/**
 * Manual Notify.lk smoke test. Not imported by the API and not run at startup.
 *
 * From welapathkade-api:
 *   npm run sms:smoke -- --check
 *   npm run sms:smoke -- --send 07XXXXXXXX
 *
 * Loads welapathkade-api/.env without overriding variables already set.
 * Sends one SMS through NotifySmsSender. Does not retry and does not print
 * credentials or the request body.
 */
import 'reflect-metadata';
import * as path from 'path';
import { config as loadEnv } from 'dotenv';
import {
  NOTIFY_LK_SEND_URL,
  NotifySmsSender,
  toNotifyLkPhone,
} from '../auth/providers/notify-sms.sender';

const TEST_MESSAGE = 'Welapathkade SMS test. Notify.lk integration is working.';
const OFFICIAL_ENDPOINT = 'https://app.notify.lk/api/v1/send';

const envFile = path.resolve(__dirname, '../../.env');
const loaded = loadEnv({ path: envFile, quiet: true });

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce(
    (current, secret) =>
      secret.length > 0 ? current.split(secret).join('[redacted]') : current,
    text,
  );
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const phoneArg = args.find((arg) => !arg.startsWith('--'));
  if (args.filter((arg) => !arg.startsWith('--')).length > 1) {
    fail('Pass one destination number, or none with --check.');
  }

  if (loaded.error) {
    fail('Could not read welapathkade-api/.env.');
  }

  const userId = blankToUndefined(process.env.NOTIFY_LK_USER_ID);
  const apiKey = blankToUndefined(process.env.NOTIFY_LK_API_KEY);
  const senderId = blankToUndefined(process.env.NOTIFY_LK_SENDER_ID);
  const secrets = [userId ?? '', apiKey ?? '', senderId ?? ''];

  console.log(`NOTIFY_LK_USER_ID: ${userId ? 'configured' : 'missing'}`);
  console.log(`NOTIFY_LK_API_KEY: ${apiKey ? 'configured' : 'missing'}`);
  console.log(`NOTIFY_LK_SENDER_ID: ${senderId ? 'configured' : 'missing'}`);
  console.log(
    `sender ID is NotifyDEMO: ${
      senderId === undefined ? 'not configured' : senderId === 'NotifyDEMO' ? 'yes' : 'no'
    }`,
  );
  console.log(`endpoint: ${NOTIFY_LK_SEND_URL}`);
  console.log(
    `endpoint is official HTTPS: ${
      NOTIFY_LK_SEND_URL === OFFICIAL_ENDPOINT ? 'yes' : 'no'
    }`,
  );

  if (!userId || !apiKey || !senderId) {
    fail('Notify.lk settings are incomplete. No request was sent.');
  }
  if (senderId === 'NotifyDEMO') {
    console.log('NotifyDEMO: allowed for this manual smoke test only');
  }
  if (NOTIFY_LK_SEND_URL !== OFFICIAL_ENDPOINT) {
    fail('Endpoint is not the official Notify.lk HTTPS URL. No request was sent.');
  }

  if (!send) {
    if (phoneArg) {
      try {
        console.log(`destination: ${toNotifyLkPhone(phoneArg)}`);
      } catch (error) {
        fail(redact(error instanceof Error ? error.message : 'Invalid destination', secrets));
      }
    } else {
      console.log('destination: not provided');
    }
    console.log('request: not sent');
    return;
  }

  if (!phoneArg) {
    fail('A destination number is required with --send. No request was sent.');
  }

  let destination: string;
  try {
    destination = toNotifyLkPhone(phoneArg);
  } catch (error) {
    fail(
      redact(
        error instanceof Error ? error.message : 'Invalid destination',
        secrets,
      ),
    );
  }
  console.log(`destination: ${destination}`);

  try {
    await new NotifySmsSender({ userId, apiKey, senderId }).sendText(
      phoneArg,
      TEST_MESSAGE,
    );
  } catch (error) {
    fail(
      redact(
        error instanceof Error ? error.message : 'SMS test failed',
        secrets,
      ),
    );
  }
  console.log('Notify.lk accepted the test SMS.');
}

void main();
