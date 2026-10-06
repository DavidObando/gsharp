// <copyright file="MethodInfoHelpers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-12: small grouping of static method-info utilities lifted from
/// <see cref="ReflectionMetadataEmitter"/>. These helpers form a
/// tight cluster around method-vs-interface comparison and signature
/// matching:
/// <list type="bullet">
///   <item><description><see cref="RequiresVirtualOnValueType"/> — issue #409, the question
///     "must this struct method keep <c>virtual</c> attributes because the CLR will
///     vtable-dispatch through it?"</description></item>
///   <item><description><see cref="MethodImplicitlyImplementsInterface"/> — supports the answer by
///     walking both G# <see cref="StructSymbol.Interfaces"/> and imported CLR
///     <see cref="StructSymbol.ImplementedClrInterfaces"/> (issue #525).</description></item>
///   <item><description><see cref="MethodSignaturesMatch"/> — name/return/parameter equality
///     between two G# functions, used when matching candidate implementations
///     to interface members.</description></item>
///   <item><description><see cref="CallableParameters"/> — strips the explicit receiver from a
///     method's parameter list to get the "as-called" arity.</description></item>
/// </list>
/// Kept static and pure: no <see cref="EmitContext"/> reference required.
/// </summary>
internal static class MethodInfoHelpers
{
    /// <summary>Finds inherited source members selected for interfaces introduced by descendants.</summary>
    /// <param name="program">The program whose source members are being emitted.</param>
    /// <returns>The methods and property accessors requiring interface dispatch slots.</returns>
    public static (
        HashSet<FunctionSymbol> Methods,
        HashSet<(PropertySymbol Property, bool IsGetter)> PropertyAccessors)
        GetInheritedInterfaceImplementations(BoundProgram program)
    {
        var methods = new HashSet<FunctionSymbol>();
        var propertyAccessors = new HashSet<(PropertySymbol Property, bool IsGetter)>();
        foreach (var implementer in program.Structs)
        {
            if (!implementer.IsClass || implementer.BaseClass == null)
            {
                continue;
            }

            foreach (var iface in implementer.Interfaces)
            {
                foreach (var slot in iface.Methods)
                {
                    AddMethod(DeclarationBinder.FindInterfaceMethodImplementation(implementer, iface, slot));
                }

                foreach (var slot in (iface.Definition ?? iface).Properties)
                {
                    if (!slot.IsStatic)
                    {
                        AddProperty(
                            DeclarationBinder.FindInterfacePropertyImplementation(implementer, iface, slot),
                            slot.HasGetter,
                            slot.HasSetter);
                    }
                }
            }

            foreach (var iface in implementer.ImplementedClrInterfaces)
            {
                foreach (var slot in MemberLookup.EnumerateClrInterfaceSlots(iface, includeDefaultMethods: true))
                {
                    AddMethod(DeclarationBinder.FindClrInterfaceMethodImplementation(implementer, slot));
                }

                foreach (var slot in MemberLookup.EnumerateClrInterfacePropertySlots(iface))
                {
                    AddProperty(
                        DeclarationBinder.FindClrInterfacePropertyImplementation(
                            implementer,
                            slot.SlotOwner,
                            slot.Property,
                            slot.Property.GetMethod,
                            slot.Property.SetMethod,
                            slot.SymbolicArgs),
                        slot.Property.GetMethod != null,
                        slot.Property.SetMethod != null);
                }
            }

            void AddMethod(FunctionSymbol? method)
            {
                if (method?.ReceiverType is StructSymbol owner
                    && !ReferenceEquals(owner.Definition ?? owner, implementer.Definition ?? implementer))
                {
                    methods.Add(method);
                }
            }

            void AddProperty(PropertySymbol? property, bool needsGetter, bool needsSetter)
            {
                if (property == null)
                {
                    return;
                }

                foreach (var owner in implementer.GetHierarchy())
                {
                    var index = owner.Properties.IndexOf(property);
                    if (index < 0)
                    {
                        continue;
                    }

                    if (ReferenceEquals(owner, implementer))
                    {
                        return;
                    }

                    // Constructed properties preserve declaration order and their
                    // accessor symbols; promote the emitted definition, not its projection.
                    var definition = (owner.Definition ?? owner).Properties[index];
                    if (needsGetter && definition.HasGetter)
                    {
                        propertyAccessors.Add((definition, true));
                        if (definition.GetterSymbol is { } getter)
                        {
                            methods.Add(getter);
                        }
                    }

                    if (needsSetter && definition.HasSetter)
                    {
                        propertyAccessors.Add((definition, false));
                        if (definition.SetterSymbol is { } setter)
                        {
                            methods.Add(setter);
                        }
                    }

                    return;
                }
            }
        }

        return (methods, propertyAccessors);
    }

