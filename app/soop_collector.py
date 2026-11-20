import asyncio
import json
import re
import time
import urllib.parse
import urllib.request
from collections import deque
from typing import Callable

import websockets

SOOP_F = "\x0c"
SOOP_ESC = "\x1b\t"

collector_state = {
    "enabled": True,
    "connected": False,
    "channel_id": "leeso0403",
    "status_text": "초기화 중...",
    "messages_seen": 0,
    "points_awarded": 0,
    "recent_logs": deque(maxlen=12),
    "last_updated": 0.0,
}

_collector_task: asyncio.Task | None = None


def _make_packet(cmd: str, body: str) -> bytes:
    body_bytes = body.encode("utf-8")
    header = f"{SOOP_ESC}{cmd}{len(body_bytes):06d}00".encode("ascii")
    return header + body_bytes


def _fetch_live_chat_creds(channel_id: str) -> dict | None:
    # Check station API first so offline state is reported cleanly
    st_req = urllib.request.Request(
        f"https://chapi.sooplive.com/api/{urllib.parse.quote(channel_id)}/station",
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": f"https://www.sooplive.com/station/{channel_id}",
            "Origin": "https://www.sooplive.com",
        },
    )
    with urllib.request.urlopen(st_req, timeout=6) as st_resp:
        st_data = json.loads(st_resp.read().decode("utf-8"))
    if not isinstance(st_data.get("broad"), dict) or not st_data["broad"].get("broad_no"):
        return None

    api_url = f"https://live.sooplive.co.kr/afreeca/player_live_api.php?bjid={urllib.parse.quote(channel_id)}"
    form = urllib.parse.urlencode(
        {
            "bid": channel_id,
            "bjid": channel_id,
            "type": "live",
            "player_type": "html5",
            "stream_type": "common",
            "quality": "HD",
            "mode": "landing",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        api_url,
        data=form,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": f"https://play.sooplive.com/{channel_id}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=6) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    ch = data.get("CHANNEL") or {}
    chat_no = ch.get("CHATNO")
    ch_domain = ch.get("CHDOMAIN")
    ch_pt = ch.get("CHPT")
    if not (chat_no and ch_domain and ch_pt):
        return None
    return {
        "chat_no": str(chat_no),
        "ch_domain": str(ch_domain).lower(),
        "ch_pt": int(ch_pt),
    }


def _parse_chat_frame(raw: bytes | str) -> tuple[str, str] | None:
    text = raw.decode("utf-8", errors="ignore") if isinstance(raw, bytes) else raw
    if not text.startswith(SOOP_ESC):
        return None
    cmd = text[2:6]
    if cmd != "0005":  # Chat message opcode
        return None
    # Payload begins after 14-byte header (\x1b\t + 4 cmd + 6 len + 2 flag)
    payload = text[14:]
    parts = payload.split(SOOP_F)
    if len(parts) < 3:
        return None
    message = parts[1].strip()
    sender_raw = parts[2].strip()
    sender_id = re.sub(r"\(\d+\)$", "", sender_raw).lower()
    if not sender_id or not message:
        return None
    return sender_id, message


async def _run_collector_loop(on_chat_message: Callable[[str, str], dict]) -> None:
    while True:
        channel_id = collector_state["channel_id"]
        if not collector_state["enabled"]:
            collector_state["connected"] = False
            collector_state["status_text"] = "수집기 일시 정지됨"
            await asyncio.sleep(5)
            continue

        try:
            creds = await asyncio.to_thread(_fetch_live_chat_creds, channel_id)
        except Exception as exc:
            collector_state["connected"] = False
            collector_state["status_text"] = f"방송 상태 확인 대기 중 ({type(exc).__name__})"
            await asyncio.sleep(15)
            continue

        if not creds:
            collector_state["connected"] = False
            collector_state["status_text"] = f"방송 오프라인 ({channel_id}) — 방송 시작 시 자동 연결됩니다"
            collector_state["last_updated"] = time.time()
            await asyncio.sleep(20)
            continue

        ws_url = f"wss://{creds['ch_domain']}:{creds['ch_pt'] + 1}/Websocket/{channel_id}"
        try:
            collector_state["status_text"] = f"SOOP 채팅 서버 연결 중 ({channel_id})..."
            async with websockets.connect(ws_url, subprotocols=["chat"], ping_interval=None) as ws:
                # 1. Connect packet
                await ws.send(_make_packet("0001", f"{SOOP_F * 3}16{SOOP_F}"))
                await asyncio.sleep(0.2)
                # 2. Join chat room packet
                await ws.send(_make_packet("0002", f"{SOOP_F}{creds['chat_no']}{SOOP_F * 5}"))

                collector_state["connected"] = True
                collector_state["status_text"] = f"🟢 실시간 채팅 수집 중 ({channel_id})"
                collector_state["last_updated"] = time.time()

                last_ping = time.monotonic()
                while collector_state["enabled"]:
                    if time.monotonic() - last_ping >= 45:
                        await ws.send(_make_packet("0000", SOOP_F))
                        last_ping = time.monotonic()

                    try:
                        frame = await asyncio.wait_for(ws.recv(), timeout=15)
                    except asyncio.TimeoutError:
                        continue

                    parsed = _parse_chat_frame(frame)
                    if not parsed:
                        continue
                    sender_id, message = parsed
                    collector_state["messages_seen"] += 1
                    collector_state["last_updated"] = time.time()

                    res = await asyncio.to_thread(on_chat_message, sender_id, message)
                    if res.get("status") == "awarded":
                        collector_state["points_awarded"] += int(res.get("awarded", 0))
                        collector_state["recent_logs"].appendleft(
                            f"+{res.get('awarded')}P · {sender_id}: {message[:30]}"
                        )
                    elif res.get("status") == "verified":
                        collector_state["recent_logs"].appendleft(
                            f"✅ 인증완료 · {sender_id}"
                        )
        except Exception as exc:
            collector_state["connected"] = False
            collector_state["status_text"] = f"연결 재시도 대기 중 ({type(exc).__name__})"
            await asyncio.sleep(10)


def start_collector(on_chat_message: Callable[[str, str], dict]) -> None:
    global _collector_task
    if _collector_task is None or _collector_task.done():
        _collector_task = asyncio.create_task(_run_collector_loop(on_chat_message))


def get_collector_status() -> dict:
    return {
        "enabled": collector_state["enabled"],
        "connected": collector_state["connected"],
        "channel_id": collector_state["channel_id"],
        "status_text": collector_state["status_text"],
        "messages_seen": collector_state["messages_seen"],
        "points_awarded": collector_state["points_awarded"],
        "recent_logs": list(collector_state["recent_logs"]),
    }
