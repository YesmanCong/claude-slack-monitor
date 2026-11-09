// 以用户本人的网页版 Slack 会话发一条代发消息：顶部一行灰色小字标出是 agent 代发（identity.agent_reply_header），下面是正文。
// 正文从 stdin 读，按 Slack 的 markdown block 渲染；用法：
//   node slack_send.mjs --channel D0123ABCD [--thread 1700000000.000000] < body.md
// 成功时 stdout 打出 {"ts": ..., "permalink": ...}；cookie 和令牌不出现在任何输出里。
import { readFileSync } from "node:fs";

import {
  defaultWebSocketFactory, guardedWebSocket, makeScrubber, readCookieFromKeychain, scrubbingLogger,
} from "./slack_common.mjs";

const DEFAULT_HEADER = "Auto-reply from agent";
// markdown block 单块上限 12000 字符，超出就拆成几块。
const MARKDOWN_BLOCK_MAX = 12000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (name === "--channel") args.channel = value;
    else if (name === "--thread") args.thread = value;
    else throw new Error(`unknown argument ${name}`);
  }
  if (!/^[CDG][A-Z0-9]{6,}$/.test(args.channel ?? "")) throw new Error("--channel must be a Slack channel id like D0123ABCD");
  if (args.thread !== undefined && !/^\d{10}\.\d{6}$/.test(args.thread)) throw new Error("--thread must be a Slack ts like 1700000000.000000");
  return args;
}

function buildMessage(body, prefix, header) {
  const chunks = [];
  for (let rest = body; rest.length > 0; rest = rest.slice(MARKDOWN_BLOCK_MAX)) chunks.push(rest.slice(0, MARKDOWN_BLOCK_MAX));
  return {
    blocks: [
      { type: "context", elements: [{ type: "mrkdwn", text: header }] },
      ...chunks.map((text) => ({ type: "markdown", text })),
    ],
    // 通知和监控读的是 text：开头保留代发前缀，监控靠它认出自己发的、不推回来。
    text: `${prefix} ${body}`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = readFileSync(0, "utf8").trim();
  if (body === "") throw new Error("message body on stdin is empty");
  const config = JSON.parse(readFileSync(new URL("./slack-poller-config.json", import.meta.url), "utf8"));
  const prefix = config.identity?.agent_reply_prefixes?.[0];
  if (!prefix) throw new Error("identity.agent_reply_prefixes is empty in slack-poller-config.json");
  const header = config.identity?.agent_reply_header || DEFAULT_HEADER;

  const cookie = await readCookieFromKeychain();
  if (!cookie) throw new Error("Keychain 里没有会话，先跑 node slack_login.mjs");
  const scrub = makeScrubber(cookie);
  const { GabrielCore } = await import("gabriel-slack");
  const core = new GabrielCore({
    auth: { cookieD: cookie },
    logger: scrubbingLogger(scrub),
    createWebSocket: guardedWebSocket(await defaultWebSocketFactory()),
  });
  try {
    await core.initialize();
    const { blocks, text } = buildMessage(body, prefix, header);
    const posted = await core.callWebApi("chat.postMessage", {
      channel: args.channel,
      text,
      blocks: JSON.stringify(blocks),
      unfurl_links: false,
      ...(args.thread ? { thread_ts: args.thread } : {}),
    });
    const link = await core.callWebApi("chat.getPermalink", { channel: args.channel, message_ts: posted.ts });
    process.stdout.write(JSON.stringify({ ts: posted.ts, permalink: link.permalink }) + "\n");
  } finally {
    core.disconnect();
  }
}

main().catch((e) => {
  process.stderr.write("slack_send: " + makeScrubber()(e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
