// Splits a reply under Discord's 2000-character limit at line boundaries.
// A chunk that ends inside a code fence is closed and the fence is reopened in the next chunk.

export const DISCORD_LIMIT = 2000;

const FENCE = /^\s*(```|~~~)/;
const isFence = (line: string) => FENCE.test(line);

/** Number of fence lines in `text`; balanced when even. */
export const fenceCount = (text: string) => text.split("\n").filter(isFence).length;

/** Cuts `text` to `max` characters, closing a code fence the cut left open. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 6)).trimEnd() + "\n…";
  if (fenceCount(cut) % 2 === 1) cut = text.slice(0, Math.max(0, max - 10)).trimEnd() + "\n…\n```";
  return cut;
}

export function splitMessage(text: string, limit = DISCORD_LIMIT): string[] {
  if (limit < 40) throw new Error("limit too small");
  const chunks: string[] = [];
  let lines: string[] = [];
  let size = 0;
  let open: string | null = null; // the opening fence line while inside a fence

  const closeLen = () => (open ? "\n```".length : 0);
  const flush = () => {
    if (!lines.length) return;
    const body = lines.join("\n");
    if (body.trim()) chunks.push(open ? `${body}\n\`\`\`` : body);
    lines = open ? [open] : [];
    size = open ? open.length : 0;
  };
  const push = (line: string) => {
    size += (lines.length ? 1 : 0) + line.length;
    lines.push(line);
  };

  for (const raw of text.split("\n")) {
    // A single line longer than a chunk is hard-split; fence lines are never that long in practice.
    const room: number = limit - (open ? open.length + 1 : 0) - "\n```".length;
    const pieces: string[] = raw.length > room ? raw.match(new RegExp(`[\\s\\S]{1,${room}}`, "g"))! : [raw];
    for (const line of pieces) {
      const fence = isFence(line);
      const closing = fence && open !== null;
      // A closing fence must fit without the extra close we would otherwise add.
      const need = (lines.length ? 1 : 0) + line.length + (closing ? 0 : closeLen()) + (fence && !open ? "\n```".length : 0);
      if (size + need > limit) flush();
      push(line);
      if (fence) open = open ? null : line.trim();
    }
  }
  if (lines.length && !(open && lines.length === 1)) {
    const body = lines.join("\n");
    if (body.trim()) chunks.push(open ? `${body}\n\`\`\`` : body);
  }
  return chunks;
}
