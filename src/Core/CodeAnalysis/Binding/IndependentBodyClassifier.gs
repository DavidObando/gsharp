package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic

/// Proves that a body uses scalar operations, canonical enum constants, and body-owned locals.
/// Unknown forms stay on the coordinator, which owns shared synthesis and inferred signatures.
internal class IndependentBodyClassifier {
    private let declarationScope BoundScope?
    private var typeLookupContext BinderContext?
    private var currentFunction FunctionSymbol?

    private init(declarationScope BoundScope?) {
        this.declarationScope = declarationScope
    }

    shared {
        internal func CanBind(function FunctionSymbol, declarationScope BoundScope? = nil) bool ->
        IndependentBodyClassifier(declarationScope).CanBindBody(function)
    }

    private func CanBindBody(function FunctionSymbol) bool {
        currentFunction = function
        if function
            .Declaration
            ?.Body is not{} body ||
            function.ThisParameter != nil ||
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

    private func IsPrimitive(type TypeSymbol) bool -> type == TypeSymbol.Bool ||
        type == TypeSymbol.Char ||
        type == TypeSymbol.Int8 ||
        type == TypeSymbol.UInt8 ||
        type == TypeSymbol.Int16 ||
        type == TypeSymbol.UInt16 ||
        type == TypeSymbol.Int32 ||
        type == TypeSymbol.UInt32 ||
        type == TypeSymbol.Int64 ||
        type == TypeSymbol.UInt64 ||
        type == TypeSymbol.NInt ||
        type == TypeSymbol.NUInt ||
        type == TypeSymbol.Float32 ||
        type == TypeSymbol.Float64 ||
        type == TypeSymbol.String ||
        (type is EnumSymbol and {ContainingType: nil})

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
            case SwitchStatementSyntax selection {
                let type = ExpressionType(selection.Expression, locals)
                if type == nil {
                    return false
                }
                for arm in selection.Cases {
                    if arm.Guard != nil ||
                        (!arm.IsDefault && !IsScalarPattern(arm.Value, type, locals)) ||
                        !VisitStatement(arm.Body, Dictionary[string, TypeSymbol](locals), returnType) {
                        return false
                    }
                }
                return true
            }
            default {
                return false
            }
        }
    }

    private func IsScalarPattern(pattern PatternSyntax?, type TypeSymbol, locals Dictionary[string, TypeSymbol]) bool {
        return switch pattern {
            case ConstantPatternSyntax constant: ExpressionType(constant.Expression, locals) == type
            case TypeOrConstantPatternSyntax candidate when candidate.PropertyPattern == nil:
            ExpressionType(candidate.Expression, locals) == type
            case DiscardPatternSyntax: true
            case BinaryPatternSyntax binary:
            IsScalarPattern(binary.Left, type, locals) && IsScalarPattern(binary.Right, type, locals)
            case ParenthesizedPatternSyntax parenthesized: IsScalarPattern(parenthesized.Pattern, type, locals)
            default: false
        }
    }

    private func ExpressionType(expression ExpressionSyntax, locals Dictionary[string, TypeSymbol]) TypeSymbol? {
        if expression.Kind is not(
            SyntaxKind.LiteralExpression or
                SyntaxKind.NameExpression or
                SyntaxKind.ParenthesizedExpression or
                SyntaxKind.UnaryExpression or
                SyntaxKind.BinaryExpression or
                SyntaxKind.AssignmentExpression or
                SyntaxKind.AccessorExpression or
                SyntaxKind.SwitchExpression
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
                    case char: TypeSymbol.Char
                    case string: TypeSymbol.String
                    default: default(TypeSymbol?)
                }
            }
            case NameExpressionSyntax name {
                return LookupLocal(name.IdentifierToken.ValueText, locals)
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
                let type = LookupLocal(assignment.IdentifierToken.ValueText, locals)
                return if type != nil && value == type {
                    type
                } else {
                    default(TypeSymbol?)
                }
            }
            case AccessorExpressionSyntax accessor {
                let scope_ = declarationScope
                if accessor.IsNullConditional ||
                    accessor.LeftPart is not NameExpressionSyntax owner ||
                    accessor.RightPart is not NameExpressionSyntax member ||
                    locals.ContainsKey(owner.IdentifierToken.ValueText) || scope_ == nil || scope_.TryLookupSymbol(
                    owner.IdentifierToken.ValueText
                ) is VariableSymbol {
                    return nil
                }
                if currentFunction?.StaticOwnerType is StructSymbol ownerType &&
                    (
                    !ownerType.TypeParameters.IsDefaultOrEmpty || !StructSymbol.CollectEnclosingTypeParameters(
                        ownerType
                    )
                        .IsDefaultOrEmpty
                ) {
                    return nil
                }
                let name = owner.IdentifierToken.ValueText
                if scope_.TryLookupImport(name, out var import_) && import_!!.IsAlias {
                    return nil
                }
                typeLookupContext ??= BinderContext(scope_)
                if !typeLookupContext!!.TryLookupSourceType(scope_, name, 0, currentFunction, out var type, out _) ||
                    type is not(EnumSymbol and {ContainingType: nil}) {
                    return nil
                }
                let enumType = cast[EnumSymbol](type)
                return if enumType.TryGetMember(member.IdentifierToken.ValueText, out _) {
                    enumType
                } else {
                    default(TypeSymbol?)
                }
            }
            case SwitchExpressionSyntax selection {
                let type = ExpressionType(selection.Expression, locals)
                if type == nil {
                    return nil
                }
                var resultType TypeSymbol? = nil
                for arm in selection.Arms {
                    if arm.Guard != nil || (!arm.IsDefault && !IsScalarPattern(arm.Value, type, locals)) {
                        return nil
                    }
                    let candidate = ExpressionType(arm.Result, locals)
                    if candidate == nil || (resultType != nil && resultType != candidate) {
                        return nil
                    }
                    resultType = candidate
                }
                return resultType
            }
            default {
                return nil
            }
        }
    }

    private func LookupLocal(name string, locals Dictionary[string, TypeSymbol]) TypeSymbol? {
        // Discards do not create lookup-visible local bindings.
        return if name != "_" && locals.TryGetValue(name, out var type) {
            type
        } else {
            default(TypeSymbol?)
        }
    }
}
