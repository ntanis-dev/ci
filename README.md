# Ntanis CI

Public, secret-free reusable workflows for projects owned by Ntanis.

`project-candidate.yml` builds an explicitly configured matrix on isolated GitHub-hosted runners. Build jobs have read-only repository access and **no OIDC permission**. GitHub transfers their output to separate publisher jobs, which do not execute repository code; those jobs receive a short-lived GitHub OIDC identity and stream checksum-verified artifacts to Ntanis Hub.

Hub accepts an upload only when the signed identity matches the registered repository, branch, commit, run and this exact reusable workflow. No project receives a Hub credential. Uploaded bytes remain private candidates until an owner publishes or rejects them in the Hub admin panel.

Call it from a project workflow:

```yaml
jobs:
  candidate:
    permissions:
      contents: read
      id-token: write
    uses: ntanis-dev/ci/.github/workflows/project-candidate.yml@main
    with:
      project: example
      build-matrix: >-
        [{"os":"ubuntu-latest","script":"build","artifactDirectory":"dist","includeExtensions":"appimage","platform":"linux","architecture":"x64","platformSigned":false,"install":true}]
```

Pin third-party actions by full commit SHA. Never add credentials, deployment keys, arbitrary shell bridges or project-specific secrets to this repository.

Each matrix entry declares `install` explicitly. Use `true` for locked `npm ci` builds and `false` only for packaging steps that need no repository dependencies.
