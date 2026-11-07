import fs from 'node:fs';
import path from 'node:path';

import { safeSlug } from './paths';

// Boards by their stable id (card 90612d66). Everything the runner keeps for
// a board is named by its slug: its folder, and its key in access.json. A
// space's slug follows its name, so renaming the space used to leave the
// runner with an empty board under the new slug and everything under the old.
//
// `spaces.json` remembers the slug each board id last came with, the slugs it
// had before, and the space's name, which is what the runner says when it
// talks about the board. When an id comes with another slug (the server's
// `runner:space-renamed`, its answer to `runner:board-names`, or any message
// that carries the id), the folder moves to the new slug and the old name
// stays behind as a link to it: worktrees, running terminals and every path
// an agent already holds keep resolving. Board listings read real
// directories only (Dirent.isDirectory), so the link is never a second board.

const REGISTRY_FILE = 'spaces.json';
/** Old slugs kept per board, so a terminal or a pin that still names one
 *  finds the board. */
const MAX_FORMER_SLUGS = 5;

export type BoardRename = { from: string; to: string };

/**
 * What `spaces.json` holds per board id. The plugin's programs read it too
 * (bin/factiii-secrets, bin/session-context.sh), and they are plain JS and
 * shell: keep it this flat. A runner from before names were kept wrote the
 * slug alone (`{"66":"my-board"}`), which reads as `{ slug }`.
 */
export type BoardEntry = {
  /** The slug the board last came with: its folder's name. */
  slug: string;
  /** The space's name as the server last gave it. What a person is shown. */
  name?: string;
  /** Slugs it had before, newest first. */
  was?: string[];
};

export type KnownBoard = BoardEntry & { id: number };

type Registry = Record<string, BoardEntry>;

function asEntry(value: unknown): BoardEntry | null {
  if (typeof value === 'string') return value ? { slug: value } : null;
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.slug !== 'string' || !v.slug) return null;
  const was = Array.isArray(v.was)
    ? v.was.filter((s): s is string => typeof s === 'string' && s !== '')
    : [];
  return {
    slug: v.slug,
    ...(typeof v.name === 'string' && v.name.trim() ? { name: v.name.trim() } : {}),
    ...(was.length ? { was } : {})
  };
}

function readRegistry(configDir: string): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, REGISTRY_FILE), 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const registry: Registry = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = asEntry(value);
      if (entry) registry[key] = entry;
    }
    return registry;
  } catch {
    return {};
  }
}

function writeRegistry(configDir: string, registry: Registry): void {
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, REGISTRY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const isRealDir = (dir: string): boolean => {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Record that board `spaceId` is called `slug` now, and `name` when the
 * message carried one. Answers the rename when the id last came with another
 * slug, after moving the folder (when the old one is a real folder and the
 * new name is free), and null otherwise. Never throws: a registry or folder it
 * cannot touch is logged and left as it is.
 */
export function noteBoard(
  configDir: string,
  spaceId: number,
  slug: string,
  name?: string
): BoardRename | null {
  if (!Number.isInteger(spaceId) || spaceId <= 0 || !slug) return null;
  try {
    const registry = readRegistry(configDir);
    const key = String(spaceId);
    const known = registry[key];
    const from = known?.slug;
    const nextName = name?.trim() || known?.name;
    if (from === slug && nextName === known?.name) return null;
    const earlier = (known?.was ?? []).filter((s) => s !== slug && s !== from);
    const was = from && from !== slug ? [from, ...earlier] : earlier;
    registry[key] = {
      slug,
      ...(nextName ? { name: nextName } : {}),
      ...(was.length ? { was: was.slice(0, MAX_FORMER_SLUGS) } : {})
    };
    writeRegistry(configDir, registry);
    if (!from || from === slug) return null;

    const oldDir = path.join(configDir, safeSlug(from));
    const newDir = path.join(configDir, safeSlug(slug));
    if (isRealDir(oldDir) && !fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
      // Relative, so the runner folder can move as a whole.
      fs.symlinkSync(safeSlug(slug), oldDir);
    } else if (isRealDir(oldDir)) {
      console.error(
        `[boards] ${boardLabel(registry[key], slug)} was ${from}, but a folder named ${safeSlug(slug)} already exists. Both are kept; nothing was moved.`
      );
    }
    return { from, to: slug };
  } catch (err) {
    console.error(`[boards] could not record board ${spaceId} as ${slug}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Every board the runner has been told about. */
export function knownBoards(configDir: string): KnownBoard[] {
  return Object.entries(readRegistry(configDir))
    .map(([key, entry]) => ({ id: Number(key), ...entry }))
    .filter((b) => Number.isInteger(b.id) && b.id > 0);
}

/**
 * The board a message, a terminal or a pin means: by id when it has one,
 * else by its slug now, else by a slug it had before (a terminal started
 * before a rename still holds that one). Undefined for a board the runner has
 * never been told about.
 */
export function findBoard(
  configDir: string,
  ref: { id?: number; slug?: string }
): KnownBoard | undefined {
  const boards = knownBoards(configDir);
  if (ref.id !== undefined) {
    const byId = boards.find((b) => b.id === ref.id);
    if (byId) return byId;
  }
  const slug = ref.slug;
  if (!slug) return undefined;
  return boards.find((b) => b.slug === slug) ?? boards.find((b) => b.was?.includes(slug));
}

/**
 * How the runner names a board to a person: the space's name, with the slug
 * after it where the two differ (the slug is what a command takes and what
 * the folder is called). The slug alone for a board it knows no name for.
 */
export function boardLabel(board: Pick<BoardEntry, 'slug' | 'name'> | undefined, slug: string): string {
  const current = board?.slug ?? slug;
  const name = board?.name;
  if (!name) return current;
  return name.toLowerCase() === current.toLowerCase() ? name : `${name} (${current})`;
}

/** `boardLabel` for a slug the runner holds, current or former. */
export function describeBoard(configDir: string, slug: string): string {
  return boardLabel(findBoard(configDir, { slug }), slug);
}

/** `map` with the entry under `from` moved to `to`, or `map` itself when
 *  there is none. An entry already under `to` is replaced. */
export function rekeyBoard<T>(map: Record<string, T>, rename: BoardRename): Record<string, T> {
  if (!Object.hasOwn(map, rename.from)) return map;
  const { [rename.from]: moved, ...rest } = map;
  return { ...rest, [rename.to]: moved };
}
