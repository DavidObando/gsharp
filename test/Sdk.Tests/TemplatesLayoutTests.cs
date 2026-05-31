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
/// sample sources we ship for each <c>dotnet new</c> template.
/// </summary>
public class TemplatesLayoutTests
{
    private static readonly string TemplatesContentRoot =
        Path.Combine(RepoRoot.TemplatesSourceDir, "content");

    private static readonly string ConsoleContentRoot =
        Path.Combine(TemplatesContentRoot, "gsharp-console");

    private static readonly string LibContentRoot =
        Path.Combine(TemplatesContentRoot, "gsharp-lib");

    private static readonly string WebContentRoot =
        Path.Combine(TemplatesContentRoot, "gsharp-web");

    private static readonly string XunitContentRoot =
        Path.Combine(TemplatesContentRoot, "gsharp-xunit");

    [Fact]
    public void TemplateConfig_Has_Expected_Identity_And_ShortName()
    {
        var path = Path.Combine(ConsoleContentRoot, ".template.config", "template.json");
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
        var path = Path.Combine(ConsoleContentRoot, "GsharpConsoleApp.gsproj");
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
        var path = Path.Combine(ConsoleContentRoot, "Program.gs");
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

    [Fact]
    public void Lib_Template_Has_Expected_Identity_And_ShortName()
    {
        var path = Path.Combine(LibContentRoot, ".template.config", "template.json");
        Assert.True(File.Exists(path), path);

        using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = doc.RootElement;

        Assert.Equal("GSharp.Templates.Library", root.GetProperty("identity").GetString());
        Assert.Equal("gsharp-lib", root.GetProperty("shortName").GetString());
        Assert.Equal("GsharpLibrary", root.GetProperty("sourceName").GetString());
        Assert.Equal("project", root.GetProperty("tags").GetProperty("type").GetString());
    }

    [Fact]
    public void Lib_Template_Gsproj_Targets_Library_With_GsharpNetSdk()
    {
        var path = Path.Combine(LibContentRoot, "GsharpLibrary.gsproj");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var sdkAttr = (string)doc.Root.Attribute("Sdk");
        Assert.StartsWith("Gsharp.NET.Sdk", sdkAttr, System.StringComparison.Ordinal);

        var text = File.ReadAllText(path);
        Assert.Contains("<OutputType>Library</OutputType>", text, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Lib_Template_Source_Has_Package_And_Class()
    {
        var path = Path.Combine(LibContentRoot, "Greeter.gs");
        Assert.True(File.Exists(path), path);

        var src = File.ReadAllText(path);
        Assert.Contains("package GsharpLibrary", src, System.StringComparison.Ordinal);
        Assert.Contains("type Greeter class", src, System.StringComparison.Ordinal);
        Assert.Contains("func Greet", src, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Web_Template_Has_Expected_Identity_And_ShortName()
    {
        var path = Path.Combine(WebContentRoot, ".template.config", "template.json");
        Assert.True(File.Exists(path), path);

        using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = doc.RootElement;

        Assert.Equal("GSharp.Templates.Web", root.GetProperty("identity").GetString());
        Assert.Equal("gsharp-web", root.GetProperty("shortName").GetString());
        Assert.Equal("GsharpWebApp", root.GetProperty("sourceName").GetString());
        Assert.Equal("project", root.GetProperty("tags").GetProperty("type").GetString());
    }

    [Fact]
    public void Web_Template_Gsproj_Produces_Executable_With_GsharpNetSdk()
    {
        var path = Path.Combine(WebContentRoot, "GsharpWebApp.gsproj");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var sdkAttr = (string)doc.Root.Attribute("Sdk");
        Assert.StartsWith("Gsharp.NET.Sdk", sdkAttr, System.StringComparison.Ordinal);

        var text = File.ReadAllText(path);
        Assert.Contains("<OutputType>Exe</OutputType>", text, System.StringComparison.Ordinal);

        // The web stack is pulled in through the shared ASP.NET Core framework.
        Assert.Contains(
            "<FrameworkReference Include=\"Microsoft.AspNetCore.App\" />",
            text,
            System.StringComparison.Ordinal);
    }

    [Fact]
    public void Web_Template_Program_Uses_AspNetCore_WebApplication()
    {
        var path = Path.Combine(WebContentRoot, "Program.gs");
        Assert.True(File.Exists(path), path);

        var src = File.ReadAllText(path);
        Assert.Contains("package GsharpWebApp", src, System.StringComparison.Ordinal);
        Assert.Contains("import Microsoft.AspNetCore.Builder", src, System.StringComparison.Ordinal);
        Assert.Contains("import Microsoft.AspNetCore.Http", src, System.StringComparison.Ordinal);

        // The modern WebApplication host serves requests through a RequestDelegate.
        Assert.Contains("WebApplication.CreateBuilder()", src, System.StringComparison.Ordinal);
        Assert.Contains("RequestDelegate", src, System.StringComparison.Ordinal);
        Assert.Contains("context.Response.WriteAsync", src, System.StringComparison.Ordinal);
        Assert.Contains("app.Run(handler)", src, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Xunit_Template_Has_Expected_Identity_And_Solution_Type()
    {
        var path = Path.Combine(XunitContentRoot, ".template.config", "template.json");
        Assert.True(File.Exists(path), path);

        using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = doc.RootElement;

        Assert.Equal("GSharp.Templates.XunitTests", root.GetProperty("identity").GetString());
        Assert.Equal("gsharp-xunit", root.GetProperty("shortName").GetString());
        Assert.Equal("GsharpLibrary", root.GetProperty("sourceName").GetString());
        Assert.Equal("solution", root.GetProperty("tags").GetProperty("type").GetString());
    }

    [Fact]
    public void Xunit_Template_Library_Project_Is_Gsharp_Library()
    {
        var path = Path.Combine(XunitContentRoot, "GsharpLibrary", "GsharpLibrary.gsproj");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var sdkAttr = (string)doc.Root.Attribute("Sdk");
        Assert.StartsWith("Gsharp.NET.Sdk", sdkAttr, System.StringComparison.Ordinal);

        var text = File.ReadAllText(path);
        Assert.Contains("<OutputType>Library</OutputType>", text, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Xunit_Template_Library_Source_Defines_Public_Class()
    {
        var path = Path.Combine(XunitContentRoot, "GsharpLibrary", "Greeter.gs");
        Assert.True(File.Exists(path), path);

        var src = File.ReadAllText(path);
        Assert.Contains("package GsharpLibrary", src, System.StringComparison.Ordinal);
        Assert.Contains("type Greeter class", src, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Xunit_Template_Test_Project_References_Library_And_Xunit()
    {
        var path = Path.Combine(XunitContentRoot, "GsharpLibrary.Tests", "GsharpLibrary.Tests.gsproj");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var sdkAttr = (string)doc.Root.Attribute("Sdk");
        Assert.StartsWith("Gsharp.NET.Sdk", sdkAttr, System.StringComparison.Ordinal);

        var text = File.ReadAllText(path);
        Assert.Contains("<IsTestProject>true</IsTestProject>", text, System.StringComparison.Ordinal);
        Assert.Contains("xunit", text, System.StringComparison.Ordinal);
        Assert.Contains("Microsoft.NET.Test.Sdk", text, System.StringComparison.Ordinal);
        Assert.Contains("GsharpLibrary.gsproj", text, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Xunit_Template_Tests_Are_Written_In_Gsharp()
    {
        var path = Path.Combine(XunitContentRoot, "GsharpLibrary.Tests", "GreeterTests.gs");
        Assert.True(File.Exists(path), path);

        var src = File.ReadAllText(path);
        Assert.Contains("package GsharpLibrary.Tests", src, System.StringComparison.Ordinal);
        Assert.Contains("import Xunit", src, System.StringComparison.Ordinal);
        Assert.Contains("type GreeterTests class", src, System.StringComparison.Ordinal);
        Assert.Contains("@Fact", src, System.StringComparison.Ordinal);
        Assert.Contains("@Theory", src, System.StringComparison.Ordinal);
        Assert.Contains("@InlineData", src, System.StringComparison.Ordinal);
        Assert.Contains("Assert.Equal", src, System.StringComparison.Ordinal);

        // The legacy C# test sources must be gone.
        Assert.False(
            File.Exists(Path.Combine(XunitContentRoot, "GsharpLibrary.Tests", "GreeterTests.cs")),
            "C# test source should have been migrated to GSharp.");
    }

    [Fact]
    public void Xunit_Template_Has_Solution_File()
    {
        var path = Path.Combine(XunitContentRoot, "GsharpLibrary.sln");
        Assert.True(File.Exists(path), path);

        var text = File.ReadAllText(path);
        Assert.Contains("GsharpLibrary.gsproj", text, System.StringComparison.Ordinal);
        Assert.Contains("GsharpLibrary.Tests.gsproj", text, System.StringComparison.Ordinal);
    }
}
