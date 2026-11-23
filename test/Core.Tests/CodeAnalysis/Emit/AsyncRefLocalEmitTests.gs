// <copyright file="AsyncRefLocalEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// End-to-end PE round-trip tests for ref locals in async state machines.
/// Verifies that ref locals across await boundaries compile and produce correct results.
open class AsyncRefLocalEmitTests {
    @Fact
    func RefLocal_To_Local_Across_Await_ReadsCurrentValue() {
        // Declares a ref local pointing to a local, awaits, then writes to the
        // original local and reads through the (conceptual) ref local.
        const Source = `package AsyncRefLocal1
import System
import System.Threading.Tasks

async func run() int32 {
    var x = 10
    var slot = &x
    let added = await Task.FromResult(32)
    x = added + 10
    return *slot
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncRefLocal1")
        Assert.Contains("42", output)
    }

    @Fact
    func RefLocal_To_ArrayElement_Across_Await_RoundTrips() {
        // Declares a ref local pointing to an array element, awaits, then
        // reads through the ref local to verify the element value.
        const Source = `package AsyncRefArr
import System
import System.Threading.Tasks

async func run() int32 {
    var arr = [3]int32{10, 20, 30}
    var i = 1
    var slot = &arr[i]
    let delta = await Task.FromResult(22)
    return *slot + delta
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncRefArr")
        Assert.Contains("42", output)
    }

    @Fact
    func RefLocal_Used_Only_Before_Await_DoesNotRequireHoisting() {
        // The ref local is only used before the await — still must produce valid IL.
        const Source = `package AsyncRefBeforeAwait
import System
import System.Threading.Tasks

async func run() int32 {
    var x = 40
    var slot = &x
    var before = *slot
    let extra = await Task.FromResult(2)
    return before + extra
}

var t = run()
t.Wait()
Console.WriteLine(t.Result)
`
        let output = CompileAndRun(Source, "AsyncRefBeforeAwait")
        Assert.Contains("42", output)
    }

    @Fact
    func RefLocal_UnreachableConditionalReseat_AcrossAwait_PreservesOriginalTarget() {
        const Source = `package AsyncRefConditionalFalse
import System
import System.Threading.Tasks

async func run() Task {
    var x = 1
    var y = 77
    var p = &x
    if false {
        p = &y
    }
    Console.WriteLine("before=${*p}")
    await Task.Delay(1)
    Console.WriteLine("after=${*p}")
}

run().GetAwaiter().GetResult()
`
        let output = CompileAndRun(Source, "AsyncRefConditionalFalse").Replace("\r\n", "\n")
        Assert.Equal("before=1\nafter=1\n", output)
    }

    @Fact
    func RefLocal_DynamicConditionalReseat_AcrossAwait_SelectsExecutedBranch() {
        const Source = `package AsyncRefConditionalDynamic
import System
import System.Threading.Tasks

async func run(flag bool) Task[string] {
    var x = 1
    var y = 77
    var p = &x
    if flag {
        p = &y
    }
    let before = *p
    await Task.Delay(1)
    let after = *p
    return "${before}:${after}"
}

Console.WriteLine(run(false).GetAwaiter().GetResult())
Console.WriteLine(run(true).GetAwaiter().GetResult())
`
        let output = CompileAndRun(Source, "AsyncRefConditionalDynamic").Replace("\r\n", "\n")
        Assert.Equal("1:1\n77:77\n", output)
    }

    @Fact
    func MissingUnsafeNullRef_InTargetClosure_ReportsGS0546() {
        const Source = `package MissingUnsafeNullRef6182
func run() int32 {
    var dummy = 0
    var p = &dummy
    return *p
}
`
        using let netStandard = NetStandardClosure()
        let comp = Compilation(netStandard, SyntaxTree.Parse(SourceText.From(Source)))
        let bound = comp.BoundProgram
        Assert.False(bound.Diagnostics.Any((d Diagnostic) -> d.IsError))
        let patcher = DummyAddressToDefaultRewriter()
        let patchedFunctions = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
        for pair in bound.Functions {
            patchedFunctions.Add(pair.Key, cast[BoundBlockStatement](patcher.RewriteStatement(pair.Value)))
        }
        let patchedProgram = BoundProgram(
            bound.EntryPointPackage,
            bound.Packages,
            bound.Diagnostics,
            patchedFunctions.ToImmutable(),
            bound.EntryPoint,
            bound.Statement
        )
        using let peStream = MemoryStream()
        let ex = Assert.Throws[EmitDiagnosticException](
            () -> ReflectionMetadataEmitter.Emit(
                patchedProgram,
                peStream,
                netStandard,
                "MissingUnsafeNullRef6182",
                metadataOnly: false
            )
        )
        Assert.Equal("GS0546", ex.DiagnosticId)
        Assert.Contains(PinningShapes.UnsafeNullRefSignature, ex.Message, StringComparison.Ordinal)
    }

    private class DummyAddressToDefaultRewriter : BoundTreeRewriter {
        protected override func RewriteAddressOfExpression(node BoundAddressOfExpression) BoundExpression {
            if node.Operand is BoundVariableExpression{Variable: LocalVariableSymbol v} && v.Name == "dummy" {
                return BoundDefaultExpression(node.Syntax, node.Type)
            }
            return base.RewriteAddressOfExpression(node)
        }
    }

    shared {
        private func NetStandardClosure() ReferenceResolver {
            let directory = typeof(AsyncRefLocalEmitTests)
                .Assembly
                .GetCustomAttributes[AssemblyMetadataAttribute]()
                .Single((attribute AssemblyMetadataAttribute) -> attribute.Key == "NetStandard20ReferenceDirectory")
                .Value!!
            return ReferenceResolver.WithReferences(Directory.EnumerateFiles(directory, "*.dll"))
        }

        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
