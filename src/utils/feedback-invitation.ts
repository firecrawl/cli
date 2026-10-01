export const KEYLESS_FEEDBACK_HELP =
  '\nConsider submitting feedback through firecrawl feedback, especially if a keyless result is wrong, incomplete, blocked, or an error. Include specific evidence to help improve Firecrawl. Run firecrawl feedback --help for submission fields. Invitations and job references appear in metadata or stderr. Feedback does not consume operation quota.';

export function reportFeedbackInvitation(
  metadata: any,
  endpoint: string
): void {
  if (typeof metadata?.jobId !== 'string') return;
  process.stderr.write(`Feedback job (${endpoint}): ${metadata.jobId}\n`);
  if (metadata.feedback) {
    process.stderr.write(
      `Consider submitting feedback, especially if this result is wrong, incomplete, blocked, or an error. Include specific evidence to help improve Firecrawl: firecrawl feedback ${endpoint} ${metadata.jobId} --help\n`
    );
  }
}
