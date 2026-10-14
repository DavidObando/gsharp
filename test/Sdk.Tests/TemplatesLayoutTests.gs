// <copyright file="TemplatesLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System
import System.IO
import System.Text.Json
import System.Xml.Linq
import Xunit

/// Sanity checks the `Gsharp.Templates` package content: `template.json`
/// metadata, the scaffolded `.gsproj` using `Gsharp.NET.Sdk`, and the
/// sample sources we ship for each `dotnet new` template.
open class TemplatesLayoutTests {
    @Fact
    func TemplateConfig_Has_Expected_Identity_And_ShortName() {
        let path = Path.Combine(ConsoleContentRoot, ".template.config", "template.json")
        Assert.True(File.Exists(path), path)
        using let doc = JsonDocument.Parse(File.ReadAllBytes(path))
        let root = doc.RootElement
        Assert.Equal("GSharp.Templates.Console", root.GetProperty("identity").GetString())
        Assert.Equal("gsharp-console", root.GetProperty("shortName").GetString())
        Assert.Equal("GsharpConsoleApp", root.GetProperty("sourceName").GetString())
        Assert.Equal("project", root.GetProperty("tags").GetProperty("type").GetString())
    }

    @Fact
    func Scaffolded_Gsproj_Uses_GsharpNetSdk_And_Compiles_GsFiles() {
        let path = Path.Combine(ConsoleContentRoot, "GsharpConsoleApp.gsproj")
        Assert.True(File.Exists(path), path)
        let doc = XDocument.Load(path)
        let sdkAttr string? = string(doc.Root!!.Attribute(XName?("Sdk")!!))
        Assert.StartsWith("Gsharp.NET.Sdk", sdkAttr, StringComparison.Ordinal)
        let text = File.ReadAllText(path)
        Assert.Contains("<OutputType>Exe</OutputType>", text, StringComparison.Ordinal)
    }

