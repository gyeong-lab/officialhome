import hmac
import html as html_lib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.config import (
    ATTENDANCE_POINTS,
    BASE_DIR,
    CHAT_COOLDOWN_SECONDS,
    CHAT_DAILY_CAP_POINTS,
    CHAT_POINTS_PER_MSG,
    LIKE_MILESTONES,
    LIKE_RECEIVED_POINTS,
    POST_CREATE_POINTS,
    SESSION_COOKIE_NAME,
    SESSION_TTL_SECONDS,
    UPLOAD_DIR,
)
from app.database import (
    apply_point_delta,
    get_connection,
    init_db,
    is_double_points_active,
    today_kst_str,
    transaction,
    utc_now_iso,
)
from app.security import (
    clean_text,
    generate_session_tokens,
    generate_soop_verify_code,
    hash_password,
    hash_token,
    rate_limiter,
    verify_password,
    verify_soop_signature,
)
from app.soop_collector import collector_state, get_collector_status, start_collector

app = FastAPI(title="체온 공홈", docs_url=None, redoc_url=None)

STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)


@app.on_event("startup")
async def on_startup() -> None:
    init_db()
    if not os.environ.get("VERCEL"):
        start_collector(lambda sid, msg: _process_soop_chat_event(sid, msg))


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: https://*.sooplive.com; "
        "media-src 'self'; "
        "connect-src 'self'; "
        "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com; "
        "frame-ancestors 'none';"
    )
    return response


# ---------------------------------------------------------------------------
# Auth & Security Dependencies
# ---------------------------------------------------------------------------

def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _check_user_ban(user_row: dict) -> str | None:
    if user_row.get("is_blacklisted"):
        reason = user_row.get("ban_reason") or "관리자 조치"
        return f"영구 활동정지(블랙) 처리된 계정입니다. (사유: {reason})"
    ban_until = user_row.get("ban_until")
    if ban_until:
        try:
            until_dt = datetime.fromisoformat(ban_until)
            if until_dt.tzinfo is None:
                until_dt = until_dt.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) < until_dt:
                kst_dt = until_dt + timedelta(hours=9)
                reason = user_row.get("ban_reason") or "관리자 조치"
                return f"기간 이용정지 중인 계정입니다. (해제: {kst_dt.strftime('%Y-%m-%d %H:%M')} · 사유: {reason})"
        except Exception:
            pass
    return None


def get_current_session(request: Request) -> dict | None:
    raw_token = request.cookies.get(SESSION_COOKIE_NAME)
    if not raw_token:
        return None
    token_hash = hash_token(raw_token)
    now_ts = int(time.time())
    conn = get_connection()
    try:
        row = conn.execute(
            """
            SELECT s.token_hash, s.csrf_token, s.expires_at,
                   u.id, u.username, u.nickname, u.role, u.points,
                   u.soop_id, u.soop_verified, u.soop_pending_id, u.soop_verify_code,
                   u.ban_until, u.is_blacklisted, u.ban_reason, u.double_points_until
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?
            """,
            (token_hash, now_ts),
        ).fetchone()
        if not row:
            return None
        user_dict = dict(row)
        if _check_user_ban(user_dict):
            return None
        return user_dict
    finally:
        conn.close()


def require_user(session: dict | None = Depends(get_current_session)) -> dict:
    if not session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="로그인이 필요합니다.")
    return session


def require_csrf(request: Request, session: dict = Depends(require_user)) -> dict:
    if request.method.upper() in ("POST", "PUT", "PATCH", "DELETE"):
        header_token = request.headers.get("X-CSRF-Token", "")
        if not header_token or not hmac.compare_digest(header_token, session["csrf_token"]):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF 토큰 검증에 실패했습니다.")
    return session


def require_admin(session: dict = Depends(require_csrf)) -> dict:
    if session["role"] not in ("admin", "staff"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="관리자 권한이 필요합니다.")
    return session


def _serialize_user(row: dict) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "nickname": row["nickname"],
        "role": row["role"],
        "points": row["points"],
        "soop_id": row["soop_id"],
        "soop_verified": bool(row["soop_verified"]),
        "soop_pending_id": row["soop_pending_id"],
        "soop_verify_code": row["soop_verify_code"],
        "double_points_until": row.get("double_points_until"),
    }


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------

class RegisterBody(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    nickname: str = Field(min_length=2, max_length=20)
    password: str = Field(min_length=8, max_length=72)


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=72)


class SoopLinkRequestBody(BaseModel):
    soop_id: str = Field(min_length=2, max_length=30)


class SoopChatEventBody(BaseModel):
    soop_id: str = Field(min_length=2, max_length=30)
    message: str = Field(min_length=1, max_length=300)
    event_id: str | None = Field(default=None, max_length=80)


class PostCreateBody(BaseModel):
    tab: Literal["notice", "free", "fanart", "clip", "qna", "emoticon"]
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=5000)
    is_pinned: bool = False
    is_anonymous: bool = False
    attachments: list[dict] = Field(default_factory=list, max_length=4)


class EmoticonCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    glyph: str = Field(default="", max_length=16)
    image_url: str = Field(default="", max_length=300)


class SoopSdkConfigBody(BaseModel):
    client_id: str = Field(min_length=1, max_length=120)
    client_secret: str = Field(default="", max_length=200)


class SoopSdkTokenBody(BaseModel):
    code: str = Field(default="", max_length=200)
    certification_number: str = Field(default="", max_length=20)
    redirect_uri: str = Field(default="", max_length=300)


class SoopSdkMessageBody(BaseModel):
    user_id: str = Field(min_length=1, max_length=40)
    nickname: str = Field(default="", max_length=40)
    message: str = Field(min_length=1, max_length=500)
    action: str = Field(default="MESSAGE", max_length=32)


class CommentCreateBody(BaseModel):
    content: str = Field(min_length=1, max_length=1000)


