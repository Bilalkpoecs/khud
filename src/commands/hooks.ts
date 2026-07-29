import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';

import { type SupportedTarget, expandTargets } from '../lib/agents.js';
import { displayPath, resolvePaths } from '../lib/paths.js';

const PATHS = resolvePaths();
const PROMPT_RECALL =
  '/home/bilal/Desktop/bilal-workspace/Active/turbovec-obsidian/hooks/prompt_recall.py';
const CLAUDE_RECALL_WRAPPER = path.join(PATHS.homeDir, '.local/bin/khud-prompt-recall-claude');
const CURSOR_RECALL_WRAPPER = path.join(PATHS.homeDir, '.cursor/hooks/turbovec-recall-prompt.py');
const STOP_WRAPPER = path.join(PATHS.homeDir, '.local/bin/khud-obsidian-stop');

interface CommandHook {
  type?: string;
  command: string;
  async?: boolean;
  timeout?: number;
}

interface ClaudeHookGroup {
  hooks: CommandHook[];
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookGroup[]>;
  [key: string]: unknown;
}

interface CursorHooksFile {
  version: number;
  hooks: Record<string, Array<{ command: string; timeout?: number }>>;
}

export function cmdHooksInstall(target: string = 'all'): void {
  installHooksForTargets(expandTargets(target));
}

export function installHooksForTargets(targets: SupportedTarget[]): void {
  for (const currentTarget of targets) {
    try {
      if (currentTarget === 'claude') installClaudeHooks();
      if (currentTarget === 'opencode') installOpencodePlugin();
      if (currentTarget === 'cursor') installCursorHooks();
    } catch (error) {
      console.log(chalk.red(`✗ ${currentTarget} - ${(error as Error).message}`));
    }
  }
}

function installClaudeHooks(): void {
  const settingsPath = PATHS.claudeSettings;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  let settings: ClaudeSettings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
    } catch {
      settings = {};
    }
  }

  settings.hooks ??= {};
  settings.hooks.SessionStart = [{
    hooks: [{ type: 'command', command: 'khud sync --to claude', async: true }]
  }];
  settings.hooks.UserPromptSubmit = [{
    hooks: [{ type: 'command', command: CLAUDE_RECALL_WRAPPER }]
  }];
  settings.hooks.Stop = [{
    hooks: [{
      type: 'command',
      command: STOP_WRAPPER,
      async: true
    }]
  }];

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(chalk.green(`✓ claude    -> ${displayPath(settingsPath)} (sync + recall + finalize)`));
}

function installOpencodePlugin(): void {
  const pluginsDir = PATHS.opencodePluginsDir;
  fs.mkdirSync(pluginsDir, { recursive: true });
  const pluginPath = path.join(pluginsDir, 'khud-sync.js');
  fs.writeFileSync(pluginPath, OPENCODE_PLUGIN_SOURCE);
  console.log(chalk.green(`✓ opencode  -> ${displayPath(pluginPath)}`));
}

function installCursorHooks(): void {
  const hooksPath = PATHS.cursorHooks;
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });

  let hooks: CursorHooksFile = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as CursorHooksFile;
      hooks.hooks ??= {};
    } catch {
      hooks = { version: 1, hooks: {} };
    }
  }

  hooks.hooks.sessionStart = [{ command: './hooks/session-start.sh' }];
  hooks.hooks.beforeSubmitPrompt = [{
    command: `python3 ${CURSOR_RECALL_WRAPPER}`,
    timeout: 15
  }];
  hooks.hooks.stop = [{ command: STOP_WRAPPER }];

  fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
  console.log(chalk.green(`✓ cursor    -> ${displayPath(hooksPath)} (sync + recall + finalize)`));
  void PROMPT_RECALL;
}

const OPENCODE_PLUGIN_SOURCE = `// khud-sync.js - OpenCode plugin for identity, recall, and finalize
// Auto-injected by: khud hooks install --for opencode
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.HOME || os.homedir();
const STOP_HOOK = path.join(HOME, '.local/bin/khud-obsidian-stop');
const PROMPT_RECALL = '${PROMPT_RECALL}';
const PLUGIN_LOG = path.join(HOME, '.khud/history/opencode-plugin.log');
const finalized = new Set();

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
  if (!sessionID || finalized.has(sessionID)) return;
  finalized.add(sessionID);
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
