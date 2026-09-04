# FlagForge MCP Server

MCP (Model Context Protocol) server ที่เปลี่ยน FlagForge REST API เป็นเครื่องมือสำหรับ AI agent — ให้ agent ค้นคลัง CTF ที่เคยแก้, ทำงานกับโจทย์ระหว่าง event สด, บันทึก evidence, ส่ง flag, และเขียน writeup ได้โดยตรง

## การติดตั้งและรัน

```bash
cd C:/Users/Admin/Desktop/files/mcp-ai/flagforge-mcp
npm install
npm run build        # tsc → dist/index.js
```

### Environment variables (จำเป็น)

| ตัวแปร | ค่า | ตัวอย่าง |
|---|---|---|
| `FLAGFORGE_BASE_URL` | URL ของ FlagForge web app | `http://localhost:3000` |
| `FLAGFORGE_TOKEN` | Bearer token ของ agent (สร้างจากหน้า admin → Agents) | `ff_xxxxxxxx` หรือ admin bootstrap token |

> Token ต้องเป็นของ **agent principal** ที่สร้างไว้ในระบบ (role: reader/solver/submitter/admin) หรือ `FLAGFORGE_ADMIN_TOKEN` สำหรับการทดสอบ — สิทธิ์ทุกอย่างถูกบังคับตาม role ของ token นั้น

### การเชื่อมต่อกับ Claude Desktop / Claude Code

เพิ่มใน `claude_desktop_config.json` (Claude Desktop):

```json
{
  "mcpServers": {
    "flagforge": {
      "command": "node",
      "args": ["C:\\Users\\Admin\\Desktop\\files\\mcp-ai\\flagforge-mcp\\dist\\index.js"],
      "env": {
        "FLAGFORGE_BASE_URL": "https://your-flagforge.example.com",
        "FLAGFORGE_TOKEN": "ff_your_agent_token"
      }
    }
  }
}
```

สำหรับ Claude Code:

```bash
claude mcp add flagforge -e FLAGFORGE_BASE_URL=http://localhost:3000 -e FLAGFORGE_TOKEN=ff_your_token -- node C:/Users/Admin/Desktop/files/mcp-ai/flagforge-mcp/dist/index.js
```

## เครื่องมือทั้ง 18 ตัว

### Events

| Tool | สิทธิ์ขั้นต่ำ | คำอธิบาย |
|---|---|---|
| `list_events` | reader | รายการ event ทั้งหมด พร้อมจำนวนโจทย์/แก้แล้ว |
| `create_event` | admin | สร้าง event ใหม่ (name, slug, platform_type: ctfd/custom/manual, organizer, description, flag_pattern, status) |

### Challenges

| Tool | สิทธิ์ขั้นต่ำ | คำอธิบาย |
|---|---|---|
| `list_challenges` | reader | โจทย์ใน event (รับ **event id หรือ slug**) + filter ได้ (category, status) |
| `get_challenge` | reader | รายละเอียดโจทย์เดี่ยว: คำอธิบาย, สถานะ, flag status, writeup status |
| `create_challenge` | solver+`challenge.write` | สร้างโจทย์ (title, category, points, description, connection_info, tags, external_id) — slug สร้างอัตโนมัติจาก title |
| `update_challenge` | solver+`challenge.write` | แก้ไขฟิลด์โจทย์ |
| `delete_challenge` | admin | ลบโจทย์ + evidence/flags/artifacts (cascade) |
| `claim_challenge` | solver | จองโจทย์ (lock กันซ้ำ มี expiry) |
| `release_challenge` | solver | ปลดล็อกโจทย์ที่จองไว้ |
| `set_challenge_status` | solver | เปลี่ยนสถานะ: `unopened` `triaging` `in_progress` `blocked` `solved` `verified` `failed` |

### Evidence (บันทึกระหว่างแก้)

| Tool | สิทธิ์ขั้นต่ำ | คำอธิบาย |
|---|---|---|
| `save_evidence` | solver | บันทึก evidence: `command` `output` `observation` `hypothesis` `request` `response` `reference` |
| `list_evidence` | reader | ดู evidence ทั้งหมดของโจทย์ |

### Flags (ห้องนิรภัย — เข้ารหัส AES-256-GCM)

