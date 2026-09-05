// <copyright file="LspServerFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// ADR-0179 coverage for canonical whole-document, range, and on-type formatting.
/// </summary>
public class LspServerFormattingTests
{
    [Fact]
    public void ServerCapabilities_AdvertiseCanonicalFormattingSurfaces()
    {
        var capabilities = ServerCapabilitiesFactory.Create();

        Assert.True(capabilities.DocumentFormattingProvider);
        Assert.True(capabilities.DocumentRangeFormattingProvider);
        Assert.NotNull(capabilities.DocumentOnTypeFormattingProvider);
    }

    [Fact]
    public async Task FormattingAsync_MultiStatementBody_KeepsStatementsOnSeparateLines()
    {
        const string source = "func foo() {\nvar x = 1\nvar y = 2\n}\n";
        var (server, uri, gsPath) = await OpenDocumentAsync(source);
        try
        {
            var edits = await server.FormattingAsync(new DocumentFormattingParams
            {
                TextDocument = new TextDocumentIdentifier { Uri = uri },
                Options = new FormattingOptions { TabSize = 2, InsertSpaces = true },
            });

            string formatted = ApplyEdits(source, edits);
            Assert.Contains("    var x = 1", formatted);
            Assert.Contains("    var y = 2", formatted);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!, recursive: true);
        }
    }

    [Fact]
    public async Task FormattingAsync_IgnoresRequestFormattingOptions()
    {
        const string source = "func foo() {\nvar x = 1\n}\n";
        var (server, uri, gsPath) = await OpenDocumentAsync(source);
        try
        {
            var edits = await server.FormattingAsync(new DocumentFormattingParams
            {
                TextDocument = new TextDocumentIdentifier { Uri = uri },
                Options = new FormattingOptions { TabSize = 4, InsertSpaces = true },
            });

            Assert.Contains("    var x = 1", ApplyEdits(source, edits));
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!, recursive: true);
        }
    }

    [Fact]
    public async Task RangeFormattingAsync_FormatsIntersectingSource()
    {
        var (server, uri, gsPath) = await OpenDocumentAsync("func foo() {\nvar x = 1\nvar y = 2\n}\n");
        try
        {
            var edits = await server.RangeFormattingAsync(new DocumentRangeFormattingParams
            {
                TextDocument = new TextDocumentIdentifier { Uri = uri },
                Range = new GSharp.LanguageServer.Protocol.Range
                {
                    Start = new Position { Line = 1, Character = 0 },
                    End = new Position { Line = 1, Character = 9 },
                },
                Options = new FormattingOptions { TabSize = 2, InsertSpaces = true },
            });

            Assert.NotEmpty(edits);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!, recursive: true);
        }
    }

    [Fact]
    public async Task OnTypeFormattingAsync_FormatsAtTheCaret()
    {
        var (server, uri, gsPath) = await OpenDocumentAsync("func foo() {\nvar x = 1\nvar y = 2\n}\n");
        try
        {
            var edits = await server.OnTypeFormattingAsync(new DocumentOnTypeFormattingParams
            {
                TextDocument = new TextDocumentIdentifier { Uri = uri },
                Position = new Position { Line = 2, Character = 9 },
                Ch = "\n",
                Options = new FormattingOptions { TabSize = 2, InsertSpaces = true },
            });

            Assert.NotEmpty(edits);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!, recursive: true);
        }
    }

    [Fact]
    public async Task InitializeAsync_FeatureOptions_DoNotChangeCanonicalFormatting()
    {
        const string source = "func foo() {\nvar x = 1\n}\n";
        var (server, uri, gsPath) = await OpenDocumentAsync(source, initialize: true);
        try
        {
            var edits = await server.FormattingAsync(new DocumentFormattingParams
            {
                TextDocument = new TextDocumentIdentifier { Uri = uri },
                Options = new FormattingOptions { TabSize = 2, InsertSpaces = true },
            });

            Assert.Contains("    var x = 1", ApplyEdits(source, edits));
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(Path.GetDirectoryName(gsPath))!, recursive: true);
        }
    }

    private static string ApplyEdits(string source, TextEdit[] edits)
    {
        foreach (TextEdit edit in edits.OrderByDescending(item => item.Range.Start.Line)
            .ThenByDescending(item => item.Range.Start.Character))
        {
            int start = ToOffset(source, edit.Range.Start);
            int end = ToOffset(source, edit.Range.End);
            source = source.Substring(0, start) + edit.NewText + source.Substring(end);
        }

        return source;
    }

    private static int ToOffset(string source, Position position)
    {
        int offset = 0;
        for (int line = 0; line < position.Line; line++)
        {
            int next = source.IndexOf('\n', offset);
            offset = next < 0 ? source.Length : next + 1;
        }

        return System.Math.Min(source.Length, offset + position.Character);
    }

    private static async Task<(LspServer Server, DocumentUri Uri, string GsPath)> OpenDocumentAsync(
        string text, bool initialize = false)
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

        if (initialize)
        {
            await server.InitializeAsync(new InitializeParams
            {
                InitializationOptions = new LanguageServerInitializationOptions
                {
                    DiagnosticsOnType = false,
                },
            });
        }

        var uri = DocumentUri.FromFileSystemPath(gsPath);
        await server.DidOpenAsync(new DidOpenTextDocumentParams
        {
            TextDocument = new TextDocumentItem { Uri = uri, Text = text },
        });

        return (server, uri, gsPath);
    }
}
