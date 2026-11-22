import http.cookiejar
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import uvicorn

# Use an isolated temporary SQLite database for testing
_tmp_dir = tempfile.TemporaryDirectory()
os.environ["APP_DB_PATH"] = str(Path(_tmp_dir.name) / "test_site.db")

from app.main import app  # noqa: E402
from app.security import compute_soop_signature, rate_limiter  # noqa: E402


class ApiClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))
        self.csrf_token: str | None = None

    def request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        headers: dict | None = None,
        include_csrf: bool = True,
    ) -> tuple[int, dict]:
        req_headers = dict(headers or {})
        raw = None
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            req_headers["Content-Type"] = "application/json"
        if include_csrf and self.csrf_token and method in ("POST", "PUT", "PATCH", "DELETE"):
            req_headers["X-CSRF-Token"] = self.csrf_token

        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=raw,
            headers=req_headers,
            method=method,
        )
        try:
            with self.opener.open(req) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))


class SecurityAndPointsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        config = uvicorn.Config(app, host="127.0.0.1", port=18765, log_level="warning")
        cls.server = uvicorn.Server(config)
        cls.thread = threading.Thread(target=cls.server.run, daemon=True)
        cls.thread.start()
        for _ in range(40):
            try:
                urllib.request.urlopen("http://127.0.0.1:18765/api/stream/status", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        cls.base_url = "http://127.0.0.1:18765"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.should_exit = True
        cls.thread.join(timeout=3)
        _tmp_dir.cleanup()

    def setUp(self) -> None:
        rate_limiter.reset()

    def test_01_register_login_csrf_and_rbac(self) -> None:
        fan = ApiClient(self.base_url)
        status, data = fan.request(
            "POST",
            "/api/auth/register",
            {"username": "testfan1", "nickname": "테스트팬", "password": "Password!123"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["user"]["points"], 2000)
        fan.csrf_token = data["csrf_token"]

        # Missing CSRF header must be blocked with 403
        status_no_csrf, _ = fan.request(
            "POST",
            "/api/points/attendance",
            include_csrf=False,
        )
        self.assertEqual(status_no_csrf, 403)

        # Normal user cannot post to notice tab (403)
        status_notice, _ = fan.request(
            "POST",
            "/api/posts",
            {"tab": "notice", "title": "가짜 공지", "content": "테스트"},
        )
        self.assertEqual(status_notice, 403)

        # Attendance works once, then rejects duplicate on same day (409)
        s1, d1 = fan.request("POST", "/api/points/attendance")
        self.assertEqual(s1, 200)
        self.assertEqual(d1["balance"], 2100)

        s2, _ = fan.request("POST", "/api/points/attendance")
        self.assertEqual(s2, 409)

    def test_02_soop_verification_and_chat_points(self) -> None:
        fan = ApiClient(self.base_url)
        status, data = fan.request(
            "POST",
            "/api/auth/login",
            {"username": "testfan1", "password": "Password!123"},
        )
        self.assertEqual(status, 200)
        fan.csrf_token = data["csrf_token"]

        # Request SOOP link verification code
        s_req, d_req = fan.request("POST", "/api/soop/link/request", {"soop_id": "my_soop_99"})
        self.assertEqual(s_req, 200)
        code = d_req["soop_verify_code"]
        self.assertTrue(code.startswith("PINK-"))

        # External collector sends HMAC-signed verification chat message
        verify_payload = {"soop_id": "my_soop_99", "message": f"!인증 {code}"}
        raw_verify = json.dumps(verify_payload).encode("utf-8")
        sig = compute_soop_signature(raw_verify)

        collector = ApiClient(self.base_url)
        # Invalid signature should fail (401 since no session)
        bad_s, _ = collector.request(
            "POST",
            "/api/integrations/soop/chat-events",
            verify_payload,
            headers={"X-Soop-Signature": "deadbeef"},
            include_csrf=False,
        )
        self.assertEqual(bad_s, 401)

        # Valid HMAC signature verifies the account
        ok_s, ok_d = collector.request(
            "POST",
            "/api/integrations/soop/chat-events",
            verify_payload,
            headers={"X-Soop-Signature": sig},
            include_csrf=False,
        )
        self.assertEqual(ok_s, 200)
        self.assertEqual(ok_d["status"], "verified")

        # Now chat event awards +5P, and immediate second message hits cooldown
        chat_payload = {"soop_id": "my_soop_99", "message": "방송 재밌어요!", "event_id": "evt-1"}
        chat_sig = compute_soop_signature(json.dumps(chat_payload).encode("utf-8"))
        c1_s, c1_d = collector.request(
            "POST",
            "/api/integrations/soop/chat-events",
            chat_payload,
            headers={"X-Soop-Signature": chat_sig},
            include_csrf=False,
        )
        self.assertEqual(c1_s, 200)
        self.assertEqual(c1_d["status"], "awarded")
        self.assertEqual(c1_d["balance"], 2105)

        chat_payload2 = {"soop_id": "my_soop_99", "message": "연속 채팅 테스트!", "event_id": "evt-2"}
        chat_sig2 = compute_soop_signature(json.dumps(chat_payload2).encode("utf-8"))
        c2_s, c2_d = collector.request(
            "POST",
            "/api/integrations/soop/chat-events",
            chat_payload2,
            headers={"X-Soop-Signature": chat_sig2},
            include_csrf=False,
        )
        self.assertEqual(c2_s, 200)
        self.assertEqual(c2_d["status"], "awarded")
        self.assertEqual(c2_d["balance"], 2110)

        # Normal fan cannot forge chat-events without HMAC signature
        forge_s, _ = fan.request(
            "POST",
            "/api/integrations/soop/chat-events",
            {"soop_id": "my_soop_99", "message": "forged"},
        )
        self.assertEqual(forge_s, 403)

    def test_03_staff_and_admin_can_edit_delete_all_normal_fan_blocked(self) -> None:
        fan = ApiClient(self.base_url)
        _, fan_data = fan.request(
            "POST",
            "/api/auth/login",
            {"username": "testfan1", "password": "Password!123"},
        )
        fan.csrf_token = fan_data["csrf_token"]

        # Fan creates a post & comment
        s_p, d_p = fan.request("POST", "/api/posts", {"tab": "free", "title": "팬글", "content": "내용"})
        self.assertEqual(s_p, 200)
        post_id = d_p["id"]
        s_c, d_c = fan.request("POST", f"/api/posts/{post_id}/comments", {"content": "팬댓글"})
        self.assertEqual(s_c, 200)
        comment_id = d_c["id"]

        # Normal fan cannot edit or delete ANY section (even their own post/comment)
        self.assertEqual(
            fan.request("PUT", f"/api/posts/{post_id}", {"tab": "free", "title": "수정", "content": "수정"})[0],
            403,
        )
        self.assertEqual(fan.request("DELETE", f"/api/posts/{post_id}")[0], 403)
        self.assertEqual(fan.request("PUT", f"/api/comments/{comment_id}", {"content": "수정"})[0], 403)
        self.assertEqual(fan.request("DELETE", f"/api/comments/{comment_id}")[0], 403)
        self.assertEqual(
            fan.request("PUT", "/api/signatures/1", {"title": "x", "balloon_count": 10, "category": "귀여움", "description": "d"})[0],
            403,
        )
        self.assertEqual(
            fan.request("PUT", "/api/calendar/1", {"title": "x", "event_date": "2026-11-20", "start_time": "20:00", "category": "live"})[0],
            403,
        )
        self.assertEqual(
            fan.request("PUT", "/api/shop/items/1", {"name": "x", "description": "d", "cost": 10, "stock": 1})[0],
            403,
        )

        # Manager (staff) CAN edit & delete all of them
        mgr = ApiClient(self.base_url)
        s_m, d_m = mgr.request("POST", "/api/auth/login", {"username": "manager", "password": "Manager!1234"})
        self.assertEqual(s_m, 200)
        mgr.csrf_token = d_m["csrf_token"]

        self.assertEqual(
            mgr.request("PUT", f"/api/posts/{post_id}", {"tab": "free", "title": "매니저수정", "content": "수정됨"})[0],
            200,
        )
        self.assertEqual(mgr.request("PUT", f"/api/comments/{comment_id}", {"content": "매니저댓글수정"})[0], 200)
        self.assertEqual(mgr.request("DELETE", f"/api/comments/{comment_id}")[0], 200)
        self.assertEqual(mgr.request("DELETE", f"/api/posts/{post_id}")[0], 200)
        self.assertEqual(
            mgr.request("PUT", "/api/signatures/1", {"title": "수정시그", "balloon_count": 33, "category": "귀여움", "description": "d"})[0],
            200,
        )
        s_cal, d_cal = mgr.request(
            "POST",
            "/api/calendar",
            {"title": "테스트일정", "event_date": "2026-11-20", "start_time": "20:00", "category": "live"},
        )
        self.assertEqual(s_cal, 200)
        cal_id = d_cal["id"]
        self.assertEqual(
            mgr.request("PUT", f"/api/calendar/{cal_id}", {"title": "수정일정", "event_date": "2026-11-20", "start_time": "21:00", "category": "live"})[0],
            200,
        )
        self.assertEqual(mgr.request("DELETE", f"/api/calendar/{cal_id}")[0], 200)
        s_shop, d_shop = mgr.request(
            "POST",
            "/api/shop/items",
            {"name": "테스트상품", "description": "d", "cost": 500, "stock": 10},
        )
        self.assertEqual(s_shop, 200)
        shop_id = d_shop["id"]
        self.assertEqual(
            mgr.request("PUT", f"/api/shop/items/{shop_id}", {"name": "수정상품", "description": "d", "cost": 500, "stock": 10})[0],
            200,
        )
        self.assertEqual(mgr.request("DELETE", f"/api/shop/items/{shop_id}")[0], 200)

    def test_04_anonymous_author_visibility_and_ban_blacklist(self) -> None:
        fan = ApiClient(self.base_url)
        _, fan_data = fan.request(
            "POST",
            "/api/auth/login",
            {"username": "testfan1", "password": "Password!123"},
        )
        fan.csrf_token = fan_data["csrf_token"]
        fan_id = fan_data["user"]["id"]

        # Fan creates an anonymous post
        s_p, d_p = fan.request(
            "POST",
            "/api/posts",
            {"tab": "free", "title": "익명글테스트", "content": "비밀내용", "is_anonymous": True},
        )
        self.assertEqual(s_p, 200)
        anon_post_id = d_p["id"]

        # Normal fan sees only "익명"
        _, fan_view = fan.request("GET", f"/api/posts/{anon_post_id}")
        self.assertEqual(fan_view["post"]["author_nickname"], "익명")

        # Manager sees real author info on anonymous post
        mgr = ApiClient(self.base_url)
        _, mgr_data = mgr.request("POST", "/api/auth/login", {"username": "manager", "password": "Manager!1234"})
        mgr.csrf_token = mgr_data["csrf_token"]
        _, mgr_view = mgr.request("GET", f"/api/posts/{anon_post_id}")
        self.assertIn("testfan1", mgr_view["post"]["author_nickname"])

        # Manager blacklists fan -> fan's active session is immediately invalidated & login returns 403
        s_ban, _ = mgr.request(
            "POST",
            f"/api/admin/users/{fan_id}/ban",
            {"mode": "black", "reason": "악성 도배"},
        )
        self.assertEqual(s_ban, 200)

        s_post_after, _ = fan.request("POST", "/api/points/attendance")
        self.assertEqual(s_post_after, 401)

        s_login_banned, _ = fan.request(
            "POST",
            "/api/auth/login",
            {"username": "testfan1", "password": "Password!123"},
        )
        self.assertEqual(s_login_banned, 403)

    def test_suika_game_points_and_anticheat(self) -> None:
        from app.database import get_connection

        player = ApiClient(self.base_url)
        s_reg, reg_data = player.request(
            "POST",
            "/api/auth/register",
            {"username": "suikafan", "nickname": "수박유저", "password": "Password!123"},
        )
        self.assertEqual(s_reg, 200)
        player.csrf_token = reg_data["csrf_token"]
        self.assertEqual(reg_data["user"]["points"], 2000)

        # Invalid stake is rejected
        s_bad_stake, _ = player.request("POST", "/api/games/suika/start", {"stake": 250})
        self.assertEqual(s_bad_stake, 400)

        # Start 100P challenge -> balance becomes 1900
        s_start, start_data = player.request("POST", "/api/games/suika/start", {"stake": 100})
        self.assertEqual(s_start, 200)
        self.assertEqual(start_data["points"], 1900)
        run_id = start_data["run_id"]

        # Instant high score (<4s elapsed) is blocked by anti-cheat
        s_cheat, _ = player.request(
            "POST",
            "/api/games/suika/finish",
            {"run_id": run_id, "score": 1500, "max_tier": 6, "merges_count": 20, "duration_sec": 25},
        )
        self.assertEqual(s_cheat, 400)

        # Simulate realistic 20s elapsed run in DB, then finish with 1,200 points -> 180P reward (2080P total)
        conn = get_connection()
        try:
            conn.execute(
                "UPDATE suika_runs SET created_at = '2026-01-01T00:00:00+00:00' WHERE id = ?",
                (run_id,),
            )
            conn.commit()
        finally:
            conn.close()

        s_win, win_data = player.request(
            "POST",
            "/api/games/suika/finish",
            {"run_id": run_id, "score": 1200, "max_tier": 7, "merges_count": 32, "duration_sec": 25},
        )
        self.assertEqual(s_win, 200)
        # 1st reward: 1,000P base (0% cut) -> 1900 + 1000 = 2900
        self.assertEqual(win_data["reward"], 1000)
        self.assertEqual(win_data["cut_percent"], 0)
        self.assertEqual(win_data["points"], 2900)

        # Double settlement on the same run is rejected
        s_dup, _ = player.request(
            "POST",
            "/api/games/suika/finish",
            {"run_id": run_id, "score": 1200, "max_tier": 7, "merges_count": 32, "duration_sec": 25},
        )
        self.assertEqual(s_dup, 409)

        # Verify diminishing rewards: 2nd (-50%), 3rd (-70%), 4th (-90%)
        for expected_score, expected_cut, expected_reward in [
            (2200, 50, 1500),   # 3000 * 0.5 = 1500
            (5100, 70, 3000),   # 10000 * 0.3 = 3000
            (1100, 90, 100),    # 1000 * 0.1 = 100
        ]:
            s_s, d_s = player.request("POST", "/api/games/suika/start", {"stake": 100})
            self.assertEqual(s_s, 200)
            rid = d_s["run_id"]
            conn = get_connection()
            try:
                conn.execute("UPDATE suika_runs SET created_at = '2026-01-01T00:00:00+00:00' WHERE id = ?", (rid,))
                conn.commit()
            finally:
                conn.close()
            s_f, d_f = player.request(
                "POST",
                "/api/games/suika/finish",
                {"run_id": rid, "score": expected_score, "max_tier": 8, "merges_count": 40, "duration_sec": 30},
            )
            self.assertEqual(s_f, 200)
            self.assertEqual(d_f["cut_percent"], expected_cut)
            self.assertEqual(d_f["reward"], expected_reward)

        # Leaderboard reflects the highest finished run (5100)
        s_lb, lb_data = player.request("GET", "/api/games/suika/leaderboard")
        self.assertEqual(s_lb, 200)
        self.assertTrue(any(r["nickname"] == "수박유저" and r["best_score"] == 5100 for r in lb_data["leaderboard"]))

    def test_omok_game_points_and_anticheat(self) -> None:
        from app.database import get_connection

        player = ApiClient(self.base_url)
        s_reg, reg_data = player.request(
            "POST",
            "/api/auth/register",
            {"username": "omokfan", "nickname": "오목고수", "password": "Password!123"},
        )
        self.assertEqual(s_reg, 200)
        player.csrf_token = reg_data["csrf_token"]
        self.assertEqual(reg_data["user"]["points"], 2000)

        # Start hard AI match (100P stake -> 1900P)
        s_start, start_data = player.request("POST", "/api/games/omok/start", {"difficulty": "hard"})
        self.assertEqual(s_start, 200)
        self.assertEqual(start_data["points"], 1900)
        run_id = start_data["run_id"]

        # Instant win (<3s or <9 moves) is blocked
        s_cheat, _ = player.request(
            "POST",
            "/api/games/omok/finish",
            {"run_id": run_id, "result": "win", "moves_count": 5, "duration_sec": 1},
        )
        self.assertEqual(s_cheat, 400)

        # Realistic elapsed time -> hard win awards 800P (1900 + 800 = 2700P)
        conn = get_connection()
        try:
            conn.execute("UPDATE omok_runs SET created_at = '2026-01-01T00:00:00+00:00' WHERE id = ?", (run_id,))
            conn.commit()
        finally:
            conn.close()

        s_win, win_data = player.request(
            "POST",
            "/api/games/omok/finish",
            {"run_id": run_id, "result": "win", "moves_count": 19, "duration_sec": 25},
        )
        self.assertEqual(s_win, 200)
        self.assertEqual(win_data["reward"], 800)
        self.assertEqual(win_data["points"], 2700)

        # Double settlement is rejected
        s_dup, _ = player.request(
            "POST",
            "/api/games/omok/finish",
            {"run_id": run_id, "result": "win", "moves_count": 19, "duration_sec": 25},
        )
        self.assertEqual(s_dup, 409)

        # Leaderboard reflects 1 win
        s_lb, lb_data = player.request("GET", "/api/games/omok/leaderboard")
        self.assertEqual(s_lb, 200)
        self.assertTrue(any(r["nickname"] == "오목고수" and r["wins"] == 1 for r in lb_data["leaderboard"]))


if __name__ == "__main__":
    unittest.main()
