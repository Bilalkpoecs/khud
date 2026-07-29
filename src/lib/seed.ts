import type { Profile } from './types.js';

export function buildSeedProfile(): Profile {
  const today = new Date().toISOString().slice(0, 10);

  return {
    name: 'Bilal Ahmad',
    updated: today,
    stack: [
      'TypeScript',
      'Node.js',
      'PostgreSQL',
      'Drizzle ORM',
      'n8n',
      'Railway',
      'Google Apps Script'
    ],
    agents: [
      'Claude Code',
      'OpenCode v1.3.3',
      'Cursor'
    ],
    preferences: [
      'Never use default exports in TypeScript',
      'Always explicit try/catch in async functions',
      'Minimal abstractions - explicit over implicit',
      'No em dashes in any output',
      'n8n: prefer positional $input.all() in Code nodes over node name references',
      'Prefer Railway for Node.js hosting',
      'PostgreSQL with Drizzle ORM - no raw SQL strings'
    ],
    active_project: {
      name: 'khud',
      description: 'Cross-agent identity compiler - local Phase 0',
      stack: 'Node.js + TypeScript + Railway',
      status: 'Phase 0 - building and wiring on Portege'
    },
    recent_decisions: [
      {
        date: today,
        what: 'khud uses zero extra API for capture',
        why: 'agent writes its own session summary - cheaper, faster, no extra dependency'
      },
      {
        date: today,
        what: 'local-first architecture for Phase 0',
        why: 'fastest validation, zero risk, no hosting needed before value is proven'
      }
    ],
    constraints: [
      'Linux Mint 22.3 XFCE on Toshiba Portege X30W-J - X11 not Wayland',
      'PipeWire audio stack - use aplay not paplay',
      'OpenCode: use stdbuf -oL to prevent inotifywait output buffering',
      'nvm manages Node.js - source nvm before running node in scripts',
      'Work desktop is NYS-bilal-PC (separate machine)'
    ]
  };
}

export const SEED_PROFILE: Profile = buildSeedProfile();
