// <copyright file="RenameHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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
    public void ComputeRename_RejectsTypeParameterUse()
    {
        const string source = "class Box[T] { var Value T }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///rename.gs");

        var edit = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "T", 1),
            "ZZ");

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
        Assert.All(edits, e => Assert.Equal("Crate", e.NewText));
        AssertRanges(edits, source, "Box");
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
        Assert.All(edits, e => Assert.Equal("Shade", e.NewText));
        AssertRanges(edits, source, "Color");
    }

    [Fact]
    public void ComputeRename_ConstructedInterfaceFromUseRenamesExactRanges()
    {
        const string source = """
            package P
            interface Source[T] {}
            func I(value Source[int32]) {}
            func S(value Source[string]) {}
            func B(value Source[bool]) {}
            """;
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///rename.gs");

        var edit = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Source", 1),
            "Provider");

        Assert.NotNull(edit);
        var edits = edit.Changes[uri].ToList();
        Assert.All(edits, e => Assert.Equal("Provider", e.NewText));
        AssertRanges(edits, source, "Source");
    }

    [Fact]
    public void ComputeRename_ImportedGenericArgumentDoesNotRenameImportedType()
    {
        const string source = """
            package P
            import System.Collections.Generic
            class Box[T] {}
            func Use(value List[Box[int32]]) {}
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
        Assert.All(edits, e => Assert.Equal("Crate", e.NewText));
        AssertRanges(edits, source, "Box");
    }

    [Fact]
    public void ComputeRename_ComposedTypeArgumentsProduceExactCrossFileRanges()
    {
        const string declarationSource = """
            package P
            class Box[T] {}
            """;
        const string useSource = """
            package P
            func Use(
                slice []Box[bool],
                array [2]Box[int32],
                mapping map[string]Box[int32],
                pair (Box[int32], bool),
                callback (Box[int32]) -> Box[string],
                stream chan[Box[int32]]) {}
            """;
        const string declarationPath = "/test/lib.gs";
        const string usePath = "/test/main.gs";
        var project = new ProjectState("/test/app.gsproj");
        project.UpdateFile(declarationPath, declarationSource);
        project.UpdateFile(usePath, useSource);
        var content = ContentWithProject(project, usePath);
        var useUri = DocumentUri.FromFileSystemPath(usePath);
        var declarationUri = DocumentUri.FromFileSystemPath(declarationPath);

        var edit = RenameComputer.ComputeRename(
            useUri,
            content,
            LanguageServerTestHelpers.PositionOf(useSource, "Box"),
            "Crate");

        Assert.NotNull(edit);
        Assert.Equal(2, edit.Changes.Count);
        var declarationEdits = edit.Changes[declarationUri].ToList();
        var useEdits = edit.Changes[useUri].ToList();
        Assert.All(declarationEdits.Concat(useEdits), e => Assert.Equal("Crate", e.NewText));
        AssertRanges(declarationEdits, declarationSource, "Box");
        AssertRanges(useEdits, useSource, "Box");
    }

    private static DocumentContent ContentWithProject(ProjectState project, string filePath)
    {
        project.TryGetSyntaxTree(filePath, out var tree);
        var source = tree.Text.ToString();
        var lines = new List<int>();
        for (var i = 0; i < source.Length; i++)
        {
            if (source[i] == '\n')
            {
                lines.Add(i);
            }
        }

        return new DocumentContent(tree, lines, project);
    }

    private static void AssertRanges(IEnumerable<TextEdit> edits, string source, string text)
    {
        var expected = new List<(int Line, int Start, int End)>();
        var start = 0;
        while ((start = source.IndexOf(text, start, StringComparison.Ordinal)) >= 0)
        {
            var position = LanguageServerTestHelpers.PositionOf(source, text, expected.Count);
            expected.Add((position.Line, position.Character, position.Character + text.Length));
            start += text.Length;
        }

        var actual = edits
            .Select(e => (
                Line: e.Range.Start.Line,
                Start: e.Range.Start.Character,
                End: e.Range.End.Character))
            .OrderBy(r => r.Line)
            .ThenBy(r => r.Start)
            .ToArray();
        Assert.Equal(expected.OrderBy(r => r.Line).ThenBy(r => r.Start), actual);
    }
}
