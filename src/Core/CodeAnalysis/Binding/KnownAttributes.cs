// <copyright file="KnownAttributes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Type-identity recogniser for the closed set of compiler-recognised
/// attributes (ADR-0047 §6). All checks key off the resolved CLR
/// <see cref="System.Type"/> on a <see cref="BoundAttribute"/> rather
/// than a string name, so renaming an attribute type or shadowing it in
/// user code never breaks compiler semantics.
/// </summary>
internal static class KnownAttributes
{
    private static readonly HashSet<Type> ReservedForCompilerSet = new()
    {
        typeof(System.Runtime.CompilerServices.ExtensionAttribute),
        typeof(System.Runtime.CompilerServices.AsyncStateMachineAttribute),
        typeof(System.Runtime.CompilerServices.CompilerGeneratedAttribute),
        typeof(System.Runtime.CompilerServices.NullableAttribute),
        typeof(System.Runtime.CompilerServices.NullableContextAttribute),
    };

    /// <summary>
    /// Returns <c>true</c> when <paramref name="clrType"/> is one of the
    /// attributes ADR-0047 §6 reserves for compiler synthesis. Users
    /// must not write these in source.
    /// </summary>
    /// <param name="clrType">The resolved attribute CLR type, or <c>null</c>.</param>
    /// <returns><c>true</c> if the attribute is reserved for the compiler.</returns>
    public static bool IsReservedForCompiler(Type clrType)
    {
        return clrType != null && ReservedForCompilerSet.Contains(clrType);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attribute"/> is
    /// <see cref="System.ObsoleteAttribute"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <returns><c>true</c> when the attribute is <c>[Obsolete]</c>.</returns>
    public static bool IsObsolete(BoundAttribute attribute)
    {
        return attribute?.AttributeType?.ClrType == typeof(System.ObsoleteAttribute);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="clrType"/> is
    /// <see cref="System.Runtime.InteropServices.DllImportAttribute"/>. ADR-0047 §6
    /// recognises <c>[DllImport]</c> but only on declarations whose body marker is
    /// <c>extern</c>, which is post-v1.0; for v1.0 the binder reports
    /// <c>GS0211</c> (<c>ERR_DllImportNotSupported</c>) on any use in source.
    /// Recognition is type-identity based so renaming or shadowing the
    /// source-level name cannot bypass the rule.
    /// </summary>
    /// <param name="clrType">The resolved attribute CLR type, or <c>null</c>.</param>
    /// <returns><c>true</c> when the attribute is <c>[DllImport]</c>.</returns>
    public static bool IsDllImport(Type clrType)
    {
        return clrType == typeof(System.Runtime.InteropServices.DllImportAttribute);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attribute"/> is
    /// <see cref="System.Runtime.InteropServices.DllImportAttribute"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <returns><c>true</c> when the attribute is <c>[DllImport]</c>.</returns>
    public static bool IsDllImport(BoundAttribute attribute)
    {
        return IsDllImport(attribute?.AttributeType?.ClrType);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="clrType"/> is
    /// <see cref="System.Diagnostics.CodeAnalysis.NotNullWhenAttribute"/>.
    /// ADR-0047 §6 / issue #178: recognised on imported metadata and on
    /// user-written annotations alike; type-identity based so renaming or
    /// shadowing the source-level name cannot bypass the rule.
    /// </summary>
    /// <param name="clrType">The resolved attribute CLR type, or <c>null</c>.</param>
    /// <returns><c>true</c> when the attribute is <c>[NotNullWhen]</c>.</returns>
    public static bool IsNotNullWhen(Type clrType)
    {
        return clrType == typeof(System.Diagnostics.CodeAnalysis.NotNullWhenAttribute);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attribute"/> is
    /// <see cref="System.Diagnostics.CodeAnalysis.NotNullWhenAttribute"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <returns><c>true</c> when the attribute is <c>[NotNullWhen]</c>.</returns>
    public static bool IsNotNullWhen(BoundAttribute attribute)
    {
        return IsNotNullWhen(attribute?.AttributeType?.ClrType);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="clrType"/> is
    /// <see cref="System.Diagnostics.CodeAnalysis.MaybeNullWhenAttribute"/>.
    /// </summary>
    /// <param name="clrType">The resolved attribute CLR type, or <c>null</c>.</param>
    /// <returns><c>true</c> when the attribute is <c>[MaybeNullWhen]</c>.</returns>
    public static bool IsMaybeNullWhen(Type clrType)
    {
        return clrType == typeof(System.Diagnostics.CodeAnalysis.MaybeNullWhenAttribute);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attribute"/> is
    /// <see cref="System.Diagnostics.CodeAnalysis.MaybeNullWhenAttribute"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <returns><c>true</c> when the attribute is <c>[MaybeNullWhen]</c>.</returns>
    public static bool IsMaybeNullWhen(BoundAttribute attribute)
    {
        return IsMaybeNullWhen(attribute?.AttributeType?.ClrType);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="clrType"/> is
    /// <see cref="System.Diagnostics.CodeAnalysis.MemberNotNullAttribute"/>.
    /// Recognised so it round-trips through the attribute pipeline; field
    /// post-condition tracking is a follow-up.
    /// </summary>
    /// <param name="clrType">The resolved attribute CLR type, or <c>null</c>.</param>
    /// <returns><c>true</c> when the attribute is <c>[MemberNotNull]</c>.</returns>
    public static bool IsMemberNotNull(Type clrType)
    {
        return clrType == typeof(System.Diagnostics.CodeAnalysis.MemberNotNullAttribute);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attribute"/> is
    /// <see cref="System.Diagnostics.CodeAnalysis.MemberNotNullAttribute"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <returns><c>true</c> when the attribute is <c>[MemberNotNull]</c>.</returns>
    public static bool IsMemberNotNull(BoundAttribute attribute)
    {
        return IsMemberNotNull(attribute?.AttributeType?.ClrType);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="clrType"/> is
    /// <see cref="System.Diagnostics.CodeAnalysis.MemberNotNullWhenAttribute"/>.
    /// </summary>
    /// <param name="clrType">The resolved attribute CLR type, or <c>null</c>.</param>
    /// <returns><c>true</c> when the attribute is <c>[MemberNotNullWhen]</c>.</returns>
    public static bool IsMemberNotNullWhen(Type clrType)
    {
        return clrType == typeof(System.Diagnostics.CodeAnalysis.MemberNotNullWhenAttribute);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attribute"/> is
    /// <see cref="System.Diagnostics.CodeAnalysis.MemberNotNullWhenAttribute"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <returns><c>true</c> when the attribute is <c>[MemberNotNullWhen]</c>.</returns>
    public static bool IsMemberNotNullWhen(BoundAttribute attribute)
    {
        return IsMemberNotNullWhen(attribute?.AttributeType?.ClrType);
    }

    /// <summary>
    /// Extracts the <c>returnValue</c> boolean from a <c>[NotNullWhen(...)]</c>
    /// application. The single positional argument is the boolean trigger
    /// (issue #178 / ADR-0047 §6): when the method's <c>bool</c> return
    /// matches this value, the annotated parameter is known non-null in the
    /// caller's post-state.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <param name="returnValue">Receives the <c>returnValue</c> argument.</param>
    /// <returns><c>true</c> when <paramref name="attribute"/> is <c>[NotNullWhen]</c> and the argument is a constant <see cref="bool"/>.</returns>
    public static bool TryGetNotNullWhenReturnValue(BoundAttribute attribute, out bool returnValue)
    {
        returnValue = false;
        return IsNotNullWhen(attribute) && TryGetSingleBoolArgument(attribute, out returnValue);
    }

    /// <summary>
    /// Extracts the <c>returnValue</c> boolean from a <c>[MaybeNullWhen(...)]</c>
    /// application — the inverse postcondition to <see cref="TryGetNotNullWhenReturnValue"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <param name="returnValue">Receives the <c>returnValue</c> argument.</param>
    /// <returns><c>true</c> when <paramref name="attribute"/> is <c>[MaybeNullWhen]</c> and the argument is a constant <see cref="bool"/>.</returns>
    public static bool TryGetMaybeNullWhenReturnValue(BoundAttribute attribute, out bool returnValue)
    {
        returnValue = false;
        return IsMaybeNullWhen(attribute) && TryGetSingleBoolArgument(attribute, out returnValue);
    }

    /// <summary>
    /// Collects all member names from every <c>[MemberNotNull("_f1", "_f2", …)]</c>
    /// attribute in <paramref name="attributes"/>. Issue #208: the post-call
    /// postcondition lists which fields are non-null after the annotated method
    /// returns. Multiple attributes and multiple string arguments per attribute
    /// are both supported.
    /// </summary>
    /// <param name="attributes">The attribute list on a function symbol.</param>
    /// <param name="members">Receives the collected member names.</param>
    /// <returns><c>true</c> when at least one name was collected.</returns>
    public static bool TryGetMemberNotNullMembers(ImmutableArray<BoundAttribute> attributes, out ImmutableArray<string> members)
    {
        members = ImmutableArray<string>.Empty;
        if (attributes.IsDefaultOrEmpty)
        {
            return false;
        }

        ImmutableArray<string>.Builder builder = null;
        foreach (var attr in attributes)
        {
            if (!IsMemberNotNull(attr) || attr.PositionalArguments.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var arg in attr.PositionalArguments)
            {
                if (arg.Value is string s && !string.IsNullOrEmpty(s))
                {
                    (builder ??= ImmutableArray.CreateBuilder<string>()).Add(s);
                }
            }
        }

        if (builder == null)
        {
            return false;
        }

        members = builder.ToImmutable();
        return true;
    }

    /// <summary>
    /// Extracts the <c>returnValue</c> boolean and field names from a single
    /// <c>[MemberNotNullWhen(returnValue, "_f1", "_f2", …)]</c> attribute.
    /// Issue #208: on the arm where the call returns <paramref name="returnValue"/>
    /// the named fields are guaranteed non-null.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <param name="returnValue">Receives the <c>returnValue</c> argument.</param>
    /// <param name="members">Receives the member names.</param>
    /// <returns><c>true</c> when <paramref name="attribute"/> is a valid
    /// <c>[MemberNotNullWhen]</c> with at least one string member.</returns>
    public static bool TryGetMemberNotNullWhenData(BoundAttribute attribute, out bool returnValue, out ImmutableArray<string> members)
    {
        returnValue = false;
        members = ImmutableArray<string>.Empty;

        if (!IsMemberNotNullWhen(attribute)
            || attribute.PositionalArguments.IsDefaultOrEmpty
            || attribute.PositionalArguments.Length < 2
            || attribute.PositionalArguments[0].Value is not bool rv)
        {
            return false;
        }

        var builder = ImmutableArray.CreateBuilder<string>();
        for (var i = 1; i < attribute.PositionalArguments.Length; i++)
        {
            if (attribute.PositionalArguments[i].Value is string s && !string.IsNullOrEmpty(s))
            {
                builder.Add(s);
            }
        }

        if (builder.Count == 0)
        {
            return false;
        }

        returnValue = rv;
        members = builder.ToImmutable();
        return true;
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="clrType"/> is
    /// <see cref="System.Runtime.CompilerServices.EnumeratorCancellationAttribute"/>.
    /// Recognition is type-identity based (ADR-0047 §6 / ADR-0040): the
    /// resolved CLR type — not the source name — selects the behaviour, so a
    /// renamed or shadowed alias cannot bypass the validation rules.
    /// </summary>
    /// <param name="clrType">The resolved attribute CLR type, or <c>null</c>.</param>
    /// <returns><c>true</c> when the attribute is <c>[EnumeratorCancellation]</c>.</returns>
    public static bool IsEnumeratorCancellation(Type clrType)
    {
        return clrType == typeof(System.Runtime.CompilerServices.EnumeratorCancellationAttribute);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attribute"/> is
    /// <see cref="System.Runtime.CompilerServices.EnumeratorCancellationAttribute"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <returns><c>true</c> when the attribute is <c>[EnumeratorCancellation]</c>.</returns>
    public static bool IsEnumeratorCancellation(BoundAttribute attribute)
    {
        return IsEnumeratorCancellation(attribute?.AttributeType?.ClrType);
    }

    /// <summary>
    /// Returns the first <c>[EnumeratorCancellation]</c> attribute in
    /// <paramref name="attributes"/>, or <c>null</c> if none is present.
    /// </summary>
    /// <param name="attributes">The attribute list on a parameter symbol.</param>
    /// <returns>The matching attribute, or <c>null</c>.</returns>
    public static BoundAttribute FindEnumeratorCancellation(ImmutableArray<BoundAttribute> attributes)
    {
        if (attributes.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var attr in attributes)
        {
            if (IsEnumeratorCancellation(attr))
            {
                return attr;
            }
        }

        return null;
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="clrType"/> is
    /// <see cref="System.Diagnostics.ConditionalAttribute"/>. ADR-0047 §6 /
    /// issue #176: calls to a method carrying one or more
    /// <c>[Conditional("SYMBOL")]</c> applications are elided at every call
    /// site at which none of the named symbols is in the active preprocessor
    /// symbol set. Recognition is type-identity based so renaming or shadowing
    /// the source-level name cannot bypass the rule.
    /// </summary>
    /// <param name="clrType">The resolved attribute CLR type, or <c>null</c>.</param>
    /// <returns><c>true</c> when the attribute is <c>[Conditional]</c>.</returns>
    public static bool IsConditional(Type clrType)
    {
        return clrType == typeof(System.Diagnostics.ConditionalAttribute);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attribute"/> is
    /// <see cref="System.Diagnostics.ConditionalAttribute"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <returns><c>true</c> when the attribute is <c>[Conditional]</c>.</returns>
    public static bool IsConditional(BoundAttribute attribute)
    {
        return IsConditional(attribute?.AttributeType?.ClrType);
    }

    /// <summary>
    /// Returns <c>true</c> when any attribute in <paramref name="attributes"/>
    /// is <see cref="System.Diagnostics.ConditionalAttribute"/>. Used by the
    /// function-declaration binder to drive the void-return validation
    /// (ADR-0047 §6 / issue #176).
    /// </summary>
    /// <param name="attributes">The attribute list on a function symbol.</param>
    /// <returns><c>true</c> when at least one <c>[Conditional]</c> is present.</returns>
    public static bool HasConditional(ImmutableArray<BoundAttribute> attributes)
    {
        if (attributes.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var attr in attributes)
        {
            if (IsConditional(attr))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attributes"/> contains at
    /// least one <c>[Conditional("SYMBOL")]</c> application and *none* of the
    /// named symbols is present in <paramref name="preprocessorSymbols"/>. In
    /// that case the call site must be elided per ADR-0047 §6 / issue #176.
    /// Returns <c>false</c> when no <c>[Conditional]</c> attribute is present
    /// (so the caller emits the call normally) or when at least one named
    /// symbol is defined (the C# rule is "any defined symbol keeps the call").
    /// Attributes whose positional argument is missing or not a string are
    /// ignored for the purpose of elision; they were already reported as
    /// invalid by attribute argument binding.
    /// </summary>
    /// <param name="attributes">The attribute list on the called function.</param>
    /// <param name="preprocessorSymbols">The active preprocessor symbol set; never <c>null</c>.</param>
    /// <returns><c>true</c> when the call should be elided.</returns>
    public static bool IsConditionallyElided(ImmutableArray<BoundAttribute> attributes, System.Collections.Generic.ICollection<string> preprocessorSymbols)
    {
        if (attributes.IsDefaultOrEmpty)
        {
            return false;
        }

        var sawConditional = false;
        foreach (var attr in attributes)
        {
            if (!IsConditional(attr))
            {
                continue;
            }

            sawConditional = true;
            if (attr.PositionalArguments.IsDefaultOrEmpty || attr.PositionalArguments.Length < 1)
            {
                continue;
            }

            if (attr.PositionalArguments[0].Value is string symbol
                && preprocessorSymbols != null
                && preprocessorSymbols.Contains(symbol))
            {
                return false;
            }
        }

        return sawConditional;
    }

    /// <summary>
    /// Looks for an <c>[Obsolete]</c> attribute in <paramref name="attributes"/>
    /// and extracts its <c>message</c> and <c>isError</c> arguments.
    /// </summary>
    /// <param name="attributes">The attribute list on the symbol.</param>
    /// <param name="message">The optional user-supplied message, or <c>null</c>.</param>
    /// <param name="isError">Whether the attribute's <c>error</c> flag is set.</param>
    /// <returns><c>true</c> if any attribute in the list is <c>[Obsolete]</c>.</returns>
    public static bool TryGetObsolete(ImmutableArray<BoundAttribute> attributes, out string message, out bool isError)
    {
        message = null;
        isError = false;
        if (attributes.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var attr in attributes)
        {
            if (!IsObsolete(attr))
            {
                continue;
            }

            if (!attr.PositionalArguments.IsDefaultOrEmpty)
            {
                if (attr.PositionalArguments.Length >= 1 && attr.PositionalArguments[0].Value is string s)
                {
                    message = s;
                }

                if (attr.PositionalArguments.Length >= 2 && attr.PositionalArguments[1].Value is bool b)
                {
                    isError = b;
                }
            }

            return true;
        }

        return false;
    }

    /// <summary>
    /// Resolves the effective <see cref="AttributeUsageAttribute"/> for the
    /// candidate attribute class <paramref name="attributeType"/>. ADR-0047
    /// §6 / issue #177: an <c>@AttributeUsage(...)</c> annotation on a
    /// user-declared <c>@Attribute</c> class supplies <c>ValidOn</c> and
    /// <c>AllowMultiple</c>; CLR-imported attribute types are read via
    /// reflection. When the attribute carries no <c>AttributeUsage</c> the
    /// C# defaults apply: <see cref="AttributeTargets.All"/> /
    /// <c>AllowMultiple = false</c>.
    /// </summary>
    /// <param name="attributeType">The resolved attribute type symbol.</param>
    /// <param name="validOn">Receives the <c>ValidOn</c> flag set.</param>
    /// <param name="allowMultiple">Receives the <c>AllowMultiple</c> flag.</param>
    public static void GetAttributeUsage(TypeSymbol attributeType, out AttributeTargets validOn, out bool allowMultiple)
    {
        validOn = AttributeTargets.All;
        allowMultiple = false;

        if (attributeType == null)
        {
            return;
        }

        if (attributeType is StructSymbol structSym && structSym.IsAttributeClass)
        {
            if (TryReadAttributeUsageFromBound(structSym.Attributes, out var v, out var am))
            {
                validOn = v;
                allowMultiple = am;
            }

            return;
        }

        var clr = attributeType.ClrType;
        if (clr == null)
        {
            return;
        }

        var usage = (AttributeUsageAttribute)Attribute.GetCustomAttribute(clr, typeof(AttributeUsageAttribute), inherit: true);
        if (usage != null)
        {
            validOn = usage.ValidOn;
            allowMultiple = usage.AllowMultiple;
        }
    }

    private static bool TryReadAttributeUsageFromBound(ImmutableArray<BoundAttribute> attributes, out AttributeTargets validOn, out bool allowMultiple)
    {
        validOn = AttributeTargets.All;
        allowMultiple = false;
        if (attributes.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var attr in attributes)
        {
            if (attr?.AttributeType?.ClrType != typeof(AttributeUsageAttribute))
            {
                continue;
            }

            if (!attr.PositionalArguments.IsDefaultOrEmpty
                && attr.PositionalArguments.Length >= 1
                && TryConvertToInt32(attr.PositionalArguments[0].Value, out var raw))
            {
                validOn = (AttributeTargets)raw;
            }

            if (!attr.NamedArguments.IsDefaultOrEmpty)
            {
                foreach (var named in attr.NamedArguments)
                {
                    if (named.Name == "AllowMultiple" && named.Value is bool b)
                    {
                        allowMultiple = b;
                    }
                }
            }

            return true;
        }

        return false;
    }

    private static bool TryConvertToInt32(object value, out int result)
    {
        switch (value)
        {
            case int i: result = i; return true;
            case short s: result = s; return true;
            case byte by: result = by; return true;
            case sbyte sb: result = sb; return true;
            case ushort us: result = us; return true;
            case uint ui: result = (int)ui; return true;
            case long l: result = (int)l; return true;
            case AttributeTargets at: result = (int)at; return true;
            default: result = 0; return false;
        }
    }

    private static bool TryGetSingleBoolArgument(BoundAttribute attribute, out bool value)
    {
        value = false;
        if (attribute == null || attribute.PositionalArguments.IsDefaultOrEmpty || attribute.PositionalArguments.Length < 1)
        {
            return false;
        }

        if (attribute.PositionalArguments[0].Value is bool b)
        {
            value = b;
            return true;
        }

        return false;
    }
}
