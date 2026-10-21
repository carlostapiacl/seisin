/**
 * The launcher's trace, carried into the log.
 *
 * A launcher that runs many agents (a team, a CI job) gives each run a W3C
 * `TRACEPARENT`. Without it in the log, nothing says which of these lines belong
 * to which of the launcher's runs, and the log cannot be joined with anything
 * else that observed the same run (a tracer, the launcher's own spans). With it,
 * any OpenTelemetry tool joins them by trace id; seisin does not need to know
 * who else is looking.
 *
 * Only a well-formed value is used (W3C Trace Context, version 00): a malformed
 * one is ignored rather than copied into a log that other tools will trust.
 */

const PART = { version: /^[0-9a-f]{2}$/, trace: /^[0-9a-f]{32}$/, span: /^[0-9a-f]{16}$/, flags: /^[0-9a-f]{2}$/ };

/** `{ trace_id, span_id }` from a `TRACEPARENT` value, or null. */
export function parseTraceparent(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split("-");
  if (parts.length < 4) return null;
  const [version, trace, span, flags] = parts;
  if (!PART.version.test(version) || version === "ff") return null;
  if (version === "00" && parts.length !== 4) return null;
  if (!PART.trace.test(trace) || !PART.span.test(span) || !PART.flags.test(flags)) return null;
  if (/^0+$/.test(trace) || /^0+$/.test(span)) return null;
  return { trace_id: trace, span_id: span };
}

/** The fields a log entry carries for the launcher's trace: `{}` when there is none. */
export function traceFields(env = process.env) {
  return parseTraceparent(env.TRACEPARENT) ?? {};
}
