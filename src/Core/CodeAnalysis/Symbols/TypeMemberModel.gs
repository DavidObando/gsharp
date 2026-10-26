// <copyright file="TypeMemberModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq

/// ADR-0112: the single canonical member-resolution layer for user-defined G#
/// types ((cref:StructSymbol) for class + struct,
/// (cref:InterfaceSymbol), and (cref:EnumSymbol)).
///
/// This type is deliberately pure — it has no `BinderContext` dependency and
/// returns only existing (cref:Symbol) instances (FunctionSymbol /
/// FieldSymbol / PropertySymbol / EventSymbol / EnumMemberSymbol) — so both the
/// binder and the language server can consume it without behavioral drift, and
/// emit / overload resolution / conversion are unaffected by the layer itself.
///
/// CLR / imported member reflection is intentionally out of scope and remains
/// behind `MemberLookup`; this layer covers user-symbol member tables only.
shared class TypeMemberModel {
    // Storage reads retain the canonical property association through exact
    // backing-field identity in the effective owner, never synthesized names.
    internal func PropertyForBackingField(type StructSymbol?, field FieldSymbol) PropertySymbol? {
        if type == nil || field.IsStatic || field.IsEventBackingField {
            return nil
        }
        var selected PropertySymbol? = nil
        for owner in GetHierarchy(type) {
            for property in owner.Properties {
                if !property.IsAutoProperty || property.IsStatic || property.IsIndexer || !object.ReferenceEquals(
                    property.BackingField,
                    field
                ) {
                    continue
                }
                if selected != nil && !object.ReferenceEquals(selected, property) {
                    return nil
                }
                selected = property
            }
        }
        return selected
    }

    /// Returns the ordered members used by synthesized and bound data-type
    /// deconstruction. Primary-constructor parameters are positional. Native
    /// body-form data types deconstruct their fields and then their auto
    /// properties (ADR-0199 keeps this for every data type, however declared).
    /// @param type The data class or data struct.
    /// @returns The logical deconstruction members in declaration order.
    func GetDataDeconstructionMembers(type StructSymbol?) ImmutableArray[Symbol] {
        if type == nil || !type.IsData {
            return ImmutableArray[Symbol].Empty
        }
        let members = ImmutableArray.CreateBuilder[Symbol]()
        if type.HasPrimaryConstructor || type.Declaration?.HasPrimaryConstructor == true {
            for parameter in type.PrimaryConstructorParameters {
                for property in type.Properties {
                    if property.Name == parameter.Name &&
                        property.HasGetter &&
                        !property.IsStatic &&
                        !property.IsIndexer {
                        members.Add(property)
                        break
                    }
                }
            }
            return members.ToImmutable()
        }
        for field in type.Fields {
            members.Add(field)
        }
        for property in type.Properties {
            if !property.IsStatic && !property.IsIndexer && property.BackingField != nil {
                members.Add(property)
            }
        }
        return members.ToImmutable()
    }

    /// Looks up the first member named [`name`](paramref) on
    /// [`type`](paramref) honoring [`query`](paramref). The search
    /// order — property → field → event → method, instance entries before static
    /// entries, walking the base chain this-first — matches the historic
    /// language-server enumeration so hover/definition/lookup stay byte-for-byte
    /// equivalent under (cref:MemberQuery.All).
    /// @param type The type to resolve against (user-defined types only).
    /// @param name The member name.
    /// @param query The static/instance/inherited/kind filter.
    /// @returns The first matching member, or `null` when none matches.
    func LookupMember(type TypeSymbol, name string, query MemberQuery) Symbol? {
        if type is StructSymbol structSymbol {
            return LookupStructMember(structSymbol, name, query)
        }
        if type is InterfaceSymbol interfaceSymbol {
            return LookupInterfaceMember(interfaceSymbol, name, query)
        }
        if type is EnumSymbol enumSymbol {
            if query.IncludeStatic && (query.Kinds & MemberKinds.Field) != 0 && enumSymbol.TryGetMember(
                name,
                out var enumMember
            ) {
                return enumMember!!
            }
            return nil
        }
        return nil
    }

    /// Returns every method named [`name`](paramref) visible on
    /// [`type`](paramref) for the given query (the overload set), walking
    /// inheritance this-first with signature-based dedup so each visible
    /// signature appears once. Instance methods are surfaced when
    /// (cref:MemberQuery.IncludeInstance) is set; static methods when
    /// (cref:MemberQuery.IncludeStatic) is set.
    /// @param type The type to resolve against.
    /// @param name The method name.
    /// @param query The static/instance/inherited filter.
    /// @returns The merged overload set; empty when none found.
    func GetMethods(type TypeSymbol, name string, query MemberQuery) ImmutableArray[FunctionSymbol] {
        if (query.Kinds & MemberKinds.Method) == 0 {
            return ImmutableArray[FunctionSymbol].Empty
        }
        if type is StructSymbol structSymbol {
            var builder ImmutableArray[FunctionSymbol].Builder? = nil
            for c in GetHierarchy(structSymbol) {
                if query.IncludeInstance {
                    AddMethodsDeduped(&builder, c.GetMethods(name), name)
                }
                if query.IncludeStatic {
                    AddMethodsDeduped(
                        &builder,
                        c.StaticMethods,
                        name,
                        skipPrivate: !object.ReferenceEquals(c, structSymbol)
                    )
                }
                if !query.IncludeInherited {
                    break
                }
            }
            return builder?.ToImmutable() ?? ImmutableArray[FunctionSymbol].Empty
        }
        if type is InterfaceSymbol interfaceSymbol {
            interfaceSymbol.EnsureMembersResolved()
            var builder ImmutableArray[FunctionSymbol].Builder? = nil
            // Issue #1006: walk this interface and its transitive base
            // interfaces so an `interface B : A` surfaces A's methods. When
            // inherited lookup is disabled, only the interface's own methods
            // are considered.
            for iface in if query.IncludeInherited {
                interfaceSymbol.SelfAndAllBaseInterfaces()
            } else {
                cast[IEnumerable[InterfaceSymbol]]([]InterfaceSymbol{interfaceSymbol})
            } {
                iface.EnsureMembersResolved()
                if query.IncludeInstance {
                    AddMethodsDeduped(&builder, iface.Methods, name)
                }
                if query.IncludeStatic {
                    AddMethodsDeduped(&builder, iface.StaticMethods, name)
                }
            }
            return builder?.ToImmutable() ?? ImmutableArray[FunctionSymbol].Empty
        }
        return ImmutableArray[FunctionSymbol].Empty
    }

    /// Enumerates every member matching [`query`](paramref) on [`type`](paramref) (for completion). Order
    /// is this-first, kind by kind, instance entries before static entries.
    /// @param type The type to enumerate.
    /// @param query The static/instance/inherited/kind filter.
    /// @returns The matching members.
    func EnumerateMembers(type TypeSymbol, query MemberQuery) IEnumerable[Symbol] {
        if type is StructSymbol structSymbol {
            return EnumerateStructMembers(structSymbol, query)
        }
        if type is InterfaceSymbol interfaceSymbol {
            return EnumerateInterfaceMembers(interfaceSymbol, query)
        }
        if type is EnumSymbol enumSymbol {
            return EnumerateEnumMembers(enumSymbol, query)
        }
        return Enumerable.Empty[Symbol]()
    }

    /// Tries to find an instance field named [`name`](paramref) on [`type`](paramref), walking the base
    /// chain.
    /// @param type The type to resolve against.
    /// @param name The field name.
    /// @param field The found field on success.
    /// @returns True if found.
    func TryGetField(type TypeSymbol, name string, @NotNullWhen(true) out field FieldSymbol?) bool {
        field = nil
        if type is StructSymbol structSymbol {
            for c in GetHierarchy(structSymbol) {
                if c.TryGetField(name, out var foundField) {
                    field = foundField
                    return true
                }
            }
        }
        return false
    }

    /// ADR-0112 P0: tries to find a field named [`name`](paramref) on
    /// [`type`](paramref) while also surfacing the (cref:StructSymbol)
    /// that actually declares it — the binder needs the declaring struct to build
    /// a `BoundFieldAccessExpression`. This mirrors
    /// (cref:StructSymbol.TryGetFieldIncludingInherited) for the
    /// declaring-type semantics but honors [`query`](paramref) (instance
    /// before static at each level, this-first base-chain walk, stopping when
    /// (cref:MemberQuery.IncludeInherited) is unset).
    /// @param type The type to resolve against (user-defined struct/class only).
    /// @param name The field name.
    /// @param query The static/instance/inherited filter.
    /// @param field The found field on success.
    /// @param declaringType The struct that actually declares the field on success.
    /// @returns True if found.
    func TryGetFieldIncludingInherited(
        type TypeSymbol,
        name string,
        query MemberQuery,
        @NotNullWhen(true) out field FieldSymbol?,
        @NotNullWhen(true) out declaringType StructSymbol?
    ) bool {
        field = nil
        declaringType = nil
        if (query.Kinds & MemberKinds.Field) != 0 && type is StructSymbol structSymbol {
            for c in GetHierarchy(structSymbol) {
                if query.IncludeInstance && c.TryGetField(name, out var foundInstanceField) {
                    field = foundInstanceField
                    declaringType = c
                    return true
                }
                if query.IncludeStatic && c.TryGetStaticField(name, out var foundStaticField) {
                    if !object.ReferenceEquals(c, structSymbol) &&
                        foundStaticField!!.Accessibility == Accessibility.Private {
                        break
                    }
                    field = foundStaticField
                    declaringType = c
                    return true
                }
                if !query.IncludeInherited {
                    break
                }
            }
        }
        return false
    }

    /// Tries to find a static field named [`name`](paramref) on [`type`](paramref).
    /// @param type The type to resolve against.
    /// @param name The field name.
    /// @param field The found field on success.
    /// @returns True if found.
    func TryGetStaticField(type TypeSymbol, name string, @NotNullWhen(true) out field FieldSymbol?) bool {
        if type is StructSymbol structSymbol && structSymbol.TryGetStaticField(name, out field) {
            return true
        }
        field = nil
        return false
    }

    /// Tries to find an inherited static field and its effective declaring type.
    /// @param type The source type used to qualify the field.
    /// @param name The field name.
    /// @param field The declared field.
    /// @param declaringType The effective declaring construction.
    /// @returns Whether a field was found.
    func TryGetStaticFieldIncludingInherited(
        type StructSymbol,
        name string,
        @NotNullWhen(true) out field FieldSymbol?,
        @NotNullWhen(true) out declaringType StructSymbol?
    ) bool {
        for c in GetHierarchy(type) {
            if c.TryGetStaticField(name, out field) {
                if !object.ReferenceEquals(c, type) && field!!.Accessibility == Accessibility.Private {
                    break
                }
                declaringType = ResolveStaticMemberOwner(type, c)
                return true
            }
            if DeclaresAnyStaticMember(c, name) {
                break
            }
        }
        field = nil
        declaringType = nil
        return false
    }

    /// Tries to find an instance property named [`name`](paramref) on [`type`](paramref), walking the base
    /// chain.
    /// @param type The type to resolve against.
    /// @param name The property name.
    /// @param property The found property on success.
    /// @returns True if found.
    func TryGetProperty(
        type TypeSymbol,
        name string,
        @NotNullWhen(true) out property PropertySymbol?
    ) bool -> TryGetProperty(type, name, out property, out _)

    /// Issue #950: like (cref:TryGetProperty(TypeSymbol, string, out PropertySymbol))
    /// but also surfaces the (cref:StructSymbol) that declares the
    /// property, so callers can enforce `protected` accessibility against
    /// the declaring type.
    /// @param type The type to resolve against.
    /// @param name The property name.
    /// @param property The found property on success.
    /// @param declaringType The struct/class that declares the property, or `null`.
    /// @returns True if found.
    func TryGetProperty(
        type TypeSymbol,
        name string,
        @NotNullWhen(true) out property PropertySymbol?,
        out declaringType StructSymbol?
    ) bool {
        let found = TryGetPropertyWithOwner(type, name, out property, out var owner)
        declaringType = owner as StructSymbol
        return found
    }

    /// Finds an instance property and returns its effective struct or interface
    /// owner. Constructed interface owners are preserved so callers can close
    /// member signature types before binding a load.
    /// @param type Type to resolve against.
    /// @param name Property name.
    /// @param property Found property.
    /// @param declaringType Effective declaring struct/class/interface.
    /// @returns Whether a property was found.
    func TryGetPropertyWithOwner(
        type TypeSymbol,
        name string,
        @NotNullWhen(true) out property PropertySymbol?,
        out declaringType TypeSymbol?
    ) bool {
        if type is StructSymbol structSymbol {
            for c in GetHierarchy(structSymbol) {
                for p in c.Properties {
                    // ADR-0118 / issue #944: an indexer ('Item') is not reachable
                    // by member name — only through `obj[i]` index access.
                    if p.IsIndexer {
                        continue
                    }
                    if p.Name == name {
                        property = p
                        declaringType = c
                        return true
                    }
                }
            }
        } else if type is InterfaceSymbol interfaceSymbol {
            // Issue #1006: walk base interfaces too.
            for iface in interfaceSymbol.SelfAndAllBaseInterfaces() {
                iface.EnsureMembersResolved()
                let propertyOwner = if iface.Definition != nil && !object.ReferenceEquals(iface.Definition, iface) {
                    iface.Definition
                } else {
                    iface
                }
                for p in propertyOwner.Properties {
                    if !p.IsStatic && !p.IsIndexer && p.Name == name {
                        property = p
                        declaringType = iface
                        return true
                    }
                }
            }
        }
        property = nil
        declaringType = nil
        return false
    }

    /// Finds the effective declaring construction of an already-bound property by member/accessor identity.
    /// @param type The receiver or declaring construction.
    /// @param boundProperty The selected property, not another member with the same name.
    /// @param property The property in the effective construction.
    /// @param declaringType The effective declaring construction.
    /// @returns Whether the bound property was found.
    func TryGetPropertyWithOwner(
        type TypeSymbol,
        boundProperty PropertySymbol,
        @NotNullWhen(true) out property PropertySymbol?,
        @NotNullWhen(true) out declaringType TypeSymbol?
    ) bool {
        var type = type
        var visited HashSet[TypeParameterSymbol]? = nil
        while type is TypeParameterSymbol parameter && parameter.ConstraintReferenceType is {} constraint {
            visited ??= HashSet[TypeParameterSymbol]()
            if !visited!!.Add(parameter) {
                break
            }
            type = constraint
        }
        let owners IEnumerable[TypeSymbol] = switch type {
            case aggregate is StructSymbol: cast[IEnumerable[TypeSymbol]](aggregate.GetHierarchy())
            case contract is InterfaceSymbol: cast[IEnumerable[TypeSymbol]](contract.SelfAndAllBaseInterfaces())
            default: ImmutableArray[TypeSymbol].Empty
        }
        for owner in owners {
            var candidates IEnumerable[PropertySymbol]
            if owner is StructSymbol aggregate {
                candidates = if boundProperty.IsStatic {
                    aggregate.StaticProperties
                } else {
                    aggregate.Properties
                }
            } else if owner is InterfaceSymbol contract {
                contract.EnsureMembersResolved()
                candidates = (contract.Definition ?? contract).Properties
            } else {
                continue
            }
            for candidate in candidates {
                if object.ReferenceEquals(candidate, boundProperty) ||
                    (
                    boundProperty.GetterSymbol != nil && object.ReferenceEquals(
                        candidate.GetterSymbol,
                        boundProperty.GetterSymbol
                    )
                ) ||
                    (
                    boundProperty.SetterSymbol != nil && object.ReferenceEquals(
                        candidate.SetterSymbol,
                        boundProperty.SetterSymbol
                    )
                ) {
                    property = candidate
                    declaringType = owner
                    return true
                }
            }
        }
        property = nil
        declaringType = nil
        return false
    }

    /// Issue #2150: tries to find a data-class positional (primary-constructor)
    /// parameter named [`name`](paramref) on [`type`](paramref) or any
    /// class in its base chain. Positional parameters are materialized as public
    /// instance fields (not (cref:StructSymbol.Properties)), yet — like a
    /// C# record's positional property — they satisfy a matching interface
    /// property contract. The base-chain walk is this-first, mirroring
    /// (cref:TryGetProperty(TypeSymbol, string, out PropertySymbol)) and
    /// issue #1066 semantics.
    /// @param type The type to resolve against.
    /// @param name The parameter name.
    /// @param parameter The found positional parameter on success.
    /// @returns True if found.
    func TryGetPrimaryConstructorParameter(
        type TypeSymbol,
        name string,
        @NotNullWhen(true) out parameter ParameterSymbol?
    ) bool {
        if type is StructSymbol structSymbol {
            for c in GetHierarchy(structSymbol) {
                if c.PrimaryConstructorParameters.IsDefaultOrEmpty {
                    continue
                }
                for p in c.PrimaryConstructorParameters {
                    if p.Name == name {
                        parameter = p
                        return true
                    }
                }
            }
        }
        parameter = nil
        return false
    }

    /// Tries to find a static property named [`name`](paramref) on [`type`](paramref).
    /// @param type The type to resolve against.
    /// @param name The property name.
    /// @param property The found property on success.
    /// @returns True if found.
    func TryGetStaticProperty(type TypeSymbol, name string, @NotNullWhen(true) out property PropertySymbol?) bool {
        if type is StructSymbol structSymbol {
            for p in structSymbol.StaticProperties {
                if p.Name == name {
                    property = p
                    return true
                }
            }
        }
        property = nil
        return false
    }

    /// Tries to find an inherited static property and its effective declaring type.
    /// @param type The source type used to qualify the property.
    /// @param name The property name.
    /// @param property The property in the effective owner context.
    /// @param declaringType The effective declaring construction.
    /// @returns Whether a property was found.
    func TryGetStaticPropertyIncludingInherited(
        type StructSymbol,
        name string,
        @NotNullWhen(true) out property PropertySymbol?,
        @NotNullWhen(true) out declaringType StructSymbol?
    ) bool {
        for c in GetHierarchy(type) {
            let effective = ResolveStaticMemberOwner(type, c)
            if TryGetStaticProperty(effective, name, out property) {
                if !object.ReferenceEquals(c, type) && property.Accessibility == Accessibility.Private {
                    break
                }
                declaringType = effective
                return true
            }
            if DeclaresAnyStaticMember(c, name) {
                break
            }
        }
        property = nil
        declaringType = nil
        return false
    }

    /// Tries to find an instance event named [`name`](paramref) on [`type`](paramref), walking the base
    /// chain.
    /// @param type The type to resolve against.
    /// @param name The event name.
    /// @param event The found event on success.
    /// @returns True if found.
    func TryGetEvent(type TypeSymbol, name string, @NotNullWhen(true) out event EventSymbol?) bool {
        if type is StructSymbol structSymbol {
            for c in GetHierarchy(structSymbol) {
                for e in c.Events {
                    if e.Name == name {
                        event = e
                        return true
                    }
                }
            }
        } else if type is InterfaceSymbol interfaceSymbol {
            // Issue #1006: walk base interfaces too.
            //
            // ADR-0149 follow-up (issue #2370): like Properties (see
            // InterfaceSymbol.TryResolveMembers's remarks — only
            // Methods/StaticMethods/PrivateMethods/StaticPrivateMethods are
            // substituted onto a CONSTRUCTED generic interface instance),
            // Events is never populated on a constructed instance either —
            // only the open Definition carries it. Resolve against
            // `iface.Definition ?? iface` (a no-op for a non-generic
            // interface) so a constructed generic interface receiver (e.g.
            // `IWatchable[int32]`) still finds its own event instead of
            // silently reporting "not found".
            for iface in interfaceSymbol.SelfAndAllBaseInterfaces() {
                let def = iface.Definition ?? iface
                def.EnsureMembersResolved()
                for e in def.Events {
                    if e.Name == name {
                        event = e
                        return true
                    }
                }
            }
        }
        event = nil
        return false
    }

    /// Tries to find an instance event named [`name`](paramref) on
    /// [`type`](paramref), walking the base chain, and reports the
    /// construction of the class that declares it as
    /// [`type`](paramref)'s hierarchy instantiates it
    /// (`GB[string]` for an event of `GB[T]` reached through
    /// `D : GB[string]`).
    /// @remarks Issue #4394: an accessibility check needs the declaring class, not the
    /// receiver's static type (a `private` event of a base is not
    /// accessible from the derived class). Issue #4391: the declaring
    /// construction also supplies the event's handler type with the class's
    /// type parameters replaced (`EventHandler[string]`, not
    /// `EventHandler[T]`).
    /// @param type The receiver's static type.
    /// @param name The event name.
    /// @param event The found event on success.
    /// @param declaringType The declaring class's construction on success.
    /// @returns True if found.
    func TryGetEvent(
        type StructSymbol,
        name string,
        @NotNullWhen(true) out event EventSymbol?,
        @NotNullWhen(true) out declaringType StructSymbol?
    ) bool {
        for c in GetHierarchy(type) {
            for e in c.Events {
                if e.Name == name {
                    event = e
                    declaringType = ResolveStaticMemberOwner(type, c)
                    return true
                }
            }
        }
        event = nil
        declaringType = nil
        return false
    }

    /// Tries to find a static event named [`name`](paramref) on [`type`](paramref).
    /// @param type The type to resolve against.
    /// @param name The event name.
    /// @param event The found event on success.
    /// @returns True if found.
    func TryGetStaticEvent(type TypeSymbol, name string, @NotNullWhen(true) out event EventSymbol?) bool {
        if type is StructSymbol structSymbol {
            for e in structSymbol.StaticEvents {
                if e.Name == name {
                    event = e
                    return true
                }
            }
        }
        event = nil
        return false
    }

    /// Tries to find an inherited static event and its effective declaring type.
    /// @param type The source type used to qualify the event.
    /// @param name The event name.
    /// @param event The declared event.
    /// @param declaringType The effective declaring construction.
    /// @returns Whether an event was found.
    func TryGetStaticEventIncludingInherited(
        type StructSymbol,
        name string,
        @NotNullWhen(true) out event EventSymbol?,
        @NotNullWhen(true) out declaringType StructSymbol?
    ) bool {
        for c in GetHierarchy(type) {
            let effective = ResolveStaticMemberOwner(type, c)
            if TryGetStaticEvent(effective, name, out event) {
                if !object.ReferenceEquals(c, type) && event.Accessibility == Accessibility.Private {
                    break
                }
                declaringType = effective
                return true
            }
            if DeclaresAnyStaticMember(c, name) {
                break
            }
        }
        event = nil
        declaringType = nil
        return false
    }

    /// Resolves the base-class construction that owns a static member found
    /// through [`lookupType`](paramref).
    /// @param lookupType The source type used to qualify the member.
    /// @param declaredOwner The member's declared owner.
    /// @returns The owner construction in the lookup type's base chain.
    func ResolveStaticMemberOwner(lookupType StructSymbol, declaredOwner StructSymbol) StructSymbol {
        let declaredDefinition = declaredOwner.Definition ?? declaredOwner
        if !declaredDefinition.TypeParameters.IsDefaultOrEmpty {
            return lookupType.FindConstructedGenericBase(
                (candidate StructSymbol) -> {
                    return object.ReferenceEquals(candidate, declaredDefinition)
                }
            ) ??
                declaredOwner
        }
        for c in GetHierarchy(lookupType) {
            if object.ReferenceEquals(c.Definition ?? c, declaredDefinition) {
                return c
            }
        }
        return declaredOwner
    }

    /// Finds the nearest imported CLR base under a source class chain.
    /// @param type The source class whose chain is searched.
    /// @returns The imported base, or null.
    func GetNearestImportedBase(type StructSymbol) TypeSymbol? {
        for c in GetHierarchy(type) {
            if c.ImportedBaseType?.ClrType != nil {
                return c.ImportedBaseType!!
            }
        }
        return nil
    }

    /// ADR-0112: tries to find the FIRST instance method named [`name`](paramref)
    /// on [`type`](paramref), walking the base chain this-first (declaration order
    /// within each level). Mirrors (cref:StructSymbol.TryGetMethodIncludingInherited):
    /// instance methods only, no overload set, no statics. Used by user-operator
    /// resolution and duck-typed protocol probes (iterator, dispose).
    /// @param type The type to resolve against (user-defined struct/class only).
    /// @param name The method name.
    /// @param method The found method on success.
    /// @returns True if found.
    func TryGetMethodIncludingInherited(
        type TypeSymbol,
        name string,
        @NotNullWhen(true) out method FunctionSymbol?
    ) bool {
        if type is StructSymbol structSymbol {
            for c in GetHierarchy(structSymbol) {
                if c.TryGetMethod(name, out method) {
                    return true
                }
            }
        }
        method = nil
        return false
    }

    /// Issue #2377: tries to find the FIRST static method named [`name`](paramref)
    /// on [`type`](paramref), walking the base chain this-first (declaration order
    /// within each level). Mirrors (cref:TryGetMethodIncludingInherited) but
    /// searches (cref:StructSymbol.StaticMethods) instead of the instance
    /// bucket — used by user-defined operator resolution (Stream D), since a
    /// receiver-clause operator (`func (a T) operator ...`) now binds as a static,
    /// SpecialName `op_*` method on its owning struct/class rather than as an
    /// instance method, and an operator declared on an `open` base must still
    /// be found through a derived operand type.
    /// @param type The type to resolve against (user-defined struct/class only).
    /// @param name The method name.
    /// @param method The found method on success.
    /// @returns True if found.
    func TryGetStaticMethodIncludingInherited(
        type TypeSymbol,
        name string,
        @NotNullWhen(true) out method FunctionSymbol?
    ) bool -> TryGetStaticMethodIncludingInherited(type, name, out method, out _)

    /// Tries to find the first static method named [`name`](paramref) and
    /// returns the constructed type level that supplied it.
    /// @param type The type to resolve against.
    /// @param name The method name.
    /// @param method The found method on success.
    /// @param declaringType The matching type level in the receiver's constructed base chain.
    /// @returns True if found.
    func TryGetStaticMethodIncludingInherited(
        type TypeSymbol,
        name string,
        @NotNullWhen(true) out method FunctionSymbol?,
        @NotNullWhen(true) out declaringType StructSymbol?
    ) bool {
        if type is StructSymbol structSymbol {
            for c in GetHierarchy(structSymbol) {
                if c.TryGetStaticMethod(name, out method) {
                    declaringType = c
                    return true
                }
            }
        }
        method = nil
        declaringType = nil
        return false
    }

    internal func DeclaresAnyStaticMember(type StructSymbol, name string) bool {
        if type.TryGetStaticField(name, out _) {
            return true
        }
        for property in type.StaticProperties {
            if property.Name == name {
                return true
            }
        }
        for event in type.StaticEvents {
            if event.Name == name {
                return true
            }
        }
        for method in type.StaticMethods {
            if method.Name == name {
                return true
            }
        }
        return false
    }

    // Issue #4164: this used to be its own unguarded copy of the
    // hierarchy walk (`current = current.BaseClass` with no visited guard),
    // independently reachable from StructSymbol.GetHierarchy()'s (fixed by
    // #4162) via TryGetProperty/TryGetEvent during declaration-time
    // `override prop`/`override event` base-member lookup, before the
    // post-bind cycle detector (#973) has run — confirmed hanging (~13 GB
    // RSS in 6s) on a two-class base-class cycle with an `override prop` on
    // either side. Forwards to the single guarded walk instead of keeping a
    // second copy that can drift out of sync with its fix again.
    private func GetHierarchy(type StructSymbol) List[StructSymbol] -> type.GetHierarchy()

    private func EnumerateStructMembers(structSymbol StructSymbol, query MemberQuery) sequence[Symbol] {
        for c in GetHierarchy(structSymbol) {
            if (query.Kinds & MemberKinds.Field) != 0 {
                if query.IncludeInstance {
                    for f in c.Fields {
                        yield f
                    }
                }
                if query.IncludeStatic {
                    for f in c.StaticFields {
                        yield f
                    }
                }
            }
            if (query.Kinds & MemberKinds.Property) != 0 {
                if query.IncludeInstance {
                    for p in c.Properties {
                        yield p
                    }
                }
                if query.IncludeStatic {
                    for p in c.StaticProperties {
                        yield p
                    }
                }
            }
            if (query.Kinds & MemberKinds.Event) != 0 {
                if query.IncludeInstance {
                    for e in c.Events {
                        yield e
                    }
                }
                if query.IncludeStatic {
                    for e in c.StaticEvents {
                        yield e
                    }
                }
            }
            if (query.Kinds & MemberKinds.Method) != 0 {
                if query.IncludeInstance {
                    for m in c.GetDeclaredInstanceMethods() {
                        yield m
                    }
                }
                if query.IncludeStatic {
                    for m in c.StaticMethods {
                        yield m
                    }
                }
            }
            if !query.IncludeInherited {
                yield break
            }
        }
    }

    /// Enumerates interface members with the query's inheritance and static/instance filters.
    private func EnumerateInterfaceMembers(interfaceSymbol InterfaceSymbol, query MemberQuery) sequence[Symbol] {
        // Issue #1006: include inherited base-interface members when the query
        // permits inherited lookup.
        let interfaces = if query.IncludeInherited {
            interfaceSymbol.SelfAndAllBaseInterfaces()
        } else {
            cast[IEnumerable[InterfaceSymbol]]([]InterfaceSymbol{interfaceSymbol})
        }
        for iface in interfaces {
            iface.EnsureMembersResolved()
            // Constructed interfaces project methods but retain data symbols on their definition.
            let declaration = iface.Definition ?? iface
            declaration.EnsureMembersResolved()
            if (query.Kinds & MemberKinds.Property) != 0 {
                for p in declaration.Properties {
                    if IncludesStaticness(p.IsStatic, query) {
                        yield p
                    }
                }
            }
            if (query.Kinds & MemberKinds.Event) != 0 && query.IncludeInstance {
                for e in declaration.Events {
                    yield e
                }
            }
            if (query.Kinds & MemberKinds.Method) != 0 {
                if query.IncludeInstance {
                    for m in iface.Methods {
                        yield m
                    }
                }
                if query.IncludeStatic {
                    for m in iface.StaticMethods {
                        yield m
                    }
                }
            }
        }
    }

    /// ADR-0112 P0: enumerates an enum's members for completion. Enum members
    /// are surfaced as static fields, mirroring the enum handling in
    /// (cref:LookupMember).
    private func EnumerateEnumMembers(enumSymbol EnumSymbol, query MemberQuery) sequence[Symbol] {
        if query.IncludeStatic && (query.Kinds & MemberKinds.Field) != 0 {
            for member in enumSymbol.Members {
                yield member
            }
        }
    }

    private func LookupStructMember(structSymbol StructSymbol, name string, query MemberQuery) Symbol? {
        for c in GetHierarchy(structSymbol) {
            if (query.Kinds & MemberKinds.Property) != 0 &&
                TryFirst(
                if query.IncludeInstance {
                    c.Properties
                } else {
                    ImmutableArray[PropertySymbol].Empty
                },
                if query.IncludeStatic {
                    c.StaticProperties
                } else {
                    ImmutableArray[PropertySymbol].Empty
                },
                name,
                out var property
            ) {
                return property!!
            }
            if (query.Kinds & MemberKinds.Field) != 0 &&
                TryFirst(
                if query.IncludeInstance {
                    c.Fields
                } else {
                    ImmutableArray[FieldSymbol].Empty
                },
                if query.IncludeStatic {
                    c.StaticFields
                } else {
                    ImmutableArray[FieldSymbol].Empty
                },
                name,
                out var field
            ) {
                return field!!
            }
            if (query.Kinds & MemberKinds.Event) != 0 &&
                TryFirst(
                if query.IncludeInstance {
                    c.Events
                } else {
                    ImmutableArray[EventSymbol].Empty
                },
                if query.IncludeStatic {
                    c.StaticEvents
                } else {
                    ImmutableArray[EventSymbol].Empty
                },
                name,
                out var event
            ) {
                return event!!
            }
            if (query.Kinds & MemberKinds.Method) != 0 &&
                TryFirst(
                if query.IncludeInstance {
                    c.GetMethods(name)
                } else {
                    ImmutableArray[FunctionSymbol].Empty
                },
                if query.IncludeStatic {
                    c.StaticMethods
                } else {
                    ImmutableArray[FunctionSymbol].Empty
                },
                name,
                out var method
            ) {
                return method!!
            }
            if !query.IncludeInherited {
                break
            }
        }
        return nil
    }

    private func LookupInterfaceMember(interfaceSymbol InterfaceSymbol, name string, query MemberQuery) Symbol? {
        for member in EnumerateInterfaceMembers(interfaceSymbol, query) {
            if member.Name == name {
                return member
            }
        }
        return nil
    }

    private func IncludesStaticness(isStatic bool, query MemberQuery) bool -> if isStatic {
        query.IncludeStatic
    } else {
        query.IncludeInstance
    }

    private func TryFirst[T Symbol](
        instance ImmutableArray[T],
        static ImmutableArray[T],
        name string,
        @NotNullWhen(true) out result T?
    ) bool {
        if !instance.IsDefaultOrEmpty {
            for s in instance {
                if s.Name == name {
                    result = s
                    return true
                }
            }
        }
        if !static.IsDefaultOrEmpty {
            for s in static {
                if s.Name == name {
                    result = s
                    return true
                }
            }
        }
        result = nil
        return false
    }

    private func AddMethodsDeduped(
        ref builder ImmutableArray[FunctionSymbol].Builder?,
        source ImmutableArray[FunctionSymbol],
        name string,
        skipPrivate bool = false
    ) {
        if source.IsDefaultOrEmpty {
            return
        }
        for m in source {
            if m.Name != name || (skipPrivate && m.Accessibility == Accessibility.Private) {
                continue
            }
            // Issue #3907: an ADR-0149 explicit-interface implementation
            // (`func (IFoo) Bar(…)`) is NOT a member of the implementing type's
            // own lookup surface — C# and the CLR reach it only through the
            // interface. It keeps its plain Name in the symbol table (only the
            // METADATA name is mangled), so leaving it here put it in the
            // overload set for `Bar(…)` written inside the type, where it beat
            // or tied the ordinary method it was meant to delegate to. In the
            // migrated Gsharp.Runtime.Channels that turned
            // `Chan<T>.TrySendLocked`'s `SendOutcome` helper into the `bool`
            // explicit implementation calling itself.
            if m.HasExplicitInterfaceClause || m.ExplicitInterfaceClauseTarget != nil {
                continue
            }
            if builder != nil {
                var hidden = false
                for existing in builder {
                    if BoundScope.FunctionSignaturesEqual(existing, m) || Overrides(existing, m) {
                        hidden = true
                        break
                    }
                }
                if hidden {
                    continue
                }
            }
            builder ??= ImmutableArray.CreateBuilder[FunctionSymbol]()
            builder!!.Add(m)
        }
    }

    /// Issue #3907: reports whether [`derived`](paramref) (already in the
    /// overload set, found first by the this-first hierarchy walk) overrides
    /// [`baseCandidate`](paramref), so the base declaration must not be
    /// added a second time.
    /// @remarks The signature comparison above cannot see this on a GENERIC hierarchy.
    /// `class Derived[T] : Base[T]` gives each level its own
    /// `TypeParameterSymbol` named `T`, so
    /// `Commit(value T)` on the base and on the override are not
    /// signature-equal by symbol identity, both entered the set, and every call
    /// became `GS0266 ambiguous between multiple overloads`. The override
    /// LINK the binder already recorded says what the type comparison cannot.
    /// @param derived The candidate already in the overload set.
    /// @param baseCandidate The base-class candidate being considered.
    /// @returns `true` when the base candidate is already represented.
    private func Overrides(derived FunctionSymbol, baseCandidate FunctionSymbol) bool {
        // Bounded by the depth of the override chain, which the binder builds
        // acyclically; the guard is belt-and-braces against a malformed chain.
        var depth = 0
        {
            var current FunctionSymbol? = derived.OverriddenMethod
            while current != nil && depth < 64 {
                if object.ReferenceEquals(current, baseCandidate) {
                    return true
                }
                current = current.OverriddenMethod
                depth++
            }
        }
        return false
    }
}
