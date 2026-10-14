// <copyright file="Adr0169GsAnalyzerForwardingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import Gsharp.NET.Sdk.Tools
import Microsoft.Build.Framework
import Microsoft.Build.Utilities
import System
import System.IO
import System.Linq
import Xunit

/// ADR-0169: the SDK forwards @(GsharpCodeAnalyzer) items to gsc as
/// `/gsanalyzer:` arguments via (cref:BuildTask.GsAnalyzers).
open class Adr0169GsAnalyzerForwardingTests {
    @Fact
    func GsAnalyzers_ForwardAsGsAnalyzerArguments() {
        let task = BuildTask{
            GsharpCompilerFullPath: "missing-gsc.dll",
            OutputPath: ".",
            OutputName: "AnalyzerForwarding",
            TempOutputPath: ".",
            TargetFramework: "net10.0",
            BasePath: ".",
            OutputType: "Library",
            Compile: cast[[]ITaskItem]([]TaskItem{TaskItem("Program.gs")}),
            References: cast[[]ITaskItem](Array.Empty[TaskItem]()),
            GsAnalyzers: cast[[]ITaskItem]([]TaskItem{TaskItem("MyAnalyzers.dll")}),
            ResponseFilePath: Path.Combine(
                Path.GetTempPath(),
                "gsharp-analyzer-forwarding-" + Guid.NewGuid().ToString("N") + ".rsp"
            ),
            SkipCompilerExecution: "true",
            ProvideCommandLineArgs: "true"
        }
        Assert.True(task.Execute())
        let arguments = task.CommandLineArgs.Select((item ITaskItem) -> item.ItemSpec!!).ToArray()
        Assert.Contains("/gsanalyzer:MyAnalyzers.dll", arguments)
    }

    @Fact
    func CoreCompileTarget_PassesGsharpCodeAnalyzerItems() {
        let targetsPath = Path.Combine(
            RepoRoot.Path,
            "src",
            "Sdk",
            "Gsharp.NET.Sdk",
            "build",
            "Gsharp.NET.Core.Sdk.targets"
        )
        let targets = File.ReadAllText(targetsPath)
        Assert.Contains("GsAnalyzers=\"@(GsharpCodeAnalyzer)\"", targets, StringComparison.Ordinal)
        Assert.Contains("@(GsharpCodeAnalyzer);", targets, StringComparison.Ordinal)
    }
}
