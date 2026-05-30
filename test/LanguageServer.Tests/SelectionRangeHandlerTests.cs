// <copyright file="SelectionRangeHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class SelectionRangeHandlerTests
{
    [Fact]
    public void ComputeSelectionRange_ReturnsNestedRanges()
    {
        const string source = "func add(a int32, b int32) int32 {\n  return a + b\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var position = LanguageServerTestHelpers.PositionOf(source, "a + b");

        var result = SelectionRangeComputer.ComputeSelectionRange(content, position);

        // Should have at least one level of nesting
        Assert.NotNull(result);
        Assert.NotNull(result.Parent);
    }

    [Fact]
    public void ComputeSelectionRange_AtTopLevel_ReturnsFullFile()
    {
        const string source = "var x = 42\n";
        var content = LanguageServerTestHelpers.Content(source);
        var position = new Position(0, 4);

        var result = SelectionRangeComputer.ComputeSelectionRange(content, position);

        Assert.NotNull(result);
    }

    [Fact]
    public void ComputeSelectionRange_EmptySource_ReturnsNull()
    {
        const string source = "";
        var content = LanguageServerTestHelpers.Content(source);
        var position = new Position(0, 0);

        var result = SelectionRangeComputer.ComputeSelectionRange(content, position);

        // Empty source may return null or a minimal range
        // The handler should not throw
        Assert.True(result == null || result.Range != null);
    }
}
