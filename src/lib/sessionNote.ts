import { createHash } from 'node:crypto';
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
  const frontmatter = [
    '---',
    `session_id: ${record.session_id}`,
    `capture_id: ${record.capture_id}`,
    `client: ${record.client}`,
    'status: current',
    '---'
  ];

  const lines = [
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

  const body = `${lines.join('\n')}\n`;
  const text = `${frontmatter.join('\n')}\n${body}`;

  // Filename disambiguation keys on a CONTENT fingerprint, never on capture_id.
  // capture_id is a fresh randomUUID() per capture, so a capture_id-keyed suffix can
  // never collide and therefore never dedups: 47 groups and 342 duplicate-body files
  // in the vault came from exactly that, one group reaching 130 copies. capture-design.md
  // section 5 requires the fingerprint be computed over capture content for this reason.
  const primary = path.join(paths().sessionsDir, `${baseName}.md`);
  if (!fs.existsSync(primary)) {
    atomicWriteText(primary, text);
    return primary;
  }
  if (readBody(primary) === body) return primary; // same content already stored, no write

  const fingerprint = createHash('sha256').update(body).digest('hex').slice(0, 12);
  const variant = path.join(paths().sessionsDir, `${baseName}-${fingerprint}.md`);
  if (fs.existsSync(variant) && readBody(variant) === body) return variant;
  atomicWriteText(variant, text);
  return variant;
}

/** Read a note's body, i.e. everything after the leading frontmatter block. */
function readBody(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return raw;
  const after = raw.indexOf('\n', end + 1);
  return after === -1 ? '' : raw.slice(after + 1);
}
