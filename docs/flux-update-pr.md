# flux-update-pr

Reusable workflow that turns a Flux `ImageUpdateAutomation` push branch into a pull request with
the upstream release notes, assigned per component.

Flux finds the new tag and commits the bump. The workflow adds what Flux can't:

- the release notes of every release between the old and new version, not only the latest
- a **Before merging** section that collects the release notes' deploy, upgrade, migration and
  behavior-change sections, so operators see right away whether the bump needs config changes
- a warning when the notes announce a breaking change
- assignees, reviewers and labels **per component**

## Flow

```
ImagePolicy picks new tag
  -> ImageUpdateAutomation commits the bump to <env>/<component>-updates   (push.branch)
  -> push triggers the caller workflow in the k8s repo
  -> flux-update-pr diffs the branch against main, reads the changed $imagepolicy setters,
     fetches the release notes and creates or refreshes the PR
```

Environments that should deploy without review (usually dev) push straight to `main` and never
reach this workflow.

The workflow only rewrites the part of the PR body between
`<!-- flux-update-pr:begin -->` and `<!-- flux-update-pr:end -->`; anything written outside the
markers survives later pushes.

## Caller

```yaml
# .github/workflows/flux-update-pr.yaml in the k8s repo
name: Flux update PR
on:
  push:
    branches:
      - "*/*-updates"
jobs:
  pr:
    uses: pinax-network/.github/.github/workflows/flux-update-pr.yaml@main
    permissions:
      contents: read
      pull-requests: write
    secrets:
      # only needed when an upstream repo is private
      release-notes-token: ${{ secrets.PAT_INTERNAL_REPOSITORIES }}
```

Inputs: `config` (default `.github/flux-updates.yaml`) and `base` (default `main`).

The PR is opened with `GITHUB_TOKEN`, so the owner of `release-notes-token` can still be
assigned or asked to review. A PR opened with `GITHUB_TOKEN` does not trigger `pull_request`
workflows; validation that runs on `push` still reports on the branch head.

## Config

```yaml
# .github/flux-updates.yaml in the k8s repo
defaults:
  labels: [dependencies]

components:
  pinax-account-api:
    repo: pinax-network/pinax-account-api
    assignees: [fschoell]

  nats:
    policies: [nats]                  # ImagePolicy names; default is the component id
    repo: nats-io/nats-server
    version: appVersion               # release notes follow the chart's appVersion
    chart: oci://registry/charts/nats # needed for appVersion
    assignees: [someone]
    reviewers: [someone-else]
```

| Key | Meaning |
|---|---|
| `policies` | `ImagePolicy` names, or `namespace:name`, belonging to the component. Default `[<id>]`. |
| `repo` | GitHub repository whose releases are the changelog. Without it the PR only lists the change. |
| `assignees`, `reviewers`, `labels` | Applied to the PR. A PR covering several components gets the union. |
| `tag-prefix` | Prefix of upstream release tags, e.g. `redis/`. |
| `version` | `tag` (default) or `appVersion`. |
| `chart` | Chart reference for `helm show chart`, required for `appVersion`. |
| `include-prereleases` | Also list prereleases. Default false, unless the new version is itself a prerelease. |

`defaults` takes any of these keys plus:

| Key | Default |
|---|---|
| `deploy-sections` | Heading regex for the **Before merging** section: `^(deploy(ment)?\|upgrad(e\|ing)\|breaking\|behaviou?r change\|migration\|action required\|config(uration)? change\|operator)` |
| `breaking-pattern` | Body regex that triggers the warning: `breaking change\|\bBREAKING\b\|backwards?[- ]incompatible` |

Keep one `ImageUpdateAutomation` (and so one push branch) per component when the components have
different reviewers; Flux batches every change under its `update.path` into one branch.
