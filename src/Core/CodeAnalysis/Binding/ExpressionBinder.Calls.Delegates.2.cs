// <copyright file="ExpressionBinder.Calls.Delegates.2.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{


    private static bool SymbolicLambdaParameterTypesAgree(Dictionary<int, ImmutableArray<TypeSymbol>> a, Dictionary<int, ImmutableArray<TypeSymbol>> b)
    {
        if (a.Count != b.Count)
        {
            return false;
        }

        foreach (var kv in a)
        {
            if (!b.TryGetValue(kv.Key, out var other) || other.Length != kv.Value.Length)
            {
                return false;
            }

            for (var i = 0; i < kv.Value.Length; i++)
            {
                if (!Equals(kv.Value[i], other[i]))
                {
                    return false;
                }
            }
        }

        return true;
    }

    private bool TryBindUserStructDelegateFieldInvocation(
        BoundExpression receiver,
        StructSymbol receiverStruct,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result)
    {
        result = null;

        // Walk the base chain so an inherited delegate field on a base class
        // is invokable on a derived instance.
        FieldSymbol matchedField = null;
        StructSymbol declaringType = null;
        for (var c = receiverStruct; c != null; c = c.BaseClass)
        {
            if (c.TryGetField(methodName, out var f))
            {
                matchedField = f;
                declaringType = c;
                break;
            }
        }

        if (matchedField == null)
        {
            return false;
        }

        FunctionTypeSymbol functionType;
        if (matchedField.Type is FunctionTypeSymbol fts)
        {
            functionType = fts;
        }
        else if (matchedField.Type is DelegateTypeSymbol nds)
        {
            functionType = nds.EquivalentFunctionType;
        }
        else if (matchedField.Type?.ClrType is System.Type fieldClrType
            && ClrTypeUtilities.IsDelegateType(fieldClrType)
            && MemberLookup.TryGetDelegateFunctionType(fieldClrType, out var clrFn))
        {
            functionType = clrFn;
        }
        else
        {
            return false;
        }

        // ADR-0102 follow-up / issue #818: when the field's declared
        // function type spells a trailing variadic parameter, pack /
        // pass-through trailing args at the call site.
        var fldIsVariadic = functionType.HasVariadic;
        var fldFixedCount = fldIsVariadic ? functionType.ParameterTypes.Length - 1 : functionType.ParameterTypes.Length;
        if (fldIsVariadic)
        {
            if (arguments.Length < fldFixedCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(ce.Location, methodName, fldFixedCount, arguments.Length);
                result = new BoundErrorExpression(null);
                return true;
            }
        }
        else if (arguments.Length != functionType.ParameterTypes.Length)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, functionType.ParameterTypes.Length, arguments.Length);
            result = new BoundErrorExpression(null);
            return true;
        }

        ImmutableArray<BoundExpression> permutedArgs = arguments;
        if (fldIsVariadic)
        {
            var sliceType = (SliceTypeSymbol)functionType.ParameterTypes[functionType.ParameterTypes.Length - 1];
            var trailing = arguments.Length - fldFixedCount;
            var passThrough = trailing == 1 && arguments[fldFixedCount].Type == sliceType;
            if (!passThrough)
            {
                var packed = ImmutableArray.CreateBuilder<BoundExpression>(trailing);
                for (var i = fldFixedCount; i < arguments.Length; i++)
                {
                    packed.Add(arguments[i]);
                }

                var rebuilt = ImmutableArray.CreateBuilder<BoundExpression>(fldFixedCount + 1);
                for (var i = 0; i < fldFixedCount; i++)
                {
                    rebuilt.Add(arguments[i]);
                }

                rebuilt.Add(new BoundArrayCreationExpression(ce, sliceType, packed.MoveToImmutable()));
                permutedArgs = rebuilt.ToImmutable();
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArgs.Length);
        for (var i = 0; i < permutedArgs.Length; i++)
        {
            var argLoc = i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
            convertedArgs.Add(conversions.BindConversion(argLoc, permutedArgs[i], functionType.ParameterTypes[i]));
        }

        var fieldLoad = new BoundFieldAccessExpression(null, receiver, declaringType, matchedField);
        result = new BoundIndirectCallExpression(null, fieldLoad, functionType, convertedArgs.MoveToImmutable());
        return true;
    }

    /// <summary>
    /// Issue #527: when an accessor-style call <c>receiver.Member(args)</c>
    /// matches no method on the CLR receiver type, fall back to a public
    /// field or property of the same name whose type is a CLR delegate.
    /// Lowers to a load of the delegate value (<c>ldfld</c> / property getter)
    /// followed by an <c>Invoke(args)</c> call. Returns <see langword="true"/>
    /// when a delegate-typed member matched and the call was bound (the
    /// resulting expression may be a <see cref="BoundErrorExpression"/> if
    /// argument resolution failed).
    /// </summary>
    private bool TryBindClrDelegateMemberInvocation(
        BoundExpression receiver,
        System.Type clrType,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;
        if (clrType == null)
        {
            return false;
        }

        // Prefer a property of the right name over a field — the same
        // precedence used by the read path in BindAccessorStep (properties
        // first, fields fallback). Indexer properties (those with parameters)
        // are not member-style invocable, so skip them.
        System.Reflection.MemberInfo member = ClrTypeUtilities.SafeGetProperty(clrType, methodName, BindingFlags.Public | BindingFlags.Instance);
        if (member is System.Reflection.PropertyInfo prop && (prop.GetIndexParameters().Length != 0 || !prop.CanRead))
        {
            member = null;
        }

        member ??= ClrTypeUtilities.SafeGetField(clrType, methodName, BindingFlags.Public | BindingFlags.Instance);
        if (member == null)
        {
            return false;
        }

        System.Type memberClrType = member switch
        {
            System.Reflection.PropertyInfo p => p.PropertyType,
            System.Reflection.FieldInfo f => f.FieldType,
            _ => null,
        };
        if (memberClrType == null || !ClrTypeUtilities.IsDelegateType(memberClrType))
        {
            return false;
        }

        TypeSymbol memberTypeSymbol = member switch
        {
            System.Reflection.PropertyInfo p2 => ClrNullability.GetPropertyTypeSymbol(p2),
            System.Reflection.FieldInfo f2 => ClrNullability.GetFieldTypeSymbol(f2),
            _ => TypeSymbol.FromClrType(memberClrType),
        };

        // The delegate value load — `ldfld` for a field, `call get_X` for a
        // property. The shared BoundClrPropertyAccessExpression node carries
        // either MemberInfo shape, and EmitClrPropertyAccess already handles
        // both (including the value-type-receiver `ldloca` step we need for
        // a CLR struct field).
        var delegateLoad = new BoundClrPropertyAccessExpression(null, receiver, member, memberTypeSymbol);

        // Strip nullable annotation when dispatching through Invoke — the
        // delegate value is loaded as-is from the field; the call would
        // dereference null at runtime if the member is unassigned. This
        // matches CLR semantics for `del()` on a null `Func<T>`.
        var underlyingDelegateClr = memberClrType;

        // Reuse the same Invoke-overload-resolution path that the bare
        // delegate-variable call uses at #325 (BindCallExpression), so
        // generic delegate arguments, named arguments, and ref/in/out are
        // all handled uniformly.
        if (TryBindInheritedClrInstanceCall(delegateLoad, underlyingDelegateClr, "Invoke", arguments, ce, out var invokeCall, argumentNames: argumentNames))
        {
            result = invokeCall;
            return true;
        }

        // No applicable Invoke overload — most likely an argument-count or
        // type mismatch. Report against the member name (not "Invoke") so the
        // diagnostic points to what the user wrote.
        var invoke = memberClrType.GetMethod("Invoke");
        var expectedArity = invoke?.GetParameters().Length ?? 0;
        if (arguments.Length != expectedArity)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, methodName, expectedArity, arguments.Length);
        }
        else
        {
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        }

        result = new BoundErrorExpression(null);
        return true;
    }

    /// <summary>
    /// ADR-0059 / issue #255: lowers a <c>delegateValue.Invoke(args)</c>
    /// call against a value of <see cref="DelegateTypeSymbol"/> into a
    /// <see cref="BoundIndirectCallExpression"/> whose function shape is the
    /// delegate's equivalent <see cref="FunctionTypeSymbol"/>. The emitter
    /// recognises a DelegateTypeSymbol target and routes the call through
    /// the delegate's runtime-implemented Invoke MethodDef.
    /// </summary>
    private BoundExpression BindNamedDelegateInvokeCall(BoundExpression receiver, DelegateTypeSymbol delegateSym, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce)
    {
        // ADR-0101 follow-up / issue #812: a named delegate may declare a
        // trailing variadic parameter. Apply the same arity + pack /
        // pass-through rule that we use for the direct-call (`del(args)`)
        // path so the explicit `.Invoke(args)` spelling behaves identically.
        var isVariadic = delegateSym.Parameters.Length > 0
            && delegateSym.Parameters[delegateSym.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? delegateSym.Parameters.Length - 1 : delegateSym.Parameters.Length;

        if (isVariadic)
        {
            if (arguments.Length < fixedParamCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(ce.Location, delegateSym.Name, fixedParamCount, arguments.Length);
                return new BoundErrorExpression(null);
            }
        }
        else if (arguments.Length != delegateSym.Parameters.Length)
        {
            Diagnostics.ReportWrongArgumentCount(ce.Location, delegateSym.Name, delegateSym.Parameters.Length, arguments.Length);
            return new BoundErrorExpression(null);
        }

        var permutedArgs = arguments;
        if (isVariadic)
        {
            var variadicParam = delegateSym.Parameters[delegateSym.Parameters.Length - 1];
            var sliceType = (SliceTypeSymbol)variadicParam.Type;
            var trailingCount = arguments.Length - fixedParamCount;
            var passThrough = trailingCount == 1 && arguments[fixedParamCount].Type == sliceType;
            if (!passThrough)
            {
                var packed = ImmutableArray.CreateBuilder<BoundExpression>(trailingCount);
                for (var i = fixedParamCount; i < arguments.Length; i++)
                {
                    packed.Add(arguments[i]);
                }

                var rebuilt = ImmutableArray.CreateBuilder<BoundExpression>(fixedParamCount + 1);
                for (var i = 0; i < fixedParamCount; i++)
                {
                    rebuilt.Add(arguments[i]);
                }

                rebuilt.Add(new BoundArrayCreationExpression(ce, sliceType, packed.MoveToImmutable()));
                permutedArgs = rebuilt.ToImmutable();
            }
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArgs.Length);
        for (var i = 0; i < permutedArgs.Length; i++)
        {
            var argLoc = i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
            convertedArgs.Add(conversions.BindConversion(argLoc, permutedArgs[i], delegateSym.Parameters[i].Type));
        }

        return new BoundIndirectCallExpression(null, receiver, delegateSym.EquivalentFunctionType, convertedArgs.MoveToImmutable());
    }

    private ImmutableArray<BoundExpression> RebindFunctionLiteralDelegateArguments(
        ImmutableArray<BoundExpression> arguments,
        ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping = default)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            var argument = arguments[i];
            var rebound = argument;
            if (paramIndex < parameters.Length
                && LambdaBinder.TryGetFunctionLiteral(argument, out var literal)
                && MemberLookup.TryGetDelegateFunctionType(parameters[paramIndex].ParameterType, out var targetFunctionType)
                && literal.FunctionType != targetFunctionType)
            {
                rebound = lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType);
            }

            if (rebound != argument && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(arguments[j]);
                }
            }

            builder?.Add(rebound);
        }

        if (builder == null)
        {
            return arguments;
        }

        for (var i = builder.Count; i < arguments.Length; i++)
        {
            builder.Add(arguments[i]);
        }

        return builder.ToImmutable();
    }

    // Issue #1150: reshape only those func/arrow literal arguments whose natural
    // numeric return type implicitly, losslessly widens to the corresponding
    // delegate parameter's return type. The reshape routes through the erased
    // adapter (the established pattern for generic-LINQ dispatch), inserting the
    // numeric return-widening conversion in the body so the produced delegate's
    // return type matches the target. Literals whose return already matches the
    // target (the common LINQ case: Where/Single/Select with bool/string
    // selectors) are left completely untouched, preserving their natural
    // concrete delegate signature.
    private ImmutableArray<BoundExpression> RebindNumericReturnWideningDelegateArguments(
        ImmutableArray<BoundExpression> arguments,
        ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping = default)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            var argument = arguments[i];
            var rebound = argument;
            if (paramIndex < parameters.Length
                && LambdaBinder.TryGetFunctionLiteral(argument, out var literal)
                && literal.FunctionType is FunctionTypeSymbol literalFnType
                && literalFnType.ReturnType != TypeSymbol.Void
                && literalFnType.ReturnType != TypeSymbol.Error
                && MemberLookup.TryGetDelegateFunctionType(parameters[paramIndex].ParameterType, out var targetFunctionType)
                && targetFunctionType.ReturnType != TypeSymbol.Void
                && targetFunctionType.ReturnType != TypeSymbol.Error
                && targetFunctionType.Arity == literalFnType.Arity
                && !ReferenceEquals(literalFnType.ReturnType, targetFunctionType.ReturnType)
                && Conversion.Classify(literalFnType.ReturnType, targetFunctionType.ReturnType).IsImplicit)
            {
                rebound = lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType);
            }

            if (rebound != argument && builder == null)
            {
                builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
                for (var j = 0; j < i; j++)
                {
                    builder.Add(arguments[j]);
                }
            }

            builder?.Add(rebound);
        }

        if (builder == null)
        {
            return arguments;
        }

        for (var i = builder.Count; i < arguments.Length; i++)
        {
            builder.Add(arguments[i]);
        }

        return builder.ToImmutable();
    }
}
