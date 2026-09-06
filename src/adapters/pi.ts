import { profileCore, renderCore, renderProjection } from '../lib/context.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';
import { measure, writeManagedBlock, type ProjectionWrite } from './projection.js';

/**
 * Pi concatenates global and ancestor context files. It receives the same core, inside a
 * marked block so the user's own additions to the file survive, and without the obsolete
 * pending-delta, TOON-only and OpenCode-specific startup rituals the old hand-cloned file
 * carried.
 */
export function injectPi(profile: Profile): ProjectionWrite {
  const target = resolvePaths().piAgentsFile;
  const core = renderCore(profileCore(profile));
  const block = renderProjection('pi', core);
  return measure('pi', [target], block, writeManagedBlock(target, block, core));
}
