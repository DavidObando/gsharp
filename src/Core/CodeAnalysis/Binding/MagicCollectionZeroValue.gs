// <copyright file="MagicCollectionZeroValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Reflection

/// Issue #3310 / ADR-0159: sound zero values for the magic collection types.
/// A declared-without-initializer slot of type `map[K, V]`, `[]T`,
/// `[N]T`, `[,]T`, or `sequence[T]` binds an <b>empty instance</b> instead
/// of a null reference, making the bare (non-`?`) spelling's non-null
/// promise true (the #2262 NRE class). The synthesized expressions reuse the
/// existing literal machinery — (cref:BoundMapLiteralExpression) with
/// zero entries (symbolic `Dictionary`2` ctor MemberRefs per #1481/#3306
/// for open K/V) and (cref:BoundArrayCreationExpression) (symbolic
/// `newarr` element token for open element types) — so generic contexts
/// are covered by already-verified emit paths. `chan T` is deliberately
/// NOT synthesized here: an auto-created channel has no sensible default
/// (buffer size, ownership), so channel slots have no zero value at all (see
/// (cref:RequiresExplicitInitializer)). Globals and fields must
/// initialize explicitly (GS0520); locals may declare freely and are instead
/// flow-checked at use sites by (cref:DefiniteAssignmentAnalyzer)
/// (GS0522, issue #3316).
///
/// Issue #3319: a value-type struct slot (local, global, or field) recurses
/// into its OWN declared fields — and transitively into any struct-typed
/// field's fields — synthesizing a (cref:BoundStructLiteralExpression)
/// that carries a (cref:BoundFieldInitializer) for every field whose
/// type (directly or through nested struct composition) needs a sound
/// empty-instance default. This is a NEW bound-tree node per call (never a
/// shared/reused instance — see the aliasing guard in
/// `MethodBodyPlanner`'s struct-literal slot planner), so it composes
/// safely with every existing consumer of (cref:TrySynthesizeEmptyInstance):
/// the bare `var s S` declaration path (`StatementBinder.BindVariableDeclaration`),
/// and the struct/class field-default probes in
/// `DeclarationBinder.Structs.cs`. Deliberately does NOT run any of the
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
/// (cref:StructSymbol.Fields) being reachable and fully bound — true
/// for a struct declared in THIS compilation, but not for a struct symbol
/// rebuilt from reflection over an ALREADY-EMITTED type in another assembly
/// (or, for the REPL, an earlier submission): that reconstruction (see
/// `ImportedTypeSymbol.BuildSemanticAggregate`) resolves each field's
/// type via raw CLR reflection (`TypeSymbol.FromClrType`), which cannot
/// by itself distinguish a slice from a same-CLR-shaped fixed array, or
/// know that a nested struct-typed field needs its own zero-value probe at
/// all. (cref:ClassifyForMarker) / (cref:TrySynthesizeEmptyInstanceFromMarker)
/// and the `GSharp.MagicCollectionFields` assembly-metadata marker (see
/// (cref:Symbols.ImportedAssemblySemantics)) close that gap: the
/// DECLARING compilation records, per struct, which fields (magic-collection
/// OR struct-typed-and-recursively-magic) need synthesis, so an IMPORTING
/// compilation's struct literal can reconstruct the identical zero value
/// without ever needing the declaring compilation's own bound tree.
internal shared class MagicCollectionZeroValue {
    /// Synthesizes the empty-instance zero value for the given declared type,
    /// or returns `null` when the type keeps its CLR default
    /// (every non-magic-collection, non-struct type; all `?`-wrapped
    /// types; channels — see (cref:RequiresExplicitInitializer); and a
    /// struct whose fields, recursively, contain no magic-collection type).
    /// @param syntax The originating declaration syntax (may be null in synthesized contexts).
    /// @param type The declared slot type.
    /// @returns The synthesized empty-instance expression, or null.
    func TrySynthesizeEmptyInstance(syntax SyntaxNode?, type TypeSymbol) BoundExpression? -> TrySynthesizeEmptyInstance(
        syntax,
        type,
        out _
    )

    internal func TrySynthesizeEmptyInstance(
        syntax SyntaxNode?,
        type TypeSymbol,
        out missingDeclarationShape bool
    ) BoundExpression? -> TrySynthesizeEmptyInstanceCore(
        syntax,
        type,
        visiting: nil,
        Dictionary[TypeSymbol, bool](),
        out missingDeclarationShape
    )

    /// Issue #3319: a cheap, NON-recursive shape check for whether a
    /// declared field's type is a zero-value CANDIDATE — used at the eager
    /// "probe" call sites in `DeclarationBinder.Structs.cs` that run
    /// per-struct, during the same compilation-wide pass that populates every
    /// struct's (cref:StructSymbol.Fields) (base-order, not
    /// field-type-composition order). A sibling struct type referenced as a
    /// field's type may not have its OWN `Fields` populated yet at probe
    /// time, so the probe must NOT recurse (that would silently under-report
    /// via (cref:StructSymbol)'s empty-by-default field list) — it only
    /// asks "is this field's OWN declared type shaped like it might need a
    /// zero value," and defers the real (safe-to-recurse) decision to
    /// (cref:TrySynthesizeEmptyInstance), called later once every
    /// struct's fields are fully bound (see the "actual synthesis" call
    /// sites that gate on this candidacy).
    /// @param type The declared field/slot type.
    /// @returns True for a magic collection, imported value type, or non-class non-inline source struct.
    func MightNeedZeroValue(type TypeSymbol) bool -> type is MapTypeSymbol ||
        type is SliceTypeSymbol ||
        type is ArrayTypeSymbol ||
        type is RectangularArrayTypeSymbol ||
        type is SequenceTypeSymbol ||
        type is ImportedTypeSymbol &&
        type
        .Type
        .IsValueType ||
        type is StructSymbol &&
        type.IsClass == false &&
        type.IsInline == false

    /// Gets a value indicating whether the declared type is the ADR-0159
    /// channel carve-out: a bare `chan T` slot has no usable default
    /// value. Declaring a global or field without an initializer is an error
    /// (GS0520); a declared-without-initializer local is legal and instead
    /// subject to the definite-assignment use-site check (GS0522,
    /// issue #3316).
    /// @param type The declared slot type.
    /// @returns True for a bare (non-`?`) channel type.
    func RequiresExplicitInitializer(type TypeSymbol) bool -> type is ChannelTypeSymbol ||
        ManagedReferenceTypes.TryGetElement(type, out _, out _) || NativeProtocolMetadata.IsProtocol(type)

    /// Synthesizes a field value only when the definition's in-type zero
    /// constructor actually writes that storage.
    /// @param syntax The originating zero-value syntax.
    /// @param owner The actual declaring construction.
    /// @param field The bound storage identity.
    /// @returns The constructed field's zero value, or null for untouched storage.
    internal func TrySynthesizeInTypeZeroField(
        syntax SyntaxNode?,
        owner StructSymbol,
        field FieldSymbol
    ) BoundExpression? {
        // Constructed fields preserve definition order; property backing fields
        // are not in this list. A closed T must not invent a definition-time store.
        if owner.GetDefinitionField(field) is not{} definitionField {
            return nil
        }
        let value BoundExpression? = TrySynthesizeEmptyInstance(syntax, definitionField.Type)
        return if value == nil || object.ReferenceEquals(definitionField.Type, field.Type) {
            value
        } else {
            TrySynthesizeEmptyInstance(syntax, field.Type)
        }
    }

    internal func TrySynthesizePrimaryArgument(
        syntax SyntaxNode?,
        owner StructSymbol,
        parameter ParameterSymbol,
        out missingDeclarationShape bool,
        parameterType TypeSymbol? = nil,
        constructor ConstructorInfo? = nil
    ) BoundExpression? {
        missingDeclarationShape = false
        let type = parameterType ?? parameter.Type
        if type.ReferenceNullability == ReferenceNullabilityKind.Nullable || NullableLifting.IsAnyValueTypeNullable(
            type as NullableTypeSymbol
        ) {
            return nil
        }
        if owner.ClrType is {} imported {
            let index = owner.PrimaryConstructorParameters.IndexOf(parameter)
            let field = owner.GetDataConstructionPrimaryField(imported, index)
            if field != nil && ImportedAssemblySemantics.TryGetMagicCollectionFields(imported, out var kinds) &&
                kinds!!
                .TryGetValue(field.Name, out var kind) {
                let zero = TrySynthesizeEmptyInstanceFromMarker(
                    field,
                    kind,
                    out missingDeclarationShape,
                    parameterType ?? MemberLookup.GetClrFieldTypeSymbol(owner, field)
                )
                // A declared marker cannot fall back to a different zero recipe.
                return zero
            }
            if constructor != nil {
                let declaration = if imported.IsGenericType && !imported.IsGenericTypeDefinition {
                    ClrTypeUtilities.FindMetadataDefinition(
                        imported.GetGenericTypeDefinition(),
                        constructor,
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
                    ) as ConstructorInfo
                } else {
                    constructor
                }
                if declaration == nil {
                    missingDeclarationShape = true
                    return nil
                }
                // Only whole-slot parameters preserve constructed collection shapes without declaration metadata.
                let declaredType = declaration.GetParameters()[index].ParameterType
                let collectionShape = declaredType.IsArray || MapTypeSymbol.TryGetMapShape(type, out _, out _) ||
                    SequenceTypeSymbol.TryGetEnumerableInterfaceShape(
                    type.StripToBareShape(),
                    out var definition,
                    out _
                ) &&
                    definition.IsSameAs(typeof(IEnumerable[_]))
                if !declaredType.IsGenericParameter && collectionShape {
                    missingDeclarationShape = true
                    return nil
                }
            }
        }
        return TrySynthesizeEmptyInstance(syntax, type, out missingDeclarationShape)
    }

    internal func CanSynthesizeInTypeZeroConstructor(owner StructSymbol) bool {
        var hasZero = false
        for field in owner.Fields {
            if TrySynthesizeInTypeZeroField(nil, owner, field) is {} zero {
                if !CanInitializeZeroValue(zero) {
                    return false
                }
                hasZero = true
            }
        }
        return hasZero
    }

    private func CanInitializeZeroValue(value BoundExpression) bool {
        if value is not BoundStructLiteralExpression literal {
            return true
        }
        // IsInTypeZeroInitializer queries this probe when it selects a helper.
        // Source stores belong to the prospective helper; imported stores remain external.
        return literal.Initializers.All(
            (initializer BoundFieldInitializer) ->
            (
                literal
                    .StructType
                    .ClrType == nil ||
                    initializer.Field == nil ||
                    BoundStructLiteralExpression.CanWriteInitializerField(literal.StructType, initializer.Field)
            ) &&
                CanInitializeZeroValue(initializer.Value)
        )
    }

    /// Issue #3329: classifies a struct field's shape into the compact tag
    /// recorded by the `GSharp.MagicCollectionFields` cross-assembly
    /// metadata marker (see (cref:Symbols.ImportedAssemblySemantics)).
    /// A struct's own (cref:StructSymbol.InstanceFieldInitializers) —
    /// where this zero-value synthesis is normally recorded (see
    /// `DeclarationBinder.Structs.cs`) — is unavailable once the struct
    /// is referenced from ANOTHER assembly (or, for the REPL, a LATER
    /// submission): only the declaring compilation ever binds the struct's
    /// own declaration syntax. The marker plus
    /// (cref:TrySynthesizeEmptyInstanceFromMarker) let a struct
    /// literal reconstruct the same sound zero value from the field's own
    /// reflected CLR shape. Issue #3330 composition: a struct-typed field is
    /// tagged `"struct"` when — and only when — recursing into ITS
    /// fields (via the same same-assembly (cref:TrySynthesizeEmptyInstance)
    /// recursion #3330 added) actually finds a magic-collection zero value
    /// somewhere in its closure; a struct field with no such need is left
    /// unmarked, exactly like every other unaffected field.
    /// @param type The field's declared type.
    /// @returns The marker tag, or `null` when the type is not a magic-collection or recursively-magic
    /// struct shape.
    internal func ClassifyForMarker(type TypeSymbol) string? -> switch type {
        case _ is MapTypeSymbol: "map"
        case _ is SliceTypeSymbol: "slice"
        case arr is ArrayTypeSymbol: "arr" + arr.Length.ToString(CultureInfo.InvariantCulture)
        case array is RectangularArrayTypeSymbol: "rect" + array.Rank.ToString(CultureInfo.InvariantCulture)
        case _ is SequenceTypeSymbol: "seq"
        case StructSymbol{IsClass: false, IsInline: false} structField when TrySynthesizeEmptyInstance(
            nil,
            structField
        ) != nil: "struct"
        case importedField is ImportedTypeSymbol when importedField
            .Type
            .IsValueType &&
            TrySynthesizeEmptyInstance(nil, importedField) != nil: "struct"
        default: default(string?)
    }

    /// The inverse of (cref:ClassifyForMarker): reconstructs the
    /// magic-collection (cref:TypeSymbol) shape (or, for a nested
    /// struct field, the recursively-synthesized struct literal) named by
    /// [`markerKind`](paramref) from a reflected field's OWN CLR type —
    /// the marker tag alone disambiguates a slice from a same-CLR-shaped
    /// fixed-size array (both are plain CLR SZ arrays with no length
    /// encoded) and records the fixed length — then synthesizes its sound
    /// zero value (see (cref:TrySynthesizeEmptyInstance)).
    /// @param fieldInfo The reflected field the marker describes.
    /// @param markerKind The marker tag produced by (cref:ClassifyForMarker).
    /// @param fieldType The receiver-aware signature type, when available.
    /// @returns The synthesized empty-instance expression, or `null` when the field/tag cannot be
    /// reconstructed.
    internal func TrySynthesizeEmptyInstanceFromMarker(
        fieldInfo FieldInfo?,
        markerKind string?,
        fieldType TypeSymbol? = nil
    ) BoundExpression? -> TrySynthesizeEmptyInstanceFromMarker(fieldInfo, markerKind, out _, fieldType)

    internal func TrySynthesizeEmptyInstanceFromMarker(
        fieldInfo FieldInfo?,
        markerKind string?,
        out missingDeclarationShape bool,
        fieldType TypeSymbol? = nil
    ) BoundExpression? {
        missingDeclarationShape = true
        if fieldInfo == nil {
            return nil
        }
        let signatureType = fieldType ?? ClrNullability.GetFieldTypeSymbol(fieldInfo)
        if signatureType.ReferenceNullability == ReferenceNullabilityKind.Nullable ||
            NullableLifting.IsAnyValueTypeNullable(signatureType as NullableTypeSymbol) {
            missingDeclarationShape = false
            return nil
        }
        if string.IsNullOrEmpty(markerKind) {
            return nil
        }
        // Issue #3330 composition: a nested struct-typed field. Its own zero
        // value is reconstructed by recursing into ITS reflected CLR type —
        // NOT via ClassifyForMarker/this marker (that describes the OUTER
        // field only) — reusing the exact same cross-assembly reconstruction
        // this method performs for a leaf magic-collection field, one level
        // deeper. This mirrors #3330's same-assembly struct-in-struct
        // recursion, but walks reflected metadata instead of a bound
        // StructSymbol.
        if string.Equals(markerKind, "struct", StringComparison.Ordinal) {
            let zero = TrySynthesizeEmptyInstanceForImportedStruct(
                fieldType?.ClrType ?? fieldInfo.FieldType,
                out missingDeclarationShape,
                receiverType: fieldType,
                requiresDeclarationShape: true
            )
            return zero
        }
        var type TypeSymbol
        if string.Equals(markerKind, "map", StringComparison.Ordinal) {
            let args = fieldInfo.FieldType.GetGenericArguments()
            if args.Length != 2 {
                return nil
            }
            type = MapTypeSymbol.Get(ElementShape(fieldInfo, 0, fieldType), ElementShape(fieldInfo, 1, fieldType))
        } else if string.Equals(markerKind, "slice", StringComparison.Ordinal) {
            let elementClr Type? = fieldInfo.FieldType.GetElementType()
            if elementClr == nil || !fieldInfo.FieldType.IsSZArray {
                return nil
            }
            type = SliceTypeSymbol.Get(ElementShape(fieldInfo, 0, fieldType))
        } else if markerKind.StartsWith("arr", StringComparison.Ordinal) {
            let elementClr Type? = fieldInfo.FieldType.GetElementType()
            if elementClr == nil || !fieldInfo.FieldType.IsSZArray || !int32.TryParse(
                markerKind.AsSpan(3),
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out var length
            ) ||
                length < 0 {
                return nil
            }
            type = ArrayTypeSymbol.Get(ElementShape(fieldInfo, 0, fieldType), length)
        } else if markerKind.StartsWith("rect", StringComparison.Ordinal) {
            let elementClr Type? = fieldInfo.FieldType.GetElementType()
            if elementClr == nil || !fieldInfo.FieldType.IsArray || !int32.TryParse(
                markerKind.AsSpan(4),
                NumberStyles.Integer,
                CultureInfo.InvariantCulture,
                out var rank
            ) ||
                rank < 2 ||
                fieldInfo
                .FieldType
                .GetArrayRank() != rank {
                return nil
            }
            type = RectangularArrayTypeSymbol.Get(ElementShape(fieldInfo, 0, fieldType), rank)
        } else if string.Equals(markerKind, "seq", StringComparison.Ordinal) {
            let args = fieldInfo.FieldType.GetGenericArguments()
            if args.Length != 1 {
                return nil
            }
            type = SequenceTypeSymbol.Get(ElementShape(fieldInfo, 0, fieldType))
        } else {
            return nil
        }
        let zero = TrySynthesizeEmptyInstance(nil, type, out missingDeclarationShape)
        missingDeclarationShape = missingDeclarationShape || zero == nil
        return zero
    }

    /// Issue #3329/#3330 composition: reconstructs a
    /// (cref:BoundStructLiteralExpression) for a NESTED struct-typed
    /// field's own zero value, purely from its reflected CLR
    /// [`clrType`](paramref) and its OWN
    /// `GSharp.MagicCollectionFields` marker (every gsc-compiled struct
    /// with a field needing synthesis carries its own independent marker
    /// entry — see `AssemblyAttributeEmitter.EmitGSharpMagicCollectionFieldMarkers`,
    /// which iterates every struct in the compilation, not just top-level
    /// ones). This does not require (and does not build) a full imported
    /// `StructSymbol` aggregate for [`clrType`](paramref) — a
    /// synthetic minimal one is enough to carry the emitted field
    /// initializers, mirroring exactly what a same-assembly recursive
    /// (cref:TrySynthesizeStructFieldDefaults) call would have built
    /// had the struct been declared in this compilation.
    /// @param clrType The nested struct field's own reflected CLR type.
    /// @returns The synthesized nested struct literal, or `null` when it carries no marker or no field of
    /// it can be reconstructed.
    private func TrySynthesizeEmptyInstanceForImportedStruct(
        clrType Type?,
        out missingDeclarationShape bool,
        syntax SyntaxNode? = nil,
        receiverType TypeSymbol? = nil,
        requiresDeclarationShape bool = false
    ) BoundExpression? {
        missingDeclarationShape = false
        if clrType == nil || !clrType.IsValueType || !ImportedAssemblySemantics.TryGetMagicCollectionFields(
            clrType,
            out var magicFieldKinds
        ) {
            missingDeclarationShape = requiresDeclarationShape
            return nil
        }
        let ownerType TypeSymbol? = if receiverType != nil {
            MemberLookup.GetProjectionReceiverImportedType(receiverType) ?? receiverType.StripToBareShape()
        } else {
            nil
        }
        let bindingFlags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
        let fieldBuilder = ImmutableArray.CreateBuilder[FieldSymbol]()
        let reflectedFields = Dictionary[string, FieldInfo](StringComparer.Ordinal)
        for field in ClrTypeUtilities.SafeGetFields(clrType, bindingFlags) {
            if field.IsStatic || field.IsSpecialName {
                continue
            }
            fieldBuilder.Add(
                FieldSymbol(
                    field.Name,
                    if ownerType != nil {
                        MemberLookup.GetClrFieldTypeSymbol(ownerType, field)
                    } else {
                        ClrNullability.GetFieldTypeSymbol(field)
                    },
                    if field.IsPublic {
                        Accessibility.Public
                    } else {
                        Accessibility.Private
                    },
                    isReadOnly: field.IsInitOnly
                )
            )
            reflectedFields[field.Name] = field
        }
        if requiresDeclarationShape && magicFieldKinds!!.Keys.Any((name string) -> !reflectedFields.ContainsKey(name)) {
            missingDeclarationShape = true
            return nil
        }
        let nestedStruct = StructSymbol(
            name: clrType.Name,
            fields: fieldBuilder.ToImmutable(),
            accessibility: Accessibility.Public,
            declaration: nil,
            packageName: clrType.Namespace ?? string.Empty,
            isData: false,
            isInline: false,
            isClass: false,
            primaryConstructorParameters: ImmutableArray[ParameterSymbol].Empty,
            isOpen: false,
            baseClass: nil,
            clrType: clrType
        )
        var inits ImmutableArray[BoundFieldInitializer].Builder? = nil
        for fieldSymbol in nestedStruct.Fields {
            if !magicFieldKinds!!.TryGetValue(fieldSymbol.Name, out var kind) || !reflectedFields.TryGetValue(
                fieldSymbol.Name,
                out var reflectedField
            ) {
                continue
            }
            let zeroValue BoundExpression? = TrySynthesizeEmptyInstanceFromMarker(
                reflectedField,
                kind,
                out missingDeclarationShape,
                fieldSymbol.Type
            )
            if missingDeclarationShape {
                return nil
            }
            if zeroValue == nil {
                continue
            }
            inits ??= ImmutableArray.CreateBuilder[BoundFieldInitializer]()
            inits!!.Add(BoundFieldInitializer(fieldSymbol, zeroValue))
        }
        if inits == nil {
            return nil
        }
        return BoundStructLiteralExpression(
            syntax,
            nestedStruct,
            inits.ToImmutable(),
            copySource: nil,
            isZeroInitialization: true,
            resultType: ownerType
        )
    }

    private func TrySynthesizeEmptyInstanceCore(
        syntax SyntaxNode?,
        type TypeSymbol,
        visiting HashSet[StructSymbol]?,
        needsZeroCache Dictionary[TypeSymbol, bool],
        out missingDeclarationShape bool
    ) BoundExpression? {
        let result BoundExpression? = TrySynthesizeEmptyInstanceCoreUncached(
            syntax,
            type,
            visiting,
            needsZeroCache,
            out missingDeclarationShape
        )
        needsZeroCache[type] = result != nil
        return result
    }

    private func TrySynthesizeEmptyInstanceCoreUncached(
        syntax SyntaxNode?,
        type TypeSymbol,
        visiting HashSet[StructSymbol]?,
        needsZeroCache Dictionary[TypeSymbol, bool],
        out missingDeclarationShape bool
    ) BoundExpression? {
        missingDeclarationShape = false
        switch type {
            case mapType is MapTypeSymbol {
                // `map[K, V]{}` — symbolic Dictionary`2 ctor for open K/V.
                return BoundMapLiteralExpression(syntax, mapType, ImmutableArray[BoundMapEntry].Empty)
            }
            case sliceType is SliceTypeSymbol {
                // `[]T{}` — `ldc.i4.0; newarr T` with the symbolic element token.
                return BoundArrayCreationExpression(syntax, sliceType, ImmutableArray[BoundExpression].Empty)
            }
            case arrayType is ArrayTypeSymbol {
                // `[N]T`'s zero value is N zeroed elements (`newarr` self-
                // zero-inits), via the runtime-length allocation form. The
                // ELEMENTS stay CLR defaults — ADR-0159's element-default
                // honesty clause (the C# NRT array hole).
                return BoundArrayCreationExpression(
                    syntax,
                    arrayType,
                    BoundLiteralExpression(syntax, arrayType.Length, TypeSymbol.Int32)
                )
            }
            case rectangularType is RectangularArrayTypeSymbol {
                let dimensions = ImmutableArray.CreateBuilder[BoundExpression](rectangularType.Rank)
                for var i = 0; i < rectangularType.Rank; i++ {
                    dimensions.Add(BoundLiteralExpression(syntax, 0, TypeSymbol.Int32))
                }
                return BoundArrayCreationExpression.CreateRectangular(
                    syntax,
                    rectangularType,
                    dimensions.MoveToImmutable()
                )
            }
            case sequenceType is SequenceTypeSymbol {
                // The empty sequence is an empty T[] held as IEnumerable<T> —
                // a no-op reference conversion at the IL level (array-to-
                // interface), recognized symbolically for open element types
                // by the matching #3310 arms in Conversion.ClassifyCore and
                // MethodBodyEmitter.IsReferenceCompatible.
                return BoundConversionExpression(
                    syntax,
                    sequenceType,
                    BoundArrayCreationExpression(
                        syntax,
                        SliceTypeSymbol.Get(sequenceType.ElementType),
                        ImmutableArray[BoundExpression].Empty
                    )
                )
            }
            case structType is StructSymbol when !structType.IsClass && !structType.IsInline {
                if structType.ClrType is {} imported {
                    return TrySynthesizeEmptyInstanceForImportedStruct(
                        imported,
                        out missingDeclarationShape,
                        syntax,
                        structType
                    )
                }
                return TrySynthesizeStructFieldDefaults(
                    syntax,
                    structType,
                    visiting,
                    needsZeroCache,
                    out missingDeclarationShape
                )
            }
            case importedType is ImportedTypeSymbol when importedType.Type.IsValueType {
                return TrySynthesizeEmptyInstanceForImportedStruct(
                    importedType.Type,
                    out missingDeclarationShape,
                    syntax,
                    importedType
                )
            }
            default {
                return nil
            }
        }
    }

    /// Issue #3319: builds a (cref:BoundStructLiteralExpression) whose
    /// initializers cover exactly the fields (at any nesting depth of
    /// further value-type struct composition) that need a sound
    /// magic-collection zero value, or returns `null` when
    /// no field in the struct's closure needs one — preserving byte-identical
    /// emission (no ctor synthesis, no literal at all) for every struct
    /// unaffected by ADR-0159. A `visiting` guard prevents unbounded
    /// recursion for a self-referential struct shape (nothing else in the
    /// compiler currently rejects that as a layout cycle).
    private func TrySynthesizeStructFieldDefaults(
        syntax SyntaxNode?,
        structType StructSymbol,
        visiting HashSet[StructSymbol]?,
        needsZeroCache Dictionary[TypeSymbol, bool],
        out missingDeclarationShape bool
    ) BoundExpression? {
        missingDeclarationShape = false
        var visiting = visiting
        // Key the cycle guard by the generic DEFINITION so a self-referential
        // shape is caught regardless of which closed instantiation is being
        // walked (an open struct can only cycle back to its own definition).
        let visitKey = structType.Definition ?? structType
        visiting ??= HashSet[StructSymbol]()
        if !visiting!!.Add(visitKey) {
            return nil
        }
        try {
            var inits ImmutableArray[BoundFieldInitializer].Builder? = nil
            var needsZeroValue = false
            var hasNonPublicZeroValueField = false
            for field in structType.Fields {
                let fieldZeroValue BoundExpression? = TrySynthesizeEmptyInstanceCore(
                    syntax,
                    field.Type,
                    visiting,
                    needsZeroCache,
                    out missingDeclarationShape
                )
                if missingDeclarationShape {
                    return nil
                }
                if fieldZeroValue == nil {
                    continue
                }
                needsZeroValue = true
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
                if field.Accessibility != Accessibility.Public {
                    hasNonPublicZeroValueField = true
                    continue
                }
                inits ??= ImmutableArray.CreateBuilder[BoundFieldInitializer]()
                inits!!.Add(BoundFieldInitializer(field, fieldZeroValue))
            }
            if !needsZeroValue {
                return nil
            }
            var initializers = inits?.ToImmutable() ?? ImmutableArray[BoundFieldInitializer].Empty
            if hasNonPublicZeroValueField && !initializers.IsEmpty {
                let retained = ImmutableArray.CreateBuilder[BoundFieldInitializer]()
                for initializer in initializers {
                    let field = Invariant.Required(
                        initializer.Field,
                        "synthesized struct zero entries target fields",
                        expression: "initializer.Field"
                    )
                    let initializedInType = if visitKey.ValueStructDefaultCtorIsZeroInitialization {
                        structType.GetDefinitionField(field) is {} definitionField &&
                            (
                            object.ReferenceEquals(definitionField.Type, field.Type) ||
                                (
                                if needsZeroCache.TryGetValue(definitionField.Type, out var needsZero) {
                                    needsZero
                                } else {
                                    TrySynthesizeEmptyInstanceCore(
                                        syntax,
                                        definitionField.Type,
                                        visiting,
                                        needsZeroCache,
                                        out _
                                    ) != nil
                                }
                            )
                        )
                    } else {
                        structType.GetDefinitionField(field) is {} declaredField &&
                            visitKey
                            .InstanceFieldInitializers
                            .ContainsKey(declaredField)
                    }
                    if !initializedInType {
                        retained.Add(initializer)
                    }
                }
                // A private sibling does not erase public closed-generic values
                // whose definition's constructor has no corresponding store.
                initializers = retained.ToImmutable()
            }
            return BoundStructLiteralExpression(
                syntax,
                structType,
                initializers,
                copySource: nil,
                isZeroInitialization: true
            )
        } finally {
            visiting!!.Remove(visitKey)
        }
    }

    /// Reads a collection element through canonical signature queries.
    /// Sound-zero construction uses the substituted element's bare shape.
    private func ElementShape(field FieldInfo, index int32, fieldType TypeSymbol? = nil) TypeSymbol {
        let positions = (fieldType ?? ClrNullability.GetFieldTypeSymbol(field)).GetElementPositions()
        return if uint32(index) < uint32(positions.Length) {
            positions[index].StripToBareShape()
        } else {
            TypeSymbol.Error
        }
    }
}
