// <copyright file="LspServerFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Regression coverage for issue #1660: multi-statement bodies no longer collapse onto one
/// line, formatting options (request-level and server initializationOptions) are honored, and
/// the range/on-type formatting capabilities are not advertised since FormattingEngine only
/// supports whole-document formatting.
/// </summary>
public class LspServerFormattingTests
{
    [Fact]
    public void ServerCapabilities_DoNotAdvertiseRangeOrOnTypeFormatting()
    {
        var capabilities = ServerCapabilitiesFactory.Create();

        Assert.True(capabilities.DocumentFormattingProvider);
        Assert.False(capabilities.DocumentRangeFormattingProvider);
        Assert.Null(capabilities.DocumentOnTypeFormattingProvider);
    }

    [Fact]
    public async Task FormattingAsync_MultiStatementBody_KeepsStatementsOnSeparateLines()
    {
        var (server, uri, gsPath) = await OpenDocumentAsync("func foo() {\nvar x = 1\nvar y = 2\n}\n");
        try
        {
            var edits = await server.FormattingAsync(new DocumentFormattingParams
            {
                TextDocument = new TextDocumentIdentifier { Uri = uri },
                Options = new FormattingOptions { TabSize = 2, InsertSpaces = true },
            });

            var edit = Assert.Single(edits);
            Assert.Equal("func foo () {\n  var x = 1\n  var y = 2\n}\n", edit.NewText);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!, recursive: true);
        }
    }

    [Fact]
    public async Task FormattingAsync_HonorsRequestFormattingOptions()
    {
        var (server, uri, gsPath) = await OpenDocumentAsync("func foo() {\nvar x = 1\n}\n");
        try
        {
            var edits = await server.FormattingAsync(new DocumentFormattingParams
            {
                TextDocument = new TextDocumentIdentifier { Uri = uri },
                Options = new FormattingOptions { TabSize = 4, InsertSpaces = true },
            });

            var edit = Assert.Single(edits);
            Assert.Contains("    var x = 1", edit.NewText);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!, recursive: true);
        }
    }

    [Fact]
    public async Task InitializeAsync_FormattingIndentSizeInitializationOption_IsUsedWhenRequestOmitsOptions()
    {
        var (server, uri, gsPath) = await OpenDocumentAsync("func foo() {\nvar x = 1\n}\n", indentSize: 4, useTabs: false);
        try
        {
            var edits = await server.FormattingAsync(new DocumentFormattingParams
            {
                TextDocument = new TextDocumentIdentifier { Uri = uri },
                Options = null,
            });

            var edit = Assert.Single(edits);
            Assert.Contains("    var x = 1", edit.NewText);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!, recursive: true);
        }
    }

    private static async Task<(LspServer Server, DocumentUri Uri, string GsPath)> OpenDocumentAsync(
        string text, int? indentSize = null, bool? useTabs = null)
    {
        var rootDir = Path.Combine(Path.GetTempPath(), "gsfmt_" + System.Guid.NewGuid().ToString("N"));
        var projDir = Path.Combine(rootDir, "Demo");
        Directory.CreateDirectory(projDir);

        File.WriteAllText(
            Path.Combine(projDir, "Demo.gsproj"),
            "<Project Sdk=\"Gsharp.NET.Sdk\">\n  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>\n</Project>\n");

        var gsPath = Path.Combine(projDir, "Foo.gs");
        File.WriteAllText(gsPath, text);

        var workspace = new WorkspaceState();
        WorkspaceInitializer.Initialize(workspace, rootDir);
        var server = new LspServer(new DocumentContentService(), workspace);

        if (indentSize.HasValue || useTabs.HasValue)
        {
            var initOptionsJson = JsonSerializer.Serialize(new
            {
                formattingIndentSize = indentSize ?? 2,
                formattingUseTabs = useTabs ?? false,
            });
            using var doc = JsonDocument.Parse(initOptionsJson);
            await server.InitializeAsync(new InitializeParams { InitializationOptions = doc.RootElement.Clone() });
        }

        var uri = DocumentUri.FromFileSystemPath(gsPath);
        await server.DidOpenAsync(new DidOpenTextDocumentParams
        {
            TextDocument = new TextDocumentItem { Uri = uri, Text = text },
        });

        return (server, uri, gsPath);
    }
}
