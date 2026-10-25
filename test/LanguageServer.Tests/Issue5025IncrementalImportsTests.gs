// <copyright file="Issue5025IncrementalImportsTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Threading
import System.Threading.Tasks
import Xunit

open class Issue5025IncrementalImportsTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    async func FullTextBodyEdits_KeepImportedLocalHoversAndDiagnostics(vscodeUri bool) {
        if vscodeUri && !OperatingSystem.IsWindows() {
            return
        }
        let root = Path.Combine(Directory.GetCurrentDirectory(), "issue5025-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        let documents = DocumentContentService()
        let workspace = WorkspaceState()
        let server = LspServer(documents, workspace)
        try {
            let path = Path.Combine(root, "Example.gs")
            File.WriteAllText(path, Source)
            let project = workspace.AddProject(Path.Combine(root, "Example.gsproj"))
            project.References = []string{typeof(object).Assembly.Location}
            project.UpdateFile(path, Source)
            workspace.RegisterFile(path, project)
            let initial = project.GetCompilation()
            Assert.Empty(initial.GlobalScope.Diagnostics)
            Assert.Empty(initial.BoundProgram.Diagnostics)
            let canonicalUri = DocumentUri.FromFileSystemPath(path)!!
            let uri = if vscodeUri {
                DocumentUri.From(
                    canonicalUri.ToString().Replace(
                        path.Substring(0, 2),
                        path.Substring(0, 1).ToLowerInvariant() + "%3A",
                        StringComparison.OrdinalIgnoreCase
                    )
                )!!
            } else {
                canonicalUri
            }
            if vscodeUri {
                Assert.Contains("%3A", uri.ToString())
                Assert.Equal(char.ToLowerInvariant(path[0]), uri.ToString()[8])
            }
            using let capabilities = JsonDocument.Parse("{\"textDocument\":{\"diagnostic\":{}}}")
            await server.InitializeAsync(InitializeParams{Capabilities: capabilities.RootElement.Clone()})
            await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: Source}})
            await AssertBindingAsync(server, documents, uri, Source)
            let scope_ = project.GetCompilation().GlobalScope
            var version = 1
            for source in[]string{
                Source.Replace("return builder.Length", "return builder.Length + 0"),
                Source.Replace("let builder =", "let builder = ").Replace(
                    "return builder.Length",
                    "\nreturn builder.Length"
                ),
                Source
            } {
                await server.DidChangeAsync(
                    DidChangeTextDocumentParams{
                        TextDocument: VersionedTextDocumentIdentifier{Uri: uri, Version: version++},
                        ContentChanges: List[TextDocumentContentChangeEvent]{
                            TextDocumentContentChangeEvent{Text: source}
                        }
                    }
                )
                await AssertBindingAsync(server, documents, uri, source)
                Assert.Same(scope_, project.GetCompilation().GlobalScope)
            }
            Assert.Equal(Source, File.ReadAllText(path))
        } finally {
            server.Shutdown()
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        private const Source string = `package Repro
import System.Text
class Example {
    func Read() int32 {
        let builder = StringBuilder()
        return builder.Length
    }
}`

        private async func AssertBindingAsync(
            server LspServer,
            documents DocumentContentService,
            uri DocumentUri,
            source string
        ) {
            for var occurrence = 0; occurrence < 2; occurrence++ {
                let hover = Assert.IsType[Hover](
                    await server.HoverAsync(
                        HoverParams{
                            TextDocument: TextDocumentIdentifier{Uri: uri},
                            Position: LanguageServerTestHelpers.PositionOf(source, "builder", occurrence)
                        }
                    )
                )
                Assert.Contains("(local variable) builder System.Text.StringBuilder", hover.Contents.ToString())
                Assert.DoesNotContain("builder ?", hover.Contents.ToString())
            }
            let report = Assert.IsType[FullDocumentDiagnosticReport](
                await server.DocumentDiagnosticAsync(
                    DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: uri}},
                    CancellationToken.None
                )
            )
            Assert.Empty(report.Items)
            Assert.True(documents.TryGet(uri.ToString(), out var content))
            let compilation = content.Project!!.GetCompilation()
            let token = SemanticLookup.FindTokenAt(
                content.SyntaxTree,
                source.IndexOf("builder =", StringComparison.Ordinal)
            )!!
            let local = Assert.IsAssignableFrom[VariableSymbol](SemanticLookup.ResolveSymbol(compilation, token))
            Assert.Equal("System.Text.StringBuilder", local.Type.ClrType?.FullName)
        }
    }
}
