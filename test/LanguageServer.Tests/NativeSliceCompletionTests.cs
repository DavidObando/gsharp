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
        foreach (var label in new[] { "slice[T]", "readonly slice[T]", "array[T]", "managed[T]", "readonlyManaged[T]" })
        {
            var item = Assert.Single(items, item => item.Label == label);
            Assert.Contains("${1:T}", item.InsertText);
        }

        Assert.DoesNotContain(items, item => item.Label == "readonlySlice[T]");
    }
}
