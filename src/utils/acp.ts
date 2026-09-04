/**
 * Session management for Firecrawl Agent.
 *
 * Manages persistent sessions in ~/.firecrawl/sessions/.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  provider: string;
  prompt: string;
  schema: string[];
  format: string;
  outputPath: string;
  createdAt: string;
  updatedAt: string;
  iterations: number;
}

// ─── Sessions directory ─────────────────────────────────────────────────────

function getFirecrawlDir(): string {
  return path.join(os.homedir(), '.firecrawl');
}

function getSessionsDir(): string {
  return path.join(getFirecrawlDir(), 'sessions');
}

function ensureSessionsDir(): void {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Preferences ────────────────────────────────────────────────────────────

interface Preferences {
  defaultAgent?: string;
  defaultFormat?: string;
}

function getPrefsPath(): string {
  return path.join(getFirecrawlDir(), 'preferences.json');
}

export function loadPreferences(): Preferences {
  try {
    const p = getPrefsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Preferences;
  } catch {
    return {};
  }
}

export function savePreferences(patch: Partial<Preferences>): void {
  const dir = getFirecrawlDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const current = loadPreferences();
  const updated = { ...current, ...patch };
  fs.writeFileSync(getPrefsPath(), JSON.stringify(updated, null, 2));
}

// ─── Session ID ─────────────────────────────────────────────────────────────

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ─── Session CRUD ───────────────────────────────────────────────────────────

export function createSession(opts: {
  provider: string;
  prompt: string;
  schema: string[];
  format: string;
}): Session {
  ensureSessionsDir();

  const id = generateId();
  const sessionDir = path.join(getSessionsDir(), id);
  fs.mkdirSync(sessionDir, { recursive: true });

  const ext =
    opts.format === 'csv' ? 'csv' : opts.format === 'json' ? 'json' : 'md';
  const outputPath = path.join(sessionDir, `output.${ext}`);

  const session: Session = {
    id,
    provider: opts.provider,
    prompt: opts.prompt,
    schema: opts.schema,
    format: opts.format,
    outputPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    iterations: 0,
  };

  fs.writeFileSync(
    path.join(sessionDir, 'session.json'),
    JSON.stringify(session, null, 2)
  );

  return session;
}

export function loadSession(id: string): Session | null {
  const sessionFile = path.join(getSessionsDir(), id, 'session.json');
  if (!fs.existsSync(sessionFile)) return null;

  try {
    return JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as Session;
  } catch {
    return null;
  }
}

export function listSessions(): Session[] {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .map((name) => loadSession(name))
    .filter((s): s is Session => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function updateSession(id: string, patch: Partial<Session>): void {
  const session = loadSession(id);
  if (!session) return;

  const updated = { ...session, ...patch, updatedAt: new Date().toISOString() };
  const sessionFile = path.join(getSessionsDir(), id, 'session.json');
  fs.writeFileSync(sessionFile, JSON.stringify(updated, null, 2));
}

export function getSessionDir(id: string): string {
  return path.join(getSessionsDir(), id);
}
