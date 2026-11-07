import {
  PREMIUM_MONTHLY_CENTS,
  priceEndingIn99Cents,
  storePriceCents,
  SUBSCRIPTION_TRON_ALLOWANCE_PERCENT,
  subscriptionAllowanceTrons
} from './products';

// Oakbox (.specs/oakbox.md) — the private file app.
//
// Oakbox is the OneDrive vault with the OneDrive taken out: files land in R2
// instead of a Graph drive, and everything downstream (extract → content rows →
// vectors → ROOT factiii walk) is the same pipeline the sync runs. These are the
// constants the server, the mobile app and the seed all have to agree on, so
// they live here rather than being retyped in three places.

/** The space storage plans are sold in. Not `premium`: a storage plan and the
 *  Factiii monthly subscription must be holdable at once, and the purchase path
 *  allows one active MONTHLY_SUBSCRIPTION per space. */
export const OAKBOX_SPACE_SLUG = 'oakbox';

/** Said wherever a file goes in — Oakbox and the Factiii vault alike, since
 *  both run the same ingest. The legal pages carry the detail; this line exists
 *  so nobody has to read them to learn the two facts that matter before a drop:
 *  a model reads every file, and the files are not end-to-end encrypted. */
export const FILE_AI_NOTICE =
  'AI from Anthropic or OpenAI reads each file you add, to tag and search it. Your files are private to you and anyone you share your vault with, but not end-to-end encrypted.';

/** The first tier: what a premium member has before buying a plan. Small on
 *  purpose — it is enough to try the app on, not enough to live in. A bought
 *  tier REPLACES it, so a 50 GB plan is 50 GB, not 60. */
export const OAKBOX_INCLUDED_GB = 10;

// A file search under this many characters is not a search (vaultSearch.ts).
export { VAULT_SEARCH_MIN_CHARS } from './vaultSearch';

// How many accounts may be on one vault's access list, the team of its
// owner's profile board (.todos/oakbox-sessions.md "The profile's board").
// A list, not a pair; the cap only bounds a runaway invite loop.
export const MAX_VAULT_MEMBERS = 50;

/**
 * True when a product sells storage ABOVE the tier premium already carries.
 *
 * Premium IS the OAKBOX_INCLUDED_GB rung, so it carries a `storageGb` like
 * every other one. `storageGb !== null` therefore stopped meaning "a storage
 * plan rather than premium" and started meaning "a rung", which Premium is.
 * Every rule that exists to stop premium being sold twice needs the narrower
 * question, and this is it: does this row sell bytes the buyer does not
 * already have from premium alone?
 */
export const sellsExtraStorage = (storageGb: number | null): boolean =>
  storageGb !== null && storageGb > OAKBOX_INCLUDED_GB;

/** Bytes in a gigabyte, as the plans are sold. Decimal, not binary: Apple
 *  advertises "50 GB", and a quota that reads 46.6 in the app would be wrong
 *  against the thing it copies. */
export const BYTES_PER_GB = 1_000_000_000;

/**
 * What a gigabyte costs us for a month, and what we therefore charge.
 *
 * Written as a model rather than five numbers so re-pricing is one constant.
 * The prices below are DERIVED — change the rate here and every tier moves
 * together, which is the only way the margin stays what we say it is.
 *
 * This is Cloudflare R2 (see clients/storage.ts), which charges for stored
 * bytes and nothing for egress. There is therefore no egress term: the old
 * model added an assumed 5% of stored bytes at the S3 egress rate, and on R2
 * that term is zero. Class A/B operation charges are real but tiny next to the
 * bytes — a drop of a thousand files costs a fraction of a cent.
 */
const R2_STORAGE_USD_PER_GB_MONTH = 0.015;

/**
 * How many bytes of quota one byte of the vault's Postgres rows uses.
 *
 * The tiers are priced as if every byte were a file in R2. Text and vectors
 * live in RDS instead, which costs $0.115/GB-month against the R2 rate above
 * — 7.7× as much. Charging database bytes at a multiple of that keeps every
 * tier priced as R2: 1 GB of quota is 1 GB of files, or 100 MB of rows at 10×.
 *
 * 10 rather than 7.7 because `pg_column_size` leaves out indexes, page
 * overhead and backups, so the disk RDS bills is more than the quota counts.
 *
 * Lives in SystemCache (`vaultDatabaseStorageMultiplier`) so admin retunes it
 * without a deploy once we see how real vaults split — this constant is only
 * the fallback when the cache has no row.
 */
export const DEFAULT_DATABASE_STORAGE_MULTIPLIER = 10;

/**
 * Below 1 a row would be cheaper than a file, which it never is; the ceiling
 * only stops a typo from locking every text-heavy vault out of its plan.
 */
const MAX_DATABASE_STORAGE_MULTIPLIER = 100;
export const clampDatabaseStorageMultiplier = (multiplier: number): number => {
  if (!Number.isFinite(multiplier)) return DEFAULT_DATABASE_STORAGE_MULTIPLIER;
  return Math.min(Math.max(multiplier, 1), MAX_DATABASE_STORAGE_MULTIPLIER);
};

