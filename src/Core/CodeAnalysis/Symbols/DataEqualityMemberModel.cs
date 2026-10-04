// <copyright file="DataEqualityMemberModel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>Compiler-owned signatures shared by data equality binding and emission.</summary>
internal static class DataEqualityMemberModel
{
    /// <summary>Creates a self or inherited typed-base equality member.</summary>
    /// <param name="owner">The declaring data type.</param>
    /// <param name="otherType">The self type or direct data base.</param>
    /// <param name="isOverride">Whether this member overrides the direct base typed slot.</param>
    /// <returns>The compiler-owned equality signature.</returns>
    internal static FunctionSymbol Create(StructSymbol owner, StructSymbol otherType, bool isOverride)
    {
        var definition = typeof(IEquatable<>);
        var method = Invariant.Required(definition.GetMethod("Equals"), "IEquatable<T> declares Equals");
        var signatureType = otherType.IsGenericDefinition
            ? StructSymbol.Construct(otherType, otherType.TypeParameters.Cast<TypeSymbol>().ToImmutableArray())
            : otherType;
        var parameterType = MemberLookup.GetClrOpenParameterTypeSymbol(
            method.GetParameters()[0],
            definition,
            ImmutableArray.Create<TypeSymbol>(signatureType));
        return new FunctionSymbol(
            "Equals",
            ImmutableArray.Create(new ParameterSymbol("other", parameterType)),
            TypeSymbol.Bool,
            declaration: null,
            package: null,
            accessibility: Accessibility.Public,
            receiverType: owner,
            isOpen: owner.IsClass && (owner.IsOpen || owner.IsSealedHierarchy) && !isOverride,
            isOverride: isOverride);
    }

    /// <summary>Creates the existing synthesized override of object equality.</summary>
    /// <param name="owner">The declaring data type.</param>
    /// <returns>The compiler-owned object equality signature.</returns>
    internal static FunctionSymbol CreateObject(StructSymbol owner)
    {
        var method = Invariant.Required(
            typeof(object).GetMethod("Equals", new[] { typeof(object) }),
            "System.Object declares instance Equals");
        var parameter = method.GetParameters()[0];
        return new FunctionSymbol(
            "Equals",
            ImmutableArray.Create(new ParameterSymbol(
                Invariant.Required(parameter.Name, "System.Object.Equals has a named parameter"),
                MemberLookup.GetClrOpenParameterTypeSymbol(parameter, typeof(object), ImmutableArray<TypeSymbol>.Empty))),
            TypeSymbol.Bool,
            declaration: null,
            package: null,
            accessibility: Accessibility.Public,
            receiverType: owner,
            isOpen: owner.IsClass && (owner.IsOpen || owner.IsSealedHierarchy),
            isOverride: true);
    }
}
