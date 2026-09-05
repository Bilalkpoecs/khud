import { createHash } from 'node:crypto';

import { estimateTokens, TIER1_TOTAL_TOKENS } from './tier1.js';
import type { Profile } from './types.js';

export const HERMES_BLOCK_START = '<!-- khud:core:start -->';
export const HERMES_BLOCK_END = '<!-- khud:core:end -->';

// Preview targets are separate until each live adapter has passed migration checks.
export const CONTEXT_TARGETS = ['claude', 'codex', 'opencode', 'cursor', 'pi', 'hermes'] as const;
export type ContextTarget = (typeof CONTEXT_TARGETS)[number];

export interface ContextProfile {
  name: string;
  preferences: string[];
  constraints: string[];
  /** Deterministic paths to scoped guidance, so a moved rule never depends on a cosine match alone. */
  routing: string[];
}

export interface ContextProjection {
  target: ContextTarget;
  kind: 'file' | 'managed-block';
  content: string;
  bytes: number;
  estimated_tokens: number;
  within_budget: boolean;
}

export interface ContextPreview {
  schema_version: 1;
  token_estimate: 'characters/4';
  budget_tokens: number;
  core: { content: string; sha256: string };
  omitted_profile_fields: string[];
  projections: ContextProjection[];
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function parseContextProfile(value: unknown): ContextProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('name' in value) || typeof value.name !== 'string' || !value.name.trim()
    || !('preferences' in value) || !isStringList(value.preferences)
    || !('constraints' in value) || !isStringList(value.constraints)) {
    throw new Error('Context profile requires a non-empty name, preferences string array and constraints string array.');
  }
  const routing = 'routing' in value ? value.routing : [];
  if (!isStringList(routing)) {
    throw new Error('Context profile routing must be a string array of scoped-guidance paths.');
  }
  return { name: value.name, preferences: value.preferences, constraints: value.constraints, routing };
}

/**
 * The one semantic core every agent receives.
 *
 * `stack`, `agents`, `updated`, `active_project` and `recent_decisions` are read from the
 * profile by other commands but are never projected: a startup file is not the place for
 * package-install history or one project's status.
 */
export function renderCore(profile: ContextProfile): string {
  const sections = [`# ${profile.name} - Shared instructions`];
  if (profile.preferences.length) {
    sections.push(`## Preferences\n${profile.preferences.map((rule) => `- ${rule}`).join('\n')}`);
  }
  if (profile.constraints.length) {
    sections.push(`## Constraints\n${profile.constraints.map((rule) => `- ${rule}`).join('\n')}`);
  }
  if (profile.routing.length) {
    sections.push(`## On demand\nRead these when the task needs more than the rules above.\n${profile.routing.map((route) => `- ${route}`).join('\n')}`);
  }
  return `${sections.join('\n\n')}\n`;
}

/** Only the wrapper differs per agent. The semantic core is byte-identical everywhere. */
export function renderProjection(target: ContextTarget, core: string): string {
  if (target === 'cursor') {
    return `---\ndescription: Shared developer instructions\nalwaysApply: true\n---\n\n${core}`;
  }
  if (target === 'hermes') {
    return `${HERMES_BLOCK_START}\n${core}${HERMES_BLOCK_END}\n`;
  }
  return core;
}

/** Narrow a full stored profile to the projected core. Legacy fields stay parseable. */
export function profileCore(profile: Profile): ContextProfile {
  return {
    name: profile.name,
    preferences: profile.preferences,
    constraints: profile.constraints,
    routing: profile.routing ?? [],
  };
}

export function previewContext(profile: ContextProfile, target: string = 'all'): ContextPreview {
  const selected = CONTEXT_TARGETS.find((candidate) => candidate === target);
  if (target !== 'all' && !selected) {
    throw new Error(`Unknown context target: ${target}. Expected ${CONTEXT_TARGETS.join(', ')} or all.`);
  }
  const targets = selected ? [selected] : [...CONTEXT_TARGETS];
  const content = renderCore(profile);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const projections: ContextProjection[] = targets.map((currentTarget) => {
    const rendered = renderProjection(currentTarget, content);
    const estimatedTokens = estimateTokens(rendered);
    return {
      target: currentTarget,
      kind: currentTarget === 'hermes' ? 'managed-block' : 'file',
      content: rendered,
      bytes: Buffer.byteLength(rendered, 'utf8'),
      estimated_tokens: estimatedTokens,
      within_budget: estimatedTokens <= TIER1_TOTAL_TOKENS,
    };
  });
  return {
    schema_version: 1,
    token_estimate: 'characters/4',
    budget_tokens: TIER1_TOTAL_TOKENS,
    core: { content, sha256 },
    omitted_profile_fields: ['stack', 'agents', 'updated', 'active_project', 'recent_decisions'],
    projections,
  };
}
