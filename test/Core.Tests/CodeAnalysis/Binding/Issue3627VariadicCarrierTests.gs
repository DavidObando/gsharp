// <copyright file="Issue3627VariadicCarrierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// ADR-0173 / issue #3627: generalized variadic carriers — `...X[T]`
/// is semantically equivalent to C#13 `params X<T>`. The type
/// written after `...` is the CARRIER when it is a supported
/// collection shape (slice/array, `List[T]`, the five
/// IEnumerable-family interfaces, `Span[T]`/`ReadOnlySpan[T]`);
/// otherwise it stays the ADR-0101 ELEMENT type with an implicit slice
/// carrier. Witness of discrimination: before ADR-0173 every carrier
/// spelling below bound the parameter as a slice OF the carrier
/// (`...List[int32]` meant `params List<int>[]`), so
/// element-typed expanded calls failed GS0154 and the bodies' carrier
/// member accesses (`values.Count`) failed GS0158.
open class Issue3627VariadicCarrierTests {
    @Fact
    func ClassicElementVariadic_Unchanged() {
        let result = EmittedOracle.Evaluate(`
func total(values ...int32) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t
}
total(1, 2, 3)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ExplicitSliceCarrier_SameAsClassic() {
        let result = EmittedOracle.Evaluate(`
func total(values ...[]int32) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t
}
total(4, 5)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func ListCarrier_PacksExpandedCall_BodySeesList() {
        // `values.Count` discriminates: a slice has no Count property.
        let result = EmittedOracle.Evaluate(`
import System.Collections.Generic

func total(values ...List[int32]) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t + values.Count
}
total(1, 2, 3)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func ListCarrier_PassThroughExistingList() {
        let result = EmittedOracle.Evaluate(`
import System.Collections.Generic

func total(values ...List[int32]) int32 {
    return values.Count
}
let existing = List[int32]()
existing.Add(1)
existing.Add(2)
total(existing)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Theory
    @InlineData("List")
    @InlineData("Span")
    @InlineData("ReadOnlySpan")
    func ReferenceNullableElementCarrier_PacksWithoutLosingNullability(carrier string) {
        let result = EmittedOracle.Evaluate(`import System
import System.Collections.Generic

func countNulls(values ...CARRIER[string?]) int32 {
    var count = 0
    for value in values {
        if value == nil { count++ }
    }
    return count
}
countNulls(nil, "present")`.Replace("CARRIER", carrier))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func SameCompilationElementCarrier_RemainsUnsupported() {
        let diagnostics = Errors(`import System.Collections.Generic

class Entry {}
func count(values ...List[Entry]) int32 -> values.Count
count(Entry())`)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0544")
    }

    @Fact
    func ReadOnlySpanCarrier_PacksExpandedCall() {
        let result = EmittedOracle.Evaluate(`
import System

func total(values ...ReadOnlySpan[int32]) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t + values.Length
}
total(10, 20)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(32, result.Value)
    }

    @Fact
    func SpanCarrier_PacksExpandedCall() {
        let result = EmittedOracle.Evaluate(`
import System

func total(values ...Span[int32]) int32 {
    var t = 0
    for v in values {
        t = t + v
    }
    return t
}
total(7, 8)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(15, result.Value)
    }

    @Fact
    func EnumerableInterfaceCarrier_PacksAndPassesThrough() {
        let result = EmittedOracle.Evaluate(`
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
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(13, result.Value)
    }

    @Fact
    func ReadOnlyListInterfaceCarrier_Packs() {
        let result = EmittedOracle.Evaluate(`
import System.Collections.Generic

func first(values ...IReadOnlyList[string]) string {
    return values[0]
}
first("a", "b")
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("a", result.Value)
    }

    @Fact
    func ZeroArgumentExpandedCall_EmptyCarrier() {
        let result = EmittedOracle.Evaluate(`
import System.Collections.Generic

func total(values ...List[int32]) int32 {
    return values.Count
}
total()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func NonCarrierGenericElement_KeepsElementInterpretation() {
        // HashSet is not a supported carrier — `...HashSet[int32]` stays the
        // ADR-0101 element interpretation (params of HashSet elements).
        let result = EmittedOracle.Evaluate(`
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
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func SpanCarrier_ElementCoercion_AppliesImplicitConversions() {
        // int32 literals into an int64 span element slot — the #1493 element
        // coercion must run before packing, same as the classic slice path.
        let result = EmittedOracle.Evaluate(`
import System

func total(values ...ReadOnlySpan[int64]) int64 {
    var t = int64(0)
    for v in values {
        t = t + v
    }
    return t
}
total(1, 2, 3)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6L, result.Value)
    }

    @Fact
    func ListCarrier_WrongElementType_ReportsGS0154() {
        let diagnostics = Errors(`
import System.Collections.Generic

func total(values ...List[int32]) int32 {
    return values.Count
}
let x = total("nope")
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0154")
    }

    @Fact
    func CarrierOnConstructor_Packs() {
        let result = EmittedOracle.Evaluate(`
import System.Collections.Generic

class Box {
    var Count int32

    init(values ...List[int32]) {
        Count = values.Count
    }
}
let b = Box(1, 2, 3)
b.Count
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    shared {
        private func Errors(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation
                .Emit(peStream)
                .Diagnostics
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
        }
    }
}
