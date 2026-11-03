import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startAutoUpdate } from '../../utils/auto-update';
import type { InstallChannel } from '../../utils/install-channel';
import packageJson from '../../../package.json';
describe('startAutoUpdate', () => {
  const names = [
    'HOME',
    'USERPROFILE',
    'CI',
    'FIRECRAWL_NO_AUTO_UPDATE',
    'FIRECRAWL_NO_UPDATE_CHECK',
  ];
  let home: string;
  let saved: Record<string, string | undefined>;
  const quiet = { isTTY: false, write: () => true };

  function cache(latestVersion: string, hoursAgo: number): void {
    const dir = path.join(home, '.firecrawl');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'update-check.json'),
      JSON.stringify({
        latestVersion,
        checkedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      })
    );
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-start-'));
    saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const binary = (): InstallChannel => ({
    kind: 'binary',
    executable: path.join(home, 'firecrawl'),
    asset: 'firecrawl-linux-x64',
  });

  it('never starts an update for an external system package manager', async () => {
    cache('1.0.0', 48);
    await expect(
      startAutoUpdate({
        channel: { kind: 'brew', cellar: '/unused/Cellar/firecrawl-cli' },
        stderr: quiet,
      })
    ).resolves.toBe(false);
    expect(
      fs.existsSync(path.join(home, '.firecrawl', 'auto-update.lock'))
    ).toBe(false);
  });

  it('leaves a new major version to the notice, even from a stale cache', async () => {
    cache('99.0.0', 1);
    await expect(
      startAutoUpdate({ channel: binary(), stderr: quiet })
    ).resolves.toBe(false);

    cache('99.0.0', 48);
    await expect(
      startAutoUpdate({ channel: binary(), stderr: quiet })
    ).resolves.toBe(false);
    expect(
      fs.existsSync(path.join(home, '.firecrawl', 'auto-update.lock'))
    ).toBe(false);
  });

  it('keeps the notice quiet when the cache shows this release is current', async () => {
    cache(packageJson.version, 1);
    await expect(
      startAutoUpdate({ channel: binary(), stderr: quiet })
    ).resolves.toBe(true);
  });
});
