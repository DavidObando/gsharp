// <copyright file="ExpressionBinder.Calls.Regular.3.cs" company="GSharp">
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
    /// Issue #296: resolves an instance method call against an imported CLR
    /// base class for a GSharp class receiver that inherits it. Uses the same
    /// overload resolution as direct imported-instance calls; <c>GetMethods</c>
    /// on the base type already includes members inherited up the CLR chain.
    /// Returns <c>true</c> with a bound call when a unique match is found.
    /// </summary>
    internal bool TryBindInheritedClrInstanceCall(
        BoundExpression receiver,
        System.Type importedBaseClr,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result,
        System.Type[] explicitTypeArgs = null,
        ImmutableArray<TypeSymbol> typeArgSymbols = default,
        ImmutableArray<string> argumentNames = default,
        bool mapEnumArgumentsToBaseClr = false)
    {
        result = null;

        var candidates = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(importedBaseClr, methodName);
        if (candidates.Count == 0)
        {
            return false;
        }

        return TryResolveAndBindClrInstanceCall(receiver, candidates, importedBaseClr, methodName, arguments, ce, out result, explicitTypeArgs, typeArgSymbols, argumentNames, mapEnumArgumentsToBaseClr);
    }

    /// <summary>
    /// Issue #1181: resolves an instance method call against the imported/BCL
    /// base interfaces of a user interface receiver. A user interface
    /// <c>interface IBox : IDisposable</c> has a null <c>ClrType</c>, so the
    /// regular imported-instance walks find nothing; this projects every
    /// transitive imported base interface's public instance methods onto the
    /// receiver (matching how user-base-interface members are surfaced) and
    /// runs the shared overload resolution. The emitted
    /// <see cref="BoundImportedInstanceCallExpression"/> dispatches via
    /// <c>callvirt</c> on the imported interface method, which is verifiable
    /// because <c>IBox</c> carries an InterfaceImpl row to each imported base.
    /// Runs only after user member-table lookup fails, so user-declared
    /// interface members keep priority.
    /// </summary>
    /// <param name="receiver">The interface-typed receiver expression.</param>
    /// <param name="interfaceSymbol">The user interface symbol of the receiver.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound call arguments.</param>
    /// <param name="ce">The call syntax (for diagnostics/locations).</param>
    /// <param name="result">The bound call on success, or an error node on ambiguity.</param>
    /// <param name="explicitTypeArgs">Explicit CLR type arguments, when present.</param>
    /// <param name="typeArgSymbols">Explicit symbolic type arguments, when present.</param>
    /// <param name="argumentNames">Named-argument labels, when present.</param>
    /// <returns>True when the call resolved (or reported a precise ambiguity).</returns>
    internal bool TryBindInterfaceImportedBaseInstanceCall(
        BoundExpression receiver,
        InterfaceSymbol interfaceSymbol,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result,
        System.Type[] explicitTypeArgs = null,
        ImmutableArray<TypeSymbol> typeArgSymbols = default,
        ImmutableArray<string> argumentNames = default)
    {
        result = null;

        var clrBases = MemberLookup.GetTransitiveClrBaseInterfaces(interfaceSymbol);
        if (clrBases.Count == 0)
        {
            return false;
        }

        var candidates = new List<MethodInfo>();
        foreach (var clrBase in clrBases)
        {
            foreach (var m in ClrTypeUtilities.SafeGetMethods(clrBase, BindingFlags.Instance | BindingFlags.Public))
            {
                if (string.Equals(m.Name, methodName, System.StringComparison.Ordinal)
                    && !MemberLookup.HasSameSignature(candidates, m))
                {
                    candidates.Add(m);
                }
            }
        }

        if (candidates.Count == 0)
        {
            return false;
        }

        return TryResolveAndBindClrInstanceCall(receiver, candidates, importedBaseClr: clrBases[0], methodName, arguments, ce, out result, explicitTypeArgs, typeArgSymbols, argumentNames);
    }

    /// <summary>
    /// Issue #296 / #1181: shared overload-resolution + bound-call construction
    /// core for an imported-instance method call against a pre-collected
    /// <paramref name="candidates"/> set. Factored out of
    /// <see cref="TryBindInheritedClrInstanceCall"/> so the inherited-base-class
    /// path and the user-interface imported-base path share one implementation.
    /// </summary>
    /// <param name="receiver">The receiver expression.</param>
    /// <param name="candidates">The candidate CLR methods.</param>
    /// <param name="importedBaseClr">A representative CLR type for named-argument diagnostics.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound call arguments.</param>
    /// <param name="ce">The call syntax.</param>
    /// <param name="result">The bound call on success.</param>
    /// <param name="explicitTypeArgs">Explicit CLR type arguments, when present.</param>
    /// <param name="typeArgSymbols">Explicit symbolic type arguments, when present.</param>
    /// <param name="argumentNames">Named-argument labels, when present.</param>
    /// <param name="mapEnumArgumentsToBaseClr">When <see langword="true"/>, enum-typed arguments resolve as the inherited base CLR type (<c>System.Enum</c>) instead of their erased underlying primitive, so members such as <c>HasFlag(System.Enum)</c> match.</param>
    /// <param name="nonVirtualBaseCall">Issue #1260: when <see langword="true"/>, the resolved call is a <c>base.M(...)</c> access into an imported/BCL base and is flagged so the emitter writes a non-virtual <c>call</c>; an <c>abstract</c> best match is reported as GS0413.</param>
    /// <param name="baseMemberLocation">Issue #1260: the location of the member identifier for the GS0413 abstract-base diagnostic (used only when <paramref name="nonVirtualBaseCall"/> is set).</param>
    /// <returns>True when the call resolved (or reported a precise ambiguity).</returns>
    private bool TryResolveAndBindClrInstanceCall(
        BoundExpression receiver,
        IReadOnlyList<MethodInfo> candidates,
        System.Type importedBaseClr,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        out BoundExpression result,
        System.Type[] explicitTypeArgs,
        ImmutableArray<TypeSymbol> typeArgSymbols,
        ImmutableArray<string> argumentNames,
        bool mapEnumArgumentsToBaseClr = false,
        bool nonVirtualBaseCall = false,
        TextLocation? baseMemberLocation = null)
    {
        result = null;

        var argTypes = new System.Type[arguments.Length];
        var hasUserClassArg = false;
        for (var i = 0; i < arguments.Length; i++)
        {
            // Issue #1218: when resolving an inherited call against System.Enum
            // (e.g. HasFlag(System.Enum)), an enum-typed argument is the boxed
            // System.Enum the parameter expects. The default mapping erases an
            // enum to its underlying int32 (issue #661), which would not match a
            // System.Enum parameter, so map it to the base CLR type instead.
            if (mapEnumArgumentsToBaseClr && arguments[i].Type is EnumSymbol)
            {
                argTypes[i] = importedBaseClr;
                continue;
            }

            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            // Issue #658: use overload-resolution variant for user classes.
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                return false;
            }

            if (arguments[i].Type is StructSymbol { IsClass: true })
            {
                hasUserClassArg = true;
            }

            argTypes[i] = t;
        }

        // Issue #658: set up supplementary interface check for user-class args.
        if (hasUserClassArg)
        {
            OverloadResolution.SupplementaryInterfaceCheck = (source, target) =>
                IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target);
        }

        OverloadResolution.Result<MethodInfo> resolution;
        try
        {
            OverloadResolution.ConstantNarrowingArgumentCheck = MakeConstantNarrowingArgumentCheck(arguments);
            resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences, argumentNames: argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
        }
        finally
        {
            if (hasUserClassArg)
            {
                OverloadResolution.SupplementaryInterfaceCheck = null;
            }

            OverloadResolution.ConstantNarrowingArgumentCheck = null;
        }

        switch (resolution.Outcome)
        {
            case OverloadResolution.ResolutionOutcome.Resolved:
                // Issue #1260: a `base.M(...)` into an abstract BCL member has no
                // base implementation to delegate to (e.g. Stream.Read). Match C#
                // (CS0205) with a clean diagnostic instead of emitting invalid IL.
                if (nonVirtualBaseCall && resolution.Best.IsAbstract)
                {
                    Diagnostics.ReportBaseClassCallAbstractMember(baseMemberLocation ?? ce.Location, importedBaseClr?.Name ?? "object", methodName);
                    result = new BoundErrorExpression(null);
                    return true;
                }

                var inheritedSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(receiver?.Type, ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
                var inheritedSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(resolution.Best, typeArgSymbols, inheritedSymbolicArgs);
                var inheritedTypeArgSymbolsForCall = !inheritedSymbolicTypeArgs.IsDefault ? inheritedSymbolicTypeArgs : typeArgSymbols;
                var returnType = ResolveImportedGenericReturnType(resolution.Best, typeArgSymbols)
                    ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(resolution.Best, inheritedSymbolicTypeArgs, receiver?.Type)
                    ?? ResolveInstanceReturnTypeFromReceiver(receiver?.Type, resolution.Best)
                    ?? TypeSymbol.FromClrType(resolution.Best.ReturnType);
                var inheritedParameters = resolution.Best.GetParameters();
                var inheritedMapping = resolution.ParameterMapping;
                var inheritedExpandedArgs = resolution.IsExpanded
                    ? overloads.ExpandParamsArguments(arguments, inheritedParameters, ce, parameterMapping: inheritedMapping)
                    : arguments;
                var inheritedDownstreamMapping = resolution.IsExpanded ? default : inheritedMapping;
                var inheritedHandlerArgs = ApplyInterpolatedStringHandlers(inheritedParameters, inheritedExpandedArgs, receiver, ce.Location, inheritedDownstreamMapping, out var inheritedHandlerPrelude, out var inheritedUpdatedReceiver);
                var inheritedDelegateArgs = RebindFunctionLiteralDelegateArguments(inheritedHandlerArgs, inheritedParameters, inheritedDownstreamMapping);
                var inheritedConvertedArgs = conversions.BindClrParameterConversions(inheritedDelegateArgs, inheritedParameters, ce, inheritedDownstreamMapping);
                var inheritedArguments = OverloadResolver.BuildOrderedCallArguments(inheritedConvertedArgs, inheritedDownstreamMapping, inheritedParameters);
                var refKinds = ComputeArgumentRefKinds(inheritedParameters);
                overloads.ValidateRefArguments(inheritedArguments, refKinds, methodName, ce.Location);
                BoundExpression inheritedCall = new BoundImportedInstanceCallExpression(null, inheritedUpdatedReceiver ?? receiver, resolution.Best, returnType, inheritedArguments, refKinds, inheritedTypeArgSymbolsForCall, isNonVirtualBaseCall: nonVirtualBaseCall);
                result = WrapWithHandlerPrelude(inheritedCall, inheritedHandlerPrelude, ce);
                return true;
            case OverloadResolution.ResolutionOutcome.Ambiguous:
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                result = new BoundErrorExpression(null);
                return true;
            default:
                // Issue #343: if the failure is plausibly due to an unknown
                // named-argument target, surface that as the diagnostic.
                if (!argumentNames.IsDefault
                    && overloads.TryReportUnknownNamedArgumentForClr(importedBaseClr, methodName, BindingFlags.Instance | BindingFlags.Public, ce, argumentNames))
                {
                    result = new BoundErrorExpression(null);
                    return true;
                }

                return false;
        }
    }

    /// <summary>
    /// Issue #294: resolves a call written with instance ("receiver") syntax
    /// against an imported CLR static method marked with
    /// <c>[System.Runtime.CompilerServices.ExtensionAttribute]</c> whose first
    /// parameter is compatible with the receiver's type. This makes BCL/library
    /// extension methods (LINQ <c>Where</c>/<c>Select</c>/<c>ToList</c>, the
    /// ASP.NET Core minimal-API/middleware surface, etc.) callable as
    /// <c>receiver.Method(args)</c> rather than only statically as
    /// <c>DeclaringClass.Method(receiver, args)</c>.
    /// </summary>
    /// <param name="receiver">The bound receiver expression.</param>
    /// <param name="methodName">The method name at the call site.</param>
    /// <param name="arguments">The bound user arguments (excluding the receiver).</param>
    /// <param name="ce">The originating call expression.</param>
    /// <param name="result">The bound call when resolution succeeds (or a bound error on ambiguity).</param>
    /// <param name="explicitTypeArgs">Issue #311: resolved explicit type arguments from a <c>[T1, T2]</c> list, or <c>null</c> for inference.</param>
    /// <param name="typeArgSymbols">Issue #320: explicit type-argument symbols in source order (carrying user-defined types), or default.</param>
    /// <param name="argumentNames">Issue #343: per-source-argument names parallel to <paramref name="arguments"/> (entries are <see langword="null"/> for positional); default when the call is purely positional.</param>
    /// <returns>True when an imported extension method was matched (success or ambiguity); false to let the caller report GS0159.</returns>
    private bool TryBindImportedExtensionCall(BoundExpression receiver, string methodName, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, out BoundExpression result, System.Type[] explicitTypeArgs = null, ImmutableArray<TypeSymbol> typeArgSymbols = default, ImmutableArray<string> argumentNames = default)
    {
        result = null;

        var receiverClrType = receiver?.Type?.ClrType;
        if (receiverClrType == null)
        {
            // Issue #833: a slice/sequence of an open method type parameter
            // (e.g. `[]T{}.ToArray()` inside `func F[T]()`) has no CLR
            // backing on the receiver. Project it to an erased shape so
            // overload resolution can run; symbolic recovery happens via
            // BuildSymbolicMethodTypeArgs + ResolveCallReturnTypeFromSymbolicTypeArgs.
            if (receiver?.Type == null || !MemberLookup.TryProjectErasedClrType(receiver.Type, out receiverClrType))
            {
                return false;
            }
        }

        // Build the argument-type vector as the extension method sees it: the
        // receiver becomes the first ("this") parameter, followed by the user
        // arguments. Every argument must carry a concrete CLR type so overload
        // resolution (including generic inference) can run.
        var argTypes = new Type[arguments.Length + 1];
        argTypes[0] = receiverClrType;
        var hasUserClassArg = false;
        for (var i = 0; i < arguments.Length; i++)
        {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            // Issue #658: use overload-resolution variant for user classes.
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                // Issue #833: argument may carry an open TP (e.g. `T`,
                // `[]T`). Project to an erased shape so resolution can run.
                if (!MemberLookup.TryProjectErasedClrType(arguments[i].Type, out t))
                {
                    return false;
                }
            }

            if (arguments[i].Type is StructSymbol { IsClass: true })
            {
                hasUserClassArg = true;
            }

            argTypes[i + 1] = t;
        }

        // Issue #343: extension methods are dispatched as `Class.Method(receiver, userArgs...)`,
        // so prepend a null slot to user-supplied argument names so positions
        // align with the method's parameter list (where index 0 is `this`).
        IReadOnlyList<string> extensionArgumentNames = null;
        if (!argumentNames.IsDefault)
        {
            var withReceiver = new string[arguments.Length + 1];
            for (var i = 0; i < arguments.Length; i++)
            {
                withReceiver[i + 1] = argumentNames[i];
            }

            extensionArgumentNames = withReceiver;
        }

        var candidates = this.memberLookup.CollectImportedExtensionMethods(methodName);
        if (candidates.Count == 0)
        {
            return false;
        }

        // OverloadResolution.Resolve infers type arguments for open generic
        // method definitions (e.g. Where<TSource>(IEnumerable<TSource>,
        // Func<TSource,bool>)) from the receiver and argument types. Issue #311:
        // when the call site supplied explicit type arguments (e.g.
        // services.AddSingleton[IService, Service]()), those are used to close
        // the generic method instead of inference.
        // Issue #658: set up supplementary interface check for user-class args.
        if (hasUserClassArg)
        {
            OverloadResolution.SupplementaryInterfaceCheck = (source, target) =>
                IsUserClassAssignableToInterfaceFromArgs(arguments, argTypes, source, target);
        }

        OverloadResolution.Result<MethodInfo> resolution;
        try
        {
            // Issue #1311: imported extension calls dispatch as
            // `Class.Method(this receiver, args…)`, so argTypes slot 0 is the
            // receiver and user argument `i` lives at slot `i + 1`.
            OverloadResolution.ConstantNarrowingArgumentCheck = MakeConstantNarrowingArgumentCheck(arguments, argumentOffset: 1);
            resolution = OverloadResolution.Resolve(candidates, argTypes, explicitTypeArgs, scope.References.MapClrTypeToReferences, argumentNames: extensionArgumentNames);
        }
        finally
        {
            if (hasUserClassArg)
            {
                OverloadResolution.SupplementaryInterfaceCheck = null;
            }

            OverloadResolution.ConstantNarrowingArgumentCheck = null;
        }

        switch (resolution.Outcome)
        {
            case OverloadResolution.ResolutionOutcome.Resolved:
                break;
            case OverloadResolution.ResolutionOutcome.Ambiguous:
                Diagnostics.ReportAmbiguousOverload(ce.Location, methodName, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                result = new BoundErrorExpression(null);
                return true;
            default:
                return false;
        }

        var best = resolution.Best;
        var declaringType = best.DeclaringType;
        if (declaringType == null)
        {
            return false;
        }

        var importedClass = new ImportedClassSymbol(declaringType, ce);

        // Issue #833: for an extension call the symbolic-argument vector
        // includes the receiver as slot 0 to mirror the static-dispatch
        // shape (`Class.Method(this receiver, args…)`). The inferred
        // method-type-args may then surface a symbolic return like
        // `[]T` from `[]T{}.ToArray()` instead of the erased
        // `object[]`.
        var extensionSymbolicArgs = MemberLookup.BuildSymbolicArgTypeVector(receiver?.Type, ImmutableArray.CreateRange(arguments.Select(a => a?.Type)));
        var extensionSymbolicTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(best, typeArgSymbols, extensionSymbolicArgs);
        var extensionTypeArgSymbolsForCall = !extensionSymbolicTypeArgs.IsDefault ? extensionSymbolicTypeArgs : typeArgSymbols;
        var returnOverride = ResolveImportedGenericReturnType(best, typeArgSymbols)
            ?? MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(best, extensionSymbolicTypeArgs, receiver?.Type);
        var function = new ImportedFunctionSymbol(methodName, importedClass, best, ce, returnOverride);

        var allArguments = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length + 1);
        allArguments.Add(receiver);
        allArguments.AddRange(arguments);
        var bound = allArguments.MoveToImmutable();

        // Issue #506: when overload resolution selected the expanded form of a
        // `params T[]` extension method (e.g. `MyEnumerable.Concat(this src,
        // params string[] tail)` called with positional tail args), pack the
        // trailing positional arguments into a synthesised slice/array first.
        // The receiver occupies parameter slot 0; the params slot is always
        // the last parameter, so it never collides with the receiver. Named
        // arguments against an expanded-form extension are funnelled through
        // an offset mapping so the receiver position lines up with bound[0].
        var parameters = best.GetParameters();
        if (resolution.IsExpanded)
        {
            ImmutableArray<int> expandedMapping = default;
            if (!resolution.ParameterMapping.IsDefault)
            {
                var offset = ImmutableArray.CreateBuilder<int>(bound.Length);
                offset.Add(0);
                for (var i = 0; i < resolution.ParameterMapping.Length; i++)
                {
                    offset.Add(resolution.ParameterMapping[i]);
                }

                expandedMapping = offset.MoveToImmutable();
            }

            bound = overloads.ExpandParamsArguments(bound, parameters, ce, receiverArgCount: 1, parameterMapping: expandedMapping);
        }

        var downstreamMapping = resolution.IsExpanded ? default : resolution.ParameterMapping;

        // Issue #1150: reshape a func/arrow literal argument whose natural
        // numeric return type implicitly, losslessly widens to the resolved
        // parameter's delegate return type (e.g. a `uint32`-returning selector
        // flowing into `Sum`'s `Func<T,long>` overload) so the produced delegate
        // is created over a method whose return type already matches the target
        // — inserting the numeric return-widening conversion in the body. Only
        // the return is widened; the literal's concrete parameter types are
        // preserved (so non-widening selectors such as `Where`/`Single`/`Select`
        // are left untouched and value-type selectors are not erased to object).
        // The bound vector is [receiver, args…] aligned with the method's
        // parameter list (receiver at slot 0), matching the mapping used below.
        bound = RebindNumericReturnWideningDelegateArguments(bound, parameters, downstreamMapping);

        // Issue #506 follow-up: route through BindClrParameterConversions so
        // value-type → object boxing fires for fixed-arity imported extension
        // calls too. The receiver occupies arg slot 0 (and is already typed
        // correctly via the extension dispatch).
        bound = conversions.BindClrParameterConversions(bound, parameters, ce, downstreamMapping, receiverArgCount: 1);

        // Issue #327 / #343: re-order arguments into parameter positions when
        // named arguments were used; otherwise fall through to the existing
        // trailing-optional fill.
        bound = OverloadResolver.BuildOrderedCallArguments(bound, downstreamMapping, parameters);

        var refKinds = ComputeArgumentRefKinds(parameters);
        overloads.ValidateRefArguments(bound, refKinds, methodName, ce.Location);
        result = new BoundImportedCallExpression(null, function, bound, refKinds, extensionTypeArgSymbolsForCall);
        return true;
    }

    /// <summary>
    /// Issue #658: determines whether a user-defined G# class argument (identified
    /// by its surrogate CLR type in <paramref name="argTypes"/>) implements the
    /// specified CLR <paramref name="target"/> interface. Used as the
    /// <see cref="OverloadResolution.SupplementaryInterfaceCheck"/> callback during
    /// overload resolution for calls that include user-class arguments.
    /// </summary>
    private static bool IsUserClassAssignableToInterface(
        ImmutableArray<BoundExpression>.Builder boundArguments,
        System.Type[] argTypes,
        System.Type source,
        System.Type target)
    {
        for (var i = 0; i < boundArguments.Count; i++)
        {
            if (!ReferenceEquals(argTypes[i], source))
            {
                continue;
            }

            if (boundArguments[i].Type is StructSymbol { IsClass: true } ss)
            {
                if (UserClassImplementsInterface(ss, target))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #658: checks whether a user-defined G# class (or any of its base
    /// classes) declares implementation of the specified CLR interface.
    /// </summary>
    private static bool UserClassImplementsInterface(StructSymbol ss, System.Type target)
    {
        for (var current = ss; current != null; current = current.BaseClass)
        {
            foreach (var iface in current.ImplementedClrInterfaces)
            {
                if (iface.ClrType == null)
                {
                    continue;
                }

                // Direct match: the implemented interface IS the target.
                if (ClrTypeUtilities.AreSame(iface.ClrType, target))
                {
                    return true;
                }

                // The implemented interface itself inherits from the target.
                if (ClrTypeUtilities.ImplementsInterfaceByName(iface.ClrType, target))
                {
                    return true;
                }
            }
        }

        // Also check the imported CLR base type (if any) — it may implement
        // the target interface.
        if (ss.ImportedBaseType?.ClrType != null
            && ClrTypeUtilities.ImplementsInterfaceByName(ss.ImportedBaseType.ClrType, target))
        {
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #658: variant of <see cref="IsUserClassAssignableToInterface"/> that
    /// works with <see cref="ImmutableArray{T}"/> arguments (used by instance
    /// method call paths).
    /// </summary>
    private static bool IsUserClassAssignableToInterfaceFromArgs(
        ImmutableArray<BoundExpression> boundArguments,
        System.Type[] argTypes,
        System.Type source,
        System.Type target)
    {
        for (var i = 0; i < boundArguments.Length; i++)
        {
            if (!ReferenceEquals(argTypes[i], source))
            {
                continue;
            }

            if (boundArguments[i].Type is StructSymbol { IsClass: true } ss)
            {
                if (UserClassImplementsInterface(ss, target))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0091 / issue #757: bind an explicit-base interface call
    /// <c>base[IFoo].M(args)</c>. Validates that:
    /// <list type="number">
    ///   <item>the enclosing function is an instance member of a class or struct,</item>
    ///   <item>the interface resolves and is in the enclosing type's interface set (GS0338),</item>
    ///   <item>the named member exists on the interface (GS0339),</item>
    ///   <item>the member has a default body (GS0340), and</item>
    ///   <item>the member is not a <c>private</c> helper (GS0341 — preserves ADR-0090).</item>
    /// </list>
    /// On success, returns a <see cref="BoundBaseInterfaceCallExpression"/>
    /// whose receiver is the enclosing method's <c>this</c> parameter.
    /// </summary>
    private BoundExpression BindBaseInterfaceCallExpression(BaseInterfaceCallExpressionSyntax syntax)
    {
        // Resolve the selector inside the brackets first. Issue #986: when it
        // names a base CLASS instead of an interface, route to the base-class
        // call form so `base[BaseClass].M(args)` works as an alternative
        // spelling of `base.M(args)` — binding arguments there (not here) so
        // they are not bound twice. Type-clause binding already reports the
        // relevant "type not found" diagnostic (GS0046) when resolution fails.
        var ifaceType = bindTypeClause(syntax.InterfaceTypeClause);
        if (ifaceType is null || ifaceType == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        // Issue #1104: the parenthesis-less PROPERTY form `base[BaseClass].Prop`
        // (read) and `base[BaseClass].Prop = value` (write). Route to the shared
        // base-class property read/write path with the explicit ancestor
        // selector so resolution + GS0383/GS0384/GS0385 diagnostics + non-virtual
        // `call instance ... <SelectorBase>::get_/set_Prop` emission all reuse
        // the same code as plain `base.Prop`. A base-class selector is required;
        // an interface selector in this position is not a supported form and is
        // reported via the member-not-found path below by falling through to the
        // call handling (which yields a clear diagnostic).
        if (syntax.IsPropertyAccess && ifaceType is StructSymbol propSelector && propSelector.IsClass)
        {
            if (syntax.IsPropertyWrite)
            {
                var boundValue = BindExpression(syntax.Value);
                return BindBaseClassPropertyWrite(
                    syntax.MethodIdentifier.Text,
                    syntax.MethodIdentifier.Location,
                    syntax.BaseKeyword.Location,
                    boundValue,
                    syntax.Value.Location,
                    syntax.EqualsToken.Location,
                    explicitBaseType: propSelector,
                    selectorLocation: syntax.InterfaceTypeClause.Location);
            }

            var memberName = new NameExpressionSyntax(syntax.SyntaxTree, syntax.MethodIdentifier);
            return BindBaseClassPropertyRead(
                memberName,
                syntax.BaseKeyword.Location,
                explicitBaseType: propSelector,
                selectorLocation: syntax.InterfaceTypeClause.Location);
        }

        if (ifaceType is StructSymbol classSelector && classSelector.IsClass)
        {
            var synthesizedCall = new CallExpressionSyntax(
                syntax.SyntaxTree,
                syntax.MethodIdentifier,
                syntax.MethodTypeArgumentList,
                syntax.OpenParenthesisToken,
                syntax.Arguments,
                syntax.CloseParenthesisToken);
            return BindBaseClassCall(
                synthesizedCall,
                syntax.BaseKeyword.Location,
                classSelector,
                syntax.InterfaceTypeClause.Location);
        }

        // Bind the user arguments unconditionally — even on the failure paths
        // below we want any nested binder diagnostics (unknown name in arg
        // position, etc.) to surface in the same pass.
        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Arguments.Count);
        for (var i = 0; i < syntax.Arguments.Count; i++)
        {
            boundArguments.Add(BindExpression(syntax.Arguments[i]));
        }

        // The selector must denote an interface.
        if (ifaceType is not InterfaceSymbol ifaceSym)
        {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.InterfaceTypeClause.Location,
                EnclosingTypeDisplayName(),
                ifaceType.Name);
            return new BoundErrorExpression(null);
        }

        // The call site must live in an instance member of a class/struct
        // that implements `ifaceSym`. A top-level function, a `shared` static,
        // or a generic-typeparameter-receiver call all fail this test.
        var enclosingType = function?.ReceiverType as StructSymbol;
        if (enclosingType == null || function?.ThisParameter == null)
        {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.BaseKeyword.Location,
                "<top-level>",
                ifaceSym.Name);
            return new BoundErrorExpression(null);
        }

        if (!EnclosingTypeImplements(enclosingType, ifaceSym))
        {
            Diagnostics.ReportBaseInterfaceCallTypeDoesNotImplementInterface(
                syntax.InterfaceTypeClause.Location,
                enclosingType.Name,
                ifaceSym.Name);
            return new BoundErrorExpression(null);
        }

        // Generic-method type arguments on the selector are reserved for a
        // future ADR-0091 follow-up — reject for now with the "member is
        // abstract"-shaped diagnostic name so users get a clear pointer.
        if (syntax.MethodTypeArgumentList != null)
        {
            Diagnostics.ReportBaseInterfaceCallMemberNotFound(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                syntax.MethodIdentifier.Text + "[…]");
            return new BoundErrorExpression(null);
        }

        var methodName = syntax.MethodIdentifier.Text;

        // Private helpers (ADR-0090) are intentionally invisible to
        // implementers; calling one through base[IFoo] would defeat that
        // encapsulation. Check first so the diagnostic distinguishes the
        // private case from a generic "no such member".
        var privateMatches = ifaceSym.GetPrivateMethods(methodName);
        if (privateMatches.Length > 0)
        {
            Diagnostics.ReportBaseInterfaceCallTargetsPrivateHelper(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName);
            return new BoundErrorExpression(null);
        }

        // Look up the named method on the interface's public contract. Pick
        // the overload whose callable arity matches the call site; if no
        // overload matches at all, fall back to "member not found" — when
        // overload-by-arity finds a match but its body is abstract, fall to
        // GS0340 below. For a constructed generic interface, the method we
        // find is the substituted one; we map it back to its open definition
        // (preserved on InterfaceSymbol.Definition.Methods at the same
        // index) so the emitter and interpreter can resolve through the
        // single MethodHandles / program.Functions slot.
        FunctionSymbol arityMatch = null;
        FunctionSymbol anyMatch = null;
        int matchIndex = -1;
        var overloads = ifaceSym.Methods;
        for (var i = 0; i < overloads.Length; i++)
        {
            var candidate = overloads[i];
            if (candidate.Name != methodName)
            {
                continue;
            }

            anyMatch = candidate;
            var calleeOffset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
            var callableParameterCount = candidate.Parameters.Length - calleeOffset;
            if (callableParameterCount == boundArguments.Count)
            {
                arityMatch = candidate;
                matchIndex = i;
                break;
            }
        }

        if (anyMatch == null)
        {
            Diagnostics.ReportBaseInterfaceCallMemberNotFound(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName);
            return new BoundErrorExpression(null);
        }

        if (arityMatch == null)
        {
            // Member exists but no overload accepts this many arguments;
            // report a wrong-arg-count diagnostic against the first overload
            // for ergonomic recovery (the user will fix the arg count and
            // re-bind).
            var calleeOffset = anyMatch.ExplicitReceiverParameter == null ? 0 : 1;
            var callableParameterCount = anyMatch.Parameters.Length - calleeOffset;
            Diagnostics.ReportWrongArgumentCount(syntax.MethodIdentifier.Location, methodName, callableParameterCount, boundArguments.Count);
            return new BoundErrorExpression(null);
        }

        // Map the substituted method on a constructed generic interface back
        // to its open MethodDef slot (cache.MethodHandles is keyed on the
        // open definition). CreateConstructed preserves declaration order
        // 1:1, so the same index identifies the open slot.
        var openMethod = arityMatch;
        if (ifaceSym.Definition != null && !ReferenceEquals(ifaceSym.Definition, ifaceSym) && matchIndex >= 0 && matchIndex < ifaceSym.Definition.Methods.Length)
        {
            openMethod = ifaceSym.Definition.Methods[matchIndex];
        }

        if (!InterfaceSymbol.HasDefaultBody(openMethod))
        {
            Diagnostics.ReportBaseInterfaceCallMemberIsAbstract(
                syntax.MethodIdentifier.Location,
                ifaceSym.Name,
                methodName);
            return new BoundErrorExpression(null);
        }

        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        return new BoundBaseInterfaceCallExpression(
            syntax,
            receiver,
            ifaceSym,
            openMethod,
            boundArguments.ToImmutable());
    }

    /// <summary>
    /// ADR-0091 / issue #757: returns true when <paramref name="enclosingType"/>
    /// (or any of its base classes) appears in <paramref name="ifaceSym"/>'s
    /// implementer set. Constructed generic interfaces compare by
    /// <see cref="InterfaceSymbol.Definition"/> identity to allow
    /// <c>base[IFoo[int]]</c> from a class declared as <c>: IFoo[int]</c>.
    /// </summary>
    private static bool EnclosingTypeImplements(StructSymbol enclosingType, InterfaceSymbol ifaceSym)
    {
        var ifaceDef = ifaceSym.Definition ?? ifaceSym;
        for (var t = enclosingType; t != null; t = t.BaseClass)
        {
            foreach (var iface in t.Interfaces)
            {
                var candidateDef = iface.Definition ?? iface;
                if (ReferenceEquals(candidateDef, ifaceDef))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0091: produces a human-readable display name for the enclosing
    /// receiver type used in GS0338 messages. Falls back to a placeholder
    /// when the call site is not inside an instance member.
    /// </summary>
    private string EnclosingTypeDisplayName()
    {
        if (function?.ReceiverType is { } recv)
        {
            return recv.Name;
        }

        return "<top-level>";
    }
}
