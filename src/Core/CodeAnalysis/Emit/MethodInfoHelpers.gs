// <copyright file="MethodInfoHelpers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection

/// PR-E-12: small grouping of static method-info utilities lifted from
/// (cref:ReflectionMetadataEmitter). These helpers form a
/// tight cluster around method-vs-interface comparison and signature
/// matching:
/// - (cref:RequiresVirtualOnValueType) — issue #409, the question "must this struct method keep
/// `virtual` attributes because the CLR will vtable-dispatch through it?"
/// - (cref:MethodImplicitlyImplementsInterface) — supports the answer by walking both G#
/// (cref:StructSymbol.Interfaces) and imported CLR (cref:StructSymbol.ImplementedClrInterfaces) (issue
/// #525).
/// - (cref:MethodSignaturesMatch) — name/return/parameter equality between two G# functions, used when
/// matching candidate implementations to interface members.
/// - (cref:CallableParameters) — strips the explicit receiver from a method's parameter list to get the
/// "as-called" arity.
/// Kept static and pure: no (cref:EmitContext) reference required.
internal shared class MethodInfoHelpers {
    /// Finds inherited source members selected for interfaces introduced by descendants.
    /// @param program The program whose source members are being emitted.
    /// @returns The methods and property accessors requiring interface dispatch slots.
    func GetInheritedInterfaceImplementations(program BoundProgram)(
        Methods HashSet[FunctionSymbol],
        PropertyAccessors HashSet[(Property PropertySymbol, IsGetter bool)]
    ) {
        let methods = HashSet[FunctionSymbol]()
        let propertyAccessors = HashSet[(Property PropertySymbol, IsGetter bool)]()
        for implementer in program.Structs {
            let AddMethod = func (method FunctionSymbol?) {
                if method?.ReceiverType is StructSymbol owner && !object.ReferenceEquals(
                    owner.Definition ?? owner,
                    implementer.Definition ?? implementer
                ) {
                    methods.Add(method!!)
                }
            }
            let AddProperty = func (property PropertySymbol?, needsGetter bool, needsSetter bool) {
                if property == nil {
                    return
                }
                for owner in implementer.GetHierarchy() {
                    let index = owner.Properties.IndexOf(property)
                    if index < 0 {
                        continue
                    }
                    if object.ReferenceEquals(owner, implementer) {
                        return
                    }
                    // Constructed properties preserve declaration order and their
                    // accessor symbols; promote the emitted definition, not its projection.
                    let definition = (owner.Definition ?? owner).Properties[index]
                    if needsGetter && definition.HasGetter {
                        propertyAccessors.Add((definition, true))
                        if definition.GetterSymbol is {} getter {
                            methods.Add(getter)
                        }
                    }
                    if needsSetter && definition.HasSetter {
                        propertyAccessors.Add((definition, false))
                        if definition.SetterSymbol is {} setter {
                            methods.Add(setter)
                        }
                    }
                    return
                }
            }
            if !implementer.IsClass || implementer.BaseClass == nil {
                continue
            }
            for iface in implementer.Interfaces {
                for slot in iface.Methods {
                    AddMethod(DeclarationBinder.FindInterfaceMethodImplementation(implementer, iface, slot))
                }
                for slot in(iface.Definition ?? iface).Properties {
                    if !slot.IsStatic {
                        AddProperty(
                            DeclarationBinder.FindInterfacePropertyImplementation(implementer, iface, slot),
                            slot.HasGetter,
                            slot.HasSetter
                        )
                    }
                }
            }
            for iface in implementer.ImplementedClrInterfaces {
                for slot in MemberLookup.EnumerateClrInterfaceSlots(iface, includeDefaultMethods: true) {
                    AddMethod(DeclarationBinder.FindClrInterfaceMethodImplementation(implementer, slot))
                }
                for slot in MemberLookup.EnumerateClrInterfacePropertySlots(iface) {
                    AddProperty(
                        DeclarationBinder.FindClrInterfacePropertyImplementation(
                            implementer,
                            slot.SlotOwner,
                            slot.Property,
                            slot.Property.GetMethod,
                            slot.Property.SetMethod,
                            slot.SymbolicArgs
                        ),
                        slot.Property.GetMethod != nil,
                        slot.Property.SetMethod != nil
                    )
                }
            }
        }
        return (methods, propertyAccessors)
    }

    func IsCovariantPropertyGetter(
        function FunctionSymbol
    ) bool -> function.AssociatedSymbol is PropertySymbol property &&
        object.ReferenceEquals(property.GetterSymbol, function) && IsCovariantPropertyGetter(property)

    func IsCovariantPropertyGetter(property PropertySymbol) bool {
        if !property.IsOverride || !property.HasGetter {
            return false
        }
        if property.OverriddenProperty is {} baseProperty {
            return DeclarationBinder.IsCovariantPropertyOverride(
                baseProperty,
                property.Type,
                property.HasGetter,
                property.HasSetter,
                property.ReturnRefKind
            )
        }
        if property.ExternalOverriddenGetter is not{} externalGetter ||
            property.ExternalOverrideContainingType is not{} externalOwner {
            return false
        }
        let baseType = MemberLookup.GetClrMethodReturnTypeSymbol(externalOwner, externalGetter)
        return DeclarationBinder.IsCovariantPropertyOverride(
            baseType,
            baseHasGetter: true,
            baseHasSetter: property.ExternalOverriddenSetter != nil,
            baseReturnRefKind: if externalGetter.ReturnType.IsByRef {
                RefKind.Ref
            } else {
                RefKind.None
            },
            property.Type,
            property.HasGetter,
            property.HasSetter,
            property.ReturnRefKind
        )
    }

    /// Issue #409: determines whether a value-type instance method must keep
    /// virtual method attributes because it participates in CLR vtable dispatch.
    /// @param function The function being inspected.
    /// @param receiverStruct The struct that declares [`function`](paramref),
    /// or `null` when the function has no declaring struct.
    /// @returns True if the method must be emitted as `virtual`.
    func RequiresVirtualOnValueType(function FunctionSymbol, receiverStruct StructSymbol?) bool {
        if function.IsOverride || function.OverriddenMethod != nil {
            return true
        }
        if receiverStruct == nil {
            // No declaring struct means no property accessor to check, and a
            // function that is not a value-type member cannot need this at all.
            return false
        }
        for property in receiverStruct.Properties {
            if (
                object.ReferenceEquals(property.GetterSymbol, function) || object.ReferenceEquals(
                    property.SetterSymbol,
                    function
                )
            ) &&
                (
                property.HasExplicitInterfaceClause || MemberDefEmitter.PropertyImplicitlyImplementsInterface(
                    receiverStruct,
                    property
                )
            ) {
                return true
            }
        }
        // Issue #4157: the property loop above checks a PROPERTY accessor's
        // explicit-interface clause, but an ordinary METHOD's own explicit
        // binding to an interface slot was never checked here — the code fell
        // straight through to the implicit-match fallback below, whose own
        // contract (see its doc comment) only recognizes an IMPLICIT
        // same-name/same-signature match. Two distinct explicit-binding shapes
        // both need the same "must be virtual" answer as the property case:
        //   - `function.HasExplicitInterfaceClause` — a G#-authored explicit
        //     qualifier clause (`func (IFoo) M(...)`, ADR-0149), whether the
        //     clause target is a G# interface (ExplicitInterfaceMember) or an
        //     imported CLR interface (ExplicitInterfaceSlot) — mirrors the
        //     property check immediately above.
        //   - `function.ExplicitInterfaceSlot != null` — set WITHOUT any
        //     explicit-interface clause syntax at all (G# has none for plain
        //     methods) when DeclarationBinder.Structs.cs's covariant-return
        //     interface bridge (issue #985) binds a same-name/same-parameter
        //     method to a DIFFERENT interface slot than its sibling overload
        //     — the exact shape of the non-generic `IEnumerable.GetEnumerator`
        //     bridge alongside a public generic `GetEnumerator()` that this
        //     issue's failing corpus fixtures hit. Both shapes emit a
        //     `MethodImpl` row (see InterfaceImplEmitter) that binds the
        //     method to an interface slot; per ECMA-335 the CLR type loader
        //     requires that method to be `virtual` or the type fails to load
        //     (`TypeLoadException: "...must be virtual to implement a method
        //     on an interface or super type."`) — a defect ilverify does not
        //     catch (see the dotnet/runtime issue this fix cites).
        if function.HasExplicitInterfaceClause || function.ExplicitInterfaceSlot != nil {
            return true
        }
        return MethodImplicitlyImplementsInterface(receiverStruct, function)
    }

    /// Determines whether a method on a class/struct implicitly implements an
    /// interface method (same name, parameters, and return type). Considers
    /// both G# interfaces ((cref:StructSymbol.Interfaces)) and imported
    /// CLR interfaces ((cref:StructSymbol.ImplementedClrInterfaces),
    /// issue #525).
    /// @param structSym The struct that contains [`method`](paramref).
    /// @param method The candidate method.
    /// @returns True if the method matches any interface method (G# or CLR).
    func MethodImplicitlyImplementsInterface(structSym StructSymbol, method FunctionSymbol) bool {
        if !structSym.Interfaces.IsDefaultOrEmpty {
            for iface in structSym.Interfaces {
                let defIface = iface.Definition ?? iface
                for interfaceEvent in defIface.Events {
                    var implementationEvent EventSymbol? = nil
                    for candidate in structSym.Events {
                        if object.ReferenceEquals(candidate.AddMethodSymbol, method) || object.ReferenceEquals(
                            candidate.RemoveMethodSymbol,
                            method
                        ) ||
                            object.ReferenceEquals(candidate.RaiseMethodSymbol, method) {
                            implementationEvent = candidate
                            break
                        }
                    }
                    if implementationEvent != nil &&
                        interfaceEvent.Name == implementationEvent.Name &&
                        DeclarationBinder.InterfaceEventTypesEquivalent(iface, interfaceEvent, implementationEvent) {
                        return true
                    }
                }
                if iface.Methods.IsDefaultOrEmpty {
                    continue
                }
                for ifaceMethod in iface.Methods {
                    if MethodSignaturesMatch(ifaceMethod, method) {
                        return true
                    }
                }
            }
        }
        if !structSym.ImplementedClrInterfaces.IsDefaultOrEmpty {
            for ifaceSym in structSym.ImplementedClrInterfaces {
                // Issue #949: a CLR generic interface closed over a user G# type
                // (e.g. `IEquatable[Shape]`) is type-erased; match against the
                // open definition with the symbolic arguments substituted so the
                // user method (`Equals(Shape)`) is recognised as an implicit
                // implementation and is promoted to a virtual interface slot.
                if MemberLookup.TryGetSymbolicClrGenericInterface(
                    ifaceSym,
                    out var openDefinition,
                    out var symbolicArgs
                ) {
                    for inherited in MemberLookup.EnumerateSelfAndInterfaces(openDefinition) {
                        for openMethod in inherited.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                            if openMethod.Name != method.Name || (openMethod.IsSpecialName && !method.IsSpecialName) {
                                continue
                            }
                            if MemberLookup.MethodMatchesSymbolicClrInterfaceSignature(
                                method,
                                openMethod,
                                symbolicArgs
                            ) {
                                return true
                            }
                        }
                    }
                    continue
                }
                let clrIface Type? = ifaceSym?.ClrType
                if clrIface == nil {
                    continue
                }
                // GetMethods on an interface omits inherited slots (#4214).
                for inherited in MemberLookup.EnumerateSelfAndInterfaces(clrIface) {
                    for clrMethod in inherited.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                        if clrMethod.Name != method.Name || (clrMethod.IsSpecialName && !method.IsSpecialName) {
                            continue
                        }
                        if MemberLookup.MethodMatchesClrSignature(method, clrMethod) {
                            return true
                        }
                    }
                }
            }
        }
        return false
    }

    /// Returns true when the two G# function signatures match (name, return
    /// type, and ordered parameter types).
    /// @param interfaceMethod The interface method.
    /// @param implementationMethod The candidate implementation method.
    /// @returns True if the signatures are equivalent.
    func MethodSignaturesMatch(interfaceMethod FunctionSymbol, implementationMethod FunctionSymbol) bool {
        let typeParameterMap IReadOnlyDictionary[
            TypeParameterSymbol,
            TypeSymbol
        ]? = DeclarationBinder.TryBuildMethodTypeParameterMap(interfaceMethod, implementationMethod)
        if typeParameterMap == nil ||
            interfaceMethod.Name != implementationMethod.Name ||
            !ReturnTypesMatch(interfaceMethod, implementationMethod, typeParameterMap) {
            return false
        }
        let interfaceParameters = CallableParameters(interfaceMethod)
        let implementationParameters = CallableParameters(implementationMethod)
        if interfaceParameters.Length != implementationParameters.Length {
            return false
        }
        for var i = 0; i < interfaceParameters.Length; i++ {
            if !DeclarationBinder.ConformanceSignaturesEquivalent(
                interfaceParameters[i].Type,
                implementationParameters[i].Type,
                typeParameterMap
            ) {
                return false
            }
        }
        return true
    }

    /// Returns the method's parameter list with the explicit receiver (the
    /// first parameter when (cref:FunctionSymbol.ExplicitReceiverParameter)
    /// is set) removed — i.e. the parameters as seen by the call site.
    /// @param method The method.
    /// @returns The "as-called" parameter list.
    func CallableParameters(method FunctionSymbol) ImmutableArray[
        ParameterSymbol
    ] -> if method.ExplicitReceiverParameter == nil {
        method.Parameters
    } else {
        method.Parameters.RemoveAt(0)
    }

    /// Issue #1071: compares an interface method's declared return type against
    /// the implementing method's <em>effective</em> return type, normalizing for
    /// `async` so an `async func` (effective return `Task` /
    /// `Task[T]`) is recognised as implementing an interface method declared
    /// with the explicit `Task` / `Task[T]` return type. Required so
    /// the implementing async method is promoted to a virtual interface slot at
    /// emit time.
    private func ReturnTypesMatch(
        interfaceMethod FunctionSymbol,
        implementationMethod FunctionSymbol,
        typeParameterMap IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]
    ) bool {
        if AsyncIteratorDetection.IsAsyncIteratorReturnType(interfaceMethod.Type) &&
            AsyncIteratorDetection
            .IsAsyncIteratorReturnType(implementationMethod.Type) {
            return TypesMatch(interfaceMethod.Type, implementationMethod.Type, typeParameterMap)
        }
        if interfaceMethod.IsAsyncVoid || implementationMethod.IsAsyncVoid {
            let interfaceIsEffectivelyVoid = interfaceMethod.IsAsyncVoid ||
                (!interfaceMethod.IsAsyncOrSuspending && object.ReferenceEquals(interfaceMethod.Type, TypeSymbol.Void))
            let implementationIsEffectivelyVoid = implementationMethod.IsAsyncVoid ||
                (
                !implementationMethod.IsAsyncOrSuspending && object.ReferenceEquals(
                    implementationMethod.Type,
                    TypeSymbol.Void
                )
            )
            return interfaceIsEffectivelyVoid && implementationIsEffectivelyVoid
        }
        if interfaceMethod.IsAsyncOrSuspending == implementationMethod.IsAsyncOrSuspending {
            return TypesMatch(interfaceMethod.Type, implementationMethod.Type, typeParameterMap)
        }
        if implementationMethod.IsAsyncOrSuspending {
            return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(interfaceMethod.Type, out var awaited) &&
                TypesMatch(awaited, implementationMethod.Type, typeParameterMap)
        }
        return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(implementationMethod.Type, out var awaited2) &&
            TypesMatch(interfaceMethod.Type, awaited2, typeParameterMap)
    }

    private func TypesMatch(
        a TypeSymbol?,
        b TypeSymbol?,
        typeParameterMap IReadOnlyDictionary[TypeParameterSymbol, TypeSymbol]
    ) bool {
        if DeclarationBinder.ConformanceSignaturesEquivalent(a, b, typeParameterMap) {
            return true
        }
        if a == nil || b == nil {
            return false
        }
        let ca Type? = a.ClrType
        let cb Type? = b.ClrType
        return ca != nil && cb != nil && ClrTypeUtilities.AreSame(ca, cb)
    }
}
