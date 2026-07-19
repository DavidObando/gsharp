// <copyright file="InterfaceImplEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1202 // 'internal' members should come before 'private' members (methods keep their original ReflectionMetadataEmitter band order: entry points interleaved with the private helpers they orchestrate)
#pragma warning disable SA1204 // static members should come before non-static (the open-slot resolvers sit next to the emitters that consume them, preserving band order)
#pragma warning disable SA1515 // single-line comment preceded by blank line (inherited from the ReflectionMetadataEmitter band; bodies are verbatim moves)
#pragma warning disable SA1611 // parameter documentation missing — the API surface is mechanically lifted from ReflectionMetadataEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Reflection.Metadata;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-14 (#1361): interface method-implementation emitter. Owns every
/// <c>MethodImpl</c>-row band moved off <see cref="ReflectionMetadataEmitter"/>:
/// explicit interface method/property/event implementations (issues
/// #985/#2010, #2362, ADR-0149) and static-virtual interface slot bindings
/// (ADR-0089, issues #755/#1019/#1268/#2370), plus the open-slot resolution
/// and signature-matching helpers used only by this band
/// (<c>ResolveOpenInterfaceInstanceMethod</c>,
/// <c>ResolveOpenInterfaceStaticMethod</c>,
/// <c>StaticVirtualSignatureEquals</c>).
/// </summary>
/// <remarks>
/// Wired with a back-reference to the root emitter (the MethodBodyEmitter
/// idiom) for the cross-cutting token resolvers
/// (<see cref="ImportedMemberRefFactory.GetMethodReference(System.Reflection.MethodInfo)"/>,
/// <see cref="UserTokenResolver.ResolveUserInterfaceInstanceMethodToken"/>,
/// <see cref="ReflectionMetadataEmitter.IsUserGenericInterfaceReference"/>),
/// with direct fields for the shared <see cref="EmitContext"/> and
/// <see cref="MetadataTokenCache"/>. Method bodies are verbatim moves;
/// emitted PEs are byte-identical with the pre-E-14 baseline.
/// </remarks>
internal sealed class InterfaceImplEmitter
{
    private readonly ReflectionMetadataEmitter outer;
    private readonly EmitContext emitCtx;
    private readonly MetadataTokenCache cache;

    public InterfaceImplEmitter(ReflectionMetadataEmitter outer)
    {
        this.outer = outer ?? throw new ArgumentNullException(nameof(outer));
        this.emitCtx = outer.emitCtx;
        this.cache = outer.cache;
    }

