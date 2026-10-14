// <copyright file="DocumentDiagnosticHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import System
import System.IO
import System.Linq
import System.Text.Json
import System.Threading
import System.Threading.Tasks
import Xunit

open class DocumentDiagnosticHandlerTests {
    @Fact
    async func DocumentDiagnostic_IncludesBindingDiagnostics() {
        let (server, uri) = await CreateServerWithDocumentAsync(BodyErrorSource)
        let report = await server.DocumentDiagnosticAsync(
            DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: uri}},
            CancellationToken.None
        )
        let full = Assert.IsType[FullDocumentDiagnosticReport](report)
        Assert.Equal("full", full.Kind)
        Assert.False(string.IsNullOrEmpty(full.ResultId))
        Assert.Contains(
            full.Items,
            (d Diagnostic) -> d.Message.Contains("Not all code paths", StringComparison.Ordinal)
        )
    }

    @Fact
    async func DocumentDiagnostic_UnchangedPreviousResultId_ReturnsUnchangedReport() {
        let (server, uri) = await CreateServerWithDocumentAsync(BodyErrorSource)
        let first = cast[FullDocumentDiagnosticReport](
            await server.DocumentDiagnosticAsync(
                DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: uri}},
                CancellationToken.None
            )
        )
        let second = await server.DocumentDiagnosticAsync(
            DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: uri}, PreviousResultId: first.ResultId},
            CancellationToken.None
        )
        let unchanged = Assert.IsType[UnchangedDocumentDiagnosticReport](second)
        Assert.Equal("unchanged", unchanged.Kind)
        Assert.Equal(first.ResultId, unchanged.ResultId)
    }

    @Fact
    async func DocumentDiagnostic_UnknownDocument_ReturnsEmptyFullReport() {
        let server = LspServer(DocumentContentService(), WorkspaceState())
        let report = await server.DocumentDiagnosticAsync(
            DocumentDiagnosticParams{
                TextDocument: TextDocumentIdentifier{Uri: DocumentUri.From("file:///missing.gs")!!}
            },
            CancellationToken.None
        )
        let full = Assert.IsType[FullDocumentDiagnosticReport](report)
        Assert.Empty(full.Items)
    }

    @Fact
    func ServerCapabilities_AdvertisesPullDiagnostics() {
        let capabilities = ServerCapabilitiesFactory.Create()
        Assert.NotNull(capabilities.DiagnosticProvider)
        Assert.Equal(Constants.LanguageId, capabilities.DiagnosticProvider.Identifier)
        Assert.True(capabilities.DiagnosticProvider.InterFileDependencies)
    }

    @Fact
    async func DocumentDiagnostic_Report_SerializesRuntimeKind() {
        let (server, uri) = await CreateServerWithDocumentAsync(BodyErrorSource)
        let report = await server.DocumentDiagnosticAsync(
            DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: uri}},
            CancellationToken.None
        )
        // The handler returns object; the protocol depends on the runtime type ("full"/"unchanged")
        // being serialized, not the declared object type.
        let json = JsonSerializer.Serialize(report, LspJson.Options)
        Assert.Contains("\"kind\":\"full\"", json, StringComparison.Ordinal)
        Assert.Contains("\"items\":", json, StringComparison.Ordinal)
    }

    @Fact
    async func DocumentDiagnostic_ProjectFile_ReportsConversionError() {
        // Regression for #359 follow-up: a file that belongs to a project still reports its own
        // semantic/binding diagnostics. The project keeps a separate SyntaxTree instance per file,
        // so the report must be attributed to the in-memory-synced tree rather than dropped.
        let dir = Path.Combine(Path.GetTempPath(), "gsdiag" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(dir)
        try {
            let gsPath = Path.Combine(dir, "Program.gs")
            const source = "var y uint8 = true\n"
            File.WriteAllText(gsPath, source)
            File.WriteAllText(Path.Combine(dir, "Repro.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
<PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup>
<ItemGroup><Compile Include="Program.gs" /></ItemGroup>
</Project>
`)
            let workspace = WorkspaceState()
            WorkspaceInitializer.Initialize(workspace, dir)
            let server = LspServer(DocumentContentService(), workspace)
            let uri = DocumentUri.FromFileSystemPath(gsPath)!!
            await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: source}})
            let report = await server.DocumentDiagnosticAsync(
                DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: uri}},
                CancellationToken.None
            )
            let full = Assert.IsType[FullDocumentDiagnosticReport](report)
            Assert.Contains(
                full.Items,
                (d Diagnostic) -> d.Message.Contains("Cannot convert type", StringComparison.Ordinal)
            )
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Fact
    async func DocumentDiagnostic_ErrorOnLaterLine_ReportsCorrectColumn() {
        // Regression: column mapping previously hardcoded a 2-char ("\r\n") line break, so on
        // LF documents every line after the first was reported one column too early.
        // Line 1 (0-based) is "var y uint8 = true"; "true" starts at character index 14.
        const source = `let a = 1
var y uint8 = true
`
        let (server, uri) = await CreateServerWithDocumentAsync(source)
        let report = await server.DocumentDiagnosticAsync(
            DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: uri}},
            CancellationToken.None
        )
        let full = Assert.IsType[FullDocumentDiagnosticReport](report)
        let conversion = Assert.Single(
            full.Items,
            (d Diagnostic) -> d.Message.Contains("Cannot convert type", StringComparison.Ordinal)
        )
        Assert.Equal(1, conversion.Range.Start.Line)
        Assert.Equal(14, conversion.Range.Start.Character)
    }

    @Fact
    async func DocumentDiagnostic_UnknownDocTag_ReportsGS0231Warning() {
        const source = `package Lib

/// Gets a value.
/// @return the value
func Get() int32 {
    return 0
}`
        let (server, uri) = await CreateServerWithDocumentAsync(source)
        let report = await server.DocumentDiagnosticAsync(
            DocumentDiagnosticParams{TextDocument: TextDocumentIdentifier{Uri: uri}},
            CancellationToken.None
        )
        let full = Assert.IsType[FullDocumentDiagnosticReport](report)
        let diag = Assert.Single(full.Items, (d Diagnostic) -> d.Code!!.Value == "GS0231")
        Assert.Equal(DiagnosticSeverity.Warning, diag.Severity)
        Assert.Contains("@return", diag.Message, StringComparison.Ordinal)
    }

    shared {
        private const BodyErrorSource string = `func F() int32 {
}
`

        private async func CreateServerWithDocumentAsync(source string)(Server LspServer, Uri DocumentUri) {
            let server = LspServer(DocumentContentService(), WorkspaceState())
            let uri = DocumentUri.From("file:///diagnostic-test.gs")!!
            await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: source}})
            return (server, uri)
        }
    }
}
