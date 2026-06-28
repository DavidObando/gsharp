// <copyright file="DeclarationBinder.Variables.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Extracted from <see cref="Binder"/> in PR-B-8. Owns every per-declaration-kind
/// binder: type aliases, named delegates, enums, structs (including the large
/// <c>BindStructDeclarationBody</c> driver and its interface-implementation
/// verification pass), interfaces, free / member / extension functions,
/// constructors (<c>init</c>) plus the <c>: base(...)</c> initializer
/// resolver, the two symbol-construction <c>BindVariableDeclaration</c>
/// overloads, generic-parameter binding (<c>BindTypeParameterList</c>), the
/// declaration-side attribute binder (<c>BindAttributes</c>/<c>BindAttribute</c>),
/// and the queue of pending struct→interface implementation checks. The
/// expression binder and most type-name resolution remain on
/// <see cref="Binder"/> and are invoked via the delegate callbacks supplied to
/// the constructor; the same is true for <c>BindBlockStatement</c>-driven
/// body binding (which happens later, in <c>BindProgram</c>, not here).
/// </summary>

internal sealed partial class DeclarationBinder
{


    // Issue #1085: base-constructor-initializer (`: base(...)`) argument binding
    // is deferred until every declared type's explicit constructors have been
    // populated. The argument expressions may construct OTHER user types (e.g.
    // `: base(H(1))`), and resolving such a constructor call requires the
    // referenced type's ExplicitConstructor(s) to already exist. Because type
    // bodies are bound one file at a time, a base-initializer in a file processed
    // before the constructed type's file would otherwise resolve against an
    // empty (not-yet-populated) constructor shell and wrongly report GS0144.
    // Method bodies already see fully-populated constructors because they are
    // bound in a later phase; deferring base-initializer argument binding to a
    // post-pass gives it the same guarantee, regardless of source-file order.
    private readonly List<Action> pendingBaseInitializerBindings = new List<Action>();

    /// <summary>
    /// Issue #987: verifies that every concrete (non-<c>open</c>) class
    /// overrides all abstract methods it inherits. Run after all type bodies are
    /// bound so the base-class method sets are complete. An <c>open</c> class may
    /// leave inherited abstract members unimplemented (it stays abstract itself).
    /// </summary>
    // Issue #1085: run all deferred base-constructor-initializer bindings. Must
    // be called after every declared type body has been bound (so all explicit
    // constructors exist) and before lowering/emit consume the resolved
    // initializers.
    internal void BindPendingBaseInitializers()
    {
        foreach (var bind in pendingBaseInitializerBindings)
        {
            bind();
        }

        pendingBaseInitializerBindings.Clear();
    }

    /// <summary>
    /// Issue #1194: binds the deferred field-initializer expressions for every
    /// type, run from <c>Binder.BindGlobalScope</c> after all top-level
    /// functions have been declared so a field initializer can resolve an
    /// unqualified free-function or sibling static-member call.
    /// </summary>
    internal void BindPendingFieldInitializers()
    {
        foreach (var bind in pendingFieldInitializerBindings)
        {
            bind();
        }

        pendingFieldInitializerBindings.Clear();
    }

