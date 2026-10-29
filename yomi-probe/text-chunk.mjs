// Split long text into chunks with numbering tag for platforms with message length limits.
export function splitTextChunks(text, limit = 4000) {
  if (typeof text !== 'string') return [text];
  const safeLimit = Math.max(10, Math.floor(Number(limit) || 4000));
  if (text.length <= safeLimit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= safeLimit) {
      chunks.push(remaining);
      break;
    }
    let sliceEnd = safeLimit;
    // Prefer splitting at double newlines, single newlines, or spaces
    const lastDoubleNewline = remaining.lastIndexOf('\n\n', sliceEnd);
    if (lastDoubleNewline > sliceEnd * 0.6) {
      sliceEnd = lastDoubleNewline + 2;
    } else {
      const lastNewline = remaining.lastIndexOf('\n', sliceEnd);
      if (lastNewline > sliceEnd * 0.6) {
        sliceEnd = lastNewline + 1;
      } else {
        const lastSpace = remaining.lastIndexOf(' ', sliceEnd);
        if (lastSpace > sliceEnd * 0.7) {
          sliceEnd = lastSpace + 1;
        }
      }
    }
    // Guarantee positive progress to avoid infinite loop
    sliceEnd = Math.max(1, Math.min(remaining.length, sliceEnd));
    chunks.push(remaining.slice(0, sliceEnd));
    remaining = remaining.slice(sliceEnd);
  }
  if (chunks.length <= 1) return chunks;
  const total = chunks.length;
  return chunks.map((chunk, index) => `${chunk.trimEnd()} (${index + 1}/${total})`);
}
