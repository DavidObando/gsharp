// <copyright file="Issue1664PushDiagnosticsOffGateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Issue #1664: for push-diagnostics clients (no textDocument/diagnostic pull support —
/// vim/neovim/emacs/older editors), didOpen/didChange/didSave used to (1) parse the same text
/// twice (once in <c>UpdateDocument</c>, once again in the old push-publish path) and (2) run the
/// full binding pass + <c>DocumentationValidator</c> inline, under the single write
/// <c>gate</c> every other request must acquire — freezing the whole server for the duration of
/// a full project bind on every synchronization event. These tests lock in the fix: the parse
/// result is reused (no second parse), the full bind runs off the gate on the thread pool, a newer edit
/// supersedes (and its publish is dropped for) any still-running older bind, and push clients
/// still receive correct, full diagnostics once the bind completes.
///
/// None of these tests attach a real JsonRpc transport (server.rpc stays null, matching every
/// other test in this suite), so they use the internal Test* hooks on <see cref="LspServer"/> —
/// invoked at exactly the points production code would otherwise call into JsonRpc — to observe
/// diagnostics and control bind timing deterministically, without sleeps.
/// </summary>
public class Issue1664PushDiagnosticsOffGateTests
{
    private const string BindingErrorSource = "func F() int32 {\n}\n";

    [Fact]
    public async Task DidSave_ReusesParsedTree_DoesNotReparseForOffGateBind()
    {
        // A standalone file (no .gsproj) takes the most literal double-parse path: without a
        // project, ComputeDiagnostics always does `SyntaxTree.Parse(text)` fresh, with no
        // ProjectState-level cache. If the off-gate bind reparsed instead of reusing
        // UpdateDocument's tree, the two captured SyntaxTree instances below would differ.
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());
        var uri = DocumentUri.From("file:///reparse-check.gs");

        SyntaxTree parsedTree = null;
        SyntaxTree boundTree = null;
        server.TestOnParseResult = (_, result) => parsedTree = result.Content.SyntaxTree;
        server.TestOnBindResult = (_, result) => boundTree = result.Content.SyntaxTree;

        await server.DidSaveAsync(new DidSaveTextDocumentParams
        {
            TextDocument = new TextDocumentIdentifier { Uri = uri },
            Text = BindingErrorSource,
        });

        await WaitForAsync(() => boundTree != null);

