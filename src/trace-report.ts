// Writes a readable trace for one saved run: npm run trace -- [latest | runs/<file>.json]
import fs from "node:fs";
import path from "node:path";
import type { TraceEntry } from "./trace.js";

const arg = process.argv[2] ?? "latest";
const file =
  arg === "latest"
    ? path.join("runs", fs.readdirSync("runs").filter((f) => f.endsWith("-web.json")).sort().at(-1) ?? "")
    : arg;
const run = JSON.parse(fs.readFileSync(file, "utf8")) as {
  analysis: { provider: string };
  trace?: TraceEntry[];
  events: { type: string; outcome?: { status: string; monthlySaved: number; oneTimeSaved: number; summary: string } }[];
};
if (!run.trace?.length) throw new Error(`${file} has no trace (it was saved before tracing was added)`);

const show = (v: unknown, max = 1200) => {
  const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
};
const outcome = run.events.find((e) => e.type === "outcome")?.outcome;
const counts = run.trace.reduce<Record<string, number>>((acc, t) => ((acc[t.name] = (acc[t.name] ?? 0) + 1), acc), {});
const start = Date.parse(run.trace[0].at);
const end = Date.parse(run.trace.at(-1)!.at) + run.trace.at(-1)!.ms;

const lines = [
  `# Run trace: ${path.basename(file, ".json")}`,
  "",
  `Bill: ${run.analysis.provider} (fictional sample). Mode: rehearsal, Fo called my own phone and I played the rep.`,
  `Duration: ${Math.round((end - start) / 1000)}s. Tool calls: ${run.trace.length}.`,
  outcome ? `Outcome: ${outcome.status}, $${outcome.monthlySaved}/mo + $${outcome.oneTimeSaved} once. ${outcome.summary}` : "Outcome: none recorded",
  "",
  "## Calls by tool",
  "",
  ...Object.entries(counts).map(([name, n]) => `- ${name}: ${n}`),
  "",
  "## Timeline",
  "",
  "Repeated polls with no change (get_fo_reply while working, transcript and chat polls) are kept; each one is a real call.",
  "",
];
run.trace.forEach((t, i) => {
  const offset = ((Date.parse(t.at) - start) / 1000).toFixed(1);
  lines.push(`### ${i + 1}. +${offset}s  ${t.kind === "fo_mcp" ? "Fo MCP" : "Claude"}: ${t.name}  (${t.ms} ms)${t.error ? "  ERROR" : ""}`);
  lines.push("", "Input:", "```json", show(t.input), "```", "Output:", "```json", t.error ? t.error : show(t.output), "```", "");
});

const out = file.replace(/\.json$/, "-trace.md");
fs.writeFileSync(out, lines.join("\n"));
console.log(`Wrote ${out} (${run.trace.length} tool calls)`);
