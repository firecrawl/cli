/**
 * Map command implementation
 */

import type { MapOptions, MapResult } from '../types/map';
import { getClient } from '../utils/client';
import { writeOutput } from '../utils/output';
import {
  agentHintMetadata,
  withoutAgentHints,
  writeAgentHints,
} from '../utils/agent-hints';
import { apiFailure } from './alexandria';

/**
 * Execute map command
 */
export async function executeMap(options: MapOptions): Promise<MapResult> {
  try {
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
    const { urlOrJobId } = options;

    // Build map options
    const mapOptions: any = {
      integration: 'cli',
    };

    if (options.limit !== undefined) {
      mapOptions.limit = options.limit;
    }
    if (options.search) {
      mapOptions.search = options.search;
    }
    if (options.sitemap) {
      mapOptions.sitemap = options.sitemap;
    }
    if (options.includeSubdomains !== undefined) {
      mapOptions.includeSubdomains = options.includeSubdomains;
    }
    if (options.ignoreQueryParameters !== undefined) {
      mapOptions.ignoreQueryParameters = options.ignoreQueryParameters;
    }
    if (options.timeout !== undefined) {
      mapOptions.timeout = options.timeout * 1000; // Convert to milliseconds
    }

    // Execute map (seems synchronous in SDK)
    const mapData = await app.map(urlOrJobId, mapOptions);

    return {
      success: true,
      ...(mapData.id && { id: mapData.id }),
      ...agentHintMetadata(mapData),
      data: {
        links: mapData.links.map((link: any) => ({
          url: link.url,
          title: link.title,
          description: link.description,
        })),
      },
    };
  } catch (error) {
    return apiFailure(error, 'Unknown error occurred');
  }
}

/**
 * Format map data in human-readable way
 */
function formatMapReadable(data: MapResult['data']): string {
  if (!data || !data.links) return '';

  // Output one URL per line (like curl)
  return data.links.map((link) => link.url).join('\n') + '\n';
}

/**
 * Handle map command output
 */
export async function handleMapCommand(options: MapOptions): Promise<void> {
  const response = await executeMap(options);
  const result =
    options.agentHints === false ? withoutAgentHints(response) : response;

  if (options.json) {
    writeOutput(
      JSON.stringify(result, null, options.pretty ? 2 : undefined),
      options.output,
      !!options.output
    );
    if (!result.success) process.exitCode = 1;
    return;
  }
  writeAgentHints(result);

  if (!result.success) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  if (!result.data) {
    return;
  }

  const outputContent = formatMapReadable(result.data);

  writeOutput(outputContent, options.output, !!options.output);
}
