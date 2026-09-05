/**
 * Regressions for the 2026-08-21 repair pass:
 *   1. finalize commits atomically enough that a refusal writes no vault note,
 *      appends no Decision-Log entry, and is safe to retry.
 *   2. the legacy pending.json bridge keeps its own client and session_id, and
 *      claims the file atomically so it can never be ingested twice.
 *   3. the generated OpenCode plugin carries no module-scoped one-shot state.
 *   4. hook installation preserves unrelated hook entries, owns only the exact
 *      commands it writes, and refuses rather than replacing a broken config.
 *   5. a capture that changes no profile content is never measured against the
 *      profile ceiling, and one that can never fit stops stalling the inbox.
 *   6. same-what decisions merge, replay keeps the supersedes chain, and a
 *      settled candidate status survives a re-save.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MAX_PROJECT_STATUS_CHARS,
  MAX_STACK_ITEM_CHARS,
  MAX_STACK_UPDATES,
  bridgeLegacyPending,
  listInboxCaptures,
  quarantineCapture,
  validateCapture,
  writeCapture
} from '../dist/lib/capture.js';
import { finalizeInbox, ingestHookPayload } from '../dist/lib/finalize.js';
import {
  installClaudeHooks,
  installCursorHooks,
  installOpencodePlugin,
  opencodePluginSource
} from '../dist/commands/hooks.js';
import { PROFILE_CEILING_BYTES, writeProfile } from '../dist/lib/profile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_MODULE = path.join(HERE, '..', 'dist', 'lib', 'capture.js');

const DECISION_LOG_HEADER = '# Decision Log\n\n---\n';

function seedTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khud-repair-'));
  process.env.KHUD_HOME = root;
  process.env.HOME = root;
  process.env.KHUD_CONFIG_HOME = path.join(root, '.config');
  process.env.KHUD_DESKTOP_DIR = path.join(root, 'Desktop');
  process.env.KHUD_VAULT_DIR = path.join(root, 'vault');
  fs.mkdirSync(path.join(root, 'vault', 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vault', 'Decisions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'vault', 'Decisions', 'Decision-Log.md'), DECISION_LOG_HEADER);
  fs.mkdirSync(path.join(root, '.khud'), { recursive: true });
  writeProfile({
    name: 'Test',
    updated: '2026-08-21',
    stack: ['typescript'],
    agents: ['claude-code'],
    preferences: [],
    active_project: { name: 'khud', description: 'test', stack: 'ts', status: 'testing' },
    recent_decisions: [],
    constraints: []
  });
  return root;
}

function sessionNotes(root) {
  return fs.readdirSync(path.join(root, 'vault', 'Sessions'));
}

function decisionNotes(root) {
  return fs
    .readdirSync(path.join(root, 'vault', 'Decisions'))
    .filter((name) => name.endsWith('.md') && !name.startsWith('Decision-Log'));
}

function decisionLog(root) {
  return fs.readFileSync(path.join(root, 'vault', 'Decisions', 'Decision-Log.md'), 'utf8');
}

function countLogBlocks(root, what) {
  return decisionLog(root).split(`**What:** ${what}`).length - 1;
}

function candidateFiles(root) {
  const dir = path.join(root, '.khud', 'candidates');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

function profilePath(root) {
  return path.join(root, '.khud', 'profile.json');
}

function profileBytes(root) {
  return fs.readFileSync(profilePath(root), 'utf8');
}

function quarantineFiles(root) {
  const dir = path.join(root, '.khud', 'quarantine');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

function inboxFiles(root) {
  const dir = path.join(root, '.khud', 'inbox');
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function candidates(root) {
  const dir = path.join(root, '.khud', 'candidates');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      file: path.join(dir, f),
      value: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    }));
}

function decisionNoteText(root, needle) {
  const dir = path.join(root, 'vault', 'Decisions');
  const match = decisionNotes(root).find((name) => name.includes(needle));
  assert.ok(match, `no decision note matching ${needle}`);
  return { name: match, text: fs.readFileSync(path.join(dir, match), 'utf8') };
}

/**
 * Push profile.json past the ceiling behind khud's back.
 *
 * Sentinel and a hand edit can both do this, and it is the state that used to
 * strand every capture: with the file already over the ceiling, even a capture
 * that would change nothing in it was refused.
 */
