# Security: the runner's Vault and Runner Cloud

This file ships with the public source of `@factiii/runner`
(https://github.com/factiii/runner). It says what the runner's two stores
keep, who can read them, what never leaves your computer, where the code that
enforces each rule lives, and how to report a problem.

## The two stores

The runner keeps two separate stores on your computer. Each is its own
database (PGlite, an in-process Postgres) and its own files folder, so no
query, search or index of one can reach the other's rows.

| | Runner Cloud | Vault |
|---|---|---|
| Folder | `parts/runner-storage/` in the runner's folder | `parts/vault/` |
| Who reads it | you, and the people you share it with | you only, never shared |
| Which AI reads it | any AI source you pick on the runner | Ollama on that runner only |
| Encrypted at rest | yes, under a key the runner holds | yes, under your Vault key, once set up |

Both are reached only over a direct, encrypted link (WebRTC) from your own
devices. Every store action is refused on Factiii's relay, so neither store's
data passes through Factiii's servers.

## The rules, and the code that enforces them

| Rule | Where |
|---|---|
| The Vault is owner only. A member you let in reaches Runner Cloud, never the Vault (`VAULT_NEVER_SHARED`). | `shared/vault-core/access.ts` (`vaultRole`, `vaultActionAllowed`) |
| Only Ollama on the runner reads the Vault. Claude, Codex and every other engine are refused before anything is read (`VAULT_OLLAMA_ONLY`). | `shared/vault-core/access.ts` (`storeEngineAllowed`, `askEngineAllowed`), called from `apps/runner/src/vault/ask.ts`, `askMcp.ts`, `service.ts` |
| Store actions never run on the relay (`RELAY_VAULT_REFUSAL`). | `shared/all/helpers/board-agent-core/runner-access.ts` |
| Encryption: AES-256-GCM, HKDF-SHA256 and scrypt from Node's own crypto, nothing hand-rolled. The database is sealed as one blob; files are sealed in 64 KiB segments (the STREAM construction). | `shared/vault-core/crypto.ts`, `objectStore.ts` (`sealKey`), `sealedDb.ts` |
| The Vault key: 160 random bits, shown once, kept in your password manager. On disk only the master key wrapped under it (scrypt, N = 2^17). | `shared/vault-core/keyring.ts`, `vaultKeys.ts` |
| Lock: after `VAULT_LOCK_IDLE_MINUTES` (default 15, you can set 1 to 1440) with no use, the database is flushed, its process ended and the master key overwritten. | `shared/vault-core/vaultKeys.ts`, `shared/all/validators/vaultKeys.ts` |
| Turning encryption on is crash safe: staged, verified by decrypting, then committed. | `shared/vault-core/sealMigration.ts` |
| Runner Cloud's key is made on first start and kept in a 0600 file in the runner's folder, on every OS (no Keychain; an older runner's Keychain-held key is moved to the file once, then deleted from the Keychain). | `shared/vault-core/runnerCloudSeal.ts` (the key file and its check), `apps/runner/src/vault/runnerCloudKey.ts` (where the key is kept) |
| One schema with Factiii's server. The stores' tables are cut from the server's schema by a script, and a test fails when they drift apart. | `shared/vault-core/schemaGen.ts`, `shared/vault-core/vault.prisma`, `apps/runner/src/vault/schemaGenCli.ts` (`vault:schema`, `vault:schema:check`) |
| The same procedures serve the server's store and the runner's. | `shared/vault-core/router.ts` (`createVaultRouter`), `prismaDb.ts` (the queries both run), `inputs.ts`, `ports.ts` |
| This code opens no network connection: a test fails if any of it, or the shared code it reaches, imports a networking module or calls a network API. | `shared/vault-core/noNetwork.test.ts` |
| The build can be checked: `pnpm build:check` builds twice, fails unless both builds are byte-identical, and writes their checksums (vault-core's own included) to `SHA256SUMS`. | `apps/runner/scripts/reproducible-build.mjs` |

The tests that prove these rules are in `shared/vault-core/*.test.ts`
(`access.test.ts`, `crypto.test.ts`, `objectStore.test.ts`,
`sealedDb.test.ts`, `sealMigration.test.ts`, `vaultKeys.test.ts`,
`runnerCloudSeal.test.ts`, `noNetwork.test.ts`) and
`apps/runner/src/vault/*.test.ts` (`stores.test.ts`, `ask.test.ts`,
`sealedDb.test.ts`, `vaultSeal.test.ts`, `runnerCloudKey.test.ts`). Run them
with `pnpm install && pnpm test`.

## What never leaves your computer

- Vault data, except an answer sent straight to you over the direct link when
  you open it.
- Your Vault key. Factiii never has it and cannot recover it.
- Backups (Time Machine, a synced folder) carry the Vault as ciphertext only.

## Honest limits

- Encryption protects a locked Vault, a powered-off computer, a stolen disk
  and backups. While the Vault is unlocked, anyone with full control of the
  runner's user account can read it: the key and the database are in that
  user's memory. Keep the idle lock short.
- Runner Cloud is sealed under a key the runner holds, so that AI and the
  people you share it with can use it while you are away. A backup of the
  whole runner folder that carries that key file can open Runner Cloud.
- Anyone with your Vault key can unlock the Vault from your devices. If you
  think it was seen, change it. Changing it re-wraps the Vault's master key
  under the new key; it does not re-encrypt the data under a new master key.
  The old key no longer opens today's `keys.json`, but the old key together
  with an older copy of `keys.json` (a Time Machine backup, a synced folder)
  still opens the data, today's included. So after a suspected leak, change
  the key and also delete the old backups of the Vault folder.
- A Vault that was never encrypted is plain files readable by the runner's
  user.

## Reporting a problem

Please do not open a public issue for a security problem. Email
support@factiii.com with "Security" in the subject, what you found and how to
reproduce it.
