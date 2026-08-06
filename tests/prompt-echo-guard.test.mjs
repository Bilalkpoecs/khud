// Regression tests for the two defects that made prompt text outrank real decisions.
//
// 1. matchExplicitDecision fired on the bare word use/ship/go-with anywhere in a user
//    message and took everything after it as a decision, stamping `why` with the literal
//    placeholder "explicit user decision". "use it for free like here or in the cli..."
//    became Decisions/2026-07-30-it for free like here or in the cli like you prompt it...
//    Those prompt-titled notes outrank genuine decisions on the lexical retrieval path,
//    because the queries are user prompts too. capture-design.md section 3 ruled it the
//    wrong mechanism and said to delete it rather than gate it harder.
//
// 2. writeDecisionNote accepted a `supersedes` equal to its own id, because the id is
//    derived from date|what|session_id and a re-finalize resolves `prior` to the note
//    being rewritten. The vault held notes superseding themselves.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khud-echo-'));
process.env.KHUD_HOME = root;
process.env.HOME = root;
process.env.KHUD_DESKTOP_DIR = path.join(root, 'Desktop');
process.env.KHUD_VAULT_DIR = path.join(root, 'vault');

const capture = await import('../dist/lib/capture.js');
const { writeDecisionNote } = await import('../dist/lib/decisions.js');

test('conversational prompts containing use/ship/go-with yield no decisions', () => {
  // The real prompts that produced prompt-titled Decisions/ notes in the vault.
  const prompts = [
    'i want to get it for free like here or in the cli like you prompt it, my main goal is to get created a site fromm kimi k3',
    'so they can be shipped again and rest batch (current build one excluding these orders)',
    'use the bulkship export and go with whatever ships fastest',
    "let's go with option 3 for now",
    'ship it'
  ];
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(
    transcript,
    prompts.map((p) => JSON.stringify({ type: 'user', message: { role: 'user', content: p } })).join('\n')
  );

  const record = capture.extractFromTranscript(transcript, {
    client: 'claude-code',
    sessionId: 'sess-echo-guard'
  });

  const decisions = record?.decisions ?? [];
  assert.equal(
    decisions.length,
    0,
    `no decision should be mined from conversational text, got: ${JSON.stringify(decisions.map((d) => d.what))}`
  );
  for (const d of decisions) {
    assert.notEqual(d.why, 'explicit user decision', 'placeholder why must never be produced');
  }
});

test('the regex alternation is gone from the built code path', () => {
  const src = fs.readFileSync(new URL('../dist/lib/capture.js', import.meta.url), 'utf8');
  // Look for the executable pattern, not for prose. The bug's own description is allowed
  // to survive in a comment; only a live regex is a defect.
  assert.ok(
    !/quote\.match\(\s*\/\(\?:decide/.test(src),
    'the decide/use/ship matcher must not be invoked in built output'
  );
  assert.equal(typeof capture.matchExplicitDecision, 'undefined', 'must not be exported');
});

test('a note never supersedes itself', () => {
  const record = {
    schema_version: 1,
    client: 'claude-code',
    session_id: 'sess-self-supersede',
    capture_id: 'cap-1',
    date: '2026-08-06',
    project_status: 'testing the self-supersede guard',
    decisions: [],
    preferences_learned: [],
    stack_updates: []
  };
  const decision = { what: 'Key filenames on a content fingerprint', why: 'capture_id never collides' };

  const first = writeDecisionNote(decision, record);
  assert.equal(first.supersedes, undefined, 'a fresh note has nothing to supersede');

  // Feed its own basename back in, exactly as finalize.ts does on a re-finalize.
  const ownBasename = path.basename(first.filePath, '.md');
  const second = writeDecisionNote(decision, record, { supersedes: ownBasename });
  assert.equal(second.id, first.id, 'same date|what|session_id must yield the same id');
  assert.equal(second.supersedes, undefined, 'self-referential supersedes must be dropped');

  const text = fs.readFileSync(second.filePath, 'utf8');
  assert.ok(!text.includes(`supersedes: ${second.id}`), 'rendered note must not supersede itself');
});

test('a genuine supersedes chain is preserved', () => {
  const record = {
    schema_version: 1,
    client: 'claude-code',
    session_id: 'sess-real-chain',
    capture_id: 'cap-2',
    date: '2026-08-06',
    project_status: 'testing a real supersede chain',
    decisions: [],
    preferences_learned: [],
    stack_updates: []
  };
  const note = writeDecisionNote(
    { what: 'Adopt Hermes as the orchestrator', why: 'it supplies crons and a dashboard' },
    record,
    { supersedes: '2026-07-01-some-earlier-decision-abcdef123456' }
  );
  assert.equal(note.supersedes, '2026-07-01-some-earlier-decision-abcdef123456');
});
