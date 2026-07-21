using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.LanguageServer.Client;
using Microsoft.VisualStudio.Threading;
using Microsoft.VisualStudio.Utilities;

namespace GSharp.VisualStudio;

[ContentType(GSharpContentTypeDefinitions.ContentTypeName)]
[Export(typeof(ILanguageClient))]
public sealed class GSharpLanguageClient : ILanguageClient, ILanguageClientCustomMessage2
{
    private readonly GSharpLanguageServerRpc rpcBridge;
    private readonly object serverProcessLock = new();
    private Process? serverProcess;
    private AsyncEventHandler<EventArgs>? stopAsync;

    internal static GSharpLanguageClient? Current { get; private set; }

    [ImportingConstructor]
    public GSharpLanguageClient(GSharpLanguageServerRpc rpcBridge)
    {
        this.rpcBridge = rpcBridge;
        Current = this;
    }

    public string Name => "G# Language Server";

    public bool ShowNotificationOnInitializeFailed => true;

    public IEnumerable<string>? ConfigurationSections => null;

    public object? MiddleLayer => null;

    public object? CustomMessageTarget => null;

    public object InitializationOptions
    {
        get
        {
            GSharpOptions options = GSharpPackage.Options;
            return LanguageClientPolicy.CreateInitializationOptions(
                options.IndentSize,
                options.UseTabs,
                options.EnableDiagnosticsOnType,
                options.TriggerCompletionOnDot,
                options.EnableReferenceCodeLens,
                options.EnableParameterNameInlayHints,
                options.EnableTypeInlayHints,
                options.EnableColdStartCache);
        }
    }

    public IEnumerable<string> FilesToWatch => new[]
    {
        "**/*.gs",
        "**/*.gsproj",
        "**/*.resx",
    };

    public event AsyncEventHandler<EventArgs>? StartAsync;

    public event AsyncEventHandler<EventArgs>? StopAsync
    {
        add => stopAsync += value;
        remove => stopAsync -= value;
    }

    public Task AttachForCustomMessageAsync(StreamJsonRpc.JsonRpc rpc)
    {
        rpcBridge.Attach(rpc);
        GSharpLog.Write("Attached custom language-server RPC connection.");
        return Task.CompletedTask;
    }

    public async Task<Connection?> ActivateAsync(CancellationToken token)
    {
        GSharpLog.Write("Activating language server.");
        await GSharpPackage.ShowStatusAsync("starting", includeActiveProject: true, token);
        GSharpOptions options = GSharpPackage.Options;
        string extensionDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)
            ?? throw new InvalidOperationException("Unable to locate the G# extension directory.");
        string serverPath = LanguageClientPolicy.ResolveServerPath(
            extensionDirectory,
            options.ServerPath);
        if (!File.Exists(serverPath))
        {
            throw new FileNotFoundException("The G# language server was not found.", serverPath);
        }

        string dotnetPath = DotnetHostResolver.Resolve();
        string arguments = Quote(serverPath);
        if (options.WaitForDebugger)
        {
            arguments += " --debug";
        }

        if (options.EnableServerLog)
        {
            string logPath = string.IsNullOrWhiteSpace(options.ServerLogPath)
                ? GSharpLog.ServerLogPath
                : Environment.ExpandEnvironmentVariables(options.ServerLogPath);
            arguments += " --log=" + Quote(logPath);
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = dotnetPath,
            Arguments = arguments,
            WorkingDirectory = extensionDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (KeyValuePair<string, string> variable in
            LanguageClientPolicy.CreateEnvironment(
                options.EnableColdStartCache,
                options.WaitForDebugger))
        {
            startInfo.EnvironmentVariables[variable.Key] = variable.Value;
        }

        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.ErrorDataReceived += (_, e) =>
        {
            if (!string.IsNullOrEmpty(e.Data))
            {
                Trace.WriteLine($"[G# LSP] {e.Data}");
            }
        };

        if (!process.Start())
        {
            process.Dispose();
            throw new InvalidOperationException("Failed to start the G# language server.");
        }

        process.BeginErrorReadLine();
        GSharpLog.Write($"Started {dotnetPath} with process id {process.Id}.");
        lock (serverProcessLock)
        {
            serverProcess = process;
        }

        token.Register(() => StopServer(process));

        await Task.Yield();
        return new Connection(process.StandardOutput.BaseStream, process.StandardInput.BaseStream);
    }

    public async Task OnLoadedAsync()
    {
        GSharpLog.Write("Language client loaded.");
        AsyncEventHandler<EventArgs>? start = StartAsync;
        if (start != null)
        {
            await start.InvokeAsync(this, EventArgs.Empty);
        }
    }

    public async Task<InitializationFailureContext?> OnServerInitializeFailedAsync(
        ILanguageClientInitializationInfo initializationState)
    {
        rpcBridge.Detach();
        GSharpLog.Write($"Initialization failed: {initializationState}");
        Trace.WriteLine($"[G# LSP] Initialization failed: {initializationState}");
        await GSharpPackage.ShowStatusAsync(
            "initialization failed; see G# Output",
            includeActiveProject: true,
            CancellationToken.None);
        return null;
    }

    public async Task OnServerInitializedAsync()
    {
        rpcBridge.MarkInitialized();
        GSharpLog.Write("Language server initialized.");
        Trace.WriteLine("[G# LSP] Initialized.");
        await GSharpPackage.ShowStatusAsync(
            "ready",
            includeActiveProject: true,
            CancellationToken.None);
    }

    internal async Task RestartAsync()
    {
        AsyncEventHandler<EventArgs>? stop = stopAsync;
        AsyncEventHandler<EventArgs>? start = StartAsync;
        rpcBridge.Detach();
        await GSharpPackage.ShowStatusAsync(
            "restarting",
            includeActiveProject: true,
            CancellationToken.None);
        await LanguageClientPolicy.RestartAsync(
            stop == null ? null : () => stop.InvokeAsync(this, EventArgs.Empty),
            start == null ? null : () => start.InvokeAsync(this, EventArgs.Empty));
    }

    private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";

    private void StopServer(Process process)
    {
        lock (serverProcessLock)
        {
            if (!ReferenceEquals(serverProcess, process))
            {
                return;
            }

            serverProcess = null;
            rpcBridge.Detach();
        }

        try
        {
            if (!process.HasExited)
            {
                process.Kill();
            }
        }
        catch (InvalidOperationException)
        {
        }
        finally
        {
            GSharpLog.Write($"Stopped language-server process {process.Id}.");
            process.Dispose();
        }
    }
}
