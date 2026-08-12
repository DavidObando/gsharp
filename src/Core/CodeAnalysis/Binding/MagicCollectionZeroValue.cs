// <copyright file="MagicCollectionZeroValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #3310 / ADR-0159: sound zero values for the magic collection types.
/// A declared-without-initializer slot of type <c>map[K, V]</c>, <c>[]T</c>,
/// <c>[N]T</c>, <c>[,]T</c>, or <c>sequence[T]</c> binds an <b>empty instance</b> instead
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
///
/// Issue #3329: the same-assembly recursion above depends on
/// <see cref="StructSymbol.Fields"/> being reachable and fully bound — true
/// for a struct declared in THIS compilation, but not for a struct symbol
/// rebuilt from reflection over an ALREADY-EMITTED type in another assembly
/// (or, for the REPL, an earlier submission): that reconstruction (see
/// <c>ImportedTypeSymbol.BuildSemanticAggregate</c>) resolves each field's
/// type via raw CLR reflection (<c>TypeSymbol.FromClrType</c>), which cannot
/// by itself distinguish a slice from a same-CLR-shaped fixed array, or
/// know that a nested struct-typed field needs its own zero-value probe at
/// all. <see cref="ClassifyForMarker"/> / <see cref="TrySynthesizeEmptyInstanceFromMarker"/>
/// and the <c>GSharp.MagicCollectionFields</c> assembly-metadata marker (see
/// <see cref="Symbols.ImportedAssemblySemantics"/>) close that gap: the
/// DECLARING compilation records, per struct, which fields (magic-collection
/// OR struct-typed-and-recursively-magic) need synthesis, so an IMPORTING
/// compilation's struct literal can reconstruct the identical zero value
/// without ever needing the declaring compilation's own bound tree.
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
    public static BoundExpression? TrySynthesizeEmptyInstance(SyntaxNode? syntax, TypeSymbol type)
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
            or RectangularArrayTypeSymbol
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

    /// <summary>
    /// Issue #3329: classifies a struct field's shape into the compact tag
    /// recorded by the <c>GSharp.MagicCollectionFields</c> cross-assembly
    /// metadata marker (see <see cref="Symbols.ImportedAssemblySemantics"/>).
    /// A struct's own <see cref="StructSymbol.InstanceFieldInitializers"/> —
    /// where this zero-value synthesis is normally recorded (see
    /// <c>DeclarationBinder.Structs.cs</c>) — is unavailable once the struct
    /// is referenced from ANOTHER assembly (or, for the REPL, a LATER
    /// submission): only the declaring compilation ever binds the struct's
    /// own declaration syntax. The marker plus
    /// <see cref="TrySynthesizeEmptyInstanceFromMarker"/> let a struct
    /// literal reconstruct the same sound zero value from the field's own
    /// reflected CLR shape. Issue #3330 composition: a struct-typed field is
    /// tagged <c>"struct"</c> when — and only when — recursing into ITS
    /// fields (via the same same-assembly <see cref="TrySynthesizeEmptyInstance"/>
    /// recursion #3330 added) actually finds a magic-collection zero value
    /// somewhere in its closure; a struct field with no such need is left
    /// unmarked, exactly like every other unaffected field.
    /// </summary>
    /// <param name="type">The field's declared type.</param>
    /// <returns>The marker tag, or <see langword="null"/> when the type is not a magic-collection or recursively-magic struct shape.</returns>
    internal static string? ClassifyForMarker(TypeSymbol type) => type switch
    {
        MapTypeSymbol => "map",
        SliceTypeSymbol => "slice",
        ArrayTypeSymbol arr => "arr" + arr.Length.ToString(CultureInfo.InvariantCulture),
        RectangularArrayTypeSymbol array => "rect" + array.Rank.ToString(CultureInfo.InvariantCulture),
        SequenceTypeSymbol => "seq",
        StructSymbol { IsClass: false, IsInline: false } structField when TrySynthesizeEmptyInstance(null, structField) != null => "struct",
        _ => null,
    };

    /// <summary>
    /// The inverse of <see cref="ClassifyForMarker"/>: reconstructs the
    /// magic-collection <see cref="TypeSymbol"/> shape (or, for a nested
    /// struct field, the recursively-synthesized struct literal) named by
    /// <paramref name="markerKind"/> from a reflected field's OWN CLR type —
    /// the marker tag alone disambiguates a slice from a same-CLR-shaped
    /// fixed-size array (both are plain CLR SZ arrays with no length
    /// encoded) and records the fixed length — then synthesizes its sound
    /// zero value (see <see cref="TrySynthesizeEmptyInstance"/>).
    /// </summary>
    /// <param name="fieldInfo">The reflected field the marker describes.</param>
    /// <param name="markerKind">The marker tag produced by <see cref="ClassifyForMarker"/>.</param>
    /// <returns>The synthesized empty-instance expression, or <see langword="null"/> when the field/tag cannot be reconstructed.</returns>
    internal static BoundExpression? TrySynthesizeEmptyInstanceFromMarker(FieldInfo? fieldInfo, string? markerKind)
    {
        if (fieldInfo == null || string.IsNullOrEmpty(markerKind))
        {
            return null;
        }

        // Issue #3330 composition: a nested struct-typed field. Its own zero
        // value is reconstructed by recursing into ITS reflected CLR type —
        // NOT via ClassifyForMarker/this marker (that describes the OUTER
        // field only) — reusing the exact same cross-assembly reconstruction
        // this method performs for a leaf magic-collection field, one level
        // deeper. This mirrors #3330's same-assembly struct-in-struct
        // recursion, but walks reflected metadata instead of a bound
        // StructSymbol.
        if (string.Equals(markerKind, "struct", StringComparison.Ordinal))
        {
            return TrySynthesizeEmptyInstanceForImportedStruct(fieldInfo.FieldType);
        }

        TypeSymbol type;
        if (string.Equals(markerKind, "map", StringComparison.Ordinal))
        {
            var args = fieldInfo.FieldType.GetGenericArguments();
            if (args.Length != 2)
            {
                return null;
            }

            type = MapTypeSymbol.Get(TypeSymbol.FromClrType(args[0]), TypeSymbol.FromClrType(args[1]));
        }
        else if (string.Equals(markerKind, "slice", StringComparison.Ordinal))
        {
            var elementClr = fieldInfo.FieldType.GetElementType();
            if (elementClr == null)
            {
                return null;
            }

            type = SliceTypeSymbol.Get(TypeSymbol.FromClrType(elementClr));
        }
        else if (markerKind.StartsWith("arr", StringComparison.Ordinal))
        {
            var elementClr = fieldInfo.FieldType.GetElementType();
            if (elementClr == null || !int.TryParse(markerKind.AsSpan(3), NumberStyles.Integer, CultureInfo.InvariantCulture, out var length))
            {
                return null;
            }

            type = ArrayTypeSymbol.Get(TypeSymbol.FromClrType(elementClr), length);
        }
        else if (markerKind.StartsWith("rect", StringComparison.Ordinal))
        {
            var elementClr = fieldInfo.FieldType.GetElementType();
            if (elementClr == null
                || !fieldInfo.FieldType.IsArray
                || !int.TryParse(
                    markerKind.AsSpan(4),
                    NumberStyles.Integer,
                    CultureInfo.InvariantCulture,
                    out var rank)
                || fieldInfo.FieldType.GetArrayRank() != rank)
            {
                return null;
            }

            type = RectangularArrayTypeSymbol.Get(TypeSymbol.FromClrType(elementClr), rank);
        }
        else if (string.Equals(markerKind, "seq", StringComparison.Ordinal))
        {
            var args = fieldInfo.FieldType.GetGenericArguments();
            if (args.Length != 1)
            {
                return null;
            }

            type = SequenceTypeSymbol.Get(TypeSymbol.FromClrType(args[0]));
        }
        else
        {
            return null;
        }

        return TrySynthesizeEmptyInstance(null, type);
    }

    /// <summary>
    /// Issue #3329/#3330 composition: reconstructs a
    /// <see cref="BoundStructLiteralExpression"/> for a NESTED struct-typed
    /// field's own zero value, purely from its reflected CLR
    /// <paramref name="clrType"/> and its OWN
    /// <c>GSharp.MagicCollectionFields</c> marker (every gsc-compiled struct
    /// with a field needing synthesis carries its own independent marker
    /// entry — see <c>AssemblyAttributeEmitter.EmitGSharpMagicCollectionFieldMarkers</c>,
    /// which iterates every struct in the compilation, not just top-level
    /// ones). This does not require (and does not build) a full imported
    /// <c>StructSymbol</c> aggregate for <paramref name="clrType"/> — a
    /// synthetic minimal one is enough to carry the emitted field
    /// initializers, mirroring exactly what a same-assembly recursive
    /// <see cref="TrySynthesizeStructFieldDefaults"/> call would have built
    /// had the struct been declared in this compilation.
    /// </summary>
    /// <param name="clrType">The nested struct field's own reflected CLR type.</param>
    /// <returns>The synthesized nested struct literal, or <see langword="null"/> when it carries no marker or no field of it can be reconstructed.</returns>
    private static BoundExpression? TrySynthesizeEmptyInstanceForImportedStruct(Type? clrType)
    {
        if (clrType == null || !ImportedAssemblySemantics.TryGetMagicCollectionFields(clrType, out var magicFieldKinds))
        {
            return null;
        }

        var bindingFlags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        var fieldBuilder = ImmutableArray.CreateBuilder<FieldSymbol>();
        var reflectedFields = new Dictionary<string, FieldInfo>(StringComparer.Ordinal);
        foreach (var field in ClrTypeUtilities.SafeGetFields(clrType, bindingFlags))
        {
            if (field.IsStatic || field.IsSpecialName)
            {
                continue;
            }

            fieldBuilder.Add(new FieldSymbol(
                field.Name,
                TypeSymbol.FromClrType(field.FieldType),
                field.IsPublic ? Accessibility.Public : Accessibility.Private,
                isReadOnly: field.IsInitOnly));
            reflectedFields[field.Name] = field;
        }

        var nestedStruct = new StructSymbol(
            name: clrType.Name,
            fields: fieldBuilder.ToImmutable(),
            accessibility: Accessibility.Public,
            declaration: null,
            packageName: clrType.Namespace ?? string.Empty,
            isData: false,
            isInline: false,
            isClass: false,
            primaryConstructorParameters: ImmutableArray<ParameterSymbol>.Empty,
            isOpen: false,
            baseClass: null,
            clrType: clrType);

        var fieldsByName = nestedStruct.Fields.ToDictionary(f => f.Name, StringComparer.Ordinal);
        ImmutableArray<BoundFieldInitializer>.Builder? inits = null;
        foreach (var (fieldName, kind) in magicFieldKinds)
        {
            if (!fieldsByName.TryGetValue(fieldName, out var fieldSymbol)
                || fieldSymbol.Accessibility != Accessibility.Public
                || !reflectedFields.TryGetValue(fieldName, out var reflectedField))
            {
                continue;
            }

            var zeroValue = TrySynthesizeEmptyInstanceFromMarker(reflectedField, kind);
            if (zeroValue == null)
            {
                continue;
            }

            inits ??= ImmutableArray.CreateBuilder<BoundFieldInitializer>();
            inits.Add(new BoundFieldInitializer(fieldSymbol, zeroValue));
        }

        if (inits == null)
        {
            return null;
        }

        return new BoundStructLiteralExpression(null, nestedStruct, inits.ToImmutable());
    }

    private static BoundExpression? TrySynthesizeEmptyInstanceCore(SyntaxNode? syntax, TypeSymbol type, HashSet<StructSymbol>? visiting)
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

            case RectangularArrayTypeSymbol rectangularType:
                var dimensions = ImmutableArray.CreateBuilder<BoundExpression>(rectangularType.Rank);
                for (var i = 0; i < rectangularType.Rank; i++)
                {
                    dimensions.Add(new BoundLiteralExpression(syntax, 0, TypeSymbol.Int32));
                }

                return BoundArrayCreationExpression.CreateRectangular(
                    syntax,
                    rectangularType,
                    dimensions.MoveToImmutable());

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
    private static BoundExpression? TrySynthesizeStructFieldDefaults(SyntaxNode? syntax, StructSymbol structType, HashSet<StructSymbol>? visiting)
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
            ImmutableArray<BoundFieldInitializer>.Builder? inits = null;
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
