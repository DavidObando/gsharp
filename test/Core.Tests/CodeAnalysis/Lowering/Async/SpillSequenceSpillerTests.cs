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
        BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.Int32, TypeSymbol.Int32);

    private static readonly BoundBinaryOperator LogicalAndOp =
        BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool);

    private static readonly BoundBinaryOperator LogicalOrOp =
        BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool);

    [Fact]
    public void Pure_BinaryExpression_With_AwaitOnRight_SpillsLeft()
    {
        // Arrange: left is a call (not pure), right is await
        var leftCall = MakeCall("sideEffect", TypeSymbol.Int32);
        var rightAwait = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var binary = new BoundBinaryExpression(null, leftCall, AddOp, rightAwait);
        var decl = new BoundVariableDeclaration(
            null,
            new LocalVariableSymbol("x", false, TypeSymbol.Int32),
            binary);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(decl));

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
        var left = new BoundLiteralExpression(null, 10);
        var rightAwait = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var binary = new BoundBinaryExpression(null, left, AddOp, rightAwait);
        var decl = new BoundVariableDeclaration(
            null,
            new LocalVariableSymbol("x", false, TypeSymbol.Int32),
            binary);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(decl));

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
        var left = new BoundVariableExpression(null, new LocalVariableSymbol("a", true, TypeSymbol.Bool));
        var rightAwait = new BoundAwaitExpression(null, new BoundLiteralExpression(null, true), TypeSymbol.Bool);
        var binary = new BoundBinaryExpression(null, left, LogicalAndOp, rightAwait);
        var stmt = new BoundExpressionStatement(null, binary);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(stmt));

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
        var left = new BoundVariableExpression(null, new LocalVariableSymbol("a", true, TypeSymbol.Bool));
        var rightAwait = new BoundAwaitExpression(null, new BoundLiteralExpression(null, false), TypeSymbol.Bool);
        var binary = new BoundBinaryExpression(null, left, LogicalOrOp, rightAwait);
        var stmt = new BoundExpressionStatement(null, binary);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(stmt));

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
        var arg0 = MakeCall("sideEffect", TypeSymbol.Int32);
        var arg1 = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var call = new BoundCallExpression(
            null,
            MakeFunction("f", TypeSymbol.Int32, TypeSymbol.Int32, TypeSymbol.Int32),
            ImmutableArray.Create<BoundExpression>(arg0, arg1));
        var decl = new BoundVariableDeclaration(
            null,
            new LocalVariableSymbol("r", false, TypeSymbol.Int32), call);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(decl));

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
        var arg = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var method = typeof(string).GetMethod("Substring", new[] { typeof(int) });
        var call = new BoundImportedInstanceCallExpression(
            null,
            receiver, method, TypeSymbol.String,
            ImmutableArray.Create<BoundExpression>(arg));
        var decl = new BoundVariableDeclaration(
            null,
            new LocalVariableSymbol("s", false, TypeSymbol.String), call);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(decl));

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
        var awaitLeft = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var awaitRight = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var binary = new BoundBinaryExpression(null, awaitLeft, AddOp, awaitRight);
        var decl = new BoundVariableDeclaration(
            null,
            new LocalVariableSymbol("x", false, TypeSymbol.Int32), binary);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(decl));

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
        var awaitExpr = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var stmt = new BoundExpressionStatement(null, awaitExpr);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(stmt));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: should be unchanged (idempotent)
        Assert.Same(body, result);
    }

    [Fact]
    public void NonAsync_Function_NotProcessed()
    {
        // Arrange: a body without any await
        var literal = new BoundLiteralExpression(null, 42);
        var decl = new BoundVariableDeclaration(
            null,
            new LocalVariableSymbol("x", false, TypeSymbol.Int32), literal);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(decl));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: should be unchanged
        Assert.Same(body, result);
    }

    [Fact]
    public void Unary_Expression_With_Await_Operand_Spills_Operand()
    {
        // Arrange: -(await t)
        var op = BoundUnaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32);
        var awaitOperand = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var unary = new BoundUnaryExpression(null, op, awaitOperand);
        var decl = new BoundVariableDeclaration(
            null,
            new LocalVariableSymbol("x", false, TypeSymbol.Int32),
            unary);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(decl));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: the await is lifted to a spill temp before the final decl.
        Assert.NotSame(body, result);
        Assert.True(result.Statements.Length >= 2, "Expected spill statements before the final declaration.");

        // The first spill temp's initializer should be the await.
        var firstDecl = Assert.IsType<BoundVariableDeclaration>(result.Statements[0]);
        Assert.StartsWith(GeneratedNames.SpillTempPrefix, firstDecl.Variable.Name);
        Assert.IsType<BoundAwaitExpression>(firstDecl.Initializer);

        // The final declaration's initializer is a unary expression whose operand
        // is a variable read (the spill temp), not the original await.
        var lastDecl = Assert.IsType<BoundVariableDeclaration>(result.Statements[^1]);
        var unaryOut = Assert.IsType<BoundUnaryExpression>(lastDecl.Initializer);
        Assert.IsType<BoundVariableExpression>(unaryOut.Operand);
    }

    [Fact]
    public void Unary_Expression_Without_Await_Returns_Trivial()
    {
        // Arrange: -literal (no await).
        var op = BoundUnaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32);
        var unary = new BoundUnaryExpression(null, op, new BoundLiteralExpression(null, 5));
        var decl = new BoundVariableDeclaration(
            null,
            new LocalVariableSymbol("x", false, TypeSymbol.Int32),
            unary);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(decl));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: unchanged because there's no await anywhere.
        Assert.Same(body, result);
    }

    [Fact]
    public void Index_Assignment_With_Await_RHS_Spills_Value()
    {
        // Arrange: arr[0] = await t  (Target is a VariableSymbol)
        var arr = new LocalVariableSymbol("arr", false, ArrayTypeSymbol.Get(TypeSymbol.Int32, 3));
        var awaitVal = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var ixa = new BoundIndexAssignmentExpression(
            null,
            arr,
            new BoundLiteralExpression(null, 0),
            awaitVal,
            TypeSymbol.Int32);
        var stmt = new BoundExpressionStatement(null, ixa);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(stmt));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: a spill temp for the await result is introduced, then the
        // final index assignment uses the temp as its value (no embedded await).
        Assert.NotSame(body, result);
        var spillCount = 0;
        BoundIndexAssignmentExpression finalIxa = null;
        foreach (var s in result.Statements)
        {
            if (s is BoundVariableDeclaration d
                && d.Variable.Name.StartsWith(GeneratedNames.SpillTempPrefix))
            {
                spillCount++;
            }

            if (s is BoundExpressionStatement es && es.Expression is BoundIndexAssignmentExpression fix)
            {
                finalIxa = fix;
            }
        }

        Assert.True(spillCount >= 1, "Expected at least one spill temp for the await.");
        Assert.NotNull(finalIxa);
        Assert.IsNotType<BoundAwaitExpression>(finalIxa!.Value);
    }

    [Fact]
    public void Index_Assignment_With_Await_In_Index_And_Value_Spills_Both()
    {
        // Arrange: arr[await t1] = await t2  — index must be stabilized to a
        // temp because the RHS await suspends after the index is computed.
        var arr = new LocalVariableSymbol("arr", false, ArrayTypeSymbol.Get(TypeSymbol.Int32, 3));
        var awaitIdx = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var awaitVal = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var ixa = new BoundIndexAssignmentExpression(null, arr, awaitIdx, awaitVal, TypeSymbol.Int32);
        var stmt = new BoundExpressionStatement(null, ixa);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(stmt));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: at least two spill temps (index await + value await).
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
    public void Spilled_Await_Inside_Try_Block_Is_Spilled()
    {
        // Arrange: try { f(sideEffect(), await task) }
        // The spiller must descend into the protected block and lift the
        // sub-expression await to statement top-level. Previously the try was
        // treated as an await-free leaf, leaving the raw await for the emitter.
        var arg0 = MakeCall("sideEffect", TypeSymbol.Int32);
        var arg1 = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var call = new BoundCallExpression(
            null,
            MakeFunction("f", TypeSymbol.Int32, TypeSymbol.Int32, TypeSymbol.Int32),
            ImmutableArray.Create<BoundExpression>(arg0, arg1));
        var tryBlock = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, call)));
        var tryStmt = new BoundTryStatement(
            null,
            tryBlock,
            ImmutableArray<BoundCatchClause>.Empty,
            null);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = SpillSequenceSpiller.Rewrite(body);

        // Assert: the try block body is rewritten with spill temps; no
        // sub-expression await survives below statement level.
        Assert.NotSame(body, result);
        var rewrittenTry = Assert.IsType<BoundTryStatement>(result.Statements[0]);
        var rewrittenBlock = Assert.IsType<BoundBlockStatement>(rewrittenTry.TryBlock);
        Assert.True(
            rewrittenBlock.Statements.Length >= 2,
            "Expected spill statements inside the try block.");

        var hasSpillTemp = false;
        foreach (var s in rewrittenBlock.Statements)
        {
            if (s is BoundVariableDeclaration d
                && d.Variable.Name.StartsWith(GeneratedNames.SpillTempPrefix))
            {
                hasSpillTemp = true;
                break;
            }
        }

        Assert.True(hasSpillTemp, "Expected a spill temp declaration inside the try block.");
    }

    private static BoundCallExpression MakeCall(string name, TypeSymbol returnType)
    {
        var func = new FunctionSymbol(
            name,
            ImmutableArray<ParameterSymbol>.Empty,
            returnType);
        return new BoundCallExpression(null, func, ImmutableArray<BoundExpression>.Empty);
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
