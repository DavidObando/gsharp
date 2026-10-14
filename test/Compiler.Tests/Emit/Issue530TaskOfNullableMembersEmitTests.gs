// <copyright file="Issue530TaskOfNullableMembersEmitTests.cs" company="GSharp">
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

/// Issue #530: `Task<T?>.Result` (and other members like
/// `.GetAwaiter()`) fail to bind when the type argument is nullable.
/// These tests exercise both nullable reference types (`string?`) and
/// nullable value types (`int32?`), plus a non-nullable regression guard.
open class Issue530TaskOfNullableMembersEmitTests {
    @Fact
    func Result_On_Task_Of_NullableString_Returns_Value() {
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.FromResult[string?]("hi")
let r = t.Result
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    @Fact
    func GetAwaiter_On_Task_Of_NullableString_Returns_Value() {
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.FromResult[string?]("hello")
let awaiter = t.GetAwaiter()
let r = awaiter.GetResult()
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func Result_On_Task_Of_NullableInt32_Returns_Value() {
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.FromResult[int32?](42)
let r = t.Result
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Await_Task_Of_NullableString_Returns_Value() {
        let source = `package P

import System
import System.Threading.Tasks

async func getVal() string? {
    let t = Task.FromResult[string?]("awaited")
    return await t
}

let r = getVal().Result
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("awaited${Environment.NewLine}", output)
    }

    @Fact
    func Await_Task_Of_NullableInt32_Returns_Value() {
        let source = `package P

import System
import System.Threading.Tasks

async func getVal() int32? {
    let t = Task.FromResult[int32?](99)
    return await t
}

let r = getVal().Result
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func Result_On_Task_Of_NonNullableString_Regression() {
        // Non-nullable T regression guard — must still work.
        let source = `package P

import System
import System.Threading.Tasks

let t = Task.FromResult[string]("world")
let r = t.Result
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("world${Environment.NewLine}", output)
    }

    @Fact
    func ConfigureAwait_On_Task_Of_NullableString() {
        let source = `package P

import System
import System.Threading.Tasks

async func getVal() string? {
    let t = Task.FromResult[string?]("configured")
    return await t.ConfigureAwait(false)
}

let r = getVal().Result
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("configured${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string, expectSuccess bool)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_530_").FullName
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
