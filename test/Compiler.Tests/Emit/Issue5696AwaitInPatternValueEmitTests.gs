// <copyright file="Issue5696AwaitInPatternValueEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System.IO
import Xunit

/// Issue #5696: `SpillSequenceSpiller` lowers `await` expressions inside
/// pattern values across `is` expressions, `switch` statements, and `switch`
/// expressions while preserving left-to-right evaluation and short-circuiting.
class Issue5696AwaitInPatternValueEmitTests {
    @Fact
    func RelationalEqualityAndOrdering_AwaitInPatternValue_MatchesAndPreservesOrder() {
        const source = `import System
import System.Threading.Tasks
class Trace {
    shared {
        var Events string = ""
    }
}
func Subject(n int32) int32 {
    Trace.Events += "s"
    return n
}
async func Value() Task[int32] {
    Trace.Events += "v"
    await Task.Yield()
    return 3
}
async func A(n int32) Task[bool] {
    return Subject(n) is == await Value()
}
async func B(n int32) Task[bool] {
    return Subject(n) is > await Value()
}
async func NotEqual(n int32) Task[bool] {
    return Subject(n) is != await Value()
}
Console.Write("${A(3).Result} ${B(4).Result} ${A(2).Result} ${B(3).Result} ${NotEqual(2).Result}|${Trace.Events}")
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            "True True False False True|svsvsvsvsv",
            "5696"
        )
    }

    @Fact
    func ConstantPattern_AwaitInPatternValue_MatchesPrimitiveStringAndDecimal() {
        const source = `import System
import System.Threading.Tasks
async func Num() Task[int32] {
    await Task.Yield()
    return 7
}
async func Text() Task[string] {
    await Task.Yield()
    return String([]char{'o', 'k'})
}
async func Price() Task[decimal] {
    await Task.Yield()
    return 12.5m
}
async func Check(n int32, s string, d decimal) Task[string] {
    let a = if n is (await Num()) { "1" } else { "0" }
    let b = if s is (await Text()) { "1" } else { "0" }
    let c = if d is (await Price()) { "1" } else { "0" }
    return a + b + c
}
Console.Write(Check(7, "ok", 12.50m).Result + "|" + Check(8, "no", 1.0m).Result)
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(source, "111|000", "5696")
    }

