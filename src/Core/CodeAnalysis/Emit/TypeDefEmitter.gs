// <copyright file="TypeDefEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Runtime.InteropServices

/// IL/metadata emission for the TypeDef and constructor surface of every
/// user-defined aggregate type (struct, class, interface, enum, delegate)
/// plus the assembly-level synthesized default constructor.
/// @remarks PR-E-8 introduces this component. Per the decomposition plan, every
/// method moved here was a top-level `private` on
/// (cref:ReflectionMetadataEmitter). The methods moved are
/// (organized by category):
///
/// <b>TypeDef shape emission:</b>
///
/// - `EmitStructTypeDef` — struct/class TypeDef plus instance/static field rows
/// - `EmitNestedStructTypeDef` — nested-private TypeDef for closure / state-machine types
/// - `EmitEnumTypeDef` — enum TypeDef plus `value__` and literal-field rows
/// - `EmitInterfaceTypeDef` — interface TypeDef
/// - `EmitDelegateTypeDef` — named delegate TypeDef plus `.ctor`/`Invoke` MethodDefs
/// - `EmitAbstractMethod` — abstract MethodDef for an interface member
///
/// <b>Constructor emission:</b>
///
/// - `EmitClassDefaultConstructor` — parameter-less `.ctor` chaining to the base ctor
/// - `EmitStaticConstructor` — `.cctor` running static-field initializers
/// - `EmitClassPrimaryConstructor` — Kotlin-style primary ctor
/// - `EmitClassConstructorWithBaseInitializer` — forwarding ctor with explicit `: Base(args)`
/// - `EmitClassConstructorWithBody` — explicit `init` ctor with user body and optional base init
/// - `EmitDefaultConstructor` — assembly-level synthesized default ctor for closure classes etc.
///
/// Plus the small helpers used exclusively by the methods above:
/// `GetBaseCtorToken`, `GetBaseInitializerCtorToken`,
/// `GetImportedBaseDefaultCtorReference`,
/// `EmitIsReadOnlyAttribute`, `EmitIsByRefLikeAttribute`. The
/// accessibility-map helpers (`MapTypeAccessibility` /
/// `MapFieldAccessibility` / etc.) live in
/// (cref:AccessibilityMap) as of PR-E-12 — both this component and
/// the root call into that single canonical home.
///
/// Like every other PR-E-* component, (cref:TypeDefEmitter) is
/// `internal sealed` and constructor-injected. It receives the same
/// (cref:EmitContext), (cref:MetadataTokenCache), and
/// (cref:WellKnownReferences) as its peers plus delegate callbacks
/// for the remaining (cref:ReflectionMetadataEmitter) helpers it
/// depends on (`EncodeTypeSymbol`, `EncodeReturnSymbol`,
/// `GetTypeReference`, `NextParameterHandle`,
/// `EmitUserAttributes`, `EmitIsReadOnlyAttributeOnParameter`,
/// `GetCtorReference`). For the three constructor methods that
/// internally drive the still-private `BodyEmitter` nested class
/// (`EmitStaticConstructor`, `EmitClassConstructorWithBaseInitializer`,
/// `EmitClassConstructorWithBody`), the body-emission step is
/// reached via injected (cref:Func{TResult}) callbacks that return
/// the IL body offset. Those helpers stay on the root so they remain
/// adjacent to `BodyEmitter` until PR-E-11 promotes the whole
/// nested class to its own file.
///
/// What stays on (cref:ReflectionMetadataEmitter): the synthesized
/// inline-struct constructor (already moved to
/// (cref:DataStructSynthesizer) in PR-E-6), the
/// `EmitBaseConstructorArguments` helper which is
/// `BodyEmitter`-internal (moves with `BodyEmitter` in PR-E-11),
/// and the root's orchestrator `Emit`/`EmitCore` entry points
/// (thinned in PR-E-12).
internal class TypeDefEmitter {
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let wellKnown WellKnownReferences
    private let encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void
    private let encodeReturnSymbol(ReturnTypeEncoder, TypeSymbol, RefKind) -> void
    private let getTypeReference(Type) -> TypeReferenceHandle
    private let getImportedTypeHandle(Type) -> EntityHandle
    private let getUserStructTypeSpec(StructSymbol) -> EntityHandle
    private let resolveConstructedBaseCtorToken(StructSymbol) -> EntityHandle
    private let resolveConstructedBaseExplicitCtorToken(StructSymbol, ConstructorSymbol?) -> EntityHandle
    private let nextParameterHandle() -> ParameterHandle
    private let emitUserAttributes(EntityHandle, Symbol, AttributeTargetKind) -> void
    private let emitNullableContextOnType(TypeDefinitionHandle) -> void
    private let emitNullableAttributeOnField(FieldDefinitionHandle, TypeSymbol) -> void
    private let emitMethodNullability(
        MethodDefinitionHandle,
        MethodNullabilityPlan,
        ParameterHandle?,
        ImmutableArray[ParameterHandle]
    ) -> void
    private let emitTupleElementNamesOnParameter(ParameterHandle, TypeSymbol) -> void
    private let emitIsReadOnlyAttributeOnParameter(ParameterHandle) -> void
    private let emitParamArrayAttributeOnParameter(ParameterHandle) -> void
    private let emitParamCollectionAttributeOnParameter(ParameterHandle) -> void
    private let getCtorReference(ConstructorInfo) -> MemberReferenceHandle
    private let getCtorReferenceForType(ConstructorInfo, TypeSymbol?) -> MemberReferenceHandle
    private let emitStaticConstructorBodyBytes(StructSymbol) -> int32
    private let emitClassDefaultConstructorBodyBytes(StructSymbol, EntityHandle) -> int32
    private let emitValueStructDefaultConstructorBodyBytes(StructSymbol) -> int32
    private let emitClassPrimaryConstructorBodyBytes(StructSymbol, EntityHandle) -> int32
    private let emitClassConstructorWithBaseInitializerBodyBytes(
        StructSymbol,
        ImmutableArray[ParameterSymbol],
        BaseConstructorInitializer,
        EntityHandle
    ) -> int32
    private let emitClassConstructorWithBodyBodyBytes(
        StructSymbol,
        ConstructorSymbol,
        BaseConstructorInitializer?,
        EntityHandle
    ) -> int32
    private let emitClassDeinitializerBodyBytes(StructSymbol, DeinitSymbol, BoundBlockStatement, EntityHandle) -> int32

    init(
        emitCtx EmitContext,
        cache MetadataTokenCache,
        wellKnown WellKnownReferences,
        encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void,
        encodeReturnSymbol(ReturnTypeEncoder, TypeSymbol, RefKind) -> void,
        getTypeReference(Type) -> TypeReferenceHandle,
        getImportedTypeHandle(Type) -> EntityHandle,
        getUserStructTypeSpec(StructSymbol) -> EntityHandle,
        resolveConstructedBaseCtorToken(StructSymbol) -> EntityHandle,
        resolveConstructedBaseExplicitCtorToken(StructSymbol, ConstructorSymbol?) -> EntityHandle,
        nextParameterHandle() -> ParameterHandle,
        emitUserAttributes(EntityHandle, Symbol, AttributeTargetKind) -> void,
        emitNullableContextOnType(TypeDefinitionHandle) -> void,
        emitNullableAttributeOnField(FieldDefinitionHandle, TypeSymbol) -> void,
        emitMethodNullability(
            MethodDefinitionHandle,
            MethodNullabilityPlan,
            ParameterHandle?,
            ImmutableArray[ParameterHandle]
        ) -> void,
        emitTupleElementNamesOnParameter(ParameterHandle, TypeSymbol) -> void,
        emitIsReadOnlyAttributeOnParameter(ParameterHandle) -> void,
        emitParamArrayAttributeOnParameter(ParameterHandle) -> void,
        emitParamCollectionAttributeOnParameter(ParameterHandle) -> void,
        getCtorReference(ConstructorInfo) -> MemberReferenceHandle,
        getCtorReferenceForType(ConstructorInfo, TypeSymbol?) -> MemberReferenceHandle,
        emitStaticConstructorBodyBytes(StructSymbol) -> int32,
        emitClassDefaultConstructorBodyBytes(StructSymbol, EntityHandle) -> int32,
        emitValueStructDefaultConstructorBodyBytes(StructSymbol) -> int32,
        emitClassPrimaryConstructorBodyBytes(StructSymbol, EntityHandle) -> int32,
        emitClassConstructorWithBaseInitializerBodyBytes(
            StructSymbol,
            ImmutableArray[ParameterSymbol],
            BaseConstructorInitializer,
            EntityHandle
        ) -> int32,
        emitClassConstructorWithBodyBodyBytes(
            StructSymbol,
            ConstructorSymbol,
            BaseConstructorInitializer?,
            EntityHandle
        ) -> int32,
        emitClassDeinitializerBodyBytes(StructSymbol, DeinitSymbol, BoundBlockStatement, EntityHandle) -> int32
    ) {
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.cache = cache ?? throw ArgumentNullException("cache")
        this.wellKnown = wellKnown ?? throw ArgumentNullException("wellKnown")
        this.encodeTypeSymbol = encodeTypeSymbol ?? throw ArgumentNullException("encodeTypeSymbol")
        this.encodeReturnSymbol = encodeReturnSymbol ?? throw ArgumentNullException("encodeReturnSymbol")
        this.getTypeReference = getTypeReference ?? throw ArgumentNullException("getTypeReference")
        this.getImportedTypeHandle = getImportedTypeHandle ?? throw ArgumentNullException("getImportedTypeHandle")
        this.getUserStructTypeSpec = getUserStructTypeSpec ?? throw ArgumentNullException("getUserStructTypeSpec")
        this.resolveConstructedBaseCtorToken = resolveConstructedBaseCtorToken ??
            throw ArgumentNullException("resolveConstructedBaseCtorToken")
        this.resolveConstructedBaseExplicitCtorToken = resolveConstructedBaseExplicitCtorToken ??
            throw ArgumentNullException("resolveConstructedBaseExplicitCtorToken")
        this.nextParameterHandle = nextParameterHandle ?? throw ArgumentNullException("nextParameterHandle")
        this.emitUserAttributes = emitUserAttributes ?? throw ArgumentNullException("emitUserAttributes")
        this.emitNullableContextOnType = emitNullableContextOnType ??
            throw ArgumentNullException("emitNullableContextOnType")
        this.emitNullableAttributeOnField = emitNullableAttributeOnField ??
            throw ArgumentNullException("emitNullableAttributeOnField")
        this.emitMethodNullability = emitMethodNullability ?? throw ArgumentNullException("emitMethodNullability")
        this.emitTupleElementNamesOnParameter = emitTupleElementNamesOnParameter ??
            throw ArgumentNullException("emitTupleElementNamesOnParameter")
        this.emitIsReadOnlyAttributeOnParameter = emitIsReadOnlyAttributeOnParameter ??
            throw ArgumentNullException("emitIsReadOnlyAttributeOnParameter")
        this.emitParamArrayAttributeOnParameter = emitParamArrayAttributeOnParameter ??
            throw ArgumentNullException("emitParamArrayAttributeOnParameter")
        this.emitParamCollectionAttributeOnParameter = emitParamCollectionAttributeOnParameter ??
            throw ArgumentNullException("emitParamCollectionAttributeOnParameter")
        this.getCtorReference = getCtorReference ?? throw ArgumentNullException("getCtorReference")
        this.getCtorReferenceForType = getCtorReferenceForType ?? throw ArgumentNullException("getCtorReferenceForType")
        this.emitStaticConstructorBodyBytes = emitStaticConstructorBodyBytes ??
            throw ArgumentNullException("emitStaticConstructorBodyBytes")
        this.emitClassDefaultConstructorBodyBytes = emitClassDefaultConstructorBodyBytes ??
            throw ArgumentNullException("emitClassDefaultConstructorBodyBytes")
        this.emitValueStructDefaultConstructorBodyBytes = emitValueStructDefaultConstructorBodyBytes ??
            throw ArgumentNullException("emitValueStructDefaultConstructorBodyBytes")
        this.emitClassPrimaryConstructorBodyBytes = emitClassPrimaryConstructorBodyBytes ??
            throw ArgumentNullException("emitClassPrimaryConstructorBodyBytes")
        this.emitClassConstructorWithBaseInitializerBodyBytes = emitClassConstructorWithBaseInitializerBodyBytes ??
            throw ArgumentNullException("emitClassConstructorWithBaseInitializerBodyBytes")
        this.emitClassConstructorWithBodyBodyBytes = emitClassConstructorWithBodyBodyBytes ??
            throw ArgumentNullException("emitClassConstructorWithBodyBodyBytes")
        this.emitClassDeinitializerBodyBytes = emitClassDeinitializerBodyBytes ??
            throw ArgumentNullException("emitClassDeinitializerBodyBytes")
    }

    // TypeDef shape emission
    /// Emits the TypeDef row for a user-declared struct or class and its
    /// instance/static field/event/property-backing FieldDefs. The struct/
    /// class distinction selects base type (`System.ValueType` vs
    /// `System.Object`) and the appropriate (cref:TypeAttributes)
    /// shape. Routes user annotations onto the TypeDef and each FieldDef.
    /// @param structSym The struct or class symbol to emit.
    /// @param firstFieldRow The pre-reserved first field row used as the TypeDef's `fieldList` when no
    /// fields are emitted.
    /// @param methodListRow The pre-reserved first method row used as the TypeDef's `methodList`.
    func EmitStructTypeDef(structSym StructSymbol, firstFieldRow int32, methodListRow int32) {
        ValidateStructTypeDefinition(structSym)
        var firstField = default(FieldDefinitionHandle)
        this.EmitStructInstanceFields(structSym, &firstField)
        this.EmitStructAutoPropertyBackingFields(structSym, &firstField)
        this.EmitStructEventBackingFields(structSym, &firstField)
        this.EmitStructStaticFields(structSym, &firstField)
        this.EmitStructConstFields(structSym, &firstField)
        this.EmitStructStaticPropertyBackingFields(structSym, &firstField)
        this.EmitStructStaticEventBackingFields(structSym, &firstField)
        EnsureStructFirstField(firstFieldRow, &firstField)
        let (typeAccessibility, structNamespace) = this.ResolveStructNamespaceAndAccessibility(structSym)
        let (resolvedTypeAttrs, baseType) = this.ResolveStructTypeShape(structSym, typeAccessibility)
        let typeAttrs = SuppressBeforeFieldInitForStruct(structSym, resolvedTypeAttrs)
        let handle2 = this.EmitStructTypeDefinition(
            structSym,
            typeAttrs,
            structNamespace,
            baseType,
            firstField,
            methodListRow
        )
        this.EmitStructClassLayout(handle2, structSym)
        this.EmitStructTypeAttributes(handle2, structSym)
    }