    /// <summary>
    /// Issue #1194: binds a single type's deferred field/const/static
    /// initializers within the active static-member scope. Const initializers
    /// are folded with a fixpoint so sibling const references resolve regardless
    /// of declaration order (#1193); instance initializers reject instance
    /// member references (no <c>this</c> is available, GS0377).
    /// </summary>
    private void BindDeferredFieldInitializers(
        StructSymbol structSymbol,
        List<(FieldSymbol Field, FieldDeclarationSyntax Syntax, TypeSymbol FieldType)> constInitializers,
        List<(FieldSymbol Field, FieldDeclarationSyntax Syntax, TypeSymbol FieldType)> sharedConstInitializers,
        List<(FieldSymbol Field, ExpressionSyntax InitSyntax, TypeSymbol FieldType)> staticFieldInitializers,
        List<(FieldSymbol Field, ExpressionSyntax InitSyntax, TypeSymbol FieldType)> instanceInitializers,
        ImmutableArray<FieldSymbol> fields,
        ImmutableArray<ParameterSymbol> primaryCtorParameters)
    {
        // Fold const initializers with a fixpoint so a const that references a
        // sibling const folds regardless of declaration order (#1193). Each
        // initializer is bound exactly once (binding a const reference does not
        // require its value), then folding is retried until no further progress.
        // Class const initializers are seeded first so a `shared` const
        // referencing a class const can read its value.
        var pendingConstFolds = new List<(FieldSymbol Field, BoundExpression Bound, TextLocation Location)>();
        foreach (var (constField, fieldSyntaxNode, fieldType) in constInitializers)
        {
            pendingConstFolds.Add(BindConstFieldInitializer(constField, fieldSyntaxNode, fieldType));
        }

        foreach (var (constField, fieldSyntaxNode, fieldType) in sharedConstInitializers)
        {
            pendingConstFolds.Add(BindConstFieldInitializer(constField, fieldSyntaxNode, fieldType));
        }

        var progress = true;
        while (progress && pendingConstFolds.Count > 0)
        {
            progress = false;
            var stillPending = new List<(FieldSymbol Field, BoundExpression Bound, TextLocation Location)>();
            foreach (var item in pendingConstFolds)
            {
                if (TryFoldConstantFieldValue(item.Bound, item.Field.Type, out var constantValue))
                {
                    item.Field.SetConstantValue(constantValue);
                    progress = true;
                }
                else
                {
                    stillPending.Add(item);
                }
            }

            pendingConstFolds = stillPending;
        }

        // Report diagnostics for any const that still cannot fold (a genuinely
        // non-constant initializer or an unresolved cycle).
        foreach (var (constField, bound, location) in pendingConstFolds)
        {
            if (bound is not BoundErrorExpression)
            {
                Diagnostics.ReportConstFieldInitializerNotConstant(location, constField.Name);
            }
        }

        // Bind `shared` static field initializers.
        if (staticFieldInitializers.Count > 0)
        {
            var staticInitBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
            foreach (var (fieldSym, initSyntax, fieldType) in staticFieldInitializers)
            {
                var boundInit = bindExpression(initSyntax);
                var convertedInit = conversions.BindConversion(initSyntax.Location, boundInit, fieldType);
                staticInitBuilder[fieldSym] = convertedInit;
            }

            structSymbol.SetStaticFieldInitializers(staticInitBuilder.ToImmutable());
        }

        // Bind instance field initializers. These run before the constructor
        // body, so they cannot reference `this`, other instance members, or
        // constructor parameters (matching C#); a genuine instance-member
        // reference is reported precisely rather than as a bare GS0125.
        if (instanceInitializers.Count > 0)
        {
            var instanceMemberNames = new HashSet<string>(System.StringComparer.Ordinal) { "this" };
            foreach (var f in fields)
            {
                instanceMemberNames.Add(f.Name);
            }

            foreach (var p in primaryCtorParameters)
            {
                instanceMemberNames.Add(p.Name);
            }

            var instanceInitBuilder = ImmutableDictionary.CreateBuilder<FieldSymbol, BoundExpression>();
            foreach (var (fieldSym, initSyntax, fieldType) in instanceInitializers)
            {
                if (TryFindInstanceMemberReference(initSyntax, instanceMemberNames, out var offendingName, out var offendingLocation))
                {
                    Diagnostics.ReportFieldInitializerCannotReferenceInstanceMember(offendingLocation, offendingName);
                    continue;
                }

                var boundInit = bindExpression(initSyntax);
                var convertedInit = conversions.BindConversion(initSyntax.Location, boundInit, fieldType);
                instanceInitBuilder[fieldSym] = convertedInit;
            }

            structSymbol.SetInstanceFieldInitializers(instanceInitBuilder.ToImmutable());
        }
    }

