// <copyright file="ManagedReferenceSpillTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public sealed class ManagedReferenceSpillTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ControlFlowLocationPreservesOriginalSlotAndPermission(bool readOnly)
    {
        var root = new LocalVariableSymbol("root", false, TypeSymbol.Int32);
        var result = new LocalVariableSymbol("result", false, TypeSymbol.Object);
        var exit = new BoundLabel("exit");
        var effect = Call("SelectOnce", TypeSymbol.Void);
        var location = new BoundBlockExpression(
            null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, effect),
                new BoundConditionalGotoStatement(null, exit, new BoundLiteralExpression(null, false))),
            new BoundVariableExpression(null, root));
        var reference = new BoundManagedReferenceExpression(null, location, result.Type, readOnly);
        var body = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(
                new BoundVariableDeclaration(null, root, new BoundLiteralExpression(null, 1)),
                new BoundVariableDeclaration(null, result, reference),
                new BoundLabelStatement(null, exit)));

        var rewritten = SpillSequenceSpiller.RewriteControlFlowBlocks(body);

        var declaration = Assert.Single(rewritten.Statements.OfType<BoundVariableDeclaration>(), d => d.Variable == result);
        var retained = Assert.IsType<BoundManagedReferenceExpression>(declaration.Initializer);
        Assert.Same(root, Assert.IsType<BoundVariableExpression>(retained.Location).Variable);
        Assert.Same(reference.Type, retained.Type);
        Assert.Equal(readOnly, retained.IsReadOnly);
        Assert.Same(effect, Assert.Single(rewritten.Statements.OfType<BoundExpressionStatement>()).Expression);
        Assert.Same(exit, Assert.Single(rewritten.Statements.OfType<BoundConditionalGotoStatement>()).Label);
    }

    [Fact]
    public void AwaitingIndexRetainsArraySelectionRatherThanElementValue()
    {
        var arrayType = SliceTypeSymbol.Get(TypeSymbol.Int32);
        var array = Call("SelectArray", arrayType);
        var index = new BoundAwaitExpression(null, Call("Index", TypeSymbol.Int32), TypeSymbol.Int32);
        var reference = new BoundManagedReferenceExpression(
            null, new BoundIndexExpression(null, array, index, TypeSymbol.Int32), TypeSymbol.Object, readOnly: true);
        var result = new LocalVariableSymbol("result", false, reference.Type);
        var body = new BoundBlockStatement(
            null, ImmutableArray.Create<BoundStatement>(new BoundVariableDeclaration(null, result, reference)));

        var rewritten = SpillSequenceSpiller.Rewrite(body);

        var declarations = rewritten.Statements.OfType<BoundVariableDeclaration>().ToArray();
        var retained = Assert.IsType<BoundManagedReferenceExpression>(Assert.Single(declarations, d => d.Variable == result).Initializer);
        var location = Assert.IsType<BoundIndexExpression>(retained.Location);
        var savedArray = Assert.IsType<BoundVariableExpression>(location.Target);
        var selected = Assert.Single(declarations, d => d.Variable == savedArray.Variable);
        Assert.Same(array, selected.Initializer);
        Assert.Same(arrayType, savedArray.Type);
        var savedIndex = Assert.IsType<BoundVariableExpression>(location.Index);
        Assert.IsType<BoundAwaitExpression>(Assert.Single(declarations, d => d.Variable == savedIndex.Variable).Initializer);
        Assert.True(System.Array.IndexOf(declarations, selected) < System.Array.FindIndex(declarations, d => d.Variable == savedIndex.Variable));
        Assert.True(retained.IsReadOnly);
    }

    [Fact]
    public void FieldKeySpillsOnlyItsRuntimeParent()
    {
        var field = FieldMetadataWithAwaitingReceiver();
        var parent = new BoundAwaitExpression(null, Call("Parent", TypeSymbol.Object), TypeSymbol.Object);
        var key = new BoundManagedFieldKeyExpression(parent, field);
        var result = new LocalVariableSymbol("result", false, key.Type);
        var body = new BoundBlockStatement(
            null, ImmutableArray.Create<BoundStatement>(new BoundVariableDeclaration(null, result, key)));

        var rewritten = SpillSequenceSpiller.Rewrite(body);

        var declarations = rewritten.Statements.OfType<BoundVariableDeclaration>().ToArray();
        var retained = Assert.IsType<BoundManagedFieldKeyExpression>(Assert.Single(declarations, d => d.Variable == result).Initializer);
        Assert.Same(field, retained.Field);
        var savedParent = Assert.IsType<BoundVariableExpression>(retained.Parent);
        var awaitDeclaration = Assert.Single(declarations, d => d.Initializer is BoundAwaitExpression);
        Assert.Same(savedParent.Variable, awaitDeclaration.Variable);
        var awaited = Assert.IsType<BoundAwaitExpression>(awaitDeclaration.Initializer);
        Assert.Same(parent.Expression, awaited.Expression);
        Assert.Same(parent.Type, awaited.Type);
    }

    [Fact]
    public void FieldMetadataReceiverIsNotAnEvaluatedSpillOperand()
    {
        var key = new BoundManagedFieldKeyExpression(
            new BoundVariableExpression(null, new LocalVariableSymbol("parent", false, TypeSymbol.Object)),
            FieldMetadataWithAwaitingReceiver());
        var body = new BoundBlockStatement(
            null, ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, key)));

        Assert.Same(body, SpillSequenceSpiller.Rewrite(body));
    }

    private static BoundFieldAccessExpression FieldMetadataWithAwaitingReceiver()
    {
        var field = new FieldSymbol("Value", TypeSymbol.Int32, Accessibility.Public);
        var owner = new StructSymbol(
            "Owner", ImmutableArray.Create(field), Accessibility.Public, declaration: null, packageName: string.Empty,
            isData: false, isInline: false, isClass: true);
        // Field is a resolved token payload. Its original receiver must not
        // acquire a second evaluation when the runtime key parent is spilled.
        return new BoundFieldAccessExpression(
            null, new BoundAwaitExpression(null, Call("MetadataOnlyReceiver", owner), owner), owner, field);
    }

    private static BoundCallExpression Call(string name, TypeSymbol type)
        => new(null, new FunctionSymbol(name, ImmutableArray<ParameterSymbol>.Empty, type), ImmutableArray<BoundExpression>.Empty);
}
