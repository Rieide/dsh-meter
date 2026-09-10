// dsh-meter host half: session usage fold + historical price accounting + DeepSeek balance.
// Exposes one JSON route: GET /api/dsm/status?session=<sessionId>

const name = "dsh-meter";

// Hard dependencies; `agentDefaultModel` is read optionally for the default model.
const inject = ["webServer", "sessionQuery", "credentials", "shell"];

// ---- local price history (CNY per 1M tokens) -------------------------------
// Each era is valid over [from, to); the newest era carries `to: null`.
// `peakRule` picks which days have peak windows (Beijing time):
//   "daily"    – every day 09:00-12:00 / 14:00-18:00
//   "weekdays" – Monday-Friday only (weekends are entirely off-peak)
// `families[family].models` lists the model versions that era serves.
// Sources: DeepSeek official "Models & Pricing" page + change log.
const PEAK_WINDOWS = [
  { s: 540, e: 720 },
  { s: 840, e: 1080 },
];
const OFF_WINDOWS = [
  { s: 0, e: 540 },
  { s: 720, e: 840 },
  { s: 1080, e: 1440 },
];

// Price tiers, reused across eras.
const P_V41_FLASH = {
  off: { hit: 0.02, miss: 1.0, out: 4.0 },
  peak: { hit: 0.04, miss: 2.0, out: 8.0 },
};
const P_V4_FLASH = {
  off: { hit: 0.05, miss: 1.5, out: 4.5 },
  peak: { hit: 0.1, miss: 3.0, out: 9.0 },
};
const P_V4_PRO = {
  off: { hit: 0.15, miss: 4.5, out: 13.5 },
  peak: { hit: 0.3, miss: 9.0, out: 27.0 },
};

const FLASH_MODELS_V41 = ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];
const FLASH_MODELS_V4 = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];

// Newest era first — `eraAt` walks this list in order.
const PRICE_HISTORY = [
  {
    id: "v4-pro-via-v4.1-flash",
    label: "V4 Pro 路由至 V4.1 Flash，按 Flash 单价计费",
    from: "2026-09-14T04:00:00Z", // 2026-09-14 12:00 北京时间（官方公告）
    to: null,
    peakRule: "weekdays",
    families: {
      flash: { models: FLASH_MODELS_V41, off: P_V41_FLASH.off, peak: P_V41_FLASH.peak },
      pro: { models: ["deepseek-v4-pro"], off: P_V41_FLASH.off, peak: P_V41_FLASH.peak },
    },
  },
  {
    id: "v4.1-flash",
    label: "DeepSeek-V4.1-Flash 上线调价；高峰改限工作日",
    from: "2026-09-09T16:00:00Z", // 2026-09-10 00:00 北京时间（公告只到日）
    to: "2026-09-14T04:00:00Z",
    peakRule: "weekdays",
    families: {
      flash: { models: FLASH_MODELS_V41, off: P_V41_FLASH.off, peak: P_V41_FLASH.peak },
      pro: { models: ["deepseek-v4-pro"], off: P_V4_PRO.off, peak: P_V4_PRO.peak },
    },
  },
  {
    id: "peak-valley",
    label: "峰谷计价上线（每日高峰）",
    from: "2026-08-16T16:00:00Z",
    to: "2026-09-09T16:00:00Z",
    peakRule: "daily",
    families: {
      flash: { models: FLASH_MODELS_V4, off: P_V4_FLASH.off, peak: P_V4_FLASH.peak },
      pro: { models: ["deepseek-v4-pro"], off: P_V4_PRO.off, peak: P_V4_PRO.peak },
    },
  },
];

/** Display names of the known model versions. */
const MODEL_NAMES = {
  "deepseek-flash": "DeepSeek-V4.1-Flash",
  "deepseek-v4-flash": "DeepSeek-V4-Flash",
  "deepseek-v4-flash-vision-exp": "DeepSeek-V4-Flash-Vision-Exp",
  "deepseek-v4-pro": "DeepSeek-V4-Pro-0813",
};

