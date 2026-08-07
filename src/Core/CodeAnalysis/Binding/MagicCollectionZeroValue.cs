// <copyright file="MagicCollectionZeroValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
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
/// (buffer size, ownership), so channel slots have no zero value at all (see
/// <see cref="RequiresExplicitInitializer"/>). Globals and fields must
/// initialize explicitly (GS0520); locals may declare freely and are instead
/// flow-checked at use sites by <see cref="DefiniteAssignmentAnalyzer"/>
/// (GS0522, issue #3316).
///
/// Issue #3319: a value-type struct slot (local, global, or field) recurses
/// into its OWN declared fields — and transitively into any struct-typed
/// field's fields — synthesizing a <see cref="BoundStructLiteralExpression"/>
/// that carries a <see cref="BoundFieldInitializer"/> for every field whose
/// type (directly or through nested struct composition) needs a sound
/// empty-instance default. This is a NEW bound-tree node per call (never a
/// shared/reused instance — see the aliasing guard in
/// <c>MethodBodyPlanner</c>'s struct-literal slot planner), so it composes
/// safely with every existing consumer of <see cref="TrySynthesizeEmptyInstance"/>:
/// the bare `var s S` declaration path (<c>StatementBinder.BindVariableDeclaration</c>),
/// and the struct/class field-default probes in
/// <c>DeclarationBinder.Structs.cs</c>. Deliberately does NOT run any of the
/// nested struct's own EXPLICIT field initializers — matching the existing
/// "value-struct default bypasses ctors" honesty clause, generalized: a
/// bare declaration only ever gets CLR defaults plus sound magic-collection
/// zero values, at any nesting depth, never arbitrary initializer side
/// effects. Class-typed fields are reference-typed and are NOT recursed into
/// here — a null class reference is the correct, unchanged CLR default; only
/// a nested VALUE-type struct's fields are embedded by value and need this
/// treatment. Inline structs (ADR-0033's fixed synthesized-member layout,
/// see #3219) are excluded from recursion for the same reason #3219 excludes
/// them from ctor synthesis.
/// </summary>
internal static class MagicCollectionZeroValue
{
    /// <summary>
    /// Synthesizes the empty-instance zero value for the given declared type,
    /// or returns <see langword="null"/> when the type keeps its CLR default
    /// (every non-magic-collection, non-struct type; all <c>?</c>-wrapped
    /// types; channels — see <see cref="RequiresExplicitInitializer"/>; and a
    /// struct whose fields, recursively, contain no magic-collection type).
    /// </summary>
    /// <param name="syntax">The originating declaration syntax (may be null in synthesized contexts).</param>
    /// <param name="type">The declared slot type.</param>
    /// <returns>The synthesized empty-instance expression, or null.</returns>
    public static BoundExpression TrySynthesizeEmptyInstance(SyntaxNode syntax, TypeSymbol type)
        => TrySynthesizeEmptyInstanceCore(syntax, type, visiting: null);

    /// <summary>
    /// Issue #3319: a cheap, NON-recursive shape check for whether a
    /// declared field's type is a zero-value CANDIDATE — used at the eager
    /// "probe" call sites in <c>DeclarationBinder.Structs.cs</c> that run
    /// per-struct, during the same compilation-wide pass that populates every
    /// struct's <see cref="StructSymbol.Fields"/> (base-order, not
    /// field-type-composition order). A sibling struct type referenced as a
    /// field's type may not have its OWN <c>Fields</c> populated yet at probe
    /// time, so the probe must NOT recurse (that would silently under-report
    /// via <see cref="StructSymbol"/>'s empty-by-default field list) — it only
    /// asks "is this field's OWN declared type shaped like it might need a
    /// zero value," and defers the real (safe-to-recurse) decision to
    /// <see cref="TrySynthesizeEmptyInstance"/>, called later once every
    /// struct's fields are fully bound (see the "actual synthesis" call
    /// sites that gate on this candidacy).
    /// </summary>
    /// <param name="type">The declared field/slot type.</param>
    /// <returns>True when the type is directly magic, or a non-class non-inline struct that might recursively contain one.</returns>
    public static bool MightNeedZeroValue(TypeSymbol type)
        => type is MapTypeSymbol
            or SliceTypeSymbol
            or ArrayTypeSymbol
            or SequenceTypeSymbol
            or StructSymbol { IsClass: false, IsInline: false };

