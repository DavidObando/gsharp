// <copyright file="ExpressionBinder.Calls.Delegates.cs" company="GSharp">
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
    /// Issue #891: binds a single call argument, target-typing arrow/func
    /// literals against the matching delegate-typed parameter discovered from
    /// the candidate (constructor or method) parameter lists. This lets an
    /// arrow lambda — including a statement body that only throws — be bound
    /// directly as the corresponding delegate (Func/Action) instead of
    /// inferring a standalone (often void) function type that fails overload
    /// resolution and misroutes the call.
    /// </summary>
    private BoundExpression BindCallArgumentWithDelegateTargetTyping(
        ExpressionSyntax argumentSyntax,
        IReadOnlyList<ParameterInfo[]> candidateParameterLists,
        int sourceArgIndex,
        string argName,
        int paramOffset)
    {
        var inner = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax);
        if (inner is LambdaExpressionSyntax lambdaSyntax
            && TryResolveDelegateTargetFromCandidates(candidateParameterLists, paramOffset, sourceArgIndex, argName, out var target))
        {
            return lambdas.BindLambdaExpression(lambdaSyntax, target);
        }

        return BindExpression(inner);
    }

    /// <summary>
    /// Issue #891: discovers the (non-generic) delegate function type that a
    /// given argument position maps to across all candidate parameter lists.
    /// Named arguments are matched by parameter name; positional arguments by
    /// index (after <paramref name="paramOffset"/>, e.g. an extension method's
    /// receiver). Returns false when no candidate exposes a closed delegate
    /// parameter there, or when candidates disagree on the delegate shape.
    /// </summary>
    private static bool TryResolveDelegateTargetFromCandidates(
        IReadOnlyList<ParameterInfo[]> candidateParameterLists,
        int paramOffset,
        int sourceArgIndex,
        string argName,
        out FunctionTypeSymbol target)
    {
        target = null;
        foreach (var parameters in candidateParameterLists)
        {
            int paramIndex;
            if (!string.IsNullOrEmpty(argName))
            {
                paramIndex = -1;
                for (var p = 0; p < parameters.Length; p++)
                {
                    if (string.Equals(parameters[p].Name, argName, StringComparison.Ordinal))
                    {
                        paramIndex = p;
                        break;
                    }
                }

                if (paramIndex < 0)
                {
                    continue;
                }
            }
            else
            {
                paramIndex = sourceArgIndex + paramOffset;
                if (paramIndex < 0 || paramIndex >= parameters.Length)
                {
                    continue;
                }
            }

            var parameterType = parameters[paramIndex].ParameterType;
            if (parameterType == null || parameterType.ContainsGenericParameters)
            {
                // Open generic delegate parameters are resolved later, once the
                // generic method's type arguments have been inferred.
                continue;
            }

            if (!MemberLookup.TryGetDelegateFunctionType(parameterType, out var candidate) || candidate == null)
            {
                continue;
            }

            if (target == null)
            {
                target = candidate;
            }
            else if (!ReferenceEquals(target, candidate) && !target.Equals(candidate))
            {
                // Candidates disagree on the delegate shape — leave the lambda
                // to be bound without a target (overload resolution decides).
                target = null;
                return false;
            }
        }

        return target != null;
    }

    /// <summary>
    /// Issue #891: determines whether the supplied expression is an arrow
    /// lambda with at least one parameter whose type is omitted, so its
    /// parameter type(s) must be inferred from a target delegate.
    /// </summary>
    private static bool IsUntypedArrowLambda(ExpressionSyntax inner)
    {
        if (inner is not LambdaExpressionSyntax lambda)
        {
            return false;
        }

        for (var i = 0; i < lambda.Parameters.Count; i++)
        {
            if (lambda.Parameters[i].Type == null)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #908: collects the parameter lists of the CLR methods a member-style
    /// call could resolve to — static methods of the accessed class, or instance
    /// methods on the receiver plus imported extension methods — so an arrow
    /// lambda argument can be target-typed from its matching delegate parameter
    /// before binding. Extension-method parameter lists have their leading
    /// <c>this</c> receiver parameter stripped so every returned list aligns at a
    /// zero parameter offset, matching the positional argument indices.
    /// </summary>
    private List<ParameterInfo[]> CollectDelegateTargetCandidateParameterLists(
        BoundExpression receiver,
        ImportedClassSymbol classSymbol,
        string methodName)
    {
        var result = new List<ParameterInfo[]>();
        if (classSymbol != null)
        {
            foreach (var m in ClrTypeUtilities.SafeGetMethods(classSymbol.ClassType, BindingFlags.Static | BindingFlags.Public)
                .Where(m => m.Name == methodName))
            {
                result.Add(m.GetParameters());
            }

            return result;
        }

        if (receiver?.Type?.ClrType is System.Type receiverClrType)
        {
            foreach (var m in ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(receiverClrType, BindingFlags.Instance | BindingFlags.Public)
                .Where(m => m.Name == methodName))
            {
                result.Add(m.GetParameters());
            }
        }

        foreach (var ext in this.memberLookup.CollectImportedExtensionMethods(methodName))
        {
            var extParams = ext.GetParameters();
            if (extParams.Length == 0)
            {
                continue;
            }

            // Strip the leading `this` receiver parameter so positional indices
            // line up with the call's explicit arguments (offset 0).
            var stripped = new ParameterInfo[extParams.Length - 1];
            System.Array.Copy(extParams, 1, stripped, 0, stripped.Length);
            result.Add(stripped);
        }

        return result;
    }

    /// <summary>
    /// Issue #891: infers the target delegate type for each deferred un-typed
    /// arrow lambda argument of a member-style call by probing the applicable
    /// candidate methods — instance methods on the receiver, imported
    /// extension methods (LINQ et al.), or static methods of the accessed
    /// class — with the lambda slots treated as unconstrained. Once the
    /// (possibly generic) overload is resolved and its type arguments inferred,
    /// the corresponding closed delegate parameter type target-types the lambda,
    /// which is then bound in place inside <paramref name="boundArgs"/>.
    /// </summary>
    /// <summary>
    /// Issue #951: resolves deferred un-typed arrow-lambda arguments of a
    /// member-style call whose receiver is a <em>user-declared</em>
    /// class/struct/interface (no CLR type to reflect over). For each still-
    /// deferred lambda index, the matching parameter symbol of the candidate
    /// user method(s) supplies the target delegate shape, which target-types
    /// the lambda exactly like the CLR reflection path. When no candidate
    /// exposes a delegate-typed parameter at that position — or candidates
    /// disagree on the shape — the lambda is left deferred so the caller's
    /// fallback binds it without a target (surfacing GS0304).
    /// </summary>
    /// <param name="receiver">The bound receiver of the member call.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="ce">The call syntax (used for the argument syntax nodes).</param>
    /// <param name="deferredIndices">The argument indices still awaiting a target.</param>
    /// <param name="boundArgs">The in-progress bound-argument array, mutated in place.</param>
    private void ResolveDeferredArrowLambdaArgumentsFromUserMethods(
        BoundExpression receiver,
        string methodName,
        CallExpressionSyntax ce,
        List<int> deferredIndices,
        BoundExpression[] boundArgs)
    {
        if (deferredIndices.Count == 0 || receiver?.Type == null)
        {
            return;
        }

        ImmutableArray<FunctionSymbol> candidates;
        switch (receiver.Type)
        {
            case StructSymbol structRecv:
                candidates = TypeMemberModel.GetMethods(structRecv, methodName, MemberQuery.Instance(MemberKinds.Method));
                break;
            case InterfaceSymbol ifaceRecv:
                candidates = TypeMemberModel.GetMethods(ifaceRecv, methodName, MemberQuery.Instance(MemberKinds.Method));
                break;
            case TypeParameterSymbol { InterfaceConstraint: { } constraint }:
                candidates = TypeMemberModel.GetMethods(constraint, methodName, MemberQuery.Instance(MemberKinds.Method));
                break;
            default:
                return;
        }

        if (candidates.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var idx in deferredIndices.ToArray())
        {
            if (boundArgs[idx] is not BoundErrorExpression { Syntax: LambdaExpressionSyntax lambdaSyntax })
            {
                continue;
            }

            FunctionTypeSymbol target = null;
            var disagree = false;
            foreach (var candidate in candidates)
            {
                var offset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
                var paramPos = idx + offset;
                if (paramPos < 0 || paramPos >= candidate.Parameters.Length)
                {
                    continue;
                }

                if (!MemberLookup.TryGetDelegateFunctionTypeFromSymbol(candidate.Parameters[paramPos].Type, out var fn) || fn == null)
                {
                    continue;
                }

                if (target == null)
                {
                    target = fn;
                }
                else if (!ReferenceEquals(target, fn) && !target.Equals(fn))
                {
                    disagree = true;
                    break;
                }
            }

            if (target != null && !disagree)
            {
                boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, target);
                deferredIndices.Remove(idx);
            }
        }
    }

    private void ResolveDeferredArrowLambdaArguments(
        BoundExpression receiver,
        ImportedClassSymbol classSymbol,
        string methodName,
        CallExpressionSyntax ce,
        System.Type[] explicitTypeArgs,
        List<int> deferredIndices,
        BoundExpression[] boundArgs)
    {
        var probes = new List<(IReadOnlyList<MethodInfo> Methods, int Offset)>();
        if (classSymbol != null)
        {
            var statics = ClrTypeUtilities.SafeGetMethods(classSymbol.ClassType, BindingFlags.Static | BindingFlags.Public)
                .Where(m => m.Name == methodName)
                .ToList();
            if (statics.Count > 0)
            {
                probes.Add((statics, 0));
            }
        }
        else if (receiver?.Type?.ClrType is System.Type receiverClrType)
        {
            var instance = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(receiverClrType, BindingFlags.Instance | BindingFlags.Public)
                .Where(m => m.Name == methodName)
                .ToList();
            if (instance.Count > 0)
            {
                probes.Add((instance, 0));
            }

            var extensions = this.memberLookup.CollectImportedExtensionMethods(methodName);
            if (extensions.Count > 0)
            {
                probes.Add((extensions, 1));
            }
        }

        if (probes.Count == 0)
        {
            return;
        }

        var deferred = new HashSet<int>(deferredIndices);

        // Issue #903: when the receiver carries a same-compilation user element
        // type (e.g. `List[Check]` where `Check` is a struct/class still being
        // compiled), that element type is erased to `object` at the CLR layer.
        // The reflection-driven inference paths below would therefore bind the
        // lambda parameter as `object` and fail member access in the body
        // (`c.Id` → GS0158). Try a symbol-based inference first that recovers
        // the real element type from the receiver's symbolic `TypeArguments`,
        // builds a `FunctionTypeSymbol` target carrying that type, and binds the
        // lambda against it. This path only succeeds (and pre-empts the CLR
        // paths) when it actually recovers a same-compilation user type, so the
        // referenced-element-type and primitive cases are untouched.
        foreach (var (methods, offset) in probes)
        {
            if (TryMapDeferredLambdaTargetsSymbolic(methods, offset, receiver, ce, deferredIndices, boundArgs, deferred, out var symbolicTargets))
            {
                foreach (var idx in deferredIndices)
                {
                    var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
                    if (inner is LambdaExpressionSyntax lambdaSyntax && symbolicTargets.TryGetValue(idx, out var target))
                    {
                        boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, target, inferReturnTypeFromBody: true);
                    }
                }

                return;
            }
        }

        foreach (var (methods, offset) in probes)
        {
            var argTypes = new System.Type[boundArgs.Length + offset];
            if (offset == 1)
            {
                argTypes[0] = receiver.Type.ClrType;
            }

            var usable = true;
            for (var i = 0; i < boundArgs.Length; i++)
            {
                if (deferred.Contains(i))
                {
                    // An unconstrained lambda slot: null is skipped by generic
                    // inference and treated as reference-convertible to the
                    // delegate parameter, so the candidate still applies.
                    argTypes[i + offset] = null;
                    continue;
                }

                var t = GetEffectiveArgumentClrTypeForOverloadResolution(boundArgs[i].Type);
                if (t == null && boundArgs[i].Type != TypeSymbol.Null)
                {
                    usable = false;
                    break;
                }

                argTypes[i + offset] = t;
            }

            if (!usable)
            {
                continue;
            }

            var resolution = OverloadResolution.Resolve(methods, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences);
            if (resolution.Outcome != OverloadResolution.ResolutionOutcome.Resolved)
            {
                continue;
            }

            var parameters = resolution.Best.GetParameters();
            var targets = new Dictionary<int, FunctionTypeSymbol>();
            var allMapped = true;
            foreach (var idx in deferredIndices)
            {
                var paramIndex = idx + offset;
                if (paramIndex >= parameters.Length)
                {
                    allMapped = false;
                    break;
                }

                var parameterType = parameters[paramIndex].ParameterType;
                if (parameterType == null
                    || parameterType.ContainsGenericParameters
                    || !MemberLookup.TryGetDelegateFunctionType(parameterType, out var fn)
                    || fn == null)
                {
                    allMapped = false;
                    break;
                }

                targets[idx] = fn;
            }

            if (!allMapped)
            {
                continue;
            }

            foreach (var idx in deferredIndices)
            {
                var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
                if (inner is LambdaExpressionSyntax lambdaSyntax)
                {
                    boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, targets[idx]);
                }
            }

            return;
        }

        // Follow-up to issue #891: the full-inference path above could not
        // map every deferred lambda — typically because the matching generic
        // method's lambda RETURN type is a method type parameter that is only
        // inferable from the lambda body (e.g.
        // Select<TSource,TResult>(IEnumerable<TSource>, Func<TSource,TResult>)).
        // Fall back to partial inference: infer the type parameters reachable
        // from the non-lambda arguments (so the lambda's *parameter* types close)
        // and bind each lambda against a target carrying only those parameter
        // types, leaving its return type to be inferred from the body.
        foreach (var (methods, offset) in probes)
        {
            if (TryMapDeferredLambdaParameterTargets(methods, offset, receiver, ce, deferredIndices, boundArgs, out var partialTargets))
            {
                foreach (var idx in deferredIndices)
                {
                    var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
                    if (inner is LambdaExpressionSyntax lambdaSyntax && partialTargets.TryGetValue(idx, out var target))
                    {
                        boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, target, inferReturnTypeFromBody: true);
                    }
                }

                return;
            }
        }
    }

    /// <summary>
    /// Follow-up to issue #891: partial-inference fallback for <see cref="ResolveDeferredArrowLambdaArguments"/>.
    /// For each candidate generic method, infers the type parameters reachable
    /// from the non-lambda argument CLR types and resolves the closed parameter
    /// types of every deferred lambda's delegate (arity-matched to the lambda),
    /// even when the delegate's return type remains an un-inferred method type
    /// parameter. Builds a per-slot <see cref="FunctionTypeSymbol"/> target that
    /// carries only the closed parameter types. Candidates must agree on the
    /// resulting parameter types; otherwise the fallback declines (preserving the
    /// existing GS0304 behaviour) to avoid binding against an ambiguous shape.
    /// </summary>
    private bool TryMapDeferredLambdaParameterTargets(
        IReadOnlyList<MethodInfo> methods,
        int offset,
        BoundExpression receiver,
        CallExpressionSyntax ce,
        List<int> deferredIndices,
        BoundExpression[] boundArgs,
        out Dictionary<int, FunctionTypeSymbol> targets)
    {
        targets = null;

        var deferred = new HashSet<int>(deferredIndices);
        var argTypes = new System.Type[boundArgs.Length + offset];
        if (offset == 1)
        {
            if (receiver?.Type?.ClrType is not System.Type receiverClrType)
            {
                return false;
            }

            argTypes[0] = receiverClrType;
        }

        for (var i = 0; i < boundArgs.Length; i++)
        {
            if (deferred.Contains(i))
            {
                argTypes[i + offset] = null;
                continue;
            }

            var t = GetEffectiveArgumentClrTypeForOverloadResolution(boundArgs[i].Type);
            if (t == null && boundArgs[i].Type != TypeSymbol.Null)
            {
                return false;
            }

            argTypes[i + offset] = t;
        }

        var lambdaParamIndices = new List<int>();
        var arities = new List<int>();
        var argIndexByParamIndex = new Dictionary<int, int>();
        foreach (var idx in deferredIndices)
        {
            var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
            if (inner is not LambdaExpressionSyntax lambda)
            {
                return false;
            }

            var paramIndex = idx + offset;
            lambdaParamIndices.Add(paramIndex);
            arities.Add(lambda.Parameters.Count);
            argIndexByParamIndex[paramIndex] = idx;
        }

        Dictionary<int, System.Type[]> agreed = null;
        foreach (var method in methods)
        {
            if (method == null || (!method.IsGenericMethodDefinition && !method.IsGenericMethod))
            {
                continue;
            }

            if (!OverloadResolution.TryInferDeferredLambdaParameterTypes(method, argTypes, lambdaParamIndices, arities, out var closed))
            {
                continue;
            }

            if (agreed == null)
            {
                agreed = closed;
            }
            else if (!DeferredLambdaParameterTypesAgree(agreed, closed))
            {
                return false;
            }
        }

        if (agreed == null)
        {
            return false;
        }

        var built = new Dictionary<int, FunctionTypeSymbol>();
        foreach (var kv in agreed)
        {
            var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(kv.Value.Length);
            foreach (var clr in kv.Value)
            {
                var symbol = TypeSymbol.FromClrType(clr);
                if (symbol == null || symbol == TypeSymbol.Error)
                {
                    return false;
                }

                parameterTypes.Add(symbol);
            }

            // The return slot is a placeholder; binding passes
            // inferReturnTypeFromBody so the lambda infers its own return type.
            built[argIndexByParamIndex[kv.Key]] = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), default, TypeSymbol.Object);
        }

        targets = built;
        return true;
    }

    private static bool DeferredLambdaParameterTypesAgree(Dictionary<int, System.Type[]> a, Dictionary<int, System.Type[]> b)
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
                if (!ClrTypeUtilities.AreSame(kv.Value[i], other[i]))
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #903: symbol-based deferred arrow-lambda target inference. The
    /// CLR-driven <see cref="ResolveDeferredArrowLambdaArguments"/> paths infer
    /// the lambda's parameter type from the receiver's <em>CLR</em> type, which
    /// for a same-compilation generic element type (e.g. <c>List[Check]</c>
    /// where <c>Check</c> is being compiled) is erased to <c>List&lt;object&gt;</c>
    /// — so the lambda parameter would bind as <c>object</c> and member access
    /// in the body fails. This routine instead recovers the element type
    /// symbolically: it unifies the receiver/argument <see cref="TypeSymbol"/>s
    /// against each candidate generic method's open parameters (reusing
    /// <see cref="MemberLookup.InferSymbolicMethodTypeArguments"/>), then maps
    /// each deferred lambda's delegate <em>parameter</em> types through those
    /// inferred symbolic arguments (reusing
    /// <see cref="MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo, ImmutableArray{TypeSymbol})"/>).
    /// A per-slot <see cref="FunctionTypeSymbol"/> carrying those parameter
    /// types is produced (its return type is a placeholder — callers bind with
    /// <c>inferReturnTypeFromBody</c>). Candidates must agree on the recovered
    /// parameter types. The method succeeds <em>only</em> when at least one
    /// recovered parameter type is a same-compilation user type, so the
    /// referenced-element and primitive cases continue through the existing
    /// CLR paths unchanged.
    /// </summary>
    private bool TryMapDeferredLambdaTargetsSymbolic(
        IReadOnlyList<MethodInfo> methods,
        int offset,
        BoundExpression receiver,
        CallExpressionSyntax ce,
        List<int> deferredIndices,
        BoundExpression[] boundArgs,
        HashSet<int> deferred,
        out Dictionary<int, FunctionTypeSymbol> targets)
    {
        targets = null;

        // Symbolic recovery is anchored on the candidate's symbolic argument
        // vector: the receiver's symbolic TypeArguments for instance/extension
        // calls, or — for a static call (issue #932:
        // `Assert.DoesNotContain(items, i -> ...)`) — the same-compilation user
        // type carried by a non-deferred argument such as `items : List[Item]`.
        // An extension probe (offset == 1) places the receiver in slot 0, so it
        // genuinely needs a receiver; a static/instance probe (offset == 0) does
        // not. The success gate below (`anySameCompilationType`) still ensures
        // this path only fires — and pre-empts the CLR erasure paths — when a
        // real same-compilation user type is recovered.
        if (offset == 1 && receiver?.Type == null)
        {
            return false;
        }

        // Build the symbolic argument vector as the candidate method sees it:
        // for an extension probe (offset == 1) the receiver is slot 0 ("this"),
        // followed by the user arguments. Deferred lambda slots are left null so
        // unification skips them.
        var symbolicArgs = new TypeSymbol[boundArgs.Length + offset];
        if (offset == 1)
        {
            symbolicArgs[0] = receiver.Type;
        }

        for (var i = 0; i < boundArgs.Length; i++)
        {
            symbolicArgs[i + offset] = deferred.Contains(i) ? null : boundArgs[i]?.Type;
        }

        var symbolicArgVector = ImmutableArray.Create(symbolicArgs);

        // Record the expected delegate arity for each deferred lambda slot.
        var arityByIndex = new Dictionary<int, int>();
        foreach (var idx in deferredIndices)
        {
            var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
            if (inner is not LambdaExpressionSyntax lambda)
            {
                return false;
            }

            arityByIndex[idx] = lambda.Parameters.Count;
        }

        Dictionary<int, ImmutableArray<TypeSymbol>> agreed = null;
        var anySameCompilationType = false;

        foreach (var method in methods)
        {
            if (method == null || (!method.IsGenericMethodDefinition && !method.IsGenericMethod))
            {
                continue;
            }

            MethodInfo openMethod;
            ParameterInfo[] openParameters;
            try
            {
                openMethod = method.IsGenericMethodDefinition ? method : method.GetGenericMethodDefinition();
                if (!openMethod.IsGenericMethodDefinition)
                {
                    continue;
                }

                openParameters = openMethod.GetParameters();
            }
            catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
            {
                continue;
            }

            if (openParameters.Length < symbolicArgs.Length)
            {
                continue;
            }

            var inferred = MemberLookup.InferSymbolicMethodTypeArguments(openMethod, symbolicArgVector);
            var methodTypeArgs = ImmutableArray.Create(inferred);

            var slotTargets = new Dictionary<int, ImmutableArray<TypeSymbol>>();
            var candidateUsable = true;
            var candidateHasSameCompilationType = false;

            foreach (var idx in deferredIndices)
            {
                var paramIndex = idx + offset;
                if (paramIndex >= openParameters.Length)
                {
                    candidateUsable = false;
                    break;
                }

                MethodInfo invoke;
                ParameterInfo[] invokeParameters;
                try
                {
                    var delegateType = openParameters[paramIndex].ParameterType;
                    invoke = delegateType?.GetMethod("Invoke");
                    invokeParameters = invoke?.GetParameters();
                }
                catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
                {
                    candidateUsable = false;
                    break;
                }

                if (invoke == null || invokeParameters == null || invokeParameters.Length != arityByIndex[idx])
                {
                    candidateUsable = false;
                    break;
                }

                // Issue #903: only trust this candidate's delegate parameter
                // shape when every method type parameter reachable from it was
                // actually resolved by unifying the receiver/arguments. When a
                // candidate's "this" parameter does not match the receiver
                // shape (e.g. a `Single` overload over `IQueryable<T>` against a
                // `List` receiver), the relevant slot stays unresolved and
                // MapOpenClrTypeToSymbolic would otherwise surface a bogus open
                // parameter (an ImportedTypeSymbol named "T") that neither
                // ContainsTypeParameter nor ContainsSameCompilationUserType
                // flags — which would then disagree with the correct candidate
                // and abort the whole inference. Skip such candidates instead.
                var unresolvedSlot = false;
                foreach (var invokeParameter in invokeParameters)
                {
                    if (!AllMethodTypeParametersResolved(invokeParameter.ParameterType, openMethod, inferred))
                    {
                        unresolvedSlot = true;
                        break;
                    }
                }

                if (unresolvedSlot)
                {
                    candidateUsable = false;
                    break;
                }

                var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(invokeParameters.Length);
                var slotUsable = true;
                foreach (var invokeParameter in invokeParameters)
                {
                    var mapped = MemberLookup.MapOpenClrTypeToSymbolic(invokeParameter.ParameterType, openDefinition: null, typeArguments: default, openMethodDefinition: openMethod, methodTypeArguments: methodTypeArgs);
                    if (mapped == null || mapped == TypeSymbol.Error || TypeSymbol.ContainsTypeParameter(mapped))
                    {
                        slotUsable = false;
                        break;
                    }

                    parameterTypes.Add(mapped);
                    if (TypeSymbol.ContainsSameCompilationUserType(mapped))
                    {
                        candidateHasSameCompilationType = true;
                    }
                }

                if (!slotUsable)
                {
                    candidateUsable = false;
                    break;
                }

                slotTargets[idx] = parameterTypes.ToImmutable();
            }

            if (!candidateUsable || slotTargets.Count != deferredIndices.Count)
            {
                continue;
            }

            if (agreed == null)
            {
                agreed = slotTargets;
            }
            else if (!SymbolicLambdaParameterTypesAgree(agreed, slotTargets))
            {
                return false;
            }

            anySameCompilationType |= candidateHasSameCompilationType;
        }

        if (agreed == null || !anySameCompilationType)
        {
            return false;
        }

        var built = new Dictionary<int, FunctionTypeSymbol>();
        foreach (var kv in agreed)
        {
            // The return slot is a placeholder; callers bind with
            // inferReturnTypeFromBody so the lambda infers its own return type.
            built[kv.Key] = FunctionTypeSymbol.Get(kv.Value, TypeSymbol.Object);
        }

        targets = built;
        return true;
    }
}
