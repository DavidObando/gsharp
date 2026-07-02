// <copyright file="Issue1620FunctionTypeCacheNestedTypeParamTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1620: the process-wide <see cref="FunctionTypeSymbol"/> cache keyed a
/// composite parameter type (<c>List[T]</c>, <c>[]T</c>, <c>T?</c>, tuples) by
/// its display NAME whenever the type parameter was nested rather than a
/// direct slot. Two distinct generic declarations that both spell their type
/// parameter <c>T</c> and both take a function-typed parameter shaped
/// <c>(List[T]) -&gt; int32</c> produced the SAME name ("(List&lt;T&gt;) -&gt; int32")
/// and therefore aliased in the cache: whichever declaration bound SECOND
/// reused the FIRST declaration's <see cref="TypeParameterSymbol"/> instance,
/// so substitution / lambda-parameter inference at its call sites silently
/// failed (GS0304 / GS0158). Each test below uses a UNIQUE package name
/// because the cache is not cleared between tests (see
/// <see cref="Issue1537GenericNestedInGenericBinderTests"/>).
/// </summary>
public class Issue1620FunctionTypeCacheNestedTypeParamTests
{
    [Fact]
    public void TwoGenericFunctions_SameLetterListOfT_FirstDeclarationOrder_BothBind()
    {
        AssertBothOrdersBind(package: "Issue1620ListOrderA", declareApplyAFirst: true);
    }

    [Fact]
    public void TwoGenericFunctions_SameLetterListOfT_SecondDeclarationOrder_BothBind()
    {
        // Swapping declaration order is the crux of the repro: before the fix
        // whichever of applyA/applyB was declared SECOND lost its own
        // TypeParameterSymbol identity to the cache alias.
        AssertBothOrdersBind(package: "Issue1620ListOrderB", declareApplyAFirst: false);
    }

    [Fact]
    public void TwoGenericFunctions_SameLetterNestedListOfListOfT_BothBind()
    {
        var source = """
            package Issue1620NestedListList
            import System.Collections.Generic

            func applyA[T](xs List[List[T]], f (List[List[T]]) -> int32) int32 {
                return f(xs)
            }
            func applyB[T](xs List[List[T]], f (List[List[T]]) -> int32) int32 {
                return f(xs)
            }
            func Main() {
                var la = List[List[int32]]()
                var ra = applyA(la, (l) -> l.Count)
                var lb = List[List[string]]()
                var rb = applyB(lb, (l) -> l.Count)
            }
            """;
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void TwoGenericFunctions_SameLetterTupleOfT_BothBind()
    {
        var source = """
            package Issue1620TupleT

            func applyA[T](x T, f ((T, int32)) -> int32) int32 {
                return f((x, 1))
            }
            func applyB[T](x T, f ((T, int32)) -> int32) int32 {
                return f((x, 2))
            }
            func Main() {
                var ra = applyA(1, (t) -> t.Item2)
                var rb = applyB("s", (t) -> t.Item2)
            }
            """;
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void TwoGenericFunctions_SameLetterNullableT_BothBind()
    {
        var source = """
            package Issue1620NullableT

            func applyA[T](x T, f (T?) -> int32) int32 {
                return f(x)
            }
            func applyB[T](x T, f (T?) -> int32) int32 {
                return f(x)
            }
            func Main() {
                var ra = applyA(1, (x) -> 1)
                var rb = applyB("s", (x) -> 2)
            }
            """;
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void TwoGenericFunctions_SameLetterArrayOfT_BothBind()
    {
        var source = """
            package Issue1620ArrayT
            import Gsharp.Extensions.Go

            func applyA[T](xs []T, f ([]T) -> int32) int32 {
                return f(xs)
            }
            func applyB[T](xs []T, f ([]T) -> int32) int32 {
                return f(xs)
            }
            func Main() {
                var ra = applyA([]int32{1, 2}, (s) -> len(s))
                var rb = applyB([]string{"a", "b", "c"}, (s) -> len(s))
            }
            """;
        Assert.Empty(GetDiagnostics(source));
    }

    private static void AssertBothOrdersBind(string package, bool declareApplyAFirst)
    {
        var applyA = """
            func applyA[T](xs List[T], f (List[T]) -> int32) int32 {
                return f(xs)
            }
            """;
        var applyB = """
            func applyB[T](xs List[T], f (List[T]) -> int32) int32 {
                return f(xs)
            }
            """;
        var first = declareApplyAFirst ? applyA : applyB;
        var second = declareApplyAFirst ? applyB : applyA;

        var source = $$"""
            package {{package}}
            import System.Collections.Generic

            {{first}}
            {{second}}
            func Main() {
                var la = List[int32]{1, 2, 3}
                var ra = applyA(la, (l) -> l.Count)
                var lb = List[string]{"a", "b"}
                var rb = applyB(lb, (l) -> l.Count)
            }
            """;

        Assert.Empty(GetDiagnostics(source));
    }

    private static IReadOnlyList<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }
}
