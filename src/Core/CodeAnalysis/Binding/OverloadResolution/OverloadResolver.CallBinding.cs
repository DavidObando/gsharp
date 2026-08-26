// <copyright file="OverloadResolver.CallBinding.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding.OverloadResolution;

internal sealed partial class OverloadResolver
{
    /// <summary>
    /// Whether the referenced-assembly CLR <paramref name="type"/> declares a
    /// <c>public static</c> method named <paramref name="name"/> — used to select
    /// a static-import candidate for an unqualified call (ADR-0134, extended to
    /// imported CLR types).
    /// </summary>
    private static bool ClrTypeExposesStaticMethod(System.Type type, string name)
    {
        if (type == null)
        {
            return false;
        }

        foreach (var m in ClrTypeUtilities.SafeGetMethods(type, System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public))
        {
            if (ClrTypeUtilities.EmittedMemberNameMatches(m, name))
            {
                return true;
            }
        }

        return false;
    }

    private bool TryResolveImplicitInheritedTypeArguments(
        TypeArgumentListSyntax? typeArgumentList,
        out Type[]? clrTypeArguments,
        out ImmutableArray<TypeSymbol> typeArgumentSymbols)
    {
        clrTypeArguments = null;
        typeArgumentSymbols = default;
        if (typeArgumentList == null)
        {
            return true;
        }

        clrTypeArguments = new Type[typeArgumentList.Arguments.Count];
        var symbols = ImmutableArray.CreateBuilder<TypeSymbol>(typeArgumentList.Arguments.Count);
        for (var i = 0; i < typeArgumentList.Arguments.Count; i++)
        {
            var symbol = bindTypeClause(typeArgumentList.Arguments[i]);
            if (symbol == null)
            {
                return false;
            }

            symbols.Add(symbol);
            var clrType = NullableLifting.GetEffectiveClrType(symbol);
            clrTypeArguments[i] = clrType != null
                ? binderCtx.References.MapClrTypeToReferences(clrType)
                : binderCtx.References.GetCoreType("System.Object");
        }

        typeArgumentSymbols = symbols.MoveToImmutable();
        return true;
    }

    /// <summary>
    /// Issue #1159: returns the implicit-<c>this</c> parameter that an
    /// unqualified instance-member reference should bind against. For a direct
    /// instance method (or interface default method) body this is the enclosing
    /// function's own <see cref="FunctionSymbol.ThisParameter"/>. Inside a
    /// lambda body the enclosing function is a synthetic
    /// <see cref="FunctionSymbol"/> with no receiver, so we fall back to the
    /// <c>this</c> that is still visible in the current lexical scope — the
    /// enclosing instance method's <c>this</c>, which the lambda's child scope
    /// inherits and which capture analysis already captures into the display
    /// class (mirroring how explicit <c>this.X</c> and bare field/property
    /// reads already work and capture). In a static context no <c>this</c> is
    /// in scope, so this returns <see langword="null"/> and unqualified
    /// resolution stays unchanged.
    /// </summary>
    private ParameterSymbol? GetEffectiveThisParameter()
    {
        if (binderCtx.InConstructorInitializer)
        {
            return null;
        }

        var current = getCurrentFunction();
        if (current?.ThisParameter != null)
        {
            return current.ThisParameter;
        }

        return Scope.TryLookupSymbol("this") as ParameterSymbol;
    }

    /// <summary>
    /// Issue #3487: the lexical owner for implicit static-self dispatch. A
    /// member body carries it as the function's own <c>StaticOwnerType</c>; a
    /// function literal nested in that body has a synthetic symbol with no
    /// <c>StaticOwnerType</c>, only the <c>LexicalEnclosingType</c> chained
    /// through <c>LambdaBinder.ResolveLexicalEnclosingType</c> — falling back
    /// to it makes bare sibling <c>shared</c> calls resolve identically in
    /// both positions (they already did inside instance-method lambdas via
    /// the effective-<c>this</c> path).
    /// </summary>
    private TypeSymbol? GetImplicitStaticSelfOwner()
    {
        var current = getCurrentFunction();
        return current?.ThisParameter != null
            ? null
            : current?.StaticOwnerType ?? current?.LexicalEnclosingType;
    }

    private StructSymbol? GetConstructorInitializerReceiverType()
    {
        return (getCurrentFunction()?.ReceiverType as StructSymbol)
            ?? ((Scope.TryLookupSymbol("this") as ParameterSymbol)?.Type as StructSymbol);
    }

    /// <summary>
    /// ADR-0063: thin wrapper around <see cref="SelectBestInstanceOverload"/>
    /// that reports the standard ambiguity / no-applicable-overload diagnostics
    /// when more than one candidate is supplied. When a single candidate is
    /// supplied the wrapper returns it unchanged so legacy single-overload
    /// callsites keep their existing diagnostics (wrong arity, etc.).
    /// </summary>
    /// <summary>
    /// Issue #1626: finalizes an implicit static-self dispatch (a bare
    /// <c>Helper(args)</c> call resolved inside a static interface/struct
    /// helper body) once <see cref="SelectInstanceOverloadOrReport"/> has
    /// picked <paramref name="method"/>. That selector returns a lone
    /// candidate with NO applicability check, so this helper — mirroring the
    /// arity/named-argument handling every other static-call finalizer
    /// performs — validates argument count and reorders named arguments
    /// before converting, instead of indexing <c>method.Parameters</c>
    /// positionally and risking an out-of-range crash (too many args) or an
    /// invalid short <see cref="BoundCallExpression"/> (too few args).
    /// </summary>
    /// <remarks>
    /// ponytail: this is only reached when <see cref="bindUserTypeStaticCall"/>
    /// is <see langword="null"/> (e.g. an <see cref="OverloadResolver"/> built
    /// directly, without the production callback wiring). The real binder
    /// always supplies <c>bindUserTypeStaticCall</c>, which gives full
    /// optional/variadic/generic fidelity via <c>BindUserTypeStaticCall</c>;
    /// this fallback only needs to be crash-safe, not feature-complete.
    /// </remarks>
    private BoundExpression BindImplicitStaticSelfCallFallback(
        FunctionSymbol method,
        CallExpressionSyntax syntax,
        ImmutableArray<BoundExpression> boundArguments,
        ImmutableArray<string> argumentNames)
    {
        var parameterCount = method.Parameters.Length;
        Func<int, string> parameterNameAt = parameterIndex => method.Parameters[parameterIndex].Name;
        if (boundArguments.Length != parameterCount)
        {
            Diagnostics.ReportWrongArgumentCount(syntax.Location, method.Name, parameterCount, boundArguments.Length);
            return new BoundErrorExpression(null);
        }

        ExpressionSyntax?[] permutedSyntax;
        ImmutableArray<BoundExpression> permutedArguments;
        if (!argumentNames.IsDefault)
        {
            if (!TryReorderUserCallArguments(
                    syntax.Arguments,
                    boundArguments,
                    parameterCount,
                    parameterNameAt,
                    method.Name,
                    out permutedSyntax,
                    out permutedArguments))
            {
                return new BoundErrorExpression(null);
            }
        }
        else
        {
            permutedSyntax = new ExpressionSyntax[syntax.Arguments.Count];
            for (var i = 0; i < syntax.Arguments.Count; i++)
            {
                permutedSyntax[i] = syntax.Arguments[i];
            }

            permutedArguments = boundArguments;
        }

        var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(parameterCount);
        for (var ai = 0; ai < parameterCount; ai++)
        {
            convertedArgs.Add(conversions.BindConversion(
                Invariant.Required(permutedSyntax[ai], "a reordered call argument has source syntax").Location,
                permutedArguments[ai],
                method.Parameters[ai].Type));
        }

        var finalArguments = PreserveNamedArgumentEvaluationOrder(
            syntax.Arguments,
            convertedArgs.MoveToImmutable(),
            parameterNameAt);
        return new BoundCallExpression(null, method, finalArguments);
    }

    /// <summary>
    /// Issue #2403: whether <paramref name="syntax"/>'s unqualified callee name
    /// could resolve to a genuine non-constructor callable — a same-compilation
    /// free/extension <see cref="FunctionSymbol"/> reachable through
    /// <see cref="Scope"/>, or an implicit-<c>this</c> instance/static sibling
    /// method (including a private one) on the enclosing struct/class or
    /// interface body, or an inherited CLR method on the implicit receiver —
    /// checked BEFORE the CLR constructor/conversion
    /// fallbacks a few lines below in <see cref="BindCallExpression"/> run. A
    /// same-named imported CLR type (e.g. <c>System.Net.Http.HttpClient</c>)
    /// must not shadow a colliding user method in call position, mirroring how
    /// a same-named source method always wins over an imported CLR type in
    /// C#.
    /// </summary>
    /// <remarks>
    /// Only the EXISTENCE of a same-named candidate is checked here — not full
    /// overload applicability (argument count/types). That is intentional:
    /// when this returns <see langword="true"/>, <see cref="BindCallExpression"/>
    /// simply skips the CLR early-return paths and falls through to its
    /// ordinary implicit-<c>this</c> / symbol-lookup call-binding logic further
    /// down, which already performs full overload selection via
    /// <see cref="SelectUnifiedInstanceStaticOverload"/> / <see cref="SelectInstanceOverloadOrReport"/>
    /// / <see cref="SelectBestUserOverload"/> and reports the correct
    /// diagnostic (wrong-argument-count, ambiguity, ...) against the genuine
    /// user candidate — so no overload-resolution logic is duplicated here.
    /// When no such candidate exists, this returns <see langword="false"/> and
    /// the CLR paths run exactly as before, so genuine constructor/conversion
    /// calls (e.g. `StringBuilder(16)`) are unaffected.
    /// </remarks>
    private bool HasNonConstructorCallableCandidate(CallExpressionSyntax syntax)
    {
        var name = syntax.Identifier.Text;

        // A same-compilation free function or extension function (extension
        // functions are flattened into the global function table — issue
        // #1103) is directly visible through the scope's symbol table.
        if (Scope.TryLookupSymbol(name) is FunctionSymbol)
        {
            return true;
        }

        // Issue #1159: the implicit `this` an unqualified instance-member
        // reference would bind against (mirrors GetEffectiveThisParameter's
        // callers below).
        var effThis = GetEffectiveThisParameter();
        if (effThis?.Type is StructSymbol receiverStruct)
        {
            // Issue #1147: an unqualified call inside an instance method
            // resolves against the COMBINED instance + static (`shared`)
            // overload set of the enclosing type — mirror that union here.
            if (!TypeMemberModel.GetMethods(receiverStruct, name, MemberQuery.Instance(MemberKinds.Method)).IsDefaultOrEmpty
                || !TypeMemberModel.GetMethods(receiverStruct, name, MemberQuery.Static(MemberKinds.Method)).IsDefaultOrEmpty)
            {
                return true;
            }

            // An imported type with the same simple name as an inherited CLR
            // method must not turn an implicit-receiver call into construction.
            var inheritedClr = ExpressionBinder.GetInheritedClrBaseType(receiverStruct) ?? typeof(object);
            if (MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(inheritedClr, name).Count > 0)
            {
                return true;
            }
        }
        else if (effThis?.Type is InterfaceSymbol receiverIface)
        {
            // ADR-0085 / ADR-0090: implicit `this` inside an interface default
            // method body also sees the interface's own private helpers.
            if (!TypeMemberModel.GetMethods(receiverIface, name, MemberQuery.Instance(MemberKinds.Method)).IsDefaultOrEmpty
                || receiverIface.GetPrivateMethods(name).Length > 0)
            {
                return true;
            }
        }

        if (getCurrentFunction()?.ThisParameter == null)
        {
            // ADR-0089 / ADR-0090: implicit static-self dispatch inside a
            // static-virtual or private-static interface helper body.
            if (GetImplicitStaticSelfOwner() is InterfaceSymbol staticIface)
            {
                if (!TypeMemberModel.GetMethods(staticIface, name, MemberQuery.Static(MemberKinds.Method)).IsDefaultOrEmpty
                    || staticIface.GetStaticPrivateMethods(name).Length > 0)
                {
                    return true;
                }
            }
            else if (GetImplicitStaticSelfOwner() is StructSymbol staticStruct)
            {
                // Issue #1585: implicit static-self dispatch inside a
                // `shared` method body of a user struct/class.
                if (!TypeMemberModel.GetMethods(staticStruct, name, MemberQuery.Static(MemberKinds.Method)).IsDefaultOrEmpty)
                {
                    return true;
                }
            }
        }

        return false;
    }

