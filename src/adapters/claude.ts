import { profileCore, renderCore, renderProjection } from '../lib/context.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';
import { measure, writeIfChanged, type ProjectionWrite } from './projection.js';

/**
 * Claude Code reads ~/.claude/CLAUDE.md at session start.
 *
 * Until 2026-09-05 this file also carried the stack list, the active project's status and
 * the whole session-capture JSON schema: about 1,850 estimated tokens of always-on context,
 * most of it irrelevant to any given task. The capture format now lives in one on-demand
 * reference and the project status is not global information at all.
 */
export function injectClaude(profile: Profile): ProjectionWrite {
  const target = resolvePaths().claudeMarkdown;
  const content = previewClaude(profile);
  return measure('claude', [target], content, writeIfChanged(target, content));
}

/** Render without writing, so a change can be inspected before it lands. */
export function previewClaude(profile: Profile): string {
  return renderProjection('claude', renderCore(profileCore(profile)));
}