    /// <summary>
    /// Gets a value indicating whether the declared type is the ADR-0159
    /// channel carve-out: a bare <c>chan T</c> slot has no usable default
    /// value. Declaring a global or field without an initializer is an error
    /// (GS0520); a declared-without-initializer local is legal and instead
    /// subject to the definite-assignment use-site check (GS0522,
    /// issue #3316).
    /// </summary>
    /// <param name="type">The declared slot type.</param>
    /// <returns>True for a bare (non-<c>?</c>) channel type.</returns>
    public static bool RequiresExplicitInitializer(TypeSymbol type)
        => type is ChannelTypeSymbol;

    private static BoundExpression TrySynthesizeEmptyInstanceCore(SyntaxNode syntax, TypeSymbol type, HashSet<StructSymbol> visiting)
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

            // Issue #3319: a value-type struct's OWN fields (recursively) may
            // themselves need sound zero values. Class-typed slots (reference
            // types) and inline structs (fixed layout, #3219) are excluded.
            case StructSymbol structType when !structType.IsClass && !structType.IsInline:
                return TrySynthesizeStructFieldDefaults(syntax, structType, visiting);

            default:
                return null;
        }
    }

    /// <summary>
    /// Issue #3319: builds a <see cref="BoundStructLiteralExpression"/> whose
    /// initializers cover exactly the fields (at any nesting depth of
    /// further value-type struct composition) that need a sound
    /// magic-collection zero value, or returns <see langword="null"/> when
    /// no field in the struct's closure needs one — preserving byte-identical
    /// emission (no ctor synthesis, no literal at all) for every struct
    /// unaffected by ADR-0159. A <c>visiting</c> guard prevents unbounded
    /// recursion for a self-referential struct shape (nothing else in the
    /// compiler currently rejects that as a layout cycle).
    /// </summary>
    private static BoundExpression TrySynthesizeStructFieldDefaults(SyntaxNode syntax, StructSymbol structType, HashSet<StructSymbol> visiting)
    {
        // Key the cycle guard by the generic DEFINITION so a self-referential
        // shape is caught regardless of which closed instantiation is being
        // walked (an open struct can only cycle back to its own definition).
        var visitKey = structType.Definition ?? structType;
        visiting ??= new HashSet<StructSymbol>();
        if (!visiting.Add(visitKey))
        {
            return null;
        }

        try
        {
            ImmutableArray<BoundFieldInitializer>.Builder inits = null;
            var needsZeroValue = false;
            var hasNonPublicZeroValueField = false;
            foreach (var field in structType.Fields)
            {
                var fieldZeroValue = TrySynthesizeEmptyInstanceCore(syntax, field.Type, visiting);
                if (fieldZeroValue == null)
                {
                    continue;
                }

                needsZeroValue = true;

                // Issue #3219 composing with #3319: a non-public field can
                // only be stored into from INSIDE its declaring struct — an
                // external stfld throws FieldAccessException. Declaring this
                // field (unconditionally, regardless of accessibility) as a
                // zero-value candidate at ITS OWN declaration site already
                // makes THAT struct's independent field-default probe (see
                // DeclarationBinder.Structs.cs) populate its own
                // InstanceFieldInitializers entry for it, which in turn
                // makes ConstructorBodyEmitter.NeedsSynthesizedValueStructDefaultCtor
                // return true for it — so its own synthesized parameterless
                // ctor already assigns this field IN-TYPE. Track that here
                // (without emitting an explicit initializer for it — that
                // would require an illegal external store) so the caller
                // still knows this struct needs SOMETHING even if every
                // zero-value field ends up omitted below.
                if (field.Accessibility != Accessibility.Public)
                {
                    hasNonPublicZeroValueField = true;
                    continue;
                }

                inits ??= ImmutableArray.CreateBuilder<BoundFieldInitializer>();
                inits.Add(new BoundFieldInitializer(field, fieldZeroValue));
            }

            if (!needsZeroValue)
            {
                return null;
            }

            // Once at least one non-public field needs a zero value, this
            // struct's OWN #3219 ctor is guaranteed to be synthesized (see
            // above) and — per ConstructorBodyEmitter.BuildInstanceFieldInitializerStatements
            // — that ctor assigns EVERY declared field with a zero-value
            // entry, public or private, in one pass. Emit a field-initializer-free
            // literal so MethodBodyEmitter.EmitStructLiteral routes through
            // `call .ctor()` instead of the historical inline
            // initobj+per-field-stfld path, avoiding both the illegal
            // external private-field store AND a redundant double
            // assignment of any public sibling field.
            var initializers = hasNonPublicZeroValueField
                ? ImmutableArray<BoundFieldInitializer>.Empty
                : inits?.ToImmutable() ?? ImmutableArray<BoundFieldInitializer>.Empty;
            return new BoundStructLiteralExpression(syntax, structType, initializers);
        }
        finally
        {
            visiting.Remove(visitKey);
        }
    }
}
