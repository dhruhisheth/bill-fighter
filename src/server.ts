// Web app: npm run dev, then open http://localhost:3000
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { config } from "./config.js";
import { analyzeBill, BillAnalysis } from "./analyze.js";
import { buildBrief, callTarget } from "./brief.js";
import { askFo, connectFo, watchCall, type FoTurn } from "./fo.js";
import { readOutcome } from "./outcome.js";
import { maskInTrace, withTrace, type TraceEntry } from "./trace.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = path.resolve("public");
const SAMPLES = path.resolve("samples");

type JobEvent = { at?: number } & (
  | { type: "progress"; text: string; elapsed: number }
  | { type: "line"; who: "fo" | "rep"; text: string }
  | { type: "question"; text: string }
  | { type: "outcome"; outcome: unknown }
  | { type: "error"; text: string }
);

type Job = {
  analysis: BillAnalysis;
  trace: TraceEntry[];
  sample?: string;
  events: JobEvent[];
  listeners: Set<http.ServerResponse>;
  conversationId?: string;
  busy: boolean;
  startedAt: number;
};

const jobs = new Map<string, Job>();
const analyzeTraces = new Map<string, TraceEntry[]>();
try {
  maskInTrace(config.customerPhone());
} catch {}
let foClient: Promise<Client> | undefined;
const fo = () => (foClient ??= connectFo());

function emit(job: Job, event: JobEvent) {
  event.at = Date.now();
  job.events.push(event);
  if (event.type === "outcome" || event.type === "error") saveRun(job);
  for (const res of job.listeners) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// Every finished run is saved to runs/ so it can be replayed (/?replay=latest)
// for demo recordings without placing another call.
function saveRun(job: Job) {
  const file = `runs/${new Date(job.startedAt).toISOString().replace(/[:.]/g, "-")}-web.json`;
  fs.writeFileSync(file, JSON.stringify({ sample: job.sample, analysis: job.analysis, events: job.events, trace: job.trace }, null, 2));
}

// Runs one Fo turn, then decides whether Fo is asking us something or is done.
function runTurn(job: Job, message: string, first: boolean) {
  return withTrace(job.trace, () => runTurnTraced(job, message, first));
}

async function runTurnTraced(job: Job, message: string, first: boolean) {
  job.busy = true;
  try {
    const client = await fo();
    const onProgress = (t: FoTurn) =>
      emit(job, { type: "progress", text: t.progress ?? "Working on it", elapsed: t.elapsedSeconds ?? 0 });
    emit(job, { type: "progress", text: first ? "Briefing Fo" : "Sending your answer to Fo", elapsed: 0 });
    const turn = await askFo(client, message, {
      ...(job.conversationId ? { conversationId: job.conversationId } : { newConversation: first }),
      onProgress,
    });
    job.conversationId = turn.conversationId;
    if (turn.status === "failed") {
      emit(job, { type: "error", text: turn.response || "Fo couldn't finish this one." });
      return;
    }
    let report = turn.response;
    let outcome = await readOutcome(job.analysis, report);
    // Fo's turn ends once it dials; the call and its summary arrive afterwards.
    while (outcome.status === "calling") {
      emit(job, { type: "progress", text: "Fo is on the call", elapsed: 0 });
      report = await watchCall(client, turn.conversationId, {
        callSince: new Date(job.startedAt - 60_000),
        onLine: (who, text) => emit(job, { type: "line", who, text }),
      });
      emit(job, { type: "progress", text: "Reading Fo's report", elapsed: 0 });
      outcome = await readOutcome(job.analysis, report);
    }
    if (outcome.status === "needs_input") emit(job, { type: "question", text: outcome.question ?? report });
    else emit(job, { type: "outcome", outcome: { ...outcome, foReply: report } });
  } catch (err) {
    emit(job, { type: "error", text: (err as Error).message });
  } finally {
    job.busy = false;
  }
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".js": "text/javascript",
  ".css": "text/css",
};

function serveFile(res: http.ServerResponse, root: string, rel: string) {
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") return serveFile(res, PUBLIC, "index.html");
    if (req.method === "GET" && url.pathname.startsWith("/samples/"))
      return serveFile(res, SAMPLES, url.pathname.slice("/samples/".length));

    // Replays a saved run: /api/runs/latest or /api/runs/<file name without .json>
    const runMatch = url.pathname.match(/^\/api\/runs\/([\w.-]+)$/);
    if (req.method === "GET" && runMatch) {
      const saved = fs.readdirSync("runs").filter((f) => f.endsWith("-web.json")).sort();
      const name = runMatch[1] === "latest" ? saved.at(-1) : `${runMatch[1]}.json`;
      if (!name || !saved.includes(name)) return send(res, 404, { error: "No saved run with that name" });
      return send(res, 200, JSON.parse(fs.readFileSync(path.join("runs", name), "utf8")));
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return send(res, 200, { customerPhone: config.customerPhone() });
    }

    // Body: { name, data } where data is base64 file contents, or { sample: "internet-bill.png" }.
    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const body = await readJson<{ name?: string; data?: string; sample?: string }>(req);
      let file: string;
      if (body.sample) {
        file = path.join(SAMPLES, path.basename(body.sample));
      } else if (body.name && body.data) {
        file = path.join(os.tmpdir(), `bill-${randomUUID()}${path.extname(body.name).toLowerCase()}`);
        fs.writeFileSync(file, Buffer.from(body.data, "base64"));
      } else {
        return send(res, 400, { error: "Send a bill file or pick a sample" });
      }
      const trace: TraceEntry[] = [];
      const analysis = await withTrace(trace, () => analyzeBill(file));
      const traceId = randomUUID();
      analyzeTraces.set(traceId, trace);
      return send(res, 200, { ...analysis, traceId });
    }

    if (req.method === "POST" && url.pathname === "/api/fight") {
      const body = await readJson<{ analysis: { traceId?: string }; live?: boolean; sample?: string }>(req);
      const analysis = BillAnalysis.parse(body.analysis);
      const customer = { name: config.customerName(), phone: config.customerPhone() };
      const live = body.live === true;
      const id = randomUUID();
      const job: Job = {
        analysis,
        trace: [...(analyzeTraces.get(body.analysis.traceId ?? "") ?? [])],
        sample: body.sample ? path.basename(body.sample) : undefined,
        events: [],
        listeners: new Set(),
        busy: false,
        startedAt: Date.now(),
      };
      jobs.set(id, job);
      void runTurn(job, buildBrief(analysis, customer, live), true);
      return send(res, 200, { id, target: callTarget(analysis, customer, live) });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/(events|reply)$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return send(res, 404, { error: "unknown job" });

      if (req.method === "GET" && jobMatch[2] === "events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        job.listeners.add(res);
        req.on("close", () => job.listeners.delete(res));
        return;
      }
      if (req.method === "POST" && jobMatch[2] === "reply") {
        if (job.busy) return send(res, 409, { error: "Fo is still working" });
        const { text } = await readJson<{ text: string }>(req);
        void runTurn(job, text, false);
        return send(res, 200, { ok: true });
      }
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, () => console.log(`Bill Fighter on http://localhost:${PORT}`));
