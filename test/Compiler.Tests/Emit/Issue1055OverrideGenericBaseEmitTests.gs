// <copyright file="Issue1055OverrideGenericBaseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #1055: when a class overrides an `open` base member whose
/// signature USES the base class's generic type parameters, and the base is
/// inherited as a CONSTRUCTED generic (e.g. `Derived : Base[int32, int32]`),
/// the override-matcher must first substitute the constructed base's type
/// arguments into the candidate base member's signature before comparing.
/// These tests compile and run an end-to-end program that dispatches through a
/// base-typed reference to confirm the override is correctly bound, emitted
/// (with the right base `extends` TypeSpec and base-ctor chaining), and
/// dispatched at runtime; the emitted IL is also checked with `ilverify`.
open class Issue1055OverrideGenericBaseEmitTests {
    @Fact
    func OverrideMethodUsingTypeParams_ConstructedBase_DispatchesThroughBaseRef_Runs() {
        let source = `package p
open class Base[TIn, TOut] {
    open func Transform(x TIn) TOut;
}
class Derived : Base[int32, int32] {
    override func Transform(x int32) int32 { return x + 1 }
}
func Main() {
    let b Base[int32, int32] = Derived()
    System.Console.WriteLine(b.Transform(41))
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func OverridePropertyUsingTypeParam_ConstructedBase_DispatchesThroughBaseRef_Runs() {
        let source = `package p
open class Holder[T] {
    open prop Value T { get; }
}
class IntHolder : Holder[int32] {
    override prop Value int32 { get { return 7 } }
}
func Main() {
    let h Holder[int32] = IntHolder()
    System.Console.WriteLine(h.Value)
}`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func OverrideMethodAcrossTwoConstructedLevels_DispatchesThroughMidRef_Runs() {
        // Leaf : Mid[int32] : Base[T] — the substitution composes across each
        // hop so the abstract `Do(x T) T` declared on Mid[T] is matched by the
        // concrete `Do(x int32) int32` override on Leaf.
        let source = `package p
open class Base[T] {
    open prop Size int32 { get; }
}
open class Mid[T] : Base[T] {
    open func Do(x T) T;
}
open class Leaf : Mid[int32] {
    override prop Size int32 { get { return 1 } }
    override func Do(x int32) int32 { return x + 100 }
}
func Main() {
    let m Mid[int32] = Leaf()
    System.Console.WriteLine(m.Do(5))
}`
        Assert.Equal("105${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1055_emit_").FullName
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
