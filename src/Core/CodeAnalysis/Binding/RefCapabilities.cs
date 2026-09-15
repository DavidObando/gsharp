// <copyright file="RefCapabilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

internal static class RefCapabilities
{
    internal static string DescribeReturn(RefKind kind)
        => kind == RefKind.RefReadOnly ? "by ref readonly" : kind == RefKind.Ref ? "by ref" : "by value";

    internal static bool IsReadOnlyReference(BoundExpression expression)
        => expression switch
        {
            // An immutable pointer binding does not make its pointee readonly.
            BoundVariableExpression { Type: ByRefTypeSymbol or PointerTypeSymbol } => false,
            BoundVariableExpression { Variable: LocalVariableSymbol local } =>
                local.RefKind == RefKind.RefReadOnly || local.RefKind == RefKind.In,
            BoundVariableExpression => false,
            BoundBlockExpression block => IsReadOnlyReference(block.Expression),
            BoundFieldAccessExpression field => field.Receiver != null
                && !Binder.IsReferenceTypeForConstraint(field.Receiver.Type) && IsReadOnlyReference(field.Receiver),
            _ => IsReadOnlyStorage(expression),
        };

    internal static bool IsReadOnlyMethod(MethodInfo method)
        => method.GetCustomAttributesData().Any(
                attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute")
            || method.DeclaringType?.GetCustomAttributesData().Any(
                attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute") == true;

    internal static TypeSymbol GetInferenceType(ParameterSymbol parameter, TypeSymbol argumentType)
        => parameter.RefKind != RefKind.None && argumentType is ByRefTypeSymbol byRef
            ? byRef.PointeeType
            : argumentType;

    internal static RefKind GetReturnRefKind(MethodInfo? method)
    {
        if (method?.ReturnType.IsByRef != true)
        {
            return RefKind.None;
        }

        var parameter = method.ReturnParameter;
        return parameter.GetRequiredCustomModifiers().Any(
                type => type.FullName == "System.Runtime.InteropServices.InAttribute")
            || parameter.GetCustomAttributesData().Any(
                attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute")
                ? RefKind.RefReadOnly
                : RefKind.Ref;
    }

    internal static RefKind GetReturnRefKind(PropertyInfo property)
        => !property.PropertyType.IsByRef ? RefKind.None
            : GetReturnRefKind(property.GetMethod) == RefKind.RefReadOnly
                || property.GetRequiredCustomModifiers().Any(type => type.FullName == "System.Runtime.InteropServices.InAttribute")
                || property.GetCustomAttributesData().Any(attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute")
                    ? RefKind.RefReadOnly
                    : RefKind.Ref;

    internal static bool IsReadOnlyStorage(BoundExpression expression)
        => expression switch
        {
            BoundVariableExpression variable => variable.Variable.IsReadOnly,
            BoundBlockExpression block => IsReadOnlyStorage(block.Expression),
            BoundConditionalExpression conditional => IsReadOnlyStorage(conditional.WhenTrue) || IsReadOnlyStorage(conditional.WhenFalse),
            BoundConditionalAddressExpression conditional => IsReadOnlyStorage(conditional.WhenTrueOperand) || IsReadOnlyStorage(conditional.WhenFalseOperand),
            BoundFieldAccessExpression field => field.Field.IsReadOnly || IsReadOnlyValueReceiver(field.Receiver),
            BoundAddressOfExpression address => address.IsReadOnly,
            BoundDereferenceExpression dereference => IsReadOnlyReference(dereference.Operand),
            BoundPropertyAccessExpression property => property.Property.ReturnRefKind == RefKind.RefReadOnly,
            BoundCallExpression call => call.Function.ReturnRefKind == RefKind.RefReadOnly,
            BoundUserInstanceCallExpression call => call.Method.ReturnRefKind == RefKind.RefReadOnly,
            BoundBaseInterfaceCallExpression call => call.Method.ReturnRefKind == RefKind.RefReadOnly,
            BoundBaseClassCallExpression call => (call.Method?.ReturnRefKind ?? call.Property?.ReturnRefKind) == RefKind.RefReadOnly,
            BoundConstrainedStaticCallExpression call => (call.InterfaceMethod?.ReturnRefKind ?? GetReturnRefKind(call.ClrMethod)) == RefKind.RefReadOnly,
            BoundImportedCallExpression call => GetReturnRefKind(call.Function.Method) == RefKind.RefReadOnly,
            BoundImportedInstanceCallExpression call => GetReturnRefKind(call.Method) == RefKind.RefReadOnly,
            BoundClrStaticCallExpression call => GetReturnRefKind(call.Method) == RefKind.RefReadOnly,
            BoundClrIndexExpression index => GetReturnRefKind(index.Indexer) == RefKind.RefReadOnly,
            BoundClrPropertyAccessExpression { Member: PropertyInfo property } => GetReturnRefKind(property) == RefKind.RefReadOnly,
            BoundClrPropertyAccessExpression { Member: FieldInfo field } access => field.IsInitOnly || field.IsLiteral || IsReadOnlyValueReceiver(access.Receiver),
            _ => false,
        };

    internal static bool IsReadOnlyValueReceiver(BoundExpression? expression)
        => expression != null
            && !Binder.IsReferenceTypeForConstraint(expression.Type)
            && IsReadOnlyStorage(expression);

    internal static bool IsReadOnlyValueReference(BoundExpression expression)
        => !Binder.IsReferenceTypeForConstraint(expression.Type)
            && IsReadOnlyReference(expression);
}
