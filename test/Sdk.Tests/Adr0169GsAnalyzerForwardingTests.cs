// <copyright file="Adr0169GsAnalyzerForwardingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Gsharp.NET.Sdk.Tools;
using Microsoft.Build.Utilities;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// ADR-0169: the SDK forwards @(GsharpCodeAnalyzer) items to gsc as
/// <c>/gsanalyzer:</c> arguments via <see cref="BuildTask.GsAnalyzers"/>.
/// </summary>
public class Adr0169GsAnalyzerForwardingTests
{
    [Fact]
    public void GsAnalyzers_ForwardAsGsAnalyzerArguments()
    {
        var task = new BuildTask
        {
            GsharpCompilerFullPath = "missing-gsc.dll",
            OutputPath = ".",
            OutputName = "AnalyzerForwarding",
            TempOutputPath = ".",
            TargetFramework = "net10.0",
            BasePath = ".",
            OutputType = "Library",
            Compile = new[] { new TaskItem("Program.gs") },
            References = Array.Empty<TaskItem>(),
            GsAnalyzers = new[] { new TaskItem("MyAnalyzers.dll") },
            ResponseFilePath = Path.Combine(Path.GetTempPath(), "gsharp-analyzer-forwarding-" + Guid.NewGuid().ToString("N") + ".rsp"),
            SkipCompilerExecution = "true",
            ProvideCommandLineArgs = "true",
        };

        Assert.True(task.Execute());

        var arguments = task.CommandLineArgs.Select(item => item.ItemSpec).ToArray();
        Assert.Contains("/gsanalyzer:MyAnalyzers.dll", arguments);
    }

    [Fact]
    public void CoreCompileTarget_PassesGsharpCodeAnalyzerItems()
    {
        var targetsPath = Path.Combine(
            RepoRoot.Path,
            "src", "Sdk", "Gsharp.NET.Sdk", "build", "Gsharp.NET.Core.Sdk.targets");
        var targets = File.ReadAllText(targetsPath);

        Assert.Contains("GsAnalyzers=\"@(GsharpCodeAnalyzer)\"", targets, StringComparison.Ordinal);
        Assert.Contains("@(GsharpCodeAnalyzer);", targets, StringComparison.Ordinal);
    }
}
