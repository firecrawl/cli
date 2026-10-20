export type SkillFamily = 'core' | 'build' | 'workflows';

export interface CatalogSkill {
  name: string;
  family: SkillFamily;
  files: Record<string, string>;
}

export const CATALOG_TREE_URL =
  'https://api.github.com/repos/firecrawl/skills/git/trees/main?recursive=1';

/** Match the files installed by the native skill installer. */
export function isSkillFile(file: string): boolean {
  return file
    .split('/')
    .every(
      (part) =>
        part.length > 0 &&
        !part.startsWith('.') &&
        part !== 'metadata.json' &&
        part !== '__pycache__' &&
        !part.includes('\\')
    );
}

/** Parse a complete Git tree, including references and other supporting files. */
export function parseCatalogTree(value: unknown): CatalogSkill[] {
  const data = value as { truncated?: boolean; tree?: unknown[] } | null;
  if (!data || data.truncated !== false || !Array.isArray(data.tree)) {
    throw new Error('The skill catalog returned an incomplete tree.');
  }
  const skills = new Map<string, CatalogSkill>();
  for (const entry of data.tree) {
    const file = entry as { path?: string; type?: string; sha?: string };
    if (!file || file.type !== 'blob' || typeof file.path !== 'string')
      continue;
    const match = file.path.match(
      /^skills\/(core|build|workflows)\/(firecrawl(?:-[a-z0-9]+)*)\/(.+)$/
    );
    if (!match || !isSkillFile(match[3])) continue;
    if (typeof file.sha !== 'string' || !/^[a-f0-9]{40}$/.test(file.sha)) {
      throw new Error('The skill catalog returned an invalid file hash.');
    }
    const [, family, name, relativePath] = match;
    const key = `${family}/${name}`;
    const skill = skills.get(key) ?? {
      name,
      family: family as SkillFamily,
      files: {},
    };
    skill.files[relativePath] = file.sha;
    skills.set(key, skill);
  }
  const result = [...skills.values()]
    .filter((skill) => Object.hasOwn(skill.files, 'SKILL.md'))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (
    !result.length ||
    new Set(result.map((skill) => skill.name)).size !== result.length
  ) {
    throw new Error('The skill catalog returned missing or duplicate skills.');
  }
  return result;
}

export async function fetchCatalogTree(timeoutMs = 5000): Promise<unknown> {
  const response = await fetch(CATALOG_TREE_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `Could not read the skill catalog (HTTP ${response.status}). Retry setup later.`
    );
  }
  return response.json();
}

/** Explicit setup always reads the current catalog, independent of notice caching. */
export async function getCatalogSkills(): Promise<CatalogSkill[]> {
  return parseCatalogTree(await fetchCatalogTree());
}
