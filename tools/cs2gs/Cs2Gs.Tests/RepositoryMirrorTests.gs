// <copyright file="RepositoryMirrorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import System.Threading.Tasks
import System.Xml.Linq
import Cs2Gs.Pipeline
import Xunit

/// Tests repository discovery and exact file mirroring.
class RepositoryMirrorTests {
    @Fact
    async func Migrate_ExcludedSiblingKeepsIncludedProjectAndSource() {
        using let scratch = RepositoryMirrorTests.ScratchDirectory()
        let source = Path.Combine(scratch.Path, "source")
        let shared = Path.Combine(source, "shared")
        let destination = Path.Combine(scratch.Path, "destination")
        Directory.CreateDirectory(shared)
        GsharpTestProjectRunner.WriteIsolationBoundary(source)
        let initialized = await ProcessRunner.RunAsync("git", []string{"init", "--quiet"}, source)
        Assert.Equal(0, initialized.ExitCode)
        for name in[]string{"Included", "Excluded"} {
            File.WriteAllText(
                Path.Combine(shared, name + ".csproj"),
                "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework>" +
                    "<EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>" +
                    "<ItemGroup><Compile Include=\"" +
                    name +
                    ".cs\" /></ItemGroup></Project>"
            )
            File.WriteAllText(Path.Combine(shared, name + ".cs"), "public class " + name + " {}")
        }
        File.WriteAllBytes(Path.Combine(shared, "asset.bin"), []byte{0, 255, 13, 10})
        let cli = Path.Combine(
            GsharpTestProjectRunner.FindRepoRoot()!!,
            "out",
            "bin",
            "Release",
            "Cs2Gs.Cli",
            "cs2gs.dll"
        )
        let result = await ProcessRunner.RunAsync(
            "dotnet",
            []string{
                cli,
                "migrate",
                "--corpus",
                source,
                "--out",
                destination,
                "--artifacts",
                Path.Combine(scratch.Path, "artifacts"),
                "--sdk-pin",
                "global-json",
                "--config",
                "Release",
                "--translate-only",
                "--exclude",
                "shared/Excluded.csproj"
            },
            source,
            TimeSpan.FromMinutes(2)
        )
        Assert.False(result.TimedOut, result.Output)
        Assert.True(result.ExitCode == 0, result.Output)
        Assert.Equal(
            Encoding.UTF8.GetBytes("open class Included { }\n"),
            File.ReadAllBytes(Path.Combine(destination, "shared", "Included.gs"))
        )
        let project = "\uFEFF<?xml version=\"1.0\" encoding=\"utf-8\"?><Project Sdk=\"Gsharp.NET.Sdk\">" +
            "<PropertyGroup><TargetFramework>net10.0</TargetFramework>" +
            "<EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>" +
            "<ItemGroup><Compile Include=\"Included.gs\" /></ItemGroup></Project>"
        Assert.Equal(
            Encoding.UTF8.GetBytes(project),
            File.ReadAllBytes(Path.Combine(destination, "shared", "Included.gsproj"))
        )
        Assert.Equal([]byte{0, 255, 13, 10}, File.ReadAllBytes(Path.Combine(destination, "shared", "asset.bin")))
        Assert.False(File.Exists(Path.Combine(destination, "shared", "Excluded.gsproj")))
        Assert.False(File.Exists(Path.Combine(destination, "shared", "Excluded.csproj")))
        Assert.False(File.Exists(Path.Combine(destination, "shared", "Excluded.gs")))
        Assert.False(File.Exists(Path.Combine(destination, "shared", "Excluded.cs")))
    }

