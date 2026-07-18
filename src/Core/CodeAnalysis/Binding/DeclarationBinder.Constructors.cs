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
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class DeclarationBinder
{
    /// <summary>
    /// Issue #306: binds the explicit base-constructor argument list
    /// (<c>: Base(args)</c>) of a class declaration and resolves it against the
    /// base class's constructors. The arguments are bound in a scope that
    /// exposes the primary-constructor parameters so they can be forwarded to
    /// the base. On success the resolved <see cref="BaseConstructorInitializer"/>
    /// is recorded on <paramref name="structSymbol"/> for the emitter; failures
    /// surface a diagnostic.
    /// </summary>
    private void BindBaseConstructorInitializer(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType,
        ImmutableArray<ParameterSymbol> primaryCtorParameters)
    {
        if (!syntax.HasBaseConstructorArguments)
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
                BindBaseConstructorInitializerCore(syntax, structSymbol, baseClassSymbol, importedBaseType, primaryCtorParameters);
            }
            finally
            {
                scope.SetCurrentDeclaringPackage(savedPackage);
                scope.SetCurrentReferencingSyntaxTree(savedTree);
                scope = outerScope;
            }
        });
    }

    private void BindBaseConstructorInitializerCore(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType,
        ImmutableArray<ParameterSymbol> primaryCtorParameters)
    {
        var location = syntax.BaseConstructorOpenParenthesisToken.Location;

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
        BaseConstructorInitializer clrInit = null;
        BaseConstructorInitializer gsharpInit = null;
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

            boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(syntax.BaseConstructorArguments.Count);
            for (var i = 0; i < syntax.BaseConstructorArguments.Count; i++)
            {
                boundArguments.Add(bindExpression(syntax.BaseConstructorArguments[i]));
            }

            // Issue #1812: resolve (and, when needed, interpolation-rebind)
            // while the primary-ctor-parameter scope set up above is still
            // active — this must happen before the `using` block below tears
            // the parameter scope back down (`PushStaticMemberScope`'s
            // `Dispose` hard-resets `binderCtx.RootScope`, discarding the
            // child scope created above regardless of any assignment here).
            // See the matching comment in BindConstructorBaseInitializerCore.
            if (importedBaseType?.ClrType is System.Type clrBase)
            {
                clrInit = ResolveClrBaseConstructor(i => syntax.BaseConstructorArguments[i].Location, clrBase, boundArguments, location, i => syntax.BaseConstructorArguments[i]);
            }
            else
            {
                gsharpInit = ResolveGSharpBaseConstructor(i => syntax.BaseConstructorArguments[i].Location, structSymbol.Name, baseClassSymbol, boundArguments, location);
            }

            scope = staticScope;
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
    private BaseConstructorInitializer ResolveClrBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        System.Type clrBase,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        TextLocation location,
        System.Func<int, ExpressionSyntax> argSyntax = null)
    {
        var ctors = ClrTypeUtilities.SafeGetConstructors(clrBase, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .Where(c => c.IsPublic || c.IsFamily || c.IsFamilyOrAssembly)
            .ToArray();

        var argTypes = new System.Type[boundArguments.Count];
        var argsAllTyped = true;
        for (var i = 0; i < boundArguments.Count; i++)
        {
            // Issue #530: use GetEffectiveArgumentClrType (see instance method path).
            // Issue #533: allow null (nil literal) through.
            var t = getEffectiveArgumentClrType(boundArguments[i].Type);
            if (t == null && boundArguments[i].Type != TypeSymbol.Null)
            {
                argsAllTyped = false;
                break;
            }

            argTypes[i] = t;
        }

        ConstructorInfo bestCtor = null;
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
            var resolution = OverloadResolution.Resolve(
                ctors,
                argTypes,
                interpolatedStringArgs: interpolatedStringArgs,
                constantNarrowingArgumentCheck: ExpressionBinder.MakeConstantNarrowingArgumentCheck(boundArguments),
                structuralProjectionArgumentCheck: ExpressionBinder.MakeStructuralProjectionArgumentCheck(boundArguments));
            switch (resolution.Outcome)
            {
                case OverloadResolution.ResolutionOutcome.Resolved:
                    bestCtor = resolution.Best as ConstructorInfo;
                    isExpanded = resolution.IsExpanded;
                    break;
                case OverloadResolution.ResolutionOutcome.Ambiguous:
                    Diagnostics.ReportAmbiguousOverload(location, clrBase.Name, resolution.Ambiguous.Length, resolution.Ambiguous.Select(OverloadResolution.FormatMethodSignature));
                    return null;
                default:
                    break;
            }
        }

        if (bestCtor == null)
        {
            Diagnostics.ReportNoMatchingBaseConstructor(location, clrBase.Name, boundArguments.Count);
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
                    && OverloadResolution.IsFormattableStringTarget(bestCtorParams[i].ParameterType))
                {
                    boundArguments[i] = bindInterpolatedStringAsFormattable(interpolated, targetType: null);
                }
            }
        }

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
        ImmutableArray<BoundExpression> orderedArgs;
        if (isExpanded)
        {
            var paramsIndex = ctorParams.Length - 1;
            var paramArrayType = ctorParams[paramsIndex].ParameterType;
            var elementClrType = paramArrayType.GetElementType();
            var elementTypeSymbol = elementClrType == null
                ? TypeSymbol.Object
                : TypeSymbol.FromClrType(elementClrType);
            var sliceType = SliceTypeSymbol.Get(elementTypeSymbol);

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
            orderedArgs = boundArguments.ToImmutable();
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
            var targetType = TypeSymbol.FromClrType(clrParamType);
            var argLoc = isExpanded && i == ctorParams.Length - 1
                ? location
                : argLocation(i);
            var orderedArg = orderedArgs[i];

            // Issue #506 follow-up: when the synthesised params array already
            // carries the exact CLR type of the parameter (SliceTypeSymbol(T)
            // → T[]), skip the rebinding so the emitter sees the original
            // array-creation expression without an extra conversion wrapper.
            if (orderedArg.Type?.ClrType != null && orderedArg.Type.ClrType == clrParamType)
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
    private static System.Collections.Generic.IReadOnlyList<bool> ComputeInterpolatedStringArgFlags(System.Func<int, ExpressionSyntax> argSyntax, int count)
    {
        if (argSyntax == null)
        {
            return null;
        }

        bool[] flags = null;
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
    private BaseConstructorInitializer ResolveGSharpBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        string derivedNameForDiag,
        StructSymbol baseClassSymbol,
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
        if (boundArguments.Count != baseParams.Length)
        {
            Diagnostics.ReportNoMatchingBaseConstructor(location, baseClassSymbol.Name, boundArguments.Count);
            return null;
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(boundArguments.Count);
        for (var i = 0; i < boundArguments.Count; i++)
        {
            var argument = boundArguments[i];
            var parameter = baseParams[i];
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
    private BaseConstructorInitializer ResolveGSharpExplicitBaseConstructor(
        System.Func<int, TextLocation> argLocation,
        StructSymbol baseClassSymbol,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        TextLocation location)
    {
        ConstructorSymbol best = null;
        ImmutableArray<TypeSymbol> bestParamTypes = default;
        var bestExactMatches = -1;
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
            if (paramTypes.Length != boundArguments.Count)
            {
                continue;
            }

            var applicable = true;
            var exactMatches = 0;
            for (var i = 0; i < paramTypes.Length; i++)
            {
                var argType = boundArguments[i].Type;
                var paramType = paramTypes[i];
                if (argType == paramType)
                {
                    exactMatches++;
                    continue;
                }

                // Error-typed arguments don't disqualify a candidate: a prior
                // diagnostic already explains the bad argument.
                if (argType == TypeSymbol.Error)
                {
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

            if (exactMatches > bestExactMatches)
            {
                best = candidate;
                bestParamTypes = paramTypes;
                bestExactMatches = exactMatches;
                ambiguous = false;
            }
            else if (exactMatches == bestExactMatches)
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

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(boundArguments.Count);
        for (var i = 0; i < boundArguments.Count; i++)
        {
            convertedArgs.Add(conversions.BindConversion(argLocation(i), boundArguments[i], bestParamTypes[i]));
        }

        return new BaseConstructorInitializer(convertedArgs.ToImmutable(), baseClassSymbol, best);
    }

    /// <summary>
    /// Issue #306: binds the standalone user-defined constructors (<c>init(...)</c>)
    /// declared in a class body. Each constructor becomes a <see cref="ConstructorSymbol"/>
    /// whose body is bound in <see cref="Binder.BindProgram(BoundGlobalScope, ReferenceResolver)"/> as an instance-method body and
    /// emitted/interpreted as a <c>.ctor</c>.
    /// </summary>
    private void BindConstructorDeclarations(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        PackageSymbol package,
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType)
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

        if (!structSymbol.IsClass)
        {
            return;
        }

        // ADR-0065 §5: when both a primary-constructor parameter list and
        // explicit `init(...)` bodies are declared, the primary constructor
        // becomes a synthesized designated initializer that participates in
        // the overload set alongside the explicit bodies. Duplicate signatures
        // are diagnosed below by the same overload-equality check that catches
        // collisions between two user-declared init overloads.
        ConstructorSymbol synthesizedPrimary = null;
        if (structSymbol.HasPrimaryConstructor)
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
                Diagnostics.ReportConvenienceInitMayNotCallBase(ctorSyntax.BaseKeyword.Location, structSymbol.Name);
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
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType)
    {
        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        var seenParameterNames = new HashSet<string>();
        foreach (var parameterSyntax in ctorSyntax.Parameters)
        {
            var parameterName = parameterSyntax.Identifier.Text;
            var parameterType = bindTypeClause(parameterSyntax.Type) ?? TypeSymbol.Error;

            // ADR-0101 follow-up / issue #812: variadic parameters are now
            // accepted on explicit `init(...)` constructors. The body sees
            // the parameter as `[]T`; constructor calls (and
            // `: this(...)` / `: base(...)` chaining) go through the
            // constructor overload paths that pack trailing arguments.
            var isVariadic = parameterSyntax.IsVariadic;
            if (isVariadic && parameterType != TypeSymbol.Error)
            {
                parameterType = SliceTypeSymbol.Get(parameterType);
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

        // Resolve the optional `: base(args)` initializer, with the constructor
        // parameters in scope so they can be forwarded to the base.
        //
        // Issue #1085: the argument expressions may construct other user types
        // whose explicit constructors are not yet populated when this type body
        // is bound (the constructed type may live in a source file processed
        // later). Defer the argument binding and base-constructor resolution to
        // a post-pass that runs after every declared type's constructors exist.
        if (ctorSyntax.HasBaseInitializer)
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
        StructSymbol baseClassSymbol,
        TypeSymbol importedBaseType)
    {
        var location = ctorSyntax.BaseKeyword.Location;

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
        BaseConstructorInitializer init = null;
        using (PushStaticMemberScope(structSymbol))
        {
            var staticScope = scope;
            scope = new BoundScope(staticScope);
            foreach (var p in ctorFunction.Parameters)
            {
                scope.TryDeclareVariable(p);
            }

            boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(ctorSyntax.BaseArguments.Count);
            for (var i = 0; i < ctorSyntax.BaseArguments.Count; i++)
            {
                boundArguments.Add(bindExpression(ctorSyntax.BaseArguments[i]));
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
                init = ResolveClrBaseConstructor(i => ctorSyntax.BaseArguments[i].Location, clrBase, boundArguments, location, i => ctorSyntax.BaseArguments[i]);
            }
            else
            {
                init = ResolveGSharpBaseConstructor(i => ctorSyntax.BaseArguments[i].Location, structSymbol.Name, baseClassSymbol, boundArguments, location);
            }

            scope = staticScope;
        }

        if (init != null)
        {
            constructorSymbol.SetBaseInitializer(init);
        }

        scope = savedScope;
        binderCtx.CurrentTypeParameters = savedTypeParameters;
    }
}
