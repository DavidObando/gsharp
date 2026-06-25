// <copyright file="Issue1150IntegerWideningBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1150: implicit, lossless integer widening is applied when matching a
/// typed integer value (including a lambda body) to an expected integer type
/// during overload resolution, argument/lambda-return conversion, and binary
/// operators. This mirrors C#'s implicit-conversion lattice
/// (<c>byte→int</c>, <c>uint→long</c>, <c>int→long</c>, …). Narrowing and
/// non-widening mixed pairs still require an explicit cast.
/// </summary>
public class Issue1150IntegerWideningBinderTests
{
    // ── PRIMARY repro: LINQ Sum over a uint32 selector ─────────────────

    [Fact]
    public void SumOverUInt32Selector_ResolvesToInt64Overload_NoDiagnostics()
    {
        // The selector `(i Item) -> i.Size` has natural type Func<Item,uint32>.
        // uint32 widens to int64, selecting Enumerable.Sum(Func<T,long>) — so
        // the Sum result is int64 and `int32(...)` of it is valid. If the
        // widening did not apply, Sum would appear "not found" (GS0159) and
        // the lambda parameter `i` would never be typed, cascading GS0158
        // "cannot find member" on `i.Size`.
        var source = @"
package p
import System.Collections.Generic
import System.Linq
class Item { var Size uint32 }
class C {
    func TotalU(items List[Item]) int32 {
        return int32(items.Sum((i Item) -> i.Size))
    }
}
";
        var errors = Errors(source);
        Assert.Empty(errors);
    }

    [Fact]
    public void SumOverUInt32Selector_NoMemberCascade()
    {
        // Specifically assert the lambda parameter gets typed (no GS0158
        // "cannot find member" cascade) and Sum is found (no GS0159).
        var source = @"
package p
import System.Collections.Generic
import System.Linq
class Item { var Size uint32 }
class C {
    func TotalU(items List[Item]) int32 {
        return int32(items.Sum((i Item) -> i.Size))
    }
}
";
        var errors = Errors(source);
        Assert.DoesNotContain(errors, d => d.Id == "GS0159");
        Assert.DoesNotContain(errors, d => d.Id == "GS0158");
    }

    // ── Lambda return widening to a delegate parameter ─────────────────

    [Fact]
    public void LambdaReturnWidening_ToUserFunctionDelegateParam_Compiles()
    {
        // `(x int32) -> uint16(x)` has natural type Func<int32,uint16>; uint16
        // widens to int64, so it is applicable to Func<int32,int64>.
        var source = @"
package p
import System
class C {
    func Apply(f Func[int32,int64]) int64 { return f(10) }
    func Use() int64 { return this.Apply((x int32) -> uint16(x)) }
}
";
        Assert.Empty(Errors(source));
    }

    // ── Binary mixed-width integer operators ───────────────────────────

    [Theory]
    [InlineData("a uint32, b int64", "a + b", "int64")]
    [InlineData("a uint8, b int32", "a + b", "int32")]
    [InlineData("a int32, b int64", "a + b", "int64")]
    [InlineData("a uint32, b int64", "a - b", "int64")]
    [InlineData("a uint32, b int64", "a * b", "int64")]
    [InlineData("a uint8, b int32", "a | b", "int32")]
    [InlineData("a uint8, b int32", "a & b", "int32")]
    [InlineData("a uint8, b int32", "a ^ b", "int32")]
    public void BinaryMixedWidth_WidensAndBinds(string parms, string expr, string ret)
    {
        var source = Wrap($"func F({parms}) {ret} {{ return {expr} }}");
        Assert.Empty(Errors(source));
    }

    [Theory]
    [InlineData("a < b")]
    [InlineData("a > b")]
    [InlineData("a == b")]
    [InlineData("a != b")]
    [InlineData("a <= b")]
    [InlineData("a >= b")]
    public void BinaryMixedWidth_Comparisons_ProduceBool(string expr)
    {
        var source = Wrap($"func F(a uint32, b int64) bool {{ return {expr} }}");
        Assert.Empty(Errors(source));
    }

    // ── Guardrails: non-widening / narrowing / lossy still error ───────

    [Fact]
    public void BinaryNonWideningPair_Int32VsUInt32_StillErrorsGS0129()
    {
        // Neither int32 nor uint32 implicitly converts to the other, so the
        // operator stays unbound (no C# int+uint→long promotion in G#).
        var source = Wrap("func F(a int32, b uint32) int64 { return int64(a + b) }");
        Assert.Contains(Errors(source), d => d.Id == "GS0129");
    }

    [Fact]
    public void BinaryNarrowing_RequiresCast_StillErrors()
    {
        // int64 var assigned into an int32 local is a narrowing — still GS0156.
        var source = Wrap("func F(a int64) int32 { let x int32 = a return x }");
        Assert.Contains(Errors(source), d => d.Id == "GS0156");
    }

    [Fact]
    public void LambdaReturnNarrowing_ToDelegateParam_StillErrors()
    {
        // int64 does NOT widen to int32, so the literal is inapplicable.
        var source = @"
package p
import System
class C {
    func Apply(f Func[int32,int32]) int32 { return f(10) }
    func Use() int32 { return this.Apply((x int32) -> int64(x)) }
}
";
        Assert.NotEmpty(Errors(source));
    }

    [Fact]
    public void LambdaReturnFloat_ToIntDelegateParam_StillErrors()
    {
        // float→int is lossy and must NOT be applied implicitly.
        var source = @"
package p
import System
class C {
    func Apply(f Func[int32,int64]) int64 { return f(10) }
    func Use() int64 { return this.Apply((x int32) -> 1.5) }
}
";
        Assert.NotEmpty(Errors(source));
    }

    private static string Wrap(string member)
    {
        return @"
package p
class C {
    " + member + @"
}
";
    }

    private static IReadOnlyList<Diagnostic> Errors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
    }
}
