// <copyright file="ReferenceCodeLensRpcTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import Nerdbank.Streams
import StreamJsonRpc
import System.Threading
import System.Threading.Tasks
import Xunit

class ReferenceCodeLensRpcTests {
    @Fact
    async func ReferenceCodeLensRequest_OverRpc_ReusesCodeLensAnalysis() {
        const source = `func add(a int32, b int32) int32 { return a + b }
var x = add(1, 2)
`
        let uri = DocumentUri.From("file:///test.gs")!!
        let documents = DocumentContentService()
        documents.AddOrUpdate(uri.ToString(), LanguageServerTestHelpers.Content(source))
        let server = LspServer(documents, WorkspaceState())
        let (clientStream, serverStream) = FullDuplexStream.CreatePair()
        using let serverRpc = JsonRpc(
            HeaderDelimitedMessageHandler(
                serverStream,
                serverStream,
                SystemTextJsonFormatter{JsonSerializerOptions: LspJson.Options}
            )
        )
        serverRpc.AddLocalRpcTarget(server, JsonRpcTargetOptions{DisposeOnDisconnect: false})
        serverRpc.StartListening()
        using let clientRpc = JsonRpc(
            HeaderDelimitedMessageHandler(
                clientStream,
                clientStream,
                SystemTextJsonFormatter{JsonSerializerOptions: LspJson.Options}
            )
        )
        clientRpc.StartListening()
        let lenses = await clientRpc.InvokeWithParameterObjectAsync[[]ReferenceCodeLens](
            "gsharp/referenceCodeLens",
            CodeLensParams{TextDocument: TextDocumentIdentifier{Uri: uri}},
            CancellationToken.None
        )
        Assert.Equal(2, lenses.Length)
        Assert.Equal(1, lenses[0].ReferenceCount)
        Assert.Single(lenses[0].References)
        Assert.Equal(1, lenses[0].References[0].Range.Start.Line)
    }
}
