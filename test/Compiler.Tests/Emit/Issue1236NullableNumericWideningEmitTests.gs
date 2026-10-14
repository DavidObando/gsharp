// <copyright file="Issue1236NullableNumericWideningEmitTests.cs" company="GSharp">
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

/// Issue #1236: a lifted (nullable) binary operator honours the same implicit
/// lossless integer-widening lattice and constant-integer-literal adaptation as
/// its non-nullable counterpart. The binder converts both operands to a common
/// `Nullable<underlying>` so the lifted operator is homogeneous; the new
/// machinery is a lifted `Nullable<T1> → Nullable<T2>` numeric-widening
/// conversion (null stays null, present values convert through the underlying
/// numeric type). Null semantics match the existing same-underlying lifted
/// operators.
///
/// Each test compiles via `gsc`, IL-verifies the produced PE, then executes
/// it under `dotnet exec` and asserts on captured stdout.
open class Issue1236NullableNumericWideningEmitTests {
    @Fact
    func LiftedLiteralEquality_Present_IsTrue() {
        let source = `package P

import System

func Eq(b uint8?) bool { return b == 11 }

let v uint8 = 11
let b uint8? = v
Console.WriteLine(Eq(b))
Console.WriteLine(Eq(nil))`
        // present 11 == 11 -> True; nil == 11 -> False (lifted equality).
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedDirectionalWideningEquality_Present_IsTrue() {
        let source = `package P

import System

func Eq(a uint8?, b int32?) bool { return a == b }

let av uint8 = 3
let a uint8? = av
let bv int32 = 3
let b int32? = bv
Console.WriteLine(Eq(a, b))
Console.WriteLine(Eq(a, nil))`
        // uint8? 3 == int32? 3 -> True; uint8? 3 == nil -> False.
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedArithmeticWidening_Present_AddsThroughUnderlying() {
        let source = `package P

import System

func Add(a int64?, b int32?) int64? { return a + b }

let av int64 = 5
let a int64? = av
let bv int32 = 11
let b int32? = bv
Console.WriteLine(Add(a, b).ToString())
Console.WriteLine(Add(a, nil) == nil)`
        // 5 + 11 -> 16; 5 + nil -> nil (null-propagation).
        Assert.Equal("16${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedLiteralArithmetic_AdaptsLiteralToUnderlying() {
        let source = `package P

import System

func Add(b int64?) int64? { return b + 11 }

let v int64 = 5
let b int64? = v
Console.WriteLine(Add(b).ToString())
Console.WriteLine(Add(nil) == nil)`
        Assert.Equal("16${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LiftedOrderingWidening_Present_ComparesThroughUnderlying() {
        let source = `package P

import System

func Lt(a uint8?, b int32?) bool { return a < b }

let av uint8 = 3
let a uint8? = av
let bv int32 = 10
let b int32? = bv
Console.WriteLine(Lt(a, b))
Console.WriteLine(Lt(a, nil))`
        // 3 < 10 -> True; 3 < nil -> False (lifted ordering with a null operand).
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1236_").FullName
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
