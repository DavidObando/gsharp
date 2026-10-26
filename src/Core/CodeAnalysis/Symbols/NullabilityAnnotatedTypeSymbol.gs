// <copyright file="NullabilityAnnotatedTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Emit
import System
import System.Collections.Immutable
import System.Linq

/// A (cref:TypeSymbol) that wraps an imported CLR generic or array type
/// and carries the full `[NullableAttribute]` byte array so that
/// inner-position nullability (issue #209) can be recovered when the type is
/// later used as a collection element, dictionary value, etc.
/// @remarks The (cref:NullableFlags) array follows the C# compiler's DFS pre-order
/// layout: byte 0 belongs to the outer reference/array position or is the
/// leading zero placeholder for a closed generic value type. Subsequent bytes
/// belong to array elements and generic arguments in DFS order; non-generic
/// value types contribute no position, and `Nullable<T>` is
/// transparent.
///
/// Example — `Dictionary<string, string?>`:<br />
/// flags = { 1 (Dictionary non-null), 1 (string key non-null), 2 (string? value nullable) }.
class NullabilityAnnotatedTypeSymbol : TypeSymbol {
    internal init(baseType TypeSymbol, nullableFlags ImmutableArray[uint8]) : base(baseType.Name, baseType.ClrType) {
        _baseType = baseType
        NullableFlags = nullableFlags
    }

    /// Gets the underlying non-annotated type symbol.
    private var _baseType TypeSymbol

    override prop BaseType TypeSymbol -> _baseType

    /// Gets the full `[NullableAttribute]` byte array for this type, starting
    /// at the outer type's own byte (index 0).
    prop NullableFlags ImmutableArray[uint8] {
        get;
    }

