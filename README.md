# @factiii/runner 0.44.0: source

The source of [`@factiii/runner`](https://www.npmjs.com/package/@factiii/runner),
the program that lets you drive AI coding agents on a computer you own from the
Factiii apps (https://factiii.com).

This repository is generated from Factiii's private monorepo on every release.
It holds `apps/runner` and exactly the shared files the runner compiles, so
what you read here is what `dist/cli.js` is built from. Pull requests are not
merged here; please open an issue instead.

- What the runner can do, and how you control it: [DISCLOSURE](apps/runner/DISCLOSURE)
- What the Vault and Runner Cloud keep, who reads them, and how to report a problem: [SECURITY](SECURITY.md)
  (the code: `shared/vault-core`)
- Build: `pnpm install --frozen-lockfile && pnpm build` (output in `apps/runner/dist`).
  `pnpm-lock.yaml` pins every package to the version the release was built with.
- Check the build: `pnpm build:check` builds twice, fails unless both are
  byte-identical, and writes their checksums to `SHA256SUMS` (a release
  commits the one its own check wrote, vault-core's line included)
- Test: `pnpm test` (vault-core's tests, then the runner's)
- Release tarballs: see Releases. Install one with `npm install -g ./factiii-runner-<version>.tgz`.

Contact: support@factiii.com
