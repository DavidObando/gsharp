// <copyright file="ExpressionTreeRestrictionValidator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #2130: validates that a lambda being converted to
/// <c>System.Linq.Expressions.Expression&lt;TDelegate&gt;</c> only uses the
/// subset of language constructs G# lowers to expression-tree factory calls.
/// </summary>
internal static class ExpressionTreeRestrictionValidator
{
    public static void Validate(
        BoundFunctionLiteralExpression literal,
        TypeSymbol targetType,
        DiagnosticBag diagnostics)
    {
        if (literal == null || diagnostics == null)
        {
            return;
        }

        if (!MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(targetType, out var delegateType)
            || !MemberLookup.TryGetDelegateFunctionTypeFromSymbol(delegateType, out _))
        {
            diagnostics.ReportExpressionTreeTargetMustBeDelegate(
                literal.Syntax != null
                    ? literal.Syntax.Location
                    : literal.Function.Declaration != null ? literal.Function.Declaration.Location : default,
                targetType ?? TypeSymbol.Error);
            return;
        }

        if (literal.Syntax is LambdaExpressionSyntax lambdaSyntax)
        {
            if (lambdaSyntax.IsAsync)
            {
                diagnostics.ReportExpressionTreeUnsupported(lambdaSyntax.AsyncModifier.Location, "an async lambda");
            }

            if (lambdaSyntax.Body is BlockExpressionSyntax)
            {
                diagnostics.ReportExpressionTreeUnsupported(lambdaSyntax.Body.Location, "a statement body");
            }
        }

        foreach (var parameter in literal.Function.Parameters)
        {
            if (parameter.Name == "_")
            {
                diagnostics.ReportExpressionTreeUnsupported(
                    parameter.DeclaringSyntax != null ? parameter.DeclaringSyntax.Location : literal.Syntax.Location,
                    "a discard parameter");
            }

            if (parameter.RefKind != RefKind.None)
            {
                diagnostics.ReportExpressionTreeUnsupported(
                    parameter.DeclaringSyntax != null ? parameter.DeclaringSyntax.Location : literal.Syntax.Location,
                    $"a '{parameter.RefKind.ToString().ToLowerInvariant()}' parameter");
            }

            if (parameter.IsVariadic)
            {
                diagnostics.ReportExpressionTreeUnsupported(
                    parameter.DeclaringSyntax != null ? parameter.DeclaringSyntax.Location : literal.Syntax.Location,
                    "a variadic parameter");
            }

            if (TypeSymbol.IsByRefLike(parameter.Type) || parameter.Type is ByRefTypeSymbol or PointerTypeSymbol)
            {
                diagnostics.ReportExpressionTreeUnsupported(
                    parameter.DeclaringSyntax != null ? parameter.DeclaringSyntax.Location : literal.Syntax.Location,
                    $"the restricted type '{parameter.Type}'");
            }
        }

        ValidateStatement(literal.Body, diagnostics);
    }

