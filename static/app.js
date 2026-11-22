(() => {
  const state = {
    user: null,
    csrfToken: null,
    page: "home",
    boardTab: "all",
    boardSort: "latest",
    noticeSubTab: "soop",
    noticePage: 1,
    ledgerPage: 1,
    sigCategory: "all",
    sigSort: "asc",
    sigKeyword: "",
    allSignatures: [],
    calYear: 2026,
    calMonth: 11, // 1-12
    streamStatus: null,
  };

  const TAB_LABELS = {
    notice: "공지",
    free: "자유",
    fanart: "팬아트",
    clip: "클립",
    qna: "질문/건의",
    emoticon: "이모티콘",
  };

  const CAL_CAT_LABELS = {
    live: "정규방송",
    collab: "합방",
    event: "이벤트",
    rest: "휴방",
  };

  // Safe DOM helper (never uses innerHTML for untrusted text)
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "className") node.className = v;
      else if (k === "textContent") node.textContent = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === undefined || v === null || v === false) {
        continue;
      } else if (v === true) {
        node.setAttribute(k, "");
      } else {
        node.setAttribute(k, v);
      }
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.add("hidden"), 2800);
  }

  async function api(url, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && state.csrfToken) {
      headers["X-CSRF-Token"] = state.csrfToken;
    }
    const res = await fetch(url, {
      ...options,
      method,
      headers,
      credentials: "same-origin",
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || "요청 처리 중 오류가 발생했습니다.");
    }
    return data;
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
    const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().slice(0, 16).replace("T", " ");
  }

  // Modal helpers
  function openModal(title, contentNode) {
    document.getElementById("modal-title").textContent = title;
    const body = document.getElementById("modal-body");
    clear(body);
    body.appendChild(contentNode);
    document.getElementById("modal-backdrop").classList.remove("hidden");
  }

  function closeModal() {
    document.getElementById("modal-backdrop").classList.add("hidden");
    const params = new URLSearchParams(window.location.search);
    if (params.has("post")) {
      history.replaceState(null, "", window.location.pathname);
    }
  }

  // Auth & Header UI
  async function refreshMe() {
    const data = await api("/api/auth/me");
    state.user = data.user;
    state.csrfToken = data.csrf_token;
    renderAuthArea();
    renderHomeUserBox();
    renderSoopLinkSection();
  }

  function renderAuthArea() {
    const area = document.getElementById("auth-area");
    const adminBtn = document.getElementById("nav-admin-btn");
    const noticeWriteBtn = document.getElementById("notice-write-btn");
    clear(area);

    if (state.user) {
      area.appendChild(
        el("button", {
          type: "button",
          className: "user-chip",
          textContent: `👤 ${state.user.nickname} · ${state.user.points.toLocaleString()}P`,
          title: "내 프로필 및 작성 글/댓글 보기",
          onClick: openMyProfileModal,
        })
      );
      area.appendChild(
        el("button", {
          className: "btn btn-outline btn-sm",
          textContent: "로그아웃",
          onClick: async () => {
            await api("/api/auth/logout", { method: "POST" });
            state.user = null;
            state.csrfToken = null;
            showToast("로그아웃되었습니다.");
            renderAuthArea();
            renderHomeUserBox();
            renderSoopLinkSection();
            if (state.page === "admin") switchPage("home");
          },
        })
      );
      const isAdmin = state.user.role === "admin" || state.user.role === "staff";
      adminBtn.classList.toggle("hidden", !isAdmin);
      noticeWriteBtn.classList.toggle("hidden", !isAdmin);
    } else {
      adminBtn.classList.add("hidden");
      noticeWriteBtn.classList.add("hidden");
      area.appendChild(
        el("button", {
          className: "btn btn-outline btn-sm",
          textContent: "로그인",
          onClick: showLoginModal,
        })
      );
      area.appendChild(
        el("button", {
          className: "btn btn-pink btn-sm",
          textContent: "회원가입",
          onClick: showRegisterModal,
        })
      );
    }
  }

  function renderHomeUserBox() {
    const ptsEl = document.getElementById("home-points");
    const soopEl = document.getElementById("home-soop-status");
    const shopPtsEl = document.getElementById("shop-my-points");
    if (state.user) {
      ptsEl.textContent = `${state.user.points.toLocaleString()} P`;
      shopPtsEl.textContent = `보유: ${state.user.points.toLocaleString()} P`;
      soopEl.textContent = state.user.soop_verified
        ? `SOOP 연동됨 (${state.user.soop_id})`
        : "SOOP 미연동 (포인트 탭에서 연동)";
    } else {
      ptsEl.textContent = "- P";
      shopPtsEl.textContent = "보유: - P";
      soopEl.textContent = "로그인 후 출석/연동 가능";
    }
  }

  async function openMyProfileModal() {
    if (!state.user) return;
    try {
      const data = await api("/api/me/activity");
      const u = data.user;
      const myPosts = data.posts || [];
      const myComments = data.comments || [];
      const ROLE_LABEL = { admin: "방송인(주인)", staff: "관리자(매니저)", user: "일반팬" };

      const summaryCard = el("div", { className: "info-box" }, [
        el("div", { className: "row-gap", style: "justify-content:space-between" }, [
          el("strong", { style: "font-size:1.05rem", textContent: `${u.nickname} (${u.username})` }),
          el("span", { className: "badge-pink", textContent: ROLE_LABEL[u.role] || u.role }),
        ]),
        el("div", { className: "row-gap mt-12", style: "justify-content:space-between" }, [
          el("span", { textContent: `보유 포인트: ${u.points.toLocaleString()} P`, style: "font-weight:800; color:#db2777" }),
          el("span", { className: "muted small", textContent: `SOOP 연동: ${u.soop_verified ? u.soop_id : "미연동"}` }),
        ]),
      ]);

      const postsWrap = el("div", { className: "list-stack mt-12" });
      if (!myPosts.length) {
        postsWrap.appendChild(el("p", { className: "muted small", textContent: "아직 작성한 게시글이 없습니다." }));
      } else {
        myPosts.forEach((p) => {
          postsWrap.appendChild(
            el("div", {
              className: "list-item",
              style: "cursor:pointer",
              onClick: () => openPostDetail(p.id),
            }, [
              el("div", {}, [
                el("span", { className: "badge-pink", textContent: TAB_LABELS[p.tab] || p.tab }),
                p.is_anonymous ? el("span", { className: "badge-pink", textContent: "익명" }) : null,
                el("strong", { textContent: ` ${p.title}` }),
                el("div", { className: "muted small", textContent: `추천 ${p.like_count} · 댓글 ${p.comment_count} · 조회 ${p.views}` }),
              ]),
              el("span", { className: "muted small", textContent: formatDate(p.created_at).slice(0, 10) }),
            ])
          );
        });
      }

      const commentsWrap = el("div", { className: "list-stack mt-12 hidden" });
      if (!myComments.length) {
        commentsWrap.appendChild(el("p", { className: "muted small", textContent: "아직 작성한 댓글이 없습니다." }));
      } else {
        myComments.forEach((c) => {
          commentsWrap.appendChild(
            el("div", {
              className: "list-item",
              style: "cursor:pointer",
              onClick: () => openPostDetail(c.post_id),
            }, [
              el("div", {}, [
                el("strong", { textContent: c.content }),
                el("div", { className: "muted small", textContent: `원글: ${c.post_title}` }),
              ]),
              el("span", { className: "muted small", textContent: formatDate(c.created_at).slice(0, 10) }),
            ])
          );
        });
      }

      const btnPosts = el("button", { type: "button", className: "pill active", textContent: `📝 내가 쓴 글 (${myPosts.length})` });
      const btnComments = el("button", { type: "button", className: "pill", textContent: `💬 내가 쓴 댓글 (${myComments.length})` });

      btnPosts.addEventListener("click", () => {
        btnPosts.classList.add("active");
        btnComments.classList.remove("active");
        postsWrap.classList.remove("hidden");
        commentsWrap.classList.add("hidden");
      });
      btnComments.addEventListener("click", () => {
        btnComments.classList.add("active");
        btnPosts.classList.remove("active");
        commentsWrap.classList.remove("hidden");
        postsWrap.classList.add("hidden");
      });

      const body = el("div", {}, [
        summaryCard,
        el("div", { className: "tab-pills mt-12" }, [btnPosts, btnComments]),
        postsWrap,
        commentsWrap,
      ]);
      openModal("내 프로필 & 활동 내역", body);
    } catch (err) {
      showToast(err.message);
    }
  }

  function isStaffOrAdmin() {
    return Boolean(state.user && (state.user.role === "admin" || state.user.role === "staff"));
  }

  function showLoginModal() {
    const userInput = el("input", { type: "text", required: "true", placeholder: "아이디 입력" });
    const pwInput = el("input", { type: "password", required: "true", placeholder: "비밀번호 입력" });
    const form = el("form", { className: "form-stack" }, [
      el("label", {}, ["아이디", userInput]),
      el("label", {}, ["비밀번호", pwInput]),
      el("button", { type: "submit", className: "btn btn-pink", textContent: "로그인" }),
    ]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const res = await api("/api/auth/login", {
          method: "POST",
          body: { username: userInput.value, password: pwInput.value },
        });
        state.user = res.user;
        state.csrfToken = res.csrf_token;
        closeModal();
        showToast(`${res.user.nickname}님 환영합니다!`);
        renderAuthArea();
        renderHomeUserBox();
        loadPointsPage();
      } catch (err) {
        showToast(err.message);
      }
    });
    openModal("로그인", form);
  }

  function showRegisterModal() {
    const userInput = el("input", { type: "text", required: "true", placeholder: "영문/숫자/_ 3~24자" });
    const nickInput = el("input", { type: "text", required: "true", placeholder: "사이트에서 쓸 닉네임" });
    const pwInput = el("input", { type: "password", required: "true", placeholder: "8자 이상 비밀번호" });
    const form = el("form", { className: "form-stack" }, [
      el("label", {}, ["아이디", userInput]),
      el("label", {}, ["닉네임", nickInput]),
      el("label", {}, ["비밀번호 (8자 이상)", pwInput]),
      el("button", { type: "submit", className: "btn btn-pink", textContent: "가입하기 (+2000P)" }),
    ]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const res = await api("/api/auth/register", {
          method: "POST",
          body: { username: userInput.value, nickname: nickInput.value, password: pwInput.value },
        });
        state.user = res.user;
        state.csrfToken = res.csrf_token;
        closeModal();
        showToast("회원가입 완료! 환영 포인트 2,000P가 지급되었습니다.");
        renderAuthArea();
        renderHomeUserBox();
        loadPointsPage();
      } catch (err) {
        showToast(err.message);
      }
    });
    openModal("회원가입", form);
  }

  // Navigation
  function switchPage(pageName, pushUrl = true) {
    state.page = pageName;
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${pageName}`));
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.page === pageName));

    if (pushUrl) {
      const targetUrl = pageName === "home" ? "/" : `/${pageName}`;
      if (window.location.pathname + window.location.search !== targetUrl) {
        history.pushState({ page: pageName }, "", targetUrl);
      }
    }

    if (pageName === "home") loadHome();
    else if (pageName === "notice") loadNotices();
    else if (pageName === "board") loadBoard();
    else if (pageName === "signatures") loadSignatures();
    else if (pageName === "emoticons") loadEmoticonsPage();
    else if (pageName === "calendar") loadCalendar();
    else if (pageName === "points") loadPointsPage();
    else if (pageName === "game") loadGamePage();
    else if (pageName === "gift") loadGiftPage();
    else if (pageName === "admin") loadAdminPage();
  }

  // Home
  async function loadHome() {
    const [stream, notices, cal, vodsRes] = await Promise.all([
      api("/api/stream/status"),
      api("/api/soop/notices"),
      api(`/api/calendar?month=${state.calYear}-${String(state.calMonth).padStart(2, "0")}`),
      api("/api/soop/vods"),
    ]);
    const liveLink = document.getElementById("home-live-link");
    const liveText = document.getElementById("home-live-text");
    if (liveLink && liveText) {
      const isLive = Boolean(stream.is_live);
      liveLink.classList.toggle("on", isLive);
      liveLink.href = stream.live_url || "https://www.sooplive.com/station/leeso0403";
      liveText.textContent = isLive
        ? `LIVE 방송 중 · ${stream.title} (${(stream.viewers || 0).toLocaleString()}명 시청) ↗`
        : `OFFLINE · 체온 SOOP 방송국 바로가기 ↗`;
    }

    const noticeWrap = document.getElementById("home-notices");
    clear(noticeWrap);
    const soopNotices = notices.posts || [];
    if (!soopNotices.length) {
      noticeWrap.appendChild(el("p", { className: "muted", textContent: "SOOP 공지사항이 없거나 불러오는 중입니다." }));
    } else {
      soopNotices.slice(0, 4).forEach((p) => {
        noticeWrap.appendChild(
          el(
            "div",
            {
              className: "list-item",
              style: "cursor:pointer",
              onClick: () => window.open(p.url, "_blank", "noopener,noreferrer"),
            },
            [
              el("div", { className: "row-gap", style: "flex:1; min-width:0" }, [
                p.thumbnail ? el("img", { className: "soop-thumb-sm", src: p.thumbnail, alt: p.title, loading: "lazy" }) : null,
                el("div", { style: "min-width:0" }, [
                  p.is_pinned ? el("span", { className: "badge-pink badge-pin", textContent: "공지" }) : null,
                  el("span", { textContent: ` ${p.title}`, style: "font-weight:700" }),
                ]),
              ]),
              el("span", { className: "muted small", textContent: `${(p.reg_date || "").slice(0, 10)} ↗` }),
            ]
          )
        );
      });
    }

    const evWrap = document.getElementById("home-events");
    clear(evWrap);
    const ym = `${state.calYear}-${String(state.calMonth).padStart(2, "0")}`;
    const evByDay = {};
    (cal.events || []).forEach((ev) => {
      const dNum = Number(ev.event_date.split("-")[2]);
      if (!evByDay[dNum]) evByDay[dNum] = [];
      evByDay[dNum].push(ev);
    });

    evWrap.appendChild(el("div", { className: "mini-cal-header", textContent: `${state.calYear}년 ${state.calMonth}월` }));
    evWrap.appendChild(
      el("div", { className: "mini-cal-weekdays" }, ["일", "월", "화", "수", "목", "금", "토"].map((w) => el("div", { textContent: w })))
    );

    const miniGrid = el("div", { className: "mini-cal-grid" });
    const firstWd = new Date(state.calYear, state.calMonth - 1, 1).getDay();
    const totalDays = new Date(state.calYear, state.calMonth, 0).getDate();
    const nowDate = new Date();
    const isCurMonth = nowDate.getFullYear() === state.calYear && nowDate.getMonth() + 1 === state.calMonth;
    const todayDay = nowDate.getDate();

    for (let i = 0; i < firstWd; i++) {
      miniGrid.appendChild(el("div", { className: "mini-cal-day empty" }));
    }
    for (let d = 1; d <= totalDays; d++) {
      const dayEvs = evByDay[d] || [];
      const dots = dayEvs.length
        ? el(
            "div",
            { className: "mini-cal-dots" },
            dayEvs.slice(0, 3).map((ev) => el("span", { className: "mini-cal-dot", style: `background:${ev.color || "#ec4899"}` }))
          )
        : null;
      miniGrid.appendChild(
        el(
          "div",
          {
            className: `mini-cal-day${isCurMonth && d === todayDay ? " today" : ""}`,
            title: dayEvs.map((ev) => `${ev.start_time} ${ev.title}`).join("\n") || `${ym}-${String(d).padStart(2, "0")}`,
            onClick: () => switchPage("calendar"),
          },
          [el("span", { textContent: String(d) }), dots]
        )
      );
    }
    evWrap.appendChild(miniGrid);

    (cal.events || []).slice(0, 3).forEach((ev) => {
      const evColor = ev.color || "#ec4899";
      evWrap.appendChild(
        el("div", { className: "list-item", style: `border-left: 4px solid ${evColor}` }, [
          el("div", {}, [
            el("span", {
              className: "badge-pink",
              style: `background:${evColor}; color:#fff`,
              textContent: CAL_CAT_LABELS[ev.category] || ev.category,
            }),
            el("strong", { textContent: ` ${ev.title}` }),
          ]),
          el("span", { className: "muted small", textContent: `${ev.event_date} ${ev.start_time}` }),
        ])
      );
    });

    const vodWrap = document.getElementById("home-vods");
    clear(vodWrap);
    const vods = vodsRes.vods || [];
    if (!vods.length) {
      vodWrap.appendChild(el("p", { className: "muted", textContent: "다시보기 영상을 불러오는 중이거나 등록된 영상이 없습니다." }));
    } else {
      vods.forEach((v) => {
        vodWrap.appendChild(
          el(
            "div",
            {
              className: "vod-card",
              onClick: () => window.open(v.url, "_blank", "noopener,noreferrer"),
            },
            [
              el("div", { className: "vod-thumb" }, [
                v.thumb ? el("img", { src: v.thumb, alt: v.title, loading: "lazy" }) : null,
                el("span", { className: "vod-play-badge", textContent: "▶ 다시보기" }),
              ]),
              el("div", { className: "vod-body" }, [
                el("div", { className: "vod-title", textContent: v.title, title: v.title }),
                el("div", { className: "muted small", textContent: `${(v.reg_date || "").slice(0, 10)}` }),
              ]),
            ]
          )
        );
      });
    }
  }

  // Posts (Notice & Board)
  function showEditPostModal(post) {
    const tabSelect = el("select", {}, [
      el("option", { value: "notice", textContent: "공지사항" }),
      el("option", { value: "free", textContent: "자유게시판" }),
      el("option", { value: "fanart", textContent: "팬아트" }),
      el("option", { value: "clip", textContent: "레전드 클립" }),
      el("option", { value: "qna", textContent: "질문/건의" }),
      el("option", { value: "emoticon", textContent: "이모티콘 게시판" }),
    ]);
    tabSelect.value = post.tab;
    const titleInput = el("input", { type: "text", required: "true", maxlength: "120", value: post.title });
    const contentInput = el("textarea", { rows: "6", required: "true", maxlength: "5000" });
    contentInput.value = post.content;
    const pinCheck = el("input", { type: "checkbox" });
    pinCheck.checked = Boolean(post.is_pinned);

    const form = el("form", { className: "form-stack" }, [
      el("label", {}, ["게시판", tabSelect]),
      el("label", {}, ["제목", titleInput]),
      el("label", {}, ["내용", contentInput]),
      el("label", { className: "checkbox-row" }, [pinCheck, "상단 고정"]),
      el("button", { type: "submit", className: "btn btn-pink", textContent: "수정 저장" }),
    ]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api(`/api/posts/${post.id}`, {
          method: "PUT",
          body: {
            tab: tabSelect.value,
            title: titleInput.value,
            content: contentInput.value,
            is_pinned: pinCheck.checked,
          },
        });
        closeModal();
        showToast("게시글이 수정되었습니다.");
        if (state.page === "notice") loadNotices();
        else if (state.page === "home") loadHome();
        else loadBoard();
      } catch (err) {
        showToast(err.message);
      }
    });
    openModal("게시글 수정", form);
  }

  function makeLikeButton(post, onToggled = null) {
    const btn = el("button", {
      type: "button",
      className: `btn btn-sm ${post.liked_by_me ? "btn-pink" : "btn-outline"}`,
      textContent: `💗 추천 ${post.like_count || 0}`,
      onClick: async (e) => {
        e.stopPropagation();
        if (!state.user) return showToast("로그인 후 추천할 수 있습니다.");
        try {
          const res = await api(`/api/posts/${post.id}/like`, { method: "POST" });
          post.liked_by_me = res.liked;
          post.like_count = res.like_count;
          btn.className = `btn btn-sm ${res.liked ? "btn-pink" : "btn-outline"}`;
          btn.textContent = `💗 추천 ${res.like_count}`;
          if (onToggled) onToggled(res);
        } catch (err) {
          showToast(err.message);
        }
      },
    });
    return btn;
  }

  function renderPostList(container, posts) {
    clear(container);
    if (!posts.length) {
      container.appendChild(el("p", { className: "muted", textContent: "등록된 게시글이 없습니다." }));
      return;
    }
    const adminMode = isStaffOrAdmin();
    posts.forEach((p) => {
      const badges = [];
      if (p.is_hidden) badges.push(el("span", { className: "badge-pink", style: "background:#f3f4f6; color:#374151", textContent: "🔒 비공개" }));
      if (p.is_pinned) badges.push(el("span", { className: "badge-pink badge-pin", textContent: "고정" }));
      badges.push(el("span", { className: "badge-pink", textContent: TAB_LABELS[p.tab] || p.tab }));

      const rightControls = el("div", { className: "row-gap" }, [
        el("span", {
          className: "post-meta",
          textContent: `${p.author_nickname} · ${formatDate(p.created_at).slice(0, 10)} · 조회 ${p.views}`,
        }),
        makeLikeButton(p),
      ]);
      if (adminMode) {
        rightControls.appendChild(
          el("button", {
            className: "btn btn-outline btn-sm",
            textContent: p.is_hidden ? "공개" : "비공개",
            onClick: async (e) => {
              e.stopPropagation();
              const res = await api(`/api/posts/${p.id}/hide`, { method: "POST" });
              showToast(res.is_hidden ? "게시글이 비공개 처리되었습니다." : "게시글이 공개되었습니다.");
              if (state.page === "notice") loadNotices();
              else loadBoard();
            },
          })
        );
        rightControls.appendChild(
          el("button", {
            className: "btn btn-outline btn-sm",
            textContent: "수정",
            onClick: (e) => {
              e.stopPropagation();
              showEditPostModal(p);
            },
          })
        );
        rightControls.appendChild(
          el("button", {
            className: "btn btn-danger btn-sm",
            textContent: "삭제",
            onClick: async (e) => {
              e.stopPropagation();
              await api(`/api/posts/${p.id}`, { method: "DELETE" });
              showToast("게시글이 삭제되었습니다.");
              if (state.page === "notice") loadNotices();
              else loadBoard();
            },
          })
        );
      }

      container.appendChild(
        el("div", { className: "post-row", onClick: () => openPostDetail(p.id) }, [
          el("div", { className: "post-title-wrap" }, [
            ...badges,
            el("span", { className: "post-title", textContent: p.title }),
            el("span", { className: "muted small", textContent: `[${p.comment_count || 0}]` }),
          ]),
          rightControls,
        ])
      );
    });
  }

  async function loadNotices() {
    const siteContainer = document.getElementById("site-notice-list");
    const soopContainer = document.getElementById("notice-list");
    const pagWrap = document.getElementById("notice-pagination");
    const isSoop = state.noticeSubTab === "soop";
    soopContainer.classList.toggle("hidden", !isSoop);
    pagWrap.classList.toggle("hidden", !isSoop);
    siteContainer.classList.toggle("hidden", isSoop);

    const q = (document.getElementById("notice-search-input")?.value || "").trim().toLowerCase();
    clear(siteContainer);
    clear(soopContainer);
    soopContainer.appendChild(el("p", { className: "muted", style: "padding:16px", textContent: "SOOP 공지사항을 불러오는 중..." }));

    try {
      const [siteData, soopData] = await Promise.all([
        api("/api/posts?tab=notice"),
        api(`/api/soop/notices?page=${state.noticePage}`),
      ]);
      const adminMode = isStaffOrAdmin();
      const sitePosts = (siteData.posts || []).filter(
        (p) => !q || p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q)
      );

      sitePosts.forEach((p, idx) => {
        const titleLine = el("div", { className: "nt-title-line" }, [
          el("span", { className: "post-title", textContent: p.title }),
          el("span", { className: "muted small", textContent: `[${p.comment_count || 0}]` }),
          makeLikeButton(p),
          adminMode
            ? el("button", {
                className: "btn btn-outline btn-sm",
                textContent: "수정",
                onClick: (e) => { e.stopPropagation(); showEditPostModal(p); },
              })
            : null,
          adminMode
            ? el("button", {
                className: "btn btn-danger btn-sm",
                textContent: "삭제",
                onClick: async (e) => {
                  e.stopPropagation();
                  await api(`/api/posts/${p.id}`, { method: "DELETE" });
                  showToast("공지가 삭제되었습니다.");
                  loadNotices();
                },
              })
            : null,
        ]);

        siteContainer.appendChild(
          el("div", { className: `notice-table-row${p.is_pinned ? " pinned" : ""}`, onClick: () => openPostDetail(p.id) }, [
            el("div", { className: "nt-col-badge" }, [
              el("span", {
                className: p.is_pinned ? "badge-pink badge-pin" : "badge-pink",
                textContent: p.is_pinned ? "공지" : String(sitePosts.length - idx),
              }),
            ]),
            el("div", { className: "nt-col-title" }, [titleLine]),
            el("div", { className: "nt-col-author", textContent: p.author_nickname }),
            el("div", { className: "nt-col-date", textContent: formatDate(p.created_at).slice(0, 10) }),
            el("div", { className: "nt-col-views", textContent: String(p.views) }),
          ])
        );
      });

      const soopPosts = (soopData.posts || []).filter(
        (p) => !q || p.title.toLowerCase().includes(q) || (p.preview || "").toLowerCase().includes(q)
      );
      clear(soopContainer);
      if (!soopPosts.length && !sitePosts.length) {
        soopContainer.appendChild(el("p", { className: "muted", style: "padding:16px", textContent: "검색된 공지사항이 없습니다." }));
        return;
      }
      soopPosts.forEach((p) => {
        const imgs = p.images || [];
        const thumbRow = imgs.length
          ? el(
              "div",
              { className: "soop-thumb-row" },
              imgs.slice(0, 3).map((src) =>
                el("img", { className: "soop-thumb-lg", src, alt: p.title, loading: "lazy" })
              )
            )
          : null;

        soopContainer.appendChild(
          el(
            "div",
            {
              className: `notice-table-row${p.is_pinned ? " pinned" : ""}`,
              onClick: () => window.open(p.url, "_blank", "noopener,noreferrer"),
            },
            [
              el("div", { className: "nt-col-badge" }, [
                el("span", { className: "badge-pink", textContent: "SOOP" }),
              ]),
              el("div", { className: "nt-col-title" }, [
                el("div", { className: "nt-title-line" }, [
                  el("span", { className: "post-title", textContent: p.title }),
                  el("span", { className: "muted small", textContent: `[${p.comment_cnt || 0}]` }),
                  el("span", { className: "muted small", textContent: "↗" }),
                ]),
                p.preview ? el("div", { className: "muted small", textContent: p.preview }) : null,
                thumbRow,
              ]),
              el("div", { className: "nt-col-author", textContent: p.author }),
              el("div", { className: "nt-col-date", textContent: (p.reg_date || "").slice(0, 10) }),
              el("div", { className: "nt-col-views", textContent: String(p.read_cnt) }),
            ]
          )
        );
      });

      const pagWrap = document.getElementById("notice-pagination");
      clear(pagWrap);
      const cur = soopData.current_page || 1;
      const last = soopData.last_page || 1;
      if (last > 1) {
        const goNoticePage = (nextPage) => {
          state.noticePage = nextPage;
          loadNotices();
          window.scrollTo({ top: 0, behavior: "smooth" });
        };
        const btnRow = el("div", { className: "row-gap", style: "width:100%; justify-content:center" }, [
          el("button", {
            type: "button",
            className: "btn btn-outline btn-sm",
            textContent: "◀ 이전",
            disabled: cur <= 1,
            onClick: () => {
              if (cur > 1) goNoticePage(cur - 1);
            },
          }),
        ]);
        const startP = Math.max(1, cur - 2);
        const endP = Math.min(last, cur + 2);
        for (let pNum = startP; pNum <= endP; pNum++) {
          btnRow.appendChild(
            el("button", {
              type: "button",
              className: `btn btn-sm ${pNum === cur ? "btn-pink" : "btn-outline"}`,
              textContent: String(pNum),
              onClick: () => goNoticePage(pNum),
            })
          );
        }
        btnRow.appendChild(
          el("button", {
            type: "button",
            className: "btn btn-outline btn-sm",
            textContent: "다음 ▶",
            disabled: cur >= last,
            onClick: () => {
              if (cur < last) goNoticePage(cur + 1);
            },
          })
        );
        pagWrap.appendChild(btnRow);
        pagWrap.appendChild(
          el("div", {
            className: "muted small",
            style: "width:100%; text-align:center",
            textContent: `${cur} / ${last}페이지 · 총 ${(soopData.total || 0).toLocaleString()}건`,
          })
        );
      }
    } catch (err) {
      clear(soopContainer);
      soopContainer.appendChild(el("p", { className: "muted", style: "padding:16px", textContent: err.message }));
    }
  }

  async function loadBoard() {
    const q = document.getElementById("board-search-input").value.trim();
    const url = `/api/posts?tab=${encodeURIComponent(state.boardTab)}&sort=${encodeURIComponent(state.boardSort)}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    const data = await api(url);
    const filtered = state.boardTab === "all"
      ? (data.posts || []).filter((p) => p.tab !== "notice")
      : (data.posts || []);
    renderPostList(document.getElementById("board-list"), filtered);
  }

  async function openPostDetail(postId, pushUrl = true) {
    try {
      const data = await api(`/api/posts/${postId}`);
      const p = data.post;
      if (pushUrl) {
        const basePath = p.tab === "notice" ? "/notice" : "/board";
        const targetUrl = `${basePath}?post=${postId}`;
        if (window.location.pathname + window.location.search !== targetUrl) {
          history.pushState({ page: p.tab === "notice" ? "notice" : "board", postId }, "", targetUrl);
        }
      }
      const adminMode = isStaffOrAdmin();

      const commentsWrap = el("div", { className: "list-stack mt-12" });
      (data.comments || []).forEach((c) => {
        const commentRight = el("div", { className: "row-gap" }, [
          el("span", { className: "muted small", textContent: formatDate(c.created_at) }),
        ]);
        if (adminMode) {
          commentRight.appendChild(
            el("button", {
              className: "btn btn-outline btn-sm",
              textContent: "수정",
              onClick: () => {
                const editInput = el("input", { type: "text", required: "true", maxlength: "1000", value: c.content });
                const editForm = el("form", { className: "form-stack" }, [
                  el("label", {}, ["댓글 내용", editInput]),
                  el("button", { type: "submit", className: "btn btn-pink", textContent: "수정 저장" }),
                ]);
                editForm.addEventListener("submit", async (e) => {
                  e.preventDefault();
                  await api(`/api/comments/${c.id}`, { method: "PUT", body: { content: editInput.value } });
                  showToast("댓글이 수정되었습니다.");
                  openPostDetail(postId);
                });
                openModal("댓글 수정", editForm);
              },
            })
          );
          commentRight.appendChild(
            el("button", {
              className: "btn btn-danger btn-sm",
              textContent: "삭제",
              onClick: async () => {
                await api(`/api/comments/${c.id}`, { method: "DELETE" });
                showToast("댓글이 삭제되었습니다.");
                openPostDetail(postId);
              },
            })
          );
        }
        const cBody = el("div");
        renderRichPostBody(cBody, c.content, false);
        commentsWrap.appendChild(
          el("div", { className: "list-item" }, [
            el("div", {}, [
              el("strong", { textContent: c.author_nickname }),
              cBody,
            ]),
            commentRight,
          ])
        );
      });

      const commentInput = el("input", { type: "text", placeholder: "댓글을 입력하세요...", maxlength: "1000" });
      const { toggleBtn: commentEmojiBtn, pickerBox: commentEmojiPicker } = buildEmoticonPicker(commentInput, 5);
      const commentForm = el("form", { className: "search-form mt-12" }, [
        commentInput,
        commentEmojiBtn,
        el("button", { type: "submit", className: "btn btn-pink btn-sm", textContent: "등록" }),
      ]);
      commentForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!state.user) return showToast("로그인 후 댓글을 작성할 수 있습니다.");
        try {
          await api(`/api/posts/${postId}/comments`, {
            method: "POST",
            body: { content: commentInput.value },
          });
          openPostDetail(postId);
        } catch (err) {
          showToast(err.message);
        }
      });

      const bodyNode = el("div", { className: "post-detail-body" });
      renderRichPostBody(bodyNode, p.content);

      const attachWrap = el("div", { className: "attach-gallery" });
      (p.attachments || []).forEach((att) => {
        if (att.kind === "image") {
          attachWrap.appendChild(el("img", { className: "attach-img", src: att.url, alt: att.name || "첨부 이미지" }));
        } else if (att.kind === "video") {
          attachWrap.appendChild(el("video", { className: "attach-video", src: att.url, controls: "true", playsinline: "true" }));
        }
      });

      const detailActions = el("div", { className: "row-gap" }, [
        makeLikeButton(p, () => {
          if (state.page === "notice") loadNotices();
          else if (state.page === "board") loadBoard();
        }),
      ]);
      if (adminMode) {
        detailActions.appendChild(
          el("button", {
            className: "btn btn-outline btn-sm",
            textContent: p.is_hidden ? "공개로 전환" : "비공개",
            onClick: async () => {
              const res = await api(`/api/posts/${p.id}/hide`, { method: "POST" });
              showToast(res.is_hidden ? "게시글이 비공개 처리되었습니다." : "게시글이 공개되었습니다.");
              openPostDetail(p.id, false);
              if (state.page === "notice") loadNotices();
              else if (state.page === "board") loadBoard();
            },
          })
        );
        detailActions.appendChild(
          el("button", {
            className: "btn btn-outline btn-sm",
            textContent: "게시글 수정",
            onClick: () => showEditPostModal(p),
          })
        );
        detailActions.appendChild(
          el("button", {
            className: "btn btn-danger btn-sm",
            textContent: "게시글 삭제",
            onClick: async () => {
              await api(`/api/posts/${p.id}`, { method: "DELETE" });
              closeModal();
              showToast("삭제되었습니다.");
              if (state.page === "notice") loadNotices();
              else loadBoard();
            },
          })
        );
      }

      const wrapper = el("div", {}, [
        el("div", {
          className: "muted small",
          textContent: `${TAB_LABELS[p.tab] || p.tab} · ${p.author_nickname} · ${formatDate(p.created_at)} · 조회 ${p.views}`,
        }),
        bodyNode,
        (p.attachments || []).length ? attachWrap : null,
        detailActions,
        el("h4", { className: "mt-16", textContent: `댓글 (${(data.comments || []).length})` }),
        commentsWrap,
        commentForm,
        commentEmojiPicker,
      ]);
      openModal(p.title, wrapper);
    } catch (err) {
      showToast(err.message);
    }
  }

  const EMOTICON_MAP = {};

  async function loadEmoticons() {
    try {
      const data = await api("/api/emoticons");
      const list = data.emoticons || [];
      Object.keys(EMOTICON_MAP).forEach((k) => delete EMOTICON_MAP[k]);
      list.forEach((em) => {
        EMOTICON_MAP[String(em.id)] = em;
      });
      return list;
    } catch {
      return [];
    }
  }

  function renderEmoticonNode(em) {
    if (em.image_url) {
      return el("img", {
        className: "inline-sticker-img",
        src: em.image_url,
        alt: em.name || "이모티콘",
        title: em.name || "이모티콘",
      });
    }
    return el("span", {
      className: "inline-sticker",
      textContent: em.glyph || "😊",
      title: em.name || "이모티콘",
    });
  }

  function extractYouTubeIds(text) {
    const ids = [];
    const seen = new Set();
    const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        ids.push(m[1]);
      }
    }
    return ids.slice(0, 3);
  }

  function extractSoopVodEmbeds(text) {
    const urls = [];
    const seen = new Set();
    const regex = /(?:https?:\/\/)?vod\.sooplive\.(?:com|co\.kr)\/player\/(\d+)(?:\/(catch))?(?:\/embed)?/gi;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const id = m[1];
      const isCatch = Boolean(m[2]);
      const embedUrl = isCatch
        ? `https://vod.sooplive.com/player/${id}/catch/embed`
        : `https://vod.sooplive.com/player/${id}/embed`;
      if (!seen.has(embedUrl)) {
        seen.add(embedUrl);
        urls.push(embedUrl);
      }
    }
    return urls.slice(0, 3);
  }

  function renderRichPostBody(container, text, includeEmbeds = true) {
    clear(container);
    const parts = String(text || "").split(/(\[\[이모티콘:\d+\]\])/g);
    parts.forEach((part) => {
      const m = /^\[\[이모티콘:(\d+)\]\]$/.exec(part);
      if (m && EMOTICON_MAP[m[1]]) {
        container.appendChild(renderEmoticonNode(EMOTICON_MAP[m[1]]));
      } else if (part) {
        container.appendChild(document.createTextNode(part));
      }
    });
    if (includeEmbeds) {
      extractYouTubeIds(text || "").forEach((vid) => {
        container.appendChild(
          el("iframe", {
            className: "yt-embed",
            src: `https://www.youtube-nocookie.com/embed/${vid}`,
            title: "YouTube video",
            allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
            allowfullscreen: "true",
          })
        );
      });
      extractSoopVodEmbeds(text || "").forEach((embedUrl) => {
        container.appendChild(
          el("iframe", {
            className: "yt-embed",
            src: embedUrl,
            title: "SOOP VOD player",
            allow: "autoplay; fullscreen; picture-in-picture",
            allowfullscreen: "true",
          })
        );
      });
    }
  }

  function buildEmoticonPicker(targetInput, maxCount = 10) {
    const pickerBox = el("div", { className: "emoji-picker-box hidden" });
    const emojiEntries = Object.values(EMOTICON_MAP);
    if (!emojiEntries.length) {
      pickerBox.appendChild(el("p", { className: "muted small", textContent: "현재 등록된 이모티콘이 없습니다. (관리자가 이모티콘 탭에서 등록 가능)" }));
    } else {
      const emojiGrid = el("div", { className: "emoji-grid" });
      emojiEntries.forEach((em) => {
        const content = em.image_url
          ? [el("img", { src: em.image_url, alt: em.name })]
          : [em.glyph || "😊"];
        emojiGrid.appendChild(
          el(
            "button",
            {
              type: "button",
              className: "emoji-btn",
              title: em.name,
              onClick: () => {
                const count = (targetInput.value.match(/\[\[이모티콘:\d+\]\]/g) || []).length;
                if (count >= maxCount) return showToast(`이모티콘은 최대 ${maxCount}개까지 넣을 수 있습니다.`);
                const tag = `[[이모티콘:${em.id}]]`;
                const start = targetInput.selectionStart ?? targetInput.value.length;
                const end = targetInput.selectionEnd ?? targetInput.value.length;
                targetInput.value = targetInput.value.slice(0, start) + tag + targetInput.value.slice(end);
                targetInput.focus();
                targetInput.setSelectionRange(start + tag.length, start + tag.length);
              },
            },
            content
          )
        );
      });
      pickerBox.appendChild(emojiGrid);
    }

    const toggleBtn = el("button", {
      type: "button",
      className: "btn btn-outline btn-sm",
      textContent: "😊 이모티콘",
      onClick: () => pickerBox.classList.toggle("hidden"),
    });
    return { toggleBtn, pickerBox };
  }

  async function loadEmoticonsPage() {
    const adminCard = document.getElementById("emoticon-admin-card");
    const canManage = isAdminOrStaff();
    if (adminCard) adminCard.classList.toggle("hidden", !canManage);

    const list = await loadEmoticons();
    const grid = document.getElementById("emoticons-grid");
    const countLabel = document.getElementById("emoticon-count-label");
    if (countLabel) countLabel.textContent = `${list.length}개`;
    if (!grid) return;
    clear(grid);
    if (!list.length) {
      grid.appendChild(el("p", { className: "muted", textContent: "현재 등록된 이모티콘이 없습니다." }));
      return;
    }
    list.forEach((em) => {
      const preview = el(
        "div",
        { className: "emoticon-preview" },
        em.image_url ? [el("img", { src: em.image_url, alt: em.name })] : [em.glyph || "😊"]
      );
      const actions = el("div", { className: "row-gap" }, [
        el("button", {
          type: "button",
          className: "btn btn-outline btn-sm",
          textContent: "코드복사",
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(`[[이모티콘:${em.id}]]`);
              showToast(`[[이모티콘:${em.id}]] 복사됨`);
            } catch {
              showToast(`코드: [[이모티콘:${em.id}]]`);
            }
          },
        }),
      ]);
      if (canManage) {
        actions.appendChild(
          el("button", {
            type: "button",
            className: "btn btn-danger btn-sm",
            textContent: "삭제",
            onClick: async () => {
              try {
                await api(`/api/emoticons/${em.id}`, { method: "DELETE" });
                showToast("이모티콘이 삭제되었습니다.");
                loadEmoticonsPage();
              } catch (err) {
                showToast(err.message);
              }
            },
          })
        );
      }
      grid.appendChild(
        el("div", { className: "emoticon-card" }, [
          preview,
          el("div", { className: "emoticon-name", textContent: em.name }),
          el("div", { className: "muted small", textContent: `[[이모티콘:${em.id}]]` }),
          actions,
        ])
      );
    });
  }

  function showWritePostModal(defaultTab = "free", lockNotice = false) {
    if (!state.user) return showToast("로그인 후 작성할 수 있습니다.");
    const activeDefault = !lockNotice && state.boardTab !== "all" ? state.boardTab : defaultTab;

    const tabSelect = el("select", {}, [
      ...(lockNotice ? [el("option", { value: "notice", textContent: "공지사항" })] : []),
      ...(!lockNotice
        ? [
            el("option", { value: "free", textContent: "자유게시판" }),
            el("option", { value: "fanart", textContent: "팬아트" }),
            el("option", { value: "clip", textContent: "레전드 클립" }),
            el("option", { value: "qna", textContent: "질문/건의" }),
            el("option", { value: "emoticon", textContent: "이모티콘 게시판" }),
          ]
        : []),
    ]);
    tabSelect.value = activeDefault;

    const titleInput = el("input", { type: "text", required: "true", maxlength: "120", placeholder: "제목을 입력하세요" });
    const contentInput = el("textarea", {
      rows: "7",
      required: "true",
      maxlength: "5000",
      placeholder: "내용을 입력하세요... (YouTube 또는 SOOP VOD·캐치 URL을 붙여넣으면 영상이 자동으로 임베드됩니다)",
    });

    const { toggleBtn: emojiToggleBtn, pickerBox } = buildEmoticonPicker(contentInput, 10);

    // File attachments (max 4, photos & videos)
    const selectedFiles = [];
    const countLabel = el("span", { className: "muted small", textContent: "0/4" });
    const previewGrid = el("div", { className: "preview-grid hidden" });
    const fileInput = el("input", {
      type: "file",
      multiple: "true",
      accept: "image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime",
      className: "hidden",
    });

    function renderPreviews() {
      clear(previewGrid);
      countLabel.textContent = `${selectedFiles.length}/4`;
      previewGrid.classList.toggle("hidden", selectedFiles.length === 0);
      selectedFiles.forEach((f, idx) => {
        const objUrl = URL.createObjectURL(f);
        const mediaNode = f.type.startsWith("video/")
          ? el("video", { src: objUrl, muted: "true" })
          : el("img", { src: objUrl, alt: f.name });
        previewGrid.appendChild(
          el("div", { className: "preview-item" }, [
            mediaNode,
            el("button", {
              type: "button",
              className: "preview-remove",
              textContent: "✕",
              onClick: (e) => {
                e.stopPropagation();
                selectedFiles.splice(idx, 1);
                renderPreviews();
              },
            }),
          ])
        );
      });
    }

    function addFiles(fileList) {
      for (const f of Array.from(fileList)) {
        if (selectedFiles.length >= 4) {
          showToast("파일은 최대 4개까지 첨부할 수 있습니다.");
          break;
        }
        if (!f.type.startsWith("image/") && !f.type.startsWith("video/")) {
          showToast("사진 또는 영상 파일만 첨부할 수 있습니다.");
          continue;
        }
        selectedFiles.push(f);
      }
      renderPreviews();
    }

    fileInput.addEventListener("change", () => {
      addFiles(fileInput.files);
      fileInput.value = "";
    });

    const dropzone = el("div", { className: "dropzone" }, [
      el("div", { className: "dropzone-icon", textContent: "☁️" }),
      el("div", { className: "dropzone-title", textContent: "사진·영상을 끌어다 놓거나 클릭해서 선택하세요" }),
      el("div", { className: "dropzone-sub", textContent: "이미지(JPG/PNG/GIF/WEBP) · 영상(MP4/WEBM/MOV) 첨부 가능" }),
    ]);
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
    });

    const anonCheck = el("input", { type: "checkbox" });
    const pinCheck = el("input", { type: "checkbox" });
    const isAdmin = ["admin", "staff"].includes(state.user.role);
    const submitBtn = el("button", { type: "submit", className: "btn btn-pink", textContent: "등록" });

    const form = el("form", { className: "form-stack" }, [
      el("label", {}, ["게시판", tabSelect]),
      el("label", {}, ["제목 *", titleInput]),
      el("label", {}, ["내용 *", contentInput]),
      el("div", { className: "row-gap" }, [emojiToggleBtn]),
      pickerBox,
      el("div", { className: "compose-hint" }, [
        el("div", { textContent: "이모티콘을 고르면 커서 자리에 [[이모티콘:번호]]로 들어가고, 올린 글에서는 그림으로 보여요. (글 하나에 10개까지)" }),
        el("div", { textContent: "▶ YouTube 영상은 링크를 본문에 붙여넣으면 자동 임베드됩니다." }),
      ]),
      el("div", { className: "row-gap", style: "justify-content:space-between; margin-top:4px" }, [
        el("strong", { className: "small", textContent: "파일 첨부 (사진 · 영상, 최대 4개)" }),
        countLabel,
      ]),
      fileInput,
      dropzone,
      previewGrid,
      el("div", { className: "anon-box" }, [
        el("label", { className: "checkbox-row" }, [
          anonCheck,
          el("span", { textContent: '🕵️ 익명으로 작성 (작성자명이 "익명"으로 표시)' }),
        ]),
      ]),
      isAdmin ? el("label", { className: "checkbox-row" }, [pinCheck, "상단 고정"]) : null,
      el("div", { className: "modal-footer-end" }, [
        el("button", { type: "button", className: "btn btn-outline", textContent: "취소", onClick: closeModal }),
        submitBtn,
      ]),
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = "등록 중...";
      try {
        let attachments = [];
        if (selectedFiles.length > 0) {
          const fd = new FormData();
          selectedFiles.forEach((f) => fd.append("files", f));
          const upRes = await fetch("/api/uploads", {
            method: "POST",
            headers: state.csrfToken ? { "X-CSRF-Token": state.csrfToken } : {},
            credentials: "same-origin",
            body: fd,
          });
          const upData = await upRes.json().catch(() => ({}));
          if (!upRes.ok) throw new Error(upData.detail || "파일 업로드에 실패했습니다.");
          attachments = upData.files || [];
        }

        const created = await api("/api/posts", {
          method: "POST",
          body: {
            tab: tabSelect.value,
            title: titleInput.value,
            content: contentInput.value,
            is_pinned: pinCheck.checked,
            is_anonymous: anonCheck.checked,
            attachments,
          },
        });
        closeModal();
        showToast(
          created.awarded
            ? `게시글이 등록되었습니다. (+${created.awarded}P 적립!)`
            : "게시글이 등록되었습니다. (일일 글쓰기 포인트 3회 적립 완료)"
        );
        await refreshMe();
        if (tabSelect.value === "notice") loadNotices();
        else loadBoard();
      } catch (err) {
        showToast(err.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "등록";
      }
    });
    openModal(lockNotice ? "공지사항 작성" : "게시글 작성", form);
  }

  // Signatures
  function showSignatureModal(existing = null) {
    const isEdit = Boolean(existing);
    const titleIn = el("input", { type: "text", required: "true", maxlength: "60", value: existing ? existing.title : "", placeholder: "예: 우치다" });
    const countIn = el("input", { type: "number", required: "true", min: "1", value: existing ? String(existing.balloon_count) : "", placeholder: "예: 101" });
    const clipIn = el("input", { type: "url", maxlength: "300", value: existing ? (existing.clip_url || "") : "", placeholder: "https://vod.sooplive.com/player/..." });
    const imgIn = el("input", { type: "text", maxlength: "300", value: existing ? (existing.image_url || "") : "", placeholder: "썸네일 이미지 URL (선택)" });
    const tagsIn = el("input", { type: "text", maxlength: "80", value: existing ? (existing.tags || "") : "", placeholder: "realhot,new,hot (선택)" });
    const descIn = el("input", { type: "text", maxlength: "200", value: existing ? (existing.description || "") : "", placeholder: "설명 (선택)" });

    const form = el("form", { className: "form-stack" }, [
      el("label", {}, ["시그니처 이름 *", titleIn]),
      el("label", {}, ["풍선 개수 *", countIn]),
      el("label", {}, ["클립 URL (선택)", clipIn]),
      el("label", {}, ["썸네일 URL (선택)", imgIn]),
      el("label", {}, ["태그 (realhot, new, hot)", tagsIn]),
      el("label", {}, ["설명", descIn]),
      el("div", { className: "modal-footer-end" }, [
        el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "취소", onClick: closeModal }),
        el("button", { type: "submit", className: "btn btn-pink btn-sm", textContent: isEdit ? "수정 저장" : "시그니처 등록" }),
      ]),
    ]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        title: titleIn.value,
        balloon_count: Number(countIn.value),
        category: "시그니처",
        description: descIn.value,
        badge: "💖",
        clip_url: clipIn.value,
        image_url: imgIn.value,
        tags: tagsIn.value,
      };
      try {
        if (isEdit) {
          await api(`/api/signatures/${existing.id}`, { method: "PUT", body: payload });
          showToast("시그니처가 수정되었습니다.");
        } else {
          await api("/api/signatures", { method: "POST", body: payload });
          showToast("시그니처가 등록되었습니다.");
        }
        closeModal();
        loadSignatures();
      } catch (err) {
        showToast(err.message);
      }
    });
    openModal(isEdit ? "시그니처 수정" : "새 시그니처 추가", form);
  }

  function renderFilteredSignatures() {
    const grid = document.getElementById("signatures-grid");
    const descEl = document.getElementById("sig-range-desc");
    clear(grid);

    const range = state.sigCategory;
    if (range === "new") descEl.textContent = "최근 새롭게 나온 시그입니다!";
    else if (range === "realhot") descEl.textContent = "최근 기간동안 자주 나왔던 시그입니다!";
    else if (range === "hot") descEl.textContent = "열혈 시그니처 목록입니다!";
    else descEl.textContent = "";

    let items = [...state.allSignatures];
    if (range !== "all") {
      items = items.filter((s) => {
        const num = Number(s.balloon_count);
        const tagList = (s.tags || "").split(",").map((t) => t.trim());
        if (range === "realhot" || range === "new" || range === "hot") return tagList.includes(range);
        if (range === "100s") return num >= 100 && num <= 199;
        if (range === "200s") return num >= 200 && num <= 299;
        if (range === "300s") return num >= 300 && num <= 399;
        if (range === "400to900") return num >= 400 && num <= 999;
        if (range === "1000s") return num >= 1000 && num <= 1999;
        if (range === "2000s") return num >= 2000 && num <= 2999;
        if (range === "3000s") return num >= 3000 && num <= 9999;
        if (range === "10000s") return num >= 10000;
        return true;
      });
    }

    const kw = state.sigKeyword.trim().toLowerCase();
    if (kw) {
      items = items.filter(
        (s) => s.title.toLowerCase().includes(kw) || String(s.balloon_count).includes(kw)
      );
    }

    if (state.sigSort === "asc") items.sort((a, b) => a.balloon_count - b.balloon_count);
    else if (state.sigSort === "desc") items.sort((a, b) => b.balloon_count - a.balloon_count);
    else if (state.sigSort === "korean") items.sort((a, b) => a.title.localeCompare(b.title, "ko"));

    if (!items.length) {
      grid.appendChild(el("p", { className: "muted", textContent: "검색 결과가 없습니다." }));
      return;
    }

    const adminMode = isStaffOrAdmin();
    items.forEach((s) => {
      const thumbChildren = [];
      if (s.image_url) {
        thumbChildren.push(el("img", { src: s.image_url, alt: s.title, loading: "lazy" }));
      } else {
        thumbChildren.push(el("div", { className: "sig-thumb-title", textContent: s.title }));
        thumbChildren.push(el("div", { className: "sig-thumb-num", textContent: `🎈 ${s.balloon_count.toLocaleString()}` }));
      }
      if (s.clip_url) {
        thumbChildren.push(el("span", { className: "sig-clip-badge", textContent: "▶ 클립" }));
      }

      const card = el(
        "div",
        {
          className: `sig-card${s.clip_url ? " has-clip" : ""}`,
          onClick: s.clip_url ? () => window.open(s.clip_url, "_blank", "noopener,noreferrer") : undefined,
        },
        [
          el("div", { className: "sig-thumb" }, thumbChildren),
          el("div", { className: "sig-card-body" }, [
            el("div", { className: "sig-card-title", textContent: s.title, title: s.title }),
            el("span", { className: "sig-count-pill", textContent: `🎈 ${s.balloon_count.toLocaleString()}개` }),
            adminMode
              ? el("div", { className: "row-gap", style: "margin-top:auto" }, [
                  el("button", {
                    className: "btn btn-outline btn-sm",
                    textContent: "수정",
                    onClick: (e) => {
                      e.stopPropagation();
                      showSignatureModal(s);
                    },
                  }),
                  el("button", {
                    className: "btn btn-danger btn-sm",
                    textContent: "삭제",
                    onClick: async (e) => {
                      e.stopPropagation();
                      await api(`/api/signatures/${s.id}`, { method: "DELETE" });
                      showToast("시그니처가 삭제되었습니다.");
                      loadSignatures();
                    },
                  }),
                ])
              : null,
          ]),
        ]
      );
      grid.appendChild(card);
    });
  }

  async function loadSignatures() {
    document.getElementById("sig-add-btn").classList.toggle("hidden", !isStaffOrAdmin());
    const data = await api("/api/signatures");
    state.allSignatures = data.signatures || [];
    renderFilteredSignatures();
  }

  // Calendar
  const EVENT_COLOR_PRESETS = [
    { hex: "#ec4899", name: "핑크" },
    { hex: "#8b5cf6", name: "퍼플" },
    { hex: "#3b82f6", name: "블루" },
    { hex: "#10b981", name: "민트" },
    { hex: "#f59e0b", name: "골드" },
    { hex: "#6b7280", name: "휴방/그레이" },
  ];

  function showCalendarEventModal(existing = null, defaultDate = "") {
    const isEdit = Boolean(existing);
    const titleIn = el("input", { type: "text", required: "true", maxlength: "80", value: existing ? existing.title : "", placeholder: "일정 제목" });
    const dateIn = el("input", { type: "date", required: "true", value: existing ? existing.event_date : defaultDate });
    const timeIn = el("input", { type: "time", required: "true", value: existing ? existing.start_time : "20:00" });
    const catSel = el("select", {}, [
      el("option", { value: "live", textContent: "정규 방송" }),
      el("option", { value: "collab", textContent: "합방" }),
      el("option", { value: "event", textContent: "이벤트" }),
      el("option", { value: "rest", textContent: "휴방" }),
    ]);
    catSel.value = existing ? existing.category : "live";
    const descIn = el("input", { type: "text", maxlength: "300", value: existing ? (existing.description || "") : "", placeholder: "일정 설명 (선택)" });

    const colorIn = el("input", { type: "color", value: existing?.color || "#ec4899" });
    const swatchWrap = el("div", { className: "color-swatches" });
    function syncSwatches() {
      swatchWrap.querySelectorAll(".color-swatch").forEach((b) => {
        b.classList.toggle("active", b.dataset.hex.toLowerCase() === colorIn.value.toLowerCase());
      });
    }
    EVENT_COLOR_PRESETS.forEach((p) => {
      swatchWrap.appendChild(
        el("button", {
          type: "button",
          className: "color-swatch",
          dataset: { hex: p.hex },
          style: `background:${p.hex}`,
          title: p.name,
          onClick: () => {
            colorIn.value = p.hex;
            syncSwatches();
          },
        })
      );
    });
    swatchWrap.appendChild(colorIn);
    colorIn.addEventListener("input", syncSwatches);
    syncSwatches();

    const footer = el("div", { className: "modal-footer-end" }, [
      isEdit
        ? el("button", {
            type: "button",
            className: "btn btn-danger btn-sm",
            textContent: "삭제",
            onClick: async () => {
              await api(`/api/calendar/${existing.id}`, { method: "DELETE" });
              closeModal();
              showToast("일정이 삭제되었습니다.");
              loadCalendar();
            },
          })
        : null,
      el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "취소", onClick: closeModal }),
      el("button", { type: "submit", className: "btn btn-pink btn-sm", textContent: isEdit ? "수정 저장" : "일정 등록" }),
    ]);

    const form = el("form", { className: "form-stack" }, [
      el("label", {}, ["일정 제목 *", titleIn]),
      el("label", {}, ["날짜 *", dateIn]),
      el("label", {}, ["시간 *", timeIn]),
      el("label", {}, ["구분", catSel]),
      el("label", {}, ["일정 색상", swatchWrap]),
      el("label", {}, ["설명", descIn]),
      footer,
    ]);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        title: titleIn.value,
        event_date: dateIn.value,
        start_time: timeIn.value,
        category: catSel.value,
        description: descIn.value,
        color: colorIn.value,
      };
      if (isEdit) {
        await api(`/api/calendar/${existing.id}`, { method: "PUT", body: payload });
        showToast("일정이 수정되었습니다.");
      } else {
        await api("/api/calendar", { method: "POST", body: payload });
        showToast("일정이 등록되었습니다.");
      }
      closeModal();
      loadCalendar();
    });
    openModal(isEdit ? "일정 수정 / 삭제" : "새 일정 추가", form);
  }

  async function loadCalendar() {
    const ym = `${state.calYear}-${String(state.calMonth).padStart(2, "0")}`;
    document.getElementById("cal-month-label").textContent = ym;
    const adminMode = isStaffOrAdmin();
    document.getElementById("cal-add-btn").classList.toggle("hidden", !adminMode);

    const data = await api(`/api/calendar?month=${ym}`);
    const events = data.events || [];

    const byDay = {};
    events.forEach((ev) => {
      const day = Number(ev.event_date.split("-")[2]);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(ev);
    });

    const grid = document.getElementById("cal-grid");
    clear(grid);

    const firstWeekday = new Date(state.calYear, state.calMonth - 1, 1).getDay();
    const daysInMonth = new Date(state.calYear, state.calMonth, 0).getDate();
    const now = new Date();
    const isCurMonth = state.calYear === now.getFullYear() && state.calMonth === now.getMonth() + 1;
    const todayDay = now.getDate();

    for (let i = 0; i < firstWeekday; i++) {
      grid.appendChild(el("div", { className: "cal-cell empty" }));
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dayEvents = byDay[day] || [];
      const dayStr = `${ym}-${String(day).padStart(2, "0")}`;
      const isToday = isCurMonth && day === todayDay;
      const cell = el(
        "div",
        {
          className: `cal-cell${isToday ? " today" : ""}${adminMode ? " clickable" : ""}`,
          onClick: adminMode ? () => showCalendarEventModal(null, dayStr) : undefined,
        },
        [
          el("div", { className: "cal-day", textContent: isToday ? `${day} · 오늘` : String(day) }),
          ...dayEvents.map((ev) =>
            el("div", {
              className: "cal-chip",
              style: `background:${ev.color || "#ec4899"}`,
              textContent: `${ev.start_time} ${ev.title}`,
              title: `${ev.title}${ev.description ? ` (${ev.description})` : ""}`,
              onClick: adminMode
                ? (e) => {
                    e.stopPropagation();
                    showCalendarEventModal(ev);
                  }
                : undefined,
            })
          ),
        ]
      );
      grid.appendChild(cell);
    }

    const listWrap = document.getElementById("cal-event-list");
    clear(listWrap);
    if (!events.length) {
      listWrap.appendChild(el("p", { className: "muted", textContent: "이번 달 등록된 일정이 없습니다." }));
    } else {
      events.forEach((ev) => {
        const evColor = ev.color || "#ec4899";
        const rightBox = el("div", { className: "row-gap" }, [
          el("span", { className: "muted small", textContent: `${ev.event_date} ${ev.start_time}` }),
        ]);
        if (adminMode) {
          rightBox.appendChild(
            el("button", {
              className: "btn btn-outline btn-sm",
              textContent: "수정",
              onClick: () => showCalendarEventModal(ev),
            })
          );
          rightBox.appendChild(
            el("button", {
              className: "btn btn-danger btn-sm",
              textContent: "삭제",
              onClick: async () => {
                await api(`/api/calendar/${ev.id}`, { method: "DELETE" });
                showToast("일정이 삭제되었습니다.");
                loadCalendar();
              },
            })
          );
        }
        listWrap.appendChild(
          el("div", { className: "list-item", style: `border-left: 5px solid ${evColor}` }, [
            el("div", {}, [
              el("span", {
                className: "badge-pink",
                style: `background:${evColor}; color:#fff`,
                textContent: CAL_CAT_LABELS[ev.category] || ev.category,
              }),
              el("strong", { textContent: ` ${ev.title}` }),
              el("div", { className: "muted small", textContent: ev.description }),
            ]),
            rightBox,
          ])
        );
      });
    }
  }

  // Points & SOOP Link
  function renderSoopLinkSection() {
    const statusBox = document.getElementById("soop-link-status-box");
    const pendingBox = document.getElementById("soop-pending-box");
    const unlinkBtn = document.getElementById("soop-unlink-btn");

    clear(statusBox);
    clear(pendingBox);
    pendingBox.classList.add("hidden");
    unlinkBtn.classList.add("hidden");

    if (!state.user) {
      statusBox.textContent = "로그인하면 SOOP 아이디를 연동하고 채팅 포인트를 적립할 수 있습니다.";
      return;
    }

    if (state.user.soop_verified) {
      statusBox.appendChild(el("strong", { textContent: `✅ 연동 완료: ${state.user.soop_id}` }));
      statusBox.appendChild(el("div", { className: "muted small", textContent: "이제 방송 채팅 참여 시 자동으로 포인트가 적립됩니다." }));
      unlinkBtn.classList.remove("hidden");
    } else {
      statusBox.textContent = "아직 연동된 SOOP 아이디가 없습니다.";
    }

    if (state.user.soop_pending_id && state.user.soop_verify_code) {
      pendingBox.classList.remove("hidden");
      pendingBox.appendChild(
        el("div", {
          textContent: `인증 대기 중 (${state.user.soop_pending_id}) — 본인 SOOP 방송국 소개글에 아래 코드를 입력하고 저장한 뒤 확인 버튼을 누르세요:`,
        })
      );
      pendingBox.appendChild(
        el("div", { style: "margin:8px 0; font-size:1.1rem" }, [
          el("strong", { textContent: state.user.soop_verify_code }),
        ])
      );
      pendingBox.appendChild(
        el("div", {
          className: "muted small",
          textContent: "인증 완료 후에는 소개글에서 코드를 지우셔도 계속 연동 상태가 유지됩니다.",
        })
      );
      pendingBox.appendChild(
        el("div", { className: "row-gap mt-12" }, [
          el("button", {
            type: "button",
            className: "btn btn-pink btn-sm",
            textContent: "방송국 소개글로 인증 확인",
            onClick: async () => {
              try {
                const res = await api("/api/soop/link/verify-station", { method: "POST" });
                showToast(res.message || "SOOP 계정 인증 완료!");
                await refreshMe();
                renderHomeUserBox();
              } catch (err) {
                showToast(err.message);
              }
            },
          }),
        ])
      );
    }
  }

  async function refreshCollectorStatus() {
    const box = document.getElementById("collector-status-box");
    const logsWrap = document.getElementById("collector-logs");
    if (!box || !logsWrap) return;
    try {
      const st = await api("/api/integrations/soop/collector/status");
      clear(box);
      box.appendChild(el("strong", { textContent: st.status_text }));
      box.appendChild(
        el("div", {
          className: "muted small",
          textContent: `감지된 채팅 ${st.messages_seen.toLocaleString()}건 · 자동 지급 ${st.points_awarded.toLocaleString()}P`,
        })
      );
      clear(logsWrap);
      if (!(st.recent_logs || []).length) {
        logsWrap.appendChild(el("div", { className: "muted small", textContent: "아직 자동 적립된 실시간 채팅 로그가 없습니다." }));
      } else {
        st.recent_logs.forEach((line) => {
          logsWrap.appendChild(el("div", { className: "list-item", textContent: line }));
        });
      }
    } catch {
      box.textContent = "수집기 상태를 불러오지 못했습니다.";
    }
  }

  async function loadPredictions() {
    const wrap = document.getElementById("predictions-list");
    const addBtn = document.getElementById("pred-add-btn");
    if (!wrap) return;
    const adminMode = isStaffOrAdmin();
    addBtn.classList.toggle("hidden", !adminMode);

    const data = await api("/api/predictions");
    const preds = data.predictions || [];
    clear(wrap);
    if (!preds.length) {
      wrap.appendChild(el("p", { className: "muted", textContent: "현재 등록된 승부예측이 없습니다." }));
      return;
    }

    const STATUS_BADGE = {
      open: "🟢 진행 중",
      locked: "🔒 마감됨",
      settled: "🏆 정산 완료",
      cancelled: "❌ 취소됨",
    };

    const OPTION_COLORS = ["#ec4899", "#8b5cf6", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#6366f1", "#84cc16", "#f97316"];

    preds.forEach((pr) => {
      const options = pr.options || [];
      let selectedChoice = pr.my_bets && pr.my_bets.length ? String(pr.my_bets[0].choice) : "0";
      const optNodes = [];

      const barChildren = options.map((opt, idx) =>
        el("div", {
          style: `width:${opt.pct}%; height:100%; background:${OPTION_COLORS[idx % OPTION_COLORS.length]}`,
        })
      );

      options.forEach((opt, idx) => {
        const color = OPTION_COLORS[idx % OPTION_COLORS.length];
        const isWinner = pr.status === "settled" && String(pr.winner) === String(opt.index);
        const node = el(
          "div",
          {
            className: `pred-opt${isWinner ? " winner" : ""}${pr.status === "open" && selectedChoice === String(opt.index) ? " selected" : ""}`,
            style: `border-left: 4px solid ${color}`,
          },
          [
            el("div", { className: "row-gap", style: "justify-content:space-between" }, [
              el("strong", { textContent: `${idx + 1}. ${opt.label}` }),
              el("span", {
                className: "badge-pink",
                style: `background:${color}1a; color:${color}`,
                textContent: `${opt.pct}% · ${opt.odds}배`,
              }),
            ]),
            el("div", { className: "muted small", textContent: `${opt.pool.toLocaleString()}P (${opt.count}명)` }),
          ]
        );
        if (pr.status === "open") {
          node.addEventListener("click", () => {
            selectedChoice = String(opt.index);
            optNodes.forEach((n) => n.classList.remove("selected"));
            node.classList.add("selected");
          });
        }
        optNodes.push(node);
      });

      const betFormRow = pr.status === "open"
        ? (() => {
            const amtIn = el("input", { type: "number", min: "10", step: "10", placeholder: "베팅 포인트", style: "width:150px" });
            const betForm = el("form", { className: "row-gap" }, [
              amtIn,
              el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "+50", onClick: () => { amtIn.value = String((Number(amtIn.value) || 0) + 50); } }),
              el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "+100", onClick: () => { amtIn.value = String((Number(amtIn.value) || 0) + 100); } }),
              el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "+500", onClick: () => { amtIn.value = String((Number(amtIn.value) || 0) + 500); } }),
              el("button", { type: "submit", className: "btn btn-pink btn-sm", textContent: "베팅하기" }),
            ]);
            betForm.addEventListener("submit", async (e) => {
              e.preventDefault();
              if (!state.user) return showToast("로그인 후 베팅할 수 있습니다.");
              const amt = Number(amtIn.value);
              if (!amt || amt <= 0) return showToast("베팅할 포인트를 입력하세요.");
              try {
                await api(`/api/predictions/${pr.id}/bet`, {
                  method: "POST",
                  body: { choice: selectedChoice, amount: amt },
                });
                const chosen = options.find((o) => String(o.index) === selectedChoice);
                showToast(`'${chosen ? chosen.label : selectedChoice}'에 ${amt.toLocaleString()}P 베팅 완료!`);
                await refreshMe();
                loadPointsPage();
              } catch (err) {
                showToast(err.message);
              }
            });
            return betForm;
          })()
        : null;

      const adminRow = adminMode
        ? el("div", { className: "row-gap" }, [
            pr.status === "open"
              ? el("button", {
                  className: "btn btn-outline btn-sm",
                  textContent: "베팅 마감",
                  onClick: async () => {
                    await api(`/api/predictions/${pr.id}/lock`, { method: "POST" });
                    showToast("베팅이 마감되었습니다.");
                    loadPredictions();
                  },
                })
              : null,
            ...(pr.status === "open" || pr.status === "locked"
              ? options.map((opt, idx) =>
                  el("button", {
                    className: "btn btn-pink btn-sm",
                    style: `background:${OPTION_COLORS[idx % OPTION_COLORS.length]}`,
                    textContent: `${opt.label} 승리`,
                    onClick: async () => {
                      await api(`/api/predictions/${pr.id}/settle`, {
                        method: "POST",
                        body: { winner: String(opt.index) },
                      });
                      showToast(`'${opt.label}' 승리로 정산 완료!`);
                      await refreshMe();
                      loadPointsPage();
                    },
                  })
                )
              : []),
            pr.status === "open" || pr.status === "locked"
              ? el("button", {
                  className: "btn btn-outline btn-sm",
                  textContent: "취소(환불)",
                  onClick: async () => {
                    await api(`/api/predictions/${pr.id}/cancel`, { method: "POST" });
                    showToast("승부예측 취소 및 환불 완료!");
                    await refreshMe();
                    loadPointsPage();
                  },
                })
              : null,
            el("button", {
              className: "btn btn-danger btn-sm",
              textContent: "삭제",
              onClick: async () => {
                await api(`/api/predictions/${pr.id}`, { method: "DELETE" });
                showToast("승부예측이 삭제되었습니다.");
                await refreshMe();
                loadPointsPage();
              },
            }),
          ])
        : null;

      const winOpt = options.find((o) => String(o.index) === String(pr.winner));
      const myBetText = (pr.my_bets || [])
        .map((mb) => {
          const opt = options.find((o) => String(o.index) === String(mb.choice));
          return `${opt ? opt.label : mb.choice} ${mb.amount.toLocaleString()}P${mb.payout > 0 ? ` (획득 ${mb.payout.toLocaleString()}P)` : ""}`;
        })
        .join(" · ");

      wrap.appendChild(
        el("div", { className: "pred-card" }, [
          el("div", { className: "pred-head" }, [
            el("strong", { style: "font-size:1.05rem", textContent: pr.title }),
            el("div", { className: "row-gap" }, [
              pr.closes_at_kst
                ? el("span", { className: "muted small", textContent: `⏰ 마감: ${pr.closes_at_kst}` })
                : null,
              el("span", {
                className: "badge-pink",
                textContent: pr.status === "settled" && winOpt ? `🏆 ${winOpt.label} 승리` : (STATUS_BADGE[pr.status] || pr.status),
              }),
            ]),
          ]),
          el("div", { className: "pred-bar-wrap" }, barChildren),
          el("div", { className: "pred-options-grid" }, optNodes),
          myBetText ? el("div", { className: "muted small", textContent: `내 베팅: ${myBetText}` }) : null,
          betFormRow,
          adminRow,
        ])
      );
    });
  }

  async function loadPointsPage() {
    try { renderSoopLinkSection(); } catch (_) {}
    try { renderHomeUserBox(); } catch (_) {}
    refreshCollectorStatus();
    loadPredictions();

    try {
      const shopData = await api("/api/shop/items");
      const shopGrid = document.getElementById("shop-grid");
      const shopAddBtn = document.getElementById("shop-add-btn");
      clear(shopGrid);
      const adminMode = isStaffOrAdmin();
      shopAddBtn.classList.toggle("hidden", !adminMode);

      if (!(shopData.items || []).length) {
        shopGrid.appendChild(el("p", { className: "muted", textContent: "현재 등록된 상품이 없습니다." }));
      }
      (shopData.items || []).forEach((item) => {
        const actions = el("div", { className: "row-gap" }, [
          el("button", {
            className: "btn btn-pink btn-sm",
            textContent: "교환하기",
            onClick: async () => {
              if (!state.user) return showToast("로그인이 필요합니다.");
              try {
                const res = await api("/api/shop/redeem", {
                  method: "POST",
                  body: { item_id: item.id, note: "" },
                });
                showToast(
                  res.double_points_until
                    ? `${res.item_name} 적용 완료! (${formatDate(res.double_points_until)}까지 획득 포인트 2배)`
                    : `${res.item_name} 교환 완료! (자동 승인)`
                );
                await refreshMe();
                loadPointsPage();
              } catch (err) {
                showToast(err.message);
              }
            },
          }),
        ]);
        if (adminMode) {
          actions.appendChild(
            el("button", {
              className: "btn btn-outline btn-sm",
              textContent: "수정",
              onClick: () => {
                const nameIn = el("input", { type: "text", required: "true", maxlength: "60", value: item.name });
                const costIn = el("input", { type: "number", required: "true", min: "1", value: String(item.cost) });
                const stockIn = el("input", { type: "number", required: "true", min: "0", value: String(item.stock) });
                const descIn = el("input", { type: "text", required: "true", maxlength: "200", value: item.description });
                const form = el("form", { className: "form-stack" }, [
                  el("label", {}, ["상품명", nameIn]),
                  el("label", {}, ["필요 포인트", costIn]),
                  el("label", {}, ["재고", stockIn]),
                  el("label", {}, ["설명", descIn]),
                  el("button", { type: "submit", className: "btn btn-pink", textContent: "수정 저장" }),
                ]);
                form.addEventListener("submit", async (e) => {
                  e.preventDefault();
                  await api(`/api/shop/items/${item.id}`, {
                    method: "PUT",
                    body: {
                      name: nameIn.value,
                      cost: Number(costIn.value),
                      stock: Number(stockIn.value),
                      description: descIn.value,
                    },
                  });
                  closeModal();
                  showToast("상품이 수정되었습니다.");
                  loadPointsPage();
                });
                openModal("상점 상품 수정", form);
              },
            })
          );
          actions.appendChild(
            el("button", {
              className: "btn btn-danger btn-sm",
              textContent: "삭제",
              onClick: async () => {
                await api(`/api/shop/items/${item.id}`, { method: "DELETE" });
                showToast("상품이 삭제되었습니다.");
                loadPointsPage();
              },
            })
          );
        }
        shopGrid.appendChild(
          el("div", { className: "shop-card" }, [
            el("div", {}, [
              el("strong", { textContent: item.name }),
              el("p", { className: "muted small", textContent: item.description }),
            ]),
            el("div", { className: "row-gap", style: "justify-content:space-between" }, [
              el("span", { className: "badge-pink", textContent: `${item.cost.toLocaleString()} P · 재고 ${item.stock}` }),
              actions,
            ]),
          ])
        );
      });
    } catch (_) {}

    const ledgerWrap = document.getElementById("ledger-list");
    const ledgerPag = document.getElementById("ledger-pagination");
    const redWrap = document.getElementById("my-redemptions-list");
    clear(ledgerWrap);
    if (ledgerPag) clear(ledgerPag);
    clear(redWrap);

    if (!state.user) {
      ledgerWrap.appendChild(el("p", { className: "muted", textContent: "로그인 후 확인할 수 있습니다." }));
      redWrap.appendChild(el("p", { className: "muted", textContent: "로그인 후 확인할 수 있습니다." }));
      return;
    }

    let ledgerRes = { ledger: [] };
    let redRes = { redemptions: [] };
    try {
      [ledgerRes, redRes] = await Promise.all([
        api(`/api/points/ledger?page=${state.ledgerPage || 1}&per_page=10`),
        api("/api/redemptions/me"),
      ]);
    } catch (err) {
      ledgerWrap.appendChild(el("p", { className: "muted small", textContent: err.message || "포인트 원장을 불러오지 못했습니다." }));
      return;
    }

    if (!(ledgerRes.ledger || []).length) {
      ledgerWrap.appendChild(el("p", { className: "muted small", textContent: "포인트 내역이 없습니다." }));
    }
    (ledgerRes.ledger || []).forEach((l) => {
      const sign = l.delta >= 0 ? `+${l.delta}` : String(l.delta);
      ledgerWrap.appendChild(
        el("div", { className: "list-item" }, [
          el("div", {}, [
            el("strong", { textContent: l.reason }),
            el("div", { className: "muted small", textContent: formatDate(l.created_at) }),
          ]),
          el("strong", {
            style: `color:${l.delta >= 0 ? "#db2777" : "#6b7280"}`,
            textContent: `${sign}P (잔액 ${l.balance_after.toLocaleString()}P)`,
          }),
        ])
      );
    });

    if (ledgerPag) {
      const cur = ledgerRes.page || 1;
      const last = ledgerRes.total_pages || 1;
      if (last > 1) {
        const goLedgerPage = (p) => {
          state.ledgerPage = p;
          loadPointsPage();
        };
        const btnRow = el("div", { className: "row-gap", style: "width:100%; justify-content:center" }, [
          el("button", {
            type: "button",
            className: "btn btn-outline btn-sm",
            textContent: "◀ 이전",
            disabled: cur <= 1,
            onClick: () => { if (cur > 1) goLedgerPage(cur - 1); },
          }),
        ]);
        const startP = Math.max(1, cur - 2);
        const endP = Math.min(last, cur + 2);
        for (let pNum = startP; pNum <= endP; pNum++) {
          btnRow.appendChild(
            el("button", {
              type: "button",
              className: `btn btn-sm ${pNum === cur ? "btn-pink" : "btn-outline"}`,
              textContent: String(pNum),
              onClick: () => goLedgerPage(pNum),
            })
          );
        }
        btnRow.appendChild(
          el("button", {
            type: "button",
            className: "btn btn-outline btn-sm",
            textContent: "다음 ▶",
            disabled: cur >= last,
            onClick: () => { if (cur < last) goLedgerPage(cur + 1); },
          })
        );
        ledgerPag.appendChild(btnRow);
        ledgerPag.appendChild(
          el("div", {
            className: "muted small",
            style: "width:100%; text-align:center",
            textContent: `${cur} / ${last}페이지 · 총 ${(ledgerRes.total || 0).toLocaleString()}건`,
          })
        );
      }
    }

    (redRes.redemptions || []).forEach((r) => {
      redWrap.appendChild(
        el("div", { className: "list-item" }, [
          el("div", {}, [
            el("strong", { textContent: r.item_name }),
            el("div", { className: "muted small", textContent: `${r.cost}P · ${formatDate(r.created_at)}` }),
          ]),
          el("span", { className: "badge-pink", textContent: r.status }),
        ])
      );
    });
  }

  let activeGameTab = "suika";
  let gameTabsBound = false;

  function loadGamePage() {
    const gameCtx = {
      api,
      getUser: () => state.user,
      onPointsChanged: (newPoints) => {
        if (state.user && typeof newPoints === "number") {
          state.user.points = newPoints;
          renderAuthArea();
          renderHomeUserBox();
        }
      },
      showToast,
    };

    const showGameTab = (tabName) => {
      activeGameTab = tabName === "omok" ? "omok" : "suika";
      document.querySelectorAll("#game-tabs .pill").forEach((b) => {
        b.classList.toggle("active", b.dataset.gtab === activeGameTab);
      });
      const suikaPanel = document.getElementById("game-panel-suika");
      const omokPanel = document.getElementById("game-panel-omok");
      if (suikaPanel) suikaPanel.classList.toggle("hidden", activeGameTab !== "suika");
      if (omokPanel) omokPanel.classList.toggle("hidden", activeGameTab !== "omok");

      if (activeGameTab === "suika" && window.ChaeonSuika) {
        window.ChaeonSuika.initPage(gameCtx);
      } else if (activeGameTab === "omok" && window.ChaeonOmok) {
        window.ChaeonOmok.initPage(gameCtx);
      }
    };

    if (!gameTabsBound) {
      gameTabsBound = true;
      document.querySelectorAll("#game-tabs .pill").forEach((btn) => {
        btn.addEventListener("click", () => showGameTab(btn.dataset.gtab));
      });
    }

    showGameTab(activeGameTab);
  }

  // Gift Page
  let currentGiftType = "point";

  async function loadGiftPage() {
    const ptsBadge = document.getElementById("gift-my-points");
    ptsBadge.textContent = state.user ? `보유: ${state.user.points.toLocaleString()} P` : "보유: - P";

    const opts = await api("/api/gifts/options");

    const itemSel = document.getElementById("gift-item-select");
    clear(itemSel);
    if (!(opts.items || []).length) {
      itemSel.appendChild(el("option", { value: "", textContent: "현재 상점에 등록된 아이템이 없습니다." }));
    } else {
      opts.items.forEach((it) => {
        itemSel.appendChild(el("option", { value: String(it.id), textContent: `${it.name} (${it.cost.toLocaleString()}P · 재고 ${it.stock})` }));
      });
    }

    const emoSel = document.getElementById("gift-emoticon-select");
    clear(emoSel);
    if (!(opts.emoticons || []).length) {
      emoSel.appendChild(el("option", { value: "", textContent: "현재 등록된 이모티콘이 없습니다." }));
    } else {
      opts.emoticons.forEach((em) => {
        emoSel.appendChild(el("option", { value: em.id, textContent: `${em.name} (${em.cost}P)` }));
      });
    }

    const recWrap = document.getElementById("gift-received-list");
    const sentWrap = document.getElementById("gift-sent-list");
    const voucherWrap = document.getElementById("my-vouchers-list");
    const voucherHint = document.getElementById("gift-voucher-owned-hint");
    const adminVoucherCard = document.getElementById("gift-admin-voucher-card");
    clear(recWrap);
    clear(sentWrap);
    if (voucherWrap) clear(voucherWrap);
    if (adminVoucherCard) adminVoucherCard.classList.toggle("hidden", !isStaffOrAdmin());

    if (!state.user) {
      recWrap.appendChild(el("p", { className: "muted", textContent: "로그인 후 확인할 수 있습니다." }));
      sentWrap.appendChild(el("p", { className: "muted", textContent: "로그인 후 확인할 수 있습니다." }));
      if (voucherWrap) voucherWrap.appendChild(el("p", { className: "muted", textContent: "로그인 후 확인할 수 있습니다." }));
      if (voucherHint) voucherHint.textContent = "로그인 후 보유 장수를 확인할 수 있습니다.";
      return;
    }

    const [myGifts, myVouchers] = await Promise.all([api("/api/gifts/me"), api("/api/vouchers/me")]);
    const vCounts = myVouchers.counts || { "1000": 0, "5000": 0, "10000": 0 };
    if (voucherHint) {
      voucherHint.textContent = `내 보유: +1,000P ${vCounts["1000"] || 0}장 · +5,000P ${vCounts["5000"] || 0}장 · +10,000P ${vCounts["10000"] || 0}장`;
    }
    if (voucherWrap) {
      const tiers = [1000, 5000, 10000];
      const totalV = tiers.reduce((acc, v) => acc + (vCounts[String(v)] || 0), 0);
      if (totalV === 0) {
        voucherWrap.appendChild(el("p", { className: "muted small", textContent: "보유 중인 선물권이 없습니다." }));
      } else {
        tiers.forEach((val) => {
          const cnt = vCounts[String(val)] || 0;
          if (!cnt) return;
          voucherWrap.appendChild(
            el("div", { className: "list-item" }, [
              el("div", {}, [
                el("strong", { textContent: `🎟️ +${val.toLocaleString()}P 선물권` }),
                el("div", { className: "muted small", textContent: `현재 ${cnt}장 보유 중` }),
              ]),
              el("button", {
                type: "button",
                className: "btn btn-pink btn-sm",
                textContent: `선물권 열기 (+${val.toLocaleString()}P)`,
                onClick: async () => {
                  try {
                    const res = await api("/api/vouchers/open", {
                      method: "POST",
                      body: { point_value: val },
                    });
                    showToast(`🎉 선물권을 열어 +${res.awarded.toLocaleString()}P를 받았습니다!`);
                    await refreshMe();
                    loadGiftPage();
                  } catch (err) {
                    showToast(err.message);
                  }
                },
              }),
            ])
          );
        });
      }
    }
    if (!(myGifts.received || []).length) {
      recWrap.appendChild(el("p", { className: "muted small", textContent: "받은 선물이 없습니다." }));
    } else {
      myGifts.received.forEach((g) => {
        recWrap.appendChild(
          el("div", { className: "list-item" }, [
            el("div", {}, [
              el("strong", { textContent: `${g.title}` }),
              el("div", { className: "muted small", textContent: `보낸이: ${g.sender_nickname}${g.message ? ` · "${g.message}"` : ""}` }),
            ]),
            el("span", { className: "muted small", textContent: formatDate(g.created_at).slice(0, 10) }),
          ])
        );
      });
    }

    if (!(myGifts.sent || []).length) {
      sentWrap.appendChild(el("p", { className: "muted small", textContent: "보낸 선물이 없습니다." }));
    } else {
      myGifts.sent.forEach((g) => {
        sentWrap.appendChild(
          el("div", { className: "list-item" }, [
            el("div", {}, [
              el("strong", { textContent: `${g.title}` }),
              el("div", { className: "muted small", textContent: `받는이: ${g.recipient_nickname}${g.message ? ` · "${g.message}"` : ""}` }),
            ]),
            el("span", { className: "badge-pink", textContent: g.cost > 0 ? `-${g.cost.toLocaleString()}P` : "선물권" }),
          ])
        );
      });
    }
  }

  // Admin
  async function loadAdminPage() {
    if (!state.user || !["admin", "staff"].includes(state.user.role)) return;
    const [stream, redRes, usersRes] = await Promise.all([
      api("/api/stream/status"),
      api("/api/admin/redemptions"),
      api("/api/admin/users"),
    ]);
    document.getElementById("adm-is-live").checked = Boolean(stream.is_live);
    document.getElementById("adm-stream-title").value = stream.title || "";
    document.getElementById("adm-stream-cat").value = stream.category || "";
    document.getElementById("adm-stream-banner").value = stream.notice_banner || "";

    state.adminUsers = usersRes.users || [];
    renderAdminBalances(state.adminUsers);

    const usersWrap = document.getElementById("admin-users-list");
    clear(usersWrap);
    const searchKw = (document.getElementById("adm-user-search")?.value || "").trim().toLowerCase();
    const ROLE_LABEL = { admin: "방송인", staff: "관리자(매니저)", user: "일반팬" };
    (usersRes.users || [])
      .filter((u) => {
        if (!searchKw) return true;
        return (
          u.username.toLowerCase().includes(searchKw) ||
          u.nickname.toLowerCase().includes(searchKw) ||
          (u.soop_id || "").toLowerCase().includes(searchKw)
        );
      })
      .forEach((u) => {
      const isTempBanned = Boolean(u.ban_until && new Date(u.ban_until) > new Date());
      const isBanned = Boolean(u.is_blacklisted || isTempBanned);
      const banLabel = u.is_blacklisted
        ? "⛔ 영구정지(블랙)"
        : isTempBanned
          ? `⏳ 기간정지 (~${u.ban_until.slice(0, 10)})`
          : "";

      const right = el("div", { className: "row-gap" });
      const hasBroadcasterPerm = state.user.role === "admin" || state.user.username === "1234gung";
      const canManageBan = u.role !== "admin" && u.username !== "1234gung" && (hasBroadcasterPerm || u.role === "user");
      const canDelete = canManageBan && u.id !== state.user.id;

      if (canManageBan) {
        right.appendChild(
          el("button", {
            type: "button",
            className: "btn btn-outline btn-sm",
            textContent: "관리",
            onClick: () => openUserManageModal(u, isBanned),
          })
        );
      }
      if (canDelete) {
        right.appendChild(
          el("button", {
            type: "button",
            className: "btn btn-danger btn-sm",
            textContent: "탈퇴",
            onClick: () => confirmDeleteUser(u),
          })
        );
      }

      const metaParts = [`${u.points.toLocaleString()}P · SOOP: `];
      if (u.soop_verified && u.soop_id) {
        metaParts.push(
          el("a", {
            href: `https://www.sooplive.com/station/${encodeURIComponent(u.soop_id)}`,
            target: "_blank",
            rel: "noopener noreferrer",
            className: "link-btn",
            textContent: `${u.soop_id} ↗`,
          })
        );
      } else if (u.soop_pending_id) {
        metaParts.push(`인증대기 (${u.soop_pending_id})`);
      } else {
        metaParts.push("미연동");
      }
      if (u.ban_reason) metaParts.push(` · 사유: ${u.ban_reason}`);

      usersWrap.appendChild(
        el("div", { className: "list-item" }, [
          el("div", {}, [
            el("div", { className: "row-gap" }, [
              el("strong", { textContent: `${u.nickname} (${u.username})` }),
              el("span", { className: "badge-pink", textContent: ROLE_LABEL[u.role] || u.role }),
              banLabel ? el("span", { className: "badge-pink", style: "background:#fee2e2; color:#b91c1c", textContent: banLabel }) : null,
            ]),
            el("div", { className: "muted small" }, metaParts),
          ]),
          right,
        ])
      );
    });

    const wrap = document.getElementById("admin-redemptions-list");
    clear(wrap);
    (redRes.redemptions || []).forEach((r) => {
      wrap.appendChild(
        el("div", { className: "list-item" }, [
          el("div", {}, [
            el("strong", { textContent: `${r.nickname} (${r.username}) — ${r.item_name}` }),
            el("div", { className: "muted small", textContent: `${r.cost}P · 상태: ${r.status}` }),
          ]),
          r.status === "pending"
            ? el("div", { className: "row-gap" }, [
                el("button", {
                  className: "btn btn-pink btn-sm",
                  textContent: "승인",
                  onClick: async () => {
                    await api(`/api/admin/redemptions/${r.id}`, {
                      method: "PATCH",
                      body: { status: "approved" },
                    });
                    loadAdminPage();
                  },
                }),
                el("button", {
                  className: "btn btn-danger btn-sm",
                  textContent: "반려(환불)",
                  onClick: async () => {
                    await api(`/api/admin/redemptions/${r.id}`, {
                      method: "PATCH",
                      body: { status: "rejected" },
                    });
                    loadAdminPage();
                  },
                }),
              ])
            : el("span", { className: "badge-pink", textContent: r.status }),
        ])
      );
    });

    const lookupInput = document.getElementById("adm-soop-lookup-input");
    await runAdminSoopLookup(lookupInput ? lookupInput.value : "");
    await loadSoopSdkCard();
  }

  let soopSdkInstance = null;
  let soopSdkConnected = false;

  function updateSoopSdkUi(cfg = null) {
    const statusEl = document.getElementById("adm-sdk-status");
    const connBtn = document.getElementById("adm-sdk-connect-btn");
    if (!statusEl || !connBtn) return;
    if (soopSdkConnected) {
      statusEl.textContent = "🟢 공식 SDK 연결됨";
      connBtn.textContent = "공식 SDK 연결 해제";
    } else if (cfg && cfg.has_token) {
      statusEl.textContent = "✅ 토큰 준비됨 (연결 가능)";
      connBtn.textContent = "공식 SDK 채팅 수집 시작";
    } else if (cfg && cfg.client_id && cfg.has_secret) {
      statusEl.textContent = "🔑 키 저장됨 (토큰 발급 필요)";
      connBtn.textContent = "공식 SDK 채팅 수집 시작";
    } else {
      statusEl.textContent = "미설정";
      connBtn.textContent = "공식 SDK 채팅 수집 시작";
    }
  }

  async function loadSoopSdkCard() {
    try {
      const params = new URLSearchParams(window.location.search);
      const oauthCode = params.get("code");
      if (oauthCode) {
        try {
          await api("/api/admin/soop-sdk/token", {
            method: "POST",
            body: { code: oauthCode, redirect_uri: `${window.location.origin}/admin` },
          });
          showToast("SOOP OAuth 토큰 발급이 완료되었습니다!");
          history.replaceState({ page: "admin" }, "", "/admin");
        } catch (err) {
          showToast(err.message);
        }
      }
      const cfg = await api("/api/admin/soop-sdk/config");
      state.soopSdkConfig = cfg;
      const cidInput = document.getElementById("adm-sdk-client-id");
      const secInput = document.getElementById("adm-sdk-client-secret");
      if (cidInput) cidInput.value = cfg.client_id || "";
      if (secInput) secInput.placeholder = cfg.has_secret ? "저장됨 (변경 시에만 입력)" : "Client Secret 입력";
      updateSoopSdkUi(cfg);
    } catch {
      // ignore if not admin
    }
  }

  async function connectSoopSdk() {
    if (!window.SOOP || !window.SOOP.ChatSDK) {
      return showToast("SOOP Chat SDK 스크립트를 불러오지 못했습니다. 네트워크를 확인하세요.");
    }
    let cfg = await api("/api/admin/soop-sdk/config");
    if (!cfg.client_id || !cfg.has_token) {
      return showToast("먼저 Client ID/Secret 저장 및 토큰 발급을 진행해 주세요.");
    }
    if (cfg.token_expires_at && cfg.token_expires_at < Math.floor(Date.now() / 1000) + 60 && cfg.has_refresh) {
      try {
        const ref = await api("/api/admin/soop-sdk/refresh", { method: "POST" });
        cfg.access_token = ref.access_token;
      } catch {
        // fallback to existing token
      }
    }

    try {
      const sdk = new window.SOOP.ChatSDK(cfg.client_id);
      if (typeof sdk.init === "function") sdk.init();
      sdk.setAuth(cfg.access_token);
      sdk.handleMessageReceived(async (action, message) => {
        if ((action === "MESSAGE" || action === "MANAGER_MESSAGE") && message && message.userId && message.message) {
          try {
            await api("/api/integrations/soop/sdk-message", {
              method: "POST",
              body: {
                user_id: String(message.userId),
                nickname: String(message.userNickname || ""),
                message: String(message.message),
                action,
              },
            });
          } catch {
            // silent retry on next message
          }
        }
      });
      if (typeof sdk.handleChatClosed === "function") {
        sdk.handleChatClosed(() => {
          soopSdkConnected = false;
          soopSdkInstance = null;
          updateSoopSdkUi(state.soopSdkConfig);
          showToast("SOOP 공식 Chat SDK 연결이 종료되었습니다.");
        });
      }
      if (typeof sdk.handleError === "function") {
        sdk.handleError((code, msg) => {
          showToast(`SOOP SDK 오류 (${code}): ${msg}`);
        });
      }
      await sdk.connect();
      soopSdkInstance = sdk;
      soopSdkConnected = true;
      updateSoopSdkUi(cfg);
      showToast("SOOP 공식 Chat SDK 연결 성공! 실시간 채팅 수집을 시작합니다.");
    } catch (err) {
      soopSdkConnected = false;
      updateSoopSdkUi(cfg);
      showToast(`SDK 연결 실패: ${err.message || err}`);
    }
  }

  function disconnectSoopSdk() {
    try {
      if (soopSdkInstance && typeof soopSdkInstance.disconnect === "function") {
        soopSdkInstance.disconnect();
      }
    } catch {
      // ignore
    }
    soopSdkInstance = null;
    soopSdkConnected = false;
    updateSoopSdkUi(state.soopSdkConfig);
    showToast("SOOP 공식 Chat SDK 연결이 해제되었습니다.");
  }

  async function runAdminSoopLookup(q = "") {
    const resWrap = document.getElementById("admin-soop-lookup-result");
    if (!resWrap) return;
    clear(resWrap);
    try {
      const data = await api(`/api/admin/soop-lookup?q=${encodeURIComponent((q || "").trim())}`);
      const list = data.users || [];
      if (!list.length) {
        resWrap.appendChild(el("p", { className: "muted small", textContent: "조건에 맞는 회원이 없습니다." }));
        return;
      }
      const nowMs = Date.now();
      list.forEach((u) => {
        const isTempBanned = Boolean(u.ban_until && new Date(u.ban_until).getTime() > nowMs);
        const banBadge = u.is_blacklisted
          ? el("span", { className: "badge-pink", style: "background:#fee2e2; color:#b91c1c", textContent: "⛔ 활동금지" })
          : isTempBanned
            ? el("span", { className: "badge-pink", style: "background:#fef3c7; color:#92400e", textContent: "⏳ 일시정지" })
            : null;

        const soopBadge = u.soop_verified && u.soop_id
          ? el("span", { className: "badge-pink", textContent: `✅ ${u.soop_id}` })
          : u.soop_pending_id
            ? el("span", { className: "badge-pink", style: "background:#fef3c7; color:#92400e", textContent: `⏳ 대기: ${u.soop_pending_id}` })
            : el("span", { className: "muted small", textContent: "미연동" });

        resWrap.appendChild(
          el(
            "div",
            {
              className: "list-item",
              style: "cursor:pointer",
              onClick: () => openSoopUserActionModal(u),
            },
            [
              el("div", {}, [
                el("div", { className: "row-gap" }, [
                  el("strong", { textContent: `${u.nickname} (${u.username})` }),
                  banBadge,
                ]),
                el("div", { className: "muted small", textContent: `보유 ${Number(u.points || 0).toLocaleString()}P · 눌러서 SOOP 상세/제재` }),
              ]),
              soopBadge,
            ]
          )
        );
      });
    } catch (err) {
      resWrap.appendChild(el("p", { className: "muted small", textContent: err.message }));
    }
  }

  function openSoopUserActionModal(u) {
    const nowMs = Date.now();
    const isTempBanned = Boolean(u.ban_until && new Date(u.ban_until).getTime() > nowMs);
    const isBanned = Boolean(u.is_blacklisted || isTempBanned);
    const stack = el("div", { className: "form-stack" });

    const soopInfo = u.soop_verified && u.soop_id
      ? el("div", { className: "info-box" }, [
          el("div", {}, [el("strong", { textContent: `✅ 연동된 SOOP 계정: ${u.soop_id}` })]),
          el("a", {
            href: u.soop_station_url || `https://www.sooplive.com/station/${encodeURIComponent(u.soop_id)}`,
            target: "_blank",
            rel: "noopener noreferrer",
            className: "btn btn-outline btn-sm mt-12",
            textContent: "SOOP 방송국 열기 ↗",
          }),
        ])
      : u.soop_pending_id
        ? el("div", { className: "info-box", textContent: `⏳ SOOP 인증 대기 중: ${u.soop_pending_id}` })
        : el("div", { className: "info-box", textContent: "❌ 연동된 SOOP 계정이 없습니다." });
    stack.appendChild(soopInfo);

    const statusText = u.is_blacklisted
      ? `⛔ 현재 영구 활동금지 상태 (사유: ${u.ban_reason || "-"})`
      : isTempBanned
        ? `⏳ 현재 활동일시정지 중 (~${formatDate(u.ban_until)} · 사유: ${u.ban_reason || "-"})`
        : "✅ 현재 정상 활동 중";
    stack.appendChild(el("div", { className: "muted small", textContent: statusText }));

    const canSanction = u.role !== "admin" && u.username !== "1234gung" && (state.user.role === "admin" || state.user.username === "1234gung" || u.role === "user");
    if (canSanction) {
      const reasonIn = el("input", { type: "text", maxlength: "120", placeholder: "제재 사유 입력 (선택)" });
      stack.appendChild(el("label", {}, ["제재 사유", reasonIn]));

      const applyBan = async (payload, okMsg) => {
        try {
          await api(`/api/admin/users/${u.id}/ban`, { method: "POST", body: payload });
          closeModal();
          showToast(okMsg);
          loadAdminPage();
        } catch (err) {
          showToast(err.message);
        }
      };

      const btnGrid = el("div", { className: "row-gap", style: "flex-wrap:wrap" }, [
        el("button", {
          type: "button",
          className: "btn btn-outline btn-sm",
          textContent: "⏳ 1시간 정지",
          onClick: () => applyBan({ mode: "temp", hours: 1, reason: reasonIn.value }, `${u.nickname}님 1시간 활동일시정지 처리 완료`),
        }),
        el("button", {
          type: "button",
          className: "btn btn-outline btn-sm",
          textContent: "⏳ 하루 정지",
          onClick: () => applyBan({ mode: "temp", days: 1, reason: reasonIn.value }, `${u.nickname}님 하루 활동일시정지 처리 완료`),
        }),
        el("button", {
          type: "button",
          className: "btn btn-outline btn-sm",
          textContent: "⏳ 일주일 정지",
          onClick: () => applyBan({ mode: "temp", days: 7, reason: reasonIn.value }, `${u.nickname}님 일주일 활동일시정지 처리 완료`),
        }),
        el("button", {
          type: "button",
          className: "btn btn-danger btn-sm",
          textContent: "⛔ 활동금지(영구)",
          onClick: () => applyBan({ mode: "black", reason: reasonIn.value }, `${u.nickname}님 영구 활동금지 처리 완료`),
        }),
        el("button", {
          type: "button",
          className: "btn btn-pink btn-sm",
          textContent: "✅ 모든 제재 해제",
          onClick: () => applyBan({ mode: "unban" }, `${u.nickname}님의 모든 제재가 해제되었습니다.`),
        }),
      ]);
      if (u.id !== state.user.id) {
        btnGrid.appendChild(
          el("button", {
            type: "button",
            className: "btn btn-danger btn-sm",
            textContent: "🗑️ 계정 삭제",
            onClick: () => confirmDeleteUser(u),
          })
        );
      }
      stack.appendChild(btnGrid);
    }

    openModal(`${u.nickname} (${u.username}) SOOP · 제재`, stack);
  }

  async function handleAttendance() {
    if (!state.user) return showToast("로그인 후 출석체크를 할 수 있습니다.");
    try {
      const res = await api("/api/points/attendance", { method: "POST" });
      showToast(`출석체크 완료! +${res.awarded}P 적립`);
      await refreshMe();
      if (state.page === "points") loadPointsPage();
    } catch (err) {
      showToast(err.message);
    }
  }

  // Event Bindings
  function bindEvents() {
    document.getElementById("brand-home").addEventListener("click", () => switchPage("home"));
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchPage(btn.dataset.page));
    });
    document.querySelectorAll("[data-goto]").forEach((btn) => {
      btn.addEventListener("click", () => switchPage(btn.dataset.goto));
    });

    document.getElementById("modal-close-btn").addEventListener("click", closeModal);
    document.getElementById("modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "modal-backdrop") closeModal();
    });

    document.getElementById("home-attendance-btn").addEventListener("click", handleAttendance);
    document.getElementById("points-attendance-btn").addEventListener("click", handleAttendance);

    document.getElementById("notice-write-btn").addEventListener("click", () => showWritePostModal("notice", true));
    document.getElementById("board-write-btn").addEventListener("click", () => showWritePostModal("free", false));
    document.getElementById("shop-add-btn").addEventListener("click", () => {
      const nameIn = el("input", { type: "text", required: "true", maxlength: "60", placeholder: "상품명" });
      const costIn = el("input", { type: "number", required: "true", min: "1", placeholder: "필요 포인트" });
      const stockIn = el("input", { type: "number", required: "true", min: "0", value: "10" });
      const descIn = el("input", { type: "text", required: "true", maxlength: "200", placeholder: "상품 설명" });
      const form = el("form", { className: "form-stack" }, [
        el("label", {}, ["상품명", nameIn]),
        el("label", {}, ["필요 포인트", costIn]),
        el("label", {}, ["재고 수량", stockIn]),
        el("label", {}, ["설명", descIn]),
        el("button", { type: "submit", className: "btn btn-pink", textContent: "상품 등록" }),
      ]);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await api("/api/shop/items", {
            method: "POST",
            body: {
              name: nameIn.value,
              cost: Number(costIn.value),
              stock: Number(stockIn.value),
              description: descIn.value,
            },
          });
          closeModal();
          showToast("상품이 등록되었습니다.");
          loadPointsPage();
        } catch (err) {
          showToast(err.message);
        }
      });
      openModal("포인트 상점 상품 추가", form);
    });

    document.querySelectorAll("#board-tabs .pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll("#board-tabs .pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        state.boardTab = pill.dataset.tab;
        loadBoard();
      });
    });

    document.getElementById("board-search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      loadBoard();
    });
    document.getElementById("board-sort-select").addEventListener("change", (e) => {
      state.boardSort = e.target.value;
      loadBoard();
    });
    document.getElementById("notice-search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      state.noticePage = 1;
      loadNotices();
    });
    document.querySelectorAll("#notice-subtabs .pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll("#notice-subtabs .pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        state.noticeSubTab = pill.dataset.ntab;
        loadNotices();
      });
    });

    document.querySelectorAll("#sig-categories .pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll("#sig-categories .pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        state.sigCategory = pill.dataset.cat;
        renderFilteredSignatures();
      });
    });

    document.getElementById("sig-search-input").addEventListener("input", (e) => {
      state.sigKeyword = e.target.value;
      renderFilteredSignatures();
    });
    document.getElementById("sig-sort-select").addEventListener("change", (e) => {
      state.sigSort = e.target.value;
      renderFilteredSignatures();
    });
    document.getElementById("sig-add-btn").addEventListener("click", () => showSignatureModal(null));

    document.getElementById("cal-prev").addEventListener("click", () => {
      state.calMonth -= 1;
      if (state.calMonth < 1) { state.calMonth = 12; state.calYear -= 1; }
      loadCalendar();
    });
    document.getElementById("cal-next").addEventListener("click", () => {
      state.calMonth += 1;
      if (state.calMonth > 12) { state.calMonth = 1; state.calYear += 1; }
      loadCalendar();
    });
    document.getElementById("cal-add-btn").addEventListener("click", () => {
      const ym = `${state.calYear}-${String(state.calMonth).padStart(2, "0")}`;
      showCalendarEventModal(null, `${ym}-20`);
    });

    // SOOP Link Request
    document.getElementById("soop-link-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.user) return showToast("로그인 후 이용 가능합니다.");
      try {
        const res = await api("/api/soop/link/request", {
          method: "POST",
          body: { soop_id: document.getElementById("soop-id-input").value },
        });
        state.user.soop_pending_id = res.soop_pending_id;
        state.user.soop_verify_code = res.soop_verify_code;
        renderSoopLinkSection();
        showToast(`인증 코드(${res.soop_verify_code})가 발급되었습니다!`);
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById("soop-unlink-btn").addEventListener("click", async () => {
      await api("/api/soop/link", { method: "DELETE" });
      showToast("SOOP 연동이 해제되었습니다.");
      await refreshMe();
    });

    document.getElementById("collector-refresh-btn").addEventListener("click", refreshCollectorStatus);

    document.querySelectorAll("#gift-type-tabs .pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll("#gift-type-tabs .pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        currentGiftType = pill.dataset.gtype;
        document.getElementById("gift-field-point").classList.toggle("hidden", currentGiftType !== "point");
        document.getElementById("gift-field-voucher").classList.toggle("hidden", currentGiftType !== "voucher");
        document.getElementById("gift-field-item").classList.toggle("hidden", currentGiftType !== "item");
        document.getElementById("gift-field-emoticon").classList.toggle("hidden", currentGiftType !== "emoticon");
      });
    });

    document.getElementById("gift-send-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.user) return showToast("로그인 후 선물할 수 있습니다.");
      try {
        const payload = {
          recipient: document.getElementById("gift-recipient").value,
          gift_type: currentGiftType,
          message: document.getElementById("gift-message").value,
        };
        if (currentGiftType === "point") payload.amount = Number(document.getElementById("gift-amount").value);
        else if (currentGiftType === "voucher") {
          payload.voucher_value = Number(document.getElementById("gift-voucher-value").value);
          payload.quantity = Number(document.getElementById("gift-voucher-qty").value || 1);
        }
        else if (currentGiftType === "item") payload.item_id = Number(document.getElementById("gift-item-select").value) || null;
        else if (currentGiftType === "emoticon") payload.emoticon_id = document.getElementById("gift-emoticon-select").value;

        const res = await api("/api/gifts/send", { method: "POST", body: payload });
        showToast(`${res.recipient}님께 '${res.title}' 선물을 보냈습니다!`);
        e.target.reset();
        await refreshMe();
        loadGiftPage();
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById("admin-voucher-grant-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const res = await api("/api/admin/vouchers/grant", {
          method: "POST",
          body: {
            recipient: document.getElementById("adm-voucher-recipient").value,
            point_value: Number(document.getElementById("adm-voucher-value").value),
            quantity: Number(document.getElementById("adm-voucher-qty").value || 1),
            message: document.getElementById("adm-voucher-msg").value,
          },
        });
        showToast(`${res.recipient}님께 +${res.point_value.toLocaleString()}P 선물권 ${res.quantity}장을 지급했습니다!`);
        e.target.reset();
        document.getElementById("adm-voucher-qty").value = "1";
        loadGiftPage();
      } catch (err) {
        showToast(err.message);
      }
    });

    document.querySelectorAll("#points-subtabs .pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll("#points-subtabs .pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        const target = pill.dataset.ptab;
        document.querySelectorAll(".ptab-panel").forEach((panel) => {
          panel.classList.toggle("hidden", panel.id !== `ptab-${target}`);
        });
      });
    });

    document.getElementById("pred-add-btn").addEventListener("click", () => {
      const titleIn = el("input", { type: "text", required: "true", maxlength: "120", placeholder: "예: 오늘 게임 1등은 누구?" });
      const optsWrap = el("div", { className: "form-stack" });
      const optInputs = [];

      function addOptionRow(placeholder = "") {
        if (optInputs.length >= 10) return showToast("항목은 최대 10개까지 추가할 수 있습니다.");
        const inp = el("input", { type: "text", required: "true", maxlength: "40", placeholder: placeholder || `항목 ${optInputs.length + 1}` });
        optInputs.push(inp);
        const row = el("div", { className: "row-gap" }, [
          inp,
          optInputs.length > 2
            ? el("button", {
                type: "button",
                className: "btn btn-danger btn-sm",
                textContent: "✕",
                onClick: () => {
                  const idx = optInputs.indexOf(inp);
                  if (idx >= 0) optInputs.splice(idx, 1);
                  row.remove();
                },
              })
            : null,
        ]);
        inp.style.flex = "1";
        optsWrap.appendChild(row);
      }

      addOptionRow("항목 1 (예: 체온 승)");
      addOptionRow("항목 2 (예: 상대 승)");

      const addOptBtn = el("button", {
        type: "button",
        className: "btn btn-outline btn-sm",
        textContent: "+ 항목 추가 (최대 10개)",
        onClick: () => addOptionRow(),
      });

      const closesIn = el("input", { type: "datetime-local" });
      function setPresetMinutes(mins) {
        const d = new Date(Date.now() + mins * 60000);
        const pad = (n) => String(n).padStart(2, "0");
        closesIn.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }

      const form = el("form", { className: "form-stack" }, [
        el("label", {}, ["승부예측 제목 *", titleIn]),
        el("div", { className: "row-gap", style: "justify-content:space-between" }, [
          el("strong", { className: "small", textContent: "예측 항목 (2~10개)" }),
          addOptBtn,
        ]),
        optsWrap,
        el("label", {}, ["베팅 자동 마감 시간 (비워두면 수동 마감)", closesIn]),
        el("div", { className: "row-gap" }, [
          el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "5분 뒤", onClick: () => setPresetMinutes(5) }),
          el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "10분 뒤", onClick: () => setPresetMinutes(10) }),
          el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "30분 뒤", onClick: () => setPresetMinutes(30) }),
          el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "1시간 뒤", onClick: () => setPresetMinutes(60) }),
          el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "마감 없음", onClick: () => { closesIn.value = ""; } }),
        ]),
        el("div", { className: "modal-footer-end" }, [
          el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "취소", onClick: closeModal }),
          el("button", { type: "submit", className: "btn btn-pink btn-sm", textContent: "승부예측 열기" }),
        ]),
      ]);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const options = optInputs.map((i) => i.value.trim()).filter(Boolean);
        if (options.length < 2) return showToast("최소 2개 이상의 항목을 입력하세요.");
        try {
          await api("/api/predictions", {
            method: "POST",
            body: { title: titleIn.value, options, closes_at: closesIn.value || null },
          });
          closeModal();
          showToast("새 승부예측이 열렸습니다!");
          loadPredictions();
        } catch (err) {
          showToast(err.message);
        }
      });
      openModal("새 승부예측 만들기", form);
    });

    let activeGameTab = "suika";
  let gameTabsBound = false;

  function loadGamePage() {
    const gameCtx = {
      api,
      getUser: () => state.user,
      onPointsChanged: (newPoints) => {
        if (state.user && typeof newPoints === "number") {
          state.user.points = newPoints;
          renderAuthArea();
          renderHomeUserBox();
        }
      },
      showToast,
    };

    const showGameTab = (tabName) => {
      activeGameTab = tabName === "omok" ? "omok" : "suika";
      document.querySelectorAll("#game-tabs .pill").forEach((b) => {
        b.classList.toggle("active", b.dataset.gtab === activeGameTab);
      });
      const suikaPanel = document.getElementById("game-panel-suika");
      const omokPanel = document.getElementById("game-panel-omok");
      if (suikaPanel) suikaPanel.classList.toggle("hidden", activeGameTab !== "suika");
      if (omokPanel) omokPanel.classList.toggle("hidden", activeGameTab !== "omok");

      if (activeGameTab === "suika" && window.ChaeonSuika) {
        window.ChaeonSuika.initPage(gameCtx);
      } else if (activeGameTab === "omok" && window.ChaeonOmok) {
        window.ChaeonOmok.initPage(gameCtx);
      }
    };

    if (!gameTabsBound) {
      gameTabsBound = true;
      document.querySelectorAll("#game-tabs .pill").forEach((btn) => {
        btn.addEventListener("click", () => showGameTab(btn.dataset.gtab));
      });
    }

    showGameTab(activeGameTab);
  }

  // Gift Page
  let currentGiftType = "point";

  async function loadGiftPage() {
    const ptsBadge = document.getElementById("gift-my-points");
    ptsBadge.textContent = state.user ? `보유: ${state.user.points.toLocaleString()} P` : "보유: - P";

    const opts = await api("/api/gifts/options");

    const itemSel = document.getElementById("gift-item-select");
    clear(itemSel);
    if (!(opts.items || []).length) {
      itemSel.appendChild(el("option", { value: "", textContent: "현재 상점에 등록된 아이템이 없습니다." }));
    } else {
      opts.items.forEach((it) => {
        itemSel.appendChild(el("option", { value: String(it.id), textContent: `${it.name} (${it.cost.toLocaleString()}P · 재고 ${it.stock})` }));
      });
    }

    const emoSel = document.getElementById("gift-emoticon-select");
    clear(emoSel);
    if (!(opts.emoticons || []).length) {
      emoSel.appendChild(el("option", { value: "", textContent: "현재 등록된 이모티콘이 없습니다." }));
    } else {
      opts.emoticons.forEach((em) => {
        emoSel.appendChild(el("option", { value: em.id, textContent: `${em.name} (${em.cost}P)` }));
      });
    }

    const recWrap = document.getElementById("gift-received-list");
    const sentWrap = document.getElementById("gift-sent-list");
    const voucherWrap = document.getElementById("my-vouchers-list");
    const voucherHint = document.getElementById("gift-voucher-owned-hint");
    const adminVoucherCard = document.getElementById("gift-admin-voucher-card");
    clear(recWrap);
    clear(sentWrap);
    if (voucherWrap) clear(voucherWrap);
    if (adminVoucherCard) adminVoucherCard.classList.toggle("hidden", !isStaffOrAdmin());

    if (!state.user) {
      recWrap.appendChild(el("p", { className: "muted", textContent: "로그인 후 확인할 수 있습니다." }));
      sentWrap.appendChild(el("p", { className: "muted", textContent: "로그인 후 확인할 수 있습니다." }));
      if (voucherWrap) voucherWrap.appendChild(el("p", { className: "muted", textContent: "로그인 후 확인할 수 있습니다." }));
      if (voucherHint) voucherHint.textContent = "로그인 후 보유 장수를 확인할 수 있습니다.";
      return;
    }

    const [myGifts, myVouchers] = await Promise.all([api("/api/gifts/me"), api("/api/vouchers/me")]);
    const vCounts = myVouchers.counts || { "1000": 0, "5000": 0, "10000": 0 };
    if (voucherHint) {
      voucherHint.textContent = `내 보유: +1,000P ${vCounts["1000"] || 0}장 · +5,000P ${vCounts["5000"] || 0}장 · +10,000P ${vCounts["10000"] || 0}장`;
    }
    if (voucherWrap) {
      const tiers = [1000, 5000, 10000];
      const totalV = tiers.reduce((acc, v) => acc + (vCounts[String(v)] || 0), 0);
      if (totalV === 0) {
        voucherWrap.appendChild(el("p", { className: "muted small", textContent: "보유 중인 선물권이 없습니다." }));
      } else {
        tiers.forEach((val) => {
          const cnt = vCounts[String(val)] || 0;
          if (!cnt) return;
          voucherWrap.appendChild(
            el("div", { className: "list-item" }, [
              el("div", {}, [
                el("strong", { textContent: `🎟️ +${val.toLocaleString()}P 선물권` }),
                el("div", { className: "muted small", textContent: `현재 ${cnt}장 보유 중` }),
              ]),
              el("button", {
                type: "button",
                className: "btn btn-pink btn-sm",
                textContent: `선물권 열기 (+${val.toLocaleString()}P)`,
                onClick: async () => {
                  try {
                    const res = await api("/api/vouchers/open", {
                      method: "POST",
                      body: { point_value: val },
                    });
                    showToast(`🎉 선물권을 열어 +${res.awarded.toLocaleString()}P를 받았습니다!`);
                    await refreshMe();
                    loadGiftPage();
                  } catch (err) {
                    showToast(err.message);
                  }
                },
              }),
            ])
          );
        });
      }
    }
    if (!(myGifts.received || []).length) {
      recWrap.appendChild(el("p", { className: "muted small", textContent: "받은 선물이 없습니다." }));
    } else {
      myGifts.received.forEach((g) => {
        recWrap.appendChild(
          el("div", { className: "list-item" }, [
            el("div", {}, [
              el("strong", { textContent: `${g.title}` }),
              el("div", { className: "muted small", textContent: `보낸이: ${g.sender_nickname}${g.message ? ` · "${g.message}"` : ""}` }),
            ]),
            el("span", { className: "muted small", textContent: formatDate(g.created_at).slice(0, 10) }),
          ])
        );
      });
    }

    if (!(myGifts.sent || []).length) {
      sentWrap.appendChild(el("p", { className: "muted small", textContent: "보낸 선물이 없습니다." }));
    } else {
      myGifts.sent.forEach((g) => {
        sentWrap.appendChild(
          el("div", { className: "list-item" }, [
            el("div", {}, [
              el("strong", { textContent: `${g.title}` }),
              el("div", { className: "muted small", textContent: `받는이: ${g.recipient_nickname}${g.message ? ` · "${g.message}"` : ""}` }),
            ]),
            el("span", { className: "badge-pink", textContent: g.cost > 0 ? `-${g.cost.toLocaleString()}P` : "선물권" }),
          ])
        );
      });
    }
  }

  function confirmDeleteUser(u) {
    const errBox = el("div", { className: "muted small", style: "color:#b91c1c" });
    const confirmBtn = el("button", { type: "button", className: "btn btn-danger btn-sm", textContent: "탈퇴 확정" });
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "처리 중...";
      errBox.textContent = "";
      try {
        await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
        closeModal();
        showToast(`${u.nickname} (${u.username}) 회원이 탈퇴(삭제) 처리되었습니다.`);
        await loadAdminPage();
      } catch (err) {
        errBox.textContent = err.message || "삭제 중 오류가 발생했습니다.";
        showToast(err.message || "삭제 중 오류가 발생했습니다.");
        confirmBtn.disabled = false;
        confirmBtn.textContent = "탈퇴 확정";
      }
    });
    const confirmBox = el("div", { className: "form-stack" }, [
      el("p", {
        textContent: `정말 '${u.nickname} (${u.username})' 회원을 탈퇴(삭제) 시키겠습니까?`,
      }),
      el("p", {
        className: "muted small",
        textContent: "탈퇴 처리 후에는 되돌릴 수 없으며, 해당 계정의 활동 데이터도 함께 삭제됩니다.",
      }),
      errBox,
      el("div", { className: "modal-footer-end" }, [
        el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "취소", onClick: closeModal }),
        confirmBtn,
      ]),
    ]);
    openModal("회원 강제 탈퇴 확인", confirmBox);
  }

  function openUserManageModal(u, isBanned) {
    const stack = el("div", { className: "form-stack" });

    if (state.user.role === "admin" || state.user.username === "1234gung") {
      const roleSelect = el("select", {}, [
        el("option", { value: "user", textContent: "일반팬" }),
        el("option", { value: "staff", textContent: "관리자(매니저)" }),
      ]);
      roleSelect.value = u.role === "staff" ? "staff" : "user";
      stack.appendChild(
        el("div", { className: "row-gap" }, [
          roleSelect,
          el("button", {
            type: "button",
            className: "btn btn-pink btn-sm",
            textContent: "권한 저장",
            onClick: async () => {
              await api(`/api/admin/users/${u.id}/role`, {
                method: "PATCH",
                body: { role: roleSelect.value },
              });
              closeModal();
              showToast(`${u.nickname}님 권한이 변경되었습니다.`);
              loadAdminPage();
            },
          }),
          el("button", {
            type: "button",
            className: "btn btn-outline btn-sm",
            textContent: "👑 방송인으로 승격",
            onClick: () => {
              const confirmForm = el("form", { className: "form-stack" }, [
                el("p", { textContent: `정말 '${u.nickname} (${u.username})'님을 방송인(최고관리자)으로 승격하시겠습니까?` }),
                el("div", { className: "modal-footer-end" }, [
                  el("button", { type: "button", className: "btn btn-outline btn-sm", textContent: "취소", onClick: closeModal }),
                  el("button", { type: "submit", className: "btn btn-pink btn-sm", textContent: "방송인 승격 확정" }),
                ]),
              ]);
              confirmForm.addEventListener("submit", async (e) => {
                e.preventDefault();
                await api(`/api/admin/users/${u.id}/transfer-owner`, { method: "POST" });
                closeModal();
                showToast(`${u.nickname}님이 방송인으로 승격되었습니다.`);
                await refreshMe();
                loadAdminPage();
              });
              openModal("방송인 승격", confirmForm);
            },
          }),
        ])
      );
    }

    stack.appendChild(
      el("button", {
        type: "button",
        className: "btn btn-pink btn-sm",
        textContent: "✅ 모든 제재 해제",
        onClick: async () => {
          await api(`/api/admin/users/${u.id}/ban`, { method: "POST", body: { mode: "unban" } });
          closeModal();
          showToast(`${u.nickname}님의 모든 제재가 해제되었습니다.`);
          loadAdminPage();
        },
      })
    );
    if (!isBanned) {
      const daysIn = el("input", { type: "number", min: "1", max: "3650", value: "7", style: "width:90px" });
      const reasonIn = el("input", { type: "text", maxlength: "120", placeholder: "정지 사유", style: "flex:1" });
      stack.appendChild(
        el("div", { className: "row-gap", style: "flex-wrap:wrap" }, [
          daysIn,
          reasonIn,
          el("button", {
            type: "button",
            className: "btn btn-outline btn-sm",
            textContent: "기간정지",
            onClick: async () => {
              await api(`/api/admin/users/${u.id}/ban`, {
                method: "POST",
                body: { mode: "temp", days: Number(daysIn.value || 7), reason: reasonIn.value },
              });
              closeModal();
              showToast(`${u.nickname}님 ${daysIn.value}일 정지 처리 완료`);
              loadAdminPage();
            },
          }),
          el("button", {
            type: "button",
            className: "btn btn-danger btn-sm",
            textContent: "블랙(영구정지)",
            onClick: async () => {
              await api(`/api/admin/users/${u.id}/ban`, {
                method: "POST",
                body: { mode: "black", reason: reasonIn.value },
              });
              closeModal();
              showToast(`${u.nickname}님 영구정지(블랙) 처리 완료`);
              loadAdminPage();
            },
          }),
        ])
      );
    }

    if (u.role !== "admin" && u.id !== state.user.id && (state.user.role === "admin" || u.role === "user")) {
      stack.appendChild(
        el("button", {
          type: "button",
          className: "btn btn-danger btn-sm",
          textContent: "회원 강제 탈퇴",
          onClick: () => confirmDeleteUser(u),
        })
      );
    }

    openModal(`${u.nickname} (${u.username}) 관리`, stack);
  }

  function switchAdminTab(tabName) {
    document.querySelectorAll("#admin-tabs .pill").forEach((p) => p.classList.toggle("active", p.dataset.atab === tabName));
    const ov = document.getElementById("admin-tab-overview");
    const bal = document.getElementById("admin-tab-balances");
    if (ov) ov.classList.toggle("hidden", tabName !== "overview");
    if (bal) bal.classList.toggle("hidden", tabName !== "balances");
  }

  function renderAdminBalances(users = []) {
    const listWrap = document.getElementById("admin-balances-list");
    const summaryEl = document.getElementById("adm-total-points-summary");
    if (!listWrap) return;
    clear(listWrap);

    const totalPts = users.reduce((acc, u) => acc + Number(u.points || 0), 0);
    if (summaryEl) summaryEl.textContent = `총 ${users.length}명 · 합계 ${totalPts.toLocaleString()}P`;

    const kw = (document.getElementById("adm-balance-search")?.value || "").trim().toLowerCase();
    const sortMode = document.getElementById("adm-balance-sort")?.value || "desc";
    const ROLE_LABEL = { admin: "방송인", staff: "관리자(매니저)", user: "일반팬" };

    const filtered = users
      .filter((u) => {
        if (!kw) return true;
        return (
          u.username.toLowerCase().includes(kw) ||
          u.nickname.toLowerCase().includes(kw) ||
          (u.soop_id || "").toLowerCase().includes(kw)
        );
      })
      .slice()
      .sort((a, b) => {
        if (sortMode === "asc") return a.points - b.points || a.id - b.id;
        if (sortMode === "id") return a.id - b.id;
        return b.points - a.points || a.id - b.id;
      });

    if (!filtered.length) {
      listWrap.appendChild(el("p", { className: "muted small", textContent: "조건에 맞는 회원이 없습니다." }));
      return;
    }

    const nowMs = Date.now();
    filtered.forEach((u, idx) => {
      const hasDouble = Boolean(u.double_points_until && new Date(u.double_points_until).getTime() > nowMs);
      const soopText = u.soop_verified && u.soop_id ? `SOOP: ${u.soop_id}` : "SOOP 미연동";
      listWrap.appendChild(
        el("div", { className: "list-item" }, [
          el("div", {}, [
            el("div", { className: "row-gap" }, [
              el("strong", { textContent: `${idx + 1}. ${u.nickname} (${u.username})` }),
              el("span", { className: "badge-pink", textContent: ROLE_LABEL[u.role] || u.role }),
              hasDouble ? el("span", { className: "badge-pink", style: "background:#fef3c7; color:#92400e", textContent: "⚡ 2배 적용중" }) : null,
            ]),
            el("div", { className: "muted small", textContent: soopText }),
          ]),
          el("div", { className: "row-gap" }, [
            el("strong", { style: "color:var(--pink-600); font-size:1.05rem", textContent: `${Number(u.points || 0).toLocaleString()} P` }),
            el("button", {
              type: "button",
              className: "btn btn-outline btn-sm",
              textContent: "지급/회수",
              onClick: () => {
                switchAdminTab("overview");
                const ptUser = document.getElementById("adm-pt-user");
                if (ptUser) {
                  ptUser.value = u.username;
                  ptUser.focus();
                }
              },
            }),
          ]),
        ])
      );
    });
  }

  // Admin forms
    document.querySelectorAll("#admin-tabs .pill").forEach((pill) => {
      pill.addEventListener("click", () => switchAdminTab(pill.dataset.atab));
    });
    document.getElementById("adm-balance-search").addEventListener("input", () => {
      renderAdminBalances(state.adminUsers || []);
    });
    document.getElementById("adm-balance-sort").addEventListener("change", () => {
      renderAdminBalances(state.adminUsers || []);
    });

    document.getElementById("admin-stream-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/stream/status", {
          method: "PUT",
          body: {
            is_live: document.getElementById("adm-is-live").checked,
            title: document.getElementById("adm-stream-title").value,
            category: document.getElementById("adm-stream-cat").value,
            notice_banner: document.getElementById("adm-stream-banner").value,
          },
        });
        showToast("방송 상태가 저장되었습니다.");
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById("admin-points-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const res = await api("/api/admin/points/adjust", {
          method: "POST",
          body: {
            username: document.getElementById("adm-pt-user").value,
            delta: Number(document.getElementById("adm-pt-delta").value),
            reason: document.getElementById("adm-pt-reason").value,
          },
        });
        showToast(`${res.username}님 잔액: ${res.new_balance.toLocaleString()}P`);
        await refreshMe();
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById("admin-role-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const target = document.getElementById("adm-role-target").value;
        const role = document.getElementById("adm-role-select").value;
        const res = await api("/api/admin/users/role-by-name", {
          method: "POST",
          body: { target, role },
        });
        showToast(`${res.nickname}님 권한이 '${role}'(으)로 변경되었습니다.`);
        e.target.reset();
        await refreshMe();
        loadAdminPage();
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById("adm-user-search").addEventListener("input", () => {
      loadAdminPage();
    });

    document.getElementById("admin-sig-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const cat = document.getElementById("adm-sig-cat").value;
      const tags = cat === "NEW" ? "new" : cat === "열혈" ? "hot" : "";
      try {
        await api("/api/signatures", {
          method: "POST",
          body: {
            title: document.getElementById("adm-sig-title").value,
            balloon_count: Number(document.getElementById("adm-sig-count").value),
            category: cat,
            tags,
            badge: document.getElementById("adm-sig-badge").value,
            description: document.getElementById("adm-sig-desc").value,
          },
        });
        showToast("시그니처가 등록되었습니다.");
        e.target.reset();
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById("admin-cal-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/calendar", {
          method: "POST",
          body: {
            title: document.getElementById("adm-cal-title").value,
            event_date: document.getElementById("adm-cal-date").value,
            start_time: document.getElementById("adm-cal-time").value,
            category: document.getElementById("adm-cal-cat").value,
            description: document.getElementById("adm-cal-desc").value,
            color: document.getElementById("adm-cal-color").value,
          },
        });
        showToast("일정이 등록되었습니다.");
        e.target.reset();
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById("emoticon-create-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const name = document.getElementById("emo-name").value.trim();
        const glyph = document.getElementById("emo-glyph").value.trim();
        const fileInput = document.getElementById("emo-file");
        let image_url = "";
        if (fileInput && fileInput.files && fileInput.files[0]) {
          const fd = new FormData();
          fd.append("files", fileInput.files[0]);
          const up = await api("/api/uploads", { method: "POST", body: fd });
          image_url = up.files?.[0]?.url || "";
        }
        await api("/api/emoticons", {
          method: "POST",
          body: { name, glyph, image_url },
        });
        showToast("이모티콘이 등록되었습니다. 이제 공홈에서 사용할 수 있습니다!");
        e.target.reset();
        await loadEmoticonsPage();
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById("admin-soop-lookup-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      await runAdminSoopLookup(document.getElementById("adm-soop-lookup-input").value);
    });

    document.getElementById("admin-sdk-config-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/admin/soop-sdk/config", {
          method: "PUT",
          body: {
            client_id: document.getElementById("adm-sdk-client-id").value,
            client_secret: document.getElementById("adm-sdk-client-secret").value,
          },
        });
        document.getElementById("adm-sdk-client-secret").value = "";
        showToast("SOOP API 키가 저장되었습니다.");
        await loadSoopSdkCard();
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById("adm-sdk-oauth-btn").addEventListener("click", () => {
      const clientId = (document.getElementById("adm-sdk-client-id")?.value || "").trim();
      if (!clientId) return showToast("먼저 Client ID를 입력하고 저장해 주세요.");
      const authUrl = `https://openapi.sooplive.com/auth/code?client_id=${encodeURIComponent(clientId)}&scope=broad_access_chatinfo`;
      window.location.href = authUrl;
    });

    document.getElementById("adm-sdk-cert-btn").addEventListener("click", async () => {
      const cert = (document.getElementById("adm-sdk-cert-num")?.value || "").trim();
      if (!cert) return showToast("SOOP 앱 6자리 인증번호를 입력하세요.");
      try {
        await api("/api/admin/soop-sdk/token", {
          method: "POST",
          body: { certification_number: cert },
        });
        document.getElementById("adm-sdk-cert-num").value = "";
        showToast("SOOP 액세스 토큰 발급 완료! 이제 연결할 수 있습니다.");
        await loadSoopSdkCard();
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById("adm-sdk-connect-btn").addEventListener("click", async () => {
      if (soopSdkConnected) disconnectSoopSdk();
      else await connectSoopSdk();
    });

    document.getElementById("admin-shop-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/shop/items", {
          method: "POST",
          body: {
            name: document.getElementById("adm-shop-name").value,
            cost: Number(document.getElementById("adm-shop-cost").value),
            stock: Number(document.getElementById("adm-shop-stock").value),
            description: document.getElementById("adm-shop-desc").value,
          },
        });
        showToast("상점 상품이 등록되었습니다.");
        e.target.reset();
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  async function syncFromLocation() {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
    const validPages = ["home", "notice", "board", "signatures", "emoticons", "calendar", "points", "game", "gift", "admin"];
    const targetPage = validPages.includes(path) ? path : "home";
    switchPage(targetPage, false);

    const postParam = new URLSearchParams(window.location.search).get("post");
    if (postParam && /^\d+$/.test(postParam)) {
      await openPostDetail(Number(postParam), false);
    } else {
      document.getElementById("modal-backdrop").classList.add("hidden");
    }
  }

  function initInstallBanner() {
    const banner = document.getElementById("install-banner");
    const installBtn = document.getElementById("install-app-btn");
    const dismissBtn = document.getElementById("install-dismiss-btn");
    if (!banner || !installBtn || !dismissBtn) return;

    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    const dismissed = localStorage.getItem("chaeon_install_dismissed_v1") === "1";
    if (!isStandalone && !dismissed) {
      banner.classList.remove("hidden");
    }

    let deferredPrompt = null;
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
    });

    installBtn.addEventListener("click", async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        deferredPrompt = null;
        if (choice && choice.outcome === "accepted") {
          banner.classList.add("hidden");
          localStorage.setItem("chaeon_install_dismissed_v1", "1");
        }
        return;
      }
      const guide = el("div", { className: "form-stack" }, [
        el("p", { textContent: "브라우저 메뉴에서 홈 화면에 추가하면 앱처럼 바로 실행할 수 있습니다." }),
        el("div", { className: "info-box small" }, [
          el("div", { textContent: "📱 Android (Chrome): 우측 상단 ⋮ 메뉴 → '앱 설치' 또는 '홈 화면에 추가'" }),
          el("div", { className: "mt-12", textContent: "🍎 iPhone (Safari): 하단 공유 버튼(⬆️) → '홈 화면에 추가'" }),
          el("div", { className: "mt-12", textContent: "💻 PC (Chrome / Edge): 주소창 오른쪽 '앱 설치(⊕)' 아이콘 클릭" }),
        ]),
        el("div", { className: "modal-footer-end" }, [
          el("button", { type: "button", className: "btn btn-pink btn-sm", textContent: "확인", onClick: closeModal }),
        ]),
      ]);
      openModal("📱 체온 공홈 앱 설치 방법", guide);
    });

    dismissBtn.addEventListener("click", () => {
      banner.classList.add("hidden");
      localStorage.setItem("chaeon_install_dismissed_v1", "1");
    });
  }

  async function init() {
    initInstallBanner();
    bindEvents();
    window.addEventListener("popstate", () => {
      syncFromLocation();
    });
    await refreshMe();
    await loadEmoticons();
    await syncFromLocation();
  }

  init();
})();
