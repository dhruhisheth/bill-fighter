import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { claude, requestDefaults } from "./claude.js";
import { traced } from "./trace.js";

export const Issue = z.object({
  kind: z.enum([
    "expired_promo",
    "price_increase",
    "duplicate_charge",
    "fee",
    "unused_service",
    "equipment_rental",
    "late_fee",
    "cancellation",
    "billing_error",
    "other",
  ]),
  title: z.string().describe("Short, plain English, e.g. 'Promo rate ended'"),
  evidence: z.string().describe("The exact line or text on the bill this is based on"),
  ask: z.string().describe("What to ask the rep for, in one sentence"),
  monthlySavings: z.number().describe("Realistic monthly savings in USD if the ask succeeds, 0 if none"),
  oneTimeSavings: z.number().describe("Realistic one time refund or credit in USD, 0 if none"),
  confidence: z.enum(["high", "medium", "low"]),
});

export const BillAnalysis = z.object({
  provider: z.string(),
  providerPhone: z.string().nullable().describe("Customer service number printed on the bill, null if absent"),
  accountNumber: z.string().nullable(),
  accountHolder: z.string().nullable(),
  serviceAddress: z.string().nullable().describe("Service or billing address printed on the bill, null if absent"),
  billDate: z.string().nullable(),
  totalDue: z.number(),
  monthlyRecurring: z.number().nullable().describe("Recurring monthly charges before one time items"),
  goal: z.enum(["negotiate", "cancel", "dispute"]),
  issues: z.array(Issue),
  script: z.object({
    opening: z.string().describe("First thing to say after identity verification"),
    asks: z.array(z.string()).describe("Asks in order, strongest first"),
    fallbackAsks: z.array(z.string()).describe("What to ask for if the main asks are refused"),
    leverage: z.array(z.string()).describe("Facts to mention: tenure, competitor prices, on time history"),
    doNotAgreeTo: z.array(z.string()),
    walkAway: z.string().describe("When to politely end the call"),
  }),
  summary: z.string().describe("One sentence for the user, e.g. 'Your promo ended and you are paying for a router you could own.'"),
});

export type BillAnalysis = z.infer<typeof BillAnalysis>;
export type Issue = z.infer<typeof Issue>;

const SYSTEM = `You audit household bills (internet, phone, utilities, gym, subscriptions, medical) and prepare the customer to get money back.

Read every line. Flag only things the bill itself supports, quote the line as evidence, and say what to ask for. Typical wins: an expired promo rate (ask for it back or a retention offer), equipment rental (ask to waive it or return it), add ons the customer may not use, late fees on a first or near miss late payment (ask for a one time courtesy waiver), paper statement fees (switch to paperless), duplicate charges (refund), annual or "enhancement" fees, and charges after a term ended or after the last visit.

Savings must be realistic, not best case. Retention discounts are usually 10 to 30 percent of the base rate. If something is uncertain, say so with low confidence instead of overstating it.

Never invent a phone number, account number or name. Use null when it is not printed on the bill.

The call script is for an AI assistant calling on the customer's behalf. Keep it polite, firm and short. It must never agree to a new contract, an upgrade, a price that is higher than today, or share payment card details. Don't set a minimum discount to hold out for: any discount without a contract is worth taking.`;

type Media =
  | { kind: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string }
  | { kind: "pdf"; data: string };

// iPhone photos are often HEIC, which Claude can't read; macOS `sips` converts them.
function loadMedia(file: string): Media {
  let ext = path.extname(file).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    const out = path.join(os.tmpdir(), `${path.basename(file, ext)}-${Date.now()}.jpg`);
    execFileSync("sips", ["-s", "format", "jpeg", file, "--out", out], { stdio: "ignore" });
    file = out;
    ext = ".jpg";
  }
  const data = fs.readFileSync(file).toString("base64");
  switch (ext) {
    case ".png":
      return { kind: "image", mediaType: "image/png", data };
    case ".jpg":
    case ".jpeg":
      return { kind: "image", mediaType: "image/jpeg", data };
    case ".webp":
      return { kind: "image", mediaType: "image/webp", data };
    case ".gif":
      return { kind: "image", mediaType: "image/gif", data };
    case ".pdf":
      return { kind: "pdf", data };
    default:
      throw new Error(`Unsupported bill file type: ${ext} (use a photo, screenshot or PDF)`);
  }
}

export function mediaBlock(media: Media): Anthropic.Beta.BetaContentBlockParam {
  return media.kind === "pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: media.data } }
    : { type: "image", source: { type: "base64", media_type: media.mediaType, data: media.data } };
}

export async function analyzeBill(file: string): Promise<BillAnalysis> {
  return analyzeMedia(loadMedia(file));
}

export async function analyzeMedia(media: Media): Promise<BillAnalysis> {
  const input = { model: requestDefaults.model, effort: "high", content: [`[bill ${media.kind}]`, "Audit this bill and prepare the call."] };
  const response = await traced("claude", "messages.parse (analyze bill)", input, () => claude.beta.messages.parse({
    ...requestDefaults,
    output_config: { effort: "high", format: zodOutputFormat(BillAnalysis) },
    max_tokens: 16000,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [mediaBlock(media), { type: "text", text: "Audit this bill and prepare the call." }],
      },
    ],
  }), (r) => ({
    stop_reason: r.stop_reason,
    usage: { input: r.usage.input_tokens, output: r.usage.output_tokens },
    provider: r.parsed_output?.provider,
    issues: r.parsed_output?.issues.map((i) => `${i.title} (${i.monthlySavings}/mo + ${i.oneTimeSavings} once, ${i.confidence})`),
  }));
  if (response.stop_reason === "refusal") throw new Error("Claude declined to analyze this bill");
  if (!response.parsed_output) throw new Error(`Could not parse the analysis (stop: ${response.stop_reason})`);
  return response.parsed_output;
}

export type { Media };

export function totals(a: BillAnalysis) {
  return {
    monthly: a.issues.reduce((sum, i) => sum + i.monthlySavings, 0),
    oneTime: a.issues.reduce((sum, i) => sum + i.oneTimeSavings, 0),
  };
}
