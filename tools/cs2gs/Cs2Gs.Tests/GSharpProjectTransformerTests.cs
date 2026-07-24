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
