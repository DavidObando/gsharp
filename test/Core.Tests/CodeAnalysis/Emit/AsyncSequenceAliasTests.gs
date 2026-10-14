// <copyright file="AsyncSequenceAliasTests.cs" company="GSharp">
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
import System.Threading
import Xunit

/// End-to-end tests for ADR-0041: in the return-type position of an
/// `async func`, the `sequence[T]` alias resolves to
/// `IAsyncEnumerable[T]`. Outside that position, it continues to mean
/// `IEnumerable[T]` (ADR-0040).
open class AsyncSequenceAliasTests {
    @Fact
    func AsyncSequenceAlias_YieldOnly_ProducesValues() {
        const Source = `package AsyncSeqAlias
import System
import System.Collections.Generic
import System.Threading.Tasks

async func numbers() sequence[int32] {
    yield 1
    yield 2
    yield 3
}
`
        let items = CompileAndEnumerateAsync[int32](Source, "numbers", "AsyncSequenceAlias_YieldOnly_ProducesValues")
        Assert.Equal([]int32{1, 2, 3}, items)
    }

    @Fact
    func AsyncSequenceAlias_YieldWithAwait_ProducesValues() {
        const Source = `package AsyncSeqAliasAwait
import System
import System.Collections.Generic
import System.Threading.Tasks

async func numbers() sequence[int32] {
    yield 10
    await Task.Yield()
    yield 20
    await Task.Yield()
    yield 30
}
`
        let items = CompileAndEnumerateAsync[int32](
            Source,
            "numbers",
            "AsyncSequenceAlias_YieldWithAwait_ProducesValues"
        )
        Assert.Equal([]int32{10, 20, 30}, items)
    }

    @Fact
    func AsyncSequenceAlias_ResultImplementsIAsyncEnumerable() {
        const Source = `package AsyncSeqAliasShape
import System
import System.Collections.Generic
import System.Threading.Tasks

async func gen() sequence[int32] {
    yield 1
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncSequenceAlias_ResultImplementsIAsyncEnumerable")
        try {
            let result object? = InvokeFunction(asm, "gen", nil)
            Assert.IsAssignableFrom[IAsyncEnumerable[int32]](result)
            Assert.False(result is IEnumerable[int32], "async-sequence return must not also be IEnumerable<int32>")
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func SyncSequence_NoAsyncModifier_StillIEnumerable() {
        const Source = `package SyncSeqStable
import System
import System.Collections.Generic

func numbers() sequence[int32] {
    yield 1
    yield 2
}
`
        let (asm, ctx) = CompileToAssembly(Source, "SyncSequence_NoAsyncModifier_StillIEnumerable")
        try {
            let result object? = InvokeFunction(asm, "numbers", nil)
            Assert.IsAssignableFrom[IEnumerable[int32]](result)
            Assert.False(result is IAsyncEnumerable[int32], "sync-sequence return must not be IAsyncEnumerable<int32>")
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncSequenceAlias_ParameterPosition_StaysSyncEnumerable() {
        // ADR-0041: the alias swap applies only to the return-type slot.
        // Parameter `items` is sequence[int] inside an async func — it must
        // still bind to IEnumerable[int] so we can pass a normal collection.
        const Source = `package AsyncSeqParam
import System
import System.Collections.Generic
import System.Threading.Tasks

async func echo(items sequence[int32]) sequence[int32] {
    for x in items {
        yield x
    }
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncSequenceAlias_ParameterPosition_StaysSyncEnumerable")
        try {
            // Pass a synchronous IEnumerable<int> as the argument.
            let arg IEnumerable[int32] = []int32{7, 8, 9}
            let result object? = InvokeFunction(asm, "echo", []object{arg})
            let items = ConsumeAsyncEnumerable[int32](result)
            Assert.Equal([]int32{7, 8, 9}, items)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func AsyncSequenceAlias_AndExplicitIAsyncEnumerable_AreSameClrType() {
        // Two functions, one spelled with the alias, the other with the BCL
        // type, should expose the same CLR return type.
        const Source = `package AsyncSeqEquiv
import System
import System.Collections.Generic
import System.Threading.Tasks

async func viaAlias() sequence[int32] {
    yield 1
}

func viaExplicit() IAsyncEnumerable[int32] {
    yield 2
}
`
        let (asm, ctx) = CompileToAssembly(Source, "AsyncSequenceAlias_AndExplicitIAsyncEnumerable_AreSameClrType")
        try {
            let programType = asm.GetTypes().First((t Type) -> t.Name == "<Program>")
            let alias MethodInfo? = programType.GetMethod(
                "viaAlias",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            let explicitly MethodInfo? = programType.GetMethod(
                "viaExplicit",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(alias)
            Assert.NotNull(explicitly)
            Assert.Equal(alias!!.ReturnType, explicitly!!.ReturnType)
            Assert.Equal(typeof(IAsyncEnumerable[int32]), alias!!.ReturnType)
        } finally {
            ctx.Unload()
        }
    }

    shared {
        private func CompileAndEnumerateAsync[T](source string, functionName string, contextName string) List[T] {
            let (asm, ctx) = CompileToAssembly(source, contextName)
            try {
                let enumerable object? = InvokeFunction(asm, functionName, nil)
                return ConsumeAsyncEnumerable[T](enumerable)
            } finally {
                ctx.Unload()
            }
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

        private func InvokeFunction(asm Assembly, functionName string, args[]?object) object? {
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let method MethodInfo? = programType!!.GetMethod(
                functionName,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return method!!.Invoke(nil, args)
        }

        private func ConsumeAsyncEnumerable[T](enumerable object?) List[T] {
            let asyncEnumerable IAsyncEnumerable[T]? = cast[IAsyncEnumerable[T]](enumerable)
            let enumerator = asyncEnumerable!!.GetAsyncEnumerator(CancellationToken.None)
            let items = List[T]()
            try {
                while enumerator.MoveNextAsync().AsTask().GetAwaiter().GetResult() {
                    items.Add(enumerator.Current)
                }
            } finally {
                enumerator.DisposeAsync().AsTask().GetAwaiter().GetResult()
            }
            return items
        }
    }
}
