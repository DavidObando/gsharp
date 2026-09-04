// <copyright file="IfLetBindingSupport.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1201 // Elements should appear in the correct order

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0071 / issue #708, ADR-0151, and ADR-0163 / issue #3352: the
/// nullable-binding rules shared by the <c>if let</c>, <c>guard let</c>, and
/// <c>while let</c> statement forms (bound by <see cref="StatementBinder"/>)
/// and the <c>if let</c> expression form (bound by
/// <see cref="ExpressionBinder"/>). All surfaces must strip
/// exactly one nullable layer, honour the optional explicit underlying type
/// clause, and report <c>GS0296</c> identically, so the logic lives here
/// once and is invoked through collaborator callbacks (ADR-0150 wiring
/// idiom) rather than being duplicated per binder.
/// </summary>
internal static class IfLetBindingSupport
{
    /// <summary>
    /// The result of binding one <c>let name [T] = expr</c> clause.
    /// </summary>
    /// <param name="Variable">
    /// The declared local. Never <see langword="null"/>: an erroneous clause
    /// still declares a placeholder so later references resolve.
    /// </param>
    /// <param name="Underlying">
    /// The underlying (non-null) type the binding is observed at, or
    /// <see langword="null"/> when the clause was erroneous.
    /// </param>
    /// <param name="Initializer">The bound right-hand-side expression.</param>
    internal readonly record struct BoundIfLetBinding(
        VariableSymbol Variable,
        TypeSymbol? Underlying,
        BoundExpression Initializer)
    {
        /// <summary>Gets a value indicating whether the clause produced a usable binding.</summary>
        internal bool IsValid => Variable != null && Underlying != null;
    }

