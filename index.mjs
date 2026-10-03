#!/usr/bin/env node
/**
 * peoplesearch-mcp — a local (stdio) Model Context Protocol server for PeopleSearch.im.
 *
 * A zero-dependency bridge: it speaks MCP over stdio to your client (Claude Desktop, Cursor, …) and
 * forwards each tool call to the PeopleSearch.im REST API using your API key, so an agent can search
 * people and companies, reveal profiles, and fetch verified professional emails, billed to your credits.
 *
 * There is nothing to build: `npx peoplesearch-mcp` runs this file directly on Node 18+ (global fetch).
 *
 * Config:
 *   PEOPLESEARCH_API_KEY   required. Your key (sk_sift_…) from https://peoplesearch.im/developers
 *   PEOPLESEARCH_BASE_URL  optional. Defaults to https://peoplesearch.im
 *
 * Most users of a REMOTE MCP client should instead point straight at https://peoplesearch.im/api/mcp
 * (see /developers). This package exists for stdio-only clients and for the Official MCP Registry.
 */

import { createInterface } from "node:readline";

const BASE = (process.env.PEOPLESEARCH_BASE_URL || "https://peoplesearch.im").replace(/\/+$/, "");
const API_KEY = process.env.PEOPLESEARCH_API_KEY || "";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const S = (props, required, additional = false) => ({ type: "object", properties: props, required, additionalProperties: additional });
const str = (description) => ({ type: "string", description });

