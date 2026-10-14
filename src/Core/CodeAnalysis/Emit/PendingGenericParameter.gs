// <copyright file="PendingGenericParameter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Reflection
import System.Reflection.Metadata

/// A deferred `GenericParam` table row queued by
/// (cref:TypeDefEmitter.EmitGenericParamRows) and flushed in sorted order
/// before PE serialisation per ECMA-335 II.22.20 (the `GenericParam` table
/// must be sorted by (Owner, Number)).
/// @param Owner Coded TypeOrMethodDef parent (TypeDef or MethodDef).
/// @param Attributes Generic-parameter attributes (variance, constraints).
/// @param Name Source name of the type parameter.
/// @param Index Zero-based position in the owner's type-parameter list.
/// @param InterfaceConstraintType Issue #943: the imported CLR interface type (constructed-generic such
/// as
/// `IComparable[T]`, or non-generic) the parameter is constrained to,
/// requiring a matching `GenericParamConstraint` row, or
/// `null` when the parameter carries no CLR interface
/// constraint. (G# static-virtual sealed-interface constraints, ADR-0089, are
/// not emitted here.)
/// @param HasUnmanagedConstraint Issue #1336: `true` when the type parameter carries an
/// `unmanaged` constraint, requiring an additional
/// `GenericParamConstraint` row to `System.ValueType` decorated with
/// a required custom modifier of
/// `System.Runtime.InteropServices.UnmanagedType`.
/// @param PreResolvedConstraintHandle Issue #2118: a pre-resolved `TypeDefOrRefOrSpec` handle for the
/// interface constraint, resolved eagerly while an emit-time context (such as a
/// generic-promoted lambda's type-parameter remap) was active. When present it
/// is used verbatim by (cref:TypeDefEmitter.FlushPendingGenericParameters)
/// instead of re-resolving (cref:InterfaceConstraintType) at flush time
/// (when the context is gone), so the constraint encodes the method's own
/// `MVar` slots rather than the enclosing parameter it textually references.
internal data struct PendingGenericParameter(
    Owner EntityHandle,
    Attributes GenericParameterAttributes,
    Name string,
    Index uint16,
    InterfaceConstraintType TypeSymbol?,
    HasUnmanagedConstraint bool = false,
    PreResolvedConstraintHandle EntityHandle? = nil
) : IEquatable[PendingGenericParameter] { }
