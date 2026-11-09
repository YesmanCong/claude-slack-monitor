// 网页版 Slack 实时消息源：用 Keychain 里的会话 cookie 连 Slack，把要看的消息一条一行 JSON 写到 stdout，交给 slack_poller.py 分诊。
// 收哪些：私信、群私信、@ 我的、GitHub、Notion 和 Jira 通知 DM，外加我 @ 自己（写给 Claude 的话）。细过滤（黑白名单、自动回复、去重）在 Python 那边。
// 断线重连、进程重启后漏掉消息的补拉由 gabriel 的 GabrielClient 负责：各频道收到哪条的水位存在 .gabriel-state/state.json，
// 重启时从水位往后补（补回来的消息 delivery 是 backfill，Python 按 ts 去重）。
// cookie 和令牌只在进程内，不写文件、不打日志、不出现在 stdout 或报错里；state.json 里只有频道 id 和消息 ts。
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultWebSocketFactory, guardedWebSocket, makeScrubber, readCookieFromKeychain, scrubbingLogger,
} from "./slack_common.mjs";

// 身份和通知 DM 的 channel id 来自 slack-poller-config.json，由 slack_poller.py 通过环境变量传进来。
const MY_USER_ID = process.env.SLACK_MY_USER_ID || "";
const GITHUB_DM = process.env.SLACK_GITHUB_DM || "";
const NOTION_DM = process.env.SLACK_NOTION_DM || "";
const JIRA_DM = process.env.SLACK_JIRA_DM || "";
const TEAM_DOMAIN = process.env.SLACK_TEAM_DOMAIN || "app";
// 加入频道、改名这类系统消息不要。
const SKIP_SUBTYPES = new Set([
  "channel_join", "channel_leave", "group_join", "group_leave",
  "channel_topic", "channel_purpose", "channel_name", "channel_archive", "channel_unarchive",
]);

const log = (line) => process.stderr.write(line + "\n");
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function sourceOf(ch) {
  if (ch.id === GITHUB_DM) return "github";
  if (ch.id === NOTION_DM) return "notion";
  if (ch.id === JIRA_DM) return "jira";
  if (ch.isIm || ch.isMpim) return "dm";
  return "mention";
}

function channelName(ch, sender) {
  if (ch.id === GITHUB_DM) return "DM: GitHub";
  if (ch.id === NOTION_DM) return "DM: Notion";
  if (ch.id === JIRA_DM) return "DM: Jira";
  if (ch.isIm) return `DM: ${sender.displayName || sender.name || sender.id}`;
  return ch.name || (ch.isMpim ? "Group DM" : ch.id);
}

function permalink(channelId, ts, threadTs) {
  const base = `https://${TEAM_DOMAIN}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base;
}

export function toItem(evt) {
  // gabriel does not mark the self-DM as isIm; every DM channel id starts with "D".
  const ch = { ...evt.channel, ...(evt.channel?.id?.startsWith("D") ? { isIm: true } : {}) };
  const sender = evt.sender || {};
  // Bot messages (e.g. GitHub) carry their content in blocks; text can be empty while markdown has it.
  const text = evt.text || evt.markdown || "";
  const mineSelfMention = sender.id === MY_USER_ID && text.includes(`<@${MY_USER_ID}`);
  if (!(ch.isIm || ch.isMpim || evt.isMentioningMe || ch.id === GITHUB_DM || mineSelfMention)) return null;
  if (evt.subtype && SKIP_SUBTYPES.has(evt.subtype)) return null;
  return {
    source: sourceOf(ch),
    channel_id: ch.id,
    channel_name: channelName(ch, sender),
    user_id: sender.id,
    user_name: sender.displayName || sender.name || sender.id,
    is_bot: evt.origin === "bot" || sender.isBot === true || evt.subtype === "bot_message",
    ts: evt.ts,
    thread_ts: evt.threadTs || null,
    text,
    permalink: permalink(ch.id, evt.ts, evt.threadTs),
  };
}

async function main() {
  const cookie = await readCookieFromKeychain();
  if (!cookie) {
    emit({ __event__: "need_login", note: "Keychain 里没有会话 cookie" });
    log("source: 还没登录，先跑 node slack_login.mjs");
    process.exit(2);
  }
  const scrub = makeScrubber(cookie);
  const { GabrielClient, FileStateStore } = await import("gabriel-slack");
  const client = GabrielClient.fromCookie({
    cookieD: cookie,
    stateStore: new FileStateStore({ dir: fileURLToPath(new URL("./.gabriel-state", import.meta.url)) }),
    // 我 @ 自己是写给 Claude 的话，所以要收到自己发的消息；自己普通消息和 Claude 代发的回复由 Python 丢掉。
    loopGuard: { includeSelfMessages: true },
    logger: scrubbingLogger(scrub),
    advanced: { createWebSocket: guardedWebSocket(await defaultWebSocketFactory()) },
  });

  client.on("message.created", (evt) => {
    try {
      const item = toItem(evt);
      if (item && item.channel_id && item.ts) emit(item);
    } catch (e) {
      log("source: 处理消息出错：" + scrub(e instanceof Error ? e.message : String(e)));
    }
  });
  client.on("auth.dead", () => {
    emit({ __event__: "need_login", note: "会话已失效（SSO 过期或已登出）" });
    log("source: 会话失效，需要重新登录");
    void client.stop({ drainMs: 2_000 }).finally(() => process.exit(3));
  });
  client.onError((e) => log("source: " + scrub(e instanceof Error ? e.message : String(e))));

  const bye = () => { void client.stop({ drainMs: 5_000 }).finally(() => process.exit(0)); };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);

  await client.start();
  log("source: 已连上 Slack，开始实时收消息");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    emit({ __event__: "need_login", note: "连接失败" });
    process.stderr.write("source: 启动失败：" + makeScrubber()(e instanceof Error ? e.message : String(e)) + "\n");
    process.exit(1);
  });
}
