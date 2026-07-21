// <copyright file="LspServerParityContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class LspServerParityContractTests
{
    [Fact]
    public async Task Initialize_CapabilitiesMatchSnapshot()
    {
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());

        var result = await server.InitializeAsync(new InitializeParams());
        var actual = JsonNode.Parse(JsonSerializer.Serialize(result.Capabilities, LspJson.Options));
        var expected = JsonNode.Parse(
            """
            {
              "textDocumentSync":{"openClose":true,"change":1,"save":{"includeText":true}},
              "hoverProvider":true,
              "definitionProvider":true,
              "typeDefinitionProvider":true,
              "implementationProvider":true,
              "referencesProvider":true,
              "documentHighlightProvider":true,
              "documentSymbolProvider":true,
              "workspaceSymbolProvider":true,
              "codeActionProvider":{"codeActionKinds":["quickfix","refactor.rewrite"]},
              "codeLensProvider":{"resolveProvider":false},
              "documentFormattingProvider":true,
              "documentRangeFormattingProvider":false,
              "renameProvider":{"prepareProvider":true},
              "foldingRangeProvider":true,
              "selectionRangeProvider":true,
              "semanticTokensProvider":{
                "legend":{
                  "tokenTypes":["namespace","type","struct","interface","enum","enumMember","typeParameter","parameter","variable","property","function","method","keyword","string","number","operator","comment","event"],
                  "tokenModifiers":["declaration","definition","readonly","static","async","deprecated"]
                },
                "full":{"delta":false},
                "range":true
              },
              "completionProvider":{"triggerCharacters":["."],"resolveProvider":false},
              "signatureHelpProvider":{"triggerCharacters":["(",","] ,"retriggerCharacters":[","]},
              "inlayHintProvider":{"resolveProvider":false},
              "linkedEditingRangeProvider":true,
              "diagnosticProvider":{"identifier":"gsharp","interFileDependencies":true,"workspaceDiagnostics":false}
            }
            """);

        Assert.True(JsonNode.DeepEquals(expected, actual), actual?.ToJsonString());
    }

    [Fact]
    public async Task EmptyOpenAndSave_AreAppliedByRealHandlers()
    {
        var documents = new DocumentContentService();
        var server = new LspServer(documents, new WorkspaceState());
        var uri = DocumentUri.From("file:///empty-document.gs");

        await server.DidOpenAsync(new DidOpenTextDocumentParams
        {
            TextDocument = new TextDocumentItem { Uri = uri, Text = string.Empty },
        });

        Assert.True(documents.TryGet(uri.ToString(), out var opened));
        Assert.Equal(string.Empty, opened.SyntaxTree.Text.ToString());

        await server.DidChangeAsync(new DidChangeTextDocumentParams
        {
            TextDocument = new VersionedTextDocumentIdentifier { Uri = uri },
            ContentChanges =
            [
                new TextDocumentContentChangeEvent { Text = "func F() int32 -> 1\n" },
            ],
        });
        await server.DidSaveAsync(new DidSaveTextDocumentParams
        {
            TextDocument = new TextDocumentIdentifier { Uri = uri },
            Text = string.Empty,
        });

        Assert.True(documents.TryGet(uri.ToString(), out var saved));
        Assert.Equal(string.Empty, saved.SyntaxTree.Text.ToString());
    }

    [Fact]
    public async Task PushClient_OpenBeforeDiscovery_IsReboundWithProjectDiagnostics()
    {
        var root = CreateDirectory();
        try
        {
            var projectPath = Path.Combine(root, "Sample.gsproj");
            var sourcePath = Path.Combine(root, "Foo.gs");
            File.WriteAllText(
                projectPath,
                "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>");
            File.WriteAllText(sourcePath, "class Foo {\n  func run() int32 -> Bar().value()\n}\n");
            File.WriteAllText(
                Path.Combine(root, "Bar.gs"),
                "class Bar {\n  func value() int32 -> 1\n}\n");

            var workspace = new WorkspaceState();
            var server = new LspServer(new DocumentContentService(), workspace);
            var uri = DocumentUri.FromFileSystemPath(sourcePath);
            DiagnosticComputationResult projectBind = null;
            server.TestOnBindResult = (_, result) =>
            {
                if (result.Content.Project != null)
                {
                    projectBind = result;
                }
            };

            await server.InitializeAsync(new InitializeParams { RootPath = root });
            await server.DidOpenAsync(new DidOpenTextDocumentParams
            {
                TextDocument = new TextDocumentItem
                {
                    Uri = uri,
                    Text = File.ReadAllText(sourcePath),
                },
            });

            Assert.Null(workspace.GetProjectForFile(sourcePath));
            using var initializedParams = JsonDocument.Parse("{}");
            server.Initialized(initializedParams.RootElement.Clone());

            await WaitForAsync(() => Volatile.Read(ref projectBind) != null);
            Assert.Empty(projectBind.Diagnostics);
            Assert.Equal(Path.GetFullPath(projectPath), projectBind.Content.Project.ProjectFilePath);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task WatchedChangedSource_ReloadsProjectTreeFromDisk()
    {
        var root = CreateDirectory();
        try
        {
            var projectPath = Path.Combine(root, "Sample.gsproj");
            var sourcePath = Path.Combine(root, "Program.gs");
            File.WriteAllText(projectPath, "<Project />");
            File.WriteAllText(sourcePath, "func Value() int32 -> 1\n");

            var workspace = new WorkspaceState();
            WorkspaceInitializer.Initialize(workspace, root);
            var project = Assert.Single(workspace.Projects);
            File.WriteAllText(sourcePath, "func Value() int32 -> 2\n");

            var server = new LspServer(new DocumentContentService(), workspace);
            await NotifyWatchedFileAsync(server, sourcePath, FileChangeType.Changed);

            Assert.True(project.TryGetSyntaxTree(sourcePath, out var tree));
            Assert.Contains("-> 2", tree.Text.ToString(), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task WatchedChangedProject_RefreshesIdentityMetadata()
    {
        var root = CreateDirectory();
        try
        {
            var projectPath = Path.Combine(root, "Sample.gsproj");
            File.WriteAllText(
                projectPath,
                "<Project><PropertyGroup><AssemblyName>Before</AssemblyName><TargetFramework>net9.0</TargetFramework><RootNamespace>Before.Root</RootNamespace></PropertyGroup></Project>");
            File.WriteAllText(Path.Combine(root, "Program.gs"), string.Empty);

            var workspace = new WorkspaceState();
            WorkspaceInitializer.Initialize(workspace, root);
            var project = Assert.Single(workspace.Projects);

            File.WriteAllText(
                projectPath,
                "<Project><PropertyGroup><AssemblyName>After</AssemblyName><TargetFramework>net10.0</TargetFramework><RootNamespace>After.Root</RootNamespace></PropertyGroup></Project>");

            var server = new LspServer(new DocumentContentService(), workspace);
            await NotifyWatchedFileAsync(server, projectPath, FileChangeType.Changed);

            Assert.Same(project, workspace.GetProject(projectPath));
            Assert.Equal("After", project.AssemblyName);
            Assert.Equal("net10.0", project.TargetFramework);
            Assert.Equal("After.Root", project.RootNamespace);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static Task NotifyWatchedFileAsync(LspServer server, string path, FileChangeType changeType)
        => server.DidChangeWatchedFilesAsync(new DidChangeWatchedFilesParams
        {
            Changes =
            [
                new FileEvent { Uri = DocumentUri.FromFileSystemPath(path), Type = changeType },
            ],
        });

    private static string CreateDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "gsharp-lsp-parity-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static async Task WaitForAsync(Func<bool> condition, int timeoutMs = 10000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
            {
                Assert.Fail("Timed out waiting for asynchronous language-server work.");
            }

            await Task.Delay(25);
        }
    }
}
