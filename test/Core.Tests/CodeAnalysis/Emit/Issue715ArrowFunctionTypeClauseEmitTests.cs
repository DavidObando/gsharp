// <copyright file="Issue715ArrowFunctionTypeClauseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
/// Issue #715 / ADR-0075 — end-to-end emit tests for the canonical
/// arrow-form function-type clause <c>(T) -&gt; R</c> in real programs.
/// Verifies that emitted delegate types and assignments behave identically
/// to the legacy <c>func(T) R</c> spelling.
/// </summary>
public class Issue715ArrowFunctionTypeClauseEmitTests
{
    [Fact]
    public void ArrowFunctionType_OnParameter_EmitsFuncDelegate()
    {
        const string Source = @"package ArrowFuncParam
import System

func runEach(cb (int32) -> int32) {
    Console.Out.WriteLine(""ok"")
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ArrowFunctionType_OnParameter_EmitsFuncDelegate));
        try
        {
            var method = GetProgramMethod(asm, "runEach");
            var parameters = method.GetParameters();
            Assert.Single(parameters);

            var paramType = parameters[0].ParameterType;
            var invoke = paramType.GetMethod("Invoke");
            Assert.NotNull(invoke);
            Assert.Equal(typeof(int), invoke!.ReturnType);
            Assert.Single(invoke.GetParameters());
            Assert.Equal(typeof(int), invoke.GetParameters()[0].ParameterType);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncArrowFunctionType_OnParameter_EmitsFuncDelegateReturningTask()
    {
        const string Source = @"package AsyncArrowFuncParam
import System
import System.Threading.Tasks

func runEach(cb async (int32) -> int32) {
    Console.Out.WriteLine(""ok"")
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(AsyncArrowFunctionType_OnParameter_EmitsFuncDelegateReturningTask));
        try
        {
            var method = GetProgramMethod(asm, "runEach");
            var parameters = method.GetParameters();
            Assert.Single(parameters);

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
    public void ArrowAndLegacyForms_EmitTheSameDelegateType()
    {
        // The two spellings must produce the same FunctionTypeSymbol, which
        // means the emitter must reuse the same delegate type for both.
        const string Source = @"package ArrowParity
import System

func arrow(cb (int32) -> int32) { }
func legacy(cb func(int32) int32) { }
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ArrowAndLegacyForms_EmitTheSameDelegateType));
        try
        {
            var arrowParam = GetProgramMethod(asm, "arrow").GetParameters()[0].ParameterType;
            var legacyParam = GetProgramMethod(asm, "legacy").GetParameters()[0].ParameterType;
            Assert.Same(arrowParam, legacyParam);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ArrowFunctionType_OnLocal_RoundTripsThroughLambdaInvocation()
    {
        const string Source = @"package ArrowLocal
import System

func main() int32 {
    var add (int32, int32) -> int32 = (a int32, b int32) -> a + b
    return add(40, 2)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ArrowFunctionType_OnLocal_RoundTripsThroughLambdaInvocation));
        try
        {
            var method = GetProgramMethod(asm, "main");
            var result = method.Invoke(null, null);
            Assert.Equal(42, result);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ArrowFunctionType_OnLocal_AcceptsMethodGroup()
    {
        const string Source = @"package ArrowMethodGroup
import System

func twice(x int32) int32 { return x * 2 }

func main() int32 {
    var g (int32) -> int32 = twice
    return g(21)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ArrowFunctionType_OnLocal_AcceptsMethodGroup));
        try
        {
            var method = GetProgramMethod(asm, "main");
            var result = method.Invoke(null, null);
            Assert.Equal(42, result);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ArrowFunctionType_PassingLambdaThroughParameter_Works()
    {
        const string Source = @"package ArrowLambdaParam
import System

func apply(f (int32) -> int32, v int32) int32 { return f(v) }

func main() int32 {
    return apply((x int32) -> x * 3, 14)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ArrowFunctionType_PassingLambdaThroughParameter_Works));
        try
        {
            var method = GetProgramMethod(asm, "main");
            var result = method.Invoke(null, null);
            Assert.Equal(42, result);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ArrowFunctionType_ReturnedFromFunction_Works()
    {
        const string Source = @"package ArrowReturned
import System

func makeAdder(delta int32) (int32) -> int32 { return (x int32) -> x + delta }

func main() int32 {
    var addTen = makeAdder(10)
    return addTen(32)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ArrowFunctionType_ReturnedFromFunction_Works));
        try
        {
            var method = GetProgramMethod(asm, "main");
            var result = method.Invoke(null, null);
            Assert.Equal(42, result);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ArrowFunctionType_VoidReturn_Works()
    {
        const string Source = @"package ArrowVoid
import System

func main() int32 {
    var g () -> void = () -> Console.Out.WriteLine(""ok"")
    g()
    return 42
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ArrowFunctionType_VoidReturn_Works));
        try
        {
            var method = GetProgramMethod(asm, "main");
            var result = method.Invoke(null, null);
            Assert.Equal(42, result);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ArrowFunctionType_TupleReturn_Works()
    {
        const string Source = @"package ArrowTupleReturn
import System

func split(s string) (string, int32) { return (s, s.Length) }

func main() int32 {
    var splitter (string) -> (string, int32) = split
    var t = splitter(""hello"")
    return t.Item2
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ArrowFunctionType_TupleReturn_Works));
        try
        {
            var method = GetProgramMethod(asm, "main");
            var result = method.Invoke(null, null);
            Assert.Equal(5, result);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void LegacyFuncForm_StillCompiles_EmitsGS0303_Warning()
    {
        const string Source = @"package LegacyDeprecated
import System

func runEach(cb func(int32) int32) {
    Console.Out.WriteLine(""ok"")
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.True(result.Success, "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        var warnings = result.Diagnostics.Where(d => d.Id == "GS0303").ToList();
        Assert.Single(warnings);
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
