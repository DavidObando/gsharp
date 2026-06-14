// <copyright file="Issue816HandlerExceptionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Issue #816: opening a real-world file in the bundled extension surfaced a
/// "Object reference not set to an instance of an object" popup for every
/// pull-based LSP request (diagnostic, inlayHint, codeLens, semanticTokens).
/// The handlers must degrade to "no result" on internal exceptions rather
/// than propagating the failure to the client.
///
/// The repro source uses pre-ADR-0078 syntax (<c>type Name class : I</c>)
/// the way users hit it in the wild — i.e. a file whose grammar is partly
/// understood by the LS. The contract under test is "no exception escapes";
/// the actual content of the returned report/list is best-effort.
/// </summary>
public class Issue816HandlerExceptionTests
{
    private const string PreAdr0078Source = @"
package Oahu.Cli.Tests.Experiment.Tui

import System
import System.Collections.Generic
import System.Threading.Tasks
import Xunit

type AppShellTests class : IDisposable {
    init() { Theme.Reset() }
    func Dispose() { Theme.Reset() }

    func MakeConsole() IAnsiConsole {
        return AnsiConsole.Create(AnsiConsoleSettings())
    }

    func NewShell() AppShell {
        return AppShell(MakeConsole(), AppShellOptions())
    }

    func NewShellWithBuffer(buf LogRingBuffer) AppShell {
        return AppShell(MakeConsole(), AppShellOptions() { LogBuffer = buf })
    }

    func NewShellWithTabs(tabs List[ITabScreen]) AppShell {
        let roTabs IReadOnlyList[ITabScreen] = tabs
        return AppShell(MakeConsole(), AppShellOptions() { Tabs = roTabs })
    }

    func K(ch char, key ConsoleKey, shift bool, alt bool, ctrl bool) ConsoleKeyInfo {
        return ConsoleKeyInfo(ch, key, shift, alt, ctrl)
    }

    @Fact
    func Number_Keys_Switch_Tabs() {
        var shell = NewShell()
        Assert.Equal(0, shell.ActiveTab)
        shell.Dispatch(K('3', ConsoleKey.D3, false, false, false))
        Assert.Equal(2, shell.ActiveTab)
    }
}

type ScreenImpl class : ITabScreen {
    TabTitle string = ""Test""
    TabNumberKey char = '1'
    Capturing bool = false

    prop Title string { get { return TabTitle } }
    prop NumberKey char { get { return TabNumberKey } }
    prop Hints IEnumerable[KeyValuePair[string, string?]] {
        get {
            var list = List[KeyValuePair[string, string?]]()
            return list
        }
    }

    func HandleKey(key ConsoleKeyInfo) bool {
        return Capturing
    }
}
";

