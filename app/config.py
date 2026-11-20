import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path("/tmp/chaeon_data") if os.environ.get("VERCEL") else (BASE_DIR / "data")
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = Path(os.environ.get("APP_DB_PATH", str(DATA_DIR / "site.db")))
SECRET_FILE = DATA_DIR / ".secrets"


def _load_or_create_secrets() -> tuple[str, str]:
    env_session = os.environ.get("APP_SESSION_SECRET")
    env_soop = os.environ.get("SOOP_WEBHOOK_SECRET")
    if env_session and env_soop:
        return env_session, env_soop

    if SECRET_FILE.exists():
        lines = [line.strip() for line in SECRET_FILE.read_text(encoding="utf-8").splitlines() if line.strip()]
        if len(lines) >= 2:
            return lines[0], lines[1]

    session_secret = secrets.token_hex(32)
    soop_secret = secrets.token_hex(32)
    SECRET_FILE.write_text(f"{session_secret}\n{soop_secret}\n", encoding="utf-8")
    return session_secret, soop_secret


SESSION_SECRET, SOOP_WEBHOOK_SECRET = _load_or_create_secrets()

SESSION_COOKIE_NAME = "pink_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 7  # 7 days

# Point system rules
ATTENDANCE_POINTS = 100
POST_CREATE_POINTS = 50
LIKE_RECEIVED_POINTS = 10
LIKE_MILESTONES = {5: 50, 10: 100, 30: 300}
CHAT_POINTS_PER_MSG = 5
CHAT_COOLDOWN_SECONDS = 0
CHAT_DAILY_CAP_POINTS = 500
