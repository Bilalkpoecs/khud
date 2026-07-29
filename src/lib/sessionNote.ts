import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteText, safeFileStem } from './atomic.js';
import { resolvePaths } from './paths.js';
import type { CaptureRecord } from './types.js';

const paths = () => resolvePaths();

/** Hook idle stubs — never worth a vault episode or profile status clobber. */
export function isHookStubStatus(status: string): boolean {
  const s = status.trim();
  return (
    /^Session\s+\S+\s+ended\b/i.test(s) ||
    /^Session captured from\b/i.test(s)
  );
}

/**
 * Write a Sessions/ note when there is structured memory, or a substantive
 * status narrative. Skip thin ops breadcrumbs and idle stop-hook stubs.
 */
export function shouldWriteSessionEpisode(record: CaptureRecord): boolean {
  if (
    record.decisions.length > 0 ||
    record.preferences_learned.length > 0 ||
    record.stack_updates.length > 0
  ) {
    return true;
  }
  return isSubstantiveStatus(record.project_status);
}

export function isSubstantiveStatus(status: string): boolean {
  const s = status.trim();
  if (s.length < 48) return false;
  if (isHookStubStatus(s)) return false;
  // Run result counters only (Shopify apply / fulfill prep style)
  if (/\brun\s+\d+\b/i.test(s) && /\b\d+\s+(ok|pkgs?|orders?|lines)\b/i.test(s)) {
    return false;
  }
  if (/\b\d+\s+ok\b/i.test(s) && /\bpartial_skip\b/i.test(s)) return false;
  return true;
}

function relatedLinks(record: CaptureRecord): string[] {
  const blob = [
    record.project_status,
    ...record.decisions.map((d) => `${d.what} ${d.why}`),
    ...record.preferences_learned.map((p) => p.text)
  ]
    .join(' ')
    .toLowerCase();

  const links: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/khud|identity compiler|turbovec|obsidian/, 'Projects/khud'],
    [/erp|vegas|dashboard|warehouse|outbound|bulkship/, 'Projects/ERP-Dashboard'],
    [/shiphero|ship hero/, 'Projects/ShipHero-API'],
    [/ups|shipping provision|bundle rate/, 'Projects/Ops-Working'],
    [/linkedin/, 'Projects/LinkedIn-Automation'],
    [/n8n|workflow/, 'Projects/n8n-Workflows'],
    [/claude\.md|agent config|mcp|skill|hook/, 'Stack/Agent-Configuration']
  ];
  for (const [pattern, target] of rules) {
    if (pattern.test(blob)) links.push(`- [[${target}]]`);
  }
  return [...new Set(links)];
}

export function writeSessionEpisode(record: CaptureRecord): string {
  fs.mkdirSync(paths().sessionsDir, { recursive: true });
  const title = safeFileStem(
    record.project_status
      .replace(/:.*$/, '')
      .replace(/ -- .*$/, '')
      .replace(/ — .*$/, '')
      .slice(0, 60),
    60
  );
  const baseName = title === 'untitled'
    ? `${record.date}-${safeFileStem(record.session_id, 40)}`
    : `${record.date} — ${title}`;
  let out = path.join(paths().sessionsDir, `${baseName}.md`);
  if (fs.existsSync(out)) {
    out = path.join(
      paths().sessionsDir,
      `${baseName}-${safeFileStem(record.capture_id, 12)}.md`
    );
  }

  const lines = [
    '---',
    `session_id: ${record.session_id}`,
    `capture_id: ${record.capture_id}`,
    `client: ${record.client}`,
    'status: current',
    '---',
    '',
    `# Session ${record.date}`,
    '',
    `**Agent:** ${record.client}`,
    record.project_status ? `**Status:** ${record.project_status}` : null,
    ''
  ].filter((line) => line !== null) as string[];

  if (record.decisions.length) {
    lines.push('## Decisions');
    for (const decision of record.decisions) {
      lines.push(`- **${decision.what}** -- ${decision.why}`);
    }
    lines.push('');
  }

  if (record.preferences_learned.length) {
    lines.push('## Preferences Learned');
    for (const pref of record.preferences_learned) {
      lines.push(`- ${pref.text}`);
    }
    lines.push('');
  }

  if (record.stack_updates.length) {
    lines.push('## Stack Updates');
    for (const item of record.stack_updates) lines.push(`- ${item}`);
    lines.push('');
  }

  const links = relatedLinks(record);
  if (links.length) {
    lines.push('## Related');
    lines.push(...links);
    lines.push('');
  }

  atomicWriteText(out, `${lines.join('\n')}\n`);
  return out;
}
