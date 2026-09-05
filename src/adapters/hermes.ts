import fs from 'node:fs';

import {
  HERMES_BLOCK_END,
  HERMES_BLOCK_START,
  profileCore,
  renderCore,
  renderProjection,
} from '../lib/context.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';
import { measure, writeIfChanged, type ProjectionWrite } from './projection.js';

/**
 * Hermes personas are role definitions, not identity files.
 *
 * The shared core goes into a managed block inside each SOUL.md; everything outside that
 * block is the profile's own role and is never rewritten. `code` dispatches, `linkedin`
 * writes: they are meant to differ.
 */
export function hermesSoulFiles(): string[] {
  const paths = resolvePaths();
  const files = [paths.hermesSoulFile];
  if (fs.existsSync(paths.hermesProfilesDir)) {
    for (const entry of fs.readdirSync(paths.hermesProfilesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const soul = `${paths.hermesProfilesDir}/${entry.name}/SOUL.md`;
      if (fs.existsSync(soul)) files.push(soul);
    }
  }
  return files;
}

export function applyManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(HERMES_BLOCK_START);
  const end = existing.indexOf(HERMES_BLOCK_END);
  if (start >= 0 && end > start) {
    const after = end + HERMES_BLOCK_END.length;
    const tail = existing.slice(after).replace(/^\n/, '');
    return `${existing.slice(0, start)}${block}${tail}`;
  }
  const role = existing.trimEnd();
  return role ? `${block}\n${role}\n` : block;
}

export function injectHermes(profile: Profile): ProjectionWrite {
  const block = renderProjection('hermes', renderCore(profileCore(profile)));
  const files = hermesSoulFiles();
  if (files.length === 0) {
    throw new Error('No Hermes SOUL.md found; refusing to create a persona file from nothing.');
  }
  let changed = false;
  for (const file of files) {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (writeIfChanged(file, applyManagedBlock(existing, block))) changed = true;
  }
  return measure('hermes', files, block, changed);
}
