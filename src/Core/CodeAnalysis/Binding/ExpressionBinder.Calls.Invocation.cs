// <copyright file="ExpressionBinder.Calls.Invocation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
    /// Issue #311: resolves the explicit <c>[T1, T2]</c> type-argument list on a
    /// generic-method call site into CLR types projected onto the reference load
    /// context, ready for <see cref="System.Reflection.MethodInfo.MakeGenericMethod"/>.
    /// Mirrors the generic-construction path so primitives and constructed
    /// generics resolve against the target framework's reference assemblies.
    /// </summary>
    /// <param name="typeArgumentList">The call site's explicit type-argument list, or <c>null</c>.</param>
    /// <param name="explicitTypeArgs">On success, the resolved (mapped) CLR type arguments; <c>null</c> when the list is absent.</param>
    /// <param name="typeArgSymbols">
    /// Issue #320: on success, the resolved type-argument <see cref="TypeSymbol"/>s
    /// in source order; default when the list is absent. These carry user-defined
    /// types (which have no reference-context CLR type and are closed with an
    /// <see cref="object"/> placeholder in <paramref name="explicitTypeArgs"/>) so
    /// later stages can recover and emit the real type argument.
    /// </param>
    /// <returns>
    /// <see langword="true"/> when there is no list (no explicit type args) or
    /// every argument resolved; <see langword="false"/> when a type argument
    /// could not be resolved.
    /// </returns>
    private bool TryResolveExplicitMethodTypeArgs(TypeArgumentListSyntax typeArgumentList, out System.Type[] explicitTypeArgs, out ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        explicitTypeArgs = null;
        typeArgSymbols = default;
        if (typeArgumentList == null)
        {
            return true;
        }

        var resolved = new System.Type[typeArgumentList.Arguments.Count];
        var symbols = ImmutableArray.CreateBuilder<TypeSymbol>(typeArgumentList.Arguments.Count);
        for (var i = 0; i < typeArgumentList.Arguments.Count; i++)
        {
            var ta = bindTypeClause(typeArgumentList.Arguments[i]);
            if (ta == null)
            {
                return false;
            }

            symbols.Add(ta);

            if (ta.ClrType != null)
            {
                // BCL / imported type argument. Project onto the resolver's
                // reference set so it shares the open generic method's load
                // context, exactly as the generic-construction path does before
                // MakeGenericType / MakeGenericMethod.
                // Issue #530: use ResolveClrTypeForGenericArg so that
                // `int32?` resolves to `Nullable<int>` (not bare `int`).
                resolved[i] = resolveClrTypeForGenericArg(ta) ?? scope.References.MapClrTypeToReferences(ta.ClrType);
            }
            else
            {
                // Issue #320: a user-defined type (or an in-scope type parameter)
                // has no reference-context CLR type, so it cannot be handed to
                // MakeGenericMethod directly. Close the open method with a
                // reference-context System.Object placeholder so resolution and
                // applicability still run; the real type-argument symbol is
                // preserved in typeArgSymbols and re-emitted as its own TypeDef
                // token in the generic method specification.
                resolved[i] = scope.References.GetCoreType("System.Object");
            }
        }

        explicitTypeArgs = resolved;
        typeArgSymbols = symbols.MoveToImmutable();
        return true;
    }

    /// <summary>
    /// Issue #1833: scans every public static/instance generic method named
    /// <paramref name="methodName"/> on <paramref name="classType"/> whose
    /// arity matches the explicit type-argument list, looking for one whose
    /// only structural mismatch is a value-type-erased type argument (a
    /// concrete non-enum struct, or a bare <c>[T struct]</c> type parameter)
    /// failing an explicit base-class constraint — e.g. <c>Enum.TryParse</c>'s
    /// <c>where TEnum : Enum</c> bound. Reports the constraint-violation
    /// diagnostic (<c>GS0152</c>, the same one user-declared generic
    /// functions/types already use) and returns <see langword="true"/> on the
    /// first hit; other reasons a candidate is inapplicable (arity, argument
    /// types, an unconstrained type parameter, ...) are left to the caller's
    /// existing "cannot find function" fallback.
    /// </summary>
    /// <param name="classType">The imported class's CLR <see cref="Type"/>.</param>
    /// <param name="methodName">The called method's name.</param>
    /// <param name="explicitTypeArgs">The resolved explicit CLR type arguments.</param>
    /// <param name="typeArgSymbols">The resolved symbolic type-argument vector.</param>
    /// <param name="location">The text location to attach the diagnostic to.</param>
    /// <returns><see langword="true"/> when a violation was found and reported.</returns>
    private bool TryReportGenericValueTypeBaseConstraintViolation(Type classType, string methodName, System.Type[] explicitTypeArgs, ImmutableArray<TypeSymbol> typeArgSymbols, TextLocation location)
    {
        if (classType is null || explicitTypeArgs is null || explicitTypeArgs.Length == 0 || typeArgSymbols.IsDefaultOrEmpty)
        {
            return false;
        }

        MethodInfo[] candidates;
        try
        {
            candidates = classType
                .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance)
                .Where(m => m.Name == methodName
                    && m.IsGenericMethodDefinition
                    && m.GetGenericArguments().Length == explicitTypeArgs.Length)
                .ToArray();
        }
        catch (Exception)
        {
            return false;
        }

        foreach (var candidate in candidates)
        {
            if (OverloadResolution.TryDescribeValueTypeBaseConstraintViolation(candidate, explicitTypeArgs, typeArgSymbols, out var typeParameterName, out var typeArgument, out var constraintDescription))
            {
                Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(location, typeParameterName, typeArgument, constraintDescription);
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #320: computes a return-type override for an imported generic method
    /// closed over explicit type arguments. When the method's open return type is
    /// exactly one of its method type parameters, the real return type is the
    /// corresponding explicit type-argument symbol (recovering a user-defined type
    /// that was closed with an <see cref="object"/> placeholder). Returns
    /// <see langword="null"/> when no override is needed, so callers keep their
    /// existing return-type derivation.
    /// </summary>
    /// <param name="closed">The closed generic method selected by overload resolution.</param>
    /// <param name="typeArgSymbols">The explicit type-argument symbols, or default.</param>
    /// <returns>The override return type symbol, or <see langword="null"/>.</returns>
    private static TypeSymbol ResolveImportedGenericReturnType(System.Reflection.MethodInfo closed, ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        if (!typeArgSymbols.IsDefaultOrEmpty
            && OverloadResolution.TryGetGenericMethodParameterReturnPosition(closed, out var position)
            && position >= 0
            && position < typeArgSymbols.Length)
        {
            return typeArgSymbols[position];
        }

        return null;
    }

    /// <summary>
    /// Issue #1320: a <c>sequence[T]</c> / <c>asyncsequence[T]</c> (iterator
    /// return types, aliases for <c>IEnumerable&lt;T&gt;</c> /
    /// <c>IAsyncEnumerable&lt;T&gt;</c>) or a user-element array receiver over a
    /// same-compilation user element type has a <see langword="null"/>
    /// <see cref="TypeSymbol.ClrType"/> during binding (the element type is not
    /// yet emitted). That null ClrType caused instance-method lookup
    /// (e.g. <c>GetEnumerator</c>) to dead-end with GS0159, even though the same
    /// call resolves on an explicitly-typed <c>IEnumerable[T]</c> parameter
    /// (whose ClrType type-erases to <c>IEnumerable&lt;object&gt;</c>) and on a
    /// primitive-element <c>sequence[int32]</c> / array. Normalize such a
    /// receiver to the equivalent type-erased shape so the shared CLR
    /// member-lookup + symbolic return-type recovery path resolves it uniformly:
    /// <list type="bullet">
    /// <item><c>sequence[T]</c> → a constructed <see cref="ImportedTypeSymbol"/>
    /// over <c>IEnumerable&lt;&gt;</c> with the symbolic <c>[T]</c> argument
    /// (so the generic <c>GetEnumerator() → IEnumerator[T]</c> overload and its
    /// element-typed return are recovered, exactly as for an
    /// <c>IEnumerable[T]</c> parameter).</item>
    /// <item><c>asyncsequence[T]</c> → the <c>IAsyncEnumerable&lt;&gt;</c>
    /// counterpart.</item>
    /// <item>user-element array / slice → a plain
    /// <see cref="ImportedTypeSymbol"/> over the erased array CLR type
    /// (e.g. <c>object[]</c>), reaching parity with a primitive-element array
    /// (which finds the non-generic <c>GetEnumerator()</c>).</item>
    /// </list>
    /// The bound call keeps the original receiver expression; the emitter
    /// already normalizes sequence/array receivers
    /// (<c>TryNormalizeToSymbolicContainer</c>), so emission is unaffected.
    /// Returns <see langword="false"/> when no normalization applies.
    /// </summary>
    /// <param name="receiverType">The receiver's static type symbol.</param>
    /// <param name="normalized">The normalized receiver type, on success.</param>
    /// <returns><see langword="true"/> when a normalized receiver type was produced.</returns>
    private static bool TryNormalizeSymbolicEnumerableReceiver(TypeSymbol receiverType, out TypeSymbol normalized)
    {
        normalized = null;
        if (receiverType == null || receiverType.ClrType != null)
        {
            return false;
        }

        switch (receiverType)
        {
            case SequenceTypeSymbol seq:
                normalized = ImportedTypeSymbol.GetConstructed(
                    typeof(System.Collections.Generic.IEnumerable<object>),
                    typeof(System.Collections.Generic.IEnumerable<>),
                    ImmutableArray.Create(seq.ElementType));
                return true;
            case AsyncSequenceTypeSymbol aseq:
                normalized = ImportedTypeSymbol.GetConstructed(
                    typeof(System.Collections.Generic.IAsyncEnumerable<object>),
                    typeof(System.Collections.Generic.IAsyncEnumerable<>),
                    ImmutableArray.Create(aseq.ElementType));
                return true;
            case ArrayTypeSymbol or SliceTypeSymbol:
                if (MemberLookup.TryProjectErasedClrType(receiverType, out var erasedArray))
                {
                    normalized = ImportedTypeSymbol.Get(erasedArray);
                    return true;
                }

                return false;
            default:
                return false;
        }
    }

    /// <summary>
    /// Issue #1507: builds the receiver type used to drive DEFERRED untyped
    /// arrow-lambda inference over a slice (<c>[]T</c>) or array (<c>[N]T</c>)
    /// receiver. Such a receiver's <see cref="TypeSymbol.ClrType"/> is
    /// <see langword="null"/> for a same-compilation user element (and an array
    /// CLR type otherwise), so the extension-method probe in
    /// <see cref="ResolveDeferredArrowLambdaArguments"/> — which is gated on a
    /// non-null receiver <c>ClrType</c> — is never reached and the element type
    /// is never recovered to target-type the untyped lambda parameter. Normalize
    /// to a symbolic constructed <c>IEnumerable[elementType]</c> carrying the
    /// element type as a symbolic argument (mirroring the <c>List[T]</c> /
    /// <c>sequence[T]</c> shapes), so the LINQ extension
    /// <c>Where&lt;TSource&gt;(IEnumerable&lt;TSource&gt;, Func&lt;TSource,bool&gt;)</c>
    /// (and every other delegate-taking extension) matches and <c>TSource</c> is
    /// recovered as the element type. The constructed <c>ClrType</c> uses the
    /// element's erased CLR projection, so a same-compilation user element
    /// (<c>[]Item</c>) closes to <c>IEnumerable&lt;object&gt;</c> with the
    /// symbolic <c>[Item]</c> argument (the symbolic recovery path re-derives
    /// <c>Item</c>), while a primitive/BCL element (<c>[]int32</c>,
    /// <c>[]string</c>) closes to the concrete <c>IEnumerable&lt;int&gt;</c> /
    /// <c>IEnumerable&lt;string&gt;</c> so the CLR inference path recovers the
    /// real element type instead of erasing it to <c>object</c>. This mirrors the
    /// <c>List[T]</c> behaviour exactly. The <c>IEnumerable&lt;&gt;</c> open
    /// definition and closed shape are resolved through the compilation's
    /// reference set (<see cref="ReferenceResolver.MapClrTypeToReferences"/>) so
    /// the constructed <c>OpenDefinition</c> is reference-identical to the
    /// extension methods' <c>this IEnumerable&lt;TSource&gt;</c> parameter — the
    /// symbolic unifier (<c>UnifyForMethodTypeArgs</c>) matches the open
    /// definition by reference, which would otherwise fail whenever the reference
    /// set is projected through a <see cref="System.Reflection.MetadataLoadContext"/>
    /// (its <c>IEnumerable&lt;&gt;</c> is not the runtime <c>typeof</c>). The bound
    /// call keeps the original slice/array receiver expression; the emitter
    /// already normalizes slice/array receivers to their enumerable surface, so
    /// emission is unaffected. Returns <see langword="false"/> when no
    /// normalization applies.
    /// </summary>
    /// <param name="receiverType">The receiver's static type symbol.</param>
    /// <param name="normalized">The normalized symbolic <c>IEnumerable[T]</c> receiver type, on success.</param>
    /// <returns><see langword="true"/> when a normalized receiver type was produced.</returns>
    private bool TryNormalizeSliceArrayReceiverForLambdaInference(TypeSymbol receiverType, out TypeSymbol normalized)
    {
        normalized = null;

        TypeSymbol elementType;
        switch (receiverType)
        {
            case SliceTypeSymbol slice:
                elementType = slice.ElementType;
                break;
            case ArrayTypeSymbol array:
                elementType = array.ElementType;
                break;
            default:
                return false;
        }

        if (elementType == null || !MemberLookup.TryProjectErasedClrType(elementType, out var erasedElement))
        {
            return false;
        }

        Type openDefinition;
        Type closedEnumerable;
        try
        {
            openDefinition = scope.References.MapClrTypeToReferences(typeof(System.Collections.Generic.IEnumerable<>));
            var mappedElement = scope.References.MapClrTypeToReferences(erasedElement);
            closedEnumerable = openDefinition.MakeGenericType(mappedElement);
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex) || ex is ArgumentException || ex is InvalidOperationException)
        {
            return false;
        }

        normalized = ImportedTypeSymbol.GetConstructed(
            closedEnumerable,
            openDefinition,
            ImmutableArray.Create(elementType));
        return true;
    }

    /// <summary>
    /// Issue #794: when an instance call is dispatched against a receiver whose
    /// <see cref="ImportedTypeSymbol"/> carries symbolic type arguments
    /// (e.g. <c>List[T]</c>, <c>Dictionary[K, V]</c>) — including the
    /// open in-scope type-parameter case from #313/#671 — substitute the
    /// open declaring type's return type using the receiver's symbolic
    /// arguments. Without this override the call's return type comes from the
    /// type-erased closed shape (<c>List&lt;object&gt;.ToArray()</c> →
    /// <c>object[]</c>), losing the symbolic projection (<c>T[]</c>).
    /// Returns <see langword="null"/> when no override is needed so callers
    /// keep their existing return-type derivation.
    /// </summary>
    /// <param name="receiverType">The receiver's static type symbol.</param>
    /// <param name="closedMethod">The closed method selected by overload resolution.</param>
    /// <returns>The override return type symbol, or <see langword="null"/>.</returns>
    private static TypeSymbol ResolveInstanceReturnTypeFromReceiver(TypeSymbol receiverType, System.Reflection.MethodInfo closedMethod)
    {
        if (receiverType is not ImportedTypeSymbol imp
            || imp.OpenDefinition == null
            || imp.TypeArguments.IsDefaultOrEmpty
            || closedMethod == null)
        {
            return null;
        }

        var openMethod = TryGetOpenInstanceMethod(imp.OpenDefinition, closedMethod);
        if (openMethod == null)
        {
            return null;
        }

        var openReturn = openMethod.ReturnType;
        if (openReturn == null || openReturn.IsSameAs(typeof(void)))
        {
            return null;
        }

        var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openReturn, imp.OpenDefinition, imp.TypeArguments);

        // Issue #1100: keep the symbolic projection when the recovered return
        // type references a same-compilation user type as well (not only an
        // in-scope type parameter). A constructed BCL generic over a
        // same-compilation class — e.g. `Queue[Entry].Dequeue()` — projects the
        // open `T` return to the user `Entry` symbol (whose `ClrType` is null
        // while being emitted). Without this the result type-erases to `object`
        // and an `Entry`-typed target fails to bind (GS0155).
        return TypeSymbol.ContainsTypeParameter(mapped) || TypeSymbol.ContainsSameCompilationUserType(mapped)
            ? mapped
            : null;
    }

    /// <summary>
    /// Issue #1107: the by-ref-parameter counterpart of
    /// <see cref="ResolveInstanceReturnTypeFromReceiver"/>. When a call is
    /// dispatched against a receiver whose <see cref="ImportedTypeSymbol"/>
    /// carries symbolic type arguments (e.g. <c>Dictionary[K, V]</c>),
    /// substitute the open declaring type's parameter pointee type using the
    /// receiver's symbolic arguments. Without this an inline <c>out var</c>
    /// argument against a generic by-ref parameter (e.g. the <c>out TValue</c>
    /// of <c>Dictionary&lt;K, V&gt;.TryGetValue</c>) would bind from the
    /// type-erased closed shape (<c>out object</c>), losing the symbolic
    /// projection (the same-compilation user element type) and reporting
    /// <c>GS0158</c> on a subsequent member access of the out-var local.
    /// Returns <see langword="null"/> when no override is needed so callers keep
    /// their existing pointee derivation.
    /// </summary>
    /// <param name="receiverType">The receiver's static type symbol.</param>
    /// <param name="closedMethod">The closed method selected by overload resolution.</param>
    /// <param name="paramIndex">The zero-based parameter position to recover.</param>
    /// <returns>The override pointee type symbol, or <see langword="null"/>.</returns>
    private static TypeSymbol ResolveInstanceParameterPointeeTypeFromReceiver(
        TypeSymbol receiverType,
        System.Reflection.MethodInfo closedMethod,
        int paramIndex)
    {
        if (receiverType is not ImportedTypeSymbol imp
            || imp.OpenDefinition == null
            || imp.TypeArguments.IsDefaultOrEmpty
            || closedMethod == null
            || paramIndex < 0)
        {
            return null;
        }

        var openMethod = TryGetOpenInstanceMethod(imp.OpenDefinition, closedMethod);
        if (openMethod == null)
        {
            return null;
        }

        var openParameters = openMethod.GetParameters();
        if (paramIndex >= openParameters.Length)
        {
            return null;
        }

        var openParamType = openParameters[paramIndex].ParameterType;
        var openPointee = openParamType.IsByRef ? openParamType.GetElementType() : openParamType;
        if (openPointee == null)
        {
            return null;
        }

        var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openPointee, imp.OpenDefinition, imp.TypeArguments);
        return TypeSymbol.ContainsTypeParameter(mapped) || TypeSymbol.ContainsSameCompilationUserType(mapped)
            ? mapped
            : null;
    }

    /// <summary>
    /// Locates the open-generic-definition counterpart of <paramref name="closedMethod"/>
    /// on <paramref name="openDefinition"/>. Match is by metadata token + module,
    /// which is stable for methods on a constructed generic type (the
    /// reflection layer reports the open token regardless of the closing).
    /// </summary>
    /// <param name="openDefinition">The open generic type definition.</param>
    /// <param name="closedMethod">The closed method to project.</param>
    /// <returns>The open method, or <see langword="null"/> when no match.</returns>
    private static System.Reflection.MethodInfo TryGetOpenInstanceMethod(System.Type openDefinition, System.Reflection.MethodInfo closedMethod)
    {
        if (openDefinition == null || closedMethod == null)
        {
            return null;
        }

        if (ClrTypeUtilities.AreSame(closedMethod.DeclaringType, openDefinition))
        {
            return closedMethod;
        }

        var token = closedMethod.MetadataToken;
        var module = closedMethod.Module;
        var bindingFlags = System.Reflection.BindingFlags.Public
            | System.Reflection.BindingFlags.NonPublic
            | System.Reflection.BindingFlags.Instance
            | System.Reflection.BindingFlags.Static;
        foreach (var candidate in openDefinition.GetMethods(bindingFlags))
        {
            if (candidate.MetadataToken == token && ReferenceEquals(candidate.Module, module))
            {
                return candidate;
            }
        }

        return null;
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
        var staticClassType = classSymbol?.ClassType;
        var receiverClrType = classSymbol == null ? receiver?.Type?.ClrType : null;
        foreach (var probe in this.memberLookup.CollectImportedMethodProbes(staticClassType, receiverClrType, methodName, includeExtensions: classSymbol == null))
        {
            foreach (var method in probe.Methods)
            {
                var parameters = method.GetParameters();
                if (probe.ReceiverParameterOffset == 0)
                {
                    result.Add(parameters);
                    continue;
                }

                var stripped = new ParameterInfo[parameters.Length - probe.ReceiverParameterOffset];
                System.Array.Copy(parameters, probe.ReceiverParameterOffset, stripped, 0, stripped.Length);
                result.Add(stripped);
            }
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

        var candidates = MemberLookup.CollectSourceInstanceMethods(receiver.Type, methodName);

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

                if (!MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(candidate.Parameters[paramPos].Type, out var fn) || fn == null)
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

    /// <summary>
    /// Issue #1330: binds a static method call on a generic type constructed
    /// over an in-scope generic type parameter (e.g.
    /// <c>Comparer[TResult].Create(...)</c>) by substituting the receiver's
    /// symbolic type arguments through the resolved method's open parameter and
    /// return types. A delegate parameter surfaces as its symbolic shape
    /// (<c>Comparison[TResult]</c>) so a function-literal argument flows through
    /// as an identity adapter hosted in the enclosing generic context rather than
    /// a type-erased <c>&lt;object&gt;</c> adapter referencing an out-of-scope
    /// type parameter; the result is the symbolic <c>Comparer[TResult]</c>; and
    /// the produced <see cref="BoundImportedCallExpression"/> carries the
    /// symbolic container so the emitter parents the call at the constructed
    /// <c>Comparer&lt;!TResult&gt;</c> TypeSpec. Returns <see langword="false"/>
    /// (deferring to the ordinary erased path) when the symbolic open method or a
    /// parameter projection cannot be recovered.
    /// </summary>
    private bool TryBindSymbolicImportedStaticCall(
        CallExpressionSyntax ce,
        ImportedClassSymbol classSymbol,
        ImportedFunctionSymbol staticFn,
        ImmutableArray<BoundExpression> arguments,
        out BoundExpression result)
    {
        result = null;
        var symbolicReceiver = classSymbol.SymbolicReceiver;
        if (symbolicReceiver?.OpenDefinition == null
            || symbolicReceiver.TypeArguments.IsDefaultOrEmpty
            || !TryResolveOpenStaticMethod(symbolicReceiver.OpenDefinition, staticFn.Method, out var openMethod))
        {
            return false;
        }

        var openParameters = openMethod.GetParameters();
        if (openParameters.Length != arguments.Length)
        {
            // Optional/params/defaulted parameter shapes are not handled by this
            // narrow symbolic path; fall back to the ordinary resolution.
            return false;
        }

        var openDef = symbolicReceiver.OpenDefinition;
        var symbolicArgs = symbolicReceiver.TypeArguments;
        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        for (var i = 0; i < arguments.Length; i++)
        {
            var argument = arguments[i];
            var openParamType = openParameters[i].ParameterType;
            var symbolicParamType = MemberLookup.MapOpenClrTypeToSymbolic(openParamType, openDef, symbolicArgs);

            if (LambdaBinder.TryGetFunctionLiteral(argument, out var functionLiteral)
                && symbolicParamType is ImportedTypeSymbol symbolicDelegateParam
                && symbolicDelegateParam.OpenDefinition != null
                && symbolicDelegateParam.HasTypeParameterArgument
                && TryBuildSymbolicDelegateTarget(openParamType, openDef, symbolicArgs, out var symbolicDelegateTarget))
            {
                // The substituted delegate target matches the literal's declared
                // (TResult-typed) shape, so the adapter returns the literal
                // unchanged (IsIdentityAdapter) — the lambda MethodDef is hosted
                // in the enclosing generic context. Wrap it in a conversion to
                // the symbolic constructed delegate type (`Comparison[TResult]`)
                // so the emitter materialises a `Comparison<!TResult>` instance
                // (rather than the natural `Func<...>` or the type-erased
                // `Comparison<object>`) that the callee's reified parameter
                // accepts. The classifier would reject this (the erased
                // `Comparison<object>` Invoke shape differs from the TResult
                // literal), so build the conversion node directly.
                var adapter = lambdas.CreateErasedFunctionLiteralAdapter(functionLiteral, symbolicDelegateTarget);
                convertedArgs.Add(new BoundConversionExpression(null, symbolicDelegateParam, adapter));
                continue;
            }

            if (symbolicParamType is TypeParameterSymbol || symbolicParamType == TypeSymbol.Error)
            {
                convertedArgs.Add(argument);
                continue;
            }

            var argLoc = i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
            convertedArgs.Add(conversions.BindConversion(argLoc, argument, symbolicParamType));
        }

        var symbolicReturn = MemberLookup.MapOpenClrTypeToSymbolic(openMethod.ReturnType, openDef, symbolicArgs);
        var overriddenFn = new ImportedFunctionSymbol(
            staticFn.Name,
            classSymbol,
            staticFn.Method,
            staticFn.Declaration,
            returnTypeOverride: symbolicReturn);
        var refKinds = ComputeArgumentRefKinds(staticFn.Method.GetParameters());
        result = new BoundImportedCallExpression(
            null,
            overriddenFn,
            convertedArgs.MoveToImmutable(),
            refKinds,
            typeArgumentSymbols: default,
            staticContainerType: symbolicReceiver);
        return true;
    }

    /// <summary>
    /// Issue #1330: resolves the open generic <em>type</em> definition's method
    /// corresponding to <paramref name="closedMethod"/> (a static method on the
    /// type-erased closed shape, e.g. <c>Comparer&lt;object&gt;.Create</c>) by
    /// metadata-token identity, yielding e.g. <c>Comparer&lt;&gt;.Create</c>
    /// whose parameter/return types are stated in terms of the type's open
    /// generic parameters.
    /// </summary>
    private static bool TryResolveOpenStaticMethod(Type openDefinition, MethodInfo closedMethod, out MethodInfo openMethod)
        => TryResolveOpenMethodByToken(openDefinition, closedMethod, BindingFlags.Static, out openMethod);

    /// <summary>
    /// Issue #2365: instance-method sibling of <see cref="TryResolveOpenStaticMethod"/>.
    /// Resolves the open generic <em>type</em> definition's INSTANCE method
    /// corresponding to <paramref name="closedMethod"/> (a non-generic instance
    /// method reflected off a constructed generic receiver, e.g.
    /// <c>CreateTableBuilder&lt;object&gt;.PrimaryKey</c>) by metadata-token
    /// identity, yielding the open shape (e.g. <c>CreateTableBuilder&lt;&gt;.PrimaryKey</c>)
    /// whose parameter types are stated in terms of the type's own open generic
    /// parameters. This lets a delegate/expression-tree parameter that closes
    /// over the DECLARING TYPE's type parameter (rather than a method-level one)
    /// recover its symbolic shape even though the method itself is not generic.
    /// </summary>
    private static bool TryResolveOpenInstanceMethod(Type openDefinition, MethodInfo closedMethod, out MethodInfo openMethod)
        => TryResolveOpenMethodByToken(openDefinition, closedMethod, BindingFlags.Instance, out openMethod);

    private static bool TryResolveOpenMethodByToken(Type openDefinition, MethodInfo closedMethod, BindingFlags kindFlag, out MethodInfo openMethod)
    {
        openMethod = null;
        if (openDefinition == null || closedMethod == null)
        {
            return false;
        }

        try
        {
            foreach (var candidate in openDefinition.GetMethods(kindFlag | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (candidate.MetadataToken == closedMethod.MetadataToken && candidate.Module == closedMethod.Module)
                {
                    openMethod = candidate;
                    return true;
                }
            }
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return false;
        }

        return false;
    }

    /// <summary>
    /// Issue #1330: builds a <see cref="FunctionTypeSymbol"/> for an open
    /// delegate parameter type (e.g. <c>Comparison&lt;T&gt;</c>) by substituting
    /// the receiver's symbolic type arguments into the delegate's
    /// <c>Invoke</c> signature, producing the symbolic target
    /// <c>(TResult, TResult) -&gt; int32</c>. Returns <see langword="false"/> when
    /// the parameter is not a delegate type.
    /// </summary>
    private static bool TryBuildSymbolicDelegateTarget(
        Type openParameterType,
        Type openDefinition,
        ImmutableArray<TypeSymbol> symbolicArgs,
        out FunctionTypeSymbol target)
    {
        target = null;
        if (openParameterType == null)
        {
            return false;
        }

        // Issue #2365: an `Expression<TDelegate>` parameter is not itself a
        // delegate (it exposes no `Invoke`), so unwrap it to the wrapped open
        // delegate type first, mirroring the identical unwrap in the
        // method-parameter sibling <see cref="TryBuildSymbolicDelegateTargetForMethodParam"/>.
        if (MemberLookup.TryGetExpressionTreeDelegateType(openParameterType, out var unwrappedParameterType))
        {
            openParameterType = unwrappedParameterType;
        }

        var invoke = openParameterType?.GetMethodSafe("Invoke");
        if (invoke == null)
        {
            return false;
        }

        var invokeParameters = invoke.GetParameters();
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(invokeParameters.Length);
        foreach (var parameter in invokeParameters)
        {
            parameterTypes.Add(MemberLookup.MapOpenClrTypeToSymbolic(parameter.ParameterType, openDefinition, symbolicArgs));
        }

        var returnType = invoke.ReturnType.IsSameAs(typeof(void))
            ? TypeSymbol.Void
            : MemberLookup.MapOpenClrTypeToSymbolic(invoke.ReturnType, openDefinition, symbolicArgs);
        target = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), returnType);
        return true;
    }

    /// <summary>
    /// Issue #1512 / #2365: builds a symbolic <see cref="FunctionTypeSymbol"/> for
    /// a lambda argument bound to a CLR/imported method whose delegate (or
    /// <c>Expression&lt;TDelegate&gt;</c>-wrapped delegate) parameter mentions a
    /// generic type parameter — either a METHOD-level one (e.g.
    /// <c>Task.ContinueWith&lt;TResult&gt;(Func&lt;Task,TResult&gt;)</c>, #1512) or
    /// the DECLARING TYPE's own type parameter closed over by a symbolic
    /// receiver on a non-generic method (e.g.
    /// <c>CreateTableBuilder&lt;TColumns&gt;.PrimaryKey(Expression&lt;Func&lt;TColumns,object&gt;&gt;)</c>,
    /// #2365). The CLOSED method's parameter is type-erased
    /// (<c>Expression&lt;Func&lt;object,object&gt;&gt;</c> / <c>Func&lt;Task,object&gt;</c>),
    /// which would force the lambda's bound function type — and therefore its
    /// synthesized return/parameter shape — to <c>object</c>, producing an
    /// unverifiable delegate. This recovers the real shape by substituting the
    /// inferred symbolic method type arguments AND/OR the receiver's symbolic
    /// type arguments through the OPEN method's delegate parameter via
    /// <see cref="MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo, ImmutableArray{TypeSymbol})"/>,
    /// unwrapping an <c>Expression&lt;TDelegate&gt;</c> parameter shape to its
    /// inner delegate first so both direct-delegate and expression-tree targets
    /// share the same recovery path. Returns <see langword="false"/> (deferring
    /// to the erased target) when neither the method nor the receiver carries a
    /// symbolic type argument, the parameter is not a delegate/expression-tree
    /// shape, or no recovered position contains a type parameter /
    /// same-compilation user type.
    /// </summary>
    private static bool TryBuildSymbolicDelegateTargetForMethodParam(
        MethodInfo closedMethod,
        int paramIndex,
        ImmutableArray<TypeSymbol> symbolicMethodTypeArgs,
        TypeSymbol receiverType,
        out FunctionTypeSymbol target)
    {
        target = null;
        if (closedMethod == null)
        {
            return false;
        }

        var methodHasSymbolicArgs = closedMethod.IsGenericMethod
            && !symbolicMethodTypeArgs.IsDefaultOrEmpty
            && symbolicMethodTypeArgs.Any(s => s != null
                && (TypeSymbol.ContainsTypeParameter(s) || TypeSymbol.ContainsSameCompilationUserType(s)));

        Type receiverOpenDef = null;
        ImmutableArray<TypeSymbol> receiverTypeArgs = default;
        if (receiverType is ImportedTypeSymbol imp && imp.OpenDefinition != null && !imp.TypeArguments.IsDefaultOrEmpty)
        {
            receiverOpenDef = imp.OpenDefinition;
            receiverTypeArgs = imp.TypeArguments;
        }

        var receiverHasSymbolicArgs = receiverOpenDef != null
            && receiverTypeArgs.Any(s => s != null
                && (TypeSymbol.ContainsTypeParameter(s) || TypeSymbol.ContainsSameCompilationUserType(s)));

        if (!methodHasSymbolicArgs && !receiverHasSymbolicArgs)
        {
            return false;
        }

        MethodInfo openMethod;
        ParameterInfo[] openParams;
        try
        {
            if (closedMethod.IsGenericMethod)
            {
                openMethod = closedMethod.IsGenericMethodDefinition ? closedMethod : closedMethod.GetGenericMethodDefinition();
            }
            else if (receiverOpenDef != null && !closedMethod.IsStatic
                && TryResolveOpenInstanceMethod(receiverOpenDef, closedMethod, out var resolvedOpenMethod))
            {
                // Issue #2365: the method itself has no generic parameters of
                // its own — TColumns belongs to the DECLARING TYPE
                // (`CreateTableBuilder[TColumns]`) — so recover the open shape
                // from the receiver's open type definition rather than from
                // `GetGenericMethodDefinition()` (which only applies to
                // method-level generics).
                openMethod = resolvedOpenMethod;
            }
            else
            {
                return false;
            }

            openParams = openMethod.GetParameters();
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return false;
        }

        if (paramIndex < 0 || paramIndex >= openParams.Length)
        {
            return false;
        }

        var openParamType = openParams[paramIndex].ParameterType;

        // Issue #2365: an `Expression<TDelegate>` parameter is not itself a
        // delegate (it exposes no `Invoke`), so unwrap it to the wrapped open
        // delegate type first. Both a direct delegate parameter and an
        // expression-tree-wrapped one recover through the identical
        // substitution path below; the caller compares the result against the
        // literal's own (unwrapped) delegate function type either way.
        if (MemberLookup.TryGetExpressionTreeDelegateType(openParamType, out var unwrappedOpenDelegate))
        {
            openParamType = unwrappedOpenDelegate;
        }

        var invoke = openParamType?.GetMethodSafe("Invoke");
        if (invoke == null)
        {
            return false;
        }

        var invokeParameters = invoke.GetParameters();
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(invokeParameters.Length);
        foreach (var parameter in invokeParameters)
        {
            parameterTypes.Add(MemberLookup.MapOpenClrTypeToSymbolic(
                parameter.ParameterType, receiverOpenDef, receiverTypeArgs, openMethod, symbolicMethodTypeArgs));
        }

        var returnType = invoke.ReturnType.IsSameAs(typeof(void))
            ? TypeSymbol.Void
            : MemberLookup.MapOpenClrTypeToSymbolic(invoke.ReturnType, receiverOpenDef, receiverTypeArgs, openMethod, symbolicMethodTypeArgs);

        var candidate = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), returnType);

        // Only override the erased target when the recovered shape actually
        // carries a type parameter or same-compilation user type; otherwise the
        // ordinary closed-CLR delegate target is already correct.
        var carries = (returnType != null && (TypeSymbol.ContainsTypeParameter(returnType) || TypeSymbol.ContainsSameCompilationUserType(returnType)))
            || parameterTypes.Any(p => p != null && (TypeSymbol.ContainsTypeParameter(p) || TypeSymbol.ContainsSameCompilationUserType(p)));
        if (!carries)
        {
            return false;
        }

        target = candidate;
        return true;
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
        // Issue #1507: a slice/array receiver (`[]T` / `[N]T`) carries a null
        // (user element) or array-shaped ClrType, so the extension-method probe
        // below — gated on a non-null receiver ClrType — would never be added
        // and the untyped lambda parameter would never be target-typed from the
        // matching LINQ delegate. Normalize such a receiver to a symbolic
        // `IEnumerable[elementType]` (recovering the element type exactly as the
        // `List[T]`/`sequence[T]` paths do) purely for the purpose of inferring
        // the deferred lambda targets; the finally-bound call keeps the original
        // slice/array receiver expression.
        var receiverType = receiver?.Type;
        if (receiverType != null
            && TryNormalizeSliceArrayReceiverForLambdaInference(receiverType, out var normalizedReceiverType))
        {
            receiverType = normalizedReceiverType;
        }

        var probes = this.memberLookup.CollectImportedMethodProbes(
            classSymbol?.ClassType,
            classSymbol == null ? receiverType?.ClrType : null,
            methodName,
            includeExtensions: classSymbol == null && receiverType?.ClrType != null);

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
        foreach (var probe in probes)
        {
            if (TryMapDeferredLambdaTargetsSymbolic(probe.Methods, probe.ReceiverParameterOffset, receiverType, ce, deferredIndices, boundArgs, deferred, out var symbolicTargets, out var exactReturnIndices))
            {
                foreach (var idx in deferredIndices)
                {
                    var inner = OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[idx]);
                    if (inner is LambdaExpressionSyntax lambdaSyntax && symbolicTargets.TryGetValue(idx, out var target))
                    {
                        // Issue #2345: when this slot's return type was fully
                        // recovered (e.g. `void` for an Action-shaped
                        // parameter), bind against the real target so the
                        // void-discard / ordinary target-typed return-type
                        // inference applies instead of inferring the return
                        // type purely from the lambda body.
                        boundArgs[idx] = lambdas.BindLambdaExpression(lambdaSyntax, target, inferReturnTypeFromBody: !exactReturnIndices.Contains(idx));
                    }
                }

                return;
            }
        }

        foreach (var probe in probes)
        {
            var offset = probe.ReceiverParameterOffset;
            var methods = probe.Methods;
            var argTypes = new System.Type[boundArgs.Length + offset];
            if (offset == 1)
            {
                argTypes[0] = receiverType.ClrType;
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

            // Issue #1812: `interpolatedStringArgs` is intentionally omitted
            // here. This Resolve call is a best-effort probe purely to
            // discover a deferred (untyped) arrow-lambda argument's delegate
            // parameter type by narrowing candidates on the other,
            // already-bound arguments; it is never the final overload
            // decision. The call is re-resolved for real via the ordinary
            // static/instance/extension Resolve call sites once every
            // argument (including the now-typed lambda) is bound — those
            // sites already pass the flag, so an interpolated-string argument
            // sharing a call with a deferred lambda still resolves/rebinds
            // correctly overall.
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
                    || !MemberLookup.TryGetLambdaTargetFunctionType(parameterType, out var fn)
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
        foreach (var probe in probes)
        {
            if (TryMapDeferredLambdaParameterTargets(probe.Methods, probe.ReceiverParameterOffset, receiverType, ce, deferredIndices, boundArgs, out var partialTargets))
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
        TypeSymbol receiverType,
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
            if (receiverType?.ClrType is not System.Type receiverClrType)
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
    ///
    /// Issue #2345: also recovers the delegate's <em>return</em> shape when it
    /// is fully closed by the same unification (including the common case of a
    /// <c>void</c>-returning <c>Action</c>-shaped delegate). When recovered,
    /// the corresponding slot in <paramref name="exactReturnIndices"/> is
    /// marked so callers bind that lambda against the real target (not
    /// <c>inferReturnTypeFromBody</c>) — this is what lets a block-bodied
    /// lambda whose trailing statement calls a fluent/self-returning method
    /// correctly discard that value instead of being mis-inferred as a
    /// value-returning <c>Func</c> (see <c>InferLambdaReturnType</c>'s issue
    /// #889 void-discard rule). When the return type still contains an
    /// unresolved method type parameter, the slot keeps the previous
    /// placeholder behavior (return type inferred from the lambda body).
    /// </summary>
    private bool TryMapDeferredLambdaTargetsSymbolic(
        IReadOnlyList<MethodInfo> methods,
        int offset,
        TypeSymbol receiverType,
        CallExpressionSyntax ce,
        List<int> deferredIndices,
        BoundExpression[] boundArgs,
        HashSet<int> deferred,
        out Dictionary<int, FunctionTypeSymbol> targets,
        out HashSet<int> exactReturnIndices)
    {
        exactReturnIndices = new HashSet<int>();

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
        if (offset == 1 && receiverType == null)
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
            symbolicArgs[0] = receiverType;
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
        Dictionary<int, TypeSymbol> agreedReturnTypes = null;
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
            var slotReturnTypes = new Dictionary<int, TypeSymbol>();
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
                    invoke = delegateType?.GetMethodSafe("Invoke");
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

                // Issue #2345: recover the delegate's return shape too, when it
                // is fully closed by this unification (most commonly `void`,
                // for an Action-shaped constraints/configuration delegate).
                // Candidates that leave the return type open (e.g. still
                // containing an unresolved method type parameter) fall back to
                // the pre-existing placeholder + inferReturnTypeFromBody
                // behavior for that slot.
                var returnClrType = invoke.ReturnType;
                var mappedReturn = returnClrType != null && returnClrType.IsSameAs(typeof(void))
                    ? TypeSymbol.Void
                    : MemberLookup.MapOpenClrTypeToSymbolic(returnClrType, openDefinition: null, typeArguments: default, openMethodDefinition: openMethod, methodTypeArguments: methodTypeArgs);
                if (mappedReturn != null && mappedReturn != TypeSymbol.Error && !TypeSymbol.ContainsTypeParameter(mappedReturn))
                {
                    slotReturnTypes[idx] = mappedReturn;
                }
            }

            if (!candidateUsable || slotTargets.Count != deferredIndices.Count)
            {
                continue;
            }

            if (agreed == null)
            {
                agreed = slotTargets;
                agreedReturnTypes = slotReturnTypes;
            }
            else if (!SymbolicLambdaParameterTypesAgree(agreed, slotTargets))
            {
                return false;
            }
            else
            {
                // Issue #2345: parameter shapes agree across candidates, but
                // only keep a recovered return type for a slot when every
                // agreeing candidate recovered the *same* return type;
                // otherwise that slot falls back to the pre-existing
                // placeholder + inferReturnTypeFromBody behavior.
                foreach (var idx in deferredIndices)
                {
                    if (agreedReturnTypes.TryGetValue(idx, out var existingReturn))
                    {
                        if (!slotReturnTypes.TryGetValue(idx, out var otherReturn) || !Equals(existingReturn, otherReturn))
                        {
                            agreedReturnTypes.Remove(idx);
                        }
                    }
                }
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
            if (agreedReturnTypes != null && agreedReturnTypes.TryGetValue(kv.Key, out var exactReturn))
            {
                // Issue #2345: the delegate's return shape was fully closed by
                // unification (e.g. `void` for an Action-shaped parameter) —
                // bind against the real target so the caller does NOT pass
                // inferReturnTypeFromBody, letting InferLambdaReturnType's
                // void-discard rule (issue #889) and ordinary target-typed
                // inference apply.
                built[kv.Key] = FunctionTypeSymbol.Get(kv.Value, exactReturn);
                exactReturnIndices.Add(kv.Key);
            }
            else
            {
                // The return slot is a placeholder; callers bind with
                // inferReturnTypeFromBody so the lambda infers its own return type.
                built[kv.Key] = FunctionTypeSymbol.Get(kv.Value, TypeSymbol.Object);
            }
        }

        targets = built;
        return true;
    }

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

    /// <summary>
    /// Issue #903: returns <see langword="true"/> when every <em>method</em>
    /// generic parameter (declared on <paramref name="openMethod"/>) reachable
    /// from <paramref name="openType"/> has a non-<see langword="null"/> entry in
    /// <paramref name="inferred"/> — i.e. it was actually resolved by unifying
    /// the receiver/arguments. Used to discard candidate methods whose delegate
    /// parameter shape contains a method type parameter that the call did not
    /// determine (e.g. a <c>Single</c> overload whose <c>this</c> parameter does
    /// not match the receiver), which would otherwise surface a bogus open
    /// parameter symbol via
    /// <see cref="MemberLookup.MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo, ImmutableArray{TypeSymbol})"/>.
    /// </summary>
    private static bool AllMethodTypeParametersResolved(Type openType, MethodInfo openMethod, TypeSymbol[] inferred)
    {
        if (openType == null)
        {
            return false;
        }

        try
        {
            if (openType.IsGenericParameter)
            {
                // A type-level parameter (declared on the receiver type) is
                // resolved through the receiver's TypeArguments, not the method
                // type-arg vector, so it does not gate this candidate.
                if (openType.DeclaringMethod == null)
                {
                    return true;
                }

                if (!ReferenceEquals(openType.DeclaringMethod, openMethod)
                    && openType.DeclaringMethod.MetadataToken != openMethod.MetadataToken)
                {
                    return true;
                }

                var pos = openType.GenericParameterPosition;
                return (uint)pos < (uint)inferred.Length && inferred[pos] != null;
            }

            if (openType.IsByRef || openType.IsArray)
            {
                return AllMethodTypeParametersResolved(openType.GetElementType(), openMethod, inferred);
            }

            if (openType.IsGenericType)
            {
                foreach (var arg in openType.GetGenericArguments())
                {
                    if (!AllMethodTypeParametersResolved(arg, openMethod, inferred))
                    {
                        return false;
                    }
                }
            }

            return true;
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #977: detects whether the argument at <paramref name="index"/> of an
    /// imported-method call is an inline <c>out var</c>/<c>out let</c>/<c>out _</c>
    /// declaration whose type is omitted (and therefore must be inferred from the
    /// resolved overload). An explicitly typed inline declaration is excluded
    /// because its local is already declared with a known type in the eager pass.
    /// </summary>
    /// <param name="ce">The call expression syntax.</param>
    /// <param name="index">The source argument index.</param>
    /// <param name="refArg">The matched ref-argument syntax, when applicable.</param>
    /// <returns><see langword="true"/> when the argument is a type-omitted inline out declaration.</returns>
    private static bool TryGetInlineOutVarArgument(CallExpressionSyntax ce, int index, out RefArgumentExpressionSyntax refArg)
    {
        refArg = null;
        if (index < 0 || index >= ce.Arguments.Count)
        {
            return false;
        }

        if (OverloadResolver.UnwrapNamedArgumentValue(ce.Arguments[index]) is RefArgumentExpressionSyntax candidate
            && candidate.IsInlineDeclaration
            && candidate.DeclaredType == null)
        {
            refArg = candidate;
            return true;
        }

        return false;
    }

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
    /// <param name="typeArgSymbols">The explicit type-argument symbols (issue #1599, for recovering a placeholder-closed out-parameter pointee); default when absent.</param>
    /// <returns>The argument vector with inline out-var placeholders rebound.</returns>
    private ImmutableArray<BoundExpression> RebindInlineOutVarArguments(
        CallExpressionSyntax ce,
        ImmutableArray<BoundExpression> arguments,
        System.Reflection.MethodInfo resolvedMethod,
        ImmutableArray<int> parameterMapping,
        TypeSymbol receiverType = null,
        ImmutableArray<TypeSymbol> typeArgSymbols = default)
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
                ?? ResolveMethodGenericParameterPointeeType(resolvedMethod, paramIndex, typeArgSymbols)
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

    /// <summary>
    /// Issue #1599: recovers the pointee type of an <c>out</c>/<c>ref</c> parameter that
    /// is typed by one of the resolved generic method's own type parameters (e.g. the
    /// <c>out TEnum</c> of <c>Enum.TryParse&lt;TEnum&gt;(string, out TEnum)</c>) from the
    /// explicit type-argument symbols. When the method was closed over a value-type
    /// placeholder (or an <see cref="object"/> erasure) — as happens for a
    /// same-compilation user value type under a <c>where T : struct</c> constraint — the
    /// closed CLR parameter carries the placeholder, which must not leak into an inline
    /// <c>out var</c> local. Returns <see langword="null"/> when no recovery applies so
    /// the caller falls back to the CLR pointee type.
    /// </summary>
    /// <param name="resolvedMethod">The closed generic method selected by overload resolution.</param>
    /// <param name="parameterIndex">The zero-based parameter position of the out/ref argument.</param>
    /// <param name="typeArgSymbols">The explicit type-argument symbols, or default.</param>
    /// <returns>The recovered pointee type symbol, or <see langword="null"/>.</returns>
    private static TypeSymbol ResolveMethodGenericParameterPointeeType(
        System.Reflection.MethodInfo resolvedMethod,
        int parameterIndex,
        ImmutableArray<TypeSymbol> typeArgSymbols)
    {
        if (!typeArgSymbols.IsDefaultOrEmpty
            && OverloadResolution.TryGetGenericMethodParameterPosition(resolvedMethod, parameterIndex, out var position)
            && position >= 0
            && position < typeArgSymbols.Length)
        {
            return typeArgSymbols[position];
        }

        return null;
    }

    internal BoundExpression BindAccessorCall(BoundExpression receiver, ImportedClassSymbol classSymbol, CallExpressionSyntax ce)
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
                //
                // Issue #2193: but if a same-named user extension function has a
                // function-typed parameter at this position, the CLR candidate
                // set is not authoritative — target-typing the lambda to a CLR
                // delegate (e.g. the void `SendOrPostCallback` of
                // `SynchronizationContext.Send`) would erase the lambda's return
                // type and break inference of the extension's result type
                // parameter (GS0151). Bind the lambda with its natural type so
                // both the CLR instance method and the user extension can compete
                // (delegate-reshaping conversions still make it applicable to a
                // concrete CLR delegate parameter when that path is chosen).
                var argName = argumentNames.IsDefault ? null : argumentNames[argSlot];
                if (UserExtensionHasFunctionTypedParameterAt(receiver, methodName, argSlot))
                {
                    boundArguments.Add(BindExpression(inner));
                }
                else
                {
                    if (!delegateTargetCandidatesComputed)
                    {
                        delegateTargetCandidatesComputed = true;
                        delegateTargetCandidateParams = CollectDelegateTargetCandidateParameterLists(receiver, classSymbol, methodName);
                    }

                    // Issue #2345: an explicitly-typed lambda whose matching
                    // delegate parameter is an *open* generic (e.g. an imported
                    // generic method's `Action<Builder<TColumns>>`, where
                    // `TColumns` only closes once the method's type arguments
                    // are inferred from the call's other arguments) cannot be
                    // target-typed yet. Binding it now with no target is only
                    // safe for an expression-bodied lambda (`-> expr`), whose
                    // return type is unambiguously the expression's type either
                    // way. A block-bodied lambda (`-> { ... }`) is different:
                    // with no target, a trailing call expression-statement (e.g.
                    // a fluent/self-returning builder method) is treated as the
                    // block's *value*, producing a `Func<..., TResult>`-shaped
                    // lambda instead of the `void`-returning `Action` the (still
                    // unresolved) target actually expects — which mismatches the
                    // real parameter and cascades into "cannot find function" at
                    // the outer call. Defer such lambdas exactly like an
                    // untyped arrow lambda so the staged inference below
                    // (`ResolveDeferredArrowLambdaArguments`) can close the
                    // generic method's type arguments from the other arguments
                    // first, then bind this lambda against the now-closed
                    // delegate target (its own explicit parameter types are
                    // unaffected — only return-type inference depends on the
                    // target).
                    if (inner is LambdaExpressionSyntax { Body: BlockExpressionSyntax } blockLambda
                        && argumentNames.IsDefault
                        && !TryResolveDelegateTargetFromCandidates(delegateTargetCandidateParams, paramOffset: 0, sourceArgIndex: argSlot, argName: argName, target: out _, blockedByOpenGenericParameter: out var blocked)
                        && blocked)
                    {
                        deferredArrowLambdaIndices.Add(argSlot);
                        boundArguments.Add(new BoundErrorExpression(blockLambda));
                    }
                    else
                    {
                        boundArguments.Add(BindCallArgumentWithDelegateTargetTyping(
                            argument, delegateTargetCandidateParams, sourceArgIndex: argSlot, argName: argName, paramOffset: 0));
                    }
                }
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
                // Issue #1538: now that the imported static overload is chosen,
                // re-bind any inline `out var`/`out let`/`out _` placeholders
                // against the resolved by-ref parameter so the synthesized local
                // is declared with the inferred (substituted) pointee type and
                // leaks into the enclosing block scope. Without this the
                // placeholder (an Error-typed address-of) would flow into the
                // parameter-conversion path below and the inline-declared local
                // would never exist for the rest of the body. Static calls have
                // no receiver, so pass null; the mapping aligns source args to
                // parameters for out-parameters in any position.
                arguments = RebindInlineOutVarArguments(ce, arguments, staticFn.Method, staticMapping, receiver?.Type, typeArgSymbols);

                // Issue #1330: when the receiver is a generic type constructed
                // over an in-scope generic type parameter (`Comparer[TResult]`),
                // bind the static call symbolically — substituting the receiver's
                // symbolic arguments through the resolved method's parameter and
                // return types — so a delegate parameter surfaces as
                // `Comparison[TResult]` (the lambda flows through as an identity
                // adapter hosted in the enclosing generic context rather than a
                // type-erased `<object>` adapter referencing an out-of-scope
                // type parameter), the call's result type is the symbolic
                // `Comparer[TResult]`, and the emitter parents the call at the
                // constructed `Comparer<!TResult>` TypeSpec. Yields verifiable IL
                // exactly as the concrete-argument receiver does.
                if (classSymbol.SymbolicReceiver != null
                    && argumentNames.IsDefault
                    && !staticIsExpanded
                    && staticMapping.IsDefault
                    && TryBindSymbolicImportedStaticCall(ce, classSymbol, staticFn, arguments, out var symbolicStaticCall))
                {
                    return symbolicStaticCall;
                }

                var staticParameters = staticFn.Method.GetParameters();
                var staticExpandedArgs = staticIsExpanded
                    ? overloads.ExpandParamsArguments(arguments, staticParameters, ce, parameterMapping: staticMapping)
                    : arguments;
                var staticDownstreamMapping = staticIsExpanded ? default : staticMapping;

                // Issue #1325 / #1471: recover the symbolic method type-argument
                // vector before parameter conversion so a bare `default`
                // argument closed over an open type parameter (e.g.
                // `Task.FromResult[T?](default)`) materialises against the real
                // type parameter instead of the erased `object` placeholder.
                // Issue #1512: computed BEFORE the delegate rebind so a lambda
                // argument whose return is a method type parameter recovers its
                // symbolic delegate target rather than erasing to `object`.
                var staticSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(
                    receiverType: null,
                    ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
                var staticSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(staticFn.Method, typeArgSymbols, staticSymbolicArgs);
                var staticTypeArgSymbolsForCall = !staticSymbolicTypeArgs.IsDefault ? staticSymbolicTypeArgs : typeArgSymbols;

                // Issue #1638: shared CLR call-argument-construction pipeline
                // (interpolation rebind → handler args → delegate rebind →
                // parameter conversions). Issue #889: void-izes value-returning
                // func/arrow literals passed to void-returning delegate
                // parameters (System.Action / Action<...>), mirroring the
                // instance path. Issue #506 follow-up: ensures value-type →
                // object boxing fires for fixed-arity CLR static calls (e.g.
                // `String.Format("{0}", 42)` selecting the fixed `(string,
                // object)` overload).
                var staticConvertedArgs = BuildResolvedClrCallArguments(
                    staticExpandedArgs,
                    ce.Arguments,
                    staticParameters,
                    staticDownstreamMapping,
                    receiver: null,
                    ce.Location,
                    ce,
                    ClrCallDelegateRebindMode.Full,
                    out var staticHandlerPrelude,
                    out _,
                    method: staticFn.Method,
                    symbolicMethodTypeArgs: staticTypeArgSymbolsForCall);
                var staticArguments = OverloadResolver.BuildOrderedCallArguments(staticConvertedArgs, staticDownstreamMapping, staticParameters);
                var refKinds = ComputeArgumentRefKinds(staticParameters);
                overloads.ValidateRefArguments(staticArguments, refKinds, methodName, ce.Location);

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

            // Issue #1833: a value-type-erased type argument (a concrete
            // non-enum struct, or a bare `[T struct]` type parameter) explicitly
            // supplied to a generic BCL method whose type parameter carries an
            // `Enum` (or any other concrete) base-class constraint is now
            // rejected by `SatisfiesGenericConstraints`, so the candidate above
            // was silently dropped exactly like any other inapplicable overload.
            // Report the specific constraint violation here — before falling
            // back to the generic "cannot find function" diagnostic — so the
            // caller gets a clear bind-time error instead of only discovering
            // the problem at CLR verification.
            if (explicitTypeArgs != null
                && TryReportGenericValueTypeBaseConstraintViolation(classSymbol.ClassType, methodName, explicitTypeArgs, typeArgSymbols, ce.Location))
            {
                return new BoundErrorExpression(null);
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
                var tpOverloads = MemberLookup.CollectSourceInstanceMethods(tpRecv, methodName);
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
                var tpClassOverloads = MemberLookup.CollectSourceInstanceMethods(tpClassRecv, methodName);
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
                var userOverloads = MemberLookup.CollectSourceInstanceMethods(userClass, methodName);
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
            // Issue #2210: use the transitive walk (issue #1582) rather than
            // only `inheritedDerived`'s own ImportedBaseType, so a metadata
            // base reached through one or more intermediate G#-defined base
            // classes (`class C : B` where `B : SomeImportedBase`) still
            // surfaces its inherited methods, matching how field/property
            // access already walks the chain.
            // Issue #2218 follow-up: only surface `protected`/`protected
            // internal` inherited members when `receiver` IS the current
            // implicit/explicit `this` — this path (BindAccessorCall) also
            // handles an arbitrary qualified `receiver.Method(...)` call, so
            // without this check protected inherited members would be
            // callable through any receiver expression, leaking accessibility.
            var allowProtectedInherited = IsCurrentThisReceiver(receiver);
            if (receiver != null && receiver.Type is StructSymbol inheritedDerived
                && (GetInheritedClrBaseType(inheritedDerived) ?? typeof(object)) is System.Type inheritedBaseClr
                && TryBindInheritedClrInstanceCall(receiver, inheritedBaseClr, methodName, arguments, ce, out var inheritedCall, explicitTypeArgs, typeArgSymbols, argumentNames, allowProtectedInherited: allowProtectedInherited))
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
            // Enum members are all public, so protected admission stays off here.
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

            // Issue #1550: a value of ANY type parameter is ultimately a
            // System.Object, so the universal object instance members
            // (ToString, GetHashCode, Equals(object), GetType) are callable on
            // any type-parameter receiver even when no constraint supplies them.
            // Runs AFTER the constraint-dispatch paths above (#1052 / #1056 /
            // #943) so a constraint that redeclares one of these names still
            // wins there. Emitted as a verifiable
            // `constrained. !!T  callvirt System.Object::Method(...)` sequence,
            // which dispatches to any override for value, struct/enum and
            // reference type parameters alike without a manual box.
            if (receiver != null && receiver.Type is TypeParameterSymbol tpObjRecv
                && TryBindConstrainedObjectMemberCall(receiver, tpObjRecv, methodName, arguments, ce, argumentNames, out var constrainedObjectCall))
            {
                return constrainedObjectCall;
            }

            // Issue #2304: a source-declared interface (`InterfaceSymbol`,
            // ClrType still null at bind time) implicitly derives from
            // `System.Object` for member-access purposes, exactly like the
            // type-parameter fallback just above. Run AFTER every
            // user/imported-interface member and extension lookup so a
            // same-named interface/extension member still wins.
            if (receiver != null && receiver.Type is InterfaceSymbol
                && TryBindInterfaceObjectMemberCall(receiver, methodName, arguments, ce, argumentNames, out var ifaceObjectCall))
            {
                return ifaceObjectCall;
            }

            Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
            return new BoundErrorExpression(null);
        }

        // Prefer a user-defined class method when the receiver is a user
        // class symbol that has one with this name. (BCL lookup is the
        // fallback for imported CLR types.)
        if (receiver.Type is StructSymbol userClassPriority)
        {
            var priorityOverloads = MemberLookup.CollectSourceInstanceMethods(userClassPriority, methodName);
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
        var candidates = new List<MethodInfo>(MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(clrType, methodName));

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
                    // Issue #2347: a bare method group (e.g. a static BCL
                    // method or another CLR method reference) passed to a
                    // generic static/instance method has no fixed CLR type
                    // until the target delegate parameter is known. Defer it
                    // like an untyped lambda — leave the argTypes slot null
                    // so applicability/generic inference proceed using the
                    // other arguments — instead of aborting the whole
                    // candidate set; it is resolved against the winning
                    // overload's parameter type afterwards by
                    // BindClrParameterConversions.
                    if (!OverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]))
                    {
                        argsAllTyped = false;
                        break;
                    }
                }

                if (arguments[i].Type is StructSymbol { IsClass: true })
                {
                    hasUserClassArg = true;
                }

                argTypes[i] = t;
            }

            if (argsAllTyped)
            {
                // Issue #658 / #1634: supplementary interface check for user-class
                // args, threaded as a call-local parameter into Resolve instead of
                // a shared static so nested/concurrent binds can't clobber it.
                Func<Type, Type, bool> supplementaryInterfaceCheck = hasUserClassArg
                    ? (source, target) => IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target)
                    : null;

                var resolution = OverloadResolution.Resolve(
                    candidates,
                    argTypes,
                    explicitTypeArgs,
                    scope.References.MapClrTypeToReferences,
                    ComputeInterpolatedStringArgFlags(ce.Arguments, arguments.Length),
                    argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames,
                    supplementaryInterfaceCheck: supplementaryInterfaceCheck,
                    constantNarrowingArgumentCheck: MakeConstantNarrowingArgumentCheck(arguments),
                    structuralProjectionArgumentCheck: MakeStructuralProjectionArgumentCheck(arguments));
                switch (resolution.Outcome)
                {
                    case OverloadResolution.ResolutionOutcome.Resolved:
                        // Issue #2193: a CLR/imported instance method that shares a
                        // name with a user extension function must not automatically
                        // win overload resolution when it is only applicable through
                        // a lossy delegate-reshaping conversion (e.g. a G# function
                        // value `(T) -> TResult` discarding its result to satisfy a
                        // named void delegate parameter like
                        // `SynchronizationContext.Send(SendOrPostCallback, object)`)
                        // while an in-scope user extension is a strictly better
                        // (identity/standard) match. Merge the user-extension
                        // candidate set into the decision and prefer the extension
                        // when it is strictly better; instance methods that are a
                        // good (non-reshaping) match still win unconditionally.
                        if (receiver != null
                            && TryPreferBetterExtensionOverClrInstanceMethod(receiver, methodName, resolution.Best, argTypes, arguments, ce, argumentNames, out var betterExtensionCall))
                        {
                            return betterExtensionCall;
                        }

                        // Issue #977: now that the overload is chosen, re-bind
                        // any inline `out var`/`out let`/`out _` placeholders
                        // against the resolved by-ref parameter so the new
                        // local is declared with the inferred pointee type.
                        arguments = RebindInlineOutVarArguments(ce, arguments, resolution.Best, resolution.ParameterMapping, receiver?.Type, typeArgSymbols);

                        // Issue #1512: for a genuine INSTANCE method the receiver
                        // is `this`, not a formal parameter — `GetParameters()`
                        // excludes it. The method-type-argument inference vector
                        // must therefore align with the method's parameters and
                        // must NOT carry the receiver as slot 0 (unlike the
                        // extension-method path, where the receiver IS param 0).
                        // Including it shifted every real argument by one slot, so
                        // a method type parameter inferable only from a lambda
                        // argument (e.g. `TResult` of
                        // `Task.ContinueWith<TResult>(Func<Task,TResult>)`) was
                        // never unified and the call collapsed to `<object>`. The
                        // receiver still drives return-type Var substitution via
                        // `ResolveCallReturnTypeFromSymbolicTypeArgs` below.
                        var instSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(null, ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
                        var instSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(resolution.Best, typeArgSymbols, instSymbolicArgs);
                        var instTypeArgSymbolsForCall = !instSymbolicTypeArgs.IsDefault ? instSymbolicTypeArgs : typeArgSymbols;
                        var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols)
                            ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(resolution.Best, instSymbolicTypeArgs, effectiveReceiverType)
                            ?? ResolveInstanceReturnTypeFromReceiver(effectiveReceiverType, resolution.Best)
                            ?? MapClrMethodReturnType(resolution.Best);
                        var instParameters = resolution.Best.GetParameters();
                        var instMapping = resolution.ParameterMapping;
                        var instExpandedArgs = resolution.IsExpanded
                            ? overloads.ExpandParamsArguments(arguments, instParameters, ce, parameterMapping: instMapping)
                            : arguments;
                        var instDownstreamMapping = resolution.IsExpanded ? default : instMapping;

                        // Issue #1638: shared CLR call-argument-construction
                        // pipeline (interpolation rebind → handler args →
                        // delegate rebind → parameter conversions).
                        var instConvertedArgs = BuildResolvedClrCallArguments(
                            instExpandedArgs,
                            ce.Arguments,
                            instParameters,
                            instDownstreamMapping,
                            receiver,
                            ce.Location,
                            ce,
                            ClrCallDelegateRebindMode.Full,
                            out var instHandlerPrelude,
                            out var instUpdatedReceiver,
                            method: resolution.Best,
                            symbolicMethodTypeArgs: instTypeArgSymbolsForCall,
                            receiverType: effectiveReceiverType,
                            hasConversionReceiverTypeOverride: true,
                            conversionReceiverType: receiver?.Type);
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

        // Issue #2304: an imported interface (`ImportedTypeSymbol` whose
        // `ClrType.IsInterface` is true) implicitly derives from
        // `System.Object` for member-access purposes. `Type.GetMethods()` on
        // an interface type never reports Object's members (only the
        // interface's own transitive base interfaces are walked above), so
        // ToString/GetHashCode/Equals/GetType otherwise dead-end here. Run
        // AFTER every instance/extension lookup so a same-named member still
        // wins.
        if (clrType is { IsInterface: true }
            && TryBindInterfaceObjectMemberCall(receiver, methodName, arguments, ce, argumentNames, out var importedIfaceObjectCall))
        {
            return importedIfaceObjectCall;
        }

        Diagnostics.ReportUnableToFindFunction(ce.Location, methodName);
        return new BoundErrorExpression(null);
    }
}
