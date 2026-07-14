// <copyright file="TranslateStageNbgvPackageReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Stage-level tests for issue #2267: the isolated <c>--via-sdk</c> gsproj drops
/// <c>Nerdbank.GitVersioning</c> entirely because it is a build/dev-only
/// dependency (<c>PrivateAssets="all"</c>, no compile-time reference DLL), so
/// its <c>ThisAssembly</c> MSBuild source generator never runs. <see cref="TranslateStage"/>
/// must recover the source project's nbgv declaration — even when, as in Oahu,
/// it is split by Central Package Management across a versionless
/// <c>&lt;PackageReference&gt;</c> in a shared <c>Directory.Build.props</c> and
/// the actual <c>&lt;PackageVersion&gt;</c> in <c>Directory.Packages.props</c> —
/// and publish it on <see cref="StageExecutionContext.BuildOnlyPackageReferences"/>
/// so <see cref="CompileStage"/>/<see cref="SdkCompileRunner"/> can re-declare it.
/// </summary>
public class TranslateStageNbgvPackageReferenceTests
{
    [Fact]
    public async Task TranslateStage_CpmSplitNbgvDeclaration_PublishesBumpedBuildOnlyPackageReference()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        // Mirrors Oahu's real layout: repo-root Directory.Packages.props pins a
        // below-floor literal nbgv version; a nested Directory.Build.props
        // declares the versionless, PrivateAssets="all" consumer-side reference.
        string repoDir = NewScratchDir("translate-nbgv-cpm");
        File.WriteAllText(
            Path.Combine(repoDir, "Directory.Packages.props"),
            """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Nerdbank.GitVersioning" Version="3.7.115" />
              </ItemGroup>
            </Project>
            """);

        string srcDir = Path.Combine(repoDir, "src");
        Directory.CreateDirectory(srcDir);
        File.WriteAllText(
            Path.Combine(srcDir, "Directory.Build.props"),
            """
            <Project>
              <ItemGroup>
                <PackageReference Include="Nerdbank.GitVersioning" PrivateAssets="all" />
              </ItemGroup>
            </Project>
            """);

        string projectDir = Path.Combine(srcDir, "Sample");
        Directory.CreateDirectory(projectDir);
        string projectPath = Path.Combine(projectDir, "Sample.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Exe</OutputType>
                <RootNamespace>Sample.App</RootNamespace>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(
            Path.Combine(projectDir, "Program.cs"),
            "public class Program { public static void Main() { } }");

        string appRunDir = NewOutputRoot("translate-nbgv-cpm");
        var app = new CorpusApp("test/NbgvCpmApp", projectPath, TargetKind.Exe);
        var options = new PipelineOptions { GscPath = compiler };
        var gsc = new GscInvoker(compiler);
        var triage = new TriageBuilder("test-run", "2026-01-01T00:00:00Z", "0.0.0", app.Id);
        var context = new StageExecutionContext(app, options, gsc, appRunDir, triage);

        StageOutcome outcome = await new TranslateStage().ExecuteAsync(context);

        Assert.Equal(StageStatus.Passed, outcome.Status);

        DeclaredPackageReference nbgvReference = Assert.Single(context.BuildOnlyPackageReferences);
        Assert.Equal(NerdbankGitVersioningPolicy.PackageId, nbgvReference.Id);
        Assert.Equal(NerdbankGitVersioningPolicy.MinimumGSharpVersion, nbgvReference.Version);
        Assert.Equal("all", nbgvReference.PrivateAssets);

        // Issue #2319: the copied Directory.Packages.props — the file NuGet
        // actually restores the generated app against — must itself carry the
        // bumped version; a verbatim copy plus the previous inert
        // nbgv-bump/Directory.Packages.props left the below-floor version in
        // place for restore. The Translate stage must also record that CPM
        // governs this app so the Compile stage omits Version= from any
        // PackageReference it synthesizes.
        Assert.True(context.UsesCentralPackageManagement);
        string copiedProps = File.ReadAllText(Path.Combine(appRunDir, "Directory.Packages.props"));
        Assert.Contains(
            "<PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" />",
            copiedProps);
        Assert.DoesNotContain("3.7.115", copiedProps);
    }

    [Fact]
    public async Task TranslateStage_NonCpmProject_LeavesCentralPackageManagementDisabledAndCopiesNoPropsFile()
    {
        // Preserve non-CPM behavior (issue #2319): when the source project's
        // ancestry has no Directory.Packages.props at all, no such file should
        // be copied, and UsesCentralPackageManagement must stay false so the
        // Compile stage keeps emitting a normal Version= attribute.
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string repoDir = NewScratchDir("translate-nbgv-noncpm");
        string projectDir = Path.Combine(repoDir, "src", "Sample");
        Directory.CreateDirectory(projectDir);
        string projectPath = Path.Combine(projectDir, "Sample.csproj");
        File.WriteAllText(projectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Exe</OutputType>
                <RootNamespace>Sample.App</RootNamespace>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Nerdbank.GitVersioning" Version="3.7.115" PrivateAssets="all" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(
            Path.Combine(projectDir, "Program.cs"),
            "public class Program { public static void Main() { } }");

        string appRunDir = NewOutputRoot("translate-nbgv-noncpm");
        var app = new CorpusApp("test/NbgvNonCpmApp", projectPath, TargetKind.Exe);
        var options = new PipelineOptions { GscPath = compiler };
        var gsc = new GscInvoker(compiler);
        var triage = new TriageBuilder("test-run", "2026-01-01T00:00:00Z", "0.0.0", app.Id);
        var context = new StageExecutionContext(app, options, gsc, appRunDir, triage);

        StageOutcome outcome = await new TranslateStage().ExecuteAsync(context);

        Assert.Equal(StageStatus.Passed, outcome.Status);
        Assert.False(context.UsesCentralPackageManagement);
        Assert.False(File.Exists(Path.Combine(appRunDir, "Directory.Packages.props")));
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string NewScratchDir(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
