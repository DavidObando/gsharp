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
