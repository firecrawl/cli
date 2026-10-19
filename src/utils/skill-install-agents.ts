import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

/**
 * Global targets understood by the third-party installer (verified with 1.7.2).
 * Keep this separate from native installation: npx resolves its own destination
 * paths, and supports more agents and configuration overrides than native does.
 * Only agents with global support belong here. Explicit --agent bypasses this.
 */
export function detectGlobalSkillAgents(): string[] {
  const home = os.homedir();
  const cwd = process.cwd();
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const inHome = (...names: string[]) =>
    names.map((name) => path.join(home, name));
  const configured = (variable: string, fallback: string) => [
    process.env[variable]?.trim() || path.join(home, fallback),
  ];
  const optional = (variable: string, suffix: string) => {
    const value = process.env[variable]?.trim();
    return value ? [path.join(value, suffix)] : [];
  };

  const locations: Record<string, string[]> = {
    'aider-desk': inHome('.aider-desk'),
    amp: [path.join(config, 'amp')],
    antigravity: inHome('.gemini/antigravity'),
    'antigravity-cli': inHome('.gemini/antigravity-cli'),
    astrbot: [...inHome('.astrbot'), path.join(cwd, 'data/skills')],
    'autohand-code': configured('AUTOHAND_HOME', '.autohand'),
    augment: inHome('.augment'),
    bob: inHome('.bob'),
    'claude-code': configured('CLAUDE_CONFIG_DIR', '.claude'),
    openclaw: inHome('.openclaw', '.clawdbot', '.moltbot'),
    cline: inHome('.cline'),
    'codearts-agent': inHome('.codeartsdoer'),
    codebuddy: [...inHome('.codebuddy'), path.join(cwd, '.codebuddy')],
    codemaker: inHome('.codemaker'),
    codestudio: inHome('.codestudio'),
    codex: [...configured('CODEX_HOME', '.codex'), '/etc/codex'],
    'command-code': inHome('.commandcode'),
    continue: [...inHome('.continue'), path.join(cwd, '.continue')],
    cortex: inHome('.snowflake/cortex'),
    // The installer fixes both Crush detection and installation under ~/.config,
    // even when XDG_CONFIG_HOME is set. Do not substitute `config` here.
    crush: inHome('.config/crush'),
    cursor: inHome('.cursor'),
    deepagents: inHome('.deepagents'),
    devin: [path.join(config, 'devin')],
    dexto: inHome('.dexto'),
    droid: inHome('.factory'),
    firebender: inHome('.firebender'),
    forgecode: inHome('.forge'),
    fx: inHome('.fx'),
    'gemini-cli': inHome('.gemini'),
    'github-copilot': inHome('.copilot'),
    goose: [path.join(config, 'goose')],
    grok: configured('GROK_HOME', '.grok'),
    'hermes-agent': configured('HERMES_HOME', '.hermes'),
    'inference-sh': inHome('.inferencesh'),
    jazz: [...inHome('.jazz'), path.join(cwd, '.jazz')],
    junie: inHome('.junie'),
    'iflow-cli': inHome('.iflow'),
    kilo: inHome('.kilo', '.kilocode'),
    kimchi: inHome('.config/kimchi'),
    'kimi-code-cli': inHome('.kimi-code', '.kimi'),
    'kiro-cli': inHome('.kiro'),
    kode: inHome('.kode'),
    lingma: inHome('.lingma'),
    loaf: inHome('.loaf'),
    mcpjam: inHome('.mcpjam'),
    'minimax-code': [...inHome('.minimax'), '/Applications/MiniMax Code.app'],
    'mistral-vibe': configured('VIBE_HOME', '.vibe'),
    moxby: inHome('.moxby'),
    mux: inHome('.mux'),
    opencode: [path.join(config, 'opencode')],
    openhands: inHome('.openhands'),
    ona: inHome('.ona'),
    pi: inHome('.pi/agent'),
    'posit-assistant': inHome('.posit/assistant', '.positai'),
    qoder: inHome('.qoder'),
    'qoder-cn': inHome('.qoder-cn'),
    'qwen-code': inHome('.qwen'),
    replit: [path.join(cwd, '.replit')],
    reasonix: inHome('.reasonix'),
    rovodev: inHome('.rovodev'),
    roo: inHome('.roo'),
    'sarvam-code': configured('SARVAM_HOME', '.sarvam'),
    'tabnine-cli': inHome('.tabnine'),
    terramind: inHome('.terramind'),
    tinycloud: inHome('.tinycloud'),
    trae: inHome('.trae'),
    'trae-cn': inHome('.trae-cn'),
    warp: inHome('.warp'),
    windsurf: inHome('.codeium/windsurf'),
    zed: [
      path.join(config, 'zed'),
      ...optional('APPDATA', 'Zed'),
      ...optional('FLATPAK_XDG_CONFIG_HOME', 'zed'),
    ],
    zcode: [...inHome('.zcode'), '/Applications/ZCode.app'],
    zencoder: inHome('.zencoder'),
    zenflow: inHome('.zencoder'),
    neovate: inHome('.neovate'),
    pochi: inHome('.pochi'),
    adal: inHome('.adal'),
  };

  return Object.entries(locations)
    .filter(([, candidates]) =>
      candidates.some((candidate) => existsSync(candidate))
    )
    .map(([name]) => name);
}
