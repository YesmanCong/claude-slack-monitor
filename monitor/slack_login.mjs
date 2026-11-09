// 登录网页版 Slack，把会话 d cookie 存进 macOS Keychain（服务 slack-session-monitor）。
// 另起一个独立 Chrome（临时配置目录，不碰你平时的 Chrome），调试端口只听本机，打开 Slack 登录页。
// 你在弹出的窗口里自己登录；脚本每秒读一次 .slack.com 的 d cookie，拿到后先换一次会话验证，成功才存进 Keychain。
// cookie 等于你的 Slack 登录：只进 Keychain，不写文件、不打日志、不出现在报错里。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultWebSocketFactory, guardedWebSocket, makeScrubber, scrubbingLogger, writeCookieToKeychain,
} from "./slack_common.mjs";

const SIGN_IN_URL = "https://slack.com/signin";
const COOKIE_PREFIX = "xoxd-";
const TIMEOUT_MS = 5 * 60_000;
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const log = (line) => process.stderr.write(line + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function verifies(cookie) {
  const scrub = makeScrubber(cookie);
  const { GabrielCore } = await import("gabriel-slack");
  const core = new GabrielCore({
    auth: { cookieD: cookie },
    logger: scrubbingLogger(scrub),
    createWebSocket: guardedWebSocket(await defaultWebSocketFactory()),
  });
  try {
    await core.initialize();
    return true;
  } catch (e) {
    log("login: cookie 还换不出会话，继续等：" + scrub(e instanceof Error ? e.message : String(e)));
    return false;
  } finally {
    core.disconnect();
  }
}

function openChrome() {
  const path = CHROME_CANDIDATES.find(existsSync);
  if (!path) throw new Error("这台电脑上没找到 Google Chrome，装好再试。");
  const profile = mkdtempSync(join(tmpdir(), "slack-login-"));
  const child = spawn(path, [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", `--app=${SIGN_IN_URL}`,
  ], { stdio: "ignore" });
  let closed = false;
  child.once("exit", () => { closed = true; });
  child.once("error", () => { closed = true; });
  const cleanup = () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } };
  let socket = null;
  const cdp = async () => {
    if (socket?.open()) return socket;
    const file = join(profile, "DevToolsActivePort");
    if (!existsSync(file)) throw new Error("Chrome 还在启动");
    const [port, browserPath] = readFileSync(file, "utf8").split("\n");
    if (!/^\d{1,5}$/.test((port || "").trim()) || !browserPath?.startsWith("/devtools/browser/")) throw new Error("Chrome 还在启动");
    socket = await openCdp(`ws://127.0.0.1:${port.trim()}${browserPath.trim()}`);
    return socket;
  };
  return {
    isClosed: () => closed,
    async cookieD() {
      const result = await (await cdp()).call("Storage.getCookies");
      const cookies = Array.isArray(result.cookies) ? result.cookies : [];
      const d = cookies.find((c) => c?.name === "d" && /(^|\.)slack\.com$/i.test(String(c.domain).replace(/^\./, "")));
      if (!d || typeof d.value !== "string") return null;
      try { return decodeURIComponent(d.value); } catch { return d.value; }
    },
    close() {
      socket?.close();
      if (child.exitCode === null && !child.killed) child.kill();
      cleanup();
    },
  };
}

async function openCdp(url) {
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 5_000 });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let next = 1;
  const pending = new Map();
  ws.on("message", (data) => {
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    const w = typeof m.id === "number" ? pending.get(m.id) : undefined;
    if (!w) return;
    pending.delete(m.id);
    m.error ? w.reject(new Error(m.error.message ?? "CDP error")) : w.resolve(m.result ?? {});
  });
  ws.on("close", () => { for (const w of pending.values()) w.reject(new Error("CDP closed")); pending.clear(); });
  return {
    open: () => ws.readyState === WebSocket.OPEN,
    call(method) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10_000);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        ws.send(JSON.stringify({ id, method }));
      });
    },
    close() { try { ws.close(); } catch { /* best effort */ } },
  };
}

async function main() {
  log("login: 正在打开一个独立的 Chrome，请在窗口里登录你的 Slack（最多等 5 分钟）。");
  const chrome = openChrome();
  const deadline = Date.now() + TIMEOUT_MS;
  const tried = new Set();
  try {
    while (!chrome.isClosed() && Date.now() < deadline) {
      let cookie = null;
      try { cookie = await chrome.cookieD(); } catch { /* Chrome still starting */ }
      if (cookie && cookie.startsWith(COOKIE_PREFIX) && !tried.has(cookie)) {
        tried.add(cookie);
        if (await verifies(cookie)) {
          await writeCookieToKeychain(cookie);
          log("login: 登录成功，会话已存进 Keychain。可以启动监控了。");
          return;
        }
      }
      await sleep(1_000);
    }
    throw new Error(chrome.isClosed() ? "登录窗口关掉了，还没登录成功。" : "等了 5 分钟还没登录成功。");
  } finally {
    chrome.close();
  }
}

main().then(() => process.exit(0), (e) => { log("login: " + (e instanceof Error ? e.message : String(e))); process.exit(1); });
