#!/usr/bin/env bash
# ADR-0192 follow-on 2 (step 4): `@GeneratedRegex` on a G# partial method,
# built through the REAL packed Gsharp.NET.Sdk and run. Unlike gsgen-e2e.sh
# (which only proves the SDK ran the MVVM generator), this build must go fully
# GREEN and the app's output must match exactly:
#   - the targeting-pack System.Text.RegularExpressions.Generator runs via
#     gsgen, and its generated implementation is back-translated as a G#
#     implementing part that gsc pairs with the user's declaring part;
#   - a pattern with options and a backtracking pattern run through the
#     generated Regex subclass;
#   - KNOWN GAP: a pattern whose backtracking runs inside a loop makes the
#     generator pass `ref base.runstack!` (a nullable-annotated field of the
#     reference pack) to a `ref int[]` helper. G# has no spelling for that
#     `!`: cs2gs emits `&base.runstack`, which gsc rejects with GS0154. That
#     case is built separately and must fail with exactly that error, so the
#     script fails loudly once the gap closes;
#   - the generator's `file` helper types keep their own package, so a user
#     type named `Utilities` does not collide with them, and a second user
#     package shares the same helpers;
#   - a declaring part spelled differently from the back-translated C#
#     (a fully qualified return type) still pairs: gsgen copies its header.
# A second, throwaway project does the same for Microsoft.Extensions.Logging's
# `@LoggerMessage` with a parameter spelled `int` (the generated C# `int`
# back-translates to `int32`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Packing Gsharp.NET.Sdk into .nugs/"
dotnet build src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.csproj -c Release --nologo -v:q
mkdir -p .nugs
cp out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg .nugs/

NUPKG=$(ls -t out/bin/Release/nupkgs/Gsharp.NET.Sdk.*.nupkg | head -1)
VER="${NUPKG##*Gsharp.NET.Sdk.}"
VER="${VER%.nupkg}"

# Force NuGet to re-extract the (same-versioned) SDK so target edits take effect.
rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

echo "==> Pinning samples/GeneratedRegex/global.json to Gsharp.NET.Sdk $VER"
cat > samples/GeneratedRegex/global.json <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF

echo "==> dotnet build samples/GeneratedRegex/GeneratedRegex.gsproj"
rm -rf samples/GeneratedRegex/bin samples/GeneratedRegex/obj
dotnet build samples/GeneratedRegex/GeneratedRegex.gsproj --nologo

GSGEN_DIR="samples/GeneratedRegex/obj/Debug/net10.0/gsgen"
USER_PART="$GSGEN_DIR/RegexGenerator.g.gs"
HELPERS="$GSGEN_DIR/RegexGenerator.System_Text_RegularExpressions_Generated.g.gs"
for f in "$USER_PART" "$HELPERS"; do
    if [[ ! -f "$f" ]]; then
        echo "FAIL: gsgen did not produce $f"
        ls -1 "$GSGEN_DIR" 2>/dev/null || true
        exit 1
    fi
done
echo "----- $(basename "$USER_PART") -----"
cat "$USER_PART"

if ! grep -q "^package System.Text.RegularExpressions.Generated" "$HELPERS"; then
    echo "FAIL: the generator's helper types are not in their own package."
    exit 1
fi
if grep -q "class Utilities" "$USER_PART"; then
    echo "FAIL: the generator's Utilities helper leaked into the user's package."
    exit 1
fi
if ! grep -q "partial func Digits() System.Text.RegularExpressions.Regex ->" "$USER_PART"; then
    echo "FAIL: the implementing part was not spelled with the declaring part's header."
    exit 1
fi

OUT="samples/GeneratedRegex/bin/Debug/net10.0/GeneratedRegex.dll"
echo "==> Running $OUT"
ACTUAL=$(dotnet "$OUT")
EXPECTED='month: 05
no month: none
tail: abc12|345
no tail: none
first number: 42
words: 3
utilities: user Utilities
implementation: System.Text.RegularExpressions.Generated'
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "FAIL: unexpected output."
    echo "----- expected -----"
    echo "$EXPECTED"
    echo "----- actual -----"
    echo "$ACTUAL"
    exit 1
fi
echo "PASS: @GeneratedRegex built through the packed SDK and ran through the generated Regex subclass."

