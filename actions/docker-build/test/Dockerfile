# Fixture for .github/workflows/test-docker-build.yaml, it fails the build if the action passes the wrong arguments.
FROM alpine:3.22 AS base

ARG VERSION
ARG COMMIT
ARG EXTRA

RUN test "$VERSION" = "develop" \
    && test "${#COMMIT}" -eq 7 \
    && test "$EXTRA" = "passed"

# Requires the forwarded SSH agent to hold a key.
FROM base AS ssh

RUN apk add --no-cache openssh-client
RUN --mount=type=ssh,required=true ssh-add -l

FROM base AS plain
