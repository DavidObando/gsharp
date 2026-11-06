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
    func SliceElementTypeVariadic_PacksSliceOfSlices() {
        let result = EmittedOracle.Evaluate(`
func total(values ...[]int32) int32 {
    var t = 0
    for row in values {
        for v in row {
            t = t + v
        }
    }
    return t
}
total([]int32{4}, []int32{5})
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

    @Fact
    func SliceElementType_PacksSliceOfSlices_WhileExplicitJaggedAndCollectionElementSliceCarriersPreserveCarrier() {
        let result = EmittedOracle.Evaluate(`
import System.Collections.Generic

func join(parts ...[]uint8) int32 {
    var n = 0
    for p in parts {
        n = n + p.Length
    }
    return n
}
func joinNullable(parts ...[]?List[int32]) int32 {
    var n = 0
    for p in parts {
        if p != nil {
            n = n + p.Length
        }
    }
    return n
}
func jagged(rows ...[][]int32) int32 {
    var n = 0
    for r in rows {
        n = n + r.Length
    }
    return n
}
func lists(items ...[]List[int32]) int32 {
    var n = 0
    for l in items {
        n = n + l.Count
    }
    return n
}
let a = []uint8{1, 2}
let b = []uint8{3, 4, 5}
let matrix = [][]uint8{a, b}
let l1 = List[int32]()
l1.Add(10)
let l2 = List[int32]()
l2.Add(20)
l2.Add(30)
let nullableArr []?List[int32] = []List[int32]{l1}
join(a, b) * 100 + join(matrix) * 10 + jagged([]int32{1, 2}, []int32{3}) + lists(l1, l2) + joinNullable(nullableArr, nil)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(557, result.Value)
    }

    @Fact
    func SharedAndBodyConstWithoutTypeClause_InfersTypeAndResolvesBySimpleName() {
        let result = EmittedOracle.Evaluate(`
interface Limits {
    shared {
        const Base = 3
        func GetBase() int32 {
            return Base
        }
    }
}
class Early {
    const Cross = Late.Computed + 1
    shared {
        func GetCross() int32 -> Cross
    }
}
class Late {
    const Computed = 1 + 2
}
class Holder {
    const Top = 7
    shared {
        var Nothing Holder? = (nil)
        const DirectCopy = ComputedSibling
        const ExplicitDependent int32 = ComputedSibling + 1
        const ComputedSibling = 1 + 2
        const Reverse = Limit * 2
        const Limit = 5
        const Label = "ok"
        func UseLimit(s string?) int32 {
            if s == nil {
                return 0
            }
            let _ = Nothing
            return s.Length + Reverse + Limit + Top + Limits.GetBase() + Label.Length + DirectCopy + ExplicitDependent + Early.GetCross()
        }
    }
}
Holder.UseLimit("a")
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(39, result.Value)
    }

    @Fact
    func ExplicitGenericConstructorCall_SubstitutesTypeParameterIntoLambdaTarget() {
        let result = EmittedOracle.Evaluate(`
import System

class Box[T] {
    private let handler (T) -> void
    init(handler (T) -> void) {
        this.handler = handler
    }
    func Fire(v T) {
        this.handler(v)
    }
    shared {
        func NoOp() Box[T] -> Box[T](x -> {})
    }
}
class ActionBox[T] {
    private let handler Action[T]
    init(handler Action[T]) {
        this.handler = handler
    }
    func Fire(v T) {
        this.handler(v)
    }
}
var total int64 = 0
let b1 = Box[int64]((n int64) -> { total = total + n })
let b2 = Box[int64](n -> { total = total + n })
let b3 = ActionBox[int64]((n int64) -> { total = total + n })
let b4 = Box[int64].NoOp()
b1.Fire(4)
b2.Fire(5)
b3.Fire(6)
b4.Fire(7)
total
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(15L, result.Value)
    }

    @Fact
    func SourceNominalGenericDelegate_SupportsObjectUpcastCheckedDowncastAndTupleElementIdentity() {
        let result = EmittedOracle.Evaluate(`
import System

delegate Factory[T]() T;

func Present() (Text string, Code int32) -> ("ok", 7)

let local Factory[(Text string, Code int32)] = Present
let relabeled Factory[(Label string, Number int32)] = local
let asObject object = relabeled
let asDelegate Delegate = local
let asMulticast MulticastDelegate = local
let nullableLocal Factory[(Text string, Code int32)]? = local
let fromNullable object = cast[object](nullableLocal)
let converted = cast[Factory[(Text string, Code int32)]](asObject)
let fromDel = cast[Factory[(Text string, Code int32)]](asDelegate)
let fromMulti = cast[Factory[(Text string, Code int32)]](asMulticast)
let item = converted()
"${item.Text}:${item.Code}:${fromDel().Code}:${fromMulti().Code}:${fromNullable != nil}"
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok:7:7:7:True", result.Value)
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
