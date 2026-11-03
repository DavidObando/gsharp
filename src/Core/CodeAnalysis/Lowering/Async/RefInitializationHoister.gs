// <copyright file="RefInitializationHoister.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// Lowering pass that eliminates `ref` locals (managed pointer locals) from
/// async method bodies so they do not require hoisting into byref fields — which
/// the CLR forbids on heap-allocated or state-machine types.
/// @remarks A ref local is identified by its type being (cref:ByRefTypeSymbol)
/// and its initializer being a (cref:BoundAddressOfExpression). The hoister
/// recomputes the managed pointer at every use site:
///
/// - `*refLocal` (dereference read) → replaced with the underlying lvalue expression.
/// - `refLocal` (bare pointer usage, e.g., passed to ref parameter) → replaced with `&lvalue`.
///
/// To avoid duplicating side effects (issue #418 / P1-12), any
/// non-trivial sub-expression of the original ref initializer (call receiver,
/// index expression, etc.) is evaluated <em>once</em> into a hoisted temporary
/// local at the ref-initialization site. The reconstructed lvalue then refers
/// only to those temporaries and other side-effect-free leaves (variables,
/// parameters, literals), making it safe to inline at every use site. The
/// constituent variables are themselves later hoisted into state-machine
/// fields by (cref:AsyncCaptureWalker) if they cross an await.
///
/// A reconstructed field or element address is also probed once at the
/// original declaration site. This preserves null and bounds exceptions before
/// a later suspension while still avoiding an illegal managed-pointer
/// state-machine field.
///
/// This pass runs after (cref:SpillSequenceSpiller) and before
/// (cref:AsyncStateMachineTypeBuilder) in the async pipeline.
/// Opaque borrowed addresses remain MoveNext locals only when the shared
/// suspension-liveness analysis proves they do not cross a suspension.
shared class RefInitializationHoister {
    private class Rewriter : BoundTreeRewriter {
        private let refLocals Dictionary[LocalVariableSymbol, BoundExpression]
        private var tempCounter int32

        init(refLocals Dictionary[LocalVariableSymbol, BoundExpression]) {
            this.refLocals = refLocals
        }

        protected override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
            // Replace ref local declarations with component captures plus any
            // required field/element address probe. The rewritten template —
            // referencing only captured temps and repeatable storage — is
            // recorded for use-site reconstruction.
            let local = node.Variable as LocalVariableSymbol
            let addressOf BoundAddressOfExpression? = node.Initializer as BoundAddressOfExpression
            if local != nil && local.Type is ByRefTypeSymbol && addressOf != nil && refLocals.ContainsKey(local) {
                let prelude = ImmutableArray.CreateBuilder[BoundStatement]()
                let template = HoistOperand(addressOf.Operand, prelude, captureComponents: true)
                if (
                    template is BoundTupleElementAccessExpression or
                        BoundIndexExpression or
                        BoundFieldAccessExpression and
                        {Receiver: not nil} or
                        BoundClrPropertyAccessExpression{Member: FieldInfo, Receiver: not nil} or
                        BoundDereferenceExpression{Operand: BoundConditionalAddressExpression}
                ) {
                    prelude.Add(
                        BoundExpressionStatement(node.Syntax, BoundAddressOfExpression(addressOf.Syntax, template))
                    )
                }
                refLocals[local] = template
                return BoundBlockStatement(nil, prelude.ToImmutable())
            }
            return base.RewriteVariableDeclaration(node)
        }

        protected override func RewriteDereferenceExpression(node BoundDereferenceExpression) BoundExpression {
            // *refLocal → reconstructed lvalue template.
            if node.Operand is BoundVariableExpression varExpr &&
                varExpr.Variable is LocalVariableSymbol local &&
                refLocals
                .TryGetValue(local, out var template) {
                // The template only references hoisted temps and trivially
                // repeatable leaves, so no further rewriting is required and
                // every inlining is side-effect-free.
                return template
            }
            return base.RewriteDereferenceExpression(node)
        }

        protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
            // Bare ref local usage (e.g., passed to a ref parameter) → &lvalue.
            if node.Variable is LocalVariableSymbol local && refLocals.TryGetValue(local, out var template) {
                return BoundAddressOfExpression(nil, template)
            }
            return base.RewriteVariableExpression(node)
        }

        protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
            // Re-seating the ref local itself (refLocal = &newTarget): replace
            // the template with the new target's hoisted form. This case is
            // unlikely in V1 but handle it gracefully.
            if node.Variable is LocalVariableSymbol local && refLocals.ContainsKey(local) {
                if node.Expression is BoundAddressOfExpression newAddr {
                    // Re-seating mid-method: any side effects in the new
                    // operand must execute exactly once at this point. We
                    // cannot inject statements from inside an expression
                    // rewrite, so fall back to inlining the (already-rewritten)
                    // operand directly. Spilling earlier in the pipeline will
                    // already have flattened complex re-seats, so in practice
                    // the operand is simple.
                    refLocals[local] = RewriteExpression(newAddr.Operand)
                }
                return BoundLiteralExpression(nil, 0)
            }
            return base.RewriteAssignmentExpression(node)
        }

        /// Reconstructs [`operand`](paramref) as a side-effect-free
        /// template, emitting hoisting declarations into
        /// [`prelude`](paramref) for any non-trivial sub-expression.
        private func HoistOperand(
            operand BoundExpression,
            prelude ImmutableArray[BoundStatement].Builder,
            captureComponents bool = false
        ) BoundExpression {
            if RefCapabilities.IsRefReturningAccess(operand) {
                throw System.InvalidOperationException(
                    "Opaque ref-returning storage must be rejected before async address reconstruction."
                )
            }
            switch operand {
                case BoundDereferenceExpression{Operand: BoundAddressOfExpression address} {
                    return HoistOperand(address.Operand, prelude, captureComponents: true)
                }
                case tuple is BoundTupleElementAccessExpression {
                    // Later arguments can replace an owner or index before address reconstruction.
                    return BoundTupleElementAccessExpression(
                        tuple.Syntax,
                        HoistOperand(tuple.Receiver, prelude, captureComponents: true),
                        tuple.TupleType,
                        tuple.Index
                    )
                }
                case idx is BoundIndexExpression {
                    {
                        let target = HoistIfNeeded(idx.Target, prelude, captureComponents)
                        let indices = idx
                            .Indices
                            .Select((index BoundExpression) -> HoistIfNeeded(index, prelude, captureComponents))
                            .ToImmutableArray()
                        return BoundIndexExpression(idx.Syntax, target, indices, idx.Type)
                    }
                }
                case field is BoundFieldAccessExpression {
                    {
                        if field.Receiver == nil {
                            // A static or interface static-field read (ADR-0089 /
                            // #1030) has no receiver expression to hoist, and
                            // rebuilding it through the receiver constructor would
                            // drop InterfaceType -- the #3333 failure shape. The
                            // base BoundTreeRewriter bails the same way.
                            return field
                        }
                        let receiver = if Binder.IsReferenceTypeForConstraint(field.Receiver.Type) ||
                            !IsReconstructableStorage(field.Receiver) {
                            HoistIfNeeded(field.Receiver, prelude, captureComponents)
                        } else {
                            HoistOperand(field.Receiver, prelude, captureComponents)
                        }
                        return BoundFieldAccessExpression(
                            field.Syntax,
                            receiver,
                            BoundNodeForm.DeclaringType(field),
                            field.Field,
                            field.SubstitutedType,
                            field.NarrowedType
                        )
                    }
                }
                case clrIdx is BoundClrIndexExpression {
                    {
                        let target = HoistIfNeeded(clrIdx.Target, prelude)
                        let args = ImmutableArray.CreateBuilder[BoundExpression](clrIdx.Arguments.Length)
                        for arg in clrIdx.Arguments {
                            args.Add(HoistIfNeeded(arg, prelude))
                        }
                        return BoundClrIndexExpression(
                            clrIdx.Syntax,
                            target,
                            clrIdx.Indexer,
                            args.MoveToImmutable(),
                            clrIdx.Type,
                            clrIdx.ConstrainedReceiverTypeParameter,
                            clrIdx.ConstrainedInterfaceType
                        )
                    }
                }
                case clrProp is BoundClrPropertyAccessExpression when clrProp.Receiver != nil {
                    {
                        let owner = clrProp.Receiver!!
                        let receiver = if clrProp.Member is FieldInfo && !Binder.IsReferenceTypeForConstraint(
                            owner.Type
                        ) &&
                            IsReconstructableStorage(owner) {
                            HoistOperand(owner, prelude, captureComponents)
                        } else {
                            HoistIfNeeded(owner, prelude, captureComponents)
                        }
                        return BoundClrPropertyAccessExpression(
                            clrProp.Syntax,
                            receiver,
                            clrProp.Member,
                            clrProp.Type,
                            clrProp.StaticContainerType,
                            clrProp.ConstrainedReceiverTypeParameter,
                            clrProp.ConstrainedInterfaceType,
                            clrProp.IsAddressableStaticField,
                            clrProp.IsReadOnlySubmissionGlobal
                        )
                    }
                }
                case BoundDereferenceExpression{Operand: BoundConditionalAddressExpression address} dereference {
                    let condition = HoistIfNeeded(address.Condition, prelude, forceCapture: true)
                    let truePrelude = ImmutableArray.CreateBuilder[BoundStatement]()
                    let whenTrue = HoistOperand(address.WhenTrueOperand, truePrelude, captureComponents: true)
                    let falsePrelude = ImmutableArray.CreateBuilder[BoundStatement]()
                    let whenFalse = HoistOperand(address.WhenFalseOperand, falsePrelude, captureComponents: true)
                    if truePrelude.Count != 0 {
                        let skip = BoundLabel("<refSkip>__${tempCounter++}")
                        prelude.Add(BoundConditionalGotoStatement(nil, skip, condition, jumpIfTrue: false))
                        prelude.AddRange(truePrelude)
                        prelude.Add(BoundLabelStatement(nil, skip))
                    }
                    if falsePrelude.Count != 0 {
                        let skip = BoundLabel("<refSkip>__${tempCounter++}")
                        prelude.Add(BoundConditionalGotoStatement(nil, skip, condition, jumpIfTrue: true))
                        prelude.AddRange(falsePrelude)
                        prelude.Add(BoundLabelStatement(nil, skip))
                    }
                    return BoundDereferenceExpression(
                        dereference.Syntax,
                        BoundConditionalAddressExpression(
                            address.Syntax,
                            condition,
                            whenTrue,
                            whenFalse,
                            address.PointeeType
                        )
                    )
                }
                case dereference is BoundDereferenceExpression {
                    return BoundDereferenceExpression(dereference.Syntax, HoistIfNeeded(dereference.Operand, prelude))
                }
                default {
                    if operand.Type is ByRefTypeSymbol && operand is not BoundVariableExpression {
                        throw System.InvalidOperationException(
                            "Opaque ref-returning storage must be rejected before async address reconstruction."
                        )
                    }
                    // Other operands are repeatable leaves or already spilled storage.
                    return operand
                }
            }
        }

        /// Returns [`expression`](paramref) unchanged when it is trivially
        /// repeatable; otherwise emits a fresh local declaration into
        /// [`prelude`](paramref) and returns a read of that local.
        private func HoistIfNeeded(
            expression BoundExpression,
            prelude ImmutableArray[BoundStatement].Builder,
            forceCapture bool = false
        ) BoundExpression {
            if !forceCapture && RefInitializationHoister.IsTriviallyRepeatable(expression) {
                return expression
            }
            let temp = LocalVariableSymbol("<refTmp>__${tempCounter++}", isReadOnly: false, expression.Type)
            prelude.Add(BoundVariableDeclaration(nil, temp, expression))
            return BoundVariableExpression(nil, temp)
        }

        shared {
            private func IsReconstructableStorage(expression BoundExpression) bool {
                return switch expression {
                    case tuple is BoundTupleElementAccessExpression: IsReconstructableStorage(tuple.Receiver)
                    case BoundClrPropertyAccessExpression{Member: FieldInfo, Receiver: nil}: true
                    case BoundClrPropertyAccessExpression{
                        Member: FieldInfo,
                        Receiver: {} receiver
                    }: Binder.IsReferenceTypeForConstraint(receiver.Type) || IsReconstructableStorage(receiver)
                    case _ is BoundVariableExpression: true
                    case _ is BoundDereferenceExpression: true
                    case _ is BoundIndexExpression: true
                    case boundFieldAccessExpression is BoundFieldAccessExpression when boundFieldAccessExpression.Receiver == nil: true
                    case BoundFieldAccessExpression{Receiver: {} receiver}: Binder.IsReferenceTypeForConstraint(
                        receiver.Type
                    ) ||
                        IsReconstructableStorage(receiver)
                    default: false
                }
            }
        }
    }

    /// Rewrites [`body`](paramref) by reconstructing ref locals where possible.
    /// @param body The spilled async method body.
    /// @returns The rewritten body, preserving opaque ref locals only within a suspension-free lifetime.
    func Rewrite(body BoundBlockStatement) BoundBlockStatement {
        // First pass: collect ref local declarations (we still need to know
        // which locals are ref so the rewriter can recognize their uses). The
        // operand template is computed in the second pass at the declaration
        // site itself, where we also emit the hoisting prelude.
        let refLocals = Dictionary[LocalVariableSymbol, BoundExpression]()
        if !CollectRefLocals(body, refLocals) {
            return body
        }
        let crossing = RefStructAsyncLivenessAnalyzer.FindLocalsLiveAcrossSuspension(
            body,
            refLocals.Keys.Cast[VariableSymbol]()
        )
        for local in refLocals.Keys.ToArray() {
            if !crossing.Contains(local) && RefCapabilities.IsBorrowedLocation(refLocals[local]) {
                // Keep an opaque address in a MoveNext local when no suspension needs it.
                refLocals.Remove(local)
            }
        }
        if refLocals.Count == 0 {
            return body
        }
        // Second pass: rewrite the tree. The rewriter replaces each ref local
        // declaration with a block containing the hoisting prelude and updates
        // the refLocals mapping to point at the side-effect-free template
        // expression that re-derives the lvalue from hoisted temporaries.
        let rewriter = RefInitializationHoister.Rewriter(refLocals)
        let result = cast[BoundBlockStatement](rewriter.RewriteStatement(body))
        return result
    }

    private func CollectRefLocals(
        statement BoundStatement,
        refLocals Dictionary[LocalVariableSymbol, BoundExpression]
    ) bool {
        var found = false
        if statement is BoundBlockStatement block {
            for stmt in block.Statements {
                found |= CollectRefLocals(stmt, refLocals)
            }
        } else if statement is BoundVariableDeclaration decl {
            let local = decl.Variable as LocalVariableSymbol
            let addressOf BoundAddressOfExpression? = decl.Initializer as BoundAddressOfExpression
            if local?.Type is ByRefTypeSymbol && addressOf != nil {
                // Seed with the raw operand; the rewriter replaces this with the
                // hoisted template when it visits the declaration.
                refLocals[local!!] = addressOf.Operand
                found = true
            }
        } else if statement is BoundIfStatement ifStmt {
            found |= CollectRefLocals(ifStmt.ThenStatement, refLocals)
            if ifStmt.ElseStatement != nil {
                found |= CollectRefLocals(ifStmt.ElseStatement, refLocals)
            }
        } else if statement is BoundTryStatement tryStmt {
            found |= CollectRefLocals(tryStmt.TryBlock, refLocals)
            for clause in tryStmt.CatchClauses {
                found |= CollectRefLocals(clause.Body, refLocals)
            }
            if tryStmt.FinallyBlock != nil {
                found |= CollectRefLocals(tryStmt.FinallyBlock, refLocals)
            }
        }
        return found
    }

    /// Returns `true` when [`expression`](paramref) can
    /// be re-evaluated arbitrarily many times without observable side effects
    /// and without re-running user code: pure leaves like variable reads,
    /// parameter reads, literals, and the implicit `this`/state-machine
    /// receiver. Anything else (calls, indexers, field/property reads, casts,
    /// arithmetic, etc.) is hoisted into a temporary.
    private func IsTriviallyRepeatable(expression BoundExpression) bool {
        return expression is BoundVariableExpression || expression is BoundLiteralExpression
    }
}
