// <copyright file="AsyncCaptureWalkerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable
import System.Linq
import Xunit

open class AsyncCaptureWalkerTests {
    @Fact
    func Analyze_EmptyBody_NoLocals() {
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Empty(result.Parameters)
        Assert.Empty(result.Locals)
    }

    @Fact
    func Analyze_DeclaredLocal_IsHoisted() {
        let local = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundVariableDeclaration(nil, local, BoundLiteralExpression(nil, 0)))
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Single(result.Locals)
        Assert.Same(local, result.Locals[0])
    }

    @Fact
    func Analyze_ReferencedLocal_IsHoisted() {
        let local = LocalVariableSymbol("y", isReadOnly: false, TypeSymbol.Int32)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, BoundVariableExpression(nil, local)))
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Single(result.Locals)
        Assert.Same(local, result.Locals[0])
    }

    @Fact
    func Analyze_AssignmentOnlyLocal_IsHoisted() {
        let local = LocalVariableSymbol("u", isReadOnly: false, TypeSymbol.Int32)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, local, BoundLiteralExpression(nil, 42)))
            )
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Single(result.Locals)
        Assert.Same(local, result.Locals[0])
    }

    @Fact
    func Analyze_SameLocalReferencedTwice_AppearsOnce() {
        let local = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, local, BoundLiteralExpression(nil, 1)),
                BoundExpressionStatement(nil, BoundVariableExpression(nil, local)),
                BoundExpressionStatement(nil, BoundVariableExpression(nil, local))
            )
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Single(result.Locals)
    }

    @Fact
    func Analyze_DeterministicOrder_FirstEncounterWins() {
        let first = LocalVariableSymbol("first", isReadOnly: false, TypeSymbol.Int32)
        let second = LocalVariableSymbol("second", isReadOnly: false, TypeSymbol.Int32)
        let third = LocalVariableSymbol("third", isReadOnly: false, TypeSymbol.Int32)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, first, BoundLiteralExpression(nil, 1)),
                BoundExpressionStatement(nil, BoundVariableExpression(nil, second)),
                BoundVariableDeclaration(nil, third, BoundLiteralExpression(nil, 3)),
                BoundExpressionStatement(nil, BoundVariableExpression(nil, first))
            )
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Equal(
            []string{"first", "second", "third"},
            result.Locals.Select((l LocalVariableSymbol) -> l.Name).ToArray()
        )
    }

    @Fact
    func Analyze_SpillTemp_IsExcluded() {
        let userLocal = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)
        let spillTemp = LocalVariableSymbol(GeneratedNames.SpillTempField(0), isReadOnly: false, TypeSymbol.Int32)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, userLocal, BoundLiteralExpression(nil, 1)),
                BoundVariableDeclaration(nil, spillTemp, BoundLiteralExpression(nil, 2))
            )
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Single(result.Locals)
        Assert.Equal("x", result.Locals[0].Name)
    }

    @Fact
    func Analyze_Parameters_AlwaysHoistedAsProvided() {
        let p1 = ParameterSymbol("a", TypeSymbol.Int32)
        let p2 = ParameterSymbol("b", TypeSymbol.String)
        let body = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray.Create(p1, p2))
        Assert.Equal(2, result.Parameters.Length)
        Assert.Same(p1, result.Parameters[0])
        Assert.Same(p2, result.Parameters[1])
    }

    @Fact
    func Analyze_ParameterReferencedInBody_NotDuplicatedIntoLocals() {
        let p1 = ParameterSymbol("a", TypeSymbol.Int32)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, BoundVariableExpression(nil, p1)))
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray.Create(p1))
        Assert.Single(result.Parameters)
        Assert.Empty(result.Locals)
    }

    @Fact
    func Analyze_LocalCapturedOnlyInsideNestedLambda_IsHoisted() {
        // `let x = 42; await Helper(); Task.Run(() -> ... x ...)` — the walker
        // never sees a direct BoundVariableExpression(x) at the outer level;
        // it must be discovered via the lambda literal's CapturedVariables.
        let x = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)
        let literal = MakeLiteral(EmptyLiteralBody(), x)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, x, BoundLiteralExpression(nil, 42)),
                BoundExpressionStatement(nil, literal)
            )
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Single(result.Locals)
        Assert.Same(x, result.Locals[0])
    }

    @Fact
    func Analyze_ParameterCapturedOnlyInsideNestedLambda_NotDuplicatedIntoLocals() {
        // Parameters are always hoisted unconditionally (hoist.Parameters is
        // the kickoff's own parameter list), so a parameter captured only by
        // a nested lambda must resolve through `result.Parameters`, not leak
        // a second, redundant entry into `result.Locals`.
        let p = ParameterSymbol("value", TypeSymbol.Int32)
        let literal = MakeLiteral(EmptyLiteralBody(), p)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, literal))
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray.Create(p))
        Assert.Single(result.Parameters)
        Assert.Same(p, result.Parameters[0])
        Assert.Empty(result.Locals)
    }

    @Fact
    func Analyze_DoublyNestedLambda_TransitiveCaptureIsHoisted_ButInnerLambdaOwnLocalIsNot() {
        // Mirrors the binder's own transitive-propagation guarantee (issue
        // #503): when an inner lambda nested inside an outer lambda captures
        // an outer-scope variable, the *outer* literal's own
        // CapturedVariables already lists that variable too. The outer
        // literal's body also declares its own local (`innerOnly`, standing
        // in for e.g. `let inner = () -> ...`) that is NOT part of any
        // CapturedVariables list — it must never be hoisted into the async
        // method's state machine.
        let x = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)
        let innerOnly = LocalVariableSymbol("innerOnly", isReadOnly: false, TypeSymbol.Int32)
        let innerLiteral = MakeLiteral(EmptyLiteralBody(), x)
        let outerBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, innerOnly, BoundLiteralExpression(nil, 1)),
                BoundExpressionStatement(nil, innerLiteral)
            )
        )
        let outerLiteral = MakeLiteral(outerBody, x)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, x, BoundLiteralExpression(nil, 7)),
                BoundExpressionStatement(nil, outerLiteral)
            )
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Single(result.Locals)
        Assert.Same(x, result.Locals[0])
        Assert.DoesNotContain(result.Locals, (l LocalVariableSymbol) -> object.ReferenceEquals(l, innerOnly))
    }

    @Fact
    func Analyze_MixedThisAndLocalCapture_OnlyLocalIsHoistedAsLocal() {
        // `this` (an implicit ParameterSymbol capture) and an ordinary local
        // captured together by the same lambda: the local must be hoisted,
        // and `this` (a ParameterSymbol) must not be duplicated into Locals —
        // its hoisting is handled unconditionally elsewhere (ThisField).
        let thisParam = ParameterSymbol("this", TypeSymbol.Object)
        let local = LocalVariableSymbol("local", isReadOnly: false, TypeSymbol.Int32)
        let literal = MakeLiteral(EmptyLiteralBody(), thisParam, local)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, local, BoundLiteralExpression(nil, 5)),
                BoundExpressionStatement(nil, literal)
            )
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Single(result.Locals)
        Assert.Same(local, result.Locals[0])
    }

    @Fact
    func Analyze_LambdaOwnLocal_IsNotHoisted_WhenNotCaptured() {
        // Control: a lambda that declares (and only uses) its own local, with
        // an empty CapturedVariables list, must never contribute that local
        // to the outer async method's hoist set — even though the walker now
        // recurses defensively into nested-lambda bodies to find
        // further-nested literals.
        let ownLocal = LocalVariableSymbol("ownLocal", isReadOnly: false, TypeSymbol.Int32)
        let literalBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, ownLocal, BoundLiteralExpression(nil, 3)),
                BoundExpressionStatement(nil, BoundVariableExpression(nil, ownLocal))
            )
        )
        let literal = MakeLiteral(literalBody)
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, literal))
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Empty(result.Locals)
    }

    @Fact
    func Analyze_LambdaOwnParameter_IsNotHoisted_WhenNotCaptured() {
        let parameter = ParameterSymbol("u", TypeSymbol.Int32)
        let literalBody = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundVariableExpression(nil, parameter))
            )
        )
        let function = FunctionSymbol("<>lambda", ImmutableArray.Create(parameter), TypeSymbol.Void)
        let functionType = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32), TypeSymbol.Void)
        let literal = BoundFunctionLiteralExpression(
            nil,
            function,
            functionType,
            literalBody,
            ImmutableArray[VariableSymbol].Empty
        )
        let body = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, literal))
        )
        let result = AsyncCaptureWalker.Analyze(body, ImmutableArray[ParameterSymbol].Empty)
        Assert.Empty(result.Locals)
    }

    shared {
        // Issue #2331 (deferred half): a local/parameter whose only reference in
        // the async body is inside a nested lambda must still be discovered so it
        // gets hoisted; a lambda's own locals must never leak into the outer
        // hoist set. These tests exercise AsyncCaptureWalker.Analyze directly
        // (bypassing CaptureBoxingRewriter) so they pin down the walker's own
        // contract regardless of any other pass that might independently paper
        // over the gap.
        private func MakeLiteral(
            body BoundBlockStatement,
            capturedVariables ...VariableSymbol
        ) BoundFunctionLiteralExpression {
            let function = FunctionSymbol("<>lambda", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void)
            let functionType = FunctionTypeSymbol.Get(ImmutableArray[TypeSymbol].Empty, TypeSymbol.Void)
            return BoundFunctionLiteralExpression(
                nil,
                function,
                functionType,
                body,
                ImmutableArray.Create(capturedVariables)
            )
        }

        private func EmptyLiteralBody() BoundBlockStatement -> BoundBlockStatement(
            nil,
            ImmutableArray[BoundStatement].Empty
        )
    }
}
