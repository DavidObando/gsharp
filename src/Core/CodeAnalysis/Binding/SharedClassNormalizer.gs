// <copyright file="SharedClassNormalizer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// ADR-0195 / issue #4674: hands the binder a `shared class` in the one shape
/// it already binds. The author writes the members directly in the class body
/// (`shared class Helpers { func Twice(x int32) int32 { … } }`) and every one of
/// them is shared; the binder has a single path for a type's shared members, which
/// reads them from the type's (cref:StructDeclarationSyntax.SharedBlock). So
/// this pass returns a copy of such a declaration whose body members sit in a shared
/// block (built from the class's own `shared` modifier and braces) and whose
/// instance member lists are empty. It never mutates its input: the parsed tree is
/// reused across compilations and read by the language server, formatter and
/// analyzers, which all see the source as written.
///
/// It also rejects what a shared class cannot hold: an `init(…)` constructor, a
/// primary constructor, a `deinit`, a `shared { }` block of its own
/// (`GS0617`) and a base class or interface (`GS0619`).
internal shared class SharedClassNormalizer {
    /// Returns [`declaration`](paramref) with every `shared class` in it (itself
    /// and its nested types) in the binder's shape, or the same instance when there is none.
    /// @param declaration The (possibly already partial-merged) class/struct declaration.
    /// @param diagnostics The bag that receives GS0617 and GS0619.
    /// @returns The normalized declaration.
    func Normalize(declaration StructDeclarationSyntax, diagnostics DiagnosticBag) StructDeclarationSyntax {
        let nestedTypes = NormalizeNestedTypes(declaration.NestedTypes, diagnostics)
        if !declaration.IsClass || declaration.SharedModifier is not{} sharedModifier {
            return if nestedTypes.Equals(declaration.NestedTypes) {
                declaration
            } else {
                declaration.WithMemberLists(declaration.Methods, declaration.SharedBlock, nestedTypes)
            }
        }
        Validate(declaration, diagnostics)
        // A `shared { }` block inside the class is diagnosed above; its members are still
        // folded in so they bind (and do not cascade into "member not found" errors).
        let explicitBlock = declaration.SharedBlock
        let sharedBlock = SharedBlockSyntax(
            declaration.SyntaxTree,
            sharedModifier,
            declaration.OpenBraceToken,
            Concat(declaration.Fields, explicitBlock?.Fields),
            Concat(declaration.Properties, explicitBlock?.Properties),
            Concat(declaration.Events, explicitBlock?.Events),
            Concat(declaration.Methods, explicitBlock?.Methods),
            Concat(declaration.SharedInitializers, explicitBlock?.InitBlocks),
            declaration.CloseBraceToken
        )
        return declaration.WithMembersInSharedBlock(sharedBlock, nestedTypes)
    }

    private func Validate(declaration StructDeclarationSyntax, diagnostics DiagnosticBag) {
        let className = declaration.Identifier.Text
        if declaration.HasBaseType {
            diagnostics.ReportSharedClassCannotHaveBaseTypes(
                declaration.BaseColonToken?.Location ?? declaration.Identifier.Location,
                className
            )
        }
        if declaration.PrimaryConstructorOpenParenthesisToken is {} primaryConstructor {
            diagnostics.ReportSharedClassCannotDeclare(primaryConstructor.Location, className, "a primary constructor")
        }
        for constructor in declaration.Constructors {
            diagnostics.ReportSharedClassCannotDeclare(
                constructor.InitKeyword.Location,
                className,
                "an 'init' constructor"
            )
        }
        if declaration.Deinitializer is {} deinitializer {
            diagnostics.ReportSharedClassCannotDeclare(deinitializer.DeinitKeyword.Location, className, "a 'deinit'")
        }
        if declaration.SharedBlock is {} explicitBlock {
            diagnostics.ReportSharedClassCannotDeclare(
                explicitBlock.SharedKeyword.Location,
                className,
                "a 'shared { }' block"
            )
        }
        // The body parser accepts `open` and `override` on a method, property or event, and
        // the shared-member binders would silently drop them (a shared member is static
        // and never virtual), unlike the same member in a `shared { }` block. Reject them.
        for method in declaration.Methods {
            ReportVirtualModifiers(diagnostics, className, "method", method.OpenModifier, method.OverrideModifier)
        }
        for property in declaration.Properties {
            ReportVirtualModifiers(diagnostics, className, "property", property.OpenModifier, property.OverrideModifier)
        }
        for evt in declaration.Events {
            ReportVirtualModifiers(diagnostics, className, "event", evt.OpenModifier, evt.OverrideModifier)
        }
    }

    private func ReportVirtualModifiers(
        diagnostics DiagnosticBag,
        className string,
        memberKind string,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?
    ) {
        if openModifier != nil {
            diagnostics.ReportSharedClassCannotDeclare(openModifier.Location, className, "an 'open' $memberKind")
        }
        if overrideModifier != nil {
            diagnostics.ReportSharedClassCannotDeclare(
                overrideModifier.Location,
                className,
                "an 'override' $memberKind"
            )
        }
    }

    private func NormalizeNestedTypes(
        nestedTypes ImmutableArray[MemberSyntax],
        diagnostics DiagnosticBag
    ) ImmutableArray[MemberSyntax] {
        if nestedTypes.IsDefaultOrEmpty {
            return nestedTypes
        }
        var rebuilt ImmutableArray[MemberSyntax].Builder? = nil
        for var i = 0; i < nestedTypes.Length; i++ {
            if nestedTypes[i] is not StructDeclarationSyntax nested {
                rebuilt?.Add(nestedTypes[i])
                continue
            }
            let normalized = Normalize(nested, diagnostics)
            if rebuilt == nil && !object.ReferenceEquals(normalized, nested) {
                rebuilt = ImmutableArray.CreateBuilder[MemberSyntax](nestedTypes.Length)
                rebuilt.AddRange(nestedTypes, i)
            }
            rebuilt?.Add(normalized)
        }
        return if rebuilt == nil {
            nestedTypes
        } else {
            rebuilt.MoveToImmutable()
        }
    }

    private func Concat[T](first ImmutableArray[T], second ImmutableArray[T]?) ImmutableArray[T] {
        if second is not{IsDefaultOrEmpty: false} more {
            return if first.IsDefault {
                ImmutableArray[T].Empty
            } else {
                first
            }
        }
        return if first.IsDefaultOrEmpty {
            more
        } else {
            first.AddRange(more)
        }
    }
}
