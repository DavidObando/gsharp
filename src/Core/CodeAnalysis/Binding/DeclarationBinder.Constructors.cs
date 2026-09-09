// <copyright file="DeclarationBinder.Constructors.cs" company="GSharp">
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
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class DeclarationBinder
{
    /// <summary>
    /// Binds a class declaration's explicit <c>: Base(args)</c> initializer, or
    /// its implicit zero-argument base call when no <c>init</c> body owns that
    /// call. Resolution materializes omitted optional arguments, so the emitter
    /// calls the constructor that actually exists instead of inventing a
    /// parameterless MemberRef.
    /// </summary>
    private void BindBaseConstructorInitializer(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructSymbol? baseClassSymbol,
        TypeSymbol? importedBaseType,
        ImmutableArray<ParameterSymbol> primaryCtorParameters)
    {
        var hasImplicitBaseConstructorToResolve =
            importedBaseType != null
            || baseClassSymbol?.EffectiveExplicitConstructors.IsDefaultOrEmpty == false;
        if (!syntax.HasBaseConstructorArguments
            && ((!hasImplicitBaseConstructorToResolve)
                || (!syntax.Constructors.IsDefaultOrEmpty
                    && !structSymbol.HasPrimaryConstructor)))
        {
            return;
        }

        // Issue #1085: defer the actual argument binding and base-constructor
        // resolution until all declared types' explicit constructors exist.
        var capturedScope = scope;
        pendingBaseInitializerBindings.Add(() =>
        {
            var outerScope = scope;
            scope = capturedScope;

            // Issue #2342: re-establish this type's OWN owning package as the
            // ambient lookup preference (see field-initializer closure above
            // for the full rationale) for the duration of this deferred bind.
            var savedPackage = scope.SetCurrentDeclaringPackage(structSymbol.PackageName);
            var savedTree = scope.SetCurrentReferencingSyntaxTree(syntax.SyntaxTree);
            try
            {
                if (syntax.HasBaseConstructorArguments)
                {
                    BindBaseConstructorInitializerCore(syntax, structSymbol, baseClassSymbol, importedBaseType, primaryCtorParameters);
                }
                else
                {
                    BindImplicitBaseConstructorInitializer(syntax, structSymbol, baseClassSymbol, importedBaseType);
                }
            }
            finally
            {
                scope.SetCurrentDeclaringPackage(savedPackage);
                scope.SetCurrentReferencingSyntaxTree(savedTree);
                scope = outerScope;
            }
        });
    }

    private void BindImplicitBaseConstructorInitializer(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructSymbol? baseClassSymbol,
        TypeSymbol? importedBaseType)
    {
        var location = syntax.Identifier?.Location ?? syntax.Location;
        var arguments = ImmutableArray.CreateBuilder<BoundExpression>();
        BaseConstructorInitializer? initializer;
        if (importedBaseType?.ClrType is System.Type clrBase)
        {
            initializer = ResolveClrBaseConstructor(
                _ => location,
                clrBase,
                importedBaseType,
                arguments,
                location);
        }
        else if (baseClassSymbol?.EffectiveExplicitConstructors.IsDefaultOrEmpty == false)
        {
            initializer = ResolveGSharpBaseConstructor(
                _ => location,
                structSymbol.Name,
                baseClassSymbol,
                arguments,
                location);
        }
        else
        {
            return;
        }

        if (initializer is { Arguments.IsEmpty: false })
        {
            structSymbol.SetBaseConstructorInitializer(initializer);
        }
    }

    private void BindBaseConstructorInitializerCore(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructSymbol? baseClassSymbol,
        TypeSymbol? importedBaseType,
        ImmutableArray<ParameterSymbol> primaryCtorParameters)
    {
        var location = Invariant.Required(
            syntax.BaseConstructorOpenParenthesisToken,
            "a base-constructor argument list has an opening parenthesis").Location;

        if (baseClassSymbol == null && importedBaseType == null)
        {
            Diagnostics.ReportBaseConstructorArgumentsWithoutBase(location);
            return;
        }

        // Bind the argument expressions with the primary-constructor parameters
        // in scope (they are the typical source of forwarded values). Issue
        // #1194: also expose the enclosing type's static members (consts, static
        // fields/properties, static methods) and — because this runs after all
        // top-level functions are declared — free functions, so a `: base(...)`
        // argument can reference them unqualified (matching C#).
        var savedScope = scope;
        var savedTypeParameters = binderCtx.CurrentTypeParameters;
        if (!structSymbol.TypeParameters.IsDefaultOrEmpty)
        {
            binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
            foreach (var tp in structSymbol.TypeParameters)
            {
                binderCtx.CurrentTypeParameters[tp.Name] = tp;
            }
        }

        ImmutableArray<BoundExpression>.Builder boundArguments;
        BaseConstructorInitializer? clrInit = null;
        BaseConstructorInitializer? gsharpInit = null;
        var savedFunction = getCurrentFunction();
        setCurrentFunction(CreateFieldInitializerAccessibilityContext(structSymbol));
        try
        {
            using (PushStaticMemberScope(structSymbol))
            {
                var staticScope = scope;
                scope = new BoundScope(staticScope);
                if (!primaryCtorParameters.IsDefaultOrEmpty)
                {
                    foreach (var p in primaryCtorParameters)
                    {
                        scope.TryDeclareVariable(p);
                    }
                }

                var baseArguments = syntax.BaseConstructorArguments
                    ?? throw new InvalidOperationException(
                        "Invariant violated: a base-constructor argument list has an opening parenthesis.");
                boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(baseArguments.Count);
                for (var i = 0; i < baseArguments.Count; i++)
                {
                    boundArguments.Add(BindConstructorInitializerArgument(baseArguments[i]));
                }

                // Issue #1812: resolve (and, when needed, interpolation-rebind)
                // while the primary-ctor-parameter scope set up above is still
                // active — this must happen before the `using` block below tears
                // the parameter scope back down (`PushStaticMemberScope`'s
                // `Dispose` hard-resets `binderCtx.RootScope`, discarding the
                // child scope created above regardless of any assignment here).
                // See the matching comment in BindConstructorBaseInitializerCore.
                System.Func<int, TextLocation> argumentLocation = i => baseArguments[i].Location;
                System.Func<int, ExpressionSyntax> argumentSyntax = i => baseArguments[i];
                if (importedBaseType?.ClrType is System.Type clrBase)
                {
                    clrInit = ResolveClrBaseConstructor(argumentLocation, clrBase, importedBaseType, boundArguments, location, argumentSyntax);
                }
                else
                {
                    gsharpInit = ResolveGSharpBaseConstructor(
                        argumentLocation,
                        structSymbol.Name,
                        Invariant.Required(baseClassSymbol, "a non-CLR base constructor has a declared GSharp base class"),
                        boundArguments,
                        location);
                }

                scope = staticScope;
            }
        }
        finally
        {
            setCurrentFunction(savedFunction);
        }

        if (clrInit != null)
        {
            structSymbol.SetBaseConstructorInitializer(clrInit);
        }
        else if (gsharpInit != null)
        {
            structSymbol.SetBaseConstructorInitializer(gsharpInit);
        }

        scope = savedScope;
        binderCtx.CurrentTypeParameters = savedTypeParameters;
    }

    /// <summary>Resolves a base-constructor initializer against an imported CLR base type's constructors (issue #306). Returns <c>null</c> (after reporting a diagnostic) when no accessible constructor matches.</summary>
    private BaseConstructorInitializer? ResolveClrBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        System.Type clrBase,
        TypeSymbol? importedBaseType,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        TextLocation location,
        System.Func<int, ExpressionSyntax>? argSyntax = null)
    {
        var visibleConstructors = new List<ConstructorInfo>();
        foreach (var constructor in ClrTypeUtilities.SafeGetConstructors(
                     clrBase,
                     BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
        {
            if (constructor.IsPublic || constructor.IsFamily || constructor.IsFamilyOrAssembly)
            {
                visibleConstructors.Add(constructor);
            }
        }

        var ctors = visibleConstructors.ToArray();

        RebindDeferredArgumentsWithCommonClrTargets(ctors, boundArguments);

        var argTypes = new System.Type?[boundArguments.Count];
        var argsAllTyped = true;
        for (var i = 0; i < boundArguments.Count; i++)
        {
            // Issue #530 / #3984: use the OVERLOAD-RESOLUTION projection (see
            // the instance-method path) so an argument with no CLR backing of
            // its own — `[]T`, `map[K, V]`, `chan[T]`, a symbolic tuple, a
            // same-compilation user type — still ranks on its erased shape
            // instead of abandoning resolution here.
            // Issue #533: allow null (nil literal) through.
            var t = getEffectiveArgumentClrTypeForOverloadResolution(boundArguments[i].Type);
            if (t == null && boundArguments[i].Type != TypeSymbol.Null)
            {
                argsAllTyped = false;
                break;
            }

            argTypes[i] = t;
        }

        ConstructorInfo? bestCtor = null;
        var isExpanded = false;
        if (argsAllTyped)
        {
            // Issue #1812: a `: base($"...")` argument to an imported CLR base
            // constructor is convertible to an IFormattable/FormattableString
            // (or interpolated-string-handler) parameter just like any other
            // CLR call site, so mark which positional arguments are
            // interpolated-string literals (base-ctor arguments are always
            // positional, never named).
            var interpolatedStringArgs = ComputeInterpolatedStringArgFlags(argSyntax, boundArguments.Count);
            var resolution = ClrOverloadResolution.Resolve<ConstructorInfo>(
                ctors,
                argTypes,
                interpolatedStringArgs: interpolatedStringArgs,
                constantNarrowingArgumentCheck: ExpressionBinder.MakeConstantNarrowingArgumentCheck(boundArguments),
                structuralProjectionArgumentCheck: ExpressionBinder.MakeStructuralProjectionArgumentCheck(boundArguments),
                erasedArgumentMismatchCheck: ExpressionBinder.MakeErasedArgumentMismatchCheck(boundArguments),
                delegateRefKindArgumentCheck: ExpressionBinder.MakeDelegateRefKindArgumentCheck(boundArguments));
            switch (resolution.Outcome)
            {
                case ClrOverloadResolution.ResolutionOutcome.Resolved:
                    bestCtor = resolution.Best as ConstructorInfo;
                    isExpanded = resolution.IsExpanded;
                    break;
                case ClrOverloadResolution.ResolutionOutcome.Ambiguous:
                    Diagnostics.ReportAmbiguousOverload(location, clrBase.Name, resolution.Ambiguous.Length, resolution.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature));
                    return null;
                default:
                    break;
            }
        }

        if (bestCtor == null)
        {
            // Issue #3984: GS0214 says the base declares no accessible
            // constructor of this ARITY. Say that only when it is true. Once
            // resolution has actually run (`argsAllTyped`), a base that does
            // declare a constructor callable with this many arguments failed
            // on applicability, not on arity — which is the same situation the
            // ordinary imported-constructor probe reports as GS0267, so the
            // two positions now name the same problem the same way.
            if (argsAllTyped && ctors.Any(ctor => AcceptsArgumentCount(ctor, boundArguments.Count)))
            {
                Diagnostics.ReportNoApplicableOverload(location, clrBase.Name);
            }
            else
            {
                Diagnostics.ReportNoMatchingBaseConstructor(location, clrBase.Name, boundArguments.Count);
            }

            return null;
        }

        // Issue #1812: mirror RebindFormattableInterpolationArguments (the
        // step every ExpressionBinder CLR-call path runs) — now that overload
        // resolution has selected `bestCtor`, re-lower each interpolated-string
        // `: base(...)` argument whose chosen parameter is
        // IFormattable/FormattableString-shaped to
        // FormattableStringFactory.Create(...). Base-ctor arguments are always
        // positional (no named-argument mapping), so parameter index == argument
        // index. A no-op (and safe) when the caller has no
        // bindInterpolatedStringAsFormattable delegate wired or no argSyntax was
        // supplied.
        if (argSyntax != null && bindInterpolatedStringAsFormattable != null)
        {
            var bestCtorParams = bestCtor.GetParameters();
            var limit = Math.Min(boundArguments.Count, bestCtorParams.Length);
            for (var i = 0; i < limit; i++)
            {
                if (argSyntax(i) is InterpolatedStringExpressionSyntax interpolated
                    && ClrOverloadResolution.IsFormattableStringTarget(bestCtorParams[i].ParameterType))
                {
                    boundArguments[i] = bindInterpolatedStringAsFormattable(interpolated, targetType: null);
                }
            }
        }

        // Issue #3984: the open definition's constructor is where the parameter
        // types still mention the base's own generic parameters; `clrBase` has
        // already erased them.
        var openBaseDefinition = clrBase.IsConstructedGenericType ? clrBase.GetGenericTypeDefinition() : null;
        var openBaseCtorParams = TryGetOpenBaseConstructorParameters(openBaseDefinition, bestCtor);
        var baseTypeArguments = importedBaseType is ImportedTypeSymbol importedBase
            ? importedBase.TypeArguments
            : default;

        // Issue #306 (item 2): honor `ref`/`out`/`in` base-constructor parameters.
        // For a by-ref parameter the bound argument must already be an address-of
        // expression (`&x`); the emitter forwards the address rather than a value.
        var ctorParams = bestCtor.GetParameters();

        // Issue #506 follow-up: when overload resolution selected the expanded
        // form of a `params T[]` base ctor (e.g. `init() : base(1, 2, 3, 4)`
        // flowing into a C# `Base(int x, params int[] tail)`), pack the trailing
        // positional arguments into a synthesised slice/array first. The fixed
        // leading parameters and the synthesised array slot then go through the
        // same per-parameter ref/conversion loop as the normal-form path.
        var suppliedArgumentCount = boundArguments.Count;
        ImmutableArray<BoundExpression> orderedArgs;
        if (isExpanded)
        {
            var paramsIndex = ctorParams.Length - 1;
            var paramArrayType = ctorParams[paramsIndex].ParameterType;
            var elementClrType = paramArrayType.GetElementType();

            // Issue #3984 (review): the packed array is what the emitter pushes
            // at the base call, so it has to be built over the SYMBOLIC element
            // — `params T[]` on a `Base[T]` is `!T0[]`, not the erased
            // `object[]` the constructed type reports. Building the erased one
            // boxed each element and handed an `object[]` to a MemberRef whose
            // signature says `T0[]`, which ILVerify rejects.
            var symbolicParamsSlice =
                TryProjectSymbolicBaseParameterType(openBaseCtorParams, openBaseDefinition, baseTypeArguments, paramsIndex)
                    as SliceTypeSymbol;
            var elementTypeSymbol = symbolicParamsSlice?.ElementType
                ?? (elementClrType == null
                    ? TypeSymbol.Object
                    : TypeSymbol.FromClrType(elementClrType));
            var sliceType = symbolicParamsSlice ?? SliceTypeSymbol.Get(elementTypeSymbol);

            var tailCount = boundArguments.Count - paramsIndex;
            var packed = ImmutableArray.CreateBuilder<BoundExpression>(tailCount);
            for (var j = 0; j < tailCount; j++)
            {
                var srcIndex = paramsIndex + j;
                var element = boundArguments[srcIndex];
                if (element.Type != null && element.Type != TypeSymbol.Error && element.Type != elementTypeSymbol)
                {
                    if (Conversion.Classify(element.Type, elementTypeSymbol).Exists)
                    {
                        element = conversions.BindConversion(argLocation(srcIndex), element, elementTypeSymbol, allowExplicit: true);
                    }
                    else if (conversions.TryApplyUserDefinedImplicitArgumentConversion(element, elementTypeSymbol, out var udc))
                    {
                        element = udc;
                    }
                }

                packed.Add(element);
            }

            var arrayExpr = new BoundArrayCreationExpression(syntax: null, sliceType, packed.MoveToImmutable());

            var expandedBuilder = ImmutableArray.CreateBuilder<BoundExpression>(ctorParams.Length);
            for (var i = 0; i < paramsIndex; i++)
            {
                expandedBuilder.Add(boundArguments[i]);
            }

            expandedBuilder.Add(arrayExpr);
            orderedArgs = expandedBuilder.MoveToImmutable();
        }
        else
        {
            // Issue #3984 (review): a constructor selected with OMITTED optional
            // parameters supplies fewer arguments than it has parameters, and
            // the per-parameter loop below walks the parameters. Materialize the
            // omitted defaults first — the same step every ordinary CLR call
            // site runs — or the loop indexes past the supplied arguments and
            // the compiler crashes with an IndexOutOfRangeException. Before this
            // fix the case was unreachable from an erased argument only because
            // resolution never ran at all.
            orderedArgs = ConversionClassifier.AppendOmittedOptionalArguments(
                boundArguments.ToImmutable(),
                ctorParams);
        }

        var refKindsBuilder = ImmutableArray.CreateBuilder<RefKind>(ctorParams.Length);
        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(ctorParams.Length);
        for (var i = 0; i < ctorParams.Length; i++)
        {
            var clrParamType = ctorParams[i].ParameterType;
            if (clrParamType.IsByRef)
            {
                var refKind = ctorParams[i].IsOut ? RefKind.Out
                    : ctorParams[i].IsIn ? RefKind.In
                    : RefKind.Ref;
                refKindsBuilder.Add(refKind);

                // A by-ref argument is forwarded as-is (it is already a managed
                // pointer, e.g. the result of `&x`); no value conversion applies.
                convertedArgs.Add(orderedArgs[i]);
                continue;
            }

            refKindsBuilder.Add(RefKind.None);
            var targetType = ClrNullability.GetParameterTypeSymbol(ctorParams[i]);

            // Issue #3984: for a GENERIC base the erased CLR parameter type
            // above is not what the emitter writes. `List[T]`'s CLR shape is
            // `List<object>`, so `ctorParams[i].ParameterType` is
            // `IEnumerable<object>` — but the base-constructor MemberRef is
            // parented at the SYMBOLIC TypeSpec, and its signature reads
            // `IEnumerable<!T0>`. Converting to the erased shape therefore
            // targets a type the call does not have: for an argument with no
            // CLR identity (`[]T`) `Conversion` has no rule at all and the
            // whole initializer failed, and for one that does
            // (`[]string`, `(int32, object)`) it silently succeeded and left
            // ILVerify's StackUnexpected in the emitted constructor. Recover
            // the symbolic parameter by substituting the base's own type
            // arguments into the OPEN definition's constructor — the same
            // projection `ConversionClassifier.TrySubstituteParameterTypeFrom
            // Receiver` applies to an imported instance call's parameters.
            var orderedArg = orderedArgs[i];
            var symbolicTarget = TryProjectSymbolicBaseParameterType(
                openBaseCtorParams,
                openBaseDefinition,
                baseTypeArguments,
                i);
            if (symbolicTarget != null)
            {
                targetType = symbolicTarget;
            }

            // The synthesised params array and any materialised optional default
            // have no source argument of their own, so they report at the call.
            var argLoc = (isExpanded && i == ctorParams.Length - 1) || i >= suppliedArgumentCount
                ? location
                : argLocation(i);

            // Issue #3984 (review follow-up): an omitted optional is
            // materialised from the parameter's ERASED CLR type, so
            // `T fallback = default` on a `Base[T]` arrives as
            // `default(object)` and meets a symbolic `T` slot it cannot
            // convert to. Re-materialise it at the recovered target instead —
            // the same recovery #1471 applies to an explicit `default`
            // argument, and the reason it matters is identical: `default(T)`
            // must reify over the real slot rather than lower to `ldnull`.
            if (symbolicTarget != null
                && i >= suppliedArgumentCount
                && orderedArg is BoundDefaultExpression)
            {
                orderedArg = new BoundDefaultExpression(orderedArg.Syntax, symbolicTarget);
            }

            // Issue #506 follow-up: when the synthesised params array already
            // carries the exact CLR type of the parameter (SliceTypeSymbol(T)
            // → T[]), skip the rebinding so the emitter sees the original
            // array-creation expression without an extra conversion wrapper.
            if (symbolicTarget == null && orderedArg.Type?.ClrType != null && orderedArg.Type.ClrType == clrParamType)
            {
                convertedArgs.Add(orderedArg);
            }
            else if (orderedArg.Type == targetType)
            {
                convertedArgs.Add(orderedArg);
            }
            else
            {
                convertedArgs.Add(conversions.BindConversion(argLoc, orderedArg, targetType));
            }
        }

        return new BaseConstructorInitializer(convertedArgs.ToImmutable(), bestCtor, refKindsBuilder.ToImmutable());
    }

    /// <summary>
    /// Issue #3984: reports whether <paramref name="ctor"/> is callable with
    /// <paramref name="argumentCount"/> positional arguments — its fixed arity,
    /// or fewer once optional parameters are omitted, or more once a trailing
    /// <c>params</c> array is expanded. Used to keep GS0214's arity claim
    /// honest.
    /// </summary>
    /// <param name="ctor">The candidate constructor.</param>
    /// <param name="argumentCount">The number of supplied arguments.</param>
    /// <returns>Whether the constructor accepts that many arguments.</returns>
    private static bool AcceptsArgumentCount(ConstructorInfo ctor, int argumentCount)
    {
        var parameters = ctor.GetParameters();
        if (parameters.Length == argumentCount)
        {
            return true;
        }

        // `ClrOverloadResolution.IsParamsArrayParameter` reads the marker by
        // name, which is what keeps this working for a base type loaded through
        // a MetadataLoadContext.
        if (parameters.Length > 0
            && ClrOverloadResolution.IsParamsArrayParameter(parameters[^1])
            && argumentCount >= parameters.Length - 1)
        {
            return true;
        }

        var required = 0;
        foreach (var parameter in parameters)
        {
            if (!parameter.IsOptional)
            {
                required++;
            }
        }

        return argumentCount >= required && argumentCount <= parameters.Length;
    }

    /// <summary>
    /// Issue #3984: finds <paramref name="bestCtor"/> on the base type's OPEN
    /// generic definition, whose parameter types still mention the base's own
    /// generic parameters.
    /// </summary>
    /// <param name="openBaseDefinition">The base type's open generic definition, or <see langword="null"/> for a non-generic base.</param>
    /// <param name="bestCtor">The constructor overload resolution selected, on the constructed (erased) type.</param>
    /// <returns>The open constructor's parameters, or <see langword="null"/>.</returns>
    private static ParameterInfo[]? TryGetOpenBaseConstructorParameters(
        System.Type? openBaseDefinition,
        ConstructorInfo bestCtor)
    {
        if (openBaseDefinition == null)
        {
            return null;
        }

        foreach (var candidate in ClrTypeUtilities.SafeGetConstructors(
                     openBaseDefinition,
                     BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
        {
            if (candidate.MetadataToken == bestCtor.MetadataToken && candidate.Module == bestCtor.Module)
            {
                return candidate.GetParameters();
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #3984: substitutes the base type's symbolic type arguments into
    /// the open base constructor's parameter at <paramref name="index"/>,
    /// producing the type the emitted MemberRef's signature actually carries
    /// (<c>IEnumerable[T]</c> for <c>List[T]</c>, not
    /// <c>IEnumerable[object]</c>).
    /// </summary>
    /// <remarks>
    /// Returns <see langword="null"/> unless the substitution genuinely changes
    /// something — a base closed over concrete types (<c>List[int32]</c>) maps
    /// back to the same shape the erased signature already gave, so those call
    /// sites keep the exact target, conversion and IL they have today.
    /// </remarks>
    /// <param name="openBaseCtorParams">The open base constructor's parameters.</param>
    /// <param name="openBaseDefinition">The base type's open generic definition.</param>
    /// <param name="baseTypeArguments">The base type's symbolic type arguments.</param>
    /// <param name="index">The parameter ordinal.</param>
    /// <returns>The symbolic parameter type, or <see langword="null"/>.</returns>
    private static TypeSymbol? TryProjectSymbolicBaseParameterType(
        ParameterInfo[]? openBaseCtorParams,
        System.Type? openBaseDefinition,
        ImmutableArray<TypeSymbol> baseTypeArguments,
        int index)
    {
        if (openBaseCtorParams == null
            || openBaseDefinition == null
            || baseTypeArguments.IsDefaultOrEmpty
            || index < 0
            || index >= openBaseCtorParams.Length)
        {
            return null;
        }

        var raw = MemberLookup.MapOpenClrParameterTypeToSymbolic(
            openBaseCtorParams[index].ParameterType,
            openBaseDefinition,
            baseTypeArguments);

        // Issue #3987: #3984 canonicalised `raw` here — a `Dictionary`2`-shaped
        // `ImportedTypeSymbol` became a `MapTypeSymbol`, a `ValueTuple`n`-shaped
        // one a `TupleTypeSymbol` — because `Conversion` related the two
        // spellings of one type only while their `ClrType`s were readable, and
        // an argument the author wrote as `map[K, V]` therefore could not reach
        // the `Dictionary[K, V]` parameter it IS. That rewrite (and the
        // `ShouldCanonicalizeAgainst` guard that kept it from breaking the
        // opposite spelling) is DELETED: `Conversion` now recognises both
        // shapes by shape rather than by spelling, so the raw projection is
        // accepted whichever way either side is written.
        var mapped = raw;

        return mapped != TypeSymbol.Error
            && (TypeSymbol.ContainsTypeParameter(mapped) || TypeSymbol.ContainsSameCompilationUserType(mapped))
            ? mapped
            : null;
    }

    private BoundExpression BindConstructorInitializerArgument(ExpressionSyntax syntax)
    {
        if (ExpressionBinder.IsTargetDependentBlockArgumentSyntax(syntax))
        {
            return new BoundErrorExpression(syntax);
        }

        if (!ExpressionBinder.IsTargetTypedBranchyArgumentSyntax(syntax))
        {
            return bindExpression(syntax);
        }

        var previous = binderCtx.DeferTargetlessConditional;
        binderCtx.DeferTargetlessConditional = true;
        try
        {
            return bindExpression(syntax);
        }
        finally
        {
            binderCtx.DeferTargetlessConditional = previous;
        }
    }

    private void RebindDeferredArgumentsWithCommonClrTargets(
        ConstructorInfo[] constructors,
        ImmutableArray<BoundExpression>.Builder boundArguments)
    {
        var deferred = new List<int>();
        for (var i = 0; i < boundArguments.Count; i++)
        {
            if (ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(boundArguments[i], out _))
            {
                deferred.Add(i);
            }
        }

        if (deferred.Count == 0)
        {
            return;
        }

        var deferredSet = new HashSet<int>(deferred);
        var applicabilityArgumentTypes = new System.Type?[boundArguments.Count];
        for (var i = 0; i < boundArguments.Count; i++)
        {
            if (deferredSet.Contains(i))
            {
                applicabilityArgumentTypes[i] = ClrOverloadResolution.DefaultLiteralArgumentType;
                continue;
            }

            var argumentType = getEffectiveArgumentClrTypeForOverloadResolution(boundArguments[i].Type);
            if (argumentType == null && boundArguments[i].Type != TypeSymbol.Null)
            {
                return;
            }

            applicabilityArgumentTypes[i] = argumentType;
        }

        var delegateRefKindCheck = ExpressionBinder.MakeDelegateRefKindArgumentCheck(boundArguments);
        var compatible = new List<(ConstructorInfo Constructor, ParameterInfo[] Parameters)>();
        foreach (var constructor in constructors)
        {
            var parameters = constructor.GetParameters();
            if (parameters.Length != boundArguments.Count)
            {
                continue;
            }

            var deferredTargetsMatch = true;
            foreach (var index in deferred)
            {
                var targetClrType = parameters[index].ParameterType;
                if (targetClrType.IsByRef)
                {
                    targetClrType = targetClrType.GetElementType() ?? targetClrType;
                }

                if (!ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(boundArguments[index], out var syntax)
                    || !ExpressionBinder.CanTargetDependentBlockArgument(syntax, TypeSymbol.FromClrType(targetClrType)))
                {
                    deferredTargetsMatch = false;
                    break;
                }
            }

            if (!deferredTargetsMatch)
            {
                continue;
            }

            System.Func<int, System.Type, bool?> refKindCheck = (index, targetType) =>
                deferredSet.Contains(index) ? true : delegateRefKindCheck?.Invoke(index, targetType);
            var resolution = ClrOverloadResolution.Resolve<ConstructorInfo>(
                [constructor],
                applicabilityArgumentTypes,
                constantNarrowingArgumentCheck: ExpressionBinder.MakeConstantNarrowingArgumentCheck(boundArguments),
                structuralProjectionArgumentCheck: ExpressionBinder.MakeStructuralProjectionArgumentCheck(boundArguments),
                erasedArgumentMismatchCheck: ExpressionBinder.MakeErasedArgumentMismatchCheck(boundArguments),
                delegateRefKindArgumentCheck: refKindCheck);
            if (resolution.Outcome == ClrOverloadResolution.ResolutionOutcome.Resolved)
            {
                compatible.Add((constructor, parameters));
            }
        }

        foreach (var index in deferred)
        {
            System.Type? commonTargetType = null;
            var targetsDisagree = false;
            foreach (var candidate in compatible)
            {
                var candidateTargetType = candidate.Parameters[index].ParameterType;
                if (candidateTargetType.IsByRef)
                {
                    candidateTargetType = candidateTargetType.GetElementType() ?? candidateTargetType;
                }

                if (commonTargetType is null)
                {
                    commonTargetType = candidateTargetType;
                }
                else if (!ClrTypeUtilities.AreSame(commonTargetType, candidateTargetType))
                {
                    targetsDisagree = true;
                    break;
                }
            }

            if (commonTargetType is null || targetsDisagree)
            {
                continue;
            }

            var targetType = TypeSymbol.FromClrType(commonTargetType);
            boundArguments[index] = conversions.BindConversion(
                boundArguments[index].Syntax?.Location ?? default,
                boundArguments[index],
                targetType);
        }
    }

    /// <summary>
    /// Issue #1812 (ADR-0055 Tier 4 / #369 companion): produces the per-argument
    /// flags marking which positional `: base(...)` arguments are
    /// interpolated-string literals, so overload resolution can treat them as
    /// convertible to IFormattable/FormattableString/handler parameters — the
    /// same treatment every other CLR-call Resolve site gives interpolated
    /// string arguments. Base-constructor arguments are always positional
    /// (there is no named-argument base-ctor syntax), so no unwrap step is
    /// needed here (contrast with the named-argument-aware helpers used for
    /// ordinary calls). Returns <see langword="null"/> when no argument
    /// qualifies or <paramref name="argSyntax"/> is unavailable.
    /// </summary>
    private static System.Collections.Generic.IReadOnlyList<bool>? ComputeInterpolatedStringArgFlags(System.Func<int, ExpressionSyntax>? argSyntax, int count)
    {
        if (argSyntax == null)
        {
            return null;
        }

        bool[]? flags = null;
        for (var i = 0; i < count; i++)
        {
            if (argSyntax(i) is InterpolatedStringExpressionSyntax)
            {
                flags ??= new bool[count];
                flags[i] = true;
            }
        }

        return flags;
    }

    /// <summary>Resolves a base-constructor initializer against a GSharp base class's constructors (issue #306). Returns <c>null</c> (after reporting a diagnostic) when no match.</summary>
    private BaseConstructorInitializer? ResolveGSharpBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        string derivedNameForDiag,
        StructSymbol? baseClassSymbol,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        TextLocation location)
    {
        if (baseClassSymbol == null)
        {
            Diagnostics.ReportNoMatchingBaseConstructor(location, derivedNameForDiag, boundArguments.Count);
            return null;
        }

        // Issue #1060: when the base class declares explicit `init(...)`
        // constructors, the `: base(args)` initializer must resolve against the
        // full overload set — every explicit init plus (when present) the
        // synthesized primary-constructor designated init — selecting the best
        // overload by argument types, mirroring C# where a derived constructor
        // may chain to any accessible base constructor. The primary-only fast
        // path below covers classes that declare no explicit init bodies.
        // Issue #1087: a constructed generic base (e.g. `Base[int32]`) does not
        // carry its own explicit-constructor table — consult the open
        // definition's via EffectiveExplicitConstructors.
        if (!baseClassSymbol.EffectiveExplicitConstructors.IsDefaultOrEmpty)
        {
            return ResolveGSharpExplicitBaseConstructor(argLocation, baseClassSymbol, boundArguments, location);
        }

        var baseParams = baseClassSymbol.PrimaryConstructorParameters;
        var requiredCount = baseParams.Length;
        while (requiredCount > 0 && baseParams[requiredCount - 1].HasExplicitDefaultValue)
        {
            requiredCount--;
        }

        if (boundArguments.Count < requiredCount || boundArguments.Count > baseParams.Length)
        {
            Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count);
            return null;
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(baseParams.Length);
        for (var i = 0; i < baseParams.Length; i++)
        {
            var parameter = baseParams[i];
            if (i >= boundArguments.Count)
            {
                convertedArgs.Add(CreateProjectedOptionalUserDefaultArgument(parameter, parameter.Type));
                continue;
            }

            var argument = boundArguments[i];
            if (ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(argument, out _))
            {
                argument = conversions.BindConversion(argLocation(i), argument, parameter.Type);
                boundArguments[i] = argument;
            }

            if (parameter.RefKind != RefKind.None)
            {
                if (!TryGetAddressedArgumentType(argument, out var addressedType)
                    || addressedType != parameter.Type)
                {
                    Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count);
                    return null;
                }

                convertedArgs.Add(argument);
                continue;
            }

            // Issue #3907: an `@AllowNull` base-constructor parameter declares
            // that it accepts a nil-carrying input.
            if (ConversionClassifier.AcceptsNilAnnotatedArgument(parameter, argument.Type, parameter.Type))
            {
                convertedArgs.Add(argument);
                continue;
            }

            if (argument.Type != parameter.Type
                && !Conversion.Classify(argument.Type, parameter.Type).IsImplicit
                && !ExpressionBinder.IsImplicitConstantNarrowingArgument(argument, parameter.Type))
            {
                if (argument.Type != TypeSymbol.Error)
                {
                    Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count);
                }

                return null;
            }

            convertedArgs.Add(conversions.BindConversion(argLocation(i), argument, parameter.Type));
        }

        return new BaseConstructorInitializer(convertedArgs.ToImmutable(), baseClassSymbol);
    }

    /// <summary>
    /// Issue #1060: resolves a <c>: base(args)</c> initializer against the explicit
    /// <c>init(...)</c> constructors declared on a GSharp base class (which already
    /// includes the synthesized primary-constructor designated init when present),
    /// selecting the best overload by argument types. Returns <c>null</c> (after
    /// reporting a diagnostic) when no accessible base constructor matches.
    /// </summary>
    private BaseConstructorInitializer? ResolveGSharpExplicitBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        StructSymbol baseClassSymbol,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        TextLocation location)
    {
        ConstructorSymbol? best = null;
        ImmutableArray<TypeSymbol> bestParamTypes = default;
        var bestExactMatches = -1;
        var bestOmittedCount = int.MaxValue;
        var ambiguous = false;
        var anyArgIsError = false;

        foreach (var arg in boundArguments)
        {
            if (arg.Type == TypeSymbol.Error)
            {
                anyArgIsError = true;
            }
        }

        // Issue #1087: iterate the effective explicit-constructor set (the open
        // definition's, for a constructed generic base) and compare against each
        // candidate's type-argument-substituted parameter signature so that a
        // generic base ctor such as `init(a T)` matches `: base(value)` on a
        // constructed `Base[int32]`.
        foreach (var candidate in baseClassSymbol.EffectiveExplicitConstructors)
        {
            var paramTypes = baseClassSymbol.GetConstructorParameterTypesForConstruction(candidate);
            var requiredCount = candidate.Parameters.Length;
            while (requiredCount > 0
                && candidate.Parameters[requiredCount - 1].HasExplicitDefaultValue)
            {
                requiredCount--;
            }

            if (boundArguments.Count < requiredCount || boundArguments.Count > paramTypes.Length)
            {
                continue;
            }

            var applicable = true;
            var exactMatches = 0;
            for (var i = 0; i < boundArguments.Count; i++)
            {
                var argType = boundArguments[i].Type;
                var paramType = paramTypes[i];
                var parameter = candidate.Parameters[i];
                if (parameter.RefKind != RefKind.None)
                {
                    if (!TryGetAddressedArgumentType(boundArguments[i], out var addressedType)
                        || addressedType != paramType)
                    {
                        applicable = false;
                        break;
                    }

                    exactMatches++;
                    continue;
                }

                if (boundArguments[i] is BoundAddressOfExpression { IsUnmanaged: false }
                    or BoundConditionalAddressExpression)
                {
                    applicable = false;
                    break;
                }

                if (argType == paramType)
                {
                    exactMatches++;
                    continue;
                }

                // Error-typed arguments don't disqualify a candidate: a prior
                // diagnostic already explains the bad argument.
                if (argType == TypeSymbol.Error)
                {
                    if (ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(boundArguments[i], out var deferredSyntax)
                        && !ExpressionBinder.CanTargetDependentBlockArgument(deferredSyntax, paramType))
                    {
                        applicable = false;
                        break;
                    }

                    continue;
                }

                // Issue #1307: a constant integer argument that fits a narrower /
                // cross-sign integer parameter is implicitly convertible there
                // (C# §10.2.11, issue #1281), so it must not disqualify the
                // candidate even though the lattice conversion is not implicit.
                if (ExpressionBinder.IsImplicitConstantNarrowingArgument(boundArguments[i], paramType))
                {
                    continue;
                }

                if (!Conversion.Classify(argType, paramType).IsImplicit)
                {
                    applicable = false;
                    break;
                }
            }

            if (!applicable)
            {
                continue;
            }

            var omittedCount = paramTypes.Length - boundArguments.Count;
            if (exactMatches > bestExactMatches
                || (exactMatches == bestExactMatches && omittedCount < bestOmittedCount))
            {
                best = candidate;
                bestParamTypes = paramTypes;
                bestExactMatches = exactMatches;
                bestOmittedCount = omittedCount;
                ambiguous = false;
            }
            else if (exactMatches == bestExactMatches && omittedCount == bestOmittedCount)
            {
                ambiguous = true;
            }
        }

        if (best == null || ambiguous)
        {
            // Suppress the GS0214 cascade when an argument already failed to
            // bind (an error type was produced upstream).
            if (!anyArgIsError)
            {
                Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count);
            }

            return null;
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(best.Parameters.Length);
        for (var i = 0; i < best.Parameters.Length; i++)
        {
            if (i >= boundArguments.Count)
            {
                convertedArgs.Add(
                    CreateProjectedOptionalUserDefaultArgument(
                        best.Parameters[i],
                        bestParamTypes[i]));
                continue;
            }

            convertedArgs.Add(best.Parameters[i].RefKind != RefKind.None
                ? boundArguments[i]
                : conversions.BindConversion(argLocation(i), boundArguments[i], bestParamTypes[i]));
        }

        return new BaseConstructorInitializer(convertedArgs.ToImmutable(), baseClassSymbol, best);
    }

    private static BoundExpression CreateProjectedOptionalUserDefaultArgument(
        ParameterSymbol parameter,
        TypeSymbol targetType)
    {
        if (parameter.ExplicitDefaultValue == null)
        {
            return new BoundDefaultExpression(null, targetType);
        }

        return new BoundLiteralExpression(null, parameter.ExplicitDefaultValue, targetType);
    }

    private static bool TryGetAddressedArgumentType(
        BoundExpression argument,
        [NotNullWhen(true)] out TypeSymbol? addressedType)
    {
        switch (argument)
        {
            case BoundAddressOfExpression { IsUnmanaged: false } address:
                addressedType = address.Operand.Type;
                return true;
            case BoundConditionalAddressExpression conditionalAddress:
                addressedType = conditionalAddress.PointeeType;
                return true;
            default:
                addressedType = null;
                return false;
        }
    }

    /// <summary>
    /// Issue #306 / #2766: binds standalone user-defined constructors (<c>init(...)</c>)
    /// declared in a class or plain struct body. Each constructor becomes a <see cref="ConstructorSymbol"/>
    /// whose body is bound in <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver)"/> as an instance-method body and
    /// emitted/interpreted as a <c>.ctor</c>.
    /// </summary>
    private void BindConstructorDeclarations(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        PackageSymbol package,
        StructSymbol? baseClassSymbol,
        TypeSymbol? importedBaseType)
    {
        // ADR-0065 §5: a class with a primary-constructor parameter list and
        // no explicit `init(...)` body still needs ExplicitConstructors set up
        // for the convenience-init self-delegation lookup, but the emitter
        // already handles the primary-ctor-only case via its existing
        // ClassPrimaryCtorHandles path. We only need to materialize a
        // synthesized designated ConstructorSymbol when there are also
        // explicit init(...) bodies (so that primary becomes a peer in the
        // overload set), or when a class needs an init(...) overload for
        // diagnostics or chaining purposes. For pure primary-ctor classes we
        // leave the existing path unchanged.
        if (syntax.Constructors.IsDefaultOrEmpty)
        {
            return;
        }

        // ADR-0065 §5: when both a primary-constructor parameter list and
        // explicit `init(...)` bodies are declared, the primary constructor
        // becomes a synthesized designated initializer that participates in
        // the overload set alongside the explicit bodies. Duplicate signatures
        // are diagnosed below by the same overload-equality check that catches
        // collisions between two user-declared init overloads.
        ConstructorSymbol? synthesizedPrimary = null;
        if (structSymbol.IsClass && structSymbol.HasPrimaryConstructor)
        {
            synthesizedPrimary = SynthesizePrimaryConstructor(structSymbol, package);
        }

        // ADR-0063 §9: bind every declared init(...) constructor. Duplicate
        // signatures are diagnosed as GS0264 the same way as duplicate method
        // overloads, so each surviving ConstructorSymbol carries a unique
        // signature within the overload family.
        var ctorBuilder = ImmutableArray.CreateBuilder<ConstructorSymbol>();
        if (synthesizedPrimary != null)
        {
            ctorBuilder.Add(synthesizedPrimary);
        }

        foreach (var ctorSyntax in syntax.Constructors)
        {
            var ctor = BindSingleConstructorDeclaration(ctorSyntax, structSymbol, package, baseClassSymbol, importedBaseType);
            if (ctor == null)
            {
                continue;
            }

            // ADR-0065 §2: enforce constraints on convenience initializers.
            // Issue #1085: base-initializer resolution is deferred, so detect the
            // `: base(...)` presence from syntax rather than the (not-yet-set)
            // resolved BaseInitializer symbol.
            if (ctor.IsConvenience && ctorSyntax.HasBaseInitializer)
            {
                Diagnostics.ReportConvenienceInitMayNotCallBase(
                    Invariant.Required(ctorSyntax.BaseKeyword, "a constructor with a base initializer has a base keyword").Location,
                    structSymbol.Name);
            }

            var duplicate = false;
            foreach (var existing in ctorBuilder)
            {
                if (BoundScope.FunctionSignaturesEqual(existing.Function, ctor.Function))
                {
                    duplicate = true;
                    break;
                }
            }

            if (duplicate)
            {
                // ADR-0065 §5: distinguish duplication against the synthesized
                // primary ctor from duplication between two user inits so users
                // get an actionable message.
                if (synthesizedPrimary != null
                    && BoundScope.FunctionSignaturesEqual(synthesizedPrimary.Function, ctor.Function))
                {
                    Diagnostics.ReportInitDuplicatesPrimaryCtor(
                        ctorSyntax.InitKeyword.Location,
                        structSymbol.Name,
                        Binder.FormatOverloadSignature(ctor.Function));
                }
                else
                {
                    Diagnostics.ReportDuplicateOverloadSignature(
                        ctorSyntax.InitKeyword.Location,
                        "init",
                        Binder.FormatOverloadSignature(ctor.Function));
                }

                continue;
            }

            ctorBuilder.Add(ctor);
        }

        structSymbol.SetExplicitConstructors(ctorBuilder.ToImmutable());

        // Issue #4143: validate every EXPLICIT `init(...)` overload's
        // parameter types too — `csc` checks CS0181 against every
        // constructor of an attribute class, not just the primary one. The
        // synthesized primary constructor (if any) is skipped here: its
        // parameters were already validated once, against the primary
        // constructor's own parameter list, where the class's base clause
        // was bound (`BindStructBaseAndInterfaces`) — validating it again
        // here would double-report the same offending parameter.
        if (structSymbol.DerivesFromSystemAttribute())
        {
            foreach (var ctor in ctorBuilder)
            {
                if (ctor == synthesizedPrimary)
                {
                    continue;
                }

                ValidateAttributeConstructorParameterTypes(ctor.Parameters, syntax.Identifier.Location);
            }
        }
    }

    /// <summary>
    /// ADR-0068 / issue #698: binds the optional <c>deinit { … }</c> destructor
    /// on a class body into a synthesized <see cref="FunctionSymbol"/> named
    /// <c>Finalize</c>. The body itself is bound later in
    /// <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver)"/>
    /// alongside method and constructor bodies. Non-class types are rejected
    /// here so the parser-level GS0289 is never the only signal in tools that
    /// skip parser diagnostics.
    /// </summary>
    private void BindDeinitDeclaration(StructDeclarationSyntax syntax, StructSymbol structSymbol, PackageSymbol package)
    {
        var deinitSyntax = syntax.Deinitializer;
        if (deinitSyntax == null)
        {
            return;
        }

        // Defence-in-depth: the parser already reports GS0289 when `deinit`
        // appears inside a non-class body, but if a downstream tool feeds us
        // such a tree directly we must still refuse to synthesise a Finalize
        // symbol for the value type.
        if (!structSymbol.IsClass)
        {
            return;
        }

        var ctorFunction = new FunctionSymbol(
            "Finalize",
            ImmutableArray<ParameterSymbol>.Empty,
            TypeSymbol.Void,
            declaration: null,
            package,
            Accessibility.Private,
            receiverType: structSymbol);

        var deinitSymbol = new DeinitSymbol(ctorFunction, deinitSyntax);
        structSymbol.SetDeinitializer(deinitSymbol);
    }

    /// <summary>
    /// ADR-0065 §5: synthesizes a designated <see cref="ConstructorSymbol"/>
    /// whose signature matches the class's primary-constructor parameter list.
    /// The emitter produces its body (field assignments per parameter) directly
    /// rather than reading from <c>BoundProgram.Functions</c>; we leave the
    /// function's body unbound here. The synthesized ctor is marked with
    /// <see cref="ConstructorSymbol.IsSynthesizedFromPrimaryConstructor"/> so
    /// emit and overload-resolution paths can detect it.
    /// </summary>
    private ConstructorSymbol SynthesizePrimaryConstructor(StructSymbol structSymbol, PackageSymbol package)
    {
        // Reuse the primary-ctor parameter symbols verbatim — they already
        // carry the right names, types, ref-kinds and any defaults. The
        // emitter looks up the matching same-named field for each parameter.
        var parameters = structSymbol.PrimaryConstructorParameters;
        var ctorFunction = new FunctionSymbol(
            ".ctor",
            parameters,
            TypeSymbol.Void,
            declaration: null,
            package,
            Accessibility.Public,
            receiverType: structSymbol)
        {
            IsSpecialName = true,
        };

        var ctorSymbol = new ConstructorSymbol(ctorFunction, declaration: null);
        ctorSymbol.MarkSynthesizedFromPrimaryConstructor();
        return ctorSymbol;
    }

    /// <summary>
    /// ADR-0063 §9: binds a single <c>init(...)</c> constructor declaration into a
    /// <see cref="ConstructorSymbol"/> with the optional <c>: base(args)</c> initializer
    /// resolved. The caller is responsible for collecting all constructors and
    /// rejecting same-signature duplicates.
    /// </summary>
    private ConstructorSymbol BindSingleConstructorDeclaration(
        ConstructorDeclarationSyntax ctorSyntax,
        StructSymbol structSymbol,
        PackageSymbol package,
        StructSymbol? baseClassSymbol,
        TypeSymbol? importedBaseType)
    {
        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        var seenParameterNames = new HashSet<string>();
        foreach (var parameterSyntax in ctorSyntax.Parameters)
        {
            var parameterName = parameterSyntax.Identifier.ValueText;
            var parameterType = parameterSyntax.Type is { } parameterTypeSyntax
                ? bindTypeClause(parameterTypeSyntax) ?? TypeSymbol.Error
                : TypeSymbol.Error;

            // ADR-0101 follow-up / issue #812: variadic parameters are now
            // accepted on explicit `init(...)` constructors. The body sees
            // the parameter as `[]T`; constructor calls (and
            // `: this(...)` / `: base(...)` chaining) go through the
            // constructor overload paths that pack trailing arguments.
            var isVariadic = parameterSyntax.IsVariadic;
            if (isVariadic && parameterType != TypeSymbol.Error)
            {
                parameterType = VariadicCarriers.ResolveDeclaredParameterType(parameterType);
            }

            var parameterRefKind = conversions.BindAndValidateParameterRefKind(
                parameterSyntax,
                parameterName,
                parameterType,
                isVariadic,
                asyncOrIteratorKind: null);

            // Issue #1262: `_` is the discard identifier — repeated `_` parameters are
            // permitted on named functions/methods. Each `_` occupies a positional slot
            // but is not added to the body scope, so non-`_` duplicates still error.
            if (parameterName != "_" && !seenParameterNames.Add(parameterName))
            {
                Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName);
            }
            else
            {
                var ctorParam = new ParameterSymbol(parameterName, parameterType, isVariadic, declaringSyntax: parameterSyntax.Identifier, isScoped: parameterSyntax.IsScoped, refKind: parameterRefKind);
                conversions.BindAndAttachParameterDefaultValue(parameterSyntax, ctorParam);
                BindAndAttachParameterAttributes(parameterSyntax, ctorParam);
                parameters.Add(ctorParam);
            }
        }

        ValidateVariadicParameterShape(ctorSyntax.Parameters);

        var ctorAccessibility = resolveAccessibility(ctorSyntax.AccessibilityModifier);
        var ctorFunction = new FunctionSymbol(
            ".ctor",
            parameters.ToImmutable(),
            TypeSymbol.Void,
            declaration: null,
            package,
            ctorAccessibility,
            receiverType: structSymbol)
        {
            IsSpecialName = true,
        };

        var constructorSymbol = new ConstructorSymbol(ctorFunction, ctorSyntax);
        Binder.AttachDocumentation(ctorFunction, ctorSyntax);

        // ADR-0065 §2: propagate the contextual `convenience` modifier from
        // syntax onto the symbol so the binder/emitter can apply the §2
        // rules (delegation-first, no `: base()`, this(args) chaining).
        if (ctorSyntax.IsConvenience)
        {
            constructorSymbol.MarkConvenience();
        }

        // Resolve the explicit `: base(args)` initializer, or the implicit
        // zero-argument base call of a designated constructor, with the
        // constructor parameters in scope so explicit arguments can be
        // forwarded to the base.
        //
        // Issue #1085: the argument expressions may construct other user types
        // whose explicit constructors are not yet populated when this type body
        // is bound (the constructed type may live in a source file processed
        // later). Defer the argument binding and base-constructor resolution to
        // a post-pass that runs after every declared type's constructors exist.
        if (ctorSyntax.HasBaseInitializer
            || (!ctorSyntax.IsConvenience
                && (importedBaseType != null
                    || baseClassSymbol?.EffectiveExplicitConstructors.IsDefaultOrEmpty == false)))
        {
            var capturedScope = scope;
            pendingBaseInitializerBindings.Add(() =>
            {
                var outerScope = scope;
                scope = capturedScope;

                // Issue #2342: re-establish this type's OWN owning package as
                // the ambient lookup preference (see field-initializer closure
                // above for the full rationale) for the duration of this
                // deferred bind.
                var savedPackage = scope.SetCurrentDeclaringPackage(structSymbol.PackageName);
                var savedTree = scope.SetCurrentReferencingSyntaxTree(ctorSyntax.SyntaxTree);
                try
                {
                    BindConstructorBaseInitializerCore(ctorSyntax, constructorSymbol, ctorFunction, structSymbol, baseClassSymbol, importedBaseType);
                }
                finally
                {
                    scope.SetCurrentDeclaringPackage(savedPackage);
                    scope.SetCurrentReferencingSyntaxTree(savedTree);
                    scope = outerScope;
                }
            });
        }

        return constructorSymbol;
    }

    private void BindConstructorBaseInitializerCore(
        ConstructorDeclarationSyntax ctorSyntax,
        ConstructorSymbol constructorSymbol,
        FunctionSymbol ctorFunction,
        StructSymbol structSymbol,
        StructSymbol? baseClassSymbol,
        TypeSymbol? importedBaseType)
    {
        var hasExplicitBaseInitializer = ctorSyntax.HasBaseInitializer;
        var location = hasExplicitBaseInitializer
            ? Invariant.Required(
                ctorSyntax.BaseKeyword,
                "a constructor base initializer has a base keyword").Location
            : ctorSyntax.InitKeyword.Location;

        // Issue #1194: expose the enclosing type's static members (consts, static
        // fields/properties, static methods) and — because this runs after all
        // top-level functions are declared — free functions, so a `: base(...)`
        // argument can reference them unqualified (matching C#).
        var savedScope = scope;
        var savedTypeParameters = binderCtx.CurrentTypeParameters;
        if (!structSymbol.TypeParameters.IsDefaultOrEmpty)
        {
            binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
            foreach (var tp in structSymbol.TypeParameters)
            {
                binderCtx.CurrentTypeParameters[tp.Name] = tp;
            }
        }

        ImmutableArray<BoundExpression>.Builder boundArguments;
        BaseConstructorInitializer? init = null;
        var savedFunction = getCurrentFunction();
        var savedInitializerContext = ctorFunction.IsExpressionInitializer;
        ctorFunction.IsExpressionInitializer = true;
        setCurrentFunction(ctorFunction);
        try
        {
            using var initializerContext = binderCtx.PushConstructorInitializerContext();

            using (PushStaticMemberScope(structSymbol))
            {
                var staticScope = scope;
                scope = new BoundScope(staticScope);
                foreach (var p in ctorFunction.Parameters)
                {
                    scope.TryDeclareVariable(p);
                }

                var baseArgumentCount = hasExplicitBaseInitializer ? ctorSyntax.BaseArguments.Count : 0;
                boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(baseArgumentCount);
                for (var i = 0; i < baseArgumentCount; i++)
                {
                    boundArguments.Add(BindConstructorInitializerArgument(ctorSyntax.BaseArguments[i]));
                }

                // Issue #1812: resolve (and, when needed, interpolation-rebind)
                // while the ctor-parameter scope set up above is still active, so
                // a `: base($"...{n}...")` argument referencing an explicit ctor
                // parameter (`n`) can be re-bound against the chosen
                // FormattableString parameter — this must happen before the
                // `using` block below tears the parameter scope back down
                // (`PushStaticMemberScope`'s `Dispose` hard-resets
                // `binderCtx.RootScope`, discarding the child scope created above
                // regardless of any assignment here), otherwise the rebind would
                // fail to resolve `n` (issue #377/#1638's
                // RebindFormattableInterpolationArguments does not have this
                // problem because ExpressionBinder never tears its scope down
                // mid-call the way this deferred base-initializer pass does).
                if (baseClassSymbol == null && importedBaseType == null)
                {
                    Diagnostics.ReportBaseConstructorArgumentsWithoutBase(location);
                }
                else if (importedBaseType?.ClrType is System.Type clrBase)
                {
                    System.Func<int, TextLocation> argumentLocation =
                        i => hasExplicitBaseInitializer ? ctorSyntax.BaseArguments[i].Location : location;
                    System.Func<int, ExpressionSyntax>? argumentSyntax = hasExplicitBaseInitializer
                        ? i => ctorSyntax.BaseArguments[i]
                        : null;
                    init = ResolveClrBaseConstructor(argumentLocation, clrBase, importedBaseType, boundArguments, location, argumentSyntax);
                }
                else
                {
                    System.Func<int, TextLocation> argumentLocation =
                        i => hasExplicitBaseInitializer ? ctorSyntax.BaseArguments[i].Location : location;
                    init = ResolveGSharpBaseConstructor(
                        argumentLocation,
                        structSymbol.Name,
                        Invariant.Required(baseClassSymbol, "a non-CLR base constructor has a declared GSharp base class"),
                        boundArguments,
                        location);
                }

                scope = staticScope;
            }
        }
        finally
        {
            ctorFunction.IsExpressionInitializer = savedInitializerContext;
            setCurrentFunction(savedFunction);
        }

        if (init != null)
        {
            constructorSymbol.SetBaseInitializer(init);
        }

        scope = savedScope;
        binderCtx.CurrentTypeParameters = savedTypeParameters;
    }
}
