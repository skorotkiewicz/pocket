# https://github.com/casey/just
set positional-arguments

[private]
default:
    @just --list

# Build the single ./pocket executable, including the TUI and SSH server.
build:
    cargo build --release --all-features --manifest-path server/Cargo.toml
    bun run build

# Run from source with the Rust SSH server and tmux.
run *args:
    bun run start "$@"

# Run only the TUI from source.
dev *args:
    bun run dev "$@"

# Run the built executable.
run-bin *args:
    ./pocket "$@"

fmt:
    cargo fmt --manifest-path server/Cargo.toml

check:
    bun run check
    cargo fmt --manifest-path server/Cargo.toml -- --check
    cargo clippy --locked --manifest-path server/Cargo.toml --all-targets -- -D warnings

test: check
    bun run test
    bun run server:test

ssh-test:
    bun run ssh:test

binary-test:
    bun run binary:test

# Check source mode, packaged mode and the embedded Rust feature.
test-all: test ssh-test binary-test
    POCKET_TUI_BINARY="$(pwd)/server/target/pocket-tui" cargo test --locked --manifest-path server/Cargo.toml --all-targets --all-features
    POCKET_TUI_BINARY="$(pwd)/server/target/pocket-tui" cargo clippy --locked --manifest-path server/Cargo.toml --all-targets --all-features -- -D warnings

install-hook:
    @printf '#!/bin/sh\nset -e\njust check\n' > .git/hooks/pre-commit
    @chmod +x .git/hooks/pre-commit

remove-hook:
    @rm .git/hooks/pre-commit

add-tag:
    #!/usr/bin/env bash
    set -euo pipefail
    VERSION=$(grep '^version' server/Cargo.toml | head -1 | cut -d'"' -f2)
    git push origin main
    git tag -a "v${VERSION}" -m "Release v${VERSION}"
    git push origin "v${VERSION}"

# `just remove-tag v0.0.0` or `just remove-tag` (uses fzf)
remove-tag VERSION="":
    #!/usr/bin/env bash
    set -euo pipefail
    tag="$1"
    [ -z "$tag" ] && tag=$(git tag | sort -V | fzf --prompt="Select tag to remove: ")
    [ -z "$tag" ] && echo "No tag selected" && exit 1
    git tag -d "$tag"
    git push --delete origin "$tag"

# Undo last commit locally and on remote, keeping changes staged.
undo-commit:
    #!/usr/bin/env bash
    set -euo pipefail

    upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}')
    remote="${upstream%%/*}"
    branch="${upstream#*/}"

    git reset --soft HEAD~1
    git push --force-with-lease "$remote" "HEAD:$branch"
