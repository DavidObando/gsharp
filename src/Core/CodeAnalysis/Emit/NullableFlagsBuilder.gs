// <copyright file="NullableFlagsBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Linq

/// Issue #834: computes the C#-compatible
/// `[System.Runtime.CompilerServices.NullableAttribute]` byte array
/// (DFS pre-order) for a GSharp (cref:TypeSymbol). The bytes use the
/// well-known encoding:
/// - `0` — oblivious (no nullability information), including a non-Nullable closed generic value type's
/// leading placeholder and a struct-constrained generic parameter's slot.
/// - `1` — not-annotated (non-nullable reference / open type parameter).
/// - `2` — annotated (nullable reference / nullable open type parameter).
///
/// Layout mirrors the C# compiler: byte 0 belongs to the outer type when that
/// type occupies a reference-type position. Closed generic value types
/// contribute a leading oblivious placeholder byte before their arguments,
/// except metadata-transparent `Nullable<T>`, which contributes
/// only T's subtree. Struct-constrained generic parameters contribute one
/// oblivious slot. Non-generic value types contribute none (matches
/// (cref:ClrNullability.CountNullabilityBytes(System.Type))).
///
/// Per-position attributes are intentionally narrow — they only describe what
/// C#'s nullable flow analysis needs to see at a parameter / return slot. They
/// do not depend on whether the receiver, declaring type, or assembly has its
/// own `NullableContextAttribute`; the per-slot byte array overrides any
/// surrounding context.
internal shared class NullableFlagsBuilder {
    /// The byte used for oblivious positions and generic value-type placeholders.
    internal const Oblivious uint8 = uint8(0)

    /// The byte the C# compiler uses for non-nullable reference positions.
    internal const NotAnnotated uint8 = uint8(1)

    /// The byte the C# compiler uses for nullable reference positions.
    internal const Annotated uint8 = uint8(2)

    /// Computes the DFS pre-order nullable byte array for the supplied
    /// (cref:TypeSymbol). Returns an empty array when the type
    /// contributes no nullable-metadata positions (e.g. a non-generic value
    /// type) — in which case no
    /// `NullableAttribute` need be emitted.
    /// @param type The parameter / return / field / property type to inspect.
    /// @returns The flags array — possibly empty; never `default`.
    internal func Build(type TypeSymbol) ImmutableArray[uint8] {
        let builder = ImmutableArray.CreateBuilder[uint8]()
        Append(type, builder, isRoot: true)
        return builder.ToImmutable()
    }

    /// Merges receiver-projected generic nullability with declaration-site
    /// nullable metadata node by node. A substituted type-parameter subtree is
    /// kept intact; the declaration's byte annotates only that subtree's root.
    /// @param projectedType Type after receiver generic substitution.
    /// @param layoutType Open declaration type defining metadata positions.
    /// @param declarationFlags Declaration nullable flags.
    /// @returns Combined nullability-aware type.
    @NullabilityFunnel
    internal func MergeDeclarationNullability(
        projectedType TypeSymbol,
        layoutType Type,
        declarationFlags ImmutableArray[uint8]
    ) TypeSymbol {
        let ApplyRootAnnotation = func (projected TypeSymbol, flag uint8) TypeSymbol {
            // Issue #3705 family 2: ask the single #1354 predicate rather than
            // open-coding `flag != Annotated`. The two differ on the oblivious
            // byte `0`, which csc emits explicitly for a `#nullable disable`
            // member of a `[NullableContext(1)]` type — a NON-empty flags array
            // the removed short-circuit above never even saw.
            //
            // ADR-0186 §2: the predicate is now the three-state classifier, and
            // this — the third of `ClrNullability`'s reading paths — defers to
            // it exactly as the other two do, so the three cannot drift on what
            // byte `0` means. `SymbolForState` holds the one answer that
            // changes.
            let state = ClrNullability.ClassifyFlag(flag)
            if state == ClrNullabilityState.NotAnnotated ||
                projected is NullableTypeSymbol ||
                projected is PlatformTypeSymbol {
                return projected
            }
            let isValueType = switch projected {
                case parameter is TypeParameterSymbol: parameter.HasValueTypeConstraint
                case structure is StructSymbol: !structure.IsClass
                case _ is EnumSymbol: true
                default: projected.ClrType?.IsValueType == true
            }
            return if isValueType {
                projected
            } else {
                ClrNullability.SymbolForState(projected, state)
            }
        }
        // Issue #3705 family 2: no short-circuit on empty flags. An absent
        // `[Nullable]` is not "no information" in G# — issue #1354 makes it
        // mean `T?`, and `ExpandNullableFlags` already expands empty metadata
        // to a full array of `2`s for exactly that reason. Returning
        // `projectedType` here is what made a member reached through a
        // receiver-substituting reader (field, constrained call, deconstruct
        // out-parameter) keep the pre-#1354 non-null answer while its
        // ClrNullability-read siblings said `T?`.
        let declaredFlags = ClrNullability.ExpandNullableFlags(layoutType, declarationFlags)
        // The same expansion read LITERALLY: absent positions stay oblivious
        // instead of defaulting to `2`. Only the open-type-parameter carve-out
        // below consults this, because it is the one position where "the
        // declaration was silent" must not be read as "the declaration said
        // `T?`" — and the default expansion cannot tell those apart.
        let literalFlags = ClrNullability.ExpandNullableFlags(layoutType, declarationFlags, absentFill: Oblivious)
        var position = 0
        let ReadConcretePosition = func (layout Type) TypeSymbol {
            let merged = ClrNullability.SymbolFromFlagsOffset(layout, declaredFlags, position)
            position += ClrNullability.CountNullabilityBytes(layout)
            return merged
        }
        let SkipChildren = func (projected TypeSymbol, childLayout Type) TypeSymbol {
            position += ClrNullability.CountNullabilityBytes(childLayout)
            return projected
        }
        let Merge = func (projected TypeSymbol, layout Type) TypeSymbol {
            if NullableLifting.GetValueTypeNullableUnderlyingClr(layout) is {} nullableUnderlying {
                return Merge(projected, nullableUnderlying)
            }
            if layout.IsByRef {
                let element = layout.GetElementType()!!
                return ByRefTypeSymbol.Get(
                    if projected is ByRefTypeSymbol byRef {
                        Merge(byRef.PointeeType, element)
                    } else {
                        ReadConcretePosition(element)
                    }
                )
            }
            if layout.IsGenericParameter {
                // Issue #3705 family 2 — the ONE carve-out from the #1354 rule,
                // and it is principled rather than pragmatic.
                //
                // #1354 is a statement about CONCRETE reference positions in
                // imported metadata: "unannotated means the declarer told us
                // nothing, so assume `T?`". An OPEN type-parameter position is
                // not such a position. Its nullability is supplied by the type
                // ARGUMENT at substitution — which carries its own annotation —
                // so reading the declaration's missing byte as `K?` would
                // overwrite the caller's answer with a guess.
                //
                // It is also unsound in a way the concrete case is not: an
                // unconstrained `K` may be substituted with a VALUE type, where
                // `K?` silently means `Nullable<K>` and changes the contract.
                // (`ApplyRootAnnotation`'s value-type guard cannot catch this —
                // it inspects the still-open parameter, which has no `struct`
                // constraint to see.) This is what `Issue3311…GenericFunc_Keys_
                // FullyOpen_ReturnsFirstKey_As_K` pins: `map[K, V].Keys` must
                // iterate as `K`, not `K?`.
                //
                // So an open parameter slot keeps the pre-#1354 reading: widen
                // only for an EXPLICIT `[Nullable(2)]`, which is the declarer
                // genuinely saying `K?`. Absent and oblivious leave it alone.
                // Read LITERALLY: `declaredFlags` would show a fabricated `2`
                // here for a declaration that said nothing at all, which is the
                // very case the carve-out exists to leave alone.
                //
                // ADR-0186 §2 leaves this carve-out exactly as it is: an open
                // slot still widens only for an EXPLICIT `[Nullable(2)]`. There
                // is no `K!` for the same reason there is no `K?` here — the
                // answer arrives with the type argument. Routed through the
                // classifier only so no byte comparison survives outside it.
                //
                // ADR-0193 §1: under platform types the decision is
                // `NullabilityImportRule.ApplyOpenSlot`'s. That differs from
                // the legacy arm below in one cell: an explicit `2` over an
                // argument whose kind is not known (an unconstrained G# type
                // parameter) now leaves it alone rather than widening it to
                // `K?` — the owner's ruling on ADR-0193 Open question 1, and
                // the hazard the paragraph above names.
                //
                // Only a SUBSTITUTED slot is an open slot. When the projection
                // left the declaration's own generic parameter in place (a
                // method-level `T` with no method type arguments to map it
                // through), nothing arrived to speak for the slot, and it reads
                // as the declaration spells it — exactly as the direct reader
                // reads the same open definition. `adapt[I](...)` compares
                // `T? Echo<T>` with `T Echo<T>` this way.
                let parameterFlag = literalFlags[position++]
                let unsubstituted = !(projected is TypeParameterSymbol) &&
                    projected.ClrType is {} self &&
                    NullabilityImportRule.IsUnsubstitutedSlot(self, layout)
                if NullabilityOptions.PlatformTypesEnabled && !unsubstituted {
                    return NullabilityImportRule.ApplyOpenSlot(projected, ClrNullability.ClassifyFlag(parameterFlag))
                }
                return if ClrNullability.ClassifyFlag(parameterFlag) == ClrNullabilityState.Annotated {
                    ApplyRootAnnotation(projected, parameterFlag)
                } else {
                    projected
                }
            }
            if layout.IsFunctionPointer && projected is FunctionPointerTypeSymbol pointer {
                position++
                let returnType = Merge(pointer.ReturnType, layout.GetFunctionPointerReturnType())
                let layouts = layout.GetFunctionPointerParameterTypes()
                let parameters = ImmutableArray.CreateBuilder[TypeSymbol](layouts.Length)
                for var i = 0; i < layouts.Length; i++ {
                    parameters.Add(Merge(pointer.ParameterTypes[i], layouts[i]))
                }
                return pointer.WithSignature(parameters.MoveToImmutable(), returnType)
            }
            if layout.IsPointer && projected is PointerTypeSymbol pointer {
                position++
                return PointerTypeSymbol.Get(Merge(pointer.PointeeType, layout.GetElementType()!!))
            }
            if layout.IsArray {
                // Issues #4402/#4449: FromClrType represents a concrete array
                // as an imported CLR type, not one of the symbolic array
                // shapes. With no open slot to preserve, let the canonical
                // direct funnel reader decode the complete subtree instead of
                // skipping its child.
                if !layout.ContainsGenericParameters &&
                    !(projected is ArrayTypeSymbol) &&
                    !(projected is SliceTypeSymbol) &&
                    !(projected is RectangularArrayTypeSymbol) {
                    return ReadConcretePosition(layout)
                }
                let flag = declaredFlags[position++]
                let elementLayout = Invariant.Required(
                    layout.GetElementType(),
                    "an array type has an element type",
                    expression: "layout.GetElementType()"
                )
                let merged = switch projected {
                    case array is ArrayTypeSymbol: cast[TypeSymbol](
                        ArrayTypeSymbol.Get(Merge(array.ElementType, elementLayout), array.Length)
                    )
                    case slice is SliceTypeSymbol: cast[TypeSymbol](
                        SliceTypeSymbol.Get(Merge(slice.ElementType, elementLayout))
                    )
                    case rectangular is RectangularArrayTypeSymbol: cast[TypeSymbol](
                        RectangularArrayTypeSymbol.Get(Merge(rectangular.ElementType, elementLayout), rectangular.Rank)
                    )
                    default: SkipChildren(projected, elementLayout)
                }
                return if layout.IsValueType {
                    merged
                } else {
                    ApplyRootAnnotation(merged, flag)
                }
            }
            let isClosedGeneric = layout.IsGenericType && !layout.IsGenericTypeDefinition
            if isClosedGeneric {
                let nullable NullableTypeSymbol? = projected as NullableTypeSymbol
                let core = nullable?.UnderlyingType ?? projected
                if core is TupleTypeSymbol tuple {
                    let start = position
                    var index = 0
                    let merged = ClrNullability.MapTupleTypeSymbol(
                        layout,
                        start,
                        (argument Type, offset int32) -> {
                            position = offset
                            return Merge(tuple.ElementTypes[index++], argument)
                        },
                        tuple.ElementNames
                    )
                    position = start + ClrNullability.CountNullabilityBytes(layout)
                    return if nullable != nil {
                        NullabilityImportRule.RestorePeeledNullable(merged)
                    } else {
                        merged
                    }
                }
                // The corresponding concrete ValueTuple shape is a
                // TupleTypeSymbol, so the ImportedTypeSymbol-only recursion
                // below cannot carry its element flags.
                if !layout.ContainsGenericParameters && !(core is ImportedTypeSymbol) {
                    let concrete = ReadConcretePosition(layout)
                    return if nullable != nil && layout.IsValueType {
                        NullabilityImportRule.RestorePeeledNullable(concrete)
                    } else {
                        concrete
                    }
                }
                let flag = declaredFlags[position++]
                let layoutArguments = layout.GetGenericArguments()
                var merged = core
                if core is ImportedTypeSymbol imported && imported.ClrType is Type importedClr {
                    var projectedArguments = imported.TypeArguments
                    if projectedArguments.IsDefaultOrEmpty &&
                        importedClr.IsGenericType &&
                        !importedClr
                        .IsGenericTypeDefinition {
                        projectedArguments = importedClr
                            .GetGenericArguments()
                            .Select(TypeSymbol.FromClrType)
                            .ToImmutableArray()
                    }
                    if projectedArguments.Length == layoutArguments.Length {
                        let arguments = ImmutableArray.CreateBuilder[TypeSymbol](layoutArguments.Length)
                        for var i = 0; i < layoutArguments.Length; i++ {
                            arguments.Add(Merge(projectedArguments[i], layoutArguments[i]))
                        }
                        merged = ImportedTypeSymbol.GetConstructed(
                            importedClr,
                            imported.OpenDefinition ?? layout.UnderlyingSystemType.GetGenericTypeDefinition(),
                            arguments.MoveToImmutable()
                        )
                    } else {
                        for argument in layoutArguments {
                            position += ClrNullability.CountNullabilityBytes(argument)
                        }
                    }
                } else {
                    for argument in layoutArguments {
                        position += ClrNullability.CountNullabilityBytes(argument)
                    }
                }
                if nullable != nil {
                    merged = NullabilityImportRule.RestorePeeledNullable(merged)
                }
                return if layout.IsValueType {
                    merged
                } else {
                    ApplyRootAnnotation(merged, flag)
                }
            }
            if !layout.IsValueType {
                return ApplyRootAnnotation(projected, declaredFlags[position++])
            }
            return projected
        }
        return Merge(projectedType, layoutType)
    }

    private func Append(type TypeSymbol?, builder ImmutableArray[uint8].Builder, isRoot bool = false) {
        if type == nil {
            return
        }
        if type is PlatformTypeSymbol platform {
            // ADR-0186 §8's third round-trip value: an oblivious position is
            // emitted as the oblivious byte `0`, so it re-imports as `T!`.
            //
            // Step 1 refused this path outright with a `NotSupportedException`,
            // on the (correct at the time) reasoning that the alternative
            // then available was the fall-through to `AppendClrType`, which
            // writes byte `1` — NON-NULL. That is the worst possible encoding
            // of "nobody said": it launders an unknown into a guarantee, in
            // metadata, where the next reader has no way to tell it was a
            // guess. ADR-0186 exists because that conversion happened once
            // already, and that constraint has not moved: **never `1`**.
            //
            // The refusal became unshippable at step 3. `PlatformTypeSymbol`
            // reaches the emitter from ordinary default-on source, not only
            // from §9's not-yet-existing oblivious scopes: any inferred local
            // whose initializer is an oblivious CLR call (`let s =
            // DeferFixture.Snapshot()`) has type `string!`, and the moment
            // that local is captured — a closure display class, an async
            // state machine, a script's result slot — its type is written to
            // metadata as a synthesized member's signature.
            //
            // §8 sanctions exactly two shapes for an oblivious declaration:
            // emit nothing at all (csc's `#nullable disable` shape), or "an
            // explicit `[NullableContext(0)]` with byte `0` for oblivious
            // positions in any per-member array", and says both "read back as
            // `T!` under §2's table ... so either is correct and the choice is
            // an emit-size question". This is the per-position half of the
            // second shape, and nothing more: the type-level context byte and
            // §9's scope mechanism remain step 5's work. `ClassifyPosition`
            // reads byte `0` as `ClrNullabilityState.Oblivious` and
            // `SymbolForState` maps that back to `T!`, so the round trip is
            // total rather than merely non-lossy in the safe direction.
            //
            // Value types are excluded by §2 (there is no `int32!`), so unlike
            // the `NullableTypeSymbol` arm below there is no `Nullable<T>`
            // lowering case to consider.
            let platformInner = platform.UnderlyingType
            builder.Add(Oblivious)
            if platformInner is NullabilityAnnotatedTypeSymbol annotatedPlatformInner {
                AppendAnnotatedTail(
                    annotatedPlatformInner,
                    builder,
                    allowScalarCompression: isRoot,
                    uniformFlag: Oblivious
                )
            } else {
                AppendGenericArguments(platformInner, builder)
            }
            return
        }
        // Imported wrapper that already carries the C# DFS byte array — pass
        // physical flags through verbatim. An empty wrapper represents
        // absent/oblivious metadata; expand it using the importer's existing
        // nullable-by-default semantics before re-emission.
        if type is NullabilityAnnotatedTypeSymbol annotated {
            if isRoot && !annotated.NullableFlags.IsDefaultOrEmpty {
                builder.AddRange(annotated.NullableFlags)
            } else if annotated.ClrType != nil {
                builder.AddRange(ClrNullability.ExpandNullableFlags(annotated.ClrType, annotated.NullableFlags))
            }
            return
        }
        if type is NullableTypeSymbol nullable {
            let inner = nullable.UnderlyingType
            // `T?` over a struct-constrained type parameter lowers to
            // `Nullable<T>` at the signature level. Nullable<T> is transparent
            // in nullable metadata: recurse into T at the same position.
            if IsValueTypeNullableLowering(inner) {
                Append(inner, builder, isRoot)
                return
            }
            // Reference-position annotated as nullable.
            builder.Add(Annotated)
            if inner is NullabilityAnnotatedTypeSymbol annotatedInner {
                AppendAnnotatedTail(annotatedInner, builder, allowScalarCompression: isRoot)
            } else {
                AppendGenericArguments(inner, builder)
            }
            return
        }
        if type is TypeParameterSymbol tp {
            if tp.HasValueTypeConstraint {
                // CLR generic parameters with a `struct` constraint occupy an
                // explicit oblivious placeholder position.
                builder.Add(Oblivious)
                return
            }
            builder.Add(NotAnnotated)
            return
        }
        if type is ByRefTypeSymbol byRef {
            // A `ref T` parameter shape is encoded at the parent (parameter)
            // encoder level via `isByRef: true`; the nullability byte set is
            // that of the pointee T.
            Append(byRef.PointeeType, builder)
            return
        }
        if type is FunctionPointerTypeSymbol pointer {
            builder.Add(Oblivious)
            Append(pointer.ReturnType, builder)
            for parameter in pointer.ParameterTypes {
                Append(parameter, builder)
            }
            return
        }
        if type is PointerTypeSymbol pointer {
            builder.Add(Oblivious)
            Append(pointer.PointeeType, builder)
            return
        }
        if type is ArrayTypeSymbol arr {
            builder.Add(NotAnnotated)
            Append(arr.ElementType, builder)
            return
        }
        if type is RectangularArrayTypeSymbol rectangular {
            builder.Add(NotAnnotated)
            Append(rectangular.ElementType, builder)
            return
        }
        if type is SliceTypeSymbol slice {
            builder.Add(NotAnnotated)
            Append(slice.ElementType, builder)
            return
        }
        if type is TupleTypeSymbol tup {
            var index = 0
            while tup.ElementTypes.Length - index > 7 {
                builder.Add(Oblivious)
                for var i = 0; i < 7; i++ {
                    Append(tup.ElementTypes[index], builder)
                    index++
                }
            }
            builder.Add(Oblivious)
            while index < tup.ElementTypes.Length {
                Append(tup.ElementTypes[index], builder)
                index++
            }
            return
        }
        if type is EnumSymbol {
            // User-defined enums are CLR value types.
            return
        }
        if type is StructSymbol structSym {
            let isGeneric = !structSym.TypeArguments.IsDefaultOrEmpty || !structSym.TypeParameters.IsDefaultOrEmpty
            if structSym.IsClass {
                builder.Add(NotAnnotated)
            } else if isGeneric {
                builder.Add(Oblivious)
            }
            if !structSym.TypeArguments.IsDefaultOrEmpty {
                for arg in structSym.TypeArguments {
                    Append(arg, builder)
                }
            } else if !structSym.TypeParameters.IsDefaultOrEmpty {
                // Open self-reference (the struct's own type parameters) —
                // each is a reference-typed open TP slot unless `struct`-constrained.
                for defTp in structSym.TypeParameters {
                    Append(defTp, builder)
                }
            }
            return
        }
        if type is InterfaceSymbol ifaceSym {
            builder.Add(NotAnnotated)
            if !ifaceSym.TypeArguments.IsDefaultOrEmpty {
                for arg in ifaceSym.TypeArguments {
                    Append(arg, builder)
                }
            } else if !ifaceSym.TypeParameters.IsDefaultOrEmpty {
                for defTp in ifaceSym.TypeParameters {
                    Append(defTp, builder)
                }
            }
            return
        }
        // ADR-0186 step 5: G#'s own reference-shaped collection, channel,
        // sequence and constructed-delegate symbols. Each erases to a single
        // generic CLR class/interface (Dictionary<K,V>, a Chan<T>/Channel<T>
        // view, IEnumerable<T>/IAsyncEnumerable<T>, the delegate's TypeDef),
        // so the layout is one reference byte followed by the arguments'
        // subtrees — written from the SYMBOLIC arguments. The CLR fallback
        // below erased them: `map[string?, string]` came out `1,1,1`, and an
        // oblivious one could not say `0` for its value. (This fixes the
        // enabled `?` case too, which predates ADR-0186.)
        if type is MapTypeSymbol ||
            type is ChannelTypeSymbol ||
            type is SequenceTypeSymbol ||
            type is AsyncSequenceTypeSymbol ||
            type is DelegateTypeSymbol &&
            type
            .TypeArguments
            .IsDefaultOrEmpty == false {
            builder.Add(NotAnnotated)
            AppendGenericArguments(type, builder)
            return
        }
        if type is FunctionTypeSymbol function {
            let start = builder.Count
            builder.Add(NotAnnotated)
            AppendGenericArguments(function, builder)
            if isRoot && function.ClrType == nil && builder.Skip(start).All((flag uint8) -> flag == NotAnnotated) {
                // A scalar applies to the entire root type, preserving the
                // existing symbolic-delegate context-selection encoding.
                builder.Count = start + 1
            }
            return
        }
        if type is ImportedTypeSymbol imported {
            let clr Type? = imported.ClrType
            if clr?.IsGenericParameter == true {
                builder.Add(
                    if ClrNullability.IsNotNullableValueTypeParameter(clr!!) {
                        Oblivious
                    } else {
                        NotAnnotated
                    }
                )
                return
            }
            let isValueType = clr != nil && clr.IsValueType
            if !isValueType {
                builder.Add(NotAnnotated)
            } else if (!imported.TypeArguments.IsDefaultOrEmpty) ||
                (clr != nil && clr.IsGenericType && !clr.IsGenericTypeDefinition) {
                builder.Add(Oblivious)
            }
            // Prefer the symbolic TypeArguments — they preserve in-scope
            // type-parameter identity so nullability for `IEnumerable[T]`
            // is captured as the TP's byte (or skipped for `struct` Ts).
            if !imported.TypeArguments.IsDefaultOrEmpty {
                for arg in imported.TypeArguments {
                    Append(arg, builder)
                }
            } else if clr != nil && clr.IsGenericType && !clr.IsGenericTypeDefinition {
                for clrArg in clr.GetGenericArguments() {
                    AppendClrType(clrArg, builder)
                }
            }
            return
        }
        // Fallback: dispatch via the CLR type when present.
        let clrFallback Type? = type.ClrType
        if clrFallback != nil {
            AppendClrType(clrFallback, builder)
            return
        }
        // Last-resort: a symbolic reference type with no other information.
        builder.Add(NotAnnotated)
    }

    /// Appends the nested positions of an imported annotated wrapper, dropping
    /// them entirely when every one of them repeats [`uniformFlag`](paramref)
    /// — the byte the caller has already written for the outer position — so
    /// that `NullableAttribute(byte)`'s scalar form can stand for the whole
    /// tree.
    /// @param annotated The imported wrapper carrying the DFS byte array.
    /// @param builder The flags being built.
    /// @param allowScalarCompression Whether the caller is at the root, where the scalar form is legal.
    /// @param uniformFlag The outer byte the caller already wrote. (cref:Annotated) for a
    /// `T?` wrapper; ADR-0186 §8 adds (cref:Oblivious) for a
    /// `T!` one. Compression is only sound when the nested positions all
    /// repeat it, because the scalar form applies one byte to every position.
    private func AppendAnnotatedTail(
        annotated NullabilityAnnotatedTypeSymbol,
        builder ImmutableArray[uint8].Builder,
        allowScalarCompression bool,
        uniformFlag uint8 = 2
    ) {
        if annotated.ClrType == nil {
            return
        }
        let expanded = ClrNullability.ExpandNullableFlags(annotated.ClrType, annotated.NullableFlags)
        let tail = expanded.AsSpan().Slice(1)
        if !allowScalarCompression {
            builder.AddRange(tail.ToArray())
            return
        }
        for flag in tail {
            if flag != uniformFlag {
                builder.AddRange(tail.ToArray())
                return
            }
        }
        // Every nested position repeats the outer byte. Keep the single outer
        // one; NullableAttribute(byte) applies that scalar to the whole type
        // tree.

    }

    private func AppendGenericArguments(type TypeSymbol?, builder ImmutableArray[uint8].Builder) {
        if type is FunctionTypeSymbol function {
            for parameter in function.ParameterTypes {
                Append(parameter, builder)
            }
            if function.ReturnType != TypeSymbol.Void {
                Append(function.ReturnType, builder)
            }
            return
        }
        if type == nil {
            return
        }
        if type is StructSymbol s && !s.TypeArguments.IsDefaultOrEmpty {
            for arg in s.TypeArguments {
                Append(arg, builder)
            }
            return
        }
        // Issue #4988: an open self-reference under `?` (a generic data
        // class's synthesized `==(R[T]? left, R[T]? right)`) lays out its own
        // type parameters, exactly as the non-nullable arm in Append does.
        // Without them the array was the scalar `[2]`, which a reader applies
        // to every position and so read `T` as `T?`.
        if type is StructSymbol openStruct && !openStruct.TypeParameters.IsDefaultOrEmpty {
            for defTp in openStruct.TypeParameters {
                Append(defTp, builder)
            }
            return
        }
        if type is InterfaceSymbol iface && !iface.TypeArguments.IsDefaultOrEmpty {
            for arg in iface.TypeArguments {
                Append(arg, builder)
            }
            return
        }
        if type is InterfaceSymbol openInterface && !openInterface.TypeParameters.IsDefaultOrEmpty {
            for defTp in openInterface.TypeParameters {
                Append(defTp, builder)
            }
            return
        }
        if type is TupleTypeSymbol tup {
            for elem in tup.ElementTypes {
                Append(elem, builder)
            }
            return
        }
        // ADR-0186 step 5: see the matching arm in Append.
        switch type {
            case map_ is MapTypeSymbol {
                Append(map_.KeyType, builder)
                Append(map_.ValueType, builder)
                return
            }
            case channel is ChannelTypeSymbol {
                Append(channel.ElementType, builder)
                return
            }
            case sequence_ is SequenceTypeSymbol {
                Append(sequence_.ElementType, builder)
                return
            }
            case asyncSequence is AsyncSequenceTypeSymbol {
                Append(asyncSequence.ElementType, builder)
                return
            }
            case DelegateTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} constructedDelegate {
                for arg in constructedDelegate.TypeArguments {
                    Append(arg, builder)
                }
                return
            }
        }
        if type is ArrayTypeSymbol array {
            Append(array.ElementType, builder)
            return
        }
        if type is RectangularArrayTypeSymbol rectangular {
            Append(rectangular.ElementType, builder)
            return
        }
        if type is SliceTypeSymbol slice {
            Append(slice.ElementType, builder)
            return
        }
        if type is ImportedTypeSymbol imported {
            if !imported.TypeArguments.IsDefaultOrEmpty {
                for arg in imported.TypeArguments {
                    Append(arg, builder)
                }
                return
            }
            let clr Type? = imported.ClrType
            if clr != nil && clr.IsGenericType && !clr.IsGenericTypeDefinition {
                for clrArg in clr.GetGenericArguments() {
                    AppendClrType(clrArg, builder)
                }
            }
            return
        }
        let fallbackClr Type? = type.ClrType
        if fallbackClr != nil && fallbackClr.IsGenericType && !fallbackClr.IsGenericTypeDefinition {
            for clrArg in fallbackClr.GetGenericArguments() {
                AppendClrType(clrArg, builder)
            }
        }
    }

    private func AppendClrType(clrType Type?, builder ImmutableArray[uint8].Builder) {
        if clrType == nil {
            return
        }
        if clrType.IsGenericParameter {
            builder.Add(
                if ClrNullability.IsNotNullableValueTypeParameter(clrType) {
                    Oblivious
                } else {
                    NotAnnotated
                }
            )
            return
        }
        if NullableLifting.GetValueTypeNullableUnderlyingClr(clrType) is {} nullableUnderlying {
            AppendClrType(nullableUnderlying, builder)
            return
        }
        if clrType.IsByRef {
            AppendClrType(clrType.GetElementType(), builder)
            return
        }
        if clrType.IsFunctionPointer {
            builder.Add(Oblivious)
            AppendClrType(clrType.GetFunctionPointerReturnType(), builder)
            for parameter in clrType.GetFunctionPointerParameterTypes() {
                AppendClrType(parameter, builder)
            }
            return
        }
        if clrType.IsPointer {
            builder.Add(Oblivious)
            AppendClrType(clrType.GetElementType(), builder)
            return
        }
        if clrType.IsArray {
            builder.Add(NotAnnotated)
            AppendClrType(clrType.GetElementType(), builder)
            return
        }
        let isClosedGeneric = clrType.IsGenericType && !clrType.IsGenericTypeDefinition
        if !clrType.IsValueType {
            builder.Add(NotAnnotated)
        } else if isClosedGeneric {
            builder.Add(Oblivious)
        }
        if isClosedGeneric {
            for arg in clrType.GetGenericArguments() {
                AppendClrType(arg, builder)
            }
        }
    }

    private func IsValueTypeNullableLowering(inner TypeSymbol) bool {
        if inner is TypeParameterSymbol tp && tp.HasValueTypeConstraint {
            return true
        }
        if inner?.ClrType is {IsValueType: true} {
            return true
        }
        if inner is StructSymbol s && !s.IsClass {
            return true
        }
        if inner is TupleTypeSymbol {
            return true
        }
        if inner is EnumSymbol {
            return true
        }
        return false
    }
}
