[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [int]$VisualStudioProcessId,

    [int]$TimeoutSeconds = 60,

    [string]$ProtocolTracePath = (Join-Path $PSScriptRoot '..\artifacts\vs2026-lsp-protocol.log')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -eq 'Core') {
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -NoLogo `
        -NoProfile `
        -ExecutionPolicy Bypass `
        -File $PSCommandPath `
        -VisualStudioProcessId $VisualStudioProcessId `
        -TimeoutSeconds $TimeoutSeconds `
        -ProtocolTracePath $ProtocolTracePath
    if ($LASTEXITCODE -ne 0) {
        throw "Debugger validation failed with exit code $LASTEXITCODE."
    }

    return
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installationPath = (& $vswhere -latest -products * -property installationPath).Trim()
$envDtePath = Join-Path $installationPath 'Common7\IDE\PublicAssemblies\EnvDTE.dll'
$interopPath = Join-Path $installationPath 'Common7\IDE\PublicAssemblies\Microsoft.VisualStudio.Interop.dll'
Add-Type -Path $interopPath
Add-Type -Path $envDtePath
Add-Type -ReferencedAssemblies @($envDtePath, $interopPath) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class RunningVisualStudio
{
    [DllImport("ole32.dll")]
    private static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable table);

    [DllImport("ole32.dll")]
    private static extern int CreateBindCtx(int reserved, out IBindCtx context);

    public static EnvDTE.DTE GetDte(int processId)
    {
        IRunningObjectTable table;
        IEnumMoniker enumerator;
        IBindCtx context;
        GetRunningObjectTable(0, out table);
        table.EnumRunning(out enumerator);
        CreateBindCtx(0, out context);
        IMoniker[] monikers = new IMoniker[1];
        while (enumerator.Next(1, monikers, IntPtr.Zero) == 0)
        {
            string name;
            monikers[0].GetDisplayName(context, null, out name);
            if (name.StartsWith("!VisualStudio.DTE.", StringComparison.Ordinal) &&
                name.EndsWith(":" + processId, StringComparison.Ordinal))
            {
                object value;
                table.GetObject(monikers[0], out value);
                return (EnvDTE.DTE)value;
            }
        }

        throw new InvalidOperationException("Visual Studio DTE was not found for PID " + processId + ".");
    }

    public static string SetStartupProject(object dteObject, string projectName)
    {
        EnvDTE.DTE dte = (EnvDTE.DTE)dteObject;
        for (int index = 1; index <= dte.Solution.Projects.Count; index++)
        {
            EnvDTE.Project project = dte.Solution.Projects.Item(index);
            if (project != null && project.Name == projectName)
            {
                dte.Solution.SolutionBuild.StartupProjects = project.UniqueName;
                return project.UniqueName;
            }
        }

        throw new InvalidOperationException(projectName + " was not loaded.");
    }

    private static EnvDTE.DTE Dte(object value)
    {
        return (EnvDTE.DTE)value;
    }

    public static bool IsSolutionLoaded(object dte, int expectedProjectCount)
    {
        EnvDTE.Solution solution = Dte(dte).Solution;
        return solution != null && solution.Projects.Count >= expectedProjectCount;
    }

    public static int GetProjectCount(object dte)
    {
        EnvDTE.Solution solution = Dte(dte).Solution;
        return solution == null ? 0 : solution.Projects.Count;
    }

    public static int BuildSolution(object dte)
    {
        EnvDTE.Solution solution = Dte(dte).Solution;
        EnvDTE.SolutionBuild build = solution.SolutionBuild;
        build.Clean(true);
        System.Threading.Thread.Sleep(2000);
        int failedBuilds = 0;
        foreach (EnvDTE.SolutionContext context in build.ActiveConfiguration.SolutionContexts)
        {
            if (context.ShouldBuild)
            {
                build.BuildProject(
                    context.ConfigurationName,
                    context.ProjectName,
                    true);
                failedBuilds += build.LastBuildInfo;
            }
        }

        return failedBuilds;
    }

    public static string GetBuildContexts(object dte)
    {
        EnvDTE.SolutionConfiguration configuration =
            Dte(dte).Solution.SolutionBuild.ActiveConfiguration;
        var contexts = new System.Text.StringBuilder();
        foreach (EnvDTE.SolutionContext context in configuration.SolutionContexts)
        {
            contexts.AppendLine(
                context.ProjectName + "|" +
                context.ConfigurationName + "|" +
                context.PlatformName + "|build=" +
                context.ShouldBuild);
        }

        return contexts.ToString();
    }

    public static string GetOutputPaneText(object dte, string paneName)
    {
        EnvDTE.OutputWindow output = (EnvDTE.OutputWindow)Dte(dte)
            .Windows.Item(EnvDTE.Constants.vsWindowKindOutput).Object;
        EnvDTE.OutputWindowPane pane = output.OutputWindowPanes.Item(paneName);
        EnvDTE.TextDocument document = (EnvDTE.TextDocument)pane.TextDocument;
        EnvDTE.EditPoint start = document.StartPoint.CreateEditPoint();
        return start.GetText(document.EndPoint);
    }

    public static void DeleteAllBreakpoints(object dte)
    {
        EnvDTE.Breakpoints breakpoints = Dte(dte).Debugger.Breakpoints;
        while (breakpoints.Count > 0)
        {
            breakpoints.Item(1).Delete();
        }
    }

    public static void AddBreakpoint(object dte, string file, int line)
    {
        Dte(dte).Debugger.Breakpoints.Add(
            "",
            file,
            line,
            1,
            "",
            EnvDTE.dbgBreakpointConditionType.dbgBreakpointConditionTypeWhenTrue,
            "",
            "",
            0,
            "",
            0,
            EnvDTE.dbgHitCountType.dbgHitCountTypeNone);
    }

    public static int GetDebuggerMode(object dte)
    {
        return (int)Dte(dte).Debugger.CurrentMode;
    }

    public static string GetExpression(object dte, string expression)
    {
        EnvDTE.Expression value = Dte(dte).Debugger.GetExpression(expression, true, 1000);
        if (!value.IsValidValue)
        {
            throw new InvalidOperationException(expression + " is not a valid debugger expression.");
        }

        return value.Value;
    }

    public static void StepOver(object dte)
    {
        Dte(dte).Debugger.StepOver(true);
    }

    public static void StepInto(object dte)
    {
        Dte(dte).Debugger.StepInto(true);
    }

    public static string GetCurrentFunction(object dte)
    {
        return Dte(dte).Debugger.CurrentStackFrame.FunctionName;
    }

    public static int GetActiveLine(object dteObject)
    {
        EnvDTE.DTE dte = Dte(dteObject);
        EnvDTE.TextSelection selection = (EnvDTE.TextSelection)dte.ActiveDocument.Selection;
        return selection.ActivePoint.Line;
    }

    public static void OpenFileAt(object dteObject, string path, int line, int column)
    {
        EnvDTE.DTE dte = Dte(dteObject);
        EnvDTE.Window window = dte.ItemOperations.OpenFile(path);
        window.Activate();
        EnvDTE.TextSelection selection = (EnvDTE.TextSelection)dte.ActiveDocument.Selection;
        selection.MoveToLineAndOffset(line, column, false);
    }

    public static string GetActiveDocumentPath(object dteObject)
    {
        return Dte(dteObject).ActiveDocument.FullName;
    }

    public static void ExecuteCommand(object dteObject, string command)
    {
        EnvDTE.DTE dte = Dte(dteObject);
        EnvDTE.Command commandInfo = dte.Commands.Item(command);
        if (!commandInfo.IsAvailable)
        {
            throw new InvalidOperationException(command + " is not available.");
        }

        dte.ExecuteCommand(command);
    }

    public static void TerminateAll(object dte)
    {
        Dte(dte).Debugger.TerminateAll();
    }

    public static void Continue(object dte)
    {
        Dte(dte).Debugger.Go(false);
    }

    public static void AttachToProcess(object dteObject, int processId)
    {
        EnvDTE.DTE dte = Dte(dteObject);
        foreach (EnvDTE.Process process in dte.Debugger.LocalProcesses)
        {
            if (process.ProcessID == processId)
            {
                process.Attach();
                return;
            }
        }

        throw new InvalidOperationException("The attach process was not visible to Visual Studio.");
    }

    public static void DetachAll(object dte)
    {
        Dte(dte).Debugger.DetachAll();
    }
}

