import fs from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import { hermesSoulFiles } from '../adapters/hermes.js';
import { SUPPORTED_TARGETS, type SupportedTarget } from '../lib/agents.js';
import { listInboxCaptures } from '../lib/capture.js';
import { displayPath, resolvePaths } from '../lib/paths.js';

const paths = () => resolvePaths();

export async function cmdStatus(): Promise<void> {
  console.log('');
  console.log(chalk.bold('khud status'));
  console.log('');

  checkFile('Profile', path.join(paths().khudDir, 'profile.json'));
  for (const target of SUPPORTED_TARGETS) {
    for (const file of projectionFiles(target)) {
      checkFile(target, file);
    }
  }

  console.log('');

  checkHookContent(
    'Claude hooks',
    paths().claudeSettings,
    ['UserPromptSubmit', 'turbovec-recall-prompt --client claude-code', 'khud-obsidian-stop']
  );
  checkHookContent(
    'Cursor hooks',
    paths().cursorHooks,
    ['turbovec-recall-prompt --client cursor', 'khud-obsidian-stop']
  );
  checkHookContent(
    'OpenCode plugin',
    path.join(paths().opencodePluginsDir, 'khud-sync.js'),
    ['chat.message', 'finalize', 'prompt_recall']
  );

  console.log('');
  checkMirrorsFresh();
  checkInbox();
  await checkIndex();
  checkLogs();
  checkBackup();
  console.log('');
}

/** Every supported target reports its own generated files, so a missing one is visible. */
function projectionFiles(target: SupportedTarget): string[] {
  const resolved = paths();
  if (target === 'claude') return [resolved.claudeMarkdown];
  if (target === 'codex') return [resolved.codexAgentsFile];
  if (target === 'opencode') return [resolved.opencodeIdentityFile];
  if (target === 'cursor') return [resolved.cursorRuleFile];
  if (target === 'pi') return [resolved.piAgentsFile];
  const souls = hermesSoulFiles();
  return souls.length ? souls : [resolved.hermesSoulFile];
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
  const mirrors = SUPPORTED_TARGETS.flatMap((target) => projectionFiles(target));
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

/**
 * Read-only health probe against the local turbovec dashboard.
 *
 * Uses the built-in fetch rather than shelling out to curl. Spawning curl meant
 * a subprocess and an external binary dependency for what is one loopback GET,
 * and it showed up in supply-chain scanners as shell execution plus an embedded
 * URL. Node 18 is already the floor in `engines`, so fetch is always available.
 *
 * Loopback only. khud makes no other network call.
 */
const TURBOVEC_STATUS_URL = 'http://127.0.0.1:11435/api/status';

async function checkIndex(): Promise<void> {
  try {
    const response = await fetch(TURBOVEC_STATUS_URL, {
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) {
      throw new Error(`dashboard returned ${response.status}`);
    }
    const status = (await response.json()) as {
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
