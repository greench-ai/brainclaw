# Brainclaw 🧠⚔️

> Self-Evolving Multi-Agent Memory — Like Evoclaw, but built for the GreenchClaw stack

Brainclaw is a self-improving memory and learning system for multi-agent AI teams. It watches what your agents do, learns from success and failure, and synthesizes actionable guidelines that make each agent smarter over time.

**Built for:** Fuma, Kojiro, Sasuke, and Nexus on the Greench machine — all sharing the same brain.

---

## What It Does

```
You → Agent does something → [Brainclaw records experience]
     ← Agent retrieves learned guidelines before answering ←
     ← You give feedback (praise/correct) ←
     → Q-value updated → High-value patterns → New guideline synthesized
```

**vs Evoclaw (self-evolve):**
| Feature | Evoclaw | Brainclaw |
|---------|---------|-----------|
| Multi-agent shared memory | ❌ | ✅ All 4 agents share episodic memory |
| A2A protocol | ❌ | ✅ Agent-to-agent hint sharing |
| Privacy-first | ⚠️ Remote server | ✅ All local, no external deps |
| GreenchClaw native | ❌ | ✅ Plugin hooks + sidecar |
| Q-learning | ✅ | ✅ + confidence weighting |
| Guideline synthesis | LLM-only | Configurable (LLM or rule-based) |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  GreenchClaw agents (Fuma, Kojiro, Sasuke, Nexus)  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ Plugin Hooks │  │ Plugin Hooks │  │ Plugin    │ │
│  │ before_prompt│  │ agent_end    │  │ Hooks     │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘ │
└─────────┼──────────────────┼───────────────┼───────┘
          │  HTTP / WS       │               │
          └────────┬─────────┘               │
                   ▼                          │
          ┌────────────────────┐             │
          │  Brainclaw Sidecar │◄───────────-┘
          │  (port 3002)       │   (agent registers itself)
          │  ┌───────────────┐ │
          │  │ SQLite DB    │ │
          │  │ episodes.db  │ │
          │  │ guidelines   │ │
          │  │ shared_hints │ │
          │  └───────────────┘ │
          │  ┌───────────────┐ │
          │  │ Q-Learning    │ │
          │  │ Memory Engine │ │
          │  └───────────────┘ │
          │  ┌───────────────┐ │
          │  │ A2A Protocol  │ │
          │  │ Hint Exchange │ │
          │  └───────────────┘ │
          └────────────────────┘
```

**Two parts:**
1. **Sidecar service** (`src/index.js`) — Fastify + SQLite + WebSocket server on port 3002
2. **GreenchClaw plugin** (`GreenchClaw-plugin/`) — Hooks into gateway events

---

## Quick Start

```bash
# 1. Install dependencies
cd /home/greench/projects/brainclaw
npm install

# 2. Start the sidecar
npm start

# 3. In another terminal, register an agent
curl -X POST http://localhost:3002/api/agents/sasuke \
  -H "Content-Type: application/json" \
  -d '{"name":"Sasuke","platform":"GreenchClaw","port":18420}'

# 4. Record an experience
curl -X POST http://localhost:3002/api/experiences \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "sasuke",
    "userMessage": "Build me a new API endpoint",
    "agentReply": "Created Fastify route at /api/data with SQLite persistence",
    "toolWasUsed": true
  }'

# 5. Give feedback (positive)
curl -X POST http://localhost:3002/api/feedback \
  -H "Content-Type: application/json" \
  -d '{"agentId":"sasuke","reward":0.8,"confidence":0.9}'

# 6. Retrieve before next similar task
curl -X POST http://localhost:3002/api/retrieve \
  -H "Content-Type: application/json" \
  -d '{"agentId":"sasuke","contextText":"Build me a new API endpoint"}'
