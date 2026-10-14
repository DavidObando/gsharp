// <copyright file="AsyncSequenceTypeClauseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// End-to-end tests for ADR-0042: `async sequence[T]` as a type-clause
/// spelling for `IAsyncEnumerable[T]` in any type-clause position
/// (parameters, locals, fields, generic arguments, function-type return
/// slots, etc.). Most of the verification is via reflection on emitted
/// metadata, because GSharp marks any function returning
/// `IAsyncEnumerable[T]` as an async iterator (ADR-0041) regardless of
/// whether the body yields.
open class AsyncSequenceTypeClauseTests {
    @Fact
    func AsyncSequenceTypeClause_ParameterPosition_HasAsyncEnumerableClrType() {
        // A sync function that accepts `async sequence[int]` and forwards it
        // to another sink. We only verify the parameter type at the metadata
        // level — the body is `return null` to keep the iterator rewriter
        // from interfering with the call site.
        const Source = `package AsyncSeqParam
import System
import System.Collections.Generic
import System.Threading.Tasks

func describe(stream async sequence[int32]) {
    Console.Out.WriteLine("ok")
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "AsyncSequenceTypeClause_ParameterPosition_HasAsyncEnumerableClrType"
        )
        try {
            let method = GetProgramMethod(asm, "describe")
            let parameters = method.GetParameters()
            Assert.Single(parameters)
            Assert.Equal(typeof(IAsyncEnumerable[int32]), parameters[0].ParameterType)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncSequenceTypeClause_LocalDeclaration_BindsToAsyncEnumerable() {
        // A local typed `async sequence[int]` is hoisted to a state-machine
        // field when used inside an async function. We verify via reflection
        // that the field exists with the expected CLR type, which proves the
        // local's type clause bound to IAsyncEnumerable[int].
        const Source = `package AsyncSeqLocal
import System
import System.Collections.Generic
import System.Threading.Tasks

async func source() sequence[int32] {
    yield 1
}

async func consume() int32 {
    let stream async sequence[int32] = source()
    await Task.Yield()
    return 0
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncSequenceTypeClause_LocalDeclaration_BindsToAsyncEnumerable")
        try {
            // Look at every type in the assembly for a field whose type is
            // IAsyncEnumerable<int>; the hoisted local should be exactly that.
            let hasField = asm
                .GetTypes()
                .SelectMany(
                func (t Type) IEnumerable[FieldInfo] {
                    return t.GetFields(
                        BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                    )
                }
            )
                .Any((f FieldInfo) -> f.FieldType == typeof(IAsyncEnumerable[int32]))
            Assert.True(
                hasField,
                "Expected at least one emitted field of type IAsyncEnumerable<int32> from the hoisted local."
            )
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncSequenceTypeClause_AndExplicitIAsyncEnumerable_AreSameClrType() {
        // Explicit modifier `async sequence[int]` and the BCL spelling
        // `IAsyncEnumerable[int]` must produce identical CLR signatures.
        const Source = `package AsyncSeqEquiv
import System
import System.Collections.Generic
import System.Threading.Tasks

func viaModifier(s async sequence[int32]) {
}

func viaBcl(s IAsyncEnumerable[int32]) {
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncSequenceTypeClause_AndExplicitIAsyncEnumerable_AreSameClrType")
        try {
            let viaModifier = GetProgramMethod(asm, "viaModifier")
            let viaBcl = GetProgramMethod(asm, "viaBcl")
            Assert.Equal(typeof(IAsyncEnumerable[int32]), viaModifier.GetParameters()[0].ParameterType)
            Assert.Equal(typeof(IAsyncEnumerable[int32]), viaBcl.GetParameters()[0].ParameterType)
            Assert.Equal(viaModifier.GetParameters()[0].ParameterType, viaBcl.GetParameters()[0].ParameterType)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncSequenceTypeClause_DiagnosticWhenAsyncIsNotFollowedBySequence() {
        // `async` as a type-clause prefix is reserved for `sequence` today.
        const Source = `package AsyncSeqInvalid
import System

func bad(s async int32) {
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains(
                "'async' modifier in a type clause is only valid before 'sequence[T]'",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func AsyncSequenceTypeClause_InReturnSlot_MatchesAdr0041Swap() {
        // ADR-0041: `async func foo() sequence[int]` implicitly swaps to
        // IAsyncEnumerable[int].
        // ADR-0042: `async func foo() async sequence[int]` says it explicitly.
        // Both should produce the same return type.
        const Source = `package AsyncSeqReturn
import System
import System.Collections.Generic
import System.Threading.Tasks

async func implicitSwap() sequence[int32] {
    yield 1
}

async func explicitModifier() async sequence[int32] {
    yield 2
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncSequenceTypeClause_InReturnSlot_MatchesAdr0041Swap")
        try {
            let implicitSwap = GetProgramMethod(asm, "implicitSwap")
            let explicitModifier = GetProgramMethod(asm, "explicitModifier")
            Assert.Equal(typeof(IAsyncEnumerable[int32]), implicitSwap.ReturnType)
            Assert.Equal(typeof(IAsyncEnumerable[int32]), explicitModifier.ReturnType)
        } finally {
            ctx.Unload()
        }
    }

    shared {
        private func GetProgramMethod(asm Assembly, name string) MethodInfo {
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let method MethodInfo? = programType!!.GetMethod(
                name,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return method!!
        }

        private func CompileToAssembly(source string, contextName string)(asm Assembly, ctx AssemblyLoadContext) {
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
            let asm = loadContext.LoadFromStream(peStream)
            return (asm, loadContext)
        }
    }
}
