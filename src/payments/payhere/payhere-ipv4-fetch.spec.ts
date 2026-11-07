import * as http from 'http';
import type { AddressInfo } from 'net';
import { createPayHereIpv4Fetch } from './payhere-ipv4-fetch';

type Seen = {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  remoteAddress?: string;
};

let server: http.Server;
let port: number;
let seen: Seen[] = [];
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        remoteAddress: req.socket.remoteAddress,
      });
      handler(req, res);
    });
  });
  // Dual-stack when the host supports IPv6, so the test can see which
  // family the client actually used.
  await new Promise<void>((resolve) => {
    server.once('error', () => server.listen(0, '0.0.0.0', resolve));
    server.listen({ port: 0, host: '::', ipv6Only: false }, resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":1}');
  };
});

function ipv4Fetch(options: { maxResponseBytes?: number } = {}) {
  const calls: http.RequestOptions[] = [];
  const request = ((
    url: URL,
    opts: http.RequestOptions,
    cb: (res: http.IncomingMessage) => void,
  ) => {
    calls.push(opts);
    return http.request(url, opts, cb);
  }) as never;
  return { fetch: createPayHereIpv4Fetch({ request, ...options }), calls };
}

describe('createPayHereIpv4Fetch', () => {
  it('connects over IPv4 only, even for a name that resolves to IPv6 first', async () => {
    const { fetch, calls } = ipv4Fetch();
    const response = await fetch(`http://localhost:${port}/merchant/v1/x`);
    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({ family: 4 });
    expect(seen[0].remoteAddress).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it('sends method, headers, and a JSON body, and exposes a 401 error body', async () => {
    handler = (_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json;charset=UTF-8',
        'cf-ray': 'abc-SIN',
      });
      res.end('{"status":-1,"msg":"Access denied for the domain","data":null}');
    };
    const { fetch } = ipv4Fetch();
    const body = JSON.stringify({ type: 'PAYMENT', amount: 500 });
    const response = await fetch(`http://127.0.0.1:${port}/charge`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer t',
        'Content-Type': 'application/json',
      },
      body,
      redirect: 'error',
    });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/charge', body });
    expect(seen[0].headers).toMatchObject({
      authorization: 'Bearer t',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    });
    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
    expect(response.headers.get('cf-ray')).toBe('abc-SIN');
    expect(await response.json()).toEqual({
      status: -1,
      msg: 'Access denied for the domain',
      data: null,
    });
  });

  it('sends a URLSearchParams body and keeps the query string', async () => {
    const { fetch } = ipv4Fetch();
    await fetch(new URL(`http://127.0.0.1:${port}/oauth?x=1`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    expect(seen[0]).toMatchObject({
      url: '/oauth?x=1',
      body: 'grant_type=client_credentials',
    });
  });

  it('rejects a redirect when redirect is error', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: 'http://example.com/' });
      res.end();
    };
    const { fetch } = ipv4Fetch();
    await expect(
      fetch(`http://127.0.0.1:${port}/`, { redirect: 'error' }),
    ).rejects.toThrow(/redirect/);
  });

  it('rejects with the timeout reason when the signal fires', async () => {
    handler = () => {
      // never respond
    };
    const { fetch } = ipv4Fetch();
    await expect(
      fetch(`http://127.0.0.1:${port}/slow`, {
        signal: AbortSignal.timeout(50),
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('rejects an oversized response body', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(5000));
    };
    const { fetch } = ipv4Fetch({ maxResponseBytes: 1000 });
    await expect(fetch(`http://127.0.0.1:${port}/big`)).rejects.toThrow(
      /size limit/,
    );
  });

  it('returns an empty body for 204 and an empty 401', async () => {
    handler = (req, res) => {
      res.writeHead(req.url === '/none' ? 204 : 401);
      res.end();
    };
    const { fetch } = ipv4Fetch();
    expect((await fetch(`http://127.0.0.1:${port}/none`)).status).toBe(204);
    const empty = await fetch(`http://127.0.0.1:${port}/empty`);
    expect(empty.status).toBe(401);
    expect(await empty.text()).toBe('');
  });

  it('rejects a connection error', async () => {
    const { fetch } = ipv4Fetch();
    await expect(fetch('http://127.0.0.1:1/')).rejects.toBeDefined();
  });
});
