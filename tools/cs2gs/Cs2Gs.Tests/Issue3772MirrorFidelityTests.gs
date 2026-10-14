// <copyright file="Issue3772MirrorFidelityTests.cs" company="GSharp">
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

/// Issue #3772: the migrated tree is a repository, not a bag of projects. Code
/// in the mirror probes the repository layout it was written against — the
/// solution that names the repository root, and the projects its own project
/// files reference — so the mirror has to reproduce both.
class Issue3772MirrorFidelityTests : IDisposable {
    private let root string

    /// Initializes a new isolated test directory.
    init() {
        this.root = Path.Combine(Path.GetTempPath(), "issue-3772-mirror-fidelity", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(this.root)
    }

    /// Removes the isolated test directory.
    func Dispose() {
        Directory.Delete(this.root, recursive: true)
    }

    /// An excluded project with nothing to translate keeps its project file, so
    /// the mirror never holds a project directory without its project.
    @Fact
    func MirrorExcludedProjects_AlreadyGsharpProject_IsMirroredWithRetargetedReferences() {
        let source = Path.Combine(this.root, "source")
        let destination = Path.Combine(this.root, "destination")
        let extensionsDirectory = Path.Combine(source, "src", "Sdk", "Gsharp.Extensions")
        Directory.CreateDirectory(extensionsDirectory)
        Directory.CreateDirectory(Path.Combine(source, "src", "Compiler"))
        File.WriteAllText(Path.Combine(source, "src", "Compiler", "Compiler.csproj"), "<Project />")
        File.WriteAllText(Path.Combine(extensionsDirectory, "Optional.gs"), "func none() {}")
        File.WriteAllText(Path.Combine(extensionsDirectory, "Gsharp.Extensions.csproj"), `<Project>
  <!-- keep me -->
  <PropertyGroup>
    <AssemblyName>Gsharp.Extensions</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\..\Compiler\Compiler.csproj" />
    <ProjectReference Include="..\Gsharp.NET.Sdk\Gsharp.NET.Sdk.csproj" ReferenceOutputAssembly="false" />
  </ItemGroup>
  <Import Sdk="Microsoft.NET.Sdk" Project="Sdk.props" />
  <Import Project="..\Gsharp.NET.Sdk.Bootstrap\build\Gsharp.NET.Sdk.Bootstrap.targets" />
</Project>`)
        let scope_ = ExcludedScope(source, Path.Combine(extensionsDirectory, "Gsharp.Extensions.csproj"))
        let written = RepositoryMirror.MirrorExcludedProjects(
            source,
            destination,
            []string{
                "src/Compiler/Compiler.csproj",
                "src/Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj",
                "src/Sdk/Gsharp.Extensions/Optional.gs"
            },
            scope_,
            Dictionary[string, string](StringComparer.OrdinalIgnoreCase){
                [Path.Combine(source, "src", "Compiler", "Compiler.csproj")] = Path.Combine(
                    destination,
                    "src",
                    "Compiler",
                    "Compiler.gsproj"
                )
            },
            "Gsharp.NET.Sdk/9.9.9-test"
        )
        Assert.Equal(
            []string{Path.Combine("src", "Sdk", "Gsharp.Extensions", "Gsharp.Extensions.csproj")},
            written.ToArray()
        )
        let mirrored = Path.Combine(destination, "src", "Sdk", "Gsharp.Extensions", "Gsharp.Extensions.csproj")
        let document = XDocument.Load(mirrored, LoadOptions.PreserveWhitespace)
        Assert.Equal(
            "../../Compiler/Compiler.gsproj",
            document.Descendants("ProjectReference").Single().Attribute(XName?("Include")!!)!!.Value
        )
        Assert.Contains("keep me", File.ReadAllText(mirrored), StringComparison.Ordinal)
        // Rebound onto the pinned SDK: no bootstrap imports and none of the
        // bootstrap's toolchain-only build-ordering references.
        Assert.Equal("Gsharp.NET.Sdk/9.9.9-test", document.Root!!.Attribute(XName?("Sdk")!!)!!.Value)
        Assert.Empty(document.Descendants("Import"))
        Assert.Equal("Gsharp.Extensions", document.Descendants("AssemblyName").Single().Value)
    }

    /// An excluded project whose C# sources were left untranslated stays out of
    /// the mirror: mirroring it would produce a project with no sources.
    @Fact
    func MirrorExcludedProjects_ProjectWithCSharpSources_IsNotMirrored() {
        let source = Path.Combine(this.root, "source")
        let destination = Path.Combine(this.root, "destination")
        let extensionDirectory = Path.Combine(source, "src", "vs-gsharp", "src", "VsGsharp")
        Directory.CreateDirectory(extensionDirectory)
        File.WriteAllText(Path.Combine(extensionDirectory, "VsGsharp.csproj"), "<Project />")
        File.WriteAllText(Path.Combine(extensionDirectory, "Package.cs"), "class Package {}")
        let scope_ = ExcludedScope(source, Path.Combine(extensionDirectory, "VsGsharp.csproj"))
        let written = RepositoryMirror.MirrorExcludedProjects(
            source,
            destination,
            []string{"src/vs-gsharp/src/VsGsharp/Package.cs", "src/vs-gsharp/src/VsGsharp/VsGsharp.csproj"},
            scope_,
            Dictionary[string, string](StringComparer.OrdinalIgnoreCase),
            "Gsharp.NET.Sdk/9.9.9-test"
        )
        Assert.Empty(written)
    }

    /// A passthrough project remains buildable as C#, so retained migrated
    /// consumers can continue to reference it.
    @Fact
    func MirrorPassthroughProjects_CopiesProjectAndCSharpSources() {
        let source = Path.Combine(this.root, "source")
        let destination = Path.Combine(this.root, "destination")
        let runtimeDirectory = Path.Combine(source, "src", "Runtime")
        let compilerDirectory = Path.Combine(source, "src", "Compiler")
        let supportDirectory = Path.Combine(source, "src", "Support")
        Directory.CreateDirectory(runtimeDirectory)
        Directory.CreateDirectory(compilerDirectory)
        Directory.CreateDirectory(supportDirectory)
        File.WriteAllText(Path.Combine(compilerDirectory, "Compiler.csproj"), "<Project />")
        File.WriteAllText(Path.Combine(runtimeDirectory, "Runtime.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <DependencyProjects>..\Compiler\Compiler.csproj; ..\Support\Support.csproj</DependencyProjects>
  </PropertyGroup>
  <ItemGroup>
    <DependencyProjects Include="..\Compiler\Compiler.csproj; ..\Support\Support.csproj" />
    <ProjectReference Include="..\Compiler\Compiler.csproj" />
    <ProjectReference Include="..\Compiler\Compiler.csproj; ..\Support\Support.csproj" />
    <ProjectReference Include="..\Compiler\Compiler.csproj; ..\External\External.csproj" />
    <ProjectReference Include="$(DependencyProjects)" />
    <ProjectReference Include="@(DependencyProjects)" />
    <ProjectReference Include="@(GsharpCore)" />
  </ItemGroup>
  <Target Name="BuildCompiler">
    <MSBuild Projects="..\Compiler\Compiler.csproj" />
  </Target>
</Project>`)
        File.WriteAllText(Path.Combine(runtimeDirectory, "Runtime.cs"), "class Runtime {}")
        let scope_ = ExcludedScope(source, Path.Combine(runtimeDirectory, "Runtime.csproj"))
        let written = RepositoryMirror.MirrorPassthroughProjects(
            source,
            destination,
            []string{"src/Compiler/Compiler.csproj", "src/Runtime/Runtime.cs", "src/Runtime/Runtime.csproj"},
            scope_,
            Dictionary[string, string](StringComparer.OrdinalIgnoreCase){
                [Path.Combine(compilerDirectory, "Compiler.csproj")] = Path.Combine(
                    destination,
                    "src",
                    "Compiler",
                    "Compiler.gsproj"
                ),
                [Path.Combine(supportDirectory, "Support.csproj")] = Path.Combine(
                    destination,
                    "src",
                    "Support",
                    "Support.csproj"
                )
            }
        )
        Assert.Equal(
            []string{Path.Combine("src", "Runtime", "Runtime.cs"), Path.Combine("src", "Runtime", "Runtime.csproj")},
            written.OrderBy((path string) -> path, StringComparer.Ordinal).ToArray()
        )
        Assert.Equal("class Runtime {}", File.ReadAllText(Path.Combine(destination, "src", "Runtime", "Runtime.cs")))
        let project = XDocument.Load(Path.Combine(destination, "src", "Runtime", "Runtime.csproj"))
        Assert.Equal("Microsoft.NET.Sdk", project.Root!!.Attribute(XName?("Sdk")!!)!!.Value)
        Assert.Equal(
            "../Compiler/Compiler.gsproj; ../Support/Support.csproj",
            project
                .Descendants("DependencyProjects")
                .Single((element XElement) -> element.Attribute(XName?("Include")!!) == nil)
                .Value
        )
        Assert.Equal(
            "../Compiler/Compiler.gsproj; ../Support/Support.csproj",
            project
                .Descendants("DependencyProjects")
                .Single((element XElement) -> element.Attribute(XName?("Include")!!) != nil)
                .Attribute(XName?("Include")!!)!!.Value
        )
        Assert.Equal(
            []string{
                "../Compiler/Compiler.gsproj",
                "../Compiler/Compiler.gsproj; ../Support/Support.csproj",
                "../Compiler/Compiler.gsproj",
                "..\\External\\External.csproj",
                "$$(DependencyProjects)",
                "@(DependencyProjects)",
                "@(GsharpCore->'%(RootDir)%(Directory)%(Filename).gsproj')"
            },
            project
                .Descendants("ProjectReference")
                .Select((reference XElement) -> reference.Attribute(XName?("Include")!!)!!.Value)
                .ToArray()
        )
        Assert.Equal(
            "../Compiler/Compiler.gsproj",
            project.Descendants("MSBuild").Single().Attribute(XName?("Projects")!!)!!.Value
        )
    }

    @Fact
    func MirrorPassthroughProjects_CopiesRootProjectAndEvaluatedSources() {
        let source = Path.Combine(this.root, "source")
        let destination = Path.Combine(this.root, "destination")
        let projectPath = Path.Combine(source, "Root.csproj")
        let rootSource = Path.Combine(source, "Root.cs")
        let linkedSource = Path.Combine(source, "Shared", "Linked.cs")
        Directory.CreateDirectory(Path.GetDirectoryName(linkedSource)!!)
        File.WriteAllText(projectPath, "<Project Sdk=\"Microsoft.NET.Sdk\" />")
        File.WriteAllText(rootSource, "class Root {}")
        File.WriteAllText(linkedSource, "class Linked {}")
        File.WriteAllText(Path.Combine(source, "Other.cs"), "class Other {}")
        let scope_ = RepositoryExcludedScope.Compute(
            source,
            []string{projectPath},
            Dictionary[string, IReadOnlyList[string]](StringComparer.OrdinalIgnoreCase){
                [projectPath] = []string{rootSource, linkedSource}
            }
        )
        let written = RepositoryMirror.MirrorPassthroughProjects(
            source,
            destination,
            []string{"Root.csproj", "Root.cs", "Shared/Linked.cs", "Other.cs"},
            scope_,
            Dictionary[string, string](StringComparer.OrdinalIgnoreCase){
                [projectPath] = Path.Combine(destination, "Root.csproj")
            }
        )
        Assert.Equal(
            []string{"Root.cs", "Root.csproj", Path.Combine("Shared", "Linked.cs")},
            written.OrderBy((path string) -> path, StringComparer.Ordinal).ToArray()
        )
        Assert.False(File.Exists(Path.Combine(destination, "Other.cs")))
    }

    /// A legacy solution is mirrored under its own name — the file name the
    /// repository's own sources use to find the repository root — with its
    /// project paths retargeted, and the buildable `.slnx` lands beside it.
    @Fact
    func Generate_LegacySolution_MirrorsSlnAndEmitsSlnx() {
        let source = Path.Combine(this.root, "source")
        let destination = Path.Combine(this.root, "destination")
        Directory.CreateDirectory(Path.Combine(source, "src", "App"))
        let sourceProject = Path.Combine(source, "src", "App", "App.csproj")
        File.WriteAllText(
            sourceProject,
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup>" +
                "<TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
        )
        File.WriteAllText(Path.Combine(source, "Product.sln"), `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "App", "src\App\App.csproj", "{2E0F0D1B-5E52-4A2A-9C7C-1E5B0F6A7B31}"
EndProject
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
		Debug|Any CPU = Debug|Any CPU
	EndGlobalSection
	GlobalSection(ProjectConfigurationPlatforms) = postSolution
		{2E0F0D1B-5E52-4A2A-9C7C-1E5B0F6A7B31}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
	EndGlobalSection
EndGlobal
`)
        let written = RepositorySolutionGenerator.Generate(
            source,
            destination,
            Dictionary[string, string]{[sourceProject] = Path.Combine(destination, "src", "App", "App.gsproj")}
        )
        let mirroredSln = Path.Combine(destination, "Product.sln")
        let convertedSlnx = Path.Combine(destination, "Product.slnx")
        Assert.Equal(
            []string{mirroredSln, convertedSlnx}.OrderBy((path string) -> path, StringComparer.Ordinal).ToArray(),
            written.OrderBy((path string) -> path, StringComparer.Ordinal).ToArray()
        )
        let legacy = File.ReadAllText(mirroredSln)
        Assert.Contains("\"src\\App\\App.gsproj\"", legacy, StringComparison.Ordinal)
        Assert.DoesNotContain("App.csproj", legacy, StringComparison.Ordinal)
        Assert.Contains("{2E0F0D1B-5E52-4A2A-9C7C-1E5B0F6A7B31}", legacy, StringComparison.Ordinal)
        Assert.Contains("GlobalSection(ProjectConfigurationPlatforms)", legacy, StringComparison.Ordinal)
        Assert.Equal(
            "src/App/App.gsproj",
            XDocument.Load(convertedSlnx).Descendants("Project").Single().Attribute(XName?("Path")!!)!!.Value
        )
    }

    /// The completeness contract expects both mirrored solution files, so a
    /// mirror that reproduces the repository's own layout validates clean.
    @Fact
    func ValidateCompleted_MirroredSlnAndSlnx_AreBothExpected() {
        let source = Path.Combine(this.root, "source")
        let destination = Path.Combine(this.root, "destination")
        Directory.CreateDirectory(source)
        Directory.CreateDirectory(destination)
        File.WriteAllText(Path.Combine(destination, "Product.sln"), "legacy")
        File.WriteAllText(Path.Combine(destination, "Product.slnx"), "<Solution />")
        RepositoryMirror.ValidateCompleted(source, destination, []string{"Product.sln"})
        File.Delete(Path.Combine(destination, "Product.sln"))
        let missing = Assert.Throws[InvalidOperationException](
            () -> RepositoryMirror.ValidateCompleted(source, destination, []string{"Product.sln"})
        )
        Assert.Contains("Product.sln", missing.Message, StringComparison.Ordinal)
    }

    shared {
        private func ExcludedScope(
            sourceRoot string,
            excludedProject string
        ) RepositoryExcludedScope -> RepositoryExcludedScope.Compute(sourceRoot, []string{excludedProject})
    }
}
