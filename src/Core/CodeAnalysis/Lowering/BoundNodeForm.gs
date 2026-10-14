// <copyright file="BoundNodeForm.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols

/// Reads the members of a bound node that only one of the node's construction
/// forms omits, from a pass that has already excluded that form.
/// @remarks Several bound nodes are discriminated unions over their constructors, and
/// a member one form omits is declared nullable for that reason alone.
/// `BoundFieldAccessExpression.StructType` is null only in the interface
/// static-field form (ADR-0089 / #1030), which also has no receiver;
/// `BoundIndexAssignmentExpression.Target` is null only in the
/// expression-target form (#2488), which sets `TargetExpression` instead.
/// The two nulls in each pair always travel together, but the compiler cannot
/// correlate two properties, so a pass that has already excluded one form
/// still sees the other's member as maybe-null.
///
/// Every lowering pass hits this, so each invariant is stated once here rather
/// than re-argued at a dozen call sites (ADR-0155 amendment A7). Use these
/// helpers <em>only</em> after excluding the other form — by testing the
/// receiver, the target expression, or `InterfaceType` itself.
///
/// A pass that rebuilds a node <em>without</em> making that distinction is a
/// different matter, and these helpers are the wrong tool for it: it must
/// branch and reconstruct through the matching constructor, or it silently
/// drops the discriminator. Three rewriters that did not are issue #3333.
internal shared class BoundNodeForm {
    private const DeclaringTypeBecause string = "a field node with a receiver is a struct/class access, whose constructor requires a declaring type; " +
        "only the interface static-field form leaves StructType null, and that form has no receiver"
    private const TargetBecause string = "this is the variable-target form: the expression-target form was excluded by testing TargetExpression"

    /// Gets the declaring struct/class type of a field read that is not the
    /// interface static-field form.
    /// @param node The field read, already known not to be the
    /// interface static-field form.
    /// @returns The declaring type.
    func DeclaringType(node BoundFieldAccessExpression) StructSymbol -> Invariant.Required(
        node.StructType,
        DeclaringTypeBecause,
        expression: "node.StructType"
    )

    /// Gets the declaring struct/class type of a field write that is not the
    /// interface static-field form.
    /// @param node The field write, already known not to be the
    /// interface static-field form.
    /// @returns The declaring type.
    func DeclaringType(node BoundFieldAssignmentExpression) StructSymbol -> Invariant.Required(
        node.StructType,
        DeclaringTypeBecause,
        expression: "node.StructType"
    )

    /// Gets the variable target of an index write already known to be in the
    /// variable-target form.
    /// @param node The index write, already known not to be the
    /// expression-target form.
    /// @returns The target variable.
    func VariableTarget(node BoundIndexAssignmentExpression) VariableSymbol -> Invariant.Required(
        node.Target,
        TargetBecause,
        expression: "node.Target"
    )

    /// Gets the variable target of a CLR indexer write already known to be in
    /// the variable-target form.
    /// @param node The indexer write, already known not to be the
    /// expression-target form.
    /// @returns The target variable.
    func VariableTarget(node BoundClrIndexAssignmentExpression) VariableSymbol -> Invariant.Required(
        node.Target,
        TargetBecause,
        expression: "node.Target"
    )
}
