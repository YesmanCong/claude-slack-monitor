"""自检：approve 例外、设置页表单校验、记录页统计、动态规则改动记录。跑法：python3 -I -m unittest test_slack_poller"""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import slack_poller as poller


def review_request(repo, author, cross_repo=False):
    return repo, 7, {"baseRefName": "staging", "headRefName": "feature", "headRefOid": "abc", "isCrossRepository": cross_repo,
                     "author": {"login": author}}


class ApproveExceptionTest(unittest.TestCase):
    after_review = ["acme/ep-* Alice bob", "acme/*-api* *"]
    without_review = ["acme/tools carol", "acme/* dave"]

    def match(self, repo, author, **kwargs):
        return poller.approve_exception_pr(review_request(repo, author, **kwargs), self.without_review, self.after_review)

    def test_repo_and_author_must_both_match(self):
        self.assertEqual(self.match("acme/ep-cli", "alice"),
                         {"repo": "acme/ep-cli", "number": 7, "author": "alice", "head_sha": "abc", "needs_review": True})
        self.assertIsNone(self.match("acme/ep-cli", "carol"))
        self.assertIsNone(self.match("acme/billing", "alice"))
        self.assertIsNone(self.match("Other/ep-cli", "alice"))

    def test_any_author_and_any_repo(self):
        self.assertTrue(self.match("acme/shop-api", "whoever")["needs_review"])
        self.assertFalse(self.match("acme/anything", "dave")["needs_review"])

    def test_the_list_without_review_wins_and_never_honors_any_author(self):
        self.assertFalse(self.match("acme/tools", "carol", cross_repo=True)["needs_review"])
        self.assertIsNone(poller.approve_exception_pr(review_request("acme/tools", "mallory"), ["acme/tools *"], []))
        self.assertIsNone(poller.approve_exception_pr(review_request("acme/tools", "carol"), [], []))

    def test_feature_branch_is_not_a_release_merge(self):
        self.assertIsNone(poller.release_merge_pr(review_request("acme/tools", "carol"), []))


class ParseFormTest(unittest.TestCase):
    def form(self, **extra):
        base = {"work_start": ["10:00"], "work_end": ["19:00"], "max_age_workdays": ["1"],
                "follow_up_check_minutes": ["60"], "session_scan_minutes": ["0"]}
        return {**base, **{k: [v] for k, v in extra.items()}}

    def test_accepts_exception_lines_and_intervals(self):
        cfg = poller.parse_form(self.form(approve_exceptions="acme/ep-* alice bob\nacme/tools carol"), dict(poller.DEFAULT_CONFIG))
        self.assertEqual(cfg["approve_exceptions"], ["acme/ep-* alice bob", "acme/tools carol"])
        self.assertEqual((cfg["follow_up_check_minutes"], cfg["session_scan_minutes"]), (60, 0))

    def test_rejects_exception_without_author_or_with_wildcard_owner(self):
        for line in ("acme/tools", "*/tools alice"):
            with self.assertRaises(ValueError, msg=line):
                poller.parse_form(self.form(approve_exceptions=line), dict(poller.DEFAULT_CONFIG))
        self.assertEqual(poller.parse_form(self.form(approve_exceptions="acme/*-api* *"), dict(poller.DEFAULT_CONFIG))["approve_exceptions"],
                         ["acme/*-api* *"])
        with self.assertRaises(ValueError):
            poller.parse_form(self.form(approve_without_review="acme/tools *"), dict(poller.DEFAULT_CONFIG))

    def test_reply_marks_are_saved_and_blank_ones_keep_the_saved_value(self):
        current = {**poller.DEFAULT_CONFIG, "identity": {"my_user_id": "U1", "agent_reply_prefixes": ["[旧]:"], "agent_reply_header": "旧小字"}}
        cfg = poller.parse_form(self.form(agent_reply_prefixes="[新 😼]:\r\n[新 :smirk_cat:]:", agent_reply_header="新小字"), current)
        self.assertEqual(cfg["identity"], {"my_user_id": "U1", "agent_reply_prefixes": ["[新 😼]:", "[新 :smirk_cat:]:"], "agent_reply_header": "新小字"})
        self.assertEqual(poller.parse_form(self.form(), current)["identity"], current["identity"])
        with self.assertRaises(ValueError):
            poller.parse_form(self.form(agent_reply_header="长" * 101), current)

    def test_rejects_interval_out_of_range(self):
        with self.assertRaises(ValueError):
            poller.parse_form(self.form(session_scan_minutes="5000"), dict(poller.DEFAULT_CONFIG))