    private func EmitStructInstanceFields(structSym StructSymbol, ref firstField FieldDefinitionHandle) {
        // Emit field definitions in source order. Each field's signature is a
        // FieldSig encoding the GSharp type symbol.
        for field in structSym.Fields {
            let sigBlob = BlobBuilder()
            this.encodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), field.Type)
            var attrs = AccessibilityMap.MapFieldAccessibility(field.Accessibility)
            if field.IsReadOnly {
                attrs |= FieldAttributes.InitOnly
            }
            let handle = this
                .emitCtx
                .Metadata
                .AddFieldDefinition(
                attributes: attrs,
                name: this.emitCtx.Metadata.GetOrAddString(field.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
            if firstField.IsNil {
                firstField = handle
            }
            this.cache.StructFieldDefs[field] = handle
            // ADR-0093 §5: a field declared with @FieldOffset(N) inside an
            // explicit-layout type produces a `FieldLayout` row pointing at
            // the field's FieldDef. The @FieldOffset attribute itself is
            // pseudo-custom and is filtered out of the CustomAttribute pass
            // by KnownAttributes.IsPseudoCustomAttribute.
            if field.ExplicitOffset is int32 offset {
                this.emitCtx.Metadata.AddFieldLayout(handle, offset)
            }
            // Issue #186 / ADR-0047 §3: route any @-annotations bound onto
            // the field symbol onto the FieldDef row so attributes like
            // @Obsolete round-trip into CustomAttribute rows.
            this.emitUserAttributes(handle, field, AttributeTargetKind.Field)
            this.emitNullableAttributeOnField(handle, field.Type)
            // ADR-0122 §10 / issue #1035: a fixed-size buffer field carries a
            // `[FixedBuffer(typeof(T), N)]` attribute pointing at the element
            // type and count, mirroring C# / Roslyn's lowering.
            if field.IsFixedBuffer {
                this.EmitFixedBufferFieldAttribute(handle, field)
            }
        }
    }

    private func EmitStructAutoPropertyBackingFields(structSym StructSymbol, ref firstField FieldDefinitionHandle) {
        // ADR-0051 Phase 6: emit backing FieldDefs for auto-properties.
        for prop in structSym.Properties {
            if !prop.IsAutoProperty || prop.BackingField == nil {
                continue
            }
            // #573: when a field-backed synthesized property reuses an existing
            // user field (which was already emitted above), skip creating a
            // duplicate backing FieldDef — the mapping already exists.
            if this.cache.StructFieldDefs.ContainsKey(prop.BackingField!!) {
                continue
            }
            let sigBlob = BlobBuilder()
            this.encodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), prop.Type)
            var attributes = AccessibilityMap.MapFieldAccessibility(prop.BackingField!!.Accessibility)
            if prop.BackingField!!.IsReadOnly {
                attributes |= FieldAttributes.InitOnly
            }
            let backingHandle = this
                .emitCtx
                .Metadata
                .AddFieldDefinition(
                attributes,
                name: this.emitCtx.Metadata.GetOrAddString(prop.BackingField!!.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
            if firstField.IsNil {
                firstField = backingHandle
            }
            this.cache.StructFieldDefs[prop.BackingField!!] = backingHandle
            // Issue #4988: a backing field carries its property's nullability,
            // as csc's does.
            this.emitNullableAttributeOnField(backingHandle, prop.Type)
        }
    }

    private func EmitStructEventBackingFields(structSym StructSymbol, ref firstField FieldDefinitionHandle) {
        // ADR-0052: emit backing FieldDefs for field-like events.
        for ev in structSym.Events {
            if !ev.IsFieldLike || ev.BackingField == nil {
                continue
            }
            let sigBlob = BlobBuilder()
            this.encodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), ev.Type)
            // Issue #1221: emit the field-like event's backing delegate field as
            // `family` (protected) rather than `private`. C# keeps the backing
            // field private and forbids raising a base-class event from a derived
            // class, but G# semantics (and the Oahu corpus) require an inherited
            // event to be raisable from a derived type. A derived method raises
            // the event by reading this backing field on `this`, which a private
            // field would reject at runtime (FieldAccessException); `family`
            // grants the necessary derived-class (and cross-assembly subclass)
            // access while still hiding the field from unrelated types.
            let backingHandle = this
                .emitCtx
                .Metadata
                .AddFieldDefinition(
                attributes: FieldAttributes.Family,
                name: this.emitCtx.Metadata.GetOrAddString(ev.BackingField!!.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
            if firstField.IsNil {
                firstField = backingHandle
            }
            this.cache.StructFieldDefs[ev.BackingField!!] = backingHandle
            // Issue #4988: the `family` backing field is visible to a derived
            // type in another assembly, which reads the handler's nullability
            // from it.
            this.emitNullableAttributeOnField(backingHandle, ev.Type)
        }
    }

