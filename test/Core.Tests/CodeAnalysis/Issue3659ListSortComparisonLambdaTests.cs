// <copyright file="Issue3659ListSortComparisonLambdaTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3659: <c>List[T].Sort(lambda)</c> reported GS0159 "Cannot find
/// function Sort" — the symptom that blocked the migrated
/// <c>src/LanguageServer</c> for #3501 — for two distinct reasons.
/// <para>When the element type is a same-compilation enum, or a tuple carrying
/// a slice of a same-compilation type, the deferred arrow-lambda's symbolic
/// delegate target was closed through the inference-oriented erasure
/// (enum → <c>Int32</c>, slice → <c>object</c>) while the receiver was closed
/// through the type-clause erasure (enum → <c>object</c>, slice →
/// <c>object[]</c>). The rebound lambda's argument type then matched none of
/// the receiver's own candidates, so every <c>Sort</c> overload was rejected.
/// The target's erased CLR shape is now re-anchored on the candidate's own
/// closed parameter type.</para>
/// <para>When the lambda's parameters are untyped, the CLR probe that
/// discovers their target type passed <c>null</c> for the lambda slot, which
/// is applicable to every overload — so <c>Sort</c>'s four-way overload set
/// probed as ambiguous and the parameters never got a target (GS0304, then
/// GS0159). The probe now narrows to the overloads whose lambda slot is
/// actually delegate-shaped with the lambda's arity.</para>
/// <para>Each test asserts the <em>correct</em> overload was selected by
/// checking the list is really reordered by the comparison, not merely that
/// the call binds.</para>
/// </summary>
public class Issue3659ListSortComparisonLambdaTests
{
    [Fact]
    public void SortComparisonLambda_SameCompilationEnumElement_SortsDescending()
    {
        var source = @"
import System.Collections.Generic

enum Tok { A, B, C }

func run() int32 {
    let xs = List[Tok]()
    xs.Add(Tok.C)
    xs.Add(Tok.A)
    xs.Add(Tok.B)
    xs.Sort((a Tok, b Tok) -> int32(b) - int32(a))
    var acc = 0
    for x in xs {
        acc = acc * 10 + int32(x)
    }
    return acc
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));

        // C(2), B(1), A(0) — the Comparison[Tok] overload really ran.
        Assert.Equal(210, result.Value);
    }

    [Fact]
    public void SortComparisonLambda_TupleElementWithUserTypeSlice_SortsAscending()
    {
        var source = @"
import System.Collections.Generic

struct Sp { var Start int32 }

func run() int32 {
    let xs = List[(A int32, B []Sp)]()
    xs.Add((3, []Sp{}))
    xs.Add((1, []Sp{}))
    xs.Add((2, []Sp{}))
    xs.Sort((p (A int32, B []Sp), q (A int32, B []Sp)) -> p.A.CompareTo(q.A))
    var acc = 0
    for t in xs {
        acc = acc * 10 + t.A
    }
    return acc
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(123, result.Value);
    }

    [Fact]
    public void SortComparisonLambda_UntypedParameters_TargetTypeFromComparisonOverload()
    {
        var source = @"
import System.Collections.Generic

func run() int32 {
    let xs = List[int32]()
    xs.Add(1)
    xs.Add(3)
    xs.Add(2)
    xs.Sort((a, b) -> b.CompareTo(a))
    var acc = 0
    for x in xs {
        acc = acc * 10 + x
    }
    return acc
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));

        // Descending — the untyped `a`/`b` inferred int32 from Comparison[int32].
        Assert.Equal(321, result.Value);
    }

    [Fact]
    public void SortComparisonLambda_ImportedStructElement_StillSorts()
    {
        // The shape from the migrated SemanticTokensHandler: an imported
        // (metadata) struct element sorted by one of its members.
        var source = @"
import System
import System.Collections.Generic

func run() int32 {
    let xs = List[TimeSpan]()
    xs.Add(TimeSpan.FromTicks(30))
    xs.Add(TimeSpan.FromTicks(10))
    xs.Add(TimeSpan.FromTicks(20))
    xs.Sort((a TimeSpan, b TimeSpan) -> a.Ticks.CompareTo(b.Ticks))
    var acc = 0
    for t in xs {
        acc = acc * 10 + int32(t.Ticks) / 10
    }
    return acc
}

run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(123, result.Value);
    }
}
