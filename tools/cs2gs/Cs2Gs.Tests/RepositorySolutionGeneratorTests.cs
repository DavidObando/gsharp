// <copyright file="RepositorySolutionGeneratorTests.cs" company="GSharp">
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

/// <summary>Tests repository solution mirroring without invoking solution migration.</summary>
public sealed class RepositorySolutionGeneratorTests : IDisposable
{
    private readonly string root;

    /// <summary>Initializes a new isolated test directory.</summary>
    public RepositorySolutionGeneratorTests()
    {
        this.root = Path.Combine(
            AppContext.BaseDirectory,
            "repository-solution-generator-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    /// <summary>Removes the isolated test directory.</summary>
    public void Dispose()
    {
        Directory.Delete(this.root, recursive: true);
    }

    /// <summary>
    /// Existing slnx files retain their folder and configuration structure while
    /// mapped project paths become relative to the mirrored solution directory.
    /// </summary>
    [Fact]
    public void Generate_ExistingSlnx_PreservesMetadataAndRewritesProjectPath()
    {
        string sourceRoot = this.CreateDirectory("source");
        string destinationRoot = Path.Combine(this.root, "destination");
        string solutionDirectory = this.CreateDirectory("source", "eng", "solutions");
        string sourceProject = Path.Combine(sourceRoot, "src", "App", "App.csproj");
        string generatedProject = Path.Combine(destinationRoot, "generated", "App.gsproj");
        string sourceSolution = Path.Combine(solutionDirectory, "Product.slnx");
        File.WriteAllText(
            sourceSolution,
            """
            <Solution>
              <Configurations>
                <Platform Name="Any CPU" />
              </Configurations>
              <Folder Name="/Applications/">
                <Project Path="../../src/App/App.csproj" />
              </Folder>
            </Solution>
            """);

        IReadOnlyList<string> written = RepositorySolutionGenerator.Generate(
            sourceRoot,
            destinationRoot,
            new Dictionary<string, string> { [sourceProject] = generatedProject });

        string destinationSolution = Path.Combine(destinationRoot, "eng", "solutions", "Product.slnx");
        Assert.Equal(destinationSolution, Assert.Single(written));
        XDocument document = XDocument.Load(destinationSolution, LoadOptions.PreserveWhitespace);
        Assert.Equal(
            "../../generated/App.gsproj",
            document.Descendants("Project").Single().Attribute("Path").Value);
        Assert.Equal("C#", document.Descendants("Project").Single().Attribute("Type").Value);
        Assert.Equal(
            "/Applications/",
            document.Descendants("Folder").Single().Attribute("Name").Value);
        Assert.Equal(
            "Any CPU",
            document.Descendants("Platform").Single().Attribute("Name").Value);
    }

    /// <summary>Solution discovery is recursive and skips build, test, and Git output trees.</summary>
    [Fact]
    public void Generate_RecursesButSkipsExcludedDirectories()
    {
        string sourceRoot = this.CreateDirectory("source");
        string destinationRoot = Path.Combine(this.root, "destination");
        string nestedDirectory = this.CreateDirectory("source", "nested");
        File.WriteAllText(Path.Combine(nestedDirectory, "Included.slnx"), "<Solution />");

        foreach (string excluded in new[] { "bin", "obj", "TestResults", ".git" })
        {
            string excludedDirectory = this.CreateDirectory("source", excluded, "nested");
            File.WriteAllText(Path.Combine(excludedDirectory, "Ignored.slnx"), "<Solution />");
        }

        IReadOnlyList<string> written = RepositorySolutionGenerator.Generate(
            sourceRoot,
            destinationRoot,
            new Dictionary<string, string>());

        Assert.Equal(
            Path.Combine(destinationRoot, "nested", "Included.slnx"),
            Assert.Single(written));
    }

    /// <summary>A repository without solutions receives one root solution containing every generated project.</summary>
    [Fact]
    public void Generate_NoSolutions_SynthesizesRootSolution()
    {
        string sourceRoot = this.CreateDirectory("source");
        string destinationRoot = Path.Combine(this.root, "destination");
        var mapping = new Dictionary<string, string>
        {
            [Path.Combine(sourceRoot, "src", "First.csproj")] =
                Path.Combine(destinationRoot, "src", "First.gsproj"),
            [Path.Combine(sourceRoot, "tests", "Second.csproj")] =
                Path.Combine(destinationRoot, "tests", "Second.gsproj"),
        };

        IReadOnlyList<string> written = RepositorySolutionGenerator.Generate(
            sourceRoot,
            destinationRoot,
            mapping);

        string solutionPath = Path.Combine(destinationRoot, "source.slnx");
        Assert.Equal(solutionPath, Assert.Single(written));
        string[] projectPaths = XDocument.Load(solutionPath)
            .Descendants("Project")
            .Select(project => project.Attribute("Path").Value)
            .ToArray();
        Assert.Equal(new[] { "src/First.gsproj", "tests/Second.gsproj" }, projectPaths);
        Assert.All(
            XDocument.Load(solutionPath).Descendants("Project"),
            project => Assert.Equal("C#", project.Attribute("Type").Value));
    }

    /// <summary>A legacy and XML solution with the same basename fail before destination files are written.</summary>
    [Fact]
    public void Generate_SlnAndSlnxDestinationCollision_ThrowsBeforeWriting()
    {
        string sourceRoot = this.CreateDirectory("source");
        string destinationRoot = Path.Combine(this.root, "destination");
        File.WriteAllText(Path.Combine(sourceRoot, "Product.sln"), string.Empty);
        File.WriteAllText(Path.Combine(sourceRoot, "Product.slnx"), "<Solution />");

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => RepositorySolutionGenerator.Generate(
                sourceRoot,
                destinationRoot,
                new Dictionary<string, string>()));

        Assert.Contains("both map to", exception.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(destinationRoot));
    }

    private string CreateDirectory(params string[] parts)
    {
        string path = parts.Aggregate(this.root, Path.Combine);
        Directory.CreateDirectory(path);
        return path;
    }
}
