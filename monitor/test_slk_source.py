import json
import os
from pathlib import Path
import tempfile
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

    def poll_expecting_window(self, last_polled_at, expected_within):
        payload = [activity("dm", "D456", "1760000000.000001")]
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "slk"
            binary.write_text(
                "#!/usr/bin/env python3\n"
                "import os, sys\n"
                f"assert sys.argv[1:] == ['recent', '--within', '{expected_within}', '--workspace', 'workspace']\n"
                "assert not {'SLK_DEBUG', 'CLAUDE_CODE_MESSAGING_SOCKET',"
                " 'CLAUDE_CODE_MESSAGING_TOKEN'} & os.environ.keys()\n"
                f"print({json.dumps(json.dumps(payload))})\n"
            )
            binary.chmod(0o755)
            opts = {"binary": str(binary), "workspace": "workspace"}
            with patch.dict(os.environ, {"SLK_DEBUG": "1", "CLAUDE_CODE_MESSAGING_TOKEN": "placeholder"}):
                items = poller.poll_slk(CONFIG, opts, last_polled_at)
            self.assertIsNone(poller.current_proc[0])
            self.assertEqual([item["channel_id"] for item in items], ["D456"])

    def test_poll_executes_configured_binary_without_inbox_credentials(self):
        self.poll_expecting_window(None, "600s")

    def test_poll_reads_back_to_last_successful_poll(self):
        now = poller.time.time()
        with patch.object(poller.time, "time", return_value=now):
            self.poll_expecting_window(now - 3600, "3660s")

    def test_poll_window_stops_at_max_age(self):
        now = poller.dt.datetime.now()
        oldest = poller.workdays_ago_epoch(CONFIG["max_age_workdays"], now)
        with patch.object(poller.time, "time", return_value=now.timestamp()):
            self.poll_expecting_window(oldest - 86400, f"{int(now.timestamp() - oldest)}s")

    def test_source_loop_alerts_after_three_failures_and_records_successful_poll(self):
        class StopLoop(Exception):
            pass

        class Restart:
            waits = 0

            def clear(self):
                pass

            def is_set(self):
                return False

            def wait(self, _):
                self.waits += 1
                if self.waits == 4:
                    raise StopLoop

        failure = ValueError("slk recent 查询失败。")
        results = [failure, failure, failure, []]

        def poll(cfg, opts, last_polled_at):
            result = results.pop(0)
            if isinstance(result, Exception):
                raise result
            return result

        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            state_path = Path(directory) / "state.json"
            poller.save_json(config_path, {**CONFIG, "slack_backend": "slk"})
            pushed = []
            with patch.multiple(poller, CONFIG_PATH=config_path, STATE_PATH=state_path, restart_source=Restart(),
                                poll_slk=poll, push_to_session=pushed.append,
                                status={"state": "starting", "needs_login": False, "last_error": None}):
                with self.assertRaises(StopLoop):
                    poller.source_loop()
                self.assertEqual(poller.status["state"], "connected")
            self.assertEqual(len(pushed), 1)
            self.assertIn("slk 连续 3 次读取失败", pushed[0])
            self.assertIn("slk_polled_at", poller.load_json(state_path, {}))

    def test_poll_does_not_surface_raw_cli_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "slk"
            binary.write_text("#!/bin/sh\nprintf '%s\\n' 'private annotation' >&2\nexit 1\n")
            binary.chmod(0o755)
            with self.assertRaisesRegex(ValueError, r"^slk recent 查询失败") as error:
                poller.poll_slk(CONFIG, {"binary": str(binary), "workspace": ""}, None)
            self.assertNotIn("private annotation", str(error.exception))
            self.assertIsNone(poller.current_proc[0])

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
