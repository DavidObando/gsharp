// <copyright file="SharedClassNormalizer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0195 / issue #4674: hands the binder a <c>shared class</c> in the one shape
/// it already binds. The author writes the members directly in the class body
/// (<c>shared class Helpers { func Twice(x int32) int32 { … } }</c>) and every one of
/// them is shared; the binder has a single path for a type's shared members, which
/// reads them from the type's <see cref="StructDeclarationSyntax.SharedBlock"/>. So
/// this pass returns a copy of such a declaration whose body members sit in a shared
/// block (built from the class's own <c>shared</c> modifier and braces) and whose
/// instance member lists are empty. It never mutates its input: the parsed tree is
/// reused across compilations and read by the language server, formatter and
/// analyzers, which all see the source as written.
/// <para>
/// It also rejects what a shared class cannot hold: an <c>init(…)</c> constructor, a
/// primary constructor, a <c>deinit</c>, a <c>shared { }</c> block of its own
/// (<c>GS0617</c>) and a base class or interface (<c>GS0619</c>).
/// </para>
/// </summary>
internal static class SharedClassNormalizer
{
    /// <summary>
    /// Returns <paramref name="declaration"/> with every <c>shared class</c> in it (itself
    /// and its nested types) in the binder's shape, or the same instance when there is none.
    /// </summary>
    /// <param name="declaration">The (possibly already partial-merged) class/struct declaration.</param>
    /// <param name="diagnostics">The bag that receives GS0617 and GS0619.</param>
    /// <returns>The normalized declaration.</returns>
    public static StructDeclarationSyntax Normalize(StructDeclarationSyntax declaration, DiagnosticBag diagnostics)
    {
        var nestedTypes = NormalizeNestedTypes(declaration.NestedTypes, diagnostics);

        if (!declaration.IsClass || declaration.SharedModifier is not { } sharedModifier)
        {
            return nestedTypes.Equals(declaration.NestedTypes)
                ? declaration
                : declaration.WithMemberLists(declaration.Methods, declaration.SharedBlock, nestedTypes);
        }

        Validate(declaration, diagnostics);

        // A `shared { }` block inside the class is diagnosed above; its members are still
        // folded in so they bind (and do not cascade into "member not found" errors).
        var explicitBlock = declaration.SharedBlock;
        var sharedBlock = new SharedBlockSyntax(
            declaration.SyntaxTree,
            sharedModifier,
            declaration.OpenBraceToken,
            Concat(declaration.Fields, explicitBlock?.Fields),
            Concat(declaration.Properties, explicitBlock?.Properties),
            Concat(declaration.Events, explicitBlock?.Events),
            Concat(declaration.Methods, explicitBlock?.Methods),
            Concat(declaration.SharedInitializers, explicitBlock?.InitBlocks),
            declaration.CloseBraceToken);
        return declaration.WithMembersInSharedBlock(sharedBlock, nestedTypes);
    }

    private static void Validate(StructDeclarationSyntax declaration, DiagnosticBag diagnostics)
    {
        var className = declaration.Identifier.Text;

        if (declaration.HasBaseType)
        {
            diagnostics.ReportSharedClassCannotHaveBaseTypes(
                declaration.BaseColonToken?.Location ?? declaration.Identifier.Location,
                className);
        }

        if (declaration.PrimaryConstructorOpenParenthesisToken is { } primaryConstructor)
        {
            diagnostics.ReportSharedClassCannotDeclare(primaryConstructor.Location, className, "a primary constructor");
        }

        foreach (var constructor in declaration.Constructors)
        {
            diagnostics.ReportSharedClassCannotDeclare(constructor.InitKeyword.Location, className, "an 'init' constructor");
        }

        if (declaration.Deinitializer is { } deinitializer)
        {
            diagnostics.ReportSharedClassCannotDeclare(deinitializer.DeinitKeyword.Location, className, "a 'deinit'");
        }

        if (declaration.SharedBlock is { } explicitBlock)
        {
            diagnostics.ReportSharedClassCannotDeclare(explicitBlock.SharedKeyword.Location, className, "a 'shared { }' block");
        }

        // The body parser accepts `open` and `override` on a method, property or event, and
        // the shared-member binders would silently drop them (a shared member is static
        // and never virtual), unlike the same member in a `shared { }` block. Reject them.
        foreach (var method in declaration.Methods)
        {
            ReportVirtualModifiers(diagnostics, className, "method", method.OpenModifier, method.OverrideModifier);
        }

        foreach (var property in declaration.Properties)
        {
            ReportVirtualModifiers(diagnostics, className, "property", property.OpenModifier, property.OverrideModifier);
        }

        foreach (var evt in declaration.Events)
        {
            ReportVirtualModifiers(diagnostics, className, "event", evt.OpenModifier, evt.OverrideModifier);
        }
    }

    private static void ReportVirtualModifiers(
        DiagnosticBag diagnostics,
        string className,
        string memberKind,
        SyntaxToken? openModifier,
        SyntaxToken? overrideModifier)
    {
        if (openModifier != null)
        {
            diagnostics.ReportSharedClassCannotDeclare(openModifier.Location, className, $"an 'open' {memberKind}");
        }

        if (overrideModifier != null)
        {
            diagnostics.ReportSharedClassCannotDeclare(overrideModifier.Location, className, $"an 'override' {memberKind}");
        }
    }

    private static ImmutableArray<MemberSyntax> NormalizeNestedTypes(
        ImmutableArray<MemberSyntax> nestedTypes,
        DiagnosticBag diagnostics)
    {
        if (nestedTypes.IsDefaultOrEmpty)
        {
            return nestedTypes;
        }

        ImmutableArray<MemberSyntax>.Builder? rebuilt = null;
        for (var i = 0; i < nestedTypes.Length; i++)
        {
            if (nestedTypes[i] is not StructDeclarationSyntax nested)
            {
                rebuilt?.Add(nestedTypes[i]);
                continue;
            }

            var normalized = Normalize(nested, diagnostics);
            if (rebuilt == null && !ReferenceEquals(normalized, nested))
            {
                rebuilt = ImmutableArray.CreateBuilder<MemberSyntax>(nestedTypes.Length);
                rebuilt.AddRange(nestedTypes, i);
            }

            rebuilt?.Add(normalized);
        }

        return rebuilt == null ? nestedTypes : rebuilt.MoveToImmutable();
    }

    private static ImmutableArray<T> Concat<T>(ImmutableArray<T> first, ImmutableArray<T>? second)
    {
        if (second is not { IsDefaultOrEmpty: false } more)
        {
            return first.IsDefault ? ImmutableArray<T>.Empty : first;
        }

        return first.IsDefaultOrEmpty ? more : first.AddRange(more);
    }
}