    @Fact
    func CombinatorsAndSubpatterns_ShortCircuitAwaitInPatternValue() {
        const source = `import System
import System.Threading.Tasks
open class Animal {
    init() { }
}
class Dog : Animal {
    prop P int32 { get; set; }
    init(p int32) {
        P = p
    }
}
class Cat : Animal {
    init() { }
}
class Counter {
    shared {
        var Calls int32 = 0
    }
}
async func SideEffectValue(v int32) Task[int32] {
    Counter.Calls += 1
    await Task.Yield()
    return v
}
async func CheckTypeProperty(a Animal) Task[bool] {
    return a is Dog{ P: > await SideEffectValue(3) }
}
async func CheckAnd(n int32) Task[bool] {
    return n is > 10 and < await SideEffectValue(20)
}
async func CheckOr(n int32) Task[bool] {
    return n is == await SideEffectValue(5) or == await SideEffectValue(9)
}
async func CheckNot(n int32) Task[bool] {
    return n is not == await SideEffectValue(4)
}
async func CheckList(items []int32) Task[bool] {
    return items is [1, == await SideEffectValue(2)]
}
func Bit(b bool) string -> if b { "1" } else { "0" }
let c0 = Bit(CheckTypeProperty(Cat()).Result) + ":${Counter.Calls}"
let c1 = Bit(CheckTypeProperty(Dog(5)).Result) + ":${Counter.Calls}"
let c2 = Bit(CheckTypeProperty(Dog(2)).Result) + ":${Counter.Calls}"
let c3 = Bit(CheckAnd(4).Result) + ":${Counter.Calls}"
let c4 = Bit(CheckAnd(15).Result) + ":${Counter.Calls}"
let c5 = Bit(CheckOr(5).Result) + ":${Counter.Calls}"
let c6 = Bit(CheckOr(9).Result) + ":${Counter.Calls}"
let c7 = Bit(CheckNot(4).Result) + Bit(CheckNot(8).Result) + ":${Counter.Calls}"
let c8 = Bit(CheckList([]int32{0, 2}).Result) + ":${Counter.Calls}"
let c9 = Bit(CheckList([]int32{1, 2}).Result) + ":${Counter.Calls}"
Console.Write("${c0}|${c1}|${c2}|${c3}|${c4}|${c5}|${c6}|${c7}|${c8}|${c9}")
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            "0:0|1:1|0:2|0:2|1:3|1:4|1:6|01:8|0:8|1:9",
            "5696"
        )
    }

    @Fact
    func SwitchStatementAndSwitchExpression_AwaitInPatternArms_ShortCircuitEarlierMatches() {
        const source = `import System
import System.Threading.Tasks
class Counter {
    shared {
        var StmtCalls int32 = 0
        var ExprCalls int32 = 0
    }
}
async func StmtThreshold(v int32) Task[int32] {
    Counter.StmtCalls += 1
    await Task.Yield()
    return v
}
async func ExprThreshold(v int32) Task[int32] {
    Counter.ExprCalls += 1
    await Task.Yield()
    return v
}
async func ClassifyStmt(n int32) Task[string] {
    switch n {
        case 1 {
            return "one"
        }
        case == await StmtThreshold(5) {
            return "five"
        }
        case > await StmtThreshold(10) {
            return "big"
        }
        default {
            return "other"
        }
    }
}
async func ClassifyExpr(n int32) Task[string] {
    return switch n {
        case 1: "one"
        case == await ExprThreshold(5): "five"
        case > await ExprThreshold(10): "big"
        default: "other"
    }
}
let s1 = ClassifyStmt(1).Result + ":${Counter.StmtCalls}"
let s2 = ClassifyStmt(5).Result + ":${Counter.StmtCalls}"
let s3 = ClassifyStmt(12).Result + ":${Counter.StmtCalls}"
let s4 = ClassifyStmt(3).Result + ":${Counter.StmtCalls}"
let e1 = ClassifyExpr(1).Result + ":${Counter.ExprCalls}"
let e2 = ClassifyExpr(5).Result + ":${Counter.ExprCalls}"
let e3 = ClassifyExpr(12).Result + ":${Counter.ExprCalls}"
let e4 = ClassifyExpr(3).Result + ":${Counter.ExprCalls}"
Console.Write("${s1},${s2},${s3},${s4}|${e1},${e2},${e3},${e4}")
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            "one:0,five:1,big:3,other:5|one:0,five:1,big:3,other:5",
            "5696"
        )
    }

    @Fact
    func NullableValueTypeRelationalPattern_AwaitInPatternValue_PreservesLiftedSemantics() {
        const source = `import System
import System.Threading.Tasks
class Trace {
    shared {
        var Events string = ""
    }
}
func Subject(n int32?) int32? {
    Trace.Events += "s"
    return n
}
async func Value(v int32) Task[int32] {
    Trace.Events += "v"
    await Task.Yield()
    return v
}
async func NullableValue(v int32?) Task[int32?] {
    Trace.Events += "n"
    await Task.Yield()
    return v
}
async func Eq(n int32?) Task[bool] -> Subject(n) is == await Value(3)
async func Neq(n int32?) Task[bool] -> Subject(n) is != await Value(3)
async func Gt(n int32?) Task[bool] -> Subject(n) is > await Value(3)
async func GtNullable(n int32?, m int32?) Task[bool] -> Subject(n) is > await NullableValue(m)
func Bit(b bool) string -> if b { "1" } else { "0" }
let eq = Bit(Eq(3).Result) + Bit(Eq(4).Result) + Bit(Eq(nil).Result)
let neq = Bit(Neq(3).Result) + Bit(Neq(4).Result) + Bit(Neq(nil).Result)
let gt = Bit(Gt(5).Result) + Bit(Gt(3).Result) + Bit(Gt(nil).Result)
let gtn = Bit(GtNullable(5, 3).Result) + Bit(GtNullable(5, nil).Result) + Bit(GtNullable(nil, 3).Result)
Console.Write("${eq}|${neq}|${gt}|${gtn}|${Trace.Events}")
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            "100|011|100|100|svsvsvsvsvsvsvsvsvsnsnsn",
            "5696"
        )
    }

    @Fact
    func MutatingValueTypePropertyPatternAndMutatedListPattern_PreserveSingleCaptureAndShapeCheck() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "MutatingPatterns.ref.dll")
        let implementation = fixture.CompileCSharpWithReference(`namespace MutatingPatterns {
public struct ImportedIndexable {
    public int N;
    public int Count => 1;
    public int Next => ++N;
    public int this[int index] => ++N;
}
}`, "MutatingPatterns", reference)
        const source = `import MutatingPatterns
import System
import System.Collections.Generic
import System.Threading.Tasks
struct Counter {
    var N int32
    prop Next int32 {
        get {
            N += 1
            return N
        }
    }
}
async func One() Task[int32] {
    await Task.Yield()
    return 1
}
async func Two() Task[int32] {
    await Task.Yield()
    return 2
}
async func GrowAndReturnOne(items List[int32]) Task[int32] {
    await Task.Yield()
    items.Add(99)
    return 1
}
async func CheckStruct(c Counter) Task[bool] -> c is { Next: == await One(), N: 1 }
async func CheckStructOr(c Counter) Task[bool] -> c is { Next: == await Two(), N: 1 } or { N: 0 }
async func CheckImportedStruct(c ImportedIndexable) Task[bool] -> c is { Next: == await One(), N: 1 }
async func CheckImportedIndexableOr(c ImportedIndexable) Task[bool] -> c is [== await Two()] or { N: 0 }
async func CheckListExact() Task[bool] {
    let items = List[int32]()
    items.Add(1)
    items.Add(2)
    return items is [== await GrowAndReturnOne(items), 2]
}
async func CheckListSlice() Task[bool] {
    let items = List[int32]()
    items.Add(1)
    items.Add(2)
    return items is [== await GrowAndReturnOne(items), .., 2]
}
func Bit(b bool) string -> if b { "1" } else { "0" }
let s1 = Bit(CheckStruct(Counter{N: 0}).Result)
let s2 = Bit(CheckStructOr(Counter{N: 0}).Result)
let s3 = Bit(CheckImportedStruct(ImportedIndexable{N: 0}).Result)
let s4 = Bit(CheckImportedIndexableOr(ImportedIndexable{N: 0}).Result)
let l1 = Bit(CheckListExact().Result)
let l2 = Bit(CheckListSlice().Result)
Console.Write("${s1}${s2}${s3}${s4}|${l1}${l2}")
`
        Issue5392ConstructedInterfaceMethodDriverTests.CompileVerifyAndRun(
            source,
            "1111|11",
            "5696",
            reference,
            implementation
        )
    }
}