    public static bool IsCovariantPropertyGetter(FunctionSymbol function)
        => function.AssociatedSymbol is PropertySymbol property
            && ReferenceEquals(property.GetterSymbol, function)
            && IsCovariantPropertyGetter(property);

    public static bool IsCovariantPropertyGetter(PropertySymbol property)
    {
        if (!property.IsOverride || !property.HasGetter)
        {
            return false;
        }

        if (property.OverriddenProperty is { } baseProperty)
        {
            return DeclarationBinder.IsCovariantPropertyOverride(
                baseProperty,
                property.Type,
                property.HasGetter,
                property.HasSetter,
                property.ReturnRefKind);
        }

        if (property.ExternalOverriddenGetter is not { } externalGetter
            || property.ExternalOverrideContainingType is not { } externalOwner)
        {
            return false;
        }

        var baseType = MemberLookup.GetClrMethodReturnTypeSymbol(externalOwner, externalGetter);
        return DeclarationBinder.IsCovariantPropertyOverride(
            baseType,
            baseHasGetter: true,
            baseHasSetter: property.ExternalOverriddenSetter != null,
            baseReturnRefKind: externalGetter.ReturnType.IsByRef ? RefKind.Ref : RefKind.None,
            property.Type,
            property.HasGetter,
            property.HasSetter,
            property.ReturnRefKind);
    }

