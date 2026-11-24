// 自检：从搜索结果里认出代发的消息、拼出日志行。跑法：node slack_backfill.test.mjs
import assert from "node:assert/strict";
import { logEntry, sentByAgent } from "./slack_backfill.mjs";

const prefixes = ["[P 😼]:", "[P :smirk_cat:]:"];
const permalink = "https://x.slack.com/archives/C1/p1795486240755199?thread_ts=1795424165.127879&cid=C1";

// 通知文字带前缀（emoji 被 Slack 存成 shortcode）：正文是前缀后面的部分，实体还原。
assert.equal(sentByAgent({ text: "[P :smirk_cat:]: a &amp; b &lt;c&gt;" }, prefixes, "H"), "a & b <c>");
// 文字里没有前缀，但第一个 block 是那行小字：正文取 markdown block。
assert.equal(sentByAgent({ text: "正文", blocks: [{ type: "context", elements: [{ text: "H" }] }, { type: "markdown", text: "正文 md" }] }, prefixes, "H"), "正文 md");
// 用户自己打的消息：不算。
assert.equal(sentByAgent({ text: "我自己发的", blocks: [{ type: "rich_text" }] }, prefixes, "H"), null);

const entry = logEntry({ ts: "1795486240.755199", permalink, channel: { id: "C1" } }, "正文", "dev-chat");
assert.deepEqual({ ...entry, at: undefined }, { at: undefined, type: "sent", action: "post", channel_id: "C1", channel_name: "dev-chat",
  thread_ts: "1795424165.127879", ts: "1795486240.755199", permalink, body: "正文", backfilled: true });
assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
assert.equal("thread_ts" in logEntry({ ts: "1.000001", permalink: "https://x.slack.com/archives/D1/p1000001", channel: { id: "D1" } }, "b", "私信 A"), false);

console.log("ok");
