import { type RouterOutputs } from './trpc';

export type Product =
  RouterOutputs['products']['getPurchasableProducts']['products'][0];

export type RewardItem = RouterOutputs['products']['tronRewards']['rewards'][0];

export enum ProductType {
  TRON = 'TRON',
  FOUNDERS_TOKEN = 'FOUNDERS_TOKEN',
  MONTHLY_SUBSCRIPTION = 'MONTHLY_SUBSCRIPTION',
  DONATION = 'DONATION'
}

// ---------------------------------------------------------------------------
// Tron denomination
// ---------------------------------------------------------------------------
// ONE TRON IS ONE MICRO-DOLLAR of AI provider cost. Every provider publishes
// prices in USD per million tokens, so this basis makes the two units line up
// exactly: trons-per-token == dollars-per-million-tokens (Claude Sonnet input
// at $3/MTok is 3 trons/token). Every rate in the model catalog therefore
// lands on a whole number of trons with no rounding loss — see
// `usdPerMillionToTrons` in apps/server/src/utilities/modelCatalog.ts.
//
// Trons exist because provider costs are fractions of a penny: a cache read on
// a nano model is $0.025 per million tokens, which no cent-denominated unit
// can represent. This basis has headroom down to $0.001/MTok.
export const TRONS_PER_USD = 1_000_000;
export const TRONS_PER_CENT = TRONS_PER_USD / 100; // 10,000

// ---------------------------------------------------------------------------
// The standing Premium Subscription price — the anchor for every other price
// ---------------------------------------------------------------------------
// Stripe base, in cents — already on a .99 point, and the anchor every other
// price is built from. It buys the premium benefits, the tron allowance and
// the 10 GB of Oakbox storage every premium account carries. Exported because
// the Oakbox storage plans INCLUDE premium: each tier is this fee plus the
// extra bytes it adds, so a plan and the standing subscription never drift
// apart. Every store price is DERIVED from it by storePriceCents below.
export const PREMIUM_MONTHLY_CENTS = 999;

// ---------------------------------------------------------------------------
// Where a Founders Token can be sold
// ---------------------------------------------------------------------------
// The web, and nowhere else. The token runs as three waves at 50/25/0% and a
// store sells one fixed price per SKU, so Apple cannot express what it is:
// `founders_token` has never been approved and sits at MISSING_METADATA with
// no review screenshot. The active wave still carries the id on purpose, in
// case Apple ever allows the structure — which is why this is a rule and not
// a missing row.
//
// ONE rule, every reader: the platform filter and the sold-out fallback in
// `getPurchasableProducts`, the till in `checkPurchase`, and the post-signup
// offer in `checkFoundersToken`. Flipping this line is the whole switch if the
// day ever comes (.specs/products.md, "Web only").
type SalesPlatform = 'web' | 'ios' | 'android';
export const foundersTokenSellableOn = (platform: SalesPlatform): boolean =>
  platform === 'web';

// Share of a subscription's price that comes back as a tron allowance; the
// rest is margin. A percentage, not a number of trons, so the allowance
// follows the price whenever a plan is repriced.
export const SUBSCRIPTION_TRON_ALLOWANCE_PERCENT = 20;
export const subscriptionAllowanceTrons = (priceCents: number): number =>
  Math.round(
    (priceCents * TRONS_PER_CENT * SUBSCRIPTION_TRON_ALLOWANCE_PERCENT) / 100
  );

// ---------------------------------------------------------------------------
// The store price calculator — one function, never a typed-in number
// ---------------------------------------------------------------------------
// Apple and Google take a commission, so a store price has to be higher than
// the Stripe base for the three rails to keep the same margin. The markup is
// the commission, and nothing more: base / (1 − commission).
//
// 15%: Apple's Small Business Program (under $1M/yr) and Google Play's rate on
// the first $1M/yr. Above that both take 30%, and this constant is the one
// place to change when we get there.
export const STORE_COMMISSION_RATE = 0.15;

/**
 * Round a price UP to the next one ending in .99, a dollar at a time.
 *
 * Stripe accepts any amount, so this is not a constraint — it is the price
 * point a person expects to read, applied to a number that came out of a cost
 * model ($10.41 is arithmetic showing through). Up only: rounding down would
 * put a price under the cost it was derived from.
 *
 * Whole-dollar steps, unlike the store ladder below, because nothing here
 * forces the coarser one: a $135.99 plan is $135.99 on Stripe and only the
 * stores need it rounded further.
 */
export const priceEndingIn99Cents = (cents: number): number =>
  Math.ceil((cents + 1) / 100) * 100 - 1;

