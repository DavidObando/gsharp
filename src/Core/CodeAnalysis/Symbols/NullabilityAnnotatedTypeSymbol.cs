// <copyright file="NullabilityAnnotatedTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Emit;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// A <see cref="TypeSymbol"/> that wraps an imported CLR generic or array type
/// and carries the full <c>[NullableAttribute]</c> byte array so that
/// inner-position nullability (issue #209) can be recovered when the type is
/// later used as a collection element, dictionary value, etc.
/// </summary>
/// <remarks>
/// <para>
/// The <see cref="NullableFlags"/> array follows the C# compiler's DFS pre-order
/// layout: byte 0 belongs to the outer reference/array position or is the
/// leading zero placeholder for a closed generic value type. Subsequent bytes
/// belong to array elements and generic arguments in DFS order; non-generic
/// value types contribute no position, and <c>Nullable&lt;T&gt;</c> is
/// transparent.
/// </para>
/// <para>
/// Example — <c>Dictionary&lt;string, string?&gt;</c>:<br/>
/// flags = { 1 (Dictionary non-null), 1 (string key non-null), 2 (string? value nullable) }.
/// </para>
/// </remarks>
public sealed class NullabilityAnnotatedTypeSymbol : TypeSymbol
{
    internal NullabilityAnnotatedTypeSymbol(TypeSymbol baseType, ImmutableArray<byte> nullableFlags)
        : base(baseType.Name, baseType.ClrType)
    {
        BaseType = baseType;
        NullableFlags = nullableFlags;
    }

    /// <summary>Gets the underlying non-annotated type symbol.</summary>
    public override TypeSymbol BaseType { get; }

    /// <summary>
    /// Gets the full <c>[NullableAttribute]</c> byte array for this type, starting
    /// at the outer type's own byte (index 0).
    /// </summary>
    public ImmutableArray<byte> NullableFlags { get; }

    /// <summary>
    /// Returns the <see cref="TypeSymbol"/> for the generic type argument at
    /// <paramref name="argIndex"/> (0-based), with reference nullability applied
    /// from <see cref="NullableFlags"/>.
    /// </summary>
    /// <param name="argIndex">0-based index into the outer CLR type's generic arguments.</param>
    /// <returns>
    /// The properly-nullified symbol, or <see cref="TypeSymbol.Error"/> when the
    /// outer CLR type is not a closed generic.
    /// </returns>
    public TypeSymbol GetTypeArgumentSymbol(int argIndex)
    {
        var clr = ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return TypeSymbol.Error;
        }

        var args = clr.GetGenericArguments();
        if ((uint)argIndex >= (uint)args.Length)
        {
            return TypeSymbol.Error;
        }

        // Byte 0 belongs to the outer type itself (a reference type).
        int offset = 1;
        for (int i = 0; i < argIndex; i++)
        {
            offset += ClrNullability.CountNullabilityBytes(args[i]);
        }

        var derived = ClrNullability.SymbolFromFlagsOffset(args[argIndex], NullableFlags, offset);

        // ADR-0172: the flags-derived argument is rebuilt from the CLR shape,
        // which cannot carry tuple element names. When the wrapped symbolic
        // base holds a named tuple at this position, transfer its names.
        if (BaseType is ImportedTypeSymbol { TypeArguments.IsDefaultOrEmpty: false } symbolicBase
            && (uint)argIndex < (uint)symbolicBase.TypeArguments.Length)
        {
            var symbolicArgument = symbolicBase.TypeArguments[argIndex];
            derived = TypeSymbol.ContainsNamedTupleElements(symbolicArgument)
                ? TransferTupleNames(symbolicArgument, derived)
                : NullableFlagsBuilder.MergeDeclarationNullability(
                    symbolicArgument,
                    args[argIndex],
                    ClrNullability.GetNullableFlagsForSubtree(
                        args[argIndex],
                        NullableFlags,
                        offset));
        }

