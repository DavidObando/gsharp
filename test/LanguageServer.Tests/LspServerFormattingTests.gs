// <copyright file="LspServerFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// ADR-0179 coverage for canonical whole-document, range, and on-type formatting.
open class LspServerFormattingTests {
    @Fact
    func ServerCapabilities_AdvertiseCanonicalFormattingSurfaces() {
        let capabilities = ServerCapabilitiesFactory.Create()
        Assert.True(capabilities.DocumentFormattingProvider)
        Assert.True(capabilities.DocumentRangeFormattingProvider)
        Assert.NotNull(capabilities.DocumentOnTypeFormattingProvider)
    }

    @Fact
    async func FormattingAsync_MultiStatementBody_KeepsStatementsOnSeparateLines() {
        const source = `func foo() {
var x = 1
var y = 2
}
`
        let (server, uri, gsPath) = await OpenDocumentAsync(source)
        try {
            let edits = await server.FormattingAsync(
                DocumentFormattingParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Options: FormattingOptions{TabSize: 2, InsertSpaces: true}
                }
            )
            let formatted = ApplyEdits(source, edits)
            Assert.Contains("    var x = 1", formatted)
            Assert.Contains("    var y = 2", formatted)
        } finally {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!!, recursive: true)
        }
    }

    @Fact
    async func FormattingAsync_IgnoresRequestFormattingOptions() {
        const source = `func foo() {
var x = 1
}
`
        let (server, uri, gsPath) = await OpenDocumentAsync(source)
        try {
            let edits = await server.FormattingAsync(
                DocumentFormattingParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Options: FormattingOptions{TabSize: 4, InsertSpaces: true}
                }
            )
            Assert.Contains("    var x = 1", ApplyEdits(source, edits))
        } finally {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!!, recursive: true)
        }
    }

    @Fact
    async func RangeFormattingAsync_FormatsIntersectingSource() {
        const source = `func foo() {
var x = 1
var y = 2
}
`
        let (server, uri, gsPath) = await OpenDocumentAsync(source)
        try {
            let edits = await server.RangeFormattingAsync(
                DocumentRangeFormattingParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Range: GSharp
                        .LanguageServer
                        .Protocol
                        .Range{Start: Position{Line: 1, Character: 0}, End: Position{Line: 1, Character: 9}},
                    Options: FormattingOptions{TabSize: 2, InsertSpaces: true}
                }
            )
            let formatted = ApplyEdits(source, edits)
            Assert.Contains(`
    var x = 1
`, formatted)
            Assert.Contains(`
var y = 2
`, formatted)
        } finally {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!!, recursive: true)
        }
    }

    @Fact
    async func OnTypeFormattingAsync_FormatsAtTheCaret() {
        let (server, uri, gsPath) = await OpenDocumentAsync(`func foo() {
var x = 1
var y = 2
}
`)
        try {
            let edits = await server.OnTypeFormattingAsync(
                DocumentOnTypeFormattingParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Position: Position{Line: 2, Character: 9},
                    Ch: "\n",
                    Options: FormattingOptions{TabSize: 2, InsertSpaces: true}
                }
            )
            Assert.NotEmpty(edits)
        } finally {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!!, recursive: true)
        }
    }

    @Fact
    async func InitializeAsync_FeatureOptions_DoNotChangeCanonicalFormatting() {
        const source = `func foo() {
var x = 1
}
`
        let (server, uri, gsPath) = await OpenDocumentAsync(source, initialize: true)
        try {
            let edits = await server.FormattingAsync(
                DocumentFormattingParams{
                    TextDocument: TextDocumentIdentifier{Uri: uri},
                    Options: FormattingOptions{TabSize: 2, InsertSpaces: true}
                }
            )
            Assert.Contains("    var x = 1", ApplyEdits(source, edits))
        } finally {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!!, recursive: true)
        }
    }

    shared {
        private func ApplyEdits(source string, edits[]GSharp.LanguageServer.Protocol.TextEdit) string {
            var source = source
            for edit in edits.OrderByDescending((item GSharp.LanguageServer.Protocol.TextEdit) -> item.Range.Start.Line)
                .ThenByDescending((item GSharp.LanguageServer.Protocol.TextEdit) -> item.Range.Start.Character) {
                let start = ToOffset(source, edit.Range.Start)
                let end = ToOffset(source, edit.Range.End)
                source = source.Substring(0, start) + edit.NewText + source.Substring(end)
            }
            return source
        }

        private func ToOffset(source string, position Position) int32 {
            var offset = 0
            for var line = 0; line < position.Line; line++ {
                let next = source.IndexOf('\n', offset)
                offset = if next < 0 {
                    source.Length
                } else {
                    next + 1
                }
            }
            return Math.Min(source.Length, offset + position.Character)
        }

        private async func OpenDocumentAsync(text string, initialize bool = false)(
            Server LspServer,
            Uri DocumentUri,
            GsPath string
        ) {
            let rootDir = Path.Combine(Path.GetTempPath(), "gsfmt_" + Guid.NewGuid().ToString("N"))
            let projDir = Path.Combine(rootDir, "Demo")
            Directory.CreateDirectory(projDir)
            File.WriteAllText(Path.Combine(projDir, "Demo.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>
</Project>
`)
            let gsPath = Path.Combine(projDir, "Foo.gs")
            File.WriteAllText(gsPath, text)
            let workspace = WorkspaceState()
            WorkspaceInitializer.Initialize(workspace, rootDir)
            let server = LspServer(DocumentContentService(), workspace)
            if initialize {
                await server.InitializeAsync(
                    InitializeParams{
                        InitializationOptions: LanguageServerInitializationOptions{DiagnosticsOnType: false}
                    }
                )
            }
            let uri = DocumentUri.FromFileSystemPath(gsPath)!!
            await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: text}})
            return (server, uri, gsPath)
        }
    }
}
