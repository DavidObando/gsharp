// <copyright file="HoistedFieldRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Iterators

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Shared rewriter that maps hoisted local reads/writes to field accesses on
/// the synthesized state machine, using the supplied `this` parameter
/// (different per state-machine method). This is the single home for the
/// hoisted-variable-to-field rewriting rules accumulated by issues #618,
/// #641, #655, and #887, used by every MoveNext/Dispose body builder
/// (sync iterator, async iterator) so a fix here applies everywhere at once.
internal open class HoistedFieldRewriter : BoundTreeRewriter {
    protected let smClass StructSymbol
    protected let thisParameter ParameterSymbol
    protected let fieldMap Dictionary[VariableSymbol, FieldSymbol]

    init(smClass StructSymbol, thisParameter ParameterSymbol, fieldMap Dictionary[VariableSymbol, FieldSymbol]) {
        this.smClass = smClass
        this.thisParameter = thisParameter
        this.fieldMap = fieldMap
    }

    protected func FieldRead(field FieldSymbol) BoundExpression -> this.FieldRead(field, narrowedType: nil)

    // Issue #3501 (ilverify): a hoisted variable READ may carry an ADR-0069
    // smart-cast narrowing; the replacement field access must keep it so the
    // emitter's narrowing castclass still fires (the field itself stays at
    // the declared type).
    protected func FieldRead(field FieldSymbol, narrowedType TypeSymbol?) BoundExpression -> BoundFieldAccessExpression(
        nil,
        BoundVariableExpression(nil, this.thisParameter),
        this.smClass,
        field,
        narrowedType
    )

    protected func FieldWrite(
        field FieldSymbol,
        value BoundExpression
    ) BoundExpression -> BoundFieldAssignmentExpression(nil, this.thisParameter, this.smClass, field, value)

