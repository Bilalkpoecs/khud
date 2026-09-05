import path from 'node:path';

import { profileCore, renderCore, renderProjection } from '../lib/context.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';
import { measure, writeIfChanged, type ProjectionWrite } from './projection.js';

/**
 * Cursor rules need native frontmatter; `alwaysApply: true` is what makes the file load.
 * A rules file on disk is not proof of an effective load: IDE User Rules and project rules
 * are separate surfaces and are verified by hand.
 */
export function injectCursorProject(profile: Profile, cwd: string = process.cwd()): void {
  const target = path.join(cwd, '.cursor', 'rules', 'khud.mdc');
  writeIfChanged(target, compileToCursor(profile));
}

export function injectCursorGlobal(profile: Profile): ProjectionWrite {
  const target = resolvePaths().cursorRuleFile;
  const content = compileToCursor(profile);
  return measure('cursor', [target], content, writeIfChanged(target, content));
}

function compileToCursor(profile: Profile): string {
  return renderProjection('cursor', renderCore(profileCore(profile)));
}
