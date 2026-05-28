// <copyright file="AsyncSequenceTypeClauseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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
/// End-to-end tests for ADR-0042: <c>async sequence[T]</c> as a type-clause
/// spelling for <c>IAsyncEnumerable[T]</c> in any type-clause position
/// (parameters, locals, fields, generic arguments, function-type return
/// slots, etc.). Most of the verification is via reflection on emitted
/// metadata, because GSharp marks any function returning
/// <c>IAsyncEnumerable[T]</c> as an async iterator (ADR-0041) regardless of
/// whether the body yields.
/// </summary>
public class AsyncSequenceTypeClauseTests
{
    [Fact]
    public void AsyncSequenceTypeClause_ParameterPosition_HasAsyncEnumerableClrType()
    {
        // A sync function that accepts `async sequence[int]` and forwards it
        // to another sink. We only verify the parameter type at the metadata
        // level — the body is `return null` to keep the iterator rewriter
        // from interfering with the call site.
        const string Source = @"package AsyncSeqParam
import System
import System.Collections.Generic
import System.Threading.Tasks

func describe(stream async sequence[int32]) {
    Console.Out.WriteLine(""ok"")
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncSequenceTypeClause_ParameterPosition_HasAsyncEnumerableClrType));
        try
        {
            var method = GetProgramMethod(asm, "describe");
            var parameters = method.GetParameters();
            Assert.Single(parameters);
            Assert.Equal(typeof(IAsyncEnumerable<int>), parameters[0].ParameterType);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncSequenceTypeClause_LocalDeclaration_BindsToAsyncEnumerable()
    {
        // A local typed `async sequence[int]` is hoisted to a state-machine
        // field when used inside an async function. We verify via reflection
        // that the field exists with the expected CLR type, which proves the
        // local's type clause bound to IAsyncEnumerable[int].
        const string Source = @"package AsyncSeqLocal
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
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncSequenceTypeClause_LocalDeclaration_BindsToAsyncEnumerable));
        try
        {
            // Look at every type in the assembly for a field whose type is
            // IAsyncEnumerable<int>; the hoisted local should be exactly that.
            var hasField = asm.GetTypes()
                .SelectMany(t => t.GetFields(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
                .Any(f => f.FieldType == typeof(IAsyncEnumerable<int>));
            Assert.True(
                hasField,
                "Expected at least one emitted field of type IAsyncEnumerable<int32> from the hoisted local.");
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncSequenceTypeClause_AndExplicitIAsyncEnumerable_AreSameClrType()
    {
        // Explicit modifier `async sequence[int]` and the BCL spelling
        // `IAsyncEnumerable[int]` must produce identical CLR signatures.
        const string Source = @"package AsyncSeqEquiv
import System
import System.Collections.Generic
import System.Threading.Tasks

func viaModifier(s async sequence[int32]) {
}

func viaBcl(s IAsyncEnumerable[int32]) {
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncSequenceTypeClause_AndExplicitIAsyncEnumerable_AreSameClrType));
        try
        {
            var viaModifier = GetProgramMethod(asm, "viaModifier");
            var viaBcl = GetProgramMethod(asm, "viaBcl");
            Assert.Equal(typeof(IAsyncEnumerable<int>), viaModifier.GetParameters()[0].ParameterType);
            Assert.Equal(typeof(IAsyncEnumerable<int>), viaBcl.GetParameters()[0].ParameterType);
            Assert.Equal(viaModifier.GetParameters()[0].ParameterType, viaBcl.GetParameters()[0].ParameterType);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncSequenceTypeClause_DiagnosticWhenAsyncIsNotFollowedBySequence()
    {
        // `async` as a type-clause prefix is reserved for `sequence` today.
        const string Source = @"package AsyncSeqInvalid
import System

func bad(s async int32) {
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.False(result.Success);
        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains("'async' modifier in a type clause is only valid before 'sequence[T]'", StringComparison.Ordinal));
    }

    [Fact]
    public void AsyncSequenceTypeClause_InReturnSlot_MatchesAdr0041Swap()
    {
        // ADR-0041: `async func foo() sequence[int]` implicitly swaps to
        // IAsyncEnumerable[int].
        // ADR-0042: `async func foo() async sequence[int]` says it explicitly.
        // Both should produce the same return type.
        const string Source = @"package AsyncSeqReturn
import System
import System.Collections.Generic
import System.Threading.Tasks

async func implicitSwap() sequence[int32] {
    yield 1
}

async func explicitModifier() async sequence[int32] {
    yield 2
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncSequenceTypeClause_InReturnSlot_MatchesAdr0041Swap));
        try
        {
            var implicitSwap = GetProgramMethod(asm, "implicitSwap");
            var explicitModifier = GetProgramMethod(asm, "explicitModifier");
            Assert.Equal(typeof(IAsyncEnumerable<int>), implicitSwap.ReturnType);
            Assert.Equal(typeof(IAsyncEnumerable<int>), explicitModifier.ReturnType);
        }
        finally
        {
            ctx.Unload();
        }
    }

    private static MethodInfo GetProgramMethod(Assembly asm, string name)
    {
        var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(programType);
        var method = programType!.GetMethod(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!;
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
}
