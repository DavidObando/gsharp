// <copyright file="Issue3785InitializerHoverCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public sealed class Issue3785InitializerHoverCompletionTests
{
    [Theory]
    [InlineData("List[int32](4)", "import System.Collections.Generic\n")]
    [InlineData("System.Collections.Generic.List[int32](4)", "")]
    public void Hover_ExplicitClrMember_UsesConstructedReceiver(string target, string imports)
    {
        var source = imports + "func Main() {\nlet xs = " + target + "{ 1, .Capacity: 8 }\n}";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Capacity"));
        Assert.NotNull(hover);
        Assert.Contains("Capacity", hover.Contents.ToString(), StringComparison.Ordinal);
        Assert.Contains("List", hover.Contents.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Hover_ExplicitSourceMember_UsesConstructedReceiver()
    {
        const string source = """
            class Box {
                prop Width int32
                init(value int32) { Width = value }
            }
            let box = Box(1){ .Width: 2 }
            """;
        var hover = HoverComputer.ComputeHover(
            LanguageServerTestHelpers.Content(source),
            LanguageServerTestHelpers.PositionOf(source, "Width", occurrence: 2));
        Assert.NotNull(hover);
        Assert.Contains("Width", hover.Contents.ToString(), StringComparison.Ordinal);
        Assert.Contains("int32", hover.Contents.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(".")]
    [InlineData(".Cap")]
    [InlineData(".Capacity")]
    public void Completion_IncompleteExplicitMember_OffersReceiverMembers(string entry)
    {
        var source = "func Main() {\nlet xs = System.Collections.Generic.List[int32](4){ 1, " + entry + " }\n}";
        var prefix = "{ 1, " + entry;
        var start = LanguageServerTestHelpers.PositionOf(source, prefix);
        var caret = new Position(start.Line, start.Character + prefix.Length);
        var items = CompletionComputer.ComputeCompletions(LanguageServerTestHelpers.Content(source), caret);
        Assert.Contains(items, item => item.Label == "Capacity" && item.Kind == CompletionItemKind.Property);
        Assert.DoesNotContain(items, item => item.Label == "let" && item.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void Completion_SourceMember_OffersProperties()
    {
        const string source = "class Box { prop Width int32 }\nlet box = Box(){ .Wi }";
        var start = LanguageServerTestHelpers.PositionOf(source, ".Wi");
        var items = CompletionComputer.ComputeCompletions(
            LanguageServerTestHelpers.Content(source),
            new Position(start.Line, start.Character + 3));
        Assert.Contains(items, item => item.Label == "Width" && item.Kind == CompletionItemKind.Property);
    }

    [Fact]
    public void Completion_ExplicitMemberValue_KeepsExpressionContext()
    {
        const string source = "import System.Collections.Generic\nlet xs = List[int32](){ .Capacity:  }";
        var start = LanguageServerTestHelpers.PositionOf(source, ".Capacity: ");
        var items = CompletionComputer.ComputeCompletions(
            LanguageServerTestHelpers.Content(source),
            new Position(start.Line, start.Character + ".Capacity: ".Length));
        Assert.Contains(items, item => item.Label == "true" && item.Kind == CompletionItemKind.Keyword);
        Assert.DoesNotContain(items, item => item.Label == "Capacity" && item.Kind == CompletionItemKind.Property);
    }

    [Fact]
    public void Hover_UnmarkedKey_IsAVariableNotAReceiverMember()
    {
        const string source = """
            import System.Collections.Generic
            let Capacity = "key"
            let xs = SortedList[string, int32](){ ...[]KeyValuePair[string, int32]{}, Capacity: 2 }
            """;
        var hover = HoverComputer.ComputeHover(
            LanguageServerTestHelpers.Content(source),
            LanguageServerTestHelpers.PositionOf(source, "Capacity", occurrence: 1));
        Assert.NotNull(hover);
        Assert.Contains("string", hover.Contents.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("SortedList", hover.Contents.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Completion_NestedMemberCollection_UsesMemberType()
    {
        const string source = """
            import System.Collections.Generic
            class Owner { public let Children List[int32] = List[int32]() }
            let owner = Owner(){ .Children: { .Cap } }
            """;
        var start = LanguageServerTestHelpers.PositionOf(source, ".Cap");
        var items = CompletionComputer.ComputeCompletions(
            LanguageServerTestHelpers.Content(source),
            new Position(start.Line, start.Character + 4));
        Assert.Contains(items, item => item.Label == "Capacity" && item.Kind == CompletionItemKind.Property);
    }

    [Fact]
    public void Hover_GenericSourceMember_UsesClosedType()
    {
        const string source = """
            class Box[T any] {
                public var Value T
                init(value T) { Value = value }
            }
            let box = Box[int32](1){ .Value: 2 }
            """;
        var start = LanguageServerTestHelpers.PositionOf(source, ".Value");
        var hover = HoverComputer.ComputeHover(
            LanguageServerTestHelpers.Content(source),
            new Position(start.Line, start.Character + 1));
        Assert.NotNull(hover);
        Assert.Contains("int32", hover.Contents.ToString(), StringComparison.Ordinal);
    }
}
