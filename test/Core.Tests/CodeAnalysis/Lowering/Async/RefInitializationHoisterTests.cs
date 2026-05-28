// <copyright file="RefInitializationHoisterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class RefInitializationHoisterTests
{
    [Fact]
    public void RefLocal_NotCrossingAwait_LeftAlone()
    {
        // A body with no await: the hoister still eliminates ref locals
        // (conservative V1 approach for async bodies), but let's verify that
        // the non-ref parts are untouched.
        var x = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var y = new LocalVariableSymbol("y", isReadOnly: false, TypeSymbol.Int32);

        // var x = 42
        // var y = x + 1
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 42)),
            new BoundVariableDeclaration(null,
y, new BoundBinaryExpression(
                null,
                new BoundVariableExpression(null, x),
                BoundBinaryOperator.Bind(Core.CodeAnalysis.Syntax.SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32),
                new BoundLiteralExpression(null, 1)))));

        var result = RefInitializationHoister.Rewrite(body);

        // No ref locals → body unchanged (same reference).
        Assert.Same(body, result);
    }

    [Fact]
    public void RefLocal_To_Local_CrossingAwait_RewritesUseToAddressOfHoistedLocal()
    {
        // var x = 10
        // var slot = &x   (ref local: type *int, initializer is BoundAddressOfExpression)
        // ... (imagine await here) ...
        // *slot            (dereference → should become just `x`)
        var x = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));

        var declX = new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 10));
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, new BoundVariableExpression(null, x)));

        // Use: *slot (dereference)
        var deref = new BoundDereferenceExpression(null, new BoundVariableExpression(null, slot));
        var useStmt = new BoundExpressionStatement(null, deref);

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declX, declSlot, useStmt));

        var result = RefInitializationHoister.Rewrite(body);

        // The ref local declaration should be removed (replaced with empty block).
        Assert.NotSame(body, result);
        var stmts = result.Statements;

        // Statement 0: var x = 10 (unchanged)
        Assert.IsType<BoundVariableDeclaration>(stmts[0]);
        var declXResult = (BoundVariableDeclaration)stmts[0];
        Assert.Equal("x", declXResult.Variable.Name);

        // Statement 1: empty block (ref local decl removed)
        Assert.IsType<BoundBlockStatement>(stmts[1]);
        Assert.Empty(((BoundBlockStatement)stmts[1]).Statements);

        // Statement 2: expression statement with the inlined operand (x, not *slot)
        Assert.IsType<BoundExpressionStatement>(stmts[2]);
        var expr = ((BoundExpressionStatement)stmts[2]).Expression;
        Assert.IsType<BoundVariableExpression>(expr);
        Assert.Equal("x", ((BoundVariableExpression)expr).Variable.Name);
    }

    [Fact]
    public void RefLocal_To_ArrayElement_CrossingAwait_HoistsArrayAndIndex()
    {
        // var arr = [array]
        // var i = 2
        // var slot = &arr[i]  (ref local, initializer = BoundAddressOfExpression(BoundIndexExpression(arr, i)))
        // *slot               (should become arr[i])
        var arr = new LocalVariableSymbol("arr", isReadOnly: false, TypeSymbol.FromClrType(typeof(int[])));
        var i = new LocalVariableSymbol("i", isReadOnly: false, TypeSymbol.Int32);
        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));

        var indexExpr = new BoundIndexExpression(
            null,
            new BoundVariableExpression(null, arr),
            new BoundVariableExpression(null, i),
            TypeSymbol.Int32);
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, indexExpr));

        var deref = new BoundDereferenceExpression(null, new BoundVariableExpression(null, slot));
        var useStmt = new BoundExpressionStatement(null, deref);

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declSlot, useStmt));

        var result = RefInitializationHoister.Rewrite(body);
        var stmts = result.Statements;

        // Statement 0: empty block (ref local decl removed)
        Assert.IsType<BoundBlockStatement>(stmts[0]);

        // Statement 1: expression is arr[i] (BoundIndexExpression)
        Assert.IsType<BoundExpressionStatement>(stmts[1]);
        var expr = ((BoundExpressionStatement)stmts[1]).Expression;
        Assert.IsType<BoundIndexExpression>(expr);
        var idx = (BoundIndexExpression)expr;
        Assert.IsType<BoundVariableExpression>(idx.Target);
        Assert.Equal("arr", ((BoundVariableExpression)idx.Target).Variable.Name);
        Assert.IsType<BoundVariableExpression>(idx.Index);
        Assert.Equal("i", ((BoundVariableExpression)idx.Index).Variable.Name);
    }

    [Fact]
    public void RefLocal_To_FieldAccess_CrossingAwait_HoistsReceiver()
    {
        // var slot = &obj.field  (ref local)
        // *slot                  (should become obj.field)
        var field = new FieldSymbol("value", TypeSymbol.Int32, Accessibility.Public);
        var structType = new StructSymbol("MyStruct", ImmutableArray.Create(field), Accessibility.Public, null, "test");
        var obj = new LocalVariableSymbol("obj", isReadOnly: false, structType);
        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));

        var fieldAccess = new BoundFieldAccessExpression(
            null,
            new BoundVariableExpression(null, obj), structType, field);
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, fieldAccess));

        var deref = new BoundDereferenceExpression(null, new BoundVariableExpression(null, slot));
        var useStmt = new BoundExpressionStatement(null, deref);

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declSlot, useStmt));

        var result = RefInitializationHoister.Rewrite(body);
        var stmts = result.Statements;

        // Statement 1: expression is obj.field (BoundFieldAccessExpression)
        Assert.IsType<BoundExpressionStatement>(stmts[1]);
        var expr = ((BoundExpressionStatement)stmts[1]).Expression;
        Assert.IsType<BoundFieldAccessExpression>(expr);
        var fa = (BoundFieldAccessExpression)expr;
        Assert.Equal("value", fa.Field.Name);
    }

    [Fact]
    public void NonAsync_Function_NotProcessed()
    {
        // When body is null, Rewrite returns null.
        var result = RefInitializationHoister.Rewrite(null);
        Assert.Null(result);
    }

    [Fact]
    public void BareRefLocalUsage_ReplacedWithAddressOf()
    {
        // If a ref local is used without dereference (e.g., passed to a ref param),
        // it should be replaced with &operand.
        var x = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var slot = new LocalVariableSymbol("slot", isReadOnly: false, ByRefTypeSymbol.Get(TypeSymbol.Int32));

        var declX = new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 10));
        var declSlot = new BoundVariableDeclaration(null, slot, new BoundAddressOfExpression(null, new BoundVariableExpression(null, x)));

        // Bare usage of slot (not dereferenced)
        var bareUse = new BoundExpressionStatement(null, new BoundVariableExpression(null, slot));

        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(declX, declSlot, bareUse));

        var result = RefInitializationHoister.Rewrite(body);
        var stmts = result.Statements;

        // Statement 2: expression should be &x (BoundAddressOfExpression)
        Assert.IsType<BoundExpressionStatement>(stmts[2]);
        var expr = ((BoundExpressionStatement)stmts[2]).Expression;
        Assert.IsType<BoundAddressOfExpression>(expr);
        var addrOf = (BoundAddressOfExpression)expr;
        Assert.IsType<BoundVariableExpression>(addrOf.Operand);
        Assert.Equal("x", ((BoundVariableExpression)addrOf.Operand).Variable.Name);
    }
}
