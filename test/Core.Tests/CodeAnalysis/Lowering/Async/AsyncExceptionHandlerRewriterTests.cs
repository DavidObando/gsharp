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
    public void TryFinally_WithAwait_FunnelsEarlyReturnThroughLiftedFinally()
    {
        // Arrange: try { return 7 } finally { await ... } — Pattern C (#1484).
        // The early return leaves a try whose finally awaits, so it must be
        // captured into a pending-branch discriminator and resumed AFTER the
        // lifted finally, not emitted as a raw pass-through return.
        var tryBlock = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(
                new BoundReturnStatement(null, new BoundLiteralExpression(null, 7))));
        var awaitExpr = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var finallyBlock = new BoundBlockStatement(
            null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, awaitExpr)));
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray<BoundCatchClause>.Empty, finallyBlock);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert: the try is rewritten and a pending-branch discriminator plus a
        // pending-return-value local are declared.
        Assert.NotSame(body, result);
        var innerBlock = Assert.IsType<BoundBlockStatement>(result.Statements[0]);
        var decls = innerBlock.Statements.OfType<BoundVariableDeclaration>().ToList();
        Assert.Contains(decls, d => d.Variable.Name.Contains("<>pending_branch_"));
        Assert.Contains(decls, d => d.Variable.Name.Contains("<>pending_ret_"));

        // The rewritten inner try must NOT contain a raw return anymore — the
        // return was funneled into a pending-branch capture + goto.
        var innerTry = innerBlock.Statements.OfType<BoundTryStatement>().First();
        Assert.False(ContainsReturn(innerTry.TryBlock), "Early return must be funneled, not left in the try body.");

        // A raw return IS re-emitted after the lifted finally (the dispatch),
        // outside any protected region.
        Assert.True(
            innerBlock.Statements.Skip(1).Any(ContainsReturn),
            "A resume `return` should be dispatched after the lifted finally.");

        // The lifted await still appears outside the protected region.
        Assert.True(
            innerBlock.Statements.Any(s => AsyncBoundTreeQueries.HasAwait(s) && !(s is BoundTryStatement)),
            "Await should be lifted outside the try region.");
    }

    private static bool ContainsReturn(BoundStatement statement)
    {
        switch (statement)
        {
            case BoundReturnStatement:
                return true;
            case BoundBlockStatement block:
                return block.Statements.Any(ContainsReturn);
            case BoundTryStatement tryStmt:
                return ContainsReturn(tryStmt.TryBlock)
                    || tryStmt.CatchClauses.Any(c => ContainsReturn(c.Body))
                    || (tryStmt.FinallyBlock != null && ContainsReturn(tryStmt.FinallyBlock));
            default:
                return false;
        }
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

        // Pending exception declaration is first.
        Assert.IsType<BoundVariableDeclaration>(innerBlock.Statements[0]);

        // Find the (single) rewritten try statement. Issue #419: the rewriter
        // now also emits a per-clause capture local before the try, so the try
        // is no longer at a fixed index — locate it instead.
        var rewrittenTry = innerBlock.Statements.OfType<BoundTryStatement>().Single();
        Assert.Single(rewrittenTry.CatchClauses);

        // The rewritten catch keeps the ORIGINAL exception type (no widening
        // to System.Exception) so the CLR catch dispatch only matches the
        // intended type (issue #419).
        Assert.Same(ExceptionType, rewrittenTry.CatchClauses[0].ExceptionType);

        // The catch body should be a block of assignments
        // (capture_i = e; pendingException = e;)
        var catchBodyRewritten = rewrittenTry.CatchClauses[0].Body;
        var catchBlock = Assert.IsType<BoundBlockStatement>(catchBodyRewritten);
        Assert.Equal(2, catchBlock.Statements.Length);
        Assert.IsType<BoundExpressionStatement>(catchBlock.Statements[0]);
        Assert.IsType<BoundExpressionStatement>(catchBlock.Statements[1]);

        // The await should be outside the try (in the lifted handler section)
        var tryIndex = innerBlock.Statements.IndexOf(rewrittenTry);
        var afterTry = innerBlock.Statements.Skip(tryIndex + 1).ToArray();
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

    // ----------------------------------------------------------------------
    // Issue #419: typed catch with await must keep its original exception type
    // so the CLR catch dispatch only fires for matching exceptions.
    // ----------------------------------------------------------------------

    /// <summary>
    /// A struct-class derived from <see cref="System.Exception"/> used to stand
    /// in for a custom typed catch in the rewriter tests.
    /// </summary>
    private static TypeSymbol MakeDerivedExceptionType()
    {
        // ArgumentException is a real subtype of Exception in the host runtime,
        // making it a convenient typed-catch target for structural assertions.
        return TypeSymbol.FromClrType(typeof(System.ArgumentException));
    }

    [Fact]
    public void TryCatch_TypedCatch_WithAwait_KeepsOriginalCatchType()
    {
        // Arrange: try { x = 1 } catch (e ArgumentException) { await ... }
        // The rewriter must NOT widen this to catch (Exception); otherwise an
        // InvalidOperationException would also be swallowed.
        var argExType = MakeDerivedExceptionType();
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var e = new LocalVariableSymbol("e", false, argExType);
        var tryBlock = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var awaitExpr = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var catchBody = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, awaitExpr)));
        var catchClause = new BoundCatchClause(argExType, e, catchBody);
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchClause), null);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert
        var innerBlock = Assert.IsType<BoundBlockStatement>(result.Statements[0]);
        var rewrittenTry = innerBlock.Statements.OfType<BoundTryStatement>().Single();
        Assert.Single(rewrittenTry.CatchClauses);
        // The catch type must remain the ORIGINAL ArgumentException — never
        // widened to System.Exception.
        Assert.Same(argExType, rewrittenTry.CatchClauses[0].ExceptionType);
        Assert.NotSame(ExceptionType, rewrittenTry.CatchClauses[0].ExceptionType);
    }

    [Fact]
    public void TryCatch_MultipleTypedCatches_WithAwait_KeepEachOriginalType()
    {
        // Arrange: catch (a ArgumentException) { await } catch (g Exception) { await }
        // Both clauses must remain typed: the CLR's in-order dispatch handles
        // the discriminative routing, and each lifted handler runs only for
        // its own exception type.
        var argExType = MakeDerivedExceptionType();
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var a = new LocalVariableSymbol("a", false, argExType);
        var g = new LocalVariableSymbol("g", false, ExceptionType);
        var tryBlock = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var awaitA = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var catchBodyA = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, awaitA)));
        var catchA = new BoundCatchClause(argExType, a, catchBodyA);
        var awaitG = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var catchBodyG = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, awaitG)));
        var catchG = new BoundCatchClause(ExceptionType, g, catchBodyG);
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchA, catchG), null);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert
        var innerBlock = Assert.IsType<BoundBlockStatement>(result.Statements[0]);
        var rewrittenTry = innerBlock.Statements.OfType<BoundTryStatement>().Single();
        Assert.Equal(2, rewrittenTry.CatchClauses.Length);
        Assert.Same(argExType, rewrittenTry.CatchClauses[0].ExceptionType);
        Assert.Same(ExceptionType, rewrittenTry.CatchClauses[1].ExceptionType);
    }

    [Fact]
    public void TryCatch_TypedCatchWithAwait_FollowedByGeneralCatch_PreservesFallthrough()
    {
        // Arrange: catch (a ArgumentException) { await }   <- with await
        //          catch (g Exception) { x = 2 }           <- without await; stays in place
        // The general catch must remain reachable: prior to the fix, the
        // ArgumentException clause was widened to Exception and shadowed it.
        var argExType = MakeDerivedExceptionType();
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var a = new LocalVariableSymbol("a", false, argExType);
        var g = new LocalVariableSymbol("g", false, ExceptionType);
        var tryBlock = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var awaitA = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var catchBodyA = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, awaitA)));
        var catchA = new BoundCatchClause(argExType, a, catchBodyA);
        var catchBodyG = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 2)))));
        var catchG = new BoundCatchClause(ExceptionType, g, catchBodyG);
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchA, catchG), null);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert
        var innerBlock = Assert.IsType<BoundBlockStatement>(result.Statements[0]);
        var rewrittenTry = innerBlock.Statements.OfType<BoundTryStatement>().Single();
        Assert.Equal(2, rewrittenTry.CatchClauses.Length);

        // First clause: typed catch with await — keeps ArgumentException type
        // and body is the capture/pending assignments (not the original body).
        Assert.Same(argExType, rewrittenTry.CatchClauses[0].ExceptionType);
        var typedBody = Assert.IsType<BoundBlockStatement>(rewrittenTry.CatchClauses[0].Body);
        Assert.All(typedBody.Statements, s => Assert.IsType<BoundExpressionStatement>(s));

        // Second clause: stays in place untouched (its body is the original).
        Assert.Same(ExceptionType, rewrittenTry.CatchClauses[1].ExceptionType);
        Assert.Same(catchBodyG, rewrittenTry.CatchClauses[1].Body);
    }

    [Fact]
    public void TryCatch_TypedCatchWithAwait_DispatchUsesPerClauseCaptureNotPending()
    {
        // The post-try lifted handler must check a per-clause capture local
        // (not the shared pendingException) so that when the catch-all (or
        // another catch) sets pendingException to an unrelated exception, the
        // handler does not erroneously run.
        var argExType = MakeDerivedExceptionType();
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var e = new LocalVariableSymbol("e", false, argExType);
        var tryBlock = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var awaitExpr = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var catchBody = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, awaitExpr)));
        var catchClause = new BoundCatchClause(argExType, e, catchBody);
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchClause), null);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert
        var innerBlock = Assert.IsType<BoundBlockStatement>(result.Statements[0]);

        // Should have a per-clause capture local declared before the try.
        var declsBeforeTry = innerBlock.Statements
            .TakeWhile(s => s is not BoundTryStatement)
            .OfType<BoundVariableDeclaration>()
            .ToArray();
        Assert.Contains(declsBeforeTry, d => d.Variable.Name.StartsWith("<>catch_capture_", System.StringComparison.Ordinal));
        Assert.Contains(declsBeforeTry, d => d.Variable.Name.StartsWith("<>pending_ex_", System.StringComparison.Ordinal));
    }

    [Fact]
    public void TryCatchFinally_TypedCatchWithAwait_KeepsTypedDispatch()
    {
        // Pattern B (finally has await) must still keep the typed catch's
        // original exception type. The trailing catch-all (Exception) is the
        // pattern-required capture for the finally; the typed catch retains
        // its narrow type ahead of it.
        var argExType = MakeDerivedExceptionType();
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var e = new LocalVariableSymbol("e", false, argExType);
        var tryBlock = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var awaitA = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var catchBody = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, awaitA)));
        var catchClause = new BoundCatchClause(argExType, e, catchBody);
        var awaitF = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var finallyBlock = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, awaitF)));
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchClause), finallyBlock);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert
        var innerBlock = Assert.IsType<BoundBlockStatement>(result.Statements[0]);
        var rewrittenTry = innerBlock.Statements.OfType<BoundTryStatement>().Single();
        Assert.Null(rewrittenTry.FinallyBlock);

        // Two clauses: typed [ArgumentException] then catch-all [Exception]
        // (the catch-all is the finally-pattern capture).
        Assert.Equal(2, rewrittenTry.CatchClauses.Length);
        Assert.Same(argExType, rewrittenTry.CatchClauses[0].ExceptionType);
        Assert.Same(ExceptionType, rewrittenTry.CatchClauses[1].ExceptionType);
    }

    // ----------------------------------------------------------------------
    // Issue #418 P1-11: the auto-rethrow at the tail of a try/finally-with-await
    // rewrite must preserve the original stack trace by going through
    // ExceptionDispatchInfo.Capture(...).Throw() instead of `throw ex;`.
    // ----------------------------------------------------------------------

    [Fact]
    public void TryFinally_WithAwaitInFinally_RethrowsViaExceptionDispatchInfo_NotBareThrow()
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

        // Assert: the auto-rethrow at the tail must NOT be a BoundThrowStatement
        // (which would lower to `throw ex` and reset the stack trace). It must
        // call ExceptionDispatchInfo.Capture(pendingException).Throw().
        var innerBlock = Assert.IsType<BoundBlockStatement>(result.Statements[0]);
        var allStmts = FlattenStatements(innerBlock).ToArray();

        // No BoundThrowStatement should be present anywhere in the rewritten body —
        // the only throw-shaped operation should be the EDI Throw() instance call.
        Assert.DoesNotContain(allStmts, s => s is BoundThrowStatement);

        // Locate the EDI Throw() call.
        var ediThrowCalls = allStmts
            .OfType<BoundExpressionStatement>()
            .Select(es => es.Expression)
            .OfType<BoundImportedInstanceCallExpression>()
            .Where(ic => ic.Method.DeclaringType == typeof(System.Runtime.ExceptionServices.ExceptionDispatchInfo)
                         && ic.Method.Name == nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw))
            .ToArray();
        Assert.Single(ediThrowCalls);

        // The receiver must be ExceptionDispatchInfo.Capture(pendingException).
        var receiverCall = Assert.IsType<BoundImportedCallExpression>(ediThrowCalls[0].Receiver);
        Assert.Equal(nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture), receiverCall.Function.Method.Name);
        Assert.Equal(typeof(System.Runtime.ExceptionServices.ExceptionDispatchInfo), receiverCall.Function.Method.DeclaringType);

        // Capture must take a single Exception-typed argument: the pendingException local.
        var arg = Assert.Single(receiverCall.Arguments);
        var pendingRef = Assert.IsType<BoundVariableExpression>(arg);
        Assert.Contains("<>pending_ex_", pendingRef.Variable.Name);
    }

    [Fact]
    public void TryCatchFinally_WithAwait_RethrowUsesExceptionDispatchInfo()
    {
        // Arrange: try { x = 1 } catch (e) { x = 2 } finally { await b }
        // The rewriter must lift the finally and emit an EDI-based rethrow at the
        // tail, NOT a bare `throw pendingException`.
        var x = new LocalVariableSymbol("x", false, TypeSymbol.Int32);
        var e = new LocalVariableSymbol("e", false, ExceptionType);
        var tryBlock = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 1)))));
        var catchBody = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, new BoundAssignmentExpression(null, x, new BoundLiteralExpression(null, 2)))));
        var catchClause = new BoundCatchClause(ExceptionType, e, catchBody);
        var awaitB = new BoundAwaitExpression(null, new BoundLiteralExpression(null, 0), TypeSymbol.Int32);
        var finallyBlock = new BoundBlockStatement(null,
            ImmutableArray.Create<BoundStatement>(new BoundExpressionStatement(null, awaitB)));
        var tryStmt = new BoundTryStatement(null, tryBlock, ImmutableArray.Create(catchClause), finallyBlock);
        var body = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(tryStmt));

        // Act
        var result = AsyncExceptionHandlerRewriter.Rewrite(body);

        // Assert: no bare BoundThrowStatement in the rewritten body; EDI Throw() exists.
        var innerBlock = Assert.IsType<BoundBlockStatement>(result.Statements[0]);
        var allStmts = FlattenStatements(innerBlock).ToArray();
        Assert.DoesNotContain(allStmts, s => s is BoundThrowStatement);
        Assert.Contains(
            allStmts.OfType<BoundExpressionStatement>().Select(s => s.Expression).OfType<BoundImportedInstanceCallExpression>(),
            ic => ic.Method.DeclaringType == typeof(System.Runtime.ExceptionServices.ExceptionDispatchInfo)
                  && ic.Method.Name == nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw));
    }

    /// <summary>
    /// Recursively yields all <see cref="BoundStatement"/> nodes in a block,
    /// descending into nested <see cref="BoundBlockStatement"/>s. Used so tests
    /// can assert on the absence of specific statement kinds anywhere in the
    /// rewritten body regardless of nesting introduced by the rewriter.
    /// </summary>
    private static System.Collections.Generic.IEnumerable<BoundStatement> FlattenStatements(BoundBlockStatement block)
    {
        foreach (var stmt in block.Statements)
        {
            yield return stmt;
            if (stmt is BoundBlockStatement nested)
            {
                foreach (var inner in FlattenStatements(nested))
                {
                    yield return inner;
                }
            }
        }
    }
}
