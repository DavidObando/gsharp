// <copyright file="NullabilityFunnelAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0193 §3 (GSA0007): marks a member that is part of the producer
/// funnel, and so may call the conversion doors (<see cref="TypeSymbol.FromClrType"/>,
/// the <c>MemberLookup.MapOpenClrTypeToSymbolic</c> overloads,
/// <see cref="ImportedTypeSymbol.Get(Type)"/>, and
/// <see cref="ClrNullability"/>'s <c>ReadNullableFlags</c> /
/// <c>ClassifyFlag</c> / <c>ClassifyPosition</c>).
/// <para>
/// The exemption is <b>per member, never per type</b>: other members of the
/// same type are checked like any other code. Adding this attribute is the
/// reviewed exception issue #4363 asks for. The analyzer's tests pin the
/// full list of attributed members, so a new one fails a test until that
/// list is updated. Inside a funnel member other than
/// <see cref="NullabilityImportRule"/>'s, a direct
/// <see cref="NullableTypeSymbol.Get"/> or <see cref="PlatformTypeSymbol.Get"/>
/// call is still reported: classified positions resolve through the rule.
/// </para>
/// <para>
/// Lambdas and local functions inside an attributed member are part of it.
/// </para>
/// </summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Constructor | AttributeTargets.Property, Inherited = false)]
internal sealed class NullabilityFunnelAttribute : Attribute
{
}
