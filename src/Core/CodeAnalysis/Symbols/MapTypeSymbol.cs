// <copyright file="MapTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Runtime.CompilerServices;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a G# map type <c>map[K,V]</c>.
/// </summary>
/// <remarks>
/// ADR-0104 (supersedes Phase 3.A.4 Go-flavored <c>map[K]V</c>) — backing
/// representation is the CLR
/// <c>System.Collections.Generic.Dictionary&lt;K, V&gt;</c>. The literal
/// form <c>map[K,V]{k: v, …}</c> populates a freshly allocated dictionary;
/// <c>m[k]</c> indexes it; the <c>delete(m, k)</c> built-in removes a
/// key; <c>len(m)</c> returns <c>Count</c>. Instances are cached per
/// <c>(K, V)</c> pair so identical map types compare by reference.
/// </remarks>
public sealed class MapTypeSymbol : TypeSymbol
{
    /// <summary>The full name of the CLR type a <c>map[K, V]</c> IS (ADR-0104).</summary>
    private const string DictionaryFullName = "System.Collections.Generic.Dictionary`2";

    private static readonly ConcurrentDictionary<(TypeSymbol, TypeSymbol), MapTypeSymbol> Cache = new();

    /// <summary>
    /// Issue #4023: per-reference-context projectors, registered by
    /// <see cref="ReferenceResolver"/> for every assembly it loaded. Keyed
    /// weakly by <see cref="Assembly"/> exactly as
    /// <see cref="ImportedTypeSymbol"/>'s own cache is, so a disposed
    /// <see cref="System.Reflection.MetadataLoadContext"/>'s entries become
    /// collectable on their own and one live compilation can never be
    /// deprived of its projector by another's disposal.
    /// </summary>
    private static readonly ConditionalWeakTable<Assembly, Func<Type?, Type?>> ReferenceProjectors = new();

    private MapTypeSymbol(TypeSymbol keyType, TypeSymbol valueType)

        // TypeSymbol's legacy CLR-type constructor accepts null for symbolic
        // same-compilation key/value types.
        : base($"map[{keyType.Name},{valueType.Name}]", MakeClrType(keyType, valueType))
    {
        KeyType = keyType;
        ValueType = valueType;
    }

    /// <summary>Gets the key type.</summary>
    public TypeSymbol KeyType { get; }

    /// <summary>Gets the value type.</summary>
    public TypeSymbol ValueType { get; }

    /// <summary>
    /// Gets or creates the map type symbol for the given key and value types.
    /// </summary>
    /// <param name="keyType">The key type.</param>
    /// <param name="valueType">The value type.</param>
    /// <returns>The cached <see cref="MapTypeSymbol"/>.</returns>
    public static MapTypeSymbol Get(TypeSymbol keyType, TypeSymbol valueType)
    {
        if (keyType == null)
        {
            throw new ArgumentNullException(nameof(keyType));
        }

        if (valueType == null)
        {
            throw new ArgumentNullException(nameof(valueType));
        }

        return Cache.GetOrAdd((keyType, valueType), k => new MapTypeSymbol(k.Item1, k.Item2));
    }

