import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteText } from '../lib/atomic.js';
import type { ContextTarget } from '../lib/context.js';
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
