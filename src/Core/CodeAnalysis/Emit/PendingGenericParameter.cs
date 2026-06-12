// <copyright file="PendingGenericParameter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using System.Reflection.Metadata;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// A deferred <c>GenericParam</c> table row queued by
/// <see cref="TypeDefEmitter.EmitGenericParamRows"/> and flushed in sorted order
/// before PE serialisation per ECMA-335 II.22.20 (the <c>GenericParam</c> table
/// must be sorted by (Owner, Number)).
/// </summary>
/// <param name="Owner">Coded TypeOrMethodDef parent (TypeDef or MethodDef).</param>
/// <param name="Attributes">Generic-parameter attributes (variance, constraints).</param>
/// <param name="Name">Source name of the type parameter.</param>
/// <param name="Index">Zero-based position in the owner's type-parameter list.</param>
internal readonly record struct PendingGenericParameter(
    EntityHandle Owner,
    GenericParameterAttributes Attributes,
    string Name,
    ushort Index);
