// <copyright file="Adr0193NullabilityFunnelMembersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0193 §3 (GSA0007): pins every member that carries
/// <see cref="NullabilityFunnelAttribute"/>. The attribute exempts a member
/// from the producer-funnel analyzer, so adding one is the reviewed exception
/// issue #4363 asks for: a new exemption fails this test until it is added to
/// the list below, and so shows up in review.
/// </summary>
public sealed class Adr0193NullabilityFunnelMembersTests
{
    private static readonly string[] Expected =
    [
        "ClrNullability.ApplyReferenceNullabilityFull(TypeSymbol, Type, ICustomAttributeProvider, MemberInfo, Type)",
        "ClrNullability.ClassifyFlag(Byte)",
        "ClrNullability.ClassifyPosition(ImmutableArray`1, Int32)",
        "ClrNullability.GetFieldTypeSymbol(FieldInfo)",
        "ClrNullability.GetParameterTypeSymbol(ParameterInfo)",
        "ClrNullability.GetPropertyElementTypeSymbol(PropertyInfo, Type)",
        "ClrNullability.GetPropertyTypeSymbol(PropertyInfo)",
        "ClrNullability.GetReturnTypeSymbol(MethodInfo)",
        "ClrNullability.IsFlagNonNull(Byte)",
        "ClrNullability.IsPositionNonNull(ImmutableArray`1, Int32)",
        "ClrNullability.ProjectNullableFlags(Type, Type, ImmutableArray`1)",
        "ClrNullability.ReadNullableFlags(ICustomAttributeProvider, MemberInfo)",
        "ClrNullability.SymbolFromFlagsOffset(Type, ImmutableArray`1, Int32)",
        "ExternalClrOverrideResolver.SlotSignaturesMatch(MethodInfo, MethodInfo, ImmutableArray`1)",
        "ExternalClrOverrideResolver.TypeMatches(Type, TypeSymbol, ImmutableArray`1, MethodInfo, ImmutableArray`1)",
        "ImportedTypeSymbol.Get(Type)",
        "ImportedTypeSymbol.GetWithoutNullability(Type, NullabilityFreeReason)",
        "MemberLookup.ApplyEventDeclarationNullability(TypeSymbol, EventInfo, Type)",
        "MemberLookup.GetClrEventHandlerTypeSymbol(EventInfo)",
        "MemberLookup.GetClrEventHandlerTypeSymbol(TypeSymbol, EventInfo)",
        "MemberLookup.GetClrFieldTypeSymbol(TypeSymbol, FieldInfo)",
        "MemberLookup.GetClrMemberDeclaringTypeSymbol(TypeSymbol, MemberInfo)",
        "MemberLookup.GetClrMemberValueTypeSymbol(MemberInfo, Type, ImmutableArray`1)",
        "MemberLookup.GetClrMethodParameterTypeSymbol(TypeSymbol, MethodInfo, Int32)",
        "MemberLookup.GetClrMethodReturnTypeSymbol(TypeSymbol, MethodInfo)",
        "MemberLookup.GetClrOpenMethodReturnTypeSymbol(MethodInfo, Type, ImmutableArray`1, ImmutableArray`1)",
        "MemberLookup.GetClrOpenParameterConversionTargetTypeSymbol(ParameterInfo, Type, ImmutableArray`1, MethodInfo, ImmutableArray`1)",
        "MemberLookup.GetClrOpenParameterPointeeTypeSymbol(ParameterInfo, Type, ImmutableArray`1, MethodInfo, ImmutableArray`1)",
        "MemberLookup.GetClrPropertyTypeSymbol(TypeSymbol, PropertyInfo, Boolean)",
        "MemberLookup.GetClrReceiverProjectedParameterPointeeTypeSymbol(TypeSymbol, MethodInfo, Int32)",
        "MemberLookup.GetClrReceiverProjectedReturnTypeSymbol(TypeSymbol, MethodInfo)",
        "MemberLookup.GetIndexerParameterTypeSymbol(TypeSymbol, PropertyInfo, Int32)",
        "MemberLookup.MapOpenClrTypeToSymbolic(Type, ImportedTypeSymbol)",
        "MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray`1)",
        "MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray`1, MethodInfo, ImmutableArray`1)",
        "MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(Type, ImportedTypeSymbol, NullabilityFreeReason)",
        "MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(Type, Type, ImmutableArray`1, NullabilityFreeReason)",
        "NullabilityAnnotatedTypeSymbol.DecodeSymbolicPositions()",
        "NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbol(Int32)",
        "NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbolForClrType(Type)",
        "NullableFlagsBuilder.MergeDeclarationNullability(TypeSymbol, Type, ImmutableArray`1)",
        "TypeSymbol.FromClrType(Type)",
        "TypeSymbol.FromClrTypeWithoutNullability(Type, NullabilityFreeReason)",
        "UserTokenResolver.TryGetSymbolicSubstitutedImportedCallReturn(MethodInfo, ImmutableArray`1, TypeSymbol&)",
        "UserTokenResolver.TryGetSymbolicSubstitutedInstanceMethodReturn(TypeSymbol, MethodInfo, TypeSymbol&)",
        "UserTokenResolver.TryGetSymbolicSubstitutedPropertyReturn(TypeSymbol, PropertyInfo, TypeSymbol&)",
    ];

    [Fact]
    public void EveryFunnelMemberIsListed()
    {
        const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic
            | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        var actual = typeof(TypeSymbol).Assembly.GetTypes()
            .SelectMany(type => type.GetMembers(All))
            .Where(member => member.IsDefined(typeof(NullabilityFunnelAttribute), inherit: false))
            .Select(Describe)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.True(
            Expected.SequenceEqual(actual),
            "The [NullabilityFunnel] members changed. Review the exemption, then update the list to:"
                + Environment.NewLine
                + string.Join(Environment.NewLine, actual.Select(name => $"        \"{name}\",")));
    }

    private static string Describe(MemberInfo member)
    {
        var owner = member.DeclaringType?.Name ?? "?";
        return member switch
        {
            MethodBase method => $"{owner}.{method.Name}({string.Join(", ", method.GetParameters().Select(p => p.ParameterType.Name))})",
            _ => $"{owner}.{member.Name}",
        };
    }
}
