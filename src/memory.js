// Brainclaw — Q-learning episodic memory with multi-agent support
import { insertEpisode, updateEpisodeQ, searchEpisodes, getRecentEpisodes, insertFeedback, getDb } from './db.js';
import { sanitizeMemoryText, detectIntent, categorizeGuideline, generalizeWithLLM } from './sanitize.js';
import { insertGuideline, getActiveGuidelines } from './db.js';
import { nanoid } from 'nanoid';

// ── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  learning: {
    minAbsReward: 0.15,
    minRewardConfidence: 0.55,
    newIntentThreshold: 0.35,
    maxTurnsPerTask: 5,
    idleTurnsToClose: 2,
    pendingTtlMs: 300_000,
  },
  retrieval: {
    tau: 0.72,        // similarity threshold
    maxInject: 5,     // max guidelines to inject
  },
  memory: {
    maxEntries: 300,
    forgetHalfLifeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  }
};

// ── Q-Learning Core ───────────────────────────────────────────────────────────

/**
 * Compute updated Q-value using exponential moving average
 * Q_new = Q_old + alpha * (reward - Q_old)
 */
function updateQ(qOld, reward, confidence = 0.5) {
  const alpha = 0.3 * confidence; // higher confidence → faster update
  return qOld + alpha * (reward - qOld);
}

// ── Task Tracker ─────────────────────────────────────────────────────────────

const tasks = new Map(); // agentId -> { id, intent, turns, lastSeen, status }

// ── Experience Buffer ───────────────────────────────────────────────────────

// Per-agent pending experience buffers
const pendingExperiences = new Map(); // agentId -> [exp, ...]

export function startTask(agentId, intent) {
  const task = {
    id: nanoid(),
    agentId,
    intent,
    turns: 0,
    lastSeen: Date.now(),
    status: 'open',
    ttlAt: Date.now() + CONFIG.learning.pendingTtlMs,
    actions: [],
    outcome: null,
  };
  tasks.set(agentId, task);
  return task;
}

export function addTurnToTask(agentId, action, result) {
  const task = tasks.get(agentId);
  if (!task || task.status !== 'open') return null;
  task.turns++;
  task.lastSeen = Date.now();
  task.actions.push({ action, result, turn: task.turns });
  task.ttlAt = Date.now() + CONFIG.learning.pendingTtlMs;

  // Auto-close on max turns
  if (task.turns >= CONFIG.learning.maxTurnsPerTask) {
    task.status = 'max_turns';
  }

  return task;
}

export function closeTask(agentId, outcome, reward) {
  const task = tasks.get(agentId);
  if (!task) return null;
  task.outcome = outcome;
  task.status = task.status === 'open' ? 'done' : task.status;

  // Record the full episode
  const episode = {
    id: nanoid(),
    agentId,
    intent: task.intent,
    action: task.actions.map(a => a.action).join(' → '),
    outcome,
    reward,
    q_value: reward, // bootstrap with reward as initial Q
    confidence: 0.5,
    tags: [categorizeGuideline(outcome)],
  };

  insertEpisode(episode);
  tasks.delete(agentId);
  return episode;
}

export function getOpenTask(agentId) {
  return tasks.get(agentId) || null;
}

export function isNewIntent(agentId, newIntent) {
  const task = tasks.get(agentId);
  if (!task) return true;

  // Simple similarity check on intent strings
  const sim = jaccardSimilarity(task.intent, newIntent);
  return sim < CONFIG.learning.newIntentThreshold;
}

// ── Main learning entry ──────────────────────────────────────────────────────

/**
 * Called after agent reply. Immediately writes an episode and returns its ID.
 * @returns {string} episodeId
 */
export async function recordExperience({ agentId, userMessage, agentReply, toolWasUsed, reward = 0, llm }) {
  const intent = sanitizeMemoryText(detectIntent(userMessage) + ': ' + userMessage.slice(0, 200));
  const task = getOpenTask(agentId);

  if (!task) {
    startTask(agentId, intent);
  } else {
    addTurnToTask(agentId, agentReply.slice(0, 300), null);
  }

  // Immediately write the episode so feedback can find it
  const episode = {
    id: nanoid(),
    agentId,
    intent,
    action: agentReply.slice(0, 300),
    outcome: '',
    reward,
    q_value: reward,
    confidence: 0.5,
    tags: [],
  };

  insertEpisode(episode);
  return episode.id;
}

