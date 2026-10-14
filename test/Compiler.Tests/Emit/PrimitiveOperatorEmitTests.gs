// <copyright file="PrimitiveOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Phase 4 of #142: end-to-end operator coverage for the expanded
/// numeric primitive set. Each test compiles a tiny GSharp program
/// that exercises one operator on one new primitive type, runs it,
/// and asserts the printed value matches what the BCL produces for
/// the same expression in C#.
open class PrimitiveOperatorEmitTests {
    @Theory
    @InlineData("int64", "100L + 50L", "150")
    @InlineData("int64", "100L - 50L", "50")
    @InlineData("int64", "100L * 50L", "5000")
    @InlineData("int64", "100L / 50L", "2")
    @InlineData("int64", "100L % 30L", "10")
    @InlineData("int64", "100L < 50L", "False")
    @InlineData("int64", "100L >= 100L", "True")
    @InlineData("int64", "100L == 100L", "True")
    @InlineData("int64", "100L & 6L", "4")
    @InlineData("int64", "100L | 6L", "102")
    @InlineData("int64", "100L ^ 6L", "98")
    @InlineData("int64", "1L << 10", "1024")
    @InlineData("int64", "1024L >> 2", "256")
    @InlineData("int32", "1 << 33", "2")
    @InlineData("int32", "1 << 32", "1")
    @InlineData("int32", "100 >> 32", "100")
    @InlineData("uint32", "uint32(1) << 32", "1")
    @InlineData("uint32", "uint32(100) >> 64", "100")
    @InlineData("int64", "1L << 64", "1")
    @InlineData("int64", "1L << 100", "68719476736")
    @InlineData("int64", "1024L >> 64", "1024")
    @InlineData("uint64", "uint64(1) << 64", "1")
    @InlineData("uint64", "uint64(1024) >> 64", "1024")
    @InlineData("int32", "1 << 31", "-2147483648")
    @InlineData("int64", "1L << 63", "-9223372036854775808")
    @InlineData("uint32", "uint32(1) << 31", "2147483648")
    @InlineData("uint64", "uint64(1) << 63", "9223372036854775808")
    @InlineData("int32", "42 << 0", "42")
    @InlineData("int64", "42L >> 0", "42")
    func Long_Operators_ProduceExpectedValue(_ string, expr string, expected string) {
        Assert.Equal(expected + Environment.NewLine, CompileAndRun(BuildSource(expr)))
    }

    // Issue #1232: a narrower-order integer shift count is implicitly widened to
    // int32, and the shift runs with C#/CLR masking — end-to-end.
    @Fact
    func Shift_NarrowOrderCount_WidensAndRuns() {
        let src = `package P
import System

func Shl(value uint32, count uint8) uint32 {
    return value << count
}

Console.WriteLine(Shl(uint32(1), uint8(4)))`
        Assert.Equal("16${Environment.NewLine}", CompileAndRun(src))
    }

    // Issue #1232: a value-producing if whose arms are a uint32 and the literal
    // `0` unifies on uint32 without an explicit cast on the `0`.
    @Fact
    func ValueIf_Uint32AndZeroLiteral_RunsWithoutCast() {
        let src = `package P
import System

func Pick(cond bool, u uint32) uint32 {
    return if cond { u } else { 0 }
}

Console.WriteLine(Pick(false, uint32(7)))`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(src))
    }

    @Theory
    @InlineData("uint64", "9000000000UL + 1000000000UL", "10000000000")
    @InlineData("uint64", "9000000000UL / 3UL", "3000000000")
    @InlineData("uint64", "9000000000UL > 1UL", "True")
    func ULong_Operators_UseUnsignedOpcodes(_ string, expr string, expected string) {
        Assert.Equal(expected + Environment.NewLine, CompileAndRun(BuildSource(expr)))
    }

    @Theory
    @InlineData("float64", "1.5 + 2.25", "3.75")
    @InlineData("float64", "10.0 / 4.0", "2.5")
    @InlineData("float64", "1.5 < 2.0", "True")
    func Float64_Operators_ProduceExpectedValue(_ string, expr string, expected string) {
        Assert.Equal(expected + Environment.NewLine, CompileAndRun(BuildSource(expr)))
    }

    @Theory
    @InlineData("decimal", "1.5M + 2.25M", "3.75")
    @InlineData("decimal", "10M / 4M", "2.5")
    @InlineData("decimal", "5M * 7M", "35")
    @InlineData("decimal", "10M - 3M", "7")
    @InlineData("decimal", "10M % 3M", "1")
    @InlineData("decimal", "1.5M < 2M", "True")
    @InlineData("decimal", "2M == 2M", "True")
    @InlineData("decimal", "2M != 3M", "True")
    func Decimal_Operators_RouteThroughOperatorMethods(_ string, expr string, expected string) {
        Assert.Equal(expected + Environment.NewLine, CompileAndRun(BuildSource(expr)))
    }

    @Fact
    func Char_Equality_Works() {
        let src = `package P
import System

let a = 'A'
let b = 'A'
Console.WriteLine(a == b)`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(src))
    }

    @Fact
    func Object_ReferenceEquality_OnSameInstance_IsTrue() {
        let src = `package P
import System

let s = "hello"
let a object = s
let b object = s
Console.WriteLine(a == b)`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(src))
    }

    @Fact
    func Decimal_UnaryNegation_RoutesThroughOperatorMethod() {
        let src = `package P
import System

let x = 3.14M
Console.WriteLine(-x)`
        Assert.Equal("-3.14${Environment.NewLine}", CompileAndRun(src))
    }

    @Fact
    func Long_UnaryNegation_UsesNegOpcode() {
        let src = `package P
import System

let x = 42L
Console.WriteLine(-x)`
        Assert.Equal("-42${Environment.NewLine}", CompileAndRun(src))
    }

    @Fact
    func Byte_OnesComplement_Works() {
        // ~1 as byte is 0xFE = 254. We compare against another byte value
        // to keep the result type as byte, since Console.WriteLine overload
        // selection for byte (no exact overload exists in System.Console)
        // is part of Phase 5 work.
        let src = `package P
import System

let x = uint8(1)
let y = uint8(254)
Console.WriteLine(~x == y)`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(src))
    }

    shared {
        private func BuildSource(expr string) string {
            return (`package P
import System

Console.WriteLine(` + "$expr" + `)`)
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_phase4_ops_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
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
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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
    }
}
