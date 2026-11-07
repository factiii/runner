// A file search under this many characters is not a search: the list stays as
// it is (`onedriveEmbed.files` → `query`). One letter matches nearly every
// file, and reads every file's text to say so.
//
// In a file of its own, with no imports, so the vault router
// (@shared/vault-router) can read it without `oakbox.ts`'s imports, which
// reach the server's router types. `oakbox.ts` re-exports it.
export const VAULT_SEARCH_MIN_CHARS = 2;
