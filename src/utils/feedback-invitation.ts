export function reportFeedbackInvitation(
  metadata: any,
  endpoint: string
): void {
  if (typeof metadata?.jobId === 'string') {
    process.stderr.write(`Feedback job (${endpoint}): ${metadata.jobId}\n`);
  }
  if (typeof metadata?.feedback?.jobId === 'string') {
    process.stderr.write(
      `If this result is wrong, incomplete, blocked, or an error, optional feedback helps improve Firecrawl: firecrawl feedback ${endpoint} ${metadata.feedback.jobId} --help\n`
    );
  }
}
