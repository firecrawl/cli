export function reportFeedbackInvitation(
  metadata: any,
  endpoint: string
): void {
  if (typeof metadata?.jobId === 'string') {
    process.stderr.write(`Feedback job (${endpoint}): ${metadata.jobId}\n`);
  }
  if (typeof metadata?.feedback?.message === 'string') {
    process.stderr.write(
      `${metadata.feedback.message}\nUse: firecrawl feedback ${endpoint} ${metadata.feedback.jobId} --rating <good|partial|bad> --task <task> --assessment <assessment> --observations-file <path>${endpoint === 'parse' ? ' --doc-class <born_digital|scanned|mixed|unknown>' : ''}\n`
    );
  }
}
