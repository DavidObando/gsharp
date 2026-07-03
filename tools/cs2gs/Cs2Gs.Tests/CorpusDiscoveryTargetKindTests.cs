// <copyright file="CorpusDiscoveryTargetKindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1749 mode 3: <c>CorpusDiscovery.ReadTargetKind</c>
/// used to match the literal substring <c>&lt;OutputType&gt;Exe&lt;/OutputType&gt;</c>,
/// so any benign reformat (extra whitespace, an attribute, <c>WinExe</c>)
/// silently reclassified the app as <see cref="TargetKind.Library"/>, which
/// flips <c>gsc</c> to <c>/target:library</c> and — because stdout-parity
/// requires <see cref="TargetKind.Exe"/> — drops stdout-parity verification
/// entirely. The fix parses the csproj as XML instead.
/// </summary>
public class CorpusDiscoveryTargetKindTests
{
    [Theory]
    [InlineData("<OutputType>Exe</OutputType>", TargetKind.Exe)]
    [InlineData("<OutputType> Exe </OutputType>", TargetKind.Exe)]
    [InlineData("<OutputType>WinExe</OutputType>", TargetKind.Exe)]
    [InlineData("<OutputType>exe</OutputType>", TargetKind.Exe)]
    [InlineData("<OutputType>Library</OutputType>", TargetKind.Library)]
    [InlineData("", TargetKind.Library)]
    [InlineData("<OutputType Condition=\"'$(Configuration)'=='Debug'\">Exe</OutputType>", TargetKind.Exe)]
    public void Discover_ClassifiesTargetKind_FromParsedOutputType(string outputTypeElement, TargetKind expected)
    {
        string appDir = NewScratchApp("MyApp", outputTypeElement);

        CorpusApp app = Assert.Single(CorpusDiscovery.Discover(Path.GetDirectoryName(appDir)));

        Assert.Equal(expected, app.TargetKind);
    }

    /// <summary>
    /// The old literal substring match's exact failure cases (formatting or a
    /// <c>WinExe</c> variant) must now classify as <see cref="TargetKind.Exe"/>,
    /// not silently fall back to <see cref="TargetKind.Library"/>.
    /// </summary>
    [Theory]
    [InlineData("<OutputType> Exe </OutputType>")]
    [InlineData("<OutputType>WinExe</OutputType>")]
    public void Discover_FormattingOrWinExe_NeverMisclassifiesAsLibrary(string outputTypeElement)
    {
        string appDir = NewScratchApp("ReformattedApp", outputTypeElement);

        CorpusApp app = Assert.Single(CorpusDiscovery.Discover(Path.GetDirectoryName(appDir)));

        Assert.Equal(TargetKind.Exe, app.TargetKind);
    }

    /// <summary>
    /// Multiple <c>PropertyGroup</c>s (SDK-style, with an earlier stale value)
    /// resolve to the last <c>OutputType</c> in document order.
    /// </summary>
    [Fact]
    public void Discover_MultiplePropertyGroups_LastOutputTypeWins()
    {
        string root = NewScratchDir("multi-propertygroup");
        string appFolder = Path.Combine(root, "MultiApp");
        Directory.CreateDirectory(appFolder);
        File.WriteAllText(Path.Combine(appFolder, "MultiApp.csproj"), $@"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
  <PropertyGroup>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
</Project>
");
        File.WriteAllText(Path.Combine(appFolder, "Program.cs"), "class Program { static void Main() { } }");

        CorpusApp app = Assert.Single(CorpusDiscovery.Discover(root));

        Assert.Equal(TargetKind.Exe, app.TargetKind);
    }

    private static string NewScratchApp(string appName, string outputTypeElement)
    {
        string root = NewScratchDir(appName);
        string appFolder = Path.Combine(root, appName);
        Directory.CreateDirectory(appFolder);
        File.WriteAllText(Path.Combine(appFolder, appName + ".csproj"), $@"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    {outputTypeElement}
  </PropertyGroup>
</Project>
");
        File.WriteAllText(Path.Combine(appFolder, "Program.cs"), "class Program { static void Main() { } }");
        return appFolder;
    }

    private static string NewScratchDir(string label)
    {
        // Not AppContext.BaseDirectory: it sits under out/bin/<Config>/..., and
        // CorpusDiscovery.Discover deliberately excludes anything under a
        // "/bin/" or "/obj/" path segment (build output noise), which would
        // make Discover find zero apps here.
        string root = Path.Combine(Path.GetTempPath(), "cs2gs-corpus-discovery-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }
}