// Stores sell at fixed price points, not at any number of cents, so the marked
// up price is rounded UP to the next allowed point — never down, which would
// sell below the margin. Every point ends in .99, and the ladder coarsens as it
// climbs; these bands match Apple's published price points (App Store Connect
// → Pricing, the generated global tier list) and Google's suggested points,
// which follow the same shape.
//
// ASSUMPTION, because Apple's exact grid is longer than this: $1 steps up to
// $50, $5 steps to $100, $10 steps above it. Apple offers finer points in
// places (and Google allows any price at all), so a rounded price here is
// always a point that EXISTS — it may leave a few cents on the table rather
// than land on the closest available point. Both stores round the same way, so
// Apple and Google get the same number and the rails stay comparable.
const storePointStepCents = (cents: number): number => {
  if (cents <= 5000) return 100;
  if (cents <= 10000) return 500;
  return 1000;
};

/**
 * The store price for a Stripe base price, in cents.
 *
 * Used for EVERY store price we publish — premium and each Oakbox tier — so no
 * store price is ever typed in by hand and no tier can drift from its base.
 */
export const storePriceCents = (baseCents: number): number => {
  const marked = Math.ceil(baseCents / (1 - STORE_COMMISSION_RATE));
  const step = storePointStepCents(marked);
  // Points end in .99, so a point is a whole number of steps less one cent.
  // With step = 100 this is priceEndingIn99Cents; the bands only coarsen it.
  return Math.ceil((marked + 1) / step) * step - 1;
};

// ---------------------------------------------------------------------------
// The margin — taken when trons are SPENT, not when they are sold
// ---------------------------------------------------------------------------
// Trons sell flat: $1 buys 1,000,000 trons for everyone, premium or not. The
// margin is applied at BURN time instead, against the buyer's premium status
// at the moment the AI actually runs.
//
// Why burn-time and not sale-time: a sale-time premium discount lets someone
// subscribe, stockpile trons at cost, cancel, and then spend them at cost
// forever. Charging at burn also means we take margin exactly when we incur
// provider cost, rather than booking it against a tron that may never be spent.
//
// Lives in SystemCache (`nonPremiumMarginPercent`) so admin retunes it without
// a deploy — this constant is only the fallback when the cache has no row.
export const DEFAULT_NON_PREMIUM_MARGIN_PERCENT = 10;

// A margin of 100% would double every charge and make the savings math divide
// by zero, so the lever is clamped wherever it is read.
const MAX_NON_PREMIUM_MARGIN_PERCENT = 90;
export const clampMarginPercent = (marginPercent: number): number => {
  if (!Number.isFinite(marginPercent) || marginPercent < 0) return 0;
  return marginPercent > MAX_NON_PREMIUM_MARGIN_PERCENT
    ? MAX_NON_PREMIUM_MARGIN_PERCENT
    : marginPercent;
};

/**
 * THE margin function. Every path that decrements a user's balance for AI use
 * goes through this — server billing, and the client/mobile cost previews that
 * must agree with it. Premium members are charged exact provider cost.
 *
 * Rounds up, so a charge is never under cost. The most it can over-charge is
 * one tron: a millionth of a dollar.
 */
export const getChargedTrons = (
  baseCostTrons: number,
  isPremium: boolean,
  marginPercent: number
): number =>
  isPremium
    ? baseCostTrons
    : Math.ceil(
        (baseCostTrons * (100 + clampMarginPercent(marginPercent))) / 100
      );

/** What premium saved (or would save) on a charge — for billing history. */
export const getPremiumSavingsTrons = (
  baseCostTrons: number,
  marginPercent: number
): number =>
  getChargedTrons(baseCostTrons, false, marginPercent) - baseCostTrons;

/**
 * How much provider cost a balance can actually buy, in trons. A balance is a
 * fixed number of trons but NOT a fixed amount of AI — a non-premium member
 * spends `1 + margin` trons per tron of cost. Use this for every "≈ $X of AI"
 * readout so web, mobile, and the server agree.
 */
export const getAiValueTrons = (
  balanceTrons: number,
  isPremium: boolean,
  marginPercent: number
): number =>
  isPremium
    ? balanceTrons
    : Math.floor(
        (balanceTrons * 100) / (100 + clampMarginPercent(marginPercent))
      );

/** Trons as cents, for the shared `formatUSD` formatter. */
export const tronsToCents = (trons: number): number => trons / TRONS_PER_CENT;

/**
 * USD as trons. Use this for EVERY hardcoded tron amount in the codebase —
 * fees, gates, display thresholds — so the value is readable as money and
 * survives any future redenomination. A bare tron literal is a magic number
 * whose worth silently changes the day the basis moves.
 */