        return derived;
    }

    /// <summary>
    /// Searches the outer type's generic arguments or array element for one whose
    /// resolved CLR type matches <paramref name="targetClrType"/> and returns a
    /// properly-nullified <see cref="TypeSymbol"/> for it. Falls back to a plain
    /// <see cref="TypeSymbol.FromClrType"/> result when no matching argument is found.
    /// </summary>
    /// <param name="targetClrType">The CLR element type to locate.</param>
    /// <returns>The nullified symbol for the first matching argument.</returns>
    public TypeSymbol GetTypeArgumentSymbolForClrType(Type? targetClrType)
    {
        if (targetClrType == null)
        {
            return TypeSymbol.Error;
        }

        var clr = ClrType;
        if (clr?.IsArray == true)
        {
            var elementType = clr.GetElementType();
            return elementType != null
                && (elementType == targetClrType
                    || (!elementType.IsGenericParameter && elementType.FullName == targetClrType.FullName))
                    ? ClrNullability.SymbolFromFlagsOffset(elementType, NullableFlags, 1)
                    : TypeSymbol.FromClrType(targetClrType);
        }

        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return TypeSymbol.FromClrType(targetClrType);
        }

        var args = clr.GetGenericArguments();
        if (targetClrType.IsGenericParameter
            && (uint)targetClrType.GenericParameterPosition < (uint)args.Length)
        {
            return GetTypeArgumentSymbol(targetClrType.GenericParameterPosition);
        }

        int offset = 1; // byte 0 = outer type

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
        var matchIndex = -1;
        var matchOffset = 0;
        var ambiguous = false;

        for (int i = 0; i < args.Length; i++)
        {
            var arg = args[i];

            // Compare by FullName so MetadataLoadContext types match runtime types.
            if (arg == targetClrType || (!arg.IsGenericParameter && arg.FullName == targetClrType.FullName))
            {
                if (matchIndex >= 0)
                {
                    ambiguous = true;
                }
                else
                {
                    matchIndex = i;
                    matchOffset = offset;
                }
            }

            offset += ClrNullability.CountNullabilityBytes(arg);
        }

        if (matchIndex >= 0 && !ambiguous)
        {
            var arg = args[matchIndex];
            var flagged = ClrNullability.SymbolFromFlagsOffset(arg, NullableFlags, matchOffset);

            // ADR-0172: transfer tuple element names from the wrapped
            // symbolic base's matching argument (the flags-derived symbol
            // is rebuilt from the CLR shape and cannot carry them).
            if (BaseType is ImportedTypeSymbol { TypeArguments.IsDefaultOrEmpty: false } symbolicBase
                && (uint)matchIndex < (uint)symbolicBase.TypeArguments.Length)
            {
                flagged = TransferTupleNames(symbolicBase.TypeArguments[matchIndex], flagged);
            }

            return flagged;
        }

        return TypeSymbol.FromClrType(targetClrType);
    }

    /// <summary>
    /// Issue #4159: grafts tuple element names from <paramref name="source"/>
    /// (the naive, name-bearing symbolic type — see
    /// <see cref="TypeSymbol.ContainsNamedTupleElements"/>) onto
    /// <paramref name="target"/> (the flags-derived, nullability-correct but
    /// unnamed type built by <see cref="ClrNullability.SymbolFromFlagsOffset"/>),
    /// recursing through every shape the CLR-import symbol tree can produce.
    /// <para>
    /// A prior version of this method only matched a tuple sitting DIRECTLY at
    /// the top of the position being merged (optionally under one
    /// <c>Nullable</c> wrapper) — so a named tuple nested one level deeper,
    /// e.g. <c>IReadOnlyList[(string Key, string? Value)]</c> reached through
    /// an <c>async Task[...]</c> return, was silently left unnamed: this
    /// method returned <paramref name="target"/> unchanged because the
    /// top-level shape (<see cref="ImportedTypeSymbol"/>) didn't match either
    /// pattern, even though <see cref="TypeSymbol.ContainsNamedTupleElements"/>
    /// (which recurses) correctly said "yes, look deeper" to the caller.
    /// </para>
    /// </summary>
    /// <param name="source">The naive, name-bearing symbolic type at this position.</param>
    /// <param name="target">The flags-derived, correctly-nullable but unnamed type at this position.</param>
    /// <returns><paramref name="target"/>'s shape with tuple names grafted in wherever <paramref name="source"/> has them.</returns>
    private static TypeSymbol TransferTupleNames(TypeSymbol source, TypeSymbol target)
    {
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
        if (target is NullableTypeSymbol targetNullable)
        {
            var sourceForUnderlying = source is NullableTypeSymbol namedNullable
                ? namedNullable.UnderlyingType
                : source;
            return NullableTypeSymbol.Get(TransferTupleNames(sourceForUnderlying, targetNullable.UnderlyingType));
        }

        if (source is TupleTypeSymbol namedTuple
            && target is TupleTypeSymbol unnamedTuple
            && namedTuple.Arity == unnamedTuple.Arity)
        {
            var elements = ImmutableArray.CreateBuilder<TypeSymbol>(unnamedTuple.ElementTypes.Length);
            for (var i = 0; i < unnamedTuple.ElementTypes.Length; i++)
            {
                elements.Add(TransferTupleNames(namedTuple.ElementTypes[i], unnamedTuple.ElementTypes[i]));
            }

            return unnamedTuple.HasNames
                ? TupleTypeSymbol.Get(elements.MoveToImmutable(), unnamedTuple.ElementNames)
                : TupleTypeSymbol.Get(elements.MoveToImmutable(), namedTuple.ElementNames);
        }

        if (source is ImportedTypeSymbol { TypeArguments.IsDefaultOrEmpty: false } namedImported
            && target is ImportedTypeSymbol { TypeArguments.IsDefaultOrEmpty: false } unnamedImported
            && unnamedImported.ClrType is Type unnamedImportedClr
            && namedImported.TypeArguments.Length == unnamedImported.TypeArguments.Length
            && TypeSymbol.ContainsNamedTupleElements(namedImported))
        {
            var arguments = ImmutableArray.CreateBuilder<TypeSymbol>(unnamedImported.TypeArguments.Length);
            for (var i = 0; i < unnamedImported.TypeArguments.Length; i++)
            {
                arguments.Add(TransferTupleNames(namedImported.TypeArguments[i], unnamedImported.TypeArguments[i]));
            }

            return ImportedTypeSymbol.GetConstructed(
                unnamedImportedClr,
                unnamedImported.OpenDefinition ?? namedImported.OpenDefinition,
                arguments.MoveToImmutable());
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
        if (target is NullabilityAnnotatedTypeSymbol annotatedTarget
            && source is ImportedTypeSymbol { TypeArguments.IsDefaultOrEmpty: false } namedSourceGeneric
            && annotatedTarget.ClrType is Type annotatedTargetClr
            && annotatedTargetClr.IsGenericType
            && !annotatedTargetClr.IsGenericTypeDefinition
            && TypeSymbol.ContainsNamedTupleElements(namedSourceGeneric))
        {
            var clrArguments = annotatedTargetClr.GetGenericArguments();
            if (namedSourceGeneric.TypeArguments.Length == clrArguments.Length)
            {
                var openDefinition = (annotatedTarget.BaseType as ImportedTypeSymbol)?.OpenDefinition
                    ?? annotatedTargetClr.GetGenericTypeDefinition();
                var arguments = ImmutableArray.CreateBuilder<TypeSymbol>(clrArguments.Length);
                for (var i = 0; i < clrArguments.Length; i++)
                {
                    var materialized = annotatedTarget.GetTypeArgumentSymbol(i);
                    arguments.Add(TransferTupleNames(namedSourceGeneric.TypeArguments[i], materialized));
                }

                return ImportedTypeSymbol.GetConstructed(annotatedTargetClr, openDefinition, arguments.MoveToImmutable());
            }
        }

        if (source is SliceTypeSymbol namedSlice && target is SliceTypeSymbol unnamedSlice)
        {
            return SliceTypeSymbol.Get(TransferTupleNames(namedSlice.ElementType, unnamedSlice.ElementType));
        }

        if (source is ArrayTypeSymbol namedArray
            && target is ArrayTypeSymbol unnamedArray
            && namedArray.Length == unnamedArray.Length)
        {
            return ArrayTypeSymbol.Get(TransferTupleNames(namedArray.ElementType, unnamedArray.ElementType), unnamedArray.Length);
        }

        if (source is RectangularArrayTypeSymbol namedRectangular
            && target is RectangularArrayTypeSymbol unnamedRectangular
            && namedRectangular.Rank == unnamedRectangular.Rank)
        {
            return RectangularArrayTypeSymbol.Get(
                TransferTupleNames(namedRectangular.ElementType, unnamedRectangular.ElementType),
                unnamedRectangular.Rank);
        }

        return target;
    }
}
