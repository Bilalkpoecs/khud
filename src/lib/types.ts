export interface Decision {
  date: string;
  what: string;
  why: string;
}

export interface PendingDecision {
  date?: string;
  what: string;
  why: string;
}

export interface ActiveProject {
  name: string;
  description: string;
  stack: string;
  status: string;
}

export interface Profile {
  name: string;
  updated: string;
  stack: string[];
  agents: string[];
  preferences: string[];
  active_project: ActiveProject;
  recent_decisions: Decision[];
  constraints: string[];
}

/** @deprecated Prefer CaptureRecord inbox. Kept for legacy pending.json bridge. */
export interface PendingSummary {
  agent: string;
  date: string;
  decisions: PendingDecision[];
  preferences_learned: string[];
  project_status: string;
  stack_updates: string[];
}

export type InjectMode = 'inject' | 'stack-only' | 'project-only' | 'off';

export type CaptureClient = 'cursor' | 'claude-code' | 'opencode' | 'unknown';

export type EvidenceKind = 'explicit_user' | 'verified_behavior' | 'agent_observation';

export type MemoryStatus =
  | 'current'
  /** Written by sentinel when the owner approves a candidate. */
  | 'promoted'
  | 'pending_review'
  | 'rejected'
  | 'superseded'
  | 'contradicted';

export interface EvidenceRef {
  kind: EvidenceKind;
  quote: string;
  message_ref?: string;
  transcript_path?: string;
  confidence: number;
}

export interface CaptureDecision {
  what: string;
  why: string;
  evidence?: EvidenceRef;
}

export interface CapturePreference {
  text: string;
  evidence?: EvidenceRef;
}

export interface CaptureRecord {
  schema_version: 1;
  capture_id: string;
  client: CaptureClient;
  session_id: string;
  created_at: string;
  date: string;
  workspace?: string;
  transcript_path?: string;
  content_hash: string;
  project_status: string;
  decisions: CaptureDecision[];
  preferences_learned: CapturePreference[];
  stack_updates: string[];
  source: 'agent' | 'transcript' | 'legacy-pending' | 'hook';
}

export interface MemoryCandidate {
  id: string;
  kind: 'preference' | 'stack' | 'status' | 'decision';
  text: string;
  why?: string;
  evidence: EvidenceRef;
  status: MemoryStatus;
  valid_from: string;
  valid_to?: string;
  supersedes?: string;
  contradicts?: string[];
  session_id: string;
  client: CaptureClient;
  capture_id: string;
}

export interface FinalizeResult {
  processed: number;
  quarantined: number;
  episodes: number;
  decisions: number;
  promoted_preferences: number;
  pending_review: number;
  skipped_duplicates: number;
  /** Captures refused because the profile would breach its byte ceiling. */
  ceiling_blocked: number;
}
