/**
 * Usernames nobody can register or change to.
 *
 * Profiles live at the root of the site (`/<username>`), so a username that
 * equals a top-level route would be shadowed by that route (Next matches
 * static segments before the dynamic `[username]` one), and a route added
 * later would take over an existing profile's URL. Every top-level segment of
 * apps/factiii-web/src/app is listed here; the web test
 * apps/factiii-web/src/app/reservedUsernames.test.ts fails when a new one is
 * missing. The forward-looking words hold names we may want as routes or
 * subdomains later, or that would let an account pass as the platform.
 *
 * Matching is case-insensitive: entries are lowercase and the input is
 * lowercased before the lookup.
 */

// Top-level segments of apps/factiii-web/src/app (directories and route
// files), plus the paths next.config.ts redirects or rewrites at the root.
const ROUTE_SEGMENTS = [
  'about',
  'admin',
  'analytics',
  'api',
  'aup',
  'biometric-verification',
  'chat',
  'contact',
  'cookies',
  'credits',
  'dev',
  'download',
  'dsar',
  'eula',
  'explore',
  'f',
  'fact',
  'fids',
  'games',
  'gant',
  'home',
  'hub',
  'invite',
  'login',
  'magic-link',
  'map',
  'moderation',
  'notifications',
  'oauth',
  'onboarding',
  'opengraph',
  'payment',
  'pitch',
  'post',
  'privacy',
  'private-post',
  'products',
  'record',
  'reset-password',
  'routines',
  'runners',
  's',
  'saved',
  'scheduled',
  'search',
  'settings',
  'shop',
  'signup',
  'terminal',
  'terms',
  'test',
  'test-embeds',
  'transfer',
  'trello',
  'trending',
  // The old profile prefix; /user/<name> now redirects to /<name>.
  'user',
  'verify-email',
  'vol2',
  'waitlist',
  // Redirected or rewritten in next.config.ts.
  'company',
  // The old spaces list, now the Hub's Spaces tab (/hub/spaces).
  'spaces',
  'fun',
  'index',
  'ingest',
  'sitemap',
  'sitemap-index',
  '.well-known'
] as const;

// Metadata routes and files served at the root (app/*.ts route files and
// public/). Usernames cannot contain a dot, so the dotted ones can never be
// registered; they are listed so the list reads as the full set of root paths.
const ROOT_FILES = [
  'robots',
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  'llms-full.txt',
  'favicon.ico',
  'icon',
  'icons',
  'apple-icon',
  'manifest',
  'manifest.json',
  'manifest.webmanifest',
  'opengraph-image',
  'twitter-image',
  'images',
  'cesium',
  'worklets',
  'scratchpad-fixtures',
  'runner.sh'
] as const;

// Not routes yet: names worth keeping free for routes, subdomains or the
// platform's own accounts.
const FORWARD_LOOKING = [
  'app',
  'help',
  'www',
  'mail',
  'oakbox',
  'factiii',
  'support',
  'blog',
  'docs',
  'status',
  'static',
  '_next',
  'assets',
  'login',
  'logout',
  'me',
  'new',
  'edit'
] as const;

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set<string>([
  ...ROUTE_SEGMENTS,
  ...ROOT_FILES,
  ...FORWARD_LOOKING
]);

export const RESERVED_USERNAME_MESSAGE = 'That name is reserved.';

export const isReservedUsername = (username: string): boolean =>
  RESERVED_USERNAMES.has(username.trim().toLowerCase());
