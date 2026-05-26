// <copyright file="AnnotationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a Kotlin-style annotation lead-in (ADR-0047): an
/// <c>@</c> token optionally followed by a use-site target qualifier
/// (<c>field:</c>, <c>param:</c>, <c>return:</c>, …), a dotted attribute
/// name, and an optional argument list.
///
/// Examples:
/// <list type="bullet">
///   <item><description><c>@Serializable</c></description></item>
///   <item><description><c>@Obsolete("use Bar")</c></description></item>
///   <item><description><c>@field:NonSerialized</c></description></item>
///   <item><description><c>@System.Diagnostics.Conditional("DEBUG")</c></description></item>
/// </list>
///
/// Phase 1 / issue #141 only models the surface syntax; the binder (Phase 2)
/// will resolve the dotted name through the C#-style
/// <c>Foo</c> / <c>FooAttribute</c> lookup and the emitter (Phase 3) will
/// write the corresponding <c>CustomAttribute</c> metadata row.
/// </summary>
public sealed class AnnotationSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="AnnotationSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="atToken">The leading <c>@</c> token.</param>
    /// <param name="target">Optional use-site target qualifier (e.g. <c>field:</c>); <c>null</c> when the annotation uses the default target for its declaration position.</param>
    /// <param name="nameSegments">The dotted attribute-name path. The first segment is the leftmost identifier; dots are interleaved into <paramref name="dotTokens"/>.</param>
    /// <param name="dotTokens">The <c>.</c> tokens that separate name segments. Always <c>nameSegments.Length - 1</c> entries (possibly empty).</param>
    /// <param name="openParenthesisToken">Optional opening <c>(</c> token. Non-<c>null</c> iff an argument list was supplied.</param>
    /// <param name="arguments">The positional / named-argument list (per ADR-0047 §1). Empty when no argument list was supplied.</param>
    /// <param name="closeParenthesisToken">Optional closing <c>)</c> token. Non-<c>null</c> iff <paramref name="openParenthesisToken"/> is non-<c>null</c>.</param>
    public AnnotationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken atToken,
        AnnotationTargetSyntax target,
        ImmutableArray<SyntaxToken> nameSegments,
        ImmutableArray<SyntaxToken> dotTokens,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ExpressionSyntax> arguments,
        SyntaxToken closeParenthesisToken)
        : base(syntaxTree)
    {
        AtToken = atToken;
        Target = target;
        NameSegments = nameSegments;
        DotTokens = dotTokens;
        OpenParenthesisToken = openParenthesisToken;
        Arguments = arguments;
        CloseParenthesisToken = closeParenthesisToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.Annotation;

    /// <summary>Gets the leading <c>@</c> token.</summary>
    public SyntaxToken AtToken { get; }

    /// <summary>Gets the optional use-site target qualifier; <c>null</c> when none is supplied (annotation uses the default target).</summary>
    public AnnotationTargetSyntax Target { get; }

    /// <summary>Gets the dotted attribute-name segments (the leftmost identifier is at index 0).</summary>
    public ImmutableArray<SyntaxToken> NameSegments { get; }

    /// <summary>Gets the <c>.</c> tokens that separate <see cref="NameSegments"/>.</summary>
    public ImmutableArray<SyntaxToken> DotTokens { get; }

    /// <summary>Gets the optional opening <c>(</c> of the argument list; <c>null</c> when no parenthesised argument list was supplied.</summary>
    public SyntaxToken OpenParenthesisToken { get; }

    /// <summary>Gets the (possibly empty) annotation argument list.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> Arguments { get; }

    /// <summary>Gets the optional closing <c>)</c> of the argument list; <c>null</c> when no parenthesised argument list was supplied.</summary>
    public SyntaxToken CloseParenthesisToken { get; }

    /// <summary>Gets a value indicating whether this annotation carries a parenthesised argument list.</summary>
    public bool HasArgumentList => OpenParenthesisToken != null;

    /// <summary>Gets the dotted attribute name as a string (e.g. <c>"System.Diagnostics.Conditional"</c>).</summary>
    /// <returns>The flattened dotted name; segments are joined with <c>.</c>.</returns>
    public string GetNameText()
    {
        if (NameSegments.Length == 1)
        {
            return NameSegments[0].Text;
        }

        var sb = new System.Text.StringBuilder();
        for (var i = 0; i < NameSegments.Length; i++)
        {
            if (i > 0)
            {
                sb.Append('.');
            }

            sb.Append(NameSegments[i].Text);
        }

        return sb.ToString();
    }
}