/**
 * How full we price a vault to be.
 *
 * A plan is sold by its ceiling but paid for by its contents, and almost
 * nobody fills one. So a tier is priced to break even at this much of it used:
 * below the line the plan earns, above it the plan costs. 0.7 is a decision,
 * not a measurement — revisit it once real vaults show their fill.
 *
 * Apple's own tier prices were the other candidate, twice, and they cover this
 * for no tier: $9.99 for 2 TB nets $8.49 after the store's 15%, and 70% of 2 TB
 * is $21 of R2 alone. Apple owns its datacentres; we rent ours — R2 at $15/TB
 * and RDS at $110/TB, which is what the multiplier below normalises.
 */
const ASSUMED_FILL_RATIO = 0.7;

/**
 * Trons the FIRST tier grants per cycle — the 10 GB tier, which is the standing
 * Premium Subscription itself.
 *
 * Every tier grants SUBSCRIPTION_TRON_ALLOWANCE_PERCENT of its own price, the
 * same rule the Factiii subscription follows, so a bigger plan carries more AI
 * credit. It is not flat any more: a plan that costs seven times as much and
 * handed back the same $2.00 of credit was the odd one out among our
 * subscriptions, and the tier price below now reserves the allowance rather
 * than leaving premium's fee to carry it.
 *
 * Derived from premium's own price through the same helper the seed uses, so
 * repricing premium moves the first tier's allowance and they cannot drift.
 */
export const OAKBOX_PLAN_TRONS = subscriptionAllowanceTrons(
  PREMIUM_MONTHLY_CENTS
);

/**
 * What a tier COSTS us for a month, in cents — the price before rounding.
 *
 * A plan is premium plus more room, and it is priced that way: PREMIUM_MONTHLY_CENTS
 * for everything premium already sells (the benefits, the tron allowance and
 * OAKBOX_INCLUDED_GB), then the bytes the tier adds on top. So a plan can never
 * undercut the standing subscription it contains.
 *
 * Base only: per .specs/products.md the IAP store prices are marked up from
 * this to cover Apple's and Google's commission, so the price must NOT try to
 * absorb that here as well.
 *
 */
const storageTierCostCents = (gb: number): number => {
  // Premium's own fee, unchanged: it already buys the premium benefits, the
  // tron allowance on the first tier and OAKBOX_INCLUDED_GB itself. A plan IS
  // premium with a bigger tier, so it charges that fee and then charges only
  // for the bytes the tier adds above those 10 GB.
  const extra =
    (gb - OAKBOX_INCLUDED_GB) *
    ASSUMED_FILL_RATIO *
    R2_STORAGE_USD_PER_GB_MONTH;
  // The added bytes are grossed up by the tron allowance, because the
  // allowance is a share of the WHOLE price and not of premium's fee alone.
  // Without this the credit comes out of the bytes, which have no margin to
  // give: the 6 TB tier is $63 of R2 at ASSUMED_FILL_RATIO inside a $72.99
  // price, so a 20% allowance would be $14.60 against $7.99 of gross and the
  // tier would lose $4.61 a month at the fill it is priced for.
  //
  // Solving price = premiumNonTron + bytes + allowance x price gives
  // price = PREMIUM_MONTHLY_CENTS + bytes / (1 - allowance), which leaves the
  // same gross behind every tier as the flat allowance did.
  const allowanceShare = SUBSCRIPTION_TRON_ALLOWANCE_PERCENT / 100;
  // No margin term on the extra bytes: the margin IS the empty space. The tier
  // breaks even at ASSUMED_FILL_RATIO of what it adds, and earns below it. The
  // store price carries Apple's 15% on top (base / 0.85, .specs/products.md).
  return (
    PREMIUM_MONTHLY_CENTS + Math.ceil((extra * 100) / (1 - allowanceShare))
  );
};

/**
 * The Stripe base price for a tier, in cents: the cost above, rounded UP to the
 * next price ending in .99 through the shared priceEndingIn99Cents — the same
 * rounding rule the store prices use, in one place.
 *
 * Up only, so a tier can never sit below what its bytes cost, and what the
 * rounding adds is margin on top of the break-even price. Apple sells its own
 * tiers on .99 points, and a price straight out of a cost model reads as
 * arithmetic ($10.41).
 */
const storageTierCents = (gb: number): number =>
  priceEndingIn99Cents(storageTierCostCents(gb));

type StorageTier = {
  /** Product ID in App Store Connect / Play Console, and the seed's lookup key. */
  sku: string;
  label: string;
  gb: number;
  /** Stripe base price in cents — the canonical price, per .specs/products.md. */
  cents: number;
  /** What the cost model asked for, before the .99 rounding. The difference is margin. */
  costCents: number;
  /** What Apple and Google charge, derived from `cents` by storePriceCents. */
  storeCents: number;
  /** Trons granted per cycle, priced into `cents`. */
  trons: number;
};

/**
 * iCloud+'s tier SIZES, deliberately: a storage amount the buyer already knows
 * makes the comparison easy. The prices are ours and are derived from what the
 * storage actually costs us — Apple runs its own datacentres and prices a
 * gigabyte of its big tiers at a third of what R2 charges us for one, so
 * copying their numbers would mean selling every tier at a loss. Our price per
 * GB has a floor of the R2 rate plus the margin; Apple's floor is near zero.
 *
 * The ladder STOPS AT 6 TB. Decided 2026-09-23: a 12 TB tier priced by this
 * model charges $135.99, and a vault that actually filled it would cost about
 * $180 a month once the database side is counted at the multiplier below — so
 * the one tier on the ladder that can lose money is the one nobody should be
 * able to buy. Everything at 6 TB and under earns at ASSUMED_FILL_RATIO.
 */
