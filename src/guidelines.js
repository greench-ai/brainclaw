// Brainclaw — Guideline synthesis and management
import { getActiveGuidelines, insertGuideline, updateGuidelineConfidence, deactivateGuideline } from './db.js';
import { categorizeGuideline } from './sanitize.js';
import { nanoid } from 'nanoid';

// ── Synthesis ────────────────────────────────────────────────────────────────

/**
 * Synthesize a new guideline from a high-value episode
 * Called by the memory system when reward * confidence exceeds threshold
 */
export async function synthesizeGuideline({ episode, llm }) {
  const { intent, action, outcome, q_value, confidence } = episode;

  // Skip if quality is too low
  if (q_value < 0.1 && confidence < 0.6) return null;

  // Build synthesis prompt
  const prompt = `You are a coding style advisor for an AI development agent.
From this successful agent interaction, derive ONE concise behavioral guideline
that captures what the agent did right.

Format: A single, actionable rule in plain English, max 120 characters.
Example: "When user asks to set up a project, prefer npm init over yarn for compatibility"
Example: "When fixing bugs, always write a failing test first to confirm the issue"

Successful interaction:
Intent: ${intent}
Agent action: ${action.slice(0, 300)}
Outcome: ${outcome?.slice(0, 200) || 'success'}

Your guideline (max 120 chars):`.slice(0, 600);

  let guidelineText = '';
  try {
    const response = await llm.complete(prompt);
    guidelineText = response.trim().slice(0, 120);
  } catch {
    guidelineText = action.slice(0, 120);
  }

  if (!guidelineText) return null;

  const priority = Math.round((Math.abs(q_value) * 0.6 + confidence * 0.4) * 10);

  return {
    id: nanoid(),
    pattern: intent,
    guideline: guidelineText,
    category: categorizeGuideline(guidelineText),
    priority,
    confidence: Math.min(1, confidence + 0.1),
    q_based: true,
    source_episode: episode.id,
  };
}

// ── Decay ───────────────────────────────────────────────────────────────────

/**
 * Decay guideline confidence over time (called periodically)
 * Low-confidence guidelines get deactivated
 */
export function decayGuidelines(agentId) {
  const guidelines = getActiveGuidelines(agentId);
  const decayed = [];

  for (const g of guidelines) {
    if (g.confidence < 0.15 && g.q_based) {
      deactivateGuideline(g.id);
      decayed.push(g.id);
    } else {
      // Slight decay for non-Q-based guidelines
      if (!g.q_based) {
        updateGuidelineConfidence(g.id, Math.max(0.1, g.confidence - 0.01));
      }
    }
  }

  return decayed;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format active guidelines as a system prompt section
 */
export function formatGuidelinesPrompt(agentId, maxChars = 2000) {
  const guidelines = getActiveGuidelines(agentId);
  if (guidelines.length === 0) return '';

  const lines = ['## Your Learned Guidelines'];
  for (const g of guidelines) {
    const line = `[${g.category.toUpperCase()}] ${g.guideline}`;
    if (lines.join('\n').length + line.length > maxChars) break;
    lines.push(line);
  }

  return lines.join('\n');
}

/**
 * Format guidelines as a JSON struct for structured injection
 */
export function formatGuidelinesJSON(agentId) {
  const guidelines = getActiveGuidelines(agentId);
  return guidelines.map(g => ({
    id: g.id,
    category: g.category,
    priority: g.priority,
    guideline: g.guideline,
    confidence: Math.round(g.confidence * 100) / 100,
  }));
}

// ── Merge from shared hints ──────────────────────────────────────────────────

/**
 * Import a shared hint as a personal guideline
 */
export function adoptSharedHint(hint, agentId) {
  return insertGuideline({
    id: nanoid(),
    agent_id: agentId,
    category: hint.category || 'general',
    priority: 5,
    pattern: hint.pattern,
    guideline: hint.guideline,
    examples: '[]',
    q_based: false,
    confidence: hint.confidence * 0.8, // derate shared content
    source_episode: hint.id,
  });
}
