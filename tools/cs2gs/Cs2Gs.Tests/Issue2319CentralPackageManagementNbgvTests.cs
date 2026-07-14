// <copyright file="Issue2319CentralPackageManagementNbgvTests.cs" company="GSharp">
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
/// End-to-end regression coverage for issue #2319: a Central Package
/// Management (CPM) repository whose <c>Directory.Packages.props</c> pins a
/// below-floor <c>Nerdbank.GitVersioning</c> (nbgv) version used to fail
/// <c>--via-sdk</c> restore with NU1008, because the copied
/// <c>Directory.Packages.props</c> kept the original below-floor version while
/// <see cref="SdkCompileRunner"/> independently emitted a bumped
/// <c>Version=</c> attribute on the generated nbgv <c>PackageReference</c> —
/// a combination CPM rejects outright. This exercises the real Translate +
/// Compile (<c>--via-sdk</c>) stages together and, when a locally-built
/// <c>Gsharp.NET.Sdk</c> nupkg is available, runs a real <c>dotnet build</c> to
/// prove the fix, not just the generated XML shape.
/// </summary>
public class Issue2319CentralPackageManagementNbgvTests
{
    [Fact]
    public async Task Pipeline_CpmNbgvFixture_BumpsCopiedPropsAndOmitsVersionOnGeneratedPackageReference()
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

        // Mirrors the reported repro: a repo-root Directory.Packages.props
        // that actually enables CPM and pins a below-floor literal nbgv
        // version, with the consumer-side versionless PackageReference
        // declared in a nested Directory.Build.props (Oahu's own layout).
        string sourceRoot = NewScratchDir("issue2319-cpm-nbgv");
        File.WriteAllText(
            Path.Combine(sourceRoot, "Directory.Packages.props"),
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

        string srcDir = Path.Combine(sourceRoot, "src");
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

        string outputRoot = NewOutputRoot("issue2319-cpm-nbgv");
        var app = new CorpusApp("test/CpmNbgvApp", projectPath, TargetKind.Exe);
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,

            // CompileViaSdk left at its true default (issue #2261) — this is
            // exactly the path that failed with NU1008 before the fix.
        };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);

        string appRunDir = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id));
        string generatedProps = Path.Combine(appRunDir, "Directory.Packages.props");
        string generatedProjectXml = File.ReadAllText(
            Directory.GetFiles(appRunDir, "*.gsproj", SearchOption.TopDirectoryOnly).Single());

        // Expected fix (1): the copied Directory.Packages.props — the file
        // actually consumed by the generated app — carries the bumped
        // version, not the inert nbgv-bump side channel.
        Assert.True(File.Exists(generatedProps), "Expected a copied Directory.Packages.props in the app run dir.");
        string propsText = File.ReadAllText(generatedProps);
        Assert.Contains(
            "<PackageVersion Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" />",
            propsText);
        Assert.DoesNotContain("3.7.115", propsText);

        // Expected fix (2): the generated NBGV PackageReference carries no
        // Version= attribute — CPM supplies it exclusively via PackageVersion.
        Assert.Contains(
            "<PackageReference Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />",
            generatedProjectXml);
        Assert.DoesNotContain(
            "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=",
            generatedProjectXml);

        // Expected fix (3): the real dotnet build (via-sdk) actually succeeds —
        // before the fix this failed restore with NU1008.
        Assert.True(
            appResult.Succeeded,
            "Expected the --via-sdk build to succeed for the CPM+nbgv fixture. AppResult: " +
                string.Join(
                    "; ",
                    appResult.Stages.Select(s => s.Stage + "=" + s.Status)));
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