export const OAKBOX_STORAGE_TIERS: StorageTier[] = [
  { sku: 'oakbox_storage_50gb', label: '50 GB', gb: 50 },
  { sku: 'oakbox_storage_200gb', label: '200 GB', gb: 200 },
  // Gigabytes in the id, not terabytes, and NOT `_2tb`/`_6tb`: those ids were
  // used once and Apple reserves a product id permanently, so a deleted one can
  // never come back. Matching the `_50gb`/`_200gb` pattern also puts the exact
  // `gb` value the code keys on into the id.
  { sku: 'oakbox_storage_2000gb', label: '2 TB', gb: 2000 },
  { sku: 'oakbox_storage_6000gb', label: '6 TB', gb: 6000 }
].map((tier) => {
  const cents = storageTierCents(tier.gb);
  return {
    ...tier,
    cents,
    costCents: storageTierCostCents(tier.gb),
    // Never a typed-in store price: one calculator prices premium and every
    // tier, so all three rails carry the same margin.
    storeCents: storePriceCents(cents),
    // A share of THIS tier's price, not a flat grant: the price above already
    // reserved it, so the bigger plans hand back more AI credit.
    trons: subscriptionAllowanceTrons(cents)
  };
});

/**
 * How much more storage a Founders Token holder gets: a fifth again, on
 * whatever tier they are on, 10 GB included (10 → 12, 200 → 240, 6 TB → 7.2).
 *
 * It is a STORAGE benefit, not a discount, and the reason is Apple and Google:
 * a store price is fixed by its SKU, so a founder cannot be charged less there.
 * Giving bytes instead is the one benefit that can be identical on all three
 * rails, so a founder pays exactly what anyone pays and simply gets more room.
 *
 * Applied once, in vaultStorage's limitBytes, so every reader of a limit sees
 * it: the quota refusal, the storage bar and the paywall copy alike.
 */
export const FOUNDERS_STORAGE_BONUS = 1.2;

/** The room a plan actually gives this person, in GB. */
export const effectiveStorageGb = (
  planGb: number,
  isFounder: boolean
): number => {
  const tier = Math.max(planGb, OAKBOX_INCLUDED_GB);
  // Rounded DOWN to a whole gigabyte: a quota is a promise, and 2.4 TB reads
  // better than 2,400.000001 GB in a bar.
  return isFounder ? Math.floor(tier * FOUNDERS_STORAGE_BONUS) : tier;
};

/**
 * How far past its plan a vault may go before uploads are refused.
 *
 * Decided 2026-10: stopping an upload exactly at the line loses the file the
 * person was in the middle of adding, at the moment they are least able to do
 * anything about it. So the vault takes this much more, and says so loudly
 * with an upgrade button (`vaultOverage`) until it is back under the plan. The
 * same 1 GB on every tier: it is room to finish, not extra storage to sell.
 */
export const OAKBOX_OVERAGE_GB = 1;
export const OAKBOX_OVERAGE_BYTES = OAKBOX_OVERAGE_GB * BYTES_PER_GB;

/**
 * Where a vault stands against its plan, for the over-limit notice both
 * Oakbox clients show.
 *
 * `over` is past the plan and still accepting; `stopped` is past the extra
 * room too, which is where the server refuses. `overageBytes` comes from the
 * server (`onedriveEmbed.storage`) so the notice and the refusal agree.
 */
export const vaultOverage = ({
  usedBytes,
  limitBytes,
  overageBytes
}: {
  usedBytes: number;
  limitBytes: number;
  overageBytes: number;
}): {
  over: boolean;
  stopped: boolean;
  overBytes: number;
  leftBytes: number;
} => ({
  over: usedBytes > limitBytes,
  stopped: usedBytes >= limitBytes + overageBytes,
  overBytes: Math.max(0, usedBytes - limitBytes),
  leftBytes: Math.max(0, limitBytes + overageBytes - usedBytes)
});

/** The two sentences of that notice, the same words on both clients. */
export const overageMessage = (
  overage: ReturnType<typeof vaultOverage>,
  format: (bytes: number) => string
): { title: string; body: string } => ({
  title: `${format(overage.overBytes)} over your plan`,
  body: overage.stopped
    ? `The extra ${OAKBOX_OVERAGE_GB} GB is used up, so new files are refused. Upgrade your plan or delete something.`
    : `You are using the extra ${OAKBOX_OVERAGE_GB} GB past your plan, with ${format(overage.leftBytes)} of it left. New files are refused when it runs out.`
});

/**
 * Where more storage is bought: the plan section of Oakbox's account page,
 * which lists the storage tiers. Factiii sells no storage of its own, so a
 * Factiii upload refused for space links here too.
 */
export const STORAGE_PLANS_URL = 'https://oakbox.me/app/account?tab=profile#plan';

/**
 * The refusal for a premium upload (a screen recording, or a post file over
 * the free cap) that would go past the storage ceiling. One sentence on both
 * sides, so a client can tell it apart from any other upload error and put the
 * link to STORAGE_PLANS_URL beside it.
 */
