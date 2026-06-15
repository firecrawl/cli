import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getConfigDirectoryPath } from './credentials';

const SESSION_FILE = 'session.json';
const SESSION_TTL_MS = 30 * 60 * 1000;

type StoredSession = { id: string; last_active_at: number };

function sessionFilePath(): string {
  return path.join(getConfigDirectoryPath(), SESSION_FILE);
}

function readSession(): StoredSession | null {
  try {
    const raw = fs.readFileSync(sessionFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.id === 'string' &&
      typeof parsed.last_active_at === 'number'
    ) {
      return parsed as StoredSession;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeSession(session: StoredSession): void {
  try {
    const dir = path.dirname(sessionFilePath());
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(sessionFilePath(), JSON.stringify(session));
  } catch {
    // best-effort
  }
}

let cachedSessionId: string | null = null;

export function getSessionId(): string {
  if (cachedSessionId) return cachedSessionId;

  const now = Date.now();
  const existing = readSession();
  const id =
    existing && now - existing.last_active_at < SESSION_TTL_MS
      ? existing.id
      : randomUUID();

  writeSession({ id, last_active_at: now });
  cachedSessionId = id;
  return id;
}

export type SessionHeaders = Record<string, string>;

export function getSessionHeaders(): SessionHeaders {
  return {
    'x-firecrawl-session-id': getSessionId(),
  };
}
