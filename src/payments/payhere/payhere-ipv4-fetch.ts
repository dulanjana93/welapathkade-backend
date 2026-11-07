import * as https from 'https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'http';

/**
 * PayHere Merchant API calls must leave this server over IPv4.
 *
 * PayHere matches the caller's source address against the app's Allowed
 * Domains. `api.welapathkade.lk` has only an A record, so a request sent over
 * the droplet's IPv6 address is rejected with HTTP 401 "Access denied for the
 * domain". Node's default resolution prefers PayHere's IPv6 (AAAA) address,
 * and global `fetch` may also fall back between families. This fetch resolves
 * IPv4 only and never tries IPv6.
 *
 * It supports the subset of `fetch` the PayHere gateway uses: string / URL
 * input, method, plain-object headers, string or URLSearchParams body,
 * `redirect: 'error'`, and `signal`.
 */

/** Upper bound on a PayHere response body. Larger bodies are rejected. */
export const PAYHERE_MAX_RESPONSE_BYTES = 1024 * 1024;

type RequestFn = (
  url: URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function bodyText(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new TypeError('PayHere IPv4 fetch supports string bodies only');
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Error or DOMException (which may come from another realm). */
function asError(value: unknown): Error {
  if (
    value instanceof Error ||
    (value !== null &&
      typeof value === 'object' &&
      typeof (value as { name?: unknown }).name === 'string' &&
      typeof (value as { message?: unknown }).message === 'string')
  ) {
    return value as Error;
  }
  return new Error(String(value));
}

/** Keeps the signal's reason (e.g. TimeoutError) as global fetch does. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason !== undefined) return asError(reason);
  return new DOMException('The operation was aborted', 'AbortError');
}

export function createPayHereIpv4Fetch(
  options: { request?: RequestFn; maxResponseBytes?: number } = {},
): typeof fetch {
  const request: RequestFn = options.request ?? https.request;
  const maxBytes = options.maxResponseBytes ?? PAYHERE_MAX_RESPONSE_BYTES;

  const ipv4Fetch = (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      return Promise.reject(
        new TypeError('PayHere IPv4 fetch accepts a string or URL'),
      );
    }
    const url = new URL(String(input));
    const signal = init.signal ?? undefined;
    let payload: string | undefined;
    try {
      payload = bodyText(init.body);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    const headers = headerRecord(init.headers);
    if (payload !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(payload));
    }

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(asError(error));
      };
      const onAbort = () => {
        req.destroy();
        fail(abortReason(signal!));
      };

      const req = request(
        url,
        {
          method: init.method ?? 'GET',
          headers,
          // IPv4 only: the lookup returns A records only, so there is no
          // IPv6 address to fall back to.
          family: 4,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && init.redirect === 'error') {
            res.resume();
            fail(new TypeError('fetch failed: unexpected redirect'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy();
              fail(new Error('PayHere response exceeded the size limit'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', fail);
          res.on('end', () => {
            if (settled) return;
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              responseHeaders.set(
                key,
                Array.isArray(value) ? value.join(', ') : value,
              );
            }
            let response: Response;
            try {
              response = new Response(
                NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks),
                {
                  status,
                  statusText: res.statusMessage ?? '',
                  headers: responseHeaders,
                },
              );
            } catch (error) {
              fail(error);
              return;
            }
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(response);
          });
        },
      );
      req.on('error', fail);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  };

  return ipv4Fetch;
}