export const OVER_STORAGE_ERROR =
  'That file would put you over your storage. Buy more storage, or delete something first.';

/** "2 TB" from 2000, so a tier's own label and a quota readout agree. */
export const formatStorageGb = (gb: number): string =>
  gb >= 1000 ? `${gb / 1000} TB` : `${gb} GB`;

/**
 * The biggest single file the vault takes.
 *
 * This is R2's ceiling on a single PUT, not a policy: the bytes go from the
 * device straight to the bucket and never touch the API, so storing a large
 * file costs us nothing to carry. Reading one does — that bound is
 * MAX_EXTRACT_BYTES on the server, and a file above it is stored and attached
 * rather than refused, so it is findable by name but not searchable by content.
 *
 * Checked on the client as well so an oversized pick is refused at once,
 * instead of uploading for an hour and failing at the bucket. Lifting it past
 * this would mean multipart uploads, which nothing here does.
 *
 * Lives here rather than beside the uploader in
 * `shared/utils/helpers/vaultAddFiles.ts`, which still re-exports it, because
 * that module imports the React Native tRPC client — so a web client that
 * wanted only this number pulled `react-native` into its bundle and failed the
 * build. A constant both front ends check before they start an upload belongs
 * in the platform-free half of shared.
 */
export const MAX_VAULT_FILE_BYTES = 5 * 1024 * 1024 * 1024;

/** The same number as a person reads it, for the one message that says it. */
export const MAX_VAULT_FILE_LABEL = '5 GB';

/**
 * The three things a vault's storage is made of, as each client shows them.
 *
 * `vaultStorage` on the server measures them and counts all three against the
 * quota: files in R2, the data read out of them in Postgres, and the embeds
 * (vectors) that make that data searchable. The last two are charged at
 * DEFAULT_DATABASE_STORAGE_MULTIPLIER, and arrive here already multiplied.
 * Shared so the web and the app show the same labels and the same percentages.
 *
 * Each share is of what is used, not of the plan, so the three add up to the
 * whole bar.
 */
type StoragePart = {
  key: 'files' | 'posts' | 'vectors';
  label: string;
  bytes: number;
  share: number;
};

export const storageParts = (sizes: {
  filesBytes: number;
  postsBytes: number;
  vectorsBytes: number;
}): StoragePart[] => {
  const total = sizes.filesBytes + sizes.postsBytes + sizes.vectorsBytes;
  const parts: Omit<StoragePart, 'share'>[] = [
    // Named for what the person gets, not for the table it sits in: "Data" is
    // the text we read out of their files so they can search it, and "Embeds"
    // is what makes that search find meaning rather than words. "Posts" and
    // "Indexes" named our rows and told the reader nothing.
    { key: 'files', label: 'Files', bytes: sizes.filesBytes },
    { key: 'posts', label: 'Data', bytes: sizes.postsBytes },
    { key: 'vectors', label: 'Embeds', bytes: sizes.vectorsBytes }
  ];
  return parts.map((part) => ({
    ...part,
    share: total > 0 ? part.bytes / total : 0
  }));
};