| Tool | สิทธิ์ขั้นต่ำ | คำอธิบาย |
|---|---|---|
| `submit_flag_candidate` | submitter | เก็บ flag candidate (เข้ารหัส, กันซ้ำด้วย HMAC) |
| `list_flags` | reader | ดู flags — **ได้เฉพาะ redacted preview** เช่น `TCTT20…_ok}` ไม่มี plaintext ยกเว้น admin reveal |

### Writeups

| Tool | สิทธิ์ขั้นต่ำ | คำอธิบาย |
|---|---|---|
| `save_writeup` | solver | บันทึก writeup (language: `thai` = มนุษย์เขียน / `english` = AI generate, status: draft/reviewed/final) |
| `get_writeup` | reader | อ่าน writeup ทั้งสองภาษา |

### ค้นหา + Artifacts

| Tool | สิทธิ์ขั้นต่ำ | คำอธิบาย |
|---|---|---|
| `search_knowledge` | reader | ค้นหาทุก event: คำอธิบายโจทย์, writeup ไทย/อังกฤษ, tags — หาว่าโจทย์แนวนี้เคยแก้ยังไง |
| `list_artifacts` | reader | ไฟล์แนบโจทย์ (images, pcaps, notes) พร้อม sha256 |

## Workflow ที่แนะนำ

### 1. ก่อนเริ่มโจทย์ใหม่ — ค้นความรู้เดิมก่อนเสมอ

```
search_knowledge(q="SQL injection union")     → เจอโจทย์คล้ายที่เคยแก้ + writeup
search_knowledge(q="buffer overflow", language="english")
```

### 2. ระหว่าง event สด

```
list_events()                                  → หา event ที่กำลัง live
list_challenges(event="tctt-2026", status="unopened")
get_challenge(challenge_id=...)                → อ่านคำอธิบาย
claim_challenge(challenge_id=...)              → จองก่อนใคร
set_challenge_status(challenge_id=..., status="in_progress")
save_evidence(challenge_id=..., evidence_type="command",
             content="nmap found port 1337", command_text="nmap -sV target")
submit_flag_candidate(challenge_id=..., value="TCTT{...}")
set_challenge_status(challenge_id=..., status="solved")
```

### 3. หลังแก้เสร็จ — เขียน writeup

```
save_writeup(challenge_id=..., language="thai",
             markdown="## วิธีแก้\n\n...", status="final")
```

### 4. ตัวอย่างการสร้าง event + โจทย์ด้วยมือ

```
create_event(name="My CTF 2026", slug="my-ctf-2026", platform_type="manual", status="live")
create_challenge(event="my-ctf-2026", title="Baby SQLi", category="Web",
                 points=100, description_markdown="Find the flag in /search",
                 tags=["sqli", "web"])
```

## การทดสอบ

มี e2e test 2 ชุด (ต้องรัน web app ที่ `localhost:3000` ก่อน):

```bash
# ชุดพื้นฐาน 17 tests — flow หลักครบ
FLAGFORGE_TOKEN=<admin token> node test-mcp.mjs

# ชุดละเอียด 39 tests — ทุก tool + error paths + permission + dedup + bilingual
FLAGFORGE_TOKEN=<admin token> READER_TOKEN=<reader token> node test-mcp-exhaustive.mjs
```

ผลล่าสุด: **17/17 และ 39/39 ผ่านทั้งหมด** — ครอบคลุม:
- Validation (slug ซ้ำ, slug format ผิด, status ไม่มีอยู่)
- Permission (reader ปฏิเสธการเขียนทุกชนิด: 403)
- Flag security (list ไม่เคยคืน plaintext, dedup ซ้ำ, มีเฉพาะ redacted preview)
- Claim/release lifecycle (lock/unlock จริง)
- Bilingual writeup (ไทย+อังกฤษ)
- Search (อังกฤษ, ไทย, ไม่เจอ = ชุดว่าง)
- Not-found paths (404 ทุก tool)

## ข้อควรระวังด้านความปลอดภัย

- Flag **ถูกเข้ารหัสตอนพัก** (AES-256-GCM) — MCP ไม่มี tool ไหนคืน plaintext เด็ดขาด
- ทุก writeup ห้าม log flag เต็ม — ใช้ redacted preview เท่านั้น
- Token ของ agent มี SHA-256 hash lookup — หากโดนขโมยให้ revoke ทันทีจาก admin UI
- ทุกการเขียนผ่าน MCP มี audit log ผูกกับ agent principal
"# flagforge-mcp" 
