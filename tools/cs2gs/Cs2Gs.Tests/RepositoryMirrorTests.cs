// <copyright file="RepositoryMirrorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Tests repository discovery and exact file mirroring.</summary>
public sealed class RepositoryMirrorTests
{
    [Fact]
    public void Prepare_CopiesAssetsAndExcludesBuildOutputs()
    {
        using var scratch = new ScratchDirectory();
        string source = Path.Combine(scratch.Path, "source");
        string destination = Path.Combine(scratch.Path, "destination");
        Directory.CreateDirectory(Path.Combine(source, "src", "App"));
        Directory.CreateDirectory(Path.Combine(source, "src", "App", "bin"));
        Directory.CreateDirectory(Path.Combine(source, "tests", "App.Tests", "TestResults"));
        File.WriteAllText(Path.Combine(source, "README.md"), "unchanged");
        File.WriteAllText(Path.Combine(source, "src", "App", "Program.cs"), "class Program {}");
        File.WriteAllText(Path.Combine(source, "src", "App", "App.csproj"), "<Project />");
        File.WriteAllText(Path.Combine(source, "src", "App", "asset.json"), "{}");
        File.WriteAllText(Path.Combine(source, "src", "App", "bin", "App.dll"), "ignored");
        File.WriteAllText(
            Path.Combine(source, "tests", "App.Tests", "TestResults", "result.trx"),
            "ignored");

        RepositoryMirror.Prepare(source, destination);

        Assert.Equal("unchanged", File.ReadAllText(Path.Combine(destination, "README.md")));
        Assert.Equal("{}", File.ReadAllText(Path.Combine(destination, "src", "App", "asset.json")));
        Assert.False(File.Exists(Path.Combine(destination, "src", "App", "Program.cs")));
        Assert.False(File.Exists(Path.Combine(destination, "src", "App", "App.csproj")));
        Assert.False(Directory.Exists(Path.Combine(destination, "src", "App", "bin")));
        Assert.False(Directory.Exists(Path.Combine(destination, "tests", "App.Tests", "TestResults")));
    }

    [Fact]
    public void Prepare_CollidingExtensionMappingsFailBeforeDestinationCreation()
    {
        using var scratch = new ScratchDirectory();
        string source = Path.Combine(scratch.Path, "source");
        string destination = Path.Combine(scratch.Path, "destination");
        Directory.CreateDirectory(source);
        File.WriteAllText(Path.Combine(source, "Program.cs"), "class Program {}");
        File.WriteAllText(Path.Combine(source, "Program.gs"), "func main() {}");

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => RepositoryMirror.Prepare(source, destination));

        Assert.Contains("collision", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False(Directory.Exists(destination));
    }

    [Fact]
    public void Prepare_UpgradesNerdbankGitVersioningInSharedProps()
    {
        using var scratch = new ScratchDirectory();
        string source = Path.Combine(scratch.Path, "source");
        string destination = Path.Combine(scratch.Path, "destination");
        Directory.CreateDirectory(source);
        File.WriteAllText(
            Path.Combine(source, "Directory.Packages.props"),
            """
            <Project>
              <ItemGroup>
                <PackageVersion Include="Nerdbank.GitVersioning" Version="3.7.115" />
              </ItemGroup>
            </Project>
            """);

        RepositoryMirror.Prepare(source, destination);

        string copied = File.ReadAllText(Path.Combine(destination, "Directory.Packages.props"));
        Assert.Contains("Version=\"3.11.13-beta\"", copied);
        Assert.DoesNotContain("3.7.115", copied);
    }

    [Fact]
    public void Prepare_RetargetsGsharpPropsProjectHandlesInMigrationSet()
    {
        using var scratch = new ScratchDirectory();
        string source = Path.Combine(scratch.Path, "source");
        string destination = Path.Combine(scratch.Path, "destination");
        string props = Path.Combine(source, "build", "gsharp.props");
        Directory.CreateDirectory(Path.GetDirectoryName(props));
        File.WriteAllText(
            props,
            """
            <Project>
              <PropertyGroup>
                <GsharpRepoRoot>$(MSBuildThisFileDirectory)..</GsharpRepoRoot>
              </PropertyGroup>
              <ItemGroup>
                <GsharpCore Include="$(GsharpRepoRoot)\src\Core\Core.csproj" />
                <GsharpCompiler Include="$(GsharpRepoRoot)\src\Compiler\Compiler.csproj" />
                <GsharpFormatting Include="$(GsharpRepoRoot)\src\Formatting\Formatting.csproj" />
                <GsharpFormatterCli Include="$(GsharpRepoRoot)\src\Formatting\FormatterCli.csproj" />
                <GsharpRepl Include="$(GsharpRepoRoot)\src\Repl\Repl.csproj" />
                <GsharpLanguageServer Include="$(GsharpRepoRoot)\src\LanguageServer\LanguageServer.csproj" />
                <GsharpAll Include="@(GsharpCore)" />
              </ItemGroup>
            </Project>
            """);

        var generated = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string project in new[] { "Core", "Compiler", "Repl", "LanguageServer" })
        {
            generated[Path.Combine(source, "src", project, project + ".csproj")] =
                Path.Combine(destination, "src", project, project + ".gsproj");
        }

