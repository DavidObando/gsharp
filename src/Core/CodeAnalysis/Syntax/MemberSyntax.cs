// <copyright file="MemberSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an abstract member in the language.
/// </summary>
public abstract class MemberSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="MemberSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    protected MemberSyntax(SyntaxTree syntaxTree)
        : base(syntaxTree)
    {
        Annotations = ImmutableArray<AnnotationSyntax>.Empty;
    }

    /// <summary>
    /// Gets the Kotlin-style annotations (ADR-0047) attached to this member
    /// declaration. Empty when the member has no <c>@</c> lead-ins.
    /// </summary>
    /// <remarks>
    /// Annotations are populated by the parser via <see cref="WithAnnotations"/>
    /// immediately after the concrete member node is constructed, so that
    /// existing constructor overloads on derived members do not need to be
    /// touched. <see cref="SyntaxNode.GetChildren"/> finds the slot
    /// through reflection on the public <c>IEnumerable&lt;SyntaxNode&gt;</c>
    /// property.
    /// </remarks>
    public ImmutableArray<AnnotationSyntax> Annotations { get; private set; }

    /// <summary>Attaches the given annotation list to this member and returns the same instance for fluent use by the parser.</summary>
    /// <param name="annotations">The annotation list to attach (may be empty).</param>
    /// <returns>This same <see cref="MemberSyntax"/>, with <see cref="Annotations"/> updated.</returns>
    internal MemberSyntax WithAnnotations(ImmutableArray<AnnotationSyntax> annotations)
    {
        Annotations = annotations.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : annotations;
        return this;
    }
}
