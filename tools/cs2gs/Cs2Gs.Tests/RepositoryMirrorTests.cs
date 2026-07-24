// <copyright file="RepositoryMirrorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
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
