// <copyright file="TupleElementNamesReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection

/// ADR-0172 Phase B: decodes
/// `System.Runtime.CompilerServices.TupleElementNamesAttribute` from an
/// imported parameter / return / field / property and applies the flattened
/// name array onto the already-mapped (cref:TypeSymbol), rebuilding
/// each tuple occurrence as a named (cref:TupleTypeSymbol). The walk
/// consumes names in the same DFS pre-order the C# compiler (and gsc's
/// emit-side `TupleElementNamesBuilder`) uses: every tuple contributes
/// its arity of entries before its element subtrees; non-tuple composites are
/// traversed transparently. Application is best-effort — a cursor/shape
/// mismatch (foreign compiler quirk) leaves the remaining tree unnamed rather
/// than failing the import.
shared class TupleElementNamesReader {
    private const TupleElementNamesAttributeFullName string = "System.Runtime.CompilerServices.TupleElementNamesAttribute"

    /// Applies any `[TupleElementNames]` metadata found on
    /// [`provider`](paramref) to [`mapped`](paramref).
    /// Returns [`mapped`](paramref) unchanged when the attribute is
    /// absent or carries no names.
    /// @param mapped The already-mapped member type symbol.
    /// @param provider The imported parameter / field / property to read the attribute from.
    /// @returns The (possibly) name-enriched type symbol.
    func ApplyNames(mapped TypeSymbol, provider ICustomAttributeProvider) TypeSymbol {
        let names = TryGetNames(provider)
        if names.IsDefaultOrEmpty {
            return mapped
        }
        var position = 0
        return Apply(mapped, names, &position)
    }

    private func TryGetNames(provider ICustomAttributeProvider) ImmutableArray[string?] {
        var attrs IList[CustomAttributeData]?
        try {
            attrs = switch provider {
                case member is MemberInfo: member.GetCustomAttributesData()
                case parameter is ParameterInfo: parameter.GetCustomAttributesData()
                default: default(IList[CustomAttributeData]?)
            }
        } catch (ex Exception) when ex is TypeLoadException ||
            ex is FileNotFoundException ||
            ex is BadImageFormatException {
            ClrNullability.RecordMetadataReadFailure()
            return ImmutableArray[string?].Empty
        }
        let attr CustomAttributeData? = attrs?.FirstOrDefault(
            (a CustomAttributeData) -> a.AttributeType.FullName == TupleElementNamesAttributeFullName
        )
        if attr == nil || attr.ConstructorArguments.Count != 1 {
            return ImmutableArray[string?].Empty
        }
        if attr.ConstructorArguments[0].Value is not IReadOnlyCollection[CustomAttributeTypedArgument]entries {
            return ImmutableArray[string?].Empty
        }
        return entries.Select((e CustomAttributeTypedArgument) -> cast[string?](e.Value)).ToImmutableArray()
    }

    private func Apply(type TypeSymbol, names ImmutableArray[string?], ref position int32) TypeSymbol {
        var type = type
        // An imported generic type argument surfaces as an imported
        // `System.ValueTuple<…>` rather than a TupleTypeSymbol (issue #813 /
        // #1922 identity bridging covers the two spellings elsewhere).
        // Flatten it first so its positions line up with the name cursor.
        if !(type is TupleTypeSymbol) &&
            type is ImportedTypeSymbol{ClrType: {} importedClr} &&
            TypeSymbol.TryGetTupleTypeSymbolFromClr(importedClr, out var flattened) {
            type = flattened!!
        }
        switch type {
            case tuple is TupleTypeSymbol {
                {
                    if position + tuple.Arity > names.Length {
                        // Shape mismatch — stop consuming, keep the subtree as-is.
                        position = names.Length
                        return tuple
                    }
                    let elementNames = ImmutableArray.CreateBuilder[string?](tuple.Arity)
                    for var i = 0; i < tuple.Arity; i++ {
                        elementNames.Add(names[position])
                        position++
                    }
                    let elements = ImmutableArray.CreateBuilder[TypeSymbol](tuple.Arity)
                    for element in tuple.ElementTypes {
                        elements.Add(Apply(element, names, &position))
                    }
                    return TupleTypeSymbol.Get(elements.MoveToImmutable(), elementNames.MoveToImmutable())
                }
            }
            case nullable is NullableTypeSymbol {
                {
                    let applied = Apply(nullable.UnderlyingType, names, &position)
                    return if object.ReferenceEquals(applied, nullable.UnderlyingType) {
                        type
                    } else {
                        cast[TypeSymbol](NullableTypeSymbol.Get(applied))
                    }
                }
            }
            case platform is PlatformTypeSymbol {
                let applied = Apply(platform.UnderlyingType, names, &position)
                return if object.ReferenceEquals(applied, platform.UnderlyingType) {
                    type
                } else {
                    PlatformTypeSymbol.Get(applied)
                }
            }
            case array is ArrayTypeSymbol {
                {
                    let applied = Apply(array.ElementType, names, &position)
                    return if object.ReferenceEquals(applied, array.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](ArrayTypeSymbol.Get(applied, array.Length))
                    }
                }
            }
            case slice is SliceTypeSymbol {
                {
                    let applied = Apply(slice.ElementType, names, &position)
                    return if object.ReferenceEquals(applied, slice.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](SliceTypeSymbol.Get(applied))
                    }
                }
            }
            case rectangular is RectangularArrayTypeSymbol {
                {
                    let applied = Apply(rectangular.ElementType, names, &position)
                    return if object.ReferenceEquals(applied, rectangular.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](RectangularArrayTypeSymbol.Get(applied, rectangular.Rank))
                    }
                }
            }
            case map_ is MapTypeSymbol {
                {
                    let key = Apply(map_.KeyType, names, &position)
                    let value = Apply(map_.ValueType, names, &position)
                    return if object.ReferenceEquals(key, map_.KeyType) && object.ReferenceEquals(
                        value,
                        map_.ValueType
                    ) {
                        type
                    } else {
                        cast[TypeSymbol](MapTypeSymbol.Get(key, value))
                    }
                }
            }
            case sequence_ is SequenceTypeSymbol {
                {
                    let applied = Apply(sequence_.ElementType, names, &position)
                    return if object.ReferenceEquals(applied, sequence_.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](SequenceTypeSymbol.Get(applied))
                    }
                }
            }
            case asyncSequence is AsyncSequenceTypeSymbol {
                {
                    let applied = Apply(asyncSequence.ElementType, names, &position)
                    return if object.ReferenceEquals(applied, asyncSequence.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](AsyncSequenceTypeSymbol.Get(applied))
                    }
                }
            }
            case channel is ChannelTypeSymbol {
                {
                    let applied = Apply(channel.ElementType, names, &position)
                    return if object.ReferenceEquals(applied, channel.ElementType) {
                        type
                    } else {
                        cast[TypeSymbol](ChannelTypeSymbol.Get(applied, channel.Direction))
                    }
                }
            }
            case ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} imported {
                {
                    let arguments = ImmutableArray.CreateBuilder[TypeSymbol](imported.TypeArguments.Length)
                    var changed = false
                    for argument in imported.TypeArguments {
                        let applied = Apply(argument, names, &position)
                        arguments.Add(applied)
                        changed |= !object.ReferenceEquals(applied, argument)
                    }
                    return if changed {
                        cast[TypeSymbol](
                            ImportedTypeSymbol.GetConstructed(
                                imported.Type,
                                imported.OpenDefinition,
                                arguments.MoveToImmutable()
                            )
                        )
                    } else {
                        type
                    }
                }
            }
            case annotated is NullabilityAnnotatedTypeSymbol {
                {
                    let applied = Apply(annotated.BaseType, names, &position)
                    return if object.ReferenceEquals(applied, annotated.BaseType) {
                        type
                    } else {
                        cast[TypeSymbol](NullabilityAnnotatedTypeSymbol(applied, annotated.NullableFlags))
                    }
                }
            }
            case {ClrType: {IsGenericType: true, IsGenericTypeDefinition: false} closedClr} {
                {
                    var clrArguments[]Type
                    try {
                        clrArguments = closedClr.GetGenericArguments()
                    } catch (ex Exception) when ex is TypeLoadException ||
                        ex is FileNotFoundException ||
                        ex is BadImageFormatException {
                        ClrNullability.RecordMetadataReadFailure()
                        return type
                    }
                    let arguments = ImmutableArray.CreateBuilder[TypeSymbol](clrArguments.Length)
                    var changed = false
                    for clrArgument in clrArguments {
                        let argumentSymbol = TypeSymbol.FromClrTypeWithoutNullability(
                            clrArgument,
                            NullabilityFreeReason.TypeStructure
                        )
                        let applied = Apply(argumentSymbol, names, &position)
                        arguments.Add(applied)
                        changed |= !object.ReferenceEquals(applied, argumentSymbol)
                    }
                    return if changed {
                        cast[TypeSymbol](
                            ImportedTypeSymbol.GetConstructed(
                                closedClr,
                                closedClr.GetGenericTypeDefinition(),
                                arguments.MoveToImmutable()
                            )
                        )
                    } else {
                        type
                    }
                }
            }
            default {
                return type
            }
        }
    }
}
