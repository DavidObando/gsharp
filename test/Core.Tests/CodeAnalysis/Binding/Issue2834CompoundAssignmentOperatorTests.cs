// <copyright file="Issue2834CompoundAssignmentOperatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2834 — parser/binder coverage for user-defined compound-assignment
/// operators (<c>operator +=</c> and siblings). Unlike the binary/unary
/// operators of issue #2377 — which bind as STATIC, <c>specialname</c>
/// <c>op_*</c> methods — a compound-assignment operator follows the C# 14
/// contract: an INSTANCE, <c>specialname</c>, <see langword="void"/>-returning
/// method taking exactly one parameter that mutates its receiver in place. Both
/// the in-body member form (<c>public func operator +=(n int32)</c>) and the
/// receiver-clause form (<c>func (b Bag) operator +=(n int32)</c>) must produce
/// that same shape, and the use site <c>x += y</c> must resolve it ahead of the
/// built-in table and the <c>x = x + y</c> rewrite.
/// Emission-level coverage (metadata flags, C#-consumer round-trip) lives in
/// <c>Issue2834CompoundAssignmentOperatorEmitTests</c> (Compiler.Tests).
/// </summary>
public class Issue2834CompoundAssignmentOperatorTests
{
    [Theory]
    [InlineData("+=", "op_AdditionAssignment")]
    [InlineData("-=", "op_SubtractionAssignment")]
    [InlineData("*=", "op_MultiplicationAssignment")]
    [InlineData("/=", "op_DivisionAssignment")]
    [InlineData("%=", "op_ModulusAssignment")]
    [InlineData("&=", "op_BitwiseAndAssignment")]
    [InlineData("|=", "op_BitwiseOrAssignment")]
    [InlineData("^=", "op_ExclusiveOrAssignment")]
    [InlineData("<<=", "op_LeftShiftAssignment")]
    [InlineData(">>=", "op_RightShiftAssignment")]
    [InlineData(">>>=", "op_UnsignedRightShiftAssignment")]
    public void InBodyForm_BindsAsInstanceSpecialNameMethod_ForEveryCompoundToken(string token, string metadataName)
    {
        var source = $@"
class Bag {{
    var total int32
    public func operator {token}(amount int32) {{ total = amount }}
}}
0
";
        var compilation = Compile(source);
        var bag = (StructSymbol)compilation.GlobalScope.Structs.Single(t => t.Name == "Bag");

        Assert.Empty(bag.StaticMethods);
        var op = bag.Methods.Single(m => m.Name == metadataName);
        Assert.False(op.IsStatic);
        Assert.True(op.IsSpecialName);
        Assert.Same(bag, op.ReceiverType);
        Assert.Single(op.Parameters);
        Assert.Equal(TypeSymbol.Void, op.Type);
    }

    [Fact]
    public void ReceiverClauseForm_BindsAsInstanceSpecialNameMethod_NotStatic()
    {
        // Contrast with issue #2377: a receiver-clause BINARY operator becomes a
        // static op_* method. The compound form is deliberately excluded from
        // that rewrite so it keeps the instance shape the CLR contract requires.
        var source = @"
class Bag {
    var total int32
}

func (b Bag) operator +=(amount int32) { b.total = b.total + amount }
0
";
        var compilation = Compile(source);
        var bag = (StructSymbol)compilation.GlobalScope.Structs.Single(t => t.Name == "Bag");

        Assert.Empty(bag.StaticMethods);
        var op = bag.Methods.Single(m => m.Name == "op_AdditionAssignment");
        Assert.False(op.IsStatic);
        Assert.True(op.IsSpecialName);
        Assert.Equal(TypeSymbol.Void, op.Type);
        Assert.NotNull(op.ExplicitReceiverParameter);

        // The receiver survives as Parameters[0]; the operand is Parameters[1].
        Assert.Equal(2, op.Parameters.Length);
        Assert.Equal("b", op.Parameters[0].Name);
        Assert.Equal("amount", op.Parameters[1].Name);
    }

