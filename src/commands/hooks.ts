import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';

import { type SupportedTarget, expandTargets } from '../lib/agents.js';
import { atomicWriteText } from '../lib/atomic.js';
import { displayPath, resolvePaths } from '../lib/paths.js';

// Resolved per call, never at module load. Anything captured at import time is
// bound to the process's original HOME, which made these installers untestable
// and made a KHUD_HOME override silently write to the real config instead.
const paths = () => resolvePaths();

function promptRecallScript(): string {
  return path.join(
    paths().desktopDir,
    'bilal-workspace/Active/turbovec-obsidian/hooks/prompt_recall.py'
  );
}

/**
 * The one recall wrapper, shared by every client.
 *
 * `khud-prompt-recall-claude` and `turbovec-recall-claude` were near copies that
 * disagreed on the Python runtime and both hardcoded the client to `claude-code`,
 * so Codex prompts were deduplicated as if they were Claude Code's. The client is
 * now an argument.
 */
function recallWrapper(): string {
  return path.join(paths().homeDir, '.local/bin/turbovec-recall-prompt');
}

function recallCommand(client: 'claude-code' | 'cursor'): string {
  return `${recallWrapper()} --client ${client}`;
}

/**
 * Recall wrappers khud used to install.
 *
 * They are retired, not renamed. Each has to be named here or install leaves it in
 * place beside the current wrapper, and every prompt then pays for two recall passes
 * over the same vault.
 */
function retiredRecallWrappers(): string[] {
  const home = paths().homeDir;
  const paths_ = [
    path.join(home, '.local/bin/khud-prompt-recall-claude'),
    path.join(home, '.local/bin/turbovec-recall-claude'),
    path.join(home, '.cursor/hooks/turbovec-recall-prompt.py')
  ];
  return [...paths_, ...paths_.map((item) => `python3 ${item}`)];
}

function stopWrapper(): string {
  return path.join(paths().homeDir, '.local/bin/khud-obsidian-stop');
}

interface CommandHook {
  type?: string;
  command: string;
  async?: boolean;
  timeout?: number;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks: CommandHook[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookGroup[]>;
  [key: string]: unknown;
}

interface CursorHook {
  command: string;
  timeout?: number;
}

interface CursorHooksFile {
  version: number;
  hooks: Record<string, CursorHook[]>;
  [key: string]: unknown;
}

/** Raised instead of overwriting a config khud cannot understand. */
export class HookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookConfigError';
  }
}

/**
 * The exact commands khud owns, and may therefore remove.
 *
 * Ownership used to be a substring test: any command containing `khud` (or
 * `prompt_recall.py`, or `hooks/session-start.sh`) was khud's to delete. That
 * claimed hooks it never wrote — an owner's own `khud status` hook, a personal
 * wrapper living under a path with `khud` in it, an unrelated
 * `hooks/session-start.sh` — and deleted them on every install.
 *
 * Whole commands are compared instead, so nothing khud did not write can match.
 * Retired entries are listed by name because that is now the only way they get
 * cleaned up; drop one from this list and a reinstall leaves a second copy of
 * that hook running beside the current one.
 */
function claudeManagedCommands(): string[] {
  return [
    // Current.
    'khud sync --to claude',
    recallCommand('claude-code'),
    stopWrapper(),
    // Retired.
    ...retiredRecallWrappers(),
    promptRecallScript(),
    `python3 ${promptRecallScript()}`,
    'khud finalize',
    'khud finalize-hook',
    './hooks/session-start.sh'
  ];
}

function cursorManagedCommands(): string[] {
  return [
    // Current.
    'khud sync --to cursor',
    recallCommand('cursor'),
    stopWrapper(),
    // Retired.
    ...retiredRecallWrappers(),
    'khud finalize',
    'khud finalize-hook',
    './hooks/session-start.sh'
  ];
}

