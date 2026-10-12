// The head writes Markdown; Slack renders its own mrkdwn. Converts the common parts line by line:
// bold, italic, strike, links, headings, bullets and code fences. Code is left alone apart from escaping.

/** Slack requires &, < and > escaped in message text. */
export const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const FENCE = /^(\s*)(```|~~~)/;
const BOLD = "\u0000";

function inline(text: string): string {
  // Inline code spans keep their content; only the text between them is converted.
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 ? escapeText(part) : prose(part)))
    .join("");
}

function prose(text: string): string {
  return escapeText(text)
    .replace(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => `<${url}|${label}>`)
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*|__(?=\S)([^_\n]+?)(?<=\S)__/g, (_, a?: string, b?: string) => `${BOLD}${a ?? b}${BOLD}`)
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, "$1_$2_")
    .replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, "~$1~")
    .replaceAll(BOLD, "*");
}

export function toMrkdwn(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      const fence = FENCE.exec(line);
      if (fence) {
        inFence = !inFence;
        // Slack prints a language tag as code, so the opening fence drops it.
        return `${fence[1]}\`\`\``;
      }
      if (inFence) return escapeText(line);
      const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) return `*${inline(heading[1]!).replaceAll("*", "")}*`;
      // Slack has one level of quote; nested markers collapse into it.
      const quote = /^\s*(?:>\s?)+(.*)$/.exec(line);
      if (quote) return `> ${inline(quote[1]!)}`.trimEnd();
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return "──────────";
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bullet) return `${bullet[1]}• ${inline(bullet[2]!)}`;
      return inline(line);
    })
    .join("\n");
}
