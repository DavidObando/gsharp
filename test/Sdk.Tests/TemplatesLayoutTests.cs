// <copyright file="TemplatesLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Text.Json;
using System.Xml.Linq;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Sanity checks the <c>Gsharp.Templates</c> package content: <c>template.json</c>
/// metadata, the scaffolded <c>.gsproj</c> using <c>Gsharp.NET.Sdk</c>, and the
/// sample sources we ship for <c>dotnet new gsharp-console</c>.
/// </summary>
public class TemplatesLayoutTests
{
    private static readonly string ContentRoot =
        Path.Combine(RepoRoot.TemplatesSourceDir, "content", "gsharp-console");

    [Fact]
    public void TemplateConfig_Has_Expected_Identity_And_ShortName()
    {
        var path = Path.Combine(ContentRoot, ".template.config", "template.json");
        Assert.True(File.Exists(path), path);

        using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = doc.RootElement;

        Assert.Equal("GSharp.Templates.Console", root.GetProperty("identity").GetString());
        Assert.Equal("gsharp-console", root.GetProperty("shortName").GetString());
        Assert.Equal("GsharpConsoleApp", root.GetProperty("sourceName").GetString());
        Assert.Equal("project", root.GetProperty("tags").GetProperty("type").GetString());
    }

    [Fact]
    public void Scaffolded_Gsproj_Uses_GsharpNetSdk_And_Compiles_GsFiles()
    {
        var path = Path.Combine(ContentRoot, "GsharpConsoleApp.gsproj");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var sdkAttr = (string)doc.Root.Attribute("Sdk");
        Assert.StartsWith("Gsharp.NET.Sdk", sdkAttr, System.StringComparison.Ordinal);

        var text = File.ReadAllText(path);
        Assert.Contains("<OutputType>Exe</OutputType>", text, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Scaffolded_Program_Has_Package_And_TopLevel_WriteLine()
    {
        var path = Path.Combine(ContentRoot, "Program.gs");
        Assert.True(File.Exists(path), path);

        var src = File.ReadAllText(path);
        Assert.Contains("package ", src, System.StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine", src, System.StringComparison.Ordinal);
    }

    [Fact]
    public void HelloWorld_Sample_Uses_GsharpNetSdk()
    {
        var path = Path.Combine(RepoRoot.SamplesDir, "HelloWorld", "HelloWorld.gsproj");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        Assert.Equal("Gsharp.NET.Sdk", (string)doc.Root.Attribute("Sdk"));
    }
}
