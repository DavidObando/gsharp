// <copyright file="NativeSliceCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public sealed class NativeSliceCompletionTests
{
    [Fact]
    public void NativeTypeSnippetsRetainDistinctRepresentations()
    {
        const string source = "func use(value ) { }\n";
        var items = CompletionComputer.ComputeCompletions(
            LanguageServerTestHelpers.Content(source), new Position(0, 15));
        foreach (var label in new[] { "slice[T]", "readonly slice[T]", "array[T]", "managed[T]", "readonly managed[T]" })
        {
            var item = Assert.Single(items, item => item.Label == label);
            Assert.Contains("${1:T}", item.InsertText);
        }

        Assert.DoesNotContain(items, item => item.Label == "readonlySlice[T]");
        Assert.DoesNotContain(items, item => item.Label == "readonlyManaged[T]");
    }

    [Fact]
    public void ManagedReferenceHoverUsesTheTwoTokenSpelling()
    {
        const string source = "func Read(value readonly managed[string?]?) { }\n";
        var hover = HoverComputer.ComputeHover(
            LanguageServerTestHelpers.Content(source), LanguageServerTestHelpers.PositionOf(source, "Read"));
        Assert.NotNull(hover);
        Assert.Contains("readonly managed[string?]?", hover.Contents.ToString());
        Assert.DoesNotContain("readonlyManaged", hover.Contents.ToString());
    }
}