    [Fact]
    public void BothDeclarationForms_ProduceTheSameSymbolShape()
    {
        var inBody = Compile(@"
class Bag {
    var total int32
    public func operator +=(amount int32) { total = total + amount }
}
0
");
        var receiverClause = Compile(@"
class Bag {
    var total int32
}

func (b Bag) operator +=(amount int32) { b.total = b.total + amount }
0
");

        var a = ((StructSymbol)inBody.GlobalScope.Structs.Single(t => t.Name == "Bag"))
            .Methods.Single(m => m.Name == "op_AdditionAssignment");
        var b = ((StructSymbol)receiverClause.GlobalScope.Structs.Single(t => t.Name == "Bag"))
            .Methods.Single(m => m.Name == "op_AdditionAssignment");

        Assert.Equal(a.IsStatic, b.IsStatic);
        Assert.Equal(a.IsSpecialName, b.IsSpecialName);
        Assert.Equal(a.Type, b.Type);
    }

    [Fact]
    public void UseSite_OnLocal_InvokesTheOperatorInPlace()
    {
        var source = @"
class Bag {
    var total int32
    public func New() { total = 0 }
    public prop Total int32 { get { return total } }
    public func operator +=(amount int32) { total = total + amount }
}

var bag = Bag()
bag += 5
bag += 7
bag!!.Total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void UseSite_PrefersCompoundOperatorOverBinaryOperator()
    {
        // C# 14 semantics: a type declaring BOTH `operator +` and `operator +=`
        // gets the IN-PLACE form for `+=`. `operator +` here returns a bag whose
        // total is 100, so observing 5 proves the compound operator won and no
        // `bag = bag + 5` rewrite happened.
        var source = @"
class Bag {
    var total int32
    public func New() { total = 0 }
    public prop Total int32 { get { return total } }
    public func operator +=(amount int32) { total = total + amount }
    public func Seed(value int32) { total = value }
}

func (a Bag) operator +(b int32) Bag {
    var r = Bag()
    r!!.Seed(100)
    return r
}

var bag = Bag()
bag += 5
bag!!.Total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void BinaryOperator_StillWins_WhenNoCompoundOperatorIsDeclared()
    {
        // Regression guard for the fallback: with only `operator +` declared,
        // `bag += 5` must still lower to the `bag = bag + 5` rewrite.
        var source = @"
class Bag {
    var total int32
    public func New() { total = 0 }
    public prop Total int32 { get { return total } }
    public func Seed(value int32) { total = value }
}

func (a Bag) operator +(b int32) Bag {
    var r = Bag()
    r!!.Seed(100)
    return r
}

var bag = Bag()
bag += 5
bag!!.Total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(100, result.Value);
    }

    [Fact]
    public void UseSite_OnFieldReceiver_Binds()
    {
        var source = @"
class Bag {
    var total int32
    public func New() { total = 0 }
    public prop Total int32 { get { return total } }
    public func operator +=(amount int32) { total = total + amount }
}

class Holder {
    public var Inner Bag
}

var h = Holder()
h!!.Inner = Bag()
h!!.Inner += 3
0
";
        // Binding-level assertion only. Runtime behaviour is covered
        // end-to-end over real IL in Compiler.Tests
        // (Issue2834CompoundAssignmentOperatorEmitTests).
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void UseSite_OnGetterOnlyProperty_Binds_BecauseMutationIsInPlace()
    {
        // An in-place operator needs no setter and no write-back, so a
        // getter-only property is a legal compound-assignment target.
        var source = @"
class Bag {
    var total int32
    public func New() { total = 0 }
    public prop Total int32 { get { return total } }
    public func operator +=(amount int32) { total = total + amount }
}

class Holder {
    public var Inner Bag
    public prop Only Bag { get { return Inner } }
}

var h = Holder()
h!!.Inner = Bag()
h!!.Only += 4
0
";
        // A getter-only property is a legal compound-assignment target only
        // because the mutation happens in place: GS0127 ("read-only") must NOT
        // be reported. Runtime behaviour is covered in Compiler.Tests.
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0127");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void InheritedCompoundOperator_ResolvesThroughDerivedReceiver()
    {
        var source = @"
open class BaseBag {
    var total int32
    public func New() { total = 0 }
    public prop Total int32 { get { return total } }
    public func operator +=(amount int32) { total = total + amount }
}

class DerivedBag : BaseBag {
    public func New() { }
}

var bag = DerivedBag()
bag += 9
bag!!.Total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void WrongArity_ReportsGS0500()
    {
        var source = @"
class Bag {
    var total int32
    public func operator +=(a int32, b int32) { total = a + b }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0500");
    }

    [Fact]
    public void NonVoidReturn_ReportsGS0500()
    {
        var source = @"
class Bag {
    var total int32
    public func operator -=(a int32) int32 { return a }
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0500");
    }

    [Fact]
    public void ReceiverClauseForm_WrongArity_ReportsGS0500()
    {
        var source = @"
class Bag {
    var total int32
}

func (b Bag) operator +=() { b.total = 0 }
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0500");
    }

    [Fact]
    public void NoCompoundOperatorDeclared_StillReportsGS0129_Unchanged()
    {
        // Regression guard: the compound hook must not swallow the pre-existing
        // "undefined binary operator" diagnostic for a type with no operator.
        var source = @"
class Plain {
    var total int32
    public func New() { total = 0 }
}

var p = Plain()
p += 5
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0129");
    }

    [Fact]
    public void BuiltinNumericCompoundAssignment_IsUnaffected()
    {
        var source = @"
var x = 10
x += 5
x -= 3
x
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void AmpersandHatEquals_IsNotACompoundAssignmentOperatorName()
    {
        // `&^=` (Go-style AND-NOT) has no CLR metadata name, so it must not be
        // accepted as an operator declaration.
        var source = @"
class Bag {
    var total int32
    public func operator &^=(amount int32) { total = amount }
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
