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

    @Fact
    func OpenDocument_IsFoundUnderAnEquivalentUri() {
        let service = DocumentContentService()
        let path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "adr0227a.gs")
        let stored = LanguageServerTestHelpers.Content(Source).WithVersion(4)
        service.AddOrUpdate(DocumentUri.FromFileSystemPath(path)!!.ToString(), stored)
        let encoded = DocumentUri.From(
            DocumentUri.FromFileSystemPath(path)!!.ToString().Replace("adr0227a.gs", "adr0227%61.gs")
        )!!
        Assert.Same(stored, GSharp.LanguageServer.Server.LspServer.FindOpenDocument(service, encoded))
        Assert.Null(
            GSharp
                .LanguageServer
                .Server
                .LspServer
                .FindOpenDocument(service, DocumentUri.FromFileSystemPath(path + ".other")!!)
        )
    }

    @Fact
    func Resolve_ForAnOpenBufferOfAProject_UsesTheProjectSnapshot() {
        let directory = System.IO.Directory.CreateTempSubdirectory("gs-ls-codefix-resolve")
        try {
            let path = System.IO.Path.Combine(directory.FullName, "main.gs")
            System.IO.File.WriteAllText(path, Source)
            let project = ProjectState(System.IO.Path.Combine(directory.FullName, "App.gsproj"))
            project.UpdateFile(path, Source)
            // The buffer's tree is not the project's tree, as after a watcher refresh.
            let buffer = SyntaxTree.Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(Source, path))
            let lines = List[int32]()
            for var i = 0; i < Source.Length; i++ {
                if Source[i] == '\n' {
                    lines.Add(i)
                }
            }
            let content = DocumentContent(buffer, lines, project, nil, 2)
            let uri = DocumentUri.FromFileSystemPath(path)!!
            let at = LanguageServerTestHelpers.PositionOf(Source, "null")
            let client = CodeActionClientOptions{SupportsResolveEdit: true}
            let listed = CodeActionComputer
                .ComputeCodeActions(uri, content, Range(at, at), nil, client)
                .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Use 'nil'")
                .CodeAction
            Assert.NotNull(CodeActionComputer.ResolveCodeAction(listed, content, client).Edit)
        } finally {
            directory.Delete(true)
        }
    }

    @Fact
    func PreferredFix_IsChosenAmongTheOfferedFixes() {
        let content = LanguageServerTestHelpers.Content(Source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(Source, "null")
        let registry = GSharp.Core.CodeAnalysis.CodeFixes.CodeFixRegistry.CreateDefault()
        registry.Add(ThrowingComputeProvider(GSharp.Core.CodeAnalysis.CodeFixes.Applicability.MachineApplicable))
        let fix = CodeActionComputer
            .ComputeCodeActions(
            uri,
            content,
            Range(at, at),
            nil,
            CodeActionClientOptions(),
            registry,
            default(System.Threading.CancellationToken)
        )
            .Single((a CommandOrCodeAction) -> a.CodeAction.Title == "Use 'nil'")
            .CodeAction
        Assert.True(fix.IsPreferred)
    }

    // A fix whose deferred computation throws.
    private class ThrowingComputeProvider : GSharp.Core.CodeAnalysis.CodeFixes.GSharpCodeFixProvider {
        private let applicability GSharp.Core.CodeAnalysis.CodeFixes.Applicability

        init(
            applicability GSharp
                .Core
                .CodeAnalysis
                .CodeFixes
                .Applicability = GSharp
                .Core
                .CodeAnalysis
                .CodeFixes
                .Applicability
                .MaybeIncorrect
        ) {
            this.applicability = applicability
        }

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
                applicability,
                (editor SyntaxEditor) -> {
                    throw InvalidOperationException("broken provider")
                }
            )
        }
    }

    @Fact
    func SourceFixAll_AppliesEveryMachineApplicableFix_OnlyWhenAsked() {
        const source = "package P\n\nfunc F(a bool, b bool) string? {\n    if a or b {\n        return null\n    }\n    return null\n}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let origin = Position(0, 0)
        Assert.DoesNotContain(
            CodeActionComputer.ComputeCodeActions(uri, content, Range(origin, origin)),
            (a CommandOrCodeAction) -> a.CodeAction.Kind == CodeActionKind.SourceFixAllGSharp
        )
        let context = CodeActionContext{Only: []CodeActionKind{CodeActionKind("source.fixAll")}}
        let action = Assert.Single(
            CodeActionComputer.ComputeCodeActions(
                uri,
                content,
                Range(origin, origin),
                context,
                CodeActionClientOptions()
            )
        )
            .CodeAction
        Assert.Equal(CodeActionKind.SourceFixAllGSharp, action.Kind)
        let edit = Assert.Single(action.Edit!!.Changes!![uri])
        let start = LanguageServerTestHelpers.PositionOf(source, "or")
        Assert.Equal(start.Line, edit.Range.Start.Line)
        Assert.Contains("||", edit.NewText, StringComparison.Ordinal)
        Assert.Contains("nil", edit.NewText, StringComparison.Ordinal)
        Assert.DoesNotContain("null", edit.NewText, StringComparison.Ordinal)
    }

    @Fact
    func SourceFixAll_ThatAddsASyntaxError_IsNotOffered() {
        // GS0125 has no compiler suggestion, so the breaking provider is the only fix.
        let content = LanguageServerTestHelpers.Content("package P\n\nfunc F() int32 {\n    return missing\n}\n")
        let uri = DocumentUri.From("file:///a.gs")!!
        let origin = Position(0, 0)
        let registry = GSharp.Core.CodeAnalysis.CodeFixes.CodeFixRegistry()
        registry.Add(BreakingProvider())
        let context = CodeActionContext{Only: []CodeActionKind{CodeActionKind("source.fixAll")}}
        let actions = CodeActionComputer.ComputeCodeActions(
            uri,
            content,
            Range(origin, origin),
            context,
            CodeActionClientOptions(),
            registry,
            default(System.Threading.CancellationToken)
        )
        Assert.Empty(actions)
    }

    // A machine-applicable fix that leaves an open parenthesis.
    private class BreakingProvider : GSharp.Core.CodeAnalysis.CodeFixes.GSharpCodeFixProvider {
        override prop FixableDiagnosticIds System
            .Collections
            .Immutable
            .ImmutableArray[string] -> System
            .Collections
            .Immutable
            .ImmutableArray
            .Create("GS0125")

        override func RegisterCodeFixes(context GSharp.Core.CodeAnalysis.CodeFixes.CodeFixContext) {
            let token = context.Tree.Root.FindToken(context.Diagnostic.Location.Span.Start)!!
            context.RegisterFix(
                "Break",
                "test.break",
                GSharp.Core.CodeAnalysis.CodeFixes.Applicability.MachineApplicable,
                (editor SyntaxEditor) -> editor.ReplaceToken(token, "(nil")
            )
        }
    }

    @Fact
    func DataDefinedFix_ThatAddsADiagnostic_IsNotOffered() {
        const source = "package P\n\nfunc F() string? {\n    return null\n}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(source, "null")
        for dataDefined in[]bool{false, true} {
            let registry = GSharp.Core.CodeAnalysis.CodeFixes.CodeFixRegistry()
            registry.Add(UndefinedNameProvider(dataDefined))
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
            // The hand-written fix gets only the syntax gate; the data-defined one gets the full gate.
            Assert.Equal(!dataDefined, titles.Contains("Use an undefined name"))
            Assert.Contains("Use 'nil'", titles)
        }
    }

    @Fact
    func SourceFixAll_WithADataDefinedFixThatAddsADiagnostic_IsNotOffered() {
        const source = "package P\n\nfunc F() int32 {\n    let x = 1\n    x = 2\n    return x\n}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let origin = Position(0, 0)
        let context = CodeActionContext{Only: []CodeActionKind{CodeActionKind("source.fixAll")}}
        for dataDefined in[]bool{false, true} {
            let registry = GSharp.Core.CodeAnalysis.CodeFixes.CodeFixRegistry()
            registry.Add(
                UndefinedNameProvider(
                    dataDefined,
                    "GS0127",
                    GSharp.Core.CodeAnalysis.CodeFixes.Applicability.MachineApplicable
                )
            )
            let actions = CodeActionComputer.ComputeCodeActions(
                uri,
                content,
                Range(origin, origin),
                context,
                CodeActionClientOptions(),
                registry,
                default(System.Threading.CancellationToken)
            )
            // FixAll gates the batch on syntax only; a batch with a data-defined fix gets the full gate.
            Assert.Equal(
                !dataDefined,
                actions.Any((a CommandOrCodeAction) -> a.CodeAction.Kind == CodeActionKind.SourceFixAllGSharp)
            )
        }
    }

    @Fact
    func DataDefinedFix_ThatAddsAnAnalyzerDiagnostic_IsNotOffered() {
        const source = "package P\n\nfunc F() string? {\n    return null\n}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(source, "null")
        let analyzers = []GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer{NilAnalyzer()}
        for withAnalyzers in[]bool{false, true} {
            let registry = GSharp.Core.CodeAnalysis.CodeFixes.CodeFixRegistry()
            registry.Add(NilProvider())
            let titles = CodeActionComputer
                .ComputeCodeActions(
                uri,
                content,
                Range(at, at),
                nil,
                CodeActionClientOptions(),
                registry,
                if withAnalyzers {
                    analyzers
                } else {
                    nil
                },
                default(System.Threading.CancellationToken)
            )
                .Select((a CommandOrCodeAction) -> a.CodeAction.Title)
                .ToList()
            // The full gate runs the project's analyzers: the edit adds the analyzer's diagnostic.
            Assert.Equal(!withAnalyzers, titles.Contains("Write nil (data)"))
        }
    }

    @Fact
    func DataDefinedFix_IsNotOffered_WhenAnAnalyzerDoesNotRunToTheEnd() {
        const source = "package P\n\nfunc F() string? {\n    return null\n}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///a.gs")!!
        let at = LanguageServerTestHelpers.PositionOf(source, "null")
        for broken in[]bool{false, true} {
            let registry = GSharp.Core.CodeAnalysis.CodeFixes.CodeFixRegistry()
            registry.Add(NilProvider())
            let analyzers = if broken {
                []GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer{ThrowingTreeAnalyzer()}
            } else {
                []GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer{}
            }
            let titles = CodeActionComputer
                .ComputeCodeActions(
                uri,
                content,
                Range(at, at),
                nil,
                CodeActionClientOptions(),
                registry,
                analyzers,
                default(System.Threading.CancellationToken)
            )
                .Select((a CommandOrCodeAction) -> a.CodeAction.Title)
                .ToList()
            // An analyzer that throws before and after the edit leaves the gate incomplete.
            Assert.Equal(!broken, titles.Contains("Write nil (data)"))
        }
    }

    // An analyzer that throws on every tree.
    private class ThrowingTreeAnalyzer : GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics System
            .Collections
            .Immutable
            .ImmutableArray[GSharp.Core.CodeAnalysis.DiagnosticDescriptor] -> System
            .Collections
            .Immutable
            .ImmutableArray
            .Create(NilAnalyzer.NilRule)

        override func Initialize(context GSharp.Core.CodeAnalysis.Analyzers.AnalysisContext) {
            context.RegisterSyntaxTreeAction(
                (_ GSharp.Core.CodeAnalysis.Analyzers.SyntaxTreeAnalysisContext) -> {
                    throw InvalidOperationException("broken analyzer")
                }
            )
        }
    }

    // A data-defined fix that writes `nil` for `null`.
    private class NilProvider : GSharp.Core.CodeAnalysis.CodeFixes.GSharpCodeFixProvider {
        override prop FixableDiagnosticIds System
            .Collections
            .Immutable
            .ImmutableArray[string] -> System
            .Collections
            .Immutable
            .ImmutableArray
            .Create("GS0273")

        override prop IsDataDefined bool -> true

        override func RegisterCodeFixes(context GSharp.Core.CodeAnalysis.CodeFixes.CodeFixContext) {
            let token = context.Tree.Root.FindToken(context.Diagnostic.Location.Span.Start)!!
            context.RegisterFix(
                "Write nil (data)",
                "test.nil",
                GSharp.Core.CodeAnalysis.CodeFixes.Applicability.MaybeIncorrect,
                (editor SyntaxEditor) -> editor.ReplaceToken(token, "nil")
            )
        }
    }

    // An analyzer that reports every `nil`.
    private class NilAnalyzer : GSharp.Core.CodeAnalysis.Analyzers.GSharpDiagnosticAnalyzer {
        override prop SupportedDiagnostics System
            .Collections
            .Immutable
            .ImmutableArray[GSharp.Core.CodeAnalysis.DiagnosticDescriptor] -> System
            .Collections
            .Immutable
            .ImmutableArray
            .Create(NilRule)

        override func Initialize(context GSharp.Core.CodeAnalysis.Analyzers.AnalysisContext) {
            context.RegisterSyntaxTreeAction(
                (ctx GSharp.Core.CodeAnalysis.Analyzers.SyntaxTreeAnalysisContext) -> {
                    for token in ctx.Tree.Root.DescendantTokens() {
                        if token.Text == "nil" {
                            ctx.ReportDiagnostic(GSharp.Core.CodeAnalysis.Diagnostic.Create(NilRule, token.Location))
                        }
                    }
                }
            )
        }

        shared {
            let NilRule GSharp
                .Core
                .CodeAnalysis
                .DiagnosticDescriptor = GSharp
                .Core
                .CodeAnalysis
                .DiagnosticDescriptor("TEST0230", GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning, "nil")
        }
    }

    // A fix that replaces the token at the diagnostic with a name that does not exist: it adds GS0125.
    private class UndefinedNameProvider : GSharp.Core.CodeAnalysis.CodeFixes.GSharpCodeFixProvider {
        private let dataDefined bool
        private let id string
        private let applicability GSharp.Core.CodeAnalysis.CodeFixes.Applicability

        convenience init(dataDefined bool) {
            init(dataDefined, "GS0273", GSharp.Core.CodeAnalysis.CodeFixes.Applicability.MaybeIncorrect)
        }

        init(dataDefined bool, id string, applicability GSharp.Core.CodeAnalysis.CodeFixes.Applicability) {
            this.dataDefined = dataDefined
            this.id = id
            this.applicability = applicability
        }

        override prop FixableDiagnosticIds System
            .Collections
            .Immutable
            .ImmutableArray[string] -> System
            .Collections
            .Immutable
            .ImmutableArray
            .Create(id)

        override prop IsDataDefined bool -> dataDefined

        override func RegisterCodeFixes(context GSharp.Core.CodeAnalysis.CodeFixes.CodeFixContext) {
            let token = context.Tree.Root.FindToken(context.Diagnostic.Location.Span.Start)!!
            context.RegisterFix(
                "Use an undefined name",
                "test.undefined",
                applicability,
                (editor SyntaxEditor) -> editor.ReplaceToken(token, "undefinedName")
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
