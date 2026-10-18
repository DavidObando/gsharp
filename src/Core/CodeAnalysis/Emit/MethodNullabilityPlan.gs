// <copyright file="MethodNullabilityPlan.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable

/// Issue #4988: the single decision of how a method signature's declared types
/// become `[NullableContext]` / `[Nullable]` metadata.
///
/// The per-position byte arrays come from (cref:NullableFlagsBuilder.Build);
/// this type adds what only a whole signature can decide, the way csc does: the
/// method-level context byte (the most common byte across the return and the
/// parameters), and which positions still need their own attribute under it.
/// It also says whether the return position needs a sequence-0 `Param` row,
/// which a MethodDef only has when something is attached to it.
///
/// Every MethodDef gsc mints plans its signature here, whatever declaration
/// produced it: a method with or without a body, an interface slot, a property
/// or event accessor, a delegate's `Invoke`, a constructor, or a member the
/// compiler synthesizes. Before #4988 each of those paths made the decision
/// itself, and the paths that never created a return row (an interface
/// method without a body, a delegate's `Invoke`, an auto-property getter)
/// exported `Task[Token?]` as `Task[Token]`.
/// @remarks Fields, properties and events have no member-level context: their
/// rows read the enclosing type's `[NullableContext(1)]`, so they use
/// (cref:NeedsAttribute) against (cref:NullableFlagsBuilder.NotAnnotated).
internal class MethodNullabilityPlan {
    private init(
        returnFlags ImmutableArray[uint8],
        parameterFlags ImmutableArray[ImmutableArray[uint8]],
        effectiveDefault uint8,
        contextByteToEmit uint8?
    ) {
        ReturnFlags = returnFlags
        ParameterFlags = parameterFlags
        EffectiveDefault = effectiveDefault
        ContextByteToEmit = contextByteToEmit
    }

    /// Gets the return position's DFS pre-order nullability bytes. Empty for
    /// `void` and for a return type that has no nullability positions.
    prop ReturnFlags ImmutableArray[uint8] {
        get;
    }

    /// Gets each emitted parameter's nullability bytes, in parameter order.
    prop ParameterFlags ImmutableArray[ImmutableArray[uint8]] {
        get;
    }

    /// Gets the byte every position of this method defaults to: the method's
    /// own context when (cref:ContextByteToEmit) is set, otherwise the
    /// enclosing type's (cref:NullableFlagsBuilder.NotAnnotated).
    prop EffectiveDefault uint8 {
        get;
    }

    /// Gets the `[NullableContext]` byte to stamp on the MethodDef, or
    /// `null` when the enclosing type's context already covers it.
    prop ContextByteToEmit uint8? {
        get;
    }

    /// Gets a value indicating whether the return position needs its own
    /// `[Nullable]`, and therefore a sequence-0 `Param` row to carry it.
    prop ReturnNeedsAttribute bool -> NeedsAttribute(ReturnFlags, EffectiveDefault)

    /// Gets a value indicating whether the parameter at [`index`](paramref)
    /// needs its own `[Nullable]`.
    /// @param index The zero-based index into (cref:ParameterFlags).
    /// @returns `true` when its bytes are not all the method's default.
    func ParameterNeedsAttribute(index int32) bool -> NeedsAttribute(ParameterFlags[index], EffectiveDefault)

    shared {
        /// Plans a signature from its declared return type and parameters.
        /// @param returnType The declared return type; `null` or `void` for none.
        /// @param parameters The parameters that get `Param` rows, in order.
        /// @returns The plan.
        func ForParameters(returnType TypeSymbol?, parameters IEnumerable[ParameterSymbol]) MethodNullabilityPlan {
            let parameterFlags = ImmutableArray.CreateBuilder[ImmutableArray[uint8]]()
            for parameter in parameters {
                parameterFlags.Add(NullableFlagsBuilder.Build(parameter.Type))
            }
            return FromFlags(ReturnFlagsOf(returnType), parameterFlags.ToImmutable())
        }

        /// Plans a signature whose return position's physical type differs from
        /// the declared one (an async kickoff returns its builder's task), so
        /// the caller supplies the return bytes.
        /// @param returnFlags The physical return position's bytes.
        /// @param parameters The parameters that get `Param` rows, in order.
        /// @returns The plan.
        func ForParameters(
            returnFlags ImmutableArray[uint8],
            parameters IEnumerable[ParameterSymbol]
        ) MethodNullabilityPlan {
            let parameterFlags = ImmutableArray.CreateBuilder[ImmutableArray[uint8]]()
            for parameter in parameters {
                parameterFlags.Add(NullableFlagsBuilder.Build(parameter.Type))
            }
            return FromFlags(returnFlags, parameterFlags.ToImmutable())
        }

        /// Whether a position needs its own `[Nullable]` under a context: it
        /// does unless every one of its bytes repeats that context, which
        /// is what a reader falls back to when the attribute is absent.
        /// @param flags The position's bytes.
        /// @param context The surrounding context byte.
        /// @returns `true` when the attribute must be emitted.
        func NeedsAttribute(flags ImmutableArray[uint8], context uint8) bool {
            if flags.IsDefaultOrEmpty {
                return false
            }
            for flag in flags {
                if flag != context {
                    return true
                }
            }
            return false
        }

        private func ReturnFlagsOf(returnType TypeSymbol?) ImmutableArray[uint8] -> if returnType == nil ||
            returnType == TypeSymbol.Void {
            ImmutableArray[uint8].Empty
        } else {
            NullableFlagsBuilder.Build(returnType)
        }

        /// Mirrors Roslyn's compaction: the most frequent byte across the
        /// return and parameter positions becomes the method's context, emitted
        /// only when it differs from the enclosing type's
        /// (cref:NullableFlagsBuilder.NotAnnotated). Ties keep the type's
        /// context, which emits the least metadata.
        private func FromFlags(
            returnFlags ImmutableArray[uint8],
            parameterFlags ImmutableArray[ImmutableArray[uint8]]
        ) MethodNullabilityPlan {
            const TypeDefault = NullableFlagsBuilder.NotAnnotated
            var countOblivious = 0
            var countNotAnnotated = 0
            var countAnnotated = 0
            let Tally = func (flags ImmutableArray[uint8]) {
                if flags.IsDefaultOrEmpty {
                    return
                }
                for b in flags {
                    switch b {
                        case 0 {
                            countOblivious++
                        }
                        case 1 {
                            countNotAnnotated++
                        }
                        case 2 {
                            countAnnotated++
                        }
                    }
                }
            }
            Tally(returnFlags)
            for flags in parameterFlags {
                Tally(flags)
            }
            var common = TypeDefault
            var best = countNotAnnotated
            if countAnnotated > best {
                common = NullableFlagsBuilder.Annotated
                best = countAnnotated
            }
            if countOblivious > best {
                common = NullableFlagsBuilder.Oblivious
            }
            let contextByte uint8? = if common == TypeDefault {
                nil
            } else {
                common
            }
            return MethodNullabilityPlan(returnFlags, parameterFlags, common, contextByte)
        }
    }
}
