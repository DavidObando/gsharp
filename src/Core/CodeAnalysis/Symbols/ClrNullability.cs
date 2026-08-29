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
/// Both top-level and inner-position (generic argument or array element)
/// nullability are surfaced. Inner positions are carried via
/// <see cref="NullabilityAnnotatedTypeSymbol"/> so that code paths such as
/// <c>for range</c> iteration and CLR indexer access can recover element
/// nullability at bind time.
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
        // ADR-0172 Phase B: surface imported tuple element names.
        return TupleElementNamesReader.ApplyNames(
            ApplyReferenceNullabilityFull(baseSymbol, property.PropertyType, property, property.DeclaringType),
            property);
    }

    /// <summary>
    /// Issue #1701: variant of <see cref="GetPropertyTypeSymbol(PropertyInfo)"/>
    /// for a ref-returning indexer (<c>PropertyType.IsByRef</c>), where the
    /// <c>[NullableAttribute]</c> metadata is read off <paramref name="property"/>
    /// but applied to <paramref name="elementType"/> (the by-ref pointee,
    /// e.g. <c>T</c> in <c>ref T</c>) rather than the by-ref type itself —
    /// mirroring how <see cref="GetPropertyTypeSymbol(PropertyInfo)"/> handles
    /// the non-byref case. Callers wrap the result in <c>ByRefTypeSymbol</c>.
    /// </summary>
    /// <param name="property">The ref-returning indexer/property to read attributes from.</param>
    /// <param name="elementType">The dereferenced (non-byref) element type.</param>
    /// <returns>The nullability-aware element type symbol.</returns>
    public static TypeSymbol GetPropertyElementTypeSymbol(PropertyInfo property, Type elementType)
    {
        var baseSymbol = TypeSymbol.FromClrType(elementType);
        return TupleElementNamesReader.ApplyNames(
            ApplyReferenceNullabilityFull(baseSymbol, elementType, property, property.DeclaringType),
            property);
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

        // ADR-0172 Phase B: surface imported tuple element names.
        return TupleElementNamesReader.ApplyNames(
            ApplyReferenceNullabilityFull(baseSymbol, field.FieldType, field, field.DeclaringType),
            field);
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
        var definition = GetMetadataDefinition(method) as MethodInfo;

        // ADR-0172 Phase B: surface imported tuple element names.
        return TupleElementNamesReader.ApplyNames(
            ApplyReferenceNullabilityFull(
                baseSymbol,
                method.ReturnType,
                method.ReturnParameter,
                method,
                definition?.ReturnType),
            method.ReturnParameter);
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
        var parameterType = parameter.ParameterType.IsByRef
            ? parameter.ParameterType.GetElementType()
            : parameter.ParameterType;
        var definition = parameter.Member is MethodBase method
            ? GetMetadataDefinition(method)
            : null;
        var definitionParameters = definition?.GetParameters();
        var layoutType = definitionParameters != null
            && (uint)parameter.Position < (uint)definitionParameters.Length
                ? definitionParameters[parameter.Position].ParameterType
                : null;
        if (layoutType?.IsByRef == true)
        {
            layoutType = layoutType.GetElementType();
        }

        var baseSymbol = TypeSymbol.FromClrType(parameterType);
        var mapped = ApplyReferenceNullabilityFull(
            baseSymbol,
            parameterType,
            parameter,
            parameter.Member,
            layoutType);

        // ADR-0172 Phase B: surface imported tuple element names.
        mapped = TupleElementNamesReader.ApplyNames(mapped, parameter);
        var rawDefault = parameter.HasDefaultValue || parameter.IsOptional
            ? parameter.RawDefaultValue
            : null;
        return parameterType?.IsValueType == false
            && (parameter.HasDefaultValue || parameter.IsOptional)
            && (rawDefault == null
                || ReferenceEquals(rawDefault, Missing.Value)
                || ReferenceEquals(rawDefault, System.DBNull.Value))
            && mapped is not NullableTypeSymbol
                ? NullableTypeSymbol.Get(mapped)
                : mapped;
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

        ImmutableArray<string>.Builder? builder = null;
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

            ImmutableArray<string>.Builder? builder = null;
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
    internal static ImmutableArray<byte> ReadNullableFlags(ICustomAttributeProvider declaration, MemberInfo? enclosingMember)
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
    /// in a <c>[NullableAttribute]</c> byte array. The count follows the CLR
    /// DFS pre-order layout: reference and array positions contribute one byte,
    /// as does a closed generic value type's leading oblivious placeholder.
    /// <c>Nullable&lt;T&gt;</c> is transparent and contributes only T's
    /// subtree; generic parameters contribute one slot (forced to <c>0</c>
    /// for a struct constraint); non-generic value types contribute none.
    /// </summary>
    /// <param name="type">The CLR type to measure.</param>
    /// <returns>The number of nullability bytes this type occupies.</returns>
    internal static int CountNullabilityBytes(Type type)
    {
        if (type == null)
        {
            return 0;
        }

        if (NullableLifting.GetValueTypeNullableUnderlyingClr(type) is { } nullableUnderlying)
        {
            return CountNullabilityBytes(nullableUnderlying);
        }

        if (type.IsGenericParameter)
        {
            return 1;
        }

        if (type.IsArray)
        {
            return 1 + CountNullabilityBytes(
                Invariant.Required(type.GetElementType(), "an array type has an element type"));
        }

        var isClosedGeneric = type.IsGenericType && !type.IsGenericTypeDefinition;
        int count = !type.IsValueType || isClosedGeneric ? 1 : 0;

        if (isClosedGeneric)
        {
            foreach (var arg in type.GetGenericArguments())
            {
                count += CountNullabilityBytes(arg);
            }
        }

        return count;
    }

    /// <summary>
    /// Returns whether a reflected generic parameter carries the CLR
    /// non-nullable value-type (<c>struct</c>) constraint.
    /// </summary>
    /// <param name="type">Reflected type to inspect.</param>
    /// <returns><see langword="true"/> for a struct-constrained generic parameter.</returns>
    internal static bool IsNotNullableValueTypeParameter(Type type)
    {
        return type.IsGenericParameter
            && (type.GenericParameterAttributes
                & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0;
    }

    /// <summary>
    /// Returns nullability flags rooted at a nested type. Scalar and empty
    /// forms are kept intact because they apply semantically to every position;
    /// physical per-position arrays are sliced to the exact subtree width.
    /// </summary>
    /// <param name="type">Nested CLR type.</param>
    /// <param name="flags">Flags for the containing type tree.</param>
    /// <param name="offset">Nested type's DFS offset.</param>
    /// <returns>Flags rooted at <paramref name="type"/>.</returns>
    internal static ImmutableArray<byte> GetNullableFlagsForSubtree(
        Type type,
        ImmutableArray<byte> flags,
        int offset)
    {
        if (flags.Length <= 1)
        {
            return flags;
        }

        return flags
            .Skip(offset)
            .Take(CountNullabilityBytes(type))
            .ToImmutableArray();
    }

    /// <summary>
    /// Expands scalar, context-only, or absent nullable metadata to the CLR
    /// per-position layout for <paramref name="type"/>. Generic value-type
    /// placeholders are emitted as oblivious byte <c>0</c>, while
    /// metadata-transparent <c>Nullable&lt;T&gt;</c> recurses directly into T.
    /// Struct-constrained generic parameters likewise force a <c>0</c> slot.
    /// Empty and missing positions use the importer's existing nullable-by-default
    /// semantics and expand to byte <c>2</c>.
    /// </summary>
    /// <param name="type">CLR type tree to expand.</param>
    /// <param name="flags">Physical nullable flags, possibly scalar or empty.</param>
    /// <returns>One byte per CLR nullable-metadata position.</returns>
    internal static ImmutableArray<byte> ExpandNullableFlags(Type type, ImmutableArray<byte> flags)
    {
        var builder = ImmutableArray.CreateBuilder<byte>(CountNullabilityBytes(type));
        var index = 0;
        Append(type);
        return builder.MoveToImmutable();

        void Append(Type current)
        {
            if (NullableLifting.GetValueTypeNullableUnderlyingClr(current) is { } nullableUnderlying)
            {
                Append(nullableUnderlying);
                return;
            }

            if (current.IsGenericParameter)
            {
                builder.Add(IsNotNullableValueTypeParameter(current) ? (byte)0 : GetFlag(index));
                index++;
                return;
            }

            if (current.IsArray)
            {
                builder.Add(GetFlag(index++));
                Append(Invariant.Required(current.GetElementType(), "an array type has an element type"));
                return;
            }

            var isClosedGeneric = current.IsGenericType && !current.IsGenericTypeDefinition;
            if (isClosedGeneric && current.IsValueType)
            {
                builder.Add(0);
                index++;
            }
            else if (!current.IsValueType)
            {
                builder.Add(GetFlag(index++));
            }

            if (isClosedGeneric)
            {
                foreach (var argument in current.GetGenericArguments())
                {
                    Append(argument);
                }
            }
        }

        byte GetFlag(int position)
        {
            if (flags.IsDefaultOrEmpty)
            {
                return 2;
            }

            if (flags.Length == 1)
            {
                return flags[0];
            }

            return position < flags.Length ? flags[position] : (byte)2;
        }
    }

    /// <summary>
    /// Issue #1354: applies the "unannotated imported reference types are nullable
    /// by default" (Kotlin-style) reading rule to a single reference-type position.
    /// Given the nullable-flags array returned by <see cref="ReadNullableFlags"/>
    /// and the DFS position <paramref name="index"/>:
    /// <list type="bullet">
    /// <item><description><paramref name="flags"/> empty (no <c>[Nullable]</c> and no
    /// <c>[NullableContext]</c> anywhere) → <b>nullable</b> (<c>T?</c>).</description></item>
    /// <item><description>A single scalar/context byte (<c>flags.Length == 1</c>) applies
    /// to <b>every</b> position: non-null iff that byte is <c>1</c>.</description></item>
    /// <item><description>A per-position array (<c>flags.Length &gt; 1</c>): non-null iff
    /// <c>flags[index] == 1</c>.</description></item>
    /// </list>
    /// Only an explicit <c>1</c> (NotAnnotated) means a non-null reference type; <c>2</c>
    /// (Annotated), <c>0</c> (oblivious) and absent all mean nullable.
    /// </summary>
    /// <param name="flags">The nullable-flags byte array (possibly empty or scalar).</param>
    /// <param name="index">The DFS position index of the reference-type position.</param>
    /// <returns><c>true</c> when the position is non-null, <c>false</c> when nullable.</returns>
    internal static bool IsPositionNonNull(ImmutableArray<byte> flags, int index)
    {
        if (flags.IsDefaultOrEmpty)
        {
            // No annotation and no context anywhere → unannotated/oblivious → nullable.
            return false;
        }

        if (flags.Length == 1)
        {
            // Scalar/context byte applies to every position.
            return flags[0] == 1;
        }

        // Per-position array: index directly; beyond-length positions are nullable.
        return index < flags.Length && flags[index] == 1;
    }

    /// <summary>
    /// Constructs a <see cref="TypeSymbol"/> for <paramref name="clrType"/> by
    /// reading the nullability byte at <paramref name="offset"/> within
    /// <paramref name="flags"/>, and (for generic or array types with further
    /// inner bytes) wrapping the result in a
    /// <see cref="NullabilityAnnotatedTypeSymbol"/>.
    /// </summary>
    /// <param name="clrType">The CLR type to map.</param>
    /// <param name="flags">The full nullable-flags byte array.</param>
    /// <param name="offset">The index within <paramref name="flags"/> where this type's byte lives.</param>
    /// <returns>The appropriately-nullified <see cref="TypeSymbol"/>.</returns>
    internal static TypeSymbol SymbolFromFlagsOffset(Type clrType, ImmutableArray<byte> flags, int offset)
    {
        if (NullableLifting.GetValueTypeNullableUnderlyingClr(clrType) is { } nullableUnderlying)
        {
            return NullableTypeSymbol.Get(
                SymbolFromFlagsOffset(nullableUnderlying, flags, offset));
        }

        var baseSymbol = TypeSymbol.FromClrType(clrType);
        if (IsNotNullableValueTypeParameter(clrType))
        {
            return baseSymbol;
        }

        // Issue #2176: pointers are not reference types — never nullable-wrap on import.
        if (clrType.IsPointer || baseSymbol is PointerTypeSymbol or FunctionPointerTypeSymbol)
        {
            return baseSymbol;
        }

        if (clrType.IsArray)
        {
            if (clrType.GetArrayRank() > 1)
            {
                var elementType = SymbolFromFlagsOffset(
                    Invariant.Required(clrType.GetElementType(), "an array type has an element type"),
                    flags,
                    offset + 1);
                var rectangular = RectangularArrayTypeSymbol.Get(elementType, clrType.GetArrayRank());
                return IsPositionNonNull(flags, offset)
                    ? rectangular
                    : NullableTypeSymbol.Get(rectangular);
            }

            TypeSymbol array = baseSymbol;
            if (CountNullabilityBytes(clrType) > 1)
            {
                array = new NullabilityAnnotatedTypeSymbol(
                    baseSymbol,
                    GetNullableFlagsForSubtree(clrType, flags, offset));
            }

            return IsPositionNonNull(flags, offset)
                ? array
                : NullableTypeSymbol.Get(array);
        }

        if (clrType.IsValueType)
        {
            if (baseSymbol is TupleTypeSymbol
                && CountNullabilityBytes(clrType) > 1)
            {
                return BuildTupleTypeSymbol(clrType, flags, offset);
            }

            // A closed generic value type carries a leading zero placeholder.
            // Keep its annotation wrapper when arguments add further positions.
            if (clrType.IsGenericType
                && !clrType.IsGenericTypeDefinition
                && CountNullabilityBytes(clrType) > 1)
            {
                return new NullabilityAnnotatedTypeSymbol(
                    baseSymbol,
                    GetNullableFlagsForSubtree(clrType, flags, offset));
            }

            return baseSymbol;
        }

        // Issue #1354: a reference position is non-null only for an explicit `1`;
        // absent / oblivious / annotated all mean nullable.
        bool isNullable = !IsPositionNonNull(flags, offset);
        TypeSymbol result = isNullable ? NullableTypeSymbol.Get(baseSymbol) : baseSymbol;

        // Propagate inner flags when the type is a closed generic.
        if (clrType.IsGenericType
            && !clrType.IsGenericTypeDefinition
            && CountNullabilityBytes(clrType) > 1)
        {
            // Slice from `offset` so that NullabilityAnnotatedTypeSymbol.NullableFlags[0]
            // is the byte for this type itself, matching the layout convention.
            var slicedFlags = GetNullableFlagsForSubtree(clrType, flags, offset);
            var annotated = new NullabilityAnnotatedTypeSymbol(baseSymbol, slicedFlags);
            result = isNullable ? (TypeSymbol)NullableTypeSymbol.Get(annotated) : annotated;
        }

        return result;
    }

    /// <summary>
    /// Decodes nullable flags described by an open metadata signature onto its
    /// reflected closed CLR type.
    /// </summary>
    /// <param name="actualType">Closed reflected type to decode.</param>
    /// <param name="layoutType">Open metadata type that defines flag positions.</param>
    /// <param name="flags">Nullable flags in <paramref name="layoutType"/> order.</param>
    /// <returns>Decoded closed type symbol.</returns>
    internal static TypeSymbol SymbolFromLayoutFlags(
        Type actualType,
        Type layoutType,
        ImmutableArray<byte> flags)
    {
        var projectedFlags = ClrTypeUtilities.AreSame(actualType, layoutType)
            ? flags
            : ProjectNullableFlags(actualType, layoutType, flags);
        return SymbolFromFlagsOffset(actualType, projectedFlags, 0);
    }

    private static TupleTypeSymbol BuildTupleTypeSymbol(
        Type clrType,
        ImmutableArray<byte> flags,
        int offset)
    {
        var elements = ImmutableArray.CreateBuilder<TypeSymbol>();
        var position = offset;
        AppendElements(clrType);
        return TupleTypeSymbol.Get(elements.ToImmutable());

        void AppendElements(Type tupleType)
        {
            position++; // Generic value-type placeholder.
            var arguments = tupleType.GetGenericArguments();
            var directCount = arguments.Length == 8 ? 7 : arguments.Length;
            for (var i = 0; i < directCount; i++)
            {
                var argument = arguments[i];
                elements.Add(SymbolFromFlagsOffset(argument, flags, position));
                position += CountNullabilityBytes(argument);
            }

            if (arguments.Length == 8)
            {
                AppendElements(arguments[7]);
            }
        }
    }

    private static TypeSymbol ApplyReferenceNullabilityFull(
        TypeSymbol baseSymbol,
        Type? clrType,
        ICustomAttributeProvider declaration,
        MemberInfo? enclosingMember,
        Type? layoutType = null)
    {
        if (clrType == null)
        {
            return baseSymbol;
        }

        var flags = ReadNullableFlags(declaration, enclosingMember);
        return layoutType == null
            ? SymbolFromFlagsOffset(clrType, flags, 0)
            : SymbolFromLayoutFlags(clrType, layoutType, flags);
    }

    private static ImmutableArray<byte> ProjectNullableFlags(
        Type actualType,
        Type layoutType,
        ImmutableArray<byte> flags)
    {
        var layoutFlags = ExpandNullableFlags(layoutType, flags);
        var builder = ImmutableArray.CreateBuilder<byte>();
        var layoutOffset = 0;
        Append(actualType, layoutType);
        return builder.ToImmutable();

        void Append(Type actual, Type layout)
        {
            if (NullableLifting.GetValueTypeNullableUnderlyingClr(actual) is { } actualUnderlying)
            {
                actual = actualUnderlying;
            }

            if (NullableLifting.GetValueTypeNullableUnderlyingClr(layout) is { } layoutUnderlying)
            {
                layout = layoutUnderlying;
            }

            if (layout.IsGenericParameter)
            {
                var flag = layoutFlags[layoutOffset++];
                builder.AddRange(
                    ExpandNullableFlags(actual, ImmutableArray.Create(flag)));
                return;
            }

            if (actual.IsArray && layout.IsArray)
            {
                builder.Add(layoutFlags[layoutOffset++]);
                Append(
                    Invariant.Required(actual.GetElementType(), "an array type has an element type"),
                    Invariant.Required(layout.GetElementType(), "an array type has an element type"));
                return;
            }

            var actualGeneric = actual.IsGenericType && !actual.IsGenericTypeDefinition;
            var layoutGeneric = layout.IsGenericType && !layout.IsGenericTypeDefinition;
            if (actualGeneric
                && layoutGeneric
                && ClrTypeUtilities.AreSame(
                    actual.GetGenericTypeDefinition(),
                    layout.GetGenericTypeDefinition()))
            {
                builder.Add(actual.IsValueType ? (byte)0 : layoutFlags[layoutOffset]);
                layoutOffset++;
                var actualArguments = actual.GetGenericArguments();
                var layoutArguments = layout.GetGenericArguments();
                for (var i = 0; i < actualArguments.Length; i++)
                {
                    Append(actualArguments[i], layoutArguments[i]);
                }

                return;
            }

            var actualCount = CountNullabilityBytes(actual);
            var layoutCount = CountNullabilityBytes(layout);
            if (actualCount > 0)
            {
                var flag = layoutCount > 0
                    ? layoutFlags[layoutOffset]
                    : (byte)1;
                builder.AddRange(
                    ExpandNullableFlags(actual, ImmutableArray.Create(flag)));
            }

            layoutOffset += layoutCount;
        }
    }

    private static MethodBase? GetMetadataDefinition(MethodBase method)
    {
        MethodBase definition = method;
        if (method is MethodInfo genericMethod
            && genericMethod.IsGenericMethod
            && !genericMethod.IsGenericMethodDefinition)
        {
            definition = genericMethod.GetGenericMethodDefinition();
        }

        var declaringType = definition.DeclaringType;
        if (declaringType == null
            || !declaringType.IsGenericType
            || declaringType.IsGenericTypeDefinition)
        {
            return definition;
        }

        var openType = declaringType.GetGenericTypeDefinition();
        var candidates = definition is ConstructorInfo
            ? openType.GetConstructors(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .Cast<MethodBase>()
            : openType.GetMethods(
                BindingFlags.Public | BindingFlags.NonPublic
                | BindingFlags.Instance | BindingFlags.Static);
        return candidates.FirstOrDefault(candidate =>
            candidate.MetadataToken == definition.MetadataToken)
            ?? definition;
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
        ref ImmutableArray<string>.Builder? builder)
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

    private static System.Collections.Generic.IList<CustomAttributeData>? SafeGetCustomAttributesData(ICustomAttributeProvider provider)
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
