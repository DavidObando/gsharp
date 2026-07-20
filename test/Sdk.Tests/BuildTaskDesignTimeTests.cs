// <copyright file="BuildTaskDesignTimeTests.cs" company="GSharp">
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
/// Tests the compiler task's non-executing design-time mode.
/// </summary>
public class BuildTaskDesignTimeTests
{
    /// <summary>
    /// Verifies that design-time builds expose arguments without filesystem or process side effects.
    /// </summary>
    [Fact]
    public void SkipCompilerExecution_ReturnsArgumentsWithoutWritingResponseFile()
    {
        var tempDirectory = Path.Combine(Path.GetTempPath(), "gsharp-design-time-" + Guid.NewGuid().ToString("N"));
        var responseFile = Path.Combine(tempDirectory, "project.rsp");
        var task = new BuildTask
        {
            GsharpCompilerFullPath = Path.Combine(tempDirectory, "missing-gsc.dll"),
            OutputPath = tempDirectory,
            OutputName = "DesignTime",
            TempOutputPath = tempDirectory,
            TargetFramework = "net10.0",
            BasePath = tempDirectory,
            OutputType = "Library",
            Compile = new[] { new TaskItem("Program.gs") },
            References = new[] { new TaskItem("Reference.dll") },
            ResponseFilePath = responseFile,
            SkipCompilerExecution = "true",
            ProvideCommandLineArgs = "true",
        };

        Assert.True(task.Execute());
        Assert.False(File.Exists(responseFile));

        var arguments = task.CommandLineArgs.Select(item => item.ItemSpec).ToArray();
        Assert.Contains("/target:library", arguments);
        Assert.Contains("/targetframework:net10.0", arguments);
        Assert.Contains("/r:Reference.dll", arguments);
        Assert.Contains("Program.gs", arguments);
    }
}
