import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import chalk from 'chalk';
import { listInboxCaptures } from '../lib/capture.js';
import { displayPath, resolvePaths } from '../lib/paths.js';

const paths = () => resolvePaths();

export function cmdStatus(): void {
  console.log('');
  console.log(chalk.bold('khud status'));
  console.log('');

  checkFile('Profile', path.join(paths().khudDir, 'profile.json'));
  checkFile('Claude', paths().claudeMarkdown);
  checkFile('OpenCode', paths().opencodeIdentityFile);
  checkFile('Cursor', paths().cursorRuleFile);

  console.log('');

  checkHookContent(
    'Claude hooks',
    paths().claudeSettings,
    ['UserPromptSubmit', 'khud-prompt-recall-claude', 'khud-obsidian-stop']
  );
  checkHookContent(
    'Cursor hooks',
    paths().cursorHooks,
    ['turbovec-recall-prompt', 'khud-obsidian-stop']
  );
  checkHookContent(
    'OpenCode plugin',
    path.join(paths().opencodePluginsDir, 'khud-sync.js'),
    ['chat.message', 'finalize', 'prompt_recall']
  );

  console.log('');
  checkMirrorsFresh();
  checkInbox();
  checkIndex();
  checkLogs();
  checkBackup();
  console.log('');
}

function checkFile(label: string, fullPath: string): void {
  const exists = fs.existsSync(fullPath);
  const icon = exists ? chalk.green('✓') : chalk.red('✗');
  const status = exists
    ? chalk.gray(`(${fs.statSync(fullPath).mtime.toISOString().slice(0, 10)})`)
    : chalk.red('missing');
  console.log(`  ${icon} ${label.padEnd(14)} ${displayPath(fullPath)} ${status}`);
}

function checkHookContent(label: string, fullPath: string, needles: string[]): void {
  if (!fs.existsSync(fullPath)) {
    console.log(`  ${chalk.red('✗')} ${label.padEnd(14)} ${displayPath(fullPath)} ${chalk.red('missing')}`);
    return;
  }
  const text = fs.readFileSync(fullPath, 'utf8');
  const missing = needles.filter((needle) => !text.includes(needle));
  if (missing.length) {
    console.log(
      `  ${chalk.yellow('⚠')} ${label.padEnd(14)} stale/missing: ${missing.join(', ')}`
    );
    return;
  }
  console.log(
    `  ${chalk.green('✓')} ${label.padEnd(14)} ${displayPath(fullPath)} ${chalk.gray('(wired)')}`
  );
}

function checkMirrorsFresh(): void {
  const profile = path.join(paths().khudDir, 'profile.json');
  if (!fs.existsSync(profile)) return;
  const profileMtime = fs.statSync(profile).mtimeMs;
  const mirrors = [paths().claudeMarkdown, paths().cursorRuleFile, paths().opencodeIdentityFile];
  for (const mirror of mirrors) {
    if (!fs.existsSync(mirror)) continue;
    const lagMin = (profileMtime - fs.statSync(mirror).mtimeMs) / 60000;
    if (lagMin > 60) {
      console.log(`  ${chalk.yellow('⚠')} mirror lag ${displayPath(mirror)} ~${Math.round(lagMin)}m`);
    }
  }
}

function checkInbox(): void {
  const captures = listInboxCaptures();
  const quarantine = fs.existsSync(paths().quarantineDir)
    ? fs.readdirSync(paths().quarantineDir).filter((f) => f.endsWith('.json')).length
    : 0;
  if (captures.length) {
    console.log(`  ${chalk.yellow('⚠')} inbox         ${captures.length} waiting capture(s)`);
  } else {
    console.log(`  ${chalk.green('✓')} inbox         empty`);
  }
  if (quarantine) {
    console.log(`  ${chalk.yellow('⚠')} quarantine    ${quarantine} record(s)`);
  }
}

function checkIndex(): void {
  try {
    const raw = execFileSync(
      'curl',
      ['-fsS', 'http://127.0.0.1:11435/api/status'],
      { encoding: 'utf8', timeout: 2000 }
    );
    const status = JSON.parse(raw) as {
      in_sync?: boolean;
      stale_changed?: number;
      watch?: { active?: boolean; state?: string };
      ollama?: { up?: boolean };
    };
    const ok = Boolean(status.in_sync);
    const watch = status.watch?.active ? 'active' : status.watch?.state || '?';
    const ollama = status.ollama?.up ? 'up' : 'down';
    console.log(
      `  ${ok ? chalk.green('✓') : chalk.yellow('⚠')} turbovec      ` +
        `in_sync=${status.in_sync} changed=${status.stale_changed ?? 0} ` +
        `watch=${watch} ollama=${ollama}`
    );
  } catch {
    console.log(`  ${chalk.yellow('⚠')} turbovec      dashboard unreachable`);
  }
}

function checkLogs(): void {
  const files = [
    path.join(paths().historyDir, 'stop-hook.log'),
    path.join(paths().historyDir, 'opencode-plugin.log')
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const mb = fs.statSync(file).size / (1024 * 1024);
    if (mb > 5) {
      console.log(`  ${chalk.yellow('⚠')} log           ${displayPath(file)} ${mb.toFixed(1)}MB`);
    }
  }
}

function checkBackup(): void {
  const dir = path.join(paths().homeDir, '.local/share/khud/backups');
  if (!fs.existsSync(dir)) {
    console.log(`  ${chalk.yellow('⚠')} backup        none yet`);
    return;
  }
  const archives = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('khud-memory-') && name.endsWith('.tar.gz'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!archives.length) {
    console.log(`  ${chalk.yellow('⚠')} backup        none yet`);
    return;
  }
  const ageH = (Date.now() - fs.statSync(archives[0]).mtimeMs) / 3600000;
  console.log(
    `  ${ageH < 36 ? chalk.green('✓') : chalk.yellow('⚠')} backup        ` +
      `${path.basename(archives[0])} (${ageH.toFixed(1)}h old)`
  );
}
