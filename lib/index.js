// dsh-meter host half: session usage fold + peak/off-peak cost + DeepSeek balance.
// Exposes one JSON route: GET /api/dsm/status?session=<sessionId>

const name = "dsh-meter";

// Hard dependencies; `agentDefaultModel` is read optionally for the default family.
const inject = ["webServer", "sessionQuery", "credentials", "shell"];

// Beijing peak windows (minutes of day): 09:00-12:00, 14:00-18:00. Everything else is off-peak (half price).
const PEAK_WINDOWS = [
  { s: 540, e: 720 },
  { s: 840, e: 1080 },
];
const OFF_WINDOWS = [
  { s: 0, e: 540 },
  { s: 720, e: 840 },
  { s: 1080, e: 1440 },
];

// CNY per 1M tokens (official pricing, peak/off-peak since 2026-08-16).
const PRICING = {
  flash: {
    off: { hit: 0.05, miss: 1.5, out: 4.5 },
    peak: { hit: 0.1, miss: 3.0, out: 9.0 },
  },
  pro: {
    off: { hit: 0.15, miss: 4.5, out: 13.5 },
    peak: { hit: 0.3, miss: 9.0, out: 27.0 },
  },
};

function familyOf(model) {
  const m = String(model || "").toLowerCase();
  if (m.indexOf("pro") >= 0 || m.indexOf("reasoner") >= 0) return "pro";
  return "flash";
}

function beijingMinute(ms) {
  const d = new Date(ms + 8 * 3600e3);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function windowOf(ms) {
  const m = beijingMinute(ms);
  for (const w of PEAK_WINDOWS) if (m >= w.s && m < w.e) return { status: "peak", start: w.s, end: w.e };
  for (const w of OFF_WINDOWS) if (m >= w.s && m < w.e) return { status: "off", start: w.s, end: w.e };
  return { status: "off", start: 0, end: 1440 };
}

function hhmm(m) {
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function emptyBucket() {
  return { hit: 0, miss: 0, out: 0, write: 0 };
}

function mkPair() {
  return { peak: emptyBucket(), off: emptyBucket(), requests: 0 };
}

function freshEntry() {
  return { models: {}, currentFamily: "flash", last: null, seeded: false };
}

// Sequential fold, same semantics as the token-meter projection:
// `request/header` updates the model in force, usage events fold into that model's
// peak/off buckets, and a repeated (turn, step) sample replaces instead of double-counting.
function foldEvent(entry, ev) {
  if (ev.type === "request/header" && ev.data && ev.data.header && ev.data.header.config) {
    entry.currentFamily = familyOf(ev.data.header.config.model);
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
  const family = entry.currentFamily || "flash";
  const pair = entry.models[family] || (entry.models[family] = mkPair());
  const hit = usage.cacheReadTokens ?? 0;
  const miss = usage.inputTokens ?? 0;
  const out = usage.outputTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const last = entry.last;
  if (last && last.turn === turn && last.step === step) {
    const lb = entry.models[last.family] || (entry.models[last.family] = mkPair());
    const bb = last.peak ? lb.peak : lb.off;
    bb.hit -= last.hit;
    bb.miss -= last.miss;
    bb.out -= last.out;
    bb.write -= last.write;
    lb.requests -= 1;
  }
  const peak = windowOf(ev.time).status === "peak";
  const b = peak ? pair.peak : pair.off;
  b.hit += hit;
  b.miss += miss;
  b.out += out;
  b.write += write;
  pair.requests += 1;
  entry.last = { turn, step, hit, miss, out, write, peak, family };
}

function costOfPair(pair, pricing) {
  const p = pricing.peak;
  const o = pricing.off;
  const peakCost =
    (pair.peak.hit / 1e6) * p.hit + (pair.peak.miss / 1e6) * p.miss + (pair.peak.out / 1e6) * p.out;
  const offCost =
    (pair.off.hit / 1e6) * o.hit + (pair.off.miss / 1e6) * o.miss + (pair.off.out / 1e6) * o.out;
  return { total: peakCost + offCost, peak: peakCost, off: offCost };
}

function apply(ctx) {
  const ledgers = new Map();

  function defaultFamily() {
    try {
      const adm = ctx.get("agentDefaultModel");
      if (adm) {
        const sel = adm.currentSelection();
        if (sel && sel.model) return familyOf(sel.model);
      }
    } catch (err) {
      /* keep default */
    }
    return "flash";
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
        const win = windowOf(now);
        const currentFamily = entry.currentFamily || defaultFamily();
        const perModel = [];
        const grand = { total: 0, peak: 0, off: 0 };
        const tokens = { hit: 0, miss: 0, out: 0, write: 0 };
        let requests = 0;
        for (const family of ["flash", "pro"]) {
          const pair = entry.models[family];
          if (!pair) continue;
          const pricing = PRICING[family];
          const cost = costOfPair(pair, pricing);
          const hit = pair.peak.hit + pair.off.hit;
          const miss = pair.peak.miss + pair.off.miss;
          const out = pair.peak.out + pair.off.out;
          const write = pair.peak.write + pair.off.write;
          const denom = hit + miss + write;
          perModel.push({
            family,
            pricing,
            requests: pair.requests,
            tokens: { hit, miss, out, write },
            hitRate: denom > 0 ? hit / denom : null,
            cost,
          });
          grand.total += cost.total;
          grand.peak += cost.peak;
          grand.off += cost.off;
          tokens.hit += hit;
          tokens.miss += miss;
          tokens.out += out;
          tokens.write += write;
          requests += pair.requests;
        }
        const denom = tokens.hit + tokens.miss + tokens.write;
        json(res, 200, {
          sessionId,
          now,
          status: win.status,
          start: hhmm(win.start),
          end: hhmm(win.end),
          windows: PEAK_WINDOWS.map((w) => [hhmm(w.s), hhmm(w.e)]),
          offWindows: OFF_WINDOWS.map((w) => [hhmm(w.s), hhmm(w.e)]),
          currentFamily,
          currentPricing: PRICING[currentFamily] || PRICING.flash,
          perModel,
          cost: grand,
          tokens,
          hitRate: denom > 0 ? tokens.hit / denom : null,
          requests,
          balance: await getBalance(),
        });
      } catch (err) {
        json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}

export { apply, inject, name };
