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
            _ => TypeAttributes.NestedPublic,
        };
    }

    public static FieldAttributes MapFieldAccessibility(Accessibility accessibility)
    {
        return accessibility switch
        {
            Accessibility.Internal => FieldAttributes.Assembly,
            Accessibility.Private => FieldAttributes.Private,
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
            default:
                return MethodAttributes.Public;
        }
    }
}