class SummarizeActivityTest(unittest.TestCase):
    entries = [
        {"at": "2026-11-23T10:00:00", "type": "received", "channel_id": "C1", "channel_name": "dev-chat", "outcome": "pushed"},
        {"at": "2026-11-24T10:00:00", "type": "received", "channel_id": "C1", "channel_name": "dev-chat", "outcome": "pushed"},
        {"at": "2026-11-24T10:01:00", "type": "received", "channel_id": "D1", "channel_name": "", "user_name": "Alex", "outcome": "filtered"},
        {"at": "2026-11-24T10:05:00", "type": "sent", "action": "post", "channel_id": "C1", "body": "好的", "permalink": "https://x/p1"},
        {"at": "2026-11-24T10:06:00", "type": "sent", "action": "update", "channel_id": "C1", "body": "好的。", "permalink": "https://x/p1"},
        {"at": "2026-11-24T10:07:00", "type": "sent", "action": "post", "channel_id": "C9", "body": "新起一条", "permalink": None},
        {"at": "2026-11-24T09:00:00", "type": "sent", "action": "post", "channel_id": "C8", "channel_name": "补回来的", "body": "早上补的", "permalink": None},
        {"at": "2026-11-24T11:00:00", "type": "rule_change", "by": "Claude", "added": ["x"], "removed": []},
    ]
    today = dt.date(2026, 11, 24)

    def test_today(self):
        out = poller.summarize_activity(self.entries, 1, self.today)
        self.assertEqual(out["totals"], {"received": 2, "pushed": 1, "filtered": 1, "sent": 3})
        self.assertEqual((out["unit"], len(out["by_time"])), ("hour", 24))
        self.assertEqual(out["by_time"][10], {"slot": "10", "received": 2, "pushed": 1, "filtered": 1, "sent": 2})
        self.assertEqual([m["body"] for m in out["sent"]], ["早上补的", "好的", "好的。", "新起一条"])
        self.assertEqual({r["channel"]: r["sent"] for r in out["by_channel"]}, {"dev-chat": 1, "私信 Alex": 0, "C9": 1, "补回来的": 1})

    def test_week_fills_empty_days_and_filters_by_channel(self):
        out = poller.summarize_activity(self.entries, 7, self.today, "dev-chat")
        self.assertEqual((out["unit"], len(out["by_time"])), ("day", 7))
        self.assertEqual(out["by_time"][0], {"slot": "2026-11-18", "received": 0, "pushed": 0, "filtered": 0, "sent": 0})
        self.assertEqual(out["totals"], {"received": 2, "pushed": 2, "filtered": 0, "sent": 1})
        self.assertEqual(len(out["by_channel"]), 4)
        self.assertEqual([m["channel"] for m in out["sent"]], ["补回来的", "dev-chat", "dev-chat", "C9"])


