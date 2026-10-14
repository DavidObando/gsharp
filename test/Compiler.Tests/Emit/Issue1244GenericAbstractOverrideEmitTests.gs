// <copyright file="Issue1244GenericAbstractOverrideEmitTests.cs" company="GSharp">
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

/// Issue #1244: a GENERIC derived class whose `override` of an abstract base
/// member uses the class type parameter (`Der[T] : Base[T]` overriding
/// `Handle(x T) int32`) must be recognized as implementing the abstract, so a
/// concrete leaf (`Leaf : Der[int32]`) is fully instantiable (no GS0386/GS0387)
/// and emits a correct vtable. These tests drive the real end-to-end emit pipeline:
/// they construct the leaf, run the program, and verify the emitted IL with
/// `ilverify` — proving the override slot is laid out correctly, not merely the
/// diagnostic.
open class Issue1244GenericAbstractOverrideEmitTests {
    @Fact
    func CanonicalGenericDerivedOverride_LeafConstructsAndRuns() {
        // The canonical #1244 case: ONLY Der[T]'s type-parameter-using override
        // closes Base[T].Handle; Leaf adds no override. Before the fix this failed
        // with GS0387 (Leaf wrongly considered abstract) so it could not be emitted
        // at all. Now it constructs, runs, and the IL verifies.
        let source = `package p
open class Base[T] {
    open func Handle(x T) int32;
}
open class Der[T] : Base[T] {
    override func Handle(x T) int32 { return 0 }
}
class Leaf : Der[int32] {
    func Plain() int32 { return 42 }
}
func Main() {
    let leaf Leaf = Leaf()
    System.Console.WriteLine(leaf.Plain())
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericHierarchyOverride_DispatchesOverriddenValueAtRuntime() {
        // Proves runtime vtable dispatch in the same generic hierarchy: Der[T]
        // declares an open override of the type-parameter-using abstract, and the
        // concrete Leaf overrides it again with a concrete signature. Invoking the
        // member must reach Leaf's override and return its value.
        let source = `package p
open class Base[T] {
    open func Handle(x T) int32;
}
open class Der[T] : Base[T] {
    open override func Handle(x T) int32 { return -1 }
}
class Leaf : Der[int32] {
    override func Handle(x int32) int32 { return x + 1 }
}
func Main() {
    let leaf Leaf = Leaf()
    System.Console.WriteLine(leaf.Handle(41))
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ThreeLevelGenericChain_LeafConstructsAndRuns() {
        // FilterBase[T] -> TransformBase[TIn, TOut] (generic derived overriding the
        // type-parameter-using abstract Handle(x TIn)) -> AacFilter (overriding the
        // remaining abstract Perform). The substitution composes across every hop;
        // the concrete leaf constructs and runs, and the IL verifies.
        let source = `package p
open class FilterBase[T] {
    protected open func Handle(x T) int32;
}
open class TransformBase[TIn, TOut] : FilterBase[TIn] {
    protected override func Handle(x TIn) int32 { return 0 }
    protected open func Perform(x TIn) TOut;
}
open class AacFilter : TransformBase[int32, int32] {
    protected override func Perform(x int32) int32 { return x + 5 }
    func Run(x int32) int32 { return x + 5 }
}
func Main() {
    let f AacFilter = AacFilter()
    System.Console.WriteLine(f.Run(37))
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ExpressionBodiedPropertyOverride_InheritedByLeaf_DispatchesDuringBaseConstruction() {
        let source = `package p
open class Base[T] {
    private let values []T
    init() { values = [Size]T }
    protected open prop Size int32 { get; }
    func Count() int32 { return values.Length }
}
open class Mid : Base[int32] {
    protected open override prop Size int32 -> 1000
}
class Leaf : Mid {
}
func Main() {
    System.Console.WriteLine(Leaf().Count())
}`
        Assert.Equal("1000${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1244_emit_").FullName
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
