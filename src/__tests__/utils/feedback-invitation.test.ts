import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportFeedbackInvitation } from '../../utils/feedback-invitation';

describe('feedback invitation output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it('keeps content stdout unchanged and writes a short optional reminder to stderr', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    reportFeedbackInvitation(
      {
        jobId: 'job-1',
        feedback: { jobId: 'job-1', message: 'Server feedback guidance.' },
      },
      'parse'
    );
    expect(stdout).not.toHaveBeenCalled();
    const printed = stderr.mock.calls.flat().join('');
    expect(printed).toBe(
      'Feedback job (parse): job-1\n' +
        'Consider submitting feedback, especially if this result is wrong, incomplete, blocked, or an error. Include specific evidence to help improve Firecrawl: firecrawl feedback parse job-1 --help\n'
    );
    expect(printed).not.toContain('Server feedback guidance.');
    expect(printed).not.toContain('--observations-file');
  });
  it('retains keyless invitations despite authenticated feedback preferences', () => {
    vi.stubEnv('FIRECRAWL_NO_ENDPOINT_FEEDBACK', 'true');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    reportFeedbackInvitation(
      {
        jobId: 'job-1',
        feedback: { jobId: 'job-1', message: 'Optional feedback.' },
      },
      'search'
    );
    expect(stderr.mock.calls.flat().join('')).toContain(
      'firecrawl feedback search job-1'
    );
  });
  it('prints only the job reference when the API did not issue an invitation', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    reportFeedbackInvitation({ jobId: 'job-1' }, 'parse');
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      'Feedback job (parse): job-1\n'
    );
  });

  it('does not invent invitations when metadata is absent', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    reportFeedbackInvitation(undefined, 'scrape');
    expect(stderr).not.toHaveBeenCalled();
  });
});
