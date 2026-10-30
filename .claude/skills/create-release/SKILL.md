---
name: create-release
description: Cut a HIKA release - check the Pages tag rule, pick the version (tag an unreleased version as is, otherwise a semver bump from the commits since the last tag), run the checks, tag vX.Y.Z on main, push it and watch the GitHub Pages deploy. Use when the user asks to release, ship, tag or deploy the site.
---

# Create a release

Pushing a `v*` tag is what deploys the site: `.github/workflows/pages.yml` builds and publishes to
GitHub Pages, and fails unless the tag equals `v` + the `package.json` version. Pushes to `main`
alone deploy nothing. `task release` wraps the mechanics (checks, `npm version`, `git push --follow-tags`).

Choosing the bump is your call (AGENTS.md: "Bump the version to your own judgement"). Pushing the
tag publishes the live site, so only push when the user asked for a release; if you got here some
other way, ask first.

## 1. Check the starting point

Releases are cut from `main` in the main checkout, never from a worktree branch. If you are in a
worktree, run the git commands with `git -C <main checkout>` (the worktree's parent repo).

```bash
git -C <repo> fetch --tags origin
git -C <repo> status --short --branch
```

Stop and tell the user if:
- the current branch is not `main`;
- the tree is dirty (`npm version` refuses to run on a dirty tree);
- `main` is behind `origin/main` (pull first, with their OK) or ahead of it with commits they may
  not have meant to publish (list them and ask).

Then check that the `github-pages` environment accepts tag deploys:

```bash
gh api repos/SosiNone/hika/environments/github-pages/deployment-branch-policies \
  --jq '.branch_policies[] | {name, type}'
```

There must be an entry `{"name": "v*", "type": "tag"}`. A `v*` entry with `"type": "branch"` looks
right in the settings page but does **not** match tags; the build would pass and the deploy job
would be rejected. If the tag rule is missing, stop and ask the user to add it under Settings →
Environments → `github-pages` → Deployment branches and tags → Add rule, with **Ref type: Tag** and
pattern `v*`. (Adding it yourself with `gh api` changes repository settings: only with their OK.)
Re-run the check after they say it's done; don't take their word for it.

## 2. See what is being released

```bash
git -C <repo> describe --tags --abbrev=0          # last tag; none yet means first release
git -C <repo> log --oneline --no-merges <last-tag>..HEAD   # or the full history for a first release
```

If there are no commits since the last tag, there is nothing to release: say so and stop.

## 3. Pick the version

**First, check whether the current version was ever released:**

```bash
git -C <repo> tag --list "v$(node -p 'require("<repo>/package.json").version')"
```

If that prints nothing (always the case for the first release), the `package.json` version has
not been published yet: **release it as is, without bumping**. Bumping would skip a version that
never shipped. Use the tag-as-is path in step 5.

Otherwise, pick a bump. The project is pre-1.0 (`0.y.z`), so follow the usual 0.x semver convention:
- **minor** (`0.1.0 → 0.2.0`): new features, user-visible changes to the HUD, or reading a new
  atlas format (`ATLAS_FORMAT` in `src/data/types.ts`). New regions and data refreshes ship from the
  hika-data repo and need no app release.
- **patch** (`0.1.0 → 0.1.1`): fixes, docs, CI, refactors.
- **major**: only when the user decides the project is 1.0 or later.

Use the bump the user named if they named one; otherwise decide yourself. Note the version and a
short grouped summary of the commits (features / fixes / other) for the final report.

## 4. Run the checks

`task release` runs `task check` itself (type-check and tests, as the deploy workflow does), but
run it first so a failure shows up before anything is committed or tagged:

```bash
task check
```

If anything fails, stop and report the output. Don't tag a broken build.

## 5. Tag and push

From the main checkout.

**Tag as is** (the current version is untagged, see step 3): there is nothing to commit, so tag
`HEAD` directly and push `main` before the tag, so the tagged commit is on `origin/main`:

```bash
git -C <repo> push origin main
git -C <repo> tag -a v<version> -m "Release v<version>"
git -C <repo> push origin v<version>
```

**Bump** (the usual case):

```bash
task --yes release BUMP=<patch|minor|major>
```

`--yes` answers the task's confirmation prompt (the shell here is non-interactive). This creates the `Release vX.Y.Z` commit and the `vX.Y.Z` tag, then
pushes `main` and the tag.

If `task` is unavailable, do the same by hand: `npm version <bump> -m "Release v%s"`, then
`git push --follow-tags`.

## 6. Watch the deploy

```bash
gh run list --workflow=pages.yml --limit 1
gh run watch <run-id> --exit-status
```

Run `gh run watch` in the background, since it can take a few minutes.

- **Success**: report the version and the live URL, <https://sosinone.github.io/hika/>.
- **Deploy job rejected by environment protection**: the `github-pages` tag rule is missing or was
  added as a branch rule (see step 1). Once the user has added the `v*` **tag** rule and the check
  confirms it, re-run the failed run with `gh run rerun <run-id> --failed`.
- **Build failure**: show the failing step's log (`gh run view <run-id> --log-failed`). The tag is
  already public; fix forward with a new patch release rather than deleting or moving the tag,
  unless the user explicitly asks for that.

## Don't

- Don't edit `package.json`'s version by hand. To bump, use `npm version` (via `task release`), which
  keeps the commit, tag and `package-lock.json` in step. Use `git tag` directly only for the
  tag-as-is path, where the version is already right.
- Don't force-push, delete or re-point a published tag without the user asking.
- Don't push from a worktree branch or release unmerged work.
