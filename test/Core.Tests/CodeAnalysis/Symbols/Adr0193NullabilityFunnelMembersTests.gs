// <copyright file="Adr0193NullabilityFunnelMembersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import Xunit

/// ADR-0193 §3 (GSA0007): pins every member that carries
/// (cref:NullabilityFunnelAttribute). The attribute exempts a member
/// from the producer-funnel analyzer, so adding one is the reviewed exception
/// issue #4363 asks for: a new exemption fails this test until it is added to
/// the list below, and so shows up in review.
class Adr0193NullabilityFunnelMembersTests {
    @Fact
    func EveryFunnelMemberIsListed() {
        const All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
        let actual = typeof(TypeSymbol)
            .Assembly
            .GetTypes()
            .SelectMany(
            func (type Type) IEnumerable[MemberInfo] {
                return type.GetMembers(All)
            }
        )
            .Where((member MemberInfo) -> member.IsDefined(typeof(NullabilityFunnelAttribute), inherit: false))
            .Select(Describe)
            .OrderBy((name string) -> name, StringComparer.Ordinal)
            .ToArray()
        Assert.True(
            Expected.SequenceEqual(actual),
            "The [NullabilityFunnel] members changed. Review the exemption, then update the list to:" +
                Environment.NewLine +
                string.Join(Environment.NewLine, actual.Select((name string) -> "        \"$name\","))
        )
    }

    shared {
        private let Expected[]string = []string{
            "ClrNullability.ApplyReferenceNullabilityFull(TypeSymbol, Type, ICustomAttributeProvider, MemberInfo, Type)",
            "ClrNullability.ClassifyFlag(Byte)",
            "ClrNullability.ClassifyPosition(ImmutableArray`1, Int32)",
            "ClrNullability.DecodeFieldTypeSymbol(FieldInfo)",
            "ClrNullability.DecodeParameterTypeSymbol(ParameterInfo)",
            "ClrNullability.DecodePropertyTypeSymbol(PropertyInfo)",
            "ClrNullability.DecodeReturnTypeSymbol(MethodInfo)",
            "ClrNullability.GetFieldTypeSymbol(FieldInfo)",
            "ClrNullability.GetParameterDeclaredState(ParameterInfo)",
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
            "MemberLookup.GetClrMethodParameterConversionTargetTypeSymbol(TypeSymbol, MethodInfo, Int32, ImmutableArray`1)",
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
            "MetadataMemberComparison.PositionMark(Type, ICustomAttributeProvider, MemberInfo)",
            "MetadataNullability.ApplyPosition(ReferenceImageSet, TypeSymbol, ImmutableArray`1)",
            "MetadataNullability.ReadFlags(MetadataModule, EntityHandle, IEnumerable`1)",
            "NullabilityAnnotatedTypeSymbol.DecodeSymbolicPositions()",
            "NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbol(Int32)",
            "NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbolForClrType(Type)",
            "NullableFlagsBuilder.MergeDeclarationNullability(TypeSymbol, Type, ImmutableArray`1)",
            "TypeSymbol.FromClrType(Type)",
            "TypeSymbol.FromClrTypeWithoutNullability(Type, NullabilityFreeReason)",
            "UserTokenResolver.TryGetSymbolicSubstitutedImportedCallReturn(MethodInfo, ImmutableArray`1, TypeSymbol&)",
            "UserTokenResolver.TryGetSymbolicSubstitutedInstanceMethodReturn(TypeSymbol, MethodInfo, TypeSymbol&)",
            "UserTokenResolver.TryGetSymbolicSubstitutedPropertyReturn(TypeSymbol, PropertyInfo, TypeSymbol&)"
        }

        private func Describe(member MemberInfo) string {
            let owner = member.DeclaringType?.Name ?? "?"
            return switch member {
                case method is MethodBase: "$owner.${method.Name}(${string.Join(", ", method.GetParameters().Select((p ParameterInfo) -> p.ParameterType.Name))})"
                default: "$owner.${member.Name}"
            }
        }
    }
}
