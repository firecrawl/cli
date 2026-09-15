export const ENDPOINT_FEEDBACK_OPT_OUT_ENV_VARS = [
  'FIRECRAWL_NO_ENDPOINT_FEEDBACK',
  'FIRECRAWL_DISABLE_ENDPOINT_FEEDBACK',
] as const;

export function isEndpointFeedbackDisabledLocally(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return ENDPOINT_FEEDBACK_OPT_OUT_ENV_VARS.some((key) =>
    /^(1|true|yes|on)$/i.test(env[key]?.trim() ?? '')
  );
}