    public BoundExpression BindCallExpression(CallExpressionSyntax syntax)
    {
        if (syntax.ConversionTypeClause != null)
        {
            var compositeConversionType = bindTypeClause(syntax.ConversionTypeClause);
            if (compositeConversionType == null)
            {
                return new BoundErrorExpression(syntax);
            }

            if (syntax.Arguments.Count != 1)
            {
                Diagnostics.ReportWrongArgumentCount(
                    syntax.ConversionTypeClause.Location,
                    compositeConversionType.Name,
                    expectedCount: 1,
                    actualCount: syntax.Arguments.Count);
                return new BoundErrorExpression(syntax);
            }

            reportObsoleteUseIfApplicable(
                syntax.ConversionTypeClause.Location,
                compositeConversionType,
                compositeConversionType.Name);
            return conversions.BindConversion(
                syntax.Arguments[0],
                compositeConversionType,
                allowExplicit: true);
        }

        // Issue #2185: an indirect invocation whose callee is an arbitrary
        // function-typed expression (`(expr)(args)`, `expr!!(args)`, a curried
        // `f()(x)`, ...). The parser tags these with a non-null Callee (there is
        // no identifier to resolve), so dispatch on the bound callee expression's
        // (narrowed / null-forgiven) type rather than any syntactic callee shape.
        if (syntax.Callee != null)
        {
            return BindIndirectCallExpression(syntax);
        }

        // Issue #3421 review: `cast[T](value)` is the unambiguous,
        // constructor-independent explicit-conversion form. Bind it before
        // callable/type lookup so no symbol named `cast` can redirect it.
        if (syntax.Identifier.Text == "cast"
            && tryBindIntrinsicCall(syntax, out var checkedCast))
        {
            return checkedCast;
        }

        // ADR-0065 §2: a bare `init(args)` call inside a constructor body is
        // a self-delegation to a sibling constructor on the same aggregate. This
        // is the only legal use of `init` as a callable identifier. Recognise
        // it before any other call-binding path so the generic identifier
        // fallback at the bottom doesn't surface a misleading "unknown
        // function" diagnostic.
        if (syntax.TypeArgumentList == null
            && syntax.Identifier.Kind == SyntaxKind.IdentifierToken
            && syntax.Identifier.Text == "init")
        {
            var inCtor = getCurrentFunction();
            if (inCtor != null
                && inCtor.IsSpecialName
                && inCtor.Name == ".ctor"
                && inCtor.ReceiverType is StructSymbol owningClass
                && !owningClass.ExplicitConstructors.IsDefaultOrEmpty)
            {
                return BindConstructorChainingExpression(syntax, owningClass, inCtor);
            }
        }

        // Issue #2403 / #2549: a resolvable non-constructor callable (same-compilation
        // free/extension function, or an implicit-`this` instance/static
        // sibling/inherited CLR method) with this name takes precedence over ALL THREE CLR
        // constructor/conversion fallback paths below, mirroring how a
        // same-named source method always shadows a colliding imported CLR
        // type (e.g. `System.Net.Http.HttpClient`) in call position. Computed
        // once and reused by all three gates; see HasNonConstructorCallableCandidate's
        // remarks for why only existence (not full overload applicability) is
        // checked here.
        var hasNonConstructorCallable = HasNonConstructorCallableCandidate(syntax);

        // Issue #1263: when the construction carries an explicit type-argument
        // list (`Op[int32](5)`), resolve the constructed type by (name, arity)
        // so a non-generic `Op` and a generic `Op[T]` can coexist. With no type
        // arguments the arity is -1 ("no preference"), preferring the arity-0
        // type — so `Op(...)` keeps picking the non-generic `Op`. This reuses
        // the same #1051 arity-keyed type-alias lookup the type-reference and
        // struct-literal paths already use.
        var ctorPreferredArity = syntax.TypeArgumentList != null
            ? syntax.TypeArgumentList.Arguments.Count
            : -1;

        // Issue #2455: a genuinely resolvable SOURCE type alias (a struct or
        // class declared in THIS compilation, via BoundScope.TryLookupTypeAlias
        // — which never sees CLR-imported types) that is itself constructible
        // takes precedence over CLR-imported-class construction a few lines
        // below, mirroring (a) how a same-named source function/method already
        // shadows a colliding imported CLR type in call position
        // (HasNonConstructorCallableCandidate, issue #2403), and (b) how the
        // struct/class-literal binder (BindStructLiteralExpression) already
        // checks TryLookupTypeAlias before ever falling back to
        // TryLookupImportedClass. Without this, `Type(...)` for a same-simple-
        // name source struct/class colliding with an imported CLR class (e.g.
        // a package-qualified source construction like
        // `Oahu.Audible.Json.ChapterInfo()` peeled and rebound by simple name
        // — see TryBindQualifiedSourceTypeConstruction) always constructed the
        // CLR type, never the source one, regardless of import order,
        // qualification, or the qualified-construction package hint — because
        // tryBindClrConstructorCall/TryLookupImportedClass ran unconditionally
        // before the source-type-alias checks further down ever got a chance.
        // Issue #3466: a nested source type keeps that precedence only inside
        // its containing lexical scope; outside it, an explicit alias or
        // same-named top-level import remains the visible constructor target.
        bool hasImportedType = Scope.TryLookupImportedClassByArity(
                syntax.Identifier.Text,
                ctorPreferredArity,
                declaration: null,
                out var importedCtorCandidate);
        var hasSourceConstructibleType = binderCtx.TryLookupSourceType(
                Scope,
                syntax.Identifier.Text,
                ctorPreferredArity,
                getCurrentFunction(),
                out var sourceCtorCandidate,
                out _)
            && sourceCtorCandidate is StructSymbol sourceCtorStruct
            && !(hasImportedType
                && binderCtx.ImportedTypeOverridesSourceType(
                    Scope,
                    syntax.Identifier.Text,
                    sourceCtorStruct,
                    ctorPreferredArity,
                    getCurrentFunction(),
                    importedCtorCandidate!.ClassType))
            && (ctorPreferredArity < 0
                || (sourceCtorStruct.IsGenericDefinition
                    ? sourceCtorStruct.TypeParameters.Length
                    : 0) == ctorPreferredArity)
            && (sourceCtorStruct.IsClass
                || sourceCtorStruct.IsInline
                || sourceCtorStruct.HasPrimaryConstructor
                || !sourceCtorStruct.ExplicitConstructors.IsDefaultOrEmpty);

        // Phase 4-exit: prefer CLR class instantiation over the single-arg
        // conversion-call hijack below, so that `StringBuilder(16)` resolves
        // to a CLR ctor rather than `conversions.BindConversion(int → StringBuilder)`.
        // Also handles closed-generic imports (`List[int]()`,
        // `Dictionary[string, int]()`). Interpreter-only — resolves a
        // ConstructorInfo and emits BoundClrConstructorCallExpression.
        if (!hasNonConstructorCallable
            && !hasSourceConstructibleType
            && tryBindClrConstructorCall(syntax, out var clrCtorCall))
        {
            return clrCtorCall;
        }

        var conversionType = lookupTypeWithArity(
            syntax.Identifier.Text,
            ctorPreferredArity);
        var hasSingleInlineOutArgument = syntax.Arguments.Count == 1
            && UnwrapNamedArgumentValue(syntax.Arguments[0])
                is RefArgumentExpressionSyntax { IsInlineDeclaration: true };
        if (!hasNonConstructorCallable
            && syntax.Arguments.Count == 1
            && !hasSingleInlineOutArgument
            && conversionType is TypeSymbol)
        {
            var explicitConversionType = TryConstructConversionTarget(
                syntax,
                conversionType);
            if (explicitConversionType == null)
            {
                return new BoundErrorExpression(syntax);
            }

            // Issue #663: when the call carries a `?` token (e.g. `string?(x)`),
            // wrap the resolved type in NullableTypeSymbol so the conversion
            // targets the nullable form.
            if (syntax.NullableQuestionToken != null)
            {
                explicitConversionType = NullableTypeSymbol.Get(explicitConversionType);
            }

            // A class exposing a one-argument constructor shape reserves
            // `T(value)` for construction. `cast[T](value)` is the unambiguous
            // checked-cast spelling when construction and conversion overlap.
            // This decision uses declaration shape only: binding the argument
            // speculatively here and again in the constructor binder can
            // duplicate capture/spill state even if diagnostics are truncated.
            var singleArgClass = conversionType as StructSymbol;
            var typeArgumentsMatchConversionTarget = syntax.TypeArgumentList == null
                || (singleArgClass is { IsGenericDefinition: true }
                    && syntax.TypeArgumentList.Arguments.Count == singleArgClass.TypeParameters.Length);
            if (singleArgClass != null
                && singleArgClass.IsClass
                && typeArgumentsMatchConversionTarget
                && (syntax.NullableQuestionToken != null
                    || !HasSingleArgumentConstructorShape(singleArgClass)))
            {
                reportObsoleteUseIfApplicable(
                    syntax.Identifier.Location,
                    explicitConversionType,
                    explicitConversionType.Name);
                return conversions.BindConversion(
                    syntax.Arguments[0],
                    explicitConversionType,
                    allowExplicit: true);
            }

            if (syntax.NullableQuestionToken != null
                || !(conversionType is StructSymbol constructibleSingleArgStruct
                  && (constructibleSingleArgStruct.IsClass
                      || constructibleSingleArgStruct.IsInline
                      || constructibleSingleArgStruct.HasPrimaryConstructor
                      || !constructibleSingleArgStruct.ExplicitConstructors.IsDefaultOrEmpty)))
            {
                // ADR-0047 §6 / #175: `Type(x)` as an explicit conversion
                // is still a use of the named type.
                reportObsoleteUseIfApplicable(
                    syntax.Identifier.Location,
                    explicitConversionType,
                    explicitConversionType.Name);
                return conversions.BindConversion(
                    syntax.Arguments[0],
                    explicitConversionType,
                    allowExplicit: true);
            }
        }

        // Phase 3.B.3 sub-step 2: `ClassName(arg1, arg2, ...)` invokes the
        // class's primary constructor when the call target resolves to a
        // class type with a declared primary ctor. Issue #524: a class
        // declaring no explicit `init(...)` and no primary constructor is
        // still constructible via `ClassName()` against the synthesized
        // parameterless default constructor — the emitter already produces
        // a `.ctor()` for such classes (see EmitClassDefaultConstructor),
        // so we just need the binder to route `ClassName()` through here.
        // Issue #1069: a value struct (e.g. a `data struct`) declaring a
        // primary constructor is also positionally constructible —
        // `Entry(1, 2)` lowers to a struct literal initializing its fields.
        if (!hasNonConstructorCallable
            && lookupTypeWithArity(syntax.Identifier.Text, ctorPreferredArity) is StructSymbol classType
            && (classType.IsClass
                || classType.IsInline
                || classType.HasPrimaryConstructor
                || !classType.ExplicitConstructors.IsDefaultOrEmpty))
        {
            return BindConstructorCallExpression(syntax, classType);
        }

        // Issue #988: `T()` constructs the type parameter `T` when the enclosing
        // generic declares an `init()` default-constructor constraint (`[T init()]`).
        // Lowered to a reified `Activator.CreateInstance<T>()` (ADR-0087). A
        // type parameter has no user-callable members, so a zero-argument call
        // to it can only mean construction. When the `init()` constraint is
        // absent we cannot guarantee an accessible parameterless constructor, so
        // report GS0389 pointing at the missing constraint.
        if (syntax.Arguments.Count == 0
            && syntax.TypeArgumentList == null
            && lookupType(syntax.Identifier.Text) is TypeParameterSymbol typeParam)
        {
            if (typeParam.HasDefaultConstructorConstraint)
            {
                return new BoundTypeParameterConstructionExpression(syntax, typeParam);
            }

            Diagnostics.ReportConstructedTypeParameterRequiresNewConstraint(
                syntax.Identifier.Location, typeParam.Name);
            return new BoundErrorExpression(null);
        }

        if (tryBindIntrinsicCall(syntax, out var intrinsic))
        {
            return intrinsic;
        }

        // Issue #343: pre-validate named-argument layout (positional precedes
        // named, no duplicate names). Errors are reported by the helper so the
        // call short-circuits to a bound error here.
        if (!TryAnalyzeCallArgumentLayout(syntax.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();

        // Issue #951: untyped arrow lambdas whose binding
        // is deferred until the callee's parameter types are known, so the
        // target delegate shape can drive lambda-parameter-type inference.
        // Without the deferral the lambda binds with no target, reports GS0304
        // ("cannot infer parameter type"), and aborts the call — even though
        // the parameter (e.g. `Func[int32, int32]` / `(int32) -> int32`)
        // fully determines the lambda's shape.
        HashSet<LambdaExpressionSyntax>? deferredArrowLambdas = null;

        // ADR-0060: argument binding needs the matching parameter to resolve
        // inline `out var`/`out let`/`out _` payloads. For free-function calls
        // we don't have the FunctionSymbol resolved until below, so we first
        // bind everything with parameter=null (the inline-out form falls back
        // to its declared type) and patch up the type later. The plain
        // lvalue ref/in/out form is parameter-independent.
        foreach (var argument in syntax.Arguments)
        {
            // Issue #343: a named-argument wrapper carries the value expression
            // we want to bind; unwrap it so the value is bound on its own.
            var argSyntax = UnwrapNamedArgumentValue(argument);
            var lambdaSyntax = GetLambdaArgumentSyntax(argSyntax);
            BoundExpression boundArgument;
            if (argSyntax is RefArgumentExpressionSyntax refArg)
            {
                // The first binding pass has no resolved parameter for inline out arguments.
                boundArgument = bindRefArgumentExpression(refArg, null);
            }
            else if (bindLambdaWithTarget != null
                && lambdaSyntax is { } deferredLambda
                && IsUntypedArrowLambda(deferredLambda))
            {
                // Issue #951: defer; bind once the parameter delegate target is
                // known (per-position loop below). A placeholder carrying the
                // lambda syntax keeps argument positions aligned.
                (deferredArrowLambdas ??= new HashSet<LambdaExpressionSyntax>())
                    .Add(deferredLambda);
                boundArgument = new BoundErrorExpression(deferredLambda);
            }
            else
            {
                boundArgument = BindOverloadArgumentValue(argSyntax);
            }

            boundArguments.Add(boundArgument);
        }

        var symbol = Scope.TryLookupSymbol(syntax.Identifier.Text);

        // Issue #2066: a smart-cast null-guard (`if x != nil { x(...) }`)
        // narrows the static type seen by a bare *read* of `x`, but the direct
        // call-syntax checks below key off the declared `VariableSymbol.Type`
        // (still `T?`) rather than any bound/narrowed read. Without this,
        // `snapshot(count)` on a null-guarded `TickHandler?` local fails to
        // match the function/delegate call branches and reports "not a
        // function". Mirror the narrowing lookup the name-expression path
        // uses (see ExpressionBinder.TryGetNarrowedType) so a narrowed
        // nullable local dispatches through the same call paths as an
        // already non-nullable one.
        var narrowedCallTargetType = symbol is VariableSymbol callTargetVariable
            ? TryGetNarrowedVariableType(callTargetVariable)
            : null;

        // Issue #1566: an accessible in-scope member of the enclosing type
        // shadows a same-named top-level EXTENSION function for an unqualified,
        // receiver-less call — mirroring C#, where an in-scope member hides an
        // extension method. Extension functions are flattened into the global
        // function table (issue #1103) so `TryLookupSymbol` returns them for
        // free-call syntax; when the resolved name denotes only extension
        // function(s), route through the implicit-`this` member-resolution path
        // first. If the enclosing type exposes no matching member the block
        // falls through and the extension binds exactly as before (so both the
        // receiver-form `x.Ext(...)` and free-call extension usage, and calls
        // from types with no such member, are unaffected).
        var resolvedIsExtensionOnly = symbol is FunctionSymbol
            && IsAllExtensionOverloadSet(syntax.Identifier.Text);
        if (symbol == null || resolvedIsExtensionOnly)
        {
            if (binderCtx.InConstructorInitializer
                && GetConstructorInitializerReceiverType() is { } initializerReceiverType)
            {
                var staticMethods = TypeMemberModel.GetMethods(
                    initializerReceiverType,
                    syntax.Identifier.Text,
                    MemberQuery.Static(MemberKinds.Method));
                if (!staticMethods.IsDefaultOrEmpty)
                {
                    if (bindUserTypeStaticCall != null)
                    {
                        return bindUserTypeStaticCall(initializerReceiverType, syntax);
                    }

                    var staticMethod = SelectInstanceOverloadOrReport(
                        staticMethods,
                        boundArguments.ToImmutable(),
                        syntax,
                        syntax.Identifier.Text,
                        argumentNames);
                    if (staticMethod == null)
                    {
                        return new BoundErrorExpression(syntax);
                    }

                    return BindImplicitStaticSelfCallFallback(
                        staticMethod,
                        syntax,
                        boundArguments.ToImmutable(),
                        argumentNames);
                }
                else if (!TypeMemberModel.GetMethods(
                        initializerReceiverType,
                        syntax.Identifier.Text,
                        MemberQuery.Instance(MemberKinds.Method)).IsDefaultOrEmpty)
                {
                    Diagnostics.ReportConstructorInitializerCannotReferenceInstanceMember(
                        syntax.Identifier.Location,
                        syntax.Identifier.Text);
                    return new BoundErrorExpression(syntax);
                }
            }

            // Implicit `this`: if we are inside an instance method body and the
            // name matches a sibling method on the receiver type, dispatch via
            // `this.<method>(args)` automatically.
            // Issue #1159: `effThis` is the enclosing instance method's `this`
            // even when this call sits inside a lambda body (whose synthetic
            // enclosing function carries no receiver), so unqualified
            // enclosing-instance member calls resolve and capture `this`.
            var effThis = GetEffectiveThisParameter();
            if (effThis != null
                && effThis.Type is StructSymbol implicitReceiverStruct)
            {
                // Issue #1147 (Facet B): an unqualified same-named call inside an
                // instance method resolves against the COMBINED instance + static
                // (`shared`) overload set of the enclosing type — mirroring C#'s
                // unified overload resolution — instead of seeing only instance
                // overloads. The selected method's IsStatic routes emission.
                var implicitMethod = SelectUnifiedInstanceStaticOverload(
                    implicitReceiverStruct,
                    syntax.Identifier.Text,
                    boundArguments.ToImmutable(),
                    syntax,
                    argumentNames,
                    out var implicitHasCandidates);
                if (implicitHasCandidates)
                {
                    if (implicitMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    if (implicitMethod.IsStatic)
                    {
                        // Resolved to a same-named static sibling: finalize as a
                        // static user call (full optional/variadic/generic
                        // fidelity via the shared static-call finalizer).
                        if (bindUserTypeStaticCall != null)
                        {
                            return bindUserTypeStaticCall(implicitReceiverStruct, syntax);
                        }

                        return BindImplicitStaticSelfCallFallback(implicitMethod, syntax, boundArguments.ToImmutable(), argumentNames);
                    }

                    var implicitReceiver = new BoundVariableExpression(null, effThis);
                    return BindUserInstanceCall(implicitReceiver, implicitMethod, boundArguments.ToImmutable(), syntax, argumentNames);
                }

                // Issue #1136: a bare (implicit-`this`) call such as `GetType()`
                // inside an instance method must resolve as `this.GetType()`
                // against the universally-inherited System.Object members when
                // no sibling user method matches. Falls back to typeof(object)
                // (or the explicit imported base if present); the helper returns
                // false for any name Object does not define, so the GS0130 path
                // below still fires for genuinely undefined functions.
                // Issue #2210: walk the transitive G# base-class chain (issue
                // #1582's helper) rather than only `implicitReceiverStruct`'s
                // own ImportedBaseType, so an unqualified call to a method
                // inherited from a metadata base reached through one or more
                // G#-defined base classes resolves — matching the qualified
                // `this.Method(...)` path and G#-defined-base behavior.
                if (!TryResolveImplicitInheritedTypeArguments(
                    syntax.TypeArgumentList,
                    out var inheritedClrTypeArgs,
                    out var inheritedTypeArgSymbols))
                {
                    return new BoundErrorExpression(null);
                }

                var implicitBaseClr = ExpressionBinder.GetInheritedClrBaseType(implicitReceiverStruct) ?? typeof(object);
                var implicitReceiverExpr = new BoundVariableExpression(null, effThis);

                // The callback uses null to mean that no explicit type arguments were supplied.
                if (tryBindInheritedClrInstanceCall(implicitReceiverExpr, implicitBaseClr, syntax.Identifier.Text, boundArguments.ToImmutable(), syntax, out var implicitInheritedCall, inheritedClrTypeArgs, inheritedTypeArgSymbols, argumentNames, allowProtectedInherited: true))
                {
                    return implicitInheritedCall;
                }
            }

            // ADR-0085 / ADR-0090 implicit `this` inside an interface default
            // method body. The body's enclosing function is a DIM whose
            // ReceiverType is the owning InterfaceSymbol; an unqualified call
            // (`Helper(args)`) should resolve to a sibling method on the same
            // interface. The visibility rule from ADR-0090 applies: callers
            // inside the interface see both the public surface and the
            // private helpers; external callers go through the receiver-typed
            // path which does its own GS0334 check.
            if (effThis != null
                && effThis.Type is InterfaceSymbol implicitReceiverIface)
            {
                var implicitIfaceOverloads = TypeMemberModel.GetMethods(implicitReceiverIface, syntax.Identifier.Text, MemberQuery.Instance(MemberKinds.Method));
                var implicitPrivateIfaceOverloads = implicitReceiverIface.GetPrivateMethods(syntax.Identifier.Text);
                if (implicitPrivateIfaceOverloads.Length > 0)
                {
                    implicitIfaceOverloads = implicitIfaceOverloads.AddRange(implicitPrivateIfaceOverloads);
                }

                if (implicitIfaceOverloads.Length > 0)
                {
                    var implicitIfaceMethod = SelectInstanceOverloadOrReport(implicitIfaceOverloads, boundArguments.ToImmutable(), syntax, syntax.Identifier.Text, argumentNames);
                    if (implicitIfaceMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    var implicitReceiver = new BoundVariableExpression(null, effThis);
                    return BindUserInstanceCall(implicitReceiver, implicitIfaceMethod, boundArguments.ToImmutable(), syntax, argumentNames);
                }

                // Issue #2600: an interface default method's implicit `this`
                // also exposes System.Object members. This is the bare-call
                // counterpart of the qualified interface-receiver fallback
                // from issue #2304 and applies in every expression context,
                // including interpolation holes.
                var implicitObjectReceiver = new BoundVariableExpression(null, effThis);

                // The callback uses null to mean that no explicit type arguments were supplied.
                if (tryBindInheritedClrInstanceCall(implicitObjectReceiver, typeof(object), syntax.Identifier.Text, boundArguments.ToImmutable(), syntax, out var implicitObjectCall, null, default, argumentNames))
                {
                    return implicitObjectCall;
                }
            }

            // ADR-0089 / ADR-0090: implicit static-self dispatch inside a
            // static-virtual or private-static interface helper body. The
            // enclosing function has no `this` parameter but
            // <c>StaticOwnerType</c> set to the owning InterfaceSymbol. An
            // unqualified call resolves against the interface's static
            // (public + private) buckets.
            if (GetImplicitStaticSelfOwner() is InterfaceSymbol implicitStaticIface)
            {
                var implicitStaticOverloads = TypeMemberModel.GetMethods(implicitStaticIface, syntax.Identifier.Text, MemberQuery.Static(MemberKinds.Method));
                var implicitStaticPrivateOverloads = implicitStaticIface.GetStaticPrivateMethods(syntax.Identifier.Text);
                if (implicitStaticPrivateOverloads.Length > 0)
                {
                    implicitStaticOverloads = implicitStaticOverloads.AddRange(implicitStaticPrivateOverloads);
                }

                if (implicitStaticOverloads.Length > 0)
                {
                    var implicitStaticMethod = SelectInstanceOverloadOrReport(implicitStaticOverloads, boundArguments.ToImmutable(), syntax, syntax.Identifier.Text, argumentNames);
                    if (implicitStaticMethod == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    // Issue #1626: `implicitStaticMethod` may be a private static
                    // helper (only visible from inside the interface body, via
                    // `GetStaticPrivateMethods` above) that the shared
                    // `bindUserTypeStaticCall` finalizer cannot see — its own
                    // member lookup only walks the public `StaticMethods`
                    // bucket. Finalize directly here instead, but through the
                    // same arity/named-argument-safe helper the struct
                    // static-self path (above) falls back to, so a lone
                    // candidate can no longer be indexed past its parameter
                    // list.
                    return BindImplicitStaticSelfCallFallback(implicitStaticMethod, syntax, boundArguments.ToImmutable(), argumentNames);
                }
            }

            // Issue #1585: implicit static-self dispatch inside a `shared`
            // (static) method body of a user struct/class. The enclosing
            // function has no `this` parameter but carries <c>StaticOwnerType</c>
            // = the owning StructSymbol. An unqualified call (`Helper(args)` /
            // `Helper[T](args)`) must resolve against the type's own static
            // (`shared`) method group — mirroring both the qualified
            // `Type.Helper(args)` path and the instance-body bare-call path
            // (issue #1147), which already reach sibling statics. Routing
            // through the shared static-call finalizer (`bindUserTypeStaticCall`)
            // gives full private/overload/optional/variadic/generic fidelity and
            // walks the same base-type chain as the qualified path. The method
            // group is fetched through the canonical member-resolution layer
            // (ADR-0112) so it holds under both reference resolvers.
            if (GetImplicitStaticSelfOwner() is StructSymbol implicitStaticStruct
                && bindUserTypeStaticCall != null)
            {
                var implicitStaticStructOverloads = TypeMemberModel.GetMethods(
                    implicitStaticStruct,
                    syntax.Identifier.Text,
                    MemberQuery.Static(MemberKinds.Method));
                if (!implicitStaticStructOverloads.IsDefaultOrEmpty)
                {
                    return bindUserTypeStaticCall(implicitStaticStruct, syntax);
                }
            }

            // Issue #1566: reaching here with a non-null symbol means the name
            // denotes only extension function(s) and the enclosing type had no
            // matching member — fall through to the free-function/extension
            // binding below rather than the not-found paths.
            if (symbol == null)
            {
                // Issue #1201 (C# `using static`): an unqualified call may resolve
                // to a `shared` (static) method of a type brought into scope by a
                // type import (`import Ns.Type`). Mirror C#'s using-static
                // semantics — search every type-import's static method set and bind
                // against the single match. When two or more imported types expose a
                // same-named static method the reference is ambiguous (GS0414), but
                // only here, where the name is actually used. The shared static-call
                // finalizer (`bindUserTypeStaticCall`) provides full
                // optional/variadic/generic fidelity, so an unqualified
                // `GetValues[TEnum]()` resolves exactly like `EnumUtil.GetValues[TEnum]()`.
                if (bindUserTypeStaticCall != null)
                {
                    StructSymbol? matchedStaticImport = null;
                    var ambiguousStaticImport = false;
                    foreach (var importedType in binderCtx.GetStaticImportTypes())
                    {
                        var importedStatics = TypeMemberModel.GetMethods(
                            importedType,
                            syntax.Identifier.Text,
                            MemberQuery.Static(MemberKinds.Method));
                        if (importedStatics.IsDefaultOrEmpty)
                        {
                            continue;
                        }

                        if (matchedStaticImport == null)
                        {
                            matchedStaticImport = importedType;
                        }
                        else if (!ReferenceEquals(matchedStaticImport, importedType))
                        {
                            ambiguousStaticImport = true;
                            break;
                        }
                    }

                    if (ambiguousStaticImport)
                    {
                        Diagnostics.ReportAmbiguousImportedStaticMember(syntax.Identifier.Location, syntax.Identifier.Text);
                        return new BoundErrorExpression(null);
                    }

                    if (matchedStaticImport != null)
                    {
                        return bindUserTypeStaticCall(matchedStaticImport, syntax);
                    }
                }

                // Issue #3334 / ADR-0134: an unqualified call may also resolve
                // to a `public static` method on an imported CLR type or a
                // referenced package's synthetic `<Program>` holder. Consulted
                // only when no same-compilation source class matched above; the
                // imported qualified static-call binder provides full
                // optional/variadic/generic fidelity.
                if (bindImportedClrStaticCall != null)
                {
                    System.Type? matchedClrStaticImport = null;
                    var ambiguousClrStaticImport = false;
                    foreach (var clrType in Scope.EnumerateStaticImportClrTypes())
                    {
                        if (!ClrTypeExposesStaticMethod(clrType, syntax.Identifier.Text))
                        {
                            continue;
                        }

                        if (matchedClrStaticImport == null)
                        {
                            matchedClrStaticImport = clrType;
                        }
                        else if (!ClrTypeUtilities.IsSameAs(matchedClrStaticImport, clrType))
                        {
                            ambiguousClrStaticImport = true;
                            break;
                        }
                    }

                    if (ambiguousClrStaticImport)
                    {
                        Diagnostics.ReportAmbiguousImportedStaticMember(syntax.Identifier.Location, syntax.Identifier.Text);
                        return new BoundErrorExpression(null);
                    }

                    if (matchedClrStaticImport != null)
                    {
                        return bindImportedClrStaticCall(matchedClrStaticImport, syntax);
                    }
                }

                // ADR-0156 Phase 2: an unqualified call may resolve to a
                // top-level function of a prior interactive submission — a
                // static method on that submission's <Program> container.
                // Submissions are consulted newest first and the first one
                // declaring the name wins outright (scope-chain shadowing,
                // not using-static ambiguity).
                if (Scope.SubmissionImports is { } submissionImports)
                {
                    if (bindImportedClrStaticCall != null
                        && submissionImports.TryFindFunctionContainer(Scope.References, syntax.Identifier.Text, out var submissionProgramType)
                        && submissionProgramType is not null)
                    {
                        return bindImportedClrStaticCall(submissionProgramType, syntax);
                    }

                    // A function-typed global from a prior submission (e.g. a
                    // closure stored with `let inc = func() { ... }`) invokes
                    // through the indirect-call path: load the static field,
                    // then dispatch its Func/Action shape.
                    if (TryBindSubmissionDelegateGlobalCall(syntax, submissionImports, out var submissionDelegateCall))
                    {
                        return Invariant.Required(submissionDelegateCall, "a matched submission delegate global produces a bound invocation");
                    }
                }

                Diagnostics.ReportUndefinedFunction(syntax.Identifier.Location, syntax.Identifier.Text);
                return new BoundErrorExpression(null);
            }
        }

        // ADR-0122 §9 / issues #1035 and #3523: invoking a function-pointer-
        // typed variable goes through the shared `calli` path. Implicit field
        // and property symbols must first become real member loads rather than
        // non-existent local slots.
        var fpVar = symbol as VariableSymbol;
        var fpSym = (narrowedCallTargetType ?? fpVar?.Type) as FunctionPointerTypeSymbol;
        if (fpVar != null && fpSym != null)
        {
            BoundExpression pointer;
            if (TryBuildImplicitMemberLoad(
                fpVar,
                syntax.Identifier.Location,
                out var implicitPointer,
                narrowedCallTargetType))
            {
                pointer = Invariant.Required(
                    implicitPointer,
                    "an implicit function-pointer member load succeeds with a bound expression");
            }
            else
            {
                pointer = new BoundVariableExpression(null, fpVar, narrowedCallTargetType);
            }

            return BindFunctionPointerInvocation(
                syntax,
                pointer,
                fpSym,
                fpVar.Name,
                syntax.Identifier.Location,
                boundArguments.ToImmutable(),
                argumentNames,
                fpVar.CallableParameterNames);
        }

        if (symbol is VariableSymbol nullableDelegateVar
            && TryBindNullableDelegateInvocation(nullableDelegateVar, syntax, boundArguments.ToImmutable(), argumentNames, out var nullableDelegateCall))
        {
            return nullableDelegateCall;
        }

        if (symbol is VariableSymbol directDelegateVar
            && TryReportNullableDelegateReceiver(
                narrowedCallTargetType ?? directDelegateVar.Type,
                syntax.Identifier.Location,
                directDelegateVar.Name,
                nullSafeInvocation: "?(...)"))
        {
            return new BoundErrorExpression(null);
        }

        // Phase 4.7: invoking a function-typed variable goes through the
        // indirect-call path. Sites like `add(1, 2)` where `add` is `let
        // add func(int, int) int = ...` reduce to BoundIndirectCallExpression.
        var variable = symbol as VariableSymbol;
        var callableType = narrowedCallTargetType ?? variable?.Type;
        var fnType = callableType as FunctionTypeSymbol;
        if (variable != null && fnType != null)
        {
            if (!TryBindFunctionTypeArguments(
                    variable.Name,
                    fnType,
                    syntax,
                    boundArguments.ToImmutable(),
                    variable.CallableParameterNames,
                    out var convertedArgs))
            {
                return new BoundErrorExpression(null);
            }

            return BuildIndirectDelegateCall(
                syntax,
                variable,
                fnType,
                convertedArgs,
                narrowedCallTargetType);
        }

        // ADR-0059 / issue #255: direct call syntax `h(args)` on a variable
        // of a user-declared named delegate type. Mirrors the CLR-delegate
        // branch below — both end up dispatching through Invoke.
        var namedDelegateVar = symbol as VariableSymbol;
        var namedDelegateSym =
            (narrowedCallTargetType ?? namedDelegateVar?.Type) as DelegateTypeSymbol;
        if (namedDelegateVar != null && namedDelegateSym != null)
        {
            if (!TryBindNamedDelegateArguments(
                namedDelegateVar.Name,
                namedDelegateSym,
                syntax,
                boundArguments.ToImmutable(),
                out var convertedNamedArgs,
                out var namedRefKinds))
            {
                return new BoundErrorExpression(null);
            }

            return BuildIndirectDelegateCall(
                syntax,
                namedDelegateVar,
                namedDelegateSym.EquivalentFunctionType,
                convertedNamedArgs,
                narrowedCallTargetType,
                namedRefKinds);
        }

        // #325: a variable whose type is a CLR delegate (e.g. `Func[int32,
        // int32]`, `RequestDelegate`) is callable with call syntax `f(x)`,
        // mirroring native func-typed variables. Lower the call to an
        // invocation of the delegate's `Invoke` method, identical in behavior
        // to the explicit `f.Invoke(x)` form.
        var delegateVar = symbol as VariableSymbol;
        var delegateTargetType = narrowedCallTargetType ?? delegateVar?.Type;
        var delegateClrType = delegateTargetType?.ClrType;
        if (delegateVar != null
            && delegateTargetType != null
            && delegateClrType != null
            && ClrTypeUtilities.IsDelegateType(delegateClrType))
        {
            // Issue #2799 follow-up: the receiver load must honor every
            // implicit-member variable kind, not only a plain local/parameter
            // (a bare `BoundVariableExpression`) and the field-like event's
            // implicit backing field. A nominal CLR delegate-typed value
            // exposed as a bare static field or instance/static property
            // (`ImplicitStaticFieldVariableSymbol` /
            // `ImplicitPropertyVariableSymbol` /
            // `ImplicitStaticPropertyVariableSymbol`) has no local slot, so a
            // bare `BoundVariableExpression` ICE-d with GS9998 ("no local slot")
            // on any invocation — conditional or not. `TryBuildImplicitMemberLoad`
            // resolves each such symbol to the correct field/property access
            // (the same helper the structural `FunctionTypeSymbol` path uses),
            // leaving locals/parameters to the bare-variable fallback.
            // Issue #2849: preserve the narrowed receiver type on every load
            // shape so emit can parent Invoke at the reified generic TypeSpec
            // instead of the nullable declaration's erased ClrType.
            BoundExpression receiver;
            if (delegateVar is ImplicitFieldVariableSymbol clrImplicitField)
            {
                receiver = BuildImplicitFieldLoad(clrImplicitField, narrowedCallTargetType);
            }
            else if (TryBuildImplicitMemberLoad(
                delegateVar,
                syntax.Identifier.Location,
                out var clrMemberLoad,
                narrowedCallTargetType))
            {
                receiver = Invariant.Required(clrMemberLoad, "an implicit member load succeeds with a bound expression");
            }
            else
            {
                receiver = new BoundVariableExpression(null, delegateVar, narrowedCallTargetType);
            }

            // Issue #2796 / #2798: a null-conditional raise `Evt?(args)` of a
            // CLR delegate-typed value — canonically a field-like event's
            // backing delegate, which PR #2792 (fix/2726) now emits as a
            // nominal `System.EventHandler`/`EventHandler<T>` or a canonicalized
            // CLR `Func<...>`/named delegate — must short-circuit when the
            // delegate is null, mirroring C# `Evt?.Invoke(args)`. Without the
            // guard the emitted `callvirt Invoke` dereferences a null delegate
            // and NREs on a fresh event with no subscribers. The
            // FunctionTypeSymbol and named-delegate call paths above already
            // guard the raise via BuildIndirectDelegateCall; the CLR-delegate
            // path — reached once a structural `(object?, EventArgs) -> void`,
            // nominal `EventHandler`, or nominal `Func<int, int>` event is a CLR
            // delegate — must do the same for both the `void`-returning raise
            // (a plain no-op null branch) and the value-returning raise
            // (Issue #2798: the null branch must yield the correct
            // optional/null result via the established result-slot lowering, so
            // `var r = Evt?(x)` on a subscriber-less event produces null/default
            // instead of NRE-ing). The receiver is evaluated once into
            // `eventRaiseCapture`; a non-null delegate invokes normally.
            if (syntax.NullableQuestionToken != null)
            {
                var eventRaiseCaptureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter)
                    .ToString(System.Globalization.CultureInfo.InvariantCulture);
                var eventRaiseCapture = new LocalVariableSymbol(eventRaiseCaptureName, isReadOnly: true, type: delegateTargetType);
                var eventRaiseCaptureRef = new BoundVariableExpression(null, eventRaiseCapture);

                // The callback uses null to mean that no explicit type arguments were supplied.
                if (tryBindInheritedClrInstanceCall(eventRaiseCaptureRef, delegateClrType, "Invoke", boundArguments.ToImmutable(), syntax, out var guardedInvoke, null, default, argumentNames)
                    && guardedInvoke is not BoundErrorExpression)
                {
                    return BuildNullConditionalDelegateResult(syntax, receiver, eventRaiseCapture, guardedInvoke, guardedInvoke.Type);
                }
            }

            // The callback uses null to mean that no explicit type arguments were supplied.
            if (tryBindInheritedClrInstanceCall(receiver, delegateClrType, "Invoke", boundArguments.ToImmutable(), syntax, out var invokeCall, null, default, argumentNames))
            {
                return invokeCall;
            }

            var invoke = delegateClrType.GetMethodSafe("Invoke");
            var expectedArity = invoke?.GetParameters().Length ?? 0;
            if (syntax.Arguments.Count != expectedArity)
            {
                Diagnostics.ReportWrongArgumentCount(syntax.Identifier.Location, delegateVar.Name, expectedArity, syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }

            Diagnostics.ReportNotAFunction(syntax.Identifier.Location, syntax.Identifier.Text);
            return new BoundErrorExpression(null);
        }

        var function = symbol as FunctionSymbol;
        if (function == null)
        {
            Diagnostics.ReportNotAFunction(syntax.Identifier.Location, syntax.Identifier.Text);
            return new BoundErrorExpression(null);
        }

        // ADR-0063 §11: when multiple top-level functions share this name,
        // perform overload selection over the supplied argument shape (count
        // and, where useful, types). The legacy `TryLookupSymbol` returned the
        // first declared overload; we now consult the overload-set store.
        var overloadSet = Scope.TryLookupFunctions(syntax.Identifier.Text);
        var explicitOverloadTypeArguments = default(ImmutableArray<TypeSymbol>);
        if (overloadSet.Length > 1)
        {
            if (syntax.TypeArgumentList != null)
            {
                var explicitArguments = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.TypeArgumentList.Arguments.Count);
                foreach (var explicitArgument in syntax.TypeArgumentList.Arguments)
                {
                    var boundTypeArgument = bindTypeClause(explicitArgument);
                    if (boundTypeArgument == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    explicitArguments.Add(boundTypeArgument);
                }

                explicitOverloadTypeArguments = explicitArguments.MoveToImmutable();
                var constraintMatches = ImmutableArray.CreateBuilder<FunctionSymbol>();
                foreach (var candidate in overloadSet)
                {
                    if (candidate.TypeParameters.Length != explicitOverloadTypeArguments.Length)
                    {
                        continue;
                    }

                    var constraintsSatisfied = true;
                    for (var i = 0; i < candidate.TypeParameters.Length; i++)
                    {
                        constraintsSatisfied &=
                            satisfiesConstraint(explicitOverloadTypeArguments[i], candidate.TypeParameters[i]);
                    }

                    if (constraintsSatisfied)
                    {
                        constraintMatches.Add(candidate);
                    }
                }

                if (constraintMatches.Count > 0)
                {
                    overloadSet = constraintMatches.ToImmutable();
                }
            }

            var selected = SelectBestUserOverload(overloadSet, syntax.Arguments.Count, argumentNames, boundArguments, syntax, out var overloadAmbiguous, out var nullSafetyFailure, syntax.TypeArgumentList?.Arguments.Count ?? 0);
            if (selected == null)
            {
                if (nullSafetyFailure != null)
                {
                    var argLoc = nullSafetyFailure.Index < syntax.Arguments.Count
                        ? syntax.Arguments[nullSafetyFailure.Index].Location
                        : syntax.Identifier.Location;
                    Diagnostics.ReportWrongArgumentType(argLoc, nullSafetyFailure.ParamName, nullSafetyFailure.ParamType, nullSafetyFailure.ArgType);
                }
                else if (overloadAmbiguous)
                {
                    if (TryGetUnconstrainedNullableIteratorTypeParameter(
                        overloadSet,
                        boundArguments,
                        syntax.Arguments.Count,
                        explicitOverloadTypeArguments,
                        out var unconstrainedTypeParameter))
                    {
                        Diagnostics.ReportUnconstrainedNullableIteratorCall(
                            syntax.Identifier.Location,
                            syntax.Identifier.Text,
                            Invariant.Required(unconstrainedTypeParameter, "an unconstrained nullable iterator diagnostic has a type parameter").Name);
                    }
                    else
                    {
                        Diagnostics.ReportAmbiguousOverloadResolution(syntax.Identifier.Location, syntax.Identifier.Text);
                    }
                }
                else
                {
                    Diagnostics.ReportNoApplicableOverload(syntax.Identifier.Location, syntax.Identifier.Text);
                }

                return new BoundErrorExpression(null);
            }

            function = selected;
        }

        reportObsoleteUseIfApplicable(syntax.Identifier.Location, function, function.Name);

        var isVariadic = function.Parameters.Length > 0 && function.Parameters[function.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? function.Parameters.Length - 1 : function.Parameters.Length;
        var requiredFixedParamCount = fixedParamCount;
        for (var i = fixedParamCount - 1; i >= 0; i--)
        {
            if (function.Parameters[i].HasExplicitDefaultValue)
            {
                requiredFixedParamCount = i;
            }
            else
            {
                break;
            }
        }

        Func<int, string> functionParameterNameAt =
            parameterIndex => function.Parameters[parameterIndex].Name;
        Func<int, bool> functionParameterIsOptional =
            parameterIndex => function.Parameters[parameterIndex].HasExplicitDefaultValue;

        // ADR-0063: count of leading non-optional parameters (the minimum a
        // call must supply when there are no variadic parameters).
        var requiredParamCount = function.Parameters.Length;
        for (var i = function.Parameters.Length - 1; i >= 0; i--)
        {
            if (function.Parameters[i].HasExplicitDefaultValue)
            {
                requiredParamCount = i;
            }
            else
            {
                break;
            }
        }

        if (isVariadic &&
            !ValidateExpandedVariadicNamedArguments(
                argumentNames,
                fixedParamCount,
                functionParameterNameAt,
                function.Name,
                syntax))
        {
            return new BoundErrorExpression(null);
        }

        if (isVariadic)
        {
            if (syntax.Arguments.Count < requiredFixedParamCount)
            {
                Diagnostics.ReportTooFewArgumentsForVariadic(
                    syntax.Identifier.Location,
                    function.Name,
                    requiredFixedParamCount,
                    syntax.Arguments.Count);
                return new BoundErrorExpression(null);
            }
        }
        else if (syntax.Arguments.Count < requiredParamCount || syntax.Arguments.Count > function.Parameters.Length)
        {
            TextSpan span;
            if (syntax.Arguments.Count > function.Parameters.Length)
            {
                SyntaxNode firstExceedingNode;
                if (function.Parameters.Length > 0)
                {
                    firstExceedingNode = Invariant.Required(
                        syntax.Arguments.GetSeparator(function.Parameters.Length - 1),
                        "an argument list with too many arguments has a separator before the excess arguments");
                }
                else
                {
                    firstExceedingNode = syntax.Arguments[0];
                }

                var lastExceedingArgument = Invariant.Required(
                    syntax.Arguments[syntax.Arguments.Count - 1],
                    "an argument list with too many arguments has a last argument");
                span = TextSpan.FromBounds(firstExceedingNode.Span.Start, lastExceedingArgument.Span.End);
            }
            else
            {
                span = syntax.CloseParenthesisToken.Span;
            }

            Diagnostics.ReportWrongArgumentCount(
                new TextLocation(Invariant.Required(syntax.Location.Text, "a call syntax location has source text"), span),
                function.Name,
                function.Parameters.Length,
                syntax.Arguments.Count);
            return new BoundErrorExpression(null);
        }

        // Issue #343: when the call site mixes positional and named arguments,
        // reorder the bound arguments into the function's parameter order so
        // the existing per-position passes operate as if every argument were
        // positional. `parameterSyntax[i]` carries the source-syntax node at
        // parameter position `i` (preserving locations for diagnostics).
        // ADR-0063: when there are optional parameters, omitted slots are left
        // empty in the reorder output, then filled with default-value
        // BoundLiteralExpression here.
        ExpressionSyntax?[] parameterSyntax;
        var hasOptional = function.Parameters.Length > 0 && requiredParamCount < function.Parameters.Length && !isVariadic;
        if ((!argumentNames.IsDefault && !isVariadic) ||
            (hasOptional && syntax.Arguments.Count < function.Parameters.Length))
        {
            if (!TryReorderUserCallArguments(
                    syntax.Arguments,
                    boundArguments.ToImmutable(),
                    function.Parameters.Length,
                    functionParameterNameAt,
                    hasOptional ? functionParameterIsOptional : null,
                    function.Name,
                    out parameterSyntax,
                    out var permutedBound))
            {
                return new BoundErrorExpression(null);
            }

            boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(permutedBound.Length);
            for (var i = 0; i < permutedBound.Length; i++)
            {
                if (permutedBound[i] == null)
                {
                    // ADR-0063: fill the omitted optional slot with the parameter's default.
                    boundArguments.Add(CreateOptionalUserDefaultArgument(function.Parameters[i]));
                }
                else
                {
                    boundArguments.Add(permutedBound[i]);
                }
            }
        }
        else
        {
            parameterSyntax = new ExpressionSyntax[syntax.Arguments.Count];
            for (var i = 0; i < syntax.Arguments.Count; i++)
            {
                parameterSyntax[i] = syntax.Arguments[i];
            }
        }

        if (isVariadic && boundArguments.Count < fixedParamCount)
        {
            var paddedSyntax = new ExpressionSyntax?[fixedParamCount];
            Array.Copy(parameterSyntax, paddedSyntax, parameterSyntax.Length);
            parameterSyntax = paddedSyntax;
            for (var i = boundArguments.Count; i < fixedParamCount; i++)
            {
                boundArguments.Add(CreateOptionalUserDefaultArgument(function.Parameters[i]));
            }
        }

        bool hasErrors = false;

        // Phase 4.1 / ADR-0020: if the callee is generic, build the type
        // substitution either from the explicit `[T1, T2]` list at the call
        // site or by left-to-right inference from argument types matched
        // against parameter types.
        Dictionary<TypeParameterSymbol, TypeSymbol>? substitution = null;
        if (function.IsGeneric)
        {
            substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            if (syntax.TypeArgumentList != null)
            {
                var explicitArgs = syntax.TypeArgumentList.Arguments;
                if (explicitArgs.Count != function.TypeParameters.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, function.Name, function.TypeParameters.Length, explicitArgs.Count);
                    return new BoundErrorExpression(null);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = !explicitOverloadTypeArguments.IsDefault
                        ? explicitOverloadTypeArguments[i]
                        : bindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    substitution[function.TypeParameters[i]] = ta;
                }
            }
            else
            {
                for (var i = 0; i < function.Parameters.Length && i < boundArguments.Count; i++)
                {
                    var paramType = function.Parameters[i].Type;

                    // ADR-0101 / issue #799: when the trailing parameter is
                    // variadic (`name ...T`), inference must consider every
                    // packed argument against the element type — *unless* the
                    // caller supplied a single trailing argument whose type
                    // already matches the slice (the C# `params` pass-through
                    // case), in which case the slice itself drives inference.
                    if (i == function.Parameters.Length - 1
                        && function.Parameters[i].IsVariadic
                        && paramType is SliceTypeSymbol variadicSlice)
                    {
                        var trailingCount = boundArguments.Count - i;
                        if (trailingCount == 1 && boundArguments[i].Type is SliceTypeSymbol)
                        {
                            inferTypeArguments(paramType, boundArguments[i].Type, substitution);
                        }
                        else
                        {
                            for (var j = i; j < boundArguments.Count; j++)
                            {
                                inferTypeArguments(variadicSlice.ElementType, boundArguments[j].Type, substitution);
                            }
                        }

                        break;
                    }

                    inferTypeArguments(paramType, boundArguments[i].Type, substitution);
                }

                foreach (var tp in function.TypeParameters)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(syntax.Identifier.Location, function.Name, tp.Name);
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // Phase 4.2 / ADR-0020: each substituted type argument must satisfy
            // its type parameter's declared constraint.
            var constraintLocation = syntax.TypeArgumentList != null
                ? syntax.TypeArgumentList.Location
                : syntax.Identifier.Location;
            if (TryReportByRefLikeTypeArgument(function.TypeParameters, substitution, constraintLocation))
            {
                return new BoundErrorExpression(null);
            }

            foreach (var tp in function.TypeParameters)
            {
                var typeArg = substitution[tp];
                if (!satisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, describeConstraint(tp));
                    return new BoundErrorExpression(null);
                }
            }
        }

        for (var i = 0; i < fixedParamCount; i++)
        {
            var argument = boundArguments[i];
            var parameter = function.Parameters[i];
            TypeSymbol? expectedType = substitution != null
                ? substituteType(parameter.Type, substitution)
                : parameter.Type;

            // Issue #1238: a deferred target-typed conditional/if/switch
            // argument is re-bound here against the resolved parameter type so
            // each branch is target-typed before the convertibility checks
            // below (which would otherwise reject the suppressed-error
            // placeholder).
            boundArguments[i] = argument = FinalizeBranchyArgument(
                argument,
                i < parameterSyntax.Length ? parameterSyntax[i] : null,
                expectedType);

            // bound against the resolved parameter's delegate target so its
            // omitted parameter type(s) and inferred return type are filled in
            // from the parameter shape (e.g. `func F(f Func[int32, int32])`
            // accepts `F((x) -> x + 1)`). The bound lambda is then converted to
            // the exact parameter type so the correct delegate adapter
            // (`Func`/`Action`/`Predicate`/a named delegate) is materialised.
            // If the parameter is not a delegate type, fall back to binding the
            // lambda with no target, which surfaces the established GS0304
            // diagnostic through the regular conversion checks below.
            if (deferredArrowLambdas != null
                && i < parameterSyntax.Length
                && parameterSyntax[i] is { } deferredArgument
                && GetLambdaArgumentSyntax(deferredArgument) is { } deferredLambda
                && deferredArrowLambdas.Remove(deferredLambda))
            {
                var lambdaLoc = deferredArgument.Location;
                if (bindLambdaWithTarget != null
                    && expectedType != null
                    && expectedType != TypeSymbol.Error
                    && !TypeSymbol.ContainsTypeParameter(expectedType)
                    && MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(expectedType, out var deferredTarget)
                    && deferredTarget != null)
                {
                    var targeted = bindLambdaWithTarget(deferredLambda, deferredTarget);
                    boundArguments[i] = conversions.BindConversion(lambdaLoc, targeted, expectedType);
                    continue;
                }

                boundArguments[i] = argument = bindExpression(deferredLambda);
            }

            var lambdaTargetLoc = i < parameterSyntax.Length
                ? parameterSyntax[i]?.Location ?? syntax.Identifier.Location
                : syntax.Identifier.Location;
            var lambdaSyntax = i < parameterSyntax.Length && parameterSyntax[i] is { } sourceArgument
                ? GetLambdaArgumentSyntax(sourceArgument)
                : null;
            if (parameter.RefKind == RefKind.None
                && TryConvertLambdaArgumentWithTarget(
                    argument,
                    expectedType,
                    lambdaTargetLoc,
                    out var targetTypedLambda,
                    lambdaSyntax,
                    parameter))
            {
                boundArguments[i] = Invariant.Required(
                    targetTypedLambda,
                    "a successfully target-typed lambda produces a bound expression");
                continue;
            }

            // ADR-0100 / issue #795: materialise a bare-`default`
            // placeholder argument (BoundDefaultExpression with Error
            // type and bare DefaultExpressionSyntax) against the
            // expected parameter type. The placeholder originates in
            // ExpressionBinder.BindDefaultExpression when the bare form
            // is encountered through the eager argument-binding loop
            // above; by this point we know the target type and can pin
            // it down.
            if (argument is BoundDefaultExpression bareDefArg
                && argument.Type == TypeSymbol.Error
                && argument.Syntax is DefaultExpressionSyntax bareDefArgSyntax
                && bareDefArgSyntax.TypeClause == null
                && expectedType != null
                && expectedType != TypeSymbol.Error)
            {
                boundArguments[i] = argument = new BoundDefaultExpression(bareDefArgSyntax, expectedType);
            }

            // ADR-0060: ref-kind argument matching. The argument's syntax must
            // carry the same `ref`/`out`/`in` modifier as the parameter; for `in`
            // the modifier is required (warning GS0242 is reported when omitted).
            // ADR-0060 §1 back-compat: a bare `&x` (BoundAddressOfExpression
            // without a RefArgumentExpressionSyntax wrapper) is universally
            // compatible with any ref-kind parameter (existing ADR-0039 behaviour).
            if (parameter.RefKind != RefKind.None || (i < parameterSyntax.Length && parameterSyntax[i] is RefArgumentExpressionSyntax))
            {
                var argSyntax = i < parameterSyntax.Length ? parameterSyntax[i] : null;
                var argRefKind = RefKind.None;
                if (argSyntax is RefArgumentExpressionSyntax refArgSyntax)
                {
                    argRefKind = getRefKindFromModifier(refArgSyntax.RefKindModifier);
                }

                // Back-compat: bare `&x` (UnaryExpression with AmpersandToken,
                // bound to BoundAddressOfExpression) is universally compatible
                // with any ref-kind parameter. Treat it as if the user wrote the
                // matching keyword. ADR-0061: same back-compat applies to the
                // bare `&(cond ? a : b)` conditional address-of form.
                bool isBareAddressOf = argRefKind == RefKind.None
                    && (argument is BoundAddressOfExpression || argument is BoundConditionalAddressExpression)
                    && parameter.RefKind != RefKind.None;
                if (isBareAddressOf)
                {
                    argRefKind = parameter.RefKind;
                }

                if (argRefKind != parameter.RefKind)
                {
                    if (parameter.RefKind == RefKind.In && argRefKind == RefKind.None)
                    {
                        // GS0242 (error): `in` without the explicit modifier. ADR-0060
                        // says we do NOT silently spill a value to a temp, and no
                        // downstream type error is guaranteed to fire, so the diagnostic
                        // itself carries error severity (issue #3501: it was a warning,
                        // and the mis-bound argument reached the emitter as GS9998).
                        Diagnostics.ReportInArgumentMissingInModifier(argSyntax?.Location ?? syntax.Location, i + 1, parameter.Name);
                        hasErrors = true;
                        continue;
                    }

                    Diagnostics.ReportRefKindMismatch(
                        argSyntax?.Location ?? syntax.Location,
                        i + 1,
                        parameter.Name,
                        refKindToString(parameter.RefKind),
                        refKindToString(argRefKind));
                    hasErrors = true;
                    continue;
                }

                // Modifiers match. The bound argument is BoundAddressOfExpression
                // (or, ADR-0061, BoundConditionalAddressExpression) whose
                // operand/pointee type must match the parameter's pointee type.
                if (argument is BoundAddressOfExpression addr)
                {
                    var operandType = addr.Operand.Type;

                    // ADR-0060: an inline-decl `out var n` / `out let n` / `out _`
                    // was bound with TypeSymbol.Error in the first pass because
                    // the parameter was unknown. Re-bind now that overload
                    // resolution has chosen the function and the parameter
                    // pointee type is known.
                    if (operandType == TypeSymbol.Error
                        && i < parameterSyntax.Length
                        && parameterSyntax[i] is RefArgumentExpressionSyntax refArgFixup
                        && refArgFixup.IsInlineDeclaration
                        && refArgFixup.DeclaredType == null)
                    {
                        boundArguments[i] = bindRefArgumentExpression(refArgFixup, parameter);
                        continue;
                    }

                    if (!DeclarationBinder.TypeSignaturesEquivalent(operandType, expectedType)
                        && operandType != TypeSymbol.Error)
                    {
                        Diagnostics.ReportWrongArgumentType(
                            Invariant.Required(parameterSyntax[i], "a ref argument has source syntax").Location,
                            parameter.Name,
                            Invariant.Required(expectedType, "a bound parameter has a target type"),
                            operandType);
                        hasErrors = true;
                    }
                }
                else if (argument is BoundConditionalAddressExpression condAddrArg)
                {
                    var pointeeType = condAddrArg.PointeeType;
                    if (pointeeType != expectedType && pointeeType != TypeSymbol.Error)
                    {
                        Diagnostics.ReportWrongArgumentType(
                            Invariant.Required(parameterSyntax[i], "a conditional ref argument has source syntax").Location,
                            parameter.Name,
                            Invariant.Required(expectedType, "a bound parameter has a target type"),
                            pointeeType);
                        hasErrors = true;
                    }
                }

                continue;
            }

            if (substitution != null
                && parameter.Type is FunctionTypeSymbol openFunctionParameter
                && tryGetFunctionLiteral(argument, out var functionLiteralArgument))
            {
                // ADR-0087 §3 R6: substitute the open target before
                // routing through the adapter so the identity-check
                // inside the adapter can drop the wrapper when the
                // literal already matches.
                var substitutedOpenTarget = (substituteType(openFunctionParameter, substitution) as FunctionTypeSymbol)
                    ?? openFunctionParameter;
                boundArguments[i] = createErasedFunctionLiteralAdapter(functionLiteralArgument, substitutedOpenTarget);
                continue;
            }

            // Issue #1150: a func/arrow literal argument whose natural numeric
            // return type implicitly, losslessly widens to the (non-generic)
            // delegate parameter's return type (e.g. `(x int32) -> uint16(x)`
            // into a `Func<int32,int64>` parameter) is routed through
            // BindConversion, which reshapes it via the erased adapter so the
            // produced delegate's return type already matches the target —
            // inserting the widening conversion in the body. Without this the
            // literal would materialise as a narrower-returning delegate flowing
            // into a wider delegate slot (unverifiable IL).
            if (!(substitution != null && TypeSymbol.ContainsTypeParameter(parameter.Type))
                && tryGetFunctionLiteral(argument, out var widenLiteralArg))
            {
                var widenLiteralFnType = widenLiteralArg.FunctionType as FunctionTypeSymbol;
                if (widenLiteralFnType != null
                    && widenLiteralFnType.ReturnType != TypeSymbol.Void
                    && widenLiteralFnType.ReturnType != TypeSymbol.Error
                    && expectedType != null
                    && MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(expectedType, out var widenTargetFn)
                    && widenTargetFn != null
                    && widenTargetFn.Arity == widenLiteralFnType.Arity
                    && widenTargetFn.ReturnType != TypeSymbol.Void
                    && widenTargetFn.ReturnType != TypeSymbol.Error
                    && !ReferenceEquals(widenLiteralFnType.ReturnType, widenTargetFn.ReturnType)
                    && Conversion.Classify(widenLiteralFnType.ReturnType, widenTargetFn.ReturnType).IsImplicit)
                {
                    var widenLoc = i < parameterSyntax.Length
                        ? Invariant.Required(parameterSyntax[i], "a widened lambda argument has source syntax").Location
                        : syntax.Identifier.Location;
                    boundArguments[i] = conversions.BindConversion(
                        widenLoc,
                        argument,
                        expectedType);
                    continue;
                }
            }

            // ADR-0055 Tier 4 (#369): an interpolated-string argument bound
            // against an IFormattable/FormattableString parameter is re-lowered
            // to FormattableStringFactory.Create instead of an eager string. Only
            // applies in the non-generic case (a type parameter is never a
            // formattable target).
            if (substitution == null
                && i < parameterSyntax.Length
                && parameterSyntax[i] is InterpolatedStringExpressionSyntax interpolatedArg
                && isFormattableStringTargetType(Invariant.Required(expectedType, "a non-generic interpolated-string argument has a target type")))
            {
                boundArguments[i] = bindInterpolatedStringAsFormattable(
                    interpolatedArg,
                    Invariant.Required(expectedType, "a formattable-string argument has a target type"));
                continue;
            }

            // ADR-0112 / ADR-0063 §9: an unresolved method group argument
            // (multiple user overloads, or a CLR method group) carries no fixed
            // type until the target delegate signature drives overload
            // selection. Route it through BindConversion — which performs the
            // signature-directed pick — instead of the type-equality / implicit
            // conversion checks below (which would reject the Error-typed group).
            if ((argument is BoundMethodGroupExpression { FunctionType: null }
                    || argument is BoundClrMethodGroupExpression { ResolvedMethod: null })
                && !(substitution != null && TypeSymbol.ContainsTypeParameter(parameter.Type)))
            {
                var groupLoc = i < parameterSyntax.Length
                    ? Invariant.Required(parameterSyntax[i], "a method group argument has source syntax").Location
                    : syntax.Identifier.Location;
                var resolvedGroupArg = conversions.BindConversion(
                    groupLoc,
                    argument,
                    Invariant.Required(expectedType, "a method group argument has a target type"));
                boundArguments[i] = resolvedGroupArg;
                if (resolvedGroupArg is BoundErrorExpression)
                {
                    hasErrors = true;
                }

                continue;
            }

            // Issue #1256: an element-wise tuple conversion `(T1, …) -> (U1, …)`
            // is implicit but NOT representation-preserving — the source and
            // target `ValueTuple<…>` are different CLR instantiations, so the
            // argument must be lowered (rebuilt) via BindConversion rather than
            // passed through unchanged. The generic implicit-conversion branch
            // below only inserts a conversion node for value-type nullable
            // targets, leaving every other "implicit" conversion as a no-op, so
            // tuple arguments would otherwise reach the call site still typed as
            // the source tuple and produce unverifiable IL.
            if (argument.Type is TupleTypeSymbol argTuple
                && expectedType is TupleTypeSymbol paramTuple
                && argTuple.Arity == paramTuple.Arity
                && argTuple != paramTuple
                && Conversion.Classify(argTuple, paramTuple).IsImplicit)
            {
                var tupleLoc = i < parameterSyntax.Length
                    ? Invariant.Required(parameterSyntax[i], "a tuple argument has source syntax").Location
                    : syntax.Identifier.Location;
                boundArguments[i] = conversions.BindConversion(
                    tupleLoc,
                    argument,
                    Invariant.Required(expectedType, "a tuple argument has a target type"));
                continue;
            }

            // Issue #2069: force the wrap for a func/arrow literal argument
            // flowing into a NAMED delegate parameter — see the matching
            // comment at the constructor-argument path (above in this file)
            // for the full rationale. This is the general free-function /
            // method call-argument path, the one that reproduces the issue's
            // exact repro (`Apply((n int32) -> ...)` against a `func
            // Apply(h TickHandler)` parameter).
            // Issue #2850: strip reference nullability on both sides and use
            // the substituted target, whether it is closed at this call site
            // or remains open during generic forwarding. A direct generic
            // free-function call must materialize the structural value as the
            // nominal delegate just like the instance/static method paths do.
            var nominalDelegateCallTarget = expectedType is NullableTypeSymbol nullableDelegateTarget
                ? nullableDelegateTarget.UnderlyingType
                : expectedType;
            var structuralArgumentType = argument.Type is NullableTypeSymbol nullableFunctionArgument
                ? nullableFunctionArgument.UnderlyingType
                : argument.Type;
            if (nominalDelegateCallTarget is DelegateTypeSymbol
                && structuralArgumentType is FunctionTypeSymbol)
            {
                var namedDelegateLoc = i < parameterSyntax.Length
                    ? Invariant.Required(parameterSyntax[i], "a delegate argument has source syntax").Location
                    : syntax.Identifier.Location;
                boundArguments[i] = conversions.BindConversion(
                    namedDelegateLoc,
                    argument,
                    Invariant.Required(expectedType, "a delegate argument has a target type"));
                continue;
            }

            if (argument.Type != expectedType
                && !TypeSymbol.ContainsTypeParameter(Invariant.Required(expectedType, "an argument conversion has a target type"))
                && !Conversion.Classify(argument.Type, Invariant.Required(expectedType, "an argument conversion has a target type")).IsImplicit)
            {
                // Issue #889: arrow/func literal → void-returning delegate.
                var voidDelegateLoc = i < parameterSyntax.Length
                    ? Invariant.Required(parameterSyntax[i], "a delegate argument has source syntax").Location
                    : syntax.Identifier.Location;
                var targetType = Invariant.Required(expectedType, "a delegate argument has a target type");
                if (TryConvertLiteralArgumentToExpressionTree(argument, targetType, voidDelegateLoc, out var expressionTreeArg))
                {
                    boundArguments[i] = Invariant.Required(expressionTreeArg, "a successful expression-tree argument conversion produces a bound expression");
                    continue;
                }

                if (TryConvertLambdaArgumentWithTarget(
                    argument,
                    targetType,
                    voidDelegateLoc,
                    out var targetTypedLambdaArg,
                    parameter: parameter))
                {
                    boundArguments[i] = Invariant.Required(targetTypedLambdaArg, "a successful target-typed lambda conversion produces a bound expression");
                    continue;
                }

                // Issue #1281: a constant integer argument that fits a narrower /
                // cross-sign integer parameter converts implicitly (C# §10.2.11).
                // Re-materialise it as a literal of exactly the parameter type so
                // emit produces a correctly-typed constant — matching `var x
                // uint16 = 5` at a declaration target (ADR-0129).
                if (TryBindConstantNarrowingArgument(argument, targetType, voidDelegateLoc, out var narrowedArg))
                {
                    boundArguments[i] = Invariant.Required(narrowedArg, "a successful constant narrowing conversion produces a bound expression");
                    continue;
                }

                if (conversions.TryApplyUserDefinedImplicitArgumentConversion(argument, targetType, out var convertedArg))
                {
                    boundArguments[i] = convertedArg;
                    continue;
                }

                if (argument.Type != TypeSymbol.Error)
                {
                    conversions.ReportCallArgumentConversionFailure(
                        Invariant.Required(parameterSyntax[i], "an argument with a conversion error has source syntax").Location,
                        parameter,
                        targetType,
                        argument.Type);
                }

                hasErrors = true;
            }
            else if (argument.Type != expectedType
                && expectedType is NullableTypeSymbol ntConv
                && (ntConv.UnderlyingType?.ClrType is { IsValueType: true }
                    || NullableLifting.IsUserValueTypeNullable(ntConv)))
            {
                // Issue #533: conversions to a value-type Nullable<T> parameter
                // need explicit lowering:
                // - nil → Nullable<T> becomes BoundDefaultExpression (initobj)
                // - T → Nullable<T> becomes BoundConversionExpression (newobj ctor)
                //
                // Issue #1572: a user-declared value-type underlying (struct? /
                // enum?) has a null ClrType, so the primitive probe above misses
                // it and the argument would otherwise pass through unlifted (a
                // bare `UserT` where `Nullable<UserT>` is expected). Include the
                // symbol-aware predicate so the `UserT → UserT?` argument lift is
                // lowered to a `newobj Nullable<UserT>::.ctor` here too.
                var argLoc = i < parameterSyntax.Length
                    ? Invariant.Required(parameterSyntax[i], "a nullable-lifted argument has source syntax").Location
                    : syntax.Identifier.Location;
                boundArguments[i] = conversions.BindConversion(argLoc, argument, Invariant.Required(expectedType, "a nullable-lifted argument has a target type"));
            }
            else if (argument.Type != expectedType
                && !(substitution != null
                    && parameter.Type is TypeParameterSymbol
                    && TypeSymbol.ContainsTypeParameter(Invariant.Required(expectedType, "a substituted argument has a target type")))
                && (!(substitution != null && TypeSymbol.ContainsTypeParameter(parameter.Type))
                    || (Conversion.Classify(argument.Type, Invariant.Required(expectedType, "a substituted argument has a target type")).IsImplicit
                        && structuralArgumentType is not FunctionTypeSymbol)))
            {
                // Issue #2335 (audit follow-up): every OTHER implicit
                // conversion reaches this point already classified
                // `IsImplicit` by the negation in the very first `if` above
                // (that branch's `!IsImplicit` guard is what routed
                // execution past it), yet none of the specific branches
                // above (delegate/tuple/named-delegate/nullable-lift)
                // materializes it. Left unconverted, the raw argument would
                // flow straight to the emitter — which, for a plain
                // (non-imported) function call, applies NO further implicit
                // widening/boxing of its own (contrast the CLR-call and
                // instance/shared/extension-call paths, which always run
                // their argument through `BindCallArgumentWithRefKind` /
                // `BindConversion`). The most common manifestation is a
                // value-type/generic-type-parameter argument passed to an
                // `object`/interface-typed plain-function parameter (e.g.
                // `func Show(x object) {…}; Show(42)`): the missing `box`
                // opcode produces IL ilverify rejects
                // (`StackUnexpected: found Int32, expected ref 'object'`).
                // The same gap silently dropped numeric widening
                // (`int32 → int64`) and other representation-changing
                // implicit conversions.
                //
                // Issue #3222: only a BARE erased slot whose substituted target
                // remains open is skipped. Once explicit substitution closes
                // the slot, this branch must materialize conversions such as
                // value-type boxing, matching the instance and extension paths.
                // A parameter that merely CONTAINS a type parameter (e.g. a
                // constructed generic interface `IHolder[T]`) emits as a real
                // constructed slot (`IHolder<!!T>`), so a value-type argument
                // still needs its materialized conversion (`box StringBox` →
                // `IHolder<string>`); skipping it produced
                // InvalidProgramException at the call site. Substituted
                // non-bare slots whose conversion is NOT implicit keep the
                // historical skip (status quo) rather than surfacing new
                // diagnostics from this branch. A FUNCTION-shaped argument
                // (lambda/method group into a substituted delegate slot like
                // `Func[A, T]`) also keeps the historical skip: the emitter's
                // delegate-materialization path already builds the accurate
                // nullable-preserving `Func<…,Nullable<T>>` shape (#1518), and
                // re-materializing it here rebuilt the delegate from the
                // collapsed structural shape (`Func<int32,int32>`), tripping
                // ilverify's DelegateCtor check.
                var argLoc = i < parameterSyntax.Length
                    ? Invariant.Required(parameterSyntax[i], "an implicitly converted argument has source syntax").Location
                    : syntax.Identifier.Location;
                boundArguments[i] = conversions.BindConversion(
                    argLoc,
                    argument,
                    Invariant.Required(expectedType, "an implicitly converted argument has a target type"));
            }
        }

        // Issue #951: any deferred un-typed arrow lambda that did not map to a
        // fixed parameter (e.g. it landed in a trailing variadic slot) is bound
        // here with no target so the established GS0304 diagnostic surfaces
        // rather than leaving an unbound placeholder.
        if (deferredArrowLambdas != null)
        {
            for (var idx = 0; idx < boundArguments.Count; idx++)
            {
                if (idx < boundArguments.Count
                    && boundArguments[idx] is BoundErrorExpression placeholder
                    && placeholder.Syntax is LambdaExpressionSyntax pendingLambda
                    && deferredArrowLambdas.Remove(pendingLambda))
                {
                    boundArguments[idx] = bindExpression(pendingLambda);
                }
            }
        }

        // Phase 4.8: type-check trailing variadic arguments against the slice
        // element type, then pack them into a single slice-typed argument.
        // ADR-0101 / issue #799: a single trailing argument whose type already
        // matches the variadic slice type is passed through unchanged
        // (parity with the C# `params T[]` call-site semantics so the
        // dogfooded `Sequences.Of` port accepts `Sequences.Of(arr)`).
        if (isVariadic)
        {
            var variadicParam = function.Parameters[function.Parameters.Length - 1];
            var paramSliceType = (SliceTypeSymbol)variadicParam.Type;
            var sliceType = substitution != null
                ? (SliceTypeSymbol)substituteType(paramSliceType, substitution)
                : paramSliceType;

            // Issue #1630: pack/pass-through through the canonical helper
            // (applies #1493 element coercion when packing).
            Func<int, TextLocation> argumentLocation =
                argumentIndex => syntax.Arguments[argumentIndex].Location;
            var packedArgs = PackOrPassThroughVariadicArguments(
                conversions,
                Diagnostics,
                syntax,
                boundArguments.ToImmutable(),
                fixedParamCount,
                sliceType,
                variadicParam.Name,
                argumentLocation,
                ref hasErrors);

            if (!hasErrors)
            {
                boundArguments = packedArgs.ToBuilder();
            }
        }

        if (hasErrors)
        {
            return new BoundErrorExpression(syntax);
        }

        // Issue #1931: stash the function's own (explicit or inferred) type
        // arguments on the bound node so the emitter's MethodSpec construction
        // can use this authoritative bind-time result instead of re-deriving
        // it via structural unification (which can fail for uninformative
        // argument shapes like a bare `nil`).
        var methodTypeArguments = default(ImmutableArray<TypeSymbol>);
        if (function.IsGeneric && substitution != null)
        {
            var methodTypeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(function.TypeParameters.Length);
            foreach (var tp in function.TypeParameters)
            {
                methodTypeArgsBuilder.Add(substitution[tp]);
            }

            methodTypeArguments = methodTypeArgsBuilder.MoveToImmutable();
        }

        var finalBoundArguments = PreserveNamedArgumentEvaluationOrder(
            syntax.Arguments,
            boundArguments.ToImmutable(),
            functionParameterNameAt);

        if (substitution != null)
        {
            var returnType = substituteType(function.Type, substitution);
            if (function.IsAsync && !isAsyncIteratorReturnType(function.Type))
            {
                returnType = wrapAsTask(returnType, function.AsyncReturnsValueTask);
            }

            return CreatePossiblyElidedCall(syntax, function, finalBoundArguments, returnType, methodTypeArguments);
        }

        if (function.IsAsync && !isAsyncIteratorReturnType(function.Type))
        {
            var asyncReturn = wrapAsTask(function.Type, function.AsyncReturnsValueTask);
            return CreatePossiblyElidedCall(syntax, function, finalBoundArguments, asyncReturn, methodTypeArguments);
        }

        return CreatePossiblyElidedCall(syntax, function, finalBoundArguments, returnType: null, methodTypeArguments);
    }

    private static bool HasSingleArgumentConstructorShape(StructSymbol classType)
    {
        if (!classType.EffectiveExplicitConstructors.IsDefaultOrEmpty)
        {
            foreach (var constructor in classType.EffectiveExplicitConstructors)
            {
                if (ParametersAcceptSingleArgument(constructor.Parameters))
                {
                    return true;
                }
            }

            return false;
        }

        return ParametersAcceptSingleArgument(classType.PrimaryConstructorParameters);
    }

    private static bool ParametersAcceptSingleArgument(
        ImmutableArray<ParameterSymbol> parameters)
    {
        if (parameters.IsDefaultOrEmpty)
        {
            return false;
        }

        for (var i = 1; i < parameters.Length; i++)
        {
            if (!parameters[i].HasExplicitDefaultValue && !parameters[i].IsVariadic)
            {
                return false;
            }
        }

        return true;
    }

    private TypeSymbol? TryConstructConversionTarget(
        CallExpressionSyntax syntax,
        TypeSymbol type)
    {
        if (syntax.TypeArgumentList == null)
        {
            return type;
        }

        ImmutableArray<TypeParameterSymbol> typeParameters;
        if (type is StructSymbol { IsGenericDefinition: true } genericStruct)
        {
            typeParameters = genericStruct.TypeParameters;
        }
        else if (type is InterfaceSymbol { IsGenericDefinition: true } genericInterface)
        {
            typeParameters = genericInterface.TypeParameters;
        }
        else
        {
            return type;
        }

        if (syntax.TypeArgumentList.Arguments.Count != typeParameters.Length)
        {
            Diagnostics.ReportWrongTypeArgumentCount(
                syntax.TypeArgumentList.Location,
                type.Name,
                typeParameters.Length,
                syntax.TypeArgumentList.Arguments.Count);
            return null;
        }

        var typeArguments = ImmutableArray.CreateBuilder<TypeSymbol>(typeParameters.Length);
        for (var i = 0; i < typeParameters.Length; i++)
        {
            var typeArgument = bindTypeClause(syntax.TypeArgumentList.Arguments[i]);
            if (typeArgument == null)
            {
                return null;
            }

            if (!satisfiesConstraint(typeArgument, typeParameters[i]))
            {
                Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                    syntax.TypeArgumentList.Arguments[i].Location,
                    typeParameters[i].Name,
                    typeArgument,
                    describeConstraint(typeParameters[i]));
                return null;
            }

            typeArguments.Add(typeArgument);
        }

        var arguments = typeArguments.MoveToImmutable();
        return type switch
        {
            StructSymbol targetStruct => MapClrType is { } structMapClrType
                ? StructSymbol.Construct(targetStruct, arguments, structMapClrType)
                : StructSymbol.Construct(targetStruct, arguments),
            InterfaceSymbol targetInterface => MapClrType is { } interfaceMapClrType
                ? InterfaceSymbol.Construct(targetInterface, arguments, interfaceMapClrType)
                : InterfaceSymbol.Construct(targetInterface, arguments),
            _ => type,
        };
    }

    /// <summary>
    /// Issue #951: determines whether the supplied expression is an arrow
    /// lambda with at least one parameter whose type clause is omitted, so its
    /// parameter type(s) must be inferred from a target delegate.
    /// </summary>
    /// <param name="inner">The (already name-unwrapped) argument expression.</param>
    /// <returns><see langword="true"/> for an arrow lambda carrying an
    /// untyped parameter slot.</returns>
    private static bool IsUntypedArrowLambda(ExpressionSyntax inner)
    {
        inner = UnwrapArgumentValueWrappers(inner);
        if (inner is not LambdaExpressionSyntax lambda)
        {
            return false;
        }

        return ContainsTargetDependentLambda(lambda);
    }

    internal static bool ContainsTargetDependentLambda(ExpressionSyntax syntax)
    {
        syntax = UnwrapArgumentValueWrappers(syntax);

        if (syntax is LambdaExpressionSyntax lambda)
        {
            for (var i = 0; i < lambda.Parameters.Count; i++)
            {
                if (lambda.Parameters[i].Type == null)
                {
                    return true;
                }
            }

            return ContainsTargetDependentLambda(lambda.Body);
        }

        return syntax switch
        {
            BlockExpressionSyntax block =>
                (block.Expression != null
                    && ContainsTargetDependentLambda(block.Expression))
                || ContainsTargetDependentLambdaInReturns(block),
            ConditionalExpressionSyntax conditional =>
                ContainsTargetDependentLambda(conditional.WhenTrue)
                || ContainsTargetDependentLambda(conditional.WhenFalse),
            IfExpressionSyntax ifExpression =>
                ContainsTargetDependentLambda(ifExpression.ThenBlock)
                || (ifExpression.ElseExpression != null
                    && ContainsTargetDependentLambda(ifExpression.ElseExpression)),
            IfLetExpressionSyntax ifLetExpression =>
                ContainsTargetDependentLambda(ifLetExpression.ThenBlock)
                || (ifLetExpression.ElseExpression != null
                    && ContainsTargetDependentLambda(ifLetExpression.ElseExpression)),
            SwitchExpressionSyntax switchExpression =>
                switchExpression.Arms.Any(arm =>
                    ContainsTargetDependentLambda(arm.Result)),
            BinaryExpressionSyntax binary
                when binary.OperatorToken.Kind == SyntaxKind.QuestionQuestionToken =>
                    ContainsTargetDependentLambda(binary.Left)
                    || ContainsTargetDependentLambda(binary.Right),
            _ => false,
        };
    }

    private static bool ContainsTargetDependentLambdaInReturns(
        BlockExpressionSyntax block)
    {
        foreach (var returnStatement in EnumerateExplicitReturns(block))
        {
            if (ContainsTargetDependentLambda(
                Invariant.Required(
                    returnStatement.Expression,
                    "explicit value-return enumeration excludes bare returns")))
            {
                return true;
            }
        }

        return false;
    }

    private static IEnumerable<ReturnStatementSyntax> EnumerateExplicitReturns(
        BlockExpressionSyntax block)
    {
        var stack = new Stack<SyntaxNode>(block.Statements.Cast<SyntaxNode>());
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            if (node is LambdaExpressionSyntax
                or FunctionLiteralExpressionSyntax
                or FunctionDeclarationSyntax)
            {
                continue;
            }

            if (node is ReturnStatementSyntax { Expression: { } expression })
            {
                yield return (ReturnStatementSyntax)node;
                continue;
            }

            foreach (var child in node.GetChildren())
            {
                stack.Push(child);
            }
        }
    }

    /// <summary>
    /// Constructs a <see cref="BoundCallExpression"/> for a direct function
    /// call, applying ADR-0047 §6 / issue #176 <c>[Conditional]</c> call-site
    /// elision. When elision applies, the resulting call carries an empty
    /// argument list (C# semantics: arguments to a conditional method are
    /// not evaluated when the symbol is undefined) and the
    /// <see cref="BoundCallExpression.IsConditionalElided"/> flag is set so
    /// the emitter and interpreter skip both argument evaluation and the
    /// method invocation. The validation that the function returns
    /// <c>void</c> was performed at declaration time (GS0212), so callers
    /// can rely on the elided call being a no-op of type <c>void</c>.
    /// Argument binding still ran above so wrong-type diagnostics on the
    /// elided arguments are reported normally.
    /// </summary>
    private BoundExpression CreatePossiblyElidedCall(CallExpressionSyntax syntax, FunctionSymbol function, ImmutableArray<BoundExpression> arguments, TypeSymbol? returnType, ImmutableArray<TypeSymbol> methodTypeArguments = default)
    {
        if (KnownAttributes.IsConditionallyElided(function.Attributes, Scope.PreprocessorSymbols))
        {
            return new BoundCallExpression(null, function, ImmutableArray<BoundExpression>.Empty, returnType, isConditionalElided: true) { MethodTypeArguments = methodTypeArguments };
        }

        return new BoundCallExpression(syntax, function, arguments, returnType) { MethodTypeArguments = methodTypeArguments };
    }

    /// <summary>
    /// ADR-0156 Phase 2: binds an unqualified call whose name matches a
    /// function-typed global (a <c>System.Func</c>/<c>System.Action</c>-shaped
    /// static field) declared by a prior interactive submission. The field is
    /// loaded from the submission's <c>&lt;Program&gt;</c> container and the
    /// invocation dispatches through the ordinary indirect-call path.
    /// </summary>
    /// <param name="syntax">The call syntax.</param>
    /// <param name="submissionImports">The active submission import set.</param>
    /// <param name="result">The bound invocation, when the name matched an invocable global.</param>
    /// <returns><c>true</c> when the call was bound (or errored) against a submission global.</returns>
    private bool TryBindSubmissionDelegateGlobalCall(CallExpressionSyntax syntax, SubmissionImports submissionImports, out BoundExpression? result)
    {
        result = null;
        var name = syntax.Identifier.Text;
        if (!submissionImports.TryFindGlobalVariable(Scope.References, name, out var programType, out _))
        {
            return false;
        }

        if (programType is null)
        {
            return false;
        }

        var field = programType.GetField(name, BindingFlags.Public | BindingFlags.Static);
        if (field is null || !TryMapClrDelegateToFunctionType(field.FieldType, out var functionType))
        {
            return false;
        }

        // Static field access has no instance receiver; this constructor's
        // non-null annotation predates its use for static fields.
        var calleeLoad = new BoundClrPropertyAccessExpression(
            syntax,
            receiver: null,
            field,
            Invariant.Required(functionType, "a mapped CLR delegate has a function type"));

        // The callback uses null to mean that no null-safe invocation token was present.
        result = BindIndirectCallExpression(syntax, calleeLoad, name, syntax.Identifier.Location, nullSafeInvocation: null);
        return true;
    }

    // Maps a System.Func`N / System.Action`N CLR delegate shape back to the
    // equivalent G# function type so the indirect-call binder (and the
    // emitter's Invoke dispatch) can consume it. Other delegate shapes (named
    // G# delegates, custom CLR delegates) are not mapped here.
    private static bool TryMapClrDelegateToFunctionType(Type clrType, out FunctionTypeSymbol? functionType)
    {
        functionType = null;
        if (clrType is null || !ClrTypeUtilities.IsDelegateType(clrType))
        {
            return false;
        }

        var fullName = clrType.IsGenericType ? clrType.GetGenericTypeDefinition().FullName : clrType.FullName;
        var isAction = string.Equals(fullName, "System.Action", StringComparison.Ordinal)
            || (fullName?.StartsWith("System.Action`", StringComparison.Ordinal) ?? false);
        var isFunc = fullName?.StartsWith("System.Func`", StringComparison.Ordinal) ?? false;
        if (!isAction && !isFunc)
        {
            return false;
        }

        var args = clrType.IsGenericType ? clrType.GetGenericArguments() : Type.EmptyTypes;
        var parameterCount = isFunc ? args.Length - 1 : args.Length;
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(parameterCount);
        for (var i = 0; i < parameterCount; i++)
        {
            var mapped = TypeSymbol.FromClrType(args[i]);
            if (mapped is null || mapped == TypeSymbol.Error)
            {
                return false;
            }

            parameterTypes.Add(mapped);
        }

        var returnType = isFunc ? TypeSymbol.FromClrType(args[^1]) : TypeSymbol.Void;
        if (returnType is null || returnType == TypeSymbol.Error)
        {
            return false;
        }

        functionType = FunctionTypeSymbol.Get(parameterTypes.MoveToImmutable(), returnType);
        return true;
    }
}
