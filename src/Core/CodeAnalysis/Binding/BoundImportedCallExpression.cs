// <copyright file="BoundImportedCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound call expression.
/// </summary>
public sealed class BoundImportedCallExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundImportedCallExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="function">The function symbol.</param>
    /// <param name="arguments">The provided arguments.</param>
    /// <param name="argumentRefKinds">Per-argument ref-kind annotations (default all-None).</param>
    public BoundImportedCallExpression(SyntaxNode syntax, ImportedFunctionSymbol function, ImmutableArray<BoundExpression> arguments, ImmutableArray<RefKind> argumentRefKinds = default)
        : base(syntax)
    {
        Function = function;
        Arguments = arguments;
        ArgumentRefKinds = argumentRefKinds.IsDefault ? default : argumentRefKinds;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ImportedCallExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => Function.Type;

    /// <summary>
    /// Gets the imported function symbol.
    /// </summary>
    public ImportedFunctionSymbol Function { get; }

    /// <summary>
    /// Gets the provided arguments.
    /// </summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>
    /// Gets the per-argument ref-kind annotations. May be default (all-None).
    /// </summary>
    public ImmutableArray<RefKind> ArgumentRefKinds { get; }
}
