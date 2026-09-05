import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { safeFileStem } from '../dist/lib/atomic.js';
import {
  extractFromTranscript,
  inferClient,
  normalizeClient,
  quarantineCapture,
  validateCapture,
  writeCapture
} from '../dist/lib/capture.js';
import { buildPreferenceCandidate } from '../dist/lib/evidence.js';
import { finalizeInbox, ingestHookPayload } from '../dist/lib/finalize.js';
import { injectCursorProject } from '../dist/adapters/cursor.js';
import {
  PROFILE_CEILING_BYTES,
  ProfileCeilingError,
  writeProfile
} from '../dist/lib/profile.js';
import { announcePendingReview, sentinelReviewUrl } from '../dist/lib/notice.js';
import {
  isSubstantiveStatus,
  shouldWriteSessionEpisode
} from '../dist/lib/sessionNote.js';

function seedTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khud-test-'));
  process.env.KHUD_HOME = root;
  process.env.HOME = root;
  process.env.KHUD_DESKTOP_DIR = path.join(root, 'Desktop');
  process.env.KHUD_VAULT_DIR = path.join(root, 'vault');
  fs.mkdirSync(path.join(root, 'vault', 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vault', 'Decisions'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'vault', 'Decisions', 'Decision-Log.md'),
    '# Decision Log\n\n---\n'
  );
  fs.mkdirSync(path.join(root, '.khud'), { recursive: true });
  writeProfile({
    name: 'Test',
    updated: '2026-07-17',
    stack: ['typescript'],
    agents: ['cursor'],
    preferences: ['Never use default exports in TypeScript'],
    active_project: {
      name: 'khud',
      description: 'test',
      stack: 'ts',
      status: 'testing'
    },
    recent_decisions: [],
    constraints: []
  });
  return root;
}

test('safeFileStem removes path separators and newlines', () => {
  assert.equal(safeFileStem('a/b\nc:d'), 'a-b c-d');
});

test('validateCapture requires session_id', () => {
  seedTempHome();
  assert.throws(
    () => validateCapture({ client: 'cursor', project_status: 'x' }),
    /session_id/
  );
});

test('no preference reaches the profile without approval, however strong the evidence', async () => {
  const root = seedTempHome();
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ role: 'user', content: 'Always prefer named exports in TypeScript' }) + '\n'
  );

  writeCapture({
    client: 'cursor',
    session_id: 's1',
    transcript_path: transcript,
    project_status: 'learned preference',
    decisions: [],
    preferences_learned: [
      {
        text: 'Always prefer named exports in TypeScript',
        evidence: {
          kind: 'explicit_user',
          quote: 'Always prefer named exports in TypeScript',
          confidence: 0.9
        }
      },
      {
        text: 'Maybe use tabs',
        evidence: { kind: 'agent_observation', quote: 'inferred', confidence: 0.3 }
      }
    ],
    stack_updates: [],
    source: 'agent'
  });

  const result = await finalizeInbox({ syncAgents: false });
  assert.equal(result.episodes, 1);
  // A verbatim-verified quote used to land in the profile directly. It is now
  // queued like everything else, so sentinel is the only promotion path.
  assert.equal(result.promoted_preferences, 0);
  assert.equal(result.pending_review, 2);
  // Every queued rule reports its candidate id so the notice can deep-link it.
  assert.equal(result.pending_review_ids.length, 2);
  for (const id of result.pending_review_ids) {
    assert.ok(fs.existsSync(path.join(root, '.khud', 'candidates', `${id}.json`)));
  }

  const profile = JSON.parse(fs.readFileSync(path.join(root, '.khud', 'profile.json'), 'utf8'));
  assert.ok(!profile.preferences.includes('Always prefer named exports in TypeScript'));
  assert.ok(!profile.preferences.includes('Maybe use tabs'));

  // The evidence is still classified, so the review UI can show why the first
  // candidate is trustworthy and the second is not.
  const candidatesDir = path.join(root, '.khud', 'candidates');
  const candidates = fs
    .readdirSync(candidatesDir)
    .map((file) => JSON.parse(fs.readFileSync(path.join(candidatesDir, file), 'utf8')));
  const named = candidates.find((c) => c.text === 'Always prefer named exports in TypeScript');
  assert.equal(named.status, 'pending_review');
  assert.equal(named.evidence.kind, 'explicit_user');
  assert.ok(named.evidence.confidence >= 0.9);
});

