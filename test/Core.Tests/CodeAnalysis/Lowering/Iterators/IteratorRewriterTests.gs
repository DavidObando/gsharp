// <copyright file="IteratorRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Iterators

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Iterators
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Unit tests for (cref:IteratorRewriter). These tests construct
/// bound programs with yield statements and verify the iterator rewriter
/// produces correct state-machine plans.
open class IteratorRewriterTests {
    @Fact
    func Rewrite_SingleYield_CreatesIteratorPlan() {
        // Arrange: function with one yield
        let elementType = TypeSymbol.Int32
        let seqType = SequenceTypeSymbol.Get(elementType)
        let function = FunctionSymbol("gen", ImmutableArray[ParameterSymbol].Empty, seqType, $package: Package)
        let yieldStmt = BoundYieldStatement(nil, BoundLiteralExpression(nil, 42))
        let body = Block(yieldStmt)
        let program = MakeProgram(function, body)
        // Act
        let result = IteratorRewriter.Rewrite(program)
        // Assert
        let plan = Assert.Single(result.Plans)
        Assert.Same(function, plan.Function)
        Assert.Equal(elementType, plan.ElementType)
        Assert.Single(plan.YieldStates)
        Assert.Equal(1, plan.YieldStates[yieldStmt])
    }

    @Fact
    func Rewrite_MultipleYields_AllocateDistinctStates() {
        // Arrange: function with three yields
        let seqType = SequenceTypeSymbol.Get(TypeSymbol.Int32)
        let function = FunctionSymbol("multi", ImmutableArray[ParameterSymbol].Empty, seqType, $package: Package)
        let yield1 = BoundYieldStatement(nil, BoundLiteralExpression(nil, 1))
        let yield2 = BoundYieldStatement(nil, BoundLiteralExpression(nil, 2))
        let yield3 = BoundYieldStatement(nil, BoundLiteralExpression(nil, 3))
        let body = Block(yield1, yield2, yield3)
        let program = MakeProgram(function, body)
        // Act
        let result = IteratorRewriter.Rewrite(program)
        // Assert: states should be 1, 2, 3 (incrementing from 1)
        let plan = Assert.Single(result.Plans)
        Assert.Equal(3, plan.YieldStates.Count)
        Assert.Equal(1, plan.YieldStates[yield1])
        Assert.Equal(2, plan.YieldStates[yield2])
        Assert.Equal(3, plan.YieldStates[yield3])
    }

    @Fact
    func Rewrite_NoYield_ProducesNoPlan() {
        // Arrange: non-iterator function
        let seqType = SequenceTypeSymbol.Get(TypeSymbol.Int32)
        let function = FunctionSymbol("plain", ImmutableArray[ParameterSymbol].Empty, seqType, $package: Package)
        let body = Block(BoundExpressionStatement(nil, BoundLiteralExpression(nil, 1)))
        let program = MakeProgram(function, body)
        // Act
        let result = IteratorRewriter.Rewrite(program)
        // Assert
        Assert.Empty(result.Plans)
    }

    @Fact
    func Rewrite_HoistsAllLocals() {
        // Arrange: function with a local and a yield
        let seqType = SequenceTypeSymbol.Get(TypeSymbol.Int32)
        let function = FunctionSymbol("withLocal", ImmutableArray[ParameterSymbol].Empty, seqType, $package: Package)
        let localVar = LocalVariableSymbol("temp", false, TypeSymbol.Int32)
        let body = Block(
            BoundVariableDeclaration(nil, localVar, BoundLiteralExpression(nil, 10)),
            BoundYieldStatement(nil, BoundVariableExpression(nil, localVar))
        )
        let program = MakeProgram(function, body)
        // Act
        let result = IteratorRewriter.Rewrite(program)
        // Assert: local should be in hoisted locals
        let plan = Assert.Single(result.Plans)
        Assert.Contains(plan.HoistedLocals, (v VariableSymbol) -> v.Name == "temp")
    }

    @Fact
    func Rewrite_IEnumerableGenericType_DetectsElementType() {
        // Arrange: function returning IEnumerable<string>
        let stringType = TypeSymbol.FromClrType(typeof(string))
        let enumerableType = TypeSymbol.FromClrType(typeof(IEnumerable[string]))
        let function = FunctionSymbol(
            "strings",
            ImmutableArray[ParameterSymbol].Empty,
            enumerableType,
            $package: Package
        )
        let body = Block(BoundYieldStatement(nil, BoundLiteralExpression(nil, "hello")))
        let program = MakeProgram(function, body)
        // Act
        let result = IteratorRewriter.Rewrite(program)
        // Assert
        let plan = Assert.Single(result.Plans)
        Assert.Equal(typeof(string), plan.ElementType.ClrType)
    }

