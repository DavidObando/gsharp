// <copyright file="MethodInfoHelpers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// PR-E-12: small grouping of static method-info utilities lifted from
/// <see cref="ReflectionMetadataEmitter"/>. These four helpers form a
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
                    foreach (var openMethod in openDefinition.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
                    {
                        if (openMethod.IsSpecialName || openMethod.Name != method.Name)
                        {
                            continue;
                        }

                        if (MemberLookup.HasMatchingMethodForSymbolicClrInterface(structSym, openMethod, symbolicArgs))
                        {
                            return true;
                        }
                    }

                    continue;
                }

                var clrIface = ifaceSym?.ClrType;
                if (clrIface == null)
                {
                    continue;
                }

                foreach (var clrMethod in clrIface.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
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
            if (!DeclarationBinder.TypeSignaturesEquivalent(
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
        if (DeclarationBinder.TypeSignaturesEquivalent(a, b, typeParameterMap))
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
