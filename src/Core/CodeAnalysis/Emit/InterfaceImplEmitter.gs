// <copyright file="InterfaceImplEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis

/// PR-E-14 (#1361): interface method-implementation emitter. Owns every
/// `MethodImpl`-row band moved off (cref:ReflectionMetadataEmitter):
/// explicit interface method/property/event implementations (issues
/// #985/#2010, #2362, ADR-0149) and static-virtual interface slot bindings
/// (ADR-0089, issues #755/#1019/#1268/#2370), plus the open-slot resolution
/// and signature-matching helpers used only by this band
/// (`ResolveOpenInterfaceInstanceMethod`,
/// `ResolveOpenInterfaceStaticMethod`,
/// `StaticVirtualSignatureEquals`).
/// @remarks Wired with a back-reference to the root emitter (the MethodBodyEmitter
/// idiom) for the cross-cutting token resolvers
/// ((cref:ImportedMemberRefFactory.GetMethodReference(System.Reflection.MethodInfo)),
/// (cref:UserTokenResolver.ResolveUserInterfaceInstanceMethodToken),
/// (cref:ReflectionMetadataEmitter.IsUserGenericInterfaceReference)),
/// with direct fields for the shared (cref:EmitContext) and
/// (cref:MetadataTokenCache). Method bodies are verbatim moves;
/// emitted PEs are byte-identical with the pre-E-14 baseline.
internal class InterfaceImplEmitter {
    private let outer ReflectionMetadataEmitter
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let inheritedEventBridges Dictionary[StructSymbol, List[InheritedEventBridge]] = Dictionary[
        StructSymbol,
        List[InheritedEventBridge]
    ]()
    private let importedAccessorBridges Dictionary[StructSymbol, List[ImportedAccessorBridge]] = Dictionary[
        StructSymbol,
        List[ImportedAccessorBridge]
    ]()
    private let inheritedStaticBridges Dictionary[StructSymbol, List[InheritedStaticBridge]] = Dictionary[
        StructSymbol,
        List[InheritedStaticBridge]
    ]()

    init(outer ReflectionMetadataEmitter) {
        this.outer = outer ?? throw ArgumentNullException("outer")
        this.emitCtx = outer.emitCtx
        this.cache = outer.cache
    }

