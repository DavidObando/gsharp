[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [int]$VisualStudioProcessId,

    [int]$TimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

    public static void TerminateAll(object dte)
    {
        Dte(dte).Debugger.TerminateAll();
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

$dte = [RunningVisualStudio]::GetDte($VisualStudioProcessId)
$webProcess = $null
try {
Wait-Until { $dte.Solution.IsOpen -and $dte.Solution.Projects.Count -eq 4 } 'the fixture solution'
if ([RunningVisualStudio]::GetDebuggerMode($dte) -ne 1) {
    [RunningVisualStudio]::TerminateAll($dte)
    Wait-Until { [RunningVisualStudio]::GetDebuggerMode($dte) -eq 1 } 'the previous debugger session to stop'
}

$consoleProjectUniqueName = [RunningVisualStudio]::SetStartupProject($dte, 'Console')
$existingConsoleIds = @(Get-Process -Name Console -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Id)
$dte.ExecuteCommand('Debug.StartWithoutDebugging')
Wait-Until {
    @(Get-Process -Name Console -ErrorAction SilentlyContinue |
        Where-Object Id -notin $existingConsoleIds).Count -gt 0
} 'Start Without Debugging to launch Console'

$source = Join-Path $PSScriptRoot 'Console\Program.gs'
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
[RunningVisualStudio]::TerminateAll($dte)
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

[RunningVisualStudio]::TerminateAll($dte)
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

[RunningVisualStudio]::TerminateAll($dte)
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
