// <copyright file="MemberDefEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// IL emission for property and event accessor MethodDefs, plus the
/// PropertyDef/EventDef/PropertyMap/EventMap/MethodSemantics rows that
/// link them to their owning TypeDef. Covers instance, static, and
/// interface variants for both properties and events.
/// @remarks PR-E-7 introduces this component. Per the decomposition plan, every
/// method moved here was a top-level `private` on
/// (cref:ReflectionMetadataEmitter) (none lived inside the nested
/// `BodyEmitter`), so this extraction is a clean Option-A move with
/// no BodyEmitter seam issues like PR-E-5 had with the conversion
/// methods. The methods moved are:
///
/// - `EmitPropertyAccessors` / `EmitPropertyGetter` / `EmitPropertySetter`
/// - `EmitStaticPropertyAccessors` / `EmitStaticPropertyGetter` / `EmitStaticPropertySetter`
/// - `EmitEventAccessors` / `EmitEventAddAccessor` / `EmitEventRemoveAccessor` /
/// `EmitEventRaiseAccessor`
/// - `EmitStaticEventAccessors` / `EmitStaticEventAddAccessor` / `EmitStaticEventRemoveAccessor`
/// - `EmitInterfacePropertyAccessors` / `EmitInterfacePropertyGetter` / `EmitInterfacePropertySetter` /
/// `EmitInterfaceEventAccessors`
///
/// Plus four private helpers used exclusively by the methods above:
///
/// - `PropertyImplicitlyImplementsInterface` — virtual-slot promotion check for issue #248 / #525
/// - `EventImplicitlyImplementsInterface` — same, for ADR-0052 event accessors
/// - `GetEventTypeHandle` — resolves the EntityHandle for an event handler type
/// - `GetInterlockedCompareExchangeSpec` — MethodSpec for the CAS loop in field-like add/remove (issue
/// #256)
///
/// Like every other PR-E-* component, `MemberDefEmitter` is
/// `internal sealed` and constructor-injected. It receives the same
/// (cref:EmitContext), (cref:MetadataTokenCache), and
/// (cref:WellKnownReferences) as its peers, plus delegate
/// callbacks bound to the remaining (cref:ReflectionMetadataEmitter)
/// helpers it depends on (`EmitFunction`, `EncodeTypeSymbol`,
/// `NextParameterHandle`, `GetTypeReference`,
/// `GetTypeHandleForMember`). The callbacks mirror the pattern
/// PR-E-4 (cref:SlotPlanner), PR-E-5 (cref:ConversionEmitter),
/// and PR-E-6 (cref:DataStructSynthesizer) established to avoid
/// hard back-references to the root emitter.
///
/// The shared (cref:MetadataTokenCache.PropertyAccessorHandles),
/// (cref:MetadataTokenCache.EventAccessorHandles), and
/// (cref:MetadataTokenCache.TypesWithPropertyMap) collections stay
/// on the cache, not on this component, so future consumers (e.g.
/// TypeDefEmitter in PR-E-8) can keep reading them without needing a
/// reference to `MemberDefEmitter`.
internal class MemberDefEmitter {
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let wellKnown WellKnownReferences
    private let emitFunction(FunctionSymbol, BoundBlockStatement, bool) -> MethodDefinitionHandle
    private let encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void
    private let nextParameterHandle() -> ParameterHandle
    private let getTypeReference(Type) -> TypeReferenceHandle
    private let getTypeHandleForMember(Type) -> EntityHandle
    private let resolveFieldToken(StructSymbol, FieldSymbol) -> EntityHandle
    private let emitNullableAttributeOnProperty(PropertyDefinitionHandle, TypeSymbol) -> void
    private let emitNullableAttributeOnEvent(EventDefinitionHandle, TypeSymbol) -> void
    private let emitMethodNullability(
        MethodDefinitionHandle,
        MethodNullabilityPlan,
        ParameterHandle?,
        ImmutableArray[ParameterHandle]
    ) -> void
    private let emitTupleElementNamesAttribute(EntityHandle, TypeSymbol) -> void
    private let emitUserAttributes(EntityHandle, Symbol, AttributeTargetKind) -> void
    private let emitNativeProtocolFeature(EntityHandle) -> void

    init(
        emitCtx EmitContext,
        cache MetadataTokenCache,
        wellKnown WellKnownReferences,
        emitFunction(FunctionSymbol, BoundBlockStatement, bool) -> MethodDefinitionHandle,
        encodeTypeSymbol(SignatureTypeEncoder, TypeSymbol) -> void,
        nextParameterHandle() -> ParameterHandle,
        getTypeReference(Type) -> TypeReferenceHandle,
        getTypeHandleForMember(Type) -> EntityHandle,
        resolveFieldToken(StructSymbol, FieldSymbol) -> EntityHandle,
        emitNullableAttributeOnProperty(PropertyDefinitionHandle, TypeSymbol) -> void,
        emitNullableAttributeOnEvent(EventDefinitionHandle, TypeSymbol) -> void,
        emitMethodNullability(
            MethodDefinitionHandle,
            MethodNullabilityPlan,
            ParameterHandle?,
            ImmutableArray[ParameterHandle]
        ) -> void,
        emitTupleElementNamesAttribute(EntityHandle, TypeSymbol) -> void,
        emitUserAttributes(EntityHandle, Symbol, AttributeTargetKind) -> void,
        emitNativeProtocolFeature(EntityHandle) -> void
    ) {
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.cache = cache ?? throw ArgumentNullException("cache")
        this.wellKnown = wellKnown ?? throw ArgumentNullException("wellKnown")
        this.emitFunction = emitFunction ?? throw ArgumentNullException("emitFunction")
        this.encodeTypeSymbol = encodeTypeSymbol ?? throw ArgumentNullException("encodeTypeSymbol")
        this.nextParameterHandle = nextParameterHandle ?? throw ArgumentNullException("nextParameterHandle")
        this.getTypeReference = getTypeReference ?? throw ArgumentNullException("getTypeReference")
        this.getTypeHandleForMember = getTypeHandleForMember ?? throw ArgumentNullException("getTypeHandleForMember")
        this.resolveFieldToken = resolveFieldToken ?? throw ArgumentNullException("resolveFieldToken")
        this.emitNullableAttributeOnProperty = emitNullableAttributeOnProperty ??
            throw ArgumentNullException("emitNullableAttributeOnProperty")
        this.emitNullableAttributeOnEvent = emitNullableAttributeOnEvent ??
            throw ArgumentNullException("emitNullableAttributeOnEvent")
        this.emitMethodNullability = emitMethodNullability ?? throw ArgumentNullException("emitMethodNullability")
        this.emitTupleElementNamesAttribute = emitTupleElementNamesAttribute ??
            throw ArgumentNullException("emitTupleElementNamesAttribute")
        this.emitUserAttributes = emitUserAttributes ?? throw ArgumentNullException("emitUserAttributes")
        this.emitNativeProtocolFeature = emitNativeProtocolFeature ??
            throw ArgumentNullException("emitNativeProtocolFeature")
    }

