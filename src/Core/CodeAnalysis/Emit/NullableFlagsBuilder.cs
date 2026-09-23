// <copyright file="NullableFlagsBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Issue #834: computes the C#-compatible
/// <c>[System.Runtime.CompilerServices.NullableAttribute]</c> byte array
/// (DFS pre-order) for a GSharp <see cref="TypeSymbol"/>. The bytes use the
/// well-known encoding:
/// <list type="bullet">
/// <item><c>0</c> — oblivious (no nullability information), including a
/// non-Nullable closed generic value type's leading placeholder and a
/// struct-constrained generic parameter's slot.</item>
/// <item><c>1</c> — not-annotated (non-nullable reference / open type parameter).</item>
/// <item><c>2</c> — annotated (nullable reference / nullable open type parameter).</item>
/// </list>
/// <para>
/// Layout mirrors the C# compiler: byte 0 belongs to the outer type when that
/// type occupies a reference-type position. Closed generic value types
/// contribute a leading oblivious placeholder byte before their arguments,
/// except metadata-transparent <c>Nullable&lt;T&gt;</c>, which contributes
/// only T's subtree. Struct-constrained generic parameters contribute one
/// oblivious slot. Non-generic value types contribute none (matches
/// <see cref="ClrNullability.CountNullabilityBytes(System.Type)"/>).
/// </para>
/// <para>
/// Per-position attributes are intentionally narrow — they only describe what
/// C#'s nullable flow analysis needs to see at a parameter / return slot. They
/// do not depend on whether the receiver, declaring type, or assembly has its
/// own <c>NullableContextAttribute</c>; the per-slot byte array overrides any
/// surrounding context.
/// </para>
/// </summary>
internal static class NullableFlagsBuilder
{
    /// <summary>The byte used for oblivious positions and generic value-type placeholders.</summary>
    internal const byte Oblivious = 0;

    /// <summary>The byte the C# compiler uses for non-nullable reference positions.</summary>
    internal const byte NotAnnotated = 1;

    /// <summary>The byte the C# compiler uses for nullable reference positions.</summary>
    internal const byte Annotated = 2;

    /// <summary>
    /// Computes the DFS pre-order nullable byte array for the supplied
    /// <see cref="TypeSymbol"/>. Returns an empty array when the type
    /// contributes no nullable-metadata positions (e.g. a non-generic value
    /// type) — in which case no
    /// <c>NullableAttribute</c> need be emitted.
    /// </summary>
    /// <param name="type">The parameter / return / field / property type to inspect.</param>
    /// <returns>The flags array — possibly empty; never <see langword="default"/>.</returns>
    internal static ImmutableArray<byte> Build(TypeSymbol type)
    {
        var builder = ImmutableArray.CreateBuilder<byte>();
        Append(type, builder, isRoot: true);
        return builder.ToImmutable();
    }

