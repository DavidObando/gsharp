// <copyright file="Issue1144LiteralIntAdaptEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #1144: end-to-end emit + execution tests proving a constant integer
/// literal operand of a binary operator adapts to the OTHER operand's integer
/// type and is emitted with that type. Each program compiles via `gsc`,
/// is IL-verified, and runs under `dotnet exec` with its runtime values
/// asserted — including an unsigned-arithmetic check to confirm the literal is
/// emitted as the unsigned operand type (not int32).
open class Issue1144LiteralIntAdaptEmitTests {
    @Fact
    func BothLiteralOperands_AdaptRepresentableValues_AndRejectInvalidConversions() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package LiteralPromotion
import System
func Sum() uint32 -> 4294967294 + 1
func ReverseSum() uint32 -> 1 + 4294967294
func WideSum() uint64 -> 18446744073709551614 + 1
func ReverseWideSum() uint64 -> 1 + 18446744073709551614
func SignedSum() int64 -> 9223372036854775806 + 1
func Main() {
    Console.WriteLine(Sum())
    Console.WriteLine(ReverseSum())
    Console.WriteLine(WideSum())
    Console.WriteLine(ReverseWideSum())
    Console.WriteLine(SignedSum())
    Console.WriteLine(4294967294 - 1)
    Console.WriteLine(4294967294 * 1)
    Console.WriteLine(4294967294 / 2)
    Console.WriteLine(4294967294 % 3)
    Console.WriteLine(4294967294 | 1)
    Console.WriteLine(4294967294 & 1)
    Console.WriteLine(4294967294 ^ 1)
    Console.WriteLine(4294967294 > 1)
    Console.WriteLine(1 < 4294967294)
    Console.WriteLine(4294967294 == 1)
    Console.WriteLine(1 != 4294967294)
}`
        let dll = fixture.Compile(source, "LiteralPromotion", true, "/deterministic+", "/debug:none")
        IlVerifier.Verify(dll)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                (
                    "4294967295\n4294967295\n18446744073709551615\n18446744073709551615\n" +
                        "9223372036854775807\n4294967293\n4294967294\n2147483647\n2\n" +
                        "4294967295\n0\n4294967295\nTrue\nTrue\nFalse\nTrue\n"
                ).Replace("\n", Environment.NewLine, StringComparison.Ordinal)
            ),
            fixture.RunBytes(dll)
        )
        let first = File.ReadAllBytes(dll)
        fixture.Compile(source, "LiteralPromotion", true, "/deterministic+", "/debug:none")
        Assert.Equal(first, File.ReadAllBytes(dll))

        for expression in[]string{
            "4294967294 + 0xffffffff",
            "0xffffffff + 4294967294",
            "18446744073709551615 + -1",
            "4294967294 + value",
            "value + 4294967294",
            "small + 256",
            "unsigned + -1"
        } {
            let declaration = "func F(value int32, small uint8, unsigned uint32) -> "
            let rejected = "package Rejected\n" + declaration + expression
            let (code, diagnostics) = fixture.TryCompile(rejected, "Rejected", false)
            Assert.NotEqual(0, code)
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
            let error = Assert.Single(Regex.Matches(diagnostics, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+):`))
            let column = declaration.Length + expression.IndexOf('+') + 1
            Assert.Equal("GS0129", error.Groups[5].Value)
            Assert.Equal("2", error.Groups[1].Value)
            Assert.Equal(column.ToString(), error.Groups[2].Value)
            Assert.Equal("2", error.Groups[3].Value)
            Assert.Equal((column + 1).ToString(), error.Groups[4].Value)
        }
    }

    @Fact
    func UInt32Increment_LiteralAdapts_AndRuns() {
        let source = `package main
import System

func F(a uint32) uint32 { return a + 1 }

func run() {
    Console.WriteLine(F(uint32(10)))
}

run()`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UInt8BitwiseOr_LiteralAdapts_AndRuns() {
        let source = `package main
import System

func G(b uint8) int32 { return int32(b | 4) }

func run() {
    Console.WriteLine(G(uint8(1)))
}

run()`
        // 1 | 4 == 5
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UInt8Equality_LiteralAdapts_AndRuns() {
        let source = `package main
import System

func H(c uint8) bool { return c == 0 }

func run() {
    Console.WriteLine(H(uint8(0)))
    Console.WriteLine(H(uint8(5)))
}

run()`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UInt32Wrap_LiteralEmittedAsUnsigned_NotInt32() {
        // If the literal `1` were emitted as int32 and the addition performed
        // as signed int32, `0xFFFFFFFF + 1` would overflow into a negative
        // int32. Adapting the literal to uint32 makes this wrap to 0 as
        // unsigned arithmetic — proving the emitted operand type.
        let source = `package main
import System

func F(a uint32) uint32 { return a + 1 }

func run() {
    var max = 4294967295U
    Console.WriteLine(F(max))
}

run()`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Int64Operand_LiteralAdapts_AndRuns() {
        let source = `package main
import System

func F(l int64) int64 { return l + 1 }

func run() {
    Console.WriteLine(F(9223372036854775806L))
}

run()`
        Assert.Equal("9223372036854775807${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1144_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath, nil, Array.Empty[string]())
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
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }
    }
}
