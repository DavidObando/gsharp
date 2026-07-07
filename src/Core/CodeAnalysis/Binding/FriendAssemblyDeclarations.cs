// <copyright file="FriendAssemblyDeclarations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Diagnostics;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Reads the producer-side friend-assembly opt-in surface: file-level
/// <c>@assembly:InternalsVisibleTo("OtherAssemblyName")</c> annotations
/// (<see cref="CompilationUnitSyntax.AssemblyAttributes"/>) and turns them
/// into the literal friend-assembly name list the emitter writes as real
/// <see cref="System.Runtime.CompilerServices.InternalsVisibleToAttribute"/>
/// custom attribute rows (issue #1929/#1953: replaces the removed
/// consumer-driven <c>.Tests</c>-suffix heuristic with genuine, producer-
/// declared friendship).
///
/// This intentionally does not go through the general <c>@Attribute</c>
/// binder (<c>DeclarationBinder.BindAttributes</c>): friend-assembly names
/// must be known as plain strings very early (before internal-visibility
/// checks against previously-compiled references), so a syntactic,
/// string-literal-only read is sufficient and keeps that specific opt-in
/// resolvable without a full expression bind.
///
/// Issue #2237: every OTHER <c>@assembly:</c> annotation (i.e. anything that
/// isn't <c>InternalsVisibleTo</c>) is bound through the general attribute
/// binder instead — see <see cref="CollectOtherAnnotations"/> and
/// <c>Binder.BindGlobalScope</c>'s <c>AssemblyAttributes</c> handling — so
/// arbitrary C#-parity assembly attributes (<c>AssemblyVersionAttribute</c>,
/// <c>AssemblyMetadataAttribute</c>, a same-compilation user attribute, ...)
/// become real assembly-level <c>CustomAttribute</c> rows.
/// </summary>
internal static class FriendAssemblyDeclarations
{
    private const string AnnotationName = "InternalsVisibleTo";
    private const string AnnotationNameWithSuffix = "InternalsVisibleToAttribute";

    /// <summary>
    /// Collects every file-level <c>@assembly:</c> annotation across
    /// <paramref name="syntaxTrees"/> EXCEPT <c>InternalsVisibleTo</c> (which
    /// <see cref="Collect"/> already handles via its own syntactic,
    /// string-literal-only fast path). Used by <c>Binder.BindGlobalScope</c>
    /// to feed the remaining annotations through the general attribute
    /// binder (issue #2237).
    /// </summary>
    /// <param name="syntaxTrees">The syntax trees making up the compilation.</param>
    /// <returns>The non-<c>InternalsVisibleTo</c> assembly-level annotations, in source order.</returns>
    public static ImmutableArray<AnnotationSyntax> CollectOtherAnnotations(ImmutableArray<SyntaxTree> syntaxTrees)
    {
        if (syntaxTrees.IsDefaultOrEmpty)
        {
            return ImmutableArray<AnnotationSyntax>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<AnnotationSyntax>();
        foreach (var tree in syntaxTrees)
        {
            var annotations = tree.Root?.AssemblyAttributes ?? ImmutableArray<AnnotationSyntax>.Empty;
            foreach (var annotation in annotations)
            {
                var name = annotation.GetNameText();
                if (string.Equals(name, AnnotationName, StringComparison.Ordinal)
                    || string.Equals(name, AnnotationNameWithSuffix, StringComparison.Ordinal))
                {
                    continue;
                }

                builder.Add(annotation);
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Collects the distinct friend-assembly names declared via
    /// <c>@assembly:InternalsVisibleTo("...")</c> across all of the given
    /// syntax trees, reporting diagnostics for malformed declarations.
    /// </summary>
    /// <param name="syntaxTrees">The syntax trees making up the compilation.</param>
    /// <param name="diagnostics">The bag to report malformed declarations to.</param>
    /// <returns>The distinct, ordinal-compared set of declared friend-assembly names.</returns>
    public static ImmutableArray<string> Collect(ImmutableArray<SyntaxTree> syntaxTrees, DiagnosticBag diagnostics)
    {
        if (syntaxTrees.IsDefaultOrEmpty)
        {
            return ImmutableArray<string>.Empty;
        }

        var friends = ImmutableArray.CreateBuilder<string>();
        var seen = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal);

        foreach (var tree in syntaxTrees)
        {
            var annotations = tree.Root?.AssemblyAttributes ?? ImmutableArray<AnnotationSyntax>.Empty;
            foreach (var annotation in annotations)
            {
                var name = annotation.GetNameText();
                if (!string.Equals(name, AnnotationName, StringComparison.Ordinal)
                    && !string.Equals(name, AnnotationNameWithSuffix, StringComparison.Ordinal))
                {
                    // Issue #2237: no longer unsupported — every other
                    // `@assembly:` annotation is bound generically by
                    // `Binder.BindGlobalScope` via `CollectOtherAnnotations`.
                    continue;
                }

                if (annotation.Arguments.Count != 1
                    || annotation.Arguments[0] is not LiteralExpressionSyntax literal
                    || literal.Value is not string friendName
                    || string.IsNullOrWhiteSpace(friendName))
                {
                    var argLocation = annotation.Arguments.Count > 0
                        ? annotation.Arguments[0].Location
                        : GetNameLocation(annotation);
                    diagnostics?.ReportAssemblyAnnotationArgumentNotStringLiteral(argLocation);
                    continue;
                }

                if (seen.Add(friendName))
                {
                    friends.Add(friendName);
                }
            }
        }

        return friends.ToImmutable();
    }

    private static Text.TextLocation GetNameLocation(AnnotationSyntax annotation)
    {
        if (!annotation.NameSegments.IsDefaultOrEmpty)
        {
            var first = annotation.NameSegments[0];
            var last = annotation.NameSegments[annotation.NameSegments.Length - 1];
            var span = Text.TextSpan.FromBounds(first.Span.Start, last.Span.End);
            return new Text.TextLocation(annotation.SyntaxTree.Text, span);
        }

        return annotation.Location;
    }
}
