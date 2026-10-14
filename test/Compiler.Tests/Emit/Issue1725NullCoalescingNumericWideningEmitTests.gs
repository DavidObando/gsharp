// <copyright file="Issue1725NullCoalescingNumericWideningEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1725 — cs2gs's `TranslateNullCoalescing` unconditionally
/// coerced the right operand of `a ?? b` down to the left operand's
/// underlying numeric type whenever the two numeric kinds differed. That only
/// matches C# when the right operand implicitly converts to the left's
/// underlying type; when the right side is wider, C# types `a ?? b` as
/// the right operand's (wider) type and converts the LEFT's value instead —
/// the buggy translation truncated the right operand. These are end-to-end
/// runtime checks of the underlying gsc `??` semantics that the cs2gs
/// fix now relies on (rather than re-deriving them with its own lowering):
/// gsc's own `??` binder (issue #1239) already performs C#'s
/// best-common-type widening and auto-converts the left operand's non-null
/// value, so the translated G# for each of these C# snippets is the
/// untouched `a ?? b` (verified separately by the Cs2Gs.Tests
/// translation tests) and must therefore produce the widened, non-truncated
/// runtime value below.
open class Issue1725NullCoalescingNumericWideningEmitTests {
    @Fact
    func RightWiderThanLeft_Int64_DoesNotTruncate() {
        const source = `package i1725rightwiderlong
import System

func N(nInt int32?, longDefault int64) int64 -> nInt ?? longDefault

func Main() {
    System.Console.WriteLine(N(nil, 5000000000))
    System.Console.WriteLine(N(3, 5000000000))
}`
        let output = CompileAndRun(source)
        Assert.Equal("5000000000${Environment.NewLine}3${Environment.NewLine}", output)
    }

    @Fact
    func RightWiderThanLeft_Double_KeepsFraction() {
        const source = `package i1725rightwiderdouble
import System

func N(nInt int32?) double -> nInt ?? 2.5

func Main() {
    System.Console.WriteLine(N(nil))
    System.Console.WriteLine(N(2))
}`
        let output = CompileAndRun(source)
        Assert.Equal("2.5${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func RightWiderThanLeft_NonConstantDouble_KeepsFraction() {
        const source = `package i1725rightwiderdoublevar
import System

func N(nInt int32?, otherDouble double) double -> nInt ?? otherDouble

func Main() {
    System.Console.WriteLine(N(nil, 2.5))
    System.Console.WriteLine(N(9, 2.5))
}`
        let output = CompileAndRun(source)
        Assert.Equal("2.5${Environment.NewLine}9${Environment.NewLine}", output)
    }

    @Fact
    func LeftWiderThanRight_CoercesConstantUp() {
        const source = `package i1725leftwider
import System

func N(nLong int64?) int64 -> nLong ?? 7

func Main() {
    System.Console.WriteLine(N(nil))
    System.Console.WriteLine(N(42))
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func EqualNumericKinds_NoCoercionNeeded() {
        const source = `package i1725equalkinds
import System

func N(x uint32?, fallback uint32) uint32 -> x ?? fallback

func Main() {
    System.Console.WriteLine(N(nil, 11u))
    System.Console.WriteLine(N(3u, 11u))
}`
        let output = CompileAndRun(source)
        Assert.Equal("11${Environment.NewLine}3${Environment.NewLine}", output)
    }

    // N1: reviewer-flagged combos where cs2gs emits `left ?? rightAtResultType`
    // with NO explicit left coercion, relying entirely on gsc's `??` binder to
    // widen the left operand's non-null value up to the result type. Each is
    // an end-to-end lock of that gsc contract for a combo not covered above.
    @Fact
    func LeftWiderFloatToDouble_WidensNonNullValue() {
        const source = `package i1725leftfloatdouble
import System

func N(f float?, d double) double -> f ?? d

func Main() {
    System.Console.WriteLine(N(nil, 2.5))
    System.Console.WriteLine(N(3.0f, 2.5))
}`
        let output = CompileAndRun(source)
        Assert.Equal("2.5${Environment.NewLine}3${Environment.NewLine}", output)
    }

    @Fact
    func LeftWiderUintToLong_WidensNonNullValue() {
        const source = `package i1725leftuintlong
import System

func N(u uint32?, l int64) int64 -> u ?? l

func Main() {
    System.Console.WriteLine(N(nil, 5000000000))
    System.Console.WriteLine(N(4000000000u, 5000000000))
}`
        let output = CompileAndRun(source)
        Assert.Equal("5000000000${Environment.NewLine}4000000000${Environment.NewLine}", output)
    }

    @Fact
    func LeftWiderIntToDecimal_WidensNonNullValue() {
        const source = `package i1725leftintdecimal
import System

func N(i int32?, d decimal) decimal -> i ?? d

func Main() {
    System.Console.WriteLine(N(nil, 2.5m))
    System.Console.WriteLine(N(7, 2.5m))
}`
        let output = CompileAndRun(source)
        Assert.Equal("2.5${Environment.NewLine}7${Environment.NewLine}", output)
    }

    // N3 / issue #914: a constant signed/unsigned mismatch (`uint? x ?? 0`) —
    // the literal `0`'s natural type `int32` differs from the `uint32` result
    // C# computes, so cs2gs coerces the right constant to the result type
    // (`x ?? uint32(0)`, per Issue1725NullCoalescingResultTypeTranslationTests
    // .ConstantNarrowerThanUnsignedResult_StillCoerced). Locks the runtime
    // value of that translated form, not just its text.
    @Fact
    func ConstantUnsignedMismatch_ProducesCorrectRuntimeValue() {
        const source = `package i1725constuintzero
import System

func N(x uint32?) uint32 -> x ?? uint32(0)

func Main() {
    System.Console.WriteLine(N(nil))
    System.Console.WriteLine(N(5u))
}`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}5${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1725_exe_").FullName
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
    }
}