    /// <summary>
    /// Merges receiver-projected generic nullability with declaration-site
    /// nullable metadata node by node. A substituted type-parameter subtree is
    /// kept intact; the declaration's byte annotates only that subtree's root.
    /// </summary>
    /// <param name="projectedType">Type after receiver generic substitution.</param>
    /// <param name="layoutType">Open declaration type defining metadata positions.</param>
    /// <param name="declarationFlags">Declaration nullable flags.</param>
    /// <returns>Combined nullability-aware type.</returns>
    internal static TypeSymbol MergeDeclarationNullability(
        TypeSymbol projectedType,
        Type layoutType,
        ImmutableArray<byte> declarationFlags)
    {
        // Issue #3705 family 2: no short-circuit on empty flags. An absent
        // `[Nullable]` is not "no information" in G# — issue #1354 makes it
        // mean `T?`, and `ExpandNullableFlags` already expands empty metadata
        // to a full array of `2`s for exactly that reason. Returning
        // `projectedType` here is what made a member reached through a
        // receiver-substituting reader (field, constrained call, deconstruct
        // out-parameter) keep the pre-#1354 non-null answer while its
        // ClrNullability-read siblings said `T?`.
        var declaredFlags = ClrNullability.ExpandNullableFlags(
            layoutType,
            declarationFlags);

        // The same expansion read LITERALLY: absent positions stay oblivious
        // instead of defaulting to `2`. Only the open-type-parameter carve-out
        // below consults this, because it is the one position where "the
        // declaration was silent" must not be read as "the declaration said
        // `T?`" — and the default expansion cannot tell those apart.
        var literalFlags = ClrNullability.ExpandNullableFlags(
            layoutType,
            declarationFlags,
            absentFill: Oblivious);
        var position = 0;
        return Merge(projectedType, layoutType);

        TypeSymbol Merge(TypeSymbol projected, Type layout)
        {
            if (NullableLifting.GetValueTypeNullableUnderlyingClr(layout) is { } nullableUnderlying)
            {
                return Merge(projected, nullableUnderlying);
            }

            if (layout.IsGenericParameter)
            {
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
                var parameterFlag = literalFlags[position++];
                return ClrNullability.ClassifyFlag(parameterFlag) == ClrNullabilityState.Annotated
                    ? ApplyRootAnnotation(projected, parameterFlag)
                    : projected;
            }

            if (layout.IsArray)
            {
                var flag = declaredFlags[position++];
                var elementLayout = Invariant.Required(
                    layout.GetElementType(),
                    "an array type has an element type");
                TypeSymbol merged = projected switch
                {
                    ArrayTypeSymbol array => ArrayTypeSymbol.Get(
                        Merge(array.ElementType, elementLayout),
                        array.Length),
                    SliceTypeSymbol slice => SliceTypeSymbol.Get(
                        Merge(slice.ElementType, elementLayout)),
                    RectangularArrayTypeSymbol rectangular =>
                        RectangularArrayTypeSymbol.Get(
                            Merge(rectangular.ElementType, elementLayout),
                            rectangular.Rank),
                    _ => SkipChildren(projected, elementLayout),
                };
                return layout.IsValueType
                    ? merged
                    : ApplyRootAnnotation(merged, flag);
            }

            var isClosedGeneric = layout.IsGenericType && !layout.IsGenericTypeDefinition;
            if (isClosedGeneric)
            {
                var flag = declaredFlags[position++];
                var layoutArguments = layout.GetGenericArguments();
                var nullable = projected as NullableTypeSymbol;
                var core = nullable?.UnderlyingType ?? projected;
                TypeSymbol merged = core;
                if (core is ImportedTypeSymbol imported
                    && imported.ClrType is Type importedClr)
                {
                    var projectedArguments = imported.TypeArguments;
                    if (projectedArguments.IsDefaultOrEmpty
                        && importedClr.IsGenericType
                        && !importedClr.IsGenericTypeDefinition)
                    {
                        projectedArguments = importedClr.GetGenericArguments()
                            .Select(TypeSymbol.FromClrType)
                            .ToImmutableArray();
                    }

                    if (projectedArguments.Length == layoutArguments.Length)
                    {
                        var arguments = ImmutableArray.CreateBuilder<TypeSymbol>(
                            layoutArguments.Length);
                        for (var i = 0; i < layoutArguments.Length; i++)
                        {
                            arguments.Add(Merge(
                                projectedArguments[i],
                                layoutArguments[i]));
                        }

                        merged = ImportedTypeSymbol.GetConstructed(
                            importedClr,
                            imported.OpenDefinition ?? layout.GetGenericTypeDefinition(),
                            arguments.MoveToImmutable());
                    }
                    else
                    {
                        foreach (var argument in layoutArguments)
                        {
                            position += ClrNullability.CountNullabilityBytes(argument);
                        }
                    }
                }
                else
                {
                    foreach (var argument in layoutArguments)
                    {
                        position += ClrNullability.CountNullabilityBytes(argument);
                    }
                }

                if (nullable != null)
                {
                    merged = NullableTypeSymbol.Get(merged);
                }

                return layout.IsValueType
                    ? merged
                    : ApplyRootAnnotation(merged, flag);
            }

            if (!layout.IsValueType)
            {
                return ApplyRootAnnotation(projected, declaredFlags[position++]);
            }

            return projected;
        }

        TypeSymbol SkipChildren(TypeSymbol projected, Type childLayout)
        {
            position += ClrNullability.CountNullabilityBytes(childLayout);
            return projected;
        }

        static TypeSymbol ApplyRootAnnotation(TypeSymbol projected, byte flag)
        {
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
            var state = ClrNullability.ClassifyFlag(flag);
            if (state == ClrNullabilityState.NotAnnotated
                || projected is NullableTypeSymbol or PlatformTypeSymbol)
            {
                return projected;
            }

            var isValueType = projected switch
            {
                TypeParameterSymbol parameter => parameter.HasValueTypeConstraint,
                StructSymbol structure => !structure.IsClass,
                EnumSymbol => true,
                _ => projected.ClrType?.IsValueType == true,
            };
            return isValueType
                ? projected
                : ClrNullability.SymbolForState(projected, state);
        }
    }

