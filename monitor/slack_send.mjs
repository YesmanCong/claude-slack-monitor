// 以用户本人的网页版 Slack 会话发一条代发消息：顶部一行灰色小字标出是 agent 代发（identity.agent_reply_header），下面是正文。
// 正文从 stdin 读，按 Slack 的 markdown block 渲染；用法：
//   node slack_send.mjs --channel D0123ABCD [--thread 1700000000.000000] < body.md
//   node slack_send.mjs --channel D0123ABCD --update <要改的那条 ts> < body.md   （改自己发过的一条）
//   node slack_send.mjs --channel D0123ABCD [--thread ...] --file a.png [--file b.png] < body.md
//     （正文发完再把文件传到同一个 channel / thread；--file 可重复，不能和 --update 一起用）
// 成功时 stdout 打出 {"ts": ..., "permalink": ..., "files": [...]}；cookie 和令牌不出现在任何输出里。
import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import {
  defaultWebSocketFactory, guardedWebSocket, makeScrubber, readCookieFromKeychain, scrubbingLogger,
} from "./slack_common.mjs";

const DEFAULT_HEADER = "Auto-reply from agent";
// markdown block 单块上限 12000 字符，超出就拆成几块。
const MARKDOWN_BLOCK_MAX = 12000;
const FILE_SIZE_MAX = 50 << 20;
// 全局安全规约禁止读取这些文件，上传等于外发，一并拦掉。
const FORBIDDEN_FILE_PATTERN = /(^\.env(\..*)?$|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519|ecdsa)$|^credentials|^secrets\.)/i;
const ALLOWED_ENV_FILES = new Set([".env.example", ".env.sample", ".env.template"]);
const MIME_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
};

function parseArgs(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (name === "--channel") args.channel = value;
    else if (name === "--thread") args.thread = value;
    else if (name === "--update") args.update = value;
    else if (name === "--file") args.files.push(checkedFile(value));
    else throw new Error(`unknown argument ${name}`);
  }
  if (!/^[CDG][A-Z0-9]{6,}$/.test(args.channel ?? "")) throw new Error("--channel must be a Slack channel id like D0123ABCD");
  for (const key of ["thread", "update"]) {
    if (args[key] !== undefined && !/^\d{10}\.\d{6}$/.test(args[key])) throw new Error(`--${key} must be a Slack ts like 1700000000.000000`);
  }
  if (args.update && args.files.length > 0) throw new Error("--file cannot be combined with --update");
  return args;
}

function checkedFile(path) {
  if (!path) throw new Error("--file needs a path");
  const absolute = resolve(path);
  const filename = basename(absolute);
  if (FORBIDDEN_FILE_PATTERN.test(filename) && !ALLOWED_ENV_FILES.has(filename)) {
    throw new Error(`--file ${filename} looks like a credential file and is not uploaded`);
  }
  const stat = statSync(absolute);
  if (!stat.isFile()) throw new Error(`--file ${filename} is not a regular file`);
  if (stat.size === 0 || stat.size > FILE_SIZE_MAX) throw new Error(`--file ${filename} must be 1 byte to 50 MB`);
  return { absolute, filename, size: stat.size, mimeType: MIME_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream" };
}

// 与 gabriel-slack FilesApi.upload 相同的三步：getUploadURL → POST 字节 → completeUpload（带 channel 即分享）。
async function uploadFile(core, file, channel, threadTs) {
  const step1 = await core.callWebApi("files.getUploadURL", { filename: file.filename, length: file.size }, { reason: "upload-queue" });
  if (!step1.file || !step1.upload_url) throw new Error("files.getUploadURL returned no upload URL");
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file.absolute)], { type: file.mimeType }), file.filename);
  const resp = await core.http.fetchAuthenticated(step1.upload_url, {
    method: "POST", body: form, signal: AbortSignal.timeout(10 * 60_000),
  }, { bearer: false });
  await resp.body?.cancel().catch(() => {});
  if (!resp.ok) throw new Error(`upload of ${file.filename} failed (HTTP ${resp.status})`);
  await core.callWebApi("files.completeUpload", {
    files: [{ id: step1.file, title: file.filename }],
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  }, { reason: "upload-queue", retry: "none" });
  return { id: step1.file, filename: file.filename };
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
    const posted = args.update
      ? await core.callWebApi("chat.update", { channel: args.channel, ts: args.update, text, blocks: JSON.stringify(blocks) })
      : await core.callWebApi("chat.postMessage", {
        channel: args.channel,
        text,
        blocks: JSON.stringify(blocks),
        unfurl_links: false,
        ...(args.thread ? { thread_ts: args.thread } : {}),
      });
    const link = await core.callWebApi("chat.getPermalink", { channel: args.channel, message_ts: posted.ts });
    const files = [];
    for (const file of args.files) files.push(await uploadFile(core, file, args.channel, args.thread));
    process.stdout.write(JSON.stringify({ ts: posted.ts, permalink: link.permalink, ...(files.length ? { files } : {}) }) + "\n");
  } finally {
    core.disconnect();
  }
}

main().catch((e) => {
  process.stderr.write("slack_send: " + makeScrubber()(e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