// ── Feedback processing ──────────────────────────────────────────────────────

/**
 * Called when user gives explicit feedback (praise/correction)
 * Scores the reward and decides whether to write an episodic memory + guideline
 */
export async function processFeedback({ agentId, episodeId, reward, confidence = 0.8, note, llm }) {
  const db = getDb();

  // Fetch the episode (or find most recent if none specified)
  let ep = episodeId ? db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId) : null;
  if (!ep) {
    // Fall back to most recent episode for this agent
    ep = db.prepare('SELECT * FROM episodes WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(agentId);
  }
  if (!ep) return { learned: false, reason: 'episode_not_found' };

  // Store feedback
  insertFeedback({ episode_id: ep.id, agent_id: agentId, reward, confidence, note });

  // Update Q-value
  const newQ = updateQ(ep.q_value, reward, confidence);
  const newConfidence = Math.min(1, ep.confidence + 0.05);
  updateEpisodeQ(episodeId, newQ, newConfidence);

  const absReward = Math.abs(reward);

  // Check learning gates
  if (absReward < CONFIG.learning.minAbsReward) {
    return { learned: false, reason: 'reward_below_threshold', q: newQ };
  }
  if (confidence < CONFIG.learning.minRewardConfidence) {
    return { learned: false, reason: 'confidence_below_threshold', q: newQ };
  }

  // Sanitize and generalize
  const sanitized = sanitizeMemoryText(ep.action + ' | ' + ep.outcome);
  let generalized;
  if (llm) {
    try {
      generalized = await generalizeWithLLM(sanitized, ep.intent, ep.action, llm);
    } catch {
      generalized = { pattern: ep.intent, guideline: ep.action.slice(0, 200), placeholders: [] };
    }
  } else {
    generalized = { pattern: ep.intent, guideline: ep.action.slice(0, 200), placeholders: [] };
  }

  // Write guideline
  const category = categorizeGuideline(generalized.guideline);
  const guidelineId = insertGuideline({
    id: nanoid(),
    agent_id: agentId,
    category,
    priority: Math.round(absReward * 10),
    pattern: generalized.pattern,
    guideline: generalized.guideline,
    examples: JSON.stringify([{ intent: ep.intent, action: ep.action }]),
    q_based: true,
    confidence: newConfidence,
    source_episode: episodeId,
  });

  // Cleanup old episodes if over limit
  pruneOldEpisodes(agentId);

  return {
    learned: true,
    guidelineId,
    pattern: generalized.pattern,
    q: newQ,
    category,
  };
}

// ── Retrieval ─────────────────────────────────────────────────────────────────

/**
 * Retrieve relevant memories for the current context
 * Returns: { guidelines: [...], episodes: [...], sharedHints: [...] }
 */
