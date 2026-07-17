import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ALL_SKILL_REPOS } from '../commands/skills-install';
import {
  addRouterGuidanceToSkillDescription,
  assertNotSymlink,
  assertRouterCardStateSafe,
  assertSafeProjectPath,
  atomicWriteFile,
  installRouterCard,
  removeRouterCard,
  routerCardPath,
  resolveRouterCardContext,
  ROUTER_SKILL_DESCRIPTION_PREFIX_SHA256,
  type RouterCardAgent,
  type RouterCardResult,
} from './router-card';

const MANAGED_SKILL_VERSION = 2;
const MANAGED_SKILL_MARKER = '.firecrawl-router-skill.json';
const PREFERENCE_VERSION = 1;
const PREFERENCE_PATH = path.join('.firecrawl', 'router-card.json');
const CANONICAL_SKILLS_DIR = path.join('.agents', 'skills');
const SKILL_LOCK_PATH = path.join('.agents', '.skill-lock.json');

const PROJECT_SKILLS_DIRS: Record<RouterCardAgent, string> = {
  claude: path.join('.claude', 'skills'),
  codex: path.join('.agents', 'skills'),
};

export interface SkillSourceProvenance {
  source: string;
  sourceUrl: string;
  skillPath: string;
  skillFolderHash: string;
}

interface SkillLockFile {
  version: number;
  skills: Record<string, unknown>;
}

const ALLOWED_SKILL_REPOS = new Set<string>(ALL_SKILL_REPOS);

interface ManagedSkillMarker {
  version: number;
  skillName: string;
  sourceSha256: string;
  routedSha256: string;
  routerPrefixSha256: string;
  provenance: SkillSourceProvenance;
}

export interface ManagedSkillReceipt extends ManagedSkillMarker {
  path: string;
  status: 'installed' | 'refreshed' | 'current' | 'pruned' | 'removed';
}

export interface PreservedSkillReceipt {
  path: string;
  skillName: string;
  reason: string;
  sourceSha256?: string;
  routedSha256?: string;
  routerPrefixSha256?: string;
  provenance?: SkillSourceProvenance;
}

export interface ProjectSkillsReceipt {
  root: string;
  changed: boolean;
  sourceCount: number;
  installed: ManagedSkillReceipt[];
  refreshed: ManagedSkillReceipt[];
  current: ManagedSkillReceipt[];
  pruned: ManagedSkillReceipt[];
  removed: ManagedSkillReceipt[];
  preserved: PreservedSkillReceipt[];
}

export interface RouterPreferenceReceipt {
  path: string;
  enabled: boolean;
  changed: boolean;
}

export interface FullProjectRouterStateReceipt {
  operation: 'install' | 'remove';
  status:
    | 'installed'
    | 'current'
    | 'disabled'
    | 'skipped-safe'
    | 'removed'
    | 'removed-with-preserved-content';
  agent: RouterCardAgent;
  project: string;
  operationComplete: boolean;
  artifactsConfigured: boolean;
  nativeDiscovery: {
    status: 'pending' | 'unverified';
    verified: false;
  };
  warning?: string;
  card?: RouterCardResult;
  preservedCard?: {
    path: string;
    reason: string;
  };
  skills: ProjectSkillsReceipt;
  preference: RouterPreferenceReceipt;
}

export interface FullProjectRouterStatePrerequisites {
  authenticated: boolean;
  mcpInstalled: boolean;
  skillsInstalled: boolean;
}

export interface InstallFullProjectRouterStateOptions extends FullProjectRouterStatePrerequisites {
  agent: RouterCardAgent;
  project: string;
  forceEnable?: boolean;
}

function emptySkillsReceipt(root: string): ProjectSkillsReceipt {
  return {
    root,
    changed: false,
    sourceCount: 0,
    installed: [],
    refreshed: [],
    current: [],
    pruned: [],
    removed: [],
    preserved: [],
  };
}

function preferencePath(project: string): string {
  return path.join(project, PREFERENCE_PATH);
}

