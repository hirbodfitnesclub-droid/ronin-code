// Mock OpenAI-compatible provider for Ronin host E2E tests.
// Behavior is driven by markers in the last user message:
//   SCENARIO:bash CMD:<command>   -> one bash tool call, then final text
//   SCENARIO:env                  -> one read of ".env", then final text
//   SCENARIO:noisy                -> bash printing repeated lines + a fake secret
//   MOCK:429                      -> HTTP 429 when Authorization is Bearer mock-key-1
//   plan prompt ("planning a coding task") -> fenced JSON plan (no tools)
//   idea prompt ("Mature it")     -> JSON audience/features/plan (no tools)
//   otherwise                     -> plain text reply
// Every request body is recorded; GET /__requests returns them as JSON.

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 7411);
export const requests = [];
let rateLimitHits = 0;

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function chunkBase(id) {
  return { id, object: "chat.completion.chunk", created: 1700000000, model: "mock-1" };
}
function sendText(res, text, usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }) {
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 9)}`;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  sseChunk(res, { ...chunkBase(id), choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
  sseChunk(res, { ...chunkBase(id), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
  res.write("data: [DONE]\n\n");
  res.end();
}
function sendToolCall(res, callId, name, args, usage = { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 }) {
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 9)}`;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  sseChunk(res, {
    ...chunkBase(id),
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: null,
    }],
  });
  sseChunk(res, { ...chunkBase(id), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
  return "";
}
function lastUserText(body) {
  const msgs = body.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return textOf(msgs[i].content);
  }
  return "";
}
function hasToolResult(body) {
  return (body.messages || []).some((m) => m.role === "tool");
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model" }] }));
  }
  if (url.pathname === "/__requests") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(requests));
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      requests.push({ at: Date.now(), auth: req.headers.authorization || "", body });
      const userText = lastUserText(body);

      if (userText.includes("MOCK:429")) {
        // Fail the first 3 attempts (one full engine attempt incl. its
        // internal retries), then recover — deterministic failover test
        // regardless of which key the router picks first.
        rateLimitHits++;
        if (rateLimitHits <= 3) {
          console.log(`[mock] 429 #${rateLimitHits} for ${req.headers.authorization}`);
          res.writeHead(429, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "Rate limit exceeded, please retry later (429)" } }));
        }
      }
      console.log(`[mock] ok ${req.headers.authorization} :: ${userText.slice(0, 60).replace(/\n/g, " ")} :: toolResult=${hasToolResult(body)}`);
      if (userText.includes("planning a coding task")) {
        return sendText(res, '```json\n{"steps":[{"title":"Explore files","detail":"Look at the project"},{"title":"Build it","detail":"Make the change"},{"title":"Verify","detail":"Check the result"}]}\n```');
      }
      if (userText.includes("Mature it")) {
        return sendText(res, JSON.stringify({
          audience: { who: "Barbers and their clients", pain: "Phone-tag bookings" },
          features: ["Online booking page", "SMS reminders", "Barber profiles"],
          plan: [
            { title: "Landing + booking form", detail: "The core page" },
            { title: "Barber admin", detail: "Manage slots" },
          ],
        }));
      }
      if (hasToolResult(body)) {
        return sendText(res, "Mock turn complete.");
      }
      if (userText.includes("Approved plan")) {
        return sendToolCall(res, "call_bash_3", "bash", { command: "touch PLANMARKER" });
      }
      if (userText.includes("SCENARIO:outside")) {
        return sendToolCall(res, "call_write_1", "write", { path: "/tmp/ronin-e2e/outside.txt", content: "outside\n" });
      }
      if (userText.includes("SCENARIO:bash")) {
        const m = userText.match(/CMD:([^\n]+)/);
        return sendToolCall(res, "call_bash_1", "bash", { command: m ? m[1].trim() : "echo hello-from-mock" });
      }
      if (userText.includes("SCENARIO:env")) {
        return sendToolCall(res, "call_read_1", "read", { path: ".env" });
      }
      if (userText.includes("SCENARIO:noisy")) {
        const cmd = `node -e "for(let i=0;i<400;i++) console.log('worker heartbeat ok'); console.log('connecting with key sk-FAKESECRETKEY1234567890abcdef'); console.log('done');"`;
        return sendToolCall(res, "call_bash_2", "bash", { command: cmd });
      }
      return sendText(res, "Mock reply.");
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock provider listening on http://127.0.0.1:${PORT}`);
});
