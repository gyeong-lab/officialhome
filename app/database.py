import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Generator

from app.config import DATABASE_URL, DB_PATH
from app.security import hash_password

_TABLES_WITH_ID = {
    "users",
    "posts",
    "comments",
    "signatures",
    "calendar_events",
    "point_ledger",
    "shop_items",
    "redemptions",
    "predictions",
    "prediction_bets",
    "gifts",
    "gift_vouchers",
    "emoticons",
    "suika_runs",
    "omok_runs",
    "omok_rooms",
}

_INSERT_TABLE_RE = re.compile(r"^\s*INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)\b", re.IGNORECASE)


def _is_postgres() -> bool:
    return bool(DATABASE_URL)


def _qmark_to_percent(sql: str) -> str:
    """Convert SQLite `?` placeholders outside single-quoted literals to psycopg `%s`."""
    out: list[str] = []
    in_quote = False
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":
            out.append(ch)
            if in_quote and i + 1 < n and sql[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            in_quote = not in_quote
        elif ch == "?" and not in_quote:
            out.append("%s")
        elif ch == "%" :
            out.append("%%")
        else:
            out.append(ch)
        i += 1
    return "".join(out)


class _PgCursorWrapper:
    def __init__(self, cur: Any, lastrowid: int | None = None) -> None:
        self._cur = cur
        self.lastrowid = lastrowid

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount

    def fetchone(self) -> Any:
        return self._cur.fetchone()

    def fetchall(self) -> list[Any]:
        return self._cur.fetchall()


class _PgConnectionWrapper:
    def __init__(self, conn: Any) -> None:
        self._conn = conn

    def execute(self, sql: str, params: tuple | list = ()) -> _PgCursorWrapper:
        stripped = sql.strip()
        upper = stripped.upper()
        if upper.startswith("PRAGMA") or upper == "BEGIN IMMEDIATE":
            return _PgCursorWrapper(None)

        pg_sql = _qmark_to_percent(stripped)
        lastrowid = None
        m = _INSERT_TABLE_RE.match(pg_sql)
        if m and m.group(1).lower() in _TABLES_WITH_ID and "RETURNING" not in upper:
            pg_sql = pg_sql.rstrip(";") + " RETURNING id"
            cur = self._conn.execute(pg_sql, params or ())
            row = cur.fetchone()
            if row:
                lastrowid = row["id"]
            return _PgCursorWrapper(cur, lastrowid=lastrowid)

        cur = self._conn.execute(pg_sql, params or ())
        return _PgCursorWrapper(cur)

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def close(self) -> None:
        self._conn.close()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today_kst_str() -> str:
    # Korea Standard Time (UTC+9)
    from datetime import timedelta
    kst = datetime.now(timezone.utc) + timedelta(hours=9)
    return kst.strftime("%Y-%m-%d")


def get_connection() -> Any:
    if _is_postgres():
        import psycopg
        from psycopg.rows import dict_row

        conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
        return _PgConnectionWrapper(conn)

    conn = sqlite3.connect(str(DB_PATH), timeout=15.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def transaction() -> Generator[Any, None, None]:
    conn = get_connection()
    try:
        if not _is_postgres():
            conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


DOUBLE_POINTS_SOURCES = {"attendance", "board", "soop_chat"}


def is_double_points_active(conn: sqlite3.Connection, user_id: int) -> bool:
    row = conn.execute("SELECT double_points_until FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row or not row["double_points_until"]:
        return False
    try:
        until_dt = datetime.fromisoformat(row["double_points_until"])
        if until_dt.tzinfo is None:
            until_dt = until_dt.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) < until_dt
    except Exception:
        return False


def apply_point_delta(
    conn: sqlite3.Connection,
    user_id: int,
    delta: int,
    reason: str,
    source: str,
    idempotency_key: str | None = None,
) -> tuple[bool, int]:
    """Atomically apply a point delta within an active transaction.
    Returns (applied, new_balance). If idempotency_key already exists, returns (False, current_balance).
    """
    if idempotency_key:
        existing = conn.execute(
            "SELECT id FROM point_ledger WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
        if existing:
            row = conn.execute("SELECT points FROM users WHERE id = ?", (user_id,)).fetchone()
            return False, int(row["points"]) if row else 0

    row = conn.execute("SELECT points, double_points_until FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise ValueError("사용자를 찾을 수 없습니다.")

    effective_delta = delta
    effective_reason = reason
    if delta > 0 and source in DOUBLE_POINTS_SOURCES and row["double_points_until"]:
        try:
            until_dt = datetime.fromisoformat(row["double_points_until"])
            if until_dt.tzinfo is None:
                until_dt = until_dt.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) < until_dt:
                effective_delta = delta * 2
                effective_reason = f"{reason} (2배 부스터)"
        except Exception:
            pass

    current = int(row["points"])
    new_balance = current + effective_delta
    if new_balance < 0:
        raise ValueError("포인트가 부족합니다.")

    conn.execute("UPDATE users SET points = ? WHERE id = ?", (new_balance, user_id))
    conn.execute(
        """
        INSERT INTO point_ledger (user_id, delta, balance_after, reason, source, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (user_id, effective_delta, new_balance, effective_reason, source, idempotency_key, utc_now_iso()),
    )
    return True, new_balance


def _migrate_posts_tab_check_if_needed() -> None:
    """Recreate posts table if its CHECK constraint does not yet allow 'emoticon'."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='posts'"
        ).fetchone()
        if not row or "'emoticon'" in (row["sql"] or ""):
            return
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN IMMEDIATE")
        conn.executescript(
            """
            CREATE TABLE posts_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tab TEXT NOT NULL CHECK(tab IN ('notice', 'free', 'fanart', 'clip', 'qna', 'emoticon')),
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                is_anonymous INTEGER NOT NULL DEFAULT 0,
                is_hidden INTEGER NOT NULL DEFAULT 0,
                attachments TEXT NOT NULL DEFAULT '[]',
                views INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO posts_new (id, tab, title, content, author_id, is_pinned, is_anonymous, is_hidden, attachments, views, created_at, updated_at)
            SELECT id, tab, title, content, author_id, is_pinned, is_anonymous, is_hidden, attachments, views, created_at, updated_at FROM posts;
            DROP TABLE posts;
            ALTER TABLE posts_new RENAME TO posts;
            """
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.close()


_PG_SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'staff', 'admin')),
        points INTEGER NOT NULL DEFAULT 0 CHECK(points >= 0),
        soop_id TEXT UNIQUE,
        soop_verified INTEGER NOT NULL DEFAULT 0,
        soop_pending_id TEXT,
        soop_verify_code TEXT,
        ban_until TEXT,
        is_blacklisted INTEGER NOT NULL DEFAULT 0,
        ban_reason TEXT NOT NULL DEFAULT '',
        double_points_until TEXT,
        profile_level INTEGER NOT NULL DEFAULT 0 CHECK(profile_level >= 0 AND profile_level <= 5),
        profile_tickets INTEGER NOT NULL DEFAULT 0 CHECK(profile_tickets >= 0),
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        tab TEXT NOT NULL CHECK(tab IN ('notice', 'free', 'fanart', 'clip', 'qna', 'emoticon')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_anonymous INTEGER NOT NULL DEFAULT 0,
        is_hidden INTEGER NOT NULL DEFAULT 0,
        attachments TEXT NOT NULL DEFAULT '[]',
        views INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS post_likes (
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (post_id, user_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS signatures (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        balloon_count INTEGER NOT NULL CHECK(balloon_count > 0),
        category TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        badge TEXT NOT NULL DEFAULT '💖',
        clip_url TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS calendar_events (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        event_date TEXT NOT NULL,
        start_time TEXT NOT NULL DEFAULT '20:00',
        category TEXT NOT NULL CHECK(category IN ('live', 'event', 'collab', 'rest')),
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '#ec4899',
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS point_ledger (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS shop_items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        cost INTEGER NOT NULL CHECK(cost > 0),
        stock INTEGER NOT NULL CHECK(stock >= 0),
        is_active INTEGER NOT NULL DEFAULT 1
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS redemptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES shop_items(id),
        item_name TEXT NOT NULL,
        cost INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS soop_chat_tracker (
        soop_id TEXT PRIMARY KEY,
        last_awarded_ts DOUBLE PRECISION NOT NULL DEFAULT 0,
        daily_date TEXT NOT NULL,
        daily_points INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS stream_status (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        streamer_name TEXT NOT NULL,
        soop_channel_id TEXT NOT NULL,
        is_live INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        notice_banner TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        option_a TEXT NOT NULL DEFAULT '',
        option_b TEXT NOT NULL DEFAULT '',
        options_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'locked', 'settled', 'cancelled')),
        winner TEXT,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        settled_at TEXT,
        closes_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS prediction_bets (
        id SERIAL PRIMARY KEY,
        prediction_id INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        choice TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK(amount > 0),
        payout INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS gifts (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        gift_type TEXT NOT NULL CHECK(gift_type IN ('point', 'item', 'emoticon', 'voucher')),
        title TEXT NOT NULL,
        cost INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS gift_vouchers (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        point_value INTEGER NOT NULL CHECK(point_value IN (1000, 5000, 10000)),
        status TEXT NOT NULL DEFAULT 'owned' CHECK(status IN ('owned', 'opened')),
        issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        received_from INTEGER REFERENCES users(id) ON DELETE SET NULL,
        opened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        opened_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS emoticons (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        pack_name TEXT NOT NULL DEFAULT '체온이모티콘(1)',
        glyph TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS uploaded_files (
        filename TEXT PRIMARY KEY,
        content_type TEXT NOT NULL,
        data BYTEA NOT NULL,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS suika_runs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'challenge' CHECK(mode IN ('practice', 'challenge')),
        stake INTEGER NOT NULL DEFAULT 0 CHECK(stake >= 0),
        score INTEGER NOT NULL DEFAULT 0 CHECK(score >= 0),
        max_tier INTEGER NOT NULL DEFAULT 1 CHECK(max_tier >= 1 AND max_tier <= 11),
        merges_count INTEGER NOT NULL DEFAULT 0 CHECK(merges_count >= 0),
        duration_sec INTEGER NOT NULL DEFAULT 0 CHECK(duration_sec >= 0),
        reward INTEGER NOT NULL DEFAULT 0 CHECK(reward >= 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'finished', 'forfeited')),
        created_at TEXT NOT NULL,
        finished_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS omok_runs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        difficulty TEXT NOT NULL DEFAULT 'normal' CHECK(difficulty IN ('easy', 'normal', 'hard')),
        stake INTEGER NOT NULL DEFAULT 0 CHECK(stake >= 0),
        result TEXT NOT NULL DEFAULT 'active' CHECK(result IN ('active', 'win', 'lose', 'draw', 'forfeited')),
        moves_count INTEGER NOT NULL DEFAULT 0 CHECK(moves_count >= 0),
        duration_sec INTEGER NOT NULL DEFAULT 0 CHECK(duration_sec >= 0),
        reward INTEGER NOT NULL DEFAULT 0 CHECK(reward >= 0),
        created_at TEXT NOT NULL,
        finished_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS omok_rooms (
        id SERIAL PRIMARY KEY,
        host_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        guest_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        stake INTEGER NOT NULL CHECK(stake > 0),
        status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'playing', 'finished', 'cancelled')),
        board_json TEXT NOT NULL,
        turn INTEGER NOT NULL DEFAULT 1 CHECK(turn IN (1, 2)),
        moves_count INTEGER NOT NULL DEFAULT 0,
        last_move_json TEXT NOT NULL DEFAULT 'null',
        win_line_json TEXT NOT NULL DEFAULT 'null',
        winner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        end_reason TEXT NOT NULL DEFAULT '',
        turn_deadline TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
    )
    """,
]


def _init_pg_schema(conn: Any) -> None:
    for stmt in _PG_SCHEMA_STATEMENTS:
        conn.execute(stmt)
    conn.execute("ALTER TABLE gifts DROP CONSTRAINT IF EXISTS gifts_gift_type_check")
    conn.execute(
        "ALTER TABLE gifts ADD CONSTRAINT gifts_gift_type_check CHECK (gift_type IN ('point', 'item', 'emoticon', 'voucher'))"
    )
    conn.execute("ALTER TABLE omok_rooms DROP CONSTRAINT IF EXISTS omok_rooms_stake_check")
    conn.execute("ALTER TABLE omok_rooms ADD CONSTRAINT omok_rooms_stake_check CHECK (stake > 0)")
    conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_level INTEGER NOT NULL DEFAULT 0")
    conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_tickets INTEGER NOT NULL DEFAULT 0")
    conn.execute("ALTER TABLE emoticons ADD COLUMN IF NOT EXISTS pack_name TEXT NOT NULL DEFAULT '체온이모티콘(1)'")
    conn.execute(
        """
        INSERT INTO shop_items (name, description, cost, stock, is_active)
        SELECT '✨ 프로필 강화권', '닉네임 앞 뱃지를 최대 Lv.5까지 강화할 수 있는 강화권 1장! (강화할수록 성공 확률이 낮아집니다)', 1000, 999999, 1
        WHERE NOT EXISTS (SELECT 1 FROM shop_items WHERE name = '✨ 프로필 강화권')
        """
    )
    conn.execute(
        "UPDATE shop_items SET cost = 1000, description = '닉네임 앞 뱃지를 최대 Lv.5까지 강화할 수 있는 강화권 1장! (강화할수록 성공 확률이 낮아집니다)' WHERE name = '✨ 프로필 강화권'"
    )
    _sync_signatures_v2_if_needed(conn)


def _sync_signatures_v2_if_needed(conn: Any) -> None:
    row = conn.execute("SELECT value FROM site_settings WHERE key = 'signatures_sync_v2'").fetchone()
    if row and row["value"] == "1":
        return
    from app.chaeon_signatures import build_seed_signatures

    now = utc_now_iso()
    conn.execute("DELETE FROM signatures")
    for title, cnt, cat, desc, badge, clip_url, tags in build_seed_signatures():
        conn.execute(
            """
            INSERT INTO signatures (title, balloon_count, category, description, badge, clip_url, tags, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (title, cnt, cat, desc, badge, clip_url, tags, now),
        )
    conn.execute(
        """
        INSERT INTO site_settings (key, value, updated_at)
        VALUES ('signatures_sync_v2', '1', ?)
        ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
        """,
        (now,),
    )


def _migrate_gifts_type_check_if_needed() -> None:
    """Recreate gifts table if its CHECK constraint does not yet allow 'voucher'."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='gifts'"
        ).fetchone()
        if not row or "'voucher'" in (row["sql"] or ""):
            return
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN IMMEDIATE")
        conn.executescript(
            """
            CREATE TABLE gifts_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                gift_type TEXT NOT NULL CHECK(gift_type IN ('point', 'item', 'emoticon', 'voucher')),
                title TEXT NOT NULL,
                cost INTEGER NOT NULL DEFAULT 0,
                message TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            INSERT INTO gifts_new (id, sender_id, recipient_id, gift_type, title, cost, message, created_at)
            SELECT id, sender_id, recipient_id, gift_type, title, cost, message, created_at FROM gifts;
            DROP TABLE gifts;
            ALTER TABLE gifts_new RENAME TO gifts;
            """
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.close()


def init_db() -> None:
    if not _is_postgres():
        _migrate_posts_tab_check_if_needed()
        _migrate_gifts_type_check_if_needed()
    with transaction() as conn:
        if _is_postgres():
            _init_pg_schema(conn)
        else:
            conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                nickname TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'staff', 'admin')),
                points INTEGER NOT NULL DEFAULT 0 CHECK(points >= 0),
                soop_id TEXT UNIQUE,
                soop_verified INTEGER NOT NULL DEFAULT 0,
                soop_pending_id TEXT,
                soop_verify_code TEXT,
                ban_until TEXT,
                is_blacklisted INTEGER NOT NULL DEFAULT 0,
                ban_reason TEXT NOT NULL DEFAULT '',
                double_points_until TEXT,
                profile_level INTEGER NOT NULL DEFAULT 0 CHECK(profile_level >= 0 AND profile_level <= 5),
                profile_tickets INTEGER NOT NULL DEFAULT 0 CHECK(profile_tickets >= 0),
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                csrf_token TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tab TEXT NOT NULL CHECK(tab IN ('notice', 'free', 'fanart', 'clip', 'qna', 'emoticon')),
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                is_anonymous INTEGER NOT NULL DEFAULT 0,
                is_hidden INTEGER NOT NULL DEFAULT 0,
                attachments TEXT NOT NULL DEFAULT '[]',
                views INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS post_likes (
                post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                PRIMARY KEY (post_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS signatures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                balloon_count INTEGER NOT NULL CHECK(balloon_count > 0),
                category TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                badge TEXT NOT NULL DEFAULT '💖',
                clip_url TEXT NOT NULL DEFAULT '',
                image_url TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS calendar_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                event_date TEXT NOT NULL,
                start_time TEXT NOT NULL DEFAULT '20:00',
                category TEXT NOT NULL CHECK(category IN ('live', 'event', 'collab', 'rest')),
                description TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL DEFAULT '#ec4899',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS point_ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                delta INTEGER NOT NULL,
                balance_after INTEGER NOT NULL,
                reason TEXT NOT NULL,
                source TEXT NOT NULL,
                idempotency_key TEXT UNIQUE,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS shop_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                cost INTEGER NOT NULL CHECK(cost > 0),
                stock INTEGER NOT NULL CHECK(stock >= 0),
                is_active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS redemptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                item_id INTEGER NOT NULL REFERENCES shop_items(id),
                item_name TEXT NOT NULL,
                cost INTEGER NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS soop_chat_tracker (
                soop_id TEXT PRIMARY KEY,
                last_awarded_ts REAL NOT NULL DEFAULT 0,
                daily_date TEXT NOT NULL,
                daily_points INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS stream_status (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                streamer_name TEXT NOT NULL,
                soop_channel_id TEXT NOT NULL,
                is_live INTEGER NOT NULL DEFAULT 0,
                title TEXT NOT NULL,
                category TEXT NOT NULL,
                notice_banner TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS predictions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                option_a TEXT NOT NULL DEFAULT '',
                option_b TEXT NOT NULL DEFAULT '',
                options_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'locked', 'settled', 'cancelled')),
                winner TEXT,
                closes_at TEXT,
                created_by INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL,
                settled_at TEXT
            );

            CREATE TABLE IF NOT EXISTS prediction_bets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prediction_id INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                choice TEXT NOT NULL,
                amount INTEGER NOT NULL CHECK(amount > 0),
                payout INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS gifts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                gift_type TEXT NOT NULL CHECK(gift_type IN ('point', 'item', 'emoticon', 'voucher')),
                title TEXT NOT NULL,
                cost INTEGER NOT NULL DEFAULT 0,
                message TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS gift_vouchers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                point_value INTEGER NOT NULL CHECK(point_value IN (1000, 5000, 10000)),
                status TEXT NOT NULL DEFAULT 'owned' CHECK(status IN ('owned', 'opened')),
                issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                received_from INTEGER REFERENCES users(id) ON DELETE SET NULL,
                opened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                opened_at TEXT
            );

            CREATE TABLE IF NOT EXISTS emoticons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                pack_name TEXT NOT NULL DEFAULT '체온이모티콘(1)',
                glyph TEXT NOT NULL DEFAULT '',
                image_url TEXT NOT NULL DEFAULT '',
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS site_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS uploaded_files (
                filename TEXT PRIMARY KEY,
                content_type TEXT NOT NULL,
                data BLOB NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS suika_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                mode TEXT NOT NULL DEFAULT 'challenge' CHECK(mode IN ('practice', 'challenge')),
                stake INTEGER NOT NULL DEFAULT 0 CHECK(stake >= 0),
                score INTEGER NOT NULL DEFAULT 0 CHECK(score >= 0),
                max_tier INTEGER NOT NULL DEFAULT 1 CHECK(max_tier >= 1 AND max_tier <= 11),
                merges_count INTEGER NOT NULL DEFAULT 0 CHECK(merges_count >= 0),
                duration_sec INTEGER NOT NULL DEFAULT 0 CHECK(duration_sec >= 0),
                reward INTEGER NOT NULL DEFAULT 0 CHECK(reward >= 0),
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'finished', 'forfeited')),
                created_at TEXT NOT NULL,
                finished_at TEXT
            );

            CREATE TABLE IF NOT EXISTS omok_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                difficulty TEXT NOT NULL DEFAULT 'normal' CHECK(difficulty IN ('easy', 'normal', 'hard')),
                stake INTEGER NOT NULL DEFAULT 0 CHECK(stake >= 0),
                result TEXT NOT NULL DEFAULT 'active' CHECK(result IN ('active', 'win', 'lose', 'draw', 'forfeited')),
                moves_count INTEGER NOT NULL DEFAULT 0 CHECK(moves_count >= 0),
                duration_sec INTEGER NOT NULL DEFAULT 0 CHECK(duration_sec >= 0),
                reward INTEGER NOT NULL DEFAULT 0 CHECK(reward >= 0),
                created_at TEXT NOT NULL,
                finished_at TEXT
            );

            CREATE TABLE IF NOT EXISTS omok_rooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                guest_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                stake INTEGER NOT NULL CHECK(stake > 0),
                status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'playing', 'finished', 'cancelled')),
                board_json TEXT NOT NULL,
                turn INTEGER NOT NULL DEFAULT 1 CHECK(turn IN (1, 2)),
                moves_count INTEGER NOT NULL DEFAULT 0,
                last_move_json TEXT NOT NULL DEFAULT 'null',
                win_line_json TEXT NOT NULL DEFAULT 'null',
                winner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                end_reason TEXT NOT NULL DEFAULT '',
                turn_deadline TEXT,
                created_at TEXT NOT NULL,
                finished_at TEXT
            );
            """
        )

            # Auto-migrate existing posts table if needed
            post_cols = {row["name"] for row in conn.execute("PRAGMA table_info(posts)").fetchall()}
            if "is_anonymous" not in post_cols:
                conn.execute("ALTER TABLE posts ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0")
            if "attachments" not in post_cols:
                conn.execute("ALTER TABLE posts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
            if "is_hidden" not in post_cols:
                conn.execute("ALTER TABLE posts ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0")

            cal_cols = {row["name"] for row in conn.execute("PRAGMA table_info(calendar_events)").fetchall()}
            if "color" not in cal_cols:
                conn.execute("ALTER TABLE calendar_events ADD COLUMN color TEXT NOT NULL DEFAULT '#ec4899'")

            sig_cols = {row["name"] for row in conn.execute("PRAGMA table_info(signatures)").fetchall()}
            if "clip_url" not in sig_cols:
                conn.execute("ALTER TABLE signatures ADD COLUMN clip_url TEXT NOT NULL DEFAULT ''")
            if "image_url" not in sig_cols:
                conn.execute("ALTER TABLE signatures ADD COLUMN image_url TEXT NOT NULL DEFAULT ''")
            if "tags" not in sig_cols:
                conn.execute("ALTER TABLE signatures ADD COLUMN tags TEXT NOT NULL DEFAULT ''")

            user_cols = {row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
            if "ban_until" not in user_cols:
                conn.execute("ALTER TABLE users ADD COLUMN ban_until TEXT")
            if "is_blacklisted" not in user_cols:
                conn.execute("ALTER TABLE users ADD COLUMN is_blacklisted INTEGER NOT NULL DEFAULT 0")
            if "ban_reason" not in user_cols:
                conn.execute("ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT ''")
            if "double_points_until" not in user_cols:
                conn.execute("ALTER TABLE users ADD COLUMN double_points_until TEXT")
            if "profile_level" not in user_cols:
                conn.execute("ALTER TABLE users ADD COLUMN profile_level INTEGER NOT NULL DEFAULT 0")
            if "profile_tickets" not in user_cols:
                conn.execute("ALTER TABLE users ADD COLUMN profile_tickets INTEGER NOT NULL DEFAULT 0")

            emo_cols = {row["name"] for row in conn.execute("PRAGMA table_info(emoticons)").fetchall()}
            if "pack_name" not in emo_cols:
                conn.execute("ALTER TABLE emoticons ADD COLUMN pack_name TEXT NOT NULL DEFAULT '체온이모티콘(1)'")

            conn.execute(
                """
                INSERT INTO shop_items (name, description, cost, stock, is_active)
                SELECT '✨ 프로필 강화권', '닉네임 앞 뱃지를 최대 Lv.5까지 강화할 수 있는 강화권 1장! (강화할수록 성공 확률이 낮아집니다)', 1000, 999999, 1
                WHERE NOT EXISTS (SELECT 1 FROM shop_items WHERE name = '✨ 프로필 강화권')
                """
            )
            conn.execute(
                "UPDATE shop_items SET cost = 1000, description = '닉네임 앞 뱃지를 최대 Lv.5까지 강화할 수 있는 강화권 1장! (강화할수록 성공 확률이 낮아집니다)' WHERE name = '✨ 프로필 강화권'"
            )

            pred_cols = {row["name"] for row in conn.execute("PRAGMA table_info(predictions)").fetchall()}
            if "options_json" not in pred_cols:
                # Recreate empty prediction tables without A/B-only CHECK constraints
                cnt = conn.execute("SELECT COUNT(*) AS c FROM predictions").fetchone()["c"]
                if cnt == 0:
                    conn.execute("DROP TABLE IF EXISTS prediction_bets")
                    conn.execute("DROP TABLE IF EXISTS predictions")
                    conn.executescript(
                        """
                        CREATE TABLE predictions (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            title TEXT NOT NULL,
                            option_a TEXT NOT NULL DEFAULT '',
                            option_b TEXT NOT NULL DEFAULT '',
                            options_json TEXT NOT NULL DEFAULT '[]',
                            status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'locked', 'settled', 'cancelled')),
                            winner TEXT,
                            created_by INTEGER NOT NULL REFERENCES users(id),
                            created_at TEXT NOT NULL,
                            settled_at TEXT
                        );
                        CREATE TABLE prediction_bets (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            prediction_id INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
                            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            choice TEXT NOT NULL,
                            amount INTEGER NOT NULL CHECK(amount > 0),
                            payout INTEGER NOT NULL DEFAULT 0,
                            created_at TEXT NOT NULL
                        );
                        """
                    )
                else:
                    conn.execute("ALTER TABLE predictions ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]'")
            if "closes_at" not in pred_cols:
                conn.execute("ALTER TABLE predictions ADD COLUMN closes_at TEXT")

            _sync_signatures_v2_if_needed(conn)

            omok_sql_row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'omok_rooms'"
            ).fetchone()
            if omok_sql_row and "CHECK(stake IN (100, 300, 500))" in (omok_sql_row["sql"] or ""):
                conn.executescript(
                    """
                    CREATE TABLE omok_rooms_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        host_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        guest_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                        stake INTEGER NOT NULL CHECK(stake > 0),
                        status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'playing', 'finished', 'cancelled')),
                        board_json TEXT NOT NULL,
                        turn INTEGER NOT NULL DEFAULT 1 CHECK(turn IN (1, 2)),
                        moves_count INTEGER NOT NULL DEFAULT 0,
                        last_move_json TEXT NOT NULL DEFAULT 'null',
                        win_line_json TEXT NOT NULL DEFAULT 'null',
                        winner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                        end_reason TEXT NOT NULL DEFAULT '',
                        turn_deadline TEXT,
                        created_at TEXT NOT NULL,
                        finished_at TEXT
                    );
                    INSERT INTO omok_rooms_new SELECT * FROM omok_rooms;
                    DROP TABLE omok_rooms;
                    ALTER TABLE omok_rooms_new RENAME TO omok_rooms;
                    """
                )

        # Seed only if users table is empty
        user_count = conn.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()["cnt"]
        if user_count == 0:
            now = utc_now_iso()
            conn.execute(
                """
                INSERT INTO users (username, nickname, password_hash, role, points, soop_id, soop_verified, created_at)
                VALUES (?, ?, ?, 'staff', 5000, NULL, 0, ?)
                """,
                ("1234gung", "조정간단발이", hash_password("Admin!1234"), now),
            )
            conn.execute(
                """
                INSERT INTO users (username, nickname, password_hash, role, points, soop_id, soop_verified, created_at)
                VALUES (?, ?, ?, 'staff', 2000, 'pinkmanager', 1, ?)
                """,
                ("manager", "매니저", hash_password("Manager!1234"), now),
            )
            conn.execute(
                """
                INSERT INTO users (username, nickname, password_hash, role, points, soop_id, soop_verified, created_at)
                VALUES (?, ?, ?, 'user', 350, 'fan_test01', 1, ?)
                """,
                ("pinkfan", "핑크단1호", hash_password("Fan!1234"), now),
            )

            conn.execute(
                """
                INSERT INTO stream_status (id, streamer_name, soop_channel_id, is_live, title, category, notice_banner, updated_at)
                VALUES (1, '체온', 'leeso0403', 1, '[생방송] 오늘 밤 8시 체온 소통 & 시그니처 리액션!', '토크/캠방', 'SOOP 계정 연동 후 채팅 참여 시 포인트가 적립됩니다!', ?)
                """,
                (now,),
            )

            # Notices & Board posts
            posts_seed = [
                ("notice", "[필독] 공식 홈페이지 오픈 및 포인트 시스템 안내", "안녕하세요! 공식 홈페이지가 오픈했습니다.\n\n1. 자체 회원가입 후 마이페이지에서 SOOP 아이디를 인증 코드로 연동할 수 있습니다.\n2. 출석체크, 게시글 작성, SOOP 방송 채팅 참여로 포인트를 모을 수 있어요.\n3. 모은 포인트는 포인트 상점에서 방셀, 닉네임 호출권 등으로 교환 가능합니다!", 1, 1),
                ("notice", "11월 정기 휴방 및 합방 일정 공지", "이번 주 금요일은 합방 콘텐츠로 오후 9시에 시작합니다! 자세한 일정은 캘린더 탭을 확인해 주세요.", 1, 0),
                ("free", "홈페이지 핑크 색감 너무 예쁘네요!!", "디자인 깔끔하고 포인트 내역도 한눈에 보여서 좋아요 ㅎㅎ 오늘 방송도 본방사수!", 2, 0),
                ("fanart", "체온 SD 팬아트 그려왔어요", "다음 방송 대기화면에 써주시면 감사하겠습니다 :) 체온 파이팅!", 2, 0),
                ("clip", "어제 레전드 시그니처 리액션 모음", "33개 리액션 연속으로 터진 구간 진짜 웃겼습니다 ㅋㅋㅋㅋ", 2, 0),
                ("qna", "SOOP 계정 연동은 어떻게 하나요?", "마이페이지 -> SOOP 연동 탭에서 본인 SOOP 아이디 입력 후 발급된 인증 코드를 채팅창에 치면 바로 연동됩니다!", 2, 0),
            ]
            for tab, title, content, author_id, pinned in posts_seed:
                conn.execute(
                    """
                    INSERT INTO posts (tab, title, content, author_id, is_pinned, views, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 12, ?, ?)
                    """,
                    (tab, title, content, author_id, pinned, now, now),
                )

            # Signatures (Chaeon full signature list)
            from app.chaeon_signatures import build_seed_signatures

            for title, cnt, cat, desc, badge, clip_url, tags in build_seed_signatures():
                conn.execute(
                    """
                    INSERT INTO signatures (title, balloon_count, category, description, badge, clip_url, tags, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (title, cnt, cat, desc, badge, clip_url, tags, now),
                )

            # Calendar starts empty (managed by streamer/staff)

            # Shop starts empty (managed by streamer/staff)

            # Initial ledger record for pinkfan
            conn.execute(
                """
                INSERT INTO point_ledger (user_id, delta, balance_after, reason, source, idempotency_key, created_at)
                VALUES (3, 350, 350, '오픈 기념 환영 포인트', 'admin', 'seed_welcome_3', ?)
                """,
                (now,),
            )
        else:
            # Replace legacy 'admin' (체온(방송인)) with '1234gung' as broadcaster/owner
            legacy_admin = conn.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
            gung_user = conn.execute("SELECT id FROM users WHERE username = '1234gung'").fetchone()
            if legacy_admin:
                if not gung_user:
                    conn.execute(
                        "UPDATE users SET username = '1234gung', nickname = '조정간단발이', role = 'staff', soop_id = NULL, soop_verified = 0 WHERE id = ?",
                        (legacy_admin["id"],),
                    )
                else:
                    conn.execute("UPDATE users SET role = 'staff' WHERE id = ?", (gung_user["id"],))
                    conn.execute("UPDATE posts SET author_id = ? WHERE author_id = ?", (gung_user["id"], legacy_admin["id"]))
                    conn.execute("UPDATE predictions SET created_by = ? WHERE created_by = ?", (gung_user["id"], legacy_admin["id"]))
                    conn.execute("DELETE FROM users WHERE id = ?", (legacy_admin["id"],))
            elif gung_user:
                conn.execute("UPDATE users SET role = 'staff' WHERE id = ? AND role != 'staff'", (gung_user["id"],))

            # Ensure manager account exists for existing databases
            has_manager = conn.execute("SELECT id FROM users WHERE username = 'manager'").fetchone()
            if not has_manager:
                conn.execute(
                    """
                    INSERT INTO users (username, nickname, password_hash, role, points, soop_id, soop_verified, created_at)
                    VALUES (?, ?, ?, 'staff', 2000, 'pinkmanager', 1, ?)
                    """,
                    ("manager", "매니저", hash_password("Manager!1234"), utc_now_iso()),
                )
