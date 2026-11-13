#!/usr/bin/env bash
# Tests vars.sh for the refs a pull request build can't produce: releases, the default branch and public repositories.
set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)"
failed=0

# run <name> <expected exit code> <expected output lines, "" to skip> [ENV=value...]
run() {
  local name="$1" want_code="$2" want="$3"
  shift 3
  local out code=0
  out="$(mktemp)"
  env -i PATH="$PATH" GITHUB_OUTPUT="$out" GITHUB_REPOSITORY="Pinax-Network/Some.Repo" \
    GITHUB_REPOSITORY_OWNER="Pinax-Network" GITHUB_SHA="0123456789abcdef" DEFAULT_BRANCH="main" \
    REPOSITORY_PRIVATE="true" "$@" bash "$dir/vars.sh" > /dev/null || code=$?
  # the timestamp is the only part that changes between runs
  local got
  got="$(sed -E 's/:0123456-[0-9]+/:0123456-TS/' "$out")"
  if [[ "$code" != "$want_code" ]]; then
    echo "FAIL $name: exit code $code, want $want_code"
    failed=1
  elif [[ -n "$want" && "$got" != "$want" ]]; then
    echo "FAIL $name"
    diff <(echo "$want") <(echo "$got") || true
    failed=1
  else
    echo "ok   $name"
  fi
}

image="ghcr.io/pinax-network/some.repo"

run "release tag" 0 "image=$image
version=v1.4.2
commit=0123456
cache-scope=some.repo
cache-mode=max
tags<<EOF_TAGS
$image:v1.4.2
EOF_TAGS" GITHUB_REF=refs/tags/v1.4.2 GITHUB_REF_NAME=v1.4.2

run "release tag with build metadata and suffix" 0 "image=$image
version=v1.4.2+build.1
commit=0123456
cache-scope=some.repo-debian
cache-mode=max
tags<<EOF_TAGS
$image:v1.4.2-build.1-debian
EOF_TAGS" GITHUB_REF=refs/tags/v1.4.2+build.1 GITHUB_REF_NAME=v1.4.2+build.1 TAG_SUFFIX=-debian

run "default branch" 0 "image=$image
version=develop
commit=0123456
cache-scope=some.repo
cache-mode=max
tags<<EOF_TAGS
$image:0123456-TS
$image:develop
EOF_TAGS" GITHUB_REF=refs/heads/main GITHUB_REF_NAME=main

run "other branch with image name" 0 "image=ghcr.io/pinax-network/other
version=develop
commit=0123456
cache-scope=other
cache-mode=max
tags<<EOF_TAGS
ghcr.io/pinax-network/other:0123456-TS
EOF_TAGS" GITHUB_REF=refs/heads/test/main GITHUB_REF_NAME=test/main IMAGE_NAME=Other

run "public repository with ssh key" 0 "image=$image
version=develop
commit=0123456
cache-scope=some.repo
cache-mode=min
tags<<EOF_TAGS
$image:0123456-TS
EOF_TAGS" GITHUB_REF=refs/pull/1/merge GITHUB_REF_NAME=1/merge REPOSITORY_PRIVATE=false HAS_SSH_KEY=true

run "public repository without ssh key" 0 "" GITHUB_REF=refs/heads/main GITHUB_REF_NAME=main REPOSITORY_PRIVATE=false
grep -q "cache-mode=max" <<< "$(REPOSITORY_PRIVATE=false HAS_SSH_KEY=false GITHUB_OUTPUT=/dev/stdout GITHUB_REPOSITORY=a/b \
  GITHUB_REPOSITORY_OWNER=a GITHUB_SHA=0123456789 GITHUB_REF=refs/heads/x GITHUB_REF_NAME=x bash "$dir/vars.sh")" \
  || { echo "FAIL public repository without ssh key must cache with mode=max"; failed=1; }

run "image name with owner" 1 "" GITHUB_REF=refs/heads/main GITHUB_REF_NAME=main IMAGE_NAME=pinax-network/other
run "invalid tag" 1 "" GITHUB_REF=refs/tags/v1/2 GITHUB_REF_NAME=v1/2
run "repository name that is not an image name" 1 "" GITHUB_REF=refs/heads/main GITHUB_REF_NAME=main GITHUB_REPOSITORY=pinax-network/.github

exit "$failed"
