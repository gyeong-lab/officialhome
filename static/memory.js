(() => {
  const TIME_LIMIT_MS = 60000;
  let ctx = null;
  let cardsPool = [];
  let deck = [];
  let flipped = [];
  let matchedCount = 0;
  let moves = 0;
  let lockBoard = false;
  let runId = null;
  let startTimeMs = 0;
  let timerHandle = null;
  let playing = false;
  let bound = false;

  function formatMs(ms) {
    const s = Math.max(0, ms) / 1000;
    return `${s.toFixed(2)}초`;
  }

  function stopTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function updateHud(elapsedMs = 0) {
    const timeEl = document.getElementById("memory-time");
    const movesEl = document.getElementById("memory-moves");
    const pairsEl = document.getElementById("memory-pairs");
    const statusEl = document.getElementById("memory-status");
    if (timeEl) timeEl.textContent = formatMs(elapsedMs);
    if (movesEl) movesEl.textContent = `${moves}회`;
    if (pairsEl) pairsEl.textContent = `${matchedCount} / 8`;
    if (statusEl && !playing && matchedCount === 0) {
      statusEl.textContent = "새 게임 시작을 눌러 60초 안에 8쌍을 맞춰보세요!";
    }
  }

  function shuffle(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function renderBoard() {
    const board = document.getElementById("memory-board");
    if (!board) return;
    board.innerHTML = "";
    deck.forEach((card, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "memory-card";
      if (card.flipped) btn.classList.add("flipped");
      if (card.matched) btn.classList.add("matched");
      btn.dataset.index = String(idx);
      btn.setAttribute("aria-label", card.matched || card.flipped ? card.name : "뒤집힌 카드");

      const inner = document.createElement("div");
      inner.className = "memory-card-inner";

      const back = document.createElement("div");
      back.className = "memory-card-face memory-card-back";
      back.textContent = "💖";

      const front = document.createElement("div");
      front.className = "memory-card-face memory-card-front";
      if (card.image_url) {
        const img = document.createElement("img");
        img.src = card.image_url;
        img.alt = card.name;
        img.loading = "lazy";
        front.appendChild(img);
      } else {
        const g = document.createElement("span");
        g.className = "memory-card-glyph";
        g.textContent = card.glyph || "💖";
        front.appendChild(g);
      }

      inner.appendChild(back);
      inner.appendChild(front);
      btn.appendChild(inner);
      btn.addEventListener("click", () => handleCardClick(idx));
      board.appendChild(btn);
    });
  }

  async function handleCardClick(idx) {
    if (!playing || lockBoard) return;
    const card = deck[idx];
    if (!card || card.flipped || card.matched) return;

    card.flipped = true;
    flipped.push(idx);
    renderBoard();

    if (flipped.length < 2) return;

    moves += 1;
    const [aIdx, bIdx] = flipped;
    const cardA = deck[aIdx];
    const cardB = deck[bIdx];

    if (cardA.id === cardB.id) {
      cardA.matched = true;
      cardB.matched = true;
      matchedCount += 1;
      flipped = [];
      renderBoard();
      updateHud(Date.now() - startTimeMs);

      if (matchedCount === 8) {
        await finishGame();
      }
    } else {
      lockBoard = true;
      updateHud(Date.now() - startTimeMs);
      setTimeout(() => {
        cardA.flipped = false;
        cardB.flipped = false;
        flipped = [];
        lockBoard = false;
        renderBoard();
      }, 550);
    }
  }

  async function finishGame() {
    playing = false;
    stopTimer();
    const elapsedMs = Math.max(2500, Date.now() - startTimeMs);
    updateHud(elapsedMs);
    const statusEl = document.getElementById("memory-status");

    const user = ctx && ctx.getUser ? ctx.getUser() : null;
    if (user && runId) {
      try {
        const res = await ctx.api("/api/games/memory/finish", {
          method: "POST",
          body: { run_id: runId, moves, elapsed_ms: elapsedMs },
        });
        runId = null;
        const rankMsg = res.my_rank ? ` (오늘 현재 ${res.my_rank}위!)` : "";
        if (statusEl) {
          statusEl.textContent = `🎉 클리어! ${formatMs(res.elapsed_ms)} · ${moves}회${rankMsg}`;
        }
        ctx.showToast(`🃏 클리어! ${formatMs(res.elapsed_ms)}${rankMsg}`);
        await refreshStatsAndLeaderboard();
      } catch (err) {
        if (statusEl) statusEl.textContent = err.message || "기록 저장에 실패했습니다.";
        ctx.showToast(err.message || "기록 저장에 실패했습니다.");
      }
    } else {
      if (statusEl) {
        statusEl.textContent = `🎉 연습 클리어! ${formatMs(elapsedMs)} · ${moves}회 (로그인하면 랭킹 등록 가능)`;
      }
      ctx.showToast(`🃏 연습 클리어! ${formatMs(elapsedMs)}`);
    }
  }

  async function startGame() {
    stopTimer();
    playing = false;
    lockBoard = false;
    flipped = [];
    matchedCount = 0;
    moves = 0;
    runId = null;

    if (!cardsPool.length) {
      const data = await ctx.api("/api/games/memory/cards");
      cardsPool = data.cards || [];
    }

    const user = ctx && ctx.getUser ? ctx.getUser() : null;
    const statusEl = document.getElementById("memory-status");
    if (user) {
      try {
        const started = await ctx.api("/api/games/memory/start", { method: "POST", body: {} });
        runId = started.run_id;
      } catch (err) {
        ctx.showToast(err.message || "게임 시작 중 오류가 발생했습니다.");
        return;
      }
    }

    const base8 = cardsPool.slice(0, 8);
    deck = shuffle([...base8, ...base8]).map((c) => ({
      ...c,
      flipped: false,
      matched: false,
    }));

    playing = true;
    startTimeMs = Date.now();
    if (statusEl) {
      statusEl.textContent = user
        ? "🔥 일일 랭킹 도전 중! 60초 안에 8쌍을 맞춰보세요!"
        : "🎮 무료 연습 중! (로그인 시 일일 랭킹 도전)";
    }
    renderBoard();
    updateHud(0);

    timerHandle = setInterval(() => {
      if (!playing) return stopTimer();
      const elapsed = Date.now() - startTimeMs;
      if (elapsed >= TIME_LIMIT_MS) {
        playing = false;
        stopTimer();
        lockBoard = true;
        updateHud(TIME_LIMIT_MS);
        if (statusEl) statusEl.textContent = "⏰ 시간 초과! 다시 시작해 보세요.";
        ctx.showToast("⏰ 60초 시간 초과!");
        return;
      }
      updateHud(elapsed);
    }, 100);
  }

  async function refreshStatsAndLeaderboard() {
    const lbWrap = document.getElementById("memory-leaderboard");
    const rewardsWrap = document.getElementById("memory-rewards-list");
    const yesterdayWrap = document.getElementById("memory-yesterday-list");
    const myBestEl = document.getElementById("memory-my-best");
    const ptsEl = document.getElementById("memory-my-points");
    const user = ctx && ctx.getUser ? ctx.getUser() : null;

    if (ptsEl) {
      ptsEl.textContent = user ? `보유 ${Number(user.points || 0).toLocaleString()} P` : "로그인 필요";
    }

    try {
      const lb = await ctx.api("/api/games/memory/leaderboard");
      if (rewardsWrap) {
        rewardsWrap.innerHTML = "";
        (lb.rewards || []).forEach((amt, idx) => {
          const row = document.createElement("div");
          row.className = "list-item row-between";
          row.innerHTML = `<span>${idx + 1}등</span><span class="badge-pink">+${Number(amt).toLocaleString()} P</span>`;
          rewardsWrap.appendChild(row);
        });
      }

      if (lbWrap) {
        lbWrap.innerHTML = "";
        const list = lb.leaderboard || [];
        if (!list.length) {
          lbWrap.innerHTML = `<p class="muted small">오늘(${lb.day_kst}) 아직 클리어 기록이 없습니다. 첫 1등에 도전하세요!</p>`;
        } else {
          list.forEach((item) => {
            const row = document.createElement("div");
            row.className = "list-item row-between";
            const medal = item.rank === 1 ? "🥇" : item.rank === 2 ? "🥈" : item.rank === 3 ? "🥉" : `${item.rank}위`;
            row.innerHTML = `
              <div><strong>${medal} ${item.nickname}</strong><div class="muted small">${item.moves}회 시도</div></div>
              <div style="text-align:right"><strong>${formatMs(item.elapsed_ms)}</strong><div class="muted small">+${Number(item.reward).toLocaleString()}P 예정</div></div>
            `;
            lbWrap.appendChild(row);
          });
        }
      }

      if (yesterdayWrap) {
        yesterdayWrap.innerHTML = "";
        const winners = lb.yesterday_winners || [];
        if (!winners.length) {
          yesterdayWrap.innerHTML = `<p class="muted small">이전 정산 내역이 아직 없습니다.</p>`;
        } else {
          const head = document.createElement("div");
          head.className = "muted small";
          head.textContent = `정산일: ${lb.yesterday_day}`;
          yesterdayWrap.appendChild(head);
          winners.forEach((w) => {
            const row = document.createElement("div");
            row.className = "list-item row-between";
            row.innerHTML = `<span>${w.rank}위 ${w.nickname} (${formatMs(w.elapsed_ms)})</span><span class="badge-pink">+${Number(w.reward).toLocaleString()} P</span>`;
            yesterdayWrap.appendChild(row);
          });
        }
      }
    } catch (_) {}

    if (user && myBestEl) {
      try {
        const me = await ctx.api("/api/games/memory/me");
        if (me.my_best_today) {
          myBestEl.textContent = `${formatMs(me.my_best_today.elapsed_ms)} (${me.my_rank ? `${me.my_rank}위` : "순위권 외"})`;
        } else {
          myBestEl.textContent = "오늘 기록 없음";
        }
      } catch (_) {}
    } else if (myBestEl) {
      myBestEl.textContent = "-";
    }
  }

  async function initPage(gameCtx) {
    ctx = gameCtx;
    if (!bound) {
      bound = true;
      const startBtn = document.getElementById("memory-start-btn");
      if (startBtn) startBtn.addEventListener("click", startGame);
    }
    try {
      const data = await ctx.api("/api/games/memory/cards");
      cardsPool = data.cards || [];
    } catch (_) {}
    if (!playing && !deck.length) {
      const base8 = (cardsPool.length ? cardsPool : []).slice(0, 8);
      deck = [...base8, ...base8].map((c) => ({ ...c, flipped: false, matched: false }));
      renderBoard();
      updateHud(0);
    }
    await refreshStatsAndLeaderboard();
  }

  window.ChaeonMemory = { initPage };
})();
