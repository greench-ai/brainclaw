/**
 * Brainclaw GreenchClaw Plugin
 *
 * Hooks into:
 * - before_prompt_build: retrieve + inject relevant guidelines
 * - agent_end: record the experience, update Q-values
 * - message_received: track task context
 *
 * Communicates with the Brainclaw sidecar at sidecarUrl.
 */

import { definePluginEntry } from "GreenchClaw/plugin-sdk/plugin-entry";
import type { GreenchClawPluginApi } from "GreenchClaw/plugin-sdk/plugin-entry";

// ── Types ────────────────────────────────────────────────────────────────────

interface BrainclawConfig {
  enabled: boolean;
  sidecarUrl: string;
  agentId: string;
  learnMode: "all" | "tools_only" | "balanced";
  retrievalEnabled: boolean;
  recordEnabled: boolean;
  injectGuidelines: boolean;
  maxInjectChars: number;
}

// ── State ────────────────────────────────────────────────────────────────────

let config: BrainclawConfig = {
  enabled: true,
  sidecarUrl: "http://127.0.0.1:3002",
  agentId: "sasuke",
  learnMode: "balanced",
  retrievalEnabled: true,
  recordEnabled: true,
  injectGuidelines: true,
  maxInjectChars: 1500,
};

let currentTaskId: string | null = null;

// ── HTTP client (no external deps needed) ────────────────────────────────────

