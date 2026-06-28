#nullable disable

// <copyright file="MemberFieldAssignmentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a chained member-access assignment whose receiver is an arbitrary
/// expression rather than a bare identifier, e.g. <c>a.B.C = value</c> or
/// <c>GetObj().Field = value</c>. Issue #648: this complements
/// <see cref="FieldAssignmentExpressionSyntax"/> (which is restricted to a
/// single identifier on the left of the dot) by allowing the assigned target
/// to be reached through any expression that produces a value with a settable
/// member.
/// </summary>
public sealed class MemberFieldAssignmentExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="MemberFieldAssignmentExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="receiver">The expression producing the receiver (everything before the last dot).</param>
    /// <param name="dotToken">The dot token preceding the assigned field/property.</param>
    /// <param name="fieldIdentifier">The field or property name being assigned.</param>
    /// <param name="equalsToken">The equals token.</param>
    /// <param name="value">The value expression on the right of the equals sign.</param>
    public MemberFieldAssignmentExpressionSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax receiver,
        SyntaxToken dotToken,
        SyntaxToken fieldIdentifier,
        SyntaxToken equalsToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        Receiver = receiver;
        DotToken = dotToken;
        FieldIdentifier = fieldIdentifier;
        EqualsToken = equalsToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.MemberFieldAssignmentExpression;

    /// <summary>Gets the receiver expression (the chain before the last dot).</summary>
    public ExpressionSyntax Receiver { get; }

    /// <summary>Gets the dot token.</summary>
    public SyntaxToken DotToken { get; }

    /// <summary>Gets the field/property identifier being assigned.</summary>
    public SyntaxToken FieldIdentifier { get; }

    /// <summary>Gets the equals token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the value expression on the right of the equals sign.</summary>
    public ExpressionSyntax Value { get; }
}
