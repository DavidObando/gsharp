// <copyright file="DocumentDiagnosticHandlerTests.cs" company="GSharp">
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

public class DocumentDiagnosticHandlerTests
{
    private const string BodyErrorSource = "func F() int32 {\n}\n";

    [Fact]
    public async Task DocumentDiagnostic_IncludesBindingDiagnostics()
    {
        var (server, uri) = await CreateServerWithDocumentAsync(BodyErrorSource);

        var report = await server.DocumentDiagnosticAsync(
            new DocumentDiagnosticParams { TextDocument = new TextDocumentIdentifier { Uri = uri } },
            CancellationToken.None);

        var full = Assert.IsType<FullDocumentDiagnosticReport>(report);
        Assert.Equal("full", full.Kind);
        Assert.False(string.IsNullOrEmpty(full.ResultId));
        Assert.Contains(full.Items, d => d.Message.Contains("Not all code paths", StringComparison.Ordinal));
    }

    [Fact]
    public async Task DocumentDiagnostic_UnchangedPreviousResultId_ReturnsUnchangedReport()
    {
        var (server, uri) = await CreateServerWithDocumentAsync(BodyErrorSource);

        var first = (FullDocumentDiagnosticReport)await server.DocumentDiagnosticAsync(
            new DocumentDiagnosticParams { TextDocument = new TextDocumentIdentifier { Uri = uri } },
            CancellationToken.None);

        var second = await server.DocumentDiagnosticAsync(
            new DocumentDiagnosticParams
            {
                TextDocument = new TextDocumentIdentifier { Uri = uri },
                PreviousResultId = first.ResultId,
            },
            CancellationToken.None);

        var unchanged = Assert.IsType<UnchangedDocumentDiagnosticReport>(second);
        Assert.Equal("unchanged", unchanged.Kind);
        Assert.Equal(first.ResultId, unchanged.ResultId);
    }

    [Fact]
    public async Task DocumentDiagnostic_UnknownDocument_ReturnsEmptyFullReport()
    {
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());

        var report = await server.DocumentDiagnosticAsync(
            new DocumentDiagnosticParams { TextDocument = new TextDocumentIdentifier { Uri = DocumentUri.From("file:///missing.gs") } },
            CancellationToken.None);

        var full = Assert.IsType<FullDocumentDiagnosticReport>(report);
        Assert.Empty(full.Items);
    }

    [Fact]
    public void ServerCapabilities_AdvertisesPullDiagnostics()
    {
        var capabilities = ServerCapabilitiesFactory.Create();

        Assert.NotNull(capabilities.DiagnosticProvider);
        Assert.Equal(Constants.LanguageId, capabilities.DiagnosticProvider.Identifier);
        Assert.True(capabilities.DiagnosticProvider.InterFileDependencies);
    }

    [Fact]
    public async Task DocumentDiagnostic_Report_SerializesRuntimeKind()
    {
        var (server, uri) = await CreateServerWithDocumentAsync(BodyErrorSource);

        object report = await server.DocumentDiagnosticAsync(
            new DocumentDiagnosticParams { TextDocument = new TextDocumentIdentifier { Uri = uri } },
            CancellationToken.None);

        // The handler returns object; the protocol depends on the runtime type ("full"/"unchanged")
        // being serialized, not the declared object type.
        var json = System.Text.Json.JsonSerializer.Serialize(report, LspJson.Options);
        Assert.Contains("\"kind\":\"full\"", json, StringComparison.Ordinal);
        Assert.Contains("\"items\":", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DocumentDiagnostic_ProjectFile_ReportsConversionError()
    {
        // Regression for #359 follow-up: a file that belongs to a project still reports its own
        // semantic/binding diagnostics. The project keeps a separate SyntaxTree instance per file,
        // so the report must be attributed to the in-memory-synced tree rather than dropped.
        var dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "gsdiag" + Guid.NewGuid().ToString("N"));
        System.IO.Directory.CreateDirectory(dir);
        try
        {
            var gsPath = System.IO.Path.Combine(dir, "Program.gs");
            const string source = "var y uint8 = 255\n";
            System.IO.File.WriteAllText(gsPath, source);
            System.IO.File.WriteAllText(
                System.IO.Path.Combine(dir, "Repro.gsproj"),
                "<Project Sdk=\"Gsharp.NET.Sdk\">\n<PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup>\n<ItemGroup><Compile Include=\"Program.gs\" /></ItemGroup>\n</Project>\n");

            var workspace = new WorkspaceState();
            WorkspaceInitializer.Initialize(workspace, dir);
            var server = new LspServer(new DocumentContentService(), workspace);
            var uri = DocumentUri.FromFileSystemPath(gsPath);
            await server.DidOpenAsync(new DidOpenTextDocumentParams
            {
                TextDocument = new TextDocumentItem { Uri = uri, Text = source },
            });

            var report = await server.DocumentDiagnosticAsync(
                new DocumentDiagnosticParams { TextDocument = new TextDocumentIdentifier { Uri = uri } },
                CancellationToken.None);

            var full = Assert.IsType<FullDocumentDiagnosticReport>(report);
            Assert.Contains(full.Items, d => d.Message.Contains("Cannot convert type", StringComparison.Ordinal));
        }
        finally
        {
            System.IO.Directory.Delete(dir, recursive: true);
        }
    }

    private static async Task<(LspServer Server, DocumentUri Uri)> CreateServerWithDocumentAsync(string source)
    {
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());
        var uri = DocumentUri.From("file:///diagnostic-test.gs");
        await server.DidOpenAsync(new DidOpenTextDocumentParams
        {
            TextDocument = new TextDocumentItem { Uri = uri, Text = source },
        });
        return (server, uri);
    }
}
