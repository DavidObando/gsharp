#!/usr/bin/env bash
# Issue #4301 (ADR-0192 follow-on 3): `cs2gs migrate` on a small C# project
# that uses [GeneratedRegex], then a build of the migrated G# through the REAL
# packed Gsharp.NET.Sdk, and a run whose output must match the C# program's.
#
# The migrated project has no hand-written regex code: every [GeneratedRegex]
# method is a G# declaring part (`@GeneratedRegex(...) partial func F() Regex;`),
# and the SDK's gsgen runs the targeting pack's Regex generator to supply the
# implementing parts. The project covers:
#   - a simple pattern, a pattern with options and a match timeout, a
#     backtracking pattern, one that backtracks inside a loop (the generator's
#     `ref base.runstack!`, #4422), a const pattern with escapes and non-ASCII
#     text;
#   - culture-sensitive IgnoreCase (tr-TR), which the retired cached-Regex
#     rewrite reported as unsupported;
#   - an instance method, a second namespace, and a top-level-statements
#     program whose partial `Program` class declares a [GeneratedRegex]
#     method (the entry class is kept as a class, not hoisted, and its
#     private members become internal so the G# top-level statements reach
#     them).
#
# Work files go under $E2E_WORK_ROOT when set (default: a fresh mktemp dir).
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

echo "==> Building cs2gs and gsc (Release)"
dotnet build tools/cs2gs/Cs2Gs.Cli/Cs2Gs.Cli.csproj -c Release --nologo -v:q
dotnet build src/Compiler/Compiler.csproj -c Release --nologo -v:q

WORK_DIR="${E2E_WORK_ROOT:-$(mktemp -d)}"
mkdir -p "$WORK_DIR"
if [[ -z "${E2E_WORK_ROOT:-}" ]]; then
    trap 'rm -rf "$WORK_DIR"' EXIT
fi
SRC="$WORK_DIR/src"
OUT="$WORK_DIR/out"
ARTIFACTS="$WORK_DIR/artifacts"
rm -rf "$SRC" "$OUT" "$ARTIFACTS"
mkdir -p "$SRC/Regexes"

echo "==> Writing the C# project under $SRC"
cat > "$SRC/Regexes/Regexes.csproj" <<'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
  </PropertyGroup>
</Project>
EOF

cat > "$SRC/Regexes/Patterns.cs" <<'EOF'
using System.Text.RegularExpressions;

namespace Regexes;

public static partial class Patterns
{
    private const string Odd = "a\\d\"q\" é日";

    [GeneratedRegex(@"\d+")]
    private static partial Regex Digits();

    [GeneratedRegex(@"^(?<y>\d{4})-(?<m>\d{2})$", RegexOptions.IgnoreCase, matchTimeoutMilliseconds: 1000)]
    private static partial Regex IsoMonth();

    [GeneratedRegex(@"^(.*)(\d{3})$")]
    private static partial Regex LastThree();

    [GeneratedRegex("^i$", RegexOptions.IgnoreCase, "tr-TR")]
    private static partial Regex TurkishI();

    [GeneratedRegex(@"(foo|ba+r)+\w*?baz", RegexOptions.IgnoreCase)]
    private static partial Regex Loop();

    public static bool LoopMatches(string s) => Loop().IsMatch(s);

    [GeneratedRegex(Odd)]
    private static partial Regex OddPattern();

    public static string FirstNumber(string s) => Digits().Match(s).Value;

    public static string Month(string s)
    {
        Match m = IsoMonth().Match(s);
        return m.Success ? m.Groups["m"].Value : "none";
    }

    public static string Tail(string s)
    {
        Match m = LastThree().Match(s);
        return m.Success ? m.Groups[1].Value + "|" + m.Groups[2].Value : "none";
    }

    public static string Turkish() =>
        TurkishI().IsMatch("İ") + "/" + TurkishI().IsMatch("I");

    public static bool OddRoundTrips() => OddPattern().ToString() == Odd;

    public static double Timeout() => IsoMonth().MatchTimeout.TotalMilliseconds;
}
EOF

cat > "$SRC/Regexes/Words.cs" <<'EOF'
using System.Text.RegularExpressions;

namespace Regexes.Text;

public partial class Words
{
    [GeneratedRegex(@"\b\w+\b")]
    public partial Regex Word();

    public int Count(string s) => Word().Count(s);
}
EOF

cat > "$SRC/Regexes/Program.cs" <<'EOF'
using System;
using System.Text.RegularExpressions;
using Regexes;
using Regexes.Text;

