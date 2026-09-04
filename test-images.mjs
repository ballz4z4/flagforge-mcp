// Detailed test: upload_artifact (both modes) + save_writeup with embedded image
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.FLAGFORGE_BASE_URL ?? "http://localhost:3100";
const TOKEN = process.env.FLAGFORGE_TOKEN;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { FLAGFORGE_BASE_URL: BASE, FLAGFORGE_TOKEN: TOKEN },
});
const client = new Client({ name: "img-test", version: "1.0.0" });
await client.connect(transport);

const call = (name, args) => client.callTool({ name, arguments: args });
const parse = (r) => JSON.parse(r.content[0].text);

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
}

// 1. create test event + challenge
const ev = parse(await call("create_event", {
  name: "MCP Image Test Event", slug: `mcp-img-test-${Date.now()}`,
  status: "live", platform_type: "manual",
}));
const eventId = ev.event.id;
console.log("1. create_event:", eventId);

const ch = parse(await call("create_challenge", {
  event: eventId, title: "img-test-chal", category: "misc", points: 10,
  description_markdown: "test",
}));
const challengeId = ch.challenge.id;
console.log("2. create_challenge:", challengeId);

// 3. upload via file_path (tiny PNG)
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const dir = mkdtempSync(join(tmpdir(), "ff-mcp-"));
const imgPath = join(dir, "test-shot.png");
writeFileSync(imgPath, png);

const up1 = parse(await call("upload_artifact", {
  challenge_id: challengeId, file_path: imgPath, mime_type: "image/png",
}));
check("upload_artifact (file_path) returns artifact id", !!up1.artifact?.id);
check("upload returns markdown_snippet",
  up1.markdown_snippet === `![test-shot.png](/artifacts/${up1.artifact.id})`,
  JSON.stringify(up1.markdown_snippet));
check("upload records sha256", !!up1.artifact?.sha256);
check("upload records mime type", up1.artifact?.mime_type === "image/png");
console.log("3. upload_artifact file_path:", up1.artifact.id);

// 4. upload via content_base64
const up2 = parse(await call("upload_artifact", {
  challenge_id: challengeId, content_base64: png.toString("base64"),
  filename: "inline.png", mime_type: "image/png",
}));
check("upload_artifact (content_base64) returns artifact id", !!up2.artifact?.id);
check("base64 upload uses provided filename",
  up2.artifact?.original_filename === "inline.png");
console.log("4. upload_artifact content_base64:", up2.artifact.id);

// 5. upload with no source → should be a clean error, not a crash
const upErr = await call("upload_artifact", { challenge_id: challengeId });
check("upload without source returns isError", upErr.isError === true);
check("upload error message mentions the options",
  /file_path|content_base64/.test(upErr.content[0].text));
console.log("5. upload error case ok");

// 6. save_writeup with embedded image markdown
const md = [
  "# ทดสอบรูปใน writeup",
  "",
  "รูปจาก file_path:",
  up1.markdown_snippet,
  "",
  "รูปจาก base64:",
  up2.markdown_snippet,
  "",
  "```bash",
  "nmap -sV target",
  "```",
].join("\n");
const saved = parse(await call("save_writeup", {
  challenge_id: challengeId, language: "thai", markdown: md, status: "reviewed",
}));
check("save_writeup with images succeeds", !!saved.writeup?.id);
check("writeup stored image ref",
  saved.writeup?.thai_human_markdown.includes(`/artifacts/${up1.artifact.id}`));
console.log("6. save_writeup with images:", saved.writeup.id);

// 7. get_writeup returns the markdown intact
const got = parse(await call("get_writeup", { challenge_id: challengeId }));
check("get_writeup round-trips markdown",
  got.writeup.thai_human_markdown === md);
console.log("7. get_writeup round-trip ok");

// 8. images actually serve over HTTP (session cookie, like a browser)
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: TOKEN }),
});
const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
for (const [label, a] of [["file_path", up1.artifact], ["base64", up2.artifact]]) {
  const res = await fetch(`${BASE}/artifacts/${a.id}`, { headers: { cookie } });
  const body = Buffer.from(await res.arrayBuffer());
  check(`image (${label}) serves 200 image/png`,
    res.status === 200 && res.headers.get("content-type") === "image/png",
    `status ${res.status} type ${res.headers.get("content-type")}`);
  check(`image (${label}) bytes match size`,
    body.length === a.size_bytes, `${body.length} vs ${a.size_bytes}`);
}
console.log("8. images serve over HTTP");

// 9. list_artifacts shows both
const arts = parse(await call("list_artifacts", { challenge_id: challengeId }));
check("list_artifacts shows both uploads",
  arts.artifacts.length === 2 &&
  arts.artifacts.every(a => a.sha256));
console.log("9. list_artifacts ok");

// 10. cleanup — delete test event via API (cascades challenges)
const delRes = await fetch(`${BASE}/api/v1/events/${eventId}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${TOKEN}` },
});
check("cleanup delete event", delRes.ok, `status ${delRes.status}`);
console.log("10. cleanup done");

console.log(`\n=== ${pass}/${pass + fail} passed ===`);
await client.close();
process.exit(fail ? 1 : 0);
