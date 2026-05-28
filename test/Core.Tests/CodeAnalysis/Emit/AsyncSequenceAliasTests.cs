// <copyright file="AsyncSequenceAliasTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// End-to-end tests for ADR-0041: in the return-type position of an
/// <c>async func</c>, the <c>sequence[T]</c> alias resolves to
/// <c>IAsyncEnumerable[T]</c>. Outside that position, it continues to mean
/// <c>IEnumerable[T]</c> (ADR-0040).
/// </summary>
public class AsyncSequenceAliasTests
{
    [Fact]
    public void AsyncSequenceAlias_YieldOnly_ProducesValues()
    {
        const string Source = @"package AsyncSeqAlias
import System
import System.Collections.Generic
import System.Threading.Tasks

async func numbers() sequence[int32] {
    yield 1
    yield 2
    yield 3
}
";
        var items = CompileAndEnumerateAsync<int>(Source, "numbers", nameof(AsyncSequenceAlias_YieldOnly_ProducesValues));
        Assert.Equal(new[] { 1, 2, 3 }, items);
    }

    [Fact]
    public void AsyncSequenceAlias_YieldWithAwait_ProducesValues()
    {
        const string Source = @"package AsyncSeqAliasAwait
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
";
        var items = CompileAndEnumerateAsync<int>(Source, "numbers", nameof(AsyncSequenceAlias_YieldWithAwait_ProducesValues));
        Assert.Equal(new[] { 10, 20, 30 }, items);
    }

    [Fact]
    public void AsyncSequenceAlias_ResultImplementsIAsyncEnumerable()
    {
        const string Source = @"package AsyncSeqAliasShape
import System
import System.Collections.Generic
import System.Threading.Tasks

async func gen() sequence[int32] {
    yield 1
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncSequenceAlias_ResultImplementsIAsyncEnumerable));
        try
        {
            var result = InvokeFunction(asm, "gen", null);
            Assert.IsAssignableFrom<IAsyncEnumerable<int>>(result);
            Assert.False(result is IEnumerable<int>, "async-sequence return must not also be IEnumerable<int32>");
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void SyncSequence_NoAsyncModifier_StillIEnumerable()
    {
        const string Source = @"package SyncSeqStable
import System
import System.Collections.Generic

func numbers() sequence[int32] {
    yield 1
    yield 2
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(SyncSequence_NoAsyncModifier_StillIEnumerable));
        try
        {
            var result = InvokeFunction(asm, "numbers", null);
            Assert.IsAssignableFrom<IEnumerable<int>>(result);
            Assert.False(result is IAsyncEnumerable<int>, "sync-sequence return must not be IAsyncEnumerable<int32>");
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncSequenceAlias_ParameterPosition_StaysSyncEnumerable()
    {
        // ADR-0041: the alias swap applies only to the return-type slot.
        // Parameter `items` is sequence[int] inside an async func — it must
        // still bind to IEnumerable[int] so we can pass a normal collection.
        const string Source = @"package AsyncSeqParam
import System
import System.Collections.Generic
import System.Threading.Tasks

async func echo(items sequence[int32]) sequence[int32] {
    for x in items {
        yield x
    }
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncSequenceAlias_ParameterPosition_StaysSyncEnumerable));
        try
        {
            // Pass a synchronous IEnumerable<int> as the argument.
            IEnumerable<int> arg = new[] { 7, 8, 9 };
            var result = InvokeFunction(asm, "echo", new object[] { arg });
            var items = ConsumeAsyncEnumerable<int>(result);
            Assert.Equal(new[] { 7, 8, 9 }, items);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncSequenceAlias_AndExplicitIAsyncEnumerable_AreSameClrType()
    {
        // Two functions, one spelled with the alias, the other with the BCL
        // type, should expose the same CLR return type.
        const string Source = @"package AsyncSeqEquiv
import System
import System.Collections.Generic
import System.Threading.Tasks

async func viaAlias() sequence[int32] {
    yield 1
}

func viaExplicit() IAsyncEnumerable[int32] {
    yield 2
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncSequenceAlias_AndExplicitIAsyncEnumerable_AreSameClrType));
        try
        {
            var programType = asm.GetTypes().First(t => t.Name == "<Program>");
            var alias = programType.GetMethod("viaAlias", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            var explicitly = programType.GetMethod("viaExplicit", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(alias);
            Assert.NotNull(explicitly);
            Assert.Equal(alias!.ReturnType, explicitly!.ReturnType);
            Assert.Equal(typeof(IAsyncEnumerable<int>), alias.ReturnType);
        }
        finally
        {
            ctx.Unload();
        }
    }

    private static List<T> CompileAndEnumerateAsync<T>(string source, string functionName, string contextName)
    {
        var (asm, ctx) = CompileToAssembly(source, contextName);
        try
        {
            var enumerable = InvokeFunction(asm, functionName, null);
            return ConsumeAsyncEnumerable<T>(enumerable);
        }
        finally
        {
            ctx.Unload();
        }
    }

    private static (Assembly asm, AssemblyLoadContext ctx) CompileToAssembly(string source, string contextName)
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
        var asm = loadContext.LoadFromStream(peStream);
        return (asm, loadContext);
    }

    private static object InvokeFunction(Assembly asm, string functionName, object[] args)
    {
        var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(programType);
        var method = programType!.GetMethod(
            functionName,
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!.Invoke(null, args);
    }

    private static List<T> ConsumeAsyncEnumerable<T>(object enumerable)
    {
        var asyncEnumerable = (IAsyncEnumerable<T>)enumerable;
        var enumerator = asyncEnumerable.GetAsyncEnumerator(CancellationToken.None);
        var items = new List<T>();
        try
        {
            while (enumerator.MoveNextAsync().AsTask().GetAwaiter().GetResult())
            {
                items.Add(enumerator.Current);
            }
        }
        finally
        {
            enumerator.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }

        return items;
    }
}
