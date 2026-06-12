// <copyright file="Issue716LambdaBindingInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
/// Issue #716 / ADR-0076 — end-to-end emit tests for lambda binding type
/// inference: when a <c>let</c> / <c>var</c> binding is initialized with a
/// lambda whose parameter types are all spelled out, the binding's type is
/// inferred to be the lambda's function type <c>(T1, ...) -&gt; R</c>. The
/// emitted IL must call the inferred local through the synthesized Func / Action
/// delegate exactly as if the user had written the function-type clause.
/// </summary>
public class Issue716LambdaBindingInferenceEmitTests
{
    [Fact]
    public void InferredSingleParamLambda_IsCallable()
    {
        const string Source = @"package InferredSquare
import System

func main() int32 {
    var square = (n int32) -> n * n
    return square(7)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(InferredSingleParamLambda_IsCallable));
        try
        {
            var method = GetProgramMethod(asm, "main");
            Assert.Equal(49, method.Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void InferredStringIdentityLambda_IsCallable()
    {
        const string Source = @"package InferredStringId
import System

func main() string {
    let id = (s string) -> s
    return id(""hello"")
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(InferredStringIdentityLambda_IsCallable));
        try
        {
            var method = GetProgramMethod(asm, "main");
            Assert.Equal("hello", method.Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void InferredMultiParamLambda_IsCallable()
    {
        const string Source = @"package InferredMulti
import System

func main() int32 {
    let add = (a int32, b int32) -> a + b
    return add(20, 22)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(InferredMultiParamLambda_IsCallable));
        try
        {
            var method = GetProgramMethod(asm, "main");
            Assert.Equal(42, method.Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void InferredZeroParamLambda_IsCallable()
    {
        const string Source = @"package InferredZero
import System

func main() int32 {
    let always = () -> 42
    return always()
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(InferredZeroParamLambda_IsCallable));
        try
        {
            var method = GetProgramMethod(asm, "main");
            Assert.Equal(42, method.Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void InferredBlockBodyLambda_IsCallable()
    {
        const string Source = @"package InferredBlock
import System

func main() int32 {
    let inc = (n int32) -> { return n + 1 }
    return inc(41)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(InferredBlockBodyLambda_IsCallable));
        try
        {
            var method = GetProgramMethod(asm, "main");
            Assert.Equal(42, method.Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void InferredVoidReturningLambda_IsCallable()
    {
        const string Source = @"package InferredVoid
import System

func main() int32 {
    let log = (msg string) -> Console.Out.WriteLine(msg)
    log(""ok"")
    return 7
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(InferredVoidReturningLambda_IsCallable));
        try
        {
            var method = GetProgramMethod(asm, "main");
            Assert.Equal(7, method.Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void InferredLambda_CapturesLocal()
    {
        const string Source = @"package InferredCapture
import System

func main() int32 {
    let basis = 100
    let addBase = (n int32) -> n + basis
    return addBase(7)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(InferredLambda_CapturesLocal));
        try
        {
            var method = GetProgramMethod(asm, "main");
            Assert.Equal(107, method.Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void InferredLambda_PassesThroughTypedParameter()
    {
        const string Source = @"package InferredPass
import System

func apply(f (int32) -> int32, v int32) int32 { return f(v) }

func main() int32 {
    let triple = (x int32) -> x * 3
    return apply(triple, 14)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(InferredLambda_PassesThroughTypedParameter));
        try
        {
            var method = GetProgramMethod(asm, "main");
            Assert.Equal(42, method.Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void TargetTypedLambda_ParametersCanBeOmitted()
    {
        const string Source = @"package TargetTypedOmit
import System

func main() int32 {
    let twice (int32) -> int32 = (x) -> x * 2
    return twice(21)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(TargetTypedLambda_ParametersCanBeOmitted));
        try
        {
            var method = GetProgramMethod(asm, "main");
            Assert.Equal(42, method.Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void OpenLambdaBinding_EmitsGS0304()
    {
        const string Source = @"package OpenLambda
import System

func main() int32 {
    let f = (x) -> x + 1
    return 0
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        var open = result.Diagnostics.Where(d => d.Id == "GS0304").ToList();
        Assert.NotEmpty(open);
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
