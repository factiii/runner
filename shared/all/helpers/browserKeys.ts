// The keys the browser panel passes through to the tab
// (.specs/browser-panel.md). One table for both ends: the panel takes a key
// from the viewer's own browser only when it is here, and the runner sends
// Chrome only what is here.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** `KeyboardEvent.code` to the Windows virtual key code Chrome's key events
 *  carry. Physical keys; ⌘ is absent on purpose, as on the simulator: the
 *  viewer's own browser keeps its shortcuts. */
export const BROWSER_KEY_CODES: Record<string, number> = {
  ...Object.fromEntries([...LETTERS].map((l, i) => [`Key${l}`, 65 + i])),
  ...Object.fromEntries([...'0123456789'].map((d, i) => [`Digit${d}`, 48 + i])),
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222
};

/** The runner refuses a longer `text` command. */
export const BROWSER_TEXT_MAX = 2000;
