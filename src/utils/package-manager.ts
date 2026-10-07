export type PackageManager = 'npm' | 'pnpm' | 'bun';

export function detectPackageManager(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  versions: Partial<NodeJS.ProcessVersions> = process.versions
): PackageManager {
  // Install and runner paths identify the manager without lifecycle metadata.
  const entry = (argv[1] ?? '').replaceAll('\\', '/');
  if (/bunx[-/]|\/\.bun\//.test(entry)) return 'bun';
  if (/\/pnpm\/(dlx|global)\//.test(entry)) return 'pnpm';
  const hint = `${env.npm_config_user_agent ?? ''} ${env.npm_execpath ?? ''}`;
  if (/\bpnpm\b/i.test(hint)) return 'pnpm';
  if (/\bbun\b/i.test(hint)) return 'bun';
  if (versions.bun) return 'bun';
  return 'npm';
}

export const PACKAGE_MANAGERS = {
  npm: {
    install: 'npm install -g firecrawl-cli',
    run: 'npx firecrawl-cli',
    bin: 'npm prefix -g',
  },
  pnpm: {
    install: 'pnpm add -g firecrawl-cli',
    run: 'pnpm dlx firecrawl-cli',
    bin: 'pnpm bin -g',
  },
  bun: {
    install: 'bun add -g firecrawl-cli',
    run: 'bunx firecrawl-cli',
    bin: 'bun pm bin -g',
  },
} as const;