    /// <summary>
    /// Issue #2443: binds G# methods and property/event accessors to virtual
    /// slots inherited from imported CLR base classes. Exact-signature
    /// overrides would usually reuse the slot from their Virtual/ReuseSlot
    /// flags alone, but an explicit MethodImpl also supports covariant returns
    /// and records the intended external declaration unambiguously.
    /// </summary>
    internal void EmitExternalBaseMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null
            || !this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var method in structSymbol.Methods)
        {
            if (method.ExternalOverriddenMethod != null
                && this.cache.MethodHandles.TryGetValue(method, out var implHandle))
            {
                var declaration = this.outer.memberRefs.GetMethodEntityHandle(
                    method.ExternalOverriddenMethod,
                    method.ExternalOverrideContainingType);
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, declaration);
            }
        }

        foreach (var property in structSymbol.Properties)
        {
            if (!this.cache.PropertyAccessorHandles.TryGetValue(property, out var accessors))
            {
                continue;
            }

            if (property.ExternalOverriddenGetter != null && accessors.Getter.HasValue)
            {
                var declaration = this.outer.memberRefs.GetMethodEntityHandle(
                    property.ExternalOverriddenGetter,
                    property.ExternalOverrideContainingType);
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Getter.Value, declaration);
            }

            if (property.ExternalOverriddenSetter != null && accessors.Setter.HasValue)
            {
                var declaration = this.outer.memberRefs.GetMethodEntityHandle(
                    property.ExternalOverriddenSetter,
                    property.ExternalOverrideContainingType);
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Setter.Value, declaration);
            }
        }

        foreach (var eventSymbol in structSymbol.Events)
        {
            if (!this.cache.EventAccessorHandles.TryGetValue(eventSymbol, out var accessors))
            {
                continue;
            }

            if (eventSymbol.ExternalOverriddenAddMethod != null)
            {
                var declaration = this.outer.memberRefs.GetMethodEntityHandle(
                    eventSymbol.ExternalOverriddenAddMethod,
                    eventSymbol.ExternalOverrideContainingType);
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Add, declaration);
            }

            if (eventSymbol.ExternalOverriddenRemoveMethod != null)
            {
                var declaration = this.outer.memberRefs.GetMethodEntityHandle(
                    eventSymbol.ExternalOverriddenRemoveMethod,
                    eventSymbol.ExternalOverrideContainingType);
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Remove, declaration);
            }

            if (eventSymbol.ExternalOverriddenRaiseMethod != null && accessors.Raise.HasValue)
            {
                var declaration = this.outer.memberRefs.GetMethodEntityHandle(
                    eventSymbol.ExternalOverriddenRaiseMethod,
                    eventSymbol.ExternalOverrideContainingType);
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, accessors.Raise.Value, declaration);
            }
        }
    }

    /// <summary>
    /// Issue #985 / #2010: emit MethodImpl rows for covariant-return interface
    /// bridges AND for mangled-name explicit interface implementations. A
    /// method whose <see cref="FunctionSymbol.ExplicitInterfaceSlot"/> is set
    /// explicitly implements a specific (typically inherited, non-generic) CLR
    /// interface slot — e.g. the private non-generic
    /// <c>IEnumerable.GetEnumerator()</c> alongside the public generic
    /// <c>IEnumerable&lt;T&gt;.GetEnumerator()</c>. A private bridge method
    /// cannot implicitly implement an interface slot, so the explicit row is
    /// required for the resulting type to load.
    ///
    /// A method whose <see cref="FunctionSymbol.ExplicitInterfaceMember"/> is
    /// set explicitly implements one specific in-compilation (G#) interface
    /// member — its mangled name never matches the interface member's own
    /// name, so ordinary name-based virtual dispatch never wires it into that
    /// interface's slot; an explicit <c>MethodImpl</c> row is required here
    /// too (mirrors <see cref="EmitStaticVirtualMethodImpls"/>'s generic-aware
    /// token resolution for a constructed interface).
    /// </summary>
    /// <param name="structSymbol">The implementing class or struct.</param>
    internal void EmitExplicitInterfaceMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Methods.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var method in structSymbol.Methods)
        {
            if (!this.cache.MethodHandles.TryGetValue(method, out var implHandle))
            {
                continue;
            }

            var slot = method.ExplicitInterfaceSlot;
            if (slot != null)
            {
                var slotRef = this.outer.memberRefs.GetMethodReference(slot);
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, slotRef);
            }

            var ifaceMember = method.ExplicitInterfaceMember;
            if (ifaceMember == null || structSymbol.Interfaces.IsDefaultOrEmpty)
            {
                continue;
            }

            EntityHandle? slotHandle = null;
            foreach (var iface in structSymbol.Interfaces)
            {
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
                if (iface.Methods.IsDefaultOrEmpty || !iface.Methods.Contains(ifaceMember))
                {
                    continue;
                }

                var openSlot = ResolveOpenInterfaceInstanceMethod(iface, ifaceMember);
                slotHandle = ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface)
                    ? this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, openSlot)
                    : this.cache.MethodHandles.TryGetValue(openSlot, out var slotDefHandle)
                        ? slotDefHandle
                        : (EntityHandle?)null;
                break;
            }

            if (slotHandle.HasValue)
            {
                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, slotHandle.Value);
            }
        }
    }

    /// <summary>
    /// Issue #2362: emit <c>MethodImpl</c> rows for mangled-name explicit
    /// interface PROPERTY implementations — the property-level counterpart of
    /// <see cref="EmitExplicitInterfaceMethodImpls"/>. A property whose
    /// <see cref="PropertySymbol.ExplicitInterfaceMember"/> is set explicitly
    /// implements one specific in-compilation (G#) interface property; its
    /// mangled name never matches the interface member's own name, so
    /// ordinary name-based virtual dispatch never wires its accessors into
    /// that interface's slot. An explicit <c>MethodImpl</c> row per accessor
    /// (getter and/or setter) is required, exactly mirroring
    /// <see cref="EmitStaticVirtualPropertyMethodImpls"/>'s generic-aware
    /// token resolution for a constructed interface, but for an INSTANCE
    /// property slot resolved from <see cref="StructSymbol.Interfaces"/>
    /// rather than a static-virtual slot.
    /// </summary>
    /// <param name="structSymbol">The implementing class or struct.</param>
    internal void EmitExplicitInterfacePropertyMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Properties.IsDefaultOrEmpty || structSymbol.Interfaces.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var prop in structSymbol.Properties)
        {
            var ifaceMember = prop.ExplicitInterfaceMember;
            if (ifaceMember == null)
            {
                continue;
            }

            if (!this.cache.PropertyAccessorHandles.TryGetValue(prop, out var implAccessors))
            {
                continue;
            }

            foreach (var iface in structSymbol.Interfaces)
            {
                // Issue #2362: InterfaceSymbol.Construct does not substitute
                // Properties onto a constructed generic instance (see
                // InterfaceSymbol.TryResolveMembers) — `ExplicitInterfaceMember`
                // is always linked against the OPEN definition's property (see
                // TryResolveExplicitInterfacePropertyImplementation), so match
                // against `defIface.Properties` here too, exactly like
                // EmitStaticVirtualPropertyMethodImpls.
                var defIface = iface.Definition ?? iface;
                if (defIface.Properties.IsDefaultOrEmpty || !defIface.Properties.Contains(ifaceMember))
                {
                    continue;
                }

                var isGenericIface = ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface);

                if (ifaceMember.HasGetter && implAccessors.Getter.HasValue && ifaceMember.GetterSymbol != null)
                {
                    EntityHandle? getterDecl = isGenericIface
                        ? this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, ifaceMember.GetterSymbol)
                        : this.cache.MethodHandles.TryGetValue(ifaceMember.GetterSymbol, out var getterDefHandle)
                            ? getterDefHandle
                            : (EntityHandle?)null;
                    if (getterDecl.HasValue)
                    {
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Getter.Value, getterDecl.Value);
                    }
                }

                if (ifaceMember.HasSetter && implAccessors.Setter.HasValue && ifaceMember.SetterSymbol != null)
                {
                    EntityHandle? setterDecl = isGenericIface
                        ? this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, ifaceMember.SetterSymbol)
                        : this.cache.MethodHandles.TryGetValue(ifaceMember.SetterSymbol, out var setterDefHandle)
                            ? setterDefHandle
                            : (EntityHandle?)null;
                    if (setterDecl.HasValue)
                    {
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Setter.Value, setterDecl.Value);
                    }
                }

                break;
            }
        }
    }

    /// <summary>
    /// ADR-0149: emit <c>MethodImpl</c> rows for explicit-interface-clause
    /// EVENT implementations (<c>event (IFoo) Changed T</c>) — the event-level
    /// counterpart of <see cref="EmitExplicitInterfacePropertyMethodImpls"/>,
    /// generalizing the #2362 explicit-implementation convention to events
    /// for the first time. An event whose
    /// <see cref="EventSymbol.ExplicitInterfaceMember"/> is set explicitly
    /// implements one specific in-compilation interface event; its add/
    /// remove (and, if present, raise) accessors are bridged into that
    /// interface's abstract slots via one <c>MethodImpl</c> row per accessor,
    /// exactly mirroring the property function's generic-aware token
    /// resolution.
    /// </summary>
    /// <param name="structSymbol">The implementing class or struct.</param>
    internal void EmitExplicitInterfaceEventMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Events.IsDefaultOrEmpty || structSymbol.Interfaces.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var ev in structSymbol.Events)
        {
            var ifaceMember = ev.ExplicitInterfaceMember;
            if (ifaceMember == null)
            {
                continue;
            }

            if (!this.cache.EventAccessorHandles.TryGetValue(ev, out var implAccessors))
            {
                continue;
            }

            foreach (var iface in structSymbol.Interfaces)
            {
                // ADR-0149 (mirrors #2362's property resolution): interface
                // Events, like Properties, are never substituted onto a
                // constructed generic instance (InterfaceSymbol.TryResolveMembers),
                // so ExplicitInterfaceMember is always linked against the OPEN
                // definition's event — match against `defIface.Events` here.
                var defIface = iface.Definition ?? iface;
                if (defIface.Events.IsDefaultOrEmpty || !defIface.Events.Contains(ifaceMember))
                {
                    continue;
                }

                var isGenericIface = ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface);

                if (ifaceMember.AddMethodSymbol != null)
                {
                    EntityHandle? addDecl = isGenericIface
                        ? this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, ifaceMember.AddMethodSymbol)
                        : this.cache.MethodHandles.TryGetValue(ifaceMember.AddMethodSymbol, out var addDefHandle)
                            ? addDefHandle
                            : (EntityHandle?)null;
                    if (addDecl.HasValue)
                    {
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Add, addDecl.Value);
                    }
                }

                if (ifaceMember.RemoveMethodSymbol != null)
                {
                    EntityHandle? removeDecl = isGenericIface
                        ? this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, ifaceMember.RemoveMethodSymbol)
                        : this.cache.MethodHandles.TryGetValue(ifaceMember.RemoveMethodSymbol, out var removeDefHandle)
                            ? removeDefHandle
                            : (EntityHandle?)null;
                    if (removeDecl.HasValue)
                    {
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Remove, removeDecl.Value);
                    }
                }

                if (ifaceMember.RaiseMethodSymbol != null && implAccessors.Raise.HasValue)
                {
                    EntityHandle? raiseDecl = isGenericIface
                        ? this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, ifaceMember.RaiseMethodSymbol)
                        : this.cache.MethodHandles.TryGetValue(ifaceMember.RaiseMethodSymbol, out var raiseDefHandle)
                            ? raiseDefHandle
                            : (EntityHandle?)null;
                    if (raiseDecl.HasValue)
                    {
                        this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Raise.Value, raiseDecl.Value);
                    }
                }

                break;
            }
        }
    }

    /// <summary>
    /// ADR-0089 / issue #755: emit MethodImpl rows binding each declared
    /// static-virtual interface slot to the implementer's matching static
    /// method on <paramref name="structSymbol"/>. Best-effort match — if
    /// the implementer is missing the slot, the binder has already issued
    /// GS0331/GS0332 and we skip silently here.
    /// </summary>
    internal void EmitStaticVirtualMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Interfaces.IsDefaultOrEmpty || structSymbol.StaticMethods.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var iface in structSymbol.Interfaces)
        {
            if (iface.StaticMethods.IsDefaultOrEmpty)
            {
                continue;
            }

            // Issue #1268: when the implemented interface is a constructed
            // generic (e.g. `TrackNumber : IData[TrackNumber]`), its
            // `StaticMethods` are substituted instances that are NOT keyed in
            // `MethodHandles`; only the open definition's slots are. Resolve
            // each substituted slot back to its open counterpart for the
            // MethodDef lookup, and parent the MethodImpl's declaration at the
            // constructed interface's TypeSpec (a MemberRef) so the runtime can
            // pair the override against `IData`1<TrackNumber>::Method`.
            var isGenericIface = ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface);
            foreach (var slot in iface.StaticMethods)
            {
                var openSlot = ResolveOpenInterfaceStaticMethod(iface, slot);
                if (!this.cache.MethodHandles.TryGetValue(openSlot, out var slotDefHandle))
                {
                    continue;
                }

                EntityHandle slotHandle = isGenericIface
                    ? this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, openSlot)
                    : slotDefHandle;

                // ADR-0149 follow-up (issue #2370): an explicit-interface-
                // clause static method (`func (IFoo) M(...)` inside a
                // `shared { }` block) is linked by the binder via
                // `ExplicitInterfaceMember` (DeclarationBinder's
                // `TryResolveExplicitInterfaceStaticImplementation`) against
                // this exact constructed-instance `slot`, regardless of its
                // own declared name — prefer that link over the name-based
                // `StaticVirtualSignatureEquals` scan below, mirroring
                // `EmitExplicitInterfaceMethodImpls`'s instance-method
                // precedent.
                FunctionSymbol implMatch = null;
                if (!structSymbol.StaticMethods.IsDefaultOrEmpty)
                {
                    foreach (var explicitCandidate in structSymbol.StaticMethods)
                    {
                        if (ReferenceEquals(explicitCandidate.ExplicitInterfaceMember, slot))
                        {
                            implMatch = explicitCandidate;
                            break;
                        }
                    }
                }

                if (implMatch == null)
                {
                    foreach (var candidate in structSymbol.GetStaticMethods(slot.Name))
                    {
                        if (StaticVirtualSignatureEquals(slot, candidate))
                        {
                            implMatch = candidate;
                            break;
                        }
                    }
                }

                if (implMatch == null)
                {
                    continue;
                }

                if (!this.cache.MethodHandles.TryGetValue(implMatch, out var implHandle))
                {
                    continue;
                }

                this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implHandle, slotHandle);
            }
        }
    }

    /// <summary>
    /// Issue #1268: maps a (possibly substituted) static-virtual method slot
    /// on a constructed generic interface back to its open declaration on the
    /// interface definition. Returns <paramref name="slot"/> unchanged when the
    /// interface is not a constructed instance, or when no open counterpart is
    /// found.
    /// </summary>
    /// <summary>
    /// Issue #2181: maps a (possibly substituted) instance method slot on a
    /// constructed generic interface back to its open declaration on the
    /// interface definition — the counterpart of
    /// <see cref="ResolveOpenInterfaceStaticMethod"/> for the (non-static)
    /// <see cref="InterfaceSymbol.Methods"/> table. Positional match first
    /// (the constructed instance's <c>Methods</c> mirror the definition's
    /// order), with a name/arity fallback; returns <paramref name="slot"/>
    /// unchanged when the interface is a plain definition (identity map).
    /// </summary>
    private static FunctionSymbol ResolveOpenInterfaceInstanceMethod(InterfaceSymbol iface, FunctionSymbol slot)
    {
        var def = iface.Definition ?? iface;
        // Function/interface symbols are canonical within one emit pass; CLR
        // metadata Type identity is not involved in this positional map.
        if (ReferenceEquals(def, iface))
        {
            return slot;
        }

        var constructedMethods = iface.Methods;
        var defMethods = def.Methods;
        for (var i = 0; i < constructedMethods.Length; i++)
        {
            if (ReferenceEquals(constructedMethods[i], slot) && i < defMethods.Length)
            {
                return defMethods[i];
            }
        }

        foreach (var m in defMethods)
        {
            if (m.Name == slot.Name && m.Parameters.Length == slot.Parameters.Length)
            {
                return m;
            }
        }

        return slot;
    }

    internal static FunctionSymbol ResolveOpenInterfaceStaticMethod(InterfaceSymbol iface, FunctionSymbol slot)
    {
        var def = iface.Definition ?? iface;
        // Function/interface symbols are canonical within one emit pass; CLR
        // metadata Type identity is not involved in this positional map.
        if (ReferenceEquals(def, iface))
        {
            return slot;
        }

        var constructedStatics = iface.StaticMethods;
        var defStatics = def.StaticMethods;
        for (var i = 0; i < constructedStatics.Length; i++)
        {
            if (ReferenceEquals(constructedStatics[i], slot) && i < defStatics.Length)
            {
                return defStatics[i];
            }
        }

        foreach (var m in defStatics)
        {
            if (m.Name == slot.Name && m.Parameters.Length == slot.Parameters.Length)
            {
                return m;
            }
        }

        return slot;
    }

    /// <summary>
    /// ADR-0089 / issue #1019: emit <c>MethodImpl</c> rows pairing the
    /// implementer's static property accessor methods (<c>get_Name</c> /
    /// <c>set_Name</c>) to the matching static-virtual interface property
    /// accessor slots. Mirrors <see cref="EmitStaticVirtualMethodImpls"/> but
    /// resolves accessor MethodDef handles through
    /// <c>PropertyAccessorHandles</c> (static properties are tracked on
    /// <see cref="StructSymbol.StaticProperties"/>, not <c>StaticMethods</c>).
    /// </summary>
    /// <param name="structSymbol">The implementer struct/class.</param>
    internal void EmitStaticVirtualPropertyMethodImpls(StructSymbol structSymbol)
    {
        if (structSymbol == null || structSymbol.Interfaces.IsDefaultOrEmpty || structSymbol.StaticProperties.IsDefaultOrEmpty)
        {
            return;
        }

        if (!this.cache.StructTypeDefs.TryGetValue(structSymbol, out var implTypeDef))
        {
            return;
        }

        foreach (var iface in structSymbol.Interfaces)
        {
            // Issue #1268: a constructed generic interface does not surface its
            // declared properties on the constructed instance (only methods are
            // substituted) — walk the open definition's property table so the
            // static-virtual property slots are found, and parent the
            // MethodImpl declaration at the constructed TypeSpec for generic
            // interfaces.
            var defIface = iface.Definition ?? iface;
            if (defIface.Properties.IsDefaultOrEmpty)
            {
                continue;
            }

            var isGenericIface = ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface);
            foreach (var slotProp in defIface.Properties)
            {
                if (!slotProp.IsStatic)
                {
                    continue;
                }

                if (!this.cache.PropertyAccessorHandles.TryGetValue(slotProp, out var slotAccessors))
                {
                    continue;
                }

                // ADR-0149 follow-up (issue #2370): an explicit-interface-
                // clause static property (`prop (IFoo) P T` inside a
                // `shared { }` block) is linked by the binder via
                // `ExplicitInterfaceMember` against this exact `slotProp`
                // (both resolved from the OPEN interface definition's
                // `Properties` table — see `VerifyStaticVirtualInterfaceProperty
                // Implementations`'s `staticPropDefIface` fix) — prefer that
                // link over the name-based scan below.
                PropertySymbol implProp = null;
                foreach (var explicitCandidate in structSymbol.StaticProperties)
                {
                    if (ReferenceEquals(explicitCandidate.ExplicitInterfaceMember, slotProp))
                    {
                        implProp = explicitCandidate;
                        break;
                    }
                }

                if (implProp == null)
                {
                    foreach (var candidate in structSymbol.StaticProperties)
                    {
                        // PropertySymbol.Type is a compiler TypeSymbol, not a CLR
                        // reflection Type; keep symbol identity plus name fallback.
                        if (candidate.Name == slotProp.Name
                            && (ReferenceEquals(candidate.Type, slotProp.Type) || candidate.Type?.Name == slotProp.Type?.Name))
                        {
                            implProp = candidate;
                            break;
                        }
                    }
                }

                if (implProp == null
                    || !this.cache.PropertyAccessorHandles.TryGetValue(implProp, out var implAccessors))
                {
                    continue;
                }

                if (slotProp.HasGetter && slotAccessors.Getter.HasValue && implAccessors.Getter.HasValue)
                {
                    EntityHandle getterDecl = isGenericIface && slotProp.GetterSymbol != null
                        ? this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, slotProp.GetterSymbol)
                        : slotAccessors.Getter.Value;
                    this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Getter.Value, getterDecl);
                }

                if (slotProp.HasSetter && slotAccessors.Setter.HasValue && implAccessors.Setter.HasValue)
                {
                    EntityHandle setterDecl = isGenericIface && slotProp.SetterSymbol != null
                        ? this.outer.userTokens.ResolveUserInterfaceInstanceMethodToken(iface, slotProp.SetterSymbol)
                        : slotAccessors.Setter.Value;
                    this.emitCtx.Metadata.AddMethodImplementation(implTypeDef, implAccessors.Setter.Value, setterDecl);
                }
            }
        }
    }

    private static bool StaticVirtualSignatureEquals(FunctionSymbol a, FunctionSymbol b)
    {
        if (a == null || b == null)
        {
            return false;
        }

        if (a.Parameters.Length != b.Parameters.Length)
        {
            return false;
        }

        // FunctionSymbol.Type and parameter Type values are compiler symbols
        // canonicalized for this emit pass, not reflection Type instances.
        if (!ReferenceEquals(a.Type, b.Type) && a.Type?.Name != b.Type?.Name)
        {
            return false;
        }

        for (var i = 0; i < a.Parameters.Length; i++)
        {
            var pa = a.Parameters[i].Type;
            var pb = b.Parameters[i].Type;
            if (!ReferenceEquals(pa, pb) && pa?.Name != pb?.Name)
            {
                return false;
            }
        }

        return true;
    }
}
