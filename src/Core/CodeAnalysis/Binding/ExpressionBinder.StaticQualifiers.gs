package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Reflection

internal partial class ExpressionBinder {
    // Keep the resolved type qualifier when member selection fails, so tools can complete an unfinished access.
    private func RecordStaticTypeQualifier(result BoundExpression, owner TypeSymbol, member ExpressionSyntax) {
        if member is not(NameExpressionSyntax or CallExpressionSyntax) {
            return
        }
        var read = UnwrapTransparentMemberResult(result)
        while read.LogicalCompletionOperand is {} operand {
            read = UnwrapTransparentMemberResult(operand)
        }
        let isStatic = IsStaticQualifiedResult(read, member)
        if isStatic || read is BoundErrorExpression {
            read.RecordStaticQualifier(owner, member)
        }
    }

    private func IsStaticQualifiedResult(read BoundExpression, member ExpressionSyntax) bool -> switch read {
        case property is BoundPropertyAccessExpression: property.Receiver == nil && property.Property.IsStatic
        case field is BoundFieldAccessExpression: field.Receiver == nil && field.Field.IsStatic
        case call is BoundCallExpression: call.Function.IsStatic
        case call is BoundImportedCallExpression: call.Function?.Method.IsStatic == true
        case call is BoundConstrainedStaticCallExpression:
        call.InterfaceMethod?.IsStatic == true || call.ClrMethod?.IsStatic == true
        case BoundLiteralExpression: member is NameExpressionSyntax
        case imported is BoundClrPropertyAccessExpression: imported.Receiver == nil && switch imported.Member {
            case field is FieldInfo: field.IsStatic
            case property is PropertyInfo: (property.GetMethod ?? property.SetMethod)?.IsStatic == true
            default: false
        }
        case importedCall is BoundImportedInstanceCallExpression:
        IsStaticQualifiedCallee(importedCall.Receiver)
        case indirect is BoundIndirectCallExpression: IsStaticQualifiedCallee(indirect.Target)
        case fnPtr is BoundFunctionPointerInvocationExpression: IsStaticQualifiedCallee(fnPtr.Pointer)
        case hop is BoundNullConditionalAccessExpression: IsStaticQualifiedCallee(hop.Receiver)
        default: false
    }

    private func IsStaticQualifiedCallee(node BoundExpression) bool {
        var hasCalleeIdentifier = false
        var current BoundExpression? = node
        while current != nil {
            if current.CalleeIdentifier != nil {
                hasCalleeIdentifier = true
            }
            if current is BoundFieldAccessExpression or
                BoundPropertyAccessExpression or
                BoundClrPropertyAccessExpression or
                BoundCallExpression {
                return hasCalleeIdentifier && IsStaticQualifiedMemberRead(current)
            }
            current = switch current {
                case deref is BoundDereferenceExpression: deref.Operand
                case unary is BoundUnaryExpression when unary.Op.Kind == BoundUnaryOperatorKind.NullAssertion:
                unary.Operand
                case conv is BoundConversionExpression when conv.Syntax == nil || object.ReferenceEquals(
                    conv.ImplicitConversionOperand,
                    conv.Expression
                ): conv.Expression
                case idx is BoundIndexExpression: idx.Target
                case clrIdx is BoundClrIndexExpression: clrIdx.Target
                case userIdx is BoundUserInstanceCallExpression when !hasCalleeIdentifier: userIdx.Receiver
                case clrIdxCall is BoundImportedInstanceCallExpression when !hasCalleeIdentifier: clrIdxCall.Receiver
                default: default(BoundExpression?)
            }
        }
        return false
    }

    private func IsStaticQualifiedMemberRead(read BoundExpression) bool -> switch read {
        case property is BoundPropertyAccessExpression: property.Receiver == nil && property.Property.IsStatic
        case field is BoundFieldAccessExpression: field.Receiver == nil && field.Field.IsStatic
        case call is BoundCallExpression: call.Function.IsStatic
        case imported is BoundClrPropertyAccessExpression: imported.Receiver == nil && switch imported.Member {
            case field is FieldInfo: field.IsStatic
            case property is PropertyInfo: (property.GetMethod ?? property.SetMethod)?.IsStatic == true
            default: false
        }
        default: false
    }
}
