import { profileCore, renderCore, renderProjection } from '../lib/context.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';
import { measure, writeIfChanged, type ProjectionWrite } from './projection.js';

/**
 * OpenCode loads this file through the `instructions` list in its config. The tiny
 * runtime AGENTS.md beside it keeps only routing that OpenCode itself needs.
 */
export function injectOpencode(profile: Profile): ProjectionWrite {
  const target = resolvePaths().opencodeIdentityFile;
  const content = renderProjection('opencode', renderCore(profileCore(profile)));
  return measure('opencode', [target], content, writeIfChanged(target, content));
}
