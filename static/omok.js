(() => {
  "use strict";

  const SIZE = 15;
  const CANVAS_SIZE = 450;
  const PAD = 24;
  const CELL = (CANVAS_SIZE - PAD * 2) / (SIZE - 1);
  const DIRS = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  const STAR_POINTS = [
    [3, 3],
    [3, 11],
    [7, 7],
    [11, 3],
    [11, 11],
  ];
  const DIFF_LABELS = { easy: "쉬움", normal: "보통", hard: "어려움" };

  const omok = {
    initialized: false,
    canvas: null,
    ctx: null,
    mode: "practice", // "practice" | "pvp"
    difficulty: "normal",
    selectedStake: 1000,
    board: [],
    turn: 1,
    running: false,
    gameOver: false,
    aiThinking: false,
    movesCount: 0,
    lastMove: null,
    hoverCell: null,
    winLine: null,
    pvpRoom: null,
    pvpSending: false,
    pollTimer: null,
    countdownTimer: null,
    apiHelper: null,
    getUser: null,
    onPointsChanged: null,
    showToast: null,
  };

  function createEmptyBoard() {
    return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  }

  function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function checkWinAt(board, r, c, player) {
    for (const [dr, dc] of DIRS) {
      const line = [[r, c]];
      for (let step = 1; step < 5; step++) {
        const nr = r + dr * step;
        const nc = c + dc * step;
        if (!inBounds(nr, nc) || board[nr][nc] !== player) break;
        line.push([nr, nc]);
      }
      for (let step = 1; step < 5; step++) {
        const nr = r - dr * step;
        const nc = c - dc * step;
        if (!inBounds(nr, nc) || board[nr][nc] !== player) break;
        line.unshift([nr, nc]);
      }
      if (line.length >= 5) return line;
    }
    return null;
  }

  function evaluateCellFor(board, r, c, player) {
    let total = 0;
    for (const [dr, dc] of DIRS) {
      let count = 1;
      let openEnds = 0;
      let step = 1;
      while (inBounds(r + dr * step, c + dc * step) && board[r + dr * step][c + dc * step] === player) {
        count++;
        step++;
      }
      if (inBounds(r + dr * step, c + dc * step) && board[r + dr * step][c + dc * step] === 0) openEnds++;

      step = 1;
      while (inBounds(r - dr * step, c - dc * step) && board[r - dr * step][c - dc * step] === player) {
        count++;
        step++;
      }
      if (inBounds(r - dr * step, c - dc * step) && board[r - dr * step][c - dc * step] === 0) openEnds++;

      if (count >= 5) total += 1000000;
      else if (count === 4 && openEnds === 2) total += 90000;
      else if (count === 4 && openEnds === 1) total += 12000;
      else if (count === 3 && openEnds === 2) total += 8000;
      else if (count === 3 && openEnds === 1) total += 700;
      else if (count === 2 && openEnds === 2) total += 450;
      else if (count === 2 && openEnds === 1) total += 60;
      else if (count === 1 && openEnds === 2) total += 15;
    }
    return total + Math.max(0, 14 - (Math.abs(r - 7) + Math.abs(c - 7)));
  }

  function getCandidateCells(board) {
    const candidates = [];
    const seen = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    let hasStone = false;

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c] === 0) continue;
        hasStone = true;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const nr = r + dr;
            const nc = c + dc;
            if (inBounds(nr, nc) && board[nr][nc] === 0 && !seen[nr][nc]) {
              seen[nr][nc] = true;
              const atk = evaluateCellFor(board, nr, nc, 2);
              const def = evaluateCellFor(board, nr, nc, 1);
              candidates.push({ r: nr, c: nc, score: atk * 1.08 + def });
            }
          }
        }
      }
    }
    if (!hasStone) return [{ r: 7, c: 7, score: 100 }];
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  function pickAiMove() {
    const candidates = getCandidateCells(omok.board);
    if (candidates.length === 0) return null;

    for (const cand of candidates) {
      omok.board[cand.r][cand.c] = 2;
      const win = checkWinAt(omok.board, cand.r, cand.c, 2);
      omok.board[cand.r][cand.c] = 0;
      if (win) return cand;
    }
    for (const cand of candidates) {
      omok.board[cand.r][cand.c] = 1;
      const win = checkWinAt(omok.board, cand.r, cand.c, 1);
      omok.board[cand.r][cand.c] = 0;
      if (win) return cand;
    }

    if (omok.difficulty === "easy") {
      const pool = candidates.slice(0, Math.min(4, candidates.length));
      if (Math.random() < 0.45 && pool.length > 1) return pool[Math.floor(Math.random() * pool.length)];
      return pool[0];
    }
    if (omok.difficulty === "normal") return candidates[0];

    const top = candidates.slice(0, Math.min(8, candidates.length));
    let bestMove = top[0];
    let bestVal = -Infinity;
    for (const cand of top) {
      omok.board[cand.r][cand.c] = 2;
      const oppCands = getCandidateCells(omok.board);
      const oppBest = oppCands.length > 0 ? oppCands[0].score : 0;
      const val = cand.score - oppBest * 0.65;
      omok.board[cand.r][cand.c] = 0;
      if (val > bestVal) {
        bestVal = val;
        bestMove = cand;
      }
    }
    return bestMove;
  }

  function drawStone(ctx, x, y, player) {
    const r = CELL * 0.43;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.28)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1.5;
    ctx.shadowOffsetY = 2;

    const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.12, x, y, r);
    if (player === 1) {
      grad.addColorStop(0, "#6b7280");
      grad.addColorStop(0.35, "#1f2937");
      grad.addColorStop(1, "#030712");
    } else {
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.7, "#f3f4f6");
      grad.addColorStop(1, "#cbd5e1");
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  function myPvpSide() {
    const user = omok.getUser ? omok.getUser() : null;
    if (!user || !omok.pvpRoom) return 0;
    if (Number(omok.pvpRoom.host_user_id) === Number(user.id)) return 1;
    if (Number(omok.pvpRoom.guest_user_id) === Number(user.id)) return 2;
    return 0;
  }

  function canLocalPlayerPlace() {
    if (!omok.running || omok.gameOver) return false;
    if (omok.mode === "practice") return !omok.aiThinking && omok.turn === 1;
    if (omok.mode === "pvp") {
      return Boolean(omok.pvpRoom && omok.pvpRoom.status === "playing" && !omok.pvpSending && omok.turn === myPvpSide());
    }
    return false;
  }

  function drawBoard() {
    const ctx = omok.ctx;
    if (!ctx) return;

    const bg = ctx.createLinearGradient(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    bg.addColorStop(0, "#f7d59c");
    bg.addColorStop(1, "#e7b46c");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    ctx.strokeStyle = "rgba(92, 58, 22, 0.72)";
    ctx.lineWidth = 1;
    for (let i = 0; i < SIZE; i++) {
      const pos = PAD + i * CELL;
      ctx.beginPath();
      ctx.moveTo(PAD, pos);
      ctx.lineTo(CANVAS_SIZE - PAD, pos);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(pos, PAD);
      ctx.lineTo(pos, CANVAS_SIZE - PAD);
      ctx.stroke();
    }

    ctx.fillStyle = "#5c3a16";
    for (const [sr, sc] of STAR_POINTS) {
      ctx.beginPath();
      ctx.arc(PAD + sc * CELL, PAD + sr * CELL, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }

    if (canLocalPlayerPlace() && omok.hoverCell) {
      const { r, c } = omok.hoverCell;
      if (inBounds(r, c) && omok.board[r][c] === 0) {
        ctx.save();
        ctx.globalAlpha = 0.42;
        drawStone(ctx, PAD + c * CELL, PAD + r * CELL, omok.mode === "pvp" ? myPvpSide() : 1);
        ctx.restore();
      }
    }

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const p = omok.board[r][c];
        if (p !== 0) drawStone(ctx, PAD + c * CELL, PAD + r * CELL, p);
      }
    }

    if (omok.lastMove) {
      const { r, c } = omok.lastMove;
      ctx.save();
      ctx.strokeStyle = "#ec4899";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(PAD + c * CELL, PAD + r * CELL, 5.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (omok.winLine && omok.winLine.length >= 5) {
      const first = omok.winLine[0];
      const last = omok.winLine[omok.winLine.length - 1];
      ctx.save();
      ctx.strokeStyle = "rgba(236, 72, 153, 0.85)";
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(PAD + first[1] * CELL, PAD + first[0] * CELL);
      ctx.lineTo(PAD + last[1] * CELL, PAD + last[0] * CELL);
      ctx.stroke();
      ctx.restore();
    }
  }

  function showOverlay(title, desc, btnText, onBtn) {
    const box = document.getElementById("omok-overlay");
    if (!box) return;
    document.getElementById("omok-overlay-title").textContent = title;
    document.getElementById("omok-overlay-desc").textContent = desc;
    const btn = document.getElementById("omok-overlay-btn");
    btn.textContent = btnText;
    btn.onclick = onBtn;
    box.classList.remove("hidden");
  }

  function hideOverlay() {
    const box = document.getElementById("omok-overlay");
    if (box) box.classList.add("hidden");
  }

  function startPracticeMatch() {
    if (omok.pvpRoom && (omok.pvpRoom.status === "waiting" || omok.pvpRoom.status === "playing")) {
      if (omok.showToast) omok.showToast("진행 중인 1:1 대국실이 있어 먼저 취소하거나 기권해 주세요.");
      return;
    }
    omok.mode = "practice";
    omok.pvpRoom = null;
    omok.board = createEmptyBoard();
    omok.turn = 1;
    omok.running = true;
    omok.gameOver = false;
    omok.aiThinking = false;
    omok.movesCount = 0;
    omok.lastMove = null;
    omok.hoverCell = null;
    omok.winLine = null;
    hideOverlay();
    drawBoard();
    renderControls();
  }

  function switchToPvpTab() {
    omok.mode = "pvp";
    if (!omok.pvpRoom) {
      omok.board = createEmptyBoard();
      omok.running = false;
      omok.gameOver = false;
      omok.lastMove = null;
      omok.winLine = null;
      hideOverlay();
      drawBoard();
    }
    renderControls();
    refreshRoomsAndStats();
  }

  function finishAiPractice(result) {
    omok.gameOver = true;
    omok.running = false;
    omok.aiThinking = false;
    drawBoard();
    updateHud();
    const title = result === "win" ? "🎉 AI 연습 승리!" : result === "draw" ? "🤝 무승부!" : "😢 AI 승리!";
    const desc =
      result === "win"
        ? `${DIFF_LABELS[omok.difficulty]} AI를 ${omok.movesCount}수 만에 이겼습니다! (포인트 변동 없음)`
        : result === "draw"
          ? "빈 칸 없이 무승부로 끝났습니다."
          : `${DIFF_LABELS[omok.difficulty]} AI에게 패배했습니다. 다시 연습해보세요!`;
    showOverlay(title, desc, "다시 연습하기", startPracticeMatch);
  }

  function placeAiStone(r, c, player) {
    omok.board[r][c] = player;
    omok.movesCount += 1;
    omok.lastMove = { r, c };
    const win = checkWinAt(omok.board, r, c, player);
    if (win) {
      omok.winLine = win;
      finishAiPractice(player === 1 ? "win" : "lose");
      return true;
    }
    if (omok.movesCount >= SIZE * SIZE) {
      finishAiPractice("draw");
      return true;
    }
    return false;
  }

  async function handleBoardClick(r, c) {
    if (!canLocalPlayerPlace()) return;
    if (!inBounds(r, c) || omok.board[r][c] !== 0) return;

    if (omok.mode === "practice") {
      if (placeAiStone(r, c, 1)) return;
      omok.turn = 2;
      omok.aiThinking = true;
      drawBoard();
      updateHud();
      setTimeout(() => {
        if (omok.mode !== "practice" || !omok.running || omok.gameOver) return;
        const move = pickAiMove();
        omok.aiThinking = false;
        if (!move) {
          finishAiPractice("draw");
          return;
        }
        if (!placeAiStone(move.r, move.c, 2)) {
          omok.turn = 1;
          drawBoard();
          updateHud();
        }
      }, 200);
      return;
    }

    // PvP server move
    if (omok.mode === "pvp" && omok.pvpRoom && omok.apiHelper) {
      omok.pvpSending = true;
      try {
        const updated = await omok.apiHelper(`/api/games/omok/rooms/${omok.pvpRoom.id}/move`, {
          method: "POST",
          body: { r, c },
        });
        applyPvpRoomState(updated);
      } catch (err) {
        if (omok.showToast) omok.showToast(err.message);
      } finally {
        omok.pvpSending = false;
      }
    }
  }

  function applyPvpRoomState(room) {
    if (!room) return;
    const prevStatus = omok.pvpRoom ? omok.pvpRoom.status : null;
    omok.pvpRoom = room;
    omok.mode = "pvp";
    omok.board = room.board || createEmptyBoard();
    omok.turn = Number(room.turn || 1);
    omok.movesCount = Number(room.moves_count || 0);
    omok.lastMove = room.last_move || null;
    omok.winLine = room.win_line || null;
    omok.running = room.status === "playing";
    omok.gameOver = room.status === "finished" || room.status === "cancelled";

    if (typeof room.my_points === "number" && omok.onPointsChanged) {
      omok.onPointsChanged(room.my_points);
    }

    drawBoard();
    renderControls();

    if (room.status === "waiting") {
      showOverlay(
        "⏳ 상대방 대기 중...",
        `참가비 ${Number(room.stake).toLocaleString()}P 방이 열렸습니다. 다른 유저가 참가하면 자동으로 시작됩니다.`,
        "❌ 대기 취소 (100% 환급)",
        cancelPvpRoom
      );
    } else if (room.status === "playing") {
      hideOverlay();
      if (prevStatus === "waiting" && omok.showToast) {
        omok.showToast(`${room.guest_nickname || "상대방"}님이 입장했습니다! 대국 시작!`);
      }
    } else if (room.status === "finished") {
      const user = omok.getUser ? omok.getUser() : null;
      const myId = user ? Number(user.id) : 0;
      const reasonMap = { five: "5목 완성", timeout: "상대 시간 초과", resign: "상대 기권", draw: "무승부" };
      let title = "대국 종료";
      let desc = "";
      if (room.winner_user_id == null) {
        title = "🤝 무승부!";
        desc = `참가비 ${Number(room.stake).toLocaleString()}P가 환급되었습니다.`;
      } else if (Number(room.winner_user_id) === myId) {
        title = "🎉 1:1 승리!";
        desc = `${reasonMap[room.end_reason] || "승리"}! +${(Number(room.stake) * 2).toLocaleString()}P 획득!`;
      } else {
        title = "😢 아쉽게 패배...";
        desc = `${room.end_reason === "timeout" ? "시간 초과" : room.end_reason === "resign" ? "기권" : "상대 5목 완성"}로 패배했습니다.`;
      }
      showOverlay(title, desc, "대국실 로비로 돌아가기", () => {
        omok.pvpRoom = null;
        omok.board = createEmptyBoard();
        omok.winLine = null;
        omok.lastMove = null;
        hideOverlay();
        drawBoard();
        renderControls();
        refreshRoomsAndStats();
      });
      if (prevStatus === "playing") refreshRoomsAndStats();
    }
  }

  async function createPvpRoom() {
    const user = omok.getUser ? omok.getUser() : null;
    if (!user) {
      if (omok.showToast) omok.showToast("1:1 대국실은 로그인 후 이용할 수 있습니다.");
      return;
    }
    try {
      const room = await omok.apiHelper("/api/games/omok/rooms", {
        method: "POST",
        body: { stake: omok.selectedStake },
      });
      applyPvpRoomState(room);
      if (omok.showToast) omok.showToast(`${omok.selectedStake.toLocaleString()}P 1:1 대국실을 만들었습니다!`);
    } catch (err) {
      if (omok.showToast) omok.showToast(err.message);
    }
  }

  async function joinPvpRoom(roomId) {
    const user = omok.getUser ? omok.getUser() : null;
    if (!user) {
      if (omok.showToast) omok.showToast("1:1 대국실 참가는 로그인 후 이용할 수 있습니다.");
      return;
    }
    try {
      const room = await omok.apiHelper(`/api/games/omok/rooms/${roomId}/join`, { method: "POST" });
      applyPvpRoomState(room);
    } catch (err) {
      if (omok.showToast) omok.showToast(err.message);
      refreshRoomsAndStats();
    }
  }

  async function cancelPvpRoom() {
    if (!omok.pvpRoom || !omok.apiHelper) return;
    try {
      const res = await omok.apiHelper(`/api/games/omok/rooms/${omok.pvpRoom.id}/cancel`, { method: "POST" });
      if (typeof res.points === "number" && omok.onPointsChanged) omok.onPointsChanged(res.points);
      omok.pvpRoom = null;
      omok.board = createEmptyBoard();
      hideOverlay();
      drawBoard();
      renderControls();
      if (omok.showToast) omok.showToast("대국실이 취소되어 참가비가 100% 환급되었습니다.");
      refreshRoomsAndStats();
    } catch (err) {
      if (omok.showToast) omok.showToast(err.message);
    }
  }

  async function resignPvpRoom() {
    if (!omok.pvpRoom || omok.pvpRoom.status !== "playing" || !omok.apiHelper) return;
    if (!window.confirm("정말 1:1 대국을 기권할까요? 상대방이 승리하게 됩니다.")) return;
    try {
      const updated = await omok.apiHelper(`/api/games/omok/rooms/${omok.pvpRoom.id}/resign`, { method: "POST" });
      applyPvpRoomState(updated);
    } catch (err) {
      if (omok.showToast) omok.showToast(err.message);
    }
  }

  function remainingSecondsText() {
    if (!omok.pvpRoom || omok.pvpRoom.status !== "playing" || !omok.pvpRoom.turn_deadline) return "";
    const dl = Date.parse(omok.pvpRoom.turn_deadline);
    if (Number.isNaN(dl)) return "";
    const sec = Math.max(0, Math.ceil((dl - Date.now()) / 1000));
    return ` · ⏱️ ${sec}초`;
  }

  function updateHud() {
    const turnEl = document.getElementById("omok-turn-status");
    const movesEl = document.getElementById("omok-moves-count");
    const modeEl = document.getElementById("omok-mode-status");

    if (omok.mode === "practice") {
      if (turnEl) {
        if (omok.gameOver) turnEl.textContent = "연습 종료";
        else if (omok.aiThinking) turnEl.textContent = "⚪ AI 생각 중...";
        else turnEl.textContent = omok.turn === 1 ? "⚫ 내 차례 (흑돌)" : "⚪ AI 차례 (백돌)";
      }
      if (movesEl) movesEl.textContent = `${omok.movesCount}수`;
      if (modeEl) modeEl.textContent = `🤖 무료 연습 (${DIFF_LABELS[omok.difficulty]} AI)`;
      return;
    }

    const r = omok.pvpRoom;
    if (!r) {
      if (turnEl) turnEl.textContent = "대기 중";
      if (movesEl) movesEl.textContent = "0수";
      if (modeEl) modeEl.textContent = "⚔️ 방을 만들거나 대기 중인 대국실에 참가하세요!";
      return;
    }

    const side = myPvpSide();
    if (turnEl) {
      if (r.status === "waiting") turnEl.textContent = "⏳ 상대 입장 대기";
      else if (r.status === "finished") turnEl.textContent = "대국 종료";
      else turnEl.textContent = Number(r.turn) === side ? "🔥 내 차례!" : "⏳ 상대 차례";
    }
    if (movesEl) movesEl.textContent = `${omok.movesCount}수${remainingSecondsText()}`;
    if (modeEl) {
      modeEl.textContent = `⚫ ${r.host_nickname} vs ⚪ ${r.guest_nickname || "대기중"} (${Number(r.stake).toLocaleString()}P 방)`;
    }
  }

  function renderControls() {
    const user = omok.getUser ? omok.getUser() : null;
    const ptsEl = document.getElementById("omok-my-points");
    if (ptsEl) ptsEl.textContent = user ? `보유: ${user.points.toLocaleString()} P` : "로그인 필요";

    const practiceBtn = document.getElementById("omok-practice-btn");
    const pvpBtn = document.getElementById("omok-pvp-tab-btn");
    const aiCtrl = document.getElementById("omok-ai-controls");
    const pvpCtrl = document.getElementById("omok-pvp-controls");

    if (practiceBtn) practiceBtn.classList.toggle("active", omok.mode === "practice");
    if (pvpBtn) pvpBtn.classList.toggle("active", omok.mode === "pvp");
    if (aiCtrl) aiCtrl.classList.toggle("hidden", omok.mode !== "practice");
    if (pvpCtrl) pvpCtrl.classList.toggle("hidden", omok.mode !== "pvp");

    document.querySelectorAll(".omok-diff-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.diff === omok.difficulty);
    });
    document.querySelectorAll(".omok-pvp-stake-btn").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.stake) === omok.selectedStake);
      btn.disabled = Boolean(omok.pvpRoom && (omok.pvpRoom.status === "waiting" || omok.pvpRoom.status === "playing"));
    });

    const createBtn = document.getElementById("omok-create-room-btn");
    const cancelBtn = document.getElementById("omok-cancel-room-btn");
    const forfeitBtn = document.getElementById("omok-forfeit-btn");
    const inWaiting = Boolean(omok.pvpRoom && omok.pvpRoom.status === "waiting");
    const inPlaying = Boolean(omok.pvpRoom && omok.pvpRoom.status === "playing");

    if (createBtn) {
      createBtn.classList.toggle("hidden", inWaiting || inPlaying);
      createBtn.textContent = `➕ ${omok.selectedStake.toLocaleString()}P 방 만들기`;
    }
    if (cancelBtn) cancelBtn.classList.toggle("hidden", !inWaiting);
    if (forfeitBtn) forfeitBtn.classList.toggle("hidden", !inPlaying);

    updateHud();
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function refreshRoomsAndStats() {
    if (!omok.apiHelper) return;
    try {
      const data = await omok.apiHelper("/api/games/omok/rooms");
      const user = omok.getUser ? omok.getUser() : null;
      const myId = user ? Number(user.id) : 0;

      if (data.my_room && (!omok.pvpRoom || omok.pvpRoom.status !== "finished")) {
        applyPvpRoomState(data.my_room);
      }

      const waitEl = document.getElementById("omok-waiting-rooms");
      if (waitEl) {
        waitEl.innerHTML = "";
        if (!data.waiting_rooms || data.waiting_rooms.length === 0) {
          waitEl.innerHTML = '<div class="muted small">현재 대기 중인 1:1 방이 없습니다. 방을 만들어 보세요!</div>';
        } else {
          data.waiting_rooms.forEach((rm) => {
            const item = document.createElement("div");
            item.className = "list-item row-between";
            const left = document.createElement("div");
            left.innerHTML = `<strong>${escapeHtml(rm.host_nickname)}</strong> <span class="badge-pink">${Number(rm.stake).toLocaleString()}P</span>`;
            item.appendChild(left);
            if (Number(rm.host_user_id) === myId) {
              const mine = document.createElement("span");
              mine.className = "muted small";
              mine.textContent = "내 방";
              item.appendChild(mine);
            } else {
              const btn = document.createElement("button");
              btn.type = "button";
              btn.className = "btn btn-pink btn-sm";
              btn.textContent = "⚔️ 참가";
              btn.onclick = () => joinPvpRoom(rm.id);
              item.appendChild(btn);
            }
            waitEl.appendChild(item);
          });
        }
      }

      const lbEl = document.getElementById("omok-leaderboard");
      if (lbEl) {
        lbEl.innerHTML = "";
        if (!data.leaderboard || data.leaderboard.length === 0) {
          lbEl.innerHTML = '<div class="muted small">아직 1:1 오목 승리 기록이 없습니다.</div>';
        } else {
          data.leaderboard.forEach((row, idx) => {
            const item = document.createElement("div");
            item.className = "list-item row-between";
            item.innerHTML = `<span><strong>${idx + 1}. ${escapeHtml(row.nickname)}</strong></span><span class="badge-pink">${row.wins}승</span>`;
            lbEl.appendChild(item);
          });
        }
      }

      const recEl = document.getElementById("omok-my-record");
      const histEl = document.getElementById("omok-my-history");
      if (!user || !data.my_stats) {
        if (recEl) recEl.textContent = "-";
        if (histEl) histEl.innerHTML = '<div class="muted small">로그인하면 내 1:1 전적을 확인할 수 있습니다.</div>';
      } else {
        if (recEl) recEl.textContent = `${data.my_stats.wins}승 ${data.my_stats.losses}패`;
        if (histEl) {
          histEl.innerHTML = "";
          if (!data.recent_matches || data.recent_matches.length === 0) {
            histEl.innerHTML = '<div class="muted small">아직 1:1 대국 기록이 없습니다.</div>';
          } else {
            data.recent_matches.forEach((m) => {
              const isWin = Number(m.winner_user_id) === myId;
              const isDraw = m.winner_user_id == null;
              const opp = Number(m.host_user_id) === myId ? m.guest_nickname : m.host_nickname;
              const item = document.createElement("div");
              item.className = "list-item row-between";
              const resText = isDraw ? "무승부" : isWin ? "승리" : "패배";
              const ptsText = isDraw ? `${m.stake}P 환급` : isWin ? `+${(m.stake * 2).toLocaleString()}P` : `-${m.stake}P`;
              item.innerHTML = `<span><strong>${resText}</strong> <span class="muted small">vs ${escapeHtml(opp || "상대")}</span></span><span class="${isWin ? "badge-pink" : "muted small"}">${ptsText}</span>`;
              histEl.appendChild(item);
            });
          }
        }
      }
    } catch (_) {
      // Ignore transient polling error
    }
  }

  function startTimers() {
    if (!omok.pollTimer) {
      omok.pollTimer = setInterval(async () => {
        const page = document.getElementById("page-game");
        const panel = document.getElementById("game-panel-omok");
        if (!page || !page.classList.contains("active") || !panel || panel.classList.contains("hidden")) return;

        if (omok.pvpRoom && (omok.pvpRoom.status === "waiting" || omok.pvpRoom.status === "playing")) {
          try {
            const updated = await omok.apiHelper(`/api/games/omok/rooms/${omok.pvpRoom.id}`);
            applyPvpRoomState(updated);
          } catch (_) {}
        } else if (omok.mode === "pvp") {
          refreshRoomsAndStats();
        }
      }, 1500);
    }

    if (!omok.countdownTimer) {
      omok.countdownTimer = setInterval(() => {
        if (omok.mode === "pvp" && omok.pvpRoom && omok.pvpRoom.status === "playing") {
          updateHud();
        }
      }, 500);
    }
  }

  function eventToCell(canvas, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * CANVAS_SIZE;
    const y = ((clientY - rect.top) / rect.height) * CANVAS_SIZE;
    return { r: Math.round((y - PAD) / CELL), c: Math.round((x - PAD) / CELL) };
  }

  function initPage({ api, getUser, onPointsChanged, showToast }) {
    omok.apiHelper = api;
    omok.getUser = getUser;
    omok.onPointsChanged = onPointsChanged;
    omok.showToast = showToast;

    if (!omok.initialized) {
      omok.initialized = true;
      const canvas = document.getElementById("omok-canvas");
      if (!canvas) return;
      omok.canvas = canvas;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = CANVAS_SIZE * dpr;
      canvas.height = CANVAS_SIZE * dpr;
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      omok.ctx = ctx;

      canvas.addEventListener("pointermove", (e) => {
        if (e.pointerType !== "mouse") return;
        omok.hoverCell = eventToCell(canvas, e.clientX, e.clientY);
        drawBoard();
      });
      canvas.addEventListener("pointerleave", () => {
        omok.hoverCell = null;
        drawBoard();
      });
      canvas.addEventListener("click", (e) => {
        const cell = eventToCell(canvas, e.clientX, e.clientY);
        handleBoardClick(cell.r, cell.c);
      });

      document.getElementById("omok-practice-btn")?.addEventListener("click", startPracticeMatch);
      document.getElementById("omok-pvp-tab-btn")?.addEventListener("click", switchToPvpTab);
      document.getElementById("omok-ai-restart-btn")?.addEventListener("click", startPracticeMatch);
      document.getElementById("omok-create-room-btn")?.addEventListener("click", createPvpRoom);
      document.getElementById("omok-cancel-room-btn")?.addEventListener("click", cancelPvpRoom);
      document.getElementById("omok-forfeit-btn")?.addEventListener("click", resignPvpRoom);
      document.getElementById("omok-refresh-rooms-btn")?.addEventListener("click", refreshRoomsAndStats);

      document.querySelectorAll(".omok-diff-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          omok.difficulty = btn.dataset.diff;
          renderControls();
        });
      });

      document.querySelectorAll(".omok-pvp-stake-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          omok.selectedStake = Number(btn.dataset.stake);
          renderControls();
        });
      });

      startPracticeMatch();
      startTimers();
    }

    renderControls();
    refreshRoomsAndStats();
  }

  window.ChaeonOmok = { initPage };
})();
