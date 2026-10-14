// <copyright file="Issue1591NarrowedNullableInstanceCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1591 — calling an INSTANCE METHOD on a nullable value-type local that
/// has been smart-cast-narrowed by a null guard (`if x == nil { return }`)
/// silently emitted IL that read the DEFAULT value of the underlying type
/// instead of the actual stored value. No diagnostic was produced.
///
/// Root cause: smart-cast narrowing materializes the underlying `T` via the
/// same `!!` unwrap lowering as postfix null-assertion. When the unwrapped
/// value was then used as an instance-call receiver, the emitter needed the
/// address of the unwrapped `T`. The `Nullable<T>` unwrap scratch
/// slot and the bare-`T` receiver-address scratch slot were keyed on the
/// SAME `BoundUnaryExpression` node in `receiverSpillSlots`, so one
/// slot overwrote the other; the `get_Value` spill stored the
/// `Nullable<T>` struct into a `T`-typed slot and the call read a
/// default-initialized value (`0` for `int32?`, the first member for an
/// `enum?`).
///
/// The fix keys the unwrap scratch slot on the unwrap's OPERAND node rather than
/// the shared unary/receiver node, keeping the two slots distinct. Each test
/// RUNS the program and asserts the CORRECT runtime output; each uses a UNIQUE
/// package and user-type names because the in-process `FunctionTypeSymbol`
/// cache is name-keyed and not cleared between in-process emit tests.
open class Issue1591NarrowedNullableInstanceCallEmitTests {
    @Fact
    func EndToEnd_NarrowedInt32Nullable_ToStringReceiver_Runs() {
        const source = `package i1591int32tostring
import System

class C1591Int { func G(x int32?) string { if x == nil { return "none" } return x.ToString() } }

func Main() { System.Console.WriteLine(C1591Int().G(42)) }`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NarrowedInt32Nullable_NilGuardTakesNoneBranch_Runs() {
        const source = `package i1591int32none
import System

class C1591None { func G(x int32?) string { if x == nil { return "none" } return x.ToString() } }

func Main() { System.Console.WriteLine(C1591None().G(nil)) }`
        let output = CompileAndRun(source)
        Assert.Equal("none${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NarrowedEnumNullable_ToStringReceiver_Runs() {
        const source = `package i1591enumtostring
import System

enum Hue1591 { Red, Green, Blue }

class C1591Enum { func G(x Hue1591?) string { if x == nil { return "none" } return x.ToString() } }

func Main() { System.Console.WriteLine(C1591Enum().G(Hue1591.Green)) }`
        let output = CompileAndRun(source)
        Assert.Equal("Green${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NarrowedUserStructNullable_InstanceMethodReceiver_Runs() {
        const source = `package i1591structmethod
import System

struct Box1591 { var v int32
  func Show() string { return v.ToString() } }

class C1591Struct { func G(x Box1591?) string { if x == nil { return "none" } return x.Show() } }

func Main() { System.Console.WriteLine(C1591Struct().G(Box1591{v: 7})) }`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NarrowedInt32Nullable_ChainedValueTypeMemberCall_Runs() {
        const source = `package i1591chained
import System

class C1591Chain { func G(x int32?) string { if x == nil { return "none" } return x.CompareTo(0).ToString() } }

func Main() { System.Console.WriteLine(C1591Chain().G(42)) }`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NarrowedInt32Nullable_OperatorUse_StaysCorrect_Runs() {
        // Control: operator use of the narrowed local was already correct on
        // main; it must remain correct after the slot-keying fix.
        const source = `package i1591operator
import System

class C1591Op { func G(x int32?) int32 { if x == nil { return -1 } return x + 1 } }

func Main() { System.Console.WriteLine(C1591Op().G(42)) }`
        let output = CompileAndRun(source)
        Assert.Equal("43${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NarrowedInt32Nullable_BareReturn_StaysCorrect_Runs() {
        // Control: bare read of the narrowed local was already correct on main.
        const source = `package i1591bare
import System

class C1591Bare { func G(x int32?) int32 { if x == nil { return -1 } return x } }

func Main() { System.Console.WriteLine(C1591Bare().G(42)) }`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1591_exe_").FullName
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
