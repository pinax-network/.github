# flux-update-pr

Composite action that turns a Flux `ImageUpdateAutomation` push branch into a pull request with
the upstream release notes, assigned per component.

Flux finds the new tag and commits the bump. The action adds what Flux can't:

- the release notes of every release between the old and new version, not only the latest
- with `summarize: true`, a **Summary** by GitHub Models: a verdict per component (`Merge as is`,
  `Needs config or secret change`, `Needs coordination`, `Breaking`) with action items citing their
  release
- otherwise, or when the model call fails, a **Before merging** section that quotes the release
  notes' deploy, upgrade, migration and behavior-change sections
- a warning when the notes announce a breaking change
- assignees, reviewers and labels **per component**

## Flow

```
ImagePolicy picks new tag
  -> ImageUpdateAutomation commits the bump to <env>/<component>-updates   (push.branch)
  -> push triggers the caller workflow in the k8s repo
  -> the action diffs the branch against main, reads the changed $imagepolicy setters,
     fetches the release notes and creates or refreshes the PR
```

Environments that should deploy without review (usually dev) push straight to `main` and never
reach this workflow.

The action only rewrites the part of the PR body between
`<!-- flux-update-pr:begin -->` and `<!-- flux-update-pr:end -->`; anything written outside the
markers survives later pushes.

## Usage

```yaml
# .github/workflows/flux-update-pr.yaml in the k8s repo
name: Flux update PR
on:
  push:
    branches:
      - "*/*-updates"
jobs:
  pr:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      models: read # only for summarize
    concurrency:
      group: flux-update-pr-${{ github.ref_name }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: pinax-network/.github/actions/flux-update-pr@main
        with:
          # only needed when an upstream repo is private
          release-notes-token: ${{ secrets.PAT_INTERNAL_REPOSITORIES }}
          summarize: true
```

| Input | Default | |
|---|---|---|
| `config` | `.github/flux-updates.yaml` | Component config in the calling repo. |
| `base` | `main` | Branch the Flux automation checks out and the PR targets. |
| `github-token` | `github.token` | Opens and edits the PR. |
| `release-notes-token` | | Reads releases of private upstream repos. |
| `summarize` | `false` | Summarize the release notes with GitHub Models; see below. |
| `model` | `openai/gpt-4.1` | GitHub Models model ID. |
| `models-token` | `github.token` | Token for the GitHub Models API; needs `models: read`. |
| `models-endpoint` | `https://models.github.ai/inference/chat/completions` | Use `https://models.github.ai/orgs/<org>/inference/chat/completions` to bill the organization. |
| `summary-max-input-chars` | `24000` | Largest release-notes input sent to the model. |

Outputs: `pull-request-number`, `pull-request-url` (empty when the branch has no changes).

The PR is opened with `github-token`, so the owner of `release-notes-token` can still be
assigned or asked to review. A PR opened with `GITHUB_TOKEN` does not trigger `pull_request`
workflows; validation that runs on `push` still reports on the branch head.

The action needs `yq` and, for `version: appVersion`, `helm`; both are on GitHub's Ubuntu runners.

## AI summary

With `summarize: true` the release notes go to GitHub Models, and its answer replaces the
**Before merging** section. To keep the PR body short, only one of the two is shown. The full
release notes stay below either way, and the summary says which model wrote it.

The **Before merging** section is the fallback whenever there is no summary: `summarize` is off,
GitHub Models isn't enabled for the organization, the call fails or times out, the answer is empty,
or the notes are too long. The PR is created either way; the run log has a warning saying why.

Input: all release notes in the range, newest first. Above `summary-max-input-chars` (24,000
characters, about 6k tokens, under the free tier's per-request limit) only their deploy sections are
sent; if those are still too long, there is no summary. The model runs at temperature 0 and is told
to use only facts from the notes, quote config keys exactly and cite the release for each action item.

Release notes are untrusted input, so the summary is advisory: the model has no tools, `@mentions`
and the action's markers are stripped from its answer, and nothing merges on its verdict. Mentions in
quoted release notes are defanged too, so upstream contributors aren't notified by these PRs.

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

## Development

The logic is in `index.js` (GitHub API, git, helm) and `lib.js` (pure functions). Run the tests
with `node --test 'actions/**/*.test.js'`.
