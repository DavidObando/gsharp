// <copyright file="Issue2834CompoundAssignmentOperatorTests.cs" company="GSharp">
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

/// Issue #2834 — parser/binder coverage for user-defined compound-assignment
/// operators (`operator +=` and siblings). Unlike the binary/unary
/// operators of issue #2377 — which bind as STATIC, `specialname`
/// `op_*` methods — a compound-assignment operator follows the C# 14
/// contract: an INSTANCE, `specialname`, `void`-returning
/// method taking exactly one parameter that mutates its receiver in place. Both
/// the in-body member form (`public func operator +=(n int32)`) and the
/// receiver-clause form (`func (b Bag) operator +=(n int32)`) must produce
/// that same shape, and the use site `x += y` must resolve it ahead of the
/// built-in table and the `x = x + y` rewrite.
/// Emission-level coverage (metadata flags, C#-consumer round-trip) lives in
/// `Issue2834CompoundAssignmentOperatorEmitTests` (Compiler.Tests).
open class Issue2834CompoundAssignmentOperatorTests {
    @Theory
    @InlineData("+=", "op_AdditionAssignment")
    @InlineData("-=", "op_SubtractionAssignment")
    @InlineData("*=", "op_MultiplicationAssignment")
    @InlineData("/=", "op_DivisionAssignment")
    @InlineData("%=", "op_ModulusAssignment")
    @InlineData("&=", "op_BitwiseAndAssignment")
    @InlineData("|=", "op_BitwiseOrAssignment")
    @InlineData("^=", "op_ExclusiveOrAssignment")
    @InlineData("<<=", "op_LeftShiftAssignment")
    @InlineData(">>=", "op_RightShiftAssignment")
    @InlineData(">>>=", "op_UnsignedRightShiftAssignment")
    func InBodyForm_BindsAsInstanceSpecialNameMethod_ForEveryCompoundToken(token string, metadataName string) {
        let source = (`
class Bag {
    var total int32
    public func operator ` + "$token" + `(amount int32) { total = amount }
}
0
`)
        let compilation = Compile(source)
        let bag = cast[StructSymbol](compilation.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "Bag"))
        Assert.Empty(bag.StaticMethods)
        let op = bag.Methods.Single((m FunctionSymbol) -> m.Name == metadataName)
        Assert.False(op.IsStatic)
        Assert.True(op.IsSpecialName)
        Assert.Same(bag, op.ReceiverType)
        Assert.Single(op.Parameters)
        Assert.Equal(TypeSymbol.Void, op.Type)
    }

    @Fact
    func ReceiverClauseForm_BindsAsInstanceSpecialNameMethod_NotStatic() {
        // Contrast with issue #2377: a receiver-clause BINARY operator becomes a
        // static op_* method. The compound form is deliberately excluded from
        // that rewrite so it keeps the instance shape the CLR contract requires.
        let source = `
class Bag {
    var total int32
}

func (b Bag) operator +=(amount int32) { b.total = b.total + amount }
0
`
        let compilation = Compile(source)
        let bag = cast[StructSymbol](compilation.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "Bag"))
        Assert.Empty(bag.StaticMethods)
        let op = bag.Methods.Single((m FunctionSymbol) -> m.Name == "op_AdditionAssignment")
        Assert.False(op.IsStatic)
        Assert.True(op.IsSpecialName)
        Assert.Equal(TypeSymbol.Void, op.Type)
        Assert.NotNull(op.ExplicitReceiverParameter)
        // The receiver survives as Parameters[0]; the operand is Parameters[1].
        Assert.Equal(2, op.Parameters.Length)
        Assert.Equal("b", op.Parameters[0].Name)
        Assert.Equal("amount", op.Parameters[1].Name)
    }

    @Fact
    func BothDeclarationForms_ProduceTheSameSymbolShape() {
        let inBody = Compile(`
class Bag {
    var total int32
    public func operator +=(amount int32) { total = total + amount }
}
0
`)
        let receiverClause = Compile(`
class Bag {
    var total int32
}

func (b Bag) operator +=(amount int32) { b.total = b.total + amount }
0
`)
        let a = (cast[StructSymbol](inBody.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "Bag")))
            .Methods
            .Single((m FunctionSymbol) -> m.Name == "op_AdditionAssignment")
        let b = (cast[StructSymbol](receiverClause.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "Bag")))
            .Methods
            .Single((m FunctionSymbol) -> m.Name == "op_AdditionAssignment")
        Assert.Equal(a.IsStatic, b.IsStatic)
        Assert.Equal(a.IsSpecialName, b.IsSpecialName)
        Assert.Equal(a.Type, b.Type)
    }

    @Fact
    func UseSite_OnLocal_InvokesTheOperatorInPlace() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(12, result.Value)
    }

    @Fact
    func UseSite_PrefersCompoundOperatorOverBinaryOperator() {
        // C# 14 semantics: a type declaring BOTH `operator +` and `operator +=`
        // gets the IN-PLACE form for `+=`. `operator +` here returns a bag whose
        // total is 100, so observing 5 proves the compound operator won and no
        // `bag = bag + 5` rewrite happened.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(5, result.Value)
    }

    @Fact
    func BinaryOperator_StillWins_WhenNoCompoundOperatorIsDeclared() {
        // Regression guard for the fallback: with only `operator +` declared,
        // `bag += 5` must still lower to the `bag = bag + 5` rewrite.
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(100, result.Value)
    }

    @Fact
    func UseSite_OnFieldReceiver_Binds() {
        let source = `
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
`
        // Binding-level assertion only. Runtime behaviour is covered
        // end-to-end over real IL in Compiler.Tests
        // (Issue2834CompoundAssignmentOperatorEmitTests).
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func UseSite_OnGetterOnlyProperty_Binds_BecauseMutationIsInPlace() {
        // An in-place operator needs no setter and no write-back, so a
        // getter-only property is a legal compound-assignment target.
        let source = `
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
`
        // A getter-only property is a legal compound-assignment target only
        // because the mutation happens in place: GS0127 ("read-only") must NOT
        // be reported. Runtime behaviour is covered in Compiler.Tests.
        let result = Evaluate(source)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func InheritedCompoundOperator_ResolvesThroughDerivedReceiver() {
        let source = `
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
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(9, result.Value)
    }

    @Fact
    func WrongArity_ReportsGS0500() {
        let source = `
class Bag {
    var total int32
    public func operator +=(a int32, b int32) { total = a + b }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0500")
    }

    @Fact
    func NonVoidReturn_ReportsGS0500() {
        let source = `
class Bag {
    var total int32
    public func operator -=(a int32) int32 { return a }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0500")
    }

    @Fact
    func ReceiverClauseForm_WrongArity_ReportsGS0500() {
        let source = `
class Bag {
    var total int32
}

func (b Bag) operator +=() { b.total = 0 }
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0500")
    }

    @Fact
    func NoCompoundOperatorDeclared_StillReportsGS0129_Unchanged() {
        // Regression guard: the compound hook must not swallow the pre-existing
        // "undefined binary operator" diagnostic for a type with no operator.
        let source = `
class Plain {
    var total int32
    public func New() { total = 0 }
}

var p = Plain()
p += 5
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func BuiltinNumericCompoundAssignment_IsUnaffected() {
        let source = `
var x = 10
x += 5
x -= 3
x
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(12, result.Value)
    }

    @Fact
    func AmpersandHatEquals_IsNotACompoundAssignmentOperatorName() {
        // `&^=` (Go-style AND-NOT) has no CLR metadata name, so it must not be
        // accepted as an operator declaration.
        let source = `
class Bag {
    var total int32
    public func operator &^=(amount int32) { total = amount }
}
0
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
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
