// <copyright file="Issue2319AppLocalNbgvPackageReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// End-to-end regression coverage for issue #2319's app-local follow-up: a
/// non-CPM project whose own `.csproj` declares `Nerdbank.GitVersioning`
/// directly with a literal below-floor `Version` (no ancestor
/// `Directory.Build.props`/`Directory.Packages.props` split) used to
/// keep that below-floor version, because the declared-item passthrough in
/// `SdkCompileRunner.BuildProjectXml` copies the app's own
/// `PackageReference` verbatim, and `SdkCompileRunner.Compile`'s
/// duplicate-avoidance filter (`declaredPackageIds`) then discards the
/// correctly-bumped entry (cref:TranslateStage.ExecuteAsync) separately
/// records on (cref:StageExecutionContext.BuildOnlyPackageReferences),
/// since the id is already "declared". This exercises the real Translate +
/// Compile (`--via-sdk`) stages together and, when a locally-built
/// `Gsharp.NET.Sdk` nupkg is available, runs a real `dotnet build` to
/// prove the fix, not just the generated XML shape.
open class Issue2319AppLocalNbgvPackageReferenceTests {
    @Fact
    async func Pipeline_AppLocalNbgvFixture_BumpsDeclaredPackageReferenceVersionWithoutDuplication() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            // Gated like every other live --via-sdk e2e test in this suite:
            // build GSharp.sln (and pack the SDK) first.
            return
        }
        // Non-CPM: no Directory.Packages.props/Directory.Build.props anywhere
        // in the ancestry — the app's own .csproj is the sole and complete
        // declaration, with a literal below-floor Version attribute.
        let sourceRoot = NewScratchDir("issue2319-applocal-nbgv")
        let projectDir = Path.Combine(sourceRoot, "src", "Sample")
        Directory.CreateDirectory(projectDir)
        let projectPath = Path.Combine(projectDir, "Sample.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <RootNamespace>Sample.App</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Nerdbank.GitVersioning" Version="3.7.115" PrivateAssets="all" />
  </ItemGroup>
</Project>`)
        File.WriteAllText(
            Path.Combine(projectDir, "Program.cs"),
            "public class Program { public static void Main() { } }"
        )
        let outputRoot = NewOutputRoot("issue2319-applocal-nbgv")
        let app = CorpusApp("test/AppLocalNbgvApp", projectPath, TargetKind.Exe)
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let generatedProjectXml = File.ReadAllText(
            Directory.GetFiles(appRunDir, "*.gsproj", SearchOption.TopDirectoryOnly).Single()
        )
        // Expected fix (1): the app's own declared PackageReference is bumped
        // in place — not left at the original below-floor literal.
        Assert.Contains(
            "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" PrivateAssets=\"all\" />",
            generatedProjectXml
        )
        Assert.DoesNotContain("3.7.115", generatedProjectXml)
        // Expected fix (2): no duplicate PackageReference for nbgv — the
        // separately-recorded BuildOnlyPackageReferences entry must still be
        // filtered out by SdkCompileRunner.Compile's declaredPackageIds check
        // now that the surviving declared copy already carries the fix.
        let occurrences = CountOccurrences(generatedProjectXml, "Include=\"Nerdbank.GitVersioning\"")
        Assert.Equal(1, occurrences)
        // Expected fix (3): the real dotnet build (via-sdk) actually succeeds.
        Assert.True(
            appResult.Succeeded,
            "Expected the --via-sdk build to succeed for the app-local nbgv fixture. AppResult: " + string.Join(
                "; ",
                appResult.Stages.Select((s StageResult) -> s.Stage + "=" + s.Status)
            )
        )
    }

    shared {
        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            var index = 0
            while (index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += needle.Length
            }
            return count
        }

        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func NewScratchDir(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "scratch-projects", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindSiblingTool(projectDirName string, dllName string) string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, projectDirName, dllName)
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
