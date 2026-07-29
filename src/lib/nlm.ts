import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { resolvePaths } from './paths.js';
import type { PendingSummary } from './types.js';

const PATHS = resolvePaths();
const NLM_CONFIG = path.join(PATHS.khudDir, 'nlm.json');
export const NLM_CONTEXT = path.join(PATHS.khudDir, 'nlm-context.md');
const NOTEBOOK_NAME = 'khud-session-memory';

interface NlmConfig {
  notebook_id: string;
  notebook_name: string;
  created: string;
}

function readNlmConfig(): NlmConfig | null {
  try {
    if (!fs.existsSync(NLM_CONFIG)) return null;
    return JSON.parse(fs.readFileSync(NLM_CONFIG, 'utf8')) as NlmConfig;
  } catch {
    return null;
  }
}

function writeNlmConfig(config: NlmConfig): void {
  fs.writeFileSync(NLM_CONFIG, JSON.stringify(config, null, 2));
}

function nlmRun(args: string[], timeoutMs = 30000): { stdout: string; ok: boolean } {
  try {
    const result = spawnSync('nlm', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { stdout: result.stdout ?? '', ok: result.status === 0 };
  } catch {
    return { stdout: '', ok: false };
  }
}

// Finds notebook by name from `nlm notebook list --json` output.
function findNotebookByName(name: string): string | null {
  const result = nlmRun(['notebook', 'list', '--json']);
  if (!result.ok) return null;
  try {
    const notebooks = JSON.parse(result.stdout) as Array<{ id: string; title: string }>;
    return notebooks.find((nb) => nb.title === name)?.id ?? null;
  } catch {
    return null;
  }
}

export function ensureNotebook(): string | null {
  const config = readNlmConfig();
  if (config?.notebook_id) return config.notebook_id;

  // Check if it already exists before creating
  const existing = findNotebookByName(NOTEBOOK_NAME);
  if (existing) {
    writeNlmConfig({ notebook_id: existing, notebook_name: NOTEBOOK_NAME, created: new Date().toISOString().slice(0, 10) });
    return existing;
  }

  const createResult = nlmRun(['notebook', 'create', NOTEBOOK_NAME]);
  if (!createResult.ok) return null;

  // Try to parse ID from output (UUID pattern), fallback to list lookup
  const uuidMatch = createResult.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const notebookId = uuidMatch?.[0] ?? findNotebookByName(NOTEBOOK_NAME);
  if (!notebookId) return null;

  writeNlmConfig({ notebook_id: notebookId, notebook_name: NOTEBOOK_NAME, created: new Date().toISOString().slice(0, 10) });
  return notebookId;
}

export function buildMemoryText(pending: PendingSummary): string {
  const decisionsText = pending.decisions.length > 0
    ? pending.decisions.map((d) => `- ${d.what} (why: ${d.why})`).join('\n')
    : '- none';

  const prefsText = pending.preferences_learned.length > 0
    ? pending.preferences_learned.map((p) => `- ${p}`).join('\n')
    : '- none';

  const stackText = (pending.stack_updates ?? []).length > 0
    ? (pending.stack_updates ?? []).map((s) => `- ${s}`).join('\n')
    : '- none';

  return [
    `Session date: ${pending.date}`,
    `Agent: ${pending.agent}`,
    `Goal: ${pending.project_status || 'not recorded'}`,
    '',
    'What changed:',
    decisionsText,
    '',
    'Decisions:',
    decisionsText,
    '',
    'Preferences learned:',
    prefsText,
    '',
    'Stack updates:',
    stackText,
    '',
    'Open items:',
    `- ${pending.project_status || 'none'}`,
    '',
    `Tags: kind=session-memory; agent=${pending.agent}; date=${pending.date}`
  ].join('\n');
}

export function saveSession(pending: PendingSummary): void {
  try {
    const notebookId = readNlmConfig()?.notebook_id;
    if (!notebookId) return;

    const text = buildMemoryText(pending);
    const title = `session-${pending.date}-${pending.agent}`;

    nlmRun(['source', 'add', notebookId, '--text', text, '--title', title], 30000);
  } catch {
    // silent fail - NLM is advisory only
  }
}

export function recallContext(): void {
  try {
    const notebookId = readNlmConfig()?.notebook_id;
    if (!notebookId) return;

    const result = nlmRun(
      [
        'notebook', 'query', notebookId,
        'Summarize the most recent sessions: what was the goal, what changed, what are open items and next steps?',
        '--timeout', '20'
      ],
      25000
    );

    if (!result.ok || !result.stdout.trim()) return;

    // nlm notebook query returns JSON with a `value.answer` field
    let recalled = result.stdout.trim();
    try {
      const parsed = JSON.parse(recalled) as { value?: { answer?: string } };
      if (parsed?.value?.answer) recalled = parsed.value.answer;
    } catch {
      // not JSON - use raw output
    }

    fs.writeFileSync(
      NLM_CONTEXT,
      `# Recent Session Context (NotebookLM)\n_Recalled: ${new Date().toISOString().slice(0, 10)}_\n\n${recalled}\n`
    );
  } catch {
    // silent fail
  }
}
