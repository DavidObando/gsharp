using System;
using System.ComponentModel.Design;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Shell;

namespace GSharp.VisualStudio;

internal static class GSharpCommands
{
    public static readonly Guid CommandSet = new Guid("D157AC8A-6B90-4C67-9BD6-CB4A59C44F13");

    public static async Task InitializeAsync(
        AsyncPackage package,
        CancellationToken cancellationToken)
    {
        await package.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        var commandService = await package.GetServiceAsync(typeof(IMenuCommandService))
            as OleMenuCommandService;
        if (commandService == null)
        {
            return;
        }

        commandService.AddCommand(new MenuCommand(
            (_, _) => package.JoinableTaskFactory.Run(
                () => GSharpLanguageClient.Current?.RestartAsync() ?? Task.CompletedTask),
            new CommandID(CommandSet, 0x0100)));
        commandService.AddCommand(new MenuCommand(
            (_, _) => package.JoinableTaskFactory.Run(
                () => GSharpLog.ShowAsync(package, CancellationToken.None)),
            new CommandID(CommandSet, 0x0101)));
        commandService.AddCommand(new MenuCommand(
            (_, _) => Process.Start(new ProcessStartInfo(
                "https://github.com/DavidObando/gsharp/issues/new")
            {
                UseShellExecute = true,
            }),
            new CommandID(CommandSet, 0x0102)));
    }
}
