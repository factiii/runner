// Terminal output arrives in pty-sized reads, so an escape sequence can be
// split across two of them. Stripping each read on its own leaves the tail as
// literal text: a chopped `\x1b[2K` put "2K" on the end of a scraped OAuth URL.

// The real CSI grammar, not just digits: parameter bytes 0x30-0x3F, then
// intermediate bytes 0x20-0x2F, then one final byte 0x40-0x7E. A narrower
// pattern misses `\x1b[2 q` (cursor shape) and `\x1b[>4;2m`, and leaks their
// digits into the text. OSC stops at the first terminator rather than running
// to the last one, which would swallow a hyperlink's visible label.
const CSI = String.raw`\x1b\[[0-?]*[ -/]*[@-~]`;
const OSC = String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`;
const TWO_CHAR = String.raw`\x1b[@-Z\\-_]`;
const ANSI_RE = new RegExp(`${CSI}|${OSC}|${TWO_CHAR}`, 'g');
const COMPLETE = new RegExp(`^(?:${CSI}|${OSC}|${TWO_CHAR})`);
// A stray ESC that never terminates must not stall the stream forever.
const MAX_HELD = 64;

// tmux does not pass an app's bytes through; it redraws the screen, moving the
// cursor to each row. Deleting those moves welds separate rows into one line,
// which is how a scraped OAuth URL picked up the "2" from the numbered step
// under it. They are line breaks, so that is what they become.
const CURSOR_MOTION = /^\x1b(?:\[[0-?]*[ -/]*[ABEFHfd]|[DEM])$/;

function replacement(seq: string): string {
  return CURSOR_MOTION.test(seq) ? '\n' : '';
}

/** Strip ANSI across chunk boundaries, holding a trailing partial sequence
 *  back until the rest of it arrives. One stripper per stream. */
export function createAnsiStripper(): (chunk: string) => string {
  let held = '';
  return (chunk) => {
    const text = held + chunk;
    const esc = text.lastIndexOf('\x1b');
    const partial =
      esc !== -1 &&
      !COMPLETE.test(text.slice(esc)) &&
      text.length - esc <= MAX_HELD;
    held = partial ? text.slice(esc) : '';
    return (partial ? text.slice(0, esc) : text).replace(ANSI_RE, replacement);
  };
}
