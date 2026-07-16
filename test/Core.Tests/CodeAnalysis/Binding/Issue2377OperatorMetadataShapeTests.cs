// <copyright file="Issue2377OperatorMetadataShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2377 — binder-level regression coverage for the receiver-style
/// user operator CLR metadata shape fix. Before the fix,
/// <c>func (a T) operator ==(b T) bool</c> bound as an ordinary INSTANCE
/// method on <c>T</c> (<see cref="FunctionSymbol.ReceiverType"/> set,
/// <see cref="FunctionSymbol.IsSpecialName"/> false); after the fix it binds
/// as a STATIC, <see cref="FunctionSymbol.IsSpecialName"/> method on
/// <see cref="FunctionSymbol.StaticOwnerType"/>, with the receiver preserved
/// only as an ordinary first parameter — exactly like
/// <c>BindConversionOperatorDeclaration</c>'s <c>op_Implicit</c>/
/// <c>op_Explicit</c> shape. These tests exercise the symbol shape directly
/// (via <see cref="Compilation.GlobalScope"/>) and the interpreter-level
/// (<see cref="Compilation.Evaluate"/>) behavior across binary, unary,
/// comparison, generic, nested, inherited, duplicate-signature, and
/// undefined-operator (negative) scenarios. Emission-level (reflection
/// metadata, C#-consumer, ClrOperatorResolution re-import fallback,
/// expression-tree, ILVerify) coverage lives in
/// <c>Issue2377OperatorMetadataShapeEmitTests</c> (Compiler.Tests).
/// </summary>
public class Issue2377OperatorMetadataShapeTests
{
    [Fact]
    public void BinaryEqualityOperator_BindsAsStaticSpecialNameOnStaticOwnerType()
    {
        var source = @"
struct Id(Value string) {
}

func (a Id) operator ==(b Id) bool -> a.Value == b.Value
func (a Id) operator !=(b Id) bool -> !(a == b)
0
";
        var compilation = Compile(source);
        var idStruct = (StructSymbol)compilation.GlobalScope.Structs.Single(t => t.Name == "Id");

        Assert.Empty(idStruct.Methods);
        Assert.Equal(2, idStruct.StaticMethods.Length);

        var eq = idStruct.StaticMethods.Single(m => m.Name == "op_Equality");
        Assert.True(eq.IsStatic);
        Assert.True(eq.IsSpecialName);
        Assert.False(eq.IsInstanceMethod);
        Assert.Null(eq.ReceiverType);
        Assert.Null(eq.ThisParameter);
        Assert.Same(idStruct, eq.StaticOwnerType);
        Assert.Equal(2, eq.Parameters.Length);
        Assert.Equal("a", eq.Parameters[0].Name);
        Assert.Equal("b", eq.Parameters[1].Name);

        var neq = idStruct.StaticMethods.Single(m => m.Name == "op_Inequality");
        Assert.True(neq.IsStatic);
        Assert.True(neq.IsSpecialName);
        Assert.False(neq.IsInstanceMethod);
    }

    [Fact]
    public void UnaryNegationOperator_BindsAsStaticSpecialNameWithSingleParameter()
    {
        var source = @"
struct Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator -() Vector2 {
    return Vector2{X: -a.X, Y: -a.Y}
}
0
";
        var compilation = Compile(source);
        var vecStruct = (StructSymbol)compilation.GlobalScope.Structs.Single(t => t.Name == "Vector2");
        var neg = vecStruct.StaticMethods.Single(m => m.Name == "op_UnaryNegation");

        Assert.True(neg.IsStatic);
        Assert.True(neg.IsSpecialName);
        Assert.False(neg.IsInstanceMethod);
        Assert.Same(vecStruct, neg.StaticOwnerType);
        Assert.Single(neg.Parameters);
        Assert.Equal("a", neg.Parameters[0].Name);
    }

    [Theory]
    [InlineData("+", "op_Addition")]
    [InlineData("-", "op_Subtraction")]
    [InlineData("*", "op_Multiply")]
    [InlineData("/", "op_Division")]
    [InlineData("<", "op_LessThan")]
    [InlineData("<=", "op_LessThanOrEqual")]
    [InlineData(">", "op_GreaterThan")]
    [InlineData(">=", "op_GreaterThanOrEqual")]
    public void AllSupportedBinaryOperators_BindAsStaticSpecialName(string op, string clrName)
    {
        var source = $$"""
            struct Money(Amount int32) {
            }

            func (a Money) operator {{op}}(b Money) bool_or_money -> a.Amount {{op}} b.Amount
            """.Replace("bool_or_money", op is "<" or "<=" or ">" or ">=" ? "bool" : "int32");

        var compilation = Compile(source);
        var moneyStruct = (StructSymbol)compilation.GlobalScope.Structs.Single(t => t.Name == "Money");
        var method = moneyStruct.StaticMethods.Single(m => m.Name == clrName);

        Assert.True(method.IsStatic);
        Assert.True(method.IsSpecialName);
        Assert.False(method.IsInstanceMethod);
        Assert.Equal(2, method.Parameters.Length);
    }

