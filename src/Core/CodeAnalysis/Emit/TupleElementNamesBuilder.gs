// <copyright file="TupleElementNamesBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable

/// ADR-0172 Phase B: computes the C#-compatible
/// `[System.Runtime.CompilerServices.TupleElementNamesAttribute]`
/// `string[]` for a G# (cref:TypeSymbol) — a DFS pre-order walk
/// of the type tree in which every tuple occurrence contributes its arity of
/// entries (declared name, or `null` for an unnamed position)
/// before its element subtrees are visited. Non-tuple composites (arrays,
/// slices, maps, sequences, channels, nullable wrappers, generic
/// instantiations, function types) contribute no entries of their own but are
/// traversed, matching Roslyn's `TupleNamesEncoder`. Arity ≥ 8 tuples
/// contribute their LOGICAL elements only — the CLR's synthesized
/// `TRest` nesting is invisible, exactly as in C#. The attribute is
/// only emitted when at least one entry is non-null; (cref:Build)
/// returns an empty array otherwise.
internal shared class TupleElementNamesBuilder {
    /// Computes the flattened element-name array for the supplied type.
    /// Returns an empty array when no tuple position anywhere in the type
    /// declares a name (no attribute needed).
    /// @param type The parameter / return / field / property type to inspect.
    /// @returns The names array — possibly empty; never `default`.
    internal func Build(type TypeSymbol) ImmutableArray[string?] {
        let builder = ImmutableArray.CreateBuilder[string?]()
        var anyName = false
        Append(type, builder, &anyName)
        return if anyName {
            builder.ToImmutable()
        } else {
            ImmutableArray[string?].Empty
        }
    }

    private func Append(type TypeSymbol, builder ImmutableArray[string?].Builder, ref anyName bool) {
        switch type {
            case tuple is TupleTypeSymbol {
                for var i = 0; i < tuple.Arity; i++ {
                    let name string? = if tuple.HasNames {
                        tuple.ElementNames[i]
                    } else {
                        default(string?)
                    }
                    builder.Add(name)
                    anyName |= name != nil
                }
                for element in tuple.ElementTypes {
                    Append(element, builder, &anyName)
                }
            }
            case nullable is NullableTypeSymbol {
                Append(nullable.UnderlyingType, builder, &anyName)
            }
            case array is ArrayTypeSymbol {
                Append(array.ElementType, builder, &anyName)
            }
            case slice is SliceTypeSymbol {
                Append(slice.ElementType, builder, &anyName)
            }
            case rectangular is RectangularArrayTypeSymbol {
                Append(rectangular.ElementType, builder, &anyName)
            }
            case map_ is MapTypeSymbol {
                Append(map_.KeyType, builder, &anyName)
                Append(map_.ValueType, builder, &anyName)
            }
            case sequence_ is SequenceTypeSymbol {
                Append(sequence_.ElementType, builder, &anyName)
            }
            case asyncSequence is AsyncSequenceTypeSymbol {
                Append(asyncSequence.ElementType, builder, &anyName)
            }
            case channel is ChannelTypeSymbol {
                Append(channel.ElementType, builder, &anyName)
            }
            case function is FunctionTypeSymbol {
                for parameterType in function.ParameterTypes {
                    Append(parameterType, builder, &anyName)
                }
                Append(function.ReturnType, builder, &anyName)
            }
            case pointer is FunctionPointerTypeSymbol {
                Append(pointer.ReturnType, builder, &anyName)
                for parameter in pointer.ParameterTypes {
                    Append(parameter, builder, &anyName)
                }
            }
            case StructSymbol{TypeArguments: {IsDefaultOrEmpty: false}} aggregate {
                for argument in aggregate.TypeArguments {
                    Append(argument, builder, &anyName)
                }
            }
            case ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} imported {
                for argument in imported.TypeArguments {
                    Append(argument, builder, &anyName)
                }
            }
            case PointerTypeSymbol, ByRefTypeSymbol, PlatformTypeSymbol, NullabilityAnnotatedTypeSymbol {
                for child in TypeSymbol.GetWrappedTypes(type) {
                    Append(child, builder, &anyName)
                }
            }
            default { }
        }
    }
}
