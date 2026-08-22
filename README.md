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
