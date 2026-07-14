// <copyright file="Issue2319AppLocalNbgvPackageReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// End-to-end regression coverage for issue #2319's app-local follow-up: a
/// non-CPM project whose own <c>.csproj</c> declares <c>Nerdbank.GitVersioning</c>
/// directly with a literal below-floor <c>Version</c> (no ancestor
/// <c>Directory.Build.props</c>/<c>Directory.Packages.props</c> split) used to
/// keep that below-floor version, because the declared-item passthrough in
/// <c>SdkCompileRunner.BuildProjectXml</c> copies the app's own
/// <c>PackageReference</c> verbatim, and <c>SdkCompileRunner.Compile</c>'s
/// duplicate-avoidance filter (<c>declaredPackageIds</c>) then discards the
/// correctly-bumped entry <see cref="TranslateStage.ExecuteAsync"/> separately
/// records on <see cref="StageExecutionContext.BuildOnlyPackageReferences"/>,
/// since the id is already "declared". This exercises the real Translate +
/// Compile (<c>--via-sdk</c>) stages together and, when a locally-built
/// <c>Gsharp.NET.Sdk</c> nupkg is available, runs a real <c>dotnet build</c> to
/// prove the fix, not just the generated XML shape.
/// </summary>
public class Issue2319AppLocalNbgvPackageReferenceTests
{
    [Fact]
    public async Task Pipeline_AppLocalNbgvFixture_BumpsDeclaredPackageReferenceVersionWithoutDuplication()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null || repoRoot is null ||
            GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            // Gated like every other live --via-sdk e2e test in this suite:
            // build GSharp.sln (and pack the SDK) first.
            return;
        }

        // Non-CPM: no Directory.Packages.props/Directory.Build.props anywhere
        // in the ancestry — the app's own .csproj is the sole and complete
        // declaration, with a literal below-floor Version attribute.
        string sourceRoot = NewScratchDir("issue2319-applocal-nbgv");
        string projectDir = Path.Combine(sourceRoot, "src", "Sample");
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

        string outputRoot = NewOutputRoot("issue2319-applocal-nbgv");
        var app = new CorpusApp("test/AppLocalNbgvApp", projectPath, TargetKind.Exe);
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,

            // CompileViaSdk left at its true default (issue #2261) — this is
            // exactly the path where the below-floor literal Version used to
            // survive verbatim into the generated .gsproj.
        };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);

        string appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id));
        string generatedProjectXml = File.ReadAllText(
            Directory.GetFiles(appRunDir, "*.gsproj", SearchOption.TopDirectoryOnly).Single());

        // Expected fix (1): the app's own declared PackageReference is bumped
        // in place — not left at the original below-floor literal.
        Assert.Contains(
            "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" PrivateAssets=\"all\" />",
            generatedProjectXml);
        Assert.DoesNotContain("3.7.115", generatedProjectXml);

        // Expected fix (2): no duplicate PackageReference for nbgv — the
        // separately-recorded BuildOnlyPackageReferences entry must still be
        // filtered out by SdkCompileRunner.Compile's declaredPackageIds check
        // now that the surviving declared copy already carries the fix.
        int occurrences = CountOccurrences(generatedProjectXml, "Include=\"Nerdbank.GitVersioning\"");
        Assert.Equal(1, occurrences);

        // Expected fix (3): the real dotnet build (via-sdk) actually succeeds.
        Assert.True(
            appResult.Succeeded,
            "Expected the --via-sdk build to succeed for the app-local nbgv fixture. AppResult: " +
                string.Join(
                    "; ",
                    appResult.Stages.Select(s => s.Stage + "=" + s.Status)));
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string NewScratchDir(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "scratch-projects", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirName, string dllName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, projectDirName, dllName);
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
