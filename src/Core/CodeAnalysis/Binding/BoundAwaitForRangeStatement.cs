#nullable disable

// <copyright file="BoundAwaitForRangeStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Phase 5.8 / ADR-0023: bound form of
/// <c>await for v := range stream { ... }</c>. The stream operand is
/// an <c>IAsyncEnumerable[T]</c>; the value variable is typed as
/// <c>T</c>. The interpreter realizes the loop by reflection on
/// <c>GetAsyncEnumerator</c>/<c>MoveNextAsync</c>/<c>Current</c>/
/// <c>DisposeAsync</c>, blocking on each underlying <c>ValueTask</c>
/// via <c>GetAwaiter().GetResult()</c> (the same synchronous-await
/// idiom Phase 5.1 uses for plain <c>await</c>). The async-aware
/// lowering and emit are deferred.
/// </summary>
public sealed class BoundAwaitForRangeStatement : BoundLoopStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundAwaitForRangeStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="valueVariable">The element variable.</param>
    /// <param name="stream">The async-stream expression.</param>
    /// <param name="body">The loop body.</param>
    /// <param name="breakLabel">The break label targeted by <c>break</c> inside the loop body.</param>
    /// <param name="continueLabel">The continue label targeted by <c>continue</c> inside the loop body.</param>
    public BoundAwaitForRangeStatement(
        SyntaxNode syntax,
        VariableSymbol valueVariable,
        BoundExpression stream,
        BoundStatement body,
        BoundLabel breakLabel,
        BoundLabel continueLabel)
        : base(syntax, breakLabel, continueLabel)
    {
        ValueVariable = valueVariable;
        Stream = stream;
        Body = body;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.AwaitForRangeStatement;

    /// <summary>Gets the element variable, typed as the stream's element type.</summary>
    public VariableSymbol ValueVariable { get; }

    /// <summary>Gets the async-stream expression.</summary>
    public BoundExpression Stream { get; }

    /// <summary>Gets the loop body.</summary>
    public BoundStatement Body { get; }
}