    /// <summary>
    /// Issue #3987: recognizes a map-shaped type by SHAPE rather than by
    /// spelling — G#'s own <see cref="MapTypeSymbol"/>, or the
    /// <c>System.Collections.Generic.Dictionary&lt;K, V&gt;</c> it IS
    /// (ADR-0104 identity) arriving from metadata as an
    /// <see cref="ImportedTypeSymbol"/>.
    /// </summary>
    /// <remarks>
    /// The direct analogue of <see cref="ChannelTypeSymbol.TryGetChannelShape"/>
    /// and <see cref="SequenceTypeSymbol.TryGetEnumerableInterfaceShape"/>, and
    /// it exists for the same reason: with CLOSED key/value types the two
    /// spellings are already identity because <c>Conversion</c> compares their
    /// <see cref="TypeSymbol.ClrType"/>s, but the moment one of them is open
    /// those <c>ClrType</c>s stop identifying the types — this side's is null,
    /// and the imported side's is the ADR-0004 type-ERASED
    /// <c>Dictionary&lt;object, object&gt;</c> — so the comparison has nothing
    /// left it can trust. Which name the author (or the metadata) happened to
    /// use is not a fact about the type.
    /// </remarks>
    /// <param name="type">The candidate type.</param>
    /// <param name="keyType">The recovered key type.</param>
    /// <param name="valueType">The recovered value type.</param>
    /// <returns>True when <paramref name="type"/> is map-shaped.</returns>
    public static bool TryGetMapShape(
        TypeSymbol? type,
        [NotNullWhen(true)] out TypeSymbol? keyType,
        [NotNullWhen(true)] out TypeSymbol? valueType)
    {
        keyType = null;
        valueType = null;

        switch (type)
        {
            case null:
                return false;
            case NullabilityAnnotatedTypeSymbol annotated:
                return TryGetMapShape(annotated.BaseType, out keyType, out valueType);
            case MapTypeSymbol map:
                keyType = map.KeyType;
                valueType = map.ValueType;
                return true;
            case ImportedTypeSymbol imported:
            {
                var open = imported.OpenDefinition;
                if (open == null && imported.ClrType is { IsGenericType: true } closed)
                {
                    open = closed.GetGenericTypeDefinition();
                }

                if (open?.FullName != DictionaryFullName)
                {
                    return false;
                }

                if (imported.TypeArguments.Length == 2)
                {
                    keyType = imported.TypeArguments[0];
                    valueType = imported.TypeArguments[1];
                    return true;
                }

                if (imported.ClrType is { IsGenericType: true } closedShape)
                {
                    var arguments = closedShape.GetGenericArguments();
                    if (arguments.Length != 2)
                    {
                        return false;
                    }

                    keyType = FromClrType(arguments[0]);
                    valueType = FromClrType(arguments[1]);
                    return keyType != null && valueType != null;
                }

                return false;
            }

            default:
                return false;
        }
    }

    /// <summary>
    /// Removes all entries from the static type cache. Called by
    /// <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects backed by a disposed metadata load context
    /// that would otherwise pin the context's memory indefinitely.
    /// </summary>
    internal static void ClearCache() => Cache.Clear();

    /// <summary>
    /// Issue #4023: registers the projector that maps a host CLR
    /// <see cref="Type"/> into the reflection context <paramref name="assembly"/>
    /// belongs to (<see cref="ReferenceResolver.MapClrTypeToReferences"/>), so
    /// <see cref="MakeClrType"/> can build a map's backing
    /// <c>Dictionary&lt;K, V&gt;</c> in the SAME context as an imported key or
    /// value rather than in the host's, where the two cannot be mixed.
    /// </summary>
    /// <param name="assembly">An assembly the registering resolver loaded.</param>
    /// <param name="project">The resolver's host-to-context type projector.</param>
    internal static void RegisterReferenceProjector(Assembly assembly, Func<Type?, Type?> project)
    {
        if (assembly == null || project == null)
        {
            return;
        }

        ReferenceProjectors.AddOrUpdate(assembly, project);
    }

    /// <summary>
    /// Issue #4023: the erasure counterpart of <see cref="MakeClrType"/>, for
    /// <c>MemberLookup</c>'s map arm. Given two ALREADY-ERASED CLR types, at
    /// least one of which came from a reference context, answers a
    /// member-resolvable <c>Dictionary&lt;K, V&gt;</c> built entirely inside
    /// that context, or <see langword="null"/> when the context cannot be
    /// identified. The caller keeps the host construction as its fallback, so
    /// this only ever UPGRADES an erasure that would otherwise be a
    /// member-less <c>TypeBuilderInstantiation</c>.
    /// </summary>
    /// <param name="keyClrType">The erased key CLR type.</param>
    /// <param name="valueClrType">The erased value CLR type.</param>
    /// <returns>The context-correct closed dictionary, or <see langword="null"/>.</returns>
    internal static Type? TryMakeErasedClrTypeInReferenceContext(Type keyClrType, Type valueClrType)
        => keyClrType == null || valueClrType == null
            ? null
            : TryMakeClrTypeInReferenceContext(
                keyClrType,
                keyIsNullableValueType: false,
                valueClrType,
                valueIsNullableValueType: false);

