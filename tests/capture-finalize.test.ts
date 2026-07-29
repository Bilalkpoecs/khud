import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { safeFileStem } from '../dist/lib/atomic.js';
import { quarantineCapture, validateCapture, writeCapture } from '../dist/lib/capture.js';
import { buildPreferenceCandidate } from '../dist/lib/evidence.js';
import { finalizeInbox, ingestHookPayload } from '../dist/lib/finalize.js';
import { writeProfile } from '../dist/lib/profile.js';
import type { Profile } from '../dist/lib/types.js';

function seedTempHome(): string {
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
  const profile: Profile = {
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
  };
  writeProfile(profile);
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

test('explicit user preference promotes; agent observation stays pending', async () => {
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
  assert.equal(result.promoted_preferences, 1);
  assert.ok(result.pending_review >= 1);

  const profile = JSON.parse(
    fs.readFileSync(path.join(root, '.khud', 'profile.json'), 'utf8')
  ) as Profile;
  assert.ok(profile.preferences.includes('Always prefer named exports in TypeScript'));
  assert.ok(!profile.preferences.includes('Maybe use tabs'));
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
  const profile = JSON.parse(
    fs.readFileSync(path.join(root, '.khud', 'profile.json'), 'utf8')
  ) as Profile;
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
