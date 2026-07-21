using System;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using StreamJsonRpc;

#if NETFRAMEWORK
using System.ComponentModel.Composition;
#endif

namespace GSharp.VisualStudio;

#if NETFRAMEWORK
[Export]
[PartCreationPolicy(CreationPolicy.Shared)]
#endif
public sealed class GSharpLanguageServerRpc
{
    internal const string ReferenceCodeLensMethod = "gsharp/referenceCodeLens";

    private readonly object syncRoot = new();
    private JsonRpc? rpc;
    private bool initialized;

    internal event EventHandler? StateChanged;

    internal bool IsReady
    {
        get
        {
            lock (syncRoot)
            {
                return initialized && rpc != null;
            }
        }
    }

    internal void Attach(JsonRpc newRpc)
    {
        if (newRpc == null)
        {
            throw new ArgumentNullException(nameof(newRpc));
        }

        lock (syncRoot)
        {
            if (rpc != null)
            {
                rpc.Disconnected -= OnDisconnected;
            }

            rpc = newRpc;
            initialized = false;
            rpc.Disconnected += OnDisconnected;
        }

        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    internal void MarkInitialized()
    {
        lock (syncRoot)
        {
            if (rpc == null)
            {
                throw new InvalidOperationException("The G# language-server RPC connection is not attached.");
            }

            initialized = true;
        }

        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    internal void Detach()
    {
        lock (syncRoot)
        {
            if (rpc != null)
            {
                rpc.Disconnected -= OnDisconnected;
            }

            rpc = null;
            initialized = false;
        }

        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    internal async Task<TResult> InvokeAsync<TResult>(
        string method,
        object? parameters,
        CancellationToken cancellationToken)
    {
        JsonRpc current;
        lock (syncRoot)
        {
            current = initialized && rpc != null
                ? rpc
                : throw new InvalidOperationException("The G# language server is not ready.");
        }

        if (parameters == null)
        {
            return await current.InvokeWithCancellationAsync<TResult>(
                method,
                Array.Empty<object>(),
                cancellationToken);
        }

        return await current.InvokeWithParameterObjectAsync<TResult>(
            method,
            parameters,
            cancellationToken);
    }

    internal Task<GSharpReferenceCodeLens[]> GetReferenceCodeLensesAsync(
        string documentUri,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(documentUri))
        {
            throw new ArgumentException("A document URI is required.", nameof(documentUri));
        }

        return InvokeAsync<GSharpReferenceCodeLens[]>(
            ReferenceCodeLensMethod,
            new { textDocument = new { uri = documentUri } },
            cancellationToken);
    }

    private void OnDisconnected(object? sender, JsonRpcDisconnectedEventArgs e)
    {
        lock (syncRoot)
        {
            if (rpc is not JsonRpc current || !ReferenceEquals(current, sender))
            {
                return;
            }

            current.Disconnected -= OnDisconnected;
            rpc = null;
            initialized = false;
        }

        StateChanged?.Invoke(this, EventArgs.Empty);
    }
}

internal sealed class GSharpReferenceCodeLens
{
    [JsonPropertyName("declarationRange")]
    public GSharpRange? DeclarationRange { get; set; }

    [JsonPropertyName("referenceCount")]
    public int ReferenceCount { get; set; }

    [JsonPropertyName("references")]
    public GSharpLocation[] References { get; set; } = Array.Empty<GSharpLocation>();
}

internal sealed class GSharpLocation
{
    [JsonPropertyName("uri")]
    public string? Uri { get; set; }

    [JsonPropertyName("range")]
    public GSharpRange? Range { get; set; }
}

internal sealed class GSharpRange
{
    [JsonPropertyName("start")]
    public GSharpPosition? Start { get; set; }

    [JsonPropertyName("end")]
    public GSharpPosition? End { get; set; }
}

internal sealed class GSharpPosition
{
    [JsonPropertyName("line")]
    public int Line { get; set; }

    [JsonPropertyName("character")]
    public int Character { get; set; }
}
