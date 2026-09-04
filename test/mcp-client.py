"""Quick MCP stdio client test for the FlagForge MCP server.

Reads FLAGFORGE_BASE_URL and FLAGFORGE_TOKEN from the environment so
restricted tokens can be tested; falls back to local dev defaults.
"""
import subprocess, json, os, sys, threading

env = dict(os.environ)
env.setdefault("FLAGFORGE_BASE_URL", "http://localhost:3000")
env.setdefault("FLAGFORGE_TOKEN", "test-admin-token-12345")

p = subprocess.Popen(
    ["node", "dist/index.js"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env=env,
)

responses = {}

def reader():
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if "id" in msg:
            responses[msg["id"]] = msg

threading.Thread(target=reader, daemon=True).start()

def send(msg):
    p.stdin.write((json.dumps(msg) + "\n").encode())
    p.stdin.flush()

def wait_for(rid, timeout=15):
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        if rid in responses:
            return responses[rid]
        time.sleep(0.1)
    raise TimeoutError(f"no response for id {rid}")

send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2024-11-05", "capabilities": {},
    "clientInfo": {"name": "test", "version": "0.1"}}})
init = wait_for(1)
print("server:", init["result"]["serverInfo"])

send({"jsonrpc": "2.0", "method": "notifications/initialized"})

send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
tools = wait_for(2)
names = [t["name"] for t in tools["result"]["tools"]]
print(f"tools ({len(names)}):", ", ".join(names))

def call_tool(rid, name, args):
    send({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
          "params": {"name": name, "arguments": args}})
    return wait_for(rid)

r = call_tool(3, "list_events", {})
print("list_events ok:", "tctt-2026" in r["result"]["content"][0]["text"])

r = call_tool(4, "search_knowledge", {"q": "Signal Desktop"})
print("search ok:", "Shadow Council" in r["result"]["content"][0]["text"])

r = call_tool(5, "list_challenges", {"event": "tctt-2026"})
print("list_challenges ok:", "Shadow Council" in r["result"]["content"][0]["text"])

p.terminate()
print("ALL DONE")
