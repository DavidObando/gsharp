// <copyright file="AsyncExceptionHandlerRewriterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Linq
import System.Runtime.ExceptionServices
import Xunit

/// Unit tests for (cref:AsyncExceptionHandlerRewriter). These tests construct
/// bound trees directly and verify the structural shape of the rewritten output.
open class AsyncExceptionHandlerRewriterTests {
    @Fact
    func TryFinally_WithoutAwait_PassesThroughUnchanged() {
        // Arrange: try { x = 1 } finally { x = 2 } — no await anywhere
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let finallyBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 2)))
            )
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray[BoundCatchClause].Empty, finallyBlock)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert: returned unchanged
        Assert.Same(body, result)
    }

    @Fact
    func TryFinally_WithAwaitInFinally_LiftsFinallyOutsideTry() {
        // Arrange: try { x = 1 } finally { await ... }
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let awaitExpr = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let finallyBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitExpr))
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray[BoundCatchClause].Empty, finallyBlock)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert: the result is different and the try statement no longer has a finally
        Assert.NotSame(body, result)
        // Should contain: pendingEx decl, try/catch(Exception), await stmt, conditional rethrow
        Assert.True(result.Statements.Length >= 1)
        // The first statement in the rewritten block should be a block containing the rewrite
        let innerBlock BoundBlockStatement? = result.Statements[0] as BoundBlockStatement
        Assert.NotNull(innerBlock)
        // First stmt: variable declaration for pendingException
        Assert.IsType[BoundVariableDeclaration](innerBlock!!.Statements[0])
        let pendingDecl = cast[BoundVariableDeclaration](innerBlock!!.Statements[0])
        Assert.Contains("<>pending_ex_", pendingDecl.Variable.Name)
        // Second stmt: try statement with catch-all, NO finally
        Assert.IsType[BoundTryStatement](innerBlock!!.Statements[1])
        let rewrittenTry = cast[BoundTryStatement](innerBlock!!.Statements[1])
        Assert.Null(rewrittenTry.FinallyBlock)
        Assert.Single(rewrittenTry.CatchClauses)
        // The await expression should appear somewhere after the try (outside handler)
        let hasAwaitAfterTry = innerBlock!!
            .Statements
            .Skip(2)
            .Any((s BoundStatement) -> AsyncBoundTreeQueries.HasAwait(s))
        Assert.True(hasAwaitAfterTry, "Await should be lifted outside the try/catch region.")
    }

    @Fact
    func TryFinally_WithAwait_FunnelsEarlyReturnThroughLiftedFinally() {
        // Arrange: try { return 7 } finally { await ... } — Pattern C (#1484).
        // The early return leaves a try whose finally awaits, so it must be
        // captured into a pending-branch discriminator and resumed AFTER the
        // lifted finally, not emitted as a raw pass-through return.
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundReturnStatement(nil, BoundLiteralExpression(nil, 7)))
        )
        let awaitExpr = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let finallyBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitExpr))
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray[BoundCatchClause].Empty, finallyBlock)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert: the try is rewritten and a pending-branch discriminator plus a
        // pending-return-value local are declared.
        Assert.NotSame(body, result)
        let innerBlock = Assert.IsType[BoundBlockStatement](result.Statements[0])
        let decls = innerBlock.Statements.OfType[BoundVariableDeclaration]().ToList()
        Assert.Contains(decls, (d BoundVariableDeclaration) -> d.Variable.Name.Contains("<>pending_branch_"))
        Assert.Contains(decls, (d BoundVariableDeclaration) -> d.Variable.Name.Contains("<>pending_ret_"))
        // The rewritten inner try must NOT contain a raw return anymore — the
        // return was funneled into a pending-branch capture + goto.
        let innerTry = innerBlock.Statements.OfType[BoundTryStatement]().First()
        Assert.False(ContainsReturn(innerTry.TryBlock), "Early return must be funneled, not left in the try body.")
        // A raw return IS re-emitted after the lifted finally (the dispatch),
        // outside any protected region.
        Assert.True(
            innerBlock.Statements.Skip(1).Any(ContainsReturn),
            "A resume `return` should be dispatched after the lifted finally."
        )
        // The lifted await still appears outside the protected region.
        Assert.True(
            innerBlock.Statements.Any(
                (s BoundStatement) -> AsyncBoundTreeQueries.HasAwait(s) && !(s is BoundTryStatement)
            ),
            "Await should be lifted outside the try region."
        )
    }

    @Fact
    func TryCatch_WithoutAwait_PassesThroughUnchanged() {
        // Arrange: try { x = 1 } catch (e Exception) { x = 2 } — no await
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let e = LocalVariableSymbol("e", false, ExceptionType)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let catchBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 2)))
            )
        )
        let catchClause = BoundCatchClause(ExceptionType, e, catchBody)
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchClause), nil)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert
        Assert.Same(body, result)
    }

    @Fact
    func TryCatch_WithAwaitInCatch_LiftsCatchBodyAfterTry_UsingPendingException() {
        // Arrange: try { x = 1 } catch (e Exception) { await ...; x = 2 }
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let e = LocalVariableSymbol("e", false, ExceptionType)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let awaitExpr = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let catchBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, awaitExpr),
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 2)))
            )
        )
        let catchClause = BoundCatchClause(ExceptionType, e, catchBody)
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchClause), nil)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert
        Assert.NotSame(body, result)
        let innerBlock BoundBlockStatement? = result.Statements[0] as BoundBlockStatement
        Assert.NotNull(innerBlock)
        // Pending exception declaration is first.
        Assert.IsType[BoundVariableDeclaration](innerBlock!!.Statements[0])
        // Find the (single) rewritten try statement. Issue #419: the rewriter
        // now also emits a per-clause capture local before the try, so the try
        // is no longer at a fixed index — locate it instead.
        let rewrittenTry = innerBlock!!.Statements.OfType[BoundTryStatement]().Single()
        Assert.Single(rewrittenTry.CatchClauses)
        // The rewritten catch keeps the ORIGINAL exception type (no widening
        // to System.Exception) so the CLR catch dispatch only matches the
        // intended type (issue #419).
        Assert.Same(ExceptionType, rewrittenTry.CatchClauses[0].ExceptionType)
        // The catch body should be a block of assignments
        // (capture_i = e; pendingException = e;)
        let catchBodyRewritten = rewrittenTry.CatchClauses[0].Body
        let catchBlock = Assert.IsType[BoundBlockStatement](catchBodyRewritten)
        Assert.Equal(2, catchBlock.Statements.Length)
        Assert.IsType[BoundExpressionStatement](catchBlock.Statements[0])
        Assert.IsType[BoundExpressionStatement](catchBlock.Statements[1])
        // The await should be outside the try (in the lifted handler section)
        let tryIndex = innerBlock!!.Statements.IndexOf(rewrittenTry)
        let afterTry = innerBlock!!.Statements.Skip(tryIndex + 1).ToArray()
        Assert.True(
            afterTry.Any((s BoundStatement) -> AsyncBoundTreeQueries.HasAwait(s)),
            "Await should be lifted outside the try/catch region."
        )
    }

    @Fact
    func TryCatchFinally_WithAwaitInBoth_LiftsBoth() {
        // Arrange: try { x = 1 } catch (e) { await a } finally { await b }
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let e = LocalVariableSymbol("e", false, ExceptionType)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let awaitA = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let catchBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitA))
        )
        let catchClause = BoundCatchClause(ExceptionType, e, catchBody)
        let awaitB = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let finallyBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitB))
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchClause), finallyBlock)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert: both awaits lifted outside handler regions
        Assert.NotSame(body, result)
        let innerBlock BoundBlockStatement? = result.Statements[0] as BoundBlockStatement
        Assert.NotNull(innerBlock)
        // The rewritten try should have NO finally
        let tryStatements = innerBlock!!.Statements.OfType[BoundTryStatement]().ToArray()
        Assert.NotEmpty(tryStatements)
        for ts in tryStatements {
            Assert.Null(ts.FinallyBlock)
        }
    }

    @Fact
    func NonAsync_Function_NotProcessed() {
        // A body with no await should pass through unchanged
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let stmt = BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 42)))
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](stmt))
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        Assert.Same(body, result)
    }

    @Fact
    func Throw_From_OriginalCatch_RethrowsAfterAwait() {
        // Arrange: try { throw new Exception() } catch (e) { await ...; throw e; }
        // After rewrite, the throw should reference the pendingException variable.
        let e = LocalVariableSymbol("e", false, ExceptionType)
        let throwExpr = BoundThrowStatement(nil, BoundVariableExpression(nil, e))
        let awaitExpr = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let catchBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitExpr), throwExpr)
        )
        let catchClause = BoundCatchClause(ExceptionType, e, catchBody)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundThrowStatement(nil, BoundLiteralExpression(nil, "test", TypeSymbol.String))
            )
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchClause), nil)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert: result was rewritten (the throw is now outside the handler)
        Assert.NotSame(body, result)
        let innerBlock BoundBlockStatement? = result.Statements[0] as BoundBlockStatement
        Assert.NotNull(innerBlock)
        // Find a throw statement in the lifted section
        let throwStmts = innerBlock!!.Statements.OfType[BoundThrowStatement]().ToArray()
        Assert.NotEmpty(throwStmts)
    }

    @Fact
    func TryFinally_With_Return_FromTryBody_Reports_Diagnostic_Or_Falls_Back() {
        // For now, pending-branch dispatch is deferred. The rewriter should still
        // process the finally-with-await pattern; the return inside the try body
        // will pass through (it's handled by MoveNextBodyRewriter's exit label).
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundReturnStatement(nil, BoundLiteralExpression(nil, 42)))
        )
        let awaitExpr = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let finallyBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitExpr))
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray[BoundCatchClause].Empty, finallyBlock)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act: should not throw; should rewrite
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert: the finally body is lifted (pattern B applies)
        Assert.NotSame(body, result)
    }

    @Fact
    func TryCatch_TypedCatch_WithAwait_KeepsOriginalCatchType() {
        // Arrange: try { x = 1 } catch (e ArgumentException) { await ... }
        // The rewriter must NOT widen this to catch (Exception); otherwise an
        // InvalidOperationException would also be swallowed.
        let argExType = MakeDerivedExceptionType()
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let e = LocalVariableSymbol("e", false, argExType)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let awaitExpr = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let catchBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitExpr))
        )
        let catchClause = BoundCatchClause(argExType, e, catchBody)
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchClause), nil)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert
        let innerBlock = Assert.IsType[BoundBlockStatement](result.Statements[0])
        let rewrittenTry = innerBlock.Statements.OfType[BoundTryStatement]().Single()
        Assert.Single(rewrittenTry.CatchClauses)
        // The catch type must remain the ORIGINAL ArgumentException — never
        // widened to System.Exception.
        Assert.Same(argExType, rewrittenTry.CatchClauses[0].ExceptionType)
        Assert.NotSame(ExceptionType, rewrittenTry.CatchClauses[0].ExceptionType)
    }

    @Fact
    func TryCatch_MultipleTypedCatches_WithAwait_KeepEachOriginalType() {
        // Arrange: catch (a ArgumentException) { await } catch (g Exception) { await }
        // Both clauses must remain typed: the CLR's in-order dispatch handles
        // the discriminative routing, and each lifted handler runs only for
        // its own exception type.
        let argExType = MakeDerivedExceptionType()
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let a = LocalVariableSymbol("a", false, argExType)
        let g = LocalVariableSymbol("g", false, ExceptionType)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let awaitA = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let catchBodyA = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitA))
        )
        let catchA = BoundCatchClause(argExType, a, catchBodyA)
        let awaitG = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let catchBodyG = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitG))
        )
        let catchG = BoundCatchClause(ExceptionType, g, catchBodyG)
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchA, catchG), nil)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert
        let innerBlock = Assert.IsType[BoundBlockStatement](result.Statements[0])
        let rewrittenTry = innerBlock.Statements.OfType[BoundTryStatement]().Single()
        Assert.Equal(2, rewrittenTry.CatchClauses.Length)
        Assert.Same(argExType, rewrittenTry.CatchClauses[0].ExceptionType)
        Assert.Same(ExceptionType, rewrittenTry.CatchClauses[1].ExceptionType)
    }

    @Fact
    func TryCatch_TypedCatchWithAwait_FollowedByGeneralCatch_PreservesFallthrough() {
        // Arrange: catch (a ArgumentException) { await }   <- with await
        //          catch (g Exception) { x = 2 }           <- without await; stays in place
        // The general catch must remain reachable: prior to the fix, the
        // ArgumentException clause was widened to Exception and shadowed it.
        let argExType = MakeDerivedExceptionType()
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let a = LocalVariableSymbol("a", false, argExType)
        let g = LocalVariableSymbol("g", false, ExceptionType)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let awaitA = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let catchBodyA = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitA))
        )
        let catchA = BoundCatchClause(argExType, a, catchBodyA)
        let catchBodyG = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 2)))
            )
        )
        let catchG = BoundCatchClause(ExceptionType, g, catchBodyG)
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchA, catchG), nil)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert
        let innerBlock = Assert.IsType[BoundBlockStatement](result.Statements[0])
        let rewrittenTry = innerBlock.Statements.OfType[BoundTryStatement]().Single()
        Assert.Equal(2, rewrittenTry.CatchClauses.Length)
        // First clause: typed catch with await — keeps ArgumentException type
        // and body is the capture/pending assignments (not the original body).
        Assert.Same(argExType, rewrittenTry.CatchClauses[0].ExceptionType)
        let typedBody = Assert.IsType[BoundBlockStatement](rewrittenTry.CatchClauses[0].Body)
        Assert.All(typedBody.Statements, (s BoundStatement) -> Assert.IsType[BoundExpressionStatement](s))
        // Second clause: stays in place untouched (its body is the original).
        Assert.Same(ExceptionType, rewrittenTry.CatchClauses[1].ExceptionType)
        Assert.Same(catchBodyG, rewrittenTry.CatchClauses[1].Body)
    }

    @Fact
    func TryCatch_TypedCatchWithAwait_DispatchUsesPerClauseCaptureNotPending() {
        // The post-try lifted handler must check a per-clause capture local
        // (not the shared pendingException) so that when the catch-all (or
        // another catch) sets pendingException to an unrelated exception, the
        // handler does not erroneously run.
        let argExType = MakeDerivedExceptionType()
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let e = LocalVariableSymbol("e", false, argExType)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let awaitExpr = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let catchBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitExpr))
        )
        let catchClause = BoundCatchClause(argExType, e, catchBody)
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchClause), nil)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert
        let innerBlock = Assert.IsType[BoundBlockStatement](result.Statements[0])
        // Should have a per-clause capture local declared before the try.
        let declsBeforeTry = innerBlock
            .Statements
            .TakeWhile((s BoundStatement) -> !(s is BoundTryStatement))
            .OfType[BoundVariableDeclaration]()
            .ToArray()
        Assert.Contains(
            declsBeforeTry,
            (d BoundVariableDeclaration) -> d.Variable.Name.StartsWith("<>catch_capture_", StringComparison.Ordinal)
        )
        Assert.Contains(
            declsBeforeTry,
            (d BoundVariableDeclaration) -> d.Variable.Name.StartsWith("<>pending_ex_", StringComparison.Ordinal)
        )
    }

    @Fact
    func TryCatchFinally_TypedCatchWithAwait_KeepsTypedDispatch() {
        // Pattern B (finally has await) must still keep the typed catch's
        // original exception type. The trailing catch-all (Exception) is the
        // pattern-required capture for the finally; the typed catch retains
        // its narrow type ahead of it.
        let argExType = MakeDerivedExceptionType()
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let e = LocalVariableSymbol("e", false, argExType)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let awaitA = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let catchBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitA))
        )
        let catchClause = BoundCatchClause(argExType, e, catchBody)
        let awaitF = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let finallyBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitF))
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchClause), finallyBlock)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert
        let innerBlock = Assert.IsType[BoundBlockStatement](result.Statements[0])
        let rewrittenTries = innerBlock.Statements.OfType[BoundTryStatement]().ToArray()
        Assert.Equal(2, rewrittenTries.Length)
        let rewrittenTry = rewrittenTries[0]
        Assert.Null(rewrittenTry.FinallyBlock)
        // Two clauses: typed [ArgumentException] then catch-all [Exception]
        // (the catch-all is the finally-pattern capture).
        Assert.Equal(2, rewrittenTry.CatchClauses.Length)
        Assert.Same(argExType, rewrittenTry.CatchClauses[0].ExceptionType)
        Assert.Same(ExceptionType, rewrittenTry.CatchClauses[1].ExceptionType)
        // The lifted handler is protected too, so a rethrow cannot bypass the
        // lifted finally; its exception is captured and rethrown afterward.
        Assert.Single(rewrittenTries[1].CatchClauses)
        Assert.Same(ExceptionType, rewrittenTries[1].CatchClauses[0].ExceptionType)
    }

    // ----------------------------------------------------------------------
    // Issue #418 P1-11: the auto-rethrow at the tail of a try/finally-with-await
    // rewrite must preserve the original stack trace by going through
    // ExceptionDispatchInfo.Capture(...).Throw() instead of `throw ex;`.
    // ----------------------------------------------------------------------
    @Fact
    func TryFinally_WithAwaitInFinally_RethrowsViaExceptionDispatchInfo_NotBareThrow() {
        // Arrange: try { x = 1 } finally { await ... }
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let awaitExpr = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let finallyBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitExpr))
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray[BoundCatchClause].Empty, finallyBlock)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert: the auto-rethrow at the tail must NOT be a BoundThrowStatement
        // (which would lower to `throw ex` and reset the stack trace). It must
        // call ExceptionDispatchInfo.Capture(pendingException).Throw().
        let innerBlock = Assert.IsType[BoundBlockStatement](result.Statements[0])
        let allStmts = FlattenStatements(innerBlock).ToArray()
        // No BoundThrowStatement should be present anywhere in the rewritten body —
        // the only throw-shaped operation should be the EDI Throw() instance call.
        Assert.DoesNotContain(allStmts, (s BoundStatement) -> s is BoundThrowStatement)
        // Locate the EDI Throw() call.
        let ediThrowCalls = allStmts
            .OfType[BoundExpressionStatement]()
            .Select((es BoundExpressionStatement) -> es.Expression)
            .OfType[BoundImportedInstanceCallExpression]()
            .Where(
            (ic BoundImportedInstanceCallExpression) -> ic
                .Method
                .DeclaringType == typeof(ExceptionDispatchInfo) &&
                ic
                .Method
                .Name == "Throw"
        )
            .ToArray()
        Assert.Single(ediThrowCalls)
        // The receiver must be ExceptionDispatchInfo.Capture(pendingException).
        let receiverCall = Assert.IsType[BoundImportedCallExpression](ediThrowCalls[0].Receiver)
        Assert.Equal("Capture", receiverCall.Function.Method.Name)
        Assert.Equal(typeof(ExceptionDispatchInfo), receiverCall.Function.Method.DeclaringType)
        // Capture must take a single Exception-typed argument: the pendingException local.
        let arg = Assert.Single(receiverCall.Arguments)
        let pendingRef = Assert.IsType[BoundVariableExpression](arg)
        Assert.Contains("<>pending_ex_", pendingRef.Variable.Name)
    }

    @Fact
    func TryCatchFinally_WithAwait_RethrowUsesExceptionDispatchInfo() {
        // Arrange: try { x = 1 } catch (e) { x = 2 } finally { await b }
        // The rewriter must lift the finally and emit an EDI-based rethrow at the
        // tail, NOT a bare `throw pendingException`.
        let x = LocalVariableSymbol("x", false, TypeSymbol.Int32)
        let e = LocalVariableSymbol("e", false, ExceptionType)
        let tryBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 1)))
            )
        )
        let catchBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, x, BoundLiteralExpression(nil, 2)))
            )
        )
        let catchClause = BoundCatchClause(ExceptionType, e, catchBody)
        let awaitB = BoundAwaitExpression(nil, BoundLiteralExpression(nil, 0), TypeSymbol.Int32)
        let finallyBlock = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, awaitB))
        )
        let tryStmt = BoundTryStatement(nil, tryBlock, ImmutableArray.Create(catchClause), finallyBlock)
        let body = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](tryStmt))
        // Act
        let result = AsyncExceptionHandlerRewriter.Rewrite(body)
        // Assert: no bare BoundThrowStatement in the rewritten body; EDI Throw() exists.
        let innerBlock = Assert.IsType[BoundBlockStatement](result.Statements[0])
        let allStmts = FlattenStatements(innerBlock).ToArray()
        Assert.DoesNotContain(allStmts, (s BoundStatement) -> s is BoundThrowStatement)
        Assert.Contains(
            allStmts
                .OfType[BoundExpressionStatement]()
                .Select((s BoundExpressionStatement) -> s.Expression)
                .OfType[BoundImportedInstanceCallExpression](),
            (ic BoundImportedInstanceCallExpression) -> ic
                .Method
                .DeclaringType == typeof(ExceptionDispatchInfo) &&
                ic
                .Method
                .Name == "Throw"
        )
    }

    shared {
        private let ExceptionType TypeSymbol = TypeSymbol.FromClrType(typeof(Exception))

        private func ContainsReturn(statement BoundStatement?) bool {
            switch statement {
                case BoundReturnStatement {
                    return true
                }
                case block is BoundBlockStatement {
                    return block.Statements.Any(ContainsReturn)
                }
                case tryStmt is BoundTryStatement {
                    return ContainsReturn(tryStmt.TryBlock) || tryStmt.CatchClauses.Any(
                        (c BoundCatchClause) -> ContainsReturn(c.Body)
                    ) ||
                        (tryStmt.FinallyBlock != nil && ContainsReturn(tryStmt.FinallyBlock))
                }
                default {
                    return false
                }
            }
        }

        // ----------------------------------------------------------------------
        // Issue #419: typed catch with await must keep its original exception type
        // so the CLR catch dispatch only fires for matching exceptions.
        // ----------------------------------------------------------------------
        /// A struct-class derived from (cref:System.Exception) used to stand
        /// in for a custom typed catch in the rewriter tests.
        private func MakeDerivedExceptionType() TypeSymbol {
            // ArgumentException is a real subtype of Exception in the host runtime,
            // making it a convenient typed-catch target for structural assertions.
            return TypeSymbol.FromClrType(typeof(ArgumentException))
        }

        /// Recursively yields all (cref:BoundStatement) nodes in a block,
        /// descending into nested (cref:BoundBlockStatement)s. Used so tests
        /// can assert on the absence of specific statement kinds anywhere in the
        /// rewritten body regardless of nesting introduced by the rewriter.
        private func FlattenStatements(block BoundBlockStatement) sequence[BoundStatement] {
            for stmt in block.Statements {
                yield stmt
                if stmt is BoundBlockStatement nested {
                    for inner in FlattenStatements(nested) {
                        yield inner
                    }
                }
            }
        }
    }
}
