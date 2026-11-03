# Notes for agents

> **Not public documentation.** These are internal working notes for the agents and people who maintain this
> repository and the ntanis.dev projects that call it. Nothing here is a supported interface or a promise to anyone
> else, and it changes whenever those projects need it to. The public description is [README.md](README.md).

## Ground rules

- This repository is public: commit messages carry no `Co-Authored-By` trailer.
- `main` is where the Hub's trust comes from (see [Pinning and the Hub](#pinning-and-the-hub)). It is protected
  against force pushes and deletion, administrators included. Do not rewrite it.
- Run `node --test tests/*.test.mjs` before pushing. `ci.yml` runs the same tests on pushes that touch `tests/`,
  `.github/workflows/` or `.github/actions/`.
- Never add release-age exceptions (`minimumReleaseAgeExclude`, uv `exclude-newer-package`) or overrides that force a
  version outside its declared range, here or in a caller. A fix younger than two weeks waits; the gate reports it as
  waiting and passes.
- Every job sets `timeout-minutes` (see [Job timeouts](#job-timeouts)), and scheduled runs stay weekly.

## Pinning and the Hub

Callers pin every workflow by full commit: `ntanis-dev/ci/.github/workflows/<file>@<40 hex>`. The workflows here call
this repository's actions the same way (`ntanis-dev/ci/.github/actions/<name>@<40 hex>`). So changing an action takes
two commits on `main`: the action itself, then the workflows re-pinned to that commit. Callers then pin the second
one. Callers drift across different commits over time; when you roll anything out, bump every caller to the head of
`main`. Callers live in the `ntanis-dev`, `primed-sh` and `criticalscripts-shop` repositories.

Hub authenticates the workflows that talk to it (`register-project.yml`, `project-candidate.yml`,
`project-kubernetes-service.yml`, `project-container-service.yml`, `report-hosted-deployment.yml`,
`ghcr-retention.yml`) by their GitHub OIDC `job_workflow_ref`. It accepts a call only when the workflow file is one it
expects for that purpose and the pinned commit is reachable from this repository's `main`. It asks GitHub's compare
API (`<commit>...main` must be `ahead` or `identical`) and caches a yes for an hour and a no for a minute. There is no
list of commits to update: push to `main`, then callers pin the commit. A branch or tag reference, or a commit that is
not on `main`, is refused.

Rewriting `main` therefore means lifting its protection first, and every caller pinned to a commit that disappears
stops deploying (after at most an hour of cached trust) until it is re-pinned.

## Dependency scan and maintenance

`dependency-scan.yml` scans a repository with OSV-Scanner (a pinned release, checked against its SHA-256 in
`.github/actions/dependency-gate/action.yml`) and fails only when someone has to act. The `dependency-gate` action
classifies every finding:

- **accepted**: listed in [`accepted-advisories.json`](accepted-advisories.json) with a reason and an expiry date. The
  gate reads that file from `main`, so a decision applies everywhere without re-pinning. Expired entries fail again.
- **waiting**: the fixed release is younger than the two-week release age; the scan reports the date it lands and
  passes.
- **action**: a fixed release has passed the release age but is not applied.
- **decision**: there is no fixed release, or an acceptance expired.

Only action and decision fail (at or above `fail-severity`; unknown severities and release dates fail closed). Release
dates come from the npm registry, PyPI, crates.io and the Go module proxy; a Go standard library fix is dated by its
toolchain release. `project-validate.yml` and `project-candidate.yml` run the same gate at `high` in place of `pnpm
audit`.

Decisions that concern one repository only stay in that repository's `osv-scanner.toml`, which OSV-Scanner applies
first. It reads that file only from the directory of each file it scans, so a project with lockfiles in several
folders needs one next to each. For `requirements.txt`, OSV-Scanner resolves the transitive versions itself, and they
can differ from what pip installs: pin the versions that are really installed so the scan sees them.

`dependency-maintenance.yml` runs weekly in each pnpm repository, before its scan. It refuses to run without
`minimumReleaseAge: 20160` and `minimumReleaseAgeStrict: true`. It then:

- drops `minimumReleaseAgeExclude` entries whose versions are two weeks old (quoted or not, with their comments);
- moves an override that pins a vulnerable version to the mature fix of the same major;
- updates only the packages whose mature fix is missing, through `pnpm update`, so pnpm's own `minimumReleaseAge`
  decides what enters the lockfile;
- verifies the frozen install, the supply-chain policy and the optional check and build scripts, regenerates
  third-party notices and pushes to `main` as `github-actions[bot]`.

It never adds an exception or an override. Commits pushed with the workflow token start no other workflow, so the
change is built and deployed by the next push.

```yaml
# .github/workflows/osv-scanner.yml
name: Dependency Vulnerability Scan
on:
  push:
    branches: [main]
    paths: ["**/pnpm-lock.yaml", "**/osv-scanner.toml", ".github/workflows/osv-scanner.yml"]
  schedule:
    - cron: '29 4 * * 1'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  scan:
    uses: ntanis-dev/ci/.github/workflows/dependency-scan.yml@<exact-commit>
```

```yaml
# .github/workflows/dependency-maintenance.yml
name: Dependency maintenance
on:
  schedule:
    - cron: '47 3 * * 1'
  workflow_dispatch:
permissions:
  contents: write
jobs:
  maintain:
    uses: ntanis-dev/ci/.github/workflows/dependency-maintenance.yml@<exact-commit>
    with:
      build-script: build
```

Both take `exclude`, newline-separated paths whose lockfiles ship nowhere (experiments, research snapshots). The
`pnpm-supply-chain` check accepts an `osv-scanner.yml` only when it calls `dependency-scan.yml` at a full commit.

To accept an advisory that has no fix in range, add one entry to `accepted-advisories.json` (id, package, until,
reason) rather than per-repository files. Do not bump lockfiles by hand for mature fixes in a maintained repository;
Monday's run does it, or start it early with `workflow_dispatch`. Go and Python fixes are not maintained
automatically and are applied by hand.

`node scripts/dependency-summary.mjs` (optionally `--out <file>`) reads every repository's latest results with your
own `gh` login and prints one summary: what needs you, what maintenance fixed this week, what is waiting and until
when, and which acceptances expire soon.

## Release candidates

`project-candidate.yml` builds the repository-declared platform matrix without using GitHub Actions artifact storage.
Each isolated platform runner stages only its declared top-level release files, registers that target through the
repository-bound GitHub OIDC identity, and uploads bounded checksummed chunks directly to Hub. The final job sends no
binaries; it only asks Hub to atomically mark the candidate ready after every configured target and byte has been
verified. Hub removes incomplete upload sessions after 24 hours.

Candidate callers are release controls, not continuous-build workflows. Trigger them explicitly from
`workflow_dispatch` on the registered branch and pin the reusable workflow to an exact commit:

```yaml
name: Build candidate
on:
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  candidate:
    uses: ntanis-dev/ci/.github/workflows/project-candidate.yml@<exact-commit>
    with:
      project: example
      build-matrix: '<repository-owned JSON matrix>'
```

## Hosted project containers

`project-container-service.yml` publishes and optionally deploys an approved Hub component without assuming a project
package manager or programming language. The caller must make the reusable-workflow job depend on its complete
repository-owned verification job. The shared workflow independently validates the Hub contract, requires
digest-pinned Dockerfile base images, publishes the commit-tagged image, captures its immutable registry digest, and
submits only the bounded deployment request with GitHub OIDC. It receives no Hub or Kubernetes credential. Before
validation and image construction, it materializes every Git LFS object and fails closed if any tracked file remains an
unresolved pointer. The legacy pnpm-specific Kubernetes workflow enforces the same checkout boundary.

The optional `context` (default `.`) and `dockerfile` (default `Dockerfile`) inputs are repository-relative paths. The
Dockerfile must be inside the context; resolved paths must stay inside the checkout, and the context must include a
`.dockerignore`. Modern contracts select either `ghcr.io/<owner>/<repo>` or `ghcr.io/<owner>/<repo>/<component>`.
Component builds have separate concurrency keys. Runtime environment requirements include only secrets declared for
that component (plus unscoped declarations); these are names, never values.

Optional `public-build-args` is a bounded JSON object of `PUBLIC_` names and single-line string values. These values
are baked into the image and may appear in public browser bundles and build metadata. Use repository variables for
public identifiers; never pass secrets or private credentials. Arguments are validated and passed as separate quoted
Docker arguments without shell evaluation.

`tests/project-container-workflow.test.mjs` exercises the embedded contract validator, including path confinement,
image ownership, and secret selection.

```yaml
jobs:
  verify:
    # Repository-specific locked installs, audits, lint, tests, SBOM and image smoke test.

  deploy-container:
    needs: verify
    if: github.event_name != 'pull_request'
    permissions:
      contents: read
      packages: write
      id-token: write
    uses: ntanis-dev/ci/.github/workflows/project-container-service.yml@<exact-commit>
    with:
      project: example
      component: api
      deploy: ${{ github.ref == 'refs/heads/main' && vars.NTANIS_KUBERNETES_DEPLOY_ENABLED == 'true' }}
```

Container deployment status polling uses the contract startup timeout and replica bound plus ten minutes for
queueing. The maximum is 310 minutes; omitted startup settings keep a bounded default. Hub remains responsible for
health checks, leases and rollback.

When Hub holds a queued deployment because required component-scoped settings are not yet saved and applied, its
status carries their names as `missing_environment`. The deploy job then ends successfully with a warning annotation
instead of polling: Hub keeps the running build serving and rolls the queued image out by itself once the settings
are applied, so no new run is needed. A Hub that does not report the field leaves the job polling as before.

## Job timeouts

Every job in these workflows sets `timeout-minutes`, so a stuck job cannot run for GitHub's default six hours. Each
reusable workflow takes its timeout as an optional input; callers do not need to pass it unless a project is slower
than usual.

| Workflow | Input | Default | Usual run |
| --- | --- | --- | --- |
| `project-validate.yml` | `timeout-minutes` | 15 | under 2 minutes |
| `project-candidate.yml` | `timeout-minutes` (each build and the final upload) | 30 | builds up to 7, upload up to 14 |
| `project-kubernetes-service.yml` | `timeout-minutes` (build), `deploy-timeout-minutes` | 20, 25 | build under 8, deploy under 9 |
| `project-container-service.yml` | `timeout-minutes` (build) | 20 | under 5 |
| `dependency-scan.yml` | `timeout-minutes` | 10 | a few minutes |
| `dependency-maintenance.yml` | `timeout-minutes` | 30 | a few minutes |
| `register-project.yml`, `report-hosted-deployment.yml`, `ghcr-retention.yml` | `timeout-minutes` | 10 | seconds to a minute |

The container deploy job has no input: its timeout is computed from the same startup budget as its health polling (15
seconds per poll, plus ten minutes, never more than six hours), so a slow but healthy cold start is never cut short.
`tests/workflow-timeouts.test.mjs` fails if a job loses its timeout or the deploy timeout stops covering the poll
budget.

## Release-age maintenance (replaced)

`release-age-maintenance.yml` is the older cleanup that only removed release-age exceptions marked with an expiry
date (`# security-expires: 2026-11-02` after a pnpm entry, or a `# security-expires: name=date` line above a uv
`exclude-newer-package` table). Since 2026-11-02 no repository calls it: `dependency-maintenance.yml` drops matured
exceptions by their release date and does the rest. Its own Monday schedule only runs in this repository. Its tests
are `tests/release-age-maintenance.test.mjs`; delete the workflow, its action and its tests together if it goes.