    /// Returns the (cref:TypeSymbol) for the generic type argument at
    /// [`argIndex`](paramref) (0-based), with reference nullability applied
    /// from (cref:NullableFlags).
    /// @param argIndex 0-based index into the outer CLR type's generic arguments.
    /// @returns The properly-nullified symbol, or (cref:TypeSymbol.Error) when the
    /// outer CLR type is not a closed generic.
    @NullabilityFunnel
    func GetTypeArgumentSymbol(argIndex int32) TypeSymbol {
        let clr Type? = ClrType
        if clr == nil || !clr.IsGenericType || clr.IsGenericTypeDefinition {
            return TypeSymbol.Error
        }
        let args = clr.GetGenericArguments()
        if uint32(argIndex) >= uint32(args.Length) {
            return TypeSymbol.Error
        }
        // Byte 0 belongs to the outer type itself (a reference type).
        var offset = 1
        for var i = 0; i < argIndex; i++ {
            offset += ClrNullability.CountNullabilityBytes(args[i])
        }
        // ADR-0172: the flags-derived argument is rebuilt from the CLR shape,
        // which cannot carry tuple element names. When the wrapped symbolic
        // base holds a named tuple at this position, transfer its names.
        if BaseType is ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} symbolicBase &&
            uint32(argIndex) < uint32(symbolicBase.TypeArguments.Length) {
            let symbolicArgument = symbolicBase.TypeArguments[argIndex]
            return if TypeSymbol.ContainsNamedTupleElements(symbolicArgument) {
                TransferTupleNames(
                    symbolicArgument,
                    ClrNullability.SymbolFromFlagsOffset(args[argIndex], NullableFlags, offset)
                )
            } else {
                NullableFlagsBuilder.MergeDeclarationNullability(
                    symbolicArgument,
                    args[argIndex],
                    ClrNullability.GetNullableFlagsForSubtree(args[argIndex], NullableFlags, offset)
                )
            }
        }
        return ClrNullability.SymbolFromFlagsOffset(args[argIndex], NullableFlags, offset)
    }

    /// Searches the outer type's generic arguments or array element for one whose
    /// resolved CLR type matches [`targetClrType`](paramref) and returns a
    /// properly-nullified (cref:TypeSymbol) for it. Falls back to a plain
    /// (cref:TypeSymbol.FromClrType) result when no matching argument is found.
    /// @param targetClrType The CLR element type to locate.
    /// @returns The nullified symbol for the first matching argument.
    @NullabilityFunnel
    func GetTypeArgumentSymbolForClrType(targetClrType Type?) TypeSymbol {
        if targetClrType == nil {
            return TypeSymbol.Error
        }
        let clr Type? = ClrType
        if clr?.IsArray == true {
            let elementType Type? = clr!!.GetElementType()
            return if elementType != nil &&
                (
                elementType == targetClrType ||
                    (!elementType.IsGenericParameter && elementType.FullName == targetClrType.FullName)
            ) {
                ClrNullability.SymbolFromFlagsOffset(elementType, NullableFlags, 1)
            } else {
                TypeSymbol.FromClrType(targetClrType)
            }
        }
        if clr == nil || !clr.IsGenericType || clr.IsGenericTypeDefinition {
            return TypeSymbol.FromClrType(targetClrType)
        }
        let args = clr.GetGenericArguments()
        if targetClrType.IsGenericParameter && uint32(targetClrType.GenericParameterPosition) < uint32(args.Length) {
            return GetTypeArgumentSymbol(targetClrType.GenericParameterPosition)
        }
        // Issue #4159 (Copilot review finding on this PR): matching by
        // CLOSED CLR type alone is ambiguous for a custom awaitable — this
        // method is reached from ANY type with a conforming duck-typed
        // GetAwaiter/GetResult (see AwaitableShape.Resolve, C# spec
        // §12.9.8), not just Task[T]/ValueTask[T], which only ever have ONE
        // outer type argument — whenever two or more of the outer type's
        // own generic arguments happen to close over the exact same CLR
        // type (e.g. `Awaitable[string, string?]`, where `GetResult()`
        // returns the SECOND parameter): the first (by position) match
        // would silently recover the WRONG argument's nullability. Scan
        // every argument before deciding, and refuse to guess — falling
        // back to the unannotated result, same as a genuine no-match — the
        // instant more than one argument could be the answer, rather than
        // ever return a nullability annotation that might belong to a
        // different type parameter.
        var matchIndex = -1
        var ambiguous = false
        for var i = 0; i < args.Length; i++ {
            let arg = args[i]
            // Compare by FullName so MetadataLoadContext types match runtime types.
            if arg == targetClrType || (!arg.IsGenericParameter && arg.FullName == targetClrType.FullName) {
                if matchIndex >= 0 {
                    ambiguous = true
                } else {
                    matchIndex = i
                }
            }
        }
        if matchIndex >= 0 && !ambiguous {
            // ADR-0193 §4: one lazy accessor, reached by index or by CLR
            // type. This arm used to decode the flags itself and, over a
            // symbolic base, only transferred tuple names — so it never
            // merged the base's own argument, and `IEnumerable[string?]`'s
            // element read `string` here and `string?` through
            // `GetTypeArgumentSymbol`. The reader-agreement test found the
            // two disagreeing. Over a non-symbolic base the two computed the
            // same thing, so delegating changes nothing there.
            return GetTypeArgumentSymbol(matchIndex)
        }
        return TypeSymbol.FromClrType(targetClrType)
    }

    /// ADR-0193 §2: this representation's half of
    /// (cref:TypeSymbol.GetElementPositions) — every position decoded
    /// through the same lazy accessors an element read uses, so a query and a
    /// read cannot disagree.
    /// @returns The element / type-argument positions.
    internal func GetAnnotatedElementPositions() ImmutableArray[TypeSymbol] {
        // A symbolic array shape (a slice over `T`, say) has an erased or no
        // CLR type, so its element is the symbolic one, not the CLR one.
        if (BaseType is SliceTypeSymbol or ArrayTypeSymbol or RectangularArrayTypeSymbol) {
            return DecodeSymbolicPositions()
        }
        let clr Type? = ClrType
        if clr?.IsArray == true && clr!!.GetElementType() is {} element {
            return ImmutableArray.Create(GetTypeArgumentSymbolForClrType(element))
        }
        if clr == nil || !clr.IsGenericType || clr.IsGenericTypeDefinition {
            // Only the array shapes above have a layout this type can decode
            // symbolically without re-deriving NullableFlagsBuilder's (a
            // tuple's interleaved TRest placeholders, a nested type's
            // enclosing arguments). Other symbolic bases keep their own
            // positions; ADR-0193 Phase 3's query API owns the general case.
            return BaseType.GetElementPositions()
        }
        let count = clr.GetGenericArguments().Length
        let builder = ImmutableArray.CreateBuilder[TypeSymbol](count)
        for var i = 0; i < count; i++ {
            builder.Add(GetTypeArgumentSymbol(i))
        }
        return builder.MoveToImmutable()
    }

    /// Decodes (cref:NullableFlags) against the base's SYMBOLIC
    /// positions, for a base with no CLR shape to lay the bytes out against. The
    /// layout is the one (cref:NullableFlagsBuilder.Build) writes for
    /// that same base, so each position's slice of the flags is found by the
    /// byte count the builder gives it; a position whose declared state says
    /// `?` or `!` gets it through the import rule
    /// ((cref:ClrNullability.SymbolForState)), and one with further
    /// positions of its own keeps its slice lazily, like a CLR-decoded one.
    /// @returns The decoded positions.
    @NullabilityFunnel
    private func DecodeSymbolicPositions() ImmutableArray[TypeSymbol] {
        let Slice = func (start int32, length int32) ImmutableArray[uint8] {
            return if NullableFlags.Length <= 1 {
                NullableFlags
            } else {
                ImmutableArray.CreateRange(NullableFlags.Skip(start).Take(length))
            }
        }
        let positions = BaseType.GetElementPositions()
        if positions.IsDefaultOrEmpty || NullableFlags.IsDefaultOrEmpty {
            return positions
        }
        // Called only for a slice/array/rectangular base: one element, laid
        // out after the array's own byte.
        let widths = positions.Select((p TypeSymbol) -> NullableFlagsBuilder.Build(p).Length).ToImmutableArray()
        var offset = NullableFlagsBuilder.Build(BaseType).Length - widths.Sum()
        if offset < 0 {
            return positions
        }
        let builder = ImmutableArray.CreateBuilder[TypeSymbol](positions.Length)
        for var i = 0; i < positions.Length; i++ {
            let position = positions[i]
            let width = widths[i]
            if width == 0 || (position is NullableTypeSymbol or PlatformTypeSymbol) {
                // A value position has no byte; a stated `?`/`!` already speaks.
                builder.Add(position)
            } else {
                let core = if width > 1 {
                    cast[TypeSymbol](NullabilityAnnotatedTypeSymbol(position, Slice(offset, width)))
                } else {
                    position
                }
                builder.Add(ClrNullability.SymbolForState(core, ClrNullability.ClassifyPosition(NullableFlags, offset)))
            }
            offset += width
        }
        return builder.MoveToImmutable()
    }

    shared {
        /// Issue #4159: grafts tuple element names from [`source`](paramref)
        /// (the naive, name-bearing symbolic type — see
        /// (cref:TypeSymbol.ContainsNamedTupleElements)) onto
        /// [`target`](paramref) (the flags-derived, nullability-correct but
        /// unnamed type built by (cref:ClrNullability.SymbolFromFlagsOffset)),
        /// recursing through every shape the CLR-import symbol tree can produce.
        ///
        /// A prior version of this method only matched a tuple sitting DIRECTLY at
        /// the top of the position being merged (optionally under one
        /// `Nullable` wrapper) — so a named tuple nested one level deeper,
        /// e.g. `IReadOnlyList[(string Key, string? Value)]` reached through
        /// an `async Task[...]` return, was silently left unnamed: this
        /// method returned [`target`](paramref) unchanged because the
        /// top-level shape ((cref:ImportedTypeSymbol)) didn't match either
        /// pattern, even though (cref:TypeSymbol.ContainsNamedTupleElements)
        /// (which recurses) correctly said "yes, look deeper" to the caller.
        /// @param source The naive, name-bearing symbolic type at this position.
        /// @param target The flags-derived, correctly-nullable but unnamed type at this position.
        /// @returns [`target`](paramref)'s shape with tuple names grafted in wherever [`source`](paramref) has
        /// them.
        private func TransferTupleNames(source TypeSymbol, target TypeSymbol) TypeSymbol {
            // Issue #4159 (Copilot review finding on this PR): `target` alone
            // decides whether this position is nullable — `source` is the
            // naive, pre-flags symbolic tree and, unlike `target`, does NOT
            // reliably wrap a nullable REFERENCE type (e.g. an argument typed
            // `IReadOnlyList[...]?`) in `NullableTypeSymbol`, since determining
            // reference nullability is exactly the flags-based job `target`'s
            // own construction (`ClrNullability.SymbolFromFlagsOffset`) does
            // that `source`'s construction does not. Requiring BOTH sides
            // wrapped — the previous condition — only ever fired for a
            // genuine value-type `Nullable[T]` (where raw CLR reflection alone
            // already makes `source` nullable-wrapped too) and silently
            // skipped grafting whenever `target` was nullable-wrapped ONLY
            // because of `[NullableAttribute]` metadata, dropping tuple names
            // one level under a nullable reference generic argument (e.g.
            // `Task[IReadOnlyList[(...)]?]`). Unwrap `source` too when it
            // happens to also be wrapped (preserves the original value-type
            // behavior exactly); otherwise recurse with `source` itself
            // against `target`'s underlying type.
            if target is NullableTypeSymbol targetNullable {
                let sourceForUnderlying = if source is NullableTypeSymbol namedNullable {
                    namedNullable.UnderlyingType
                } else {
                    source
                }
                return NullableTypeSymbol.Get(TransferTupleNames(sourceForUnderlying, targetNullable.UnderlyingType))
            }
            if source is TupleTypeSymbol namedTuple &&
                target is TupleTypeSymbol unnamedTuple &&
                namedTuple.Arity == unnamedTuple
                .Arity {
                let elements = ImmutableArray.CreateBuilder[TypeSymbol](unnamedTuple.ElementTypes.Length)
                for var i = 0; i < unnamedTuple.ElementTypes.Length; i++ {
                    elements.Add(TransferTupleNames(namedTuple.ElementTypes[i], unnamedTuple.ElementTypes[i]))
                }
                return if unnamedTuple.HasNames {
                    TupleTypeSymbol.Get(elements.MoveToImmutable(), unnamedTuple.ElementNames)
                } else {
                    TupleTypeSymbol.Get(elements.MoveToImmutable(), namedTuple.ElementNames)
                }
            }
            if source is ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} namedImported &&
                target is ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} unnamedImported &&
                unnamedImported.ClrType is Type unnamedImportedClr &&
                namedImported
                .TypeArguments
                .Length == unnamedImported
                .TypeArguments
                .Length &&
                TypeSymbol
                .ContainsNamedTupleElements(namedImported) {
                let arguments = ImmutableArray.CreateBuilder[TypeSymbol](unnamedImported.TypeArguments.Length)
                for var i = 0; i < unnamedImported.TypeArguments.Length; i++ {
                    arguments.Add(TransferTupleNames(namedImported.TypeArguments[i], unnamedImported.TypeArguments[i]))
                }
                return ImportedTypeSymbol.GetConstructed(
                    unnamedImportedClr,
                    unnamedImported.OpenDefinition ?? namedImported.OpenDefinition,
                    arguments.MoveToImmutable()
                )
            }
            // Issue #4159: `target` at a NESTED generic position (e.g. the
            // `IReadOnlyList[...]` argument of `Task[IReadOnlyList[...]]`) is
            // usually LAZY — `ClrNullability.SymbolFromFlagsOffset` wraps a
            // "plain" (`ImportedTypeSymbol.Get`, EMPTY `TypeArguments`) symbol in
            // a `NullabilityAnnotatedTypeSymbol` carrying only a sliced flags
            // array, deferring each argument's own nullability/name derivation
            // to `GetTypeArgumentSymbol`/`GetTypeArgumentSymbolForClrType` rather
            // than eagerly rebuilding the whole subtree. The two `ImportedTypeSymbol`
            // cases above never fire here because `target` isn't directly an
            // `ImportedTypeSymbol` — it's this wrapper — and neither `source`
            // (the eagerly name-rebuilt symbolic argument) is lazy the same way.
            // Materialize `target` into a fully eager `ImportedTypeSymbol` by
            // deriving each of ITS generic arguments (nullability-correct, via
            // its own accessor) and grafting `source`'s corresponding argument's
            // names onto each, one recursive level at a time.
            if target is NullabilityAnnotatedTypeSymbol annotatedTarget &&
                source is ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} namedSourceGeneric &&
                annotatedTarget.ClrType is Type annotatedTargetClr &&
                annotatedTargetClr.IsGenericType &&
                !annotatedTargetClr.IsGenericTypeDefinition &&
                TypeSymbol
                .ContainsNamedTupleElements(namedSourceGeneric) {
                let clrArguments = annotatedTargetClr.GetGenericArguments()
                if namedSourceGeneric.TypeArguments.Length == clrArguments.Length {
                    let openDefinition = (annotatedTarget.BaseType as ImportedTypeSymbol)?.OpenDefinition ??
                        annotatedTargetClr.GetGenericTypeDefinition()
                    let arguments = ImmutableArray.CreateBuilder[TypeSymbol](clrArguments.Length)
                    for var i = 0; i < clrArguments.Length; i++ {
                        let materialized = annotatedTarget.GetTypeArgumentSymbol(i)
                        arguments.Add(TransferTupleNames(namedSourceGeneric.TypeArguments[i], materialized))
                    }
                    return ImportedTypeSymbol.GetConstructed(
                        annotatedTargetClr,
                        openDefinition,
                        arguments.MoveToImmutable()
                    )
                }
            }
            if source is SliceTypeSymbol namedSlice && target is SliceTypeSymbol unnamedSlice {
                return SliceTypeSymbol.Get(TransferTupleNames(namedSlice.ElementType, unnamedSlice.ElementType))
            }
            if source is ArrayTypeSymbol namedArray &&
                target is ArrayTypeSymbol unnamedArray &&
                namedArray.Length == unnamedArray
                .Length {
                return ArrayTypeSymbol.Get(
                    TransferTupleNames(namedArray.ElementType, unnamedArray.ElementType),
                    unnamedArray.Length
                )
            }
            if source is RectangularArrayTypeSymbol namedRectangular &&
                target is RectangularArrayTypeSymbol unnamedRectangular &&
                namedRectangular.Rank == unnamedRectangular
                .Rank {
                return RectangularArrayTypeSymbol.Get(
                    TransferTupleNames(namedRectangular.ElementType, unnamedRectangular.ElementType),
                    unnamedRectangular.Rank
                )
            }
            return target
        }
    }
}
