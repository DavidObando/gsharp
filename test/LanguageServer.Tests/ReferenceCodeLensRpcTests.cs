// <copyright file="ReferenceCodeLensRpcTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Nerdbank.Streams;
using StreamJsonRpc;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public sealed class ReferenceCodeLensRpcTests
{
    [Fact]
    public async Task ReferenceCodeLensRequest_OverRpc_ReusesCodeLensAnalysis()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar x = add(1, 2)\n";
        var uri = DocumentUri.From("file:///test.gs");
        var documents = new DocumentContentService();
        documents.AddOrUpdate(uri.ToString(), LanguageServerTestHelpers.Content(source));
        var server = new LspServer(documents, new WorkspaceState());

        var (clientStream, serverStream) = FullDuplexStream.CreatePair();
        using var serverRpc = new JsonRpc(new HeaderDelimitedMessageHandler(
            serverStream,
            serverStream,
            new SystemTextJsonFormatter { JsonSerializerOptions = LspJson.Options }));
        serverRpc.AddLocalRpcTarget(server, new JsonRpcTargetOptions { DisposeOnDisconnect = false });
        serverRpc.StartListening();
        using var clientRpc = new JsonRpc(new HeaderDelimitedMessageHandler(
            clientStream,
            clientStream,
            new SystemTextJsonFormatter { JsonSerializerOptions = LspJson.Options }));
        clientRpc.StartListening();

        var lenses = await clientRpc.InvokeWithParameterObjectAsync<ReferenceCodeLens[]>(
            "gsharp/referenceCodeLens",
            new CodeLensParams
            {
                TextDocument = new TextDocumentIdentifier { Uri = uri },
            },
            CancellationToken.None);

        Assert.Equal(2, lenses.Length);
        Assert.Equal(1, lenses[0].ReferenceCount);
        Assert.Single(lenses[0].References);
        Assert.Equal(1, lenses[0].References[0].Range.Start.Line);
    }
}
