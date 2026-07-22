(() => {
  const cardsEl = document.getElementById("cards");
  const statusEl = document.getElementById("status");
  const errorEl = document.getElementById("error");
  const footerMetaEl = document.getElementById("footer-meta");
  const refreshBtn = document.getElementById("refresh-btn");

  const AUTO_REFRESH_MS = 15 * 60 * 1000;
  let autoTimer = null;

  function formatMoney(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1_000_000_000) {
      const v = n / 1_000_000_000;
      return `$${trimNum(v)}B`;
    }
    if (abs >= 1_000_000) {
      const v = n / 1_000_000;
      return `$${trimNum(v)}M`;
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n);
  }

  function trimNum(v) {
    return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
  }

  function formatExact(n) {
    if (n == null) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n);
  }

  function formatWhen(iso) {
    if (!iso) return "unknown";
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return iso;
    }
  }

  function showSkeletons() {
    cardsEl.innerHTML = "";
    for (let i = 0; i < 3; i += 1) {
      const s = document.createElement("div");
      s.className = "skeleton";
      s.setAttribute("aria-hidden", "true");
      cardsEl.appendChild(s);
    }
    cardsEl.setAttribute("aria-busy", "true");
  }

  function renderGames(data) {
    const games = data.games || [];
    cardsEl.innerHTML = "";
    cardsEl.setAttribute("aria-busy", "false");

    if (!games.length) {
      cardsEl.innerHTML = "<p class='meta'>No games available.</p>";
      return;
    }

    for (const game of games) {
      const card = document.createElement("article");
      card.className = `card ${game.id}`;
      card.innerHTML = `
        <div class="card-top" aria-hidden="true"></div>
        <div class="card-body">
          <h2 class="game-name">${escapeHtml(game.name)}</h2>
          <div class="primary">
            <p class="primary-label">After-tax cash (37% federal)</p>
            <p class="primary-value" title="${escapeHtml(formatExact(game.after_tax_cash))}">
              ${escapeHtml(formatMoney(game.after_tax_cash))}
            </p>
          </div>
          <div class="rows">
            <div class="row">
              <span class="row-label">Cash value (pre-tax)</span>
              <span class="row-value" title="${escapeHtml(formatExact(game.cash_value))}">
                ${escapeHtml(formatMoney(game.cash_value))}
              </span>
            </div>
            <div class="row">
              <span class="row-label">Advertised jackpot</span>
              <span class="row-value" title="${escapeHtml(formatExact(game.jackpot_annuity))}">
                ${escapeHtml(formatMoney(game.jackpot_annuity))}
              </span>
            </div>
            <div class="row">
              <span class="row-label">Federal tax @ 37%</span>
              <span class="row-value" title="${escapeHtml(formatExact(game.cash_value - game.after_tax_cash))}">
                −${escapeHtml(formatMoney(game.cash_value - game.after_tax_cash))}
              </span>
            </div>
          </div>
          <div class="meta">
            ${game.next_draw ? `Next draw: <strong>${escapeHtml(game.next_draw)}</strong>` : "Next draw: —"}
            ${game.last_draw ? `<br />Last draw: ${escapeHtml(game.last_draw)}` : ""}
          </div>
        </div>
      `;
      cardsEl.appendChild(card);
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function setStatus(data, isError) {
    statusEl.classList.toggle("stale", Boolean(data && data.stale));
    if (isError) {
      statusEl.textContent = "Failed to load";
      return;
    }
    const parts = [];
    parts.push(`Updated ${formatWhen(data.fetched_at)}`);
    if (data.stale) parts.push("showing cached data");
    if (data.cache_hit && !data.stale) parts.push("cached");
    if (data.rate_limited) parts.push("refresh rate-limited");
    statusEl.textContent = parts.join(" · ");

    const tax = data.tax || {};
    footerMetaEl.textContent = [
      `Source: ${data.source_url || "calottery.com"}`,
      `Federal rate: ${((tax.federal_rate ?? 0.37) * 100).toFixed(0)}%`,
      `CA state rate: ${((tax.state_rate ?? 0) * 100).toFixed(0)}%`,
      data.stale ? "Data may be stale" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }

  function clearError() {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }

  async function loadJackpots({ force = false } = {}) {
    refreshBtn.disabled = true;
    if (!cardsEl.querySelector(".card")) {
      showSkeletons();
    }

    try {
      let data;
      if (force) {
        const res = await fetch("/api/refresh", { method: "POST" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || `Refresh failed (${res.status})`);
        }
        data = await res.json();
      } else {
        const res = await fetch("/api/jackpots");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || `Load failed (${res.status})`);
        }
        data = await res.json();
      }

      clearError();
      renderGames(data);
      setStatus(data, false);
      if (data.error && data.stale) {
        showError(`Live update failed; showing last good data. (${data.error})`);
      }
    } catch (err) {
      setStatus(null, true);
      showError(err.message || String(err));
      if (!cardsEl.querySelector(".card")) {
        cardsEl.innerHTML = "";
        cardsEl.setAttribute("aria-busy", "false");
      }
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function scheduleAutoRefresh() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        loadJackpots({ force: false });
      }
    }, AUTO_REFRESH_MS);
  }

  refreshBtn.addEventListener("click", () => loadJackpots({ force: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadJackpots({ force: false });
    }
  });

  loadJackpots({ force: false });
  scheduleAutoRefresh();
})();
