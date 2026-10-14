// <copyright file="Issue4222RefAliasSuspensionEmitTests.cs" company="GSharp">
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

/// Issue #4222: end-to-end PE round-trip tests proving a native `let
/// ref`/`var ref` alias local, confined to one execution segment
/// (never live across an `await`/`yield` suspension point), now
/// compiles and runs correctly in async functions, iterators, and async
/// iterators — the two G# repros from the issue plus their `let ref`
/// siblings and an async-iterator combination, each producing the expected
/// runtime value and emitting no by-ref-typed state-machine field.
open class Issue4222RefAliasSuspensionEmitTests {
    @Fact
    func Async_VarRefAliasOfArrayElement_ConsumedBeforeAwait_Returns42() {
        // The issue's own async repro, verbatim.
        const Source = `package I4222AsyncVarRef
import System
import System.Threading.Tasks
async func Run() int32 {
    var values = []int32{10}
    {
        var ref alias = values[0]
        alias = 42
    }
    await Task.Delay(1)
    return values[0]
}
Console.WriteLine(Run().Result)
`
        let (output, hasByRefFields) = CompileAndRun(
            Source,
            "Async_VarRefAliasOfArrayElement_ConsumedBeforeAwait_Returns42"
        )
        Assert.Contains("42", output)
        Assert.False(hasByRefFields)
    }

    @Fact
    func Async_LetRefAliasOfArrayElement_ConsumedBeforeAwait_Returns42() {
        // `let ref` sibling: a read-only alias, only ever read, still
        // confined to before the await.
        const Source = `package I4222AsyncLetRef
import System
import System.Threading.Tasks
async func Run() int32 {
    var values = []int32{42}
    var result = 0
    {
        let ref alias = values[0]
        result = alias
    }
    await Task.Delay(1)
    return result
}
Console.WriteLine(Run().Result)
`
        let (output, hasByRefFields) = CompileAndRun(
            Source,
            "Async_LetRefAliasOfArrayElement_ConsumedBeforeAwait_Returns42"
        )
        Assert.Contains("42", output)
        Assert.False(hasByRefFields)
    }

    @Fact
    func Iterator_VarRefAliasOfArrayElement_ConsumedBeforeYield_Returns42() {
        // The issue's own iterator repro, verbatim.
        const Source = `package I4222IterVarRef
import System
func Values() sequence[int32] {
    var values = []int32{10}
    {
        var ref alias = values[0]
        alias = 42
    }
    yield values[0]
}
for value in Values() {
    Console.WriteLine(value)
}
`
        let (output, hasByRefFields) = CompileAndRun(
            Source,
            "Iterator_VarRefAliasOfArrayElement_ConsumedBeforeYield_Returns42"
        )
        Assert.Contains("42", output)
        Assert.False(hasByRefFields)
    }

    @Fact
    func Iterator_LetRefAliasOfArrayElement_ConsumedBeforeYield_Returns42() {
        const Source = `package I4222IterLetRef
import System
func Values() sequence[int32] {
    var values = []int32{42}
    var result = 0
    {
        let ref alias = values[0]
        result = alias
    }
    yield result
}
for value in Values() {
    Console.WriteLine(value)
}
`
        let (output, hasByRefFields) = CompileAndRun(
            Source,
            "Iterator_LetRefAliasOfArrayElement_ConsumedBeforeYield_Returns42"
        )
        Assert.Contains("42", output)
        Assert.False(hasByRefFields)
    }

    @Fact
    func AsyncIterator_VarRefAlias_ConsumedBeforeYield_AwaitFollows_Returns42() {
        // An async-iterator route: the alias is confined to a segment before
        // BOTH kinds of suspension point the function contains (a `yield`
        // right after the alias's block, then an `await` before the next
        // yield) — neither hoists it.
        const Source = `package I4222AsyncIterVarRef
import System
import System.Collections.Generic
import System.Threading.Tasks
func gen() IAsyncEnumerable[int32] {
    var values = []int32{10}
    {
        var ref alias = values[0]
        alias = 42
    }
    yield values[0]
    await Task.Delay(1)
    yield 0
}
await for x in gen() {
    Console.WriteLine(x)
}
`
        let (output, hasByRefFields) = CompileAndRun(
            Source,
            "AsyncIterator_VarRefAlias_ConsumedBeforeYield_AwaitFollows_Returns42"
        )
        Assert.Contains("42", output)
        Assert.False(hasByRefFields)
    }

    shared {
        /// Compiles, runs, and — while the collectible (cref:AssemblyLoadContext)
        /// is still alive — scans every type in the emitted assembly (nested
        /// state-machine types included, since (cref:Assembly.GetTypes)
        /// returns nested types too) for a field whose type is a managed
        /// pointer. Issue #4222's definition of done requires this to be false
        /// regardless of how many locals — hoisted or not — the compiled
        /// program's state machines carry.
        private func CompileAndRun(source string, contextName string)(Output string, HasByRefFields bool) {
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
                let hasByRefFields = asm
                    .GetTypes()
                    .SelectMany(
                    func (t Type) IEnumerable[FieldInfo] {
                        return t.GetFields(
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance
                        )
                    }
                )
                    .Any((f FieldInfo) -> f.FieldType.IsByRef)
                return (captured.ToString(), hasByRefFields)
            } finally {
                loadContext.Unload()
            }
        }
    }
}
