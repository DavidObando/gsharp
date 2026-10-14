// <copyright file="Issue4262NullableDelegateArgumentRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Diagnostics
import System.IO
import Xunit

/// Runtime-behavior regression for cs2gs issue #4262: a nullable-ENABLED
/// consumer project calling into a nullable-OBLIVIOUS sibling project it
/// references was getting a spurious `!!` on an intentionally-nullable
/// delegate ARGUMENT (see
/// `Cs2Gs.Tests.Issue4262CrossProjectObliviousDelegateArgumentTests` for
/// the translator-level fix and regression). These tests exercise the exact
/// runtime mechanism at stake — G#'s `!!` is not erased like C#'s
/// `!`, it is a real THROW-ON-NIL check — to confirm the fix's shape
/// (a bare, un-asserted delegate argument) genuinely runs to completion on a
/// legitimate `nil`, and that the bug's shape (the spurious `!!`)
/// genuinely crashes, not merely that either one compiles.
open class Issue4262NullableDelegateArgumentRuntimeTests {
    @Fact
    func BareNullableDelegateArgument_NilFlowsThrough_RunsToCompletion() {
        // The FIXED cs2gs shape: the nullable local is passed bare into the
        // nullable-declared parameter, exactly as `TranslateArgumentValue`
        // now emits for a cross-project oblivious target proven to accept
        // nil. Must run to completion — the whole point of the fix is that
        // this legitimate nil no longer throws.
        let stdout = CompileAndRun(ProgramSource.Replace("__ARG__", "convertAction"), "issue4262bare")
        Assert.Equal("ok${Environment.NewLine}", stdout)
    }

    @Fact
    func AssertedNullableDelegateArgument_NilFlowsThrough_ThrowsAtRuntime() {
        // Precision guard / severity proof: `!!` is a REAL runtime throw in
        // G# (unlike C#'s erased `!`), so the BUG's shape — the spurious
        // `!!` cs2gs used to emit here — genuinely crashes on the exact
        // legitimate nil the source passed, confirming this was a runtime
        // correctness bug and not a cosmetic one.
        CompileAndRunExpectingCrash(
            ProgramSource.Replace("__ARG__", "convertAction!!"),
            "issue4262asserted",
            "NullReferenceException"
        )
    }

    shared {
        private const ProgramSource string = `package Issue4262Repro
import System

delegate ConvertDelegate(ctx int32);

func Invoke(ctx int32, convertAction ConvertDelegate?) {
    if convertAction != nil {
        convertAction(ctx)
    }
}

func Main() {
    var convertAction ConvertDelegate? = nil
    Invoke(1, __ARG__)
    Console.WriteLine("ok")
}`

        private func CompileAndRun(source string, testName string) string {
            let (exitCode, stdout, stderr) = CompileAndExecute(source, testName)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunExpectingCrash(source string, testName string, expectedInStderr string) {
            let (exitCode, stdout, stderr) = CompileAndExecute(source, testName)
            Assert.True(exitCode != 0, (`expected a runtime crash but exited 0
stdout:
` + "$stdout"))
            Assert.Contains(expectedInStderr, stderr)
        }

        private func CompileAndExecute(source string, testName string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4262_" + testName + "_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                return (proc.ExitCode, stdout, stderr)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) {
                    // Best-effort cleanup; a concurrent agent sharing /tmp may
                    // still hold a handle.

                }
            }
        }
    }
}
