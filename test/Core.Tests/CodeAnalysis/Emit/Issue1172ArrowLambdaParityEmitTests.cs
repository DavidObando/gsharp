// <copyright file="Issue1172ArrowLambdaParityEmitTests.cs" company="GSharp">
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
/// ADR-0128 / issue #1172 — end-to-end emit tests proving a block-bodied arrow
/// lambda <c>(p) -&gt; { … }</c> now behaves as a statement block with an optional
/// trailing value expression (parity with func literals): a non-trailing
/// <c>if</c>-without-<c>else</c> is a void statement, a trailing one yields a void
/// (Action) lambda, explicit <c>return</c> works anywhere, and the return type is
/// inferred — all previously rejected with GS0276. Includes WORKS-today regression
/// guards.
/// </summary>
public class Issue1172ArrowLambdaParityEmitTests
{
    [Fact]
    public void NonTrailingIfWithoutElse_ThenReturn_RunsAndReturnsValue()
    {
        const string Source = @"package P1
import System

func main() int32 {
    let f = (x int32) -> { if x > 0 { Console.WriteLine(""a"") }
return x * 2 }
    return f(3)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(NonTrailingIfWithoutElse_ThenReturn_RunsAndReturnsValue));
        try
        {
            Assert.Equal(6, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void TrailingIfWithoutElse_VoidActionLambda_ExecutesSideEffect()
    {
        // A trailing `if`-without-`else` makes the block produce no value: the
        // lambda is a void Action. Observe the side effect via a captured local.
        const string Source = @"package P2
import System

func main() int32 {
    var seen = 0
    let act = (x int32) -> { if x > 0 { seen = x } }
    act(5)
    return seen
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(TrailingIfWithoutElse_VoidActionLambda_ExecutesSideEffect));
        try
        {
            Assert.Equal(5, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void EarlyReturnInsideIfWithoutElse_RunsBothPaths()
    {
        const string Source = @"package P3
import System

func classify(x int32) int32 {
    let f = (n int32) -> { if n < 0 { return 0 }
return n * 2 }
    return f(x)
}

func main() int32 {
    return classify(3) + classify(-4)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(EarlyReturnInsideIfWithoutElse_RunsBothPaths));
        try
        {
            // classify(3) -> 6, classify(-4) -> 0, total 6.
            Assert.Equal(6, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ExplicitFuncTargetType_IfWithoutElse_RunsAndReturnsValue()
    {
        const string Source = @"package P4
import System

func main() int32 {
    let g Func[int32, int32] = (x int32) -> { if x > 0 { return x }
return 0 }
    return g(5)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ExplicitFuncTargetType_IfWithoutElse_RunsAndReturnsValue));
        try
        {
            Assert.Equal(5, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void NestedIfWithoutElse_InnerIfWithElse_TrailingValue_Runs()
    {
        const string Source = @"package P5
import System

func main() int32 {
    let f = (x int32) -> { if x > 0 { if x > 10 { Console.WriteLine(""big"") } else { Console.WriteLine(""small"") } }
x }
    return f(15)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(NestedIfWithoutElse_InnerIfWithElse_TrailingValue_Runs));
        try
        {
            Assert.Equal(15, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void TrailingIfWithElse_AsValue_Runs()
    {
        const string Source = @"package P6
import System

func main() string {
    let f = (x int32) -> { if x > 0 { ""pos"" } else if x < 0 { ""neg"" } else { ""zero"" } }
    return f(-3)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(TrailingIfWithElse_AsValue_Runs));
        try
        {
            Assert.Equal("neg", GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void AsyncBlockLambda_WithVoidIf_AwaitsAndReturns()
    {
        const string Source = @"package P7
import System
import System.Threading.Tasks

var f = async (x int32) -> { if x > 0 { Console.WriteLine(""pos"") }
return x + 1 }

var t = f(5)
t.Wait()
Console.WriteLine(t.Result)
";
        var output = CompileAndRun(Source, nameof(AsyncBlockLambda_WithVoidIf_AwaitsAndReturns));
        Assert.Contains("pos", output);
        Assert.Contains("6", output);
    }

    [Fact]
    public void TrailingExpressionValueBlock_StillRuns()
    {
        const string Source = @"package P8
import System

func main() int32 {
    let f = (x int32) -> { let y = x + 1
y * 2 }
    return f(3)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(TrailingExpressionValueBlock_StillRuns));
        try
        {
            Assert.Equal(8, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ExpressionBodyLambda_StillRuns()
    {
        const string Source = @"package P9
import System

func main() int32 {
    let f = (x int32) -> x * 2
    return f(3)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ExpressionBodyLambda_StillRuns));
        try
        {
            Assert.Equal(6, GetProgramMethod(asm, "main").Invoke(null, null));
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

    private static string CompileAndRun(string source, string contextName)
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            catch (TargetInvocationException ex) when (ex.InnerException is AggregateException agg)
            {
                throw agg.InnerException ?? agg;
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
