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
  const DIFF_STAKES = { easy: 100, normal: 300, hard: 500 };
  const DIFF_REWARDS = { easy: 200, normal: 700, hard: 1500 };

  const omok = {
    initialized: false,
    canvas: null,
    ctx: null,
    board: [],
    turn: 1, // 1 = Player (Black), 2 = AI (White)
    mode: "practice", // "practice" | "challenge"
    difficulty: "normal",
    activeRunId: null,
    running: false,
    gameOver: false,
    aiThinking: false,
    settling: false,
    movesCount: 0,
    lastMove: null,
    hoverCell: null,
    winLine: null,
    startedAtMs: 0,
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
      if (inBounds(r + dr * step, c + dc * step) && board[r + dr * step][c + dc * step] === 0) {
        openEnds++;
      }

      step = 1;
      while (inBounds(r - dr * step, c - dc * step) && board[r - dr * step][c - dc * step] === player) {
        count++;
        step++;
      }
      if (inBounds(r - dr * step, c - dc * step) && board[r - dr * step][c - dc * step] === 0) {
        openEnds++;
      }

      if (count >= 5) total += 1000000;
      else if (count === 4 && openEnds === 2) total += 90000;
      else if (count === 4 && openEnds === 1) total += 12000;
      else if (count === 3 && openEnds === 2) total += 8000;
      else if (count === 3 && openEnds === 1) total += 700;
      else if (count === 2 && openEnds === 2) total += 450;
      else if (count === 2 && openEnds === 1) total += 60;
      else if (count === 1 && openEnds === 2) total += 15;
    }
    const centerDist = Math.abs(r - 7) + Math.abs(c - 7);
    total += Math.max(0, 14 - centerDist);
    return total;
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

    // Immediate winning move for AI
    for (const cand of candidates) {
      omok.board[cand.r][cand.c] = 2;
      const win = checkWinAt(omok.board, cand.r, cand.c, 2);
      omok.board[cand.r][cand.c] = 0;
      if (win) return cand;
    }

    // Immediate block for Player's 5-in-a-row
    for (const cand of candidates) {
      omok.board[cand.r][cand.c] = 1;
      const win = checkWinAt(omok.board, cand.r, cand.c, 1);
      omok.board[cand.r][cand.c] = 0;
      if (win) return cand;
    }

    if (omok.difficulty === "easy") {
      const pool = candidates.slice(0, Math.min(4, candidates.length));
      if (Math.random() < 0.45 && pool.length > 1) {
        return pool[Math.floor(Math.random() * pool.length)];
      }
      return pool[0];
    }

    if (omok.difficulty === "normal") {
      return candidates[0];
    }

    // Hard: 2-ply lookahead over top 8 candidates
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

  function drawBoard() {
    const ctx = omok.ctx;
    if (!ctx) return;

    // Wood background
    const bg = ctx.createLinearGradient(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    bg.addColorStop(0, "#f7d59c");
    bg.addColorStop(1, "#e7b46c");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Grid lines
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

    // Star points
    ctx.fillStyle = "#5c3a16";
    for (const [sr, sc] of STAR_POINTS) {
      ctx.beginPath();
      ctx.arc(PAD + sc * CELL, PAD + sr * CELL, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Hover preview stone
    if (omok.running && !omok.gameOver && !omok.aiThinking && omok.turn === 1 && omok.hoverCell) {
      const { r, c } = omok.hoverCell;
      if (inBounds(r, c) && omok.board[r][c] === 0) {
        ctx.save();
        ctx.globalAlpha = 0.42;
        drawStone(ctx, PAD + c * CELL, PAD + r * CELL, 1);
        ctx.restore();
      }
    }

    // Placed stones
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const p = omok.board[r][c];
        if (p !== 0) {
          drawStone(ctx, PAD + c * CELL, PAD + r * CELL, p);
        }
      }
    }

    // Last move marker
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

    // Winning 5-in-a-row highlight
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

  function resetBoard() {
    omok.board = createEmptyBoard();
    omok.turn = 1;
    omok.gameOver = false;
    omok.aiThinking = false;
    omok.settling = false;
    omok.movesCount = 0;
    omok.lastMove = null;
    omok.hoverCell = null;
    omok.winLine = null;
    omok.startedAtMs = Date.now();
    hideOverlay();
    drawBoard();
    updateHud();
  }

  function startPracticeMatch() {
    if (omok.activeRunId) {
      if (omok.showToast) omok.showToast("진행 중인 오목 포인트 대국이 있습니다. 먼저 종료하거나 기권해 주세요.");
      return;
    }
    omok.mode = "practice";
    omok.running = true;
    resetBoard();
    renderControls();
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

  async function finishMatch(result) {
    omok.gameOver = true;
    omok.running = false;
    omok.aiThinking = false;
    drawBoard();
    updateHud();

    const durationSec = Math.max(1, Math.round((Date.now() - omok.startedAtMs) / 1000));
    const titleMap = {
      win: "🎉 승리했습니다!",
      lose: "😢 AI가 승리했습니다",
      draw: "🤝 무승부입니다",
    };

    if (omok.mode === "challenge" && omok.activeRunId && omok.apiHelper) {
      omok.settling = true;
      showOverlay("⏳ 대국 정산 중...", "결과를 서버에 기록하고 포인트를 정산 중입니다.", "잠시만요...", () => {});
      try {
        const res = await omok.apiHelper("/api/games/omok/finish", {
          method: "POST",
          body: {
            run_id: omok.activeRunId,
            result,
            moves_count: omok.movesCount,
            duration_sec: durationSec,
          },
        });
        omok.activeRunId = null;
        if (omok.onPointsChanged) omok.onPointsChanged(res.points);
        const msg =
          result === "win"
            ? `${DIFF_LABELS[res.difficulty]} AI 승리! +${res.reward.toLocaleString()} P 획득 (순수익 +${res.net.toLocaleString()} P)`
            : result === "draw"
              ? `무승부로 참가비 ${res.reward.toLocaleString()} P가 환급되었습니다.`
              : `아쉽게 패배해 참가비 ${res.stake.toLocaleString()} P를 잃었습니다.`;
        showOverlay(titleMap[result], msg, "다시 도전하기", () => startChallengeMatch(false));
        await refreshStatsAndLeaderboard();
      } catch (err) {
        showOverlay("정산 오류", err.message || "정산 중 오류가 발생했습니다.", "연습 모드로 전환", startPracticeMatch);
      } finally {
        omok.settling = false;
        renderControls();
      }
      return;
    }

    const practiceMsg =
      result === "win"
        ? `${DIFF_LABELS[omok.difficulty]} AI를 ${omok.movesCount}수 만에 이겼습니다!`
        : result === "draw"
          ? "빈 칸 없이 무승부로 끝났습니다."
          : `${DIFF_LABELS[omok.difficulty]} AI에게 패배했습니다. 다시 도전해보세요!`;
    showOverlay(titleMap[result], practiceMsg, "다시 연습하기", startPracticeMatch);
    renderControls();
  }

  function placeStone(r, c, player) {
    omok.board[r][c] = player;
    omok.movesCount += 1;
    omok.lastMove = { r, c };
    const win = checkWinAt(omok.board, r, c, player);
    if (win) {
      omok.winLine = win;
      finishMatch(player === 1 ? "win" : "lose");
      return true;
    }
    if (omok.movesCount >= SIZE * SIZE) {
      finishMatch("draw");
      return true;
    }
    return false;
  }

  function handlePlayerClick(r, c) {
    if (!omok.running || omok.gameOver || omok.aiThinking || omok.turn !== 1) return;
    if (!inBounds(r, c) || omok.board[r][c] !== 0) return;

    const ended = placeStone(r, c, 1);
    if (ended) return;

    omok.turn = 2;
    omok.aiThinking = true;
    drawBoard();
    updateHud();

    setTimeout(() => {
      if (!omok.running || omok.gameOver) return;
      const move = pickAiMove();
      omok.aiThinking = false;
      if (!move) {
        finishMatch("draw");
        return;
      }
      const aiEnded = placeStone(move.r, move.c, 2);
      if (!aiEnded) {
        omok.turn = 1;
        drawBoard();
        updateHud();
      }
    }, 220);
  }

  async function startChallengeMatch(forfeitExisting = false) {
    const user = omok.getUser ? omok.getUser() : null;
    if (!user) {
      if (omok.showToast) omok.showToast("포인트 도전은 로그인 후 이용할 수 있습니다.");
      return;
    }
    try {
      const res = await omok.apiHelper("/api/games/omok/start", {
        method: "POST",
        body: { difficulty: omok.difficulty, forfeit_existing: forfeitExisting },
      });
      omok.mode = "challenge";
      omok.activeRunId = res.run_id;
      omok.running = true;
      if (omok.onPointsChanged) omok.onPointsChanged(res.points);
      resetBoard();
      renderControls();
      if (omok.showToast) {
        omok.showToast(`오목 AI(${DIFF_LABELS[omok.difficulty]}) 도전 시작! 승리 시 ${DIFF_REWARDS[omok.difficulty].toLocaleString()}P 획득!`);
      }
      await refreshStatsAndLeaderboard();
    } catch (err) {
      if (err.message && err.message.includes("진행 중인 오목 대국")) {
        if (window.confirm("이미 진행 중인 오목 대국이 있습니다. 기존 대국을 기권하고 새로 시작할까요? (기존 참가비는 반환되지 않습니다)")) {
          await startChallengeMatch(true);
        }
      } else if (omok.showToast) {
        omok.showToast(err.message);
      }
    }
  }

  async function forfeitActiveMatch() {
    if (!omok.activeRunId || !omok.apiHelper) return;
    const stake = DIFF_STAKES[omok.difficulty] || 100;
    if (!window.confirm(`정말 현재 대국을 기권할까요? 참가비 ${stake.toLocaleString()}P는 반환되지 않습니다.`)) return;
    try {
      await omok.apiHelper("/api/games/omok/forfeit", {
        method: "POST",
        body: { run_id: omok.activeRunId },
      });
      omok.activeRunId = null;
      omok.running = false;
      omok.gameOver = true;
      if (omok.showToast) omok.showToast("오목 대국을 기권했습니다.");
      startPracticeMatch();
      await refreshStatsAndLeaderboard();
    } catch (err) {
      if (omok.showToast) omok.showToast(err.message);
    }
  }

  function updateHud() {
    const turnEl = document.getElementById("omok-turn-status");
    const movesEl = document.getElementById("omok-moves-count");
    const modeEl = document.getElementById("omok-mode-status");
    if (turnEl) {
      if (omok.gameOver) turnEl.textContent = "대국 종료";
      else if (omok.aiThinking) turnEl.textContent = "⚪ AI 생각 중...";
      else turnEl.textContent = omok.turn === 1 ? "⚫ 내 차례 (흑돌)" : "⚪ AI 차례 (백돌)";
    }
    if (movesEl) movesEl.textContent = `${omok.movesCount}수`;
    if (modeEl) {
      const reward = DIFF_REWARDS[omok.difficulty];
      modeEl.textContent =
        omok.mode === "challenge" && omok.activeRunId
          ? `🔥 포인트 도전 중 (${DIFF_LABELS[omok.difficulty]} · 승리 보상 ${reward.toLocaleString()}P)`
          : `무료 연습 (${DIFF_LABELS[omok.difficulty]} AI)`;
    }
  }

  function renderControls() {
    const user = omok.getUser ? omok.getUser() : null;
    const ptsEl = document.getElementById("omok-my-points");
    if (ptsEl) ptsEl.textContent = user ? `보유: ${user.points.toLocaleString()} P` : "로그인 필요";

    document.querySelectorAll(".omok-diff-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.diff === omok.difficulty);
      btn.disabled = Boolean(omok.activeRunId);
    });

    const practiceBtn = document.getElementById("omok-practice-btn");
    const startBtn = document.getElementById("omok-start-challenge-btn");
    const forfeitBtn = document.getElementById("omok-forfeit-btn");
    if (practiceBtn) practiceBtn.classList.toggle("active", omok.mode === "practice");
    if (startBtn) {
      startBtn.disabled = Boolean(omok.activeRunId);
      const stake = DIFF_STAKES[omok.difficulty] || 100;
      const reward = DIFF_REWARDS[omok.difficulty] || 200;
      startBtn.textContent = omok.activeRunId
        ? `대국 진행 중 (${DIFF_LABELS[omok.difficulty]})`
        : `🔥 ${stake.toLocaleString()}P 걸고 도전 (승리 ${reward.toLocaleString()}P)`;
    }
    if (forfeitBtn) forfeitBtn.classList.toggle("hidden", !omok.activeRunId);
    updateHud();
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function refreshStatsAndLeaderboard() {
    if (!omok.apiHelper) return;
    try {
      const lb = await omok.apiHelper("/api/games/omok/leaderboard");
      const lbEl = document.getElementById("omok-leaderboard");
      if (lbEl) {
        lbEl.innerHTML = "";
        if (!lb.leaderboard || lb.leaderboard.length === 0) {
          lbEl.innerHTML = '<div class="muted small">아직 포인트 대국 승리 기록이 없습니다. 첫 승리에 도전하세요!</div>';
        } else {
          lb.leaderboard.forEach((row, idx) => {
            const item = document.createElement("div");
            item.className = "list-item row-between";
            item.innerHTML = `<span><strong>${idx + 1}. ${escapeHtml(row.nickname)}</strong> <span class="muted small">(${row.games_played}전)</span></span><span class="badge-pink">${row.wins}승</span>`;
            lbEl.appendChild(item);
          });
        }
      }

      const user = omok.getUser ? omok.getUser() : null;
      const recordEl = document.getElementById("omok-my-record");
      const histEl = document.getElementById("omok-my-history");
      if (!user) {
        if (recordEl) recordEl.textContent = "-";
        if (histEl) histEl.innerHTML = '<div class="muted small">로그인하면 내 대국 전적을 확인할 수 있습니다.</div>';
        return;
      }

      const me = await omok.apiHelper("/api/games/omok/me");
      if (recordEl) recordEl.textContent = `${me.wins}승 ${me.losses}패`;
      if (me.active_run && !omok.activeRunId) {
        omok.activeRunId = me.active_run.id;
        omok.difficulty = me.active_run.difficulty || "normal";
        omok.mode = "challenge";
        omok.running = true;
        resetBoard();
      }

      if (histEl) {
        histEl.innerHTML = "";
        if (!me.recent_runs || me.recent_runs.length === 0) {
          histEl.innerHTML = '<div class="muted small">아직 포인트 대국 기록이 없습니다.</div>';
        } else {
          const resLabel = { win: "승리", lose: "패배", draw: "무승부", forfeited: "기권" };
          me.recent_runs.forEach((r) => {
            const item = document.createElement("div");
            item.className = "list-item row-between";
            const left = document.createElement("div");
            left.innerHTML = `<strong>${resLabel[r.result] || r.result}</strong> <span class="muted small">· ${DIFF_LABELS[r.difficulty] || r.difficulty} AI (${r.moves_count}수)</span>`;
            const right = document.createElement("span");
            right.className = r.reward > 0 ? "badge-pink" : "muted small";
            right.textContent = r.reward > 0 ? `+${Number(r.reward).toLocaleString()}P` : "0P";
            item.appendChild(left);
            item.appendChild(right);
            histEl.appendChild(item);
          });
        }
      }
      renderControls();
    } catch (_) {
      // Ignore transient error
    }
  }

  function eventToCell(canvas, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * CANVAS_SIZE;
    const y = ((clientY - rect.top) / rect.height) * CANVAS_SIZE;
    const c = Math.round((x - PAD) / CELL);
    const r = Math.round((y - PAD) / CELL);
    return { r, c };
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
        handlePlayerClick(cell.r, cell.c);
      });

      document.querySelectorAll(".omok-diff-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (omok.activeRunId) return;
          omok.difficulty = btn.dataset.diff;
          renderControls();
        });
      });

      const practiceBtn = document.getElementById("omok-practice-btn");
      if (practiceBtn) practiceBtn.addEventListener("click", startPracticeMatch);

      const startBtn = document.getElementById("omok-start-challenge-btn");
      if (startBtn) startBtn.addEventListener("click", () => startChallengeMatch(false));

      const forfeitBtn = document.getElementById("omok-forfeit-btn");
      if (forfeitBtn) forfeitBtn.addEventListener("click", forfeitActiveMatch);

      startPracticeMatch();
    }

    renderControls();
    refreshStatsAndLeaderboard();
  }

  window.ChaeonOmok = { initPage };
})();
