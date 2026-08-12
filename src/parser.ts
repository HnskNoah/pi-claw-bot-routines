/**
 * @file parser.ts — interval string → milliseconds.
 *
 * Accepts forms like "30s", "5m", "1h", "1h30m", "2h 15m", "25 minutes",
 * "1 hour", optionally prefixed with "every ". Rejects intervals shorter
 * than 30s or longer than 24h with clear, user-readable error messages.
 *
 * Pure module — no I/O, no side effects.
 */

import type { ParsedInterval } from "./types.ts";

const MIN_MS = 10_000; // patched by pi: github 10s polling floor (user requested)
const MAX_MS = 24 * 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

/** Matches one `<number><unit>` segment, e.g. "1h", "30 minutes", "90s". */
const SEGMENT_RE = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;

/**
 * Parse a human interval string into `{ ms, human }`.
 *
 * @throws Error with a user-readable message on:
 *   - intervals < 30s ("Interval must be at least 30 seconds")
 *   - bare numbers with no unit ("Specify a unit: 5s, 5m, or 5h")
 *   - intervals > 24h ("Intervals over 24h should use a cron trigger instead")
 *   - unparseable input ("Could not parse interval: '<input>'. Examples: 5m, 1h, 90s")
 */
export function parseInterval(input: string): ParsedInterval {
	const original = input;
	let s = input.trim().toLowerCase();
	if (s.startsWith("every ")) s = s.slice("every ".length).trim();

	if (s.length === 0) {
		throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
	}

	// Bare number (no unit) → friendly message.
	if (/^\d+(?:\.\d+)?$/.test(s)) {
		throw new Error("Specify a unit: 5s, 5m, or 5h");
	}

	// Collect all <number><unit> segments and require the entire string be
	// composed of them (plus whitespace).
	const matches = Array.from(s.matchAll(SEGMENT_RE));
	if (matches.length === 0) {
		throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
	}
	const consumed = matches.reduce((n, m) => n + m[0].length, 0);
	const residual = s.replace(/\s+/g, "").replace(SEGMENT_RE, "").trim();
	if (residual.length > 0 || consumed === 0) {
		throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
	}

	let ms = 0;
	for (const m of matches) {
		const n = Number(m[1]);
		const unit = m[2];
		const factor = UNIT_MS[unit];
		if (factor === undefined) {
			throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
		}
		if (!Number.isFinite(n) || n < 0) {
			throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
		}
		ms += n * factor;
	}

	if (ms > MAX_MS) {
		throw new Error("Intervals over 24h should use a cron trigger instead");
	}
	if (ms < MIN_MS) {
		throw new Error("Interval must be at least 30 seconds");
	}

	return { ms, human: formatHuman(ms) };
}

/** Normalize a millisecond duration to a compact human string. */
function formatHuman(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;

	const parts: string[] = [];
	if (h > 0) parts.push(`${h}h`);
	if (m > 0) parts.push(`${m}m`);
	if (s > 0) parts.push(`${s}s`);
	return parts.length > 0 ? parts.join("") : "0s";
}

// ─── Cron parser (5-field POSIX subset) ───────────────────────────

export interface ParsedCron {
	minutes: number[];
	hours: number[];
	dom: number[];
	month: number[];
	dow: number[];
	/** True if the original dom field was `*` (used for day-OR semantics). */
	domStar: boolean;
	/** True if the original dow field was `*`. */
	dowStar: boolean;
}

const CRON_RANGES = [
	[0, 59], // minutes
	[0, 23], // hours
	[1, 31], // dom
	[1, 12], // month
	[0, 6], // dow (0 = Sun)
] as const;

