import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const PROFILE = {
  name: 'Bilal Ahmad',
  updated: '2026-09-05',
  stack: ['khud 0.2.0', 'graphify 0.9.29 via uv tool install'],
  agents: ['Claude Code'],
  preferences: ['Never use default exports in TypeScript'],
  constraints: ['PipeWire audio: use aplay not paplay'],
  routing: ['Coding, n8n, TDD, auth: Reference/Agent Context/Coding.md'],
  active_project: { name: 'khud', description: 'compiler', stack: 'Node', status: 'Downloaded the UPS tracking script from EC2' },
  recent_decisions: [{ date: '2026-08-01', what: 'Old shipping decision', why: 'Historical' }],
};

const HERMES_ROLES = {
  '': 'You are Bilal general assistant.',
  code: 'You are the code dispatch role.',
  linkedin: 'You are the LinkedIn writing role.',
  ops: 'You are the ops role.',
  research: 'You are the research role.',
};

function fixture(t, profileOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khud-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, body) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return full;
  };
  write('.khud/profile.json', JSON.stringify({ ...PROFILE, ...profileOverrides }));
  write('.hermes/SOUL.md', `${HERMES_ROLES['']}\n`);
  for (const name of ['code', 'linkedin', 'ops', 'research']) {
    write(`.hermes/profiles/${name}/SOUL.md`, `${HERMES_ROLES[name]}\n`);
  }
  return { root, write };
}

function run(root, args) {
  return spawnSync(process.execPath, [cli, ...args], {
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

const OUTPUTS = {
  claude: '.claude/CLAUDE.md',
  codex: '.codex/AGENTS.md',
  opencode: '.config/opencode/agents/khud-identity.md',
  cursor: '.cursor/rules/khud.mdc',
  pi: '.pi/agent/AGENTS.md',
};

test('sync all writes one shared core to all six agents and drops project history', (t) => {
  const { root } = fixture(t);
  const result = run(root, ['sync', '--to', 'all']);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const bodies = [];
  for (const [target, rel] of Object.entries(OUTPUTS)) {
    const body = fs.readFileSync(path.join(root, rel), 'utf8');
    bodies.push([target, body]);
  }
  for (const name of ['SOUL.md', 'profiles/code/SOUL.md', 'profiles/linkedin/SOUL.md', 'profiles/ops/SOUL.md', 'profiles/research/SOUL.md']) {
    bodies.push([`hermes:${name}`, fs.readFileSync(path.join(root, '.hermes', name), 'utf8')]);
  }

  for (const [target, body] of bodies) {
    assert.match(body, /Never use default exports in TypeScript/, `${target} lost a preference`);
    assert.match(body, /use aplay not paplay/, `${target} lost a constraint`);
    assert.match(body, /Reference\/Agent Context\/Coding\.md/, `${target} lost routing`);
    assert.doesNotMatch(body, /UPS tracking script|Old shipping decision|graphify 0\.9\.29/, `${target} still renders project history`);
    assert.doesNotMatch(body, /schema_version|Khud Session Protocol/, `${target} still embeds the capture schema`);
  }

  // Hermes keeps each role outside the managed block.
  assert.match(fs.readFileSync(path.join(root, '.hermes/profiles/code/SOUL.md'), 'utf8'), /You are the code dispatch role\./);
  assert.match(fs.readFileSync(path.join(root, '.hermes/profiles/linkedin/SOUL.md'), 'utf8'), /You are the LinkedIn writing role\./);
  assert.match(fs.readFileSync(path.join(root, '.hermes/SOUL.md'), 'utf8'), /You are Bilal general assistant\./);

  // Cursor keeps native frontmatter.
  assert.match(fs.readFileSync(path.join(root, OUTPUTS.cursor), 'utf8'), /^---\n[\s\S]*alwaysApply: true\n---/);
});

test('a second sync changes no bytes and no mtimes', (t) => {
  const { root } = fixture(t);
  assert.equal(run(root, ['sync', '--to', 'all']).status, 0);
  const targets = [...Object.values(OUTPUTS), '.hermes/SOUL.md', '.hermes/profiles/code/SOUL.md'];
  const before = targets.map((rel) => {
    const full = path.join(root, rel);
    return [rel, fs.readFileSync(full, 'utf8'), fs.statSync(full).mtimeMs];
  });
  assert.equal(run(root, ['sync', '--to', 'all']).status, 0);
  for (const [rel, body, mtime] of before) {
    const full = path.join(root, rel);
    assert.equal(fs.readFileSync(full, 'utf8'), body, `${rel} content changed on a no-op sync`);
    assert.equal(fs.statSync(full).mtimeMs, mtime, `${rel} mtime changed on a no-op sync`);
  }
});

test('one failing target makes the whole sync visibly unsuccessful', (t) => {
  const { root } = fixture(t);
  // A file where the Codex directory must be blocks that one write.
  fs.writeFileSync(path.join(root, '.codex'), 'not a directory\n');
  const result = run(root, ['sync', '--to', 'all']);
  assert.equal(result.status, 1, 'sync must not report success when a target failed');
  assert.match(result.stdout + result.stderr, /codex/);
  // Every other target still landed.
  assert.match(fs.readFileSync(path.join(root, OUTPUTS.claude), 'utf8'), /Never use default exports/);
});

test('sync --to accepts each of the six targets individually', (t) => {
  for (const target of ['claude', 'codex', 'opencode', 'cursor', 'pi', 'hermes']) {
    const { root } = fixture(t);
    const result = run(root, ['sync', '--to', target]);
    assert.equal(result.status, 0, `${target}: ${result.stderr}`);
  }
});

test('hermes managed block updates in place instead of stacking copies', (t) => {
  const { root } = fixture(t);
  assert.equal(run(root, ['sync', '--to', 'hermes']).status, 0);
  assert.equal(run(root, ['sync', '--to', 'hermes']).status, 0);
  const body = fs.readFileSync(path.join(root, '.hermes/profiles/ops/SOUL.md'), 'utf8');
  assert.equal(body.match(/khud:core:start/g).length, 1);
  assert.match(body, /You are the ops role\./);
});

test('status reports all six targets', (t) => {
  const { root } = fixture(t);
  run(root, ['sync', '--to', 'all']);
  const result = run(root, ['status']);
  for (const target of ['claude', 'codex', 'opencode', 'cursor', 'pi', 'hermes']) {
    assert.match(result.stdout, new RegExp(target), `status omits ${target}`);
  }
});
