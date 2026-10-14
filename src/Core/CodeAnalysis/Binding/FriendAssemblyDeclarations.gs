// <copyright file="FriendAssemblyDeclarations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Diagnostics
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Reads the producer-side friend-assembly opt-in surface: file-level
/// `@assembly:InternalsVisibleTo("OtherAssemblyName")` annotations
/// ((cref:CompilationUnitSyntax.AssemblyAttributes)) and turns them
/// into the literal friend-assembly name list the emitter writes as real
/// (cref:System.Runtime.CompilerServices.InternalsVisibleToAttribute)
/// custom attribute rows (issue #1929/#1953: replaces the removed
/// consumer-driven `.Tests`-suffix heuristic with genuine, producer-
/// declared friendship).
///
/// This intentionally does not go through the general `@Attribute`
/// binder (`DeclarationBinder.BindAttributes`): friend-assembly names
/// must be known as plain strings very early (before internal-visibility
/// checks against previously-compiled references), so a syntactic,
/// string-literal-only read is sufficient and keeps that specific opt-in
/// resolvable without a full expression bind.
///
/// Issue #2237: every OTHER `@assembly:` annotation (i.e. anything that
/// isn't `InternalsVisibleTo`) is bound through the general attribute
/// binder instead — see (cref:CollectOtherAnnotations) and
/// `Binder.BindGlobalScope`'s `AssemblyAttributes` handling — so
/// arbitrary C#-parity assembly attributes (`AssemblyVersionAttribute`,
/// `AssemblyMetadataAttribute`, a same-compilation user attribute, ...)
/// become real assembly-level `CustomAttribute` rows.
internal shared class FriendAssemblyDeclarations {
    private const AnnotationName string = "InternalsVisibleTo"
    private const AnnotationNameWithSuffix string = "InternalsVisibleToAttribute"

    /// Collects every file-level `@assembly:` or `@module:` annotation across
    /// [`syntaxTrees`](paramref) EXCEPT `InternalsVisibleTo` (which
    /// (cref:Collect) already handles via its own syntactic,
    /// string-literal-only fast path). Used by `Binder.BindGlobalScope`
    /// to feed the remaining annotations through the general attribute
    /// binder (issue #2237).
    /// @param syntaxTrees The syntax trees making up the compilation.
    /// @returns The non-`InternalsVisibleTo` assembly-level annotations, in source order.
    func CollectOtherAnnotations(syntaxTrees ImmutableArray[SyntaxTree]) ImmutableArray[AnnotationSyntax] {
        if syntaxTrees.IsDefaultOrEmpty {
            return ImmutableArray[AnnotationSyntax].Empty
        }
        let builder = ImmutableArray.CreateBuilder[AnnotationSyntax]()
        for tree in syntaxTrees {
            let annotations = tree.Root?.FileAttributes ?? ImmutableArray[AnnotationSyntax].Empty
            for annotation in annotations {
                let name = annotation.GetNameText()
                if annotation
                    .Target
                    ?.KindIdentifier
                    .ValueText == "assembly" &&
                    (
                    string.Equals(name, AnnotationName, StringComparison.Ordinal) || string.Equals(
                        name,
                        AnnotationNameWithSuffix,
                        StringComparison.Ordinal
                    )
                ) {
                    continue
                }
                builder.Add(annotation)
            }
        }
        return builder.ToImmutable()
    }

    /// Collects the distinct friend-assembly names declared via
    /// `@assembly:InternalsVisibleTo("...")` across all of the given
    /// syntax trees, reporting diagnostics for malformed declarations.
    /// @param syntaxTrees The syntax trees making up the compilation.
    /// @param diagnostics The bag to report malformed declarations to.
    /// @returns The distinct, ordinal-compared set of declared friend-assembly names.
    func Collect(syntaxTrees ImmutableArray[SyntaxTree], diagnostics DiagnosticBag) ImmutableArray[string] {
        if syntaxTrees.IsDefaultOrEmpty {
            return ImmutableArray[string].Empty
        }
        let friends = ImmutableArray.CreateBuilder[string]()
        let seen = HashSet[string](StringComparer.Ordinal)
        for tree in syntaxTrees {
            let annotations = tree.Root?.AssemblyAttributes ?? ImmutableArray[AnnotationSyntax].Empty
            for annotation in annotations {
                let name = annotation.GetNameText()
                if !string.Equals(name, AnnotationName, StringComparison.Ordinal) && !string.Equals(
                    name,
                    AnnotationNameWithSuffix,
                    StringComparison.Ordinal
                ) {
                    // Issue #2237: no longer unsupported — every other
                    // `@assembly:` annotation is bound generically by
                    // `Binder.BindGlobalScope` via `CollectOtherAnnotations`.
                    continue
                }
                if annotation
                    .Arguments
                    .Count != 1 ||
                    annotation.Arguments[0] is not LiteralExpressionSyntax literal ||
                    literal.Value is not string friendName ||
                    string
                    .IsNullOrWhiteSpace(friendName) {
                    let argLocation = if annotation.Arguments.Count > 0 {
                        annotation.Arguments[0].Location
                    } else {
                        GetNameLocation(annotation)
                    }
                    diagnostics?.ReportAssemblyAnnotationArgumentNotStringLiteral(argLocation)
                    continue
                }
                if seen.Add(friendName) {
                    friends.Add(friendName)
                }
            }
        }
        return friends.ToImmutable()
    }

    private func GetNameLocation(annotation AnnotationSyntax) TextLocation {
        if !annotation.NameSegments.IsDefaultOrEmpty {
            let first = annotation.NameSegments[0]
            let last = annotation.NameSegments[annotation.NameSegments.Length - 1]
            let span = TextSpan.FromBounds(first.Span.Start, last.Span.End)
            return TextLocation(annotation.SyntaxTree.Text, span)
        }
        return annotation.Location
    }
}
