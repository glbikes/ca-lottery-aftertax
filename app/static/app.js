(() => {
  const cardsEl = document.getElementById("cards");
  const statusEl = document.getElementById("status");
  const errorEl = document.getElementById("error");
  const refreshBtn = document.getElementById("refresh-btn");
  const assumptionsEl = document.getElementById("assumptions");
  const howEl = document.getElementById("how");
  const howBodyEl = document.getElementById("how-body");
  const annuityDialog = document.getElementById("annuity-dialog");
  const annuityTitleEl = document.getElementById("annuity-title");
  const annuityContentEl = document.getElementById("annuity-content");

  const AUTO_REFRESH_MS = 15 * 60 * 1000;
  const STATUS_TICK_MS = 30 * 1000;
  const EXPECTED_GAMES = [
    { id: "powerball", name: "Powerball" },
    { id: "mega-millions", name: "Mega Millions" },
    { id: "superlotto-plus", name: "SuperLotto Plus" },
  ];
  // Payments shown in the condensed annuity table: at claim, year 10, year 20, final.
  const ANNUITY_HIGHLIGHT_INDEXES = [0, 10, 20];
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

  let autoTimer = null;
  let statusTimer = null;
  let latestData = null;

  /* ---------- Formatting ---------- */

  function formatMoney(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1_000_000_000) return `$${trimNum(n / 1_000_000_000)}B`;
    if (abs >= 1_000_000) return `$${trimNum(n / 1_000_000)}M`;
    return formatExact(n);
  }

  function trimNum(v) {
    return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
  }

  function formatExact(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n);
  }

  function formatPct(rate, digits = 0) {
    const pct = rate * 100;
    return `${Number.isInteger(pct) ? pct : pct.toFixed(digits)}%`;
  }

  // Millions with a fixed single decimal, so a table column lines up.
  function formatMillions(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return `$${(n / 1_000_000).toFixed(1)}M`;
  }

  // Exact on wide screens, abbreviated on narrow ones (CSS picks which shows).
  function dualMoney(n) {
    return `<span class="v-exact">${escapeHtml(formatExact(n))}</span><span class="v-short">${escapeHtml(formatMillions(n))}</span>`;
  }

  function formatTimestamp(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return iso;
    }
  }

  function formatAgo(iso) {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "unknown";
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    return formatTimestamp(iso);
  }

  // calottery.com gives e.g. "SAT/OCT 24, 2026".
  function parseDrawDate(raw) {
    const m = /^\s*[A-Z]{3}\/([A-Z]{3})\s+(\d{1,2}),\s*(\d{4})\s*$/i.exec(raw || "");
    if (!m) return null;
    const month = MONTHS.indexOf(m[1].toUpperCase());
    if (month < 0) return null;
    return new Date(Number(m[3]), month, Number(m[2]));
  }

  function drawLabel(raw) {
    const date = parseDrawDate(raw);
    if (!date) return { date: raw, relative: "", iso: "" };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((date - today) / 86_400_000);
    let relative = "";
    if (days === 0) relative = "Tonight";
    else if (days === 1) relative = "Tomorrow";
    else if (days > 1 && days < 7) relative = `in ${days} days`;
    const sameYear = date.getFullYear() === today.getFullYear();
    return {
      date: date.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(sameYear ? {} : { year: "numeric" }),
      }),
      relative,
      iso: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    };
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  /* ---------- Assumptions (driven by the API) ---------- */

  function renderAssumptions(data) {
    const tax = data.tax || {};
    const yld = data.yield || {};
    if (tax.federal_rate == null) return;
    const fed = formatPct(tax.federal_rate);
    const state = formatPct(tax.state_rate || 0);
    assumptionsEl.textContent = `${fed} federal, ${state} CA state tax`;

    const apy = yld.annual_rate != null ? formatPct(yld.annual_rate) : null;
    const combined = yld.interest_combined_tax_rate != null ? formatPct(yld.interest_combined_tax_rate, 1) : null;
    const yFed = yld.interest_federal_tax_rate != null ? formatPct(yld.interest_federal_tax_rate) : fed;
    const yState = yld.interest_state_tax_rate != null ? formatPct(yld.interest_state_tax_rate, 1) : null;

    let html = `
      <p>
        After-tax cash is the cash option minus ${escapeHtml(fed)} federal tax, the top marginal rate,
        for a conservative take-home estimate. Large prizes are usually withheld at 24% federally;
        your final rate depends on total income.
        ${tax.state_rate ? `California tax is shown at ${escapeHtml(state)}.` : "California does not tax CA Lottery prizes."}
      </p>`;
    if (apy && combined) {
      html += `
      <p>
        The interest line assumes the after-tax cash earns about ${escapeHtml(apy)} APY, with that interest taxed at
        about ${escapeHtml(combined)}${yState ? ` (${escapeHtml(yFed)} federal plus ${escapeHtml(yState)} CA)` : ""}.
        Treasury interest is often CA-exempt, and high earners may also owe about 3.8% NIIT.
      </p>`;
    }
    howBodyEl.innerHTML = html;
  }

  /* ---------- Cards ---------- */

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
    // Keep any open interest panels open across auto-refreshes.
    const openPanels = new Set(
      [...cardsEl.querySelectorAll("[data-interest][aria-expanded='true']")].map((b) => b.dataset.interest),
    );
    cardsEl.innerHTML = "";
    cardsEl.setAttribute("aria-busy", "false");

    if (!games.length && !(data.missing_games || []).length) {
      cardsEl.innerHTML = "<p class='meta'>No games available.</p>";
      return;
    }

    for (const expected of EXPECTED_GAMES) {
      const game = byId[expected.id];
      cardsEl.appendChild(
        game ? renderGameCard(game, data.yield, openPanels.has(game.id)) : renderUnavailableCard(expected),
      );
    }
  }

  function renderGameCard(game, yieldMeta, interestOpen) {
    const card = document.createElement("article");
    card.className = `card ${game.id}`;
    const federalTax = game.cash_value - game.after_tax_cash;
    const draw = game.next_draw ? drawLabel(game.next_draw) : null;
    const hasInterest = game.yield_monthly_income != null || game.yield_annual_income != null;
    const hasAnnuity = Boolean(game.annuity_schedule && game.annuity_schedule.length);
    const panelId = `interest-${game.id}`;

    const drawHtml = draw
      ? `<time datetime="${escapeHtml(draw.iso)}"><strong>${escapeHtml(draw.date)}</strong></time>${
          draw.relative ? ` <span class="draw-rel${draw.relative === "Tonight" ? " is-tonight" : ""}">${escapeHtml(draw.relative)}</span>` : ""
        }`
      : "—";

    const actions = [];
    if (hasInterest) {
      actions.push(`
            <button type="button" class="card-action" data-interest="${escapeHtml(game.id)}"
              aria-expanded="${interestOpen}" aria-controls="${panelId}">
              Interest details
              <svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>`);
    }
    if (hasAnnuity) {
      actions.push(`
            <button type="button" class="card-action" data-annuity="${escapeHtml(game.id)}" aria-haspopup="dialog">
              Annuity schedule
              <svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>`);
    }

    card.innerHTML = `
        <div class="card-top" aria-hidden="true"></div>
        <div class="card-body">
          <h2 class="game-name">
            ${escapeHtml(game.name)}
            <span class="game-jackpot">${escapeHtml(formatMoney(game.jackpot_annuity))} jackpot</span>
          </h2>
          <div class="primary">
            <p class="primary-label">After-tax cash</p>
            <p class="primary-value" title="${escapeHtml(formatExact(game.after_tax_cash))}">
              ${escapeHtml(formatMoney(game.after_tax_cash))}
            </p>
            <p class="math-line" title="${escapeHtml(formatExact(game.cash_value))} cash − ${escapeHtml(formatExact(federalTax))} federal">
              ${escapeHtml(formatMoney(game.cash_value))} cash − ${escapeHtml(formatMoney(federalTax))} federal
            </p>
          </div>
          ${hasInterest ? renderYieldBlock(game, yieldMeta, panelId, interestOpen) : ""}
          <div class="card-foot">
            <p class="draw-line">Next draw ${drawHtml}</p>
            ${actions.length ? `<div class="card-actions">${actions.join("")}</div>` : ""}
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

  function renderYieldBlock(game, yieldMeta, panelId, open) {
    const rate = yieldMeta && yieldMeta.annual_rate != null ? yieldMeta.annual_rate : 0.04;
    const cell = (n, per) =>
      `<td class="num" title="${escapeHtml(formatExact(n))}${per}">${escapeHtml(formatMoney(n))}</td>`;
    return `
          <div class="yield">
            <p class="yield-one-liner" title="${escapeHtml(formatExact(game.yield_monthly_income))} per month after tax">
              ≈ <strong>${escapeHtml(formatMoney(game.yield_monthly_income))}/mo</strong> after tax if parked at ${escapeHtml(formatPct(rate))}
            </p>
            <div class="yield-panel" id="${panelId}" ${open ? "" : "hidden"}>
              <table class="yield-grid">
                <thead>
                  <tr><th scope="col"><span class="sr-only">Interest</span></th><th scope="col" class="num">Monthly</th><th scope="col" class="num">Yearly</th></tr>
                </thead>
                <tbody>
                  <tr class="is-strong">
                    <th scope="row">After tax</th>
                    ${cell(game.yield_monthly_income, " /mo")}
                    ${cell(game.yield_annual_income, " /yr")}
                  </tr>
                  <tr>
                    <th scope="row">Pretax</th>
                    ${cell(game.yield_monthly_pretax, " /mo")}
                    ${cell(game.yield_annual_pretax, " /yr")}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>`;
  }

  /* ---------- Annuity dialog ---------- */

  function openAnnuity(gameId) {
    const game = latestData && (latestData.games || []).find((g) => g.id === gameId);
    if (!game || !game.annuity_schedule || !game.annuity_schedule.length) return;
    const schedule = game.annuity_schedule;
    const meta = latestData.annuity || {};
    const fedRate = latestData.tax && latestData.tax.federal_rate != null ? latestData.tax.federal_rate : 0.37;
    const first = schedule[0];
    const last = schedule[schedule.length - 1];
    const years = schedule.length - 1;
    const highlight = new Set([...ANNUITY_HIGHLIGHT_INDEXES, schedule.length - 1]);

    let cumulative = 0;
    const rows = [];
    schedule.forEach((p, i) => {
      cumulative += p.after_tax;
      const when = i === 0 ? "At claim" : `Year ${i}`;
      rows.push(`
            <tr${highlight.has(i) ? "" : ' class="is-extra"'}>
              <th scope="row">${escapeHtml(when)}</th>
              <td class="num">${dualMoney(p.pretax)}</td>
              <td class="num accent">${dualMoney(p.after_tax)}</td>
              <td class="num">${dualMoney(cumulative)}</td>
            </tr>`);
    });

    const ratio = game.after_tax_cash ? game.annuity_after_tax_total / game.after_tax_cash : null;
    const ratioText = ratio ? `${ratio.toFixed(1)}×` : "";

    annuityTitleEl.textContent = `${game.name} annuity`;
    annuityContentEl.innerHTML = `
      <p class="annuity-lead">
        The annuity pays <strong class="accent">${escapeHtml(formatMoney(game.annuity_after_tax_total))}</strong> after tax over ${years} years.
        ${ratioText ? `That is <strong>${escapeHtml(ratioText)}</strong> the <strong>${escapeHtml(formatMoney(game.after_tax_cash))}</strong> lump sum, but paid out gradually.` : ""}
      </p>
      <dl class="annuity-summary">
        <div><dt>Jackpot, pre-tax</dt><dd title="${escapeHtml(formatExact(game.jackpot_annuity))}">${escapeHtml(formatMoney(game.jackpot_annuity))}</dd></div>
        <div><dt>Annuity after tax</dt><dd class="accent" title="${escapeHtml(formatExact(game.annuity_after_tax_total))}">${escapeHtml(formatMoney(game.annuity_after_tax_total))}</dd></div>
        <div><dt>Lump sum after tax</dt><dd title="${escapeHtml(formatExact(game.after_tax_cash))}">${escapeHtml(formatMoney(game.after_tax_cash))}</dd></div>
        <div><dt>First / last payment</dt><dd>${escapeHtml(formatMoney(first.after_tax))} / ${escapeHtml(formatMoney(last.after_tax))}</dd></div>
      </dl>
      <div class="table-wrap is-condensed" id="annuity-table-wrap">
        <table class="annuity-table">
          <caption class="sr-only">Annuity payments, ${escapeHtml(formatPct(fedRate))} federal tax</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col" class="num">Pre-tax</th>
              <th scope="col" class="num">After tax</th>
              <th scope="col" class="num">Cumulative</th>
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
      <button type="button" class="card-action toggle-all" data-annuity-all
        aria-controls="annuity-table-wrap" aria-expanded="false" data-count="${schedule.length}">
        Show all ${schedule.length} payments
      </button>
      ${meta.note ? `<p class="dialog-note">${escapeHtml(meta.note)}</p>` : ""}
    `;
    if (!annuityDialog.open) annuityDialog.showModal();
  }

  /* ---------- Status / errors ---------- */

  function renderStatus() {
    const data = latestData;
    if (!data) return;
    statusEl.classList.toggle("stale", Boolean(data.stale));
    const parts = [`Updated ${formatAgo(data.fetched_at)}`];
    if (data.stale) parts.push("showing cached data");
    if (data.rate_limited) parts.push("refresh rate-limited");
    statusEl.textContent = parts.join(" · ");
    statusEl.title = data.fetched_at ? formatTimestamp(data.fetched_at) : "";
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }

  function clearError() {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }

  /* ---------- Loading ---------- */

  async function loadJackpots({ force = false } = {}) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add("is-spinning");
    if (!cardsEl.querySelector(".card")) showSkeletons();

    try {
      const res = force ? await fetch("/api/refresh", { method: "POST" }) : await fetch("/api/jackpots");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `${force ? "Refresh" : "Load"} failed (${res.status})`);
      }
      const data = await res.json();

      clearError();
      latestData = data;
      renderAssumptions(data);
      renderGames(data);
      renderStatus();
      // Partial missing games stay on their Unavailable card only.
      if (data.error && data.stale) {
        showError(`Live update failed; showing last good data. (${data.error})`);
      }
    } catch (err) {
      statusEl.classList.remove("stale");
      statusEl.textContent = "Failed to load";
      showError(err.message || String(err));
      if (!cardsEl.querySelector(".card")) {
        cardsEl.innerHTML = "";
        cardsEl.setAttribute("aria-busy", "false");
      }
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("is-spinning");
    }
  }

  function scheduleTimers() {
    clearInterval(autoTimer);
    clearInterval(statusTimer);
    autoTimer = setInterval(() => {
      if (document.visibilityState === "visible") loadJackpots({ force: false });
    }, AUTO_REFRESH_MS);
    statusTimer = setInterval(renderStatus, STATUS_TICK_MS);
  }

  /* ---------- Events ---------- */

  refreshBtn.addEventListener("click", () => loadJackpots({ force: true }));

  cardsEl.addEventListener("click", (e) => {
    const annuityBtn = e.target.closest("[data-annuity]");
    if (annuityBtn) {
      openAnnuity(annuityBtn.dataset.annuity);
      return;
    }
    const interestBtn = e.target.closest("[data-interest]");
    if (interestBtn) {
      const panel = document.getElementById(interestBtn.getAttribute("aria-controls"));
      const open = interestBtn.getAttribute("aria-expanded") !== "true";
      interestBtn.setAttribute("aria-expanded", String(open));
      if (panel) panel.hidden = !open;
    }
  });

  annuityContentEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-annuity-all]");
    if (!btn) return;
    const wrap = document.getElementById("annuity-table-wrap");
    const expand = btn.getAttribute("aria-expanded") !== "true";
    wrap.classList.toggle("is-condensed", !expand);
    btn.setAttribute("aria-expanded", String(expand));
    btn.textContent = expand ? "Show key payments only" : `Show all ${btn.dataset.count} payments`;
    if (!expand) wrap.scrollTop = 0;
  });

  document.getElementById("annuity-close").addEventListener("click", () => annuityDialog.close());
  annuityDialog.addEventListener("click", (e) => {
    // Click on the backdrop (outside the dialog box) closes it.
    if (e.target === annuityDialog) annuityDialog.close();
  });

  document.getElementById("how-link").addEventListener("click", (e) => {
    e.preventDefault();
    howEl.open = true;
    howEl.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    howEl.querySelector("summary").focus({ preventScroll: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadJackpots({ force: false });
  });

  loadJackpots({ force: false });
  scheduleTimers();
})();
