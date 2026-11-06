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
    // GSA0005: The rebuild sits inside `node.Receiver != null`, so this is the
    // variable-receiver form; every other form falls through to base.
    @SuppressDiagnostic("GSA0005")
    protected open override func RewriteFieldAssignmentExpression(node BoundFieldAssignmentExpression) BoundExpression {
        if node.Receiver != nil && this.fieldMap.TryGetValue(node.Receiver, out var proxyField) {
            let receiverExpr = this.FieldRead(proxyField)
            let value = this.RewriteExpression(node.Value)
            return BoundFieldAssignmentExpression.WithExpressionReceiver(
                nil,
                receiverExpr,
                BoundNodeForm.DeclaringType(node),
                node.Field,
                value,
                node.ResultType
            )
        }
        return base.RewriteFieldAssignmentExpression(node)
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

    protected open override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
        let result = cast[BoundTryStatement](base.RewriteTryStatement(node))
        var needsCatchPatch = false
        for clause in result.CatchClauses {
            if clause.Variable is {} variable && this.fieldMap.ContainsKey(variable) {
                needsCatchPatch = true
                break
            }
        }
        if !needsCatchPatch {
            return result
        }
        let patchedClauses = ImmutableArray.CreateBuilder[BoundCatchClause](result.CatchClauses.Length)
        for clause in result.CatchClauses {
            if clause.Variable is {} variable && this.fieldMap.TryGetValue(variable, out var field) {
                let copyToField = BoundExpressionStatement(
                    nil,
                    this.FieldWrite(field, BoundVariableExpression(nil, variable))
                )
                if clause.Filter is {} existingFilter {
                    let patchedFilter = if existingFilter is BoundBlockExpression existingBlock {
                        BoundBlockExpression(
                            nil,
                            ImmutableArray.Create[BoundStatement](copyToField).AddRange(existingBlock.Statements),
                            existingBlock.Expression
                        )
                    } else {
                        BoundBlockExpression(nil, ImmutableArray.Create[BoundStatement](copyToField), existingFilter)
                    }
                    patchedClauses.Add(clause.Update(patchedFilter, clause.Body))
                } else {
                    let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
                    stmts.Add(copyToField)
                    if clause.Body is BoundBlockStatement block {
                        stmts.AddRange(block.Statements)
                    } else {
                        stmts.Add(clause.Body)
                    }
                    patchedClauses.Add(clause.WithBody(BoundBlockStatement(nil, stmts.ToImmutable())))
                }
            } else {
                patchedClauses.Add(clause)
            }
        }
        return BoundTryStatement(result.Syntax, result.TryBlock, patchedClauses.ToImmutable(), result.FinallyBlock)
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
