// <copyright file="RenameHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class RenameHandlerTests
{
    [Fact]
    public void ComputeRename_ReturnsWorkspaceEditForAllOccurrences()
    {
        const string source = "func F(x int32) int32 {\nlet y = x\nreturn x + y\n}\n";
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

    [Fact]
    public void ComputeRename_ConstructedUserTypeRenamesEveryConstruction()
    {
        const string source = """
            package P
            class Box[T] { var Value T }
            func Use(value Box[int32]) {}
            func Ret() Box[bool] { return Box[bool]() }
            """;
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///rename.gs");

        var edit = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Box", 1),
            "Crate");

        Assert.NotNull(edit);
        var edits = edit.Changes[uri].ToList();
        Assert.Equal(4, edits.Count);
        Assert.All(edits, e => Assert.Equal("Crate", e.NewText));
    }

    [Fact]
    public void ComputeRename_ConstructedNestedEnumRenamesEveryConstruction()
    {
        const string source = """
            package P
            struct Outer[T] { enum Color { Red } }
            func I(c Outer[int32].Color) {}
            func S(c Outer[string].Color) {}
            """;
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///rename.gs");

        var edit = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Color", 1),
            "Shade");

        Assert.NotNull(edit);
        var edits = edit.Changes[uri].ToList();
        Assert.Equal(3, edits.Count);
        Assert.All(edits, e => Assert.Equal("Shade", e.NewText));
    }
}
