// <copyright file="WorkspaceDiscoveryDiagnosticRefreshTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Background workspace discovery (kicked off in "initialized") races the editor's didOpen:
/// on a cold start the client opens visible files before discovery has registered any project,
/// so a pull-diagnostics client (e.g. VS Code) that pulls diagnostics during the race gets a
/// file bound against a project-less compilation — with none of the project's references or
/// sibling source files. Every imported symbol then reported "could not be found" (e.g. GS0198
/// on xunit's <c>@Fact</c>, or a sibling type/function in the same project), and the squiggles
/// persisted because nothing re-pulled the file once discovery finished — the user had to edit
/// the file to trigger a refresh.
///
/// This test locks in the fix: once background discovery completes, the server asks the client
/// to refresh diagnostics, and the resulting re-pull binds each open file against its
/// now-discovered project, clearing the spurious diagnostics.
/// </summary>
public class WorkspaceDiscoveryDiagnosticRefreshTests
{
    // Foo references a type + method defined in a sibling file (Bar.gs) of the SAME project.
    // Bound alone (project-less) both are unresolved; bound with the project they resolve.
    private const string BarSource = "class Bar {\n  func hello() int -> 42\n}\n";
    private const string FooSource = "class Foo {\n  func run() int -> Bar().hello()\n}\n";

    [Fact]
    public async Task PullClient_DiscoveryAfterOpen_RequestsRefreshAndSubsequentPullIsClean()
    {
        var rootDir = CreateSampleWorkspace();
        try
        {
            var workspace = new WorkspaceState();
            var server = new LspServer(new DocumentContentService(), workspace);
            var fooPath = Path.Combine(rootDir, "Demo", "Foo.gs");
            var uri = DocumentUri.FromFileSystemPath(fooPath);

            var refreshRequested = false;
            server.TestOnDiagnosticRefreshAfterDiscovery = () => refreshRequested = true;

            await server.InitializeAsync(new InitializeParams { RootPath = rootDir, Capabilities = PullClientCapabilities() });

            await server.DidOpenAsync(new DidOpenTextDocumentParams
            {
                TextDocument = new TextDocumentItem { Uri = uri, Text = FooSource },
            });

            // A pull that lands before background discovery registers the project binds the file
            // project-less: the sibling symbols in Bar.gs are invisible and reported missing.
            var beforeDiscovery = await PullDiagnosticsAsync(server, uri);
            Assert.Null(workspace.GetProjectForFile(fooPath));
            Assert.NotEmpty(beforeDiscovery);

            // Discovery runs in the background; when it completes the server asks the client to
            // refresh (re-pull) diagnostics for its open documents.
            using var doc = JsonDocument.Parse("{}");
            server.Initialized(doc.RootElement.Clone());

            await WaitForAsync(() => refreshRequested && workspace.GetProjectForFile(fooPath) != null);

            // The refresh-driven re-pull now binds Foo.gs against its project (both source files),
            // so the sibling symbols resolve and the spurious diagnostics are gone.
            var afterDiscovery = await PullDiagnosticsAsync(server, uri);
            Assert.Empty(afterDiscovery);
        }
        finally
        {
            Directory.Delete(rootDir, recursive: true);
        }
    }

    private static JsonElement PullClientCapabilities()
    {
        // Advertise textDocument/diagnostic (pull) and workspace diagnostic refreshSupport so the
        // server treats this as a pull client that can be asked to re-pull.
        var doc = JsonDocument.Parse(
            "{\"textDocument\":{\"diagnostic\":{}},\"workspace\":{\"diagnostics\":{\"refreshSupport\":true}}}");
        return doc.RootElement.Clone();
    }

    private static async Task<IReadOnlyList<Diagnostic>> PullDiagnosticsAsync(LspServer server, DocumentUri uri)
    {
        var report = await server.DocumentDiagnosticAsync(
            new DocumentDiagnosticParams { TextDocument = new TextDocumentIdentifier { Uri = uri } },
            CancellationToken.None);
        return report is FullDocumentDiagnosticReport full ? full.Items : Array.Empty<Diagnostic>();
    }

    private static string CreateSampleWorkspace()
    {
        var rootDir = Path.Combine(Path.GetTempPath(), "gsrefresh_" + Guid.NewGuid().ToString("N"));
        var projDir = Path.Combine(rootDir, "Demo");
        Directory.CreateDirectory(projDir);

        File.WriteAllText(
            Path.Combine(projDir, "Demo.gsproj"),
            "<Project Sdk=\"Gsharp.NET.Sdk\">\n  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>\n</Project>\n");

        File.WriteAllText(Path.Combine(projDir, "Bar.gs"), BarSource);
        File.WriteAllText(Path.Combine(projDir, "Foo.gs"), FooSource);

        return rootDir;
    }

    private static async Task WaitForAsync(Func<bool> condition, int timeoutMs = 10000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
            {
                Assert.Fail("Timed out waiting for post-discovery diagnostic refresh.");
            }

            await Task.Delay(25);
        }
    }
}
