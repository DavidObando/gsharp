#!/usr/bin/env bash
# ADR-0198 integrated certification: migrate this repository C# -> G#, then run
# the isolated stage-2 controller over the migrated tree and verify that it
# produced a real `certified: true` report.
#
#   1. cs2gs migrates the repository (compile + `!!` polish, no test parity).
#   2. The migrated tree is committed to a throwaway Git repository, because
#      the controller freezes its input from Git objects.
#   3. The stage-0 Gsharp.NET.Sdk package is the one built from this checkout.
#   4. build/selfhost-stage2.py packs stage 1, rebuilds the tree with it
#      (stage 2), compares GSharp.Core.dll and gsc.dll, and runs the test
#      selections under stage 2 inside the sandbox.
#   5. build/verify-stage2-report.py rejects any report that is not a genuine
#      certification.
#
# Usage: build/run-selfhost-stage2-certification.sh <work-root>
#        (the work root must not exist; keep it off tmpfs, e.g. ~/.cache/<tag>)
# Environment:
#   STAGE2_COMMAND_TIMEOUT  per-command timeout in seconds (default 7200)
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=${1:?usage: $0 <new-work-root>}
if [[ -e "$work" ]]; then
  echo "refusing to reuse an existing work root: $work" >&2
  exit 2
fi
mkdir -p "$work"
work=$(cd "$work" && pwd -P)
export TMPDIR="$work/tmp"
mkdir -p "$TMPDIR"

# shellcheck source=build/selfmig-common.sh
source "$repo_root/build/selfmig-common.sh"

cd "$repo_root"
dotnet restore GSharp.sln
selfmig_build_prerequisites
dotnet build tools/cs2gs/Cs2Gs.Cli/Cs2Gs.Cli.csproj -c Release

dotnet out/bin/Release/Cs2Gs.Cli/cs2gs.dll migrate \
  --corpus "$repo_root" --sdk-pin global-json \
  --out "$work/migrated" --artifacts "$work/runs" --config Release \
  "${selfmig_project_filters[@]}" | tee "$work/migrate.log"

git -C "$work/migrated" init -q
git -C "$work/migrated" add -A
git -C "$work/migrated" -c user.name=stage2 -c user.email=stage2@example.invalid \
  commit -q -m "migrated tree"

mkdir -p "$work/bootstrap"
cp out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg "$work/bootstrap/"
bootstrap=$(find "$work/bootstrap" -name 'Gsharp.NET.Sdk.*.nupkg' ! -name '*.snupkg' | head -1)

python3 build/selfhost-stage2.py \
  --tree "$work/migrated" --bootstrap "$bootstrap" --work "$work/controller" \
  --command-timeout "${STAGE2_COMMAND_TIMEOUT:-7200}" \
  --project src/Core/Core.gsproj --project src/Compiler/Compiler.gsproj \
  --assembly Core/GSharp.Core.dll --assembly Compiler/gsc.dll \
  --test "test/Core.Tests/Core.Tests.gsproj::$(python3 build/selfhost/stage2-test-filter.py Core.Tests)" \
  --test "test/Compiler.Tests/Compiler.Tests.gsproj::$(python3 build/selfhost/stage2-test-filter.py Compiler.Tests)" \
  --test-env GSHARP_SKIP_ILVERIFY=1 \
  --test-adapter-sha256 c5ac41b36fac0fcef9714fb80fea0175913530fb53dd7bb8e5e1470339667100 \
  --test-adapter-sha256 194458c816e0ea9ff0c5eac8896c52133fe9205661833b3d0f57e85a4e66936b \
  --test-adapter-sha256 ec705ad62e33f31fc46ad5800c9b1694c02d0ec4e1ee704712da9f24ebbea22e \
  --test-adapter-sha256 3166dc70323fb30ccf1cedb0fe86f2ad122c46d254542342d90386efc4c9285c

python3 build/verify-stage2-report.py "$work/controller/reports/stage2-report.json" \
  --assembly Core/GSharp.Core.dll --assembly Compiler/gsc.dll --tests 2
