// The index as tools for an agent: three tool definitions and a Model Context Protocol (MCP)
// handler for them. The handler is plain JSON-RPC with no dependencies, so the same code serves
// MCP over stdio (local agents), over HTTP from the Node server, and from the Cloudflare Worker
// (stateless Streamable HTTP: every POST gets its JSON-RPC response as application/json).
import { catalog, getSection, KINDS, renderResults, search } from "./search.mjs";
import { authorityLabel } from "./cite.mjs";

export const SERVER_INFO = { name: "wlu-policy-index", title: "Laurier policy index", version: "1.0.0" };
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Searches every Wilfrid Laurier University policy and procedure (the governance policy register on wlu.ca) and the Undergraduate Academic Calendar and student pages the PC141 assistant uses. Each result is one section of a page, with a citation such as "12.2 Student Code of Conduct: Academic Misconduct > 4.04 Penalties for Academic Misconduct, 4.04.01" and a URL that opens the page at that section. Cite the section, not just the page, and quote its text exactly. University policies and the Academic Calendar are the rules; guidance pages explain them. Pages are re-checked weekly, so check "revised" and "fetched_at" for currency.`;

export const TOOLS = [
  {
    name: "search_policies",
    title: "Search Laurier policies",
    description: "Find the sections of official Laurier policies, procedures, the Academic Calendar and student guidance pages that answer a question. Returns up to k sections, best first, each with a citation, a deep link, the page's authority and revision date, and the section text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question or topic, in the student's words (e.g. \"penalty for a first plagiarism offence\")." },
        k: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "How many sections to return." },
        kinds: { type: "array", items: { type: "string", enum: KINDS }, description: "Only these kinds of page: policy, procedure, other (governance documents such as by-laws), calendar, guidance." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_policy_section",
    title: "Read a policy section in context",
    description: "Return a section found by search_policies together with the sections just before and after it on the same page, for reading a rule in full before citing it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The section id from search_policies." },
        around: { type: "integer", minimum: 0, maximum: 5, default: 1, description: "Neighbouring sections to include on each side." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_policies",
    title: "List indexed Laurier pages",
    description: "List every indexed page (policy number, title, URL, kind, last revision), optionally only some kinds.",
    inputSchema: {
      type: "object",
      properties: { kinds: { type: "array", items: { type: "string", enum: KINDS } } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

class ToolError extends Error {}

// -> { text, structured } for one tool call. Throws ToolError for bad arguments.
export async function callTool(adapter, name, args = {}) {
  if (name === "search_policies") {
    const query = String(args.query || "").trim();
    if (!query || query.length > 500) throw new ToolError("query must be a non-empty string under 500 characters");
    const k = Math.max(1, Math.min(10, Number(args.k) || 5));
    const r = await search(adapter, query, { k, kinds: args.kinds });
    return { text: renderResults(r), structured: { query, results: r.results } };
  }
  if (name === "get_policy_section") {
    const s = await getSection(adapter, String(args.id || ""), args.around ?? 1);
    if (!s) throw new ToolError(`no section with id "${args.id}"`);
    const head = `${s.title} (${s.publisher}; ${authorityLabel(s.authority)}${s.revised ? `, last revised ${s.revised}` : ""})\n${s.page_url}`;
    const body = s.chunks.map((c) => `${c.requested ? ">> " : ""}${c.citation}\nURL: ${c.url}\nid: ${c.id}\n${c.text}`).join("\n\n");
    return { text: `${head}\n\n${body}`, structured: s };
  }
  if (name === "list_policies") {
    const pages = await catalog(adapter, args.kinds);
    return { text: pages.map((p) => `${p.kind}\t${p.title}\t${p.revised || "-"}\t${p.url}`).join("\n"), structured: { pages } };
  }
  throw new ToolError(`unknown tool "${name}"`);
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

// One JSON-RPC message (or a batch) in, the response(s) out; null when there is nothing to send
// back (notifications).
export async function handleMcp(adapter, message) {
  if (Array.isArray(message)) {
    const out = (await Promise.all(message.map((m) => handleMcp(adapter, m)))).filter(Boolean);
    return out.length ? out : null;
  }
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return message && "result" in message ? null : rpcError(message?.id, -32600, "Invalid Request");
  }
  const { id, method, params = {} } = message;
  if (id === undefined) return null; // notification (notifications/initialized, cancelled, ...)
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      try {
        const { text, structured } = await callTool(adapter, params.name, params.arguments || {});
        return ok({ content: [{ type: "text", text }], structuredContent: structured, isError: false });
      } catch (e) {
        if (e instanceof ToolError) return ok({ content: [{ type: "text", text: e.message }], isError: true });
        return ok({ content: [{ type: "text", text: `search failed: ${e.message || e}` }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// MCP's Streamable HTTP transport, stateless: POST a JSON-RPC body, get JSON back (202 when the
// body held only notifications). There is no server-to-client stream, so GET is not allowed.
export async function mcpHttp(adapter, method, bodyText) {
  if (method !== "POST") return { status: 405, headers: { Allow: "POST" }, body: { error: "MCP endpoint: POST JSON-RPC messages here" } };
  let msg;
  try {
    msg = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: rpcError(null, -32700, "Parse error") };
  }
  const out = await handleMcp(adapter, msg);
  return out ? { status: 200, body: out } : { status: 202, body: null };
}