/** Whitespace-normalized, so `python3  <path>` still matches `python3 <path>`. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function ownsCommand(command: string, managed: string[]): boolean {
  const value = normalizeCommand(command);
  if (!value) return false;
  return managed.some((entry) => normalizeCommand(entry) === value);
}

/** Existing groups minus khud's own entries, then khud's current entries. */
function mergeClaudeEvent(
  event: string,
  existing: ClaudeHookGroup[] | undefined,
  own: CommandHook[],
  managed: string[]
): ClaudeHookGroup[] {
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new HookConfigError(
      `hooks.${event} is not an array. Nothing was written; khud will not replace it.`
    );
  }
  const preserved: ClaudeHookGroup[] = [];
  for (const [groupIndex, group] of (existing || []).entries()) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new HookConfigError(
        `hooks.${event}[${groupIndex}] is not an object. Nothing was written; khud will not replace it.`
      );
    }
    if (!Array.isArray(group.hooks)) {
      throw new HookConfigError(
        `hooks.${event}[${groupIndex}].hooks is not an array. Nothing was written; khud will not replace it.`
      );
    }
    const hooks = group.hooks;
    for (const [hookIndex, hook] of hooks.entries()) {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
        throw new HookConfigError(
          `hooks.${event}[${groupIndex}].hooks[${hookIndex}] is not an object. ` +
            'Nothing was written; khud will not replace it.'
        );
      }
      if (typeof hook.command !== 'string') {
        throw new HookConfigError(
          `hooks.${event}[${groupIndex}].hooks[${hookIndex}].command is not a string. ` +
            'Nothing was written; khud will not replace it.'
        );
      }
    }
    const kept = hooks.filter((hook) => !ownsCommand(String(hook?.command || ''), managed));
    if (kept.length) preserved.push({ ...group, hooks: kept });
  }
  return [...preserved, { hooks: own }];
}

function mergeCursorEvent(
  event: string,
  existing: CursorHook[] | undefined,
  own: CursorHook[],
  managed: string[]
): CursorHook[] {
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new HookConfigError(
      `hooks.${event} is not an array. Nothing was written; khud will not replace it.`
    );
  }
  for (const [hookIndex, hook] of (existing || []).entries()) {
    if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
      throw new HookConfigError(
        `hooks.${event}[${hookIndex}] is not an object. Nothing was written; khud will not replace it.`
      );
    }
    if (typeof hook.command !== 'string') {
      throw new HookConfigError(
        `hooks.${event}[${hookIndex}].command is not a string. ` +
          'Nothing was written; khud will not replace it.'
      );
    }
  }
  const preserved = (existing || []).filter(
    (hook) => !ownsCommand(String(hook?.command || ''), managed)
  );
  return [...preserved, ...own];
}

/**
 * Parse a hook config, refusing rather than resetting.
 *
 * Both installers used to swallow a parse failure and carry on from `{}`, which
 * overwrote the file: a config with one trailing comma, or one mid-write read,
 * lost every hook and every unrelated setting in it. There is no recovering the
 * old content from khud, so the only safe move is to write nothing and say why.
 */
function readConfigObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new HookConfigError(
      `cannot read ${displayPath(filePath)}: ${(error as Error).message}. Nothing was written.`
    );
  }
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HookConfigError(
      `${displayPath(filePath)} is not valid JSON (${(error as Error).message}). ` +
        'Nothing was written. Fix or move the file, then re-run khud hooks install.'
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HookConfigError(
      `${displayPath(filePath)} is not a JSON object. Nothing was written; ` +
        'khud will not replace it.'
    );
  }
  return parsed as Record<string, unknown>;
}

/** The `hooks` map of a parsed config, refusing when it is present but not a map. */
function readHooksMap(
  filePath: string,
  config: Record<string, unknown> | null
): Record<string, unknown> {
  const hooks = config?.hooks;
  if (hooks === undefined || hooks === null) return {};
  if (typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new HookConfigError(
      `${displayPath(filePath)} has a "hooks" value that is not an object. Nothing was written.`
    );
  }
  return hooks as Record<string, unknown>;
}

