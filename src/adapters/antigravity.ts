import { profileCore, renderCore, renderProjection } from '../lib/context.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';
import { measure, writeManagedBlock, type ProjectionWrite } from './projection.js';

/**
 * Antigravity reads ~/.gemini/GEMINI.md for global instructions and system context.
 * Only the managed block inside it is generated here: the rest is user-defined rules.
 */
export function injectAntigravity(profile: Profile): ProjectionWrite {
  const target = resolvePaths().antigravityRuleFile;
  const core = renderCore(profileCore(profile));
  const block = renderProjection('antigravity', core);
  return measure('antigravity', [target], block, writeManagedBlock(target, block, core));
}