async function sidecarRequest(path: string, body: unknown): Promise<unknown> {
  try {
    const res = await fetch(`${config.sidecarUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: config.agentId, ...body }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn("[brainclaw] sidecar unreachable:", (e as Error).message);
    return null;
  }
}

// ── Plugin Entry ────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "brainclaw",
  name: "Brainclaw",
  description: "Self-evolving multi-agent episodic memory",

  register(api: GreenchClawPluginApi) {
    // Load config
    api.addEventListener("gateway_start", () => {
      // nothing needed
    });

    // ── Hook: before_prompt_build ──────────────────────────────────────────
    api.on(
      "before_prompt_build",
      async (event) => {
        if (!config.enabled || !config.retrievalEnabled) return;

        const ctx = event.context as { prompt?: string };
        if (!ctx?.prompt) return;

        // Retrieve relevant guidelines from sidecar
        const result = await sidecarRequest("/retrieve", {
          contextText: ctx.prompt.slice(0, 500),
        }) as { injectionText?: string; guidelines?: unknown[] } | null;

        if (!result?.injectionText) return;

        const injection = result.injectionText.slice(0, config.maxInjectChars);
        if (!injection) return;

        return {
          prependContext: injection,
        };
      },
      { priority: 30 }
    );

    // ── Hook: agent_end ─────────────────────────────────────────────────────
    api.on(
      "agent_end",
      async (event) => {
        if (!config.enabled || !config.recordEnabled) return;

        const ctx = event.context as {
          sessionKey?: string;
          runId?: string;
        };

        // Check learn mode
        const wasToolTurn = (event as unknown as { toolCalls?: unknown[] }).toolCalls?.length > 0;
        if (config.learnMode === "tools_only" && !wasToolTurn) return;
        if (config.learnMode === "balanced" && !wasToolTurn) {
          // balanced mode: skip non-tool turns unless explicitly rewarded
          return;
        }

        // Record experience
        const messages = (event as unknown as { messages?: Array<{role:string; content:string}> }).messages || [];
        const lastUser = messages.filter((m: {role:string}) => m.role === "user").pop()?.content?.slice(0, 300) || "";
        const lastAssistant = messages.filter((m: {role:string}) => m.role === "assistant").pop()?.content?.slice(0, 300) || "";

        await sidecarRequest("/experiences", {
          userMessage: lastUser,
          agentReply: lastAssistant,
          toolWasUsed: wasToolTurn,
        });
      },
      { priority: 10 }
    );

    // ── Hook: heartbeat_prompt_contribution ─────────────────────────────────
    api.on("heartbeat_prompt_contribution", async (event) => {
      if (!config.enabled || !config.retrievalEnabled) return;

      const ctx = event.context as { prompt?: string };
      if (!ctx?.prompt) return;

      const result = await sidecarRequest("/retrieve", {
        contextText: ctx.prompt.slice(0, 300),
      }) as { injectionText?: string } | null;

      if (!result?.injectionText) return;

      return {
        prependContext: result.injectionText.slice(0, 800),
      };
    });

    // ── Tool: brainclaw_status ─────────────────────────────────────────────
    api.registerTool({
      name: "brainclaw_status",
      description: "Check Brainclaw memory system status and stats",
      parameters: {} as unknown as Record<string, unknown>,
      async execute() {
        const stats = await sidecarRequest("/stats", {}) as { episodes?: number; guidelines?: number; avgQ?: number } | null;
        const guidelines = await sidecarRequest("/guidelines", { contextText: "" }) as unknown[] | null;
        return {
          content: [
            {
              type: "text" as const,
              text: stats
                ? `Brainclaw Status\nEpisodes: ${stats.episodes}\nActive Guidelines: ${stats.guidelines}\nAvg Q-value: ${stats.avgQ?.toFixed(3)}\nGuidelines: ${(guidelines || []).map((g: unknown) => (g as {guideline:string})?.guideline).join("\n")}`
                : "Brainclaw sidecar unreachable",
            },
          ],
        };
      },
    });

    // ── Tool: brainclaw_feedback ───────────────────────────────────────────
    api.registerTool({
      name: "brainclaw_feedback",
      description: "Give feedback to Brainclaw for the last experience (reward: -1 to 1, confidence: 0 to 1)",
      parameters: {
        type: "object" as const,
        properties: {
          reward: { type: "number" as const, description: "Reward: 1=great, 0=neutral, -1=wrong" },
          confidence: { type: "number" as const, description: "Confidence in feedback: 0-1" },
          note: { type: "string" as const, description: "Optional note explaining the feedback" },
        },
        required: ["reward"] as string[],
      },
      async execute(params: { reward: number; confidence?: number; note?: string }) {
        const result = await sidecarRequest("/feedback", {
          reward: params.reward,
          confidence: params.confidence ?? 0.8,
          note: params.note || "",
        }) as { learned?: boolean; reason?: string; pattern?: string };
        return {
          content: [
            {
              type: "text" as const,
              text: result?.learned
                ? `Learned: ${result.pattern || "new guideline synthesized"}`
                : `No learning: ${result?.reason || "below threshold"}`,
            },
          ],
        };
      },
    });

    // ── Tool: brainclaw_recall ─────────────────────────────────────────────
    api.registerTool({
      name: "brainclaw_recall",
      description: "Retrieve relevant memories and guidelines for a task",
      parameters: {
        type: "object" as const,
        properties: {
          context: { type: "string" as const, description: "What you're currently working on" },
        },
        required: ["context"] as string[],
      },
      async execute(params: { context: string }) {
        const result = await sidecarRequest("/retrieve", {
          contextText: params.context,
        }) as { injectionText?: string; guidelines?: unknown[]; episodes?: unknown[] } | null;
        if (!result) {
          return { content: [{ type: "text" as const, text: "Brainclaw sidecar unreachable" }] };
        }
        const lines = ["Retrieved Guidelines:"];
        for (const g of (result.guidelines || []).slice(0, 5) as Array<{guideline:string; category:string; confidence:number}>) {
          lines.push(`[${g.category}] ${g.guideline} (conf:${(g.confidence*100).toFixed(0)}%)`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") || "No relevant memories found." }] };
      },
    });

    // ── Tool: brainclaw_share ──────────────────────────────────────────────
    api.registerTool({
      name: "brainclaw_share",
      description: "Share a learned guideline with other agents via A2A",
      parameters: {
        type: "object" as const,
        properties: {
          pattern: { type: "string" as const, description: "When this pattern is detected" },
          guideline: { type: "string" as const, description: "The behavioral guideline to share" },
          category: { type: "string" as const, description: "Category: coding, testing, devops, etc." },
        },
        required: ["pattern", "guideline"] as string[],
      },
      async execute(params: { pattern: string; guideline: string; category?: string }) {
        await sidecarRequest("/shared", {
          pattern: params.pattern,
          guideline: params.guideline,
          category: params.category || "general",
          confidence: 0.7,
        });
        return { content: [{ type: "text" as const, text: "Shared with team via A2A." }] };
      },
    });

    console.log("[brainclaw] Brainclaw plugin registered");
    console.log(`[brainclaw] Sidecar: ${config.sidecarUrl}`);
    console.log(`[brainclaw] Agent ID: ${config.agentId}`);
  },
});
