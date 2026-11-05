// <copyright file="SubmissionGlobalTypeProjection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Diagnostics.CodeAnalysis

/// Issue #3308 / ADR-0156 Phase 2: reverse projection for prior-submission
/// globals whose declared G# type is a compiler-magic wrapper kind. Later
/// cells bind a prior cell's top-level global through its emitted CLR field
/// (the #3186 submission-as-metadata seam), so the field's type surfaces as
/// the CLR <em>projection</em> of the declared type — e.g. a `chan T`
/// global surfaces as imported `System.Threading.Channels.Channel[T]`.
/// Kinds whose operations type-check against the magic symbol itself
/// ((cref:ChannelTypeSymbol) for `<-`/`select`/`close`,
/// (cref:SliceTypeSymbol)/(cref:ArrayTypeSymbol) for
/// `len`/`cap`/`append`) lose those operations cross-cell
/// unless the CLR projection is mapped back to the magic symbol.
///
/// The reverse projection is steered by the declaring submission's
/// source-side type (recorded in its (cref:BoundGlobalScope)), which
/// settles otherwise-ambiguous CLR shapes (a `T[]` field is a slice or
/// a fixed array depending on the declaration, and the fixed length exists
/// only source-side); component types are rebuilt from the CURRENT
/// compilation's metadata view of the field (never from the prior
/// compilation's symbols, whose CLR identities belong to a different
/// resolver). Kinds that already round-trip correctly through the seam are
/// intentionally left on their existing paths: maps bind through the erased
/// `IDictionary`2` member family, sequences through the duck-typed
/// enumerable probes, and function-typed globals through the delegate-shape
/// mapping in the call binder (#3184).
internal shared class SubmissionGlobalTypeProjection {
    /// Maps a prior-submission global's CLR-projected type back to its magic
    /// wrapper symbol when the source-side declaration says the global was a
    /// magic kind whose operations require symbol identity. Returns
    /// [`projected`](paramref) unchanged when no arm applies.
    /// @param projected The CLR-projected type the metadata read produced.
    /// @param clrFieldType The emitted field's CLR type, seen through the current resolver.
    /// @param declaredType The declaring submission's source-side type for the global (may be `null`).
    /// @param references The current compilation's reference resolver.
    /// @returns The reverse-projected type, or [`projected`](paramref) when no arm applies.
    internal func ReverseProject(
        projected TypeSymbol,
        clrFieldType Type,
        declaredType TypeSymbol?,
        references ReferenceResolver
    ) TypeSymbol {
        switch declaredType {
            case declaredChannel is ChannelTypeSymbol {
                if TryGetChannelElement(clrFieldType, out var elementClr, out var direction) &&
                    direction == declaredChannel.Direction &&
                    TryProjectComponent(elementClr, declaredChannel.ElementType, references, out var element) {
                    return ChannelTypeSymbol.Get(element, direction)
                }
            }
            case declaredSlice is SliceTypeSymbol {
                if clrFieldType != nil &&
                    clrFieldType.IsSZArray == true &&
                    TryProjectComponent(
                    clrFieldType.GetElementType(),
                    declaredSlice.ElementType,
                    references,
                    out var sliceElement
                ) {
                    return SliceTypeSymbol.Get(sliceElement)
                }
            }
            case declaredArray is ArrayTypeSymbol {
                // The CLR projection of `[N]T` is the same `T[]` a slice
                // projects to — the fixed length N exists only source-side,
                // so it is recovered from the declaration.
                if clrFieldType != nil &&
                    clrFieldType.IsSZArray == true &&
                    TryProjectComponent(
                    clrFieldType.GetElementType(),
                    declaredArray.ElementType,
                    references,
                    out var arrayElement
                ) {
                    return ArrayTypeSymbol.Get(arrayElement, declaredArray.Length)
                }
            }
        }
        return projected
    }

    // Projects one component (element) type of a magic wrapper through the
    // current resolver's metadata view, recursing so nested magic kinds
    // (e.g. `chan []int32`) keep their identity too.
    private func TryProjectComponent(
        clrType Type?,
        declaredComponent TypeSymbol,
        references ReferenceResolver,
        @NotNullWhen(true) out component TypeSymbol?
    ) bool {
        component = nil
        if clrType == nil {
            return false
        }
        let projected TypeSymbol? = ImportedTypeSymbol.NormalizeSemanticAggregate(
            TypeSymbol.FromClrTypeWithoutNullability(clrType, NullabilityFreeReason.CompilerProduced),
            clrType,
            references
        )
        if projected == nil || projected == TypeSymbol.Error || projected == TypeSymbol.Void {
            return false
        }
        component = ReverseProject(projected, clrType, declaredComponent, references)
        return true
    }

    // Matches the emitted backing shape of a channel type clause (ADR-0174 D2)
    // — a closed `Channel<T>` (chan[T]), `ChannelReader<T>` (in chan[T]) or
    // `ChannelWriter<T>` (out chan[T]) — by open-definition full name, so
    // types seen through a MetadataLoadContext still match. The runtime's
    // constructed `Chan<T>` is deliberately NOT matched: a global declared by
    // construction (`let ch = chan[T](1)`) keeps its imported class type so
    // `Length()`/`Capacity`/`Close()` stay bindable in later cells.
    private func TryGetChannelElement(
        clrFieldType Type,
        @NotNullWhen(true) out elementClr Type?,
        out direction ChannelDirection
    ) bool {
        elementClr = nil
        direction = ChannelDirection.Both
        if !(clrFieldType != nil && clrFieldType.IsGenericType == true) {
            return false
        }
        switch clrFieldType.GetGenericTypeDefinition().FullName {
            case "System.Threading.Channels.Channel`1" {
                direction = ChannelDirection.Both
            }
            case "System.Threading.Channels.ChannelReader`1" {
                direction = ChannelDirection.In
            }
            case "System.Threading.Channels.ChannelWriter`1" {
                direction = ChannelDirection.Out
            }
            default {
                return false
            }
        }
        elementClr = clrFieldType.GetGenericArguments()[0]
        return true
    }
}
