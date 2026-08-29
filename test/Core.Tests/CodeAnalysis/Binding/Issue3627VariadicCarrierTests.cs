// <copyright file="Issue3627VariadicCarrierTests.cs" company="GSharp">
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
/// ADR-0173 / issue #3627: generalized variadic carriers — <c>...X[T]</c>
/// is semantically equivalent to C#13 <c>params X&lt;T&gt;</c>. The type
/// written after <c>...</c> is the CARRIER when it is a supported
/// collection shape (slice/array, <c>List[T]</c>, the five
/// IEnumerable-family interfaces, <c>Span[T]</c>/<c>ReadOnlySpan[T]</c>);
/// otherwise it stays the ADR-0101 ELEMENT type with an implicit slice
/// carrier. Witness of discrimination: before ADR-0173 every carrier
/// spelling below bound the parameter as a slice OF the carrier
/// (<c>...List[int32]</c> meant <c>params List&lt;int&gt;[]</c>), so
/// element-typed expanded calls failed GS0154 and the bodies' carrier
/// member accesses (<c>values.Count</c>) failed GS0158.
/// </summary>
public class Issue3627VariadicCarrierTests
{
    [Fact]
    public void ClassicElementVariadic_Unchanged()
    {
        var result = EmittedOracle.Evaluate(@"
func total(values ...int32) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t
}
total(1, 2, 3)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ExplicitSliceCarrier_SameAsClassic()
    {
        var result = EmittedOracle.Evaluate(@"
func total(values ...[]int32) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t
}
total(4, 5)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void ListCarrier_PacksExpandedCall_BodySeesList()
    {
        // `values.Count` discriminates: a slice has no Count property.
        var result = EmittedOracle.Evaluate(@"
import System.Collections.Generic

func total(values ...List[int32]) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t + values.Count
}
total(1, 2, 3)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void ListCarrier_PassThroughExistingList()
    {
        var result = EmittedOracle.Evaluate(@"
import System.Collections.Generic

func total(values ...List[int32]) int32 {
    return values.Count
}
let existing = List[int32]()
existing.Add(1)
existing.Add(2)
total(existing)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void ReadOnlySpanCarrier_PacksExpandedCall()
    {
        var result = EmittedOracle.Evaluate(@"
import System

func total(values ...ReadOnlySpan[int32]) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t + values.Length
}
total(10, 20)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(32, result.Value);
    }

    [Fact]
    public void SpanCarrier_PacksExpandedCall()
    {
        var result = EmittedOracle.Evaluate(@"
import System

func total(values ...Span[int32]) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t
}
total(7, 8)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(15, result.Value);
    }

    [Fact]
    public void EnumerableInterfaceCarrier_PacksAndPassesThrough()
    {
        var result = EmittedOracle.Evaluate(@"
import System.Collections.Generic

func total(values ...IEnumerable[int32]) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t
}
let packed = total(1, 2)
let existing = List[int32]()
existing.Add(10)
packed + total(existing)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(13, result.Value);
    }

    [Fact]
    public void ReadOnlyListInterfaceCarrier_Packs()
    {
        var result = EmittedOracle.Evaluate(@"
import System.Collections.Generic

func first(values ...IReadOnlyList[string]) string {
    return values[0]
}
first(""a"", ""b"")
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("a", result.Value);
    }

    [Fact]
    public void ZeroArgumentExpandedCall_EmptyCarrier()
    {
        var result = EmittedOracle.Evaluate(@"
import System.Collections.Generic

func total(values ...List[int32]) int32 {
    return values.Count
}
total()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void NonCarrierGenericElement_KeepsElementInterpretation()
    {
        // HashSet is not a supported carrier — `...HashSet[int32]` stays the
        // ADR-0101 element interpretation (params of HashSet elements).
        var result = EmittedOracle.Evaluate(@"
import System.Collections.Generic

func countSets(sets ...HashSet[int32]) int32 {
    var n = 0
    for s in sets {
        n = n + s.Count
    }
    return n
}
let a = HashSet[int32]()
a.Add(1)
let b = HashSet[int32]()
b.Add(2)
b.Add(3)
countSets(a, b)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void SpanCarrier_ElementCoercion_AppliesImplicitConversions()
    {
        // int32 literals into an int64 span element slot — the #1493 element
        // coercion must run before packing, same as the classic slice path.
        var result = EmittedOracle.Evaluate(@"
import System

func total(values ...ReadOnlySpan[int64]) int64 {
    var t = int64(0)
    for v in values {
        t = t + v
    }
    return t
}
total(1, 2, 3)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6L, result.Value);
    }

    [Fact]
    public void ListCarrier_WrongElementType_ReportsGS0154()
    {
        var diagnostics = Errors(@"
import System.Collections.Generic

func total(values ...List[int32]) int32 {
    return values.Count
}
let x = total(""nope"")
");
        Assert.Contains(diagnostics, d => d.Id == "GS0154");
    }

    [Fact]
    public void CarrierOnConstructor_Packs()
    {
        var result = EmittedOracle.Evaluate(@"
import System.Collections.Generic

class Box {
    var Count int32

    init(values ...List[int32]) {
        Count = values.Count
    }
}
let b = Box(1, 2, 3)
b.Count
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
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
