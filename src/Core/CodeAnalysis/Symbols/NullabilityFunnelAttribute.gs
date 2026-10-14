// <copyright file="NullabilityFunnelAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System

/// ADR-0193 §3 (GSA0007): marks a member that is part of the producer
/// funnel, and so may call the conversion doors ((cref:TypeSymbol.FromClrType),
/// the `MemberLookup.MapOpenClrTypeToSymbolic` overloads,
/// (cref:ImportedTypeSymbol.Get(Type)), and
/// (cref:ClrNullability)'s `ReadNullableFlags` /
/// `ClassifyFlag` / `ClassifyPosition`).
///
/// The exemption is <b>per member, never per type</b>: other members of the
/// same type are checked like any other code. Adding this attribute is the
/// reviewed exception issue #4363 asks for. The analyzer's tests pin the
/// full list of attributed members, so a new one fails a test until that
/// list is updated. Inside a funnel member other than
/// (cref:NullabilityImportRule)'s, a direct
/// (cref:NullableTypeSymbol.Get) or (cref:PlatformTypeSymbol.Get)
/// call is still reported: classified positions resolve through the rule.
///
/// Lambdas and local functions inside an attributed member are part of it.
@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor, Inherited = false)
internal class NullabilityFunnelAttribute : Attribute { }
