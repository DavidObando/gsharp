// <copyright file="SpillSequenceSpillerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>
/// Unit tests for <see cref="SpillSequenceSpiller"/>. These tests construct
/// bound trees directly (no parsing) and verify the structural shape of the
/// spilled output.
/// </summary>
public class SpillSequenceSpillerTests
{
    private static readonly BoundBinaryOperator AddOp =
        BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int, TypeSymbol.Int);

    private static readonly BoundBinaryOperator LogicalAndOp =
        BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool);

    private static readonly BoundBinaryOperator LogicalOrOp =
        BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool);

    [Fact]
    public void Pure_BinaryExpression_With_AwaitOnRight_SpillsLeft()
    {
        // Arrange: left is a call (not pure), right is await
        var leftCall = MakeCall("sideEffect", TypeSymbol.Int);
        var rightAwait = new BoundAwaitExpression(new BoundLiteralExpression(0), TypeSymbol.Int);
        var binary = new BoundBinaryExpression(leftCall, AddOp, rightAwait);
        var decl = new BoundVariableDeclaration(
            new LocalVariableSymbol("x", false, TypeSymbol.Int),
            binary);
        var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(decl));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: the result should have spill temps before the var decl
        Assert.NotSame(body, result);
        // The spilled left should appear as a variable declaration before the final one.
        Assert.True(result.Statements.Length > 1, "Expected spill statements to be generated.");

        // The last statement should be the original variable declaration with
        // a binary expression whose left is now a variable read.
        var lastStmt = result.Statements[^1];
        Assert.IsType<BoundVariableDeclaration>(lastStmt);
        var lastDecl = (BoundVariableDeclaration)lastStmt;
        Assert.Equal("x", lastDecl.Variable.Name);
    }

    [Fact]
    public void Pure_BinaryExpression_With_AwaitOnRight_OfPureLeft_DoesNotSpillLeft()
    {
        // Arrange: left is a literal (pure constant), right is await
        var left = new BoundLiteralExpression(10);
        var rightAwait = new BoundAwaitExpression(new BoundLiteralExpression(0), TypeSymbol.Int);
        var binary = new BoundBinaryExpression(left, AddOp, rightAwait);
        var decl = new BoundVariableDeclaration(
            new LocalVariableSymbol("x", false, TypeSymbol.Int),
            binary);
        var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(decl));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: The left literal should NOT be spilled (no extra decl for it).
        // We expect: spill temp for await result, then final decl.
        Assert.NotSame(body, result);

        // None of the intermediate declarations should be for the literal 10.
        foreach (var stmt in result.Statements)
        {
            if (stmt is BoundVariableDeclaration d && d.Variable.Name == "x")
            {
                continue;
            }

            if (stmt is BoundVariableDeclaration spillDecl)
            {
                // The spill temp should be for the await result, not for "10"
                Assert.StartsWith(GeneratedNames.SpillTempPrefix, spillDecl.Variable.Name);
            }
        }
    }

    [Fact]
    public void LogicalAnd_With_Await_OnRight_LowersToIf()
    {
        // Arrange: left && (await right)
        var left = new BoundVariableExpression(new LocalVariableSymbol("a", true, TypeSymbol.Bool));
        var rightAwait = new BoundAwaitExpression(new BoundLiteralExpression(true), TypeSymbol.Bool);
        var binary = new BoundBinaryExpression(left, LogicalAndOp, rightAwait);
        var stmt = new BoundExpressionStatement(binary);
        var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(stmt));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: should contain a conditional goto for short-circuit semantics
        Assert.NotSame(body, result);
        var hasConditionalGoto = false;
        foreach (var s in result.Statements)
        {
            if (s is BoundConditionalGotoStatement)
            {
                hasConditionalGoto = true;
                break;
            }
        }

        Assert.True(hasConditionalGoto, "LogicalAnd with await should lower to conditional goto statements.");
    }

    [Fact]
    public void LogicalOr_With_Await_OnRight_LowersToIf()
    {
        // Arrange: left || (await right)
        var left = new BoundVariableExpression(new LocalVariableSymbol("a", true, TypeSymbol.Bool));
        var rightAwait = new BoundAwaitExpression(new BoundLiteralExpression(false), TypeSymbol.Bool);
        var binary = new BoundBinaryExpression(left, LogicalOrOp, rightAwait);
        var stmt = new BoundExpressionStatement(binary);
        var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(stmt));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert
        Assert.NotSame(body, result);
        var hasConditionalGoto = false;
        foreach (var s in result.Statements)
        {
            if (s is BoundConditionalGotoStatement)
            {
                hasConditionalGoto = true;
                break;
            }
        }

        Assert.True(hasConditionalGoto, "LogicalOr with await should lower to conditional goto statements.");
    }

    [Fact]
    public void Method_Call_With_Await_As_Second_Argument_SpillsFirstArg()
    {
        // Arrange: f(sideEffect(), await task)
        var arg0 = MakeCall("sideEffect", TypeSymbol.Int);
        var arg1 = new BoundAwaitExpression(new BoundLiteralExpression(0), TypeSymbol.Int);
        var call = new BoundCallExpression(
            MakeFunction("f", TypeSymbol.Int, TypeSymbol.Int, TypeSymbol.Int),
            ImmutableArray.Create<BoundExpression>(arg0, arg1));
        var decl = new BoundVariableDeclaration(
            new LocalVariableSymbol("r", false, TypeSymbol.Int), call);
        var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(decl));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: first arg should be spilled into a temp before the await
        Assert.NotSame(body, result);
        Assert.True(result.Statements.Length >= 2, "Expected at least one spill before the call.");

        // Check first statement spills arg0
        var firstDecl = Assert.IsType<BoundVariableDeclaration>(result.Statements[0]);
        Assert.StartsWith(GeneratedNames.SpillTempPrefix, firstDecl.Variable.Name);
    }

    [Fact]
    public void Method_Call_On_Reference_Receiver_With_Await_Arg_SpillsReceiver()
    {
        // Arrange: receiver.Method(await task)
        var receiver = MakeCall("getObj", TypeSymbol.String);
        var arg = new BoundAwaitExpression(new BoundLiteralExpression(0), TypeSymbol.Int);
        var method = typeof(string).GetMethod("Substring", new[] { typeof(int) });
        var call = new BoundImportedInstanceCallExpression(
            receiver, method, TypeSymbol.String,
            ImmutableArray.Create<BoundExpression>(arg));
        var decl = new BoundVariableDeclaration(
            new LocalVariableSymbol("s", false, TypeSymbol.String), call);
        var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(decl));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: receiver should be spilled
        Assert.NotSame(body, result);
        // Find the spill temp for the receiver
        var hasReceiverSpill = false;
        foreach (var s in result.Statements)
        {
            if (s is BoundVariableDeclaration d
                && d.Variable.Name.StartsWith(GeneratedNames.SpillTempPrefix)
                && d.Initializer is BoundCallExpression)
            {
                hasReceiverSpill = true;
                break;
            }
        }

        Assert.True(hasReceiverSpill, "Receiver should be spilled when args contain await.");
    }

    [Fact]
    public void Nested_Await_In_Binary_BothSidesAwait_BothSpilled()
    {
        // Arrange: (await t1) + (await t2)
        var awaitLeft = new BoundAwaitExpression(new BoundLiteralExpression(0), TypeSymbol.Int);
        var awaitRight = new BoundAwaitExpression(new BoundLiteralExpression(0), TypeSymbol.Int);
        var binary = new BoundBinaryExpression(awaitLeft, AddOp, awaitRight);
        var decl = new BoundVariableDeclaration(
            new LocalVariableSymbol("x", false, TypeSymbol.Int), binary);
        var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(decl));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: both awaits should be spilled
        Assert.NotSame(body, result);
        var spillCount = 0;
        foreach (var s in result.Statements)
        {
            if (s is BoundVariableDeclaration d
                && d.Variable.Name.StartsWith(GeneratedNames.SpillTempPrefix))
            {
                spillCount++;
            }
        }

        Assert.True(spillCount >= 2, $"Expected at least 2 spill temps but got {spillCount}.");
    }

    [Fact]
    public void Await_AlreadyAt_TopLevel_NotSpilled()
    {
        // Arrange: await task (expression statement)
        var awaitExpr = new BoundAwaitExpression(new BoundLiteralExpression(0), TypeSymbol.Int);
        var stmt = new BoundExpressionStatement(awaitExpr);
        var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(stmt));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: should be unchanged (idempotent)
        Assert.Same(body, result);
    }

    [Fact]
    public void NonAsync_Function_NotProcessed()
    {
        // Arrange: a body without any await
        var literal = new BoundLiteralExpression(42);
        var decl = new BoundVariableDeclaration(
            new LocalVariableSymbol("x", false, TypeSymbol.Int), literal);
        var body = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(decl));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: should be unchanged
        Assert.Same(body, result);
    }

    private static BoundCallExpression MakeCall(string name, TypeSymbol returnType)
    {
        var func = new FunctionSymbol(
            name,
            ImmutableArray<ParameterSymbol>.Empty,
            returnType);
        return new BoundCallExpression(func, ImmutableArray<BoundExpression>.Empty);
    }

    private static FunctionSymbol MakeFunction(string name, TypeSymbol returnType, params TypeSymbol[] paramTypes)
    {
        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        for (var i = 0; i < paramTypes.Length; i++)
        {
            parameters.Add(new ParameterSymbol("p" + i, paramTypes[i]));
        }

        return new FunctionSymbol(name, parameters.ToImmutable(), returnType);
    }
}
