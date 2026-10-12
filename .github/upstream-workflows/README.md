# Inactive upstream workflow archive

These 13 YAML files are byte-for-byte copies of the upstream workflows present
in the imported foundation. GitHub only discovers workflows in
`.github/workflows/`; this directory is reference material, not active automation.
Do not move these files back without separately reviewing and authorizing their
effects. Repository publication does not authorize deployment or releases.

| Original workflow | Effects retained here, inactive |
| --- | --- |
| `ci.yml` | Original test/build/architecture/OpenSpec/contributor gates, PostgreSQL, Rust/native probes and dependency audit, browser smoke, Docker scanning (including Security writes), Helm/kind local installs, Nix checks. |
| `docs.yml` | Strict docs build, Pages artifact upload and GitHub Pages deployment. |
| `issue-labeler.yml` | Adds issue labels. |
| `pr-labeler.yml` | Labels PRs on `pull_request_target`. |
| `prepare-beta-release.yml` | Commits/pushes beta branches, creates/edits PRs, closes superseded beta PRs. |
| `publish-beta-release.yml` | Pushes tags and creates/edits GitHub prereleases after beta PR merges. |
| `release-guards.yml` | Read-only stable/beta release validation using PR metadata. |
| `release-please.yml` | Release PR/tag/release automation and lockfile commits/pushes. |
| `release.yml` | PyPI publishing, GHCR image/chart pushes, Security uploads, GitHub release writes and withdrawal to draft on failure. |
| `simplicity-budgets.yml` | Read-only live PR-label lookup and budget validation. |
| `stale.yml` | Scheduled issue/PR comments, labels and closures. |
| `update-upstream-metadata.yml` | Scheduled external snapshot refresh, commits, branch pushes and PR creation (upstream-repository gated). |
| `windows-startup.yml` | Manually dispatched Windows memory/startup regression checks. |

The active Gemini workflow grants only `contents: read` and runs validation on
main pushes, pull requests and merge queues, without manual/scheduled triggers,
publication actions, secrets, bot writes or deployment. Existing Make targets,
Python/uv/Bun/Rust tooling and all original tests remain available unchanged.
The active suite runs full unit/simulation, all integration-core shards (including
Gemini/source/API-key/migration tests), bridge and e2e slices, SQLite migration
checks, frontend coverage tests, lint/types/package and Rust/native wire checks.
PostgreSQL, browser, Docker/Helm/Nix and upstream policy checks remain available
in the original toolchain/archive but are not claimed as active Gemini CI gates.

Known upstream shutdown failures reproduced at CPython 3.14.8 are not excluded
or marked `continue-on-error`. CI uses the original Python 3.13 selection and
must report its actual unfiltered outcome; a local result on another interpreter
is not evidence of a green GitHub run.
