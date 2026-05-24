// <copyright file="RenameHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using OmniSharp.Extensions.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class RenameHandlerTests
{
    [Fact]
    public void ComputeRename_ReturnsWorkspaceEditForAllOccurrences()
    {
        const string source = "func F(x int) int {\nlet y = x\nreturn x + y\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///rename.gs");

        var edit = RenameComputer.ComputeRename(uri, content, LanguageServerTestHelpers.PositionOf(source, "x"), "value");

        Assert.NotNull(edit);
        var edits = edit.Changes[uri].ToList();
        Assert.Equal(3, edits.Count);
        Assert.All(edits, e => Assert.Equal("value", e.NewText));
    }

    [Fact]
    public void ComputeRename_RejectsInvalidName()
    {
        const string source = "let answer = 42\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///rename.gs");

        var edit = RenameComputer.ComputeRename(uri, content, LanguageServerTestHelpers.PositionOf(source, "answer"), "123bad");

        Assert.Null(edit);
    }

    [Fact]
    public void ComputeRename_RejectsPrimitiveClrBackedType()
    {
        const string source = "let name string = \"g\"\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///rename.gs");

        var edit = RenameComputer.ComputeRename(uri, content, LanguageServerTestHelpers.PositionOf(source, "string"), "text");

        Assert.Null(edit);
    }
}