    [Fact]
    public async Task AllPullHandlers_DegradeGracefully_OnPartiallyValidSource()
    {
        // Mirror the user-reported layout (project plus an under-edit .gs file). The
        // project intentionally references siblings that do not exist on disk; the LS
        // must not crash when discovery turns up cross-references it can't follow.
        var rootDir = Path.Combine(Path.GetTempPath(), "gsrepro816_" + Guid.NewGuid().ToString("N"));
        var projDir = Path.Combine(rootDir, "tests", "Oahu.Cli.Tests.Experiment");
        var tuiDir = Path.Combine(projDir, "Tui");
        Directory.CreateDirectory(tuiDir);
        try
        {
            File.WriteAllText(
                Path.Combine(projDir, "Oahu.Cli.Tests.Experiment.gsproj"),
                "<Project Sdk=\"Gsharp.NET.Sdk\">\n"
                + "  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Oahu.Cli.Tests.Experiment</AssemblyName></PropertyGroup>\n"
                + "  <ItemGroup>\n"
                + "    <ProjectReference Include=\"..\\..\\src\\Oahu.Cli\\Oahu.Cli.csproj\" />\n"
                + "    <ProjectReference Include=\"..\\..\\src\\Oahu.Cli.App.Experiment\\Oahu.Cli.App.Experiment.gsproj\" />\n"
                + "  </ItemGroup>\n"
                + "</Project>\n");
            var gsPath = Path.Combine(tuiDir, "AppShellTests.gs");
            File.WriteAllText(gsPath, PreAdr0078Source);

            var workspace = new WorkspaceState();
            WorkspaceInitializer.Initialize(workspace, rootDir);

            var server = new LspServer(new DocumentContentService(), workspace);
            var uri = DocumentUri.FromFileSystemPath(gsPath);

            await server.DidOpenAsync(new DidOpenTextDocumentParams
            {
                TextDocument = new TextDocumentItem { Uri = uri, Text = PreAdr0078Source },
            });

            var id = new TextDocumentIdentifier { Uri = uri };

            // Each call must complete without throwing. The contract is "no exception
            // escapes"; the returned values are best-effort.
            var diagnostic = await server.DocumentDiagnosticAsync(
                new DocumentDiagnosticParams { TextDocument = id },
                CancellationToken.None);
            Assert.NotNull(diagnostic);

            _ = await server.InlayHintAsync(new InlayHintParams { TextDocument = id });
            _ = await server.CodeLensAsync(new CodeLensParams { TextDocument = id });
            _ = await server.SemanticTokensFullAsync(new SemanticTokensParams { TextDocument = id });
            _ = await server.SemanticTokensRangeAsync(new SemanticTokensRangeParams { TextDocument = id });
            _ = await server.HoverAsync(new HoverParams { TextDocument = id, Position = new Position(0, 0) });
            _ = await server.DocumentSymbolAsync(new DocumentSymbolParams { TextDocument = id });
            _ = await server.FoldingRangeAsync(new FoldingRangeParams { TextDocument = id });
            _ = await server.CompletionAsync(new CompletionParams { TextDocument = id, Position = new Position(0, 0) });
        }
        finally
        {
            try { Directory.Delete(rootDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task GuardAsync_SwallowsHandlerException_ReturnsDefault()
    {
        // Direct contract test for the defensive try/catch added in LspServer.GuardAsync.
        // The throwing-content service forces a handler body to NRE on the very first
        // access to DocumentContent.SyntaxTree; without the catch the JSON-RPC layer
        // would surface a "-32000 Object reference not set to an instance of an object"
        // error popup for every request the editor pulls.
        var contentService = new ThrowingDocumentContentService();
        var server = new LspServer(contentService, new WorkspaceState());
        var uri = DocumentUri.From("file:///throw-test.gs");

        // Populate the service with a sentinel entry whose SyntaxTree access throws.
        contentService.InstallThrowingEntry(uri.ToString());

        var id = new TextDocumentIdentifier { Uri = uri };

        // Each of these handler types would historically tear down with NRE.
        Assert.Null(await server.HoverAsync(new HoverParams { TextDocument = id, Position = new Position(0, 0) }));
        Assert.Empty(await server.InlayHintAsync(new InlayHintParams { TextDocument = id }) ?? Array.Empty<InlayHint>());
        Assert.Empty(await server.CodeLensAsync(new CodeLensParams { TextDocument = id }) ?? Array.Empty<CodeLens>());

        var tokens = await server.SemanticTokensFullAsync(new SemanticTokensParams { TextDocument = id });
        Assert.True(tokens == null || tokens.Data.IsDefaultOrEmpty);
    }

    private sealed class ThrowingDocumentContentService : DocumentContentService
    {
        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, bool> throwingKeys = new();

        public void InstallThrowingEntry(string key) => this.throwingKeys[key] = true;

        public override bool TryGet(string key, out DocumentContent content)
        {
            if (this.throwingKeys.ContainsKey(key))
            {
                throw new NullReferenceException("Simulated #816 NRE inside content lookup.");
            }

            return base.TryGet(key, out content);
        }
    }
}
