// Read-only smoke test: confirms Claude and Fo both work.
// Run with `npm run check`. Nothing here asks Fo to do anything.
import "./config.js";
import { claude, requestDefaults } from "./claude.js";
import { connectFo, listConversations } from "./fo.js";

async function checkClaude() {
  const msg = await claude.beta.messages.create({
    ...requestDefaults,
    output_config: { effort: "low" },
    max_tokens: 256,
    messages: [{ role: "user", content: "Reply with the single word: ready" }],
  });
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  console.log(`Claude: ok (${msg.model}) -> ${text.trim()}`);
}

async function checkFo() {
  const client = await connectFo();
  const { tools } = await client.listTools();
  console.log(`Fo: ok, tools: ${tools.map((t) => t.name).join(", ")}`);
  const convos = await listConversations(client);
  console.log(`Fo: ${convos.length} past conversations visible`);
  await client.close();
}

for (const [name, run] of [["Claude", checkClaude], ["Fo", checkFo]] as const) {
  try {
    await run();
  } catch (err) {
    console.error(`${name}: FAILED -> ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