function projectSkillsRoot(agent: RouterCardAgent, project: string): string {
  return path.join(project, PROJECT_SKILLS_DIRS[agent]);
}

function readPreference(project: string): RouterPreferenceReceipt {
  const destination = preferencePath(project);
  assertSafeProjectPath(project, destination);
  if (!fs.existsSync(destination)) {
    return { path: destination, enabled: true, changed: false };
  }

  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(destination, 'utf8'));
  } catch {
    throw new Error(`Router-card preference is malformed: ${destination}`);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== PREFERENCE_VERSION ||
    typeof (value as { enabled?: unknown }).enabled !== 'boolean'
  ) {
    throw new Error(`Router-card preference is malformed: ${destination}`);
  }
  return {
    path: destination,
    enabled: (value as { enabled: boolean }).enabled,
    changed: false,
  };
}

function disablePreference(project: string): RouterPreferenceReceipt {
  const current = readPreference(project);
  if (!current.enabled) return current;
  atomicWriteFile(
    current.path,
    `${JSON.stringify({ version: PREFERENCE_VERSION, enabled: false }, null, 2)}\n`,
    0o644
  );
  return { ...current, enabled: false, changed: true };
}

function enablePreference(project: string): RouterPreferenceReceipt {
  const current = readPreference(project);
  if (current.enabled) return current;
  fs.rmSync(current.path);
  return { ...current, enabled: true, changed: true };
}

function shouldCopyEntry(name: string): boolean {
  return (
    !name.startsWith('.') && name !== 'metadata.json' && name !== '__pycache__'
  );
}

function directoryDigest(root: string): string {
  const hash = createHash('sha256');

  function walk(current: string): void {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === MANAGED_SKILL_MARKER) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Managed router skill contains a symlink: ${absolute}`);
      }
      if (stat.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        walk(absolute);
      } else if (stat.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(fs.readFileSync(absolute));
        hash.update('\0');
      } else {
        throw new Error(`Unsupported managed router skill entry: ${absolute}`);
      }
    }
  }

  walk(root);
  return hash.digest('hex');
}

function copySourceTree(source: string, destination: string): void {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`Router skill source must be a real directory: ${source}`);
  }
  fs.mkdirSync(destination, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!shouldCopyEntry(entry.name)) continue;
    const sourceEntry = path.join(source, entry.name);
    const targetEntry = path.join(destination, entry.name);
    const stat = fs.lstatSync(sourceEntry);
    if (stat.isSymbolicLink()) {
      throw new Error(`Router skill source contains a symlink: ${sourceEntry}`);
    }
    if (stat.isDirectory()) {
      copySourceTree(sourceEntry, targetEntry);
    } else if (stat.isFile()) {
      fs.copyFileSync(sourceEntry, targetEntry);
    }
  }
}

function parseMarker(
  markerPath: string,
  skillName: string
): ManagedSkillMarker {
  assertNotSymlink(markerPath, markerPath);
  let marker: unknown;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    throw new Error(`Managed router skill marker is malformed: ${markerPath}`);
  }
  const candidate = marker as Partial<ManagedSkillMarker>;
  if (
    candidate.version !== MANAGED_SKILL_VERSION ||
    candidate.skillName !== skillName ||
    typeof candidate.sourceSha256 !== 'string' ||
    typeof candidate.routedSha256 !== 'string' ||
    candidate.routerPrefixSha256 !== ROUTER_SKILL_DESCRIPTION_PREFIX_SHA256 ||
    !isAllowedSkillProvenance(candidate.provenance)
  ) {
    throw new Error(`Managed router skill marker is malformed: ${markerPath}`);
  }
  return candidate as ManagedSkillMarker;
}

function inspectOwnedSkill(
  skillPath: string,
  skillName: string
): ManagedSkillMarker {
  const stat = fs.lstatSync(skillPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing router skill symlink collision: ${skillPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing user-owned router skill collision: ${skillPath}`);
  }
  const markerPath = path.join(skillPath, MANAGED_SKILL_MARKER);
  if (!fs.existsSync(markerPath)) {
    throw new Error(`Refusing user-owned router skill collision: ${skillPath}`);
  }
  const marker = parseMarker(markerPath, skillName);
  const currentDigest = directoryDigest(skillPath);
  if (currentDigest !== marker.routedSha256) {
    throw new Error(
      `Refusing to overwrite modified router skill: ${skillPath}`
    );
  }
  return marker;
}

