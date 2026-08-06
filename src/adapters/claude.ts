import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteText } from '../lib/atomic.js';
import { resolvePaths } from '../lib/paths.js';
import {
  TIER1_SLOTS,
  TIER1_TOTAL_TOKENS,
  estimateTokens,
  rulesBudgetTokens,
  trimLinesToBudget,
} from '../lib/tier1.js';
import type { Profile } from '../lib/types.js';

const CLAUDE_MD = resolvePaths().claudeMarkdown;

export interface Tier1Report {
  readonly totalTokens: number;
  readonly budgetTokens: number;
  readonly withinBudget: boolean;
  readonly slotTokens: Record<string, number>;
  readonly droppedRules: readonly string[];
  readonly droppedStack: readonly string[];
}

export function injectClaude(profile: Profile): Tier1Report {
  const { content, report } = compileToClaude(profile);
  fs.mkdirSync(path.dirname(CLAUDE_MD), { recursive: true });
  // Claude's SessionStart hook runs async, so a torn CLAUDE.md would load silently.
  atomicWriteText(CLAUDE_MD, content);
  return report;
}

/** Render without writing, so a budget change can be inspected before it lands. */
export function previewClaude(profile: Profile): { content: string; report: Tier1Report } {
  return compileToClaude(profile);
}

function compileToClaude(profile: Profile): { content: string; report: Tier1Report } {
  const decisions = profile.recent_decisions
    .slice(0, 5)
    .map((decision) => `- **${decision.date}** - ${decision.what} (${decision.why})`)
    .join('\n');

  // Rules slot: preferences plus constraints, trimmed together under one budget
  // because they are one category to the reader. Default budget is unlimited; see
  // rulesBudgetTokens for why.
  const preferenceLines = profile.preferences.map((preference) => `- ${preference}`);
  const trimmedPreferences = trimLinesToBudget(preferenceLines, rulesBudgetTokens());
  const preferences = trimmedPreferences.kept.join('\n');

  // Stack slot: names only, no prose, per spec 3.1.
  const stackEntries = profile.stack;
  const trimmedStack = trimLinesToBudget(stackEntries, TIER1_SLOTS.stack.tokens);
  const stack = trimmedStack.kept.join(' · ');

  const constraints = profile.constraints.map((constraint) => `- ${constraint}`).join('\n');

  const content = renderClaude(profile, { decisions, preferences, stack, constraints });

  const identityBlock = `# ${profile.name} - Developer Identity`;
  const projectBlock = `${profile.active_project.name}${profile.active_project.description}` +
    `${profile.active_project.stack}${profile.active_project.status}${decisions}`;
  const slotTokens = {
    identity: estimateTokens(identityBlock),
    stack: estimateTokens(stack),
    rules: estimateTokens(`${preferences}\n${constraints}`),
    project: estimateTokens(projectBlock),
  };
  const totalTokens = estimateTokens(content);

  return {
    content,
    report: {
      totalTokens,
      budgetTokens: TIER1_TOTAL_TOKENS,
      withinBudget: totalTokens <= TIER1_TOTAL_TOKENS,
      slotTokens,
      droppedRules: trimmedPreferences.dropped,
      droppedStack: trimmedStack.dropped,
    },
  };
}

function renderClaude(
  profile: Profile,
  parts: { decisions: string; preferences: string; stack: string; constraints: string },
): string {
  const { decisions, preferences, stack, constraints } = parts;
  return `# ${profile.name} - Developer Identity
_Managed by khud. Edit profile at ~/.khud/profile.json. Last synced: ${profile.updated}_

## Stack
${stack}

## Preferences
${preferences}

## Active Project
**${profile.active_project.name}** - ${profile.active_project.description}
Stack: ${profile.active_project.stack}
Status: ${profile.active_project.status}

## Recent Decisions
${decisions}

## Constraints
${constraints}

---

## Khud Session Protocol

At the END of every session, before you stop, write a capture file under:
\`~/.khud/inbox/claude-code/<session-id>/<capture-id>.json\`

Legacy fallback still accepted: \`~/.khud/pending.json\` (auto-bridged).

Structure:
{
  "schema_version": 1,
  "client": "claude-code",
  "session_id": "<session id>",
  "date": "${new Date().toISOString().slice(0, 10)}",
  "decisions": [{ "what": "...", "why": "...", "evidence": { "kind": "explicit_user", "quote": "...", "confidence": 0.9 } }],
  "preferences_learned": [{ "text": "...", "evidence": { "kind": "explicit_user", "quote": "...", "confidence": 0.9 } }],
  "project_status": "one line of what was accomplished",
  "stack_updates": [],
  "source": "agent"
}

Rules:
- Quote the user verbatim for explicit preferences
- Agent inferences without quotes stay observations (not auto-promoted)
- Write empty arrays if nothing to capture
- Write silently
`;
}
