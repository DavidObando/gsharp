// <copyright file="Issue2154CompoundOperatorOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2154 — issue #1554 taught compound assignment (`x op= y`) to
/// fall back to a USER-DEFINED `operator` overload the same way the
/// equivalent binary expression `x = x op y` does, but that fallback was
/// only reachable for a BARE local variable and for the built-in event-style
/// `+=`/`-=` operators on member access. The parser only emitted an
/// (cref:GSharp.Core.CodeAnalysis.Syntax.EventSubscriptionExpressionSyntax)
/// (the node whose binder falls back to compound-assignment semantics for a
/// non-event member) for `+=`/`-=` — ANY other compound operator
/// (`*=`, `/=`, `%=`, `^=`, `&=`, `|=`, ...)
/// on a member-access LHS (`obj.Field *= 2`, `Type.StaticField *= 2`,
/// `a.B.C *= 2`) failed to even PARSE (`GS0005 Unexpected token
/// <StarEqualsToken>`), even though the member's type declared a
/// matching `operator *` overload and `obj.Field = obj.Field * 2`
/// bound and ran fine.
///
/// The fix widens the parser's member-access compound-assignment gate from
/// `+=`/`-=`-only to ANY compound operator (mirroring the
/// already-generalized bare-identifier and indexer paths), and threads the
/// actual base operator kind through the binder's compound-assignment helpers
/// (previously hard-coded to a `bool isAdd` that only ever produced
/// `+`/`-`) so every LHS shape works uniformly for every compound
/// operator.
open class Issue2154CompoundOperatorOverrideTests {
    @Fact
    func EndToEnd_UserOperatorStarEquals_InstanceField_Runs() {
        const source = `package i2154ifieldmul
import System
class VecD {
  var X int32
  var Y int32
}
func (a VecD) operator *(s int32) VecD {
  return VecD{X: a.X * s, Y: a.Y * s}
}
class HolderD { var V VecD }
func Main() {
  var h = HolderD{}
  h.V = VecD{X: 2, Y: 3}
  h.V *= 3
  Console.WriteLine(h.V.X)
  Console.WriteLine(h.V.Y)
}`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}9${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UserOperatorStarEquals_StaticField_Runs() {
        const source = `package i2154sfieldmul
import System
struct MoneyT {
  var Cents int32
}
func (a MoneyT) operator *(s int32) MoneyT {
  return MoneyT{Cents: a.Cents * s}
}
class BankT {
  shared {
    var Total MoneyT
  }
}
func Main() {
  BankT.Total = MoneyT{Cents: 3}
  BankT.Total *= 4
  Console.WriteLine(BankT.Total.Cents)
}`
        let output = CompileAndRun(source)
        Assert.Equal("12${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UserOperatorStarEquals_ChainedMember_Runs() {
        const source = `package i2154chainmul
import System
struct VecE {
  var X int32
}
func (a VecE) operator *(s int32) VecE {
  return VecE{X: a.X * s}
}
class InnerE { var V VecE }
class OuterE { var In InnerE }
func Main() {
  var o = OuterE{In: InnerE{V: VecE{X: 2}}}
  o.In.V *= 5
  Console.WriteLine(o.In.V.X)
}`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UserOperatorSlashEquals_InstanceField_Runs() {
        const source = `package i2154ifielddiv
import System
class VecF {
  var X int32
}
func (a VecF) operator /(s int32) VecF {
  return VecF{X: a.X / s}
}
class HolderF { var V VecF }
func Main() {
  var h = HolderF{}
  h.V = VecF{X: 20}
  h.V /= 4
  Console.WriteLine(h.V.X)
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    /// A real event on a member-access LHS must still bind as event
    /// subscription for `+=`/`-=` (regression guard: generalizing the
    /// parser/binder to accept any compound operator on a member-access LHS
    /// must not break the pre-existing event path).
    @Fact
    func EndToEnd_EventSubscription_MemberAccess_StillRuns() {
        const source = `package i2154eventregress
import System
class ClickerG {
  event Clicked () -> void
  func Raise() {
    Clicked?.Invoke()
  }
}
func Main() {
  var c = ClickerG{}
  c.Clicked += func() { Console.WriteLine(1) }
  c.Raise()
}`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2154_exe_").FullName
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
