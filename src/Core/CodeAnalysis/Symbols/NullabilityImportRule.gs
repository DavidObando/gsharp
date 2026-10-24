// <copyright file="NullabilityImportRule.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection

/// ADR-0193 §1: what a classified imported position becomes. This is the
/// representation-neutral half of (cref:NullabilityImportRule)'s
/// answer; each type model maps it onto its own types with a thin applier.
internal enum ImportedReferenceNullability {
    Unchanged,
    NotNull,
    Nullable,
    Platform
}

/// ADR-0193 §1: what is known about a type argument's kind at the point the
/// rule runs. Deliberately three-valued: an unconstrained type parameter is
/// neither a reference nor a value type, and folding it into either neighbour
/// is the PR #4362 round-1 regression (`Min()` on an unconstrained
/// `T` becoming `T?`).
internal enum TypeArgumentKind {
    Reference,
    Value,
    Unknown
}

/// ADR-0193 §1 — <b>the</b> producer choke point: the single decision
/// <em>"a position whose declaration is classified as S, substituted (or not)
/// with argument A, gets which reference nullability?"</em>.
///
/// The decision ((cref:DecideConcrete), (cref:DecideOpenSlot))
/// takes and returns no type-model value, so gsc's (cref:TypeSymbol)
/// walkers and cs2gs's `GTypeReference` applier share it. gsc's appliers
/// ((cref:ApplyConcrete), (cref:ApplyOpenSlot), and the byte-level
/// (cref:ApplyOpenSlotToFlags) the projection reader needs) are the only
/// places a Layer 1 walker turns a classified position into a wrapper.
///
/// <b>Platform-types semantics only</b> (ADR-0193 owner decision 2). There is
/// no (cref:NullabilityOptions) branch in this class and none may be
/// added: the legacy `--nullability=enabled` reading is retired by #4372,
/// and the walkers keep their own legacy arm until then.
internal shared class NullabilityImportRule {
    /// The C# nullable-metadata byte for a not-annotated position.
    private const NotAnnotatedByte uint8 = uint8(1)

    /// The C# nullable-metadata byte for an annotated position.
    private const AnnotatedByte uint8 = uint8(2)

    /// ADR-0186 §2's table for a <em>concrete</em> position — one whose type
    /// the declaration itself spells, rather than an open slot a type argument
    /// fills.
    /// @param state What the declaration says about the position.
    /// @param kind The position's kind. A concrete position is a closed type and so is
    /// normally (cref:TypeArgumentKind.Reference) or
    /// (cref:TypeArgumentKind.Value); a CLR generic parameter read
    /// directly off an open definition (not substituted) is
    /// (cref:TypeArgumentKind.Unknown) and is read as the declaration
    /// spells it, exactly like a reference position.
    /// @returns The decision.
    internal func DecideConcrete(state ClrNullabilityState, kind TypeArgumentKind) ImportedReferenceNullability {
        if kind == TypeArgumentKind.Value {
            return ImportedReferenceNullability.Unchanged
        }
        return switch state {
            case ClrNullabilityState.NotAnnotated: ImportedReferenceNullability.NotNull
            case ClrNullabilityState.Annotated: ImportedReferenceNullability.Nullable
            default: ImportedReferenceNullability.Platform
        }
    }

    /// ADR-0186 §2's open-type-parameter carve-out plus ADR-0193 owner
    /// decision 1: an open slot widens to `T?` only for an explicit
    /// `[Nullable(2)]`, and only when the argument is known to be a
    /// reference type. Every other cell leaves the argument to speak for
    /// itself.
    /// ```xmldoc
    /// <list type="table">
    /// <listheader><term>Declared</term><description>Reference / Value / Unknown</description></listheader>
    /// <item><term><c>Annotated</c></term><description><c>Nullable</c> / <c>Unchanged</c> / <c>Unchanged</c></description></item>
    /// <item><term><c>NotAnnotated</c></term><description><c>Unchanged</c> in every column</description></item>
    /// <item><term><c>Oblivious</c> / absent</term><description><c>Unchanged</c> in every column</description></item>
    /// </list>
    /// ```
    ///
    /// The `Annotated` × `Unknown` cell is `Unchanged` by the
    /// owner's 2026-09-24 ruling (ADR-0193 Open question 1). Revisiting it as
    /// `Platform` is #4385, a Phase 3 exit criterion — not this class's
    /// call to make on its own.
    /// @param declaredState What the open declaration says about the slot.
    /// @param argumentKind What is known about the substituted argument.
    /// @returns The decision.
    internal func DecideOpenSlot(
        declaredState ClrNullabilityState,
        argumentKind TypeArgumentKind
    ) ImportedReferenceNullability -> if declaredState == ClrNullabilityState.Annotated &&
        argumentKind == TypeArgumentKind.Reference {
        ImportedReferenceNullability.Nullable
    } else {
        ImportedReferenceNullability.Unchanged
    }

    /// gsc's applier for a concrete position: (cref:DecideConcrete)
    /// mapped onto (cref:TypeSymbol).
    /// @param baseSymbol The unwrapped position type.
    /// @param state What the declaration says about the position.
    /// @returns The nullability-aware type symbol.
    internal func ApplyConcrete(baseSymbol TypeSymbol, state ClrNullabilityState) TypeSymbol -> Apply(
        baseSymbol,
        DecideConcrete(state, ClassifyArgument(baseSymbol))
    )

    /// gsc's applier for an open slot: (cref:DecideOpenSlot) mapped onto
    /// (cref:TypeSymbol). `Unchanged` returns
    /// [`argument`](paramref) exactly as given — a `string?`
    /// argument stays `string?` in every row.
    /// @param argument The substituted type argument.
    /// @param declaredState What the open declaration says about the slot.
    /// @returns The nullability-aware type symbol.
    internal func ApplyOpenSlot(argument TypeSymbol, declaredState ClrNullabilityState) TypeSymbol -> Apply(
        argument,
        DecideOpenSlot(declaredState, ClassifyArgument(argument))
    )

    /// The inverse of (cref:ApplyOpenSlot), for method type-argument
    /// inference: given the argument a call passes to an open slot, the type
    /// argument that slot must be closed over. Where (cref:DecideOpenSlot)
    /// widens a `Reference` argument to `T?`, a `X?` argument
    /// passed to that slot supplies `T := X`. This is C#'s rule:
    /// `Required<T>(T? value) where T : class` called with a
    /// `Type?` infers `T` as `Type`, so the call returns
    /// `Type`. Every other cell hands the argument back unchanged. A value
    /// type `int?` is its own argument (`T := int?` for an
    /// unconstrained `T?`), and so is a `T!` platform value.
    /// @param argument The argument's type at the slot.
    /// @param declaredState What the open declaration says about the slot.
    /// @returns The type the slot's type parameter is inferred as.
    internal func InferOpenSlotArgument(
        argument TypeSymbol,
        declaredState ClrNullabilityState
    ) TypeSymbol -> if argument is NullableTypeSymbol nullable &&
        DecideOpenSlot(declaredState, ClassifyArgument(nullable)) == ImportedReferenceNullability.Nullable {
        nullable.UnderlyingType
    } else {
        argument
    }

    /// ADR-0193 amendment (2026-09-26, #4451, owner decision): an explicit
    /// method type argument that closes an open slot the declaration leaves
    /// oblivious reads as `T!`. `Ob.WrapList[string](x)` over an
    /// oblivious `List<T> WrapList<T>(T value)` binds
    /// `T = string!`: its parameter takes a nil unchecked, as the C#
    /// does, and its return is `List[string!]`, so a nil element is
    /// checked where it is read. This narrows (cref:DecideOpenSlot)'s
    /// `Unchanged` only for an explicit reference type argument at an
    /// oblivious slot; an annotated or enabled slot, a value-type argument,
    /// and an argument that already states its nullability (`string?`,
    /// `string!`) are unchanged. Inference reaches the same answer on
    /// its own (#4459: an oblivious slot keeps the argument's `T!`).
    /// @param argument The explicit type argument.
    /// @param declaredState What the open declaration says about the slot the type parameter fills.
    /// @returns The type the type parameter is bound to.
    internal func ApplyExplicitOpenSlotArgument(
        argument TypeSymbol,
        declaredState ClrNullabilityState
    ) TypeSymbol -> if declaredState == ClrNullabilityState.Oblivious &&
        !(argument is NullableTypeSymbol) &&
        !(argument is PlatformTypeSymbol) &&
        ClassifyArgument(argument) == TypeArgumentKind.Reference {
        Apply(argument, ImportedReferenceNullability.Platform)
    } else {
        argument
    }

    /// Issue #4403: the direct parameter reader lifts a reference parameter
    /// whose default value is `null` to `T?`. That is a G#-side
    /// inference from the default value, not a classified metadata position,
    /// so it is named here rather than passed off as an `Annotated`
    /// state. Only `ClrNullability.GetParameterTypeSymbol` applies it
    /// today; #4403 decides whether the other readers should.
    /// @param parameterType The parameter's already-read type.
    /// @returns The parameter type, stated nullable.
    internal func ApplyNullDefaultLift(parameterType TypeSymbol) TypeSymbol -> NullableTypeSymbol.Get(parameterType)

    /// The (cref:ImportedReferenceNullability.Unchanged) decision for a
    /// walker that peeled its input's own `?` to rebuild the core under
    /// it (merging the arguments of a `List[string]?`, say): the rebuilt
    /// core gets the input's `?` back, whether it was a reference or a
    /// value-type one. No metadata byte is consulted — the input already
    /// stated it.
    /// @param rebuiltCore The rebuilt, unwrapped core.
    /// @returns The core, stated nullable again.
    internal func RestorePeeledNullable(rebuiltCore TypeSymbol) TypeSymbol -> NullableTypeSymbol.Get(rebuiltCore)

    /// The byte-domain applier for an open slot, for the projection reader
    /// (`ClrNullability.ProjectNullableFlags`), which rewrites a flag
    /// array rather than building a (cref:TypeSymbol). The argument is
    /// an erased closed CLR type and so states no nullability of its own:
    /// every position in it reads as not-annotated, which is how the merge
    /// reader reads the same argument after (cref:TypeSymbol.FromClrType).
    /// A `Nullable` decision annotates the argument's root only — never
    /// its inner positions, which belong to the argument, not the slot.
    /// @param argument The substituted closed CLR argument.
    /// @param declaredState What the open declaration says about the slot.
    /// @returns One byte per nullable-metadata position of [`argument`](paramref).
    internal func ApplyOpenSlotToFlags(argument Type, declaredState ClrNullabilityState) ImmutableArray[uint8] {
        let flags = ClrNullability.ExpandNullableFlags(argument, ImmutableArray.Create(NotAnnotatedByte))
        if DecideOpenSlot(declaredState, ClassifyArgument(argument)) != ImportedReferenceNullability.Nullable ||
            flags.IsEmpty {
            return flags
        }
        // Only a Reference argument decides `Nullable`, and a reference type
        // always owns byte 0 of its own subtree.
        let builder = flags.ToBuilder()
        builder[0] = AnnotatedByte
        return builder.MoveToImmutable()
    }

    /// Whether [`argument`](paramref) is not a substitution at all but the
    /// open slot's own generic parameter left in place — a method-level
    /// `T` read with no method type arguments to map it through, or the
    /// same parameter reached through a closed declaring type. Nothing arrived
    /// to speak for such a slot, so the walkers read it as the declaration
    /// spells it (a concrete position, (cref:DecideConcrete)), exactly
    /// as the direct reader reads the open definition, rather than as an
    /// (cref:TypeArgumentKind.Unknown) argument.
    /// @param argument The CLR type found at the slot.
    /// @param slot The open slot's generic parameter.
    /// @returns `true` when no substitution happened.
    internal func IsUnsubstitutedSlot(argument Type, slot Type) bool {
        if !argument.IsGenericParameter ||
            !slot.IsGenericParameter ||
            argument.GenericParameterPosition != slot.GenericParameterPosition {
            return false
        }
        // A TYPE's parameter is the same slot only when the declaring types
        // share a generic definition: `Base<T>` and `Derived<T>` both declare
        // a type-level `T` at ordinal 0, and an inherited `Base<T>` member
        // read through `Derived<T>` IS a substitution.
        //
        // A METHOD's parameter cannot be compared by owner here. The argument
        // reaches the walkers as `ImportedTypeSymbol.Get(parameter).ClrType`,
        // and that cache keys generic parameters structurally, so the Type it
        // hands back may be a different method's same-named parameter. A
        // method-level parameter is never substituted by another method's
        // parameter (method substitution supplies symbols), so the name and
        // ordinal are the identity that survives.
        if argument.DeclaringMethod != nil || slot.DeclaringMethod != nil {
            return argument.DeclaringMethod != nil && slot.DeclaringMethod != nil && string.Equals(
                argument.Name,
                slot.Name,
                StringComparison.Ordinal
            )
        }
        return argument.DeclaringType is {} argumentOwner &&
            slot.DeclaringType is {} slotOwner &&
            ClrTypeUtilities
            .AreSame(
            if argumentOwner.IsGenericType {
                argumentOwner.GetGenericTypeDefinition()
            } else {
                argumentOwner
            },
            if slotOwner.IsGenericType {
                slotOwner.GetGenericTypeDefinition()
            } else {
                slotOwner
            }
        )
    }

    /// Classifies a (cref:TypeSymbol) into (cref:TypeArgumentKind).
    /// The one classifier the appliers and (cref:PlatformTypeSymbol.Get)'s
    /// value-type normalisation share, so the two cannot disagree about what a
    /// value type is.
    /// @param type The type to classify.
    /// @returns What is known about its kind.
    internal func ClassifyArgument(type TypeSymbol) TypeArgumentKind {
        switch type {
            case nullable is NullableTypeSymbol {
                return if NullableLifting.IsAnyValueTypeNullable(nullable) {
                    TypeArgumentKind.Value
                } else {
                    ClassifyArgument(nullable.UnderlyingType)
                }
            }
            case platform is PlatformTypeSymbol {
                return ClassifyArgument(platform.UnderlyingType)
            }
            case annotated is NullabilityAnnotatedTypeSymbol {
                return ClassifyArgument(annotated.BaseType)
            }
            case parameter is TypeParameterSymbol {
                if parameter.HasValueTypeConstraint || parameter.HasUnmanagedConstraint {
                    return TypeArgumentKind.Value
                }
                return if parameter.HasReferenceTypeConstraint ||
                    parameter.ClassConstraint != nil ||
                    parameter.DependentBoundProvesReferenceType {
                    TypeArgumentKind.Reference
                } else {
                    TypeArgumentKind.Unknown
                }
            }
            case tuple is TupleTypeSymbol {
                // A G# tuple is a ValueTuple, and a symbolic one has no
                // ClrType to say so. But issue #1922 also maps the reference
                // type `System.Tuple<…>` onto TupleTypeSymbol, and that one is
                // a reference position — its ClrType is the authority when
                // there is one.
                return if tuple.ClrType is {IsValueType: false} {
                    TypeArgumentKind.Reference
                } else {
                    TypeArgumentKind.Value
                }
            }
            case PointerTypeSymbol, FunctionPointerTypeSymbol {
                // Pointers are not reference types (issue #2176).
                return TypeArgumentKind.Value
            }
            case modified is MetadataModifiedTypeSymbol {
                return ClassifyArgument(modified.Unmodified)
            }
            case definition is MetadataTypeSymbol {
                return if definition.Kinds.IsValueType {
                    TypeArgumentKind.Value
                } else {
                    TypeArgumentKind.Reference
                }
            }
            case constructed is ConstructedMetadataTypeSymbol {
                return ClassifyArgument(constructed.Definition)
            }
            case _ is MetadataFunctionPointerTypeSymbol {
                return TypeArgumentKind.Value
            }
            case imported is ImportedTypeSymbol when imported.OpenDefinition?.IsValueType == true {
                return TypeArgumentKind.Value
            }
            case _ is StructSymbol or _ is EnumSymbol {
                return if type.IsValueType {
                    TypeArgumentKind.Value
                } else {
                    TypeArgumentKind.Reference
                }
            }
        }
        return if type.ClrType is {} clr {
            ClassifyArgument(clr)
        } else {
            TypeArgumentKind.Reference
        }
    }

    /// Classifies a reflected CLR type into (cref:TypeArgumentKind).
    /// @param type The CLR type to classify.
    /// @returns What is known about its kind.
    internal func ClassifyArgument(type Type) TypeArgumentKind {
        if type.IsGenericParameter {
            return ClassifyGenericParameter(type, visited: nil)
        }
        return if type.IsValueType || type.IsPointer || type.IsFunctionPointer {
            TypeArgumentKind.Value
        } else {
            TypeArgumentKind.Reference
        }
    }

    /// Classifies a reflected generic parameter from its constraints, following
    /// a dependent bound (`where T : U`) transitively. C# propagates a
    /// bounding parameter's `class`/`struct` constraint to the
    /// bounded one, which is exactly what
    /// (cref:TypeParameterSymbol.DependentBoundProvesReferenceType)
    /// answers for the (cref:TypeSymbol) overload; the two must agree.
    /// A cycle is broken by visited-set, answering `Unknown`.
    private func ClassifyGenericParameter(parameter Type, visited HashSet[Type]?) TypeArgumentKind {
        var visited = visited
        let attributes = parameter.GenericParameterAttributes
        if (attributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0 {
            return TypeArgumentKind.Value
        }
        if (attributes & GenericParameterAttributes.ReferenceTypeConstraint) != 0 {
            return TypeArgumentKind.Reference
        }
        for constraint in parameter.GetGenericParameterConstraints() {
            if constraint.IsGenericParameter {
                visited ??= HashSet[Type](ReferenceEqualityComparer.Instance){parameter}
                if visited!!.Add(constraint) &&
                    ClassifyGenericParameter(constraint, visited) == TypeArgumentKind.Reference {
                    return TypeArgumentKind.Reference
                }
                continue
            }
            if constraint.IsClass &&
                constraint.FullName is not("System.Object" or "System.ValueType" or "System.Enum") {
                return TypeArgumentKind.Reference
            }
        }
        return TypeArgumentKind.Unknown
    }

    private func Apply(symbol TypeSymbol, decision ImportedReferenceNullability) TypeSymbol -> switch decision {
        case ImportedReferenceNullability.Nullable: cast[TypeSymbol](NullableTypeSymbol.Get(symbol))
        case ImportedReferenceNullability.Platform: PlatformTypeSymbol.Get(symbol)
        default: symbol
    }
}
