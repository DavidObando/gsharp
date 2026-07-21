using System;
using System.ComponentModel.Composition;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Language.CodeLens;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.TextManager.Interop;
using StreamJsonRpc;

namespace GSharp.VisualStudio;

[Export(typeof(ICodeLensCallbackListener))]
internal sealed class GSharpCodeLensCallbackListener : ICodeLensCallbackListener
{
    internal const string ShowReferencesMethod = "GSharp.CodeLens.ShowReferences";

    [JsonRpcMethod(ShowReferencesMethod)]
    public async Task ShowReferencesAsync(
        string filePath,
        int line,
        int character,
        CancellationToken cancellationToken)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        VsShellUtilities.OpenDocument(
            ServiceProvider.GlobalProvider,
            filePath,
            Guid.Empty,
            out _,
            out _,
            out IVsWindowFrame frame,
            out IVsTextView view);
        ErrorHandler.ThrowOnFailure(frame.Show());
        ErrorHandler.ThrowOnFailure(view.SetCaretPos(line, character));

        var shell = ServiceProvider.GlobalProvider.GetService(typeof(SVsUIShell)) as IVsUIShell
            ?? throw new InvalidOperationException("Visual Studio shell service is unavailable.");
        Guid commandSet = VSConstants.GUID_VSStandardCommandSet97;
        ErrorHandler.ThrowOnFailure(shell.PostExecCommand(
            ref commandSet,
            (uint)VSConstants.VSStd97CmdID.FindReferences,
            0,
            null));
    }
}
