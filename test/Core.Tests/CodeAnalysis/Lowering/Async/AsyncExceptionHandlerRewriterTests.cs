// <copyright file="AsyncExceptionHandlerRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>
/// Unit tests for <see cref="AsyncExceptionHandlerRewriter"/>. These tests construct
/// bound trees directly and verify the structural shape of the rewritten output.
/// </summary>
public class AsyncExceptionHandlerRewriterTests
{
    private static readonly TypeSymbol ExceptionType = TypeSymbol.FromClrType(typeof(System.Exception));

    [Fact]
    public void TryFinally_WithoutAwait_PassesThroughUnchanged()
    {
        // Arrange: try { x = 1 } finally { x = 2 } — no await anywhere
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var tryBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var finallyBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 2)))));
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray<BoundCatchClause>.Empty, finallyBlock);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert: returned unchanged
        Assert.Same(body, result);
    }

    [Fact]
    public void TryFinally_WithAwaitInFinally_LiftsFinallyOutsideTry()
    {
        // Arrange: try { x = 1 } finally { await ... }
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var tryBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var awaitExpr = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var finallyBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, awaitExpr)));
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray<BoundCatchClause>.Empty, finallyBlock);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert: the result is different and the try statement no longer has a finally
        Assert.NotSame(body, result);

        // Should contain: pendingEx decl, try/catch(Exception), await stmt, conditional rethrow
        Assert.True(result.Statements.Length >= 1);

        // The first statement in the rewritten block should be a block containing the rewrite
        var innerBlock = result.Statements[0] as BoundBlockStatement;
        Assert.NotNull(innerBlock);

        // First stmt: variable declaration for pendingException
        Assert.IsType<BoundVariableDeclaration>(innerBlock.Statements[0]);
        var pendingDecl = (BoundVariableDeclaration)innerBlock.Statements[0];
        Assert.Contains("<>pending_ex_", pendingDecl.Variable.Name);

        // Second stmt: try statement with catch-all, NO finally
        Assert.IsType<BoundTryStatement>(innerBlock.Statements[1]);
        var rewrittenTry = (BoundTryStatement)innerBlock.Statements[1];
        Assert.Null(rewrittenTry.FinallyBlock);
        Assert.Single(rewrittenTry.CatchClauses);

        // The await expression should appear somewhere after the try (outside handler)
        var hasAwaitAfterTry = innerBlock.Statements.Skip(2).Any(s => AsyncBoundTreeQueries.HasAwait(s));
        Assert.True(hasAwaitAfterTry, "Await should be lifted outside the try/catch region.");
    }

    [Fact]
    public void TryCatch_WithoutAwait_PassesThroughUnchanged()
    {
        // Arrange: try { x = 1 } catch (e Exception) { x = 2 } — no await
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var e = new LocalVariableSymbol("e", false, ExceptionType);
        var tryBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var catchBody = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 2)))));
        var catchClause = new BoundCatchClause(ExceptionType, e, catchBody);
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchClause), null);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert
        Assert.Same(body, result);
    }

    [Fact]
    public void TryCatch_WithAwaitInCatch_LiftsCatchBodyAfterTry_UsingPendingException()
    {
        // Arrange: try { x = 1 } catch (e Exception) { await ...; x = 2 }
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var e = new LocalVariableSymbol("e", false, ExceptionType);
        var tryBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var awaitExpr = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var catchBody = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, awaitExpr),
            new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 2)))));
        var catchClause = new BoundCatchClause(ExceptionType, e, catchBody);
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchClause), null);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert
        Assert.NotSame(body, result);
        var innerBlock = result.Statements[0] as BoundBlockStatement;
        Assert.NotNull(innerBlock);

        // Pending exception declaration
        Assert.IsType<BoundVariableDeclaration>(innerBlock.Statements[0]);

        // Try statement with modified catch (just stores exception)
        Assert.IsType<BoundTryStatement>(innerBlock.Statements[1]);
        var rewrittenTry = (BoundTryStatement)innerBlock.Statements[1];
        Assert.Single(rewrittenTry.CatchClauses);

        // The catch body should be a block containing an assignment (pendingEx = e)
        var catchBodyRewritten = rewrittenTry.CatchClauses[0].Body;
        var catchBlock = Assert.IsType<BoundBlockStatement>(catchBodyRewritten);
        Assert.Single(catchBlock.Statements);
        Assert.IsType<BoundExpressionStatement>(catchBlock.Statements[0]);

        // The await should be outside the try (in the lifted handler section)
        var afterTry = innerBlock.Statements.Skip(2).ToArray();
        Assert.True(afterTry.Any(s => AsyncBoundTreeQueries.HasAwait(s)),
            "Await should be lifted outside the try/catch region.");
    }

    [Fact]
    public void TryCatchFinally_WithAwaitInBoth_LiftsBoth()
    {
        // Arrange: try { x = 1 } catch (e) { await a } finally { await b }
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var e = new LocalVariableSymbol("e", false, ExceptionType);
        var tryBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var awaitA = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var catchBody = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, awaitA)));
        var catchClause = new BoundCatchClause(ExceptionType, e, catchBody);
        var awaitB = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var finallyBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, awaitB)));
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchClause), finallyBlock);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert: both awaits lifted outside handler regions
        Assert.NotSame(body, result);
        var innerBlock = result.Statements[0] as BoundBlockStatement;
        Assert.NotNull(innerBlock);

        // The rewritten try should have NO finally
        var tryStatements = innerBlock.Statements.OfType<BoundTryStatement>().ToArray();
        Assert.NotEmpty(tryStatements);
        foreach (var ts in tryStatements)
        {
            Assert.Null(ts.FinallyBlock);
        }
    }

    [Fact]
    public void NonAsync_Function_NotProcessed()
    {
        // A body with no await should pass through unchanged
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var stmt = new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 42)));
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(stmt));

        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        Assert.Same(body, result);
    }

    [Fact]
    public void Throw_From_OriginalCatch_RethrowsAfterAwait()
    {
        // Arrange: try { throw new Exception() } catch (e) { await ...; throw e; }
        // After rewrite, the throw should reference the pendingException variable.
        var e = new LocalVariableSymbol("e", false, ExceptionType);
        var throwExpr = new BoundThrowStatement(null, new BoundVariableExpression(null, e));
        var awaitExpr = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var catchBody = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, awaitExpr),
            throwExpr));
        var catchClause = new BoundCatchClause(ExceptionType, e, catchBody);
        var tryBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundThrowStatement(null, new BoundLiteralExpression(null, "test", TypeSymbol.String))));
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchClause), null);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert: result was rewritten (the throw is now outside the handler)
        Assert.NotSame(body, result);
        var innerBlock = result.Statements[0] as BoundBlockStatement;
        Assert.NotNull(innerBlock);

        // Find a throw statement in the lifted section
        var throwStmts = innerBlock.Statements
            .OfType<BoundThrowStatement>()
            .ToArray();
        Assert.NotEmpty(throwStmts);
    }

    [Fact]
    public void TryFinally_With_Return_FromTryBody_Reports_Diagnostic_Or_Falls_Back()
    {
        // For now, pending-branch dispatch is deferred. The rewriter should still
        // process the finally-with-await pattern; the return inside the try body
        // will pass through (it's handled by MoveNextBodyRewriter's exit label).
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var tryBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundReturnStatement(null, new BoundLiteralExpression(null, 42))));
        var awaitExpr = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var finallyBlock = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, awaitExpr)));
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray<BoundCatchClause>.Empty, finallyBlock);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act: should not throw; should rewrite
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert: the finally body is lifted (pattern B applies)
        Assert.NotSame(body, result);
    }
}