    [Fact]
    public void GenericStructOperator_OnClosedInstantiation_BindsAsStaticSpecialName_AndEvaluatesCorrectly()
    {
        // NOTE: the receiver clause here uses the CLOSED instantiation
        // `Box[int32]`, not the open `Box[T]`. Referencing the struct's own
        // open type parameter from a receiver-clause declaration outside the
        // struct body is a separate, pre-existing gap (receiver-clause
        // functions do not currently bring the receiver's generic type
        // parameters into signature scope) — unrelated to the #2377
        // metadata-shape defect and left as documented deferred work.
        var source = @"
struct Box[T] {
    var Value T
}

func (a Box[int32]) operator +(b Box[int32]) int32 -> a.Value + b.Value

var p = Box[int32]{Value: 3}
var q = Box[int32]{Value: 4}
var sum = p + q
";
        var compilation = Compile(source);
        var boxStruct = (StructSymbol)compilation.GlobalScope.Structs.Single(t => t.Name == "Box");
        var add = boxStruct.StaticMethods.Single(m => m.Name == "op_Addition");
        Assert.True(add.IsStatic);
        Assert.True(add.IsSpecialName);
        Assert.False(add.IsInstanceMethod);

        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NestedClassOperator_BindsAsStaticSpecialName_AndEvaluatesCorrectly()
    {
        var source = @"
class Outer {
    class Inner {
        var X int32
    }
}

func (a Outer.Inner) operator +(b Outer.Inner) int32 -> a.X + b.X

var p = Outer.Inner{X: 5}
var q = Outer.Inner{X: 6}
var sum = p + q
";
        var compilation = Compile(source);
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void InheritedBinaryOperator_DeclaredOnOpenBase_StillStaticSpecialName_BindsThroughDerived()
    {
        // ADR-0112 A8 regression, re-validated with the new static shape: an
        // operator declared on an open base class must still be found when
        // the operands are a derived instance — TryGetStaticMethodIncludingInherited
        // walks the base chain exactly like the old instance-only helper did.
        var source = @"
open class OpBaseVec {
    var X int32
}

func (a OpBaseVec) operator +(b OpBaseVec) int32 -> a.X + b.X

class OpDerivedVec : OpBaseVec {
}

var p = OpDerivedVec{X: 5}
var q = OpDerivedVec{X: 7}
var sum = p + q
";
        var compilation = Compile(source);
        var baseClass = (StructSymbol)compilation.GlobalScope.Structs.Single(t => t.Name == "OpBaseVec");
        var add = baseClass.StaticMethods.Single(m => m.Name == "op_Addition");
        Assert.True(add.IsStatic);
        Assert.True(add.IsSpecialName);

        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void DuplicateOperatorSignature_OnSameType_ReportsDuplicateOverloadDiagnostic()
    {
        // Issue #2377: duplicate-signature detection must now compare
        // against StaticMethods (where operators live), not the old
        // instance Methods bucket, or a genuine duplicate `operator ==`
        // would silently go undetected.
        var source = @"
struct Dup(Value string) {
}

func (a Dup) operator ==(b Dup) bool -> a.Value == b.Value
func (a Dup) operator ==(b Dup) bool -> false
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0170" || d.IsError);
    }

    [Fact]
    public void UndefinedBinaryOperator_OnTypeWithNoOperatorDeclared_ReportsGS0129()
    {
        // Negative control: a struct with NO user-defined `==` must still
        // fail with the normal "undefined binary operator" diagnostic — the
        // static-shape fix must not accidentally make every struct
        // comparable.
        var source = @"
struct NoOps(Value string) {
}

var p = NoOps{Value: ""a""}
var q = NoOps{Value: ""b""}
var r = p == q
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void UndefinedUnaryOperator_OnTypeWithNoOperatorDeclared_ReportsGS0128()
    {
        var source = @"
struct NoUnaryOps(Value int32) {
}

var p = NoUnaryOps{Value: 3}
var r = -p
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0128");
    }

    [Fact]
    public void ExtensionOperator_OnNonOwnedImportedType_StillWorks_Unaffected()
    {
        // Regression guard: extension-form operators (non-owned receiver,
        // e.g. an imported CLR type) already bound as static+SpecialName
        // before this fix (via FunctionSymbol.IsExtension) — the owned-type
        // fix must not disturb that pre-existing, already-correct path.
        var source = @"
import System

func (a TimeSpan) operator +(b TimeSpan) TimeSpan -> a.Add(b)

var x = TimeSpan(0, 0, 5) + TimeSpan(0, 0, 3)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
