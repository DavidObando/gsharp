// <copyright file="ClassTests.cs" company="GSharp">
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
import Xunit

/// Emitted-oracle coverage for class.
open class ClassTests {
    @Fact
    func ClassLiteral_ReadFields() {
        let source = `
class Box {
    var Width int32
    var Height int32
}

var b = Box{Width: 3, Height: 4}
b.Width + b.Height
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func ClassAssignment_HasReferenceSemantics() {
        let source = `
class Box {
    var Width int32
}

var b = Box{Width: 1}
var c = b
c.Width = 99
b.Width
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func ClassFieldAssignment_MutatesInPlace() {
        let source = `
class Box {
    var Width int32
}

var b = Box{Width: 5}
b.Width = 42
b.Width
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func StructAssignment_StillHasValueSemantics() {
        // Regression: 3.B.3's IsClass dispatch must not regress struct value-copy.
        let source = `
struct Point {
    var X int32
}

var p = Point{X: 1}
var q = p
q.X = 99
p.X
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func ClassLiteral_EmptyInitializerZeroes() {
        let source = `
class Box {
    var Width int32
    var Height int32
}

var b = Box{}
b.Width + b.Height
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func DataClass_Accepted() {
        // ADR-0078: `data class` is now a first-class declaration form that
        // pairs reference identity with synthesized equality / with-copy /
        // deconstruction (combines with `class` for the reference flavor of
        // the data carrier).
        let source = `
data class Foo(X int32) {
}

let f = Foo(7)
f.X
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func PrimaryConstructor_PositionalCtorCall() {
        // Phase 3.B.3 sub-step 2: Kotlin-style primary ctor — params become
        // public fields of the same name; the class is constructed positionally
        // via `Name(args)`.
        let source = `
class Point(X int32, Y int32) {
}

var p = Point(3, 4)
p.X + p.Y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func PrimaryConstructor_AdditionalBodyFieldZeroInitialized() {
        // Body fields not listed in the primary ctor are zero-initialized.
        let source = `
class Counter(initial int32) {
    var Count int32
}

var c = Counter(10)
c.initial + c.Count
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func PrimaryConstructor_WrongArgumentCount_Diagnoses() {
        let source = `
class Point(X int32, Y int32) {
}

var p = Point(3)
0
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func PrimaryConstructor_WrongArgumentType_Diagnoses() {
        let source = `
class Point(X int32, Y int32) {
}

var p = Point(3, true)
0
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func PrimaryConstructor_NameCollidesWithBodyField_Diagnoses() {
        let source = `
class Point(X int32, Y int32) {
    var X int32
}
0
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func GenericClass_Inherits_GenericBaseClass_UsingTypeParameter_Binds() {
        let source = `
open class Base[T any] {
    func Echo(x T) T { return x }
}

class Derived[T any] : Base[T] {
}

var d = Derived[string]{}
d.Echo("ok")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }

    @Fact
    func Method_CallReturnsValue_UsingImplicitThis() {
        // Phase 3.B.3 sub-step 2b: bare `X` / `Y` inside `Sum` resolve to
        // `this.X` / `this.Y`.
        let source = `
class Pt(X int32, Y int32) {
    func Sum() int32 {
        return X + Y
    }
}
var p = Pt(3, 4)
p.Sum()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Method_MutatesReceiverViaImplicitFieldAssignment() {
        let source = `
class Pt(X int32, Y int32) {
    func Scale(f int32) {
        X = X * f
        Y = Y * f
    }
}
var p = Pt(2, 3)
p.Scale(10)
p.X + p.Y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(50, result.Value)
    }

    @Fact
    func Method_TakesAndUsesArguments() {
        let source = `
class Vec(X int32) {
    func Add(n int32) int32 {
        return X + n
    }
}
var v = Vec(5)
v.Add(7)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func Method_WrongArgCount_Diagnoses() {
        let source = `
class Pt(X int32) {
    func Inc() int32 {
        return X + 1
    }
}
var p = Pt(1)
p.Inc(99)
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Method_NameCollidesWithField_Diagnoses() {
        let source = `
class Pt(X int32) {
    func X() int32 {
        return 0
    }
}
0
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Method_OnStruct_IsAccepted() {
        // Issue #938 / ADR-0079: in-body `func` methods are the canonical
        // declaration site for owned `struct` (and `data struct`) instance
        // methods, mirroring the long-standing `class` support. The method
        // binds as an instance method on the value type with no diagnostics.
        let source = `
struct Pt {
    var X int32

    func Sum() int32 {
        return X
    }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    // Phase 3.B.3 sub-step 3: open / override + single inheritance (ADR-0017).
    @Fact
    func Inheritance_BaseMustBeOpen_Diagnoses() {
        let source = `
class A { var X int32 }
class B : A { var Y int32 }
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("not open"))
    }

    @Fact
    func Inheritance_OpenClass_Subclass_Works() {
        let source = `
open class A { var X int32 }
class B : A { var Y int32 }
var b = B{X: 1, Y: 2}
b.X + b.Y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func Override_OverridesOpenMethod_Dispatches() {
        let source = `
open class A {
    open func F() int32 { return 1 }
}
class B : A {
    override func F() int32 { return 2 }
}
var b = B{}
b.F()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func Override_DerivedDeclaredBeforeBase_Dispatches() {
        let source = `
class B : A {
    override func F() int32 { return 2 }
}
open class A {
    open func F() int32 { return 1 }
}
var b = B{}
b.F()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func Override_DerivedTreeBeforeBaseTree_Binds() {
        let derived = SyntaxTree.Parse(SourceText.From(`
package Demo
class B : A {
    init() : base(1) {}
    override func F() int32 { return 2 }
}
`))
        let baseType = SyntaxTree.Parse(SourceText.From(`
package Demo
open class A {
    init(value int32) {}
    open func F() int32 { return 1 }
}
`))
        // Tree-order binder regression (issue #3176 Phase 3b.2): bind the
        // plain multi-tree compilation via EmittedOracle.CompileDiagnostics;
        // the sources declare types only and nothing needs to run.
        let compilation = Compilation(derived, baseType)
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
    }

    @Fact
    func Override_OfNonOpenMethod_Diagnoses() {
        let source = `
open class A {
    func F() int32 { return 1 }
}
class B : A {
    override func F() int32 { return 2 }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("not open"))
    }

    @Fact
    func Override_WithoutKeyword_Diagnoses() {
        let source = `
open class A {
    open func F() int32 { return 1 }
}
class B : A {
    func F() int32 { return 2 }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("add 'override'"))
    }

    @Fact
    func Override_NoBaseMethod_Diagnoses() {
        let source = `
open class A {}
class B : A {
    override func F() int32 { return 1 }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("no matching open base method"))
    }

    @Fact
    func Override_SignatureMismatch_Diagnoses() {
        let source = `
open class A {
    open func F() int32 { return 1 }
}
class B : A {
    override func F(x int32) int32 { return x }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("match the base method"))
    }

    @Fact
    func Override_ConstructedGenericBase_UsingTypeParams_Binds() {
        // Issue #1055: the base member signature USES the base's type
        // parameters and the base is inherited as a constructed generic, so the
        // matcher must substitute TIn->int32, TOut->int32 before comparing.
        let source = `
open class Base[TIn, TOut] {
    open func Transform(x TIn) TOut;
}
class Derived : Base[int32, int32] {
    override func Transform(x int32) int32 { return x + 1 }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Override_ConstructedGenericBase_Property_UsingTypeParam_Binds() {
        // Issue #1055: property whose type is the base's type parameter.
        let source = `
open class Holder[T] {
    open prop Value T { get; }
}
class IntHolder : Holder[int32] {
    override prop Value int32 { get { return 7 } }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Override_ConstructedGenericBase_TwoLevels_Binds() {
        // Issue #1055: substitution must compose across each inheritance hop
        // (Leaf : Mid[int32] : Base[T]).
        let source = `
open class Base[T] {
    open prop Size int32 { get; }
}
open class Mid[T] : Base[T] {
    open func Do(x T) T;
}
open class Leaf : Mid[int32] {
    override prop Size int32 { get { return 1 } }
    override func Do(x int32) int32 { return x + 100 }
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Override_ConstructedGenericBase_RealMismatch_Diagnoses() {
        // Issue #1055: after substituting TIn->int32, TOut->int32 the override's
        // parameter type (string) genuinely mismatches and must still report.
        let source = `
open class Base[TIn, TOut] {
    open func Transform(x TIn) TOut;
}
class Derived : Base[int32, int32] {
    override func Transform(x string) int32 { return 1 }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("match the base method"))
    }

    @Fact
    func Inheritance_InheritedFieldAccessibleByBareName() {
        let source = `
open class A {
    var X int32
    func GetX() int32 { return X }
}
class B : A {}
var b = B{X: 42}
b.GetX()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Inheritance_InheritedMethod_Callable() {
        let source = `
open class A {
    func Hello() int32 { return 7 }
}
class B : A {}
var b = B{}
b.Hello()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func BaseConstructorInitializer_GSharpBase_ForwardsArgument() {
        // Issue #306: `: Base(args)` chains to the base primary constructor.
        let source = `
open class Animal(Name string) {
    func Speak() string { return Name }
}
class Dog(Pet string) : Animal(Pet) {}
var d = Dog("Rex")
d.Speak()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Rex", result.Value)
    }

    @Fact
    func BaseConstructorInitializer_NoMatchingBaseConstructor_Diagnoses() {
        // Issue #306: GS0214 when no base ctor matches the supplied arguments.
        let source = `
open class Animal(Name string) {}
class Dog(Pet string) : Animal(Pet, Pet) {}
0
`
        let result = Evaluate(source)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("no accessible constructor that takes")
        )
    }

    @Fact
    func BaseConstructorInitializer_ArgumentsOnInterface_Diagnoses() {
        // Issue #306: GS0213 when base-ctor args are given but there is no base class.
        let source = `
interface IShape {
    func Area() int32;
}
class Square(Side int32) : IShape(Side) {
    func Area() int32 { return Side * Side }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("requires an explicit base class"))
    }

    @Fact
    func ExplicitConstructor_BodyAssignsAndComputesFields() {
        // Issue #306: an `init(...)` constructor body runs arbitrary statements
        // with `this`, its parameters, and the class fields in scope.
        let source = `
class Rect {
    var Width int32
    var Height int32
    var Area int32
    init(w int32, h int32) {
        Width = w
        Height = h
        Area = w * h
    }
}
var r = Rect(3, 4)
r.Area
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func ExplicitConstructor_ControlFlowInBody() {
        // The constructor body may contain control flow.
        let source = `
class Clamped {
    var Value int32
    init(v int32) {
        if v < 0 {
            Value = 0
        } else {
            Value = v
        }
    }
}
Clamped(-5).Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func ExplicitConstructor_GSharpBase_ForwardsAndRunsBody() {
        // Issue #306: an `init` may chain to a GSharp base class's primary
        // constructor via `: base(args)` and then run its own body.
        let source = `
open class Animal(Name string) {
    func Speak() string { return Name }
}
class Dog : Animal {
    var Tricks int32
    init(name string, tricks int32) : base(name) {
        Tricks = tricks
    }
}
var d = Dog("Rex", 3)
d.Speak()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Rex", result.Value)
    }

    @Fact
    func ExplicitConstructor_GSharpBase_BodyFieldIsSet() {
        let source = `
open class Animal(Name string) {
    func Speak() string { return Name }
}
class Dog : Animal {
    var Tricks int32
    init(name string, tricks int32) : base(name) {
        Tricks = tricks
    }
}
var d = Dog("Rex", 3)
d.Tricks
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ExplicitConstructor_WrongArgumentCount_Diagnoses() {
        let source = `
class Rect {
    var Width int32
    init(w int32, h int32) {
        Width = w
    }
}
var r = Rect(3)
0
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func ExplicitConstructor_WrongArgumentType_Diagnoses() {
        let source = `
class Rect {
    var Width int32
    init(w int32) {
        Width = w
    }
}
var r = Rect(true)
0
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func ExplicitConstructor_PrimaryAndExplicit_SameSignatureDiagnoses() {
        // ADR-0065 §5: the primary constructor is one designated init among
        // others. A user-declared init that duplicates its signature is a
        // compile-time error (GS0284).
        let source = `
class Bad(X int32) {
    init(y int32) {
        X = y
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("duplicates the synthesized primary-constructor overload")
        )
    }

    @Fact
    func ExplicitConstructor_PrimaryAndExplicit_DistinctSignatures_Compile() {
        // ADR-0065 §5: when a class declares a primary-constructor parameter
        // list AND additional explicit init(...) bodies with distinct
        // signatures, both kinds coexist as designated initializers.
        let source = `
class Both(Name string) {
    var Age int32
    init(age int32) {
        Age = age
    }
}
var byName = Both("Alice")
byName.Name
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Alice", result.Value)
    }

    @Fact
    func ExplicitConstructor_MultipleInit_Selects_Overload() {
        // ADR-0063 §9: multiple `init(...)` overloads are now supported. The
        // call site selects the best match by argument arity/type.
        let source = `
class Bag {
    var X int32
    init(a int32) {
        X = a
    }
    init(a int32, b int32) {
        X = a + b
    }
}
var b = Bag(2, 3)
b.X
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func ConvenienceInit_DelegatesToDesignated_Evaluates() {
        // ADR-0065 §2: convenience init body begins with `init(args)` which
        // delegates to the designated init in the same class.
        let source = `
class Rect {
    var Width int32
    var Height int32
    init(w int32, h int32) {
        Width = w
        Height = h
    }
    convenience init(side int32) {
        init(side, side)
    }
}
var r = Rect(7)
r.Width + r.Height
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(14, result.Value)
    }

    @Fact
    func ConvenienceInit_MissingDelegation_ReportsGS0278() {
        // ADR-0065 §2 Rule 3 / GS0278.
        let source = `
class Bad {
    var X int32
    init(x int32) {
        X = x
    }
    convenience init() {
        X = 0
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("delegate to another initializer"))
    }

    @Fact
    func DesignatedInit_InitDelegation_ReportsGS0281() {
        // ADR-0065 §2 / GS0281: only convenience init may use init(args).
        let source = `
class Bad {
    var X int32
    init(x int32) {
        X = x
    }
    init() {
        init(0)
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Designated initializer"))
    }

    @Fact
    func ConvenienceInit_WithBase_ReportsGS0279() {
        // ADR-0065 §2 / GS0279: convenience may not declare `: base()`.
        let source = `
open class Animal(Name string) {
}
class Dog : Animal("rex") {
    init(n string) {
    }
    convenience init() : base("rex") {
        init("rex")
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("may not declare ': base"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
