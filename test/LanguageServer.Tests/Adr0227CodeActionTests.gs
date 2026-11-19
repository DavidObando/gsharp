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

    @Fact
    func Resolve_ReturnsTheListedEdit_AndNothingForAnotherSnapshotOrAnUnknownId() {
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(5)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let client = CodeActionClientOptions{SupportsResolveEdit: true}
        let listed = CodeActionComputer
            .ComputeCodeActions(uri, content, Range(at, at), nil, client)
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Use 'nil'")
            .CodeAction
        Assert.Equal(
            "nil",
            Assert.Single(CodeActionComputer.ResolveCodeAction(listed, content, client).Edit!!.Changes!![uri]).NewText
        )
        // The same version of a text that was parsed again is another snapshot.
        let reparsed = LanguageServerTestHelpers.Content(Source).WithVersion(5)
        let again = CodeActionComputer
            .ComputeCodeActions(uri, content, Range(at, at), nil, client)
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Use 'nil'")
            .CodeAction
        Assert.Null(CodeActionComputer.ResolveCodeAction(again, reparsed, client).Edit)
        let unknown = CodeAction{
            Title: "Use 'nil'",
            Kind: CodeActionKind.QuickFix,
            Data: CodeActionData{Uri: uri.ToString(), Version: 5, Key: "missing"}
        }
        Assert.Null(CodeActionComputer.ResolveCodeAction(unknown, content, client).Edit)
    }

    @Fact
    func EditOfAnotherOpenDocument_CarriesItsClientVersion() {
        let content = LanguageServerTestHelpers.Content(Source).WithVersion(1)
        let uri = DocumentUri.From("file:///a.gs")!!
        let otherPath = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "adr0227-other.gs")
        let otherUri = DocumentUri.FromFileSystemPath(otherPath)!!
        let other = SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From("package P\n", otherPath))
        let changes = GSharp
            .Core
            .CodeAnalysis
            .CodeFixes
            .FixChanges(
            System
                .Collections
                .Immutable
                .ImmutableArray
                .Create(
                GSharp
                    .Core
                    .CodeAnalysis
                    .CodeFixes
                    .DocumentChanges(
                    other,
                    System
                        .Collections
                        .Immutable
                        .ImmutableArray
                        .Create(
                        GSharp.Core.CodeAnalysis.Text.TextChange(GSharp.Core.CodeAnalysis.Text.TextSpan(0, 0), "// x\n")
                    ),
                    System.Collections.Immutable.ImmutableArray[GSharp.Core.CodeAnalysis.Text.TextSpan].Empty
                )
            )
        )
        let stored = DocumentContent(other, List[int32](), nil, nil, 9)
        let client = CodeActionClientOptions{
            SupportsDocumentChanges: true,
            DocumentOf: (u DocumentUri) -> if u.ToString() == otherUri.ToString() {
                stored
            } else {
                default(DocumentContent?)
            }
        }
        let edit = CodeActionComputer.BuildEdit(uri, content, changes, client)!!
        let documentEdit = Assert.Single(edit.DocumentChanges!!)
        Assert.Equal(otherUri.ToString(), documentEdit.TextDocument.Uri.ToString())
        Assert.Equal(9, documentEdit.TextDocument.Version)
        // The open document changed after the fix was computed: its ranges are stale, so no edit.
        let changed = DocumentContent(
            SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From("package Q\n", otherPath)),
            List[int32](),
            nil,
            nil,
            10
        )
        let staleClient = CodeActionClientOptions{SupportsDocumentChanges: true, DocumentOf: (u DocumentUri) -> changed}
        Assert.Null(CodeActionComputer.BuildEdit(uri, content, changes, staleClient))
    }

    @Fact
    func ProviderThatThrowsWhenComputing_LosesOnlyItsFix() {
        const source = "package P\n\nimport Zeta\nimport Alpha\n\nfunc F() string? {\n    return null\n}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(source, "null")
        let registry = GSharp.Core.CodeAnalysis.CodeFixes.CodeFixRegistry.CreateDefault()
        registry.Add(ThrowingComputeProvider())
        let titles = CodeActionComputer
            .ComputeCodeActions(
            uri,
            content,
            Range(at, at),
            nil,
            CodeActionClientOptions(),
            registry,
            default(System.Threading.CancellationToken)
        )
            .Select((a CommandOrCodeAction) -> a.CodeAction.Title)
            .ToList()
        Assert.Contains("Use 'nil'", titles)
        Assert.Contains("Sort imports", titles)
        Assert.DoesNotContain("Throws later", titles)
    }

    @Fact
    func ContextDiagnostic_WithAnIntegerCode_Deserializes() {
        const json = `{"textDocument":{"uri":"file:///a.gs"},"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}},"context":{"diagnostics":[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"code":123,"message":"m"}]}}`
        let request = System.Text.Json.JsonSerializer.Deserialize[CodeActionParams](json, LspJson.Options)
        Assert.Equal("123", Assert.Single(request.Context!!.Diagnostics!!).Code!!.ToString())
    }

    @Fact
    func ProjectRegistry_ForgetsAnalyzerProviders_WhenTheConfigurationIsRemoved() {
        let directory = System.IO.Directory.CreateTempSubdirectory("gs-ls-codefix-tests")
        try {
            let rsp = System.IO.Path.Combine(directory.FullName, "App.rsp")
            System
                .IO
                .File
                .WriteAllLines(rsp, []string{"/gsanalyzer:" + typeof(Adr0227ProbeFixProvider).Assembly.Location})
            let project = ProjectState(System.IO.Path.Combine(directory.FullName, "App.gsproj")){
                ReferenceSourcePath = rsp
            }
            let builtIns = GSharp.Core.CodeAnalysis.CodeFixes.CodeFixRegistry.CreateDefault().Providers.Length
            Assert.Contains(
                project.GetCodeFixRegistry().Providers,
                // The host loads the assembly in its own load context, so the type is compared by name.
                (p GSharp.Core.CodeAnalysis.CodeFixes.GSharpCodeFixProvider) -> p.GetType()
                    .FullName == typeof(Adr0227ProbeFixProvider).FullName
            )
            System.IO.File.Delete(rsp)
            Assert.Equal(builtIns, project.GetCodeFixRegistry().Providers.Length)
        } finally {
            directory.Delete(true)
        }
    }

    @Fact
    func AnalyzerWithAThrowingMetadataGetter_IsSkipped() {
        let registry = GSharp.Core.CodeAnalysis.CodeFixes.CodeFixRegistry()
        registry.Add(Adr0227ProbeFixProvider())
        let analyzers = System
            .Collections
            .Immutable
            .ImmutableArray
            .Create[GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer](
            ThrowingMetadataAnalyzer(),
            ProbeIdAnalyzer()
        )
        Assert.True(CodeActionComputer.AnyFixable(analyzers, registry, default(System.Threading.CancellationToken)))
    }

    private class ThrowingMetadataAnalyzer : GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics System
            .Collections
            .Immutable
            .ImmutableArray[GSharp.Core.CodeAnalysis.DiagnosticDescriptor] {
            get {
                throw InvalidOperationException("broken metadata")
            }
        }

        override func Initialize(context GSharp.Core.CodeAnalysis.Analyzers.AnalysisContext) { }
    }

    private class ProbeIdAnalyzer : GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics System
            .Collections
            .Immutable
            .ImmutableArray[GSharp.Core.CodeAnalysis.DiagnosticDescriptor] -> System
            .Collections
            .Immutable
            .ImmutableArray
            .Create(
            GSharp
                .Core
                .CodeAnalysis
                .DiagnosticDescriptor("TEST0229", GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning, "probe")
        )

        override func Initialize(context GSharp.Core.CodeAnalysis.Analyzers.AnalysisContext) { }
    }

    // A fix whose deferred computation throws.
    private class ThrowingComputeProvider : GSharp.Core.CodeAnalysis.CodeFixes.GSharpCodeFixProvider {
        override prop FixableDiagnosticIds System
            .Collections
            .Immutable
            .ImmutableArray[string] -> System
            .Collections
            .Immutable
            .ImmutableArray
            .Create("GS0273")

        override func RegisterCodeFixes(context GSharp.Core.CodeAnalysis.CodeFixes.CodeFixContext) {
            context.RegisterFix(
                "Throws later",
                "test.throws",
                GSharp.Core.CodeAnalysis.CodeFixes.Applicability.MaybeIncorrect,
                (editor SyntaxEditor) -> {
                    throw InvalidOperationException("broken provider")
                }
            )
        }
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

/// A provider that the analyzer host discovers in this test assembly (ADR-0227 D2).
@GSharp.Core.CodeAnalysis.CodeFixes.GSharpCodeFixProvider
class Adr0227ProbeFixProvider : GSharp.Core.CodeAnalysis.CodeFixes.GSharpCodeFixProvider {
    override prop FixableDiagnosticIds System
        .Collections
        .Immutable
        .ImmutableArray[string] -> System
        .Collections
        .Immutable
        .ImmutableArray
        .Create("TEST0229")

    override func RegisterCodeFixes(context GSharp.Core.CodeAnalysis.CodeFixes.CodeFixContext) { }
}
