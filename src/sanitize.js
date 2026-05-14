// Brainclaw — Two-stage privacy sanitizer
// Stage 1: Structural removal of metadata, IDs, sender tags
// Stage 2: LLM-powered generalization + placeholder substitution

/**
 * Stage 1: Fast structural sanitization
 * Removes: message IDs, sender IDs, timestamps, channel names, agent names,
 *          file paths, URLs, API keys, tokens, emails, phone numbers
 */
export function sanitizeMemoryText(raw) {
  if (!raw) return '';

  return raw
    // IDs and hashes
    .replace(/\b[0-9a-f]{8,32}\b/gi, '[ID]')
    .replace(/\b[0-9a-f]{4,7}\b/gi, '[HASH]')
    // Timestamps and dates
    .replace(/\b\d{10,13}\b/g, '[TS]')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, '[DATE]')
    // URLs
    .replace(/https?:\/\/[^\s<>"]+/g, '[URL]')
    // File paths (Unix)
    .replace(/\/~?\/\.[^\s<>"]+/g, '[PATH]')
    // Email
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[EMAIL]')
    // Phone
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4,}\b/g, '[PHONE]')
    // API keys / tokens
    .replace(/\b(ghp_[a-zA-Z0-9]{36}|sk-[a-zA-Z0-9]{32,}|Bearer \S+|token["\s:=]+\S+)\b/gi, '[SECRET]')
    // Names in brackets (common sender format)
    .replace(/\[sender:[^\]]+\]/g, '[USER]')
    .replace(/\[agent:[^\]]+\]/g, '[AGENT]')
    .replace(/\[channel:[^\]]+\]/g, '[CHANNEL]')
    // Excessive whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stage 2: LLM-powered generalization
 * Takes a sanitized text and returns a generalized pattern + redact sensitive specifics
 *
 * @param {string} text - Stage-1 sanitized text
 * @param {string} intent - The detected user intent
 * @param {string} action - What the agent did
 * @param {object} llm - { complete(prompt): Promise<string> }
 * @returns {Promise<{pattern: string, guideline: string, placeholders: string[]}>}
 */
export async function generalizeWithLLM(text, intent, action, llm) {
  const prompt = `You are a privacy-filtering AI. Given a sanitized agent interaction, extract:
1. A behavioral PATTERN: a reusable rule like "When user asks to X, prefer Y approach"
2. A specific GUIDELINE: a concrete instruction the agent should follow next time

Rules:
- Replace ALL remaining sensitive values with [REDACTED_*] placeholders (e.g., [REDACTED_NAME], [REDACTED_PROJECT], [REDACTED_TOOL])
- Focus on the STRATEGY, not the specific details
- Output ONLY valid JSON: {"pattern": "...", "guideline": "...", "placeholders": ["..."]}
- Keep pattern under 100 chars, guideline under 200 chars

Input:
Intent: ${intent}
Agent action: ${action}
Sanitized transcript: ${text.slice(0, 800)}

Output JSON:`;

  try {
    const response = await llm.complete(prompt);
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        pattern: parsed.pattern || '',
        guideline: parsed.guideline || '',
        placeholders: parsed.placeholders || []
      };
    }
  } catch (e) {
    // LLM failed — return generic version
  }

  return {
    pattern: `When intent="${intent}", prefer: ${action.slice(0, 80)}`,
    guideline: action.slice(0, 200),
    placeholders: []
  };
}

/**
 * Lightweight intent detection from text
 * Uses keyword extraction (no LLM needed)
 */
export function detectIntent(text) {
  if (!text) return 'unknown';

  const lower = text.toLowerCase();

  const intentSignals = [
    { pattern: /build|create|make|new project|setup/i, intent: 'build_project' },
    { pattern: /fix|bug|error|crash|broken/i, intent: 'fix_issue' },
    { pattern: /research|look up|search|find.*info/i, intent: 'research' },
    { pattern: /deploy|publish|release|push to/i, intent: 'deploy' },
    { pattern: /test|run|execute|try/i, intent: 'test_run' },
    { pattern: /config|setup|configure|settings/i, intent: 'configure' },
    { pattern: /explain|what is|how does|tell me/i, intent: 'explain' },
    { pattern: /refactor|rewrite|clean|improve/i, intent: 'refactor' },
    { pattern: /debug|investigate|trace|diagnose/i, intent: 'debug' },
    { pattern: /review|check|validate|verify/i, intent: 'review' },
  ];

  for (const { pattern, intent } of intentSignals) {
    if (pattern.test(lower)) return intent;
  }

  return 'general';
}

/**
 * Categorize guideline into one of the known categories
 */
export function categorizeGuideline(text) {
  const lower = text.toLowerCase();
  if (/code|function|typescript|javascript|import|class/i.test(lower)) return 'coding';
  if (/test|assert|coverage|jest|vitest/i.test(lower)) return 'testing';
  if (/deploy|build|docker|kubernetes|ci\/cd/i.test(lower)) return 'devops';
  if (/design|ui|component|style|css/i.test(lower)) return 'design';
  if (/security|auth|permission|sanitize/i.test(lower)) return 'security';
  if (/api|endpoint|fetch|rest|graphql/i.test(lower)) return 'api';
  if (/git|commit|pull|branch/i.test(lower)) return 'git';
  if (/performance|speed|optimize|cache/i.test(lower)) return 'performance';
  return 'general';
}
