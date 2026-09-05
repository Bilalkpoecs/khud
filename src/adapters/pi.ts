import { profileCore, renderCore, renderProjection } from '../lib/context.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';
import { measure, writeIfChanged, type ProjectionWrite } from './projection.js';

/**
 * Pi concatenates global and ancestor context files. It receives the same core, without
 * the obsolete pending-delta, TOON-only and OpenCode-specific startup rituals the old
 * hand-cloned file carried.
 */
export function injectPi(profile: Profile): ProjectionWrite {
  const target = resolvePaths().piAgentsFile;
  const content = renderProjection('pi', renderCore(profileCore(profile)));
  return measure('pi', [target], content, writeIfChanged(target, content));
}
