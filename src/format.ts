// One byte formatter, imported by both the analyzer and the reporter.
//
// The two classes previously held byte-identical private copies. The analyzer
// prints progress sizes and the reporter prints every table, report and cleanup
// prompt, so editing one copy produced inconsistent sizes inside a single run
// with nothing to signal it.
//
// The unit table runs to PB — 1 PB is already past Number.MAX_SAFE_INTEGER in
// bytes, so there is nothing above it worth naming — and the index is clamped
// to the table. The old table stopped at GB and was indexed unclamped, so
// anything from 1 TiB upwards printed its number followed by the word
// "undefined": "1 undefined" rather than "1 TB". That is a plausible output for
// a tool whose whole purpose is auditing accounts where artifact storage has
// got out of hand.
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const STEP = 1024;

// Non-finite, zero and negative inputs all render as "0 B" rather than as
// "NaN undefined". A size is never legitimately negative here, and a totals row
// reading "NaN" helps nobody diagnose why.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const exponent = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(STEP)), UNITS.length - 1)
  );

  // parseFloat drops the trailing zeros toFixed adds, keeping "1.5 GB" and
  // "1 GB" rather than "1.50 GB" and "1.00 GB". That is the existing output
  // format, which the table column widths and the README examples both assume.
  return `${parseFloat((bytes / Math.pow(STEP, exponent)).toFixed(2))} ${UNITS[exponent]}`;
}
