// <copyright file="RenameHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Linq
import Xunit

open class RenameHandlerTests {
    @Fact
    func ComputeRename_ReturnsWorkspaceEditForAllOccurrences() {
        const source = `func F(x int32) int32 {
let y = x
return x + y
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///rename.gs")!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "x"),
            "value"
        )
        Assert.NotNull(edit)
        let edits = edit!!.Changes[uri].ToList()
        Assert.Equal(3, edits.Count)
        Assert.All(edits, (e GSharp.LanguageServer.Protocol.TextEdit) -> Assert.Equal("value", e.NewText))
    }

    @Fact
    func ComputeRename_RejectsInvalidName() {
        const source = "let answer = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///rename.gs")!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "answer"),
            "123bad"
        )
        Assert.Null(edit)
    }

    @Fact
    func ComputeRename_RejectsPrimitiveClrBackedType() {
        const source = "let name string = \"g\"\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///rename.gs")!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "string"),
            "text"
        )
        Assert.Null(edit)
    }

    @Fact
    func ComputeRename_RejectsTypeParameterUse() {
        const source = "class Box[T] { var Value T }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///rename.gs")!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "T", 1),
            "ZZ"
        )
        Assert.Null(edit)
    }

    @Fact
    func ComputeRename_ConstructedUserTypeRenamesEveryConstruction() {
        const source = `package P
class Box[T] { var Value T }
func Use(value Box[int32]) {}
func Ret() Box[bool] { return Box[bool]() }`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///rename.gs")!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Box", 1),
            "Crate"
        )
        Assert.NotNull(edit)
        let edits = edit!!.Changes[uri].ToList()
        Assert.All(edits, (e GSharp.LanguageServer.Protocol.TextEdit) -> Assert.Equal("Crate", e.NewText))
        AssertRanges(edits, source, "Box")
    }

    @Fact
    func ComputeRename_ConstructedNestedEnumRenamesEveryConstruction() {
        const source = `package P
struct Outer[T] { enum Color { Red } }
func I(c Outer[int32].Color) {}
func S(c Outer[string].Color) {}`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///rename.gs")!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Color", 1),
            "Shade"
        )
        Assert.NotNull(edit)
        let edits = edit!!.Changes[uri].ToList()
        Assert.All(edits, (e GSharp.LanguageServer.Protocol.TextEdit) -> Assert.Equal("Shade", e.NewText))
        AssertRanges(edits, source, "Color")
    }

    @Fact
    func ComputeRename_ConstructedInterfaceFromUseRenamesExactRanges() {
        const source = `package P
interface Source[T] {}
func I(value Source[int32]) {}
func S(value Source[string]) {}
func B(value Source[bool]) {}`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///rename.gs")!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Source", 1),
            "Provider"
        )
        Assert.NotNull(edit)
        let edits = edit!!.Changes[uri].ToList()
        Assert.All(edits, (e GSharp.LanguageServer.Protocol.TextEdit) -> Assert.Equal("Provider", e.NewText))
        AssertRanges(edits, source, "Source")
    }

    @Fact
    func ComputeRename_ImportedGenericArgumentDoesNotRenameImportedType() {
        const source = `package P
import System.Collections.Generic
class Box[T] {}
func Use(value List[Box[int32]]) {}`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///rename.gs")!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "Box", 1),
            "Crate"
        )
        Assert.NotNull(edit)
        let edits = edit!!.Changes[uri].ToList()
        Assert.All(edits, (e GSharp.LanguageServer.Protocol.TextEdit) -> Assert.Equal("Crate", e.NewText))
        AssertRanges(edits, source, "Box")
    }

    @Fact
    func ComputeRename_ComposedTypeArgumentsProduceExactCrossFileRanges() {
        const declarationSource = "package P\nclass Box[T] {}"
        const useSource = `package P
func Use(
    slice []Box[bool],
    array [2]Box[int32],
    mapping map[string]Box[int32],
    pair (Box[int32], bool),
    callback (Box[int32]) -> Box[string],
    stream chan[Box[int32]]) {}`
        const declarationPath = "/test/lib.gs"
        const usePath = "/test/main.gs"
        let project = ProjectState("/test/app.gsproj")
        project.UpdateFile(declarationPath, declarationSource)
        project.UpdateFile(usePath, useSource)
        let content = ContentWithProject(project, usePath)
        let useUri = DocumentUri.FromFileSystemPath(usePath)!!
        let declarationUri = DocumentUri.FromFileSystemPath(declarationPath)!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(
            useUri,
            content,
            LanguageServerTestHelpers.PositionOf(useSource, "Box"),
            "Crate"
        )
        Assert.NotNull(edit)
        Assert.Equal(2, edit!!.Changes.Count)
        let declarationEdits = edit!!.Changes[declarationUri].ToList()
        let useEdits = edit!!.Changes[useUri].ToList()
        Assert.All(
            declarationEdits.Concat(useEdits),
            (e GSharp.LanguageServer.Protocol.TextEdit) -> Assert.Equal("Crate", e.NewText)
        )
        AssertRanges(declarationEdits, declarationSource, "Box")
        AssertRanges(useEdits, useSource, "Box")
    }

    shared {
        private func ContentWithProject(project ProjectState, filePath string) DocumentContent {
            project.TryGetSyntaxTree(filePath, out var tree)
            let source = tree.Text.ToString()
            let lines = List[int32]()
            for var i = 0; i < source.Length; i++ {
                if source[i] == '\n' {
                    lines.Add(i)
                }
            }
            return DocumentContent(tree, lines, project)
        }

        private func AssertRanges(
            edits IEnumerable[GSharp.LanguageServer.Protocol.TextEdit],
            source string,
            text string
        ) {
            let expected = List[(Line int32, Start int32, End int32)]()
            var start = 0
            while (start = source.IndexOf(text, start, StringComparison.Ordinal)) >= 0 {
                let position = LanguageServerTestHelpers.PositionOf(source, text, expected.Count)
                expected.Add((position.Line, position.Character, position.Character + text.Length))
                start += text.Length
            }
            let actual = edits
                .Select(
                (e GSharp.LanguageServer.Protocol.TextEdit) -> (
                    Line: e.Range.Start.Line,
                    Start: e.Range.Start.Character,
                    End: e.Range.End.Character
                )
            )
                .OrderBy((r(Line int32, Start int32, End int32)) -> r.Item1)
                .ThenBy((r(Line int32, Start int32, End int32)) -> r.Item2)
                .ToArray()
            Assert.Equal(
                expected.OrderBy((r(Line int32, Start int32, End int32)) -> r.Line).ThenBy(
                    (r(Line int32, Start int32, End int32)) -> r.Start
                ),
                actual
            )
        }
    }
}
