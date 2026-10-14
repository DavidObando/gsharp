// <copyright file="Issue1664PushDiagnosticsOffGateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Syntax
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

/// Issue #1664: for push-diagnostics clients (no textDocument/diagnostic pull support —
/// vim/neovim/emacs/older editors), didOpen/didChange/didSave used to (1) parse the same text
/// twice (once in `UpdateDocument`, once again in the old push-publish path) and (2) run the
/// full binding pass + `DocumentationValidator` inline, under the single write
/// `gate` every other request must acquire — freezing the whole server for the duration of
/// a full project bind on every synchronization event. These tests lock in the fix: the parse
/// result is reused (no second parse), the full bind runs off the gate on the thread pool, a newer edit
/// supersedes (and its publish is dropped for) any still-running older bind, and push clients
/// still receive correct, full diagnostics once the bind completes.
///
/// None of these tests attach a real JsonRpc transport (server.rpc stays null, matching every
/// other test in this suite), so they use the internal Test* hooks on (cref:LspServer) —
/// invoked at exactly the points production code would otherwise call into JsonRpc — to observe
/// diagnostics and control bind timing deterministically, without sleeps.
open class Issue1664PushDiagnosticsOffGateTests {
    @Fact
    async func DidSave_ReusesParsedTree_DoesNotReparseForOffGateBind() {
        // A standalone file (no .gsproj) takes the most literal double-parse path: without a
        // project, ComputeDiagnostics always does `SyntaxTree.Parse(text)` fresh, with no
        // ProjectState-level cache. If the off-gate bind reparsed instead of reusing
        // UpdateDocument's tree, the two captured SyntaxTree instances below would differ.
        let server = LspServer(DocumentContentService(), WorkspaceState())
        let uri = DocumentUri.From("file:///reparse-check.gs")!!
        var parsedTree SyntaxTree? = nil
        var boundTree SyntaxTree? = nil
        server.TestOnParseResult = (_ DocumentUri, result DiagnosticComputationResult) -> {
            parsedTree = result.Content.SyntaxTree
        }
        server.TestOnBindResult = (_ DocumentUri, result DiagnosticComputationResult) -> {
            boundTree = result.Content.SyntaxTree
        }
        await server.DidSaveAsync(
            DidSaveTextDocumentParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Text: BindingErrorSource}
        )
        await WaitForAsync(() -> boundTree != nil)
        Assert.NotNull(parsedTree)
        Assert.Same(parsedTree, boundTree)
    }

    @Fact
    async func OpenChangeAndSave_PushMode_PublishFullBindingDiagnostics() {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        let uri = DocumentUri.From("file:///offgate-correctness.gs")!!
        var published IReadOnlyList[Diagnostic]? = nil
        server.TestOnPublish = (_ DocumentUri, diagnostics IReadOnlyList[Diagnostic]) -> {
            published = diagnostics
        }
        await server.DidOpenAsync(
            DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: BindingErrorSource}}
        )
        await WaitForAsync(() -> HasBindingError(published))
        published = nil
        await server.DidChangeAsync(
            DidChangeTextDocumentParams{
                TextDocument: VersionedTextDocumentIdentifier{Uri: uri},
                ContentChanges: List[TextDocumentContentChangeEvent]{
                    TextDocumentContentChangeEvent{Text: BindingErrorSource}
                }
            }
        )
        await WaitForAsync(() -> HasBindingError(published))
        published = nil
        await server.DidSaveAsync(
            DidSaveTextDocumentParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Text: BindingErrorSource}
        )
        await WaitForAsync(() -> HasBindingError(published))
    }

    @Fact
    async func DidSave_FullBindRunsOffGate_ConcurrentGatedRequestIsNotBlocked() {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        let uri = DocumentUri.From("file:///gate-free-check.gs")!!
        // Stall the bind indefinitely (until released below) to simulate the ~17s cold
        // full-project bind the issue describes. If it still ran under GuardAsync's gate,
        // DidSaveAsync itself would not return until released, and the concurrent didChange
        // below would hang waiting for the same gate.
        let release = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        server.TestPushBindDelay = async (ct CancellationToken) -> {
            using let registration = ct.Register(() -> release.TrySetCanceled(ct))
            await release.Task.ConfigureAwait(false)
        }
        await server.DidOpenAsync(
            DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: BindingErrorSource}}
        )
        let saveTask = server.DidSaveAsync(
            DidSaveTextDocumentParams{TextDocument: TextDocumentIdentifier{Uri: uri}, Text: BindingErrorSource}
        )
        // DidSaveAsync's GuardAsync body only parses and schedules the bind; it must complete
        // promptly even though the bind it scheduled is stalled indefinitely.
        let completed = await Task.WhenAny(saveTask, Task.Delay(TimeSpan.FromSeconds(5)))
        Assert.Same(saveTask, completed)
        // With the gate held for the whole bind (the bug), this would hang until `release`
        // completes. With the fix, the gate was already released, so this proceeds immediately.
        let changeTask = server.DidChangeAsync(
            DidChangeTextDocumentParams{
                TextDocument: VersionedTextDocumentIdentifier{Uri: uri},
                ContentChanges: List[TextDocumentContentChangeEvent]{
                    TextDocumentContentChangeEvent{Text: BindingErrorSource}
                }
            }
        )
        let changeCompleted = await Task.WhenAny(changeTask, Task.Delay(TimeSpan.FromSeconds(5)))
        Assert.Same(changeTask, changeCompleted)
        release.TrySetResult(true)
    }

    @Fact
    async func NewerEdit_SupersedesOlderInFlightBind_NoStaleDiagnosticsClobber() {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        let uri = DocumentUri.From("file:///supersede-check.gs")!!
        const firstText = `func F() int32 {
}
` // binding error: missing return
        const secondText = `func F() int32 {
  return 1
}
` // no binding error
        let firstBindGate = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        let firstBindStarted = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        let publishes = List[(Uri string, Diagnostics IReadOnlyList[Diagnostic])]()
        var delayCallCount = 0
        let initialBindCompleted = TaskCompletionSource[bool](TaskCreationOptions.RunContinuationsAsynchronously)
        server.TestOnBindResult = (_ DocumentUri, _ DiagnosticComputationResult) -> initialBindCompleted.TrySetResult(
            true
        )
        await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: secondText}})
        await initialBindCompleted.Task
        server.TestOnBindResult = nil
        server.TestPushBindDelay = async (ct CancellationToken) -> {
            let call = Interlocked.Increment(&delayCallCount)
            if call == 1 {
                // Stall the FIRST bind (for firstText) until the second edit has had a chance to
                // supersede it.
                firstBindStarted.TrySetResult(true)
                using let registration = ct.Register(() -> firstBindGate.TrySetCanceled(ct))
                await firstBindGate.Task.ConfigureAwait(false)
            }
            // The second bind (for secondText) proceeds immediately, no stall.

        }
        server.TestOnPublish = (u DocumentUri, diagnostics IReadOnlyList[Diagnostic]) -> {
            lock publishes {
                publishes.Add((u.ToString(), diagnostics))
            }
        }
        await server.DidChangeAsync(
            DidChangeTextDocumentParams{
                TextDocument: VersionedTextDocumentIdentifier{Uri: uri},
                ContentChanges: List[TextDocumentContentChangeEvent]{TextDocumentContentChangeEvent{Text: firstText}}
            }
        )
        await firstBindStarted.Task
        // Supersede: a newer edit for the same file while the first bind is still stalled.
        // This must cancel the first bind's token so its (stale) diagnostics for firstText are
        // never published, even though it "completes" (via cancellation) after the second.
        await server.DidChangeAsync(
            DidChangeTextDocumentParams{
                TextDocument: VersionedTextDocumentIdentifier{Uri: uri},
                ContentChanges: List[TextDocumentContentChangeEvent]{TextDocumentContentChangeEvent{Text: secondText}}
            }
        )
        await WaitForAsync(
            () -> {
                lock publishes {
                    return publishes.Any(
                        (p(Uri string, Diagnostics IReadOnlyList[Diagnostic])) -> p.Uri == uri.ToString() &&
                            !p
                            .Diagnostics
                            .Any((d Diagnostic) -> d.Message.Contains("Not all code paths", StringComparison.Ordinal))
                    )
                }
            }
        )
        // Let the stalled first bind observe cancellation and (if it ever reaches the publish
        // check) attempt to publish; it must not, because its token was cancelled.
        firstBindGate.TrySetResult(true)
        await Task.Delay(200)
        lock publishes {
            let forThisFile = publishes.Where(
                (p(Uri string, Diagnostics IReadOnlyList[Diagnostic])) -> p.Uri == uri.ToString()
            )
                .ToList()
            Assert.DoesNotContain(
                forThisFile,
                (p(Uri string, Diagnostics IReadOnlyList[Diagnostic])) -> p.Diagnostics.Any(
                    (d Diagnostic) -> d.Message.Contains("Not all code paths", StringComparison.Ordinal)
                )
            )
        }
    }

    @Fact
    async func DidChange_PushMode_RefreshesOtherOpenProjectDocuments() {
        let root = Path.Combine(Path.GetTempPath(), "gsharp-push-refresh-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            File.WriteAllText(
                Path.Combine(root, "Demo.gsproj"),
                "<Project Sdk=\"Gsharp.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
            )
            let firstPath = Path.Combine(root, "First.gs")
            let secondPath = Path.Combine(root, "Second.gs")
            File.WriteAllText(firstPath, "func First() { }\n")
            File.WriteAllText(secondPath, "func Second() { }\n")
            let workspace = WorkspaceState()
            WorkspaceInitializer.Initialize(workspace, root)
            let server = LspServer(DocumentContentService(), workspace)
            let firstUri = DocumentUri.From(firstPath)!!
            let secondUri = DocumentUri.From(secondPath)!!
            let boundUris = List[string]()
            server.TestOnBindResult = (uri DocumentUri, _ DiagnosticComputationResult) -> {
                lock boundUris {
                    boundUris.Add(uri.ToString())
                }
            }
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{
                    TextDocument: TextDocumentItem{Uri: firstUri, Text: File.ReadAllText(firstPath)}
                }
            )
            await server.DidOpenAsync(
                DidOpenTextDocumentParams{
                    TextDocument: TextDocumentItem{Uri: secondUri, Text: File.ReadAllText(secondPath)}
                }
            )
            await WaitForAsync(() -> ContainsBoth(boundUris, firstUri, secondUri))
            lock boundUris {
                boundUris.Clear()
            }
            await server.DidChangeAsync(
                DidChangeTextDocumentParams{
                    TextDocument: VersionedTextDocumentIdentifier{Uri: firstUri},
                    ContentChanges: List[TextDocumentContentChangeEvent]{
                        TextDocumentContentChangeEvent{Text: "func First() { var x = 1 }\n"}
                    }
                }
            )
            await WaitForAsync(() -> ContainsBoth(boundUris, firstUri, secondUri))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        private const BindingErrorSource string = `func F() int32 {
}
`

        private func HasBindingError(diagnostics IReadOnlyList[Diagnostic]?) bool -> diagnostics?.Any(
            (d Diagnostic) -> d.Message.Contains("Not all code paths", StringComparison.Ordinal)
        ) == true

        private func ContainsBoth(uris List[string], first DocumentUri, second DocumentUri) bool {
            lock uris {
                return uris.Contains(first.ToString()) && uris.Contains(second.ToString())
            }
        }

        private async func WaitForAsync(condition() -> bool, timeoutMs int32 = 10000) {
            let deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs)
            while !condition() {
                if DateTime.UtcNow > deadline {
                    Assert.Fail("Timed out waiting for the condition to become true.")
                }
                await Task.Delay(25)
            }
        }
    }
}