    func EmitPropertyAccessors(structSym StructSymbol) {
        if structSym.Properties.IsDefaultOrEmpty {
            return
        }
        if !this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle) {
            return
        }
        var firstPropDef = default(PropertyDefinitionHandle)
        for prop in structSym.Properties {
            if !this.cache.PropertyAccessorHandles.TryGetValue(prop, out var accessorHandles) {
                continue
            }
            // Emit getter MethodDef.
            var emittedGetter MethodDefinitionHandle? = nil
            if prop.HasGetter && (accessorHandles.Getter != nil) {
                emittedGetter = this.EmitPropertyGetter(structSym, prop)
            }
            // Emit setter MethodDef.
            var emittedSetter MethodDefinitionHandle? = nil
            if prop.HasSetter && (accessorHandles.Setter != nil) {
                emittedSetter = this.EmitPropertySetter(structSym, prop)
            }
            // Emit PropertyDef row.
            let propertySignature = BlobBuilder()
            if prop.IsIndexer && !prop.Parameters.IsDefaultOrEmpty {
                // ADR-0118 / issue #944: a CLR default indexer property carries
                // its index parameter types in the PropertyDef signature.
                let indexParams = prop.Parameters
                BlobEncoder(propertySignature).PropertySignature(isInstanceProperty: true).Parameters(
                    indexParams.Length,
                    (returnType ReturnTypeEncoder) -> this.EncodePropertyType(returnType, prop),
                    (parameters ParametersEncoder) -> {
                        for indexParam in indexParams {
                            this.encodeTypeSymbol(parameters.AddParameter().Type(), indexParam.Type)
                        }
                    }
                )
            } else {
                BlobEncoder(propertySignature).PropertySignature(isInstanceProperty: true).Parameters(
                    0,
                    (returnType ReturnTypeEncoder) -> this.EncodePropertyType(returnType, prop),
                    (parameters ParametersEncoder) -> { }
                )
            }
            let propDef = this
                .emitCtx
                .Metadata
                .AddProperty(
                attributes: PropertyAttributes.None,
                name: this
                    .emitCtx
                    .Metadata
                    .GetOrAddString(
                    if prop.HasExplicitInterfaceClause {
                        ExplicitInterfaceMetadataNaming.GetMetadataName(
                            prop.Name,
                            Invariant.Required(
                                prop.ExplicitInterfaceClauseTarget,
                                "an explicit property implementation has a target",
                                expression: "prop.ExplicitInterfaceClauseTarget"
                            )
                        )
                    } else {
                        prop.Name
                    }
                ),
                signature: this.emitCtx.Metadata.GetOrAddBlob(propertySignature)
            )
            if firstPropDef.IsNil {
                firstPropDef = propDef
            }
            // MethodSemantics rows linking accessor MethodDefs to the PropertyDef.
            if (emittedGetter != nil) {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Getter, emittedGetter)
            }
            if (emittedSetter != nil) {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Setter, emittedSetter)
            }
            this.emitNullableAttributeOnProperty(propDef, prop.Type)
            this.EmitReadOnlyRefAttribute(propDef, prop)
            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the PropertyDef (parity with the class/interface member path).
            this.emitUserAttributes(propDef, prop, AttributeTargetKind.Property)
        }
        // PropertyMap row: links the TypeDef to its first PropertyDef.
        if !firstPropDef.IsNil {
            this.emitCtx.Metadata.AddPropertyMap(typeDefHandle, firstPropDef)
            this.cache.TypesWithPropertyMap.Add(typeDefHandle)
        }
    }

    /// Issue #3879 (ADR-0060 amendment): encodes a property's type into the
    /// return-type slot of a PropertyDef or accessor MethodDef signature,
    /// honouring the property's (cref:PropertySymbol.ReturnRefKind).
    /// A `ref`-returning property is `T&` in BOTH signatures —
    /// ECMA-335 §II.23.2.5 allows `ELEMENT_TYPE_BYREF` in a PropertySig,
    /// and the two have to agree. Encoding only the getter does not merely cost
    /// the alias: measured, Roslyn refuses the member outright with CS1546
    /// ("Property, indexer, or event 'Holder.Property' is not supported by the
    /// language; try directly calling accessor method 'Holder.get_Property()'").
    ///
    /// This is the single funnel for every property-signature return slot
    /// (instance, static, interface, indexer, and the metadata-only fallback),
    /// so the implementation assembly and the reference assembly cannot
    /// disagree about a property's ref-kind.
    /// @param encoder The signature's return-type encoder.
    /// @param prop The property whose type is encoded.
    private func EncodePropertyType(encoder ReturnTypeEncoder, prop PropertySymbol) {
        if prop.ReturnRefKind == RefKind.RefReadOnly {
            encoder.CustomModifiers().AddModifier(this.wellKnown.GetInAttributeTypeRef(), isOptional: false)
        }
        this.encodeTypeSymbol(encoder.Type(isByRef: prop.ReturnRefKind != RefKind.None), prop.Type)
    }

    private func EmitReadOnlyRefAttribute(handle EntityHandle, property PropertySymbol) {
        if property.ReturnRefKind != RefKind.RefReadOnly {
            return
        }
        let value = BlobBuilder()
        value.WriteUInt16(1)
        value.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            handle,
            this.wellKnown.GetIsReadOnlyAttributeCtorRef(),
            this.emitCtx.Metadata.GetOrAddBlob(value)
        )
    }

    /// Issue #4988: mints an accessor MethodDef's `Param` rows — the
    /// sequence-0 return row when the signature needs one, then one row per
    /// parameter — and plans the signature's nullability. Every accessor that
    /// does not go through `EmitFunction` (auto-properties, field-like events,
    /// interface and abstract slots, the metadata-only fallbacks) mints its rows
    /// here, so its signature carries exactly the annotations a bodied accessor's
    /// would. Call it immediately before `AddMethodDefinition` and pass the
    /// result to (cref:StampAccessor) afterwards.
    /// @param returnType The accessor's return type (`void` for setters and event accessors).
    /// @param readOnlyRefProperty The property whose `ref readonly` return the row marks, if any.
    /// @param parameters The accessor's parameters: index parameters, then any `value`.
    /// @returns The rows and their plan.
    private func AddAccessorRows(
        returnType TypeSymbol,
        readOnlyRefProperty PropertySymbol?,
        parameters ImmutableArray[ParameterSymbol]
    ) SignatureRows {
        let rows = ParameterMetadataEmitter.AddSignatureRows(
            this.emitCtx,
            returnType,
            readOnlyRefProperty?.ReturnRefKind ?? RefKind.None,
            parameters
        )
        if rows.ReturnRow is {} returnRow && readOnlyRefProperty != nil {
            this.EmitReadOnlyRefAttribute(returnRow, readOnlyRefProperty)
        }
        return rows
    }

    /// Issue #4988: stamps the rows (cref:AddAccessorRows) minted once the
    /// accessor's MethodDef exists: parameter annotations, the planned
    /// nullability, and tuple element names.
    /// @param handle The accessor's MethodDef.
    /// @param rows The rows minted for it.
    private func StampAccessor(handle MethodDefinitionHandle, rows SignatureRows, owner FunctionSymbol?) {
        for var i = 0; i < rows.Rows.Length; i++ {
            this.emitUserAttributes(rows.Rows[i], rows.Parameters[i], AttributeTargetKind.Param)
        }
        this.emitMethodNullability(handle, rows.Nullability, rows.ReturnRow, rows.Rows)
        if rows.ReturnRow is {} returnRow {
            this.emitTupleElementNamesAttribute(returnRow, rows.ReturnType)
        }
        for var i = 0; i < rows.Rows.Length; i++ {
            this.emitTupleElementNamesAttribute(rows.Rows[i], rows.Parameters[i].Type)
        }
        if if owner != nil {
            NativeProtocolSafety.RequiresFeatureMarker(owner)
        } else {
            NativeProtocolSafety.RequiresFeatureMarker(rows.ReturnType, rows.Parameters)
        } {
            this.emitNativeProtocolFeature(handle)
        }
    }

    /// The `value` parameter a property setter takes after its index parameters.
    private func SetterParameters(prop PropertySymbol) ImmutableArray[ParameterSymbol] {
        let parameters = ImmutableArray.CreateBuilder[ParameterSymbol]()
        if !prop.Parameters.IsDefaultOrEmpty {
            parameters.AddRange(prop.Parameters)
        }
        parameters.Add(ParameterSymbol(prop.SetterParameterName ?? "value", prop.Type))
        return parameters.ToImmutable()
    }

    /// A property getter's parameters: its index parameters, if any.
    private func GetterParameters(prop PropertySymbol) ImmutableArray[ParameterSymbol] -> if prop
        .Parameters
        .IsDefaultOrEmpty {
        ImmutableArray[ParameterSymbol].Empty
    } else {
        prop.Parameters
    }

    /// An event `add`/`remove` accessor's single `value` parameter.
    private func EventAccessorParameters(ev EventSymbol) ImmutableArray[ParameterSymbol] -> ImmutableArray.Create(
        ParameterSymbol("value", ev.Type)
    )

    /// A `raise` accessor's parameters: the handler delegate's, named `arg0`...
    private func RaiseParameters(raiseShape FunctionTypeSymbol?) ImmutableArray[ParameterSymbol] {
        if raiseShape == nil {
            return ImmutableArray[ParameterSymbol].Empty
        }
        let parameters = ImmutableArray.CreateBuilder[ParameterSymbol](raiseShape.ParameterTypes.Length)
        for var i = 0; i < raiseShape.ParameterTypes.Length; i++ {
            parameters.Add(ParameterSymbol("arg$i", raiseShape.ParameterTypes[i]))
        }
        return parameters.MoveToImmutable()
    }

    /// Emits a property accessor's method body, shared by all four property
    /// accessor copies (instance/static × get/set). Returns a fully-emitted
    /// computed-accessor MethodDef when the accessor has a bound body (the
    /// caller returns it directly), otherwise a body offset for the
    /// auto-property or NotImplementedException fallback body. The issue #989
    /// self-TypeSpec backing-field token handling lives here in exactly one
    /// place so it can no longer drift between the copies.
    /// @param structSym The owning type whose accessor is emitted.
    /// @param prop The property whose accessor body is emitted.
    /// @param isStatic `true` for a static accessor.
    /// @param isGetter `true` for a getter, `false` for a setter.
    /// @returns A tuple: `Computed` is the handle of a fully-emitted computed
    /// accessor (return it directly) or `null`; `BodyOffset`
    /// is the method-body offset for the auto/fallback body, or `-1`.
    private func EmitPropertyAccessorBody(structSym StructSymbol, prop PropertySymbol, isStatic bool, isGetter bool)(
        Computed MethodDefinitionHandle?,
        BodyOffset int32
    ) {
        if this.emitCtx.MetadataOnly {
            return (nil, -1)
        }
        if prop.IsAutoProperty &&
            prop.BackingField != nil &&
            this
            .cache
            .StructFieldDefs
            .TryGetValue(prop.BackingField!!, out var backingHandle) {
            // Issue #989: inside a generic type's own accessor body the
            // backing-field token must be a self-TypeSpec MemberRef
            // (Box`1<!0>), not the bare FieldDef, or the verifier rejects
            // the receiver type on the stack.
            let backingToken = if ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym) {
                this.resolveFieldToken(structSym, prop.BackingField!!)
            } else {
                EntityHandle(backingHandle)
            }
            let il = InstructionEncoder(BlobBuilder())
            if isGetter {
                if !isStatic {
                    il.LoadArgument(0)
                }
                il.OpCode(
                    if isStatic {
                        ILOpCode.Ldsfld
                    } else {
                        ILOpCode.Ldfld
                    }
                )
            } else {
                if !isStatic {
                    il.LoadArgument(0)
                }
                il.LoadArgument(
                    if isStatic {
                        0
                    } else {
                        1
                    }
                )
                il.OpCode(
                    if isStatic {
                        ILOpCode.Stsfld
                    } else {
                        ILOpCode.Stfld
                    }
                )
            }
            il.Token(backingToken)
            il.OpCode(ILOpCode.Ret)
            return (nil, this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il)))
        }
        let accessorSymbol FunctionSymbol? = if isGetter {
            prop.GetterSymbol
        } else {
            prop.SetterSymbol
        }
        if accessorSymbol != nil && this.emitCtx.Program.Functions.TryGetValue(accessorSymbol, out var body) {
            // Computed property with bound body: emit using EmitFunction infrastructure.
            return (this.emitFunction(accessorSymbol, body, false), -1)
        }
        // Fallback: throw new NotImplementedException().
        let nieIl = InstructionEncoder(BlobBuilder())
        let nieCtor = this.wellKnown.GetNotImplementedExceptionCtor()
        nieIl.OpCode(ILOpCode.Newobj)
        nieIl.Token(nieCtor)
        nieIl.OpCode(ILOpCode.Throw)
        return (
            nil,
            this.emitCtx.MethodBodyStream.AddMethodBody(nieIl, maxStack: MaxStackTracker.ComputeMaxStack(nieIl))
        )
    }

    /// ADR-0051 Phase 6: emits a getter accessor MethodDef (get_PropertyName).
    /// For auto-properties: ldarg.0, ldfld backing, ret.
    /// For computed properties: emits the bound getter body IL.
    private func EmitPropertyGetter(structSym StructSymbol, prop PropertySymbol) MethodDefinitionHandle {
        if prop.IsAbstract && prop.GetterBodySyntax == nil {
            return this.EmitAbstractClassPropertyAccessor(prop, isGetter: true)
        }
        let (computed, bodyOffset) = this.EmitPropertyAccessorBody(structSym, prop, isStatic: false, isGetter: true)
        if (computed != nil) {
            return computed
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            if prop.Parameters.IsDefaultOrEmpty {
                0
            } else {
                prop.Parameters.Length
            },
            (r ReturnTypeEncoder) -> this.EncodePropertyType(r, prop),
            (ps ParametersEncoder) -> {
                // Issue #2832: an indexer's getter takes the index
                // parameters. A computed accessor normally reaches the
                // `EmitFunction` path above, which encodes them from the
                // accessor's FunctionSymbol — but under
                // `EmitContext.MetadataOnly` (reference-assembly emit) no
                // body is produced, so this fallback is what lands in the
                // ref assembly and must carry the same signature.
                if prop.Parameters.IsDefaultOrEmpty {
                    return
                }
                for indexParam in prop.Parameters {
                    this.encodeTypeSymbol(ps.AddParameter().Type(), indexParam.Type)
                }
            }
        )
        // ADR-0149: an explicit-interface qualifier clause property (whether
        // an auto-property, reaching this fallback path, or an indexer,
        // which always has a computed body and so never reaches this path)
        // is ALWAYS private in CLR metadata — see the matching remark on
        // ReflectionMetadataEmitter.EmitFunction's effectiveAccessibility.
        var methodAttrs = (
            if prop.HasExplicitInterfaceClause {
                MethodAttributes.Private
            } else {
                AccessibilityMap.ToMethodVisibility(prop.GetterAccessibility)
            }
        ) | MethodAttributes.SpecialName | MethodAttributes.HideBySig
        // Issue #2870: `IsVirtual` (declared `open`) and `IsOverride` are
        // INDEPENDENT — an `open override prop` is both — so the override test
        // has to come first. An override reuses the base virtual slot and must
        // NOT carry NewSlot, whether or not it is itself further overridable.
        // The implementation assembly happens to route computed-body accessors
        // through FunctionEmitter and got this right; this fallback path is
        // what a metadata-only (reference assembly) emit uses for every
        // property, so the two assemblies disagreed on the vtable layout and
        // consumers of the reference assembly saw the override as a fresh
        // virtual — which made the declaring type look abstract (GS0386).
        if prop.IsOverride {
            methodAttrs |= MethodAttributes.Virtual
            if MethodInfoHelpers.IsCovariantPropertyGetter(prop) {
                methodAttrs |= MethodAttributes.NewSlot
            }
        } else if prop.IsVirtual {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
        } else if PropertyImplicitlyImplementsInterface(structSym, prop) {
            // Issue #248: implicit interface implementation requires Virtual | NewSlot.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
        } else if this.emitCtx.InheritedInterfacePropertyAccessors.Contains((prop, true)) {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final
        } else if prop.ExplicitInterfaceMember != nil {
            // Issue #2362: a mangled-name explicit interface property
            // implementation is bound to its interface slot purely via an
            // explicit MethodImpl row (see
            // EmitExplicitInterfacePropertyMethodImpls).
            // PropertyImplicitlyImplementsInterface deliberately excludes explicit implementations.
            // Per ECMA-335 §II.10.3.3, a MethodImpl body method must be virtual;
            // Final prevents a derived class from overriding this synthetic accessor
            // by name (it has no natural override point, exactly like the
            // #2010 mangled explicit method convention's own methods, which
            // get Virtual | NewSlot | Final unconditionally via EmitFunction).
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final
        }
        // ADR-0149: a property declared with an explicit-interface qualifier
        // clause needs a collision-free metadata name for its getter, same
        // rationale as ExplicitInterfaceMetadataNaming's remarks (two
        // explicit implementations sharing a plain property name would
        // otherwise also share the identical "get_Name" accessor name).
        let getterName = if prop.HasExplicitInterfaceClause {
            "get_" + ExplicitInterfaceMetadataNaming.GetMetadataName(
                prop.Name,
                Invariant.Required(
                    prop.ExplicitInterfaceClauseTarget,
                    "an explicit property implementation has a target",
                    expression: "prop.ExplicitInterfaceClauseTarget"
                )
            )
        } else {
            "get_${prop.Name}"
        }
        let accessorRows = this.AddAccessorRows(prop.Type, prop, this.GetterParameters(prop))
        let accessor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(getterName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: accessorRows.First
        )
        this.StampAccessor(accessor, accessorRows, prop.GetterSymbol)
        return accessor
    }

    /// ADR-0051 Phase 6: emits a setter accessor MethodDef (set_PropertyName).
    /// For auto-properties: ldarg.0, ldarg.1, stfld backing, ret.
    /// For computed properties: emits the bound setter body IL.
    private func EmitPropertySetter(structSym StructSymbol, prop PropertySymbol) MethodDefinitionHandle {
        if prop.IsAbstract && prop.SetterBodySyntax == nil {
            return this.EmitAbstractClassPropertyAccessor(prop, isGetter: false)
        }
        let (computed, bodyOffset) = this.EmitPropertyAccessorBody(structSym, prop, isStatic: false, isGetter: false)
        if (computed != nil) {
            return computed
        }
        let sigBlob = BlobBuilder()
        let indexParameterCount = if prop.Parameters.IsDefaultOrEmpty {
            0
        } else {
            prop.Parameters.Length
        }
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            indexParameterCount + 1,
            (r ReturnTypeEncoder) -> {
                // Issue #946: an `init`-only setter encodes its void return
                // with modreq(System.Runtime.CompilerServices.IsExternalInit),
                // exactly as a C# 9 init-only setter does. This is how the
                // CLR and peer compilers recognize the accessor as init-only.
                if prop.IsInitOnly {
                    let isExternalInit = this.wellKnown.GetIsExternalInitTypeRef()
                    if !isExternalInit.IsNil {
                        r.CustomModifiers().AddModifier(isExternalInit, isOptional: false)
                    }
                }
                r.Void()
            },
            (ps ParametersEncoder) -> {
                // Issue #2832: see the matching comment in
                // EmitPropertyGetter — an indexer's setter takes the index
                // parameters ahead of the value parameter.
                if !prop.Parameters.IsDefaultOrEmpty {
                    for indexParam in prop.Parameters {
                        this.encodeTypeSymbol(ps.AddParameter().Type(), indexParam.Type)
                    }
                }
                this.encodeTypeSymbol(ps.AddParameter().Type(), prop.Type)
            }
        )
        // ADR-0149: see the matching visibility comment in EmitPropertyGetter
        // — an explicit-interface qualifier clause property is always
        // private in CLR metadata.
        var methodAttrs = (
            if prop.HasExplicitInterfaceClause {
                MethodAttributes.Private
            } else {
                AccessibilityMap.ToMethodVisibility(prop.SetterAccessibility)
            }
        ) | MethodAttributes.SpecialName | MethodAttributes.HideBySig
        // Issue #2870: see the matching comment in EmitPropertyGetter — the
        // override test must precede the virtual test, since an
        // `open override prop` is both.
        if prop.IsOverride {
            methodAttrs |= MethodAttributes.Virtual
        } else if prop.IsVirtual {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
        } else if PropertyImplicitlyImplementsInterface(structSym, prop) {
            // Issue #248: implicit interface implementation requires Virtual | NewSlot.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
        } else if this.emitCtx.InheritedInterfacePropertyAccessors.Contains((prop, false)) {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final
        } else if prop.ExplicitInterfaceMember != nil {
            // Issue #2362: see the matching comment in EmitPropertyGetter —
            // the setter half of a mangled-name explicit interface property
            // implementation needs the same Virtual | NewSlot | Final promotion
            // so its MethodImpl row (emitted separately) is ECMA-335-valid.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final
        }
        // Emit the Parameter rows: the index parameters, then "value", so the
        // setter has named parameters (issue #2832: for an indexer the value
        // parameter follows the index parameters).
        // ADR-0149: see the matching comment in EmitPropertyGetter.
        let setterName = if prop.HasExplicitInterfaceClause {
            "set_" + ExplicitInterfaceMetadataNaming.GetMetadataName(
                prop.Name,
                Invariant.Required(
                    prop.ExplicitInterfaceClauseTarget,
                    "an explicit property implementation has a target",
                    expression: "prop.ExplicitInterfaceClauseTarget"
                )
            )
        } else {
            "set_${prop.Name}"
        }
        let accessorRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.SetterParameters(prop))
        let accessor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(setterName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: accessorRows.First
        )
        this.StampAccessor(accessor, accessorRows, prop.SetterSymbol)
        return accessor
    }

    private func EmitAbstractClassPropertyAccessor(prop PropertySymbol, isGetter bool) MethodDefinitionHandle {
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            prop
                .Parameters
                .Length +
                (
                if isGetter {
                    0
                } else {
                    1
                }
            ),
            (r ReturnTypeEncoder) -> {
                if isGetter {
                    this.encodeTypeSymbol(r.Type(), prop.Type)
                } else {
                    if prop.IsInitOnly {
                        let isExternalInit = this.wellKnown.GetIsExternalInitTypeRef()
                        if !isExternalInit.IsNil {
                            r.CustomModifiers().AddModifier(isExternalInit, isOptional: false)
                        }
                    }
                    r.Void()
                }
            },
            (ps ParametersEncoder) -> {
                for indexParam in prop.Parameters {
                    this.encodeTypeSymbol(ps.AddParameter().Type(), indexParam.Type)
                }
                if !isGetter {
                    this.encodeTypeSymbol(ps.AddParameter().Type(), prop.Type)
                }
            }
        )
        let accessibility = if isGetter {
            prop.GetterAccessibility
        } else {
            prop.SetterAccessibility
        }
        var methodAttrs = AccessibilityMap.ToMethodVisibility(
            accessibility
        ) | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Virtual | MethodAttributes.Abstract
        if !prop.IsOverride || (isGetter && MethodInfoHelpers.IsCovariantPropertyGetter(prop)) {
            methodAttrs |= MethodAttributes.NewSlot
        }
        let accessorRows = if isGetter {
            this.AddAccessorRows(prop.Type, nil, this.GetterParameters(prop))
        } else {
            this.AddAccessorRows(TypeSymbol.Void, nil, this.SetterParameters(prop))
        }
        let accessor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("${(if isGetter { "get" } else { "set" })}_${prop.Name}"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: -1,
            parameterList: accessorRows.First
        )
        this.StampAccessor(
            accessor,
            accessorRows,
            if isGetter {
                prop.GetterSymbol
            } else {
                prop.SetterSymbol
            }
        )
        return accessor
    }

    /// Issue #263: emits accessor MethodDefs, PropertyDef rows, PropertyMap,
    /// and MethodSemantics rows for static properties declared in a shared block.
    /// @param structSym The owning struct or class symbol whose static properties are emitted.
    func EmitStaticPropertyAccessors(structSym StructSymbol) {
        if structSym.StaticProperties.IsDefaultOrEmpty {
            return
        }
        if !this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle) {
            return
        }
        var firstPropDef = default(PropertyDefinitionHandle)
        for prop in structSym.StaticProperties {
            if !this.cache.PropertyAccessorHandles.TryGetValue(prop, out var accessorHandles) {
                continue
            }
            // Emit getter MethodDef.
            var emittedGetter MethodDefinitionHandle? = nil
            if prop.HasGetter && (accessorHandles.Getter != nil) {
                emittedGetter = this.EmitStaticPropertyGetter(structSym, prop)
            }
            // Emit setter MethodDef.
            var emittedSetter MethodDefinitionHandle? = nil
            if prop.HasSetter && (accessorHandles.Setter != nil) {
                emittedSetter = this.EmitStaticPropertySetter(structSym, prop)
            }
            // Emit PropertyDef row.
            let propertySignature = BlobBuilder()
            BlobEncoder(propertySignature).PropertySignature(isInstanceProperty: false).Parameters(
                0,
                (returnType ReturnTypeEncoder) -> this.EncodePropertyType(returnType, prop),
                (parameters ParametersEncoder) -> { }
            )
            let propDef = this
                .emitCtx
                .Metadata
                .AddProperty(
                attributes: PropertyAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(prop.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(propertySignature)
            )
            if firstPropDef.IsNil {
                firstPropDef = propDef
            }
            // MethodSemantics rows linking accessor MethodDefs to the PropertyDef.
            if (emittedGetter != nil) {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Getter, emittedGetter)
            }
            if (emittedSetter != nil) {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Setter, emittedSetter)
            }
            this.emitNullableAttributeOnProperty(propDef, prop.Type)
            this.EmitReadOnlyRefAttribute(propDef, prop)
            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the PropertyDef (parity with the class/interface member path).
            this.emitUserAttributes(propDef, prop, AttributeTargetKind.Property)
        }
        // PropertyMap row: links the TypeDef to its first PropertyDef.
        // Issue #418 (P1-7): only add a PropertyMap here if the instance-property
        // emission path (EmitPropertyAccessors) didn't already add one. Using
        // structSym.Properties.IsDefaultOrEmpty was incorrect — instance properties
        // may be declared but all skipped during emission (e.g., computed property
        // whose getter symbol has no entry in program.Functions), leaving no
        // PropertyMap. Without this row the static PropertyDef rows would be
        // orphaned and violate ECMA-335 §II.22.35.
        if !firstPropDef.IsNil && !this.cache.TypesWithPropertyMap.Contains(typeDefHandle) {
            this.emitCtx.Metadata.AddPropertyMap(typeDefHandle, firstPropDef)
            this.cache.TypesWithPropertyMap.Add(typeDefHandle)
        }
    }

    /// Issue #263: emits a static getter accessor MethodDef (get_PropertyName).
    private func EmitStaticPropertyGetter(structSym StructSymbol, prop PropertySymbol) MethodDefinitionHandle {
        let (computed, bodyOffset) = this.EmitPropertyAccessorBody(structSym, prop, isStatic: true, isGetter: true)
        if (computed != nil) {
            return computed
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            0,
            (r ReturnTypeEncoder) -> this.EncodePropertyType(r, prop),
            (_ ParametersEncoder) -> { }
        )
        let methodAttrs = AccessibilityMap.ToMethodVisibility(
            prop.GetterAccessibility
        ) | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static
        let accessorRows = this.AddAccessorRows(prop.Type, prop, ImmutableArray[ParameterSymbol].Empty)
        let accessor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("get_${prop.Name}"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: accessorRows.First
        )
        this.StampAccessor(accessor, accessorRows, prop.GetterSymbol)
        return accessor
    }

    /// Issue #263: emits a static setter accessor MethodDef (set_PropertyName).
    private func EmitStaticPropertySetter(structSym StructSymbol, prop PropertySymbol) MethodDefinitionHandle {
        let (computed, bodyOffset) = this.EmitPropertyAccessorBody(structSym, prop, isStatic: true, isGetter: false)
        if (computed != nil) {
            return computed
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), prop.Type)
        )
        let methodAttrs = AccessibilityMap.ToMethodVisibility(
            prop.SetterAccessibility
        ) | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static
        let accessorRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.SetterParameters(prop))
        let accessor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("set_${prop.Name}"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: accessorRows.First
        )
        this.StampAccessor(accessor, accessorRows, prop.SetterSymbol)
        return accessor
    }

    /// Issue #263: emits add/remove accessor MethodDefs, EventDef rows, EventMap,
    /// and MethodSemantics rows for static events declared in a shared block.
    /// @param structSym The owning struct or class symbol whose static events are emitted.
    func EmitStaticEventAccessors(structSym StructSymbol) {
        if structSym.StaticEvents.IsDefaultOrEmpty {
            return
        }
        if !this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle) {
            return
        }
        var firstEventDef = default(EventDefinitionHandle)
        for ev in structSym.StaticEvents {
            if !this.cache.EventAccessorHandles.TryGetValue(ev, out var accessorHandles) {
                continue
            }
            // Emit add_X MethodDef.
            let addMethod = this.EmitStaticEventAddAccessor(structSym, ev)
            // Emit remove_X MethodDef.
            let removeMethod = this.EmitStaticEventRemoveAccessor(structSym, ev)
            // Issue #257: emit raise_X MethodDef if present.
            var raiseMethod MethodDefinitionHandle? = nil
            if ev.RaiseMethodSymbol != nil {
                raiseMethod = this.EmitEventRaiseAccessor(structSym, ev, isStatic: true)
            }
            // Emit EventDef row.
            let eventTypeHandle = this.GetEventTypeHandle(ev.Type)
            let eventDef = this
                .emitCtx
                .Metadata
                .AddEvent(
                attributes: EventAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(ev.Name),
                type: eventTypeHandle
            )
            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the EventDef (parity with the class/interface member path).
            this.emitUserAttributes(eventDef, ev, AttributeTargetKind.Event)
            // ADR-0186 §8: the handler's nullability, on the row the import
            // side reads it from — see CustomAttributeEncoder.EmitNullableAttributeOnEvent.
            this.emitNullableAttributeOnEvent(eventDef, ev.Type)
            if firstEventDef.IsNil {
                firstEventDef = eventDef
            }
            // MethodSemantics rows linking accessor MethodDefs to the EventDef.
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Adder, addMethod)
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Remover, removeMethod)
            if (raiseMethod != nil) {
                this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Raiser, raiseMethod)
            }
        }
        // EventMap row: links the TypeDef to its first EventDef.
        // Only add if no instance events already created an EventMap for this type.
        if !firstEventDef.IsNil && structSym.Events.IsDefaultOrEmpty {
            this.emitCtx.Metadata.AddEventMap(typeDefHandle, firstEventDef)
        }
    }

    /// Issue #263: emits a static add_X accessor MethodDef for a static event.
    private func EmitStaticEventAddAccessor(structSym StructSymbol, ev EventSymbol) MethodDefinitionHandle {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            if ev.IsFieldLike &&
                ev.BackingField != nil &&
                this
                .cache
                .StructFieldDefs
                .TryGetValue(ev.BackingField!!, out var backingHandle) {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                bodyOffset = this.EmitEventCasLoopBody(structSym, ev, backingHandle, isStatic: true, isAdd: true)
            } else if ev.AddMethodSymbol != nil &&
                this
                .emitCtx
                .Program
                .Functions
                .TryGetValue(ev.AddMethodSymbol!!, out var addBody) {
                let handle = this.emitFunction(ev.AddMethodSymbol!!, addBody, false)
                return handle
            } else {
                let il = InstructionEncoder(BlobBuilder())
                let nieCtor = this.wellKnown.GetNotImplementedExceptionCtor()
                il.OpCode(ILOpCode.Newobj)
                il.Token(nieCtor)
                il.OpCode(ILOpCode.Throw)
                bodyOffset = this
                    .emitCtx
                    .MethodBodyStream
                    .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
            }
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type)
        )
        let methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static
        let accessorRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.EventAccessorParameters(ev))
        let accessor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("add_${ev.Name}"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: accessorRows.First
        )
        this.StampAccessor(accessor, accessorRows, ev.AddMethodSymbol)
        return accessor
    }

    /// Issue #263: emits a static remove_X accessor MethodDef for a static event.
    private func EmitStaticEventRemoveAccessor(structSym StructSymbol, ev EventSymbol) MethodDefinitionHandle {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            if ev.IsFieldLike &&
                ev.BackingField != nil &&
                this
                .cache
                .StructFieldDefs
                .TryGetValue(ev.BackingField!!, out var backingHandle) {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                bodyOffset = this.EmitEventCasLoopBody(structSym, ev, backingHandle, isStatic: true, isAdd: false)
            } else if ev.RemoveMethodSymbol != nil &&
                this
                .emitCtx
                .Program
                .Functions
                .TryGetValue(ev.RemoveMethodSymbol!!, out var removeBody) {
                let handle = this.emitFunction(ev.RemoveMethodSymbol!!, removeBody, false)
                return handle
            } else {
                let il = InstructionEncoder(BlobBuilder())
                let nieCtor = this.wellKnown.GetNotImplementedExceptionCtor()
                il.OpCode(ILOpCode.Newobj)
                il.Token(nieCtor)
                il.OpCode(ILOpCode.Throw)
                bodyOffset = this
                    .emitCtx
                    .MethodBodyStream
                    .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
            }
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: false).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type)
        )
        let methodAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Static
        let accessorRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.EventAccessorParameters(ev))
        let accessor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString("remove_${ev.Name}"),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: accessorRows.First
        )
        this.StampAccessor(accessor, accessorRows, ev.RemoveMethodSymbol)
        return accessor
    }

    /// ADR-0052: determines whether an event on a class/struct implicitly implements
    /// an interface event (same name on any implemented interface).
    private func EventImplicitlyImplementsInterface(structSym StructSymbol, ev EventSymbol) bool {
        if !structSym.Interfaces.IsDefaultOrEmpty {
            for iface in structSym.Interfaces {
                // ADR-0149 follow-up (issue #2370): see the matching comment in
                // PropertyImplicitlyImplementsInterface — Events is likewise
                // never substituted onto a constructed generic interface
                // instance, so this must resolve against the open Definition.
                let defIface = iface.Definition ?? iface
                if defIface.Events.IsDefaultOrEmpty {
                    continue
                }
                for ifaceEvent in defIface.Events {
                    if ifaceEvent.Name == ev.Name {
                        return true
                    }
                }
            }
        }
        // Issue #2380: mirror PropertyImplicitlyImplementsInterface's
        // ImplementedClrInterfaces (issue #525) branch — this was entirely
        // missing for events, so a class/struct event implicitly satisfying
        // an IMPORTED CLR interface's event (of any handler-type shape,
        // including one that nests a `Nullable<T>` generic argument, e.g.
        // `EventHandler<Notification<int?>>`) was never promoted to
        // Virtual|NewSlot and silently produced unverifiable IL, exactly
        // like the property/method gaps this issue fixes. Uses the same
        // effective-CLR-type comparison as the property branch.
        if !structSym.ImplementedClrInterfaces.IsDefaultOrEmpty {
            let evClr Type? = NullableLifting.GetEffectiveClrType(ev.Type)
            for ifaceSym in structSym.ImplementedClrInterfaces {
                let clrIface Type? = ifaceSym?.ClrType
                if clrIface == nil {
                    continue
                }
                for clrEvent in MemberLookup.EnumerateSelfAndInterfaces(clrIface).SelectMany(
                    func (inherited Type) IEnumerable[EventInfo] {
                        return inherited.GetEvents(BindingFlags.Public | BindingFlags.Instance)
                    }
                ) {
                    if clrEvent.Name == ev.Name &&
                        (
                        evClr == nil ||
                            (
                            clrEvent.EventHandlerType is {} eventHandlerType && ClrTypeUtilities.AreSame(
                                evClr,
                                eventHandlerType
                            )
                        )
                    ) {
                        return true
                    }
                }
            }
        }
        return false
    }

    /// ADR-0052: emits add/remove accessor MethodDefs, EventDef rows, EventMap,
    /// and MethodSemantics rows for all events declared on a type.
    /// @param structSym The owning struct or class symbol whose instance events are emitted.
    func EmitEventAccessors(structSym StructSymbol) {
        if structSym.Events.IsDefaultOrEmpty {
            return
        }
        if !this.cache.StructTypeDefs.TryGetValue(structSym, out var typeDefHandle) {
            return
        }
        var firstEventDef = default(EventDefinitionHandle)
        for ev in structSym.Events {
            if !this.cache.EventAccessorHandles.TryGetValue(ev, out var accessorHandles) {
                continue
            }
            // Emit add_X MethodDef.
            let addMethod = this.EmitEventAddAccessor(structSym, ev)
            // Emit remove_X MethodDef.
            let removeMethod = this.EmitEventRemoveAccessor(structSym, ev)
            // Issue #257: emit raise_X MethodDef if present.
            var raiseMethod MethodDefinitionHandle? = nil
            if ev.RaiseMethodSymbol != nil {
                raiseMethod = this.EmitEventRaiseAccessor(structSym, ev, isStatic: false)
            }
            // Emit EventDef row.
            let eventTypeHandle = this.GetEventTypeHandle(ev.Type)
            let eventDef = this
                .emitCtx
                .Metadata
                .AddEvent(
                attributes: EventAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(ev.Name),
                type: eventTypeHandle
            )
            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the EventDef (parity with the class/interface member path).
            this.emitUserAttributes(eventDef, ev, AttributeTargetKind.Event)
            // ADR-0186 §8: the handler's nullability, on the row the import
            // side reads it from — see CustomAttributeEncoder.EmitNullableAttributeOnEvent.
            this.emitNullableAttributeOnEvent(eventDef, ev.Type)
            if firstEventDef.IsNil {
                firstEventDef = eventDef
            }
            // MethodSemantics rows linking accessor MethodDefs to the EventDef.
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Adder, addMethod)
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Remover, removeMethod)
            if (raiseMethod != nil) {
                this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Raiser, raiseMethod)
            }
        }
        // EventMap row: links the TypeDef to its first EventDef.
        if !firstEventDef.IsNil {
            this.emitCtx.Metadata.AddEventMap(typeDefHandle, firstEventDef)
        }
    }

    /// ADR-0052: resolves the EntityHandle for the event handler type used in the EventDef row.
    private func GetEventTypeHandle(type TypeSymbol) EntityHandle {
        var type = type
        // Issue #4391: a field-like event is usually declared nullable
        // (`event E EventHandler[T]?`). The `?` / `!` wrapper is a G#
        // annotation only, so peel it before choosing the token; otherwise
        // none of the branches below match and the wrapper's erased ClrType
        // (`EventHandler<object>`) becomes the accessor's castclass token.
        while type is NullableTypeSymbol || type is PlatformTypeSymbol {
            type = if type is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                (cast[PlatformTypeSymbol](type)).UnderlyingType
            }
        }
        // Issue #4391: a type that mentions an in-scope type parameter
        // (`EventHandler[T]` on `GB[T]`) has only an erased runtime ClrType;
        // encode it as a TypeSpec (`EventHandler`1<!T>`) so the castclass
        // token matches the CAS-loop locals and the backing field.
        if TypeSymbol.ContainsTypeParameter(type) {
            return this.GetEventTypeSpecHandle(type)
        }
        if type is FunctionTypeSymbol fnType {
            let clrType Type? = fnType.ClrType
            if clrType != nil {
                return this.getTypeHandleForMember(clrType)
            }
            // Issue #1473: a function-type delegate whose closed type arguments include a
            // user-declared type has no runtime CLR Type, so ClrType is null. Build the concrete
            // closed delegate (Action`n / Func`n) TypeSpec via the same encodeTypeSymbol machinery
            // used by the backing-field signature and Interlocked.CompareExchange<T> spec, so the
            // EventDef type and the accessor-body castclass token agree with the CAS loop.
            return this.GetEventTypeSpecHandle(type)
        }
        // Issue #2066: a user-declared named delegate (`type X = delegate
        // func(...) ...`) has no runtime CLR Type — its TypeDef only exists
        // in the assembly being emitted — so the `type.ClrType != null`
        // branch below can't reach it and this previously fell through to
        // the "encode as System.Delegate" fallback. That token mismatched
        // the CAS-loop locals (typed as the named delegate itself), failing
        // IL verification on the generated add_/remove_ accessor bodies.
        // Route it through the same TypeSpec machinery the FunctionTypeSymbol
        // branch above uses (valid for both non-generic and constructed
        // generic named delegates).
        if type is DelegateTypeSymbol {
            return this.GetEventTypeSpecHandle(type)
        }
        if type is ImportedTypeSymbol && type.OpenDefinition != nil && type.TypeArguments.IsDefaultOrEmpty == false {
            return this.GetEventTypeSpecHandle(type)
        }
        if type.ClrType != nil {
            return this.getTypeHandleForMember(type.ClrType)
        }
        if type is StructSymbol structSym && this.cache.StructTypeDefs.TryGetValue(structSym, out var td) {
            return td
        }
        if type is InterfaceSymbol ifaceSym && this.cache.InterfaceTypeDefs.TryGetValue(ifaceSym, out var ifaceDef) {
            return ifaceDef
        }
        // Fallback: encode as System.Delegate.
        return this.getTypeReference(typeof(Delegate))
    }

    /// Issue #1473: encodes the event handler type symbol into a TypeSpec EntityHandle, used when
    /// the type has no runtime CLR (cref:Type) (e.g. a function-type delegate closed over a
    /// user-declared type argument). Mirrors the TypeSpec machinery in
    /// (cref:GetInterlockedCompareExchangeSpec) and the backing-field signature.
    private func GetEventTypeSpecHandle(type TypeSymbol) EntityHandle {
        let sigBlob = BlobBuilder()
        this.encodeTypeSymbol(BlobEncoder(sigBlob).TypeSpecificationSignature(), type)
        return this.emitCtx.MetadataRows.AddTypeSpecification(this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    /// Issue #1611: emits the thread-safe CAS-loop body shared by the instance/static
    /// add/remove event accessors. Resolves the backing-field token through
    /// (cref:resolveFieldToken) when the owning type is a generic type (mirrors
    /// the property fix for issue #989) so the emitted tokens are valid self-TypeSpec
    /// MemberRefs instead of bare FieldDefs on a generic type.
    /// @param structSym The struct/class declaring the event.
    /// @param ev The field-like event being emitted.
    /// @param backingHandle The FieldDef handle for the backing field.
    /// @param isStatic Whether the accessor is static (ldsfld/ldsflda vs ldfld/ldflda, no `this`).
    /// @param isAdd Whether this is the add accessor (Delegate.Combine) or remove (Delegate.Remove).
    private func EmitEventCasLoopBody(
        structSym StructSymbol,
        ev EventSymbol,
        backingHandle FieldDefinitionHandle,
        isStatic bool,
        isAdd bool
    ) int32 {
        let backingToken = if ReflectionMetadataEmitter.IsUserGenericTypeReference(structSym) {
            this.resolveFieldToken(
                structSym,
                Invariant.Required(
                    ev.BackingField,
                    "a field-like event has a backing field",
                    expression: "ev.BackingField"
                )
            )
        } else {
            EntityHandle(backingHandle)
        }
        let il = InstructionEncoder(BlobBuilder(), ControlFlowBuilder())
        let eventTypeHandle = this.GetEventTypeHandle(ev.Type)
        // Static accessors have no `this`; the value parameter is argument 0 instead of 1.
        let valueArgIndex = if isStatic {
            0
        } else {
            1
        }
        // load backingField; stloc.0
        if !isStatic {
            il.LoadArgument(0)
        }
        il.OpCode(
            if isStatic {
                ILOpCode.Ldsfld
            } else {
                ILOpCode.Ldfld
            }
        )
        il.Token(backingToken)
        il.OpCode(ILOpCode.Stloc_0)
        // loop_start:
        let loopStart = il.DefineLabel()
        il.MarkLabel(loopStart)
        // ldloc.0; stloc.1
        il.OpCode(ILOpCode.Ldloc_0)
        il.OpCode(ILOpCode.Stloc_1)
        // ldloc.1; ldarg value; call Delegate.Combine/Remove; castclass T; stloc.2
        il.OpCode(ILOpCode.Ldloc_1)
        il.LoadArgument(valueArgIndex)
        il.OpCode(ILOpCode.Call)
        il.Token(
            if isAdd {
                this.wellKnown.GetDelegateCombineRef()
            } else {
                this.wellKnown.GetDelegateRemoveRef()
            }
        )
        il.OpCode(ILOpCode.Castclass)
        il.Token(eventTypeHandle)
        il.OpCode(ILOpCode.Stloc_2)
        // load backingField address; ldloc.2; ldloc.1
        if !isStatic {
            il.LoadArgument(0)
        }
        il.OpCode(
            if isStatic {
                ILOpCode.Ldsflda
            } else {
                ILOpCode.Ldflda
            }
        )
        il.Token(backingToken)
        il.OpCode(ILOpCode.Ldloc_2)
        il.OpCode(ILOpCode.Ldloc_1)
        // call Interlocked.CompareExchange<T>; stloc.0
        il.OpCode(ILOpCode.Call)
        il.Token(this.GetInterlockedCompareExchangeSpec(ev.Type))
        il.OpCode(ILOpCode.Stloc_0)
        // ldloc.0; ldloc.1; bne.un.s loop_start
        il.OpCode(ILOpCode.Ldloc_0)
        il.OpCode(ILOpCode.Ldloc_1)
        il.Branch(ILOpCode.Bne_un_s, loopStart)
        il.OpCode(ILOpCode.Ret)
        let localsSigBlob = BlobBuilder()
        let localsEncoder = BlobEncoder(localsSigBlob).LocalVariableSignature(3)
        this.encodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type)
        this.encodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type)
        this.encodeTypeSymbol(localsEncoder.AddVariable().Type(), ev.Type)
        let localsSignature = this
            .emitCtx
            .Metadata
            .AddStandaloneSignature(this.emitCtx.Metadata.GetOrAddBlob(localsSigBlob))
        return this
            .emitCtx
            .MethodBodyStream
            .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il), localVariablesSignature: localsSignature)
    }

    /// ADR-0052: emits the add_X accessor MethodDef for an event.
    private func EmitEventAddAccessor(structSym StructSymbol, ev EventSymbol) MethodDefinitionHandle {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            if ev.IsFieldLike &&
                ev.BackingField != nil &&
                this
                .cache
                .StructFieldDefs
                .TryGetValue(ev.BackingField!!, out var backingHandle) {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                bodyOffset = this.EmitEventCasLoopBody(structSym, ev, backingHandle, isStatic: false, isAdd: true)
            } else if ev.AddMethodSymbol != nil &&
                this
                .emitCtx
                .Program
                .Functions
                .TryGetValue(ev.AddMethodSymbol!!, out var addBody) {
                // Explicit accessor with bound body: emit using EmitFunction infrastructure.
                let handle = this.emitFunction(ev.AddMethodSymbol!!, addBody, false)
                return handle
            } else {
                // Fallback: throw new NotImplementedException().
                let il = InstructionEncoder(BlobBuilder())
                let nieCtor = this.wellKnown.GetNotImplementedExceptionCtor()
                il.OpCode(ILOpCode.Newobj)
                il.Token(nieCtor)
                il.OpCode(ILOpCode.Throw)
                bodyOffset = this
                    .emitCtx
                    .MethodBodyStream
                    .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
            }
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type)
        )
        // ADR-0149: an explicit-interface qualifier clause field-like event's
        // add_ accessor is always private in CLR metadata (mirrors the
        // property getter/setter fix above); a custom (non-field-like)
        // explicit event's add accessor instead returns early above via
        // EmitFunction, whose own effectiveAccessibility already enforces
        // this, so this fallback only needs to cover the field-like case.
        var methodAttrs = (
            if ev.HasExplicitInterfaceClause {
                MethodAttributes.Private
            } else {
                MethodAttributes.Public
            }
        ) | MethodAttributes.SpecialName | MethodAttributes.HideBySig
        if ev.IsVirtual {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
        } else if ev.IsOverride {
            methodAttrs |= MethodAttributes.Virtual
        } else if this.EventImplicitlyImplementsInterface(structSym, ev) {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
        } else if ev.ExplicitInterfaceMember != nil {
            // ADR-0149: mirrors the property MethodImpl-bridge promotion —
            // a MethodImpl body method must be Virtual per ECMA-335 §II.10.3.3;
            // Final additionally prevents an accidental by-name override.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final
        }
        // ADR-0149: a collision-free metadata name, mirroring
        // EmitPropertyGetter/Setter's getterName/setterName synthesis.
        let addName = if ev.HasExplicitInterfaceClause {
            "add_" + ExplicitInterfaceMetadataNaming.GetMetadataName(
                ev.Name,
                Invariant.Required(
                    ev.ExplicitInterfaceClauseTarget,
                    "an explicit event implementation has a target",
                    expression: "ev.ExplicitInterfaceClauseTarget"
                )
            )
        } else {
            "add_${ev.Name}"
        }
        let accessorRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.EventAccessorParameters(ev))
        let accessor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(addName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: accessorRows.First
        )
        this.StampAccessor(accessor, accessorRows, ev.AddMethodSymbol)
        return accessor
    }

    /// ADR-0052: emits the remove_X accessor MethodDef for an event.
    private func EmitEventRemoveAccessor(structSym StructSymbol, ev EventSymbol) MethodDefinitionHandle {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            if ev.IsFieldLike &&
                ev.BackingField != nil &&
                this
                .cache
                .StructFieldDefs
                .TryGetValue(ev.BackingField!!, out var backingHandle) {
                // Issue #256: thread-safe CAS loop using Interlocked.CompareExchange<T>.
                bodyOffset = this.EmitEventCasLoopBody(structSym, ev, backingHandle, isStatic: false, isAdd: false)
            } else if ev.RemoveMethodSymbol != nil &&
                this
                .emitCtx
                .Program
                .Functions
                .TryGetValue(ev.RemoveMethodSymbol!!, out var removeBody) {
                // Explicit accessor with bound body: emit using EmitFunction infrastructure.
                let handle = this.emitFunction(ev.RemoveMethodSymbol!!, removeBody, false)
                return handle
            } else {
                // Fallback: throw new NotImplementedException().
                let il = InstructionEncoder(BlobBuilder())
                let nieCtor = this.wellKnown.GetNotImplementedExceptionCtor()
                il.OpCode(ILOpCode.Newobj)
                il.Token(nieCtor)
                il.OpCode(ILOpCode.Throw)
                bodyOffset = this
                    .emitCtx
                    .MethodBodyStream
                    .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
            }
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type)
        )
        // ADR-0149: see the matching visibility comment in EmitEventAddAccessor.
        var methodAttrs = (
            if ev.HasExplicitInterfaceClause {
                MethodAttributes.Private
            } else {
                MethodAttributes.Public
            }
        ) | MethodAttributes.SpecialName | MethodAttributes.HideBySig
        if ev.IsVirtual {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
        } else if ev.IsOverride {
            methodAttrs |= MethodAttributes.Virtual
        } else if this.EventImplicitlyImplementsInterface(structSym, ev) {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
        } else if ev.ExplicitInterfaceMember != nil {
            // ADR-0149: see the matching comment in EmitEventAddAccessor.
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final
        }
        // ADR-0149: see the matching comment in EmitEventAddAccessor.
        let removeName = if ev.HasExplicitInterfaceClause {
            "remove_" + ExplicitInterfaceMetadataNaming.GetMetadataName(
                ev.Name,
                Invariant.Required(
                    ev.ExplicitInterfaceClauseTarget,
                    "an explicit event implementation has a target",
                    expression: "ev.ExplicitInterfaceClauseTarget"
                )
            )
        } else {
            "remove_${ev.Name}"
        }
        let accessorRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.EventAccessorParameters(ev))
        let accessor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(removeName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: accessorRows.First
        )
        this.StampAccessor(accessor, accessorRows, ev.RemoveMethodSymbol)
        return accessor
    }

    /// Issue #257: emits the raise_X accessor MethodDef for an event.
    /// The raise accessor body is always user-provided (explicit).
    private func EmitEventRaiseAccessor(structSym StructSymbol, ev EventSymbol, isStatic bool) MethodDefinitionHandle {
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            if ev.RaiseMethodSymbol != nil &&
                this
                .emitCtx
                .Program
                .Functions
                .TryGetValue(ev.RaiseMethodSymbol!!, out var raiseBody) {
                let handle = this.emitFunction(ev.RaiseMethodSymbol!!, raiseBody, false)
                return handle
            } else {
                // Fallback: throw new NotImplementedException().
                let il = InstructionEncoder(BlobBuilder())
                let nieCtor = this.wellKnown.GetNotImplementedExceptionCtor()
                il.OpCode(ILOpCode.Newobj)
                il.Token(nieCtor)
                il.OpCode(ILOpCode.Throw)
                bodyOffset = this
                    .emitCtx
                    .MethodBodyStream
                    .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
            }
        }
        // Build signature: parameters match the handler type's parameters, return void.
        // Issue #2726 follow-up: resolve the raise parameters through the general
        // delegate-shape helper so canonicalized nominal CLR handler types
        // (`EventHandler`/`EventHandler<T>`) — which are `ImportedTypeSymbol`s, not
        // `FunctionTypeSymbol`s — expose their real `(object, EventArgs)` /
        // `(object, T)` parameters instead of falling through to a zero-parameter
        // shape.
        var paramCount = 0
        var raiseShape FunctionTypeSymbol? = nil
        if MemberLookup.TryGetDelegateFunctionTypeFromSymbol(ev.Type, out var resolvedShape) {
            raiseShape = resolvedShape
            paramCount = resolvedShape.ParameterTypes.Length
        }
        let sigBlob = BlobBuilder()
        BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !isStatic).Parameters(
            paramCount,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                if raiseShape != nil {
                    for pt in raiseShape.ParameterTypes {
                        this.encodeTypeSymbol(ps.AddParameter().Type(), pt)
                    }
                }
            }
        )
        // ADR-0149: see the matching visibility comment in EmitEventAddAccessor
        // (this fallback is reached only when MetadataOnly suppresses the
        // EmitFunction path above, or when there is genuinely no raise
        // accessor body — a raise accessor is always user-provided).
        var methodAttrs = (
            if ev.HasExplicitInterfaceClause {
                MethodAttributes.Private
            } else {
                MethodAttributes.Public
            }
        ) | MethodAttributes.SpecialName | MethodAttributes.HideBySig
        if isStatic {
            methodAttrs |= MethodAttributes.Static
        } else if ev.IsVirtual {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot
        } else if ev.IsOverride {
            methodAttrs |= MethodAttributes.Virtual
        } else if ev.ExplicitInterfaceMember != nil {
            methodAttrs |= MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final
        }
        // ADR-0149: see the matching comment in EmitEventAddAccessor.
        let raiseName = if ev.HasExplicitInterfaceClause {
            "raise_" + ExplicitInterfaceMetadataNaming.GetMetadataName(
                ev.Name,
                Invariant.Required(
                    ev.ExplicitInterfaceClauseTarget,
                    "an explicit event implementation has a target",
                    expression: "ev.ExplicitInterfaceClauseTarget"
                )
            )
        } else {
            "raise_${ev.Name}"
        }
        let accessorRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.RaiseParameters(raiseShape))
        let accessor = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            attributes: methodAttrs,
            implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
            name: this.emitCtx.Metadata.GetOrAddString(raiseName),
            signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
            bodyOffset: bodyOffset,
            parameterList: accessorRows.First
        )
        this.StampAccessor(accessor, accessorRows, ev.RaiseMethodSymbol)
        return accessor
    }

    /// Issue #256: produces a MethodSpec for Interlocked.CompareExchange<EventType>.
    private func GetInterlockedCompareExchangeSpec(eventType TypeSymbol) EntityHandle {
        let openRef = this.wellKnown.GetInterlockedCompareExchangeOpenRef()
        let sigBlob = BlobBuilder()
        let argsEncoder = BlobEncoder(sigBlob).MethodSpecificationSignature(1)
        let typeEncoder = argsEncoder.AddArgument()
        this.encodeTypeSymbol(typeEncoder, eventType)
        return this.emitCtx.MetadataRows.AddMethodSpecification(openRef, this.emitCtx.Metadata.GetOrAddBlob(sigBlob))
    }

    /// Issue #248: emits abstract accessor MethodDefs, PropertyDef rows, PropertyMap,
    /// and MethodSemantics rows for all properties declared on an interface.
    /// @param ifaceSym The owning interface symbol whose property accessors are emitted as abstract
    /// MethodDefs.
    func EmitInterfacePropertyAccessors(ifaceSym InterfaceSymbol) {
        if ifaceSym.Properties.IsDefaultOrEmpty {
            return
        }
        if !this.cache.InterfaceTypeDefs.TryGetValue(ifaceSym, out var typeDefHandle) {
            return
        }
        var firstPropDef = default(PropertyDefinitionHandle)
        for prop in ifaceSym.Properties {
            if !this.cache.PropertyAccessorHandles.TryGetValue(prop, out var accessorHandles) {
                continue
            }
            // Emit abstract getter MethodDef.
            var emittedGetter MethodDefinitionHandle? = nil
            if prop.HasGetter && (accessorHandles.Getter != nil) {
                emittedGetter = this.EmitInterfacePropertyGetter(prop)
            }
            // Emit abstract setter MethodDef.
            var emittedSetter MethodDefinitionHandle? = nil
            if prop.HasSetter && (accessorHandles.Setter != nil) {
                emittedSetter = this.EmitInterfacePropertySetter(prop)
            }
            // Emit PropertyDef row.
            let propertySignature = BlobBuilder()
            if prop.IsIndexer && !prop.Parameters.IsDefaultOrEmpty {
                // ADR-0118 / ADR-0149 (issue #944 follow-up): an interface
                // indexer's PropertyDef signature carries its index parameter
                // types too, mirroring the struct/class indexer PropertyDef
                // emission above (EmitPropertyGetter/Setter's sibling path).
                let indexParams = prop.Parameters
                BlobEncoder(propertySignature).PropertySignature(isInstanceProperty: !prop.IsStatic).Parameters(
                    indexParams.Length,
                    (returnType ReturnTypeEncoder) -> this.EncodePropertyType(returnType, prop),
                    (parameters ParametersEncoder) -> {
                        for indexParam in indexParams {
                            this.encodeTypeSymbol(parameters.AddParameter().Type(), indexParam.Type)
                        }
                    }
                )
            } else {
                BlobEncoder(propertySignature).PropertySignature(isInstanceProperty: !prop.IsStatic).Parameters(
                    0,
                    (returnType ReturnTypeEncoder) -> this.EncodePropertyType(returnType, prop),
                    (parameters ParametersEncoder) -> { }
                )
            }
            let propDef = this
                .emitCtx
                .Metadata
                .AddProperty(
                attributes: PropertyAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(prop.Name),
                signature: this.emitCtx.Metadata.GetOrAddBlob(propertySignature)
            )
            if firstPropDef.IsNil {
                firstPropDef = propDef
            }
            // MethodSemantics rows linking accessor MethodDefs to the PropertyDef.
            if (emittedGetter != nil) {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Getter, emittedGetter)
            }
            if (emittedSetter != nil) {
                this.emitCtx.Metadata.AddMethodSemantics(propDef, MethodSemanticsAttributes.Setter, emittedSetter)
            }
            this.emitNullableAttributeOnProperty(propDef, prop.Type)
            this.EmitReadOnlyRefAttribute(propDef, prop)
            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the PropertyDef (parity with the class/interface member path).
            this.emitUserAttributes(propDef, prop, AttributeTargetKind.Property)
        }
        // PropertyMap row: links the TypeDef to its first PropertyDef.
        if !firstPropDef.IsNil {
            this.emitCtx.Metadata.AddPropertyMap(typeDefHandle, firstPropDef)
            this.cache.TypesWithPropertyMap.Add(typeDefHandle)
        }
    }

    private func EmitInterfacePropertyGetter(prop PropertySymbol) MethodDefinitionHandle {
        var emittedGetter MethodDefinitionHandle
        // Issue #1030 / #2293: a default-bodied interface property
        // getter — static-virtual or ordinary instance — is a
        // non-abstract Virtual slot with a real IL body. Route it
        // through the regular function-emit pipeline (signature +
        // body + parameter rows), which stamps
        // Static|Virtual|NewSlot|SpecialName for a static accessor,
        // or Virtual|NewSlot|SpecialName (receiver = interface, no
        // Static) for an instance default accessor — mirroring how
        // default-interface *methods* are emitted (EmitFunction's
        // receiver-is-interface branch). The MethodDef row lands in
        // the planned accessor position because this runs in
        // accessor order.
        if prop.GetterSymbol != nil &&
            !prop.GetterSymbol!!.IsAbstract &&
            this
            .emitCtx
            .Program
            .Functions
            .TryGetValue(prop.GetterSymbol!!, out var getterBody) {
            emittedGetter = this.emitFunction(prop.GetterSymbol!!, getterBody, false)
        } else {
            let sigBlob = BlobBuilder()
            BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !prop.IsStatic).Parameters(
                prop.Parameters.Length,
                (r ReturnTypeEncoder) -> this.encodeTypeSymbol(r.Type(), prop.Type),
                (ps ParametersEncoder) -> {
                    // ADR-0149 (issue #944 follow-up): an abstract
                    // interface indexer getter carries its index
                    // parameters ahead of the return type, exactly
                    // like a struct/class indexer getter.
                    for indexParam in prop.Parameters {
                        this.encodeTypeSymbol(ps.AddParameter().Type(), indexParam.Type)
                    }
                }
            )
            var attrs = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot | MethodAttributes.SpecialName
            if prop.IsStatic {
                attrs |= MethodAttributes.Static
            }
            let accessorRows = this.AddAccessorRows(prop.Type, nil, this.GetterParameters(prop))
            emittedGetter = this
                .emitCtx
                .Metadata
                .AddMethodDefinition(
                attributes: attrs,
                implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                name: this.emitCtx.Metadata.GetOrAddString("get_${prop.Name}"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
                bodyOffset: -1,
                parameterList: accessorRows.First
            )
            this.StampAccessor(emittedGetter, accessorRows, prop.GetterSymbol)
        }
        return emittedGetter
    }

    private func EmitInterfacePropertySetter(prop PropertySymbol) MethodDefinitionHandle {
        var emittedSetter MethodDefinitionHandle
        // Issue #1030 / #2293: default-bodied interface setter
        // (static-virtual or ordinary instance).
        if prop.SetterSymbol != nil &&
            !prop.SetterSymbol!!.IsAbstract &&
            this
            .emitCtx
            .Program
            .Functions
            .TryGetValue(prop.SetterSymbol!!, out var setterBody) {
            emittedSetter = this.emitFunction(prop.SetterSymbol!!, setterBody, false)
        } else {
            let sigBlob = BlobBuilder()
            BlobEncoder(sigBlob).MethodSignature(isInstanceMethod: !prop.IsStatic).Parameters(
                prop.Parameters.Length + 1,
                (r ReturnTypeEncoder) -> {
                    if prop.IsInitOnly {
                        let isExternalInit = this.wellKnown.GetIsExternalInitTypeRef()
                        if !isExternalInit.IsNil {
                            r.CustomModifiers().AddModifier(isExternalInit, isOptional: false)
                        }
                    }
                    r.Void()
                },
                (ps ParametersEncoder) -> {
                    // ADR-0149 (issue #944 follow-up): an abstract
                    // interface indexer setter carries its index
                    // parameters ahead of the trailing `value`
                    // parameter, exactly like a struct/class
                    // indexer setter.
                    for indexParam in prop.Parameters {
                        this.encodeTypeSymbol(ps.AddParameter().Type(), indexParam.Type)
                    }
                    this.encodeTypeSymbol(ps.AddParameter().Type(), prop.Type)
                }
            )
            var attrs = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot | MethodAttributes.SpecialName
            if prop.IsStatic {
                attrs |= MethodAttributes.Static
            }
            let accessorRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.SetterParameters(prop))
            emittedSetter = this
                .emitCtx
                .Metadata
                .AddMethodDefinition(
                attributes: attrs,
                implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                name: this.emitCtx.Metadata.GetOrAddString("set_${prop.Name}"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(sigBlob),
                bodyOffset: -1,
                parameterList: accessorRows.First
            )
            this.StampAccessor(emittedSetter, accessorRows, prop.SetterSymbol)
        }
        return emittedSetter
    }

    /// ADR-0052: emits abstract add/remove accessor MethodDefs, EventDef rows, EventMap,
    /// and MethodSemantics rows for all events declared on an interface.
    /// @param ifaceSym The owning interface symbol whose event accessors are emitted as abstract
    /// MethodDefs.
    func EmitInterfaceEventAccessors(ifaceSym InterfaceSymbol) {
        if ifaceSym.Events.IsDefaultOrEmpty {
            return
        }
        if !this.cache.InterfaceTypeDefs.TryGetValue(ifaceSym, out var typeDefHandle) {
            return
        }
        var firstEventDef = default(EventDefinitionHandle)
        for ev in ifaceSym.Events {
            if !this.cache.EventAccessorHandles.TryGetValue(ev, out var accessorHandles) {
                continue
            }
            // Emit abstract add_X MethodDef.
            let addSigBlob = BlobBuilder()
            BlobEncoder(addSigBlob).MethodSignature(isInstanceMethod: true).Parameters(
                1,
                (r ReturnTypeEncoder) -> r.Void(),
                (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type)
            )
            let addAttrs = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot | MethodAttributes.SpecialName
            let addRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.EventAccessorParameters(ev))
            let emittedAdd = this
                .emitCtx
                .Metadata
                .AddMethodDefinition(
                attributes: addAttrs,
                implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                name: this.emitCtx.Metadata.GetOrAddString("add_${ev.Name}"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(addSigBlob),
                bodyOffset: -1,
                parameterList: addRows.First
            )
            this.StampAccessor(emittedAdd, addRows, ev.AddMethodSymbol)
            // Emit abstract remove_X MethodDef.
            let removeSigBlob = BlobBuilder()
            BlobEncoder(removeSigBlob).MethodSignature(isInstanceMethod: true).Parameters(
                1,
                (r ReturnTypeEncoder) -> r.Void(),
                (ps ParametersEncoder) -> this.encodeTypeSymbol(ps.AddParameter().Type(), ev.Type)
            )
            let removeAttrs = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot | MethodAttributes.SpecialName
            let removeRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.EventAccessorParameters(ev))
            let emittedRemove = this
                .emitCtx
                .Metadata
                .AddMethodDefinition(
                attributes: removeAttrs,
                implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                name: this.emitCtx.Metadata.GetOrAddString("remove_${ev.Name}"),
                signature: this.emitCtx.Metadata.GetOrAddBlob(removeSigBlob),
                bodyOffset: -1,
                parameterList: removeRows.First
            )
            this.StampAccessor(emittedRemove, removeRows, ev.RemoveMethodSymbol)
            // Emit EventDef row.
            let eventTypeHandle = this.GetEventTypeHandle(ev.Type)
            let eventDef = this
                .emitCtx
                .Metadata
                .AddEvent(
                attributes: EventAttributes.None,
                name: this.emitCtx.Metadata.GetOrAddString(ev.Name),
                type: eventTypeHandle
            )
            // Issue #2129: emit user @annotations as CustomAttribute rows on
            // the EventDef (parity with the class/interface member path).
            this.emitUserAttributes(eventDef, ev, AttributeTargetKind.Event)
            // ADR-0186 §8: the handler's nullability, on the row the import
            // side reads it from — see CustomAttributeEncoder.EmitNullableAttributeOnEvent.
            this.emitNullableAttributeOnEvent(eventDef, ev.Type)
            if firstEventDef.IsNil {
                firstEventDef = eventDef
            }
            // MethodSemantics rows linking accessor MethodDefs to the EventDef.
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Adder, emittedAdd)
            this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Remover, emittedRemove)
            // Issue #257: emit abstract raise_X MethodDef if present.
            if ev.RaiseMethodSymbol != nil {
                // Issue #2726 follow-up: mirror the class/struct raise-signature fix
                // so canonicalized nominal CLR handler types on interface events
                // (`EventHandler`/`EventHandler<T>`) expose their real parameters
                // instead of a zero-parameter shape.
                var raiseParamCount = 0
                var raiseShape FunctionTypeSymbol? = nil
                if MemberLookup.TryGetDelegateFunctionTypeFromSymbol(ev.Type, out var resolvedShape) {
                    raiseShape = resolvedShape
                    raiseParamCount = resolvedShape.ParameterTypes.Length
                }
                let raiseSigBlob = BlobBuilder()
                BlobEncoder(raiseSigBlob).MethodSignature(isInstanceMethod: true).Parameters(
                    raiseParamCount,
                    (r ReturnTypeEncoder) -> r.Void(),
                    (ps ParametersEncoder) -> {
                        if raiseShape != nil {
                            for pt in raiseShape.ParameterTypes {
                                this.encodeTypeSymbol(ps.AddParameter().Type(), pt)
                            }
                        }
                    }
                )
                let raiseAttrs = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot | MethodAttributes.SpecialName
                let raiseRows = this.AddAccessorRows(TypeSymbol.Void, nil, this.RaiseParameters(raiseShape))
                let emittedRaise = this
                    .emitCtx
                    .Metadata
                    .AddMethodDefinition(
                    attributes: raiseAttrs,
                    implAttributes: MethodImplAttributes.IL | MethodImplAttributes.Managed,
                    name: this.emitCtx.Metadata.GetOrAddString("raise_${ev.Name}"),
                    signature: this.emitCtx.Metadata.GetOrAddBlob(raiseSigBlob),
                    bodyOffset: -1,
                    parameterList: raiseRows.First
                )
                this.StampAccessor(emittedRaise, raiseRows, ev.RaiseMethodSymbol)
                this.emitCtx.Metadata.AddMethodSemantics(eventDef, MethodSemanticsAttributes.Raiser, emittedRaise)
            }
        }
        // EventMap row: links the TypeDef to its first EventDef.
        if !firstEventDef.IsNil {
            this.emitCtx.Metadata.AddEventMap(typeDefHandle, firstEventDef)
        }
    }

    shared {
        /// Issue #248: determines whether a property on a class/struct implicitly implements
        /// an interface property (same name and type on any implemented interface).
        /// @param structSym The type declaring the candidate property.
        /// @param prop The candidate property.
        /// @returns `true` when the property implements an interface property.
        internal func PropertyImplicitlyImplementsInterface(structSym StructSymbol, prop PropertySymbol) bool {
            if prop.HasExplicitInterfaceClause {
                return false
            }
            if !structSym.Interfaces.IsDefaultOrEmpty {
                for iface in structSym.Interfaces {
                    // ADR-0149 follow-up (issue #2370): Properties is never
                    // substituted onto a CONSTRUCTED generic interface instance
                    // (see InterfaceSymbol.TryResolveMembers — only
                    // Methods/StaticMethods/PrivateMethods/StaticPrivateMethods
                    // are substituted), so `iface.Properties` is empty for e.g.
                    // `IWatchable[int32]`. Resolve against `iface.Definition ??
                    // iface` (a no-op for a non-generic interface) so an
                    // ordinary (implicit) property implementation of a GENERIC
                    // interface still gets promoted to Virtual|NewSlot instead
                    // of silently staying non-virtual and failing to satisfy the
                    // interface slot at the CLR level.
                    let defIface = iface.Definition ?? iface
                    if defIface.Properties.IsDefaultOrEmpty {
                        continue
                    }
                    let typeParameterMap = DeclarationBinder.BuildInterfaceTypeParameterMap(iface)
                    for ifaceProp in defIface.Properties {
                        if PropertyMatchesInterfaceSlot(prop, ifaceProp, typeParameterMap) {
                            return true
                        }
                    }
                }
            }
            // Issue #525: imported CLR interfaces from the base-type clause also
            // trigger the implicit-implementation virtual-slot promotion.
            if !structSym.ImplementedClrInterfaces.IsDefaultOrEmpty {
                // Issue #2380: use the effective (runtime-shape) CLR type rather
                // than the raw `ClrType`. `NullableTypeSymbol.ClrType` deliberately
                // returns the *underlying* (unwrapped) type for a value-typed
                // `T?` — see `NullableLifting.GetEffectiveClrType`'s remarks — so
                // comparing the raw `ClrType` against an imported interface's
                // `Nullable<T>`-typed property (e.g. `DateTime? ReleaseDate`)
                // never matches, and the property silently stays non-virtual
                // (ILVerify: "Class implements interface but not method"). The
                // binder-side `MemberLookup.FindMatchingProperty` already gets
                // this right; this call brings the emitter in line with it.
                for ifaceSym in structSym.ImplementedClrInterfaces {
                    let clrIface Type? = ifaceSym?.ClrType
                    if clrIface == nil {
                        continue
                    }
                    for clrProp in MemberLookup.EnumerateSelfAndInterfaces(clrIface).SelectMany(
                        func (inherited Type) IEnumerable[PropertyInfo] {
                            return inherited.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                        }
                    ) {
                        let indexParameters = clrProp.GetIndexParameters()
                        // Nullable reference annotations do not participate in CLR interface slots.
                        if clrProp.Name != prop.Name ||
                            prop.IsIndexer != (indexParameters.Length > 0) ||
                            prop
                            .Parameters
                            .Length != indexParameters.Length ||
                            (clrProp.GetMethod != nil && !prop.HasGetter) ||
                            (clrProp.SetMethod != nil && !prop.HasSetter) ||
                            !TypeSymbol
                            .AreRuntimeEquivalentIgnoringReferenceNullability(
                            prop.Type,
                            MemberLookup.GetClrPropertyTypeSymbol(
                                Invariant.Required(
                                    ifaceSym,
                                    "a CLR interface entry has a type symbol",
                                    expression: "ifaceSym"
                                ),
                                clrProp
                            )
                        ) {
                            continue
                        }
                        var parametersMatch = true
                        for var i = 0; i < indexParameters.Length; i++ {
                            if !DeclarationBinder.ConformanceSignaturesEquivalent(
                                prop.Parameters[i].Type,
                                MemberLookup.GetIndexerParameterTypeSymbol(
                                    Invariant.Required(
                                        ifaceSym,
                                        "a CLR interface entry has a type symbol",
                                        expression: "ifaceSym"
                                    ),
                                    clrProp,
                                    i
                                )
                            ) {
                                parametersMatch = false
                                break
                            }
                        }
                        if parametersMatch {
                            return true
                        }
                    }
                }
            }
            return false
        }

        private func PropertyMatchesInterfaceSlot(
            property PropertySymbol,
            interfaceProperty PropertySymbol,
            typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]?
        ) bool {
            if property.Name != interfaceProperty.Name ||
                property.IsIndexer != interfaceProperty.IsIndexer ||
                property
                .Parameters
                .Length != interfaceProperty
                .Parameters
                .Length ||
                (interfaceProperty.HasGetter && !property.HasGetter) ||
                (interfaceProperty.HasSetter && !property.HasSetter) ||
                !DeclarationBinder
                .IsInterfacePropertyTypeCompatible(
                property.Type,
                interfaceProperty.Type,
                interfaceProperty.HasSetter,
                typeParameterMap
            ) {
                return false
            }
            for var i = 0; i < property.Parameters.Length; i++ {
                if !DeclarationBinder.ConformanceSignaturesEquivalent(
                    interfaceProperty.Parameters[i].Type,
                    property.Parameters[i].Type,
                    typeParameterMap
                ) {
                    return false
                }
            }
            return true
        }
    }
}
