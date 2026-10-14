// <copyright file="Issue1554CompoundAssignOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1554 — compound assignment `x op= y` only resolved the BUILT-IN
/// binary operator; it did NOT fall back to USER-DEFINED
/// (`func (a T) operator +(b U) R`) or CLR (`op_*`, e.g.
/// `TimeSpan.op_Addition`) operator resolution the way the equivalent
/// binary expression `x = x op y` does. So `x += y` reported GS0129 for
/// any type whose operator is user-defined or a BCL operator, even though
/// `x + y` bound fine.
///
/// The fix routes (cref:GSharp.Binding.ExpressionBinder.TryBindCompoundBinaryOperation)
/// through the same user/CLR operator fallback the binary path uses (a shared
/// helper), so every compound-assignment target kind (local, instance field,
/// static field, chained member) works uniformly for user and BCL operators.
///
/// Each test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed for user types.
open class Issue1554CompoundAssignOperatorEmitTests {
    @Fact
    func EndToEnd_TimeSpanPlusEquals_Local_Runs() {
        const source = `package i1554tsadd
import System
func Main() {
  var x = TimeSpan.FromSeconds(int64(1))
  x += TimeSpan.FromSeconds(int64(2))
  Console.WriteLine(x.TotalSeconds)
}`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_TimeSpanMinusEquals_Local_Runs() {
        const source = `package i1554tssub
import System
func Main() {
  var x = TimeSpan.FromSeconds(int64(5))
  x -= TimeSpan.FromSeconds(int64(2))
  Console.WriteLine(x.TotalSeconds)
}`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DateTimePlusEqualsTimeSpan_Local_Runs() {
        const source = `package i1554dtadd
import System
func Main() {
  var d = DateTime(2020, 1, 1, 0, 0, 0)
  d += TimeSpan.FromDays(float64(5))
  Console.WriteLine(d.Day)
}`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UserOperatorPlusEquals_Local_Runs() {
        const source = `package i1554vecadd
import System
class VecA {
  var X int32
  var Y int32
}
func (a VecA) operator +(b VecA) VecA {
  return VecA{X: a.X + b.X, Y: a.Y + b.Y}
}
func Main() {
  var p = VecA{X: 1, Y: 2}
  p += VecA{X: 3, Y: 4}
  Console.WriteLine(p.X)
  Console.WriteLine(p.Y)
}`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}6${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UserOperatorStarEquals_Local_Runs() {
        const source = `package i1554moneymul
import System
struct MoneyM {
  var Cents int32
}
func (a MoneyM) operator *(b MoneyM) MoneyM {
  return MoneyM{Cents: a.Cents * b.Cents}
}
func Main() {
  var m = MoneyM{Cents: 3}
  m *= MoneyM{Cents: 4}
  Console.WriteLine(m.Cents)
}`
        let output = CompileAndRun(source)
        Assert.Equal("12${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UserOperatorPlusEquals_InstanceField_Runs() {
        const source = `package i1554ifield
import System
class VecB {
  var X int32
  var Y int32
}
func (a VecB) operator +(b VecB) VecB {
  return VecB{X: a.X + b.X, Y: a.Y + b.Y}
}
class HolderB { var V VecB }
func Main() {
  var h = HolderB{}
  h.V = VecB{X: 1, Y: 2}
  h.V += VecB{X: 3, Y: 4}
  Console.WriteLine(h.V.X)
  Console.WriteLine(h.V.Y)
}`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}6${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UserOperatorPlusEquals_StaticField_Runs() {
        const source = `package i1554sfield
import System
struct MoneyS {
  var Cents int32
}
func (a MoneyS) operator +(b MoneyS) MoneyS {
  return MoneyS{Cents: a.Cents + b.Cents}
}
class BankS {
  shared {
    var Total MoneyS
  }
}
func Main() {
  BankS.Total = MoneyS{Cents: 3}
  BankS.Total += MoneyS{Cents: 4}
  Console.WriteLine(BankS.Total.Cents)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UserOperatorPlusEquals_ChainedMember_Runs() {
        const source = `package i1554chain
import System
struct VecC {
  var X int32
}
func (a VecC) operator +(b VecC) VecC {
  return VecC{X: a.X + b.X}
}
class InnerC { var V VecC }
class OuterC { var In InnerC }
func Main() {
  var o = OuterC{In: InnerC{V: VecC{X: 1}}}
  o.In.V += VecC{X: 10}
  Console.WriteLine(o.In.V.X)
}`
        let output = CompileAndRun(source)
        Assert.Equal("11${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_Int32PlusEquals_Local_StillRuns() {
        const source = `package i1554i32
import System
func Main() {
  var i int32 = 10
  i += 5
  Console.WriteLine(i)
}`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DecimalPlusEquals_Local_StillRuns() {
        const source = `package i1554dec
import System
func Main() {
  var d decimal = decimal(10)
  d += decimal(5)
  Console.WriteLine(d)
}`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}", output)
    }

    @Fact
    func CompileOnly_Uint8PlusEqualsInt32_StillRejected() {
        const source = `package i1554u8reject
import System
func Main() {
  var b uint8 = uint8(1)
  var i int32 = 5
  b += i
  Console.WriteLine(b)
}`
        let (exit, output) = CompileOnly(source)
        Assert.NotEqual(0, exit)
        Assert.True(output.Contains("GS0129") || output.Contains("GS0156"), (`expected a compound-assignment rejection diagnostic, got:
` + "$output"))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1554_exe_").FullName
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

        private func CompileOnly(source string)(Exit int32, Output string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1554_neg_").FullName
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
    }
}
