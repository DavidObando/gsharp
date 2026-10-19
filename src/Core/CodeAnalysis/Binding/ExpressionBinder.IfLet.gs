// <copyright file="ExpressionBinder.IfLet.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Collections.Immutable

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
        // The bindings live in their own scope so they are invisible to the
        // else branch (ADR-0071: bindings are then-only). `narrowing` is the
        // single smart-cast frame every binding is added to as it succeeds, so
        // a later initializer, the guard, and the then-block all observe the
        // earlier bindings at their non-null underlying types.
        $scope = BoundScope($scope)
        let narrowing = Dictionary[AccessPath, TypeSymbol]()
        binderCtx.BeginNarrowingProof(narrowing)
        binderCtx.NarrowedVariables.Add(narrowing)
        let bound = ImmutableArray.CreateBuilder[
            (Syntax IfLetBindingClauseSyntax, Variable VariableSymbol, Initializer BoundExpression)
        ]()
        var anyInvalid = false
        var guard_ BoundExpression? = nil
        var whenTrue BoundExpression
        let BindInitializer = func (initializer ExpressionSyntax) BoundExpression {
            return BindExpression(initializer)
        }
        try {
            for binding in syntax.Bindings {
                let clause = IfLetBindingSupport.BindBindingClause(
                    binding,
                    Diagnostics,
                    conversions,
                    bindTypeClause,
                    BindInitializer,
                    DeclareIfLetLocal
                )
                if !clause.IsValid {
                    anyInvalid = true
                    continue
                }
                narrowing[clause.Variable] = Invariant.Required(
                    clause.Underlying,
                    "a valid if-let binding has an underlying type",
                    expression: "clause.Underlying"
                )
                bound.Add((binding, clause.Variable, clause.Initializer))
            }
            if syntax.Guard != nil {
                guard_ = BindExpression(syntax.Guard, TypeSymbol.Bool)
            }
            whenTrue = BindBlockExpressionValue(syntax.ThenBlock, canBeVoid, targetType)
        } finally {
            binderCtx.EndNarrowingProof()
            $scope = $scope.Pop()
        }
        // Bound AFTER the binding scope/frame is popped: the else branch never
        // sees the bindings.
        var whenFalse = BindIfLetElseBranch(syntax.ElseExpression!!, canBeVoid, targetType)
        if anyInvalid ||
            bound.Count == 0 ||
            guard_ is BoundErrorExpression ||
            whenTrue is BoundErrorExpression ||
            whenFalse is BoundErrorExpression {
            return BoundErrorExpression(nil)
        }
        if IsVoidInDiscardedPosition(canBeVoid, []BoundExpression{whenTrue, whenFalse}) {
            // ADR-0202: the void if-let, as for the plain if-expression.
            return BoundConditionalExpression(
                nil,
                Invariant.Required(
                    BuildIfLetCondition(bound.ToImmutable(), 0, guard_),
                    "a valid if-let expression has at least one binding",
                    expression: "BuildIfLetCondition(bound.ToImmutable(), 0, guard)"
                ),
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
        let convertedTrue = ConvertConditionalBranch(syntax.ThenBlock.Location, whenTrue, resultType)
        let convertedFalse = ConvertConditionalBranch(syntax.ElseExpression!!.Location, whenFalse, resultType)
        if convertedTrue is BoundErrorExpression || convertedFalse is BoundErrorExpression {
            if deferOnFailure {
                Diagnostics.TruncateTo(diagMark)
                return BoundErrorExpression(syntax)
            }
            return BoundErrorExpression(nil)
        }
        let condition = Invariant.Required(
            BuildIfLetCondition(bound.ToImmutable(), 0, guard_),
            "a valid if-let expression has at least one binding",
            expression: "BuildIfLetCondition(bound.ToImmutable(), 0, guard)"
        )
        return BoundConditionalExpression(nil, condition, convertedTrue, convertedFalse, resultType)
    }

    /// Declares one ADR-0151 binding local. Routed through the same
    /// `DeclarationBinder.BindVariableDeclaration` callback the statement
    /// forms use, so duplicate-name reporting (GS0004) and the top-level
    /// global-variable shaping behave identically on both surfaces.
    private func DeclareIfLetLocal(identifier SyntaxToken, isReadOnly bool, type TypeSymbol) VariableSymbol {
        if bindLocalVariable != nil {
            return bindLocalVariable(identifier, isReadOnly, type)
        }
        // Defensive: an ExpressionBinder constructed without the declaration
        // callback (no production path does this) still produces a usable
        // symbol so binding can continue and report the real diagnostics.
        let fallback = LocalVariableSymbol(identifier.ValueText ?? "?", isReadOnly, type, declaringSyntax: identifier)
        $scope.TryDeclareVariable(fallback)
        return fallback
    }

    /// Builds the boolean condition that declares each binding in turn and
    /// short-circuits on the first `nil`. See
    /// (cref:BindIfLetExpression) for the produced shape.
    private func BuildIfLetCondition(
        bindings ImmutableArray[
            (Syntax IfLetBindingClauseSyntax, Variable VariableSymbol, Initializer BoundExpression)
        ],
        index int32,
        $guard BoundExpression?
    ) BoundExpression {
        let (bindingSyntax, variable, initializer) = bindings[index]
        let declaration = BoundVariableDeclaration(bindingSyntax, variable, initializer)
        let test = Invariant.Required(
            IfLetBindingSupport.BuildNilCheckChain(bindingSyntax, []VariableSymbol{variable}),
            "an if-let binding condition has a nil check",
            expression: "IfLetBindingSupport.BuildNilCheckChain(bindingSyntax, new[] { variable })"
        )
        var value BoundExpression
        if index == bindings.Length - 1 {
            value = if $guard == nil {
                test
            } else {
                cast[BoundExpression](
                    BoundConditionalExpression(
                        nil,
                        test,
                        $guard,
                        BoundLiteralExpression(bindingSyntax, false, TypeSymbol.Bool),
                        TypeSymbol.Bool
                    )
                )
            }
        } else {
            value = BoundConditionalExpression(
                nil,
                test,
                BuildIfLetCondition(bindings, index + 1, $guard),
                BoundLiteralExpression(bindingSyntax, false, TypeSymbol.Bool),
                TypeSymbol.Bool
            )
        }
        return BoundBlockExpression(nil, ImmutableArray.Create[BoundStatement](declaration), value)
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
