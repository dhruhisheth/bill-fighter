// CLI: npm run fight -- <bill image or pdf> [--live] [--dry]
//   --dry   analyze only, no call
//   --live  call the number on the bill (default calls your own phone)
import fs from "node:fs";
import readline from "node:readline/promises";
import { config } from "./config.js";
import { analyzeBill, totals, type BillAnalysis } from "./analyze.js";
import { buildBrief, callTarget } from "./brief.js";
import { askFo, connectFo, watchCall } from "./fo.js";
import { readOutcome, type Outcome } from "./outcome.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const live = args.includes("--live");
const dry = args.includes("--dry");
if (!file) {
  console.error("Usage: npm run fight -- <bill.png|jpg|heic|pdf> [--live] [--dry]");
  process.exit(1);
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const log: Record<string, unknown> = { file, live };
const saveLog = () => fs.writeFileSync(`runs/${stamp}.json`, JSON.stringify(log, null, 2));

function printAnalysis(a: BillAnalysis) {
  const t = totals(a);
  console.log(`\n${a.provider}: ${a.summary}\n`);
  for (const i of a.issues) {
    const save = [i.monthlySavings && `${usd(i.monthlySavings)}/mo`, i.oneTimeSavings && `${usd(i.oneTimeSavings)} once`]
      .filter(Boolean)
      .join(" + ");
    console.log(`  • ${i.title}${save ? `  (${save})` : ""}  [${i.confidence}]`);
  }
  console.log(`\nPotential: ${usd(t.monthly)}/mo + ${usd(t.oneTime)} back\n`);
}

function printOutcome(o: Outcome) {
  console.log(`\n${o.summary}`);
  for (const w of o.wins) console.log(`  ✓ ${w}`);
  for (const m of o.misses) console.log(`  ✗ ${m}`);
  if (o.reference) console.log(`  Reference: ${o.reference}`);
  if (o.monthlySaved || o.oneTimeSaved) {
    console.log(`\n  Fo saved you ${usd(o.monthlySaved)} a month${o.oneTimeSaved ? ` + ${usd(o.oneTimeSaved)} back` : ""}.\n`);
  }
}

console.log(`Reading ${file}...`);
const analysis = await analyzeBill(file);
log.analysis = analysis;
saveLog();
printAnalysis(analysis);
if (dry) process.exit(0);

const customer = { name: config.customerName(), phone: config.customerPhone() };
const target = callTarget(analysis, customer, live);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const go = await rl.question(
  `Have Fo call ${target}${live ? ` (${analysis.provider}, LIVE)` : " (your phone, rehearsal)"}? [y/N] `,
);
if (go.trim().toLowerCase() !== "y") process.exit(0);

const fo = await connectFo();
const onProgress = (t: { progress?: string; elapsedSeconds?: number }) =>
  console.log(`  Fo (${t.elapsedSeconds ?? 0}s): ${t.progress ?? "working..."}`);

const startedAt = new Date();
let turn = await askFo(fo, buildBrief(analysis, customer, live), { newConversation: true, onProgress });
log.turns = [turn];
let report = turn.response;
let outcome = await readOutcome(analysis, report);

while (turn.status === "complete") {
  if (outcome.status === "calling") {
    // Fo's turn ends once it dials; follow the call and wait for its summary.
    console.log("\n  Fo is on the call:");
    report = await watchCall(fo, turn.conversationId, {
      callSince: new Date(startedAt.getTime() - 60_000),
      onLine: (who, text) => console.log(`    ${who === "fo" ? "Fo " : "Rep"}: ${text}`),
    });
    outcome = await readOutcome(analysis, report);
  } else if (outcome.status === "needs_input") {
    // Fo sometimes asks before acting; relay its question and keep going.
    const answer = await rl.question(`\nFo asks: ${outcome.question ?? report}\n> `);
    turn = await askFo(fo, answer, { conversationId: turn.conversationId, onProgress });
    (log.turns as unknown[]).push(turn);
    report = turn.response;
    outcome = await readOutcome(analysis, report);
  } else {
    break;
  }
}

log.report = report;
log.outcome = outcome;
saveLog();
if (turn.status === "failed") console.log(`\nFo couldn't finish: ${turn.response}`);
printOutcome(outcome);
rl.close();
await fo.close();
