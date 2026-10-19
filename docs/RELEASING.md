# Releasing

Versions are prepared by Changesets and published when you push a version tag.

## One-time setup

- An NPM automation token stored as the `NPM_TOKEN` repository secret, for an
  account that owns the `@richardmcquiston01` scope.
- "Allow GitHub Actions to create and approve pull requests" enabled under
  Settings, Actions, General (the version workflow opens a PR).

## Each release

1. Every user-facing PR carries a changeset (`npm run changeset`) and merges to
   `dev`.
2. Promote with a PR from `dev` to `main`, merged with a merge commit.
3. The **Version** workflow (`.github/workflows/version.yml`) opens or updates a
   "version packages" PR on `main`. It bumps `package.json`, writes
   `CHANGELOG.md` and removes the used changesets. Review and merge it. This
   does **not** publish.
4. Tag the merge commit on `main` with the version in `package.json`:

   ```bash
   git checkout main && git pull
   git tag v1.0.0
   git push origin v1.0.0
   ```

   or use "Draft a new release" on GitHub, choose **Create new tag** `v1.0.0`
   on target `main`, and publish. (Do not tag from a branch other than `main`.)

5. The **Publish** workflow (`.github/workflows/publish.yml`) runs on the tag. It
   refuses to continue unless the tagged commit is on `main` and the tag matches
   `package.json`. Then it runs `npm run verify`, publishes with provenance, and
   creates the GitHub release (marked a prerelease for tags such as
   `v1.1.0-beta.1`, which also publish under the `next` dist-tag instead of
   `latest`).
6. Fast-forward `dev` to `main` so the version commit is on both branches.

## If something goes wrong

- **Publish refused: not on main / tag mismatch.** Delete the tag
  (`git push --delete origin v1.0.0`, `git tag -d v1.0.0`), fix the cause, and
  tag again.
- **Verify failed.** Nothing was published. Fix on a branch, merge through
  `dev` and `main`, then move the tag: delete it as above and tag the new
  commit.
- **NPM rejected the publish after verify passed** (token, scope or provenance
  error). Fix the cause, then re-run the failed Publish job from the Actions
  tab, which retries the same tag.
- A version that NPM already has cannot be published again. Bump the version
  with a new changeset and tag the new version.
