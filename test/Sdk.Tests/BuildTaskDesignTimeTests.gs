// <copyright file="BuildTaskDesignTimeTests.cs" company="GSharp">
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

/// Tests the compiler task's non-executing design-time mode.
open class BuildTaskDesignTimeTests {
    /// Verifies that design-time builds expose arguments without filesystem or process side effects.
    @Fact
    func SkipCompilerExecution_ReturnsArgumentsWithoutWritingResponseFile() {
        let tempDirectory = Path.Combine(Path.GetTempPath(), "gsharp-design-time-" + Guid.NewGuid().ToString("N"))
        let responseFile = Path.Combine(tempDirectory, "project.rsp")
        let task = BuildTask{
            GsharpCompilerFullPath: Path.Combine(tempDirectory, "missing-gsc.dll"),
            OutputPath: tempDirectory,
            OutputName: "DesignTime",
            TempOutputPath: tempDirectory,
            TargetFramework: "net10.0",
            BasePath: tempDirectory,
            OutputType: "Library",
            Compile: cast[[]ITaskItem]([]TaskItem{TaskItem("Program.gs")}),
            References: cast[[]ITaskItem]([]TaskItem{TaskItem("Reference.dll")}),
            ResponseFilePath: responseFile,
            SkipCompilerExecution: "true",
            ProvideCommandLineArgs: "true"
        }
        Assert.True(task.Execute())
        Assert.False(File.Exists(responseFile))
        let arguments = task.CommandLineArgs.Select((item ITaskItem) -> item.ItemSpec!!).ToArray()
        Assert.Contains("/target:library", arguments)
        Assert.Contains("/targetframework:net10.0", arguments)
        Assert.Contains("/optimize+", arguments)
        Assert.Contains("/r:Reference.dll", arguments)
        Assert.Contains("Program.gs", arguments)
    }

    @Theory
    @InlineData("true", "/optimize+")
    @InlineData("false", "/optimize-")
    func Optimization_ForwardsCompilerFlag(optimization string, expectedArgument string) {
        let task = BuildTask{
            GsharpCompilerFullPath: "missing-gsc.dll",
            OutputPath: ".",
            OutputName: "Issue2920",
            TempOutputPath: ".",
            TargetFramework: "net10.0",
            BasePath: ".",
            OutputType: "Library",
            Optimization: optimization,
            Compile: cast[[]ITaskItem]([]TaskItem{TaskItem("Program.gs")}),
            References: cast[[]ITaskItem](Array.Empty[TaskItem]()),
            ResponseFilePath: "issue2920.rsp",
            SkipCompilerExecution: "true",
            ProvideCommandLineArgs: "true"
        }
        Assert.True(task.Execute())
        Assert.Contains(task.CommandLineArgs, (item ITaskItem) -> item.ItemSpec == expectedArgument)
    }

    @Fact
    func ResxLogicalName_GetsResourcesSuffix() {
        let resource = TaskItem("Resources.resources")
        resource.SetMetadata("LogicalName", "Demo.Properties.Resources")
        resource.SetMetadata("Type", "Resx")
        let task = BuildTask{
            GsharpCompilerFullPath: "missing-gsc.dll",
            OutputPath: ".",
            OutputName: "DesignTime",
            TempOutputPath: ".",
            TargetFramework: "net10.0",
            BasePath: ".",
            OutputType: "Library",
            Compile: cast[[]ITaskItem]([]TaskItem{TaskItem("Program.gs")}),
            References: cast[[]ITaskItem](Array.Empty[TaskItem]()),
            Resources: cast[[]ITaskItem]([]TaskItem{resource}),
            ResponseFilePath: "project.rsp",
            SkipCompilerExecution: "true",
            ProvideCommandLineArgs: "true"
        }
        Assert.True(task.Execute())
        Assert.Contains(
            task.CommandLineArgs,
            (item ITaskItem) -> item.ItemSpec.Contains("Demo.Properties.Resources.resources", StringComparison.Ordinal)
        )
    }
}
