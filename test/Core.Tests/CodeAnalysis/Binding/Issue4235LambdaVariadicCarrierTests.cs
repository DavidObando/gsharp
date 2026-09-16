// <copyright file="Issue4235LambdaVariadicCarrierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4235: a named delegate's variadic carrier (ADR-0173 / #3627, e.g.
/// <c>...List[T]</c>) was resolved correctly for the DELEGATE declaration
/// but not for a LAMBDA assigned to it — <c>LambdaBinder</c> still had the
/// pre-ADR-0173 unconditional <c>...T</c> -&gt; <c>[]T</c> wrap left over from
/// #812, so an explicitly typed <c>xs ...List[int32]</c> lambda parameter
/// bound as <c>[]List[int32]</c> (a slice OF the carrier) instead of the
/// carrier itself, and assigning the lambda to the delegate failed GS0155
/// ("Cannot convert type 'List[int32]' to '[]List[int32]'"). Fixed by
/// routing both lambda-parameter binding sites (function-literal and arrow
/// lambda) through the same <c>VariadicCarriers.ResolveDeclaredParameterType</c>
/// helper that delegate/function declarations already used.
/// </summary>
public class Issue4235LambdaVariadicCarrierTests
{
    [Fact]
    public void ArrowLambda_ListCarrier_AssignsToMatchingDelegate()
    {
        // The issue's standalone repro, made runtime-observable: the
        // assignment itself is the defect (no invocation was needed to
        // reproduce GS0155), but a real call proves the carrier is bound
        // correctly end to end, not just "no longer rejected".
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            delegate D(a int32, xs ...List[int32]) int32;
            let d D = (a int32, xs ...List[int32]) -> a + xs.Count
            d(1, 2, 3)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ArrowLambda_ListCarrier_TargetTypedInference_OmittedParameterTypes()
    {
        // Every other test in this file writes the lambda parameter types out
        // explicitly (the shape the issue's own repro uses, and the one the
        // defect lived in). This one omits them so the target-typed
        // inference path (p.Type == null in LambdaBinder) is also exercised
        // end to end, confirming it was already correct and stayed so.
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            delegate D(a int32, xs ...List[int32]) int32;
            let d D = (a, xs) -> a + xs.Count
            d(1, 2, 3)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ArrowLambda_ListCarrier_ZeroVariadicArguments()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            delegate D(a int32, xs ...List[int32]) int32;
            let d D = (a int32, xs ...List[int32]) -> a + xs.Count
            d(10)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void ArrowLambda_ListCarrier_PassThroughExistingList()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            delegate D(xs ...List[int32]) int32;
            let d D = (xs ...List[int32]) -> xs.Count
            let existing = List[int32]()
            existing.Add(1)
            existing.Add(2)
            d(existing)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void FunctionLiteral_ListCarrier_AssignsToMatchingDelegate()
    {
        // Same defect, second binding site: `func(...) {}` function-literal
        // lambdas (LambdaBinder.PrepareFunctionLiteralSignature) had the
        // identical unconditional slice wrap.
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            delegate D(xs ...List[int32]) int32;
            let d D = func(xs ...List[int32]) int32 {
                return xs.Count
            }
            d(1, 2, 3, 4)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void ArrowLambda_ListCarrier_InferredFunctionType_NoNamedDelegate()
    {
        // No named delegate: the lambda's own inferred function type must
        // carry the resolved carrier, exercising the indirect-call packing
        // path in OverloadResolver.Arguments for a lambda-typed callee.
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            let f = (xs ...List[int32]) -> xs.Count
            f(1, 2, 3)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ArrowLambda_ArrayOfListCarrier_StillBindsAsArray()
    {
        // The real "array of List" shape (`...[]List[T]`) must keep meaning
        // an array whose elements are List[T] — the fix must not collapse
        // this distinct, intentional shape into the List[T] carrier.
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            delegate D(xs ...[]List[int32]) int32;
            let d D = (xs ...[]List[int32]) -> xs.Length
            let inner = List[int32]()
            inner.Add(9)
            d(inner, inner)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void ArrowLambda_NestedListOfListCarrier()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            delegate D(xs ...List[List[int32]]) int32;
            let d D = (xs ...List[List[int32]]) -> xs.Count
            let inner = List[int32]()
            inner.Add(1)
            d(inner, inner)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void ArrowLambda_DictionaryElement_KeepsElementInterpretation()
    {
        // Dictionary[K, V] is not an allowlisted carrier shape (it takes two
        // type arguments; VariadicCarriers only recognizes the
        // single-argument carrier family), so `...Dictionary[K, V]` keeps
        // the ADR-0101 element meaning: an implicit `[]Dictionary[K, V]`
        // carrier of Dictionary elements. Both the delegate and the
        // assigned lambda must agree on that, same as before this fix.
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            delegate D(xs ...Dictionary[string, int32]) int32;
            let d D = (xs ...Dictionary[string, int32]) -> xs.Length
            let m = Dictionary[string, int32]()
            d(m, m)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void ArrowLambda_IEnumerableCarrier_AssignsToMatchingDelegate()
    {
        // A second carrier family (interface, not List) proves the fix is
        // not List-specific — it routes through the same
        // VariadicCarriers.IsCarrierType classification as every other shape.
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            delegate D(xs ...IEnumerable[int32]) int32;
            let d D = (xs ...IEnumerable[int32]) -> {
                var t = 0
                for v in xs {
                    t = t + v
                }
                return t
            }
            d(1, 2, 3)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ArrowLambda_MismatchedCarrier_StillReportsGS0155()
    {
        // Regression safety: a genuinely mismatched carrier (delegate wants
        // List[int32], lambda declares plain int32 -> implicit []int32) must
        // still be rejected. The fix must not silently widen conversions.
        var diagnostics = Errors("""
            import System.Collections.Generic

            delegate D(a int32, xs ...List[int32]) int32;
            let d D = (a int32, xs ...int32) -> a + xs.Length
            """);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0155");
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
