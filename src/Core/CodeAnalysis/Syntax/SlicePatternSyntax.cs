// <copyright file="SlicePatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a slice ("rest") subpattern inside a list pattern, e.g. the
/// <c>..</c> in <c>[1, .., 3]</c>, an optional named capture <c>..rest</c>
/// binding the middle slice, or an optional sub-pattern <c>..[&gt; 0]</c>
/// matched against the middle slice.
/// </summary>
public sealed class SlicePatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="SlicePatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="dotDotToken">The <c>..</c> token.</param>
    /// <param name="captureIdentifier">The optional capture identifier (e.g. <c>rest</c> in <c>..rest</c>), or <c>null</c>.</param>
    /// <param name="pattern">The optional sub-pattern matched against the middle slice, or <c>null</c>.</param>
    public SlicePatternSyntax(SyntaxTree syntaxTree, SyntaxToken dotDotToken, SyntaxToken captureIdentifier, PatternSyntax pattern)
        : base(syntaxTree)
    {
        DotDotToken = dotDotToken;
        CaptureIdentifier = captureIdentifier;
        Pattern = pattern;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SlicePattern;

    /// <summary>Gets the <c>..</c> token.</summary>
    public SyntaxToken DotDotToken { get; }

    /// <summary>Gets the optional capture identifier, or <c>null</c> for a discard slice.</summary>
    public SyntaxToken CaptureIdentifier { get; }

    /// <summary>Gets the optional sub-pattern matched against the middle slice, or <c>null</c>.</summary>
    public PatternSyntax Pattern { get; }
}