    @Fact
    func ValidateCompleted_ExcludedSiblingKeepsIncludedProjectRequiredAndRejectsUnownedProjects() {
        using let scratch = RepositoryMirrorTests.ScratchDirectory()
        let source = Path.Combine(scratch.Path, "source")
        let destination = Path.Combine(scratch.Path, "destination")
        let excluded = Path.Combine(source, "shared", "Excluded.csproj")
        Directory.CreateDirectory(Path.GetDirectoryName(excluded)!!)
        Directory.CreateDirectory(Path.Combine(destination, "shared"))
        File.WriteAllText(excluded, "<Project />")
        File.WriteAllText(Path.Combine(destination, "Product.slnx"), "<Solution />")
        let files = []string{"Product.slnx", "shared/Excluded.csproj", "shared/Included.csproj"}
        let scope_ = RepositoryExcludedScope.Compute(source, []string{excluded})
        let missing = Assert.Throws[InvalidOperationException](
            () -> RepositoryMirror.ValidateCompleted(source, destination, files, excludedScope: scope_)
        )
        Assert.Contains("expected file 'shared/Included.gsproj'", missing.Message, StringComparison.Ordinal)
        File.WriteAllText(Path.Combine(destination, "shared", "Included.gsproj"), "<Project />")
        RepositoryMirror.ValidateCompleted(source, destination, files, excludedScope: scope_)
        File.WriteAllText(Path.Combine(destination, "shared", "Unowned.gsproj"), "<Project />")
        let unexpected = Assert.Throws[InvalidOperationException](
            () -> RepositoryMirror.ValidateCompleted(source, destination, files, excludedScope: scope_)
        )
        Assert.Equal("Repository migration produced unexpected file 'shared/Unowned.gsproj'.", unexpected.Message)
    }

    @Fact
    func Prepare_CopiesAssetsAndExcludesBuildOutputs() {
        using let scratch = RepositoryMirrorTests.ScratchDirectory()
        let source = Path.Combine(scratch.Path, "source")
        let destination = Path.Combine(scratch.Path, "destination")
        Directory.CreateDirectory(Path.Combine(source, "src", "App"))
        Directory.CreateDirectory(Path.Combine(source, "src", "App", "bin"))
        Directory.CreateDirectory(Path.Combine(source, "tests", "App.Tests", "TestResults"))
        File.WriteAllText(Path.Combine(source, "README.md"), "unchanged")
        File.WriteAllText(Path.Combine(source, "src", "App", "Program.cs"), "class Program {}")
        File.WriteAllText(Path.Combine(source, "src", "App", "App.csproj"), "<Project />")
        File.WriteAllText(Path.Combine(source, "src", "App", "asset.json"), "{}")
        File.WriteAllText(Path.Combine(source, "src", "App", "bin", "App.dll"), "ignored")
        File.WriteAllText(Path.Combine(source, "tests", "App.Tests", "TestResults", "result.trx"), "ignored")
        RepositoryMirror.Prepare(source, destination)
        Assert.Equal("unchanged", File.ReadAllText(Path.Combine(destination, "README.md")))
        Assert.Equal("{}", File.ReadAllText(Path.Combine(destination, "src", "App", "asset.json")))
        Assert.False(File.Exists(Path.Combine(destination, "src", "App", "Program.cs")))
        Assert.False(File.Exists(Path.Combine(destination, "src", "App", "App.csproj")))
        Assert.False(Directory.Exists(Path.Combine(destination, "src", "App", "bin")))
        Assert.False(Directory.Exists(Path.Combine(destination, "tests", "App.Tests", "TestResults")))
    }

    @Fact
    func Prepare_CollidingExtensionMappingsFailBeforeDestinationCreation() {
        using let scratch = RepositoryMirrorTests.ScratchDirectory()
        let source = Path.Combine(scratch.Path, "source")
        let destination = Path.Combine(scratch.Path, "destination")
        Directory.CreateDirectory(source)
        File.WriteAllText(Path.Combine(source, "Program.cs"), "class Program {}")
        File.WriteAllText(Path.Combine(source, "Program.gs"), "func main() {}")
        let exception = Assert.Throws[InvalidOperationException](
            func () object? {
                return RepositoryMirror.Prepare(source, destination)
            }
        )
        Assert.Contains("collision", exception.Message, StringComparison.OrdinalIgnoreCase)
        Assert.False(Directory.Exists(destination))
    }

    @Fact
    func Prepare_UpgradesNerdbankGitVersioningInSharedProps() {
        using let scratch = RepositoryMirrorTests.ScratchDirectory()
        let source = Path.Combine(scratch.Path, "source")
        let destination = Path.Combine(scratch.Path, "destination")
        Directory.CreateDirectory(source)
        File.WriteAllText(Path.Combine(source, "Directory.Packages.props"), `<Project>
  <ItemGroup>
    <PackageVersion Include="Nerdbank.GitVersioning" Version="3.7.115" />
  </ItemGroup>
</Project>`)
        RepositoryMirror.Prepare(source, destination)
        let copied = File.ReadAllText(Path.Combine(destination, "Directory.Packages.props"))
        Assert.Contains("Version=\"3.11.13-beta\"", copied)
        Assert.DoesNotContain("3.7.115", copied)
    }

