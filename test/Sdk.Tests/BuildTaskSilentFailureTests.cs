// <copyright file="BuildTaskSilentFailureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using Gsharp.NET.Sdk.Tools;
using Microsoft.Build.Framework;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// 6.2 SilentEmitFailure invariant (boundary ring): verifies that the real
/// BuildTask parser logs both source-anchored and location-less GS9998 output
/// as structured MSBuild errors.
///
/// <para>
/// Located output carries the source file and span. Location-less output keeps
/// the compiler's error code and root-cause message without inventing a file or
/// coordinates, and still sets <see cref="Microsoft.Build.Utilities.TaskLoggingHelper.HasLoggedErrors"/>.
/// </para>
/// </summary>
public class BuildTaskSilentFailureTests
{
    [Fact]
    public void LogCompilerLine_LocatedGS9998_LogsStructuredErrorWithSourceSpan()
    {
        var (task, engine) = CreateTask();
        var line = "/path/to/test.gs(9,5,11,1): error GS9998: InvalidOperationException: test message";

        task.LogCompilerLine(line);

        var error = Assert.Single(engine.Errors);
        Assert.True(task.Log.HasLoggedErrors);
        Assert.Equal("GS9998", error.Code);
        Assert.Equal("/path/to/test.gs", error.File);
        Assert.Equal(9, error.LineNumber);
        Assert.Equal(5, error.ColumnNumber);
        Assert.Equal(11, error.EndLineNumber);
        Assert.Equal(1, error.EndColumnNumber);
        Assert.Equal("InvalidOperationException: test message", error.Message);
    }

    [Fact]
    public void LogCompilerLine_LocationlessGS9998_LogsStructuredErrorWithoutInventedSpan()
    {
        var (task, engine) = CreateTask();
        var line = "error GS9998: InvalidOperationException: no source location";

        task.LogCompilerLine(line);

        var error = Assert.Single(engine.Errors);
        Assert.True(task.Log.HasLoggedErrors);
        Assert.Equal("GS9998", error.Code);
        Assert.True(string.IsNullOrEmpty(error.File));
        Assert.Equal(0, error.LineNumber);
        Assert.Equal(0, error.ColumnNumber);
        Assert.Equal("InvalidOperationException: no source location", error.Message);
        Assert.DoesNotContain("(1,1,1,1)", error.ToString());
    }

    private static (BuildTask Task, RecordingBuildEngine Engine) CreateTask()
    {
        var engine = new RecordingBuildEngine();
        return (new BuildTask { BuildEngine = engine }, engine);
    }

    private sealed class RecordingBuildEngine : IBuildEngine
    {
        public List<BuildErrorEventArgs> Errors { get; } = new();

        public bool ContinueOnError => false;

        public int LineNumberOfTaskNode => 0;

        public int ColumnNumberOfTaskNode => 0;

        public string ProjectFileOfTaskNode => string.Empty;

        public bool BuildProjectFile(
            string projectFileName,
            string[] targetNames,
            System.Collections.IDictionary globalProperties,
            System.Collections.IDictionary targetOutputs) => true;

        public void LogCustomEvent(CustomBuildEventArgs e)
        {
        }

        public void LogErrorEvent(BuildErrorEventArgs e) => Errors.Add(e);

        public void LogMessageEvent(BuildMessageEventArgs e)
        {
        }

        public void LogWarningEvent(BuildWarningEventArgs e)
        {
        }
    }
}
