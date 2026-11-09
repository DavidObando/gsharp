// <copyright file="Issue5904IncrementalRepointTests.cs" company="GSharp">
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
import System.Threading.Tasks
import Xunit

open class Issue5904IncrementalRepointTests {
    @Fact
    async func DidOpen_UnmodifiedDiskFile_PreservesSyntaxTreeAndCompilation_AndResolvesHovers() {
        let root = Path.Combine(Directory.GetCurrentDirectory(), "issue5904-open-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        let documents = DocumentContentService()
        let workspace = WorkspaceState()
        let server = LspServer(documents, workspace)
        try {
            let id3Path = Path.Combine(root, "Id3Reader.gs")
            let yotoPath = Path.Combine(root, "YotoExceptions.gs")
            let initialId3 = Id3Source.Replace("%SHIFT%", "0")
            let initialYoto = YotoSource.Replace("%SHIFT%", "0")
            File.WriteAllText(id3Path, initialId3)
            File.WriteAllText(yotoPath, initialYoto)

            let project = workspace.AddProject(Path.Combine(root, "Waikiki.gsproj"))
            project.References = []string{typeof(object).Assembly.Location}
            let diskId3Tree = project.AddFileFromDisk(id3Path)!!
            let diskYotoTree = project.AddFileFromDisk(yotoPath)!!
            workspace.RegisterFile(id3Path, project)
            workspace.RegisterFile(yotoPath, project)

            let initialCompilation = project.GetCompilation()
            Assert.Empty(initialCompilation.GetDiagnostics())

            let id3Uri = DocumentUri.FromFileSystemPath(id3Path)!!
            let yotoUri = DocumentUri.FromFileSystemPath(yotoPath)!!
            using let capabilities = JsonDocument.Parse("{\"textDocument\":{\"diagnostic\":{}}}")
            await server.InitializeAsync(InitializeParams{Capabilities: capabilities.RootElement.Clone()})

            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: id3Uri, Text: initialId3}}
            )
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: yotoUri, Text: initialYoto}}
            )

            await AssertId3HoversAsync(server, documents, id3Uri, initialId3)
            await AssertYotoHoversAsync(server, documents, yotoUri, initialYoto)

            Assert.True(project.TryGetSyntaxTree(id3Path, out var afterOpenId3Tree))
            Assert.True(project.TryGetSyntaxTree(yotoPath, out var afterOpenYotoTree))
            Assert.Same(diskId3Tree, afterOpenId3Tree)
            Assert.Same(diskYotoTree, afterOpenYotoTree)
            Assert.Same(initialCompilation, project.GetCompilation())
        } finally {
            server.Shutdown()
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    async func BodyOnlyDidChange_RepointsPrivateMethodsAndParameters_AndResolvesHovers() {
        let root = Path.Combine(Directory.GetCurrentDirectory(), "issue5904-edit-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        let documents = DocumentContentService()
        let workspace = WorkspaceState()
        let server = LspServer(documents, workspace)
        try {
            let id3Path = Path.Combine(root, "Id3Reader.gs")
            let yotoPath = Path.Combine(root, "YotoExceptions.gs")
            let initialId3 = Id3Source.Replace("%SHIFT%", "0")
            let initialYoto = YotoSource.Replace("%SHIFT%", "0")
            File.WriteAllText(id3Path, initialId3)
            File.WriteAllText(yotoPath, initialYoto)

            let project = workspace.AddProject(Path.Combine(root, "Waikiki.gsproj"))
            project.References = []string{typeof(object).Assembly.Location}
            project.UpdateFile(id3Path, initialId3)
            project.UpdateFile(yotoPath, initialYoto)
            workspace.RegisterFile(id3Path, project)
            workspace.RegisterFile(yotoPath, project)

            let initialCompilation = project.GetCompilation()
            let initialScope = initialCompilation.GlobalScope
            Assert.Empty(initialCompilation.GetDiagnostics())

            let id3Uri = DocumentUri.FromFileSystemPath(id3Path)!!
            let yotoUri = DocumentUri.FromFileSystemPath(yotoPath)!!
            using let capabilities = JsonDocument.Parse("{\"textDocument\":{\"diagnostic\":{}}}")
            await server.InitializeAsync(InitializeParams{Capabilities: capabilities.RootElement.Clone()})

            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: id3Uri, Text: initialId3}}
            )
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: yotoUri, Text: initialYoto}}
            )

            let editedId3 = Id3Source.Replace("%SHIFT%", "100\n            // shifted")
            await server.DidChangeAsync(
                DidChangeTextDocumentParams{
                    TextDocument: VersionedTextDocumentIdentifier{Uri: id3Uri, Version: 1},
                    ContentChanges: List[TextDocumentContentChangeEvent]{
                        TextDocumentContentChangeEvent{Text: editedId3}
                    }
                }
            )
            Assert.Same(initialScope, project.GetCompilation().GlobalScope)
            await AssertId3HoversAsync(server, documents, id3Uri, editedId3)

            let editedYoto = YotoSource.Replace("%SHIFT%", "200\n        // shifted")
            await server.DidChangeAsync(
                DidChangeTextDocumentParams{
                    TextDocument: VersionedTextDocumentIdentifier{Uri: yotoUri, Version: 1},
                    ContentChanges: List[TextDocumentContentChangeEvent]{
                        TextDocumentContentChangeEvent{Text: editedYoto}
                    }
                }
            )
            Assert.Same(initialScope, project.GetCompilation().GlobalScope)
            await AssertYotoHoversAsync(server, documents, yotoUri, editedYoto)
        } finally {
            server.Shutdown()
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        private const Id3Source string = `package Waikiki.Core.Music

class TrackInfo {
    var Title string?
}

class Id3Reader {
    private func ApplyInstance(info TrackInfo, label string) {
        let localLabel = label
        info.Title = localLabel
    }

    shared {
        private func ParseTag(header []uint8, tag []uint8, info TrackInfo) {
            let major = int32(header[0]) + %SHIFT%
            if major > 0 && tag.Length > 0 {
                info.Title = "TIT2"
            }
        }
    }
}
`

        private const YotoSource string = `package Waikiki.Yoto

import System

class YotoApiException : Exception {
    init(statusCode int32, body string) : base("Yoto API returned HTTP ${statusCode}: ${body}") {
        StatusCode = statusCode + %SHIFT%
        Body = body
    }

    prop StatusCode int32 {
        get;
        init;
    }

    prop Body string {
        get;
        init;
    }
}
`

        private async func AssertId3HoversAsync(
            server LspServer,
            documents DocumentContentService,
            uri DocumentUri,
            source string
        ) {
            for needle in[]string{"info.Title = localLabel", "info.Title = \"TIT2\""} {
                let hover = Assert.IsType[Hover](
                    await server.HoverAsync(
                        HoverParams{
                            TextDocument: TextDocumentIdentifier{Uri: uri},
                            Position: LanguageServerTestHelpers.PositionOf(source, needle)
                        }
                    )
                )
                Assert.Contains("(parameter) info TrackInfo", hover.Contents.ToString())
            }
            for titleNeedle in[]string{"Title = localLabel", "Title = \"TIT2\""} {
                let titleHover = Assert.IsType[Hover](
                    await server.HoverAsync(
                        HoverParams{
                            TextDocument: TextDocumentIdentifier{Uri: uri},
                            Position: LanguageServerTestHelpers.PositionOf(source, titleNeedle)
                        }
                    )
                )
                Assert.Contains("Title string?", titleHover.Contents.ToString())
            }
            for localNeedle in[]string{"localLabel", "major"} {
                let localHover = Assert.IsType[Hover](
                    await server.HoverAsync(
                        HoverParams{
                            TextDocument: TextDocumentIdentifier{Uri: uri},
                            Position: LanguageServerTestHelpers.PositionOf(source, localNeedle, 1)
                        }
                    )
                )
                Assert.Contains("(local variable) $localNeedle", localHover.Contents.ToString())
            }
            Assert.True(documents.TryGet(uri.ToString(), out var content))
            let compilation = content.Project!!.GetCompilation()
            let sharedAssignOffset = source.IndexOf("info.Title = \"TIT2\"", StringComparison.Ordinal)
            let infoToken = SemanticLookup.FindTokenAt(content.SyntaxTree, sharedAssignOffset)!!
            let resolvedInfo = Assert.IsType[ParameterSymbol](SemanticLookup.ResolveSymbol(compilation, infoToken))
            Assert.Equal("info", resolvedInfo.Name)
        }

        private async func AssertYotoHoversAsync(
            server LspServer,
            documents DocumentContentService,
            uri DocumentUri,
            source string
        ) {
            let statusHover = Assert.IsType[Hover](
                await server.HoverAsync(
                    HoverParams{
                        TextDocument: TextDocumentIdentifier{Uri: uri},
                        Position: LanguageServerTestHelpers.PositionOf(source, "statusCode", 1)
                    }
                )
            )
            Assert.Contains("(parameter) statusCode int32", statusHover.Contents.ToString())

            let bodyHover = Assert.IsType[Hover](
                await server.HoverAsync(
                    HoverParams{
                        TextDocument: TextDocumentIdentifier{Uri: uri},
                        Position: LanguageServerTestHelpers.PositionOf(source, "body", 1)
                    }
                )
            )
            Assert.Contains("(parameter) body string", bodyHover.Contents.ToString())

            Assert.True(documents.TryGet(uri.ToString(), out var content))
            let compilation = content.Project!!.GetCompilation()
            let holeOffset = source.IndexOf("$${statusCode}", StringComparison.Ordinal) + 2
            let statusToken = SemanticLookup.FindTokenAt(content.SyntaxTree, holeOffset)!!
            let resolvedStatus = Assert.IsType[ParameterSymbol](SemanticLookup.ResolveSymbol(compilation, statusToken))
            Assert.Equal("statusCode", resolvedStatus.Name)
        }
    }
}
