// <copyright file="IfLetBindingSupport.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic

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