function familyOf(model) {
  const m = String(model || "").toLowerCase();
  if (m.indexOf("pro") >= 0 || m.indexOf("reasoner") >= 0) return "pro";
  return "flash";
}

/** The price era in force at `ms`; logs older than the earliest era use it as the floor. */
function eraAt(ms) {
  for (const era of PRICE_HISTORY) {
    const from = Date.parse(era.from);
    const to = era.to === null ? Infinity : Date.parse(era.to);
    if (ms >= from && ms < to) return era;
  }
  return PRICE_HISTORY[PRICE_HISTORY.length - 1];
}

function eraById(id) {
  for (const era of PRICE_HISTORY) if (era.id === id) return era;
  return undefined;
}

function beijingParts(ms) {
  const d = new Date(ms + 8 * 3600e3);
  return { day: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Whether `ms` is inside a peak window under one era's peak rule. */
function isPeakAt(ms, peakRule) {
  const { day, minute } = beijingParts(ms);
  if (peakRule === "weekdays" && (day === 0 || day === 6)) return false;
  for (const w of PEAK_WINDOWS) if (minute >= w.s && minute < w.e) return true;
  return false;
}

/** The window to display for `ms`: a peak window, an off-peak window, or the whole day. */
function windowOf(ms, peakRule) {
  const { day, minute } = beijingParts(ms);
  if (peakRule === "weekdays" && (day === 0 || day === 6)) return { status: "off", start: 0, end: 1440 };
  for (const w of PEAK_WINDOWS) if (minute >= w.s && minute < w.e) return { status: "peak", start: w.s, end: w.e };
  for (const w of OFF_WINDOWS) if (minute >= w.s && minute < w.e) return { status: "off", start: w.s, end: w.e };
  return { status: "off", start: 0, end: 1440 };
}

function hhmm(m) {
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function emptyBucket() {
  return { hit: 0, miss: 0, out: 0, write: 0 };
}

function freshEntry() {
  return { rows: {}, currentModel: "", last: null, seeded: false };
}

function rowFor(entry, eraId, family) {
  const key = eraId + "|" + family;
  let row = entry.rows[key];
  if (row === undefined) {
    row = { key, eraId, family, models: {}, peak: emptyBucket(), off: emptyBucket(), requests: 0 };
    entry.rows[key] = row;
  }
  return row;
}

// Sequential fold with the token-meter usage semantics, but every request is
// bucketed under the price era in force at its own timestamp.
function foldEvent(entry, ev) {
  if (ev.type === "request/header" && ev.data && ev.data.header && ev.data.header.config) {
    entry.currentModel = String(ev.data.header.config.model || "");
    return;
  }
  let turn;
  let step;
  let usage;
  if (ev.type === "assistant/chunk" && ev.data && ev.data.chunk && ev.data.chunk.type === "usage") {
    turn = ev.data.turn;
    step = ev.data.step;
    usage = ev.data.chunk.usage;
  } else if (ev.type === "assistant/message" && ev.data && ev.data.usage !== undefined) {
    turn = ev.data.turn;
    step = ev.data.step;
    usage = ev.data.usage;
  } else {
    return;
  }
  if (!usage || typeof usage !== "object") return;
  const model = entry.currentModel || "";
  const hit = usage.cacheReadTokens ?? 0;
  const miss = usage.inputTokens ?? 0;
  const out = usage.outputTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const last = entry.last;
  if (last && last.turn === turn && last.step === step) {
    const lrow = entry.rows[last.key];
    if (lrow !== undefined) {
      const lb = lrow[last.tier];
      lb.hit -= last.hit;
      lb.miss -= last.miss;
      lb.out -= last.out;
      lb.write -= last.write;
      lrow.requests -= 1;
      if (last.model) {
        lrow.models[last.model] -= 1;
        if (lrow.models[last.model] <= 0) delete lrow.models[last.model];
      }
    }
  }
  const era = eraAt(ev.time);
  const tier = isPeakAt(ev.time, era.peakRule) ? "peak" : "off";
  const row = rowFor(entry, era.id, familyOf(model));
  if (model) row.models[model] = (row.models[model] || 0) + 1;
  const b = row[tier];
  b.hit += hit;
  b.miss += miss;
  b.out += out;
  b.write += write;
  row.requests += 1;
  entry.last = { turn, step, key: row.key, tier, hit, miss, out, write, model };
}

function costOfBuckets(peak, off, prices) {
  const peakCost =
    (peak.hit / 1e6) * prices.peak.hit + (peak.miss / 1e6) * prices.peak.miss + (peak.out / 1e6) * prices.peak.out;
  const offCost =
    (off.hit / 1e6) * prices.off.hit + (off.miss / 1e6) * prices.off.miss + (off.out / 1e6) * prices.off.out;
  return { total: peakCost + offCost, peak: peakCost, off: offCost };
}

/** Per-era/family breakdown plus running totals, each row priced by its own era. */
function summarize(entry) {
  const rows = [];
  const cost = { total: 0, peak: 0, off: 0 };
  const tokens = { hit: 0, miss: 0, out: 0, write: 0 };
  let requests = 0;
  for (const key of Object.keys(entry.rows)) {
    const row = entry.rows[key];
    const era = eraById(row.eraId);
    const fam = era === undefined ? undefined : era.families[row.family];
    const prices =
      fam === undefined ? { off: P_V41_FLASH.off, peak: P_V41_FLASH.peak } : { off: fam.off, peak: fam.peak };
    const rowCost = costOfBuckets(row.peak, row.off, prices);
    const hit = row.peak.hit + row.off.hit;
    const miss = row.peak.miss + row.off.miss;
    const out = row.peak.out + row.off.out;
    const write = row.peak.write + row.off.write;
    const denom = hit + miss + write;
    rows.push({
      eraId: row.eraId,
      eraLabel: era === undefined ? row.eraId : era.label,
      eraFrom: era === undefined ? null : era.from,
      eraTo: era === undefined ? null : era.to,
      peakRule: era === undefined ? "weekdays" : era.peakRule,
      family: row.family,
      models: Object.keys(row.models).map((id) => ({ id, name: MODEL_NAMES[id] || id })),
      requests: row.requests,
      tokens: { hit, miss, out, write },
      hitRate: denom > 0 ? hit / denom : null,
      prices,
      cost: rowCost,
    });
    cost.total += rowCost.total;
    cost.peak += rowCost.peak;
    cost.off += rowCost.off;
    tokens.hit += hit;
    tokens.miss += miss;
    tokens.out += out;
    tokens.write += write;
    requests += row.requests;
  }
  return { rows, cost, tokens, requests };
}

function apply(ctx) {
  const ledgers = new Map();

  function defaultModel() {
    try {
      const adm = ctx.get("agentDefaultModel");
      if (adm) {
        const sel = adm.currentSelection();
        if (sel && sel.model) return String(sel.model);
      }
    } catch (err) {
      /* keep default */
    }
    return "";
  }

  async function ensureLedger(sessionId) {
    let entry = ledgers.get(sessionId);
    if (entry && entry.seeded) return entry;
    if (!entry) {
      entry = freshEntry();
      ledgers.set(sessionId, entry);
    }
    try {
      const snap = await ctx.sessionQuery.readSession(sessionId);
      if (snap && Array.isArray(snap.events)) {
        for (const ev of snap.events) foldEvent(entry, ev);
      }
    } catch (err) {
      console.error("dsh-meter: refold failed for", sessionId, err);
    }
    entry.currentModel = entry.currentModel || defaultModel();
    entry.seeded = true;
    return entry;
  }

  ctx.on("session/event", (session, event) => {
    const id = session && session.id;
    if (!id) return;
    const entry = ledgers.get(id);
    if (!entry || !entry.seeded) return;
    foldEvent(entry, event);
  });

  let balanceCache = null;
  async function getBalance() {
    const now = Date.now();
    if (balanceCache && now - balanceCache.ts < 300000) return balanceCache.data;
    let key;
    try {
      const resolved = await ctx.credentials.resolve("DEEPSEEK_API_KEY");
      key = resolved ? resolved.value : undefined;
    } catch (err) {
      key = undefined;
    }
    if (!key) return { ok: false, error: "未配置 DEEPSEEK_API_KEY（在 Models 设置页写入）" };
    try {
      const spec = ctx.shell.resolve({
        command:
          'curl -sS -m 15 https://api.deepseek.com/user/balance -H "Authorization: Bearer $DEEPSEEK_API_KEY"',
        env: { DEEPSEEK_API_KEY: key },
        timeoutMs: 20000,
      });
      const res = await ctx.shell.run(spec);
      const text = res && res.stdout ? res.stdout.text : "";
      if (res.exitCode !== 0 || !text) {
        return { ok: false, error: "余额查询失败（exit " + String(res.exitCode) + "）" };
      }
      const parsed = JSON.parse(text);
      const data = {
        ok: true,
        isAvailable: !!parsed.is_available,
        infos: Array.isArray(parsed.balance_infos)
          ? parsed.balance_infos.map((i) => ({
              currency: i.currency,
              total: i.total_balance,
              granted: i.granted_balance,
              toppedUp: i.topped_up_balance,
            }))
          : [],
      };
      balanceCache = { ts: Date.now(), data };
      return data;
    } catch (err) {
      return { ok: false, error: "余额查询异常：" + (err && err.message ? err.message : String(err)) };
    }
  }

  function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  ctx.webServer.register({
    kind: "exact",
    path: "/api/dsm/status",
    handler: async (req, res) => {
      const raw = req.url || "";
      const q = raw.indexOf("?");
      const params = q < 0 ? new URLSearchParams() : new URLSearchParams(raw.slice(q + 1));
      const sessionId = params.get("session") || "";
      try {
        const entry = await ensureLedger(sessionId);
        const now = Date.now();
        const era = eraAt(now);
        const win = windowOf(now, era.peakRule);
        const currentModel = entry.currentModel || defaultModel();
        const currentFamily = familyOf(currentModel);
        const fam = era.families[currentFamily];
        const summary = summarize(entry);
        const denom = summary.tokens.hit + summary.tokens.miss + summary.tokens.write;
        json(res, 200, {
          sessionId,
          now,
          status: win.status,
          start: hhmm(win.start),
          end: hhmm(win.end),
          currentEra: { id: era.id, label: era.label, from: era.from, to: era.to, peakRule: era.peakRule },
          currentModel,
          currentModelName: MODEL_NAMES[currentModel] || currentModel,
          currentFamily,
          currentPricing:
            fam === undefined ? { off: P_V41_FLASH.off, peak: P_V41_FLASH.peak } : { off: fam.off, peak: fam.peak },
          rows: summary.rows,
          cost: summary.cost,
          tokens: summary.tokens,
          hitRate: denom > 0 ? summary.tokens.hit / denom : null,
          requests: summary.requests,
          modelNames: MODEL_NAMES,
          priceHistory: PRICE_HISTORY.map((e) => ({
            id: e.id,
            label: e.label,
            from: e.from,
            to: e.to,
            peakRule: e.peakRule,
            families: Object.keys(e.families).map((f) => ({
              family: f,
              models: e.families[f].models,
              off: e.families[f].off,
              peak: e.families[f].peak,
            })),
          })),
          balance: await getBalance(),
        });
      } catch (err) {
        json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}

export { apply, inject, name };
