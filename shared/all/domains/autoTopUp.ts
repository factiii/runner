import { TRONS_PER_CENT } from './products';

// Auto top-up buys a tron package on its own when the balance runs low, the
// way AI providers auto-recharge credits.
//
// STRIPE ONLY. Apple and Google forbid charging for digital goods outside IAP,
// and IAP has no off-session recharge primitive, so this can only bill a saved
// card through Stripe. Mobile shows the setting; it cannot run it.

/**
 * A sensible default threshold for a package: fire when the balance drops
 * below a quarter of what that package grants. Low enough that a top-up is not
 * constantly re-firing, high enough that the user rarely hits zero mid-task.
 */
const DEFAULT_THRESHOLD_FRACTION = 0.25;
export const suggestedThresholdTrons = (packageTrons: number): number =>
  Math.round(packageTrons * DEFAULT_THRESHOLD_FRACTION);

/**
 * Caps are what stop a runaway loop from draining a card, so the UI defaults
 * to real numbers rather than "unlimited". Both default to a small multiple of
 * the package price.
 */
const DEFAULT_DAILY_CAP_MULTIPLE = 2;
const DEFAULT_MONTHLY_CAP_MULTIPLE = 10;
export const suggestedCaps = (packagePriceCents: number) => ({
  dailyCapCents: packagePriceCents * DEFAULT_DAILY_CAP_MULTIPLE,
  monthlyCapCents: packagePriceCents * DEFAULT_MONTHLY_CAP_MULTIPLE
});

/** 0 means "no ceiling" — allowed, but the UI warns about it. */
const NO_CAP = 0;

type CapCheck =
  | { allowed: true }
  | {
      allowed: false;
      window: 'day' | 'month';
      capCents: number;
      spentCents: number;
    };

/**
 * Whether one more top-up fits inside both ceilings. Evaluated against what
 * has ALREADY been spent in each rolling window, so a cap is a true ceiling
 * rather than a count of attempts.
 */
export const checkCaps = ({
  priceCents,
  spentTodayCents,
  spentThisMonthCents,
  dailyCapCents,
  monthlyCapCents
}: {
  priceCents: number;
  spentTodayCents: number;
  spentThisMonthCents: number;
  dailyCapCents: number;
  monthlyCapCents: number;
}): CapCheck => {
  if (dailyCapCents !== NO_CAP && spentTodayCents + priceCents > dailyCapCents)
    return {
      allowed: false,
      window: 'day',
      capCents: dailyCapCents,
      spentCents: spentTodayCents
    };
  if (
    monthlyCapCents !== NO_CAP &&
    spentThisMonthCents + priceCents > monthlyCapCents
  )
    return {
      allowed: false,
      window: 'month',
      capCents: monthlyCapCents,
      spentCents: spentThisMonthCents
    };
  return { allowed: true };
};

/**
 * A threshold at or above what the package grants would re-fire immediately
 * after every top-up, because the new balance would still be under it. The
 * server rejects that and the UI prevents it.
 */
export const isThresholdRunaway = (
  thresholdTrons: number,
  packageTrons: number
): boolean => thresholdTrons >= packageTrons;

/** Rolling windows the caps are summed over. */
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MONTH_MS = 30 * DAY_MS;

/**
 * How long a claimed top-up may stay in flight before another burn is allowed
 * to retry it. Guards against a crash mid-charge wedging auto top-up off.
 */
export const CLAIM_STALE_MS = 5 * 60 * 1000;

export const MIN_THRESHOLD_TRONS = TRONS_PER_CENT; // 1 cent of AI

/**
 * How much of a cap must be spent before we warn. The warning matters because
 * hitting a cap silently turns auto top-up off — the user keeps working and
 * then runs dry with no idea why nothing recharged.
 */
export const NEAR_CAP_FRACTION = 0.8;

export const isNearCap = (spentCents: number, capCents: number): boolean =>
  capCents !== NO_CAP && spentCents >= capCents * NEAR_CAP_FRACTION;

/**
 * A sensible low-balance warning: a little above the top-up threshold, so the
 * warning lands just BEFORE the recharge rather than after it. With auto
 * top-up off it is simply the balance floor the user picked.
 */
export const suggestedAlertBalanceTrons = (thresholdTrons: number): number =>
  Math.round(thresholdTrons * 1.5);