    private static void Append(
        TypeSymbol type,
        ImmutableArray<byte>.Builder builder,
        bool isRoot = false)
    {
        if (type == null)
        {
            return;
        }

        if (type is PlatformTypeSymbol platform)
        {
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
            var platformInner = platform.UnderlyingType;
            builder.Add(Oblivious);
            if (platformInner is NullabilityAnnotatedTypeSymbol annotatedPlatformInner)
            {
                AppendAnnotatedTail(
                    annotatedPlatformInner,
                    builder,
                    allowScalarCompression: isRoot,
                    uniformFlag: Oblivious);
            }
            else
            {
                AppendGenericArguments(platformInner, builder);
            }

            return;
        }

        // Imported wrapper that already carries the C# DFS byte array — pass
        // physical flags through verbatim. An empty wrapper represents
        // absent/oblivious metadata; expand it using the importer's existing
        // nullable-by-default semantics before re-emission.
        if (type is NullabilityAnnotatedTypeSymbol annotated)
        {
            if (isRoot && !annotated.NullableFlags.IsDefaultOrEmpty)
            {
                builder.AddRange(annotated.NullableFlags);
            }
            else if (annotated.ClrType != null)
            {
                builder.AddRange(
                    ClrNullability.ExpandNullableFlags(annotated.ClrType, annotated.NullableFlags));
            }

            return;
        }

        if (type is NullableTypeSymbol nullable)
        {
            var inner = nullable.UnderlyingType;

            // `T?` over a struct-constrained type parameter lowers to
            // `Nullable<T>` at the signature level. Nullable<T> is transparent
            // in nullable metadata: recurse into T at the same position.
            if (IsValueTypeNullableLowering(inner))
            {
                Append(inner, builder, isRoot);
                return;
            }

            // Reference-position annotated as nullable.
            builder.Add(Annotated);
            if (inner is NullabilityAnnotatedTypeSymbol annotatedInner)
            {
                AppendAnnotatedTail(
                    annotatedInner,
                    builder,
                    allowScalarCompression: isRoot);
            }
            else
            {
                AppendGenericArguments(inner, builder);
            }

            return;
        }

        if (type is TypeParameterSymbol tp)
        {
            if (tp.HasValueTypeConstraint)
            {
                // CLR generic parameters with a `struct` constraint occupy an
                // explicit oblivious placeholder position.
                builder.Add(Oblivious);
                return;
            }

            builder.Add(NotAnnotated);
            return;
        }

        if (type is ByRefTypeSymbol byRef)
        {
            // A `ref T` parameter shape is encoded at the parent (parameter)
            // encoder level via `isByRef: true`; the nullability byte set is
            // that of the pointee T.
            Append(byRef.PointeeType, builder);
            return;
        }

        if (type is ArrayTypeSymbol arr)
        {
            builder.Add(NotAnnotated);
            Append(arr.ElementType, builder);
            return;
        }

        if (type is RectangularArrayTypeSymbol rectangular)
        {
            builder.Add(NotAnnotated);
            Append(rectangular.ElementType, builder);
            return;
        }

        if (type is SliceTypeSymbol slice)
        {
            builder.Add(NotAnnotated);
            Append(slice.ElementType, builder);
            return;
        }

        if (type is TupleTypeSymbol tup)
        {
            var index = 0;
            while (tup.ElementTypes.Length - index > 7)
            {
                builder.Add(Oblivious);
                for (var i = 0; i < 7; i++)
                {
                    Append(tup.ElementTypes[index++], builder);
                }
            }

            builder.Add(Oblivious);
            while (index < tup.ElementTypes.Length)
            {
                Append(tup.ElementTypes[index++], builder);
            }

            return;
        }

        if (type is EnumSymbol)
        {
            // User-defined enums are CLR value types.
            return;
        }

        if (type is StructSymbol structSym)
        {
            var isGeneric = !structSym.TypeArguments.IsDefaultOrEmpty
                || !structSym.TypeParameters.IsDefaultOrEmpty;
            if (structSym.IsClass)
            {
                builder.Add(NotAnnotated);
            }
            else if (isGeneric)
            {
                builder.Add(Oblivious);
            }

            if (!structSym.TypeArguments.IsDefaultOrEmpty)
            {
                foreach (var arg in structSym.TypeArguments)
                {
                    Append(arg, builder);
                }
            }
            else if (!structSym.TypeParameters.IsDefaultOrEmpty)
            {
                // Open self-reference (the struct's own type parameters) —
                // each is a reference-typed open TP slot unless `struct`-constrained.
                foreach (var defTp in structSym.TypeParameters)
                {
                    Append(defTp, builder);
                }
            }

            return;
        }

        if (type is InterfaceSymbol ifaceSym)
        {
            builder.Add(NotAnnotated);
            if (!ifaceSym.TypeArguments.IsDefaultOrEmpty)
            {
                foreach (var arg in ifaceSym.TypeArguments)
                {
                    Append(arg, builder);
                }
            }
            else if (!ifaceSym.TypeParameters.IsDefaultOrEmpty)
            {
                foreach (var defTp in ifaceSym.TypeParameters)
                {
                    Append(defTp, builder);
                }
            }

            return;
        }

        if (type is FunctionTypeSymbol function)
        {
            var start = builder.Count;
            builder.Add(NotAnnotated);
            AppendGenericArguments(function, builder);
            if (isRoot && function.ClrType == null && builder.Skip(start).All(flag => flag == NotAnnotated))
            {
                // A scalar applies to the entire root type, preserving the
                // existing symbolic-delegate context-selection encoding.
                builder.Count = start + 1;
            }

            return;
        }

        if (type is ImportedTypeSymbol imported)
        {
            var clr = imported.ClrType;
            if (clr?.IsGenericParameter == true)
            {
                builder.Add(
                    ClrNullability.IsNotNullableValueTypeParameter(clr)
                        ? Oblivious
                        : NotAnnotated);
                return;
            }

            var isValueType = clr != null && clr.IsValueType;
            if (!isValueType)
            {
                builder.Add(NotAnnotated);
            }
            else if ((!imported.TypeArguments.IsDefaultOrEmpty)
                || (clr != null && clr.IsGenericType && !clr.IsGenericTypeDefinition))
            {
                builder.Add(Oblivious);
            }

            // Prefer the symbolic TypeArguments — they preserve in-scope
            // type-parameter identity so nullability for `IEnumerable[T]`
            // is captured as the TP's byte (or skipped for `struct` Ts).
            if (!imported.TypeArguments.IsDefaultOrEmpty)
            {
                foreach (var arg in imported.TypeArguments)
                {
                    Append(arg, builder);
                }
            }
            else if (clr != null && clr.IsGenericType && !clr.IsGenericTypeDefinition)
            {
                foreach (var clrArg in clr.GetGenericArguments())
                {
                    AppendClrType(clrArg, builder);
                }
            }

            return;
        }

        // Fallback: dispatch via the CLR type when present.
        var clrFallback = type.ClrType;
        if (clrFallback != null)
        {
            AppendClrType(clrFallback, builder);
            return;
        }

        // Last-resort: a symbolic reference type with no other information.
        builder.Add(NotAnnotated);
    }

