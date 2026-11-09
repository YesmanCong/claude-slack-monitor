// 网页版 Slack 会话方式的共用件：从 Keychain 读 d cookie、脱敏日志、限制带 cookie 的 WebSocket 只连 Slack。
// 用 gabriel-slack（npm，锁 0.1.1），只有本目录的两个脚本经过这里用它。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const KEYCHAIN_SERVICE = "slack-session-monitor";
export const KEYCHAIN_ACCOUNT = "slack-d-cookie";

// 带 cookie 的连接只发往 Slack 的主机（和 gabriel 的 SLACK_HOST 一致）。
const SLACK_HOST = /(^|\.)slack(-edge|-files)?\.com$/i;

export function slackSocketUrlAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === "wss:" && SLACK_HOST.test(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

// 服务器给的 reconnect_url 没校验主机就连会把 cookie 发出去：这里挡住非 Slack 主机。
export function guardedWebSocket(create) {
  return (url, headers) => {
    if (!slackSocketUrlAllowed(url)) {
      let host = "an invalid address";
      try { host = new URL(url).host; } catch { /* keep the generic text */ }
      throw new Error(`refusing to send the Slack session cookie to ${host}`);
    }
    return create(url, headers);
  };
}

export async function defaultWebSocketFactory() {
  const { default: WebSocket } = await import("ws");
  return (url, headers) => new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 15_000 });
}

// gabriel 自带的脱敏只留令牌前几个字符；这里把整段 cookie、令牌和任何 xox*/xapp 片段都去掉。
export function makeScrubber(...secrets) {
  const live = secrets.filter((s) => typeof s === "string" && s.length >= 6);
  return (text) => {
    let out = String(text);
    for (const s of live) out = out.split(s).join("[REDACTED]");
    return out.replace(/\b(xox[a-z]|xapp)-[A-Za-z0-9-]+/g, "[REDACTED]");
  };
}

// GabrielClient 的 logger：warn/error 写到 stderr，脱敏后再写；debug/info 丢掉。
export function scrubbingLogger(scrub) {
  const write = (level) => (obj, msg) => {
    process.stderr.write(scrub(`session ${level}: ${msg ?? ""} ${safeJson(obj)}`.trim()) + "\n");
  };
  return { debug() {}, info() {}, warn: write("warn"), error: write("error") };
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return ""; }
}

export async function readCookieFromKeychain() {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
    return stdout.trimEnd() || null;
  } catch {
    return null;
  }
}

export async function writeCookieToKeychain(cookie) {
  await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", cookie]);
}
