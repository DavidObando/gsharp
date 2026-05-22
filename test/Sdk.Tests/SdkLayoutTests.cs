// <copyright file="SdkLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Xml.Linq;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Structural tests over the files that ship inside the <c>Gsharp.NET.Sdk</c>
/// NuGet. These pin the shape MSBuild relies on when it loads the SDK as
/// <c>&lt;Project Sdk="Gsharp.NET.Sdk"&gt;</c> so accidental edits to the
/// .props/.targets surface immediately rather than at consumer build time.
/// </summary>
public class SdkLayoutTests
{
    private static readonly XNamespace MsbuildNs =
        "http://schemas.microsoft.com/developer/msbuild/2003";

    [Fact]
    public void Sdk_Props_Imports_MicrosoftNetSdk_And_Gsharp_Build_Props()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.props");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var imports = doc.Descendants(MsbuildNs + "Import").ToList();

        Assert.Contains(imports, i =>
            (string)i.Attribute("Sdk") == "Microsoft.NET.Sdk"
            && (string)i.Attribute("Project") == "Sdk.props");

        Assert.Contains(imports, i =>
            ((string)i.Attribute("Project") ?? string.Empty).EndsWith(
                "Gsharp.NET.Sdk.props",
                System.StringComparison.Ordinal));
    }

    [Fact]
    public void Sdk_Targets_Imports_MicrosoftNetSdk_Targets()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.targets");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var imports = doc.Descendants(MsbuildNs + "Import").ToList();

        Assert.Contains(imports, i =>
            (string)i.Attribute("Sdk") == "Microsoft.NET.Sdk"
            && (string)i.Attribute("Project") == "Sdk.targets");
    }

    [Fact]
    public void Build_Props_Sets_Language_And_Tool_Paths_And_LanguageTargets()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Sdk.props");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var props = doc.Descendants(MsbuildNs + "PropertyGroup")
            .Elements()
            .ToDictionary(e => e.Name.LocalName, e => e.Value, System.StringComparer.Ordinal);

        Assert.Equal("Gsharp", props["Language"]);
        Assert.Equal("Managed", props["TargetRuntime"]);
        Assert.Contains("Gsharp.NET.Sdk.dll", props["GsharpToolFullPath"]);
        Assert.Contains("gsc.dll", props["GsharpCompilerFullPath"]);
        Assert.Contains("Gsharp.NET.Current.Sdk.targets", props["LanguageTargets"]);
    }

    [Fact]
    public void Core_Targets_Declares_BuildTask_And_CoreCompile_Override()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);

        var usingTask = doc.Descendants(MsbuildNs + "UsingTask").Single();
        Assert.Equal("Gsharp.NET.Sdk.Tools.BuildTask", (string)usingTask.Attribute("TaskName"));
        Assert.Equal("$(GsharpToolFullPath)", (string)usingTask.Attribute("AssemblyFile"));

        var coreCompile = doc.Descendants(MsbuildNs + "Target")
            .FirstOrDefault(t => (string)t.Attribute("Name") == "CoreCompile");
        Assert.NotNull(coreCompile);

        var buildTask = coreCompile.Element(MsbuildNs + "BuildTask");
        Assert.NotNull(buildTask);

        // The BuildTask invocation has to forward the inputs gsc actually
        // consumes; if any of these drop off, consumer builds silently no-op.
        var attrs = buildTask!.Attributes().ToDictionary(a => a.Name.LocalName, a => a.Value);
        Assert.Equal("$(GsharpCompilerFullPath)", attrs["GsharpCompilerFullPath"]);
        Assert.Equal("@(Compile)", attrs["Compile"]);
        Assert.Equal("@(ReferencePath)", attrs["References"]);
        Assert.Equal("$(OutputType)", attrs["OutputType"]);
        Assert.Equal("$(TargetFramework)", attrs["TargetFramework"]);
    }

    [Fact]
    public void Sdk_Csproj_Packs_As_MSBuildSdk()
    {
        var csproj = Path.Combine(RepoRoot.SdkSourceDir, "Gsharp.NET.Sdk.csproj");
        Assert.True(File.Exists(csproj), csproj);

        var text = File.ReadAllText(csproj);
        // The SDK must ship its tools (gsc + build task) and propsfiles
        // alongside Sdk.props/Sdk.targets so msbuild can resolve it.
        Assert.Contains("netstandard2.0", text, System.StringComparison.Ordinal);
        Assert.Contains("Microsoft.Build.Framework", text, System.StringComparison.Ordinal);
        Assert.Contains("Microsoft.Build.Utilities.Core", text, System.StringComparison.Ordinal);
    }
}
