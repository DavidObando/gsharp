// <copyright file="Issue2402GenericOperatorDeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Linq
import Xunit

open class Issue2402GenericOperatorDeclarationTests {
    @Fact
    func GenericStructReceiverStyleArithmeticOperator_BindsOpenOwnerShape() {
        let source = `struct Box[T] {
    var Value T
    var Rank int32
}

func (left Box[T]) operator +(right Box[T]) Box[T] {
    return Box[T]{Value: left.Value, Rank: left.Rank + right.Rank}
}

42`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
        // Binder inspection (issue #3176 Phase 3b.2): the bound-shape asserts
        // read a locally bound Compilation; the run above came from the
        // emitted oracle.
        let compilation = Compile(source)
        let box = cast[StructSymbol](compilation.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "Box"))
        let add = box.StaticMethods.Single((m FunctionSymbol) -> m.Name == "op_Addition")
        Assert.Same(box, add.StaticOwnerType)
        Assert.Empty(add.TypeParameters)
        AssertOpenSelfType(add.Parameters[0].Type, box)
        AssertOpenSelfType(add.Parameters[1].Type, box)
        AssertOpenSelfType(add.Type, box)
    }

    @Fact
    func GenericStructReceiverStyleComparisonOperator_BindsWithoutDiagnostics() {
        let result = Evaluate(`struct Box[T] {
    var Value T
    var Rank int32
}

func (left Box[T]) operator <(right Box[T]) bool {
    return left.Rank < right.Rank
}

true`)
        Assert.Empty(result.Diagnostics)
        Assert.True(bool(result.Value))
    }

    @Fact
    func GenericStructConversionOperators_BindOpenOwnerShapes() {
        let source = `struct Box[T] {
    var Value T
    var Rank int32
}

func operator implicit (value Box[T]) int32 {
    return value.Rank
}

func operator explicit (rank int32) Box[T] {
    return Box[T]{Rank: rank}
}

42`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
        // Binder inspection (issue #3176 Phase 3b.2): the bound-shape asserts
        // read a locally bound Compilation; the run above came from the
        // emitted oracle.
        let compilation = Compile(source)
        let box = cast[StructSymbol](compilation.GlobalScope.Structs.Single((t StructSymbol) -> t.Name == "Box"))
        let conversion = box.StaticMethods.Single((m FunctionSymbol) -> m.Name == "op_Implicit")
        Assert.Same(box, conversion.StaticOwnerType)
        Assert.Empty(conversion.TypeParameters)
        AssertOpenSelfType(conversion.Parameters[0].Type, box)
        let reverseConversion = box.StaticMethods.Single((m FunctionSymbol) -> m.Name == "op_Explicit")
        Assert.Same(box, reverseConversion.StaticOwnerType)
        Assert.Empty(reverseConversion.TypeParameters)
        AssertOpenSelfType(reverseConversion.Type, box)
    }

    @Fact
    func GenericOperator_WithUndeclaredReceiverTypeArgument_ReportsUndefinedType() {
        let result = Evaluate(`struct Box[T] {
    var Value T
}

func (left Box[Missing]) operator +(right Box[Missing]) Box[Missing] {
    return left
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0113")
    }

    @Fact
    func GenericConversionOperator_WithMultipleParameters_StillReportsGS0393() {
        let result = Evaluate(`struct Box[T] {
    var Value T
}

func operator implicit (value Box[T], extra int32) int32 {
    return extra
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0393")
    }

    @Fact
    func ConversionOperator_WithoutSameCompilationOwner_StillReportsGS0394() {
        let result = Evaluate(`func operator implicit (value int32) string {
    return "invalid"
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0394")
    }

    shared {
        private func AssertOpenSelfType(type TypeSymbol, owner StructSymbol) {
            let constructed = Assert.IsType[StructSymbol](type)
            Assert.Same(owner, constructed.Definition)
            Assert.Single(constructed.TypeArguments)
            Assert.Same(owner.TypeParameters[0], constructed.TypeArguments[0])
        }

        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree)
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