class SignatureCreateBody(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    balloon_count: int = Field(gt=0, le=1000000)
    category: str = Field(default="시그니처", min_length=1, max_length=24)
    description: str = Field(default="", max_length=200)
    badge: str = Field(default="💖", min_length=1, max_length=8)
    clip_url: str = Field(default="", max_length=300)
    image_url: str = Field(default="", max_length=300)
    tags: str = Field(default="", max_length=80)


class CalendarCreateBody(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    event_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    start_time: str = Field(default="20:00", pattern=r"^\d{2}:\d{2}$")
    category: Literal["live", "event", "collab", "rest"]
    description: str = Field(default="", max_length=300)
    color: str = Field(default="#ec4899", pattern=r"^#[0-9a-fA-F]{6}$")


class RedeemBody(BaseModel):
    item_id: int
    note: str = Field(default="", max_length=150)


class AdminPointAdjustBody(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    delta: int = Field(ne=0, ge=-100000, le=100000)
    reason: str = Field(min_length=1, max_length=120)


class AdminRedemptionStatusBody(BaseModel):
    status: Literal["approved", "rejected"]


class StreamStatusUpdateBody(BaseModel):
    is_live: bool
    title: str = Field(min_length=1, max_length=120)
    category: str = Field(min_length=1, max_length=40)
    notice_banner: str = Field(min_length=1, max_length=200)


class ShopItemBody(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = Field(min_length=1, max_length=200)
    cost: int = Field(gt=0, le=1000000)
    stock: int = Field(ge=0, le=100000)


class RoleUpdateBody(BaseModel):
    role: Literal["user", "staff"]


class PredictionCreateBody(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    options: list[str] = Field(min_length=2, max_length=10)
    closes_at: str | None = Field(default=None, max_length=40)


class PredictionBetBody(BaseModel):
    choice: str = Field(min_length=1, max_length=10)
    amount: int = Field(gt=0, le=1000000)


class PredictionSettleBody(BaseModel):
    winner: str = Field(min_length=1, max_length=10)


class GiftSendBody(BaseModel):
    recipient: str = Field(min_length=1, max_length=32)
    gift_type: Literal["point", "item", "emoticon", "voucher"]
    amount: int | None = Field(default=None, ge=10, le=1000000)
    item_id: int | None = None
    emoticon_id: str | None = Field(default=None, max_length=20)
    voucher_value: int | None = None
    quantity: int = Field(default=1, ge=1, le=50)
    message: str = Field(default="", max_length=120)


class AdminGrantVoucherBody(BaseModel):
    recipient: str = Field(min_length=1, max_length=32)
    point_value: Literal[1000, 5000, 10000]
    quantity: int = Field(default=1, ge=1, le=100)
    message: str = Field(default="", max_length=120)


class OpenVoucherBody(BaseModel):
    point_value: Literal[1000, 5000, 10000]


# ---------------------------------------------------------------------------
# Auth Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/auth/register")
def register(body: RegisterBody, request: Request, response: Response):
    ip = _client_ip(request)
    if not rate_limiter.allow(f"register:{ip}", limit=10, window_seconds=300):
        raise HTTPException(status_code=429, detail="요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.")

    username = body.username.strip()
    if not re.fullmatch(r"[a-zA-Z0-9_]{3,24}", username):
        raise HTTPException(status_code=400, detail="아이디는 영문, 숫자, 밑줄(_) 3~24자만 가능합니다.")

    nickname = clean_text(body.nickname, 20)
    if len(nickname) < 2:
        raise HTTPException(status_code=400, detail="닉네임은 2자 이상이어야 합니다.")

    pw_hash = hash_password(body.password)
    now = utc_now_iso()

    with transaction() as conn:
        exists = conn.execute(
            "SELECT id FROM users WHERE username = ? OR nickname = ?",
            (username, nickname),
        ).fetchone()
        if exists:
            raise HTTPException(status_code=409, detail="이미 사용 중인 아이디 또는 닉네임입니다.")

        cur = conn.execute(
            """
            INSERT INTO users (username, nickname, password_hash, role, points, created_at)
            VALUES (?, ?, ?, 'user', 2000, ?)
            """,
            (username, nickname, pw_hash, now),
        )
        user_id = cur.lastrowid
        conn.execute(
            """
            INSERT INTO point_ledger (user_id, delta, balance_after, reason, source, idempotency_key, created_at)
            VALUES (?, 2000, 2000, '신규 가입 환영 포인트', 'admin', ?, ?)
            """,
            (user_id, f"welcome:{user_id}", now),
        )

        raw_session, csrf_token = generate_session_tokens()
        conn.execute(
            """
            INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (hash_token(raw_session), user_id, csrf_token, int(time.time()) + SESSION_TTL_SECONDS, now),
        )

        user_row = dict(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())

    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=raw_session,
        httponly=True,
        samesite="lax",
        secure=False,  # Set True behind HTTPS in production
        max_age=SESSION_TTL_SECONDS,
        path="/",
    )
    return {"user": _serialize_user(user_row), "csrf_token": csrf_token}


@app.post("/api/auth/login")
def login(body: LoginBody, request: Request, response: Response):
    ip = _client_ip(request)
    if not rate_limiter.allow(f"login:{ip}", limit=15, window_seconds=300):
        raise HTTPException(status_code=429, detail="로그인 시도가 너무 많습니다. 5분 후 다시 시도해 주세요.")

    conn = get_connection()
    try:
        user = conn.execute("SELECT * FROM users WHERE username = ?", (body.username.strip(),)).fetchone()
    finally:
        conn.close()

    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다.")

    ban_msg = _check_user_ban(dict(user))
    if ban_msg:
        raise HTTPException(status_code=403, detail=ban_msg)

    raw_session, csrf_token = generate_session_tokens()
    now = utc_now_iso()
    with transaction() as conn:
        conn.execute(
            """
            INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (hash_token(raw_session), user["id"], csrf_token, int(time.time()) + SESSION_TTL_SECONDS, now),
        )

    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=raw_session,
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=SESSION_TTL_SECONDS,
        path="/",
    )
    return {"user": _serialize_user(dict(user)), "csrf_token": csrf_token}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, session: dict = Depends(require_csrf)):
    raw_token = request.cookies.get(SESSION_COOKIE_NAME)
    if raw_token:
        with transaction() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(raw_token),))
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(session: dict | None = Depends(get_current_session)):
    if not session:
        return {"user": None, "csrf_token": None}
    return {"user": _serialize_user(session), "csrf_token": session["csrf_token"]}


@app.get("/api/me/activity")
def my_activity(session: dict = Depends(require_user)):
    conn = get_connection()
    try:
        posts = conn.execute(
            """
            SELECT p.id, p.tab, p.title, p.is_anonymous, p.is_hidden, p.views, p.created_at,
                   (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
                   (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count
            FROM posts p
            WHERE p.author_id = ?
            ORDER BY p.id DESC LIMIT 50
            """,
            (session["id"],),
        ).fetchall()
        comments = conn.execute(
            """
            SELECT c.id, c.post_id, c.content, c.created_at,
                   p.title AS post_title, p.tab AS post_tab
            FROM comments c
            JOIN posts p ON p.id = c.post_id
            WHERE c.author_id = ?
            ORDER BY c.id DESC LIMIT 50
            """,
            (session["id"],),
        ).fetchall()
        return {
            "user": _serialize_user(session),
            "posts": [dict(p) for p in posts],
            "comments": [dict(c) for c in comments],
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# SOOP Account Link & Chat Point Integration
# ---------------------------------------------------------------------------

@app.post("/api/soop/link/request")
def request_soop_link(body: SoopLinkRequestBody, session: dict = Depends(require_csrf)):
    soop_id = body.soop_id.strip().lower()
    if not re.fullmatch(r"[a-z0-9_.-]{2,30}", soop_id):
        raise HTTPException(status_code=400, detail="SOOP 아이디 형식이 올바르지 않습니다.")

    code = generate_soop_verify_code()
    with transaction() as conn:
        owner = conn.execute(
            "SELECT id FROM users WHERE soop_id = ? AND soop_verified = 1 AND id != ?",
            (soop_id, session["id"]),
        ).fetchone()
        if owner:
            raise HTTPException(status_code=409, detail="이미 다른 계정에 연동된 SOOP 아이디입니다.")

        conn.execute(
            """
            UPDATE users
            SET soop_pending_id = ?, soop_verify_code = ?
            WHERE id = ?
            """,
            (soop_id, code, session["id"]),
        )
    return {"soop_pending_id": soop_id, "soop_verify_code": code}


@app.post("/api/soop/link/verify-station")
def verify_soop_station(session: dict = Depends(require_csrf)):
    pending_id = session.get("soop_pending_id")
    code = session.get("soop_verify_code")
    if not pending_id or not code:
        raise HTTPException(status_code=400, detail="먼저 SOOP 아이디를 입력하고 인증 코드를 발급해 주세요.")

    api_url = f"https://chapi.sooplive.com/api/{pending_id}/station"
    req = urllib.request.Request(
        api_url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": f"https://www.sooplive.com/station/{pending_id}",
            "Origin": "https://www.sooplive.com",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=502, detail="SOOP 방송국 정보를 불러오지 못했습니다. 아이디를 확인해 주세요.")

    station = payload.get("station") or {}
    display = station.get("display") or {}
    profile_text = str(display.get("profile_text") or "")
    station_title = str(station.get("station_title") or "")
    combined = f"{profile_text}\n{station_title}".upper()

    if code.upper() not in combined:
        raise HTTPException(
            status_code=400,
            detail=f"SOOP 방송국({pending_id}) 소개글에서 인증 코드({code})를 찾지 못했습니다. 소개글 저장 후 다시 눌러주세요.",
        )

    with transaction() as conn:
        already = conn.execute(
            "SELECT id FROM users WHERE soop_id = ? AND soop_verified = 1 AND id != ?",
            (pending_id, session["id"]),
        ).fetchone()
        if already:
            raise HTTPException(status_code=409, detail="이미 다른 계정에 연동된 SOOP 아이디입니다.")
        conn.execute(
            """
            UPDATE users
            SET soop_id = ?, soop_verified = 1, soop_pending_id = NULL, soop_verify_code = NULL
            WHERE id = ?
            """,
            (pending_id, session["id"]),
        )
    return {"soop_id": pending_id, "message": f"SOOP 계정({pending_id}) 인증 및 연동이 완료되었습니다! 이제 소개글에서 코드를 지우셔도 계속 연동됩니다."}


@app.delete("/api/soop/link")
def unlink_soop(session: dict = Depends(require_csrf)):
    with transaction() as conn:
        conn.execute(
            """
            UPDATE users
            SET soop_id = NULL, soop_verified = 0, soop_pending_id = NULL, soop_verify_code = NULL
            WHERE id = ?
            """,
            (session["id"],),
        )
    return {"ok": True}


def _process_soop_chat_event(soop_id_raw: str, message_raw: str, event_id: str | None = None) -> dict:
    soop_id = soop_id_raw.strip().lower()
    msg = clean_text(message_raw, 300)
    now_ts = time.time()
    today = today_kst_str()

    with transaction() as conn:
        verify_match = re.match(r"^!인증\s+(PINK-\d{4})$", msg.strip(), re.IGNORECASE)
        if verify_match:
            code = verify_match.group(1).upper()
            pending_user = conn.execute(
                """
                SELECT id, nickname FROM users
                WHERE soop_pending_id = ? AND soop_verify_code = ?
                """,
                (soop_id, code),
            ).fetchone()
            if not pending_user:
                return {"status": "ignored", "reason": "일치하는 인증 대기 요청이 없습니다."}

            already = conn.execute(
                "SELECT id FROM users WHERE soop_id = ? AND soop_verified = 1 AND id != ?",
                (soop_id, pending_user["id"]),
            ).fetchone()
            if already:
                return {"status": "rejected", "reason": "이미 다른 계정에 연동된 SOOP 아이디입니다."}

            conn.execute(
                """
                UPDATE users
                SET soop_id = ?, soop_verified = 1, soop_pending_id = NULL, soop_verify_code = NULL
                WHERE id = ?
                """,
                (soop_id, pending_user["id"]),
            )
            return {
                "status": "verified",
                "soop_id": soop_id,
                "user_id": pending_user["id"],
                "message": f"SOOP 계정({soop_id}) 인증 및 연동이 완료되었습니다!",
            }

        user = conn.execute(
            "SELECT id, points FROM users WHERE soop_id = ? AND soop_verified = 1",
            (soop_id,),
        ).fetchone()
        if not user:
            return {"status": "ignored", "reason": "연동(인증)된 SOOP 아이디가 아닙니다."}

        tracker = conn.execute(
            "SELECT last_awarded_ts, daily_date, daily_points FROM soop_chat_tracker WHERE soop_id = ?",
            (soop_id,),
        ).fetchone()

        last_ts = float(tracker["last_awarded_ts"]) if tracker else 0.0
        daily_points = int(tracker["daily_points"]) if (tracker and tracker["daily_date"] == today) else 0

        if CHAT_COOLDOWN_SECONDS > 0 and now_ts - last_ts < CHAT_COOLDOWN_SECONDS:
            remaining = round(CHAT_COOLDOWN_SECONDS - (now_ts - last_ts), 1)
            return {"status": "cooldown", "reason": f"도배 방지 쿨타임 중 ({remaining}초 남음)"}

        if daily_points + CHAT_POINTS_PER_MSG > CHAT_DAILY_CAP_POINTS:
            return {"status": "capped", "reason": f"일일 채팅 포인트 상한({CHAT_DAILY_CAP_POINTS}P)에 도달했습니다."}

        idem_key = f"soop_chat:{event_id}" if event_id else None
        applied, new_balance = apply_point_delta(
            conn,
            user["id"],
            CHAT_POINTS_PER_MSG,
            f"SOOP 채팅 참여 적립 ({soop_id})",
            "soop_chat",
            idempotency_key=idem_key,
        )
        if not applied:
            return {"status": "duplicate", "balance": new_balance}

        conn.execute(
            """
            INSERT INTO soop_chat_tracker (soop_id, last_awarded_ts, daily_date, daily_points)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(soop_id) DO UPDATE SET
                last_awarded_ts = excluded.last_awarded_ts,
                daily_date = excluded.daily_date,
                daily_points = excluded.daily_points
            """,
            (soop_id, now_ts, today, daily_points + CHAT_POINTS_PER_MSG),
        )
        return {
            "status": "awarded",
            "awarded": CHAT_POINTS_PER_MSG,
            "balance": new_balance,
            "daily_points": daily_points + CHAT_POINTS_PER_MSG,
            "daily_cap": CHAT_DAILY_CAP_POINTS,
        }


@app.get("/api/integrations/soop/collector/status")
def soop_collector_status(session: dict | None = Depends(get_current_session)):
    my_soop = (session.get("soop_id") or "") if (session and session.get("soop_verified")) else None
    st = get_collector_status(my_soop)
    if session:
        conn = get_connection()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt, COALESCE(SUM(delta), 0) AS total FROM point_ledger WHERE user_id = ? AND source = 'soop_chat'",
                (session["id"],),
            ).fetchone()
            st["messages_seen"] = int(row["cnt"] or 0)
            st["points_awarded"] = int(row["total"] or 0)
        finally:
            conn.close()
    else:
        st["messages_seen"] = 0
        st["points_awarded"] = 0
    return st


@app.post("/api/integrations/soop/chat-events")
async def ingest_soop_chat_event(
    body: SoopChatEventBody,
    request: Request,
    session: dict | None = Depends(get_current_session),
):
    """Receives SOOP chat events from an authorized Chat Collector (HMAC signed)
    OR from an authenticated user/admin using the built-in test simulator (with CSRF).
    """
    raw_body = await request.body()
    sig = request.headers.get("X-Soop-Signature")
    is_signed_collector = verify_soop_signature(raw_body, sig)

    if not is_signed_collector:
        if not session:
            raise HTTPException(status_code=401, detail="유효한 서명 또는 로그인이 필요합니다.")
        header_csrf = request.headers.get("X-CSRF-Token", "")
        if not header_csrf or not hmac.compare_digest(header_csrf, session["csrf_token"]):
            raise HTTPException(status_code=403, detail="CSRF 토큰이 유효하지 않습니다.")
        soop_target = body.soop_id.strip().lower()
        if session["role"] not in ("admin", "staff"):
            allowed_ids = {x for x in (session["soop_id"], session["soop_pending_id"]) if x}
            if soop_target not in allowed_ids:
                raise HTTPException(status_code=403, detail="본인의 연동/대기 중인 SOOP 아이디만 테스트할 수 있습니다.")

    return _process_soop_chat_event(body.soop_id, body.message, body.event_id)


def _get_setting(conn, key: str) -> str:
    row = conn.execute("SELECT value FROM site_settings WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row else ""


def _set_setting(conn, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO site_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, value, utc_now_iso()),
    )


def _post_soop_form(url: str, params: dict[str, str]) -> dict:
    encoded = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=encoded,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "*/*",
            "User-Agent": "Mozilla/5.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="ignore")
        raise HTTPException(status_code=502, detail=f"SOOP API 오류 ({exc.code}): {err_body or exc.reason}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SOOP API 연결 실패: {exc}")


@app.get("/api/admin/soop-sdk/config")
def get_soop_sdk_config(admin: dict = Depends(require_admin)):
    conn = get_connection()
    try:
        client_id = _get_setting(conn, "soop_client_id")
        has_secret = bool(_get_setting(conn, "soop_client_secret"))
        access_token = _get_setting(conn, "soop_access_token")
        refresh_token = _get_setting(conn, "soop_refresh_token")
        expires_at = _get_setting(conn, "soop_token_expires_at")
        return {
            "client_id": client_id,
            "has_secret": has_secret,
            "has_token": bool(access_token),
            "has_refresh": bool(refresh_token),
            "access_token": access_token,
            "token_expires_at": int(expires_at) if expires_at.isdigit() else 0,
        }
    finally:
        conn.close()


@app.put("/api/admin/soop-sdk/config")
def save_soop_sdk_config(body: SoopSdkConfigBody, admin: dict = Depends(require_admin)):
    client_id = body.client_id.strip()
    client_secret = body.client_secret.strip()
    with transaction() as conn:
        _set_setting(conn, "soop_client_id", client_id)
        if client_secret:
            _set_setting(conn, "soop_client_secret", client_secret)
    return {"ok": True}


@app.post("/api/admin/soop-sdk/token")
def issue_soop_sdk_token(body: SoopSdkTokenBody, admin: dict = Depends(require_admin)):
    conn = get_connection()
    try:
        client_id = _get_setting(conn, "soop_client_id")
        client_secret = _get_setting(conn, "soop_client_secret")
    finally:
        conn.close()

    if not client_id or not client_secret:
        raise HTTPException(status_code=400, detail="먼저 SOOP Client ID와 Client Secret을 저장하세요.")

    auth_code = body.code.strip()
    if not auth_code and body.certification_number.strip():
        cert = body.certification_number.strip()
        if not cert.isdigit():
            raise HTTPException(status_code=400, detail="SOOP 앱 6자리 숫자 인증번호를 입력하세요.")
        code_resp = _post_soop_form(
            "https://openapi.sooplive.com/auth/code",
            {
                "client_id": client_id,
                "auth_type": "api",
                "certification_number": cert,
                "scope": "broad_access_chatinfo",
            },
        )
        auth_code = str(code_resp.get("code") or "").strip()
        if not auth_code:
            raise HTTPException(status_code=502, detail="SOOP 인증 코드(code)를 받지 못했습니다.")

    if not auth_code:
        raise HTTPException(status_code=400, detail="OAuth code 또는 6자리 인증번호가 필요합니다.")

    token_params = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "client_secret": client_secret,
        "code": auth_code,
    }
    if body.redirect_uri.strip():
        token_params["redirect_uri"] = body.redirect_uri.strip()

    token_resp = _post_soop_form("https://openapi.sooplive.com/auth/token", token_params)
    access_token = str(token_resp.get("access_token") or "").strip()
    refresh_token = str(token_resp.get("refresh_token") or "").strip()
    expires_in = int(token_resp.get("expires_in") or 28800)
    if not access_token:
        raise HTTPException(status_code=502, detail="SOOP access_token 발급에 실패했습니다.")

    expires_at = int(time.time()) + expires_in
    with transaction() as conn:
        _set_setting(conn, "soop_access_token", access_token)
        if refresh_token:
            _set_setting(conn, "soop_refresh_token", refresh_token)
        _set_setting(conn, "soop_token_expires_at", str(expires_at))

    return {"access_token": access_token, "expires_in": expires_in, "token_expires_at": expires_at}


