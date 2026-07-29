import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteText } from '../lib/atomic.js';
import { resolvePaths } from '../lib/paths.js';
import type { Profile } from '../lib/types.js';

const CLAUDE_MD = resolvePaths().claudeMarkdown;

export function injectClaude(profile: Profile): void {
  const content = compileToClaude(profile);
  fs.mkdirSync(path.dirname(CLAUDE_MD), { recursive: true });
  // Claude's SessionStart hook runs async, so a torn CLAUDE.md would load silently.
  atomicWriteText(CLAUDE_MD, content);
}

function compileToClaude(profile: Profile): string {
  const decisions = profile.recent_decisions
    .slice(0, 5)
    .map((decision) => `- **${decision.date}** - ${decision.what} (${decision.why})`)
    .join('\n');

  const preferences = profile.preferences.map((preference) => `- ${preference}`).join('\n');
  const stack = profile.stack.join(' · ');
  const constraints = profile.constraints.map((constraint) => `- ${constraint}`).join('\n');

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
