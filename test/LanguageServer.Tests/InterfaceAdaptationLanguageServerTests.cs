// <copyright file="InterfaceAdaptationLanguageServerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.LanguageServer;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public sealed class InterfaceAdaptationLanguageServerTests
{
    [Fact]
    public void AdaptHoverAndCompletionUseTheTargetInterface()
    {
        const string source = """
            interface Reader { func Read() int32; }
            class Source { func Read() int32 -> 42 }
            func main() {
                let adapted = adapt[Reader](Source())
                adapted.
            }
            """;
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "adapted"));
        Assert.NotNull(hover);
        Assert.Contains("Reader", hover.Contents.ToString(), System.StringComparison.Ordinal);

        var dot = LanguageServerTestHelpers.PositionOf(source, "adapted.", occurrence: 0);
        var items = CompletionComputer.ComputeCompletions(
            content,
            new Position(dot.Line, dot.Character + "adapted.".Length));
        Assert.Contains(items, item => item.Label == "Read" && item.Kind == CompletionItemKind.Method);
    }

    [Fact]
    public void InferredRichFieldAppearsAsItsExactType()
    {
        const string source = """
            interface Reader { func Read() int32; }
            func main() {
                let value = 42
                let rich = object : Reader {
                    let Snapshot = value
                    func Read() int32 -> value
                }
                let observed = rich.Snapshot
            }
            """;
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Snapshot", occurrence: 1));
        Assert.NotNull(hover);
        Assert.Contains("int32", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }
}
