// 用 Keychain 里的会话查出配置要填的值：你的 user id、工作区子域名、GitHub / Notion / Jira app 给你发通知的 DM channel id。
// 只读，结果以 JSON 打到 stdout，可以直接合进 slack-poller-config.json；cookie 和令牌不出现在输出里。
import {
  defaultWebSocketFactory, guardedWebSocket, makeScrubber, readCookieFromKeychain, scrubbingLogger,
} from "./slack_common.mjs";

const APPS = { github: /github/i, notion: /notion/i, jira: /jira/i };

async function* pages(core, method, fields, key) {
  let cursor = "";
  do {
    const res = await core.callWebApi(method, { ...fields, limit: 1000, ...(cursor ? { cursor } : {}) });
    yield* res[key] || [];
    cursor = res.response_metadata?.next_cursor || "";
  } while (cursor);
}

async function main() {
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
    const me = await core.auth.test();
    const imByUser = new Map();
    for await (const im of pages(core, "conversations.list", { types: "im" }, "channels")) imByUser.set(im.user, im.id);
    const dms = { github: "", notion: "", jira: "" };
    for await (const u of pages(core, "users.list", {}, "members")) {
      if (!u.is_bot || !imByUser.has(u.id)) continue;
      const name = `${u.name} ${u.real_name || ""}`;
      for (const [app, re] of Object.entries(APPS)) if (!dms[app] && re.test(name)) dms[app] = imByUser.get(u.id);
    }
    const domain = String(me.url || "").match(/^https:\/\/([^.]+)\.slack\.com/)?.[1] || "";
    process.stdout.write(JSON.stringify({ identity: { my_user_id: me.user_id, team_domain: domain }, notification_dms: dms }, null, 2) + "\n");
  } finally {
    core.disconnect();
  }
}

main().catch((e) => {
  process.stderr.write("whoami: " + makeScrubber()(e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
