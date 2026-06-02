// <copyright file="HoverHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class HoverHandlerTests
{
    [Theory]
    [InlineData("let answer = 42\n", "answer", "let answer int32")]
    [InlineData("var count = 0\n", "count", "var count int32")]
    [InlineData("func add(a int32, b int32) int32 { return a + b }\n", "add", "func add(a int32, b int32) int32")]
    [InlineData("func greet(name string) { }\n", "name", "name string")]
    [InlineData("type Point struct {\nX int32\nY int32\n}\n", "Point", "struct Point { X int32; Y int32 }")]
    [InlineData("type Color enum { Red, Green }\n", "Color", "enum Color { Red, Green }")]
    [InlineData("import System\nfunc main() {\nConsole.WriteLine(\"hi\")\n}\n", "Console", "class System.Console")]
    public void ComputeHover_ReturnsMarkdownSignature(string source, string token, string expected)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(expected, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("package P\ntype Person class {\n    prop Name string\n}\n", "Name")]
    [InlineData("package P\nimport sys = System\n", "sys")]
    [InlineData("package Outer.Inner\n", "Outer")]
    [InlineData("package Outer.Inner\n", "Inner")]
    [InlineData("package P\nimport System\ntype Foo class {\n  event Click func(Object, EventArgs)\n}\n", "Click")]
    public void ComputeHover_ResolvesPropertyImportPackageAndEventSymbols(string source, string token)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(token, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("func greet(name string) { }\n", "name", "(parameter) name string")]
    [InlineData("func f() {\nvar x = 5\nx = x + 1\n}\n", "x", "(local variable) x int32")]
    [InlineData("type Color enum { Red, Green }\n", "Red", "Color.Red = 0")]
    [InlineData("type Color enum { Red, Green }\n", "Green", "Color.Green = 1")]
    [InlineData("package P\nimport sys = System\n", "sys", "import sys = System")]
    [InlineData("package Outer.Inner\n", "Inner", "package Outer.Inner")]
    public void ComputeHover_RendersEnrichedDescriptors(string source, string token, string expected)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(expected, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersPropertyAccessors()
    {
        const string source = "package P\ntype Person class {\n    prop Name string\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Name string {", value, System.StringComparison.Ordinal);
        Assert.Contains("get;", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersImportedClrInstancePropertyDocumentation()
    {
        const string source = "import System.Text\nfunc main() {\n    var sb = StringBuilder()\n    var length = sb.Length\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Length"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("System.Text.StringBuilder.Length", value, System.StringComparison.Ordinal);
        Assert.Contains("System.Int32", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersImportedClrFieldDocumentation()
    {
        const string source = "import System\nfunc main() {\n    var pi = Math.PI\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "PI"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("System.Math.PI", value, System.StringComparison.Ordinal);
        Assert.Contains("System.Double", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersImportedClrEventDocumentation()
    {
        const string source = "import System\nfunc handler(sender Object, args ConsoleCancelEventArgs) { }\nfunc main() {\n    Console.CancelKeyPress += handler\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "CancelKeyPress"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("event", value, System.StringComparison.Ordinal);
        Assert.Contains("System.Console.CancelKeyPress", value, System.StringComparison.Ordinal);
        Assert.Contains("System.ConsoleCancelEventHandler", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersImportedClrMethodDocumentation()
    {
        const string source = "import System\nfunc main() {\n    Console.WriteLine(\"hi\")\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "WriteLine"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("System.Console.WriteLine", value, System.StringComparison.Ordinal);
        Assert.Contains("System.Void", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void AssemblyDocumentationProvider_ResolvesClrMemberDocsFromReferencePack()
    {
        var resolver = CreateReferencePackResolver();
        Assert.True(resolver.TryResolveType("System.Console", out var consoleType));
        Assert.True(resolver.TryResolveType("System.Math", out var mathType));
        Assert.True(resolver.TryResolveType("System.Text.StringBuilder", out var stringBuilderType));

        var title = consoleType.GetProperty("Title", BindingFlags.Public | BindingFlags.Static);
        var cancelKeyPress = consoleType.GetEvent("CancelKeyPress", BindingFlags.Public | BindingFlags.Static);
        var writeLine = consoleType.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .First(m => m.Name == "WriteLine" && m.GetParameters().Length == 1);
        var pi = mathType.GetField("PI", BindingFlags.Public | BindingFlags.Static);
        var length = stringBuilderType.GetProperty("Length", BindingFlags.Public | BindingFlags.Instance);

        Assert.NotNull(title);
        Assert.NotNull(cancelKeyPress);
        Assert.NotNull(writeLine);
        Assert.NotNull(pi);
        Assert.NotNull(length);
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(title).Summary);
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(cancelKeyPress).Summary);
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(writeLine).Summary);
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(pi).Summary);
        Assert.NotEmpty(AssemblyDocumentationProvider.Resolve(length).Summary);
    }

    [Fact]
    public void ComputeHover_DoesNotAnnotateOverloadsForSingleFunction()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "add"));

        Assert.NotNull(hover);
        Assert.DoesNotContain("overload", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    private static ReferenceResolver CreateReferencePackResolver()
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        var dotnetRoot = Directory.GetParent(runtimeDir).Parent.Parent.FullName;
        var tfm = $"net{System.Environment.Version.Major}.0";
        var refDir = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref", System.Environment.Version.ToString(3), "ref", tfm);
        return ReferenceResolver.WithReferences(Directory.GetFiles(refDir, "*.dll"));
    }
}
