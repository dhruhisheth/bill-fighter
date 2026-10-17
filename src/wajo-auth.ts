import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// Wajo's Fo endpoint uses MCP OAuth (dynamic client registration + PKCE).
// We keep the registered client and tokens in a local, gitignored file so the
// browser sign-in only happens once.

const STORE = ".wajo-auth.json";
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;

type Store = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
};

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}

function save(patch: Partial<Store>) {
  fs.writeFileSync(STORE, JSON.stringify({ ...load(), ...patch }, null, 2), { mode: 0o600 });
}

export class WajoAuth implements OAuthClientProvider {
  get redirectUrl() {
    return REDIRECT;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Bill Fighter",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp",
    };
  }

  clientInformation() {
    return load().client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    save({ client });
  }
  tokens() {
    return load().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    save({ tokens });
  }
  saveCodeVerifier(verifier: string) {
    save({ verifier });
  }
  codeVerifier() {
    const { verifier } = load();
    if (!verifier) throw new Error("No PKCE verifier saved; run `npm run login` again");
    return verifier;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const store = load();
    if (scope === "all" || scope === "client") delete store.client;
    if (scope === "all" || scope === "tokens") delete store.tokens;
    if (scope === "all" || scope === "verifier") delete store.verifier;
    fs.writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  redirectToAuthorization(url: URL) {
    console.log(`\nSign in to Wajo in your browser. If it doesn't open, visit:\n${url}\n`);
    execFile("open", [url.toString()]);
  }
}

// Waits for Wajo to redirect the browser back with ?code=...
export function waitForAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(code ? "<p>Signed in to Wajo. You can close this tab.</p>" : `<p>Sign in failed: ${error}</p>`);
      server.close();
      if (code) resolve(code);
      else reject(new Error(`Wajo sign in failed: ${error}`));
    });
    server.listen(PORT);
  });
}
