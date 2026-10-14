// <copyright file="Issue1480ConditionalTargetTypingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1480 — a conditional (`?:`/`if`-expression) or null-coalescing
/// (`??`) whose arms are sibling types sharing only a common BASE CLASS while
/// each implements a required INTERFACE was emitted as the common base value with NO
/// cast where the interface was expected. The CLR verifier merges the two arm classes
/// to their common base (never to an interface), producing unverifiable IL
/// (`StackUnexpected [found ref 'Base'][expected ref 'IShape']`) and a runtime
/// `InvalidProgramException`. The fix emits a `castclass` to the interface
/// result type on each value branch of conditionals and `??`, and threads the
/// contextual target type into `??` binding across all target-typed contexts.
/// Each facet uses a UNIQUE package + type names so the emitted assemblies do not
/// collide.
open class Issue1480ConditionalTargetTypingEmitTests {
    @Fact
    func FacetA_ExpressionBodiedConditionalToInterface_VerifiesAndRuns() {
        let source = `package Issue1480A
import System
interface IShapeA { prop Tag int { get } }
open class BaseA { }
class Aa : BaseA, IShapeA { prop Tag int -> 1 }
class Ba : BaseA, IShapeA { prop Tag int -> 2 }

func PickExpr(cond bool, a Aa, b Ba) IShapeA -> cond ? a : b
func Main() {
    Console.WriteLine(PickExpr(true, Aa(), Ba()).Tag)
    Console.WriteLine(PickExpr(false, Aa(), Ba()).Tag)
}`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func FacetB_ReturnConditionalToInterface_VerifiesAndRuns() {
        let source = `package Issue1480B
import System
interface IShapeB { prop Tag int { get } }
open class BaseB { }
class Ab : BaseB, IShapeB { prop Tag int -> 10 }
class Bb : BaseB, IShapeB { prop Tag int -> 20 }

func PickRet(cond bool, a Ab, b Bb) IShapeB { return cond ? a : b }
func Main() {
    Console.WriteLine(PickRet(true, Ab(), Bb()).Tag)
    Console.WriteLine(PickRet(false, Ab(), Bb()).Tag)
}`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}20${Environment.NewLine}", output)
    }

    @Fact
    func FacetC_TypedLocalConditionalToInterface_VerifiesAndRuns() {
        let source = `package Issue1480C
import System
interface IShapeC { prop Tag int { get } }
open class BaseC { }
class Ac : BaseC, IShapeC { prop Tag int -> 3 }
class Bc : BaseC, IShapeC { prop Tag int -> 4 }

func PickLocal(cond bool, a Ac, b Bc) IShapeC {
    let x IShapeC = cond ? a : b
    return x
}
func Main() {
    Console.WriteLine(PickLocal(true, Ac(), Bc()).Tag)
    Console.WriteLine(PickLocal(false, Ac(), Bc()).Tag)
}`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}4${Environment.NewLine}", output)
    }

    @Fact
    func FacetD_NullCoalesceToInterface_VerifiesAndRuns() {
        // Mirrors the corpus StblBox::get_COBox shape: a nullable concrete class
        // implementing the interface, coalesced with a conversion-call cast of a
        // sibling concrete class to the interface.
        let source = `package Issue1480D
import System
interface IShapeD { prop Tag int { get } }
open class BaseD { }
class Ad : BaseD, IShapeD { prop Tag int -> 5 }
class Bd : BaseD, IShapeD { prop Tag int -> 6 }

func PickCoalesce(a Ad?, b Bd) IShapeD -> a ?? IShapeD(b)
func Main() {
    Console.WriteLine(PickCoalesce(Ad(), Bd()).Tag)
    Console.WriteLine(PickCoalesce(nil, Bd()).Tag)
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}6${Environment.NewLine}", output)
    }

    @Fact
    func FacetE_ConditionalToCommonBaseClass_VerifiesAndRuns() {
        // Arms unify to a common BASE CLASS target (not an interface): no cast is
        // required, the verifier merge already yields a subtype of the base.
        let source = `package Issue1480E
import System
open class BaseE { func Name() string -> "base" }
class Ae : BaseE { func Name() string -> "a" }
class Be : BaseE { func Name() string -> "b" }

func PickBase(cond bool, a Ae, b Be) BaseE -> cond ? a : b
func Main() {
    Console.WriteLine(PickBase(true, Ae(), Be()).Name())
    Console.WriteLine(PickBase(false, Ae(), Be()).Name())
}`
        let output = CompileAndRun(source)
        Assert.Equal("base${Environment.NewLine}base${Environment.NewLine}", output)
    }

    @Fact
    func FacetF_ConditionalWithoutTargetUsesBestCommonType_VerifiesAndRuns() {
        // Regression: with NO contextual target type the conditional still binds to
        // the best-common-type (the shared base class) and a base method is callable.
        let source = `package Issue1480F
import System
open class BaseF { func Name() string -> "base" }
class Af : BaseF, IShapeF { prop Tag int -> 7 }
class Bf : BaseF, IShapeF { prop Tag int -> 8 }
interface IShapeF { prop Tag int { get } }

func NoTarget(cond bool, a Af, b Bf) string {
    let y = cond ? a : b
    return y.Name()
}
func Main() {
    Console.WriteLine(NoTarget(true, Af(), Bf()))
    Console.WriteLine(NoTarget(false, Af(), Bf()))
}`
        let output = CompileAndRun(source)
        Assert.Equal("base${Environment.NewLine}base${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1480_exe_").FullName
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
