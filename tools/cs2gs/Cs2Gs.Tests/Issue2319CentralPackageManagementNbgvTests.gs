// <copyright file="Issue2319CentralPackageManagementNbgvTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// End-to-end regression coverage for issue #2319: a Central Package
/// Management (CPM) repository whose `Directory.Packages.props` pins a
/// below-floor `Nerdbank.GitVersioning` (nbgv) version used to fail
/// `--via-sdk` restore with NU1008, because the copied
/// `Directory.Packages.props` kept the original below-floor version while
/// (cref:SdkCompileRunner) independently emitted a bumped
/// `Version=` attribute on the generated nbgv `PackageReference` —
/// a combination CPM rejects outright. This exercises the real Translate +
/// Compile (`--via-sdk`) stages together and, when a locally-built
/// `Gsharp.NET.Sdk` nupkg is available, runs a real `dotnet build` to
/// prove the fix, not just the generated XML shape.
open class Issue2319CentralPackageManagementNbgvTests {
    @Fact
    async func Pipeline_CpmNbgvFixture_BumpsCopiedPropsAndOmitsVersionOnGeneratedPackageReference() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            // Gated like every other live --via-sdk e2e test in this suite:
            // build GSharp.sln (and pack the SDK) first.
            return
        }
        // Mirrors the reported repro: a repo-root Directory.Packages.props
        // that actually enables CPM and pins a below-floor literal nbgv
        // version, with the consumer-side versionless PackageReference
        // declared in a nested Directory.Build.props (Oahu's own layout).
        let sourceRoot = NewScratchDir("issue2319-cpm-nbgv")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Packages.props"), `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Nerdbank.GitVersioning" Version="3.7.115" />
  </ItemGroup>
</Project>`)
        let srcDir = Path.Combine(sourceRoot, "src")
        Directory.CreateDirectory(srcDir)
        File.WriteAllText(Path.Combine(srcDir, "Directory.Build.props"), `<Project>
  <ItemGroup>
    <PackageReference Include="Nerdbank.GitVersioning" PrivateAssets="all" />
  </ItemGroup>
</Project>`)
        let projectDir = Path.Combine(srcDir, "Sample")
        Directory.CreateDirectory(projectDir)
        let projectPath = Path.Combine(projectDir, "Sample.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <RootNamespace>Sample.App</RootNamespace>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(
            Path.Combine(projectDir, "Program.cs"),
            "public class Program { public static void Main() { } }"
        )
        let outputRoot = NewOutputRoot("issue2319-cpm-nbgv")
        let app = CorpusApp("test/CpmNbgvApp", projectPath, TargetKind.Exe)
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let generatedProps = Path.Combine(appRunDir, "Directory.Packages.props")
        let generatedProjectXml = File.ReadAllText(
            Directory.GetFiles(appRunDir, "*.gsproj", SearchOption.TopDirectoryOnly).Single()
        )
        // Expected fix (1): the copied Directory.Packages.props — the file
        // actually consumed by the generated app — carries the bumped
        // version, not the inert nbgv-bump side channel.
        Assert.True(File.Exists(generatedProps), "Expected a copied Directory.Packages.props in the app run dir.")
        let propsText = File.ReadAllText(generatedProps)
        Assert.Contains("<PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" />", propsText)
        Assert.DoesNotContain("3.7.115", propsText)
        // Expected fix (2): the generated NBGV PackageReference carries no
        // Version= attribute — CPM supplies it exclusively via PackageVersion.
        Assert.Contains(
            "<PackageReference Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />",
            generatedProjectXml
        )
        Assert.DoesNotContain("<PackageReference Include=\"Nerdbank.GitVersioning\" Version=", generatedProjectXml)
        // Expected fix (3): the real dotnet build (via-sdk) actually succeeds —
        // before the fix this failed restore with NU1008.
        Assert.True(
            appResult.Succeeded,
            "Expected the --via-sdk build to succeed for the CPM+nbgv fixture. AppResult: " + string.Join(
                "; ",
                appResult.Stages.Select((s StageResult) -> s.Stage + "=" + s.Status)
            )
        )
    }

    shared {
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
