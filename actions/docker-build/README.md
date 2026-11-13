# docker-build

Composite action that builds a Docker image and pushes it to `ghcr.io/<owner>/<repository>`. It replaces the
`build:docker` Taskfile targets and the hand-written `docker.yml` workflows, so every repository tags and versions
its images the same way.

The build happens inside the Dockerfile (multi-stage), the action does not install a toolchain. That keeps it
independent of the language and makes `docker build .` work the same locally and in CI.

## Usage

```yaml
# .github/workflows/docker.yaml
name: Docker
on:
  push:
    branches: [main]
    tags: ["v*"]
  workflow_dispatch:
jobs:
  docker:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v7
      - uses: pinax-network/.github/actions/docker-build@main
        with:
          # only needed when the build fetches private dependencies
          ssh-key: ${{ secrets.SSH_EOSN_DEPLOY_KEY }}
```

To also verify the image on pull requests, add `pull_request:` to the triggers and pass
`push: ${{ github.event_name != 'pull_request' }}`.

| Input | Default | |
|---|---|---|
| `image-name` | repository name | Image name without registry and owner. Only set it if the image is named differently than the repository. |
| `context` | `.` | Build context. |
| `file` | `<context>/Dockerfile` | Path to the Dockerfile. |
| `target` | last stage | Stage of the Dockerfile to build. |
| `tag-suffix` | | Appended to every tag, for variants built from another target (e.g. `-debian`). |
| `build-args` | | Additional build arguments, one `KEY=VALUE` per line. `VERSION` and `COMMIT` can't be overridden. |
| `ssh-key` | | Private SSH key forwarded to the build to fetch private dependencies. |
| `platforms` | `linux/amd64` | Comma separated list of target platforms. |
| `push` | `true` | Set to `false` to only verify that the image builds. |

Outputs: `image`, `version`, `commit`, `tags` (one image reference per line), `digest`.

The registry and owner are fixed: images always go to `ghcr.io/<owner>` of the calling repository, authenticated
with the workflow token. The calling job needs `packages: write` (`packages: read` is enough with `push: false`).

## Tags and version

| Trigger | Image tags | `VERSION` | `COMMIT` |
|---|---|---|---|
| Git tag `v1.4.2` | `v1.4.2` | `v1.4.2` | short commit hash |
| Push to the default branch | `<commit>-<unix timestamp>`, `develop` | `develop` | short commit hash |
| Any other ref | `<commit>-<unix timestamp>` | `develop` | short commit hash |

`develop` is the only moving tag, there is no `latest` and no major version tag: deployments pin an exact version.

Docker tags can't contain `+`, so a git tag with SemVer build metadata such as `v1.4.2+build.1` is pushed as
`v1.4.2-build.1`. `VERSION` keeps the git tag as is.

`VERSION` and `COMMIT` are passed as build arguments on every build. Declare them in the Dockerfile and hand them
to the compiler, see the reference Dockerfile below.

## Variants

Build each target in its own matrix job and give all but the default one a suffix:

```yaml
    strategy:
      matrix:
        include:
          - target: distroless
            suffix: ""
          - target: debian
            suffix: -debian
    steps:
      - uses: actions/checkout@v7
      - uses: pinax-network/.github/actions/docker-build@main
        with:
          target: ${{ matrix.target }}
          tag-suffix: ${{ matrix.suffix }}
```

## Private dependencies

`SSH_EOSN_DEPLOY_KEY` is an organization secret that is available to every repository. The action loads it into
an SSH agent and forwards the agent to the build. The key is only reachable from `RUN --mount=type=ssh` steps and
never ends up in an image layer, unlike a token passed as a build argument.

## Cache

Layers are cached in the GitHub Actions cache, including the build stages. Those hold the sources of the private
dependencies, and the cache of a public repository can be read by pull requests from forks. A public repository
that passes `ssh-key` therefore only caches the final stage, which makes its builds slower.

## Reference Dockerfile for Go

```dockerfile
FROM golang:1.26-trixie AS build

WORKDIR /src

# Fetch private modules through the forwarded SSH agent.
ENV GOPRIVATE=github.com/pinax-network
RUN git config --global url."ssh://git@github.com/".insteadOf "https://github.com/" \
    && mkdir -p -m 0700 ~/.ssh \
    && ssh-keyscan github.com >> ~/.ssh/known_hosts

COPY go.mod go.sum ./
RUN --mount=type=ssh go mod download

COPY . .

ARG VERSION=develop
ARG COMMIT=unknown

ENV CGO_ENABLED=0
RUN go build \
    -ldflags "-X <module>/pkg/flags.version=${VERSION} -X <module>/pkg/flags.commit=${COMMIT}" \
    -o /out/app ./cmd/<name>

FROM gcr.io/distroless/static-debian13

COPY --from=build /out/app /app/<name>

ENTRYPOINT ["/app/<name>"]
```

Locally this builds with `docker build --ssh default .`.

Pick the runtime image by how the binary is linked:

| Build | Runtime image |
|---|---|
| `CGO_ENABLED=0` (default) | `gcr.io/distroless/static-debian13` |
| cgo | `gcr.io/distroless/base-debian13`, or `cc-debian13` if it links libstdc++ |
| needs a shell or tools | `debian:trixie-slim` with `ca-certificates` and `tzdata` installed |

For cgo builds the builder and the runtime image must be the same Debian release (`trixie` and `debian13`), so the
binary finds the glibc it was linked against. The distroless images ship CA certificates and time zone data.
