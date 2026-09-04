// E2E test: drive the FlagForge MCP server over stdio JSON-RPC.
// Usage: FLAGFORGE_TOKEN=... node test-mcp.mjs
import { spawn } from "node:child_process";

const BASE_URL = process.env.FLAGFORGE_BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.FLAGFORGE_TOKEN;

const proc = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, FLAGFORGE_BASE_URL: BASE_URL, FLAGFORGE_TOKEN: TOKEN },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
let nextId = 1;
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});
proc.stderr.on("data", (d) => process.stderr.write(`[mcp] ${d}`));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 15000);
  });
}

function callTool(name, args) {
  return rpc("tools/call", { name, arguments: args });
}

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  // 1. initialize handshake
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "1.0" },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  record("initialize", !!init.serverInfo?.name, `server: ${init.serverInfo?.name}`);

  // 2. list tools
  const tools = await rpc("tools/list", {});
  const toolNames = tools.tools.map((t) => t.name);
  record("tools/list", toolNames.length >= 15, `${toolNames.length} tools: ${toolNames.join(", ")}`);

  // 3. create event
  const ev = await callTool("create_event", {
    name: "MCP E2E Test Event",
    slug: "mcp-e2e-test-event",
    platform_type: "manual",
    description: "Created by MCP e2e test",
    status: "live",
  });
  const evData = JSON.parse(ev.content[0].text);
  record("create_event", evData.event?.slug === "mcp-e2e-test-event", `id: ${evData.event?.id}`);

  // 4. list events — should contain the new one
  const evs = await callTool("list_events", {});
  const evsData = JSON.parse(evs.content[0].text);
  const found = evsData.events?.some((e) => e.slug === "mcp-e2e-test-event");
  record("list_events", found, `${evsData.events?.length} events`);

  // 5. create challenge
  const ch = await callTool("create_challenge", {
    event: "mcp-e2e-test-event",
    title: "MCP Test Challenge",
    category: "Web",
    points: 100,
    description_markdown: "Test challenge for MCP e2e",
    tags: ["test", "mcp"],
  });
  const chData = JSON.parse(ch.content[0].text);
  const chId = chData.challenge?.id;
  record("create_challenge", !!chId, `id: ${chId}`);

  // 6. list challenges
  const chs = await callTool("list_challenges", { event: "mcp-e2e-test-event" });
  const chsData = JSON.parse(chs.content[0].text);
  record("list_challenges", chsData.challenges?.some((c) => c.title === "MCP Test Challenge"), `${chsData.challenges?.length} challenges`);

  // 7. get_challenge
  const one = await callTool("get_challenge", { challenge_id: chId });
  const oneData = JSON.parse(one.content[0].text);
  record("get_challenge", oneData.challenge?.title === "MCP Test Challenge");

  // 8. save evidence
  const ev2 = await callTool("save_evidence", {
    challenge_id: chId,
    evidence_type: "observation",
    content: "Found login page at /admin",
  });
  record("save_evidence", !JSON.parse(ev2.content[0].text).error);

  // 9. list evidence
  const evList = await callTool("list_evidence", { challenge_id: chId });
  const evListData = JSON.parse(evList.content[0].text);
  record("list_evidence", evListData.evidence?.length >= 1, `${evListData.evidence?.length} items`);

  // 10. submit flag candidate
  const fl = await callTool("submit_flag_candidate", {
    challenge_id: chId,
    value: "FLAG{mcp_e2e_test_flag}",
  });
  const flData = JSON.parse(fl.content[0].text);
  record("submit_flag_candidate", !!flData.flag?.id, `status: ${flData.flag?.status}`);

  // 11. list flags (redacted only)
  const flList = await callTool("list_flags", { challenge_id: chId });
  const flListData = JSON.parse(flList.content[0].text);
  const noLeak = !JSON.stringify(flListData).includes("mcp_e2e_test_flag");
  record("list_flags", flListData.flags?.length >= 1 && noLeak, "redacted preview only");

  // 12. save writeup (thai)
  const wu = await callTool("save_writeup", {
    challenge_id: chId,
    language: "thai",
    markdown: "## วิธีแก้\n\nทดสอบผ่าน MCP",
    status: "final",
  });
  record("save_writeup", !JSON.parse(wu.content[0].text).error);

  // 13. get writeup
  const wuGet = await callTool("get_writeup", { challenge_id: chId });
  const wuData = JSON.parse(wuGet.content[0].text);
  record("get_writeup", (wuData.writeup?.thai_human_markdown ?? "").includes("วิธีแก้"));

  // 14. search knowledge
  const search = await callTool("search_knowledge", { q: "MCP Test Challenge" });
  const searchData = JSON.parse(search.content[0].text);
  record("search_knowledge", (searchData.results ?? []).some((r) => r.title === "MCP Test Challenge"), `${searchData.results?.length} results`);

  // 15. update challenge
  const upd = await callTool("update_challenge", {
    challenge_id: chId,
    points: 250,
  });
  const updData = JSON.parse(upd.content[0].text);
  record("update_challenge", updData.challenge?.points === 250);

  // 16. set status
  const st = await callTool("set_challenge_status", {
    challenge_id: chId,
    status: "in_progress",
  });
  record("set_challenge_status", !JSON.parse(st.content[0].text).error);

  // 17. cleanup: delete challenge + event via API (admin-only tools not in MCP for event delete)
  const del = await callTool("delete_challenge", { challenge_id: chId });
  record("delete_challenge", JSON.parse(del.content[0].text).deleted === true);

  // summary
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  process.exit(passed === results.length ? 0 : 1);
} catch (e) {
  console.error("FATAL:", e.message);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} passed (fatal) ===`);
  process.exit(1);
} finally {
  proc.kill();
}
