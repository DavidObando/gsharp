// <copyright file="AccessibilityMap.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-12: canonical home for the small G# <see cref="Accessibility"/> →
/// <see cref="System.Reflection"/> attribute mappers used by both
/// <see cref="ReflectionMetadataEmitter"/> (root) and
/// <see cref="TypeDefEmitter"/>. Previously each sibling carried a private
/// copy to avoid widening the root's visibility; now both call into this
/// shared static helper.
/// </summary>
internal static class AccessibilityMap
{
    public static TypeAttributes MapTypeAccessibility(Accessibility accessibility)
    {
        return accessibility switch
        {
            Accessibility.Internal => TypeAttributes.NotPublic,
            Accessibility.Private => TypeAttributes.NotPublic,
            _ => TypeAttributes.Public,
        };
    }

    public static TypeAttributes MapNestedTypeAccessibility(Accessibility accessibility)
    {
        return accessibility switch
        {
            Accessibility.Internal => TypeAttributes.NestedAssembly,
            Accessibility.Private => TypeAttributes.NestedPrivate,
            Accessibility.Protected => TypeAttributes.NestedFamily,
            _ => TypeAttributes.NestedPublic,
        };
    }

    public static FieldAttributes MapFieldAccessibility(Accessibility accessibility)
    {
        return accessibility switch
        {
            Accessibility.Internal => FieldAttributes.Assembly,
            Accessibility.Private => FieldAttributes.Private,
            Accessibility.Protected => FieldAttributes.Family,
            _ => FieldAttributes.Public,
        };
    }

    public static MethodAttributes ToMethodVisibility(Accessibility accessibility)
    {
        switch (accessibility)
        {
            case Accessibility.Public:
                return MethodAttributes.Public;
            case Accessibility.Internal:
                return MethodAttributes.Assembly;
            case Accessibility.Private:
                return MethodAttributes.Private;
            case Accessibility.Protected:
                return MethodAttributes.Family;
            default:
                return MethodAttributes.Public;
        }
    }

    /// <summary>
    /// Issue #909 / ADR-0109: maps a function's source accessibility to IL
    /// <see cref="MethodAttributes"/> visibility, accounting for whether the
    /// function is a top-level member of the synthetic <c>&lt;Program&gt;</c>
    /// type.
    /// <para>
    /// Top-level <c>private</c> functions live on <c>&lt;Program&gt;</c>, but the
    /// binder's accessibility model treats them as assembly-visible: sibling
    /// top-level types (e.g. a user <c>class</c>) in the same assembly may call
    /// them. Mapping source <c>private</c> to IL <see cref="MethodAttributes.Private"/>
    /// makes the CLR enforce private-to-<c>&lt;Program&gt;</c>, which DISAGREES
    /// with the binder and yields a runtime <see cref="System.MethodAccessException"/>
    /// despite a clean compile. We therefore emit top-level <c>private</c> as IL
    /// <c>assembly</c> (internal) so the IL accessibility matches what the binder
    /// already permits.
    /// </para>
    /// <para>
    /// This remapping is scoped to <c>&lt;Program&gt;</c> members ONLY. A
    /// <c>private</c> member of a user-defined <c>class</c>/<c>struct</c>/
    /// <c>interface</c> keeps IL <see cref="MethodAttributes.Private"/> so the
    /// CLR continues to enforce real user-type privacy.
    /// </para>
    /// </summary>
    /// <param name="accessibility">The source accessibility of the function.</param>
    /// <param name="isTopLevelProgramMember">
    /// <c>true</c> when the function is hosted on the synthetic
    /// <c>&lt;Program&gt;</c> type (see <see cref="IsTopLevelProgramMember"/>).
    /// </param>
    /// <returns>The IL visibility <see cref="MethodAttributes"/>.</returns>
    public static MethodAttributes ToMethodVisibility(Accessibility accessibility, bool isTopLevelProgramMember)
    {
        if (isTopLevelProgramMember && accessibility == Accessibility.Private)
        {
            return MethodAttributes.Assembly;
        }

        return ToMethodVisibility(accessibility);
    }

    /// <summary>
    /// Determines whether <paramref name="function"/> is emitted as a top-level
    /// member of the synthetic <c>&lt;Program&gt;</c> type (as opposed to a
    /// member of a user-defined type). Instance methods are owned by their
    /// declaring type and static methods carry a non-null
    /// <see cref="FunctionSymbol.StaticOwnerType"/>; everything else (plain
    /// top-level functions, extension functions, and non-capturing lambda host
    /// methods) is hosted on <c>&lt;Program&gt;</c>.
    /// </summary>
    /// <param name="function">The function being emitted.</param>
    /// <returns><c>true</c> when the function is a <c>&lt;Program&gt;</c> member.</returns>
    public static bool IsTopLevelProgramMember(FunctionSymbol function)
        => !function.IsInstanceMethod && function.StaticOwnerType is null;
}
