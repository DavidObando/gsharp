// <copyright file="MagicCollectionZeroValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #3310 / ADR-0159: sound zero values for the magic collection types.
/// A declared-without-initializer slot of type <c>map[K, V]</c>, <c>[]T</c>,
/// <c>[N]T</c>, or <c>sequence[T]</c> binds an <b>empty instance</b> instead
/// of a null reference, making the bare (non-<c>?</c>) spelling's non-null
/// promise true (the #2262 NRE class). The synthesized expressions reuse the
/// existing literal machinery — <see cref="BoundMapLiteralExpression"/> with
/// zero entries (symbolic <c>Dictionary`2</c> ctor MemberRefs per #1481/#3306
/// for open K/V) and <see cref="BoundArrayCreationExpression"/> (symbolic
/// <c>newarr</c> element token for open element types) — so generic contexts
/// are covered by already-verified emit paths. <c>chan T</c> is deliberately
/// NOT synthesized here: an auto-created channel has no sensible default
/// (buffer size, ownership), so channel slots require an explicit initializer
/// (GS0520; see <see cref="RequiresExplicitInitializer"/>).
/// </summary>
internal static class MagicCollectionZeroValue
{
    /// <summary>
    /// Synthesizes the empty-instance zero value for the given declared type,
    /// or returns <see langword="null"/> when the type keeps its CLR default
    /// (every non-magic-collection type, all <c>?</c>-wrapped types, and
    /// channels — see <see cref="RequiresExplicitInitializer"/>).
    /// </summary>
    /// <param name="syntax">The originating declaration syntax (may be null in synthesized contexts).</param>
    /// <param name="type">The declared slot type.</param>
    /// <returns>The synthesized empty-instance expression, or null.</returns>
    public static BoundExpression TrySynthesizeEmptyInstance(SyntaxNode syntax, TypeSymbol type)
    {
        switch (type)
        {
            case MapTypeSymbol mapType:
                // `map[K, V]{}` — symbolic Dictionary`2 ctor for open K/V.
                return new BoundMapLiteralExpression(syntax, mapType, ImmutableArray<BoundMapEntry>.Empty);

            case SliceTypeSymbol sliceType:
                // `[]T{}` — `ldc.i4.0; newarr T` with the symbolic element token.
                return new BoundArrayCreationExpression(syntax, sliceType, ImmutableArray<BoundExpression>.Empty);

            case ArrayTypeSymbol arrayType:
                // `[N]T`'s zero value is N zeroed elements (`newarr` self-
                // zero-inits), via the runtime-length allocation form. The
                // ELEMENTS stay CLR defaults — ADR-0159's element-default
                // honesty clause (the C# NRT array hole).
                return new BoundArrayCreationExpression(
                    syntax,
                    arrayType,
                    new BoundLiteralExpression(syntax, arrayType.Length, TypeSymbol.Int32));

            case SequenceTypeSymbol sequenceType:
                // The empty sequence is an empty T[] held as IEnumerable<T> —
                // a no-op reference conversion at the IL level (array-to-
                // interface), recognized symbolically for open element types
                // by the matching #3310 arms in Conversion.ClassifyCore and
                // MethodBodyEmitter.IsReferenceCompatible.
                return new BoundConversionExpression(
                    syntax,
                    sequenceType,
                    new BoundArrayCreationExpression(
                        syntax,
                        SliceTypeSymbol.Get(sequenceType.ElementType),
                        ImmutableArray<BoundExpression>.Empty));

            default:
                return null;
        }
    }

    /// <summary>
    /// Gets a value indicating whether the declared type is the ADR-0159
    /// channel carve-out: a bare <c>chan T</c> slot has no usable default
    /// value, so declaring one without an initializer is an error (GS0520).
    /// </summary>
    /// <param name="type">The declared slot type.</param>
    /// <returns>True for a bare (non-<c>?</c>) channel type.</returns>
    public static bool RequiresExplicitInitializer(TypeSymbol type)
        => type is ChannelTypeSymbol;
}
