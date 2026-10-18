import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "./config.js";
import { traced } from "./trace.js";
import { WajoAuth, waitForAuthCode } from "./wajo-auth.js";

// Client for Fo's MCP profile (https://mcp.api.wajo.ai/fo).
// ask_fo sends a request; long turns return status "working" and we keep
// calling get_fo_reply (each call waits up to 40s) until complete or failed.

export type FoTurn = {
  status: "complete" | "working" | "failed";
  response: string;
  conversationId: string;
  progress?: string;
  elapsedSeconds?: number;
};

export async function connectFo(): Promise<Client> {
  const provider = new WajoAuth();
  const url = new URL(config.foUrl);
  // Wajo answers initialize and tools/list without a token, so the SDK would
  // never prompt on its own. Sign in up front if we have no saved tokens;
  // after that the transport refreshes them on 401 by itself.
  if (!provider.tokens()) {
    const result = await auth(provider, { serverUrl: url });
    if (result === "REDIRECT") {
      await auth(provider, { serverUrl: url, authorizationCode: await waitForAuthCode() });
    }
  }
  const client = new Client({ name: "bill-fighter", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  return client;
}

// Big transcripts are summarized in the trace so it stays readable.
function summarize(name: string, out: unknown): unknown {
  const o = out as { turns?: FoLine[]; conversations?: FoConversation[] } | undefined;
  if (name === "get_fo_conversation" && o?.turns) {
    const last = o.turns.at(-1);
    return { turns: o.turns.length, last: last && { role: last.role, at: last.at, text: last.text.slice(0, 200) } };
  }
  if (name === "list_fo_conversations" && o?.conversations) {
    return { conversations: o.conversations.length, newest: o.conversations.slice(0, 2) };
  }
  return out;
}

function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  return traced("fo_mcp", name, args, () => rawCall<T>(client, name, args), (out) => summarize(name, out));
}

async function rawCall<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = (result.content as { type: string; text?: string }[])
      .map((c) => c.text ?? "")
      .join("\n");
    throw new Error(`${name} failed: ${text}`);
  }
  return result.structuredContent as T;
}

// Sends one request to Fo and waits for the turn to settle. A "complete" reply
// may be a question back to the user (Fo asks before committing to things);
// answer it with another askFo on the same conversationId.
export async function askFo(
  client: Client,
  message: string,
  opts: { conversationId?: string; newConversation?: boolean; onProgress?: (turn: FoTurn) => void } = {},
): Promise<FoTurn> {
  const args: Record<string, unknown> = { message };
  if (opts.conversationId) args.conversationId = opts.conversationId;
  else if (opts.newConversation) args.newConversation = true;

  let turn = await call<FoTurn>(client, "ask_fo", args);
  while (turn.status === "working") {
    opts.onProgress?.(turn);
    turn = await call<FoTurn>(client, "get_fo_reply", {
      conversationId: turn.conversationId,
      waitSeconds: 40,
    });
  }
  return turn;
}

export type FoConversation = { conversationId: string; title: string; channel: string; startedAt?: string };
export type FoLine = { role: "user" | "assistant"; text: string; at?: string; runId?: string };

export async function listConversations(client: Client) {
  const out = await call<{ conversations?: FoConversation[] }>(client, "list_fo_conversations", {});
  return out.conversations ?? [];
}

export async function getTurns(client: Client, conversationId: string): Promise<FoLine[]> {
  const out = await call<{ turns?: FoLine[] }>(client, "get_fo_conversation", { conversationId });
  return out.turns ?? [];
}

// A phone call runs as its own "voice" conversation, started after `since`.
export async function findVoiceCall(client: Client, since: Date): Promise<FoConversation | undefined> {
  const convos = await listConversations(client);
  return convos.find((c) => c.channel === "voice" && c.startedAt && new Date(c.startedAt) >= since);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAfter = (line: FoLine, since: number) => (line.at ? Date.parse(line.at) > since : false);

// Fo's chat turn ends once it dials; the call runs as a separate voice
// conversation and Fo posts its summary back to the chat after hanging up.
// This streams the call transcript through onLine and returns that summary.
export async function watchCall(
  client: Client,
  chatId: string,
  opts: { callSince: Date; onLine: (who: "fo" | "rep", text: string) => void; timeoutMs?: number },
): Promise<string> {
  const chatSince = Date.now() - 5_000;
  let voiceId: string | undefined;
  let lastLine = 0;

  const flushTranscript = async () => {
    voiceId ??= (await findVoiceCall(client, opts.callSince))?.conversationId;
    if (!voiceId) return;
    for (const line of await getTurns(client, voiceId)) {
      if (!isAfter(line, lastLine)) continue;
      lastLine = Date.parse(line.at!);
      opts.onLine(line.role === "assistant" ? "fo" : "rep", line.text);
    }
  };

  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60_000);
  while (Date.now() < deadline) {
    await sleep(3_000);
    await flushTranscript();
    const fresh = (await getTurns(client, chatId)).filter((t) => t.role === "assistant" && isAfter(t, chatSince));
    if (fresh.length) {
      await flushTranscript();
      return fresh.map((t) => t.text).join("\n\n");
    }
  }
  throw new Error("Fo is still on it. Its summary will show up in the Wajo app.");
}
