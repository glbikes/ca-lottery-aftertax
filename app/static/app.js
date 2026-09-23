(() => {
  const cardsEl = document.getElementById("cards");
  const statusEl = document.getElementById("status");
  const errorEl = document.getElementById("error");
  const footerMetaEl = document.getElementById("footer-meta");
  const refreshBtn = document.getElementById("refresh-btn");
  const annuityDialog = document.getElementById("annuity-dialog");
  const annuityTitleEl = document.getElementById("annuity-title");
  const annuityContentEl = document.getElementById("annuity-content");

  const AUTO_REFRESH_MS = 15 * 60 * 1000;
  const EXPECTED_GAMES = [
    { id: "powerball", name: "Powerball" },
    { id: "mega-millions", name: "Mega Millions" },
    { id: "superlotto-plus", name: "SuperLotto Plus" },
  ];
  let autoTimer = null;
  let latestData = null;

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
    const byId = Object.fromEntries(games.map((game) => [game.id, game]));
    cardsEl.innerHTML = "";
    cardsEl.setAttribute("aria-busy", "false");

    if (!games.length && !(data.missing_games || []).length) {
      cardsEl.innerHTML = "<p class='meta'>No games available.</p>";
      return;
    }

    for (const expected of EXPECTED_GAMES) {
      const game = byId[expected.id];
      if (game) {
        cardsEl.appendChild(renderGameCard(game, data.yield));
      } else {
        cardsEl.appendChild(renderUnavailableCard(expected));
      }
    }
  }

  function renderGameCard(game, yieldMeta) {
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
              <span class="row-label">
                Advertised jackpot
                ${game.annuity_schedule && game.annuity_schedule.length
                  ? `<button type="button" class="link-btn" data-annuity="${escapeHtml(game.id)}">Annuity payouts →</button>`
                  : ""}
              </span>
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
          ${renderYieldBlock(game, yieldMeta)}
          <div class="meta">
            ${game.next_draw ? `Next draw: <strong>${escapeHtml(game.next_draw)}</strong>` : "Next draw: —"}
            ${game.last_draw ? `<br />Last draw: ${escapeHtml(game.last_draw)}` : ""}
          </div>
        </div>
      `;
    return card;
  }

  function renderUnavailableCard(game) {
    const card = document.createElement("article");
    card.className = `card unavailable ${game.id}`;
    card.innerHTML = `
        <div class="card-top" aria-hidden="true"></div>
        <div class="card-body">
          <h2 class="game-name">${escapeHtml(game.name)}</h2>
          <div class="primary">
            <p class="primary-label">After-tax cash</p>
            <p class="primary-value">Unavailable</p>
          </div>
          <p class="meta">Could not parse this game from calottery.com. Other jackpots are still current.</p>
        </div>
      `;
    return card;
  }

  function yieldRateLabel(yieldMeta) {
    const rate = yieldMeta && yieldMeta.annual_rate != null
      ? yieldMeta.annual_rate
      : 0.04;
    return `${(rate * 100).toFixed(0)}%`;
  }

  function interestTaxLabel(yieldMeta) {
    const combined =
      yieldMeta && yieldMeta.interest_combined_tax_rate != null
        ? yieldMeta.interest_combined_tax_rate
        : 0.503;
    return `${(combined * 100).toFixed(1)}%`;
  }

  function renderYieldBlock(game, yieldMeta) {
    const annual = game.yield_annual_income;
    const monthly = game.yield_monthly_income;
    const pretaxAnnual = game.yield_annual_pretax;
    const pretaxMonthly = game.yield_monthly_pretax;
    if (annual == null && monthly == null) return "";
    const pct = yieldRateLabel(yieldMeta);
    const taxPct = interestTaxLabel(yieldMeta);
    return `
          <div class="yield-block">
            <p class="yield-label">If parked at ~${escapeHtml(pct)} APY (after interest tax)</p>
            <div class="rows">
              <div class="row">
                <span class="row-label">Est. annual interest (after tax)</span>
                <span class="row-value yield-value" title="${escapeHtml(formatExact(annual))}">
                  ${escapeHtml(formatMoney(annual))}<span class="per">/yr</span>
                </span>
              </div>
              <div class="row">
                <span class="row-label">Est. monthly interest (after tax)</span>
                <span class="row-value yield-value" title="${escapeHtml(formatExact(monthly))}">
                  ${escapeHtml(formatMoney(monthly))}<span class="per">/mo</span>
                </span>
              </div>
              <div class="row row-muted">
                <span class="row-label">Pretax interest</span>
                <span class="row-value" title="${escapeHtml(formatExact(pretaxAnnual))} /yr · ${escapeHtml(formatExact(pretaxMonthly))} /mo">
                  ${escapeHtml(formatMoney(pretaxAnnual))}<span class="per">/yr</span>
                  · ${escapeHtml(formatMoney(pretaxMonthly))}<span class="per">/mo</span>
                </span>
              </div>
              <div class="row row-muted">
                <span class="row-label">Interest tax assumed</span>
                <span class="row-value">−${escapeHtml(taxPct)} <span class="per">(37% fed + 13.3% CA)</span></span>
              </div>
            </div>
          </div>`;
  }

  function openAnnuity(gameId) {
    const game = latestData && (latestData.games || []).find((g) => g.id === gameId);
    if (!game || !game.annuity_schedule) return;
    const schedule = game.annuity_schedule;
    const meta = latestData.annuity || {};
    const first = schedule[0];
    const last = schedule[schedule.length - 1];

    let cumulative = 0;
    const rows = schedule
      .map((p) => {
        cumulative += p.after_tax;
        const when = p.number === 1 ? "At claim" : `Year ${p.number - 1}`;
        return `
            <tr>
              <td>${p.number}</td>
              <td>${escapeHtml(when)}</td>
              <td class="num">${escapeHtml(formatExact(p.pretax))}</td>
              <td class="num accent">${escapeHtml(formatExact(p.after_tax))}</td>
              <td class="num">${escapeHtml(formatExact(cumulative))}</td>
            </tr>`;
      })
      .join("");

    annuityTitleEl.textContent = `${game.name} — annuity payouts`;
    annuityContentEl.innerHTML = `
      <div class="rows annuity-summary">
        <div class="row">
          <span class="row-label">Advertised jackpot (total pre-tax)</span>
          <span class="row-value">${escapeHtml(formatExact(game.jackpot_annuity))}</span>
        </div>
        <div class="row">
          <span class="row-label">Total after tax (37% federal)</span>
          <span class="row-value accent">${escapeHtml(formatExact(game.annuity_after_tax_total))}</span>
        </div>
        <div class="row">
          <span class="row-label">First → final payment (after tax)</span>
          <span class="row-value">${escapeHtml(formatMoney(first.after_tax))} → ${escapeHtml(formatMoney(last.after_tax))}</span>
        </div>
        <div class="row row-muted">
          <span class="row-label">vs. lump sum after tax (cash option)</span>
          <span class="row-value">${escapeHtml(formatExact(game.after_tax_cash))}</span>
        </div>
      </div>
      <div class="table-wrap">
        <table class="annuity-table">
          <thead>
            <tr>
              <th>#</th>
              <th>When</th>
              <th class="num">Pre-tax</th>
              <th class="num">After tax</th>
              <th class="num">Cumulative</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${meta.note ? `<p class="dialog-note">${escapeHtml(meta.note)}</p>` : ""}
    `;
    if (!annuityDialog.open) annuityDialog.showModal();
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
    const missingCount = (data.missing_games || []).length;
    if (missingCount) {
      parts.push(
        missingCount === 1 ? "1 game unavailable" : `${missingCount} games unavailable`
      );
    }
    statusEl.textContent = parts.join(" · ");

    const tax = data.tax || {};
    const yld = data.yield || {};
    footerMetaEl.textContent = [
      `Source: ${data.source_url || "calottery.com"}`,
      `Federal rate: ${((tax.federal_rate ?? 0.37) * 100).toFixed(0)}%`,
      `CA state rate: ${((tax.state_rate ?? 0) * 100).toFixed(0)}%`,
      `Illustrative yield: ${((yld.annual_rate ?? 0.04) * 100).toFixed(0)}% APY`,
      `Interest tax: ${((yld.interest_combined_tax_rate ?? 0.503) * 100).toFixed(1)}%`,
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
      latestData = data;
      renderGames(data);
      setStatus(data, false);
      if (data.error && data.stale) {
        showError(`Live update failed; showing last good data. (${data.error})`);
      } else if ((data.missing_games || []).length) {
        const names = data.missing_games.map((game) => game.name).join(", ");
        showError(`Could not load ${names} from calottery.com. Other games are current.`);
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
  cardsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-annuity]");
    if (btn) openAnnuity(btn.dataset.annuity);
  });
  document.getElementById("annuity-close").addEventListener("click", () => annuityDialog.close());
  annuityDialog.addEventListener("click", (e) => {
    // Click on the backdrop (outside the dialog box) closes it
    if (e.target === annuityDialog) annuityDialog.close();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadJackpots({ force: false });
    }
  });

  loadJackpots({ force: false });
  scheduleAutoRefresh();
})();
