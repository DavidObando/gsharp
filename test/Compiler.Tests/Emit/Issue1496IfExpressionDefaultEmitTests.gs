// <copyright file="Issue1496IfExpressionDefaultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1496 — an if-expression (`if cond { ... } else { ... }`) with a
/// bare `default` arm whose merge type is an open type parameter, a
/// nullable open generic, an erased user generic, or a value type emitted
/// `ldnull` for the `default` arm instead of a zero-initialized value,
/// producing unverifiable IL (`found Nullobjref expected value 'T'`). The
/// ternary `cond ? value : default` path already pre-typed the bare default
/// from its sibling; the if-expression path did not, so the placeholder
/// `BoundDefaultExpression(syntax, TypeSymbol.Error)` survived to emit.
/// The fix materialises the bare default against the conditional merge target at
/// the shared `ConvertConditionalBranch` choke point, covering both `if`
/// and `?:`.
///
/// One facet per distinct result-type IL shape: interface-constrained `T?`,
/// `[T struct] T?`, `[T class] T?`, unconstrained `T`, an erased
/// user generic `G[T]`, a concrete struct (`initobj`), a reference type
/// (still `ldnull`, no regression), and both-`default` arms with a
/// target type. Each uses a UNIQUE package/type name to avoid the in-process,
/// name-keyed `FunctionTypeSymbol` cache contaminating sibling tests.
open class Issue1496IfExpressionDefaultEmitTests {
    @Fact
    func EndToEnd_InterfaceConstrainedNullable_DefaultArmIsNull_Runs() {
        let source = `package P1496Iface
import System
interface ITag1496[T] { func Tag() string; }
class TagBox1496 : ITag1496[TagBox1496] { func Tag() string -> "tb" }
class HolderIf1496[T ITag1496[T]] {
    func GetOrDefault(present bool, value T) T? -> if !present { default } else { value }
}
func Main() {
    var h = HolderIf1496[TagBox1496]()
    Console.WriteLine(h.GetOrDefault(false, TagBox1496()) == nil)
    Console.WriteLine(h.GetOrDefault(true, TagBox1496()) == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_StructConstrainedNullable_DefaultArmIsNull_Runs() {
        let source = `package P1496Struct
import System
struct MyVal1496 { var n int32 }
class HolderSt1496[T struct] {
    func GetOrDefault(present bool, value T) T? -> if !present { default } else { value }
}
func Main() {
    var h = HolderSt1496[MyVal1496]()
    Console.WriteLine(h.GetOrDefault(false, MyVal1496{n: 9}) == nil)
    Console.WriteLine(h.GetOrDefault(true, MyVal1496{n: 9}) == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ClassConstrainedNullable_DefaultArmIsNull_Runs() {
        let source = `package P1496Class
import System
class Ref1496 { var n int32 }
class HolderCl1496[T class] {
    func GetOrDefault(present bool, value T) T? -> if !present { default } else { value }
}
func Main() {
    var h = HolderCl1496[Ref1496]()
    Console.WriteLine(h.GetOrDefault(false, Ref1496()) == nil)
    Console.WriteLine(h.GetOrDefault(true, Ref1496()) == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UnconstrainedTypeParameter_DefaultArmIsZero_Runs() {
        let source = `package P1496UnconstrainedT
import System
class HolderU1496[T] {
    func Pick(c bool, v T) T -> if c { default } else { v }
}
func Main() {
    var hi = HolderU1496[int32]()
    Console.WriteLine(hi.Pick(true, 7))
    Console.WriteLine(hi.Pick(false, 7))
    var hs = HolderU1496[string]()
    Console.WriteLine(hs.Pick(true, "x") == nil)
    Console.WriteLine(hs.Pick(false, "x"))
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "0${Environment.NewLine}7${Environment.NewLine}True${Environment.NewLine}x${Environment.NewLine}",
            output
        )
    }

    @Fact
    func EndToEnd_ErasedUserGenericNullable_DefaultArmIsNull_Runs() {
        let source = `package P1496Box
import System
class Box1496[T] { var v T }
class Maker1496[T] {
    func GetOrDefault(present bool, b Box1496[T]) Box1496[T]? -> if !present { default } else { b }
}
func Main() {
    var m = Maker1496[int32]()
    Console.WriteLine(m.GetOrDefault(false, Box1496[int32]()) == nil)
    Console.WriteLine(m.GetOrDefault(true, Box1496[int32]()) == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ConcreteStruct_DefaultArmInitObjZeroValue_Runs() {
        let source = `package P1496ConcreteStruct
import System
struct Point1496 {
    var x int32
    var y int32
}
class Sc1496 {
    func Get(c bool) Point1496 -> if c { default } else { Point1496{x: 3, y: 4} }
}
func Main() {
    var s = Sc1496()
    Console.WriteLine(s.Get(true).x)
    Console.WriteLine(s.Get(false).x)
}`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}3${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ReferenceType_DefaultArmStillNullAndVerifies_Runs() {
        let source = `package P1496RefDefault
import System
class Sr1496 {
    func Get(c bool, s string) string -> if c { default } else { s }
}
func Main() {
    var s = Sr1496()
    Console.WriteLine(s.Get(true, "hi") == nil)
    Console.WriteLine(s.Get(false, "hi"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BothArmsBareDefaultWithTargetType_DefaultIsNull_Runs() {
        let source = `package P1496BothDefault
import System
class HolderBd1496[T struct] {
    func Pick(c bool) T? -> if c { default } else { default }
}
func Main() {
    var h = HolderBd1496[int32]()
    Console.WriteLine(h.Pick(true) == nil)
    Console.WriteLine(h.Pick(false) == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1496_exe_").FullName
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
