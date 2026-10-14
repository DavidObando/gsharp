// <copyright file="TypeSymbol.NullabilityQueries.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable

/// ADR-0193 §2: the answer to <em>"what is this type's reference
/// nullability?"</em> for one top-level position.
///
/// A separate enum from (cref:ImportedReferenceNullability), which is
/// the import rule's <em>decision</em> (its fourth value is "leave the input
/// as it is"). This one is a query result, and its fourth value says the
/// question does not apply: a value type, including `Nullable<V>`,
/// has no reference nullability. Value optionality (ADR-0001) is a different
/// question.
internal enum ReferenceNullabilityKind {
    NotApplicable,
    NotNull,
    Nullable,
    Platform
}

/// ```xmldoc
/// <content>
/// ADR-0193 §2: the type-level nullability queries. Phase 1 adds the two
/// read-only members the §4 reader-agreement test compares readers through;
/// no consumer moves onto them until Phase 3, which adds the rest of the API.
/// </content>
/// ```
open partial class TypeSymbol : Symbol {
    /// Gets the reference nullability of this type's top-level position, read
    /// through whichever wrapper represents it ((cref:NullableTypeSymbol),
    /// (cref:PlatformTypeSymbol), or a
    /// (cref:NullabilityAnnotatedTypeSymbol) over either Layer 3
    /// representation). Value types — including a value-type
    /// `Nullable<V>`, decided by
    /// (cref:NullableLifting.IsAnyValueTypeNullable) — report
    /// (cref:ReferenceNullabilityKind.NotApplicable).
    internal prop ReferenceNullability ReferenceNullabilityKind {
        get {
            switch this {
                case nullable is NullableTypeSymbol {
                    return if NullableLifting.IsAnyValueTypeNullable(nullable) {
                        ReferenceNullabilityKind.NotApplicable
                    } else {
                        ReferenceNullabilityKind.Nullable
                    }
                }
                case PlatformTypeSymbol {
                    return ReferenceNullabilityKind.Platform
                }
                case annotated is NullabilityAnnotatedTypeSymbol {
                    // The walkers express byte 0's state as the wrapper AROUND
                    // this symbol, so the top-level answer is the wrapper's.
                    // A bare annotated symbol reads as its base. Decoding byte
                    // 0 here instead is a Phase 3 query-API precision item
                    // (#4363): the event readers strip only the outer `?`, so
                    // the byte and the wrapper disagree today.
                    return annotated.BaseType.ReferenceNullability
                }
                case byRef is ByRefTypeSymbol {
                    // A by-ref contributes no nullability position of its own;
                    // `[Nullable]` on a by-ref annotates the pointee.
                    return byRef.PointeeType.ReferenceNullability
                }
            }
            if object.ReferenceEquals(this, Null) {
                return ReferenceNullabilityKind.Nullable
            }
            if object.ReferenceEquals(this, Error) || object.ReferenceEquals(this, TypeSymbol.Void) ||
                object.ReferenceEquals(this, Never) {
                return ReferenceNullabilityKind.NotApplicable
            }
            return if NullabilityImportRule.ClassifyArgument(this) == TypeArgumentKind.Value {
                ReferenceNullabilityKind.NotApplicable
            } else {
                ReferenceNullabilityKind.NotNull
            }
        }
    }

