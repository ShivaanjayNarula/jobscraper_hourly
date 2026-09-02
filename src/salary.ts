/**
 * Deterministic salary extraction from posting text.
 *
 * Indian postings express compensation three ways, all handled here:
 *
 *   "12-18 LPA" / "₹12–18 Lacs P.A."   → the range directly
 *   "₹ 8,00,000 - 12,00,000 per annum" → absolute yearly rupees
 *   "Stipend: ₹30,000/month"           → monthly, converted ×12
 *
 * Everything returns normalized ₹ LPA so the email and web UI can sort and
 * filter without knowing which shape the source used. A range that fails both
 * bounds checks returns null rather than a garbage number — an unparsed salary
 * displays as nothing, never as something wrong.
 */

export interface Salary {
  minLpa: number;
  maxLpa: number;
}

/** Absolute-INR bounds: below 1 LPA/year it's noise, above 1 Cr it's a typo or equity. */
const MIN_INR = 100_000;
const MAX_INR = 10_000_000;

/** LPA bounds: anything outside can't be an Indian fresher/early-career CTC. */
const MIN_LPA = 1;
const MAX_LPA = 100;

const RANGE_SEP = /\s*(?:[-–—]|to)\s*/;

export function extractSalary(salaryField: string | undefined, text?: string): Salary | null {
  // The ATS's own salary field is far more reliable than the description body,
  // so it's searched alone first; the body is scanned only as a fallback.
  const sources = [salaryField, (text ?? '').slice(0, 2000)].filter(
    (s): s is string => Boolean(s),
  );

  for (const source of sources) {
    const s = source.replace(/,/g, '');

    // Direct LPA/Lakhs range: "12-18 LPA", "₹ 8.5 - 12 Lakhs P.A."
    let m = s.match(new RegExp(`(?:₹\\s*)?(\\d{1,3}(?:\\.\\d)?)${RANGE_SEP.source}(?:₹\\s*)?(\\d{1,3}(?:\\.\\d)?)\\s*(?:lpa|lacs?\\b|lakhs?\\b|lac\\b)`, 'i'));
    if (m) {
      const min = Number(m[1]);
      const max = Number(m[2]);
      // A stated range that fails the sanity bounds poisons the whole source —
      // falling through would let the single-figure pass cherry-pick "99" out
      // of "0.5-99 LPA" and report a confident, wrong number.
      if (min < MIN_LPA || max < min || max > MAX_LPA) return null;
      return { minLpa: min, maxLpa: max };
    }

    // Single LPA figure: "15 LPA fixed"
    m = s.match(/(?:₹\s*)?(\d{1,2}(?:\.\d)?)\s*(?:lpa|\blacs?\b|\blakhs?\b)/i);
    if (m) {
      const v = Number(m[1]);
      if (v >= MIN_LPA && v <= MAX_LPA) return { minLpa: v, maxLpa: v };
    }

    // Absolute annual rupees: "800000-1200000 per annum" (commas pre-stripped)
    m = s.match(new RegExp(`₹?\\s*(\\d{6,7})${RANGE_SEP.source}₹?\\s*(\\d{6,7})`, 'i'));
    if (m) {
      const min = Number(m[1]);
      const max = Number(m[2]);
      if (
        min >= MIN_INR && max >= min && max <= MAX_INR &&
        // "500000-600000" must be yearly, not two monthly figures glued together —
        // require an explicit per annum marker nearby to trust it.
        /per\s*annum|per\s*year|p\.a\.?\b|annually|annual ctc/i.test(s)
      ) {
        return { minLpa: round1(min / 100_000), maxLpa: round1(max / 100_000) };
      }
    }

    // Monthly stipend: "Stipend: ₹30,000/month", "25000 per month"
    m = s.match(/(?:stipend|salary|pay)[^\n.]{0,30}?(?:₹\s*)?(\d{3,6})\s*(?:\/-)?\s*(?:per\s*month|\/\s*month|monthly|p\.?m\.?\b)/i) ??
      s.match(/(?:₹\s*)?(\d{3,6})\s*(?:\/-)?\s*(?:per\s*month|\/\s*month|monthly)[^\n.]{0,30}?(?:stipend|intern)/i);
    if (m) {
      const monthly = Number(m[1]);
      if (monthly >= 5_000 && monthly <= 200_000) {
        const lpa = round1((monthly * 12) / 100_000);
        if (lpa >= 0.5 && lpa <= MAX_LPA) return { minLpa: lpa, maxLpa: lpa };
      }
    }
  }

  return null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Email/UI display form; empty string when unknown so meta rows stay clean. */
export function salaryLabel(salary: Salary | null | undefined): string {
  if (!salary) return '';
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return salary.minLpa === salary.maxLpa
    ? `₹${fmt(salary.minLpa)} LPA`
    : `₹${fmt(salary.minLpa)}–${fmt(salary.maxLpa)} LPA`;
}