function expandField(field: string, lo: number, hi: number): number[] {
	if (/[?L#]/.test(field)) {
		throw new Error(`Cron: unsupported character in field '${field}' ('?', 'L', '#' not allowed)`);
	}
	const out = new Set<number>();
	for (const part of field.split(",")) {
		let step = 1;
		let range = part;
		const slash = part.indexOf("/");
		if (slash >= 0) {
			range = part.slice(0, slash);
			const stepStr = part.slice(slash + 1);
			step = Number(stepStr);
			if (!Number.isInteger(step) || step <= 0) {
				throw new Error(`Cron: invalid step '${stepStr}' in '${field}'`);
			}
		}
		let start: number;
		let end: number;
		if (range === "*") {
			start = lo;
			end = hi;
		} else if (range.includes("-")) {
			const [a, b] = range.split("-");
			start = Number(a);
			end = Number(b);
		} else {
			start = Number(range);
			end = step > 1 ? hi : start;
		}
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < lo ||
			end > hi ||
			start > end
		) {
			throw new Error(`Cron: value out of range in '${field}' (expected ${lo}–${hi})`);
		}
		for (let i = start; i <= end; i += step) out.add(i);
	}
	return Array.from(out).sort((a, b) => a - b);
}

/**
 * Parse a 5-field POSIX cron expression. Supports `*`, `*\/n`, `a,b,c`, `a-b`.
 * Rejects 6-field (seconds-prefixed) forms and special characters `?`, `L`, `#`.
 *
 * Day-of-week 7 is normalised to 0 (Sunday).
 *
 * @throws Error on syntax error, out-of-range values, or > 1440 fires/day.
 */
export function parseCron(expr: string): ParsedCron {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`Cron: expected 5 fields (min hour dom month dow), got ${fields.length}`);
	}
	const [fMin, fHour, fDom, fMonth, fDow] = fields;
	const minutes = expandField(fMin, CRON_RANGES[0][0], CRON_RANGES[0][1]);
	const hours = expandField(fHour, CRON_RANGES[1][0], CRON_RANGES[1][1]);
	const dom = expandField(fDom, CRON_RANGES[2][0], CRON_RANGES[2][1]);
	const month = expandField(fMonth, CRON_RANGES[3][0], CRON_RANGES[3][1]);
	// Accept 7 as Sunday: normalise then expand.
	const dowNorm = fDow.replace(/\b7\b/g, "0");
	const dow = expandField(dowNorm, CRON_RANGES[4][0], CRON_RANGES[4][1]);

	const domStar = fDom === "*";
	const dowStar = fDow === "*";

	// DOS guard: cron expressions cannot match more than 1440 times/day.
	// In POSIX, if both dom and dow are non-`*`, the day matches if EITHER
	// matches (Vixie cron) — we approximate with min(possible days)×minutes×hours.
	const firesPerDay = minutes.length * hours.length;
	if (firesPerDay > 1440) {
		throw new Error(`Cron: matches ${firesPerDay} times/day (>1440 limit)`);
	}

	return { minutes, hours, dom, month, dow, domStar, dowStar };
}

/**
 * Compute the next Date at which `expr` fires, strictly after `from`.
 *
 * Timezone semantics: when `tz` is omitted, evaluates in system local time.
 * When `tz` is provided (IANA name), all date arithmetic is performed in
 * that zone via `Intl.DateTimeFormat` field extraction; the returned `Date`
 * is the corresponding UTC instant.
 */
export function nextCronFire(expr: string, tz: string | undefined, from: Date): Date {
	const spec = parseCron(expr);
	// Bump to next minute boundary in the target zone.
	let probe = new Date(from.getTime() + 60_000 - (from.getTime() % 60_000));

	// Hard cap on search horizon: 4 years (handles Feb-29-only schedules).
	const horizonMs = 4 * 366 * 86_400_000;
	const limit = from.getTime() + horizonMs;

	while (probe.getTime() <= limit) {
		const f = zonedFields(probe, tz);
		const dowMatch = spec.dow.includes(f.dow);
		const domMatch = spec.dom.includes(f.dom);
		// Vixie cron: if both dom and dow are restricted, OR them; else AND.
		const dayMatch = spec.domStar || spec.dowStar ? domMatch && dowMatch : domMatch || dowMatch;
		if (
			spec.minutes.includes(f.minute) &&
			spec.hours.includes(f.hour) &&
			spec.month.includes(f.month) &&
			dayMatch
		) {
			return probe;
		}
		probe = new Date(probe.getTime() + 60_000);
	}
	throw new Error(`Cron: no fire within 4 years for '${expr}'`);
}

