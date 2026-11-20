import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict, deque
from threading import Lock

from app.config import SOOP_WEBHOOK_SECRET


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )
    return f"scrypt${salt.hex()}${derived.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        scheme, salt_hex, hash_hex = stored_hash.split("$", 2)
        if scheme != "scrypt":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=2**14,
            r=8,
            p=1,
            dklen=32,
        )
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def generate_session_tokens() -> tuple[str, str]:
    raw_session = secrets.token_urlsafe(32)
    csrf_token = secrets.token_urlsafe(24)
    return raw_session, csrf_token


def generate_soop_verify_code() -> str:
    return f"PINK-{secrets.randbelow(9000) + 1000}"


def compute_soop_signature(body: bytes) -> str:
    return hmac.new(
        SOOP_WEBHOOK_SECRET.encode("utf-8"),
        body,
        hashlib.sha256,
    ).hexdigest()


def verify_soop_signature(body: bytes, signature: str | None) -> bool:
    if not signature:
        return False
    expected = compute_soop_signature(body)
    return hmac.compare_digest(expected, signature.strip().lower())


def clean_text(value: str, max_len: int) -> str:
    # Remove null bytes and non-printable control characters except newline/tab
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value).strip()
    return cleaned[:max_len]


class SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, key: str, limit: int, window_seconds: int) -> bool:
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            bucket = self._hits[key]
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= limit:
                return False
            bucket.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


rate_limiter = SlidingWindowRateLimiter()