class CheckChannelsTest(unittest.TestCase):
    def check(self, tmp, cfg, commands, **state):
        def run(command):
            code, out = commands.get(command[0].rsplit("/", 1)[-1], (1, ""))
            return SimpleNamespace(returncode=code, stdout=out)
        live = {"state": "connecting", "needs_login": False, "last_error": None, **state}
        with patch.multiple(poller, HERE=Path(tmp), run_quiet=run, status=live):
            return poller.check_channels({**poller.DEFAULT_CONFIG, **cfg})

    def test_nothing_installed(self):
        with tempfile.TemporaryDirectory() as tmp:
            channels = self.check(tmp, {}, {})
            self.assertEqual([(done, label) for done, label, *_ in channels["gabriel"]["steps"]],
                             [(False, "装好依赖"), (False, "登录网页版 Slack"), (False, "连上 Slack")])
            self.assertFalse(channels["gabriel"]["ready"])
            self.assertEqual([done for done, *_ in channels["slk"]["steps"]], [False, False, False])
            self.assertEqual(channels["slk"]["steps"][0][3], "bash slk/build.sh")

    def test_active_channel_reports_the_live_connection_and_an_expired_login(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "node_modules" / "gabriel-slack").mkdir(parents=True)
            channels = self.check(tmp, {}, {"security": (0, "")}, state="connected")
            self.assertTrue(channels["gabriel"]["ready"] and channels["gabriel"]["connected"])
            self.assertTrue(all(done for done, *_ in channels["gabriel"]["steps"]))
            expired = self.check(tmp, {}, {"security": (0, "")}, state="needs_login", needs_login=True)["gabriel"]
            self.assertEqual(expired["steps"][-1][0], False)
            self.assertIn("登录过期了", expired["steps"][-1][2])
            self.assertEqual(expired["steps"][-1][3], "node slack_login.mjs")

    def test_slk_is_ready_only_when_the_saved_slug_is_one_slk_lists(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / ".slk-bin" / "slk"
            binary.parent.mkdir()
            binary.write_text("#!/bin/sh\n")
            binary.chmod(0o755)
            listing = {"slk": (0, "SLUG       NAME\nacme       Acme Inc\n")}
            self.assertTrue(self.check(tmp, {"slk": {"workspace": "acme"}}, listing)["slk"]["ready"])
            for slug in ("", "ac", "other"):
                channel = self.check(tmp, {"slk": {"workspace": slug}}, listing)["slk"]
                self.assertEqual([done for done, *_ in channel["steps"]], [True, True, False], slug)
            self.assertFalse(self.check(tmp, {"slk": {"workspace": "acme"}}, {"slk": (0, "")})["slk"]["steps"][1][0])


class RenderPageTest(unittest.TestCase):
    def test_page_renders_every_tab_and_escapes_saved_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "rules.md").write_text("- <script>alert(1)</script>\n")
            live = {"state": "connected", "needs_login": False, "last_error": None, "last_item": None, "last_push": None}
            with patch.multiple(poller, HERE=tmp, RULES_PATH=tmp / "rules.md", ACTIVITY_LOG_PATH=tmp / "log.jsonl",
                                run_quiet=lambda command: None, status=live):
                page = poller.render_page(dict(poller.DEFAULT_CONFIG))
        for marker in ('id="tab-set"', 'id="tab-rules"', 'id="tab-log"', 'id="channels"', 'name="agent_reply_header"', 'id="log-refresh"'):
            self.assertIn(marker, page)
        self.assertNotIn("<script>alert(1)</script>", page)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", page)


class RuleChangeTest(unittest.TestCase):
    def test_logs_added_and_removed_lines_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            paths = {"RULES_PATH": tmp / "rules.md", "RULES_SNAPSHOT_PATH": tmp / "snapshot", "ACTIVITY_LOG_PATH": tmp / "log.jsonl"}
            with patch.multiple(poller, **paths):
                paths["RULES_PATH"].write_text("- 甲\n- 乙\n")
                poller.record_rule_changes("Claude")
                self.assertEqual(poller.read_activity(), [])
                paths["RULES_PATH"].write_text("- 甲\n- 丙\n")
                poller.record_rule_changes("Claude")
                poller.record_rule_changes("你")
                changes = poller.read_activity()
                self.assertEqual(len(changes), 1)
                self.assertEqual((changes[0]["by"], changes[0]["added"], changes[0]["removed"]), ("Claude", ["丙"], ["乙"]))


if __name__ == "__main__":
    unittest.main()
