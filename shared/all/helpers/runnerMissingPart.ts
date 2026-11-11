import type { RunnerPartId } from '../validators/runnerParts';

// A runner error that a part of Software would fix (a tool the runner lacks):
// worded once here, so the runner says it the same way everywhere and the
// app can find the part in the words and offer its Install button
// (RunnerErrorStrip) instead of telling the person to use a package manager.

/** The parts an error can name, by the title Software shows. */
const PART_TITLES = {
  secrets: 'Secrets',
  'local-ai': 'Local AI'
} as const satisfies Partial<Record<RunnerPartId, string>>;

export type MissingPartId = keyof typeof PART_TITLES;

const TAIL = " part in the runner's Software tab.";

/** "<what> Add the <part> part in the runner's Software tab." */
export const missingPartMessage = (partId: MissingPartId, what: string) =>
  `${what} Add the ${PART_TITLES[partId]}${TAIL}`;

/** The part an error asks for, or null when it names none. */
export function missingPartOf(message: string): { partId: MissingPartId; title: string } | null {
  for (const [partId, title] of Object.entries(PART_TITLES) as [MissingPartId, string][]) {
    if (message.includes(`Add the ${title}${TAIL}`)) return { partId, title };
  }
  return null;
}
