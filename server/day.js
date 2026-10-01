// Calendar-day helpers. A journal day is the writer's own local date ('YYYY-MM-DD'), which the
// browser sends with every request — the server's clock and timezone must not decide whether
// something written at 06:00 in Jakarta belongs to today or yesterday.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const toMs = (day) => Date.parse(`${day}T00:00:00Z`);

/** True for a well-formed date that actually exists (rejects 2026-02-31). */
function isRealDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const ms = toMs(s);
  return !Number.isNaN(ms) && utcDay(ms) === s;
}

/** The day `n` days after `day` (negative n goes back). */
const shiftDay = (day, n) => utcDay(toMs(day) + n * DAY_MS);

/** The Monday of the week `day` falls in. */
function mondayOf(day) {
  const weekday = (new Date(toMs(day)).getUTCDay() + 6) % 7; // Monday = 0
  return shiftDay(day, -weekday);
}

/**
 * The caller's local date, from the X-Local-Date header. No timezone is more than a day away
 * from UTC, so a claim further off than that is ignored and the server's UTC date is used.
 */
function clientDay(req) {
  const claimed = req.get('x-local-date');
  const fallback = utcDay();
  if (isRealDay(claimed) && Math.abs(toMs(claimed) - toMs(fallback)) <= DAY_MS) return claimed;
  return fallback;
}

module.exports = { isRealDay, shiftDay, mondayOf, clientDay, utcDay };
