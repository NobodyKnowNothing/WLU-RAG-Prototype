// Live check against a built index (not part of npm test): start `node src/cli.mjs serve`, then
// run `node test/live-agent.mjs`. Drives the three tools over MCP HTTP and MCP stdio like an agent.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

const QUESTIONS = [
  "What is the penalty for a first plagiarism offence?",
  "Can my professor ban laptops in class?",
  "How long does the university keep my personal health information?",
];

async function exercise(label, transport) {
  const client = new Client({ name: "check-agent", version: "1.0.0" });
  const t0 = Date.now();
  await client.connect(transport);
  console.log(`\n=== ${label}: connected in ${Date.now() - t0} ms; server ${JSON.stringify(client.getServerVersion())}`);
  console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
  for (const q of QUESTIONS) {
    const t = Date.now();
    const r = await client.callTool({ name: "search_policies", arguments: { query: q, k: 3 } });
    console.log(`\nQ: ${q}  (${Date.now() - t} ms)`);
    for (const h of r.structuredContent.results) console.log(`  - ${h.citation}\n    ${h.url}`);
  }
  const top = (await client.callTool({ name: "search_policies", arguments: { query: QUESTIONS[0], k: 1 } })).structuredContent.results[0];
  const sec = await client.callTool({ name: "get_policy_section", arguments: { id: top.id, around: 1 } });
  console.log(`\nget_policy_section(${top.id}):\n${sec.content[0].text.split("\n").filter((l) => /^(>> )?\S.* > /.test(l)).join("\n")}`);
  const list = await client.callTool({ name: "list_policies", arguments: { kinds: ["procedure"] } });
  console.log(`list_policies(procedure): ${list.structuredContent.pages.length} pages`);
  await client.close();
}

await exercise("MCP over HTTP", new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8790/mcp")));
await exercise("MCP over stdio", new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], stderr: "ignore" }));
