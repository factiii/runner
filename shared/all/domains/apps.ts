// The apps that sell our products.
//
// An app is a STOREFRONT, and it is not a space. Space is what a subscription
// grants (`.specs/products.md`); app is where it is sold. Premium grants the
// `premium` space and sells from every app.
//
// This exists because Apple has no cross-app purchase: a receipt for
// `premium_monthly` belongs to the Factiii app and Oakbox cannot see it, so the
// same product is listed again under each app with its own SKU. `ProductSku`
// holds those listings and this holds the app list they key off.
//
// Deliberately NOT a Postgres enum on `ProductSku.app`: a new app would then
// need `ALTER TYPE … ADD VALUE`, i.e. a migration per app release. Shipping an
// app is rows in `ProductSku` plus a slug here.
//
// Bundle ids and package names are NOT here. Each app's are resolved where
// receipts are verified (`helpers/iap/apple.ts`, `helpers/iap/google.ts`), and
// Factiii's come from `APP_BUNDLE_ID` and the `googlePackageName` system-cache
// key rather than a constant, so they vary by environment. Centralising them
// would mean hardcoding what is deliberately configurable.

/**
 * Every app slug, in the order they are shown wherever all of them are listed.
 *
 * NOT the same list as `shared/utils/helpers/authTokenStore.ts`, which exports
 * its own `APP_SLUGS`/`AppSlug` as `['facti', 'oakbox']` — that one is the
 * mobile keychain namespace, keyed by the EAS project slug. Importing the wrong
 * `AppSlug` is a type error rather than a silent bug (`'factiii'` is not
 * assignable to `'facti'`), but check which one you have before chasing it.
 */
export const APP_SLUGS = ['factiii', 'oakbox'] as const;

export type AppSlug = (typeof APP_SLUGS)[number];

/** Each app's name as a person sees it, e.g. "change it in the Oakbox app". */
export const APP_NAMES: Record<AppSlug, string> = {
  factiii: 'Factiii',
  oakbox: 'Oakbox'
};
