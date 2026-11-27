"""UserPromptSubmit and Stop hook: keep the list of tasks the monitor session is working on. The slack-tasks mod draws it above the prompt."""
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

TASKS_PATH = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "slack-tasks.json"
POLLER_PREFIX = "[slack-poller]"
BOARD_PREFIX = "[待办看板]"
TITLE_MAX = 80
SUMMARY_MAX = 200
KEPT_TASKS = 20
# A turn shorter than this is a glance or a one-line reply and never enters the list. Two thirds of the monitor session's turns end sooner.
QUICK_SECONDS = 20


def name_sender(item):
    # Slack display names carry a team suffix ("Alice Wang (ENG - BE)"); the name alone tells who it is.
    name = re.sub(r"\s*\([^)]*\)\s*$", "", item.get("user_name") or "")
    channel = item.get("channel_name") or ""
    return " · ".join(part for part in (name, "" if channel.startswith("DM") else channel) if part) or "未知来源"


def clean_text(text):
    """Slack writes a link as <url|label> or <url>: keep the label, or the address without its scheme."""
    text = re.sub(r"<https?://[^|>]+\|([^>]+)>", r"\1", text)
    text = re.sub(r"<https?://([^>]+)>", r"\1", text)
    return " ".join(text.split())


def describe_task(prompt):
    """Sender, title, link and quietness of the task a prompt starts; None when the prompt is not a task."""
    head, *rows = prompt.lstrip().split("\n")
    if head.startswith(BOARD_PREFIX):
        return {"title": head.removeprefix(BOARD_PREFIX).strip()[:TITLE_MAX], "quiet": False}
    if not head.startswith(POLLER_PREFIX):
        return None
    items = []
    for row in rows:
        try:
            item = json.loads(row)
        except ValueError:
            continue
        if isinstance(item, dict):
            items.append(item)
    if not items:
        # A timed check carries no message rows ("[slack-poller] 10:30 跟进检查：…") and runs every few minutes, so it is announced nowhere and leaves the list when it ends.
        label = re.sub(r"^\d{2}:\d{2}\s*", "", head.removeprefix(POLLER_PREFIX).strip()).split("：")[0]
        return {"title": label[:TITLE_MAX], "quiet": True}
    if len(items) == 1:
        sender, title = name_sender(items[0]), clean_text(str(items[0].get("text") or ""))
    else:
        sender, title = f"{len(items)} 条消息", "、".join(dict.fromkeys(name_sender(item) for item in items))
    task = {"sender": sender, "title": title[:TITLE_MAX], "quiet": False}
    permalink = str(items[0].get("permalink") or "")
    if permalink.startswith("https://"):
        task["permalink"] = permalink
    return task


def end_tasks(tasks, session_id, now, summary):
    """Close what this session has running: a quiet or a quick task leaves the list, the others stay until the person removes them."""
    ended = []
    for task in tasks:
        is_running = task.get("session_id") == session_id and "ended" not in task
        if is_running and (task.get("quiet") or now.timestamp() * 1000 < task.get("listed_from_ms", 0)):
            continue
        ended.append({**task, "ended": f"{now:%H:%M}", "summary": summary} if is_running else task)
    return ended


def start_task(tasks, described, session_id, now):
    """A new prompt means this session's earlier turn is over, so what it left running is closed first."""
    started = {"id": f"{session_id}:{now:%Y%m%d%H%M%S}", "session_id": session_id, **described, "started": f"{now:%H:%M}",
               "listed_from_ms": int((now.timestamp() + QUICK_SECONDS) * 1000)}
    return [*end_tasks(tasks, session_id, now, ""), started][-KEPT_TASKS:]


def main():
    payload = json.load(sys.stdin)
    session_id = str(payload.get("session_id") or "")
    now = dt.datetime.now()
    try:
        tasks = json.loads(TASKS_PATH.read_text())
    except (OSError, ValueError):
        tasks = []
    if not isinstance(tasks, list):
        tasks = []
    if payload.get("hook_event_name") == "Stop":
        updated = end_tasks(tasks, session_id, now, str(payload.get("last_assistant_message") or "").strip()[:SUMMARY_MAX])
    else:
        described = describe_task(str(payload.get("prompt") or ""))
        updated = start_task(tasks, described, session_id, now) if described else tasks
    if updated != tasks:
        # The mod reads this file every few seconds; replacing it whole keeps a half-written list out of its sight.
        draft = TASKS_PATH.with_suffix(".json.tmp")
        draft.write_text(json.dumps(updated, ensure_ascii=False))
        draft.replace(TASKS_PATH)


if __name__ == "__main__":
    main()
