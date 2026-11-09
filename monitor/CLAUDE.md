# Slack 监控会话

这个目录的会话是长期置顶的 Slack 监控会话，上下文 compact 之后也按这里接着做：

- 做法以 `slack-monitor.md` 为准，收到 `[slack-poller]` 开头的推送就按它的「收到推送后」处理。
- 待处理事项在 `slack-monitor-state.json` 的 `pending`，不靠对话记忆。
- 监控脚本 `slack_poller.py` 是本会话的后台子进程，它再拉起 `node slack_source.mjs` 用网页版 Slack 的会话实时收消息（cookie 存在 macOS Keychain，服务 `slack-session-monitor`）。设置页 http://127.0.0.1:8765 。设置页打不开、或者会话重启过，就按下面重新启动：
  - 没登录过、或会话失效时，先 `node slack_login.mjs`，用户在弹出的 Chrome 里自己登录（cookie 自动进 Keychain）。
  - 然后在本目录后台跑 `python3 -I slack_poller.py`（run_in_background），不要另开终端跑，否则推不进本会话。首次换机或删过 node_modules 要先 `npm ci`。
