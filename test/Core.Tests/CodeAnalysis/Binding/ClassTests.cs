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
type Box class {
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
type Box class {
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
type Box class {
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
type Point struct {
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
type Box class {
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
    public void DataClass_Rejected()
    {
        // `data class` is intentionally not part of Phase 3 (ADR-0029 limits
        // `data` to `struct`); diagnose at parse time.
        var source = @"
type Foo data class {
    var X int32
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void PrimaryConstructor_PositionalCtorCall()
    {
        // Phase 3.B.3 sub-step 2: Kotlin-style primary ctor — params become
        // public fields of the same name; the class is constructed positionally
        // via `Name(args)`.
        var source = @"
type Point class(X int32, Y int32) {
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
type Counter class(initial int32) {
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
type Point class(X int32, Y int32) {
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
type Point class(X int32, Y int32) {
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
type Point class(X int32, Y int32) {
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
type Base[T any] open class {
    func Echo(x T) T { return x }
}

type Derived[T any] class : Base[T] {
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
type Pt class(X int32, Y int32) {
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
type Pt class(X int32, Y int32) {
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
type Vec class(X int32) {
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
type Pt class(X int32) {
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
type Pt class(X int32) {
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
    public void Method_OnStruct_Diagnoses()
    {
        // Methods are class-only in 3.B.3 sub-step 2b.
        var source = @"
type Pt struct {
    var X int32

    func Sum() int32 {
        return X
    }
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    // Phase 3.B.3 sub-step 3: open / override + single inheritance (ADR-0017).

    [Fact]
    public void Inheritance_BaseMustBeOpen_Diagnoses()
    {
        var source = @"
type A class { var X int32 }
type B class : A { var Y int32 }
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("not open"));
    }

    [Fact]
    public void Inheritance_OpenClass_Subclass_Works()
    {
        var source = @"
type A open class { var X int32 }
type B class : A { var Y int32 }
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
type A open class {
    open func F() int32 { return 1 }
}
type B class : A {
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
    public void Override_OfNonOpenMethod_Diagnoses()
    {
        var source = @"
type A open class {
    func F() int32 { return 1 }
}
type B class : A {
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
type A open class {
    open func F() int32 { return 1 }
}
type B class : A {
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
type A open class {}
type B class : A {
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
type A open class {
    open func F() int32 { return 1 }
}
type B class : A {
    override func F(x int32) int32 { return x }
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
type A open class {
    var X int32
    func GetX() int32 { return X }
}
type B class : A {}
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
type A open class {
    func Hello() int32 { return 7 }
}
type B class : A {}
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
type Animal open class(Name string) {
    func Speak() string { return Name }
}
type Dog class(Pet string) : Animal(Pet) {}
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
type Animal open class(Name string) {}
type Dog class(Pet string) : Animal(Pet, Pet) {}
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
type IShape interface {
    func Area() int32
}
type Square class(Side int32) : IShape(Side) {
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
type Rect class {
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
type Clamped class {
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
type Animal open class(Name string) {
    func Speak() string { return Name }
}
type Dog class : Animal {
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
type Animal open class(Name string) {
    func Speak() string { return Name }
}
type Dog class : Animal {
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
type Rect class {
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
type Rect class {
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
type Bad class(X int32) {
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
type Both class(Name string) {
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
type Bag class {
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
type Rect class {
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
type Bad class {
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
type Bad class {
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
type Animal open class(Name string) {
}
type Dog class : Animal(""rex"") {
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
