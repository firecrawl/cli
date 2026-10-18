/**
 * `firecrawl world-id`: verify with World ID for the keyless tier.
 *
 * Runs the API's device flow (POST /v2/keyless/world-id/device, then polls
 * /v2/keyless/world-id/token) and stores the `fcwid_` credential it returns.
 * Keyless requests then send it as `x-firecrawl-world-id`.
 */

import { Command } from 'commander';
import { getConfig } from '../utils/config';
import { KEYLESS_CLI_HEADERS } from '../utils/client';
import { openBrowser } from '../utils/auth';
import {
  activeWorldIdCredential,
  clearWorldIdCredential,
  loadWorldIdCredential,
  saveWorldIdCredential,
  type StoredWorldIdCredential,
} from '../utils/world-id';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';

export const WORLD_ID_UNAVAILABLE_MESSAGE =
  'World ID verification is not enabled on this Firecrawl API.';

interface DeviceStart {
  device_handle: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface VerifyWorldIdOptions {
  openBrowser?: boolean;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function apiUrl(): string {
  return (getConfig().apiUrl || DEFAULT_API_URL).replace(/\/$/, '');
}

async function post(
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: any; retryAfter?: number }> {
  const response = await fetch(`${apiUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...KEYLESS_CLI_HEADERS },
    body: JSON.stringify(body),
  });
  const json: any = await response.json().catch(() => ({}));
  const retryAfter = Number(response.headers.get('retry-after'));
  return {
    status: response.status,
    json,
    ...(retryAfter > 0 ? { retryAfter } : {}),
  };
}

function pollError(error: unknown, json: any): Error {
  switch (error) {
    case 'access_denied':
      return new Error('World ID verification was declined.');
    case 'expired_token':
      return new Error(
        'The World ID code expired. Run "firecrawl world-id verify" again.'
      );
    case 'subject_not_allowed':
      return new Error(
        `World ID verification succeeded, but this World ID is not enabled for the verified keyless tier yet (subject ${json?.subject_hash ?? 'unknown'}).`
      );
    default:
      return new Error(`World ID verification failed: ${String(error)}`);
  }
}

/** Runs the device flow to completion and stores the credential. */
export async function verifyWorldId(
  options: VerifyWorldIdOptions = {}
): Promise<StoredWorldIdCredential> {
  const log = options.log ?? ((message: string) => console.error(message));
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  const start = await post('/v2/keyless/world-id/device', {});
  if (start.status === 404) throw new Error(WORLD_ID_UNAVAILABLE_MESSAGE);
  if (start.status === 429) {
    throw new Error(
      `Too many World ID verification attempts. Try again in ${start.retryAfter ?? 60} seconds.`
    );
  }
  if (start.status !== 200 || typeof start.json?.device_handle !== 'string') {
    throw new Error(
      `Could not start World ID verification: ${start.json?.error ?? `HTTP ${start.status}`}`
    );
  }
  const device = start.json as DeviceStart;
  const link = device.verification_uri_complete ?? device.verification_uri;

  log(`Verify with World ID at ${link}`);
  log(`Code: ${device.user_code}`);
  if (options.openBrowser !== false) {
    await openBrowser(link).catch(() => undefined);
  }
  log('Waiting for approval in World App...');

  let intervalSeconds = device.interval > 0 ? device.interval : 5;
  const deadline =
    now() + (device.expires_in > 0 ? device.expires_in : 1200) * 1000;

  while (now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const poll = await post('/v2/keyless/world-id/token', {
      device_handle: device.device_handle,
    });
    if (poll.status === 200 && typeof poll.json?.credential === 'string') {
      const stored = {
        credential: poll.json.credential,
        expiresAt: poll.json.expires_at,
      };
      saveWorldIdCredential(stored);
      return stored;
    }
    if (poll.status === 404) throw new Error(WORLD_ID_UNAVAILABLE_MESSAGE);
    const error = poll.json?.error;
    if (error === 'authorization_pending' || poll.status >= 500) continue;
    if (error === 'slow_down') {
      intervalSeconds = Math.max(intervalSeconds + 5, poll.retryAfter ?? 0);
      continue;
    }
    throw pollError(error ?? `HTTP ${poll.status}`, poll.json);
  }
  throw pollError('expired_token', {});
}

function describeStatus(): Record<string, unknown> {
  if (process.env.FIRECRAWL_WORLD_ID?.trim()) {
    return { verified: true, source: 'env' };
  }
  const stored = loadWorldIdCredential();
  if (!stored) return { verified: false };
  return {
    verified: Boolean(activeWorldIdCredential()),
    source: 'stored',
    expiresAt: stored.expiresAt,
  };
}

export function createWorldIdCommand(): Command {
  const command = new Command('world-id').description(
    'Verify with World ID for a keyless tier of your own, separate from your IP'
  );

  command
    .command('verify')
    .description('Verify with World ID and store the credential')
    .option('--no-browser', 'Print the verification link without opening it')
    .action(async (options) => {
      const stored = await verifyWorldId({ openBrowser: options.browser });
      console.log(
        `✓ Verified with World ID. Keyless requests use your own bucket until ${stored.expiresAt}.`
      );
    });

  command
    .command('status')
    .description('Show whether a World ID credential is stored')
    .option('--json', 'Output JSON')
    .action((options) => {
      const status = describeStatus();
      if (options.json) {
        console.log(JSON.stringify(status));
        return;
      }
      if (status.source === 'env') {
        console.log('Using the World ID credential from FIRECRAWL_WORLD_ID.');
      } else if (!status.source) {
        console.log('Not verified. Run "firecrawl world-id verify".');
      } else if (status.verified) {
        console.log(`Verified with World ID until ${status.expiresAt}.`);
      } else {
        console.log(
          `World ID credential expired at ${status.expiresAt}. Run "firecrawl world-id verify" again.`
        );
      }
    });

  command
    .command('clear')
    .description('Remove the stored World ID credential')
    .action(() => {
      console.log(
        clearWorldIdCredential()
          ? '✓ Removed the stored World ID credential.'
          : 'No World ID credential stored.'
      );
    });

  return command;
}