    private static void ValidateStatement(BoundStatement statement, DiagnosticBag diagnostics)
    {
        switch (statement)
        {
            case null:
                return;
            case BoundBlockStatement block:
                foreach (var child in block.Statements)
                {
                    ValidateStatement(child, diagnostics);
                }

                return;
            case BoundReturnStatement ret:
                ValidateExpression(ret.Expression, diagnostics);
                return;
            case BoundExpressionStatement exprStmt:
                ValidateExpression(exprStmt.Expression, diagnostics);
                return;
            default:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(statement.Syntax), "a statement");
                return;
        }
    }

    private static void ValidateExpression(BoundExpression expression, DiagnosticBag diagnostics)
    {
        if (expression == null)
        {
            return;
        }

        if (expression.Type is ByRefTypeSymbol or PointerTypeSymbol || TypeSymbol.IsByRefLike(expression.Type))
        {
            diagnostics.ReportExpressionTreeUnsupported(
                LocationOf(expression.Syntax),
                $"the restricted type '{expression.Type}'");
        }

        switch (expression)
        {
            case BoundErrorExpression:
            case BoundLiteralExpression:
            case BoundVariableExpression:
            case BoundDefaultExpression:
            case BoundTypeOfExpression:
                return;

            case BoundFunctionLiteralExpression:
                // Nested delegate-valued lambdas are allowed; they become
                // Expression.Constant(delegateValue, typeof(DelegateType)).
                return;

            case BoundConversionExpression conversion:
                if (conversion.Expression is BoundFunctionLiteralExpression nestedLiteral
                    && MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(conversion.Type, out _))
                {
                    Validate(nestedLiteral, conversion.Type, diagnostics);
                    return;
                }

                if (conversion.Expression.Type is TupleTypeSymbol || conversion.Type is TupleTypeSymbol)
                {
                    diagnostics.ReportExpressionTreeUnsupported(LocationOf(conversion.Syntax), "a tuple conversion");
                }

                ValidateExpression(conversion.Expression, diagnostics);
                return;

            case BoundUnaryExpression unary:
                if (unary.Op.Kind is BoundUnaryOperatorKind.ReferenceOf or BoundUnaryOperatorKind.DereferenceOf)
                {
                    diagnostics.ReportExpressionTreeUnsupported(LocationOf(unary.Syntax), "an unsafe pointer operation");
                }
                else if (unary.Op.Kind == BoundUnaryOperatorKind.NullAssertion)
                {
                    diagnostics.ReportExpressionTreeUnsupported(LocationOf(unary.Syntax), "a null-assertion operator");
                }

                ValidateExpression(unary.Operand, diagnostics);
                return;

            case BoundBinaryExpression binary:
                if (binary.Op.Kind == BoundBinaryOperatorKind.NullCoalesce
                    && binary.Left is BoundLiteralExpression { Value: null } or BoundDefaultExpression)
                {
                    diagnostics.ReportExpressionTreeUnsupported(LocationOf(binary.Syntax), "a coalescing operator with a null/default left operand");
                }

                ValidateExpression(binary.Left, diagnostics);
                ValidateExpression(binary.Right, diagnostics);
                return;

            case BoundConditionalExpression conditional:
                ValidateExpression(conditional.Condition, diagnostics);
                ValidateExpression(conditional.WhenTrue, diagnostics);
                ValidateExpression(conditional.WhenFalse, diagnostics);
                return;

            case BoundFieldAccessExpression field:
                ValidateExpression(field.Receiver, diagnostics);
                return;

            case BoundPropertyAccessExpression property:
                ValidateExpression(property.Receiver, diagnostics);
                return;

            case BoundClrPropertyAccessExpression clrProperty:
                ValidateExpression(clrProperty.Receiver, diagnostics);
                return;

            case BoundIndexExpression index:
                ValidateExpression(index.Target, diagnostics);
                ValidateExpression(index.Index, diagnostics);
                return;

            case BoundClrIndexExpression clrIndex:
                ValidateExpression(clrIndex.Target, diagnostics);
                foreach (var argument in clrIndex.Arguments)
                {
                    ValidateExpression(argument, diagnostics);
                }

                return;

            case BoundArrayCreationExpression array:
                ValidateExpression(array.LengthExpression, diagnostics);
                foreach (var element in array.Elements)
                {
                    ValidateExpression(element, diagnostics);
                }

                return;

            case BoundConstructorCallExpression ctor:
                foreach (var argument in ctor.Arguments)
                {
                    ValidateExpression(argument, diagnostics);
                }

                return;

            case BoundClrConstructorCallExpression clrCtor:
                foreach (var argument in clrCtor.Arguments)
                {
                    ValidateExpression(argument, diagnostics);
                }

                return;

            case BoundCallExpression call:
                if (call.Function.StaticOwnerType == null)
                {
                    diagnostics.ReportExpressionTreeUnsupported(LocationOf(call.Syntax), "a top-level function call");
                    return;
                }

                ValidateArguments(call.Arguments, call.Function.Parameters, diagnostics);
                return;

            case BoundUserInstanceCallExpression userCall:
                ValidateExpression(userCall.Receiver, diagnostics);
                ValidateArguments(userCall.Arguments, userCall.Method.Parameters, diagnostics);
                return;

            case BoundImportedCallExpression importedCall:
                ValidateClrArguments(importedCall.Arguments, importedCall.ArgumentRefKinds, importedCall.Function.Method, diagnostics);
                return;

            case BoundImportedInstanceCallExpression importedInstanceCall:
                ValidateExpression(importedInstanceCall.Receiver, diagnostics);
                ValidateClrArguments(importedInstanceCall.Arguments, importedInstanceCall.ArgumentRefKinds, importedInstanceCall.Method, diagnostics);
                return;

            case BoundClrStaticCallExpression clrStaticCall:
                ValidateClrArguments(clrStaticCall.Arguments, clrStaticCall.ArgumentRefKinds, clrStaticCall.Method, diagnostics);
                return;

            case BoundClrBinaryOperatorExpression clrBinary:
                ValidateExpression(clrBinary.Left, diagnostics);
                ValidateExpression(clrBinary.Right, diagnostics);
                return;

            case BoundClrUnaryOperatorExpression clrUnary:
                ValidateExpression(clrUnary.Operand, diagnostics);
                return;

            case BoundIsExpression isExpression:
                ValidateExpression(isExpression.Expression, diagnostics);
                return;

            case BoundAsExpression asExpression:
                ValidateExpression(asExpression.Expression, diagnostics);
                return;

            case BoundAssignmentExpression:
            case BoundFieldAssignmentExpression:
            case BoundPropertyAssignmentExpression:
            case BoundClrPropertyAssignmentExpression:
            case BoundIndexAssignmentExpression:
            case BoundClrIndexAssignmentExpression:
            case BoundIndirectAssignmentExpression:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "an assignment operator");
                return;

            case BoundAwaitExpression:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "an await expression");
                return;

            case BoundNullConditionalAccessExpression:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a null-propagating operator");
                return;

            case BoundThrowExpression:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a throw expression");
                return;

            case BoundSwitchExpression:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a switch expression");
                return;

            case BoundTupleLiteralExpression:
            case BoundTupleElementAccessExpression:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a tuple expression");
                return;

            case BoundMapLiteralExpression:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a map/dictionary literal");
                return;

            case BoundInterpolatedStringExpression:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "an interpolated string");
                return;

            case BoundAddressOfExpression:
            case BoundDereferenceExpression:
            case BoundFunctionPointerFromMethodExpression:
            case BoundFunctionPointerInvocationExpression:
            case BoundSizeOfExpression:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "an unsafe pointer operation");
                return;

            case BoundMethodGroupExpression:
            case BoundClrMethodGroupExpression:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a method group");
                return;

            case BoundBlockExpression block:
                if (TryValidateObjectInitializer(block, diagnostics))
                {
                    return;
                }

                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), "a block expression");
                return;

            default:
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(expression.Syntax), $"'{expression.Kind}'");
                return;
        }
    }

    private static void ValidateArguments(
        System.Collections.Immutable.ImmutableArray<BoundExpression> arguments,
        System.Collections.Immutable.ImmutableArray<ParameterSymbol> parameters,
        DiagnosticBag diagnostics)
    {
        for (var i = 0; i < arguments.Length; i++)
        {
            if (i < parameters.Length && parameters[i].RefKind != RefKind.None)
            {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(arguments[i].Syntax), $"a '{parameters[i].RefKind.ToString().ToLowerInvariant()}' argument");
            }

            ValidateExpression(arguments[i], diagnostics);
        }
    }

    private static void ValidateClrArguments(
        System.Collections.Immutable.ImmutableArray<BoundExpression> arguments,
        System.Collections.Immutable.ImmutableArray<RefKind> argumentRefKinds,
        MethodBase method,
        DiagnosticBag diagnostics)
    {
        if (method != null && (method.CallingConvention & CallingConventions.VarArgs) != 0)
        {
            diagnostics.ReportExpressionTreeUnsupported(arguments.Length > 0 ? LocationOf(arguments[0].Syntax) : default, "a varargs call");
        }

        for (var i = 0; i < arguments.Length; i++)
        {
            if (!argumentRefKinds.IsDefaultOrEmpty && i < argumentRefKinds.Length && argumentRefKinds[i] != RefKind.None)
            {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(arguments[i].Syntax), $"a '{argumentRefKinds[i].ToString().ToLowerInvariant()}' argument");
            }

            ValidateExpression(arguments[i], diagnostics);
        }
    }

    private static TextLocation LocationOf(SyntaxNode syntax)
        => syntax != null ? syntax.Location : default;

    private static bool TryValidateObjectInitializer(BoundBlockExpression block, DiagnosticBag diagnostics)
    {
        if (!TryMatchObjectInitializer(block, out var receiver, out var initializer, out var statements))
        {
            return false;
        }

        ValidateExpression(initializer, diagnostics);

        foreach (var statement in statements)
        {
            if (statement is not BoundExpressionStatement expressionStatement)
            {
                diagnostics.ReportExpressionTreeUnsupported(LocationOf(statement.Syntax), "a block expression");
                return true;
            }

            switch (expressionStatement.Expression)
            {
                case BoundFieldAssignmentExpression field when ReferencesReceiver(field, receiver):
                    ValidateExpression(field.Value, diagnostics);
                    break;
                case BoundPropertyAssignmentExpression property when ReferencesReceiver(property.Receiver, receiver):
                    ValidateExpression(property.Value, diagnostics);
                    break;
                case BoundClrPropertyAssignmentExpression clrProperty when ReferencesReceiver(clrProperty.Receiver, receiver):
                    ValidateExpression(clrProperty.Value, diagnostics);
                    break;
                case BoundImportedInstanceCallExpression importedCall when ReferencesReceiver(importedCall.Receiver, receiver):
                case BoundUserInstanceCallExpression userCall when ReferencesReceiver(userCall.Receiver, receiver):
                case BoundClrIndexAssignmentExpression clrIndexAssignment when ReferencesReceiver(clrIndexAssignment, receiver):
                case BoundIndexAssignmentExpression indexAssignment when ReferencesReceiver(indexAssignment, receiver):
                    diagnostics.ReportExpressionTreeUnsupported(LocationOf(expressionStatement.Expression.Syntax), "a collection initializer");
                    return true;
                default:
                    diagnostics.ReportExpressionTreeUnsupported(LocationOf(expressionStatement.Expression.Syntax), "a block expression");
                    return true;
            }
        }

        return true;
    }

    private static bool TryMatchObjectInitializer(
        BoundBlockExpression block,
        out VariableSymbol receiver,
        out BoundExpression initializer,
        out System.Collections.Immutable.ImmutableArray<BoundStatement> statements)
    {
        receiver = null;
        initializer = null;
        statements = default;

        if (block.Expression is not BoundVariableExpression result
            || block.Statements.IsDefaultOrEmpty
            || block.Statements[0] is not BoundVariableDeclaration declaration
            || !ReferenceEquals(declaration.Variable, result.Variable))
        {
            return false;
        }

        receiver = declaration.Variable;
        initializer = declaration.Initializer;
        statements = block.Statements.RemoveAt(0);
        return true;
    }

    private static bool ReferencesReceiver(BoundExpression expression, VariableSymbol receiver)
        => expression is BoundVariableExpression variable && ReferenceEquals(variable.Variable, receiver);

    private static bool ReferencesReceiver(BoundFieldAssignmentExpression assignment, VariableSymbol receiver)
        => ReferenceEquals(assignment.Receiver, receiver)
            || ReferencesReceiver(assignment.ReceiverExpression, receiver);

    private static bool ReferencesReceiver(BoundClrIndexAssignmentExpression assignment, VariableSymbol receiver)
        => ReferenceEquals(assignment.Target, receiver)
            || ReferencesReceiver(assignment.TargetExpression, receiver);

    private static bool ReferencesReceiver(BoundIndexAssignmentExpression assignment, VariableSymbol receiver)
        => ReferenceEquals(assignment.Target, receiver)
            || ReferencesReceiver(assignment.TargetExpression, receiver);
}