    protected open override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
        if this.fieldMap.TryGetValue(node.Variable, out var field) {
            return this.FieldRead(field, node.NarrowedType)
        }
        return node
    }

    protected open override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
        if this.fieldMap.TryGetValue(node.Variable, out var field) {
            return this.FieldWrite(field, this.RewriteExpression(node.Expression))
        }
        return base.RewriteAssignmentExpression(node)
    }

    // Issue #655: explicitly rewrite field-access expressions whose
    // receiver is a BoundVariableExpression referencing the user-class
    // `this` (hoisted as <>4__this). Ensures the proxy load is applied
    // directly, protecting against regressions.
    protected open override func RewriteFieldAccessExpression(node BoundFieldAccessExpression) BoundExpression {
        if node.Receiver is BoundVariableExpression varExpr && this.fieldMap.TryGetValue(
            varExpr.Variable,
            out var proxyField
        ) {
            let rewrittenReceiver = this.FieldRead(proxyField)
            return BoundFieldAccessExpression(
                nil,
                rewrittenReceiver,
                BoundNodeForm.DeclaringType(node),
                node.Field,
                node.SubstitutedType,
                node.NarrowedType
            )
        }
        return base.RewriteFieldAccessExpression(node)
    }

    // Issue #641: rewrite field assignments whose receiver is the
    // user-class `this` (hoisted as <>4__this) to use an expression
    // receiver so the emitter loads the proxy field.
    protected open override func RewriteFieldAssignmentExpression(node BoundFieldAssignmentExpression) BoundExpression {
        let value = this.RewriteExpression(node.Value)
        if node.Receiver != nil && this.fieldMap.TryGetValue(node.Receiver, out var proxyField) {
            let receiverExpr = this.FieldRead(proxyField)
            return BoundFieldAssignmentExpression.WithExpressionReceiver(
                nil,
                receiverExpr,
                BoundNodeForm.DeclaringType(node),
                node.Field,
                value,
                node.ResultType
            )
        }
        if node.ReceiverExpression != nil {
            let receiverExpr = this.RewriteExpression(node.ReceiverExpression)
            if !object.ReferenceEquals(value, node.Value) || !object.ReferenceEquals(
                receiverExpr,
                node.ReceiverExpression
            ) {
                return BoundFieldAssignmentExpression.WithExpressionReceiver(
                    nil,
                    receiverExpr,
                    BoundNodeForm.DeclaringType(node),
                    node.Field,
                    value,
                    node.ResultType
                )
            }
        } else if !object.ReferenceEquals(value, node.Value) {
            // Issue #3333 / #1644: an interface static field write has a null
            // Receiver and StructType, and carries the owning interface in
            // InterfaceType. Rebuilding it through the variable-receiver
            // constructor drops that, and the emitter parents the field at the
            // open-generic TypeDef instead of a TypeSpec. This override must
            // carry the same guard the base BoundTreeRewriter does.
            if node.InterfaceType != nil {
                return BoundFieldAssignmentExpression(nil, node.Field, node.InterfaceType, value, node.ResultType)
            }
            return BoundFieldAssignmentExpression(
                nil,
                node.Receiver,
                BoundNodeForm.DeclaringType(node),
                node.Field,
                value,
                node.ResultType
            )
        }
        return node
    }

    protected open override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
        if this.fieldMap.TryGetValue(node.Variable, out var field) {
            return BoundExpressionStatement(
                nil,
                this.FieldWrite(
                    field,
                    this.RewriteExpression(
                        Invariant.Required(
                            node.Initializer,
                            "a variable declaration has an initializer",
                            expression: "node.Initializer"
                        )
                    )
                )
            )
        }
        return base.RewriteVariableDeclaration(node)
    }

    // Issue #887: an index assignment (`arr[i] = v`, `m[k] = v`) whose
    // target temp is hoisted into a state-machine field can't reference the
    // field through its VariableSymbol target. Switch to the expression
    // target form reading the hoisted field (same fix as closure boxing,
    // issue #618).
    // GSA0005: The rebuild sits inside `node.Target != null`, so this is the
    // variable-target form; TargetExpression is null on this path and the
    // expression-target form falls through to base.
    @SuppressDiagnostic("GSA0005")
    protected open override func RewriteIndexAssignmentExpression(node BoundIndexAssignmentExpression) BoundExpression {
        if node.Target != nil && this.fieldMap.TryGetValue(node.Target, out var targetField) {
            return BoundIndexAssignmentExpression.WithExpressionTarget(
                nil,
                this.FieldRead(targetField),
                node.Indices.Select(this.RewriteExpression).ToImmutableArray(),
                this.RewriteExpression(node.Value),
                node.Type
            )
        }
        return base.RewriteIndexAssignmentExpression(node)
    }

    // Issue #887: same fix for CLR-indexer writes (e.g. `dict["k"] = v` or
    // `psi.Environment["k"] = v`) whose target temp is hoisted into a field.
    // GSA0005: Same as RewriteIndexAssignmentExpression: guarded by `node.Target !=
    // null`, so TargetExpression is null on the path that rebuilds.
    @SuppressDiagnostic("GSA0005")
    protected open override func RewriteClrIndexAssignmentExpression(
        node BoundClrIndexAssignmentExpression
    ) BoundExpression {
        if node.Target != nil && this.fieldMap.TryGetValue(node.Target, out var targetField) {
            return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                nil,
                this.FieldRead(targetField),
                node.Indexer,
                this.RewriteArguments(node.Arguments),
                this.RewriteExpression(node.Value),
                node.Type,
                node.ConstrainedReceiverTypeParameter,
                node.ConstrainedInterfaceType
            )
        }
        return base.RewriteClrIndexAssignmentExpression(node)
    }

    protected func RewriteArguments(arguments ImmutableArray[BoundExpression]) ImmutableArray[BoundExpression] {
        let builder = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
        for argument in arguments {
            builder.Add(this.RewriteExpression(argument))
        }
        return builder.MoveToImmutable()
    }
}
