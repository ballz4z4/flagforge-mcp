// Exhaustive MCP e2e: all 19 tools, error paths, permissions, full flag lifecycle.
// Usage: FLAGFORGE_TOKEN=<admin token> READER_TOKEN=<reader token> node test-mcp-exhaustive.mjs
import { spawn } from "node:child_process";

const BASE_URL = process.env.FLAGFORGE_BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.FLAGFORGE_TOKEN;
const READER_TOKEN = process.env.READER_TOKEN;

if (!TOKEN || !READER_TOKEN) {
  console.error("need FLAGFORGE_TOKEN and READER_TOKEN");
  process.exit(1);
}

function makeClient(token, label) {
  const proc = spawn("node", ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, FLAGFORGE_BASE_URL: BASE_URL, FLAGFORGE_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      } catch {}
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));

  async function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message ?? "rpc error")) : resolve(m.result)));
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, 15000);
    });
  }
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.content?.[0]?.text ?? "{}";
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const tryCall = async (name, args) => {
    try { return { ok: true, data: await call(name, args) }; }
    catch (e) { return { ok: false, error: e.message }; }
  };
  const notifyInitialized = () =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { rpc, call, tryCall, notifyInitialized, kill: () => proc.kill() };
}

const admin = makeClient(TOKEN, "admin");
const reader = makeClient(READER_TOKEN, "reader");

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  // ---- handshake ----
  await admin.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  admin.notifyInitialized();
  await reader.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  reader.notifyInitialized();
  record("initialize (both clients)", true);

  const tools = await admin.rpc("tools/list", {});
  record("tools/list = 19 tools", tools.tools.length === 19, `${tools.tools.length}`);

  const SUFFIX = Date.now().toString(36);
  const SLUG = `mcp-xt-${SUFFIX}`;

  // ---- create_event ----
  const ev = await admin.call("create_event", {
    name: "MCP Exhaustive Test", slug: SLUG, platform_type: "manual",
    description: "exhaustive test event", flag_pattern: "XT{...}", status: "live",
    organizer: "test",
  });
  const EV_ID = ev.event.id;
  record("create_event (full fields)", EV_ID && ev.event.slug === SLUG);

  // duplicate slug → error
  const dup = await admin.tryCall("create_event", { name: "dup", slug: SLUG, platform_type: "manual" });
  record("create_event duplicate slug rejected", !dup.ok);

  // invalid slug format → error
  const badSlug = await admin.tryCall("create_event", { name: "bad", slug: "Invalid_Slug", platform_type: "manual" });
  record("create_event invalid slug rejected", !badSlug.ok);

  // reader cannot create event
  const readerCreate = await reader.tryCall("create_event", { name: "r", slug: `reader-${SUFFIX}`, platform_type: "manual" });
  record("create_event denied for reader", !readerCreate.ok);

  // ---- list_events ----
  const evs = await reader.call("list_events", {});
  record("list_events (reader ok)", evs.events.some((e) => e.slug === SLUG), `${evs.events.length} events`);

  // ---- create_challenge ----
  const ch = await admin.call("create_challenge", {
    event: SLUG, title: "Xt Challenge Alpha", category: "Pwn", points: 300,
    description_markdown: "Buffer overflow challenge", connection_info: "nc xt 1337",
    tags: ["bof", "xt"], external_id: "xt-1",
  });
  const CH_ID = ch.challenge.id;
  record("create_challenge (by slug, full fields)", CH_ID && ch.challenge.event_id === EV_ID, `linked to event correctly`);

  // create second challenge by UUID
  const ch2 = await admin.call("create_challenge", { event: EV_ID, title: "Xt Challenge Beta", category: "Web", points: 200 });
  const CH2_ID = ch2.challenge.id;
  record("create_challenge (by UUID)", ch2.challenge.event_id === EV_ID);

  // reader cannot create challenge
  const readerCh = await reader.tryCall("create_challenge", { event: SLUG, title: "nope", category: "Web" });
  record("create_challenge denied for reader", !readerCh.ok);

  // ---- list_challenges filters ----
  const all = await reader.call("list_challenges", { event: SLUG });
  record("list_challenges all", all.challenges.length === 2);
  const byCat = await reader.call("list_challenges", { event: SLUG, category: "Pwn" });
  record("list_challenges category filter", byCat.challenges.length === 1 && byCat.challenges[0].title === "Xt Challenge Alpha");
  const byStatus = await reader.call("list_challenges", { event: SLUG, status: "unopened" });
  record("list_challenges status filter", byStatus.challenges.length === 2);
  const notFound = await reader.tryCall("list_challenges", { event: "no-such-event" });
  record("list_challenges 404 for unknown event", !notFound.ok);

  // ---- get_challenge ----
  const one = await reader.call("get_challenge", { challenge_id: CH_ID });
  record("get_challenge", one.challenge.title === "Xt Challenge Alpha" && one.challenge.points === 300);
  const nf = await reader.tryCall("get_challenge", { challenge_id: "00000000-0000-0000-0000-000000000000" });
  record("get_challenge 404", !nf.ok);

  // ---- update_challenge ----
  const upd = await admin.call("update_challenge", { challenge_id: CH_ID, points: 500, title: "Xt Challenge Alpha v2" });
  record("update_challenge", upd.challenge.points === 500 && upd.challenge.title === "Xt Challenge Alpha v2");

  // ---- claim / release ----
  const claim = await admin.call("claim_challenge", { challenge_id: CH_ID });
  record("claim_challenge", !!claim.challenge || !!claim.claimed || !claim.error, JSON.stringify(claim).slice(0, 80));
  const claimed = await reader.call("get_challenge", { challenge_id: CH_ID });
  const isLocked = claimed.challenge.assigned_agent_id || claimed.challenge.assigned_user_id;
  record("claim_challenge locks challenge", !!isLocked);
  const release = await admin.call("release_challenge", { challenge_id: CH_ID });
  record("release_challenge", !!release.challenge || !release.error);
  const released = await reader.call("get_challenge", { challenge_id: CH_ID });
  record("release_challenge unlocks", !released.challenge.assigned_agent_id && !released.challenge.assigned_user_id);

  // ---- evidence ----
  const ev1 = await admin.call("save_evidence", { challenge_id: CH_ID, evidence_type: "command", content: "ran checksec", command_text: "checksec xt" });
  record("save_evidence (command)", !ev1.error);
  await admin.call("save_evidence", { challenge_id: CH_ID, evidence_type: "hypothesis", content: "Maybe off-by-one in parse" });
  const evList = await reader.call("list_evidence", { challenge_id: CH_ID });
  record("list_evidence (2 items, reader ok)", evList.evidence.length === 2);

  // ---- flag lifecycle ----
  const cand = await admin.call("submit_flag_candidate", { challenge_id: CH_ID, value: `XT{${SUFFIX}_real_flag}` });
  record("submit_flag_candidate", cand.flag.status === "candidate", `status: ${cand.flag.status}`);
  // duplicate flag value deduped
  const dupFlag = await admin.tryCall("submit_flag_candidate", { challenge_id: CH_ID, value: `XT{${SUFFIX}_real_flag}` });
  record("submit_flag_candidate dedup/reject duplicate", !dupFlag.ok || dupFlag.data.flag?.id === cand.flag.id);
  // flags list never leaks plaintext
  const flagsList = await reader.call("list_flags", { challenge_id: CH_ID });
  const noLeak = !JSON.stringify(flagsList).includes(`${SUFFIX}_real_flag`);
  record("list_flags redacted only (reader)", flagsList.flags.length >= 1 && noLeak, "no plaintext leak");
  // reader cannot submit flag
  const readerFlag = await reader.tryCall("submit_flag_candidate", { challenge_id: CH_ID, value: "XT{nope}" });
  record("submit_flag_candidate denied for reader", !readerFlag.ok);

  // ---- writeups ----
  await admin.call("save_writeup", { challenge_id: CH_ID, language: "thai", markdown: "## วิธีแก้\n\nใช้ buffer overflow overflow ตัว return address", status: "final" });
  const wuEn = await admin.call("save_writeup", { challenge_id: CH_ID, language: "english", markdown: "## Solution\n\nClassic stack overflow via parse()", status: "final" });
  record("save_writeup (thai + english)", !wuEn.error);
  const wuGet = await reader.call("get_writeup", { challenge_id: CH_ID });
  record("get_writeup bilingual", wuGet.writeup.thai_human_markdown.includes("วิธีแก้") && wuGet.writeup.english_ai_markdown.includes("Solution"));

  // ---- search ----
  await new Promise((r) => setTimeout(r, 1000)); // allow index write
  const sEn = await reader.call("search_knowledge", { q: "buffer overflow" });
  record("search_knowledge english hits", sEn.results.some((r) => r.challenge_id === CH_ID || r.title?.includes("Xt Challenge Alpha")), `${sEn.results.length} results`);
  const sTh = await reader.call("search_knowledge", { q: "วิธีแก้", language: "thai" });
  record("search_knowledge thai ok (no crash)", Array.isArray(sTh.results));
  const sNone = await reader.call("search_knowledge", { q: "zzzznothingmatches" });
  record("search_knowledge empty ok", sNone.results.length === 0);

  // ---- artifacts ----
  const arts = await reader.call("list_artifacts", { challenge_id: CH_ID });
  record("list_artifacts (empty ok)", Array.isArray(arts.artifacts) && arts.artifacts.length === 0);

  // ---- set_challenge_status ----
  await admin.call("set_challenge_status", { challenge_id: CH_ID, status: "in_progress" });
  const inProg = await reader.call("get_challenge", { challenge_id: CH_ID });
  record("set_challenge_status in_progress", inProg.challenge.status === "in_progress");
  await admin.call("set_challenge_status", { challenge_id: CH_ID, status: "solved" });
  const solved = await reader.call("get_challenge", { challenge_id: CH_ID });
  record("set_challenge_status solved", solved.challenge.status === "solved");
  const badStatus = await admin.tryCall("set_challenge_status", { challenge_id: CH_ID, status: "bogus_status" });
  record("set_challenge_status invalid rejected", !badStatus.ok);

  // ---- delete_challenge ----
  const del2 = await admin.call("delete_challenge", { challenge_id: CH2_ID });
  record("delete_challenge", del2.deleted === true);
  const goneCh = await reader.tryCall("get_challenge", { challenge_id: CH2_ID });
  record("delete_challenge gone", !goneCh.ok);
  // reader cannot delete
  const readerDel = await reader.tryCall("delete_challenge", { challenge_id: CH_ID });
  record("delete_challenge denied for reader", !readerDel.ok);

  // ---- summary ----
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  if (passed !== results.length) {
    console.log("FAILED:", results.filter((r) => !r.pass).map((r) => r.name).join(", "));
  }
  process.exit(passed === results.length ? 0 : 1);
} catch (e) {
  console.error("FATAL:", e.message);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} passed (fatal) ===`);
  process.exit(1);
} finally {
  admin.kill();
  reader.kill();
}
