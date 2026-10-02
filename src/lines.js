/** Bounded newline framing for the audit channel and the stdio MCP server. */
export function lineReader(consume, { maxBytes = 1_000_000, onTooLong } = {}) {
  let buffer = "", bytes = 0, discarding = false;
  return (chunk) => {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", from);
      const part = nl === -1 ? chunk.slice(from) : chunk.slice(from, nl);
      if (!discarding) {
        bytes += Buffer.byteLength(part);
        if (bytes > maxBytes) {
          buffer = ""; bytes = 0; discarding = true;
          onTooLong?.();
        } else buffer += part;
      }
      if (nl === -1) return;
      // Discard the entire oversized frame, including any later chunks, up
      // to its newline. Its suffix is never a fresh request. A burst of many
      // valid frames, however, is not one oversized frame.
      if (!discarding && buffer.trim()) consume(buffer);
      buffer = ""; bytes = 0; discarding = false;
      from = nl + 1;
      if (from === chunk.length) return;
    }
  };
}
