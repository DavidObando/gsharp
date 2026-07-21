// <copyright file="InitializationOptionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public sealed class InitializationOptionsTests
{
    [Fact]
    public void Defaults_AdvertiseAllWorkingFeatures()
    {
        var options = new LanguageServerInitializationOptions();
        var capabilities = ServerCapabilitiesFactory.Create(options);

        Assert.Equal(new[] { "." }, capabilities.CompletionProvider.TriggerCharacters);
        Assert.NotNull(capabilities.CodeLensProvider);
        Assert.NotNull(capabilities.InlayHintProvider);
        Assert.True(options.DiagnosticsOnType);
        Assert.True(options.ColdStartCache);
    }

    [Fact]
    public void DisabledFeatures_AreNotAdvertised()
    {
        var capabilities = ServerCapabilitiesFactory.Create(
            new LanguageServerInitializationOptions
            {
                CompletionTriggerOnDot = false,
                ReferenceCodeLens = false,
                ParameterNameInlayHints = false,
                TypeInlayHints = false,
            });

        Assert.Equal(Array.Empty<string>(), capabilities.CompletionProvider.TriggerCharacters);
        Assert.Null(capabilities.CodeLensProvider);
        Assert.Null(capabilities.InlayHintProvider);
    }

    [Fact]
    public void Contract_UsesStableClientPropertyNames()
    {
        string json = JsonSerializer.Serialize(new LanguageServerInitializationOptions());

        Assert.Contains("\"formattingIndentSize\":4", json);
        Assert.Contains("\"diagnosticsOnType\":true", json);
        Assert.Contains("\"completionTriggerOnDot\":true", json);
        Assert.Contains("\"referenceCodeLens\":true", json);
        Assert.Contains("\"parameterNameInlayHints\":true", json);
        Assert.Contains("\"typeInlayHints\":true", json);
        Assert.Contains("\"coldStartCache\":true", json);
    }

    [Fact]
    public async Task DisabledOnTypeDiagnostics_DoesNotPublishOnChange()
    {
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());
        await server.InitializeAsync(new InitializeParams
        {
            InitializationOptions = new LanguageServerInitializationOptions
            {
                DiagnosticsOnType = false,
            },
        });
        var publishCount = 0;
        server.TestOnPublish = (_, _) => publishCount++;

        await server.DidChangeAsync(new DidChangeTextDocumentParams
        {
            TextDocument = new VersionedTextDocumentIdentifier
            {
                Uri = DocumentUri.FromFileSystemPath(Path.GetFullPath("settings-test.gs")),
            },
            ContentChanges = new List<TextDocumentContentChangeEvent>
            {
                new TextDocumentContentChangeEvent { Text = "var value = 1\n" },
            },
        });

        Assert.Equal(0, publishCount);
    }

    [Fact]
    public async Task DisabledCodeLens_HandlerReturnsNoItems()
    {
        var server = new LspServer(new DocumentContentService(), new WorkspaceState());
        await server.InitializeAsync(new InitializeParams
        {
            InitializationOptions = new LanguageServerInitializationOptions
            {
                ReferenceCodeLens = false,
            },
        });

        var lenses = await server.CodeLensAsync(new CodeLensParams
        {
            TextDocument = new TextDocumentIdentifier
            {
                Uri = DocumentUri.FromFileSystemPath(Path.GetFullPath("settings-test.gs")),
            },
        });

        Assert.Empty(lenses);
    }
}
