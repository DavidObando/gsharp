// <copyright file="Issue3772MirrorFidelityTests.cs" company="GSharp">
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

/// <summary>
/// Issue #3772: the migrated tree is a repository, not a bag of projects. Code
/// in the mirror probes the repository layout it was written against — the
/// solution that names the repository root, and the projects its own project
/// files reference — so the mirror has to reproduce both.
/// </summary>
public sealed class Issue3772MirrorFidelityTests : IDisposable
{
    private readonly string root;

    /// <summary>Initializes a new isolated test directory.</summary>
    public Issue3772MirrorFidelityTests()
    {
        this.root = Path.Combine(
            Path.GetTempPath(),
            "issue-3772-mirror-fidelity",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    /// <summary>Removes the isolated test directory.</summary>
    public void Dispose()
    {
        Directory.Delete(this.root, recursive: true);
    }

    /// <summary>
    /// An excluded project with nothing to translate keeps its project file, so
    /// the mirror never holds a project directory without its project.
    /// </summary>
    [Fact]
    public void MirrorExcludedProjects_AlreadyGsharpProject_IsMirroredWithRetargetedReferences()
    {
        string source = Path.Combine(this.root, "source");
        string destination = Path.Combine(this.root, "destination");
        string extensionsDirectory = Path.Combine(source, "src", "Sdk", "Gsharp.Extensions");
        Directory.CreateDirectory(extensionsDirectory);
        Directory.CreateDirectory(Path.Combine(source, "src", "Compiler"));
        File.WriteAllText(Path.Combine(source, "src", "Compiler", "Compiler.csproj"), "<Project />");
        File.WriteAllText(Path.Combine(extensionsDirectory, "Optional.gs"), "func none() {}");
        File.WriteAllText(
            Path.Combine(extensionsDirectory, "Gsharp.Extensions.csproj"),
            """
            <Project>
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
            </Project>
            """);

        var scope = ExcludedScope(source, Path.Combine(extensionsDirectory, "Gsharp.Extensions.csproj"));
        IReadOnlyList<string> written = RepositoryMirror.MirrorExcludedProjects(
            source,
            destination,
            new[]
            {
                "src/Compiler/Compiler.csproj",
                "src/Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj",
                "src/Sdk/Gsharp.Extensions/Optional.gs",
            },
            scope,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                [Path.Combine(source, "src", "Compiler", "Compiler.csproj")] =
                    Path.Combine(destination, "src", "Compiler", "Compiler.gsproj"),
            },
            "Gsharp.NET.Sdk/9.9.9-test");

        Assert.Equal(
            new[] { Path.Combine("src", "Sdk", "Gsharp.Extensions", "Gsharp.Extensions.csproj") },
            written.ToArray());
        string mirrored = Path.Combine(
            destination, "src", "Sdk", "Gsharp.Extensions", "Gsharp.Extensions.csproj");
        XDocument document = XDocument.Load(mirrored, LoadOptions.PreserveWhitespace);
        Assert.Equal(
            "../../Compiler/Compiler.gsproj",
            document.Descendants("ProjectReference").Single().Attribute("Include").Value);
        Assert.Contains("keep me", File.ReadAllText(mirrored), StringComparison.Ordinal);

        // Rebound onto the pinned SDK: no bootstrap imports and none of the
        // bootstrap's toolchain-only build-ordering references.
        Assert.Equal("Gsharp.NET.Sdk/9.9.9-test", document.Root.Attribute("Sdk").Value);
        Assert.Empty(document.Descendants("Import"));
        Assert.Equal(
            "Gsharp.Extensions",
            document.Descendants("AssemblyName").Single().Value);
    }

    /// <summary>
    /// An excluded project whose C# sources were left untranslated stays out of
    /// the mirror: mirroring it would produce a project with no sources.
    /// </summary>
    [Fact]
    public void MirrorExcludedProjects_ProjectWithCSharpSources_IsNotMirrored()
    {
        string source = Path.Combine(this.root, "source");
        string destination = Path.Combine(this.root, "destination");
        string extensionDirectory = Path.Combine(source, "src", "vs-gsharp", "src", "VsGsharp");
        Directory.CreateDirectory(extensionDirectory);
        File.WriteAllText(Path.Combine(extensionDirectory, "VsGsharp.csproj"), "<Project />");
        File.WriteAllText(Path.Combine(extensionDirectory, "Package.cs"), "class Package {}");

        var scope = ExcludedScope(source, Path.Combine(extensionDirectory, "VsGsharp.csproj"));
        IReadOnlyList<string> written = RepositoryMirror.MirrorExcludedProjects(
            source,
            destination,
            new[]
            {
                "src/vs-gsharp/src/VsGsharp/Package.cs",
                "src/vs-gsharp/src/VsGsharp/VsGsharp.csproj",
            },
            scope,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
            "Gsharp.NET.Sdk/9.9.9-test");

        Assert.Empty(written);
    }

    /// <summary>
    /// A legacy solution is mirrored under its own name — the file name the
    /// repository's own sources use to find the repository root — with its
    /// project paths retargeted, and the buildable `.slnx` lands beside it.
    /// </summary>
    [Fact]
    public void Generate_LegacySolution_MirrorsSlnAndEmitsSlnx()
    {
        string source = Path.Combine(this.root, "source");
        string destination = Path.Combine(this.root, "destination");
        Directory.CreateDirectory(Path.Combine(source, "src", "App"));
        string sourceProject = Path.Combine(source, "src", "App", "App.csproj");
        File.WriteAllText(
            sourceProject,
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup>" +
            "<TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>");
        File.WriteAllText(
            Path.Combine(source, "Product.sln"),
            """
            Microsoft Visual Studio Solution File, Format Version 12.00
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

            """);

        IReadOnlyList<string> written = RepositorySolutionGenerator.Generate(
            source,
            destination,
            new Dictionary<string, string>
            {
                [sourceProject] = Path.Combine(destination, "src", "App", "App.gsproj"),
            });

        string mirroredSln = Path.Combine(destination, "Product.sln");
        string convertedSlnx = Path.Combine(destination, "Product.slnx");
        Assert.Equal(
            new[] { mirroredSln, convertedSlnx }.OrderBy(path => path, StringComparer.Ordinal).ToArray(),
            written.OrderBy(path => path, StringComparer.Ordinal).ToArray());

        string legacy = File.ReadAllText(mirroredSln);
        Assert.Contains(@"""src\App\App.gsproj""", legacy, StringComparison.Ordinal);
        Assert.DoesNotContain("App.csproj", legacy, StringComparison.Ordinal);
        Assert.Contains("{2E0F0D1B-5E52-4A2A-9C7C-1E5B0F6A7B31}", legacy, StringComparison.Ordinal);
        Assert.Contains("GlobalSection(ProjectConfigurationPlatforms)", legacy, StringComparison.Ordinal);

        Assert.Equal(
            "src/App/App.gsproj",
            XDocument.Load(convertedSlnx).Descendants("Project").Single().Attribute("Path").Value);
    }

    /// <summary>
    /// The completeness contract expects both mirrored solution files, so a
    /// mirror that reproduces the repository's own layout validates clean.
    /// </summary>
    [Fact]
    public void ValidateCompleted_MirroredSlnAndSlnx_AreBothExpected()
    {
        string source = Path.Combine(this.root, "source");
        string destination = Path.Combine(this.root, "destination");
        Directory.CreateDirectory(source);
        Directory.CreateDirectory(destination);
        File.WriteAllText(Path.Combine(destination, "Product.sln"), "legacy");
        File.WriteAllText(Path.Combine(destination, "Product.slnx"), "<Solution />");

        RepositoryMirror.ValidateCompleted(source, destination, new[] { "Product.sln" });

        File.Delete(Path.Combine(destination, "Product.sln"));
        InvalidOperationException missing = Assert.Throws<InvalidOperationException>(
            () => RepositoryMirror.ValidateCompleted(source, destination, new[] { "Product.sln" }));
        Assert.Contains("Product.sln", missing.Message, StringComparison.Ordinal);
    }

    private static RepositoryExcludedScope ExcludedScope(string sourceRoot, string excludedProject) =>
        RepositoryExcludedScope.Compute(sourceRoot, new[] { excludedProject });
}
