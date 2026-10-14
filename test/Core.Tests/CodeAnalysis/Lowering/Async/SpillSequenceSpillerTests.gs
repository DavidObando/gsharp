// <copyright file="SpillSequenceSpillerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.Reflection
import System.Threading.Tasks
import Xunit

/// Unit tests for (cref:SpillSequenceSpiller). These tests construct
/// bound trees directly (no parsing) and verify the structural shape of the
/// spilled output.
open class SpillSequenceSpillerTests {
    @Fact
    func ConditionalReferenceResult_UsesTypePreservingDefault() {
        let referenceType = TypeSymbol.FromClrType(typeof(object))
        let conditional = BoundConditionalExpression(
            nil,
            BoundLiteralExpression(nil, true),
            BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), referenceType),
            BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), referenceType),
            referenceType
        )
        let resultVariable = LocalVariableSymbol("result", false, referenceType)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundVariableDeclaration(nil, resultVariable, conditional))
        )
        let result = SpillSequenceSpiller.Rewrite(body)
        let spillDeclaration = Assert.IsType[BoundVariableDeclaration](
            Assert.Single(
                result.Statements,
                (statement BoundStatement) -> statement is BoundVariableDeclaration declaration &&
                    declaration.Variable != resultVariable &&
                    declaration
                    .Variable
                    .Type == referenceType &&
                    declaration.Initializer is BoundDefaultExpression
            )
        )
        let initializer = Assert.IsType[BoundDefaultExpression](spillDeclaration.Initializer)
        Assert.Equal(referenceType, initializer.Type)
        Assert.IsNotType[BoundLiteralExpression](initializer)
    }

    @Fact
    func Pure_BinaryExpression_With_AwaitOnRight_SpillsLeft() {
        // Arrange: left is a call (not pure), right is await
        let leftCall = MakeCall("sideEffect", TypeSymbol.Int32)
        let rightAwait = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let binary = BoundBinaryExpression(nil, leftCall, AddOp!!, rightAwait)
        let decl = BoundVariableDeclaration(nil, LocalVariableSymbol("x", false, TypeSymbol.Int32), binary)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](decl))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: the result should have spill temps before the var decl
        Assert.NotSame(body, result)
        // The spilled left should appear as a variable declaration before the final one.
        Assert.True(result.Statements.Length > 1, "Expected spill statements to be generated.")
        // The last statement should be the original variable declaration with
        // a binary expression whose left is now a variable read.
        let lastStmt = result.Statements[^1]
        Assert.IsType[BoundVariableDeclaration](lastStmt)
        let lastDecl = cast[BoundVariableDeclaration](lastStmt)
        Assert.Equal("x", lastDecl.Variable.Name)
    }

    @Fact
    func Pure_BinaryExpression_With_AwaitOnRight_OfPureLeft_DoesNotSpillLeft() {
        // Arrange: left is a literal (pure constant), right is await
        let left = BoundLiteralExpression(nil, 10)
        let rightAwait = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let binary = BoundBinaryExpression(nil, left, AddOp!!, rightAwait)
        let decl = BoundVariableDeclaration(nil, LocalVariableSymbol("x", false, TypeSymbol.Int32), binary)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](decl))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: The left literal should NOT be spilled (no extra decl for it).
        // We expect: spill temp for await result, then final decl.
        Assert.NotSame(body, result)
        // None of the intermediate declarations should be for the literal 10.
        for stmt in result.Statements {
            if stmt is BoundVariableDeclaration d && d.Variable.Name == "x" {
                continue
            }
            if stmt is BoundVariableDeclaration spillDecl {
                // The spill temp should be for the await result, not for "10"
                Assert.StartsWith(GeneratedNames.SpillTempPrefix, spillDecl.Variable.Name)
            }
        }
    }

    @Fact
    func LogicalAnd_With_Await_OnRight_LowersToIf() {
        // Arrange: left && (await right)
        let left = BoundVariableExpression(nil, LocalVariableSymbol("a", true, TypeSymbol.Bool))
        let rightAwait = BoundAwaitExpression(nil, BoundLiteralExpression(nil, true), TypeSymbol.Bool)
        let binary = BoundBinaryExpression(nil, left, LogicalAndOp!!, rightAwait)
        let stmt = BoundExpressionStatement(nil, binary)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](stmt))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: should contain a conditional goto for short-circuit semantics
        Assert.NotSame(body, result)
        var hasConditionalGoto = false
        for s in result.Statements {
            if s is BoundConditionalGotoStatement {
                hasConditionalGoto = true
                break
            }
        }
        Assert.True(hasConditionalGoto, "LogicalAnd with await should lower to conditional goto statements.")
    }

    @Fact
    func LogicalOr_With_Await_OnRight_LowersToIf() {
        // Arrange: left || (await right)
        let left = BoundVariableExpression(nil, LocalVariableSymbol("a", true, TypeSymbol.Bool))
        let rightAwait = BoundAwaitExpression(nil, BoundLiteralExpression(nil, false), TypeSymbol.Bool)
        let binary = BoundBinaryExpression(nil, left, LogicalOrOp!!, rightAwait)
        let stmt = BoundExpressionStatement(nil, binary)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](stmt))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert
        Assert.NotSame(body, result)
        var hasConditionalGoto = false
        for s in result.Statements {
            if s is BoundConditionalGotoStatement {
                hasConditionalGoto = true
                break
            }
        }
        Assert.True(hasConditionalGoto, "LogicalOr with await should lower to conditional goto statements.")
    }

    @Fact
    func Method_Call_With_Await_As_Second_Argument_SpillsFirstArg() {
        // Arrange: f(sideEffect(), await task)
        let arg0 = MakeCall("sideEffect", TypeSymbol.Int32)
        let arg1 = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let call = BoundCallExpression(
            nil,
            MakeFunction("f", TypeSymbol.Int32, TypeSymbol.Int32, TypeSymbol.Int32),
            ImmutableArray.Create[BoundExpression](arg0, arg1)
        )
        let decl = BoundVariableDeclaration(nil, LocalVariableSymbol("r", false, TypeSymbol.Int32), call)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](decl))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: first arg should be spilled into a temp before the await
        Assert.NotSame(body, result)
        Assert.True(result.Statements.Length >= 2, "Expected at least one spill before the call.")
        // Check first statement spills arg0
        let firstDecl = Assert.IsType[BoundVariableDeclaration](result.Statements[0])
        Assert.StartsWith(GeneratedNames.SpillTempPrefix, firstDecl.Variable.Name)
    }

    @Fact
    func Method_Call_On_Reference_Receiver_With_Await_Arg_SpillsReceiver() {
        // Arrange: receiver.Method(await task)
        let receiver = MakeCall("getObj", TypeSymbol.String)
        let arg = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let method MethodInfo? = typeof(string).GetMethod("Substring", []Type{typeof(int32)})
        let call = BoundImportedInstanceCallExpression(
            nil,
            receiver,
            method!!,
            TypeSymbol.String,
            ImmutableArray.Create[BoundExpression](arg)
        )
        let decl = BoundVariableDeclaration(nil, LocalVariableSymbol("s", false, TypeSymbol.String), call)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](decl))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: receiver should be spilled
        Assert.NotSame(body, result)
        // Find the spill temp for the receiver
        var hasReceiverSpill = false
        for s in result.Statements {
            if s is BoundVariableDeclaration d &&
                d
                .Variable
                .Name
                .StartsWith(GeneratedNames.SpillTempPrefix) &&
                d.Initializer is BoundCallExpression {
                hasReceiverSpill = true
                break
            }
        }
        Assert.True(hasReceiverSpill, "Receiver should be spilled when args contain await.")
    }

    @Fact
    func Nested_Await_In_Binary_BothSidesAwait_BothSpilled() {
        // Arrange: (await t1) + (await t2)
        let awaitLeft = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let awaitRight = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let binary = BoundBinaryExpression(nil, awaitLeft, AddOp!!, awaitRight)
        let decl = BoundVariableDeclaration(nil, LocalVariableSymbol("x", false, TypeSymbol.Int32), binary)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](decl))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: both awaits should be spilled
        Assert.NotSame(body, result)
        var spillCount = 0
        for s in result.Statements {
            if s is BoundVariableDeclaration d && d.Variable.Name.StartsWith(GeneratedNames.SpillTempPrefix) {
                spillCount++
            }
        }
        Assert.True(spillCount >= 2, "Expected at least 2 spill temps but got $spillCount.")
    }

    @Fact
    func Await_AlreadyAt_TopLevel_NotSpilled() {
        // Arrange: await task (expression statement)
        let awaitExpr = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let stmt = BoundExpressionStatement(nil, awaitExpr)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](stmt))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: should be unchanged (idempotent)
        Assert.Same(body, result)
    }

    @Fact
    func TopLevelAwait_WithAwaitInCallArgument_SpillsInnerAwait() {
        let taskType = TypeSymbol.FromClrType(typeof(Task))
        let innerAwait = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let call = BoundCallExpression(
            nil,
            MakeFunction("consumeAsync", taskType, TypeSymbol.Int32),
            ImmutableArray.Create[BoundExpression](innerAwait)
        )
        let outerAwait = BoundAwaitExpression(nil, call, TypeSymbol.Void)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, outerAwait))
        )
        let result = SpillSequenceSpiller.Rewrite(body)
        Assert.NotSame(body, result)
        Assert.Contains(
            result.Statements,
            (statement BoundStatement) -> statement is BoundVariableDeclaration &&
                statement.Initializer is BoundAwaitExpression
        )
        let finalAwait = Assert.IsType[BoundAwaitExpression](
            Assert.IsType[BoundExpressionStatement](result.Statements[^1]).Expression
        )
        let finalCall = Assert.IsType[BoundCallExpression](finalAwait.Expression)
        Assert.IsType[BoundVariableExpression](Assert.Single(finalCall.Arguments))
    }

    @Fact
    func NonAsync_Function_NotProcessed() {
        // Arrange: a body without any await
        let literal = BoundLiteralExpression(nil, 42)
        let decl = BoundVariableDeclaration(nil, LocalVariableSymbol("x", false, TypeSymbol.Int32), literal)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](decl))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: should be unchanged
        Assert.Same(body, result)
    }

    @Fact
    func Unary_Expression_With_Await_Operand_Spills_Operand() {
        // Arrange: -(await t)
        let op BoundUnaryOperator? = BoundUnaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32)
        let awaitOperand = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let unary = BoundUnaryExpression(nil, op!!, awaitOperand)
        let decl = BoundVariableDeclaration(nil, LocalVariableSymbol("x", false, TypeSymbol.Int32), unary)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](decl))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: the await is lifted to a spill temp before the final decl.
        Assert.NotSame(body, result)
        Assert.True(result.Statements.Length >= 2, "Expected spill statements before the final declaration.")
        // The first spill temp's initializer should be the await.
        let firstDecl = Assert.IsType[BoundVariableDeclaration](result.Statements[0])
        Assert.StartsWith(GeneratedNames.SpillTempPrefix, firstDecl.Variable.Name)
        Assert.IsType[BoundAwaitExpression](firstDecl.Initializer)
        // The final declaration's initializer is a unary expression whose operand
        // is a variable read (the spill temp), not the original await.
        let lastDecl = Assert.IsType[BoundVariableDeclaration](result.Statements[^1])
        let unaryOut = Assert.IsType[BoundUnaryExpression](lastDecl.Initializer)
        Assert.IsType[BoundVariableExpression](unaryOut.Operand)
    }

    @Fact
    func Unary_Expression_Without_Await_Returns_Trivial() {
        // Arrange: -literal (no await).
        let op BoundUnaryOperator? = BoundUnaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32)
        let unary = BoundUnaryExpression(nil, op!!, BoundLiteralExpression(nil, 5))
        let decl = BoundVariableDeclaration(nil, LocalVariableSymbol("x", false, TypeSymbol.Int32), unary)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](decl))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: unchanged because there's no await anywhere.
        Assert.Same(body, result)
    }

    @Fact
    func Index_Assignment_With_Await_RHS_Spills_Value() {
        // Arrange: arr[0] = await t  (Target is a VariableSymbol)
        let arr = LocalVariableSymbol("arr", false, ArrayTypeSymbol.Get(TypeSymbol.Int32, 3))
        let awaitVal = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let ixa = BoundIndexAssignmentExpression(nil, arr, BoundLiteralExpression(nil, 0), awaitVal, TypeSymbol.Int32)
        let stmt = BoundExpressionStatement(nil, ixa)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](stmt))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: a spill temp for the await result is introduced, then the
        // final index assignment uses the temp as its value (no embedded await).
        Assert.NotSame(body, result)
        var spillCount = 0
        var finalIxa BoundIndexAssignmentExpression? = nil
        for s in result.Statements {
            if s is BoundVariableDeclaration d && d.Variable.Name.StartsWith(GeneratedNames.SpillTempPrefix) {
                spillCount++
            }
            if s is BoundExpressionStatement es && es.Expression is BoundIndexAssignmentExpression fix {
                finalIxa = fix
            }
        }
        Assert.True(spillCount >= 1, "Expected at least one spill temp for the await.")
        Assert.NotNull(finalIxa)
        Assert.IsNotType[BoundAwaitExpression](finalIxa!!.Value)
    }

    @Fact
    func Index_Assignment_With_Await_In_Index_And_Value_Spills_Both() {
        // Arrange: arr[await t1] = await t2  — index must be stabilized to a
        // temp because the RHS await suspends after the index is computed.
        let arr = LocalVariableSymbol("arr", false, ArrayTypeSymbol.Get(TypeSymbol.Int32, 3))
        let awaitIdx = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let awaitVal = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let ixa = BoundIndexAssignmentExpression(nil, arr, awaitIdx, awaitVal, TypeSymbol.Int32)
        let stmt = BoundExpressionStatement(nil, ixa)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](stmt))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: at least two spill temps (index await + value await).
        Assert.NotSame(body, result)
        var spillCount = 0
        for s in result.Statements {
            if s is BoundVariableDeclaration d && d.Variable.Name.StartsWith(GeneratedNames.SpillTempPrefix) {
                spillCount++
            }
        }
        Assert.True(spillCount >= 2, "Expected at least 2 spill temps but got $spillCount.")
    }

    @Fact
    func Spilled_Await_Inside_Try_Block_Is_Spilled() {
        // Arrange: try { f(sideEffect(), await task) }
        // The spiller must descend into the protected block and lift the
        // sub-expression await to statement top-level. Previously the try was
        // treated as an await-free leaf, leaving the raw await for the emitter.
        let arg0 = MakeCall("sideEffect", TypeSymbol.Int32)
        let arg1 = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let call = BoundCallExpression(
            nil,
            MakeFunction("f", TypeSymbol.Int32, TypeSymbol.Int32, TypeSymbol.Int32),
            ImmutableArray.Create[BoundExpression](arg0, arg1)
        )
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, call))
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray[BoundCatchClause].Empty, nil)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = SpillSequenceSpiller.Rewrite(body)
        // Assert: the try block body is rewritten with spill temps; no
        // sub-expression await survives below statement level.
        Assert.NotSame(body, result)
        let rewrittenTry = Assert.IsType[BoundTryStatement](result.Statements[0])
        let rewrittenBlock = Assert.IsType[BoundBlockStatement](rewrittenTry.TryBlock)
        Assert.True(rewrittenBlock.Statements.Length >= 2, "Expected spill statements inside the try block.")
        var hasSpillTemp = false
        for s in rewrittenBlock.Statements {
            if s is BoundVariableDeclaration d && d.Variable.Name.StartsWith(GeneratedNames.SpillTempPrefix) {
                hasSpillTemp = true
                break
            }
        }
        Assert.True(hasSpillTemp, "Expected a spill temp declaration inside the try block.")
    }

    shared {
        private let AddOp BoundBinaryOperator? = BoundBinaryOperator.Bind(
            SyntaxKind.PlusToken,
            TypeSymbol.Int32,
            TypeSymbol.Int32
        )
        private let LogicalAndOp BoundBinaryOperator? = BoundBinaryOperator.Bind(
            SyntaxKind.AmpersandAmpersandToken,
            TypeSymbol.Bool,
            TypeSymbol.Bool
        )
        private let LogicalOrOp BoundBinaryOperator? = BoundBinaryOperator.Bind(
            SyntaxKind.PipePipeToken,
            TypeSymbol.Bool,
            TypeSymbol.Bool
        )

        private func MakeCall(name string, returnType TypeSymbol) BoundCallExpression {
            let func_ = FunctionSymbol(name, ImmutableArray[ParameterSymbol].Empty, returnType)
            return BoundCallExpression(nil, func_, ImmutableArray[BoundExpression].Empty)
        }

        private func MakeFunction(name string, returnType TypeSymbol, paramTypes ...TypeSymbol) FunctionSymbol {
            let parameters = ImmutableArray.CreateBuilder[ParameterSymbol]()
            for var i = 0; i < paramTypes.Length; i++ {
                parameters.Add(ParameterSymbol("p" + i.ToString(), paramTypes[i]))
            }
            return FunctionSymbol(name, parameters.ToImmutable(), returnType)
        }
    }
}
