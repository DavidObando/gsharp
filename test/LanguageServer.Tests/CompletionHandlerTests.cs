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
        const string source = "struct Point {\nvar X int32\nvar Y int32\n}\n";
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
        const string source = "struct Point {\nvar X int32\nvar Y int32\n}\nfunc use(p Point) {\np.\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "p."));

        Assert.Contains(items, i => i.Label == "X" && i.Kind == CompletionItemKind.Field);
        Assert.Contains(items, i => i.Label == "Y" && i.Kind == CompletionItemKind.Field);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnImplicitThisProperty_OffersMemberTypeMembers()
    {
        // `Item.` where Item is a property of the enclosing class (implicit-this access).
        // Previously the receiver switch had no PropertySymbol case, so this returned nothing.
        const string source = "class Inner {\n    prop Value int32\n}\nclass Outer {\n    prop Item Inner\n    func F() {\n        Item.\n    }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "Item."));

        Assert.Contains(items, i => i.Label == "Value");
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnImplicitThisField_OffersMemberTypeMembers()
    {
        // `item.` where item is a field of the enclosing class (implicit-this access).
        const string source = "class Inner {\n    prop Value int32\n}\nclass Outer {\n    var item Inner\n    func F() {\n        item.\n    }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "item."));

        Assert.Contains(items, i => i.Label == "Value");
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnImplicitThisPropertyOfPrimitiveType_OffersClrMembers()
    {
        // Matches the reported case: a property of a primitive type accessed via implicit this.
        const string source = "class Rect {\n    prop Width int32\n    func Area() {\n        Width.\n    }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "Width."));

        Assert.Contains(items, i => i.Label == "ToString" && i.Kind == CompletionItemKind.Method);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnEnumType_OffersEnumMembers()
    {
        const string source = "enum Color { Red, Green, Blue }\nfunc use() {\nColor.\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "Color."));

        Assert.Contains(items, i => i.Label == "Red" && i.Kind == CompletionItemKind.EnumMember);
        Assert.Contains(items, i => i.Label == "Green" && i.Kind == CompletionItemKind.EnumMember);
        Assert.Contains(items, i => i.Label == "Blue" && i.Kind == CompletionItemKind.EnumMember);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnParenthesizedExpression_OffersInstanceMembers()
    {
        const string source = "var a int32 = 3\nvar b int32 = 4\n(a + b).\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "(a + b)."));

        Assert.Contains(items, i => i.Label == "ToString" && i.Kind == CompletionItemKind.Method);
        Assert.Contains(items, i => i.Label == "CompareTo" && i.Kind == CompletionItemKind.Method);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnParenthesizedExpression_InsideFunction_UsesParameters()
    {
        const string source = "func add(a int32, b int32) {\n(a + b).\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "(a + b)."));

        Assert.Contains(items, i => i.Label == "ToString" && i.Kind == CompletionItemKind.Method);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnCallExpression_OffersReturnTypeMembers()
    {
        const string source = "func foo() int32 { return 1 }\nfunc use() {\nfoo().\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "foo()."));

        Assert.Contains(items, i => i.Label == "ToString" && i.Kind == CompletionItemKind.Method);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnIndexExpression_OffersElementMembers()
    {
        const string source = "var arr [3]int32 = [3]int32{1, 2, 3}\narr[0].\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "arr[0]."));

        Assert.Contains(items, i => i.Label == "ToString" && i.Kind == CompletionItemKind.Method);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterChainedMemberAccess_OffersMembers()
    {
        const string source = "struct Point {\nvar X int32\nvar Y int32\n}\nfunc use(p Point) {\np.X.\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "p.X."));

        Assert.Contains(items, i => i.Label == "ToString" && i.Kind == CompletionItemKind.Method);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_AfterDotOnUnresolvableReceiver_ReturnsNoMembersAndNoKeywords()
    {
        const string source = "func use() {\n(nope + 1).\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "(nope + 1)."));

        // Inference fails for the undefined receiver, but the member-access context
        // must still suppress the keyword/global list.
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);
        Assert.Empty(items);
    }

    [Fact]
    public void ComputeCompletions_WhileTypingBareIdentifier_OffersGlobalCandidates()
    {
        // Issue #917: completion-as-you-type. The caret sits in a partial identifier
        // (`ans`) with no leading dot; the global list must still be offered so the
        // editor can filter it down to the matching symbol.
        const string source = "let answer = 42\nans\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, After(source, "ans"));

        Assert.Contains(items, i => i.Label == "answer" && i.Kind == CompletionItemKind.Variable);
        Assert.Contains(items, i => i.Label == "let" && i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_WhileTypingBareIdentifier_SetsReplacementRangeOverPrefix()
    {
        // Issue #917: each plain candidate must carry an explicit replacement range
        // spanning the typed prefix so the editor replaces `ans` rather than inserting
        // alongside it.
        const string source = "let answer = 42\nans\n";
        var content = LanguageServerTestHelpers.Content(source);

        var caret = After(source, "ans");
        var items = CompletionComputer.ComputeCompletions(content, caret);

        var answer = Assert.Single(items, i => i.Label == "answer");
        Assert.NotNull(answer.TextEdit);
        Assert.Equal("answer", answer.TextEdit.NewText);

        // The prefix `ans` starts at column 0 on line 1 and ends at the caret.
        var prefixStart = LanguageServerTestHelpers.PositionOf(source, "ans");
        Assert.Equal(prefixStart.Line, answer.TextEdit.Range.Start.Line);
        Assert.Equal(prefixStart.Character, answer.TextEdit.Range.Start.Character);
        Assert.Equal(caret.Line, answer.TextEdit.Range.End.Line);
        Assert.Equal(caret.Character, answer.TextEdit.Range.End.Character);
    }

    [Fact]
    public void ComputeCompletions_AtTokenStartWithoutPrefix_LeavesItemsRangeless()
    {
        // With no identifier prefix at the caret (a fresh position), the server leaves
        // the replacement range unset so the editor applies its own word-range heuristics.
        const string source = "let answer = 42\n";
        var content = LanguageServerTestHelpers.Content(source);

        var items = CompletionComputer.ComputeCompletions(content, new Position(0, 0));

        var keyword = Assert.Single(items, i => i.Label == "let");
        Assert.Null(keyword.TextEdit);
    }

    [Fact]
    public void ComputeCompletions_WhileTypingPartialMemberAfterDot_OffersMembersAndRange()
    {
        // Issue #917: `x.To<caret>` — partial member name after a dot. Member completion
        // must still resolve the receiver's members (no keyword soup) and anchor the
        // replacement range to the partial member text being typed.
        const string source = "var x int32 = 42\nx.To\n";
        var content = LanguageServerTestHelpers.Content(source);

        var caret = After(source, "x.To");
        var items = CompletionComputer.ComputeCompletions(content, caret);

        var toString = Assert.Single(items, i => i.Label == "ToString");
        Assert.Equal(CompletionItemKind.Method, toString.Kind);
        Assert.DoesNotContain(items, i => i.Kind == CompletionItemKind.Keyword);

        Assert.NotNull(toString.TextEdit);
        var prefixStart = LanguageServerTestHelpers.PositionOf(source, "To", 0);
        Assert.Equal(prefixStart.Line, toString.TextEdit.Range.Start.Line);
        Assert.Equal(prefixStart.Character, toString.TextEdit.Range.Start.Character);
        Assert.Equal(caret.Character, toString.TextEdit.Range.End.Character);
    }

    private static Position After(string source, string marker)
    {
        var start = LanguageServerTestHelpers.PositionOf(source, marker);
        return new Position(start.Line, start.Character + marker.Length);
    }
}
