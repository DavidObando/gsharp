// <copyright file="Adr0185TupleDestructuringParameterEmitTests.cs" company="GSharp">
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
/// ADR-0185 — end-to-end emit tests for tuple-destructuring arrow-lambda
/// parameters (<c>((x string, y int)) -&gt; g(x, y)</c>), the language feature
/// that retires cs2gs's <c>__q{N}</c> synthetic-identifier family (issue
/// #4304). Compiles a real program, runs it, and asserts on the actual
/// output — this repo's established <c>*EmitTests.cs</c> pattern (see
/// <c>Issue1172ArrowLambdaParityEmitTests</c>).
/// </summary>
public class Adr0185TupleDestructuringParameterEmitTests
{
    [Fact]
    public void DestructuredParameter_TwoElements_UnpacksAndComputes()
    {
        const string Source = @"package P1

func main() int32 {
    let f = ((x int32, y int32)) -> x + y
    return f((3, 4))
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DestructuredParameter_TwoElements_UnpacksAndComputes));
        try
        {
            Assert.Equal(7, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void DestructuredParameter_ThreeElements_MixedTypes()
    {
        const string Source = @"package P2
import System

func main() int32 {
    let f = ((name string, count int32, active bool)) -> {
        if !active {
            return 0
        }

        return name.Length + count
    }
    return f((""hi"", 5, true))
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DestructuredParameter_ThreeElements_MixedTypes));
        try
        {
            Assert.Equal(7, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void DestructuredParameter_DiscardElement_Ignored()
    {
        // The `_` element is bound but never referenceable — mirrors the
        // statement-position `let (x, _) = e` discard (ADR-0032/0168).
        const string Source = @"package P3

func main() int32 {
    let f = ((x int32, _ int32)) -> x
    return f((10, 999))
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DestructuredParameter_DiscardElement_Ignored));
        try
        {
            Assert.Equal(10, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void DestructuredParameter_BlockBody_PreludeRunsBeforeOwnStatements()
    {
        // The destructuring prelude must run BEFORE any statement the
        // lambda's own block body writes, since those statements may
        // reference the destructured names.
        const string Source = @"package P4

func main() int32 {
    let f = ((x int32, y int32)) -> {
        let sum = x + y
        return sum * 2
    }
    return f((3, 4))
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DestructuredParameter_BlockBody_PreludeRunsBeforeOwnStatements));
        try
        {
            Assert.Equal(14, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void DestructuredParameter_SecondPositionAmongOrdinaryParameters()
    {
        // ADR-0185 does not restrict destructuring to the sole/first
        // parameter — an ordinary parameter and a destructured one may
        // coexist in either order.
        const string Source = @"package P5

func main() int32 {
    let f = (z int32, (x int32, y int32)) -> z + x + y
    return f(1, (2, 3))
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DestructuredParameter_SecondPositionAmongOrdinaryParameters));
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
    public void OrdinaryTupleTypedParameter_RegressionStillWorks()
    {
        // ADR-0185's regression guard: a single parameter whose TYPE happens
        // to be a parenthesized tuple must keep meaning exactly that — one
        // parameter named `pair`, of tuple type — not silently become a
        // destructured pattern.
        const string Source = @"package P6

func main() int32 {
    let f = (pair (int32, int32)) -> pair.Item1 + pair.Item2
    return f((5, 6))
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(OrdinaryTupleTypedParameter_RegressionStillWorks));
        try
        {
            Assert.Equal(11, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void DestructuredParameter_AsyncLambda_Unpacks()
    {
        const string Source = @"package P7
import System.Threading.Tasks

func main() int32 {
    let f = async ((x int32, y int32)) -> {
        return x + y
    }
    return f((4, 5)).Result
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DestructuredParameter_AsyncLambda_Unpacks));
        try
        {
            Assert.Equal(9, GetProgramMethod(asm, "main").Invoke(null, null));
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
