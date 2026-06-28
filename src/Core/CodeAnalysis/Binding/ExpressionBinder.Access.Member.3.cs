// <copyright file="ExpressionBinder.Access.Member.3.cs" company="GSharp">
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


    internal BoundExpression BindUserTypeStaticCall(StructSymbol structSym, CallExpressionSyntax ce)
    {
        var methodName = ce.Identifier.Text;

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        List<int> deferredStaticLambdaIndices = null;
        var staticArgIndex = 0;
        foreach (var argument in ce.Arguments)
        {
            if (argument is RefArgumentExpressionSyntax refArg)
            {
                boundArguments.Add(BindRefArgumentExpression(refArg, parameter: null));
            }
            else if (IsUntypedArrowLambda(OverloadResolver.UnwrapNamedArgumentValue(argument)))
            {
                // Issue #951: defer un-typed arrow lambdas until the static
                // method overload (and its delegate-typed parameters) is known.
                (deferredStaticLambdaIndices ??= new List<int>()).Add(staticArgIndex);
                boundArguments.Add(new BoundErrorExpression(OverloadResolver.UnwrapNamedArgumentValue(argument)));
            }
            else
            {
                boundArguments.Add(BindExpression(argument));
            }

            staticArgIndex++;
        }

        var arguments = boundArguments.ToImmutable();

        // Issue #940: resolve static (shared) method overloads against the FULL
        // method group by arity, parameter types, and ref-kinds — identical to
        // the instance-method path — instead of taking the first by-name match
        // and arity-checking it (which rejected every overload but the first,
        // surfacing GS0144). The group is obtained through the ADR-0112
        // canonical member-resolution layer; OverloadResolver selects the best
        // candidate (and reports ambiguity / no-applicable-overload exactly as
        // for instance methods). A single-candidate group is returned unchanged
        // so the legacy per-position arity/optional/variadic diagnostics below
        // still apply (e.g. genuine arity mismatch on a non-overloaded method).
        var staticMethodGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Static(MemberKinds.Method));
        if (!staticMethodGroup.IsDefaultOrEmpty)
        {
            var method = overloads.SelectInstanceOverloadOrReport(staticMethodGroup, arguments, ce, methodName, argumentNames: default);
            if (method == null)
            {
                return new BoundErrorExpression(null);
            }

            // Issue #951: bind any deferred un-typed arrow lambda against the
            // selected static method's delegate-typed parameter so its omitted
            // parameter type(s) and inferred return type are filled in from the
            // parameter shape. Static (`shared`) methods carry no receiver
            // parameter, so the argument index maps directly to the parameter
            // index. A non-delegate parameter leaves the lambda deferred; it is
            // then bound with no target (surfacing GS0304).
            if (deferredStaticLambdaIndices != null)
            {
                var rebound = arguments.ToBuilder();
                foreach (var idx in deferredStaticLambdaIndices)
                {
                    if (rebound[idx] is not BoundErrorExpression { Syntax: LambdaExpressionSyntax staticLambda })
                    {
                        continue;
                    }

                    if (idx < method.Parameters.Length
                        && MemberLookup.TryGetDelegateFunctionTypeFromSymbol(method.Parameters[idx].Type, out var staticTarget)
                        && staticTarget != null)
                    {
                        rebound[idx] = lambdas.BindLambdaExpression(staticLambda, staticTarget);
                    }
                    else
                    {
                        rebound[idx] = lambdas.BindLambdaExpression(staticLambda);
                    }
                }

                arguments = rebound.ToImmutable();
            }

            // ADR-0101 follow-up / issue #812: a user-declared static method
            // may declare a trailing variadic parameter. Allow flexible
            // arity, infer the element type from trailing args (if generic),
            // and pack / pass-through trailing args into a single slice
            // argument before the per-position conversion loop.
            var isVariadic = method.Parameters.Length > 0 && method.Parameters[method.Parameters.Length - 1].IsVariadic;
            var fixedParamCount = isVariadic ? method.Parameters.Length - 1 : method.Parameters.Length;

            // ADR-0063 / issue #936: count the leading non-optional parameters.
            // A static (`shared`) call may omit any trailing parameter that
            // declares a default value, mirroring the instance-call path in
            // OverloadResolver. Omitted slots are synthesized below from each
            // parameter's captured default constant.
            var requiredParamCount = method.Parameters.Length;
            for (var i = method.Parameters.Length - 1; i >= 0; i--)
            {
                if (method.Parameters[i].HasExplicitDefaultValue)
                {
                    requiredParamCount = i;
                }
                else
                {
                    break;
                }
            }

            if (isVariadic)
            {
                if (arguments.Length < fixedParamCount)
                {
                    Diagnostics.ReportTooFewArgumentsForVariadic(ce.Location, method.Name, fixedParamCount, arguments.Length);
                    return new BoundErrorExpression(null);
                }
            }
            else if (arguments.Length < requiredParamCount || arguments.Length > method.Parameters.Length)
            {
                Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, method.Parameters.Length, arguments.Length);
                return new BoundErrorExpression(null);
            }

            // Issue #312 / ADR-0020: resolve a generic static method's own type
            // arguments from an explicit `[T1, T2]` list at the call site or by
            // left-to-right inference from argument types.
            Dictionary<TypeParameterSymbol, TypeSymbol> substitution = null;
            if (method.IsGeneric)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
                if (ce.TypeArgumentList != null)
                {
                    var explicitArgs = ce.TypeArgumentList.Arguments;
                    if (explicitArgs.Count != method.TypeParameters.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(ce.TypeArgumentList.Location, method.Name, method.TypeParameters.Length, explicitArgs.Count);
                        return new BoundErrorExpression(null);
                    }

                    for (var i = 0; i < explicitArgs.Count; i++)
                    {
                        var ta = bindTypeClause(explicitArgs[i]);
                        if (ta == null)
                        {
                            return new BoundErrorExpression(null);
                        }

                        substitution[method.TypeParameters[i]] = ta;
                    }
                }
                else
                {
                    // ADR-0101 follow-up / issue #812: when the static method is
                    // variadic, fixed parameters infer pairwise as before;
                    // for the variadic slot, infer the element type from each
                    // trailing argument. A single trailing `[]U` arg with
                    // pass-through inference still infers `T=U`.
                    var inferenceLimit = isVariadic ? fixedParamCount : arguments.Length;
                    for (var i = 0; i < inferenceLimit; i++)
                    {
                        Binder.InferTypeArguments(method.Parameters[i].Type, arguments[i].Type, substitution);
                    }

                    if (isVariadic)
                    {
                        var variadicParam = method.Parameters[method.Parameters.Length - 1];
                        var variadicElementType = ((SliceTypeSymbol)variadicParam.Type).ElementType;
                        var trailingCount = arguments.Length - fixedParamCount;
                        if (trailingCount == 1 && arguments[fixedParamCount].Type is SliceTypeSymbol singleSlice)
                        {
                            Binder.InferTypeArguments(variadicElementType, singleSlice.ElementType, substitution);
                        }
                        else
                        {
                            for (var i = fixedParamCount; i < arguments.Length; i++)
                            {
                                Binder.InferTypeArguments(variadicElementType, arguments[i].Type, substitution);
                            }
                        }
                    }

                    foreach (var tp in method.TypeParameters)
                    {
                        if (!substitution.ContainsKey(tp))
                        {
                            Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, method.Name, tp.Name);
                            return new BoundErrorExpression(null);
                        }
                    }
                }

                var constraintLocation = ce.TypeArgumentList != null
                    ? ce.TypeArgumentList.Location
                    : ce.Identifier.Location;
                foreach (var tp in method.TypeParameters)
                {
                    var typeArg = substitution[tp];
                    if (!Binder.SatisfiesConstraint(typeArg, tp))
                    {
                        Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, Binder.DescribeConstraint(tp));
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // ADR-0101 follow-up / issue #812: pack / pass-through for the
            // variadic slot. A single trailing arg whose type already equals
            // the substituted slice type passes through; otherwise wrap the
            // trailing args in a fresh `[]T` slice. Empty trailing => empty
            // slice.
            ImmutableArray<BoundExpression> permutedArgs;
            if (isVariadic)
            {
                var variadicParam = method.Parameters[method.Parameters.Length - 1];
                var sliceType = (SliceTypeSymbol)variadicParam.Type;
                var substitutedSlice = substitution != null
                    ? (SliceTypeSymbol)Binder.SubstituteType(sliceType, substitution)
                    : sliceType;
                var trailingCount = arguments.Length - fixedParamCount;
                var passThrough = trailingCount == 1 && arguments[fixedParamCount].Type == substitutedSlice;
                if (passThrough)
                {
                    permutedArgs = arguments;
                }
                else
                {
                    var packedTrailing = ImmutableArray.CreateBuilder<BoundExpression>(trailingCount);
                    for (var i = fixedParamCount; i < arguments.Length; i++)
                    {
                        packedTrailing.Add(arguments[i]);
                    }

                    var newArgs = ImmutableArray.CreateBuilder<BoundExpression>(fixedParamCount + 1);
                    for (var i = 0; i < fixedParamCount; i++)
                    {
                        newArgs.Add(arguments[i]);
                    }

                    newArgs.Add(new BoundArrayCreationExpression(ce, substitutedSlice, packedTrailing.MoveToImmutable()));
                    permutedArgs = newArgs.ToImmutable();
                }
            }
            else
            {
                // ADR-0063 / issue #936: pad any trailing optional parameters
                // the static call omitted with their captured default values so
                // the per-position conversion loop binds the full parameter
                // list (matching instance-method behavior).
                if (arguments.Length < method.Parameters.Length)
                {
                    var padded = ImmutableArray.CreateBuilder<BoundExpression>(method.Parameters.Length);
                    padded.AddRange(arguments);
                    for (var i = arguments.Length; i < method.Parameters.Length; i++)
                    {
                        padded.Add(OverloadResolver.CreateOptionalUserDefaultArgument(method.Parameters[i]));
                    }

                    permutedArgs = padded.MoveToImmutable();
                }
                else
                {
                    permutedArgs = arguments;
                }
            }

            var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArgs.Length);
            for (var i = 0; i < permutedArgs.Length; i++)
            {
                var paramType = method.Parameters[i].Type;

                // ADR-0060 / issue #1139: an inline-decl `out var n` / `out let
                // n` / `out _` was bound with TypeSymbol.Error in the first
                // pass (before the static method was resolved) and never
                // declared a local. Now that overload resolution has chosen the
                // method — and the method type-argument substitution is known —
                // re-bind it (via the shared helper used by the instance path)
                // so the synthesized local is typed from the resolved
                // (substituted) out-parameter pointee type and leaks into the
                // enclosing block scope. The out-var arg always sits in the
                // fixed-parameter region, so permutedArgs[i] / ce.Arguments[i] /
                // method.Parameters[i] line up. This must run BEFORE the
                // open-type-parameter shortcut so generic static out-parameters
                // (`func G[T](out r T)`) are handled too.
                var slotSyntax = i < ce.Arguments.Count ? ce.Arguments[i] : null;
                var substitutedPointeeType = substitution != null ? Binder.SubstituteType(paramType, substitution) : paramType;
                var reboundOutVar = TryRebindInlineOutVarPlaceholder(permutedArgs[i], slotSyntax, method.Parameters[i], substitutedPointeeType);
                if (reboundOutVar != null)
                {
                    convertedArgs.Add(reboundOutVar);
                    continue;
                }

                if (paramType is TypeParameterSymbol)
                {
                    convertedArgs.Add(permutedArgs[i]);
                    continue;
                }

                if (substitution != null
                    && paramType is FunctionTypeSymbol openFunctionParameter
                    && LambdaBinder.TryGetFunctionLiteral(permutedArgs[i], out var functionLiteralArgument))
                {
                    // ADR-0087 §3 R6: substitute the open target before
                    // routing through the adapter. When the substituted
                    // target matches the literal's declared shape the
                    // adapter returns the literal unchanged (see
                    // IsIdentityAdapter), so the emitted MethodDef carries
                    // the literal's concrete signature and the reified
                    // Func/Action TypeSpec at the call site dispatches
                    // through real Invoke without DynamicInvoke marshalling.
                    var substitutedOpenTarget = (Binder.SubstituteType(openFunctionParameter, substitution) as FunctionTypeSymbol)
                        ?? openFunctionParameter;
                    convertedArgs.Add(lambdas.CreateErasedFunctionLiteralAdapter(functionLiteralArgument, substitutedOpenTarget));
                    continue;
                }

                var expectedType = substitution != null ? Binder.SubstituteType(paramType, substitution) : paramType;
                var argLoc = i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
                convertedArgs.Add(conversions.BindCallArgumentWithRefKind(argLoc, permutedArgs[i], expectedType, method.Parameters[i]));
            }

            // Issue #1209: when the static call dispatches on a constructed
            // generic user type, carry the construction so the emitter parents
            // the call at the construction's TypeSpec (a bare MethodDef token is
            // invalid for a method of a generic type). Null for non-generic
            // receivers leaves the ordinary MethodDef path unchanged.
            var staticGenericOwner = structSym.Definition != null ? structSym : null;

            if (substitution != null)
            {
                var substitutedReturn = Binder.SubstituteType(method.Type, substitution);
                if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
                {
                    substitutedReturn = lambdas.WrapAsTask(substitutedReturn);
                    return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), substitutedReturn) { StaticGenericOwnerType = staticGenericOwner };
                }

                if (!ReferenceEquals(substitutedReturn, method.Type))
                {
                    return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), substitutedReturn) { StaticGenericOwnerType = staticGenericOwner };
                }
            }

            if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
            {
                var asyncReturn = lambdas.WrapAsTask(method.Type);
                return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), asyncReturn) { StaticGenericOwnerType = staticGenericOwner };
            }

            return new BoundCallExpression(null, method, convertedArgs.ToImmutable()) { StaticGenericOwnerType = staticGenericOwner };
        }

        Diagnostics.ReportUnableToFindMember(ce.Location, methodName);
        return new BoundErrorExpression(null);
    }
}