    @Fact
    func Prepare_RetargetsGsharpPropsProjectHandlesInMigrationSet() {
        using let scratch = RepositoryMirrorTests.ScratchDirectory()
        let source = Path.Combine(scratch.Path, "source")
        let destination = Path.Combine(scratch.Path, "destination")
        let props = Path.Combine(source, "build", "gsharp.props")
        Directory.CreateDirectory(Path.GetDirectoryName(props)!!)
        File.WriteAllText(props, `<Project>
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
</Project>`)
        let generated = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
        for project in[]string{"Core", "Compiler", "Repl", "LanguageServer"} {
            generated[Path.Combine(source, "src", project, project + ".csproj")] = Path.Combine(
                destination,
                "src",
                project,
                project + ".gsproj"
            )
        }
        RepositoryMirror.Prepare(source, destination, generated)
        let mirrored = XDocument.Load(Path.Combine(destination, "build", "gsharp.props"))
        Assert.Equal(
            []string{
                "$$(GsharpRepoRoot)/src/Core/Core.gsproj",
                "$$(GsharpRepoRoot)/src/Compiler/Compiler.gsproj",
                "$$(GsharpRepoRoot)/src/Repl/Repl.gsproj",
                "$$(GsharpRepoRoot)/src/LanguageServer/LanguageServer.gsproj"
            },
            []string{"GsharpCore", "GsharpCompiler", "GsharpRepl", "GsharpLanguageServer"}.Select(
                (name string) -> mirrored.Descendants(name).Single().Attribute(XName?("Include")!!)?.Value
            )
                .ToArray()
        )
        Assert.Equal(
            "$$(GsharpRepoRoot)\\src\\Formatting\\Formatting.csproj",
            mirrored.Descendants("GsharpFormatting").Single().Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal(
            "$$(GsharpRepoRoot)\\src\\Formatting\\FormatterCli.csproj",
            mirrored.Descendants("GsharpFormatterCli").Single().Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal("@(GsharpCore)", mirrored.Descendants("GsharpAll").Single().Attribute(XName?("Include")!!)?.Value)
    }

    @Theory
    @InlineData(".props")
    @InlineData(".targets")
    func Prepare_RetargetsOnlyMigratedProjectItemPaths(extension string) {
        using let scratch = RepositoryMirrorTests.ScratchDirectory()
        let source = Path.Combine(scratch.Path, "source")
        let destination = Path.Combine(scratch.Path, "destination")
        let buildDirectory = Path.Combine(source, "build")
        let sharedBuildFile = Path.Combine(buildDirectory, "shared" + extension)
        let sourceProject = Path.Combine(source, "src", "Core", "Core.csproj")
        let generatedProject = Path.Combine(destination, "src", "Core", "Core.gsproj")
        Directory.CreateDirectory(buildDirectory)
        File.WriteAllText(sharedBuildFile, `<Project>
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
</Project>`)
        RepositoryMirror.Prepare(
            source,
            destination,
            Dictionary[string, string](StringComparer.OrdinalIgnoreCase){[sourceProject] = generatedProject}
        )
        let mirrored = XDocument.Load(Path.Combine(destination, "build", "shared" + extension))
        Assert.Equal(
            "../src/Core/Core.gsproj",
            mirrored.Descendants("LiteralProject").Single().Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal(
            "$$(RepoRoot)/src/Core/Core.gsproj",
            mirrored.Descendants("PropertyProject").Single().Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal(
            "$$(ExternalRoot)\\src\\Core\\Core.csproj",
            mirrored.Descendants("UnknownPropertyProject").Single().Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal(
            "$$(MSBuildProjectDirectory)\\..\\src\\Core\\Core.csproj",
            mirrored.Descendants("ImportingProjectPath").Single().Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal(
            "$$(RepoRoot)\\src\\$$(ProjectName)\\Core.csproj",
            mirrored.Descendants("ComputedProject").Single().Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal(
            "../external/External.csproj",
            mirrored.Descendants("ExternalProject").Single().Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal(
            "../src/Core/Core.cs",
            mirrored.Descendants("Compile").Single().Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal(
            "src/Core/Core.csproj",
            mirrored.Descendants("Message").Single().Attribute(XName?("Text")!!)?.Value
        )
    }

    @Fact
    func ValidateCompleted_RejectsUnexpectedOutput() {
        using let scratch = RepositoryMirrorTests.ScratchDirectory()
        let source = Path.Combine(scratch.Path, "source")
        let destination = Path.Combine(scratch.Path, "destination")
        Directory.CreateDirectory(source)
        Directory.CreateDirectory(destination)
        File.WriteAllText(Path.Combine(source, "Product.slnx"), "<Solution />")
        File.WriteAllText(Path.Combine(destination, "Product.slnx"), "<Solution />")
        File.WriteAllText(Path.Combine(destination, "Unexpected.gs"), "func unexpected() {}")
        let exception = Assert.Throws[InvalidOperationException](
            () -> RepositoryMirror.ValidateCompleted(source, destination, []string{"Product.slnx"})
        )
        Assert.Contains("unexpected file 'Unexpected.gs'", exception.Message, StringComparison.Ordinal)
    }

    @Fact
    func ValidateCompleted_AcceptsTranslatedLinkedOutputExcludedByAnotherProject() {
        using let scratch = RepositoryMirrorTests.ScratchDirectory()
        let source = Path.Combine(scratch.Path, "source")
        let destination = Path.Combine(scratch.Path, "destination")
        let sharedSource = Path.Combine(source, "test", "Shared", "GoldenFile.cs")
        let excludedProject = Path.Combine(source, "test", "Core.Tests", "Core.Tests.csproj")
        Directory.CreateDirectory(Path.GetDirectoryName(sharedSource)!!)
        Directory.CreateDirectory(Path.GetDirectoryName(excludedProject)!!)
        Directory.CreateDirectory(Path.Combine(destination, "test", "Shared"))
        File.WriteAllText(Path.Combine(source, "Product.slnx"), "<Solution />")
        File.WriteAllText(sharedSource, "internal static class GoldenFile {}")
        File.WriteAllText(excludedProject, `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <Compile Include="..\Shared\GoldenFile.cs" Link="GoldenFile.cs" />
  </ItemGroup>
</Project>`)
        File.WriteAllText(Path.Combine(destination, "Product.slnx"), "<Solution />")
        File.WriteAllText(Path.Combine(destination, "test", "Shared", "GoldenFile.gs"), "internal class GoldenFile {}")
        let scope_ = RepositoryExcludedScope.Compute(source, []string{excludedProject})
        RepositoryMirror.ValidateCompleted(
            source,
            destination,
            []string{"Product.slnx", "test/Core.Tests/Core.Tests.csproj", "test/Shared/GoldenFile.cs"},
            excludedScope: scope_,
            translatedSourceFiles: []string{sharedSource, Path.Combine(source, "out", "obj", "Core", "Generated.cs")}
        )
    }

    @Fact
    func RepositoryDiscovery_IncludesTestsAndUsesRelativeProjectPaths() {
        using let scratch = RepositoryMirrorTests.ScratchDirectory()
        let source = Path.Combine(scratch.Path, "source")
        let app = Path.Combine(source, "src", "App", "App.csproj")
        let tests = Path.Combine(source, "tests", "App.Tests", "App.Tests.csproj")
        Directory.CreateDirectory(Path.GetDirectoryName(app)!!)
        Directory.CreateDirectory(Path.GetDirectoryName(tests)!!)
        File.WriteAllText(app, "<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>")
        File.WriteAllText(tests, "<Project />")
        let projects = RepositoryDiscovery.Discover(source).ToArray()
        Assert.Equal(
            []string{"src/App/App.csproj", "tests/App.Tests/App.Tests.csproj"},
            projects.Select((project CorpusApp) -> project.Id).ToArray()
        )
        Assert.Equal(TargetKind.Exe, projects[0].TargetKind)
        Assert.Equal(TargetKind.Library, projects[1].TargetKind)
    }

    private class ScratchDirectory : IDisposable {
        init() {
            this.Path = Path.Combine(Path.GetTempPath(), "repository-mirror-tests", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(this.Path)
        }

        prop Path string {
            get;
        }

        func Dispose() {
            Directory.Delete(this.Path, recursive: true)
        }
    }
}