export async function retrieve({ agentId, contextEmbedding, contextText, limit = 5 }) {
  const guidelines = getActiveGuidelines(agentId);

  // If we have an embedding, search episodic memory
  let episodes = [];
  if (contextEmbedding) {
    episodes = searchEpisodes(agentId, contextEmbedding, CONFIG.retrieval.tau, limit);
  } else if (contextText) {
    // Fallback: keyword search on recent episodes
    const intent = detectIntent(contextText);
    const recent = getRecentEpisodes(agentId, Math.floor(Date.now() / 1000) - 86400);
    episodes = recent
      .filter(e => e.intent.includes(intent) || e.action.includes(intent))
      .slice(0, limit);
  }

  // Filter guidelines by similarity to context
  const scoredGuidelines = guidelines.map(g => {
    // Simple keyword overlap scoring
    const ctxWords = (contextText || '').toLowerCase().split(/\s+/);
    const guideWords = (g.guideline + ' ' + g.pattern).toLowerCase().split(/\s+/);
    const overlap = ctxWords.filter(w => w.length > 3 && guideWords.some(gw => gw.includes(w))).length;
    const score = overlap / Math.max(ctxWords.length, 1);
    return { ...g, relevanceScore: score };
  })
    .filter(g => g.relevanceScore > 0 || g.confidence > 0.7)
    .sort((a, b) => {
      const scoreA = a.relevanceScore * 0.4 + a.confidence * 0.6;
      const scoreB = b.relevanceScore * 0.4 + b.confidence * 0.6;
      return scoreB - scoreA;
    })
    .slice(0, CONFIG.retrieval.maxInject);

  // Fetch shared hints from other agents
  const { getSharedHints } = await import('./db.js');
  const allSharedHints = getSharedHints(null, null, 50);
  const scoredHints = allSharedHints
    .filter(h => h.from_agent !== agentId) // don't show own hints back to self
    .map(h => {
      const ctxWords = (contextText || '').toLowerCase().split(/\s+/);
      const hintWords = (h.pattern + ' ' + h.guideline).toLowerCase().split(/\s+/);
      const overlap = ctxWords.filter(w => w.length > 3 && hintWords.some(hw => hw.includes(w))).length;
      const score = overlap / Math.max(ctxWords.length, 1);
      return { ...h, relevanceScore: score };
    })
    .filter(h => h.relevanceScore > 0.1 || h.confidence > 0.6)
    .sort((a, b) => {
      const scoreA = a.relevanceScore * 0.4 + a.confidence * 0.6;
      const scoreB = b.relevanceScore * 0.4 + b.confidence * 0.6;
      return scoreB - scoreA;
    })
    .slice(0, 5);

  return {
    guidelines: scoredGuidelines,
    episodes: episodes.map(e => ({ id: e.id, intent: e.intent, action: e.action, q: e.q_value, similarity: e.similarity })),
    sharedHints: scoredHints,
  };
}

// ── Injection formatter ─────────────────────────────────────────────────────

/**
 * Format retrieved memories as a prompt injection string
 */
export function formatInjection({ guidelines, episodes, sharedHints }) {
  const parts = [];

  if (guidelines.length > 0) {
    parts.push('## Learned Guidelines (apply if relevant)');
    for (const g of guidelines) {
      parts.push(`[${g.category.toUpperCase()}] ${g.guideline}`);
    }
  }

  if (sharedHints && sharedHints.length > 0) {
    parts.push('\n## Team Hints (from other agents)');
    for (const h of sharedHints) {
      parts.push(`[${h.category?.toUpperCase() || 'TEAM'}] ${h.guideline} (via ${h.from_agent})`);
    }
  }

  if (episodes.length > 0) {
    parts.push('\n## Relevant Past Experience');
    for (const e of episodes) {
      parts.push(`• ${e.intent}: ${e.action.slice(0, 150)}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

function pruneOldEpisodes(agentId) {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM episodes WHERE agent_id = ?').get(agentId)?.c ?? 0;
  if (count <= CONFIG.memory.maxEntries) return;

  const toDelete = count - CONFIG.memory.maxEntries;
  db.prepare(`
    DELETE FROM episodes WHERE id IN (
      SELECT id FROM episodes WHERE agent_id = ? AND q_value < 0
      ORDER BY created_at ASC LIMIT ?
    )
  `).run(agentId, Math.ceil(toDelete * 0.5));

  // If still over, delete oldest by date
  const remaining = db.prepare('SELECT COUNT(*) as c FROM episodes WHERE agent_id = ?').get(agentId)?.c ?? 0;
  if (remaining > CONFIG.memory.maxEntries) {
    const extra = remaining - CONFIG.memory.maxEntries;
    db.prepare(`
      DELETE FROM episodes WHERE id IN (
        SELECT id FROM episodes WHERE agent_id = ? ORDER BY created_at ASC LIMIT ?
      )
    `).run(agentId, extra);
  }
}

// ── Utils ───────────────────────────────────────────────────────────────────

function jaccardSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

export function getConfig() { return CONFIG; }
