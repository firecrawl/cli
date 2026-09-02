/**
 * Cross-platform spawn for agent CLIs. Windows npm shims are `.cmd` files,
 * which Node's `execFileSync` cannot launch; those go through cmd.exe with
 * escaped argv. Everywhere else this is a direct exec.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const CMD_META_CHARS = /([()%!^"<>&|])/g;

function rejectCommandControlCharacters(value: string, label: string): void {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} contains an unsupported control character.`);
  }
}

/** Quote one argv value for cmd.exe using the same two-layer escaping model as
 * established Windows spawn libraries: first the C runtime, then cmd.exe. */
function escapeCmdArg(arg: string): string {
  rejectCommandControlCharacters(arg, 'Command argument');
  const quoted = `"${arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META_CHARS, '^$1');
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return configured
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
}

/** Resolve the actual Windows launcher instead of assuming every tool is a
 * `.cmd` shim. Native `.exe` clients must bypass cmd.exe entirely. */
function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv
): string {
  rejectCommandControlCharacters(command, 'Command');
  const hasPath = /[\\/]/.test(command);
  const hasExtension = path.extname(command) !== '';
  const candidates = hasExtension
    ? [command]
    : windowsPathExtensions(env).map((extension) => `${command}${extension}`);
  const pathEntries = hasPath
    ? ['']
    : (env.PATH ?? env.Path ?? env.path ?? '')
        .split(path.delimiter)
        .map((entry) => entry.replace(/^"|"$/g, ''))
        .filter(Boolean);

  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const resolved = directory ? path.join(directory, candidate) : candidate;
      if (existsSync(resolved)) return resolved;
    }
  }

  // Let CreateProcess perform its normal resolution for native executables.
  // Crucially, do not silently rewrite an unknown command to `<name>.cmd`.
  return command;
}

export function runClientCommand(
  command: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2]
): ReturnType<typeof execFileSync> {
  rejectCommandControlCharacters(command, 'Command');
  for (const arg of args)
    rejectCommandControlCharacters(arg, 'Command argument');

  if (process.platform !== 'win32') {
    return execFileSync(command, args, options);
  }

  const env = options?.env ?? process.env;
  const resolved = resolveWindowsCommand(command, env);
  if (!/\.(?:cmd|bat)$/i.test(resolved)) {
    return execFileSync(resolved, args, options);
  }

  const line = [escapeCmdArg(resolved), ...args.map(escapeCmdArg)].join(' ');
  const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  const windowsOptions = {
    ...options,
    windowsVerbatimArguments: true,
  } as Parameters<typeof execFileSync>[2];
  return execFileSync(comspec, ['/d', '/s', '/c', `"${line}"`], windowsOptions);
}