test('duplicate finalize is idempotent', async () => {
  const root = seedTempHome();
  const { path: filePath, record } = writeCapture({
    client: 'claude-code',
    session_id: 'dup-session',
    project_status: 'first write',
    decisions: [{ what: 'Use inbox captures', why: 'parity' }],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });

  const first = await finalizeInbox({ syncAgents: false });
  assert.equal(first.processed, 1);
  assert.equal(first.decisions, 1);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
  const second = await finalizeInbox({ syncAgents: false });
  assert.equal(second.skipped_duplicates, 1);

  const decisionFiles = fs
    .readdirSync(path.join(root, 'vault', 'Decisions'))
    .filter((name) => name.endsWith('.md') && !name.startsWith('Decision-Log'));
  assert.equal(decisionFiles.length, 1);
});

test('concurrent finalize does not drop either capture', async () => {
  seedTempHome();
  writeCapture({
    client: 'cursor',
    session_id: 'c1',
    project_status: 'cursor done',
    decisions: [{ what: 'A', why: 'a' }],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });
  writeCapture({
    client: 'opencode',
    session_id: 'c2',
    project_status: 'opencode done',
    decisions: [{ what: 'B', why: 'b' }],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });

  const [r1, r2] = await Promise.all([
    finalizeInbox({ syncAgents: false }),
    finalizeInbox({ syncAgents: false })
  ]);
  const processed = r1.processed + r2.processed + r1.skipped_duplicates + r2.skipped_duplicates;
  assert.ok(processed >= 2);
});

