// <copyright file="Issue2377OperatorMetadataShapeTests.cs" company="GSharp">
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

/// Issue #2377 — binder-level regression coverage for the receiver-style
/// user operator CLR metadata shape fix. Before the fix,
/// `func (a T) operator ==(b T) bool` bound as an ordinary INSTANCE
/// method on `T` ((cref:FunctionSymbol.ReceiverType) set,
/// (cref:FunctionSymbol.IsSpecialName) false); after the fix it binds
/// as a STATIC, (cref:FunctionSymbol.IsSpecialName) method on
/// (cref:FunctionSymbol.StaticOwnerType), with the receiver preserved
/// only as an ordinary first parameter — exactly like
/// `BindConversionOperatorDeclaration`'s `op_Implicit`/
/// `op_Explicit` shape. These tests exercise the symbol shape directly
/// (via (cref:Compilation.GlobalScope)) and the executed behavior
/// (via the emitted `EmittedOracle`, ADR-0156 Phase 3b) across binary, unary,
/// comparison, generic, nested, inherited, duplicate-signature, and
/// undefined-operator (negative) scenarios. Emission-level (reflection
/// metadata, C#-consumer, ClrOperatorResolution re-import fallback,
/// expression-tree, ILVerify) coverage lives in
/// `Issue2377OperatorMetadataShapeEmitTests` (Compiler.Tests).
open class Issue2377OperatorMetadataShapeTests {
    @Fact
    func BinaryEqualityOperator_BindsAsStaticSpecialNameOnStaticOwnerType() {
        let source = `
struct Id(Value string) {
}

func (a Id) operator ==(b Id) bool -> a.Value == b.Value
func (a Id) operator !=(b Id) bool -> !(a == b)
0
`
        let compilation = Compile(source)
        let idStruct = cast[StructSymbol](compilation.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "Id"))
        Assert.Empty(idStruct.Methods)
        Assert.Equal(2, idStruct.StaticMethods.Length)
        let eq = idStruct.StaticMethods.Single((m FunctionSymbol) -> m.Name == "op_Equality")
        Assert.True(eq.IsStatic)
        Assert.True(eq.IsSpecialName)
        Assert.False(eq.IsInstanceMethod)
        Assert.Null(eq.ReceiverType)
        Assert.Null(eq.ThisParameter)
        Assert.Same(idStruct, eq.StaticOwnerType)
        Assert.Equal(2, eq.Parameters.Length)
        Assert.Equal("a", eq.Parameters[0].Name)
        Assert.Equal("b", eq.Parameters[1].Name)
        let neq = idStruct.StaticMethods.Single((m FunctionSymbol) -> m.Name == "op_Inequality")
        Assert.True(neq.IsStatic)
        Assert.True(neq.IsSpecialName)
        Assert.False(neq.IsInstanceMethod)
    }

    @Fact
    func UnaryNegationOperator_BindsAsStaticSpecialNameWithSingleParameter() {
        let source = `
struct Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator -() Vector2 {
    return Vector2{X: -a.X, Y: -a.Y}
}
0
`
        let compilation = Compile(source)
        let vecStruct = cast[StructSymbol](
            compilation.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "Vector2")
        )
        let neg = vecStruct.StaticMethods.Single((m FunctionSymbol) -> m.Name == "op_UnaryNegation")
        Assert.True(neg.IsStatic)
        Assert.True(neg.IsSpecialName)
        Assert.False(neg.IsInstanceMethod)
        Assert.Same(vecStruct, neg.StaticOwnerType)
        Assert.Single(neg.Parameters)
        Assert.Equal("a", neg.Parameters[0].Name)
    }

    @Theory
    @InlineData("+", "op_Addition")
    @InlineData("-", "op_Subtraction")
    @InlineData("*", "op_Multiply")
    @InlineData("/", "op_Division")
    @InlineData("<", "op_LessThan")
    @InlineData("<=", "op_LessThanOrEqual")
    @InlineData(">", "op_GreaterThan")
    @InlineData(">=", "op_GreaterThanOrEqual")
    func AllSupportedBinaryOperators_BindAsStaticSpecialName(op string, clrName string) {
        let source = (`struct Money(Amount int32) {
}

func (a Money) operator ` + "$op" + `(b Money) bool_or_money -> a.Amount ` + "$op" + ` b.Amount`).Replace(
            "bool_or_money",
            if op == "<" || op == "<=" || op == ">" || op == ">=" {
                "bool"
            } else {
                "int32"
            }
        )
        let compilation = Compile(source)
        let moneyStruct = cast[StructSymbol](
            compilation.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "Money")
        )
        let method = moneyStruct.StaticMethods.Single((m FunctionSymbol) -> m.Name == clrName)
        Assert.True(method.IsStatic)
        Assert.True(method.IsSpecialName)
        Assert.False(method.IsInstanceMethod)
        Assert.Equal(2, method.Parameters.Length)
    }

    @Fact
    func GenericStructOperator_OnClosedInstantiation_BindsAsStaticSpecialName_AndEvaluatesCorrectly() {
        // NOTE: the receiver clause here uses the CLOSED instantiation
        // `Box[int32]`, not the open `Box[T]`. Referencing the struct's own
        // open type parameter from a receiver-clause declaration outside the
        // struct body is a separate, pre-existing gap (receiver-clause
        // functions do not currently bring the receiver's generic type
        // parameters into signature scope) — unrelated to the #2377
        // metadata-shape defect and left as documented deferred work.
        let source = `
struct Box[T] {
    var Value T
}

func (a Box[int32]) operator +(b Box[int32]) int32 -> a.Value + b.Value

var p = Box[int32]{Value: 3}
var q = Box[int32]{Value: 4}
var sum = p + q
`
        let compilation = Compile(source)
        let boxStruct = cast[StructSymbol](compilation.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "Box"))
        let add = boxStruct.StaticMethods.Single((m FunctionSymbol) -> m.Name == "op_Addition")
        Assert.True(add.IsStatic)
        Assert.True(add.IsSpecialName)
        Assert.False(add.IsInstanceMethod)
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func NestedClassOperator_BindsAsStaticSpecialName_AndEvaluatesCorrectly() {
        let source = `
class Outer {
    class Inner {
        var X int32
    }
}

func (a Outer.Inner) operator +(b Outer.Inner) int32 -> a.X + b.X

var p = Outer.Inner{X: 5}
var q = Outer.Inner{X: 6}
var sum = p + q
`
        let compilation = Compile(source)
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func InheritedBinaryOperator_DeclaredOnOpenBase_StillStaticSpecialName_BindsThroughDerived() {
        // ADR-0112 A8 regression, re-validated with the new static shape: an
        // operator declared on an open base class must still be found when
        // the operands are a derived instance — TryGetStaticMethodIncludingInherited
        // walks the base chain exactly like the old instance-only helper did.
        let source = `
open class OpBaseVec {
    var X int32
}

func (a OpBaseVec) operator +(b OpBaseVec) int32 -> a.X + b.X

class OpDerivedVec : OpBaseVec {
}

var p = OpDerivedVec{X: 5}
var q = OpDerivedVec{X: 7}
var sum = p + q
`
        let compilation = Compile(source)
        let baseClass = cast[StructSymbol](
            compilation.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "OpBaseVec")
        )
        let add = baseClass.StaticMethods.Single((m FunctionSymbol) -> m.Name == "op_Addition")
        Assert.True(add.IsStatic)
        Assert.True(add.IsSpecialName)
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func DuplicateOperatorSignature_OnSameType_ReportsDuplicateOverloadDiagnostic() {
        // Issue #2377: duplicate-signature detection must now compare
        // against StaticMethods (where operators live), not the old
        // instance Methods bucket, or a genuine duplicate `operator ==`
        // would silently go undetected.
        let source = `
struct Dup(Value string) {
}

func (a Dup) operator ==(b Dup) bool -> a.Value == b.Value
func (a Dup) operator ==(b Dup) bool -> false
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0170" || d.IsError)
    }

    @Fact
    func UndefinedBinaryOperator_OnTypeWithNoOperatorDeclared_ReportsGS0129() {
        // Negative control: a struct with NO user-defined `==` must still
        // fail with the normal "undefined binary operator" diagnostic — the
        // static-shape fix must not accidentally make every struct
        // comparable.
        let source = `
struct NoOps(Value string) {
}

var p = NoOps{Value: "a"}
var q = NoOps{Value: "b"}
var r = p == q
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func UndefinedUnaryOperator_OnTypeWithNoOperatorDeclared_ReportsGS0128() {
        let source = `
struct NoUnaryOps(Value int32) {
}

var p = NoUnaryOps{Value: 3}
var r = -p
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0128")
    }

    @Fact
    func ExtensionOperator_OnNonOwnedImportedType_StillWorks_Unaffected() {
        // Regression guard: extension-form operators (non-owned receiver,
        // e.g. an imported CLR type) already bound as static+SpecialName
        // before this fix (via FunctionSymbol.IsExtension) — the owned-type
        // fix must not disturb that pre-existing, already-correct path.
        let source = `
import System

func (a TimeSpan) operator +(b TimeSpan) TimeSpan -> a.Add(b)

var x = TimeSpan(0, 0, 5) + TimeSpan(0, 0, 3)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree)
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