    /// <summary>
    /// Appends the nested positions of an imported annotated wrapper, dropping
    /// them entirely when every one of them repeats <paramref name="uniformFlag"/>
    /// — the byte the caller has already written for the outer position — so
    /// that <c>NullableAttribute(byte)</c>'s scalar form can stand for the whole
    /// tree.
    /// </summary>
    /// <param name="annotated">The imported wrapper carrying the DFS byte array.</param>
    /// <param name="builder">The flags being built.</param>
    /// <param name="allowScalarCompression">Whether the caller is at the root, where the scalar form is legal.</param>
    /// <param name="uniformFlag">
    /// The outer byte the caller already wrote. <see cref="Annotated"/> for a
    /// <c>T?</c> wrapper; ADR-0186 §8 adds <see cref="Oblivious"/> for a
    /// <c>T!</c> one. Compression is only sound when the nested positions all
    /// repeat it, because the scalar form applies one byte to every position.
    /// </param>
    private static void AppendAnnotatedTail(
        NullabilityAnnotatedTypeSymbol annotated,
        ImmutableArray<byte>.Builder builder,
        bool allowScalarCompression,
        byte uniformFlag = Annotated)
    {
        if (annotated.ClrType == null)
        {
            return;
        }

        var expanded = ClrNullability.ExpandNullableFlags(
            annotated.ClrType,
            annotated.NullableFlags);
        var tail = expanded.AsSpan().Slice(1);
        if (!allowScalarCompression)
        {
            builder.AddRange(tail.ToArray());
            return;
        }

        foreach (var flag in tail)
        {
            if (flag != uniformFlag)
            {
                builder.AddRange(tail.ToArray());
                return;
            }
        }

        // Every nested position repeats the outer byte. Keep the single outer
        // one; NullableAttribute(byte) applies that scalar to the whole type
        // tree.
    }

