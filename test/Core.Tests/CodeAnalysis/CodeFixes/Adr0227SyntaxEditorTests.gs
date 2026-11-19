// <copyright file="Adr0227SyntaxEditorTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0227 D1: (cref:SourceText.WithChanges) and (cref:SyntaxEditor) edit the original text, keep
/// the comments outside the edited spans, and reject overlapping edits.
open class Adr0227SyntaxEditorTests {
    @Fact
    func WithChanges_AppliesChangesInOrder_KeepsFileName_DropsRawBytes() {
        let text = SourceText.From("abcdef", "a.gs", []uint8{1, 2, 3})
        let changed = text.WithChanges(
            ImmutableArray.Create(
                TextChange(TextSpan(1, 0), "X"),
                TextChange(TextSpan(1, 0), "Y"),
                TextChange(TextSpan(2, 2), ""),
                TextChange(TextSpan(6, 0), "!")
            )
        )
        Assert.Equal("aXYbef!", changed.ToString())
        Assert.Equal("a.gs", changed.FileName)
        Assert.Null(changed.RawBytes)
    }

    @Fact
    func WithChanges_NoChange_ReturnsSameText() {
        let text = SourceText.From("abc", "a.gs")
        Assert.Same(text, text.WithChanges(ImmutableArray[TextChange].Empty))
    }

    @Fact
    func WithChanges_RejectsOverlapAndOutOfOrder() {
        let text = SourceText.From("abcdef")
        Assert.Throws[ArgumentException](
            () -> text.WithChanges(
                ImmutableArray.Create(TextChange(TextSpan(0, 3), "x"), TextChange(TextSpan(2, 1), "y"))
            )
        )
        Assert.Throws[ArgumentException](
            () -> text.WithChanges(
                ImmutableArray.Create(TextChange(TextSpan(4, 0), "x"), TextChange(TextSpan(1, 0), "y"))
            )
        )
        Assert.Throws[ArgumentOutOfRangeException](
            () -> text.WithChanges(ImmutableArray.Create(TextChange(TextSpan(5, 4), "x")))
        )
    }

    @Fact
    func ReplaceToken_KeepsCommentsAroundTheToken() {
        const source = "package P\n\nfunc F() string? {\n    // why\n    return /* inner */ null // after\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "a.gs"))
        let editor = SyntaxEditor(tree)
        editor.ReplaceToken(Token(tree, "null"), "nil")
        Assert.Equal(
            "package P\n\nfunc F() string? {\n    // why\n    return /* inner */ nil // after\n}\n",
            editor.GetChangedText().ToString()
        )
        Assert.Empty(editor.GetChangedTree().Diagnostics)
    }

    @Fact
    func RemoveToken_RemovesTheFollowingSpace() {
        const source = "package P\n\nfunc F() int32 {\n    let x = new Make()\n    return x\n}\n\nfunc Make() int32 -> 1\n"
        let tree = SyntaxTree.Parse(source)
        let editor = SyntaxEditor(tree)
        editor.RemoveToken(Token(tree, "new"))
        Assert.Contains("let x = Make()\n", editor.GetChangedText().ToString())
    }

    @Fact
    func RemoveToken_AtEndOfLine_RemovesThePrecedingSpace() {
        const source = "package P\n\nfunc F() int32 {\n    return 1 +\n        2\n}\n"
        let tree = SyntaxTree.Parse(source)
        let editor = SyntaxEditor(tree)
        editor.RemoveToken(Token(tree, "+"))
        Assert.Contains("    return 1\n        2\n", editor.GetChangedText().ToString())
    }

    @Fact
    func RemoveToken_FollowedDirectlyByAToken_KeepsThePrecedingSpace() {
        const source = "package P\n\nfunc F(x int32) int32 {\n    return +x\n}\n"
        let tree = SyntaxTree.Parse(source)
        let editor = SyntaxEditor(tree)
        editor.RemoveToken(Token(tree, "+"))
        Assert.Contains("    return x\n", editor.GetChangedText().ToString())
    }

    @Fact
    func ReplaceNode_OfASynthesizedReturn_EditsOnlyTheRealTokens() {
        const source = "package P\n\nfunc F() int32 -> /* keep */ 1\n"
        let tree = SyntaxTree.Parse(source)
        let statement = tree.Root.DescendantNodes().OfType[ReturnStatementSyntax]().Single()
        let editor = SyntaxEditor(tree)
        Assert.Equal("1", editor.OriginalText(statement))
        editor.ReplaceNode(statement, "2")
        Assert.Equal("package P\n\nfunc F() int32 -> /* keep */ 2\n", editor.GetChangedText().ToString())
    }

    @Fact
    func InsertBefore_AReplacedToken_IsAppliedBeforeTheReplacement() {
        const source = "package P\n\nfunc F() string? {\n    return null\n}\n"
        let tree = SyntaxTree.Parse(source)
        let editor = SyntaxEditor(tree)
        let token = Token(tree, "null")
        editor.ReplaceToken(token, "nil")
        editor.InsertBefore(token, "(")
        editor.InsertAfter(token, ")")
        Assert.Contains("    return (nil)\n", editor.GetChangedText().ToString())
    }

    @Fact
    func RemoveToken_WithNoSpaceBefore_KeepsTheSpaceAfter() {
        const source = "package P\n\nfunc F(x int32) int32 {\n    return+ x\n}\n"
        let tree = SyntaxTree.Parse(source)
        let editor = SyntaxEditor(tree)
        editor.RemoveToken(Token(tree, "+"))
        Assert.Contains("    return x\n", editor.GetChangedText().ToString())
    }