export function cmdHooksInstall(target: string = 'all'): void {
  installHooksForTargets(expandTargets(target));
}

export function installHooksForTargets(targets: SupportedTarget[]): void {
  for (const currentTarget of targets) {
    try {
      if (currentTarget === 'claude') installClaudeHooks();
      else if (currentTarget === 'opencode') installOpencodePlugin();
      else if (currentTarget === 'cursor') installCursorHooks();
      else {
        // Codex, Pi and Hermes receive the shared core through `khud sync`, but khud
        // installs no hook for them. Saying so is the point: a silent no-op inside a
        // green command is exactly how a target goes unwired without anyone noticing.
        console.log(chalk.yellow(`- ${currentTarget.padEnd(9)} no khud-managed hook; identity is synced, recall is on demand`));
      }
    } catch (error) {
      console.log(chalk.red(`✗ ${currentTarget} - ${(error as Error).message}`));
    }
  }
}

export function installClaudeHooks(): void {
  const settingsPath = paths().claudeSettings;

  // Read and validate BEFORE creating anything: a refusal must leave the disk
  // exactly as it was.
  const parsed = readConfigObject(settingsPath);
  const settings = { ...(parsed || {}) } as ClaudeSettings;
  const hooks = readHooksMap(settingsPath, parsed) as Record<string, ClaudeHookGroup[]>;
  const managed = claudeManagedCommands();

  hooks.SessionStart = mergeClaudeEvent(
    'SessionStart',
    hooks.SessionStart,
    [{ type: 'command', command: 'khud sync --to claude', async: true }],
    managed
  );
  hooks.UserPromptSubmit = mergeClaudeEvent(
    'UserPromptSubmit',
    hooks.UserPromptSubmit,
    [{ type: 'command', command: recallCommand('claude-code') }],
    managed
  );
  hooks.Stop = mergeClaudeEvent(
    'Stop',
    hooks.Stop,
    [{ type: 'command', command: stopWrapper(), async: true }],
    managed
  );

  settings.hooks = hooks;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  atomicWriteText(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(chalk.green(`✓ claude    -> ${displayPath(settingsPath)} (sync + recall + finalize)`));
}

export function installOpencodePlugin(): void {
  const pluginsDir = paths().opencodePluginsDir;
  fs.mkdirSync(pluginsDir, { recursive: true });
  const pluginPath = path.join(pluginsDir, 'khud-sync.js');
  atomicWriteText(pluginPath, opencodePluginSource());
  console.log(chalk.green(`✓ opencode  -> ${displayPath(pluginPath)}`));
}

export function installCursorHooks(): void {
  const hooksPath = paths().cursorHooks;

  const parsed = readConfigObject(hooksPath);
  const file = { version: 1, ...(parsed || {}) } as CursorHooksFile;
  file.hooks = readHooksMap(hooksPath, parsed) as Record<string, CursorHook[]>;
  file.version ||= 1;
  const managed = cursorManagedCommands();

  // `khud sync --to cursor` replaces the old `./hooks/session-start.sh`, which was
  // a relative path resolved against whatever cwd Cursor happened to use.
  file.hooks.sessionStart = mergeCursorEvent(
    'sessionStart',
    file.hooks.sessionStart,
    [{ command: 'khud sync --to cursor' }],
    managed
  );
  file.hooks.beforeSubmitPrompt = mergeCursorEvent(
    'beforeSubmitPrompt',
    file.hooks.beforeSubmitPrompt,
    [{ command: recallCommand('cursor'), timeout: 15 }],
    managed
  );
  file.hooks.stop = mergeCursorEvent(
    'stop',
    file.hooks.stop,
    [{ command: stopWrapper() }],
    managed
  );

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  atomicWriteText(hooksPath, `${JSON.stringify(file, null, 2)}\n`);
  console.log(chalk.green(`✓ cursor    -> ${displayPath(hooksPath)} (sync + recall + finalize)`));
}

/**
 * The OpenCode plugin khud installs.
 *
 * There is deliberately no module-scoped one-shot state here. The previous
 * version kept `const finalized = new Set()` and skipped any session it had
 * already seen, which broke both ways: a plugin reload reset it, and a session
 * that idled early never finalized again when it actually ended. Dedupe belongs
 * downstream, where it is deterministic — capture ids are derived from capture
 * content, and finalize keys its fingerprint store on
 * `client:session_id:capture_id` under a lock.
 */
export function opencodePluginSource(): string {
  return `// khud-sync.js - OpenCode plugin for identity, recall, and finalize
// Auto-injected by: khud hooks install --for opencode
//
// Stateless by contract: every session event that means "this session ended"
// calls the stop wrapper. Repeats are cheap because finalize dedupes captures
// deterministically. Do not add module-scoped one-shot state here.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.HOME || os.homedir();
const STOP_HOOK = path.join(HOME, '.local/bin/khud-obsidian-stop');
const PROMPT_RECALL = '${promptRecallScript()}';
const PLUGIN_LOG = path.join(HOME, '.khud/history/opencode-plugin.log');

mkdirSync(path.dirname(PLUGIN_LOG), { recursive: true });

function log(line) {
  try {
    appendFileSync(PLUGIN_LOG, \`[\${new Date().toISOString()}] \${line}\\n\`);
  } catch {}
}

function runQuiet(cmd, args = [], input) {
  try {
    execFileSync(cmd, args, {
      input,
      stdio: input === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore']
    });
    return true;
  } catch {
    return false;
  }
}

function finalize(sessionID, trigger) {
  if (!sessionID) return;
  log(\`finalize \${trigger} session=\${sessionID}\`);
  const payload = JSON.stringify({
    client: 'opencode',
    session_id: sessionID,
    agent: 'opencode'
  });
  if (existsSync(STOP_HOOK)) {
    runQuiet(STOP_HOOK, [], payload);
  } else {
    runQuiet('khud', ['finalize-hook'], payload);
  }
}

function recall(prompt, sessionID) {
  if (!prompt || prompt.length < 15 || prompt.startsWith('/')) return '';
  try {
    const out = execFileSync('python3', [PROMPT_RECALL], {
      input: JSON.stringify({
        prompt,
        client: 'opencode',
        session_id: sessionID,
        output_format: 'json'
      }),
      encoding: 'utf8',
      timeout: 12000
    });
    const parsed = JSON.parse(out || '{}');
    return String(parsed.context || '');
  } catch {
    return '';
  }
}

export const KhudSyncPlugin = async () => {
  log('plugin loaded');
  return {
    event: async ({ event }) => {
      const t = event?.type || 'unknown';
      // Lifecycle only — never log token deltas.
      if (!t.startsWith('session.') && t !== 'message.updated') return;

      if (t === 'session.created') {
        runQuiet('khud', ['sync', '--to', 'opencode']);
        return;
      }
      if (t === 'session.idle' || t === 'session.deleted') {
        finalize(event?.properties?.sessionID, t);
      }
    },
    'chat.message': async ({ message, sessionID }) => {
      try {
        const textParts = (message?.parts || []).filter((part) => part?.type === 'text');
        const prompt = textParts.map((part) => part.text || '').join('\\n').trim();
        const context = recall(prompt, sessionID);
        if (!context) return;
        message.parts = message.parts || [];
        message.parts.push({
          type: 'text',
          text: \`\\n\\n[vault recall]\\n\${context}\`
        });
      } catch (error) {
        log(\`chat.message recall failed: \${error?.message || error}\`);
      }
    }
  };
};
`;
}
