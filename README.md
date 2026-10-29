# Ntanis CI

Internal CI workflows and actions for repositories owned and operated by
[ntanis.dev](https://ntanis.dev).

This repository is not an integration surface for third-party projects. Its contents may change without notice, and external use is unsupported.

## Release candidates

`project-candidate.yml` builds the repository-declared platform matrix without using GitHub Actions artifact storage. Each isolated platform runner stages only its declared top-level release files, registers that target through the repository-bound GitHub OIDC identity, and uploads bounded checksummed chunks directly to Hub. The final job sends no binaries; it only asks Hub to atomically mark the candidate ready after every configured target and byte has been verified. Hub removes incomplete upload sessions after 24 hours.

Candidate callers are release controls, not continuous-build workflows. Trigger them explicitly from `workflow_dispatch` on the registered branch and pin the reusable workflow to an exact commit:

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

`project-container-service.yml` publishes and optionally deploys an approved
Hub component without assuming a project package manager or programming
language. The caller must make the reusable-workflow job depend on its complete
repository-owned verification job. The shared workflow independently validates
the Hub contract, requires digest-pinned Dockerfile base images, publishes the
commit-tagged image, captures its immutable registry digest, and submits only
the bounded deployment request with GitHub OIDC. It receives no Hub or
Kubernetes credential.
Before validation and image construction, it materializes every Git LFS object
and fails closed if any tracked file remains an unresolved pointer. The legacy
pnpm-specific Kubernetes workflow enforces the same checkout boundary.

The optional `context` (default `.`) and `dockerfile` (default `Dockerfile`)
inputs are repository-relative paths. The Dockerfile must be inside the context;
resolved paths must stay inside the checkout, and the context must include a
`.dockerignore`. Modern contracts select either `ghcr.io/<owner>/<repo>` or
`ghcr.io/<owner>/<repo>/<component>`. Component builds have separate concurrency
keys. Runtime environment requirements include only secrets declared for that
component (plus unscoped declarations); these are names, never values.

Optional `public-build-args` is a bounded JSON object of `PUBLIC_` names and
single-line string values. These values are baked into the image and may appear
in public browser bundles and build metadata. Use repository variables for
public identifiers; never pass secrets or private credentials. Arguments are
validated and passed as separate quoted Docker arguments without shell evaluation.

Run `node --test tests/*.test.mjs` to exercise the actual embedded contract
validator, including path confinement, image ownership, and secret selection.

Callers must pin the reusable workflow to an exact commit:

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

Container deployment status polling uses the contract startup timeout and replica bound plus ten minutes for queueing. The maximum is 310 minutes; omitted startup settings keep a bounded default. Hub remains responsible for health checks, leases and rollback.

When Hub holds a queued deployment because required component-scoped settings are not yet saved and applied, its status carries their names as `missing_environment`. The deploy job then ends successfully with a warning annotation instead of polling: Hub keeps the running build serving and rolls the queued image out by itself once the settings are applied, so no new run is needed. A Hub that does not report the field leaves the job polling as before.

## Pinning and the Hub

Hub authenticates the workflows that talk to it (`register-project.yml`, `project-candidate.yml`, `project-kubernetes-service.yml`, `project-container-service.yml`, `report-hosted-deployment.yml`, `ghcr-retention.yml`) by their GitHub OIDC `job_workflow_ref`. It accepts a call only when the workflow file is one it expects for that purpose and the pinned commit is reachable from this repository's `main`. There is no list of commits to update: merge a change to `main`, then callers pin its commit. A branch or tag reference, or a commit that is not on `main`, is refused.

Because that makes `main` the source of deploy authority, it is protected against force pushes and deletion, including for administrators. Rewriting its history means lifting that protection first, and every caller that pins a commit which then disappears from `main` stops deploying until it is re-pinned.

## Job timeouts

Every job in these workflows sets `timeout-minutes`, so a stuck job cannot run for GitHub's default six hours. Each reusable workflow takes its timeout as an optional input; callers do not need to pass it unless a project is slower than usual.

| Workflow | Input | Default | Usual run |
| --- | --- | --- | --- |
| `project-validate.yml` | `timeout-minutes` | 15 | under 2 minutes |
| `project-candidate.yml` | `timeout-minutes` (each build and the final upload) | 30 | builds up to 7, upload up to 14 |
| `project-kubernetes-service.yml` | `timeout-minutes` (build), `deploy-timeout-minutes` | 20, 25 | build under 8, deploy under 9 |
| `project-container-service.yml` | `timeout-minutes` (build) | 20 | under 5 |
| `register-project.yml`, `report-hosted-deployment.yml`, `ghcr-retention.yml` | `timeout-minutes` | 10 | seconds to a minute |

The container deploy job has no input: its timeout is computed from the same startup budget as its health polling (15 seconds per poll, plus ten minutes, never more than six hours), so a slow but healthy cold start is never cut short. `tests/workflow-timeouts.test.mjs` fails if a job loses its timeout or the deploy timeout stops covering the poll budget.

## Self-expiring release-age exceptions

`release-age-maintenance.yml` removes expired security exceptions without changing the patched dependency versions. It runs weekly and can also be called manually. Each participating repository invokes the reusable workflow itself, so cleanup uses that repository's own `contents: write` token and needs no cross-repository credentials.

For pnpm, add an expiry date to each new `minimumReleaseAgeExclude` entry:

```yaml
minimumReleaseAgeExclude:
  - 'fast-uri@3.1.9' # security-expires: 2026-11-02
```

For uv, keep expiry metadata immediately above the inline exception table:

```toml
# security-expires: certifi=2026-11-03, filelock=2026-10-31
exclude-newer-package = { certifi = "2026-10-20T03:00:00Z", filelock = "2026-10-17T17:00:00Z" }
```

The cleanup removes only expired entries. Undated legacy entries remain unchanged. An empty pnpm list becomes `minimumReleaseAgeExclude: []`; an empty uv table and its metadata are removed. Removing a uv exception also advances the global `exclude-newer` cutoff to the exception's timestamp when that is newer, so the ordinary cooldown covers the patched package. No package is downgraded and no override is removed.

Before any commit, the workflow runs the frozen pnpm install, the shared supply-chain validator when configured, `uv lock`, and the repository's Python policy check. It stages only `pnpm-workspace.yaml`, `pyproject.toml`, and `uv.lock`, then pushes a metadata-only commit with `[skip ci]`. Failed verification produces no commit.

Install one static caller per participating repository and pin it to an exact central CI commit:

```yaml
name: Maintain release-age exceptions
on:
  workflow_dispatch:
permissions:
  contents: write
jobs:
  cleanup:
    uses: ntanis-dev/ci/.github/workflows/release-age-maintenance.yml@<exact-commit>
```

The reusable workflow's own Monday 05:17 UTC schedule supplies the recurring run. Routine dependency updates remain with Renovate; major upgrades and overrides outside a parent's accepted range stay manual.

Run `node --test tests/release-age-maintenance.test.mjs` to exercise expiry handling, empty-list cleanup, uv cutoff advancement, malformed metadata, and validator compatibility.