        RepositoryMirror.Prepare(source, destination, generated);

        XDocument mirrored = XDocument.Load(Path.Combine(destination, "build", "gsharp.props"));
        Assert.Equal(
            new[]
            {
                "$(GsharpRepoRoot)/src/Core/Core.gsproj",
                "$(GsharpRepoRoot)/src/Compiler/Compiler.gsproj",
                "$(GsharpRepoRoot)/src/Repl/Repl.gsproj",
                "$(GsharpRepoRoot)/src/LanguageServer/LanguageServer.gsproj",
            },
            new[] { "GsharpCore", "GsharpCompiler", "GsharpRepl", "GsharpLanguageServer" }
                .Select(name => mirrored.Descendants(name).Single().Attribute("Include")?.Value)
                .ToArray());
        Assert.Equal(
            "$(GsharpRepoRoot)\\src\\Formatting\\Formatting.csproj",
            mirrored.Descendants("GsharpFormatting").Single().Attribute("Include")?.Value);
        Assert.Equal(
            "$(GsharpRepoRoot)\\src\\Formatting\\FormatterCli.csproj",
            mirrored.Descendants("GsharpFormatterCli").Single().Attribute("Include")?.Value);
        Assert.Equal("@(GsharpCore)", mirrored.Descendants("GsharpAll").Single().Attribute("Include")?.Value);
    }

    [Theory]
    [InlineData(".props")]
    [InlineData(".targets")]
    public void Prepare_RetargetsOnlyMigratedProjectItemPaths(string extension)
    {
        using var scratch = new ScratchDirectory();
        string source = Path.Combine(scratch.Path, "source");
        string destination = Path.Combine(scratch.Path, "destination");
        string buildDirectory = Path.Combine(source, "build");
        string sharedBuildFile = Path.Combine(buildDirectory, "shared" + extension);
        string sourceProject = Path.Combine(source, "src", "Core", "Core.csproj");
        string generatedProject = Path.Combine(destination, "src", "Core", "Core.gsproj");
        Directory.CreateDirectory(buildDirectory);
        File.WriteAllText(
            sharedBuildFile,
            """
            <Project>
              <PropertyGroup>
                <RepoRoot>$(MSBuildThisFileDirectory)..</RepoRoot>
              </PropertyGroup>
              <ItemGroup>
                <LiteralProject Include="../src/Core/Core.csproj" />
                <PropertyProject Include="$(RepoRoot)\src\Core\Core.csproj" />
                <UnknownPropertyProject Include="$(ExternalRoot)\src\Core\Core.csproj" />
                <ImportingProjectPath Include="$(MSBuildProjectDirectory)\..\src\Core\Core.csproj" />
                <ComputedProject Include="$(RepoRoot)\src\$(ProjectName)\Core.csproj" />
                <ExternalProject Include="../external/External.csproj" />
                <Compile Include="../src/Core/Core.cs" />
              </ItemGroup>
              <Target Name="Report">
                <Message Text="src/Core/Core.csproj" />
              </Target>
            </Project>
            """);

        RepositoryMirror.Prepare(
            source,
            destination,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                [sourceProject] = generatedProject,
            });

        XDocument mirrored = XDocument.Load(Path.Combine(destination, "build", "shared" + extension));
        Assert.Equal("../src/Core/Core.gsproj", mirrored.Descendants("LiteralProject").Single().Attribute("Include")?.Value);
        Assert.Equal(
            "$(RepoRoot)/src/Core/Core.gsproj",
            mirrored.Descendants("PropertyProject").Single().Attribute("Include")?.Value);
        Assert.Equal(
            "$(ExternalRoot)\\src\\Core\\Core.csproj",
            mirrored.Descendants("UnknownPropertyProject").Single().Attribute("Include")?.Value);
        Assert.Equal(
            "$(MSBuildProjectDirectory)\\..\\src\\Core\\Core.csproj",
            mirrored.Descendants("ImportingProjectPath").Single().Attribute("Include")?.Value);
        Assert.Equal(
            "$(RepoRoot)\\src\\$(ProjectName)\\Core.csproj",
            mirrored.Descendants("ComputedProject").Single().Attribute("Include")?.Value);
        Assert.Equal(
            "../external/External.csproj",
            mirrored.Descendants("ExternalProject").Single().Attribute("Include")?.Value);
        Assert.Equal("../src/Core/Core.cs", mirrored.Descendants("Compile").Single().Attribute("Include")?.Value);
        Assert.Equal("src/Core/Core.csproj", mirrored.Descendants("Message").Single().Attribute("Text")?.Value);
    }

    [Fact]
    public void ValidateCompleted_RejectsUnexpectedOutput()
    {
        using var scratch = new ScratchDirectory();
        string source = Path.Combine(scratch.Path, "source");
        string destination = Path.Combine(scratch.Path, "destination");
        Directory.CreateDirectory(source);
        Directory.CreateDirectory(destination);
        File.WriteAllText(Path.Combine(source, "Product.slnx"), "<Solution />");
        File.WriteAllText(Path.Combine(destination, "Product.slnx"), "<Solution />");
        File.WriteAllText(Path.Combine(destination, "Unexpected.gs"), "func unexpected() {}");

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => RepositoryMirror.ValidateCompleted(
                source,
                destination,
                new[] { "Product.slnx" }));

        Assert.Contains("unexpected file 'Unexpected.gs'", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateCompleted_AcceptsTranslatedLinkedOutputExcludedByAnotherProject()
    {
        using var scratch = new ScratchDirectory();
        string source = Path.Combine(scratch.Path, "source");
        string destination = Path.Combine(scratch.Path, "destination");
        string sharedSource = Path.Combine(source, "test", "Shared", "GoldenFile.cs");
        string excludedProject = Path.Combine(source, "test", "Core.Tests", "Core.Tests.csproj");
        Directory.CreateDirectory(Path.GetDirectoryName(sharedSource));
        Directory.CreateDirectory(Path.GetDirectoryName(excludedProject));
        Directory.CreateDirectory(Path.Combine(destination, "test", "Shared"));
        File.WriteAllText(Path.Combine(source, "Product.slnx"), "<Solution />");
        File.WriteAllText(sharedSource, "internal static class GoldenFile {}");
        File.WriteAllText(
            excludedProject,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <Compile Include="..\Shared\GoldenFile.cs" Link="GoldenFile.cs" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(destination, "Product.slnx"), "<Solution />");
        File.WriteAllText(
            Path.Combine(destination, "test", "Shared", "GoldenFile.gs"),
            "internal class GoldenFile {}");
        RepositoryExcludedScope scope = RepositoryExcludedScope.Compute(source, new[] { excludedProject });

        RepositoryMirror.ValidateCompleted(
            source,
            destination,
            new[]
            {
                "Product.slnx",
                "test/Core.Tests/Core.Tests.csproj",
                "test/Shared/GoldenFile.cs",
            },
            excludedScope: scope,
            translatedSourceFiles: new[]
            {
                sharedSource,
                Path.Combine(source, "out", "obj", "Core", "Generated.cs"),
            });
    }

    [Fact]
    public void RepositoryDiscovery_IncludesTestsAndUsesRelativeProjectPaths()
    {
        using var scratch = new ScratchDirectory();
        string source = Path.Combine(scratch.Path, "source");
        string app = Path.Combine(source, "src", "App", "App.csproj");
        string tests = Path.Combine(source, "tests", "App.Tests", "App.Tests.csproj");
        Directory.CreateDirectory(Path.GetDirectoryName(app));
        Directory.CreateDirectory(Path.GetDirectoryName(tests));
        File.WriteAllText(app, "<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>");
        File.WriteAllText(tests, "<Project />");

        CorpusApp[] projects = RepositoryDiscovery.Discover(source).ToArray();

        Assert.Equal(
            new[] { "src/App/App.csproj", "tests/App.Tests/App.Tests.csproj" },
            projects.Select(project => project.Id).ToArray());
        Assert.Equal(TargetKind.Exe, projects[0].TargetKind);
        Assert.Equal(TargetKind.Library, projects[1].TargetKind);
    }

    private sealed class ScratchDirectory : IDisposable
    {
        public ScratchDirectory()
        {
            this.Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "repository-mirror-tests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            Directory.Delete(this.Path, recursive: true);
        }
    }
}
