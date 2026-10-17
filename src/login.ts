// One time Wajo sign in. Opens your browser, saves tokens to .wajo-auth.json.
import { connectFo, listConversations } from "./fo.js";

const client = await connectFo();
const { tools } = await client.listTools();
const convos = await listConversations(client);
console.log(`Signed in. Fo tools: ${tools.map((t) => t.name).join(", ")}; ${convos.length} past conversations`);
await client.close();
