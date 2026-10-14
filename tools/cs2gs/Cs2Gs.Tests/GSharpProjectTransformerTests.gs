// <copyright file="GSharpProjectTransformerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Xml
import System.Xml.Linq
import Cs2Gs.Pipeline
import Xunit

/// Tests for (cref:GSharpProjectTransformer).
class GSharpProjectTransformerTests {
    @Fact
    func Transform_RewritesSdkReferencesCompileSpecsAndMetadata() {
        using let scratch = GSharpProjectTransformerTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "source", "App", "App.csproj")
        let sourceLibrary = Path.Combine(scratch.Path, "source", "Lib", "Lib.csproj")
        let destinationDirectory = Path.Combine(scratch.Path, "generated", "App")
        let generatedLibrary = Path.Combine(scratch.Path, "generated", "Lib", "Lib.gsproj")
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject)!!)
        Directory.CreateDirectory(destinationDirectory)
        File.WriteAllText(sourceProject, `<Project Sdk="Microsoft.NET.Sdk">
  <!-- keep this comment -->
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <OutputType>WinExe</OutputType>
    <CustomProperty>unchanged</CustomProperty>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Lib\Lib.csproj" Aliases="library">
      <PrivateAssets>all</PrivateAssets>
    </ProjectReference>
    <Compile Include="Program.cs; Generated\**\*.CS ; readme.txt">
      <LastGenOutput>Program.generated.cs</LastGenOutput>
      <DependentUpon> Program.cs </DependentUpon>
      <CustomMetadata>keep.cs</CustomMetadata>
    </Compile>
    <Compile Update="Forms\Main.cs" />
    <Compile Remove="obj/**/*.cs;notes.csx" />
  </ItemGroup>
  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" Condition="Exists('custom')" />
  <Target Name="CustomTarget">
    <Message Text="untouched" />
  </Target>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            destinationDirectory,
            "Gsharp.NET.Sdk/2.3.4",
            Dictionary[string, string]{[Path.GetFullPath(sourceLibrary)] = generatedLibrary}
        )
        Assert.Equal("Gsharp.NET.Sdk/2.3.4", transformed.Root?.Attribute(XName?("Sdk")!!)?.Value)
        let projectReference = SingleElement(transformed, "ProjectReference")
        Assert.Equal(
            Path.GetRelativePath(destinationDirectory, generatedLibrary).Replace('\\', '/'),
            projectReference.Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal("library", projectReference.Attribute(XName?("Aliases")!!)?.Value)
        Assert.Equal("all", SingleElement(projectReference, "PrivateAssets").Value)
        let compileItems = ElementsNamed(transformed, "Compile").ToArray()
        Assert.Equal(
            "Program.gs; Generated\\**\\*.gs ; readme.txt",
            compileItems[0].Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal("Forms\\Main.gs", compileItems[1].Attribute(XName?("Update")!!)?.Value)
        Assert.Equal("obj/**/*.gs;notes.csx", compileItems[2].Attribute(XName?("Remove")!!)?.Value)
        Assert.Equal("Program.generated.gs", SingleElement(transformed, "LastGenOutput").Value)
        Assert.Equal(" Program.gs ", SingleElement(transformed, "DependentUpon").Value)
        Assert.Equal("keep.cs", SingleElement(transformed, "CustomMetadata").Value)
        Assert.Equal(
            "'$$(Configuration)' == 'Release'",
            SingleElement(transformed, "PropertyGroup").Attribute(XName?("Condition")!!)?.Value
        )
        Assert.Equal("Exe", SingleElement(transformed, "OutputType").Value)
        Assert.Equal("unchanged", SingleElement(transformed, "CustomProperty").Value)
        Assert.Equal("Exists('custom')", SingleElement(transformed, "Import").Attribute(XName?("Condition")!!)?.Value)
        Assert.Equal("untouched", SingleElement(transformed, "Message").Attribute(XName?("Text")!!)?.Value)
        Assert.Contains("  <!-- keep this comment -->", transformed.ToString(SaveOptions.DisableFormatting))
    }

    @Fact
    func Transform_LeavesUnmappedReferenceAndRewritesExpressions() {
        using let scratch = GSharpProjectTransformerTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "source", "App.csproj")
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject)!!)
        File.WriteAllText(sourceProject, `<Project>
  <ItemGroup>
    <ProjectReference Include="../External/External.csproj" Condition="'$(UseExternal)' == 'true'" />
    <ProjectReference Include="$(SharedProject)" />
    <ProjectReference Include="@(SharedProjects)" />
    <ProjectReference Include="@(GeneratedProjects); ../Other/Other.csproj" />
  </ItemGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            Path.Combine(scratch.Path, "generated"),
            "Gsharp.NET.Sdk/1.0.0",
            Dictionary[string, string]{
                [Path.Combine(scratch.Path, "Other", "Other.csproj")] = Path.Combine(
                    scratch.Path,
                    "generated",
                    "Other.gsproj"
                )
            }
        )
        let references = ElementsNamed(transformed, "ProjectReference").ToArray()
        Assert.Equal("../External/External.csproj", references[0].Attribute(XName?("Include")!!)?.Value)
        Assert.Equal("'$$(UseExternal)' == 'true'", references[0].Attribute(XName?("Condition")!!)?.Value)
        Assert.Equal(
            "$$([System.IO.Path]::ChangeExtension('$$(SharedProject)', '.gsproj'))",
            references[1].Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal(
            "@(SharedProjects->'%(RootDir)%(Directory)%(Filename).gsproj')",
            references[2].Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal(
            "@(GeneratedProjects->'%(RootDir)%(Directory)%(Filename).gsproj'); Other.gsproj",
            references[3].Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal("Gsharp.NET.Sdk/1.0.0", transformed.Root?.Attribute(XName?("Sdk")!!)?.Value)
    }

    @Fact
    func Transform_KeepsPassthroughProjectOutputAsCompileReference() {
        using let scratch = GSharpProjectTransformerTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "source", "App", "App.csproj")
        let sourceRuntime = Path.Combine(scratch.Path, "source", "Runtime", "Runtime.csproj")
        let sourceCompiler = Path.Combine(scratch.Path, "source", "Compiler", "Compiler.csproj")
        let destinationDirectory = Path.Combine(scratch.Path, "generated", "App")
        let passthroughRuntime = Path.Combine(scratch.Path, "generated", "Runtime", "Runtime.csproj")
        let generatedCompiler = Path.Combine(scratch.Path, "generated", "Compiler", "Compiler.gsproj")
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject)!!)
        Directory.CreateDirectory(destinationDirectory)
        File.WriteAllText(sourceProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <DependencyProjects>..\Runtime\Runtime.csproj; ..\Compiler\Compiler.csproj</DependencyProjects>
  </PropertyGroup>
  <ItemGroup>
    <DependencyProjects Include="..\Runtime\Runtime.csproj; ..\Compiler\Compiler.csproj" />
    <ProjectReference Include="..\Runtime\Runtime.csproj" />
    <ProjectReference Include="..\Runtime\Runtime.csproj; ..\Compiler\Compiler.csproj" />
    <ProjectReference Include="$(DependencyProjects)" />
    <ProjectReference Include="@(DependencyProjects)" />
    <ProjectReference Include="..\External\One.csproj; ..\External\Two.csproj" />
  </ItemGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            destinationDirectory,
            "Gsharp.NET.Sdk/1.0.0",
            Dictionary[string, string]{
                [Path.GetFullPath(sourceRuntime)] = passthroughRuntime,
                [Path.GetFullPath(sourceCompiler)] = generatedCompiler
            }
        )
        Assert.Equal(
            "../Runtime/Runtime.csproj; ../Compiler/Compiler.gsproj",
            ElementsNamed(transformed, "DependencyProjects").Single(
                (element XElement) -> element.Attribute(XName?("Include")!!) == nil
            )
                .Value
        )
        Assert.Equal(
            "../Runtime/Runtime.csproj; ../Compiler/Compiler.gsproj",
            ElementsNamed(transformed, "DependencyProjects")
                .Single((element XElement) -> element.Attribute(XName?("Include")!!) != nil)
                .Attribute(XName?("Include")!!)
                ?.Value
        )
        let references = ElementsNamed(transformed, "ProjectReference").ToArray()
        Assert.Equal("../Runtime/Runtime.csproj", references[0].Attribute(XName?("Include")!!)?.Value)
        Assert.Equal(
            "../Runtime/Runtime.csproj; ../Compiler/Compiler.gsproj",
            references[1].Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal("$$(DependencyProjects)", references[2].Attribute(XName?("Include")!!)?.Value)
        Assert.Equal("@(DependencyProjects)", references[3].Attribute(XName?("Include")!!)?.Value)
        Assert.Equal(
            "..\\External\\One.csproj; ..\\External\\Two.csproj",
            references[4].Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal("false", references[4].Attribute(XName?("ReferenceOutputAssembly")!!)?.Value)
        Assert.All(
            references.Take(4),
            (reference XElement) -> Assert.Null(reference.Attribute(XName?("ReferenceOutputAssembly")!!))
        )
    }

    @Fact
    func Transform_ResolvesAnchoredPathsAndSplitsMixedLiteralReferences() {
        using let scratch = GSharpProjectTransformerTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "source", "App", "App.csproj")
        let sourceRuntime = Path.Combine(scratch.Path, "source", "Runtime", "Runtime.csproj")
        let destinationDirectory = Path.Combine(scratch.Path, "generated", "App")
        let generatedRuntime = Path.Combine(scratch.Path, "generated", "Runtime", "Runtime.csproj")
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject)!!)
        Directory.CreateDirectory(destinationDirectory)
        File.WriteAllText(sourceProject, `<Project>
  <ItemGroup>
    <ProjectReference Include="$(MSBuildProjectDirectory)\..\Runtime\Runtime.csproj" />
    <ProjectReference Include="..\Runtime\Runtime.csproj;..\External\External.csproj" />
  </ItemGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            destinationDirectory,
            "Gsharp.NET.Sdk/1.0.0",
            Dictionary[string, string]{[Path.GetFullPath(sourceRuntime)] = generatedRuntime}
        )
        let references = ElementsNamed(transformed, "ProjectReference").ToArray()
        Assert.Equal(3, references.Length)
        Assert.Equal(
            "$$(MSBuildProjectDirectory)/../Runtime/Runtime.csproj",
            references[0].Attribute(XName?("Include")!!)?.Value
        )
        Assert.Equal("../Runtime/Runtime.csproj", references[1].Attribute(XName?("Include")!!)?.Value)
        Assert.Null(references[1].Attribute(XName?("ReferenceOutputAssembly")!!))
        Assert.Equal("..\\External\\External.csproj", references[2].Attribute(XName?("Include")!!)?.Value)
        Assert.Equal("false", references[2].Attribute(XName?("ReferenceOutputAssembly")!!)?.Value)
    }

    @Fact
    func Transform_UpgradesNerdbankGitVersioning() {
        using let scratch = GSharpProjectTransformerTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "App.csproj")
        File.WriteAllText(sourceProject, `<Project>
  <ItemGroup>
    <PackageReference Include="Nerdbank.GitVersioning" Version="3.7.115" PrivateAssets="all" />
  </ItemGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            scratch.Path,
            "Gsharp.NET.Sdk/1.0.0",
            Dictionary[string, string]()
        )
        let packageReference = SingleElement(transformed, "PackageReference")
        Assert.Equal("3.11.13-beta", packageReference.Attribute(XName?("Version")!!)?.Value)
    }

    @Theory
    @InlineData("Microsoft.NET.Sdk.Worker", false)
    @InlineData("Microsoft.NET.Sdk.Web", true)
    func Transform_PreservesExecutableSdkDefaults(sourceSdk string, expectsAspNetCore bool) {
        using let scratch = GSharpProjectTransformerTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "source", "App.csproj")
        let destinationDirectory = Path.Combine(scratch.Path, "generated", "App")
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject)!!)
        Directory.CreateDirectory(destinationDirectory)
        File.WriteAllText(sourceProject, (`<Project Sdk="` + "$sourceSdk" + `">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>`))
        let transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            destinationDirectory,
            "Gsharp.NET.Sdk/1.0.0",
            Dictionary[string, string]()
        )
        Assert.Equal("Exe", SingleElement(transformed, "OutputType").Value)
        let frameworkReference XElement? = ElementsNamed(transformed, "FrameworkReference").SingleOrDefault()
        Assert.Equal(expectsAspNetCore, frameworkReference != nil)
        if expectsAspNetCore {
            Assert.Equal("Microsoft.AspNetCore.App", frameworkReference?.Attribute(XName?("Include")!!)?.Value)
        }
    }

    // Issue #3674: the Pack* targets of this repo's own Gsharp.NET.Sdk.csproj
    // drive nested builds through <MSBuild Projects="…"/> and through
    // PropertyGroup properties holding project paths. Both shapes must follow
    // the migration set or the mirrored build fails with MSB3202.
    @Fact
    func Transform_RewritesNestedBuildProjectPathsForMigratedProjects() {
        using let scratch = GSharpProjectTransformerTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "source", "Sdk", "Sdk.csproj")
        let sourceCompiler = Path.Combine(scratch.Path, "source", "Compiler", "Compiler.csproj")
        let sourceTool = Path.Combine(scratch.Path, "source", "tools", "Gsgen", "Gsgen.csproj")
        let destinationDirectory = Path.Combine(scratch.Path, "generated", "Sdk")
        let generatedCompiler = Path.Combine(scratch.Path, "generated", "Compiler", "Compiler.gsproj")
        let generatedTool = Path.Combine(scratch.Path, "generated", "tools", "Gsgen", "Gsgen.gsproj")
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject)!!)
        Directory.CreateDirectory(destinationDirectory)
        File.WriteAllText(sourceProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <_CompilerProject>$(MSBuildThisFileDirectory)..\Compiler\Compiler.csproj</_CompilerProject>
    <_ExtensionsProject>$(MSBuildThisFileDirectory)..\Extensions\Extensions.csproj</_ExtensionsProject>
    <_ToolProject>$(MSBuildProjectDirectory)\..\tools\Gsgen\Gsgen.csproj</_ToolProject>
    <_Unrelated>net10.0</_Unrelated>
  </PropertyGroup>
  <Target Name="PackEverything">
    <MSBuild Projects="$(MSBuildThisFileDirectory)..\Compiler\Compiler.csproj" Targets="Publish" />
    <MSBuild Projects="..\tools\Gsgen\Gsgen.csproj; ..\Extensions\Extensions.csproj" Targets="Build" />
    <MSBuild Projects="$(_CompilerProject)" Targets="Build" />
  </Target>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            destinationDirectory,
            "Gsharp.NET.Sdk/1.0.0",
            Dictionary[string, string]{
                [Path.GetFullPath(sourceCompiler)] = generatedCompiler,
                [Path.GetFullPath(sourceTool)] = generatedTool
            }
        )
        Assert.Equal(
            "$$(MSBuildThisFileDirectory)../Compiler/Compiler.gsproj",
            SingleElement(transformed, "_CompilerProject").Value
        )
        Assert.Equal(
            "$$(MSBuildProjectDirectory)/../tools/Gsgen/Gsgen.gsproj",
            SingleElement(transformed, "_ToolProject").Value
        )
        // Not in the migration set: left verbatim rather than re-anchored at
        // the source repository.
        Assert.Equal(
            "$$(MSBuildThisFileDirectory)..\\Extensions\\Extensions.csproj",
            SingleElement(transformed, "_ExtensionsProject").Value
        )
        Assert.Equal("net10.0", SingleElement(transformed, "_Unrelated").Value)
        let nestedBuilds = ElementsNamed(transformed, "MSBuild").ToArray()
        Assert.Equal(
            "$$(MSBuildThisFileDirectory)../Compiler/Compiler.gsproj",
            nestedBuilds[0].Attribute(XName?("Projects")!!)?.Value
        )
        Assert.Equal("Publish", nestedBuilds[0].Attribute(XName?("Targets")!!)?.Value)
        Assert.Equal(
            "../tools/Gsgen/Gsgen.gsproj; ..\\Extensions\\Extensions.csproj",
            nestedBuilds[1].Attribute(XName?("Projects")!!)?.Value
        )
        // The property it names was rewritten, so the indirection needs no edit.
        Assert.Equal("$$(_CompilerProject)", nestedBuilds[2].Attribute(XName?("Projects")!!)?.Value)
    }

    @Fact
    func Transform_TurnsOffPackOnBuild() {
        using let scratch = GSharpProjectTransformerTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "Sdk.csproj")
        File.WriteAllText(sourceProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <GeneratePackageOnBuild>true</GeneratePackageOnBuild>
    <IsPackable>true</IsPackable>
  </PropertyGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            scratch.Path,
            "Gsharp.NET.Sdk/1.0.0",
            Dictionary[string, string]()
        )
        Assert.Equal("false", SingleElement(transformed, "GeneratePackageOnBuild").Value)
        Assert.Equal("true", SingleElement(transformed, "IsPackable").Value)
    }

    @Fact
    func Transform_LeavesUnresolvableNestedBuildProjectPathsUntouched() {
        using let scratch = GSharpProjectTransformerTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "source", "Sdk", "Sdk.csproj")
        let sourceCompiler = Path.Combine(scratch.Path, "source", "Compiler", "Compiler.csproj")
        let destinationDirectory = Path.Combine(scratch.Path, "generated", "Sdk")
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject)!!)
        Directory.CreateDirectory(destinationDirectory)
        File.WriteAllText(sourceProject, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <_FromUnknownRoot>$(RepoRoot)Compiler\Compiler.csproj</_FromUnknownRoot>
    <_ThroughProperty>$(MSBuildThisFileDirectory)..\$(Leaf)\Compiler.csproj</_ThroughProperty>
    <_Glob>$(MSBuildThisFileDirectory)..\**\*.csproj</_Glob>
    <_NotAProject>$(MSBuildThisFileDirectory)..\Compiler\Compiler.props</_NotAProject>
  </PropertyGroup>
  <Target Name="Pack">
    <MSBuild Projects="@(CompilerProjects)" Targets="Build" />
  </Target>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            destinationDirectory,
            "Gsharp.NET.Sdk/1.0.0",
            Dictionary[string, string]{
                [Path.GetFullPath(sourceCompiler)] = Path.Combine(
                    scratch.Path,
                    "generated",
                    "Compiler",
                    "Compiler.gsproj"
                )
            }
        )
        Assert.Equal("$$(RepoRoot)Compiler\\Compiler.csproj", SingleElement(transformed, "_FromUnknownRoot").Value)
        Assert.Equal(
            "$$(MSBuildThisFileDirectory)..\\$$(Leaf)\\Compiler.csproj",
            SingleElement(transformed, "_ThroughProperty").Value
        )
        Assert.Equal("$$(MSBuildThisFileDirectory)..\\**\\*.csproj", SingleElement(transformed, "_Glob").Value)
        Assert.Equal(
            "$$(MSBuildThisFileDirectory)..\\Compiler\\Compiler.props",
            SingleElement(transformed, "_NotAProject").Value
        )
        Assert.Equal(
            "@(CompilerProjects)",
            SingleElement(transformed, "MSBuild").Attribute(XName?("Projects")!!)?.Value
        )
    }

    @Fact
    func Transform_PropagatesMalformedXmlException() {
        using let scratch = GSharpProjectTransformerTests.ScratchDirectory()
        let sourceProject = Path.Combine(scratch.Path, "Malformed.csproj")
        File.WriteAllText(sourceProject, "<Project><PropertyGroup></Project>")
        Assert.Throws[XmlException](
            func () object? {
                return GSharpProjectTransformer.Transform(
                    sourceProject,
                    scratch.Path,
                    "Gsharp.NET.Sdk/1.0.0",
                    Dictionary[string, string]()
                )
            }
        )
    }

    private class ScratchDirectory : IDisposable {
        init() {
            this.Path = Path.Combine(
                AppContext.BaseDirectory,
                "scratch-projects",
                "project-transformer",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(this.Path)
        }

        prop Path string {
            get;
        }

        func Dispose() {
            Directory.Delete(this.Path, recursive: true)
        }
    }

    shared {
        private func ElementsNamed(container XContainer, localName string) IEnumerable[XElement] -> container
            .Descendants().Where(
            (element XElement) -> element.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase)
        )

        private func SingleElement(container XContainer, localName string) XElement -> Assert.Single(
            ElementsNamed(container, localName)
        )
    }
}