[ComImport]
[Guid("00000016-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOleMessageFilter
{
    [PreserveSig]
    int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo);

    [PreserveSig]
    int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType);

    [PreserveSig]
    int MessagePending(IntPtr taskCallee, int tickCount, int pendingType);
}

public sealed class OleMessageFilter : IOleMessageFilter
{
    [DllImport("ole32.dll")]
    private static extern int CoRegisterMessageFilter(
        IOleMessageFilter newFilter,
        out IOleMessageFilter oldFilter);

    public static void Register()
    {
        IOleMessageFilter oldFilter;
        CoRegisterMessageFilter(new OleMessageFilter(), out oldFilter);
    }

    public int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo)
    {
        return 0;
    }

    public int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType)
    {
        return rejectType == 2 && tickCount < 60000 ? 100 : -1;
    }

    public int MessagePending(IntPtr taskCallee, int tickCount, int pendingType)
    {
        return 2;
    }
}
'@

function Wait-Until([scriptblock]$Condition, [string]$Description) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            if (& $Condition) {
                return
            }
        }
        catch {
            if ($_.Exception.ToString() -notmatch 'RPC_E_CALL_REJECTED|0x80010001') {
                throw
            }
        }

        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for $Description."
}

function Invoke-ComRetry([scriptblock]$Operation, [string]$Description) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            return & $Operation
        }
        catch {
            if ($_.Exception.ToString() -notmatch 'RPC_E_CALL_REJECTED|0x80010001') {
                throw
            }
        }

        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting to $Description."
}

