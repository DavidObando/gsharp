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
/// <param name="InterfaceConstraintType">
/// Issue #943: the imported CLR interface type (constructed-generic such as
/// <c>IComparable[T]</c>, or non-generic) the parameter is constrained to,
/// requiring a matching <c>GenericParamConstraint</c> row, or
/// <see langword="null"/> when the parameter carries no CLR interface
/// constraint. (G# static-virtual sealed-interface constraints, ADR-0089, are
/// not emitted here.)
/// </param>
/// <param name="HasUnmanagedConstraint">
/// Issue #1336: <see langword="true"/> when the type parameter carries an
/// <c>unmanaged</c> constraint, requiring an additional
/// <c>GenericParamConstraint</c> row to <c>System.ValueType</c> decorated with
/// a required custom modifier of
/// <c>System.Runtime.InteropServices.UnmanagedType</c>.
/// </param>
/// <param name="PreResolvedConstraintHandle">
/// Issue #2118: a pre-resolved <c>TypeDefOrRefOrSpec</c> handle for the
/// interface constraint, resolved eagerly while an emit-time context (such as a
/// generic-promoted lambda's type-parameter remap) was active. When present it
/// is used verbatim by <see cref="TypeDefEmitter.FlushPendingGenericParameters"/>
/// instead of re-resolving <see cref="InterfaceConstraintType"/> at flush time
/// (when the context is gone), so the constraint encodes the method's own
/// <c>MVar</c> slots rather than the enclosing parameter it textually references.
/// </param>
internal readonly record struct PendingGenericParameter(
    EntityHandle Owner,
    GenericParameterAttributes Attributes,
    string Name,
    ushort Index,
    GSharp.Core.CodeAnalysis.Symbols.TypeSymbol InterfaceConstraintType,
    bool HasUnmanagedConstraint = false,
    EntityHandle? PreResolvedConstraintHandle = null);
