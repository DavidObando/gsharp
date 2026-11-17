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
        if isStatic || read is BoundErrorExpression {
            read.RecordStaticQualifier(owner, member)
        }
    }
}
