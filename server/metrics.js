// Business numbers for the brief, worked out from the daily rows in data/demo.json (business.daily).
// daily[0] is yesterday, daily[1] the day before, and so on. Today's sales are not in yet, so
// "month to date" means the full days of this month that are already over.
import { TZ } from "./runtime.js";

const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
const round1 = n => Math.round(n * 10) / 10;
const pct = (part, whole) => (whole ? (part / whole) * 100 : 0);

export function businessMetrics(b, now = new Date()) {
  const daily = b.daily || [];
  const [y, m, d] = now.toLocaleDateString("en-CA", { timeZone: TZ }).split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  // ---- 1. Sales vs monthly target (pace)
  const target = b.monthly_target || 0;
  const elapsed = Math.min(d - 1, daily.length);          // full days of this month that are over
  const mtd = sum(daily.slice(0, elapsed), "sales");       // month-to-date sales
  const expected = target * elapsed / daysInMonth;         // where a straight line to the target would be today
  const daysLeft = daysInMonth - elapsed;                  // today counts as a day left
  const pace = {
    target, mtd, elapsed, daysInMonth, daysLeft,
    expected: Math.round(expected),
    pace_pct: expected ? Math.round((mtd / expected - 1) * 100) : 0,               // + ahead, - behind
    run_rate: elapsed ? Math.round(mtd / elapsed) : 0,                              // average per day so far
    projected: elapsed ? Math.round(mtd / elapsed * daysInMonth) : 0,              // month end at today's run rate
    need_per_day: daysLeft ? Math.round(Math.max(0, target - mtd) / daysLeft) : 0, // to still hit the target
    done_pct: Math.round(pct(mtd, target)),
  };

  // ---- 2. Orders + average order value (AOV = sales ÷ orders)
  const yest = daily[0] || { sales: 0, orders: 0 };
  const week = daily.slice(0, 7), prev = daily.slice(7, 14);
  const w = { sales: sum(week, "sales"), orders: sum(week, "orders"), cogs: sum(week, "cogs"), complaints: sum(week, "complaints"), returns: sum(week, "returns") };
  const p = { sales: sum(prev, "sales"), orders: sum(prev, "orders"), cogs: sum(prev, "cogs"), complaints: sum(prev, "complaints"), returns: sum(prev, "returns") };
  const aov = yest.orders ? Math.round(yest.sales / yest.orders) : 0;
  const aovWeek = w.orders ? Math.round(w.sales / w.orders) : 0;
  const orders = {
    sales: yest.sales, orders: yest.orders, aov,
    week_orders: w.orders, week_sales: w.sales, aov_week: aovWeek,
    aov_vs_week_pct: aovWeek ? Math.round((aov / aovWeek - 1) * 100) : 0,
  };

  // ---- 3. Gross margin % = (sales - cost of goods sold) ÷ sales, this week vs last week
  const gm = round1(pct(w.sales - w.cogs, w.sales));
  const gmPrev = round1(pct(p.sales - p.cogs, p.sales));
  const margin = {
    pct: gm, prev_pct: gmPrev, change_pts: round1(gm - gmPrev),
    week_sales: w.sales, week_cogs: w.cogs, week_profit: w.sales - w.cogs,
  };

  // ---- 4. Complaints / returns: this week vs last week, and per 100 orders
  const issues = w.complaints + w.returns, issuesPrev = p.complaints + p.returns;
  const quality = {
    complaints: w.complaints, returns: w.returns, total: issues,
    prev_complaints: p.complaints, prev_returns: p.returns, prev_total: issuesPrev,
    per_100_orders: round1(pct(issues, w.orders)),
    prev_per_100_orders: round1(pct(issuesPrev, p.orders)),
    worse: issues > issuesPrev,
  };

  return { pace, orders, margin, quality };
}