function bloatProfileBeyondCeiling(root) {
  const profile = JSON.parse(profileBytes(root));
  profile.constraints.push('q'.repeat(PROFILE_CEILING_BYTES));
  fs.writeFileSync(profilePath(root), `${JSON.stringify(profile, null, 2)}\n`);
}

/** Grow the profile until only `slack` bytes of headroom remain. */
function fillProfileToCeiling(root, slack) {
  const profilePath = path.join(root, '.khud', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const headroom =
    PROFILE_CEILING_BYTES - Buffer.byteLength(`${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  const filler = 'z'.repeat(Math.max(headroom - slack, 1));
  profile.stack.push(filler);
  writeProfile(profile);
  return filler;
}

test('an overfull static profile does not block dynamic session memory', async () => {
  const root = seedTempHome();
  fillProfileToCeiling(root, 40);

  writeCapture({
    client: 'claude-code',
    session_id: 'ceiling-atomic',
    project_status: 'a status long enough to be substantive for the episode gate',
    decisions: [{ what: 'Block before writing anything', why: 'atomicity' }],
    preferences_learned: [{ text: 'Always fail closed', evidence: { kind: 'explicit_user', quote: 'always fail closed', confidence: 0.9 } }],
    stack_updates: ['this stack entry does not fit under the ceiling'],
    source: 'agent'
  });

  const result = await finalizeInbox({ syncAgents: false });
  assert.equal(result.ceiling_blocked, 0);
  assert.equal(result.processed, 1);
  assert.equal(result.decisions, 1);
  assert.equal(result.pending_review, 1);
  assert.equal(sessionNotes(root).length, 1);
  assert.equal(decisionNotes(root).length, 1);
  assert.equal(countLogBlocks(root, 'Block before writing anything'), 1);
  assert.equal(candidateFiles(root).length, 1);
});

test('re-finalizing the same decision never appends a second Decision-Log entry', async () => {
  const root = seedTempHome();
  const { path: capturePath, record } = writeCapture({
    client: 'claude-code',
    session_id: 'log-idempotence',
    project_status: 'wrote the retry-safe Decision-Log append with an idempotence key',
    decisions: [{ what: 'Key the Decision-Log append', why: 'retries must not duplicate' }],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });

  const first = await finalizeInbox({ syncAgents: false });
  assert.equal(first.decisions, 1);
  assert.equal(countLogBlocks(root, 'Key the Decision-Log append'), 1);

  // Simulate a crash that lost the fingerprint store: the capture is replayed
  // with no memory of having been processed, which is the exact path that used
  // to prepend a duplicate block on every run.
  fs.rmSync(path.join(root, '.khud', 'processed', 'fingerprints.json'), { force: true });
  fs.mkdirSync(path.dirname(capturePath), { recursive: true });
  fs.writeFileSync(capturePath, JSON.stringify(record, null, 2));

  const second = await finalizeInbox({ syncAgents: false });
  assert.equal(second.processed, 1);
  assert.equal(countLogBlocks(root, 'Key the Decision-Log append'), 1);
  assert.equal(decisionNotes(root).length, 1);
  assert.equal(sessionNotes(root).length, 1);
});

test('a capture that fails validation is quarantined without touching the vault', async () => {
  const root = seedTempHome();
  const logBefore = decisionLog(root);
  const bad = path.join(root, '.khud', 'inbox', 'cursor', 'broken', 'x.json');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{"client":"cursor","project_status":"no session id"}');

  const result = await finalizeInbox({ syncAgents: false });
  assert.equal(result.quarantined, 1);
  assert.equal(result.processed, 0);
  assert.deepEqual(sessionNotes(root), []);
  assert.deepEqual(decisionNotes(root), []);
  assert.equal(decisionLog(root), logBefore);
});

test('bridging pending.json keeps the client and session that wrote it', async () => {
  const root = seedTempHome();
  fs.writeFileSync(
    path.join(root, '.khud', 'pending.json'),
    JSON.stringify({
      client: 'opencode',
      session_id: 'oc-42',
      date: '2026-08-21',
      decisions: [{ what: 'Keep legacy attribution', why: 'cross-agent correctness' }],
      preferences_learned: [],
      project_status: 'opencode session summary',
      stack_updates: []
    })
  );

  // An unrelated Claude Code stop hook fires next. It must not claim the file.
  const written = bridgeLegacyPending({ sessionId: 'claude-9', client: 'claude-code' });
  const bridged = JSON.parse(fs.readFileSync(written, 'utf8'));
  assert.equal(bridged.client, 'opencode');
  assert.equal(bridged.session_id, 'oc-42');
  assert.ok(written.includes(path.join('inbox', 'opencode', 'oc-42')));
});

test('a pending.json with no session id is never given an unrelated session id', () => {
  const root = seedTempHome();
  fs.writeFileSync(
    path.join(root, '.khud', 'pending.json'),
    JSON.stringify({
      agent: 'opencode',
      date: '2026-08-21',
      decisions: [],
      preferences_learned: [],
      project_status: 'opencode session with no session id',
      stack_updates: []
    })
  );

  const written = bridgeLegacyPending({ sessionId: 'claude-9', client: 'claude-code' });
  const bridged = JSON.parse(fs.readFileSync(written, 'utf8'));
  assert.equal(bridged.client, 'opencode');
  assert.equal(bridged.session_id, 'legacy-opencode-2026-08-21');
});

test('the hook session id is still used when the same client wrote the file', () => {
  const root = seedTempHome();
  fs.writeFileSync(
    path.join(root, '.khud', 'pending.json'),
    JSON.stringify({
      agent: 'cursor',
      date: '2026-08-21',
      decisions: [],
      preferences_learned: [],
      project_status: 'cursor session summary',
      stack_updates: []
    })
  );

  const written = bridgeLegacyPending({ sessionId: 'cursor-hook-1', client: 'cursor' });
  const bridged = JSON.parse(fs.readFileSync(written, 'utf8'));
  assert.equal(bridged.client, 'cursor');
  assert.equal(bridged.session_id, 'cursor-hook-1');
});

test('ingest attributes a bridged pending.json to its own agent end to end', async () => {
  const root = seedTempHome();
  fs.writeFileSync(
    path.join(root, '.khud', 'pending.json'),
    JSON.stringify({
      client: 'opencode',
      session_id: 'oc-77',
      date: '2026-08-21',
      decisions: [],
      preferences_learned: [],
      project_status: 'an opencode summary bridged by the claude code stop hook',
      stack_updates: []
    })
  );

  await ingestHookPayload({ client: 'claude-code', session_id: 'claude-abc', cwd: root });
  await finalizeInbox({ syncAgents: false });

  const processedRoot = path.join(root, '.khud', 'processed');
  assert.ok(fs.existsSync(path.join(processedRoot, 'opencode', 'oc-77')));
  assert.ok(!fs.existsSync(path.join(processedRoot, 'claude-code', 'oc-77')));
});

test('a repeated stop hook for one session yields one capture, not one per fire', async () => {
  const root = seedTempHome();
  await ingestHookPayload({ client: 'opencode', session_id: 'idle-twice' });
  await ingestHookPayload({ client: 'opencode', session_id: 'idle-twice' });

  // Deterministic capture ids mean the second fire overwrites the first file.
  const inbox = path.join(root, '.khud', 'inbox', 'opencode', 'idle-twice');
  assert.equal(fs.readdirSync(inbox).filter((f) => f.endsWith('.json')).length, 1);

  const first = await finalizeInbox({ syncAgents: false });
  assert.equal(first.processed, 1);

  await ingestHookPayload({ client: 'opencode', session_id: 'idle-twice' });
  const second = await finalizeInbox({ syncAgents: false });
  assert.equal(second.processed, 0);
  assert.equal(second.skipped_duplicates, 1);
});

test('the generated OpenCode plugin holds no module-scoped one-shot state', () => {
  seedTempHome();
  const source = opencodePluginSource();

  assert.doesNotMatch(source, /new Set\(/);
  assert.doesNotMatch(source, /finalized/);
  assert.doesNotMatch(source, /^(?:const|let|var)\s+\w*(?:seen|once|done)\w*\s*=/im);
  // Finalize stays reachable on every fire; only a missing session id skips it.
  assert.match(source, /function finalize\(sessionID, trigger\) \{\s*\n\s*if \(!sessionID\) return;/);
  assert.match(source, /session\.idle/);
  assert.match(source, /export const KhudSyncPlugin/);
});

test('installing claude hooks preserves unrelated entries and is idempotent', () => {
  const root = seedTempHome();
  const settingsPath = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      model: 'opus',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'my-own-session-start' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'my-own-stop' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-guard' }] }]
      }
    })
  );

  installClaudeHooks();
  const once = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  // Unrelated settings and unrelated events survive untouched.
  assert.equal(once.model, 'opus');
  assert.equal(once.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(once.hooks.PreToolUse[0].hooks[0].command, 'my-own-guard');

  const commands = (event) => once.hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands('SessionStart').includes('my-own-session-start'));
  assert.ok(commands('SessionStart').includes('khud sync --to claude'));
  assert.ok(commands('Stop').includes('my-own-stop'));
  assert.ok(commands('Stop').some((c) => c.endsWith('.local/bin/khud-obsidian-stop')));
  assert.ok(
    commands('UserPromptSubmit').some((c) => c === `${path.join(root, '.local/bin/turbovec-recall-prompt')} --client claude-code`)
  );

  installClaudeHooks();
  const twice = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const twiceCommands = (event) => twice.hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const khudEntries = twiceCommands(event).filter((c) => c.includes('khud'));
    assert.equal(khudEntries.length, 1, `${event} stacked a duplicate khud hook`);
  }
  assert.ok(twiceCommands('SessionStart').includes('my-own-session-start'));
  assert.ok(twiceCommands('Stop').includes('my-own-stop'));
});

test('installing cursor hooks preserves unrelated entries and replaces the retired one', () => {
  const root = seedTempHome();
  const hooksPath = path.join(root, '.cursor', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(
    hooksPath,
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: './hooks/session-start.sh' }, { command: 'my-own-session-start' }],
        stop: [{ command: 'my-own-stop' }],
        afterEdit: [{ command: 'my-own-format' }]
      }
    })
  );

  installCursorHooks();
  const file = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const commands = (event) => file.hooks[event].map((h) => h.command);

  assert.equal(file.version, 1);
  assert.deepEqual(commands('afterEdit'), ['my-own-format']);
  assert.ok(commands('sessionStart').includes('my-own-session-start'));
  assert.ok(commands('sessionStart').includes('khud sync --to cursor'));
  // The retired relative-path entry khud used to install must be gone.
  assert.ok(!commands('sessionStart').includes('./hooks/session-start.sh'));
  assert.ok(commands('stop').includes('my-own-stop'));
  assert.ok(commands('stop').some((c) => c.endsWith('.local/bin/khud-obsidian-stop')));
  assert.ok(commands('beforeSubmitPrompt').some((c) => c === `${path.join(root, '.local/bin/turbovec-recall-prompt')} --client cursor`));

  installCursorHooks();
  const again = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  assert.equal(again.hooks.sessionStart.filter((h) => h.command.includes('khud')).length, 1);
  assert.equal(again.hooks.beforeSubmitPrompt.length, 1);
  assert.equal(again.hooks.stop.length, 2);
});

test('installing the opencode plugin writes the plugin file under the config dir', () => {
  const root = seedTempHome();
  installOpencodePlugin();
  const pluginPath = path.join(root, '.config', 'opencode', 'plugins', 'khud-sync.js');
  assert.ok(fs.existsSync(pluginPath));
  assert.match(fs.readFileSync(pluginPath, 'utf8'), /export const KhudSyncPlugin/);
});

test('a capture that changes no profile content is not measured against the ceiling', async () => {
  const root = seedTempHome();
  bloatProfileBeyondCeiling(root);
  const before = profileBytes(root);

  writeCapture({
    client: 'claude-code',
    session_id: 'noop-profile',
    // The status already on the profile, a stack entry already in it, and a
    // preference that only queues: nothing here changes profile content.
    project_status: 'testing',
    decisions: [
      { what: 'Skip the ceiling for a no-op capture', why: 'a restamped date is not a change' }
    ],
    preferences_learned: [{ text: 'Never restamp the profile for nothing' }],
    stack_updates: ['typescript'],
    source: 'agent'
  });

  const result = await finalizeInbox({ syncAgents: false });
  assert.equal(result.ceiling_blocked, 0);
  assert.equal(result.processed, 1);
  assert.equal(result.decisions, 1);
  assert.equal(result.pending_review, 1);
  // Not rewritten at all, so `updated` did not move either.
  assert.equal(profileBytes(root), before);
  assert.equal(decisionNotes(root).length, 1);
  assert.equal(sessionNotes(root).length, 1);
});

test('dynamic project status stays in the session note and never rewrites static identity', async () => {
  const root = seedTempHome();
  const before = JSON.parse(profileBytes(root));
  writeCapture({
    client: 'hermes',
    session_id: 'other-project-status',
    project_status: 'Completed a different project session with measured results',
    decisions: [],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });

  const result = await finalizeInbox({ syncAgents: false });
  assert.equal(result.processed, 1);
  assert.equal(result.episodes, 1);
  const after = JSON.parse(profileBytes(root));
  assert.equal(after.active_project.status, before.active_project.status);
  assert.match(
    fs.readFileSync(path.join(root, 'vault', 'Sessions', sessionNotes(root)[0]), 'utf8'),
    /Completed a different project session with measured results/
  );
});

test('project-specific stack updates stay in the session note, not static identity', async () => {
  const root = seedTempHome();
  bloatProfileBeyondCeiling(root);
  const before = profileBytes(root);

  writeCapture({
    client: 'claude-code',
    session_id: 'grows-profile',
    project_status: 'testing',
    decisions: [],
    preferences_learned: [],
    stack_updates: ['OpenGL ES offscreen render'],
    source: 'agent'
  });

  const result = await finalizeInbox({ syncAgents: false });
  assert.equal(result.ceiling_blocked, 0);
  assert.equal(result.processed, 1);
  assert.equal(profileBytes(root), before);
  assert.match(
    fs.readFileSync(path.join(root, 'vault', 'Sessions', sessionNotes(root)[0]), 'utf8'),
    /OpenGL ES offscreen render/
  );
});

test('project_status and stack updates are clamped before they reach memory notes', () => {
  seedTempHome();
  const record = validateCapture({
    client: 'claude-code',
    session_id: 'clamp-me',
    project_status: 'y'.repeat(5000),
    decisions: [],
    preferences_learned: [],
    stack_updates: Array.from({ length: 40 }, (_, i) => `${i}-${'x'.repeat(500)}`),
    source: 'agent'
  });

  assert.equal(record.project_status.length, MAX_PROJECT_STATUS_CHARS);
  assert.ok(record.project_status.endsWith('...'));
  assert.equal(record.stack_updates.length, MAX_STACK_UPDATES);
  for (const item of record.stack_updates) {
    assert.ok(item.length <= MAX_STACK_ITEM_CHARS, `stack entry too long: ${item.length}`);
  }
});

test('two decisions with the same what merge into one note and count once', async () => {
  const root = seedTempHome();
  const { record } = writeCapture({
    client: 'claude-code',
    session_id: 'same-what',
    project_status: 'testing',
    decisions: [
      { what: 'Dedupe same-what decisions', why: '' },
      {
        what: '  dedupe   same-what decisions  ',
        why: 'the second copy carries the reason',
        evidence: { kind: 'explicit_user', quote: 'dedupe them', confidence: 0.9 }
      }
    ],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });

  assert.equal(record.decisions.length, 1);
  assert.equal(record.decisions[0].what, 'Dedupe same-what decisions');
  assert.equal(record.decisions[0].why, 'the second copy carries the reason');
  assert.equal(record.decisions[0].evidence.kind, 'explicit_user');

  const result = await finalizeInbox({ syncAgents: false });
  assert.equal(result.decisions, 1);
  assert.equal(decisionNotes(root).length, 1);
  assert.equal(countLogBlocks(root, 'Dedupe same-what decisions'), 1);
});

test('the same decision across captures keeps the richer reason and counts one note', async () => {
  const root = seedTempHome();
  const common = {
    client: 'claude-code',
    session_id: 'same-decision-across-captures',
    date: '2026-08-21',
    project_status: 'testing',
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  };
  writeCapture({
    ...common,
    decisions: [{ what: 'Keep one canonical decision', why: 'short reason' }]
  });
  writeCapture({
    ...common,
    decisions: [
      {
        what: 'Keep one canonical decision',
        why: 'the fuller measured reason must survive regardless of capture ordering'
      }
    ]
  });

  const result = await finalizeInbox({ syncAgents: false });
  assert.equal(result.processed, 2);
  assert.equal(result.decisions, 1);
  assert.equal(decisionNotes(root).length, 1);
  assert.match(
    decisionNoteText(root, '2026-08-21').text,
    /\*\*Why:\*\* the fuller measured reason must survive regardless of capture ordering/
  );
  assert.equal(countLogBlocks(root, 'Keep one canonical decision'), 1);
  assert.match(
    decisionLog(root),
    /\*\*Why:\*\* the fuller measured reason must survive regardless of capture ordering/
  );
});

test('inbox enumeration ignores non-files and quarantine never crashes on them', async () => {
  const root = seedTempHome();
  writeCapture({
    client: 'cursor',
    session_id: 'healthy-next-to-debris',
    project_status: 'valid capture beside non-file inbox entries',
    decisions: [],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });

  const sessionDir = path.join(root, '.khud', 'inbox', 'cursor', 'healthy-next-to-debris');
  const poisonDir = path.join(sessionDir, 'poison.json');
  const linkedJson = path.join(sessionDir, 'linked.json');
  const nestedInvalid = path.join(sessionDir, 'legacy', '2026-08-01', 'review.json');
  fs.mkdirSync(poisonDir);
  fs.symlinkSync(path.join(sessionDir, fs.readdirSync(sessionDir)[0]), linkedJson);
  fs.mkdirSync(path.dirname(nestedInvalid), { recursive: true });
  fs.writeFileSync(nestedInvalid, JSON.stringify({ report: 'not a capture' }));

  assert.equal(listInboxCaptures().length, 2);
  assert.doesNotThrow(() => quarantineCapture(poisonDir, 'non-regular inbox entry'));
  assert.ok(fs.statSync(poisonDir).isDirectory());

  const result = await finalizeInbox({ syncAgents: false });
  assert.equal(result.processed, 1);
  assert.equal(result.quarantined, 1);
});

test('replaying a capture keeps the supersedes chain its note already recorded', async () => {
  const root = seedTempHome();
  writeCapture({
    client: 'claude-code',
    session_id: 'chain-first',
    date: '2026-08-20',
    project_status: 'testing',
    decisions: [{ what: 'Route recall through one hook', why: 'first call' }],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });
  await finalizeInbox({ syncAgents: false });

  const { path: secondPath, record: second } = writeCapture({
    client: 'claude-code',
    session_id: 'chain-second',
    date: '2026-08-21',
    project_status: 'testing',
    decisions: [{ what: 'Route recall through one hook', why: 'revised after measuring' }],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });
  await finalizeInbox({ syncAgents: false });

  const first = decisionNoteText(root, '2026-08-20');
  assert.match(first.text, /status: superseded/);
  const chained = decisionNoteText(root, '2026-08-21').text.match(/^supersedes:\s*(.+)$/m);
  assert.ok(chained, 'the second note recorded no supersedes');
  assert.equal(chained[1].trim(), first.name.replace(/\.md$/, ''));

  // Replay with no memory of having processed it. The note is rewritten from the
  // capture alone, which never knew about its predecessor.
  fs.rmSync(path.join(root, '.khud', 'processed', 'fingerprints.json'), { force: true });
  fs.mkdirSync(path.dirname(secondPath), { recursive: true });
  fs.writeFileSync(secondPath, JSON.stringify(second, null, 2));
  await finalizeInbox({ syncAgents: false });

  const replayed = decisionNoteText(root, '2026-08-21');
  const stillChained = replayed.text.match(/^supersedes:\s*(.+)$/m);
  assert.ok(stillChained, 'replay erased the supersedes chain');
  assert.equal(stillChained[1].trim(), first.name.replace(/\.md$/, ''));
  assert.match(replayed.text, /status: current/);
  assert.equal(decisionNotes(root).length, 2);
});

test('an unattributed hook session id is never stamped onto a summary that names its agent', () => {
  const root = seedTempHome();
  fs.writeFileSync(
    path.join(root, '.khud', 'pending.json'),
    JSON.stringify({
      agent: 'opencode',
      date: '2026-08-21',
      decisions: [],
      preferences_learned: [],
      project_status: 'opencode summary, the hook that bridged it never said who it was',
      stack_updates: []
    })
  );

  const written = bridgeLegacyPending({ sessionId: 'unattributed-hook-1' });
  const bridged = JSON.parse(fs.readFileSync(written, 'utf8'));
  assert.equal(bridged.client, 'opencode');
  assert.equal(bridged.session_id, 'legacy-opencode-2026-08-21');
});

test('two concurrent bridges ingest pending.json once, not twice', async () => {
  const root = seedTempHome();
  fs.writeFileSync(
    path.join(root, '.khud', 'pending.json'),
    JSON.stringify({
      date: '2026-08-21',
      decisions: [],
      preferences_learned: [],
      project_status: 'a summary that named neither its agent nor its session',
      stack_updates: []
    })
  );

  // Each child takes its session id from its own hint, so a double read leaves
  // two distinct captures in the inbox. That is the double-ingestion signature.
  const script = path.join(root, 'bridge-once.mjs');
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      `import { bridgeLegacyPending } from ${JSON.stringify(CAPTURE_MODULE)};`,
      'const [ready, barrier, sessionId] = process.argv.slice(2);',
      "fs.writeFileSync(ready, 'ready');",
      'const deadline = Date.now() + 10000;',
      'while (!fs.existsSync(barrier) && Date.now() < deadline) {}',
      'const written = bridgeLegacyPending({ sessionId });',
      "process.stdout.write(written ? 'won' : 'lost');"
    ].join('\n')
  );

  const barrier = path.join(root, 'go');
  const run = (sessionId, ready) =>
    new Promise((resolve) => {
      let out = '';
      const child = spawn(process.execPath, [script, ready, barrier, sessionId], {
        env: { ...process.env }
      });
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
      });
      child.on('close', () => resolve(out));
    });

  const readyA = path.join(root, 'ready-a');
  const readyB = path.join(root, 'ready-b');
  const both = Promise.all([run('hook-a', readyA), run('hook-b', readyB)]);
  while (!(fs.existsSync(readyA) && fs.existsSync(readyB))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(barrier, 'go');
  const results = await both;

  assert.equal(results.filter((r) => r === 'won').length, 1, `results: ${results.join(',')}`);
  assert.equal(results.filter((r) => r === 'lost').length, 1, `results: ${results.join(',')}`);
  assert.equal(inboxFiles(root).length, 1);
  assert.ok(!fs.existsSync(path.join(root, '.khud', 'pending.json')));
});

test('a candidate the owner already rejected stays rejected across a replay', async () => {
  const root = seedTempHome();
  const { path: capturePath, record } = writeCapture({
    client: 'claude-code',
    session_id: 'terminal-status',
    project_status: 'testing',
    decisions: [],
    preferences_learned: [{ text: 'Ask before every repo file write' }],
    stack_updates: [],
    source: 'agent'
  });

  const first = await finalizeInbox({ syncAgents: false });
  assert.equal(first.pending_review, 1);
  const [candidate] = candidates(root);
  assert.equal(candidate.value.status, 'pending_review');

  // The owner turns it down in sentinel.
  fs.writeFileSync(
    candidate.file,
    JSON.stringify({ ...candidate.value, status: 'rejected' }, null, 2)
  );

  fs.rmSync(path.join(root, '.khud', 'processed', 'fingerprints.json'), { force: true });
  fs.mkdirSync(path.dirname(capturePath), { recursive: true });
  fs.writeFileSync(capturePath, JSON.stringify(record, null, 2));

  const second = await finalizeInbox({ syncAgents: false });
  assert.equal(second.processed, 1);
  // Neither re-queued nor re-counted.
  assert.equal(second.pending_review, 0);
  assert.equal(candidates(root).length, 1);
  assert.equal(candidates(root)[0].value.status, 'rejected');
});

test('hook install refuses a config it cannot parse and preserves it byte for byte', () => {
  const root = seedTempHome();
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const brokenClaude = '{\n  "model": "opus",\n  "hooks": {\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, brokenClaude);
  assert.throws(() => installClaudeHooks(), /not valid JSON/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), brokenClaude);

  const hooksPath = path.join(root, '.cursor', 'hooks.json');
  const brokenCursor = '{ "version": 1, "hooks": { "stop": [ }';
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, brokenCursor);
  assert.throws(() => installCursorHooks(), /not valid JSON/);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), brokenCursor);
});

test('hook install refuses a config whose hooks are the wrong shape', () => {
  const root = seedTempHome();
  const settingsPath = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const wrongMap = JSON.stringify({ model: 'opus', hooks: ['not', 'a', 'map'] }, null, 2);
  fs.writeFileSync(settingsPath, wrongMap);
  assert.throws(() => installClaudeHooks(), /not an object/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), wrongMap);

  const wrongEvent = JSON.stringify({ hooks: { Stop: 'my-own-stop' } }, null, 2);
  fs.writeFileSync(settingsPath, wrongEvent);
  assert.throws(() => installClaudeHooks(), /is not an array/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), wrongEvent);

  const malformedGroup = JSON.stringify(
    { hooks: { Stop: [{ matcher: 'keep-me', hooks: 'my-own-stop' }] } },
    null,
    2
  );
  fs.writeFileSync(settingsPath, malformedGroup);
  assert.throws(() => installClaudeHooks(), /hooks\.Stop\[0\]\.hooks is not an array/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), malformedGroup);

  const hooksPath = path.join(root, '.cursor', 'hooks.json');
  const malformedCursorEntry = JSON.stringify(
    { version: 1, hooks: { stop: ['my-own-stop'] } },
    null,
    2
  );
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, malformedCursorEntry);
  assert.throws(() => installCursorHooks(), /hooks\.stop\[0\] is not an object/);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), malformedCursorEntry);
});

test('hook install owns only the commands it wrote, not everything containing khud', () => {
  const root = seedTempHome();
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const ownWrapper = path.join(root, '.local/bin/my-khud-recall');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'khud status' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: ownWrapper }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'bash ./hooks/session-start.sh --mine' }] }]
      }
    })
  );

  installClaudeHooks();
  const file = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const commands = (event) => file.hooks[event].flatMap((g) => g.hooks.map((h) => h.command));

  // All three contain a khud marker or a retired path fragment, and none of them
  // is a command khud ever wrote.
  assert.ok(commands('SessionStart').includes('khud status'));
  assert.ok(commands('UserPromptSubmit').includes(ownWrapper));
  assert.ok(commands('Stop').includes('bash ./hooks/session-start.sh --mine'));
});

// Updated 2026-09-05: the two per-client wrappers collapsed into one that takes
// --client, so both old names are retired and each host keeps exactly one recall hook.
test('installing hooks retires every old recall wrapper and leaves one recall hook', () => {
  const root = seedTempHome();
  const retired = path.join(root, '.local/bin/turbovec-recall-claude');
  const alsoRetired = path.join(root, '.local/bin/khud-prompt-recall-claude');

  const settingsPath = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: retired }] },
          { hooks: [{ type: 'command', command: alsoRetired }] }
        ]
      }
    })
  );

  installClaudeHooks();
  const claude = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const claudeCommands = claude.hooks.UserPromptSubmit.flatMap((g) =>
    g.hooks.map((h) => h.command)
  );
  assert.deepEqual(claudeCommands, [`${path.join(root, '.local/bin/turbovec-recall-prompt')} --client claude-code`]);
  assert.equal(claudeCommands.filter((c) => /recall/.test(c)).length, 1);

  const hooksPath = path.join(root, '.cursor', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(
    hooksPath,
    JSON.stringify({
      version: 1,
      hooks: { beforeSubmitPrompt: [{ command: `python3 ${retired}` }] }
    })
  );

  installCursorHooks();
  const cursor = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const cursorCommands = cursor.hooks.beforeSubmitPrompt.map((h) => h.command);
  assert.equal(cursorCommands.length, 1);
  assert.equal(cursorCommands[0], `${path.join(root, '.local/bin/turbovec-recall-prompt')} --client cursor`);
});