        Assert.NotNull(parsedTree);
        Assert.Same(parsedTree, boundTree);
    }

    [Fact]
    public async Task OpenChangeAndSave_PushMode_PublishFullBindingDiagnostics()
    {
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());
        var uri = DocumentUri.From("file:///offgate-correctness.gs");

        IReadOnlyList<Diagnostic> published = null;
        server.TestOnPublish = (_, diagnostics) => published = diagnostics;

        await server.DidOpenAsync(new DidOpenTextDocumentParams
        {
            TextDocument = new TextDocumentItem { Uri = uri, Text = BindingErrorSource },
        });
        await WaitForAsync(() => HasBindingError(published));

        published = null;
        await server.DidChangeAsync(new DidChangeTextDocumentParams
        {
            TextDocument = new VersionedTextDocumentIdentifier { Uri = uri },
            ContentChanges = new List<TextDocumentContentChangeEvent>
            {
                new TextDocumentContentChangeEvent { Text = BindingErrorSource },
            },
        });
        await WaitForAsync(() => HasBindingError(published));

        published = null;
        await server.DidSaveAsync(new DidSaveTextDocumentParams
        {
            TextDocument = new TextDocumentIdentifier { Uri = uri },
            Text = BindingErrorSource,
        });
        await WaitForAsync(() => HasBindingError(published));
    }

    [Fact]
    public async Task DidSave_FullBindRunsOffGate_ConcurrentGatedRequestIsNotBlocked()
    {
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());
        var uri = DocumentUri.From("file:///gate-free-check.gs");

        // Stall the bind indefinitely (until released below) to simulate the ~17s cold
        // full-project bind the issue describes. If it still ran under GuardAsync's gate,
        // DidSaveAsync itself would not return until released, and the concurrent didChange
        // below would hang waiting for the same gate.
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        server.TestPushBindDelay = async ct =>
        {
            using var registration = ct.Register(() => release.TrySetCanceled(ct));
#pragma warning disable VSTHRD003 // test-only: awaiting a TaskCompletionSource signaled by the test body, not started here.
            await release.Task.ConfigureAwait(false);
#pragma warning restore VSTHRD003
        };

        await server.DidOpenAsync(new DidOpenTextDocumentParams
        {
            TextDocument = new TextDocumentItem { Uri = uri, Text = BindingErrorSource },
        });

        var saveTask = server.DidSaveAsync(new DidSaveTextDocumentParams
        {
            TextDocument = new TextDocumentIdentifier { Uri = uri },
            Text = BindingErrorSource,
        });

        // DidSaveAsync's GuardAsync body only parses and schedules the bind; it must complete
        // promptly even though the bind it scheduled is stalled indefinitely.
        var completed = await Task.WhenAny(saveTask, Task.Delay(TimeSpan.FromSeconds(5)));
        Assert.Same(saveTask, completed);

        // With the gate held for the whole bind (the bug), this would hang until `release`
        // completes. With the fix, the gate was already released, so this proceeds immediately.
        var changeTask = server.DidChangeAsync(new DidChangeTextDocumentParams
        {
            TextDocument = new VersionedTextDocumentIdentifier { Uri = uri },
            ContentChanges = new List<TextDocumentContentChangeEvent> { new TextDocumentContentChangeEvent { Text = BindingErrorSource } },
        });
        var changeCompleted = await Task.WhenAny(changeTask, Task.Delay(TimeSpan.FromSeconds(5)));
        Assert.Same(changeTask, changeCompleted);

        release.TrySetResult(true);
    }

    [Fact]
    public async Task NewerEdit_SupersedesOlderInFlightBind_NoStaleDiagnosticsClobber()
    {
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());
        var uri = DocumentUri.From("file:///supersede-check.gs");

        const string firstText = "func F() int32 {\n}\n"; // binding error: missing return
        const string secondText = "func F() int32 {\n  return 1\n}\n"; // no binding error

        var firstBindGate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstBindStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var publishes = new List<(string Uri, IReadOnlyList<Diagnostic> Diagnostics)>();
        var delayCallCount = 0;
        var initialBindCompleted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        server.TestOnBindResult = (_, _) => initialBindCompleted.TrySetResult(true);

        await server.DidOpenAsync(new DidOpenTextDocumentParams
        {
            TextDocument = new TextDocumentItem { Uri = uri, Text = secondText },
        });
        await initialBindCompleted.Task;
        server.TestOnBindResult = null;

        server.TestPushBindDelay = async ct =>
        {
            var call = Interlocked.Increment(ref delayCallCount);
            if (call == 1)
            {
                // Stall the FIRST bind (for firstText) until the second edit has had a chance to
                // supersede it.
                firstBindStarted.TrySetResult(true);
                using var registration = ct.Register(() => firstBindGate.TrySetCanceled(ct));
#pragma warning disable VSTHRD003 // test-only: awaiting a TaskCompletionSource signaled by the test body, not started here.
                await firstBindGate.Task.ConfigureAwait(false);
#pragma warning restore VSTHRD003
            }

            // The second bind (for secondText) proceeds immediately, no stall.
        };
        server.TestOnPublish = (u, diagnostics) =>
        {
            lock (publishes)
            {
                publishes.Add((u.ToString(), diagnostics));
            }
        };

        await server.DidChangeAsync(new DidChangeTextDocumentParams
        {
            TextDocument = new VersionedTextDocumentIdentifier { Uri = uri },
            ContentChanges = new List<TextDocumentContentChangeEvent>
            {
                new TextDocumentContentChangeEvent { Text = firstText },
            },
        });
        await firstBindStarted.Task;

        // Supersede: a newer edit for the same file while the first bind is still stalled.
        // This must cancel the first bind's token so its (stale) diagnostics for firstText are
        // never published, even though it "completes" (via cancellation) after the second.
        await server.DidChangeAsync(new DidChangeTextDocumentParams
        {
            TextDocument = new VersionedTextDocumentIdentifier { Uri = uri },
            ContentChanges = new List<TextDocumentContentChangeEvent>
            {
                new TextDocumentContentChangeEvent { Text = secondText },
            },
        });

        await WaitForAsync(() =>
        {
            lock (publishes)
            {
                return publishes.Any(p => p.Uri == uri.ToString()
                    && !p.Diagnostics.Any(d => d.Message.Contains("Not all code paths", StringComparison.Ordinal)));
            }
        });

        // Let the stalled first bind observe cancellation and (if it ever reaches the publish
        // check) attempt to publish; it must not, because its token was cancelled.
        firstBindGate.TrySetResult(true);
        await Task.Delay(200);

        lock (publishes)
        {
            var forThisFile = publishes.Where(p => p.Uri == uri.ToString()).ToList();
            Assert.DoesNotContain(
                forThisFile,
                p => p.Diagnostics.Any(d => d.Message.Contains("Not all code paths", StringComparison.Ordinal)));
        }
    }

    [Fact]
    public async Task DidChange_PushMode_RefreshesOtherOpenProjectDocuments()
    {
        var root = Path.Combine(Path.GetTempPath(), "gsharp-push-refresh-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(
                Path.Combine(root, "Demo.gsproj"),
                "<Project Sdk=\"Gsharp.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>");
            var firstPath = Path.Combine(root, "First.gs");
            var secondPath = Path.Combine(root, "Second.gs");
            File.WriteAllText(firstPath, "func First() { }\n");
            File.WriteAllText(secondPath, "func Second() { }\n");

            var workspace = new WorkspaceState();
            WorkspaceInitializer.Initialize(workspace, root);
            var server = new LspServer(new DocumentContentService(), workspace);
            var firstUri = DocumentUri.From(firstPath);
            var secondUri = DocumentUri.From(secondPath);
            var boundUris = new List<string>();
            server.TestOnBindResult = (uri, _) =>
            {
                lock (boundUris)
                {
                    boundUris.Add(uri.ToString());
                }
            };

            await server.DidOpenAsync(new DidOpenTextDocumentParams
            {
                TextDocument = new TextDocumentItem { Uri = firstUri, Text = File.ReadAllText(firstPath) },
            });
            await server.DidOpenAsync(new DidOpenTextDocumentParams
            {
                TextDocument = new TextDocumentItem { Uri = secondUri, Text = File.ReadAllText(secondPath) },
            });
            await WaitForAsync(() => ContainsBoth(boundUris, firstUri, secondUri));
            lock (boundUris)
            {
                boundUris.Clear();
            }

            await server.DidChangeAsync(new DidChangeTextDocumentParams
            {
                TextDocument = new VersionedTextDocumentIdentifier { Uri = firstUri },
                ContentChanges = new List<TextDocumentContentChangeEvent>
                {
                    new TextDocumentContentChangeEvent { Text = "func First() { var x = 1 }\n" },
                },
            });

            await WaitForAsync(() => ContainsBoth(boundUris, firstUri, secondUri));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static bool HasBindingError(IReadOnlyList<Diagnostic> diagnostics)
        => diagnostics?.Any(d => d.Message.Contains("Not all code paths", StringComparison.Ordinal)) == true;

    private static bool ContainsBoth(List<string> uris, DocumentUri first, DocumentUri second)
    {
        lock (uris)
        {
            return uris.Contains(first.ToString()) && uris.Contains(second.ToString());
        }
    }

    private static async Task WaitForAsync(Func<bool> condition, int timeoutMs = 10000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
            {
                Assert.Fail("Timed out waiting for the condition to become true.");
            }

            await Task.Delay(25);
        }
    }
}