    private static void AppendGenericArguments(TypeSymbol type, ImmutableArray<byte>.Builder builder)
    {
        if (type is FunctionTypeSymbol function)
        {
            foreach (var parameter in function.ParameterTypes)
            {
                Append(parameter, builder);
            }

            if (function.ReturnType != TypeSymbol.Void)
            {
                Append(function.ReturnType, builder);
            }

            return;
        }

        if (type == null)
        {
            return;
        }

        if (type is StructSymbol s && !s.TypeArguments.IsDefaultOrEmpty)
        {
            foreach (var arg in s.TypeArguments)
            {
                Append(arg, builder);
            }

            return;
        }

        if (type is InterfaceSymbol iface && !iface.TypeArguments.IsDefaultOrEmpty)
        {
            foreach (var arg in iface.TypeArguments)
            {
                Append(arg, builder);
            }

            return;
        }

        if (type is TupleTypeSymbol tup)
        {
            foreach (var elem in tup.ElementTypes)
            {
                Append(elem, builder);
            }

            return;
        }

        if (type is ArrayTypeSymbol array)
        {
            Append(array.ElementType, builder);
            return;
        }

        if (type is RectangularArrayTypeSymbol rectangular)
        {
            Append(rectangular.ElementType, builder);
            return;
        }

        if (type is SliceTypeSymbol slice)
        {
            Append(slice.ElementType, builder);
            return;
        }

        if (type is ImportedTypeSymbol imported)
        {
            if (!imported.TypeArguments.IsDefaultOrEmpty)
            {
                foreach (var arg in imported.TypeArguments)
                {
                    Append(arg, builder);
                }

                return;
            }

            var clr = imported.ClrType;
            if (clr != null && clr.IsGenericType && !clr.IsGenericTypeDefinition)
            {
                foreach (var clrArg in clr.GetGenericArguments())
                {
                    AppendClrType(clrArg, builder);
                }
            }

            return;
        }

        var fallbackClr = type.ClrType;
        if (fallbackClr != null && fallbackClr.IsGenericType && !fallbackClr.IsGenericTypeDefinition)
        {
            foreach (var clrArg in fallbackClr.GetGenericArguments())
            {
                AppendClrType(clrArg, builder);
            }
        }
    }

    private static void AppendClrType(Type? clrType, ImmutableArray<byte>.Builder builder)
    {
        if (clrType == null)
        {
            return;
        }

        if (clrType.IsGenericParameter)
        {
            builder.Add(
                ClrNullability.IsNotNullableValueTypeParameter(clrType)
                    ? Oblivious
                    : NotAnnotated);
            return;
        }

        if (NullableLifting.GetValueTypeNullableUnderlyingClr(clrType) is { } nullableUnderlying)
        {
            AppendClrType(nullableUnderlying, builder);
            return;
        }

        if (clrType.IsByRef)
        {
            AppendClrType(clrType.GetElementType(), builder);
            return;
        }

        if (clrType.IsArray)
        {
            builder.Add(NotAnnotated);
            AppendClrType(clrType.GetElementType(), builder);
            return;
        }

        var isClosedGeneric = clrType.IsGenericType && !clrType.IsGenericTypeDefinition;
        if (!clrType.IsValueType)
        {
            builder.Add(NotAnnotated);
        }
        else if (isClosedGeneric)
        {
            builder.Add(Oblivious);
        }

        if (isClosedGeneric)
        {
            foreach (var arg in clrType.GetGenericArguments())
            {
                AppendClrType(arg, builder);
            }
        }
    }

    private static bool IsValueTypeNullableLowering(TypeSymbol inner)
    {
        if (inner is TypeParameterSymbol tp && tp.HasValueTypeConstraint)
        {
            return true;
        }

        if (inner?.ClrType is { IsValueType: true })
        {
            return true;
        }

        if (inner is StructSymbol s && !s.IsClass)
        {
            return true;
        }

        if (inner is TupleTypeSymbol)
        {
            return true;
        }

        if (inner is EnumSymbol)
        {
            return true;
        }

        return false;
    }
}
