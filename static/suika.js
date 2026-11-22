(() => {
  "use strict";

  const WIDTH = 400;
  const HEIGHT = 560;
  const WALL_PAD = 8;
  const FLOOR_Y = HEIGHT - 10;
  const DANGER_Y = 92;
  const DROP_Y = 44;
  const GRAVITY = 1280;
  const SUBSTEPS = 8;
  const DROP_COOLDOWN_MS = 450;

  const FRUITS = [
    { tier: 1, name: "체리", emoji: "🍒", r: 16, score: 2, color: "#fb7185", rim: "#be123c" },
    { tier: 2, name: "딸기", emoji: "🍓", r: 22, score: 4, color: "#f43f5e", rim: "#9f1239" },
    { tier: 3, name: "포도", emoji: "🍇", r: 28, score: 8, color: "#a855f7", rim: "#6b21a8" },
    { tier: 4, name: "한라봉", emoji: "🍊", r: 34, score: 14, color: "#fb923c", rim: "#c2410c" },
    { tier: 5, name: "오렌지", emoji: "🟠", r: 41, score: 22, color: "#f97316", rim: "#9a3412" },
    { tier: 6, name: "사과", emoji: "🍎", r: 49, score: 32, color: "#ef4444", rim: "#991b1b" },
    { tier: 7, name: "배", emoji: "🍐", r: 57, score: 45, color: "#a3e635", rim: "#4d7c0f" },
    { tier: 8, name: "복숭아", emoji: "🍑", r: 66, score: 60, color: "#fda4af", rim: "#e11d48" },
    { tier: 9, name: "파인애플", emoji: "🍍", r: 75, score: 80, color: "#facc15", rim: "#a16207" },
    { tier: 10, name: "멜론", emoji: "🍈", r: 85, score: 105, color: "#4ade80", rim: "#15803d" },
    { tier: 11, name: "수박", emoji: "🍉", r: 98, score: 150, color: "#16a34a", rim: "#14532d" },
  ];

  const game = {
    initialized: false,
    ctx: null,
    canvas: null,
    rafId: null,
    lastTs: 0,
    mode: "practice", // "practice" | "challenge"
    selectedStake: 100,
    activeRunId: null,
    activeStake: 0,
    startedAtMs: 0,
    running: false,
    gameOver: false,
    settling: false,
    score: 0,
    maxTier: 1,
    mergesCount: 0,
    fruits: [],
    particles: [],
    popups: [],
    nextId: 1,
    currentTier: 1,
    nextTier: 2,
    dropX: WIDTH / 2,
    lastDropMs: 0,
    dangerTimer: 0,
    pointerActive: false,
    nextCutPercent: 0,
    rules: {
      stakes: [100],
      tiers: [
        { min_score: 5000, base_reward: 10000, label: "5,000점 이상" },
        { min_score: 2000, base_reward: 3000, label: "2,000점 이상" },
        { min_score: 1000, base_reward: 1000, label: "1,000점 이상" },
      ],
      diminishing_cuts: [0, 50, 70, 90],
    },
    apiHelper: null,
    getUser: null,
    onPointsChanged: null,
    showToast: null,
  };

  function randomDropTier() {
    const weights = [30, 28, 20, 14, 8];
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i + 1;
    }
    return 1;
  }

  function fruitMeta(tier) {
    return FRUITS[Math.max(0, Math.min(FRUITS.length - 1, tier - 1))];
  }

  function clampDropX(x, tier) {
    const r = fruitMeta(tier).r;
    return Math.max(WALL_PAD + r + 2, Math.min(WIDTH - WALL_PAD - r - 2, x));
  }

  function resetBoardState() {
    game.fruits = [];
    game.particles = [];
    game.popups = [];
    game.score = 0;
    game.maxTier = 1;
    game.mergesCount = 0;
    game.dangerTimer = 0;
    game.gameOver = false;
    game.settling = false;
    game.currentTier = randomDropTier();
    game.nextTier = randomDropTier();
    game.dropX = WIDTH / 2;
    game.lastDropMs = 0;
    game.startedAtMs = Date.now();
    hideOverlay();
    updateHud();
  }

  function startPracticeGame() {
    if (game.activeRunId) {
      if (game.showToast) game.showToast("진행 중인 포인트 도전이 있어 먼저 종료하거나 정산해 주세요.");
      return;
    }
    game.mode = "practice";
    game.running = true;
    resetBoardState();
    renderModeControls();
  }

  function spawnParticles(x, y, color, count = 12) {
    for (let i = 0; i < count; i++) {
      const ang = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const spd = 70 + Math.random() * 140;
      game.particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 30,
        r: 3 + Math.random() * 4,
        color,
        life: 0.45 + Math.random() * 0.25,
        maxLife: 0.7,
      });
    }
  }

  function spawnPopup(x, y, text, color = "#db2777") {
    game.popups.push({ x, y, text, color, life: 0.9, maxLife: 0.9 });
  }

  function dropCurrentFruit() {
    if (!game.running || game.gameOver || game.settling) return;
    const now = performance.now();
    if (now - game.lastDropMs < DROP_COOLDOWN_MS) return;

    const meta = fruitMeta(game.currentTier);
    const x = clampDropX(game.dropX, game.currentTier);
    game.fruits.push({
      id: game.nextId++,
      tier: game.currentTier,
      r: meta.r,
      mass: meta.r * meta.r,
      x,
      y: DROP_Y,
      vx: (Math.random() - 0.5) * 6,
      vy: 30,
      angle: 0,
      angVel: 0,
      grace: 1.7,
      merged: false,
    });
    if (game.currentTier > game.maxTier) game.maxTier = game.currentTier;

    game.lastDropMs = now;
    game.currentTier = game.nextTier;
    game.nextTier = randomDropTier();
    game.dropX = clampDropX(game.dropX, game.currentTier);
    updateHud();
  }

  function stepPhysics(dt) {
    const subDt = dt / SUBSTEPS;
    const mergedPairs = [];

    for (let s = 0; s < SUBSTEPS; s++) {
      for (const f of game.fruits) {
        if (f.merged) continue;
        f.vy += GRAVITY * subDt;
        f.x += f.vx * subDt;
        f.y += f.vy * subDt;
        f.angle += f.angVel * subDt;

        // Gentle damping
        f.vx *= 0.999;
        f.angVel *= 0.992;

        // Walls & floor
        if (f.x - f.r < WALL_PAD) {
          f.x = WALL_PAD + f.r;
          f.vx = Math.abs(f.vx) * 0.25;
        } else if (f.x + f.r > WIDTH - WALL_PAD) {
          f.x = WIDTH - WALL_PAD - f.r;
          f.vx = -Math.abs(f.vx) * 0.25;
        }
        if (f.y + f.r > FLOOR_Y) {
          f.y = FLOOR_Y - f.r;
          f.vy = -Math.abs(f.vy) * 0.14;
          if (Math.abs(f.vy) < 12) f.vy = 0;
          f.vx *= 0.96;
          f.angVel = f.vx / Math.max(10, f.r);
        }
      }

      // Circle-circle collisions
      const n = game.fruits.length;
      for (let i = 0; i < n; i++) {
        const a = game.fruits[i];
        if (a.merged) continue;
        for (let j = i + 1; j < n; j++) {
          const b = game.fruits[j];
          if (b.merged) continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const minDist = a.r + b.r;
          const distSq = dx * dx + dy * dy;
          if (distSq >= minDist * minDist) continue;

          if (a.tier === b.tier) {
            a.merged = true;
            b.merged = true;
            mergedPairs.push([a, b]);
            continue;
          }

          const dist = Math.sqrt(distSq) || 0.001;
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = minDist - dist;

          const totalMass = a.mass + b.mass;
          const ratioA = b.mass / totalMass;
          const ratioB = a.mass / totalMass;
          const corr = overlap * 0.85;
          a.x -= nx * corr * ratioA;
          a.y -= ny * corr * ratioA;
          b.x += nx * corr * ratioB;
          b.y += ny * corr * ratioB;

          const rvx = b.vx - a.vx;
          const rvy = b.vy - a.vy;
          const velAlongNormal = rvx * nx + rvy * ny;
          if (velAlongNormal < 0) {
            const restitution = 0.16;
            const jImpulse = (-(1 + restitution) * velAlongNormal) / (1 / a.mass + 1 / b.mass);
            const ix = jImpulse * nx;
            const iy = jImpulse * ny;
            a.vx -= ix / a.mass;
            a.vy -= iy / a.mass;
            b.vx += ix / b.mass;
            b.vy += iy / b.mass;

            // Tangential spin
            const tx = -ny;
            const ty = nx;
            const vt = rvx * tx + rvy * ty;
            a.angVel -= (vt * 0.015) / Math.max(12, a.r);
            b.angVel += (vt * 0.015) / Math.max(12, b.r);
          }
        }
      }
    }

    if (mergedPairs.length > 0) {
      game.fruits = game.fruits.filter((f) => !f.merged);
      for (const [a, b] of mergedPairs) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        game.mergesCount += 1;

        if (a.tier >= 11) {
          // Two watermelons pop!
          const bonus = 250;
          game.score += bonus;
          spawnParticles(mx, my, "#16a34a", 24);
          spawnPopup(mx, my, `🍉 수박 폭발! +${bonus}`, "#16a34a");
        } else {
          const newTier = a.tier + 1;
          const meta = fruitMeta(newTier);
          game.score += meta.score;
          if (newTier > game.maxTier) game.maxTier = newTier;
          const cx = Math.max(WALL_PAD + meta.r, Math.min(WIDTH - WALL_PAD - meta.r, mx));
          const cy = Math.min(FLOOR_Y - meta.r, my);
          game.fruits.push({
            id: game.nextId++,
            tier: newTier,
            r: meta.r,
            mass: meta.r * meta.r,
            x: cx,
            y: cy,
            vx: (a.vx + b.vx) * 0.35,
            vy: Math.min(0, (a.vy + b.vy) * 0.35) - 45,
            angle: 0,
            angVel: 0,
            grace: 0.9,
            merged: false,
          });
          spawnParticles(cx, cy, meta.color, 12);
          spawnPopup(cx, cy - 10, `+${meta.score}`, meta.rim);
        }
      }
      updateHud();
    }

    // Update grace & check danger line
    let anyDanger = false;
    for (const f of game.fruits) {
      if (f.grace > 0) {
        f.grace = Math.max(0, f.grace - dt);
      } else if (f.y - f.r < DANGER_Y) {
        anyDanger = true;
      }
    }

    if (anyDanger) {
      game.dangerTimer += dt;
      if (game.dangerTimer >= 1.55) {
        triggerGameOver();
      }
    } else {
      game.dangerTimer = Math.max(0, game.dangerTimer - dt * 2);
    }

    // Update particles & popups
    for (const p of game.particles) {
      p.vy += 320 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    game.particles = game.particles.filter((p) => p.life > 0);

    for (const pop of game.popups) {
      pop.y -= 38 * dt;
      pop.life -= dt;
    }
    game.popups = game.popups.filter((pop) => pop.life > 0);
  }

  function drawFruit(ctx, x, y, r, tier, angle = 0) {
    const meta = fruitMeta(tier);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Body gradient
    const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.22, meta.color);
    grad.addColorStop(1, meta.rim);

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.stroke();

    // Watermelon stripes
    if (tier === 11) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r - 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = "rgba(20, 83, 45, 0.45)";
      ctx.lineWidth = 7;
      for (let k = -2; k <= 2; k++) {
        ctx.beginPath();
        ctx.arc(k * 28, 0, r * 0.9, -1.1, 1.1);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Glossy highlight
    ctx.beginPath();
    ctx.ellipse(-r * 0.32, -r * 0.34, r * 0.22, r * 0.12, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fill();

    // Emoji badge / cute face
    if (r >= 20) {
      ctx.font = `${Math.round(r * 0.92)}px "Apple Color Emoji","Segoe UI Emoji",sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(meta.emoji, 0, 2);
    } else {
      ctx.font = `${Math.round(r * 1.15)}px "Apple Color Emoji","Segoe UI Emoji",sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(meta.emoji, 0, 1);
    }

    ctx.restore();
  }

  function render() {
    const ctx = game.ctx;
    if (!ctx) return;

    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // Background container
    const bgGrad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    bgGrad.addColorStop(0, "#fff5f9");
    bgGrad.addColorStop(1, "#ffe4ef");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Side walls & floor
    ctx.fillStyle = "#fbcfe8";
    ctx.fillRect(0, 0, WALL_PAD, HEIGHT);
    ctx.fillRect(WIDTH - WALL_PAD, 0, WALL_PAD, HEIGHT);
    ctx.fillRect(0, FLOOR_Y, WIDTH, HEIGHT - FLOOR_Y);

    // Danger line
    const dangerRatio = Math.min(1, game.dangerTimer / 1.55);
    ctx.save();
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = dangerRatio > 0 ? 3 : 2;
    ctx.strokeStyle = dangerRatio > 0 ? `rgba(225, 29, 72, ${0.55 + 0.45 * Math.sin(performance.now() * 0.018)})` : "rgba(236, 72, 153, 0.35)";
    ctx.beginPath();
    ctx.moveTo(WALL_PAD, DANGER_Y);
    ctx.lineTo(WIDTH - WALL_PAD, DANGER_Y);
    ctx.stroke();
    ctx.restore();

    // Drop guide & preview fruit
    if (game.running && !game.gameOver) {
      const x = clampDropX(game.dropX, game.currentTier);
      const canDrop = performance.now() - game.lastDropMs >= DROP_COOLDOWN_MS;
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = "rgba(219, 39, 119, 0.28)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, DROP_Y);
      ctx.lineTo(x, FLOOR_Y);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = canDrop ? 1 : 0.45;
      drawFruit(ctx, x, DROP_Y, fruitMeta(game.currentTier).r, game.currentTier, 0);
      ctx.restore();
    }

    // Fruits
    for (const f of game.fruits) {
      drawFruit(ctx, f.x, f.y, f.r, f.tier, f.angle);
    }

    // Particles
    for (const p of game.particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Score popups
    for (const pop of game.popups) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, pop.life / pop.maxLife);
      ctx.font = "800 15px Pretendard, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = pop.color;
      ctx.fillText(pop.text, pop.x, pop.y);
      ctx.restore();
    }
  }

  function loop(ts) {
    if (!game.lastTs) game.lastTs = ts;
    const dt = Math.min(0.035, Math.max(0.001, (ts - game.lastTs) / 1000));
    game.lastTs = ts;

    if (game.running && !game.gameOver) {
      stepPhysics(dt);
    }
    render();
    game.rafId = requestAnimationFrame(loop);
  }

  function showOverlay(title, desc, primaryText, onPrimary) {
    const box = document.getElementById("suika-overlay");
    if (!box) return;
    document.getElementById("suika-overlay-title").textContent = title;
    document.getElementById("suika-overlay-desc").textContent = desc;
    const btn = document.getElementById("suika-overlay-btn");
    btn.textContent = primaryText;
    btn.onclick = onPrimary;
    box.classList.remove("hidden");
  }

  function hideOverlay() {
    const box = document.getElementById("suika-overlay");
    if (box) box.classList.add("hidden");
  }

  async function triggerGameOver(manualCashout = false) {
    if (game.gameOver || game.settling) return;
    game.gameOver = true;
    game.running = false;

    const finalScore = game.score;
    const durationSec = Math.max(1, Math.round((Date.now() - game.startedAtMs) / 1000));

    if (game.mode === "challenge" && game.activeRunId && game.apiHelper) {
      game.settling = true;
      showOverlay("⏳ 결과 정산 중...", `최종 점수 ${finalScore.toLocaleString()}점을 서버에서 정산하고 있습니다.`, "잠시만요...", () => {});
      try {
        const res = await game.apiHelper("/api/games/suika/finish", {
          method: "POST",
          body: {
            run_id: game.activeRunId,
            score: finalScore,
            max_tier: game.maxTier,
            merges_count: game.mergesCount,
            duration_sec: durationSec,
          },
        });
        game.activeRunId = null;
        game.activeStake = 0;
        if (typeof res.next_cut_percent === "number") game.nextCutPercent = res.next_cut_percent;
        if (game.onPointsChanged) game.onPointsChanged(res.points);
        const net = res.net;
        const cutNote = res.cut_percent > 0 ? ` (-${res.cut_percent}% 차감 적용)` : "";
        const msg =
          res.reward > 0
            ? `🎉 목표 달성! ${res.reward.toLocaleString()} P 획득${cutNote} (순수익 ${net >= 0 ? "+" : ""}${net.toLocaleString()} P)`
            : `아쉽게도 1,000점 미달성으로 참가비(${res.stake.toLocaleString()} P)를 잃었습니다.`;
        showOverlay(
          manualCashout ? "✅ 정산 완료!" : "🍉 게임 오버!",
          `최종 점수 ${finalScore.toLocaleString()}점 · ${msg}`,
          "다시 도전하기",
          () => startChallengeGame(false)
        );
        await refreshStatsAndLeaderboard();
      } catch (err) {
        showOverlay("정산 오류", err.message || "정산 중 오류가 발생했습니다.", "연습 모드로 전환", startPracticeGame);
      } finally {
        game.settling = false;
        renderModeControls();
      }
      return;
    }

    showOverlay(
      "🍉 연습 게임 종료!",
      `최종 점수 ${finalScore.toLocaleString()}점 (최고 과일: ${fruitMeta(game.maxTier).emoji} ${fruitMeta(game.maxTier).name})`,
      "다시 연습하기",
      startPracticeGame
    );
    renderModeControls();
  }

  async function startChallengeGame(forfeitExisting = false) {
    const user = game.getUser ? game.getUser() : null;
    if (!user) {
      if (game.showToast) game.showToast("포인트 도전 모드는 로그인 후 이용할 수 있습니다.");
      return;
    }
    try {
      const res = await game.apiHelper("/api/games/suika/start", {
        method: "POST",
        body: { stake: game.selectedStake, forfeit_existing: forfeitExisting },
      });
      game.mode = "challenge";
      game.activeRunId = res.run_id;
      game.activeStake = res.stake;
      game.running = true;
      if (game.onPointsChanged) game.onPointsChanged(res.points);
      resetBoardState();
      renderModeControls();
      if (game.showToast) game.showToast(`${res.stake.toLocaleString()}P 도전 시작! 1,000점 이상 달성해 보세요.`);
      await refreshStatsAndLeaderboard();
    } catch (err) {
      if (err.message && err.message.includes("진행 중인 수박게임 도전")) {
        if (window.confirm("이미 진행 중인 포인트 도전이 있습니다. 기존 도전을 포기하고 새로 시작할까요? (기존 참가비는 반환되지 않습니다)")) {
          await startChallengeGame(true);
        }
      } else if (game.showToast) {
        game.showToast(err.message);
      }
    }
  }

  async function forfeitActiveRun() {
    if (!game.activeRunId || !game.apiHelper) return;
    if (!window.confirm("정말 현재 포인트 도전을 포기할까요? 참가비는 반환되지 않습니다.")) return;
    try {
      await game.apiHelper("/api/games/suika/forfeit", {
        method: "POST",
        body: { run_id: game.activeRunId },
      });
      game.activeRunId = null;
      game.activeStake = 0;
      game.running = false;
      game.gameOver = true;
      if (game.showToast) game.showToast("도전을 포기했습니다.");
      startPracticeGame();
      await refreshStatsAndLeaderboard();
    } catch (err) {
      if (game.showToast) game.showToast(err.message);
    }
  }

  function updateHud() {
    const scoreEl = document.getElementById("suika-score");
    const nextEl = document.getElementById("suika-next");
    const targetEl = document.getElementById("suika-target-status");
    const cashoutBtn = document.getElementById("suika-cashout-btn");
    if (scoreEl) scoreEl.textContent = game.score.toLocaleString();
    if (nextEl) {
      const nm = fruitMeta(game.nextTier);
      nextEl.textContent = `${nm.emoji} ${nm.name}`;
    }
    if (targetEl) {
      if (game.mode === "challenge" && game.activeRunId) {
        let base = 0;
        if (game.score >= 5000) base = 10000;
        else if (game.score >= 2000) base = 3000;
        else if (game.score >= 1000) base = 1000;
        const est = Math.round((base * (100 - game.nextCutPercent)) / 100);
        targetEl.textContent =
          est > 0
            ? `🔥 현재 예상 보상: ${est.toLocaleString()} P${game.nextCutPercent > 0 ? ` (-${game.nextCutPercent}%)` : ""}`
            : `목표 1,000점까지 ${Math.max(0, 1000 - game.score).toLocaleString()}점 남음`;
      } else {
        targetEl.textContent = "무료 연습 모드 (포인트 미사용)";
      }
    }
    if (cashoutBtn) {
      const canCashout = game.mode === "challenge" && game.activeRunId && game.running && !game.gameOver && game.score >= 1000;
      cashoutBtn.classList.toggle("hidden", !canCashout);
    }
  }

  function renderModeControls() {
    const user = game.getUser ? game.getUser() : null;
    const ptsEl = document.getElementById("suika-my-points");
    if (ptsEl) ptsEl.textContent = user ? `보유: ${user.points.toLocaleString()} P` : "로그인 필요";

    document.querySelectorAll(".suika-stake-btn").forEach((btn) => {
      const val = Number(btn.dataset.stake);
      btn.classList.toggle("active", val === game.selectedStake);
    });

    const rateBadge = document.getElementById("suika-next-rate-badge");
    if (rateBadge) {
      rateBadge.textContent =
        game.nextCutPercent === 0
          ? "첫 보상 100% 적용"
          : `다음 보상 -${game.nextCutPercent}% (${100 - game.nextCutPercent}% 지급)`;
    }

    document.querySelectorAll("#suika-reward-table [data-base]").forEach((badge) => {
      const base = Number(badge.dataset.base || 0);
      const actual = Math.round((base * (100 - game.nextCutPercent)) / 100);
      badge.textContent =
        game.nextCutPercent > 0
          ? `${actual.toLocaleString()} P (기본 ${base.toLocaleString()}P)`
          : `${base.toLocaleString()} P`;
    });

    const startChallengeBtn = document.getElementById("suika-start-challenge-btn");
    const practiceBtn = document.getElementById("suika-practice-btn");
    const forfeitBtn = document.getElementById("suika-forfeit-btn");
    if (startChallengeBtn) {
      startChallengeBtn.disabled = Boolean(game.activeRunId);
      startChallengeBtn.textContent = game.activeRunId
        ? `도전 진행 중 (${game.activeStake}P)`
        : `🔥 ${game.selectedStake}P 걸고 도전`;
    }
    if (practiceBtn) {
      practiceBtn.classList.toggle("active", game.mode === "practice");
    }
    if (forfeitBtn) {
      forfeitBtn.classList.toggle("hidden", !game.activeRunId);
    }
    updateHud();
  }

  async function refreshStatsAndLeaderboard() {
    if (!game.apiHelper) return;
    try {
      const lb = await game.apiHelper("/api/games/suika/leaderboard");
      if (lb.rules) game.rules = lb.rules;
      const lbEl = document.getElementById("suika-leaderboard");
      if (lbEl) {
        lbEl.innerHTML = "";
        if (!lb.leaderboard || lb.leaderboard.length === 0) {
          lbEl.innerHTML = '<div class="muted small">아직 포인트 도전 기록이 없습니다. 첫 1등에 도전해보세요!</div>';
        } else {
          lb.leaderboard.forEach((row, idx) => {
            const fm = fruitMeta(row.best_tier || 1);
            const item = document.createElement("div");
            item.className = "list-item row-between";
            const left = document.createElement("div");
            left.innerHTML = `<strong>${idx + 1}. ${escapeHtml(row.nickname)}</strong> <span class="muted small">(${fm.emoji} ${fm.name})</span>`;
            const right = document.createElement("span");
            right.className = "badge-pink";
            right.textContent = `${Number(row.best_score).toLocaleString()}점`;
            item.appendChild(left);
            item.appendChild(right);
            lbEl.appendChild(item);
          });
        }
      }

      const user = game.getUser ? game.getUser() : null;
      const recentEl = document.getElementById("suika-my-history");
      const bestEl = document.getElementById("suika-my-best");
      if (!user) {
        if (bestEl) bestEl.textContent = "-";
        if (recentEl) recentEl.innerHTML = '<div class="muted small">로그인하면 내 도전 기록을 확인할 수 있습니다.</div>';
        return;
      }

      const me = await game.apiHelper("/api/games/suika/me");
      game.nextCutPercent = Number(me.next_cut_percent || 0);
      if (bestEl) bestEl.textContent = `${Number(me.best_score || 0).toLocaleString()}점`;
      if (me.active_run && !game.activeRunId) {
        game.activeRunId = me.active_run.id;
        game.activeStake = me.active_run.stake;
        game.mode = "challenge";
        game.running = true;
        resetBoardState();
      }
      if (recentEl) {
        recentEl.innerHTML = "";
        if (!me.recent_runs || me.recent_runs.length === 0) {
          recentEl.innerHTML = '<div class="muted small">아직 도전 기록이 없습니다.</div>';
        } else {
          me.recent_runs.forEach((r) => {
            const item = document.createElement("div");
            item.className = "list-item row-between";
            const statusText = r.status === "forfeited" ? "포기" : `${Number(r.score).toLocaleString()}점`;
            const left = document.createElement("div");
            left.innerHTML = `<strong>${statusText}</strong> <span class="muted small">· 참가비 ${Number(r.stake).toLocaleString()}P</span>`;
            const right = document.createElement("span");
            right.className = r.reward > 0 ? "badge-pink" : "muted small";
            right.textContent = r.reward > 0 ? `+${Number(r.reward).toLocaleString()}P` : "0P";
            item.appendChild(left);
            item.appendChild(right);
            recentEl.appendChild(item);
          });
        }
      }
      renderModeControls();
    } catch (_) {
      // Ignore transient load error
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setupCanvasEvents(canvas) {
    const updateX = (clientX) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * WIDTH;
      game.dropX = clampDropX(x, game.currentTier);
    };

    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      game.pointerActive = true;
      updateX(e.clientX);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" || game.pointerActive) {
        updateX(e.clientX);
      }
    });
    window.addEventListener("pointerup", (e) => {
      if (!game.pointerActive) return;
      game.pointerActive = false;
      if (e.target === canvas || canvas.contains(e.target)) {
        updateX(e.clientX);
        dropCurrentFruit();
      }
    });

    window.addEventListener("keydown", (e) => {
      const page = document.getElementById("page-game");
      if (!page || !page.classList.contains("active")) return;
      if (!game.running || game.gameOver) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        game.dropX = clampDropX(game.dropX - 18, game.currentTier);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        game.dropX = clampDropX(game.dropX + 18, game.currentTier);
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        dropCurrentFruit();
      }
    });
  }

  function renderEvolutionStrip() {
    const strip = document.getElementById("suika-evo-strip");
    if (!strip) return;
    strip.innerHTML = FRUITS.map((f) => `<span class="suika-evo-chip" title="${f.name} (+${f.score}점)">${f.emoji} ${f.name}</span>`).join("");
  }

  function initPage({ api, getUser, onPointsChanged, showToast }) {
    game.apiHelper = api;
    game.getUser = getUser;
    game.onPointsChanged = onPointsChanged;
    game.showToast = showToast;

    if (!game.initialized) {
      game.initialized = true;
      const canvas = document.getElementById("suika-canvas");
      if (!canvas) return;
      game.canvas = canvas;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = WIDTH * dpr;
      canvas.height = HEIGHT * dpr;
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);
      game.ctx = ctx;

      setupCanvasEvents(canvas);
      renderEvolutionStrip();

      document.querySelectorAll(".suika-stake-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          game.selectedStake = Number(btn.dataset.stake);
          renderModeControls();
        });
      });

      const practiceBtn = document.getElementById("suika-practice-btn");
      if (practiceBtn) practiceBtn.addEventListener("click", startPracticeGame);

      const startBtn = document.getElementById("suika-start-challenge-btn");
      if (startBtn) startBtn.addEventListener("click", () => startChallengeGame(false));

      const forfeitBtn = document.getElementById("suika-forfeit-btn");
      if (forfeitBtn) forfeitBtn.addEventListener("click", forfeitActiveRun);

      const cashoutBtn = document.getElementById("suika-cashout-btn");
      if (cashoutBtn) cashoutBtn.addEventListener("click", () => triggerGameOver(true));

      startPracticeGame();
      game.rafId = requestAnimationFrame(loop);
    }

    renderModeControls();
    refreshStatsAndLeaderboard();
  }

  window.ChaeonSuika = { initPage };
})();
