#!/usr/bin/env bash
# Builds every program variant used by tests and deploys.
#   target/deploy/landed.so                 devnet build (fault-lab)     -> deployed
#   target/sbf-variants/landed_test.so      fault-lab + short-timers     -> MagicSVM tests
#   target/sbf-variants/landed_mainnet.so   no features (A24)            -> MagicSVM tests
#   target/deploy/naive_cashout.so          baseline
#   target/idl/*.json                       IDLs
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
mkdir -p target/sbf-variants
cargo build-sbf --manifest-path programs/landed/Cargo.toml --features fault-lab,short-timers,sim-committor-drop
cp target/deploy/landed.so target/sbf-variants/landed_test.so
cargo build-sbf --manifest-path programs/landed/Cargo.toml --features fault-lab,short-timers
cp target/deploy/landed.so target/sbf-variants/landed_test_stuck.so
cargo build-sbf --manifest-path programs/landed/Cargo.toml
cp target/deploy/landed.so target/sbf-variants/landed_mainnet.so
# Final: devnet build of both programs + IDLs
anchor build --ignore-keys -- --features fault-lab
ls -la target/deploy/*.so target/sbf-variants/*.so target/idl/
