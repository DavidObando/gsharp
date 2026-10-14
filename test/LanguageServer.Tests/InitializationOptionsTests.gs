// <copyright file="InitializationOptionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Threading.Tasks
import Xunit

class InitializationOptionsTests {
    @Fact
    func Defaults_AdvertiseAllWorkingFeatures() {
        let options = LanguageServerInitializationOptions()
        let capabilities = ServerCapabilitiesFactory.Create(options)
        Assert.Equal([]string{"."}, capabilities.CompletionProvider.TriggerCharacters)
        Assert.NotNull(capabilities.CodeLensProvider)
        Assert.NotNull(capabilities.InlayHintProvider)
        Assert.True(options.DiagnosticsOnType)
        Assert.True(options.ColdStartCache)
    }

    @Fact
    func DisabledFeatures_AreNotAdvertised() {
        let capabilities = ServerCapabilitiesFactory.Create(
            LanguageServerInitializationOptions{
                CompletionTriggerOnDot: false,
                ReferenceCodeLens: false,
                ParameterNameInlayHints: false,
                TypeInlayHints: false
            }
        )
        Assert.Equal(Array.Empty[string](), capabilities.CompletionProvider.TriggerCharacters)
        Assert.Null(capabilities.CodeLensProvider)
        Assert.Null(capabilities.InlayHintProvider)
    }

    @Fact
    func Contract_UsesStableClientPropertyNames() {
        let json = JsonSerializer.Serialize(LanguageServerInitializationOptions())
        Assert.DoesNotContain("formattingIndentSize", json, StringComparison.Ordinal)
        Assert.DoesNotContain("formattingUseTabs", json, StringComparison.Ordinal)
        Assert.Contains("\"diagnosticsOnType\":true", json)
        Assert.Contains("\"completionTriggerOnDot\":true", json)
        Assert.Contains("\"referenceCodeLens\":true", json)
        Assert.Contains("\"parameterNameInlayHints\":true", json)
        Assert.Contains("\"typeInlayHints\":true", json)
        Assert.Contains("\"coldStartCache\":true", json)
    }

    @Fact
    async func DisabledOnTypeDiagnostics_DoesNotPublishOnChange() {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        await server.InitializeAsync(
            InitializeParams{InitializationOptions: LanguageServerInitializationOptions{DiagnosticsOnType: false}}
        )
        var publishCount = 0
        server.TestOnPublish = (_ DocumentUri, _ IReadOnlyList[Diagnostic]) -> publishCount++
        await server.DidChangeAsync(
            DidChangeTextDocumentParams{
                TextDocument: VersionedTextDocumentIdentifier{
                    Uri: DocumentUri.FromFileSystemPath(Path.GetFullPath("settings-test.gs"))!!
                },
                ContentChanges: List[TextDocumentContentChangeEvent]{
                    TextDocumentContentChangeEvent{Text: "var value = 1\n"}
                }
            }
        )
        Assert.Equal(0, publishCount)
    }

    @Fact
    async func DisabledCodeLens_HandlerReturnsNoItems() {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        await server.InitializeAsync(
            InitializeParams{InitializationOptions: LanguageServerInitializationOptions{ReferenceCodeLens: false}}
        )
        let lenses = await server.CodeLensAsync(
            CodeLensParams{
                TextDocument: TextDocumentIdentifier{
                    Uri: DocumentUri.FromFileSystemPath(Path.GetFullPath("settings-test.gs"))!!
                }
            }
        )
        Assert.Empty(lenses)
    }
}
