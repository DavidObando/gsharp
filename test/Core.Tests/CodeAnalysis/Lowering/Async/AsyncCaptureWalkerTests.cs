// <copyright file="AsyncCaptureWalkerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

public class AsyncCaptureWalkerTests
{
    [Fact]
    public void Analyze_EmptyBody_NoLocals()
    {
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);
        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Empty(result.Parameters);
        Assert.Empty(result.Locals);
    }

    [Fact]
    public void Analyze_DeclaredLocal_IsHoisted()
    {
        var local = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, local, new BoundLiteralExpression(null, 0))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
        Assert.Same(local, result.Locals[0]);
    }

    [Fact]
    public void Analyze_ReferencedLocal_IsHoisted()
    {
        var local = new LocalVariableSymbol("y", isReadOnly: false, TypeSymbol.Int32);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundVariableExpression(null, local))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
        Assert.Same(local, result.Locals[0]);
    }

    [Fact]
    public void Analyze_SameLocalReferencedTwice_AppearsOnce()
    {
        var local = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, local, new BoundLiteralExpression(null, 1)),
            new BoundExpressionStatement(null, new BoundVariableExpression(null, local)),
            new BoundExpressionStatement(null, new BoundVariableExpression(null, local))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
    }

    [Fact]
    public void Analyze_DeterministicOrder_FirstEncounterWins()
    {
        var first = new LocalVariableSymbol("first", isReadOnly: false, TypeSymbol.Int32);
        var second = new LocalVariableSymbol("second", isReadOnly: false, TypeSymbol.Int32);
        var third = new LocalVariableSymbol("third", isReadOnly: false, TypeSymbol.Int32);

        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, first, new BoundLiteralExpression(null, 1)),
            new BoundExpressionStatement(null, new BoundVariableExpression(null, second)),
            new BoundVariableDeclaration(null, third, new BoundLiteralExpression(null, 3)),
            new BoundExpressionStatement(null, new BoundVariableExpression(null, first))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Equal(new[] { "first", "second", "third" }, result.Locals.Select(l => l.Name).ToArray());
    }

    [Fact]
    public void Analyze_SpillTemp_IsExcluded()
    {
        var userLocal = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var spillTemp = new LocalVariableSymbol(GeneratedNames.SpillTempField(0), isReadOnly: false, TypeSymbol.Int32);

        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, userLocal, new BoundLiteralExpression(null, 1)),
            new BoundVariableDeclaration(null, spillTemp, new BoundLiteralExpression(null, 2))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
        Assert.Equal("x", result.Locals[0].Name);
    }

    [Fact]
    public void Analyze_Parameters_AlwaysHoistedAsProvided()
    {
        var p1 = new ParameterSymbol("a", TypeSymbol.Int32);
        var p2 = new ParameterSymbol("b", TypeSymbol.String);
        var body = new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray.Create(p1, p2));

        Assert.Equal(2, result.Parameters.Length);
        Assert.Same(p1, result.Parameters[0]);
        Assert.Same(p2, result.Parameters[1]);
    }

    [Fact]
    public void Analyze_ParameterReferencedInBody_NotDuplicatedIntoLocals()
    {
        var p1 = new ParameterSymbol("a", TypeSymbol.Int32);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, new BoundVariableExpression(null, p1))));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray.Create(p1));

        Assert.Single(result.Parameters);
        Assert.Empty(result.Locals);
    }

    // Issue #2331 (deferred half): a local/parameter whose only reference in
    // the async body is inside a nested lambda must still be discovered so it
    // gets hoisted; a lambda's own locals must never leak into the outer
    // hoist set. These tests exercise AsyncCaptureWalker.Analyze directly
    // (bypassing CaptureBoxingRewriter) so they pin down the walker's own
    // contract regardless of any other pass that might independently paper
    // over the gap.
    private static BoundFunctionLiteralExpression MakeLiteral(
        BoundBlockStatement body,
        params VariableSymbol[] capturedVariables)
    {
        var function = new FunctionSymbol("<>lambda", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Void);
        var functionType = FunctionTypeSymbol.Get(ImmutableArray<TypeSymbol>.Empty, TypeSymbol.Void);
        return new BoundFunctionLiteralExpression(
            null,
            function,
            functionType,
            body,
            ImmutableArray.Create(capturedVariables));
    }

    private static BoundBlockStatement EmptyLiteralBody()
        => new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);

    [Fact]
    public void Analyze_LocalCapturedOnlyInsideNestedLambda_IsHoisted()
    {
        // `let x = 42; await Helper(); Task.Run(() -> ... x ...)` — the walker
        // never sees a direct BoundVariableExpression(x) at the outer level;
        // it must be discovered via the lambda literal's CapturedVariables.
        var x = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var literal = MakeLiteral(EmptyLiteralBody(), x);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 42)),
            new BoundExpressionStatement(null, literal)));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
        Assert.Same(x, result.Locals[0]);
    }

    [Fact]
    public void Analyze_ParameterCapturedOnlyInsideNestedLambda_NotDuplicatedIntoLocals()
    {
        // Parameters are always hoisted unconditionally (hoist.Parameters is
        // the kickoff's own parameter list), so a parameter captured only by
        // a nested lambda must resolve through `result.Parameters`, not leak
        // a second, redundant entry into `result.Locals`.
        var p = new ParameterSymbol("value", TypeSymbol.Int32);
        var literal = MakeLiteral(EmptyLiteralBody(), p);
        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, literal)));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray.Create(p));

        Assert.Single(result.Parameters);
        Assert.Same(p, result.Parameters[0]);
        Assert.Empty(result.Locals);
    }

    [Fact]
    public void Analyze_DoublyNestedLambda_TransitiveCaptureIsHoisted_ButInnerLambdaOwnLocalIsNot()
    {
        // Mirrors the binder's own transitive-propagation guarantee (issue
        // #503): when an inner lambda nested inside an outer lambda captures
        // an outer-scope variable, the *outer* literal's own
        // CapturedVariables already lists that variable too. The outer
        // literal's body also declares its own local (`innerOnly`, standing
        // in for e.g. `let inner = () -> ...`) that is NOT part of any
        // CapturedVariables list — it must never be hoisted into the async
        // method's state machine.
        var x = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        var innerOnly = new LocalVariableSymbol("innerOnly", isReadOnly: false, TypeSymbol.Int32);

        var innerLiteral = MakeLiteral(EmptyLiteralBody(), x);
        var outerBody = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, innerOnly, new BoundLiteralExpression(null, 1)),
            new BoundExpressionStatement(null, innerLiteral)));
        var outerLiteral = MakeLiteral(outerBody, x);

        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, x, new BoundLiteralExpression(null, 7)),
            new BoundExpressionStatement(null, outerLiteral)));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
        Assert.Same(x, result.Locals[0]);
        Assert.DoesNotContain(result.Locals, l => ReferenceEquals(l, innerOnly));
    }

    [Fact]
    public void Analyze_MixedThisAndLocalCapture_OnlyLocalIsHoistedAsLocal()
    {
        // `this` (an implicit ParameterSymbol capture) and an ordinary local
        // captured together by the same lambda: the local must be hoisted,
        // and `this` (a ParameterSymbol) must not be duplicated into Locals —
        // its hoisting is handled unconditionally elsewhere (ThisField).
        var thisParam = new ParameterSymbol("this", TypeSymbol.Object);
        var local = new LocalVariableSymbol("local", isReadOnly: false, TypeSymbol.Int32);
        var literal = MakeLiteral(EmptyLiteralBody(), thisParam, local);

        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, local, new BoundLiteralExpression(null, 5)),
            new BoundExpressionStatement(null, literal)));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Single(result.Locals);
        Assert.Same(local, result.Locals[0]);
    }

    [Fact]
    public void Analyze_LambdaOwnLocal_IsNotHoisted_WhenNotCaptured()
    {
        // Control: a lambda that declares (and only uses) its own local, with
        // an empty CapturedVariables list, must never contribute that local
        // to the outer async method's hoist set — even though the walker now
        // recurses defensively into nested-lambda bodies to find
        // further-nested literals.
        var ownLocal = new LocalVariableSymbol("ownLocal", isReadOnly: false, TypeSymbol.Int32);
        var literalBody = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundVariableDeclaration(null, ownLocal, new BoundLiteralExpression(null, 3)),
            new BoundExpressionStatement(null, new BoundVariableExpression(null, ownLocal))));
        var literal = MakeLiteral(literalBody);

        var body = new BoundBlockStatement(null,
ImmutableArray.Create<BoundStatement>(
            new BoundExpressionStatement(null, literal)));

        var result = AsyncCaptureWalker.Analyze(body, ImmutableArray<ParameterSymbol>.Empty);

        Assert.Empty(result.Locals);
    }
}
