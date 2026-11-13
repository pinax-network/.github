#!/usr/bin/env bash
# Determines the image name, the version and the image tags of a build and writes them to $GITHUB_OUTPUT.
#
# Reads GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER, GITHUB_REF, GITHUB_REF_NAME and GITHUB_SHA, plus:
#   IMAGE_NAME          image name override, defaults to the repository name
#   TAG_SUFFIX          suffix appended to every tag
#   DEFAULT_BRANCH      default branch of the repository, the only one moving the develop tag
#   HAS_SSH_KEY         "true" if an SSH key is forwarded to the build
#   REPOSITORY_PRIVATE  "true" if the repository is private or internal
set -euo pipefail

name="${IMAGE_NAME:-${GITHUB_REPOSITORY#*/}}"
name="${name,,}"
if [[ ! "$name" =~ ^[a-z0-9]+([._-]+[a-z0-9]+)*$ ]]; then
  echo "::error::'$name' is not a valid image name. Set image-name to the name only, without registry and owner."
  exit 1
fi
image="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/$name"
commit="${GITHUB_SHA::7}"

# Tagged commits are releases and only get their immutable version tag. Everything else gets a unique
# <commit>-<timestamp> tag, and the default branch additionally moves the develop tag.
image_tags=()
if [[ "$GITHUB_REF" == refs/tags/* ]]; then
  version="$GITHUB_REF_NAME"
  # Docker tags can't contain the "+" of SemVer build metadata, VERSION keeps the git tag as is.
  image_tags+=("${version//+/-}${TAG_SUFFIX:-}")
else
  version="develop"
  image_tags+=("$commit-$(date +%s)${TAG_SUFFIX:-}")
  if [[ -n "${DEFAULT_BRANCH:-}" && "$GITHUB_REF" == "refs/heads/$DEFAULT_BRANCH" ]]; then
    image_tags+=("develop${TAG_SUFFIX:-}")
  fi
fi

tags=""
for tag in "${image_tags[@]}"; do
  if [[ ! "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    echo "::error::'$tag' is not a valid Docker tag."
    exit 1
  fi
  tags+="${tags:+$'\n'}$image:$tag"
done

# mode=max also caches the build stages, which hold the sources of private dependencies. The cache of a public
# repository can be read by pull requests from forks, so there only the final stage is cached.
cache_mode="max"
if [[ "${HAS_SSH_KEY:-}" == "true" && "${REPOSITORY_PRIVATE:-}" != "true" ]]; then
  cache_mode="min"
fi

{
  echo "image=$image"
  echo "version=$version"
  echo "commit=$commit"
  echo "cache-scope=$name${TAG_SUFFIX:-}"
  echo "cache-mode=$cache_mode"
  echo "tags<<EOF_TAGS"
  echo "$tags"
  echo "EOF_TAGS"
} >> "$GITHUB_OUTPUT"
