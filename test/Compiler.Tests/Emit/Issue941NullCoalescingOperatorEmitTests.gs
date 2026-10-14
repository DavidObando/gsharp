// <copyright file="Issue941NullCoalescingOperatorEmitTests.cs" company="GSharp">
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

/// Issue #941: the binary null-coalescing operator `a ?? b` (replacing the
/// removed `?:` spelling). Evaluates `a`; if non-nil yields `a`,
/// otherwise evaluates and yields `b`. The right operand is evaluated
/// lazily, `??` is right-associative and binds lower than `||`, and the
/// removed `?:` spelling is now a parse error (GS0005).
///
/// Each test compiles via `gsc`, IL-verifies the produced PE, then executes
/// it under `dotnet exec` and asserts on captured stdout.
open class Issue941NullCoalescingOperatorEmitTests {
    @Fact
    func ReferenceTypeFallback_LeftNil_ReturnsRight() {
        let source = `package P

import System

func OrDefault(value string?, fallback string) string {
    return value ?? fallback
}

Console.WriteLine(OrDefault(nil, "fallback"))
Console.WriteLine(OrDefault("present", "fallback"))`
        let output = CompileAndRun(source)
        Assert.Equal("fallback${Environment.NewLine}present${Environment.NewLine}", output)
    }

    @Fact
    func NullableValueTypeFallback_LeftNil_ReturnsRightUnderlying() {
        let source = `package P

import System

let absent int32? = nil
let present int32? = 7
Console.WriteLine((absent ?? -1).ToString())
Console.WriteLine((present ?? -1).ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("-1${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func Chained_RightAssociative_FallsThroughToFirstNonNil() {
        let source = `package P

import System

let a string? = nil
let b string? = nil
let c string? = "third"
Console.WriteLine(a ?? b ?? c ?? "last")

let x string? = nil
let y string? = "second"
Console.WriteLine(x ?? y ?? "last")`
        let output = CompileAndRun(source)
        Assert.Equal("third${Environment.NewLine}second${Environment.NewLine}", output)
    }

    @Fact
    func ShortCircuit_RightSideNotEvaluated_WhenLeftNonNil() {
        // The right operand has an observable side effect (prints SIDE). When
        // the left operand is non-nil, the right operand must NOT be evaluated,
        // so SIDE must not appear in stdout.
        let source = `package P

import System

func Side() string {
    Console.WriteLine("SIDE")
    return "from-side"
}

let present string? = "present"
Console.WriteLine(present ?? Side())

let absent string? = nil
Console.WriteLine(absent ?? Side())`
        let output = CompileAndRun(source)
        // present branch: prints "present" and never calls Side().
        // absent branch: calls Side() (prints "SIDE") then yields "from-side".
        Assert.Equal("present${Environment.NewLine}SIDE${Environment.NewLine}from-side${Environment.NewLine}", output)
    }

    @Fact
    func CompoundAssignment_StillWorks() {
        // Regression guard: `??=` (ADR-0072) continues to work unchanged
        // alongside the new `??` read operator.
        let source = `package P

import System

var x string? = nil
x ??= "defaulted"
Console.WriteLine(x ?? "n/a")

var y string? = "kept"
y ??= "ignored"
Console.WriteLine(y ?? "n/a")`
        let output = CompileAndRun(source)
        Assert.Equal("defaulted${Environment.NewLine}kept${Environment.NewLine}", output)
    }

    @Fact
    func RemovedElvisSpelling_IsParseError() {
        // Issue #941: the former `?:` null-coalescing spelling was removed.
        // `a ?: b` no longer parses — the lexer yields `?` then `:`, and the
        // parser reports GS0005.
        let source = `package P

import System

let x string? = nil
Console.WriteLine(x ?: "fallback")`
        let (exitCode, _, diagnostics) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0005", diagnostics)
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

        private func CompileExpectingFailure(source string)(ExitCode int32, Stdout string, Diagnostics string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue941_err_").FullName
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
                return (compileExit, compileOut.ToString(), compileOut.ToString() + compileErr.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue941_").FullName
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