```

---

## API Reference

### Agents
- `POST /api/agents/:agentId` — Register an agent
- `GET /api/agents` — List all registered agents

### Experiences
- `POST /api/experiences` — Record an experience
- `POST /api/feedback` — Give feedback on an episode (triggers Q-update + guideline synthesis)

### Retrieval
- `POST /api/retrieve` — Get relevant guidelines + episodes for current context

### Guidelines
- `GET /api/guidelines/:agentId` — List active guidelines as JSON
- `GET /api/guidelines/:agentId/prompt` — Format guidelines as prompt text

### Tasks
- `POST /api/tasks/start` — Start tracking a new task
- `POST /api/tasks/close` — Close task, record episode
- `GET /api/tasks/:agentId` — Get open task

### Shared Hints (A2A)
- `POST /api/shared` — Publish a hint for other agents
- `GET /api/shared` — Query shared hints
- `POST /api/shared/:hintId/vote` — Upvote/downvote a hint

### Stats
- `GET /api/stats/:agentId` — Memory stats (episodes, guidelines, avg Q)

---

## WebSocket API

Connect to `ws://localhost:3002` (no auth for local agents).

```js
// Register
ws.send(JSON.stringify({ type: 'register', agentId: 'sasuke', label: 'Sasuke-GreenchClaw' }));

// Record experience
ws.send(JSON.stringify({ type: 'experience', agentId: 'sasuke', data: { userMessage: '...', agentReply: '...' } }));

// Retrieve
ws.send(JSON.stringify({ type: 'retrieve', agentId: 'sasuke', contextText: 'Build me an API' }));

// Feedback
ws.send(JSON.stringify({ type: 'feedback', agentId: 'sasuke', data: { reward: 0.8 } }));
```

---

## The Learning Loop

```
1. TASK START → agent begin_task() → new task created
2. TURNS → agent does work → each turn recorded
3. FEEDBACK → user says "great" or "wrong" → processFeedback()
4. Q-UPDATE → Q-value adjusted: Q = Q + α(reward - Q)
5. LEARN? → if reward * confidence > gates → synthesizeGuideline()
6. RETRIEVE → next similar task → inject relevant guidelines
7. REPEAT → each interaction makes the agent smarter
```

**Learning gates (configurable):**
- `minAbsReward: 0.15` — Reward must exceed this
- `minRewardConfidence: 0.55` — Feedback confidence must exceed this
- `retrieval.tau: 0.72` — Similarity threshold for injection

---

## Privacy Design

- All data stored locally in `brainclaw.db` (SQLite)
- Two-stage sanitization before any sharing:
  1. **Structural** — Remove IDs, URLs, emails, file paths, API keys
  2. **LLM generalization** — Replace remaining specifics with `[REDACTED_*]` placeholders
- Shared hints are **behavioral patterns only** — no raw conversations leave the agent
- Each agent has its own isolated episode namespace
- Shared hints can be opted into per-hint (not all-or-nothing)

---

## LLM Configuration

Brainclaw uses a local LLM for guideline synthesis by default (Ollama). Configure in `src/index.js`:

```js
const LLM_CONFIG = {
  provider: 'ollama',       // 'ollama' | 'openai' | 'anthropic'
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.2:latest', // or your preferred model
  apiKey: null,
};
```

If no LLM is available, Brainclaw falls back to rule-based generalization.

---

## Project Structure

```
brainclaw/
├── src/
│   ├── index.js      # Fastify server + WebSocket + HTTP API
│   ├── db.js         # SQLite schema + all queries
│   ├── memory.js     # Q-learning episodic memory engine
│   ├── guidelines.js # Guideline synthesis + management
│   ├── sanitize.js   # Two-stage privacy filter
│   └── a2a.js        # A2A protocol handler
├── GreenchClaw-plugin/
│   ├── index.ts      # GreenchClaw plugin entry
│   └── plugin.json   # Plugin manifest
├── brainclaw.db      # SQLite database (created at runtime)
├── package.json
└── README.md
```

---

## License

MIT — Greench-AI Team
