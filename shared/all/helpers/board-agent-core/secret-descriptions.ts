// What a stored secret is FOR, and the one rule for resolving it.
//
// Two sources describe a key and neither is complete:
//
//   the deploy contract  `.agents/skills/deploy/required-variables.json` on the
//                        default branch - authored by the skill creator, merge
//                        reviewed, and only ever covers keys a skill DECLARES
//   the meta sidecar     `<space>/secrets/secrets.meta.json` - the owner's own
//                        edits, plus whatever the one-time vault import
//                        seeded. Covers anything, including the many
//                        keys a repo with no deploy skill holds
//
// Pure and node-free on purpose: the runner resolves this for
// `factiii-secrets list`, and the web and mobile Secrets panels resolve it for
// their rows. Written twice it would drift, and the two would then disagree
// about what a credential is for - which is worse than no description at all.

/** One row of the meta sidecar. Descriptions only; there is no value here and
 *  nothing that reads one. */
export type SecretMeta = {
  /** Short label, e.g. "npm publish token". */
  title: string;
  /** What it is for, and what breaks without it - the line an agent reads. */
  description: string;
  /** Grouping for the settings panel: release, aws, apple, database...
   *  '' means "not stated here", not "general" - see `describeSecret`. */
  category: string;
  /** Where it came from: `vault:npm` for the retired vault's import, `manual` for a
   *  value typed into the panel. Free text, only ever displayed. */
  source: string;
};

/** The resolved description, always populated - `category` falls back so
 *  every key groups somewhere. */
export type SecretDescription = {
  title: string;
  description: string;
  category: string;
};

export const DEFAULT_SECRET_CATEGORY = 'general';

/**
 * Resolve what a key is for.
 *
 * The contract is the default and the sidecar is the override, FIELD BY FIELD:
 * a key the owner retitled in the panel keeps the contract's longer
 * description. A field the sidecar leaves empty is not an opinion, so it never
 * shadows one.
 */
export function describeSecret(
  meta: Partial<SecretMeta> | undefined,
  contract: Partial<SecretDescription> | undefined
): SecretDescription {
  return {
    title: meta?.title || contract?.title || '',
    description: meta?.description || contract?.description || '',
    category: meta?.category || contract?.category || DEFAULT_SECRET_CATEGORY
  };
}

/** Shown after a stored value is removed or replaced: the store forgets it,
 *  but wherever it was issued it may still work. The clients show the key's
 *  description under it, which says where it came from. */
export const SECRET_REVOKE_NOTE = 'Now revoke the old value where it came from.';
