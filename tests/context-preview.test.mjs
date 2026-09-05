import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khud-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = {
    name: 'Bilal Ahmad',
    updated: '2026-08-17',
    stack: ['Obsolete graphify installation story'],
    agents: ['Claude Code'],
    preferences: ['Never use default exports in TypeScript', 'No em dashes in any output'],
    constraints: ['Use aplay for local audio'],
    active_project: { name: 'khud', description: 'Shipping leak', stack: 'Legacy ORM', status: 'UPS downloads completed' },
    recent_decisions: [{ date: '2026-08-01', what: 'Old shipping decision', why: 'Historical' }],
    ...overrides,
  };
  const profilePath = path.join(root, '.khud', 'profile.json');
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  const sentinel = path.join(root, '.hermes', 'SOUL.md');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'Existing Hermes role must survive preview.\n');
  return { root, profilePath };
}

function runPreview(root, args = []) {
  return spawnSync(process.execPath, [cli, 'context', 'preview', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KHUD_HOME: root,
      KHUD_CONFIG_HOME: path.join(root, '.config'),
      KHUD_DESKTOP_DIR: path.join(root, 'Desktop'),
      KHUD_VAULT_DIR: path.join(root, 'vault'),
    },
  });
}

function snapshot(root, relative = '') {
  const result = {};
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, snapshot(root, name));
    else result[name] = fs.readFileSync(path.join(root, name), 'utf8');
  }
  return result;
}

test('preview retains every supplied rule across six formats without writing live files or carrying project history', (t) => {
  const { root } = fixture(t);
  const before = snapshot(root);
  const result = runPreview(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.projections.map((item) => item.target), ['claude', 'codex', 'opencode', 'cursor', 'pi', 'hermes']);
  assert.equal(report.token_estimate, 'characters/4');
  assert.equal(report.budget_tokens, 800);
  assert.match(report.core.sha256, /^[a-f0-9]{64}$/);
  for (const projection of report.projections) {
    assert.ok(projection.content.includes(report.core.content));
    assert.match(projection.content, /Never use default exports in TypeScript/);
    assert.match(projection.content, /No em dashes in any output/);
    assert.match(projection.content, /Use aplay for local audio/);
    assert.doesNotMatch(projection.content, /UPS downloads|Old shipping decision|graphify|2026-08-17/);
    assert.equal(projection.within_budget, true);
  }
  assert.match(report.projections.find((item) => item.target === 'cursor').content, /^---\ndescription:.*\nalwaysApply: true\n---/);
  assert.equal(report.projections.find((item) => item.target === 'hermes').kind, 'managed-block');
  assert.deepEqual(snapshot(root), before, 'preview must not change profile, native files or create capture state');
});


test('over-budget preview exits nonzero while keeping the last rule and leaving files unchanged', (t) => {
  const { root } = fixture(t, {
    preferences: ['A long retained instruction '.repeat(180), 'Keep this final preference'],
    constraints: ['Keep this final constraint'],
  });
  const before = snapshot(root);
  const result = runPreview(root, ['--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /All supplied rules are retained/);
  const report = JSON.parse(result.stdout);
  for (const projection of report.projections) {
    assert.equal(projection.within_budget, false);
    assert.match(projection.content, /Keep this final preference/);
    assert.match(projection.content, /Keep this final constraint/);
  }
  assert.deepEqual(snapshot(root), before);
});

test('a staged profile and one target can be previewed without replacing the live profile', (t) => {
  const { root } = fixture(t);
  const staged = path.join(root, 'proposed.json');
  fs.writeFileSync(staged, JSON.stringify({ name: 'Staged identity', preferences: ['Preserve scoped guidance'], constraints: [] }));
  const before = snapshot(root);
  const result = runPreview(root, ['--profile', staged, '--to', 'hermes', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.source, staged);
  assert.deepEqual(report.projections.map((item) => item.target), ['hermes']);
  assert.match(report.core.content, /Staged identity/);
  assert.doesNotMatch(report.core.content, /Bilal Ahmad/);
  assert.deepEqual(snapshot(root), before);
});

test('invalid targets and malformed rule arrays fail without producing a partial preview', (t) => {
  const { root, profilePath } = fixture(t);
  const unknown = runPreview(root, ['--to', 'missing-agent', '--json']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown context target/);
  assert.equal(unknown.stdout, '');
  fs.writeFileSync(profilePath, JSON.stringify({ name: 'Bilal', preferences: ['valid', { text: 'invalid' }], constraints: [] }));
  const before = snapshot(root);
  const malformed = runPreview(root, ['--json']);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /preferences string array/);
  assert.equal(malformed.stdout, '');
  assert.deepEqual(snapshot(root), before);
});

test('preview is deterministic and core hash ignores changes to excluded history', (t) => {
  const { root, profilePath } = fixture(t);
  const first = runPreview(root, ['--json']);
  const repeat = runPreview(root, ['--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, repeat.stdout);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  profile.updated = '2030-01-01';
  profile.active_project.status = 'New unrelated episode';
  profile.stack.push('Another installation episode');
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  const changed = runPreview(root, ['--json']);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(first.stdout).core.sha256, JSON.parse(changed.stdout).core.sha256);
  assert.equal(first.stdout, changed.stdout);
});

test('routing lines are rendered in every projection and reach the scoped notes', (t) => {
  const { root } = fixture(t, {
    preferences: ['Keep context small'],
    constraints: [],
    routing: ['Coding, n8n, TDD, auth: Reference/Agent Context/Coding.md'],
  });
  const before = snapshot(root);
  const result = runPreview(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.match(report.core.content, /## On demand/);
  for (const projection of report.projections) {
    assert.match(projection.content, /Reference\/Agent Context\/Coding\.md/);
  }
  assert.deepEqual(snapshot(root), before);
});

test('a profile without routing renders no on-demand section and stays valid', (t) => {
  const { root } = fixture(t);
  const result = runPreview(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.doesNotMatch(report.core.content, /## On demand/);
});

test('malformed routing is rejected without a partial preview', (t) => {
  const { root, profilePath } = fixture(t);
  fs.writeFileSync(profilePath, JSON.stringify({ name: 'Bilal', preferences: [], constraints: [], routing: [{ to: 'nope' }] }));
  const result = runPreview(root, ['--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /routing/);
  assert.equal(result.stdout, '');
});
