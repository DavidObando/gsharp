// <copyright file="BoundLoopStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding;

using GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Bound loop statement.
/// </summary>
public abstract class BoundLoopStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundLoopStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="breakLabel">The break label.</param>
    /// <param name="continueLabel">The continue label.</param>
    protected BoundLoopStatement(SyntaxNode syntax, BoundLabel breakLabel, BoundLabel continueLabel)
        : base(syntax)
    {
        BreakLabel = breakLabel;
        ContinueLabel = continueLabel;
    }

    /// <summary>
    /// Gets the break label.
    /// </summary>
    public BoundLabel BreakLabel { get; }

    /// <summary>
    /// Gets the continue label.
    /// </summary>
    public BoundLabel ContinueLabel { get; }
}
