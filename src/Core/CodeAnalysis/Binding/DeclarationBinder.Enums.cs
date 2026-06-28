// <copyright file="DeclarationBinder.Enums.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Extracted from <see cref="Binder"/> in PR-B-8. Owns every per-declaration-kind
/// binder: type aliases, named delegates, enums, structs (including the large
/// <c>BindStructDeclarationBody</c> driver and its interface-implementation
/// verification pass), interfaces, free / member / extension functions,
/// constructors (<c>init</c>) plus the <c>: base(...)</c> initializer
/// resolver, the two symbol-construction <c>BindVariableDeclaration</c>
/// overloads, generic-parameter binding (<c>BindTypeParameterList</c>), the
/// declaration-side attribute binder (<c>BindAttributes</c>/<c>BindAttribute</c>),
/// and the queue of pending struct→interface implementation checks. The
/// expression binder and most type-name resolution remain on
/// <see cref="Binder"/> and are invoked via the delegate callbacks supplied to
/// the constructor; the same is true for <c>BindBlockStatement</c>-driven
/// body binding (which happens later, in <c>BindProgram</c>, not here).
/// </summary>

internal sealed partial class DeclarationBinder
{


    internal EnumSymbol BindEnumDeclaration(EnumDeclarationSyntax syntax, PackageSymbol package, TypeSymbol containingType = null)
    {
        var name = syntax.Identifier.Text;

        if (isPrimitiveTypeName(name))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
            return null;
        }

        var accessibility = resolveAccessibility(syntax.AccessibilityModifier);
        var enumSymbol = new EnumSymbol(name, accessibility, package.Name, syntax);

        // Issue #1080: set the enclosing type BEFORE registering the name so the
        // scope can scope name-uniqueness to the enclosing type (a nested type
        // must not collide with a same-named package-level or differently-nested
        // type).
        if (containingType != null)
        {
            enumSymbol.SetContainingType(containingType);
        }

        Binder.AttachDocumentation(enumSymbol, syntax);
        enumSymbol.SetAttributes(BindAttributes(
            syntax.Annotations,
            AttributeTargetKind.Type,
            Binder.TypeDeclarationAllowedTargets,
            "an enum declaration",
            System.AttributeTargets.Enum));

        var seenMemberNames = new HashSet<string>();
        var members = ImmutableArray.CreateBuilder<EnumMemberSymbol>();
        foreach (var memberSyntax in syntax.Members)
        {
            var memberName = memberSyntax.Identifier.Text;
            if (!seenMemberNames.Add(memberName))
            {
                Diagnostics.ReportDuplicateEnumMember(memberSyntax.Identifier.Location, memberName, name);
                continue;
            }

            var memberSymbol = new EnumMemberSymbol(memberName, enumSymbol, members.Count);
            Binder.AttachDocumentation(memberSymbol, memberSyntax);

            // Issue #188 / ADR-0047 §3: bind any `@Foo` annotations attached
            // to the enum-member entry with default target `field` (enum
            // members are emitted as static literal fields on the enum type
            // per ECMA-335 §I.8.5.2), so #175 use-site diagnostics
            // (e.g. `@Obsolete`) fire on `Color.Red` references.
            if (!memberSyntax.Annotations.IsDefaultOrEmpty)
            {
                memberSymbol.SetAttributes(BindAttributes(
                    memberSyntax.Annotations,
                    AttributeTargetKind.Field,
                    Binder.VariableDeclarationAllowedTargets,
                    "an enum member declaration",
                    System.AttributeTargets.Field));
            }

            members.Add(memberSymbol);
        }

        if (members.Count == 0)
        {
            Diagnostics.ReportEmptyEnumDeclaration(syntax.Identifier.Location, name);
        }

        enumSymbol.SetMembers(members.ToImmutable());

        if (!scope.TryDeclareTypeAlias(name, enumSymbol))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, name);
        }

        return enumSymbol;
    }

    private static bool IsEnumLikeType(TypeSymbol type)
    {
        if (type is EnumSymbol)
        {
            return true;
        }

        var clr = type?.ClrType;
        return clr != null && clr.IsEnum;
    }
}
