import { describe, expect, it } from 'vitest';
import { buildCreateBody } from '../../commands/monitor';

describe('monitor command helpers', () => {
  describe('buildCreateBody', () => {
    it('includes a goal when creating a monitor from flags', () => {
      expect(
        buildCreateBody({
          name: 'Pricing',
          goal: 'Track plan price and feature changes',
          scheduleText: 'every 30 minutes',
          timezone: 'UTC',
          urls: ['https://example.com/pricing'],
        })
      ).toEqual({
        name: 'Pricing',
        goal: 'Track plan price and feature changes',
        schedule: {
          text: 'every 30 minutes',
          timezone: 'UTC',
        },
        targets: [
          {
            type: 'scrape',
            urls: ['https://example.com/pricing'],
          },
        ],
      });
    });

    it('supports the simple page plus goal path', () => {
      expect(
        buildCreateBody({
          name: 'Docs',
          goal: 'Tell me when the changelog adds a new release',
          scheduleText: 'hourly',
          page: 'https://example.com/changelog',
        })
      ).toMatchObject({
        name: 'Docs',
        goal: 'Tell me when the changelog adds a new release',
        targets: [
          {
            type: 'scrape',
            urls: ['https://example.com/changelog'],
          },
        ],
      });
    });
  });
});
