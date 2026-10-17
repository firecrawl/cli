import { Command } from 'commander';
import { getApiKey, getConfig } from '../utils/config';
import { writeOutput } from '../utils/output';

type TermsOptions = {
  apiKey?: string;
  apiUrl?: string;
  json?: boolean;
  pretty?: boolean;
};

export const TERMS_DASHBOARD_URL =
  'https://www.firecrawl.dev/app/settings?tab=data-sources';

const DASHBOARD_ONLY_ACCEPTANCE = {
  success: false,
  error:
    'Provider terms are accepted only in the Firecrawl dashboard, by an organization admin. The CLI cannot accept them.',
  guidance: {
    message:
      'Give the user this link so an organization admin can review and accept the terms, then rerun the original command.',
    url: TERMS_DASHBOARD_URL,
  },
};

export async function requestTerms(
  provider: string,
  options: TermsOptions
): Promise<Record<string, any>> {
  if (!provider.trim() || provider.length > 200)
    throw new Error('Provide a provider ID of 1-200 characters.');
  const key = getApiKey(options.apiKey);
  if (!key)
    throw new Error('A Firecrawl API key is required. Run firecrawl login.');
  const base = (
    options.apiUrl ||
    getConfig().apiUrl ||
    'https://api.firecrawl.dev'
  ).replace(/\/$/, '');
  const response = await fetch(`${base}/exchange/provider-terms`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(getConfig().timeoutMs ?? 30000),
  });
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object')
    throw new Error(
      `Terms endpoint returned non-JSON (HTTP ${response.status}).`
    );
  if (!response.ok || body.success === false)
    return {
      ...body,
      success: false,
      status: response.status,
      ...(response.status === 403 && {
        guidance: {
          message:
            'Terms access was refused. Show this error to the user and ask an organization admin to review access in Settings. Do not retry automatically.',
          url: TERMS_DASHBOARD_URL,
        },
      }),
    };
  if (!Array.isArray(body.providers))
    throw new Error('Terms endpoint returned an invalid catalog.');
  const item = body.providers.find((entry: any) => entry.provider === provider);
  if (!item)
    throw new Error('Provider not found in the accessible terms catalog.');
  return {
    ...item,
    success: true,
    instructions: `Present the returned terms and any provider document links to the user. Reading terms does not accept them. Only an organization admin can accept them, in the Firecrawl dashboard: ${TERMS_DASHBOARD_URL}`,
  };
}

async function handleShow(provider: string, options: TermsOptions) {
  try {
    const result = await requestTerms(provider, options);
    if (result.success === false) process.exitCode = 1;
    writeOutput(JSON.stringify(result, null, options.pretty ? 2 : undefined));
  } catch (error) {
    process.exitCode = 1;
    writeOutput(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Terms request failed',
      })
    );
  }
}

export function createTermsCommand(): Command {
  const terms = new Command('terms').description(
    'Read provider terms; an organization admin accepts them in the Firecrawl dashboard'
  );
  terms.addCommand(
    new Command('show')
      .argument('<provider>', 'Exact provider ID')
      .option('-k, --api-key <key>', 'Firecrawl API key')
      .option('--api-url <url>', 'Firecrawl API URL')
      .option('--json', 'Output JSON (default)')
      .option('--pretty', 'Format JSON')
      .action(handleShow)
  );
  // Kept so earlier instructions that still run `terms accept` get the
  // dashboard link instead of an unknown-command error. It never calls the API.
  terms.addCommand(
    new Command('accept')
      .argument('[provider]')
      .allowUnknownOption()
      .allowExcessArguments()
      .action(() => {
        process.exitCode = 1;
        writeOutput(JSON.stringify(DASHBOARD_ONLY_ACCEPTANCE));
      }),
    { hidden: true }
  );
  return terms;
}
