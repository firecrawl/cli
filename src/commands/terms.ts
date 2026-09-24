import { Command } from 'commander';
import { getApiKey, getConfig } from '../utils/config';
import { writeOutput } from '../utils/output';

type TermsOptions = {
  apiKey?: string;
  apiUrl?: string;
  termsVersion?: string;
  digest?: string;
  confirm?: boolean;
  json?: boolean;
  pretty?: boolean;
};

export async function requestTerms(
  provider: string,
  options: TermsOptions,
  accept = false
): Promise<Record<string, any>> {
  if (!provider.trim() || provider.length > 200)
    throw new Error('Provide a provider ID of 1-200 characters.');
  if (
    accept &&
    (!options.confirm ||
      !options.termsVersion?.trim() ||
      options.termsVersion.length > 200 ||
      !/^[a-f0-9]{64}$/.test(options.digest ?? ''))
  ) {
    throw new Error(
      'Review the terms, then supply --terms-version, --digest (64 lowercase hex characters), and --confirm.'
    );
  }
  const key = getApiKey(options.apiKey);
  if (!key)
    throw new Error('A Firecrawl API key is required. Run firecrawl login.');
  const base = (
    options.apiUrl ||
    getConfig().apiUrl ||
    'https://api.firecrawl.dev'
  ).replace(/\/$/, '');
  const response = await fetch(
    `${base}/exchange/provider-terms${accept ? '/accept' : ''}`,
    {
      method: accept ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      ...(accept
        ? {
            body: JSON.stringify({
              provider,
              version: options.termsVersion,
              digest: options.digest,
              confirmed: true,
            }),
          }
        : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(getConfig().timeoutMs ?? 30000),
    }
  );
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
            'Terms access was refused. Show this error to the user and ask an organization admin to review access in Settings. Do not retry or accept automatically.',
          url: 'https://www.firecrawl.dev/app/settings?tab=data-sources',
        },
      }),
    };
  if (accept) {
    if (body.success !== true)
      throw new Error(
        'Acceptance response did not confirm success. Check status before retrying.'
      );
    return body;
  }
  if (!Array.isArray(body.providers))
    throw new Error('Terms endpoint returned an invalid catalog.');
  const item = body.providers.find((entry: any) => entry.provider === provider);
  if (!item)
    throw new Error('Provider not found in the accessible terms catalog.');
  return {
    ...item,
    success: true,
    instructions:
      'Present the returned terms and any provider document links to the user. Ask for explicit approval before accepting this exact version and digest for their organization. Reading terms does not accept them; stop if approval is absent.',
  };
}

async function handle(
  provider: string,
  options: TermsOptions,
  accept: boolean
) {
  try {
    const result = await requestTerms(provider, options, accept);
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
    'Read provider terms or explicitly accept an exact version for your API key organization'
  );
  for (const name of ['show', 'accept'] as const) {
    const command = new Command(name)
      .argument('<provider>', 'Exact provider ID')
      .option('-k, --api-key <key>', 'Firecrawl API key')
      .option('--api-url <url>', 'Firecrawl API URL')
      .option('--json', 'Output JSON (default)')
      .option('--pretty', 'Format JSON');
    if (name === 'accept')
      command
        .requiredOption(
          '--terms-version <version>',
          'Exact version of the terms you reviewed'
        )
        .requiredOption(
          '--digest <sha256>',
          'Exact SHA-256 digest of the terms you reviewed'
        )
        .option(
          '--confirm',
          'Confirm acceptance for the organization associated with your API key'
        );
    command.action((provider, options) =>
      handle(provider, options, name === 'accept')
    );
    terms.addCommand(command);
  }
  return terms;
}
