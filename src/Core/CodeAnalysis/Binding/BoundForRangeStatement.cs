// <copyright file="BoundForRangeStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Iteration strategies the evaluator picks per collection kind.
/// </summary>
public enum ForRangeKind
{
    /// <summary>Iterates an array or slice by integer index.</summary>
    Indexed,

    /// <summary>Iterates a CLR <c>IDictionary</c> producing key/value pairs.</summary>
    Dictionary,

    /// <summary>Iterates a CLR <c>IEnumerable</c> (no index — the key variable, if any, is a running counter).</summary>
    Enumerable,

    /// <summary>Iterates a pattern-based <c>GetEnumerator()</c> enumerable.</summary>
    PatternEnumerator,
}

/// <summary>
/// Bound for-range statement (Phase 4 exit). Forms:
/// <c>for v := range coll { ... }</c> (no key) and
/// <c>for k, v := range coll { ... }</c>. For arrays/slices the key is
/// the int index; for CLR dictionaries the key is the dictionary key.
/// </summary>
public sealed class BoundForRangeStatement : BoundLoopStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundForRangeStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="keyVariable">The key variable (may be null when no key was declared).</param>
    /// <param name="valueVariable">The value variable.</param>
    /// <param name="collection">The collection expression.</param>
    /// <param name="kind">The iteration strategy.</param>
    /// <param name="body">The loop body.</param>
    /// <param name="breakLabel">The break label.</param>
    /// <param name="continueLabel">The continue label.</param>
    public BoundForRangeStatement(
        SyntaxNode syntax,
        VariableSymbol keyVariable,
        VariableSymbol valueVariable,
        BoundExpression collection,
        ForRangeKind kind,
        BoundStatement body,
        BoundLabel breakLabel,
        BoundLabel continueLabel)
        : base(syntax, breakLabel, continueLabel)
    {
        KeyVariable = keyVariable;
        ValueVariable = valueVariable;
        Collection = collection;
        IterationKind = kind;
        Body = body;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ForRangeStatement;

    /// <summary>Gets the key variable (or null when only a value was declared).</summary>
    public VariableSymbol KeyVariable { get; }

    /// <summary>Gets the value variable.</summary>
    public VariableSymbol ValueVariable { get; }

    /// <summary>Gets the collection expression.</summary>
    public BoundExpression Collection { get; }

    /// <summary>Gets the iteration strategy.</summary>
    public ForRangeKind IterationKind { get; }

    /// <summary>Gets the loop body.</summary>
    public BoundStatement Body { get; }
}