    @Fact
    func Scaffolded_Program_Has_Package_And_TopLevel_WriteLine() {
        let path = Path.Combine(ConsoleContentRoot, "Program.gs")
        Assert.True(File.Exists(path), path)
        let src = File.ReadAllText(path)
        Assert.Contains("package ", src, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine", src, StringComparison.Ordinal)
    }

    @Fact
    func HelloWorld_Sample_Uses_GsharpNetSdk() {
        let path = Path.Combine(RepoRoot.SamplesDir, "HelloWorld", "HelloWorld.gsproj")
        Assert.True(File.Exists(path), path)
        let doc = XDocument.Load(path)
        Assert.Equal("Gsharp.NET.Sdk", string(doc.Root!!.Attribute(XName?("Sdk")!!)))
    }

    @Fact
    func Lib_Template_Has_Expected_Identity_And_ShortName() {
        let path = Path.Combine(LibContentRoot, ".template.config", "template.json")
        Assert.True(File.Exists(path), path)
        using let doc = JsonDocument.Parse(File.ReadAllBytes(path))
        let root = doc.RootElement
        Assert.Equal("GSharp.Templates.Library", root.GetProperty("identity").GetString())
        Assert.Equal("gsharp-lib", root.GetProperty("shortName").GetString())
        Assert.Equal("GsharpLibrary", root.GetProperty("sourceName").GetString())
        Assert.Equal("project", root.GetProperty("tags").GetProperty("type").GetString())
    }

    @Fact
    func Lib_Template_Gsproj_Targets_Library_With_GsharpNetSdk() {
        let path = Path.Combine(LibContentRoot, "GsharpLibrary.gsproj")
        Assert.True(File.Exists(path), path)
        let doc = XDocument.Load(path)
        let sdkAttr string? = string(doc.Root!!.Attribute(XName?("Sdk")!!))
        Assert.StartsWith("Gsharp.NET.Sdk", sdkAttr, StringComparison.Ordinal)
        let text = File.ReadAllText(path)
        Assert.Contains("<OutputType>Library</OutputType>", text, StringComparison.Ordinal)
    }

    @Fact
    func Lib_Template_Source_Has_Package_And_Class() {
        let path = Path.Combine(LibContentRoot, "Greeter.gs")
        Assert.True(File.Exists(path), path)
        let src = File.ReadAllText(path)
        Assert.Contains("package GsharpLibrary", src, StringComparison.Ordinal)
        Assert.Contains("class Greeter", src, StringComparison.Ordinal)
        Assert.Contains("func Greet", src, StringComparison.Ordinal)
    }

    @Fact
    func Web_Template_Has_Expected_Identity_And_ShortName() {
        let path = Path.Combine(WebContentRoot, ".template.config", "template.json")
        Assert.True(File.Exists(path), path)
        using let doc = JsonDocument.Parse(File.ReadAllBytes(path))
        let root = doc.RootElement
        Assert.Equal("GSharp.Templates.Web", root.GetProperty("identity").GetString())
        Assert.Equal("gsharp-web", root.GetProperty("shortName").GetString())
        Assert.Equal("GsharpWebApp", root.GetProperty("sourceName").GetString())
        Assert.Equal("project", root.GetProperty("tags").GetProperty("type").GetString())
    }

    @Fact
    func Web_Template_Gsproj_Produces_Executable_With_GsharpNetSdk() {
        let path = Path.Combine(WebContentRoot, "GsharpWebApp.gsproj")
        Assert.True(File.Exists(path), path)
        let doc = XDocument.Load(path)
        let sdkAttr string? = string(doc.Root!!.Attribute(XName?("Sdk")!!))
        Assert.StartsWith("Gsharp.NET.Sdk", sdkAttr, StringComparison.Ordinal)
        let text = File.ReadAllText(path)
        Assert.Contains("<OutputType>Exe</OutputType>", text, StringComparison.Ordinal)
        // The web stack is pulled in through the shared ASP.NET Core framework.
        Assert.Contains("<FrameworkReference Include=\"Microsoft.AspNetCore.App\" />", text, StringComparison.Ordinal)
    }

    @Fact
    func Web_Template_Program_Uses_AspNetCore_WebApplication() {
        let path = Path.Combine(WebContentRoot, "Program.gs")
        Assert.True(File.Exists(path), path)
        let src = File.ReadAllText(path)
        Assert.Contains("package GsharpWebApp", src, StringComparison.Ordinal)
        Assert.Contains("import Microsoft.AspNetCore.Builder", src, StringComparison.Ordinal)
        Assert.Contains("import Microsoft.AspNetCore.Routing", src, StringComparison.Ordinal)
        // The modern WebApplication host serves requests through minimal-API routing.
        Assert.Contains("WebApplication.CreateBuilder()", src, StringComparison.Ordinal)
        Assert.Contains("Func[string]", src, StringComparison.Ordinal)
        Assert.Contains("app.MapGet(", src, StringComparison.Ordinal)
        Assert.Contains("app.Run(", src, StringComparison.Ordinal)
    }

    @Fact
    func Xunit_Template_Has_Expected_Identity_And_Solution_Type() {
        let path = Path.Combine(XunitContentRoot, ".template.config", "template.json")
        Assert.True(File.Exists(path), path)
        using let doc = JsonDocument.Parse(File.ReadAllBytes(path))
        let root = doc.RootElement
        Assert.Equal("GSharp.Templates.XunitTests", root.GetProperty("identity").GetString())
        Assert.Equal("gsharp-xunit", root.GetProperty("shortName").GetString())
        Assert.Equal("GsharpLibrary", root.GetProperty("sourceName").GetString())
        Assert.Equal("solution", root.GetProperty("tags").GetProperty("type").GetString())
    }

    @Fact
    func Xunit_Template_Library_Project_Is_Gsharp_Library() {
        let path = Path.Combine(XunitContentRoot, "GsharpLibrary", "GsharpLibrary.gsproj")
        Assert.True(File.Exists(path), path)
        let doc = XDocument.Load(path)
        let sdkAttr string? = string(doc.Root!!.Attribute(XName?("Sdk")!!))
        Assert.StartsWith("Gsharp.NET.Sdk", sdkAttr, StringComparison.Ordinal)
        let text = File.ReadAllText(path)
        Assert.Contains("<OutputType>Library</OutputType>", text, StringComparison.Ordinal)
    }

    @Fact
    func Xunit_Template_Library_Source_Defines_Public_Class() {
        let path = Path.Combine(XunitContentRoot, "GsharpLibrary", "Greeter.gs")
        Assert.True(File.Exists(path), path)
        let src = File.ReadAllText(path)
        Assert.Contains("package GsharpLibrary", src, StringComparison.Ordinal)
        Assert.Contains("class Greeter", src, StringComparison.Ordinal)
    }

    @Fact
    func Xunit_Template_Test_Project_References_Library_And_Xunit() {
        let path = Path.Combine(XunitContentRoot, "GsharpLibrary.Tests", "GsharpLibrary.Tests.gsproj")
        Assert.True(File.Exists(path), path)
        let doc = XDocument.Load(path)
        let sdkAttr string? = string(doc.Root!!.Attribute(XName?("Sdk")!!))
        Assert.StartsWith("Gsharp.NET.Sdk", sdkAttr, StringComparison.Ordinal)
        let text = File.ReadAllText(path)
        Assert.Contains("<IsTestProject>true</IsTestProject>", text, StringComparison.Ordinal)
        Assert.Contains("xunit", text, StringComparison.Ordinal)
        Assert.Contains("Microsoft.NET.Test.Sdk", text, StringComparison.Ordinal)
        Assert.Contains("GsharpLibrary.gsproj", text, StringComparison.Ordinal)
    }

    @Fact
    func Xunit_Template_Tests_Are_Written_In_Gsharp() {
        let path = Path.Combine(XunitContentRoot, "GsharpLibrary.Tests", "GreeterTests.gs")
        Assert.True(File.Exists(path), path)
        let src = File.ReadAllText(path)
        Assert.Contains("package GsharpLibrary.Tests", src, StringComparison.Ordinal)
        Assert.Contains("import Xunit", src, StringComparison.Ordinal)
        Assert.Contains("class GreeterTests", src, StringComparison.Ordinal)
        Assert.Contains("@Fact", src, StringComparison.Ordinal)
        Assert.Contains("@Theory", src, StringComparison.Ordinal)
        Assert.Contains("@InlineData", src, StringComparison.Ordinal)
        Assert.Contains("Assert.Equal", src, StringComparison.Ordinal)
        // The legacy C# test sources must be gone.
        Assert.False(
            File.Exists(Path.Combine(XunitContentRoot, "GsharpLibrary.Tests", "GreeterTests.cs")),
            "C# test source should have been migrated to GSharp."
        )
    }

    @Fact
    func Xunit_Template_Has_Solution_File() {
        let path = Path.Combine(XunitContentRoot, "GsharpLibrary.sln")
        Assert.True(File.Exists(path), path)
        let text = File.ReadAllText(path)
        Assert.Contains("GsharpLibrary.gsproj", text, StringComparison.Ordinal)
        Assert.Contains("GsharpLibrary.Tests.gsproj", text, StringComparison.Ordinal)
    }

    shared {
        private let TemplatesContentRoot string = Path.Combine(RepoRoot.TemplatesSourceDir, "content")
        private let ConsoleContentRoot string = Path.Combine(TemplatesContentRoot, "gsharp-console")
        private let LibContentRoot string = Path.Combine(TemplatesContentRoot, "gsharp-lib")
        private let WebContentRoot string = Path.Combine(TemplatesContentRoot, "gsharp-web")
        private let XunitContentRoot string = Path.Combine(TemplatesContentRoot, "gsharp-xunit")
    }
}
