// <copyright file="CodeActionHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import Range = GSharp.LanguageServer.Protocol.Range
import System
import System.Linq
import Xunit

open class CodeActionHandlerTests {
    @Fact
    func ComputeCodeActions_OffersSortImports() {
        const source = `import Zeta
import Alpha
func F() {}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///actions.gs")!!
        let actions = CodeActionComputer.ComputeCodeActions(uri, content, Range(Position(0, 0), Position(0, 0)))
            .ToList()
        let sort = Assert.Single(actions, (a CommandOrCodeAction) -> a.CodeAction.Title == "Sort imports")
        Assert.Equal(CodeActionKind.RefactorRewrite, sort.CodeAction.Kind)
        Assert.Contains("import Alpha", sort.CodeAction.Edit.Changes[uri].Single().NewText, StringComparison.Ordinal)
    }

    @Fact
    func NullConditionalQuickFix_OfferedOnNullableMemberAccess() {
        // ADR-0099 / issue #730: GS0158 ("Cannot find member") on a `.` access whose receiver
        // is a `T?` should offer a `.` → `?.` rewrite. The rewrite must be valid (the
        // resulting program no longer reports the diagnostic).
        const source = `func main() {
    let x string? = "hi"
    let n = x.Length
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///deref.gs")!!
        let memberStart = LanguageServerTestHelpers.PositionOf(source, "Length")
        let range_ = Range(memberStart, memberStart)
        let actions = CodeActionComputer.ComputeCodeActions(uri, content, range_).ToList()
        let quickFix = Assert.Single(
            actions,
            (a CommandOrCodeAction) -> a.CodeAction.Title == NullabilityQuickFixes.NullConditionalAccessTitle
        )
        Assert.Equal(CodeActionKind.QuickFix, quickFix.CodeAction.Kind)
        let edit = quickFix.CodeAction.Edit.Changes[uri].Single()
        Assert.Equal("?.", edit.NewText)
        // Apply the edit and verify the resulting program no longer reports GS0158.
        let rewritten = ApplyEdit(source, edit)
        let rebound = Compilation(SyntaxTree.Parse(rewritten))
        Assert.DoesNotContain(
            rebound.BoundProgram.Diagnostics,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0158"
        )
    }

    @Fact
    func NullConditionalQuickFix_NotOfferedForRegularMissingMember() {
        // Non-nullable receiver with a typo should NOT trigger the nullable-deref quick fix.
        const source = `func main() {
    let x string = "hi"
    let n = x.Lenghh
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///typo.gs")!!
        let memberStart = LanguageServerTestHelpers.PositionOf(source, "Lenghh")
        let range_ = Range(memberStart, memberStart)
        let actions = CodeActionComputer.ComputeCodeActions(uri, content, range_).ToList()
        Assert.DoesNotContain(
            actions,
            (a CommandOrCodeAction) -> a.CodeAction.Title == NullabilityQuickFixes.NullConditionalAccessTitle
        )
    }

    @Fact
    func ElvisAndAssertion_OfferedOnNullableConversion() {
        // GS0155/GS0156: assigning string? to string.
        const source = `func main() {
    let x string? = "hi"
    let y string = x
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///conv.gs")!!
        let pos = LanguageServerTestHelpers.PositionOf(source, "x", occurrence: 1)
        let range_ = Range(pos, pos)
        let actions = CodeActionComputer.ComputeCodeActions(uri, content, range_).ToList()
        let elvis = Assert.Single(
            actions,
            (a CommandOrCodeAction) -> a
                .CodeAction
                .Title
                .StartsWith("Provide default with '??", StringComparison.Ordinal)
        )
        let bang = Assert.Single(
            actions,
            (a CommandOrCodeAction) -> a.CodeAction.Title == NullabilityQuickFixes.NullAssertionTitle
        )
        Assert.Equal(CodeActionKind.QuickFix, elvis.CodeAction.Kind)
        Assert.Equal(CodeActionKind.QuickFix, bang.CodeAction.Kind)
        let elvisEdit = elvis.CodeAction.Edit.Changes[uri].Single()
        Assert.Equal("(x ?? \"\")", elvisEdit.NewText)
        let bangEdit = bang.CodeAction.Edit.Changes[uri].Single()
        Assert.Equal("(x!!)", bangEdit.NewText)
        // Applying either edit clears the GS0155/GS0156 diagnostic.
        for fix in[]GSharp.LanguageServer.Protocol.TextEdit{elvisEdit, bangEdit} {
            let rewritten = ApplyEdit(source, fix)
            let rebound = Compilation(SyntaxTree.Parse(rewritten))
            Assert.DoesNotContain(
                rebound.BoundProgram.Diagnostics,
                (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0155" || d.Id == "GS0156"
            )
        }
    }

    @Fact
    func ElvisAndAssertion_OfferedOnNullableArgument() {
        // GS0154: passing string? to parameter of type string.
        const source = `func f(s string) {}
func main() {
    let x string? = "hi"
    f(x)
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///arg.gs")!!
        let pos = LanguageServerTestHelpers.PositionOf(source, "f(x)")
        // place the request on the argument
        let argPos = Position(pos.Line, pos.Character + 2)
        let range_ = Range(argPos, argPos)
        let actions = CodeActionComputer.ComputeCodeActions(uri, content, range_).ToList()
        let elvis = Assert.Single(
            actions,
            (a CommandOrCodeAction) -> a
                .CodeAction
                .Title
                .StartsWith("Provide default with '??", StringComparison.Ordinal)
        )
        let bang = Assert.Single(
            actions,
            (a CommandOrCodeAction) -> a.CodeAction.Title == NullabilityQuickFixes.NullAssertionTitle
        )
        let elvisEdit = elvis.CodeAction.Edit.Changes[uri].Single()
        Assert.Equal("(x ?? \"\")", elvisEdit.NewText)
        let bangEdit = bang.CodeAction.Edit.Changes[uri].Single()
        Assert.Equal("(x!!)", bangEdit.NewText)
        // The applied null-assertion fix must remove GS0154.
        let rewritten = ApplyEdit(source, bangEdit)
        let rebound = Compilation(SyntaxTree.Parse(rewritten))
        Assert.DoesNotContain(
            rebound.BoundProgram.Diagnostics,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0154"
        )
    }

    @Fact
    func NullableValueFixes_NotOfferedForLiteralNil() {
        // GS0274 fires on a literal `nil` flowing into a non-nullable parameter. Wrapping `nil`
        // in `??` or `!!` is degenerate — the user has to make the parameter nullable instead
        // (see the diagnostic's own suggestion).
        const source = `func f(s string) {}
func main() {
    f(nil)
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///nil.gs")!!
        let pos = LanguageServerTestHelpers.PositionOf(source, "nil")
        let range_ = Range(pos, pos)
        let actions = CodeActionComputer.ComputeCodeActions(uri, content, range_).ToList()
        Assert.DoesNotContain(
            actions,
            (a CommandOrCodeAction) -> a.CodeAction.Title == NullabilityQuickFixes.NullAssertionTitle
        )
        Assert.DoesNotContain(
            actions,
            (a CommandOrCodeAction) -> a
                .CodeAction
                .Title
                .StartsWith("Provide default with '??", StringComparison.Ordinal)
        )
    }

    @Fact
    func NullableQuickFixes_NotOfferedForUnrelatedDiagnostics() {
        // A pure syntax error elsewhere in the file should not produce any nullability fixes.
        const source = `func main() {
    let y int = "abc"
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///unrelated.gs")!!
        let pos = LanguageServerTestHelpers.PositionOf(source, "\"abc\"")
        let range_ = Range(pos, pos)
        let actions = CodeActionComputer.ComputeCodeActions(uri, content, range_).ToList()
        Assert.DoesNotContain(
            actions,
            (a CommandOrCodeAction) -> a.CodeAction.Title == NullabilityQuickFixes.NullAssertionTitle
        )
        Assert.DoesNotContain(
            actions,
            (a CommandOrCodeAction) -> a.CodeAction.Title == NullabilityQuickFixes.NullConditionalAccessTitle
        )
        Assert.DoesNotContain(
            actions,
            (a CommandOrCodeAction) -> a
                .CodeAction
                .Title
                .StartsWith("Provide default with '??", StringComparison.Ordinal)
        )
    }

    @Fact
    func NullableQuickFixes_RangeOutsideDiagnosticReturnsNothing() {
        const source = `func main() {
    let x string? = "hi"
    let y string = x
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///out-of-range.gs")!!
        // Caret on the first line ("func main()") — the diagnostic is on line 2.
        let range_ = Range(Position(0, 0), Position(0, 0))
        let actions = CodeActionComputer.ComputeCodeActions(uri, content, range_).ToList()
        Assert.DoesNotContain(
            actions,
            (a CommandOrCodeAction) -> a.CodeAction.Title == NullabilityQuickFixes.NullAssertionTitle
        )
        Assert.DoesNotContain(
            actions,
            (a CommandOrCodeAction) -> a
                .CodeAction
                .Title
                .StartsWith("Provide default with '??", StringComparison.Ordinal)
        )
    }

    shared {
        private func ApplyEdit(source string, edit GSharp.LanguageServer.Protocol.TextEdit) string {
            // Convert the LSP-range back to an offset pair and splice in the replacement text.
            let startLine = edit.Range.Start.Line
            let startChar = edit.Range.Start.Character
            let endLine = edit.Range.End.Line
            let endChar = edit.Range.End.Character
            let startOffset = LineCharToOffset(source, startLine, startChar)
            let endOffset = LineCharToOffset(source, endLine, endChar)
            return source.Substring(0, startOffset) + edit.NewText + source.Substring(endOffset)
        }

        private func LineCharToOffset(source string, line int32, character int32) int32 {
            var offset = 0
            for var i = 0; i < line; i++ {
                let nl = source.IndexOf('\n', offset)
                if nl < 0 {
                    return source.Length
                }
                offset = nl + 1
            }
            return Math.Min(offset + character, source.Length)
        }
    }
}
