// Verifies that cost accounting uses the price era in force at each request's
// own timestamp (not a single "current" price), and that peak rules follow the
// era: run with `node scripts/verify-pricing.mjs` after editing the price table.
import { apply } from "../lib/index.js";

let handler;
const events = [];

const ctx = {
  get: () => undefined,
  on: () => {},
  webServer: {
    register: (route) => {
      handler = route.handler;
      return () => {};
    },
  },
  sessionQuery: { readSession: async () => ({ events }) },
  credentials: { resolve: async () => undefined },
  shell: { resolve: (spec) => spec, run: async () => ({ exitCode: 0, stdout: { text: "" } }) },
};

const USAGE = { inputTokens: 100000, cacheReadTokens: 1000000, outputTokens: 10000, cacheWriteTokens: 0 };

function request(model, time) {
  events.push({ type: "request/header", time, data: { header: { config: { model } } } });
}
function usage(turn, time) {
  events.push({ type: "assistant/chunk", time, data: { turn, step: 1, chunk: { type: "usage", usage: USAGE } } });
}

// 2026-09-01 10:00 Beijing (Tuesday) -> era "peak-valley", daily peak rule -> peak
request("deepseek-v4-flash", Date.parse("2026-09-01T02:00:00Z"));
usage(1, Date.parse("2026-09-01T02:00:10Z"));
// 2026-09-10 10:00 Beijing (Thursday) -> era "v4.1-flash", weekdays rule -> peak
request("deepseek-flash", Date.parse("2026-09-10T02:00:00Z"));
usage(2, Date.parse("2026-09-10T02:00:10Z"));
// 2026-09-12 10:00 Beijing (Saturday) -> era "v4.1-flash", weekdays rule -> OFF-peak
usage(3, Date.parse("2026-09-12T02:00:10Z"));

apply(ctx);

const out = await new Promise((resolve, reject) => {
  handler(
    { url: "/api/dsm/status?session=test" },
    { writeHead: () => {}, end: (body) => resolve(JSON.parse(body)) },
  ).catch(reject);
});

const line = (r) =>
  `${r.eraId}/${r.family}: peak=${r.cost.peak.toFixed(4)} off=${r.cost.off.toFixed(4)} total=${r.cost.total.toFixed(4)} models=${r.models
    .map((m) => m.id)
    .join(",")}`;

console.log("rows:");
for (const r of out.rows) console.log("  " + line(r));
console.log("total:", out.cost.total.toFixed(4));

// era "peak-valley"  peak flash: 1M*0.10 + 0.1M*3.0 + 0.01M*9.0 = 0.49
// era "v4.1-flash"   peak flash: 1M*0.04 + 0.1M*2.0 + 0.01M*8.0 = 0.32
// era "v4.1-flash"   off  flash: 1M*0.02 + 0.1M*1.0 + 0.01M*4.0 = 0.16
const expected = { "peak-valley/flash": 0.49, "v4.1-flash/flash": 0.48 };
let ok = Math.abs(out.cost.total - 0.97) < 1e-9;
for (const r of out.rows) {
  const want = expected[r.eraId + "/" + r.family];
  if (want === undefined || Math.abs(r.cost.total - want) > 1e-9) ok = false;
}
console.log(ok ? "PASS: historical eras + weekday peak rule applied per request" : "FAIL");
process.exit(ok ? 0 : 1);
