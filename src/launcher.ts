#!/usr/bin/env node
import path from 'path';
import packageJson from '../package.json';
import { detectInstallChannel } from './utils/install-channel';
import {
  installationId,
  LAUNCHER_ID_ENV,
  managedEntry,
  readManagedPointer,
} from './utils/managed-paths';
import { leaseManagedVersion } from './utils/managed-lifecycle';
import { compareVersions, isPrerelease } from './utils/npm-registry';

const channel = detectInstallChannel({
  moduleDir: path.join(__dirname, 'utils'),
  execPath: process.execPath,
  platform: process.platform,
  arch: process.arch,
});
let entry = path.join(__dirname, 'index.js');
const identity = installationId(path.resolve(__dirname, '..'));
process.env[LAUNCHER_ID_ENV] = identity;
process.env.FIRECRAWL_INSTALL_CHANNEL = channel.kind;
process.env.FIRECRAWL_LAUNCHER_PATH = __filename;
const args = process.argv.slice(2);
// Rollback runs from this package so a broken release cannot block recovery.
const recovering = args[0] === 'update' && args.includes('--rollback');
// Package runners, local dependencies, and system package managers retain
// their selected release. A global launcher stays untouched by self-updates.
if (
  !recovering &&
  ['npm', 'pnpm', 'bun', 'yarn'].includes(channel.kind) &&
  !isPrerelease(packageJson.version)
) {
  const pointer = readManagedPointer();
  if (
    pointer?.installation === identity &&
    compareVersions(pointer.version, packageJson.version) > 0
  ) {
    const release = leaseManagedVersion(pointer.version);
    if (release) {
      const selected = managedEntry(pointer.version);
      if (selected) {
        entry = selected;
        process.once('exit', release);
      } else release();
    }
  }
}
process.argv[1] = entry;
require(entry);
