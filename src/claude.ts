import Anthropic from "@anthropic-ai/sdk";

// Reads ANTHROPIC_API_KEY from the environment (loaded from .env by config.ts).
export const claude = new Anthropic();

// Shared request settings. `fallbacks: "default"` reruns a request on another
// model server side if a safety classifier declines it, instead of failing.
export const MODEL = "claude-opus-5-5";
export const requestDefaults = {
  model: MODEL,
  betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[],
  fallbacks: "default" as const,
  output_config: { effort: "medium" as const },
};