@app.post("/api/admin/soop-sdk/refresh")
def refresh_soop_sdk_token(admin: dict = Depends(require_admin)):
    conn = get_connection()
    try:
        client_id = _get_setting(conn, "soop_client_id")
        client_secret = _get_setting(conn, "soop_client_secret")
        refresh_token = _get_setting(conn, "soop_refresh_token")
    finally:
        conn.close()

    if not (client_id and client_secret and refresh_token):
        raise HTTPException(status_code=400, detail="갱신할 SOOP refresh_token 또는 API 키가 없습니다.")

    token_resp = _post_soop_form(
        "https://openapi.sooplive.com/auth/token",
        {
            "grant_type": "refresh_token",
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
        },
    )
    access_token = str(token_resp.get("access_token") or "").strip()
    new_refresh = str(token_resp.get("refresh_token") or refresh_token).strip()
    expires_in = int(token_resp.get("expires_in") or 28800)
    if not access_token:
        raise HTTPException(status_code=502, detail="SOOP 토큰 갱신에 실패했습니다.")

    expires_at = int(time.time()) + expires_in
    with transaction() as conn:
        _set_setting(conn, "soop_access_token", access_token)
        _set_setting(conn, "soop_refresh_token", new_refresh)
        _set_setting(conn, "soop_token_expires_at", str(expires_at))

    return {"access_token": access_token, "expires_in": expires_in, "token_expires_at": expires_at}


@app.post("/api/integrations/soop/sdk-message")
def ingest_soop_sdk_message(body: SoopSdkMessageBody, admin: dict = Depends(require_admin)):
    sender_id = body.user_id.strip().lower()
    msg = body.message.strip()
    collector_state["connected"] = True
    collector_state["status_text"] = f"🟢 공식 SOOP Chat SDK 연결됨 ({collector_state['channel_id']})"
    collector_state["messages_seen"] += 1
    collector_state["last_updated"] = time.time()

    res = _process_soop_chat_event(sender_id, msg)
    if res.get("status") == "awarded":
        collector_state["points_awarded"] += int(res.get("awarded", 0))
        collector_state["recent_logs"].appendleft(
            {"soop_id": sender_id, "text": f"+{res.get('awarded')}P · {sender_id}: {msg[:30]}"}
        )
    elif res.get("status") == "verified":
        collector_state["recent_logs"].appendleft(
            {"soop_id": sender_id, "text": f"✅ 인증완료 · {sender_id}"}
        )
    return res


# ---------------------------------------------------------------------------
# SOOP Station Board Notices (Live Sync)
# ---------------------------------------------------------------------------

SOOP_NOTICE_STATION_ID = "leeso0403"
SOOP_NOTICE_BOARD_ID = "117677437"
SOOP_NOTICE_BOARD_URL = f"https://www.sooplive.com/station/{SOOP_NOTICE_STATION_ID}/board/{SOOP_NOTICE_BOARD_ID}"
_soop_notice_cache: dict = {"ts": 0.0, "posts": []}


def _strip_html(raw_html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw_html or "")
    text = html_lib.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _extract_soop_images(raw_html: str) -> list[str]:
    urls = re.findall(r'<img[^>]+src=["\']([^"\']+)["\']', raw_html or "", re.I)
    photos = []
    stickers = []
    seen = set()
    for u in urls:
        if u.startswith("//"):
            u = "https:" + u
        if not re.match(r"^https://[a-zA-Z0-9.-]+\.sooplive\.com/", u):
            continue
        if u in seen:
            continue
        seen.add(u)
        if "stimg.sooplive.com" in u:
            photos.append(u)
        else:
            stickers.append(u)
    return (photos + stickers)[:4]


_soop_notice_pages_cache: dict[int, dict] = {}


