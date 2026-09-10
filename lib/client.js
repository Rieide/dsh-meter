// dsh-meter client half: three single-line chips above the composer,
// polling the host /api/dsm/status endpoint.

window.__ModuleLoader__.load({
  id: "dsh-meter",
  factory: (require) => {
    const React = require("react");

    const CSS =
      ".dsm-row{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:2px 0;flex-wrap:nowrap}" +
      ".dsm-chip{display:inline-flex;flex-direction:row;align-items:center;gap:4px;padding:3px 12px;border:1.5px solid color-mix(in srgb, var(--dsw-alias-border-l2) 70%, white 30%);border-radius:999px;background:var(--dsw-alias-bg-base);line-height:1.35;cursor:default;user-select:none}" +
      ".dsm-chip-v{font-size:11px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".dsm-chip-s{font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap}" +
      ".dsm-chip-peak{border-color:#D97757;background:color-mix(in srgb, #D97757 12%, var(--dsw-alias-bg-base))}" +
      ".dsm-chip-peak .dsm-chip-v{color:#D97757}";

    if (typeof document !== "undefined" && document.getElementById("dsh-meter/style") === null) {
      const tag = document.createElement("style");
      tag.id = "dsh-meter/style";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    const PEAK_WINDOWS = [
      { s: 540, e: 720 },
      { s: 840, e: 1080 },
    ];
    const OFF_WINDOWS = [
      { s: 0, e: 540 },
      { s: 720, e: 840 },
      { s: 1080, e: 1440 },
    ];

    function windowOf(ms, peakRule) {
      const d = new Date(ms + 8 * 3600e3);
      const day = d.getUTCDay(); // Beijing weekday: 0=Sun .. 6=Sat
      const m = d.getUTCHours() * 60 + d.getUTCMinutes();
      if (peakRule === "weekdays" && (day === 0 || day === 6)) return { status: "off", start: 0, end: 1440 };
      for (const w of PEAK_WINDOWS) if (m >= w.s && m < w.e) return { status: "peak", start: w.s, end: w.e };
      for (const w of OFF_WINDOWS) if (m >= w.s && m < w.e) return { status: "off", start: w.s, end: w.e };
      return { status: "off", start: 0, end: 1440 };
    }
    function hhmm(m) {
      return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
    }
    /** Beijing calendar date of an ISO timestamp (era boundaries are Beijing-facing). */
    function beijingDate(iso) {
      if (!iso) return "";
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return "";
      const d = new Date(t + 8 * 3600e3);
      return (
        d.getUTCFullYear() +
        "-" +
        String(d.getUTCMonth() + 1).padStart(2, "0") +
        "-" +
        String(d.getUTCDate()).padStart(2, "0")
      );
    }
    function fmtTokens(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(n);
    }
    function fmtCny(v) {
      if (v < 0.01) return v.toFixed(4);
      if (v < 100) return v.toFixed(2);
      return v.toFixed(0);
    }
    function pct(r) {
      return r === null ? "--" : (r * 100).toFixed(1) + "%";
    }

    function PeakChip(props) {
      const w = windowOf(props.now, props.rule);
      const peak = w.status === "peak";
      const ruleHint = props.rule === "weekdays" ? "工作日（周一至周五）" : "每日";
      return React.createElement(
        "div",
        {
          className: "dsm-chip" + (peak ? " dsm-chip-peak" : ""),
          title:
            "北京时间" +
            ruleHint +
            "高峰窗口：09:00-12:00、14:00-18:00（高峰价）；其余为低峰（半价）。\n高峰规则随价位表时段变化。",
        },
        React.createElement(
          "span",
          { className: "dsm-chip-v" },
          (peak ? "高峰 " : "低峰 ") + hhmm(w.start) + "-" + hhmm(w.end),
        ),
      );
    }

    function CostChip(props) {
      if (!props.status) {
        return React.createElement(
          "div",
          { className: "dsm-chip" },
          React.createElement("span", { className: "dsm-chip-v" }, "消费 --"),
        );
      }
      const status = props.status;
      const cur = windowOf(props.now, props.rule).status === "peak" ? "peak" : "off";
      const curTier = cur === "peak" ? "高峰价" : "低峰价";
      const up = status.currentPricing[cur];
      const rows = status.rows || [];
      const rowLines = rows.map((r) => {
        const models = (r.models || []).map((m) => m.name).join("/") || r.family;
        const since = beijingDate(r.eraFrom);
        return (
          r.family +
          " · " +
          models +
          " · " +
          r.eraLabel +
          (since ? "（" + since + " 起）" : "") +
          "\n    " +
          "输入 命中 " +
          fmtTokens(r.tokens.hit) +
          "/未命中 " +
          fmtTokens(r.tokens.miss) +
          " · 输出 " +
          fmtTokens(r.tokens.out) +
          " · 命中率 " +
          pct(r.hitRate) +
          " · ¥" +
          fmtCny(r.cost.total)
        );
      });
      const history = status.priceHistory || [];
      const detail = [
        "对话ID：" + status.sessionId,
        "当前模型：" +
          (status.currentModel || status.currentFamily) +
          (status.currentModelName && status.currentModelName !== status.currentModel
            ? "（" + status.currentModelName + "）"
            : "") +
          " · 轮数：" +
          props.turns +
          " · 请求：" +
          status.requests +
          " 次",
        "— 按价位段核算（本地价位表历史）—",
      ]
        .concat(rowLines.length ? rowLines : ["（本会话暂无模型用量）"])
        .concat([
          "— 合计 —",
          "费用：高峰段 ¥" +
            fmtCny(status.cost.peak) +
            " + 低峰段 ¥" +
            fmtCny(status.cost.off) +
            " = ¥" +
            fmtCny(status.cost.total),
          "缓存命中率：" + pct(status.hitRate),
          "当前单价（" +
            (status.currentModel || status.currentFamily) +
            " · " +
            status.currentEra.label +
            " · 当前" +
            curTier +
            "）：命中 ¥" +
            up.hit +
            "/M · 未命中 ¥" +
            up.miss +
            "/M · 输出 ¥" +
            up.out +
            "/M",
          "当前价位时段：" +
            beijingDate(status.currentEra.from) +
            " 起（" +
            status.currentEra.label +
            "，高峰规则：" +
            (status.currentEra.peakRule === "weekdays" ? "工作日" : "每日") +
            "）",
          "价位表共 " + history.length + " 个时段，逐请求按发生时刻的价目核算",
          "（估算值，以官方账单为准）",
        ])
        .join("\n");
      return React.createElement(
        "div",
        { className: "dsm-chip", title: detail },
        React.createElement("span", { className: "dsm-chip-v" }, "消费 ¥" + fmtCny(status.cost.total)),
      );
    }

    function BalanceChip(props) {
      if (!props.status) {
        return React.createElement(
          "div",
          { className: "dsm-chip" },
          React.createElement("span", { className: "dsm-chip-v" }, "余额 --"),
        );
      }
      const b = props.status.balance;
      if (!b || !b.ok) {
        const err = b && b.error ? b.error : "余额服务不可用";
        return React.createElement(
          "div",
          { className: "dsm-chip", title: err },
          React.createElement("span", { className: "dsm-chip-v" }, "余额 --"),
        );
      }
      const info = (b.infos && b.infos.find((i) => i.currency === "CNY")) || (b.infos && b.infos[0]);
      if (!info) {
        return React.createElement(
          "div",
          { className: "dsm-chip" },
          React.createElement("span", { className: "dsm-chip-v" }, "余额 --"),
        );
      }
      const sym = info.currency === "USD" ? "$" : "¥";
      return React.createElement(
        "div",
        {
          className: "dsm-chip",
          title:
            "总余额 " +
            sym +
            info.total +
            "（赠金 " +
            sym +
            info.granted +
            " · 充值 " +
            sym +
            info.toppedUp +
            "）\n每 5 分钟自动刷新",
        },
        React.createElement("span", { className: "dsm-chip-v" }, "余额 " + sym + info.total),
        React.createElement("span", { className: "dsm-chip-s" }, info.currency),
      );
    }

    function DsMeterRow(props) {
      const [now, setNow] = React.useState(() => Date.now());
      const [status, setStatus] = React.useState(null);
      const stats = props.useProjection ? props.useProjection("sessionStats") : null;
      const turns = stats && typeof stats.turns === "number" ? stats.turns : 0;
      React.useEffect(() => {
        let alive = true;
        const load = () => {
          setNow(Date.now());
          const sid = props.sessionId ? String(props.sessionId) : "";
          fetch("/api/dsm/status?session=" + encodeURIComponent(sid))
            .then((r) => r.json())
            .then((v) => {
              if (alive) setStatus(v);
            })
            .catch(() => {
              if (alive) setStatus(null);
            });
        };
        load();
        const t = setInterval(load, 30000);
        return () => {
          alive = false;
          clearInterval(t);
        };
      }, [props.sessionId]);
      const rule = status && status.currentEra ? status.currentEra.peakRule : "weekdays";
      return React.createElement(
        "div",
        { className: "dsm-row" },
        React.createElement(PeakChip, { now, rule }),
        React.createElement(CostChip, { status, turns, now, rule }),
        React.createElement(BalanceChip, { status }),
      );
    }

    const inject = ["slots"];
    function apply(ctx) {
      ctx.inject(["slots", "conversation"], (scope) => {
        scope.effect(
          () =>
            scope.slots.register(
              {
                name: "conversation.input.dock",
                id: "ds-meter",
                order: 30,
                inject: () => ({}),
              },
              DsMeterRow,
            ),
          "dsh-meter: dock",
        );
      });
    }

    return { apply, inject };
  },
});
