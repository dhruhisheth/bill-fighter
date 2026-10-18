import { AsyncLocalStorage } from "node:async_hooks";

// Records every tool call one run makes (Fo MCP tools and Claude requests) so
// a run can be shown as a trace. AsyncLocalStorage keeps concurrent runs apart.

export type TraceEntry = {
  at: string;
  ms: number;
  kind: "fo_mcp" | "claude";
  name: string;
  input: unknown;
  output: unknown;
  error?: string;
};

const store = new AsyncLocalStorage<TraceEntry[]>();
const secrets: string[] = [];

// Anything registered here (e.g. the customer's phone) is masked in the trace.
export function maskInTrace(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 7) secrets.push(digits);
}

function scrub(value: unknown): unknown {
  let text = JSON.stringify(value ?? null);
  for (const digits of secrets) {
    // Match the number with or without separators between digits.
    const pattern = new RegExp(digits.split("").join("\\D?"), "g");
    text = text.replace(pattern, `•••${digits.slice(-4)}`);
  }
  return JSON.parse(text);
}

export function withTrace<T>(entries: TraceEntry[], fn: () => Promise<T>): Promise<T> {
  return store.run(entries, fn);
}

export async function traced<T>(
  kind: TraceEntry["kind"],
  name: string,
  input: unknown,
  run: () => Promise<T>,
  summarize: (out: T) => unknown = (out) => out,
): Promise<T> {
  const entries = store.getStore();
  const started = Date.now();
  try {
    const out = await run();
    entries?.push({ at: new Date(started).toISOString(), ms: Date.now() - started, kind, name, input: scrub(input), output: scrub(summarize(out)) });
    return out;
  } catch (err) {
    entries?.push({ at: new Date(started).toISOString(), ms: Date.now() - started, kind, name, input: scrub(input), output: null, error: (err as Error).message });
    throw err;
  }
}