    @Fact
    func PayloadEnum_GeneratedTokensAndDeclarations_AreRejected() {
        const source = "package P\n\nenum E { Some(value int32), None }\n"
        let tree = SyntaxTree.Parse(source)
        let editor = SyntaxEditor(tree)
        let generated = tree
            .Root
            .DescendantTokens()
            .Where((t SyntaxToken) -> t.Text == "class" && !t.IsMissing)
            .ToList()
        Assert.NotEmpty(generated)
        for token in generated {
            Assert.Throws[InvalidOperationException](() -> editor.ReplaceToken(token, "struct"))
        }
        // Each generated case declaration borrows the enum's tokens.
        let cases = tree
            .Root
            .DescendantNodes()
            .Where(
            (n SyntaxNode) -> n.Kind == SyntaxKind.StructDeclaration && n.DescendantTokens().Any(
                (t SyntaxToken) -> t.Text == "Some"
            )
        )
            .ToList()
        Assert.NotEmpty(cases)
        Assert.All(cases, (n SyntaxNode) -> Assert.Throws[InvalidOperationException](() -> editor.ReplaceNode(n, "x")))
        Assert.False(editor.HasChanges)
    }

    @Fact
    func RemoveNode_AloneOnItsLine_RemovesTheLine() {
        const source = "package P\n\nfunc F() int32 {\n    var x = 1\n    x = 2\n    return x\n}\n"
        let tree = SyntaxTree.Parse(source)
        let statement = tree.Root.DescendantNodes().OfType[ExpressionStatementSyntax]().Single()
        let editor = SyntaxEditor(tree)
        editor.RemoveNode(statement)
        Assert.Equal(
            "package P\n\nfunc F() int32 {\n    var x = 1\n    return x\n}\n",
            editor.GetChangedText().ToString()
        )
    }

    @Fact
    func OriginalText_KeepsInnerComments_ForAMovedSubtree() {
        const source = "package P\n\nfunc F(a int32) int32 {\n    return a + /* keep */ 1\n}\n"
        let tree = SyntaxTree.Parse(source)
        let binary = tree.Root.DescendantNodes().OfType[BinaryExpressionSyntax]().Single()
        let editor = SyntaxEditor(tree)
        editor.ReplaceNode(binary, "(" + editor.OriginalText(binary) + ")")
        Assert.Contains("return (a + /* keep */ 1)\n", editor.GetChangedText().ToString())
    }

    @Fact
    func Insertions_AtOnePosition_KeepCallOrder() {
        const source = "package P\n\nfunc F(a int32) int32 {\n    return a\n}\n"
        let tree = SyntaxTree.Parse(source)
        let name = tree.Root.DescendantNodes().OfType[ReturnStatementSyntax]().Single().GetLastToken()
        let editor = SyntaxEditor(tree)
        editor.InsertBefore(name, "(")
        editor.InsertBefore(name, "-")
        editor.InsertAfter(name, ")")
        Assert.Contains("return (-a)\n", editor.GetChangedText().ToString())
        Assert.Equal(3, editor.GetChanges().Length)
    }

    @Fact
    func OverlappingEdits_Throw() {
        const source = "package P\n\nfunc F(a int32) int32 {\n    return a + 1\n}\n"
        let tree = SyntaxTree.Parse(source)
        let binary = tree.Root.DescendantNodes().OfType[BinaryExpressionSyntax]().Single()
        let editor = SyntaxEditor(tree)
        editor.ReplaceNode(binary, "a - 1")
        Assert.Throws[InvalidOperationException](() -> editor.ReplaceToken(binary.GetFirstToken(), "b"))
        Assert.Throws[InvalidOperationException](() -> editor.InsertAfter(binary.GetFirstToken(), "b"))
        // An insertion at the edge of a replacement does not overlap it.
        editor.InsertAfter(binary, " ")
        Assert.Equal(2, editor.GetChanges().Length)
    }

    @Fact
    func EditOnMissingToken_Throws() {
        let tree = SyntaxTree.Parse("package P\n\nfunc F() int32 {\n    return (1\n}\n")
        let missing = tree.Root.DescendantTokens().First((t SyntaxToken) -> t.IsMissing)
        let editor = SyntaxEditor(tree)
        Assert.Throws[InvalidOperationException](() -> editor.ReplaceToken(missing, ")"))
    }

    @Fact
    func NodeOfAnotherTree_Throws() {
        let tree = SyntaxTree.Parse("package P\n")
        let other = SyntaxTree.Parse("package Q\n")
        Assert.Throws[ArgumentException](() -> SyntaxEditor(tree).ReplaceToken(other.Root.GetFirstToken(), "x"))
    }

    @Fact
    func Placeholders_AreMappedToTheChangedText() {
        const source = "package P\n\nfunc F(a int32) int32 {\n    return a\n}\n"
        let tree = SyntaxTree.Parse(source)
        let name = tree.Root.DescendantNodes().OfType[ReturnStatementSyntax]().Single().GetLastToken()
        let editor = SyntaxEditor(tree)
        editor.InsertBefore(tree.Root.GetFirstToken(), "// head\n")
        editor.ReplaceToken(name, "a + VALUE")
        editor.MarkPlaceholder(4, 5)
        let text = editor.GetChangedText().ToString()
        let placeholder = Assert.Single(editor.GetPlaceholders())
        Assert.Equal("VALUE", text.Substring(placeholder.Start, placeholder.Length))
    }

    private func Token(tree SyntaxTree, text string) SyntaxToken -> tree
        .Root
        .DescendantTokens()
        .First((t SyntaxToken) -> t.Text == text)
}