function stageRoutedSkill(
  source: string,
  parent: string,
  skillName: string,
  provenance: SkillSourceProvenance
): { stage: string; marker: ManagedSkillMarker } {
  const stage = path.join(parent, `.${skillName}.${randomUUID()}.tmp`);
  try {
    copySourceTree(source, stage);
    const sourceSha256 = directoryDigest(stage);
    const skillFile = path.join(stage, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Router skill source has no SKILL.md: ${source}`);
    }
    const original = fs.readFileSync(skillFile, 'utf8');
    const routed = addRouterGuidanceToSkillDescription(original);
    atomicWriteFile(skillFile, routed, fs.statSync(skillFile).mode & 0o777);
    const routedSha256 = directoryDigest(stage);
    const marker: ManagedSkillMarker = {
      version: MANAGED_SKILL_VERSION,
      skillName,
      sourceSha256,
      routedSha256,
      routerPrefixSha256: ROUTER_SKILL_DESCRIPTION_PREFIX_SHA256,
      provenance,
    };
    atomicWriteFile(
      path.join(stage, MANAGED_SKILL_MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
      0o644
    );
    return { stage, marker };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function expectedSourceUrl(source: string): string {
  return `https://github.com/${source}.git`;
}

function isAllowedSkillProvenance(
  provenance: unknown
): provenance is SkillSourceProvenance {
  if (!provenance || typeof provenance !== 'object') return false;
  const candidate = provenance as Partial<SkillSourceProvenance>;
  return (
    typeof candidate.source === 'string' &&
    ALLOWED_SKILL_REPOS.has(candidate.source) &&
    candidate.sourceUrl === expectedSourceUrl(candidate.source) &&
    typeof candidate.skillPath === 'string' &&
    candidate.skillPath.length > 0 &&
    typeof candidate.skillFolderHash === 'string' &&
    /^[a-f0-9]{40}$/.test(candidate.skillFolderHash)
  );
}

/** Must stay byte-compatible with skills-native's lock-file hash. */
function skillLockDigest(root: string): string {
  const hash = createHash('sha1');

  function walk(current: string): void {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Router skill source contains a symlink: ${absolute}`);
      }
      if (stat.isDirectory()) {
        walk(absolute);
      } else if (stat.isFile()) {
        hash.update(entry.name);
        hash.update(fs.readFileSync(absolute));
      } else {
        throw new Error(`Unsupported router skill source entry: ${absolute}`);
      }
    }
  }

  walk(root);
  return hash.digest('hex');
}

function discoverCanonicalSkills(): Array<{
  name: string;
  source: string;
  provenance: SkillSourceProvenance;
}> {
  const canonical = path.join(os.homedir(), CANONICAL_SKILLS_DIR);
  const lockPath = path.join(os.homedir(), SKILL_LOCK_PATH);
  assertNotSymlink(canonical, canonical);
  if (!fs.existsSync(canonical)) {
    throw new Error(`Firecrawl canonical skills are missing: ${canonical}`);
  }
  assertNotSymlink(lockPath, lockPath);
  if (!fs.existsSync(lockPath)) {
    throw new Error(`Firecrawl skill provenance lock is missing: ${lockPath}`);
  }

  let lock: SkillLockFile;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as SkillLockFile;
  } catch {
    throw new Error(
      `Firecrawl skill provenance lock is malformed: ${lockPath}`
    );
  }
  if (
    !lock ||
    typeof lock !== 'object' ||
    lock.version !== 3 ||
    !lock.skills ||
    typeof lock.skills !== 'object' ||
    Array.isArray(lock.skills)
  ) {
    throw new Error(
      `Firecrawl skill provenance lock is malformed: ${lockPath}`
    );
  }

  const sources: Array<{
    name: string;
    source: string;
    provenance: SkillSourceProvenance;
  }> = [];
  for (const [name, provenance] of Object.entries(lock.skills)) {
    if (
      path.basename(name) !== name ||
      name === '.' ||
      name === '..' ||
      !provenance ||
      typeof provenance !== 'object'
    ) {
      continue;
    }
    if (!isAllowedSkillProvenance(provenance)) {
      const candidate = provenance as Partial<SkillSourceProvenance>;
      const sourceRepo = String(candidate.source ?? '');
      if (
        !ALLOWED_SKILL_REPOS.has(sourceRepo) ||
        candidate.sourceUrl !== expectedSourceUrl(sourceRepo)
      ) {
        continue;
      }
      throw new Error(`Firecrawl skill provenance is malformed for ${name}.`);
    }
    const sourceRepo = provenance.source;
    if (
      !ALLOWED_SKILL_REPOS.has(sourceRepo) ||
      provenance.sourceUrl !== expectedSourceUrl(sourceRepo)
    ) {
      continue;
    }
    const source = path.join(canonical, name);
    if (!fs.existsSync(source)) {
      throw new Error(`Locked Firecrawl skill is missing: ${source}`);
    }
    const stat = fs.lstatSync(source);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `Router skill source must be a real directory: ${source}`
      );
    }
    const currentFolderHash = skillLockDigest(source);
    if (currentFolderHash !== provenance.skillFolderHash) {
      throw new Error(
        `Locked Firecrawl skill content does not match its provenance hash: ${source}`
      );
    }
    sources.push({
      name,
      source,
      provenance: {
        source: sourceRepo,
        sourceUrl: provenance.sourceUrl,
        skillPath: provenance.skillPath,
        skillFolderHash: provenance.skillFolderHash,
      },
    });
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

export function installManagedProjectSkills(
  agent: RouterCardAgent,
  projectPath: string
): ProjectSkillsReceipt {
  const project = path.resolve(projectPath);
  const root = projectSkillsRoot(agent, project);
  assertSafeProjectPath(project, root);
  const sources = discoverCanonicalSkills();
  if (sources.length === 0) {
    throw new Error('No installed Firecrawl skills are available to route.');
  }

  fs.mkdirSync(root, { recursive: true });
  assertNotSymlink(root, root);
  const sourceNames = new Set(sources.map((source) => source.name));
  const existingManaged = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      return fs.existsSync(path.join(root, entry.name, MANAGED_SKILL_MARKER));
    })
    .map((entry) => entry.name);

  const existingMarkers = new Map<string, ManagedSkillMarker>();
  for (const source of sources) {
    const destination = path.join(root, source.name);
    if (fs.existsSync(destination)) {
      existingMarkers.set(
        source.name,
        inspectOwnedSkill(destination, source.name)
      );
    }
  }
  for (const name of existingManaged) {
    if (!sourceNames.has(name)) {
      existingMarkers.set(name, inspectOwnedSkill(path.join(root, name), name));
    }
  }

  const receipt = emptySkillsReceipt(root);
  receipt.sourceCount = sources.length;

  const stagedSkills: Array<{
    name: string;
    stage: string;
    marker: ManagedSkillMarker;
  }> = [];
  try {
    for (const source of sources) {
      stagedSkills.push({
        name: source.name,
        ...stageRoutedSkill(
          source.source,
          root,
          source.name,
          source.provenance
        ),
      });
    }
  } catch (error) {
    for (const staged of stagedSkills) {
      fs.rmSync(staged.stage, { recursive: true, force: true });
    }
    throw error;
  }

  const applied: Array<{
    destination: string;
    backup?: string;
    kind: 'installed' | 'refreshed' | 'pruned';
  }> = [];
  try {
    for (const staged of stagedSkills) {
      const destination = path.join(root, staged.name);
      const existing = existingMarkers.get(staged.name);
      if (
        existing &&
        existing.sourceSha256 === staged.marker.sourceSha256 &&
        existing.routedSha256 === staged.marker.routedSha256 &&
        JSON.stringify(existing.provenance) ===
          JSON.stringify(staged.marker.provenance)
      ) {
        fs.rmSync(staged.stage, { recursive: true, force: true });
        receipt.current.push({
          ...existing,
          path: destination,
          status: 'current',
        });
        continue;
      }

      let backup: string | undefined;
      if (existing) {
        backup = `${destination}.${randomUUID()}.backup`;
        fs.renameSync(destination, backup);
      }
      try {
        fs.renameSync(staged.stage, destination);
      } catch (error) {
        if (backup && !fs.existsSync(destination)) {
          fs.renameSync(backup, destination);
        }
        throw error;
      }
      const status = existing ? 'refreshed' : 'installed';
      applied.push({ destination, backup, kind: status });
      receipt[status].push({
        ...staged.marker,
        path: destination,
        status,
      });
    }

    for (const name of existingManaged) {
      if (sourceNames.has(name)) continue;
      const destination = path.join(root, name);
      const marker = existingMarkers.get(name)!;
      const backup = `${destination}.${randomUUID()}.backup`;
      fs.renameSync(destination, backup);
      applied.push({ destination, backup, kind: 'pruned' });
      receipt.pruned.push({
        ...marker,
        path: destination,
        status: 'pruned',
      });
    }

    for (const mutation of applied) {
      if (mutation.backup) {
        try {
          fs.rmSync(mutation.backup, { recursive: true, force: true });
        } catch {
          // The new state is committed; a stale hidden backup is safer than rollback.
        }
      }
    }
  } catch (error) {
    for (const mutation of [...applied].reverse()) {
      if (mutation.kind !== 'pruned') {
        fs.rmSync(mutation.destination, { recursive: true, force: true });
      }
      if (mutation.backup && fs.existsSync(mutation.backup)) {
        fs.renameSync(mutation.backup, mutation.destination);
      }
    }
    for (const staged of stagedSkills) {
      fs.rmSync(staged.stage, { recursive: true, force: true });
    }
    throw error;
  }

  receipt.changed =
    receipt.installed.length > 0 ||
    receipt.refreshed.length > 0 ||
    receipt.pruned.length > 0;
  return receipt;
}

export function removeManagedProjectSkills(
  agent: RouterCardAgent,
  projectPath: string
): ProjectSkillsReceipt {
  const project = path.resolve(projectPath);
  const root = projectSkillsRoot(agent, project);
  const receipt = emptySkillsReceipt(root);
  try {
    assertSafeProjectPath(project, root);
  } catch (error) {
    if (error instanceof Error && error.message.includes('symlink')) {
      receipt.preserved.push({
        path: root,
        skillName: '*',
        reason: error.message,
      });
      return receipt;
    }
    throw error;
  }
  if (!fs.existsSync(root)) return receipt;

  const owned: Array<{ path: string; marker: ManagedSkillMarker }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const skillPath = path.join(root, entry.name);
    const markerPath = path.join(skillPath, MANAGED_SKILL_MARKER);
    if (!fs.existsSync(markerPath)) continue;
    try {
      owned.push({
        path: skillPath,
        marker: inspectOwnedSkill(skillPath, entry.name),
      });
    } catch (error) {
      let marker: Partial<ManagedSkillMarker> = {};
      try {
        marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      } catch {
        // The preservation receipt still records the path and reason.
      }
      receipt.preserved.push({
        path: skillPath,
        skillName: entry.name,
        reason: error instanceof Error ? error.message : 'unsafe managed skill',
        sourceSha256: marker.sourceSha256,
        routedSha256: marker.routedSha256,
        routerPrefixSha256: marker.routerPrefixSha256,
        provenance: marker.provenance,
      });
    }
  }

  for (const item of owned) {
    fs.rmSync(item.path, { recursive: true });
    receipt.removed.push({
      ...item.marker,
      path: item.path,
      status: 'removed',
    });
  }
  receipt.changed = receipt.removed.length > 0;
  return receipt;
}

export function installFullProjectRouterState(
  options: InstallFullProjectRouterStateOptions
): FullProjectRouterStateReceipt {
  const project = path.resolve(options.project);
  const root = projectSkillsRoot(options.agent, project);
  const preference = readPreference(project);
  if (!preference.enabled && !options.forceEnable) {
    return {
      operation: 'install',
      status: 'disabled',
      agent: options.agent,
      project,
      operationComplete: true,
      artifactsConfigured: false,
      nativeDiscovery: { status: 'unverified', verified: false },
      skills: emptySkillsReceipt(root),
      preference,
    };
  }
  if (
    !options.authenticated ||
    !options.mcpInstalled ||
    !options.skillsInstalled
  ) {
    throw new Error(
      'Router state requires authenticated MCP and skills setup to complete first.'
    );
  }

  assertRouterCardStateSafe(options.agent, project);
  const enabledPreference = options.forceEnable
    ? enablePreference(project)
    : preference;
  const cardPath = routerCardPath(
    project,
    resolveRouterCardContext(options.agent)
  );
  const cardExisted = fs.existsSync(cardPath);
  const cardBefore = cardExisted ? fs.readFileSync(cardPath, 'utf8') : '';
  const cardMode = cardExisted ? fs.statSync(cardPath).mode & 0o777 : 0o644;
  let card: RouterCardResult;
  let skills: ProjectSkillsReceipt;
  try {
    card = installRouterCard(options.agent, project);
    skills = installManagedProjectSkills(options.agent, project);
  } catch (error) {
    if (cardExisted) {
      atomicWriteFile(cardPath, cardBefore, cardMode);
    } else {
      fs.rmSync(cardPath, { force: true });
    }
    if (options.forceEnable && enabledPreference.changed) {
      atomicWriteFile(
        preference.path,
        `${JSON.stringify({ version: PREFERENCE_VERSION, enabled: false }, null, 2)}\n`,
        0o644
      );
    }
    throw error;
  }
  const changed = skills.changed || card.changed || enabledPreference.changed;
  return {
    operation: 'install',
    status: changed ? 'installed' : 'current',
    agent: options.agent,
    project,
    operationComplete: true,
    artifactsConfigured: true,
    nativeDiscovery: { status: 'pending', verified: false },
    card,
    skills,
    preference: enabledPreference,
  };
}

export function removeFullProjectRouterState(
  agent: RouterCardAgent,
  projectPath: string
): FullProjectRouterStateReceipt {
  const project = path.resolve(projectPath);
  const skills = removeManagedProjectSkills(agent, project);
  let card: RouterCardResult | undefined;
  let preservedCard: FullProjectRouterStateReceipt['preservedCard'];
  try {
    card = removeRouterCard(agent, project);
  } catch (error) {
    preservedCard = {
      path: routerCardPath(project, resolveRouterCardContext(agent)),
      reason:
        error instanceof Error ? error.message : 'unsafe managed router card',
    };
  }
  const preference = disablePreference(project);
  const preserved = skills.preserved.length > 0 || Boolean(preservedCard);
  return {
    operation: 'remove',
    status: preserved ? 'removed-with-preserved-content' : 'removed',
    agent,
    project,
    operationComplete: !preserved,
    artifactsConfigured: false,
    nativeDiscovery: { status: 'unverified', verified: false },
    card,
    preservedCard,
    skills,
    preference,
  };
}

export function skippedFullProjectRouterState(
  agent: RouterCardAgent,
  projectPath: string,
  warning: string
): FullProjectRouterStateReceipt {
  const project = path.resolve(projectPath);
  return {
    operation: 'install',
    status: 'skipped-safe',
    agent,
    project,
    operationComplete: false,
    artifactsConfigured: false,
    nativeDiscovery: { status: 'unverified', verified: false },
    warning,
    skills: emptySkillsReceipt(projectSkillsRoot(agent, project)),
    preference: {
      path: preferencePath(project),
      enabled: true,
      changed: false,
    },
  };
}
