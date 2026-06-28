#nullable disable

// <copyright file="ClrNullability.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Phase 3.C.5 / ADR-0001 / issue #209: helpers for reading C# nullable-reference-types
/// metadata (<c>[NullableAttribute]</c> / <c>[NullableContextAttribute]</c>)
/// from members loaded through a <see cref="MetadataLoadContext"/>.
///
/// Both top-level and inner-position (generic type argument) nullability are
/// surfaced. Inner positions are carried via <see cref="NullabilityAnnotatedTypeSymbol"/>
/// so that code paths such as <c>for range</c> iteration and CLR indexer access
/// can recover the element-type nullability at bind time.
/// </summary>
public static class ClrNullability
{
    private const string NullableAttributeFullName = "System.Runtime.CompilerServices.NullableAttribute";
    private const string NullableContextAttributeFullName = "System.Runtime.CompilerServices.NullableContextAttribute";
    private const string NotNullWhenAttributeFullName = "System.Diagnostics.CodeAnalysis.NotNullWhenAttribute";
    private const string MaybeNullWhenAttributeFullName = "System.Diagnostics.CodeAnalysis.MaybeNullWhenAttribute";
    private const string MemberNotNullAttributeFullName = "System.Diagnostics.CodeAnalysis.MemberNotNullAttribute";
    private const string MemberNotNullWhenAttributeFullName = "System.Diagnostics.CodeAnalysis.MemberNotNullWhenAttribute";

    /// <summary>
    /// Returns the GSharp <see cref="TypeSymbol"/> for a property's
    /// declared type, with reference-type nullability applied (both
    /// top-level and inner generic argument positions — issue #209).
    /// Value-type <c>Nullable&lt;T&gt;</c> is handled inside
    /// <see cref="TypeSymbol.FromClrType(Type)"/>.
    /// </summary>
    /// <param name="property">The property to inspect.</param>
    /// <returns>The mapped type symbol.</returns>
    public static TypeSymbol GetPropertyTypeSymbol(PropertyInfo property)
    {
        var baseSymbol = TypeSymbol.FromClrType(property.PropertyType);

        // Properties have no dedicated `ReturnParameter` to attach
        // `[NullableAttribute]` to in C# metadata; the attribute lands on
        // the property itself. Walk the enclosing member chain via the
        // declaring type to pick up any `[NullableContextAttribute]`
        // fallback (matches the C# emit shape used by csc for
        // e.g. `DirectoryInfo.Parent`).
        return ApplyReferenceNullabilityFull(baseSymbol, property.PropertyType, property, property.DeclaringType);
    }

    /// <summary>
    /// Returns the GSharp <see cref="TypeSymbol"/> for a field's
    /// declared type, with reference-type nullability applied.
    /// </summary>
    /// <param name="field">The field to inspect.</param>
    /// <returns>The mapped type symbol.</returns>
    public static TypeSymbol GetFieldTypeSymbol(FieldInfo field)
    {
        var baseSymbol = TypeSymbol.FromClrType(field.FieldType);
        return ApplyReferenceNullabilityFull(baseSymbol, field.FieldType, field, field.DeclaringType);
    }

    /// <summary>
    /// Returns the GSharp <see cref="TypeSymbol"/> for a method's return
    /// type, wrapping it in <see cref="NullableTypeSymbol"/> when the
    /// underlying CLR type is a reference type annotated as nullable, and
    /// in <see cref="NullabilityAnnotatedTypeSymbol"/> when the type has
    /// generic arguments with inner-position nullability (issue #209).
    /// Value-type nullability (<c>Nullable&lt;T&gt;</c>) is handled inside
    /// <see cref="TypeSymbol.FromClrType(Type)"/>.
    /// </summary>
    /// <param name="method">The method to inspect.</param>
    /// <returns>The mapped type symbol.</returns>
    public static TypeSymbol GetReturnTypeSymbol(MethodInfo method)
    {
        var baseSymbol = TypeSymbol.FromClrType(method.ReturnType);
        return ApplyReferenceNullabilityFull(baseSymbol, method.ReturnType, method.ReturnParameter, method);
    }