/** Each tool maps its MCP arguments to a PeopleSearch.im REST call. */
const TOOLS = [
  { name: "people_search", title: "Search people",
    description: "Search a global professional database in plain English and get masked previews plus the true total. Free; spends no credits. Each result has a `token` for reveal_profile.",
    inputSchema: S({ query: str("Who you are looking for, in plain English."), limit: { type: "integer", minimum: 1, maximum: 25, description: "1-25, default 10." } }, ["query"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/search", body: { query: a.query, limit: a.limit } }) },
  { name: "reveal_profile", title: "Reveal a person",
    description: "Unlock one person from a people_search result by `token`. 1 credit. Set include_email to also fetch their verified work email (a second credit, refunded if none). Idempotent.",
    inputSchema: S({ token: str("A person's token from people_search."), include_email: { type: "boolean", description: "Also fetch the verified work email. Default false." } }, ["token"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/reveal", body: { token: a.token, withEmail: a.include_email === true } }) },
  { name: "find_people", title: "Find & unlock a batch of people",
    description: "Re-run a search and unlock up to `count` full profiles in one atomic charge (1 credit each; already-owned are free). Returns each person's id for fetch_email. Can spend up to `count` credits.",
    inputSchema: S({ query: str("Who you want, in plain English."), count: { type: "integer", minimum: 1, maximum: 100, description: "1-100, default 25." } }, ["query"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/deliver", body: { query: a.query, count: a.count || 25 } }) },
  { name: "fetch_email", title: "Fetch a verified work email",
    description: "Look up the verified professional email for a person id from find_people/reveal_profile. 1 credit, refunded if none is found. May return emailStatus 'searching'; call again (no extra charge) to collect it.",
    inputSchema: S({ profile_id: str("A person's id from find_people or reveal_profile.") }, ["profile_id"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/email", body: { id: a.profile_id } }) },
  { name: "verify_email", title: "Verify an email address",
    description: "Check whether an email exists and is safe to send to, without sending. 1 credit, refunded if no verdict.",
    inputSchema: S({ email: str("The email to verify.") }, ["email"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/tools", body: { tool: "email-verifier", input: { email: a.email } } }) },
  { name: "find_company_emails", title: "Find a company's emails",
    description: "Return role-based email addresses for a company domain or name. 2 credits, refunded if none found.",
    inputSchema: S({ domain_or_company: str("A company domain (preferred) or name.") }, ["domain_or_company"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/tools", body: { tool: "email-finder", input: { domainOrCompany: a.domain_or_company } } }) },
  { name: "reverse_email_lookup", title: "Reverse email lookup",
    description: "Turn a professional email into the person behind it and their LinkedIn profile. 13 credits (the most expensive lookup), refunded if no match.",
    inputSchema: S({ email: str("The email to identify.") }, ["email"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/tools", body: { tool: "reverse-email-lookup", input: { email: a.email } } }) },
  { name: "find_linkedin_profile", title: "Find a LinkedIn profile",
    description: "Find a person's LinkedIn URL from their name; add company/domain to disambiguate. 2 credits, refunded if no confident match.",
    inputSchema: S({ first_name: str("First name."), last_name: str("Last name."), company_or_domain: str("Optional company name or domain.") }, ["first_name", "last_name"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/tools", body: { tool: "linkedin-profile-finder", input: { firstname: a.first_name, lastname: a.last_name, companyOrDomain: a.company_or_domain || "" } } }) },
  { name: "lookup_linkedin_profile", title: "Look up a LinkedIn profile",
    description: "Turn a LinkedIn profile URL into structured data. 2 credits, refunded if it cannot be retrieved.",
    inputSchema: S({ linkedin_url: str("A LinkedIn profile URL.") }, ["linkedin_url"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/tools", body: { tool: "linkedin-profile-lookup", input: { url: a.linkedin_url } } }) },
  { name: "lookup_company", title: "Look up a company",
    description: "Turn a LinkedIn company URL into firmographic data. 1 credit, refunded if it cannot be retrieved.",
    inputSchema: S({ linkedin_company_url: str("A LinkedIn company URL.") }, ["linkedin_company_url"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/tools", body: { tool: "company-lookup", input: { url: a.linkedin_company_url } } }) },
  { name: "company_search", title: "Search companies",
    description: "Search a global company database in plain English. Free; spends no credits.",
    inputSchema: S({ query: str("The companies you want, in plain English.") }, ["query"]),
    rest: (a) => ({ method: "POST", path: "/api/v1/tools", body: { tool: "company-search", input: { query: a.query } } }) },
  { name: "check_credits", title: "Check credit balance",
    description: "Return the current credit balance for your API key. Free and read-only.",
    inputSchema: S({}, []),
    rest: () => ({ method: "GET", path: "/api/v1/credits" }) },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

async function callRest(tool, args) {
  if (!API_KEY) {
    return { content: [{ type: "text", text: "Set PEOPLESEARCH_API_KEY to your key from https://peoplesearch.im/developers." }], isError: true };
  }
  const { method, path, body } = tool.rest(args || {});
  let res, data;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    });
    data = await res.json();
  } catch (e) {
    return { content: [{ type: "text", text: `Request to PeopleSearch.im failed: ${e && e.message ? e.message : "network error"}.` }], isError: true };
  }
  const failed = !res.ok || (data && data.ok === false);
  const lead = failed
    ? (res.status === 401 ? "Unauthorized: check PEOPLESEARCH_API_KEY."
      : res.status === 402 ? "Out of credits: top up at https://peoplesearch.im/pricing."
      : (data && data.message) || `Request failed (HTTP ${res.status}).`)
    : `${tool.title} result:`;
  return {
    content: [{ type: "text", text: `${lead}\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data && typeof data === "object" ? data : undefined,
    isError: failed,
  };
}

async function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg && msg.id, -32600, "Invalid Request");
  const isNotification = msg.method.startsWith("notifications/") || !("id" in msg) || msg.id === undefined;
  if (isNotification) return null;
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const requested = params && params.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "peoplesearch.im", title: "PeopleSearch.im", version: "1.1.0" },
        instructions: "PeopleSearch.im people-data tools. Searching is free; reveals and lookups cost credits (most 1, refunded when nothing is found). Set PEOPLESEARCH_API_KEY from https://peoplesearch.im/developers.",
      });
    }
    case "ping": return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const name = params && params.name;
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name || "(none)"}`);
      return ok(id, await callRest(tool, params && params.arguments));
    }
    case "resources/list": return ok(id, { resources: [] });
    case "prompts/list": return ok(id, { prompts: [] });
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return send(rpcError(null, -32700, "Parse error")); }
  try {
    const res = await handle(msg);
    if (res) send(res);
  } catch (e) {
    send(rpcError(msg && msg.id, -32603, `Internal error: ${e && e.message ? e.message : "unknown"}`));
  }
});

process.stderr.write(`peoplesearch-mcp ready (base ${BASE}${API_KEY ? "" : ", no PEOPLESEARCH_API_KEY set"})\n`);
