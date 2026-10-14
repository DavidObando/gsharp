// <copyright file="LspServerConcurrencyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.Linq
import System.Threading
import System.Threading.Tasks
import Xunit

/// Locks in the request-concurrency model (mirrors Roslyn's RequestExecutionQueue):
/// non-mutating ("read") requests capture an ordered snapshot under the intake gate and
/// then compute off the gate, so they run concurrently and honor cancellation. Previously
/// every handler held a single gate for its entire computation, serializing all language
/// services behind the slowest in-flight request (e.g. the first cold workspace bind),
/// which made the editor appear unresponsive.
open class LspServerConcurrencyTests {
    @Fact
    async func ReadHandlers_HonorAlreadyCancelledToken() {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        let uri = DocumentUri.From("file:///concurrency-cancel.gs")!!
        await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: Source}})
        let id = TextDocumentIdentifier{Uri: uri}
        let cancelled = CancellationToken(canceled: true)
        // A request whose token is already cancelled (e.g. a superseded hover that the
        // client cancelled via $/cancelRequest) must abort instead of computing to
        // completion and tying up a thread.
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return server.HoverAsync(HoverParams{TextDocument: id, Position: Position(2, 9)}, cancelled)
            }
        )
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return server.SemanticTokensFullAsync(SemanticTokensParams{TextDocument: id}, cancelled)
            }
        )
        await Assert.ThrowsAnyAsync[OperationCanceledException](
            func () Task {
                return server.DocumentSymbolAsync(DocumentSymbolParams{TextDocument: id}, cancelled)
            }
        )
    }

    @Fact
    async func ReadHandlers_RunConcurrently_WithoutDeadlock() {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        let uri = DocumentUri.From("file:///concurrency-parallel.gs")!!
        await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: Source}})
        let id = TextDocumentIdentifier{Uri: uri}
        // Fire a burst of independent read requests at once. With the old single-gate
        // model these serialized; they must now all complete (the property under test is
        // simply that concurrent reads neither deadlock nor corrupt shared state).
        let reads = Enumerable.Range(0, 32).Select(
            (_ int32) -> Task.Run(
                async () -> {
                    await server.DocumentSymbolAsync(DocumentSymbolParams{TextDocument: id})
                    await server.FoldingRangeAsync(FoldingRangeParams{TextDocument: id})
                    await server.SemanticTokensFullAsync(SemanticTokensParams{TextDocument: id})
                    await server.HoverAsync(HoverParams{TextDocument: id, Position: Position(2, 9)})
                }
            )
        )
        await Task.WhenAll(reads)
    }

    shared {
        private const Source string = `package Demo

func Add(a int32, b int32) int32 {
    return a + b
}
`
    }
}