test('invalid capture is quarantined', () => {
  const root = seedTempHome();
  const bad = path.join(root, '.khud', 'inbox', 'cursor', 'bad', 'x.json');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{not-json');
  const dest = quarantineCapture(bad, 'parse error');
  assert.ok(fs.existsSync(dest));
  assert.ok(!fs.existsSync(bad));
});

test('contradictory preference is not promoted', () => {
  const root = seedTempHome();
  const profile = JSON.parse(fs.readFileSync(path.join(root, '.khud', 'profile.json'), 'utf8'));
  const transcript = path.join(root, 't.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ role: 'user', content: 'Always use default exports in TypeScript' }) + '\n'
  );
  const verified = buildPreferenceCandidate(
    {
      text: 'Always use default exports in TypeScript',
      evidence: {
        kind: 'explicit_user',
        quote: 'Always use default exports in TypeScript',
        confidence: 0.9
      }
    },
    {
      schema_version: 1,
      capture_id: 'y',
      client: 'cursor',
      session_id: 's2',
      created_at: new Date().toISOString(),
      date: '2026-07-17',
      content_hash: 'h2',
      project_status: '',
      decisions: [],
      preferences_learned: [],
      stack_updates: [],
      source: 'agent',
      transcript_path: transcript
    },
    profile
  );
  assert.equal(verified.status, 'contradicted');
});

test('hook ingest bridges legacy pending.json', async () => {
  const root = seedTempHome();
  fs.writeFileSync(
    path.join(root, '.khud', 'pending.json'),
    JSON.stringify({
      agent: 'cursor',
      date: '2026-07-17',
      decisions: [{ what: 'Bridge pending', why: 'compat' }],
      preferences_learned: [],
      project_status: 'legacy bridge',
      stack_updates: []
    })
  );
  await ingestHookPayload({ client: 'cursor', session_id: 'hook-1' });
  const result = await finalizeInbox({ syncAgents: false });
  assert.ok(result.processed >= 1);
  assert.ok(!fs.existsSync(path.join(root, '.khud', 'pending.json')));
});

test('episode gate keeps decisions and rich status; skips stubs and run crumbs', async () => {
  assert.equal(
    isSubstantiveStatus(
      'Run 1304 Shopify apply: 186 ok, 2 partial_skip (already FULFILLED)'
    ),
    false
  );
  assert.equal(
    isSubstantiveStatus(
      'Prepared Shopify fulfill input for run 1304 (225 pkgs / 188 orders / 651 lines)'
    ),
    false
  );
  assert.equal(isSubstantiveStatus('Session abcd1234 ended (cursor)'), false);
  assert.equal(
    isSubstantiveStatus(
      'Wrote complete file-level refactor-context documentation verified against headers'
    ),
    true
  );

  const root = seedTempHome();
  writeCapture({
    client: 'cursor',
    session_id: 'thin-ops',
    project_status:
      'Run 1304 Shopify apply: 186 ok, 2 partial_skip (already FULFILLED)',
    decisions: [],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });
  writeCapture({
    client: 'cursor',
    session_id: 'rich-status',
    project_status:
      'Wrote complete file-level refactor-context documentation verified against headers',
    decisions: [],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });
  writeCapture({
    client: 'cursor',
    session_id: 'short-with-decision',
    project_status: 'done',
    decisions: [{ what: 'Keep short status if decisions exist', why: 'not too strict' }],
    preferences_learned: [],
    stack_updates: [],
    source: 'agent'
  });

  const result = await finalizeInbox({ syncAgents: false });
  assert.equal(result.processed, 3);
  assert.equal(result.episodes, 2);
  const sessions = fs.readdirSync(path.join(root, 'vault', 'Sessions'));
  assert.equal(sessions.length, 2);
  assert.ok(sessions.some((n) => n.includes('refactor-context')));
  assert.ok(sessions.some((n) => n.includes('done')));

  assert.equal(
    shouldWriteSessionEpisode({
      schema_version: 1,
      capture_id: 'x',
      client: 'cursor',
      session_id: 's',
      created_at: new Date().toISOString(),
      date: '2026-07-17',
      content_hash: 'h',
      project_status: 'Session deadbeef ended (cursor)',
      decisions: [],
      preferences_learned: [],
      stack_updates: [],
      source: 'hook'
    }),
    false
  );
});

test('writeProfile refuses a write over the byte ceiling and leaves the file untouched', () => {
  const root = seedTempHome();
  const profilePath = path.join(root, '.khud', 'profile.json');
  const before = fs.readFileSync(profilePath, 'utf8');

  const profile = JSON.parse(before);
  profile.preferences.push('x'.repeat(PROFILE_CEILING_BYTES));

  assert.throws(() => writeProfile(profile), ProfileCeilingError);
  assert.equal(fs.readFileSync(profilePath, 'utf8'), before);
});

test('writeProfile allows a write that exactly fits the ceiling', () => {
  const root = seedTempHome();
  const profilePath = path.join(root, '.khud', 'profile.json');

  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  // Grow one byte at a time until the next byte would breach, then write.
  let padding = 0;
  for (;;) {
    const probe = { ...profile, preferences: [...profile.preferences, 'y'.repeat(padding + 1)] };
    probe.updated = new Date().toISOString().slice(0, 10);
    // Same serialization writeProfile uses, trailing newline included.
    const bytes = Buffer.byteLength(`${JSON.stringify(probe, null, 2)}\n`, 'utf8');
    if (bytes > PROFILE_CEILING_BYTES) break;
    padding += 1;
  }
  profile.preferences.push('y'.repeat(padding));

  writeProfile(profile);
  const written = fs.readFileSync(profilePath, 'utf8');
  assert.ok(Buffer.byteLength(written, 'utf8') <= PROFILE_CEILING_BYTES);
  assert.ok(JSON.parse(written).preferences.includes('y'.repeat(padding)));
});

test('a full static profile does not block a dynamic stack session', async () => {
  const root = seedTempHome();
  const profilePath = path.join(root, '.khud', 'profile.json');

  // Fill the profile to just under the ceiling with one large stack entry.
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const headroom = PROFILE_CEILING_BYTES - Buffer.byteLength(
    `${JSON.stringify(profile, null, 2)}\n`,
    'utf8'
  );
  const filler = 'z'.repeat(Math.max(headroom - 40, 1));
  profile.stack.push(filler);
  writeProfile(profile);

  writeCapture({
    client: 'claude-code',
    session_id: 'ceiling-session',
    project_status: 'a status long enough to be substantive for the episode gate',
    decisions: [],
    preferences_learned: [],
    stack_updates: ['this stack entry does not fit under the ceiling'],
    source: 'agent'
  });

  const finalized = await finalizeInbox({ syncAgents: false });
  assert.equal(finalized.ceiling_blocked, 0);
  assert.equal(finalized.processed, 1);
  const after = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  assert.ok(!after.stack.includes('this stack entry does not fit under the ceiling'));
  assert.ok(after.stack.includes(filler));
  const note = fs.readFileSync(
    path.join(root, 'vault', 'Sessions', fs.readdirSync(path.join(root, 'vault', 'Sessions'))[0]),
    'utf8'
  );
  assert.match(note, /this stack entry does not fit under the ceiling/);
});

test('the ledger records every preference that appears or vanishes', () => {
  const root = seedTempHome();
  const ledgerPath = path.join(root, '.khud', 'profile-history.jsonl');
  const profilePath = path.join(root, '.khud', 'profile.json');

  const added = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  added.preferences.push('Prefer vertical tracer slices');
  writeProfile(added, { reason: 'owner asked', source: 'test' });

  const removed = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  removed.preferences = removed.preferences.filter((p) => p !== 'Prefer vertical tracer slices');
  writeProfile(removed, { reason: 'superseded', source: 'test' });

  const records = fs
    .readFileSync(ledgerPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  const addRecord = records.find(
    (r) => r.action === 'added' && r.text === 'Prefer vertical tracer slices'
  );
  const removeRecord = records.find(
    (r) => r.action === 'removed' && r.text === 'Prefer vertical tracer slices'
  );

  assert.equal(addRecord.field, 'preferences');
  assert.equal(addRecord.reason, 'owner asked');
  assert.equal(addRecord.source, 'test');
  // Same timestamp shape khud-history writes, so both writers stay readable.
  assert.match(addRecord.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  assert.equal(removeRecord.reason, 'superseded');
});

test('client is inferred from the transcript path when the hook payload omits it', async () => {
  const root = seedTempHome();
  const transcript = path.join(root, '.claude', 'projects', '-home-bilal', 'sess.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  // Claude Code's real shape: nested envelope, content as a string and as blocks.
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'mode', sessionId: 'hook-sess' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'always use pnpm' } }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'never use default exports' }] }
      })
    ].join('\n') + '\n'
  );

  // No `client` and no `agent` key at all, exactly as Claude Code's Stop hook sends it.
  const record = await ingestHookPayload({
    session_id: 'hook-sess',
    transcript_path: transcript,
    cwd: root
  });

  assert.equal(record.client, 'claude-code');
  assert.ok(!fs.existsSync(path.join(root, '.khud', 'processed', 'unknown')));
});