    /// <summary>
    /// Issue #948: attempts to fold a bound const-field initializer to a
    /// compile-time constant value coerced to the field's CLR primitive type.
    /// Handles literal expressions (optionally wrapped in numeric/identity
    /// conversions) and unary negation of a numeric literal. Returns
    /// <c>false</c> for non-constant expressions so the caller can report a
    /// diagnostic.
    /// </summary>
    /// <param name="bound">The bound (already type-converted) initializer expression.</param>
    /// <param name="fieldType">The declared const field type.</param>
    /// <param name="value">The folded constant value on success.</param>
    /// <returns>True when a compile-time constant was produced.</returns>
    private static bool TryFoldConstantFieldValue(BoundExpression bound, TypeSymbol fieldType, out object value)
    {
        value = null;
        if (!TryEvaluateConstant(bound, out var raw))
        {
            return false;
        }

        if (raw == null)
        {
            // A null literal is only valid for reference-typed const fields
            // (e.g. `const s string = nil`); the Constant row stores a null.
            value = null;
            return !fieldType.ClrType?.IsValueType ?? true;
        }

        var targetClr = fieldType.ClrType;
        if (targetClr == null)
        {
            return false;
        }

        if (targetClr.IsEnum)
        {
            targetClr = System.Enum.GetUnderlyingType(targetClr);
        }

        try
        {
            value = targetClr == raw.GetType()
                ? raw
                : System.Convert.ChangeType(raw, targetClr, System.Globalization.CultureInfo.InvariantCulture);
            return true;
        }
        catch (System.Exception ex) when (ex is System.InvalidCastException or System.FormatException or System.OverflowException or System.ArgumentException)
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #948: evaluates a bound expression to a compile-time constant
    /// (a literal, a conversion over a constant, or a unary +/- over a numeric
    /// constant). Returns <c>false</c> for any non-constant shape.
    /// </summary>
    /// <param name="bound">The bound expression.</param>
    /// <param name="value">The constant value on success.</param>
    /// <returns>True when the expression is a compile-time constant.</returns>
    private static bool TryEvaluateConstant(BoundExpression bound, out object value)
    {
        switch (bound)
        {
            case BoundLiteralExpression lit:
                value = lit.Value;
                return true;

            case BoundConversionExpression conv:
                return TryEvaluateConstant(conv.Expression, out value);

            case BoundFieldAccessExpression fieldAccess
                when fieldAccess.Field is { IsConst: true } constField
                && constField.ConstantValue != null:
                // Issue #1193: a `const` field initializer composed of other
                // `const` fields folds by reading the referenced field's
                // already-computed compile-time value. Sibling const fields are
                // folded in dependency order (see the fixpoint loop in the
                // const-binding pass), so a referenced const's value is present
                // by the time this initializer is evaluated.
                value = constField.ConstantValue;
                return true;

            case BoundUnaryExpression unary
                when unary.Op.Kind is BoundUnaryOperatorKind.Negation or BoundUnaryOperatorKind.Identity
                && TryEvaluateConstant(unary.Operand, out var operand)
                && operand != null:
                value = NegateIfNeeded(operand, unary.Op.Kind == BoundUnaryOperatorKind.Negation);
                return value != null;

            case BoundBinaryExpression binary
                when TryEvaluateConstant(binary.Left, out var left)
                && TryEvaluateConstant(binary.Right, out var right)
                && left != null
                && right != null:
                value = FoldBinary(binary.Op.Kind, left, right);
                return value != null;

            default:
                value = null;
                return false;
        }
    }

    internal VariableSymbol BindVariableDeclaration(SyntaxToken identifier, bool isReadOnly, TypeSymbol type)
    {
        return BindVariableDeclaration(identifier, isReadOnly, type, Accessibility.Public);
    }

    internal VariableSymbol BindVariableDeclaration(SyntaxToken identifier, bool isReadOnly, TypeSymbol type, Accessibility accessibility)
    {
        var name = identifier.Text ?? "?";
        var declare = !identifier.IsMissing;

        // ADR-0066 D1: variables declared inside top-level statements live on
        // `BoundGlobalScope.Variables` as `GlobalVariableSymbol`s even though
        // the enclosing synthesized `<Main>$` is a non-null function (so that
        // `return` / `await` validation works). Treat the synthesized entry
        // point as a top-level context for variable-creation purposes only.
        var inTopLevelContext = function == null || function.IsTopLevelEntryPoint;
        var variable = inTopLevelContext
                            ? (VariableSymbol)new GlobalVariableSymbol(name, isReadOnly, type, accessibility, declaringSyntax: identifier)
                            : new LocalVariableSymbol(name, isReadOnly, type, declaringSyntax: identifier);

        if (declare && !scope.TryDeclareVariable(variable))
        {
            Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, name);
        }

        return variable;
    }
}
