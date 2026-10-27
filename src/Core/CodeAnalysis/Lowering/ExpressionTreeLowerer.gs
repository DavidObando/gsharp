// <copyright file="ExpressionTreeLowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Reflection
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import ReflectionBinder = System.Reflection.Binder
import GSharp.Core.CodeAnalysis
import System.Linq
import System.Linq.Expressions

/// Issue #2130: lowers lambda-to-`Expression<TDelegate>`
/// conversions into ordinary bound calls to
/// `System.Linq.Expressions.Expression` factory methods.
internal class ExpressionTreeLowerer : NestedFunctionBodyRewriter {
    private var counter int32

    protected override func RewriteConversionExpression(node BoundConversionExpression) BoundExpression {
        if node.Expression is BoundFunctionLiteralExpression literal &&
            MemberLookup
            .TryGetExpressionTreeDelegateTypeFromSymbol(node.Type, out _) {
            return this.BuildExpressionTreeValue(node.Syntax, literal, node.Type)
        }
        return base.RewriteConversionExpression(node)
    }

    private func BuildExpressionTreeValue(
        syntax SyntaxNode?,
        literal BoundFunctionLiteralExpression,
        targetType TypeSymbol
    ) BoundExpression {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let parameterMap = Dictionary[VariableSymbol, LocalVariableSymbol]()
        for parameter in literal.Function.Parameters {
            let local = LocalVariableSymbol(
                "<>exprParam${this.counter++}",
                isReadOnly: true,
                ParameterExpressionTypeSymbol
            )
            let initializer = BoundClrStaticCallExpression(
                syntax,
                ExpressionParameterMethod,
                ParameterExpressionTypeSymbol,
                ImmutableArray.Create[BoundExpression](
                    CreateTypeOf(parameter.Type),
                    BoundLiteralExpression(nil, parameter.Name, TypeSymbol.String)
                )
            )
            statements.Add(BoundVariableDeclaration(syntax, local, initializer))
            parameterMap[parameter] = local
        }
        let bodySource = ExtractLambdaBodyExpression(literal.Body)
        let body = this.TranslateExpression(bodySource, parameterMap)
        let lambda = BoundClrStaticCallExpression(
            syntax,
            ExpressionLambdaMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(LambdaExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                CreateTypeOf(
                    if MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(targetType, out var delegateType) {
                        delegateType!!
                    } else {
                        TypeSymbol.Error
                    }
                ),
                UpcastToExpression(body),
                BuildParameterArray(parameterMap.Values)
            )
        )
        let cast = BoundConversionExpression(syntax, targetType, lambda)
        return BoundBlockExpression(syntax, statements.ToImmutable(), cast)
    }