test('inferClient falls back to unknown only when no path identifies an agent', () => {
  seedTempHome();
  assert.equal(inferClient({ transcriptPath: '/home/b/.claude/projects/x/s.jsonl' }), 'claude-code');
  assert.equal(inferClient({ transcriptPath: '/home/b/.cursor/sessions/s.json' }), 'cursor');
  assert.equal(inferClient({ workspace: '/home/b/.local/share/opencode/x' }), 'opencode');
  assert.equal(inferClient({ transcriptPath: '/tmp/nothing.jsonl' }), 'unknown');
  assert.equal(inferClient({}), 'unknown');
});

test('a stated client is never overridden by path inference', () => {
  seedTempHome();
  // A cursor capture whose transcript happens to sit under ~/.claude must stay cursor.
  assert.equal(normalizeClient('cursor'), 'cursor');
});

test('transcript extraction reads nested message content in both shapes', () => {
  const root = seedTempHome();
  const transcript = path.join(root, 'nested.jsonl');
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'always run the tests' } }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'never commit to main' }] }
      })
    ].join('\n') + '\n'
  );

  const extracted = extractFromTranscript(transcript, {
    client: 'claude-code',
    sessionId: 'nested-sess'
  });

  // Both user messages must be visible to preference matching, not silently skipped.
  const quotes = extracted.preferences_learned.map((p) => p.evidence.quote).join(' | ');
  assert.match(quotes, /always run the tests/);
  assert.match(quotes, /never commit to main/);
});

test('the cursor adapter emits name and constraints', () => {
  const root = seedTempHome();
  const profile = JSON.parse(fs.readFileSync(path.join(root, '.khud', 'profile.json'), 'utf8'));
  profile.name = 'Bilal Ahmad';
  profile.constraints = ['Linux Mint 22.3 XFCE - X11 not Wayland', 'PipeWire - use aplay not paplay'];
  writeProfile(profile);

  // injectCursorProject takes an explicit cwd. injectCursorGlobal must NOT be used here:
  // cursor.ts resolves PATHS at module-eval time, so the global variant would write to the
  // real ~/.cursor/rules regardless of the temp HOME set above.
  injectCursorProject(profile, root);
  const written = fs.readFileSync(path.join(root, '.cursor', 'rules', 'khud.mdc'), 'utf8');

  assert.match(written, /Bilal Ahmad/);
  assert.match(written, /X11 not Wayland/);
  assert.match(written, /use aplay not paplay/);
});

test('the pending notice links the latest candidate detail page, never bare /review', () => {
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    announcePendingReview([]);
    assert.equal(lines.length, 0, 'nothing pending means no notice');

    announcePendingReview(['aaaa000000000001']);
    announcePendingReview(['aaaa000000000001', 'bbbb000000000002']);
  } finally {
    console.log = realLog;
  }

  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    '1 rule pending approval: http://localhost:11437/review/aaaa000000000001'
  );
  // Latest queued id wins. Sentinel has no bare /review page, so it must never appear.
  assert.equal(
    lines[1],
    '2 rules pending approval (latest): http://localhost:11437/review/bbbb000000000002'
  );
  for (const line of lines) assert.doesNotMatch(line, /\/review(\s|$)/);

  assert.equal(sentinelReviewUrl('abc'), 'http://localhost:11437/review/abc');
});
