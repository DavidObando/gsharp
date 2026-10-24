// <copyright file="WellKnownTypes.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Threading

/// The types that the compiler names itself, resolved by name in one (cref:ReferenceImageSet).
/// @remarks A type that the set does not supply is a (cref:MissingTypeSymbol).
/// The table does not fall back to a host type (ADR-0209 section 5).
/// The table holds definitions only. A construction such as `Func<int>` is a construction over the definition.
/// The order of the names is fixed, so the table never depends on hash order.
internal class WellKnownTypes {
    private let set ReferenceImageSet
    private let resolved[]ResolvedTypeReference?

    internal init(set ReferenceImageSet) {
        this.set = set
        resolved = [Names.Length]ResolvedTypeReference?
    }

    /// Gets the metadata full names of the table, in table order.
    internal prop FullNames ImmutableArray[string] -> Names

    /// Resolves a tagged type.
    /// @param special The tag. It must not be (cref:SpecialType.None).
    internal func Get(special SpecialType) ResolvedTypeReference {
        if special == SpecialType.None || !SpecialIndex.TryGetValue(special, out var index) {
            throw ArgumentOutOfRangeException(nameof(special))
        }
        return Get(index)
    }

    /// Resolves a type of the table by its metadata full name.
    /// @returns The answer, or `null` when the name is not in the table.
    internal func TryGet(fullName string) ResolvedTypeReference? {
        if !NameIndex.TryGetValue(fullName, out var index) {
            return nil
        }
        return Get(index)
    }

    private func Get(index int32) ResolvedTypeReference {
        let existing = resolved[index]
        if existing != nil {
            return existing
        }
        let created = set.TryResolveVisibleName(Names[index], CoreLibraryOnly.Contains(index)) ??
            ResolvedTypeReference(set.GetMissing(nil, Names[index]))
        return Interlocked.CompareExchange(&resolved[index], created, nil) ?? created
    }

