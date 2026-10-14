// <copyright file="Issue1431NativeFunctionTypeInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #1431: emit-time generic type inference must descend into a native
/// G# function type `(T1, ...) -> R` at both the parameter and return
/// positions when building a generic-method `MethodSpec`. Before the fix,
/// a type parameter that appeared ONLY in the return slot of a native
/// function-type parameter (e.g. `keySelector (TResult) -> TKey`)
/// threw an internal compiler error (GS9998 / InvalidOperationException)
/// because the structural unifier had no `FunctionTypeSymbol` branch.
/// The equivalent declaration using a CLR `Func[...]` delegate already
/// inferred fine.
/// @remarks These tests also pin the latent emitter conversion gap the inference ICE
/// previously masked: a lambda bound against a native
/// `(T) -> IEnumerable[R]` parameter yields an
/// `IEnumerable<System.Int64>` body whose closed CLR shape differs
/// in representation (but not identity) from the type-erased substituted
/// target return, which is a no-op reference conversion at the IL level.
open class Issue1431NativeFunctionTypeInferenceEmitTests {
    @Fact
    func NativeFunctionType_TypeParamOnlyInReturnPosition_InfersAndRuns() {
        // `TKey` appears ONLY in the return position of the native function
        // type `(TResult) -> TKey` and nowhere else in a parameter or the
        // method return — the exact shape that threw GS9998 before the fix.
        let source = `package Probe1431A
import System.Collections.Generic

func Project1431[TSource, TResult, TKey](
        source IEnumerable[TSource],
        selector (TSource) -> TResult,
        keySelector (TResult) -> TKey) TResult {
    for s in source {
        return selector(s)
    }

    return default(TResult?)!!
}

public var result = Project1431([]int32{5, 6, 7}, (s int32) -> s * 10, (t int32) -> t)`
        let assembly = CompileAndRun(source)
        Assert.Equal(50, GetIntField(assembly, "result"))
    }

    @Fact
    func NativeFunctionType_ReturningEnumerable_InfersAndRuns() {
        // `TResult` appears only inside the function-type return shape
        // `(TSource) -> IEnumerable[TResult]`. The unifier must recurse
        // through the FunctionTypeSymbol's return slot and then through the
        // `IEnumerable[...]` generic arguments. The lambda body
        // (`IEnumerable[int64]`) flowing into the substituted target return
        // also exercises the no-op identity reference conversion the
        // inference ICE previously masked.
        let source = `package Probe1431B
import System.Collections.Generic

func Pair1431(v int64) IEnumerable[int64] {
    yield v
    yield v * 10
}

func FlatFirst1431[TSource, TResult](
        source IEnumerable[TSource],
        selector (TSource) -> IEnumerable[TResult]) IEnumerable[TResult] {
    for s in source {
        return selector(s)
    }

    return default(IEnumerable[TResult]?)!!
}

public var total = 0
for v in FlatFirst1431([]int32{1, 2, 3}, (s int32) -> Pair1431(int64(s))) {
    total = total + int32(v)
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(11, GetIntField(assembly, "total"))
    }

    @Fact
    func NativeFunctionType_ExtensionMethodIssueShape_CompilesCleanLibrary() {
        // The literal issue repro: an extension method whose constrained
        // type parameter `TKey` only appears in the return slot of a native
        // function-type parameter. Compiles to a library with no GS9998 ICE.
        let source = `package Probe1431C
import System
import System.Collections.Generic

func (source IEnumerable[TSource]) IB1431[TSource, TResult, TKey IComparable[TKey]](
        selector (TSource) -> IEnumerable[TResult],
        keySelector (TResult) -> TKey) IEnumerable[TResult] -> default(IEnumerable[TResult]?)!!

func F1431(xs IEnumerable[int32]) {
    let r = xs.IB1431((s int32) -> default(IEnumerable[int64]?)!!, (t int64) -> t)
}`
        // Compiling to a library is sufficient — the ICE fired during emit
        // while building the MethodSpec for the `IB1431` call, so a clean
        // exit proves the fix.
        let assembly = CompileLibrary(source)
        Assert.NotNull(assembly)
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let outPath = CompileToFile(source, target: "exe")
            let assembly = EmittedFixture.Load(outPath)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return assembly
        }

        private func CompileLibrary(source string) Assembly {
            let outPath = CompileToFile(source, target: "library")
            return EmittedFixture.Load(outPath)
        }

        private func CompileToFile(source string, target string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1431_").FullName
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
                    []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func GetIntField(assembly Assembly, name string) int32 {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let field FieldInfo? = program.GetField(name, BindingFlags.Public | BindingFlags.Static)
            return int32(field!!.GetValue(nil)!!)
        }
    }
}