# Scaffolds a throwaway project directory pinned to the packed SDK.
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
scaffold() {
    local dir="$WORK_DIR/$1"
    mkdir -p "$dir"
    cat > "$dir/global.json" <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF
    cat > "$dir/NuGet.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
    <packageSources>
        <clear />
        <add key="NuGet official package source" value="https://api.nuget.org/v3/index.json" />
        <add key="Gsharp local packages" value="$ROOT/.nugs" />
    </packageSources>
</configuration>
EOF
    echo "$dir"
}

echo "==> @LoggerMessage with a differently spelled parameter type"
LOG_DIR=$(scaffold logging)
cat > "$LOG_DIR/Logging.gsproj" <<'EOF'
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>Logging</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Logging" Version="10.0.1" />
  </ItemGroup>
</Project>
EOF
cat > "$LOG_DIR/Program.gs" <<'EOF'
package Logging

import System
import Microsoft.Extensions.Logging

partial class Log {
    shared {
        @LoggerMessage(EventId: 1, Level: LogLevel.Information, Message: "Processed {count} items")
        public partial func Processed(logger ILogger, count int);
    }
}

let factory = LoggerFactory.Create(func(b ILoggingBuilder) { })
Log.Processed(factory.CreateLogger("e2e"), 3)
Console.WriteLine("logged")
EOF
(cd "$LOG_DIR" && dotnet build Logging.gsproj --nologo)
if ! grep -q "partial func Processed(logger ILogger, count int)" "$LOG_DIR/obj/Debug/net10.0/gsgen/LoggerMessage.g.gs"; then
    echo "FAIL: the @LoggerMessage implementing part was not spelled with the declaring part's header."
    cat "$LOG_DIR/obj/Debug/net10.0/gsgen/LoggerMessage.g.gs"
    exit 1
fi
LOG_ACTUAL=$(dotnet "$LOG_DIR/bin/Debug/net10.0/Logging.dll")
if [[ "$LOG_ACTUAL" != "logged" ]]; then
    echo "FAIL: expected 'logged', got '$LOG_ACTUAL'"
    exit 1
fi
echo "PASS: @LoggerMessage with a 'count int' declaring part paired and ran."

echo "==> KNOWN GAP: backtracking inside a loop (ref base.runstack!)"
GAP_DIR=$(scaffold runstack)
cat > "$GAP_DIR/Gap.gsproj" <<'EOF'
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace>Gap</RootNamespace>
  </PropertyGroup>
</Project>
EOF
cat > "$GAP_DIR/Program.gs" <<'EOF'
package Gap

import System
import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex("(foo|ba+r)+\\w*?baz", RegexOptions.IgnoreCase)
        private partial func Loop() Regex;

        public func Test(s string) bool {
            return Loop().IsMatch(s)
        }
    }
}

Console.WriteLine(P.Test("xxFOObaarQQbaz").ToString())
EOF
set +e
GAP_LOG=$(cd "$GAP_DIR" && dotnet build Gap.gsproj --nologo 2>&1)
GAP_RC=$?
set -e
if [[ "$GAP_RC" == "0" ]]; then
    echo "FAIL: the known runstack gap no longer reproduces: the backtracking-loop pattern now builds."
    echo "      Move this case into samples/GeneratedRegex and delete this block."
    exit 1
fi
GAP_ERRORS=$(echo "$GAP_LOG" | grep "error GS" | sed -E 's/^.*(error GS[0-9]+: .*) \[[^]]*\]$/\1/' | sort -u)
EXPECTED_GAP="error GS0154: Parameter 'stack' requires a value of type '[]int32' but was given a value of type '*[]?int32'."
if [[ "$GAP_ERRORS" != "$EXPECTED_GAP" ]] \
    || ! grep -q "StackPush(&base.runstack," "$GAP_DIR/obj/Debug/net10.0/gsgen/RegexGenerator.System_Text_RegularExpressions_Generated.g.gs"; then
    echo "FAIL: the backtracking-loop pattern failed differently from the known runstack gap:"
    echo "$GAP_ERRORS"
    exit 1
fi
echo "KNOWN GAP (unchanged): GS0154 at StackPush(&base.runstack, ...) in the generated helpers."