@app.get("/api/soop/notices")
def get_soop_notices(page: int = 1):
    page = max(1, min(page, 100))
    now = time.time()
    cached = _soop_notice_pages_cache.get(page)
    if cached and now - cached["ts"] < 60:
        return cached["payload"]

    api_url = (
        f"https://chapi.sooplive.com/api/{SOOP_NOTICE_STATION_ID}/board/{SOOP_NOTICE_BOARD_ID}"
        f"?page={page}&per_page=20&field=title,contents,user_nick,user_id"
    )
    req = urllib.request.Request(
        api_url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": SOOP_NOTICE_BOARD_URL,
            "Origin": "https://www.sooplive.com",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        items = payload.get("data") or []
        meta = payload.get("meta") or {}
        posts = []
        for item in items:
            title_no = item.get("title_no")
            if not title_no:
                continue
            counts = item.get("count") or {}
            content_obj = item.get("content") or {}
            raw_content = content_obj.get("content", "") if isinstance(content_obj, dict) else ""
            images = _extract_soop_images(raw_content)
            posts.append(
                {
                    "title_no": title_no,
                    "title": item.get("title_name") or "(제목 없음)",
                    "author": item.get("user_nick") or SOOP_NOTICE_STATION_ID,
                    "reg_date": item.get("reg_date") or "",
                    "read_cnt": counts.get("read_cnt", 0),
                    "comment_cnt": counts.get("comment_cnt", 0),
                    "like_cnt": counts.get("like_cnt", 0),
                    "is_pinned": int(item.get("notice_yn") or 0) > 0,
                    "preview": _strip_html(raw_content)[:120],
                    "images": images,
                    "thumbnail": images[0] if images else None,
                    "url": f"https://www.sooplive.com/station/{SOOP_NOTICE_STATION_ID}/post/{title_no}",
                }
            )
        out = {
            "posts": posts,
            "board_url": SOOP_NOTICE_BOARD_URL,
            "current_page": int(meta.get("current_page") or page),
            "last_page": int(meta.get("last_page") or page),
            "total": int(meta.get("total") or len(posts)),
        }
        _soop_notice_pages_cache[page] = {"ts": now, "payload": out}
        return out
    except Exception:
        if cached:
            return cached["payload"]
        return {
            "posts": [],
            "board_url": SOOP_NOTICE_BOARD_URL,
            "current_page": page,
            "last_page": page,
            "total": 0,
            "error": "SOOP 공지사항을 불러오는 중 일시적인 오류가 발생했습니다.",
        }


_soop_vod_cache: dict = {"ts": 0.0, "vods": []}


@app.get("/api/soop/vods")
def get_soop_vods():
    vod_page_url = f"https://www.sooplive.com/station/{SOOP_NOTICE_STATION_ID}/vod"
    now = time.time()
    if _soop_vod_cache["vods"] and now - _soop_vod_cache["ts"] < 60:
        return {"vods": _soop_vod_cache["vods"], "vod_page_url": vod_page_url}

    api_url = f"https://chapi.sooplive.com/api/{SOOP_NOTICE_STATION_ID}/vods/all?page=1&per_page=8"
    req = urllib.request.Request(
        api_url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": vod_page_url,
            "Origin": "https://www.sooplive.com",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        items = payload.get("data") or []
        vods = []
        for item in items:
            title_no = item.get("title_no")
            if not title_no:
                continue
            ucc = item.get("ucc") or {}
            thumb = str(ucc.get("thumb") or "")
            if thumb.startswith("//"):
                thumb = "https:" + thumb
            if not thumb.startswith("https://"):
                thumb = ""
            counts = item.get("count") or {}
            vods.append(
                {
                    "title_no": title_no,
                    "title": item.get("title_name") or "(제목 없음)",
                    "reg_date": item.get("reg_date") or "",
                    "thumb": thumb,
                    "read_cnt": counts.get("read_cnt", 0),
                    "url": f"https://vod.sooplive.com/player/{title_no}",
                }
            )
        vods.sort(key=lambda v: v["reg_date"], reverse=True)
        vods = vods[:8]
        _soop_vod_cache["ts"] = now
        _soop_vod_cache["vods"] = vods
        return {"vods": vods, "vod_page_url": vod_page_url}
    except Exception:
        return {
            "vods": _soop_vod_cache["vods"],
            "vod_page_url": vod_page_url,
            "error": "SOOP 다시보기를 불러오는 중 일시적인 오류가 발생했습니다.",
        }


# ---------------------------------------------------------------------------
# Stream Status, Board, Signatures, Calendar
# ---------------------------------------------------------------------------

_stream_live_cache: dict = {"ts": 0.0, "data": None}


@app.get("/api/stream/status")
def get_stream_status():
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM stream_status WHERE id = 1").fetchone()
        base = dict(row) if row else {
            "streamer_name": "체온",
            "soop_channel_id": SOOP_NOTICE_STATION_ID,
            "is_live": 0,
            "title": "",
            "category": "",
            "notice_banner": "",
        }
    finally:
        conn.close()

    channel_id = base.get("soop_channel_id") or SOOP_NOTICE_STATION_ID
    now = time.time()
    if _stream_live_cache["data"] and now - _stream_live_cache["ts"] < 20:
        return _stream_live_cache["data"]

    station_url = f"https://www.sooplive.com/station/{channel_id}"
    api_url = f"https://chapi.sooplive.com/api/{channel_id}/station"
    req = urllib.request.Request(
        api_url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": station_url,
            "Origin": "https://www.sooplive.com",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        broad = payload.get("broad")
        if isinstance(broad, dict) and broad.get("broad_no"):
            broad_no = broad["broad_no"]
            base["is_live"] = 1
            base["title"] = broad.get("broad_title") or base.get("title") or "생방송 중!"
            base["viewers"] = int(broad.get("current_sum_viewer") or 0)
            base["live_url"] = f"https://play.sooplive.com/{channel_id}/{broad_no}"
        else:
            base["is_live"] = 0
            base["viewers"] = 0
            base["live_url"] = station_url
        base["auto_synced"] = True
        _stream_live_cache["ts"] = now
        _stream_live_cache["data"] = base
    except Exception:
        base["live_url"] = station_url
        base["auto_synced"] = False
    return base


@app.put("/api/stream/status")
def update_stream_status(body: StreamStatusUpdateBody, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        conn.execute(
            """
            UPDATE stream_status
            SET is_live = ?, title = ?, category = ?, notice_banner = ?, updated_at = ?
            WHERE id = 1
            """,
            (
                1 if body.is_live else 0,
                clean_text(body.title, 120),
                clean_text(body.category, 40),
                clean_text(body.notice_banner, 200),
                utc_now_iso(),
            ),
        )
        row = conn.execute("SELECT * FROM stream_status WHERE id = 1").fetchone()
        return dict(row)


ALLOWED_IMAGE_EXTS = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
ALLOWED_VIDEO_EXTS = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
}


def _verify_magic_bytes(ext: str, head: bytes) -> bool:
    if ext in (".jpg", ".jpeg"):
        return head.startswith(b"\xff\xd8\xff")
    if ext == ".png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ext == ".gif":
        return head.startswith((b"GIF87a", b"GIF89a"))
    if ext == ".webp":
        return head.startswith(b"RIFF") and head[8:12] == b"WEBP"
    if ext in (".mp4", ".mov"):
        return b"ftyp" in head[:16]
    if ext == ".webm":
        return head.startswith(b"\x1a\x45\xdf\xa3")
    return False


def _sanitize_attachments(raw_list: list[dict]) -> list[dict]:
    cleaned = []
    for item in raw_list[:4]:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url", ""))
        kind = str(item.get("kind", ""))
        name = clean_text(str(item.get("name", "file")), 80)
        if not re.fullmatch(r"/uploads/[a-f0-9]{32}\.[a-z0-9]{2,5}", url):
            continue
        if kind not in ("image", "video"):
            continue
        cleaned.append({"url": url, "kind": kind, "name": name})
    return cleaned


@app.post("/api/uploads")
async def upload_media(files: list[UploadFile] = File(...), session: dict = Depends(require_csrf)):
    if not rate_limiter.allow(f"upload:{session['id']}", limit=20, window_seconds=300):
        raise HTTPException(status_code=429, detail="파일 업로드 요청이 너무 많습니다.")
    if len(files) > 4:
        raise HTTPException(status_code=400, detail="파일은 한 번에 최대 4개까지 첨부할 수 있습니다.")

    saved = []
    for uf in files:
        orig_name = Path(uf.filename or "file").name
        ext = Path(orig_name).suffix.lower()
        if ext in ALLOWED_IMAGE_EXTS:
            kind = "image"
            max_bytes = 15 * 1024 * 1024
        elif ext in ALLOWED_VIDEO_EXTS:
            kind = "video"
            max_bytes = 60 * 1024 * 1024
        else:
            raise HTTPException(
                status_code=400,
                detail="허용되지 않는 파일 형식입니다. (이미지: jpg/png/gif/webp, 영상: mp4/webm/mov)",
            )

        data = await uf.read()
        if not data or len(data) > max_bytes:
            raise HTTPException(status_code=400, detail=f"파일 크기는 최대 {max_bytes // (1024 * 1024)}MB까지 가능합니다.")
        if not _verify_magic_bytes(ext, data[:32]):
            raise HTTPException(status_code=400, detail="파일 내용이 확장자와 일치하지 않습니다.")

        safe_filename = f"{uuid.uuid4().hex}{ext}"
        content_type = ALLOWED_IMAGE_EXTS.get(ext) or ALLOWED_VIDEO_EXTS.get(ext) or "application/octet-stream"
        (UPLOAD_DIR / safe_filename).write_bytes(data)
        with transaction() as conn:
            conn.execute(
                """
                INSERT INTO uploaded_files (filename, content_type, data, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(filename) DO UPDATE SET content_type = excluded.content_type, data = excluded.data
                """,
                (safe_filename, content_type, data, utc_now_iso()),
            )
        saved.append({"url": f"/uploads/{safe_filename}", "kind": kind, "name": clean_text(orig_name, 80)})

    return {"files": saved}


@app.get("/api/posts")
def list_posts(
    tab: str | None = None,
    q: str | None = None,
    sort: str = "latest",
    session: dict | None = Depends(get_current_session),
):
    conn = get_connection()
    try:
        uid = session["id"] if session else -1
        is_mod = bool(session and session["role"] in ("admin", "staff"))
        sql = """
            SELECT p.id, p.tab, p.title, p.content, p.author_id, p.is_pinned, p.is_anonymous, p.is_hidden, p.attachments, p.views, p.created_at,
                   u.nickname AS author_nickname, u.username AS author_username, u.soop_id AS author_soop_id, u.role AS author_role,
                   (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
                   (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count,
                   (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = ?) AS liked_by_me
            FROM posts p
            JOIN users u ON u.id = p.author_id
            WHERE 1=1
        """
        params: list = [uid]
        if not is_mod:
            sql += " AND p.is_hidden = 0"
        if tab and tab != "all":
            sql += " AND p.tab = ?"
            params.append(tab)
        if q:
            sql += " AND (p.title LIKE ? OR p.content LIKE ?)"
            like = f"%{q.strip()}%"
            params.extend([like, like])
        if sort == "popular":
            sql += " ORDER BY p.is_pinned DESC, like_count DESC, p.id DESC LIMIT 100"
        else:
            sql += " ORDER BY p.is_pinned DESC, p.id DESC LIMIT 100"
        rows = conn.execute(sql, params).fetchall()
        posts_out = []
        for r in rows:
            d = dict(r)
            d["liked_by_me"] = bool(d.get("liked_by_me"))
            real_nick = d.get("author_nickname") or ""
            real_user = d.pop("author_username", "")
            real_soop = d.pop("author_soop_id", None)
            if d.get("is_anonymous"):
                if is_mod:
                    soop_part = f" / SOOP:{real_soop}" if real_soop else ""
                    d["author_nickname"] = f"익명 (실제: {real_nick} / {real_user}{soop_part})"
                else:
                    d["author_nickname"] = "익명"
            try:
                d["attachments"] = json.loads(d.get("attachments") or "[]")
            except Exception:
                d["attachments"] = []
            posts_out.append(d)
        return {"posts": posts_out}
    finally:
        conn.close()


@app.get("/api/posts/{post_id}")
def get_post(post_id: int, session: dict | None = Depends(get_current_session)):
    uid = session["id"] if session else -1
    is_mod = bool(session and session["role"] in ("admin", "staff"))
    with transaction() as conn:
        conn.execute("UPDATE posts SET views = views + 1 WHERE id = ?", (post_id,))
        post = conn.execute(
            """
            SELECT p.*, u.nickname AS author_nickname, u.username AS author_username, u.soop_id AS author_soop_id, u.role AS author_role,
                   (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count,
                   (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = ?) AS liked_by_me
            FROM posts p
            JOIN users u ON u.id = p.author_id
            WHERE p.id = ?
            """,
            (uid, post_id),
        ).fetchone()
        if not post:
            raise HTTPException(status_code=404, detail="게시글을 찾을 수 없습니다.")
        post_dict = dict(post)
        if post_dict.get("is_hidden") and not is_mod:
            raise HTTPException(status_code=403, detail="비공개 처리된 게시글입니다.")
        post_dict["liked_by_me"] = bool(post_dict.get("liked_by_me"))
        real_nick = post_dict.get("author_nickname") or ""
        real_user = post_dict.pop("author_username", "")
        real_soop = post_dict.pop("author_soop_id", None)
        if post_dict.get("is_anonymous"):
            if is_mod:
                soop_part = f" / SOOP:{real_soop}" if real_soop else ""
                post_dict["author_nickname"] = f"익명 (실제: {real_nick} / {real_user}{soop_part})"
            else:
                post_dict["author_nickname"] = "익명"
        try:
            post_dict["attachments"] = json.loads(post_dict.get("attachments") or "[]")
        except Exception:
            post_dict["attachments"] = []

        comments = conn.execute(
            """
            SELECT c.*, u.nickname AS author_nickname, u.role AS author_role
            FROM comments c
            JOIN users u ON u.id = c.author_id
            WHERE c.post_id = ?
            ORDER BY c.id ASC
            """,
            (post_id,),
        ).fetchall()
        return {"post": post_dict, "comments": [dict(c) for c in comments]}


@app.post("/api/posts/{post_id}/like")
def toggle_post_like(post_id: int, session: dict = Depends(require_csrf)):
    with transaction() as conn:
        post = conn.execute("SELECT id, author_id, title FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not post:
            raise HTTPException(status_code=404, detail="게시글을 찾을 수 없습니다.")
        already = conn.execute(
            "SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?",
            (post_id, session["id"]),
        ).fetchone()
        if already:
            conn.execute(
                "DELETE FROM post_likes WHERE post_id = ? AND user_id = ?",
                (post_id, session["id"]),
            )
            liked = False
        else:
            conn.execute(
                "INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)",
                (post_id, session["id"], utc_now_iso()),
            )
            liked = True
        cnt = int(
            conn.execute(
                "SELECT COUNT(*) AS cnt FROM post_likes WHERE post_id = ?",
                (post_id,),
            ).fetchone()["cnt"]
        )

        # Award points to post author for likes from other users (idempotent: no duplicate farming)
        if liked and post["author_id"] != session["id"]:
            apply_point_delta(
                conn,
                post["author_id"],
                LIKE_RECEIVED_POINTS,
                f"게시글 추천 받음 ({post['title'][:25]})",
                "board",
                idempotency_key=f"like_reward:{post_id}:{session['id']}",
            )
            for threshold, bonus in LIKE_MILESTONES.items():
                if cnt >= threshold:
                    apply_point_delta(
                        conn,
                        post["author_id"],
                        bonus,
                        f"인기글 추천 {threshold}개 달성 보너스 ({post['title'][:20]})",
                        "board",
                        idempotency_key=f"like_milestone:{post_id}:{threshold}",
                    )
        return {"liked": liked, "like_count": cnt}


@app.post("/api/posts")
def create_post(body: PostCreateBody, session: dict = Depends(require_csrf)):
    if not rate_limiter.allow(f"post:{session['id']}", limit=10, window_seconds=300):
        raise HTTPException(status_code=429, detail="게시글 작성 속도가 너무 빠릅니다.")

    if body.tab == "notice" and session["role"] not in ("admin", "staff"):
        raise HTTPException(status_code=403, detail="공지사항은 관리자만 작성할 수 있습니다.")

    is_pinned = 1 if (body.is_pinned and session["role"] in ("admin", "staff")) else 0
    is_anonymous = 1 if body.is_anonymous else 0
    attachments_json = json.dumps(_sanitize_attachments(body.attachments), ensure_ascii=False)
    title = clean_text(body.title, 120)
    content = clean_text(body.content, 5000)
    if not title or not content:
        raise HTTPException(status_code=400, detail="제목과 내용을 입력해 주세요.")

    now = utc_now_iso()
    with transaction() as conn:
        cur = conn.execute(
            """
            INSERT INTO posts (tab, title, content, author_id, is_pinned, is_anonymous, attachments, views, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (body.tab, title, content, session["id"], is_pinned, is_anonymous, attachments_json, now, now),
        )
        post_id = cur.lastrowid

        # Award small board activity point (max 3 times/day, counting only post rewards)
        today = today_kst_str()
        kst_tz = timezone(timedelta(hours=9))
        today_start_utc = datetime.strptime(today, "%Y-%m-%d").replace(tzinfo=kst_tz).astimezone(timezone.utc).isoformat()
        today_count = conn.execute(
            """
            SELECT COUNT(*) AS cnt FROM point_ledger
            WHERE user_id = ? AND idempotency_key LIKE 'post:%' AND created_at >= ?
            """,
            (session["id"], today_start_utc),
        ).fetchone()["cnt"]
        awarded = 0
        if today_count < 3:
            awarded = POST_CREATE_POINTS * (2 if is_double_points_active(conn, session["id"]) else 1)
            apply_point_delta(
                conn,
                session["id"],
                POST_CREATE_POINTS,
                "커뮤니티 게시글 작성 적립",
                "board",
                idempotency_key=f"post:{post_id}",
            )

        return {"id": post_id, "awarded": awarded}


@app.put("/api/posts/{post_id}")
def update_post(post_id: int, body: PostCreateBody, admin: dict = Depends(require_admin)):
    title = clean_text(body.title, 120)
    content = clean_text(body.content, 5000)
    if not title or not content:
        raise HTTPException(status_code=400, detail="제목과 내용을 입력해 주세요.")

    with transaction() as conn:
        post = conn.execute("SELECT id FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not post:
            raise HTTPException(status_code=404, detail="게시글을 찾을 수 없습니다.")
        conn.execute(
            """
            UPDATE posts
            SET tab = ?, title = ?, content = ?, is_pinned = ?, updated_at = ?
            WHERE id = ?
            """,
            (body.tab, title, content, 1 if body.is_pinned else 0, utc_now_iso(), post_id),
        )
    return {"ok": True}


@app.post("/api/posts/{post_id}/hide")
def toggle_post_hidden(post_id: int, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        post = conn.execute("SELECT id, is_hidden FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not post:
            raise HTTPException(status_code=404, detail="게시글을 찾을 수 없습니다.")
        new_val = 0 if post["is_hidden"] else 1
        conn.execute("UPDATE posts SET is_hidden = ?, updated_at = ? WHERE id = ?", (new_val, utc_now_iso(), post_id))
        return {"is_hidden": bool(new_val)}


@app.delete("/api/posts/{post_id}")
def delete_post(post_id: int, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        post = conn.execute("SELECT id FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not post:
            raise HTTPException(status_code=404, detail="게시글을 찾을 수 없습니다.")
        conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
    return {"ok": True}


@app.post("/api/posts/{post_id}/comments")
def create_comment(post_id: int, body: CommentCreateBody, session: dict = Depends(require_csrf)):
    if not rate_limiter.allow(f"comment:{session['id']}", limit=20, window_seconds=120):
        raise HTTPException(status_code=429, detail="댓글 작성 속도가 너무 빠릅니다.")

    content = clean_text(body.content, 1000)
    if not content:
        raise HTTPException(status_code=400, detail="댓글 내용을 입력해 주세요.")

    with transaction() as conn:
        exists = conn.execute("SELECT id FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="게시글이 존재하지 않습니다.")
        cur = conn.execute(
            """
            INSERT INTO comments (post_id, author_id, content, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (post_id, session["id"], content, utc_now_iso()),
        )
        return {"id": cur.lastrowid}


@app.put("/api/comments/{comment_id}")
def update_comment(comment_id: int, body: CommentCreateBody, admin: dict = Depends(require_admin)):
    content = clean_text(body.content, 1000)
    if not content:
        raise HTTPException(status_code=400, detail="댓글 내용을 입력해 주세요.")
    with transaction() as conn:
        row = conn.execute("SELECT id FROM comments WHERE id = ?", (comment_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="댓글을 찾을 수 없습니다.")
        conn.execute("UPDATE comments SET content = ? WHERE id = ?", (content, comment_id))
    return {"ok": True}


@app.delete("/api/comments/{comment_id}")
def delete_comment(comment_id: int, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        row = conn.execute("SELECT id FROM comments WHERE id = ?", (comment_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="댓글을 찾을 수 없습니다.")
        conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
    return {"ok": True}


@app.get("/api/signatures")
def list_signatures(category: str | None = None):
    conn = get_connection()
    try:
        if category and category != "전체":
            rows = conn.execute(
                "SELECT * FROM signatures WHERE category = ? ORDER BY balloon_count ASC",
                (category,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM signatures ORDER BY balloon_count ASC").fetchall()
        return {"signatures": [dict(r) for r in rows]}
    finally:
        conn.close()


def _safe_clip_url(url: str) -> str:
    u = url.strip()
    if not u:
        return ""
    if re.match(r"^https://[a-zA-Z0-9.-]+/", u):
        return u[:300]
    return ""


def _safe_sig_image_url(url: str) -> str:
    u = url.strip()
    if not u:
        return ""
    if re.fullmatch(r"/uploads/[a-f0-9]{32}\.[a-z0-9]{2,5}", u) or re.match(r"^https://[a-zA-Z0-9.-]+/", u):
        return u[:300]
    return ""


@app.post("/api/signatures")
def create_signature(body: SignatureCreateBody, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        cur = conn.execute(
            """
            INSERT INTO signatures (title, balloon_count, category, description, badge, clip_url, image_url, tags, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                clean_text(body.title, 60),
                body.balloon_count,
                clean_text(body.category, 24),
                clean_text(body.description, 200),
                clean_text(body.badge, 8) or "💖",
                _safe_clip_url(body.clip_url),
                _safe_sig_image_url(body.image_url),
                clean_text(body.tags, 80),
                utc_now_iso(),
            ),
        )
        return {"id": cur.lastrowid}


@app.put("/api/signatures/{sig_id}")
def update_signature(sig_id: int, body: SignatureCreateBody, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        row = conn.execute("SELECT id FROM signatures WHERE id = ?", (sig_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="시그니처를 찾을 수 없습니다.")
        conn.execute(
            """
            UPDATE signatures
            SET title = ?, balloon_count = ?, category = ?, description = ?, badge = ?, clip_url = ?, image_url = ?, tags = ?
            WHERE id = ?
            """,
            (
                clean_text(body.title, 60),
                body.balloon_count,
                clean_text(body.category, 24),
                clean_text(body.description, 200),
                clean_text(body.badge, 8) or "💖",
                _safe_clip_url(body.clip_url),
                _safe_sig_image_url(body.image_url),
                clean_text(body.tags, 80),
                sig_id,
            ),
        )
    return {"ok": True}


@app.delete("/api/signatures/{sig_id}")
def delete_signature(sig_id: int, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        conn.execute("DELETE FROM signatures WHERE id = ?", (sig_id,))
    return {"ok": True}


@app.get("/api/calendar")
def list_calendar(month: str | None = None):
    conn = get_connection()
    try:
        if month and re.fullmatch(r"\d{4}-\d{2}", month):
            rows = conn.execute(
                "SELECT * FROM calendar_events WHERE event_date LIKE ? ORDER BY event_date ASC, start_time ASC",
                (f"{month}%",),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM calendar_events ORDER BY event_date ASC, start_time ASC"
            ).fetchall()
        return {"events": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.post("/api/calendar")
def create_calendar_event(body: CalendarCreateBody, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        cur = conn.execute(
            """
            INSERT INTO calendar_events (title, event_date, start_time, category, description, color, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                clean_text(body.title, 80),
                body.event_date,
                body.start_time,
                body.category,
                clean_text(body.description, 300),
                body.color,
                utc_now_iso(),
            ),
        )
        return {"id": cur.lastrowid}


@app.put("/api/calendar/{event_id}")
def update_calendar_event(event_id: int, body: CalendarCreateBody, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        row = conn.execute("SELECT id FROM calendar_events WHERE id = ?", (event_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="일정을 찾을 수 없습니다.")
        conn.execute(
            """
            UPDATE calendar_events
            SET title = ?, event_date = ?, start_time = ?, category = ?, description = ?, color = ?
            WHERE id = ?
            """,
            (
                clean_text(body.title, 80),
                body.event_date,
                body.start_time,
                body.category,
                clean_text(body.description, 300),
                body.color,
                event_id,
            ),
        )
    return {"ok": True}


@app.delete("/api/calendar/{event_id}")
def delete_calendar_event(event_id: int, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        conn.execute("DELETE FROM calendar_events WHERE id = ?", (event_id,))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Points, Attendance, Shop & Admin
# ---------------------------------------------------------------------------

@app.post("/api/points/attendance")
def daily_attendance(session: dict = Depends(require_csrf)):
    today = today_kst_str()
    idem_key = f"attendance:{session['id']}:{today}"
    with transaction() as conn:
        awarded = ATTENDANCE_POINTS * (2 if is_double_points_active(conn, session["id"]) else 1)
        applied, new_balance = apply_point_delta(
            conn,
            session["id"],
            ATTENDANCE_POINTS,
            f"일일 출석체크 ({today})",
            "attendance",
            idempotency_key=idem_key,
        )
        if not applied:
            raise HTTPException(status_code=409, detail="오늘 출석체크를 이미 완료했습니다.")
        return {"awarded": awarded, "balance": new_balance}


@app.get("/api/points/ledger")
def get_my_ledger(page: int = 1, per_page: int = 10, session: dict = Depends(require_user)):
    page = max(1, page)
    per_page = max(1, min(per_page, 50))
    offset = (page - 1) * per_page
    conn = get_connection()
    try:
        total = conn.execute(
            "SELECT COUNT(*) AS cnt FROM point_ledger WHERE user_id = ?",
            (session["id"],),
        ).fetchone()["cnt"]
        total_pages = max(1, (int(total) + per_page - 1) // per_page)
        if page > total_pages:
            page = total_pages
            offset = (page - 1) * per_page
        rows = conn.execute(
            """
            SELECT id, delta, balance_after, reason, source, created_at
            FROM point_ledger
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT ? OFFSET ?
            """,
            (session["id"], per_page, offset),
        ).fetchall()
        return {
            "ledger": [dict(r) for r in rows],
            "page": page,
            "per_page": per_page,
            "total": int(total),
            "total_pages": total_pages,
        }
    finally:
        conn.close()


def _parse_prediction_options(row: dict) -> list[str]:
    try:
        opts = json.loads(row.get("options_json") or "[]")
        if isinstance(opts, list) and len(opts) >= 2:
            return [str(o) for o in opts]
    except Exception:
        pass
    return [row.get("option_a") or "A", row.get("option_b") or "B"]


def _parse_closes_at_utc(raw: str | None) -> str | None:
    if not raw or not raw.strip():
        return None
    s = raw.strip()
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        raise HTTPException(status_code=400, detail="마감 시간 형식이 올바르지 않습니다.")
    if dt.tzinfo is None:
        # HTML datetime-local input has no timezone; treat as KST (UTC+9)
        dt = dt.replace(tzinfo=timezone(timedelta(hours=9)))
    dt_utc = dt.astimezone(timezone.utc)
    if dt_utc <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="마감 시간은 현재 시간 이후로 설정해야 합니다.")
    return dt_utc.isoformat()


def _auto_lock_expired_predictions(conn) -> None:
    now_utc = datetime.now(timezone.utc)
    open_rows = conn.execute(
        "SELECT id, closes_at FROM predictions WHERE status = 'open' AND closes_at IS NOT NULL"
    ).fetchall()
    for row in open_rows:
        try:
            dt = datetime.fromisoformat(row["closes_at"])
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if now_utc >= dt:
                conn.execute("UPDATE predictions SET status = 'locked' WHERE id = ?", (row["id"],))
        except Exception:
            continue


@app.get("/api/predictions")
def list_predictions(session: dict | None = Depends(get_current_session)):
    uid = session["id"] if session else -1
    with transaction() as conn:
        _auto_lock_expired_predictions(conn)
        rows = conn.execute("SELECT * FROM predictions ORDER BY id DESC LIMIT 30").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            opt_labels = _parse_prediction_options(d)
            agg = conn.execute(
                """
                SELECT choice, COALESCE(SUM(amount), 0) AS total_amount, COUNT(DISTINCT user_id) AS bettors
                FROM prediction_bets
                WHERE prediction_id = ?
                GROUP BY choice
                """,
                (d["id"],),
            ).fetchall()
            pool_map: dict[str, tuple[int, int]] = {}
            for a in agg:
                pool_map[str(a["choice"])] = (int(a["total_amount"]), int(a["bettors"]))

            total_pool = sum(v[0] for v in pool_map.values())
            options_out = []
            for idx, label in enumerate(opt_labels):
                key = str(idx)
                pool, cnt = pool_map.get(key, (0, 0))
                pct = round((pool / total_pool) * 100) if total_pool > 0 else round(100 / len(opt_labels))
                odds = round(total_pool / pool, 2) if pool > 0 else 1.0
                options_out.append(
                    {
                        "index": key,
                        "label": label,
                        "pool": pool,
                        "count": cnt,
                        "pct": pct,
                        "odds": f"{odds:.2f}",
                    }
                )

            my_rows = conn.execute(
                """
                SELECT choice, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(payout), 0) AS payout
                FROM prediction_bets
                WHERE prediction_id = ? AND user_id = ?
                GROUP BY choice
                """,
                (d["id"], uid),
            ).fetchall()

            closes_kst = None
            if d.get("closes_at"):
                try:
                    dt = datetime.fromisoformat(d["closes_at"])
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    closes_kst = (dt + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M")
                except Exception:
                    closes_kst = None

            d["closes_at_kst"] = closes_kst
            d["options"] = options_out
            d["total_pool"] = total_pool
            d["my_bets"] = [dict(mb) for mb in my_rows]
            out.append(d)
        return {"predictions": out}


@app.post("/api/predictions")
def create_prediction(body: PredictionCreateBody, admin: dict = Depends(require_admin)):
    title = clean_text(body.title, 120)
    cleaned_opts = [clean_text(o, 40) for o in body.options if clean_text(o, 40)]
    if not title or len(cleaned_opts) < 2:
        raise HTTPException(status_code=400, detail="제목과 최소 2개 이상의 항목을 입력해 주세요.")
    cleaned_opts = cleaned_opts[:10]
    closes_utc = _parse_closes_at_utc(body.closes_at)
    with transaction() as conn:
        cur = conn.execute(
            """
            INSERT INTO predictions (title, option_a, option_b, options_json, status, closes_at, created_by, created_at)
            VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
            """,
            (
                title,
                cleaned_opts[0],
                cleaned_opts[1],
                json.dumps(cleaned_opts, ensure_ascii=False),
                closes_utc,
                admin["id"],
                utc_now_iso(),
            ),
        )
        return {"id": cur.lastrowid}


@app.post("/api/predictions/{pred_id}/bet")
def place_prediction_bet(pred_id: int, body: PredictionBetBody, session: dict = Depends(require_csrf)):
    if not rate_limiter.allow(f"pred_bet:{session['id']}", limit=20, window_seconds=60):
        raise HTTPException(status_code=429, detail="요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.")

    with transaction() as conn:
        _auto_lock_expired_predictions(conn)
        pred = conn.execute("SELECT * FROM predictions WHERE id = ?", (pred_id,)).fetchone()
        if not pred:
            raise HTTPException(status_code=404, detail="승부예측을 찾을 수 없습니다.")
        if pred["status"] != "open":
            raise HTTPException(status_code=400, detail="마감되었거나 종료된 승부예측입니다.")

        opts = _parse_prediction_options(dict(pred))
        try:
            idx = int(body.choice)
        except ValueError:
            raise HTTPException(status_code=400, detail="올바르지 않은 선택지입니다.")
        if idx < 0 or idx >= len(opts):
            raise HTTPException(status_code=400, detail="존재하지 않는 선택지입니다.")

        try:
            _, new_balance = apply_point_delta(
                conn,
                session["id"],
                -int(body.amount),
                f"승부예측 참여 ({pred['title']} - {opts[idx]})",
                "prediction",
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        conn.execute(
            """
            INSERT INTO prediction_bets (prediction_id, user_id, choice, amount, payout, created_at)
            VALUES (?, ?, ?, ?, 0, ?)
            """,
            (pred_id, session["id"], str(idx), int(body.amount), utc_now_iso()),
        )
        return {"balance": new_balance}


@app.post("/api/predictions/{pred_id}/lock")
def lock_prediction(pred_id: int, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        pred = conn.execute("SELECT status FROM predictions WHERE id = ?", (pred_id,)).fetchone()
        if not pred:
            raise HTTPException(status_code=404, detail="승부예측을 찾을 수 없습니다.")
        if pred["status"] != "open":
            raise HTTPException(status_code=400, detail="진행 중인 승부예측만 마감할 수 있습니다.")
        conn.execute("UPDATE predictions SET status = 'locked' WHERE id = ?", (pred_id,))
    return {"ok": True}


@app.post("/api/predictions/{pred_id}/settle")
def settle_prediction(pred_id: int, body: PredictionSettleBody, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        pred = conn.execute("SELECT * FROM predictions WHERE id = ?", (pred_id,)).fetchone()
        if not pred:
            raise HTTPException(status_code=404, detail="승부예측을 찾을 수 없습니다.")
        if pred["status"] not in ("open", "locked"):
            raise HTTPException(status_code=400, detail="이미 정산되었거나 취소된 승부예측입니다.")

        opts = _parse_prediction_options(dict(pred))
        try:
            win_idx = int(body.winner)
        except ValueError:
            raise HTTPException(status_code=400, detail="올바르지 않은 승리 항목입니다.")
        if win_idx < 0 or win_idx >= len(opts):
            raise HTTPException(status_code=400, detail="존재하지 않는 승리 항목입니다.")
        winner_key = str(win_idx)

        bets = conn.execute("SELECT * FROM prediction_bets WHERE prediction_id = ?", (pred_id,)).fetchall()
        total_pool = sum(int(b["amount"]) for b in bets)
        win_pool = sum(int(b["amount"]) for b in bets if str(b["choice"]) == winner_key)

        if win_pool == 0:
            for b in bets:
                amt = int(b["amount"])
                conn.execute("UPDATE prediction_bets SET payout = ? WHERE id = ?", (amt, b["id"]))
                apply_point_delta(
                    conn,
                    b["user_id"],
                    amt,
                    f"승부예측 적중자 없음 환불 ({pred['title']})",
                    "prediction",
                    idempotency_key=f"pred_refund:{pred_id}:{b['id']}",
                )
        else:
            for b in bets:
                if str(b["choice"]) == winner_key:
                    payout = int((int(b["amount"]) * total_pool) / win_pool)
                    conn.execute("UPDATE prediction_bets SET payout = ? WHERE id = ?", (payout, b["id"]))
                    apply_point_delta(
                        conn,
                        b["user_id"],
                        payout,
                        f"승부예측 적중 배당 ({pred['title']} - {opts[win_idx]})",
                        "prediction",
                        idempotency_key=f"pred_win:{pred_id}:{b['id']}",
                    )

        conn.execute(
            "UPDATE predictions SET status = 'settled', winner = ?, settled_at = ? WHERE id = ?",
            (winner_key, utc_now_iso(), pred_id),
        )
    return {"ok": True}


@app.post("/api/predictions/{pred_id}/cancel")
def cancel_prediction(pred_id: int, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        pred = conn.execute("SELECT * FROM predictions WHERE id = ?", (pred_id,)).fetchone()
        if not pred:
            raise HTTPException(status_code=404, detail="승부예측을 찾을 수 없습니다.")
        if pred["status"] not in ("open", "locked"):
            raise HTTPException(status_code=400, detail="이미 종료된 승부예측입니다.")
        bets = conn.execute("SELECT * FROM prediction_bets WHERE prediction_id = ?", (pred_id,)).fetchall()
        for b in bets:
            amt = int(b["amount"])
            conn.execute("UPDATE prediction_bets SET payout = ? WHERE id = ?", (amt, b["id"]))
            apply_point_delta(
                conn,
                b["user_id"],
                amt,
                f"승부예측 취소 환불 ({pred['title']})",
                "prediction",
                idempotency_key=f"pred_cancel:{pred_id}:{b['id']}",
            )
        conn.execute("UPDATE predictions SET status = 'cancelled', settled_at = ? WHERE id = ?", (utc_now_iso(), pred_id))
    return {"ok": True}


@app.delete("/api/predictions/{pred_id}")
def delete_prediction(pred_id: int, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        pred = conn.execute("SELECT * FROM predictions WHERE id = ?", (pred_id,)).fetchone()
        if not pred:
            raise HTTPException(status_code=404, detail="승부예측을 찾을 수 없습니다.")
        if pred["status"] in ("open", "locked"):
            bets = conn.execute("SELECT * FROM prediction_bets WHERE prediction_id = ?", (pred_id,)).fetchall()
            for b in bets:
                apply_point_delta(
                    conn,
                    b["user_id"],
                    int(b["amount"]),
                    f"승부예측 삭제 환불 ({pred['title']})",
                    "prediction",
                    idempotency_key=f"pred_del:{pred_id}:{b['id']}",
                )
        conn.execute("DELETE FROM predictions WHERE id = ?", (pred_id,))
    return {"ok": True}


GIFT_EMOTICON_PACKS = []


@app.get("/api/gifts/options")
def get_gift_options():
    conn = get_connection()
    try:
        items = conn.execute("SELECT id, name, description, cost, stock FROM shop_items WHERE is_active = 1 AND stock > 0 ORDER BY cost ASC").fetchall()
        return {
            "emoticons": GIFT_EMOTICON_PACKS,
            "items": [dict(i) for i in items],
        }
    finally:
        conn.close()


@app.get("/api/gifts/me")
def get_my_gifts(session: dict = Depends(require_user)):
    conn = get_connection()
    try:
        received = conn.execute(
            """
            SELECT g.*, u.nickname AS sender_nickname, u.username AS sender_username
            FROM gifts g
            JOIN users u ON u.id = g.sender_id
            WHERE g.recipient_id = ?
            ORDER BY g.id DESC LIMIT 30
            """,
            (session["id"],),
        ).fetchall()
        sent = conn.execute(
            """
            SELECT g.*, u.nickname AS recipient_nickname, u.username AS recipient_username
            FROM gifts g
            JOIN users u ON u.id = g.recipient_id
            WHERE g.sender_id = ?
            ORDER BY g.id DESC LIMIT 30
            """,
            (session["id"],),
        ).fetchall()
        return {"received": [dict(r) for r in received], "sent": [dict(s) for s in sent]}
    finally:
        conn.close()


@app.post("/api/gifts/send")
def send_gift(body: GiftSendBody, session: dict = Depends(require_csrf)):
    if not rate_limiter.allow(f"gift:{session['id']}", limit=15, window_seconds=120):
        raise HTTPException(status_code=429, detail="선물 요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.")

    target_key = body.recipient.strip()
    msg = clean_text(body.message, 120)

    with transaction() as conn:
        recipient = conn.execute(
            "SELECT id, username, nickname, is_blacklisted FROM users WHERE username = ? OR nickname = ?",
            (target_key, target_key),
        ).fetchone()
        if not recipient:
            raise HTTPException(status_code=404, detail="받는 회원을 찾을 수 없습니다. (아이디 또는 닉네임 확인)")
        if recipient["id"] == session["id"]:
            raise HTTPException(status_code=400, detail="자기 자신에게는 선물할 수 없습니다.")
        if recipient["is_blacklisted"]:
            raise HTTPException(status_code=400, detail="영구정지된 회원에게는 선물할 수 없습니다.")

        now = utc_now_iso()
        if body.gift_type == "point":
            if not body.amount or body.amount < 10:
                raise HTTPException(status_code=400, detail="포인트 선물은 최소 10P 이상부터 가능합니다.")
            cost = int(body.amount)
            title = f"{cost:,}P 포인트 선물"
            try:
                _, new_balance = apply_point_delta(
                    conn,
                    session["id"],
                    -cost,
                    f"포인트 선물 발송 (→ {recipient['nickname']})",
                    "gift",
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            apply_point_delta(
                conn,
                recipient["id"],
                cost,
                f"포인트 선물 수신 ({session['nickname']}님으로부터)",
                "gift",
            )
        elif body.gift_type == "item":
            if not body.item_id:
                raise HTTPException(status_code=400, detail="선물할 아이템을 선택해 주세요.")
            item = conn.execute(
                "SELECT * FROM shop_items WHERE id = ? AND is_active = 1",
                (body.item_id,),
            ).fetchone()
            if not item or item["stock"] <= 0:
                raise HTTPException(status_code=404, detail="선택한 아이템의 재고가 없거나 존재하지 않습니다.")
            cost = int(item["cost"])
            title = f"아이템 선물: {item['name']}"
            try:
                _, new_balance = apply_point_delta(
                    conn,
                    session["id"],
                    -cost,
                    f"아이템 선물 ({item['name']} → {recipient['nickname']})",
                    "gift",
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            conn.execute("UPDATE shop_items SET stock = stock - 1 WHERE id = ?", (item["id"],))
            conn.execute(
                """
                INSERT INTO redemptions (user_id, item_id, item_name, cost, note, status, created_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?)
                """,
                (recipient["id"], item["id"], item["name"], cost, f"[{session['nickname']}님 선물] {msg}", now),
            )
        elif body.gift_type == "voucher":
            if body.voucher_value not in (1000, 5000, 10000):
                raise HTTPException(status_code=400, detail="유효한 선물권 금액(1000/5000/10000)을 선택하세요.")
            qty = int(body.quantity or 1)
            owned_rows = conn.execute(
                """
                SELECT id FROM gift_vouchers
                WHERE owner_id = ? AND point_value = ? AND status = 'owned'
                ORDER BY id ASC LIMIT ?
                """,
                (session["id"], body.voucher_value, qty),
            ).fetchall()
            if len(owned_rows) < qty:
                raise HTTPException(
                    status_code=400,
                    detail=f"보유한 +{body.voucher_value:,}P 선물권이 부족합니다. (보유: {len(owned_rows)}장)",
                )
            for vr in owned_rows:
                conn.execute(
                    "UPDATE gift_vouchers SET owner_id = ?, received_from = ? WHERE id = ?",
                    (recipient["id"], session["id"], vr["id"]),
                )
            cost = 0
            title = f"+{body.voucher_value:,}P 선물권 x{qty}장"
            new_balance = session["points"]
        else:  # emoticon
            pack = next((e for e in GIFT_EMOTICON_PACKS if e["id"] == body.emoticon_id), None)
            if not pack:
                raise HTTPException(status_code=400, detail="선물할 이모티콘을 선택해 주세요.")
            cost = int(pack["cost"])
            title = pack["name"]
            try:
                _, new_balance = apply_point_delta(
                    conn,
                    session["id"],
                    -cost,
                    f"이모티콘 선물 ({pack['name']} → {recipient['nickname']})",
                    "gift",
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        conn.execute(
            """
            INSERT INTO gifts (sender_id, recipient_id, gift_type, title, cost, message, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (session["id"], recipient["id"], body.gift_type, title, cost, msg, now),
        )
        return {"balance": new_balance, "title": title, "recipient": recipient["nickname"]}


@app.get("/api/vouchers/me")
def get_my_vouchers(session: dict = Depends(require_user)):
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT v.id, v.point_value, v.created_at,
                   u_from.nickname AS from_nickname
            FROM gift_vouchers v
            LEFT JOIN users u_from ON u_from.id = COALESCE(v.received_from, v.issued_by)
            WHERE v.owner_id = ? AND v.status = 'owned'
            ORDER BY v.point_value ASC, v.id ASC
            """,
            (session["id"],),
        ).fetchall()
        counts = {"1000": 0, "5000": 0, "10000": 0}
        vouchers = []
        for r in rows:
            d = dict(r)
            counts[str(d["point_value"])] = counts.get(str(d["point_value"]), 0) + 1
            vouchers.append(d)
        return {"counts": counts, "vouchers": vouchers}
    finally:
        conn.close()


@app.post("/api/vouchers/open")
def open_voucher(body: OpenVoucherBody, session: dict = Depends(require_csrf)):
    now = utc_now_iso()
    with transaction() as conn:
        row = conn.execute(
            """
            SELECT id, point_value FROM gift_vouchers
            WHERE owner_id = ? AND point_value = ? AND status = 'owned'
            ORDER BY id ASC LIMIT 1
            """,
            (session["id"], body.point_value),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"보유한 +{body.point_value:,}P 선물권이 없습니다.")
        cur = conn.execute(
            "UPDATE gift_vouchers SET status = 'opened', opened_by = ?, opened_at = ? WHERE id = ? AND status = 'owned'",
            (session["id"], now, row["id"]),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=409, detail="이미 사용된 선물권입니다.")
        _, new_balance = apply_point_delta(
            conn,
            session["id"],
            int(row["point_value"]),
            f"포인트 선물권 열기 (+{int(row['point_value']):,}P)",
            "voucher",
            idempotency_key=f"voucher_open:{row['id']}",
        )
        return {"ok": True, "awarded": int(row["point_value"]), "balance": new_balance}


@app.post("/api/admin/vouchers/grant")
def admin_grant_vouchers(body: AdminGrantVoucherBody, admin: dict = Depends(require_admin)):
    target_key = body.recipient.strip()
    msg = clean_text(body.message, 120)
    now = utc_now_iso()
    with transaction() as conn:
        recipient = conn.execute(
            "SELECT id, username, nickname, is_blacklisted FROM users WHERE username = ? OR nickname = ?",
            (target_key, target_key),
        ).fetchone()
        if not recipient:
            raise HTTPException(status_code=404, detail="받는 회원을 찾을 수 없습니다.")
        if recipient["is_blacklisted"]:
            raise HTTPException(status_code=400, detail="영구정지된 회원에게는 지급할 수 없습니다.")
        for _ in range(body.quantity):
            conn.execute(
                """
                INSERT INTO gift_vouchers (owner_id, point_value, status, issued_by, created_at)
                VALUES (?, ?, 'owned', ?, ?)
                """,
                (recipient["id"], body.point_value, admin["id"], now),
            )
        title = f"+{body.point_value:,}P 선물권 x{body.quantity}장 (관리자 지급)"
        conn.execute(
            """
            INSERT INTO gifts (sender_id, recipient_id, gift_type, title, cost, message, created_at)
            VALUES (?, ?, 'voucher', ?, 0, ?, ?)
            """,
            (admin["id"], recipient["id"], title, msg, now),
        )
        return {
            "ok": True,
            "recipient": recipient["nickname"],
            "point_value": body.point_value,
            "quantity": body.quantity,
        }


@app.get("/api/shop/items")
def list_shop_items():
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM shop_items WHERE is_active = 1 ORDER BY cost ASC").fetchall()
        return {"items": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.post("/api/shop/items")
def create_shop_item(body: ShopItemBody, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        cur = conn.execute(
            """
            INSERT INTO shop_items (name, description, cost, stock, is_active)
            VALUES (?, ?, ?, ?, 1)
            """,
            (clean_text(body.name, 60), clean_text(body.description, 200), body.cost, body.stock),
        )
        return {"id": cur.lastrowid}


@app.put("/api/shop/items/{item_id}")
def update_shop_item(item_id: int, body: ShopItemBody, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        row = conn.execute("SELECT id FROM shop_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="상품을 찾을 수 없습니다.")
        conn.execute(
            """
            UPDATE shop_items
            SET name = ?, description = ?, cost = ?, stock = ?
            WHERE id = ?
            """,
            (clean_text(body.name, 60), clean_text(body.description, 200), body.cost, body.stock, item_id),
        )
    return {"ok": True}


@app.delete("/api/shop/items/{item_id}")
def delete_shop_item(item_id: int, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        conn.execute("UPDATE shop_items SET is_active = 0 WHERE id = ?", (item_id,))
    return {"ok": True}


@app.post("/api/shop/redeem")
def redeem_shop_item(body: RedeemBody, session: dict = Depends(require_csrf)):
    if not rate_limiter.allow(f"redeem:{session['id']}", limit=10, window_seconds=60):
        raise HTTPException(status_code=429, detail="요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.")

    note = clean_text(body.note, 150)
    with transaction() as conn:
        item = conn.execute(
            "SELECT * FROM shop_items WHERE id = ? AND is_active = 1",
            (body.item_id,),
        ).fetchone()
        if not item:
            raise HTTPException(status_code=404, detail="상품을 찾을 수 없습니다.")
        if item["stock"] <= 0:
            raise HTTPException(status_code=409, detail="재고가 모두 소진되었습니다.")

        try:
            _, new_balance = apply_point_delta(
                conn,
                session["id"],
                -int(item["cost"]),
                f"포인트 상점 교환: {item['name']}",
                "shop",
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        is_double_item = ("두배" in item["name"]) or ("2배" in item["name"])
        double_until_iso = None
        redemption_status = "approved"
        if is_double_item:
            now_utc = datetime.now(timezone.utc)
            base_dt = now_utc
            u_row = conn.execute("SELECT double_points_until FROM users WHERE id = ?", (session["id"],)).fetchone()
            if u_row and u_row["double_points_until"]:
                try:
                    prev_dt = datetime.fromisoformat(u_row["double_points_until"])
                    if prev_dt.tzinfo is None:
                        prev_dt = prev_dt.replace(tzinfo=timezone.utc)
                    if prev_dt > now_utc:
                        base_dt = prev_dt
                except Exception:
                    pass
            double_until_iso = (base_dt + timedelta(days=7)).isoformat()
            conn.execute("UPDATE users SET double_points_until = ? WHERE id = ?", (double_until_iso, session["id"]))
            redemption_status = "approved"
            if not note:
                note = "7일간 포인트 2배 부스터 자동 적용"

        conn.execute("UPDATE shop_items SET stock = stock - 1 WHERE id = ?", (item["id"],))
        conn.execute(
            """
            INSERT INTO redemptions (user_id, item_id, item_name, cost, note, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (session["id"], item["id"], item["name"], item["cost"], note, redemption_status, utc_now_iso()),
        )
        return {"balance": new_balance, "item_name": item["name"], "double_points_until": double_until_iso}


@app.get("/api/redemptions/me")
def my_redemptions(session: dict = Depends(require_user)):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM redemptions WHERE user_id = ? ORDER BY id DESC LIMIT 30",
            (session["id"],),
        ).fetchall()
        return {"redemptions": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.post("/api/admin/points/adjust")
def admin_adjust_points(body: AdminPointAdjustBody, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        target = conn.execute(
            "SELECT id, username, nickname FROM users WHERE username = ?",
            (body.username.strip(),),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="해당 아이디의 회원을 찾을 수 없습니다.")
        try:
            _, new_balance = apply_point_delta(
                conn,
                target["id"],
                body.delta,
                f"[관리자] {clean_text(body.reason, 120)}",
                "admin",
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return {"username": target["username"], "new_balance": new_balance}


@app.get("/api/admin/redemptions")
def admin_list_redemptions(admin: dict = Depends(require_admin)):
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT r.*, u.username, u.nickname
            FROM redemptions r
            JOIN users u ON u.id = r.user_id
            ORDER BY r.id DESC
            LIMIT 50
            """
        ).fetchall()
        return {"redemptions": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.patch("/api/admin/redemptions/{redemption_id}")
def admin_update_redemption(
    redemption_id: int,
    body: AdminRedemptionStatusBody,
    admin: dict = Depends(require_admin),
):
    with transaction() as conn:
        red = conn.execute("SELECT * FROM redemptions WHERE id = ?", (redemption_id,)).fetchone()
        if not red:
            raise HTTPException(status_code=404, detail="교환 내역을 찾을 수 없습니다.")
        if red["status"] != "pending":
            raise HTTPException(status_code=400, detail="이미 처리된 내역입니다.")

        conn.execute("UPDATE redemptions SET status = ? WHERE id = ?", (body.status, redemption_id))
        if body.status == "rejected":
            apply_point_delta(
                conn,
                red["user_id"],
                int(red["cost"]),
                f"상점 교환 반려 환불: {red['item_name']}",
                "admin",
                idempotency_key=f"refund:{redemption_id}",
            )
        return {"ok": True}


def _has_broadcaster_power(user: dict) -> bool:
    return user.get("role") == "admin" or user.get("username") == "1234gung"


class UserBanBody(BaseModel):
    mode: Literal["temp", "black", "unban"]
    days: int = Field(default=7, ge=1, le=3650)
    hours: int | None = Field(default=None, ge=1, le=87600)
    reason: str = Field(default="", max_length=120)


@app.get("/api/admin/users")
def admin_list_users(admin: dict = Depends(require_admin)):
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT id, username, nickname, role, points, soop_id, soop_verified, soop_pending_id,
                   ban_until, is_blacklisted, ban_reason, double_points_until
            FROM users ORDER BY id ASC
            """
        ).fetchall()
        return {"users": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.get("/api/admin/soop-lookup")
def admin_soop_lookup(q: str = "", admin: dict = Depends(require_admin)):
    kw = (q or "").strip()
    conn = get_connection()
    try:
        if kw:
            like = f"%{kw}%"
            rows = conn.execute(
                """
                SELECT id, username, nickname, role, points, soop_id, soop_verified, soop_pending_id,
                       ban_until, is_blacklisted, ban_reason
                FROM users
                WHERE username LIKE ? OR nickname LIKE ? OR COALESCE(soop_id, '') LIKE ? OR COALESCE(soop_pending_id, '') LIKE ?
                ORDER BY soop_verified DESC, id ASC
                LIMIT 200
                """,
                (like, like, like, like),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, username, nickname, role, points, soop_id, soop_verified, soop_pending_id,
                       ban_until, is_blacklisted, ban_reason
                FROM users
                ORDER BY soop_verified DESC, id ASC
                LIMIT 200
                """
            ).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            sid = d.get("soop_id") or ""
            d["soop_station_url"] = f"https://www.sooplive.com/station/{sid}" if sid else ""
            results.append(d)
        return {"users": results}
    finally:
        conn.close()


@app.post("/api/admin/users/{user_id}/ban")
def admin_ban_user(user_id: int, body: UserBanBody, admin: dict = Depends(require_admin)):
    with transaction() as conn:
        target = conn.execute("SELECT id, role, username FROM users WHERE id = ?", (user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="회원을 찾을 수 없습니다.")
        if target["role"] == "admin" or target["username"] == "1234gung":
            raise HTTPException(status_code=400, detail="방송인(최고관리자) 또는 제작자 계정은 정지할 수 없습니다.")
        if target["role"] == "staff" and not _has_broadcaster_power(admin):
            raise HTTPException(status_code=403, detail="다른 관리자는 방송인만 정지할 수 있습니다.")

        reason = clean_text(body.reason, 120) or "관리자 조치"
        if body.mode == "temp":
            delta = timedelta(hours=body.hours) if body.hours else timedelta(days=body.days)
            until_iso = (datetime.now(timezone.utc) + delta).isoformat()
            conn.execute(
                "UPDATE users SET ban_until = ?, is_blacklisted = 0, ban_reason = ? WHERE id = ?",
                (until_iso, reason, user_id),
            )
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        elif body.mode == "black":
            conn.execute(
                "UPDATE users SET ban_until = NULL, is_blacklisted = 1, ban_reason = ? WHERE id = ?",
                (reason, user_id),
            )
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        else:
            conn.execute(
                "UPDATE users SET ban_until = NULL, is_blacklisted = 0, ban_reason = '' WHERE id = ?",
                (user_id,),
            )
    return {"ok": True, "ban_until": None, "is_blacklisted": False}


@app.patch("/api/admin/users/{user_id}/role")
def admin_update_user_role(user_id: int, body: RoleUpdateBody, admin: dict = Depends(require_admin)):
    if not _has_broadcaster_power(admin):
        raise HTTPException(status_code=403, detail="매니저 임명/해제는 방송인(최고관리자)만 가능합니다.")
    with transaction() as conn:
        target = conn.execute("SELECT id, role, username FROM users WHERE id = ?", (user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="회원을 찾을 수 없습니다.")
        if target["username"] == "1234gung":
            raise HTTPException(status_code=400, detail="제작자(1234gung) 계정의 권한은 변경할 수 없습니다.")
        if target["role"] == "admin" and admin["username"] != "1234gung":
            raise HTTPException(status_code=400, detail="방송인(최고관리자) 권한은 변경할 수 없습니다.")
        conn.execute("UPDATE users SET role = ? WHERE id = ?", (body.role, user_id))
    return {"ok": True}


class RoleByNameBody(BaseModel):
    target: str = Field(min_length=1, max_length=32)
    role: Literal["user", "staff", "admin"]


@app.post("/api/admin/users/role-by-name")
def admin_update_role_by_name(body: RoleByNameBody, admin: dict = Depends(require_admin)):
    if not _has_broadcaster_power(admin):
        raise HTTPException(status_code=403, detail="권한 임명/변경은 방송인(최고관리자)만 가능합니다.")
    key = body.target.strip()
    with transaction() as conn:
        target = conn.execute(
            "SELECT id, username, nickname, role, is_blacklisted FROM users WHERE username = ? OR nickname = ?",
            (key, key),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="해당 아이디 또는 닉네임의 회원을 찾을 수 없습니다.")
        if target["username"] == "1234gung":
            raise HTTPException(status_code=400, detail="제작자(1234gung) 계정의 권한은 변경할 수 없습니다.")
        if target["id"] == admin["id"]:
            raise HTTPException(status_code=400, detail="본인 계정의 권한은 여기서 변경할 수 없습니다.")
        if target["role"] == "admin" and admin["username"] != "1234gung":
            raise HTTPException(status_code=400, detail="방송인(최고관리자) 권한은 변경할 수 없습니다.")
        if body.role == "admin":
            if target["is_blacklisted"]:
                raise HTTPException(status_code=400, detail="영구정지된 회원은 방송인으로 승격할 수 없습니다.")
            conn.execute("UPDATE users SET role = 'admin' WHERE id = ?", (target["id"],))
        else:
            conn.execute("UPDATE users SET role = ? WHERE id = ?", (body.role, target["id"]))
        return {"ok": True, "nickname": target["nickname"], "role": body.role}


@app.post("/api/admin/users/{user_id}/transfer-owner")
def admin_transfer_owner(user_id: int, admin: dict = Depends(require_admin)):
    if not _has_broadcaster_power(admin):
        raise HTTPException(status_code=403, detail="방송인 승격은 최고관리자만 가능합니다.")
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="이미 본인 계정입니다.")
    with transaction() as conn:
        target = conn.execute(
            "SELECT id, nickname, is_blacklisted FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="회원을 찾을 수 없습니다.")
        if target["is_blacklisted"]:
            raise HTTPException(status_code=400, detail="영구정지된 회원은 방송인으로 승격할 수 없습니다.")
        conn.execute("UPDATE users SET role = 'admin' WHERE id = ?", (user_id,))
    return {"ok": True, "new_owner": target["nickname"]}


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: int, admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="본인 계정은 삭제할 수 없습니다.")
    with transaction() as conn:
        target = conn.execute(
            "SELECT id, username, nickname, role, soop_id FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="회원을 찾을 수 없습니다.")
        if target["role"] == "admin" or target["username"] == "1234gung":
            raise HTTPException(status_code=403, detail="방송인 또는 제작자 계정은 삭제할 수 없습니다.")
        if not _has_broadcaster_power(admin) and target["role"] != "user":
            raise HTTPException(status_code=403, detail="일반팬 계정만 삭제할 수 있습니다.")

        # Delete all records tied to this user across the DB
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM post_likes WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM post_likes WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)", (user_id,))
        conn.execute("DELETE FROM comments WHERE author_id = ?", (user_id,))
        conn.execute("DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)", (user_id,))
        conn.execute("DELETE FROM posts WHERE author_id = ?", (user_id,))
        conn.execute("DELETE FROM point_ledger WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM redemptions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM prediction_bets WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM prediction_bets WHERE prediction_id IN (SELECT id FROM predictions WHERE created_by = ?)", (user_id,))
        conn.execute("DELETE FROM predictions WHERE created_by = ?", (user_id,))
        conn.execute("DELETE FROM gifts WHERE sender_id = ? OR recipient_id = ?", (user_id, user_id))
        conn.execute("DELETE FROM gift_vouchers WHERE owner_id = ?", (user_id,))
        conn.execute("UPDATE gift_vouchers SET issued_by = NULL WHERE issued_by = ?", (user_id,))
        conn.execute("UPDATE gift_vouchers SET received_from = NULL WHERE received_from = ?", (user_id,))
        conn.execute("UPDATE gift_vouchers SET opened_by = NULL WHERE opened_by = ?", (user_id,))
        conn.execute("UPDATE emoticons SET created_by = NULL WHERE created_by = ?", (user_id,))
        if target["soop_id"]:
            conn.execute("DELETE FROM soop_chat_tracker WHERE soop_id = ?", (target["soop_id"],))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return {"ok": True, "deleted_username": target["username"]}


# ---------------------------------------------------------------------------
# Static Frontend
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/uploads/{filename}")
def serve_uploaded_file(filename: str):
    if not re.fullmatch(r"[a-f0-9]{32}\.[a-z0-9]{2,5}", filename):
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    disk_path = UPLOAD_DIR / filename
    if disk_path.is_file():
        return FileResponse(str(disk_path), headers={"Cache-Control": "public, max-age=31536000"})
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT content_type, data FROM uploaded_files WHERE filename = ?",
            (filename,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
        return Response(
            content=bytes(row["data"]),
            media_type=row["content_type"],
            headers={"Cache-Control": "public, max-age=31536000"},
        )
    finally:
        conn.close()


@app.get("/api/emoticons")
def list_emoticons():
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT id, name, glyph, image_url, created_at FROM emoticons ORDER BY id ASC"
        ).fetchall()
        return {"emoticons": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.post("/api/emoticons", status_code=201)
def create_emoticon(body: EmoticonCreateBody, staff: dict = Depends(require_admin)):
    name = clean_text(body.name, 40)
    glyph = clean_text(body.glyph, 16)
    image_url = (body.image_url or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="이모티콘 이름을 입력하세요.")
    if image_url and not (image_url.startswith("/uploads/") or image_url.startswith("https://") or image_url.startswith("http://")):
        raise HTTPException(status_code=400, detail="유효하지 않은 이미지 경로입니다.")
    if not glyph and not image_url:
        raise HTTPException(status_code=400, detail="이모티콘 이미지 또는 이모지 문자를 입력하세요.")
    now = utc_now_iso()
    with transaction() as conn:
        cur = conn.execute(
            "INSERT INTO emoticons (name, glyph, image_url, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
            (name, glyph, image_url, staff["id"], now),
        )
        row = conn.execute(
            "SELECT id, name, glyph, image_url, created_at FROM emoticons WHERE id = ?",
            (cur.lastrowid,),
        ).fetchone()
    return {"emoticon": dict(row)}


@app.delete("/api/emoticons/{emoticon_id}")
def delete_emoticon(emoticon_id: int, staff: dict = Depends(require_admin)):
    with transaction() as conn:
        cur = conn.execute("DELETE FROM emoticons WHERE id = ?", (emoticon_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="이모티콘을 찾을 수 없습니다.")
    return {"ok": True}


@app.get("/")
@app.get("/notice")
@app.get("/board")
@app.get("/signatures")
@app.get("/emoticons")
@app.get("/calendar")
@app.get("/points")
@app.get("/gift")
@app.get("/admin")
def serve_index():
    return FileResponse(str(STATIC_DIR / "index.html"))
