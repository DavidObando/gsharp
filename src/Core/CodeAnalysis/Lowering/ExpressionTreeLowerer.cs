// <copyright file="ExpressionTreeLowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable SA1137 // elements should have the same indentation
#pragma warning disable SA1516 // elements should be separated by blank line

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Issue #2130: lowers lambda-to-<c>Expression&lt;TDelegate&gt;</c>
/// conversions into ordinary bound calls to
/// <c>System.Linq.Expressions.Expression</c> factory methods.
/// </summary>
internal sealed class ExpressionTreeLowerer : NestedFunctionBodyRewriter
{
    private static readonly TypeSymbol SystemTypeSymbol = TypeSymbol.FromClrType(typeof(Type));
    private static readonly TypeSymbol ObjectTypeSymbol = TypeSymbol.Object;
    private static readonly TypeSymbol BindingFlagsTypeSymbol = TypeSymbol.FromClrType(typeof(BindingFlags));
    private static readonly TypeSymbol ReflectionConstructorInfoTypeSymbol = TypeSymbol.FromClrType(typeof(ConstructorInfo));
    private static readonly TypeSymbol ReflectionFieldInfoTypeSymbol = TypeSymbol.FromClrType(typeof(FieldInfo));
    private static readonly TypeSymbol ReflectionPropertyInfoTypeSymbol = TypeSymbol.FromClrType(typeof(PropertyInfo));
    private static readonly TypeSymbol ReflectionMemberInfoTypeSymbol = TypeSymbol.FromClrType(typeof(MemberInfo));
    private static readonly TypeSymbol ExpressionTypeSymbol = TypeSymbol.FromClrType(typeof(System.Linq.Expressions.Expression));
    private static readonly TypeSymbol MemberBindingTypeSymbol = TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberBinding));
    private static readonly TypeSymbol NewExpressionTypeSymbol = TypeSymbol.FromClrType(typeof(System.Linq.Expressions.NewExpression));
    private static readonly TypeSymbol ParameterExpressionTypeSymbol = TypeSymbol.FromClrType(typeof(System.Linq.Expressions.ParameterExpression));

    private static readonly MethodInfo ExpressionParameterMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Parameter),
        typeof(Type),
        typeof(string));
    private static readonly MethodInfo ExpressionConstantMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Constant),
        typeof(object),
        typeof(Type));
    private static readonly MethodInfo ExpressionConstantUntypedMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Constant),
        typeof(object));
    private static readonly MethodInfo ExpressionFieldInstanceMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Field),
        typeof(System.Linq.Expressions.Expression),
        typeof(string));
    private static readonly MethodInfo ExpressionFieldStaticMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Field),
        typeof(System.Linq.Expressions.Expression),
        typeof(Type),
        typeof(string));
    private static readonly MethodInfo ExpressionPropertyInstanceMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Property),
        typeof(System.Linq.Expressions.Expression),
        typeof(string));
    private static readonly MethodInfo ExpressionPropertyStaticMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Property),
        typeof(System.Linq.Expressions.Expression),
        typeof(Type),
        typeof(string));
    private static readonly MethodInfo ExpressionIndexerPropertyMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Property),
        typeof(System.Linq.Expressions.Expression),
        typeof(string),
        typeof(System.Linq.Expressions.Expression[]));
    private static readonly MethodInfo ExpressionCallInstanceMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Call),
        typeof(System.Linq.Expressions.Expression),
        typeof(string),
        typeof(Type[]),
        typeof(System.Linq.Expressions.Expression[]));
    private static readonly MethodInfo ExpressionCallStaticMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Call),
        typeof(Type),
        typeof(string),
        typeof(Type[]),
        typeof(System.Linq.Expressions.Expression[]));
    private static readonly MethodInfo ExpressionLambdaMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Lambda),
        typeof(Type),
        typeof(System.Linq.Expressions.Expression),
        typeof(System.Linq.Expressions.ParameterExpression[]));
    private static readonly MethodInfo ExpressionQuoteMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Quote),
        typeof(System.Linq.Expressions.Expression));
    private static readonly MethodInfo ExpressionConvertMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Convert),
        typeof(System.Linq.Expressions.Expression),
        typeof(Type));
    private static readonly MethodInfo ExpressionConvertWithMethodMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Convert),
        typeof(System.Linq.Expressions.Expression),
        typeof(Type),
        typeof(MethodInfo));
    private static readonly MethodInfo ExpressionTypeAsMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.TypeAs),
        typeof(System.Linq.Expressions.Expression),
        typeof(Type));
    private static readonly MethodInfo ExpressionTypeIsMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.TypeIs),
        typeof(System.Linq.Expressions.Expression),
        typeof(Type));
    private static readonly MethodInfo ExpressionConditionMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Condition),
        typeof(System.Linq.Expressions.Expression),
        typeof(System.Linq.Expressions.Expression),
        typeof(System.Linq.Expressions.Expression));
    private static readonly MethodInfo ExpressionCoalesceMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Coalesce),
        typeof(System.Linq.Expressions.Expression),
        typeof(System.Linq.Expressions.Expression));
    private static readonly MethodInfo ExpressionNewTypeMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.New),
        typeof(Type));
    private static readonly MethodInfo ExpressionNewCtorMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.New),
        typeof(ConstructorInfo),
        typeof(System.Linq.Expressions.Expression[]));
    private static readonly MethodInfo ExpressionMemberInitMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.MemberInit),
        typeof(System.Linq.Expressions.NewExpression),
        typeof(System.Linq.Expressions.MemberBinding[]));
    private static readonly MethodInfo ExpressionBindMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Bind),
        typeof(MemberInfo),
        typeof(System.Linq.Expressions.Expression));
    private static readonly MethodInfo ExpressionNewArrayInitMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.NewArrayInit),
        typeof(Type),
        typeof(System.Linq.Expressions.Expression[]));
    private static readonly MethodInfo ExpressionNewArrayBoundsMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.NewArrayBounds),
        typeof(Type),
        typeof(System.Linq.Expressions.Expression[]));
    private static readonly MethodInfo ExpressionArrayIndexMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.ArrayIndex),
        typeof(System.Linq.Expressions.Expression),
        typeof(System.Linq.Expressions.Expression));
    private static readonly MethodInfo ExpressionDefaultMethod = GetRequiredMethod(
        typeof(System.Linq.Expressions.Expression),
        nameof(System.Linq.Expressions.Expression.Default),
        typeof(Type));
    private static readonly MethodInfo TypeGetConstructorMethod = GetRequiredMethod(
        typeof(Type),
        nameof(Type.GetConstructor),
        typeof(Type[]));
    private static readonly MethodInfo TypeGetFieldMethod = GetRequiredMethod(
        typeof(Type),
        nameof(Type.GetField),
        typeof(string),
        typeof(BindingFlags));
    private static readonly MethodInfo TypeGetPropertyMethod = GetRequiredMethod(
        typeof(Type),
        nameof(Type.GetProperty),
        typeof(string),
        typeof(BindingFlags));

    private int counter;

    public static BoundProgram Lower(BoundProgram program)
    {
        var lowerer = new ExpressionTreeLowerer();
        var changed = false;

        var functions = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
        foreach (var pair in program.Functions)
        {
            var newBody = (BoundBlockStatement)lowerer.RewriteStatement(pair.Value);
            functions[pair.Key] = newBody;
            changed |= newBody != pair.Value;
        }

        var statement = program.Statement;
        if (statement != null)
        {
            var newStatement = (BoundBlockStatement)lowerer.RewriteStatement(statement);
            changed |= newStatement != statement;
            statement = newStatement;
        }

        if (!changed)
        {
            return program;
        }

        return new BoundProgram(
            program.EntryPointPackage,
            program.Packages,
            program.Diagnostics,
            functions.ToImmutable(),
            program.EntryPoint,
            statement,
            program.Structs,
            program.Interfaces,
            program.Enums,
            program.Globals,
            program.Delegates)
        {
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
        };
    }

    protected override BoundExpression RewriteConversionExpression(BoundConversionExpression node)
    {
        if (node.Expression is BoundFunctionLiteralExpression literal
            && MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(node.Type, out _))
        {
            return this.BuildExpressionTreeValue(node.Syntax, literal, node.Type);
        }

        return base.RewriteConversionExpression(node);
    }

    private BoundExpression BuildExpressionTreeValue(
        SyntaxNode syntax,
        BoundFunctionLiteralExpression literal,
        TypeSymbol targetType)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var parameterMap = new Dictionary<VariableSymbol, LocalVariableSymbol>();

        foreach (var parameter in literal.Function.Parameters)
        {
            var local = new LocalVariableSymbol($"<>exprParam{this.counter++}", isReadOnly: true, ParameterExpressionTypeSymbol);
            var initializer = new BoundClrStaticCallExpression(
                syntax,
                ExpressionParameterMethod,
                ParameterExpressionTypeSymbol,
                ImmutableArray.Create<BoundExpression>(
                    CreateTypeOf(parameter.Type),
                    new BoundLiteralExpression(null, parameter.Name, TypeSymbol.String)));
            statements.Add(new BoundVariableDeclaration(syntax, local, initializer));
            parameterMap[parameter] = local;
        }

        var bodySource = ExtractLambdaBodyExpression(literal.Body);
        var body = this.TranslateExpression(bodySource, parameterMap);
        var lambda = new BoundClrStaticCallExpression(
            syntax,
            ExpressionLambdaMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.LambdaExpression)),
            ImmutableArray.Create<BoundExpression>(
                CreateTypeOf(MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(targetType, out var delegateType) ? delegateType : TypeSymbol.Error),
                UpcastToExpression(body),
                BuildParameterArray(parameterMap.Values)));

        var cast = new BoundConversionExpression(syntax, targetType, lambda);
        return new BoundBlockExpression(syntax, statements.ToImmutable(), cast);
    }

    private BoundExpression TranslateExpression(
        BoundExpression expression,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        switch (expression)
        {
            case BoundLiteralExpression literal:
                return BuildLiteralExpressionNode(literal);
            case BoundDefaultExpression @default:
                return new BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionDefaultMethod,
                    TypeSymbol.FromClrType(typeof(System.Linq.Expressions.DefaultExpression)),
                    ImmutableArray.Create<BoundExpression>(CreateTypeOf(@default.Type)));
            case BoundTypeOfExpression typeOf:
                return BuildRuntimeConstant(typeOf, SystemTypeSymbol);
            case BoundVariableExpression variable:
                if (parameterMap.TryGetValue(variable.Variable, out var parameterLocal))
                {
                    return new BoundVariableExpression(expression.Syntax, parameterLocal);
                }

                return BuildRuntimeConstant(variable, variable.Type);
            case BoundFieldAccessExpression field:
                return BuildFieldAccessExpression(field, parameterMap);
            case BoundPropertyAccessExpression property:
                return BuildPropertyAccessExpression(property, parameterMap);
            case BoundClrPropertyAccessExpression clrProperty:
                return BuildClrPropertyAccessExpression(clrProperty, parameterMap);
            case BoundIndexExpression index:
                return new BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionArrayIndexMethod,
                    TypeSymbol.FromClrType(typeof(System.Linq.Expressions.BinaryExpression)),
                    ImmutableArray.Create<BoundExpression>(
                        UpcastToExpression(this.TranslateExpression(index.Target, parameterMap)),
                        UpcastToExpression(this.TranslateExpression(index.Index, parameterMap))));
            case BoundClrIndexExpression clrIndex:
                return new BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionIndexerPropertyMethod,
                    TypeSymbol.FromClrType(typeof(System.Linq.Expressions.IndexExpression)),
                    ImmutableArray.Create<BoundExpression>(
                        UpcastToExpression(this.TranslateExpression(clrIndex.Target, parameterMap)),
                        new BoundLiteralExpression(null, clrIndex.Indexer.Name, TypeSymbol.String),
                        BuildExpressionArray(TranslateArguments(clrIndex.Arguments, clrIndex.Indexer.GetIndexParameters(), parameterMap))));
            case BoundUnaryExpression unary:
                return BuildUnaryExpression(unary, parameterMap);
            case BoundBinaryExpression binary:
                return BuildBinaryExpression(binary, parameterMap);
            case BoundConditionalExpression conditional:
                return new BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionConditionMethod,
                    TypeSymbol.FromClrType(typeof(System.Linq.Expressions.ConditionalExpression)),
                    ImmutableArray.Create<BoundExpression>(
                        UpcastToExpression(this.TranslateExpression(conditional.Condition, parameterMap)),
                        UpcastToExpression(this.TranslateExpression(conditional.WhenTrue, parameterMap)),
                        UpcastToExpression(this.TranslateExpression(conditional.WhenFalse, parameterMap))));
            case BoundIsExpression isExpression:
                return new BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionTypeIsMethod,
                    TypeSymbol.FromClrType(typeof(System.Linq.Expressions.TypeBinaryExpression)),
                    ImmutableArray.Create<BoundExpression>(
                        UpcastToExpression(this.TranslateExpression(isExpression.Expression, parameterMap)),
                        CreateTypeOf(isExpression.TargetType)));
            case BoundAsExpression asExpression:
                return new BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionTypeAsMethod,
                    TypeSymbol.FromClrType(typeof(System.Linq.Expressions.UnaryExpression)),
                    ImmutableArray.Create<BoundExpression>(
                        UpcastToExpression(this.TranslateExpression(asExpression.Expression, parameterMap)),
                        CreateTypeOf(asExpression.TargetType)));
            case BoundArrayCreationExpression array:
                return BuildArrayCreationExpression(array, parameterMap);
            case BoundConstructorCallExpression ctor:
                return BuildUserConstructorExpression(ctor, parameterMap);
            case BoundClrConstructorCallExpression clrCtor:
                return BuildClrConstructorExpression(clrCtor, parameterMap);
            case BoundConversionExpression conversion:
                return BuildConversionExpression(conversion, parameterMap);
            case BoundImportedInstanceCallExpression importedInstance:
                return BuildImportedInstanceCallExpression(importedInstance, parameterMap);
            case BoundImportedCallExpression importedCall:
                return BuildImportedStaticCallExpression(importedCall, parameterMap);
            case BoundClrStaticCallExpression clrStaticCall:
                return BuildClrStaticMethodCallExpression(clrStaticCall, parameterMap);
            case BoundUserInstanceCallExpression userInstanceCall:
                return BuildUserInstanceCallExpression(userInstanceCall, parameterMap);
            case BoundCallExpression userStaticCall:
                return BuildUserStaticCallExpression(userStaticCall, parameterMap);
            case BoundClrBinaryOperatorExpression clrBinary:
                return BuildClrBinaryOperatorExpression(clrBinary, parameterMap);
            case BoundClrUnaryOperatorExpression clrUnary:
                return BuildClrUnaryOperatorExpression(clrUnary, parameterMap);
            case BoundFunctionLiteralExpression nestedDelegateLiteral:
                return BuildRuntimeConstant(nestedDelegateLiteral, nestedDelegateLiteral.Type);
            case BoundBlockExpression block when this.TryBuildObjectInitializerExpression(block, parameterMap, out var objectInitializer):
                return objectInitializer;
            default:
                throw new NotSupportedException($"Unsupported expression-tree lowering node: {expression.Kind}.");
        }
    }

    private BoundExpression BuildLiteralExpressionNode(BoundLiteralExpression literal)
    {
        if (literal.Value == null && literal.Type == TypeSymbol.Null)
        {
            return new BoundClrStaticCallExpression(
                literal.Syntax,
                ExpressionConstantUntypedMethod,
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.ConstantExpression)),
                ImmutableArray.Create<BoundExpression>(new BoundLiteralExpression(null, null, TypeSymbol.Null)));
        }

        return BuildRuntimeConstant(literal, literal.Type);
    }

    private BoundExpression BuildRuntimeConstant(BoundExpression runtimeValue, TypeSymbol runtimeType)
    {
        return new BoundClrStaticCallExpression(
            runtimeValue.Syntax,
            ExpressionConstantMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.ConstantExpression)),
            ImmutableArray.Create<BoundExpression>(
                new BoundConversionExpression(null, ObjectTypeSymbol, runtimeValue),
                CreateTypeOf(runtimeType)));
    }

    private BoundExpression BuildFieldAccessExpression(
        BoundFieldAccessExpression field,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        if (field.Receiver == null)
        {
            var owner = field.InterfaceType as TypeSymbol ?? field.StructType;
            return new BoundClrStaticCallExpression(
                field.Syntax,
                ExpressionFieldStaticMethod,
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberExpression)),
                ImmutableArray.Create<BoundExpression>(
                    new BoundLiteralExpression(null, null, TypeSymbol.Null),
                    CreateTypeOf(owner),
                    new BoundLiteralExpression(null, field.Field.Name, TypeSymbol.String)));
        }

        return new BoundClrStaticCallExpression(
            field.Syntax,
            ExpressionFieldInstanceMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberExpression)),
            ImmutableArray.Create<BoundExpression>(
                UpcastToExpression(this.TranslateExpression(field.Receiver, parameterMap)),
                new BoundLiteralExpression(null, field.Field.Name, TypeSymbol.String)));
    }

    private BoundExpression BuildPropertyAccessExpression(
        BoundPropertyAccessExpression property,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        if (property.Receiver == null)
        {
            return new BoundClrStaticCallExpression(
                property.Syntax,
                ExpressionPropertyStaticMethod,
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberExpression)),
                ImmutableArray.Create<BoundExpression>(
                    new BoundLiteralExpression(null, null, TypeSymbol.Null),
                    CreateTypeOf(property.StructType),
                    new BoundLiteralExpression(null, property.Property.Name, TypeSymbol.String)));
        }

        return new BoundClrStaticCallExpression(
            property.Syntax,
            ExpressionPropertyInstanceMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberExpression)),
            ImmutableArray.Create<BoundExpression>(
                UpcastToExpression(this.TranslateExpression(property.Receiver, parameterMap)),
                new BoundLiteralExpression(null, property.Property.Name, TypeSymbol.String)));
    }

    private BoundExpression BuildClrPropertyAccessExpression(
        BoundClrPropertyAccessExpression property,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        var memberName = property.Member.Name;
        var ownerType = property.StaticContainerType ?? TypeSymbol.FromClrType(property.Member.DeclaringType);
        var isField = property.Member is FieldInfo;
        var staticMethod = isField ? ExpressionFieldStaticMethod : ExpressionPropertyStaticMethod;
        var instanceMethod = isField ? ExpressionFieldInstanceMethod : ExpressionPropertyInstanceMethod;

        if (property.Receiver == null)
        {
            return new BoundClrStaticCallExpression(
                property.Syntax,
                staticMethod,
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberExpression)),
                ImmutableArray.Create<BoundExpression>(
                    new BoundLiteralExpression(null, null, TypeSymbol.Null),
                    CreateTypeOf(ownerType),
                    new BoundLiteralExpression(null, memberName, TypeSymbol.String)));
        }

        return new BoundClrStaticCallExpression(
            property.Syntax,
            instanceMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberExpression)),
            ImmutableArray.Create<BoundExpression>(
                UpcastToExpression(this.TranslateExpression(property.Receiver, parameterMap)),
                new BoundLiteralExpression(null, memberName, TypeSymbol.String)));
    }

    private BoundExpression BuildUnaryExpression(
        BoundUnaryExpression unary,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        var operand = UpcastToExpression(this.TranslateExpression(unary.Operand, parameterMap));
        var method = unary.Op.Kind switch
        {
            BoundUnaryOperatorKind.Identity => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.UnaryPlus), typeof(System.Linq.Expressions.Expression)),
            BoundUnaryOperatorKind.Negation => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Negate), typeof(System.Linq.Expressions.Expression)),
            BoundUnaryOperatorKind.LogicalNegation => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Not), typeof(System.Linq.Expressions.Expression)),
            BoundUnaryOperatorKind.OnesComplement => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Not), typeof(System.Linq.Expressions.Expression)),
            _ => throw new NotSupportedException($"Unsupported unary operator '{unary.Op.Kind}' in expression-tree lowering."),
        };

        return new BoundClrStaticCallExpression(
            unary.Syntax,
            method,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.UnaryExpression)),
            ImmutableArray.Create(operand));
    }

    private BoundExpression BuildBinaryExpression(
        BoundBinaryExpression binary,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        if (binary.Op.Kind == BoundBinaryOperatorKind.BitClear)
        {
            var left = UpcastToExpression(this.TranslateExpression(binary.Left, parameterMap));
            var rightNot = new BoundClrStaticCallExpression(
                binary.Syntax,
                GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Not), typeof(System.Linq.Expressions.Expression)),
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.UnaryExpression)),
                ImmutableArray.Create(UpcastToExpression(this.TranslateExpression(binary.Right, parameterMap))));
            return new BoundClrStaticCallExpression(
                binary.Syntax,
                GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.And), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.BinaryExpression)),
                ImmutableArray.Create(left, UpcastToExpression(rightNot)));
        }

        var leftExpr = UpcastToExpression(this.TranslateExpression(binary.Left, parameterMap));
        var rightExpr = UpcastToExpression(this.TranslateExpression(binary.Right, parameterMap));
        var method = binary.Op.Kind switch
        {
            BoundBinaryOperatorKind.Sum when binary.Type == TypeSymbol.String => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Add), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression), typeof(MethodInfo)),
            BoundBinaryOperatorKind.Sum => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Add), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.Difference => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Subtract), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.Product => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Multiply), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.Quotient => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Divide), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.Remainder => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Modulo), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.ShiftLeft => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.LeftShift), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.ShiftRight => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.RightShift), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.BitwiseAnd => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.And), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.BitwiseOr => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Or), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.BitwiseXor => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.ExclusiveOr), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.Equals => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.Equal), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.NotEquals => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.NotEqual), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.Less => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.LessThan), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.LessOrEquals => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.LessThanOrEqual), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.Greater => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.GreaterThan), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.GreaterOrEquals => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.GreaterThanOrEqual), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.LogicalAnd => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.AndAlso), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.LogicalOr => GetRequiredMethod(typeof(System.Linq.Expressions.Expression), nameof(System.Linq.Expressions.Expression.OrElse), typeof(System.Linq.Expressions.Expression), typeof(System.Linq.Expressions.Expression)),
            BoundBinaryOperatorKind.NullCoalesce => ExpressionCoalesceMethod,
            _ => throw new NotSupportedException($"Unsupported binary operator '{binary.Op.Kind}' in expression-tree lowering."),
        };

        if (binary.Op.Kind == BoundBinaryOperatorKind.Sum && binary.Type == TypeSymbol.String)
        {
            var concat = GetRequiredMethod(typeof(string), nameof(string.Concat), typeof(string), typeof(string));
            return new BoundClrStaticCallExpression(
                binary.Syntax,
                method,
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.BinaryExpression)),
                ImmutableArray.Create<BoundExpression>(leftExpr, rightExpr, BuildMethodInfoConstant(concat)));
        }

        return new BoundClrStaticCallExpression(
            binary.Syntax,
            method,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.BinaryExpression)),
            ImmutableArray.Create(leftExpr, rightExpr));
    }

    private BoundExpression BuildArrayCreationExpression(
        BoundArrayCreationExpression array,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        if (array.LengthExpression != null)
        {
            return new BoundClrStaticCallExpression(
                array.Syntax,
                ExpressionNewArrayBoundsMethod,
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.NewArrayExpression)),
                ImmutableArray.Create<BoundExpression>(
                    CreateTypeOf(array.ElementType),
                    BuildExpressionArray(new[] { this.TranslateExpression(array.LengthExpression, parameterMap) })));
        }

        var elements = new List<BoundExpression>(array.Elements.Length);
        foreach (var element in array.Elements)
        {
            elements.Add(this.TranslateExpression(element, parameterMap));
        }

        return new BoundClrStaticCallExpression(
            array.Syntax,
            ExpressionNewArrayInitMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.NewArrayExpression)),
            ImmutableArray.Create<BoundExpression>(
                CreateTypeOf(array.ElementType),
                BuildExpressionArray(elements)));
    }

    private BoundExpression BuildUserConstructorExpression(
        BoundConstructorCallExpression constructor,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        if (constructor.Arguments.IsDefaultOrEmpty || constructor.Arguments.Length == 0)
        {
            return new BoundClrStaticCallExpression(
                constructor.Syntax,
                ExpressionNewTypeMethod,
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.NewExpression)),
                ImmutableArray.Create<BoundExpression>(CreateTypeOf(constructor.StructType)));
        }

        var ctorInfo = new BoundImportedInstanceCallExpression(
            constructor.Syntax,
            CreateTypeOf(constructor.StructType),
            TypeGetConstructorMethod,
            ReflectionConstructorInfoTypeSymbol,
            ImmutableArray.Create<BoundExpression>(BuildTypeArray(GetArgumentTypes(constructor.Arguments))));

        return new BoundClrStaticCallExpression(
            constructor.Syntax,
            ExpressionNewCtorMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.NewExpression)),
            ImmutableArray.Create<BoundExpression>(
                ctorInfo,
                BuildExpressionArray(TranslateArguments(constructor.Arguments, GetArgumentTypes(constructor.Arguments), parameterMap))));
    }

    private BoundExpression BuildClrConstructorExpression(
        BoundClrConstructorCallExpression constructor,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        if (constructor.Arguments.IsDefaultOrEmpty || constructor.Arguments.Length == 0)
        {
            return new BoundClrStaticCallExpression(
                constructor.Syntax,
                ExpressionNewTypeMethod,
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.NewExpression)),
                ImmutableArray.Create<BoundExpression>(CreateTypeOf(constructor.Type)));
        }

        var ctorInfo = new BoundImportedInstanceCallExpression(
            constructor.Syntax,
            CreateTypeOf(constructor.Type),
            TypeGetConstructorMethod,
            ReflectionConstructorInfoTypeSymbol,
            ImmutableArray.Create<BoundExpression>(BuildTypeArray(GetArgumentTypes(constructor.Arguments))));

        return new BoundClrStaticCallExpression(
            constructor.Syntax,
            ExpressionNewCtorMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.NewExpression)),
            ImmutableArray.Create<BoundExpression>(
                ctorInfo,
                BuildExpressionArray(TranslateArguments(constructor.Arguments, GetArgumentTypes(constructor.Arguments), parameterMap))));
    }

    private BoundExpression BuildConversionExpression(
        BoundConversionExpression conversion,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        if (conversion.Expression is BoundFunctionLiteralExpression nestedLiteral
            && MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(conversion.Type, out _))
        {
            return this.BuildExpressionTreeValue(conversion.Syntax, nestedLiteral, conversion.Type);
        }

        if (conversion.Expression is BoundFunctionLiteralExpression
            || conversion.Expression is BoundMethodGroupExpression
            || conversion.Expression is BoundClrMethodGroupExpression)
        {
            return BuildRuntimeConstant(conversion, conversion.Type);
        }

        var methodInfo = conversion switch
        {
            BoundConversionExpression { Expression: BoundClrConversionCallExpression clrConversion } => BuildMethodInfoConstant(clrConversion.Method),
            _ => null,
        };

        if (methodInfo != null)
        {
            return new BoundClrStaticCallExpression(
                conversion.Syntax,
                ExpressionConvertWithMethodMethod,
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.UnaryExpression)),
                ImmutableArray.Create<BoundExpression>(
                    UpcastToExpression(this.TranslateExpression(conversion.Expression, parameterMap)),
                    CreateTypeOf(conversion.Type),
                    methodInfo));
        }

        return new BoundClrStaticCallExpression(
            conversion.Syntax,
            ExpressionConvertMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.UnaryExpression)),
            ImmutableArray.Create<BoundExpression>(
                UpcastToExpression(this.TranslateExpression(conversion.Expression, parameterMap)),
                CreateTypeOf(conversion.Type)));
    }

    private BoundExpression BuildImportedInstanceCallExpression(
        BoundImportedInstanceCallExpression call,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        return new BoundClrStaticCallExpression(
            call.Syntax,
            ExpressionCallInstanceMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MethodCallExpression)),
            ImmutableArray.Create<BoundExpression>(
                UpcastToExpression(this.TranslateExpression(call.Receiver, parameterMap)),
                new BoundLiteralExpression(null, call.Method.Name, TypeSymbol.String),
                BuildTypeArray(GetTypeSymbols(call.TypeArgumentSymbols)),
                BuildExpressionArray(TranslateArguments(call.Arguments, call.Method.GetParameters(), parameterMap))));
    }

    private BoundExpression BuildImportedStaticCallExpression(
        BoundImportedCallExpression call,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        return new BoundClrStaticCallExpression(
            call.Syntax,
            ExpressionCallStaticMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MethodCallExpression)),
            ImmutableArray.Create<BoundExpression>(
                CreateTypeOf(TypeSymbol.FromClrType(call.Function.Method.DeclaringType)),
                new BoundLiteralExpression(null, call.Function.Method.Name, TypeSymbol.String),
                BuildTypeArray(GetTypeSymbols(call.TypeArgumentSymbols)),
                BuildExpressionArray(TranslateArguments(call.Arguments, call.Function.Method.GetParameters(), parameterMap))));
    }

    private BoundExpression BuildClrStaticMethodCallExpression(
        BoundClrStaticCallExpression call,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        return new BoundClrStaticCallExpression(
            call.Syntax,
            ExpressionCallStaticMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MethodCallExpression)),
            ImmutableArray.Create<BoundExpression>(
                CreateTypeOf(TypeSymbol.FromClrType(call.Method.DeclaringType)),
                new BoundLiteralExpression(null, call.Method.Name, TypeSymbol.String),
                BuildTypeArray(ImmutableArray<TypeSymbol>.Empty),
                BuildExpressionArray(TranslateArguments(call.Arguments, call.Method.GetParameters(), parameterMap))));
    }

    private BoundExpression BuildUserInstanceCallExpression(
        BoundUserInstanceCallExpression call,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        return new BoundClrStaticCallExpression(
            call.Syntax,
            ExpressionCallInstanceMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MethodCallExpression)),
            ImmutableArray.Create<BoundExpression>(
                UpcastToExpression(this.TranslateExpression(call.Receiver, parameterMap)),
                new BoundLiteralExpression(null, call.Method.Name, TypeSymbol.String),
                BuildTypeArray(GetTypeSymbols(call.MethodTypeArguments)),
                BuildExpressionArray(TranslateArguments(call.Arguments, GetCallableParameters(call.Method), parameterMap))));
    }

    private BoundExpression BuildUserStaticCallExpression(
        BoundCallExpression call,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        if (call.Function.StaticOwnerType == null)
        {
            throw new NotSupportedException($"Top-level function '{call.Function.Name}' is not supported inside expression trees.");
        }

        return new BoundClrStaticCallExpression(
            call.Syntax,
            ExpressionCallStaticMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MethodCallExpression)),
            ImmutableArray.Create<BoundExpression>(
                CreateTypeOf(call.Function.StaticOwnerType),
                new BoundLiteralExpression(null, call.Function.Name, TypeSymbol.String),
                BuildTypeArray(GetTypeSymbols(call.MethodTypeArguments)),
                BuildExpressionArray(TranslateArguments(call.Arguments, GetCallableParameters(call.Function), parameterMap))));
    }

    private BoundExpression BuildClrBinaryOperatorExpression(
        BoundClrBinaryOperatorExpression expression,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        var methodName = expression.OperatorKind switch
        {
            SyntaxKind.PlusToken => nameof(System.Linq.Expressions.Expression.Add),
            SyntaxKind.MinusToken => nameof(System.Linq.Expressions.Expression.Subtract),
            SyntaxKind.StarToken => nameof(System.Linq.Expressions.Expression.Multiply),
            SyntaxKind.SlashToken => nameof(System.Linq.Expressions.Expression.Divide),
            SyntaxKind.PercentToken => nameof(System.Linq.Expressions.Expression.Modulo),
            SyntaxKind.EqualsEqualsToken => nameof(System.Linq.Expressions.Expression.Equal),
            SyntaxKind.BangEqualsToken => nameof(System.Linq.Expressions.Expression.NotEqual),
            SyntaxKind.LessToken => nameof(System.Linq.Expressions.Expression.LessThan),
            SyntaxKind.LessOrEqualsToken => nameof(System.Linq.Expressions.Expression.LessThanOrEqual),
            SyntaxKind.GreaterToken => nameof(System.Linq.Expressions.Expression.GreaterThan),
            SyntaxKind.GreaterOrEqualsToken => nameof(System.Linq.Expressions.Expression.GreaterThanOrEqual),
            SyntaxKind.AmpersandToken => nameof(System.Linq.Expressions.Expression.And),
            SyntaxKind.PipeToken => nameof(System.Linq.Expressions.Expression.Or),
            SyntaxKind.HatToken => nameof(System.Linq.Expressions.Expression.ExclusiveOr),
            SyntaxKind.ShiftLeftToken => nameof(System.Linq.Expressions.Expression.LeftShift),
            SyntaxKind.ShiftRightToken => nameof(System.Linq.Expressions.Expression.RightShift),
            SyntaxKind.AmpersandAmpersandToken => nameof(System.Linq.Expressions.Expression.AndAlso),
            SyntaxKind.PipePipeToken => nameof(System.Linq.Expressions.Expression.OrElse),
            _ => throw new NotSupportedException($"Unsupported CLR binary operator token '{expression.OperatorKind}'."),
        };

        var factory = GetRequiredMethod(
            typeof(System.Linq.Expressions.Expression),
            methodName,
            typeof(System.Linq.Expressions.Expression),
            typeof(System.Linq.Expressions.Expression),
            typeof(MethodInfo));

        return new BoundClrStaticCallExpression(
            expression.Syntax,
            factory,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.BinaryExpression)),
            ImmutableArray.Create<BoundExpression>(
                UpcastToExpression(this.TranslateExpression(expression.Left, parameterMap)),
                UpcastToExpression(this.TranslateExpression(expression.Right, parameterMap)),
                BuildMethodInfoConstant(expression.Method)));
    }

    private BoundExpression BuildClrUnaryOperatorExpression(
        BoundClrUnaryOperatorExpression expression,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        var methodName = expression.OperatorKind switch
        {
            SyntaxKind.PlusToken => nameof(System.Linq.Expressions.Expression.UnaryPlus),
            SyntaxKind.MinusToken => nameof(System.Linq.Expressions.Expression.Negate),
            SyntaxKind.BangToken => nameof(System.Linq.Expressions.Expression.Not),
            SyntaxKind.HatToken => nameof(System.Linq.Expressions.Expression.Not),
            _ => throw new NotSupportedException($"Unsupported CLR unary operator token '{expression.OperatorKind}'."),
        };

        var factory = GetRequiredMethod(
            typeof(System.Linq.Expressions.Expression),
            methodName,
            typeof(System.Linq.Expressions.Expression),
            typeof(MethodInfo));

        return new BoundClrStaticCallExpression(
            expression.Syntax,
            factory,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.UnaryExpression)),
            ImmutableArray.Create<BoundExpression>(
                UpcastToExpression(this.TranslateExpression(expression.Operand, parameterMap)),
                BuildMethodInfoConstant(expression.Method)));
    }

    private bool TryBuildObjectInitializerExpression(
        BoundBlockExpression block,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap,
        out BoundExpression expression)
    {
        expression = null;

        if (!TryMatchObjectInitializer(block, out var tempVariable, out var initializer, out var statements))
        {
            return false;
        }

        var translatedInitializer = this.TranslateExpression(initializer, parameterMap);
        if (statements.Length == 0)
        {
            expression = translatedInitializer;
            return true;
        }

        var bindings = ImmutableArray.CreateBuilder<BoundExpression>(statements.Length);
        foreach (var statement in statements)
        {
            if (statement is not BoundExpressionStatement expressionStatement
                || !this.TryBuildMemberBinding(expressionStatement.Expression, tempVariable, parameterMap, out var binding))
            {
                return false;
            }

            bindings.Add(binding);
        }

        expression = new BoundClrStaticCallExpression(
            block.Syntax,
            ExpressionMemberInitMethod,
            TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberInitExpression)),
            ImmutableArray.Create<BoundExpression>(
                translatedInitializer.Type == NewExpressionTypeSymbol
                    ? translatedInitializer
                    : new BoundConversionExpression(null, NewExpressionTypeSymbol, translatedInitializer),
                BuildMemberBindingArray(bindings)));
        return true;
    }

    private bool TryBuildMemberBinding(
        BoundExpression expression,
        VariableSymbol receiver,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap,
        out BoundExpression binding)
    {
        binding = expression switch
        {
            BoundFieldAssignmentExpression field when ReferencesReceiver(field, receiver) =>
                new BoundClrStaticCallExpression(
                    field.Syntax,
                    ExpressionBindMethod,
                    TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberAssignment)),
                    ImmutableArray.Create<BoundExpression>(
                        BuildUserFieldInfoLookup(field.StructType, field.Field.Name),
                        UpcastToExpression(this.TranslateExpression(field.Value, parameterMap)))),
            BoundPropertyAssignmentExpression property when ReferencesReceiver(property.Receiver, receiver) =>
                new BoundClrStaticCallExpression(
                    property.Syntax,
                    ExpressionBindMethod,
                    TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberAssignment)),
                    ImmutableArray.Create<BoundExpression>(
                        BuildUserPropertyInfoLookup(property.StructType, property.Property.Name),
                        UpcastToExpression(this.TranslateExpression(property.Value, parameterMap)))),
            BoundClrPropertyAssignmentExpression clrProperty when ReferencesReceiver(clrProperty.Receiver, receiver) =>
                new BoundClrStaticCallExpression(
                    clrProperty.Syntax,
                    ExpressionBindMethod,
                    TypeSymbol.FromClrType(typeof(System.Linq.Expressions.MemberAssignment)),
                    ImmutableArray.Create<BoundExpression>(
                        BuildMemberInfoConstant(clrProperty.Member),
                        UpcastToExpression(this.TranslateExpression(clrProperty.Value, parameterMap)))),
            _ => null,
        };

        return binding != null;
    }

    private ImmutableArray<BoundExpression> TranslateArguments(
        ImmutableArray<BoundExpression> arguments,
        ParameterInfo[] parameters,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        var builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            var expectedType = i < parameters.Length ? TypeSymbol.FromClrType(parameters[i].ParameterType) : null;
            builder.Add(this.TranslateArgument(arguments[i], expectedType, parameterMap));
        }

        return builder.MoveToImmutable();
    }

    private ImmutableArray<BoundExpression> TranslateArguments(
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<ParameterSymbol> parameters,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        var builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            var expectedType = i < parameters.Length ? parameters[i].Type : null;
            builder.Add(this.TranslateArgument(arguments[i], expectedType, parameterMap));
        }

        return builder.MoveToImmutable();
    }

    private ImmutableArray<BoundExpression> TranslateArguments(
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<TypeSymbol> parameterTypes,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        var builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            var expectedType = i < parameterTypes.Length ? parameterTypes[i] : null;
            builder.Add(this.TranslateArgument(arguments[i], expectedType, parameterMap));
        }

        return builder.MoveToImmutable();
    }

    private BoundExpression TranslateArgument(
        BoundExpression argument,
        TypeSymbol expectedType,
        Dictionary<VariableSymbol, LocalVariableSymbol> parameterMap)
    {
        if (expectedType != null
            && MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(expectedType, out _)
            && (argument is BoundFunctionLiteralExpression
                || argument is BoundConversionExpression { Expression: BoundFunctionLiteralExpression }))
        {
            var lambda = argument is BoundFunctionLiteralExpression directLambda
                ? directLambda
                : (BoundFunctionLiteralExpression)((BoundConversionExpression)argument).Expression;
            var nested = this.BuildExpressionTreeValue(argument.Syntax, lambda, expectedType);
            return new BoundClrStaticCallExpression(
                argument.Syntax,
                ExpressionQuoteMethod,
                TypeSymbol.FromClrType(typeof(System.Linq.Expressions.UnaryExpression)),
                ImmutableArray.Create(UpcastToExpression(nested)));
        }

        if (expectedType != null
            && IsDelegateLike(expectedType)
            && (argument is BoundFunctionLiteralExpression
                || argument is BoundConversionExpression { Expression: BoundFunctionLiteralExpression or BoundMethodGroupExpression or BoundClrMethodGroupExpression }
                || argument is BoundMethodGroupExpression
                || argument is BoundClrMethodGroupExpression))
        {
            var converted = argument.Type == expectedType
                ? argument
                : new BoundConversionExpression(argument.Syntax, expectedType, argument);
            return BuildRuntimeConstant(converted, expectedType);
        }

        return this.TranslateExpression(argument, parameterMap);
    }

    private static BoundExpression BuildMethodInfoConstant(MethodInfo method)
        => new BoundLiteralExpression(null, method, TypeSymbol.FromClrType(typeof(MethodInfo)));

    private static BoundExpression BuildMemberInfoConstant(MemberInfo member)
        => new BoundLiteralExpression(null, member, ReflectionMemberInfoTypeSymbol);

    private static BoundExpression BuildUserFieldInfoLookup(TypeSymbol ownerType, string memberName)
    {
        return new BoundImportedInstanceCallExpression(
            null,
            CreateTypeOf(ownerType),
            TypeGetFieldMethod,
            ReflectionFieldInfoTypeSymbol,
            ImmutableArray.Create<BoundExpression>(
                new BoundLiteralExpression(null, memberName, TypeSymbol.String),
                BuildBindingFlagsConstant(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)));
    }

    private static BoundExpression BuildUserPropertyInfoLookup(TypeSymbol ownerType, string memberName)
    {
        return new BoundImportedInstanceCallExpression(
            null,
            CreateTypeOf(ownerType),
            TypeGetPropertyMethod,
            ReflectionPropertyInfoTypeSymbol,
            ImmutableArray.Create<BoundExpression>(
                new BoundLiteralExpression(null, memberName, TypeSymbol.String),
                BuildBindingFlagsConstant(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)));
    }

    private static BoundExpression CreateTypeOf(TypeSymbol type)
        => new BoundTypeOfExpression(null, type, SystemTypeSymbol);

    private static BoundExpression UpcastToExpression(BoundExpression expression)
        => expression.Type == ExpressionTypeSymbol ? expression : new BoundConversionExpression(null, ExpressionTypeSymbol, expression);

    private static BoundExpression BuildTypeArray(IEnumerable<TypeSymbol> types)
    {
        var elements = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var type in types)
        {
            elements.Add(CreateTypeOf(type));
        }

        return new BoundArrayCreationExpression(
            null,
            ArrayTypeSymbol.Get(SystemTypeSymbol, elements.Count),
            elements.ToImmutable());
    }

    private static BoundExpression BuildExpressionArray(IEnumerable<BoundExpression> expressions)
    {
        var elements = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var expression in expressions)
        {
            elements.Add(UpcastToExpression(expression));
        }

        return new BoundArrayCreationExpression(
            null,
            ArrayTypeSymbol.Get(ExpressionTypeSymbol, elements.Count),
            elements.ToImmutable());
    }

    private static BoundExpression BuildParameterArray(IEnumerable<LocalVariableSymbol> parameters)
    {
        var elements = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var parameter in parameters)
        {
            elements.Add(new BoundVariableExpression(null, parameter));
        }

        return new BoundArrayCreationExpression(
            null,
            ArrayTypeSymbol.Get(ParameterExpressionTypeSymbol, elements.Count),
            elements.ToImmutable());
    }

    private static BoundExpression BuildMemberBindingArray(IEnumerable<BoundExpression> bindings)
    {
        var elements = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var binding in bindings)
        {
            elements.Add(binding.Type == MemberBindingTypeSymbol ? binding : new BoundConversionExpression(null, MemberBindingTypeSymbol, binding));
        }

        return new BoundArrayCreationExpression(
            null,
            ArrayTypeSymbol.Get(MemberBindingTypeSymbol, elements.Count),
            elements.ToImmutable());
    }

    private static BoundExpression BuildBindingFlagsConstant(BindingFlags flags)
        => new BoundConversionExpression(
            null,
            BindingFlagsTypeSymbol,
            new BoundLiteralExpression(null, (int)flags, TypeSymbol.Int32));

    private static ImmutableArray<TypeSymbol> GetArgumentTypes(ImmutableArray<BoundExpression> arguments)
    {
        var builder = ImmutableArray.CreateBuilder<TypeSymbol>(arguments.Length);
        foreach (var argument in arguments)
        {
            builder.Add(argument.Type);
        }

        return builder.MoveToImmutable();
    }

    private static ImmutableArray<TypeSymbol> GetTypeSymbols(ImmutableArray<TypeSymbol> types)
        => types.IsDefault ? ImmutableArray<TypeSymbol>.Empty : types;

    private static ImmutableArray<ParameterSymbol> GetCallableParameters(FunctionSymbol function)
    {
        if (function.ExplicitReceiverParameter == null)
        {
            return function.Parameters;
        }

        return function.Parameters.RemoveAt(0);
    }

    private static BoundExpression ExtractLambdaBodyExpression(BoundBlockStatement body)
    {
        BoundExpression candidate = null;
        foreach (var statement in body.Statements)
        {
            switch (statement)
            {
                case BoundReturnStatement { Expression: not null } ret:
                    return ret.Expression;
                case BoundExpressionStatement exprStmt:
                    candidate = exprStmt.Expression;
                    break;
            }
        }

        return candidate
            ?? throw new NotSupportedException("Expression-tree lambda body did not contain a supported trailing expression.");
    }

    private static bool TryMatchObjectInitializer(
        BoundBlockExpression block,
        out VariableSymbol receiver,
        out BoundExpression initializer,
        out ImmutableArray<BoundStatement> statements)
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

    private static bool IsDelegateLike(TypeSymbol type)
        => MemberLookup.TryGetDelegateFunctionTypeFromSymbol(type, out _);

    private static MethodInfo GetRequiredMethod(Type type, string name, params Type[] parameterTypes)
        => type.GetMethod(name, parameterTypes)
            ?? throw new InvalidOperationException($"Required method '{type.FullName}.{name}' is not available.");
}

#pragma warning restore SA1516 // elements should be separated by blank line
#pragma warning restore SA1137 // elements should have the same indentation
