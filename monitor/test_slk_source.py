import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import slack_poller as poller


IDENTITY = {"my_user_id": "U123"}
CONFIG = {**poller.DEFAULT_CONFIG, "identity": IDENTITY, "notification_dms": {"github": "D123"}}


def activity(kind, channel, ts, text="hello", author="U789", is_bot=False):
    return {"kind": kind, "channel_id": channel, "ts": ts, "text": text, "author_id": author, "is_bot": is_bot}


class SlkSourceTests(unittest.TestCase):
    def test_routes_recent_messages_and_preserves_message_locations(self):
        permalink = "https://example.slack.com/archives/D123/p1760000000000002"
        payload = [
            activity("dm", "D456", "1760000000.000005"),
            activity("thread_v2", "C456", "1760000000.000004"),
            activity("thread_v2", "C456", "1760000000.000003", "<@U123> review?"),
            {**activity("bot_dm_bundle", "D123", "1760000000.000002", is_bot=True), "permalink": permalink},
            activity("at_user", "C123", "1760000000.000001", author="U123"),
        ]

        items = poller.slk_items(payload, CONFIG)

        self.assertEqual([item["source"] for item in items], ["github", "mention", "dm"])
        self.assertEqual(items[0]["channel_name"], "DM: GitHub")
        self.assertEqual(items[0]["permalink"], permalink)
        self.assertTrue(items[0]["is_bot"])
        self.assertEqual(items[1]["user_name"], "U789")

    def test_live_routes_group_dms_mentions_and_self_commands(self):
        payload = [
            activity("message", "C123", "1760000000.000001", "normal channel traffic"),
            activity("message", "G123", "1760000000.000002", "private channel traffic"),
            {**activity("message", "G123", "1760000000.000003"), "is_dm": True},
            activity("message", "C123", "1760000000.000004", "<@U123> hello", author="U123"),
            activity("message", "D123", "1760000000.000005", is_bot=True),
            activity("message", "D456", "1760000000.000006", author="U123"),
        ]
        items = poller.slk_items(payload, CONFIG)
        self.assertEqual([item["source"] for item in items], ["dm", "mention", "github"])
        self.assertTrue(poller.is_talking_to_claude(items[1], CONFIG))

    def test_watch_args_resume_from_latest_checkpoint_and_migrate_polling_state(self):
        now = int(poller.time.time())
        opts = {"binary": "./slk", "workspace": "example"}
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            with patch.object(poller, "STATE_PATH", state):
                poller.save_json(state, {"slk_polled_at": now - 3600})
                self.assertEqual(poller.slk_watch_command(CONFIG, opts)[1:],
                                 ["watch", "--since", str(now - 3660), "--workspace", "example"])
                poller.save_slk_checkpoint("example", now - 1200)
                self.assertEqual(poller.slk_watch_command(CONFIG, opts)[3], str(now - 1260))
                poller.save_slk_checkpoint("example", now - 1820)
                self.assertEqual(poller.slk_watch_command(CONFIG, opts)[3], str(now - 1260))
                other = poller.slk_watch_command(CONFIG, {**opts, "workspace": "other"})
                self.assertLessEqual(abs(int(other[3]) - (now - 600)), 2)

    def test_consume_reconnect_retains_gap_until_success(self):
        now = int(poller.time.time())
        live = activity("message", "D456", f"{now - 10}.000001")
        stream = [{"__event__": "connected"}, {"__event__": "catchup_error"}, live,
                  {"__event__": "disconnected"}, {"__event__": "caught_up", "through": now - 8},
                  {"__event__": "connected"}, {"__event__": "caught_up", "through": now - 5}]
        received = []
        checkpoints = []
        with patch.multiple(poller, status={"state": "starting"}, accept_item=received.append,
                            save_slk_checkpoint=lambda ws, ts: checkpoints.append((ws, ts))):
            poller.consume_slk(SimpleNamespace(stdout=map(json.dumps, stream)), CONFIG, "example")
            self.assertEqual(poller.status["state"], "connected")
            self.assertIsNone(poller.status["last_error"])
        self.assertEqual([item["source"] for item in received], ["dm"])
        self.assertEqual(checkpoints, [("example", now - 5)])

    def test_reconnect_errors_are_reported_once_after_three_failures(self):
        event = json.dumps({"__event__": "disconnected"})
        reports = []
        with patch.multiple(poller, status={"state": "connecting"}, push_to_session=reports.append):
            poller.consume_slk(SimpleNamespace(stdout=[event] * 4), CONFIG, "")
        self.assertEqual(len(reports), 1)
        self.assertIn("连续 3 次连接失败", reports[0])

    def test_watch_executes_configured_binary_and_drops_raw_stderr(self):
        payload = activity("message", "D456", "1760000000.000001")
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "slk"
            binary.write_text(
                "#!/usr/bin/env python3\n"
                "import os, sys\n"
                "assert sys.argv[1:3] == ['watch', '--since']\n"
                "assert sys.argv[4:] == ['--workspace', 'workspace']\n"
                "assert not {'SLK_DEBUG', 'CLAUDE_CODE_MESSAGING_SOCKET',"
                " 'CLAUDE_CODE_MESSAGING_TOKEN'} & os.environ.keys()\n"
                f"print({json.dumps(json.dumps({'__event__': 'connected'}))})\n"
                f"print({json.dumps(json.dumps(payload))})\n"
                "print('private annotation', file=sys.stderr)\n"
            )
            binary.chmod(0o755)
            received = []
            with patch.multiple(poller, STATE_PATH=Path(directory) / "state.json", status={},
                                accept_item=received.append):
                with patch.dict(os.environ, {"SLK_DEBUG": "1", "CLAUDE_CODE_MESSAGING_TOKEN": "placeholder"}):
                    poller.stream_slk({**CONFIG, "slk": {"binary": str(binary), "workspace": "workspace"}})
                self.assertEqual(poller.status["state"], "connected")
                self.assertIsNone(poller.status["last_error"])
            self.assertIsNone(poller.current_proc[0])
            self.assertEqual([item["channel_id"] for item in received], ["D456"])

    def test_dedup_persists_channel_keys_and_honors_legacy_timestamps(self):
        ts = f"{int(poller.time.time())}.000001"
        duplicate = f"{int(poller.time.time())}.000002"
        payload = [
            activity("dm", "D456", ts),
            activity("dm", "D789", ts),
            activity("dm", "D456", duplicate),
        ]
        first, second, legacy = poller.slk_items(payload, CONFIG)
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            state_path = Path(directory) / "state.json"
            poller.save_json(config_path, CONFIG)
            poller.save_json(state_path, {"seen": {duplicate: poller.time.time()}})
            with patch.multiple(poller, CONFIG_PATH=config_path, STATE_PATH=state_path,
                                batch=[], recent=poller.deque(), status={}):
                for item in (first, second, first, legacy):
                    poller.accept_item(item)
                self.assertEqual([item["channel_id"] for item in poller.batch], ["D456", "D789"])
            self.assertEqual(set(poller.load_json(state_path, {})["seen"]), {
                f"D456:{ts}", f"D789:{ts}", duplicate,
            })


if __name__ == "__main__":
    unittest.main()
