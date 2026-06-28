// <copyright file="LspServerConcurrencyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Locks in the request-concurrency model (mirrors Roslyn's RequestExecutionQueue):
/// non-mutating ("read") requests capture an ordered snapshot under the intake gate and
/// then compute off the gate, so they run concurrently and honor cancellation. Previously
/// every handler held a single gate for its entire computation, serializing all language
/// services behind the slowest in-flight request (e.g. the first cold workspace bind),
/// which made the editor appear unresponsive.
/// </summary>
public class LspServerConcurrencyTests
{
    private const string Source = @"package Demo

func Add(a int32, b int32) int32 {
    return a + b
}
";

    [Fact]
    public async Task ReadHandlers_HonorAlreadyCancelledToken()
    {
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());
        var uri = DocumentUri.From("file:///concurrency-cancel.gs");
        await server.DidOpenAsync(new DidOpenTextDocumentParams
        {
            TextDocument = new TextDocumentItem { Uri = uri, Text = Source },
        });

        var id = new TextDocumentIdentifier { Uri = uri };
        var cancelled = new CancellationToken(canceled: true);

        // A request whose token is already cancelled (e.g. a superseded hover that the
        // client cancelled via $/cancelRequest) must abort instead of computing to
        // completion and tying up a thread.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => server.HoverAsync(new HoverParams { TextDocument = id, Position = new(2, 9) }, cancelled));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => server.SemanticTokensFullAsync(new SemanticTokensParams { TextDocument = id }, cancelled));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => server.DocumentSymbolAsync(new DocumentSymbolParams { TextDocument = id }, cancelled));
    }

    [Fact]
    public async Task ReadHandlers_RunConcurrently_WithoutDeadlock()
    {
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());
        var uri = DocumentUri.From("file:///concurrency-parallel.gs");
        await server.DidOpenAsync(new DidOpenTextDocumentParams
        {
            TextDocument = new TextDocumentItem { Uri = uri, Text = Source },
        });

        var id = new TextDocumentIdentifier { Uri = uri };

        // Fire a burst of independent read requests at once. With the old single-gate
        // model these serialized; they must now all complete (the property under test is
        // simply that concurrent reads neither deadlock nor corrupt shared state).
        var reads = Enumerable.Range(0, 32).Select(_ => Task.Run(async () =>
        {
            await server.DocumentSymbolAsync(new DocumentSymbolParams { TextDocument = id });
            await server.FoldingRangeAsync(new FoldingRangeParams { TextDocument = id });
            await server.SemanticTokensFullAsync(new SemanticTokensParams { TextDocument = id });
            await server.HoverAsync(new HoverParams { TextDocument = id, Position = new(2, 9) });
        }));

        await Task.WhenAll(reads);
    }
}
