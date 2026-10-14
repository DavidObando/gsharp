// <copyright file="DeclarationBinder.InterfaceVerification.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System.Diagnostics.CodeAnalysis
import System.Text

internal partial class DeclarationBinder {
    internal func VerifyAbstractMethodImplementations() {
        for (syntax, structSymbol) in pendingAbstractImplementationChecks {
            if !structSymbol.IsDeclaredAbstract {
                for requirement in structSymbol.GetUnimplementedAbstractPropertyAccessors() {
                    // Keep the established open/get-only requirement syntax; explicit
                    // abstract contracts additionally require abstract derived owners.
                    if requirement.Property.Declaration?.AbstractModifier != nil {
                        Diagnostics.ReportAbstractMemberNotImplemented(
                            syntax.Identifier.Location,
                            structSymbol.Name,
                            requirement.Owner.Name,
                            (
                                if requirement.IsGetter {
                                    "get_"
                                } else {
                                    "set_"
                                }
                            ) +
                                requirement
                                .Property
                                .Name
                        )
                    }
                }
            }
            // An `open` class is permitted to remain abstract — it need not
            // override inherited abstract members.
            if structSymbol.IsOpen {
                continue
            }
            let dataCloneAncestor = structSymbol.GetDataCloneAncestor()
            if !structSymbol.IsData && dataCloneAncestor?.IsAbstract == true {
                // Synthesized record clones are not FunctionSymbols, so the
                // ordinary abstract-member walk cannot see this slot.
                Diagnostics.ReportAbstractMemberNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    dataCloneAncestor!!.Name,
                    "<Clone>$$"
                )
            }
            for abstractMethod in structSymbol.GetUnimplementedAbstractMethods() {
                // Skip abstract methods declared directly on this class — those
                // are reported via GS0388 (abstract member in a non-open class).
                // GS0387 is reserved for abstract members *inherited* from a base
                // class and left unimplemented by a concrete subclass.
                if object.ReferenceEquals(abstractMethod.ReceiverType, structSymbol) {
                    continue
                }
                Diagnostics.ReportAbstractMemberNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    abstractMethod.ReceiverType?.Name ?? structSymbol.Name,
                    abstractMethod.Name
                )
            }
            for abstractMember in ExternalClrOverrideResolver.GetUnimplementedAbstractMembers(structSymbol) {
                if abstractMember.ReportedBySourceAbstractMethod {
                    continue
                }
                Diagnostics.ReportAbstractMemberNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    abstractMember.DeclaringTypeName,
                    abstractMember.MemberName
                )
            }
        }
    }

    /// Issue #1006: once interface base clauses have been bound, expand each
    /// implementer's interface set to include the transitive closure of base
    /// interfaces. A `class C : B` where `interface B : A` must
    /// implement (and metadata-declare) both `B` and `A`, matching
    /// C#. Base CLR interfaces of user interfaces are folded into the
    /// implementer's CLR interface set so dispatch through them works too.
    internal func ExpandStructInterfaceClosures() {
        for (_, structSymbol) in pendingInterfaceImplementationChecks {
            if structSymbol.Interfaces.IsDefaultOrEmpty {
                continue
            }
            let ordered = List[InterfaceSymbol]()
            let seen = HashSet[InterfaceSymbol]()
            let clrSeen = HashSet[Type]()
            let extraClr = ImmutableArray.CreateBuilder[TypeSymbol]()
            if !structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty {
                for existing in structSymbol.ImplementedClrInterfaces {
                    if existing.ClrType != nil {
                        clrSeen.Add(existing.ClrType)
                    }
                }
            }
            for direct in structSymbol.Interfaces {
                for iface in direct.SelfAndAllBaseInterfaces() {
                    if seen.Add(iface) {
                        ordered.Add(iface)
                    }
                    if !iface.BaseClrInterfaces.IsDefaultOrEmpty {
                        for clr in iface.BaseClrInterfaces {
                            if clr.ClrType != nil && clrSeen.Add(clr.ClrType) {
                                extraClr.Add(clr)
                            }
                        }
                    }
                }
            }
            if ordered.Count != structSymbol.Interfaces.Length {
                structSymbol.SetInterfaces(ordered.ToImmutableArray())
            }
            if extraClr.Count > 0 {
                let merged = ImmutableArray.CreateBuilder[TypeSymbol]()
                if !structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty {
                    merged.AddRange(structSymbol.ImplementedClrInterfaces)
                }
                merged.AddRange(extraClr)
                structSymbol.SetImplementedClrInterfaces(merged.ToImmutable())
            }
        }
    }

    internal func VerifyInterfaceImplementations() {
        for (syntax, structSymbol) in pendingInterfaceImplementationChecks {
            let ResolveExplicitClrInterfaceImplementations = func (structSymbol StructSymbol) {
                for method in structSymbol.Methods {
                    let target = method.ExplicitInterfaceClauseTarget
                    if !method.HasExplicitInterfaceClause ||
                        target is InterfaceSymbol ||
                        target
                        ?.ClrType
                        ?.IsInterface != true {
                        continue
                    }
                    for slot in target!!.ClrType!!.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                        if !slot.IsSpecialName && slot.Name == method.Name && MemberLookup.MethodMatchesClrSignature(
                            method,
                            slot
                        ) {
                            method.ExplicitInterfaceSlot = slot
                            method.ExplicitInterfaceSlotContainingType = target
                            break
                        }
                    }
                    if method.ExplicitInterfaceSlot != nil {
                        continue
                    }
                    // Issue #3814: a clause naming an imported generic interface
                    // closed over a SYMBOLIC argument (`func (IEquatable[T])
                    // Equals(other T) bool` inside `class Value[T]`) never
                    // matches above: `target.ClrType` is the type-ERASED
                    // `IEquatable<object>`, so the slot reads `Equals(object)`
                    // while the declaration says `Equals(T)` (GS0494). Match
                    // against the OPEN definition with the interface's real
                    // symbolic arguments substituted — the same #949 machinery
                    // the interface-contract verification already uses — then
                    // record the erased slot, which is what the MethodImpl row's
                    // MemberRef is built from (its containing type carries the
                    // symbolic arguments).
                    if !MemberLookup.TryGetSymbolicClrGenericInterface(
                        target!!,
                        out var openInterface,
                        out var symbolicArgs
                    ) {
                        continue
                    }
                    for openSlot in openInterface.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                        if openSlot.IsSpecialName ||
                            openSlot.Name != method.Name ||
                            !MemberLookup.MethodMatchesSymbolicClrInterfaceSignature(method, openSlot, symbolicArgs) {
                            continue
                        }
                        let erasedSlot MethodInfo? = FindErasedSlotForOpenMethod(target!!.ClrType!!, openSlot)
                        if erasedSlot == nil {
                            continue
                        }
                        method.ExplicitInterfaceSlot = erasedSlot
                        method.ExplicitInterfaceSlotContainingType = target
                        break
                    }
                }
                for property in GetMembersIncludingInherited(structSymbol, (type StructSymbol) -> type.Properties) {
                    let target = property.ExplicitInterfaceClauseTarget
                    if !property.HasExplicitInterfaceClause ||
                        target is InterfaceSymbol ||
                        target
                        ?.ClrType
                        ?.IsInterface != true {
                        continue
                    }
                    for slot in target!!.ClrType!!.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                        if !ExplicitClrPropertyMatches(property, target!!, slot) {
                            continue
                        }
                        property.ExplicitInterfaceGetterSlot = slot.GetMethod
                        property.ExplicitInterfaceSetterSlot = slot.SetMethod
                        property.ExplicitInterfaceSlotContainingType = target
                        break
                    }
                    if property.ExplicitInterfaceGetterSlot != nil ||
                        property.ExplicitInterfaceSetterSlot != nil ||
                        !MemberLookup.TryGetSymbolicClrGenericInterface(
                        target!!,
                        out var openInterface,
                        out var symbolicArgs
                    ) {
                        continue
                    }
                    for openSlot in openInterface!!.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                        if (openSlot.GetMethod != nil) != property.HasGetter ||
                            (openSlot.SetMethod != nil) != property.HasSetter ||
                            !MemberLookup.PropertyMatchesSymbolicClrInterfaceSignature(
                            property,
                            openSlot,
                            symbolicArgs
                        ) {
                            continue
                        }
                        let erasedGetter MethodInfo? = if openSlot.GetMethod == nil {
                            default(MethodInfo?)
                        } else {
                            FindErasedSlotForOpenMethod(target!!.ClrType!!, openSlot.GetMethod!!)
                        }
                        let erasedSetter MethodInfo? = if openSlot.SetMethod == nil {
                            default(MethodInfo?)
                        } else {
                            FindErasedSlotForOpenMethod(target!!.ClrType!!, openSlot.SetMethod!!)
                        }
                        if (openSlot.GetMethod != nil && erasedGetter == nil) ||
                            (openSlot.SetMethod != nil && erasedSetter == nil) {
                            continue
                        }
                        property.ExplicitInterfaceGetterSlot = erasedGetter
                        property.ExplicitInterfaceSetterSlot = erasedSetter
                        property.ExplicitInterfaceSlotContainingType = target
                        break
                    }
                }
                for eventSymbol in structSymbol.Events {
                    let target = eventSymbol.ExplicitInterfaceClauseTarget
                    if !eventSymbol.HasExplicitInterfaceClause ||
                        target is InterfaceSymbol ||
                        target
                        ?.ClrType
                        ?.IsInterface != true {
                        continue
                    }
                    for slot in target!!.ClrType!!.GetEvents(BindingFlags.Public | BindingFlags.Instance) {
                        if slot.Name != eventSymbol.Name ||
                            !ConformanceSignaturesEquivalent(
                            eventSymbol.Type,
                            MemberLookup.GetClrEventHandlerTypeSymbol(target!!, slot)
                        ) {
                            continue
                        }
                        eventSymbol.ExplicitInterfaceAddSlot = slot.AddMethod
                        eventSymbol.ExplicitInterfaceRemoveSlot = slot.RemoveMethod
                        eventSymbol.ExplicitInterfaceRaiseSlot = slot.RaiseMethod
                        eventSymbol.ExplicitInterfaceSlotContainingType = target
                        break
                    }
                }
            }
            ResolveExplicitClrInterfaceImplementations(structSymbol)
            let inheritedDefaultsBySignature = Dictionary[string, (Method FunctionSymbol, Iface InterfaceSymbol)](
                StringComparer.Ordinal
            )
            let conflictsReported = HashSet[string](StringComparer.Ordinal)
            let positionalInterfaceProps = Dictionary[string, (Param ParameterSymbol, NeedsSetter bool)](
                StringComparer.Ordinal
            )
            for iface in structSymbol.Interfaces {
                VerifyInterfaceMethodImplementationsAndDefaultConflicts(
                    syntax,
                    structSymbol,
                    iface,
                    inheritedDefaultsBySignature,
                    conflictsReported
                )
                VerifyInterfacePropertyImplementationsAndCollectPositionalCandidates(
                    syntax,
                    structSymbol,
                    iface,
                    positionalInterfaceProps
                )
                VerifyInterfaceEventImplementations(syntax, structSymbol, iface)
            }
            SynthesizePositionalInterfaceProperties(structSymbol, positionalInterfaceProps)
            VerifyClrInterfaceImplementations(syntax, structSymbol)
            VerifyInheritedClrInterfaceSlots(syntax, structSymbol)
            VerifyStaticVirtualInterfaceImplementations(syntax, structSymbol)
            VerifyStaticVirtualInterfacePropertyImplementations(syntax, structSymbol)
            VerifyPrivateInterfaceHelpersNotOverridden(syntax, structSymbol)
            VerifyExplicitInterfaceClauseResolution(syntax, structSymbol)
        }
    }

    private func VerifyInterfaceMethodImplementationsAndDefaultConflicts(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        iface InterfaceSymbol,
        inheritedDefaultsBySignature Dictionary[string, (Method FunctionSymbol, Iface InterfaceSymbol)],
        conflictsReported HashSet[string]
    ) {
        // ADR-0085 / issue #726: collect every interface default-method
        // the implementer would inherit if it does not provide its own
        // method, keyed by signature (name + parameter shape). When two
        // unrelated interfaces both provide a default for the same
        // signature and the class does not declare an override, GS0318
        // fires. The mapping is "first-seen wins" for the diagnostic
        // message; conflicts are reported once per signature.
        for imethod in iface.Methods {
            // ADR-0149 (was issue #2010's mangled-name convention): an
            // explicit-interface-clause implementation
            // (`func (IFoo) M(...)`) satisfies this slot even though
            // its own declared name never needs to match `imethod`
            // via any string convention — it was already resolved and
            // linked to `imethod` by `ResolveExplicitInterfaceClauses`.
            // Skip the name-based lookup entirely once found; no
            // diagnostic, and the emitter binds the slot via
            // `FunctionSymbol.ExplicitInterfaceMember`.
            if TryResolveExplicitInterfaceImplementation(structSymbol, iface, imethod) is {} explicitImplementation {
                ValidateUnscopedRefContract(
                    explicitImplementation,
                    enforceContract: true,
                    imethod.HasUnscopedRef,
                    "implemented member '${iface.Name}.${imethod.Name}'"
                )
                continue
            }
            // ADR-0063 §8: implementing class may have multiple methods
            // with the same name; pick the one whose signature matches
            // this specific interface overload exactly.
            let signatureMatch FunctionSymbol? = FindImplicitInterfaceMethodImplementation(
                structSymbol,
                imethod,
                out var impl
            )
            if signatureMatch != nil {
                ValidateUnscopedRefContract(
                    signatureMatch,
                    enforceContract: true,
                    imethod.HasUnscopedRef,
                    "implemented member '${iface.Name}.${imethod.Name}'"
                )
                // The class itself provides an implementation that exactly
                // matches the interface signature — no default needed and
                // any earlier-seen conflicting default is preempted.
                let sigKey = BuildInterfaceMethodSignatureKey(imethod)
                inheritedDefaultsBySignature.Remove(sigKey)
                conflictsReported.Add(sigKey)
                continue
            }
            if impl == nil {
                // ADR-0085: when the interface itself provides a default,
                // the implementer does not need to declare the method.
                // Track which default would be inherited so we can
                // diagnose diamond conflicts across multiple interfaces.
                if InterfaceSymbol.HasDefaultBody(imethod) {
                    let sigKey = BuildInterfaceMethodSignatureKey(imethod)
                    if inheritedDefaultsBySignature.TryGetValue(sigKey, out var prior) {
                        if !object.ReferenceEquals(prior.Method, imethod) && conflictsReported.Add(sigKey) {
                            Diagnostics.ReportConflictingInterfaceDefaults(
                                syntax.Identifier.Location,
                                structSymbol,
                                imethod.Name,
                                prior.Iface.Name,
                                iface.Name
                            )
                        }
                    } else {
                        inheritedDefaultsBySignature[sigKey] = (imethod, iface)
                    }
                    continue
                }
                // No impl, no default → original GS0187 channel for
                // missing implementations. GS0320 narrows it to "the
                // interface deliberately requires this method".
                if InterfaceHasAnyDefaultsExcept(iface, imethod) {
                    Diagnostics.ReportInterfaceAbstractMethodHasNoDefault(
                        syntax.Identifier.Location,
                        structSymbol,
                        iface.Name,
                        imethod.Name
                    )
                } else {
                    Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol,
                        iface.Name,
                        imethod.Name
                    )
                }
            } else if signatureMatch == nil {
                // ADR-0060 §9: distinguish a pure ref-kind mismatch (GS0240) from
                // an unrelated signature mismatch (the existing diagnostic).
                // Issue #490: also surface a dedicated diagnostic when only the
                // *return* ref-kind disagrees.
                if imethod.Type == impl.Type && imethod.ReturnRefKind != impl.ReturnRefKind {
                    Diagnostics.ReportOverrideReturnRefKindMismatch(
                        syntax.Identifier.Location,
                        imethod.Name,
                        RefCapabilities.DescribeReturn(imethod.ReturnRefKind),
                        RefCapabilities.DescribeReturn(impl.ReturnRefKind)
                    )
                } else {
                    let refMismatchIdx = FindRefKindMismatchIndex(imethod, GetCallableParameters(impl), impl.Type)
                    if refMismatchIdx >= 0 {
                        let implCallable = GetCallableParameters(impl)
                        let ifaceCallable = GetCallableParameters(imethod)
                        Diagnostics.ReportOverrideRefKindMismatch(
                            syntax.Identifier.Location,
                            imethod.Name,
                            ifaceCallable[refMismatchIdx].Name,
                            refKindToString(ifaceCallable[refMismatchIdx].RefKind),
                            refKindToString(implCallable[refMismatchIdx].RefKind)
                        )
                    } else {
                        Diagnostics.ReportInterfaceMethodNotImplemented(
                            syntax.Identifier.Location,
                            structSymbol,
                            iface.Name,
                            imethod.Name
                        )
                    }
                }
            }
        }
    }

    private func VerifyInterfacePropertyImplementationsAndCollectPositionalCandidates(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        iface InterfaceSymbol,
        positionalInterfaceProps Dictionary[string, (Param ParameterSymbol, NeedsSetter bool)]
    ) {
        // Issue #2150: data-class positional parameters that satisfy an
        // interface property are materialized only as public fields, so the
        // CLR interface slot (get_/set_ accessor) would be missing and the
        // emitted type would fail to load. Collect the parameters that
        // satisfy an interface property here, then synthesize backing
        // auto-property accessor members below so the interface contract is
        // fulfilled at the IL level. Keyed by parameter name; the flag
        // tracks whether any satisfied interface property also requires a
        // setter.
        // Issue #2875 follow-up: constructed G# generic interfaces do not
        // populate iface.Properties. Verify their open definition's property
        // table with BuildInterfaceTypeParameterMap substitution, matching the
        // existing explicit-property and static-property paths.
        let propertyDefIface = iface.Definition ?? iface
        let typeParameterMap = BuildInterfaceTypeParameterMap(iface)
        // ADR-0051: verify property requirements.
        for iprop in propertyDefIface.Properties {
            // ADR-0089 / issue #1019: static-virtual interface
            // properties are verified separately (against the
            // implementer's static properties); skip them here so the
            // instance-property contract check doesn't misfire.
            if iprop.IsStatic {
                continue
            }
            // Issue #2362: a mangled-name explicit implementation
            // (`__explicit_<Interface>__<Member>`) satisfies this slot
            // even though its own name never matches `iprop.Name` —
            // regardless of its own metadata name. Resolve and link it here;
            // the emitter binds accessor MethodImpl rows via
            // `PropertySymbol.ExplicitInterfaceMember`. A set/init mismatch
            // still links the member so GS0502 is reported without cascading
            // GS0494.
            let explicitImplementation PropertySymbol? = TryResolveExplicitInterfacePropertyImplementation(
                structSymbol,
                iface,
                iprop,
                out var explicitSetterKindMismatch
            )
            if explicitImplementation != nil {
                ValidateUnscopedRefPropertyContract(
                    explicitImplementation,
                    iprop,
                    structSymbol,
                    "implemented property '${iface.Name}.${iprop.Name}'",
                    typeParameterMap,
                    enforceInterfaceContract: true
                )
                if explicitSetterKindMismatch {
                    ReportInterfacePropertySetterKindMismatch(
                        syntax,
                        structSymbol,
                        iface.Name,
                        iprop.Name,
                        iprop.IsInitOnly,
                        explicitImplementation
                    )
                }
                continue
            }
            // Issue #1066: an interface property may be satisfied by a
            // property implemented (or inherited) ANYWHERE in the base chain.
            var found = TryGetConstructedInterfacePropertyImplementation(
                structSymbol,
                iprop,
                typeParameterMap,
                out var implProp,
                out var typeMismatch
            )
            if !found &&
                TryFindMatchingImportedBaseProperty(
                structSymbol,
                iprop,
                typeParameterMap,
                out var importedProperty,
                out var importedOwner
            ) {
                found = true
                if iprop.HasGetter {
                    let getter = Invariant.Required(
                        importedProperty!!.GetGetMethod(),
                        "a matching property has its required getter",
                        expression: "importedProperty.GetGetMethod()"
                    )
                    structSymbol.ImportedInterfaceAccessors.Add((iface, iprop, getter, importedOwner!!, false))
                }
                if iprop.HasSetter {
                    let setter = Invariant.Required(
                        importedProperty!!.GetSetMethod(),
                        "a matching property has its required setter",
                        expression: "importedProperty.GetSetMethod()"
                    )
                    structSymbol.ImportedInterfaceAccessors.Add((iface, iprop, setter, importedOwner!!, true))
                }
            }
            if found && implProp != nil {
                ValidateUnscopedRefPropertyContract(
                    implProp,
                    iprop,
                    structSymbol,
                    "implemented property '${iface.Name}.${iprop.Name}'",
                    typeParameterMap,
                    enforceInterfaceContract: true
                )
                if iprop.HasGetter && !implProp.HasGetter {
                    Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol,
                        iface.Name,
                        iprop.Name + " (getter)"
                    )
                }
                if iprop.HasSetter && !implProp.HasSetter {
                    Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol,
                        iface.Name,
                        iprop.Name + " (setter)"
                    )
                }
                // Positional data members now appear in Properties too. Route
                // them through the existing positional compatibility check
                // below; ordinary declared properties keep their established
                // interface-verification behavior.
                let isPositionalMember = implProp.Declaration == nil &&
                    TypeMemberModel.TryGetPrimaryConstructorParameter(structSymbol, iprop.Name, out _)
                if isPositionalMember {
                    found = false
                } else if InterfacePropertySetterKindsMismatch(iprop, implProp) {
                    ReportInterfacePropertySetterKindMismatch(
                        syntax,
                        structSymbol,
                        iface.Name,
                        iprop.Name,
                        iprop.IsInitOnly,
                        implProp
                    )
                    continue
                }
            }
            // Issue #2150: a data-class positional (primary-constructor)
            // parameter may satisfy a matching get-only interface property.
            // Walk the
            // this-first BaseClass chain (mirroring `TryGetProperty` and
            // issue #1066) and treat a same-name, type-compatible
            // positional parameter as satisfying the property contract.
            if !found && TypeMemberModel.TryGetPrimaryConstructorParameter(
                structSymbol,
                iprop.Name,
                out var positionalParam
            ) {
                found = true
                // Issue #2150: get-only covariance permits T to satisfy T?
                // only when the nullable annotation is erased in metadata
                // (reference types and unconstrained type parameters).
                // Nullable<T> over a value type has a distinct CLR signature.
                // Settable properties remain invariant.
                if !IsInterfacePropertyTypeCompatible(
                    positionalParam!!.Type,
                    iprop.Type,
                    iprop.HasSetter,
                    typeParameterMap
                ) {
                    // Name matches but the type is incompatible: the
                    // positional parameter does not satisfy the contract.
                    // Fall through to the single GS0504 report below.
                    found = false
                } else {
                    // Issue #2875: positional data members are init-only.
                    // Their set_ accessor carries IsExternalInit and therefore
                    // cannot fill an ordinary settable interface slot.
                    if iprop.HasSetter && !iprop.IsInitOnly {
                        ReportInterfacePropertySetterKindMismatch(
                            syntax,
                            structSymbol,
                            iface.Name,
                            iprop.Name,
                            "positional member",
                            positionalParam!!.Name,
                            interfaceIsInitOnly: false,
                            implementationIsInitOnly: true
                        )
                        continue
                    }
                    // Record the positional parameter so a backing
                    // auto-property is synthesized below, filling the
                    // interface's getter (and, for an init-only interface,
                    // init accessor) slot.
                    let needsSetter = iprop.HasSetter
                    if positionalInterfaceProps.TryGetValue(iprop.Name, out var existing) {
                        positionalInterfaceProps[iprop.Name] = (existing.Param, existing.NeedsSetter || needsSetter)
                    } else {
                        positionalInterfaceProps[iprop.Name] = (positionalParam!!, needsSetter)
                    }
                }
            }
            if !found {
                // Issue #2293: an interface property whose required
                // accessors all carry a default (arrow/block) body is
                // satisfied by inheritance, exactly like a
                // default-interface method — no GS0187 needed.
                if PropertyHasDefaultBody(iprop) {
                    continue
                }
                if typeMismatch != nil {
                    let expectedType = GetInterfacePropertyExpectedType(iprop.Type, typeParameterMap)
                    if string.Equals(expectedType.ToString(), typeMismatch.Type.ToString(), StringComparison.Ordinal) {
                        Diagnostics.ReportInterfaceMethodNotImplemented(
                            syntax.Identifier.Location,
                            structSymbol,
                            iface.Name,
                            iprop.Name
                        )
                    } else {
                        Diagnostics.ReportInterfacePropertyTypeMismatch(
                            syntax.Identifier.Location,
                            structSymbol.Name,
                            typeMismatch.Name,
                            iface.Name,
                            iprop.Name,
                            expectedType,
                            typeMismatch.Type
                        )
                    }
                } else {
                    Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol,
                        iface.Name,
                        iprop.Name
                    )
                }
            }
        }
    }

    private func ReportInterfacePropertySetterKindMismatch(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        interfaceName string,
        propertyName string,
        interfaceIsInitOnly bool,
        implementation PropertySymbol
    ) {
        let isPositionalMember = implementation.Declaration == nil && TypeMemberModel.TryGetPrimaryConstructorParameter(
            structSymbol,
            implementation.Name,
            out _
        )
        ReportInterfacePropertySetterKindMismatch(
            syntax,
            structSymbol,
            interfaceName,
            propertyName,
            if isPositionalMember {
                "positional member"
            } else {
                "property"
            },
            implementation.Name,
            interfaceIsInitOnly,
            implementation.IsInitOnly
        )
    }

    private func ReportInterfacePropertySetterKindMismatch(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        interfaceName string,
        propertyName string,
        memberKind string,
        memberName string,
        interfaceIsInitOnly bool,
        implementationIsInitOnly bool
    ) {
        let implementationAccessor = if implementationIsInitOnly {
            "init"
        } else {
            "set"
        }
        let requiredAccessor = if interfaceIsInitOnly {
            "init"
        } else {
            "set"
        }
        let requiredArticle = if interfaceIsInitOnly {
            "an"
        } else {
            "a"
        }
        let fix = if memberKind == "positional member" {
            "declare property '$memberName' explicitly with $requiredArticle '$requiredAccessor' accessor."
        } else {
            "change property '$memberName' to use accessor '$requiredAccessor'."
        }
        Diagnostics.ReportInterfacePropertySetterKindMismatch(
            syntax.Identifier.Location,
            structSymbol.Name,
            memberKind,
            memberName,
            interfaceName,
            propertyName,
            implementationAccessor,
            requiredAccessor,
            fix
        )
    }

    private func VerifyInterfaceEventImplementations(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        iface InterfaceSymbol
    ) {
        let eventDefIface = iface.Definition ?? iface
        if eventDefIface.Events.IsDefaultOrEmpty {
            return
        }
        for interfaceEvent in eventDefIface.Events {
            if TryResolveExplicitInterfaceEventImplementation(structSymbol, iface, interfaceEvent) != nil {
                continue
            }
            var implementation EventSymbol? = nil
            for type in structSymbol.GetHierarchy() {
                if implementation != nil {
                    break
                }
                for candidate in type.Events {
                    if candidate.HasExplicitInterfaceClause ||
                        candidate.Name != interfaceEvent.Name ||
                        (
                        !object.ReferenceEquals(type, structSymbol) && candidate.Accessibility != Accessibility.Public
                    ) ||
                        !InterfaceEventTypesEquivalent(iface, interfaceEvent, candidate) {
                        continue
                    }
                    implementation = candidate
                    break
                }
            }
            if implementation == nil {
                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol,
                    iface.Name,
                    interfaceEvent.Name
                )
            }
        }
    }

    // ADR-0149: sweep every explicit-interface qualifier clause that
    // successfully bound a target interface (via
    // ResolveExplicitInterfaceClauses) for two outstanding problems
    // the per-interface-member loops above cannot detect on their
    // own: (a) two members on the same type both explicitly claim
    // the same (interface, name) slot (GS0495), and (b) a clause
    // whose target interface has no member matching this
    // declaration's name/signature/accessor-shape at all (GS0494) —
    // the loops above only ever *consume* a clause-bearing candidate
    // when it matches; one that never matches anything is otherwise
    // silently accepted as an ordinary (non-conforming) member.
    /// ADR-0149: reports GS0495 for two explicit-interface-clause members on
    /// the same type that target the same (interface, member-name) slot, and
    /// GS0494 for a clause-bearing member whose target interface was
    /// resolved (by (cref:ResolveExplicitInterfaceClauses)) but which
    /// never matched any interface member during the per-interface-member
    /// loops above (i.e. its `ExplicitInterfaceMember` is still
    /// unset) — most commonly a signature or accessor-shape mismatch, or a
    /// name the target interface simply does not declare.
    private func VerifyExplicitInterfaceClauseResolution(syntax StructDeclarationSyntax, structSymbol StructSymbol) {
        let seenSlots = Dictionary[(Iface TypeSymbol, Name string), bool]()
        if !structSymbol.Methods.IsDefaultOrEmpty {
            for method in structSymbol.Methods {
                if !method.HasExplicitInterfaceClause || method.ExplicitInterfaceClauseTarget == nil {
                    continue
                }
                let target = method.ExplicitInterfaceClauseTarget
                let slot = (target!!, method.Name)
                if seenSlots.ContainsKey(slot) {
                    Diagnostics.ReportDuplicateExplicitInterfaceImplementation(
                        Invariant
                            .Required(
                            method.Declaration,
                            "an explicit interface method has a declaration",
                            expression: "method.Declaration"
                        )
                            .Identifier
                            .Location,
                        target!!.Name,
                        method.Name
                    )
                    continue
                }
                seenSlots[slot] = true
                if method.ExplicitInterfaceMember == nil && method.ExplicitInterfaceSlot == nil {
                    Diagnostics.ReportExplicitInterfaceClauseMemberNotFound(
                        Invariant
                            .Required(
                            method.Declaration,
                            "an explicit interface method has a declaration",
                            expression: "method.Declaration"
                        )
                            .Identifier
                            .Location,
                        target!!.Name,
                        method.Name
                    )
                }
            }
        }
        if !structSymbol.Properties.IsDefaultOrEmpty {
            for prop in structSymbol.Properties {
                if !prop.HasExplicitInterfaceClause || prop.ExplicitInterfaceClauseTarget == nil {
                    continue
                }
                let target = prop.ExplicitInterfaceClauseTarget
                let slot = (target!!, prop.Name)
                if seenSlots.ContainsKey(slot) {
                    Diagnostics.ReportDuplicateExplicitInterfaceImplementation(
                        Invariant
                            .Required(
                            prop.Declaration,
                            "an explicit interface property has a declaration",
                            expression: "prop.Declaration"
                        )
                            .Identifier
                            .Location,
                        target!!.Name,
                        prop.Name
                    )
                    continue
                }
                seenSlots[slot] = true
                if prop.ExplicitInterfaceMember == nil &&
                    prop.ExplicitInterfaceGetterSlot == nil &&
                    prop.ExplicitInterfaceSetterSlot == nil {
                    Diagnostics.ReportExplicitInterfaceClauseMemberNotFound(
                        Invariant
                            .Required(
                            prop.Declaration,
                            "an explicit interface property has a declaration",
                            expression: "prop.Declaration"
                        )
                            .Identifier
                            .Location,
                        target!!.Name,
                        prop.Name
                    )
                }
            }
        }
        // ADR-0149: generalizes the method/property sweep above to events —
        // the fourth and final explicit-implementable member kind (an
        // indexer reuses the property sweep above, since it IS a
        // PropertySymbol with IsIndexer=true).
        if !structSymbol.Events.IsDefaultOrEmpty {
            for evt in structSymbol.Events {
                if !evt.HasExplicitInterfaceClause || evt.ExplicitInterfaceClauseTarget == nil {
                    continue
                }
                let target = evt.ExplicitInterfaceClauseTarget
                let slot = (target!!, evt.Name)
                if seenSlots.ContainsKey(slot) {
                    Diagnostics.ReportDuplicateExplicitInterfaceImplementation(
                        Invariant
                            .Required(
                            evt.Declaration,
                            "an explicit interface event has a declaration",
                            expression: "evt.Declaration"
                        )
                            .Identifier
                            .Location,
                        target!!.Name,
                        evt.Name
                    )
                    continue
                }
                seenSlots[slot] = true
                if evt.ExplicitInterfaceMember == nil &&
                    evt.ExplicitInterfaceAddSlot == nil &&
                    evt.ExplicitInterfaceRemoveSlot == nil {
                    Diagnostics.ReportExplicitInterfaceClauseMemberNotFound(
                        Invariant
                            .Required(
                            evt.Declaration,
                            "an explicit interface event has a declaration",
                            expression: "evt.Declaration"
                        )
                            .Identifier
                            .Location,
                        target!!.Name,
                        evt.Name
                    )
                }
            }
        }
        // ADR-0149 follow-up (issue #2370): STATIC methods/properties use a
        // SEPARATE slot-identity dictionary — a static-virtual member and an
        // instance member of the SAME interface/name occupy different vtable
        // spaces (distinct CLR MethodImpl targets: an instance method's
        // interfaceimpl slot vs. a static-virtual method's own, unrelated
        // slot introduced by ADR-0089/#755), so they must never collide with
        // (or be conflated with) the instance sweep above.
        let seenStaticSlots = Dictionary[(Iface TypeSymbol, Name string), bool]()
        if !structSymbol.StaticMethods.IsDefaultOrEmpty {
            for method in structSymbol.StaticMethods {
                if !method.HasExplicitInterfaceClause || method.ExplicitInterfaceClauseTarget == nil {
                    continue
                }
                let target = method.ExplicitInterfaceClauseTarget
                let slot = (target!!, method.Name)
                if seenStaticSlots.ContainsKey(slot) {
                    Diagnostics.ReportDuplicateExplicitInterfaceImplementation(
                        Invariant
                            .Required(
                            method.Declaration,
                            "an explicit interface method has a declaration",
                            expression: "method.Declaration"
                        )
                            .Identifier
                            .Location,
                        target!!.Name,
                        method.Name
                    )
                    continue
                }
                seenStaticSlots[slot] = true
                if method.ExplicitInterfaceMember == nil {
                    Diagnostics.ReportExplicitInterfaceClauseMemberNotFound(
                        Invariant
                            .Required(
                            method.Declaration,
                            "an explicit interface method has a declaration",
                            expression: "method.Declaration"
                        )
                            .Identifier
                            .Location,
                        target!!.Name,
                        method.Name
                    )
                }
            }
        }
        if !structSymbol.StaticProperties.IsDefaultOrEmpty {
            for prop in structSymbol.StaticProperties {
                if !prop.HasExplicitInterfaceClause || prop.ExplicitInterfaceClauseTarget == nil {
                    continue
                }
                let target = prop.ExplicitInterfaceClauseTarget
                let slot = (target!!, prop.Name)
                if seenStaticSlots.ContainsKey(slot) {
                    Diagnostics.ReportDuplicateExplicitInterfaceImplementation(
                        Invariant
                            .Required(
                            prop.Declaration,
                            "an explicit interface property has a declaration",
                            expression: "prop.Declaration"
                        )
                            .Identifier
                            .Location,
                        target!!.Name,
                        prop.Name
                    )
                    continue
                }
                seenStaticSlots[slot] = true
                if prop.ExplicitInterfaceMember == nil {
                    Diagnostics.ReportExplicitInterfaceClauseMemberNotFound(
                        Invariant
                            .Required(
                            prop.Declaration,
                            "an explicit interface property has a declaration",
                            expression: "prop.Declaration"
                        )
                            .Identifier
                            .Location,
                        target!!.Name,
                        prop.Name
                    )
                }
            }
        }
    }

    // ADR-0090 / issue #756: verify that the implementer does not
    // attempt to override a `private` interface helper. Private
    // helpers are part of the interface's own implementation and
    // are not part of the public contract; an implementer that
    // happens to declare a same-signature method clashes with the
    // helper at the implementation level.
    /// ADR-0090 / issue #756: rejects implementers that attempt to declare a
    /// method whose signature matches one of the private helpers on an
    /// implemented interface. Private interface helpers are not part of the
    /// public contract — implementers cannot see them — but a same-shape
    /// declaration would create an ambiguous v-table slot if we did not
    /// surface a diagnostic.
    /// @param syntax The implementer's declaring syntax (for location).
    /// @param structSymbol The class symbol whose interfaces are checked.
    private func VerifyPrivateInterfaceHelpersNotOverridden(syntax StructDeclarationSyntax, structSymbol StructSymbol) {
        for iface in structSymbol.Interfaces {
            if !iface.PrivateMethods.IsDefaultOrEmpty {
                for imethod in iface.PrivateMethods {
                    for candidate in structSymbol.GetMethodsIncludingInherited(imethod.Name) {
                        if SignaturesMatch(
                            imethod,
                            GetCallableParameters(candidate),
                            candidate.Type,
                            candidate.ReturnRefKind,
                            typeParamMap: nil,
                            candidate.IsAsync,
                            candidate.IsAsyncVoid
                        ) {
                            Diagnostics.ReportImplementerOverridesPrivateInterfaceMember(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name
                            )
                            break
                        }
                    }
                }
            }
            if !iface.StaticPrivateMethods.IsDefaultOrEmpty {
                for imethod in iface.StaticPrivateMethods {
                    for candidate in structSymbol.GetStaticMethods(imethod.Name) {
                        if StaticVirtualSignaturesMatch(imethod, candidate) {
                            Diagnostics.ReportImplementerOverridesPrivateInterfaceMember(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name
                            )
                            break
                        }
                    }
                }
            }
        }
    }

    // ADR-0089 / issue #755: verify static-virtual interface members.
    // For each declared interface, walk its StaticMethods. The
    // implementer must either (a) declare a matching static method
    // inside its `shared { ... }` block (ADR-0053) — recorded on
    // StructSymbol.StaticMethods — or (b) inherit a default body
    // from the interface itself (the interface method declaration
    // carries a body). If a same-named *instance* method exists but
    // no matching static method, GS0332 surfaces; otherwise GS0331.
    /// ADR-0089 / issue #755: enforces that every static-virtual interface
    /// member without a default body is matched by a same-signature static
    /// method on the implementer. A non-static implementer member with the
    /// same name produces GS0332; otherwise GS0331.
    private func VerifyStaticVirtualInterfaceImplementations(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol
    ) {
        for iface in structSymbol.Interfaces {
            if iface.StaticMethods.IsDefaultOrEmpty {
                continue
            }
            for imethod in iface.StaticMethods {
                // ADR-0149 follow-up (issue #2370): an explicit-interface-
                // clause static method (`func (IFoo) M(...)` inside a
                // `shared { }` block) satisfies this slot even though its
                // own declared name never needs to match `imethod` — already
                // resolved and linked by ResolveExplicitInterfaceClauses.
                // Skip the name-based lookup entirely once found; no
                // diagnostic, and the emitter binds the MethodImpl slot via
                // FunctionSymbol.ExplicitInterfaceMember.
                if TryResolveExplicitInterfaceStaticImplementation(structSymbol, iface, imethod) != nil {
                    continue
                }
                var sigMatch = false
                var nameMatch = false
                for candidate in structSymbol.GetStaticMethods(imethod.Name) {
                    // Issue #4614: an explicit-interface-clause member keeps the
                    // plain name but implements only the interface its clause
                    // names; it never satisfies another interface's slot by
                    // name. The emitter applies the same predicate, so a slot
                    // this check accepts always gets its MethodImpl.
                    if !MemberLookup.IsImplicitInterfaceImplementationCandidate(candidate) {
                        continue
                    }
                    nameMatch = true
                    if StaticVirtualSignaturesMatch(imethod, candidate) {
                        sigMatch = true
                        break
                    }
                }
                if sigMatch {
                    continue
                }
                if !nameMatch {
                    // Detect a non-static instance candidate with the same
                    // name → GS0332 — instance member cannot satisfy a
                    // static-virtual slot.
                    for instCandidate in structSymbol.GetMethodsIncludingInherited(imethod.Name) {
                        if !instCandidate.IsStatic {
                            Diagnostics.ReportNonStaticMemberForStaticVirtualSlot(
                                syntax.Identifier.Location,
                                structSymbol,
                                iface.Name,
                                imethod.Name
                            )
                            nameMatch = true
                            break
                        }
                    }
                }
                if sigMatch || nameMatch {
                    continue
                }
                // No same-name candidate at all. If the interface itself
                // provides a default body, the implementer inherits it.
                if InterfaceSymbol.HasDefaultBody(imethod) {
                    continue
                }
                Diagnostics.ReportStaticVirtualInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol,
                    iface.Name,
                    imethod.Name
                )
            }
        }
    }

    // ADR-0089 / issue #1019: verify static-virtual interface
    // *properties*. The implementer must declare a matching static
    // property (same name and type, with at least the required
    // accessors) inside its `shared { ... }` block; otherwise GS0397.
    /// ADR-0089 / issue #1019: enforces that every static-virtual interface
    /// property (declared inside the interface `shared { … }` block) is
    /// matched by a same-name, same-type static property on the implementer
    /// providing at least the required accessors. Missing slots produce GS0397.
    private func VerifyStaticVirtualInterfacePropertyImplementations(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol
    ) {
        for iface in structSymbol.Interfaces {
            // Pre-existing bug found while generalizing #2370 to static
            // explicit members: InterfaceSymbol.Construct does NOT
            // substitute Properties onto a constructed generic instance
            // (see InterfaceSymbol.TryResolveMembers, and the identical
            // `iface.Definition ?? iface` fixes above for the instance
            // explicit-property/-event pre-passes) — `iface.Properties` is
            // empty for e.g. `IBox[int32]`, so a static-virtual property
            // requirement declared on a GENERIC interface was silently
            // never verified at all before this fix.
            let staticPropDefIface = iface.Definition ?? iface
            if staticPropDefIface.Properties.IsDefaultOrEmpty {
                continue
            }
            for iprop in staticPropDefIface.Properties {
                if !iprop.IsStatic {
                    continue
                }
                // Issue #1030: a default-bodied static-virtual interface
                // property accessor (non-abstract) supplies its own body, so
                // an implementer is NOT required to provide it. Only abstract
                // accessors must be satisfied. Compute per-accessor whether an
                // abstract slot remains for the implementer to fill.
                let getterIsAbstract = iprop.HasGetter && (iprop.GetterSymbol == nil || iprop.GetterSymbol!!.IsAbstract)
                let setterIsAbstract = iprop.HasSetter && (iprop.SetterSymbol == nil || iprop.SetterSymbol!!.IsAbstract)
                if !getterIsAbstract && !setterIsAbstract {
                    // Fully default-bodied property: nothing the implementer
                    // must provide.
                    continue
                }
                // ADR-0149 follow-up (issue #2370): an explicit-interface-
                // clause static property (`prop (IFoo) P T` inside a
                // `shared { }` block) satisfies this slot regardless of its
                // own declared name — already resolved and linked by
                // ResolveExplicitInterfaceClauses. Skip the name-based
                // lookup entirely once found.
                if TryResolveExplicitInterfaceStaticPropertyImplementation(structSymbol, iface, iprop) != nil {
                    continue
                }
                var match PropertySymbol? = nil
                let typeParameterMap = BuildInterfaceTypeParameterMap(iface)
                for candidate in structSymbol.StaticProperties {
                    if candidate.Name == iprop.Name && MemberLookup.IsImplicitInterfaceImplementationCandidate(
                        candidate
                    ) &&
                        IsInterfacePropertyTypeCompatible(
                        candidate.Type,
                        iprop.Type,
                        iprop.HasSetter,
                        typeParameterMap
                    ) {
                        match = candidate
                        break
                    }
                }
                if match == nil {
                    Diagnostics.ReportStaticVirtualInterfacePropertyNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iprop.Name,
                        "missing static property"
                    )
                    continue
                }
                if getterIsAbstract && !match.HasGetter {
                    Diagnostics.ReportStaticVirtualInterfacePropertyNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iprop.Name,
                        "getter"
                    )
                }
                if setterIsAbstract && !match.HasSetter {
                    Diagnostics.ReportStaticVirtualInterfacePropertyNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iprop.Name,
                        "setter"
                    )
                }
            }
        }
    }

    /// ADR-0085 / issue #726: builds a stable signature key for an interface
    /// method (used to detect diamond conflicts across multiple interfaces).
    /// The key is "Name(P0, P1, …)" using the parameter type names from the
    /// callable shape (which strips the implicit `this`).
    private func BuildInterfaceMethodSignatureKey(method FunctionSymbol) string {
        let sb = StringBuilder()
        sb.Append(method.Name)
        sb.Append('(')
        let parameters = GetCallableParameters(method)
        for var i = 0; i < parameters.Length; i++ {
            if i > 0 {
                sb.Append(',')
            }
            sb.Append(parameters[i].Type?.Name ?? "?")
        }
        sb.Append(')')
        return sb.ToString()
    }

    // Issue #525: verify CLR interfaces declared in the base-type clause.
    // Walks each public member on the imported interface. Existing
    // implementations are contract-checked even for default members; only a
    // missing abstract member reports through the GS0187 channel.
    private func VerifyClrInterfaceImplementations(syntax StructDeclarationSyntax, structSymbol StructSymbol) {
        if structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty {
            return
        }
        for ifaceSym in structSymbol.ImplementedClrInterfaces {
            let clrIface Type? = ifaceSym.ClrType
            if clrIface == nil {
                continue
            }
            let interfaceName = SymbolDisplay.ToTypeDisplayString(ifaceSym)
            // Issue #949: a CLR generic interface closed over a user-defined G#
            // type (e.g. the self-referential `class Shape : IEquatable[Shape]`)
            // is represented with a type-erased ClrType (`IEquatable<object>`)
            // but carries the real symbolic arguments. Verify against the OPEN
            // definition's members with those arguments substituted in, so the
            // contract demands `Equals(Shape)` rather than `Equals(object)`.
            if MemberLookup.TryGetSymbolicClrGenericInterface(ifaceSym, out var openDefinition, out var symbolicArgs) {
                VerifySymbolicClrGenericInterface(
                    syntax,
                    structSymbol,
                    ifaceSym,
                    openDefinition,
                    symbolicArgs,
                    interfaceName
                )
                continue
            }
            // Issue #4593: re-listing an interface the imported base already
            // implements leaves every slot satisfied by the inherited mapping.
            let satisfiedByImportedBase = ImportedBaseImplementsClrInterface(structSymbol, ifaceSym)
            // Methods excluding property/event accessors (those are validated
            // through their owning property / event below).
            for clrMethod in clrIface.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                if clrMethod.IsSpecialName {
                    continue
                }
                VerifyClrInterfaceMember(
                    isRequired: clrMethod.IsAbstract && !satisfiedByImportedBase,
                    findImplementation: () -> FindClrInterfaceMethodImplementation(
                        structSymbol,
                        ifaceSym,
                        clrMethod,
                        () -> MemberLookup.FindMatchingMethodForClrSignature(structSymbol, clrMethod)
                    ),
                    validateImplementation: (implementation FunctionSymbol) -> ValidateUnscopedRefContract(
                        implementation,
                        enforceContract: true,
                        RefCapabilities.HasUnscopedRef(clrMethod),
                        "implemented member '$interfaceName.${clrMethod.Name}'"
                    ),
                    reportMissing: () -> Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol,
                        interfaceName,
                        FormatClrMethodSignature(clrMethod)
                    )
                )
            }
            // Properties.
            for clrProp in clrIface.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
                let requiresGetter = clrProp.GetMethod?.IsAbstract == true
                let requiresSetter = clrProp.SetMethod?.IsAbstract == true
                let isRequired = requiresGetter || requiresSetter
                // A field-backed re-mapping (#573/#606) still applies when the
                // imported base satisfies the slot; only the GS0187 is waived.
                VerifyClrInterfaceMember(
                    isRequired && !satisfiedByImportedBase,
                    findImplementation: () -> FindClrInterfacePropertyImplementationOrField(
                        structSymbol,
                        ifaceSym,
                        clrProp,
                        clrProp.GetMethod,
                        clrProp.SetMethod,
                        ImmutableArray[TypeSymbol].Empty,
                        requiresSetter,
                        isRequired
                    ),
                    validateImplementation: (implProp PropertySymbol) -> {
                        ValidateUnscopedRefPropertyContract(
                            implProp,
                            clrProp.GetMethod,
                            clrProp.SetMethod,
                            structSymbol,
                            "implemented property '$interfaceName.${clrProp.Name}'",
                            enforceInterfaceContract: true
                        )
                        if requiresGetter && !implProp.HasGetter {
                            Diagnostics.ReportInterfaceMethodNotImplemented(
                                syntax.Identifier.Location,
                                structSymbol,
                                interfaceName,
                                clrProp.Name + " (getter)"
                            )
                        }
                        if requiresSetter && !implProp.HasSetter {
                            Diagnostics.ReportInterfaceMethodNotImplemented(
                                syntax.Identifier.Location,
                                structSymbol,
                                interfaceName,
                                clrProp.Name + " (setter)"
                            )
                        } else if requiresSetter {
                            ReportClrInterfacePropertySetterKindMismatchIfNeeded(
                                syntax,
                                structSymbol,
                                interfaceName,
                                clrProp.Name,
                                Invariant.Required(
                                    clrProp.SetMethod,
                                    "an interface property requiring a setter has a setter",
                                    expression: "clrProp.SetMethod"
                                ),
                                implProp
                            )
                        }
                    },
                    reportMissing: () -> Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol,
                        interfaceName,
                        clrProp.Name
                    )
                )
            }
        }
    }

    // Issue #985: a CLR interface in the base clause may inherit other
    // interfaces whose abstract members are NOT enumerated by the
    // direct-interface walk above (e.g. `IEnumerable[T]` inherits the
    // non-generic `IEnumerable.GetEnumerator()`). The resulting type
    // must satisfy those inherited slots too — otherwise the runtime
    // rejects it with a TypeLoadException. Verify them here so a missing
    // bridge (the canonical "only the generic GetEnumerator present"
    // case) surfaces as GS0187 instead of emitting an unloadable type.
    /// Issue #985: verifies that the type satisfies every abstract method slot
    /// contributed by interfaces that its declared CLR interfaces transitively
    /// inherit. The direct-interface walks
    /// ((cref:VerifyClrInterfaceImplementations) /
    /// (cref:VerifySymbolicClrGenericInterface)) only enumerate the
    /// declared interface's OWN members, so an inherited slot such as the
    /// non-generic `IEnumerable.GetEnumerator()` reached through
    /// `IEnumerable[T]` would otherwise go unverified and the emitter would
    /// produce a type the runtime cannot load. A satisfying method may be the
    /// covariant-return bridge accepted by
    /// (cref:MemberLookup.TryResolveCovariantInterfaceBridge).
    private func VerifyInheritedClrInterfaceSlots(syntax StructDeclarationSyntax, structSymbol StructSymbol) {
        if structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty {
            return
        }
        let reported = HashSet[string](StringComparer.Ordinal)
        for ifaceSym in structSymbol.ImplementedClrInterfaces {
            for slot in MemberLookup.EnumerateClrInterfaceSlots(ifaceSym, includeDefaultMethods: true) {
                if !slot.IsInherited {
                    // The declared interface's own members are checked by the
                    // direct-interface walks; only inherited slots are new here.
                    continue
                }
                let declaringType Type? = slot.Method.DeclaringType
                let slotKey = (declaringType?.FullName ?? declaringType?.Name ?? string.Empty) +
                    "::" +
                    MemberLookup.FormatClrSlotSignature(slot.Method)
                let interfaceName = if declaringType == nil {
                    "interface"
                } else {
                    SymbolDisplay.ToTypeDisplayString(declaringType)
                }
                VerifyClrInterfaceMember(
                    isRequired: slot
                        .Method
                        .IsAbstract &&
                        !ImportedBaseImplementsClrInterface(structSymbol, slot.SlotOwner),
                    findImplementation: () -> FindClrInterfaceMethodImplementation(structSymbol, slot),
                    validateImplementation: (implementation FunctionSymbol) -> ValidateUnscopedRefContract(
                        implementation,
                        enforceContract: true,
                        RefCapabilities.HasUnscopedRef(slot.Method),
                        "implemented member '$slotKey'"
                    ),
                    reportMissing: () -> {
                        if reported.Add(slotKey) {
                            Diagnostics.ReportInterfaceMethodNotImplemented(
                                syntax.Identifier.Location,
                                structSymbol,
                                interfaceName,
                                FormatClrMethodSignature(slot.Method)
                            )
                        }
                    }
                )
            }
            for slot in MemberLookup.EnumerateClrInterfacePropertySlots(ifaceSym) {
                if !slot.IsInherited {
                    continue
                }
                let property = slot.Property
                let declaringType Type? = property.DeclaringType
                let interfaceName = if declaringType == nil {
                    "interface"
                } else {
                    SymbolDisplay.ToTypeDisplayString(declaringType)
                }
                let slotKey = (declaringType?.FullName ?? declaringType?.Name ?? string.Empty) +
                    "::" +
                    property.Name +
                    "::" +
                    (
                    if property.GetMethod == nil {
                        string.Empty
                    } else {
                        MemberLookup.FormatClrSlotSignature(property.GetMethod!!)
                    }
                ) +
                    "::" +
                    (
                    if property.SetMethod == nil {
                        string.Empty
                    } else {
                        MemberLookup.FormatClrSlotSignature(property.SetMethod!!)
                    }
                )
                let requiresGetter = property.GetMethod?.IsAbstract == true
                let requiresSetter = property.SetMethod?.IsAbstract == true
                let isRequired = requiresGetter || requiresSetter
                VerifyClrInterfaceMember(
                    isRequired && !ImportedBaseImplementsClrInterface(structSymbol, slot.SlotOwner),
                    findImplementation: () -> FindClrInterfacePropertyImplementationOrField(
                        structSymbol,
                        slot.SlotOwner,
                        property,
                        property.GetMethod,
                        property.SetMethod,
                        slot.SymbolicArgs,
                        requiresSetter,
                        isRequired
                    ),
                    validateImplementation: (implementation PropertySymbol) -> {
                        ValidateUnscopedRefPropertyContract(
                            implementation,
                            property.GetMethod,
                            property.SetMethod,
                            structSymbol,
                            "implemented property '$interfaceName.${property.Name}'",
                            enforceInterfaceContract: true
                        )
                        if requiresGetter && !implementation.HasGetter {
                            Diagnostics.ReportInterfaceMethodNotImplemented(
                                syntax.Identifier.Location,
                                structSymbol,
                                interfaceName,
                                property.Name + " (getter)"
                            )
                        }
                        if requiresSetter && !implementation.HasSetter {
                            Diagnostics.ReportInterfaceMethodNotImplemented(
                                syntax.Identifier.Location,
                                structSymbol,
                                interfaceName,
                                property.Name + " (setter)"
                            )
                        } else if requiresSetter {
                            ReportClrInterfacePropertySetterKindMismatchIfNeeded(
                                syntax,
                                structSymbol,
                                interfaceName,
                                property.Name,
                                Invariant.Required(
                                    property.SetMethod,
                                    "an interface property requiring a setter has a setter",
                                    expression: "property.SetMethod"
                                ),
                                implementation
                            )
                        }
                    },
                    reportMissing: () -> {
                        if reported.Add(slotKey) {
                            Diagnostics.ReportInterfaceMethodNotImplemented(
                                syntax.Identifier.Location,
                                structSymbol,
                                interfaceName,
                                property.Name
                            )
                        }
                    }
                )
            }
        }
    }

    /// Issue #949: verifies a class against a CLR generic interface that is
    /// closed over at least one user-defined G# type argument (e.g.
    /// `IEquatable[Shape]`, including the self-referential
    /// `class Shape : IEquatable[Shape]`). The interface's `ClrType`
    /// is type-erased (`IEquatable<object>`), so the contract is
    /// checked against the OPEN definition's members with the symbolic
    /// arguments substituted in — the class must provide `Equals(Shape)`,
    /// not `Equals(object)`.
    private func VerifySymbolicClrGenericInterface(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        interfaceType TypeSymbol,
        openDefinition Type,
        symbolicArgs ImmutableArray[TypeSymbol],
        interfaceName string
    ) {
        for openMethod in openDefinition.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
            if openMethod.IsSpecialName {
                continue
            }
            // C# records implement IEquatable<Self> with the typed Equals
            // overload synthesized by data-type emission.
            if structSymbol.IsData && ClrTypeUtilities.AreSame(openDefinition, typeof(System.IEquatable[_])) &&
                symbolicArgs.Length == 1 &&
                symbolicArgs[0] is StructSymbol equatableSelf &&
                (
                equatableSelf
                    .EnclosingTypeArguments
                    .IsDefaultOrEmpty ||
                    equatableSelf
                    .EnclosingTypeArguments
                    .SequenceEqual[TypeSymbol](StructSymbol.CollectEnclosingTypeParameters(structSymbol))
            ) &&
                ConformanceSignaturesEquivalent(
                equatableSelf,
                StructSymbol.Construct(structSymbol, structSymbol.TypeParameters.Cast[TypeSymbol]().ToImmutableArray())
            ) &&
                openMethod.Name == "Equals" &&
                openMethod
                .GetParameters().Length == 1 {
                continue
            }
            let erasedSlot = if interfaceType.ClrType == nil {
                default(MethodInfo?)
            } else {
                FindErasedSlotForOpenMethod(interfaceType.ClrType, openMethod)
            }
            VerifyClrInterfaceMember(
                isRequired: openMethod.IsAbstract,
                findImplementation: () -> FindClrInterfaceMethodImplementation(
                    structSymbol,
                    interfaceType,
                    erasedSlot,
                    () -> MemberLookup.FindMatchingMethodForSymbolicClrInterface(structSymbol, openMethod, symbolicArgs)
                ),
                validateImplementation: (implementation FunctionSymbol) -> ValidateUnscopedRefContract(
                    implementation,
                    enforceContract: true,
                    RefCapabilities.HasUnscopedRef(openMethod),
                    "implemented member '$interfaceName.${openMethod.Name}'"
                ),
                reportMissing: () -> Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol,
                    interfaceName,
                    FormatClrMethodSignature(openMethod)
                )
            )
        }
        for openProp in openDefinition.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
            let erasedGetter = if interfaceType.ClrType == nil || openProp.GetMethod == nil {
                default(MethodInfo?)
            } else {
                FindErasedSlotForOpenMethod(interfaceType.ClrType, openProp.GetMethod!!)
            }
            let erasedSetter = if interfaceType.ClrType == nil || openProp.SetMethod == nil {
                default(MethodInfo?)
            } else {
                FindErasedSlotForOpenMethod(interfaceType.ClrType, openProp.SetMethod!!)
            }
            let requiresGetter = openProp.GetMethod?.IsAbstract == true
            let requiresSetter = openProp.SetMethod?.IsAbstract == true
            VerifyClrInterfaceMember(
                isRequired: requiresGetter || requiresSetter,
                findImplementation: () -> FindClrInterfacePropertyImplementationOrField(
                    structSymbol,
                    interfaceType,
                    openProp,
                    erasedGetter,
                    erasedSetter,
                    symbolicArgs,
                    requiresSetter,
                    requiresGetter || requiresSetter
                ),
                validateImplementation: (implProp PropertySymbol) -> {
                    ValidateUnscopedRefPropertyContract(
                        implProp,
                        openProp.GetMethod,
                        openProp.SetMethod,
                        structSymbol,
                        "implemented property '$interfaceName.${openProp.Name}'",
                        enforceInterfaceContract: true
                    )
                    if requiresGetter && !implProp.HasGetter {
                        Diagnostics.ReportInterfaceMethodNotImplemented(
                            syntax.Identifier.Location,
                            structSymbol,
                            interfaceName,
                            openProp.Name + " (getter)"
                        )
                    }
                    if requiresSetter && !implProp.HasSetter {
                        Diagnostics.ReportInterfaceMethodNotImplemented(
                            syntax.Identifier.Location,
                            structSymbol,
                            interfaceName,
                            openProp.Name + " (setter)"
                        )
                    } else if requiresSetter {
                        ReportClrInterfacePropertySetterKindMismatchIfNeeded(
                            syntax,
                            structSymbol,
                            interfaceName,
                            openProp.Name,
                            Invariant.Required(
                                openProp.SetMethod,
                                "an interface property requiring a setter has a setter",
                                expression: "openProp.SetMethod"
                            ),
                            implProp
                        )
                    }
                },
                reportMissing: () -> Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol,
                    interfaceName,
                    openProp.Name
                )
            )
        }
    }

    private func ReportClrInterfacePropertySetterKindMismatchIfNeeded(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        interfaceName string,
        propertyName string,
        interfaceSetter MethodInfo,
        implementation PropertySymbol
    ) {
        let interfaceIsInitOnly = ImportedTypeSymbol.IsInitOnlySetter(interfaceSetter)
        if interfaceIsInitOnly == implementation.IsInitOnly {
            return
        }
        ReportInterfacePropertySetterKindMismatch(
            syntax,
            structSymbol,
            interfaceName,
            propertyName,
            interfaceIsInitOnly,
            implementation
        )
    }

    shared {
        /// Issue #3814: maps a method of a CLR generic interface's OPEN definition
        /// onto the corresponding method of the ERASED closed shape the rest of the
        /// pipeline reflects against, by metadata identity.
        /// @param erasedInterface The erased closed interface type.
        /// @param openSlot The method on the open definition.
        /// @returns The matching method on [`erasedInterface`](paramref), or `null`.
        private func FindErasedSlotForOpenMethod(erasedInterface Type, openSlot MethodInfo) MethodInfo? {
            for candidate in erasedInterface.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                if candidate.MetadataToken == openSlot.MetadataToken && candidate.Module == openSlot.Module {
                    return candidate
                }
            }
            return nil
        }

        private func ExplicitClrPropertyMatches(property PropertySymbol, target TypeSymbol, slot PropertyInfo) bool -> (
            slot.GetMethod != nil
        ) == property.HasGetter &&
            (slot.SetMethod != nil) == property.HasSetter &&
            MemberLookup.PropertyMatchesClrInterfaceSignature(property, target, slot)

        internal func IsInterfacePropertyTypeCompatible(
            implementationType TypeSymbol,
            interfaceType TypeSymbol,
            hasSetter bool,
            typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]?
        ) bool {
            if !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                GetInterfacePropertySlotType(interfaceType, typeParameterMap),
                implementationType
            ) {
                return false
            }
            let implementationIsNullable = implementationType is NullableTypeSymbol
            let substitutedInterfaceType = SubstituteInterfacePropertyType(interfaceType, typeParameterMap)
            // ADR-0186: a platform property (declared in an ADR-0186 §9 oblivious
            // scope, or read from oblivious metadata) states nothing about nil, so
            // it conforms to a slot written either way — including a settable
            // `T?` slot, which the exact-nullability rule below would reject.
            if implementationType is PlatformTypeSymbol || substitutedInterfaceType is PlatformTypeSymbol {
                return true
            }
            let interfaceIsNullable = substitutedInterfaceType is NullableTypeSymbol
            return if hasSetter {
                interfaceIsNullable == implementationIsNullable
            } else {
                interfaceIsNullable || !implementationIsNullable
            }
        }

        internal func GetInterfacePropertySlotType(
            type TypeSymbol,
            typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]?
        ) TypeSymbol -> if typeParameterMap == nil {
            type
        } else {
            StructSymbol.SubstituteTypeParameters(type, typeParameterMap, eraseReferenceNullability: true)!!
        }

        private func SubstituteInterfacePropertyType(
            interfaceType TypeSymbol,
            typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]?
        ) TypeSymbol {
            if typeParameterMap == nil {
                return interfaceType
            }
            return StructSymbol.SubstituteTypeParameters(interfaceType, typeParameterMap)!!
        }

        internal func GetInterfacePropertyExpectedType(
            interfaceType TypeSymbol,
            typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]?
        ) TypeSymbol {
            let substituted = SubstituteInterfacePropertyType(interfaceType, typeParameterMap)
            if interfaceType is NullableTypeSymbol{UnderlyingType: TypeParameterSymbol declaredTypeParameter} &&
                !declaredTypeParameter.HasValueTypeConstraint &&
                substituted is NullableTypeSymbol substitutedNullable &&
                NullableLifting
                .IsAnyValueTypeNullable(substitutedNullable) {
                return GetInterfacePropertySlotType(interfaceType, typeParameterMap)
            }
            return if interfaceType is NullableTypeSymbol {
                substituted
            } else {
                GetInterfacePropertySlotType(interfaceType, typeParameterMap)
            }
        }

        /// Finds the source method selected for an interface slot.
        /// @param structSymbol The implementing type.
        /// @param iface The interface containing the slot.
        /// @param interfaceMethod The interface method.
        /// @returns The explicit or implicit implementation, if present.
        internal func FindInterfaceMethodImplementation(
            structSymbol StructSymbol,
            iface InterfaceSymbol,
            interfaceMethod FunctionSymbol
        ) FunctionSymbol? -> TryResolveExplicitInterfaceImplementation(structSymbol, iface, interfaceMethod) ??
            FindImplicitInterfaceMethodImplementation(structSymbol, interfaceMethod, out _)

        private func FindImplicitInterfaceMethodImplementation(
            structSymbol StructSymbol,
            interfaceMethod FunctionSymbol,
            out firstCandidate FunctionSymbol?
        ) FunctionSymbol? {
            firstCandidate = nil
            for candidate in structSymbol.GetMethodsIncludingInherited(interfaceMethod.Name) {
                if !MemberLookup.IsImplicitInterfaceImplementationCandidate(candidate) {
                    continue
                }
                firstCandidate ??= candidate
                let methodTypeParamMap IReadOnlyDictionary[
                    TypeParameterSymbol,
                    TypeSymbol
                ]? = TryBuildMethodTypeParameterMap(interfaceMethod, candidate)
                if methodTypeParamMap != nil &&
                    SignaturesMatch(
                    interfaceMethod,
                    GetCallableParameters(candidate),
                    candidate.Type,
                    candidate.ReturnRefKind,
                    methodTypeParamMap,
                    candidate.IsAsync,
                    candidate.IsAsyncVoid
                ) {
                    return candidate
                }
            }
            return nil
        }

        /// Finds the source property selected for an interface slot.
        /// @param structSymbol The implementing type.
        /// @param iface The interface containing the slot.
        /// @param interfaceProperty The interface property.
        /// @returns The explicit or implicit implementation, if present.
        internal func FindInterfacePropertyImplementation(
            structSymbol StructSymbol,
            iface InterfaceSymbol,
            interfaceProperty PropertySymbol
        ) PropertySymbol? -> TryResolveExplicitInterfacePropertyImplementation(
            structSymbol,
            iface,
            interfaceProperty,
            out _
        ) ??
            (
            if TryGetConstructedInterfacePropertyImplementation(
                structSymbol,
                interfaceProperty,
                BuildInterfaceTypeParameterMap(iface),
                out var implementation,
                out _
            ) {
                implementation
            } else {
                default(PropertySymbol?)
            }
        )

        private func TryGetConstructedInterfacePropertyImplementation(
            structSymbol StructSymbol,
            interfaceProperty PropertySymbol,
            typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]?,
            out implementation PropertySymbol?,
            out typeMismatch PropertySymbol?
        ) bool {
            typeMismatch = nil
            for current in structSymbol.GetHierarchy() {
                for candidate in current.Properties {
                    if !MemberLookup.IsImplicitInterfaceImplementationCandidate(candidate) ||
                        candidate.Name != interfaceProperty.Name ||
                        (
                        !object.ReferenceEquals(current, structSymbol) &&
                            candidate.Accessibility != Accessibility.Public
                    ) ||
                        candidate.IsIndexer != interfaceProperty.IsIndexer ||
                        candidate
                        .Parameters
                        .Length != interfaceProperty
                        .Parameters
                        .Length {
                        continue
                    }
                    var parametersMatch = true
                    for var i = 0; i < interfaceProperty.Parameters.Length; i++ {
                        if !ConformanceSignaturesEquivalent(
                            interfaceProperty.Parameters[i].Type,
                            candidate.Parameters[i].Type,
                            typeParameterMap
                        ) {
                            parametersMatch = false
                            break
                        }
                    }
                    if !parametersMatch {
                        continue
                    }
                    if !IsInterfacePropertyTypeCompatible(
                        candidate.Type,
                        interfaceProperty.Type,
                        interfaceProperty.HasSetter,
                        typeParameterMap
                    ) {
                        typeMismatch ??= candidate
                        continue
                    }
                    implementation = candidate
                    return true
                }
            }
            implementation = nil
            return false
        }

        private func TryFindMatchingImportedBaseProperty(
            structSymbol StructSymbol,
            interfaceProperty PropertySymbol,
            typeParameterMap Dictionary[TypeParameterSymbol, TypeSymbol]?,
            @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out implementation PropertyInfo?,
            @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out containingType TypeSymbol?
        ) bool {
            implementation = nil
            containingType = nil
            let importedBase = TypeMemberModel.GetNearestImportedBase(structSymbol)
            if importedBase?.ClrType == nil {
                return false
            }
            for candidate in ClrTypeUtilities.SafeGetProperties(
                importedBase!!.ClrType!!,
                BindingFlags.Public | BindingFlags.Instance
            ) {
                let candidateParameters = candidate.GetIndexParameters()
                if candidate.Name != interfaceProperty.Name || RefCapabilities.GetReturnRefKind(
                    candidate
                ) != interfaceProperty.ReturnRefKind ||
                    candidateParameters.Length != interfaceProperty
                    .Parameters
                    .Length ||
                    (interfaceProperty.HasGetter && candidate.GetGetMethod(nonPublic: false) == nil) ||
                    (interfaceProperty.HasSetter && candidate.GetSetMethod(nonPublic: false) == nil) ||
                    (
                    interfaceProperty.HasSetter && interfaceProperty.IsInitOnly != ImportedTypeSymbol.IsInitOnlySetter(
                        Invariant.Required(
                            candidate.GetSetMethod(nonPublic: false),
                            "a property reported as having a setter exposes its setter",
                            expression: "candidate.GetSetMethod(nonPublic: false)"
                        )
                    )
                ) {
                    continue
                }
                var parametersMatch = true
                for var i = 0; i < interfaceProperty.Parameters.Length; i++ {
                    if RefCapabilities.GetParameterRefKind(candidateParameters[i]) != interfaceProperty
                        .Parameters[i]
                        .RefKind ||
                        !ConformanceSignaturesEquivalent(
                        interfaceProperty.Parameters[i].Type,
                        MemberLookup.GetIndexerParameterTypeSymbol(importedBase!!, candidate, i),
                        typeParameterMap
                    ) {
                        parametersMatch = false
                        break
                    }
                }
                if parametersMatch &&
                    IsInterfacePropertyTypeCompatible(
                    MemberLookup.GetClrPropertyTypeSymbol(importedBase!!, candidate),
                    interfaceProperty.Type,
                    interfaceProperty.HasSetter,
                    typeParameterMap
                ) {
                    implementation = candidate
                    containingType = MemberLookup.GetClrMemberDeclaringTypeSymbol(importedBase!!, candidate)
                    return true
                }
            }
            return false
        }

        private func InterfacePropertySetterKindsMismatch(
            interfaceProperty PropertySymbol,
            implementation PropertySymbol
        ) bool -> interfaceProperty.HasSetter &&
            implementation.HasSetter &&
            interfaceProperty.IsInitOnly != implementation.IsInitOnly

        private func SynthesizePositionalInterfaceProperties(
            structSymbol StructSymbol,
            positionalInterfaceProps Dictionary[string, (Param ParameterSymbol, NeedsSetter bool)]
        ) {
            // Issue #2150: materialize synthesized backing auto-properties for
            // every data-class positional parameter that satisfied an interface
            // property above. Member access still resolves to the underlying
            // field (fields are probed before properties), so this only adds the
            // get_/set_ accessor methods the CLR interface slot requires. The
            // existing property-emission path (planning, accessor IL, PropertyDef
            // rows, and Virtual|NewSlot promotion for interface implementation)
            // consumes these uniformly.
            //
            // The synthesized property is attached to the class that actually
            // declares the backing field (this class or a base). Emitting it on
            // the declaring type keeps it a same-type auto-property — the field
            // planner only reserves a backing-field row when the auto-property's
            // backing field is NOT one of the type's own fields, so a
            // cross-type backing reference would corrupt the FieldDef range.
            // The accessor is virtual (NewSlot), so a derived class that lists
            // the interface satisfies the slot through inheritance.
            if positionalInterfaceProps.Count > 0 {
                for entry in positionalInterfaceProps.Values {
                    let param = entry.Param
                    if !structSymbol.TryGetFieldIncludingInherited(
                        param.Name,
                        out var backingField,
                        out var declaringType
                    ) {
                        continue
                    }
                    // Skip if the declaring type already exposes a property of
                    // this name (a real one that already satisfies the slot, or
                    // one synthesized by an earlier derived-class check).
                    if TypeMemberModel.TryGetProperty(declaringType!!, param.Name, out _) {
                        continue
                    }
                    let synthProp = PropertySymbol(
                        name: param.Name,
                        type: param.Type,
                        accessibility: Accessibility.Public,
                        hasGetter: true,
                        hasSetter: entry.NeedsSetter,
                        isAutoProperty: true,
                        isVirtual: true,
                        isOverride: false
                    ){BackingField = backingField}
                    declaringType!!.SetProperties(declaringType!!.Properties.Add(synthProp))
                }
            }
        }

        /// ADR-0089: shallow signature comparison for a static-virtual interface
        /// slot vs. a candidate implementer method. Static methods have no
        /// implicit `this`, so all parameters are direct and compared by
        /// type identity and ref-kind.
        private func StaticVirtualSignaturesMatch(iface FunctionSymbol, impl FunctionSymbol) bool {
            // ADR-0186: exact identity, or conformance — which reads through a
            // platform position at any depth (`List[Item!]?` against
            // `List[Item]?`) and is otherwise the ordinary signature comparison.
            let StaticVirtualTypesMatch = func (a TypeSymbol, b TypeSymbol) bool {
                return EqualityComparer[TypeSymbol].Default.Equals(a, b) || ConformanceSignaturesEquivalent(a, b)
            }
            if iface.Parameters.Length != impl.Parameters.Length {
                return false
            }
            if !StaticVirtualTypesMatch(iface.Type, impl.Type) {
                return false
            }
            if iface.ReturnRefKind != impl.ReturnRefKind {
                return false
            }
            for var i = 0; i < iface.Parameters.Length; i++ {
                if !StaticVirtualTypesMatch(iface.Parameters[i].Type, impl.Parameters[i].Type) {
                    return false
                }
                if iface.Parameters[i].RefKind != impl.Parameters[i].RefKind {
                    return false
                }
            }
            return true
        }

        /// ADR-0085 helper: returns `true` when the supplied interface
        /// carries at least one default-bearing method other than
        /// [`excluded`](paramref). Used to decide whether GS0320 ("no
        /// default available") fires instead of GS0187 (general "not
        /// implemented"). When the interface is purely abstract, GS0187 stays
        /// the right channel because DIM isn't part of the conversation.
        private func InterfaceHasAnyDefaultsExcept(iface InterfaceSymbol, excluded FunctionSymbol) bool {
            for m in iface.Methods {
                if object.ReferenceEquals(m, excluded) {
                    continue
                }
                if InterfaceSymbol.HasDefaultBody(m) {
                    return true
                }
            }
            return false
        }

        /// Issue #2293: returns `true` when the supplied interface property
        /// is fully satisfied by the interface's own default (arrow/block-bodied)
        /// accessor implementations — i.e. every accessor the property actually
        /// requires (getter when (cref:PropertySymbol.HasGetter), setter
        /// when (cref:PropertySymbol.HasSetter)) is a non-abstract default
        /// slot with a real body. This mirrors (cref:InterfaceSymbol.HasDefaultBody(FunctionSymbol))
        /// for default-interface *methods*: a class that omits the property
        /// entirely still satisfies the contract by inheriting the interface's
        /// default accessor bodies. An accessor without a default body (a
        /// body-less/abstract slot) still requires the implementer to provide it,
        /// so this returns `false` in that case even if the other accessor
        /// has a default.
        /// @param property The interface property to inspect.
        /// @returns True when every required accessor has a default body.
        private func PropertyHasDefaultBody(property PropertySymbol) bool {
            if property.HasGetter && (property.GetterSymbol == nil || property.GetterSymbol!!.IsAbstract) {
                return false
            }
            if property.HasSetter && (property.SetterSymbol == nil || property.SetterSymbol!!.IsAbstract) {
                return false
            }
            return true
        }

        /// Finds the source method selected for an imported interface slot.
        /// @param structSymbol The implementing type.
        /// @param slot The imported interface slot, including its constructed owner.
        /// @returns The explicit or implicit implementation, if present.
        internal func FindClrInterfaceMethodImplementation(
            structSymbol StructSymbol,
            slot MemberLookup.ClrInterfaceSlot
        ) FunctionSymbol? -> FindClrInterfaceImplementation(
            structSymbol,
            (type StructSymbol) -> type.Methods,
            (method FunctionSymbol) -> ExplicitClrSlotMatches(
                method.ExplicitInterfaceSlotContainingType,
                slot.SlotOwner,
                method.ExplicitInterfaceSlot,
                slot.Method
            ) &&
                MemberLookup.MethodSatisfiesClrSlot(method, slot),
            () -> FindMatchingClrSlotImplementation(structSymbol, slot)
        )

        private func FindMatchingClrSlotImplementation(
            structSymbol StructSymbol,
            slot MemberLookup.ClrInterfaceSlot
        ) FunctionSymbol? {
            // Note: do NOT route through GetMethodsIncludingInherited here — it
            // dedups same-name overloads by parameter signature (ignoring return
            // type), which would hide the non-generic covariant bridge method that
            // shares the generic method's name and (empty) parameter list. Walk the
            // class and its base chain directly so both overloads are visible.
            for c in structSymbol.GetHierarchy() {
                if c.Methods.IsDefaultOrEmpty {
                    continue
                }
                for candidate in c.Methods {
                    if MemberLookup.IsImplicitInterfaceImplementationCandidate(candidate) &&
                        candidate.Name == slot
                        .Method
                        .Name &&
                        MemberLookup.MethodSatisfiesClrSlot(candidate, slot) {
                        return candidate
                    }
                }
            }
            return nil
        }

        /// Issue #4593: decides whether a CLR interface slot owner is already
        /// implemented by the nearest imported base class. Re-listing such an
        /// interface (C# interface re-implementation) needs no new member: the CLR
        /// falls back to the base's interface mapping for every slot the derived
        /// type does not re-map. Erased symbolic generics (an interface or base
        /// closed over a G# type) cannot be compared through their CLR shape, so
        /// they answer `false` and keep the full member check.
        /// @param structSymbol The implementing source type.
        /// @param slotOwner The CLR interface that owns the slot.
        /// @returns `true` when the imported base implements it.
        private func ImportedBaseImplementsClrInterface(structSymbol StructSymbol, slotOwner TypeSymbol) bool {
            if slotOwner.ClrType is not{IsInterface: true} slotInterface || MemberLookup.IsSymbolicTypeArgument(
                slotOwner
            ) ||
                !(TypeMemberModel.GetNearestImportedBase(structSymbol) is {ClrType: {} importedBaseClr} importedBase) ||
                MemberLookup.IsSymbolicTypeArgument(importedBase) {
                return false
            }
            return ClrTypeUtilities.ImplementsInterfaceByName(importedBaseClr, slotInterface)
        }

        private func VerifyClrInterfaceMember[TMember class](
            isRequired bool,
            findImplementation() -> TMember?,
            validateImplementation(TMember) -> void,
            reportMissing() -> void
        ) {
            let implementation TMember? = findImplementation()
            if implementation != nil {
                validateImplementation(implementation)
            } else if isRequired {
                reportMissing()
            }
        }

        private func FindClrInterfaceMethodImplementation(
            structSymbol StructSymbol,
            interfaceType TypeSymbol,
            explicitSlot MethodInfo?,
            findImplicit() -> FunctionSymbol?
        ) FunctionSymbol? -> FindClrInterfaceImplementation(
            structSymbol,
            (type StructSymbol) -> type.Methods,
            (method FunctionSymbol) -> ExplicitClrSlotMatches(
                method.ExplicitInterfaceSlotContainingType,
                interfaceType,
                method.ExplicitInterfaceSlot,
                explicitSlot
            ),
            findImplicit
        )

        private func ExplicitClrPropertySlotMatches(
            property PropertySymbol,
            slotOwner TypeSymbol,
            slotGetter MethodInfo?,
            slotSetter MethodInfo?
        ) bool -> ExplicitClrSlotMatches(
            property.ExplicitInterfaceSlotContainingType,
            slotOwner,
            property.ExplicitInterfaceGetterSlot,
            slotGetter
        ) ||
            ExplicitClrSlotMatches(
            property.ExplicitInterfaceSlotContainingType,
            slotOwner,
            property.ExplicitInterfaceSetterSlot,
            slotSetter
        )

        private func ExplicitClrSlotMatches(
            implementationOwner TypeSymbol?,
            slotOwner TypeSymbol,
            implementationSlot MethodInfo?,
            slot MethodInfo?
        ) bool -> implementationOwner != nil &&
            ExactInterfaceTypeMatches(implementationOwner, slotOwner) &&
            SameClrSlot(implementationSlot, slot)

        private func ExactInterfaceTypeMatches(
            implementationOwner TypeSymbol,
            slotOwner TypeSymbol
        ) bool -> TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(implementationOwner, slotOwner)

        private func FindClrInterfaceImplementation[TMember class](
            structSymbol StructSymbol,
            getMembers(StructSymbol) -> ImmutableArray[TMember],
            implementsExplicitSlot(TMember) -> bool,
            findImplicit() -> TMember?
        ) TMember? {
            for member in GetMembersIncludingInherited(structSymbol, getMembers) {
                if implementsExplicitSlot(member) {
                    return member
                }
            }
            return findImplicit()
        }

        private func GetMembersIncludingInherited[TMember](
            structSymbol StructSymbol,
            getMembers(StructSymbol) -> ImmutableArray[TMember]
        ) sequence[TMember] {
            for type in structSymbol.GetHierarchy() {
                for member in getMembers(type) {
                    yield member
                }
            }
        }

        private func FindClrInterfacePropertyImplementationOrField(
            structSymbol StructSymbol,
            interfaceType TypeSymbol,
            clrProperty PropertyInfo,
            explicitGetter MethodInfo?,
            explicitSetter MethodInfo?,
            symbolicArgs ImmutableArray[TypeSymbol],
            requiresSetter bool,
            isRequired bool
        ) PropertySymbol? {
            let implementation PropertySymbol? = FindClrInterfacePropertyImplementation(
                structSymbol,
                interfaceType,
                clrProperty,
                explicitGetter,
                explicitSetter,
                symbolicArgs
            )
            if implementation != nil || !isRequired {
                return implementation
            }
            let matchingField FieldSymbol? = MemberLookup.FindMatchingFieldForPropertyContract(
                structSymbol,
                clrProperty
            )
            if matchingField == nil {
                return nil
            }
            let contractIsInitOnly = requiresSetter && ImportedTypeSymbol.IsInitOnlySetter(
                Invariant.Required(
                    clrProperty.SetMethod,
                    "a property requiring a setter exposes its setter",
                    expression: "clrProperty.SetMethod"
                )
            )
            let synthesized = PropertySymbol(
                name: clrProperty.Name,
                type: matchingField.Type,
                accessibility: Accessibility.Public,
                hasGetter: true,
                hasSetter: requiresSetter,
                isAutoProperty: true,
                isVirtual: true,
                isOverride: false,
                isInitOnly: contractIsInitOnly
            )
            synthesized.BackingField = matchingField
            structSymbol.SetProperties(structSymbol.Properties.Add(synthesized))
            return synthesized
        }

        /// Finds an existing source property selected for an imported interface slot.
        /// @param structSymbol The implementing type.
        /// @param interfaceType The imported interface containing the slot.
        /// @param clrProperty The CLR property contract.
        /// @param explicitGetter The getter slot for explicit implementation lookup.
        /// @param explicitSetter The setter slot for explicit implementation lookup.
        /// @param symbolicArgs The symbolic interface type arguments, if present.
        /// @returns The explicit or implicit implementation, without synthesizing a field adapter.
        internal func FindClrInterfacePropertyImplementation(
            structSymbol StructSymbol,
            interfaceType TypeSymbol,
            clrProperty PropertyInfo,
            explicitGetter MethodInfo?,
            explicitSetter MethodInfo?,
            symbolicArgs ImmutableArray[TypeSymbol]
        ) PropertySymbol? {
            var implementation PropertySymbol? = nil
            for property in GetMembersIncludingInherited(structSymbol, (type StructSymbol) -> type.Properties) {
                if ExplicitClrPropertySlotMatches(property, interfaceType, explicitGetter, explicitSetter) {
                    implementation = property
                    break
                }
            }
            if implementation == nil {
                for property in GetMembersIncludingInherited(structSymbol, (type StructSymbol) -> type.Properties) {
                    if MemberLookup.IsImplicitInterfaceImplementationCandidate(property) &&
                        (
                        if symbolicArgs.IsDefaultOrEmpty {
                            MemberLookup.PropertyMatchesClrInterfaceSignature(property, interfaceType, clrProperty)
                        } else {
                            MemberLookup.PropertyMatchesSymbolicClrInterfaceSignature(
                                property,
                                clrProperty,
                                symbolicArgs
                            )
                        }
                    ) {
                        implementation = property
                        break
                    }
                }
            }
            return implementation
        }

        private func SameClrSlot(first MethodInfo?, second MethodInfo?) bool -> first != nil &&
            second != nil &&
            first.MetadataToken == second.MetadataToken &&
            first.Module == second.Module

        private func FormatClrMethodSignature(method MethodInfo) string {
            let ps = method.GetParameters()
            if ps.Length == 0 {
                return method.Name
            }
            let names = [ps.Length]string
            for var i = 0; i < ps.Length; i++ {
                names[i] = SymbolDisplay.ToTypeDisplayString(ps[i].ParameterType)
            }
            return "${method.Name}(${string.Join(", ", names)})"
        }

        /// Issue #948: scans an instance field initializer expression for a
        /// reference to `this`, another instance member, or a constructor
        /// parameter. Such references are illegal because instance field
        /// initializers run before the constructor body (matching C#).
        /// @param node The initializer expression syntax to scan.
        /// @param forbiddenNames Instance member and constructor parameter names.
        /// @param offendingName The first offending name found.
        /// @param offendingLocation The location of the first offending reference.
        /// @returns True when an illegal reference was found.
        private func TryFindInstanceMemberReference(
            node SyntaxNode,
            forbiddenNames HashSet[string],
            out offendingName string?,
            out offendingLocation TextLocation
        ) bool -> TryFindInstanceMemberReference(
            node,
            forbiddenNames,
            HashSet[string](StringComparer.Ordinal),
            out offendingName,
            out offendingLocation
        )

        /// Issue #1641: scoped/shadow-aware variant of the scan above. A name that
        /// resolves to a locally-introduced binding (lambda/function-literal
        /// parameter, local `let`/`var`, deconstruction binding, pattern
        /// capture, catch/for-loop variable, ...) shadows the instance member of
        /// the same name and must not be flagged. [`shadowedNames`](paramref)
        /// carries the names bound by enclosing scopes down into this call.
        /// Pattern captures come from `switch`/`match` arm patterns and,
        /// since ADR-0166, from boolean `is` designations
        /// ((cref:TypePatternSyntax), (cref:PropertyPatternSyntax),
        /// (cref:VarPatternSyntax), (cref:SlicePatternSyntax)). The generic child walk scopes both
        /// conservatively: a capture is added to the shadow set only while
        /// iterating the owning (cref:SwitchCaseSyntax)/
        /// (cref:SwitchExpressionArmSyntax)/(cref:IfStatementSyntax)'s
        /// own later children (guard + body, or the branches), never leaking to
        /// sibling arms or the enclosing scope.
        private func TryFindInstanceMemberReference(
            node SyntaxNode,
            forbiddenNames HashSet[string],
            shadowedNames HashSet[string],
            out offendingName string?,
            out offendingLocation TextLocation
        ) bool {
            switch node {
                case nameExpr is NameExpressionSyntax {
                    if forbiddenNames.Contains(nameExpr.IdentifierToken.ValueText) && !shadowedNames.Contains(
                        nameExpr.IdentifierToken.ValueText
                    ) {
                        offendingName = nameExpr.IdentifierToken.ValueText
                        offendingLocation = nameExpr.IdentifierToken.Location
                        return true
                    }
                }
                case lambda is LambdaExpressionSyntax {
                    // ADR-0185: an arrow-lambda parameter may be destructured
                    // (`(x string, y int) -> ...`) — every destructured element
                    // name shadows within the body exactly like an ordinary
                    // parameter name, so flatten each pattern's elements in
                    // instead of the (absent) outer Identifier.
                    let lambdaParameterNames = List[string](lambda.Parameters.Count)
                    for lambdaParam in lambda.Parameters {
                        if lambdaParam.DeconstructionPattern is {} pattern {
                            for element in pattern.Elements {
                                lambdaParameterNames.Add(element.Identifier!!.ValueText)
                            }
                        } else {
                            lambdaParameterNames.Add(lambdaParam.Identifier!!.ValueText)
                        }
                    }
                    return TryFindInstanceMemberReference(
                        lambda.Body,
                        forbiddenNames,
                        WithShadowed(shadowedNames, lambdaParameterNames),
                        out offendingName,
                        out offendingLocation
                    )
                }
                case func_ is FunctionLiteralExpressionSyntax {
                    let functionParameterNames = [func_.Parameters.Count]string
                    for var i = 0; i < func_.Parameters.Count; i++ {
                        // ADR-0185: a function-literal's parameters are parsed via
                        // Parser.Members.cs's ParseParameter (never the
                        // destructured arrow-lambda path — see ADR-0185 Decision
                        // point 2), so Identifier is always set.
                        functionParameterNames[i] = func_.Parameters[i].Identifier!!.ValueText
                    }
                    return TryFindInstanceMemberReference(
                        func_.Body,
                        forbiddenNames,
                        WithShadowed(shadowedNames, functionParameterNames),
                        out offendingName,
                        out offendingLocation
                    )
                }
                case catchClause is CatchClauseSyntax when catchClause.Identifier != nil {
                    return TryFindInstanceMemberReference(
                        catchClause.Body,
                        forbiddenNames,
                        WithShadowed(shadowedNames, []string{catchClause.Identifier!!.ValueText}),
                        out offendingName,
                        out offendingLocation
                    )
                }
                case forRange is ForRangeStatementSyntax {
                    if TryFindInstanceMemberReference(
                        forRange.Collection,
                        forbiddenNames,
                        shadowedNames,
                        out offendingName,
                        out offendingLocation
                    ) {
                        return true
                    }
                    let forRangeNames = if forRange.SecondIdentifier != nil {
                        []string{forRange.FirstIdentifier.ValueText, forRange.SecondIdentifier.ValueText}
                    } else {
                        []string{forRange.FirstIdentifier.ValueText}
                    }
                    return TryFindInstanceMemberReference(
                        forRange.Body,
                        forbiddenNames,
                        WithShadowed(shadowedNames, forRangeNames),
                        out offendingName,
                        out offendingLocation
                    )
                }
                case forTupleRange is ForTupleRangeStatementSyntax {
                    if TryFindInstanceMemberReference(
                        forTupleRange.Collection,
                        forbiddenNames,
                        shadowedNames,
                        out offendingName,
                        out offendingLocation
                    ) {
                        return true
                    }
                    let forTupleRangeNames = [forTupleRange.Identifiers.Count]string
                    for var i = 0; i < forTupleRange.Identifiers.Count; i++ {
                        forTupleRangeNames[i] = forTupleRange.Identifiers[i].Text
                    }
                    return TryFindInstanceMemberReference(
                        forTupleRange.Body,
                        forbiddenNames,
                        WithShadowed(shadowedNames, forTupleRangeNames),
                        out offendingName,
                        out offendingLocation
                    )
                }
                case forEllipsis is ForEllipsisStatementSyntax {
                    if TryFindInstanceMemberReference(
                        forEllipsis.LowerBound,
                        forbiddenNames,
                        shadowedNames,
                        out offendingName,
                        out offendingLocation
                    ) ||
                        TryFindInstanceMemberReference(
                        forEllipsis.UpperBound,
                        forbiddenNames,
                        shadowedNames,
                        out offendingName,
                        out offendingLocation
                    ) {
                        return true
                    }
                    return TryFindInstanceMemberReference(
                        forEllipsis.Body,
                        forbiddenNames,
                        WithShadowed(shadowedNames, []string{forEllipsis.Identifier.ValueText}),
                        out offendingName,
                        out offendingLocation
                    )
                }
                case awaitForRange is AwaitForRangeStatementSyntax {
                    if TryFindInstanceMemberReference(
                        awaitForRange.Stream,
                        forbiddenNames,
                        shadowedNames,
                        out offendingName,
                        out offendingLocation
                    ) {
                        return true
                    }
                    return TryFindInstanceMemberReference(
                        awaitForRange.Body,
                        forbiddenNames,
                        WithShadowed(shadowedNames, []string{awaitForRange.Identifier.ValueText}),
                        out offendingName,
                        out offendingLocation
                    )
                }
                case ifLet is IfLetStatementSyntax {
                    let ifLetNames = List[string]()
                    for binding in ifLet.Bindings {
                        if TryFindInstanceMemberReference(
                            binding.Initializer,
                            forbiddenNames,
                            shadowedNames,
                            out offendingName,
                            out offendingLocation
                        ) {
                            return true
                        }
                        ifLetNames.Add(binding.Identifier.ValueText)
                    }
                    let ifLetShadowed = WithShadowed(shadowedNames, ifLetNames)
                    if TryFindInstanceMemberReference(
                        ifLet.ThenStatement,
                        forbiddenNames,
                        ifLetShadowed,
                        out offendingName,
                        out offendingLocation
                    ) {
                        return true
                    }
                    return ifLet.ElseClause != nil &&
                        TryFindInstanceMemberReference(
                        ifLet.ElseClause,
                        forbiddenNames,
                        shadowedNames,
                        out offendingName,
                        out offendingLocation
                    )
                }
                case whileLet is WhileLetStatementSyntax {
                    let whileLetNames = List[string]()
                    for binding in whileLet.Bindings {
                        if TryFindInstanceMemberReference(
                            binding.Initializer,
                            forbiddenNames,
                            shadowedNames,
                            out offendingName,
                            out offendingLocation
                        ) {
                            return true
                        }
                        whileLetNames.Add(binding.Identifier.ValueText)
                    }
                    return TryFindInstanceMemberReference(
                        whileLet.Body,
                        forbiddenNames,
                        WithShadowed(shadowedNames, whileLetNames),
                        out offendingName,
                        out offendingLocation
                    )
                }
            }
            // Generic default: sequentially walk this node's children, growing a
            // local shadow set as declaration-introducing children are seen so
            // later siblings (e.g. a subsequent statement in the same block) see
            // names bound by an earlier `let`/`var`, deconstruction, `guard let`,
            // or pattern capture — matching how those bindings extend the
            // enclosing scope.
            var local = shadowedNames
            var cloned = false
            for child in node.GetChildren() {
                if TryFindInstanceMemberReference(
                    child,
                    forbiddenNames,
                    local,
                    out offendingName,
                    out offendingLocation
                ) {
                    return true
                }
                let declared IEnumerable[string]? = GetSequentiallyDeclaredNames(child)
                if declared != nil {
                    if !cloned {
                        local = HashSet[string](local, StringComparer.Ordinal)
                        cloned = true
                    }
                    for name in declared {
                        local.Add(name)
                    }
                }
            }
            offendingName = nil
            offendingLocation = default(TextLocation)
            return false
        }

        /// Returns a copy of [`shadowedNames`](paramref) with [`newNames`](paramref) added.
        private func WithShadowed(shadowedNames HashSet[string], newNames IEnumerable[string]) HashSet[string] {
            let result = HashSet[string](shadowedNames, StringComparer.Ordinal)
            for name in newNames {
                result.Add(name)
            }
            return result
        }

        /// Names bound by [`node`](paramref) that remain visible to its
        /// following siblings within the enclosing node's child list — plain
        /// local declarations (`let`/`var`, tuple/named deconstruction,
        /// `guard let`) and pattern captures (e.g. `x is Foo y` or a
        /// `match` arm pattern), which this scan conservatively treats as
        /// shadowing for the rest of the initializer rather than modelling
        /// precise flow-sensitive scoping. Returns `null` when the node
        /// introduces no such bindings.
        private func GetSequentiallyDeclaredNames(node SyntaxNode) IEnumerable[string]? {
            switch node {
                case variableDeclaration is VariableDeclarationSyntax {
                    return []string{variableDeclaration.Identifier.ValueText}
                }
                case tupleDeconstruction is TupleDeconstructionStatementSyntax {
                    let tupleNames = [tupleDeconstruction.Identifiers.Count]string
                    for var i = 0; i < tupleDeconstruction.Identifiers.Count; i++ {
                        tupleNames[i] = tupleDeconstruction.Identifiers[i].Text
                    }
                    return tupleNames
                }
                case namedDeconstruction is NamedDeconstructionStatementSyntax {
                    let fieldNames = [namedDeconstruction.Fields.Count]string
                    for var i = 0; i < namedDeconstruction.Fields.Count; i++ {
                        fieldNames[i] = namedDeconstruction.Fields[i].LocalIdentifier.ValueText
                    }
                    return fieldNames
                }
                case guardLet is GuardLetStatementSyntax {
                    let names = [guardLet.Bindings.Count]string
                    for var i = 0; i < guardLet.Bindings.Count; i++ {
                        names[i] = guardLet.Bindings[i].Identifier.ValueText
                    }
                    return names
                }
                case pattern is PatternSyntax {
                    let captures = List[string]()
                    CollectPatternCaptureNames(pattern, captures)
                    return if captures.Count > 0 {
                        captures
                    } else {
                        default(List[string]?)
                    }
                }
                default {
                    return nil
                }
            }
        }

        /// Recursively collects capture names (e.g. `y` in the type pattern `Foo y`, or `rest` in a slice
        /// pattern) from a pattern subtree.
        private func CollectPatternCaptureNames(node SyntaxNode, captures List[string]) {
            switch node {
                case typePattern is TypePatternSyntax when typePattern.BindingIdentifier != nil {
                    captures.Add(typePattern.BindingIdentifier!!.ValueText)
                }
                case propertyPattern is PropertyPatternSyntax when propertyPattern.Designation != nil {
                    captures.Add(propertyPattern.Designation!!.Text)
                }
                case varPattern is VarPatternSyntax when varPattern.Designation.Text != "_" {
                    captures.Add(varPattern.Designation.Text)
                }
                case slicePattern is SlicePatternSyntax when slicePattern.CaptureIdentifier != nil {
                    captures.Add(slicePattern.CaptureIdentifier!!.ValueText)
                }
            }
            for child in node.GetChildren() {
                CollectPatternCaptureNames(child, captures)
            }
        }

        private func GetBaseClauseTypeDisplayName(typeClause TypeClauseSyntax?) string {
            if typeClause == nil {
                return string.Empty
            }
            let dotted = typeClause.DottedName
            if !typeClause.HasTypeArguments {
                return dotted
            }
            let typeArguments = Invariant.Required(
                typeClause.TypeArguments,
                "a type clause with type arguments has an argument list",
                expression: "typeClause.TypeArguments"
            )
            let args = [typeArguments.Count]string
            for var i = 0; i < typeArguments.Count; i++ {
                args[i] = GetBaseClauseTypeDisplayName(typeArguments[i])
            }
            return "$dotted[${string.Join(", ", args)}]"
        }
    }
}
