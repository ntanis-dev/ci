# Ntanis CI

Public, secret-free reusable workflows for projects owned by Ntanis.

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

Each matrix entry declares `install` explicitly. Use `true` for locked `npm ci` builds and `false` only for packaging steps that need no repository dependencies.

`includeExtensions` is a required-format specification, not merely a filter. For example, `"exe,blockmap,yml"` means all three formats must exist for that target or the complete submission fails. `includeFiles` is a comma-separated set of safe top-level filename patterns; directories and files outside those explicit patterns are never submitted. A newer run replaces an unfinished older upload; Hub keeps only the current publication, its rollback predecessor and at most one active candidate, while unreferenced chunks and blobs are reclaimed automatically.