function Read-SharedText([string]$Path) {
    $stream = [IO.FileStream]::new(
        $Path,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::ReadWrite)
    try {
        $reader = [IO.StreamReader]::new($stream)
        try {
            return $reader.ReadToEnd()
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

[OleMessageFilter]::Register()
$dte = [RunningVisualStudio]::GetDte($VisualStudioProcessId)
$webProcess = $null
try {
Write-Host "DTE project count: $([RunningVisualStudio]::GetProjectCount($dte))"
Wait-Until {
    [RunningVisualStudio]::IsSolutionLoaded($dte, 4)
} 'the fixture solution'
$consoleProjectUniqueName = [RunningVisualStudio]::SetStartupProject($dte, 'Console')
Write-Host "Build contexts:`n$([RunningVisualStudio]::GetBuildContexts($dte))"
$failedBuilds = [RunningVisualStudio]::BuildSolution($dte)
Write-Host "Build output:`n$([RunningVisualStudio]::GetOutputPaneText($dte, 'Build'))"
if ($failedBuilds -ne 0) {
    throw "Visual Studio solution build reported $failedBuilds failed project(s)."
}

$source = Join-Path $PSScriptRoot 'Console\Program.gs'
$definitionSource = Join-Path $PSScriptRoot 'Library\Greeter.gs'
$traceOffset = if (Test-Path -LiteralPath $ProtocolTracePath) {
    (Read-SharedText $ProtocolTracePath).Length
} else {
    0
}
$greeterUse = Select-String -LiteralPath $source -SimpleMatch 'Greeter("debugger")'
$greeterColumn = $greeterUse.Line.IndexOf('Greeter', [StringComparison]::Ordinal) + 1
[RunningVisualStudio]::OpenFileAt($dte, $source, $greeterUse.LineNumber, $greeterColumn)
Wait-Until {
    if (-not (Test-Path -LiteralPath $ProtocolTracePath)) {
        return $false
    }

    $trace = Read-SharedText $ProtocolTracePath
    $trace.Length -gt $traceOffset -and
    $trace.Substring([Math]::Min($traceOffset, $trace.Length)).Contains('textDocument/semanticTokens')
} 'live semantic highlighting'
[RunningVisualStudio]::ExecuteCommand($dte, 'Edit.GoToDefinition')
Wait-Until {
    [string]::Equals(
        [RunningVisualStudio]::GetActiveDocumentPath($dte),
        $definitionSource,
        [StringComparison]::OrdinalIgnoreCase)
} 'Go To Definition to open Greeter.gs'
Wait-Until {
    (Read-SharedText $ProtocolTracePath).Contains('textDocument/definition')
} 'the live definition request'
[RunningVisualStudio]::OpenFileAt($dte, $source, 1, 1)

if ([RunningVisualStudio]::GetDebuggerMode($dte) -ne 1) {
    [RunningVisualStudio]::TerminateAll($dte)
    Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 1 } 'the previous debugger session to stop'
}

$existingConsoleIds = @(Get-Process -Name Console -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Id)
$dte.ExecuteCommand('Debug.StartWithoutDebugging')
Wait-Until {
    @(Get-Process -Name Console -ErrorAction SilentlyContinue |
        Where-Object Id -notin $existingConsoleIds).Count -gt 0
} 'Start Without Debugging to launch Console'

$line = (Select-String -LiteralPath $source -SimpleMatch 'BREAKPOINT:console-locals').LineNumber
[RunningVisualStudio]::DeleteAllBreakpoints($dte)
[RunningVisualStudio]::AddBreakpoint($dte, $source, $line)
$dte.ExecuteCommand('Debug.Start')
Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 2 } 'F5 to bind the G# breakpoint'

$input = [RunningVisualStudio]::GetExpression($dte, 'input')
$result = [RunningVisualStudio]::GetExpression($dte, 'result')
if ($input -ne '20') {
    throw "Unexpected input local: '$input'."
}

if ($result -ne '42') {
    throw "Unexpected result local: '$result'."
}

[RunningVisualStudio]::StepOver($dte)
Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 2 } 'Step Over to complete'
$afterStepOverLine = Invoke-ComRetry {
    [RunningVisualStudio]::GetActiveLine($dte)
} 'read the Step Over source line'
[RunningVisualStudio]::Continue($dte)
Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 1 } 'the first debugger session to stop'
[RunningVisualStudio]::DeleteAllBreakpoints($dte)

