import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient } from "../src/telegram.js";
import { renderTelegramMarkdownChunks } from "../src/telegram-markdown.js";

test("When agent markdown includes common formatting, then Telegram HTML is rendered safely", () => {
  const chunks = renderTelegramMarkdownChunks({
    prefixText: "Latest Codex reply\nsession: Build",
    markdown: [
      "# Plan",
      "",
      "Use **bold**, *italics*, `code`, and [docs](https://example.com/docs).",
      "",
      "- first item",
      "- second item",
      "",
      "```js",
      "console.log(1);",
      "```",
    ].join("\n"),
  });

  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /^Latest Codex reply\nsession: Build/);
  assert.match(chunks[0], /<b>Plan<\/b>/);
  assert.match(chunks[0], /<b>bold<\/b>/);
  assert.match(chunks[0], /<i>italics<\/i>/);
  assert.match(chunks[0], /<code>code<\/code>/);
  assert.match(chunks[0], /<a href="https:\/\/example\.com\/docs">docs<\/a>/);
  assert.match(chunks[0], /• first item/);
  assert.match(chunks[0], /<pre><code>console\.log\(1\);<\/code><\/pre>/);
});

test("When a markdown code block exceeds Telegram limits, then it is split into valid HTML chunks", () => {
  const longCode = Array.from(
    { length: 320 },
    (_, index) => `const line${index} = "${"x".repeat(24)}";`,
  ).join("\n");
  const chunks = renderTelegramMarkdownChunks({
    markdown: `\`\`\`js\n${longCode}\n\`\`\``,
  });

  assert.ok(chunks.length > 1);

  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4096);
    assert.match(chunk, /^<pre><code>/);
    assert.match(chunk, /<\/code><\/pre>$/);
  }
});

test("When markdown includes nested lists, URLs with parentheses, or unmatched backticks, then rendering stays stable", () => {
  const chunks = renderTelegramMarkdownChunks({
    markdown: [
      "- outer item",
      "  - inner item",
      "",
      "[Spec](https://example.com/spec_(v2))",
      "",
      "Literal `backtick stays open",
    ].join("\n"),
  });

  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /• outer item/);
  assert.match(chunks[0], /&nbsp;&nbsp;• inner item/);
  assert.match(chunks[0], /<a href="https:\/\/example\.com\/spec_\(v2\)">Spec<\/a>/);
  assert.match(chunks[0], /Literal `backtick stays open/);
});

test("When sendMarkdownMessage is used, then Telegram HTML parse mode is used", async () => {
  class RecordingTelegramClient extends TelegramClient {
    constructor() {
      super({
        token: "test-token",
        apiBaseUrl: "https://api.telegram.org",
      });
      this.requests = [];
    }

    async request(method, payload) {
      this.requests.push({ method, payload });
      return {
        message_id: this.requests.length,
        chat: { id: payload.chat_id },
        text: payload.text,
      };
    }
  }

  const telegram = new RecordingTelegramClient();

  await telegram.sendMarkdownMessage(42, "**done**", {
    prefixText: "Latest Codex reply",
    message_thread_id: 7,
  });

  assert.equal(telegram.requests.length, 1);
  assert.equal(telegram.requests[0].method, "sendMessage");
  assert.equal(telegram.requests[0].payload.parse_mode, "HTML");
  assert.equal(telegram.requests[0].payload.message_thread_id, 7);
  assert.ok(!Object.hasOwn(telegram.requests[0].payload, "prefixText"));
  assert.match(telegram.requests[0].payload.text, /^Latest Codex reply/);
  assert.match(telegram.requests[0].payload.text, /<b>done<\/b>/);
});
