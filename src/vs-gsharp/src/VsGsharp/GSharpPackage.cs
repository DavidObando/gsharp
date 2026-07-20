using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using EnvDTE;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;

namespace GSharp.VisualStudio;

[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
[ProvideOptionPage(typeof(GSharpOptions), "G#", "Language Server", 0, 0, true)]
[ProvideAutoLoad(VSConstants.UICONTEXT.ShellInitialized_string, PackageAutoLoadFlags.BackgroundLoad)]
[ProvideMenuResource("Menus.ctmenu", 1)]
[Guid(PackageGuidString)]
public sealed class GSharpPackage : AsyncPackage
{
    public const string PackageGuidString = "8B9C259A-CBF6-4E6B-941E-5566D7FB5156";

    internal static GSharpOptions Options { get; private set; } = new GSharpOptions();

    private static GSharpPackage? Instance { get; set; }

    protected override async Task InitializeAsync(
        CancellationToken cancellationToken,
        IProgress<ServiceProgressData> progress)
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        Instance = this;
        Options = (GSharpOptions)GetDialogPage(typeof(GSharpOptions));
        await GSharpLog.InitializeAsync(this, cancellationToken);
        await GSharpCommands.InitializeAsync(this, cancellationToken);
        GSharpLog.Write("Visual Studio package initialized.");
    }

    internal static async Task ShowStatusAsync(
        string state,
        bool includeActiveProject,
        CancellationToken cancellationToken)
    {
        GSharpPackage? package = Instance;
        if (package == null)
        {
            return;
        }

        object? statusbarService = await package.GetServiceAsync(typeof(SVsStatusbar));
        object? dteService = includeActiveProject
            ? await package.GetServiceAsync(typeof(SDTE))
            : null;
        await package.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);

        string? projectName = null;
        if (dteService is DTE dte &&
            dte.ActiveSolutionProjects is Array projects &&
            projects.Length > 0 &&
            projects.GetValue(0) is Project project)
        {
            projectName = project.Name;
        }

        if (statusbarService is IVsStatusbar statusbar)
        {
            statusbar.SetText(LanguageClientPolicy.StatusText(state, projectName));
        }
    }
}