$stepIntoLine = (Select-String -LiteralPath $source -SimpleMatch 'BREAKPOINT:step-into').LineNumber
[RunningVisualStudio]::AddBreakpoint($dte, $source, $stepIntoLine)
$dte.ExecuteCommand('Debug.Start')
Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 2 } 'F5 to bind the step-into breakpoint'
[RunningVisualStudio]::StepInto($dte)
Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 2 } 'Step Into to complete'
$afterStepIntoLine = Invoke-ComRetry {
    [RunningVisualStudio]::GetActiveLine($dte)
} 'read the Step Into source line'
$stepIntoFunction = Invoke-ComRetry {
    [RunningVisualStudio]::GetCurrentFunction($dte)
} 'read the Step Into stack frame'
if ($stepIntoFunction -notmatch 'StepTarget') {
    throw "Step Into stopped in '$stepIntoFunction' at line $afterStepIntoLine after Step Over reached line $afterStepOverLine."
}

[RunningVisualStudio]::Continue($dte)
Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 1 } 'the debugger to stop'
[RunningVisualStudio]::DeleteAllBreakpoints($dte)

$exceptionLine = (Select-String -LiteralPath $source -SimpleMatch 'BREAKPOINT:exception').LineNumber
$exceptionCatchLine = (Select-String -LiteralPath $source -SimpleMatch 'BREAKPOINT:catch-handler').LineNumber
[RunningVisualStudio]::AddBreakpoint($dte, $source, $exceptionLine)
$dte.ExecuteCommand('Debug.Start')
Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 2 } 'F5 to bind the exception breakpoint'
$throwFunction = Invoke-ComRetry {
    [RunningVisualStudio]::GetCurrentFunction($dte)
} 'read the exception stack frame'
if ($throwFunction -notmatch 'ParseExpectedException') {
    throw "The exception breakpoint stopped in unexpected function '$throwFunction'."
}

[RunningVisualStudio]::StepOver($dte)
Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 2 } 'the handled exception to reach its catch block'
$actualCatchLine = Invoke-ComRetry {
    [RunningVisualStudio]::GetActiveLine($dte)
} 'read the exception catch source line'
if ($actualCatchLine -ne $exceptionCatchLine) {
    throw "The handled exception stopped at line $actualCatchLine instead of catch line $exceptionCatchLine."
}

[RunningVisualStudio]::Continue($dte)
Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 1 } 'the exception debugger session to stop'
[RunningVisualStudio]::DeleteAllBreakpoints($dte)

$webExe = Join-Path $PSScriptRoot 'Web\bin\Debug\net10.0\Web.exe'
$previousUrls = $env:ASPNETCORE_URLS
try {
    $env:ASPNETCORE_URLS = 'http://127.0.0.1:5118'
    $webProcess = Start-Process -FilePath $webExe -PassThru -WindowStyle Hidden
}
finally {
    $env:ASPNETCORE_URLS = $previousUrls
}

try {
    Wait-Until {
        try {
            (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:5118/').Content -eq
                'gsharp-vs-acceptance'
        }
        catch {
            $false
        }
    } 'the web attach target'
    [RunningVisualStudio]::AttachToProcess($dte, $webProcess.Id)
    Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -ne 1 } 'the managed debugger to attach'
    [RunningVisualStudio]::DetachAll($dte)
    Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 1 } 'the managed debugger to detach'
}
finally {
    if (-not $webProcess.HasExited) {
        Stop-Process -Id $webProcess.Id
    }
}

$validationResult = [pscustomobject]@{
    Solution = $dte.Solution.FullName
    StartupProject = $consoleProjectUniqueName
    Breakpoint = "$source`:$line"
    Input = $input
    Result = $result
    Build = 'passed'
    SemanticHighlighting = 'passed'
    GoToDefinition = 'passed'
    StartWithoutDebugging = 'passed'
    F5 = 'passed'
    StepOver = "passed (line $afterStepOverLine)"
    StepInto = "passed (line $afterStepIntoLine)"
    StepIntoFunction = $stepIntoFunction
    Exception = "passed (line $exceptionLine -> $actualCatchLine)"
    Attach = 'passed'
}
}
finally {
    if ($null -ne $webProcess -and -not $webProcess.HasExited) {
        Stop-Process -Id $webProcess.Id
    }

    try {
        if ([RunningVisualStudio]::GetDebuggerMode($dte) -ne 1) {
            [RunningVisualStudio]::TerminateAll($dte)
        }
    }
    catch {
    }

    try {
        [RunningVisualStudio]::DeleteAllBreakpoints($dte)
    }
    catch {
    }
}

$validationResult
