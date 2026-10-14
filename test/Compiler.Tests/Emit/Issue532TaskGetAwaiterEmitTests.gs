// <copyright file="Issue532TaskGetAwaiterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #532: `Task<T>.GetAwaiter()` was rejected as ambiguous (GS0160)
/// between the inherited `Task.GetAwaiter()` and `Task<T>.GetAwaiter()`.
/// Resolved as a side effect of #530's most-derived-declaring-type filter (Phase 2d)
/// in overload resolution. These tests lock in the fix as regression coverage.
open class Issue532TaskGetAwaiterEmitTests {
    @Fact
    func GetAwaiter_GetResult_On_Task_Of_Int_Returns_Value() {
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.FromResult(42)
let r = t.GetAwaiter().GetResult()
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func GetAwaiter_GetResult_On_Task_Of_String_Returns_Value() {
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.FromResult("hi")
let r = t.GetAwaiter().GetResult()
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    @Fact
    func GetAwaiter_IsCompleted_On_Task_Of_String_Returns_True() {
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.FromResult("hi")
let awaiter = t.GetAwaiter()
let c = awaiter.IsCompleted
Console.WriteLine(c)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func GetAwaiter_GetResult_On_NonGeneric_Task_Succeeds() {
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.CompletedTask
t.GetAwaiter().GetResult()
Console.WriteLine("ok")`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}", output)
    }

    @Fact
    func GetAwaiter_GetResult_On_Explicit_Task_Of_Int_Parameter() {
        let source = `package P

import System
import System.Threading.Tasks

func run(t Task[int32]) int32 {
    return t.GetAwaiter().GetResult()
}

let result = run(Task.FromResult(99))
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func Assert_Equal_Still_Works_Regression_Guard() {
        // Regression guard for issue #505 — Assert.Equal ambiguity must not regress.
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.FromResult(42)
let r = t.GetAwaiter().GetResult()
if r == 42 {
    Console.WriteLine("pass")
} else {
    Console.WriteLine("fail")
}`
        let output = CompileAndRun(source)
        Assert.Equal("pass${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_532_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
