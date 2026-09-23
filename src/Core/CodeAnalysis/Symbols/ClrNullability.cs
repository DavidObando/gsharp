// <copyright file="ClrNullability.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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
    private const string NotNullIfNotNullAttributeFullName = "System.Diagnostics.CodeAnalysis.NotNullIfNotNullAttribute";

    /// <summary>
    /// Issue #3802: cache of the parameter names carried by
    /// <c>[return: NotNullIfNotNull(...)]</c> per method. Reading custom
    /// attribute data through a <see cref="MetadataLoadContext"/> is expensive
    /// and every imported call site asks the same question, so the answer is
    /// memoised. An empty array means "no conditional post-condition".
    /// </summary>
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<MethodInfo, string[]> NotNullIfNotNullCache = new();

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
        if (property.PropertyType.IsByRef)
        {
            // PropertyType.IsByRef guarantees that GetElementType returns the referent type.
            return ByRefTypeSymbol.Get(GetPropertyElementTypeSymbol(property, property.PropertyType.GetElementType()!));
        }

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
        // ReturnType.IsByRef guarantees a non-null reflected element type on that branch.
        var returnType = method.ReturnType.IsByRef ? method.ReturnType.GetElementType()! : method.ReturnType;
        var baseSymbol = TypeSymbol.FromClrType(returnType);
        var definition = GetMetadataDefinition(method) as MethodInfo;
        var layoutType = definition?.ReturnType;
        if (layoutType?.IsByRef == true)
        {
            layoutType = layoutType.GetElementType();
        }

        // ADR-0172 Phase B: surface imported tuple element names.
        var result = TupleElementNamesReader.ApplyNames(
            ApplyReferenceNullabilityFull(
                baseSymbol,
                returnType,
                method.ReturnParameter,
                method,
                layoutType),
            method.ReturnParameter);
        return method.ReturnType.IsByRef ? ByRefTypeSymbol.Get(result) : result;
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

    /// <summary>
    /// Issue #3802: collects the parameter names named by every
    /// <c>[return: NotNullIfNotNull(name)]</c> on <paramref name="method"/>.
    /// The attribute states a CONDITIONAL post-condition — the (declared
    /// nullable) return value is non-null whenever the named argument is
    /// non-null — so this reader deliberately reports only the names. Deciding
    /// whether the post-condition actually holds is a fact about a particular
    /// call site's arguments and belongs with the binder's narrowing
    /// machinery, not with the declaration reader: narrowing the DECLARED
    /// return type here would restore the very unsoundness that #3705 family 2
    /// removed.
    /// </summary>
    /// <param name="method">The method to inspect.</param>
    /// <returns>
    /// The named parameters, in attribute order; empty when the method carries
    /// no conditional return post-condition.
    /// </returns>
    internal static IReadOnlyList<string> GetNotNullIfNotNullParameters(MethodInfo method)
    {
        if (NotNullIfNotNullCache.TryGetValue(method, out var cached))
        {
            return cached;
        }

        var names = ReadNotNullIfNotNullParameters(method);
        NotNullIfNotNullCache.AddOrUpdate(method, names);
        return names;
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
    /// Empty and missing positions use the importer's current reading rule and
    /// expand to <see cref="DefaultAbsentFill"/> — byte <c>0</c> (oblivious)
    /// under ADR-0186's platform-types mode, which is the default since step 3,
    /// and byte <c>2</c> (nullable-by-default, ADR-0136) under
    /// <c>--nullability=enabled</c>.
    /// </summary>
    /// <param name="type">CLR type tree to expand.</param>
    /// <param name="flags">Physical nullable flags, possibly scalar or empty.</param>
    /// <returns>One byte per CLR nullable-metadata position.</returns>
    internal static ImmutableArray<byte> ExpandNullableFlags(Type type, ImmutableArray<byte> flags)
        => ExpandNullableFlags(type, flags, absentFill: DefaultAbsentFill());

    /// <summary>
    /// Issue #3705 family 2: <see cref="ExpandNullableFlags(Type, ImmutableArray{byte})"/>
    /// with an explicit fill for positions the declaration did not supply.
    /// <para>
    /// The fill the two-argument overload chooses IS the reading rule. Under
    /// <c>--nullability=enabled</c> it is <c>2</c> — the #1354 rule, "the
    /// declarer said nothing, so assume nullable" — and under ADR-0186's
    /// platform-types mode, the default since step 3, it is <c>0</c>
    /// (see <see cref="DefaultAbsentFill"/>). Either way it is right for a
    /// concrete reference position and wrong for an OPEN type-parameter
    /// position, whose nullability comes from the substituted argument
    /// instead. A caller that must distinguish "the declaration explicitly
    /// said <c>2</c>" from "the declaration was silent and the ADR-0136
    /// reading defaulted it to <c>2</c>" cannot do it from the default
    /// expansion, because both look identical. Passing <c>absentFill: 0</c>
    /// yields the literal reading in either mode.
    /// </para>
    /// <para>
    /// A scalar or context byte is a genuine statement about every position and
    /// is preserved under both fills; only truly absent and beyond-length
    /// positions differ.
    /// </para>
    /// </summary>
    /// <param name="type">CLR type tree to expand.</param>
    /// <param name="flags">Physical nullable flags, possibly scalar or empty.</param>
    /// <param name="absentFill">Byte to use for positions the declaration did not supply.</param>
    /// <returns>One byte per CLR nullable-metadata position.</returns>
    internal static ImmutableArray<byte> ExpandNullableFlags(
        Type type,
        ImmutableArray<byte> flags,
        byte absentFill)
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
                return absentFill;
            }

            if (flags.Length == 1)
            {
                return flags[0];
            }

            return position < flags.Length ? flags[position] : absentFill;
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
    /// (Annotated), <c>0</c> (oblivious) and absent are all NOT non-null.
    /// <para>
    /// ADR-0186 §2: this predicate is now a projection of
    /// <see cref="ClassifyPosition"/>, which is the real reader. It survives
    /// because "is this position non-null?" is a question several callers
    /// genuinely only need a <c>bool</c> for, and its answer is unchanged — but
    /// it is no longer sufficient on its own, because <c>false</c> now covers
    /// two different declarations (<c>T?</c> and <c>T!</c>). A caller that
    /// needs to tell them apart must ask <see cref="ClassifyPosition"/>.
    /// </para>
    /// </summary>
    /// <param name="flags">The nullable-flags byte array (possibly empty or scalar).</param>
    /// <param name="index">The DFS position index of the reference-type position.</param>
    /// <returns><c>true</c> when the position is explicitly non-null.</returns>
    internal static bool IsPositionNonNull(ImmutableArray<byte> flags, int index)
        => ClassifyPosition(flags, index) == ClrNullabilityState.NotAnnotated;

    /// <summary>
    /// ADR-0186 §2 — <b>the</b> three-state classifier, and the successor to
    /// <see cref="IsFlagNonNull"/>'s two-valued answer. Maps the DFS position
    /// <paramref name="index"/> within <paramref name="flags"/> onto what the
    /// declarer actually said about it:
    /// <list type="table">
    /// <listheader><term><paramref name="flags"/> shape</term><description>Result</description></listheader>
    /// <item><term>empty (no <c>[Nullable]</c>, no <c>[NullableContext]</c> anywhere)</term>
    /// <description><see cref="ClrNullabilityState.Oblivious"/></description></item>
    /// <item><term>length 1, <c>flags[0] == 0</c> (oblivious context)</term>
    /// <description><see cref="ClrNullabilityState.Oblivious"/></description></item>
    /// <item><term>length 1, <c>flags[0] == 1</c></term>
    /// <description><see cref="ClrNullabilityState.NotAnnotated"/></description></item>
    /// <item><term>length 1, <c>flags[0] == 2</c></term>
    /// <description><see cref="ClrNullabilityState.Annotated"/></description></item>
    /// <item><term>length &gt; 1, <c>flags[index] == 0</c></term>
    /// <description><see cref="ClrNullabilityState.Oblivious"/></description></item>
    /// <item><term>length &gt; 1, <c>flags[index] == 1</c></term>
    /// <description><see cref="ClrNullabilityState.NotAnnotated"/></description></item>
    /// <item><term>length &gt; 1, <c>flags[index] == 2</c></term>
    /// <description><see cref="ClrNullabilityState.Annotated"/></description></item>
    /// <item><term>length &gt; 1, <c>index</c> beyond the array</term>
    /// <description><see cref="ClrNullabilityState.Oblivious"/> — the declaration
    /// supplied no byte for this position, which is the same statement as
    /// supplying none at all</description></item>
    /// </list>
    /// <para>
    /// A scalar/context byte is a genuine statement about <em>every</em>
    /// position, so it is classified directly rather than treated as absent.
    /// </para>
    /// </summary>
    /// <param name="flags">The nullable-flags byte array (possibly empty or scalar).</param>
    /// <param name="index">The DFS position index of the reference-type position.</param>
    /// <returns>What the declaration says about that position.</returns>
    internal static ClrNullabilityState ClassifyPosition(ImmutableArray<byte> flags, int index)
    {
        if (flags.IsDefaultOrEmpty)
        {
            // No annotation and no context anywhere → the declarer said nothing.
            return ClrNullabilityState.Oblivious;
        }

        if (flags.Length == 1)
        {
            // Scalar/context byte applies to every position.
            return ClassifyFlag(flags[0]);
        }

        // Per-position array: index directly; beyond-length positions were
        // never described, which is obliviousness by another route.
        return index < flags.Length
            ? ClassifyFlag(flags[index])
            : ClrNullabilityState.Oblivious;
    }

    /// <summary>
    /// ADR-0186 §2: maps one C# nullable-metadata byte onto what it says. The
    /// per-byte half of <see cref="ClassifyPosition"/>, kept separate because
    /// <c>NullableFlagsBuilder</c> reads bytes out of an already-expanded array
    /// and so has no position to classify.
    /// <para>
    /// Any byte other than <c>1</c> or <c>2</c> is <see cref="ClrNullabilityState.Oblivious"/>.
    /// That is not leniency: <c>0</c> <em>is</em> the oblivious byte, and csc
    /// emits no other value, so an unexpected byte can only mean the reader has
    /// been handed something it cannot interpret — for which "the declarer said
    /// nothing" is the honest reading and the safe one.
    /// </para>
    /// </summary>
    /// <param name="flag">A single C# nullable-metadata byte (0, 1 or 2).</param>
    /// <returns>What that byte says.</returns>
    internal static ClrNullabilityState ClassifyFlag(byte flag) => flag switch
    {
        1 => ClrNullabilityState.NotAnnotated,
        2 => ClrNullabilityState.Annotated,
        _ => ClrNullabilityState.Oblivious,
    };

    /// <summary>
    /// ADR-0186 §2: the single place that turns a
    /// <see cref="ClrNullabilityState"/> into a G# type, and therefore the single
    /// cell of ADR-0136's table that this ADR changes.
    /// <list type="bullet">
    /// <item><description><see cref="ClrNullabilityState.NotAnnotated"/> → <c>T</c>.</description></item>
    /// <item><description><see cref="ClrNullabilityState.Annotated"/> → <c>T?</c>.</description></item>
    /// <item><description><see cref="ClrNullabilityState.Oblivious"/> → <c>T!</c>
    /// under <see cref="NullabilityMode.PlatformTypes"/>, and <c>T?</c>
    /// otherwise — ADR-0136's answer, which is what keeps
    /// <c>--nullability=platform-types</c> a genuine no-op while it is off.</description></item>
    /// </list>
    /// </summary>
    /// <param name="baseSymbol">The unwrapped position type.</param>
    /// <param name="state">What the declaration says about the position.</param>
    /// <returns>The nullability-aware type symbol.</returns>
    internal static TypeSymbol SymbolForState(TypeSymbol baseSymbol, ClrNullabilityState state) => state switch
    {
        ClrNullabilityState.NotAnnotated => baseSymbol,
        ClrNullabilityState.Annotated => NullableTypeSymbol.Get(baseSymbol),
        _ => NullabilityOptions.PlatformTypesEnabled
            ? PlatformTypeSymbol.Get(baseSymbol)
            : NullableTypeSymbol.Get(baseSymbol),
    };

    /// <summary>
    /// Issue #1354, issue #3705 family 2 — <b>the</b> predicate that turns one
    /// C# nullable-metadata byte into G#'s answer, and the only place in the
    /// compiler allowed to decide it.
    /// <para>
    /// G#'s import rule is the inverse of C#'s. C# reads "nullable iff the byte
    /// is <c>2</c>", so oblivious (<c>0</c>) and absent metadata mean non-null.
    /// G# reads "non-null iff the byte is <c>1</c>", so oblivious <b>and</b>
    /// absent both mean <c>T?</c>. Two readers open-coding the two rules is
    /// exactly how the #3705 nullability family kept producing member kinds
    /// that disagreed about the same declaration, so the rule lives here and
    /// <see cref="IsPositionNonNull"/> and
    /// <c>NullableFlagsBuilder.MergeDeclarationNullability</c> both defer to it
    /// rather than comparing bytes themselves.
    /// </para>
    /// <para>
    /// ADR-0186 §2 preserves that single-predicate principle and gives it a
    /// third value: the byte classifier is now <see cref="ClassifyFlag"/> and
    /// this predicate is a projection of it. G#'s rule "non-null iff the byte
    /// is <c>1</c>" is unchanged; what changed is that the <em>other</em> two
    /// answers are no longer the same answer, because <c>0</c>/absent means
    /// <c>T!</c> and only <c>2</c> means <c>T?</c>.
    /// </para>
    /// </summary>
    /// <param name="flag">A single C# nullable-metadata byte (0, 1 or 2).</param>
    /// <returns><c>true</c> only for <c>1</c> (not-annotated).</returns>
    internal static bool IsFlagNonNull(byte flag) => ClassifyFlag(flag) == ClrNullabilityState.NotAnnotated;

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
                return SymbolForState(rectangular, ClassifyPosition(flags, offset));
            }

            TypeSymbol array = baseSymbol;
            if (CountNullabilityBytes(clrType) > 1)
            {
                array = new NullabilityAnnotatedTypeSymbol(
                    baseSymbol,
                    GetNullableFlagsForSubtree(clrType, flags, offset));
            }

            return SymbolForState(array, ClassifyPosition(flags, offset));
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

        // Issue #1354: a reference position is non-null only for an explicit `1`.
        // ADR-0186 §2: the other two bytes are no longer the same answer —
        // `2` is `T?` and `0`/absent is `T!`. `SymbolForState` is where that
        // one changed cell lives, and while `--nullability=platform-types` is
        // off it still returns ADR-0136's `T?` for both.
        var state = ClassifyPosition(flags, offset);
        TypeSymbol result = SymbolForState(baseSymbol, state);

        // Propagate inner flags when the type is a closed generic.
        if (clrType.IsGenericType
            && !clrType.IsGenericTypeDefinition
            && CountNullabilityBytes(clrType) > 1)
        {
            // Slice from `offset` so that NullabilityAnnotatedTypeSymbol.NullableFlags[0]
            // is the byte for this type itself, matching the layout convention.
            var slicedFlags = GetNullableFlagsForSubtree(clrType, flags, offset);
            var annotated = new NullabilityAnnotatedTypeSymbol(baseSymbol, slicedFlags);
            result = SymbolForState(annotated, state);
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

    /// <summary>
    /// ADR-0186 §2: returns the byte an absent position expands to, which is
    /// not a detail but <b>the rule itself</b> written as a value.
    /// <para>
    /// ADR-0136 says an absent position means <c>T?</c>, so the fill is
    /// <c>2</c>. ADR-0186 says it means <c>T!</c>, so under
    /// <see cref="NullabilityMode.PlatformTypes"/> the fill becomes <c>0</c> —
    /// the oblivious byte, which <see cref="ClassifyPosition"/> then reads as
    /// <see cref="ClrNullabilityState.Oblivious"/>.
    /// </para>
    /// <para>
    /// This must track the mode, and an implementer who leaves it at <c>2</c>
    /// gets a silent drift rather than a failure: the layout/projection paths
    /// (<see cref="SymbolFromLayoutFlags"/> → <c>ProjectNullableFlags</c>, and
    /// <c>NullableFlagsBuilder.MergeDeclarationNullability</c>'s
    /// <c>declaredFlags</c>) would expand an absent byte to <c>2</c> and read
    /// the position as <c>T?</c>, while the direct path
    /// (<see cref="SymbolFromFlagsOffset"/> over the raw flags) reads the very
    /// same declaration as <c>T!</c>. Two readers disagreeing about one
    /// declaration is precisely the #3705 family-2 defect ADR-0136's
    /// single-predicate rule exists to prevent, and ADR-0186 explicitly
    /// preserves that rule.
    /// </para>
    /// <para>
    /// Platform-types is the default since ADR-0186 step 3, so <c>0</c> is the
    /// ordinary answer. Under <c>--nullability=enabled</c> this is the literal
    /// constant <c>2</c> the two-argument overload always used, so that mode
    /// keeps ADR-0136's reading unchanged.
    /// </para>
    /// </summary>
    /// <returns>The fill byte for positions the declaration did not supply.</returns>
    private static byte DefaultAbsentFill()
        => NullabilityOptions.PlatformTypesEnabled ? (byte)0 : (byte)2;

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

        // Two expansions with DIFFERENT absent fills, used only to answer one
        // question the single expansion cannot: did the declaration actually
        // DESCRIBE this position, or did the expansion invent a byte for it?
        // A position the declaration described expands to the same byte under
        // both fills; one it did not expands to the fill itself, so the two
        // disagree. The open-type-parameter arm below is the only consumer,
        // and the distinction is load-bearing there — see the comment at the
        // arm.
        var describedLow = ExpandNullableFlags(layoutType, flags, absentFill: 1);
        var describedHigh = ExpandNullableFlags(layoutType, flags, absentFill: 2);
        var builder = ImmutableArray.CreateBuilder<byte>();
        var layoutOffset = 0;
        Append(actualType, layoutType);
        return builder.ToImmutable();

        bool LayoutDescribed(int position) => describedLow[position] == describedHigh[position];

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

                // ADR-0186 §2's open-type-parameter carve-out, applied to the
                // PROJECTION path — "Open type parameters keep ADR-0136's
                // exclusion, unchanged. An open slot still widens only for an
                // explicit `[Nullable(2)]`."
                //
                // This arm stamps the byte the OPEN declaration carries onto
                // the SUBSTITUTED argument, which is exactly what §2 says must
                // not happen for anything but an explicit `2`. Under ADR-0136
                // the mis-stamp was invisible: it produced `T?`, and
                // `Conversion.ClassifyCore` strips inner nullability before
                // any rule runs, so nothing downstream could tell. Under
                // ADR-0186 it produces `T!`, which §3 rule 3 treats as a
                // genuinely different constructed type — and the mis-stamp
                // becomes a compile error on ordinary code.
                //
                // Measured, twice, both reduced from the self-migration guard
                // and from `samples/`:
                //
                //   let a = t.GetConstructors().Cast[MethodBase]()
                //   let b = cast[IEnumerable[MethodBase]](t.GetMethods())
                //   let c = if true { a } else { b }
                //   // GS0263: "branches have no common result type — the true
                //   // branch is 'IEnumerable[MethodBase]' and the false branch
                //   // is 'IEnumerable[MethodBase]'"
                //
                // `Enumerable.Cast<TResult>`'s return carries byte `0` at its
                // unconstrained `TResult` slot (csc's encoding for an open
                // parameter that may be a value type), so `a` came back as
                // `IEnumerable[MethodBase!]` — obliviousness invented for a
                // position whose nullability arrives with the ARGUMENT, and a
                // diagnostic that names one type twice because a nested
                // argument's `!` does not reach the display.
                // `Dictionary[string, int32].Enumerator` in
                // `samples/NestedTypeOfConstructedGeneric.gs` is the same
                // defect through the enclosing type's arguments.
                //
                // Gated on the mode, and that is deliberate rather than
                // timid: with `--nullability=enabled` the fabricated byte is
                // `2`, which is the answer ADR-0136 has given for its whole
                // life and which several emit and read paths are pinned to.
                // Changing it there would be an ADR-0136 semantics change
                // smuggled into an ADR-0186 step. Under platform types the
                // fabrication is observable, so §2's rule is applied and the
                // argument is left to speak for itself.
                //
                // Gated on `LayoutDescribed` too, and THAT distinction is the
                // whole correctness of this arm. Two different declarations
                // reach here with byte `0` at an open slot and they mean
                // opposite things:
                //
                //   * `Enumerable.Cast<TResult>` in the ANNOTATED BCL carries
                //     an EXPLICIT `0` there — csc's encoding for an
                //     unconstrained parameter that may be a value type. The
                //     declaration described the slot and did not say `T?`, so
                //     §2 applies and the caller's argument wins.
                //   * A method in a `#nullable disable` assembly carries NO
                //     nullable metadata at all, and the `0` is this
                //     expansion's own fill. The declaration described
                //     nothing, which is obliviousness in the ordinary sense,
                //     and §2's table says that reads as `T!`.
                //
                // Collapsing the two re-broke issue #4322 — a `nil` tuple
                // element stopped widening through an oblivious `params T[]`
                // again, because the element came back non-null instead of
                // `T!`. Both directions are pinned:
                // `Issue4044NilTupleInferenceTests` for the absent case and
                // `Adr0186_AnOpenSlot_TakesItsNullabilityFromTheArgument`
                // for the explicit one.
                if (NullabilityOptions.PlatformTypesEnabled
                    && LayoutDescribed(layoutOffset - 1)
                    && ClassifyFlag(flag) != ClrNullabilityState.Annotated)
                {
                    flag = 1;
                }

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

    private static string[] ReadNotNullIfNotNullParameters(MethodInfo method)
    {
        // Prefer the open metadata definition: on a constructed generic the
        // reflected `ReturnParameter` may not surface the attribute data.
        var definition = GetMetadataDefinition(method) as MethodInfo ?? method;
        var names = ReadNotNullIfNotNullParameters(definition.ReturnParameter);
        if (names.Length == 0 && !ReferenceEquals(definition, method))
        {
            names = ReadNotNullIfNotNullParameters(method.ReturnParameter);
        }

        return names;
    }

    private static string[] ReadNotNullIfNotNullParameters(ParameterInfo? returnParameter)
    {
        if (returnParameter == null)
        {
            return Array.Empty<string>();
        }

        var attrs = SafeGetCustomAttributesData(returnParameter);
        if (attrs == null)
        {
            return Array.Empty<string>();
        }

        ImmutableArray<string>.Builder? builder = null;
        foreach (var ad in attrs)
        {
            if (ad.AttributeType?.FullName != NotNullIfNotNullAttributeFullName
                || ad.ConstructorArguments.Count == 0)
            {
                continue;
            }

            foreach (var arg in ad.ConstructorArguments)
            {
                CollectStringOrArray(arg, ref builder);
            }
        }

        return builder == null ? Array.Empty<string>() : builder.ToArray();
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
