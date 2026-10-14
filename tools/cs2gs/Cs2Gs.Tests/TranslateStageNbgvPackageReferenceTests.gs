// <copyright file="TranslateStageNbgvPackageReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Cs2Gs.Pipeline
import Cs2Gs.Translator.Loading
import Xunit
import System.Xml.Linq

/// Stage-level tests for issue #2267: the isolated `--via-sdk` gsproj drops
/// `Nerdbank.GitVersioning` entirely because it is a build/dev-only
/// dependency (`PrivateAssets="all"`, no compile-time reference DLL), so
/// its `ThisAssembly` MSBuild source generator never runs. (cref:TranslateStage)
/// must recover the source project's nbgv declaration — even when, as in Oahu,
/// it is split by Central Package Management across a versionless
/// `<PackageReference>` in a shared `Directory.Build.props` and
/// the actual `<PackageVersion>` in `Directory.Packages.props` —
/// and publish it on (cref:StageExecutionContext.BuildOnlyPackageReferences)
/// so (cref:CompileStage)/(cref:SdkCompileRunner) can re-declare it.
open class TranslateStageNbgvPackageReferenceTests {
    @Fact
    async func TranslateStage_CpmSplitNbgvDeclaration_PublishesBumpedBuildOnlyPackageReference() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        // Mirrors Oahu's real layout: repo-root Directory.Packages.props pins a
        // below-floor literal nbgv version; a nested Directory.Build.props
        // declares the versionless, PrivateAssets="all" consumer-side reference.
        let repoDir = NewScratchDir("translate-nbgv-cpm")
        File.WriteAllText(Path.Combine(repoDir, "Directory.Packages.props"), `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Nerdbank.GitVersioning" Version="3.7.115" />
  </ItemGroup>
</Project>`)
        let srcDir = Path.Combine(repoDir, "src")
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
        let appRunDir = NewOutputRoot("translate-nbgv-cpm")
        let app = CorpusApp("test/NbgvCpmApp", projectPath, TargetKind.Exe)
        let options = PipelineOptions{GscPath: compiler}
        let gsc = GscInvoker(compiler)
        let triage = TriageBuilder("test-run", "2026-01-01T00:00:00Z", "0.0.0", app.Id)
        let context = StageExecutionContext(app, options, gsc, appRunDir, triage)
        let outcome = await TranslateStage().ExecuteAsync(context)
        Assert.Equal(StageStatus.Passed, outcome.Status)
        let nbgvReference = Assert.Single(context.BuildOnlyPackageReferences)
        Assert.Equal(NerdbankGitVersioningPolicy.PackageId, nbgvReference.Id)
        Assert.Equal(NerdbankGitVersioningPolicy.MinimumGSharpVersion, nbgvReference.Version)
        Assert.Equal("all", nbgvReference.PrivateAssets)
        // Issue #2319: the copied Directory.Packages.props — the file NuGet
        // actually restores the generated app against — must itself carry the
        // bumped version; a verbatim copy plus the previous inert
        // nbgv-bump/Directory.Packages.props left the below-floor version in
        // place for restore. The Translate stage must also record that CPM
        // governs this app so the Compile stage omits Version= from any
        // PackageReference it synthesizes.
        Assert.True(context.UsesCentralPackageManagement)
        let copiedProps = File.ReadAllText(Path.Combine(appRunDir, "Directory.Packages.props"))
        Assert.Contains("<PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" />", copiedProps)
        Assert.DoesNotContain("3.7.115", copiedProps)
    }

    @Fact
    async func TranslateStage_NonCpmProject_LeavesCentralPackageManagementDisabledAndBumpsAppLocalDeclaration() {
        // Preserve non-CPM behavior (issue #2319): when the source project's
        // ancestry has no Directory.Packages.props at all, no such file should
        // be copied, and UsesCentralPackageManagement must stay false so the
        // Compile stage keeps emitting a normal Version= attribute.
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let repoDir = NewScratchDir("translate-nbgv-noncpm")
        let projectDir = Path.Combine(repoDir, "src", "Sample")
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
        let appRunDir = NewOutputRoot("translate-nbgv-noncpm")
        let app = CorpusApp("test/NbgvNonCpmApp", projectPath, TargetKind.Exe)
        let options = PipelineOptions{GscPath: compiler}
        let gsc = GscInvoker(compiler)
        let triage = TriageBuilder("test-run", "2026-01-01T00:00:00Z", "0.0.0", app.Id)
        let context = StageExecutionContext(app, options, gsc, appRunDir, triage)
        let outcome = await TranslateStage().ExecuteAsync(context)
        Assert.Equal(StageStatus.Passed, outcome.Status)
        Assert.False(context.UsesCentralPackageManagement)
        Assert.False(File.Exists(Path.Combine(appRunDir, "Directory.Packages.props")))
        // Issue #2319 follow-up: an app-local literal Version= below the floor
        // is declared directly (not split across an ancestor Directory.Build/
        // Packages.props), so BuildOnlyPackageReferences alone cannot recover
        // it — SdkCompileRunner.Compile's declaredPackageIds filter would
        // discard that entry as a duplicate of this already-"declared" item,
        // and SdkCompileRunner.BuildProjectXml copies this item verbatim. The
        // bump must therefore happen here, on context.PackageReferences itself.
        let nbgvItem = Assert.Single(
            context.PackageReferences,
            (item DeclaredProjectItem) -> string.Equals(
                item.Element.Attribute(XName?("Include")!!)?.Value,
                NerdbankGitVersioningPolicy.PackageId,
                StringComparison.OrdinalIgnoreCase
            )
        )
        Assert.Equal(
            NerdbankGitVersioningPolicy.MinimumGSharpVersion,
            nbgvItem.Element.Attribute(XName?("Version")!!)?.Value
        )
        Assert.Equal("all", nbgvItem.Element.Attribute(XName?("PrivateAssets")!!)?.Value)
    }

    shared {
        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func NewScratchDir(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
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
