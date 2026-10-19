# Contributing

## Setup

Requires a current Node LTS (see `engines` in `package.json`).

```sh
npm ci
npm run verify   # format, lint, typecheck, tests + coverage, build, package checks
```

## Workflow

- Branch from `dev` as `feature/<name>` (or `hotfix/<name>`), and open a PR
  back to `dev`. PRs are merged with a merge commit.
- Use [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`, 50 characters or fewer).
- For any user-facing change run `npm run changeset` and commit the file.
- Adding, removing or renaming a public export means updating
  `test/public-api.test.ts`; see [docs/VERSIONING.md](docs/VERSIONING.md) for
  what counts as a breaking change.

## Code style

- Google TypeScript Style Guide, enforced by ESLint and Prettier.
- Named exports only; explicit types on variables and return values.
- Fallible functions return a `Result`; never throw across the public API.
- Error messages must say what failed, where, and with which identifiers.
