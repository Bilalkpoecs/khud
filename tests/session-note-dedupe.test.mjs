// Regression test for the duplicate-note defect.
//
// writeSessionEpisode used to disambiguate a filename collision with
// `record.capture_id`, which is a fresh randomUUID() per capture. That suffix can
// never collide, so it never dedups: re-finalizing one session wrote a new file
// every time. The vault reached 342 duplicate-body files in 47 groups, one group
// holding 130 copies of a single session.
//
// The filename now keys on a sha256 fingerprint of the note BODY (frontmatter
// excluded, because frontmatter carries the varying capture_id).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khud-dedupe-'));
process.env.KHUD_HOME = root;
process.env.HOME = root;
process.env.KHUD_DESKTOP_DIR = path.join(root, 'Desktop');
process.env.KHUD_VAULT_DIR = path.join(root, 'vault');

const { writeSessionEpisode } = await import('../dist/lib/sessionNote.js');

const baseRecord = () => ({
  schema_version: 1,
  client: 'claude-code',
  session_id: 'bc518287-9421-493b-a4cd-4c90fbc7ac45',
  capture_id: crypto.randomUUID(),
  date: '2026-08-06',
  project_status: 'Root-caused the duplicate session note writer and fixed the filename key',
  decisions: [{ what: 'Key the filename on a body fingerprint', why: 'capture_id can never collide' }],
  preferences_learned: [],
  stack_updates: []
});

const sessionsDir = () => path.join(process.env.KHUD_VAULT_DIR, "Sessions");
const noteCount = () =>
  fs.existsSync(sessionsDir()) ? fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.md')).length : 0;

test('identical body with a different capture_id writes exactly one note', () => {
  const first = writeSessionEpisode(baseRecord());
  assert.equal(noteCount(), 1, 'first capture should create one note');

  // Ten re-finalizes of the same session, each with a fresh capture_id.
  // This is the exact pattern that produced the 130-copy group.
  const paths = new Set([first]);
  for (let i = 0; i < 10; i += 1) paths.add(writeSessionEpisode(baseRecord()));

  assert.equal(noteCount(), 1, `10 re-finalizes must not add notes, got ${noteCount()}`);
  assert.equal(paths.size, 1, 'every call must return the same path');
});

test('a genuinely different body for the same session gets its own note', () => {
  const changed = baseRecord();
  changed.decisions = [{ what: 'Something materially different', why: 'a real second decision' }];
  const other = writeSessionEpisode(changed);

  assert.equal(noteCount(), 2, 'a different body must be preserved, not overwritten');
  assert.ok(/-[0-9a-f]{12}\.md$/.test(other), `variant should carry a hex fingerprint, got ${other}`);

  // And it must itself be idempotent.
  writeSessionEpisode({ ...changed, capture_id: crypto.randomUUID() });
  assert.equal(noteCount(), 2, 'repeating the variant must not add a third note');
});

test('the fingerprint suffix is not a capture_id', () => {
  const files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.md'));
  const suffixed = files.find((f) => /-[0-9a-f]{12}\.md$/.test(f));
  assert.ok(suffixed, 'expected one fingerprint-suffixed note');
  const body = fs.readFileSync(path.join(sessionsDir(), suffixed), 'utf8');
  const captureId = /capture_id: (\S+)/.exec(body)?.[1] ?? '';
  const suffix = /-([0-9a-f]{12})\.md$/.exec(suffixed)?.[1] ?? '';
  assert.ok(!captureId.startsWith(suffix), 'suffix must derive from content, not capture_id');
});
