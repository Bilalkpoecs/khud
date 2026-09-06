import { profileCore, renderCore, renderProjection } from '../lib/context.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';
import { measure, writeManagedBlock, type ProjectionWrite } from './projection.js';

/**
 * Codex reads a global AGENTS.md and also concatenates ancestor AGENTS.md files.
 * Only the global file is generated here, and only the marked block inside it: the rest
 * is the user's own guidance. The ancestor copy at ~/AGENTS.md is retired separately once
 * it is confirmed to hold no unique guidance.
 */
export function injectCodex(profile: Profile): ProjectionWrite {
  const target = resolvePaths().codexAgentsFile;
  const core = renderCore(profileCore(profile));
  const block = renderProjection('codex', core);
  return measure('codex', [target], block, writeManagedBlock(target, block, core));
}
