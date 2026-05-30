// <copyright file="CompletionHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class CompletionHandlerTests
{
    [Fact]
    public void ComputeCompletions_IncludesKeywords()
    {
        const string source = "let x = 42\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, new GSharp.LanguageServer.Protocol.Position(0, 0));

        Assert.Contains(items, i => i.Label == "let" && i.Kind == CompletionItemKind.Keyword);
        Assert.Contains(items, i => i.Label == "func" && i.Kind == CompletionItemKind.Keyword);
        Assert.Contains(items, i => i.Label == "if" && i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_IncludesGlobalVariables()
    {
        const string source = "let answer = 42\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, new GSharp.LanguageServer.Protocol.Position(0, 0));

        Assert.Contains(items, i => i.Label == "answer" && i.Kind == CompletionItemKind.Variable);
    }

    [Fact]
    public void ComputeCompletions_IncludesFunctions()
    {
        const string source = "func greet() { }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, new GSharp.LanguageServer.Protocol.Position(0, 0));

        Assert.Contains(items, i => i.Label == "greet" && i.Kind == CompletionItemKind.Function);
    }

    [Fact]
    public void ComputeCompletions_IncludesPrimitiveTypes()
    {
        const string source = "let x = 1\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, new GSharp.LanguageServer.Protocol.Position(0, 0));

        Assert.Contains(items, i => i.Label == "int32");
        Assert.Contains(items, i => i.Label == "string");
        Assert.Contains(items, i => i.Label == "bool");
    }

    [Fact]
    public void ComputeCompletions_IncludesParametersInsideFunction()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Position inside the function body
        var items = CompletionComputer.ComputeCompletions(content, LanguageServerTestHelpers.PositionOf(source, "return"));

        Assert.Contains(items, i => i.Label == "a" && i.Kind == CompletionItemKind.Variable);
        Assert.Contains(items, i => i.Label == "b" && i.Kind == CompletionItemKind.Variable);
    }

    [Fact]
    public void ComputeCompletions_IncludesStructTypes()
    {
        const string source = "type Point struct {\nX int32\nY int32\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, new GSharp.LanguageServer.Protocol.Position(0, 0));

        Assert.Contains(items, i => i.Label == "Point" && i.Kind == CompletionItemKind.Struct);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnInt32_OffersClrInstanceMembers()
    {
        const string source = "var x int32 = 42\nx.\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "x."));

        Assert.Contains(items, i => i.Label == "ToString" && i.Kind == CompletionItemKind.Method);
        Assert.Contains(items, i => i.Label == "CompareTo" && i.Kind == CompletionItemKind.Method);

        // Member context must suppress the keyword / global soup.
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
        Assert.DoesNotContain(items, i => i.Label == "int32");
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnConsole_OffersStaticMembers()
    {
        const string source = "import System\nfunc main() {\nConsole.\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "Console."));

        Assert.Contains(items, i => i.Label == "WriteLine" && i.Kind == CompletionItemKind.Method);
        Assert.Contains(items, i => i.Label == "ReadLine" && i.Kind == CompletionItemKind.Method);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnStructValue_OffersInstanceFields()
    {
        const string source = "type Point struct {\nX int32\nY int32\n}\nfunc use(p Point) {\np.\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "p."));

        Assert.Contains(items, i => i.Label == "X" && i.Kind == CompletionItemKind.Field);
        Assert.Contains(items, i => i.Label == "Y" && i.Kind == CompletionItemKind.Field);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnEnumType_OffersEnumMembers()
    {
        const string source = "type Color enum { Red, Green, Blue }\nfunc use() {\nColor.\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "Color."));

        Assert.Contains(items, i => i.Label == "Red" && i.Kind == CompletionItemKind.EnumMember);
        Assert.Contains(items, i => i.Label == "Green" && i.Kind == CompletionItemKind.EnumMember);
        Assert.Contains(items, i => i.Label == "Blue" && i.Kind == CompletionItemKind.EnumMember);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    private static Position After(string source, string marker)
    {
        var start = LanguageServerTestHelpers.PositionOf(source, marker);
        return new Position(start.Line, start.Character + marker.Length);
    }
}