    /// Returns this type's element and type-argument positions, each with the
    /// nullability the reader gave it, whichever Layer 3 representation holds
    /// it: nested wrapper types ((cref:ImportedTypeSymbol.TypeArguments),
    /// slice and array elements, map keys and values, tuple elements) or the
    /// lazily-decoded flags of a (cref:NullabilityAnnotatedTypeSymbol)
    /// (through (cref:NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbol)
    /// and (cref:NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbolForClrType),
    /// the accessors an element read uses).
    ///
    /// A top-level `?`, `!`, `Nullable<V>` or by-ref is
    /// transparent: its positions are its underlying type's, exactly as
    /// C# nullable metadata lays them out.
    /// @returns The immediate positions, in declaration order; empty for a leaf type.
    internal func GetElementPositions() ImmutableArray[TypeSymbol] {
        switch this {
            case nullable is NullableTypeSymbol {
                return nullable.UnderlyingType.GetElementPositions()
            }
            case platform is PlatformTypeSymbol {
                return platform.UnderlyingType.GetElementPositions()
            }
            case byRef is ByRefTypeSymbol {
                return byRef.PointeeType.GetElementPositions()
            }
            case annotated is NullabilityAnnotatedTypeSymbol {
                return SpliceTupleRest(annotated.ClrType, annotated.GetAnnotatedElementPositions())
            }
            case ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} imported {
                return SpliceTupleRest(imported.OpenDefinition ?? imported.ClrType, imported.TypeArguments)
            }
            case slice is SliceTypeSymbol {
                return ImmutableArray.Create(slice.ElementType)
            }
            case array is ArrayTypeSymbol {
                return ImmutableArray.Create(array.ElementType)
            }
            case rectangular is RectangularArrayTypeSymbol {
                return ImmutableArray.Create(rectangular.ElementType)
            }
            case map_ is MapTypeSymbol {
                return ImmutableArray.Create(map_.KeyType, map_.ValueType)
            }
            case tuple is TupleTypeSymbol {
                return tuple.ElementTypes
            }
            case sequence_ is SequenceTypeSymbol {
                return ImmutableArray.Create(sequence_.ElementType)
            }
            case asyncSequence is AsyncSequenceTypeSymbol {
                return ImmutableArray.Create(asyncSequence.ElementType)
            }
            case channel is ChannelTypeSymbol {
                return ImmutableArray.Create(channel.ElementType)
            }
            case function is FunctionTypeSymbol {
                // The delegate shape `Func<T1, …, TResult>` lays its
                // parameters out before its return; an `Action<…>` has no
                // return position at all.
                return if object.ReferenceEquals(function.ReturnType, TypeSymbol.Void) {
                    function.ParameterTypes
                } else {
                    function.ParameterTypes.Add(function.ReturnType)
                }
            }
            case structure is StructSymbol when !structure
                .TypeArguments
                .IsDefaultOrEmpty ||
                !structure
                .EnclosingTypeArguments
                .IsDefaultOrEmpty {
                return if structure.EnclosingTypeArguments.IsDefaultOrEmpty {
                    structure.TypeArguments
                } else {
                    structure.EnclosingTypeArguments.AddRange(
                        if structure.TypeArguments.IsDefault {
                            ImmutableArray[TypeSymbol].Empty
                        } else {
                            structure.TypeArguments
                        }
                    )
                }
            }
            case constructedInterface is InterfaceSymbol when !constructedInterface.TypeArguments.IsDefaultOrEmpty {
                return constructedInterface.TypeArguments
            }
            case constructedDelegate is DelegateTypeSymbol when !constructedDelegate.TypeArguments.IsDefaultOrEmpty {
                return constructedDelegate.TypeArguments
            }
        }
        return GetClrElementPositions(ClrType)
    }

    /// ADR-0193 Phase 2: the shape a caller that deliberately ignores
    /// reference nullability used to get from (cref:FromClrType). It
    /// removes a top-level reference `?` and platform `!`, and the
    /// (cref:NullabilityAnnotatedTypeSymbol) carrier, repeatedly, and
    /// leaves a value-type `Nullable<V>` alone.
    ///
    /// Dropping the carrier also drops the inner-position flags it holds
    /// (`List[string?]?` becomes `List[string]`), while
    /// inner positions held as nested wrappers survive. That is deliberate
    /// for the few Phase 2 callers: each read a signature position erased
    /// before, and wants that exact shape (an `object` member called on an
    /// erased type parameter, a boxing target, a method group's inference
    /// signature, a lowered local). Nothing that wants nullability should
    /// call this. Phase 3's `StripReferenceNullability(deep)` replaces it
    /// with a representation-independent answer.
    /// @returns The bare type.
    internal func StripToBareShape() TypeSymbol {
        var type = this
        while true {
            switch type {
                case platform is PlatformTypeSymbol {
                    type = platform.UnderlyingType
                    continue
                }
                case nullable is NullableTypeSymbol when !NullableLifting.IsAnyValueTypeNullable(nullable) {
                    type = nullable.UnderlyingType
                    continue
                }
                case annotated is NullabilityAnnotatedTypeSymbol {
                    type = annotated.BaseType
                    continue
                }
                default {
                    return type
                }
            }
        }
    }

    shared {
        /// An eight-argument `ValueTuple`/`Tuple` nests elements eight
        /// onward in its `TRest` argument. (cref:TupleTypeSymbol) — what
        /// (cref:FromClrType) builds — is already flat (issue #2750), so the
        /// other representations splice their rest in too: the positions of a
        /// tuple are its elements, however it is held.
        /// @param shape The CLR definition or closed type of the holder.
        /// @param positions The holder's own positions.
        /// @returns The flattened positions.
        private func SpliceTupleRest(shape Type?, positions ImmutableArray[TypeSymbol]) ImmutableArray[TypeSymbol] {
            if positions.Length != 8 || !(shape != nil && shape.IsGenericType == true) {
                return positions
            }
            let definition = if shape.IsGenericTypeDefinition {
                shape
            } else {
                shape.GetGenericTypeDefinition()
            }
            if definition.FullName is not("System.ValueTuple`8" or "System.Tuple`8") {
                return positions
            }
            // Only a canonical rest — itself a tuple — nests elements. A
            // non-canonical `ValueTuple<…, int>` is eight elements, exactly as
            // FromClrType reads it.
            let rest = positions[7]
            let restShape = if rest is ImportedTypeSymbol restImported {
                restImported.OpenDefinition ?? rest.ClrType
            } else {
                rest.ClrType
            }
            let restIsTuple = rest is TupleTypeSymbol ||
                (
                restShape is {IsGenericType: true} restGeneric &&
                    (
                    if restGeneric.IsGenericTypeDefinition {
                        restGeneric
                    } else {
                        restGeneric.GetGenericTypeDefinition()
                    }
                ).FullName is {} restName &&
                    (
                    restName.StartsWith("System.ValueTuple`", StringComparison.Ordinal) || restName.StartsWith(
                        "System.Tuple`",
                        StringComparison.Ordinal
                    )
                )
            )
            return if restIsTuple {
                positions.RemoveAt(7).AddRange(rest.GetElementPositions())
            } else {
                positions
            }
        }

        /// The positions of a type that carries no symbolic arguments: its CLR
        /// shape is all there is, and a CLR type states no reference nullability
        /// of its own, so each position is (cref:FromClrType)'s bare answer.
        /// @param clrType The CLR shape.
        /// @returns The positions.
        private func GetClrElementPositions(clrType Type?) ImmutableArray[TypeSymbol] {
            if clrType == nil {
                return ImmutableArray[TypeSymbol].Empty
            }
            if clrType.IsArray {
                return if clrType.GetElementType() is {} element {
                    ImmutableArray.Create(FromClrTypeWithoutNullability(element, NullabilityFreeReason.TypeStructure))
                } else {
                    ImmutableArray[TypeSymbol].Empty
                }
            }
            if !clrType.IsGenericType || clrType.IsGenericTypeDefinition {
                return ImmutableArray[TypeSymbol].Empty
            }
            let arguments = clrType.GetGenericArguments()
            let builder = ImmutableArray.CreateBuilder[TypeSymbol](arguments.Length)
            for argument in arguments {
                builder.Add(FromClrTypeWithoutNullability(argument, NullabilityFreeReason.TypeStructure))
            }
            return builder.MoveToImmutable()
        }
    }
}
