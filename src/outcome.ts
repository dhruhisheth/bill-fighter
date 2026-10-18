import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { BillAnalysis } from "./analyze.js";
import { claude, requestDefaults } from "./claude.js";
import { traced } from "./trace.js";

export const Outcome = z.object({
  status: z
    .enum(["won", "partial", "refused", "failed", "calling", "needs_input"])
    .describe(
      "calling: the call has started or is about to and the result will come later. needs_input: Fo cannot go ahead without the user's answer and has no call result yet",
    ),
  question: z.string().nullable().describe("Fo's question to the user when status is needs_input"),
  monthlySaved: z.number().describe("Confirmed monthly savings in USD, 0 if none"),
  oneTimeSaved: z.number().describe("Confirmed one time credits or refunds in USD, 0 if none"),
  newMonthlyPrice: z.number().nullable(),
  reference: z.string().nullable(),
  wins: z.array(z.string()).describe("Each thing the rep agreed to, short"),
  misses: z.array(z.string()).describe("Each ask that was refused, short"),
  summary: z.string().describe("One or two sentences for the user"),
});

export type Outcome = z.infer<typeof Outcome>;

// Turns Fo's free text report into numbers we can put on screen. Only counts
// savings Fo says the rep confirmed, never the estimates from the analysis.
export async function readOutcome(analysis: BillAnalysis, foReply: string): Promise<Outcome> {
  const input = { model: requestDefaults.model, effort: "low", foReport: foReply };
  const response = await traced("claude", "messages.parse (read Fo's report)", input, () => claude.beta.messages.parse({
    ...requestDefaults,
    output_config: { effort: "low", format: zodOutputFormat(Outcome) },
    max_tokens: 4000,
    system:
      "You read an AI assistant's message about a call it is making to a company about a bill, and extract what was actually confirmed. Count only savings the message says the company agreed to. If it says it is dialing or on the call and will report back, use calling. If it reports how a call went, classify the result (won, partial, refused, failed) even if it ends by offering to call again. Use needs_input only when it cannot proceed without the user's answer and no call has happened.",
    messages: [
      {
        role: "user",
        content: `What we asked for:\n${JSON.stringify(analysis.issues, null, 2)}\n\nThe assistant's report:\n${foReply}`,
      },
    ],
  }), (r) => ({ stop_reason: r.stop_reason, usage: { input: r.usage.input_tokens, output: r.usage.output_tokens }, parsed: r.parsed_output }));
  if (!response.parsed_output) throw new Error(`Could not read Fo's result (stop: ${response.stop_reason})`);
  return response.parsed_output;
}