Console.WriteLine("first number: " + Patterns.FirstNumber("abc 42 7"));
Console.WriteLine("month: " + Patterns.Month("2024-05"));
Console.WriteLine("no month: " + Patterns.Month("May 2024"));
Console.WriteLine("tail: " + Patterns.Tail("abc12345"));
Console.WriteLine("turkish: " + Patterns.Turkish());
Console.WriteLine("loop: " + Patterns.LoopMatches("xxFOObaarQQbaz") + "/" + Patterns.LoopMatches("baz"));
Console.WriteLine("odd: " + Patterns.OddRoundTrips());
Console.WriteLine("timeout: " + Patterns.Timeout());
Console.WriteLine("words: " + new Words().Count("one two  three"));
Console.WriteLine("hex: " + Hex().IsMatch("c0ffee"));
Console.WriteLine("describe: " + Describe("zz"));

internal static partial class Program
{
    [GeneratedRegex("^[0-9a-f]+$")]
    private static partial Regex Hex();

    private static string Describe(string s) => Hex().IsMatch(s) ? "hex" : "not hex";
}
EOF

(
    cd "$SRC"
    git init -q
    git add -A
    git -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m "C# source"
)

echo "==> Running the C# program for the expected output"
EXPECTED=$(dotnet run --project "$SRC/Regexes/Regexes.csproj" --nologo)
echo "$EXPECTED"

echo "==> cs2gs migrate"
dotnet out/bin/Release/Cs2Gs.Cli/cs2gs.dll migrate \
    --corpus "$SRC" \
    --out "$OUT" \
    --artifacts "$ARTIFACTS" \
    --config Release

MIGRATED="$OUT/Regexes"
echo "----- migrated Patterns.gs -----"
cat "$MIGRATED/Patterns.gs"
echo "----- migrated Program.gs -----"
cat "$MIGRATED/Program.gs"

if grep -rq "__generatedRegex_" "$MIGRATED"; then
    echo "FAIL: the migrated source still carries a __generatedRegex_ cache field."
    exit 1
fi
for decl in \
    "private partial func Digits() Regex;" \
    "private partial func TurkishI() Regex;" \
    "partial func Word() Regex;" \
    "internal partial func Hex() Regex;"; do
    if ! grep -rqF "$decl" "$MIGRATED"; then
        echo "FAIL: expected the declaring part '$decl' in the migrated source."
        exit 1
    fi
done
if ! grep -qF 'RegexOptions.IgnoreCase, "tr-TR")' "$MIGRATED/Patterns.gs"; then
    echo "FAIL: the culture argument did not survive migration."
    exit 1
fi

echo "==> Building the migrated project through the packed SDK"
GSPROJ=$(ls "$MIGRATED"/*.gsproj | head -1)
cat > "$MIGRATED/global.json" <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF
cat > "$MIGRATED/NuGet.config" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
    <packageSources>
        <clear />
        <add key="NuGet official package source" value="https://api.nuget.org/v3/index.json" />
        <add key="Gsharp local packages" value="$ROOT/.nugs" />
    </packageSources>
</configuration>
EOF
rm -rf "$MIGRATED/bin" "$MIGRATED/obj"
BUILD_LOG=$(cd "$MIGRATED" && dotnet build "$(basename "$GSPROJ")" --nologo 2>&1) || {
    echo "$BUILD_LOG"
    echo "FAIL: the migrated project did not build."
    exit 1
}
echo "$BUILD_LOG" | tail -5
if echo "$BUILD_LOG" | grep -Eq "(warning|error) GS[0-9]+"; then
    echo "FAIL: the migrated project must build with no G# diagnostics:"
    echo "$BUILD_LOG" | grep -E "(warning|error) GS[0-9]+" | sort -u
    exit 1
fi

if ! ls "$MIGRATED"/obj/Debug/net10.0/gsgen/RegexGenerator*.g.gs >/dev/null 2>&1; then
    echo "FAIL: gsgen did not run the Regex generator for the migrated project."
    ls -1 "$MIGRATED/obj/Debug/net10.0/gsgen" 2>/dev/null || true
    exit 1
fi

DLL="$MIGRATED/bin/Debug/net10.0/$(basename "${GSPROJ%.gsproj}").dll"
echo "==> Running $DLL"
ACTUAL=$(dotnet "$DLL")
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "FAIL: the migrated program's output differs from the C# program's."
    echo "----- expected (C#) -----"
    echo "$EXPECTED"
    echo "----- actual (G#) -----"
    echo "$ACTUAL"
    exit 1
fi
echo "PASS: cs2gs migrated [GeneratedRegex] to G# declaring parts; the packed SDK built them through gsgen and the program matched C#."
