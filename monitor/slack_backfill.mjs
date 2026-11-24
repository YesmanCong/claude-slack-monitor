// 把某一天 Claude 替你发出的 Slack 消息从 Slack 搜回来，补进 slack-activity-log.jsonl（设置页「记录」读它）。
// 用法：node slack_backfill.mjs [YYYY-MM-DD]（不写就是今天）。
// 只读 Slack，不发消息；日志里已经有的（同一个 channel 和 ts）不重复写。cookie 和令牌不出现在任何输出里。
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  defaultWebSocketFactory, guardedWebSocket, makeScrubber, readCookieFromKeychain, scrubbingLogger,
} from "./slack_common.mjs";

const ACTIVITY_LOG = new URL("./slack-activity-log.jsonl", import.meta.url);

export function localIso(ts) {
  const date = new Date(Number(ts) * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

const unescapeSlack = (text) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

// 代发的消息有两个记号：通知文字以代发前缀开头，第一个 block 是那行小字。搜索结果里两个都可能被 Slack 改写，认到一个就算。
export function sentByAgent(match, prefixes, header) {
  const text = unescapeSlack(match.text ?? "");
  const prefix = prefixes.find((p) => text.startsWith(p));
  if (prefix) return text.slice(prefix.length).trim();
  const first = match.blocks?.[0];
  const mark = first?.type === "context" ? unescapeSlack(first.elements?.[0]?.text ?? "") : "";
  if (!mark || !(mark === header || prefixes.some((p) => mark.startsWith(p)))) return null;
  const body = (match.blocks ?? []).filter((b) => b.type === "markdown").map((b) => b.text).join("");
  return (body || text).trim();
}

export function logEntry(match, body, channelName) {
  const threadTs = new URL(match.permalink).searchParams.get("thread_ts");
  return {
    at: localIso(match.ts),
    type: "sent",
    action: "post",
    channel_id: match.channel.id,
    channel_name: channelName,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ts: match.ts,
    permalink: match.permalink,
    body,
    backfilled: true,
  };
}

async function main() {
  const day = process.argv[2] ?? localIso(Date.now() / 1000).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("日期要写成 YYYY-MM-DD");
  const config = JSON.parse(readFileSync(new URL("./slack-poller-config.json", import.meta.url), "utf8"));
  const { my_user_id: me, agent_reply_prefixes: prefixes = [], agent_reply_header: header = "" } = config.identity ?? {};
  if (!me || prefixes.length === 0) throw new Error("slack-poller-config.json 的 identity 里没有 my_user_id 或 agent_reply_prefixes");

  const logged = new Set();
  if (existsSync(ACTIVITY_LOG)) {
    for (const line of readFileSync(ACTIVITY_LOG, "utf8").split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "sent") logged.add(`${entry.channel_id}:${entry.ts}`);
      } catch { /* a blank or damaged line is not a logged message */ }
    }
  }

  const cookie = await readCookieFromKeychain();
  if (!cookie) throw new Error("Keychain 里没有会话，先跑 node slack_login.mjs");
  const { GabrielCore } = await import("gabriel-slack");
  const core = new GabrielCore({
    auth: { cookieD: cookie },
    logger: scrubbingLogger(makeScrubber(cookie)),
    createWebSocket: guardedWebSocket(await defaultWebSocketFactory()),
  });
  try {
    await core.initialize();
    const matches = [];
    for (let page = 1; ; page += 1) {
      const res = await core.callWebApi("search.messages", {
        query: `from:<@${me}> on:${day}`, count: 100, page, sort: "timestamp", sort_dir: "asc",
      });
      matches.push(...(res.messages?.matches ?? []));
      if (page >= (res.messages?.paging?.pages ?? 1)) break;
    }

    const dmNames = new Map();
    const entries = [];
    let alreadyLogged = 0;
    for (const match of matches) {
      const body = sentByAgent(match, prefixes, header);
      if (body === null) continue;
      if (logged.has(`${match.channel.id}:${match.ts}`)) { alreadyLogged += 1; continue; }
      let name = match.channel.name ?? "";
      if (match.channel.is_im) {
        const other = match.channel.user ?? match.channel.name;
        if (!dmNames.has(other)) {
          const info = await core.callWebApi("users.info", { user: other }).catch(() => null);
          dmNames.set(other, info?.user?.profile?.display_name || info?.user?.real_name || other);
        }
        name = `私信 ${dmNames.get(other)}`;
      }
      entries.push(logEntry(match, body, name));
    }
    entries.sort((a, b) => Number(a.ts) - Number(b.ts));
    if (entries.length > 0) appendFileSync(ACTIVITY_LOG, entries.map((e) => JSON.stringify(e) + "\n").join(""));
    process.stdout.write(JSON.stringify({
      day, your_messages: matches.length, sent_by_claude: entries.length + alreadyLogged, added: entries.length, already_logged: alreadyLogged,
    }) + "\n");
  } finally {
    core.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    process.stderr.write("slack_backfill: " + makeScrubber()(e instanceof Error ? e.message : String(e)) + "\n");
    process.exit(1);
  });
}
