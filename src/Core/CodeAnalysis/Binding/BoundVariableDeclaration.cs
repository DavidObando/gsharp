// <copyright file="BoundVariableDeclaration.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound variable declaration.
/// </summary>
public sealed class BoundVariableDeclaration : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundVariableDeclaration"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="variable">The variable symbol.</param>
    /// <param name="initializer">The bound expression.</param>
    /// <param name="constantValue">
    /// The compile-time constant value when this is a <c>const</c> declaration
    /// whose initializer folds to a literal; <see langword="null"/> otherwise.
    /// When non-null the emitter will not allocate an IL slot for the variable
    /// and will instead inline the value at every read site, emitting a
    /// <c>LocalConstant</c> row in the Portable PDB.
    /// </param>
    public BoundVariableDeclaration(SyntaxNode syntax, VariableSymbol variable, BoundExpression initializer, object constantValue = null)
        : base(syntax)
    {
        Variable = variable;
        Initializer = initializer;
        ConstantValue = constantValue;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.VariableDeclaration;

    /// <summary>
    /// Gets the variable symbol.
    /// </summary>
    public VariableSymbol Variable { get; }

    /// <summary>
    /// Gets the bound expression.
    /// </summary>
    public BoundExpression Initializer { get; }

    /// <summary>
    /// Gets the compile-time constant value for this declaration, or
    /// <see langword="null"/> when the declaration is not a compile-time
    /// constant (i.e. it was declared with <c>var</c> or <c>let</c>, or the
    /// <c>const</c> initializer is not a literal expression). When non-null,
    /// no IL local slot is allocated and the value is inlined at every read
    /// site, with a <c>LocalConstant</c> row emitted in the Portable PDB.
    /// </summary>
    public object ConstantValue { get; }
}
