// Brainclaw — A2A (Agent-to-Agent) protocol handler
// Implements a lightweight A2A-inspired protocol for cross-agent memory sharing
// Built on the shared hints system for privacy-preserving knowledge exchange

import { insertSharedHint, getSharedHints, voteHint } from './db.js';
import { nanoid } from 'nanoid';

// ── A2A Message Types ───────────────────────────────────────────────────────

export const A2A_METHODS = {
  HINT_PUBLISH: 'hint.publish',    // Share a learned guideline
  HINT_QUERY: 'hint.query',        // Request guidelines for a pattern
  HINT_VOTE: 'hint.vote',         // Upvote/downvote a shared hint
  MEMORY_SYNC: 'memory.sync',     // Sync episodic memory summaries
  CAPABILITY_DISCOVER: 'capability.discover', // Discover what other agents can do
};

// ── Inbound A2A handler ──────────────────────────────────────────────────────

const handlers = new Map();

export function registerA2AHandler(method, handler) {
  handlers.set(method, handler);
}

export async function handleA2AMessage(fromAgent, message) {
  const { method, payload, id } = message;
  const handler = handlers.get(method);
  if (!handler) {
    return { id, error: `Unknown method: ${method}` };
  }

  try {
    const result = await handler(fromAgent, payload);
    return { id, result };
  } catch (e) {
    return { id, error: e.message };
  }
}

// ── Shared hint sharing ──────────────────────────────────────────────────────

/**
 * Share a guideline as a hint with other agents
 * @param {string} fromAgent - Publishing agent ID
 * @param {object} guideline - { pattern, guideline, category, confidence }
 */
export async function shareGuideline(fromAgent, guideline) {
  // Sanitize before sharing
  const hint = {
    from_agent: fromAgent,
    pattern: guideline.pattern || guideline.guideline.slice(0, 100),
    guideline: guideline.guideline.slice(0, 300),
    category: guideline.category || 'general',
    confidence: guideline.confidence || 0.5,
  };

  const id = insertSharedHint(hint);
  return { id, hint };
}

/**
 * Query for hints matching a pattern/category
 */
export function queryHints(pattern, category = null, limit = 10) {
  const hints = getSharedHints(null, category, limit);
  if (!pattern) return hints;

  const patternLower = pattern.toLowerCase();
  return hints.filter(h =>
    h.pattern.toLowerCase().includes(patternLower) ||
    h.guideline.toLowerCase().includes(patternLower)
  );
}

/**
 * Vote on a shared hint
 */
export function voteOnHint(hintId, upvote) {
  voteHint(hintId, upvote);
  return { ok: true };
}

// ── Built-in handlers ────────────────────────────────────────────────────────

registerA2AHandler(A2A_METHODS.HINT_PUBLISH, async (fromAgent, payload) => {
  const { guideline } = payload;
  if (!guideline?.guideline) throw new Error('guideline required');
  return shareGuideline(fromAgent, guideline);
});

registerA2AHandler(A2A_METHODS.HINT_QUERY, async (fromAgent, payload) => {
  const { pattern, category, limit } = payload;
  return queryHints(pattern, category, limit ?? 10);
});

registerA2AHandler(A2A_METHODS.HINT_VOTE, async (fromAgent, payload) => {
  const { hintId, upvote } = payload;
  if (!hintId) throw new Error('hintId required');
  return voteOnHint(hintId, upvote ?? true);
});

registerA2AHandler(A2A_METHODS.CAPABILITY_DISCOVER, async (fromAgent, payload) => {
  // Return this agent's capabilities (what it can help with)
  return {
    agentId: fromAgent,
    capabilities: ['memory', 'guidelines', 'retrieval', 'feedback'],
    version: '1.0.0',
  };
});

// ── Serialization for HTTP transport ─────────────────────────────────────────

export function parseA2ARequest(body) {
  try {
    return typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return null;
  }
}

export function a2aResponse(id, result, error = null) {
  return { id: id || nanoid(), result, error, ts: Date.now() };
}
