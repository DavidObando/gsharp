// <copyright file="ConditionalRefArgumentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0061: a call-site-only conditional lvalue expression of the form
/// <c>&lt;cond&gt; ? &lt;lvalue&gt; : &lt;lvalue&gt;</c>. Recognised by the parser only as
/// the payload of a ref-kind modifier (<c>ref</c>/<c>out</c>/<c>in</c>) or as the
/// operand of the <c>&amp;</c> address-of operator. The two branches may each
/// optionally carry an inner ref-kind modifier (<c>WhenTrueRefKindModifier</c> /
/// <c>WhenFalseRefKindModifier</c>) for parity with the C# spelling
/// <c>f(cond ? ref x : ref y)</c>; when present, they must match the outer
/// modifier (validated at bind time).
/// </summary>
public sealed class ConditionalRefArgumentExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ConditionalRefArgumentExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="condition">The condition expression (must be <c>bool</c>).</param>
    /// <param name="questionToken">The literal <c>?</c> token.</param>
    /// <param name="whenTrueRefKindModifier">Optional inner <c>ref</c>/<c>out</c>/<c>in</c> on the true branch (may be <see langword="null"/>).</param>
    /// <param name="whenTrue">The lvalue expression for the true branch.</param>
    /// <param name="colonToken">The literal <c>:</c> token.</param>
    /// <param name="whenFalseRefKindModifier">Optional inner <c>ref</c>/<c>out</c>/<c>in</c> on the false branch (may be <see langword="null"/>).</param>
    /// <param name="whenFalse">The lvalue expression for the false branch.</param>
    public ConditionalRefArgumentExpressionSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax condition,
        SyntaxToken questionToken,
        SyntaxToken whenTrueRefKindModifier,
        ExpressionSyntax whenTrue,
        SyntaxToken colonToken,
        SyntaxToken whenFalseRefKindModifier,
        ExpressionSyntax whenFalse)
        : base(syntaxTree)
    {
        Condition = condition;
        QuestionToken = questionToken;
        WhenTrueRefKindModifier = whenTrueRefKindModifier;
        WhenTrue = whenTrue;
        ColonToken = colonToken;
        WhenFalseRefKindModifier = whenFalseRefKindModifier;
        WhenFalse = whenFalse;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ConditionalRefArgumentExpression;

    /// <summary>Gets the condition expression.</summary>
    public ExpressionSyntax Condition { get; }

    /// <summary>Gets the literal <c>?</c> token.</summary>
    public SyntaxToken QuestionToken { get; }

    /// <summary>Gets the optional inner ref-kind modifier on the true branch (<see langword="null"/> when absent).</summary>
    public SyntaxToken WhenTrueRefKindModifier { get; }

    /// <summary>Gets the lvalue expression for the true branch.</summary>
    public ExpressionSyntax WhenTrue { get; }

    /// <summary>Gets the literal <c>:</c> token.</summary>
    public SyntaxToken ColonToken { get; }

    /// <summary>Gets the optional inner ref-kind modifier on the false branch (<see langword="null"/> when absent).</summary>
    public SyntaxToken WhenFalseRefKindModifier { get; }

    /// <summary>Gets the lvalue expression for the false branch.</summary>
    public ExpressionSyntax WhenFalse { get; }
}
