// <copyright file="Issue662ValueTaskGetResultWarningEmitTests.cs" company="GSharp">
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

/// Issue #662: end-to-end emit test asserting that the compiler produces
/// warning GS0275 when `.GetAwaiter().GetResult()` is called directly
/// on a `ValueTask`/`ValueTask<T>`.
open class Issue662ValueTaskGetResultWarningEmitTests {
    @Fact
    func Compiler_Emits_GS0275_Warning_For_ValueTask_GetResult() {
        let source = `package P

import System
import System.Threading.Tasks

let vt = ValueTask[bool](true)
let r = vt.GetAwaiter().GetResult()
Console.WriteLine(r)`
        let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
        Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
        Assert.Equal("True${Environment.NewLine}", stdout)
    }

    @Fact
    func Compiler_Output_Contains_GS0275_Warning_Text() {
        let source = `package P

import System
import System.Threading.Tasks

let vt = ValueTask[bool](true)
let r = vt.GetAwaiter().GetResult()
Console.WriteLine(r)`
        let compilerOutput = CompileOnly(source)
        Assert.Contains("GS0275", compilerOutput)
        Assert.Contains("warning", compilerOutput)
        Assert.Contains("AsTask", compilerOutput)
    }

    @Fact
    func Compiler_Does_Not_Emit_GS0275_For_AsTask_Pattern() {
        let source = `package P

import System
import System.Threading.Tasks

let vt = ValueTask[bool](true)
let r = vt.AsTask().GetAwaiter().GetResult()
Console.WriteLine(r)`
        let compilerOutput = CompileOnly(source)
        Assert.DoesNotContain("GS0275", compilerOutput)
    }

    @Fact
    func Compiler_Does_Not_Emit_GS0275_For_Task_GetResult() {
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.FromResult(42)
let r = t.GetAwaiter().GetResult()
Console.WriteLine(r)`
        let compilerOutput = CompileOnly(source)
        Assert.DoesNotContain("GS0275", compilerOutput)
    }

    shared {
        /// Compiles and runs the given source; returns exit code + output.
        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_662_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = BuildCompilerArgs(outPath, srcPath)
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
                // GS0275 is a warning, so compilation should succeed.
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

        /// Compiles only (no run), captures compiler stdout which includes diagnostics.
        private func CompileOnly(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_662c_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = BuildCompilerArgs(outPath, srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                try {
                    Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                return compileOut.ToString()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func BuildCompilerArgs(outPath string, srcPath string) List[string] {
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
            for bcl in BclReferences.Value {
                args.Add("/r:" + bcl)
            }
            args.Add(srcPath)
            return args
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