    private static Type? MakeClrType(TypeSymbol keyType, TypeSymbol valueType)
    {
        if (keyType.ClrType == null || valueType.ClrType == null)
        {
            return null;
        }

        // Issue #4035: a `NullableTypeSymbol` passes its UNDERLYING type's
        // `ClrType` straight through — `int32?.ClrType` is `System.Int32`, not
        // `System.Nullable<System.Int32>` — because for a nullable REFERENCE
        // type the annotation has no distinct runtime type and emit treats the
        // underlying as the runtime type. Reading `ClrType` here therefore
        // backed a `map[K, V?]` over a nullable VALUE type with
        // `Dictionary<K, V>` while the literal, the indexer's `out` slot and
        // the loop variable all carried a `Nullable<V>`: the program compiled
        // clean and then failed ilverify with `StackUnexpected` and threw
        // `InvalidProgramException` at runtime. `GetEffectiveClrType` is the
        // correction the compiler already applies for exactly this — it is
        // what `SequenceTypeSymbol.MakeClrType` and
        // `AsyncSequenceTypeSymbol.MakeClrType` read — and the map's
        // construction simply never called it.
        var keyClrType = NullableLifting.GetEffectiveClrType(keyType);
        var valueClrType = NullableLifting.GetEffectiveClrType(valueType);
        if (keyClrType == null || valueClrType == null)
        {
            return null;
        }

        if (keyClrType.IsRuntimeProvidedType() && valueClrType.IsRuntimeProvidedType())
        {
            return typeof(Dictionary<,>).MakeGenericType(keyClrType, valueClrType);
        }

        // Issue #4023: `typeof(Dictionary<,>)` is a host `RuntimeType`, and
        // `RuntimeType.MakeGenericType` answers a real `RuntimeType` only when
        // EVERY type argument is one too. A key or value resolved through the
        // compilation's `MetadataLoadContext` — which is every imported type,
        // `ImportedBase` and `DateTime` and `List[int32]` alike — makes it
        // answer a `System.Reflection.Emit.TypeBuilderInstantiation` instead,
        // whose `GetMethod`, `GetProperty` and `GetConstructor` all throw
        // `NotSupportedException`. That stand-in is NOT null, so every
        // `ClrType != null` gate downstream took it for a reflectable
        // dictionary and the map silently lost its whole BCL member surface:
        // `.Count` and `.Clear()` reported the internal error GS9998,
        // `.Remove` / `.ContainsKey` / `.ContainsValue` / `.Add` /
        // `.TryGetValue` reported GS0159, `.Keys` / `.Values` reported GS0158,
        // and `for k, v in m` reported GS9998 — while the `Dictionary[K, V]`
        // spelling of the SAME type (ADR-0104 says they ARE the same type)
        // kept every one of them.
        //
        // Build it in the key/value's OWN reflection context instead, which is
        // exactly what the `Dictionary[K, V]` spelling does and why that one
        // works: project the open `Dictionary<,>` and both arguments through
        // the registering resolver's `MapClrTypeToReferences` so all three
        // come from one context, and `MakeGenericType` answers a genuine,
        // member-resolvable constructed type.
        //
        // Issue #4035: the `Nullable<>` wrapper has to be built in that same
        // context, from the UNDERLYING type, rather than handed down already
        // constructed. `GetEffectiveClrType` builds it with the HOST
        // `typeof(Nullable<>)`, so for a `map[string, DateTime?]` — whose
        // underlying `DateTime` is a `MetadataLoadContext` type — it answers
        // the very `TypeBuilderInstantiation` stand-in #4023 is about, and one
        // handed to `MakeGenericType` below (or to `carrier.Assembly` above)
        // cannot name its own context. Pass the underlying and a flag instead,
        // and project the open `Nullable<>` alongside the open `Dictionary<,>`.
        return TryMakeClrTypeInReferenceContext(
            keyType.ClrType,
            IsNullableValueType(keyType),
            valueType.ClrType,
            IsNullableValueType(valueType));
    }

    /// <summary>
    /// Issue #4035: whether <paramref name="type"/> is a nullable VALUE type,
    /// the case whose backing dictionary argument must be
    /// <c>Nullable&lt;T&gt;</c> rather than the bare underlying <c>T</c>. A
    /// nullable REFERENCE type is deliberately excluded: its annotation has no
    /// distinct runtime type, so <c>map[string, string?]</c> is — correctly —
    /// backed by <c>Dictionary&lt;string, string&gt;</c>.
    /// </summary>
    /// <param name="type">The key or value type symbol.</param>
    /// <returns><see langword="true"/> for a nullable value type.</returns>
    private static bool IsNullableValueType(TypeSymbol type)
        => type is NullableTypeSymbol { UnderlyingType.ClrType.IsValueType: true };

