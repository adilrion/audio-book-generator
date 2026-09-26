/** A known CLI as the first word, or a relative path to a local binary. */
const COMMAND = /^(?:(?:pnpm|docker|brew|ollama|pip3?|npm|npx|bash|python3?|cd)(?=\s|$)|(?:workers|\.venv|\.)\/\S)/;

export interface SplitHint {
  /** Lead-in text, e.g. "Start it with:" */
  text?: string;
  /** Shell command to copy, e.g. "docker compose up -d redis" */
  command?: string;
  /** Trailing text after the command, e.g. "then retry." */
  after?: string;
}

/**
 * Pull a runnable command out of hints like "Start it with: docker compose up -d redis" or
 * "Install Tesseract with: brew install tesseract — then retry." so it can be shown copyable.
 */
export function splitHint(hint?: string): SplitHint {
  const h = hint?.trim();
  if (!h) return {};
  if (COMMAND.test(h)) return splitAfter({ command: h });
  // Try every "with: / run: / install" lead-in until the rest looks like a shell command.
  for (const m of h.matchAll(/\b(?:with|run|Run|install|Install)\s*:?\s+/g)) {
    const rest = h.slice(m.index + m[0].length);
    if (COMMAND.test(rest)) return splitAfter({ text: `${h.slice(0, m.index + m[0].length).replace(/[:\s]+$/, '')}:`, command: rest });
  }
  return { text: h };
}

function splitAfter(s: SplitHint): SplitHint {
  const [command, ...rest] = (s.command ?? '').split(/\s+[—–]\s+/);
  const after = rest.join(' — ').trim();
  return { ...s, command: command.trim().replace(/[.;]$/, ''), after: after || undefined };
}
