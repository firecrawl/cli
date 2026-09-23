export function reportFeedbackInvitation(
  metadata: any,
  endpoint: string
): void {
  if (typeof metadata?.jobId === 'string') {
    process.stderr.write(`Feedback job (${endpoint}): ${metadata.jobId}\n`);
  }
  if (typeof metadata?.feedback?.jobId === 'string') {
    process.stderr.write(
      `Optional feedback on evidence you already observed: firecrawl feedback ${endpoint} ${metadata.feedback.jobId} --help\n`
    );
  }
}
