// <copyright file="BuildTaskSilentFailureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import Gsharp.NET.Sdk.Tools
import Microsoft.Build.Framework
import System.Collections
import System.Collections.Generic
import Xunit

/// 6.2 SilentEmitFailure invariant (boundary ring): verifies that the real
/// BuildTask parser logs both source-anchored and location-less GS9998 output
/// as structured MSBuild errors.
///
/// Located output carries the source file and span. Location-less output keeps
/// the compiler's error code and root-cause message without inventing a file or
/// coordinates, and still sets (cref:Microsoft.Build.Utilities.TaskLoggingHelper.HasLoggedErrors).
open class BuildTaskSilentFailureTests {
    @Fact
    func LogCompilerLine_LocatedGS9998_LogsStructuredErrorWithSourceSpan() {
        let (task, engine) = CreateTask()
        let line = "/path/to/test.gs(9,5,11,1): error GS9998: InvalidOperationException: test message"
        task.LogCompilerLine(line)
        let error = Assert.Single(engine.Errors)
        Assert.True(task.Log.HasLoggedErrors)
        Assert.Equal("GS9998", error.Code)
        Assert.Equal("/path/to/test.gs", error.File)
        Assert.Equal(9, error.LineNumber)
        Assert.Equal(5, error.ColumnNumber)
        Assert.Equal(11, error.EndLineNumber)
        Assert.Equal(1, error.EndColumnNumber)
        Assert.Equal("InvalidOperationException: test message", error.Message)
    }

    @Fact
    func LogCompilerLine_LocationlessGS9998_LogsStructuredErrorWithoutInventedSpan() {
        let (task, engine) = CreateTask()
        let line = "error GS9998: InvalidOperationException: no source location"
        task.LogCompilerLine(line)
        let error = Assert.Single(engine.Errors)
        Assert.True(task.Log.HasLoggedErrors)
        Assert.Equal("GS9998", error.Code)
        Assert.True(string.IsNullOrEmpty(error.File))
        Assert.Equal(0, error.LineNumber)
        Assert.Equal(0, error.ColumnNumber)
        Assert.Equal("InvalidOperationException: no source location", error.Message)
        Assert.DoesNotContain("(1,1,1,1)", error.ToString())
    }

    @Theory
    @InlineData("error handling failed: retrying")
    @InlineData("warning signs detected: check config")
    @InlineData("info about the build: nothing to do")
    func LogCompilerLine_ProseIsNotClassifiedAsDiagnostic(line string) {
        let (task, engine) = CreateTask()
        task.LogCompilerLine(line)
        Assert.Empty(engine.Errors)
        Assert.Empty(engine.Warnings)
        let message = Assert.Single(engine.Messages)
        Assert.Equal(line, message.Message)
        Assert.Equal(MessageImportance.Low, message.Importance)
    }

    @Fact
    func LogCompilerLine_WarningIsNotPromotedToError() {
        let (task, engine) = CreateTask()
        task.LogCompilerLine("warning GS0001: test warning")
        Assert.Empty(engine.Errors)
        let warning = Assert.Single(engine.Warnings)
        Assert.Equal("GS0001", warning.Code)
        Assert.Equal("test warning", warning.Message)
    }

    @Fact
    func LogCompilerLine_GS9100RemainsLowImportanceMessage() {
        let (task, engine) = CreateTask()
        let line = "warning GS9100: advisory warning"
        task.LogCompilerLine(line)
        Assert.Empty(engine.Errors)
        Assert.Empty(engine.Warnings)
        let message = Assert.Single(engine.Messages)
        Assert.Equal(line, message.Message)
        Assert.Equal(MessageImportance.Low, message.Importance)
    }

    private class RecordingBuildEngine : IBuildEngine {
        init() {
            Errors = List[BuildErrorEventArgs]()
            Warnings = List[BuildWarningEventArgs]()
            Messages = List[BuildMessageEventArgs]()
        }

        prop Errors List[BuildErrorEventArgs] {
            get;
        }

        prop Warnings List[BuildWarningEventArgs] {
            get;
        }

        prop Messages List[BuildMessageEventArgs] {
            get;
        }

        prop ContinueOnError bool -> false
        prop LineNumberOfTaskNode int32 -> 0
        prop ColumnNumberOfTaskNode int32 -> 0
        prop ProjectFileOfTaskNode string -> string.Empty

        func BuildProjectFile(
            projectFileName string,
            targetNames[]string,
            globalProperties IDictionary,
            targetOutputs IDictionary
        ) bool -> true

        func LogCustomEvent(e CustomBuildEventArgs) { }

        func LogErrorEvent(e BuildErrorEventArgs) -> Errors.Add(e)

        func LogMessageEvent(e BuildMessageEventArgs) -> Messages.Add(e)

        func LogWarningEvent(e BuildWarningEventArgs) -> Warnings.Add(e)
    }

    shared {
        private func CreateTask()(Task BuildTask, Engine RecordingBuildEngine) {
            let engine = RecordingBuildEngine()
            return (BuildTask{BuildEngine: engine}, engine)
        }
    }
}
