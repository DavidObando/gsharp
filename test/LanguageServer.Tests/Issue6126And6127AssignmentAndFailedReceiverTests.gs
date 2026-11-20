// <copyright file="Issue6126And6127AssignmentAndFailedReceiverTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issues #6126 and #6127: hover, go-to-definition, find references and rename on the target of a
/// field write (bare, compound, `this.`-qualified and through a variable) resolve to the field,
/// never to the receiver; and on the receiver of a member access that reports GS0158 they resolve
/// to the receiver's variable at its nullable type.
open class Issue6126And6127AssignmentAndFailedReceiverTests {
    @Theory
    @InlineData(1) // Count = 2
    @InlineData(2) // Count += 1
    @InlineData(3) // this.Count = 3
    @InlineData(4) // b.Count = 4
    func FieldWriteTarget_HoverAndDefinition_AreTheField(occurrence int32) {
        let content = LanguageServerTestHelpers.Content(FieldWrites)
        let position = LanguageServerTestHelpers.PositionOf(FieldWrites, "Count", occurrence)
        let hover Hover? = HoverComputer.ComputeHover(content, position)
        Assert.NotNull(hover)
        let text = hover!!.Contents.ToString()
        Assert.Contains("Count", text, StringComparison.Ordinal)
        Assert.Contains("int32", text, StringComparison.Ordinal)
        Assert.DoesNotContain("this", text, StringComparison.Ordinal)
        let uri = DocumentUri.From("file:///issue6126.gs")!!
        let location Location? = DefinitionComputer.ComputeDefinition(uri, content, position)
        Assert.NotNull(location)
        let declaration = LanguageServerTestHelpers.PositionOf(FieldWrites, "Count", 0)
        Assert.Equal(declaration.Line, location!!.Range.Start.Line)
        Assert.Equal(declaration.Character, location!!.Range.Start.Character)
    }

    @Fact
    func FieldWriteTargets_AreReferencesOfTheField() {
        let content = LanguageServerTestHelpers.Content(FieldWrites)
        let uri = DocumentUri.From("file:///issue6126.gs")!!
        let references = ReferencesComputer.ComputeReferences(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(FieldWrites, "Count", 1),
            includeDeclaration: true
        )
        AssertAt(references.Select((r Location) -> r.Range), FieldWrites, "Count", 5)
    }

    @Fact
    func FieldWriteTarget_RenamesEveryWriteAndTheDeclaration() {
        let content = LanguageServerTestHelpers.Content(FieldWrites)
        let uri = DocumentUri.From("file:///issue6126.gs")!!
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(FieldWrites, "Count", 1),
            "Total"
        )
        Assert.NotNull(edit)
        let edits = edit!!.Changes!![uri].ToList()
        Assert.All(edits, (e GSharp.LanguageServer.Protocol.TextEdit) -> Assert.Equal("Total", e.NewText))
        AssertAt(edits.Select((e GSharp.LanguageServer.Protocol.TextEdit) -> e.Range), FieldWrites, "Count", 5)
    }

    @Fact
    func ReceiverOfAFieldWrite_DefinitionAndReferences_AreTheParameter() {
        let content = LanguageServerTestHelpers.Content(FieldWrites)
        let uri = DocumentUri.From("file:///issue6126.gs")!!
        let position = LanguageServerTestHelpers.PositionOf(FieldWrites, "b.Count")
        let location Location? = DefinitionComputer.ComputeDefinition(uri, content, position)
        Assert.NotNull(location)
        let declaration = LanguageServerTestHelpers.PositionOf(FieldWrites, "b Box")
        Assert.Equal(declaration.Line, location!!.Range.Start.Line)
        Assert.Equal(declaration.Character, location!!.Range.Start.Character)
        let references = ReferencesComputer.ComputeReferences(uri, content, position, includeDeclaration: true)
        Assert.Equal(2, references.Count)
    }

    @Fact
    func NullableReceiverOfAFailedAccess_HoverIsTheParameterAtItsNullableType() {
        let content = LanguageServerTestHelpers.Content(FailedAccess)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(FailedAccess, "box", 1)
        )
        Assert.NotNull(hover)
        let text = hover!!.Contents.ToString()
        Assert.Contains("box", text, StringComparison.Ordinal)
        Assert.Contains("Box?", text, StringComparison.Ordinal)
    }

    @Fact
    func NullableReceiverOfAFailedAccess_DefinitionReferencesAndRename_AreTheParameter() {
        let content = LanguageServerTestHelpers.Content(FailedAccess)
        let uri = DocumentUri.From("file:///issue6127.gs")!!
        let position = LanguageServerTestHelpers.PositionOf(FailedAccess, "box", 1)
        let location Location? = DefinitionComputer.ComputeDefinition(uri, content, position)
        Assert.NotNull(location)
        let declaration = LanguageServerTestHelpers.PositionOf(FailedAccess, "box", 0)
        Assert.Equal(declaration.Line, location!!.Range.Start.Line)
        Assert.Equal(declaration.Character, location!!.Range.Start.Character)
        let references = ReferencesComputer.ComputeReferences(uri, content, position, includeDeclaration: true)
        AssertAt(references.Select((r Location) -> r.Range), FailedAccess, "box", 2)
        let edit WorkspaceEdit? = RenameComputer.ComputeRename(uri, content, position, "crate")
        Assert.NotNull(edit)
        AssertAt(
            edit!!.Changes!![uri].Select((e GSharp.LanguageServer.Protocol.TextEdit) -> e.Range),
            FailedAccess,
            "box",
            2
        )
    }

    shared {
        private const FieldWrites string = `package P
class Box {
    var Count int32 = 1
    func Set() {
        Count = 2
        Count += 1
        this.Count = 3
    }
}
func Use(b Box) {
    b.Count = 4
}
`

        private const FailedAccess string = `package P
class Box {
    var Count int32
}
func Read(box Box?) int32? {
    return box.Count
}
`

        /// Asserts that [`ranges`](paramref) are exactly the first [`count`](paramref) occurrences of
        /// [`text`](paramref) in [`source`](paramref).
        private func AssertAt(
            ranges IEnumerable[GSharp.LanguageServer.Protocol.Range],
            source string,
            text string,
            count int32
        ) {
            let expected = Enumerable
                .Range(0, count)
                .Select((i int32) -> LanguageServerTestHelpers.PositionOf(source, text, i))
                .Select((p Position) -> "${p.Line}:${p.Character}")
                .OrderBy((s string) -> s, StringComparer.Ordinal)
                .ToArray()
            let actual = ranges
                .Select((r GSharp.LanguageServer.Protocol.Range) -> "${r.Start.Line}:${r.Start.Character}")
                .Distinct()
                .OrderBy((s string) -> s, StringComparer.Ordinal)
                .ToArray()
            Assert.Equal(expected, actual)
        }
    }
}