    @Fact
    func Rewrite_SkipsAsyncIteratorFunctions() {
        // Arrange: async iterator function should be skipped
        let asyncEnumerableType = TypeSymbol.FromClrType(typeof(IAsyncEnumerable[int32]))
        let function = FunctionSymbol(
            "asyncGen",
            ImmutableArray[ParameterSymbol].Empty,
            asyncEnumerableType,
            $package: Package
        )
        let body = Block(BoundYieldStatement(nil, BoundLiteralExpression(nil, 1)))
        let program = MakeProgram(function, body)
        // Act
        let result = IteratorRewriter.Rewrite(program)
        // Assert: async iterators go through a different path
        Assert.Empty(result.Plans)
    }

    @Fact
    func Rewrite_FunctionLiteralYield_CreatesIteratorPlan() {
        let sequenceType = SequenceTypeSymbol.Get(TypeSymbol.Int32)
        let literalFunction = FunctionSymbol(
            "literal",
            ImmutableArray[ParameterSymbol].Empty,
            sequenceType,
            $package: Package
        )
        let functionType = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, sequenceType)
        let yield = BoundYieldStatement(nil, BoundLiteralExpression(nil, 1))
        let literal = BoundFunctionLiteralExpression(
            nil,
            literalFunction,
            functionType,
            Block(yield),
            ImmutableArray[VariableSymbol].Empty
        )
        let variable = LocalVariableSymbol("values", isReadOnly: true, functionType)
        let rootFunction = FunctionSymbol(
            "root",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        )
        let result = IteratorRewriter.Rewrite(
            MakeProgram(rootFunction, Block(BoundVariableDeclaration(nil, variable, literal)))
        )
        let plan = Assert.Single(result.Plans)
        Assert.Same(literalFunction, plan.Function)
        Assert.Equal(1, plan.YieldStates[yield])
    }

    @Fact
    func Rewrite_NestedFunctionLiteralYield_CreatesDeepIteratorPlan() {
        let sequenceType = SequenceTypeSymbol.Get(TypeSymbol.Int32)
        let innerFunction = FunctionSymbol(
            "inner",
            ImmutableArray[ParameterSymbol].Empty,
            sequenceType,
            $package: Package
        )
        let innerType = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, sequenceType)
        let yield = BoundYieldStatement(nil, BoundLiteralExpression(nil, 1))
        let innerLiteral = BoundFunctionLiteralExpression(
            nil,
            innerFunction,
            innerType,
            Block(yield),
            ImmutableArray[VariableSymbol].Empty
        )
        let outerFunction = FunctionSymbol("outer", ImmutableArray[ParameterSymbol].Empty, innerType, $package: Package)
        let outerType = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, innerType)
        let outerLiteral = BoundFunctionLiteralExpression(
            nil,
            outerFunction,
            outerType,
            Block(BoundReturnStatement(nil, innerLiteral)),
            ImmutableArray[VariableSymbol].Empty
        )
        let variable = LocalVariableSymbol("factory", isReadOnly: true, outerType)
        let rootFunction = FunctionSymbol(
            "root",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            $package: Package
        )
        let result = IteratorRewriter.Rewrite(
            MakeProgram(rootFunction, Block(BoundVariableDeclaration(nil, variable, outerLiteral)))
        )
        Assert.Same(innerFunction, Assert.Single(result.Plans).Function)
    }

    @Fact
    func Detection_TraversesBranchesAndTryFinally_ButNotNestedFunctions() {
        let yield = BoundYieldStatement(nil, BoundLiteralExpression(nil, 1))
        let branch = BoundIfStatement(nil, BoundLiteralExpression(nil, true), Block(yield), Block())
        let tryFinally = BoundTryStatement(nil, Block(branch), ImmutableArray[BoundCatchClause].Empty, Block())
        Assert.True(IteratorDetection.ContainsYield(Block(tryFinally)))
        let sequenceType = SequenceTypeSymbol.Get(TypeSymbol.Int32)
        let nestedFunction = FunctionSymbol(
            "nested",
            ImmutableArray[ParameterSymbol].Empty,
            sequenceType,
            $package: Package
        )
        let functionType = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, sequenceType)
        let literal = BoundFunctionLiteralExpression(
            nil,
            nestedFunction,
            functionType,
            Block(yield),
            ImmutableArray[VariableSymbol].Empty
        )
        let lambda = LocalVariableSymbol("lambda", isReadOnly: true, functionType)
        Assert.False(IteratorDetection.ContainsYield(Block(BoundVariableDeclaration(nil, lambda, literal))))
        Assert.False(IteratorDetection.ContainsYield(Block(BoundLocalFunctionDeclaration(nil, literal))))
    }

    shared {
        private let Package PackageSymbol = PackageSymbol("main", declaration: nil)

        private func Block(statements ...BoundStatement) BoundBlockStatement {
            return BoundBlockStatement(nil, statements.ToImmutableArray())
        }

        private func MakeProgram(function FunctionSymbol, body BoundBlockStatement) BoundProgram {
            let functions = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
            functions.Add(function, body)
            return BoundProgram(
                Package,
                ImmutableArray.Create(Package),
                ImmutableArray[Diagnostic].Empty,
                functions.ToImmutable(),
                entryPoint: nil,
                statement: Block(),
                structs: ImmutableArray[StructSymbol].Empty,
                interfaces: ImmutableArray[InterfaceSymbol].Empty
            )
        }
    }
}