export const usdToTrons = (usd: number): number =>
  Math.round(usd * TRONS_PER_USD);

// ---------------------------------------------------------------------------
// Selling trons — flat, with an optional promotional boost
// ---------------------------------------------------------------------------
// Everyone pays the same and receives the same. A sale is a BOOST (extra
// trons), never a discount: Apple and Google will not let us move a listed
// price, so a discount cannot exist on mobile at all. Expressing every
// promotion as a boost keeps one mechanic across all three platforms.
export const DEFAULT_PROMO_BOOST_PERCENT = 0;

// Boosts are marketing, not pricing, so they are capped well below the point
// where a sale would stop covering its own provider liability.
const MAX_PROMO_BOOST_PERCENT = 100;
export const clampBoostPercent = (boostPercent: number): number => {
  if (!Number.isFinite(boostPercent) || boostPercent < 0) return 0;
  return boostPercent > MAX_PROMO_BOOST_PERCENT
    ? MAX_PROMO_BOOST_PERCENT
    : boostPercent;
};

/** Base trons for a price, before any promotional boost. $1 → 1,000,000. */
export const getBaseTronsForCents = (cents: number): number =>
  cents * TRONS_PER_CENT;

/** Extra trons from the standing promotional boost. Same for every buyer. */
export const getPromoBoostTrons = (
  baseTrons: number,
  boostPercent: number
): number => Math.floor((baseTrons * clampBoostPercent(boostPercent)) / 100);

// ---------------------------------------------------------------------------
// Non-TRON price discounts
// ---------------------------------------------------------------------------
// TRON products never discount their price — the benefit is always trons (see
// above). Other product types still carry a real price discount: the founders
// waves list at $200 and sell at 50/25/0% off. The 50% floor is the founders
// cost-basis guard, so a token never prices under its tron liability.
export const NON_TRON_DISCOUNT_FLOOR = 0.5;

export const getPriceMultiplier = (discountPercent: number): number => {
  const multiplier = 1 - discountPercent / 100;
  return multiplier < NON_TRON_DISCOUNT_FLOOR
    ? NON_TRON_DISCOUNT_FLOOR
    : multiplier;
};

/**
 * Bonus trons that compensate a founders IAP buyer for a wave discount the
 * store cannot apply to the single fixed SKU. `d/(100−d)` undoes the discount,
 * so wave 1 (50% off) doubles the tron grant.
 */
export const getFoundersBonusTrons = (
  baseTrons: number,
  discountPercent: number
): number => {
  const d = clampMarginPercent(discountPercent);
  return Math.floor((baseTrons * d) / (100 - d));
};

// A TRON product is award-only (visible in the award picker, never
// purchasable) when its price is under $2 — below that, payment processing
// fees swamp the sale. TRON prices are no longer discounted, so this reads
// straight off the list price.
const MIN_TRON_CHARGE_CENTS = 200;
export const isAwardOnlyTron = (priceCents: number): boolean =>
  priceCents < MIN_TRON_CHARGE_CENTS;

// Founders Tokens are refundable within this many days of purchase; after
// that all sales are final (lifetime premium is permanent). Shown at the
// point of purchase (web + mobile founders cards) and enforced in the admin
// refund path (docs/marketing/README.md §5.5).
export const FOUNDERS_REFUND_WINDOW_DAYS = 60;
export const FOUNDERS_REFUND_POLICY = `Refundable within ${FOUNDERS_REFUND_WINDOW_DAYS} days of purchase — after that, all sales are final.`;

/**
 * How long a package's premium lasts, in words.
 *
 * Lives here rather than in a component because two surfaces show it — the
 * product card and the purchase modal — and a second copy is how they end up
 * disagreeing. The same reasoning applies to the tron count: BOTH numbers are
 * derived from `Tron.quantity` and `Tron.premiumDays` at render time, and a
 * product's stored `description` must never restate either of them. It did,
 * and the redenomination left every package advertising a tenth of the trons
 * it grants and up to two years of premium against an actual seven days.
 */
export const formatPremiumDuration = (days: number): string => {
  if (days >= 365) {
    const years = Math.round(days / 365);
    return `${years} year${years === 1 ? '' : 's'} premium`;
  }
  if (days >= 30) {
    const months = Math.round(days / 30);
    return `${months} month${months === 1 ? '' : 's'} premium`;
  }
  return `${days} day${days === 1 ? '' : 's'} premium`;
};

// The most premium days one admin grant may give (admin.grantPremiumDays): ten
// years. A larger number is far more likely a typo than an intent.
export const PREMIUM_GRANT_MAX_DAYS = 3650;
