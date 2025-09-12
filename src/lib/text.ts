import { createHash } from "node:crypto";

/** Helper: hash + normalization used for signatures */
export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** Keep last N lines of a string (safe for empty input) */
export const tailLines = (s: string, n: number) => (s || "").split("\n").slice(-n).join("\n");

/** Aggressive normalization for log signatures and semantic queries 
 * 
 * Normalization rules: strip timestamps, UUIDs, memory addresses, 
 * long numerics, absolute paths → basenames, collapse whitespace, lowercase. 
 * This removes run-specific noise, leaving stacktrace-like information in logs.
*/
export function normalize(s: string) {
  return (s || "")
    .replace(/\d+:\d+/g, "L:C")                                  // line:col
    .replace(/0x[0-9a-f]+/gi, "0xADDR")                          // hex addrs
    .replace(/\b[0-9a-f]{7,}\b/gi, "HEX")                        // long hex ids
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<TIME>")
    .replace(/\b\d{7,}\b/g, "N")                                 // big ints
    .replace(/[/\\][^ \n\t]*/g, m => m.split(/[\/\\]/).pop() ?? m) // basenames
    .toLowerCase()
    .trim();
}

/** Light template-ization used for when we don't have structured fields yet 
 * highlights test or exception-class in log
*/
export function templateize(s: string) {
  return (s || "")
    .replace(/\b\d+\b/g, "N")
    .replace(/[/\\][^ \n\t]*/g, m => m.split(/[\/\\]/).pop() ?? m)
    .toLowerCase();
}

/** Basic redaction for secrets before sending logs to LLMs */
export function redactSecrets(s: string) {
  return (s || "")
    .replace(
      /\b([A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|PASS|PRIVATE|API)[A-Z0-9_]*)\s*[:=]\s*["']?([A-Za-z0-9_\-\/+\.=]{8,})["']?/g,
      "$1=***REDACTED***"
    )
    .replace(/\bgh[opmsa]_[A-Za-z0-9_]{20,}\b/g, "***REDACTED***")
    .replace(/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, "***REDACTED***");
}

/** Clamp cosine distance -> similarity 0..1 */
export function simFromDistance(distance: number | string | null | undefined) {
  const d = Number(distance ?? 1);
  const dc = Math.max(0, Math.min(1, d));
  return 1 - dc;
}

/** 0..1 clamp */
export function clamp01(x: number | undefined) {
  if (typeof x !== "number" || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** Safe stringify with size clamp (avoid giant rows) */
export function jsonClamp(v: unknown, max = 800_000) {
  let s = "";
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return s.length > max ? s.slice(0, max) + ` /* … truncated ${s.length - max} bytes */` : s;
}