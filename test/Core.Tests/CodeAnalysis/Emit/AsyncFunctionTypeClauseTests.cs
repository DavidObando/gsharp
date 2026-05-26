// <copyright file="AsyncFunctionTypeClauseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// End-to-end tests for ADR-0043: <c>async func(P) R</c> as a type-clause
/// spelling for <c>func(P) Task[R]</c> in any type-clause position
/// (parameters, locals, fields, generic arguments, function-type return
/// slots, etc.).
/// </summary>
public class AsyncFunctionTypeClauseTests
{
    [Fact]
    public void AsyncFunctionTypeClause_Parameter_BindsToFuncReturningTaskOfInt()
    {
        const string Source = @"package AsyncFuncParam
import System
import System.Threading.Tasks

func runEach(cb async func(int) int) {
    Console.Out.WriteLine(""ok"")
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncFunctionTypeClause_Parameter_BindsToFuncReturningTaskOfInt));
        try
        {
            var method = GetProgramMethod(asm, "runEach");
            var parameters = method.GetParameters();
            Assert.Single(parameters);

            // The parameter is a delegate type (Func<int, Task<int>>) — verify the
            // Invoke method shape rather than depending on the exact CLR delegate
            // shape GSharp's emitter chose.
            var paramType = parameters[0].ParameterType;
            var invoke = paramType.GetMethod("Invoke");
            Assert.NotNull(invoke);
            Assert.Equal(typeof(Task<int>), invoke!.ReturnType);
            Assert.Single(invoke.GetParameters());
            Assert.Equal(typeof(int), invoke.GetParameters()[0].ParameterType);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncFunctionTypeClause_VoidReturn_AliasesToFuncReturningPlainTask()
    {
        const string Source = @"package AsyncFuncVoid
import System
import System.Threading.Tasks

func runVoid(cb async func(int)) {
    Console.Out.WriteLine(""ok"")
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncFunctionTypeClause_VoidReturn_AliasesToFuncReturningPlainTask));
        try
        {
            var method = GetProgramMethod(asm, "runVoid");
            var paramType = method.GetParameters()[0].ParameterType;
            var invoke = paramType.GetMethod("Invoke");
            Assert.NotNull(invoke);
            Assert.Equal(typeof(Task), invoke!.ReturnType);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncFunctionTypeClause_AndExplicitTaskWrap_AreSameType()
    {
        // `async func(int) int` and `func(int) Task[int]` must resolve to the
        // exact same FunctionTypeSymbol — i.e., the same CLR parameter type.
        const string Source = @"package AsyncFuncEquiv
import System
import System.Threading.Tasks

func viaModifier(cb async func(int) int) {
}

func viaTaskWrap(cb func(int) Task[int]) {
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncFunctionTypeClause_AndExplicitTaskWrap_AreSameType));
        try
        {
            var viaModifier = GetProgramMethod(asm, "viaModifier");
            var viaTaskWrap = GetProgramMethod(asm, "viaTaskWrap");
            Assert.Equal(
                viaModifier.GetParameters()[0].ParameterType,
                viaTaskWrap.GetParameters()[0].ParameterType);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncFunctionTypeClause_InReturnSlot_OfOuterFunction()
    {
        // The outer function `factory` returns `async func() int` — i.e.,
        // `func() Task[int]`. Verify the outer return type's delegate-Invoke
        // shape via reflection.
        const string Source = @"package AsyncFuncReturn
import System
import System.Threading.Tasks

func factory() async func(int) int {
    return async func(x int) int { return x + 1 }
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncFunctionTypeClause_InReturnSlot_OfOuterFunction));
        try
        {
            var factory = GetProgramMethod(asm, "factory");
            var returnType = factory.ReturnType;
            var invoke = returnType.GetMethod("Invoke");
            Assert.NotNull(invoke);
            Assert.Equal(typeof(Task<int>), invoke!.ReturnType);
            Assert.Single(invoke.GetParameters());
            Assert.Equal(typeof(int), invoke.GetParameters()[0].ParameterType);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncFunctionTypeClause_AsyncSequenceReturn_KeepsIAsyncEnumerableUnwrapped()
    {
        // Iterator carve-out: `async func() sequence[int]` and
        // `async func() async sequence[int]` parameter types both resolve to
        // `func() IAsyncEnumerable[int]` — no Task wrap.
        const string Source = @"package AsyncFuncIterReturn
import System
import System.Collections.Generic
import System.Threading.Tasks

func acceptImplicit(cb async func() sequence[int]) {
}

func acceptExplicit(cb async func() async sequence[int]) {
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncFunctionTypeClause_AsyncSequenceReturn_KeepsIAsyncEnumerableUnwrapped));
        try
        {
            var acceptImplicit = GetProgramMethod(asm, "acceptImplicit");
            var acceptExplicit = GetProgramMethod(asm, "acceptExplicit");

            var implicitParamType = acceptImplicit.GetParameters()[0].ParameterType;
            var explicitParamType = acceptExplicit.GetParameters()[0].ParameterType;
            var implicitInvoke = implicitParamType.GetMethod("Invoke");
            var explicitInvoke = explicitParamType.GetMethod("Invoke");
            Assert.NotNull(implicitInvoke);
            Assert.NotNull(explicitInvoke);
            Assert.Equal(typeof(IAsyncEnumerable<int>), implicitInvoke!.ReturnType);
            Assert.Equal(typeof(IAsyncEnumerable<int>), explicitInvoke!.ReturnType);
            Assert.Equal(implicitParamType, explicitParamType);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncFunctionTypeClause_ExplicitTaskReturn_IsRejected()
    {
        // ADR-0043 rejects `async func(...) Task[X]` because the `async`
        // modifier already implies the Task wrap.
        const string Source = @"package AsyncFuncDoubleWrap
import System
import System.Threading.Tasks

func bad(cb async func(int) Task[int]) {
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.False(result.Success);
        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains("implicitly wrapped in 'Task'", StringComparison.Ordinal));
    }

    [Fact]
    public void AsyncPrefix_FollowedByNonFuncNonSequence_IsRejected()
    {
        // After ADR-0043 the legal followers are `func` and `sequence` only.
        const string Source = @"package AsyncBadPrefix
import System

func bad(s async int) {
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.False(result.Success);
        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains("'async' modifier in a type clause is only valid before 'sequence[T]' or 'func(...)'", StringComparison.Ordinal));
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
