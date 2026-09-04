#!/usr/bin/env node
/**
 * FlagForge MCP server — exposes the FlagForge REST API as MCP tools so an
 * AI agent can work CTF challenges through the knowledge base.
 *
 * Config (env):
 *   FLAGFORGE_BASE_URL  e.g. http://localhost:3100 (required)
 *   FLAGFORGE_TOKEN     Bearer token of the agent principal (required)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.FLAGFORGE_BASE_URL;
const TOKEN = process.env.FLAGFORGE_TOKEN;

if (!BASE_URL || !TOKEN) {
  console.error(
    "FlagForge MCP requires FLAGFORGE_BASE_URL and FLAGFORGE_TOKEN env vars"
  );
  process.exit(1);
}

const API = `${BASE_URL.replace(/\/$/, "")}/api/v1`;

async function call(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as Record<string, unknown>).error)
        : text;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return data;
}

const server = new McpServer(
  { name: "flagforge", version: "0.1.0" },
  {
    instructions:
      "FlagForge is a private CTF knowledge base. Use search_knowledge to find solutions to similar past challenges before starting a new one. During a live event: list_challenges → get_challenge → claim_challenge, record progress with save_evidence, submit flag candidates with submit_flag_candidate. Never log or echo full flag values in writeups — the vault stores them encrypted.",
  }
);

// ---------- Events ----------

server.tool(
  "list_events",
  "List CTF events with challenge/solved counts",
  {},
  async () => ({ content: [{ type: "text", text: JSON.stringify(await call("GET", "/events"), null, 1) }] })
);

server.tool(
  "create_event",
  "Create a new CTF event (requires admin role)",
  {
    name: z.string().min(1).max(200),
    slug: z.string().min(3).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase slug"),
    platform_type: z.enum(["ctfd", "custom", "manual"]),
    organizer: z.string().max(200).optional(),
    description: z.string().optional(),
    flag_pattern: z.string().max(200).optional(),
    status: z.enum(["draft", "mockup", "live", "ended", "archived"]).optional(),
  },
  async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await call("POST", "/events", input), null, 1) }],
  })
);

// ---------- Challenges ----------

server.tool(
  "list_challenges",
  "List challenges in an event (by event id or slug)",
  {
    event: z.string().describe("Event UUID or slug"),
    category: z.string().optional(),
    status: z.string().optional(),
  },
  async ({ event, category, status }) => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (status) params.set("status", status);
    const qs = params.toString();
    const data = await call("GET", `/events/${event}/challenges${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
  }
);

server.tool(
  "get_challenge",
  "Get one challenge's summary: description, status, tags, flag status, lock owner",
  { challenge_id: z.string().uuid() },
  async ({ challenge_id }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("GET", `/challenges/${challenge_id}`), null, 1) }],
  })
);

server.tool(
  "create_challenge",
  "Create (write) a new challenge in an event — for manual entry, mockups, or archiving self-made challenges",
  {
    event: z.string().describe("Event UUID or slug"),
    title: z.string().min(1).max(300),
    category: z.string().min(1).max(64),
    points: z.number().int().min(0).default(0),
    description_markdown: z.string().optional().describe("Challenge description (markdown)"),
    connection_info: z.string().optional().describe("e.g. nc host 1337 or URL"),
    tags: z.array(z.string().max(64)).default([]),
    external_id: z.string().max(128).optional().describe("ID on the source platform, e.g. CTFd challenge id"),
  },
  async ({ event, ...rest }) => {
    const body: Record<string, unknown> = {
      ...rest,
      slug: rest.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120),
    };
    const data = await call("POST", `/events/${event}/challenges`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
  }
);

server.tool(
  "update_challenge",
  "Update an existing challenge's fields (title, description, points, tags...)",
  {
    challenge_id: z.string().uuid(),
    title: z.string().min(1).max(300).optional(),
    category: z.string().min(1).max(64).optional(),
    points: z.number().int().min(0).optional(),
    description_markdown: z.string().optional(),
    connection_info: z.string().optional(),
    tags: z.array(z.string().max(64)).optional(),
  },
  async ({ challenge_id, ...body }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("PATCH", `/challenges/${challenge_id}`, body), null, 1) }],
  })
);

server.tool(
  "delete_challenge",
  "Delete a challenge and its evidence/flags/artifacts (admin only, cascades)",
  { challenge_id: z.string().uuid() },
  async ({ challenge_id }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("DELETE", `/challenges/${challenge_id}`), null, 1) }],
  })
);

server.tool(
  "claim_challenge",
  "Lock a challenge to this agent (15-min lease; 409 if someone else holds it)",
  { challenge_id: z.string().uuid() },
  async ({ challenge_id }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("POST", `/challenges/${challenge_id}/claim`), null, 1) }],
    isError: false,
  })
);

server.tool(
  "release_challenge",
  "Release the claim/lock on a challenge",
  { challenge_id: z.string().uuid() },
  async ({ challenge_id }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("POST", `/challenges/${challenge_id}/release`), null, 1) }],
  })
);

server.tool(
  "set_challenge_status",
  "Update working status: unopened | triaging | in_progress | blocked | solved | verified | failed",
  {
    challenge_id: z.string().uuid(),
    status: z.enum(["unopened", "triaging", "in_progress", "blocked", "solved", "verified", "failed"]),
  },
  async ({ challenge_id, status }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("POST", `/challenges/${challenge_id}/status`, { status }), null, 1) }],
  })
);

// ---------- Evidence ----------

server.tool(
  "list_evidence",
  "List evidence recorded on a challenge",
  { challenge_id: z.string().uuid() },
  async ({ challenge_id }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("GET", `/challenges/${challenge_id}/evidence`), null, 1) }],
  })
);

server.tool(
  "save_evidence",
  "Record evidence during solving (hypothesis, observation, command output...)",
  {
    challenge_id: z.string().uuid(),
    evidence_type: z.enum(["command", "output", "observation", "hypothesis", "request", "response", "reference"]),
    content: z.string().min(1).describe("What was found / run / observed"),
    command_text: z.string().optional().describe("The command if evidence_type is command/output"),
  },
  async ({ challenge_id, evidence_type, content, command_text }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("POST", `/challenges/${challenge_id}/evidence`, { evidence_type, content, command_text }), null, 1) }],
  })
);

// ---------- Flags ----------

server.tool(
  "list_flags",
  "List flags on a challenge (redacted previews only — the vault never returns plaintext)",
  { challenge_id: z.string().uuid() },
  async ({ challenge_id }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("GET", `/challenges/${challenge_id}/flags`), null, 1) }],
  })
);

server.tool(
  "submit_flag_candidate",
  "Store a flag candidate for a challenge (encrypted at rest, deduplicated)",
  {
    challenge_id: z.string().uuid(),
    value: z.string().min(1).describe("The flag string, e.g. FLAG{...}"),
    source: z.string().optional().describe("How it was obtained"),
  },
  async ({ challenge_id, value, source }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("POST", `/challenges/${challenge_id}/flags/candidates`, { value, source }), null, 1) }],
  })
);

// ---------- Writeups ----------

server.tool(
  "get_writeup",
  "Read a challenge's writeup (Thai human + English AI)",
  { challenge_id: z.string().uuid() },
  async ({ challenge_id }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("GET", `/challenges/${challenge_id}/writeup`), null, 1) }],
  })
);

server.tool(
  "save_writeup",
  "Save a writeup (markdown). Record Thai for human review, English for AI-generated.",
  {
    challenge_id: z.string().uuid(),
    language: z.enum(["thai", "english"]),
    markdown: z.string().min(1),
    status: z.enum(["draft", "reviewed", "final"]).optional(),
  },
  async ({ challenge_id, language, markdown, status }) => {
    const path = language === "thai" ? "thai" : "english-ai";
    const field = language === "thai" ? "thai_human_markdown" : "english_ai_markdown";
    const statusField = language === "thai" ? "thai_status" : "english_status";
    const body: Record<string, string> = { [field]: markdown };
    if (status) body[statusField] = status;
    return {
      content: [{ type: "text", text: JSON.stringify(await call("PUT", `/challenges/${challenge_id}/writeup/${path}`, body), null, 1) }],
    };
  }
);

// ---------- Search ----------

server.tool(
  "search_knowledge",
  "Search across all events: challenge descriptions, writeups (Thai/English), tags — find how similar challenges were solved before",
  {
    q: z.string().min(1).describe("Search query (English or Thai)"),
    language: z.enum(["thai", "english"]).optional(),
  },
  async ({ q, language }) => {
    const params = new URLSearchParams({ q });
    if (language) params.set("language", language);
    const data = await call("GET", `/search?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
  }
);

// ---------- Artifacts ----------

server.tool(
  "list_artifacts",
  "List files/artifacts attached to a challenge (images, pcaps, notes) with sha256",
  { challenge_id: z.string().uuid() },
  async ({ challenge_id }) => ({
    content: [{ type: "text", text: JSON.stringify(await call("GET", `/challenges/${challenge_id}/artifacts`), null, 1) }],
  })
);

// ---------- Run ----------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("flagforge-mcp fatal:", err);
  process.exit(1);
});
