// <copyright file="ManagedReferenceSpillTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Linq
import Xunit

class ManagedReferenceSpillTests {
    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ControlFlowLocationPreservesOriginalSlotAndPermission(readOnly bool, retainForCapture bool) {
        let root = LocalVariableSymbol("root", false, TypeSymbol.Int32)
        let result = LocalVariableSymbol("result", false, TypeSymbol.Object)
        let exit = BoundLabel("exit")
        let effect = Call("SelectOnce", TypeSymbol.Void)
        let location = BoundBlockExpression(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, effect),
                BoundConditionalGotoStatement(nil, exit, BoundLiteralExpression(nil, false))
            ),
            BoundVariableExpression(nil, root)
        )
        let reference = BoundManagedReferenceExpression(nil, location, result.Type, readOnly, retainForCapture)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, root, BoundLiteralExpression(nil, 1)),
                BoundVariableDeclaration(nil, result, reference),
                BoundLabelStatement(nil, exit)
            )
        )
        let rewritten = SpillSequenceSpiller.RewriteControlFlowBlocks(body)
        let declaration = Assert.Single(
            rewritten.Statements.OfType[BoundVariableDeclaration](),
            (d BoundVariableDeclaration) -> d.Variable == result
        )
        let retained = Assert.IsType[BoundManagedReferenceExpression](declaration.Initializer)
        Assert.Same(root, Assert.IsType[BoundVariableExpression](retained.Location).Variable)
        Assert.Same(reference.Type, retained.Type)
        Assert.Equal(readOnly, retained.IsReadOnly)
        Assert.Equal(retainForCapture, retained.RetainForCapture)
        Assert.Same(effect, Assert.Single(rewritten.Statements.OfType[BoundExpressionStatement]()).Expression)
        Assert.Same(exit, Assert.Single(rewritten.Statements.OfType[BoundConditionalGotoStatement]()).Label)
    }

    @Fact
    func AwaitingIndexRetainsArraySelectionRatherThanElementValue() {
        let arrayType = SliceTypeSymbol.Get(TypeSymbol.Int32)
        let array = Call("SelectArray", arrayType)
        let index = BoundAwaitExpression(nil, Call("Index", TypeSymbol.Int32), TypeSymbol.Int32)
        let reference = BoundManagedReferenceExpression(
            nil,
            BoundIndexExpression(nil, array, index, TypeSymbol.Int32),
            TypeSymbol.Object,
            readOnly: true
        )
        let result = LocalVariableSymbol("result", false, reference.Type)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundVariableDeclaration(nil, result, reference))
        )
        let rewritten = SpillSequenceSpiller.Rewrite(body)
        let declarations = rewritten.Statements.OfType[BoundVariableDeclaration]().ToArray()
        let retained = Assert.IsType[BoundManagedReferenceExpression](
            Assert.Single(declarations, (d BoundVariableDeclaration) -> d.Variable == result).Initializer
        )
        let location = Assert.IsType[BoundIndexExpression](retained.Location)
        let savedArray = Assert.IsType[BoundVariableExpression](location.Target)
        let selected = Assert.Single(declarations, (d BoundVariableDeclaration) -> d.Variable == savedArray.Variable)
        Assert.Same(array, selected.Initializer)
        Assert.Same(arrayType, savedArray.Type)
        let savedIndex = Assert.IsType[BoundVariableExpression](location.Index)
        Assert.IsType[BoundAwaitExpression](
            Assert.Single(declarations, (d BoundVariableDeclaration) -> d.Variable == savedIndex.Variable).Initializer
        )
        Assert.True(
            Array.IndexOf(declarations, selected) < Array.FindIndex(
                declarations,
                (d BoundVariableDeclaration) -> d.Variable == savedIndex.Variable
            )
        )
        Assert.True(retained.IsReadOnly)
    }

    @Fact
    func FieldKeySpillsOnlyItsRuntimeParent() {
        let field = FieldMetadataWithAwaitingReceiver()
        let parent = BoundAwaitExpression(nil, Call("Parent", TypeSymbol.Object), TypeSymbol.Object)
        let key = BoundManagedFieldKeyExpression(parent, field)
        let result = LocalVariableSymbol("result", false, key.Type)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundVariableDeclaration(nil, result, key))
        )
        let rewritten = SpillSequenceSpiller.Rewrite(body)
        let declarations = rewritten.Statements.OfType[BoundVariableDeclaration]().ToArray()
        let retained = Assert.IsType[BoundManagedFieldKeyExpression](
            Assert.Single(declarations, (d BoundVariableDeclaration) -> d.Variable == result).Initializer
        )
        Assert.Same(field, retained.Field)
        let savedParent = Assert.IsType[BoundVariableExpression](retained.Parent)
        let awaitDeclaration = Assert.Single(
            declarations,
            (d BoundVariableDeclaration) -> d.Initializer is BoundAwaitExpression
        )
        Assert.Same(savedParent.Variable, awaitDeclaration.Variable)
        let awaited = Assert.IsType[BoundAwaitExpression](awaitDeclaration.Initializer)
        Assert.Same(parent.Expression, awaited.Expression)
        Assert.Same(parent.Type, awaited.Type)
    }

    @Fact
    func FieldMetadataReceiverIsNotAnEvaluatedSpillOperand() {
        let key = BoundManagedFieldKeyExpression(
            BoundVariableExpression(nil, LocalVariableSymbol("parent", false, TypeSymbol.Object)),
            FieldMetadataWithAwaitingReceiver()
        )
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, key)))
        Assert.Same(body, SpillSequenceSpiller.Rewrite(body))
    }

    shared {
        private func FieldMetadataWithAwaitingReceiver() BoundFieldAccessExpression {
            let field = FieldSymbol("Value", TypeSymbol.Int32, Accessibility.Public)
            let owner = StructSymbol(
                "Owner",
                ImmutableArray.Create(field),
                Accessibility.Public,
                declaration: nil,
                packageName: string.Empty,
                isData: false,
                isInline: false,
                isClass: true
            )
            // Field is a resolved token payload. Its original receiver must not
            // acquire a second evaluation when the runtime key parent is spilled.
            return BoundFieldAccessExpression(
                nil,
                BoundAwaitExpression(nil, Call("MetadataOnlyReceiver", owner), owner),
                owner,
                field
            )
        }

        private func Call(name string, type TypeSymbol) BoundCallExpression -> BoundCallExpression(
            nil,
            FunctionSymbol(name, ImmutableArray[ParameterSymbol].Empty, type),
            ImmutableArray[BoundExpression].Empty
        )
    }
}
