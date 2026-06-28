#nullable disable

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
    /// <param name="typeArgumentSymbols">
    /// Issue #320: when the call site supplied an explicit generic type-argument
    /// list closing an imported generic method (e.g.
    /// <c>services.AddSingleton[Clock]()</c>), the resolved type-argument
    /// <see cref="TypeSymbol"/>s in source order. Used by the emitter to encode the
    /// generic method specification so user-defined type arguments are written as
    /// their own TypeDef token. Default when there are no explicit type arguments.
    /// </param>
    public BoundImportedCallExpression(SyntaxNode syntax, ImportedFunctionSymbol function, ImmutableArray<BoundExpression> arguments, ImmutableArray<RefKind> argumentRefKinds = default, ImmutableArray<TypeSymbol> typeArgumentSymbols = default)
        : base(syntax)
    {
        Function = function;
        Arguments = arguments;
        ArgumentRefKinds = argumentRefKinds.IsDefault ? default : argumentRefKinds;
        TypeArgumentSymbols = typeArgumentSymbols.IsDefault ? default : typeArgumentSymbols;
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

    /// <summary>
    /// Gets the explicit generic type-argument symbols, in source order, when the
    /// call site supplied a <c>[T1, T2]</c> list closing an imported generic
    /// method (issue #320). Default when there are no explicit type arguments.
    /// </summary>
    public ImmutableArray<TypeSymbol> TypeArgumentSymbols { get; }
}