    /// <summary>
    /// Issue #409: determines whether a value-type instance method must keep
    /// virtual method attributes because it participates in CLR vtable dispatch.
    /// </summary>
    /// <param name="function">The function being inspected.</param>
    /// <param name="receiverStruct">The struct that declares <paramref name="function"/>,
    /// or <c>null</c> when the function has no declaring struct.</param>
    /// <returns>True if the method must be emitted as <c>virtual</c>.</returns>
    public static bool RequiresVirtualOnValueType(FunctionSymbol function, StructSymbol? receiverStruct)
    {
        if (function.IsOverride || function.OverriddenMethod != null)
        {
            return true;
        }

        if (receiverStruct is null)
        {
            // No declaring struct means no property accessor to check, and a
            // function that is not a value-type member cannot need this at all.
            return false;
        }

        foreach (var property in receiverStruct.Properties)
        {
            if ((ReferenceEquals(property.GetterSymbol, function)
                    || ReferenceEquals(property.SetterSymbol, function))
                && (property.HasExplicitInterfaceClause
                    || MemberDefEmitter.PropertyImplicitlyImplementsInterface(receiverStruct, property)))
            {
                return true;
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
        if (function.HasExplicitInterfaceClause || function.ExplicitInterfaceSlot != null)
        {
            return true;
        }

        return MethodImplicitlyImplementsInterface(receiverStruct, function);
    }

    /// <summary>
    /// Determines whether a method on a class/struct implicitly implements an
    /// interface method (same name, parameters, and return type). Considers
    /// both G# interfaces (<see cref="StructSymbol.Interfaces"/>) and imported
    /// CLR interfaces (<see cref="StructSymbol.ImplementedClrInterfaces"/>,
    /// issue #525).
    /// </summary>
    /// <param name="structSym">The struct that contains <paramref name="method"/>.</param>
    /// <param name="method">The candidate method.</param>
    /// <returns>True if the method matches any interface method (G# or CLR).</returns>
    public static bool MethodImplicitlyImplementsInterface(StructSymbol structSym, FunctionSymbol method)
    {
        if (!structSym.Interfaces.IsDefaultOrEmpty)
        {
            foreach (var iface in structSym.Interfaces)
            {
                var defIface = iface.Definition ?? iface;
                foreach (var interfaceEvent in defIface.Events)
                {
                    EventSymbol? implementationEvent = null;
                    foreach (var candidate in structSym.Events)
                    {
                        if (ReferenceEquals(candidate.AddMethodSymbol, method)
                            || ReferenceEquals(candidate.RemoveMethodSymbol, method)
                            || ReferenceEquals(candidate.RaiseMethodSymbol, method))
                        {
                            implementationEvent = candidate;
                            break;
                        }
                    }

                    if (implementationEvent != null
                        && interfaceEvent.Name == implementationEvent.Name
                        && DeclarationBinder.InterfaceEventTypesEquivalent(iface, interfaceEvent, implementationEvent))
                    {
                        return true;
                    }
                }

                if (iface.Methods.IsDefaultOrEmpty)
                {
                    continue;
                }

                foreach (var ifaceMethod in iface.Methods)
                {
                    if (MethodSignaturesMatch(ifaceMethod, method))
                    {
                        return true;
                    }
                }
            }
        }

        if (!structSym.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            foreach (var ifaceSym in structSym.ImplementedClrInterfaces)
            {
                // Issue #949: a CLR generic interface closed over a user G# type
                // (e.g. `IEquatable[Shape]`) is type-erased; match against the
                // open definition with the symbolic arguments substituted so the
                // user method (`Equals(Shape)`) is recognised as an implicit
                // implementation and is promoted to a virtual interface slot.
                if (MemberLookup.TryGetSymbolicClrGenericInterface(ifaceSym, out var openDefinition, out var symbolicArgs))
                {
                    foreach (var inherited in MemberLookup.EnumerateSelfAndInterfaces(openDefinition))
                    {
                        foreach (var openMethod in inherited.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
                        {
                            if (openMethod.Name != method.Name
                                || (openMethod.IsSpecialName && !method.IsSpecialName))
                            {
                                continue;
                            }

                            if (MemberLookup.MethodMatchesSymbolicClrInterfaceSignature(method, openMethod, symbolicArgs))
                            {
                                return true;
                            }
                        }
                    }

                    continue;
                }

                var clrIface = ifaceSym?.ClrType;
                if (clrIface == null)
                {
                    continue;
                }

                // GetMethods on an interface omits inherited slots (#4214).
                foreach (var inherited in MemberLookup.EnumerateSelfAndInterfaces(clrIface))
                {
                    foreach (var clrMethod in inherited.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
                    {
                        if (clrMethod.Name != method.Name
                            || (clrMethod.IsSpecialName && !method.IsSpecialName))
                        {
                            continue;
                        }

                        if (MemberLookup.MethodMatchesClrSignature(method, clrMethod))
                        {
                            return true;
                        }
                    }
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Returns true when the two G# function signatures match (name, return
    /// type, and ordered parameter types).
    /// </summary>
    /// <param name="interfaceMethod">The interface method.</param>
    /// <param name="implementationMethod">The candidate implementation method.</param>
    /// <returns>True if the signatures are equivalent.</returns>
    public static bool MethodSignaturesMatch(FunctionSymbol interfaceMethod, FunctionSymbol implementationMethod)
    {
        var typeParameterMap = DeclarationBinder.TryBuildMethodTypeParameterMap(
            interfaceMethod,
            implementationMethod);
        if (typeParameterMap == null
            || interfaceMethod.Name != implementationMethod.Name
            || !ReturnTypesMatch(interfaceMethod, implementationMethod, typeParameterMap))
        {
            return false;
        }

        var interfaceParameters = CallableParameters(interfaceMethod);
        var implementationParameters = CallableParameters(implementationMethod);
        if (interfaceParameters.Length != implementationParameters.Length)
        {
            return false;
        }

        for (var i = 0; i < interfaceParameters.Length; i++)
        {
            if (!DeclarationBinder.ConformanceSignaturesEquivalent(
                interfaceParameters[i].Type,
                implementationParameters[i].Type,
                typeParameterMap))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Returns the method's parameter list with the explicit receiver (the
    /// first parameter when <see cref="FunctionSymbol.ExplicitReceiverParameter"/>
    /// is set) removed — i.e. the parameters as seen by the call site.
    /// </summary>
    /// <param name="method">The method.</param>
    /// <returns>The "as-called" parameter list.</returns>
    public static ImmutableArray<ParameterSymbol> CallableParameters(FunctionSymbol method)
        => method.ExplicitReceiverParameter == null ? method.Parameters : method.Parameters.RemoveAt(0);

    /// <summary>
    /// Issue #1071: compares an interface method's declared return type against
    /// the implementing method's <em>effective</em> return type, normalizing for
    /// <c>async</c> so an <c>async func</c> (effective return <c>Task</c> /
    /// <c>Task[T]</c>) is recognised as implementing an interface method declared
    /// with the explicit <c>Task</c> / <c>Task[T]</c> return type. Required so
    /// the implementing async method is promoted to a virtual interface slot at
    /// emit time.
    /// </summary>
    private static bool ReturnTypesMatch(
        FunctionSymbol interfaceMethod,
        FunctionSymbol implementationMethod,
        System.Collections.Generic.IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParameterMap)
    {
        if (AsyncIteratorDetection.IsAsyncIteratorReturnType(interfaceMethod.Type)
            && AsyncIteratorDetection.IsAsyncIteratorReturnType(implementationMethod.Type))
        {
            return TypesMatch(interfaceMethod.Type, implementationMethod.Type, typeParameterMap);
        }

        if (interfaceMethod.IsAsyncVoid || implementationMethod.IsAsyncVoid)
        {
            var interfaceIsEffectivelyVoid = interfaceMethod.IsAsyncVoid
                || (!interfaceMethod.IsAsyncOrSuspending && ReferenceEquals(interfaceMethod.Type, TypeSymbol.Void));
            var implementationIsEffectivelyVoid = implementationMethod.IsAsyncVoid
                || (!implementationMethod.IsAsyncOrSuspending && ReferenceEquals(implementationMethod.Type, TypeSymbol.Void));
            return interfaceIsEffectivelyVoid && implementationIsEffectivelyVoid;
        }

        if (interfaceMethod.IsAsyncOrSuspending == implementationMethod.IsAsyncOrSuspending)
        {
            return TypesMatch(interfaceMethod.Type, implementationMethod.Type, typeParameterMap);
        }

        if (implementationMethod.IsAsyncOrSuspending)
        {
            return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(interfaceMethod.Type, out var awaited)
                && TypesMatch(awaited, implementationMethod.Type, typeParameterMap);
        }

        return AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(implementationMethod.Type, out var awaited2)
            && TypesMatch(interfaceMethod.Type, awaited2, typeParameterMap);
    }

    private static bool TypesMatch(
        TypeSymbol a,
        TypeSymbol b,
        System.Collections.Generic.IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> typeParameterMap)
    {
        if (DeclarationBinder.ConformanceSignaturesEquivalent(a, b, typeParameterMap))
        {
            return true;
        }

        if (a == null || b == null)
        {
            return false;
        }

        var ca = a.ClrType;
        var cb = b.ClrType;
        return ca != null && cb != null && ClrTypeUtilities.AreSame(ca, cb);
    }
}
