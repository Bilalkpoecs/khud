import { profileCore, renderCore, renderProjection } from '../lib/context.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';
import { measure, writeIfChanged, type ProjectionWrite } from './projection.js';

/**
 * Codex reads a global AGENTS.md and also concatenates ancestor AGENTS.md files.
 * Only the global file is generated here; the ancestor copy at ~/AGENTS.md is retired
 * separately once it is confirmed to hold no unique guidance.
 */
export function injectCodex(profile: Profile): ProjectionWrite {
  const target = resolvePaths().codexAgentsFile;
  const content = renderProjection('codex', renderCore(profileCore(profile)));
  return measure('codex', [target], content, writeIfChanged(target, content));
}
