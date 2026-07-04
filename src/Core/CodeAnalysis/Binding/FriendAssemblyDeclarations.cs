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
/// binder (<c>DeclarationBinder.BindAttributes</c>): assembly attributes are
/// resolved before any type is bound, and the only shape gsc supports today
/// is a single string-literal argument, so a syntactic read is sufficient
/// and avoids a much larger "arbitrary assembly-level custom attribute"
/// binding/emit feature that nothing here needs yet.
/// </summary>
internal static class FriendAssemblyDeclarations
{
    private const string AnnotationName = "InternalsVisibleTo";
    private const string AnnotationNameWithSuffix = "InternalsVisibleToAttribute";

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
                    diagnostics?.ReportUnsupportedAssemblyAnnotation(GetNameLocation(annotation), name);
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
