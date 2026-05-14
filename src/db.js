// Brainclaw — SQLite persistence layer
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'brainclaw.db');

// ── Schema ──────────────────────────────────────────────────────────────────

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      platform  TEXT NOT NULL,
      port      INTEGER,
      metadata  TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      intent        TEXT NOT NULL,
      action        TEXT NOT NULL,
      outcome       TEXT NOT NULL,
      reward        REAL DEFAULT 0,
      q_value       REAL DEFAULT 0,
      confidence    REAL DEFAULT 0.5,
      embedding     TEXT,
      tags          TEXT DEFAULT '[]',
      source        TEXT DEFAULT 'local',
      created_at    INTEGER DEFAULT (unixepoch()),
      expires_at    INTEGER,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS guidelines (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      category      TEXT NOT NULL,
      priority      INTEGER DEFAULT 5,
      pattern       TEXT NOT NULL,
      guideline     TEXT NOT NULL,
      examples      TEXT DEFAULT '[]',
      q_based       INTEGER DEFAULT 0,
      confidence    REAL DEFAULT 0.5,
      source_episode TEXT,
      active        INTEGER DEFAULT 1,
      created_at    INTEGER DEFAULT (unixepoch()),
      updated_at    INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id            TEXT PRIMARY KEY,
      episode_id    TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      reward        REAL NOT NULL,
      confidence    REAL DEFAULT 0.5,
      note          TEXT,
      created_at    INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (episode_id) REFERENCES episodes(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS shared_hints (
      id            TEXT PRIMARY KEY,
      from_agent    TEXT NOT NULL,
      pattern       TEXT NOT NULL,
      guideline     TEXT NOT NULL,
      category      TEXT DEFAULT 'general',
      confidence    REAL DEFAULT 0.5,
      upvotes       INTEGER DEFAULT 0,
      downvotes     INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (from_agent) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS task_context (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      intent        TEXT NOT NULL,
      turns         INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'open',
      started_at    INTEGER DEFAULT (unixepoch()),
      ended_at      INTEGER,
      ttl_at        INTEGER,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_episodes_embedding ON episodes(embedding);
    CREATE INDEX IF NOT EXISTS idx_episodes_reward ON episodes(reward DESC);
    CREATE INDEX IF NOT EXISTS idx_guidelines_agent ON guidelines(agent_id, active);
    CREATE INDEX IF NOT EXISTS idx_task_context_agent ON task_context(agent_id, status);
  `);

  return _db;
}

// ── Agents ───────────────────────────────────────────────────────────────────

export function upsertAgent(agent) {
  const db = getDb();
  db.prepare(`
    INSERT INTO agents (id, name, platform, port, metadata)
    VALUES (@id, @name, @platform, @port, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      platform = excluded.platform,
      port = excluded.port,
      metadata = excluded.metadata
  `).run({ ...agent, metadata: JSON.stringify(agent.metadata || {}) });
}

export function listAgents() {
  return getDb().prepare('SELECT * FROM agents').all().map(r => ({
    ...r, metadata: JSON.parse(r.metadata || '{}')
  }));
}

// ── Episodes ─────────────────────────────────────────────────────────────────

export function insertEpisode(episode) {
  const db = getDb();
  const id = episode.id || nanoid();
  db.prepare(`
    INSERT INTO episodes (id, agent_id, intent, action, outcome, reward, q_value, confidence, embedding, tags, source)
    VALUES (@id, @agent_id, @intent, @action, @outcome, @reward, @q_value, @confidence, @embedding, @tags, @source)
  `).run({
    id,
    agent_id: episode.agentId,
    intent: episode.intent,
    action: episode.action,
    outcome: episode.outcome || '',
    embedding: episode.embedding ? JSON.stringify(episode.embedding) : null,
    tags: JSON.stringify(episode.tags || []),
    reward: episode.reward ?? 0,
    q_value: episode.q_value ?? 0,
    confidence: episode.confidence ?? 0.5,
    source: episode.source || 'local',
  });
  return id;
}

export function updateEpisodeQ(id, qValue, confidence) {
  getDb().prepare('UPDATE episodes SET q_value = ?, confidence = ? WHERE id = ?').run(qValue, confidence, id);
}

export function getEpisodesByAgent(agentId, limit = 50) {
  return getDb().prepare(
    'SELECT * FROM episodes WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(agentId, limit).map(r => ({
    ...r, embedding: r.embedding ? JSON.parse(r.embedding) : null, tags: JSON.parse(r.tags || '[]')
  }));
}

export function getTopEpisodes(agentId, minQ = 0, limit = 20) {
  return getDb().prepare(
    'SELECT * FROM episodes WHERE agent_id = ? AND q_value >= ? ORDER BY q_value DESC, created_at DESC LIMIT ?'
  ).all(agentId, minQ, limit).map(r => ({
    ...r, embedding: r.embedding ? JSON.parse(r.embedding) : null, tags: JSON.parse(r.tags || '[]')
  }));
}

export function searchEpisodes(agentId, embedding, minSimilarity = 0.7, limit = 10) {
  // Naive cosine similarity on embedding vectors (stored as JSON arrays)
  const episodes = getDb().prepare(
    'SELECT * FROM episodes WHERE agent_id = ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 200'
  ).all(agentId);

  const scored = episodes.map(ep => {
    const epEmb = JSON.parse(ep.embedding);
    const sim = cosineSimilarity(embedding, epEmb);
    return { ...ep, embedding: epEmb, similarity: sim };
  }).filter(e => e.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-10);
}

export function getRecentEpisodes(agentId, sinceUnix) {
  return getDb().prepare(
    'SELECT * FROM episodes WHERE agent_id = ? AND created_at >= ? ORDER BY created_at DESC'
  ).all(agentId, sinceUnix).map(r => ({
    ...r, embedding: r.embedding ? JSON.parse(r.embedding) : null
  }));
}

// ── Guidelines ────────────────────────────────────────────────────────────────

export function insertGuideline(gl) {
  const db = getDb();
  const id = gl.id || nanoid();
  db.prepare(`
    INSERT INTO guidelines (id, agent_id, category, priority, pattern, guideline, examples, q_based, confidence, source_episode)
    VALUES (@id, @agent_id, @category, @priority, @pattern, @guideline, @examples, @q_based, @confidence, @source_episode)
  `).run({
    id,
    agent_id: gl.agentId || gl.agent_id,
    category: gl.category,
    priority: gl.priority ?? 5,
    pattern: gl.pattern,
    guideline: gl.guideline,
    examples: JSON.stringify(gl.examples || []),
    q_based: gl.q_based ? 1 : 0,
    confidence: gl.confidence ?? 0.5,
    source_episode: gl.source_episode || null,
  });
  return id;
}

export function getActiveGuidelines(agentId, category = null) {
  const db = getDb();
  const sql = category
    ? 'SELECT * FROM guidelines WHERE agent_id = ? AND active = 1 AND category = ? ORDER BY priority DESC, confidence DESC'
    : 'SELECT * FROM guidelines WHERE agent_id = ? AND active = 1 ORDER BY priority DESC, confidence DESC';
  const rows = category ? db.prepare(sql).all(agentId, category) : db.prepare(sql).all(agentId);
  return rows.map(r => ({ ...r, examples: JSON.parse(r.examples || '[]'), q_based: !!r.q_based }));
}

export function deactivateGuideline(id) {
  getDb().prepare('UPDATE guidelines SET active = 0 WHERE id = ?').run(id);
}

export function updateGuidelineConfidence(id, confidence) {
  getDb().prepare('UPDATE guidelines SET confidence = ?, updated_at = unixepoch() WHERE id = ?').run(confidence, id);
}

// ── Feedback ─────────────────────────────────────────────────────────────────

export function insertFeedback(feedback) {
  const id = feedback.id || nanoid();
  getDb().prepare(`
    INSERT INTO feedback (id, episode_id, agent_id, reward, confidence, note)
    VALUES (@id, @episode_id, @agent_id, @reward, @confidence, @note)
  `).run({
    id,
    episode_id: feedback.episode_id,
    agent_id: feedback.agent_id,
    reward: feedback.reward,
    confidence: feedback.confidence ?? 0.5,
    note: feedback.note || null,
  });
  return id;
}

// ── Task context ─────────────────────────────────────────────────────────────

export function upsertTaskContext(task) {
  const db = getDb();
  const id = task.id || nanoid();
  db.prepare(`
    INSERT INTO task_context (id, agent_id, intent, turns, status, ttl_at)
    VALUES (@id, @agent_id, @intent, @turns, @status, @ttl_at)
    ON CONFLICT(id) DO UPDATE SET
      turns = excluded.turns,
      status = excluded.status,
      ended_at = excluded.ended_at,
      ttl_at = excluded.ttl_at
  `).run({
    id,
    agent_id: task.agentId,
    intent: task.intent,
    turns: task.turns ?? 0,
    status: task.status ?? 'open',
    ttl_at: task.ttl_at || null,
    ended_at: task.ended_at || null,
  });
  return id;
}

export function getOpenTask(agentId) {
  return getDb().prepare(
    'SELECT * FROM task_context WHERE agent_id = ? AND status = \'open\' ORDER BY started_at DESC LIMIT 1'
  ).get(agentId);
}

export function closeTask(id, status = 'done') {
  getDb().prepare('UPDATE task_context SET status = ?, ended_at = unixepoch() WHERE id = ?').run(status, id);
}

// ── Shared hints (A2A) ──────────────────────────────────────────────────────

export function insertSharedHint(hint) {
  const id = hint.id || nanoid();
  getDb().prepare(`
    INSERT INTO shared_hints (id, from_agent, pattern, guideline, category, confidence)
    VALUES (@id, @from_agent, @pattern, @guideline, @category, @confidence)
  `).run({
    id,
    from_agent: hint.from_agent,
    pattern: hint.pattern,
    guideline: hint.guideline,
    category: hint.category || 'general',
    confidence: hint.confidence ?? 0.5,
  });
  return id;
}

export function getSharedHints(agentId, category = null, limit = 20) {
  const db = getDb();
  const sql = category
    ? 'SELECT * FROM shared_hints WHERE category = ? ORDER BY (upvotes - downvotes) DESC, confidence DESC LIMIT ?'
    : 'SELECT * FROM shared_hints ORDER BY (upvotes - downvotes) DESC, confidence DESC LIMIT ?';
  const rows = category ? db.prepare(sql).all(category, limit) : db.prepare(sql).all(limit);
  return rows;
}

export function voteHint(id, upvote) {
  const col = upvote ? 'upvotes' : 'downvotes';
  getDb().prepare(`UPDATE shared_hints SET ${col} = ${col} + 1 WHERE id = ?`).run(id);
}

// ── Stats ───────────────────────────────────────────────────────────────────

export function getStats(agentId) {
  const db = getDb();
  return {
    episodes: db.prepare('SELECT COUNT(*) as c FROM episodes WHERE agent_id = ?').get(agentId)?.c ?? 0,
    guidelines: db.prepare('SELECT COUNT(*) as c FROM guidelines WHERE agent_id = ? AND active = 1').get(agentId)?.c ?? 0,
    avgQ: db.prepare('SELECT AVG(q_value) as avg FROM episodes WHERE agent_id = ?').get(agentId)?.avg ?? 0,
    feedbackCount: db.prepare('SELECT COUNT(*) as c FROM feedback WHERE agent_id = ?').get(agentId)?.c ?? 0,
  };
}
