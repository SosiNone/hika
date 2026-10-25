---
name: create-release
description: Cut a HIKA release - pick the semver bump from the commits since the last tag, run the checks, tag vX.Y.Z on main, push it and watch the GitHub Pages deploy. Use when the user asks to release, ship, tag or deploy the site.
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

## 2. See what is being released

```bash
git -C <repo> describe --tags --abbrev=0          # last tag; none yet means first release
git -C <repo> log --oneline --no-merges <last-tag>..HEAD   # or the full history for a first release
```

If there are no commits since the last tag, there is nothing to release: say so and stop.

## 3. Pick the bump

The project is pre-1.0 (`0.y.z`), so follow the usual 0.x semver convention:
- **minor** (`0.1.0 → 0.2.0`): new features, new regions, user-visible changes to the HUD,
  or a change to the bundle format (`trails.bin`, `region.json`, `RegionBundle`).
- **patch** (`0.1.0 → 0.1.1`): fixes, docs, CI, refactors, data refreshes with no format change.
- **major**: only when the user decides the project is 1.0 or later.

Use the bump the user named if they named one; otherwise decide yourself. Note the version and a
short grouped summary of the commits (features / fixes / other) for the final report.

## 4. Run the checks

`task release` runs `task check` itself, but also run the region check, as the deploy workflow does,
so a failure shows up before anything is committed or tagged:

```bash
task check
task region:check
```

If anything fails, stop and report the output. Don't tag a broken build.

## 5. Tag and push

From the main checkout:

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
- **Deploy job rejected by environment protection**: the `github-pages` environment doesn't allow
  tags yet. Tell the user to add a `v*` tag rule under Settings → Environments → `github-pages` →
  Deployment branches and tags, then re-run the failed run with `gh run rerun <run-id>`.
- **Build failure**: show the failing step's log (`gh run view <run-id> --log-failed`). The tag is
  already public; fix forward with a new patch release rather than deleting or moving the tag,
  unless the user explicitly asks for that.

## Don't

- Don't edit `package.json`'s version by hand or create tags with `git tag` directly; `npm version`
  keeps the commit, tag and `package-lock.json` in step.
- Don't force-push, delete or re-point a published tag without the user asking.
- Don't push from a worktree branch or release unmerged work.
