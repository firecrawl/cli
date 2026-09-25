export function reportFeedbackInvitation(
  metadata: any,
  endpoint: string
): void {
  if (typeof metadata?.jobId === 'string') {
    process.stderr.write(`Feedback job (${endpoint}): ${metadata.jobId}\n`);
  }
  if (typeof metadata?.feedback?.jobId === 'string') {
    process.stderr.write(
      `Feedback requested in exchange for free keyless use: firecrawl feedback ${endpoint} ${metadata.feedback.jobId} --help\n`
    );
  }
}
