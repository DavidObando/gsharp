// <copyright file="RepositorySolutionGeneratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Xml.Linq
import Cs2Gs.Pipeline
import Xunit

/// Tests repository solution mirroring without invoking solution migration.
class RepositorySolutionGeneratorTests : IDisposable {
    private let root string

    /// Initializes a new isolated test directory.
    init() {
        this.root = Path.Combine(
            AppContext.BaseDirectory,
            "repository-solution-generator-tests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(this.root)
    }

    /// Removes the isolated test directory.
    func Dispose() {
        Directory.Delete(this.root, recursive: true)
    }

    /// Existing slnx files retain their folder and configuration structure while
    /// mapped project paths become relative to the mirrored solution directory.
    @Fact
    func Generate_ExistingSlnx_PreservesMetadataAndRewritesProjectPath() {
        let sourceRoot = this.CreateDirectory("source")
        let destinationRoot = Path.Combine(this.root, "destination")
        let solutionDirectory = this.CreateDirectory("source", "eng", "solutions")
        let sourceProject = Path.Combine(sourceRoot, "src", "App", "App.csproj")
        let generatedProject = Path.Combine(destinationRoot, "generated", "App.gsproj")
        let sourceSolution = Path.Combine(solutionDirectory, "Product.slnx")
        File.WriteAllText(sourceSolution, `<Solution>
  <Configurations>
    <Platform Name="Any CPU" />
  </Configurations>
  <Folder Name="/Applications/">
    <Project Path="../../src/App/App.csproj" />
  </Folder>
</Solution>`)
        let written = RepositorySolutionGenerator.Generate(
            sourceRoot,
            destinationRoot,
            Dictionary[string, string]{[sourceProject] = generatedProject}
        )
        let destinationSolution = Path.Combine(destinationRoot, "eng", "solutions", "Product.slnx")
        Assert.Equal(destinationSolution, Assert.Single(written))
        let document = XDocument.Load(destinationSolution, LoadOptions.PreserveWhitespace)
        Assert.Equal(
            "../../generated/App.gsproj",
            document.Descendants("Project").Single().Attribute(XName?("Path")!!)!!.Value
        )
        Assert.Equal("C#", document.Descendants("Project").Single().Attribute(XName?("Type")!!)!!.Value)
        Assert.Equal("/Applications/", document.Descendants("Folder").Single().Attribute(XName?("Name")!!)!!.Value)
        Assert.Equal("Any CPU", document.Descendants("Platform").Single().Attribute(XName?("Name")!!)!!.Value)
    }

    /// Solution discovery is recursive and skips build, test, and Git output trees.
    @Fact
    func Generate_RecursesButSkipsExcludedDirectories() {
        let sourceRoot = this.CreateDirectory("source")
        let destinationRoot = Path.Combine(this.root, "destination")
        let nestedDirectory = this.CreateDirectory("source", "nested")
        File.WriteAllText(Path.Combine(nestedDirectory, "Included.slnx"), "<Solution />")
        for excluded in[]string{"bin", "obj", "TestResults", ".git"} {
            let excludedDirectory = this.CreateDirectory("source", excluded, "nested")
            File.WriteAllText(Path.Combine(excludedDirectory, "Ignored.slnx"), "<Solution />")
        }
        let written = RepositorySolutionGenerator.Generate(sourceRoot, destinationRoot, Dictionary[string, string]())
        Assert.Equal(Path.Combine(destinationRoot, "nested", "Included.slnx"), Assert.Single(written))
    }

    /// A repository without solutions receives one root solution containing every generated project.
    @Fact
    func Generate_NoSolutions_SynthesizesRootSolution() {
        let sourceRoot = this.CreateDirectory("source")
        let destinationRoot = Path.Combine(this.root, "destination")
        let mapping = Dictionary[string, string]{
            [Path.Combine(sourceRoot, "src", "First.csproj")] = Path.Combine(destinationRoot, "src", "First.gsproj"),
            [Path.Combine(sourceRoot, "tests", "Second.csproj")] = Path.Combine(
                destinationRoot,
                "tests",
                "Second.gsproj"
            )
        }
        let written = RepositorySolutionGenerator.Generate(sourceRoot, destinationRoot, mapping)
        let solutionPath = Path.Combine(destinationRoot, "source.slnx")
        Assert.Equal(solutionPath, Assert.Single(written))
        let projectPaths = XDocument
            .Load(solutionPath)
            .Descendants("Project")
            .Select((project XElement) -> project.Attribute(XName?("Path")!!)!!.Value)
            .ToArray()
        Assert.Equal([]string{"src/First.gsproj", "tests/Second.gsproj"}, projectPaths)
        Assert.All(
            XDocument.Load(solutionPath).Descendants("Project"),
            (project XElement) -> Assert.Equal("C#", project.Attribute(XName?("Type")!!)!!.Value)
        )
    }

    /// A legacy and XML solution with the same basename fail before destination files are written.
    @Fact
    func Generate_SlnAndSlnxDestinationCollision_ThrowsBeforeWriting() {
        let sourceRoot = this.CreateDirectory("source")
        let destinationRoot = Path.Combine(this.root, "destination")
        File.WriteAllText(Path.Combine(sourceRoot, "Product.sln"), string.Empty)
        File.WriteAllText(Path.Combine(sourceRoot, "Product.slnx"), "<Solution />")
        let exception = Assert.Throws[InvalidOperationException](
            func () object? {
                return RepositorySolutionGenerator.Generate(sourceRoot, destinationRoot, Dictionary[string, string]())
            }
        )
        Assert.Contains("both map to", exception.Message, StringComparison.Ordinal)
        Assert.False(Directory.Exists(destinationRoot))
    }

    private func CreateDirectory(parts ...string) string {
        let path = parts.Aggregate(this.root, Path.Combine)
        Directory.CreateDirectory(path)
        return path
    }
}
