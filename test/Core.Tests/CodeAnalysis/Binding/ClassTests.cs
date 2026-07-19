// <copyright file="ClassTests.cs" company="GSharp">
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
/// Phase 3.B.3 (sub-step 1) — <c>class</c> declarations as reference-typed
/// aggregates. Same composite-literal / field-access surface as <c>struct</c>,
/// but assignment and field writes go through reference semantics: aliases
/// observe each other's writes. Methods, inheritance, and <c>open</c> /
/// <c>override</c> land in later sub-steps. Interpreter-only for now.
/// </summary>
public class ClassTests
{
    [Fact]
    public void ClassLiteral_ReadFields()
    {
        var source = @"
class Box {
    var Width int32
    var Height int32
}

var b = Box{Width: 3, Height: 4}
b.Width + b.Height
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ClassAssignment_HasReferenceSemantics()
    {
        var source = @"
class Box {
    var Width int32
}

var b = Box{Width: 1}
var c = b
c.Width = 99
b.Width
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void ClassFieldAssignment_MutatesInPlace()
    {
        var source = @"
class Box {
    var Width int32
}

var b = Box{Width: 5}
b.Width = 42
b.Width
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void StructAssignment_StillHasValueSemantics()
    {
        // Regression: 3.B.3's IsClass dispatch must not regress struct value-copy.
        var source = @"
struct Point {
    var X int32
}

var p = Point{X: 1}
var q = p
q.X = 99
p.X
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void ClassLiteral_EmptyInitializerZeroes()
    {
        var source = @"
class Box {
    var Width int32
    var Height int32
}

var b = Box{}
b.Width + b.Height
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void DataClass_Accepted()
    {
        // ADR-0078: `data class` is now a first-class declaration form that
        // pairs reference identity with synthesized equality / with-copy /
        // deconstruction (combines with `class` for the reference flavor of
        // the data carrier).
        var source = @"
data class Foo(X int32) {
}

let f = Foo(7)
f.X
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void PrimaryConstructor_PositionalCtorCall()
    {
        // Phase 3.B.3 sub-step 2: Kotlin-style primary ctor — params become
        // public fields of the same name; the class is constructed positionally
        // via `Name(args)`.
        var source = @"
class Point(X int32, Y int32) {
}

var p = Point(3, 4)
p.X + p.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void PrimaryConstructor_AdditionalBodyFieldZeroInitialized()
    {
        // Body fields not listed in the primary ctor are zero-initialized.
        var source = @"
class Counter(initial int32) {
    var Count int32
}

var c = Counter(10)
c.initial + c.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void PrimaryConstructor_WrongArgumentCount_Diagnoses()
    {
        var source = @"
class Point(X int32, Y int32) {
}

var p = Point(3)
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void PrimaryConstructor_WrongArgumentType_Diagnoses()
    {
        var source = @"
class Point(X int32, Y int32) {
}

var p = Point(3, true)
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void PrimaryConstructor_NameCollidesWithBodyField_Diagnoses()
    {
        var source = @"
class Point(X int32, Y int32) {
    var X int32
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void GenericClass_Inherits_GenericBaseClass_UsingTypeParameter_Binds()
    {
        var source = @"
open class Base[T any] {
    func Echo(x T) T { return x }
}

class Derived[T any] : Base[T] {
}

var d = Derived[string]{}
d.Echo(""ok"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("ok", result.Value);
    }

    [Fact]
    public void Method_CallReturnsValue_UsingImplicitThis()
    {
        // Phase 3.B.3 sub-step 2b: bare `X` / `Y` inside `Sum` resolve to
        // `this.X` / `this.Y`.
        var source = @"
class Pt(X int32, Y int32) {
    func Sum() int32 {
        return X + Y
    }
}
var p = Pt(3, 4)
p.Sum()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void Method_MutatesReceiverViaImplicitFieldAssignment()
    {
        var source = @"
class Pt(X int32, Y int32) {
    func Scale(f int32) {
        X = X * f
        Y = Y * f
    }
}
var p = Pt(2, 3)
p.Scale(10)
p.X + p.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void Method_TakesAndUsesArguments()
    {
        var source = @"
class Vec(X int32) {
    func Add(n int32) int32 {
        return X + n
    }
}
var v = Vec(5)
v.Add(7)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void Method_WrongArgCount_Diagnoses()
    {
        var source = @"
class Pt(X int32) {
    func Inc() int32 {
        return X + 1
    }
}
var p = Pt(1)
p.Inc(99)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Method_NameCollidesWithField_Diagnoses()
    {
        var source = @"
class Pt(X int32) {
    func X() int32 {
        return 0
    }
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Method_OnStruct_IsAccepted()
    {
        // Issue #938 / ADR-0079: in-body `func` methods are the canonical
        // declaration site for owned `struct` (and `data struct`) instance
        // methods, mirroring the long-standing `class` support. The method
        // binds as an instance method on the value type with no diagnostics.
        var source = @"
struct Pt {
    var X int32

    func Sum() int32 {
        return X
    }
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    // Phase 3.B.3 sub-step 3: open / override + single inheritance (ADR-0017).

    [Fact]
    public void Inheritance_BaseMustBeOpen_Diagnoses()
    {
        var source = @"
class A { var X int32 }
class B : A { var Y int32 }
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("not open"));
    }

    [Fact]
    public void Inheritance_OpenClass_Subclass_Works()
    {
        var source = @"
open class A { var X int32 }
class B : A { var Y int32 }
var b = B{X: 1, Y: 2}
b.X + b.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Override_OverridesOpenMethod_Dispatches()
    {
        var source = @"
open class A {
    open func F() int32 { return 1 }
}
class B : A {
    override func F() int32 { return 2 }
}
var b = B{}
b.F()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void Override_DerivedDeclaredBeforeBase_Dispatches()
    {
        var source = @"
class B : A {
    override func F() int32 { return 2 }
}
open class A {
    open func F() int32 { return 1 }
}
var b = B{}
b.F()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void Override_DerivedTreeBeforeBaseTree_Binds()
    {
        var derived = SyntaxTree.Parse(SourceText.From(@"
package Demo
class B : A {
    override func F() int32 { return 2 }
}
"));
        var baseType = SyntaxTree.Parse(SourceText.From(@"
package Demo
open class A {
    open func F() int32 { return 1 }
}
"));
        var result = new Compilation(derived, baseType)
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Override_OfNonOpenMethod_Diagnoses()
    {
        var source = @"
open class A {
    func F() int32 { return 1 }
}
class B : A {
    override func F() int32 { return 2 }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("not open"));
    }

    [Fact]
    public void Override_WithoutKeyword_Diagnoses()
    {
        var source = @"
open class A {
    open func F() int32 { return 1 }
}
class B : A {
    func F() int32 { return 2 }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("add 'override'"));
    }

    [Fact]
    public void Override_NoBaseMethod_Diagnoses()
    {
        var source = @"
open class A {}
class B : A {
    override func F() int32 { return 1 }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("no matching open base method"));
    }

    [Fact]
    public void Override_SignatureMismatch_Diagnoses()
    {
        var source = @"
open class A {
    open func F() int32 { return 1 }
}
class B : A {
    override func F(x int32) int32 { return x }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("match the base method"));
    }

    [Fact]
    public void Override_ConstructedGenericBase_UsingTypeParams_Binds()
    {
        // Issue #1055: the base member signature USES the base's type
        // parameters and the base is inherited as a constructed generic, so the
        // matcher must substitute TIn->int32, TOut->int32 before comparing.
        var source = @"
open class Base[TIn, TOut] {
    open func Transform(x TIn) TOut;
}
class Derived : Base[int32, int32] {
    override func Transform(x int32) int32 { return x + 1 }
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Override_ConstructedGenericBase_Property_UsingTypeParam_Binds()
    {
        // Issue #1055: property whose type is the base's type parameter.
        var source = @"
open class Holder[T] {
    open prop Value T { get; }
}
class IntHolder : Holder[int32] {
    override prop Value int32 { get { return 7 } }
}
0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Override_ConstructedGenericBase_TwoLevels_Binds()
    {
        // Issue #1055: substitution must compose across each inheritance hop
        // (Leaf : Mid[int32] : Base[T]).
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Override_ConstructedGenericBase_RealMismatch_Diagnoses()
    {
        // Issue #1055: after substituting TIn->int32, TOut->int32 the override's
        // parameter type (string) genuinely mismatches and must still report.
        var source = @"
open class Base[TIn, TOut] {
    open func Transform(x TIn) TOut;
}
class Derived : Base[int32, int32] {
    override func Transform(x string) int32 { return 1 }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("match the base method"));
    }

    [Fact]
    public void Inheritance_InheritedFieldAccessibleByBareName()
    {
        var source = @"
open class A {
    var X int32
    func GetX() int32 { return X }
}
class B : A {}
var b = B{X: 42}
b.GetX()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Inheritance_InheritedMethod_Callable()
    {
        var source = @"
open class A {
    func Hello() int32 { return 7 }
}
class B : A {}
var b = B{}
b.Hello()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void BaseConstructorInitializer_GSharpBase_ForwardsArgument()
    {
        // Issue #306: `: Base(args)` chains to the base primary constructor.
        var source = @"
open class Animal(Name string) {
    func Speak() string { return Name }
}
class Dog(Pet string) : Animal(Pet) {}
var d = Dog(""Rex"")
d.Speak()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Rex", result.Value);
    }

    [Fact]
    public void BaseConstructorInitializer_NoMatchingBaseConstructor_Diagnoses()
    {
        // Issue #306: GS0214 when no base ctor matches the supplied arguments.
        var source = @"
open class Animal(Name string) {}
class Dog(Pet string) : Animal(Pet, Pet) {}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("no accessible constructor that takes"));
    }

    [Fact]
    public void BaseConstructorInitializer_ArgumentsOnInterface_Diagnoses()
    {
        // Issue #306: GS0213 when base-ctor args are given but there is no base class.
        var source = @"
interface IShape {
    func Area() int32;
}
class Square(Side int32) : IShape(Side) {
    func Area() int32 { return Side * Side }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("requires an explicit base class"));
    }

    [Fact]
    public void ExplicitConstructor_BodyAssignsAndComputesFields()
    {
        // Issue #306: an `init(...)` constructor body runs arbitrary statements
        // with `this`, its parameters, and the class fields in scope.
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void ExplicitConstructor_ControlFlowInBody()
    {
        // The constructor body may contain control flow.
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void ExplicitConstructor_GSharpBase_ForwardsAndRunsBody()
    {
        // Issue #306: an `init` may chain to a GSharp base class's primary
        // constructor via `: base(args)` and then run its own body.
        var source = @"
open class Animal(Name string) {
    func Speak() string { return Name }
}
class Dog : Animal {
    var Tricks int32
    init(name string, tricks int32) : base(name) {
        Tricks = tricks
    }
}
var d = Dog(""Rex"", 3)
d.Speak()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Rex", result.Value);
    }

    [Fact]
    public void ExplicitConstructor_GSharpBase_BodyFieldIsSet()
    {
        var source = @"
open class Animal(Name string) {
    func Speak() string { return Name }
}
class Dog : Animal {
    var Tricks int32
    init(name string, tricks int32) : base(name) {
        Tricks = tricks
    }
}
var d = Dog(""Rex"", 3)
d.Tricks
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ExplicitConstructor_WrongArgumentCount_Diagnoses()
    {
        var source = @"
class Rect {
    var Width int32
    init(w int32, h int32) {
        Width = w
    }
}
var r = Rect(3)
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void ExplicitConstructor_WrongArgumentType_Diagnoses()
    {
        var source = @"
class Rect {
    var Width int32
    init(w int32) {
        Width = w
    }
}
var r = Rect(true)
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void ExplicitConstructor_PrimaryAndExplicit_SameSignatureDiagnoses()
    {
        // ADR-0065 §5: the primary constructor is one designated init among
        // others. A user-declared init that duplicates its signature is a
        // compile-time error (GS0284).
        var source = @"
class Bad(X int32) {
    init(y int32) {
        X = y
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("duplicates the synthesized primary-constructor overload"));
    }

    [Fact]
    public void ExplicitConstructor_PrimaryAndExplicit_DistinctSignatures_Compile()
    {
        // ADR-0065 §5: when a class declares a primary-constructor parameter
        // list AND additional explicit init(...) bodies with distinct
        // signatures, both kinds coexist as designated initializers.
        var source = @"
class Both(Name string) {
    var Age int32
    init(age int32) {
        Age = age
    }
}
var byName = Both(""Alice"")
byName.Name
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Alice", result.Value);
    }

    [Fact]
    public void ExplicitConstructor_MultipleInit_Selects_Overload()
    {
        // ADR-0063 §9: multiple `init(...)` overloads are now supported. The
        // call site selects the best match by argument arity/type.
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void ConvenienceInit_DelegatesToDesignated_Evaluates()
    {
        // ADR-0065 §2: convenience init body begins with `init(args)` which
        // delegates to the designated init in the same class.
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(14, result.Value);
    }

    [Fact]
    public void ConvenienceInit_MissingDelegation_ReportsGS0278()
    {
        // ADR-0065 §2 Rule 3 / GS0278.
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("delegate to another initializer"));
    }

    [Fact]
    public void DesignatedInit_InitDelegation_ReportsGS0281()
    {
        // ADR-0065 §2 / GS0281: only convenience init may use init(args).
        var source = @"
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
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Designated initializer"));
    }

    [Fact]
    public void ConvenienceInit_WithBase_ReportsGS0279()
    {
        // ADR-0065 §2 / GS0279: convenience may not declare `: base()`.
        var source = @"
open class Animal(Name string) {
}
class Dog : Animal(""rex"") {
    init(n string) {
    }
    convenience init() : base(""rex"") {
        init(""rex"")
    }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("may not declare ': base"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
