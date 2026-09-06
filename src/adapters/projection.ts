import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteText } from '../lib/atomic.js';
import { KHUD_BLOCK_END, KHUD_BLOCK_START, type ContextTarget } from '../lib/context.js';
import { estimateTokens } from '../lib/tier1.js';

export interface ProjectionWrite {
  target: ContextTarget;
  files: string[];
  bytes: number;
  estimatedTokens: number;
  changed: boolean;
}

/**
 * Write only when the bytes actually differ.
 *
 * An identical projection must not touch the file: a changed mtime looks like a real
 * update to the watcher and to anyone reading `ls -l` to see whether a sync did anything.
 */
export function writeIfChanged(target: string, content: string): boolean {
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteText(target, content);
  return true;
}

export function measure(target: ContextTarget, files: string[], content: string, changed: boolean): ProjectionWrite {
  return {
    target,
    files,
    bytes: Buffer.byteLength(content, 'utf8'),
    estimatedTokens: estimateTokens(content),
    changed,
  };
}

/**
 * Merge the projection into a file the user also writes.
 *
 * CLAUDE.md, AGENTS.md and SOUL.md belong to the user; khud only owns the marked block
 * inside them. Everything outside the markers survives every sync.
 *
 * `legacy` is the projection khud used to write before the markers existed. A file whose
 * whole body is that older projection is khud's own output, so it is replaced rather than
 * demoted to user content, which would duplicate the core on the first upgrade.
 */
export function applyManagedBlock(existing: string, block: string, legacy?: string): string {
  const start = existing.indexOf(KHUD_BLOCK_START);
  const end = existing.indexOf(KHUD_BLOCK_END);
  if (start >= 0 && end > start) {
    const tail = existing.slice(end + KHUD_BLOCK_END.length).replace(/^\n/, '');
    return `${existing.slice(0, start)}${block}${tail}`;
  }
  if (legacy !== undefined && existing.trim() === legacy.trim()) {
    return block;
  }
  const owned = existing.trimEnd();
  return owned ? `${block}\n${owned}\n` : block;
}

/** Write a projection into a user-owned file without disturbing the rest of it. */
export function writeManagedBlock(target: string, block: string, legacy: string): boolean {
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  return writeIfChanged(target, applyManagedBlock(existing, block, legacy));
}
