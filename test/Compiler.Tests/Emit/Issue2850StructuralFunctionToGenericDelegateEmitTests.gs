// <copyright file="Issue2850StructuralFunctionToGenericDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2850 — direct calls to generic free functions skipped the conversion
/// from a structural function value to a substituted nominal delegate parameter.
open class Issue2850StructuralFunctionToGenericDelegateEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func StructuralFunctionArgument_AllGenericDeclaringForms_VerifyAndRun(nullable bool) {
        let suffix = if nullable {
            "nullable"
        } else {
            "nonnullable"
        }
        let parameterType = if nullable {
            "Conv[T]?"
        } else {
            "Conv[T]"
        }
        let nilCalls = if nullable {
            `genericJob.Do(Cancel(), nil)
methodJob.Do(Cancel(), nil)
DoStatic(Cancel(), nil)`
        } else {
            string.Empty
        }
        let source = (`package i2850` + "$suffix" + `
import System

interface ICanc { prop IsCancelled bool { get } }

delegate Conv[T ICanc](book int32, ctx T, cb (string) -> void) void;

class Cancel : ICanc { prop IsCancelled bool -> false }

class GenericJob[T ICanc] {
    func Do(ctx T, convertAction ` + "$parameterType" + `) {
        if convertAction != nil {
            convertAction(4, ctx, (s string) -> System.Console.WriteLine("generic-class:" + s))
        }
    }
}

class MethodJob {
    func Do[T ICanc](ctx T, convertAction ` + "$parameterType" + `) {
        if convertAction != nil {
            convertAction(4, ctx, (s string) -> System.Console.WriteLine("generic-method:" + s))
        }
    }
}

func DoStatic[T ICanc](ctx T, convertAction ` + "$parameterType" + `) {
    if convertAction != nil {
        convertAction(4, ctx, (s string) -> System.Console.WriteLine("static-function:" + s))
    }
}

func Main() {
    let genericJob = GenericJob[Cancel]()
    let methodJob = MethodJob()
    let ca ((int32, Cancel, (string) -> void) -> void) =
        (book int32, ctx Cancel, onState (string) -> void) -> {
            onState("` + "$suffix" + `")
        }
    genericJob.Do(Cancel(), ca)
    methodJob.Do(Cancel(), ca)
    DoStatic(Cancel(), ca)
    ` + "$nilCalls" + `
    System.Console.WriteLine("done")
}`)
        Assert.Equal(
            "generic-class:" +
                suffix +
                Environment.NewLine +
                "generic-method:" +
                suffix +
                Environment.NewLine +
                "static-function:" +
                suffix +
                Environment.NewLine +
                "done${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func GenericFreeFunction_ForwardsOpenStructuralFunctionToOpenNamedDelegate_VerifiesAndRuns() {
        const source = `package i2850forward
import System

interface ICanc { prop IsCancelled bool { get } }

delegate Conv[T ICanc](book int32, ctx T, cb (string) -> void) void;

class Cancel : ICanc { prop IsCancelled bool -> false }

func Inner[T ICanc](ctx T, convertAction Conv[T]?) {
    if convertAction != nil {
        convertAction(4, ctx, (s string) -> System.Console.WriteLine("inner:" + s))
    }
}

func Outer[T ICanc](ctx T, f ((int32, T, (string) -> void) -> void)) {
    Inner(ctx, f)
}

func Main() {
    let f ((int32, Cancel, (string) -> void) -> void) =
        (book int32, ctx Cancel, onState (string) -> void) -> {
            onState("fwd")
        }
    Outer(Cancel(), f)
    System.Console.WriteLine("done")
}`
        Assert.Equal("inner:fwd${Environment.NewLine}done${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NullableStructuralFunction_ToNonNullableGenericNamedDelegate_ReportsGS0155() {
        const source = `package i2850nullabletononnullable
import System

interface ICanc { prop IsCancelled bool { get } }

delegate Conv[T ICanc](book int32, ctx T, cb (string) -> void) void;

class Cancel : ICanc { prop IsCancelled bool -> false }

func Do[T ICanc](ctx T, convertAction Conv[T]) {
}

func Main() {
    var ca ((int32, Cancel, (string) -> void) -> void)? = nil
    Do(Cancel(), ca)
}`
        let diagnostics = CompileExpectingFailure(source)
        Assert.Contains("GS0155", diagnostics, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", diagnostics, StringComparison.Ordinal)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2850_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                Compile([]string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath})
                IlVerifier.Verify(dllPath)
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
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func Compile(args[]string) {
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
        }

        private func CompileExpectingFailure(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2850_error_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                let diagnostics = stdoutWriter.ToString() + stderrWriter.ToString()
                Assert.True(compileExit != 0, (`expected gsc to reject nullable structural function to non-nullable delegate:
` + "$diagnostics"))
                return diagnostics
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