    shared {
        // Tagged types first, then the families, then the names that the emitter writes.
        // Every list is spelled out, so no code enumerates a dictionary.
        private func BuildNames() ImmutableArray[string] {
            let names = ImmutableArray.CreateBuilder[string]()
            for special in TaggedTypes {
                names.Add(special.Value)
            }
            for var i = 1; i <= 8; i++ {
                names.Add("System.ValueTuple`${i}")
            }
            for var i = 0; i <= 16; i++ {
                names.Add(
                    if i == 0 {
                        "System.Action"
                    } else {
                        "System.Action`${i}"
                    }
                )
            }
            for var i = 1; i <= 17; i++ {
                names.Add("System.Func`${i}")
            }
            for name in OtherTypes {
                names.Add(name)
            }
            return names.ToImmutable()
        }

        private let TaggedTypes[]KeyValuePair[SpecialType, string] = []KeyValuePair[SpecialType, string]{
            KeyValuePair[SpecialType, string](SpecialType.Object, "System.Object"),
            KeyValuePair[SpecialType, string](SpecialType.Void, "System.Void"),
            KeyValuePair[SpecialType, string](SpecialType.Boolean, "System.Boolean"),
            KeyValuePair[SpecialType, string](SpecialType.Char, "System.Char"),
            KeyValuePair[SpecialType, string](SpecialType.SByte, "System.SByte"),
            KeyValuePair[SpecialType, string](SpecialType.Byte, "System.Byte"),
            KeyValuePair[SpecialType, string](SpecialType.Int16, "System.Int16"),
            KeyValuePair[SpecialType, string](SpecialType.UInt16, "System.UInt16"),
            KeyValuePair[SpecialType, string](SpecialType.Int32, "System.Int32"),
            KeyValuePair[SpecialType, string](SpecialType.UInt32, "System.UInt32"),
            KeyValuePair[SpecialType, string](SpecialType.Int64, "System.Int64"),
            KeyValuePair[SpecialType, string](SpecialType.UInt64, "System.UInt64"),
            KeyValuePair[SpecialType, string](SpecialType.IntPtr, "System.IntPtr"),
            KeyValuePair[SpecialType, string](SpecialType.UIntPtr, "System.UIntPtr"),
            KeyValuePair[SpecialType, string](SpecialType.Single, "System.Single"),
            KeyValuePair[SpecialType, string](SpecialType.Double, "System.Double"),
            KeyValuePair[SpecialType, string](SpecialType.Decimal, "System.Decimal"),
            KeyValuePair[SpecialType, string](SpecialType.String, "System.String"),
            KeyValuePair[SpecialType, string](SpecialType.ValueType, "System.ValueType"),
            KeyValuePair[SpecialType, string](SpecialType.Enum, "System.Enum"),
            KeyValuePair[SpecialType, string](SpecialType.Delegate, "System.Delegate"),
            KeyValuePair[SpecialType, string](SpecialType.MulticastDelegate, "System.MulticastDelegate"),
            KeyValuePair[SpecialType, string](SpecialType.Array, "System.Array"),
            KeyValuePair[SpecialType, string](SpecialType.Nullable, "System.Nullable`1")
        }

        // The async builders and attributes that the emitter writes, the collection shapes that the
        // lowering names, and the exception types of generated checks.
        private let OtherTypes[]string = []string{
            "System.Attribute",
            "System.Type",
            "System.TypedReference",
            "System.Exception",
            "System.NullReferenceException",
            "System.IDisposable",
            "System.IAsyncDisposable",
            "System.Collections.IEnumerable",
            "System.Collections.IEnumerator",
            "System.Collections.Generic.IEnumerable`1",
            "System.Collections.Generic.IEnumerator`1",
            "System.Collections.Generic.IAsyncEnumerable`1",
            "System.Collections.Generic.IAsyncEnumerator`1",
            "System.Collections.Generic.List`1",
            "System.Collections.Generic.Dictionary`2",
            "System.Threading.Tasks.Task",
            "System.Threading.Tasks.Task`1",
            "System.Threading.Tasks.ValueTask",
            "System.Threading.Tasks.ValueTask`1",
            "System.Runtime.CompilerServices.AsyncVoidMethodBuilder",
            "System.Runtime.CompilerServices.AsyncTaskMethodBuilder",
            "System.Runtime.CompilerServices.AsyncTaskMethodBuilder`1",
            "System.Runtime.CompilerServices.AsyncValueTaskMethodBuilder",
            "System.Runtime.CompilerServices.AsyncValueTaskMethodBuilder`1",
            "System.Runtime.CompilerServices.AsyncIteratorMethodBuilder",
            "System.Runtime.CompilerServices.IAsyncStateMachine",
            "System.Runtime.CompilerServices.AsyncStateMachineAttribute",
            "System.Runtime.CompilerServices.CompilerGeneratedAttribute",
            "System.Runtime.CompilerServices.CompilerFeatureRequiredAttribute",
            "System.Runtime.CompilerServices.ExtensionAttribute",
            "System.Runtime.CompilerServices.FixedBufferAttribute",
            "System.Runtime.CompilerServices.IsByRefLikeAttribute",
            "System.Runtime.CompilerServices.IsExternalInit",
            "System.Runtime.CompilerServices.IsReadOnlyAttribute",
            "System.Runtime.CompilerServices.NullableAttribute",
            "System.Runtime.CompilerServices.NullableContextAttribute",
            "System.Runtime.CompilerServices.ParamCollectionAttribute",
            "System.Runtime.CompilerServices.PreserveBaseOverridesAttribute",
            "System.Runtime.CompilerServices.ScopedRefAttribute",
            "System.Runtime.CompilerServices.TupleElementNamesAttribute",
            "System.Runtime.CompilerServices.UnsafeValueTypeAttribute",
            "System.Diagnostics.CodeAnalysis.UnscopedRefAttribute",
            "System.Diagnostics.DebuggerStepThroughAttribute",
            "System.Runtime.InteropServices.InAttribute",
            "System.ObsoleteAttribute",
            "System.ParamArrayAttribute"
        }

        private let Names ImmutableArray[string] = BuildNames()
        private let SpecialIndex Dictionary[SpecialType, int32] = BuildSpecialIndex()
        private let NameIndex Dictionary[string, int32] = BuildNameIndex()

        // The names that the runtime binds specially: every tagged type and System.TypedReference.
        // A definition of one of these in a library that is not a core library is a namesake.
        private let CoreLibraryOnly HashSet[int32] = BuildCoreLibraryOnly()

        private func BuildCoreLibraryOnly() HashSet[int32] {
            let indexes = HashSet[int32]()
            for pair in SpecialIndex {
                indexes.Add(pair.Value)
            }
            indexes.Add(NameIndex["System.TypedReference"])
            return indexes
        }

        private func BuildSpecialIndex() Dictionary[SpecialType, int32] {
            let index = Dictionary[SpecialType, int32]()
            for var i = 0; i < TaggedTypes.Length; i++ {
                index[TaggedTypes[i].Key] = i
            }
            // ValueTuple`1 to `8 follow the tagged types.
            for var i = 1; i <= 8; i++ {
                index[cast[SpecialType](cast[int32](SpecialType.ValueTuple1) + i - 1)] = TaggedTypes.Length + i - 1
            }
            return index
        }

        private func BuildNameIndex() Dictionary[string, int32] {
            let index = Dictionary[string, int32](StringComparer.Ordinal)
            for var i = 0; i < Names.Length; i++ {
                index.TryAdd(Names[i], i)
            }
            return index
        }
    }
}