/** Extract calendar fields for `d` in zone `tz` (or system local if undefined). */
function zonedFields(
	d: Date,
	tz: string | undefined,
): { minute: number; hour: number; dom: number; month: number; dow: number } {
	if (!tz) {
		return {
			minute: d.getMinutes(),
			hour: d.getHours(),
			dom: d.getDate(),
			month: d.getMonth() + 1,
			dow: d.getDay(),
		};
	}
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		weekday: "short",
	});
	const parts: Record<string, string> = {};
	for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
	const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
	return {
		minute: Number(parts.minute),
		hour: parts.hour === "24" ? 0 : Number(parts.hour),
		dom: Number(parts.day),
		month: Number(parts.month),
		dow: dowMap[parts.weekday] ?? 0,
	};
}

/**
 * Parse a one-off ISO-8601 timestamp into a UTC `Date`.
 *
 * Accepts both:
 *   - `"2026-06-01T09:00:00Z"` or any string with an explicit offset — used as-is.
 *   - `"2026-06-01T09:00:00"` (no offset) — treated as local time in `tz`
 *     when provided, otherwise system local.
 *
 * @throws Error if the timestamp is unparseable or already in the past (>30s ago).
 */
export function parseOneOff(iso: string, tz?: string): Date {
	if (typeof iso !== "string" || iso.length === 0) {
		throw new Error("One-off: timestamp is empty");
	}
	const hasOffset = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
	let d: Date;
	if (hasOffset || !tz) {
		d = new Date(iso);
	} else {
		// Interpret as wall-clock in `tz` by binary-searching the UTC instant
		// whose zoned fields match the requested ones.
		const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
		if (!m) throw new Error(`One-off: could not parse '${iso}'`);
		const [, Y, Mo, D, H, Mi, S] = m;
		const target = { y: +Y, mo: +Mo, d: +D, h: +H, mi: +Mi, s: S ? +S : 0 };
		// Seed with UTC interpretation, then adjust by the zone offset at that instant.
		let guess = Date.UTC(target.y, target.mo - 1, target.d, target.h, target.mi, target.s);
		for (let i = 0; i < 3; i++) {
			const f = zonedFields(new Date(guess), tz);
			const guessUtcMin =
				Date.UTC(target.y, target.mo - 1, target.d, target.h, target.mi, target.s) / 60_000;
			const zonedMin = Date.UTC(target.y, f.month - 1, f.dom, f.hour, f.minute, target.s) / 60_000;
			const deltaMin = guessUtcMin - zonedMin;
			if (deltaMin === 0) break;
			guess += deltaMin * 60_000;
		}
		d = new Date(guess);
	}
	if (Number.isNaN(d.getTime())) {
		throw new Error(`One-off: could not parse '${iso}'`);
	}
	if (d.getTime() < Date.now() - 30_000) {
		throw new Error(`One-off: '${iso}' is in the past`);
	}
	return d;
}

// ─── Inline self-test (run with `node --import tsx src/parser.ts`) ───────────
// Guarded so it doesn't execute when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
	const cases: Array<[string, number | "throws"]> = [
		["30s", 30_000],
		["5m", 300_000],
		["1h", 3_600_000],
		["1h30m", 5_400_000],
		["2h 15m", 8_100_000],
		["25 minutes", 1_500_000],
		["1 hour", 3_600_000],
		["every 5m", 300_000],
		["90s", 90_000],
		["0s", "throws"],
		["5", "throws"],
		["2d", "throws"],
		["9999h", "throws"],
		["banana", "throws"],
	];
	let fail = 0;
	for (const [input, expected] of cases) {
		try {
			const got = parseInterval(input);
			if (expected === "throws") {
				console.error(`FAIL ${input}: expected throw, got ${got.ms}`);
				fail++;
			} else if (got.ms !== expected) {
				console.error(`FAIL ${input}: expected ${expected}, got ${got.ms}`);
				fail++;
			}
		} catch (err) {
			if (expected !== "throws") {
				console.error(`FAIL ${input}: unexpected throw ${(err as Error).message}`);
				fail++;
			}
		}
	}
	console.log(fail === 0 ? "parser ok" : `parser FAIL (${fail})`);
	if (fail > 0) process.exit(1);
}