    /// <summary>
    /// Binds a single <c>let name [T] = expr</c> binding clause. The variable
    /// is declared through <paramref name="declareLocal"/>, so the caller
    /// controls the binding's lifetime (then-block only for <c>if let</c>,
    /// enclosing block for <c>guard let</c>, or loop body for
    /// <c>while let</c>).
    /// </summary>
    /// <param name="binding">The clause syntax.</param>
    /// <param name="diagnostics">The diagnostic bag GS0296 is reported into.</param>
    /// <param name="conversions">The conversion classifier used for an explicit type clause.</param>
    /// <param name="bindTypeClause">Binds the optional declared type clause.</param>
    /// <param name="bindExpression">Binds the initializer expression.</param>
    /// <param name="declareLocal">Declares the binding's local variable.</param>
    /// <param name="reportNonNullableInitializer">
    /// ADR-0174 D3: when supplied, reports a non-nullable initializer in place of
    /// GS0296 so a caller can substitute a more specific diagnostic (GS0555 for a
    /// <c>while let</c> whose initializer is a channel handle rather than a receive).
    /// </param>
    /// <returns>The bound binding.</returns>
    internal static BoundIfLetBinding BindBindingClause(
        IfLetBindingClauseSyntax binding,
        DiagnosticBag diagnostics,
        ConversionClassifier conversions,
        Func<TypeClauseSyntax, TypeSymbol?> bindTypeClause,
        Func<ExpressionSyntax, BoundExpression> bindExpression,
        Func<SyntaxToken, bool, TypeSymbol, VariableSymbol> declareLocal,
        Action<IfLetBindingClauseSyntax, BoundExpression>? reportNonNullableInitializer = null)
    {
        TypeSymbol? declaredUnderlying = null;
        if (binding.TypeClause != null)
        {
            declaredUnderlying = bindTypeClause(binding.TypeClause);

            // The author wrote `if let s string = …`: they declared the
            // underlying (non-null) type. A nullable spelling would be
            // self-defeating — reject it through the standard
            // initializer-type diagnostic by widening to the nullable.
            if (declaredUnderlying is NullableTypeSymbol declaredNullable)
            {
                declaredUnderlying = declaredNullable.UnderlyingType;
            }
        }

        var initializerExpr = bindExpression(binding.Initializer);
        var initializerType = initializerExpr.Type;

        if (initializerType == TypeSymbol.Error)
        {
            var errorVar = declareLocal(binding.Identifier, true, declaredUnderlying ?? TypeSymbol.Error);
            return new BoundIfLetBinding(errorVar, null, initializerExpr);
        }

        // ADR-0071: the right-hand side must be of nullable type so the
        // binding has something to strip. A non-nullable RHS is GS0296.
        TypeSymbol underlying;
        TypeSymbol nullableStorageType;
        if (initializerType is NullableTypeSymbol nullable)
        {
            underlying = nullable.UnderlyingType;
            nullableStorageType = nullable;
        }
        else if (initializerType == TypeSymbol.Null)
        {
            // A bare `nil` literal — there's no narrowing to do; bind to
            // the declared underlying type if available, otherwise error.
            if (declaredUnderlying == null)
            {
                diagnostics.ReportIfLetInitializerMustBeNullable(binding.Initializer.Location, binding.Identifier.ValueText, initializerType);
                var errorVar = declareLocal(binding.Identifier, true, TypeSymbol.Error);
                return new BoundIfLetBinding(errorVar, null, initializerExpr);
            }

            underlying = declaredUnderlying;
            nullableStorageType = NullableTypeSymbol.Get(declaredUnderlying);
        }
        else
        {
            if (reportNonNullableInitializer != null)
            {
                reportNonNullableInitializer(binding, initializerExpr);
            }
            else
            {
                diagnostics.ReportIfLetInitializerMustBeNullable(binding.Initializer.Location, binding.Identifier.ValueText, initializerType);
            }

            var errorVar = declareLocal(binding.Identifier, true, declaredUnderlying ?? initializerType);
            return new BoundIfLetBinding(errorVar, null, initializerExpr);
        }

        // If the user gave an explicit type clause, the underlying type
        // they wrote must match (or be a conversion-target of) the RHS's
        // underlying. We route through the existing conversion classifier
        // for an apples-to-apples diagnostic.
        if (declaredUnderlying != null)
        {
            initializerExpr = conversions.BindConversion(binding.Initializer.Location, initializerExpr, NullableTypeSymbol.Get(declaredUnderlying));
            underlying = declaredUnderlying;
            nullableStorageType = NullableTypeSymbol.Get(declaredUnderlying);
        }

        // The synthesized binding is `let name <nullable> = expr`. The
        // user observes it at the underlying type via the existing
        // narrowing path (NarrowedType on each read site).
        var variable = declareLocal(binding.Identifier, true, nullableStorageType);
        return new BoundIfLetBinding(variable, underlying, initializerExpr);
    }

    /// <summary>
    /// ADR-0071 / issue #708: builds a left-folded <c>&amp;&amp;</c> chain of
    /// <c>variable != nil</c> tests for the given bindings. With a single
    /// binding this is just <c>variable != nil</c>; with none it is
    /// <see langword="null"/>.
    /// </summary>
    /// <param name="syntax">The syntax the synthesized nodes are attributed to.</param>
    /// <param name="variables">The binding variables, in source order.</param>
    /// <returns>The nil-check chain, or <see langword="null"/> when there are no bindings.</returns>
    internal static BoundExpression? BuildNilCheckChain(SyntaxNode syntax, IEnumerable<VariableSymbol> variables)
    {
        BoundExpression? result = null;
        foreach (var variable in variables)
        {
            var read = new BoundVariableExpression(syntax, variable);
            var nilLiteral = new BoundLiteralExpression(syntax, null, TypeSymbol.Null);
            var neqOp = Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.BangEqualsToken, variable.Type, TypeSymbol.Null),
                "a nullable binding variable supports nil inequality");
            BoundExpression test = new BoundBinaryExpression(syntax, read, neqOp, nilLiteral);
            if (result == null)
            {
                result = test;
            }
            else
            {
                var andOp = Invariant.Required(
                    BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
                    "boolean nil checks support logical conjunction");
                result = new BoundBinaryExpression(syntax, result, andOp, test);
            }
        }

        return result;
    }
}