    private func EmitStructStaticFields(structSym StructSymbol, ref firstField FieldDefinitionHandle) {
        // ADR-0053: emit static field definitions from shared block.
        if !structSym.StaticFields.IsDefaultOrEmpty {
            for staticField in structSym.StaticFields {
                let sigBlob = BlobBuilder()
                this.encodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), staticField.Type)
                var attrs = AccessibilityMap.MapFieldAccessibility(staticField.Accessibility) | FieldAttributes.Static
                if staticField.IsReadOnly {
                    attrs |= FieldAttributes.InitOnly
                }
                let handle = this
                    .emitCtx
                    .Metadata
                    .AddFieldDefinition(
                    attributes: attrs,
                    name: this.emitCtx.Metadata.GetOrAddString(staticField.Name),
                    signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
                )
                if firstField.IsNil {
                    firstField = handle
                }
                this.cache.StructFieldDefs[staticField] = handle
                // Issue #4903: route `@`-annotations bound onto a `shared` field
                // onto its FieldDef. Without this `@ThreadStatic` was dropped and
                // the field became one process-wide slot.
                this.emitUserAttributes(handle, staticField, AttributeTargetKind.Field)
                this.emitNullableAttributeOnField(handle, staticField.Type)
            }
        }
    }

    private func EmitStructConstFields(structSym StructSymbol, ref firstField FieldDefinitionHandle) {
        // Issue #948 / #3519: ECMA constants use literal fields + Constant
        // rows. Decimal follows C#: static initonly storage,
        // DecimalConstantAttribute, and a .cctor assignment. Source reads inline.
        if !structSym.ConstFields.IsDefaultOrEmpty {
            for constField in structSym.ConstFields {
                let sigBlob = BlobBuilder()
                this.encodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), constField.Type)
                let attrs = AccessibilityMap.MapFieldAccessibility(
                    constField.Accessibility
                ) | FieldAttributes.Static | ConstantFieldMetadataEmitter.GetAttributes(constField.ConstantValue)
                let handle = this
                    .emitCtx
                    .Metadata
                    .AddFieldDefinition(
                    attributes: attrs,
                    name: this.emitCtx.Metadata.GetOrAddString(constField.Name),
                    signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
                )
                if firstField.IsNil {
                    firstField = handle
                }
                ConstantFieldMetadataEmitter.Emit(this.emitCtx, this.getTypeReference, handle, constField.ConstantValue)
                this.cache.StructFieldDefs[constField] = handle
                this.emitUserAttributes(handle, constField, AttributeTargetKind.Field)
                this.emitNullableAttributeOnField(handle, constField.Type)
            }
        }
    }

    private func EmitStructStaticPropertyBackingFields(structSym StructSymbol, ref firstField FieldDefinitionHandle) {
        // Issue #263: emit backing FieldDefs for static auto-properties.
        for prop in structSym.StaticProperties {
            if !prop.IsAutoProperty || prop.BackingField == nil {
                continue
            }
            let sigBlob = BlobBuilder()
            this.encodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), prop.Type)
            let backingHandle = this
                .emitCtx
                .Metadata
                .AddFieldDefinition(
                attributes: FieldAttributes.Assembly | FieldAttributes.Static,
                name: this.emitCtx.Metadata.GetOrAddString("<${prop.Name}>k__BackingField"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
            if firstField.IsNil {
                firstField = backingHandle
            }
            this.cache.StructFieldDefs[prop.BackingField!!] = backingHandle
            this.emitNullableAttributeOnField(backingHandle, prop.Type)
        }
    }

    private func EmitStructStaticEventBackingFields(structSym StructSymbol, ref firstField FieldDefinitionHandle) {
        // Issue #263: emit backing FieldDefs for static field-like events.
        for ev in structSym.StaticEvents {
            if !ev.IsFieldLike || ev.BackingField == nil {
                continue
            }
            let sigBlob = BlobBuilder()
            this.encodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), ev.Type)
            let backingHandle = this
                .emitCtx
                .Metadata
                .AddFieldDefinition(
                attributes: FieldAttributes.Private | FieldAttributes.Static,
                name: this.emitCtx.Metadata.GetOrAddString(ev.BackingField!!.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
            if firstField.IsNil {
                firstField = backingHandle
            }
            this.cache.StructFieldDefs[ev.BackingField!!] = backingHandle
            this.emitNullableAttributeOnField(backingHandle, ev.Type)
        }
    }

    private func ResolveStructNamespaceAndAccessibility(structSym StructSymbol)(
        Accessibility TypeAttributes,
        Namespace StringHandle
    ) {
        // Issue #910: a user type declared inside a class/struct body
        // (structSym.ContainingType != null) is emitted as a CLR nested
        // TypeDef. Nested types carry NestedPublic/NestedAssembly/NestedPrivate
        // visibility (never the top-level Public/NotPublic flags) and an empty
        // namespace; the enclosing TypeDef qualifies the name. A NestedClass
        // metadata row linking this TypeDef to its encloser is emitted later in
        // ReflectionMetadataEmitter once both handles exist.
        let isNestedType = structSym.ContainingType != nil
        let typeAccessibility = if isNestedType {
            AccessibilityMap.MapNestedTypeAccessibility(structSym.Accessibility)
        } else {
            AccessibilityMap.MapTypeAccessibility(structSym.Accessibility)
        }
        let structNamespace = if isNestedType {
            default(StringHandle)
        } else {
            this.emitCtx.Metadata.GetOrAddString(structSym.PackageName ?? string.Empty)
        }
        return (typeAccessibility, structNamespace)
    }

    private func ResolveStructTypeShape(structSym StructSymbol, typeAccessibility TypeAttributes)(
        Attributes TypeAttributes,
        BaseType EntityHandle
    ) {
        var typeAttrs TypeAttributes
        var baseType EntityHandle
        if structSym.IsClass {
            // Phase 3.B.3 sub-step 3: classes are CLR reference types.
            // Sealed by default per ADR-0017 (Kotlin-style `open` opt-in).
            // ADR-0078: `sealed class` denotes a CLOSED HIERARCHY (subclassing
            // allowed in-package, exhaustiveness checked at switch sites). It
            // must NOT carry the CLR `Sealed` flag, otherwise subclasses fail
            // to load with `TypeLoadException: parent type is sealed`.
            // Base is either the user-declared base class (if any) or
            // System.Object.
            var classAttrs = TypeAttributes.Class | ResolveClassLayoutFlag(
                structSym
            ) | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit | typeAccessibility
            if !structSym.IsOpen && !structSym.IsSealedHierarchy {
                classAttrs |= TypeAttributes.Sealed
            }
            // Issue #987: a class with an abstract method (own or inherited and
            // not overridden) is itself abstract — emit TypeAttributes.Abstract
            // so the runtime forbids `newobj` on it. Such a class is always
            // `open`, so it is never also Sealed. The one exception is ADR-0195's
            // `shared` class (IsAbstract, not open): CLR `abstract sealed`, which
            // is how a static class is spelled in metadata.
            if structSym.IsAbstract {
                classAttrs |= TypeAttributes.Abstract
            }
            // Issue #4234: a class hosting an `@ExtensionOwner`-routed
            // extension method (see DeclarationBinder.Functions.cs) stands in
            // for a migrated C# `static class` — ECMA-334 §13.6.9 requires an
            // extension method's container be non-generic, abstract, and
            // sealed for C#/F# callers (and gsc's own MemberLookup.IsStaticClass
            // import check) to recognise it as an extension host, exactly how
            // the package's `<Program>` is already always emitted. Force both
            // bits unconditionally: a real extension-method container can
            // never legally be open/subclassable in the first place.
            if HostsExtensionMethod(structSym) {
                classAttrs |= TypeAttributes.Sealed | TypeAttributes.Abstract
            }
            typeAttrs = classAttrs
            if structSym.IsAttributeClass {
                // Phase 4 of #141 / ADR-0047 §5: @Attribute sugar — base is
                // System.Attribute, regardless of any other resolution.
                baseType = this.wellKnown.GetSystemAttributeTypeRef()
            } else if structSym.BaseClass != nil && ReflectionMetadataEmitter.IsUserGenericTypeReference(
                structSym.BaseClass
            ) {
                // Issue #1055: the base is a CONSTRUCTED generic user class
                // (e.g. `Derived : Base[int32]`). Reference it via a TypeSpec
                // naming the generic instantiation so the runtime sees the
                // correct base subobject layout, vtable slots and type identity.
                // Issue #2337: also covers a nested sibling base that only
                // carries the enclosing generic's reified TypeParameters (no
                // own TypeArguments) — it must resolve to the base's
                // self-instantiation TypeSpec, not the bare open TypeDef.
                baseType = this.getUserStructTypeSpec(structSym.BaseClass!!)
            } else if structSym.BaseClass != nil &&
                this
                .cache
                .StructTypeDefs
                .TryGetValue(structSym.BaseClass!!, out var baseHandle) {
                baseType = baseHandle
            } else if structSym.ImportedBaseType?.ClrType != nil {
                // Issue #296: the class inherits from an imported CLR base
                // class; reference it as the TypeDef's base type so the emitted
                // metadata extends the imported base.
                baseType = this.GetImportedBaseTypeHandle(structSym.ImportedBaseType!!)
            } else {
                baseType = this.wellKnown.ObjectTypeRef
            }
        } else {
            typeAttrs = ResolveStructLayoutFlag(
                structSym
            ) | TypeAttributes.Sealed | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit | typeAccessibility
            baseType = this.wellKnown.ValueTypeRef
        }
        return (typeAttrs, baseType)
    }

    private func EmitStructTypeDefinition(
        structSym StructSymbol,
        typeAttrs TypeAttributes,
        structNamespace StringHandle,
        baseType EntityHandle,
        firstField FieldDefinitionHandle,
        methodListRow int32
    ) TypeDefinitionHandle {
        // ADR-0087 §3 R1: the suffix counts parameters declared by this type,
        // while nested TypeDefs still carry GenericParam rows copied from their
        // enclosing types. Synthesized types have no declaration, so all of
        // their TypeParameters are their own.
        let ownArity = if structSym.Declaration == nil {
            structSym.TypeParameters.Length
        } else {
            structSym.Declaration!!.TypeParameterList?.Parameters.Count ?? 0
        }
        let typeDefName = if ownArity == 0 {
            structSym.Name
        } else {
            structSym.Name + "`" + ownArity.ToString(CultureInfo.InvariantCulture)
        }
        let handle2 = this
            .emitCtx
            .Metadata
            .AddTypeDefinition(
            attributes: typeAttrs,
            namespace: structNamespace,
            name: this.emitCtx.Metadata.GetOrAddString(typeDefName),
            baseType: baseType,
            fieldList: firstField,
            methodList: MetadataTokens.MethodDefinitionHandle(methodListRow)
        )
        this.cache.StructTypeDefs[structSym] = handle2
        if structSym.IsNativeProtocolSupport || NativeProtocolSafety.ContainsSavedProtocol(structSym) {
            this.EmitNativeProtocolFeature(handle2)
        }
        EmitGenericParamRows(this.emitCtx, handle2, structSym.TypeParameters)
        if structSym.IsInline {
            this.EmitIsReadOnlyAttribute(handle2)
        }
        if structSym.IsRefStruct {
            // Issue #367: mark user-declared `ref struct` types as by-ref-like.
            this.EmitIsByRefLikeAttribute(handle2)
        }
        // ADR-0122 §10 / issue #1035: a fixed-size buffer backing struct is
        // compiler-generated and stamped with [CompilerGenerated] and
        // [UnsafeValueType], matching how C# / Roslyn lowers a fixed buffer.
        if structSym.IsFixedBufferBacking {
            this.EmitFixedBufferBackingAttributes(handle2)
        }
        return handle2
    }

    private func EmitStructClassLayout(handle2 TypeDefinitionHandle, structSym StructSymbol) {
        // ADR-0093 §5: when @StructLayout supplies Pack or Size, write the
        // matching ClassLayout row. A null/0 pack with a 0 size results in
        // no ClassLayout row at all — the runtime defaults apply.
        EmitClassLayout(this.emitCtx, handle2, structSym.LayoutMetadata)
    }

    private func EmitStructTypeAttributes(handle2 TypeDefinitionHandle, structSym StructSymbol) {
        // Phase 3 of #141: user annotations targeting the type land on this TypeDef.
        this.emitUserAttributes(handle2, structSym, AttributeTargetKind.Type)
        this.emitNullableContextOnType(handle2)
    }

    /// Emits a nested-private TypeDef for a state-machine type. Same as
    /// (cref:EmitStructTypeDef) but uses `NestedPrivate` visibility
    /// and an empty namespace (nested types have no namespace in metadata).
    /// @param structSym The nested struct symbol to emit.
    /// @param firstFieldRow The pre-reserved first field row used as the TypeDef's `fieldList` when no
    /// fields are emitted.
    /// @param methodListRow The pre-reserved first method row used as the TypeDef's `methodList`.
    func EmitNestedStructTypeDef(structSym StructSymbol, firstFieldRow int32, methodListRow int32) {
        if !structSym.TypeArguments.IsDefaultOrEmpty {
            throw NotSupportedException(
                "Internal error: a constructed StructSymbol ('${structSym.Name}') reached EmitNestedStructTypeDef."
            )
        }
        var firstField = default(FieldDefinitionHandle)
        for field in structSym.Fields {
            let sigBlob = BlobBuilder()
            this.encodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), field.Type)
            var attrs = AccessibilityMap.MapFieldAccessibility(field.Accessibility)
            if field.IsReadOnly {
                attrs |= FieldAttributes.InitOnly
            }
            let handle = this
                .emitCtx
                .Metadata
                .AddFieldDefinition(
                attributes: attrs,
                name: this.emitCtx.Metadata.GetOrAddString(field.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
            )
            if firstField.IsNil {
                firstField = handle
            }
            this.cache.StructFieldDefs[field] = handle
            // Issue #186: mirror the EmitStructTypeDef path for nested types
            // so user @-annotations on fields round-trip into CustomAttribute
            // rows on the nested FieldDef as well.
            this.emitUserAttributes(handle, field, AttributeTargetKind.Field)
        }
        if firstField.IsNil {
            firstField = MetadataTokens.FieldDefinitionHandle(firstFieldRow)
        }
        var typeAttrs TypeAttributes
        var baseType EntityHandle
        if structSym.IsClass {
            var classAttrs = TypeAttributes.Class | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit | TypeAttributes.NestedPrivate
            if !structSym.IsOpen && !structSym.IsSealedHierarchy {
                classAttrs |= TypeAttributes.Sealed
            }
            // Issue #987: a nested class with an abstract method is abstract too.
            if structSym.IsAbstract {
                classAttrs |= TypeAttributes.Abstract
            }
            typeAttrs = classAttrs
            if structSym.BaseClass != nil && ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym.BaseClass) {
                // Issue #1055: nested class extending a constructed generic base.
                // Issue #2337: also covers a nested sibling base carrying only
                // the enclosing generic's reified TypeParameters.
                baseType = this.getUserStructTypeSpec(structSym.BaseClass!!)
            } else if structSym.BaseClass != nil &&
                this
                .cache
                .StructTypeDefs
                .TryGetValue(structSym.BaseClass!!, out var baseHandle) {
                baseType = baseHandle
            } else if structSym.ImportedBaseType?.ClrType != nil {
                // Issue #296: nested class inheriting an imported CLR base.
                baseType = this.GetImportedBaseTypeHandle(structSym.ImportedBaseType!!)
            } else {
                baseType = this.wellKnown.ObjectTypeRef
            }
        } else {
            typeAttrs = TypeAttributes.SequentialLayout | TypeAttributes.Sealed | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit | TypeAttributes.NestedPrivate
            baseType = this.wellKnown.ValueTypeRef
        }
        // Nested types have no namespace in ECMA-335 metadata.
        // ADR-0140 / issue #2131: drop `beforefieldinit` on a nested type that
        // declares a `shared { init { … } }` static-initializer block.
        if structSym.HasStaticInitializerBlock {
            typeAttrs &= ~TypeAttributes.BeforeFieldInit
        }
        // Issue #810: when the state-machine class is generic over the
        // outer method's type parameters (mirroring how Roslyn emits
        // `<Empty>d__0<T>`), mangle the name with the backtick-arity
        // suffix per ECMA-335 II.10.3.1, then emit GenericParam rows
        // so reflection sees the real type-parameter slots.
        let nestedTypeDefName = MangleGenericName(structSym.Name, structSym.TypeParameters)
        let handle2 = this
            .emitCtx
            .Metadata
            .AddTypeDefinition(
            attributes: typeAttrs,
            namespace: default(StringHandle),
            name: this.emitCtx.Metadata.GetOrAddString(nestedTypeDefName),
            baseType: baseType,
            fieldList: firstField,
            methodList: MetadataTokens.MethodDefinitionHandle(methodListRow)
        )
        this.cache.StructTypeDefs[structSym] = handle2
        EmitGenericParamRows(this.emitCtx, handle2, structSym.TypeParameters)
        if structSym.IsRefStruct {
            // Issue #367: nested user-declared `ref struct` types are by-ref-like too.
            this.EmitIsByRefLikeAttribute(handle2)
        }
    }

    /// Issue #193: emits a CLR `enum` TypeDef for a user-defined GSharp
    /// `enum Name { ... }`. The TypeDef is a sealed value type
    /// deriving from `System.Enum` with:
    /// * an instance field `value__` of `int32` (the underlying
    /// type per ADR-0047 §3; widen later if we add explicit underlying
    /// -type syntax),
    /// * one `public static literal` field per (cref:EnumMemberSymbol)
    /// carrying its integer constant via a `HasDefault` / Constant row.
    /// Custom attributes bound onto `EnumSymbol.Attributes` route
    /// to the type-def row; per-member attributes route to each literal field.
    /// @param enumSym The enum symbol to emit.
    /// @param firstFieldRow The pre-reserved first field row (unused — the enum captures its own row via
    /// (cref:MetadataBuilder.GetRowCount)).
    /// @param methodListRow The pre-reserved first method row used as the TypeDef's `methodList`.
    func EmitEnumTypeDef(enumSym EnumSymbol, firstFieldRow int32, methodListRow int32) {
        let enumTypeRef = this.getTypeReference(this.emitCtx.CoreEnumType)
        // P3-8 (#420): emit the TypeDef row *before* its FieldDef rows so the
        // literal-field signatures can refer to the enum's actual TypeDef
        // handle returned by AddTypeDefinition, rather than a speculative
        // row-count+1 value that breaks silently if the emit order ever
        // changes. The TypeDef's fieldList must still point at the first
        // FieldDef row that will belong to this enum, which is the next row
        // about to be added — we capture it via GetRowCount + 1 here and
        // assert below that the first AddFieldDefinition call matches.
        let firstFieldHandle = MetadataTokens.FieldDefinitionHandle(
            this.emitCtx.Metadata.GetRowCount(TableIndex.Field) + 1
        )
        // Issue #910: a nested enum (declared inside a class/struct body) is
        // emitted with nested visibility and an empty namespace.
        let enumNested = enumSym.ContainingType != nil
        let enumNamespace = if enumNested {
            default(StringHandle)
        } else {
            this.emitCtx.Metadata.GetOrAddString(enumSym.PackageName ?? string.Empty)
        }
        let typeAttrs = TypeAttributes.Class | TypeAttributes.Sealed | TypeAttributes.AnsiClass | TypeAttributes.AutoLayout | (
            if enumNested {
                AccessibilityMap.MapNestedTypeAccessibility(enumSym.Accessibility)
            } else {
                AccessibilityMap.MapTypeAccessibility(enumSym.Accessibility)
            }
        )
        let enumTypeDef = this
            .emitCtx
            .Metadata
            .AddTypeDefinition(
            attributes: typeAttrs,
            namespace: enumNamespace,
            name: this.emitCtx.Metadata.GetOrAddString(enumSym.Name),
            baseType: enumTypeRef,
            fieldList: firstFieldHandle,
            methodList: MetadataTokens.MethodDefinitionHandle(methodListRow)
        )
        this.cache.EnumTypeDefs[enumSym] = enumTypeDef
        EmitGenericParamRows(this.emitCtx, enumTypeDef, enumSym.TypeParameters)
        // Field 1: instance int32 'value__' with SpecialName | RTSpecialName.
        let valueFieldSigBlob = BlobBuilder()
        BlobEncoder(valueFieldSigBlob).FieldSignature().Int32()
        let valueFieldHandle = this
            .emitCtx
            .Metadata
            .AddFieldDefinition(
            attributes: FieldAttributes.Public | FieldAttributes.SpecialName | FieldAttributes.RTSpecialName,
            name: this.emitCtx.Metadata.GetOrAddString("value__"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(valueFieldSigBlob)
        )
        if valueFieldHandle != firstFieldHandle {
            throw InvalidOperationException(
                "Enum '${enumSym.Name}' value__ FieldDef row ${MetadataTokens.GetRowNumber(valueFieldHandle)} did not match the fieldList row ${MetadataTokens.GetRowNumber(firstFieldHandle)} stamped on its TypeDef. This indicates another emitter inserted FieldDef rows between TypeDef creation and field emission."
            )
        }
        // Fields 2..N: one public static literal field per member, signature
        // is the enum's own typedef (the standard CLR convention for enum
        // literals). The Constant row is added below after all field rows
        // have been emitted so they remain in increasing parent-token order.
        var memberType TypeSymbol = enumSym
        if !enumSym.TypeParameters.IsDefaultOrEmpty {
            let typeArguments = ImmutableArray.CreateBuilder[TypeSymbol](enumSym.TypeParameters.Length)
            for parameter in enumSym.TypeParameters {
                typeArguments.Add(parameter)
            }
            memberType = Invariant.Required(
                EnumSymbol.ConstructNested(enumSym, typeArguments.MoveToImmutable()),
                "a nested generic enum can be constructed over its own type parameters",
                expression: "EnumSymbol.ConstructNested(enumSym, typeArguments.MoveToImmutable())"
            )
        }
        let memberFieldHandles = List[FieldDefinitionHandle](enumSym.Members.Length)
        for member in enumSym.Members {
            let memberSigBlob = BlobBuilder()
            this.encodeTypeSymbol(BlobEncoder(memberSigBlob).FieldSignature(), memberType)
            let memberFieldHandle = this
                .emitCtx
                .Metadata
                .AddFieldDefinition(
                attributes: FieldAttributes.Public | FieldAttributes.Static | FieldAttributes.Literal | FieldAttributes.HasDefault,
                name: this.emitCtx.Metadata.GetOrAddString(member.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(memberSigBlob)
            )
            memberFieldHandles.Add(memberFieldHandle)
            this.cache.EnumMemberFieldDefs[member] = memberFieldHandle
        }
        // Constant rows must be added in increasing parent FieldDefinition
        // order; iterating the literal fields in declaration order naturally
        // satisfies this since AddFieldDefinition is monotone.
        for var i = 0; i < enumSym.Members.Length; i++ {
            this.emitCtx.Metadata.AddConstant(parent: memberFieldHandles[i], value: enumSym.Members[i].Value)
        }
        // Issue #188 (step 3): route any user annotations attached to the
        // enum type onto the TypeDef row, and per-member annotations onto
        // each literal-field row.
        this.emitUserAttributes(enumTypeDef, enumSym, AttributeTargetKind.Type)
        this.emitNullableContextOnType(enumTypeDef)
        for var i = 0; i < enumSym.Members.Length; i++ {
            this.emitUserAttributes(memberFieldHandles[i], enumSym.Members[i], AttributeTargetKind.Field)
        }
    }

    /// Phase 3.B.4: emits the TypeDef row for a user-declared interface.
    /// @param ifaceSym The interface symbol.
    /// @param firstMethodRow The preassigned first method row.
    /// @param firstFieldRow The first field row for the next aggregate (interfaces own no fields, so this
    /// is forwarded as their fieldList).
    func EmitInterfaceTypeDef(ifaceSym InterfaceSymbol, firstMethodRow int32, firstFieldRow int32) {
        let ifaceNested = ifaceSym.ContainingType != nil
        let ifaceNamespace = if ifaceNested {
            default(StringHandle)
        } else {
            this.emitCtx.Metadata.GetOrAddString(ifaceSym.PackageName ?? string.Empty)
        }
        let typeAttrs = TypeAttributes.Interface | TypeAttributes.Abstract | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass | (
            if ifaceNested {
                AccessibilityMap.MapNestedTypeAccessibility(ifaceSym.Accessibility)
            } else {
                AccessibilityMap.MapTypeAccessibility(ifaceSym.Accessibility)
            }
        )
        let typeDefName = MangleGenericName(ifaceSym.Name, ifaceSym.TypeParameters)
        let handle = this
            .emitCtx
            .Metadata
            .AddTypeDefinition(
            attributes: typeAttrs,
            namespace: ifaceNamespace,
            name: this.emitCtx.Metadata.GetOrAddString(typeDefName),
            baseType: default(EntityHandle),
            fieldList: MetadataTokens.FieldDefinitionHandle(firstFieldRow),
            methodList: MetadataTokens.MethodDefinitionHandle(firstMethodRow)
        )
        this.cache.InterfaceTypeDefs[ifaceSym] = handle
        if ifaceSym.IsProtocol || NativeProtocolSafety.ContainsSavedProtocol(ifaceSym) {
            this.EmitNativeProtocolFeature(handle)
            if !ifaceSym.IsProtocol {
                this.EmitNativeProtocolFeature(handle, NativeProtocolMetadata.StorageFeatureName)
            }
        }
        EmitGenericParamRows(this.emitCtx, handle, ifaceSym.TypeParameters)
        // ADR-0089 / issues #1030/#3519: emit interface static state and const
        // fields. ECMA constants use literal fields + Constant rows; decimal
        // uses initialized static read-only storage + DecimalConstantAttribute.
        var firstInterfaceField = default(FieldDefinitionHandle)
        if !ifaceSym.StaticFields.IsDefaultOrEmpty {
            for staticField in ifaceSym.StaticFields {
                let sigBlob = BlobBuilder()
                this.encodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), staticField.Type)
                var attrs = AccessibilityMap.MapFieldAccessibility(staticField.Accessibility) | FieldAttributes.Static
                if staticField.IsReadOnly {
                    attrs |= FieldAttributes.InitOnly
                }
                let fieldHandle = this
                    .emitCtx
                    .Metadata
                    .AddFieldDefinition(
                    attributes: attrs,
                    name: this.emitCtx.Metadata.GetOrAddString(staticField.Name),
                    signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
                )
                if firstInterfaceField.IsNil {
                    firstInterfaceField = fieldHandle
                }
                this.cache.StructFieldDefs[staticField] = fieldHandle
                this.emitNullableAttributeOnField(fieldHandle, staticField.Type)
                this.emitUserAttributes(fieldHandle, staticField, AttributeTargetKind.Field)
            }
        }
        if !ifaceSym.ConstFields.IsDefaultOrEmpty {
            for constField in ifaceSym.ConstFields {
                let sigBlob = BlobBuilder()
                this.encodeTypeSymbol(BlobEncoder(sigBlob).FieldSignature(), constField.Type)
                let attrs = AccessibilityMap.MapFieldAccessibility(
                    constField.Accessibility
                ) | FieldAttributes.Static | ConstantFieldMetadataEmitter.GetAttributes(constField.ConstantValue)
                let fieldHandle = this
                    .emitCtx
                    .Metadata
                    .AddFieldDefinition(
                    attributes: attrs,
                    name: this.emitCtx.Metadata.GetOrAddString(constField.Name),
                    signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
                )
                if firstInterfaceField.IsNil {
                    firstInterfaceField = fieldHandle
                }
                ConstantFieldMetadataEmitter.Emit(
                    this.emitCtx,
                    this.getTypeReference,
                    fieldHandle,
                    constField.ConstantValue
                )
                this.cache.StructFieldDefs[constField] = fieldHandle
                this.emitUserAttributes(fieldHandle, constField, AttributeTargetKind.Field)
            }
        }
        // Phase 3 of #141: user annotations targeting the type land on this TypeDef.
        this.emitUserAttributes(handle, ifaceSym, AttributeTargetKind.Type)
        this.emitNullableContextOnType(handle)
    }

    /// ADR-0059 / issue #255: emits a user-declared named delegate as a sealed
    /// reference type deriving from `System.MulticastDelegate` with two
    /// runtime-implemented methods:
    /// - `.ctor(object, native int)` — the standard delegate constructor recognised by the CLR for delegate
    /// creation (`newobj`) and binding.
    /// - `Invoke(params...) ret` — the delegate's call signature used by both managed callers and the CLR's
    /// delegate dispatch.
    /// Both methods carry `MethodImplAttributes.Runtime | Managed` and
    /// have no IL body — the runtime supplies the implementation. We
    /// intentionally do NOT emit `BeginInvoke`/`EndInvoke`, matching
    /// Roslyn's portable-assembly convention.
    /// @param delegateSym The named delegate symbol.
    /// @param firstMethodRow The pre-reserved method row of the
    /// delegate's `.ctor` (the second reserved row is its
    /// `Invoke`).
    func EmitDelegateTypeDef(delegateSym DelegateTypeSymbol, firstMethodRow int32) {
        let multicastTypeRef = this.getTypeReference(this.emitCtx.CoreMulticastDelegateType)
        // Delegates own no fields; their fieldList points at the next
        // FieldDef row, which is the first field of whatever TypeDef follows
        // in row order. We mirror the EmitEnumTypeDef pattern of capturing
        // the *next* row from the current FieldDef table count.
        let firstFieldHandle = MetadataTokens.FieldDefinitionHandle(
            this.emitCtx.Metadata.GetRowCount(TableIndex.Field) + 1
        )
        let typeAttrs = TypeAttributes.Class | TypeAttributes.Sealed | TypeAttributes.AnsiClass | TypeAttributes.AutoLayout | AccessibilityMap.MapTypeAccessibility(
            delegateSym.Accessibility
        )
        let delegateTypeDef = this
            .emitCtx
            .Metadata
            .AddTypeDefinition(
            attributes: typeAttrs,
            namespace: this.emitCtx.Metadata.GetOrAddString(delegateSym.PackageName ?? string.Empty),
            name: this.emitCtx.Metadata.GetOrAddString(MangleGenericName(delegateSym.Name, delegateSym.TypeParameters)),
            baseType: multicastTypeRef,
            fieldList: firstFieldHandle,
            methodList: MetadataTokens.MethodDefinitionHandle(firstMethodRow)
        )
        this.cache.DelegateTypeDefs[delegateSym] = delegateTypeDef
        // Issue #1503 / ADR-0059 follow-up: a generic named delegate carries
        // one GenericParam row per type parameter (mangled name above adds the
        // backtick-arity suffix). The Invoke signature references the slots as
        // VAR(idx) through the shared type encoder, exactly as generic
        // struct/class/interface TypeDefs do (ADR-0087 §3 R1/R2). Constraints
        // (`comparable`, `class`, interface bounds, …) flow through the same
        // queued GenericParamConstraint rows. Non-generic delegates emit no
        // GenericParam rows and keep their unmangled name.
        EmitGenericParamRows(this.emitCtx, delegateTypeDef, delegateSym.TypeParameters)
        // ---- .ctor(object, native int) ----
        let ctorSigBlob = BlobBuilder()
        BlobEncoder(ctorSigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                ps.AddParameter().Type().Object()
                ps.AddParameter().Type().IntPtr()
            }
        )
        let ctorFirstParamHandle = this.nextParameterHandle()
        let ctorObjectRow = this
            .emitCtx
            .Metadata
            .AddParameter(
            attributes: ParameterAttributes.None,
            name: this.emitCtx.Metadata.GetOrAddString("object"),
            sequenceNumber: 1
        )
        let ctorMethodRow = this
            .emitCtx
            .Metadata
            .AddParameter(
            attributes: ParameterAttributes.None,
            name: this.emitCtx.Metadata.GetOrAddString("method"),
            sequenceNumber: 2
        )
        let ctorAttrs = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName
        let ctorHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: ctorAttrs,
            implAttributes: MethodImplAttributes.Runtime | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSigBlob),
            bodyOffset: -1,
            parameterList: ctorFirstParamHandle
        )
        this.cache.DelegateCtorHandles[delegateSym] = ctorHandle
        // Issue #4988: even the runtime-provided constructor's signature goes
        // through the one nullability plan (its `object` is non-null and its
        // `native int` has no position, so nothing deviates today).
        this.emitMethodNullability(
            ctorHandle,
            MethodNullabilityPlan.ForParameters(
                TypeSymbol.Void,
                []ParameterSymbol{
                    ParameterSymbol("object", TypeSymbol.Object),
                    ParameterSymbol("method", TypeSymbol.NInt)
                }
            ),
            nil,
            ImmutableArray.Create(ctorObjectRow, ctorMethodRow)
        )
        // Sanity check: the actual .ctor row must match the row reserved by
        // the scheduler so the TypeDef's methodList pointer is valid.
        if MetadataTokens.GetRowNumber(ctorHandle) != firstMethodRow {
            throw InvalidOperationException(
                "Delegate '${delegateSym.Name}' .ctor MethodDef row ${MetadataTokens.GetRowNumber(ctorHandle)} did not match the reserved row $firstMethodRow. This indicates another emitter inserted method rows between scheduling and delegate emission."
            )
        }
        // ---- Invoke(params...) ret ----
        let invokeSigBlob = BlobBuilder()
        BlobEncoder(invokeSigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            delegateSym.Parameters.Length,
            (r ReturnTypeEncoder) -> this.encodeReturnSymbol(
                r,
                delegateSym.ReturnType ?? TypeSymbol.Void,
                RefKind.None
            ),
            (ps ParametersEncoder) -> {
                for p in delegateSym.Parameters {
                    // ADR-0060 §12: a named-delegate parameter declared `ref`/`out`/`in`
                    // emits `T&` on the Invoke signature, plus the IsReadOnlyAttribute
                    // modreq for `in` (matching the C# convention so consumers see a
                    // normal `ref`/`out`/`in` parameter). ParameterAttributes.Out / In
                    // are stamped on the per-parameter row below.
                    EncodeParameterSignature(ps, p, this.encodeTypeSymbol, this.wellKnown)
                }
            }
        )
        let invokeFirstParamHandle = this.nextParameterHandle()
        // Issue #4988: `Invoke` used to mint no return row, so a delegate
        // returning `Task[Token?]` exported `Task[Token]`.
        let invokeReturnType = delegateSym.ReturnType ?? TypeSymbol.Void
        let invokeNullability = MethodNullabilityPlan.ForParameters(invokeReturnType, delegateSym.Parameters)
        let invokeReturnRow = this.AddReturnRow(invokeNullability, invokeReturnType, RefKind.None, nil)
        let invokeParamHandles = ImmutableArray.CreateBuilder[ParameterHandle](delegateSym.Parameters.Length)
        for var i = 0; i < delegateSym.Parameters.Length; i++ {
            let p = delegateSym.Parameters[i]
            let paramHandle = ParameterMetadataEmitter.AddParameter(this.emitCtx, p, i + 1, fallbackName: "arg${i + 1}")
            invokeParamHandles.Add(paramHandle)
            if p.RefKind == RefKind.In {
                this.emitIsReadOnlyAttributeOnParameter(paramHandle)
            }
            // ADR-0101 follow-up / issue #812: stamp [ParamArrayAttribute]
            // on the trailing variadic Invoke parameter so C# / F# / VB
            // consumers see the delegate as a normal `params T[]` delegate.
            if p.IsVariadic {
                // ADR-0173: array carriers keep [ParamArray]; collection
                // carriers stamp C#13's [ParamCollection].
                if VariadicCarriers.GetCarrierKind(p.Type) == VariadicCarriers.CarrierKind.Array {
                    this.emitParamArrayAttributeOnParameter(paramHandle)
                } else {
                    this.emitParamCollectionAttributeOnParameter(paramHandle)
                }
            }
            this.EmitParameterTupleNames(paramHandle, p)
        }
        let invokeAttrs = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.Virtual | MethodAttributes.NewSlot
        let invokeParamList = if delegateSym.Parameters.Length > 0 || invokeReturnRow != nil {
            invokeFirstParamHandle
        } else {
            this.nextParameterHandle()
        }
        let invokeHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: invokeAttrs,
            implAttributes: MethodImplAttributes.Runtime | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("Invoke"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(invokeSigBlob),
            bodyOffset: -1,
            parameterList: invokeParamList
        )
        this.cache.DelegateInvokeHandles[delegateSym] = invokeHandle
        // Issue #2006: delegate Invoke parameters must keep their user
        // annotations same as the other Parameter-row-minting emit sites, or
        // @Note-style attributes silently vanish for delegate params.
        let invokeRows = invokeParamHandles.MoveToImmutable()
        this.EmitUserAttributesOnParameters(invokeRows, delegateSym.Parameters)
        this.StampSignature(invokeHandle, invokeNullability, invokeReturnRow, invokeReturnType, nil, invokeRows)
        // ADR-0047 §3: user annotations targeting the delegate type land on
        // the TypeDef row (same as struct/interface/enum).
        this.emitUserAttributes(delegateTypeDef, delegateSym, AttributeTargetKind.Type)
        this.emitNullableContextOnType(delegateTypeDef)
    }

    /// Phase 3.B.4: emits an abstract method definition for an interface
    /// member. Carries `Public | Virtual | Abstract | NewSlot | HideBySig`
    /// and no body (bodyOffset = -1).
    /// @param method The interface method symbol.
    func EmitAbstractMethod(method FunctionSymbol) {
        let sigBlob = BlobBuilder()
        // Issue #1007: a bodyless interface method may be generic
        // (`func M[T](...) T;`). Stamp the signature's generic-parameter count
        // and (after the MethodDef is minted) the per-method GenericParam rows
        // so the abstract slot is a proper CLR generic method definition — its
        // parameter / return types reference the method type parameters as
        // MVAR(idx) through the shared type encoder.
        let methodGenericArity = if method.TypeParameters.IsDefaultOrEmpty {
            0
        } else {
            method.TypeParameters.Length
        }
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true, genericParameterCount: methodGenericArity)
            .Parameters(
            method.Parameters.Length,
            (r ReturnTypeEncoder) -> this.encodeReturnSymbol(r, method.Type, method.ReturnRefKind),
            (ps ParametersEncoder) -> {
                // Issue #1610: encode ref/out/in parameters as managed
                // pointers (`T&`, plus the IsReadOnlyAttribute modreq for
                // `in`) exactly like the class-method path — otherwise the
                // abstract slot's by-value signature never matches the
                // implementing class's byref signature and type load fails
                // with TypeLoadException.
                for p in method.Parameters {
                    EncodeParameterSignature(ps, p, this.encodeTypeSymbol, this.wellKnown)
                }
            }
        )
        // Issue #1610: emit a Parameter row per source parameter (name plus
        // ParameterAttributes.In/Out and the IsReadOnlyAttribute for `in`),
        // mirroring EmitFunction, so interface parameters keep their names in
        // metadata (named arguments / IDE signature help from consumers).
        // Issue #4988: the return row comes from the same decision a method
        // with a body makes — a bodyless slot returning `Task[Token?]` needs
        // it just as much.
        let nullability = MethodNullabilityPlan.ForParameters(method.Type, method.Parameters, method.TypeParameters)
        let returnHandle = this.AddReturnRow(nullability, method.Type, method.ReturnRefKind, method)
        var firstParamHandle = this.AddRefKindAwareParameterRows(method.Parameters, out var paramHandles)
        firstParamHandle = returnHandle ?? firstParamHandle
        let attrs = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot
        let handle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: attrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: -1,
            parameterList: firstParamHandle
        )
        if methodGenericArity > 0 {
            EmitGenericParamRows(this.emitCtx, handle, method.TypeParameters)
        }
        // Issue #1913: interface abstract-slot parameters must carry their
        // user annotations same as the class-method path, or @Note-style
        // attributes silently vanish for interface members.
        this.EmitUserAttributesOnParameters(paramHandles, method.Parameters)
        // Issue #2129: method-level @annotations on an abstract interface
        // method signature emit as CustomAttribute rows on the MethodDef,
        // mirroring the bodied (EmitFunction) path.
        this.emitUserAttributes(handle, method, AttributeTargetKind.Method)
        this.StampSignature(handle, nullability, returnHandle, method.Type, method, paramHandles)
        if NativeProtocolSafety.RequiresFeatureMarker(method) {
            this.EmitNativeProtocolFeature(handle)
        }
    }

    /// Issue #4988: mints a signature's sequence-0 `Param` row when
    /// (cref:ParameterMetadataEmitter.NeedsReturnParameter) says it needs
    /// one, stamping the `ref readonly` marker at once. Call it before the
    /// parameter rows: ECMA-335 II.22.33 orders a method's rows by sequence.
    /// @param plan The signature's nullability plan.
    /// @param returnType The declared return type.
    /// @param returnRefKind The return's ref kind.
    /// @param owner The declaration whose `@return:` annotations apply, if any.
    /// @returns The row, or `null` when the return position carries nothing.
    private func AddReturnRow(
        plan MethodNullabilityPlan,
        returnType TypeSymbol,
        returnRefKind RefKind,
        owner Symbol?
    ) ParameterHandle? {
        if !ParameterMetadataEmitter.NeedsReturnParameter(plan, returnType, returnRefKind, owner) {
            return nil
        }
        let handle = ParameterMetadataEmitter.AddReturnParameter(this.emitCtx)
        if returnRefKind == RefKind.RefReadOnly {
            this.emitIsReadOnlyAttributeOnParameter(handle)
        }
        return handle
    }

    /// Issue #4988: stamps what a signature's rows carry once its MethodDef
    /// exists — the return row's `@return:` annotations, the nullability
    /// [`plan`](paramref) decided, and the return's tuple element names —
    /// in the order the bodied-method path (FunctionEmitter) uses.
    /// @param handle The MethodDef.
    /// @param plan The signature's nullability plan.
    /// @param returnRow The row (cref:AddReturnRow) minted, if any.
    /// @param returnType The declared return type.
    /// @param owner The declaration whose `@return:` annotations apply, if any.
    /// @param parameterRows The parameter rows the plan covers.
    private func StampSignature(
        handle MethodDefinitionHandle,
        plan MethodNullabilityPlan,
        returnRow ParameterHandle?,
        returnType TypeSymbol,
        owner Symbol?,
        parameterRows ImmutableArray[ParameterHandle]
    ) {
        if returnRow is {} userReturnRow && owner != nil {
            this.emitUserAttributes(userReturnRow, owner, AttributeTargetKind.Return)
        }
        this.emitMethodNullability(handle, plan, returnRow, parameterRows)
        if returnRow is {} tupleReturnRow {
            this.emitTupleElementNamesOnParameter(tupleReturnRow, returnType)
        }
    }

    /// Issue #4988: stamps a constructor's parameter rows — their user
    /// annotations, then their nullability through the one plan.
    /// @param handle The constructor's MethodDef.
    /// @param parameterRows The rows, in source-parameter order.
    /// @param parameters The source parameters.
    private func StampConstructorParameters(
        handle MethodDefinitionHandle,
        parameterRows ImmutableArray[ParameterHandle],
        parameters ImmutableArray[ParameterSymbol]
    ) {
        this.EmitUserAttributesOnParameters(parameterRows, parameters)
        this.emitMethodNullability(
            handle,
            MethodNullabilityPlan.ForParameters(TypeSymbol.Void, parameters),
            nil,
            parameterRows
        )
    }

    /// ADR-0089 / issue #755: emits a static-virtual interface
    /// MethodDef. Carries
    /// `Public | Static | Virtual | Abstract | NewSlot | HideBySig`
    /// for abstract static slots, omits `Abstract` when the interface
    /// supplied a default body, and (when a body is present) plugs in the
    /// encoded IL via [`bodyOffset`](paramref).
    /// @param method The interface static-virtual method symbol.
    /// @param hasBody True if the declaration carries a default body.
    /// @param bodyOffset Pre-emitted IL body offset; ignored when [`hasBody`](paramref) is false.
    func EmitStaticVirtualMethod(method FunctionSymbol, hasBody bool, bodyOffset int32) {
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            method.Parameters.Length,
            (r ReturnTypeEncoder) -> this.encodeReturnSymbol(r, method.Type, method.ReturnRefKind),
            (ps ParametersEncoder) -> {
                // Issue #1610: same as EmitAbstractMethod — ref/out/in
                // parameters must be encoded byref (plus the `in` modreq)
                // or implementing types never satisfy the static-virtual
                // slot.
                for p in method.Parameters {
                    EncodeParameterSignature(ps, p, this.encodeTypeSymbol, this.wellKnown)
                }
            }
        )
        // Issue #1610: Parameter rows with names and In/Out flags, mirroring
        // EmitFunction.
        let nullability = MethodNullabilityPlan.ForParameters(method.Type, method.Parameters, method.TypeParameters)
        let returnHandle = this.AddReturnRow(nullability, method.Type, method.ReturnRefKind, method)
        var firstParamHandle = this.AddRefKindAwareParameterRows(method.Parameters, out var paramHandles)
        firstParamHandle = returnHandle ?? firstParamHandle
        var attrs = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.Static | MethodAttributes.Virtual | MethodAttributes.NewSlot
        if !hasBody {
            attrs |= MethodAttributes.Abstract
        }
        let handle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: attrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(method.Name),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: if hasBody {
                bodyOffset
            } else {
                -1
            },
            parameterList: firstParamHandle
        )
        // Issue #1913: same as EmitAbstractMethod — static-virtual interface
        // slots must keep their parameter annotations.
        this.EmitUserAttributesOnParameters(paramHandles, method.Parameters)
        // Issue #2129: method-level @annotations on a static-virtual interface
        // method emit as CustomAttribute rows on the MethodDef.
        this.emitUserAttributes(handle, method, AttributeTargetKind.Method)
        this.StampSignature(handle, nullability, returnHandle, method.Type, method, paramHandles)
    }

    /// Issue #1610: emits one `Parameter` row per source parameter,
    /// giving each its metadata name, stamping
    /// (cref:ParameterAttributes.Out) / (cref:ParameterAttributes.In)
    /// for `out` / `in` (ADR-0060 §6: `ref` carries neither),
    /// attaching the `IsReadOnlyAttribute` custom attribute for
    /// `in`, and `[ParamArrayAttribute]` for a trailing variadic
    /// parameter. Returns the handle of the first emitted row — or the next
    /// available row when the parameter list is empty — suitable to feed into
    /// `AddMethodDefinition.parameterList`.
    /// @param parameters The method's source parameters.
    /// @param paramHandles Every emitted Parameter row handle, in source-parameter order — feed into
    /// (cref:EmitUserAttributesOnParameters) so per-parameter annotations are never dropped.
    /// @returns The MethodDef's `parameterList` anchor handle.
    private func AddRefKindAwareParameterRows(
        parameters ImmutableArray[ParameterSymbol],
        out paramHandles ImmutableArray[ParameterHandle]
    ) ParameterHandle {
        let first = this.nextParameterHandle()
        let handles = ImmutableArray.CreateBuilder[ParameterHandle](parameters.Length)
        for var i = 0; i < parameters.Length; i++ {
            let p = parameters[i]
            let paramHandle = ParameterMetadataEmitter.AddParameter(this.emitCtx, p, i + 1)
            handles.Add(paramHandle)
            if p.RefKind == RefKind.In {
                this.emitIsReadOnlyAttributeOnParameter(paramHandle)
            }
            if p.IsVariadic {
                // ADR-0173: array carriers keep [ParamArray]; collection
                // carriers stamp C#13's [ParamCollection].
                if VariadicCarriers.GetCarrierKind(p.Type) == VariadicCarriers.CarrierKind.Array {
                    this.emitParamArrayAttributeOnParameter(paramHandle)
                } else {
                    this.emitParamCollectionAttributeOnParameter(paramHandle)
                }
            }
            this.EmitParameterTupleNames(paramHandle, p)
        }
        paramHandles = handles.MoveToImmutable()
        return first
    }

    /// ADR-0172 Phase B: parameter rows carry tuple element names. Their
    /// nullability is not stamped here: it needs the whole signature's plan,
    /// which the caller applies once the MethodDef exists (issue #4988).
    private func EmitParameterTupleNames(paramHandle ParameterHandle, parameter ParameterSymbol) {
        this.emitTupleElementNamesOnParameter(paramHandle, parameter.Type)
    }

    /// Issue #1913 (B1/B2 follow-up): the shared tail-end of every
    /// `AddRefKindAwareParameterRows` call site — stamps user
    /// annotations (e.g. `@Note("…")`) onto each Parameter row. Every
    /// emit path that mints Parameter rows via `AddRefKindAwareParameterRows`
    /// (ctor, abstract interface method, static-virtual interface method)
    /// must also call this, or parameter attributes silently vanish from the
    /// emitted metadata even though the binder attached them correctly.
    /// @param paramHandles Handles returned alongside `AddRefKindAwareParameterRows`, in source-parameter
    /// order.
    /// @param parameters The same source parameters passed to `AddRefKindAwareParameterRows`.
    private func EmitUserAttributesOnParameters(
        paramHandles ImmutableArray[ParameterHandle],
        parameters ImmutableArray[ParameterSymbol]
    ) {
        for var i = 0; i < parameters.Length; i++ {
            this.emitUserAttributes(paramHandles[i], parameters[i], AttributeTargetKind.Param)
        }
    }

    /// Emits a parameter-less `.ctor` for a user-defined `class`
    /// (Phase 3.B.3). The body chains to the base class's `.ctor()`
    /// (either an inherited user class or `System.Object`) and returns.
    /// @param classSym The class whose default constructor is being emitted.
    /// @returns The emitted constructor's MethodDef handle.
    func EmitClassDefaultConstructor(classSym StructSymbol) MethodDefinitionHandle {
        let baseCtorToken = this.GetBaseCtorToken(classSym)
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            // Issue #640: when the class declares instance field initializers,
            // delegate to the body-emitter callback so expressions are evaluated
            // and stored into fields after the base ctor call.
            if ConstructorBodyEmitter.NeedsInstanceFieldInitializerStatements(classSym) {
                bodyOffset = this.emitClassDefaultConstructorBodyBytes(classSym, baseCtorToken)
            } else {
                let il = InstructionEncoder(BlobBuilder())
                il.LoadArgument(0)
                il.OpCode(ILOpCode.Call)
                il.Token(baseCtorToken)
                il.OpCode(ILOpCode.Ret)
                bodyOffset = this
                    .emitCtx
                    .MethodBodyStream
                    .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
            }
        }
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        // ADR-0195 / issue #4674: a `shared` class is not constructible, so its
        // placeholder `.ctor` is private (C# emits none; a private member is not
        // part of the API); an explicitly `abstract` class's implicit `.ctor` is
        // `family`, as in C#, since only derived classes may chain to it.
        let visibility = if classSym.IsSharedClass {
            MethodAttributes.Private
        } else {
            (
                if IsExplicitlyAbstract(classSym) && !HasEmptyPrimaryConstructor(classSym) {
                    MethodAttributes.Family
                } else {
                    (
                        if classSym.HasPrimaryConstructor && !classSym.IsData {
                            MethodAttributes.Assembly
                        } else {
                            MethodAttributes.Public
                        }
                    )
                }
            )
        }
        return this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: visibility | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle()
        )
    }

    /// Issue #3219: emits the synthesized owning initializer `.ctor`
    /// for a value-kind struct with declaration initializers that require
    /// constructor-owned initialization: non-public fields, a generic struct
    /// or enclosing type, or primary parameters (see
    /// (cref:ConstructorBodyEmitter.NeedsSynthesizedValueStructDefaultCtor)).
    /// The body zero-initializes `this` and runs the declared instance
    /// field initializers in-type, so struct-literal sites can construct
    /// through it instead of storing private fields from the call site.
    /// A primary struct retains its parameterized signature (#4747).
    /// With an authored parameterless constructor, a distinct assembly-only
    /// signature initializes literals without executing the authored body.
    /// @param structSym The struct whose synthesized default constructor is being emitted.
    /// @returns The emitted constructor's MethodDef handle.
    func EmitValueStructDefaultConstructor(structSym StructSymbol) MethodDefinitionHandle {
        let usesPrimarySignature = structSym.HasPrimaryConstructor &&
            !structSym.ValueStructDefaultCtorIsZeroInitialization
        let parameters = if usesPrimarySignature {
            structSym.PrimaryConstructorParameters
        } else {
            ImmutableArray[ParameterSymbol].Empty
        }
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            bodyOffset = if usesPrimarySignature {
                this.emitClassPrimaryConstructorBodyBytes(structSym, default(EntityHandle))
            } else {
                this.emitValueStructDefaultConstructorBodyBytes(structSym)
            }
        }
        let ctorSig = BlobBuilder()
        let markerCount = structSym.LiteralInitializerMarkerCount
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            parameters.Length + markerCount,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                for parameter in parameters {
                    this.encodeTypeSymbol(
                        ps.AddParameter().Type(isByRef: parameter.RefKind != RefKind.None),
                        parameter.Type
                    )
                }
                for var marker = 0; marker < markerCount; marker++ {
                    this.encodeTypeSymbol(ps.AddParameter().Type(), TypeSymbol.Bool)
                }
            }
        )
        let firstParameter = this.AddPrimaryCtorParameterRows(parameters, out var parameterHandles)
        let constructor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: (
                if markerCount == 0 {
                    MethodAttributes.Public
                } else {
                    MethodAttributes.Assembly
                }
            ) | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: firstParameter
        )
        this.StampConstructorParameters(constructor, parameterHandles, parameters)
        return constructor
    }

    /// Emits a `.cctor` (type initializer) for a type with static field
    /// initializers (Issue #262). The body evaluates each initializer expression
    /// and stores the result into the corresponding static field via `stsfld`.
    /// @param typeSym The type whose static constructor is being emitted.
    func EmitStaticConstructor(typeSym StructSymbol) {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            bodyOffset = this.emitStaticConstructorBodyBytes(typeSym)
        }
        let cctorSig = BlobBuilder()
        BlobEncoder(cctorSig).MethodSignature(isInstanceMethod: false).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName | MethodAttributes.Static,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".cctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(cctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle()
        )
    }

    /// Emits the Kotlin-style primary constructor for a class
    /// (Phase 3.B.3 sub-step 2): an instance ctor taking one parameter per
    /// declared primary-ctor param, chaining to `object::.ctor()` and
    /// assigning each argument to the same-named field.
    /// @param classSym The class with a declared primary constructor.
    /// @returns The emitted constructor's MethodDef handle.
    func EmitClassPrimaryConstructor(classSym StructSymbol) MethodDefinitionHandle {
        let parameters = classSym.PrimaryConstructorParameters
        let baseCtorToken = this.GetBaseCtorToken(classSym)
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            // Issue #640: when the class declares instance field initializers,
            // delegate to the body-emitter callback so expressions are evaluated
            // and stored into fields after the base ctor call and primary ctor
            // parameter assignments.
            // ADR-0087 §3 R3: also delegate to the callback for generic
            // user classes so the param→field stfld is routed through a
            // TypeSpec-parented MemberRef (the callback uses
            // ResolveFieldToken; the inline path below uses bare
            // FieldDefs which fail ilverify on a self-instantiation).
            if ConstructorBodyEmitter.NeedsInstanceFieldInitializerStatements(classSym) ||
                ReflectionMetadataEmitter
                .IsUserGenericTypeReference(classSym) {
                bodyOffset = this.emitClassPrimaryConstructorBodyBytes(classSym, baseCtorToken)
            } else {
                let il = InstructionEncoder(BlobBuilder())
                il.LoadArgument(0)
                il.OpCode(ILOpCode.Call)
                il.Token(baseCtorToken)
                // For each ctor param: this.<field> = arg; positional 1:1 with
                // fields of the same name.
                for var i = 0; i < parameters.Length; i++ {
                    let param = parameters[i]
                    if !ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(classSym, param.Name, out var field) {
                        continue
                    }
                    if !this.cache.StructFieldDefs.TryGetValue(field, out var fieldHandle) {
                        throw InvalidOperationException("Class field '${field.Name}' has no emitted FieldDef.")
                    }
                    il.LoadArgument(0)
                    il.LoadArgument(i + 1)
                    il.OpCode(ILOpCode.Stfld)
                    il.Token(fieldHandle)
                }
                il.OpCode(ILOpCode.Ret)
                bodyOffset = this
                    .emitCtx
                    .MethodBodyStream
                    .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
            }
        }
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            parameters.Length,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                for p in parameters {
                    this.encodeTypeSymbol(ps.AddParameter().Type(), p.Type)
                }
            }
        )
        // ADR-0101 follow-up / issue #819: stamp `[ParamArrayAttribute]` on
        // the trailing variadic primary-ctor parameter so C# / F# / VB
        // consumers see `params` at the construction site. Adding Parameter
        // rows here also gives every primary-ctor parameter a metadata name
        // (parallel to the explicit `init(...)` emit path).
        let firstParamHandle = this.AddPrimaryCtorParameterRows(parameters, out var paramHandles)
        let visibility = if classSym.IsData && IsExplicitlyAbstract(classSym) {
            MethodAttributes.Family
        } else {
            MethodAttributes.Public
        }
        let ctorHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: visibility | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle
        )
        // Issue #2006: primary-ctor parameters must keep their user
        // annotations same as explicit ctors / interface methods, or
        // @Note-style attributes silently vanish for primary-ctor params.
        this.StampConstructorParameters(ctorHandle, paramHandles, parameters)
        return ctorHandle
    }

    /// Issue #306: emits a constructor that forwards arguments to an explicit
    /// base constructor (`: Base(args)`) before initializing the class's
    /// own fields from the primary-constructor parameters. The base arguments
    /// are evaluated via a `BodyEmitter` so they may reference the
    /// primary-constructor parameters; the resolved base ctor token comes from
    /// the bound (cref:BaseConstructorInitializer).
    /// @param classSym The class whose forwarding constructor is being emitted.
    /// @param parameters The constructor parameters (the primary-constructor parameters, or empty when the
    /// base arguments are constant).
    /// @returns The emitted constructor's MethodDef handle.
    func EmitClassConstructorWithBaseInitializer(
        classSym StructSymbol,
        parameters ImmutableArray[ParameterSymbol]
    ) MethodDefinitionHandle {
        // Non-null: both call sites (ReflectionMetadataEmitter.cs, the
        // synthesized-primary-constructor and single-constructor emission
        // branches) check `c.BaseConstructorInitializer != null` before
        // routing to this "WithBaseInitializer" emitter.
        let init = classSym.BaseConstructorInitializer!!
        let baseCtorToken = this.GetBaseInitializerCtorToken(classSym, init)
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            bodyOffset = this.emitClassConstructorWithBaseInitializerBodyBytes(
                classSym,
                parameters,
                init,
                baseCtorToken
            )
        }
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            parameters.Length,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                for p in parameters {
                    this.encodeTypeSymbol(ps.AddParameter().Type(), p.Type)
                }
            }
        )
        // ADR-0101 follow-up / issue #819: stamp `[ParamArrayAttribute]` on
        // the trailing variadic primary-ctor parameter so C# / F# / VB
        // consumers see `params` at the construction site. Adding Parameter
        // rows here also gives every primary-ctor parameter a metadata name
        // (parallel to the explicit `init(...)` emit path).
        let firstParamHandle = this.AddPrimaryCtorParameterRows(parameters, out var paramHandles)
        // ADR-0195 / issue #4674: the implicit parameterless constructor that chains to an
        // explicit base initializer (`abstract class D : Base(1) { }`) is `family`, like
        // the plain implicit constructor of a declared-abstract class (see
        // EmitClassDefaultConstructor); a primary constructor stays public.
        let forwardingVisibility = if IsExplicitlyAbstract(classSym) &&
            !classSym.HasPrimaryConstructor &&
            !HasEmptyPrimaryConstructor(classSym) {
            MethodAttributes.Family
        } else {
            MethodAttributes.Public
        }
        let ctorHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: forwardingVisibility | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: firstParamHandle
        )
        // Issue #2006: primary-ctor parameters must keep their user
        // annotations same as explicit ctors / interface methods, or
        // @Note-style attributes silently vanish for primary-ctor params.
        this.StampConstructorParameters(ctorHandle, paramHandles, parameters)
        return ctorHandle
    }

    /// ADR-0101 follow-up / issue #819: emits one `Parameter` row per
    /// primary-constructor parameter, giving each a metadata name and
    /// stamping `[ParamArrayAttribute]` on the trailing variadic
    /// parameter (when present). Optional parameters also carry the CLR
    /// Optional/HasDefault flags and Constant row. Returns the handle of the
    /// first emitted
    /// row — or the next available row when the parameter list is empty —
    /// suitable to feed into `AddMethodDefinition.parameterList`.
    /// Primary-ctor parameters never carry `ref` / `out` / `in`
    /// modifiers (the binder rejects those with `GS9032`), so this
    /// helper does not stamp (cref:ParameterAttributes.In) /
    /// (cref:ParameterAttributes.Out) or the
    /// `IsReadOnlyAttribute` modreq.
    /// @param parameters The primary constructor's source parameters.
    /// @param paramHandles Every emitted Parameter row handle, in source-parameter order — feed into
    /// (cref:EmitUserAttributesOnParameters) so per-parameter annotations are never dropped (issue #2006).
    private func AddPrimaryCtorParameterRows(
        parameters ImmutableArray[ParameterSymbol],
        out paramHandles ImmutableArray[ParameterHandle]
    ) ParameterHandle {
        if parameters.IsDefaultOrEmpty {
            paramHandles = ImmutableArray[ParameterHandle].Empty
            return this.nextParameterHandle()
        }
        let first = this.nextParameterHandle()
        let handles = ImmutableArray.CreateBuilder[ParameterHandle](parameters.Length)
        for var i = 0; i < parameters.Length; i++ {
            let p = parameters[i]
            let paramHandle = ParameterMetadataEmitter.AddParameter(this.emitCtx, p, i + 1)
            handles.Add(paramHandle)
            if p.IsVariadic {
                // ADR-0173: array carriers keep [ParamArray]; collection
                // carriers stamp C#13's [ParamCollection].
                if VariadicCarriers.GetCarrierKind(p.Type) == VariadicCarriers.CarrierKind.Array {
                    this.emitParamArrayAttributeOnParameter(paramHandle)
                } else {
                    this.emitParamCollectionAttributeOnParameter(paramHandle)
                }
            }
            this.EmitParameterTupleNames(paramHandle, p)
        }
        paramHandles = handles.MoveToImmutable()
        return first
    }

    /// Adds a synthesized primary constructor's parameter rows with their user
    /// annotations. The caller stamps their nullability once the MethodDef
    /// exists, through the same plan as every other signature (issue #4988).
    /// @param parameters The constructor's parameters.
    /// @returns The `parameterList` anchor and the rows, in parameter order.
    internal func AddPrimaryCtorParameters(parameters ImmutableArray[ParameterSymbol])(
        First ParameterHandle,
        Rows ImmutableArray[ParameterHandle]
    ) {
        let first = this.AddPrimaryCtorParameterRows(parameters, out var parameterHandles)
        this.EmitUserAttributesOnParameters(parameterHandles, parameters)
        return (first, parameterHandles)
    }

    /// Issue #306 / #2766: emits a class or plain-struct constructor materialized from an explicit
    /// `init(...)` declaration. The body first chains to the resolved base
    /// constructor (either the explicit `: base(args)` initializer or the
    /// conventional parameterless chain) and then runs the bound constructor
    /// body, which sees `this`, the constructor parameters, and the class's
    /// fields (as bare names).
    /// @param classSym The aggregate whose explicit constructor is being emitted.
    /// @param ctor The specific explicit ctor overload to emit. When `null` the legacy single-ctor entry on
    /// the aggregate is used.
    /// @returns The emitted constructor's MethodDef handle.
    func EmitClassConstructorWithBody(classSym StructSymbol, ctor ConstructorSymbol? = nil) MethodDefinitionHandle {
        var ctor = ctor
        ctor ??= Invariant.Required(
            classSym.ExplicitConstructor,
            "callers either pass an explicit overload from classSym.ExplicitConstructors or rely on the legacy single-constructor fallback, which requires classSym to have declared at least one init(...) constructor",
            expression: "classSym.ExplicitConstructor"
        )
        let function = ctor!!.Function
        let init BaseConstructorInitializer? = ctor!!.BaseInitializer
        let baseCtorToken = if classSym.IsClass {
            (
                if init != nil {
                    this.GetBaseInitializerCtorToken(classSym, init)
                } else {
                    this.GetBaseCtorToken(classSym)
                }
            )
        } else {
            default(EntityHandle)
        }
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            bodyOffset = this.emitClassConstructorWithBodyBodyBytes(classSym, ctor!!, init, baseCtorToken)
        }
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            function.Parameters.Length,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                for p in function.Parameters {
                    // ADR-0060: ref-kind constructor parameters are encoded as
                    // managed pointers (`T&`). For `in`, also stamp the
                    // IsReadOnlyAttribute modreq.
                    EncodeParameterSignature(ps, p, this.encodeTypeSymbol, this.wellKnown)
                }
            }
        )
        // ADR-0060: emit a Parameter row per source parameter so we can stamp
        // ParameterAttributes.In/Out and (for `in`) IsReadOnlyAttribute.
        // ADR-0102 / issue #812: the row helper also stamps
        // [ParamArrayAttribute] on a trailing variadic parameter so C#/F#
        // consumers see `params`.
        let firstCtorParamHandle = this.AddRefKindAwareParameterRows(function.Parameters, out var ctorParamHandles)
        let ctorHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: AccessibilityMap.ToMethodVisibility(
                function.Accessibility
            ) | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: firstCtorParamHandle
        )
        // Issue #1913: constructor parameters must carry their user
        // annotations same as the class-method path (bug B1 — this was
        // dropped even after the binder-level #1913 fix).
        this.StampConstructorParameters(ctorHandle, ctorParamHandles, function.Parameters)
        return ctorHandle
    }

    /// ADR-0068 / issue #698: emits the synthesized `Finalize` override
    /// for a class that declares a `deinit { … }` body. The emitted
    /// method has signature `protected override void Finalize()`
    /// ((cref:MethodAttributes.Family) | (cref:MethodAttributes.Virtual)
    /// | (cref:MethodAttributes.HideBySig)) and overrides the
    /// `Finalize` slot inherited from `System.Object` by
    /// name+signature match. The body bytes are produced by the injected
    /// `emitClassDeinitializerBodyBytes` delegate which wraps the user
    /// body in `try { … } finally { base.Finalize(); }` exactly as the
    /// C# compiler emits for `~Type()`.
    /// @param classSym The class declaring the `deinit`.
    /// @param deinit The bound deinit symbol.
    /// @param body The lowered deinit body block.
    /// @returns The emitted method's MethodDef handle.
    func EmitClassDeinitializer(
        classSym StructSymbol,
        deinit DeinitSymbol,
        body BoundBlockStatement
    ) MethodDefinitionHandle {
        let baseFinalizeRef = this.wellKnown.GetObjectFinalizeRef()
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            bodyOffset = this.emitClassDeinitializerBodyBytes(classSym, deinit, body, baseFinalizeRef)
        }
        let sig = BlobBuilder()
        BlobEncoder(sig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        return this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Family | MethodAttributes.Virtual | MethodAttributes.HideBySig,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("Finalize"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle()
        )
    }

    /// Assembly-level synthesized default constructor used by synthesized
    /// closure / state-machine classes that have no user-authored ctor.
    /// @returns The emitted constructor's MethodDef handle.
    func EmitDefaultConstructor() MethodDefinitionHandle {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            let il = InstructionEncoder(BlobBuilder())
            il.LoadArgument(0)
            il.Call(this.wellKnown.ObjectCtorRef)
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        return this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(ctorSig),
            bodyOffset: bodyOffset,
            parameterList: this.nextParameterHandle()
        )
    }

    // Private helpers — exclusive to the methods above
    /// Resolves the `.ctor()` token a derived class's ctor should chain to: either the base class's default
    /// ctor (already emitted) or (cref:WellKnownReferences.ObjectCtorRef).
    private func GetBaseCtorToken(classSym StructSymbol) EntityHandle {
        // Issue #1055: the base is a CONSTRUCTED generic user class. Its ctor
        // MethodDef is keyed by the open definition, so resolve a MemberRef
        // parented at the constructed base's TypeSpec instead of falling back to
        // System.Object (which would chain past the real base subobject).
        // Issue #2337: also covers a nested sibling base that only carries the
        // enclosing generic's reified TypeParameters (implicit generic arity,
        // no own TypeArguments) — it likewise needs a TypeSpec-parented
        // MemberRef, not the bare base ctor MethodDef.
        if classSym.BaseClass != nil && ReflectionMetadataEmitter.IsUserGenericTypeReference(classSym.BaseClass) {
            return this.resolveConstructedBaseCtorToken(classSym.BaseClass!!)
        }
        if classSym.BaseClass != nil &&
            this
            .cache
            .ClassCtorHandles
            .TryGetValue(classSym.BaseClass!!, out var baseCtor) {
            return baseCtor
        }
        if classSym.IsAttributeClass {
            // Phase 4 of #141 / ADR-0047 §5: chain to System.Attribute..ctor()
            // since the base type was overridden away from System.Object.
            return this.wellKnown.GetSystemAttributeCtorRef()
        }
        if classSym.ImportedBaseType?.ClrType is Type importedBaseClr {
            // Issue #296: chain the generated ctor to the imported CLR base's
            // accessible parameterless constructor.
            return this.GetImportedBaseDefaultCtorReference(classSym.ImportedBaseType!!)
        }
        return this.wellKnown.ObjectCtorRef
    }

    /// Returns a TypeRef or symbolic TypeSpec for an imported base class.
    private func GetImportedBaseTypeHandle(importedBaseType TypeSymbol) EntityHandle {
        if importedBaseType is ImportedTypeSymbol &&
            importedBaseType.OpenDefinition != nil &&
            importedBaseType.HasSubstitutableTypeArgument == true {
            let signature = BlobBuilder()
            this.encodeTypeSymbol(BlobEncoder(signature).TypeSpecificationSignature(), importedBaseType)
            return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(signature))
        }
        return this.getImportedTypeHandle(
            Invariant.Required(
                importedBaseType.ClrType,
                "an imported base type has a CLR representation",
                expression: "importedBaseType.ClrType"
            )
        )
    }

    /// Issue #296: resolves a MemberRef to the imported CLR base class's
    /// accessible parameterless `.ctor()` for base-constructor chaining.
    /// Uses metadata-safe reflection (the declaring type is loaded under a
    /// MetadataLoadContext). Falls back to a synthesized parameterless ctor
    /// reference when no explicit parameterless ctor is discoverable.
    private func GetImportedBaseDefaultCtorReference(importedBaseType TypeSymbol) EntityHandle {
        let importedBaseClr = Invariant.Required(
            importedBaseType.ClrType,
            "an imported base type has a CLR representation",
            expression: "importedBaseType.ClrType"
        )
        var parameterless ConstructorInfo? = nil
        for ctor in importedBaseClr.GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
        ) {
            if ctor.GetParameters().Length != 0 {
                continue
            }
            if ctor.IsPublic || ctor.IsFamily || ctor.IsFamilyOrAssembly {
                parameterless = ctor
                break
            }
        }
        if parameterless != nil {
            return this.getCtorReferenceForType(parameterless, importedBaseType)
        }
        // No explicit accessible parameterless ctor was found; reference a
        // synthesized parameterless ctor signature on the base type ref. This
        // matches the implicit default ctor a base class would otherwise expose.
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        return this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            parent: this.GetImportedBaseTypeHandle(importedBaseType),
            name: this.emitCtx.Metadata.GetOrAddString(".ctor"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob)
        )
    }

    /// Issue #306: resolves the metadata token of the base constructor targeted by a
    /// (cref:BaseConstructorInitializer).
    private func GetBaseInitializerCtorToken(classSym StructSymbol, init BaseConstructorInitializer) EntityHandle {
        if init.IsClrBase {
            return this.getCtorReferenceForType(
                Invariant.Required(
                    init.ClrConstructor,
                    "a CLR base initializer has a CLR constructor",
                    expression: "init.ClrConstructor"
                ),
                classSym.ImportedBaseType
            )
        }
        let gsharpBase StructSymbol? = init.GSharpBaseType
        // Issue #1254: when the base is a CONSTRUCTED generic user class, the
        // base ctor's MethodDef is keyed by the open definition and a bare token
        // is invalid for a generic type. Emit a MemberRef parented at the
        // constructed base's TypeSpec for the selected ctor (primary or explicit
        // `init(...)`), mirroring the parameter-less #1055 path.
        // Issue #2337: a nested sibling base carrying only the enclosing
        // generic's reified TypeParameters (no own TypeArguments) requires the
        // same TypeSpec-parented MemberRef treatment.
        let constructedGenericBase StructSymbol? = if (
            classSym.BaseClass != nil && ReflectionMetadataEmitter.IsUserGenericTypeReference(classSym.BaseClass)
        ) {
            classSym.BaseClass
        } else {
            (
                if (gsharpBase != nil && ReflectionMetadataEmitter.IsUserGenericTypeReference(gsharpBase)) {
                    gsharpBase
                } else {
                    default(StructSymbol?)
                }
            )
        }
        if constructedGenericBase != nil {
            // GSharpConstructor is null when the initializer targets the base's
            // PRIMARY constructor rather than an explicit `init(...)` -- the same
            // case the `init.GSharpConstructor != null` test below handles. The
            // resolver takes null to mean exactly that.
            return this.resolveConstructedBaseExplicitCtorToken(constructedGenericBase, init.GSharpConstructor)
        }
        // Issue #1060: when the base initializer resolved to a specific explicit
        // `init(...)` constructor on the GSharp base class, target that exact
        // constructor's metadata handle (pre-registered for every non-SM class
        // before any body is emitted), not just the base's primary/first ctor.
        if init.GSharpConstructor != nil &&
            this
            .cache
            .ExplicitCtorHandles
            .TryGetValue(init.GSharpConstructor, out var explicitHandle) {
            return explicitHandle
        }
        if init
            .Arguments
            .Length > 0 &&
            gsharpBase != nil &&
            gsharpBase.HasPrimaryConstructor &&
            this
            .cache
            .ClassPrimaryCtorHandles
            .TryGetValue(gsharpBase, out var primaryHandle) {
            return primaryHandle
        }
        if gsharpBase != nil && this.cache.ClassCtorHandles.TryGetValue(gsharpBase, out var defaultHandle) {
            return defaultHandle
        }
        // Fall back to the conventional resolution (parameterless chain).
        return this.GetBaseCtorToken(classSym)
    }

    /// Emits `System.Runtime.CompilerServices.IsReadOnlyAttribute` on an inline struct TypeDef.
    /// @param typeHandle The inline struct TypeDef handle.
    private func EmitIsReadOnlyAttribute(typeHandle TypeDefinitionHandle) {
        let ctorRef = this.wellKnown.GetIsReadOnlyAttributeCtorRef()
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: typeHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// Issue #367: emits the metadata that marks a user-declared `ref struct`
    /// TypeDef as by-ref-like, plus the legacy `Obsolete` attribute that
    /// instructs downstream C# compilers without ref-struct awareness to emit
    /// an error if such a struct is consumed as a normal value type.
    private func EmitNativeProtocolFeature(typeHandle EntityHandle, featureName string? = nil) {
        let constructor = typeof(System.Runtime.CompilerServices.CompilerFeatureRequiredAttribute).GetConstructor(
            []Type{typeof(string)}
        )!!
        let blob = BlobBuilder()
        blob.WriteUInt16(0x0001)
        blob.WriteSerializedString(featureName ?? NativeProtocolMetadata.FeatureName)
        blob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            typeHandle,
            this.getCtorReference(constructor),
            this.emitCtx.Metadata.GetOrAddBlob(blob)
        )
    }

    private func EmitIsByRefLikeAttribute(typeHandle TypeDefinitionHandle) {
        let ctorRef = this.wellKnown.GetIsByRefLikeAttributeCtorRef()
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: typeHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
        let obsoleteCtorRef = this.wellKnown.GetObsoleteAttributeStringBoolCtorRef()
        let obsoleteBlob = BlobBuilder()
        obsoleteBlob.WriteUInt16(0x0001)
        obsoleteBlob.WriteSerializedString(
            "Types with embedded references are not supported in this version of your compiler."
        )
        obsoleteBlob.WriteByte(1)
        obsoleteBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: typeHandle,
            constructor: obsoleteCtorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(obsoleteBlob)
        )
    }

    /// ADR-0122 §10 / issue #1035: emits the `[CompilerGenerated]` and
    /// `[UnsafeValueType]` attributes on a fixed-size buffer backing
    /// struct's TypeDef.
    /// @param typeHandle The backing struct's TypeDef handle.
    private func EmitFixedBufferBackingAttributes(typeHandle TypeDefinitionHandle) {
        let emptyBlob = BlobBuilder()
        emptyBlob.WriteUInt16(0x0001)
        emptyBlob.WriteUInt16(0)
        let emptyValue = this.emitCtx.Metadata.GetOrAddBlob(emptyBlob)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: typeHandle,
            constructor: this.wellKnown.GetCompilerGeneratedAttributeCtorRef(),
            value: emptyValue
        )
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: typeHandle,
            constructor: this.wellKnown.GetUnsafeValueTypeAttributeCtorRef(),
            value: emptyValue
        )
    }

    /// ADR-0122 §10 / issue #1035: emits the
    /// `[FixedBuffer(typeof(T), N)]` attribute on a fixed-size buffer
    /// field's FieldDef.
    /// @param fieldHandle The fixed-buffer field's FieldDef handle.
    /// @param field The fixed-size buffer field symbol.
    private func EmitFixedBufferFieldAttribute(fieldHandle FieldDefinitionHandle, field FieldSymbol) {
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        if field.FixedBufferElementType is not{} elementType {
            throw InvalidOperationException("Fixed-buffer field is missing its element type.")
        }
        valueBlob.WriteSerializedString(elementType.ClrType?.FullName ?? elementType.Name)
        valueBlob.WriteInt32(field.FixedBufferLength)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: fieldHandle,
            constructor: this.wellKnown.GetFixedBufferAttributeCtorRef(),
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    shared {
        private func ValidateStructTypeDefinition(structSym StructSymbol) {
            // Phase 4 emit parity (F2, type-erased): generic type definitions
            // are emitted as ordinary non-generic CLR classes/structs. Each
            // T-typed field is encoded as System.Object via EncodeTypeSymbol;
            // constructed instances (Box[int], Box[string]) share the same CLR
            // TypeDef as the definition and round-trip values through box /
            // unbox.any at field-access and primary-ctor boundaries. Constructed
            // StructSymbols are aliased into the lookup dictionaries by
            // RegisterConstructedTypeAliases after the definition's TypeDef and
            // members are emitted.
            if !structSym.TypeArguments.IsDefaultOrEmpty {
                throw NotSupportedException(
                    "Internal error: a constructed StructSymbol ('${structSym.Name}') reached EmitStructTypeDef. Only definitions should be in program.Structs."
                )
            }
        }

        private func EnsureStructFirstField(firstFieldRow int32, ref firstField FieldDefinitionHandle) {
            if firstField.IsNil {
                // Empty struct: no field rows added; point at next row, which is
                // (firstFieldRow) — same as the next TypeDef's first field row.
                firstField = MetadataTokens.FieldDefinitionHandle(firstFieldRow)
            }
        }

        /// Issue #4234: true when any of [`structSym`](paramref)'s static
        /// methods is an `@ExtensionOwner`-routed extension function (see
        /// DeclarationBinder.Functions.cs) rather than an ordinary shared-block
        /// static method.
        /// @param structSym The class or struct to check.
        /// @returns `true` when it hosts at least one such extension function.
        internal func HostsExtensionMethod(structSym StructSymbol) bool {
            for method in structSym.StaticMethods {
                if method.IsExtension && !method.IsInstanceMethod {
                    return true
                }
            }
            return false
        }

        private func SuppressBeforeFieldInitForStruct(structSym StructSymbol, typeAttrs TypeAttributes) TypeAttributes {
            var typeAttrs = typeAttrs
            // ADR-0140 / issue #2131: a type with a `shared { init { … } }`
            // static-initializer block has an explicit `.cctor` body, so — like C#
            // when a static constructor is declared — it must NOT be
            // `beforefieldinit` (which would let the runtime run the type
            // initializer at an unspecified time before first field access).
            // Issue #3203 confirmed this contract as the language semantics:
            // explicit init blocks get C# static-constructor timing, while types
            // with only shared FIELD initializers keep `beforefieldinit`, exactly
            // like C# types with only static field initializers.
            if structSym.HasStaticInitializerBlock {
                typeAttrs &= ~TypeAttributes.BeforeFieldInit
            }
            return typeAttrs
        }

        /// Issue #1610: encodes one method-signature parameter with its
        /// (cref:RefKind). A `ref`/`out`/`in` parameter is
        /// encoded as a managed pointer (`T&`); an `in` parameter
        /// additionally carries a
        /// `modreq(System.Runtime.CompilerServices.IsReadOnlyAttribute)` so
        /// consumers (e.g. C#) treat the call site as readonly (ADR-0060).
        /// This is the single canonical encoding shared by every user-method
        /// signature path — class/struct MethodDefs
        /// (`ReflectionMetadataEmitter.EmitFunction`), interface abstract and
        /// static-virtual slots, delegate `Invoke` MethodDefs and MemberRefs,
        /// and explicit constructors — so definitions and call-site references
        /// can never drift apart again.
        /// @param ps The signature's parameters encoder.
        /// @param parameter The parameter symbol to encode.
        /// @param encodeTypeSymbol The shared type-symbol encoder.
        /// @param wellKnown Well-known references used to resolve the `IsReadOnlyAttribute` modreq.
        internal func EncodeParameterSignature(
            ps ParametersEncoder,
            parameter ParameterSymbol,
            encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void,
            wellKnown WellKnownReferences
        ) {
            let paramEncoder = ps.AddParameter()
            if parameter.RefKind == RefKind.In {
                let isReadOnlyAttrType = wellKnown.GetIsReadOnlyAttributeTypeRef()
                if !isReadOnlyAttrType.IsNil {
                    paramEncoder.CustomModifiers().AddModifier(isReadOnlyAttrType, isOptional: false)
                }
            }
            encodeTypeSymbol(paramEncoder.Type(isByRef: parameter.RefKind != RefKind.None), parameter.Type)
        }

        // Constructor emission
        /// Whether the class head declares an EMPTY primary constructor (`class C()`).
        /// (cref:StructSymbol.HasPrimaryConstructor) follows the parameter array, so it
        /// is false for `()`, and the parameterless constructor gsc emits for such a
        /// class IS the declared primary constructor, which stays public. ADR-0195's family
        /// constructor is for the implicit one.
        private func HasEmptyPrimaryConstructor(classSym StructSymbol) bool -> !classSym.HasPrimaryConstructor &&
            (classSym.Declaration?.HasPrimaryConstructor ?? false)

        private func IsExplicitlyAbstract(classSym StructSymbol) bool -> classSym.IsDeclaredAbstract ||
            classSym
            .Definition
            ?.IsDeclaredAbstract == true

        /// ADR-0087 §3 R1: emits one `GenericParam` row per supplied
        /// type parameter, in source order, owned by [`owner`](paramref)
        /// (which may be a (cref:TypeDefinitionHandle) for a generic
        /// type or a (cref:MethodDefinitionHandle) for a generic method).
        /// @param emitCtx The emit context whose pending-generic-parameter buffer the rows are queued into.
        /// @param owner The owning TypeDef or MethodDef handle.
        /// @param typeParameters The type parameters to emit.
        /// @remarks The rows are queued — not added inline — because ECMA-335 II.22.20 requires
        /// the `GenericParam` table sorted by (Owner, Number). Because TypeDefs
        /// and MethodDefs are emitted in interleaved visit orders, inline emission
        /// is guaranteed to violate the sort invariant on multi-generic samples.
        /// (cref:FlushPendingGenericParameters) sorts and adds them at the end.
        internal func EmitGenericParamRows(
            emitCtx EmitContext,
            owner EntityHandle,
            typeParameters ImmutableArray[TypeParameterSymbol]
        ) {
            if typeParameters.IsDefaultOrEmpty {
                return
            }
            for var i = 0; i < typeParameters.Length; i++ {
                let tp = typeParameters[i]
                var attrs = GenericParameterAttributes.None
                if tp.Variance == TypeParameterVariance.In {
                    attrs |= GenericParameterAttributes.Contravariant
                } else if tp.Variance == TypeParameterVariance.Out {
                    attrs |= GenericParameterAttributes.Covariant
                }
                // ADR-0097 / issue #775: project G# `class` / `struct` / `new()`
                // constraints onto the matching CLR GenericParam flag bits.
                // ECMA-335 II.10.1.7 mandates that the value-type constraint
                // implies the default-constructor constraint — the emitter
                // forces both bits whenever `struct` is set.
                if tp.HasReferenceTypeConstraint {
                    attrs |= GenericParameterAttributes.ReferenceTypeConstraint
                }
                if tp.HasValueTypeConstraint {
                    attrs |= GenericParameterAttributes.NotNullableValueTypeConstraint
                    attrs |= GenericParameterAttributes.DefaultConstructorConstraint
                } else if tp.HasDefaultConstructorConstraint {
                    attrs |= GenericParameterAttributes.DefaultConstructorConstraint
                }
                // Issue #943 / #1052 / #1056: the bound may be an imported CLR
                // interface, a user-declared G# interface (sealed or not), or a
                // base-class constraint (issue #1056). Either way a
                // GenericParamConstraint metadata row is emitted (when present) so
                // the produced assembly verifies and member dispatch through the
                // bound is sound.
                emitCtx.PendingGenericParameters.Add(
                    PendingGenericParameter(
                        Owner: owner,
                        Attributes: attrs,
                        Name: tp.Name,
                        Index: uint16(i),
                        InterfaceConstraintType: tp.ConstraintReferenceType,
                        HasUnmanagedConstraint: tp.HasUnmanagedConstraint
                    )
                )
            }
        }

        /// ADR-0087 §3 R1: flushes deferred `GenericParam` rows in
        /// (Owner-coded-index, Number) order. The TypeOrMethodDef coded index
        /// uses bit 0 as tag (0=TypeDef, 1=MethodDef); the upper bits are the row id.
        /// @param emitCtx The emit context whose pending rows are flushed.
        /// @param resolveConstraintHandle Issue #943: resolves an interface-constraint (cref:TypeSymbol) to its
        /// `TypeDefOrRefOrSpec` handle for the matching `GenericParamConstraint`
        /// row. Supplied by the emitter (its `GetElementTypeToken`).
        /// @param resolveUnmanagedConstraintHandle Issue #1336: builds the `TypeSpec` handle for the
        /// `unmanaged`
        /// constraint's modreq-decorated `System.ValueType`
        /// `GenericParamConstraint`. Supplied by the emitter.
        internal func FlushPendingGenericParameters(
            emitCtx EmitContext,
            resolveConstraintHandle(TypeSymbol) -> EntityHandle,
            resolveUnmanagedConstraintHandle() -> EntityHandle
        ) {
            let pending = emitCtx.PendingGenericParameters
            if pending.Count == 0 {
                return
            }
            pending.Sort(
                (a PendingGenericParameter, b PendingGenericParameter) -> {
                    let ka = EncodeTypeOrMethodDefCodedIndex(a.Owner)
                    let kb = EncodeTypeOrMethodDefCodedIndex(b.Owner)
                    if ka != kb {
                        return ka.CompareTo(kb)
                    }
                    return a.Index.CompareTo(b.Index)
                }
            )
            let metadata = emitCtx.Metadata
            for var i = 0; i < pending.Count; i++ {
                let row = pending[i]
                let gpHandle = metadata.AddGenericParameter(
                    parent: row.Owner,
                    attributes: row.Attributes,
                    name: metadata.GetOrAddString(row.Name),
                    index: row.Index
                )
                // Issue #943: emit the GenericParamConstraint row for an
                // interface-constrained parameter so the produced metadata is
                // verifiable and the `constrained.` dispatch is sound. Rows are
                // added in ascending GenericParam-handle order (the pending list is
                // already sorted by owner/index), satisfying the ECMA-335 II.22.21
                // sort-by-Owner requirement.
                if row.InterfaceConstraintType != nil {
                    metadata.AddGenericParameterConstraint(
                        gpHandle,
                        row.PreResolvedConstraintHandle ?? resolveConstraintHandle(row.InterfaceConstraintType)
                    )
                }
                // Issue #1336: emit the `unmanaged` constraint as a
                // GenericParamConstraint to `System.ValueType` carrying a required
                // custom modifier (`modreq`) of
                // `System.Runtime.InteropServices.UnmanagedType` — the exact
                // metadata shape C# emits for `where T : unmanaged`. This is what
                // makes a pointer to the type parameter (`*T`) and `sizeof(T)` over
                // it verifiable. A parameter may carry BOTH an interface constraint
                // and the unmanaged constraint (e.g. `[T IComparable[T] unmanaged]`),
                // producing two constraint rows for the same owner; both share the
                // same gpHandle so the table stays sorted by Owner.
                if row.HasUnmanagedConstraint {
                    metadata.AddGenericParameterConstraint(gpHandle, resolveUnmanagedConstraintHandle())
                }
            }
            pending.Clear()
        }

        private func EncodeTypeOrMethodDefCodedIndex(owner EntityHandle) int32 {
            // ECMA-335 II.24.2.6: TypeOrMethodDef coded index uses tag bit 0.
            // TypeDef tag = 0, MethodDef tag = 1.
            let rowId = MetadataTokens.GetRowNumber(owner)
            let tag = if owner.Kind == HandleKind.TypeDefinition {
                0
            } else {
                1
            }
            return (rowId << 1) | tag
        }

        /// ADR-0087 §3 R1: per ECMA-335 II.10.3.1 a generic TypeDef's name carries
        /// the backtick-arity suffix so reflection round-trips `Box` as
        /// `Box`1`. Non-generic types keep their bare name.
        /// @param name The unmangled symbol name (e.g. `Box`).
        /// @param typeParameters The type parameters declared on the type.
        /// @returns The mangled metadata name (e.g.
        /// `Box`1`) or [`name`](paramref) when the type is non-generic.
        internal func MangleGenericName(name string, typeParameters ImmutableArray[TypeParameterSymbol]) string {
            if typeParameters.IsDefaultOrEmpty {
                return name
            }
            return name + "`" + typeParameters.Length.ToString(CultureInfo.InvariantCulture)
        }

        /// ADR-0093 §5: resolves the (cref:TypeAttributes) layout flag
        /// for a user struct. Defaults to (cref:TypeAttributes.SequentialLayout)
        /// when no `@StructLayout(LayoutKind.…)` annotation is present —
        /// the historical struct layout. When the annotation requests
        /// (cref:System.Runtime.InteropServices.LayoutKind.Explicit),
        /// the emitter writes the matching (cref:TypeAttributes.ExplicitLayout)
        /// flag instead so the runtime honours the per-field
        /// (cref:MetadataBuilder.AddFieldLayout) rows.
        /// @param structSym The struct symbol being emitted.
        /// @returns The chosen layout flag.
        internal func ResolveStructLayoutFlag(structSym StructSymbol) TypeAttributes {
            let meta StructLayoutMetadata? = structSym.LayoutMetadata
            if meta == nil {
                return TypeAttributes.SequentialLayout
            }
            return switch meta.Layout {
                case LayoutKind.Explicit: TypeAttributes.ExplicitLayout
                case LayoutKind.Auto: TypeAttributes.AutoLayout
                default: TypeAttributes.SequentialLayout
            }
        }

        /// ADR-0093 §5: resolves the (cref:TypeAttributes) layout flag
        /// for a user class. Defaults to (cref:TypeAttributes.AutoLayout)
        /// when no `@StructLayout(LayoutKind.…)` annotation is present —
        /// the historical class layout and the C# default. When the annotation
        /// is supplied, the chosen layout flag matches the requested
        /// (cref:System.Runtime.InteropServices.LayoutKind) so the class
        /// can participate in P/Invoke as a by-reference parameter.
        /// @param structSym The class symbol being emitted.
        /// @returns The chosen layout flag.
        internal func ResolveClassLayoutFlag(structSym StructSymbol) TypeAttributes {
            let meta StructLayoutMetadata? = structSym.LayoutMetadata
            if meta == nil {
                return TypeAttributes.AutoLayout
            }
            return switch meta.Layout {
                case LayoutKind.Explicit: TypeAttributes.ExplicitLayout
                case LayoutKind.Sequential: TypeAttributes.SequentialLayout
                default: TypeAttributes.AutoLayout
            }
        }

        /// ADR-0093 §5: writes the optional ClassLayout row for a type that
        /// carries an explicit `Pack` or `Size` on its
        /// `@StructLayout(LayoutKind.…)` annotation. A null
        /// [`metadata`](paramref) or one with both fields unset produces
        /// no ClassLayout row — the runtime defaults apply.
        /// @param emitCtx The current emit context.
        /// @param typeDefHandle The TypeDef handle the layout applies to.
        /// @param metadata The resolved layout metadata, or `null`.
        internal func EmitClassLayout(
            emitCtx EmitContext,
            typeDefHandle TypeDefinitionHandle,
            metadata StructLayoutMetadata?
        ) {
            if metadata == nil {
                return
            }
            if !(metadata.Pack != nil) && !(metadata.Size != nil) {
                return
            }
            emitCtx.Metadata.AddTypeLayout(
                type: typeDefHandle,
                packingSize: uint16((metadata.Pack ?? 0)),
                size: uint32((metadata.Size ?? 0))
            )
        }
    }
}
