import list from './trackerDomains.json';

// Known trackers by domain, for "Check my device" on the web and the runner's
// "Scan this computer" (.specs/analytics.md "Check my device"). The list is
// Factiii's own (trackerDomains.json): a small, domains-only list of the major
// ad and analytics companies, grouped by company, so both sides name the same
// companies.

export type DomainKind = 'first-party' | 'tracker' | 'other';

const byDomain = new Map<string, string>();
for (const [owner, domains] of Object.entries(list.owners)) {
  for (const domain of domains) byDomain.set(domain, owner);
}

/** A host as cookies and URLs write it: lowercased, without a leading dot
 *  (a cookie's `.example.com`) or a trailing one. */
export const normalizeHost = (host: string): string =>
  host.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');

/** Whether `host` is `domain` or one of its subdomains. */
export const hostMatches = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/** The company behind `host` when it, or a parent domain, is on the list. */
export const trackerOwner = (host: string): string | null => {
  const parts = normalizeHost(host).split('.');
  // From the full host up to its last two labels: a.b.example.com, then
  // b.example.com, then example.com.
  for (let i = 0; i < parts.length - 1; i++) {
    const owner = byDomain.get(parts.slice(i).join('.'));
    if (owner) return owner;
  }
  return null;
};

/** First party (one of `firstParty`'s domains or under one), a known
 *  tracker, or other. First party wins: a site's own host is never a
 *  tracker on its own page. */
export const classifyDomain = (
  host: string,
  firstParty: readonly string[]
): { kind: DomainKind; owner: string | null } => {
  const clean = normalizeHost(host);
  if (firstParty.some((domain) => hostMatches(clean, normalizeHost(domain)))) {
    return { kind: 'first-party', owner: null };
  }
  const owner = trackerOwner(clean);
  return owner ? { kind: 'tracker', owner } : { kind: 'other', owner: null };
};