    /// Issue #2443: binds G# methods and property/event accessors to virtual
    /// slots inherited from imported CLR base classes. Exact-signature
    /// overrides would usually reuse the slot from their Virtual/ReuseSlot
    /// flags alone, but an explicit MethodImpl also supports covariant returns
    /// and records the intended external declaration unambiguously.
    internal func EmitExternalBaseMethodImpls(structSymbol StructSymbol?) {
        if structSymbol == nil || !this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef) {
            return
        }
        for method in structSymbol.Methods {
            if method.ExternalOverriddenMethod != nil &&
                this
                .cache
                .MethodHandles
                .TryGetValue(method, out var implHandle) {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(method.ExternalOverriddenMethod!!, method.ExternalOverrideContainingType)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, declaration)
            }
        }
        for property in structSymbol.Properties {
            if !this.cache.PropertyAccessorHandles.TryGetValue(property, out var accessors) {
                continue
            }
            if property.ExternalOverriddenGetter != nil && (accessors.Getter != nil) {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(property.ExternalOverriddenGetter!!, property.ExternalOverrideContainingType)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Getter!!, declaration)
                if MethodInfoHelpers.IsCovariantPropertyGetter(property) {
                    this.AddPreserveBaseOverridesAttribute(accessors.Getter!!)
                }
            }
            if property.ExternalOverriddenSetter != nil && (accessors.Setter != nil) {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(property.ExternalOverriddenSetter!!, property.ExternalOverrideContainingType)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Setter!!, declaration)
            }
            if property.OverriddenProperty is {} overriddenProperty && DeclarationBinder.IsCovariantPropertyOverride(
                overriddenProperty,
                property.Type,
                property.HasGetter,
                property.HasSetter,
                property.ReturnRefKind
            ) &&
                (accessors.Getter != nil) {
                let declaration = this.ResolveSourcePropertyGetterToken(structSymbol, overriddenProperty)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Getter!!, declaration)
                this.AddPreserveBaseOverridesAttribute(accessors.Getter!!)
            }
        }
        for eventSymbol in structSymbol.Events {
            if !this.cache.EventAccessorHandles.TryGetValue(eventSymbol, out var accessors) {
                continue
            }
            if eventSymbol.ExternalOverriddenAddMethod != nil {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(
                    eventSymbol.ExternalOverriddenAddMethod!!,
                    eventSymbol.ExternalOverrideContainingType
                )
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Add, declaration)
            }
            if eventSymbol.ExternalOverriddenRemoveMethod != nil {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(
                    eventSymbol.ExternalOverriddenRemoveMethod!!,
                    eventSymbol.ExternalOverrideContainingType
                )
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Remove, declaration)
            }
            if eventSymbol.ExternalOverriddenRaiseMethod != nil && (accessors.Raise != nil) {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(
                    eventSymbol.ExternalOverriddenRaiseMethod!!,
                    eventSymbol.ExternalOverrideContainingType
                )
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Raise!!, declaration)
            }
        }
    }

    private func AddPreserveBaseOverridesAttribute(method MethodDefinitionHandle) {
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            method,
            this.outer.wellKnown.GetPreserveBaseOverridesAttributeCtorRef(),
            this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    private func ResolveSourcePropertyGetterToken(structSymbol StructSymbol, property PropertySymbol) EntityHandle {
        var containingType StructSymbol? = structSymbol.FindConstructedGenericBase(
            (definition StructSymbol) -> DeclaresProperty(definition, property)
        )
        if containingType == nil {
            for candidate in structSymbol.GetHierarchy() {
                if DeclaresProperty(candidate.Definition ?? candidate, property) {
                    containingType = candidate
                    break
                }
            }
        }
        return this
            .outer
            .userTokens
            .ResolveUserPropertyAccessorToken(
            containingType ??
                throw InvalidOperationException(
                "The declaring type for overridden property '${property.Name}' was not found."
            ),
            property,
            wantSetter: false
        )
    }

    /// Issue #985 / #2010: emit MethodImpl rows for covariant-return interface
    /// bridges AND for mangled-name explicit interface implementations. A
    /// method whose (cref:FunctionSymbol.ExplicitInterfaceSlot) is set
    /// explicitly implements a specific (typically inherited, non-generic) CLR
    /// interface slot — e.g. the private non-generic
    /// `IEnumerable.GetEnumerator()` alongside the public generic
    /// `IEnumerable<T>.GetEnumerator()`. A private bridge method
    /// cannot implicitly implement an interface slot, so the explicit row is
    /// required for the resulting type to load.
    ///
    /// A method whose (cref:FunctionSymbol.ExplicitInterfaceMember) is
    /// set explicitly implements one specific in-compilation (G#) interface
    /// member — its mangled name never matches the interface member's own
    /// name, so ordinary name-based virtual dispatch never wires it into that
    /// interface's slot; an explicit `MethodImpl` row is required here
    /// too (mirrors (cref:EmitStaticVirtualMethodImpls)'s generic-aware
    /// token resolution for a constructed interface).
    /// @param structSymbol The implementing class or struct.
    internal func EmitExplicitInterfaceMethodImpls(structSymbol StructSymbol?) {
        if structSymbol == nil || structSymbol.Methods.IsDefaultOrEmpty {
            return
        }
        if !this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef) {
            return
        }
        for method in structSymbol.Methods {
            if !this.cache.MethodHandles.TryGetValue(method, out var implHandle) {
                continue
            }
            let slot MethodInfo? = method.ExplicitInterfaceSlot
            if slot != nil {
                let slotRef = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(slot, method.ExplicitInterfaceSlotContainingType)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, slotRef)
            }
            let ifaceMember FunctionSymbol? = method.ExplicitInterfaceMember
            if ifaceMember == nil || structSymbol.Interfaces.IsDefaultOrEmpty {
                continue
            }
            var slotHandle EntityHandle? = nil
            for iface in structSymbol.Interfaces {
                // Issue #2181: for a constructed generic interface, the linked
                // `ExplicitInterfaceMember` is the SUBSTITUTED method surfaced
                // on the constructed instance (`iface.Methods`), not the open
                // definition's slot — so match against the constructed
                // instance's methods here, then map back to the open slot for
                // the MethodDef / MemberRef token resolution (the open slot is
                // what `MethodHandles` and `ResolveUserInterfaceInstanceMethodToken`
                // are keyed by). For a non-generic interface `iface.Methods` is
                // the definition's own table and the map is an identity, so the
                // pre-existing behavior is unchanged.
                if iface.Methods.IsDefaultOrEmpty || !iface.Methods.Contains(ifaceMember) {
                    continue
                }
                let openSlot = ResolveOpenInterfaceInstanceMethod(iface, ifaceMember)
                slotHandle = if ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface) {
                    this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, openSlot)
                } else {
                    (
                        if this.cache.MethodHandles.TryGetValue(openSlot, out var slotDefHandle) {
                            slotDefHandle
                        } else {
                            default(EntityHandle?)
                        }
                    )
                }
                break
            }
            if (slotHandle != nil) {
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, slotHandle)
            }
        }
    }

    /// Issue #2362: emit `MethodImpl` rows for mangled-name explicit
    /// interface PROPERTY implementations — the property-level counterpart of
    /// (cref:EmitExplicitInterfaceMethodImpls). A property whose
    /// (cref:PropertySymbol.ExplicitInterfaceMember) is set explicitly
    /// implements one specific in-compilation (G#) interface property; its
    /// mangled name never matches the interface member's own name, so
    /// ordinary name-based virtual dispatch never wires its accessors into
    /// that interface's slot. An explicit `MethodImpl` row per accessor
    /// (getter and/or setter) is required, exactly mirroring
    /// (cref:EmitStaticVirtualPropertyMethodImpls)'s generic-aware
    /// token resolution for a constructed interface, but for an INSTANCE
    /// property slot resolved from (cref:StructSymbol.Interfaces)
    /// rather than a static-virtual slot.
    /// @param structSymbol The implementing class or struct.
    internal func EmitExplicitInterfacePropertyMethodImpls(structSymbol StructSymbol?) {
        if structSymbol == nil || structSymbol.Properties.IsDefaultOrEmpty {
            return
        }
        if !this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef) {
            return
        }
        for prop in structSymbol.Properties {
            let ifaceMember PropertySymbol? = prop.ExplicitInterfaceMember
            if !this.cache.PropertyAccessorHandles.TryGetValue(prop, out var implAccessors) {
                continue
            }
            if prop.ExplicitInterfaceGetterSlot != nil && (implAccessors.Getter != nil) {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(prop.ExplicitInterfaceGetterSlot!!, prop.ExplicitInterfaceSlotContainingType)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Getter!!, declaration)
            }
            if prop.ExplicitInterfaceSetterSlot != nil && (implAccessors.Setter != nil) {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(prop.ExplicitInterfaceSetterSlot!!, prop.ExplicitInterfaceSlotContainingType)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Setter!!, declaration)
            }
            if ifaceMember == nil || structSymbol.Interfaces.IsDefaultOrEmpty {
                continue
            }
            for iface in structSymbol.Interfaces {
                if !DeclarationBinder.ConformanceSignaturesEquivalent(
                    Invariant.Required(
                        prop.ExplicitInterfaceClauseTarget,
                        "an explicit property implementation has a target",
                        expression: "prop.ExplicitInterfaceClauseTarget"
                    ),
                    iface
                ) {
                    continue
                }
                // Issue #2362: InterfaceSymbol.Construct does not substitute
                // Properties onto a constructed generic instance (see
                // InterfaceSymbol.TryResolveMembers) — `ExplicitInterfaceMember`
                // is always linked against the OPEN definition's property (see
                // TryResolveExplicitInterfacePropertyImplementation), so match
                // against `defIface.Properties` here too, exactly like
                // EmitStaticVirtualPropertyMethodImpls.
                let defIface = iface.Definition ?? iface
                if defIface.Properties.IsDefaultOrEmpty || !defIface.Properties.Contains(ifaceMember) {
                    continue
                }
                let isGenericIface = ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface)
                if ifaceMember.HasGetter && (implAccessors.Getter != nil) && ifaceMember.GetterSymbol != nil {
                    let getterDecl = if isGenericIface {
                        this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, ifaceMember.GetterSymbol!!)
                    } else {
                        (
                            if this
                                .cache
                                .MethodHandles
                                .TryGetValue(ifaceMember.GetterSymbol!!, out var getterDefHandle) {
                                getterDefHandle
                            } else {
                                default(EntityHandle?)
                            }
                        )
                    }
                    if (getterDecl != nil) {
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Getter!!, getterDecl)
                    }
                }
                if ifaceMember.HasSetter && (implAccessors.Setter != nil) && ifaceMember.SetterSymbol != nil {
                    let setterDecl = if isGenericIface {
                        this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, ifaceMember.SetterSymbol!!)
                    } else {
                        (
                            if this
                                .cache
                                .MethodHandles
                                .TryGetValue(ifaceMember.SetterSymbol!!, out var setterDefHandle) {
                                setterDefHandle
                            } else {
                                default(EntityHandle?)
                            }
                        )
                    }
                    if (setterDecl != nil) {
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Setter!!, setterDecl)
                    }
                }
                break
            }
        }
    }

    /// ADR-0149: emit `MethodImpl` rows for explicit-interface-clause
    /// EVENT implementations (`event (IFoo) Changed T`) — the event-level
    /// counterpart of (cref:EmitExplicitInterfacePropertyMethodImpls),
    /// generalizing the #2362 explicit-implementation convention to events
    /// for the first time. An event whose
    /// (cref:EventSymbol.ExplicitInterfaceMember) is set explicitly
    /// implements one specific in-compilation interface event; its add/
    /// remove (and, if present, raise) accessors are bridged into that
    /// interface's abstract slots via one `MethodImpl` row per accessor,
    /// exactly mirroring the property function's generic-aware token
    /// resolution.
    /// @param structSymbol The implementing class or struct.
    internal func EmitExplicitInterfaceEventMethodImpls(structSymbol StructSymbol?) {
        if structSymbol == nil || structSymbol.Events.IsDefaultOrEmpty {
            return
        }
        if !this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef) {
            return
        }
        for ev in structSymbol.Events {
            let ifaceMember EventSymbol? = ev.ExplicitInterfaceMember
            if !this.cache.EventAccessorHandles.TryGetValue(ev, out var implAccessors) {
                continue
            }
            if ev.ExplicitInterfaceAddSlot != nil {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(ev.ExplicitInterfaceAddSlot!!, ev.ExplicitInterfaceSlotContainingType)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Add, declaration)
            }
            if ev.ExplicitInterfaceRemoveSlot != nil {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(ev.ExplicitInterfaceRemoveSlot!!, ev.ExplicitInterfaceSlotContainingType)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Remove, declaration)
            }
            if ev.ExplicitInterfaceRaiseSlot != nil && (implAccessors.Raise != nil) {
                let declaration = this
                    .outer
                    .memberRefs
                    .GetMethodEntityHandle(ev.ExplicitInterfaceRaiseSlot!!, ev.ExplicitInterfaceSlotContainingType)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Raise!!, declaration)
            }
            if ifaceMember == nil || structSymbol.Interfaces.IsDefaultOrEmpty {
                continue
            }
            for iface in structSymbol.Interfaces {
                // ADR-0149 (mirrors #2362's property resolution): interface
                // Events, like Properties, are never substituted onto a
                // constructed generic instance (InterfaceSymbol.TryResolveMembers),
                // so ExplicitInterfaceMember is always linked against the OPEN
                // definition's event — match against `defIface.Events` here.
                let defIface = iface.Definition ?? iface
                if defIface.Events.IsDefaultOrEmpty || !defIface.Events.Contains(ifaceMember) {
                    continue
                }
                let isGenericIface = ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface)
                if ifaceMember.AddMethodSymbol != nil {
                    let addDecl = if isGenericIface {
                        this
                            .outer
                            .userTokens
                            .ResolveUserInterfaceInstanceMethodToken(iface, ifaceMember.AddMethodSymbol!!)
                    } else {
                        (
                            if this
                                .cache
                                .MethodHandles
                                .TryGetValue(ifaceMember.AddMethodSymbol!!, out var addDefHandle) {
                                addDefHandle
                            } else {
                                default(EntityHandle?)
                            }
                        )
                    }
                    if (addDecl != nil) {
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Add, addDecl)
                    }
                }
                if ifaceMember.RemoveMethodSymbol != nil {
                    let removeDecl = if isGenericIface {
                        this
                            .outer
                            .userTokens
                            .ResolveUserInterfaceInstanceMethodToken(iface, ifaceMember.RemoveMethodSymbol!!)
                    } else {
                        (
                            if this
                                .cache
                                .MethodHandles
                                .TryGetValue(ifaceMember.RemoveMethodSymbol!!, out var removeDefHandle) {
                                removeDefHandle
                            } else {
                                default(EntityHandle?)
                            }
                        )
                    }
                    if (removeDecl != nil) {
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Remove, removeDecl)
                    }
                }
                if ifaceMember.RaiseMethodSymbol != nil && (implAccessors.Raise != nil) {
                    let raiseDecl = if isGenericIface {
                        this
                            .outer
                            .userTokens
                            .ResolveUserInterfaceInstanceMethodToken(iface, ifaceMember.RaiseMethodSymbol!!)
                    } else {
                        (
                            if this
                                .cache
                                .MethodHandles
                                .TryGetValue(ifaceMember.RaiseMethodSymbol!!, out var raiseDefHandle) {
                                raiseDefHandle
                            } else {
                                default(EntityHandle?)
                            }
                        )
                    }
                    if (raiseDecl != nil) {
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Raise!!, raiseDecl)
                    }
                }
                break
            }
        }
    }

    /// Issues #2718/#2742: binds interface event slots whose implementation
    /// cannot be wired by ordinary name-based dispatch. This includes custom
    /// event accessors and events inherited from a base class that did not
    /// itself declare the interface.
    internal func EmitImplicitEventMethodImpls(structSymbol StructSymbol?) {
        if structSymbol == nil || !this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef) {
            return
        }
        for iface in structSymbol.Interfaces {
            let defIface = iface.Definition ?? iface
            for slotEvent in defIface.Events {
                if IsExplicitlyImplemented(structSymbol, slotEvent) ||
                    !TryFindImplicitEvent(structSymbol, iface, slotEvent, out var ev, out var declaringType) ||
                    (object.ReferenceEquals(declaringType, structSymbol) && ev!!.IsFieldLike) ||
                    !this
                    .cache
                    .EventAccessorHandles
                    .TryGetValue(ev!!, out var implAccessors) {
                    continue
                }
                let isGenericIface = ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface)
                if slotEvent.AddMethodSymbol != nil {
                    let declaration = if isGenericIface {
                        this
                            .outer
                            .userTokens
                            .ResolveUserInterfaceInstanceMethodToken(iface, slotEvent.AddMethodSymbol!!)
                    } else {
                        (
                            if this.cache.MethodHandles.TryGetValue(slotEvent.AddMethodSymbol!!, out var handle) {
                                handle
                            } else {
                                default(EntityHandle?)
                            }
                        )
                    }
                    if (declaration != nil) {
                        let body = this.GetEventAccessorBody(
                            structSymbol,
                            declaringType!!,
                            ev!!,
                            isAdd: true,
                            implAccessors.Add
                        )
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, body, declaration)
                    }
                }
                if slotEvent.RemoveMethodSymbol != nil {
                    let declaration = if isGenericIface {
                        this
                            .outer
                            .userTokens
                            .ResolveUserInterfaceInstanceMethodToken(iface, slotEvent.RemoveMethodSymbol!!)
                    } else {
                        (
                            if this.cache.MethodHandles.TryGetValue(slotEvent.RemoveMethodSymbol!!, out var handle) {
                                handle
                            } else {
                                default(EntityHandle?)
                            }
                        )
                    }
                    if (declaration != nil) {
                        let body = this.GetEventAccessorBody(
                            structSymbol,
                            declaringType!!,
                            ev!!,
                            isAdd: false,
                            implAccessors.Remove
                        )
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, body, declaration)
                    }
                }
            }
        }
        let emittedClrSlots = HashSet[MethodInfo]()
        for ifaceSymbol in structSymbol.ImplementedClrInterfaces {
            let declaredInterface = ifaceSymbol?.ClrType
            if declaredInterface?.IsInterface != true {
                continue
            }
            let interfaces = List[Type]{declaredInterface}
            interfaces.AddRange(declaredInterface!!.GetInterfaces())
            for clrInterface in interfaces {
                for slotEvent in clrInterface.GetEvents(
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                ) {
                    let containingType = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                        Invariant.Required(
                            ifaceSymbol,
                            "a CLR interface entry has a type symbol",
                            expression: "ifaceSymbol"
                        ),
                        slotEvent
                    )
                    let slotType = MemberLookup.GetClrEventHandlerTypeSymbol(containingType, slotEvent)
                    if IsImportedSlotExplicitlyImplemented(structSymbol, slotEvent) ||
                        !TryFindImplicitEvent(
                        structSymbol,
                        slotEvent.Name,
                        slotType,
                        out var ev,
                        out var declaringType
                    ) ||
                        (object.ReferenceEquals(declaringType, structSymbol) && ev!!.IsFieldLike) ||
                        !this
                        .cache
                        .EventAccessorHandles
                        .TryGetValue(ev!!, out var implAccessors) {
                        continue
                    }
                    if slotEvent.AddMethod != nil && emittedClrSlots.Add(slotEvent.AddMethod!!) {
                        let declaration = this
                            .outer
                            .memberRefs
                            .GetMethodEntityHandle(slotEvent.AddMethod!!, containingType)
                        let body = this.GetEventAccessorBody(
                            structSymbol,
                            declaringType!!,
                            ev!!,
                            isAdd: true,
                            implAccessors.Add
                        )
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, body, declaration)
                    }
                    if slotEvent.RemoveMethod != nil && emittedClrSlots.Add(slotEvent.RemoveMethod!!) {
                        let declaration = this
                            .outer
                            .memberRefs
                            .GetMethodEntityHandle(slotEvent.RemoveMethod!!, containingType)
                        let body = this.GetEventAccessorBody(
                            structSymbol,
                            declaringType!!,
                            ev!!,
                            isAdd: false,
                            implAccessors.Remove
                        )
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, body, declaration)
                    }
                }
            }
        }
    }

    internal func PlanImportedAccessorBridges(structSymbol StructSymbol, firstMethodRow int32) int32 {
        let bridges = List[ImportedAccessorBridge]()
        for selection in structSymbol.ImportedInterfaceAccessors {
            if selection
                .Accessor
                .IsVirtual ||
                SourceBaseImplementsInterface(structSymbol.BaseClass, selection.Interface) {
                continue
            }
            let handle = MetadataTokens.MethodDefinitionHandle(firstMethodRow + bridges.Count)
            // A type-local ordinal keeps names stable when reference emit omits unrelated synthesized rows.
            let namePrefix = ExplicitInterfaceMetadataNaming.GetMetadataName(
                selection.Accessor.Name,
                selection.Interface
            )
            bridges.Add(
                ImportedAccessorBridge(
                    selection.Interface,
                    selection.Property,
                    selection.Accessor,
                    selection.ContainingType,
                    selection.IsSetter,
                    handle,
                    "$namePrefix$$forwarder${bridges.Count}"
                )
            )
        }
        this.importedAccessorBridges[structSymbol] = bridges
        return bridges.Count
    }

    internal func EmitImportedAccessorBridges(structSymbol StructSymbol) {
        for bridge in this.importedAccessorBridges[structSymbol] {
            let slot = if bridge.IsSetter {
                bridge.Property.SetterSymbol
            } else {
                bridge.Property.GetterSymbol
            }
            let declaration = this
                .outer
                .userTokens
                .ResolveUserInterfaceInstanceMethodToken(
                bridge.Interface,
                Invariant.Required(slot, "a selected interface accessor has its slot symbol", expression: "slot")
            )
            var bodyOffset = -1
            let parameterCount = bridge
                .Property
                .Parameters
                .Length +
                (
                if bridge.IsSetter {
                    1
                } else {
                    0
                }
            )
            if !this.emitCtx.MetadataOnly {
                let il = InstructionEncoder(BlobBuilder())
                for var i = 0; i <= parameterCount; i++ {
                    il.LoadArgument(i)
                }
                il.OpCode(ILOpCode.Call)
                il.Token(this.outer.memberRefs.GetMethodEntityHandle(bridge.Accessor, bridge.ContainingType))
                il.OpCode(ILOpCode.Ret)
                bodyOffset = this
                    .emitCtx
                    .MethodBodyStream
                    .AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
            }
            let typeMap = DeclarationBinder.BuildInterfaceTypeParameterMap(bridge.Interface)
            let propertyType = DeclarationBinder.GetInterfacePropertyExpectedType(bridge.Property.Type, typeMap)
            let signature = BlobBuilder()
            BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
                parameterCount,
                (returnType ReturnTypeEncoder) -> {
                    if bridge.IsSetter && bridge.Property.IsInitOnly {
                        let isExternalInit = this.outer.wellKnown.GetIsExternalInitTypeRef()
                        if !isExternalInit.IsNil {
                            returnType.CustomModifiers().AddModifier(isExternalInit, isOptional: false)
                        }
                    }
                    this
                        .outer
                        .signatures
                        .EncodeReturnSymbol(
                        returnType,
                        if bridge.IsSetter {
                            TypeSymbol.Void
                        } else {
                            propertyType
                        },
                        if bridge.IsSetter {
                            RefKind.None
                        } else {
                            bridge.Property.ReturnRefKind
                        }
                    )
                },
                (parameters ParametersEncoder) -> {
                    for parameter in bridge.Property.Parameters {
                        TypeDefEmitter.EncodeParameterSignature(
                            parameters,
                            parameter,
                            (encoder SignatureTypeEncoder, type TypeSymbol) -> this
                                .outer
                                .signatures
                                .EncodeTypeSymbol(
                                encoder,
                                DeclarationBinder.GetInterfacePropertySlotType(type, typeMap)
                            ),
                            this.outer.wellKnown
                        )
                    }
                    if bridge.IsSetter {
                        this.outer.signatures.EncodeTypeSymbol(parameters.AddParameter().Type(), propertyType)
                    }
                }
            )
            // Issue #4988: the bridge's rows and nullability come from the
            // same plan as every other signature, over its slot types.
            let bridgeParameters = ImmutableArray.CreateBuilder[ParameterSymbol](parameterCount)
            for parameter in bridge.Property.Parameters {
                bridgeParameters.Add(
                    ParameterSymbol(parameter, DeclarationBinder.GetInterfacePropertySlotType(parameter.Type, typeMap))
                )
            }
            if bridge.IsSetter {
                bridgeParameters.Add(ParameterSymbol("value", propertyType))
            }
            let bridgeRows = ParameterMetadataEmitter.AddSignatureRows(
                this.emitCtx,
                if bridge.IsSetter {
                    TypeSymbol.Void
                } else {
                    propertyType
                },
                RefKind.None,
                bridgeParameters.MoveToImmutable()
            )
            for var i = 0; i < bridgeRows.Rows.Length; i++ {
                if bridgeRows.Parameters[i].RefKind == RefKind.In {
                    this.outer.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter(bridgeRows.Rows[i])
                }
            }
            let firstParameter = bridgeRows.First
            let emittedHandle = this
                .emitCtx
                .Metadata
                .AddMethodDefinition(
                MethodAttributes.Private | MethodAttributes.Final | MethodAttributes.Virtual | MethodAttributes.HideBySig | MethodAttributes.NewSlot | MethodAttributes.SpecialName,
                MethodImplAttributes.IL | MethodImplAttributes.Managed,
                this.emitCtx.Metadata.GetOrAddString(bridge.Name),
                this.emitCtx.Metadata.GetOrAddBlob(signature),
                bodyOffset,
                firstParameter
            )
            if emittedHandle != bridge.Handle {
                throw InvalidOperationException(
                    "Imported accessor bridge MethodDef row was not emitted in planned order."
                )
            }
            this
                .outer
                .customAttrEncoder
                .EmitMethodNullability(emittedHandle, bridgeRows.Nullability, bridgeRows.ReturnRow, bridgeRows.Rows)
            this
                .emitCtx
                .Metadata
                .AddMethodImplementation(this.cache.StructTypeDefs[structSymbol], bridge.Handle, declaration)
        }
    }

    internal func PlanInheritedEventBridges(structSymbol StructSymbol, firstMethodRow int32) int32 {
        var nextMethodRow = firstMethodRow
        let PlanBridge = func (ev EventSymbol) {
            if !this.inheritedEventBridges.TryGetValue(structSymbol, out var bridges) {
                bridges = List[InheritedEventBridge]()
                this.inheritedEventBridges[structSymbol] = bridges
            }
            for existing in bridges {
                if object.ReferenceEquals(existing.Event, ev) {
                    return
                }
            }
            // Issue #4114: one MethodDef row each for add_/remove_, assigned to
            // named locals across separate statements (matching every other
            // row-reservation loop in ReflectionMetadataEmitter.cs, e.g. the
            // property-getter/setter and class-event add/remove/raise loops)
            // rather than as two `nextMethodRow++` post-increments inline in
            // one constructor call. The two forms are equivalent C#, but the
            // cs2gs-translated build of this method once collapsed the inline
            // form's two increments into one read of the pre-increment value
            // used twice, handing add_ and remove_ the SAME planned row and
            // tripping "Inherited event bridge MethodDef row was not emitted
            // in planned order" (GS9998) the first time this method itself
            // ran self-hosted. The root cause was cs2gs's postfix-hoist
            // lowering (fixed in CSharpToGSharpTranslator.Statements.cs'
            // WithHoistedPostfix); this shape is kept as defense in depth so
            // a future translator change can't reopen the same trap here.
            let addHandle = MetadataTokens.MethodDefinitionHandle(nextMethodRow)
            nextMethodRow++
            let removeHandle = MetadataTokens.MethodDefinitionHandle(nextMethodRow)
            nextMethodRow++
            bridges.Add(InheritedEventBridge(ev, addHandle, removeHandle))
        }
        for iface in structSymbol.Interfaces {
            let defIface = iface.Definition ?? iface
            for slotEvent in defIface.Events {
                if !IsExplicitlyImplemented(structSymbol, slotEvent) &&
                    TryFindImplicitEvent(structSymbol, iface, slotEvent, out var ev, out var declaringType) &&
                    !object.ReferenceEquals(declaringType, structSymbol) {
                    PlanBridge(ev!!)
                }
            }
        }
        for ifaceSymbol in structSymbol.ImplementedClrInterfaces {
            let declaredInterface = ifaceSymbol?.ClrType
            if declaredInterface?.IsInterface != true {
                continue
            }
            let interfaces = List[Type]{declaredInterface}
            interfaces.AddRange(declaredInterface!!.GetInterfaces())
            for clrInterface in interfaces {
                for slotEvent in clrInterface.GetEvents(
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                ) {
                    let containingType = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                        Invariant.Required(
                            ifaceSymbol,
                            "a CLR interface entry has a type symbol",
                            expression: "ifaceSymbol"
                        ),
                        slotEvent
                    )
                    let slotType = MemberLookup.GetClrEventHandlerTypeSymbol(containingType, slotEvent)
                    if !IsImportedSlotExplicitlyImplemented(structSymbol, slotEvent) &&
                        TryFindImplicitEvent(
                        structSymbol,
                        slotEvent.Name,
                        slotType,
                        out var ev,
                        out var declaringType
                    ) &&
                        !object.ReferenceEquals(declaringType, structSymbol) {
                        PlanBridge(ev!!)
                    }
                }
            }
        }
        return nextMethodRow - firstMethodRow
    }

    internal func EmitInheritedEventBridges(structSymbol StructSymbol) {
        if !this.inheritedEventBridges.TryGetValue(structSymbol, out var bridges) {
            return
        }
        for bridge in bridges {
            let declaringType = FindDeclaringType(structSymbol, bridge.Event)
            this.EmitInheritedEventBridge(declaringType, bridge.Event, bridge.Add, isAdd: true)
            this.EmitInheritedEventBridge(declaringType, bridge.Event, bridge.Remove, isAdd: false)
        }
    }

    private func GetEventAccessorBody(
        implementingType StructSymbol,
        declaringType StructSymbol,
        ev EventSymbol,
        isAdd bool,
        definition MethodDefinitionHandle
    ) EntityHandle {
        if object.ReferenceEquals(implementingType, declaringType) {
            return definition
        }
        for bridge in this.inheritedEventBridges[implementingType] {
            if object.ReferenceEquals(bridge.Event, ev) {
                return if isAdd {
                    bridge.Add
                } else {
                    bridge.Remove
                }
            }
        }
        throw InvalidOperationException("Inherited event bridge was not planned.")
    }

    private func EmitInheritedEventBridge(
        declaringType StructSymbol,
        ev EventSymbol,
        expectedHandle MethodDefinitionHandle,
        isAdd bool
    ) {
        let accessors = this.cache.EventAccessorHandles[ev]
        let accessor FunctionSymbol? = if isAdd {
            ev.AddMethodSymbol
        } else {
            ev.RemoveMethodSymbol
        }
        let target = if declaringType.Definition != nil && !object.ReferenceEquals(
            declaringType.Definition,
            declaringType
        ) &&
            accessor != nil {
            this.outer.userTokens.ResolveUserInstanceMethodToken(declaringType, accessor)
        } else {
            (
                if isAdd {
                    accessors.Add
                } else {
                    accessors.Remove
                }
            )
        }
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            let il = InstructionEncoder(BlobBuilder())
            il.LoadArgument(0)
            il.LoadArgument(1)
            il.OpCode(ILOpCode.Call)
            il.Token(target)
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let eventType = declaringType.SubstituteMemberType(ev.Type)
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (returnType ReturnTypeEncoder) -> returnType.Void(),
            (parameters ParametersEncoder) -> this
                .outer
                .signatures
                .EncodeTypeSymbol(parameters.AddParameter().Type(), eventType)
        )
        let bridgeRows = ParameterMetadataEmitter.AddSignatureRows(
            this.emitCtx,
            TypeSymbol.Void,
            RefKind.None,
            ImmutableArray.Create(
                ParameterSymbol(
                    "value",
                    Invariant.Required(eventType, "an inherited event's handler type substitutes into its bridge")
                )
            )
        )
        let firstParameter = bridgeRows.First
        let emittedHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            MethodAttributes.Private | MethodAttributes.Final | MethodAttributes.Virtual | MethodAttributes.HideBySig | MethodAttributes.NewSlot | MethodAttributes.SpecialName,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this
                .emitCtx
                .Metadata
                .GetOrAddString(
                (
                    if isAdd {
                        "add_"
                    } else {
                        "remove_"
                    }
                ) +
                    ev.Name
            ),
            this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset,
            firstParameter
        )
        if emittedHandle != expectedHandle {
            throw InvalidOperationException("Inherited event bridge MethodDef row was not emitted in planned order.")
        }
        this
            .outer
            .customAttrEncoder
            .EmitMethodNullability(emittedHandle, bridgeRows.Nullability, bridgeRows.ReturnRow, bridgeRows.Rows)
    }

    /// Issue #4620: plans private static forwarding bridges on
    /// [`structSymbol`](paramref) for static-virtual interface slots (methods,
    /// property accessors and event accessors) whose matching implementation
    /// is inherited from a G# base class (`declaringType != structSymbol`).
    /// ECMA-335 requires `MethodImpl.Body` to be a `MethodDef` declared on the
    /// implementing type itself, so each inherited static member gets one
    /// synthesized static forwarder on [`structSymbol`](paramref).
    internal func PlanInheritedStaticVirtualBridges(structSymbol StructSymbol, firstMethodRow int32) int32 {
        if !structSymbol.IsClass ||
            structSymbol.BaseClass == nil ||
            (
            !HasStaticMethodsInHierarchy(structSymbol.BaseClass) &&
                !HasStaticPropertiesInHierarchy(structSymbol.BaseClass) &&
                !HasStaticEventsInHierarchy(structSymbol.BaseClass)
        ) {
            return 0
        }
        var nextMethodRow = firstMethodRow
        let EnsureList = func () List[InheritedStaticBridge] {
            if !this.inheritedStaticBridges.TryGetValue(structSymbol, out var list) {
                list = List[InheritedStaticBridge]()
                this.inheritedStaticBridges[structSymbol] = list
            }
            return list
        }
        let PlanMethodBridge = func (declaringType StructSymbol, method FunctionSymbol) {
            let bridges = EnsureList()
            for existing in bridges {
                if object.ReferenceEquals(existing.Method, method) {
                    return
                }
            }
            let handle = MetadataTokens.MethodDefinitionHandle(nextMethodRow)
            nextMethodRow++
            bridges.Add(
                InheritedStaticBridge(
                    DeclaringType: declaringType,
                    Method: method,
                    Property: nil,
                    Event: nil,
                    Flag: false,
                    Handle: handle,
                    Name: "<>StaticBridge$$${bridges.Count}_${method.Name}"
                )
            )
        }
        let PlanPropertyBridge = func (declaringType StructSymbol, property PropertySymbol, isSetter bool) {
            let bridges = EnsureList()
            for existing in bridges {
                if object.ReferenceEquals(existing.Property, property) && existing.Flag == isSetter {
                    return
                }
            }
            let handle = MetadataTokens.MethodDefinitionHandle(nextMethodRow)
            nextMethodRow++
            let prefix = if isSetter {
                "set_"
            } else {
                "get_"
            }
            bridges.Add(
                InheritedStaticBridge(
                    DeclaringType: declaringType,
                    Method: nil,
                    Property: property,
                    Event: nil,
                    Flag: isSetter,
                    Handle: handle,
                    Name: "<>StaticBridge$$${bridges.Count}_$prefix${property.Name}"
                )
            )
        }
        let PlanEventBridge = func (declaringType StructSymbol, ev EventSymbol, isAdd bool) {
            let bridges = EnsureList()
            for existing in bridges {
                if object.ReferenceEquals(existing.Event, ev) && existing.Flag == isAdd {
                    return
                }
            }
            let handle = MetadataTokens.MethodDefinitionHandle(nextMethodRow)
            nextMethodRow++
            let prefix = if isAdd {
                "add_"
            } else {
                "remove_"
            }
            bridges.Add(
                InheritedStaticBridge(
                    DeclaringType: declaringType,
                    Method: nil,
                    Property: nil,
                    Event: ev,
                    Flag: isAdd,
                    Handle: handle,
                    Name: "<>StaticBridge$$${bridges.Count}_$prefix${ev.Name}"
                )
            )
        }
        for iface in structSymbol.Interfaces {
            if !iface.StaticMethods.IsDefaultOrEmpty {
                for slot in iface.StaticMethods {
                    if !TryFindUserStaticVirtualMethod(structSymbol, slot, out var impl, out var declaringType) {
                        continue
                    }
                    if !object.ReferenceEquals(declaringType, structSymbol) {
                        PlanMethodBridge(declaringType, impl)
                    }
                }
            }
            let defIface = iface.Definition ?? iface
            if !defIface.Properties.IsDefaultOrEmpty {
                for slotProp in defIface.Properties {
                    if !slotProp.IsStatic {
                        continue
                    }
                    if !TryFindUserStaticVirtualProperty(
                        structSymbol,
                        iface,
                        slotProp,
                        out var implProp,
                        out var declaringType
                    ) {
                        continue
                    }
                    if !object.ReferenceEquals(declaringType, structSymbol) {
                        if slotProp.HasGetter &&
                            implProp.HasGetter &&
                            implProp.GetterAccessibility == Accessibility.Public {
                            PlanPropertyBridge(declaringType, implProp, isSetter: false)
                        }
                        if slotProp.HasSetter &&
                            implProp.HasSetter &&
                            implProp.SetterAccessibility == Accessibility.Public {
                            PlanPropertyBridge(declaringType, implProp, isSetter: true)
                        }
                    }
                }
            }
        }
        if !structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty {
            for (symbolicIface, concreteIface) in DeclarationBinder.EnumerateClrInterfaceClosure(structSymbol) {
                var openIface Type? = nil
                var symbolicArgs = default(ImmutableArray[TypeSymbol])
                if symbolicIface != nil && !MemberLookup.TryGetSymbolicClrGenericInterface(
                    symbolicIface,
                    out openIface,
                    out symbolicArgs
                ) {
                    continue
                }
                let slotOwner Type? = if symbolicIface != nil {
                    symbolicIface.ClrType
                } else {
                    concreteIface
                }
                if slotOwner == nil {
                    continue
                }
                for slot in ClrTypeUtilities.SafeGetMethods(
                    slotOwner,
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly
                ) {
                    if !slot.IsVirtual || DeclarationBinder.IsClrStaticPropertyOrEventAccessor(slotOwner, slot) {
                        continue
                    }
                    if !DeclarationBinder.TryFindClrStaticVirtualMethodImplementation(
                        structSymbol,
                        slot,
                        openIface,
                        symbolicArgs,
                        out var impl,
                        out _,
                        out var declaringType,
                        out _
                    ) {
                        continue
                    }
                    if !object.ReferenceEquals(declaringType, structSymbol) {
                        PlanMethodBridge(declaringType, impl)
                    }
                }
                let slotOwnerSymbol = symbolicIface ?? TypeSymbol.FromClrTypeWithoutNullability(
                    slotOwner,
                    NullabilityFreeReason.TypeStructure
                )
                for slotEvent in ClrTypeUtilities.SafeGetEvents(
                    slotOwner,
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly
                ) {
                    let slotAdd = slotEvent.AddMethod is {IsVirtual: true}
                    let slotRemove = slotEvent.RemoveMethod is {IsVirtual: true}
                    if !slotAdd && !slotRemove {
                        continue
                    }
                    if !DeclarationBinder.TryFindClrStaticVirtualEventImplementation(
                        structSymbol,
                        slotOwnerSymbol,
                        slotEvent,
                        out var implEvent,
                        out var declaringType
                    ) {
                        continue
                    }
                    if !object.ReferenceEquals(declaringType, structSymbol) {
                        if slotAdd {
                            PlanEventBridge(declaringType, implEvent, isAdd: true)
                        }
                        if slotRemove {
                            PlanEventBridge(declaringType, implEvent, isAdd: false)
                        }
                    }
                }
                for slotProperty in ClrTypeUtilities.SafeGetProperties(
                    slotOwner,
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly
                ) {
                    let slotGetter = slotProperty.GetMethod is {IsVirtual: true}
                    let slotSetter = slotProperty.SetMethod is {IsVirtual: true}
                    if !slotGetter && !slotSetter {
                        continue
                    }
                    if !DeclarationBinder.TryFindClrStaticVirtualPropertyImplementation(
                        structSymbol,
                        slotOwnerSymbol,
                        slotProperty,
                        out var implProp,
                        out var declaringType
                    ) {
                        continue
                    }
                    if !object.ReferenceEquals(declaringType, structSymbol) {
                        if slotGetter && implProp.HasGetter && implProp.GetterAccessibility == Accessibility.Public {
                            PlanPropertyBridge(declaringType, implProp, isSetter: false)
                        }
                        if slotSetter && implProp.HasSetter && implProp.SetterAccessibility == Accessibility.Public {
                            PlanPropertyBridge(declaringType, implProp, isSetter: true)
                        }
                    }
                }
            }
        }
        return nextMethodRow - firstMethodRow
    }

    internal func EmitInheritedStaticVirtualBridges(structSymbol StructSymbol) {
        if !this.inheritedStaticBridges.TryGetValue(structSymbol, out var bridges) {
            return
        }
        for bridge in bridges {
            if bridge.Method != nil {
                this.EmitInheritedStaticMethodBridge(bridge)
            } else if bridge.Property != nil {
                this.EmitInheritedStaticPropertyBridge(bridge)
            } else if bridge.Event != nil {
                this.EmitInheritedStaticEventBridge(bridge)
            }
        }
    }

    private func EmitInheritedStaticMethodBridge(bridge InheritedStaticBridge) {
        let defMethod = Invariant.Required(bridge.Method, "a static method bridge has a method")
        let effectiveMethod = DeclarationBinder.SubstituteStaticMethodForOwner(bridge.DeclaringType, defMethod)
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            var target = this.outer.userTokens.ResolveUserStaticMethodToken(bridge.DeclaringType, defMethod)
            if !defMethod.TypeParameters.IsDefaultOrEmpty {
                let specSig = BlobBuilder()
                let argsEnc = BlobEncoder(specSig).MethodSpecificationSignature(defMethod.TypeParameters.Length)
                for tp in defMethod.TypeParameters {
                    this.outer.signatures.EncodeTypeSymbol(argsEnc.AddArgument(), tp)
                }
                target = this
                    .emitCtx
                    .MetadataRows
                    .AddMethodSpecification(target, this.emitCtx.Metadata.GetOrAddBlob(specSig))
            }
            let il = InstructionEncoder(BlobBuilder())
            for var i = 0; i < effectiveMethod.EmittedParameters.Length; i++ {
                il.LoadArgument(i)
            }
            il.OpCode(ILOpCode.Call)
            il.Token(target)
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let signature = this.outer.userTokens.EncodeOpenMethodSignature(effectiveMethod)
        var returnTypeForMetadata = effectiveMethod.Type
        if defMethod.IsAsyncOrSuspending && defMethod.StateMachineType != nil {
            for plan in this.outer.stateMachines.AsyncStateMachinePlans {
                if plan.KickoffMethod == defMethod {
                    returnTypeForMetadata = if this.outer.GetAsyncReturnTypeSymbol(plan) is {} asyncReturnType {
                        bridge.DeclaringType.SubstituteMemberType(asyncReturnType) ?? asyncReturnType
                    } else {
                        TypeSymbol.Void
                    }
                    break
                }
            }
        }
        let bridgeRows = ParameterMetadataEmitter.AddSignatureRows(
            this.emitCtx,
            returnTypeForMetadata,
            effectiveMethod.ReturnRefKind,
            effectiveMethod.EmittedParameters
        )
        for var i = 0; i < bridgeRows.Rows.Length; i++ {
            if bridgeRows.Parameters[i].RefKind == RefKind.In {
                this.outer.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter(bridgeRows.Rows[i])
            }
        }
        var methodAttrs = MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.Static
        if defMethod.IsSpecialName {
            methodAttrs |= MethodAttributes.SpecialName
        }
        let emittedHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            methodAttrs,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString(bridge.Name),
            this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset,
            bridgeRows.First
        )
        if emittedHandle != bridge.Handle {
            throw InvalidOperationException("Inherited static bridge MethodDef row was not emitted in planned order.")
        }
        if !defMethod.TypeParameters.IsDefaultOrEmpty {
            let gpRowStart = this.emitCtx.PendingGenericParameters.Count
            TypeDefEmitter.EmitGenericParamRows(this.emitCtx, emittedHandle, defMethod.TypeParameters)
            let pendingRows = this.emitCtx.PendingGenericParameters
            for var gi = gpRowStart; gi < pendingRows.Count; gi++ {
                let gpRow = pendingRows[gi]
                if gpRow.InterfaceConstraintType != nil {
                    let substitutedConstraint = bridge.DeclaringType.SubstituteMemberType(
                        gpRow.InterfaceConstraintType
                    ) ??
                        gpRow.InterfaceConstraintType
                    pendingRows[gi] = gpRow with{
                        InterfaceConstraintType = substitutedConstraint,
                        PreResolvedConstraintHandle = this.outer.memberRefs.GetElementTypeToken(substitutedConstraint)
                    }
                }
            }
        }
        this
            .outer
            .customAttrEncoder
            .EmitMethodNullability(emittedHandle, bridgeRows.Nullability, bridgeRows.ReturnRow, bridgeRows.Rows)
    }

    private func EmitInheritedStaticPropertyBridge(bridge InheritedStaticBridge) {
        let prop = Invariant.Required(bridge.Property, "a static property bridge has a property")
        let isSetter = bridge.Flag
        let parameterCount = prop
            .Parameters
            .Length +
            (
            if isSetter {
                1
            } else {
                0
            }
        )
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            let target = this
                .outer
                .userTokens
                .ResolveUserPropertyAccessorToken(bridge.DeclaringType, prop, wantSetter: isSetter)
            let il = InstructionEncoder(BlobBuilder())
            for var i = 0; i < parameterCount; i++ {
                il.LoadArgument(i)
            }
            il.OpCode(ILOpCode.Call)
            il.Token(target)
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let signature = this
            .outer
            .userTokens
            .EncodeOpenPropertyAccessorSignature(prop, wantSetter: isSetter, bridge.DeclaringType)
        let bridgeParameters = ImmutableArray.CreateBuilder[ParameterSymbol](parameterCount)
        for parameter in prop.Parameters {
            bridgeParameters.Add(parameter)
        }
        if isSetter {
            bridgeParameters.Add(ParameterSymbol("value", prop.Type))
        }
        let bridgeRows = ParameterMetadataEmitter.AddSignatureRows(
            this.emitCtx,
            if isSetter {
                TypeSymbol.Void
            } else {
                prop.Type
            },
            if isSetter {
                RefKind.None
            } else {
                prop.ReturnRefKind
            },
            bridgeParameters.MoveToImmutable()
        )
        for var i = 0; i < bridgeRows.Rows.Length; i++ {
            if bridgeRows.Parameters[i].RefKind == RefKind.In {
                this.outer.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter(bridgeRows.Rows[i])
            }
        }
        let emittedHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.Static | MethodAttributes.SpecialName,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString(bridge.Name),
            this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset,
            bridgeRows.First
        )
        if emittedHandle != bridge.Handle {
            throw InvalidOperationException("Inherited static bridge MethodDef row was not emitted in planned order.")
        }
        this
            .outer
            .customAttrEncoder
            .EmitMethodNullability(emittedHandle, bridgeRows.Nullability, bridgeRows.ReturnRow, bridgeRows.Rows)
    }

    private func EmitInheritedStaticEventBridge(bridge InheritedStaticBridge) {
        let ev = Invariant.Required(bridge.Event, "a static event bridge has an event")
        let isAdd = bridge.Flag
        let accessors = this.cache.EventAccessorHandles[ev]
        let accessorHandle = if isAdd {
            accessors.Add
        } else {
            accessors.Remove
        }
        let accessorSymbol FunctionSymbol? = if isAdd {
            ev.AddMethodSymbol
        } else {
            ev.RemoveMethodSymbol
        }
        var bodyOffset = -1
        if !this.emitCtx.MetadataOnly {
            let target = if ReflectionMetadataEmitter.IsUserGenericTypeReference(bridge.DeclaringType) &&
                accessorSymbol != nil {
                this.outer.userTokens.ResolveUserStaticMethodToken(bridge.DeclaringType, accessorSymbol, accessorHandle)
            } else {
                EntityHandle(accessorHandle)
            }
            let il = InstructionEncoder(BlobBuilder())
            il.LoadArgument(0)
            il.OpCode(ILOpCode.Call)
            il.Token(target)
            il.OpCode(ILOpCode.Ret)
            bodyOffset = this.emitCtx.MethodBodyStream.AddMethodBody(il, maxStack: MaxStackTracker.ComputeMaxStack(il))
        }
        let eventType = Invariant.Required(
            bridge.DeclaringType.SubstituteMemberType(ev.Type),
            "an inherited static event's handler type substitutes into its bridge"
        )
        let signature = BlobBuilder()
        BlobEncoder(signature).MethodSignature(isInstanceMethod: false).Parameters(
            1,
            (returnType ReturnTypeEncoder) -> returnType.Void(),
            (parameters ParametersEncoder) -> this
                .outer
                .signatures
                .EncodeTypeSymbol(parameters.AddParameter().Type(), eventType)
        )
        let bridgeRows = ParameterMetadataEmitter.AddSignatureRows(
            this.emitCtx,
            TypeSymbol.Void,
            RefKind.None,
            ImmutableArray.Create(ParameterSymbol("value", eventType))
        )
        let emittedHandle = this
            .emitCtx
            .Metadata
            .AddMethodDefinition(
            MethodAttributes.Private | MethodAttributes.HideBySig | MethodAttributes.Static | MethodAttributes.SpecialName,
            MethodImplAttributes.IL | MethodImplAttributes.Managed,
            this.emitCtx.Metadata.GetOrAddString(bridge.Name),
            this.emitCtx.Metadata.GetOrAddBlob(signature),
            bodyOffset,
            bridgeRows.First
        )
        if emittedHandle != bridge.Handle {
            throw InvalidOperationException("Inherited static bridge MethodDef row was not emitted in planned order.")
        }
        this
            .outer
            .customAttrEncoder
            .EmitMethodNullability(emittedHandle, bridgeRows.Nullability, bridgeRows.ReturnRow, bridgeRows.Rows)
    }

    private func TryGetStaticMethodBody(
        implementingType StructSymbol,
        declaringType StructSymbol,
        method FunctionSymbol,
        out body EntityHandle
    ) bool {
        if object.ReferenceEquals(implementingType, declaringType) {
            if this.cache.MethodHandles.TryGetValue(method, out var defHandle) {
                body = defHandle
                return true
            }
            body = default(EntityHandle)
            return false
        }
        if this.inheritedStaticBridges.TryGetValue(implementingType, out var bridges) {
            for bridge in bridges {
                if object.ReferenceEquals(bridge.Method, method) {
                    body = bridge.Handle
                    return true
                }
            }
        }
        body = default(EntityHandle)
        return false
    }

    private func TryGetStaticPropertyAccessorBody(
        implementingType StructSymbol,
        declaringType StructSymbol,
        property PropertySymbol,
        isSetter bool,
        out body EntityHandle
    ) bool {
        if object.ReferenceEquals(implementingType, declaringType) {
            if this.cache.PropertyAccessorHandles.TryGetValue(property, out var implAccessors) {
                let handle = if isSetter {
                    implAccessors.Setter
                } else {
                    implAccessors.Getter
                }
                if handle != nil {
                    body = handle
                    return true
                }
            }
            body = default(EntityHandle)
            return false
        }
        if this.inheritedStaticBridges.TryGetValue(implementingType, out var bridges) {
            for bridge in bridges {
                if object.ReferenceEquals(bridge.Property, property) && bridge.Flag == isSetter {
                    body = bridge.Handle
                    return true
                }
            }
        }
        body = default(EntityHandle)
        return false
    }

    private func TryGetStaticEventAccessorBody(
        implementingType StructSymbol,
        declaringType StructSymbol,
        ev EventSymbol,
        isAdd bool,
        out body EntityHandle
    ) bool {
        if object.ReferenceEquals(implementingType, declaringType) {
            if this.cache.EventAccessorHandles.TryGetValue(ev, out var implAccessors) {
                body = if isAdd {
                    implAccessors.Add
                } else {
                    implAccessors.Remove
                }
                return true
            }
            body = default(EntityHandle)
            return false
        }
        if this.inheritedStaticBridges.TryGetValue(implementingType, out var bridges) {
            for bridge in bridges {
                if object.ReferenceEquals(bridge.Event, ev) && bridge.Flag == isAdd {
                    body = bridge.Handle
                    return true
                }
            }
        }
        body = default(EntityHandle)
        return false
    }

    /// ADR-0089 / issue #755: emit MethodImpl rows binding each declared
    /// static-virtual interface slot to the implementer's matching static
    /// method on [`structSymbol`](paramref). Best-effort match — if
    /// the implementer is missing the slot, the binder has already issued
    /// GS0331/GS0332 and we skip silently here.
    internal func EmitStaticVirtualMethodImpls(structSymbol StructSymbol?) {
        if structSymbol == nil ||
            structSymbol
            .Interfaces
            .IsDefaultOrEmpty ||
            !HasStaticMethodsInHierarchy(structSymbol) {
            return
        }
        if !this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef) {
            return
        }
        for iface in structSymbol.Interfaces {
            if iface.StaticMethods.IsDefaultOrEmpty {
                continue
            }
            // Issue #1268: when the implemented interface is a constructed
            // generic (e.g. `TrackNumber : IData[TrackNumber]`), its
            // `StaticMethods` are substituted instances that are NOT keyed in
            // `MethodHandles`; only the open definition's slots are. Resolve
            // each substituted slot back to its open counterpart for the
            // MethodDef lookup, and parent the MethodImpl's declaration at the
            // constructed interface's TypeSpec (a MemberRef) so the runtime can
            // pair the override against `IData`1<TrackNumber>::Method`.
            let isGenericIface = ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface)
            for slot in iface.StaticMethods {
                let openSlot = ResolveOpenInterfaceStaticMethod(iface, slot)
                if !this.cache.MethodHandles.TryGetValue(openSlot, out var slotDefHandle) {
                    continue
                }
                let slotHandle = if isGenericIface {
                    this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, openSlot)
                } else {
                    slotDefHandle
                }
                if !TryFindUserStaticVirtualMethod(structSymbol, slot, out var implMatch, out var declaringType) {
                    continue
                }
                if !this.TryGetStaticMethodBody(structSymbol, declaringType, implMatch, out var implHandle) {
                    continue
                }
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, slotHandle)
            }
        }
    }

    /// Issue #4614 / #4620: emit `MethodImpl` rows binding the static-virtual
    /// (static abstract or defaulted static virtual) slots of the imported
    /// CLR interfaces [`structSymbol`](paramref) implements to its matching
    /// static methods (own or inherited from a G# base class via a
    /// synthesized static bridge).
    /// @remarks The CLR never binds a static-virtual slot by name: without a
    /// `MethodImpl` a direct implementer (`struct SD : IS`) failed
    /// to load, and a type re-listing such an interface over an imported base
    /// that already implements it (`class DZ : BaseS, IS2`) silently kept
    /// the base's implementation. This pass binds the type's own static
    /// member of the same name and signature implicitly, as csc does, with
    /// one deliberate difference: csc requires that member to be public,
    /// while this pass (like (cref:EmitStaticVirtualMethodImpls) for
    /// G#-declared interfaces) applies no accessibility check to own-type
    /// members, so an own-type member of any accessibility implements the
    /// slot (an inherited member on a G# base class must be public). That is
    /// G#'s existing policy, not an omission. The interfaces
    /// come from (cref:ClrInterfaceClosure), the same set the type's
    /// `InterfaceImpl` rows are emitted from, so slots inherited through
    /// a base interface are covered and every declaration resolves against a
    /// listed interface. A slot the type does not implement gets no row, so
    /// an imported base's implementation (or the slot's default) still
    /// applies.
    /// @param structSymbol The G# type being emitted.
    internal func EmitClrStaticVirtualMethodImpls(structSymbol StructSymbol?) {
        if structSymbol == nil ||
            structSymbol
            .ImplementedClrInterfaces
            .IsDefaultOrEmpty ||
            (
            !HasStaticMethodsInHierarchy(structSymbol) &&
                !HasStaticPropertiesInHierarchy(structSymbol) &&
                !HasStaticEventsInHierarchy(structSymbol)
        ) ||
            !this
            .cache
            .StructTypeDefs
            .TryGetValue(structSymbol, out var implTypeDef) {
            return
        }
        let closure = ClrInterfaceClosure.Build(structSymbol, this.outer.signatures)
        for (symbolicIface, concreteIface) in closure.Entries {
            var openIface Type? = nil
            var symbolicArgs = default(ImmutableArray[TypeSymbol])
            if symbolicIface != nil && !MemberLookup.TryGetSymbolicClrGenericInterface(
                symbolicIface,
                out openIface,
                out symbolicArgs
            ) {
                continue
            }
            let slotOwner Type? = if symbolicIface != nil {
                symbolicIface.ClrType
            } else {
                concreteIface
            }
            if slotOwner == nil {
                continue
            }
            for slot in ClrTypeUtilities.SafeGetMethods(
                slotOwner,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly
            ) {
                if !slot.IsVirtual || DeclarationBinder.IsClrStaticPropertyOrEventAccessor(slotOwner, slot) {
                    continue
                }
                if !DeclarationBinder.TryFindClrStaticVirtualMethodImplementation(
                    structSymbol,
                    slot,
                    openIface,
                    symbolicArgs,
                    out var implementation,
                    out _,
                    out var declaringType,
                    out _
                ) {
                    continue
                }
                if !this.TryGetStaticMethodBody(structSymbol, declaringType, implementation, out var implHandle) {
                    continue
                }
                let declaration = this.outer.memberRefs.GetMethodEntityHandle(slot, symbolicIface)
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, declaration)
            }
            let slotOwnerSymbol = symbolicIface ?? TypeSymbol.FromClrTypeWithoutNullability(
                slotOwner,
                NullabilityFreeReason.TypeStructure
            )
            // Static-virtual event slots bind through their accessors, to the
            // implementer's static event of the same name and handler type.
            this.EmitClrStaticVirtualEventMethodImpls(
                structSymbol,
                implTypeDef,
                slotOwner,
                slotOwnerSymbol,
                symbolicIface
            )
            // Static-virtual property slots bind through their accessors, to
            // the implementer's static property of the same name and type.
            if !HasStaticPropertiesInHierarchy(structSymbol) {
                continue
            }
            for slotProperty in ClrTypeUtilities.SafeGetProperties(
                slotOwner,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly
            ) {
                let slotGetter MethodInfo? = if slotProperty.GetMethod is {IsVirtual: true} virtualGetter {
                    virtualGetter
                } else {
                    default(MethodInfo?)
                }
                let slotSetter MethodInfo? = if slotProperty.SetMethod is {IsVirtual: true} virtualSetter {
                    virtualSetter
                } else {
                    default(MethodInfo?)
                }
                if slotGetter == nil && slotSetter == nil {
                    continue
                }
                if !DeclarationBinder.TryFindClrStaticVirtualPropertyImplementation(
                    structSymbol,
                    slotOwnerSymbol,
                    slotProperty,
                    out var implementation,
                    out var declaringType
                ) {
                    continue
                }
                if slotGetter != nil &&
                    (
                    object.ReferenceEquals(declaringType, structSymbol) ||
                        implementation.GetterAccessibility == Accessibility.Public
                ) &&
                    this
                    .TryGetStaticPropertyAccessorBody(
                    structSymbol,
                    declaringType,
                    implementation,
                    isSetter: false,
                    out var implGetter
                ) {
                    this
                        .emitCtx
                        .Metadata
                        .AddMethodImplementation(
                        implTypeDef,
                        implGetter,
                        this.outer.memberRefs.GetMethodEntityHandle(slotGetter, symbolicIface)
                    )
                }
                if slotSetter != nil &&
                    (
                    object.ReferenceEquals(declaringType, structSymbol) ||
                        implementation.SetterAccessibility == Accessibility.Public
                ) &&
                    this
                    .TryGetStaticPropertyAccessorBody(
                    structSymbol,
                    declaringType,
                    implementation,
                    isSetter: true,
                    out var implSetter
                ) {
                    this
                        .emitCtx
                        .Metadata
                        .AddMethodImplementation(
                        implTypeDef,
                        implSetter,
                        this.outer.memberRefs.GetMethodEntityHandle(slotSetter, symbolicIface)
                    )
                }
            }
        }
    }

    /// Issue #4614 / #4620: binds the static-virtual event slots of one imported
    /// interface (`static abstract event Action Changed;`) to the
    /// implementer's static event of the same name and handler type,
    /// accessor by accessor.
    /// @param structSymbol The implementing G# type.
    /// @param implTypeDef Its TypeDef.
    /// @param slotOwner The (possibly erased) closed interface.
    /// @param slotOwnerSymbol The interface's symbol, for the handler-type reader.
    /// @param symbolicIface The symbolic interface, or `null` for a concrete one.
    private func EmitClrStaticVirtualEventMethodImpls(
        structSymbol StructSymbol,
        implTypeDef TypeDefinitionHandle,
        slotOwner Type,
        slotOwnerSymbol TypeSymbol,
        symbolicIface TypeSymbol?
    ) {
        if !HasStaticEventsInHierarchy(structSymbol) {
            return
        }
        for slotEvent in ClrTypeUtilities.SafeGetEvents(
            slotOwner,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly
        ) {
            let slotAdd MethodInfo? = if slotEvent.AddMethod is {IsVirtual: true} virtualAdd {
                virtualAdd
            } else {
                default(MethodInfo?)
            }
            let slotRemove MethodInfo? = if slotEvent.RemoveMethod is {IsVirtual: true} virtualRemove {
                virtualRemove
            } else {
                default(MethodInfo?)
            }
            if slotAdd == nil && slotRemove == nil {
                continue
            }
            if !DeclarationBinder.TryFindClrStaticVirtualEventImplementation(
                structSymbol,
                slotOwnerSymbol,
                slotEvent,
                out var implementation,
                out var declaringType
            ) {
                continue
            }
            if slotAdd != nil && this.TryGetStaticEventAccessorBody(
                structSymbol,
                declaringType,
                implementation,
                isAdd: true,
                out var addBody
            ) {
                this
                    .emitCtx
                    .Metadata
                    .AddMethodImplementation(
                    implTypeDef,
                    addBody,
                    this.outer.memberRefs.GetMethodEntityHandle(slotAdd, symbolicIface)
                )
            }
            if slotRemove != nil && this.TryGetStaticEventAccessorBody(
                structSymbol,
                declaringType,
                implementation,
                isAdd: false,
                out var removeBody
            ) {
                this
                    .emitCtx
                    .Metadata
                    .AddMethodImplementation(
                    implTypeDef,
                    removeBody,
                    this.outer.memberRefs.GetMethodEntityHandle(slotRemove, symbolicIface)
                )
            }
        }
    }

    /// ADR-0089 / issue #1019: emit `MethodImpl` rows pairing the
    /// implementer's static property accessor methods (`get_Name` /
    /// `set_Name`) to the matching static-virtual interface property
    /// accessor slots. Mirrors (cref:EmitStaticVirtualMethodImpls) but
    /// resolves accessor MethodDef handles through
    /// `PropertyAccessorHandles` (static properties are tracked on
    /// (cref:StructSymbol.StaticProperties), not `StaticMethods`).
    /// @param structSymbol The implementer struct/class.
    internal func EmitStaticVirtualPropertyMethodImpls(structSymbol StructSymbol?) {
        if structSymbol == nil ||
            structSymbol
            .Interfaces
            .IsDefaultOrEmpty ||
            !HasStaticPropertiesInHierarchy(structSymbol) {
            return
        }
        if !this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef) {
            return
        }
        for iface in structSymbol.Interfaces {
            // Issue #1268: a constructed generic interface does not surface its
            // declared properties on the constructed instance (only methods are
            // substituted) — walk the open definition's property table so the
            // static-virtual property slots are found, and parent the
            // MethodImpl declaration at the constructed TypeSpec for generic
            // interfaces.
            let defIface = iface.Definition ?? iface
            if defIface.Properties.IsDefaultOrEmpty {
                continue
            }
            let isGenericIface = ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface)
            for slotProp in defIface.Properties {
                if !slotProp.IsStatic {
                    continue
                }
                if !this.cache.PropertyAccessorHandles.TryGetValue(slotProp, out var slotAccessors) {
                    continue
                }
                if !TryFindUserStaticVirtualProperty(
                    structSymbol,
                    iface,
                    slotProp,
                    out var implProp,
                    out var declaringType
                ) {
                    continue
                }
                if slotProp.HasGetter &&
                    (slotAccessors.Getter != nil) &&
                    (
                    object.ReferenceEquals(declaringType, structSymbol) ||
                        implProp.GetterAccessibility == Accessibility.Public
                ) &&
                    this
                    .TryGetStaticPropertyAccessorBody(
                    structSymbol,
                    declaringType,
                    implProp,
                    isSetter: false,
                    out var getterBody
                ) {
                    let getterDecl = if isGenericIface && slotProp.GetterSymbol != nil {
                        this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, slotProp.GetterSymbol!!)
                    } else {
                        slotAccessors.Getter!!
                    }
                    this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, getterBody, getterDecl)
                }
                if slotProp.HasSetter &&
                    (slotAccessors.Setter != nil) &&
                    (
                    object.ReferenceEquals(declaringType, structSymbol) ||
                        implProp.SetterAccessibility == Accessibility.Public
                ) &&
                    this
                    .TryGetStaticPropertyAccessorBody(
                    structSymbol,
                    declaringType,
                    implProp,
                    isSetter: true,
                    out var setterBody
                ) {
                    let setterDecl = if isGenericIface && slotProp.SetterSymbol != nil {
                        this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, slotProp.SetterSymbol!!)
                    } else {
                        slotAccessors.Setter!!
                    }
                    this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, setterBody, setterDecl)
                }
            }
        }
    }

    private data class InheritedEventBridge(
        Event EventSymbol,
        Add MethodDefinitionHandle,
        Remove MethodDefinitionHandle
    ) : IEquatable[InheritedEventBridge] { }

    private data class ImportedAccessorBridge(
        Interface InterfaceSymbol,
        Property PropertySymbol,
        Accessor MethodInfo,
        ContainingType TypeSymbol,
        IsSetter bool,
        Handle MethodDefinitionHandle,
        Name string
    ) : IEquatable[ImportedAccessorBridge] { }

    private data class InheritedStaticBridge(
        DeclaringType StructSymbol,
        Method FunctionSymbol?,
        Property PropertySymbol?,
        Event EventSymbol?,
        Flag bool,
        Handle MethodDefinitionHandle,
        Name string
    ) : IEquatable[InheritedStaticBridge] { }

    shared {
        private func DeclaresProperty(definition StructSymbol, property PropertySymbol) bool {
            for candidate in definition.Properties {
                if object.ReferenceEquals(candidate, property) ||
                    (
                    property.Declaration != nil && object.ReferenceEquals(candidate.Declaration, property.Declaration)
                ) {
                    return true
                }
            }
            return false
        }

        private func SourceBaseImplementsInterface(baseClass StructSymbol?, iface InterfaceSymbol) bool {
            if baseClass == nil {
                return false
            }
            for ancestor in baseClass.GetHierarchy() {
                for implemented in ancestor.Interfaces {
                    if DeclarationBinder.ConformanceSignaturesEquivalent(implemented, iface) {
                        return true
                    }
                }
            }
            return false
        }

        private func TryFindImplicitEvent(
            type StructSymbol,
            iface InterfaceSymbol,
            slot EventSymbol,
            @NotNullWhen(true) out implementation EventSymbol?,
            @NotNullWhen(true) out declaringType StructSymbol?
        ) bool {
            for current in type.GetHierarchy() {
                for candidate in current.Events {
                    if !candidate.HasExplicitInterfaceClause &&
                        candidate.Name == slot.Name &&
                        (object.ReferenceEquals(current, type) || candidate.Accessibility == Accessibility.Public) &&
                        DeclarationBinder
                        .InterfaceEventTypesEquivalent(iface, slot, candidate) {
                        implementation = candidate
                        declaringType = current
                        return true
                    }
                }
            }
            implementation = nil
            declaringType = nil
            return false
        }

        private func TryFindImplicitEvent(
            type StructSymbol,
            name string,
            slotType TypeSymbol,
            @NotNullWhen(true) out implementation EventSymbol?,
            @NotNullWhen(true) out declaringType StructSymbol?
        ) bool {
            for current in type.GetHierarchy() {
                for candidate in current.Events {
                    if !candidate.HasExplicitInterfaceClause &&
                        candidate.Name == name &&
                        (object.ReferenceEquals(current, type) || candidate.Accessibility == Accessibility.Public) &&
                        DeclarationBinder
                        .ConformanceSignaturesEquivalent(slotType, candidate.Type) {
                        implementation = candidate
                        declaringType = current
                        return true
                    }
                }
            }
            implementation = nil
            declaringType = nil
            return false
        }

        private func FindDeclaringType(type StructSymbol, ev EventSymbol) StructSymbol {
            let chain = type.GetHierarchy()
            for var level = 1; level < chain.Count; level++ {
                let current = chain[level]
                for candidate in current.Events {
                    if object.ReferenceEquals(candidate, ev) {
                        return current
                    }
                }
            }
            throw InvalidOperationException("Inherited event declaring type was not found.")
        }

        private func IsExplicitlyImplemented(type StructSymbol, slot EventSymbol) bool {
            for candidate in type.Events {
                if object.ReferenceEquals(candidate.ExplicitInterfaceMember, slot) {
                    return true
                }
            }
            return false
        }

        private func IsImportedSlotExplicitlyImplemented(type StructSymbol, slot EventInfo) bool {
            for candidate in type.Events {
                if candidate.ExplicitInterfaceAddSlot == slot.AddMethod ||
                    candidate.ExplicitInterfaceRemoveSlot == slot.RemoveMethod {
                    return true
                }
            }
            return false
        }

        private func HasStaticMethodsInHierarchy(type StructSymbol?) bool {
            if type == nil {
                return false
            }
            for current in type.GetHierarchy() {
                if !current.StaticMethods.IsDefaultOrEmpty {
                    return true
                }
            }
            return false
        }

        private func HasStaticPropertiesInHierarchy(type StructSymbol?) bool {
            if type == nil {
                return false
            }
            for current in type.GetHierarchy() {
                if !current.StaticProperties.IsDefaultOrEmpty {
                    return true
                }
            }
            return false
        }

        private func HasStaticEventsInHierarchy(type StructSymbol?) bool {
            if type == nil {
                return false
            }
            for current in type.GetHierarchy() {
                if !current.StaticEvents.IsDefaultOrEmpty {
                    return true
                }
            }
            return false
        }

        private func TryFindUserStaticVirtualMethod(
            structSymbol StructSymbol,
            slot FunctionSymbol,
            @NotNullWhen(true) out implementation FunctionSymbol?,
            @NotNullWhen(true) out declaringType StructSymbol?
        ) bool {
            if !structSymbol.StaticMethods.IsDefaultOrEmpty {
                for explicitCandidate in structSymbol.StaticMethods {
                    if object.ReferenceEquals(explicitCandidate.ExplicitInterfaceMember, slot) {
                        implementation = explicitCandidate
                        declaringType = structSymbol
                        return true
                    }
                }
            }
            for current in structSymbol.GetHierarchy() {
                for candidate in current.GetStaticMethods(slot.Name) {
                    if MemberLookup.IsImplicitInterfaceImplementationCandidate(candidate) &&
                        (
                        object.ReferenceEquals(current, structSymbol) || candidate.Accessibility == Accessibility.Public
                    ) &&
                        DeclarationBinder
                        .StaticVirtualSignaturesMatch(
                        slot,
                        DeclarationBinder.SubstituteStaticMethodForOwner(current, candidate)
                    ) {
                        implementation = candidate
                        declaringType = current
                        return true
                    }
                }
            }
            implementation = nil
            declaringType = nil
            return false
        }

        private func TryFindUserStaticVirtualProperty(
            structSymbol StructSymbol,
            iface InterfaceSymbol,
            slotProp PropertySymbol,
            @NotNullWhen(true) out implementation PropertySymbol?,
            @NotNullWhen(true) out declaringType StructSymbol?
        ) bool {
            for explicitCandidate in structSymbol.StaticProperties {
                if object.ReferenceEquals(explicitCandidate.ExplicitInterfaceMember, slotProp) &&
                    DeclarationBinder
                    .ConformanceSignaturesEquivalent(
                    Invariant.Required(
                        explicitCandidate.ExplicitInterfaceClauseTarget,
                        "an explicit property implementation has a target",
                        expression: "explicitCandidate.ExplicitInterfaceClauseTarget"
                    ),
                    iface
                ) {
                    implementation = explicitCandidate
                    declaringType = structSymbol
                    return true
                }
            }
            return DeclarationBinder.TryFindImplicitStaticVirtualPropertyImplementation(
                structSymbol,
                iface,
                slotProp,
                out implementation,
                out declaringType
            )
        }

        /// Issue #1268: maps a (possibly substituted) static-virtual method slot
        /// on a constructed generic interface back to its open declaration on the
        /// interface definition. Returns [`slot`](paramref) unchanged when the
        /// interface is not a constructed instance, or when no open counterpart is
        /// found.
        ///
        /// Issue #2181: maps a (possibly substituted) instance method slot on a
        /// constructed generic interface back to its open declaration on the
        /// interface definition — the counterpart of
        /// (cref:ResolveOpenInterfaceStaticMethod) for the (non-static)
        /// (cref:InterfaceSymbol.Methods) table. Positional match first
        /// (the constructed instance's `Methods` mirror the definition's
        /// order), with a name/arity fallback; returns [`slot`](paramref)
        /// unchanged when the interface is a plain definition (identity map).
        private func ResolveOpenInterfaceInstanceMethod(iface InterfaceSymbol, slot FunctionSymbol) FunctionSymbol {
            let def = iface.Definition ?? iface
            // Function/interface symbols are canonical within one emit pass; CLR
            // metadata Type identity is not involved in this positional map.
            if object.ReferenceEquals(def, iface) {
                return slot
            }
            let constructedMethods = iface.Methods
            let defMethods = def.Methods
            for var i = 0; i < constructedMethods.Length; i++ {
                if object.ReferenceEquals(constructedMethods[i], slot) && i < defMethods.Length {
                    return defMethods[i]
                }
            }
            for m in defMethods {
                if m.Name == slot.Name && m.Parameters.Length == slot.Parameters.Length {
                    return m
                }
            }
            return slot
        }

        internal func ResolveOpenInterfaceStaticMethod(iface InterfaceSymbol, slot FunctionSymbol) FunctionSymbol {
            let def = iface.Definition ?? iface
            // Function/interface symbols are canonical within one emit pass; CLR
            // metadata Type identity is not involved in this positional map.
            if object.ReferenceEquals(def, iface) {
                return slot
            }
            let constructedStatics = iface.StaticMethods
            let defStatics = def.StaticMethods
            for var i = 0; i < constructedStatics.Length; i++ {
                if object.ReferenceEquals(constructedStatics[i], slot) && i < defStatics.Length {
                    return defStatics[i]
                }
            }
            for m in defStatics {
                if m.Name == slot.Name && m.Parameters.Length == slot.Parameters.Length {
                    return m
                }
            }
            return slot
        }
    }
}
