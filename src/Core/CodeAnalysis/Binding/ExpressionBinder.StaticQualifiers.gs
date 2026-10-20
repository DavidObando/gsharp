package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Reflection

internal partial class ExpressionBinder {
    // Record only the actual direct member selected by normal binding. A type
    // qualifier is not an expression receiver and must not be rebound by tools.
    private func RecordStaticTypeQualifier(result BoundExpression, owner TypeSymbol, member ExpressionSyntax) {
        if member is not(NameExpressionSyntax or CallExpressionSyntax) {
            return
        }
        let read = UnwrapTransparentMemberResult(result)
        let isStatic = switch read {
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
            default: false
        }
        if isStatic {
            read.RecordStaticQualifier(owner, member)
        }
    }
}