    private func TranslateExpression(
        expression BoundExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        switch expression {
            case literal is BoundLiteralExpression {
                return BuildLiteralExpressionNode(literal)
            }
            case default_ is BoundDefaultExpression {
                return BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionDefaultMethod,
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(DefaultExpression),
                        NullabilityFreeReason.TypeLiteral
                    ),
                    ImmutableArray.Create[BoundExpression](CreateTypeOf(default_.Type))
                )
            }
            case typeOf is BoundTypeOfExpression {
                return BuildRuntimeConstant(typeOf, SystemTypeSymbol)
            }
            case variable is BoundVariableExpression {
                if parameterMap.TryGetValue(variable.Variable, out var parameterLocal) {
                    return BoundVariableExpression(expression.Syntax, parameterLocal)
                }
                return BuildRuntimeConstant(variable, variable.Type)
            }
            case field is BoundFieldAccessExpression {
                return BuildFieldAccessExpression(field, parameterMap)
            }
            case property is BoundPropertyAccessExpression {
                return BuildPropertyAccessExpression(property, parameterMap)
            }
            case clrProperty is BoundClrPropertyAccessExpression {
                return BuildClrPropertyAccessExpression(clrProperty, parameterMap)
            }
            case index is BoundIndexExpression {
                if index.Indices.Length > 1 {
                    return BoundClrStaticCallExpression(
                        expression.Syntax,
                        ExpressionArrayAccessMethod,
                        TypeSymbol.FromClrTypeWithoutNullability(
                            typeof(IndexExpression),
                            NullabilityFreeReason.TypeLiteral
                        ),
                        ImmutableArray.Create[BoundExpression](
                            UpcastToExpression(this.TranslateExpression(index.Target, parameterMap)),
                            BuildExpressionArray(
                                index.Indices.Select((i BoundExpression) -> this.TranslateExpression(i, parameterMap))
                            )
                        )
                    )
                }
                return BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionArrayIndexMethod,
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(BinaryExpression),
                        NullabilityFreeReason.TypeLiteral
                    ),
                    ImmutableArray.Create[BoundExpression](
                        UpcastToExpression(this.TranslateExpression(index.Target, parameterMap)),
                        UpcastToExpression(this.TranslateExpression(index.Index, parameterMap))
                    )
                )
            }
            case clrIndex is BoundClrIndexExpression {
                return BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionIndexerPropertyMethod,
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(IndexExpression),
                        NullabilityFreeReason.TypeLiteral
                    ),
                    ImmutableArray.Create[BoundExpression](
                        UpcastToExpression(this.TranslateExpression(clrIndex.Target, parameterMap)),
                        BoundLiteralExpression(nil, clrIndex.Indexer.Name, TypeSymbol.String),
                        BuildExpressionArray(
                            TranslateArguments(clrIndex.Arguments, clrIndex.Indexer.GetIndexParameters(), parameterMap)
                        )
                    )
                )
            }
            case unary is BoundUnaryExpression {
                return BuildUnaryExpression(unary, parameterMap)
            }
            case binary is BoundBinaryExpression {
                return BuildBinaryExpression(binary, parameterMap)
            }
            case conditional is BoundConditionalExpression {
                return BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionConditionMethod,
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(ConditionalExpression),
                        NullabilityFreeReason.TypeLiteral
                    ),
                    ImmutableArray.Create[BoundExpression](
                        UpcastToExpression(this.TranslateExpression(conditional.Condition, parameterMap)),
                        UpcastToExpression(this.TranslateExpression(conditional.WhenTrue, parameterMap)),
                        UpcastToExpression(this.TranslateExpression(conditional.WhenFalse, parameterMap))
                    )
                )
            }
            case isExpression is BoundIsExpression {
                return BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionTypeIsMethod,
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(TypeBinaryExpression),
                        NullabilityFreeReason.TypeLiteral
                    ),
                    ImmutableArray.Create[BoundExpression](
                        UpcastToExpression(this.TranslateExpression(isExpression.Expression, parameterMap)),
                        CreateTypeOf(
                            Invariant.Required(
                                isExpression.TargetType,
                                "a simple is-expression has a target type",
                                expression: "isExpression.TargetType"
                            )
                        )
                    )
                )
            }
            case asExpression is BoundAsExpression {
                return BoundClrStaticCallExpression(
                    expression.Syntax,
                    ExpressionTypeAsMethod,
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(UnaryExpression),
                        NullabilityFreeReason.TypeLiteral
                    ),
                    ImmutableArray.Create[BoundExpression](
                        UpcastToExpression(this.TranslateExpression(asExpression.Expression, parameterMap)),
                        CreateTypeOf(asExpression.TargetType)
                    )
                )
            }
            case array is BoundArrayCreationExpression {
                return BuildArrayCreationExpression(array, parameterMap)
            }
            case ctor is BoundConstructorCallExpression {
                return BuildUserConstructorExpression(ctor, parameterMap)
            }
            case clrCtor is BoundClrConstructorCallExpression {
                return BuildClrConstructorExpression(clrCtor, parameterMap)
            }
            case conversion is BoundConversionExpression {
                return BuildConversionExpression(conversion, parameterMap)
            }
            case importedInstance is BoundImportedInstanceCallExpression {
                return BuildImportedInstanceCallExpression(importedInstance, parameterMap)
            }
            case importedCall is BoundImportedCallExpression {
                return BuildImportedStaticCallExpression(importedCall, parameterMap)
            }
            case clrStaticCall is BoundClrStaticCallExpression {
                return BuildClrStaticMethodCallExpression(clrStaticCall, parameterMap)
            }
            case userInstanceCall is BoundUserInstanceCallExpression {
                return BuildUserInstanceCallExpression(userInstanceCall, parameterMap)
            }
            case userStaticCall is BoundCallExpression {
                return BuildUserStaticCallExpression(userStaticCall, parameterMap)
            }
            case clrBinary is BoundClrBinaryOperatorExpression {
                return BuildClrBinaryOperatorExpression(clrBinary, parameterMap)
            }
            case clrUnary is BoundClrUnaryOperatorExpression {
                return BuildClrUnaryOperatorExpression(clrUnary, parameterMap)
            }
            case userConversion is BoundClrConversionCallExpression {
                return BuildUserDefinedConversionExpression(userConversion, parameterMap)
            }
            case nestedDelegateLiteral is BoundFunctionLiteralExpression {
                return BuildRuntimeConstant(nestedDelegateLiteral, nestedDelegateLiteral.Type)
            }
            case structLiteral is BoundStructLiteralExpression {
                return this.BuildStructLiteralExpression(structLiteral, parameterMap)
            }
            case block is BoundBlockExpression when BoundStructLiteralExpression.IsStagedConstruction(block) {
                return this.BuildStagedConstructionExpression(block, parameterMap)
            }
            case block is BoundBlockExpression when this.TryBuildObjectInitializerExpression(
                block,
                parameterMap,
                out var objectInitializer
            ) {
                return objectInitializer!!
            }
            default {
                throw NotSupportedException("Unsupported expression-tree lowering node: ${expression.Kind}.")
            }
        }
    }

    private func BuildLiteralExpressionNode(literal BoundLiteralExpression) BoundExpression {
        if literal.Value == nil && literal.Type == TypeSymbol.Null {
            return BoundClrStaticCallExpression(
                literal.Syntax,
                ExpressionConstantUntypedMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(ConstantExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](BoundLiteralExpression(nil, nil, TypeSymbol.Null))
            )
        }
        return BuildRuntimeConstant(literal, literal.Type)
    }

    private func BuildRuntimeConstant(runtimeValue BoundExpression, runtimeType TypeSymbol) BoundExpression {
        return BoundClrStaticCallExpression(
            runtimeValue.Syntax,
            ExpressionConstantMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(ConstantExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                BoundConversionExpression(nil, ObjectTypeSymbol, runtimeValue),
                CreateTypeOf(runtimeType)
            )
        )
    }

    private func BuildFieldAccessExpression(
        field BoundFieldAccessExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        if field.Receiver == nil {
            let owner = field.InterfaceType as TypeSymbol ?? field.StructType
            return BoundClrStaticCallExpression(
                field.Syntax,
                ExpressionFieldStaticMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(MemberExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](
                    BoundLiteralExpression(nil, nil, TypeSymbol.Null),
                    CreateTypeOf(
                        Invariant.Required(
                            owner,
                            "a static field read carries its owner in exactly one of InterfaceType (the ADR-0089 form) or StructType",
                            expression: "owner"
                        )
                    ),
                    BoundLiteralExpression(nil, field.Field.Name, TypeSymbol.String)
                )
            )
        }
        return BoundClrStaticCallExpression(
            field.Syntax,
            ExpressionFieldInstanceMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(MemberExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                UpcastToExpression(this.TranslateExpression(field.Receiver!!, parameterMap)),
                BoundLiteralExpression(nil, field.Field.Name, TypeSymbol.String)
            )
        )
    }

    private func BuildPropertyAccessExpression(
        property BoundPropertyAccessExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        return BoundClrStaticCallExpression(
            property.Syntax,
            ExpressionPropertyInfoMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(MemberExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                if property.Receiver == nil {
                    cast[BoundExpression](BoundLiteralExpression(nil, nil, TypeSymbol.Null))
                } else {
                    UpcastToExpression(this.TranslateExpression(property.Receiver, parameterMap))
                },
                BuildUserPropertyInfoLookup(
                    Invariant.Required(
                        property.InterfaceType as TypeSymbol ?? property.StructType ?? property.Receiver?.Type,
                        "a bound property read carries its declaring or receiver construction",
                        expression: "property.InterfaceType as TypeSymbol ?? property.StructType ?? property.Receiver?.Type"
                    ),
                    property.Property
                )
            )
        )
    }

    private func BuildClrPropertyAccessExpression(
        property BoundClrPropertyAccessExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        let memberName = property.Member.Name
        let ownerType = property.StaticContainerType ?? TypeSymbol.FromClrTypeWithoutNullability(
            Invariant.Required(
                property.Member.DeclaringType,
                "a CLR property has a declaring type",
                expression: "property.Member.DeclaringType"
            ),
            NullabilityFreeReason.TypeStructure
        )
        let isField = property.Member is FieldInfo
        let staticMethod = if isField {
            ExpressionFieldStaticMethod
        } else {
            ExpressionPropertyStaticMethod
        }
        let instanceMethod = if isField {
            ExpressionFieldInstanceMethod
        } else {
            ExpressionPropertyInstanceMethod
        }
        if property.Receiver == nil {
            return BoundClrStaticCallExpression(
                property.Syntax,
                staticMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(MemberExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](
                    BoundLiteralExpression(nil, nil, TypeSymbol.Null),
                    CreateTypeOf(ownerType),
                    BoundLiteralExpression(nil, memberName, TypeSymbol.String)
                )
            )
        }
        return BoundClrStaticCallExpression(
            property.Syntax,
            instanceMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(MemberExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                UpcastToExpression(this.TranslateExpression(property.Receiver!!, parameterMap)),
                BoundLiteralExpression(nil, memberName, TypeSymbol.String)
            )
        )
    }

    private func BuildUnaryExpression(
        unary BoundUnaryExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        let operand = UpcastToExpression(this.TranslateExpression(unary.Operand, parameterMap))
        // Issue #5400: a synthesized nullable extraction remains a conversion in expression trees.
        if unary.IsConversionUnwrap {
            return BoundClrStaticCallExpression(
                unary.Syntax,
                ExpressionConvertMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(UnaryExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](operand, CreateTypeOf(unary.Type))
            )
        }
        // Issue #3349: a reference-type null-assertion is pure static annotation
        // — the CLR has no distinct `T?`, so there is nothing to emit. Erase it
        // and hand the operand's own tree through unchanged.
        // `ExpressionTreeRestrictionValidator` has already rejected the two
        // cases that are NOT pure annotation — the nullable VALUE-type case
        // (GS0473), which is a real conversion, and ADR-0186's platform
        // operand, whose assertion lowers to a real runtime check — so
        // anything reaching here is safe to drop.
        if unary.Op.Kind == BoundUnaryOperatorKind.NullAssertion {
            return operand
        }
        let method = switch unary.Op.Kind {
            case BoundUnaryOperatorKind.Identity: GetRequiredMethod(typeof(Expression), "UnaryPlus", typeof(Expression))
            case BoundUnaryOperatorKind.Negation: GetRequiredMethod(typeof(Expression), "Negate", typeof(Expression))
            case BoundUnaryOperatorKind.LogicalNegation: GetRequiredMethod(
                typeof(Expression),
                "Not",
                typeof(Expression)
            )
            case BoundUnaryOperatorKind.OnesComplement: GetRequiredMethod(typeof(Expression), "Not", typeof(Expression))
            default: throw NotSupportedException(
                "Unsupported unary operator '${unary.Op.Kind}' in expression-tree lowering."
            )
        }
        return BoundClrStaticCallExpression(
            unary.Syntax,
            method,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(UnaryExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create(operand)
        )
    }

    private func BuildBinaryExpression(
        binary BoundBinaryExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        if binary.Op.Kind == BoundBinaryOperatorKind.BitClear {
            let left = UpcastToExpression(this.TranslateExpression(binary.Left, parameterMap))
            let rightNot = BoundClrStaticCallExpression(
                binary.Syntax,
                GetRequiredMethod(typeof(Expression), "Not", typeof(Expression)),
                TypeSymbol.FromClrTypeWithoutNullability(typeof(UnaryExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create(UpcastToExpression(this.TranslateExpression(binary.Right, parameterMap)))
            )
            return BoundClrStaticCallExpression(
                binary.Syntax,
                GetRequiredMethod(typeof(Expression), "And", typeof(Expression), typeof(Expression)),
                TypeSymbol.FromClrTypeWithoutNullability(typeof(BinaryExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create(left, UpcastToExpression(rightNot))
            )
        }
        let leftExpr = UpcastToExpression(this.TranslateExpression(binary.Left, parameterMap))
        let rightExpr = UpcastToExpression(this.TranslateExpression(binary.Right, parameterMap))
        let method = switch binary.Op.Kind {
            case BoundBinaryOperatorKind.Sum when binary.Type == TypeSymbol.String: GetRequiredMethod(
                typeof(Expression),
                "Add",
                typeof(Expression),
                typeof(Expression),
                typeof(MethodInfo)
            )
            case BoundBinaryOperatorKind.Sum: GetRequiredMethod(
                typeof(Expression),
                "Add",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.Difference: GetRequiredMethod(
                typeof(Expression),
                "Subtract",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.Product: GetRequiredMethod(
                typeof(Expression),
                "Multiply",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.Quotient: GetRequiredMethod(
                typeof(Expression),
                "Divide",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.Remainder: GetRequiredMethod(
                typeof(Expression),
                "Modulo",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.ShiftLeft: GetRequiredMethod(
                typeof(Expression),
                "LeftShift",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.ShiftRight: GetRequiredMethod(
                typeof(Expression),
                "RightShift",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.BitwiseAnd: GetRequiredMethod(
                typeof(Expression),
                "And",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.BitwiseOr: GetRequiredMethod(
                typeof(Expression),
                "Or",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.BitwiseXor: GetRequiredMethod(
                typeof(Expression),
                "ExclusiveOr",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.Equals: GetRequiredMethod(
                typeof(Expression),
                "Equal",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.NotEquals: GetRequiredMethod(
                typeof(Expression),
                "NotEqual",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.Less: GetRequiredMethod(
                typeof(Expression),
                "LessThan",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.LessOrEquals: GetRequiredMethod(
                typeof(Expression),
                "LessThanOrEqual",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.Greater: GetRequiredMethod(
                typeof(Expression),
                "GreaterThan",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.GreaterOrEquals: GetRequiredMethod(
                typeof(Expression),
                "GreaterThanOrEqual",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.LogicalAnd: GetRequiredMethod(
                typeof(Expression),
                "AndAlso",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.LogicalOr: GetRequiredMethod(
                typeof(Expression),
                "OrElse",
                typeof(Expression),
                typeof(Expression)
            )
            case BoundBinaryOperatorKind.NullCoalesce: ExpressionCoalesceMethod
            default: throw NotSupportedException(
                "Unsupported binary operator '${binary.Op.Kind}' in expression-tree lowering."
            )
        }
        if binary.Op.Kind == BoundBinaryOperatorKind.Sum && binary.Type == TypeSymbol.String {
            let concat = GetRequiredMethod(typeof(string), "Concat", typeof(string), typeof(string))
            return BoundClrStaticCallExpression(
                binary.Syntax,
                method,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(BinaryExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](leftExpr, rightExpr, BuildMethodInfoConstant(concat))
            )
        }
        return BoundClrStaticCallExpression(
            binary.Syntax,
            method,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(BinaryExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create(leftExpr, rightExpr)
        )
    }

    private func BuildArrayCreationExpression(
        array BoundArrayCreationExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        if !array.DimensionExpressions.IsDefaultOrEmpty {
            return BoundClrStaticCallExpression(
                array.Syntax,
                ExpressionNewArrayBoundsMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(NewArrayExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](
                    CreateTypeOf(array.ElementType),
                    BuildExpressionArray(
                        array.DimensionExpressions.Select(
                            (dimension BoundExpression) -> this.TranslateExpression(dimension, parameterMap)
                        )
                    )
                )
            )
        }
        let elements = List[BoundExpression](array.Elements.Length)
        for element in array.Elements {
            elements.Add(this.TranslateExpression(element, parameterMap))
        }
        return BoundClrStaticCallExpression(
            array.Syntax,
            ExpressionNewArrayInitMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(NewArrayExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](CreateTypeOf(array.ElementType), BuildExpressionArray(elements))
        )
    }

    private func BuildStructLiteralExpression(
        structLiteral BoundStructLiteralExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        if structLiteral.CopySource != nil {
            return if structLiteral.StructType.IsClass {
                cast[BoundExpression](
                    BoundClrStaticCallExpression(
                        structLiteral.Syntax,
                        ExpressionCallInstanceMethodInfoMethod,
                        TypeSymbol.FromClrTypeWithoutNullability(
                            typeof(MethodCallExpression),
                            NullabilityFreeReason.TypeLiteral
                        ),
                        ImmutableArray.Create[BoundExpression](
                            UpcastToExpression(this.TranslateExpression(structLiteral.CopySource, parameterMap)),
                            BuildUserFunctionMethodInfoLookup(
                                structLiteral.Syntax,
                                structLiteral.StructType.DataClassCloneMethod,
                                structLiteral.StructType,
                                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                            ),
                            BuildExpressionArray(ImmutableArray[BoundExpression].Empty)
                        )
                    )
                )
            } else {
                this.TranslateExpression(structLiteral.CopySource, parameterMap)
            }
        }
        if structLiteral.CallsPrimaryConstructor {
            let arguments = ImmutableArray.CreateBuilder[BoundExpression]()
            let consumed = HashSet[BoundFieldInitializer]()
            for parameter in structLiteral.StructType.PrimaryConstructorParameters {
                let initializer = Invariant.Required(
                    structLiteral.GetPrimaryArgument(parameter.Name),
                    "primary literal arguments, including defaults, are prepared during binding",
                    expression: "structLiteral.GetPrimaryArgument(parameter.Name)"
                )
                consumed.Add(initializer)
                arguments.Add(initializer.Value)
            }
            let construction = this.BuildUserConstructorExpression(
                BoundConstructorCallExpression(structLiteral.Syntax, structLiteral.StructType, arguments.ToImmutable()),
                parameterMap
            )
            let bindings = ImmutableArray.CreateBuilder[BoundExpression]()
            for initializer in structLiteral.Initializers {
                if consumed.Contains(initializer) {
                    continue
                }
                let member = if initializer.Property != nil {
                    BuildUserPropertyInfoLookup(structLiteral.StructType, initializer.Property)
                } else {
                    BuildUserFieldInfoLookup(
                        initializer.FieldDeclaringType ?? structLiteral.StructType,
                        initializer.MemberName
                    )
                }
                bindings.Add(
                    BoundClrStaticCallExpression(
                        structLiteral.Syntax,
                        ExpressionBindMethod,
                        TypeSymbol.FromClrTypeWithoutNullability(
                            typeof(MemberAssignment),
                            NullabilityFreeReason.TypeLiteral
                        ),
                        ImmutableArray.Create(
                            member,
                            UpcastToExpression(this.TranslateExpression(initializer.Value, parameterMap))
                        )
                    )
                )
            }
            return if bindings.Count == 0 {
                construction
            } else {
                cast[BoundExpression](
                    BoundClrStaticCallExpression(
                        structLiteral.Syntax,
                        ExpressionMemberInitMethod,
                        TypeSymbol.FromClrTypeWithoutNullability(
                            typeof(MemberInitExpression),
                            NullabilityFreeReason.TypeLiteral
                        ),
                        ImmutableArray.Create(construction, BuildMemberBindingArray(bindings))
                    )
                )
            }
        }
        if structLiteral.IsZeroInitialization ||
            (
            !structLiteral
                .StructType
                .HasPrimaryConstructor &&
                structLiteral
                .StructType
                .NeedsSynthesizedValueStructDefaultCtor
        ) {
            return this.BuildOwningStructLiteralExpression(structLiteral, parameterMap)
        }
        if structLiteral.Initializers.IsDefaultOrEmpty || structLiteral.Initializers.Length == 0 {
            return BoundClrStaticCallExpression(
                structLiteral.Syntax,
                ExpressionNewTypeMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(NewExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](CreateTypeOf(structLiteral.StructType))
            )
        }
        let argValues = ImmutableArray.CreateBuilder[BoundExpression](structLiteral.Initializers.Length)
        let argTypes = ImmutableArray.CreateBuilder[TypeSymbol](structLiteral.Initializers.Length)
        for initializer in structLiteral.Initializers {
            argValues.Add(initializer.Value)
            argTypes.Add(initializer.Value.Type)
        }
        let argValuesImmutable = argValues.MoveToImmutable()
        let ctorInfo = BoundImportedInstanceCallExpression(
            structLiteral.Syntax,
            CreateTypeOf(structLiteral.StructType),
            TypeGetConstructorMethod,
            ReflectionConstructorInfoTypeSymbol,
            ImmutableArray.Create[BoundExpression](BuildTypeArray(argTypes.MoveToImmutable()))
        )
        return BoundClrStaticCallExpression(
            structLiteral.Syntax,
            ExpressionNewCtorMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(NewExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                ctorInfo,
                BuildExpressionArray(
                    TranslateArguments(argValuesImmutable, GetArgumentTypes(argValuesImmutable), parameterMap)
                )
            )
        )
    }

    private func BuildStagedConstructionExpression(
        block BoundBlockExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        let locals = Dictionary[VariableSymbol, LocalVariableSymbol](parameterMap)
        let factoryStatements = ImmutableArray.CreateBuilder[BoundStatement]()
        let variables = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
        let expressions = ImmutableArray.CreateBuilder[BoundExpression]()
        for declaration BoundVariableDeclaration in block.Statements {
            let local = LocalVariableSymbol(
                "<>exprLocal${this.counter++}",
                isReadOnly: true,
                ParameterExpressionTypeSymbol
            )
            factoryStatements.Add(
                BoundVariableDeclaration(
                    nil,
                    local,
                    BoundClrStaticCallExpression(
                        nil,
                        ExpressionParameterMethod,
                        ParameterExpressionTypeSymbol,
                        ImmutableArray.Create[BoundExpression](
                            CreateTypeOf(declaration.Variable.Type),
                            BoundLiteralExpression(nil, declaration.Variable.Name, TypeSymbol.String)
                        )
                    )
                )
            )
            locals.Add(declaration.Variable, local)
            variables.Add(local)
            expressions.Add(
                BoundClrStaticCallExpression(
                    nil,
                    ExpressionAssignMethod,
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(BinaryExpression),
                        NullabilityFreeReason.TypeLiteral
                    ),
                    ImmutableArray.Create(
                        UpcastToExpression(BoundVariableExpression(nil, local)),
                        UpcastToExpression(
                            this.TranslateArgument(
                                Invariant.Required(
                                    declaration.Initializer,
                                    "a staged construction argument has an initializer",
                                    expression: "declaration.Initializer"
                                ),
                                declaration.Variable.Type,
                                locals
                            )
                        )
                    )
                )
            )
        }
        expressions.Add(this.TranslateExpression(block.Expression, locals))
        let tree = BoundClrStaticCallExpression(
            nil,
            ExpressionBlockMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(BlockExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create(BuildParameterArray(variables), BuildExpressionArray(expressions))
        )
        return BoundBlockExpression(nil, factoryStatements.ToImmutable(), tree)
    }

    private func BuildOwningStructLiteralExpression(
        literal BoundStructLiteralExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        let markerCount = literal.StructType.LiteralInitializerMarkerCount
        if literal.IsZeroInitialization &&
            literal.StructType is {IsData: true, IsClass: false, HasDeclaredPrimaryConstructor: true} &&
            markerCount == 0 {
            return this.BuildZeroStorageStructLiteralExpression(literal, parameterMap)
        }
        var construction BoundExpression
        if markerCount == 0 {
            construction = BoundClrStaticCallExpression(
                literal.Syntax,
                ExpressionNewTypeMethod,
                NewExpressionTypeSymbol,
                ImmutableArray.Create[BoundExpression](CreateTypeOf(literal.StructType))
            )
        } else {
            // Literal-only initializers have an assembly-only Boolean marker
            // signature distinct from every authored constructor.
            let constructor = BoundImportedInstanceCallExpression(
                literal.Syntax,
                CreateTypeOf(literal.StructType),
                TypeGetConstructorWithBindingFlagsMethod,
                ReflectionConstructorInfoTypeSymbol,
                ImmutableArray.Create[BoundExpression](
                    BuildBindingFlagsConstant(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                    BoundLiteralExpression(nil, nil, TypeSymbol.Null),
                    BuildTypeArray(Enumerable.Repeat(TypeSymbol.Bool, markerCount)),
                    BoundLiteralExpression(nil, nil, TypeSymbol.Null)
                )
            )
            let markers = Enumerable.Range(0, markerCount).Select(
                (_ int32) -> this.TranslateExpression(BoundLiteralExpression(nil, false, TypeSymbol.Bool), parameterMap)
            )
            construction = BoundClrStaticCallExpression(
                literal.Syntax,
                ExpressionNewCtorMethod,
                NewExpressionTypeSymbol,
                ImmutableArray.Create[BoundExpression](constructor, BuildExpressionArray(markers))
            )
        }
        if literal.Initializers.IsDefaultOrEmpty {
            return construction
        }
        let bindings = ImmutableArray.CreateBuilder[BoundExpression](literal.Initializers.Length)
        for initializer in literal.Initializers {
            if literal.IsZeroInitialization &&
                literal
                .StructType
                .ValueStructDefaultCtorIsZeroInitialization &&
                markerCount > 0 &&
                initializer.Field is {} zeroField &&
                MagicCollectionZeroValue.TrySynthesizeInTypeZeroField(
                literal.Syntax,
                literal.StructType,
                zeroField
            ) != nil {
                continue
            }
            let member = if initializer.Field != nil {
                BuildUserFieldInfoLookup(literal.StructType, initializer.Field.Name)
            } else {
                BuildUserPropertyInfoLookup(
                    literal.StructType,
                    Invariant.Required(
                        initializer.Property,
                        "a literal initializer has a field or property",
                        expression: "initializer.Property"
                    )
                )
            }
            bindings.Add(
                BoundClrStaticCallExpression(
                    literal.Syntax,
                    ExpressionBindMethod,
                    TypeSymbol.FromClrTypeWithoutNullability(
                        typeof(MemberAssignment),
                        NullabilityFreeReason.TypeLiteral
                    ),
                    ImmutableArray.Create[BoundExpression](
                        member,
                        UpcastToExpression(this.TranslateExpression(initializer.Value, parameterMap))
                    )
                )
            )
        }
        return BoundClrStaticCallExpression(
            literal.Syntax,
            ExpressionMemberInitMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(MemberInitExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](construction, BuildMemberBindingArray(bindings))
        )
    }

    private func BuildZeroStorageStructLiteralExpression(
        literal BoundStructLiteralExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        let defaultValue = BoundClrStaticCallExpression(
            literal.Syntax,
            ExpressionDefaultMethod,
            ExpressionTypeSymbol,
            ImmutableArray.Create[BoundExpression](CreateTypeOf(literal.StructType))
        )
        if literal.Initializers.IsDefaultOrEmpty {
            return defaultValue
        }
        let local = LocalVariableSymbol("<>zero${this.counter++}", isReadOnly: true, ParameterExpressionTypeSymbol)
        let declaration = BoundVariableDeclaration(
            literal.Syntax,
            local,
            BoundClrStaticCallExpression(
                literal.Syntax,
                ExpressionParameterMethod,
                ParameterExpressionTypeSymbol,
                ImmutableArray.Create[BoundExpression](
                    CreateTypeOf(literal.StructType),
                    BoundLiteralExpression(nil, string.Empty, TypeSymbol.String)
                )
            )
        )
        let localRead = BoundVariableExpression(literal.Syntax, local)
        let expressions = ImmutableArray.CreateBuilder[BoundExpression](literal.Initializers.Length + 2)
        expressions.Add(
            BoundClrStaticCallExpression(
                literal.Syntax,
                ExpressionAssignMethod,
                ExpressionTypeSymbol,
                ImmutableArray.Create[BoundExpression](UpcastToExpression(localRead), defaultValue)
            )
        )
        for initializer in literal.Initializers {
            let member BoundExpression = if initializer.Field != nil {
                BoundClrStaticCallExpression(
                    literal.Syntax,
                    ExpressionFieldInstanceMethod,
                    ExpressionTypeSymbol,
                    ImmutableArray.Create[BoundExpression](
                        UpcastToExpression(localRead),
                        BoundLiteralExpression(nil, initializer.Field.Name, TypeSymbol.String)
                    )
                )
            } else {
                BoundClrStaticCallExpression(
                    literal.Syntax,
                    ExpressionPropertyInfoMethod,
                    ExpressionTypeSymbol,
                    ImmutableArray.Create[BoundExpression](
                        UpcastToExpression(localRead),
                        BuildUserPropertyInfoLookup(
                            literal.StructType,
                            Invariant.Required(
                                initializer.Property,
                                "a literal initializer has a field or property",
                                expression: "initializer.Property"
                            )
                        )
                    )
                )
            }
            expressions.Add(
                BoundClrStaticCallExpression(
                    literal.Syntax,
                    ExpressionAssignMethod,
                    ExpressionTypeSymbol,
                    ImmutableArray.Create[BoundExpression](
                        UpcastToExpression(member),
                        UpcastToExpression(this.TranslateExpression(initializer.Value, parameterMap))
                    )
                )
            )
        }
        expressions.Add(localRead)
        return BoundBlockExpression(
            literal.Syntax,
            ImmutableArray.Create[BoundStatement](declaration),
            BoundClrStaticCallExpression(
                literal.Syntax,
                ExpressionBlockMethod,
                ExpressionTypeSymbol,
                ImmutableArray.Create[BoundExpression](
                    BuildParameterArray(ImmutableArray.Create(local)),
                    BuildExpressionArray(expressions)
                )
            )
        )
    }

    private func BuildUserConstructorExpression(
        constructor BoundConstructorCallExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        if constructor.Arguments.IsDefaultOrEmpty || constructor.Arguments.Length == 0 {
            return BoundClrStaticCallExpression(
                constructor.Syntax,
                ExpressionNewTypeMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(NewExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](CreateTypeOf(constructor.StructType))
            )
        }
        let ctorInfo = BoundImportedInstanceCallExpression(
            constructor.Syntax,
            CreateTypeOf(constructor.StructType),
            TypeGetConstructorMethod,
            ReflectionConstructorInfoTypeSymbol,
            ImmutableArray.Create[BoundExpression](BuildTypeArray(GetArgumentTypes(constructor.Arguments)))
        )
        // Only property-based anonymous objects carry the NewExpression.Members
        // contract. Named positional data types can also have properties without
        // fields, including properties that hide inherited members.
        if constructor.StructType.Definition!!.HasAnonymousConstructorMembers {
            let membersArray = BuildMemberInfoArray(
                constructor.StructType,
                constructor.StructType.PrimaryConstructorParameters
            )
            return BoundClrStaticCallExpression(
                constructor.Syntax,
                ExpressionNewCtorMembersMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(NewExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](
                    ctorInfo,
                    BuildExpressionArray(
                        TranslateArguments(constructor.Arguments, GetArgumentTypes(constructor.Arguments), parameterMap)
                    ),
                    membersArray
                )
            )
        }
        return BoundClrStaticCallExpression(
            constructor.Syntax,
            ExpressionNewCtorMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(NewExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                ctorInfo,
                BuildExpressionArray(
                    TranslateArguments(constructor.Arguments, GetArgumentTypes(constructor.Arguments), parameterMap)
                )
            )
        )
    }

    private func BuildClrConstructorExpression(
        constructor BoundClrConstructorCallExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        if constructor.Arguments.IsDefaultOrEmpty || constructor.Arguments.Length == 0 {
            return BoundClrStaticCallExpression(
                constructor.Syntax,
                ExpressionNewTypeMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(NewExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](CreateTypeOf(constructor.Type))
            )
        }
        let ctorInfo = BoundImportedInstanceCallExpression(
            constructor.Syntax,
            CreateTypeOf(constructor.Type),
            TypeGetConstructorMethod,
            ReflectionConstructorInfoTypeSymbol,
            ImmutableArray.Create[BoundExpression](BuildTypeArray(GetArgumentTypes(constructor.Arguments)))
        )
        return BoundClrStaticCallExpression(
            constructor.Syntax,
            ExpressionNewCtorMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(NewExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                ctorInfo,
                BuildExpressionArray(
                    TranslateArguments(constructor.Arguments, GetArgumentTypes(constructor.Arguments), parameterMap)
                )
            )
        )
    }

    private func BuildConversionExpression(
        conversion BoundConversionExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        if conversion.Expression is BoundFunctionLiteralExpression nestedLiteral &&
            MemberLookup
            .TryGetExpressionTreeDelegateTypeFromSymbol(conversion.Type, out _) {
            return this.BuildExpressionTreeValue(conversion.Syntax, nestedLiteral, conversion.Type)
        }
        if conversion.Expression is BoundFunctionLiteralExpression ||
            conversion.Expression is BoundMethodGroupExpression ||
            conversion.Expression is BoundClrMethodGroupExpression {
            return BuildRuntimeConstant(conversion, conversion.Type)
        }
        let methodInfo BoundExpression? = switch conversion {
            case BoundConversionExpression{
                Expression: BoundClrConversionCallExpression clrConversion
            } when clrConversion.Method != nil: BuildMethodInfoConstant(clrConversion.Method!!)
            default: default(BoundExpression?)
        }
        if methodInfo != nil {
            return BoundClrStaticCallExpression(
                conversion.Syntax,
                ExpressionConvertWithMethodMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(UnaryExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](
                    UpcastToExpression(this.TranslateExpression(conversion.Expression, parameterMap)),
                    CreateTypeOf(conversion.Type),
                    methodInfo
                )
            )
        }
        return BoundClrStaticCallExpression(
            conversion.Syntax,
            ExpressionConvertMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(UnaryExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                UpcastToExpression(this.TranslateExpression(conversion.Expression, parameterMap)),
                CreateTypeOf(conversion.Type)
            )
        )
    }

    private func BuildUserDefinedConversionExpression(
        conversion BoundClrConversionCallExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        var methodInfo BoundExpression
        if conversion.Method != nil {
            methodInfo = BuildMethodInfoConstant(conversion.Method)
        } else {
            let function = conversion.Function ??
                throw NotSupportedException("A same-compilation expression-tree conversion requires a function symbol.")
            methodInfo = BuildUserFunctionMethodInfoLookup(
                conversion.Syntax,
                function,
                conversion.FunctionOwnerType,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
        }
        return BoundClrStaticCallExpression(
            conversion.Syntax,
            ExpressionConvertWithMethodMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(UnaryExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                UpcastToExpression(this.TranslateExpression(conversion.Source, parameterMap)),
                CreateTypeOf(conversion.Type),
                methodInfo
            )
        )
    }

    private func BuildImportedInstanceCallExpression(
        call BoundImportedInstanceCallExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        return BoundClrStaticCallExpression(
            call.Syntax,
            ExpressionCallInstanceMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(MethodCallExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                UpcastToExpression(this.TranslateExpression(call.Receiver, parameterMap)),
                BoundLiteralExpression(nil, call.Method.Name, TypeSymbol.String),
                BuildTypeArray(GetNullableTypeSymbols(call.TypeArgumentSymbols)),
                BuildExpressionArray(TranslateArguments(call.Arguments, call.Method.GetParameters(), parameterMap))
            )
        )
    }

    private func BuildImportedStaticCallExpression(
        call BoundImportedCallExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        return BoundClrStaticCallExpression(
            call.Syntax,
            ExpressionCallStaticMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(MethodCallExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                CreateTypeOf(
                    TypeSymbol.FromClrTypeWithoutNullability(
                        Invariant.Required(
                            call.Function.Method.DeclaringType,
                            "a CLR method has a declaring type",
                            expression: "call.Function.Method.DeclaringType"
                        ),
                        NullabilityFreeReason.TypeStructure
                    )
                ),
                BoundLiteralExpression(nil, call.Function.Method.Name, TypeSymbol.String),
                BuildTypeArray(GetNullableTypeSymbols(call.TypeArgumentSymbols)),
                BuildExpressionArray(
                    TranslateArguments(call.Arguments, call.Function.Method.GetParameters(), parameterMap)
                )
            )
        )
    }

    private func BuildClrStaticMethodCallExpression(
        call BoundClrStaticCallExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        return BoundClrStaticCallExpression(
            call.Syntax,
            ExpressionCallStaticMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(MethodCallExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                CreateTypeOf(
                    TypeSymbol.FromClrTypeWithoutNullability(
                        Invariant.Required(
                            call.Method.DeclaringType,
                            "a CLR method has a declaring type",
                            expression: "call.Method.DeclaringType"
                        ),
                        NullabilityFreeReason.TypeStructure
                    )
                ),
                BoundLiteralExpression(nil, call.Method.Name, TypeSymbol.String),
                BuildTypeArray(ImmutableArray[TypeSymbol].Empty),
                BuildExpressionArray(TranslateArguments(call.Arguments, call.Method.GetParameters(), parameterMap))
            )
        )
    }

    private func BuildUserInstanceCallExpression(
        call BoundUserInstanceCallExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        return BoundClrStaticCallExpression(
            call.Syntax,
            ExpressionCallInstanceMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(MethodCallExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                UpcastToExpression(this.TranslateExpression(call.Receiver, parameterMap)),
                BoundLiteralExpression(nil, call.Method.Name, TypeSymbol.String),
                BuildTypeArray(GetTypeSymbols(call.MethodTypeArguments)),
                BuildExpressionArray(
                    TranslateArguments(call.Arguments, GetCallableParameters(call.Method), parameterMap)
                )
            )
        )
    }

    private func BuildUserStaticCallExpression(
        call BoundCallExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        if call.Function.StaticOwnerType == nil {
            throw NotSupportedException(
                "Top-level function '${call.Function.Name}' is not supported inside expression trees."
            )
        }
        return BoundClrStaticCallExpression(
            call.Syntax,
            ExpressionCallStaticMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(MethodCallExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                CreateTypeOf(call.Function.StaticOwnerType!!),
                BoundLiteralExpression(nil, call.Function.Name, TypeSymbol.String),
                BuildTypeArray(GetTypeSymbols(call.MethodTypeArguments)),
                BuildExpressionArray(
                    TranslateArguments(call.Arguments, GetCallableParameters(call.Function), parameterMap)
                )
            )
        )
    }

    private func BuildClrBinaryOperatorExpression(
        expression BoundClrBinaryOperatorExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        let methodName = switch expression.OperatorKind {
            case SyntaxKind.PlusToken: "Add"
            case SyntaxKind.MinusToken: "Subtract"
            case SyntaxKind.StarToken: "Multiply"
            case SyntaxKind.SlashToken: "Divide"
            case SyntaxKind.PercentToken: "Modulo"
            case SyntaxKind.EqualsEqualsToken: "Equal"
            case SyntaxKind.BangEqualsToken: "NotEqual"
            case SyntaxKind.LessToken: "LessThan"
            case SyntaxKind.LessOrEqualsToken: "LessThanOrEqual"
            case SyntaxKind.GreaterToken: "GreaterThan"
            case SyntaxKind.GreaterOrEqualsToken: "GreaterThanOrEqual"
            case SyntaxKind.AmpersandToken: "And"
            case SyntaxKind.PipeToken: "Or"
            case SyntaxKind.HatToken: "ExclusiveOr"
            case SyntaxKind.ShiftLeftToken: "LeftShift"
            case SyntaxKind.ShiftRightToken: "RightShift"
            case SyntaxKind.AmpersandAmpersandToken: "AndAlso"
            case SyntaxKind.PipePipeToken: "OrElse"
            default: throw NotSupportedException("Unsupported CLR binary operator token '${expression.OperatorKind}'.")
        }
        let leftExpr = UpcastToExpression(this.TranslateExpression(expression.Left, parameterMap))
        let rightExpr = UpcastToExpression(this.TranslateExpression(expression.Right, parameterMap))
        let resultType = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(BinaryExpression),
            NullabilityFreeReason.TypeLiteral
        )
        // Issue #2398: same-compilation operators have no MethodInfo until the
        // emitted declaring type exists. Resolve it at runtime from the exact
        // closed owner and substituted parameter signature.
        let operatorMethod = if expression.Method != nil {
            BuildMethodInfoConstant(expression.Method)
        } else {
            BuildUserOperatorMethodInfoLookup(expression)
        }
        // Issue #2373: unlike the arithmetic/bitwise/shift/logical factories,
        // the six relational/equality factories do NOT expose a 3-arg
        // (Expression, Expression, MethodInfo) overload — only a 4-arg
        // (Expression, Expression, bool liftToNull, MethodInfo) overload
        // exists. Roslyn itself always passes `liftToNull: false` for C#'s
        // built-in and user-defined `==`/`!=`/`<`/`<=`/`>`/`>=` operators
        // (confirmed empirically): `IsLifted` becomes true automatically
        // from nullable operand types, but the *result* of a comparison is
        // never itself a nullable/lifted bool, so `liftToNull` is always
        // `false` here, both for nullable and non-nullable operands.
        if ComparisonFactoryMethodNames.Contains(methodName) {
            let comparisonFactory = GetRequiredMethod(
                typeof(Expression),
                methodName,
                typeof(Expression),
                typeof(Expression),
                typeof(bool),
                typeof(MethodInfo)
            )
            return BoundClrStaticCallExpression(
                expression.Syntax,
                comparisonFactory,
                resultType,
                ImmutableArray.Create[BoundExpression](
                    leftExpr,
                    rightExpr,
                    BoundLiteralExpression(nil, false, TypeSymbol.Bool),
                    operatorMethod
                )
            )
        }
        let factory = GetRequiredMethod(
            typeof(Expression),
            methodName,
            typeof(Expression),
            typeof(Expression),
            typeof(MethodInfo)
        )
        return BoundClrStaticCallExpression(
            expression.Syntax,
            factory,
            resultType,
            ImmutableArray.Create[BoundExpression](leftExpr, rightExpr, operatorMethod)
        )
    }

    private func BuildClrUnaryOperatorExpression(
        expression BoundClrUnaryOperatorExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        let methodName = switch expression.OperatorKind {
            case SyntaxKind.PlusToken: "UnaryPlus"
            case SyntaxKind.MinusToken: "Negate"
            case SyntaxKind.BangToken: "Not"
            case SyntaxKind.TildeToken: "Not"
            default: throw NotSupportedException("Unsupported CLR unary operator token '${expression.OperatorKind}'.")
        }
        let factory = GetRequiredMethod(typeof(Expression), methodName, typeof(Expression), typeof(MethodInfo))
        return BoundClrStaticCallExpression(
            expression.Syntax,
            factory,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(UnaryExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                UpcastToExpression(this.TranslateExpression(expression.Operand, parameterMap)),
                BuildMethodInfoConstant(expression.Method)
            )
        )
    }

    private func TryBuildObjectInitializerExpression(
        block BoundBlockExpression,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol],
        @NotNullWhen(true) out expression BoundExpression?
    ) bool {
        expression = nil
        if !TryMatchObjectInitializer(
            block,
            out var tempVariable,
            out var initializer,
            out var statements,
            out var captures
        ) {
            return false
        }
        if !captures.IsDefaultOrEmpty {
            // Spilled inputs are tree locals, not values evaluated while building
            // the tree. Their assignments retain lexical order on every invocation.
            let scopedMap = Dictionary[VariableSymbol, LocalVariableSymbol](parameterMap)
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol](captures.Length)
            let declarations = ImmutableArray.CreateBuilder[BoundStatement](captures.Length)
            let expressions = ImmutableArray.CreateBuilder[BoundExpression](captures.Length + 1)
            for capture in captures {
                let local = LocalVariableSymbol(
                    "<>exprParam${this.counter++}",
                    isReadOnly: true,
                    ParameterExpressionTypeSymbol
                )
                let parameter = BoundClrStaticCallExpression(
                    capture.Syntax,
                    ExpressionParameterMethod,
                    ParameterExpressionTypeSymbol,
                    ImmutableArray.Create[BoundExpression](
                        CreateTypeOf(capture.Variable.Type),
                        BoundLiteralExpression(nil, capture.Variable.Name, TypeSymbol.String)
                    )
                )
                declarations.Add(BoundVariableDeclaration(capture.Syntax, local, parameter))
                locals.Add(local)
                expressions.Add(
                    BoundClrStaticCallExpression(
                        capture.Syntax,
                        ExpressionAssignMethod,
                        ExpressionTypeSymbol,
                        ImmutableArray.Create[BoundExpression](
                            UpcastToExpression(BoundVariableExpression(capture.Syntax, local)),
                            UpcastToExpression(
                                this.TranslateExpression(
                                    Invariant.Required(
                                        capture.Initializer,
                                        "a spilled input has an initializer",
                                        expression: "capture.Initializer"
                                    ),
                                    scopedMap
                                )
                            )
                        )
                    )
                )
                scopedMap[capture.Variable] = local
            }
            let construction = BoundBlockExpression(
                block.Syntax,
                block.Statements.RemoveRange(0, captures.Length),
                block.Expression
            )
            if !this.TryBuildObjectInitializerExpression(construction, scopedMap, out var result) {
                return false
            }
            expressions.Add(result!!)
            expression = BoundBlockExpression(
                block.Syntax,
                declarations.MoveToImmutable(),
                BoundClrStaticCallExpression(
                    block.Syntax,
                    ExpressionBlockMethod,
                    ExpressionTypeSymbol,
                    ImmutableArray.Create[BoundExpression](
                        BuildParameterArray(locals),
                        BuildExpressionArray(expressions)
                    )
                )
            )
            return true
        }
        let translatedInitializer = this.TranslateExpression(initializer, parameterMap)
        if statements.Length == 0 {
            expression = translatedInitializer
            return true
        }
        if translatedInitializer.Type != NewExpressionTypeSymbol {
            return this.TryBuildCopiedValueInitializer(
                block,
                tempVariable,
                translatedInitializer,
                statements,
                parameterMap,
                out expression
            )
        }
        let bindings = ImmutableArray.CreateBuilder[BoundExpression](statements.Length)
        for statement in statements {
            if statement is not BoundExpressionStatement expressionStatement || !this.TryBuildMemberBinding(
                expressionStatement.Expression,
                tempVariable,
                parameterMap,
                out var binding
            ) {
                return false
            }
            bindings.Add(binding!!)
        }
        expression = BoundClrStaticCallExpression(
            block.Syntax,
            ExpressionMemberInitMethod,
            TypeSymbol.FromClrTypeWithoutNullability(typeof(MemberInitExpression), NullabilityFreeReason.TypeLiteral),
            ImmutableArray.Create[BoundExpression](
                if translatedInitializer.Type == NewExpressionTypeSymbol {
                    translatedInitializer
                } else {
                    cast[BoundExpression](
                        BoundConversionExpression(nil, NewExpressionTypeSymbol, translatedInitializer)
                    )
                },
                BuildMemberBindingArray(bindings)
            )
        )
        return true
    }

    private func TryBuildCopiedValueInitializer(
        block BoundBlockExpression,
        receiver VariableSymbol,
        initializer BoundExpression,
        statements ImmutableArray[BoundStatement],
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol],
        @NotNullWhen(true) out expression BoundExpression?
    ) bool {
        expression = nil
        let local = LocalVariableSymbol("<>exprParam${this.counter++}", isReadOnly: true, ParameterExpressionTypeSymbol)
        let variable = BoundVariableExpression(block.Syntax, local)
        let parameter = BoundClrStaticCallExpression(
            block.Syntax,
            ExpressionParameterMethod,
            ParameterExpressionTypeSymbol,
            ImmutableArray.Create[BoundExpression](
                CreateTypeOf(receiver.Type),
                BoundLiteralExpression(nil, receiver.Name, TypeSymbol.String)
            )
        )
        let scopedMap = Dictionary[VariableSymbol, LocalVariableSymbol](parameterMap){[receiver] = local}
        let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
        locals.Add(local)
        let declarations = ImmutableArray.CreateBuilder[BoundStatement]()
        declarations.Add(BoundVariableDeclaration(block.Syntax, local, parameter))
        let expressions = ImmutableArray.CreateBuilder[BoundExpression](statements.Length + 2)
        expressions.Add(
            BoundClrStaticCallExpression(
                block.Syntax,
                ExpressionAssignMethod,
                ExpressionTypeSymbol,
                ImmutableArray.Create[BoundExpression](UpcastToExpression(variable), UpcastToExpression(initializer))
            )
        )
        for statement in statements {
            if statement is not BoundExpressionStatement update {
                return false
            }
            var assignment = update.Expression
            while assignment is BoundBlockExpression spilled {
                for statementInSpill in spilled.Statements {
                    if !(statementInSpill is BoundVariableDeclaration{Initializer: {} capturedValue} capture) ||
                        capture.Syntax is VariableDeclarationSyntax {
                        return false
                    }
                    let capturedLocal = LocalVariableSymbol(
                        "<>exprParam${this.counter++}",
                        isReadOnly: true,
                        ParameterExpressionTypeSymbol
                    )
                    let capturedParameter = BoundClrStaticCallExpression(
                        capture.Syntax,
                        ExpressionParameterMethod,
                        ParameterExpressionTypeSymbol,
                        ImmutableArray.Create[BoundExpression](
                            CreateTypeOf(capture.Variable.Type),
                            BoundLiteralExpression(nil, capture.Variable.Name, TypeSymbol.String)
                        )
                    )
                    declarations.Add(BoundVariableDeclaration(capture.Syntax, capturedLocal, capturedParameter))
                    locals.Add(capturedLocal)
                    expressions.Add(
                        BoundClrStaticCallExpression(
                            capture.Syntax,
                            ExpressionAssignMethod,
                            ExpressionTypeSymbol,
                            ImmutableArray.Create[BoundExpression](
                                UpcastToExpression(BoundVariableExpression(capture.Syntax, capturedLocal)),
                                UpcastToExpression(this.TranslateExpression(capturedValue, scopedMap))
                            )
                        )
                    )
                    scopedMap[capture.Variable] = capturedLocal
                }
                assignment = spilled.Expression
            }
            let target BoundExpression? = switch assignment {
                case field is BoundFieldAssignmentExpression when ReferencesReceiver(field, receiver): this
                    .BuildFieldAccessExpression(
                    BoundFieldAccessExpression(
                        field.Syntax,
                        BoundVariableExpression(field.Syntax, receiver),
                        BoundNodeForm.DeclaringType(field),
                        field.Field
                    ),
                    scopedMap
                )
                case property is BoundPropertyAssignmentExpression when ReferencesReceiver(
                    property.Receiver,
                    receiver
                ): this
                    .BuildPropertyAccessExpression(
                    BoundPropertyAccessExpression(
                        property.Syntax,
                        BoundVariableExpression(property.Syntax, receiver),
                        property.StructType,
                        property.Property
                    ),
                    scopedMap
                )
                case clrProperty is BoundClrPropertyAssignmentExpression when ReferencesReceiver(
                    clrProperty.Receiver,
                    receiver
                ): this
                    .BuildClrPropertyAccessExpression(
                    BoundClrPropertyAccessExpression(
                        clrProperty.Syntax,
                        BoundVariableExpression(clrProperty.Syntax, receiver),
                        clrProperty.Member,
                        clrProperty.Type
                    ),
                    scopedMap
                )
                default: default(BoundExpression?)
            }
            let value BoundExpression? = switch assignment {
                case field is BoundFieldAssignmentExpression: field.Value
                case property is BoundPropertyAssignmentExpression: property.Value
                case clrProperty is BoundClrPropertyAssignmentExpression: clrProperty.Value
                default: default(BoundExpression?)
            }
            if target == nil || value == nil {
                return false
            }
            expressions.Add(
                BoundClrStaticCallExpression(
                    update.Syntax,
                    ExpressionAssignMethod,
                    ExpressionTypeSymbol,
                    ImmutableArray.Create[BoundExpression](
                        UpcastToExpression(target),
                        UpcastToExpression(this.TranslateExpression(value, scopedMap))
                    )
                )
            )
        }
        expressions.Add(variable)
        expression = BoundBlockExpression(
            block.Syntax,
            declarations.ToImmutable(),
            BoundClrStaticCallExpression(
                block.Syntax,
                ExpressionBlockMethod,
                ExpressionTypeSymbol,
                ImmutableArray.Create[BoundExpression](BuildParameterArray(locals), BuildExpressionArray(expressions))
            )
        )
        return true
    }

    private func TryBuildMemberBinding(
        expression BoundExpression,
        receiver VariableSymbol,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol],
        @NotNullWhen(true) out binding BoundExpression?
    ) bool {
        binding = switch expression {
            case field is BoundFieldAssignmentExpression when ReferencesReceiver(
                field,
                receiver
            ): BoundClrStaticCallExpression(
                field.Syntax,
                ExpressionBindMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(MemberAssignment), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](
                    BuildUserFieldInfoLookup(BoundNodeForm.DeclaringType(field), field.Field.Name),
                    UpcastToExpression(this.TranslateExpression(field.Value, parameterMap))
                )
            )
            case property is BoundPropertyAssignmentExpression when ReferencesReceiver(
                property.Receiver,
                receiver
            ): BoundClrStaticCallExpression(
                property.Syntax,
                ExpressionBindMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(MemberAssignment), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](
                    BuildUserPropertyInfoLookup(
                        Invariant.Required(
                            property.StructType ?? property.Receiver?.Type,
                            "a property assignment has an expression-tree owner type",
                            expression: "property.StructType ?? property.Receiver?.Type"
                        ),
                        property.Property
                    ),
                    UpcastToExpression(this.TranslateExpression(property.Value, parameterMap))
                )
            )
            case clrProperty is BoundClrPropertyAssignmentExpression when ReferencesReceiver(
                clrProperty.Receiver,
                receiver
            ): BoundClrStaticCallExpression(
                clrProperty.Syntax,
                ExpressionBindMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(MemberAssignment), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create[BoundExpression](
                    BuildMemberInfoConstant(clrProperty.Member),
                    UpcastToExpression(this.TranslateExpression(clrProperty.Value, parameterMap))
                )
            )
            default: default(BoundClrStaticCallExpression?)
        }
        return binding != nil
    }

    private func TranslateArguments(
        arguments ImmutableArray[BoundExpression],
        parameters[]ParameterInfo,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) ImmutableArray[BoundExpression] {
        let builder = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
        for var i = 0; i < arguments.Length; i++ {
            let expectedType = if i < parameters.Length {
                ClrNullability.GetParameterTypeSymbol(parameters[i]).StripToBareShape()
            } else {
                default(TypeSymbol?)
            }
            builder.Add(this.TranslateArgument(arguments[i], expectedType, parameterMap))
        }
        return builder.MoveToImmutable()
    }

    private func TranslateArguments(
        arguments ImmutableArray[BoundExpression],
        parameters ImmutableArray[ParameterSymbol],
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) ImmutableArray[BoundExpression] {
        let builder = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
        for var i = 0; i < arguments.Length; i++ {
            let expectedType = if i < parameters.Length {
                parameters[i].Type
            } else {
                default(TypeSymbol?)
            }
            builder.Add(this.TranslateArgument(arguments[i], expectedType, parameterMap))
        }
        return builder.MoveToImmutable()
    }

    private func TranslateArguments(
        arguments ImmutableArray[BoundExpression],
        parameterTypes ImmutableArray[TypeSymbol],
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) ImmutableArray[BoundExpression] {
        let builder = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
        for var i = 0; i < arguments.Length; i++ {
            let expectedType = if i < parameterTypes.Length {
                parameterTypes[i]
            } else {
                default(TypeSymbol?)
            }
            builder.Add(this.TranslateArgument(arguments[i], expectedType, parameterMap))
        }
        return builder.MoveToImmutable()
    }

    private func TranslateArgument(
        argument BoundExpression,
        expectedType TypeSymbol?,
        parameterMap Dictionary[VariableSymbol, LocalVariableSymbol]
    ) BoundExpression {
        if expectedType != nil && MemberLookup.TryGetExpressionTreeDelegateTypeFromSymbol(expectedType, out _) &&
            (
            argument is BoundFunctionLiteralExpression ||
                argument is BoundConversionExpression &&
                argument.Expression is BoundFunctionLiteralExpression
        ) {
            let lambda = if argument is BoundFunctionLiteralExpression directLambda {
                directLambda
            } else {
                cast[BoundFunctionLiteralExpression]((cast[BoundConversionExpression](argument)).Expression)
            }
            let nested = this.BuildExpressionTreeValue(argument.Syntax, lambda, expectedType)
            return BoundClrStaticCallExpression(
                argument.Syntax,
                ExpressionQuoteMethod,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(UnaryExpression), NullabilityFreeReason.TypeLiteral),
                ImmutableArray.Create(UpcastToExpression(nested))
            )
        }
        if expectedType != nil &&
            IsDelegateLike(expectedType) &&
            (
            argument is BoundFunctionLiteralExpression ||
                argument is BoundConversionExpression &&
                (
                argument.Expression is BoundFunctionLiteralExpression ||
                    argument.Expression is BoundMethodGroupExpression ||
                    argument.Expression is BoundClrMethodGroupExpression
            ) ||
                argument is BoundMethodGroupExpression ||
                argument is BoundClrMethodGroupExpression
        ) {
            let converted = if argument.Type == expectedType {
                argument
            } else {
                cast[BoundExpression](BoundConversionExpression(argument.Syntax, expectedType, argument))
            }
            return BuildRuntimeConstant(converted, expectedType)
        }
        return this.TranslateExpression(argument, parameterMap)
    }

    shared {
        private let SystemTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(Type),
            NullabilityFreeReason.TypeLiteral
        )
        private let ObjectTypeSymbol TypeSymbol = TypeSymbol.Object
        private let BindingFlagsTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(BindingFlags),
            NullabilityFreeReason.TypeLiteral
        )
        private let ReflectionConstructorInfoTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(ConstructorInfo),
            NullabilityFreeReason.TypeLiteral
        )
        private let ReflectionFieldInfoTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(FieldInfo),
            NullabilityFreeReason.TypeLiteral
        )
        private let ReflectionMethodInfoTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(MethodInfo),
            NullabilityFreeReason.TypeLiteral
        )
        private let ReflectionPropertyInfoTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(PropertyInfo),
            NullabilityFreeReason.TypeLiteral
        )
        private let ReflectionMemberInfoTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(MemberInfo),
            NullabilityFreeReason.TypeLiteral
        )
        private let ExpressionTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(Expression),
            NullabilityFreeReason.TypeLiteral
        )
        private let MemberBindingTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(MemberBinding),
            NullabilityFreeReason.TypeLiteral
        )
        private let NewExpressionTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(NewExpression),
            NullabilityFreeReason.TypeLiteral
        )
        private let ParameterExpressionTypeSymbol TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(ParameterExpression),
            NullabilityFreeReason.TypeLiteral
        )
        private let ExpressionParameterMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Parameter",
            typeof(Type),
            typeof(string)
        )
        private let ExpressionConstantMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Constant",
            typeof(object),
            typeof(Type)
        )
        private let ExpressionConstantUntypedMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Constant",
            typeof(object)
        )
        private let ExpressionFieldInstanceMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Field",
            typeof(Expression),
            typeof(string)
        )
        private let ExpressionFieldStaticMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Field",
            typeof(Expression),
            typeof(Type),
            typeof(string)
        )
        private let ExpressionPropertyInstanceMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Property",
            typeof(Expression),
            typeof(string)
        )
        private let ExpressionPropertyInfoMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Property",
            typeof(Expression),
            typeof(PropertyInfo)
        )
        private let ExpressionPropertyStaticMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Property",
            typeof(Expression),
            typeof(Type),
            typeof(string)
        )
        private let ExpressionIndexerPropertyMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Property",
            typeof(Expression),
            typeof(string),
            typeof([]Expression)
        )
        private let ExpressionCallInstanceMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Call",
            typeof(Expression),
            typeof(string),
            typeof([]Type),
            typeof([]Expression)
        )
        private let ExpressionCallInstanceMethodInfoMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Call",
            typeof(Expression),
            typeof(MethodInfo),
            typeof([]Expression)
        )
        private let ExpressionCallStaticMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Call",
            typeof(Type),
            typeof(string),
            typeof([]Type),
            typeof([]Expression)
        )
        private let ExpressionLambdaMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Lambda",
            typeof(Type),
            typeof(Expression),
            typeof([]ParameterExpression)
        )
        private let ExpressionQuoteMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Quote",
            typeof(Expression)
        )
        private let ExpressionConvertMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Convert",
            typeof(Expression),
            typeof(Type)
        )
        private let ExpressionConvertWithMethodMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Convert",
            typeof(Expression),
            typeof(Type),
            typeof(MethodInfo)
        )
        private let ExpressionTypeAsMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "TypeAs",
            typeof(Expression),
            typeof(Type)
        )
        private let ExpressionTypeIsMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "TypeIs",
            typeof(Expression),
            typeof(Type)
        )
        private let ExpressionConditionMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Condition",
            typeof(Expression),
            typeof(Expression),
            typeof(Expression)
        )
        private let ExpressionCoalesceMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Coalesce",
            typeof(Expression),
            typeof(Expression)
        )
        private let ExpressionNewTypeMethod MethodInfo = GetRequiredMethod(typeof(Expression), "New", typeof(Type))
        private let ExpressionNewCtorMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "New",
            typeof(ConstructorInfo),
            typeof([]Expression)
        )
        private let ExpressionNewCtorMembersMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "New",
            typeof(ConstructorInfo),
            typeof(IEnumerable[Expression]),
            typeof(IEnumerable[MemberInfo])
        )
        private let ExpressionMemberInitMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "MemberInit",
            typeof(NewExpression),
            typeof([]MemberBinding)
        )
        private let ExpressionBindMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Bind",
            typeof(MemberInfo),
            typeof(Expression)
        )
        private let ExpressionAssignMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Assign",
            typeof(Expression),
            typeof(Expression)
        )
        private let ExpressionBlockMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "Block",
            typeof(IEnumerable[ParameterExpression]),
            typeof(IEnumerable[Expression])
        )
        private let ExpressionNewArrayInitMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "NewArrayInit",
            typeof(Type),
            typeof([]Expression)
        )
        private let ExpressionNewArrayBoundsMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "NewArrayBounds",
            typeof(Type),
            typeof([]Expression)
        )
        private let ExpressionArrayIndexMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "ArrayIndex",
            typeof(Expression),
            typeof(Expression)
        )
        private let ExpressionArrayAccessMethod MethodInfo = GetRequiredMethod(
            typeof(Expression),
            "ArrayAccess",
            typeof(Expression),
            typeof([]Expression)
        )
        private let ExpressionDefaultMethod MethodInfo = GetRequiredMethod(typeof(Expression), "Default", typeof(Type))
        private let TypeGetConstructorMethod MethodInfo = GetRequiredMethod(
            typeof(Type),
            "GetConstructor",
            typeof([]Type)
        )
        private let TypeGetConstructorWithBindingFlagsMethod MethodInfo = GetRequiredMethod(
            typeof(Type),
            "GetConstructor",
            typeof(BindingFlags),
            typeof(ReflectionBinder),
            typeof([]Type),
            typeof([]ParameterModifier)
        )
        private let TypeGetFieldMethod MethodInfo = GetRequiredMethod(
            typeof(Type),
            "GetField",
            typeof(string),
            typeof(BindingFlags)
        )
        private let TypeGetMethodByParameterTypesMethod MethodInfo = GetRequiredMethod(
            typeof(Type),
            "GetMethod",
            typeof(string),
            typeof(BindingFlags),
            typeof(ReflectionBinder),
            typeof([]Type),
            typeof([]ParameterModifier)
        )
        private let TypeGetPropertyMethod MethodInfo = GetRequiredMethod(
            typeof(Type),
            "GetProperty",
            typeof(string),
            typeof(BindingFlags)
        )

        // Issue #2373: unlike the arithmetic/bitwise/shift/logical factories,
        // System.Linq.Expressions.Expression's six relational/equality factories
        // (Equal/NotEqual/LessThan/LessThanOrEqual/GreaterThan/GreaterThanOrEqual)
        // do NOT expose a 3-arg (Expression, Expression, MethodInfo) overload —
        // only a 4-arg (Expression, Expression, bool liftToNull, MethodInfo)
        // overload exists. See BuildClrBinaryOperatorExpression.
        private let ComparisonFactoryMethodNames HashSet[string] = HashSet[string](StringComparer.Ordinal){
            "Equal",
            "NotEqual",
            "LessThan",
            "LessThanOrEqual",
            "GreaterThan",
            "GreaterThanOrEqual"
        }

        func Lower(program BoundProgram) BoundProgram {
            let lowerer = ExpressionTreeLowerer()
            var changed = false
            let functions = ImmutableDictionary.CreateBuilder[FunctionSymbol, BoundBlockStatement]()
            // Issue #4663: deterministic order, never identity-hash order.
            for pair in BoundProgramOrder.Functions(program) {
                let newBody = cast[BoundBlockStatement](lowerer.RewriteStatement(pair.Value))
                functions[pair.Key] = newBody
                changed |= newBody != pair.Value
            }
            let statement = cast[BoundBlockStatement](lowerer.RewriteStatement(program.Statement))
            changed |= statement != program.Statement
            let initializers = program.Initializers.ToBuilder()
            // Issue #4663: deterministic order, never identity-hash order.
            for pair in BoundProgramOrder.Initializers(program) {
                initializers[pair.Key] = pair.Value.Rewrite(lowerer.RewriteExpression, lowerer.RewriteStatement)
                changed |= initializers[pair.Key] != pair.Value
            }
            if !changed {
                return program
            }
            return BoundProgram(
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
                program.Delegates
            ){
                Initializers = initializers.ToImmutable(),
                Imports = program.Imports,
                FriendAssemblies = program.FriendAssemblies,
                AssemblyAttributes = program.AssemblyAttributes,
                ModuleAttributes = program.ModuleAttributes,
                NativeProtocols = program.NativeProtocols
            }
        }

        private func BuildMethodInfoConstant(method MethodInfo) BoundExpression -> BoundLiteralExpression(
            nil,
            method,
            ReflectionMethodInfoTypeSymbol
        )

        private func BuildUserOperatorMethodInfoLookup(expression BoundClrBinaryOperatorExpression) BoundExpression {
            let function = expression.Function ??
                throw NotSupportedException("A same-compilation expression-tree operator requires a function symbol.")
            return BuildUserFunctionMethodInfoLookup(
                expression.Syntax,
                function,
                expression.FunctionOwnerType,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
        }

        private func BuildUserFunctionMethodInfoLookup(
            syntax SyntaxNode?,
            function FunctionSymbol,
            functionOwnerType StructSymbol?,
            flags BindingFlags
        ) BoundExpression {
            let ownerType = functionOwnerType ??
                function.StaticOwnerType as StructSymbol ??
                throw NotSupportedException("Function '${function.Name}' has no same-compilation declaring type.")
            let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](function.Parameters.Length)
            for parameter in function.Parameters {
                parameterTypes.Add(ownerType.SubstituteMemberType(parameter.Type)!!)
            }
            return BoundImportedInstanceCallExpression(
                syntax,
                CreateTypeOf(ownerType),
                TypeGetMethodByParameterTypesMethod,
                ReflectionMethodInfoTypeSymbol,
                ImmutableArray.Create[BoundExpression](
                    BoundLiteralExpression(nil, function.Name, TypeSymbol.String),
                    BuildBindingFlagsConstant(flags),
                    BoundLiteralExpression(nil, nil, TypeSymbol.Null),
                    BuildTypeArray(parameterTypes.MoveToImmutable()),
                    BoundLiteralExpression(nil, nil, TypeSymbol.Null)
                )
            )
        }

        private func BuildMemberInfoConstant(member MemberInfo) BoundExpression -> BoundLiteralExpression(
            nil,
            member,
            ReflectionMemberInfoTypeSymbol
        )

        private func BuildUserFieldInfoLookup(ownerType TypeSymbol, memberName string) BoundExpression {
            return BoundImportedInstanceCallExpression(
                nil,
                CreateTypeOf(ownerType),
                TypeGetFieldMethod,
                ReflectionFieldInfoTypeSymbol,
                ImmutableArray.Create[BoundExpression](
                    BoundLiteralExpression(nil, memberName, TypeSymbol.String),
                    BuildBindingFlagsConstant(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                )
            )
        }

        private func BuildUserPropertyInfoLookup(receiverType TypeSymbol, property PropertySymbol) BoundExpression {
            TypeMemberModel.TryGetPropertyWithOwner(
                receiverType,
                property,
                out var effectiveProperty,
                out var ownerType
            )
            return BoundImportedInstanceCallExpression(
                nil,
                CreateTypeOf(
                    Invariant.Required(ownerType, "the bound property owner was found", expression: "ownerType")
                ),
                TypeGetPropertyMethod,
                ReflectionPropertyInfoTypeSymbol,
                ImmutableArray.Create[BoundExpression](
                    BoundLiteralExpression(
                        nil,
                        Invariant.Required(
                            effectiveProperty,
                            "the bound property was found",
                            expression: "effectiveProperty"
                        )
                            .Name,
                        TypeSymbol.String
                    ),
                    BuildBindingFlagsConstant(
                        BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
                    )
                )
            )
        }

        private func CreateTypeOf(type TypeSymbol) BoundExpression -> BoundTypeOfExpression(nil, type, SystemTypeSymbol)

        private func UpcastToExpression(
            expression BoundExpression
        ) BoundExpression -> if expression.Type == ExpressionTypeSymbol {
            expression
        } else {
            cast[BoundExpression](BoundConversionExpression(nil, ExpressionTypeSymbol, expression))
        }

        private func BuildTypeArray(types IEnumerable[TypeSymbol]) BoundExpression {
            let elements = ImmutableArray.CreateBuilder[BoundExpression]()
            for type in types {
                elements.Add(CreateTypeOf(type))
            }
            return BoundArrayCreationExpression(
                nil,
                ArrayTypeSymbol.Get(SystemTypeSymbol, elements.Count),
                elements.ToImmutable()
            )
        }

        // Rubber-duck follow-up to issue #2224: builds the `MemberInfo[]` array
        // for the 3-arg `Expression.New(ctor, args, members)` overload, one
        // PropertyInfo lookup per primary-ctor parameter (in argument order).
        private func BuildMemberInfoArray(
            ownerType TypeSymbol,
            parameters ImmutableArray[ParameterSymbol]
        ) BoundExpression {
            let elements = ImmutableArray.CreateBuilder[BoundExpression]()
            for parameter in parameters {
                elements.Add(
                    BuildUserPropertyInfoLookup(
                        ownerType,
                        Invariant.Required(
                            BoundStructLiteralExpression.GetPrimaryMember(
                                Invariant.Required(
                                    ownerType as StructSymbol,
                                    "anonymous constructor members belong to a source aggregate",
                                    expression: "ownerType as StructSymbol"
                                ),
                                parameter.Name
                            ) as PropertySymbol,
                            "anonymous constructor members are actual own properties",
                            expression: `BoundStructLiteralExpression.GetPrimaryMember(
                        Invariant.Required(ownerType as StructSymbol, "anonymous constructor members belong to a source aggregate"),
                        parameter.Name) as PropertySymbol`
                        )
                    )
                )
            }
            return BoundArrayCreationExpression(
                nil,
                ArrayTypeSymbol.Get(ReflectionMemberInfoTypeSymbol, elements.Count),
                elements.ToImmutable()
            )
        }

        private func BuildExpressionArray(expressions IEnumerable[BoundExpression]) BoundExpression {
            let elements = ImmutableArray.CreateBuilder[BoundExpression]()
            for expression in expressions {
                elements.Add(UpcastToExpression(expression))
            }
            return BoundArrayCreationExpression(
                nil,
                ArrayTypeSymbol.Get(ExpressionTypeSymbol, elements.Count),
                elements.ToImmutable()
            )
        }

        private func BuildParameterArray(parameters IEnumerable[LocalVariableSymbol]) BoundExpression {
            let elements = ImmutableArray.CreateBuilder[BoundExpression]()
            for parameter in parameters {
                elements.Add(BoundVariableExpression(nil, parameter))
            }
            return BoundArrayCreationExpression(
                nil,
                ArrayTypeSymbol.Get(ParameterExpressionTypeSymbol, elements.Count),
                elements.ToImmutable()
            )
        }

        private func BuildMemberBindingArray(bindings IEnumerable[BoundExpression]) BoundExpression {
            let elements = ImmutableArray.CreateBuilder[BoundExpression]()
            for binding in bindings {
                elements.Add(
                    if binding.Type == MemberBindingTypeSymbol {
                        binding
                    } else {
                        cast[BoundExpression](BoundConversionExpression(nil, MemberBindingTypeSymbol, binding))
                    }
                )
            }
            return BoundArrayCreationExpression(
                nil,
                ArrayTypeSymbol.Get(MemberBindingTypeSymbol, elements.Count),
                elements.ToImmutable()
            )
        }

        private func BuildBindingFlagsConstant(flags BindingFlags) BoundExpression -> BoundConversionExpression(
            nil,
            BindingFlagsTypeSymbol,
            BoundLiteralExpression(nil, int32(flags), TypeSymbol.Int32)
        )

        private func GetArgumentTypes(arguments ImmutableArray[BoundExpression]) ImmutableArray[TypeSymbol] {
            let builder = ImmutableArray.CreateBuilder[TypeSymbol](arguments.Length)
            for argument in arguments {
                builder.Add(argument.Type)
            }
            return builder.MoveToImmutable()
        }

        private func GetNullableTypeSymbols(types ImmutableArray[TypeSymbol?]) ImmutableArray[TypeSymbol] {
            if types.IsDefault {
                return ImmutableArray[TypeSymbol].Empty
            }
            let result = ImmutableArray.CreateBuilder[TypeSymbol](types.Length)
            for type in types {
                result.Add(type ?? TypeSymbol.Error)
            }
            return result.MoveToImmutable()
        }

        // Normalizes an uninitialized type-argument vector to Empty. Callers
        // enumerate the result, and enumerating a default ImmutableArray throws --
        // returning `default` here would defeat the whole point of the helper.
        private func GetTypeSymbols(types ImmutableArray[TypeSymbol]) ImmutableArray[TypeSymbol] -> if types.IsDefault {
            ImmutableArray[TypeSymbol].Empty
        } else {
            types
        }

        private func GetCallableParameters(function FunctionSymbol) ImmutableArray[ParameterSymbol] {
            if function.ExplicitReceiverParameter == nil {
                return function.Parameters
            }
            return function.Parameters.RemoveAt(0)
        }

        private func ExtractLambdaBodyExpression(body BoundBlockStatement) BoundExpression {
            var candidate BoundExpression? = nil
            for statement in body.Statements {
                switch statement {
                    case BoundReturnStatement{Expression: not nil} ret {
                        return ret.Expression!!
                    }
                    case exprStmt is BoundExpressionStatement {
                        candidate = exprStmt.Expression
                    }
                }
            }
            return candidate ??
                throw NotSupportedException(
                "Expression-tree lambda body did not contain a supported trailing expression."
            )
        }

        private func TryMatchObjectInitializer(
            block BoundBlockExpression,
            @NotNullWhen(true) out receiver VariableSymbol?,
            @NotNullWhen(true) out initializer BoundExpression?,
            out statements ImmutableArray[BoundStatement],
            out captures ImmutableArray[BoundVariableDeclaration]
        ) bool {
            receiver = nil
            initializer = nil
            statements = default(ImmutableArray[BoundStatement])
            captures = default(ImmutableArray[BoundVariableDeclaration])
            if block.Expression is not BoundVariableExpression result {
                return false
            }
            let leading = ImmutableArray.CreateBuilder[BoundVariableDeclaration]()
            for var index = 0; index < block.Statements.Length; index++ {
                if block.Statements[index] is not BoundVariableDeclaration{Initializer: not nil} declaration {
                    return false
                }
                if object.ReferenceEquals(declaration.Variable, result.Variable) {
                    receiver = declaration.Variable
                    initializer = declaration.Initializer
                    statements = block.Statements.RemoveRange(0, index + 1)
                    captures = leading.ToImmutable()
                    return true
                }
                leading.Add(declaration)
            }
            return false
        }

        private func ReferencesReceiver(
            expression BoundExpression?,
            receiver VariableSymbol
        ) bool -> expression is BoundVariableExpression variable &&
            object.ReferenceEquals(variable.Variable, receiver)

        private func ReferencesReceiver(
            assignment BoundFieldAssignmentExpression,
            receiver VariableSymbol
        ) bool -> object.ReferenceEquals(assignment.Receiver, receiver) ||
            ReferencesReceiver(assignment.ReceiverExpression, receiver)

        private func IsDelegateLike(type TypeSymbol) bool -> MemberLookup.TryGetDelegateFunctionTypeFromSymbol(
            type,
            out _
        )

        private func GetRequiredMethod(type Type, name string, parameterTypes ...Type) MethodInfo -> type.GetMethod(
            name,
            parameterTypes
        ) ??
            throw InvalidOperationException("Required method '${type.FullName}.$name' is not available.")
    }
}
