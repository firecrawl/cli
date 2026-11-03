#!/usr/bin/env node
import path from 'path';
import packageJson from '../package.json';
import { detectInstallChannel } from './utils/install-channel';
import { managedEntry, readManagedPointer } from './utils/managed-paths';
import { compareVersions, isPrerelease } from './utils/npm-registry';

const channel = detectInstallChannel({
  moduleDir: path.join(__dirname, 'utils'),
  execPath: process.execPath,
  platform: process.platform,
  arch: process.arch,
});
let entry = path.join(__dirname, 'index.js');
// Package runners, local dependencies, and system package managers retain
// their selected release. A global launcher stays untouched by self-updates.
if (
  ['npm', 'pnpm', 'bun', 'yarn'].includes(channel.kind) &&
  !isPrerelease(packageJson.version)
) {
  const pointer = readManagedPointer();
  if (pointer && compareVersions(pointer.version, packageJson.version) > 0) {
    entry = managedEntry(pointer.version) ?? entry;
  }
}
process.argv[1] = entry;
require(entry);