    /// <summary>
    /// Returns the GSharp <see cref="TypeSymbol"/> for a parameter, with
    /// reference-type nullability applied (both top-level and inner generic
    /// argument positions — issue #209).
    /// </summary>
    /// <param name="parameter">The parameter to inspect.</param>
    /// <returns>The mapped type symbol.</returns>
    public static TypeSymbol GetParameterTypeSymbol(ParameterInfo parameter)
    {
        var baseSymbol = TypeSymbol.FromClrType(parameter.ParameterType);
        return ApplyReferenceNullabilityFull(baseSymbol, parameter.ParameterType, parameter, parameter.Member);
    }

    internal static bool TryGetNotNullWhen(ParameterInfo parameter, out bool returnValue)
    {
        return TryGetBoolAttributeValue(parameter, NotNullWhenAttributeFullName, out returnValue);
    }

    internal static bool TryGetMaybeNullWhen(ParameterInfo parameter, out bool returnValue)
    {
        return TryGetBoolAttributeValue(parameter, MaybeNullWhenAttributeFullName, out returnValue);
    }

    /// <summary>
    /// Collects all member names from every <c>[MemberNotNull]</c> attribute
    /// on <paramref name="method"/>. Issue #208: used to apply unconditional
    /// field post-condition narrowing at call sites.
    /// </summary>
    /// <param name="method">The method to inspect.</param>
    /// <param name="members">Receives the collected member names.</param>
    /// <returns><c>true</c> when at least one name was collected.</returns>
    internal static bool TryGetMemberNotNullMembers(MethodInfo method, out ImmutableArray<string> members)
    {
        members = ImmutableArray<string>.Empty;
        var attrs = SafeGetCustomAttributesData(method);
        if (attrs == null)
        {
            return false;
        }

        ImmutableArray<string>.Builder builder = null;
        foreach (var ad in attrs)
        {
            if (ad.AttributeType?.FullName != MemberNotNullAttributeFullName || ad.ConstructorArguments.Count == 0)
            {
                continue;
            }

            foreach (var arg in ad.ConstructorArguments)
            {
                CollectStringOrArray(arg, ref builder);
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
    /// Extracts the <c>returnValue</c> boolean and field names from a
    /// <c>[MemberNotNullWhen]</c> attribute on <paramref name="method"/>.
    /// Issue #208: used to apply conditional field post-condition narrowing.
    /// Returns the first valid occurrence found.
    /// </summary>
    /// <param name="method">The method to inspect.</param>
    /// <param name="returnValue">Receives the <c>returnValue</c> argument.</param>
    /// <param name="members">Receives the member names.</param>
    /// <returns><c>true</c> when a valid <c>[MemberNotNullWhen]</c> was found.</returns>
    internal static bool TryGetMemberNotNullWhenData(MethodInfo method, out bool returnValue, out ImmutableArray<string> members)
    {
        returnValue = false;
        members = ImmutableArray<string>.Empty;
        var attrs = SafeGetCustomAttributesData(method);
        if (attrs == null)
        {
            return false;
        }

        foreach (var ad in attrs)
        {
            if (ad.AttributeType?.FullName != MemberNotNullWhenAttributeFullName || ad.ConstructorArguments.Count < 2)
            {
                continue;
            }

            if (ad.ConstructorArguments[0].Value is not bool rv)
            {
                continue;
            }

            ImmutableArray<string>.Builder builder = null;
            for (var i = 1; i < ad.ConstructorArguments.Count; i++)
            {
                CollectStringOrArray(ad.ConstructorArguments[i], ref builder);
            }

            if (builder != null && builder.Count > 0)
            {
                returnValue = rv;
                members = builder.ToImmutable();
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Reads the full <c>[NullableAttribute]</c> byte array for a declaration,
    /// falling back to a single-element array derived from the surrounding
    /// <c>[NullableContextAttribute]</c> when no explicit <c>[Nullable]</c> is
    /// present. Returns an empty array when no annotation is found at all.
    /// </summary>
    /// <param name="declaration">The attribute provider to inspect (parameter, return parameter, etc.).</param>
    /// <param name="enclosingMember">The enclosing member used to walk up to <c>[NullableContext]</c>.</param>
    /// <returns>The full byte array, or an empty array when no annotation is available.</returns>
    internal static ImmutableArray<byte> ReadNullableFlags(ICustomAttributeProvider declaration, MemberInfo enclosingMember)
    {
        var attrs = SafeGetCustomAttributesData(declaration);
        if (attrs != null)
        {
            foreach (var ad in attrs)
            {
                if (ad.AttributeType?.FullName != NullableAttributeFullName || ad.ConstructorArguments.Count != 1)
                {
                    continue;
                }

                var arg = ad.ConstructorArguments[0];

                // Single-byte scalar form: [Nullable(1)] or [Nullable(2)]
                if (arg.Value is byte b)
                {
                    return ImmutableArray.Create(b);
                }

                // Array form: [Nullable(new byte[] { 1, 1, 2 })]
                if (arg.Value is System.Collections.ObjectModel.ReadOnlyCollection<CustomAttributeTypedArgument> arr)
                {
                    var builder = ImmutableArray.CreateBuilder<byte>(arr.Count);
                    foreach (var elem in arr)
                    {
                        if (elem.Value is byte eb)
                        {
                            builder.Add(eb);
                        }
                    }

                    return builder.Count > 0 ? builder.ToImmutable() : ImmutableArray<byte>.Empty;
                }
            }
        }

        // Fall back to the surrounding NullableContextAttribute.
        for (var member = enclosingMember; member != null; member = member.DeclaringType)
        {
            var contextAttrs = SafeGetCustomAttributesData(member);
            if (contextAttrs == null)
            {
                continue;
            }

            foreach (var ad in contextAttrs)
            {
                if (ad.AttributeType?.FullName == NullableContextAttributeFullName
                    && ad.ConstructorArguments.Count == 1
                    && ad.ConstructorArguments[0].Value is byte ctxByte)
                {
                    return ImmutableArray.Create(ctxByte);
                }
            }
        }

        return ImmutableArray<byte>.Empty;
    }

    /// <summary>
    /// Counts the number of bytes the C# compiler emits for <paramref name="type"/>
    /// in a <c>[NullableAttribute]</c> byte array. The count equals the number of
    /// reference-type positions in a DFS pre-order traversal of the type tree.
    /// Value types themselves contribute 0 bytes; their reference-type generic
    /// arguments still contribute.
    /// </summary>
    /// <param name="type">The CLR type to measure.</param>
    /// <returns>The number of nullability bytes this type occupies.</returns>
    internal static int CountNullabilityBytes(Type type)
    {
        if (type == null)
        {
            return 0;
        }

        int count = type.IsValueType ? 0 : 1;

        if (type.IsGenericType && !type.IsGenericTypeDefinition)
        {
            foreach (var arg in type.GetGenericArguments())
            {
                count += CountNullabilityBytes(arg);
            }
        }

        return count;
    }

    /// <summary>
    /// Constructs a <see cref="TypeSymbol"/> for <paramref name="clrType"/> by
    /// reading the nullability byte at <paramref name="offset"/> within
    /// <paramref name="flags"/>, and (for generic types with further inner bytes)
    /// wrapping the result in a <see cref="NullabilityAnnotatedTypeSymbol"/>.
    /// </summary>
    /// <param name="clrType">The CLR type to map.</param>
    /// <param name="flags">The full nullable-flags byte array.</param>
    /// <param name="offset">The index within <paramref name="flags"/> where this type's byte lives.</param>
    /// <returns>The appropriately-nullified <see cref="TypeSymbol"/>.</returns>
    internal static TypeSymbol SymbolFromFlagsOffset(Type clrType, ImmutableArray<byte> flags, int offset)
    {
        var baseSymbol = TypeSymbol.FromClrType(clrType);

        if (clrType.IsValueType)
        {
            // Value types carry no reference-nullability byte for themselves.
            // But a generic value type (e.g., ValueTuple<string, …>) may still
            // have inner reference-type arguments.
            if (clrType.IsGenericType && !clrType.IsGenericTypeDefinition && flags.Length > offset)
            {
                return new NullabilityAnnotatedTypeSymbol(baseSymbol, flags.Skip(offset).ToImmutableArray());
            }

            return baseSymbol;
        }

        byte flag = offset < flags.Length ? flags[offset] : (byte)0;
        bool isNullable = flag == 2;
        TypeSymbol result = isNullable ? NullableTypeSymbol.Get(baseSymbol) : baseSymbol;

        // Propagate inner flags when the type is a closed generic.
        if (clrType.IsGenericType && !clrType.IsGenericTypeDefinition && flags.Length > offset + 1)
        {
            // Slice from `offset` so that NullabilityAnnotatedTypeSymbol.NullableFlags[0]
            // is the byte for this type itself, matching the layout convention.
            var slicedFlags = flags.Skip(offset).ToImmutableArray();
            var annotationBase = isNullable ? baseSymbol : result;
            var annotated = new NullabilityAnnotatedTypeSymbol(annotationBase, slicedFlags);
            result = isNullable ? (TypeSymbol)NullableTypeSymbol.Get(annotated) : annotated;
        }

        return result;
    }

    private static TypeSymbol ApplyReferenceNullabilityFull(TypeSymbol baseSymbol, Type clrType, ICustomAttributeProvider declaration, MemberInfo enclosingMember)
    {
        if (baseSymbol is NullableTypeSymbol)
        {
            // Already a value-type Nullable<T> — no further annotation needed.
            return baseSymbol;
        }

        if (clrType == null || clrType.IsValueType)
        {
            return baseSymbol;
        }

        var flags = ReadNullableFlags(declaration, enclosingMember);

        // Determine the top-level flag (byte 0 of the array, or the context fallback).
        byte topFlag = flags.Length > 0 ? flags[0] : (byte)0;

        // Wrap top-level nullability.
        TypeSymbol result = topFlag == 2 ? (TypeSymbol)NullableTypeSymbol.Get(baseSymbol) : baseSymbol;

        // If there are inner-position bytes, wrap with NullabilityAnnotatedTypeSymbol so
        // that callers (for-range, CLR indexers …) can recover element-type nullability.
        if (flags.Length > 1 && clrType.IsGenericType && !clrType.IsGenericTypeDefinition)
        {
            var annotationBase = topFlag == 2 ? baseSymbol : result;
            var annotated = new NullabilityAnnotatedTypeSymbol(annotationBase, flags);
            result = topFlag == 2 ? (TypeSymbol)NullableTypeSymbol.Get(annotated) : annotated;
        }

        return result;
    }

    private static bool TryGetBoolAttributeValue(ParameterInfo parameter, string attributeFullName, out bool value)
    {
        var attrs = SafeGetCustomAttributesData(parameter);
        if (attrs != null)
        {
            foreach (var ad in attrs)
            {
                if (ad.AttributeType?.FullName == attributeFullName
                    && ad.ConstructorArguments.Count == 1
                    && ad.ConstructorArguments[0].Value is bool boolValue)
                {
                    value = boolValue;
                    return true;
                }
            }
        }

        value = false;
        return false;
    }

    private static void CollectStringOrArray(
        CustomAttributeTypedArgument arg,
        ref ImmutableArray<string>.Builder builder)
    {
        if (arg.Value is string s && !string.IsNullOrEmpty(s))
        {
            (builder ??= ImmutableArray.CreateBuilder<string>()).Add(s);
        }
        else if (arg.Value is System.Collections.ObjectModel.ReadOnlyCollection<CustomAttributeTypedArgument> arr)
        {
            foreach (var elem in arr)
            {
                if (elem.Value is string es && !string.IsNullOrEmpty(es))
                {
                    (builder ??= ImmutableArray.CreateBuilder<string>()).Add(es);
                }
            }
        }
    }

    private static System.Collections.Generic.IList<CustomAttributeData> SafeGetCustomAttributesData(ICustomAttributeProvider provider)
    {
        try
        {
            return provider switch
            {
                MemberInfo mi => mi.GetCustomAttributesData()?.ToList(),
                ParameterInfo pi => pi.GetCustomAttributesData()?.ToList(),
                _ => null,
            };
        }
        catch
        {
            return null;
        }
    }
}
