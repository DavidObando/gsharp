using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;

namespace GSharp.VisualStudio;

internal static class GSharpLog
{
    private static readonly object Gate = new object();
    private static IVsOutputWindowPane? outputPane;

    public static string ClientLogPath { get; } =
        Path.Combine(Path.GetTempPath(), "gsharp-vs-client.log");

    public static string ServerLogPath { get; } =
        Path.Combine(Path.GetTempPath(), "gsharp-vs-server.log");

    public static void Write(string message)
    {
        string line = $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}";
        lock (Gate)
        {
            File.AppendAllText(ClientLogPath, line);
        }

        IVsOutputWindowPane? pane = outputPane;
        if (pane != null)
        {
            ThreadHelper.JoinableTaskFactory.Run(async () =>
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                pane.OutputString(line);
            });
        }
    }

    public static async Task InitializeAsync(
        AsyncPackage package,
        CancellationToken cancellationToken)
    {
        await package.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        var output = await package.GetServiceAsync(typeof(SVsOutputWindow)) as IVsOutputWindow;
        if (output == null)
        {
            return;
        }

        Guid paneGuid = new Guid("98ADAE96-2545-4B54-9C70-732EAF5ABF44");
        ErrorHandler.ThrowOnFailure(output.CreatePane(ref paneGuid, "G#", 1, 1));
        ErrorHandler.ThrowOnFailure(output.GetPane(ref paneGuid, out outputPane));
    }

    public static async Task ShowAsync(AsyncPackage package, CancellationToken cancellationToken)
    {
        await package.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        outputPane?.Activate();
        var shell = await package.GetServiceAsync(typeof(SVsUIShell)) as IVsUIShell;
        if (shell == null)
        {
            return;
        }

        Guid outputWindow = new Guid("34E76E81-EE4A-11D0-AE2E-00A0C90FFFC3");
        ErrorHandler.ThrowOnFailure(shell.FindToolWindow(
            (uint)__VSFINDTOOLWIN.FTW_fForceCreate,
            ref outputWindow,
            out IVsWindowFrame frame));
        ErrorHandler.ThrowOnFailure(frame.Show());
    }
}
