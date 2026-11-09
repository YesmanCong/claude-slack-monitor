// 自检：消息映射和安全修补。跑法：node slack_source.test.mjs
import assert from "node:assert/strict";
import { slackSocketUrlAllowed, makeScrubber } from "./slack_common.mjs";
Object.assign(process.env, {
  SLACK_MY_USER_ID: "UME000001", SLACK_TEAM_DOMAIN: "example",
  SLACK_GITHUB_DM: "DGITHUB01", SLACK_NOTION_DM: "DNOTION01", SLACK_JIRA_DM: "DJIRA0001",
});
const { toItem } = await import("./slack_source.mjs");

const ev = (o) => ({ text: "", markdown: "", isMentioningMe: false, origin: "other_user", sender: {}, channel: {}, ...o });

// GitHub 通知 DM：source=github、is_bot、permalink。
let it = toItem(ev({ channel: { id: "DGITHUB01", isIm: true }, sender: { id: "B1", isBot: true }, origin: "bot", ts: "1793698402.448139", markdown: "approved PR" }));
assert.equal(it.source, "github");
assert.equal(it.is_bot, true);
assert.equal(it.channel_name, "DM: GitHub");
assert.equal(it.text, "approved PR");
assert.equal(it.permalink, "https://example.slack.com/archives/DGITHUB01/p1793698402448139");

// Notion 通知 DM：正文在 blocks 里，text 为空时用 markdown。
it = toItem(ev({ channel: { id: "DNOTION01", isIm: true }, sender: { id: "UBOT00001", isBot: true }, origin: "bot", ts: "1793781350.810999", markdown: "Alice mentioned you in a page" }));
assert.equal(it.source, "notion");
assert.equal(it.channel_name, "DM: Notion");
assert.equal(it.text, "Alice mentioned you in a page");

// 别人发的普通 DM：source=dm。
it = toItem(ev({ channel: { id: "DPEER0001", isIm: true }, sender: { id: "U9", displayName: "Bob", isBot: false }, ts: "1.000002", text: "hi" }));
assert.equal(it.source, "dm");
assert.equal(it.user_name, "Bob");
assert.equal(it.is_bot, false);

// 频道里 @ 我：source=mention，带 thread permalink。
it = toItem(ev({ channel: { id: "CPZ", name: "proj-demo" }, sender: { id: "U9", displayName: "Carol" }, isMentioningMe: true, ts: "2.000003", threadTs: "1.000001", text: "<@UME000001> look" }));
assert.equal(it.source, "mention");
assert.equal(it.thread_ts, "1.000001");
assert.equal(it.permalink, "https://example.slack.com/archives/CPZ/p2000003?thread_ts=1.000001&cid=CPZ");

// 我在频道里 @ 自己（写给 Claude）：虽然不是别人提到我，也要收。
it = toItem(ev({ channel: { id: "CPZ", name: "proj-demo" }, sender: { id: "UME000001" }, ts: "3.000004", text: "<@UME000001> 去查一下" }));
assert.ok(it, "self-mention should be kept");
assert.equal(it.user_id, "UME000001");

// 我在给自己的私信里 @ 自己：gabriel 不标 isIm，按 D 前缀认成 dm。
it = toItem(ev({ channel: { id: "DSELF0001", name: "@me" }, sender: { id: "UME000001", displayName: "me" }, ts: "3.500000", text: "<@UME000001> sup" }));
assert.equal(it.source, "dm");
assert.equal(it.channel_name, "DM: me");

// 我在频道里发的普通消息（没 @ 自己、没被别人 @）：不收。
assert.equal(toItem(ev({ channel: { id: "CPZ", name: "proj-demo" }, sender: { id: "UME000001" }, ts: "4.0", text: "随便说一句" })), null);

// 系统消息（加入频道）：不收。
assert.equal(toItem(ev({ channel: { id: "CPZ" }, isMentioningMe: true, subtype: "channel_join", ts: "5.0", text: "x" })), null);

// WebSocket 主机白名单：只认 wss + Slack 主机。
assert.equal(slackSocketUrlAllowed("wss://wss-primary.slack.com/link"), true);
assert.equal(slackSocketUrlAllowed("wss://evil.example.com/x"), false);
assert.equal(slackSocketUrlAllowed("ws://wss-primary.slack.com/x"), false);

// 脱敏：cookie、xoxc 令牌都去掉。
const scrub = makeScrubber("xoxd-abc123secretcookie");
assert.ok(!scrub("boom xoxd-abc123secretcookie xoxc-9988776655tok end").includes("xoxd-abc123"));
assert.ok(!scrub("tok xoxc-9988776655tok end").includes("xoxc-9988776655"));

console.log("ok");
