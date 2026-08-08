# Ntanis CI

Public, secret-free reusable workflows for projects owned by ntanis.dev.

`project-candidate.yml` builds an explicitly configured matrix on isolated GitHub-hosted runners. Build jobs have read-only repository access and **no OIDC permission**. A pinned staging action copies only the declared top-level release files before GitHub retains those short-lived transfer artifacts for one day. One publisher job downloads the complete matrix without executing repository code, proves its GitHub OIDC identity, declares an atomic manifest, and uploads checksum-verified 8 MiB chunks to ntanis.dev Hub with at most four requests in flight.

Hub accepts an upload only when the signed identity matches the registered repository, branch, commit, run and an immutable revision of this reusable workflow. No project receives a Hub credential. A candidate becomes reviewable only after every required platform, architecture and format in its manifest is present. Uploaded bytes remain private until an owner publishes them in Hub; unpublishing immediately removes the public pointer without deleting the candidate.

Call it from a project workflow:

```yaml
jobs:
  candidate:
    permissions:
      contents: read
      id-token: write
    uses: ntanis-dev/ci/.github/workflows/project-candidate.yml@FULL_COMMIT_SHA
    with:
      project: example
      build-matrix: >-
        [{"os":"ubuntu-latest","script":"build","artifactDirectory":"dist","includeExtensions":"appimage","includeFiles":"example-*.AppImage","platform":"linux","architecture":"x64","platformSigned":false,"install":true}]
```

Pin this workflow and every third-party action by full commit SHA. Never add credentials, deployment keys, arbitrary shell bridges or project-specific secrets to this repository. Release files are served by ntanis.dev after publication; this workflow never creates GitHub Releases.

Every caller must implement the ntanis.dev secure pnpm baseline: pnpm 11.15.1, exact direct dependencies, a committed pnpm lockfile, frozen installs, denied-by-default lifecycle scripts, a 14-day release cooldown, SHA-pinned actions, registry-signature verification, fail-closed vulnerability checks, and a CycloneDX SBOM. The authoritative internal runbook lives in Hub at `docs/pnpm-supply-chain.md`.

Each matrix entry declares `install` explicitly. Use `true` when the build needs `pnpm install --frozen-lockfile` and `false` only for packaging steps that require no installed repository dependencies. The separate metadata job still installs and audits the locked graph before any matrix build proceeds.

`includeExtensions` is a required-format specification, not merely a filter. For example, `"exe,blockmap,yml"` means all three formats must exist for that target or the complete submission fails. `includeFiles` is a comma-separated set of safe top-level filename patterns; directories and files outside those explicit patterns are never submitted. A newer run replaces an unfinished older upload; Hub keeps only the current publication, its rollback predecessor and at most one active candidate, while unreferenced chunks and blobs are reclaimed automatically.

## Isolated web services

`project-service.yml` is the separate contract for ntanis.dev projects that need their own backend. It currently accepts `tempo`, `justdoit`, `lyrical`, and `djtube`. The build job runs the frozen pnpm install, policy and signature checks, vulnerability checks, project verification and the build without any deployment credential. It emits a production CycloneDX SBOM, prunes development packages, and transfers a one-day runtime artifact to a fresh deploy job. That job verifies the checksum and can only connect as the host's constrained `project-ci` account. The host broker then routes the exact project identifier to that project's isolated guest; the guest deployer checks archive paths, switches an immutable release, verifies `/health`, rolls back on failure and retains three releases.

The SSH private key is supplied by the private caller repository and is never stored here. The reusable workflow must be pinned by full commit SHA. Adding another service requires an explicit allow-list entry in this workflow and in the host/guest broker; arbitrary project names, commands, runtime paths and destinations are intentionally unsupported.
