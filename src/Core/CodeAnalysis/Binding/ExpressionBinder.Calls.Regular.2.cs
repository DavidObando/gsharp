// <copyright file="ExpressionBinder.Calls.Regular.2.cs" company="GSharp">
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


    /// <summary>
    /// Issue #977: re-binds inline <c>out var</c>/<c>out let</c>/<c>out _</c>
    /// placeholder arguments against the by-ref parameters of the resolved
    /// imported method, declaring each new local with the parameter's pointee
    /// type. Returns the (possibly rebuilt) argument vector.
    /// </summary>
    /// <param name="ce">The call expression syntax.</param>
    /// <param name="arguments">The bound arguments (with placeholder out-var entries).</param>
    /// <param name="resolvedMethod">The chosen imported method (constructed if generic).</param>
    /// <param name="parameterMapping">The source-argument → parameter-position mapping; default for positional calls.</param>
    /// <param name="receiverType">The receiver's static type (for symbolic by-ref-parameter recovery); may be <see langword="null"/>.</param>
    /// <returns>The argument vector with inline out-var placeholders rebound.</returns>
    private ImmutableArray<BoundExpression> RebindInlineOutVarArguments(
        CallExpressionSyntax ce,
        ImmutableArray<BoundExpression> arguments,
        System.Reflection.MethodInfo resolvedMethod,
        ImmutableArray<int> parameterMapping,
        TypeSymbol receiverType = null)
    {
        ImmutableArray<BoundExpression>.Builder rebuilt = null;
        System.Reflection.ParameterInfo[] parameters = null;
        for (var i = 0; i < arguments.Length; i++)
        {
            if (!TryGetInlineOutVarArgument(ce, i, out var refArg))
            {
                continue;
            }

            parameters ??= resolvedMethod.GetParameters();
            var paramIndex = !parameterMapping.IsDefault && i < parameterMapping.Length ? parameterMapping[i] : i;
            if (paramIndex < 0 || paramIndex >= parameters.Length)
            {
                continue;
            }

            var clrParameterType = parameters[paramIndex].ParameterType;
            var pointeeClr = clrParameterType.IsByRef ? clrParameterType.GetElementType() : clrParameterType;

            // Issue #1107: when the by-ref parameter's pointee is a type-level
            // generic parameter on the receiver (e.g. `Dictionary[string,
            // Entry].TryGetValue(string, out TValue)`), the resolved CLR method
            // erased `TValue` to `object`, so the out-var local would bind as
            // `object` and member access on it (`found.V`) would fail (GS0158).
            // Recover the symbolic pointee type from the receiver's symbolic
            // type arguments (mirroring `ResolveInstanceReturnTypeFromReceiver`).
            var pointeeType = ResolveInstanceParameterPointeeTypeFromReceiver(receiverType, resolvedMethod, paramIndex)
                ?? TypeSymbol.FromClrType(pointeeClr);
            var syntheticParameter = new ParameterSymbol(
                parameters[paramIndex].Name ?? "value",
                pointeeType,
                refKind: RefKind.Out);

            var rebound = BindRefArgumentExpression(refArg, syntheticParameter);
            rebuilt ??= arguments.ToBuilder();
            rebuilt[i] = rebound;
        }

        return rebuilt != null ? rebuilt.ToImmutable() : arguments;
    }

    private BoundExpression BindAccessorCall(BoundExpression receiver, ImportedClassSymbol classSymbol, CallExpressionSyntax ce)
    {
        var methodName = ce.Identifier.Text;
        var hasNamedArguments = ce.Arguments.Any(argument => argument is NamedArgumentExpressionSyntax);
        if (classSymbol == null && methodName == "copy" && (hasNamedArguments || (receiver?.Type is StructSymbol copyStruct && copyStruct.IsData)))
        {
            if (TryGetCopyOverrides(ce, out var overrides))
            {
                return LowerCopyOrWith(receiver, overrides, ce.Identifier.Location);
            }

            Diagnostics.ReportNamedArgumentOnlyValidForCopy(ce.Location);
            return new BoundErrorExpression(null);
        }

        // Issue #343: validate named-argument layout (positional precedes named,
        // no duplicate names). Errors are reported by the helper so the call
        // short-circuits to a bound error here.
        if (!overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        // Issue #311: resolve an explicit `[T1, T2]` type-argument list (e.g.
        // `Array.Empty[string]()`) into mapped CLR types up front so every
        // generic-method dispatch path below can close the candidate.
        if (!TryResolveExplicitMethodTypeArgs(ce.TypeArgumentList, out var explicitTypeArgs, out var typeArgSymbols))
        {
            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        var deferredArrowLambdaIndices = new List<int>();
        List<ParameterInfo[]> delegateTargetCandidateParams = null;
        var delegateTargetCandidatesComputed = false;
        var argSlot = 0;
        foreach (var argument in ce.Arguments)
        {
            var inner = OverloadResolver.UnwrapNamedArgumentValue(argument);
            if (inner is RefArgumentExpressionSyntax refArg)
            {
                boundArguments.Add(BindRefArgumentExpression(refArg, parameter: null));
            }
            else if (argumentNames.IsDefault && IsUntypedArrowLambda(inner))
            {
                // Issue #891: defer binding of an un-typed arrow lambda until
                // the target delegate type is known. Binding it now would emit
                // GS0304 (cannot infer parameter type) and produce an error-typed
                // argument that aborts overload resolution — which is exactly why
                // `list.Single((c) -> c.Id == "x")` reported "Cannot find function
                // Single" while the explicit `func(c DoctorCheck) bool { ... }`
                // form worked. The placeholder keeps argument positions aligned;
                // the real binding happens once the (possibly generic) overload —
                // including LINQ extension methods — has been resolved below.
                deferredArrowLambdaIndices.Add(argSlot);
                boundArguments.Add(new BoundErrorExpression(inner));
            }
            else if (inner is LambdaExpressionSyntax)
            {
                // Issue #908: target-type an arrow lambda argument from the
                // matching delegate-typed parameter of the applicable CLR
                // static/instance/extension methods before binding it, mirroring
                // the constructor path (BindCallArgumentWithDelegateTargetTyping).
                // Without this, `Factory.CreateStatic(() -> MemoryStream())`
                // binds the lambda with its body-derived return type
                // (`() -> MemoryStream`) before overload resolution and fails to
                // match a `Func<Stream>` parameter (GS0159). Pinning the return
                // type from the delegate target yields `() -> Stream` directly so
                // the call resolves and the produced delegate is created over a
                // method whose return already matches the parameter.
                if (!delegateTargetCandidatesComputed)
                {
                    delegateTargetCandidatesComputed = true;
                    delegateTargetCandidateParams = CollectDelegateTargetCandidateParameterLists(receiver, classSymbol, methodName);
                }

                var argName = argumentNames.IsDefault ? null : argumentNames[argSlot];
                boundArguments.Add(BindCallArgumentWithDelegateTargetTyping(
                    argument, delegateTargetCandidateParams, sourceArgIndex: argSlot, argName: argName, paramOffset: 0));
            }
            else
            {
                boundArguments.Add(BindArgumentDeferringBranchy(inner));
            }

            argSlot++;
        }

        if (deferredArrowLambdaIndices.Count > 0)
        {
            var mutableArgs = boundArguments.ToArray();
            ResolveDeferredArrowLambdaArguments(receiver, classSymbol, methodName, ce, explicitTypeArgs, deferredArrowLambdaIndices, mutableArgs);

            // Issue #951: the reflection-driven resolution above only covers CLR
            // (imported) methods. When the receiver is a user-declared
            // class/struct/interface, recover the target delegate shape from the
            // user method's own parameter symbols so an arrow lambda passed to a
            // user method with a delegate-typed parameter (e.g.
            // `calc.Apply((x) -> x * 2)`) infers its parameter type too.
            ResolveDeferredArrowLambdaArgumentsFromUserMethods(receiver, methodName, ce, deferredArrowLambdaIndices, mutableArgs);

            // Any lambda whose target could not be inferred is now bound without
            // a target so the established GS0304 diagnostic still surfaces.
            foreach (var idx in deferredArrowLambdaIndices)
            {
                if (mutableArgs[idx] is BoundErrorExpression placeholder && placeholder.Syntax is LambdaExpressionSyntax pendingLambda)
                {
                    mutableArgs[idx] = lambdas.BindLambdaExpression(pendingLambda);
                }
            }

            boundArguments.Clear();
            boundArguments.AddRange(mutableArgs);
        }

        var arguments = boundArguments.ToImmutable();

        if (classSymbol != null)
        {
            if (classSymbol.TryLookupFunction(methodName, ce, arguments, out var staticFn, out var staticMapping, out var staticAmbiguous, out var staticAmbiguousMethods, out var staticIsExpanded, explicitTypeArgs, typeArgSymbols, scope.References.MapClrTypeToReferences, argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames))
            {
                var staticParameters = staticFn.Method.GetParameters();
                var staticExpandedArgs = staticIsExpanded
                    ? overloads.ExpandParamsArguments(arguments, staticParameters, ce, parameterMapping: staticMapping)
                    : arguments;
                var staticDownstreamMapping = staticIsExpanded ? default : staticMapping;
                var staticRebound = RebindFormattableInterpolationArguments(staticExpandedArgs, ce.Arguments, staticParameters, staticDownstreamMapping);
                var staticHandlerArgs = ApplyInterpolatedStringHandlers(staticParameters, staticRebound, receiver: null, ce.Location, staticDownstreamMapping, out var staticHandlerPrelude, out _);

                // Issue #889: void-ize value-returning func/arrow literals passed
                // to void-returning delegate parameters (System.Action / Action<...>)
                // before CLR parameter conversion, mirroring the instance path.
                var staticDelegateArgs = RebindFunctionLiteralDelegateArguments(staticHandlerArgs, staticParameters, staticDownstreamMapping);

                // Issue #506 follow-up: ensure value-type → object boxing fires
                // for fixed-arity CLR static calls (e.g. `String.Format("{0}", 42)`
                // selecting the fixed `(string, object)` overload).
                var staticConvertedArgs = conversions.BindClrParameterConversions(staticDelegateArgs, staticParameters, ce, staticDownstreamMapping);
                var staticArguments = OverloadResolver.BuildOrderedCallArguments(staticConvertedArgs, staticDownstreamMapping, staticParameters);
                var refKinds = ComputeArgumentRefKinds(staticParameters);
                overloads.ValidateRefArguments(staticArguments, refKinds, methodName, ce.Location);

                // Issue #1325: when the type arguments were inferred (no explicit
                // `[...]` list), recover the symbolic method type-argument vector
                // from the argument symbols so a same-compilation user value type
                // (erased to `object` in the closed CLR method) is emitted as its
                // real TypeDef token in the MethodSpec — e.g.
                // `MemoryMarshal.AsBytes<E>` rather than the constraint-violating
                // `AsBytes<object>`. Mirrors the instance/inherited call paths.
                var staticSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
                    receiverType: null,
                    ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
                var staticSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(staticFn.Method, typeArgSymbols, staticSymbolicArgs);
                var staticTypeArgSymbolsForCall = !staticSymbolicTypeArgs.IsDefault ? staticSymbolicTypeArgs : typeArgSymbols;
                BoundExpression staticCall = new BoundImportedCallExpression(null, staticFn, staticArguments, refKinds, staticTypeArgSymbolsForCall);
                return WrapWithHandlerPrelude(staticCall, staticHandlerPrelude, ce);
            }

            if (staticAmbiguous)
            {
                // Issue #505: surface the competing candidate signatures so the
                // caller can pick a disambiguation (typically an explicit
                // type-argument list).
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, staticAmbiguousMethods.Length, staticAmbiguousMethods.Select(OverloadResolution.FormatMethodSignature));
                return new BoundErrorExpression(null);
            }

            // Issue #343: a named-argument call that resolves to no candidate
            // is most actionably explained by the first unknown name (if any),
            // since the missing parameter is the prevailing cause.
            if (!argumentNames.IsDefault && overloads.TryReportUnknownNamedArgumentForClr(classSymbol.ClassType, methodName, BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public, ce, argumentNames))
            {
                return new BoundErrorExpression(null);
            }

            // Issue #569: when no static/instance method matches, check whether
            // the call identifier names a nested type of the outer class. If so,
            // bind as a constructor invocation — this unifies the call-expression
            // path with the type-clause path that #526 already fixed.
            if (TryBindNestedTypeConstructorCall(classSymbol.ClassType, ce, out var nestedCtorResult))
            {
                return nestedCtorResult;
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        // Issue #1320: normalize a sequence[T]/asyncsequence[T] or user-element
        // array receiver (whose ClrType is null during binding) to its erased
        // CLR shape so the shared CLR-instance member-lookup path below resolves
        // its enumerable surface (GetEnumerator, ...) uniformly with an
        // explicitly-typed IEnumerable[T] parameter and a primitive-element
        // receiver. The bound call keeps the original receiver expression.
        var effectiveReceiverType = receiver?.Type;
        if (receiver?.Type != null
            && TryNormalizeSymbolicEnumerableReceiver(receiver.Type, out var normalizedReceiverType))
        {
            effectiveReceiverType = normalizedReceiverType;
        }

        if (receiver == null || effectiveReceiverType?.ClrType == null)
        {
            // ADR-0059 / issue #255: a value of a user-declared named delegate
            // type supports member-style invocation `del.Invoke(args)` (same as
            // any CLR delegate). Lower to a BoundIndirectCallExpression whose
            // function shape mirrors the delegate's declared signature; the
            // emitter recognises a DelegateTypeSymbol target and dispatches
            // through the delegate's runtime-implemented Invoke MethodDef.
            if (receiver != null && receiver.Type is DelegateTypeSymbol delRecv && string.Equals(methodName, "Invoke", System.StringComparison.Ordinal))
            {
                return BindNamedDelegateInvokeCall(receiver, delRecv, arguments, ce);
            }

            // Phase 3.B.4: dispatch to a user-defined interface method when
            // the static receiver type is an interface.
            if (receiver != null && receiver.Type is InterfaceSymbol ifaceRecv)
            {
                var ifaceOverloads = TypeMemberModel.GetMethods(ifaceRecv, methodName, MemberQuery.Instance(MemberKinds.Method));

                // ADR-0090 / issue #756: private interface helpers are visible
                // ONLY when the call is made from inside another member of the
                // same interface declaration. Both instance and static
                // members of the same interface qualify (a private static
                // helper can be called from a static-virtual default body on
                // the same interface, etc.). When the current function's
                // ReceiverType / StaticOwnerType points at the same
                // InterfaceSymbol — including the generic-definition or any
                // constructed instance — widen the candidate set with the
                // private overloads.
                var owningIfaceDef = ifaceRecv.Definition ?? ifaceRecv;
                if (IsInsideSameInterface(owningIfaceDef))
                {
                    var privateOverloads = ifaceRecv.GetPrivateMethods(methodName);
                    if (privateOverloads.Length > 0)
                    {
                        ifaceOverloads = ifaceOverloads.AddRange(privateOverloads);
                    }
                }
                else if (ifaceOverloads.Length == 0)
                {
                    // Probe the private bucket so we can give a precise
                    // visibility diagnostic instead of the generic "method
                    // not found" channel.
                    var probePriv = ifaceRecv.GetPrivateMethods(methodName);
                    if (probePriv.Length > 0)
                    {
                        Diagnostics.ReportPrivateInterfaceMemberNotAccessible(ce.Location, owningIfaceDef.Name, methodName);
                        return new BoundErrorExpression(null);
                    }
                }

                if (ifaceOverloads.Length > 0)
                {
                    var ifaceMethod = overloads.SelectInstanceOverloadOrReport(ifaceOverloads, arguments, ce, methodName, argumentNames);
                    if (ifaceMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, ifaceMethod, arguments, ce, argumentNames);
                }
            }

            // Issue #1052 (was Phase 4.2b / ADR-0020 sealed-only): dispatch
            // through a type parameter's user-declared interface constraint,
            // just as if the receiver were typed as the interface itself. The
            // constrained type parameter is threaded into the bound call so the
            // emitter produces a verifiable `constrained. !!T  callvirt` sequence
            // rather than a bare `callvirt` on the unboxed value.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpRecv && tpRecv.InterfaceConstraint != null)
            {
                var tpOverloads = TypeMemberModel.GetMethods(tpRecv.InterfaceConstraint, methodName, MemberQuery.Instance(MemberKinds.Method));
                if (tpOverloads.Length > 0)
                {
                    var tpIfaceMethod = overloads.SelectInstanceOverloadOrReport(tpOverloads, arguments, ce, methodName, argumentNames);
                    if (tpIfaceMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, tpIfaceMethod, arguments, ce, argumentNames, constrainedReceiverTypeParameter: tpRecv);
                }
            }

            // Issue #1056: dispatch through a type parameter's base-class
            // constraint, just as if the receiver were typed as the base class
            // itself (e.g. `x.Speak()` where `x : T` and `T : Animal`). The
            // constrained type parameter is threaded into the bound call so the
            // emitter produces a verifiable `constrained. !!T  callvirt
            // Animal::Speak()` sequence. The `constrained.` prefix is required
            // even though `T` is a reference type: a bare `callvirt` on the
            // unboxed `!!T` value is rejected by the verifier (StackUnexpected),
            // because the static stack type is `!!T`, not the base class. Unlike
            // the interface paths the method token is the class's own MethodDef
            // (resolved by EmitUserInstanceCall when the constraint type is not
            // an interface), so no interface MemberRef is produced.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpClassRecv
                && tpClassRecv.ClassConstraint is StructSymbol tpClassConstraint)
            {
                var tpClassOverloads = TypeMemberModel.GetMethods(tpClassConstraint, methodName, MemberQuery.Instance(MemberKinds.Method));
                if (tpClassOverloads.Length > 0)
                {
                    var tpClassMethod = overloads.SelectInstanceOverloadOrReport(tpClassOverloads, arguments, ce, methodName, argumentNames);
                    if (tpClassMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, tpClassMethod, arguments, ce, argumentNames, constrainedReceiverTypeParameter: tpClassRecv);
                }
            }

            // Issue #943: dispatch through a type parameter's *imported CLR*
            // interface constraint (generic or not), e.g. `a.CompareTo(b)` where
            // `a : T` and `T : IComparable[T]`. Emitted as a verifiable
            // `constrained. !!T  callvirt IComparable`1<!!T>::CompareTo(!0)`.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpClrRecv
                && tpClrRecv.ClrInterfaceConstraint != null
                && TryBindConstrainedClrInterfaceCall(receiver, tpClrRecv, methodName, arguments, ce, argumentNames, out var constrainedCall))
            {
                return constrainedCall;
            }

            // Phase 3.B.3 sub-step 2b: dispatch to a user-defined class method
            // if receiver is a user struct symbol.
            if (receiver != null && receiver.Type is StructSymbol userClass)
            {
                var userOverloads = TypeMemberModel.GetMethods(userClass, methodName, MemberQuery.Instance(MemberKinds.Method));
                if (userOverloads.Length > 0)
                {
                    var userMethod = overloads.SelectInstanceOverloadOrReport(userOverloads, arguments, ce, methodName, argumentNames);
                    if (userMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    return overloads.BindUserInstanceCall(receiver, userMethod, arguments, ce, argumentNames);
                }

                // ADR-0085 / issue #726: a class that does not override an
                // inherited default interface method can still be called by
                // the unqualified method name on a class-typed receiver. The
                // binder routes the call to the interface's default method;
                // the evaluator and emitter both rely on virtual dispatch
                // through the interface slot to land on any subsequent
                // override.
                var defaultIfaceMethod = TryFindDefaultInterfaceMethod(userClass, methodName, arguments, ce, argumentNames);
                if (defaultIfaceMethod != null)
                {
                    return overloads.BindUserInstanceCall(receiver, defaultIfaceMethod, arguments, ce, argumentNames);
                }

                // Issue #527: fall back to a delegate/function-typed field on
                // the user struct/class. This is the same delegate-as-callable
                // dispatch used for the imported-CLR path below; here the
                // receiver's ClrType is null (the user type has not yet been
                // emitted) so we have to handle the symbol-only shape too.
                if (TryBindUserStructDelegateFieldInvocation(receiver, userClass, methodName, arguments, ce, out var userDelegateFieldCall))
                {
                    return userDelegateFieldCall;
                }
            }

            // Phase 3.B.6 / ADR-0019: extension function fallback for
            // user-type receivers (struct/class/interface). Issue #1188:
            // extension functions overload, so select the best matching
            // overload across all (receiver, name) candidates.
            if (TryBindExtensionFunctionOverload(receiver, methodName, arguments, ce, argumentNames, out var userExtResult))
            {
                return userExtResult;
            }

            // Issue #296: a GSharp class inheriting an imported CLR base class
            // exposes the base's instance members. After user-defined and
            // extension lookups fail, resolve the call against the imported
            // base CLR type so inherited members are callable on the derived
            // GSharp instance. Inherited instance members take precedence over
            // imported extension methods.
            // Issue #1136: when the user class/struct declares no explicit
            // imported base, every .NET type still inherits System.Object's
            // instance members (GetType/ToString/GetHashCode/Equals). Fall back
            // to typeof(object) so those resolve. TryBindInheritedClrInstanceCall
            // returns false for any name Object does not define, so unknown
            // methods still report GS0159 below.
            if (receiver != null && receiver.Type is StructSymbol inheritedDerived
                && (inheritedDerived.ImportedBaseType?.ClrType ?? typeof(object)) is System.Type inheritedBaseClr
                && TryBindInheritedClrInstanceCall(receiver, inheritedBaseClr, methodName, arguments, ce, out var inheritedCall, explicitTypeArgs, typeArgSymbols, argumentNames))
            {
                return inheritedCall;
            }

            // Issue #1218: an enum value is a CLR value type whose base chain is
            // System.Enum -> System.ValueType -> System.Object. Its inherited
            // instance members (Enum.HasFlag, Object/ValueType ToString /
            // GetHashCode / Equals, Object.GetType) are callable on enum values.
            // Resolve against typeof(System.Enum); SafeGetMethods walks the base
            // types so all inherited members are found, and the helper returns
            // false for any name Enum/Object does not define (still GS0159).
            if (receiver != null && receiver.Type is EnumSymbol
                && TryBindInheritedClrInstanceCall(receiver, typeof(System.Enum), methodName, arguments, ce, out var enumInheritedCall, explicitTypeArgs, typeArgSymbols, argumentNames, mapEnumArgumentsToBaseClr: true))
            {
                return enumInheritedCall;
            }

            // Issue #294: imported [Extension] method dispatched with instance
            // (receiver) syntax, when the receiver carries a CLR type even
            // though its symbol is a user/interface shape.
            if (receiver != null && TryBindImportedExtensionCall(receiver, methodName, arguments, ce, out var userPathExt, explicitTypeArgs, typeArgSymbols, argumentNames))
            {
                return userPathExt;
            }

            // Issue #1181: a user interface that extends an imported/BCL
            // interface (e.g. `interface IBox : IDisposable`) inherits that
            // interface's members. After user-declared interface members and
            // extension lookups fail, resolve the call against the transitive
            // imported base interfaces so `b.Dispose()` (b : IBox) binds and
            // emits a verifiable `callvirt IDisposable::Dispose`.
            if (receiver != null && receiver.Type is InterfaceSymbol importedBaseIfaceRecv
                && TryBindInterfaceImportedBaseInstanceCall(receiver, importedBaseIfaceRecv, methodName, arguments, ce, out var importedBaseIfaceCall, explicitTypeArgs, typeArgSymbols, argumentNames))
            {
                return importedBaseIfaceCall;
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        // Prefer a user-defined class method when the receiver is a user
        // class symbol that has one with this name. (BCL lookup is the
        // fallback for imported CLR types.)
        if (receiver.Type is StructSymbol userClassPriority)
        {
            var priorityOverloads = TypeMemberModel.GetMethods(userClassPriority, methodName, MemberQuery.Instance(MemberKinds.Method));
            if (priorityOverloads.Length > 0)
            {
                var userMethodPriority = overloads.SelectInstanceOverloadOrReport(priorityOverloads, arguments, ce, methodName, argumentNames);
                if (userMethodPriority == null)
                {
                    return new BoundErrorExpression(null);
                }

                return overloads.BindUserInstanceCall(receiver, userMethodPriority, arguments, ce, argumentNames);
            }

            // ADR-0085 / issue #726: default-interface-method fallback —
            // same as the primary branch above.
            var defaultIfaceMethodPriority = TryFindDefaultInterfaceMethod(userClassPriority, methodName, arguments, ce, argumentNames);
            if (defaultIfaceMethodPriority != null)
            {
                return overloads.BindUserInstanceCall(receiver, defaultIfaceMethodPriority, arguments, ce, argumentNames);
            }

            // Issue #527: a G#-defined struct/class field whose type is a
            // function (or named delegate) is invokable through the same
            // call syntax as a bare function-typed variable. Lower to a load
            // of the field value followed by an indirect call. Field lookup
            // walks the inheritance chain (a class can inherit a delegate
            // field from a base class).
            if (TryBindUserStructDelegateFieldInvocation(receiver, userClassPriority, methodName, arguments, ce, out var userDelegateCall))
            {
                return userDelegateCall;
            }
        }

        // Issue #517: a value-type `T?` lowers to `System.Nullable<T>` at the
        // CLR layer; `receiver.Type.ClrType` returns the underlying T's CLR
        // type (so the binder can share lifting/conversion logic), but
        // instance-method lookup (e.g. `GetValueOrDefault`, `Equals`,
        // `ToString`) must go through the constructed `Nullable<T>` type that
        // actually carries those members.
        var clrType = receiver.Type is NullableTypeSymbol nullableRecv
            && nullableRecv.UnderlyingType?.ClrType is { IsValueType: true } nullableInnerVt
            && this.memberLookup.TryGetNullableConstructedType(nullableInnerVt, out var nullableConstructed)
            ? nullableConstructed
            : effectiveReceiverType.ClrType;

        // Issue #529: use interface-aware method enumeration so that
        // methods declared on a base interface (e.g.
        // IEnumerable<T>.GetEnumerator() surfaced through
        // IReadOnlyList<T>) are found.
        var candidates = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(clrType, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
            .Where(m => m.Name == methodName)
            .ToList();

        if (candidates.Count > 0)
        {
            var argTypes = new System.Type[arguments.Length];
            var argsAllTyped = true;
            var hasUserClassArg = false;
            for (var i = 0; i < arguments.Length; i++)
            {
                // Issue #977: an inline `out var`/`out let`/`out _` argument was
                // bound to a placeholder address-of (Error pointee) in the eager
                // pass because the parameter type was unknown. Feed a sentinel so
                // overload resolution treats it as matching any by-ref parameter;
                // the local's type is inferred from the chosen overload below.
                if (TryGetInlineOutVarArgument(ce, i, out _))
                {
                    argTypes[i] = OverloadResolution.InlineOutVarArgumentType;
                    continue;
                }

                // Issue #530: use GetEffectiveArgumentClrType so that a
                // nullable value type argument (e.g. `int32?`) is matched
                // as `Nullable<T>` in overload resolution.
                // Issue #533: allow null (nil literal) through.
                // Issue #658: use overload-resolution variant for user classes.
                var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
                if (t == null && arguments[i].Type != TypeSymbol.Null)
                {
                    argsAllTyped = false;
                    break;
                }

                if (arguments[i].Type is StructSymbol { IsClass: true })
                {
                    hasUserClassArg = true;
                }

                argTypes[i] = t;
            }

            if (argsAllTyped)
            {
                // Issue #658: set up supplementary interface check for user-class args.
                if (hasUserClassArg)
                {
                    OverloadResolution.SupplementaryInterfaceCheck = (source, target) =>
                        IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target);
                }

                try
                {
                    OverloadResolution.ConstantNarrowingArgumentCheck = MakeConstantNarrowingArgumentCheck(arguments);
                    var resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences, ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length), argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
                    switch (resolution.Outcome)
                    {
                        case OverloadResolution.ResolutionOutcome.Resolved:
                            // Issue #977: now that the overload is chosen, re-bind
                            // any inline `out var`/`out let`/`out _` placeholders
                            // against the resolved by-ref parameter so the new
                            // local is declared with the inferred pointee type.
                            arguments = RebindInlineOutVarArguments(ce, arguments, resolution.Best, resolution.ParameterMapping, receiver?.Type);
                            var instSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(effectiveReceiverType, ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
                            var instSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(resolution.Best, typeArgSymbols, instSymbolicArgs);
                            var instTypeArgSymbolsForCall = !instSymbolicTypeArgs.IsDefault ? instSymbolicTypeArgs : typeArgSymbols;
                            var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols)
                                ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(resolution.Best, instSymbolicTypeArgs, effectiveReceiverType)
                                ?? ResolveInstanceReturnTypeFromReceiver(effectiveReceiverType, resolution.Best)
                                ?? MapClrMemberType(resolution.Best.ReturnType);
                            var instParameters = resolution.Best.GetParameters();
                            var instMapping = resolution.ParameterMapping;
                            var instExpandedArgs = resolution.IsExpanded
                                ? overloads.ExpandParamsArguments(arguments, instParameters, ce, parameterMapping: instMapping)
                                : arguments;
                            var instDownstreamMapping = resolution.IsExpanded ? default : instMapping;
                            var instRebound = RebindFormattableInterpolationArguments(instExpandedArgs, ce.Arguments, instParameters, instDownstreamMapping);
                            var instHandlerArgs = ApplyInterpolatedStringHandlers(instParameters, instRebound, receiver, ce.Location, instDownstreamMapping, out var instHandlerPrelude, out var instUpdatedReceiver);
                            var instDelegateArgs = RebindFunctionLiteralDelegateArguments(instHandlerArgs, instParameters, instDownstreamMapping);
                            var instConvertedArgs = conversions.BindClrParameterConversions(instDelegateArgs, instParameters, ce, instDownstreamMapping, method: resolution.Best, receiverType: receiver?.Type);
                            var instArguments = OverloadResolver.BuildOrderedCallArguments(instConvertedArgs, instDownstreamMapping, instParameters);
                            var instRefKinds = ComputeArgumentRefKinds(instParameters);
                            overloads.ValidateRefArguments(instArguments, instRefKinds, methodName, ce.Location);
                            BoundExpression instCall = ConversionClassifier.AutoDereferenceRefReturn(new BoundImportedInstanceCallExpression(null, instUpdatedReceiver ?? receiver, resolution.Best, returnType, instArguments, instRefKinds, instTypeArgSymbolsForCall));
                            return WrapWithHandlerPrelude(instCall, instHandlerPrelude, ce);
                        case OverloadResolution.ResolutionOutcome.Ambiguous:
                            Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                            return new BoundErrorExpression(null);
                        default:
                            break;
                    }
                }
                finally
                {
                    if (hasUserClassArg)
                    {
                        OverloadResolution.SupplementaryInterfaceCheck = null;
                    }

                    OverloadResolution.ConstantNarrowingArgumentCheck = null;
                }
            }
        }

        // Issue #527: a public field or property whose type is a CLR delegate
        // (e.g. `public Func<string> OnAsk;`) is invokable through the same
        // call syntax used on the variable itself — `bag.OnAsk()`. Method
        // lookup above only consulted methods named `OnAsk`, so the delegate
        // member would otherwise miss. Lower to a load of the delegate value
        // followed by an `Invoke(args)` dispatch (mirrors the bare-delegate
        // call path in BindCallExpression at #325). This must come before the
        // extension-function fallbacks so an in-scope extension method does
        // not shadow a real delegate-typed member on the type.
        if (receiver != null
            && TryBindClrDelegateMemberInvocation(receiver, clrType, methodName, arguments, ce, argumentNames, out var delegateMemberCall))
        {
            return delegateMemberCall;
        }

        // Phase 3.B.6 / ADR-0019: extension function fallback. After all
        // instance/static lookups fail, try matching by (receiverType, name).
        // Issue #1188: extension functions overload, so select the best
        // matching overload across all (receiver, name) candidates.
        if (TryBindExtensionFunctionOverload(receiver, methodName, arguments, ce, argumentNames, out var extResult))
        {
            return extResult;
        }

        // Issue #294: BCL/library [Extension] method dispatched with instance
        // (receiver) syntax. After instance members and user extension
        // functions fail, fall back to imported static [Extension] methods
        // whose first parameter is compatible with the receiver type.
        if (receiver != null && TryBindImportedExtensionCall(receiver, methodName, arguments, ce, out var importedExt, explicitTypeArgs, typeArgSymbols, argumentNames))
        {
            return importedExt;
        }

        // Issue #343: if all CLR-instance lookups missed and the call uses
        // named arguments, point at the first unknown parameter name (if any)
        // for a more actionable diagnostic than "unable to find function".
        if (!argumentNames.IsDefault && receiver?.Type?.ClrType is System.Type recvClr
            && overloads.TryReportUnknownNamedArgumentForClr(recvClr, methodName, BindingFlags.Instance | BindingFlags.Public, ce, argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        return new BoundErrorExpression(null);
    }

    /// <summary>
    /// Issue #1188: resolves an instance-syntax call <c>receiver.Method(args)</c>
    /// against the user-defined extension functions visible from the current
    /// scope, supporting overloading. Collects every extension overload matching
    /// the (receiver type, name) pair and selects the single best applicable one
    /// through the standard overload-resolution machinery before delegating to
    /// <see cref="OverloadResolver.BindExtensionFunctionCall"/>.
    /// </summary>
    /// <remarks>
    /// Extension function symbols carry their receiver in <c>Parameters[0]</c> and
    /// never set <see cref="FunctionSymbol.ExplicitReceiverParameter"/>, so user
    /// arguments line up against <c>Parameters[1..]</c>. To reuse the existing
    /// instance-overload selector (which keys parameter alignment off
    /// <c>ExplicitReceiverParameter</c>) the receiver is prepended as the first
    /// positional argument; this makes the candidate's synthetic receiver slot
    /// participate in applicability/convertibility ranking and in generic receiver
    /// inference exactly as <see cref="OverloadResolver.BindExtensionFunctionCall"/>
    /// does once a candidate is chosen.
    /// </remarks>
    /// <param name="receiver">The bound call receiver.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound user arguments (excluding the receiver).</param>
    /// <param name="ce">The originating call syntax.</param>
    /// <param name="argumentNames">The named-argument layout, or default.</param>
    /// <param name="result">The bound call, when an extension overload matched.</param>
    /// <returns><see langword="true"/> when at least one extension overload matched the (receiver, name) pair.</returns>
    private bool TryBindExtensionFunctionOverload(
        BoundExpression receiver,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;
        if (receiver == null)
        {
            return false;
        }

        var candidates = scope.TryLookupExtensionFunctions(receiver.Type, methodName);
        if (candidates.IsDefaultOrEmpty)
        {
            return false;
        }

        var selected = candidates[0];
        if (candidates.Length > 1)
        {
            var allArguments = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length + 1);
            allArguments.Add(receiver);
            allArguments.AddRange(arguments);

            var allNames = argumentNames;
            if (!argumentNames.IsDefault)
            {
                var namesBuilder = ImmutableArray.CreateBuilder<string>(argumentNames.Length + 1);
                namesBuilder.Add(null);
                namesBuilder.AddRange(argumentNames);
                allNames = namesBuilder.ToImmutable();
            }

            selected = overloads.SelectInstanceOverloadOrReport(candidates, allArguments.ToImmutable(), ce, methodName, allNames);
            if (selected == null)
            {
                result = new BoundErrorExpression(null);
                return true;
            }
        }

        result = overloads.BindExtensionFunctionCall(receiver, selected, arguments, ce, argumentNames);
        return true;
    }

    /// <summary>
    /// Issue #527 (G#-defined struct/class arm): when a member-style call
    /// <c>receiver.Member(args)</c> does not match a method on the user
    /// struct/class, fall back to a field whose type is a function value or
    /// named delegate. Lowers to a load of the field followed by a
    /// <see cref="BoundIndirectCallExpression"/> through the function shape.
    /// Returns <see langword="true"/> when a callable field matched (the
    /// resulting expression may be a <see cref="BoundErrorExpression"/> if
    /// arity is wrong).
    /// </summary>
    /// <summary>
    /// ADR-0085 / issue #726: when a class-typed receiver does not have a
    /// matching instance method, look at the class's implemented interfaces
    /// (including bases) for a default-method (DIM) whose signature accepts
    /// the supplied arguments. Returns the selected interface method or
    /// <c>null</c> if there is no suitable candidate. Diamond conflicts are
    /// reported by <c>VerifyInterfaceImplementations</c>; this helper picks
    /// the first matching candidate so that diagnostics are not duplicated
    /// at every call site.
    /// </summary>
    /// <summary>
    /// ADR-0090 / issue #756: returns <c>true</c> when the current function
    /// being bound (the enclosing default-method body) belongs to the same
    /// interface declaration as <paramref name="ifaceDef"/>. Used at call
    /// sites that resolve through an interface receiver to decide whether
    /// the private-helper bucket is in scope.
    /// </summary>
    /// <param name="ifaceDef">The interface generic definition (callers
    /// pass <c>InterfaceSymbol.Definition</c>) being targeted.</param>
    /// <returns>True when the enclosing function's owning interface is the
    /// same definition.</returns>
    private bool IsInsideSameInterface(InterfaceSymbol ifaceDef)
    {
        var current = function;
        if (current == null || ifaceDef == null)
        {
            return false;
        }

        InterfaceSymbol ownerIface = null;
        if (current.ReceiverType is InterfaceSymbol ri)
        {
            ownerIface = ri;
        }
        else if (current.StaticOwnerType is InterfaceSymbol si)
        {
            ownerIface = si;
        }

        if (ownerIface == null)
        {
            return false;
        }

        var ownerDef = ownerIface.Definition ?? ownerIface;
        return ReferenceEquals(ownerDef, ifaceDef);
    }

    private FunctionSymbol TryFindDefaultInterfaceMethod(
        StructSymbol receiverClass,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames)
    {
        for (var c = receiverClass; c != null; c = c.BaseClass)
        {
            foreach (var iface in c.Interfaces)
            {
                if (iface == null)
                {
                    continue;
                }

                var candidates = TypeMemberModel.GetMethods(iface, methodName, MemberQuery.Instance(MemberKinds.Method));
                var defaultsOnly = ImmutableArray.CreateBuilder<FunctionSymbol>();
                for (var i = 0; i < candidates.Length; i++)
                {
                    if (InterfaceSymbol.HasDefaultBody(candidates[i]))
                    {
                        defaultsOnly.Add(candidates[i]);
                    }
                }

                if (defaultsOnly.Count == 0)
                {
                    continue;
                }

                var selected = this.overloads.SelectInstanceOverloadOrReport(defaultsOnly.ToImmutable(), arguments, ce, methodName, argumentNames);
                if (selected != null)
                {
                    return selected;
                }
            }
        }

        return null;
    }
}
