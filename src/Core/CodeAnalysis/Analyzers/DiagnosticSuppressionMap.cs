// <copyright file="DiagnosticSuppressionMap.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// ADR-0175 (issues #3820 / #3824): the source-level, scoped analyzer
/// suppressions declared by <c>@SuppressDiagnostic("ID", …)</c> annotations in
/// a compilation's syntax trees.
///
/// A suppression's scope is the span of the syntactic construct it annotates —
/// a declaration for the attribute form, the <c>{</c>..<c>}</c> of the block
/// form. A diagnostic is suppressed when its primary location falls inside a
/// scope naming its ID; the same diagnostic reported anywhere else in the same
/// file still surfaces.
/// </summary>
public sealed class DiagnosticSuppressionMap
{
    /// <summary>An empty map that suppresses nothing.</summary>
    public static readonly DiagnosticSuppressionMap Empty =
        new DiagnosticSuppressionMap(ImmutableArray<Scope>.Empty);

    private readonly ImmutableArray<Scope> scopes;

    private DiagnosticSuppressionMap(ImmutableArray<Scope> scopes)
    {
        this.scopes = scopes;
    }

    /// <summary>
    /// Builds the suppression map for <paramref name="syntaxTrees"/>.
    /// </summary>
    /// <param name="syntaxTrees">The trees to scan.</param>
    /// <returns>The map; <see cref="Empty"/> when no suppression is declared.</returns>
    public static DiagnosticSuppressionMap Build(IEnumerable<SyntaxTree> syntaxTrees)
    {
        var builder = ImmutableArray.CreateBuilder<Scope>();
        foreach (var tree in syntaxTrees)
        {
            Collect(tree.Root, tree.Text, builder);
        }

        return builder.Count == 0 ? Empty : new DiagnosticSuppressionMap(builder.ToImmutable());
    }

    /// <summary>
    /// Gets a value indicating whether <paramref name="diagnostic"/> is
    /// suppressed by a source annotation.
    /// </summary>
    /// <param name="diagnostic">The diagnostic to test.</param>
    /// <returns><see langword="true"/> when a scope covering the diagnostic names its ID.</returns>
    public bool IsSuppressed(Diagnostic diagnostic)
    {
        if (this.scopes.IsDefaultOrEmpty)
        {
            return false;
        }

        // `TextLocation.Text` is genuinely nullable — the driver reports its own
        // GS9304 with a `default` location — and a null one matches no scope.
        var location = diagnostic.Location;
        if (location.Text is null)
        {
            return false;
        }

        foreach (var scope in this.scopes)
        {
            if (!ReferenceEquals(scope.Text, location.Text))
            {
                continue;
            }

            if (location.Span.Start < scope.Span.Start || location.Span.Start >= scope.Span.End)
            {
                continue;
            }

            foreach (var id in scope.Ids)
            {
                if (string.Equals(id, diagnostic.Id, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Gets a value indicating whether <paramref name="annotation"/> is the
    /// compiler-intrinsic <c>@SuppressDiagnostic</c> annotation (ADR-0175).
    /// Recognition is by source spelling: the annotation has no CLR type, is
    /// never bound, and is never written to metadata, so a compilation needs no
    /// extra assembly reference to use it.
    /// </summary>
    /// <param name="annotation">The annotation to test.</param>
    /// <returns><see langword="true"/> when the name is <c>SuppressDiagnostic</c> or <c>SuppressDiagnosticAttribute</c>.</returns>
    public static bool IsSuppressDiagnostic(AnnotationSyntax annotation)
    {
        if (annotation.HasTypeArgumentList)
        {
            return false;
        }

        var name = annotation.GetNameText();
        return string.Equals(name, "SuppressDiagnostic", StringComparison.Ordinal)
            || string.Equals(name, "SuppressDiagnosticAttribute", StringComparison.Ordinal);
    }

    /// <summary>
    /// Extracts the diagnostic IDs named by a <c>@SuppressDiagnostic</c>
    /// annotation. Every positional argument must be a string literal; an
    /// argument that is not contributes no ID (the binder reports GS9305).
    /// </summary>
    /// <param name="annotation">The annotation to read.</param>
    /// <returns>The IDs, in source order.</returns>
    public static ImmutableArray<string> GetSuppressedIds(AnnotationSyntax annotation)
    {
        // `Arguments` is a nullable reference on the syntax node: an annotation
        // written without a parenthesised list (`@SuppressDiagnostic`) has none.
        if (annotation.Arguments is null || annotation.Arguments.Count == 0)
        {
            return ImmutableArray<string>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<string>();
        foreach (var argument in annotation.Arguments)
        {
            if (argument is LiteralExpressionSyntax { Value: string text } && IsWellFormedId(text))
            {
                builder.Add(text);
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Gets a value indicating whether <paramref name="text"/> has the shape of
    /// a diagnostic ID: at least one ASCII letter followed by at least one
    /// digit (<c>GS0157</c>, <c>GSA0005</c>, <c>PROBE001</c>).
    /// </summary>
    /// <param name="text">The candidate ID.</param>
    /// <returns><see langword="true"/> when the shape matches.</returns>
    public static bool IsWellFormedId(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return false;
        }

        var i = 0;
        while (i < text.Length && char.IsAsciiLetter(text[i]))
        {
            i++;
        }

        if (i == 0 || i == text.Length)
        {
            return false;
        }

        for (var j = i; j < text.Length; j++)
        {
            if (!char.IsAsciiDigit(text[j]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Returns the annotations attached to <paramref name="node"/>, or an empty
    /// array when the node kind carries none. Annotation lists are declared on
    /// unrelated node types rather than a shared base, so this dispatch is the
    /// single place that knows all of them.
    /// </summary>
    /// <param name="node">The node to inspect.</param>
    /// <returns>The node's annotations.</returns>
    internal static ImmutableArray<AnnotationSyntax> GetAnnotations(SyntaxNode node) => node switch
    {
        MemberSyntax m => m.Annotations,
        BlockStatementSyntax b => b.Annotations,
        VariableDeclarationSyntax v => v.Annotations,
        FieldDeclarationSyntax f => f.Annotations,
        PropertyDeclarationSyntax p => p.Annotations,
        EventDeclarationSyntax e => e.Annotations,
        EnumMemberSyntax en => en.Annotations,
        ParameterSyntax pa => pa.Annotations,
        _ => ImmutableArray<AnnotationSyntax>.Empty,
    };

    private static void Collect(SyntaxNode node, SourceText text, ImmutableArray<Scope>.Builder builder)
    {
        var annotations = GetAnnotations(node);
        if (!annotations.IsDefaultOrEmpty)
        {
            var ids = ImmutableArray.CreateBuilder<string>();
            foreach (var annotation in annotations)
            {
                if (IsSuppressDiagnostic(annotation))
                {
                    ids.AddRange(GetSuppressedIds(annotation));
                }
            }

            if (ids.Count > 0)
            {
                builder.Add(new Scope(text, node.Span, ids.ToImmutable()));
            }
        }

        foreach (var child in node.GetChildren())
        {
            Collect(child, text, builder);
        }
    }

    private readonly struct Scope
    {
        internal Scope(SourceText text, TextSpan span, ImmutableArray<string> ids)
        {
            Text = text;
            Span = span;
            Ids = ids;
        }

        internal SourceText Text { get; }

        internal TextSpan Span { get; }

        internal ImmutableArray<string> Ids { get; }
    }
}
