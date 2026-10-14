// <copyright file="LspServerMemberFeatureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks
import Xunit

/// End-to-end coverage (through the real (cref:LspServer) request pipeline, including
/// didOpen, diagnostic pulls and didChange edits) for class-member features that resolve a
/// property/field receiver: go-to-definition, member completion, and reference code lens.
/// Regression guard for the member-symbol resolution gaps that returned no result.
open class LspServerMemberFeatureTests {
    @Fact
    async func PropertyMemberFeatures_WorkAfterEditsAndDiagnostics() {
        let rootDir = Path.Combine(Path.GetTempPath(), "gsmf_" + Guid.NewGuid().ToString("N"))
        let projDir = Path.Combine(rootDir, "Demo")
        Directory.CreateDirectory(projDir)
        try {
            File.WriteAllText(Path.Combine(projDir, "Demo.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>
</Project>
`)
            let v1 = `package Demo

class Rect {
    prop Width int32
    prop Height int32
    func Area() int32 { return Width }
}
`
            let gsPath = Path.Combine(projDir, "Rect.gs")
            File.WriteAllText(gsPath, v1)
            let workspace = WorkspaceState()
            WorkspaceInitializer.Initialize(workspace, rootDir)
            let server = LspServer(DocumentContentService(), workspace)
            let uri = DocumentUri.FromFileSystemPath(gsPath)!!
            let id = TextDocumentIdentifier{Uri: uri}
            await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: v1}})
            let _ = await server.DocumentDiagnosticAsync(
                DocumentDiagnosticParams{TextDocument: id},
                CancellationToken.None
            )
            // Edit (didChange), then pull diagnostics — mirrors the real editor lifecycle.
            let v2 = `package Demo

class Rect {
    prop Width int32
    prop Height int32
    func Area() int32 { return Width * Height }
}
`
            File.WriteAllText(gsPath, v2)
            await ChangeAsync(server, uri, v2, 2)
            let _ = await server.DocumentDiagnosticAsync(
                DocumentDiagnosticParams{TextDocument: id},
                CancellationToken.None
            )
            // 1) go-to-definition on the implicit-this property usage `Width`.
            let def = await server.DefinitionAsync(
                DefinitionParams{TextDocument: id, Position: LanguageServerTestHelpers.PositionOf(v2, "Width", 1)}
            )
            Assert.NotNull(def)
            let defLocation = Assert.Single(def)
            Assert.Equal(3, defLocation.Range.Start.Line) // `prop Width` declaration
            // 2) reference code lens is produced for the file.
            let lenses = await server.CodeLensAsync(CodeLensParams{TextDocument: id})
            Assert.NotNull(lenses)
            Assert.NotEmpty(lenses)
            // 3) member completion after `Width.` (property receiver).
            let v3 = `package Demo

class Rect {
    prop Width int32
    prop Height int32
    func Area() int32 { return Width. }
}
`
            File.WriteAllText(gsPath, v3)
            await ChangeAsync(server, uri, v3, 3)
            let dotPos = LanguageServerTestHelpers.PositionOf(v3, "Width.", 0)
            let completion = await server.CompletionAsync(
                CompletionParams{TextDocument: id, Position: Position(dotPos.Line, dotPos.Character + "Width.".Length)}
            )
            Assert.NotNull(completion)
            Assert.NotEmpty(completion.Items)
            Assert.DoesNotContain(completion.Items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
        } finally {
            try {
                Directory.Delete(rootDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func ChangeAsync(server LspServer, uri DocumentUri, text string, version int32) Task -> server
            .DidChangeAsync(
            DidChangeTextDocumentParams{
                TextDocument: VersionedTextDocumentIdentifier{Uri: uri, Version: version},
                ContentChanges: List[TextDocumentContentChangeEvent]{TextDocumentContentChangeEvent{Text: text}}
            }
        )
    }
}