/** "37%", with "<1%" for a part that exists but rounds to nothing. */
export const formatShare = (share: number): string => {
  if (share === 0) return '0%';
  if (share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
};

/**
 * What each phase of an arriving file is called, and how far through that file
 * it puts it.
 *
 * Both front ends read the same two things off a queue item: the line under its
 * name in the list, and the fill of the bar that says something is still on its
 * way in. One definition, because the app and the web disagreeing about what
 * "Reading it" means would be a difference nobody chose.
 *
 * The shares are stages, not bytes. Nothing reports byte progress — the device
 * writes to R2 itself, and the server hears about the file twice: when it asks
 * for the presign and when the bytes have landed. So the fill steps once per
 * stage and the label beside it is what actually says where the file is.
 *
 * Keyed by string rather than by the server's `DropPhase`, which does not exist
 * outside the server; every read falls back to the raw phase, the way the file
 * lists already do. `done` and `error` are absent on purpose: a file in either
 * has left the queue and belongs to the list of stored files.
 */
export const DROP_PHASE_LABEL: Record<string, string> = {
  uploading: 'Uploading',
  // Not "Waiting": the bytes are already stored, and a row that only said it
  // was waiting read as an upload that had not happened yet — so a person sat
  // with the tab open for work the server does without them.
  queued: 'Uploaded, waiting to be read',
  reading: 'Reading it',
  indexing: 'Indexing'
};

export const DROP_PHASE_SHARE: Record<string, number> = {
  uploading: 0.25,
  queued: 0.5,
  reading: 0.75,
  indexing: 0.9
};

/**
 * How far a whole run of uploads has got, 0 to 1 — the upload bar's fill.
 *
 * Every file counts once at its stage's share (DROP_PHASE_SHARE), and the ones
 * this device has not sent yet count as nothing but are in the total — so the
 * bar only moves forward, instead of jumping back whenever the file it names
 * changes. Null on a server too old to send a run, so the caller falls back.
 */
export const runShare = (
  run: { total: number; phases: Record<string, number> } | null | undefined,
  waitingLocally: number
): number | null => {
  if (!run) return null;
  const total = run.total + waitingLocally;
  if (total === 0) return 0;
  let done = 0;
  for (const [phase, count] of Object.entries(run.phases)) {
    done += count * (DROP_PHASE_SHARE[phase] ?? 1);
  }
  return Math.min(1, Math.max(0, done / total));
};

// A run under a few seconds old has told us nothing about its own speed: the
// first file's share arrives before any of the work behind it has happened, and
// dividing by that gives an hour. Wait until there is a rate to measure.
const ETA_AFTER_MS = 8000;
// Past this the estimate is a guess dressed as a number, so say nothing.
const ETA_CEILING_S = 6 * 3600;

/**
 * How much longer this run has, in seconds — how long it has taken so far and
 * how much of it is done. Null when it cannot be said honestly.
 *
 * Both numbers come from the server: a reload, a second tab or a phone that
 * slept would each start their own stopwatch and disagree, and a device whose
 * clock is set wrong would be wrong by exactly that much.
 */
export const etaSeconds = (
  run: { elapsedMs?: number } | null | undefined,
  share: number | null
): number | null => {
  const elapsed = run?.elapsedMs;
  if (elapsed === undefined || share === null || share <= 0 || share >= 1) {
    return null;
  }
  if (elapsed < ETA_AFTER_MS) return null;
  const remaining = (elapsed / share) * (1 - share);
  const seconds = Math.round(remaining / 1000);
  return seconds > ETA_CEILING_S ? null : seconds;
};

/**
 * That estimate as the bar says it. Rounded hard on purpose: the share moves a
 * file at a time, so an exact number would jitter every poll, and nobody
 * watching an upload wants a stopwatch — they want to know whether to wait.
 */
export const formatEta = (seconds: number | null): string => {
  if (seconds === null) return '';
  if (seconds < 60) return 'under a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 10)
    return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`;
  if (minutes < 60) return `about ${Math.round(minutes / 5) * 5} minutes left`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 15) * 15;
  if (rest === 0 || rest === 60) {
    const whole = hours + (rest === 60 ? 1 : 0);
    return `about ${whole.toLocaleString()} hour${whole === 1 ? '' : 's'} left`;
  }
  return `about ${hours.toLocaleString()} h ${rest} min left`;
};

/**
 * The files still on their way in — the list the upload bar counts and its
 * sheet shows.
 *
 * `done` and `error` are not in flight: an errored file keeps its row in the
 * file list, which is where the reason fits. Neither is a file that already has
 * an Upload row, which is the stored list's business from that moment on.
 *
 * Takes the fields it reads rather than the router's own item type: this half
 * of shared cannot see the server, and the two clients pass the same shape.
 */
export const pendingDrops = <
  T extends { phase: string; uploadId: string | null }
>(
  items: T[]
): T[] =>
  items.filter((i) => i.phase !== 'done' && i.phase !== 'error' && !i.uploadId);

/**
 * Files that failed with nothing to show for it.
 *
 * `pendingDrops` above drops errors because a file that failed *after* ingest
 * wrote its row is in the file list, marked failed, with the reason on it. One
 * that failed before that has no row anywhere — so it left the bar and left no
 * trace, and the only word anyone got was a toast at the end of the selection
 * saying how many. The server keeps these for a week (QUEUE_TTL_S), which is
 * long enough to tell someone about; `clearDrops` is how they go.
 */
/** What the notice says. One place, because both clients say it. */
export const failedNotice = (count: number): string =>
  count === 1
    ? '1 file did not finish'
    : `${count.toLocaleString()} files did not finish`;

export const failedDrops = <
  T extends { phase: string; uploadId: string | null }
>(
  items: T[]
): T[] => items.filter((i) => i.phase === 'error' && !i.uploadId);

/**
 * The arriving file a progress bar should be talking about. Null when nothing
 * is in flight, which is when neither client draws a bar at all.
 *
 * It used to return how many were queued behind that file too, and the bar
 * added the files still on the device to it while the sheet counted the same
 * run a second way. Two derivations of one number drifted into two numbers, so
 * the count is now the bar's alone (`total` in each client's UploadBar).
 *
 * The file **furthest along** is the one worth naming, and a tie goes to the
 * newest — items arrive newest first, and among uploads the newest is the one
 * the device is actually sending, because both clients upload a selection one
 * file at a time. Picking the oldest instead would let a single upload that
 * died on the device pin the bar to itself and hide every file that arrived
 * after it, which is the exact failure this bar exists to prevent. (That row
 * still needs cancelling — `clearDrops` — but it stops speaking for the
 * others.)
 */
export const activeDrop = <
  T extends { phase: string; uploadId: string | null }
>(
  items: T[]
): { item: T } | null => {
  const pending = pendingDrops(items);
  if (pending.length === 0) return null;
  const item = pending.reduce((best, i) =>
    (DROP_PHASE_SHARE[i.phase] ?? 0) > (DROP_PHASE_SHARE[best.phase] ?? 0)
      ? i
      : best
  );
  return { item };
};

/**
 * The two stages of an upload, counted: files still going up, and files the
 * server has and is still reading.
 *
 * Two, because they ask different things of the person. Uploading needs this
 * device — the bytes are on it, and closing the tab or leaving the app stops
 * them. Reading (extraction, OCR, embedding) runs on the server and carries on
 * without it. One count that mixed them said "arriving" over files that had
 * long arrived, and nobody could tell they were free to go.
 *
 * `waitingLocally` is the files this device has not sent yet — no record on
 * the server, but still the upload's. A `queued` file is the reading stage's:
 * its bytes are stored and only the server can move it on.
 *
 * The one source for every count the bar and its sheet show. Each client used
 * to derive its own from `items.length`, and two derivations of one number
 * drift into two numbers.
 */
type DropStages = { uploading: number; reading: number };

export const dropStages = <
  T extends { phase: string; uploadId: string | null }
>(
  items: T[],
  waitingLocally: number,
  // The run the poll reports, counted over every job the server has. Preferred
  // over the rows, which are cut to the newest hundred (PENDING_SHOWN on the
  // server): a person can have thousands waiting, and a count taken from a cut
  // list would say a hundred. The rows are the fallback for a server too old
  // to send a run.
  run?: DropRunCounts | null
): DropStages => {
  if (run) {
    const sending = run.phases.uploading ?? 0;
    return {
      uploading: sending + waitingLocally,
      reading: READ_PHASES.reduce(
        (held, phase) => held + (run.phases[phase] ?? 0),
        0
      )
    };
  }
  const pending = pendingDrops(items);
  const sending = pending.filter((i) => i.phase === 'uploading').length;
  return {
    uploading: sending + waitingLocally,
    reading: pending.length - sending
  };
};

/**
 * The run as the bar reads it: how many files are at each phase, how long the
 * run has been going, and how long the reading has.
 */
export type DropRunCounts = {
  phases: Record<string, number>;
  elapsedMs?: number;
  readElapsedMs?: number;
};

// The phases a file is in while the server still owes it a read.
const READ_PHASES = ['queued', 'reading', 'indexing'];

// How far through its read a file in each phase is, for the reading bar. Not
// DROP_PHASE_SHARE, which spans both stages: `queued` is a quarter of the way
// through *a drop* and none of the way through *a read*.
const READ_PHASE_SHARE: Record<string, number> = {
  queued: 0,
  reading: 0.5,
  indexing: 0.9
};

/**
 * How much of this device's sending is done, 0 to 1 — the Uploading bar's fill.
 *
 * Of what this device is sending, not of the whole drop: a file the server has
 * is uploaded, whatever the reader does with it next. So every job past
 * `uploading` counts in full, the ones still going up count as nothing, and
 * `waitingLocally` — the files no loop has reached, which have no row anywhere
 * — is in the total. The bar fills as the device empties and reaches the end
 * when the last byte lands, whatever is still being read.
 *
 * Null without a run, so a caller can leave the bar out rather than draw a lie.
 */
export const uploadShare = (
  run: DropRunCounts | null | undefined,
  waitingLocally: number
): number | null => {
  if (!run) return null;
  const sending = (run.phases.uploading ?? 0) + waitingLocally;
  let sent = 0;
  for (const [phase, count] of Object.entries(run.phases)) {
    if (phase !== 'uploading') sent += count;
  }
  const total = sent + sending;
  if (total === 0) return 1;
  return Math.min(1, Math.max(0, sent / total));
};

/**
 * How much of what the server holds has been read, 0 to 1 — the Reading bar's
 * fill. It keeps moving after the upload bar is full, which is the whole reason
 * there are two of them.
 *
 * Of the files the server has: read, being read, and waiting to be read. A file
 * still on the device is not in this total — it is not the reader's yet, and
 * counting it would make this bar go backwards as the upload goes forwards. A
 * file in hand counts for part of itself (READ_PHASE_SHARE), so a small drop
 * does not sit at zero through the whole of its first file.
 *
 * Null when the server holds nothing of this run yet, and null without a run.
 */
export const readShare = (
  run: DropRunCounts | null | undefined
): number | null => {
  if (!run) return null;
  let held = 0;
  let read = 0;
  for (const [phase, count] of Object.entries(run.phases)) {
    if (phase === 'uploading') continue;
    held += count;
    read +=
      count *
      (READ_PHASES.includes(phase) ? (READ_PHASE_SHARE[phase] ?? 0) : 1);
  }
  if (held === 0) return null;
  return Math.min(1, Math.max(0, read / held));
};

/**
 * How much longer a stage has, in seconds, from that stage's own clock and its
 * own share. Null when it cannot be said honestly — including when the stage
 * has no clock yet, which is what the reading has before its first file is
 * picked up. Nothing is guessed in that gap: the bar simply says no number.
 */
export const etaFrom = (
  elapsedMs: number | undefined,
  share: number | null
): number | null => etaSeconds({ elapsedMs }, share);

/** "1 file", "1,204 files": a stage's count as the bar says it. */
export const fileCount = (count: number): string =>
  count === 1 ? '1 file' : `${count.toLocaleString()} files`;

/**
 * The stages as one line — "Uploading 9 files · Reading 83 files" — for the
 * bar and the title of the sheet it opens, so the two say the same thing.
 */
export const stagesLine = ({ uploading, reading }: DropStages): string =>
  dotted(
    uploading > 0 ? `Uploading ${fileCount(uploading)}` : '',
    reading > 0 ? `Reading ${fileCount(reading)}` : ''
  );

/**
 * Whether a job can be taken out of the queue. The same test `clearDroppedJobs`
 * makes on the server, so a button is absent where the server would refuse it
 * rather than offered and then ignored: a file being read finishes whatever
 * anyone clicks, and one that has an Upload row belongs to Delete.
 *
 * A predicate rather than a set of phases, because `uploadId` is half of the
 * rule — and because two clients keeping their own phase lists is how they
 * came to disagree with each other and with the server.
 */
export const canCancelDrop = (item: {
  phase: string;
  uploadId: string | null;
}): boolean =>
  !item.uploadId &&
  item.phase !== 'reading' &&
  item.phase !== 'indexing' &&
  item.phase !== 'done';

/** Human size for a byte count. Decimal units, matching the plan ladder. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

/**
 * A copy the server held back because its bytes are already in the vault
 * (apps/server/src/helpers/vaultDuplicates.ts). It was not read and costs no
 * storage; it waits for the person to keep it or the copy already stored.
 *
 * The shape `dropProgress.duplicates` returns, written out here for the same
 * reason pendingDrops takes fields rather than the router's type: this half of
 * shared cannot see the server.
 */
export type HeldCopy = {
  jobId: string;
  name: string;
  // The copy already stored, or one the same batch was reading at the time.
  existing: { name: string; at: number };
};

export type KeepCopy = 'new' | 'old';

/**
 * The held copies to ask about now, or none.
 *
 * Only once the batch is over — nothing arriving on the server, nothing still
 * being sent from this device — so a selection is asked about once, at the end,
 * rather than a file at a time while the rest are still going up. Both clients
 * ask on the same rule, so the web and the app never disagree about when.
 */
export const duplicatesToAsk = (
  progress: { running: boolean; duplicates?: HeldCopy[] } | undefined,
  sending: boolean,
  // Copies the device found by hash and never uploaded (helpers/knownCopies.ts).
  // They are the same question, asked about files the server has never seen.
  known: HeldCopy[] = []
): HeldCopy[] =>
  !progress || progress.running || sending
    ? []
    : [...known, ...(progress.duplicates ?? [])];

/**
 * The line under a held copy's name. The bytes are identical, so the only
 * things that tell the two apart are the name and when each arrived.
 */
export const duplicateMeta = (copy: HeldCopy): string => {
  const when = new Date(copy.existing.at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  return copy.existing.name === copy.name
    ? `Already in your vault, added ${when}`
    : `Same file as “${copy.existing.name}”, added ${when}`;
};

/**
 * One answer per held copy: the person's pick where they made one, otherwise
 * `fallback`. The sheets pass `old` for unpicked rows, because keeping what is
 * stored is the answer that changes nothing.
 */
export const duplicateAnswers = (
  copies: HeldCopy[],
  picks: Record<string, KeepCopy>,
  fallback: KeepCopy
): { jobId: string; keep: KeepCopy }[] =>
  copies.map((c) => ({ jobId: c.jobId, keep: picks[c.jobId] ?? fallback }));

/**
 * The kind of balance change, as a word under its label in the Tron history.
 * Keyed by the server's TronLedgerReason; a reason added there and not here
 * falls back to the raw value, the way the drop phases do. The pool account's
 * own reasons are absent: nobody reads that account's history.
 */
export const TRON_REASON_LABEL: Record<string, string> = {
  PURCHASE: 'Purchase',
  AWARD_RECEIVED: 'Award',
  REWARD: 'Reward',
  ADMIN_ADJUST: 'Adjustment',
  REFUND: 'Refund',
  AI_SPEND: 'AI',
  API_PASSTHROUGH: 'Cross-post',
  AWARD_SENT: 'Award',
  POOL_DONATION: 'Donation',
  FEATURE_FEE: 'Fee',
  CLAWBACK: 'Refund'
};

const TRON_UNITS: [number, string][] = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K']
];

/**
 * A Tron amount short enough to read at a glance: "6.5M", "3B", "950". Balances
 * run to billions, and a ten-digit figure is counted rather than read. One
 * decimal under ten of a unit, none above it.
 */
export const compactTrons = (trons: number): string => {
  const unit = TRON_UNITS.find(([size]) => Math.abs(trons) >= size);
  if (!unit) return String(Math.round(trons));
  const n = trons / unit[0];
  return `${n.toFixed(Math.abs(n) < 10 ? 1 : 0).replace(/\.0$/, '')}${unit[1]}`;
};

/** A signed change, whole Trons with separators: "+1,000,000", "−12,340". */
export const formatTronChange = (amount: number): string =>
  `${amount < 0 ? '−' : '+'}${Math.abs(amount).toLocaleString()}`;

/** When a history entry happened: "Sep 17, 3:42 PM". */
export const tronEntryWhen = (createdAt: Date | string): string =>
  new Date(createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });

/**
 * What a balance change was spent on, in Oakbox's terms, for the Tron history's
 * breakdown. Every AI charge shares one reason (AI_SPEND), so the kind comes
 * from the groupKey prefix each spender writes: `filing:` (the folder walk for
 * an upload), `vault-retag:` (a categorize run), `research:` and `note-tags:`
 * (Ask).
 *
 * Adding a file spends nothing since 2026-09-21: no model describes a photo.
 * Older rows — `vault-read:` and `vault-upload:`, which mixed reading with the
 * automatic tagging a file got back then, and the brief `photo:` rows for the
 * vision description itself — fall through to "Other AI".
 */
export type TronKind =
  | 'filing'
  | 'categorizing'
  | 'ask'
  | 'otherAi'
  | 'added'
  | 'other';

/** The spending kinds, in the order the chart stacks and colours them. */
export const TRON_SPEND_KINDS = [
  'filing',
  'categorizing',
  'ask',
  'otherAi'
] as const;

export const TRON_KIND_LABEL: Record<TronKind, string> = {
  filing: 'Filing uploads',
  categorizing: 'Categorizing',
  ask: 'Ask',
  otherAi: 'Other AI',
  added: 'Added',
  other: 'Other'
};

/**
 * Categorical slots 2-5 of the dataviz reference palette, dark steps, checked
 * against the app's #17140f ground (lightness band, chroma, colour-blind and
 * normal-vision separation, 3:1 contrast all pass). Both apps are dark-only.
 * Fixed per kind, so a kind keeps its colour when another has nothing to show
 * — and kept when "Reading photos" (slot 1, blue) was retired.
 */
export const TRON_KIND_COLOR: Record<
  (typeof TRON_SPEND_KINDS)[number],
  string
> = {
  filing: '#d95926',
  categorizing: '#199e70',
  ask: '#c98500',
  otherAi: '#d55181'
};

/** A row's colour in the history, or null for Trons added and non-AI spend. */
export const tronKindColor = (kind: TronKind): string | null =>
  kind in TRON_KIND_COLOR
    ? TRON_KIND_COLOR[kind as keyof typeof TRON_KIND_COLOR]
    : null;

const KIND_BY_PREFIX: Record<string, TronKind> = {
  filing: 'filing',
  'vault-retag': 'categorizing',
  research: 'ask',
  'note-tags': 'ask'
};

// The one AI charge written with no groupKey: rule suggestions on Ontology.
const ONTOLOGY_ADVICE_LABEL = 'Ontology suggestions';

export const tronKind = (entry: {
  amount: number;
  reason: string;
  groupKey: string | null;
  label: string;
}): TronKind => {
  if (entry.amount > 0) return 'added';
  if (entry.reason !== 'AI_SPEND') return 'other';
  if (entry.label === ONTOLOGY_ADVICE_LABEL) return 'categorizing';
  const prefix = entry.groupKey?.split(':')[0] ?? '';
  return KIND_BY_PREFIX[prefix] ?? 'otherAi';
};

/**
 * What a delete is about to take, in the words both clients show. One place
 * because the two prompts are the last thing a person reads before files go,
 * and a folder's prompt has to name a count the client would otherwise phrase
 * its own way.
 */
export type VaultDeletion =
  | { kind: 'file'; name: string }
  | { kind: 'folder'; name: string; files: number }
  | { kind: 'chosen'; count: number };

const plural = (n: number): string => (n === 1 ? 'file' : 'files');

export const deletePrompt = (
  what: VaultDeletion
): { title: string; body: string } => {
  if (what.kind === 'file') {
    return {
      title: 'Delete this file?',
      // The whole path, not the leaf: `statement.txt` on its own does not say
      // which one.
      body: `${what.name} and anything read from it.`
    };
  }
  if (what.kind === 'folder') {
    return {
      title: 'Delete this folder?',
      body: `${what.name} and the ${what.files.toLocaleString()} ${plural(what.files)} in it, with anything read from them.`
    };
  }
  return {
    title: `Delete ${what.count.toLocaleString()} ${plural(what.count)}?`,
    body: 'They go with anything read from them.'
  };
};

/**
 * The upload line: whichever of the parts are there, separated by a dot. The
 * bar and the sheet it opens say the same things in a different order, and
 * carrying the separator inside each part is how the line ends up starting with
 * one.
 */
export const dotted = (...parts: (string | null | undefined)[]): string =>
  parts.filter((part): part is string => Boolean(part)).join(' · ');

/**
 * A categorize run (onedriveEmbed.retagProgress) as the upload bar says it, so
 * web and phone put it in the same slot with the same words. The run is the
 * server's from the start, so there is no "keep this open" stretch: `leave` is
 * the platform's own "you can close …" line.
 *
 * A runner's run (vaultCategorizeStatus) is drawn by the same words. Its clock
 * is another machine's, so it carries its own estimate (`etaSeconds`) in
 * place of a start time read against this device's.
 */
export const categorizeRunLines = (
  run: {
    total: number;
    processed: number;
    startedAt: number | null;
    etaSeconds?: number | null;
  },
  now: number,
  leave: string
): {
  share: number | null;
  title: string;
  stage: string;
  left: string;
  meta: string;
} => {
  const share = run.total > 0 ? run.processed / run.total : null;
  const left = formatEta(
    run.etaSeconds === undefined
      ? etaFrom(run.startedAt ? now - run.startedAt : undefined, share)
      : run.etaSeconds
  );
  const stage = `Categorizing ${run.processed.toLocaleString()} of ${fileCount(run.total)}`;
  return {
    share,
    title: `Categorizing ${fileCount(run.total)}`,
    stage,
    left,
    meta: dotted(stage, left, leave)
  };
};
