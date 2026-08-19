#!/usr/bin/env bash
# ADR-0169: validates the G# analyzer pipeline end-to-end through MSBuild —
# a C#-authored G# analyzer assembly (referencing GSharp.Core) is handed to a
# .gsproj build via @(GsharpCodeAnalyzer), the SDK forwards it to gsc as
# /gsanalyzer:, the analyzer's warning surfaces as an MSBuild warning through
# BuildTask's stdout relogging, and NoWarn silences it.
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gsanalyzer-e2e.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "==> Building the sample analyzer assembly (references GSharp.Core)"
mkdir -p "$WORK/analyzer"
cat > "$WORK/analyzer/SampleAnalyzer.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <RunAnalyzers>false</RunAnalyzers>
    <GenerateDocumentationFile>false</GenerateDocumentationFile>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="$ROOT/src/Core/Core.csproj" />
  </ItemGroup>
</Project>
EOF
cat > "$WORK/analyzer/SampleAnalyzer.cs" <<'EOF'
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using GSharp.Core.CodeAnalysis.Syntax;

namespace Sample;

[GSharpDiagnosticAnalyzer]
public sealed class CallReporter : GSharpDiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTGSA01", "Call probe", "Sample analyzer saw a call expression.",
        "Testing", DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(
            ctx => ctx.ReportDiagnostic(Diagnostic.Create(Rule, ctx.Node.Location)),
            SyntaxKind.CallExpression);
    }
}
EOF
dotnet build "$WORK/analyzer/SampleAnalyzer.csproj" --nologo -v:q
ANALYZER_DLL=$(find "$WORK/analyzer" "$ROOT/out/bin" -name SampleAnalyzer.dll -path "*Debug*" -not -path "*/ref/*" -not -path "*/refint/*" 2>/dev/null | grep "/bin/" | head -1)
if [[ -z "$ANALYZER_DLL" ]]; then
    echo "FAIL: SampleAnalyzer.dll not found after build."
    exit 1
fi
echo "    analyzer: $ANALYZER_DLL"

echo "==> Creating the consumer .gsproj pinned to Gsharp.NET.Sdk $VER"
mkdir -p "$WORK/app"
cat > "$WORK/app/global.json" <<EOF
{
  "msbuild-sdks": {
    "Gsharp.NET.Sdk": "$VER"
  }
}
EOF
cat > "$WORK/app/nuget.config" <<EOF
<configuration>
  <packageSources>
    <add key="local-gsharp" value="$ROOT/.nugs" />
  </packageSources>
</configuration>
EOF
cat > "$WORK/app/App.gsproj" <<EOF
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <GsharpCodeAnalyzer Include="$ANALYZER_DLL" />
  </ItemGroup>
</Project>
EOF
cat > "$WORK/app/main.gs" <<'EOF'
package app
import System

func Greet() {
    Console.WriteLine("hi")
}

func Main() {
    Greet()
}
EOF

# Force NuGet to re-extract the (same-versioned) SDK so target edits take effect.
rm -rf "$HOME/.nuget/packages/gsharp.net.sdk/$VER" || true

echo "==> dotnet build (expecting TESTGSA01 warnings)"
BUILD_LOG="$WORK/build.log"
(cd "$WORK/app" && dotnet build App.gsproj --nologo) | tee "$BUILD_LOG"

if ! grep -q "TESTGSA01" "$BUILD_LOG"; then
    echo "FAIL: analyzer warning TESTGSA01 did not surface through MSBuild."
    exit 1
fi

echo "==> dotnet build with NoWarn=TESTGSA01 (expecting silence)"
rm -rf "$WORK/app/bin" "$WORK/app/obj"
SILENT_LOG="$WORK/silent.log"
(cd "$WORK/app" && dotnet build App.gsproj --nologo -p:NoWarn=TESTGSA01) | tee "$SILENT_LOG"

if grep -q "TESTGSA01" "$SILENT_LOG"; then
    echo "FAIL: NoWarn=TESTGSA01 did not silence the analyzer warning."
    exit 1
fi

echo "PASS: gsanalyzer e2e"
