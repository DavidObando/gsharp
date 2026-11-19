// <copyright file="Adr0227CodeActionTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import Range = GSharp.LanguageServer.Protocol.Range
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0227 D7: the server offers the Core code fixes with their diagnostics, prefers the one
/// machine-applicable fix, filters by `only`, resolves edits lazily, and emits versioned edits.
open class Adr0227CodeActionTests {
    const Source string = "package P\n\nfunc F() string? {\n    return null\n}\n"

    @Fact
    func NullFix_IsPreferred_AndCarriesItsDiagnostic() {
        let content = LanguageServerTestHelpers.Content(Source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let actions = CodeActionComputer.ComputeCodeActions(uri, content, Range(at, at)).ToList()
        let fix = Assert.Single(actions, (a CommandOrCodeAction) -> a.CodeAction.Title == "Use 'nil'").CodeAction
        Assert.Equal(CodeActionKind.QuickFix, fix.Kind)
        Assert.True(fix.IsPreferred)
        Assert.Equal("GS0273", Assert.Single(fix.Diagnostics!!).Code!!.ToString())
        let edit = Assert.Single(fix.Edit!!.Changes!![uri])
        Assert.Equal("nil", edit.NewText)
    }

    @Fact
    func Only_FiltersKinds() {
        const source = "package P\n\nimport Zeta\nimport Alpha\n\nfunc F() string? {\n    return null\n}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(source, "null")
        let quickFixOnly = CodeActionContext{Only: []CodeActionKind{CodeActionKind.QuickFix}}
        let fixes = CodeActionComputer.ComputeCodeActions(
            uri,
            content,
            Range(at, at),
            quickFixOnly,
            CodeActionClientOptions()
        )
            .ToList()
        Assert.NotEmpty(fixes)
        Assert.All(fixes, (a CommandOrCodeAction) -> Assert.Equal(CodeActionKind.QuickFix, a.CodeAction.Kind))
        let refactorOnly = CodeActionContext{Only: []CodeActionKind{CodeActionKind.Refactor}}
        let refactors = CodeActionComputer.ComputeCodeActions(
            uri,
            content,
            Range(at, at),
            refactorOnly,
            CodeActionClientOptions()
        )
            .ToList()
        Assert.Equal("Sort imports", Assert.Single(refactors).CodeAction.Title)
    }

    @Fact
    func VersionedClient_GetsDocumentChangesWithTheVersion() {
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(7)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let client = CodeActionClientOptions{SupportsDocumentChanges: true}
        let fix = CodeActionComputer
            .ComputeCodeActions(uri, content, Range(at, at), nil, client)
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Use 'nil'")
            .CodeAction
        Assert.Null(fix.Edit!!.Changes)
        let documentEdit = Assert.Single(fix.Edit!!.DocumentChanges!!)
        Assert.Equal(7, documentEdit.TextDocument.Version)
        Assert.Equal(uri, documentEdit.TextDocument.Uri)
        Assert.Equal("nil", Assert.Single(documentEdit.Edits).NewText)
    }

    @Fact
    func ResolveClient_GetsDataFirst_ThenTheEdit_AndAStaleVersionGetsNone() {
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(3)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let client = CodeActionClientOptions{SupportsResolveEdit: true}
        let listed = CodeActionComputer
            .ComputeCodeActions(uri, content, Range(at, at), nil, client)
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Use 'nil'")
            .CodeAction
        Assert.Null(listed.Edit)
        Assert.Equal(3, listed.Data!!.Version)
        let resolved = CodeActionComputer.ResolveCodeAction(listed, content, client)
        Assert.Equal("nil", Assert.Single(resolved.Edit!!.Changes!![uri]).NewText)
        let stale = CodeActionComputer
            .ComputeCodeActions(uri, content, Range(at, at), nil, client)
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Use 'nil'")
            .CodeAction
        let newer = LanguageServerTestHelpers.Content(Source).WithVersion(4)
        Assert.Null(CodeActionComputer.ResolveCodeAction(stale, newer, client).Edit)
    }

    @Fact
    func CSharpIsms_AreOffered() {
        AssertOffered("package P\n\nclass C { }\n\nfunc F() C {\n    return new C()\n}\n", "new", "Remove 'new'", "")
        AssertOffered(
            "package P\n\nfunc F() int32 {\n    let x = 1\n    x = 2\n    return x\n}\n",
            "= 2",
            "Change 'let' to 'var'",
            "var"
        )
        AssertOffered("package P\n\nfunc F(a bool, b bool) bool {\n    return a or b\n}\n", "or", "Use '||'", "||")
    }

    private func AssertOffered(source string, at string, title string, newText string) {
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let position = LanguageServerTestHelpers.PositionOf(source, at)
        let action = CodeActionComputer
            .ComputeCodeActions(uri, content, Range(position, position))
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == title)
            .CodeAction
        Assert.Equal(newText, Assert.Single(action.Edit!!.Changes!![uri]).NewText)
    }
}
