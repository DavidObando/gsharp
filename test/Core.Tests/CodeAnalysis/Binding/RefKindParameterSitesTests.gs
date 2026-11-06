// <copyright file="RefKindParameterSitesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0060: binding-time tests for `ref`/`out`/`in` parameters at
/// the binder sites beyond free functions: struct instance methods, struct static
/// methods, interface members, class methods, named-delegate-type declarations,
/// constructors, and override / interface-implementation matching (GS0240).
open class RefKindParameterSitesTests {
    @Fact
    func StructInstanceMethod_RefParameter_BindsCleanly() {
        // ADR-0079 (issue #719): the canonical declaration site for owned-
        // type instance methods is the in-body form. Structs don't yet
        // accept in-body methods, so this exercises the receiver-clause
        // form and explicitly ignores the GS0314 warning it emits.
        let source = `
struct Counter {
    var Value int32
}

func (c Counter) Add(ref delta int32) {
    delta = delta + 1
}
0
`
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func ClassStaticMethod_OutParameter_BindsCleanly() {
        // ADR-0017 / ADR-0024: static methods on classes live in a `shared { ... }` block.
        let source = `
class MathHelper {
    shared {
        func TryDouble(input int32, out result int32) bool {
            result = input * 2
            return true
        }
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InterfaceMember_OutParameter_BindsCleanly() {
        let source = `
interface IParser {
    func TryParse(text string, out result int32) bool;
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClassConstructor_RefParameter_BindsCleanly() {
        let source = `
class Box {
    var Value int32

    init(seed int32, ref delta int32) {
        delta = delta + 1
        Value = seed + delta
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NamedDelegate_RefOutInParameters_BindsCleanly() {
        let source = `
delegate IntRefAction(ref counter int32, by int32);
delegate IntOutPredicate(out result int32) bool;
delegate StructInObserver(in box int32);
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NamedDelegate_RefKindInvocationMismatches_ReportGS0235NotGS0155() {
        let sources = []string{`
package RefDelegateMismatch

delegate RefAction(ref value int32);
var callback RefAction = (ref value int32) -> { }
var value = 0
callback(out value)
0
`, `
package GenericOutDelegateMismatch

delegate OutAction[T](out value T) bool;
func Bad[T](callback OutAction[T], ref value T) {
    callback(ref value)
}
0
`, `
package GenericInDelegateMismatch

delegate InAction[T](in value T) bool;
func Bad[T](callback InAction[T], ref value T) {
    callback(ref value)
}
0
`}
        for source in sources {
            let result = Evaluate(source)
            Assert.True(
                result.Diagnostics.Any((d Diagnostic) -> d.Id == "GS0235"),
                source + "\n" + string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> "${d.Id}: ${d.Message}"))
            )
            Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
        }
        // Issue #4400: omitting `in` at a delegate's `in` parameter binds
        // like C# (a readonly reference), so it is not a ref-kind mismatch.
        let missingIn = Evaluate(`
package InDelegateMissingModifier

delegate InAction(in value int32) int32;
var callback InAction = (in value int32) -> value * 2
var value = 21
callback(value)
`)
        Assert.Empty(missingIn.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, missingIn.Value)
    }

    @Fact
    func PrimaryCtor_RefParameter_Rejected() {
        let source = `
class Vec(ref x int32) { }
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0424")
    }

    // ----------------------------------------------------------------------
    // Override / interface-implementation ref-kind matching (GS0240).
    // ----------------------------------------------------------------------
    @Fact
    func Override_AddsRefWhereBaseHasNone_ReportsGS0240() {
        let source = `
open class Base {
    open func Adjust(value int32) {
    }
}

class Derived : Base {
    override func Adjust(ref value int32) {
        value = value + 1
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")
    }

    @Fact
    func Override_RemovesRef_ReportsGS0240() {
        let source = `
open class Base {
    open func Adjust(ref value int32) {
        value = value + 1
    }
}

class Derived : Base {
    override func Adjust(value int32) {
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")
    }

    @Fact
    func Override_ChangesInToRef_ReportsGS0240() {
        let source = `
open class Base {
    open func Observe(in value int32) {
    }
}

class Derived : Base {
    override func Observe(ref value int32) {
        value = value + 1
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")
    }

    @Fact
    func Override_ChangesOutToIn_ReportsGS0240() {
        let source = `
open class Base {
    open func Produce(out value int32) {
        value = 0
    }
}

class Derived : Base {
    override func Produce(in value int32) {
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")
    }

    @Fact
    func Override_MatchingRefKind_BindsCleanly() {
        let source = `
open class Base {
    open func Adjust(ref value int32) {
        value = value + 1
    }
}

class Derived : Base {
    override func Adjust(ref value int32) {
        value = value + 2
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InterfaceImpl_MissingOutOnImplementor_ReportsGS0240() {
        let source = `
interface IParser {
    func TryParse(text string, out result int32) bool;
}

class MyParser : IParser {
    func TryParse(text string, result int32) bool {
        return false
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")
    }

    @Fact
    func InterfaceImpl_MatchingOut_BindsCleanly() {
        let source = `
interface IParser {
    func TryParse(text string, out result int32) bool;
}

class MyParser : IParser {
    func TryParse(text string, out result int32) bool {
        result = 0
        return false
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InParameter_MissingCallSiteModifier_PassesReadOnlyReference() {
        // Issue #4400 (ADR-0060 amendment): omitting `in` at the call site
        // binds like C# — the lvalue's own address, or a spilled temp for an
        // rvalue — instead of the former GS0242 error (issue #3501 had made it
        // an error because the argument reached the emitter as GS9998).
        let result = Evaluate(`
func Take(in f int32) int32 {
    return f * 2
}

let x = 3
Take(x) + Take(x + 1)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(14, result.Value)
    }

    @Fact
    func InParameter_ExplicitModifier_Binds() {
        let result = Evaluate(`
func Take(in f int32) int32 {
    return f * 2
}

let x = 3
Take(in x)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(6, result.Value)
    }

    @Fact
    func UserIndexer_InParameter_BindsExplicitAndOmittedInForGetSetAndCompound() {
        let result = Evaluate(`
interface IGrid {
    prop this[in i int32] int32 { get; set; }
}

class Grid : IGrid {
    var cells []int32 = []int32{10, 20, 30}

    prop this[in i int32] int32 {
        get { return cells[i] }
        set { cells[i] = value }
    }

    prop this[in row int32, col int32 = 1] int32 {
        get { return cells[row + col] }
        set { cells[row + col] = value }
    }
}

let g = Grid()
let ig IGrid = g
var idx = 0
g[in idx] = 15
g[idx] += 5
let a = g[in idx] + ig[idx] + g[1]
g[in idx, 2] = 40
g[idx, 2] += 2
let b = g[in idx, 2] + g[1, 1]
a * 100 + b
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        // a = 20 + 20 + 20 = 60; b = 42 + 42 = 84 -> 6084
        Assert.Equal(6084, result.Value)
    }

    @Fact
    func UserIndexer_InParameterIsReadOnlyInAccessorBody_ReportsGS0237() {
        let result = Evaluate(`
class Idx {
    prop this[in i int32] int32 {
        get {
            i = 1
            return i
        }
    }
}
0
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0237")
    }

    @Fact
    func UserIndexer_RefAndOutParameters_ReportGS0633() {
        let sources = []string{`
class Idx {
    prop this[ref i int32] int32 -> i
}
0
`, `
struct SIdx {
    prop this[out i int32] int32 {
        get { return 0 }
    }
}
0
`, `
interface IIdx {
    prop this[ref i int32] int32 { get; }
}
0
`}
        for source in sources {
            let result = Evaluate(source)
            let diag = Assert.Single(result.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0633"))
            Assert.True(diag.Location.Span.Length == 3)
        }
    }

    @Fact
    func UserIndexer_OverrideAndInterfaceRefKindMismatch_ReportsGS0240() {
        let overrideMismatch = Evaluate(`
open class Base {
    open prop this[in i int32] int32 -> i
}

class Derived : Base {
    override prop this[i int32] int32 -> i
}
0
`)
        Assert.Contains(overrideMismatch.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")

        let ifaceMismatch = Evaluate(`
interface IIdx {
    prop this[in i int32] int32 { get; }
}

class Impl : IIdx {
    prop this[i int32] int32 -> i
}
0
`)
        Assert.Contains(ifaceMismatch.Diagnostics, (d Diagnostic) -> d.Id == "GS0240")

        let arityMismatch = Evaluate(`
open class Base {
    open prop this[i int32] int32 -> i
}

class Derived : Base {
    override prop this[in i int32, j int32] int32 -> i + j
}
0
`)
        Assert.Contains(arityMismatch.Diagnostics, (d Diagnostic) -> d.Id == "GS0185")

        let namedItemMismatch = Evaluate(`
open class Base {
    open prop Item int32 -> 1
}

class Derived : Base {
    override prop this[in i int32] int32 -> i
}
0
`)
        Assert.Contains(namedItemMismatch.Diagnostics, (d Diagnostic) -> d.Id == "GS0185")
    }

    @Fact
    func UserIndexer_InParameterAssignment_PreservesAliasAndValidatesAddressBeforeRhs() {
        let result = Evaluate(`
import System

class Idx {
    var Last int32
    prop this[in i int32] int32 {
        get { return i }
        set { Last = i * 10 + value }
    }
    prop this[in i int32, j int32] int32 {
        get { return i + j }
        set { Last = i * 100 + j * 10 + value }
    }
}

func Alias(ref x int32) ref int32 {
    return ref x
}

func Change(ref x int32) int32 {
    x = 4
    return 7
}

let idx = Idx()
var x = 1
idx[Alias(&x)] = Change(&x)
let aliasObserved = idx.Last

var sideEffects = 0
func SideEffect() int32 {
    sideEffects = sideEffects + 1
    return 9
}

let items = []int32{10, 20}
var badIndex = 5
try {
    idx[in items[badIndex]] = SideEffect()
} catch (ex IndexOutOfRangeException) {
}
try {
    idx[in items[badIndex], SideEffect()] = 1
} catch (ex IndexOutOfRangeException) {
}
aliasObserved * 10 + sideEffects
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(470, result.Value)

        let asyncBorrowed = Evaluate(`
import System.Threading.Tasks

class Idx {
    prop this[in i int32] int32 {
        get { return i }
        set { }
    }
}

func Alias(ref x int32) ref int32 {
    return ref x
}

async func Bad() Task[int32] {
    let idx = Idx()
    var x = 1
    idx[Alias(&x)] = await Task.FromResult(2)
    return x
}
0
`)
        Assert.Contains(asyncBorrowed.Diagnostics, (d Diagnostic) -> d.Id == "GS0604")

        let asyncCompoundLocal = Evaluate(`
import System.Threading.Tasks

class Idx {
    var cells []int32 = []int32{10, 20}
    prop this[in i int32] int32 {
        get { return cells[i] }
        set { cells[i] = value }
    }
}

async func Good() Task[int32] {
    let idx = Idx()
    var i = 1
    idx[in i] += await Task.FromResult(5)
    return idx[in i]
}
Good().Result
`)
        Assert.Empty(asyncCompoundLocal.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(25, asyncCompoundLocal.Value)
    }

    @Fact
    func UserIndexer_ByValueAndInOverloads_PrefersByValueForOmittedInAndSelectsInForExplicitIn() {
        let result = Evaluate(`
class Dual {
    var Last int32
    prop this[in i System.Index] int32 {
        get { return i.Value + 200 }
        set { Last = i.Value + 200 + value }
    }
    prop this[i System.Index] int32 {
        get { return i.Value + 20 }
        set { Last = i.Value + 20 + value }
    }
    prop this[i int32] int32 {
        get { return i + 10 }
        set { Last = i + 10 + value }
    }
    prop this[in i int32] int32 {
        get { return i + 100 }
        set { Last = i + 100 + value }
    }
}

unsafe class PtrDual {
    prop this[p *int32] int32 -> *p + 10
    prop this[in i int32, unused int32 = 0] int32 -> i + 100 + unused
}

unsafe class InPtrUserIdx {
    prop this[in p *int32] int32 -> *p + 5
}

class MultiFuncIdx {
    var Last int32
    prop this[in f(int32) -> int32, arg int32] int32 {
        get -> f(arg)
        set {
            Last = f(arg) + value
        }
    }
}

unsafe func ProbePtr() int32 {
    let pd = PtrDual()
    let ip = InPtrUserIdx()
    var cell = 7
    return pd[&cell] + ip[&cell]
}

let mf = MultiFuncIdx()
mf[{
    let marker = 1
    (x) -> x + marker
}, 4] = 5
let mfWrite = mf.Last
let d = Dual()
var k = 5
let a = d[1]
let b = d[k]
let c = d[in k]
d[k] = 2
let w1 = d.Last
d[in k] = 3
let w2 = d.Last
let p = ProbePtr()
let idxRead = d[^2]
d[^2] = 4
let idxWrite = d.Last
var sysIdx = ^3
let idxInRead = d[in sysIdx]
a * 100000 + b * 1000 + c + w1 * 10 + w2 + p + idxRead + idxWrite + idxInRead + mfWrite
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        // 1115651 + 12 (ip[&cell]) + 10 (mfWrite) = 1115673
        Assert.Equal(1115673, result.Value)

        let mixedAmbiguous = Evaluate(`
class Mixed {
    prop this[in a int32, b int64] int32 -> a
    prop this[a int64, in b int32] int32 -> b
}
let m = Mixed()
m[1, 2]
`)
        Assert.Contains(mixedAmbiguous.Diagnostics, (d Diagnostic) -> d.Id == "GS0266")

        let coalesceResult = Evaluate(`
class NullableInIdx {
    var Slot0 string? = nil
    var Slot1 string? = nil
    var LastKey int32
    prop this[in k int32] string? {
        get {
            return if k == 0 { Slot0 } else { Slot1 }
        }
        set {
            LastKey = k
            if k == 0 {
                Slot0 = value
            } else {
                Slot1 = value
            }
        }
    }
}

struct RefNullableInIdx {
    var Hits int32
    var Slots []string?
    prop this[in k int32] ref string? {
        get {
            Hits = Hits + k
            return ref Slots[0]
        }
    }
}

func MutateAndReturn(ref x int32, v string) string {
    x = 9
    return v
}

func ReassignReceiverInArg(ref recv NullableInIdx, replacement NullableInIdx, k int32) int32 {
    recv = replacement
    return k
}

func ReassignReceiverInRhs(ref recv NullableInIdx, replacement NullableInIdx, v string) string {
    recv = replacement
    return v
}

let box = NullableInIdx()
var k0 = 0
box[in k0] ??= MutateAndReturn(ref k0, "first")
let afterStmtKey = box.LastKey
let afterStmtVal = box.Slot1 ?? ""
var k1 = 0
let exprVal = (box[k1] ??= "second")

let orig1 = NullableInIdx()
let repl1 = NullableInIdx()
var recv1 = orig1
recv1[ReassignReceiverInArg(ref recv1, repl1, 0)] ??= "onOrig1"

let orig2 = NullableInIdx()
let repl2 = NullableInIdx()
var recv2 = orig2
var k2 = 0
recv2[in k2] ??= ReassignReceiverInRhs(ref recv2, repl2, "onOrig2")

var refIdx = RefNullableInIdx{Hits: 0, Slots: []string?{nil}}
var rk = 1
refIdx[in rk] ??= "fromRef"
"${afterStmtKey}:${afterStmtVal}:${exprVal}:${box.Slot0 ?? ""}:${orig1.Slot0 ?? ""}:${repl1.Slot0 ?? ""}:${orig2.Slot0 ?? ""}:${repl2.Slot0 ?? ""}:${refIdx.Hits}:${refIdx.Slots[0] ?? ""}"
`)
        Assert.Empty(coalesceResult.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("9:first:second:second:onOrig1::onOrig2::1:fromRef", coalesceResult.Value)

        let coalesceBorrowAwait = Evaluate(`
import System.Threading.Tasks

class NullableInIdx {
    var Slot string?
    prop this[in k int32] string? {
        get -> Slot
        set { Slot = value }
    }
}

func Alias(ref x int32) ref int32 -> ref x

async func BadExpr(idx NullableInIdx) Task[string] {
    var k = 1
    let v = (idx[Alias(ref k)] ??= await Task.FromResult("x"))
    return v ?? ""
}
0
`)
        Assert.Contains(coalesceBorrowAwait.Diagnostics, (d Diagnostic) -> d.Id == "GS0604")

        let coalesceRefTargetAwait = Evaluate(`
import System.Threading.Tasks

struct RefNullableInIdx {
    var Slots []string?
    prop this[in k int32] ref string? {
        get -> ref Slots[0]
    }
}

async func BadRefTarget() Task[int32] {
    var idx = RefNullableInIdx{Slots: []string?{nil}}
    var k = 1
    idx[in k] ??= await Task.FromResult("x")
    return 0
}
0
`)
        Assert.Contains(coalesceRefTargetAwait.Diagnostics, (d Diagnostic) -> d.Id == "GS0604")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
