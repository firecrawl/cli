# Testing Guide

This directory contains tests for the Firecrawl CLI commands. Tests use Vitest and mock the Firecrawl client to avoid making real API calls.

## Running Tests

```bash
# Run tests in watch mode
pnpm test

# Run tests once
pnpm test:run

# Run tests with UI
pnpm test:ui
```

## Test Structure

- `commands/` - Tests for command implementations
- `utils/` - Test utilities and helpers

## Writing Tests

### Key Principles

1. **No Real API Calls**: All tests mock the Firecrawl client or fetch API
2. **Verify API Call Generation**: Tests ensure commands generate correct API call parameters
3. **Verify Response Handling**: Tests ensure commands properly handle success and error responses
4. **Type Safety**: TypeScript ensures type correctness

### Example Test Pattern

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeScrape } from '../../commands/scrape';
import { getClient } from '../../utils/client';
import { setupTest, teardownTest } from '../utils/mock-client';

// Mock the client module
vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return {
    ...actual,
    getClient: vi.fn(),
  };
});

describe('executeScrape', () => {
  let mockClient: any;

  beforeEach(() => {
    setupTest();
    mockClient = { scrape: vi.fn() };
    vi.mocked(getClient).mockReturnValue(mockClient);
  });

  it('should call scrape with correct parameters', async () => {
    mockClient.scrape.mockResolvedValue({ markdown: '# Test' });

    await executeScrape({ url: 'https://example.com' });

    expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
      formats: ['markdown'],
    });
  });
});
```

## Test Utilities

### `setupTest()` / `teardownTest()`

Resets client and config state between tests. Always use these in `beforeEach`/`afterEach`.

### Mocking Patterns

- **Client methods**: Mock `getClient()` to return a mock client with stubbed methods
- **Fetch API**: Mock `global.fetch` for commands that use fetch directly
- **Config**: Use `initializeConfig()` to set test configuration

## What to Test

1. **API Call Parameters**: Verify commands pass correct parameters to the client
2. **Response Handling**: Test success and error response handling
3. **Option Parsing**: Ensure CLI options are correctly converted to API parameters
4. **Edge Cases**: Test with missing/optional parameters, null values, etc.
