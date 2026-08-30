// <copyright file="GSharpProjectTransformerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Tests for <see cref="GSharpProjectTransformer"/>.</summary>
public sealed class GSharpProjectTransformerTests
{
    [Fact]
    public void Transform_RewritesSdkReferencesCompileSpecsAndMetadata()
    {
        using var scratch = new ScratchDirectory();
        string sourceProject = Path.Combine(scratch.Path, "source", "App", "App.csproj");
        string sourceLibrary = Path.Combine(scratch.Path, "source", "Lib", "Lib.csproj");
        string destinationDirectory = Path.Combine(scratch.Path, "generated", "App");
        string generatedLibrary = Path.Combine(scratch.Path, "generated", "Lib", "Lib.gsproj");
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject));
        Directory.CreateDirectory(destinationDirectory);
        File.WriteAllText(
            sourceProject,
            """
            <Project Sdk="Microsoft.NET.Sdk">
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
            </Project>
            """);

        XDocument transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            destinationDirectory,
            "Gsharp.NET.Sdk/2.3.4",
            new Dictionary<string, string>
            {
                [Path.GetFullPath(sourceLibrary)] = generatedLibrary,
            });

        Assert.Equal("Gsharp.NET.Sdk/2.3.4", transformed.Root?.Attribute("Sdk")?.Value);

        XElement projectReference = SingleElement(transformed, "ProjectReference");
        Assert.Equal(
            Path.GetRelativePath(destinationDirectory, generatedLibrary).Replace('\\', '/'),
            projectReference.Attribute("Include")?.Value);
        Assert.Equal("library", projectReference.Attribute("Aliases")?.Value);
        Assert.Equal("all", SingleElement(projectReference, "PrivateAssets").Value);

        XElement[] compileItems = ElementsNamed(transformed, "Compile").ToArray();
        Assert.Equal(
            "Program.gs; Generated\\**\\*.gs ; readme.txt",
            compileItems[0].Attribute("Include")?.Value);
        Assert.Equal("Forms\\Main.gs", compileItems[1].Attribute("Update")?.Value);
        Assert.Equal("obj/**/*.gs;notes.csx", compileItems[2].Attribute("Remove")?.Value);
        Assert.Equal("Program.generated.gs", SingleElement(transformed, "LastGenOutput").Value);
        Assert.Equal(" Program.gs ", SingleElement(transformed, "DependentUpon").Value);
        Assert.Equal("keep.cs", SingleElement(transformed, "CustomMetadata").Value);

        Assert.Equal(
            "'$(Configuration)' == 'Release'",
            SingleElement(transformed, "PropertyGroup").Attribute("Condition")?.Value);
        Assert.Equal("Exe", SingleElement(transformed, "OutputType").Value);
        Assert.Equal("unchanged", SingleElement(transformed, "CustomProperty").Value);
        Assert.Equal("Exists('custom')", SingleElement(transformed, "Import").Attribute("Condition")?.Value);
        Assert.Equal("untouched", SingleElement(transformed, "Message").Attribute("Text")?.Value);
        Assert.Contains("  <!-- keep this comment -->", transformed.ToString(SaveOptions.DisableFormatting));
    }

    [Fact]
    public void Transform_LeavesUnmappedReferenceAndRewritesExpressions()
    {
        using var scratch = new ScratchDirectory();
        string sourceProject = Path.Combine(scratch.Path, "source", "App.csproj");
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject));
        File.WriteAllText(
            sourceProject,
            """
            <Project>
              <ItemGroup>
                <ProjectReference Include="../External/External.csproj" Condition="'$(UseExternal)' == 'true'" />
                <ProjectReference Include="$(SharedProject)" />
                <ProjectReference Include="@(SharedProjects)" />
                <ProjectReference Include="@(GeneratedProjects); ../Other/Other.csproj" />
              </ItemGroup>
            </Project>
            """);

        XDocument transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            Path.Combine(scratch.Path, "generated"),
            "Gsharp.NET.Sdk/1.0.0",
            new Dictionary<string, string>
            {
                [Path.Combine(scratch.Path, "source", "Other.csproj")] =
                    Path.Combine(scratch.Path, "generated", "Other.gsproj"),
            });

        XElement[] references = ElementsNamed(transformed, "ProjectReference").ToArray();
        Assert.Equal("../External/External.csproj", references[0].Attribute("Include")?.Value);
        Assert.Equal("'$(UseExternal)' == 'true'", references[0].Attribute("Condition")?.Value);
        Assert.Equal(
            "$([System.IO.Path]::ChangeExtension('$(SharedProject)', '.gsproj'))",
            references[1].Attribute("Include")?.Value);
        Assert.Equal(
            "@(SharedProjects->'%(RootDir)%(Directory)%(Filename).gsproj')",
            references[2].Attribute("Include")?.Value);
        Assert.Equal(
            "@(GeneratedProjects->'%(RootDir)%(Directory)%(Filename).gsproj'); ../Other/Other.gsproj",
            references[3].Attribute("Include")?.Value);
        Assert.Equal("Gsharp.NET.Sdk/1.0.0", transformed.Root?.Attribute("Sdk")?.Value);
    }

    [Fact]
    public void Transform_UpgradesNerdbankGitVersioning()
    {
        using var scratch = new ScratchDirectory();
        string sourceProject = Path.Combine(scratch.Path, "App.csproj");
        File.WriteAllText(
            sourceProject,
            """
            <Project>
              <ItemGroup>
                <PackageReference Include="Nerdbank.GitVersioning" Version="3.7.115" PrivateAssets="all" />
              </ItemGroup>
            </Project>
            """);

        XDocument transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            scratch.Path,
            "Gsharp.NET.Sdk/1.0.0",
            new Dictionary<string, string>());

        XElement packageReference = SingleElement(transformed, "PackageReference");
        Assert.Equal("3.11.13-beta", packageReference.Attribute("Version")?.Value);
    }

    [Theory]
    [InlineData("Microsoft.NET.Sdk.Worker", false)]
    [InlineData("Microsoft.NET.Sdk.Web", true)]
    public void Transform_PreservesExecutableSdkDefaults(string sourceSdk, bool expectsAspNetCore)
    {
        using var scratch = new ScratchDirectory();
        string sourceProject = Path.Combine(scratch.Path, "source", "App.csproj");
        string destinationDirectory = Path.Combine(scratch.Path, "generated", "App");
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject));
        Directory.CreateDirectory(destinationDirectory);
        File.WriteAllText(
            sourceProject,
            $"""
            <Project Sdk="{sourceSdk}">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);

        XDocument transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            destinationDirectory,
            "Gsharp.NET.Sdk/1.0.0",
            new Dictionary<string, string>());

        Assert.Equal("Exe", SingleElement(transformed, "OutputType").Value);
        XElement frameworkReference = ElementsNamed(transformed, "FrameworkReference").SingleOrDefault();
        Assert.Equal(expectsAspNetCore, frameworkReference != null);
        if (expectsAspNetCore)
        {
            Assert.Equal("Microsoft.AspNetCore.App", frameworkReference?.Attribute("Include")?.Value);
        }
    }

    // Issue #3674: the Pack* targets of this repo's own Gsharp.NET.Sdk.csproj
    // drive nested builds through <MSBuild Projects="…"/> and through
    // PropertyGroup properties holding project paths. Both shapes must follow
    // the migration set or the mirrored build fails with MSB3202.
    [Fact]
    public void Transform_RewritesNestedBuildProjectPathsForMigratedProjects()
    {
        using var scratch = new ScratchDirectory();
        string sourceProject = Path.Combine(scratch.Path, "source", "Sdk", "Sdk.csproj");
        string sourceCompiler = Path.Combine(scratch.Path, "source", "Compiler", "Compiler.csproj");
        string sourceTool = Path.Combine(scratch.Path, "source", "tools", "Gsgen", "Gsgen.csproj");
        string destinationDirectory = Path.Combine(scratch.Path, "generated", "Sdk");
        string generatedCompiler = Path.Combine(scratch.Path, "generated", "Compiler", "Compiler.gsproj");
        string generatedTool = Path.Combine(scratch.Path, "generated", "tools", "Gsgen", "Gsgen.gsproj");
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject));
        Directory.CreateDirectory(destinationDirectory);
        File.WriteAllText(
            sourceProject,
            """
            <Project Sdk="Microsoft.NET.Sdk">
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
            </Project>
            """);

        XDocument transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            destinationDirectory,
            "Gsharp.NET.Sdk/1.0.0",
            new Dictionary<string, string>
            {
                [Path.GetFullPath(sourceCompiler)] = generatedCompiler,
                [Path.GetFullPath(sourceTool)] = generatedTool,
            });

        Assert.Equal(
            "$(MSBuildThisFileDirectory)../Compiler/Compiler.gsproj",
            SingleElement(transformed, "_CompilerProject").Value);
        Assert.Equal(
            "$(MSBuildProjectDirectory)/../tools/Gsgen/Gsgen.gsproj",
            SingleElement(transformed, "_ToolProject").Value);

        // Not in the migration set: left verbatim rather than re-anchored at
        // the source repository.
        Assert.Equal(
            "$(MSBuildThisFileDirectory)..\\Extensions\\Extensions.csproj",
            SingleElement(transformed, "_ExtensionsProject").Value);
        Assert.Equal("net10.0", SingleElement(transformed, "_Unrelated").Value);

        XElement[] nestedBuilds = ElementsNamed(transformed, "MSBuild").ToArray();
        Assert.Equal(
            "$(MSBuildThisFileDirectory)../Compiler/Compiler.gsproj",
            nestedBuilds[0].Attribute("Projects")?.Value);
        Assert.Equal("Publish", nestedBuilds[0].Attribute("Targets")?.Value);
        Assert.Equal(
            "../tools/Gsgen/Gsgen.gsproj; ..\\Extensions\\Extensions.csproj",
            nestedBuilds[1].Attribute("Projects")?.Value);

        // The property it names was rewritten, so the indirection needs no edit.
        Assert.Equal("$(_CompilerProject)", nestedBuilds[2].Attribute("Projects")?.Value);
    }

    [Fact]
    public void Transform_TurnsOffPackOnBuild()
    {
        using var scratch = new ScratchDirectory();
        string sourceProject = Path.Combine(scratch.Path, "Sdk.csproj");
        File.WriteAllText(
            sourceProject,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <GeneratePackageOnBuild>true</GeneratePackageOnBuild>
                <IsPackable>true</IsPackable>
              </PropertyGroup>
            </Project>
            """);

        XDocument transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            scratch.Path,
            "Gsharp.NET.Sdk/1.0.0",
            new Dictionary<string, string>());

        Assert.Equal("false", SingleElement(transformed, "GeneratePackageOnBuild").Value);
        Assert.Equal("true", SingleElement(transformed, "IsPackable").Value);
    }

    [Fact]
    public void Transform_LeavesUnresolvableNestedBuildProjectPathsUntouched()
    {
        using var scratch = new ScratchDirectory();
        string sourceProject = Path.Combine(scratch.Path, "source", "Sdk", "Sdk.csproj");
        string sourceCompiler = Path.Combine(scratch.Path, "source", "Compiler", "Compiler.csproj");
        string destinationDirectory = Path.Combine(scratch.Path, "generated", "Sdk");
        Directory.CreateDirectory(Path.GetDirectoryName(sourceProject));
        Directory.CreateDirectory(destinationDirectory);
        File.WriteAllText(
            sourceProject,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <_FromUnknownRoot>$(RepoRoot)Compiler\Compiler.csproj</_FromUnknownRoot>
                <_ThroughProperty>$(MSBuildThisFileDirectory)..\$(Leaf)\Compiler.csproj</_ThroughProperty>
                <_Glob>$(MSBuildThisFileDirectory)..\**\*.csproj</_Glob>
                <_NotAProject>$(MSBuildThisFileDirectory)..\Compiler\Compiler.props</_NotAProject>
              </PropertyGroup>
              <Target Name="Pack">
                <MSBuild Projects="@(CompilerProjects)" Targets="Build" />
              </Target>
            </Project>
            """);

        XDocument transformed = GSharpProjectTransformer.Transform(
            sourceProject,
            destinationDirectory,
            "Gsharp.NET.Sdk/1.0.0",
            new Dictionary<string, string>
            {
                [Path.GetFullPath(sourceCompiler)] =
                    Path.Combine(scratch.Path, "generated", "Compiler", "Compiler.gsproj"),
            });

        Assert.Equal(
            "$(RepoRoot)Compiler\\Compiler.csproj",
            SingleElement(transformed, "_FromUnknownRoot").Value);
        Assert.Equal(
            "$(MSBuildThisFileDirectory)..\\$(Leaf)\\Compiler.csproj",
            SingleElement(transformed, "_ThroughProperty").Value);
        Assert.Equal(
            "$(MSBuildThisFileDirectory)..\\**\\*.csproj",
            SingleElement(transformed, "_Glob").Value);
        Assert.Equal(
            "$(MSBuildThisFileDirectory)..\\Compiler\\Compiler.props",
            SingleElement(transformed, "_NotAProject").Value);
        Assert.Equal(
            "@(CompilerProjects)",
            SingleElement(transformed, "MSBuild").Attribute("Projects")?.Value);
    }

    [Fact]
    public void Transform_PropagatesMalformedXmlException()
    {
        using var scratch = new ScratchDirectory();
        string sourceProject = Path.Combine(scratch.Path, "Malformed.csproj");
        File.WriteAllText(sourceProject, "<Project><PropertyGroup></Project>");

        Assert.Throws<XmlException>(() => GSharpProjectTransformer.Transform(
            sourceProject,
            scratch.Path,
            "Gsharp.NET.Sdk/1.0.0",
            new Dictionary<string, string>()));
    }

    private static IEnumerable<XElement> ElementsNamed(XContainer container, string localName) =>
        container.Descendants().Where(
            element => element.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase));

    private static XElement SingleElement(XContainer container, string localName) =>
        Assert.Single(ElementsNamed(container, localName));

    private sealed class ScratchDirectory : IDisposable
    {
        public ScratchDirectory()
        {
            this.Path = System.IO.Path.Combine(
                AppContext.BaseDirectory,
                "scratch-projects",
                "project-transformer",
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
