using System;
using System.Threading;
using System.Threading.Tasks;
using Nerdbank.Streams;
using StreamJsonRpc;
using Xunit;

namespace GSharp.VisualStudio;

public sealed class LanguageServerRpcTests
{
    [Fact]
    public async Task InvokeAsync_RequiresInitializedConnection()
    {
        var bridge = new GSharpLanguageServerRpc();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            bridge.InvokeAsync<int>("test/add", new { left = 1, right = 2 }, CancellationToken.None));

        var (clientRpc, serverRpc) = CreatePair();
        using (clientRpc)
        using (serverRpc)
        {
            bridge.Attach(clientRpc);
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                bridge.InvokeAsync<int>("test/add", new { left = 1, right = 2 }, CancellationToken.None));
        }
    }

    [Fact]
    public async Task InvokeAsync_UsesAttachedInitializedConnection()
    {
        var bridge = new GSharpLanguageServerRpc();
        var (clientRpc, serverRpc) = CreatePair();
        using (clientRpc)
        using (serverRpc)
        {
            bridge.Attach(clientRpc);
            bridge.MarkInitialized();

            int result = await bridge.InvokeAsync<int>(
                "test/add",
                new { left = 3, right = 4 },
                CancellationToken.None);

            Assert.Equal(7, result);
            Assert.True(bridge.IsReady);
        }
    }

    [Fact]
    public async Task Attach_ReplacesPreviousConnection()
    {
        var bridge = new GSharpLanguageServerRpc();
        var (firstClient, firstServer) = CreatePair();
        var (secondClient, secondServer) = CreatePair();
        using (firstClient)
        using (firstServer)
        using (secondClient)
        using (secondServer)
        {
            bridge.Attach(firstClient);
            bridge.MarkInitialized();
            bridge.Attach(secondClient);

            Assert.False(bridge.IsReady);
            bridge.MarkInitialized();
            firstClient.Dispose();

            int result = await bridge.InvokeAsync<int>(
                "test/add",
                new { left = 8, right = 5 },
                CancellationToken.None);
            Assert.Equal(13, result);
        }
    }

    [Fact]
    public async Task Detach_RejectsFurtherRequests()
    {
        var bridge = new GSharpLanguageServerRpc();
        var (clientRpc, serverRpc) = CreatePair();
        using (clientRpc)
        using (serverRpc)
        {
            bridge.Attach(clientRpc);
            bridge.MarkInitialized();
            bridge.Detach();

            Assert.False(bridge.IsReady);
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                bridge.InvokeAsync<int>("test/add", new { left = 1, right = 2 }, CancellationToken.None));
        }
    }

    [Fact]
    public void ConnectionLifecycle_RaisesStateChanged()
    {
        var bridge = new GSharpLanguageServerRpc();
        var (clientRpc, serverRpc) = CreatePair();
        using (clientRpc)
        using (serverRpc)
        {
            var changes = 0;
            bridge.StateChanged += (_, _) => changes++;

            bridge.Attach(clientRpc);
            bridge.MarkInitialized();
            bridge.Detach();

            Assert.Equal(3, changes);
        }
    }

    [Fact]
    public async Task GetReferenceCodeLensesAsync_UsesTypedCustomRequest()
    {
        var bridge = new GSharpLanguageServerRpc();
        var (clientRpc, serverRpc) = CreatePair();
        using (clientRpc)
        using (serverRpc)
        {
            bridge.Attach(clientRpc);
            bridge.MarkInitialized();

            GSharpReferenceCodeLens[] lenses = await bridge.GetReferenceCodeLensesAsync(
                "file:///test.gs",
                CancellationToken.None);

            GSharpReferenceCodeLens lens = Assert.Single(lenses);
            Assert.Equal(1, lens.ReferenceCount);
            Assert.Equal(4, lens.DeclarationRange!.Start!.Character);
            Assert.Equal("file:///test.gs", Assert.Single(lens.References).Uri);
        }
    }

    [Fact]
    public async Task GetReferenceCodeLensesAsync_RejectsMissingDocumentUri()
    {
        var bridge = new GSharpLanguageServerRpc();
        await Assert.ThrowsAsync<ArgumentException>(() =>
            bridge.GetReferenceCodeLensesAsync(string.Empty, CancellationToken.None));
    }

    private static (JsonRpc Client, JsonRpc Server) CreatePair()
    {
        var (clientStream, serverStream) = FullDuplexStream.CreatePair();
        var server = JsonRpc.Attach(serverStream, new TestTarget());
        var client = JsonRpc.Attach(clientStream);
        return (client, server);
    }

    private sealed class TestTarget
    {
        [JsonRpcMethod("test/add", UseSingleObjectParameterDeserialization = true)]
        public int Add(AddParameters parameters) => parameters.Left + parameters.Right;

        [JsonRpcMethod(GSharpLanguageServerRpc.ReferenceCodeLensMethod, UseSingleObjectParameterDeserialization = true)]
        public GSharpReferenceCodeLens[] GetReferenceCodeLenses(ReferenceCodeLensParameters parameters)
            =>
            [
                new GSharpReferenceCodeLens
                {
                    DeclarationRange = new GSharpRange
                    {
                        Start = new GSharpPosition { Line = 0, Character = 4 },
                        End = new GSharpPosition { Line = 0, Character = 7 },
                    },
                    ReferenceCount = 1,
                    References =
                    [
                        new GSharpLocation
                        {
                            Uri = parameters.TextDocument.Uri,
                            Range = new GSharpRange
                            {
                                Start = new GSharpPosition { Line = 1, Character = 8 },
                                End = new GSharpPosition { Line = 1, Character = 11 },
                            },
                        },
                    ],
                },
            ];
    }

    private sealed class AddParameters
    {
        public int Left { get; set; }

        public int Right { get; set; }
    }

    private sealed class ReferenceCodeLensParameters
    {
        public TextDocumentParameters TextDocument { get; set; } = new();
    }

    private sealed class TextDocumentParameters
    {
        public string Uri { get; set; } = string.Empty;
    }
}
