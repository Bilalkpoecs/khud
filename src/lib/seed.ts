import os from 'node:os';

import type { Profile } from './types.js';

/**
 * A blank profile for a machine that has never run khud. Every list starts
 * empty so the first sync compiles nothing the user did not write, and the
 * name falls back to the OS account rather than a placeholder, since it is
 * the one field the context projection requires to be non-empty.
 */
export function buildSeedProfile(): Profile {
  const today = new Date().toISOString().slice(0, 10);

  return {
    name: currentUserName(),
    updated: today,
    stack: [],
    agents: [],
    preferences: [],
    active_project: {
      name: '',
      description: '',
      stack: '',
      status: ''
    },
    recent_decisions: [],
    constraints: []
  };
}

function currentUserName(): string {
  try {
    const { username } = os.userInfo();
    return username.trim() || 'you';
  } catch {
    return 'you';
  }
}

export const SEED_PROFILE: Profile = buildSeedProfile();
