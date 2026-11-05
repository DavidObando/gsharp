// <copyright file="ExpressionBinder.IfLet.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// ```xmldoc
/// <content>
/// ADR-0151: the value-producing <c>if let</c> EXPRESSION. It combines the
/// ADR-0071 nullable-binding header (shared with the statement form through
/// <see cref="IfLetBindingSupport" />) with the ADR-0064 if-expression branch
/// typing rules, and lowers entirely into the existing
/// <see cref="BoundBlockExpression" /> / <see cref="BoundConditionalExpression" />
/// pair — no new bound-node kind, no emitter or interpreter special case.
/// </content>
/// ```
internal partial class ExpressionBinder {
    /// ADR-0151: binds
    /// `if let a = e [, let b = e2]* [&& guard] { value } else { value }`.
    /// @remarks The lowered shape for `if let a = e0, let b = e1 && g { T } else { F }` is shown below.
    ///
    /// ```
    /// ({ let a = e0 } → a != nil ? ({ let b = e1 } → b != nil ? g : false) : false)
    /// ? T
    /// : F
    /// ```
    ///
    /// Each initializer therefore sits inside the arm that is only reached once
    /// every earlier binding matched, which is what gives ADR-0151's
    /// left-to-right short-circuit both under the interpreter (a
    /// (cref:BoundConditionalExpression) evaluates only the selected arm)
    /// and under IL emit (it branches). A `&&` chain could NOT be
    /// used for the same purpose: `Evaluator.EvaluateBinaryExpression`
    /// evaluates both operands of a logical operator before combining them.
    ///
    /// The then/else branches each appear exactly ONCE in the produced tree.
    /// Reusing a single bound-node instance in two positions would alias the
    /// emitter's identity-keyed slot dictionaries (see
    /// `SlotDictionaryAliasingAssertionTests`), so the nesting is put in
    /// the CONDITION rather than duplicating the arms per binding.
    private func BindIfLetExpression(
        syntax IfLetExpressionSyntax,
        targetType TypeSymbol?,
        canBeVoid bool = false
    ) BoundExpression {
        // Issue #1238 parity with BindIfExpression: a bare branchy argument
        // awaiting its parameter target type defers a no-common-type failure
        // instead of reporting it. Consume the flag immediately so nested
        // sub-expressions bind normally.
        let deferOnFailure = targetType == nil && binderCtx.DeferTargetlessConditional
        this.binderCtx.DeferTargetlessConditional = false
        let diagMark = Diagnostics.Count
        // ADR-0151: `else` is mandatory in value position, exactly as for the
        // ADR-0064 if-expression (GS0276).
        if syntax.ElseExpression == nil {
            Diagnostics.ReportIfExpressionMissingElse(syntax.IfKeyword.Location)
            return BoundErrorExpression(nil)
        }
        return bindDeferrableConditional(
            syntax,
            deferOnFailure,
            () -> BindIfLetExpressionCore(syntax, targetType, canBeVoid, deferOnFailure, diagMark)
        )
    }

    private func BindIfLetExpressionCore(
        syntax IfLetExpressionSyntax,
        targetType TypeSymbol?,
        canBeVoid bool,
        deferOnFailure bool,
        diagMark int32
    ) BoundExpression {
        // Issue #4961 / ADR-0201: the bindings, the guard, and the branches
        // are bound through the header helper the STATEMENT form shares, so
        // scoping (then-region only, never the else branch), progressive
        // narrowing, and the guard rules cannot drift between the forms.
        var (clauses, guard_, whenTrue, whenFalse) = bindIfLetBranches(
            syntax.Bindings,
            syntax.Guard,
            true,
            syntax.ThenBlock,
            () -> BindBlockExpressionValue(syntax.ThenBlock, canBeVoid, targetType),
            () -> BindIfLetElseBranch(syntax.ElseExpression!!, canBeVoid, targetType)
        )
        var anyInvalid = false
        for clause in clauses {
            if !clause.Binding.IsValid {
                anyInvalid = true
            }
        }
        if anyInvalid ||
            clauses.Length == 0 ||
            guard_ is BoundErrorExpression ||
            whenTrue is BoundErrorExpression ||
            whenFalse is BoundErrorExpression {
            return BoundErrorExpression(nil)
        }
        let condition = IfLetBindingSupport.BuildShortCircuitCondition(clauses, 0, guard_)
        if IsVoidInDiscardedPosition(canBeVoid, []BoundExpression{whenTrue, whenFalse}) {
            // ADR-0202: the void if-let, as for the plain if-expression.
            return BoundConditionalExpression(
                nil,
                condition,
                DiscardValue(whenTrue),
                DiscardValue(whenFalse),
                TypeSymbol.Void
            )
        }
        TryAdaptConditionalIntegerLiteralArm(&whenTrue, &whenFalse)
        let resultType TypeSymbol? = ComputeConditionalResultType(whenTrue.Type, whenFalse.Type, targetType)
        if resultType == nil {
            if deferOnFailure {
                Diagnostics.TruncateTo(diagMark)
                return BoundErrorExpression(syntax)
            }
            Diagnostics.ReportConditionalNoCommonResultType(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?"
            )
            return BoundErrorExpression(nil)
        }
        let convertedTrue = ConvertConditionalBranch(BranchValueLocation(syntax.ThenBlock), whenTrue, resultType)
        let convertedFalse = ConvertConditionalBranch(
            BranchValueLocation(syntax.ElseExpression!!),
            whenFalse,
            resultType
        )
        if convertedTrue is BoundErrorExpression || convertedFalse is BoundErrorExpression {
            if deferOnFailure {
                Diagnostics.TruncateTo(diagMark)
                return BoundErrorExpression(syntax)
            }
            return BoundErrorExpression(nil)
        }
        return BoundConditionalExpression(nil, condition, convertedTrue, convertedFalse, resultType)
    }

    /// Binds the branch after `else`: a chained `else if` /
    /// `else if let`, or a plain block expression. Delegates to the
    /// ADR-0064 helper, which already recognises both chain kinds.
    private func BindIfLetElseBranch(
        elseSyntax ExpressionSyntax,
        canBeVoid bool,
        targetType TypeSymbol? = nil
    ) BoundExpression -> BindIfExpressionElseBranch(elseSyntax, canBeVoid, targetType)
}