    /// <summary>
    /// Issue #4023: builds the backing <c>Dictionary&lt;K, V&gt;</c> inside the
    /// reflection context that <paramref name="keyClrType"/> /
    /// <paramref name="valueClrType"/> came from, or <see langword="null"/>
    /// when no projector is registered for that context or the projection does
    /// not produce a member-resolvable type.
    /// </summary>
    /// <remarks>
    /// Returning <see langword="null"/> is always safe: a <c>map[K, V]</c> with
    /// no CLR type is the compiler's long-standing symbolic shape — what a map
    /// over a type parameter or a same-compilation class has — and the emitter
    /// reifies its member refs from the symbols
    /// (<c>ImportedMemberRefFactory.TryNormalizeToSymbolicContainer</c>'s map
    /// arm, <c>GetMapCtorReference</c> and friends).
    /// </remarks>
    /// <param name="keyClrType">The key's UNDERLYING CLR type; non-null by the caller's check.</param>
    /// <param name="keyIsNullableValueType">Whether the key is a nullable value type, so its projected form must be wrapped in the context's <c>Nullable&lt;&gt;</c> (issue #4035).</param>
    /// <param name="valueClrType">The value's UNDERLYING CLR type; non-null by the caller's check.</param>
    /// <param name="valueIsNullableValueType">Whether the value is a nullable value type, as <paramref name="keyIsNullableValueType"/>.</param>
    /// <returns>The context-correct closed dictionary type, or <see langword="null"/>.</returns>
    private static Type? TryMakeClrTypeInReferenceContext(
        Type keyClrType,
        bool keyIsNullableValueType,
        Type valueClrType,
        bool valueIsNullableValueType)
    {
        // Whichever side is NOT host-provided names the context both must be
        // projected into; when both are, the caller already took the host path.
        var carrier = keyClrType.IsRuntimeProvidedType() ? valueClrType : keyClrType;
        if (carrier.Assembly is not { } carrierAssembly
            || !ReferenceProjectors.TryGetValue(carrierAssembly, out var project))
        {
            return null;
        }

        try
        {
            var openDefinition = project(typeof(Dictionary<,>));
            var projectedKey = project(keyClrType);
            var projectedValue = project(valueClrType);
            if (openDefinition == null || projectedKey == null || projectedValue == null)
            {
                return null;
            }

            // Issue #4035: wrap INSIDE the context. A host-built
            // `Nullable<contextDateTime>` is the same unreflectable
            // `TypeBuilderInstantiation` #4023 is about, so project the open
            // `Nullable<>` the way the open `Dictionary<,>` is projected and
            // close it over the already-projected underlying.
            if (keyIsNullableValueType
                && !TryWrapInContextNullable(project, ref projectedKey))
            {
                return null;
            }

            if (valueIsNullableValueType
                && !TryWrapInContextNullable(project, ref projectedValue))
            {
                return null;
            }

            var closed = openDefinition.MakeGenericType(projectedKey, projectedValue);

            // Probe one member rather than infer reflectability from the shape:
            // answering member lookups is the entire reason this type is built,
            // and a `TypeBuilderInstantiation` that slipped through throws here
            // (caught below) instead of failing much later inside the binder.
            return closed.GetMethod("ContainsKey") == null ? null : closed;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or NotSupportedException or TypeLoadException or AmbiguousMatchException)
        {
            // The reference set cannot name one of the three types, or refuses
            // the instantiation. The symbolic map shape covers it.
            return null;
        }
    }

    /// <summary>
    /// Issue #4035: closes the reference context's own <c>Nullable&lt;&gt;</c>
    /// over <paramref name="projected"/>, which is already a type in that
    /// context. Returns <see langword="false"/> when the reference set cannot
    /// name <c>System.Nullable`1</c>, in which case the caller falls back to
    /// the symbolic map shape rather than to a wrong dictionary.
    /// </summary>
    /// <param name="project">The host-to-context type projector.</param>
    /// <param name="projected">The in-context underlying type; replaced by the in-context <c>Nullable&lt;T&gt;</c> on success.</param>
    /// <returns><see langword="true"/> when the wrapper was constructed.</returns>
    private static bool TryWrapInContextNullable(Func<Type?, Type?> project, ref Type projected)
    {
        var openNullable = project(typeof(Nullable<>));
        if (openNullable == null)
        {
            return false;
        }

        var constructed = openNullable.MakeGenericType(projected);
        if (constructed == null)
        {
            return false;
        }

        projected = constructed;
        return true;
    }
}
