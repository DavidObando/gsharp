// <copyright file="Issue4222RefAliasSuspensionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #4222: end-to-end PE round-trip tests proving a native <c>let
/// ref</c>/<c>var ref</c> alias local, confined to one execution segment
/// (never live across an <c>await</c>/<c>yield</c> suspension point), now
/// compiles and runs correctly in async functions, iterators, and async
/// iterators — the two G# repros from the issue plus their <c>let ref</c>
/// siblings and an async-iterator combination, each producing the expected
/// runtime value and emitting no by-ref-typed state-machine field.
/// </summary>
public class Issue4222RefAliasSuspensionEmitTests
{
    [Fact]
    public void Async_VarRefAliasOfArrayElement_ConsumedBeforeAwait_Returns42()
    {
        // The issue's own async repro, verbatim.
        const string Source = @"package I4222AsyncVarRef
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
";
        var (output, hasByRefFields) = CompileAndRun(Source, nameof(Async_VarRefAliasOfArrayElement_ConsumedBeforeAwait_Returns42));
        Assert.Contains("42", output);
        Assert.False(hasByRefFields);
    }

    [Fact]
    public void Async_LetRefAliasOfArrayElement_ConsumedBeforeAwait_Returns42()
    {
        // `let ref` sibling: a read-only alias, only ever read, still
        // confined to before the await.
        const string Source = @"package I4222AsyncLetRef
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
";
        var (output, hasByRefFields) = CompileAndRun(Source, nameof(Async_LetRefAliasOfArrayElement_ConsumedBeforeAwait_Returns42));
        Assert.Contains("42", output);
        Assert.False(hasByRefFields);
    }

    [Fact]
    public void Iterator_VarRefAliasOfArrayElement_ConsumedBeforeYield_Returns42()
    {
        // The issue's own iterator repro, verbatim.
        const string Source = @"package I4222IterVarRef
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
";
        var (output, hasByRefFields) = CompileAndRun(Source, nameof(Iterator_VarRefAliasOfArrayElement_ConsumedBeforeYield_Returns42));
        Assert.Contains("42", output);
        Assert.False(hasByRefFields);
    }

    [Fact]
    public void Iterator_LetRefAliasOfArrayElement_ConsumedBeforeYield_Returns42()
    {
        const string Source = @"package I4222IterLetRef
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
";
        var (output, hasByRefFields) = CompileAndRun(Source, nameof(Iterator_LetRefAliasOfArrayElement_ConsumedBeforeYield_Returns42));
        Assert.Contains("42", output);
        Assert.False(hasByRefFields);
    }

    [Fact]
    public void AsyncIterator_VarRefAlias_ConsumedBeforeYield_AwaitFollows_Returns42()
    {
        // An async-iterator route: the alias is confined to a segment before
        // BOTH kinds of suspension point the function contains (a `yield`
        // right after the alias's block, then an `await` before the next
        // yield) — neither hoists it.
        const string Source = @"package I4222AsyncIterVarRef
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
";
        var (output, hasByRefFields) = CompileAndRun(Source, nameof(AsyncIterator_VarRefAlias_ConsumedBeforeYield_AwaitFollows_Returns42));
        Assert.Contains("42", output);
        Assert.False(hasByRefFields);
    }

    /// <summary>
    /// Compiles, runs, and — while the collectible <see cref="AssemblyLoadContext"/>
    /// is still alive — scans every type in the emitted assembly (nested
    /// state-machine types included, since <see cref="Assembly.GetTypes"/>
    /// returns nested types too) for a field whose type is a managed
    /// pointer. Issue #4222's definition of done requires this to be false
    /// regardless of how many locals — hoisted or not — the compiled
    /// program's state machines carry.
    /// </summary>
    private static (string Output, bool HasByRefFields) CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            var hasByRefFields = asm.GetTypes()
                .SelectMany(t => t.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance))
                .Any(f => f.FieldType.IsByRef);

            return (captured.ToString(), hasByRefFields);
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
