// <copyright file="IfLetBindingSupport.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable

/// ADR-0071 / issue #708, ADR-0151, and ADR-0163 / issue #3352: the
/// nullable-binding rules shared by the `if let`, `guard let`, and
/// `while let` statement forms (bound by (cref:StatementBinder))
/// and the `if let` expression form (bound by
/// (cref:ExpressionBinder)). All surfaces must strip
/// exactly one nullable layer, honour the optional explicit underlying type
/// clause, and report `GS0296` identically, so the logic lives here
/// once and is invoked through collaborator callbacks (ADR-0150 wiring
/// idiom) rather than being duplicated per binder.
internal shared class IfLetBindingSupport {
    /// The result of binding one `let name [T] = expr` clause.
    /// @param Variable The declared local. Never `null`: an erroneous clause
    /// still declares a placeholder so later references resolve.
    /// @param Underlying The underlying (non-null) type the binding is observed at, or
    /// `null` when the clause was erroneous.
    /// @param Initializer The bound right-hand-side expression.
    internal data struct BoundIfLetBinding(
        Variable VariableSymbol,
        Underlying TypeSymbol?,
        Initializer BoundExpression
    ) : IEquatable[BoundIfLetBinding] {
        /// Gets a value indicating whether the clause produced a usable binding.
        internal prop IsValid bool -> Variable != nil && Underlying != nil
    }

    /// Binds a single `let name [T] = expr` binding clause. The variable
    /// is declared through [`declareLocal`](paramref), so the caller
    /// controls the binding's lifetime (then-block only for `if let`,
    /// enclosing block for `guard let`, or loop body for
    /// `while let`).
    /// @param binding The clause syntax.
    /// @param diagnostics The diagnostic bag GS0296 is reported into.
    /// @param conversions The conversion classifier used for an explicit type clause.
    /// @param bindTypeClause Binds the optional declared type clause.
    /// @param bindExpression Binds the initializer expression.
    /// @param declareLocal Declares the binding's local variable.
    /// @param reportNonNullableInitializer ADR-0174 D3: when supplied, reports a non-nullable initializer
    /// in place of
    /// GS0296 so a caller can substitute a more specific diagnostic (GS0555 for a
    /// `while let` whose initializer is a channel handle rather than a receive).
    /// @returns The bound binding.
    internal func BindBindingClause(
        binding IfLetBindingClauseSyntax,
        diagnostics DiagnosticBag,
        conversions ConversionClassifier,
        bindTypeClause(TypeClauseSyntax) -> TypeSymbol?,
        bindExpression(ExpressionSyntax) -> BoundExpression,
        declareLocal(SyntaxToken, bool, TypeSymbol) -> VariableSymbol,
        reportNonNullableInitializer((IfLetBindingClauseSyntax, BoundExpression) -> void)? = nil
    ) BoundIfLetBinding {
        var declaredUnderlying TypeSymbol? = nil
        if binding.TypeClause != nil {
            declaredUnderlying = bindTypeClause(binding.TypeClause)
            // The author wrote `if let s string = …`: they declared the
            // underlying (non-null) type. A nullable spelling would be
            // self-defeating — reject it through the standard
            // initializer-type diagnostic by widening to the nullable.
            if declaredUnderlying is NullableTypeSymbol declaredNullable {
                declaredUnderlying = declaredNullable.UnderlyingType
            }
        }
        var initializerExpr = bindExpression(binding.Initializer)
        let initializerType = initializerExpr.Type
        if initializerType == TypeSymbol.Error {
            let errorVar = declareLocal(binding.Identifier, true, declaredUnderlying ?? TypeSymbol.Error)
            return BoundIfLetBinding(errorVar, nil, initializerExpr)
        }
        // ADR-0071: the right-hand side must be of nullable type so the
        // binding has something to strip. A non-nullable RHS is GS0296.
        var underlying TypeSymbol
        var nullableStorageType TypeSymbol
        if initializerType is NullableTypeSymbol nullable {
            underlying = nullable.UnderlyingType
            nullableStorageType = nullable
        } else if initializerType is PlatformTypeSymbol platform {
            // ADR-0186 §6: `if let` / `guard let` / `while let` accept a `T!`
            // initializer and bind `T`. GS0296 asks "is there a nullability
            // strip to do here?", and for a platform value the answer is yes —
            // it may genuinely be nil, which is the whole difference between
            // `T!` and `T`.
            //
            // The binding is stored at `T?` rather than `T!` deliberately: the
            // synthesized condition is `variable != nil` and the observed type
            // comes from ADR-0069 narrowing, both of which already do exactly
            // the right thing for a nullable storage slot. The two wrappers
            // erase to the same CLR type (§1), so this is a binder-level
            // choice with no representation consequence — and after the bind
            // the value IS known non-nil, which is the one fact `T!` cannot
            // state and `T?`-plus-narrowing can.
            underlying = platform.UnderlyingType
            nullableStorageType = NullableTypeSymbol.Get(platform.UnderlyingType)
        } else if initializerType == TypeSymbol.Null {
            // A bare `nil` literal — there's no narrowing to do; bind to
            // the declared underlying type if available, otherwise error.
            if declaredUnderlying == nil {
                diagnostics.ReportIfLetInitializerMustBeNullable(
                    binding.Initializer.Location,
                    binding.Identifier.ValueText,
                    initializerType
                )
                let errorVar = declareLocal(binding.Identifier, true, TypeSymbol.Error)
                return BoundIfLetBinding(errorVar, nil, initializerExpr)
            }
            underlying = declaredUnderlying
            nullableStorageType = NullableTypeSymbol.Get(declaredUnderlying)
        } else {
            if reportNonNullableInitializer != nil {
                reportNonNullableInitializer(binding, initializerExpr)
            } else {
                diagnostics.ReportIfLetInitializerMustBeNullable(
                    binding.Initializer.Location,
                    binding.Identifier.ValueText,
                    initializerType
                )
            }
            let errorVar = declareLocal(binding.Identifier, true, declaredUnderlying ?? initializerType)
            return BoundIfLetBinding(errorVar, nil, initializerExpr)
        }
        // If the user gave an explicit type clause, the underlying type
        // they wrote must match (or be a conversion-target of) the RHS's
        // underlying. We route through the existing conversion classifier
        // for an apples-to-apples diagnostic.
        if declaredUnderlying != nil {
            initializerExpr = conversions.BindConversion(
                binding.Initializer.Location,
                initializerExpr,
                NullableTypeSymbol.Get(declaredUnderlying)
            )
            underlying = declaredUnderlying
            nullableStorageType = NullableTypeSymbol.Get(declaredUnderlying)
        }
        // The synthesized binding is `let name <nullable> = expr`. The
        // user observes it at the underlying type via the existing
        // narrowing path (NarrowedType on each read site).
        let variable = declareLocal(binding.Identifier, true, nullableStorageType)
        return BoundIfLetBinding(variable, underlying, initializerExpr)
    }

    /// Issue #4961 / ADR-0201: one clause of a bound `if let` header, in
    /// source order. An erroneous clause keeps its placeholder declaration
    /// (`Binding.IsValid` is false) so later references still resolve.
    /// @param Syntax The clause syntax.
    /// @param Binding The bound clause.
    internal data struct BoundIfLetClause(Syntax IfLetBindingClauseSyntax, Binding BoundIfLetBinding) : IEquatable[
        BoundIfLetClause
    ] { }

    /// Issue #4961 / ADR-0201: binds the header shared by the `if let`
    /// STATEMENT and EXPRESSION — the bindings, the optional guard, and the
    /// then-region — with one scope and one narrowing frame, so both forms
    /// make the same scoping decisions:
    ///
    /// - every bound name is declared in a fresh scope that covers later
    ///   initializers, the guard, and the then-region, and is popped before
    ///   the caller binds the `else` branch (bindings are never visible there
    ///   or after the form);
    /// - each binding is added to the narrowing frame as soon as it binds, so a
    ///   later initializer, the guard, and the then-region all observe earlier
    ///   bindings at their non-null underlying types;
    /// - the then-region sees the guard like an `if` branch sees its
    ///   condition: the narrowing a `true` guard implies and its when-true
    ///   pattern variables;
    /// - when a guard is present and the final initializer — which the shared
    ///   parser ended at the guard's `&&` — is a non-nullable `bool`,
    ///   GS0624 replaces GS0296. A nullable conversion hiding that boolean in
    ///   an assignment/conditional continuation gets the same migration hint.
    ///
    /// The caller still owns the lowering, which differs only because one form
    /// is a statement and the other produces a value.
    /// @param binderCtx The binder context whose root scope and narrowing stack are used.
    /// @param bindings The binding clauses, in source order.
    /// @param guardSyntax The optional guard expression.
    /// @param diagnostics The diagnostic bag.
    /// @param conversions The conversion classifier used for an explicit type clause.
    /// @param bindTypeClause Binds an optional declared type clause.
    /// @param bindInitializer Binds an initializer expression.
    /// @param declareLocal Declares a binding's local variable in the current scope.
    /// @param bindGuard Binds the guard against `bool`.
    /// @param classifyGuardNarrowing Returns the narrowing a `true` guard implies (the caller's
    /// ordinary `if`-condition classifier), or `null`.
    /// @param bindThen Binds the then-region while the bindings are in scope and narrowed.
    /// @returns The bound clauses, the bound guard (null when absent), and the bound then-region.
    internal func BindHeader[TThen](
        binderCtx BinderContext,
        bindings SeparatedSyntaxList[IfLetBindingClauseSyntax],
        guardSyntax ExpressionSyntax?,
        diagnostics DiagnosticBag,
        conversions ConversionClassifier,
        bindTypeClause(TypeClauseSyntax) -> TypeSymbol?,
        bindInitializer(ExpressionSyntax) -> BoundExpression,
        declareLocal(SyntaxToken, bool, TypeSymbol) -> VariableSymbol,
        bindGuard(ExpressionSyntax) -> BoundExpression,
        classifyGuardNarrowing(BoundExpression) -> Dictionary[AccessPath, TypeSymbol]?,
        bindThen() -> TThen
    )(Clauses ImmutableArray[BoundIfLetClause], Guard BoundExpression?, Then TThen) {
        let clauses = ImmutableArray.CreateBuilder[BoundIfLetClause](bindings.Count)
        binderCtx.RootScope = BoundScope(binderCtx.RootScope)
        let narrowing = binderCtx.PushNarrowingFrame(Dictionary[AccessPath, TypeSymbol]())
        try {
            for var i = 0; i < bindings.Count; i++ {
                let binding = bindings[i]
                let reportNonNullable = if guardSyntax != nil && i == bindings.Count - 1 {
                    (
                        (clause IfLetBindingClauseSyntax, initializer BoundExpression) -> {
                            ReportFinalInitializerBeforeGuard(diagnostics, clause, initializer)
                        }
                    )
                } else {
                    default(((IfLetBindingClauseSyntax, BoundExpression) -> void)?)
                }
                let bound = BindBindingClause(
                    binding,
                    diagnostics,
                    conversions,
                    bindTypeClause,
                    bindInitializer,
                    declareLocal,
                    reportNonNullable
                )
                if bound.IsValid &&
                    guardSyntax != nil &&
                    i == bindings.Count - 1 &&
                    binding.Initializer is not ParenthesizedExpressionSyntax &&
                    HasAmbiguousBooleanContinuation(bound.Initializer, binding.Initializer) {
                    diagnostics.ReportIfLetGuardSplitsInitializer(
                        binding.Initializer.Location,
                        binding.Identifier.ValueText,
                        bound.Initializer.Type
                    )
                }
                if bound.IsValid {
                    narrowing[bound.Variable] = Invariant.Required(
                        bound.Underlying,
                        "a valid if-let binding has an underlying type",
                        expression: "bound.Underlying"
                    )
                }
                clauses.Add(BoundIfLetClause(binding, bound))
            }
            if guardSyntax == nil {
                return (clauses.ToImmutable(), nil, bindThen())
            }
            // The then-region runs only when the guard is true, so it sees the
            // guard exactly like an `if` branch sees its condition: the
            // narrowing the guard implies joins the bindings' frame, and the
            // guard's when-true pattern variables are in scope.
            let guard_ = bindGuard(guardSyntax)
            let guardFrame = classifyGuardNarrowing(guard_)
            if guardFrame != nil {
                for entry in guardFrame {
                    narrowing[entry.Key] = entry.Value
                }
            }
            let then = PatternVariables.BindInScope(binderCtx, PatternVariables.Classify(guard_).WhenTrue, bindThen)
            return (clauses.ToImmutable(), guard_, then)
        } finally {
            binderCtx.EndNarrowingProof()
            binderCtx.RootScope = binderCtx.RootScope.Pop()
        }
    }

    /// Issue #4961 / ADR-0201: reports a non-nullable final initializer that
    /// is followed by a guard. A `bool` there is what `let v = a && b ? x : y`
    /// (or any `a && b` meant as the initializer) becomes once the `&&` starts
    /// the guard, so it gets GS0624's parenthesize hint; any other type is the
    /// ordinary GS0296.
    private func ReportFinalInitializerBeforeGuard(
        diagnostics DiagnosticBag,
        clause IfLetBindingClauseSyntax,
        initializer BoundExpression
    ) {
        let type = initializer.Type
        if type == TypeSymbol.Bool {
            diagnostics.ReportIfLetGuardSplitsInitializer(
                clause.Initializer.Location,
                clause.Identifier.ValueText,
                type
            )
        } else {
            diagnostics.ReportIfLetInitializerMustBeNullable(
                clause.Initializer.Location,
                clause.Identifier.ValueText,
                type
            )
        }
    }

    private func HasAmbiguousBooleanContinuation(expression BoundExpression, initializer ExpressionSyntax) bool {
        // Assignment values, coalescing tails and ternary false arms retain
        // the parser's logical boundary. Closed nested expressions do not.
        var hasContinuation = false
        var source = initializer
        while true {
            var nextSource ExpressionSyntax? = nil
            if source is ConditionalExpressionSyntax conditional {
                nextSource = conditional.WhenFalse
            } else if source is BinaryExpressionSyntax binary &&
                binary
                .OperatorToken
                .Kind == SyntaxKind.QuestionQuestionToken {
                nextSource = binary.Right
            } else {
                var isAssignment = false
                for child in source.GetChildren() {
                    if child is SyntaxToken token &&
                        (
                        token.Kind == SyntaxKind.EqualsToken || SyntaxFacts.TryGetCompoundAssignmentBaseOperator(
                            token.Kind,
                            out _
                        )
                    ) {
                        isAssignment = true
                    } else if child is ExpressionSyntax operand {
                        nextSource = operand
                    }
                }
                if !isAssignment {
                    break
                }
            }
            if nextSource == nil {
                break
            }
            hasContinuation = true
            source = nextSource
        }
        if !hasContinuation {
            return false
        }
        // Find the original value even when assignment lowering captures it in
        // a temporary. Grouping/overflow wrappers are removed only for lookup,
        // not to resume the source continuation inside a closed expression.
        source = AssignmentTargetSyntaxFacts.UnwrapParentheses(source)
        while source is CheckedExpressionSyntax checkedExpression {
            source = AssignmentTargetSyntaxFacts.UnwrapParentheses(checkedExpression.Expression)
        }
        for node in expression.DescendantsAndSelf() {
            if node is BoundExpression value && object.ReferenceEquals(value.Syntax, source) {
                return HasBooleanValueBeforeContextualConversion(value)
            }
        }
        return false
    }

    private func HasBooleanValueBeforeContextualConversion(expression BoundExpression) bool {
        // Cover the result positions of all target-typed branchy expressions:
        // if/if-let/ternary, block, switch and coalescing. Conditions, switch
        // discriminants and guards are not result values.
        let pending = Stack[BoundExpression]()
        pending.Push(expression)
        while pending.Count > 0 {
            let value = pending.Pop()
            if value.Type == TypeSymbol.Bool || value.Type == TypeSymbol.Never {
                continue
            }
            if value.ImplicitConversionOperand is BoundExpression original {
                pending.Push(original)
                continue
            }
            switch value {
                case defaultValue is BoundDefaultExpression when defaultValue.Syntax is DefaultExpressionSyntax{
                    TypeClause: nil
                } {
                    // A bare default has no intrinsic nullable type: its
                    // contextual target cannot rule out a Boolean value.
                    continue
                }
                case conversion is BoundConversionExpression when conversion.Syntax == nil || object.ReferenceEquals(
                    conversion.Syntax,
                    conversion.Expression.Syntax
                ) {
                    pending.Push(conversion.Expression)
                }
                case conditional is BoundConditionalExpression {
                    pending.Push(conditional.WhenTrue)
                    pending.Push(conditional.WhenFalse)
                }
                case block is BoundBlockExpression {
                    pending.Push(block.Expression)
                }
                case selection is BoundSwitchExpression {
                    if selection.Arms.IsDefaultOrEmpty {
                        return false
                    }
                    for arm in selection.Arms {
                        pending.Push(arm.Result)
                    }
                }
                case coalesce is BoundBinaryExpression when coalesce.Op.Kind == BoundBinaryOperatorKind.NullCoalesce {
                    // Reuse the operator's own rules for the present left
                    // value, rather than computing nullable unwrapping here.
                    var left = coalesce.Left
                    while left.ImplicitConversionOperand is BoundExpression originalLeft {
                        left = originalLeft
                    }
                    if BoundBinaryOperator.Bind(SyntaxKind.QuestionQuestionToken, left.Type, TypeSymbol.Bool)
                        ?.Type != TypeSymbol.Bool {
                        return false
                    }
                    pending.Push(coalesce.Right)
                }
                default {
                    return false
                }
            }
        }
        return true
    }

    /// ADR-0151 / ADR-0201: builds the boolean condition that declares each
    /// binding in turn and short-circuits on the first `nil`, then evaluates
    /// the guard:
    ///
    /// ```
    /// ({ let a = e0 } → a != nil ? ({ let b = e1 } → b != nil ? g : false) : false)
    /// ```
    ///
    /// The short circuit lives in conditionals rather than a `&&` chain so
    /// each initializer sits in the arm reached only once every earlier
    /// binding matched. The `if let` expression uses it as its condition; the
    /// statement form lowers to statement-level control flow instead
    /// (StatementBinder.BindIfLetStatement).
    /// @param clauses The bound clauses; every one must be valid.
    /// @param index The first clause to declare.
    /// @param guard The optional guard, evaluated after the final binding matched.
    /// @returns The condition.
    internal func BuildShortCircuitCondition(
        clauses ImmutableArray[BoundIfLetClause],
        index int32,
        $guard BoundExpression?
    ) BoundExpression {
        let clause = clauses[index]
        let declaration = BoundVariableDeclaration(clause.Syntax, clause.Binding.Variable, clause.Binding.Initializer)
        let test = Invariant.Required(
            BuildNilCheckChain(clause.Syntax, []VariableSymbol{clause.Binding.Variable}),
            "an if-let binding condition has a nil check",
            expression: "BuildNilCheckChain(clause.Syntax, new[] { clause.Binding.Variable })"
        )
        let rest BoundExpression? = if index == clauses.Length - 1 {
            $guard
        } else {
            BuildShortCircuitCondition(clauses, index + 1, $guard)
        }
        let value BoundExpression = if rest == nil {
            test
        } else {
            BoundConditionalExpression(
                nil,
                test,
                rest,
                BoundLiteralExpression(clause.Syntax, false, TypeSymbol.Bool),
                TypeSymbol.Bool
            )
        }
        return BoundBlockExpression(nil, ImmutableArray.Create[BoundStatement](declaration), value)
    }

    /// ADR-0071 / issue #708: builds a left-folded `&&` chain of
    /// `variable != nil` tests for the given bindings. With a single
    /// binding this is just `variable != nil`; with none it is
    /// `null`.
    /// @param syntax The syntax the synthesized nodes are attributed to.
    /// @param variables The binding variables, in source order.
    /// @returns The nil-check chain, or `null` when there are no bindings.
    internal func BuildNilCheckChain(syntax SyntaxNode, variables IEnumerable[VariableSymbol]) BoundExpression? {
        var result BoundExpression? = nil
        for variable in variables {
            let read = BoundVariableExpression(syntax, variable)
            let nilLiteral = BoundLiteralExpression(syntax, nil, TypeSymbol.Null)
            let neqOp = Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.BangEqualsToken, variable.Type, TypeSymbol.Null),
                "a nullable binding variable supports nil inequality",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.BangEqualsToken, variable.Type, TypeSymbol.Null)"
            )
            let test BoundExpression = BoundBinaryExpression(syntax, read, neqOp, nilLiteral)
            if result == nil {
                result = test
            } else {
                let andOp = Invariant.Required(
                    BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
                    "boolean nil checks support logical conjunction",
                    expression: "BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool)"
                )
                result = BoundBinaryExpression(syntax, result, andOp, test)
            }
        }
        return result
    }
}
