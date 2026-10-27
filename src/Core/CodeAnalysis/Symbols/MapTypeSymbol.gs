// <copyright file="MapTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import System.Reflection
import System.Runtime.CompilerServices

/// Represents a G# map type `map[K,V]`.
/// @remarks ADR-0104 (supersedes Phase 3.A.4 Go-flavored `map[K]V`) — backing
/// representation is the CLR
/// `System.Collections.Generic.Dictionary<K, V>`. The literal
/// form `map[K,V]{k: v, …}` populates a freshly allocated dictionary;
/// `m[k]` indexes it; the `delete(m, k)` built-in removes a
/// key; `len(m)` returns `Count`. Instances are cached per
/// `(K, V)` pair so identical map types compare by reference.
class MapTypeSymbol : TypeSymbol {
    private init(keyType TypeSymbol, valueType TypeSymbol) : base(
        "map[${keyType.Name},${valueType.Name}]",
        MakeClrType(keyType, valueType)
    ) {
        KeyType = keyType
        ValueType = valueType
    }

    /// Gets the key type.
    prop KeyType TypeSymbol {
        get;
    }

    /// Gets the value type.
    prop ValueType TypeSymbol {
        get;
    }

    shared {
        /// The full name of the CLR type a `map[K, V]` IS (ADR-0104).
        private const DictionaryFullName string = "System.Collections.Generic.Dictionary`2"

        private let Cache ConcurrentDictionary[(TypeSymbol, TypeSymbol), MapTypeSymbol] = ConcurrentDictionary[
            (TypeSymbol, TypeSymbol),
            MapTypeSymbol
        ]()

        /// Issue #4023: per-reference-context projectors, registered by
        /// (cref:ReferenceResolver) for every assembly it loaded. Keyed
        /// weakly by (cref:Assembly) exactly as
        /// (cref:ImportedTypeSymbol)'s own cache is, so a disposed
        /// (cref:System.Reflection.MetadataLoadContext)'s entries become
        /// collectable on their own and one live compilation can never be
        /// deprived of its projector by another's disposal.
        private let ReferenceProjectors ConditionalWeakTable[Assembly, (Type?) -> Type?] = ConditionalWeakTable[
            Assembly,
            (Type?) -> Type?
        ]()

        /// Gets or creates the map type symbol for the given key and value types.
        /// @param keyType The key type.
        /// @param valueType The value type.
        /// @returns The cached (cref:MapTypeSymbol).
        func Get(keyType TypeSymbol?, valueType TypeSymbol?) MapTypeSymbol {
            if keyType == nil {
                throw ArgumentNullException("keyType")
            }
            if valueType == nil {
                throw ArgumentNullException("valueType")
            }
            return Cache.GetOrAdd((keyType, valueType), (k(TypeSymbol, TypeSymbol)) -> MapTypeSymbol(k.Item1, k.Item2))
        }

        /// Issue #3987: recognizes a map-shaped type by SHAPE rather than by
        /// spelling — G#'s own (cref:MapTypeSymbol), or the
        /// `System.Collections.Generic.Dictionary<K, V>` it IS
        /// (ADR-0104 identity) arriving from metadata as an
        /// (cref:ImportedTypeSymbol).
        /// @remarks The direct analogue of (cref:ChannelTypeSymbol.TryGetChannelShape)
        /// and (cref:SequenceTypeSymbol.TryGetEnumerableInterfaceShape), and
        /// it exists for the same reason: with CLOSED key/value types the two
        /// spellings are already identity because `Conversion` compares their
        /// (cref:TypeSymbol.ClrType)s, but the moment one of them is open
        /// those `ClrType`s stop identifying the types — this side's is null,
        /// and the imported side's is the ADR-0004 type-ERASED
        /// `Dictionary<object, object>` — so the comparison has nothing
        /// left it can trust. Which name the author (or the metadata) happened to
        /// use is not a fact about the type.
        /// @param type The candidate type.
        /// @param keyType The recovered key type.
        /// @param valueType The recovered value type.
        /// @returns True when [`type`](paramref) is map-shaped.
        func TryGetMapShape(
            type TypeSymbol?,
            @NotNullWhen(true) out keyType TypeSymbol?,
            @NotNullWhen(true) out valueType TypeSymbol?
        ) bool {
            keyType = nil
            valueType = nil
            switch type {
                case nil {
                    return false
                }
                case annotated is NullabilityAnnotatedTypeSymbol {
                    return TryGetMapShape(annotated.BaseType, out keyType, out valueType)
                }
                case map_ is MapTypeSymbol {
                    keyType = map_.KeyType
                    valueType = map_.ValueType
                    return true
                }
                case imported is ImportedTypeSymbol {
                    {
                        var open_ Type? = imported.OpenDefinition
                        if open_ == nil && imported.ClrType is {IsGenericType: true} closed {
                            open_ = closed.GetGenericTypeDefinition()
                        }
                        if open_?.FullName != DictionaryFullName {
                            return false
                        }
                        if imported.TypeArguments.Length == 2 {
                            keyType = imported.TypeArguments[0]
                            valueType = imported.TypeArguments[1]
                            return true
                        }
                        if imported.ClrType is {IsGenericType: true} closedShape {
                            let arguments = closedShape.GetGenericArguments()
                            if arguments.Length != 2 {
                                return false
                            }
                            keyType = TypeSymbol.FromClrTypeWithoutNullability(
                                arguments[0],
                                NullabilityFreeReason.TypeStructure
                            )
                            valueType = TypeSymbol.FromClrTypeWithoutNullability(
                                arguments[1],
                                NullabilityFreeReason.TypeStructure
                            )
                            return keyType != nil && valueType != nil
                        }
                        return false
                    }
                }
                default {
                    return false
                }
            }
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()

        /// Issue #4023: registers the projector that maps a host CLR
        /// (cref:Type) into the reflection context [`assembly`](paramref)
        /// belongs to ((cref:ReferenceResolver.MapClrTypeToReferences)), so
        /// (cref:MakeClrType) can build a map's backing
        /// `Dictionary<K, V>` in the SAME context as an imported key or
        /// value rather than in the host's, where the two cannot be mixed.
        /// @param assembly An assembly the registering resolver loaded.
        /// @param project The resolver's host-to-context type projector.
        internal func RegisterReferenceProjector(assembly Assembly?, project((Type?) -> Type?)?) {
            if assembly == nil || project == nil {
                return
            }
            ReferenceProjectors.AddOrUpdate(assembly, project)
        }

        /// Issue #4023: the erasure counterpart of (cref:MakeClrType), for
        /// `MemberLookup`'s map arm. Given two ALREADY-ERASED CLR types, at
        /// least one of which came from a reference context, answers a
        /// member-resolvable `Dictionary<K, V>` built entirely inside
        /// that context, or `null` when the context cannot be
        /// identified. The caller keeps the host construction as its fallback, so
        /// this only ever UPGRADES an erasure that would otherwise be a
        /// member-less `TypeBuilderInstantiation`.
        /// @param keyClrType The erased key CLR type.
        /// @param valueClrType The erased value CLR type.
        /// @returns The context-correct closed dictionary, or `null`.
        internal func TryMakeErasedClrTypeInReferenceContext(
            keyClrType Type?,
            valueClrType Type?
        ) Type? -> if keyClrType == nil ||
            valueClrType == nil {
            default(Type?)
        } else {
            TryMakeClrTypeInReferenceContext(
                keyClrType,
                keyIsNullableValueType: false,
                valueClrType,
                valueIsNullableValueType: false
            )
        }

        private func MakeClrType(keyType TypeSymbol, valueType TypeSymbol) Type? {
            // Nested generic arguments must use the same symbolic projection as direct type parameters (ADR-0087).
            if TypeSymbol.ContainsTypeParameter(keyType) || TypeSymbol.ContainsTypeParameter(valueType) {
                return nil
            }
            if keyType.ClrType == nil || valueType.ClrType == nil {
                return nil
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
            let keyClrType Type? = NullableLifting.GetEffectiveClrType(keyType)
            let valueClrType Type? = NullableLifting.GetEffectiveClrType(valueType)
            if keyClrType == nil || valueClrType == nil {
                return nil
            }
            if keyClrType.IsRuntimeProvidedType() && valueClrType.IsRuntimeProvidedType() {
                return typeof(Dictionary[_, _]).MakeGenericType(keyClrType, valueClrType)
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
                keyType.ClrType!!,
                IsNullableValueType(keyType),
                valueType.ClrType!!,
                IsNullableValueType(valueType)
            )
        }

        /// Issue #4035: whether [`type`](paramref) is a nullable VALUE type,
        /// the case whose backing dictionary argument must be
        /// `Nullable<T>` rather than the bare underlying `T`. A
        /// nullable REFERENCE type is deliberately excluded: its annotation has no
        /// distinct runtime type, so `map[string, string?]` is — correctly —
        /// backed by `Dictionary<string, string>`.
        /// @param type The key or value type symbol.
        /// @returns `true` for a nullable value type.
        private func IsNullableValueType(type TypeSymbol) bool -> (
            type is NullableTypeSymbol and {UnderlyingType: {ClrType: {IsValueType: true}}}
        )

        /// Issue #4023: builds the backing `Dictionary<K, V>` inside the
        /// reflection context that [`keyClrType`](paramref) /
        /// [`valueClrType`](paramref) came from, or `null`
        /// when no projector is registered for that context or the projection does
        /// not produce a member-resolvable type.
        /// @remarks Returning `null` is always safe: a `map[K, V]` with
        /// no CLR type is the compiler's long-standing symbolic shape — what a map
        /// over a type parameter or a same-compilation class has — and the emitter
        /// reifies its member refs from the symbols
        /// (`ImportedMemberRefFactory.TryNormalizeToSymbolicContainer`'s map
        /// arm, `GetMapCtorReference` and friends).
        /// @param keyClrType The key's UNDERLYING CLR type; non-null by the caller's check.
        /// @param keyIsNullableValueType Whether the key is a nullable value type, so its projected form must
        /// be wrapped in the context's `Nullable<>` (issue #4035).
        /// @param valueClrType The value's UNDERLYING CLR type; non-null by the caller's check.
        /// @param valueIsNullableValueType Whether the value is a nullable value type, as
        /// [`keyIsNullableValueType`](paramref).
        /// @returns The context-correct closed dictionary type, or `null`.
        private func TryMakeClrTypeInReferenceContext(
            keyClrType Type,
            keyIsNullableValueType bool,
            valueClrType Type,
            valueIsNullableValueType bool
        ) Type? {
            // Whichever side is NOT host-provided names the context both must be
            // projected into; when both are, the caller already took the host path.
            let carrier = if keyClrType.IsRuntimeProvidedType() {
                valueClrType
            } else {
                keyClrType
            }
            if carrier.Assembly is not{} carrierAssembly || !ReferenceProjectors.TryGetValue(
                carrierAssembly,
                out var project
            ) {
                return nil
            }
            try {
                let openDefinition Type? = project(typeof(Dictionary[_, _]))
                var projectedKey Type? = project(keyClrType)
                var projectedValue Type? = project(valueClrType)
                if openDefinition == nil || projectedKey == nil || projectedValue == nil {
                    return nil
                }
                // Issue #4035: wrap INSIDE the context. A host-built
                // `Nullable<contextDateTime>` is the same unreflectable
                // `TypeBuilderInstantiation` #4023 is about, so project the open
                // `Nullable<>` the way the open `Dictionary<,>` is projected and
                // close it over the already-projected underlying.
                if keyIsNullableValueType && !TryWrapInContextNullable(project, &projectedKey) {
                    return nil
                }
                if valueIsNullableValueType && !TryWrapInContextNullable(project, &projectedValue) {
                    return nil
                }
                let closed = openDefinition.MakeGenericType(projectedKey!!, projectedValue!!)
                // Probe one member rather than infer reflectability from the shape:
                // answering member lookups is the entire reason this type is built,
                // and a `TypeBuilderInstantiation` that slipped through throws here
                // (caught below) instead of failing much later inside the binder.
                return if closed.GetMethod("ContainsKey") == nil {
                    default(Type?)
                } else {
                    closed
                }
            } catch (e Exception) when e is ArgumentException ||
                e is InvalidOperationException ||
                e is NotSupportedException ||
                e is TypeLoadException ||
                e is AmbiguousMatchException {
                // The reference set cannot name one of the three types, or refuses
                // the instantiation. The symbolic map shape covers it.
                return nil
            }
        }

        /// Issue #4035: closes the reference context's own `Nullable<>`
        /// over [`projected`](paramref), which is already a type in that
        /// context. Returns `false` when the reference set cannot
        /// name `System.Nullable`1`, in which case the caller falls back to
        /// the symbolic map shape rather than to a wrong dictionary.
        /// @param project The host-to-context type projector.
        /// @param projected The in-context underlying type; replaced by the in-context `Nullable<T>` on
        /// success.
        /// @returns `true` when the wrapper was constructed.
        private func TryWrapInContextNullable(project(Type?) -> Type?, ref projected Type) bool {
            let openNullable Type? = project(typeof(Nullable[_]))
            if openNullable == nil {
                return false
            }
            let constructed Type? = openNullable.MakeGenericType(projected)
            if constructed == nil {
                return false
            }
            projected = constructed
            return true
        }
    }
}
