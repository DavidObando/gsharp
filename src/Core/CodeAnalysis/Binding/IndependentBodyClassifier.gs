package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic

/// Proves that a body uses only primitive operations and body-owned locals.
/// Unknown forms stay on the coordinator, which owns shared synthesis and inferred signatures.
internal shared class IndependentBodyClassifier {
    internal func CanBind(function FunctionSymbol) bool {
        if function
            .Declaration
            ?.Body is not{} body ||
            function.IsAsyncOrSuspending ||
            function.IsReturnTypeInferred ||
            !function
            .TypeParameters
            .IsDefaultOrEmpty ||
            function.ReturnRefKind != RefKind.None ||
            (function.Type != TypeSymbol.Void && !IsPrimitive(function.Type)) {
            return false
        }
        let locals = Dictionary[string, TypeSymbol]()
        for parameter in function.Parameters {
            if parameter.RefKind != RefKind.None || !IsPrimitive(parameter.Type) || locals.ContainsKey(parameter.Name) {
                return false
            }
            locals.Add(parameter.Name, parameter.Type)
        }
        return VisitStatement(body, locals, function.Type)
    }

    private func IsPrimitive(type TypeSymbol) bool -> type.GetType() == typeof(TypeSymbol) &&
        type
        .ClrType
        ?.IsPrimitive == true

    private func VisitStatement(
        statement StatementSyntax,
        locals Dictionary[string, TypeSymbol],
        returnType TypeSymbol
    ) bool {
        switch statement {
            case BlockStatementSyntax block {
                let blockLocals = Dictionary[string, TypeSymbol](locals)
                for child in block.Statements {
                    if !VisitStatement(child, blockLocals, returnType) {
                        return false
                    }
                }
                return true
            }
            case VariableDeclarationSyntax declaration {
                if declaration.TypeClause != nil ||
                    declaration.IsAsyncLet ||
                    declaration.IsScoped ||
                    declaration.HasRefKindModifier ||
                    declaration.IsGeneric ||
                    !declaration
                    .Annotations
                    .IsDefaultOrEmpty ||
                    declaration.Initializer is not{} initializer ||
                    locals.ContainsKey(declaration.Identifier.ValueText) {
                    return false
                }
                let type = ExpressionType(initializer, locals)
                if type == nil {
                    return false
                }
                locals.Add(declaration.Identifier.ValueText, type)
                return true
            }
            case ReturnStatementSyntax ret {
                return !ret.IsRefReturn &&
                    (
                    if ret.Expression is {} expression {
                        ExpressionType(expression, locals) == returnType
                    } else {
                        returnType == TypeSymbol.Void
                    }
                )
            }
            case IfStatementSyntax conditional {
                return conditional.Initializer == nil &&
                    ExpressionType(conditional.Condition, locals) == TypeSymbol.Bool &&
                    VisitStatement(conditional.ThenStatement, Dictionary[string, TypeSymbol](locals), returnType) &&
                    (
                    conditional.ElseClause == nil ||
                        VisitStatement(
                        conditional.ElseClause.ElseStatement,
                        Dictionary[string, TypeSymbol](locals),
                        returnType
                    )
                )
            }
            case WhileStatementSyntax loop {
                return ExpressionType(loop.Condition, locals) == TypeSymbol.Bool &&
                    VisitStatement(loop.Body, Dictionary[string, TypeSymbol](locals), returnType)
            }
            case ForConditionStatementSyntax loop {
                return ExpressionType(loop.Condition, locals) == TypeSymbol.Bool &&
                    VisitStatement(loop.Body, Dictionary[string, TypeSymbol](locals), returnType)
            }
            case ExpressionStatementSyntax expression {
                return expression.Expression is AssignmentExpressionSyntax &&
                    ExpressionType(expression.Expression, locals) != nil
            }
            default {
                return false
            }
        }
    }

    private func ExpressionType(expression ExpressionSyntax, locals Dictionary[string, TypeSymbol]) TypeSymbol? {
        if expression.Kind is not(
            SyntaxKind.LiteralExpression or
                SyntaxKind.NameExpression or
                SyntaxKind.ParenthesizedExpression or
                SyntaxKind.UnaryExpression or
                SyntaxKind.BinaryExpression or
                SyntaxKind.AssignmentExpression
        ) {
            return nil
        }
        switch expression {
            case LiteralExpressionSyntax literal {
                return switch literal.Value {
                    case bool: TypeSymbol.Bool
                    case int32: TypeSymbol.Int32
                    case uint32: TypeSymbol.UInt32
                    case int64: TypeSymbol.Int64
                    case uint64: TypeSymbol.UInt64
                    case float32: TypeSymbol.Float32
                    case float64: TypeSymbol.Float64
                    default: default(TypeSymbol?)
                }
            }
            case NameExpressionSyntax name {
                return if locals.TryGetValue(name.IdentifierToken.ValueText, out var type) {
                    type
                } else {
                    default(TypeSymbol?)
                }
            }
            case ParenthesizedExpressionSyntax paren {
                return ExpressionType(paren.Expression, locals)
            }
            case UnaryExpressionSyntax unary {
                let operand = ExpressionType(unary.Operand, locals)
                return if operand == nil {
                    default(TypeSymbol?)
                } else {
                    BoundUnaryOperator.Bind(unary.OperatorToken.Kind, operand)?.Type
                }
            }
            case BinaryExpressionSyntax binary {
                let left = ExpressionType(binary.Left, locals)
                let right = ExpressionType(binary.Right, locals)
                return if left == nil || right == nil {
                    default(TypeSymbol?)
                } else {
                    BoundBinaryOperator.Bind(binary.OperatorToken.Kind, left, right)?.Type
                }
            }
            case AssignmentExpressionSyntax assignment {
                let value = ExpressionType(assignment.Expression, locals)
                return if locals.TryGetValue(assignment.IdentifierToken.ValueText, out var type) && value == type {
                    type
                } else {
                    default(TypeSymbol?)
                }
            }
            default {
                return nil
            }
        }
    }
}
