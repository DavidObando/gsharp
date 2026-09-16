// <copyright file="RefCapabilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

internal static class RefCapabilities
{
    /// <summary>
    /// Issue #4224: true when <paramref name="expression"/> is a call to a
    /// same-compilation (native) ref-returning function/method or a read of a
    /// native ref-returning property. An imported/CLR ref-returning member is
    /// NOT included here — <see cref="ConversionClassifier.AutoDereferenceRefReturn"/>
    /// already wraps those in a <see cref="BoundDereferenceExpression"/> at
    /// bind time, so they are already lvalues (see
    /// <see cref="ExpressionBinder.IsLvalue"/>'s <c>BoundDereferenceExpression</c>
    /// case) with no change needed here.
    /// </summary>
    /// <param name="expression">The bound expression to classify.</param>
    /// <returns><see langword="true"/> when the expression is such a call/property read.</returns>
    internal static bool IsNativeRefReturningCall(BoundExpression expression)
        => expression switch
        {
            // A [Conditional]-elided call leaves nothing on the stack to
            // address (issue #176 / ADR-0047 §6).
            BoundCallExpression { IsConditionalElided: true } => false,
            BoundCallExpression call => call.Function.ReturnRefKind != RefKind.None,
            BoundUserInstanceCallExpression uic => uic.Method.ReturnRefKind != RefKind.None,

            // A flow-narrowed read (issue #1180) inserts a cast after the
            // getter call; the raw managed pointer from the getter would not
            // point at the narrowed value, so a narrowed read is excluded.
            BoundPropertyAccessExpression { NarrowedType: not null } => false,
            BoundPropertyAccessExpression prop => prop.Property.ReturnRefKind != RefKind.None,
            _ => false,
        };

    /// <summary>
    /// Issue #4224 (root cause #4): decomposes a native ref-returning call or
    /// property read into the pieces the caller-side ref-safe-scope
    /// computation (<c>HasFunctionLocalRefScope</c>) needs — its instance
    /// receiver (whose storage the callee could be returning a reference
    /// into) and the argument expressions passed to <c>ref</c>/<c>in</c>/
    /// <c>out</c> parameters (any of which the callee could likewise be
    /// returning). A <c>scoped ref</c>/<c>scoped in</c> parameter is excluded:
    /// the callee's own signature promises not to return that reference, so
    /// the caller's argument does not contribute to the result's scope.
    /// </summary>
    /// <param name="expression">The bound expression to decompose.</param>
    /// <param name="receiver">The instance receiver, or <see langword="null"/> for a static/no-receiver call.</param>
    /// <param name="byRefArguments">The underlying storage of each non-<c>scoped</c> ref/in/out argument.</param>
    /// <returns>
    /// <see langword="false"/> when <paramref name="expression"/> is not a
    /// native ref-returning call/property (the two out parameters are then
    /// empty).
    /// </returns>
    internal static bool TryGetRefReturnEscapeSources(
        BoundExpression expression,
        out BoundExpression? receiver,
        out ImmutableArray<BoundExpression> byRefArguments)
    {
        switch (expression)
        {
            case BoundCallExpression { IsConditionalElided: false } call when call.Function.ReturnRefKind != RefKind.None:
                receiver = null;
                byRefArguments = SelectByRefArguments(call.Function.Parameters, call.Arguments);
                return true;
            case BoundUserInstanceCallExpression uic when uic.Method.ReturnRefKind != RefKind.None:
                receiver = uic.Receiver;
                byRefArguments = SelectByRefArguments(uic.Method.Parameters, uic.Arguments);
                return true;
            case BoundPropertyAccessExpression { NarrowedType: null } prop when prop.Property.ReturnRefKind != RefKind.None:
                receiver = prop.Receiver;
                byRefArguments = ImmutableArray<BoundExpression>.Empty;
                return true;
            default:
                receiver = null;
                byRefArguments = ImmutableArray<BoundExpression>.Empty;
                return false;
        }
    }

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

            // Issue #4224: a WRITABLE (`Ref`) getter/method called on a
            // read-only value-type receiver is treated as read-only storage
            // too — mirroring the field-access case just above and matching
            // C#'s conservative rule that any non-`readonly`-marked struct
            // member called on a `readonly` value requires a defensive copy,
            // so writing through whatever reference it returns cannot be
            // trusted to reach the original storage.
            BoundPropertyAccessExpression property => property.Property.ReturnRefKind == RefKind.RefReadOnly
                || (property.Property.ReturnRefKind == RefKind.Ref && IsReadOnlyValueReceiver(property.Receiver)),
            BoundCallExpression call => call.Function.ReturnRefKind == RefKind.RefReadOnly,
            BoundUserInstanceCallExpression call => call.Method.ReturnRefKind == RefKind.RefReadOnly
                || (call.Method.ReturnRefKind == RefKind.Ref && IsReadOnlyValueReceiver(call.Receiver)),
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

    /// <summary>
    /// Selects the operand each <c>ref</c>/<c>in</c>/<c>out</c> argument's
    /// address was taken of. Conservative on any shape the caller-side scope
    /// walk cannot decompose (a conditional address, a parameter/argument
    /// count mismatch, or a byref argument that was not itself wrapped in a
    /// <see cref="BoundAddressOfExpression"/>): the unrecognized argument
    /// expression itself is returned unchanged so the recursive
    /// <c>HasFunctionLocalRefScope</c> walk's default ("unrecognized shape is
    /// function-local, i.e. unsafe") still applies, rather than silently
    /// treating an undecomposable argument as safe to escape through.
    /// </summary>
    private static ImmutableArray<BoundExpression> SelectByRefArguments(
        ImmutableArray<ParameterSymbol> parameters,
        ImmutableArray<BoundExpression> arguments)
    {
        if (parameters.IsDefaultOrEmpty || arguments.IsDefaultOrEmpty)
        {
            return ImmutableArray<BoundExpression>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<BoundExpression>();
        var count = System.Math.Min(parameters.Length, arguments.Length);
        for (int i = 0; i < count; i++)
        {
            var parameter = parameters[i];
            if (parameter.RefKind == RefKind.None || parameter.IsScoped)
            {
                continue;
            }

            builder.Add(arguments[i] is BoundAddressOfExpression addr ? addr.Operand : arguments[i]);
        }

        return builder.ToImmutable();
    }
}
