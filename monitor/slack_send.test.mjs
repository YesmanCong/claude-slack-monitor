// 自检：发送前把裸 URL 包成 <url>；发出后记的那一行日志。跑法：node slack_send.test.mjs
import assert from "node:assert/strict";
import { buildMessage, linkifyBareUrls, sentLogEntry } from "./slack_send.mjs";

const pr = "https://github.com/acme/shop-api/pull/6610";

// 全角标点、中文紧挨着 URL。
assert.equal(linkifyBareUrls(`（PR：${pr}）`), `（PR：<${pr}>）`);
assert.equal(linkifyBareUrls(`看这里${pr}，谢谢`), `看这里<${pr}>，谢谢`);

// 句末英文标点、半边括号不算进 URL；成对的括号保留。
assert.equal(linkifyBareUrls(`see ${pr}.`), `see <${pr}>.`);
assert.equal(linkifyBareUrls(`(PR: ${pr})`), `(PR: <${pr}>)`);
assert.equal(linkifyBareUrls("https://en.wikipedia.org/wiki/Foo_(bar)"), "<https://en.wikipedia.org/wiki/Foo_(bar)>");

// query 带 & 和 =。
assert.equal(linkifyBareUrls("https://a.com/x?a=1&b=2，"), "<https://a.com/x?a=1&b=2>，");

// 已有的链接写法、代码原样保留。
for (const s of [
  `<${pr}>`,
  `<${pr}|#6610>`,
  `[#6610](${pr})`,
  `[${pr}](${pr})`,
  "`https://shop.example.com/returns`",
  "```\nGET https://api.example.com/v4/x\n```",
  "<@U0123ABCD> 没有链接",
]) assert.equal(linkifyBareUrls(s), s);

// 代码和裸 URL 混在一行。
assert.equal(
  linkifyBareUrls(`返回 \`{"url": "https://x.io/returns"}\`，PR：${pr}`),
  `返回 \`{"url": "https://x.io/returns"}\`，PR：<${pr}>`,
);

// buildMessage：block 里是处理过的正文，text（通知和监控识别用）保留原文和前缀。
const { blocks, text } = buildMessage(`PR：${pr}`, "[P]:", "Auto-reply");
assert.equal(blocks[1].text, `PR：<${pr}>`);
assert.equal(text, `[P]: PR：${pr}`);

// 日志行：新发和修改、thread、附件名都记上；时间是本地时间。
const at = new Date(2026, 10, 24, 14, 5, 9);
assert.deepEqual(
  { ...sentLogEntry({ channel: "D0123ABCD", thread: "1700000000.000000", files: [{ filename: "a.png" }] }, "正文", { ts: "1700000001.000000" }, "https://x.slack.com/p1", at), session: undefined },
  { at: "2026-11-24T14:05:09", type: "sent", action: "post", channel_id: "D0123ABCD", thread_ts: "1700000000.000000",
    ts: "1700000001.000000", permalink: "https://x.slack.com/p1", body: "正文", files: ["a.png"], session: undefined },
);
assert.equal(sentLogEntry({ channel: "C0123ABCD", update: "1700000001.000000", files: [] }, "改", { ts: "1700000001.000000" }, null, at).action, "update");

console.log("ok");
