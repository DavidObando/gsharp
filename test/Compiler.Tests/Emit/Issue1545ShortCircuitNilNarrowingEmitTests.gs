// <copyright file="Issue1545ShortCircuitNilNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1545 — gsc threaded type-test narrowing (`x is T`, issues
/// #700/#712) into the right operand of `&&`/`||`, but did NOT
/// thread <em>nil-guard</em> narrowing (`x == nil` / `x != nil`). So
/// the canonical short-circuit null-guard idiom
/// (`x == nil || x.Member` / `x != nil && x.Member`) failed
/// with GS0158 even though the receiver is provably non-nil where used.
///
/// The fix adds the nil-guard leaf to
/// `ExpressionBinder.ClassifyTypeTestNarrowing` via a shared static leaf
/// (`SmartCastStability.TryClassifyNilGuardLeaf`) reused by the
/// if-condition classifier (`StatementBinder.TryClassifyNilGuard`).
///
/// Every facet failed to compile on current main and passes after the fix. Each
/// uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed for user types.
///
/// The short-circuit path intentionally restricts nil-guard narrowing to
/// nullable REFERENCE types: narrowing a nullable value type (`int32?`)
/// is not an IL no-op and the variable-load path does not emit the required
/// unwrap, so applying it produced invalid IL (regressed Issue1518's
/// `v != nil && v!! > 0`). Value-type nullables still work in the
/// guard via the nullable-lifted operator or an explicit `!!` — see
/// (cref:Control_ValueTypeNullable_ShortCircuitGuard_NotNarrowedButRuns).
open class Issue1545ShortCircuitNilNarrowingEmitTests {
    @Fact
    func EndToEnd_OrGuard_NullableArray_Runs() {
        const source = `package i1545orarray
import System

func OrGuard(x []?uint8) bool -> x == nil || x.Length < 8

func Main() {
    var big = []uint8{1,2,3,4,5,6,7,8,9,10}
    var small = []uint8{1,2,3}
    System.Console.WriteLine(OrGuard(nil))
    System.Console.WriteLine(OrGuard(big))
    System.Console.WriteLine(OrGuard(small))
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AndGuard_NullableArray_Runs() {
        const source = `package i1545andarray
import System

func AndGuard(x []?uint8) bool -> x != nil && x.Length >= 8

func Main() {
    var big = []uint8{1,2,3,4,5,6,7,8,9,10}
    var small = []uint8{1,2,3}
    System.Console.WriteLine(AndGuard(nil))
    System.Console.WriteLine(AndGuard(big))
    System.Console.WriteLine(AndGuard(small))
}`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_OrGuard_NullableStringReference_Runs() {
        const source = `package i1545orstring
import System

func IsBlank(s string?) bool -> s == nil || s.Length == 0

func Main() {
    System.Console.WriteLine(IsBlank(nil))
    System.Console.WriteLine(IsBlank(""))
    System.Console.WriteLine(IsBlank("abc"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AndGuard_NullableUserClassMemberCall_Runs() {
        const source = `package i1545anduserclass
import System

class Widget {
    prop On bool { get; init; }
    func IsOn() bool -> On
}

func Enabled(o Widget?) bool -> o != nil && o.IsOn()

func Main() {
    System.Console.WriteLine(Enabled(nil))
    System.Console.WriteLine(Enabled(Widget() { On = true }))
    System.Console.WriteLine(Enabled(Widget() { On = false }))
}`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_OrGuard_GenericNullableSequence_Runs() {
        const source = `package i1545orsequence
import System
import System.Collections.Generic
import System.Linq

func CountIt(e IEnumerable[int32]) int32 -> e.Count()

func IsEmpty(e IEnumerable[int32]?) bool -> e == nil || CountIt(e) == 0

func Main() {
    System.Console.WriteLine(IsEmpty(nil))
    var l = List[int32]()
    System.Console.WriteLine(IsEmpty(l))
    l.Add(7)
    System.Console.WriteLine(IsEmpty(l))
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_OrGuard_StableMemberPath_Runs() {
        const source = `package i1545stablepath
import System

class Holder {
    prop Field string? { get; init; }
    func Blank() bool -> this.Field == nil || this.Field.Length == 0
}

func Main() {
    System.Console.WriteLine(Holder() { Field = nil }.Blank())
    System.Console.WriteLine(Holder() { Field = "" }.Blank())
    System.Console.WriteLine(Holder() { Field = "abc" }.Blank())
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AndGuard_StableMemberPath_Runs() {
        const source = `package i1545stablepathand
import System

class Holder {
    prop Field string? { get; init; }
    func HasText() bool -> this.Field != nil && this.Field.Length > 0
}

func Main() {
    System.Console.WriteLine(Holder() { Field = nil }.HasText())
    System.Console.WriteLine(Holder() { Field = "" }.HasText())
    System.Console.WriteLine(Holder() { Field = "abc" }.HasText())
}`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NilOnLeftOperand_Runs() {
        // Either operand order must be recognised: `nil == x` / `nil != x`.
        const source = `package i1545operandorder
import System

func OrGuard(s string?) bool -> nil == s || s.Length == 0
func AndGuard(s string?) bool -> nil != s && s.Length > 0

func Main() {
    System.Console.WriteLine(OrGuard(nil))
    System.Console.WriteLine(OrGuard("abc"))
    System.Console.WriteLine(AndGuard(nil))
    System.Console.WriteLine(AndGuard("abc"))
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Negative_UnguardedMemberRead_ReportsGs0158() {
        // OUTSIDE the guarded operand, `.Length` on a nullable is still GS0158.
        const source = `package i1545neg158

func Bad(x []?uint8) int32 -> x.Length`
        let (exit, output) = CompileOnly(source)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0158", output)
    }

    @Fact
    func Negative_NonNullableComparedToNil_ReportsGs0129() {
        // A non-nullable operand compared to nil must still report GS0129; the
        // nil-guard leaf only fires for NullableTypeSymbol targets.
        const source = `package i1545neg129

func Bad(x int32) bool -> x == nil || x > 8`
        let (exit, output) = CompileOnly(source)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0129", output)
    }

    @Fact
    func Control_ValueTypeNullable_ShortCircuitGuard_NotNarrowedButRuns() {
        // A nullable VALUE type in a short-circuit guard is intentionally NOT
        // narrowed (that would need an unwrap the load path doesn't emit, giving
        // invalid IL). The idiom still runs: `v!!` unwraps explicitly and the
        // lifted `>` handles the un-narrowed operand. Both must produce valid,
        // ilverify-clean IL and the correct runtime result.
        const source = `package i1545vt

import System
import System.Linq

func CountForced(xs []int32?) int32 -> xs.Where((v int32?) -> v != nil && v!! > 0).Count()
func CountLifted(xs []int32?) int32 -> xs.Where((v int32?) -> v != nil && v > 0).Count()

func Main() {
    var xs = []int32?{1, nil, 2, nil, 3}
    Console.WriteLine(CountForced(xs))
    Console.WriteLine(CountLifted(xs))
}`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}3${Environment.NewLine}", output)
    }

    shared {
        private func CompileOnly(source string)(Exit int32, Output string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1545_neg_").FullName
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
                return (compileExit, stdoutWriter.ToString() + stderrWriter.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1545_exe_").FullName
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
