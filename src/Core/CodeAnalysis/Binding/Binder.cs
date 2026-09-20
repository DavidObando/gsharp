// <copyright file="Binder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

#pragma warning disable SA1201 // Rich anonymous-object helper types stay next to their binding entry point.

/// <summary>
/// Binder.
/// </summary>
public sealed class Binder
{
#pragma warning disable SA1202 // 'internal' members should appear before 'private' members — kept in original positions during PR-B-8 extraction to minimize diff churn.
    /// <summary>
    /// Targets permitted on a function declaration (member or free):
    /// <c>method</c> by default; <c>return</c> via use-site qualifier.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> FunctionDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Method, AttributeTargetKind.Return);

    /// <summary>
    /// Targets permitted on a parameter: only <c>param</c>.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> ParameterAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Param);

    /// <summary>
    /// Targets permitted on a type-shaped declaration
    /// (<c>struct</c> / <c>interface</c> / <c>enum</c> / type alias).
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> TypeDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Type);

    /// <summary>
    /// Targets permitted on a field declaration: only <c>field</c>.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> FieldDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Field);

    /// <summary>
    /// Targets permitted on a property declaration (ADR-0051):
    /// <c>property</c> by default; <c>field</c> for the backing field;
    /// <c>method</c> for the synthesized accessors.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> PropertyDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Property, AttributeTargetKind.Field, AttributeTargetKind.Method);

    /// <summary>
    /// Targets permitted on an event declaration (ADR-0052):
    /// <c>event</c> by default; <c>field</c> for the backing field;
    /// <c>method</c> for the synthesized add/remove accessors.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> EventDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Event, AttributeTargetKind.Field, AttributeTargetKind.Method);

    /// <summary>
    /// Targets permitted on a <c>var</c>/<c>let</c>/<c>const</c> variable
    /// declaration. ADR-0047 §2 assigns the default target <c>field</c> to
    /// these declarations (both at top level — where the variable becomes a
    /// CLR static field — and in local scope — where the attribute carries
    /// compiler-recognised semantics like <c>@Obsolete</c> for use-site
    /// diagnostics).
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> VariableDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Field);

    /// <summary>
    /// Targets permitted on a file-level annotation lead-in (ADR-0047 §2):
    /// <c>assembly</c> and <c>module</c>.
    /// </summary>
    internal static readonly ImmutableHashSet<AttributeTargetKind> FileDeclarationAllowedTargets =
        ImmutableHashSet.Create(AttributeTargetKind.Assembly, AttributeTargetKind.Module);

    // PR-B-1: cross-cutting binder state lives on BinderContext so the
    // upcoming Binder-component extractions (MemberLookup, ConversionClassifier,
    // OverloadResolver, …) can consume it via constructor injection. The
    // `scope` member is kept as a forwarding property here purely to limit the
    // diff in this PR; subsequent extractions will switch to `binderCtx.RootScope`.
    private readonly BinderContext binderCtx;

    // PR-B-2: the pure "given a type T and a name N, return the candidates"
    // facade. Consumes the BinderContext for the reference resolver / scope
    // and delegates low-level CLR member walks to ClrTypeUtilities. Composed,
    // not inherited; MemberLookup never back-references Binder.
    private readonly MemberLookup memberLookup;

    // PR-B-3: the binder-side wrapper around Conversion.Classify. Owns the
    // BindConversion / BindClr*Conversion family, the CLR-parameter conversion
    // / argument-shaping helpers, the method-group → delegate resolution, the
    // ref-kind argument validation, and the default-value attachment that
    // previously lived directly on Binder. Composed via narrow Func callbacks
    // for the still-on-Binder helpers it needs to call back into; never
    // back-references Binder.
    private readonly ConversionClassifier conversions;

    // PR-B-4: the binder-side facade for call-site overload resolution.
    // Owns BindCallExpression / BindConstructorCallExpression /
    // BindExtensionFunctionCall / BindUserInstanceCall plus their
    // supporting machinery (named-argument reordering, default-value
    // fill, params lowering, generic type-argument inference, candidate
    // selection, and diagnostic emission). Wraps the pure reflection-level
    // resolver in ClrOverloadResolution.cs (which is unchanged). Composed
    // via Func / custom-delegate callbacks; never back-references Binder.
    private readonly OverloadResolver overloads;

    // PR-B-5: the binder-side facade for per-pattern-kind binding.
    // Owns BindPattern dispatch plus BindConstantPattern / BindTypePattern
    // / BindPropertyPattern / BindRelationalPattern / BindListPattern.
    // Switch-statement / switch-expression glue (discriminant binding,
    // arm walking, exhaustiveness reporting, narrowing-frame management)
    // stays on Binder for now and will move to StatementBinder (B-7) and
    // ExpressionBinder (B-9). Composed via narrow Func callbacks; never
    // back-references Binder.
    private readonly PatternBinder patterns;

    // PR-B-6: the binder-side facade for function-literal (lambda)
    // binding. Owns BindFunctionLiteralExpression, the captured-variable
    // analysis (CapturedVariableCollector), the erased-adapter
    // synthesizer (CreateErasedFunctionLiteralAdapter +
    // ErasedFunctionLiteralAdapterRewriter), the async-return-type
    // widening helper (WrapAsTask), and the TryGetFunctionLiteral
    // unwrap helper. Composed via narrow Func / Action callbacks;
    // never back-references Binder. TryGetFunctionLiteral remains
    // accessible as `LambdaBinder.TryGetFunctionLiteral` so this
    // constructor can keep forwarding it as the
    // `OverloadResolver.TryGetFunctionLiteralDelegate` wired into
    // `OverloadResolver`'s constructor below.
    private readonly LambdaBinder lambdas;

    // PR-B-7: the binder-side facade for per-statement-kind binding. Owns
    // every Bind*Statement (block / variable declaration / if / for-family /
    // try / throw / using / defer / go / channel-send / select / scope /
    // yield / break / continue / return / expression-statement) plus the
    // narrowing helpers (nil-guard, MemberNotNullWhen merging, pattern
    // narrowing) and several deferred-call bookkeeping helpers consumed
    // only by statement binders. Composed via narrow Func / delegate
    // callbacks; never back-references Binder.
    private readonly StatementBinder statements;

    // PR-B-8: the binder-side facade for per-declaration-kind binding. Owns
    // every Bind*Declaration (type alias, named delegate, enum, struct,
    // interface, function), `BindStructDeclarationBody` plus its
    // interface-implementation verification pass, `BindConstructorDeclarations`
    // and the `: base(...)` initializer resolvers, `BindTypeParameterList`,
    // the two symbol-construction `BindVariableDeclaration` overloads, the
    // declaration-side attribute binder (`BindAttributes` / `BindAttribute`),
    // and the queue of pending struct→interface implementation checks. Composed
    // via narrow Func / delegate callbacks; never back-references Binder.
    private readonly DeclarationBinder declarations;

    // PR-B-9: the binder-side facade for per-expression-kind binding. Owns
    // every Bind*Expression (literals, operators, name/member access, calls,
    // assignments, indexers, switch expressions, await/event subscription
    // bindings) plus the long tail of expression-only helpers. Split across
    // nested partial files: ExpressionBinder.cs (ctor + dispatch + name
    // binding) and ExpressionBinder.{Literals,Operators,Calls,Access,
    // Assignments,Async,SwitchExpr}.cs. Composed via narrow Func / Action
    // callbacks; never back-references Binder.
    private readonly ExpressionBinder expressions;

    private FunctionSymbol? function;

    // SA1202 exempt: static initializer placement matches Binder's design.
#pragma warning disable SA1642
    /// <summary>
    /// Static-initializer hook for <see cref="Binder"/>.
    /// </summary>
#pragma warning restore SA1642
    static Binder()
    {
        // Stream E: let overload-resolution see user-defined op_Implicit when
        // built-in conversions don't apply. Implicit-only here — explicit
        // conversions never participate in overload tie-breaking.
        ClrOverloadResolution.UserDefinedImplicitConversionLookup ??= (source, target) =>
        {
            return ClrOperatorResolution.TryResolveConversion(source, target, allowExplicit: false, out _, out _);
        };
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="Binder"/> class.
    /// </summary>
    /// <param name="parent">The parent scope.</param>
    /// <param name="function">The function to bind.</param>
    public Binder(BoundScope parent, FunctionSymbol? function)
    {
        binderCtx = new BinderContext(parent);
        memberLookup = new MemberLookup(binderCtx);
        conversions = new ConversionClassifier(
            binderCtx,
            memberLookup,
            bindExpression: syntax => Expressions.BindExpression(syntax),
            bindExpressionWithTargetType: (syntax, targetType) => Expressions.BindExpression(syntax, targetType),
            isFormattableStringTargetType: ExpressionBinder.IsFormattableStringTargetType,
            bindInterpolatedStringAsFormattable: (syntax, targetType) =>
            {
                return Expressions.BindInterpolatedStringAsFormattable(syntax, targetType);
            },
            createErasedFunctionLiteralAdapter: (literal, targetFunctionType, exactTargetReturnType) =>
                Lambdas.CreateErasedFunctionLiteralAdapter(
                    literal,
                    targetFunctionType,
                    exactTargetReturnType: exactTargetReturnType),
            createClrMethodGroupAdapter: (group, targetFunctionType) => Lambdas.CreateClrMethodGroupAdapter(group, targetFunctionType),
            createUserExtensionMethodGroupAdapter: group => Lambdas.CreateUserExtensionMethodGroupAdapter(group),
            getMethodGroupObservableReturnType: (method, returnType) =>
                method.IsAsyncOrSuspending && !method.IsAsyncVoid && !IsAsyncIteratorReturnType(returnType)
                    ? Lambdas.WrapAsTask(returnType, method.AsyncReturnsValueTask)
                    : returnType,
            isLvalue: ExpressionBinder.IsLvalue,
            getRefKindFromModifier: GetRefKindFromModifier,
            refKindToString: RefKindToString);
        overloads = new OverloadResolver(
            binderCtx,
            memberLookup,
            conversions,
            bindExpression: syntax => Expressions.BindExpression(syntax),
            bindExpressionWithTargetType: (syntax, targetType) => Expressions.BindExpression(syntax, targetType),
            bindRefArgumentExpression: (refSyntax, parameter) => Expressions.BindRefArgumentExpression(refSyntax, parameter),
            tryRebindInlineOutVarPlaceholder: (boundArg, slotSyntax, resolvedParameter, substitutedPointeeType) => Expressions.TryRebindInlineOutVarPlaceholder(boundArg, slotSyntax, resolvedParameter, substitutedPointeeType),
            bindTypeClause: BindTypeClause,
            lookupType: LookupType,
            lookupTypeWithArity: LookupType,
            reportObsoleteUseIfApplicable: ReportObsoleteUseIfApplicable,
            tryBindClrConstructorCall: (CallExpressionSyntax syntax, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out BoundExpression? result) =>
            {
                return Expressions.TryBindClrConstructorCall(syntax, out result);
            },
            tryBindIntrinsicCall: (CallExpressionSyntax syntax, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out BoundExpression? result) =>
            {
                return Expressions.TryBindIntrinsicCall(syntax, out result);
            },
            tryBindInheritedClrInstanceCall: (BoundExpression receiver, Type? importedBaseClr, string methodName, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out BoundExpression? result, Type[]? explicitTypeArgs, ImmutableArray<TypeSymbol> typeArgSymbols, ImmutableArray<string> argumentNames, bool allowProtectedInherited) =>
            {
                result = null;
                var success = Expressions.TryBindInheritedClrInstanceCall(receiver, importedBaseClr, methodName, arguments, ce, out result, explicitTypeArgs, typeArgSymbols, argumentNames, allowProtectedInherited: allowProtectedInherited);
                return success;
            },
            isFormattableStringTargetType: ExpressionBinder.IsFormattableStringTargetType,
            bindInterpolatedStringAsFormattable: (syntax, targetType) =>
            {
                return Expressions.BindInterpolatedStringAsFormattable(syntax, targetType);
            },
            getRefKindFromModifier: GetRefKindFromModifier,
            refKindToString: RefKindToString,
            createErasedFunctionLiteralAdapter: (literal, targetFunctionType) => Lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType),
            wrapAsTask: (t, useValueTask) => Lambdas.WrapAsTask(t, useValueTask),
            isAsyncIteratorReturnType: IsAsyncIteratorReturnType,
            completeSuspendingCall: (call, logicalType, location, calleeName) => Expressions.CompleteSuspendingCall(call, logicalType, location, calleeName),
            tryGetFunctionLiteral: LambdaBinder.TryGetFunctionLiteral,
            inferTypeArguments: InferTypeArguments,
            substituteType: (t, subst) => SubstituteType(t, subst, scope.References.MapClrTypeToReferences),
            satisfiesConstraint: SatisfiesConstraint,
            describeConstraint: DescribeConstraint,
            getCurrentFunction: () => this.function,
            bindLambdaWithTarget: (syntax, targetType) =>
            {
                return Diagnostics.SuppressDuplicateDiagnosticsIn(
                    syntax.Location,
                    () => Lambdas.BindLambdaExpression(syntax, targetType));
            },
            bindUserTypeStaticCall: (structSym, ce) =>
            {
                return Expressions.BindUserTypeStaticCall(structSym, ce);
            },
            bindImportedClrStaticCall: (clrType, ce) =>
            {
                return Expressions.BindAccessorCall(receiver: null, new ImportedClassSymbol(clrType, ce, references: scope.References), ce);
            });
        patterns = new PatternBinder(
            binderCtx,
            conversions,
            bindExpression: syntax => Expressions.BindExpression(syntax),
            bindTypeClause: BindTypeClause,
            isNilLiteral: StatementBinder.IsNilLiteral);

        // ADR-0185: bindLocalVariable/bindTupleDestructuringPrelude below
        // reuse StatementBinder's own local-declaration callback and its
        // BindForTupleLoopPrelude helper for a destructured arrow-lambda
        // parameter — see LambdaBinder's own ctor doc. `Statements` is
        // assigned below in this same constructor, but these are closures
        // (not invoked until an actual lambda is bound, well after
        // construction finishes), matching the existing `Lambdas.*`
        // back-references from the `statements =` call further down.
        lambdas = new LambdaBinder(
            binderCtx,
            conversions,
            bindBlockStatement: BindNestedFunctionBodyForLambdas,
            bindTypeClause: BindTypeClause,
            bindReturnTypeClause: (syntax, isAsync) => BindReturnTypeClause(syntax, isAsync),
            isIteratorReturnType: IsIteratorReturnType,
            isAsyncIteratorReturnType: IsAsyncIteratorReturnType,
            resolveClrTypeForGenericArg: ResolveClrTypeForGenericArg,
            getCurrentFunction: () => this.function,
            setCurrentFunction: fn => this.function = fn,
            bindParameterAttributes: syntax => Declarations.BindAttributes(
                syntax.Annotations,
                AttributeTargetKind.Param,
                ParameterAllowedTargets,
                "a parameter declaration",
                System.AttributeTargets.Parameter),
            bindLocalVariable: (identifier, isReadOnly, type) =>
            {
                return Declarations.BindVariableDeclaration(identifier, isReadOnly, type);
            },
            bindTupleDestructuringPrelude: (identifiers, closeParenLocation, openParenLocation, elementVariable) =>
            {
                return Statements.BindForTupleLoopPrelude(identifiers, closeParenLocation, openParenLocation, elementVariable);
            },
            bindLambdaBodyExpression: BindLambdaBodyExpressionForLambdas,
            bindTypeParameterList: syntax =>
            {
                return Declarations.BindTypeParameterList(syntax);
            });
        BoundExpression BindExpressionWithTargetTypeForStatements(
            ExpressionSyntax syntax,
            TypeSymbol targetType) =>
            Expressions.BindExpression(syntax, targetType);

        // ADR-0176 (#3897): a lambda / local-function body is emitted as its own
        // method, so the enclosing catch handlers are not in scope for a
        // `rethrow` written inside it.
        BoundStatement BindNestedFunctionBodyForLambdas(BlockStatementSyntax syntax) =>
            Statements.BindNestedFunctionBody(syntax);
        BoundExpression BindLambdaBodyExpressionForLambdas(ExpressionSyntax syntax, TypeSymbol? targetType) =>
            Statements.OutsideExceptionHandlers(() => Expressions.BindLambdaBodyExpression(syntax, targetType));
        statements = new StatementBinder(
            binderCtx,
            conversions,
            patterns,
            bindExpression: (syntax, canBeVoid) =>
            {
                return Expressions.BindExpression(syntax, canBeVoid);
            },
            bindExpressionWithTargetType: BindExpressionWithTargetTypeForStatements,
            bindTypeClause: BindTypeClause,
            bindLocalVariable: (identifier, isReadOnly, type) =>
            {
                return Declarations.BindVariableDeclaration(identifier, isReadOnly, type);
            },
            bindLocalVariableWithAccessibility: (identifier, isReadOnly, type, accessibility) =>
            {
                return Declarations.BindVariableDeclaration(identifier, isReadOnly, type, accessibility);
            },
            bindVariableReference: (name, location) =>
            {
                return Expressions.BindVariableReference(name, location);
            },
            bindInterpolatedStringAsFormattable: (syntax, targetType) =>
            {
                return Expressions.BindInterpolatedStringAsFormattable(syntax, targetType);
            },
            isFormattableStringTargetType: ExpressionBinder.IsFormattableStringTargetType,
            isLvalue: ExpressionBinder.IsLvalue,
            isIteratorReturnType: IsIteratorReturnType,
            resolveAccessibility: ResolveAccessibility,
            bindVariableDeclarationAttributes: (annotations, positionDescription) =>
            {
                return Declarations.BindAttributes(annotations, AttributeTargetKind.Field, VariableDeclarationAllowedTargets, positionDescription, System.AttributeTargets.Field);
            },
            getCurrentFunction: () => this.function,
            bindLambdaWithTargetType: (syntax, targetType) =>
            {
                return Lambdas.BindLambdaExpression(syntax, targetType);
            },
            prepareGenericLocalFunctionDeclaration: syntax =>
            {
                return Lambdas.PrepareGenericLocalFunctionDeclaration(syntax);
            },
            checkNonGenericLocalFunctionEnclosingTypeParameterReference: (location, name, literal) => Lambdas.CheckAsyncNonGenericLocalFunctionEnclosingTypeParameterInParameter(location, name, literal),
            bindFunctionLiteralWithSelfDeclaration: (literalSyntax, onSignatureBound) =>
            {
                return Lambdas.BindFunctionLiteralExpression(literalSyntax, explicitName: null, onSignatureBound: onSignatureBound);
            },
            reconcileGenericLocalFunctionGroupCaptures: group =>
            {
                Lambdas.ReconcileGenericLocalFunctionGroupCaptures(group);
            });
        BoundExpression BindTypeOfExpressionForDeclarations(TypeOfExpressionSyntax syntax) =>
            Expressions.BindTypeOfExpression(syntax);
        BoundExpression BindExpressionForDeclarations(ExpressionSyntax syntax) =>
            Expressions.BindExpression(syntax);
        declarations = new DeclarationBinder(
            binderCtx,
            conversions,
            bindExpression: BindExpressionForDeclarations,
            bindTypeClause: BindTypeClause,
            bindReturnTypeClause: (syntax, isAsync) =>
            {
                return BindReturnTypeClause(syntax, isAsync);
            },
            bindTypeOfExpression: BindTypeOfExpressionForDeclarations,
            bindArrayCreationExpression: syntax =>
            {
                return Expressions.BindArrayCreationExpression(syntax);
            },
            resolveAccessibility: ResolveAccessibility,
            lookupType: LookupType,
            getEffectiveArgumentClrTypeForOverloadResolution: t =>
            {
                // Issue #3984: the two DeclarationBinder consumers of this
                // delegate are BOTH applicability probes — they build a
                // `System.Type?[]` for `ClrOverloadResolution` and use it for
                // nothing else — so they need the same erasure ride-throughs
                // every ExpressionBinder probe already gets. The plain
                // `GetEffectiveArgumentClrType` is honest CLR identity and
                // returns null for a type with no CLR backing of its own
                // (`[]T`, `map[K, V]`, `chan[T]`, a symbolic tuple, a
                // same-compilation user type); a `: base(...)` argument of such
                // a type therefore set `argsAllTyped = false` and resolution
                // never ran at all, so GS0214 reported an arity that was in
                // fact present. Ranking on the erased shape is safe because
                // the selected constructor's parameters are re-bound through
                // `Conversion` against the SYMBOLIC parameter type afterwards
                // (see the per-parameter loop in ResolveClrBaseConstructor),
                // exactly as the ExpressionBinder probes re-project their
                // arguments after ranking: the erasure decides what may be
                // examined, never what is accepted.
                return Expressions.GetEffectiveArgumentClrTypeForOverloadResolution(t);
            },
            isAsyncIteratorReturnType: IsAsyncIteratorReturnType,
            isAsyncSequenceReturnType: IsAsyncSequenceReturnType,
            isPrimitiveTypeName: IsPrimitiveTypeName,
            refKindToString: RefKindToString,
            getCurrentFunction: () => this.function,
            setCurrentFunction: fn => this.function = fn,
            bindInterpolatedStringAsFormattable: (syntax, targetType) =>
            {
                return Expressions.BindInterpolatedStringAsFormattable(syntax, targetType);
            });
        expressions = new ExpressionBinder(
            binderCtx,
            memberLookup,
            conversions,
            overloads,
            patterns,
            lambdas,
            bindTypeClause: BindTypeClause,
            lookupType: LookupType,
            resolveClrTypeForGenericArg: ResolveClrTypeForGenericArg,
            reportObsoleteUseIfApplicable: ReportObsoleteUseIfApplicable,
            isAsyncIteratorReturnType: IsAsyncIteratorReturnType,
            getCurrentFunction: () => this.function,
            bindStatementList: (syntax, trailing) => Statements.BindStatementList(syntax, trailingStatement: trailing),
            bindLocalVariable: (identifier, isReadOnly, type) => Declarations.BindVariableDeclaration(identifier, isReadOnly, type),
            bindRichAnonymousObject: BindRichAnonymousObject,
            bindStructuralAdaptation: BindStructuralAdaptation);

        // statements/declarations still reference this.expressions through
        // the callbacks above; expressions is wired last so its constructor
        // sees fully-initialized siblings.
        this.function = function;

        if (function != null)
        {
            // Pre-compute parameter names once so both instance-member and
            // static-member seeding can defer to parameters (parameter wins
            // on name collision with a sibling static member; the existing
            // instance-vs-parameter precedence — instance pseudo-vars win
            // today via TryDeclareVariable's silent-skip — is preserved
            // verbatim for backward compatibility).
            var paramNames = new HashSet<string>(function.Parameters.Select(p => p.Name));

            // `seenMembers` tracks names already consumed by an instance
            // field/property so we can refuse to expose a same-named static
            // member by bare name (instance wins). It is also reused as the
            // de-dup set within the instance-member inheritance walk below.
            var seenMembers = new HashSet<string>();

            if (function.ThisParameter != null)
            {
                scope.TryDeclareVariable(function.ThisParameter);

                // ADR-0058 / ADR-0184 / issue #376: EVERY struct instance member's
                // `this` is implicitly `scoped ref` in C#, not just a `ref struct`'s
                // — its REF-safe-context is the method body, so a reference into the
                // receiver's own storage may not be returned. `@UnscopedRef` is the
                // opt-out, and it is now recognised by TYPE IDENTITY off the bound
                // attribute list (ADR-0084 §L5) rather than by matching the
                // annotation's spelling.
                //
                // The two facts are carried on SEPARATE flags on purpose:
                //   * IsScoped restricts the receiver's VALUE-scope
                //     (safe-to-escape) and is read by HasFunctionLocalReferentScope
                //     and RefCapabilities.SelectEscapeArguments, both of which only
                //     ever look at byref-like values — so widening the implicit
                //     `scoped` from `ref struct` receivers to all struct receivers
                //     is behaviour-neutral for an ordinary struct.
                //   * IsUnscopedRefReceiver governs the receiver's REF-scope, which
                //     is what `return ref this.<field>` actually depends on (see
                //     StatementBinder.HasFunctionLocalRefScope). The pre-ADR-0184
                //     code only ever cleared IsScoped, which is why `@UnscopedRef`
                //     changed nothing for a ref return.
                if (TypeSymbol.IsByRefLike(function.ReceiverType)
                    || function.ReceiverType is StructSymbol { IsClass: false })
                {
                    if (function.HasUnscopedRef)
                    {
                        function.ThisParameter.IsUnscopedRefReceiver = true;
                    }
                    else
                    {
                        function.ThisParameter.IsScoped = true;
                    }
                }

                // Phase 3.B.3 sub-step 2b: expose each field on the receiver
                // as a bare name inside the method body. Field access lowers
                // to `this.<field>` at name resolution time.
                // Sub-step 3: walk inheritance chain so inherited fields are
                // also accessible via bare name. Derived shadowing wins.
                if (function.ReceiverType is StructSymbol receiverStruct)
                {
                    foreach (var t in receiverStruct.GetHierarchy())
                    {
                        if (!t.Fields.IsDefaultOrEmpty)
                        {
                            foreach (var fld in t.Fields)
                            {
                                // Issue #1240: a method/constructor parameter named
                                // like an instance field shadows that field for bare
                                // (unqualified) access — matching C# semantics and the
                                // parameter > instance member > static member precedence
                                // already enforced for static members below. The field
                                // remains reachable as `this.<field>`. Without this
                                // guard the field's pseudo-variable is seeded first and
                                // TryDeclareVariable silently drops the later parameter,
                                // so the parameter is wrongly ignored.
                                if (paramNames.Contains(fld.Name))
                                {
                                    continue;
                                }

                                // Issue #2060 (follow-up to #2044): `private` is
                                // not inherited (unlike `protected`), but the
                                // pseudo-variable is still declared here for an
                                // inherited private field so bare-name access
                                // resolves to it — BindVariableReference then
                                // runs it through AccessibilityChecker.IsAccessible
                                // and reports GS0472, instead of silently
                                // dropping the name (which used to surface as a
                                // misleading "undefined variable").
                                if (seenMembers.Add(fld.Name))
                                {
                                    scope.TryDeclareVariable(new ImplicitFieldVariableSymbol(function.ThisParameter, t, fld));
                                }
                            }
                        }

                        if (!t.Properties.IsDefaultOrEmpty)
                        {
                            foreach (var prop in t.Properties)
                            {
                                // ADR-0118 / issue #944: an indexer member has the
                                // CLR name `Item` but is not accessible by bare name —
                                // it is reached only through `this[i]` index access.
                                if (prop.IsIndexer)
                                {
                                    continue;
                                }

                                // Issue #1240: a parameter named like an instance
                                // property shadows that property for bare access; the
                                // property stays reachable as `this.<property>`.
                                if (paramNames.Contains(prop.Name))
                                {
                                    continue;
                                }

                                // Issue #2044: a base class's private property must
                                // not be exposed as a bare name inside a derived
                                // type's methods (private is not inherited).
                                if (prop.Accessibility == Accessibility.Private && !ReferenceEquals(t, receiverStruct))
                                {
                                    continue;
                                }

                                if (seenMembers.Add(prop.Name))
                                {
                                    scope.TryDeclareVariable(new ImplicitPropertyVariableSymbol(function.ThisParameter, t, prop));
                                }
                            }
                        }

                        // Issue #1213 / #1221: expose a field-like event of the
                        // receiver type *or any base class* as a bare name inside
                        // method bodies, bound to the event's backing delegate
                        // field. This lets the canonical raise pattern
                        // `MyEvent?.Invoke(args)` resolve, exactly as C# compiles
                        // it to a read of the backing field. Issue #1213 enabled
                        // this for the declaring type; issue #1221 extends it to
                        // derived types so an inherited event can be raised from a
                        // derived class (the inheritance walk binds to the base
                        // type `t` that declares the field). A bare
                        // `MyEvent += handler` still routes to the event-
                        // subscription path, which is checked first in
                        // BindBareEventOrCompoundAssignment.
                        if (!t.Events.IsDefaultOrEmpty)
                        {
                            foreach (var evt in t.Events)
                            {
                                if (evt.IsFieldLike
                                    && evt.BackingField != null
                                    && !paramNames.Contains(evt.Name)
                                    && seenMembers.Add(evt.Name))
                                {
                                    scope.TryDeclareVariable(new ImplicitFieldVariableSymbol(function.ThisParameter, t, evt.BackingField));
                                }
                            }
                        }
                    }
                }
            }

            // Issue #261 / ADR-0053: expose sibling static fields and static
            // properties of the enclosing user type as bare names inside both
            // shared method bodies AND instance method bodies, so that
            //
            //     class Counter {
            //         shared { prop CallCount int32 }
            //         func Bump() { CallCount += 1 }    // bare access OK
            //     }
            //
            // resolves without requiring `TypeName.` prefix. Static members
            // are exposed for the enclosing type only (no base-class walk) —
            // this is consistent with the qualified `Type.StaticMember`
            // paths (BindUserTypeStaticMemberAccess, BindFieldAssignmentExpression)
            // which also do not walk inheritance for statics today.
            //
            // Shadowing precedence (enforced by paramNames/seenMembers):
            //   parameter > instance member > static member.
            var ownerStruct = (function.StaticOwnerType as StructSymbol)
                ?? (function.ReceiverType as StructSymbol);
            if (ownerStruct != null)
            {
                if (!ownerStruct.StaticFields.IsDefaultOrEmpty)
                {
                    foreach (var fld in ownerStruct.StaticFields)
                    {
                        if (paramNames.Contains(fld.Name) || seenMembers.Contains(fld.Name))
                        {
                            continue;
                        }

                        if (seenMembers.Add(fld.Name))
                        {
                            scope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(ownerStruct, fld));
                        }
                    }
                }

                // Issue #948: const fields are static for bare-name resolution
                // inside the declaring type's members. Their reads are inlined
                // as the compile-time constant value by the emitter/interpreter.
                if (!ownerStruct.ConstFields.IsDefaultOrEmpty)
                {
                    foreach (var fld in ownerStruct.ConstFields)
                    {
                        if (paramNames.Contains(fld.Name) || seenMembers.Contains(fld.Name))
                        {
                            continue;
                        }

                        if (seenMembers.Add(fld.Name))
                        {
                            scope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(ownerStruct, fld));
                        }
                    }
                }

                if (!ownerStruct.StaticProperties.IsDefaultOrEmpty)
                {
                    foreach (var prop in ownerStruct.StaticProperties)
                    {
                        if (paramNames.Contains(prop.Name) || seenMembers.Contains(prop.Name))
                        {
                            continue;
                        }

                        if (seenMembers.Add(prop.Name))
                        {
                            scope.TryDeclareVariable(new ImplicitStaticPropertyVariableSymbol(ownerStruct, prop));
                        }
                    }
                }

                // Issue #3907 / #3911: expose a field-like STATIC event of the
                // enclosing type as a bare name, bound to its backing delegate
                // field — the exact static counterpart of the instance
                // exposure above (issues #1213 / #1221), and what makes the
                // canonical raise pattern
                //
                //     shared { event Ticked EventHandler? }
                //     shared func Raise() { Ticked?(nil, EventArgs.Empty) }
                //
                // resolve, precisely as C# compiles a field-like event access
                // inside its declaring type to a read of the backing field.
                //
                // Static events were fully implemented by issue #263 —
                // declaration, accessor emission with the #256
                // Interlocked.CompareExchange loop, EventDef/MethodSemantics
                // metadata, and `Type.Event += handler` subscription all work.
                // This ONE lookup step was the omission, so a static event
                // could be declared and subscribed to but never read or raised.
                // ADR-0052's "Static events on user types" follow-up entry is
                // amended accordingly.
                //
                // Scoped to the enclosing type with no base-class walk, which
                // is what every other static path here does (see the note on
                // the static-field block above). A bare `Ticked += handler`
                // still routes to the event-subscription path, which
                // BindBareEventOrCompoundAssignment checks before it consults
                // this variable.
                if (!ownerStruct.StaticEvents.IsDefaultOrEmpty)
                {
                    foreach (var evt in ownerStruct.StaticEvents)
                    {
                        if (!evt.IsFieldLike
                            || evt.BackingField == null
                            || paramNames.Contains(evt.Name)
                            || seenMembers.Contains(evt.Name))
                        {
                            continue;
                        }

                        if (seenMembers.Add(evt.Name))
                        {
                            scope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(ownerStruct, evt.BackingField));
                        }
                    }
                }
            }

            // ADR-0089 / issue #1030: expose interface static *state* by bare
            // name inside the owning interface's static members (static
            // methods, default-bodied static property accessors). The owner is
            // an InterfaceSymbol, so `ownerStruct` is null above; resolve the
            // interface owner separately and inject its static + const fields.
            var ownerInterface = function.StaticOwnerType as InterfaceSymbol;
            if (ownerInterface != null)
            {
                if (!ownerInterface.StaticFields.IsDefaultOrEmpty)
                {
                    foreach (var fld in ownerInterface.StaticFields)
                    {
                        if (paramNames.Contains(fld.Name) || seenMembers.Contains(fld.Name))
                        {
                            continue;
                        }

                        if (seenMembers.Add(fld.Name))
                        {
                            scope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(ownerInterface, fld));
                        }
                    }
                }

                if (!ownerInterface.ConstFields.IsDefaultOrEmpty)
                {
                    foreach (var fld in ownerInterface.ConstFields)
                    {
                        if (paramNames.Contains(fld.Name) || seenMembers.Contains(fld.Name))
                        {
                            continue;
                        }

                        if (seenMembers.Add(fld.Name))
                        {
                            scope.TryDeclareVariable(new ImplicitStaticFieldVariableSymbol(ownerInterface, fld));
                        }
                    }
                }
            }

            foreach (var p in function.Parameters)
            {
                if (ReferenceEquals(p, function.ThisParameter))
                {
                    continue;
                }

                // Issue #1262: a discard parameter (`_`) is non-referenceable —
                // it occupies a positional slot in the signature but is not
                // added to the body's lookup scope, so `_` does not resolve to
                // a parameter and repeated `_` parameters never collide.
                if (p.Name == "_")
                {
                    continue;
                }

                scope.TryDeclareVariable(p);
            }

            // Phase 4.1 / ADR-0020: expose declared generic type parameters
            // when binding the function body so that `T` resolves inside the
            // body to the TypeParameterSymbol. Issue #312: a method may carry
            // both the enclosing type's type parameters (when it is a member of
            // a generic class) and its own method-level type parameters; seed
            // the full enclosing type chain first, then the method's own so
            // each inner scope shadows outer names on collision.
            var enclosingGenericOwner = (function.ReceiverType ?? function.StaticOwnerType) as StructSymbol;
            var outerTypeParams = enclosingGenericOwner == null
                ? ImmutableArray<TypeParameterSymbol>.Empty
                : StructSymbol.CollectEnclosingTypeParameters(enclosingGenericOwner);
            var ownerTypeParams = enclosingGenericOwner?.Definition?.TypeParameters
                ?? enclosingGenericOwner?.TypeParameters
                ?? ImmutableArray<TypeParameterSymbol>.Empty;
            if (!outerTypeParams.IsDefaultOrEmpty || !ownerTypeParams.IsDefaultOrEmpty || function.IsGeneric)
            {
                binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                foreach (var tp in outerTypeParams)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }

                foreach (var tp in ownerTypeParams)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }

                foreach (var tp in function.TypeParameters)
                {
                    binderCtx.CurrentTypeParameters[tp.Name] = tp;
                }
            }
        }
    }

    // The seven sub-binders above are mutually referential (e.g. `expressions`
    // needs `conversions`, `conversions` needs `expressions`), so the
    // constructor wires each one's dependencies as closures over the
    // still-unassigned sibling fields — every closure is stored, not invoked,
    // and none of them runs until construction has fully completed (the rest
    // of the constructor after the wiring block only seeds `scope`, which
    // never calls back into a sub-binder). Reading a not-yet-assigned field
    // directly inside the SAME constructor makes the compiler's flow analysis
    // treat it as "maybe null" at that lexical point even though its declared
    // type is non-nullable and it is always non-null once this constructor
    // returns. The property accessors below exist only to break that
    // constructor-local flow tracking: as ordinary members (not the
    // constructor body performing the phased assignment) they see each field
    // solely through its declared, non-nullable type. Use these accessors —
    // not the bare field — from inside the wiring closures above.
    private ConversionClassifier Conversions => conversions;

    private OverloadResolver Overloads => overloads;

    private PatternBinder Patterns => patterns;

    private LambdaBinder Lambdas => lambdas;

    private StatementBinder Statements => statements;

    private DeclarationBinder Declarations => declarations;

    private ExpressionBinder Expressions => expressions;

    /// <summary>
    /// Gets the diagnostics bag.
    /// </summary>
    public DiagnosticBag Diagnostics => binderCtx.Diagnostics;

#pragma warning disable SA1300 // Element should begin with an uppercase letter
    private BoundScope scope
#pragma warning restore SA1300
    {
        get => binderCtx.RootScope;
        set => binderCtx.RootScope = value;
    }

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, resulting in a new chained global scope.
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope? previous, ImmutableArray<SyntaxTree> syntaxTrees)
        => BindGlobalScope(previous, syntaxTrees, references: null, implicitSystemImport: true);

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, resulting in
    /// a new chained global scope, using the supplied reference resolver to
    /// look up imported CLR types.
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <param name="references">The reference resolver; <c>null</c> selects <see cref="ReferenceResolver.Default"/>.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope? previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver? references)
        => BindGlobalScope(previous, syntaxTrees, references, implicitSystemImport: true);

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, with full control over implicit-import seeding.
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <param name="references">The reference resolver; <c>null</c> selects <see cref="ReferenceResolver.Default"/>.</param>
    /// <param name="implicitSystemImport">When <c>true</c>, an implicit <c>import System</c> is seeded before user imports are processed.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope? previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver? references, bool implicitSystemImport)
        => BindGlobalScope(previous, syntaxTrees, references, implicitSystemImport, preprocessorSymbols: null);

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, with full
    /// control over implicit-import seeding and the active preprocessor
    /// symbol set used by <c>[Conditional("SYMBOL")]</c> call-site elision
    /// (ADR-0047 §6 / issue #176).
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <param name="references">The reference resolver; <c>null</c> selects <see cref="ReferenceResolver.Default"/>.</param>
    /// <param name="implicitSystemImport">When <c>true</c>, an implicit <c>import System</c> is seeded before user imports are processed.</param>
    /// <param name="preprocessorSymbols">The active preprocessor symbol set; <c>null</c> means the empty set.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope? previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver? references, bool implicitSystemImport, ImmutableHashSet<string>? preprocessorSymbols)
        => BindGlobalScope(previous, syntaxTrees, references, implicitSystemImport, preprocessorSymbols, isLibrary: false);

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, with full
    /// control over implicit-import seeding, the active preprocessor symbol
    /// set, and whether the compilation is a library (ADR-0066 deferred
    /// decision D4 — top-level statements in a library are an error,
    /// matching C#'s CS8805).
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <param name="references">The reference resolver; <c>null</c> selects <see cref="ReferenceResolver.Default"/>.</param>
    /// <param name="implicitSystemImport">When <c>true</c>, an implicit <c>import System</c> is seeded before user imports are processed.</param>
    /// <param name="preprocessorSymbols">The active preprocessor symbol set; <c>null</c> means the empty set.</param>
    /// <param name="isLibrary">When <c>true</c>, the compilation produces a library and top-level statements are reported as <c>GS0285</c> at the first global statement.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope? previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver? references, bool implicitSystemImport, ImmutableHashSet<string>? preprocessorSymbols, bool isLibrary)
        => BindGlobalScope(previous, syntaxTrees, references, implicitSystemImport, preprocessorSymbols, isLibrary, submission: null);

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, with full
    /// control over implicit-import seeding, the active preprocessor symbol
    /// set, whether the compilation is a library, and — ADR-0156 Phase 2 —
    /// optional interactive submission options that bind prior REPL
    /// submissions as metadata-backed imports.
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <param name="references">The reference resolver; <c>null</c> selects <see cref="ReferenceResolver.Default"/>.</param>
    /// <param name="implicitSystemImport">When <c>true</c>, an implicit <c>import System</c> is seeded before user imports are processed.</param>
    /// <param name="preprocessorSymbols">The active preprocessor symbol set; <c>null</c> means the empty set.</param>
    /// <param name="isLibrary">When <c>true</c>, the compilation produces a library and top-level statements are reported as <c>GS0285</c> at the first global statement.</param>
    /// <param name="submission">Interactive submission options, or <c>null</c> for an ordinary compilation.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(
        BoundGlobalScope? previous,
        ImmutableArray<SyntaxTree> syntaxTrees,
        ReferenceResolver? references,
        bool implicitSystemImport,
        ImmutableHashSet<string>? preprocessorSymbols,
        bool isLibrary,
        SubmissionBindingOptions? submission)
    {
        var parentScope = CreateParentScope(previous, references, preprocessorSymbols, preserveLatestImportSyntaxTrees: false, submissionImports: submission?.Imports);
        var binder = new Binder(parentScope, function: null);

        // Issues #4089/#4090: the declaration phase binds type clauses before
        // every same-compilation declaration's type-parameter constraints are
        // resolved, so the G#-declared generic constraint checks are queued
        // here and answered by FlushPendingUserGenericConstraintChecks below.
        binder.scope.SetDeferUserGenericConstraintChecks(true);

        // ADR-0156 Phase 2: replay the session's accumulated imports so an
        // `import` evaluated in an earlier cell keeps its effect in this one
        // (each submission is a fresh compilation with no source chaining).
        // TryImport short-circuits on the first same-name import, so replayed
        // duplicates and the implicit System seed below coexist harmlessly.
        if (submission?.ReplayImports.IsDefaultOrEmpty == false)
        {
            foreach (var replayed in submission.ReplayImports)
            {
                binder.scope.TryImport(new ImportSymbol(replayed.Name, replayed.Target, declaration: null));
            }
        }

        if (implicitSystemImport && previous == null)
        {
            // Seed an implicit `import System` so common BCL types (Console,
            // String, Int32, ...) resolve without an explicit import. The user
            // may still write `import System` redundantly; lookup short-circuits
            // on the first matching import so duplicates are harmless.
            binder.scope.TryImport(new ImportSymbol("System", "System", declaration: null));

            // ADR-0174 D9/D13: the concurrency library namespace is implicitly
            // imported whenever the runtime assembly is in the reference set,
            // so `Chan.Unbounded[T]()`, `ch.Close()` (an extension on a
            // `chan[T]`), and the D9 helpers resolve with no import — the
            // syntax (`go`, `chan[T]`, `<-`, `select`) never needed one.
            if (binder.scope.References.TryResolveType(ChannelRuntimeBinder.ChanTypeName, out _))
            {
                binder.scope.TryImport(new ImportSymbol("Gsharp.Concurrency", "Gsharp.Concurrency", declaration: null, hoistsStatics: true));
            }
        }

        // Resolve each syntax tree's package declaration to a PackageSymbol.
        // Trees without a `package X` declaration fall into the implicit
        // "Default" package; trees that share a textual package name share a
        // PackageSymbol instance. The set of distinct packages, in first-seen
        // order, becomes BoundGlobalScope.Packages.
        var packagesByName = new Dictionary<string, PackageSymbol>(StringComparer.Ordinal);
        var packagesInOrder = ImmutableArray.CreateBuilder<PackageSymbol>();
        var packageByTree = new Dictionary<SyntaxTree, PackageSymbol>();
        var defaultPackageName = submission?.DefaultPackageName ?? "Default";
        foreach (var tree in syntaxTrees)
        {
            var packageSyntax = tree.Root.Members.OfType<PackageSyntax>().FirstOrDefault();
            var packageName = packageSyntax != null
                ? string.Concat(packageSyntax.IdentifiersWithDots.Select(t => t.ValueText))
                : defaultPackageName;
            if (!packagesByName.TryGetValue(packageName, out var packageSymbol))
            {
                packageSymbol = new PackageSymbol(packageName, packageSyntax);
                packagesByName[packageName] = packageSymbol;
                packagesInOrder.Add(packageSymbol);
                AttachDocumentation(packageSymbol, packageSyntax);
            }
            else if (packageSyntax != null)
            {
                packageSymbol.MarkExplicitlyDeclared();
            }

            packageByTree[tree] = packageSymbol;
        }

        foreach (var packageSymbol in packagesInOrder)
        {
            if (packageSymbol.IsExplicitlyDeclared)
            {
                binder.scope.RegisterSourcePackage(packageSymbol.Name);
            }
        }

        // Issue #2342: runs `action` with `pkg`'s name set as the ambient
        // "current declaring package" (see `BoundScope.SetCurrentDeclaringPackage`)
        // so a type-alias lookup started from within `action` prefers that
        // package's own same-simple-name type over an unrelated package's
        // homonym, then restores the previous ambient value. Used to wrap
        // every per-declaration shell/body binding call below.
        //
        // Issue #2456 (per-file import scoping / #2395 follow-up): ALSO runs
        // `action` with `tree` set as the ambient "current referencing syntax
        // tree" (see `BoundScope.SetCurrentReferencingSyntaxTree`), so a
        // same-simple-name collision encountered while binding `tree`'s own
        // declaration is only disambiguated by an import declared in `tree`
        // itself — never a sibling file's import, which issue #2395 already
        // documents as leaking compilation-wide.
        void RunWithPackage(PackageSymbol pkg, SyntaxTree tree, Action action)
        {
            var previousPackage = binder.scope.SetCurrentDeclaringPackage(pkg?.Name);
            var previousTree = binder.scope.SetCurrentReferencingSyntaxTree(tree);
            try
            {
                action();
            }
            finally
            {
                binder.scope.SetCurrentDeclaringPackage(previousPackage);
                binder.scope.SetCurrentReferencingSyntaxTree(previousTree);
            }
        }

        var importDeclarations = syntaxTrees.SelectMany(st => st.Root.Members.AsEnumerable())
                                 .OfType<ImportSyntax>();
        foreach (var import in importDeclarations)
        {
            binder.BindImport(import);
        }

        var typeAliasDeclarations = syntaxTrees.SelectMany(st => st.Root.Members.AsEnumerable())
                                               .OfType<TypeAliasDeclarationSyntax>();
        foreach (var typeAlias in typeAliasDeclarations)
        {
            var owningPackage = packageByTree[typeAlias.SyntaxTree];
            binder.declarations.ValidateTopLevelProtected(typeAlias.AccessibilityModifier);
            RunWithPackage(owningPackage, typeAlias.SyntaxTree, () => binder.declarations.BindTypeAliasDeclaration(typeAlias, owningPackage));
        }

        // Declare named delegate type-name shells before other type bodies so
        // their members can reference delegates. Signatures are bound after all
        // interface/enum/struct shells exist, making delegate constraints,
        // parameters, and returns independent of syntax-tree order.
        var delegateDeclarations = syntaxTrees.SelectMany(st => st.Root.Members.AsEnumerable())
                                              .OfType<DelegateDeclarationSyntax>()
                                              .ToList();
        var declaredDelegates = new List<(DelegateDeclarationSyntax Syntax, DelegateTypeSymbol Symbol)>();
        foreach (var delegateSyntax in delegateDeclarations)
        {
            var owningPackage = packageByTree[delegateSyntax.SyntaxTree];
            binder.declarations.ValidateTopLevelProtected(delegateSyntax.AccessibilityModifier);
            DelegateTypeSymbol? sym = null;
            RunWithPackage(owningPackage, delegateSyntax.SyntaxTree, () => sym = binder.declarations.DeclareDelegateSymbol(delegateSyntax, owningPackage));
            if (sym != null)
            {
                declaredDelegates.Add((delegateSyntax, sym));
            }
        }

        var interfaceDeclarations = PartialTypeMerger.MergeInterfaces(
            syntaxTrees.SelectMany(st => st.Root.Members.AsEnumerable()).OfType<InterfaceDeclarationSyntax>(),
            packageByTree,
            binder.Diagnostics);

        // Phase 3 exit: register interface type aliases up front so structs
        // declared in subsequent passes can implement them, *and* defer the
        // resolution of interface method signatures until after structs have
        // been registered — interface methods may reference user struct/class
        // types as parameter or return types (e.g. `func Find(...) Contact?`).
        var declaredInterfaces = new List<(InterfaceDeclarationSyntax Syntax, InterfaceSymbol Symbol)>();
        foreach (var ifaceSyntax in interfaceDeclarations)
        {
            var owningPackage = packageByTree[ifaceSyntax.SyntaxTree];
            binder.declarations.ValidateTopLevelProtected(ifaceSyntax.AccessibilityModifier);
            InterfaceSymbol? sym = null;
            RunWithPackage(owningPackage, ifaceSyntax.SyntaxTree, () => sym = binder.declarations.DeclareInterfaceSymbol(ifaceSyntax, owningPackage));
            if (sym != null)
            {
                declaredInterfaces.Add((ifaceSyntax, sym));
            }
        }

        var enumDeclarations = syntaxTrees.SelectMany(st => st.Root.Members.AsEnumerable())
                                           .OfType<EnumDeclarationSyntax>();
        foreach (var enumSyntax in enumDeclarations)
        {
            var owningPackage = packageByTree[enumSyntax.SyntaxTree];
            binder.declarations.ValidateTopLevelProtected(enumSyntax.AccessibilityModifier);
            RunWithPackage(owningPackage, enumSyntax.SyntaxTree, () => binder.declarations.BindEnumDeclaration(enumSyntax, owningPackage));
        }

        // Issue #973: declare all struct/class type-name shells first (phase 1),
        // then bind their bodies (phase 2). Splitting declaration from body
        // binding lets a field/parameter/base-clause type forward-reference a
        // user struct or class declared later in the same compilation —
        // e.g. a `class` whose field type is a `struct` declared below it —
        // mirroring the two-phase scheme already used for interfaces above.
        //
        // ADR-0146 / issue #2243: "rich" anonymous-object literals (those
        // carrying a base/interface clause, methods, or events) are desugared
        // here into compiler-synthesized top-level class declarations and fed
        // through the SAME struct/class binding pipeline (shell, body,
        // interface/override verification, method-body binding, emit) as
        // user-named classes — no bespoke binder or emitter code path. The
        // literal site later binds to a parameterless construction of the
        // synthesized class (see ExpressionBinder.BindRichAnonymousClassExpression).
        var anonClassCounter = 0;
        var richAnonymousClasses = new List<(AnonymousClassExpressionSyntax Node, StructDeclarationSyntax Declaration)>();
        foreach (var tree in syntaxTrees)
        {
            CollectRichAnonymousObjectDeclarations(
                tree.Root,
                tree,
                richAnonymousClasses,
                binder.Diagnostics,
                ref anonClassCounter,
                enclosingTypeParameters: ImmutableArray<TypeParameterListSyntax>.Empty);
        }

        var structDeclarations = PartialTypeMerger.MergeStructs(
            syntaxTrees.SelectMany(st => st.Root.Members.AsEnumerable()).OfType<StructDeclarationSyntax>(),
            packageByTree,
            binder.Diagnostics)
            .Concat(richAnonymousClasses.Select(r => r.Declaration))
            .ToList();
        var declaredStructs = new List<(StructDeclarationSyntax Syntax, StructSymbol Symbol)>();
        var syntheticDeclToSymbol = new Dictionary<StructDeclarationSyntax, StructSymbol>();
        foreach (var structSyntax in structDeclarations)
        {
            var owningPackage = packageByTree[structSyntax.SyntaxTree];
            binder.declarations.ValidateTopLevelProtected(structSyntax.AccessibilityModifier);
            StructSymbol? structSymbol = null;
            RunWithPackage(owningPackage, structSyntax.SyntaxTree, () =>
            {
                structSymbol = binder.declarations.DeclareStructShell(structSyntax, owningPackage);
                if (structSymbol != null)
                {
                    // Issue #1069: declare the type-name shells of any nested types
                    // (recursively) right after the enclosing shell, so a sibling
                    // member signature can forward-reference a nested type by name.
                    // The bodies are bound later in phase 2 (BindNestedTypeBodies).
                    binder.declarations.DeclareNestedTypeShells(structSyntax, structSymbol, owningPackage);
                }
            });
            if (structSymbol != null)
            {
                declaredStructs.Add((structSyntax, structSymbol));
                syntheticDeclToSymbol[structSyntax] = structSymbol;
            }
        }

        foreach (var (delegateSyntax, delegateSymbol) in declaredDelegates)
        {
            var owningPackage = packageByTree[delegateSyntax.SyntaxTree];
            RunWithPackage(owningPackage, delegateSyntax.SyntaxTree, () => binder.declarations.BindDelegateDeclarationBody(delegateSyntax, delegateSymbol));
        }

        // ADR-0146 / issue #2243: publish the rich anonymous-object literal →
        // synthesized-class map so the literal-site binder can construct the
        // right synthesized class. Keyed by the literal's syntax-node identity.
        var richAnonymousMap = binder.scope.GetRichAnonymousClassMap();
        foreach (var (node, decl) in richAnonymousClasses)
        {
            if (syntheticDeclToSymbol.TryGetValue(decl, out var sym))
            {
                richAnonymousMap[node] = sym;
            }
        }

        // Issue #2489: shells make base types resolvable up front, but override
        // validation also needs the base type's members. Bind same-compilation
        // base classes before their derived classes, independent of tree/source
        // order.
        var declarationsByName = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        for (var i = 0; i < declaredStructs.Count; i++)
        {
            var name = declaredStructs[i].Symbol.Name;
            if (!declarationsByName.TryGetValue(name, out var indices))
            {
                indices = new List<int>();
                declarationsByName.Add(name, indices);
            }

            indices.Add(i);
        }

        var bindingState = new byte[declaredStructs.Count];
        var bindingOrder = new List<int>(declaredStructs.Count);

        int FindTopLevelBaseIndex(
            StructDeclarationSyntax syntax,
            string packageName,
            HashSet<string>? visibleNestedTypeNames = null)
        {
            if (!syntax.IsClass)
            {
                return -1;
            }

            TypeClauseSyntax? baseType = syntax.BaseTypeClauses.Count > 0
                ? syntax.BaseTypeClauses[0]
                : syntax.BaseTypeIdentifier == null
                    ? null
                    : new TypeClauseSyntax(syntax.BaseTypeIdentifier.SyntaxTree, syntax.BaseTypeIdentifier);
            var baseName = baseType?.QualifierIdentifierTokens.LastOrDefault()?.Text
                ?? baseType?.Identifier?.Text;
            if (baseName == null
                || (baseType is { HasQualifier: false }
                    && visibleNestedTypeNames?.Contains(baseName) == true)
                || !declarationsByName.TryGetValue(baseName, out var candidates))
            {
                return -1;
            }

            var nonNullBaseType = Invariant.Required(
                baseType,
                "baseName is non-null only when baseType is non-null");
            var requestedPackage = nonNullBaseType.HasQualifier
                ? nonNullBaseType.DottedName[..^(baseName.Length + 1)]
                : packageName;
            var matchingPackage = new List<int>();
            var classCandidateCount = 0;
            var soleClassCandidate = -1;
            foreach (var candidate in candidates)
            {
                if (!declaredStructs[candidate].Symbol.IsClass)
                {
                    continue;
                }

                classCandidateCount++;
                soleClassCandidate = candidate;
                if (declaredStructs[candidate].Symbol.PackageName == requestedPackage)
                {
                    matchingPackage.Add(candidate);
                }
            }

            return matchingPackage.Count == 1
                ? matchingPackage[0]
                : classCandidateCount == 1
                    ? soleClassCandidate
                    : -1;
        }

        void AddNestedBaseDependencies(
            StructDeclarationSyntax container,
            string packageName,
            HashSet<string> inheritedNestedTypeNames)
        {
            var visibleNestedTypeNames = new HashSet<string>(
                inheritedNestedTypeNames,
                StringComparer.Ordinal);
            foreach (var nested in container.NestedTypes.OfType<StructDeclarationSyntax>())
            {
                visibleNestedTypeNames.Add(nested.Identifier.ValueText);
            }

            foreach (var nested in container.NestedTypes.OfType<StructDeclarationSyntax>())
            {
                var baseIndex = FindTopLevelBaseIndex(
                    nested,
                    packageName,
                    visibleNestedTypeNames);
                if (baseIndex >= 0)
                {
                    AddBaseFirst(baseIndex);
                }

                AddNestedBaseDependencies(nested, packageName, visibleNestedTypeNames);
            }
        }

        void AddBaseFirst(int index)
        {
            if (bindingState[index] == 2)
            {
                return;
            }

            if (bindingState[index] == 1)
            {
                return;
            }

            bindingState[index] = 1;
            var (syntax, symbol) = declaredStructs[index];
            var baseIndex = FindTopLevelBaseIndex(syntax, symbol.PackageName);
            if (baseIndex >= 0)
            {
                AddBaseFirst(baseIndex);
            }

            // Issue #3413: nested type bodies are bound recursively while their
            // owning top-level type is bound. Order any top-level source bases
            // used by those nested declarations first too, so override
            // validation sees the base members regardless of file order.
            AddNestedBaseDependencies(
                syntax,
                symbol.PackageName,
                new HashSet<string>(StringComparer.Ordinal));

            bindingState[index] = 2;
            bindingOrder.Add(index);
        }

        for (var i = 0; i < declaredStructs.Count; i++)
        {
            AddBaseFirst(i);
        }

        foreach (var index in bindingOrder)
        {
            var (structSyntax, structSymbol) = declaredStructs[index];
            var owningPackage = packageByTree[structSyntax.SyntaxTree];
            RunWithPackage(owningPackage, structSyntax.SyntaxTree, () => binder.declarations.BindStructDeclarationBody(structSyntax, owningPackage, structSymbol));
        }

        binder.declarations.ReportExplicitLayoutReferenceOverlaps(
            declaredStructs.Select(declaration => declaration.Symbol));

        // Issue #1085 / #1194: base-constructor-initializer and field-initializer
        // argument binding is deferred until AFTER all top-level functions are
        // declared (below), so those expressions can resolve unqualified
        // free-function and sibling static-member calls in addition to other
        // user types' constructors. The actual binding runs after the function
        // declaration loop.

        // Issue #973: now that every class shell has had its base clause bound
        // and its base class installed, screen the resolved base relation for
        // transitive inheritance cycles (e.g. `class B : C` / `class C : B`).
        // The two-phase split declares all type-name shells before any base
        // clause is bound — which is what makes legitimate forward references
        // work — so such cycles can no longer be rejected by declaration order
        // and must be detected explicitly here.
        binder.declarations.DetectClassInheritanceCycles(
            declaredStructs.Where(d => d.Symbol.IsClass).Select(d => d.Symbol));

        // Issue #4183 (Copilot finding on PR #4192): drain default-parameter-
        // value expressions HERE, before interfaces and top-level functions
        // bind their own members below, rather than after (as originally
        // landed). Every struct's static-member surface already exists at
        // this point (that is what let #4183 defer past the per-struct
        // declaration-body pass at all), so moving the drain earlier loses
        // nothing a class default value could legitimately reach — a default
        // value was never able to call a not-yet-declared top-level function
        // either before or after #4183, since eager binding originally ran
        // during the per-struct pass, well before any top-level function
        // exists. What the LATER drain position broke: BindInterfaceMembers
        // and BindFunctionDeclaration below still bind their OWN parameters'
        // default values eagerly (inline), and an eager default expression
        // that resolves a call against a class method/constructor (e.g.
        // `C.F()` where `F(x int32 = 1)`) reads
        // ParameterSymbol.HasExplicitDefaultValue during overload resolution.
        // Draining after those loops left that flag false for every
        // not-yet-drained class parameter, so such a call was wrongly
        // rejected instead of reaching the intended diagnostic.
        binder.declarations.BindPendingParameterDefaultValues();

        foreach (var (ifaceSyntax, ifaceSymbol) in declaredInterfaces)
        {
            var owningPackage = packageByTree[ifaceSyntax.SyntaxTree];
            RunWithPackage(owningPackage, ifaceSyntax.SyntaxTree, () => binder.declarations.BindInterfaceMembers(ifaceSyntax, ifaceSymbol, owningPackage));
        }

        var functionDeclarations = syntaxTrees.SelectMany(st => st.Root.Members.AsEnumerable())
                                              .OfType<FunctionDeclarationSyntax>();
        foreach (var function in functionDeclarations)
        {
            var owningPackage = packageByTree[function.SyntaxTree];
            binder.declarations.ValidateTopLevelProtected(function.AccessibilityModifier);
            RunWithPackage(owningPackage, function.SyntaxTree, () => binder.declarations.BindFunctionDeclaration(function, owningPackage));
        }

        // Issue #1085 / #1194: now that every type body is bound (explicit
        // constructors populated) AND every top-level function is declared,
        // bind the deferred base-constructor-initializer (`: base(...)`) and
        // field-initializer expressions. Deferring past function declaration
        // lets these expressions resolve unqualified free-function and sibling
        // static-member calls, matching the visibility a constructor body has.
        // (Parameter default values already drained above, before this
        // point — see the #4183/#4192 comment above DetectClassInheritanceCycles.)
        binder.declarations.BindPendingBaseInitializers();
        binder.declarations.BindPendingFieldInitializers();

        binder.declarations.ExpandStructInterfaceClosures();

        // Issues #4089/#4090: every same-compilation declaration's
        // type-parameter constraints are now resolved (class bodies, then
        // interface members) and every class's implemented-interface closure is
        // populated, so the G#-declared generic type-clause constraint checks
        // recorded during the declaration phase can finally be answered. Asking
        // them at their construction sites made the answer a function of source
        // order — see CheckUserGenericTypeClauseConstraints. Constructions bound
        // after this point (method bodies, later submissions) are answered in
        // place.
        FlushPendingUserGenericConstraintChecks(binder.scope);

        // ADR-0149: bind every explicit-interface qualifier clause
        // (`func (IFoo) M(...)` / `prop (IFoo) P T`) to its target interface
        // before VerifyInterfaceImplementations resolves them against each
        // interface's own abstract members.
        binder.declarations.ResolveExplicitInterfaceClauses();

        binder.declarations.VerifyInterfaceImplementations();

        // Issue #987: verify the abstract-member contract — a concrete class
        // must override every inherited abstract method.
        binder.declarations.VerifyAbstractMethodImplementations();

        // ADR-0066 §2 (deferred decision D7): sort the contributing syntax
        // trees by source path before concatenating top-level statements
        // across files, so cross-file TLS ordering is identical regardless
        // of how the build tool populates @(Compile) or how a test
        // permutes the input order. Trees without a file path (in-memory
        // SyntaxTree.Parse calls) sort stably among themselves by
        // SelectMany's iteration order.
        var globalStatements = syntaxTrees
            .OrderBy(st => st.Text?.FileName ?? string.Empty, StringComparer.Ordinal)
            .SelectMany(st => st.Root.Members.AsEnumerable())
            .OfType<GlobalStatementSyntax>()
            .ToArray();

        // ADR-0066 deferred decision D4 (mirrors C# CS8805): top-level
        // statements are not allowed in a library compilation. Report once
        // at the first global statement and continue binding so the rest of
        // the flow (synthesized <Main>$, etc.) still runs — the diagnostic
        // makes the compilation fail, but downstream consumers see a
        // complete bound tree.
        if (globalStatements.Length > 0 && isLibrary)
        {
            binder.Diagnostics.ReportTopLevelStatementsInLibrary(globalStatements[0].Location);
        }

        // ADR-0066 D1: when top-level statements exist, synthesize the
        // entry-point FunctionSymbol BEFORE binding the statements so the
        // statements can be bound through a function-scoped Binder. That
        // binder declares the implicit `args string[]` parameter and exposes
        // a non-null `function` for downstream return-type checks (D2/D3
        // build on this).
        FunctionSymbol? synthesizedEntryPoint = null;
        PackageSymbol? synthesizedEntryPointPackage = null;
        if (globalStatements.Length > 0)
        {
            synthesizedEntryPointPackage = packageByTree[globalStatements[0].SyntaxTree];

            // D1: every TLS-synthesized `<Main>$` carries an implicit
            // `args string[]` parameter so user code may reference `args`
            // and the emitted CLR signature matches the standard
            // `static T Main(string[])` shape that the .NET runtime hosts.
            var argsType = SliceTypeSymbol.Get(TypeSymbol.String);
            var argsParameter = new ParameterSymbol("args", argsType);
            var entryPointParameters = ImmutableArray.Create(argsParameter);

            // ADR-0066 D2/D3: pre-scan TLS for `return` shapes (bare vs
            // value-returning) so the synthesized entry point's return type
            // is inferred BEFORE binding. Any value-returning return → `int`;
            // any mix → GS0287 at the first offending site, with the first
            // shape seen winning recovery. D3: also detect any `await` so
            // the entry point is flagged async (its kickoff signature is
            // wrapped to Task / Task<int> by the async lowerer).
            var entryPointReturnType = InferTopLevelEntryPointReturnType(
                globalStatements,
                binder.Diagnostics,
                out var awaitFound);

            synthesizedEntryPoint = new FunctionSymbol(
                name: "<Main>$",
                parameters: entryPointParameters,
                type: entryPointReturnType,
                declaration: null,
                package: synthesizedEntryPointPackage);
            synthesizedEntryPoint.IsTopLevelEntryPoint = true;
            if (awaitFound)
            {
                // ADR-0066 D3: any TLS `await` makes the synthesized
                // entry point async. The state-machine lowering pass
                // (ADR-0023) already keys off `FunctionSymbol.IsAsync`,
                // and the emitter wraps the kickoff method's return type
                // through `AsyncStateMachineTypeBuilder.ResolveAsyncReturnClrType`
                // (Void → Task, T → Task<T>). The raw `Type` stays Void/Int32.
                synthesizedEntryPoint.IsAsync = true;
            }
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        if (synthesizedEntryPoint != null)
        {
            // Bind TLS through a function-scoped Binder. Its RootScope's
            // parent is `binder.scope`, so all globally-declared imports /
            // types / functions remain visible while the new binder's own
            // RootScope owns the `args` parameter declaration.
            var tlsBinder = new Binder(binder.scope, synthesizedEntryPoint);
            string? previousPackage = null;
            SyntaxTree? previousTree = null;
            var contextSet = false;
            try
            {
                var topLevelStatements = ImmutableArray.CreateBuilder<StatementSyntax>(globalStatements.Length);
                foreach (var globalStatement in globalStatements)
                {
                    topLevelStatements.Add(globalStatement.Statement);
                }

                var topLevelStatementsBuilt = topLevelStatements.MoveToImmutable();

                // Issue #4285: all TLS global statements share one goto/label
                // namespace (see the FinalizeUserLabels call below), so the
                // narrowing-lift guard must see whether ANY of them contains
                // a goto/label, not just the one currently being bound.
                tlsBinder.binderCtx.FunctionContainsUserGotoOrLabel =
                    topLevelStatementsBuilt.Any(statement => StatementBinder.ContainsUserGotoOrLabel(statement));

                statements.AddRange(tlsBinder.statements.BindStatementList(
                    topLevelStatementsBuilt,
                    statement =>
                    {
                        var tree = statement.SyntaxTree;
                        if (!contextSet)
                        {
                            previousPackage = binder.scope.SetCurrentDeclaringPackage(packageByTree[tree]?.Name);
                            previousTree = binder.scope.SetCurrentReferencingSyntaxTree(tree);
                            contextSet = true;
                        }
                        else
                        {
                            binder.scope.SetCurrentDeclaringPackage(packageByTree[tree]?.Name);
                            binder.scope.SetCurrentReferencingSyntaxTree(tree);
                        }

                        return;
                    }));
            }
            finally
            {
                if (contextSet)
                {
                    binder.scope.SetCurrentDeclaringPackage(previousPackage);
                    binder.scope.SetCurrentReferencingSyntaxTree(previousTree);
                }
            }

            // Issue #1884: all TLS global statements share the synthesized
            // entry point's label namespace, so undefined `goto` targets are
            // only checked once every global statement has been bound.
            tlsBinder.statements.FinalizeUserLabels();

            // Forward the per-function binder's diagnostics back into the
            // global diagnostic bag so callers see them on
            // BoundGlobalScope.Diagnostics.
            binder.Diagnostics.AddRange(tlsBinder.Diagnostics);

            // ADR-0066 D1: variables declared at the top of TLS are
            // GlobalVariableSymbols (see BindVariableDeclaration's
            // IsTopLevelEntryPoint fallback), but they were declared on the
            // per-function tlsBinder root scope. Republish them onto the
            // global binder scope so BoundGlobalScope.Variables sees them
            // (the emitter and evaluator both consume globals from there).
            foreach (var v in tlsBinder.scope.GetDeclaredVariables())
            {
                if (v is GlobalVariableSymbol)
                {
                    binder.scope.TryDeclareVariable(v);
                }
            }

            // ADR-0156 Phase 2: capture the submission's trailing value into
            // the synthesized `<Result>$` global so the REPL echoes it. The
            // evaluator's historical echo is its `LastValue` after the block;
            // the two statically-capturable shapes are a trailing expression
            // statement (its value) and a trailing variable declaration (its
            // initialized value). ByRefLike values cannot live in a static
            // field and are skipped (no echo), as are `void`/error results.
            if (submission?.CaptureTrailingExpression == true && statements.Count > 0)
            {
                GlobalVariableSymbol? resultVariable = null;
                var trailing = statements[statements.Count - 1];
                if (trailing is BoundExpressionStatement trailingExpression
                    && IsCapturableEchoType(trailingExpression.Expression.Type))
                {
                    resultVariable = new GlobalVariableSymbol(
                        SubmissionImports.ResultFieldName,
                        isReadOnly: false,
                        trailingExpression.Expression.Type,
                        Accessibility.Public);
                    statements[statements.Count - 1] = new BoundVariableDeclaration(
                        trailing.Syntax, resultVariable, trailingExpression.Expression);
                }
                else if (trailing is BoundVariableDeclaration trailingDeclaration
                    && trailingDeclaration.Initializer is not BoundAddressOfExpression
                    && IsCapturableEchoType(trailingDeclaration.Variable.Type))
                {
                    resultVariable = new GlobalVariableSymbol(
                        SubmissionImports.ResultFieldName,
                        isReadOnly: false,
                        trailingDeclaration.Variable.Type,
                        Accessibility.Public);
                    statements.Add(new BoundVariableDeclaration(
                        trailing.Syntax,
                        resultVariable,
                        new BoundVariableExpression(trailing.Syntax, trailingDeclaration.Variable)));
                }
                else if (TryInferTrailingCaptureType(trailing, out var trailingBranchType))
                {
                    // Issue #3227: the trailing statement is a value-producing
                    // branching form — a trailing `if`/`if let` statement whose
                    // arms all end in a value, a bare block, or an exhaustive
                    // switch statement. The evaluator's LastValue echoed the
                    // taken arm's tail value; capture statically by rewriting
                    // every tail into an assignment of the synthesized
                    // `<Result>$` global (the static field exists purely by
                    // virtue of the GlobalVariableSymbol declaration — every
                    // arm assigns it, so no separate initializer is needed).
                    resultVariable = new GlobalVariableSymbol(
                        SubmissionImports.ResultFieldName,
                        isReadOnly: false,
                        trailingBranchType,
                        Accessibility.Public);
                    statements[statements.Count - 1] = RewriteTrailingCapture(trailing, resultVariable);
                }

                if (resultVariable != null)
                {
                    binder.scope.TryDeclareVariable(resultVariable);
                }
            }
        }

        var imports = binder.scope.GetOwnDeclaredImports();
        var functions = binder.scope.GetDeclaredFunctions();
        var extensionFunctions = binder.scope.GetDeclaredExtensionFunctions();
        if (!extensionFunctions.IsDefaultOrEmpty)
        {
            functions = functions.AddRange(extensionFunctions);
        }

        var variables = binder.scope.GetDeclaredVariables();
        var typeAliases = binder.scope.GetDeclaredTypeAliases();
        var structs = binder.scope.GetDeclaredStructs();
        var interfaces = binder.scope.GetDeclaredInterfaces();
        var enums = binder.scope.GetDeclaredEnums();

        // Entry-point package: the package owning the top-level statements
        // (if any) or the package owning explicit Main (if any) or, lacking
        // both, the first declared package. This becomes Package — the
        // legacy single-package accessor — and the namespace that owns the
        // synthesized <Main>$ in emit.
        var entryPointPackage = synthesizedEntryPointPackage
            ?? ResolveEntryPointPackage(packageByTree, globalStatements, functions, packagesInOrder);

        // Issue #3883: a library has no entry point to resolve. Scanning for a
        // user-declared static `Main` under /target:library used to pick one
        // anyway, and the emitter then applied the CLR entry-point signature
        // rewrite to it — erasing `Task<T>` from an `async func Main` in a DLL
        // that can never be started as a process.
        //
        // TLS in a library is a different case and keeps its existing shape:
        // ADR-0066 D4 reports GS0285 and then CONTINUES, so the synthesized
        // `<Main>$` is still produced and downstream consumers see a complete
        // bound tree (BinderEntryPointTests pins this).
        var entryPoint = isLibrary && globalStatements.Length == 0
            ? null
            : ResolveEntryPoint(binder, functions, structs, globalStatements, syntaxTrees, entryPointPackage, synthesizedEntryPoint);

        // ADR-0156 Phase 3c (#3176): an interactive submission never runs a
        // user-declared entry point — `func Main()` in a cell is an ordinary
        // function declaration (the evaluator engine's RunEntryPoint=false
        // contract, preserved under emitted execution). Only the synthesized
        // top-level-statements <Main>$ is invokable, so a declaration-only
        // submission emits no entry point at all. One-shot script-shaped
        // submissions (the emitted test oracle) opt back in via
        // SubmissionBindingOptions.RunUserEntryPoint.
        if (submission is { RunUserEntryPoint: false })
        {
            entryPoint = synthesizedEntryPoint;
        }

        // Issue #2237/#2815: bind every file-level annotation EXCEPT
        // InternalsVisibleTo (which keeps its own early, syntactic
        // fast path below via FriendAssemblyDeclarations.Collect) through
        // the SAME general attribute binder used for every other
        // declaration position, so any attribute type the compiler can
        // resolve (AssemblyVersionAttribute, AssemblyMetadataAttribute, a
        // same-compilation user attribute, ...) becomes a real
        // assembly-level CustomAttribute row — full parity with C#'s
        // `[assembly: ...]`. Must run before the diagnostics snapshot below
        // so any reported diagnostics (e.g. "attribute type not found") are
        // captured.
        var otherFileAnnotations = FriendAssemblyDeclarations.CollectOtherAnnotations(syntaxTrees);
        var boundFileAttributes = binder.declarations.BindAttributes(
            otherFileAnnotations,
            AttributeTargetKind.Assembly,
            FileDeclarationAllowedTargets,
            "file-level declaration",
            System.AttributeTargets.Assembly);
        var boundAssemblyAttributes = boundFileAttributes
            .Where(attribute => attribute.Target == AttributeTargetKind.Assembly)
            .ToImmutableArray();
        var boundModuleAttributes = boundFileAttributes
            .Where(attribute => attribute.Target == AttributeTargetKind.Module)
            .ToImmutableArray();

        // Issue #4065: top-level statements do not pass through
        // AnalyzeFunctionBody, so reject any unresolved method group retained
        // by inference/conditional binding before the global diagnostic
        // snapshot is taken.
        MethodGroupDiagnostics.ReportUnresolved(
            new BoundBlockStatement(null, statements.ToImmutable()),
            binder.Diagnostics);
        var diagnostics = binder.Diagnostics.ToImmutableArray();

        if (previous != null)
        {
            diagnostics = diagnostics.InsertRange(0, previous.Diagnostics);
        }

        // Issue #3501 A2: synthesized ref-kind delegates (see
        // SynthesizedRefDelegateCache) join the declared named delegates so
        // the emitter stamps their TypeDefs through the same ADR-0059 path.
        var delegates = binder.scope.GetDeclaredDelegates()
            .AddRange(binder.scope.GetSynthesizedRefDelegateCache().Symbols);

        var result = new BoundGlobalScope(previous, entryPointPackage, packagesInOrder.ToImmutable(), diagnostics, imports, functions, variables, typeAliases, structs, interfaces, enums, delegates, entryPoint, statements.ToImmutable());
        result.PreprocessorSymbols = preprocessorSymbols ?? ImmutableHashSet<string>.Empty;
        result.AssemblyAttributes = previous == null
            ? boundAssemblyAttributes
            : previous.AssemblyAttributes.AddRange(boundAssemblyAttributes);
        result.ModuleAttributes = previous == null
            ? boundModuleAttributes
            : previous.ModuleAttributes.AddRange(boundModuleAttributes);

        // Issue #2224: anonymous-class literals (`object { let ... }`) bound
        // anywhere during this pass — top-level statements included —
        // synthesize their backing StructSymbol into binder.scope's shared
        // AnonymousTypeCache (see BoundScope.GetAnonymousTypeCache). Snapshot
        // it here so BindProgram can union it into BoundProgram.Structs even
        // though function/method bodies (bound later, in BindProgram) use a
        // freshly-derived scope chain with its own cache instance.
        result.AnonymousTypes = binder.scope.GetAnonymousTypeCache().Symbols.ToImmutableArray();

        // ADR-0146 / issue #2243: snapshot the rich anonymous-object literal →
        // synthesized-class map so BindProgram (which binds function/method
        // bodies against a freshly-derived scope chain) can rehydrate it and
        // bind literals appearing inside those bodies.
        result.RichAnonymousClassMap = binder.scope.GetRichAnonymousClassMap();
        result.RichAnonymousObjectPlans = binder.scope.GetRichAnonymousObjectPlans();
        result.StructuralAdapters = binder.scope.GetStructuralAdapterRegistry();

        // Issue #3501 A2: carry the ref-kind delegate cache itself (not just
        // a snapshot) so BindProgram can install it on its freshly-derived
        // scope chain — a type clause bound in this pass and a literal bound
        // in a method body must unify to the SAME synthesized delegate.
        result.RefDelegateCache = binder.scope.GetSynthesizedRefDelegateCache();

        // Issue #1929/#1953: collect producer-declared friend assemblies
        // (`@assembly:InternalsVisibleTo("...")`) so the emitter can write
        // real InternalsVisibleToAttribute rows. Diagnostics for malformed
        // declarations report through binder.Diagnostics above, but that bag
        // was already snapshotted into `diagnostics`, so append here too.
        var friendDiagnostics = new DiagnosticBag();
        var friendAssemblies = FriendAssemblyDeclarations.Collect(syntaxTrees, friendDiagnostics);
        if (previous == null)
        {
            result.FriendAssemblies = friendAssemblies;
        }
        else
        {
            var combinedFriends = ImmutableArray.CreateBuilder<string>(
                previous.FriendAssemblies.Length + friendAssemblies.Length);
            combinedFriends.AddRange(previous.FriendAssemblies);
            foreach (var friendAssembly in friendAssemblies)
            {
                if (!previous.FriendAssemblies.Contains(friendAssembly))
                {
                    combinedFriends.Add(friendAssembly);
                }
            }

            result.FriendAssemblies = combinedFriends.ToImmutable();
        }

        if (friendDiagnostics.Any())
        {
            result = new BoundGlobalScope(previous, entryPointPackage, packagesInOrder.ToImmutable(), diagnostics.AddRange(friendDiagnostics), imports, functions, variables, typeAliases, structs, interfaces, enums, delegates, entryPoint, statements.ToImmutable())
            {
                PreprocessorSymbols = result.PreprocessorSymbols,
                FriendAssemblies = result.FriendAssemblies,
                AssemblyAttributes = result.AssemblyAttributes,
                ModuleAttributes = result.ModuleAttributes,
                AnonymousTypes = result.AnonymousTypes,
                RichAnonymousClassMap = result.RichAnonymousClassMap,
                RichAnonymousObjectPlans = result.RichAnonymousObjectPlans,
                StructuralAdapters = result.StructuralAdapters,
                RefDelegateCache = result.RefDelegateCache,
            };
        }

        // ADR-0156 Phase 2: carry the submission import set on the scope so
        // BindProgram's freshly-derived scope chain (CreateParentScope) can
        // rehydrate prior-submission metadata lookup for member bodies.
        result.SubmissionImports = submission?.Imports;

        return result;
    }

    // ADR-0156 Phase 2: whether a submission's trailing value can be stored
    // in the synthesized `<Result>$` static field for the REPL echo.
    private static bool IsCapturableEchoType(TypeSymbol type)
        => type != null
            && type != TypeSymbol.Void
            && type != TypeSymbol.Error
            && !TypeSymbol.IsByRefLike(type);

    /// <summary>
    /// Issue #3227: determines whether a trailing branching statement — a
    /// value-producing <c>if</c>/<c>if let</c> statement, a bare block, or an
    /// exhaustive <c>switch</c> statement — has a statically capturable tail
    /// value on every path, mirroring the shapes for which the retired
    /// evaluator's LastValue produced the taken arm's tail value. Succeeds
    /// only when every leaf tail is an expression statement (or variable
    /// declaration) of one identical, capturable type: an <c>if</c> without
    /// an <c>else</c>, an empty block, mixed arm types, or a non-value tail
    /// on any path all decline the capture (no echo), exactly like the
    /// historical single-statement shapes declined non-capturable values.
    /// </summary>
    private static bool TryInferTrailingCaptureType(BoundStatement statement, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out TypeSymbol? type)
    {
        switch (statement)
        {
            case BoundExpressionStatement expressionStatement:
                type = expressionStatement.Expression.Type;
                return IsCapturableEchoType(type);

            case BoundVariableDeclaration declaration
                when declaration.Initializer is not BoundAddressOfExpression:
                type = declaration.Variable.Type;
                return IsCapturableEchoType(type);

            case BoundBlockStatement block when block.Statements.Length > 0:
                return TryInferTrailingCaptureType(block.Statements[block.Statements.Length - 1], out type);

            case BoundIfStatement ifStatement when ifStatement.ElseStatement != null:
                if (TryInferTrailingCaptureType(ifStatement.ThenStatement, out var thenType)
                    && TryInferTrailingCaptureType(ifStatement.ElseStatement, out var elseType)
                    && thenType == elseType)
                {
                    type = thenType;
                    return true;
                }

                type = null;
                return false;

            case BoundPatternSwitchStatement switchStatement
                when switchStatement.Arms.Length > 0
                    && (switchStatement.IsExhaustive || switchStatement.Arms.Any(a => a.IsDefault && a.Guard == null)):
                TypeSymbol? common = null;
                foreach (var arm in switchStatement.Arms)
                {
                    if (!TryInferTrailingCaptureType(arm.Body, out var armType)
                        || (common != null && armType != common))
                    {
                        type = null;
                        return false;
                    }

                    common = armType;
                }

                type = common;
                return type != null;

            default:
                type = null;
                return false;
        }
    }

    /// <summary>
    /// Issue #3227: rewrites the tails accepted by
    /// <see cref="TryInferTrailingCaptureType"/> so every leaf tail stores
    /// its value into the synthesized <c>&lt;Result&gt;$</c> global. Leaf
    /// expression statements become assignments to the global; leaf variable
    /// declarations keep the declaration and append the echo assignment
    /// (matching the historical trailing-declaration echo).
    /// </summary>
    private static BoundStatement RewriteTrailingCapture(BoundStatement statement, GlobalVariableSymbol resultVariable)
    {
        switch (statement)
        {
            case BoundExpressionStatement expressionStatement:
                return new BoundExpressionStatement(
                    statement.Syntax,
                    new BoundAssignmentExpression(statement.Syntax, resultVariable, expressionStatement.Expression));

            case BoundVariableDeclaration declaration:
                return new BoundBlockStatement(
                    statement.Syntax,
                    ImmutableArray.Create<BoundStatement>(
                        declaration,
                        new BoundExpressionStatement(
                            statement.Syntax,
                            new BoundAssignmentExpression(
                                statement.Syntax,
                                resultVariable,
                                new BoundVariableExpression(statement.Syntax, declaration.Variable)))));

            case BoundBlockStatement block:
                return new BoundBlockStatement(
                    block.Syntax,
                    block.Statements.SetItem(
                        block.Statements.Length - 1,
                        RewriteTrailingCapture(block.Statements[block.Statements.Length - 1], resultVariable)));

            case BoundIfStatement ifStatement:
                // TryInferTrailingCaptureType only succeeds for a trailing
                // BoundIfStatement when ElseStatement is non-null (see its
                // `when ifStatement.ElseStatement != null` case guard), and
                // this method only runs on a statement that already passed
                // that check.
                var ifElseStatement = Invariant.Required(ifStatement.ElseStatement, "TryInferTrailingCaptureType verified this if-statement has an else branch");
                return new BoundIfStatement(
                    ifStatement.Syntax,
                    ifStatement.Condition,
                    RewriteTrailingCapture(ifStatement.ThenStatement, resultVariable),
                    RewriteTrailingCapture(ifElseStatement, resultVariable));

            case BoundPatternSwitchStatement switchStatement:
                return new BoundPatternSwitchStatement(
                    switchStatement.Syntax,
                    switchStatement.Discriminant,
                    switchStatement.Arms.Select(a => new BoundPatternSwitchArm(
                        a.Syntax,
                        a.Pattern,
                        a.Guard,
                        RewriteTrailingCapture(a.Body, resultVariable))).ToImmutableArray(),
                    switchStatement.IsExhaustive);

            default:
                throw new InvalidOperationException(
                    $"Unexpected trailing-capture statement kind '{statement.Kind}'.");
        }
    }

    /// <summary>
    /// Produces a bound program from the specified global scope.
    /// </summary>
    /// <param name="globalScope">The global scope.</param>
    /// <param name="references">
    /// The reference resolver used to resolve imported CLR types inside function and
    /// method bodies. When omitted, function-body scopes fall back to
    /// <see cref="ReferenceResolver.Default"/>, which only carries core/System
    /// assemblies — causing imports of non-System namespaces (e.g. types from
    /// referenced libraries or third-party packages) to fail inside bodies.
    /// </param>
    /// <returns>A bound program.</returns>
    public static BoundProgram BindProgram(BoundGlobalScope globalScope, ReferenceResolver? references = null)
    {
        return BindProgram(globalScope, references, cache: null);
    }

    /// <summary>
    /// Produces a bound program from the specified global scope, optionally
    /// reusing previously bound member bodies from <paramref name="cache"/>
    /// (ADR-0105 Phase 1).
    /// </summary>
    /// <param name="globalScope">The global scope.</param>
    /// <param name="references">
    /// The reference resolver used to resolve imported CLR types inside function
    /// and method bodies. See the parameterless overload for details.
    /// </param>
    /// <param name="cache">
    /// An optional per-project bound-body cache. When supplied, each member body
    /// is looked up before binding; a <em>sound</em> hit (see
    /// <see cref="BoundBodyCache"/> for the soundness gate) reuses the cached
    /// lowered body and diagnostics verbatim, while a miss binds and lowers from
    /// scratch and stores the result. When <see langword="null"/>, this method
    /// behaves exactly like the full-rebuild path. The cache never changes the
    /// emitted IL or the diagnostics relative to a from-scratch bind.
    /// </param>
    /// <returns>A bound program.</returns>
    public static BoundProgram BindProgram(BoundGlobalScope globalScope, ReferenceResolver? references, BoundBodyCache? cache)
        => BindProgram(globalScope, references, cache, dirtyTrees: null);

    /// <summary>
    /// Produces a bound program, optionally reusing previously bound member
    /// bodies from <paramref name="cache"/> and, for ADR-0105 Phase 2 delta
    /// binding, <em>forcing a fresh re-bind</em> of every member whose body
    /// syntax belongs to a tree in <paramref name="dirtyTrees"/>.
    /// </summary>
    /// <param name="globalScope">The global scope.</param>
    /// <param name="references">The reference resolver (see other overloads).</param>
    /// <param name="cache">The optional per-project bound-body cache.</param>
    /// <param name="dirtyTrees">
    /// ADR-0105 Phase 2: the set of freshly-parsed syntax trees whose member
    /// bodies must be re-bound from scratch (and re-stored) rather than served
    /// from <paramref name="cache"/>. This is how the language server's
    /// incremental path re-binds <em>only</em> the edited file's bodies while
    /// the symbol instances are reused: members in an unedited file hit the
    /// cache by symbol identity, members in the edited (dirty) file are always
    /// rebound so their lowered bodies and diagnostics reflect the new source
    /// text and spans exactly as a full rebuild would. <see langword="null"/>
    /// (or empty) means "no dirty trees" — every member may be served from the
    /// cache when the soundness gate allows it.
    /// </param>
    /// <returns>A bound program.</returns>
    public static BoundProgram BindProgram(BoundGlobalScope globalScope, ReferenceResolver? references, BoundBodyCache? cache, ImmutableHashSet<SyntaxTree>? dirtyTrees)
    {
        var parentScope = CreateParentScope(globalScope, references, preprocessorSymbols: globalScope?.PreprocessorSymbols, preserveLatestImportSyntaxTrees: true);

        // Issue #3501 A2: reuse the global-scope pass's ref-kind delegate
        // cache on this pass's scope chain, so a shape spelled in a
        // declaration's type clause and the same shape appearing inside a
        // method body resolve to ONE synthesized delegate symbol.
        if (globalScope?.RefDelegateCache != null)
        {
            parentScope.InstallSynthesizedRefDelegateCache(globalScope.RefDelegateCache);
        }

        // ADR-0146 / issue #2243: rehydrate the rich anonymous-object literal →
        // synthesized-class map onto this pass's scope chain so a literal
        // inside a function or method body binds to its synthesized class (the
        // map was built while binding the global scope, on a scope chain that
        // is not reused here).
        if (globalScope?.RichAnonymousClassMap != null && globalScope.RichAnonymousClassMap.Count > 0)
        {
            var richMap = parentScope.GetRichAnonymousClassMap();
            foreach (var kv in globalScope.RichAnonymousClassMap)
            {
                richMap[kv.Key] = kv.Value;
            }
        }

        if (globalScope?.RichAnonymousObjectPlans != null && globalScope.RichAnonymousObjectPlans.Count > 0)
        {
            var richPlans = parentScope.GetRichAnonymousObjectPlans();
            foreach (var kv in globalScope.RichAnonymousObjectPlans)
            {
                richPlans[kv.Key] = kv.Value;
            }
        }

        if (globalScope?.StructuralAdapters != null)
        {
            var adapters = parentScope.GetStructuralAdapterRegistry();
            adapters.Counter = Math.Max(adapters.Counter, globalScope.StructuralAdapters.Counter);
            adapters.Types.AddRange(globalScope.StructuralAdapters.Types);
            foreach (var pair in globalScope.StructuralAdapters.MethodBodies)
            {
                adapters.MethodBodies[pair.Key] = pair.Value;
            }
        }

        var functionBodies = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
        var diagnostics = ImmutableArray.CreateBuilder<Diagnostic>();

        var scope = globalScope;

        while (scope != null)
        {
            foreach (var function in scope.Functions)
            {
                // ADR-0086 / issue #727: P/Invoke functions have no managed
                // body — the binder skips body binding and the emitter writes
                // a PinvokeImpl method with an ImplMap row instead. We still
                // register the function in functionBodies (with an empty
                // synthetic block) so the emitter's per-package method-row
                // planner produces a MethodDef handle for it.
                if (function.IsPInvoke)
                {
                    functionBodies.Add(function, new BoundBlockStatement(function.Declaration, ImmutableArray<BoundStatement>.Empty));
                    continue;
                }

                var (functionDeclaration, functionBody) = RequireDeclaredBody(function);
                var loweredBody = BindBodyWithPackage(
                    parentScope,
                    function.Package?.Name,
                    functionBody.SyntaxTree,
                    () =>
                    {
                        return BindBodyWithCache(cache, dirtyTrees, function, functionBody, diagnostics, () =>
                        {
                            var binder = new Binder(parentScope, function);
                            binder.binderCtx.FunctionContainsUserGotoOrLabel = StatementBinder.ContainsUserGotoOrLabel(functionBody);
                            var body = binder.statements.BindBlockStatement(functionBody);
                            binder.statements.FinalizeUserLabels();
                            var lowered = Lowerer.Lower(body);

                            if (function.Type != TypeSymbol.Void && !IsIteratorReturnType(function.Type) && !ControlFlowGraph.AllPathsReturn(lowered))
                            {
                                binder.Diagnostics.ReportAllPathsMustReturn(functionDeclaration.Identifier.Location);
                            }

                            AnalyzeFunctionBody(lowered, function, binder.Diagnostics);

                            return new BodyBindResult(lowered, binder.Diagnostics.ToImmutableArray());
                        });
                    });

                functionBodies.Add(function, loweredBody);
            }

            scope = scope.Previous;
        }

        // Phase 3.B.3 sub-step 2b: bind class method bodies. Methods are not
        // in globalScope.Functions (they're addressed via the dot operator),
        // so we walk Structs explicitly here. globalScope is this method's
        // own non-nullable parameter, never reassigned above.
        foreach (var structSym in globalScope!.Structs)
        {
            if (structSym.Methods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var method in structSym.Methods)
            {
                if (parentScope.GetRichAnonymousObjectPlans().TryGetValue(structSym, out var richPlan)
                    && richPlan.MethodBodies.TryGetValue(method, out var richBody))
                {
                    functionBodies[method] = richBody;
                    continue;
                }

                // Issue #987: abstract methods (a no-body `open func F() R;`)
                // have no managed body — register an empty synthetic block so
                // the emitter still mints a MethodDef handle (it writes an
                // abstract virtual slot with no IL body) and skip body binding,
                // which would otherwise dereference the null `Declaration.Body`
                // and crash with GS9998 (the original ICE in issue #987).
                if (method.IsAbstract)
                {
                    functionBodies.Add(method, new BoundBlockStatement(method.Declaration, ImmutableArray<BoundStatement>.Empty));
                    continue;
                }

                var (methodDeclaration, methodBody) = RequireDeclaredBody(method);
                var loweredBody = BindBodyWithPackage(
                    parentScope,
                    structSym.PackageName,
                    methodBody.SyntaxTree,
                    () =>
                    {
                        return BindBodyWithCache(cache, dirtyTrees, method, methodBody, diagnostics, () =>
                        {
                            var binder = new Binder(parentScope, method);
                            binder.binderCtx.FunctionContainsUserGotoOrLabel = StatementBinder.ContainsUserGotoOrLabel(methodBody);
                            var body = binder.statements.BindBlockStatement(methodBody);
                            binder.statements.FinalizeUserLabels();
                            var lowered = Lowerer.Lower(body, structSym);

                            if (method.Type != TypeSymbol.Void && !IsIteratorReturnType(method.Type) && !ControlFlowGraph.AllPathsReturn(lowered))
                            {
                                binder.Diagnostics.ReportAllPathsMustReturn(methodDeclaration.Identifier.Location);
                            }

                            AnalyzeFunctionBody(lowered, method, binder.Diagnostics);

                            return new BodyBindResult(lowered, binder.Diagnostics.ToImmutableArray());
                        });
                    });

                functionBodies.Add(method, loweredBody);
            }
        }

        // ADR-0085 / issue #726: bind default-interface-method bodies. An
        // interface method whose declaration carries a non-null Body is a
        // DIM; bind it through the same pipeline as a class method so the
        // resulting BoundBlockStatement is registered in functionBodies
        // (interpreter + emit both look it up by FunctionSymbol). Abstract
        // interface methods (no body) are skipped — they remain abstract
        // MethodDef rows in metadata and have no entry in functionBodies.
        foreach (var ifaceSym in globalScope.Interfaces)
        {
            if (ifaceSym.Methods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var method in ifaceSym.Methods)
            {
                if (method?.Declaration?.Body == null)
                {
                    continue;
                }

                BindInterfaceMethodBody(cache, dirtyTrees, parentScope, method, functionBodies, diagnostics);
            }
        }

        // ADR-0089 / issue #755: bind default bodies on static-virtual
        // interface methods. The shape mirrors the DIM loop above but
        // walks StaticMethods. Abstract static-virtuals (no body) skip
        // body binding and leave only the abstract MethodDef row.
        foreach (var ifaceSym in globalScope.Interfaces)
        {
            if (ifaceSym.StaticMethods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var method in ifaceSym.StaticMethods)
            {
                if (method?.Declaration?.Body == null)
                {
                    continue;
                }

                BindInterfaceMethodBody(cache, dirtyTrees, parentScope, method, functionBodies, diagnostics);
            }
        }

        // Issue #1030 / #2293: bind default bodies on interface *property*
        // accessors (get_/set_), both static-virtual and ordinary instance
        // properties. This mirrors the default-interface-method loop above: a
        // default-bodied accessor (arrow `->` or block body) is a
        // non-abstract Virtual slot whose lowered body is registered in
        // functionBodies keyed by the accessor FunctionSymbol. Abstract
        // accessors (no body) are skipped and remain abstract MethodDef rows.
        foreach (var ifaceSym in globalScope.Interfaces)
        {
            if (ifaceSym.Properties.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var prop in ifaceSym.Properties)
            {
                if (prop.GetterSymbol != null && prop.GetterBodySyntax != null)
                {
                    BindInterfaceAccessorBody(cache, dirtyTrees, parentScope, prop.GetterSymbol, prop.GetterBodySyntax, functionBodies, diagnostics, requireAllPathsReturn: true);
                }

                if (prop.SetterSymbol != null && prop.SetterBodySyntax != null)
                {
                    BindInterfaceAccessorBody(cache, dirtyTrees, parentScope, prop.SetterSymbol, prop.SetterBodySyntax, functionBodies, diagnostics, requireAllPathsReturn: false);
                }
            }
        }

        // ADR-0090 / issue #756: bind bodies on private interface helper
        // methods (both instance and static). Private helpers are required
        // to carry a body (GS0335 fires when the body is omitted), so a
        // missing body here is an already-diagnosed surface error — we
        // simply skip it rather than re-diagnose.
        foreach (var ifaceSym in globalScope.Interfaces)
        {
            if (!ifaceSym.PrivateMethods.IsDefaultOrEmpty)
            {
                foreach (var method in ifaceSym.PrivateMethods)
                {
                    if (method?.Declaration?.Body == null)
                    {
                        continue;
                    }

                    BindInterfaceMethodBody(cache, dirtyTrees, parentScope, method, functionBodies, diagnostics);
                }
            }

            if (!ifaceSym.StaticPrivateMethods.IsDefaultOrEmpty)
            {
                foreach (var method in ifaceSym.StaticPrivateMethods)
                {
                    if (method?.Declaration?.Body == null)
                    {
                        continue;
                    }

                    BindInterfaceMethodBody(cache, dirtyTrees, parentScope, method, functionBodies, diagnostics);
                }
            }
        }

        // Issue #306: bind standalone user-defined constructor bodies. Like
        // instance methods, the constructor body sees `this`, the constructor
        // parameters, and the aggregate's fields (via bare names). The body is keyed
        // in functionBodies by the constructor's underlying FunctionSymbol.
        // ADR-0063 §9 / issue #2766: an aggregate may declare multiple init(...) constructors; each
        // body is bound independently.
        foreach (var structSym in globalScope.Structs)
        {
            if (structSym.ExplicitConstructors.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var ctor in structSym.ExplicitConstructors)
            {
                // ADR-0065 §5: skip synthesized primary-ctor symbols; the
                // emitter materializes their field-assignment body directly.
                var ctorDeclaration = ctor.Declaration;
                if (ctor.IsSynthesizedFromPrimaryConstructor || ctorDeclaration == null)
                {
                    continue;
                }

                var ctorLoweredBody = BindBodyWithPackage(
                    parentScope,
                    structSym.PackageName,
                    ctorDeclaration.Body.SyntaxTree,
                    () =>
                    {
                        return BindBodyWithCache(cache, dirtyTrees, ctor.Function, ctorDeclaration.Body, diagnostics, () =>
                        {
                            var ctorBinder = new Binder(parentScope, ctor.Function);
                            ctorBinder.binderCtx.FunctionContainsUserGotoOrLabel = StatementBinder.ContainsUserGotoOrLabel(ctorDeclaration.Body);
                            var ctorBody = ctorBinder.statements.BindBlockStatement(ctorDeclaration.Body);
                            ctorBinder.statements.FinalizeUserLabels();

                            // ADR-0065 §2 Rule 3: a `convenience init` body must begin
                            // with a `init(args)` self-delegation expression-statement.
                            if (ctor.IsConvenience)
                            {
                                VerifyConvenienceInitDelegatesFirst(ctor, ctorBody, ctorBinder.Diagnostics);
                            }

                            var lowered = Lowerer.Lower(ctorBody, structSym);
                            AnalyzeFunctionBody(lowered, ctor.Function, ctorBinder.Diagnostics);
                            return new BodyBindResult(lowered, ctorBinder.Diagnostics.ToImmutableArray());
                        });
                    });
                functionBodies.Add(ctor.Function, ctorLoweredBody);
            }
        }

        // ADR-0068 / issue #698: bind class destructor (`deinit { … }`) bodies.
        // The body sees `this` and the class's fields (via bare names) — just
        // like an instance-method or constructor body. The emitter wraps the
        // bound body in `try { … } finally { base.Finalize(); }` directly in
        // IL, so we do not synthesize the wrapper here.
        foreach (var structSym in globalScope.Structs)
        {
            var deinit = structSym.Deinitializer;
            if (deinit == null || deinit.Declaration == null)
            {
                continue;
            }

            BindStructMemberBody(cache, dirtyTrees, parentScope, deinit.Function, deinit.Declaration.Body, structSym, functionBodies, diagnostics);
        }

        // ADR-0051: bind computed property accessor bodies. These are analogous
        // to method bodies but hang off PropertySymbol.GetterSymbol/SetterSymbol.
        foreach (var structSym in globalScope.Structs)
        {
            if (!structSym.Properties.IsDefaultOrEmpty)
            {
                foreach (var prop in structSym.Properties)
                {
                    if (prop.IsAutoProperty)
                    {
                        continue;
                    }

                    if (prop.GetterSymbol != null && prop.GetterBodySyntax != null)
                    {
                        BindStructMemberBody(cache, dirtyTrees, parentScope, prop.GetterSymbol, prop.GetterBodySyntax, structSym, functionBodies, diagnostics, prop.GetterBodySyntax.OpenBraceToken.Location);
                    }

                    if (prop.SetterSymbol != null && prop.SetterBodySyntax != null)
                    {
                        BindStructMemberBody(cache, dirtyTrees, parentScope, prop.SetterSymbol, prop.SetterBodySyntax, structSym, functionBodies, diagnostics);
                    }
                }
            }

            // ADR-0052: bind explicit event accessor bodies (add/remove/raise).
            if (!structSym.Events.IsDefaultOrEmpty)
            {
                foreach (var ev in structSym.Events)
                {
                    if (ev.IsFieldLike)
                    {
                        continue;
                    }

                    if (ev.AddMethodSymbol != null && ev.AddBodySyntax != null)
                    {
                        BindStructMemberBody(cache, dirtyTrees, parentScope, ev.AddMethodSymbol, ev.AddBodySyntax, structSym, functionBodies, diagnostics);
                    }

                    if (ev.RemoveMethodSymbol != null && ev.RemoveBodySyntax != null)
                    {
                        BindStructMemberBody(cache, dirtyTrees, parentScope, ev.RemoveMethodSymbol, ev.RemoveBodySyntax, structSym, functionBodies, diagnostics);
                    }

                    // Issue #257: bind raise accessor body.
                    if (ev.RaiseMethodSymbol != null && ev.RaiseBodySyntax != null)
                    {
                        BindStructMemberBody(cache, dirtyTrees, parentScope, ev.RaiseMethodSymbol, ev.RaiseBodySyntax, structSym, functionBodies, diagnostics);
                    }
                }
            }
        }

        // Issue #263: bind static property accessor bodies declared in `shared` blocks.
        foreach (var structSym in globalScope.Structs)
        {
            if (structSym.StaticProperties.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var prop in structSym.StaticProperties)
            {
                if (prop.IsAutoProperty)
                {
                    continue;
                }

                if (prop.GetterSymbol != null && prop.GetterBodySyntax != null)
                {
                    BindStructMemberBody(cache, dirtyTrees, parentScope, prop.GetterSymbol, prop.GetterBodySyntax, structSym, functionBodies, diagnostics, prop.GetterBodySyntax.OpenBraceToken.Location);
                }

                if (prop.SetterSymbol != null && prop.SetterBodySyntax != null)
                {
                    BindStructMemberBody(cache, dirtyTrees, parentScope, prop.SetterSymbol, prop.SetterBodySyntax, structSym, functionBodies, diagnostics);
                }
            }
        }

        // Issue #263: bind static event accessor bodies declared in `shared` blocks.
        foreach (var structSym in globalScope.Structs)
        {
            if (structSym.StaticEvents.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var ev in structSym.StaticEvents)
            {
                if (ev.IsFieldLike)
                {
                    continue;
                }

                if (ev.AddMethodSymbol != null && ev.AddBodySyntax != null)
                {
                    BindStructMemberBody(cache, dirtyTrees, parentScope, ev.AddMethodSymbol, ev.AddBodySyntax, structSym, functionBodies, diagnostics);
                }

                if (ev.RemoveMethodSymbol != null && ev.RemoveBodySyntax != null)
                {
                    BindStructMemberBody(cache, dirtyTrees, parentScope, ev.RemoveMethodSymbol, ev.RemoveBodySyntax, structSym, functionBodies, diagnostics);
                }

                // Issue #257: bind raise accessor body for static events.
                if (ev.RaiseMethodSymbol != null && ev.RaiseBodySyntax != null)
                {
                    BindStructMemberBody(cache, dirtyTrees, parentScope, ev.RaiseMethodSymbol, ev.RaiseBodySyntax, structSym, functionBodies, diagnostics);
                }
            }
        }

        // ADR-0053 Phase D: bind static method bodies declared in `shared` blocks.
        foreach (var structSym in globalScope.Structs)
        {
            if (structSym.StaticMethods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var method in structSym.StaticMethods)
            {
                if (method.Declaration == null)
                {
                    continue;
                }

                // Issue #4234: an `@ExtensionOwner`-routed extension function
                // (DeclarationBinder.Functions.cs) is added to
                // `structSym.StaticMethods` purely so the emitter hosts its
                // MethodDef here instead of the package's `<Program>` — it is
                // still a genuine top-level declaration, registered (and
                // already body-bound, with no `structSym` lowering context,
                // which it does not need) through the ordinary
                // `globalScope.Functions` loop above via
                // `scope.TryDeclareExtensionFunction`. Binding it again here
                // would both waste work and throw on the second
                // `functionBodies.Add` for the same key.
                if (method.IsExtension)
                {
                    continue;
                }

                // ADR-0086 / issue #1203: a bodyless `shared`-block method (a
                // static `@DllImport` P/Invoke extern) has no managed body to
                // bind. Register an empty synthetic block so the emitter still
                // mints a MethodDef handle (it routes P/Invokes through the
                // ImplMap path and writes no IL body) and skip body binding,
                // which would otherwise dereference the null `Declaration.Body`
                // and crash with GS9998 (the static-path analogue of issue #987).
                if (method.Declaration.Body == null)
                {
                    functionBodies.Add(method, new BoundBlockStatement(method.Declaration, ImmutableArray<BoundStatement>.Empty));
                    continue;
                }

                BindStructMethodBody(cache, dirtyTrees, parentScope, method, structSym, functionBodies, diagnostics);
            }
        }

        // ADR-0140 / issue #2131: bind `shared { init { … } }` static-initializer
        // blocks. Their statements run in the type's `.cctor` after the
        // static-field initializers. Bound in a static context whose owner is
        // the enclosing type so bare static-member names resolve (and are
        // assignable), then lowered once and stored on the type symbol.
        foreach (var structSym in globalScope.Structs)
        {
            BindStaticInitializerBlocks(parentScope, structSym, diagnostics);
        }

        var statement = Lowerer.Lower(new BoundBlockStatement(null, globalScope.Statements));

        // If the entry point is the synthesized top-level function, its body is
        // the lowered top-level statements block. Register it under EntryPoint so
        // the emitter sees a uniform "Functions[EntryPoint]" view.
        if (globalScope.EntryPoint != null && globalScope.EntryPoint.Declaration == null)
        {
            functionBodies[globalScope.EntryPoint] = statement;
        }

        // #191: surface user-declared top-level var/let/const so the emitter can
        // round-trip them as CLR static fields on <Program>. Filter out
        // compiler-synthesized temps (e.g. tuple-destructuring "<>m_..." vars)
        // by the C#-style "<>" name prefix — those remain local-slot scoped.
        var globals = globalScope.Variables
            .OfType<GlobalVariableSymbol>()
            .Where(g => !g.Name.StartsWith("<>"))
            .ToImmutableArray();

        foreach (var pair in parentScope.GetStructuralAdapterRegistry().MethodBodies)
        {
            functionBodies[pair.Key] = pair.Value;
        }

        // Issue #2224: union the anonymous-class types synthesized while
        // binding top-level statements (globalScope.AnonymousTypes) with
        // those synthesized while binding function/method bodies just above
        // (parentScope's own AnonymousTypeCache — a fresh scope chain
        // derived from globalScope, so it has its own cache instance) into
        // BoundProgram.Structs. Everything downstream (TypeDef planning,
        // field rows, the data-class Equals/GetHashCode/ToString/ctor
        // synthesizer) drives entirely off BoundProgram.Structs, so no
        // further emitter changes are needed to give each synthesized shape
        // a real CLR type.
        var allStructs = globalScope.Structs
            .AddRange(globalScope.AnonymousTypes)
            .AddRange(parentScope.GetAnonymousTypeCache().Symbols)
            .AddRange(parentScope.GetStructuralAdapterRegistry().Types);

        // ADR-0169: guarantee a syntax anchor on every dispatchable bound node
        // the program exposes. Construction sites and the bind dispatchers
        // anchor most nodes precisely; nodes synthesized during binding or
        // per-member lowering inherit the nearest anchored ancestor here.
        foreach (var (function, body) in functionBodies)
        {
            SyntaxAnchoringWalker.Anchor(body, function.Declaration);
        }

        // The synthesized top-level block has no syntax of its own; anchor it
        // (and any synthesized statements inside it) at the first top-level
        // statement that has one. A program with no top-level statements keeps
        // the empty synthetic block unanchored — there is nothing to point at.
        SyntaxAnchoringWalker.Anchor(statement, statement.Statements.FirstOrDefault(s => s.Syntax is not null)?.Syntax);

        // ADR-0174 D4: infer which functions suspend, retype the calls to them,
        // and complete those calls (implicit await / blocking root bridge).
        // Runs after every body is bound and anchored, so the fixed point sees
        // the whole call graph; the entry point's body is one of the bodies.
        var entryBodyWasTheStatementBlock = globalScope.EntryPoint is { } entryBefore
            && functionBodies.TryGetValue(entryBefore, out var entryBodyBefore)
            && ReferenceEquals(entryBodyBefore, statement);

        // The root scope already fell back to ReferenceResolver.Default() when
        // the caller passed none; inference must see the same references the
        // bodies were bound against, or a references-less compilation would
        // bind channel operations yet never colour the functions around them.
        Suspension.SuspensionInference.Run(functionBodies, globalScope.EntryPoint, parentScope.References, diagnostics);

        // ADR-0174 D10 / GS0562: batching a rendezvous channel is correct and
        // pointless. Reported here, over the bound bodies, because the question
        // is about the receiver's declaration rather than the call.
        RendezvousBatchAnalyzer.Run(functionBodies, diagnostics);
        var managedReferenceDiagnostics = new DiagnosticBag();
        ManagedReferenceSafetyAnalyzer.Analyze(functionBodies, allStructs, globalScope.Interfaces, managedReferenceDiagnostics);
        diagnostics.AddRange(managedReferenceDiagnostics.ToImmutableArray());
        if (entryBodyWasTheStatementBlock && functionBodies.TryGetValue(globalScope.EntryPoint!, out var inferredEntryBody))
        {
            // The synthesized top-level block IS the entry point's body; a user
            // `func Main()` keeps its own body and the (empty) statement block.
            statement = inferredEntryBody;
        }

        // Issue #3501 A2: union the ref-kind delegates synthesized while
        // binding top-level statements (already in globalScope.Delegates via
        // BindGlobalScope) with those synthesized while binding
        // function/method bodies just above (parentScope's own cache — a
        // fresh scope chain, mirroring the anonymous-type union above).
        var allDelegates = globalScope.Delegates
            .AddRange(parentScope.GetSynthesizedRefDelegateCache().Symbols
                .Where(d => !globalScope.Delegates.Contains(d)));

        return new BoundProgram(globalScope.Package, globalScope.Packages, diagnostics.ToImmutable(), functionBodies.ToImmutable(), globalScope.EntryPoint, statement, allStructs, globalScope.Interfaces, globalScope.Enums, globals, allDelegates)
        {
            Imports = globalScope.GetCumulativeImports(),
            FriendAssemblies = globalScope.FriendAssemblies,
            AssemblyAttributes = globalScope.AssemblyAttributes,
            ModuleAttributes = globalScope.ModuleAttributes,
        };
    }

    /// <summary>
    /// Asserts that <paramref name="function"/> has a source declaration with
    /// a body, for the member-body binding loops in <see cref="BindProgram(BoundGlobalScope, ReferenceResolver?, BoundBodyCache?, ImmutableHashSet{SyntaxTree}?)"/>
    /// and <see cref="BindInterfaceMethodBody"/>/<see cref="BindStructMemberBody"/>
    /// and friends. Every caller has already skipped members with no body
    /// (P/Invoke, abstract, or an explicit <c>Declaration?.Body == null</c>
    /// check) before reaching this call.
    /// </summary>
    /// <param name="function">The member symbol whose declaration and body are required.</param>
    /// <returns>The member's non-null declaration and body.</returns>
    private static (FunctionDeclarationSyntax Declaration, BlockStatementSyntax Body) RequireDeclaredBody(FunctionSymbol function)
    {
        var declaration = Invariant.Required(function.Declaration, "the caller has already skipped members with no source declaration");
        var body = Invariant.Required(declaration.Body, "the caller has already skipped members with no body (abstract/PInvoke/extern)");
        return (declaration, body);
    }

    /// <summary>
    /// ADR-0105 helper shared by every member-body bind site in
    /// <see cref="BindProgram(BoundGlobalScope, ReferenceResolver, BoundBodyCache, ImmutableHashSet{SyntaxTree})"/>.
    /// On a <em>sound</em> cache hit it returns the cached lowered body and
    /// appends the cached per-body diagnostics; otherwise it invokes
    /// <paramref name="bindAndLower"/> (which performs the exact same
    /// bind/lower/post-check work the call site would have done inline),
    /// appends the produced diagnostics, and stores the result for later reuse.
    /// When <paramref name="cache"/> is <see langword="null"/> this is exactly
    /// the full-rebuild path with no behavioral difference.
    /// </summary>
    /// <param name="cache">The optional bound-body cache.</param>
    /// <param name="dirtyTrees">
    /// ADR-0105 Phase 2: when <paramref name="bodySyntax"/> belongs to one of
    /// these freshly-parsed (edited) trees, the cache read is <em>bypassed</em>
    /// so the body is always rebound from scratch (and re-stored) — its lowered
    /// form and diagnostics then reflect the new source text and spans exactly
    /// as a full rebuild would. <see langword="null"/> means no dirty trees.
    /// </param>
    /// <param name="member">The member symbol whose body is being bound.</param>
    /// <param name="bodySyntax">The body syntax that will be bound and lowered.</param>
    /// <param name="diagnostics">The program-level diagnostics accumulator to append to.</param>
    /// <param name="bindAndLower">Produces the freshly bound+lowered body and its diagnostics on a miss.</param>
    /// <returns>The lowered body — reused on a sound hit, freshly produced otherwise.</returns>
    private static BoundBlockStatement BindBodyWithCache(
        BoundBodyCache? cache,
        ImmutableHashSet<SyntaxTree>? dirtyTrees,
        FunctionSymbol member,
        SyntaxNode bodySyntax,
        ImmutableArray<Diagnostic>.Builder diagnostics,
        Func<BodyBindResult> bindAndLower)
    {
        var isDirty = dirtyTrees != null
            && bodySyntax?.SyntaxTree != null
            && dirtyTrees.Contains(bodySyntax.SyntaxTree);

        if (!isDirty
            && cache != null
            && bodySyntax != null
            && cache.TryReuse(member, bodySyntax, out var reusedBody, out var reusedDiagnostics))
        {
            AppendBodyDiagnostics(diagnostics, reusedDiagnostics, member);
            return reusedBody;
        }

        var result = bindAndLower();
        AppendBodyDiagnostics(diagnostics, result.Diagnostics, member);

        // bodySyntax is this method's own non-nullable parameter, never
        // reassigned above (the `bodySyntax?.SyntaxTree` read a few lines up
        // is a redundant null-conditional, not a narrowing of bodySyntax).
        cache?.Store(member, bodySyntax!, result.Body, result.Diagnostics);
        return result.Body;
    }

    private static void AppendBodyDiagnostics(
        ImmutableArray<Diagnostic>.Builder diagnostics,
        ImmutableArray<Diagnostic> bodyDiagnostics,
        FunctionSymbol member)
    {
        foreach (var diagnostic in bodyDiagnostics)
        {
            if (member.NullableSequenceSpecialization != NullableSequenceSpecializationKind.None
                && diagnostics.Any(existing =>
                    existing.Id == diagnostic.Id
                    && existing.Severity == diagnostic.Severity
                    && existing.Message == diagnostic.Message
                    && existing.Location.CompareTo(diagnostic.Location) == 0))
            {
                continue;
            }

            diagnostics.Add(diagnostic);
        }
    }

    /// <summary>
    /// Issue #2342: runs <paramref name="bind"/> with <paramref name="packageName"/>
    /// set as <paramref name="parentScope"/>'s ambient "current declaring
    /// package" (see <see cref="BoundScope.SetCurrentDeclaringPackage"/>) for
    /// the duration of a single member-body bind, restoring the previous
    /// value afterwards. This lets an unqualified type-alias reference inside
    /// the body (e.g. a data-class object literal such as
    /// <c>AnonymousType0{...}</c>) prefer its OWN declaring package's
    /// same-simple-name type over an unrelated package's homonym — the
    /// ambiguity that arises when two packages each independently synthesize
    /// a type with the same simple name (the Oahu.Data EF-migration shape).
    ///
    /// Issue #2456 (per-file import scoping / #2395 follow-up): ALSO sets
    /// <paramref name="referencingTree"/> as the ambient "current referencing
    /// syntax tree" (see <see cref="BoundScope.SetCurrentReferencingSyntaxTree"/>)
    /// for the same duration, so a same-simple-name collision encountered
    /// while binding this body (e.g. a struct-literal or bare-constructor-call
    /// reference — issue #2455) is only disambiguated by an import declared in
    /// THIS body's own file — never a sibling file's import.
    /// </summary>
    /// <param name="parentScope">The scope whose ambient declaring-package is set for the duration of the call.</param>
    /// <param name="packageName">The declaring package of the member whose body is about to be bound, or <see langword="null"/> when unknown.</param>
    /// <param name="referencingTree">The syntax tree (file) the member's body belongs to.</param>
    /// <param name="bind">Performs the member-body bind/lower work.</param>
    /// <returns>The lowered body produced by <paramref name="bind"/>.</returns>
    private static BoundBlockStatement BindBodyWithPackage(BoundScope parentScope, string? packageName, GSharp.Core.CodeAnalysis.Syntax.SyntaxTree referencingTree, Func<BoundBlockStatement> bind)
    {
        var previousPackage = parentScope.SetCurrentDeclaringPackage(packageName);
        var previousTree = parentScope.SetCurrentReferencingSyntaxTree(referencingTree);
        try
        {
            return bind();
        }
        finally
        {
            parentScope.SetCurrentDeclaringPackage(previousPackage);
            parentScope.SetCurrentReferencingSyntaxTree(previousTree);
        }
    }

    /// <summary>
    /// ADR-0105 (Phase 1) helper for the four structurally identical interface
    /// member-body bind loops (default-interface methods, static-virtual
    /// defaults, and private instance/static helpers). Each lowers without a
    /// declaring-type context and runs the all-paths-return check, then routes
    /// through <see cref="BindBodyWithCache"/> and registers the body.
    /// </summary>
    /// <param name="cache">The optional bound-body cache.</param>
    /// <param name="dirtyTrees">ADR-0105 Phase 2: freshly-parsed (edited) trees whose member bodies must be rebound rather than served from the cache.</param>
    /// <param name="parentScope">The parent scope bodies are bound against.</param>
    /// <param name="method">The interface method whose body is being bound.</param>
    /// <param name="functionBodies">The function-body map to register the lowered body in.</param>
    /// <param name="diagnostics">The program-level diagnostics accumulator.</param>
    private static void BindInterfaceMethodBody(
        BoundBodyCache? cache,
        ImmutableHashSet<SyntaxTree>? dirtyTrees,
        BoundScope parentScope,
        FunctionSymbol method,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functionBodies,
        ImmutableArray<Diagnostic>.Builder diagnostics)
    {
        var (interfaceMethodDeclaration, interfaceMethodBody) = RequireDeclaredBody(method);
        var loweredBody = BindBodyWithPackage(
            parentScope,
            method.Package?.Name,
            interfaceMethodBody.SyntaxTree,
            () =>
            {
                return BindBodyWithCache(cache, dirtyTrees, method, interfaceMethodBody, diagnostics, () =>
                {
                    var binder = new Binder(parentScope, method);
                    binder.binderCtx.FunctionContainsUserGotoOrLabel = StatementBinder.ContainsUserGotoOrLabel(interfaceMethodBody);
                    var body = binder.statements.BindBlockStatement(interfaceMethodBody);
                    binder.statements.FinalizeUserLabels();
                    var lowered = Lowerer.Lower(body);

                    if (method.Type != TypeSymbol.Void && !IsIteratorReturnType(method.Type) && !ControlFlowGraph.AllPathsReturn(lowered))
                    {
                        binder.Diagnostics.ReportAllPathsMustReturn(interfaceMethodDeclaration.Identifier.Location);
                    }

                    AnalyzeFunctionBody(lowered, method, binder.Diagnostics);

                    return new BodyBindResult(lowered, binder.Diagnostics.ToImmutableArray());
                });
            });

        functionBodies.Add(method, loweredBody);
    }

    /// <summary>
    /// Issue #1030: binds the default body of a static-virtual interface
    /// property accessor (<c>get_Name</c> / <c>set_Name</c>). Like
    /// <see cref="BindInterfaceMethodBody"/> the body is lowered without a
    /// declaring-type context (a static accessor has no instance <c>this</c>),
    /// the getter's value-returning paths are checked, and the lowered body is
    /// registered in <paramref name="functionBodies"/> keyed by the accessor.
    /// </summary>
    /// <param name="cache">The optional bound-body cache.</param>
    /// <param name="dirtyTrees">Freshly-parsed (edited) trees whose member bodies must be rebound rather than served from the cache.</param>
    /// <param name="parentScope">The parent scope bodies are bound against.</param>
    /// <param name="accessor">The static accessor FunctionSymbol whose body is being bound.</param>
    /// <param name="bodySyntax">The accessor body block syntax.</param>
    /// <param name="functionBodies">The function-body map to register the lowered body in.</param>
    /// <param name="diagnostics">The program-level diagnostics accumulator.</param>
    /// <param name="requireAllPathsReturn">When true (a getter), all code paths must return a value.</param>
    private static void BindInterfaceAccessorBody(
        BoundBodyCache? cache,
        ImmutableHashSet<SyntaxTree>? dirtyTrees,
        BoundScope parentScope,
        FunctionSymbol accessor,
        BlockStatementSyntax bodySyntax,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functionBodies,
        ImmutableArray<Diagnostic>.Builder diagnostics,
        bool requireAllPathsReturn)
    {
        var loweredBody = BindBodyWithPackage(
            parentScope,
            accessor.Package?.Name,
            bodySyntax.SyntaxTree,
            () =>
            {
                return BindBodyWithCache(cache, dirtyTrees, accessor, bodySyntax, diagnostics, () =>
                {
                    var binder = new Binder(parentScope, accessor);
                    binder.binderCtx.FunctionContainsUserGotoOrLabel = StatementBinder.ContainsUserGotoOrLabel(bodySyntax);
                    var body = binder.statements.BindBlockStatement(bodySyntax);
                    binder.statements.FinalizeUserLabels();
                    var lowered = Lowerer.Lower(body);

                    if (requireAllPathsReturn
                        && !IsIteratorReturnType(accessor.Type)
                        && !ControlFlowGraph.AllPathsReturn(lowered))
                    {
                        binder.Diagnostics.ReportAllPathsMustReturn(bodySyntax.OpenBraceToken.Location);
                    }

                    AnalyzeFunctionBody(lowered, accessor, binder.Diagnostics);

                    return new BodyBindResult(lowered, binder.Diagnostics.ToImmutableArray());
                });
            });

        functionBodies.Add(accessor, loweredBody);
    }

    /// <summary>
    /// ADR-0105 (Phase 1) helper for struct/class member bodies bound with a
    /// declaring-type lowering context (computed-property accessors, event
    /// accessors and destructors). Optionally runs the all-paths-return check
    /// at <paramref name="allPathsReturnLocation"/> when supplied. Routes
    /// through <see cref="BindBodyWithCache"/> and registers the body.
    /// </summary>
    /// <param name="cache">The optional bound-body cache.</param>
    /// <param name="dirtyTrees">ADR-0105 Phase 2: freshly-parsed (edited) trees whose member bodies must be rebound rather than served from the cache.</param>
    /// <param name="parentScope">The parent scope bodies are bound against.</param>
    /// <param name="member">The member whose body is being bound.</param>
    /// <param name="bodySyntax">The body syntax to bind and lower.</param>
    /// <param name="structSym">The declaring type used as the lowering context.</param>
    /// <param name="functionBodies">The function-body map to register the lowered body in.</param>
    /// <param name="diagnostics">The program-level diagnostics accumulator.</param>
    /// <param name="allPathsReturnLocation">When non-null, the location at which to report a missing all-paths return.</param>
    private static void BindStructMemberBody(
        BoundBodyCache? cache,
        ImmutableHashSet<SyntaxTree>? dirtyTrees,
        BoundScope parentScope,
        FunctionSymbol member,
        StatementSyntax bodySyntax,
        StructSymbol structSym,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functionBodies,
        ImmutableArray<Diagnostic>.Builder diagnostics,
        TextLocation? allPathsReturnLocation = null)
    {
        var loweredBody = BindBodyWithPackage(
            parentScope,
            structSym.PackageName,
            bodySyntax.SyntaxTree,
            () =>
            {
                return BindBodyWithCache(cache, dirtyTrees, member, bodySyntax, diagnostics, () =>
                {
                    var binder = new Binder(parentScope, member);
                    binder.binderCtx.FunctionContainsUserGotoOrLabel = StatementBinder.ContainsUserGotoOrLabel(bodySyntax);

                    // BindStatement returns null only for a SyntaxKind.CommentToken
                    // node; a member body is never a bare comment.
                    var body = Invariant.Required(binder.statements.BindStatement(bodySyntax), "a member body statement is never a bare comment token");
                    binder.statements.FinalizeUserLabels();
                    var lowered = Lowerer.Lower(body, structSym);

                    if (allPathsReturnLocation != null
                        && !IsIteratorReturnType(member.Type)
                        && !ControlFlowGraph.AllPathsReturn(lowered))
                    {
                        binder.Diagnostics.ReportAllPathsMustReturn(allPathsReturnLocation.Value);
                    }

                    AnalyzeFunctionBody(lowered, member, binder.Diagnostics);

                    return new BodyBindResult(lowered, binder.Diagnostics.ToImmutableArray());
                });
            });

        functionBodies.Add(member, loweredBody);
    }

    /// <summary>
    /// ADR-0105 (Phase 1) helper for struct/class <em>method</em> bodies bound
    /// with a declaring-type lowering context (instance methods and
    /// <c>shared</c> static methods). Runs the void/iterator-guarded
    /// all-paths-return check, routes through <see cref="BindBodyWithCache"/>
    /// and registers the body.
    /// </summary>
    /// <param name="cache">The optional bound-body cache.</param>
    /// <param name="dirtyTrees">ADR-0105 Phase 2: freshly-parsed (edited) trees whose member bodies must be rebound rather than served from the cache.</param>
    /// <param name="parentScope">The parent scope bodies are bound against.</param>
    /// <param name="method">The method whose body is being bound.</param>
    /// <param name="structSym">The declaring type used as the lowering context.</param>
    /// <param name="functionBodies">The function-body map to register the lowered body in.</param>
    /// <param name="diagnostics">The program-level diagnostics accumulator.</param>
    private static void BindStructMethodBody(
        BoundBodyCache? cache,
        ImmutableHashSet<SyntaxTree>? dirtyTrees,
        BoundScope parentScope,
        FunctionSymbol method,
        StructSymbol structSym,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functionBodies,
        ImmutableArray<Diagnostic>.Builder diagnostics)
    {
        var (structMethodDeclaration, structMethodBody) = RequireDeclaredBody(method);
        var loweredBody = BindBodyWithPackage(
            parentScope,
            structSym.PackageName,
            structMethodBody.SyntaxTree,
            () =>
            {
                return BindBodyWithCache(cache, dirtyTrees, method, structMethodBody, diagnostics, () =>
                {
                    var binder = new Binder(parentScope, method);
                    binder.binderCtx.FunctionContainsUserGotoOrLabel = StatementBinder.ContainsUserGotoOrLabel(structMethodBody);
                    var body = binder.statements.BindBlockStatement(structMethodBody);
                    binder.statements.FinalizeUserLabels();
                    var lowered = Lowerer.Lower(body, structSym);

                    if (method.Type != TypeSymbol.Void && !IsIteratorReturnType(method.Type) && !ControlFlowGraph.AllPathsReturn(lowered))
                    {
                        binder.Diagnostics.ReportAllPathsMustReturn(structMethodDeclaration.Identifier.Location);
                    }

                    AnalyzeFunctionBody(lowered, method, binder.Diagnostics);

                    return new BodyBindResult(lowered, binder.Diagnostics.ToImmutableArray());
                });
            });

        functionBodies.Add(method, loweredBody);
    }

    private static void AnalyzeFunctionBody(
        BoundBlockStatement lowered,
        FunctionSymbol function,
        DiagnosticBag diagnostics)
    {
        var body = lowered.PreEmitAnalysisBody ?? lowered;
        MethodGroupDiagnostics.ReportUnresolved(body, diagnostics);
        DefiniteAssignmentAnalyzer.Analyze(body, function, diagnostics);
        if (function.IsAsyncOrSuspending)
        {
            new NativeSliceSuspensionAnalyzer(diagnostics).Visit(body);
        }

        RefStructAsyncLivenessAnalyzer.Analyze(body, function, diagnostics);
    }

    /// <summary>
    /// ADR-0140 / issue #2131: binds the <c>shared { init { … } }</c>
    /// static-initializer block(s) of <paramref name="structSym"/> and records
    /// the bound, lowered statements on the symbol. The statements are bound in
    /// a static context whose <see cref="FunctionSymbol.StaticOwnerType"/> is the
    /// enclosing type, so bare static-field/property names resolve and are
    /// assignable — matching a C# static-constructor body. Multiple blocks are
    /// concatenated in source order and lowered as a single block so generated
    /// labels stay unique.
    /// </summary>
    /// <param name="parentScope">The parent scope the block is bound against.</param>
    /// <param name="structSym">The type whose init block(s) are being bound.</param>
    /// <param name="diagnostics">The program-level diagnostics accumulator.</param>
    private static void BindStaticInitializerBlocks(
        BoundScope parentScope,
        StructSymbol structSym,
        ImmutableArray<Diagnostic>.Builder diagnostics)
    {
        var structDeclaration = structSym.Declaration;
        var initBlocks = structDeclaration?.SharedBlock?.InitBlocks ?? ImmutableArray<StaticInitializerBlockSyntax>.Empty;
        if (initBlocks.IsDefaultOrEmpty)
        {
            return;
        }

        // Non-empty initBlocks came from structDeclaration?.SharedBlock?.InitBlocks,
        // so structDeclaration is non-null here.
        structDeclaration = Invariant.Required(structDeclaration, "initBlocks is only non-empty when structDeclaration is non-null");

        var context = new FunctionSymbol(
            "<static-initializer>",
            ImmutableArray<ParameterSymbol>.Empty,
            TypeSymbol.Void)
        {
            IsStatic = true,
            StaticOwnerType = structSym,
            IsStaticInitializer = true,
        };

        var previousPackage = parentScope.SetCurrentDeclaringPackage(structSym.PackageName);
        var previousTree = parentScope.SetCurrentReferencingSyntaxTree(structDeclaration.SyntaxTree);
        try
        {
            var binder = new Binder(parentScope, context);

            // Issue #4285: merged partial static-initializer blocks share
            // one goto/label namespace (see the FinalizeUserLabels call
            // below), so the narrowing-lift guard must see whether ANY
            // block contains a goto/label, not just the one currently being
            // bound.
            binder.binderCtx.FunctionContainsUserGotoOrLabel =
                initBlocks.Any(b => StatementBinder.ContainsUserGotoOrLabel(b.Body));
            var boundBlocks = ImmutableArray.CreateBuilder<BoundStatement>();
            foreach (var initBlock in initBlocks)
            {
                // Issue #3336: merged partial blocks retain the declaring part's tree.
                parentScope.SetCurrentReferencingSyntaxTree(initBlock.SyntaxTree);
                boundBlocks.Add(binder.statements.BindBlockStatement(initBlock.Body));
            }

            binder.statements.FinalizeUserLabels();
            var combined = new BoundBlockStatement(null, boundBlocks.ToImmutable());
            var lowered = Lowerer.Lower(combined, structSym);
            MethodGroupDiagnostics.ReportUnresolved(lowered, binder.Diagnostics);
            diagnostics.AddRange(binder.Diagnostics.ToImmutableArray());
            structSym.SetStaticInitializerStatements(lowered.Statements);
        }
        finally
        {
            parentScope.SetCurrentDeclaringPackage(previousPackage);
            parentScope.SetCurrentReferencingSyntaxTree(previousTree);
        }
    }

    /// <summary>
    /// Speculatively binds <paramref name="expression"/> against the program's
    /// scope to infer its <see cref="TypeSymbol"/>, discarding any diagnostics.
    /// Used by the language server to offer member completions on arbitrary
    /// receiver expressions (e.g. <c>(a + b).</c>, <c>foo().</c>, <c>arr[0].</c>,
    /// <c>a.b.</c>). Top-level variables are reachable through the reconstructed
    /// parent scope; locals/parameters of an enclosing function must be supplied
    /// via <paramref name="additionalLocals"/>.
    /// </summary>
    /// <param name="globalScope">The bound global scope of the compilation.</param>
    /// <param name="references">The reference resolver supplying imported types.</param>
    /// <param name="containingFunction">The function enclosing the expression, or <c>null</c> for top-level statements.</param>
    /// <param name="additionalLocals">In-scope locals/parameters to declare before binding, or <c>null</c>.</param>
    /// <param name="expression">The receiver expression to infer a type for.</param>
    /// <returns>The inferred non-error, non-void type, or <c>null</c> when inference fails.</returns>
    public static TypeSymbol? TryInferExpressionType(
        BoundGlobalScope globalScope,
        ReferenceResolver references,
        FunctionSymbol? containingFunction,
        IEnumerable<VariableSymbol> additionalLocals,
        ExpressionSyntax expression)
    {
        if (globalScope == null || expression == null)
        {
            return null;
        }

        try
        {
            var parentScope = CreateParentScope(globalScope, references, globalScope.PreprocessorSymbols, preserveLatestImportSyntaxTrees: true);
            var binder = new Binder(parentScope, containingFunction);
            var previousPackage = parentScope.SetCurrentDeclaringPackage(containingFunction?.Package?.Name);
            var previousTree = parentScope.SetCurrentReferencingSyntaxTree(expression.SyntaxTree);

            try
            {
                if (additionalLocals != null)
                {
                    foreach (var local in additionalLocals)
                    {
                        if (local != null)
                        {
                            binder.scope.TryDeclareVariable(local);
                        }
                    }
                }

                var bound = binder.expressions.BindExpression(expression);
                var type = bound?.Type;
                return type == null || ReferenceEquals(type, TypeSymbol.Error) || ReferenceEquals(type, TypeSymbol.Void)
                    ? null
                    : type;
            }
            finally
            {
                parentScope.SetCurrentDeclaringPackage(previousPackage);
                parentScope.SetCurrentReferencingSyntaxTree(previousTree);
            }
        }
        catch (Exception)
        {
            // Inference must never throw into the editor pipeline.
            return null;
        }
    }

    private BoundExpression BindRichAnonymousObject(
        AnonymousClassExpressionSyntax syntax,
        StructSymbol classSymbol)
    {
        var plans = scope.GetRichAnonymousObjectPlans();
        if (plans.TryGetValue(classSymbol, out var existing))
        {
            return new BoundConstructorCallExpression(syntax, existing.ConstructedType, existing.Arguments);
        }

        var (outerToClassTypeParameters, classToOuterTypeParameters) =
            BuildRichTypeParameterMaps(classSymbol);
        var snapshotFields = ImmutableArray.CreateBuilder<FieldSymbol>();
        var snapshotParameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        var snapshotArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var member in syntax.Members.OfType<AnonymousClassMemberInitializerSyntax>())
        {
            var declaredType = member.TypeClause == null ? null : BindTypeClause(member.TypeClause);
            var value = declaredType == null
                ? Expressions.BindExpression(member.Value)
                : Expressions.BindExpression(member.Value, declaredType);
            if (value is BoundErrorExpression || value.Type == TypeSymbol.Null || value.Type == TypeSymbol.Void)
            {
                if (value is not BoundErrorExpression)
                {
                    Diagnostics.ReportRichAnonymousFieldInference(member.Identifier.Location, member.Identifier.ValueText);
                }

                return new BoundErrorExpression(syntax);
            }

            if (value is BoundVariableExpression receiverValue
                && receiverValue.Variable is ParameterSymbol { IsReceiverParameter: true }
                && value.Type.IsValueType)
            {
                Diagnostics.ReportManagedReference(
                    member.Value.Location,
                    "a borrowed struct receiver cannot be captured; copy it to an ordinary local before the rich object");
                return new BoundErrorExpression(syntax);
            }

            var fieldType = declaredType ?? value.Type;
            if (TypeSymbol.IsByRefLike(fieldType)
                || fieldType is ByRefTypeSymbol or PointerTypeSymbol or FunctionPointerTypeSymbol)
            {
                Diagnostics.ReportByRefLikeEscape(member.Identifier.Location, fieldType, $"be stored in rich anonymous field '{member.Identifier.ValueText}'");
                return new BoundErrorExpression(syntax);
            }

            var definitionFieldType = SubstituteRichType(fieldType, outerToClassTypeParameters);
            var field = classSymbol.Fields.FirstOrDefault(candidate =>
                candidate.Name == member.Identifier.ValueText);
            if (field == null)
            {
                field = new FieldSymbol(
                    member.Identifier.ValueText,
                    definitionFieldType,
                    Accessibility.Public,
                    isReadOnly: member.LetOrVarKeyword.Kind == SyntaxKind.LetKeyword,
                    declaration: member);
            }
            else
            {
                field.SetRichAnonymousType(definitionFieldType);
            }

            snapshotFields.Add(field);
            snapshotParameters.Add(new ParameterSymbol(field.Name, field.Type, declaringSyntax: member.Identifier));
            snapshotArguments.Add(value);
        }

        var baseArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var argument in syntax.BaseConstructorArguments)
        {
            var boundArgument = Expressions.BindExpression(argument);
            if (boundArgument is BoundVariableExpression receiverArgument
                && receiverArgument.Variable is ParameterSymbol { IsReceiverParameter: true }
                && boundArgument.Type.IsValueType)
            {
                Diagnostics.ReportManagedReference(
                    argument.Location,
                    "a borrowed struct receiver cannot be retained as a rich-object base argument; copy it first");
                return new BoundErrorExpression(syntax);
            }

            baseArguments.Add(boundArgument);
        }

        BaseConstructorInitializer? baseInitializer = null;
        if (syntax.HasBaseType)
        {
            baseInitializer = declarations.ResolveRichAnonymousBaseConstructor(
                classSymbol,
                baseArguments.ToImmutable(),
                syntax.BaseConstructorOpenParenthesisToken?.Location ?? syntax.BaseTypeClause?.Location ?? syntax.Location);
        }

        var baseFields = ImmutableArray.CreateBuilder<FieldSymbol>();
        var baseParameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        if (baseInitializer != null)
        {
            var forwarded = ImmutableArray.CreateBuilder<BoundExpression>(baseInitializer.Arguments.Length);
            for (var i = 0; i < baseInitializer.Arguments.Length; i++)
            {
                var argument = baseInitializer.Arguments[i];
                var definitionArgumentType = SubstituteRichType(argument.Type, outerToClassTypeParameters);
                var field = new FieldSymbol($"<>base{i}", definitionArgumentType, Accessibility.Private, isReadOnly: true);
                var parameter = new ParameterSymbol(field.Name, definitionArgumentType);
                baseFields.Add(field);
                baseParameters.Add(parameter);
                forwarded.Add(new BoundVariableExpression(syntax, parameter));
            }

            classSymbol.SetBaseConstructorInitializer(baseInitializer.WithArguments(forwarded.MoveToImmutable()));
        }

        classSymbol.SetInstanceFieldsAndPrimaryConstructorParameters(
            baseFields.Concat(snapshotFields).ToImmutableArray(),
            baseParameters.Concat(snapshotParameters).ToImmutableArray());

        var methodBodies = new Dictionary<FunctionSymbol, BoundBlockStatement>();
        foreach (var method in classSymbol.Methods)
        {
            if (method.IsAbstract || method.Declaration?.Body == null)
            {
                continue;
            }

            var bindingMethod = CreateRichBindingMethod(
                method,
                classToOuterTypeParameters,
                out var bindingParameterMap);
            var child = new Binder(scope, bindingMethod);
            child.binderCtx.FunctionContainsUserGotoOrLabel = StatementBinder.ContainsUserGotoOrLabel(method.Declaration.Body);
            var body = child.statements.BindBlockStatement(method.Declaration.Body);
            child.statements.FinalizeUserLabels();
            var lowered = Lowerer.Lower(body, classSymbol);
            if (bindingParameterMap.Count > 0)
            {
                lowered = (BoundBlockStatement)new RichBindingParameterRewriter(bindingParameterMap)
                    .RewriteStatement(lowered);
            }

            if (method.Type != TypeSymbol.Void && !IsIteratorReturnType(method.Type) && !ControlFlowGraph.AllPathsReturn(lowered))
            {
                child.Diagnostics.ReportAllPathsMustReturn(method.Declaration.Identifier.Location);
            }

            AnalyzeFunctionBody(lowered, method, child.Diagnostics);
            Diagnostics.AddRange(child.Diagnostics.ToImmutableArray());
            methodBodies[method] = lowered;
        }

        var captures = RichAnonymousCaptureCollector.Collect(methodBodies);
        var captureFields = ImmutableArray.CreateBuilder<FieldSymbol>();
        var captureParameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        var captureArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        var captureMap = new Dictionary<VariableSymbol, RichAnonymousCapture>();
        var captureIndex = 0;
        foreach (var variable in captures)
        {
            if (variable is GlobalVariableSymbol)
            {
                continue;
            }

            var borrowedReason = variable switch
            {
                ParameterSymbol { IsReceiverParameter: true } receiver when receiver.Type.IsValueType =>
                    "a borrowed struct receiver cannot be captured by a rich anonymous object; copy it first",
                ParameterSymbol { RefKind: not RefKind.None } =>
                    "ref, in, and out parameters cannot be captured by a rich anonymous object; copy a scalar value or retain an explicit managed handle",
                LocalVariableSymbol { RefKind: not RefKind.None } =>
                    "ref and ref readonly locals cannot be captured by a rich anonymous object; retain an explicit managed handle instead",
                _ => null,
            };
            if (borrowedReason != null)
            {
                Diagnostics.ReportManagedReference(
                    variable.DeclaringSyntax?.Location ?? syntax.Location,
                    borrowedReason);
                return new BoundErrorExpression(syntax);
            }

            if (ManagedReferenceOrigins.IsScopedHandle(variable))
            {
                Diagnostics.ReportManagedReference(
                    variable.DeclaringSyntax?.Location ?? syntax.Location,
                    "a scoped managed handle cannot be captured by a rich anonymous object");
                return new BoundErrorExpression(syntax);
            }

            if (TypeSymbol.IsByRefLike(variable.Type)
                || variable.Type is ByRefTypeSymbol or PointerTypeSymbol or FunctionPointerTypeSymbol)
            {
                Diagnostics.ReportByRefLikeEscape(
                    variable.DeclaringSyntax?.Location ?? syntax.Location,
                    variable.Type,
                    "be captured by a rich anonymous object");
                return new BoundErrorExpression(syntax);
            }

            var mutable = !variable.IsReadOnly;
            TypeSymbol storedType = SubstituteRichType(variable.Type, outerToClassTypeParameters);
            BoundExpression argument = new BoundVariableExpression(syntax, variable);
            if (mutable)
            {
                if (ManagedReferenceOrigins.Rejection(argument) is { } reason)
                {
                    Diagnostics.ReportManagedReference(variable.DeclaringSyntax?.Location ?? syntax.Location, reason);
                    return new BoundErrorExpression(syntax);
                }

                if (!ManagedReferenceTypes.TryResolveDefinition(scope.References, readOnly: false, out var definition))
                {
                    Diagnostics.ReportManagedReference(syntax.Location, "reference the matching Gsharp.Runtime.Values runtime");
                    return new BoundErrorExpression(syntax);
                }

                storedType = ManagedReferenceTypes.Construct(definition, storedType, scope.References);
                var argumentType = ManagedReferenceTypes.Construct(definition, variable.Type, scope.References);
                argument = new BoundManagedReferenceExpression(
                    syntax,
                    ManagedReferenceOrigins.PrepareAliases(argument, scope.References),
                    argumentType,
                    readOnly: false);
            }

            var field = new FieldSymbol(
                $"<>capture{captureIndex++}_{variable.Name}",
                storedType,
                Accessibility.Private,
                isReadOnly: true);
            var parameter = new ParameterSymbol(field.Name, storedType);
            captureFields.Add(field);
            captureParameters.Add(parameter);
            captureArguments.Add(argument);
            captureMap.Add(variable, new RichAnonymousCapture(field, mutable));
        }

        if (syntax.IsData && captureMap.Count > 0)
        {
            Diagnostics.ReportManagedReference(
                syntax.Location,
                "capturing rich data objects require a separate value/equality design; use a plain rich object");
            return new BoundErrorExpression(syntax);
        }

        if (captureMap.Count > 0)
        {
            foreach (var pair in methodBodies.ToArray())
            {
                methodBodies[pair.Key] = (BoundBlockStatement)new RichAnonymousCaptureRewriter(
                    classSymbol,
                    pair.Key,
                    captureMap).RewriteStatement(pair.Value);
            }
        }

        var fields = captureFields
            .Concat(baseFields)
            .Concat(snapshotFields)
            .ToImmutableArray();
        var parameters = captureParameters
            .Concat(baseParameters)
            .Concat(snapshotParameters)
            .ToImmutableArray();
        classSymbol.SetInstanceFieldsAndPrimaryConstructorParameters(fields, parameters);

        var arguments = captureArguments
            .Concat(baseInitializer?.Arguments ?? ImmutableArray<BoundExpression>.Empty)
            .Concat(snapshotArguments)
            .ToImmutableArray();
        var referencedTypes = fields.Select(field => field.Type)
            .Concat(parameters.Select(parameter => parameter.Type))
            .Concat(classSymbol.Methods.SelectMany(method => method.Parameters.Select(parameter => parameter.Type).Append(method.Type)))
            .Concat(classSymbol.Interfaces.Cast<TypeSymbol>());
        var ownMethodTypeParameters = classSymbol.Methods
            .SelectMany(method => method.TypeParameters)
            .ToHashSet(ReferenceEqualityComparer.Instance);
        var referencedTypeParameters = SynthesizedClosureReifier.CollectOrdered(referencedTypes)
            .Where(parameter => !ownMethodTypeParameters.Contains(parameter))
            .ToImmutableArray();
        StructSymbol constructedType;
        var shellTypeParameterCount = classSymbol.Declaration?.RichAnonymousShellTypeParameterCount
            ?? classSymbol.TypeParameters.Length;
        var shellTypeParameters = classSymbol.TypeParameters
            .Take(shellTypeParameterCount)
            .ToImmutableArray();
        if (!shellTypeParameters.IsDefaultOrEmpty
            && classToOuterTypeParameters.Count == shellTypeParameters.Length)
        {
            var argumentsForConstruction = shellTypeParameters
                .Select(parameter => classToOuterTypeParameters[parameter])
                .ToImmutableArray();
            var shellParameters = shellTypeParameters
                .ToHashSet(ReferenceEqualityComparer.Instance);
            var appendedParameters = referencedTypeParameters
                .Where(parameter => !shellParameters.Contains(parameter))
                .ToImmutableArray();
            if (!classSymbol.ReifiedFromTypeParameters.IsDefaultOrEmpty)
            {
                constructedType = StructSymbol.Construct(
                    classSymbol,
                    argumentsForConstruction.AddRange(
                        classSymbol.ReifiedFromTypeParameters.Cast<TypeSymbol>()),
                    scope.References.MapClrTypeToReferences);
            }
            else if (!appendedParameters.IsDefaultOrEmpty)
            {
                constructedType = SynthesizedClosureReifier.ReifyAppending(
                    classSymbol,
                    argumentsForConstruction,
                    appendedParameters,
                    scope.References.MapClrTypeToReferences);
            }
            else
            {
                constructedType = StructSymbol.Construct(
                    classSymbol,
                    argumentsForConstruction,
                    scope.References.MapClrTypeToReferences);
            }
        }
        else
        {
            constructedType = referencedTypeParameters.IsDefaultOrEmpty
                ? classSymbol
                : SynthesizedClosureReifier.Reify(
                    classSymbol,
                    referencedTypeParameters,
                    scope.References.MapClrTypeToReferences);
        }

        var plan = new RichAnonymousObjectPlan(constructedType, arguments, methodBodies);
        plans[classSymbol] = plan;
        return new BoundConstructorCallExpression(syntax, constructedType, arguments);
    }

    private (
        Dictionary<TypeParameterSymbol, TypeSymbol> OuterToClass,
        Dictionary<TypeParameterSymbol, TypeSymbol> ClassToOuter)
        BuildRichTypeParameterMaps(StructSymbol classSymbol)
    {
        var outer = new List<TypeParameterSymbol>();
        if (function?.ReceiverType is StructSymbol receiver)
        {
            if (!receiver.EnclosingTypeArguments.IsDefaultOrEmpty)
            {
                outer.AddRange(receiver.EnclosingTypeArguments.OfType<TypeParameterSymbol>());
            }
            else
            {
                outer.AddRange(StructSymbol.CollectEnclosingTypeParameters(receiver));
            }

            if (!receiver.TypeArguments.IsDefaultOrEmpty)
            {
                outer.AddRange(receiver.TypeArguments.OfType<TypeParameterSymbol>());
            }
            else
            {
                outer.AddRange(receiver.TypeParameters);
            }
        }

        if (function != null)
        {
            outer.AddRange(function.TypeParameters);
        }

        var outerToClass = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        var classToOuter = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        var shellParameterCount = classSymbol.Declaration?.RichAnonymousShellTypeParameterCount
            ?? classSymbol.TypeParameters.Length;
        foreach (var classParameter in classSymbol.TypeParameters.Take(shellParameterCount))
        {
            var match = outer.LastOrDefault(candidate =>
                candidate.Name == classParameter.Name);
            if (match == null)
            {
                continue;
            }

            outerToClass[match] = classParameter;
            classToOuter[classParameter] = match;
        }

        return (outerToClass, classToOuter);
    }

    private TypeSymbol SubstituteRichType(
        TypeSymbol type,
        Dictionary<TypeParameterSymbol, TypeSymbol> substitutions)
        => substitutions.Count == 0
            ? type
            : SubstituteType(type, substitutions, scope.References.MapClrTypeToReferences);

    private static FunctionSymbol CreateRichBindingMethod(
        FunctionSymbol method,
        Dictionary<TypeParameterSymbol, TypeSymbol> classToOuterTypeParameters,
        out Dictionary<VariableSymbol, VariableSymbol> parameterMap)
    {
        parameterMap = new Dictionary<VariableSymbol, VariableSymbol>();
        if (classToOuterTypeParameters.Count == 0)
        {
            return method;
        }

        var parameters = method.Parameters.Select(parameter => new ParameterSymbol(
            parameter.Name,
            StructSymbol.SubstituteTypeParameters(parameter.Type, classToOuterTypeParameters),
            parameter.IsVariadic,
            parameter.DeclaringSyntax,
            parameter.IsScoped,
            parameter.RefKind)).ToImmutableArray();
        var binding = new FunctionSymbol(
            method.Name,
            parameters,
            StructSymbol.SubstituteTypeParameters(method.Type, classToOuterTypeParameters),
            method.Declaration,
            method.Package,
            method.Accessibility,
            method.ReceiverType,
            method.IsOpen,
            method.IsOverride)
        {
            ReturnRefKind = method.ReturnRefKind,
            IsAsync = method.IsAsync,
        };
        binding.TypeParameters = method.TypeParameters;
        for (var i = 0; i < parameters.Length; i++)
        {
            parameterMap[parameters[i]] = method.Parameters[i];
        }

        if (binding.ThisParameter != null && method.ThisParameter != null)
        {
            parameterMap[binding.ThisParameter] = method.ThisParameter;
        }

        return binding;
    }

    private sealed class RichBindingParameterRewriter : BoundTreeRewriter
    {
        private readonly Dictionary<VariableSymbol, VariableSymbol> map;

        internal RichBindingParameterRewriter(Dictionary<VariableSymbol, VariableSymbol> map)
        {
            this.map = map;
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
            => map.TryGetValue(node.Variable, out var replacement)
                ? new BoundVariableExpression(node.Syntax, replacement, node.NarrowedType)
                : node;

        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
            => map.TryGetValue(node.Variable, out var replacement)
                ? new BoundAssignmentExpression(
                    node.Syntax,
                    replacement,
                    RewriteExpression(node.Expression),
                    node.AssignedValueType)
                : base.RewriteAssignmentExpression(node);

        protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
        {
            var body = (BoundBlockStatement)RewriteStatement(node.Body);
            var captures = node.CapturedVariables
                .Select(variable => map.TryGetValue(variable, out var replacement) ? replacement : variable)
                .ToImmutableArray();
            return body == node.Body && captures.SequenceEqual(node.CapturedVariables)
                ? node
                : new BoundFunctionLiteralExpression(
                    node.Syntax,
                    node.Function,
                    node.FunctionType,
                    body,
                    captures);
        }
    }

    private BoundExpression BindStructuralAdaptation(CallExpressionSyntax syntax)
    {
        if (syntax.TypeArgumentList == null || syntax.TypeArgumentList.Arguments.Count != 1)
        {
            Diagnostics.ReportWrongTypeArgumentCount(
                syntax.TypeArgumentList?.Location ?? syntax.Identifier.Location,
                "adapt",
                expectedCount: 1,
                actualCount: syntax.TypeArgumentList?.Arguments.Count ?? 0);
            return new BoundErrorExpression(syntax);
        }

        if (syntax.Arguments.Count != 1)
        {
            Diagnostics.ReportWrongArgumentCount(
                syntax.Identifier.Location,
                "adapt",
                expectedCount: 1,
                actualCount: syntax.Arguments.Count);
            return new BoundErrorExpression(syntax);
        }

        var target = BindTypeClause(syntax.TypeArgumentList.Arguments[0]);
        if (target == null)
        {
            return new BoundErrorExpression(syntax);
        }

        var userTarget = target as InterfaceSymbol;
        var clrTarget = target.ClrType is { IsInterface: true } ? target : null;
        if (userTarget == null && clrTarget == null)
        {
            Diagnostics.ReportStructuralAdaptation(
                syntax.Location,
                "<unknown>",
                target.Name,
                "the target must be an interface");
            return new BoundErrorExpression(syntax);
        }

        var sourceSyntax = syntax.Arguments[0];
        var handleMode = sourceSyntax is RefArgumentExpressionSyntax;
        BoundExpression source;
        TypeSymbol sourceMemberType;
        var readOnlyHandle = false;
        if (sourceSyntax is RefArgumentExpressionSyntax refArgument)
        {
            if (refArgument.RefKindModifier.Text != "ref" || refArgument.Expression == null)
            {
                Diagnostics.ReportStructuralAdaptation(
                    syntax.Location,
                    "<invalid>",
                    target.Name,
                    "persistent-location adaptation requires 'ref' followed by a managed handle");
                return new BoundErrorExpression(syntax);
            }

            source = Expressions.BindExpression(refArgument.Expression);
            if (!ManagedReferenceTypes.TryGetElement(source.Type, out var element, out readOnlyHandle))
            {
                Diagnostics.ReportStructuralAdaptation(
                    syntax.Location,
                    source.Type.Name,
                    target.Name,
                    "the 'ref' operand must have type managed[T] or readonly managed[T]");
                return new BoundErrorExpression(syntax);
            }

            sourceMemberType = element;
            if (!sourceMemberType.IsValueType)
            {
                Diagnostics.ReportStructuralAdaptation(
                    syntax.Location,
                    source.Type.Name,
                    target.Name,
                    "class-valued handles are ambiguous; adapt the explicit dereference instead");
                return new BoundErrorExpression(syntax);
            }

            if (ManagedReferenceOrigins.IsScopedHandle(source))
            {
                Diagnostics.ReportStructuralAdaptation(
                    syntax.Location,
                    source.Type.Name,
                    target.Name,
                    "a scoped managed handle cannot be retained by an adapter");
                return new BoundErrorExpression(syntax);
            }
        }
        else
        {
            source = Expressions.BindExpression(sourceSyntax);
            sourceMemberType = source.Type;
        }

        if (source is BoundErrorExpression)
        {
            return source;
        }

        if (sourceMemberType is NullableTypeSymbol)
        {
            Diagnostics.ReportStructuralAdaptation(
                syntax.Location,
                sourceMemberType.Name,
                target.Name,
                "nullable sources must be narrowed before adaptation");
            return new BoundErrorExpression(syntax);
        }

        if (sourceMemberType is ByRefTypeSymbol or PointerTypeSymbol or FunctionPointerTypeSymbol
            || TypeSymbol.IsByRefLike(sourceMemberType))
        {
            Diagnostics.ReportStructuralAdaptation(
                syntax.Location,
                sourceMemberType.Name,
                target.Name,
                "borrowed and ref-like sources cannot be retained by a heap adapter");
            return new BoundErrorExpression(syntax);
        }

        if (readOnlyHandle && sourceMemberType.ClrType == null)
        {
            Diagnostics.ReportStructuralAdaptation(
                syntax.Location,
                sourceMemberType.Name,
                target.Name,
                "readonly managed-handle adaptation requires metadata-proven readonly source members");
            return new BoundErrorExpression(syntax);
        }

        var registry = scope.GetStructuralAdapterRegistry();
        var packageName = function?.Package?.Name ?? scope.GetCurrentDeclaringPackageName() ?? string.Empty;
        var adapter = new StructSymbol(
            $"<>Adapter{registry.Counter++}",
            ImmutableArray<FieldSymbol>.Empty,
            Accessibility.Internal,
            declaration: null,
            packageName,
            isData: false,
            isInline: false,
            isClass: true);
        if (userTarget != null)
        {
            adapter.SetInterfaces(userTarget.SelfAndAllBaseInterfaces().ToImmutableArray());
        }
        else
        {
            adapter.SetImplementedClrInterfaces(ImmutableArray.Create(target));
        }

        var sourceField = new FieldSymbol(
            "<>source",
            source.Type,
            Accessibility.Private,
            isReadOnly: !sourceMemberType.IsValueType || handleMode);
        var sourceParameter = new ParameterSymbol(sourceField.Name, source.Type);
        adapter.SetInstanceFieldsAndPrimaryConstructorParameters(
            ImmutableArray.Create(sourceField),
            ImmutableArray.Create(sourceParameter));

        var methods = ImmutableArray.CreateBuilder<FunctionSymbol>();
        var properties = ImmutableArray.CreateBuilder<PropertySymbol>();
        var events = ImmutableArray.CreateBuilder<EventSymbol>();
        var failed = false;
        if (userTarget != null)
        {
            var unmatchedDefaults = new List<(InterfaceSymbol Owner, FunctionSymbol Slot)>();
            foreach (var iface in userTarget.SelfAndAllBaseInterfaces())
            {
                iface.EnsureMembersResolved();
                if (!iface.StaticMethods.IsDefaultOrEmpty)
                {
                    Diagnostics.ReportStructuralAdaptation(
                        syntax.Location,
                        sourceMemberType.Name,
                        target.Name,
                        $"interface '{iface.Name}' has static abstract/virtual requirements, which need a separate design");
                    failed = true;
                }

                foreach (var slot in iface.Events)
                {
                    var candidates = TypeMemberModel.EnumerateMembers(
                            sourceMemberType,
                            MemberQuery.Instance(MemberKinds.Event))
                        .OfType<EventSymbol>()
                        .Where(candidate => candidate.Name == slot.Name
                            && candidate.Accessibility == Accessibility.Public
                            && EventContractsMatch(slot, candidate))
                        .ToImmutableArray();
                    if (candidates.Length == 0)
                    {
                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"missing public event '{slot.Name}' with exact add/remove contract");
                        failed = true;
                        continue;
                    }

                    if (candidates.Length > 1)
                    {
                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"event '{slot.Name}' is ambiguous");
                        failed = true;
                        continue;
                    }

                    var generated = CreateUserAdapterEvent(
                        adapter,
                        sourceField,
                        sourceMemberType,
                        handleMode,
                        slot,
                        iface,
                        candidates[0]);
                    events.Add(generated.Event);
                    foreach (var body in generated.Bodies)
                    {
                        registry.MethodBodies[body.Key] = body.Value;
                    }
                }

                foreach (var slot in iface.Properties)
                {
                    var candidates = TypeMemberModel.EnumerateMembers(
                            sourceMemberType,
                            MemberQuery.Instance(MemberKinds.Property))
                        .OfType<PropertySymbol>()
                        .Where(candidate => candidate.Name == slot.Name
                            && candidate.Accessibility == Accessibility.Public
                            && PropertyContractsMatch(slot, candidate))
                        .ToImmutableArray();
                    if (candidates.Length == 0)
                    {
                        var required = slot.GetterSymbol?.IsAbstract == true
                            || slot.SetterSymbol?.IsAbstract == true;
                        if (!required)
                        {
                            continue;
                        }

                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"missing public property/indexer '{slot.Name}' with the required accessor contract");
                        failed = true;
                        continue;
                    }

                    if (candidates.Length > 1)
                    {
                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"property/indexer '{slot.Name}' is ambiguous");
                        failed = true;
                        continue;
                    }

                    var generated = CreateUserAdapterProperty(
                        adapter,
                        sourceField,
                        sourceMemberType,
                        handleMode,
                        slot,
                        iface,
                        candidates[0]);
                    properties.Add(generated.Property);
                    foreach (var body in generated.Bodies)
                    {
                        registry.MethodBodies[body.Key] = body.Value;
                    }
                }

                foreach (var slot in iface.Methods)
                {
                    var candidates = TypeMemberModel
                        .GetMethods(sourceMemberType, slot.Name, MemberQuery.Instance(MemberKinds.Method))
                        .Where(candidate => candidate.Accessibility == Accessibility.Public
                            && MethodContractsMatch(slot, candidate, sourceMemberType))
                        .ToImmutableArray();
                    if (candidates.Length == 0)
                    {
                        if (slot.Declaration?.Body != null)
                        {
                            unmatchedDefaults.Add((iface, slot));
                            continue;
                        }

                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"missing public instance method '{FormatAdapterSlot(slot)}'");
                        failed = true;
                        continue;
                    }

                    if (candidates.Length > 1)
                    {
                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"method '{FormatAdapterSlot(slot)}' is ambiguous");
                        failed = true;
                        continue;
                    }

                    var generated = CreateUserAdapterMethod(
                        syntax,
                        adapter,
                        sourceField,
                        sourceMemberType,
                        handleMode,
                        slot,
                        iface,
                        candidates[0]);
                    methods.Add(generated.Method);
                    registry.MethodBodies[generated.Method] = generated.Body;
                }
            }

            for (var i = 0; i < unmatchedDefaults.Count; i++)
            {
                var current = unmatchedDefaults[i];
                var conflicts = unmatchedDefaults
                    .Where(candidate => UserAdapterSlotsEquivalent(current.Slot, candidate.Slot))
                    .ToArray();
                if (conflicts.Length < 2
                    || !ReferenceEquals(conflicts[0].Slot, current.Slot))
                {
                    continue;
                }

                var mostSpecific = conflicts.Where(candidate =>
                    conflicts.All(other => ReferenceEquals(candidate.Owner, other.Owner)
                        || candidate.Owner.SelfAndAllBaseInterfaces().Contains(other.Owner))).ToArray();
                if (mostSpecific.Length != 1)
                {
                    Diagnostics.ReportStructuralAdaptation(
                        syntax.Location,
                        sourceMemberType.Name,
                        target.Name,
                        $"default interface method '{current.Slot.Name}' has no unique most-specific implementation");
                    failed = true;
                }
            }
        }
        else
        {
            var targetClr = Invariant.Required(target.ClrType, "an imported interface has a CLR type");
            var unmatchedDefaults = new List<(Type Owner, MethodInfo Slot)>();
            var unmatchedDefaultEvents = new List<(Type Owner, EventInfo Slot)>();
            foreach (var targetInterface in targetClr.GetInterfaces().Prepend(targetClr))
            {
                var slotOwner = ClrTypeUtilities.AreSame(targetInterface, targetClr)
                    ? target
                    : TypeSymbol.FromClrType(targetInterface);
                foreach (var slot in targetInterface.GetMethods())
                {
                    if (slot.IsStatic)
                    {
                        if (slot.IsAbstract || slot.IsVirtual)
                        {
                            Diagnostics.ReportStructuralAdaptation(
                                syntax.Location,
                                sourceMemberType.Name,
                                target.Name,
                                $"static interface requirement '{slot.Name}' is unsupported");
                            failed = true;
                        }

                        continue;
                    }

                    if (slot.IsSpecialName)
                    {
                        continue;
                    }

                    if (TryDescribeUnsupportedImportedAdapterConstraints(slot, out var constraintReason))
                    {
                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            constraintReason);
                        failed = true;
                        continue;
                    }

                    var sourceClr = sourceMemberType.ClrType;
                    if (sourceClr == null)
                    {
                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"source method metadata for '{slot.Name}' is unavailable");
                        failed = true;
                        continue;
                    }

                    var candidates = MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces(sourceClr, slot.Name)
                        .Where(candidate => candidate.IsPublic
                            && !candidate.IsStatic
                            && (!readOnlyHandle || RefCapabilities.IsReadOnlyMethod(candidate))
                            && ImportedMethodContractsMatch(slot, candidate))
                        .ToArray();
                    if (candidates.Length == 0)
                    {
                        if (!slot.IsAbstract)
                        {
                            unmatchedDefaults.Add((targetInterface, slot));
                            continue;
                        }

                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"missing public instance method '{slot}'");
                        failed = true;
                        continue;
                    }

                    if (candidates.Length > 1)
                    {
                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"method '{slot}' is ambiguous");
                        failed = true;
                        continue;
                    }

                    var generated = CreateImportedAdapterMethod(
                        adapter,
                        sourceField,
                        sourceMemberType,
                        handleMode,
                        slot,
                        slotOwner,
                        candidates[0]);
                    methods.Add(generated.Method);
                    registry.MethodBodies[generated.Method] = generated.Body;
                }

                foreach (var slot in targetInterface.GetProperties())
                {
                    var sourceClr = sourceMemberType.ClrType;
                    var candidates = sourceClr == null
                        ? Array.Empty<PropertyInfo>()
                        : GetImportedSourceProperties(sourceClr)
                            .Where(candidate => candidate.Name == slot.Name
                                && (!readOnlyHandle
                                    || (!slot.CanWrite
                                        && candidate.GetMethod != null
                                        && RefCapabilities.IsReadOnlyMethod(candidate.GetMethod)))
                                && ImportedPropertyContractsMatch(slot, candidate))
                            .ToArray();
                    var required = (slot.GetMethod?.IsAbstract ?? false) || (slot.SetMethod?.IsAbstract ?? false);
                    if (candidates.Length == 0)
                    {
                        if (!required)
                        {
                            continue;
                        }

                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"missing public property/indexer '{slot.Name}' with the required accessor contract");
                        failed = true;
                        continue;
                    }

                    if (candidates.Length > 1)
                    {
                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"property/indexer '{slot.Name}' is ambiguous");
                        failed = true;
                        continue;
                    }

                    var generated = CreateImportedAdapterProperty(
                        adapter,
                        sourceField,
                        sourceMemberType,
                        handleMode,
                        slot,
                        slotOwner,
                        candidates[0]);
                    properties.Add(generated.Property);
                    foreach (var body in generated.Bodies)
                    {
                        registry.MethodBodies[body.Key] = body.Value;
                    }
                }

                foreach (var slot in targetInterface.GetEvents())
                {
                    var sourceClr = sourceMemberType.ClrType;
                    var candidates = sourceClr == null
                        ? Array.Empty<EventInfo>()
                        : GetImportedSourceEvents(sourceClr)
                            .Where(candidate => candidate.Name == slot.Name
                                && ImportedEventContractsMatch(slot, candidate))
                            .ToArray();
                    if (candidates.Length == 0)
                    {
                        if (slot.AddMethod is { IsAbstract: false }
                            && slot.RemoveMethod is { IsAbstract: false })
                        {
                            unmatchedDefaultEvents.Add((targetInterface, slot));
                            continue;
                        }

                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"missing public event '{slot.Name}' with exact add/remove contract");
                        failed = true;
                        continue;
                    }

                    if (readOnlyHandle)
                    {
                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"readonly managed-handle adaptation cannot forward event '{slot.Name}'");
                        failed = true;
                        continue;
                    }

                    if (candidates.Length > 1)
                    {
                        Diagnostics.ReportStructuralAdaptation(
                            syntax.Location,
                            sourceMemberType.Name,
                            target.Name,
                            $"event '{slot.Name}' is ambiguous");
                        failed = true;
                        continue;
                    }

                    var generated = CreateImportedAdapterEvent(
                        adapter,
                        sourceField,
                        sourceMemberType,
                        handleMode,
                        slot,
                        slotOwner,
                        candidates[0]);
                    events.Add(generated.Event);
                    foreach (var body in generated.Bodies)
                    {
                        registry.MethodBodies[body.Key] = body.Value;
                    }
                }
            }

            for (var i = 0; i < unmatchedDefaults.Count; i++)
            {
                var current = unmatchedDefaults[i];
                var conflicts = unmatchedDefaults
                    .Where(candidate => current.Slot.Name == candidate.Slot.Name
                        && ImportedMethodContractsMatch(current.Slot, candidate.Slot))
                    .ToArray();
                if (conflicts.Length < 2
                    || !ReferenceEquals(conflicts[0].Slot, current.Slot))
                {
                    continue;
                }

                var mostSpecific = conflicts.Where(candidate =>
                    conflicts.All(other => ClrTypeUtilities.AreSame(candidate.Owner, other.Owner)
                        || other.Owner.IsAssignableFrom(candidate.Owner))).ToArray();
                if (mostSpecific.Length != 1)
                {
                    Diagnostics.ReportStructuralAdaptation(
                        syntax.Location,
                        sourceMemberType.Name,
                        target.Name,
                        $"default interface method '{current.Slot.Name}' has no unique most-specific implementation");
                    failed = true;
                }
            }

            for (var i = 0; i < unmatchedDefaultEvents.Count; i++)
            {
                var current = unmatchedDefaultEvents[i];
                var conflicts = unmatchedDefaultEvents
                    .Where(candidate => ImportedEventSlotsEquivalent(current.Slot, candidate.Slot))
                    .ToArray();
                if (conflicts.Length < 2
                    || !ReferenceEquals(conflicts[0].Slot, current.Slot))
                {
                    continue;
                }

                var mostSpecific = conflicts.Where(candidate =>
                    conflicts.All(other => ClrTypeUtilities.AreSame(candidate.Owner, other.Owner)
                        || other.Owner.IsAssignableFrom(candidate.Owner))).ToArray();
                if (mostSpecific.Length != 1)
                {
                    Diagnostics.ReportStructuralAdaptation(
                        syntax.Location,
                        sourceMemberType.Name,
                        target.Name,
                        $"default interface event '{current.Slot.Name}' has no unique most-specific implementation");
                    failed = true;
                }
            }
        }

        if (failed)
        {
            return new BoundErrorExpression(syntax);
        }

        adapter.SetMethods(methods.ToImmutable());
        adapter.SetProperties(properties.ToImmutable());
        adapter.SetEvents(events.ToImmutable());
        var adapterReferencedTypes = adapter.Fields.Select(field => field.Type)
            .Concat(adapter.Methods.SelectMany(method => method.Parameters.Select(parameter => parameter.Type).Append(method.Type)))
            .Concat(adapter.Interfaces.Cast<TypeSymbol>())
            .Concat(adapter.ImplementedClrInterfaces);
        var adapterMethodTypeParameters = adapter.Methods
            .SelectMany(method => method.TypeParameters)
            .ToHashSet(ReferenceEqualityComparer.Instance);
        var adapterTypeParameters = SynthesizedClosureReifier.CollectOrdered(adapterReferencedTypes)
            .Where(parameter => !adapterMethodTypeParameters.Contains(parameter))
            .ToImmutableArray();
        var constructedAdapter = adapterTypeParameters.IsDefaultOrEmpty
            ? adapter
            : SynthesizedClosureReifier.Reify(
                adapter,
                adapterTypeParameters,
                scope.References.MapClrTypeToReferences);
        registry.Types.Add(adapter);
        if (!handleMode && IsReferenceTypeForConstraint(sourceMemberType))
        {
            var saved = new LocalVariableSymbol($"<>adaptSource{registry.Counter}", isReadOnly: true, source.Type);
            var read = new BoundVariableExpression(syntax, saved);
            var throwIfNull = Invariant.Required(
                typeof(ArgumentNullException).GetMethod(
                    nameof(ArgumentNullException.ThrowIfNull),
                    new[] { typeof(object), typeof(string) }),
                "ArgumentNullException.ThrowIfNull(object, string) is available");
            var check = new BoundClrStaticCallExpression(
                syntax,
                throwIfNull,
                TypeSymbol.Void,
                ImmutableArray.Create<BoundExpression>(
                    new BoundConversionExpression(syntax, TypeSymbol.Object, read),
                    new BoundLiteralExpression(syntax, "source")));
            var construction = new BoundConstructorCallExpression(
                syntax,
                constructedAdapter,
                ImmutableArray.Create<BoundExpression>(read));
            return new BoundBlockExpression(
                syntax,
                ImmutableArray.Create<BoundStatement>(
                    new BoundVariableDeclaration(syntax, saved, source),
                    new BoundExpressionStatement(syntax, check)),
                new BoundConversionExpression(syntax, target, construction));
        }

        return new BoundConversionExpression(
            syntax,
            target,
            new BoundConstructorCallExpression(
                syntax,
                constructedAdapter,
                ImmutableArray.Create(source)));
    }

    private static (FunctionSymbol Method, BoundBlockStatement Body) CreateUserAdapterMethod(
        SyntaxNode syntax,
        StructSymbol adapter,
        FieldSymbol sourceField,
        TypeSymbol sourceMemberType,
        bool handleMode,
        FunctionSymbol slot,
        InterfaceSymbol slotOwner,
        FunctionSymbol sourceMethod)
    {
        var parameters = slot.Parameters.Select(parameter => new ParameterSymbol(
            parameter.Name,
            parameter.Type,
            parameter.IsVariadic,
            isScoped: parameter.IsScoped,
            refKind: parameter.RefKind)).ToImmutableArray();
        var method = new FunctionSymbol(
            slot.Name,
            parameters,
            slot.Type,
            declaration: null,
            slot.Package,
            Accessibility.Private,
            adapter)
        {
            ReturnRefKind = slot.ReturnRefKind,
            ExplicitInterfaceMember = slot,
            ExplicitInterfaceClauseTarget = slotOwner,
        };
        if (slot.HasUnscopedRef)
        {
            method.MarkUnscopedRef();
        }

        method.TypeParameters = slot.TypeParameters;
        var receiver = AdapterSourceReceiver(adapter, method, sourceField, sourceMemberType, handleMode);
        var arguments = parameters.Select(parameter => (BoundExpression)new BoundVariableExpression(syntax, parameter)).ToImmutableArray();
        var call = new BoundUserInstanceCallExpression(syntax, receiver, sourceMethod, arguments, slot.Type)
        {
            MethodTypeArguments = slot.TypeParameters.Cast<TypeSymbol>().ToImmutableArray(),
        };
        return (method, AdapterMethodBody(call, slot.Type, slot.ReturnRefKind));
    }

    private static (FunctionSymbol Method, BoundBlockStatement Body) CreateImportedAdapterMethod(
        StructSymbol adapter,
        FieldSymbol sourceField,
        TypeSymbol sourceMemberType,
        bool handleMode,
        MethodInfo slot,
        TypeSymbol slotOwner,
        MethodInfo sourceMethod)
    {
        var slotParameters = slot.GetParameters();
        var typeParameterMap = new Dictionary<Type, TypeSymbol>();
        var typeParameters = ImmutableArray<TypeParameterSymbol>.Empty;
        if (slot.IsGenericMethodDefinition)
        {
            var builder = ImmutableArray.CreateBuilder<TypeParameterSymbol>();
            foreach (var parameter in slot.GetGenericArguments())
            {
                var generated = new TypeParameterSymbol(
                    parameter.Name,
                    parameter.GenericParameterPosition,
                    TypeParameterConstraint.Any,
                    TypeParameterVariance.None);
                builder.Add(generated);
                typeParameterMap[parameter] = generated;
            }

            typeParameters = builder.ToImmutable();
            ApplyImportedGenericConstraints(slot.GetGenericArguments(), typeParameters, typeParameterMap);
        }

        var parameters = slotParameters.Select(parameter =>
        {
            var rawType = parameter.ParameterType.IsByRef
                ? RequiredAdapterElementType(parameter.ParameterType)
                : parameter.ParameterType;
            var annotatedType = ClrNullability.GetParameterTypeSymbol(parameter);
            if (annotatedType is ByRefTypeSymbol annotatedByRef)
            {
                annotatedType = annotatedByRef.PointeeType;
            }

            return new ParameterSymbol(
                parameter.Name ?? $"arg{parameter.Position}",
                MapAdapterMethodTypeWithNullability(rawType, annotatedType, typeParameterMap),
                isScoped: IsAdapterScoped(parameter),
                refKind: GetAdapterRefKind(parameter));
        }).ToImmutableArray();
        var rawReturnType = slot.ReturnType.IsByRef
            ? RequiredAdapterElementType(slot.ReturnType)
            : slot.ReturnType;
        var annotatedReturnType = ClrNullability.GetReturnTypeSymbol(slot);
        if (annotatedReturnType is ByRefTypeSymbol annotatedByRefReturn)
        {
            annotatedReturnType = annotatedByRefReturn.PointeeType;
        }

        var returnType = MapAdapterMethodTypeWithNullability(
            rawReturnType,
            annotatedReturnType,
            typeParameterMap);
        if (returnType is ByRefTypeSymbol byRefReturn)
        {
            returnType = byRefReturn.PointeeType;
        }

        var method = new FunctionSymbol(
            slot.Name,
            parameters,
            returnType,
            declaration: null,
            package: null,
            Accessibility.Private,
            adapter)
        {
            ReturnRefKind = RefCapabilities.GetReturnRefKind(slot),
            ExplicitInterfaceSlot = slot,
            ExplicitInterfaceSlotContainingType = slotOwner,
        };
        if (HasAdapterUnscopedRef(slot.ReturnParameter))
        {
            method.MarkUnscopedRef();
        }

        method.TypeParameters = typeParameters;
        var receiver = AdapterSourceReceiver(adapter, method, sourceField, sourceMemberType, handleMode);
        var arguments = parameters.Select(parameter => (BoundExpression)new BoundVariableExpression(null, parameter)).ToImmutableArray();
        var callableSourceMethod = sourceMethod.IsGenericMethodDefinition
            ? sourceMethod.MakeGenericMethod(sourceMethod.GetGenericArguments())
            : sourceMethod;
        var call = new BoundImportedInstanceCallExpression(
            null,
            receiver,
            callableSourceMethod,
            returnType,
            arguments,
            callableSourceMethod.GetParameters().Select(GetAdapterRefKind).ToImmutableArray(),
            typeArgumentSymbols: typeParameters.Cast<TypeSymbol?>().ToImmutableArray());
        return (method, AdapterMethodBody(call, returnType, method.ReturnRefKind));
    }

    private static (PropertySymbol Property, Dictionary<FunctionSymbol, BoundBlockStatement> Bodies) CreateUserAdapterProperty(
        StructSymbol adapter,
        FieldSymbol sourceField,
        TypeSymbol sourceMemberType,
        bool handleMode,
        PropertySymbol slot,
        InterfaceSymbol slotOwner,
        PropertySymbol sourceProperty)
    {
        var indexParameters = slot.Parameters.Select(parameter => new ParameterSymbol(
            parameter.Name,
            parameter.Type,
            parameter.IsVariadic,
            isScoped: parameter.IsScoped,
            refKind: parameter.RefKind)).ToImmutableArray();
        var property = new PropertySymbol(
            slot.Name,
            slot.Type,
            Accessibility.Private,
            slot.HasGetter,
            slot.HasSetter,
            isAutoProperty: false,
            isVirtual: false,
            isOverride: false,
            setterParameterName: slot.SetterParameterName)
        {
            IsIndexer = slot.IsIndexer,
            Parameters = indexParameters,
            ReturnRefKind = slot.ReturnRefKind,
            ExplicitInterfaceMember = slot,
            ExplicitInterfaceClauseTarget = slotOwner,
        };
        var bodies = new Dictionary<FunctionSymbol, BoundBlockStatement>();
        if (slot.HasGetter)
        {
            var getter = new FunctionSymbol(
                $"get_{slot.Name}",
                indexParameters,
                slot.Type,
                declaration: null,
                slot.GetterSymbol?.Package,
                Accessibility.Private,
                adapter)
            {
                ReturnRefKind = slot.ReturnRefKind,
                IsSpecialName = true,
            };
            if (slot.GetterSymbol?.HasUnscopedRef == true)
            {
                getter.MarkUnscopedRef();
            }

            property.GetterSymbol = getter;
            var receiver = AdapterSourceReceiver(adapter, getter, sourceField, sourceMemberType, handleMode);
            BoundExpression access = slot.IsIndexer
                ? new BoundUserInstanceCallExpression(
                    null,
                    receiver,
                    Invariant.Required(sourceProperty.GetterSymbol, "a matched getter contract has a source getter"),
                    indexParameters.Select(parameter => (BoundExpression)new BoundVariableExpression(null, parameter)).ToImmutableArray(),
                    slot.Type)
                : new BoundPropertyAccessExpression(
                    null,
                    receiver,
                    sourceMemberType as StructSymbol,
                    sourceProperty,
                    substitutedType: null,
                    narrowedType: null,
                    interfaceType: sourceMemberType as InterfaceSymbol);
            bodies[getter] = AdapterMethodBody(access, slot.Type, slot.ReturnRefKind);
        }

        if (slot.HasSetter)
        {
            var value = new ParameterSymbol(slot.SetterParameterName, slot.Type);
            var setterParameters = indexParameters.Add(value);
            var setter = new FunctionSymbol(
                $"set_{slot.Name}",
                setterParameters,
                TypeSymbol.Void,
                declaration: null,
                slot.SetterSymbol?.Package,
                Accessibility.Private,
                adapter)
            {
                IsSpecialName = true,
                IsInitOnlySetter = slot.IsInitOnly,
            };
            property.SetterSymbol = setter;
            var receiver = AdapterSourceReceiver(adapter, setter, sourceField, sourceMemberType, handleMode);
            BoundExpression assignment = slot.IsIndexer
                ? new BoundUserInstanceCallExpression(
                    null,
                    receiver,
                    Invariant.Required(sourceProperty.SetterSymbol, "a matched setter contract has a source setter"),
                    indexParameters
                        .Select(parameter => (BoundExpression)new BoundVariableExpression(null, parameter))
                        .Append(new BoundVariableExpression(null, value))
                        .ToImmutableArray(),
                    TypeSymbol.Void)
                : new BoundPropertyAssignmentExpression(
                    null,
                    receiver,
                    sourceMemberType as StructSymbol,
                    sourceProperty,
                    new BoundVariableExpression(null, value),
                    substitutedType: null,
                    interfaceType: sourceMemberType as InterfaceSymbol);
            bodies[setter] = AdapterMethodBody(assignment, TypeSymbol.Void);
        }

        return (property, bodies);
    }

    private static (PropertySymbol Property, Dictionary<FunctionSymbol, BoundBlockStatement> Bodies) CreateImportedAdapterProperty(
        StructSymbol adapter,
        FieldSymbol sourceField,
        TypeSymbol sourceMemberType,
        bool handleMode,
        PropertyInfo slot,
        TypeSymbol slotOwner,
        PropertyInfo sourceProperty)
    {
        var slotParameters = slot.GetIndexParameters();
        var indexParameters = slotParameters.Select(parameter => new ParameterSymbol(
            parameter.Name ?? $"arg{parameter.Position}",
            ClrNullability.GetParameterTypeSymbol(parameter),
            isScoped: IsAdapterScoped(parameter),
            refKind: GetAdapterRefKind(parameter))).ToImmutableArray();
        var propertyType = ClrNullability.GetPropertyTypeSymbol(slot);
        if (propertyType is ByRefTypeSymbol byRefType)
        {
            propertyType = byRefType.PointeeType;
        }

        var property = new PropertySymbol(
            slot.Name,
            propertyType,
            Accessibility.Private,
            slot.CanRead,
            slot.CanWrite,
            isAutoProperty: false,
            isVirtual: false,
            isOverride: false,
            isInitOnly: slot.SetMethod != null && IsAdapterInitOnly(slot.SetMethod))
        {
            IsIndexer = slotParameters.Length > 0,
            Parameters = indexParameters,
            ReturnRefKind = slot.GetMethod == null ? RefKind.None : RefCapabilities.GetReturnRefKind(slot.GetMethod),
            ExplicitInterfaceGetterSlot = slot.GetMethod,
            ExplicitInterfaceSetterSlot = slot.SetMethod,
            ExplicitInterfaceSlotContainingType = slotOwner,
        };
        var bodies = new Dictionary<FunctionSymbol, BoundBlockStatement>();
        if (slot.GetMethod != null)
        {
            var getter = new FunctionSymbol(
                $"get_{slot.Name}",
                indexParameters,
                propertyType,
                declaration: null,
                package: null,
                Accessibility.Private,
                adapter)
            {
                ReturnRefKind = property.ReturnRefKind,
                IsSpecialName = true,
            };
            if (HasAdapterUnscopedRef(slot.GetMethod.ReturnParameter))
            {
                getter.MarkUnscopedRef();
            }

            property.GetterSymbol = getter;
            var receiver = AdapterSourceReceiver(adapter, getter, sourceField, sourceMemberType, handleMode);
            BoundExpression access = property.IsIndexer
                ? new BoundClrIndexExpression(
                    null,
                    receiver,
                    sourceProperty,
                    indexParameters.Select(parameter => (BoundExpression)new BoundVariableExpression(null, parameter)).ToImmutableArray(),
                    propertyType)
                : new BoundClrPropertyAccessExpression(
                    null,
                    receiver,
                    sourceProperty,
                    propertyType,
                    staticContainerType: sourceMemberType);
            bodies[getter] = AdapterMethodBody(access, propertyType, property.ReturnRefKind);
        }

        if (slot.SetMethod != null)
        {
            var value = new ParameterSymbol("value", propertyType);
            var setter = new FunctionSymbol(
                $"set_{slot.Name}",
                indexParameters.Add(value),
                TypeSymbol.Void,
                declaration: null,
                package: null,
                Accessibility.Private,
                adapter)
            {
                IsSpecialName = true,
                IsInitOnlySetter = property.IsInitOnly,
            };
            property.SetterSymbol = setter;
            var receiver = AdapterSourceReceiver(adapter, setter, sourceField, sourceMemberType, handleMode);
            BoundExpression assignment = property.IsIndexer
                ? BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    null,
                    receiver,
                    sourceProperty,
                    indexParameters.Select(parameter => (BoundExpression)new BoundVariableExpression(null, parameter)).ToImmutableArray(),
                    new BoundVariableExpression(null, value),
                    propertyType)
                : new BoundClrPropertyAssignmentExpression(
                    null,
                    receiver,
                    sourceProperty,
                    new BoundVariableExpression(null, value),
                    propertyType,
                    staticContainerType: sourceMemberType);
            bodies[setter] = AdapterMethodBody(assignment, TypeSymbol.Void);
        }

        return (property, bodies);
    }

    private static (EventSymbol Event, Dictionary<FunctionSymbol, BoundBlockStatement> Bodies) CreateUserAdapterEvent(
        StructSymbol adapter,
        FieldSymbol sourceField,
        TypeSymbol sourceMemberType,
        bool handleMode,
        EventSymbol slot,
        InterfaceSymbol slotOwner,
        EventSymbol sourceEvent)
    {
        var eventSymbol = new EventSymbol(
            slot.Name,
            slot.Type,
            Accessibility.Private,
            isFieldLike: false,
            isVirtual: false,
            isOverride: false)
        {
            ExplicitInterfaceMember = slot,
            ExplicitInterfaceClauseTarget = slotOwner,
        };
        var bodies = new Dictionary<FunctionSymbol, BoundBlockStatement>();
        if (slot.AddMethodSymbol != null && sourceEvent.AddMethodSymbol != null)
        {
            var parameter = new ParameterSymbol("value", slot.Type);
            var add = new FunctionSymbol(
                $"add_{slot.Name}",
                ImmutableArray.Create(parameter),
                TypeSymbol.Void,
                declaration: null,
                slot.AddMethodSymbol.Package,
                Accessibility.Private,
                adapter)
            {
                IsSpecialName = true,
            };
            eventSymbol.AddMethodSymbol = add;
            var receiver = AdapterSourceReceiver(adapter, add, sourceField, sourceMemberType, handleMode);
            var call = new BoundEventSubscriptionExpression(
                null,
                receiver,
                sourceMemberType,
                sourceEvent,
                new BoundVariableExpression(null, parameter),
                isAdd: true);
            bodies[add] = AdapterMethodBody(call, TypeSymbol.Void);
        }

        if (slot.RemoveMethodSymbol != null && sourceEvent.RemoveMethodSymbol != null)
        {
            var parameter = new ParameterSymbol("value", slot.Type);
            var remove = new FunctionSymbol(
                $"remove_{slot.Name}",
                ImmutableArray.Create(parameter),
                TypeSymbol.Void,
                declaration: null,
                slot.RemoveMethodSymbol.Package,
                Accessibility.Private,
                adapter)
            {
                IsSpecialName = true,
            };
            eventSymbol.RemoveMethodSymbol = remove;
            var receiver = AdapterSourceReceiver(adapter, remove, sourceField, sourceMemberType, handleMode);
            var call = new BoundEventSubscriptionExpression(
                null,
                receiver,
                sourceMemberType,
                sourceEvent,
                new BoundVariableExpression(null, parameter),
                isAdd: false);
            bodies[remove] = AdapterMethodBody(call, TypeSymbol.Void);
        }

        return (eventSymbol, bodies);
    }

    private static (EventSymbol Event, Dictionary<FunctionSymbol, BoundBlockStatement> Bodies) CreateImportedAdapterEvent(
        StructSymbol adapter,
        FieldSymbol sourceField,
        TypeSymbol sourceMemberType,
        bool handleMode,
        EventInfo slot,
        TypeSymbol slotOwner,
        EventInfo sourceEvent)
    {
        var eventType = TypeSymbol.FromClrType(Invariant.Required(slot.EventHandlerType, "an event has a handler type"));
        var eventSymbol = new EventSymbol(
            slot.Name,
            eventType,
            Accessibility.Private,
            isFieldLike: false,
            isVirtual: false,
            isOverride: false)
        {
            ExplicitInterfaceAddSlot = slot.AddMethod,
            ExplicitInterfaceRemoveSlot = slot.RemoveMethod,
            ExplicitInterfaceSlotContainingType = slotOwner,
        };
        var bodies = new Dictionary<FunctionSymbol, BoundBlockStatement>();
        if (slot.AddMethod != null && sourceEvent.AddMethod != null)
        {
            var parameter = new ParameterSymbol("value", eventType);
            var add = new FunctionSymbol(
                $"add_{slot.Name}",
                ImmutableArray.Create(parameter),
                TypeSymbol.Void,
                declaration: null,
                package: null,
                Accessibility.Private,
                adapter)
            {
                IsSpecialName = true,
            };
            eventSymbol.AddMethodSymbol = add;
            var receiver = AdapterSourceReceiver(adapter, add, sourceField, sourceMemberType, handleMode);
            var call = new BoundClrEventSubscriptionExpression(
                null,
                receiver,
                sourceEvent,
                new BoundVariableExpression(null, parameter),
                isAdd: true,
                eventContainingType: sourceMemberType);
            bodies[add] = AdapterMethodBody(call, TypeSymbol.Void);
        }

        if (slot.RemoveMethod != null && sourceEvent.RemoveMethod != null)
        {
            var parameter = new ParameterSymbol("value", eventType);
            var remove = new FunctionSymbol(
                $"remove_{slot.Name}",
                ImmutableArray.Create(parameter),
                TypeSymbol.Void,
                declaration: null,
                package: null,
                Accessibility.Private,
                adapter)
            {
                IsSpecialName = true,
            };
            eventSymbol.RemoveMethodSymbol = remove;
            var receiver = AdapterSourceReceiver(adapter, remove, sourceField, sourceMemberType, handleMode);
            var call = new BoundClrEventSubscriptionExpression(
                null,
                receiver,
                sourceEvent,
                new BoundVariableExpression(null, parameter),
                isAdd: false,
                eventContainingType: sourceMemberType);
            bodies[remove] = AdapterMethodBody(call, TypeSymbol.Void);
        }

        return (eventSymbol, bodies);
    }

    private static BoundExpression AdapterSourceReceiver(
        StructSymbol adapter,
        FunctionSymbol method,
        FieldSymbol sourceField,
        TypeSymbol sourceMemberType,
        bool handleMode)
    {
        var field = new BoundFieldAccessExpression(
            null,
            new BoundVariableExpression(null, Invariant.Required(method.ThisParameter, "adapter methods have a receiver")),
            adapter,
            sourceField);
        return handleMode
            ? new BoundDereferenceExpression(null, ManagedReferenceTypes.Borrow(field))
            : field;
    }

    private static BoundBlockStatement AdapterMethodBody(
        BoundExpression call,
        TypeSymbol returnType,
        RefKind returnRefKind = RefKind.None)
    {
        if (returnRefKind != RefKind.None)
        {
            return new BoundBlockStatement(
                null,
                ImmutableArray.Create<BoundStatement>(
                    new BoundReturnStatement(
                        null,
                        new BoundAddressOfExpression(
                            null,
                            call,
                            unmanaged: false,
                            isReadOnly: returnRefKind == RefKind.RefReadOnly),
                        isRef: true)));
        }

        var statements = returnType == TypeSymbol.Void
            ? ImmutableArray.Create<BoundStatement>(
                new BoundExpressionStatement(null, call),
                new BoundReturnStatement(null, null))
            : ImmutableArray.Create<BoundStatement>(new BoundReturnStatement(null, call));
        return new BoundBlockStatement(null, statements);
    }

    private bool MethodContractsMatch(
        FunctionSymbol target,
        FunctionSymbol source,
        TypeSymbol sourceContainingType)
    {
        if (target.TypeParameters.Length != source.TypeParameters.Length
            || target.Parameters.Length != source.Parameters.Length
            || target.ReturnRefKind != source.ReturnRefKind
            || target.HasUnscopedRef != source.HasUnscopedRef)
        {
            return false;
        }

        var substitutions = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        if (sourceContainingType is StructSymbol sourceConstruction
            && sourceConstruction.Definition is { } sourceDefinition
            && !sourceConstruction.TypeArguments.IsDefaultOrEmpty)
        {
            for (var i = 0; i < sourceDefinition.TypeParameters.Length
                && i < sourceConstruction.TypeArguments.Length; i++)
            {
                substitutions[sourceDefinition.TypeParameters[i]] = sourceConstruction.TypeArguments[i];
            }
        }

        for (var i = 0; i < target.TypeParameters.Length; i++)
        {
            substitutions[source.TypeParameters[i]] = target.TypeParameters[i];
        }

        for (var i = 0; i < target.TypeParameters.Length; i++)
        {
            if (!AdapterGenericConstraintsMatch(target.TypeParameters[i], source.TypeParameters[i], substitutions))
            {
                return false;
            }
        }

        if (!AdapterTypesMatch(
                target.Type,
                SubstituteType(source.Type, substitutions, scope.References.MapClrTypeToReferences)))
        {
            return false;
        }

        for (var i = 0; i < target.Parameters.Length; i++)
        {
            if (target.Parameters[i].RefKind != source.Parameters[i].RefKind
                || target.Parameters[i].IsScoped != source.Parameters[i].IsScoped
                || !AdapterTypesMatch(
                    target.Parameters[i].Type,
                    SubstituteType(source.Parameters[i].Type, substitutions, scope.References.MapClrTypeToReferences)))
            {
                return false;
            }
        }

        return true;
    }

    private static bool UserAdapterSlotsEquivalent(FunctionSymbol left, FunctionSymbol right)
    {
        if (left.Name != right.Name
            || left.TypeParameters.Length != right.TypeParameters.Length
            || left.Parameters.Length != right.Parameters.Length
            || left.ReturnRefKind != right.ReturnRefKind
            || left.HasUnscopedRef != right.HasUnscopedRef
            || !AdapterTypesMatch(left.Type, right.Type))
        {
            return false;
        }

        for (var i = 0; i < left.Parameters.Length; i++)
        {
            if (left.Parameters[i].RefKind != right.Parameters[i].RefKind
                || !AdapterTypesMatch(left.Parameters[i].Type, right.Parameters[i].Type))
            {
                return false;
            }
        }

        return true;
    }

    private bool AdapterGenericConstraintsMatch(
        TypeParameterSymbol target,
        TypeParameterSymbol source,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol> substitutions)
    {
        if (target.Constraint != source.Constraint
            || target.HasReferenceTypeConstraint != source.HasReferenceTypeConstraint
            || target.HasValueTypeConstraint != source.HasValueTypeConstraint
            || target.HasDefaultConstructorConstraint != source.HasDefaultConstructorConstraint
            || target.HasUnmanagedConstraint != source.HasUnmanagedConstraint)
        {
            return false;
        }

        var targetReference = target.ConstraintReferenceType;
        var sourceReference = source.ConstraintReferenceType;
        if (targetReference == null || sourceReference == null)
        {
            return targetReference == null && sourceReference == null;
        }

        return AdapterTypesMatch(
            targetReference,
            SubstituteType(
                sourceReference,
                new Dictionary<TypeParameterSymbol, TypeSymbol>(substitutions),
                scope.References.MapClrTypeToReferences));
    }

    private static bool ImportedMethodContractsMatch(MethodInfo target, MethodInfo source)
    {
        if (target.IsGenericMethodDefinition != source.IsGenericMethodDefinition
            || target.GetGenericArguments().Length != source.GetGenericArguments().Length
            || RefCapabilities.GetReturnRefKind(target) != RefCapabilities.GetReturnRefKind(source)
            || !AdapterParameterMetadataSupported(target.ReturnParameter)
            || !AdapterParameterMetadataSupported(source.ReturnParameter)
            || !AdapterParameterMetadataMatches(target.ReturnParameter, source.ReturnParameter)
            || !ImportedAdapterTypesMatch(target.ReturnType, source.ReturnType)
            || !ImportedMethodNullabilityMatches(target, source)
            || !ImportedGenericConstraintsMatch(target, source))
        {
            return false;
        }

        var targetParameters = target.GetParameters();
        var sourceParameters = source.GetParameters();
        if (targetParameters.Length != sourceParameters.Length)
        {
            return false;
        }

        for (var i = 0; i < targetParameters.Length; i++)
        {
            if (GetAdapterRefKind(targetParameters[i]) != GetAdapterRefKind(sourceParameters[i])
                || IsAdapterScoped(targetParameters[i]) != IsAdapterScoped(sourceParameters[i])
                || !AdapterParameterMetadataSupported(targetParameters[i])
                || !AdapterParameterMetadataSupported(sourceParameters[i])
                || !AdapterParameterMetadataMatches(targetParameters[i], sourceParameters[i])
                || !ImportedAdapterTypesMatch(
                    targetParameters[i].ParameterType,
                    sourceParameters[i].ParameterType))
            {
                return false;
            }
        }

        return true;
    }

    private static bool ImportedGenericConstraintsMatch(MethodInfo target, MethodInfo source)
    {
        var targetParameters = target.GetGenericArguments();
        var sourceParameters = source.GetGenericArguments();
        for (var i = 0; i < targetParameters.Length; i++)
        {
            const GenericParameterAttributes specialMask = GenericParameterAttributes.SpecialConstraintMask;
            if ((targetParameters[i].GenericParameterAttributes & specialMask)
                != (sourceParameters[i].GenericParameterAttributes & specialMask))
            {
                return false;
            }

            if (HasAdapterUnmanagedConstraint(targetParameters[i])
                != HasAdapterUnmanagedConstraint(sourceParameters[i]))
            {
                return false;
            }

            var targetConstraints = targetParameters[i].GetGenericParameterConstraints();
            var sourceConstraints = sourceParameters[i].GetGenericParameterConstraints();
            if (targetConstraints.Length != sourceConstraints.Length)
            {
                return false;
            }

            foreach (var targetConstraint in targetConstraints)
            {
                if (!sourceConstraints.Any(sourceConstraint => ImportedAdapterTypesMatch(targetConstraint, sourceConstraint)))
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static bool TryDescribeUnsupportedImportedAdapterConstraints(
        MethodInfo method,
        [NotNullWhen(true)] out string? reason)
    {
        foreach (var parameter in method.GetGenericArguments())
        {
            var interfaceBounds = parameter.GetGenericParameterConstraints()
                .Count(constraint => constraint.IsInterface);
            if (interfaceBounds > 1)
            {
                reason =
                    $"generic method '{method.Name}' type parameter '{parameter.Name}' has {interfaceBounds} interface bounds; exact adapter metadata currently supports at most one";
                return true;
            }
        }

        reason = null;
        return false;
    }

    private static bool ImportedMethodNullabilityMatches(MethodInfo target, MethodInfo source)
    {
        var targetGenericParameters = target.GetGenericArguments();
        var sourceGenericParameters = source.GetGenericArguments();
        var canonical = ImmutableArray.CreateBuilder<TypeParameterSymbol>(targetGenericParameters.Length);
        var targetMap = new Dictionary<Type, TypeSymbol>();
        var sourceMap = new Dictionary<Type, TypeSymbol>();
        for (var i = 0; i < targetGenericParameters.Length; i++)
        {
            var parameter = new TypeParameterSymbol(
                targetGenericParameters[i].Name,
                i,
                TypeParameterConstraint.Any,
                TypeParameterVariance.None)
            {
                IsMethodTypeParameter = true,
            };
            canonical.Add(parameter);
            targetMap[targetGenericParameters[i]] = parameter;
            sourceMap[sourceGenericParameters[i]] = parameter;
        }

        var targetReturn = ClrNullability.GetReturnTypeSymbol(target);
        var sourceReturn = ClrNullability.GetReturnTypeSymbol(source);
        var targetRawReturn = target.ReturnType.IsByRef
            ? RequiredAdapterElementType(target.ReturnType)
            : target.ReturnType;
        var sourceRawReturn = source.ReturnType.IsByRef
            ? RequiredAdapterElementType(source.ReturnType)
            : source.ReturnType;
        if (targetReturn is ByRefTypeSymbol targetByRef)
        {
            targetReturn = targetByRef.PointeeType;
        }

        if (sourceReturn is ByRefTypeSymbol sourceByRef)
        {
            sourceReturn = sourceByRef.PointeeType;
        }

        if (!AdapterTypesMatch(
                MapAdapterMethodTypeWithNullability(targetRawReturn, targetReturn, targetMap),
                MapAdapterMethodTypeWithNullability(sourceRawReturn, sourceReturn, sourceMap)))
        {
            return false;
        }

        var targetParameters = target.GetParameters();
        var sourceParameters = source.GetParameters();
        for (var i = 0; i < targetParameters.Length; i++)
        {
            var targetRaw = targetParameters[i].ParameterType.IsByRef
                ? RequiredAdapterElementType(targetParameters[i].ParameterType)
                : targetParameters[i].ParameterType;
            var sourceRaw = sourceParameters[i].ParameterType.IsByRef
                ? RequiredAdapterElementType(sourceParameters[i].ParameterType)
                : sourceParameters[i].ParameterType;
            var targetAnnotated = ClrNullability.GetParameterTypeSymbol(targetParameters[i]);
            var sourceAnnotated = ClrNullability.GetParameterTypeSymbol(sourceParameters[i]);
            if (targetAnnotated is ByRefTypeSymbol targetParameterByRef)
            {
                targetAnnotated = targetParameterByRef.PointeeType;
            }

            if (sourceAnnotated is ByRefTypeSymbol sourceParameterByRef)
            {
                sourceAnnotated = sourceParameterByRef.PointeeType;
            }

            if (!AdapterTypesMatch(
                    MapAdapterMethodTypeWithNullability(targetRaw, targetAnnotated, targetMap),
                    MapAdapterMethodTypeWithNullability(sourceRaw, sourceAnnotated, sourceMap)))
            {
                return false;
            }
        }

        return true;
    }

    private static bool ImportedAdapterTypesMatch(Type target, Type source)
    {
        if (target.IsByRef || source.IsByRef)
        {
            return target.IsByRef == source.IsByRef
                && ImportedAdapterTypesMatch(
                    RequiredAdapterElementType(target),
                    RequiredAdapterElementType(source));
        }

        if (target.IsGenericParameter || source.IsGenericParameter)
        {
            return target.IsGenericParameter
                && source.IsGenericParameter
                && target.GenericParameterPosition == source.GenericParameterPosition
                && (target.DeclaringMethod != null) == (source.DeclaringMethod != null);
        }

        if (target.IsArray || source.IsArray)
        {
            return target.IsArray
                && source.IsArray
                && target.GetArrayRank() == source.GetArrayRank()
                && ImportedAdapterTypesMatch(
                    RequiredAdapterElementType(target),
                    RequiredAdapterElementType(source));
        }

        if (target.IsGenericType || source.IsGenericType)
        {
            if (!target.IsGenericType || !source.IsGenericType
                || !ClrTypeUtilities.AreSame(target.GetGenericTypeDefinition(), source.GetGenericTypeDefinition()))
            {
                return false;
            }

            var targetArguments = target.GetGenericArguments();
            var sourceArguments = source.GetGenericArguments();
            return targetArguments.Length == sourceArguments.Length
                && targetArguments.Zip(sourceArguments).All(pair => ImportedAdapterTypesMatch(pair.First, pair.Second));
        }

        return ClrTypeUtilities.AreSame(target, source);
    }

    private static TypeSymbol MapAdapterMethodType(Type type, IReadOnlyDictionary<Type, TypeSymbol> typeParameters)
    {
        if (type.IsGenericParameter && typeParameters.TryGetValue(type, out var parameter))
        {
            return parameter;
        }

        if (type.IsByRef)
        {
            return ByRefTypeSymbol.Get(
                MapAdapterMethodType(RequiredAdapterElementType(type), typeParameters));
        }

        if (type.IsArray)
        {
            var element = MapAdapterMethodType(
                RequiredAdapterElementType(type),
                typeParameters);
            return type.GetArrayRank() == 1
                ? SliceTypeSymbol.Get(element)
                : RectangularArrayTypeSymbol.Get(element, type.GetArrayRank());
        }

        if (NullableLifting.GetValueTypeNullableUnderlyingClr(type) is { } nullableUnderlying)
        {
            return NullableTypeSymbol.Get(
                MapAdapterMethodType(nullableUnderlying, typeParameters));
        }

        if (type.IsGenericType)
        {
            var definition = type.GetGenericTypeDefinition();
            var arguments = type.GetGenericArguments()
                .Select(argument => MapAdapterMethodType(argument, typeParameters))
                .ToImmutableArray();
            return ImportedTypeSymbol.GetConstructed(type, definition, arguments);
        }

        return TypeSymbol.FromClrType(type);
    }

    private static TypeSymbol MapAdapterMethodTypeWithNullability(
        Type rawType,
        TypeSymbol annotatedType,
        IReadOnlyDictionary<Type, TypeSymbol> typeParameters)
    {
        var mapped = MapAdapterMethodType(rawType, typeParameters);
        if (annotatedType is NullableTypeSymbol && mapped is not NullableTypeSymbol)
        {
            return NullableTypeSymbol.Get(mapped);
        }

        var expectedFlags = GSharp.Core.CodeAnalysis.Emit.NullableFlagsBuilder.Build(annotatedType);
        if (mapped is TypeParameterSymbol)
        {
            return expectedFlags.Length > 0
                && expectedFlags[0] == GSharp.Core.CodeAnalysis.Emit.NullableFlagsBuilder.Annotated
                    ? NullableTypeSymbol.Get(mapped)
                    : mapped;
        }

        var mappedFlags = GSharp.Core.CodeAnalysis.Emit.NullableFlagsBuilder.Build(mapped);
        return expectedFlags.SequenceEqual(mappedFlags)
            ? mapped
            : new NullabilityAnnotatedTypeSymbol(mapped, expectedFlags);
    }

    private static Type RequiredAdapterElementType(Type type)
        => Invariant.Required(
            type.GetElementType(),
            "a byref or array reflection type has an element type");

    private static void ApplyImportedGenericConstraints(
        Type[] source,
        ImmutableArray<TypeParameterSymbol> target,
        IReadOnlyDictionary<Type, TypeSymbol> map)
    {
        for (var i = 0; i < source.Length; i++)
        {
            var attributes = source[i].GenericParameterAttributes;
            target[i].HasReferenceTypeConstraint =
                (attributes & GenericParameterAttributes.ReferenceTypeConstraint) != 0;
            target[i].HasValueTypeConstraint =
                (attributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0;
            target[i].HasDefaultConstructorConstraint =
                (attributes & GenericParameterAttributes.DefaultConstructorConstraint) != 0;
            target[i].HasUnmanagedConstraint = HasAdapterUnmanagedConstraint(source[i]);

            foreach (var constraint in source[i].GetGenericParameterConstraints())
            {
                var mapped = MapAdapterMethodType(constraint, map);
                if (mapped is TypeParameterSymbol dependent)
                {
                    target[i].TypeParameterBound = dependent;
                }
                else if (constraint.IsInterface)
                {
                    target[i].ClrInterfaceConstraint = mapped;
                }
                else
                {
                    target[i].ClassConstraint = mapped;
                }
            }
        }
    }

    private static bool PropertyContractsMatch(PropertySymbol target, PropertySymbol source)
    {
        if (target.IsIndexer != source.IsIndexer
            || target.Parameters.Length != source.Parameters.Length
            || target.ReturnRefKind != source.ReturnRefKind
            || (target.HasSetter && target.IsInitOnly != source.IsInitOnly)
            || (target.HasGetter && (!source.HasGetter || source.GetterAccessibility != Accessibility.Public))
            || (target.HasSetter && (!source.HasSetter || source.SetterAccessibility != Accessibility.Public))
            || !AdapterTypesMatch(target.Type, source.Type))
        {
            return false;
        }

        for (var i = 0; i < target.Parameters.Length; i++)
        {
            if (target.Parameters[i].RefKind != source.Parameters[i].RefKind
                || target.Parameters[i].IsScoped != source.Parameters[i].IsScoped
                || !AdapterTypesMatch(target.Parameters[i].Type, source.Parameters[i].Type))
            {
                return false;
            }
        }

        return true;
    }

    private static PropertyInfo[] GetImportedSourceProperties(Type source)
    {
        var properties = new List<PropertyInfo>();
        var containers = source.IsInterface
            ? source.GetInterfaces().Prepend(source)
            : new[] { source };
        foreach (var container in containers)
        {
            foreach (var property in container.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!properties.Any(existing => SameImportedMember(existing, property)))
                {
                    properties.Add(property);
                }
            }
        }

        return properties.ToArray();
    }

    private static EventInfo[] GetImportedSourceEvents(Type source)
    {
        var events = new List<EventInfo>();
        var containers = source.IsInterface
            ? source.GetInterfaces().Prepend(source)
            : new[] { source };
        foreach (var container in containers)
        {
            foreach (var eventInfo in container.GetEvents(BindingFlags.Public | BindingFlags.Instance))
            {
                if (!events.Any(existing => SameImportedMember(existing, eventInfo)))
                {
                    events.Add(eventInfo);
                }
            }
        }

        return events.ToArray();
    }

    private static bool SameImportedMember(MemberInfo left, MemberInfo right)
        => left.MetadataToken == right.MetadataToken
            && left.Module.ModuleVersionId == right.Module.ModuleVersionId
            && ClrTypeUtilities.AreSame(
                left.ReflectedType ?? left.DeclaringType,
                right.ReflectedType ?? right.DeclaringType);

    private static bool ImportedPropertyContractsMatch(PropertyInfo target, PropertyInfo source)
    {
        if ((target.CanRead && source.GetMethod?.IsPublic != true)
            || (target.CanWrite && source.SetMethod?.IsPublic != true)
            || (target.GetMethod != null && source.GetMethod != null
                && RefCapabilities.GetReturnRefKind(target.GetMethod) != RefCapabilities.GetReturnRefKind(source.GetMethod))
            || (target.GetMethod != null && source.GetMethod != null
                && !AdapterMethodMetadataMatches(target.GetMethod, source.GetMethod))
            || (target.SetMethod != null && source.SetMethod != null
                && !AdapterMethodMetadataMatches(target.SetMethod, source.SetMethod))
            || !AdapterTypesMatch(ClrNullability.GetPropertyTypeSymbol(target), ClrNullability.GetPropertyTypeSymbol(source)))
        {
            return false;
        }

        var targetParameters = target.GetIndexParameters();
        var sourceParameters = source.GetIndexParameters();
        if (targetParameters.Length != sourceParameters.Length)
        {
            return false;
        }

        for (var i = 0; i < targetParameters.Length; i++)
        {
            if (GetAdapterRefKind(targetParameters[i]) != GetAdapterRefKind(sourceParameters[i])
                || IsAdapterScoped(targetParameters[i]) != IsAdapterScoped(sourceParameters[i])
                || !AdapterTypesMatch(
                    ClrNullability.GetParameterTypeSymbol(targetParameters[i]),
                    ClrNullability.GetParameterTypeSymbol(sourceParameters[i])))
            {
                return false;
            }
        }

        return true;
    }

    private static bool EventContractsMatch(EventSymbol target, EventSymbol source)
        => source.AddMethodSymbol != null
            && source.RemoveMethodSymbol != null
            && AdapterTypesMatch(target.Type, source.Type);

    private static bool ImportedEventContractsMatch(EventInfo target, EventInfo source)
        => source.AddMethod?.IsPublic == true
            && source.RemoveMethod?.IsPublic == true
            && target.AddMethod != null
            && target.RemoveMethod != null
            && AdapterMethodMetadataMatches(target.AddMethod, source.AddMethod)
            && AdapterMethodMetadataMatches(target.RemoveMethod, source.RemoveMethod)
            && target.EventHandlerType != null
            && source.EventHandlerType != null
            && AdapterTypesMatch(
                TypeSymbol.FromClrType(target.EventHandlerType),
                TypeSymbol.FromClrType(source.EventHandlerType));

    private static bool ImportedEventSlotsEquivalent(EventInfo left, EventInfo right)
        => left.Name == right.Name
            && left.EventHandlerType != null
            && right.EventHandlerType != null
            && ImportedAdapterTypesMatch(left.EventHandlerType, right.EventHandlerType)
            && left.AddMethod != null
            && right.AddMethod != null
            && left.RemoveMethod != null
            && right.RemoveMethod != null
            && AdapterMethodMetadataMatches(left.AddMethod, right.AddMethod)
            && AdapterMethodMetadataMatches(left.RemoveMethod, right.RemoveMethod);

    private static bool AdapterTypesMatch(TypeSymbol left, TypeSymbol right)
        => Conversion.ClassifyNonStructural(left, right).IsIdentity
            && GSharp.Core.CodeAnalysis.Emit.NullableFlagsBuilder.Build(left)
                .SequenceEqual(GSharp.Core.CodeAnalysis.Emit.NullableFlagsBuilder.Build(right));

    private static bool IsAdapterScoped(ParameterInfo parameter)
        => parameter.GetCustomAttributesData().Any(attribute =>
            attribute.AttributeType.FullName == "System.Runtime.CompilerServices.ScopedRefAttribute");

    private static bool AdapterMethodMetadataMatches(MethodInfo target, MethodInfo source)
    {
        if (!AdapterParameterMetadataMatches(target.ReturnParameter, source.ReturnParameter))
        {
            return false;
        }

        var targetParameters = target.GetParameters();
        var sourceParameters = source.GetParameters();
        return targetParameters.Length == sourceParameters.Length
            && targetParameters.Zip(sourceParameters).All(pair =>
                AdapterParameterMetadataMatches(pair.First, pair.Second));
    }

    private static bool AdapterParameterMetadataMatches(ParameterInfo target, ParameterInfo source)
        => AdapterModifierSequenceMatches(
                target.GetRequiredCustomModifiers(),
                source.GetRequiredCustomModifiers())
            && AdapterModifierSequenceMatches(
                target.GetOptionalCustomModifiers(),
                source.GetOptionalCustomModifiers())
            && HasAdapterUnscopedRef(target) == HasAdapterUnscopedRef(source);

    private static bool AdapterParameterMetadataSupported(ParameterInfo parameter)
        => parameter.GetOptionalCustomModifiers().Length == 0
            && parameter.GetRequiredCustomModifiers().All(modifier =>
                modifier.FullName is "System.Runtime.InteropServices.InAttribute"
                    or "System.Runtime.CompilerServices.IsReadOnlyAttribute"
                    or "System.Runtime.CompilerServices.IsExternalInit");

    private static bool AdapterModifierSequenceMatches(Type[] target, Type[] source)
        => target.Length == source.Length
            && target.Zip(source).All(pair => ClrTypeUtilities.AreSame(pair.First, pair.Second));

    private static bool HasAdapterUnscopedRef(ParameterInfo parameter)
        => parameter.GetCustomAttributesData().Any(attribute =>
            attribute.AttributeType.FullName == "System.Diagnostics.CodeAnalysis.UnscopedRefAttribute");

    private static bool HasAdapterUnmanagedConstraint(Type parameter)
        => parameter.GetCustomAttributesData().Any(attribute =>
            attribute.AttributeType.FullName == "System.Runtime.CompilerServices.IsUnmanagedAttribute");

    private static bool IsAdapterInitOnly(MethodInfo setter)
        => setter.ReturnParameter.GetRequiredCustomModifiers().Any(modifier =>
            modifier.FullName == "System.Runtime.CompilerServices.IsExternalInit");

    private static RefKind GetAdapterRefKind(ParameterInfo parameter)
        => !parameter.ParameterType.IsByRef ? RefKind.None
            : parameter.IsOut && !parameter.IsIn ? RefKind.Out
            : parameter.IsIn && !parameter.IsOut ? RefKind.In
            : RefKind.Ref;

    private static string FormatAdapterSlot(FunctionSymbol slot)
        => $"{slot.Name}({string.Join(", ", slot.Parameters.Select(parameter => parameter.Type.Name))}) {slot.Type.Name}";

    private sealed record RichAnonymousCapture(FieldSymbol Field, bool IsMutable);

    private sealed class RichAnonymousCaptureCollector : BoundTreeWalker
    {
        private readonly HashSet<VariableSymbol> declared = new();
        private readonly HashSet<VariableSymbol> referenced = new();

        internal static ImmutableArray<VariableSymbol> Collect(
            Dictionary<FunctionSymbol, BoundBlockStatement> bodies)
        {
            var collector = new RichAnonymousCaptureCollector();
            foreach (var (method, body) in bodies)
            {
                collector.declared.UnionWith(method.Parameters);
                if (method.ThisParameter != null)
                {
                    collector.declared.Add(method.ThisParameter);
                }

                collector.Visit(body);
            }

            return collector.referenced
                .Where(variable => !collector.declared.Contains(variable))
                .OrderBy(variable => variable.DeclaringSyntax?.Span.Start ?? int.MaxValue)
                .ThenBy(variable => variable.Name, StringComparer.Ordinal)
                .ToImmutableArray();
        }

        protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
        {
            declared.Add(node.Variable);
            base.VisitVariableDeclaration(node);
        }

        public override void VisitExpression(BoundExpression? node)
        {
            if (node is BoundVariableExpression variable)
            {
                referenced.Add(variable.Variable);
                return;
            }

            if (node is BoundFunctionLiteralExpression literal)
            {
                declared.UnionWith(literal.Function.Parameters);
                Visit(literal.Body);
                return;
            }

            base.VisitExpression(node);
        }

        protected override void VisitAssignmentExpression(BoundAssignmentExpression node)
        {
            referenced.Add(node.Variable);
            base.VisitAssignmentExpression(node);
        }
    }

    private sealed class RichAnonymousCaptureRewriter : BoundTreeRewriter
    {
        private readonly StructSymbol owner;
        private readonly FunctionSymbol method;
        private readonly Dictionary<VariableSymbol, RichAnonymousCapture> captures;

        internal RichAnonymousCaptureRewriter(
            StructSymbol owner,
            FunctionSymbol method,
            Dictionary<VariableSymbol, RichAnonymousCapture> captures)
        {
            this.owner = owner;
            this.method = method;
            this.captures = captures;
        }

        protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
            => captures.TryGetValue(node.Variable, out var capture)
                ? ReadCapture(capture)
                : node;

        protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
        {
            if (!captures.TryGetValue(node.Variable, out var capture) || !capture.IsMutable)
            {
                return base.RewriteAssignmentExpression(node);
            }

            return new BoundIndirectAssignmentExpression(
                node.Syntax,
                ManagedReferenceTypes.Borrow(ReadCaptureField(capture)),
                RewriteExpression(node.Expression));
        }

        protected override BoundExpression RewriteFunctionLiteralExpression(BoundFunctionLiteralExpression node)
        {
            var body = (BoundBlockStatement)RewriteStatement(node.Body);
            var captured = node.CapturedVariables.Where(variable => !captures.ContainsKey(variable)).ToImmutableArray().ToBuilder();
            if (node.CapturedVariables.Any(variable => captures.ContainsKey(variable))
                && method.ThisParameter != null
                && !captured.Contains(method.ThisParameter))
            {
                captured.Add(method.ThisParameter);
            }

            return body == node.Body && captured.SequenceEqual(node.CapturedVariables)
                ? node
                : new BoundFunctionLiteralExpression(
                    node.Syntax,
                    node.Function,
                    node.FunctionType,
                    body,
                    captured.ToImmutable());
        }

        private BoundExpression ReadCapture(RichAnonymousCapture capture)
        {
            var field = ReadCaptureField(capture);
            return capture.IsMutable
                ? new BoundDereferenceExpression(null, ManagedReferenceTypes.Borrow(field))
                : field;
        }

        private BoundFieldAccessExpression ReadCaptureField(RichAnonymousCapture capture)
            => new(
                null,
                new BoundVariableExpression(null, Invariant.Required(method.ThisParameter, "rich anonymous methods have a receiver")),
                owner,
                capture.Field);
    }

    /// <summary>
    /// ADR-0146 / issue #2243: recursively walks a syntax subtree and, for
    /// every "rich" anonymous-object literal (one carrying a base/interface
    /// clause, a method, or an event), synthesizes a top-level class
    /// declaration and records the (literal, declaration) pair.
    /// </summary>
    private static void CollectRichAnonymousObjectDeclarations(
        SyntaxNode node,
        SyntaxTree tree,
        List<(AnonymousClassExpressionSyntax Node, StructDeclarationSyntax Declaration)> results,
        DiagnosticBag diagnostics,
        ref int counter,
        ImmutableArray<TypeParameterListSyntax> enclosingTypeParameters)
    {
        var declaredTypeParameters = node switch
        {
            FunctionDeclarationSyntax { TypeParameterList: { } functionParameters } => functionParameters,
            StructDeclarationSyntax { TypeParameterList: { } typeParameters } => typeParameters,
            InterfaceDeclarationSyntax { TypeParameterList: { } interfaceParameters } => interfaceParameters,
            VariableDeclarationSyntax { TypeParameterList: { } localFunctionParameters } => localFunctionParameters,
            _ => null,
        };
        if (declaredTypeParameters != null)
        {
            enclosingTypeParameters = enclosingTypeParameters.Add(declaredTypeParameters);
        }

        if (node is AnonymousClassExpressionSyntax anon && IsRichAnonymousObject(anon))
        {
            var decl = SynthesizeAnonymousClassDeclaration(
                anon,
                tree,
                counter++,
                diagnostics,
                enclosingTypeParameters);
            results.Add((anon, decl));
        }

        foreach (var child in node.GetChildren())
        {
            CollectRichAnonymousObjectDeclarations(
                child,
                tree,
                results,
                diagnostics,
                ref counter,
                enclosingTypeParameters);
        }
    }

    /// <summary>
    /// Determines whether an anonymous-object literal is "rich" — carries a
    /// base/interface clause, a method, or an event — and therefore must be
    /// lowered through the synthesized-class pipeline (ADR-0146).
    /// </summary>
    private static bool IsRichAnonymousObject(AnonymousClassExpressionSyntax syntax)
    {
        if (syntax.HasBaseType)
        {
            return true;
        }

        foreach (var member in syntax.Members)
        {
            if (member is FunctionDeclarationSyntax || member is EventDeclarationSyntax)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0146 / issue #2243: synthesizes a top-level <c>class</c> declaration
    /// backing a rich anonymous-object literal. This declaration is a stable
    /// predeclared shell: fields use their explicit type or an <c>object</c>
    /// placeholder, methods/events and the base/interface type clauses retain
    /// syntax identity, and literal-site binding later installs inferred field
    /// types, constructor parameters, base arguments, captures, and bound
    /// method bodies without relocating executable expressions.
    /// </summary>
    private static StructDeclarationSyntax SynthesizeAnonymousClassDeclaration(
        AnonymousClassExpressionSyntax syntax,
        SyntaxTree tree,
        int index,
        DiagnosticBag diagnostics,
        ImmutableArray<TypeParameterListSyntax> enclosingTypeParameters)
    {
        var position = syntax.ObjectKeyword.Position;
        SyntaxToken Tok(SyntaxKind kind, string text) => new SyntaxToken(tree, kind, position, text, null);

        var identifier = Tok(SyntaxKind.IdentifierToken, $"<>AnonClass{index}");
        var classKeyword = Tok(SyntaxKind.ClassKeyword, "class");

        var fields = ImmutableArray.CreateBuilder<FieldDeclarationSyntax>();
        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();
        var events = ImmutableArray.CreateBuilder<EventDeclarationSyntax>();
        foreach (var member in syntax.Members)
        {
            switch (member)
            {
                case AnonymousClassMemberInitializerSyntax field:
                    fields.Add(new FieldDeclarationSyntax(
                        tree,
                        Tok(SyntaxKind.PublicKeyword, "public"),
                        field.LetOrVarKeyword,
                        field.Identifier,
                        field.TypeClause ?? new TypeClauseSyntax(tree, Tok(SyntaxKind.IdentifierToken, "object"))));
                    break;

                case FunctionDeclarationSyntax method:
                    methods.Add(method);
                    break;

                case EventDeclarationSyntax evt:
                    events.Add(evt);
                    break;
            }
        }

        // Base/interface clause. Replicates ParseStructDeclaration's handling:
        // the first base type populates BaseTypeIdentifier, subsequent ones
        // AdditionalBaseTypeIdentifiers, and the full list is preserved on
        // BaseTypeClauses.
        SyntaxToken? baseColon = null;
        SyntaxToken? baseTypeIdentifier = null;
        var additionalBaseIdentifiers = ImmutableArray<SyntaxToken?>.Empty;
        var baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray<SyntaxNode>.Empty);
        var syntaxBaseTypeClause = syntax.BaseTypeClause;
        if (syntax.HasBaseType && syntaxBaseTypeClause != null)
        {
            baseColon = syntax.BaseColonToken;
            baseTypeIdentifier = syntaxBaseTypeClause.DottedName == null
                ? null
                : new SyntaxToken(tree, SyntaxKind.IdentifierToken, Invariant.Required(syntaxBaseTypeClause.Identifier, "a base-type clause with a non-empty DottedName has an Identifier").Position, syntaxBaseTypeClause.DottedName, null);

            var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
            nodesAndSeparators.Add(syntaxBaseTypeClause);
            var addlBuilder = ImmutableArray.CreateBuilder<SyntaxToken?>();
            foreach (var addl in syntax.AdditionalBaseTypeClauses)
            {
                nodesAndSeparators.Add(new SyntaxToken(tree, SyntaxKind.CommaToken, position, ",", null));
                nodesAndSeparators.Add(addl);

                // Entries of AnonymousClassExpressionSyntax.AdditionalBaseTypeClauses are
                // always parsed as named (simple or dotted) base-type references, never an
                // array/pointer/function clause, so the parser always sets Identifier here.
                addlBuilder.Add(addl.DottedName == null
                    ? null
                    : new SyntaxToken(tree, SyntaxKind.IdentifierToken, Invariant.Required(addl.Identifier, "an additional base-type clause is always a named type reference with an identifier").Position, addl.DottedName, null));
            }

            additionalBaseIdentifiers = addlBuilder.ToImmutable();
            baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(nodesAndSeparators.ToImmutable());
        }

        var decl = new StructDeclarationSyntax(
            tree,
            accessibilityModifier: null,
            typeKeyword: null,
            identifier,
            dataKeyword: null,
            inlineKeyword: null,
            openModifier: null,
            classKeyword,
            Tok(SyntaxKind.OpenParenthesisToken, "("),
            new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty),
            Tok(SyntaxKind.CloseParenthesisToken, ")"),
            baseColon,
            baseTypeIdentifier,
            additionalBaseIdentifiers,
            syntax.OpenBraceToken,
            fields.ToImmutable(),
            ImmutableArray<PropertyDeclarationSyntax>.Empty,
            events.ToImmutable(),
            methods.ToImmutable(),
            syntax.CloseBraceToken);
        decl.IsSynthesizedRichAnonymousObject = true;
        var combinedTypeParameters = CombineRichTypeParameterLists(
            tree,
            position,
            enclosingTypeParameters);
        decl.TypeParameterList = combinedTypeParameters;
        decl.RichAnonymousShellTypeParameterCount =
            combinedTypeParameters?.Parameters.Count ?? 0;
        decl.BaseTypeClauses = baseTypeClauses;
        return decl;
    }

    private static TypeParameterListSyntax? CombineRichTypeParameterLists(
        SyntaxTree tree,
        int position,
        ImmutableArray<TypeParameterListSyntax> lists)
    {
        if (lists.IsDefaultOrEmpty)
        {
            return null;
        }

        if (lists.Length == 1)
        {
            return lists[0];
        }

        var visible = new HashSet<TypeParameterSyntax>(ReferenceEqualityComparer.Instance);
        var names = new HashSet<string>(StringComparer.Ordinal);
        for (var listIndex = lists.Length - 1; listIndex >= 0; listIndex--)
        {
            var parameters = lists[listIndex].Parameters;
            for (var parameterIndex = parameters.Count - 1; parameterIndex >= 0; parameterIndex--)
            {
                var parameter = parameters[parameterIndex];
                if (names.Add(parameter.Identifier.ValueText))
                {
                    visible.Add(parameter);
                }
            }
        }

        var nodes = ImmutableArray.CreateBuilder<SyntaxNode>();
        foreach (var list in lists)
        {
            foreach (var parameter in list.Parameters)
            {
                if (!visible.Contains(parameter))
                {
                    continue;
                }

                if (nodes.Count > 0)
                {
                    nodes.Add(new SyntaxToken(tree, SyntaxKind.CommaToken, position, ",", null));
                }

                nodes.Add(parameter);
            }
        }

        SyntaxToken Tok(SyntaxKind kind, string text) =>
            new(tree, kind, position, text, null);
        return new TypeParameterListSyntax(
            tree,
            Tok(SyntaxKind.OpenSquareBracketToken, "["),
            new SeparatedSyntaxList<TypeParameterSyntax>(nodes.ToImmutable()),
            Tok(SyntaxKind.CloseSquareBracketToken, "]"));
    }

    /// <summary>
    /// ADR-0066 D2/D3: pre-scans the top-level statements to determine the
    /// synthesized entry point's return type before binding. If any TLS
    /// <c>return</c> carries an expression, the entry point returns
    /// <c>int</c>; otherwise it returns <c>void</c>. Mixed bare and
    /// value-returning shapes report GS0287 at the first offending site,
    /// and recovery picks whichever shape appeared first. Awaits in TLS are
    /// reported via <paramref name="awaitFound"/> for D3 async wiring.
    /// Returns and awaits inside nested function literals are deliberately
    /// ignored: they belong to the lambda, not the entry point.
    /// </summary>
    private static TypeSymbol InferTopLevelEntryPointReturnType(
        IReadOnlyList<GlobalStatementSyntax> globalStatements,
        DiagnosticBag diagnostics,
        out bool awaitFound)
    {
        ReturnStatementSyntax? firstBare = null;
        ReturnStatementSyntax? firstValue = null;
        bool localAwaitFound = false;
        foreach (var gs in globalStatements)
        {
            CollectTopLevelReturnsAndAwaits(gs.Statement, ref firstBare, ref firstValue, ref localAwaitFound);
        }

        awaitFound = localAwaitFound;

        if (firstBare != null && firstValue != null)
        {
            // Recovery: the first shape seen wins. The mismatch fires at the
            // *later* offender's location so the user sees which return
            // disagreed with the prevailing shape.
            var firstBareSpan = firstBare.ReturnKeyword.Span.Start;
            var firstValueSpan = firstValue.ReturnKeyword.Span.Start;
            if (firstBareSpan < firstValueSpan)
            {
                diagnostics.ReportTopLevelReturnShapeMismatch(firstValue.ReturnKeyword.Location);
                return TypeSymbol.Void;
            }
            else
            {
                diagnostics.ReportTopLevelReturnShapeMismatch(firstBare.ReturnKeyword.Location);
                return TypeSymbol.Int32;
            }
        }

        return firstValue != null ? TypeSymbol.Int32 : TypeSymbol.Void;
    }

    /// <summary>
    /// Recursively walks <paramref name="node"/>, classifying every
    /// <see cref="ReturnStatementSyntax"/> as either bare or value-returning,
    /// recording the first instance of each, and noting whether any
    /// <see cref="AwaitExpressionSyntax"/> was encountered. Descent stops at
    /// <see cref="FunctionLiteralExpressionSyntax"/> boundaries: returns
    /// and awaits inside lambdas belong to the lambda's own function body,
    /// not to the surrounding TLS entry point.
    /// </summary>
    private static void CollectTopLevelReturnsAndAwaits(
        SyntaxNode node,
        ref ReturnStatementSyntax? firstBare,
        ref ReturnStatementSyntax? firstValue,
        ref bool awaitFound)
    {
        if (node == null)
        {
            return;
        }

        if (node is FunctionLiteralExpressionSyntax or LambdaExpressionSyntax)
        {
            // ADR-0066 D2/D3: lambda bodies host their own `return`s and
            // `await`s; skip them when inferring the TLS entry point shape.
            // ADR-0074 added arrow lambdas (LambdaExpressionSyntax); their
            // block-body `return` statements likewise belong to the lambda's
            // body, not the synthesized `<Main>$`.
            return;
        }

        if (node is AnonymousClassExpressionSyntax)
        {
            // ADR-0146: a rich anonymous-object literal (`object { ... }`,
            // `object : Base { ... }`) carries its own method/accessor member
            // declarations. Their `return`s (and expression-bodied `->`
            // arrows lowered to returns) belong to those synthesized members,
            // not to the surrounding `<Main>$`. Stop descent so they don't
            // flip the entry point's inferred return type away from void.
            return;
        }

        if (node is AwaitExpressionSyntax)
        {
            awaitFound = true;

            // Await operands may themselves contain returns/awaits that
            // belong to the entry point — fall through to recurse.
        }

        if (node is AwaitForRangeStatementSyntax or AwaitUsingStatementSyntax)
        {
            // Issue #3214: the statement-level await forms (`await for … { }`
            // and `await using …`) carry their `await` as a keyword token on
            // the statement syntax — there is no AwaitExpressionSyntax child
            // to find. They make the synthesized entry point async exactly
            // like an expression-level `await`; the async state-machine
            // lowering handles the rest. Fall through to recurse: their
            // bodies may contain returns/awaits of their own.
            awaitFound = true;
        }

        if (node is ReturnStatementSyntax ret)
        {
            if (ret.Expression == null)
            {
                if (firstBare == null)
                {
                    firstBare = ret;
                }
            }
            else
            {
                if (firstValue == null)
                {
                    firstValue = ret;
                }
            }

            // The return expression itself may contain an `await` (e.g.
            // `return await Task.FromResult(0)`) — recurse so D3 sees it.
            if (ret.Expression != null)
            {
                CollectTopLevelReturnsAndAwaits(ret.Expression, ref firstBare, ref firstValue, ref awaitFound);
            }

            return;
        }

        foreach (var child in node.GetChildren())
        {
            CollectTopLevelReturnsAndAwaits(child, ref firstBare, ref firstValue, ref awaitFound);
        }
    }

    private static BoundScope CreateParentScope(
        BoundGlobalScope? previous,
        ReferenceResolver? references,
        ImmutableHashSet<string>? preprocessorSymbols,
        bool preserveLatestImportSyntaxTrees)
        => CreateParentScope(previous, references, preprocessorSymbols, preserveLatestImportSyntaxTrees, previous?.SubmissionImports);

    private static BoundScope CreateParentScope(
        BoundGlobalScope? previous,
        ReferenceResolver? references,
        ImmutableHashSet<string>? preprocessorSymbols,
        bool preserveLatestImportSyntaxTrees,
        SubmissionImports? submissionImports)
    {
        var stack = new Stack<BoundGlobalScope>();
        while (previous != null)
        {
            stack.Push(previous);
            previous = previous.Previous;
        }

        var parent = CreateRootScope(references, preprocessorSymbols);
        parent.SetSubmissionImports(submissionImports);

        while (stack.Count > 0)
        {
            previous = stack.Pop();
            var scope = new BoundScope(parent);
            var preserveImportSyntaxTrees = preserveLatestImportSyntaxTrees && stack.Count == 0;

            foreach (var package in previous.Packages)
            {
                if (package.IsExplicitlyDeclared)
                {
                    scope.RegisterSourcePackage(package.Name);
                }
            }

            foreach (var i in previous.Imports)
            {
                scope.TryImport(preserveImportSyntaxTrees
                    ? i
                    : new ImportSymbol(i.Name, i.Target, declaration: null));
            }

            foreach (var alias in previous.TypeAliases)
            {
                scope.TryRedeclareTypeAlias(alias.Key, alias.Value);
            }

            foreach (var f in previous.Functions)
            {
                scope.TryDeclareFunction(f);

                // Issue #1103: extension functions are flattened into
                // BoundGlobalScope.Functions (Binder.BindGlobalScope merges
                // GetDeclaredExtensionFunctions into Functions) so free-call
                // syntax resolves them as ordinary functions. When a follow-up
                // pass rehydrates the previous global scope (the body-binding
                // pass binds member/function bodies against this rebuilt
                // scope), the extension registry must be repopulated too —
                // otherwise member-syntax dispatch (`receiver.Ext()`) via
                // BoundScope.TryLookupExtensionFunction finds nothing and the
                // call reports GS0159 even though the free-call form binds.
                if (f.IsExtension)
                {
                    scope.TryDeclareExtensionFunction(f);
                }
            }

            foreach (var v in previous.Variables)
            {
                scope.TryDeclareVariable(v);
            }

            parent = scope;
        }

        return parent;
    }

    private static BoundScope CreateRootScope(ReferenceResolver? references, ImmutableHashSet<string>? preprocessorSymbols)
    {
        // Issues #3245/#3246: the legacy `print`/`input`/`rnd` builtins were
        // retired (clean cut) — the root scope declares no builtin functions.
        // Console interop (`System.Console`) is the supported story.
        return new BoundScope(parent: null, references: references, preprocessorSymbols: preprocessorSymbols);
    }

    private void BindImport(ImportSyntax import)
    {
        var sb = new StringBuilder();
        foreach (var i in import.IdentifiersWithDots)
        {
            // ADR-0170: escaped segments (`import $class`) contribute their
            // unescaped name; dot separators pass through unchanged.
            sb.Append(i.ValueText);
        }

        var targetPath = sb.ToString();
        var localName = import.AliasIdentifier?.ValueText ?? targetPath;
        var importSymbol = new ImportSymbol(localName, targetPath, import);
        AttachDocumentation(importSymbol, import);
        scope.TryImport(importSymbol);
    }

    private static bool ClrTypesEquivalent(System.Type a, System.Type b)
        => ClrTypeUtilities.AreSame(a, b);

    private static bool IsPrimitiveTypeName(string name)
    {
        switch (name)
        {
            case "bool":
            case "uint8":
            case "int8":
            case "int16":
            case "uint16":
            case "int32":
            case "uint32":
            case "int64":
            case "uint64":
            case "nint":
            case "nuint":
            case "float32":
            case "float64":
            case "decimal":
            case "char":
            case "string":
            case "object":
            // ADR-0098 / issue #729: friendly numeric aliases are treated as
            // reserved primitive type names so user-defined `type int = …`
            // (etc.) is rejected with the same diagnostic that already
            // protects canonical width-bearing names like `int32`.
            case "byte":
            case "sbyte":
            case "short":
            case "ushort":
            case "int":
            case "uint":
            case "long":
            case "ulong":
            case "float":
            case "double":
                return true;
            default:
                return false;
        }
    }

    private static Accessibility ResolveAccessibility(SyntaxToken? modifier)
    {
        if (modifier == null)
        {
            return Accessibility.Public;
        }

        switch (modifier.Kind)
        {
            case SyntaxKind.PublicKeyword:
                return Accessibility.Public;
            case SyntaxKind.InternalKeyword:
                return Accessibility.Internal;
            case SyntaxKind.PrivateKeyword:
                return Accessibility.Private;
            case SyntaxKind.ProtectedKeyword:
                return Accessibility.Protected;
            default:
                return Accessibility.Public;
        }
    }

    private TypeSymbol? BindNonNullableTypeClause(TypeClauseSyntax? syntax)
    {
        if (syntax == null)
        {
            return null;
        }

        if (syntax.IsFunctionPointer)
        {
            // ADR-0095 / issue #761: raw function-pointer type clause
            // `unmanaged[CC] (T1, T2, ...) -> R`. Bind the inner
            // parameter/return types eagerly so structural identity holds
            // across declarations even when the user spells the same
            // signature differently elsewhere.
            var fpParameterTypes = Invariant.Required(syntax.FunctionParameterTypes, "a function-pointer type clause (IsFunctionPointer) always carries its parameter-type list from the parser");
            var paramTypes = ImmutableArray.CreateBuilder<TypeSymbol>(fpParameterTypes.Count);
            for (var i = 0; i < fpParameterTypes.Count; i++)
            {
                var pt = BindTypeClause(fpParameterTypes[i]);
                if (pt == null)
                {
                    return null;
                }

                paramTypes.Add(pt);
            }

            var fpRet = syntax.ReturnTypeClause != null ? BindTypeClause(syntax.ReturnTypeClause) : TypeSymbol.Void;
            if (fpRet == null)
            {
                return null;
            }

            // ADR-0122 §9 / issue #1035: the managed function pointer
            // `*func(T1, T2) R` is callable directly via `calli`. Like the
            // `*T` raw pointer it is only legal inside an `unsafe` context.
            if (syntax.IsManagedFunctionPointer)
            {
                if (!binderCtx.InUnsafeContext)
                {
                    Diagnostics.ReportUnmanagedPointerOutsideUnsafe(
                        Invariant.Required(syntax.ManagedFunctionPointerStarToken, "the parser sets the star token whenever IsManagedFunctionPointer (ManagedFunctionPointerFuncKeyword) is set").Location);
                    return null;
                }

                return FunctionPointerTypeSymbol.GetManaged(paramTypes.MoveToImmutable(), fpRet);
            }

            // ADR-0095 v2 / issue #3611 — the open CLR calling-convention
            // model. Collect the slot's identifiers in source order: the
            // first rides the dedicated token, the rest alternate with
            // comma separators on CallingConventionRestTokens.
            var conventionTokens = new List<SyntaxToken>();
            if (syntax.CallingConventionIdentifierToken != null)
            {
                conventionTokens.Add(syntax.CallingConventionIdentifierToken);
                foreach (var rest in syntax.CallingConventionRestTokens)
                {
                    if (rest is SyntaxToken { Kind: SyntaxKind.IdentifierToken } restIdentifier)
                    {
                        conventionTokens.Add(restIdentifier);
                    }
                }
            }

            // A single legacy name keeps the v1 closed-enum path — it
            // encodes as the legacy SignatureCallingConvention literal with
            // no modopts, byte-identical to what csc emits for
            // `delegate* unmanaged[Cdecl]<...>`.
            if (conventionTokens.Count == 1)
            {
                System.Runtime.InteropServices.CallingConvention? legacy = conventionTokens[0].Text switch
                {
                    "Cdecl" => System.Runtime.InteropServices.CallingConvention.Cdecl,
                    "Stdcall" => System.Runtime.InteropServices.CallingConvention.StdCall,
                    "Thiscall" => System.Runtime.InteropServices.CallingConvention.ThisCall,
                    "Fastcall" => System.Runtime.InteropServices.CallingConvention.FastCall,
                    _ => null,
                };
                if (legacy is { } legacyConvention)
                {
                    return FunctionPointerTypeSymbol.Get(legacyConvention, paramTypes.MoveToImmutable(), fpRet);
                }
            }

            // Every other slot shape — empty (bare platform default), a
            // single non-legacy name, or a combined list — resolves each
            // name against `System.Runtime.CompilerServices.CallConv{Name}`
            // (C#'s rule) and encodes as SignatureCallingConvention.Unmanaged
            // with the resolved types as return-type modopts in source order.
            var conventionNames = ImmutableArray.CreateBuilder<string>(conventionTokens.Count);
            var conventionClrTypes = ImmutableArray.CreateBuilder<System.Type>(conventionTokens.Count);
            foreach (var conventionToken in conventionTokens)
            {
                var metadataName = "System.Runtime.CompilerServices.CallConv" + conventionToken.Text;
                if (!binderCtx.References.TryResolveType(metadataName, out var callConvType))
                {
                    Diagnostics.ReportFunctionPointerUnknownCallingConvention(
                        conventionToken.Location,
                        conventionToken.Text);
                    return null;
                }

                conventionNames.Add(conventionToken.Text);
                conventionClrTypes.Add(callConvType);
            }

            return FunctionPointerTypeSymbol.GetUnmanagedExtended(
                conventionNames.MoveToImmutable(),
                conventionClrTypes.MoveToImmutable(),
                paramTypes.MoveToImmutable(),
                fpRet);
        }

        if (syntax.IsFunction)
        {
            // Phase 4.7: function-type clause `func(T1, T2, ...) R?`.
            // ADR-0043: `async func(P) R` aliases to `func(P) Task[R]` (with
            // carve-outs for void → Task and IAsyncEnumerable[T] → unchanged).
            // ADR-0102 follow-up / issue #818: the parameter list may
            // declare a trailing variadic slot `...T`. The structural rules
            // (at most one, last position, slice-typed) are enforced here
            // and the per-slot variadic flag is threaded into the cached
            // `FunctionTypeSymbol` so call-site pack / pass-through can
            // consult it.
            var fnParameterTypes = Invariant.Required(syntax.FunctionParameterTypes, "a function type clause (IsFunction) always carries its parameter-type list from the parser");
            var paramTypes = ImmutableArray.CreateBuilder<TypeSymbol>(fnParameterTypes.Count);
            var variadicFlagsBuilder = ImmutableArray.CreateBuilder<bool>(fnParameterTypes.Count);
            var anyVariadic = false;
            var firstVariadicSeen = false;
            for (var i = 0; i < fnParameterTypes.Count; i++)
            {
                var paramSyntax = fnParameterTypes[i];
                var pt = BindTypeClause(paramSyntax);
                if (pt == null)
                {
                    return null;
                }

                var isVariadicSlot = syntax.IsParameterVariadic(i);
                if (isVariadicSlot)
                {
                    anyVariadic = true;
                    if (firstVariadicSeen)
                    {
                        Diagnostics.ReportMultipleVariadicParameters(paramSyntax.Location, $"<arg{i}>");
                    }

                    firstVariadicSeen = true;
                    if (i < fnParameterTypes.Count - 1)
                    {
                        Diagnostics.ReportVariadicParameterMustBeLast(paramSyntax.Location, $"<arg{i}>");
                    }

                    // ADR-0102 follow-up / issue #818: the user writes
                    // `...T` and the stored parameter type is the slice
                    // `[]T`, matching the named-delegate convention so
                    // call-site pack / pass-through can share machinery.
                    if (pt != TypeSymbol.Error)
                    {
                        pt = VariadicCarriers.ResolveDeclaredParameterType(pt);
                    }
                }

                paramTypes.Add(pt);
                variadicFlagsBuilder.Add(isVariadicSlot);
            }

            var fnReturnTypeClauseSyntax = syntax.ReturnTypeClause;
            var ret = fnReturnTypeClauseSyntax != null ? BindTypeClause(fnReturnTypeClauseSyntax) : TypeSymbol.Void;
            if (ret == null)
            {
                return null;
            }

            if (syntax.IsAsyncFunction)
            {
                if (IsTaskShapedReturn(ret))
                {
                    Diagnostics.ReportAsyncFunctionTypeClauseHasExplicitTaskReturn(
                        Invariant.Required(fnReturnTypeClauseSyntax, "ret is task-shaped only when it was bound from an explicit return-type clause above").Location,
                        ret.Name);
                    return null;
                }

                // ADR-0041 iterator carve-out — same logic as
                // BindReturnTypeClause(isAsync=true) at function declarations.
                if (ret is SequenceTypeSymbol seq)
                {
                    ret = AsyncSequenceTypeSymbol.Get(seq.ElementType);
                }
                else
                {
                    var nt = ret as NullableTypeSymbol;
                    var innerSeq = nt?.UnderlyingType as SequenceTypeSymbol;
                    if (innerSeq != null)
                    {
                        ret = NullableTypeSymbol.Get(
                            AsyncSequenceTypeSymbol.Get(innerSeq.ElementType));
                    }
                    else if (!IsAsyncIteratorReturnType(ret))
                    {
                        ret = lambdas.WrapAsTask(ret);
                    }
                }
            }

            // Issue #3501 A2: a parameter slot may carry the ADR-0060
            // `ref`/`out`/`in` modifier — `(ref int32) -> void`. Func/Action
            // cannot represent by-ref type arguments, so such a shape binds
            // to a compiler-synthesized delegate (cached per shape, emitted
            // through the ADR-0059 named-delegate path) instead of a
            // FunctionTypeSymbol.
            if (!syntax.FunctionParameterRefKindTokens.IsDefaultOrEmpty
                && syntax.FunctionParameterRefKindTokens.Any(token => token != null))
            {
                var boundParamTypes = paramTypes.MoveToImmutable();
                var refParameters = ImmutableArray.CreateBuilder<ParameterSymbol>(boundParamTypes.Length);
                for (var i = 0; i < boundParamTypes.Length; i++)
                {
                    var refKindToken = syntax.FunctionParameterRefKindToken(i);
                    var refKind = refKindToken?.Text switch
                    {
                        "ref" => RefKind.Ref,
                        "out" => RefKind.Out,
                        "in" => RefKind.In,
                        _ => RefKind.None,
                    };
                    if (refKind != RefKind.None && syntax.IsParameterVariadic(i))
                    {
                        // ADR-0060 §8: a variadic slot cannot also carry a
                        // ref-kind modifier — same rule as declared parameters.
                        Diagnostics.ReportRefKindOnVariadicParameter(fnParameterTypes[i].Location, $"<arg{i}>");
                        refKind = RefKind.None;
                    }

                    refParameters.Add(new ParameterSymbol($"arg{i}", boundParamTypes[i], refKind: refKind));
                }

                return scope.GetSynthesizedRefDelegateCache().GetOrCreate(
                    refParameters.MoveToImmutable(),
                    ret ?? TypeSymbol.Void,
                    scope.GetCurrentDeclaringPackageName());
            }

            var variadicFlags = anyVariadic ? variadicFlagsBuilder.MoveToImmutable() : default;
            var functionType = FunctionTypeSymbol.Get(paramTypes.MoveToImmutable(), variadicFlags, ret ?? TypeSymbol.Void);
            return functionType;
        }

        if (syntax.IsTuple)
        {
            // Phase 4.5: tuple type clause `(T1, T2, ...)`. IsTuple implies the
            // parser set TupleElements and CloseParenToken.
            var tupleElements = Invariant.Required(syntax.TupleElements, "IsTuple implies the parser set TupleElements");
            if (tupleElements.Count < 2)
            {
                var closeParenToken = Invariant.Required(syntax.CloseParenToken, "IsTuple implies the parser set CloseParenToken");
                Diagnostics.ReportUnexpectedToken(closeParenToken.Location, closeParenToken.Kind, SyntaxKind.IdentifierToken);
                return null;
            }

            var elements = ImmutableArray.CreateBuilder<TypeSymbol>(tupleElements.Count);
            var elementNames = ImmutableArray.CreateBuilder<string?>(tupleElements.Count);
            var anyElementName = false;
            for (var i = 0; i < tupleElements.Count; i++)
            {
                var elementType = BindTypeClause(tupleElements[i]);
                if (elementType == null)
                {
                    return null;
                }

                elements.Add(elementType);

                // ADR-0172: `(line int32, column int32)` — the parser stored
                // each element's optional name on the element clause.
                var nameToken = tupleElements[i].TupleElementNameToken;
                elementNames.Add(nameToken?.ValueText);
                anyElementName |= nameToken != null;
            }

            var names = anyElementName ? elementNames.MoveToImmutable() : ImmutableArray<string?>.Empty;
            if (anyElementName)
            {
                TupleElementNameValidation.Validate(
                    Diagnostics,
                    names,
                    i => Invariant.Required(tupleElements[i].TupleElementNameToken, "validation only visits named elements").Location);
            }

            return TupleTypeSymbol.Get(elements.MoveToImmutable(), names);
        }

        if (syntax.IsMap)
        {
            // ADR-0104: map type clause `map[K,V]`. IsMap implies the parser
            // set MapKeyType/MapValueType.
            var keyType = BindTypeClause(Invariant.Required(syntax.MapKeyType, "IsMap implies the parser set MapKeyType"));
            var valueType = BindTypeClause(Invariant.Required(syntax.MapValueType, "IsMap implies the parser set MapValueType"));
            if (keyType == null || valueType == null)
            {
                return null;
            }

            return MapTypeSymbol.Get(keyType, valueType);
        }

        if (!syntax.HasQualifier && syntax.HasTypeArguments
            && syntax.Identifier is { Text: "managed" } managedName
            && binderCtx.CanUseIntrinsicAlias(scope, managedName, function))
        {
            var arguments = Invariant.Required(syntax.TypeArguments, "HasTypeArguments establishes the argument list");
            if (arguments.Count != 1)
            {
                Diagnostics.ReportManagedReference(syntax.Location, "managed[T] and readonly managed[T] require one referent type");
                return null;
            }

            var managedElement = BindTypeClause(arguments[0]);
            if (managedElement == null || managedElement == TypeSymbol.Error)
            {
                return null;
            }

            if (managedElement == TypeSymbol.Void || managedElement is ByRefTypeSymbol or PointerTypeSymbol or FunctionPointerTypeSymbol
                || TypeSymbol.IsByRefLike(managedElement))
            {
                Diagnostics.ReportManagedReference(arguments[0].Location, "the referent must be an ordinary heap-storable type");
                return null;
            }

            if (!ManagedReferenceTypes.TryResolveDefinition(scope.References, syntax.ReadOnlyManagedModifier != null, out var definition))
            {
                Diagnostics.ReportManagedReference(syntax.Location, "reference the matching Gsharp.Runtime.Values runtime");
                return null;
            }

            var symbolic = false;
            var clrElement = ProjectGenericArgument(managedElement, typeof(object), ref symbolic);
            return ApplyArraySuffix(syntax, ImportedTypeSymbol.GetConstructed(
                definition.MakeGenericType(clrElement), definition, ImmutableArray.Create(managedElement)));
        }

        if (!syntax.HasQualifier && syntax.HasTypeArguments
            && syntax.Identifier is { } nativeName
            && binderCtx.CanUseNativeBufferAlias(scope, nativeName, function))
        {
            var arguments = Invariant.Required(syntax.TypeArguments, "HasTypeArguments means the parser supplied a generic argument list");
            if (arguments.Count != 1)
            {
                Diagnostics.ReportNativeSliceType(syntax.Location, "slice[T] and array[T] require exactly one element type");
                return null;
            }

            var bufferElement = BindTypeClause(arguments[0]);
            if (bufferElement == null || bufferElement == TypeSymbol.Error)
            {
                return null;
            }

            if (syntax.Identifier.ValueText == "array")
            {
                return ApplyArraySuffix(syntax, SliceTypeSymbol.Get(bufferElement));
            }

            if (bufferElement == TypeSymbol.Void || bufferElement is ByRefTypeSymbol or PointerTypeSymbol or FunctionPointerTypeSymbol
                || TypeSymbol.IsByRefLike(bufferElement))
            {
                Diagnostics.ReportNativeSliceType(arguments[0].Location, "native slices require an ordinary heap-storable element type");
                return null;
            }

            if (!NativeSliceTypes.TryResolveDefinition(scope.References, syntax.ReadOnlySliceModifier != null, out var definition))
            {
                Diagnostics.ReportNativeSliceRuntime(syntax.Location);
                return null;
            }

            var symbolic = false;
            var clrElement = ProjectGenericArgument(bufferElement, typeof(object), ref symbolic);
            return ApplyArraySuffix(syntax, ImportedTypeSymbol.GetConstructed(
                definition.MakeGenericType(clrElement), definition, ImmutableArray.Create(bufferElement)));
        }

        if (syntax.IsChannel)
        {
            // ADR-0174 D2: `chan[T]` / `in chan[T]` / `out chan[T]`. The
            // parser recovers the retired `chan T` shape under GS0567 and it
            // binds here as if the canonical spelling had been written.
            var elementType = BindTypeClause(Invariant.Required(syntax.ChanElementType, "IsChannel implies the parser set ChanElementType"));
            if (elementType == null)
            {
                return null;
            }

            var direction = syntax.ChanDirectionToken?.Text switch
            {
                "in" => ChannelDirection.In,
                "out" => ChannelDirection.Out,
                _ => ChannelDirection.Both,
            };
            return ChannelTypeSymbol.Get(elementType, direction);
        }

        // Issue #1046: an array/slice whose element is itself a (non-identifier)
        // nested type clause — jagged arrays `[][]T`, arrays of pointers `[]*T`,
        // arrays of maps `[]map[K,V]`, etc. The element is bound recursively and
        // wrapped in the appropriate slice/array symbol, mirroring the flat
        // identifier-element path below.
        if (syntax.IsArray && syntax.HasNestedArrayElement)
        {
            var nestedElement = BindTypeClause(syntax.ArrayElementType);
            if (nestedElement == null)
            {
                return null;
            }

            return ApplyArraySuffix(syntax, nestedElement);
        }

        // ADR-0040: sequence type clause `sequence[T]`.
        // ADR-0042: `async sequence[T]` resolves to IAsyncEnumerable[T] in any
        // type-clause position; the unmodified `sequence[T]` stays IEnumerable[T]
        // (with the ADR-0041 implicit swap applied separately at function
        // return-type binding sites).
        if (syntax.IsSequence)
        {
            var elementType = BindTypeClause(syntax.SequenceElementType);
            if (elementType == null)
            {
                return null;
            }

            if (!ReferenceEquals(syntax, binderCtx.UnconstrainedNullableSequenceElementReturn)
                && elementType is NullableTypeSymbol { UnderlyingType: TypeParameterSymbol typeParameter }
                && !typeParameter.HasValueTypeConstraint
                && !typeParameter.HasReferenceTypeConstraint
                && typeParameter.ClassConstraint == null)
            {
                Diagnostics.ReportUnconstrainedNullableSequenceElement(
                    Invariant.Required(syntax.SequenceElementType, "IsSequence implies the parser set SequenceElementType").Location,
                    typeParameter.Name);
            }

            if (syntax.IsAsyncSequence)
            {
                return AsyncSequenceTypeSymbol.Get(elementType);
            }

            return SequenceTypeSymbol.Get(elementType);
        }

        // ADR-0039: pointer type clause `*T`.
        if (syntax.IsPointer)
        {
            var pointeeType = BindTypeClause(syntax.PointerPointeeType);
            if (pointeeType == null)
            {
                return null;
            }

            // ADR-0122 / issue #1014: inside an `unsafe` context the prefix
            // `*T` denotes an *unmanaged* raw pointer (CLR ELEMENT_TYPE_PTR),
            // which — unlike the managed by-ref form — is legal as a field,
            // local, and plain P/Invoke parameter type. Outside an unsafe
            // context `*T` keeps its historical meaning of a managed by-ref
            // pointer (ELEMENT_TYPE_BYREF, `T&`).
            if (binderCtx.InUnsafeContext)
            {
                // ADR-0122 §3 / issue #1033: `*void` is the true void-element
                // pointer (CLR ELEMENT_TYPE_PTR over ELEMENT_TYPE_VOID), the
                // faithful mapping of C# `void*`. It is an explicitly legal
                // pointer type even though `void` is not a blittable pointee:
                // it may not be dereferenced/indexed/advanced (the binder
                // rejects those — GS0403) but it round-trips through
                // `nint`/`IntPtr` and casts to/from typed pointers `*T`.
                if (pointeeType != TypeSymbol.Void
                    && !TypeSymbol.IsLegalPointeeType(pointeeType)
                    && pointeeType is not PointerTypeSymbol
                    && !BlittableDetector.IsBlittableValueStructPointee(pointeeType)
                    && pointeeType is not TypeParameterSymbol { HasUnmanagedConstraint: true })
                {
                    // ADR-0122 §4 / issue #1034: a pointer to a blittable user
                    // struct (`*Point`) is legal — accepted by the
                    // BlittableDetector check above. Issue #1336: a pointer to a
                    // generic type parameter constrained `unmanaged` (`*T`) is
                    // likewise legal — the `unmanaged` constraint guarantees the
                    // pointee is a GC-free value type, exactly as in C#. A
                    // pointer to a non-blittable struct (one that contains a
                    // managed reference / string / class field) or to any
                    // managed reference type is still rejected here with GS0398,
                    // matching C#'s unmanaged-type rule.
                    Diagnostics.ReportUnmanagedPointerIllegalPointee(Invariant.Required(syntax.PointerPointeeType, "IsPointer implies the parser set PointerPointeeType").Location, pointeeType.Name);
                    return PointerTypeSymbol.Get(pointeeType);
                }

                return PointerTypeSymbol.Get(pointeeType);
            }

            return ByRefTypeSymbol.Get(pointeeType);
        }

        // Phase 4.4 / ADR-0020: if the type clause carries a type-argument list,
        // first try to resolve the identifier as an open generic CLR type via
        // imports (mangled name `Name`N`). This lets users write `List[int]` or
        // `Dictionary[string, int]` directly. Falls through to the regular
        // identifier lookup (covering GSharp generic interfaces/structs) when
        // the import-search does not produce a match.
        // Issue #526: only enter this path for the simple single-identifier form;
        // dotted-qualifier names (`Outer.Inner`) are routed through
        // <see cref="BindQualifiedTypeName"/> below, which handles the
        // arity-mangled lookup for a generic NESTED type itself.
        // HasTypeArguments implies the parser set TypeArguments; the
        // single-identifier form (HasQualifier false) implies Identifier is
        // set (both are dereferenced unconditionally by the fallthrough
        // identifier-lookup path below too).
        var identifierToken = Invariant.Required(syntax.Identifier, "the single-identifier type-clause form has an Identifier token");
        var topLevelTypeArgumentCount = syntax.HasTypeArguments
            ? Invariant.Required(syntax.TypeArguments, "HasTypeArguments implies the parser set TypeArguments").Count
            : 0;
        if (!syntax.HasQualifier &&
            syntax.HasTypeArguments &&
            scope.TryLookupImportedGenericClass(identifierToken.ValueText, topLevelTypeArgumentCount, out var clrOpenType, out var genericAmbiguity) &&
            ImportedGenericTypeHasPrecedence(identifierToken.ValueText, topLevelTypeArgumentCount, clrOpenType))
        {
            if (genericAmbiguity != null)
            {
                Diagnostics.ReportAmbiguousImportedTypeReference(identifierToken.Location, identifierToken.ValueText, genericAmbiguity);
                return null;
            }

            var topLevelTypeArguments = Invariant.Required(syntax.TypeArguments, "HasTypeArguments implies the parser set TypeArguments");
            var clrArgs = new System.Type[topLevelTypeArguments.Count];
            var symbolicArgs = ImmutableArray.CreateBuilder<TypeSymbol>(topLevelTypeArguments.Count);
            var hasSymbolicArg = false;
            for (var i = 0; i < topLevelTypeArguments.Count; i++)
            {
                var ta = BindTypeClause(topLevelTypeArguments[i]);
                if (ta == null)
                {
                    return null;
                }

                symbolicArgs.Add(ta);

                // Issue #367: a by-ref-like (`ref struct`) type cannot be used as
                // a generic type argument (e.g. `List[Span[int32]]`); the CLR
                // forbids constructing a generic type over a by-ref-like type.
                if (TypeSymbol.IsByRefLike(ta))
                {
                    var taLocation = topLevelTypeArguments[i].Identifier?.Location ?? identifierToken.Location;
                    Diagnostics.ReportByRefLikeEscape(taLocation, ta, "be used as a generic type argument");
                    return null;
                }

                // Issue #2391: this caller alone retains the established Int32
                // ride-through for a top-level source enum.
                var erasedArgument = ta is EnumSymbol ? typeof(int) : typeof(object);
                clrArgs[i] = ProjectGenericArgument(ta, erasedArgument, ref hasSymbolicArg);
            }

            // Issue #4032: MetadataLoadContext's MakeGenericType does not
            // validate constraints, so ask them here.
            if (ReportUnsatisfiedGenericTypeConstraint(
                    Diagnostics,
                    clrOpenType,
                    clrArgs,
                    symbolicArgs.ToImmutable(),
                    identifierToken.Location))
            {
                return null;
            }

            try
            {
                var closed = clrOpenType.MakeGenericType(clrArgs);
                if (hasSymbolicArg || NativeSliceTypes.IsDefinition(closed, out _) || ManagedReferenceTypes.IsDefinition(closed, out _))
                {
                    // #313 / #671: keep the symbolic type arguments alongside
                    // the type-erased closed CLR shape so call-site inference,
                    // return-type substitution, and user-type emit can recover
                    // the real type argument.
                    return ApplyArraySuffix(syntax, ImportedTypeSymbol.GetConstructed(closed, clrOpenType, symbolicArgs.MoveToImmutable()));
                }

                // Issue #1354: a fully-concrete closed generic whose argument is a
                // nullable *reference* type (e.g. `List[string?]`) loses the inner
                // `?` when projected onto the CLR closed type (`string?` collapses
                // to `string`). Preserve it by attaching the DFS nullable-flags
                // array — the exact shape the metadata importer produces for
                // imported members (see ClrNullability) — so the emitter re-stamps
                // a `[NullableAttribute]` and the inner nullability round-trips.
                var concrete = ResolveClrTypeClauseSymbol(closed);
                if (!closed.IsValueType)
                {
                    var symArgs = symbolicArgs.ToImmutable();
                    var flagsBuilder = ImmutableArray.CreateBuilder<byte>();
                    flagsBuilder.Add(1);
                    foreach (var symArg in symArgs)
                    {
                        flagsBuilder.AddRange(GSharp.Core.CodeAnalysis.Emit.NullableFlagsBuilder.Build(symArg));
                    }

                    var flags = flagsBuilder.ToImmutable();
                    if (flags.Contains((byte)2))
                    {
                        return ApplyArraySuffix(syntax, new NullabilityAnnotatedTypeSymbol(concrete, flags));
                    }
                }

                return ApplyArraySuffix(syntax, concrete);
            }
            catch (System.ArgumentException)
            {
                Diagnostics.ReportTypeNotGeneric(identifierToken.Location, identifierToken.ValueText);
                return null;
            }
        }

        TypeSymbol? element;
        if (syntax.HasQualifier)
        {
            // Issue #526: dotted-qualifier name `Outer.Inner` (or `A.B.C`).
            // Resolves to a (possibly nested) CLR type, honoring imports for
            // the outer prefix and `Type.GetNestedType` for the remaining
            // segments. When the deepest segment is generic and the clause
            // carries a type-argument list, `BindQualifiedTypeName` constructs
            // the closed type via `MakeGenericType`.
            element = BindQualifiedTypeName(syntax);
            if (element == null)
            {
                return null;
            }

            // ADR-0047 §6 / #175: obsolete-use reporting still applies.
            ReportObsoleteUseIfApplicable(identifierToken.Location, element, element.Name);

            // BindQualifiedTypeName already consumed `syntax.TypeArguments` if
            // there was an arity match; skip the single-identifier generic
            // construction branch below by falling straight through to the
            // array-suffix path at the end of this method.
        }
        else
        {
            // Issue #1051: resolve by (name, arity) so that a same-named type
            // and a generic of different arity coexist. With a type-argument
            // list, prefer the matching generic definition; without one, prefer
            // the arity-0 type.
            var requestedArity = syntax.HasTypeArguments ? Invariant.Required(syntax.TypeArguments, "HasTypeArguments implies the parser set TypeArguments").Count : 0;
            element = LookupType(
                identifierToken.ValueText,
                requestedArity,
                out var ambiguousAcrossImportedPackages,
                out var importedTypeAmbiguity);

            // Issue #3734: unlike the source-type collision below, an imported
            // homonym still RESOLVES — first-import-wins — so the reference is
            // reported and binding continues with the chosen candidate.
            if (importedTypeAmbiguity != null)
            {
                Diagnostics.ReportAmbiguousImportedTypeReference(
                    identifierToken.Location,
                    identifierToken.ValueText,
                    importedTypeAmbiguity);
            }

            if (element == null)
            {
                // Issue #2455: "ambiguous between imported packages" and "no
                // match at all" are different failure modes and deserve
                // different diagnostics — ambiguous means two or more
                // colliding same-named top-level types are each imported, not
                // that the type is undefined.
                if (ambiguousAcrossImportedPackages)
                {
                    Diagnostics.ReportAmbiguousSourceType(identifierToken.Location, identifierToken.ValueText);
                }
                else
                {
                    Diagnostics.ReportUndefinedType(identifierToken.Location, identifierToken.ValueText);
                }

                return null;
            }

            // ADR-0047 §6 / #175: report obsolete-use for any named struct,
            // class, interface, or enum reference appearing in type position
            // (parameter types, return types, field types, generic-argument
            // positions, type aliases, etc.).
            ReportObsoleteUseIfApplicable(identifierToken.Location, element, element.Name);

            if (element is EnumSymbol nestedEnum)
            {
                element = EnumSymbol.ConstructNestedFromTypeParameterScope(
                    nestedEnum,
                    binderCtx.CurrentTypeParameters);
            }

            // Phase 4.3c / ADR-0020: handle generic type construction `Foo[T1, T2]` in
            // type position (currently interfaces; structs follow up later).
            if (syntax.HasTypeArguments)
            {
                var elementTypeArguments = Invariant.Required(syntax.TypeArguments, "HasTypeArguments implies the parser set TypeArguments");
                var typeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(elementTypeArguments.Count);
                for (var i = 0; i < elementTypeArguments.Count; i++)
                {
                    var ta = BindTypeClause(elementTypeArguments[i]);
                    if (ta == null)
                    {
                        return null;
                    }

                    // Issue #367: by-ref-like (`ref struct`) types are not permitted
                    // as generic type arguments to a user-defined generic type.
                    if (TypeSymbol.IsByRefLike(ta))
                    {
                        var taLocation = elementTypeArguments[i].Identifier?.Location ?? identifierToken.Location;
                        Diagnostics.ReportByRefLikeEscape(taLocation, ta, "be used as a generic type argument");
                        return null;
                    }

                    typeArgsBuilder.Add(ta);
                }

                var typeArgs = typeArgsBuilder.MoveToImmutable();
                if (element is InterfaceSymbol iface)
                {
                    if (!iface.IsGenericDefinition)
                    {
                        Diagnostics.ReportTypeNotGeneric(identifierToken.Location, identifierToken.ValueText);
                        return null;
                    }

                    if (iface.TypeParameters.Length != typeArgs.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(identifierToken.Location, identifierToken.ValueText, iface.TypeParameters.Length, typeArgs.Length);
                        return null;
                    }

                    // Issues #4089/#4090: a G#-declared generic INTERFACE
                    // reaches the same symbolic construction as a class, and
                    // was never constraint-checked at all — its type-parameter
                    // constraints are resolved only when its members bind,
                    // which is after every class body (#2519).
                    CheckUserGenericTypeClauseConstraints(
                        (iface.Definition ?? iface).TypeParameters,
                        typeArgs,
                        identifierToken.Location);

                    element = InterfaceSymbol.Construct(iface, typeArgs, scope.References.MapClrTypeToReferences);
                }
                else if (element is StructSymbol genericStruct)
                {
                    if (!genericStruct.IsGenericDefinition)
                    {
                        Diagnostics.ReportTypeNotGeneric(identifierToken.Location, identifierToken.ValueText);
                        return null;
                    }

                    if (genericStruct.TypeParameters.Length != typeArgs.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(identifierToken.Location, identifierToken.ValueText, genericStruct.TypeParameters.Length, typeArgs.Length);
                        return null;
                    }

                    // Issue #4067: the G#-declared twin of #4037's rule. This
                    // is the site `class Unf[T] : GsHandler[T]` reaches — a
                    // source generic base is closed by symbol substitution
                    // here, never by `Type.MakeGenericType`, so #4037's
                    // checker never sees it. Issues #4089/#4090: queued rather
                    // than asked here, and now also asks the CLOSED question.
                    CheckUserGenericTypeClauseConstraints(
                        (genericStruct.Definition ?? genericStruct).TypeParameters,
                        typeArgs,
                        identifierToken.Location);

                    element = StructSymbol.Construct(genericStruct, typeArgs, scope.References.MapClrTypeToReferences);
                }
                else if (element is DelegateTypeSymbol genericDelegate)
                {
                    // Issue #1503: a generic named delegate construction
                    // `Predicate[int32]` resolves to a constructed
                    // DelegateTypeSymbol whose parameter/return types are
                    // substituted with the supplied type arguments.
                    if (!genericDelegate.IsGenericDefinition)
                    {
                        Diagnostics.ReportTypeNotGeneric(identifierToken.Location, identifierToken.ValueText);
                        return null;
                    }

                    if (genericDelegate.TypeParameters.Length != typeArgs.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(identifierToken.Location, identifierToken.ValueText, genericDelegate.TypeParameters.Length, typeArgs.Length);
                        return null;
                    }

                    element = DelegateTypeSymbol.Construct(genericDelegate, typeArgs);
                }
                else
                {
                    Diagnostics.ReportTypeNotGeneric(identifierToken.Location, identifierToken.ValueText);
                    return null;
                }
            }
        }

        return ApplyArraySuffix(syntax, element);
    }

    /// <summary>
    /// Wraps a resolved element type in the slice/array symbol implied by the
    /// array prefix of <paramref name="syntax"/> (<c>[]T</c> → slice, <c>[N]T</c>
    /// → fixed-length array), or returns the element unchanged when the clause
    /// has no array prefix. Reports an invalid-array-length diagnostic and
    /// returns <c>null</c> when a fixed-length prefix carries a malformed length.
    /// </summary>
    /// <param name="syntax">The (possibly array-prefixed) type clause.</param>
    /// <param name="element">The already-resolved element type.</param>
    /// <returns>The slice/array symbol, the element itself, or <c>null</c> on error.</returns>
    private TypeSymbol? ApplyArraySuffix(TypeClauseSyntax syntax, TypeSymbol? element)
    {
        if (element == null || !syntax.IsArray)
        {
            return element;
        }

        // Issue #1212: a trailing `?` on an array/slice clause (`[]T?`,
        // `[N]T?`) binds to the *element* type, yielding an array whose
        // elements are nullable (`Slice(Nullable(T))` / `Array(Nullable(T))`).
        // This is orthogonal to a *nullable array reference* (`[]?T`), spelled
        // with a `?` right after `]` and handled by the outer NullableTypeSymbol
        // wrap in BindTypeClause. Element-nullable arrays stay indexable (the
        // array itself is non-nil), reading/writing `T?`.
        if (syntax.IsNullable)
        {
            element = NullableTypeSymbol.Get(element);
        }

        if (syntax.IsSlice)
        {
            return SliceTypeSymbol.Get(element);
        }

        if (syntax.RectangularRank > 1)
        {
            if (syntax.RectangularRank > 32)
            {
                Diagnostics.ReportRectangularArrayRankTooLarge(syntax.Location, syntax.RectangularRank);
                return null;
            }

            return RectangularArrayTypeSymbol.Get(element, syntax.RectangularRank);
        }

        // IsSlice (checked above, false here) is exactly "bracketed AND no
        // length token", so a non-slice array clause has a length token.
        var lengthToken = Invariant.Required(syntax.LengthToken, "a non-slice array type clause has a length token");
        if (!int.TryParse(lengthToken.Text, out var length) || length < 0)
        {
            Diagnostics.ReportInvalidArrayLength(lengthToken.Location, lengthToken.Text);
            return null;
        }

        return ArrayTypeSymbol.Get(element, length);
    }

    private TypeSymbol? BindTypeClause(TypeClauseSyntax? syntax)
    {
        if (syntax == null)
        {
            return null;
        }

        // Issue #3336: merged partial type clauses retain the declaring part's tree.
        var bindingScope = scope;
        var previousTree = bindingScope.SetCurrentReferencingSyntaxTree(syntax.SyntaxTree);
        try
        {
            var bound = BindNonNullableTypeClause(syntax);
            if (bound == null)
            {
                return null;
            }

            if (syntax.ReadOnlyManagedModifier != null)
            {
                if (!ManagedReferenceTypes.TryGetElement(bound, out var element, out var alreadyReadOnly))
                {
                    Diagnostics.ReportManagedReference(syntax.ReadOnlyManagedModifier.Location, "readonly requires the native managed-reference category; use Gsharp.Values.ReadOnlyManagedRef[T] explicitly when managed is shadowed");
                    return null;
                }

                if (!alreadyReadOnly)
                {
                    if (!ManagedReferenceTypes.TryResolveDefinition(scope.References, true, out var definition))
                    {
                        Diagnostics.ReportManagedReference(syntax.Location, "reference the matching Gsharp.Runtime.Values runtime");
                        return null;
                    }

                    var symbolic = false;
                    bound = ImportedTypeSymbol.GetConstructed(
                        definition.MakeGenericType(ProjectGenericArgument(element, typeof(object), ref symbolic)),
                        definition,
                        ImmutableArray.Create(element));
                }
            }

            if (syntax.ReadOnlySliceModifier != null)
            {
                if (!NativeSliceTypes.TryGetElement(bound, out var nativeElement, out var alreadyReadOnly))
                {
                    Diagnostics.ReportNativeSliceType(syntax.ReadOnlySliceModifier.Location, "readonly requires the native slice category; use Gsharp.Values.ReadOnlySlice[T] explicitly when slice is shadowed");
                    return null;
                }

                if (!alreadyReadOnly)
                {
                    if (!NativeSliceTypes.TryResolveDefinition(scope.References, true, out var readOnlyDefinition))
                    {
                        Diagnostics.ReportNativeSliceRuntime(syntax.Location);
                        return null;
                    }

                    var symbolic = false;
                    bound = ImportedTypeSymbol.GetConstructed(
                        readOnlyDefinition.MakeGenericType(ProjectGenericArgument(nativeElement, typeof(object), ref symbolic)),
                        readOnlyDefinition,
                        ImmutableArray.Create(nativeElement));
                }
            }

            // Issue #1212: for an array/slice clause the trailing `?` is consumed
            // by ApplyArraySuffix and applied to the element type (`[]T?`), so it
            // must not also wrap the whole array. The *array* is made nullable only
            // by an explicit `?` right after `]` (`[]?T` → `ArrayQuestionToken`).
            if (syntax.IsArray)
            {
                bound = syntax.IsArrayNullable ? NullableTypeSymbol.Get(bound) : bound;
            }
            else if (syntax.IsNullable)
            {
                bound = NullableTypeSymbol.Get(bound);
            }

            // Issue #3315 / ADR-0159 addendum: the `?` after the closing `)` of a
            // parenthesized type clause marks the WHOLE inner type nullable —
            // `(chan int32)?` is a nullable channel, `([]T)?` equals `[]?T`. The
            // already-nullable guard makes redundant spellings like `(int32?)?`
            // collapse instead of double-wrapping.
            if (syntax.IsParenthesizedNullable && bound is not NullableTypeSymbol)
            {
                bound = NullableTypeSymbol.Get(bound);
            }

            return bound;
        }
        finally
        {
            bindingScope.SetCurrentReferencingSyntaxTree(previousTree);
        }
    }

    /// <summary>
    /// Issue #526 / #1506: resolves a dotted-qualifier type clause (<c>Outer.Inner</c>,
    /// <c>A.B.C</c>, <c>List[int32].Enumerator</c>) to a <see cref="TypeSymbol"/>
    /// wrapping a (possibly nested, possibly constructed) CLR type.
    /// <para>
    /// Strategy: enumerate "split points" between an outer prefix that is a
    /// fully-qualified type name and the remaining segments that name nested
    /// types of that outer. The longest viable outer prefix wins, which lets
    /// callers write both <c>Outer.Inner</c> (with <c>import Probe.CSharp</c>
    /// providing the namespace prefix) and the fully-qualified
    /// <c>Probe.CSharp.Outer.Inner</c>. A single trailing type-argument list
    /// attaches to the deepest (last) segment so a nested generic such as
    /// <c>Outer.Generic[int]</c> resolves to the constructed
    /// <c>Outer.Generic`1</c> closed type.
    /// </para>
    /// <para>
    /// Per-segment type-argument syntax (e.g. <c>Outer[T].Inner</c>,
    /// <c>List[int32].Enumerator</c>, <c>A[T].B[U].C</c>) is now fully expressible:
    /// the parser records a type-argument list per qualifier segment (see
    /// <see cref="TypeClauseSyntax.GetSegmentTypeArguments"/>), and
    /// <see cref="BindPerSegmentClrQualifiedTypeName"/> resolves the nested type against
    /// the <em>constructed</em> outer — the nested CLR type definition (which carries the
    /// outer's generic parameters) closed over the outer's type arguments plus each nested
    /// segment's own arguments — rather than the open definition.
    /// </para>
    /// </summary>
    /// <summary>
    /// Issue #1069: returns the enclosing type of a (possibly nested) user type
    /// symbol — the value set via <c>SetContainingType</c> during declaration
    /// binding — or <c>null</c> for a top-level type or a non-aggregate symbol.
    /// </summary>
    private static TypeSymbol? SymbolContainingType(TypeSymbol type) => type switch
    {
        StructSymbol s => s.ContainingType,
        EnumSymbol e => e.ContainingType,
        InterfaceSymbol i => i.ContainingType,
        _ => null,
    };

    /// <summary>
    /// Issue #1069 / #1506: resolves a dotted type clause (<c>Outer.Entry</c>,
    /// <c>Outer.Middle.Inner</c>, <c>Outer[int32].Inner</c>) to a user-defined nested type
    /// declared in the current compilation, by walking the enclosing-type chain. Each segment
    /// after the first must name a type whose enclosing type is the symbol resolved for the
    /// preceding segment. Type arguments may appear on <em>any</em> segment (issue #1506): the
    /// deepest segment's arguments construct the returned closed generic, and every earlier
    /// (outer) generic segment's arguments are bound and validated against that segment's
    /// definition. Returns <c>null</c> when the chain does not resolve to such a user nested
    /// type, letting the caller fall back to the reflection-based CLR nested-type walk. Array
    /// suffixes are applied by the caller.
    /// </summary>
    private TypeSymbol? TryResolveUserNestedTypeChain(TypeClauseSyntax syntax, string[] segmentTexts)
    {
        if (segmentTexts.Length < 2)
        {
            return null;
        }

        // SegmentHasTypeArguments(i) true implies GetSegmentTypeArguments(i)
        // is non-null (both read the same underlying per-segment slot).
        SeparatedSyntaxList<TypeClauseSyntax> SegmentTypeArguments(int index) => Invariant.Required(
            syntax.GetSegmentTypeArguments(index),
            "SegmentHasTypeArguments(index) was true, and both read the same per-segment slot");

        var headArity = syntax.SegmentHasTypeArguments(0) ? SegmentTypeArguments(0).Count : -1;
        var definitions = new TypeSymbol?[segmentTexts.Length];
        definitions[0] = LookupType(segmentTexts[0], headArity > 0 ? headArity : -1);
        if (definitions[0] == null)
        {
            return null;
        }

        // Every entry from here on is set to a non-null value in the loop
        // below, or the loop returns null (unresolved segment) before this
        // method uses definitions[] again — so once execution reaches the
        // construction pass past the loop, every entry is populated.
        TypeSymbol ResolvedDefinition(int index) => Invariant.Required(
            definitions[index],
            "the segment-resolution loop above either populates every definitions[] entry or returns null before this method reads one");

        for (var i = 1; i < segmentTexts.Length; i++)
        {
            // Issue #1174: resolve each non-head segment as a nested type of the
            // previously-resolved container, NOT by global simple name. A bare
            // simple-name lookup returns a same-named top-level homonym, which
            // then fails the containment check and breaks `Container.Nested`
            // references. Issue #1506: each segment now drives its own preferred
            // arity from its own type-argument list.
            var preferredArity = syntax.SegmentHasTypeArguments(i) ? SegmentTypeArguments(i).Count : -1;
            var previousDefinition = ResolvedDefinition(i - 1);
            if (scope.TryLookupNestedTypeAlias(previousDefinition, segmentTexts[i], preferredArity, out var nested))
            {
                definitions[i] = nested;
                continue;
            }

            var containerStruct = previousDefinition as StructSymbol;
            if (containerStruct != null
                && scope.TryLookupNestedTypeAliasIncludingInherited(
                    containerStruct,
                    segmentTexts[i],
                    preferredArity,
                    out var inheritedNested,
                    out var declaringContainer))
            {
                definitions[i - 1] = declaringContainer;
                definitions[i] = inheritedNested;
                continue;
            }

            return null;
        }

        // The chain resolved to a user nested type. Construct generic segments
        // against their definitions: the deepest segment yields the returned
        // closed type; every earlier (outer) generic segment is bound and
        // validated so a malformed `Outer[bad].Inner` is diagnosed here rather
        // than falling through to a confusing CLR-path error.
        var deepest = ResolvedDefinition(segmentTexts.Length - 1);
        var constructedSegments = new TypeSymbol[segmentTexts.Length];
        for (var i = 0; i < segmentTexts.Length; i++)
        {
            constructedSegments[i] = ResolvedDefinition(i);
            if (!syntax.SegmentHasTypeArguments(i))
            {
                continue;
            }

            // This method resolves a dotted-qualifier chain, so its head
            // segment always has an Identifier token.
            var headIdentifier = Invariant.Required(syntax.Identifier, "a dotted-qualifier type-clause chain has a head Identifier");
            var segmentName = i == 0 ? headIdentifier.ValueText : string.Join(".", segmentTexts, 0, i + 1);
            var segmentLocation = i == 0 ? headIdentifier.Location : syntax.QualifierIdentifierTokens[i - 1].Location;
            var constructed = BindAndConstructUserGenericSegment(syntax, ResolvedDefinition(i), SegmentTypeArguments(i), segmentLocation, segmentName);
            if (constructed == null)
            {
                return null;
            }

            constructedSegments[i] = constructed;
            if (i == segmentTexts.Length - 1)
            {
                deepest = constructed;
            }
        }

        // Issue #1521: when the deepest segment is a type nested inside one or
        // more constructed generic enclosing segments (e.g. `Box[int32].Tag`),
        // thread the flattened enclosing construction's type arguments
        // (outermost-first) onto the nested type so a use-site reference /
        // slot encodes `Box`1+Tag`1<int32>` rather than the open
        // self-instantiation `Box`1+Tag`1<!0>`. This mirrors the enclosing-arg
        // threading the binder applies to a nested type surfaced from within a
        // constructed enclosing member (e.g. the return of `Box[int32].MakeTag()`),
        // so the two representations are reference-equal and interconvertible.
        //
        // Issue #1537: when the deepest segment ITSELF carries own type
        // arguments (`Outer[int32].Middle[string]`), thread BOTH the enclosing
        // construction's arguments and the nested type's own arguments so member
        // lookup substitutes both levels and the emitter encodes
        // `Outer`1+Middle`2<int32, string>`.
        var enclosingArgs = CollectConstructedEnclosingArguments(constructedSegments, segmentTexts.Length - 1);
        if (deepest is StructSymbol deepestStruct)
        {
            if (!enclosingArgs.IsDefaultOrEmpty)
            {
                var ownArgs = deepestStruct.TypeArguments;
                deepest = ownArgs.IsDefaultOrEmpty
                    ? StructSymbol.ConstructNested(deepestStruct.Definition ?? deepestStruct, enclosingArgs, scope.References.MapClrTypeToReferences)
                    : StructSymbol.ConstructNestedGeneric(deepestStruct.Definition ?? deepestStruct, enclosingArgs, ownArgs, scope.References.MapClrTypeToReferences);
            }
        }
        else if (deepest is EnumSymbol deepestEnum && !enclosingArgs.IsDefaultOrEmpty)
        {
            deepest = EnumSymbol.ConstructNested(deepestEnum.Definition ?? deepestEnum, enclosingArgs);
        }

        return deepest;
    }

    /// <summary>
    /// Issue #1521: gathers the flattened type arguments of the constructed
    /// generic enclosing segments (outermost-first) of a nested type-clause
    /// chain, aligned 1:1 with <see cref="StructSymbol.CollectEnclosingTypeParameters"/>.
    /// Returns <c>default</c> when no enclosing segment is a constructed
    /// generic, or when a generic enclosing segment was left open (its
    /// parameters could not be threaded), so the caller keeps the open nested
    /// definition unchanged.
    /// </summary>
    /// <param name="constructedSegments">The per-segment constructed (or open) type symbols.</param>
    /// <param name="deepestIndex">The index of the deepest (nested) segment; enclosing segments are those before it.</param>
    /// <returns>The flattened enclosing type-argument vector, or <c>default</c>.</returns>
    private static ImmutableArray<TypeSymbol> CollectConstructedEnclosingArguments(TypeSymbol[] constructedSegments, int deepestIndex)
    {
        ImmutableArray<TypeSymbol>.Builder? builder = null;
        for (var i = 0; i < deepestIndex; i++)
        {
            var seg = constructedSegments[i];
            var ownParams = seg switch
            {
                StructSymbol s => (s.Definition ?? s).TypeParameters,
                InterfaceSymbol iface => (iface.Definition ?? iface).TypeParameters,
                _ => ImmutableArray<TypeParameterSymbol>.Empty,
            };

            if (ownParams.IsDefaultOrEmpty)
            {
                // Non-generic enclosing segment contributes no enclosing params.
                continue;
            }

            var ownArgs = seg switch
            {
                StructSymbol s => s.TypeArguments,
                InterfaceSymbol iface => iface.TypeArguments,
                _ => ImmutableArray<TypeSymbol>.Empty,
            };

            if (ownArgs.IsDefaultOrEmpty || ownArgs.Length != ownParams.Length)
            {
                // A generic enclosing segment was left open — cannot thread a
                // concrete enclosing-argument vector, so keep the nested type open.
                return default;
            }

            builder ??= ImmutableArray.CreateBuilder<TypeSymbol>();
            builder.AddRange(ownArgs);
        }

        return builder?.ToImmutable() ?? default;
    }

    /// <summary>
    /// Issue #1506: binds the type-argument clauses of one segment of a user-defined dotted
    /// type name and constructs the corresponding closed generic (<see cref="StructSymbol"/>,
    /// <see cref="InterfaceSymbol"/>, or <see cref="DelegateTypeSymbol"/>). Reports the usual
    /// by-ref-like, wrong-arity, and not-generic diagnostics and returns <c>null</c> on error.
    /// </summary>
    private TypeSymbol? BindAndConstructUserGenericSegment(
        TypeClauseSyntax syntax,
        TypeSymbol definition,
        SeparatedSyntaxList<TypeClauseSyntax> argumentList,
        TextLocation location,
        string displayName)
    {
        var typeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(argumentList.Count);
        foreach (var taSyntax in argumentList)
        {
            var ta = BindTypeClause(taSyntax);
            if (ta == null)
            {
                return null;
            }

            if (TypeSymbol.IsByRefLike(ta))
            {
                Diagnostics.ReportByRefLikeEscape(taSyntax.Identifier?.Location ?? location, ta, "be used as a generic type argument");
                return null;
            }

            typeArgsBuilder.Add(ta);
        }

        var typeArgs = typeArgsBuilder.MoveToImmutable();
        switch (definition)
        {
            case StructSymbol genericStruct when genericStruct.IsGenericDefinition && genericStruct.TypeParameters.Length == typeArgs.Length:
                // Issue #4067: the qualified spelling of the same construction.
                // Issues #4089/#4090: queued, and the CLOSED question asked too.
                CheckUserGenericTypeClauseConstraints(
                    (genericStruct.Definition ?? genericStruct).TypeParameters,
                    typeArgs,
                    location);
                return StructSymbol.Construct(genericStruct, typeArgs, scope.References.MapClrTypeToReferences);
            case InterfaceSymbol genericIface when genericIface.IsGenericDefinition && genericIface.TypeParameters.Length == typeArgs.Length:
                // Issues #4089/#4090: the qualified spelling of the interface
                // construction, which asked nothing at all before.
                CheckUserGenericTypeClauseConstraints(
                    (genericIface.Definition ?? genericIface).TypeParameters,
                    typeArgs,
                    location);
                return InterfaceSymbol.Construct(genericIface, typeArgs, scope.References.MapClrTypeToReferences);
            case DelegateTypeSymbol genericDelegate when genericDelegate.IsGenericDefinition && genericDelegate.TypeParameters.Length == typeArgs.Length:
                return DelegateTypeSymbol.Construct(genericDelegate, typeArgs);
            default:
                Diagnostics.ReportTypeNotGeneric(location, displayName);
                return null;
        }
    }

    private TypeSymbol? BindQualifiedTypeName(TypeClauseSyntax syntax)
    {
        // Callers only reach this method for a dotted-qualifier name
        // (syntax.HasQualifier), which always has a head Identifier.
        var qualifiedIdentifier = Invariant.Required(syntax.Identifier, "a dotted-qualifier type clause has a head Identifier");
        var totalSegments = 1 + syntax.QualifierIdentifierTokens.Length;
        var segmentTexts = new string[totalSegments];
        segmentTexts[0] = qualifiedIdentifier.ValueText;
        for (var i = 0; i < syntax.QualifierIdentifierTokens.Length; i++)
        {
            segmentTexts[1 + i] = syntax.QualifierIdentifierTokens[i].Text;
        }

        // HasTypeArguments implies the parser set TypeArguments.
        var qualifiedTypeArguments = syntax.TypeArguments;
        var targetArity = syntax.HasTypeArguments ? Invariant.Required(qualifiedTypeArguments, "HasTypeArguments implies the parser set TypeArguments").Count : 0;

        // Issue #1069: a dotted name may reference a *user-defined* nested type
        // declared in the current compilation (e.g. `Outer.Entry`,
        // `Outer.Color`). Such types have no reflectable CLR `Type` while we are
        // still binding, so the reflection-based prefix walk below cannot see
        // them. Resolve them symbolically through the enclosing-type chain first.
        var userNested = TryResolveUserNestedTypeChain(syntax, segmentTexts);
        if (userNested != null)
        {
            return userNested;
        }

        // Issue #1506: a nested type named on a *constructed* generic outer —
        // `List[int32].Enumerator`, `Dictionary[string, int32].Enumerator`,
        // `A[T].B[U].C` — places type arguments on an outer segment and then dots
        // into a nested type. Resolve the nested type against the constructed
        // outer (the nested CLR type def closed over the outer's arguments plus
        // each nested segment's own arguments). Only the genuinely per-segment
        // form takes this path; the single-trailing-list and non-generic dotted
        // forms keep the greedy prefix walk below unchanged.
        if (syntax.HasOuterSegmentTypeArguments)
        {
            return BindPerSegmentClrQualifiedTypeName(syntax, segmentTexts);
        }

        // Issue #3907: a SOURCE declaration outranks an imported one carrying
        // the same fully-qualified name. The greedy reflection walk below only
        // sees types with a CLR representation, and a same-compilation type has
        // none while binding — so whenever the reference set happens to contain
        // `Pkg.Name` too, the walk bound the METADATA type and the source
        // declaration was never consulted. That is backwards from C#, which
        // resolves the collision in favour of source (Roslyn reports CS0436 and
        // uses the source type).
        //
        // It bites hardest when an assembly is compiled against a build of
        // ITSELF, which is the normal state for `Gsharp.Runtime.Channels`: gsc
        // appends the bundled channel runtime to every reference set
        // (ReferenceResolver.FindBundledChannelsRuntimePath), so while compiling
        // the runtime's own sources every `Gsharp.Concurrency.X` in a base
        // clause resolved to the PREVIOUS build's `X`. `class TaskArm[T] :
        // Gsharp.Concurrency.TaskArm` therefore linked its base to another
        // assembly's `TaskArm`, and the three diagnostics that followed —
        // GS0214 (no accessible 2-arg base constructor), GS0185 (override does
        // not match the base), GS0155 (`TaskArm[T]` is not an `ArmDescriptor`)
        // — were all one wrong base link. The bare-name spelling was already
        // correct, which is why only the QUALIFIED spelling failed.
        //
        // Scoped tightly on purpose, in TWO ways.
        //
        // First (see TryLookupSourceTypeInPackage): the qualifier must exactly
        // name a package this compilation declares, and that package must
        // declare this name at this arity.
        //
        // Second, and just as important: there must ACTUALLY BE an imported
        // homonym to beat. This rule is only about a source-vs-metadata
        // collision — C#'s CS0436 — so it must not reorder a source-vs-SOURCE
        // question, which is governed by ordinary scope shadowing and not by
        // this probe. Issue #3466 is the case that pins it down: inside
        // `Holder`, which declares a nested `Target`, the name
        // `Demo.Target` has no CLR type at all, so the walk below and the
        // simple-name fallback under it keep resolving it exactly as they did.
        // Without this second condition the type clause started disagreeing
        // with the construction expression beside it — the type resolved to the
        // top-level `Demo.Target` while `Demo.Target()` still resolved to
        // `Holder.Target`, giving `GS0155 Cannot convert 'Holder.Target' to
        // 'Target'`. (That disagreement is a real pre-existing gap in the
        // QUALIFIED-construction path, which resolves a package-qualified name
        // by inner-scope simple name; it is reported separately rather than
        // widened into here.)
        if (scope.TryLookupSourceTypeInPackage(
                string.Join(".", segmentTexts, 0, totalSegments - 1),
                segmentTexts[totalSegments - 1],
                targetArity,
                out var packageQualifiedSourceType)
            && TryResolveOuterPrefix(segmentTexts, totalSegments, targetArity) != null)
        {
            if (targetArity == 0)
            {
                return packageQualifiedSourceType;
            }

            var constructedSourceType = BindAndConstructUserGenericSegment(
                syntax,
                packageQualifiedSourceType,
                Invariant.Required(qualifiedTypeArguments, "targetArity != 0 implies HasTypeArguments was true, so TypeArguments is non-null"),
                qualifiedIdentifier.Location,
                syntax.DottedName);
            if (constructedSourceType != null)
            {
                return constructedSourceType;
            }
        }

        // Greedy: prefer the longest outer prefix that resolves to a real type,
        // then walk the remaining segments as nested types. Going longest-first
        // lets a fully-qualified `Probe.CSharp.Outer` win without being misled
        // by a single-name `Probe` that happens to exist somewhere.
        for (var outerLen = totalSegments; outerLen >= 1; outerLen--)
        {
            // When the whole dotted name IS the (generic) type — the trailing
            // type-argument list belongs to the deepest prefix segment — the
            // metadata name is arity-mangled (`Ns.IFoo`1`). Pass the target
            // arity so a namespace-qualified generic user/CLR type resolves
            // (issue: qualified generic type-name/constraint resolution).
            var prefixArity = outerLen == totalSegments ? targetArity : 0;
            var clrType = TryResolveOuterPrefix(segmentTexts, outerLen, prefixArity);
            if (clrType == null)
            {
                continue;
            }

            // Walk remaining segments as nested types. For the deepest segment,
            // if the clause has type arguments, prefer the arity-mangled
            // generic nested type so `Outer.Generic[T]` matches `Outer+Generic`1`.
            var walked = WalkNestedSegments(clrType, segmentTexts, outerLen, totalSegments, targetArity);
            if (walked != null)
            {
                return ConstructIfGeneric(walked, syntax, targetArity);
            }
        }

        // Same-compilation package-qualified source type: the qualifier segments
        // form a package/namespace prefix and the final segment names a source
        // type declared in this compilation (e.g. `Oahu.Decrypt.INewSplitCallback[T]`
        // referenced from within package `Oahu.Decrypt`). Source types are visible
        // by simple name across packages, but the reflection-based prefix walk
        // above only sees types with a CLR representation, so a source type — which
        // has none while binding — never resolves through it. Fall back to a
        // simple-name lookup of the final segment, honoring the trailing arity.
        // cs2gs fully-qualifies type references (including generic-math
        // constraints), so this is the common shape for translated code.
        var lastSegment = segmentTexts[totalSegments - 1];

        // Issue #3880: the simple-name fallback below refuses to guess when two
        // or more separately-imported packages declare the same simple name
        // (#2455's ambiguity rule) — but here the reference is not ambiguous at
        // all: its qualifier names the package outright. Publish that qualifier
        // as the explicit package hint #2455 already honours for qualified
        // CONSTRUCTION (`Pkg.Type{…}`), so `typeof(ImportedVisible.defer_)`
        // resolves even when a second imported package also declares `defer_`.
        // The hint is restored unconditionally: it is scoped to this one
        // lookup, exactly as at the construction site.
        var qualifierPackageHint = string.Join(".", segmentTexts, 0, totalSegments - 1);
        var previousQualifierHint = scope.SetQualifiedConstructionPackageHint(qualifierPackageHint);
        TypeSymbol? sourceType;
        try
        {
            sourceType = LookupType(lastSegment, targetArity > 0 ? targetArity : -1);
        }
        finally
        {
            scope.SetQualifiedConstructionPackageHint(previousQualifierHint);
        }

        if (sourceType != null && !ReferenceEquals(sourceType, TypeSymbol.Error))
        {
            if (targetArity == 0)
            {
                return sourceType;
            }

            var constructed = BindAndConstructUserGenericSegment(
                syntax,
                sourceType,
                Invariant.Required(qualifiedTypeArguments, "targetArity != 0 implies HasTypeArguments was true, so TypeArguments is non-null"),
                qualifiedIdentifier.Location,
                syntax.DottedName);
            if (constructed != null)
            {
                return constructed;
            }
        }

        // Could not resolve. Pinpoint the failing segment so the diagnostic is
        // actionable: if even the outermost simple name doesn't exist, report
        // a regular "undefined type". Otherwise walk from the outermost
        // resolvable segment and emit "Outer does not contain a nested type
        // 'X'" for the first failing segment.
        var outermost = LookupType(qualifiedIdentifier.ValueText);
        if (outermost == null)
        {
            Diagnostics.ReportUndefinedType(qualifiedIdentifier.Location, syntax.DottedName);
            return null;
        }

        var current = outermost.ClrType;
        if (current == null)
        {
            // Outer is a built-in / GSharp-defined type with no CLR
            // representation reachable here; just report it as undefined.
            Diagnostics.ReportUndefinedType(qualifiedIdentifier.Location, syntax.DottedName);
            return null;
        }

        var lastGoodName = qualifiedIdentifier.ValueText;
        for (var i = 0; i < syntax.QualifierIdentifierTokens.Length; i++)
        {
            var segmentText = syntax.QualifierIdentifierTokens[i].Text;
            var isLast = i == syntax.QualifierIdentifierTokens.Length - 1;
            Type? next = null;
            if (isLast && targetArity > 0)
            {
                scope.References.TryResolveNestedType(current, segmentText + "`" + targetArity, out next);
            }

            if (next == null)
            {
                scope.References.TryResolveNestedType(current, segmentText, out next);
            }

            if (next == null)
            {
                Diagnostics.ReportUndefinedNestedType(
                    syntax.QualifierIdentifierTokens[i].Location,
                    lastGoodName,
                    segmentText);
                return null;
            }

            current = next;
            lastGoodName = lastGoodName + "." + segmentText;
        }

        // Walk succeeded but ConstructIfGeneric must have failed; surface a
        // generic-mismatch diagnostic as a fallback.
        Diagnostics.ReportTypeNotGeneric(qualifiedIdentifier.Location, syntax.DottedName);
        return null;
    }

    /// <summary>
    /// Issue #526: resolves the first <paramref name="outerLen"/> segments of
    /// <paramref name="segmentTexts"/> joined by <c>.</c> to a single CLR
    /// type. Honors aliases and the active import set for one-segment
    /// prefixes, and the active import set as a namespace prefix for
    /// multi-segment prefixes.
    /// </summary>
    private Type? TryResolveOuterPrefix(string[] segmentTexts, int outerLen, int lastSegmentArity = 0)
    {
        if (outerLen == 1)
        {
            var symbol = LookupType(segmentTexts[0], lastSegmentArity > 0 ? lastSegmentArity : -1);
            return symbol?.ClrType;
        }

        var prefix = string.Join(".", segmentTexts, 0, outerLen);

        // A generic type's metadata name is arity-mangled (`Ns.IFoo`1`); when
        // the deepest prefix segment carries the trailing type-argument list,
        // try the mangled name first so a namespace-qualified generic type
        // resolves to its open definition (closed later by ConstructIfGeneric).
        if (lastSegmentArity > 0)
        {
            var mangled = prefix + "`" + lastSegmentArity;
            if (scope.References.TryResolveType(mangled, out var directGeneric))
            {
                return directGeneric;
            }

            foreach (var import in scope.GetDeclaredImports())
            {
                if (scope.References.TryResolveType(import.Target + "." + mangled, out var viaImportGeneric))
                {
                    return viaImportGeneric;
                }
            }
        }

        if (scope.References.TryResolveType(prefix, out var direct))
        {
            return direct;
        }

        foreach (var import in scope.GetDeclaredImports())
        {
            if (scope.References.TryResolveType(import.Target + "." + prefix, out var viaImport))
            {
                return viaImport;
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #526: walks <paramref name="segmentTexts"/> starting at
    /// <paramref name="start"/>, treating each remaining segment as a nested
    /// type on <paramref name="container"/>. For the deepest segment, when
    /// <paramref name="targetArity"/> &gt; 0 the arity-mangled name
    /// (<c>Name`N</c>) is preferred so a nested generic such as
    /// <c>Outer.Generic[T]</c> matches.
    /// Returns <c>null</c> when any segment fails to resolve.
    /// </summary>
    private Type? WalkNestedSegments(Type container, string[] segmentTexts, int start, int end, int targetArity)
    {
        var current = container;
        for (var i = start; i < end; i++)
        {
            var name = segmentTexts[i];
            var isLast = i == end - 1;
            Type? next = null;
            if (isLast && targetArity > 0)
            {
                scope.References.TryResolveNestedType(current, name + "`" + targetArity, out next);
            }

            if (next == null)
            {
                scope.References.TryResolveNestedType(current, name, out next);
            }

            if (next == null)
            {
                return null;
            }

            current = next;
        }

        return current;
    }

    /// <summary>
    /// Issue #526: when the resolved CLR <paramref name="clrType"/> is a
    /// generic type definition and the clause carries a type-argument list,
    /// binds each argument and calls <see cref="Type.MakeGenericType(Type[])"/>
    /// to produce the constructed type. Non-generic resolutions pass through
    /// unchanged. A type-arguments-on-a-non-generic mismatch surfaces a
    /// <c>ReportTypeNotGeneric</c> diagnostic.
    /// </summary>
    private TypeSymbol? ConstructIfGeneric(Type clrType, TypeClauseSyntax syntax, int targetArity)
    {
        if (targetArity == 0)
        {
            return ResolveClrTypeClauseSymbol(clrType);
        }

        // targetArity > 0 is only ever computed from HasTypeArguments (or an
        // equivalent per-segment discriminator) being true, which implies the
        // parser set both Identifier and TypeArguments.
        var identifierToken = Invariant.Required(syntax.Identifier, "targetArity > 0 implies a type-argument-bearing clause, which has an Identifier");
        var typeArguments = Invariant.Required(syntax.TypeArguments, "targetArity > 0 implies the parser set TypeArguments");

        if (!clrType.IsGenericTypeDefinition)
        {
            Diagnostics.ReportTypeNotGeneric(identifierToken.Location, syntax.DottedName);
            return null;
        }

        var clrArgs = new Type[targetArity];
        var symbolicArgs = ImmutableArray.CreateBuilder<TypeSymbol>(targetArity);
        var hasSymbolicArg = false;
        for (var i = 0; i < targetArity; i++)
        {
            var ta = BindTypeClause(typeArguments[i]);
            if (ta == null)
            {
                return null;
            }

            symbolicArgs.Add(ta);

            // Issue #367: by-ref-like types cannot serve as generic arguments.
            if (TypeSymbol.IsByRefLike(ta))
            {
                var taLocation = typeArguments[i].Identifier?.Location ?? identifierToken.Location;
                Diagnostics.ReportByRefLikeEscape(taLocation, ta, "be used as a generic type argument");
                return null;
            }

            clrArgs[i] = ProjectGenericArgument(ta, typeof(object), ref hasSymbolicArg);
        }

        // Issue #4032: MetadataLoadContext's MakeGenericType does not validate
        // constraints, so ask them here.
        if (ReportUnsatisfiedGenericTypeConstraint(
                Diagnostics,
                clrType,
                clrArgs,
                symbolicArgs.ToImmutable(),
                identifierToken.Location))
        {
            return null;
        }

        try
        {
            var closed = clrType.MakeGenericType(clrArgs);
            if (hasSymbolicArg || NativeSliceTypes.IsDefinition(closed, out _) || ManagedReferenceTypes.IsDefinition(closed, out _))
            {
                return ImportedTypeSymbol.GetConstructed(closed, clrType, symbolicArgs.MoveToImmutable());
            }

            return ResolveClrTypeClauseSymbol(closed);
        }
        catch (System.ArgumentException)
        {
            Diagnostics.ReportTypeNotGeneric(identifierToken.Location, syntax.DottedName);
            return null;
        }
    }

    /// <summary>
    /// Issue #1506: resolves a dotted type clause that places type arguments on an OUTER
    /// segment and then dots into a nested type — <c>List[int32].Enumerator</c>,
    /// <c>Dictionary[string, int32].Enumerator</c>, <c>A[T].B[U].C</c> — to the nested CLR
    /// type closed over the <em>constructed</em> outer.
    /// <para>
    /// A nested type of a generic outer is reflected as the outer's open nested type
    /// definition (e.g. <c>List`1+Enumerator</c>), which inherits the outer's generic
    /// parameters. Resolution therefore (1) finds the longest viable outer prefix —
    /// whose trailing segment may be a generic type carrying the outer's arguments while
    /// every earlier prefix segment is a plain namespace component — keeping it OPEN, then
    /// (2) walks the remaining segments as nested types (each preferring its OWN
    /// arity-mangled name), and finally (3) constructs the deepest definition via
    /// <see cref="Type.MakeGenericType(Type[])"/> over the cumulative argument vector
    /// (outer segment's arguments followed, in source order, by each nested segment's own
    /// arguments) — matching how reflection orders <see cref="Type.GetGenericArguments"/>.
    /// </para>
    /// </summary>
    private TypeSymbol? BindPerSegmentClrQualifiedTypeName(TypeClauseSyntax syntax, string[] segmentTexts)
    {
        var segmentCount = segmentTexts.Length;

        // Greedy longest-prefix: segments[0..outerLen-1] form a (possibly generic)
        // outer type name; segments[outerLen..] are nested types of it. Type
        // arguments may appear only on the LAST prefix segment (the generic outer);
        // earlier prefix segments are namespace components and cannot be generic.
        for (var outerLen = segmentCount; outerLen >= 1; outerLen--)
        {
            var prefixOk = true;
            for (var i = 0; i < outerLen - 1; i++)
            {
                if (syntax.SegmentHasTypeArguments(i))
                {
                    prefixOk = false;
                    break;
                }
            }

            if (!prefixOk)
            {
                continue;
            }

            var outerArity = syntax.SegmentHasTypeArguments(outerLen - 1) ? Invariant.Required(syntax.GetSegmentTypeArguments(outerLen - 1), "SegmentHasTypeArguments(outerLen - 1) was true, and both read the same per-segment slot").Count : 0;
            var outerClrType = TryResolveOuterPrefixWithArity(segmentTexts, outerLen, outerArity);
            if (outerClrType == null)
            {
                continue;
            }

            var nestedDef = WalkNestedSegmentsPerArity(outerClrType, segmentTexts, syntax, outerLen, segmentCount);
            if (nestedDef == null)
            {
                continue;
            }

            return ConstructNestedClrTypeFromSegments(syntax, nestedDef, outerLen - 1, segmentCount);
        }

        Diagnostics.ReportUndefinedType(Invariant.Required(syntax.Identifier, "a dotted-qualifier type clause has a head Identifier").Location, syntax.DottedName);
        return null;
    }

    /// <summary>
    /// Issue #1506: resolves the first <paramref name="outerLen"/> segments to a single
    /// CLR type, honoring aliases and imports like <see cref="TryResolveOuterPrefix"/> but
    /// driving the trailing segment's arity from <paramref name="arity"/> so a constructed
    /// generic outer (<c>List[int32]</c> → <c>List`1</c>) resolves to its OPEN definition.
    /// </summary>
    private Type? TryResolveOuterPrefixWithArity(string[] segmentTexts, int outerLen, int arity)
    {
        if (outerLen == 1)
        {
            if (arity > 0)
            {
                if (scope.TryLookupImportedGenericClass(segmentTexts[0], arity, out var imported)
                    && ImportedGenericTypeHasPrecedence(segmentTexts[0], arity, imported))
                {
                    return imported;
                }

                return LookupType(segmentTexts[0], arity)?.ClrType;
            }

            return LookupType(segmentTexts[0])?.ClrType;
        }

        var prefix = string.Join(".", segmentTexts, 0, outerLen);
        if (arity > 0)
        {
            prefix += "`" + arity;
        }

        if (scope.References.TryResolveType(prefix, out var direct))
        {
            return direct;
        }

        foreach (var import in scope.GetDeclaredImports())
        {
            if (scope.References.TryResolveType(import.Target + "." + prefix, out var viaImport))
            {
                return viaImport;
            }
        }

        return null;
    }

    private bool ImportedGenericTypeHasPrecedence(string name, int arity, Type importedType)
    {
        if (!binderCtx.TryLookupSourceType(
                scope,
                name,
                arity,
                function,
                out var sourceType,
                out var ambiguousAcrossImportedPackages))
        {
            return !ambiguousAcrossImportedPackages;
        }

        return binderCtx.ImportedTypeOverridesSourceType(
            scope,
            name,
            sourceType,
            arity,
            function,
            importedType);
    }

    /// <summary>
    /// Issue #1506: walks <paramref name="segmentTexts"/> from <paramref name="start"/> to
    /// <paramref name="end"/>, treating each as a nested type of the previous. Each segment
    /// prefers its OWN arity-mangled name (<c>Name`k</c> where <c>k</c> is that segment's
    /// declared type-argument count) before the unmangled name, so a nested generic such as
    /// <c>Outer[T].Inner[U]</c> matches. Returns <c>null</c> when any segment fails.
    /// </summary>
    private Type? WalkNestedSegmentsPerArity(Type container, string[] segmentTexts, TypeClauseSyntax syntax, int start, int end)
    {
        var current = container;
        for (var i = start; i < end; i++)
        {
            var name = segmentTexts[i];
            var ownArity = syntax.SegmentHasTypeArguments(i) ? Invariant.Required(syntax.GetSegmentTypeArguments(i), "SegmentHasTypeArguments(i) was true, and both read the same per-segment slot").Count : 0;
            Type? next = null;
            if (ownArity > 0)
            {
                scope.References.TryResolveNestedType(current, name + "`" + ownArity, out next);
            }

            if (next == null)
            {
                scope.References.TryResolveNestedType(current, name, out next);
            }

            if (next == null)
            {
                return null;
            }

            current = next;
        }

        return current;
    }

    /// <summary>
    /// Issue #1506: constructs the deepest nested CLR definition
    /// <paramref name="nestedDef"/> over the cumulative type-argument vector gathered from
    /// segments <paramref name="firstArgSegment"/>..<paramref name="segmentCount"/>-1 in
    /// source order. The cumulative order matches reflection's
    /// <see cref="Type.GetGenericArguments"/> (outer parameters first), so
    /// <c>List[int32].Enumerator</c> closes <c>List`1+Enumerator</c> over
    /// <c>int32</c>. Mirrors <see cref="ConstructIfGeneric"/>'s per-argument erasure
    /// (#313 type parameters / #671 user types project onto <c>System.Object</c>) and
    /// by-ref-like rejection (#367).
    /// </summary>
    private TypeSymbol? ConstructNestedClrTypeFromSegments(TypeClauseSyntax syntax, Type nestedDef, int firstArgSegment, int segmentCount)
    {
        var identifierToken = Invariant.Required(syntax.Identifier, "a dotted-qualifier type clause has a head Identifier");
        var argSyntaxes = new List<TypeClauseSyntax>();
        for (var i = firstArgSegment; i < segmentCount; i++)
        {
            if (!syntax.SegmentHasTypeArguments(i))
            {
                continue;
            }

            foreach (var ta in Invariant.Required(syntax.GetSegmentTypeArguments(i), "SegmentHasTypeArguments(i) was true, and both read the same per-segment slot"))
            {
                argSyntaxes.Add(ta);
            }
        }

        if (!nestedDef.IsGenericTypeDefinition)
        {
            if (argSyntaxes.Count == 0)
            {
                return ResolveClrTypeClauseSymbol(nestedDef);
            }

            Diagnostics.ReportTypeNotGeneric(identifierToken.Location, syntax.DottedName);
            return null;
        }

        var expected = nestedDef.GetGenericArguments().Length;
        if (expected != argSyntaxes.Count)
        {
            Diagnostics.ReportWrongTypeArgumentCount(identifierToken.Location, syntax.DottedName, expected, argSyntaxes.Count);
            return null;
        }

        var clrArgs = new Type[argSyntaxes.Count];
        var symbolicArgs = ImmutableArray.CreateBuilder<TypeSymbol>(argSyntaxes.Count);
        var hasSymbolicArg = false;
        for (var i = 0; i < argSyntaxes.Count; i++)
        {
            var ta = BindTypeClause(argSyntaxes[i]);
            if (ta == null)
            {
                return null;
            }

            symbolicArgs.Add(ta);

            if (TypeSymbol.IsByRefLike(ta))
            {
                var taLocation = argSyntaxes[i].Identifier?.Location ?? identifierToken.Location;
                Diagnostics.ReportByRefLikeEscape(taLocation, ta, "be used as a generic type argument");
                return null;
            }

            clrArgs[i] = ProjectGenericArgument(ta, typeof(object), ref hasSymbolicArg);
        }

        // Issue #4032: MetadataLoadContext's MakeGenericType does not validate
        // constraints, so ask them here.
        if (ReportUnsatisfiedGenericTypeConstraint(
                Diagnostics,
                nestedDef,
                clrArgs,
                symbolicArgs.ToImmutable(),
                identifierToken.Location))
        {
            return null;
        }

        try
        {
            var closed = nestedDef.MakeGenericType(clrArgs);
            if (hasSymbolicArg || NativeSliceTypes.IsDefinition(closed, out _) || ManagedReferenceTypes.IsDefinition(closed, out _))
            {
                return ImportedTypeSymbol.GetConstructed(closed, nestedDef, symbolicArgs.MoveToImmutable());
            }

            return ResolveClrTypeClauseSymbol(closed);
        }
        catch (System.ArgumentException)
        {
            Diagnostics.ReportTypeNotGeneric(identifierToken.Location, syntax.DottedName);
            return null;
        }
    }

    /// <summary>
    /// Projects a symbolic generic argument onto a closed CLR type while
    /// retaining any type information that the CLR shape cannot represent.
    /// </summary>
    /// <param name="type">The symbolic generic argument.</param>
    /// <param name="erasedArgument">
    /// The caller-specific CLR surrogate for a same-compilation user type.
    /// </param>
    /// <param name="hasSymbolicArgument">
    /// Set when the symbolic argument must be retained beside the CLR shape.
    /// </param>
    /// <returns>The reference-context CLR argument used to close the generic.</returns>
    private Type ProjectGenericArgument(
        TypeSymbol type,
        Type erasedArgument,
        ref bool hasSymbolicArgument)
    {
        // #313 / #671 / #3560: preserve symbolic type parameters, user types,
        // and tuple conversion semantics beside their CLR form.
        // ADR-0172: a named-tuple-bearing argument at ANY nesting depth
        // (`List[(a int32, b string)]`, `[](a int32, b string)`) shares its
        // CLR backing with the unnamed shape — only the symbolic argument
        // preserves the names on projected members.
        // Issue #3962: a fixed-length array `[N]T` is backed by the plain
        // SZ-array `T[]` — the same CLR type as `[]T` and as an array of every
        // other length — so its declared length survives ONLY in the symbol.
        // Without keeping the symbolic argument, `List[[3]int32]` and
        // `List[[4]int32]` both resolve to the ONE cached ImportedTypeSymbol
        // for `List<System.Int32[]>` and become literally the same type, and no
        // downstream conversion check can tell them apart again. Same reason
        // named tuples are listed above, and the same erased CLR argument is
        // still projected below, so the closed shape (and the emitted
        // signature) is unchanged.
        // Issue #4024: the SLICE spelling `[]T` shares that one SZ-array
        // backing, so it needs retaining for the same reason and by the same
        // gate. #3962 retained only `[N]T`, which left `List[[]int32]` with an
        // EMPTY symbolic argument vector — indistinguishable from a
        // metadata-recovered `List<int[]>`, whose shape genuinely IS
        // unknowable — so `ContainsMetadataRecoveredArray` kept the lenient CLR
        // comparison and `List[[]int32]` still converted to `List[[3]int32]`.
        // `ContainsSourceArrayShape` is `ContainsFixedLengthArray` widened to
        // both spellings; see its remarks for why this is a representation
        // change and not a rule change.
        if (TypeSymbol.RequiresSymbolicProjection(type)
            || type.ClrType == null
            || type is TupleTypeSymbol
            || TypeSymbol.ContainsNamedTupleElements(type)
            || TypeSymbol.ContainsSourceArrayShape(type))
        {
            hasSymbolicArgument = true;

            // Issue #2919 follow-up: a nullable source enum keeps the same
            // caller-selected leaf surrogate as the bare enum. A caller that
            // erases Mode to object must therefore erase Mode? to object too;
            // only callers selecting the Int32 backing may use Nullable<Int32>.
            if (type is NullableTypeSymbol { UnderlyingType: EnumSymbol }
                && !erasedArgument.IsValueType)
            {
                return scope.References.MapClrTypeToReferences(erasedArgument);
            }

            if (type is SliceTypeSymbol
                    or ArrayTypeSymbol
                    or RectangularArrayTypeSymbol
                    or TupleTypeSymbol
                    or MapTypeSymbol
                    or FunctionTypeSymbol
                    or SequenceTypeSymbol
                    or AsyncSequenceTypeSymbol
                    or ChannelTypeSymbol
                    or NullableTypeSymbol
                    or ImportedTypeSymbol
                && MemberLookup.TryProjectErasedClrType(type, out var projected))
            {
                return scope.References.MapClrTypeToReferences(projected);
            }

            return TypeSymbol.ContainsTypeParameter(type)
                || TypeSymbol.ContainsSameCompilationUserType(type)
                || type.ClrType == null
                    ? scope.References.MapClrTypeToReferences(erasedArgument)
                    : ResolveClrTypeForGenericArg(type)
                        ?? scope.References.MapClrTypeToReferences(type.ClrType);
        }

        return ResolveClrTypeForGenericArg(type)
            ?? scope.References.MapClrTypeToReferences(type.ClrType);
    }

    /// <summary>
    /// Issue #4032: reports <c>GS0152</c> when a closed generic TYPE clause
    /// (<c>class MyHandler : Handler[MyOptions]</c>, <c>var h Handler[Bad]</c>,
    /// …) violates a constraint the imported definition declares.
    /// </summary>
    /// <remarks>
    /// <para><c>Type.MakeGenericType</c> checks constraints for a live runtime
    /// definition and does NOT for one loaded by a
    /// <see cref="System.Reflection.MetadataLoadContext"/> — which is where
    /// every <c>/reference</c> assembly lives. So <c>Handler[string]</c> over
    /// <c>Handler&lt;TOptions&gt; where TOptions : SchemeOptions</c> closed
    /// silently, the emitted <c>extends</c> row named a type the CLR refuses,
    /// and the program threw <c>TypeLoadException: GenericArguments[0],
    /// 'System.String', … violates the constraint of type parameter
    /// 'TOptions'</c> the first time it touched the type. The imported generic
    /// METHOD path has checked this explicitly since #750/ADR-0088 for exactly
    /// the same reason; this is that check one type parameter over.</para>
    /// <para><b>Only fully CLOSED instantiations are asked.</b> A type
    /// argument that still mentions a type parameter is erased to the
    /// <c>object</c> placeholder in <paramref name="clrArgs"/>, and asking a
    /// constraint of a placeholder is how a projection breaks constraint
    /// satisfaction for a SIBLING parameter (the #4016/#4031 lesson). An open
    /// instantiation has no closed answer to give, so it is left alone — the
    /// CLR only loads the type once it is closed anyway. The same-compilation
    /// class case is NOT skipped, because
    /// <c>ClrOverloadResolution.SatisfiesGenericTypeConstraints</c> is handed
    /// the SYMBOLIC vector and walks a user class's own base chain
    /// (<c>UserReferenceTypeErasedSymbolSatisfiesBaseConstraint</c>) rather
    /// than reading the erased <c>object</c>. That is the whole reason
    /// <c>class MyOptions : SchemeOptions</c> stays green.</para>
    /// </remarks>
    /// <param name="diagnostics">The bag the diagnostic is reported into.</param>
    /// <param name="openDefinition">The open generic CLR definition.</param>
    /// <param name="clrArgs">The projected (possibly erased) CLR arguments.</param>
    /// <param name="symbolicArgs">The symbolic arguments, in the same order.</param>
    /// <param name="location">Where to anchor the diagnostic.</param>
    /// <returns><see langword="true"/> when a diagnostic was reported.</returns>
    internal static bool ReportUnsatisfiedGenericTypeConstraint(
        DiagnosticBag diagnostics,
        Type openDefinition,
        Type[] clrArgs,
        ImmutableArray<TypeSymbol> symbolicArgs,
        TextLocation location)
    {
        if (openDefinition == null
            || clrArgs == null
            || symbolicArgs.IsDefaultOrEmpty
            || symbolicArgs.Length != clrArgs.Length)
        {
            return false;
        }

        var anyOpen = false;
        foreach (var symbolic in symbolicArgs)
        {
            if (symbolic == null)
            {
                return false;
            }

            anyOpen |= TypeSymbol.ContainsTypeParameter(symbolic);
        }

        if (anyOpen)
        {
            // Issue #4037: an OPEN instantiation. The closed check below cannot
            // answer here and must not be asked — a type argument that still
            // mentions a type parameter is erased to an `object` placeholder,
            // and asking a constraint of a placeholder is the #4016/#4031
            // defect. A DIFFERENT question does have an answer: when the
            // argument IS a type parameter, does its own constraint set imply
            // the bound the definition declares? That is the whole of
            // `class Unforwarded[T] : Handler[T]`, and it is what `csc` asks
            // (CS0314). Handled by its own reporter, which never falls through
            // to the closed path.
            return ReportUnforwardedGenericTypeParameterConstraint(
                diagnostics,
                openDefinition,
                symbolicArgs,
                location);
        }

        var symbolicVector = ImmutableArray.CreateRange(symbolicArgs, static arg => (TypeSymbol?)arg);
        if (ClrOverloadResolution.SatisfiesGenericTypeConstraints(
                openDefinition,
                clrArgs,
                symbolicVector,
                out var failedIndex,
                out var failedConstraint)
            || failedIndex < 0
            || failedIndex >= symbolicArgs.Length)
        {
            return false;
        }

        Type failedParameter;
        try
        {
            var typeParameters = openDefinition.GetGenericArguments();
            if (failedIndex >= typeParameters.Length)
            {
                return false;
            }

            failedParameter = typeParameters[failedIndex];
        }
        catch (Exception)
        {
            // A metadata load failure did not disprove the constraint.
            return false;
        }

        var typeArgument = symbolicArgs[failedIndex];
        var constraintDescription = DescribeClrConstraint(failedParameter, failedConstraint);

        // Issue #4032 (review follow-up): report ONCE PER EXPRESSION, not once
        // per call. `ExpressionBinder.TryCloseImportedGenericTypeReceiver` is a
        // BACKTRACKING PROBE — it is reached THREE times while binding
        // `System.Nullable[string].Value` and TWICE for
        // `Handler[string].Describe()`. Measured with a stack dump at the
        // probe's entry rather than read off the code, because the obvious
        // reading (three different resolvers) is wrong: it is `BindAccessorExpression`
        // re-attempting THE SAME qualified walk through three entry points,
        // all converging on `TryWalkQualifiedClrTypePath`:
        //
        //   1  BindAccessorExpression:~81  -> TryBindFullyQualifiedClrStaticAccess
        //                                     (the full out-param overload, tried first)
        //   2  BindAccessorExpression:~558 -> TryBindImportAccessor
        //   3  BindAccessorExpression:~630 -> TryBindFullyQualifiedClrStaticAccess
        //                                     (the 3-arg overload, which DISCARDS the out-params)
        //
        // The unqualified "two" is the same method attempting the other
        // resolver twice — `TryResolveConstructedGenericTypeReceiver`, from
        // `BindAccessorExpression` at ~221 and again at ~690. Every OTHER
        // construction site calls this checker exactly once (measured, by
        // tracing all seven), so this is not a general fan-out.
        //
        // A per-call report turned one violation into three identical errors,
        // and the COUNT was a function of how many internal paths the binder
        // happened to take — which is exactly the kind of detail that must not
        // reach an author. Suppressing a byte-identical diagnostic (same id,
        // same span, same message) loses nothing a reader could have
        // distinguished, and the repo already takes this position for exact
        // duplicates (`DiagnosticBag.SuppressDuplicateDiagnosticsIn`).
        //
        // The RETURN VALUE is unchanged when a duplicate is suppressed: callers
        // use it to mean "this construction is invalid, stop", and every probe
        // must still bail out even though only the first one printed.
        var message = string.Format(
            CultureInfo.CurrentCulture,
            DiagnosticDescriptors.TypeArgumentDoesNotSatisfyConstraint.MessageFormat,
            typeArgument,
            failedParameter.Name,
            constraintDescription);
        if (AlreadyReportedHere(
                diagnostics,
                DiagnosticDescriptors.TypeArgumentDoesNotSatisfyConstraint.Id,
                message,
                location))
        {
            return true;
        }

        diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
            location,
            failedParameter.Name,
            typeArgument,
            constraintDescription);
        return true;
    }

    /// <summary>
    /// Issue #4037: reports <c>GS0580</c> when an OPEN instantiation of a
    /// constrained generic writes the enclosing declaration's own type
    /// parameter at a position whose bound that parameter does not forward —
    /// <c>class Unforwarded[T] : Handler[T]</c> over
    /// <c>Handler&lt;TOptions&gt; where TOptions : SchemeOptions</c>.
    /// </summary>
    /// <remarks>
    /// <para><b>The rule, and why it is not the #4032 check.</b> #4032 asks
    /// "does this ARGUMENT satisfy the bound", which only a CLOSED
    /// instantiation can answer. Here there is no argument: <c>T</c> stands
    /// for every type its own bounds admit, so the instantiation is valid
    /// exactly when <c>T</c>'s bounds are at least as strong as the
    /// definition's — C# §13.4.3, which <c>csc</c> reports as
    /// <b>CS0314</b>. Measured, not assumed: <c>csc</c> reports CS0314 (not
    /// CS0311, which is the CONCRETE-argument case G# already spells GS0152)
    /// at a base clause, a field type, a local type, an interface list entry
    /// and a return type alike, which is why this sits at the shared
    /// construction sites rather than in the base-clause binder.</para>
    /// <para><b>What is still not asked.</b> Only a type argument that IS a
    /// type parameter. A composite open shape (<c>Handler[List[T]]</c>) has
    /// no forwarding question to ask and is skipped exactly as before, and so
    /// is a position whose declared bound MENTIONS another of the
    /// definition's own parameters (#4031's dependent-bound shape). The rule
    /// therefore only ever ADDS rejections it can prove.</para>
    /// </remarks>
    /// <param name="diagnostics">The bag the diagnostic is reported into.</param>
    /// <param name="openDefinition">The open generic CLR definition.</param>
    /// <param name="symbolicArgs">The symbolic arguments, in declaration order.</param>
    /// <param name="location">Where to anchor the diagnostic.</param>
    /// <returns><see langword="true"/> when a diagnostic was reported.</returns>
    private static bool ReportUnforwardedGenericTypeParameterConstraint(
        DiagnosticBag diagnostics,
        Type openDefinition,
        ImmutableArray<TypeSymbol> symbolicArgs,
        TextLocation location)
    {
        for (var i = 0; i < symbolicArgs.Length; i++)
        {
            if (symbolicArgs[i] is not TypeParameterSymbol argument)
            {
                continue;
            }

            if (ClrOverloadResolution.TypeParameterForwardsDeclaredConstraints(
                    openDefinition,
                    i,
                    argument,
                    out var failedConstraint,
                    out var declaredParameterName)
                || declaredParameterName == null)
            {
                continue;
            }

            Type declaredParameter;
            try
            {
                declaredParameter = openDefinition.GetGenericArguments()[i];
            }
            catch (Exception)
            {
                // A metadata load failure did not disprove the constraint.
                continue;
            }

            var constraintDescription = DescribeClrConstraint(declaredParameter, failedConstraint);

            // Issue #4037: the same once-per-expression rule #4032 established.
            // The receiver probes that made a single violation print three
            // times are the same probes here.
            var message = string.Format(
                CultureInfo.CurrentCulture,
                DiagnosticDescriptors.TypeParameterDoesNotForwardConstraint.MessageFormat,
                argument.Name,
                declaredParameterName,
                constraintDescription);
            if (!AlreadyReportedHere(
                    diagnostics,
                    DiagnosticDescriptors.TypeParameterDoesNotForwardConstraint.Id,
                    message,
                    location))
            {
                diagnostics.ReportTypeParameterDoesNotForwardConstraint(
                    location,
                    argument.Name,
                    declaredParameterName,
                    constraintDescription);
            }

            // One diagnostic per construction, even when two positions fail:
            // the author fixes the declaration, not the instantiation.
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issues #4089/#4090: asks both constraint questions of a G#-declared
    /// generic TYPE-CLAUSE construction — does an OPEN argument forward the
    /// declared bound (<c>GS0580</c>, #4067), and does a CLOSED argument
    /// satisfy it (<c>GS0152</c>, #4090) — deferring the ask until every
    /// same-compilation declaration's type-parameter constraints are resolved.
    /// </summary>
    /// <remarks>
    /// <para><b>Why it cannot be asked here.</b> A declaration's type-parameter
    /// constraints are resolved by <c>ResolvePartialTypeParameterConstraints</c>
    /// when that declaration's own body (a class) or members (an interface) are
    /// bound — #2519's aggregate-shell lifecycle, which exists so a constraint
    /// may name any same-compilation type and so CRTP works. A type clause in
    /// ANOTHER declaration may bind before that, and then the declared
    /// parameter still reads no constraints at all, which both checkers read as
    /// "nothing to violate" and accept. That is not a conservative default; it
    /// is a silent hole whose shape is source order.</para>
    /// <para><b>Both defects are that one hole.</b> Interface members bind
    /// after every class body, so a G#-declared generic INTERFACE was NEVER
    /// checked (#4089). A class is ordered base-first
    /// (<c>AddBaseFirst</c>), so <c>class Unf[T] : GsHandler[T]</c> happened to
    /// work — but a FIELD type has no such ordering, and
    /// <c>class Unf[T] { var f GsHandler[T] }</c> was accepted whenever
    /// <c>GsHandler</c> was declared below it. Measured both ways.</para>
    /// <para><b>Deferral, not lifecycle surgery.</b> The alternative — resolving
    /// interface type-parameter constraints before class bodies bind — is the
    /// #2519 CRTP shell lifecycle, and moving it is a far larger change than
    /// the rule needs. Queuing costs one list per compilation and answers with
    /// exactly the same code. Once <see cref="FlushPendingUserGenericConstraintChecks"/>
    /// has run, later constructions — member bodies, which <c>BindProgram</c>
    /// binds through a freshly derived scope chain, and any subsequent
    /// interactive submission — are answered in place. The deferred base and
    /// field initialisers bind BEFORE the flush and so ride the queue.</para>
    /// </remarks>
    /// <param name="declaredParameters">The definition's own type parameters.</param>
    /// <param name="typeArgs">The symbolic arguments, in declaration order.</param>
    /// <param name="location">Where to anchor the diagnostic.</param>
    private void CheckUserGenericTypeClauseConstraints(
        ImmutableArray<TypeParameterSymbol> declaredParameters,
        ImmutableArray<TypeSymbol> typeArgs,
        TextLocation location)
    {
        if (declaredParameters.IsDefaultOrEmpty
            || typeArgs.IsDefaultOrEmpty
            || declaredParameters.Length != typeArgs.Length)
        {
            return;
        }

        var pending = new PendingUserGenericConstraintCheck(Diagnostics, declaredParameters, typeArgs, location);
        if (!scope.IsDeferringUserGenericConstraintChecks())
        {
            RunUserGenericTypeClauseConstraintCheck(pending);
            return;
        }

        scope.GetPendingUserGenericConstraintChecks().Add(pending);
    }

    /// <summary>
    /// Issues #4089/#4090: answers every queued G#-declared generic
    /// type-clause constraint check and latches the queue closed, so any later
    /// construction is answered at its own site.
    /// </summary>
    /// <remarks>
    /// <para>Called from <c>BindGlobalScope</c> after
    /// <c>ExpandStructInterfaceClosures</c>. The BINDING constraint is the
    /// interface-members loop just above it: that is where an interface's own
    /// type-parameter constraints are resolved (#2519), and nothing before it
    /// can answer #4089's question at all.</para>
    /// <para><b>The later boundary is the conservative choice, and it was
    /// measured rather than argued.</b> The obvious worry is
    /// <see cref="SatisfiesConstraint"/>'s interface arm: it answers through
    /// <see cref="ImplementsInterface"/>, which reads a class's own
    /// <c>Interfaces</c> list, so flushing before the closure expansion might
    /// reject a class that inherits its implementation. Traced by moving the
    /// call up to immediately after the interface-members loop, rebuilding, and
    /// compiling both shapes — an implementation inherited from a BASE CLASS
    /// and one reached through a BASE INTERFACE. Both stay green at either
    /// boundary, because <see cref="ImplementsInterface"/> walks
    /// <c>BaseClass</c> itself and asks <c>SelfAndAllBaseInterfaces()</c>, and
    /// both of those are populated by the time the interface loop ends. The
    /// later point is kept anyway — it is the first place at which every
    /// declaration-phase structure this predicate can read is final — and both
    /// shapes are pinned as green rows so moving either boundary is caught.</para>
    /// <para>The queue is DRAINED before the first check is answered, not
    /// cleared after the last. The deferral only works while the queue is a
    /// faithful record of what has yet to be asked, so it must be left empty on
    /// every path: were a check to throw, a clear-afterwards would strand the
    /// remaining items in the root scope and they would be answered later
    /// against whatever declaration happened to trigger the next flush. This is
    /// the error-path counterpart of the two speculative rollback sites in
    /// <c>ResolvePartialTypeParameterConstraints</c>.</para>
    /// </remarks>
    /// <param name="scope">Any scope in the compilation's chain.</param>
    internal static void FlushPendingUserGenericConstraintChecks(BoundScope scope)
    {
        var pending = scope.GetPendingUserGenericConstraintChecks();

        // Clear the latch FIRST: anything the reports themselves bind is
        // answered in place rather than re-queued behind a flush that has
        // already begun.
        scope.SetDeferUserGenericConstraintChecks(false);

        // Then DRAIN before answering anything. Emptying the queue up front
        // rather than after the loop is what makes the flush exception-safe:
        // if a check throws, the queue is already empty, so no stale work item
        // survives to be answered later against an unrelated declaration.
        var draining = pending.ToArray();
        pending.Clear();

        foreach (var check in draining)
        {
            RunUserGenericTypeClauseConstraintCheck(check);
        }
    }

    /// <summary>
    /// Issues #4089/#4090: asks the OPEN (forwarding) question first and, only
    /// when it reports nothing, the CLOSED (satisfaction) question. They are
    /// complementary per position — an argument is either a bare type
    /// parameter, fully closed, or a composite open shape neither asks — so the
    /// ordering only decides which of two positions in the SAME vector wins the
    /// one-diagnostic-per-construction budget.
    /// </summary>
    /// <param name="check">The recorded construction.</param>
    private static void RunUserGenericTypeClauseConstraintCheck(PendingUserGenericConstraintCheck check)
    {
        if (ReportUnforwardedUserGenericConstraint(
                check.Diagnostics,
                check.DeclaredParameters,
                check.TypeArgs,
                check.Location))
        {
            return;
        }

        ReportUnsatisfiedUserGenericTypeArgument(
            check.Diagnostics,
            check.DeclaredParameters,
            check.TypeArgs,
            check.Location);
    }

    /// <summary>
    /// Issue #4067: reports <c>GS0580</c> when an instantiation of a
    /// <b>G#-declared</b> constrained generic writes the enclosing
    /// declaration's own type parameter at a position whose bound that
    /// parameter does not forward — <c>class Unf[T] : GsHandler[T]</c> over
    /// <c>open class GsHandler[TOptions SchemeOptions]</c>.
    /// </summary>
    /// <remarks>
    /// <para><b>Why #4037's checker cannot reach this.</b> #4037 put the
    /// implication rule at
    /// <see cref="ReportUnsatisfiedGenericTypeConstraint"/>, the one entry
    /// point every user-facing <c>Type.MakeGenericType</c> construction funnels
    /// through. A G#-declared generic base is never closed that way: the
    /// declaration binder resolves it by symbol substitution over
    /// <c>StructSymbol</c> / <c>InterfaceSymbol</c> / <c>TypeParameterSymbol</c>
    /// and never touches a CLR open definition, so it reaches no CLR checker at
    /// all. The RULE is identical (C# §13.4.3, which <c>csc</c> spells
    /// <c>CS0314</c>); only the substrate differs, so this is the symbolic twin
    /// of <c>ClrOverloadResolution.TypeParameterForwardsDeclaredConstraints</c>
    /// and reports the same diagnostic.</para>
    /// <para><b>Only a type argument that IS a type parameter.</b> A composite
    /// open shape (<c>GsHandler[List[T]]</c>) has no forwarding question. A
    /// CLOSED argument is a DIFFERENT question that this checker deliberately
    /// does not ask; since #4090 it is asked immediately afterwards by
    /// <see cref="ReportUnsatisfiedUserGenericTypeArgument"/>, which reports
    /// <c>GS0152</c>.</para>
    /// <para><b>A declared bound that mentions another of the definition's own
    /// parameters is skipped</b>, exactly as #4037 skips it: that is the
    /// #4031/#4041 dependent shape, where answering on an unsubstituted
    /// parameter is precisely what goes wrong.</para>
    /// <para><b>Never called at the construction site.</b> #4067 wired this
    /// inline at the STRUCT/CLASS type clause, which made the answer a function
    /// of DECLARATION ORDER: a declaration's type-parameter constraints are
    /// resolved when its own body/members are bound, so a reference that binds
    /// earlier reads <c>ClassConstraint == null</c> and is silently accepted.
    /// Measured three ways — a generic INTERFACE is always accepted (#4089,
    /// because interface members bind after every class body, #2519), and even
    /// the class case flips on source order (<c>class Unf[T] { var f
    /// GsHandler[T] }</c> is accepted when <c>GsHandler</c> is declared BELOW
    /// it and rejected when it is declared above). #4089/#4090 therefore route
    /// every type-clause construction through
    /// <see cref="CheckUserGenericTypeClauseConstraints"/>, which queues the
    /// question until <see cref="FlushPendingUserGenericConstraintChecks"/>
    /// runs it with every same-compilation constraint resolved. The RULE is
    /// unchanged; only when it is asked moved.</para>
    /// </remarks>
    /// <param name="diagnostics">The bag the diagnostic is reported into.</param>
    /// <param name="declaredParameters">The definition's own type parameters.</param>
    /// <param name="typeArgs">The symbolic arguments, in declaration order.</param>
    /// <param name="location">Where to anchor the diagnostic.</param>
    /// <returns><see langword="true"/> when a diagnostic was reported.</returns>
    internal static bool ReportUnforwardedUserGenericConstraint(
        DiagnosticBag diagnostics,
        ImmutableArray<TypeParameterSymbol> declaredParameters,
        ImmutableArray<TypeSymbol> typeArgs,
        TextLocation location)
    {
        if (declaredParameters.IsDefaultOrEmpty
            || typeArgs.IsDefaultOrEmpty
            || declaredParameters.Length != typeArgs.Length)
        {
            return false;
        }

        for (var i = 0; i < typeArgs.Length; i++)
        {
            if (typeArgs[i] is not TypeParameterSymbol argument)
            {
                continue;
            }

            var declared = declaredParameters[i];
            if (declared == null || ReferenceEquals(declared, argument))
            {
                continue;
            }

            if (TypeParameterForwardsUserDeclaredConstraints(argument, declared, out var constraintDescription)
                || constraintDescription == null)
            {
                continue;
            }

            // Issue #4032's once-per-expression rule, inherited through #4037.
            // A type clause is re-bound through several entry points, so a
            // per-call report would turn one violation into a count that is a
            // function of how many internal paths the binder happened to take.
            var message = string.Format(
                CultureInfo.CurrentCulture,
                DiagnosticDescriptors.TypeParameterDoesNotForwardConstraint.MessageFormat,
                argument.Name,
                declared.Name,
                constraintDescription);
            if (!AlreadyReportedHere(
                    diagnostics,
                    DiagnosticDescriptors.TypeParameterDoesNotForwardConstraint.Id,
                    message,
                    location))
            {
                diagnostics.ReportTypeParameterDoesNotForwardConstraint(
                    location,
                    argument.Name,
                    declared.Name,
                    constraintDescription);
            }

            // One diagnostic per construction, even when two positions fail:
            // the author fixes the declaration, not the instantiation.
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #4090: reports <c>GS0152</c> when a CLOSED type argument at a
    /// <b>G#-declared</b> generic TYPE clause does not satisfy the bound the
    /// definition declares — <c>class Bad : GsHandler[Unrelated]</c> and
    /// <c>var f GsHandler[Unrelated]</c> over
    /// <c>open class GsHandler[TOptions SchemeOptions]</c>.
    /// </summary>
    /// <remarks>
    /// <para><b>The rule already exists; only this site did not ask it.</b>
    /// The CONSTRUCTOR spelling <c>GsHandler[Unrelated]()</c> has always
    /// reported <c>GS0152</c> — <c>OverloadResolver.Constructors</c> runs
    /// <see cref="SatisfiesConstraint"/> over the vector — and so has the
    /// struct-literal spelling (<c>ExpressionBinder.Literals</c>). The two
    /// TYPE-position construction sites
    /// (<c>BindNonNullableTypeClause</c> and
    /// <c>BindAndConstructUserGenericSegment</c>) called nothing, so the same
    /// violation written as a base clause or a field/variable type compiled and
    /// emitted IL that fails verification with
    /// <c>UnsatisfiedMethodParentInst</c>. This is C# §13.4.3's concrete half,
    /// which <c>csc</c> spells <c>CS0311</c>.</para>
    /// <para><b>Only fully CLOSED arguments are asked</b>, which is the exact
    /// complement of <see cref="ReportUnforwardedUserGenericConstraint"/>: an
    /// argument that still mentions a type parameter stands for every type its
    /// own bounds admit and has no closed answer here, so it is the FORWARDING
    /// question (<c>GS0580</c>) or it is a composite open shape that neither
    /// checker asks. The two never both fire at one position.</para>
    /// <para><b>The whole vector builds the substitution before any position is
    /// checked.</b> A dependent bound (<c>[TBase, TDerived TBase]</c>, #4043)
    /// is only answerable once the BOUNDING parameter's own argument is known,
    /// and <see cref="SatisfiesConstraint"/> reads it out of that map. A
    /// per-position check without it would ACCEPT — the deliberate
    /// indeterminate direction — and silently lose the dependent shape.</para>
    /// </remarks>
    /// <param name="diagnostics">The bag the diagnostic is reported into.</param>
    /// <param name="declaredParameters">The definition's own type parameters.</param>
    /// <param name="typeArgs">The symbolic arguments, in declaration order.</param>
    /// <param name="location">Where to anchor the diagnostic.</param>
    /// <returns><see langword="true"/> when a diagnostic was reported.</returns>
    internal static bool ReportUnsatisfiedUserGenericTypeArgument(
        DiagnosticBag diagnostics,
        ImmutableArray<TypeParameterSymbol> declaredParameters,
        ImmutableArray<TypeSymbol> typeArgs,
        TextLocation location)
    {
        if (declaredParameters.IsDefaultOrEmpty
            || typeArgs.IsDefaultOrEmpty
            || declaredParameters.Length != typeArgs.Length)
        {
            return false;
        }

        // Issue #4043: the dependent bound needs the sibling's argument, so the
        // whole vector is mapped before any position is asked.
        var substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        for (var i = 0; i < typeArgs.Length; i++)
        {
            if (declaredParameters[i] is { } parameter && typeArgs[i] is { } argument)
            {
                substitution[parameter] = argument;
            }
        }

        for (var i = 0; i < typeArgs.Length; i++)
        {
            var declared = declaredParameters[i];
            var typeArgument = typeArgs[i];
            if (declared == null
                || typeArgument == null
                || typeArgument == TypeSymbol.Error
                || ReferenceEquals(declared, typeArgument))
            {
                continue;
            }

            // The OPEN half of the question belongs to
            // ReportUnforwardedUserGenericConstraint, which has already run.
            if (TypeSymbol.ContainsTypeParameter(typeArgument))
            {
                continue;
            }

            if (SatisfiesConstraint(typeArgument, declared, substitution))
            {
                continue;
            }

            var constraintDescription = DescribeConstraint(declared);

            // Issue #4032's once-per-expression rule, inherited through #4067.
            // A type clause is re-bound through several entry points, so a
            // per-call report would turn one violation into a count that is a
            // function of how many internal paths the binder happened to take.
            var message = string.Format(
                CultureInfo.CurrentCulture,
                DiagnosticDescriptors.TypeArgumentDoesNotSatisfyConstraint.MessageFormat,
                typeArgument,
                declared.Name,
                constraintDescription);
            if (!AlreadyReportedHere(
                    diagnostics,
                    DiagnosticDescriptors.TypeArgumentDoesNotSatisfyConstraint.Id,
                    message,
                    location))
            {
                diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                    location,
                    declared.Name,
                    typeArgument,
                    constraintDescription);
            }

            // One diagnostic per construction, matching the forwarding twin.
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #4067: whether <paramref name="argument"/>'s own constraint set
    /// implies every constraint <paramref name="declared"/> requires, so that
    /// writing it at that position is valid for EVERY type the argument admits.
    /// </summary>
    /// <remarks>
    /// <para><b>Two different walks, and the difference is load-bearing.</b>
    /// A TYPE bound is implied by anything the argument is provably an instance
    /// of, so it is asked of the argument AND of every bound in its chain —
    /// that is what makes <c>[T DisposableOptions]</c> forward
    /// <c>[TOptions IDisposable]</c> when <c>DisposableOptions</c> implements
    /// it, the false rejection #4037's review caught in the imported twin. A
    /// SPECIAL constraint (<c>struct</c> / <c>class</c> / <c>new()</c> /
    /// <c>unmanaged</c>) is a property of the PARAMETER's own declaration and
    /// is asked only of the type parameters in the chain: a class bound with a
    /// public parameterless constructor does NOT give the parameter
    /// <c>new()</c>, and accepting it there would be a false accept the CLR
    /// then refuses.</para>
    /// <para><b>Indeterminate accepts.</b> A bound that still mentions a type
    /// parameter has no closed answer here and is skipped, and so is a
    /// dependent bound (<c>TypeParameterBound</c>) — the #4031/#4041 shape. A
    /// wrong "no" is a GS0580 on a legal program, which is strictly worse than
    /// the defect being fixed.</para>
    /// </remarks>
    /// <param name="argument">The type parameter written as the type argument.</param>
    /// <param name="declared">The definition's type parameter at that position.</param>
    /// <param name="failedConstraint">The unforwarded constraint's description, when the answer is no.</param>
    /// <returns><see langword="true"/> when every constraint is forwarded.</returns>
    private static bool TypeParameterForwardsUserDeclaredConstraints(
        TypeParameterSymbol argument,
        TypeParameterSymbol declared,
        out string? failedConstraint)
    {
        failedConstraint = null;
        var parameters = EnumerateForwardedParameterChain(argument);

        if (declared.HasValueTypeConstraint
            && !AnyParameter(parameters, static p => p.HasValueTypeConstraint || p.HasUnmanagedConstraint))
        {
            failedConstraint = "struct";
            return false;
        }

        if (declared.HasUnmanagedConstraint
            && !AnyParameter(parameters, static p => p.HasUnmanagedConstraint))
        {
            failedConstraint = "unmanaged";
            return false;
        }

        if (declared.HasReferenceTypeConstraint
            && !AnyBound(parameters, IsReferenceTypeForConstraint))
        {
            failedConstraint = "class";
            return false;
        }

        if (declared.HasDefaultConstructorConstraint
            && !AnyParameter(
                parameters,
                static p => p.HasDefaultConstructorConstraint || p.HasValueTypeConstraint || p.HasUnmanagedConstraint))
        {
            failedConstraint = "new()";
            return false;
        }

        if (declared.Constraint == TypeParameterConstraint.Comparable
            && !AnyBound(parameters, IsComparable))
        {
            failedConstraint = "comparable";
            return false;
        }

        if (declared.ClassConstraint is { } classBound
            && !TypeSymbol.ContainsTypeParameter(classBound)
            && !AnyBound(parameters, candidate => SatisfiesClassConstraint(candidate, classBound)))
        {
            failedConstraint = SymbolDisplay.ToTypeDisplayString(classBound);
            return false;
        }

        if (declared.InterfaceConstraint is { } userInterfaceBound
            && !TypeSymbol.ContainsTypeParameter(userInterfaceBound)
            && !AnyBound(parameters, candidate => ImplementsInterface(candidate, userInterfaceBound)))
        {
            failedConstraint = SymbolDisplay.ToTypeDisplayString(userInterfaceBound);
            return false;
        }

        if (declared.ClrInterfaceConstraint is { } clrInterfaceBound
            && !TypeSymbol.ContainsTypeParameter(clrInterfaceBound)
            && !AnyBound(
                parameters,
                candidate => SatisfiesClrInterfaceConstraint(candidate, clrInterfaceBound, declared)))
        {
            failedConstraint = SymbolDisplay.ToTypeDisplayString(clrInterfaceBound);
            return false;
        }

        return true;
    }

    /// <summary>
    /// Issue #4067: <paramref name="argument"/> and every type parameter its
    /// own bounds prove it to be an instance of — through a dependent bound
    /// (<c>[U SchemeOptions, T U]</c>) or through a type-parameter-valued class
    /// constraint. Cycle-safe and TOTAL: a cycle is already rejected at
    /// declaration by <c>GS0581</c>, and the visited set terminates the walk on
    /// a malformed symbol graph anyway.
    /// </summary>
    /// <remarks>
    /// <para>Issue #4084 made this <see langword="internal"/>: the IMPORTED
    /// twin of #4067's rule,
    /// <c>ClrOverloadResolution.TypeParameterSatisfiesClrBound</c>, asks the
    /// same "which parameters does this one stand for" question and had a
    /// second, narrower walk that read only <c>ClassConstraint</c>. This is a
    /// pure symbol walk with no <c>Type</c> dependency, so both sides can
    /// share it — and a dependent bound now forwards on both.</para>
    /// <para><b>Review finding (#4084): the 32-element cap is gone.</b> It was
    /// belt-and-braces on top of the visited set, and it was LOSSY: a chain of
    /// 40 dependent bounds ending in a class or interface bound was truncated
    /// and the bound reported unforwarded. Measured on this branch's parent
    /// <c>b4478875</c> and before this removal — a 40-link chain reported
    /// <c>GS0159</c> at an imported generic method and <c>GS0580</c> at an
    /// imported generic type, while the 5-link control bound. The cap was
    /// never needed: <see cref="AddForwardedParameter"/> refuses a parameter
    /// already in the set, so the walk visits each DISTINCT parameter at most
    /// once and terminates on any graph, cyclic or not. The membership test is
    /// a <see cref="HashSet{T}"/> on reference identity so removing the bound
    /// does not turn the walk quadratic.</para>
    /// </remarks>
    /// <param name="argument">The type parameter to walk from.</param>
    /// <returns>The chain, argument first.</returns>
    internal static List<TypeParameterSymbol> EnumerateForwardedParameterChain(TypeParameterSymbol argument)
    {
        var chain = new List<TypeParameterSymbol> { argument };
        var visited = new HashSet<TypeParameterSymbol>(ReferenceEqualityComparer.Instance) { argument };
        for (var i = 0; i < chain.Count; i++)
        {
            var current = chain[i];
            AddForwardedParameter(chain, visited, current.TypeParameterBound);
            AddForwardedParameter(chain, visited, current.ClassConstraint as TypeParameterSymbol);
        }

        return chain;
    }

    /// <summary>
    /// Issue #4067: appends <paramref name="candidate"/> to
    /// <paramref name="chain"/> when it is present and not already there.
    /// </summary>
    /// <remarks>
    /// This deduplication is what makes
    /// <see cref="EnumerateForwardedParameterChain"/> total, so it is the only
    /// termination guarantee the walk has and must not be weakened.
    /// </remarks>
    /// <param name="chain">The chain being built.</param>
    /// <param name="visited">The parameters already in the chain.</param>
    /// <param name="candidate">The parameter to append, if any.</param>
    private static void AddForwardedParameter(
        List<TypeParameterSymbol> chain,
        HashSet<TypeParameterSymbol> visited,
        TypeParameterSymbol? candidate)
    {
        if (candidate == null || !visited.Add(candidate))
        {
            return;
        }

        chain.Add(candidate);
    }

    /// <summary>
    /// Issue #4067: whether any type parameter in the chain answers
    /// <paramref name="predicate"/>.
    /// </summary>
    /// <param name="parameters">The forwarded-bound chain.</param>
    /// <param name="predicate">The property asked of each parameter's own declaration.</param>
    /// <returns><see langword="true"/> when one answers.</returns>
    private static bool AnyParameter(
        List<TypeParameterSymbol> parameters,
        Func<TypeParameterSymbol, bool> predicate)
    {
        foreach (var parameter in parameters)
        {
            if (predicate(parameter))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #4067: whether any type parameter in the chain, OR any concrete
    /// bound those parameters carry, answers <paramref name="predicate"/>. A
    /// type bound is implied by the class or interface a parameter is bounded
    /// by, which is why the concrete bounds are asked too.
    /// </summary>
    /// <param name="parameters">The forwarded-bound chain.</param>
    /// <param name="predicate">The relation asked of each candidate.</param>
    /// <returns><see langword="true"/> when one answers.</returns>
    private static bool AnyBound(
        List<TypeParameterSymbol> parameters,
        Func<TypeSymbol, bool> predicate)
    {
        foreach (var parameter in parameters)
        {
            if (predicate(parameter))
            {
                return true;
            }

            if (parameter.ClassConstraint is { } classBound && predicate(classBound))
            {
                return true;
            }

            if (parameter.InterfaceConstraint is { } userInterfaceBound && predicate(userInterfaceBound))
            {
                return true;
            }

            if (parameter.ClrInterfaceConstraint is { } clrInterfaceBound && predicate(clrInterfaceBound))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #4032 (review follow-up), reused by #4037: whether a
    /// byte-identical diagnostic (same id, same span, same message) already
    /// stands in <paramref name="diagnostics"/>.
    /// </summary>
    /// <remarks>
    /// The generic-receiver resolvers are BACKTRACKING PROBES — measured with
    /// a stack dump at the probe's entry, `Handler[string].Describe()` reaches
    /// one twice and `System.Nullable[string].Value` three times, because
    /// <c>BindAccessorExpression</c> re-attempts THE SAME qualified walk
    /// through several entry points. A per-call report turned one violation
    /// into three identical errors, and the COUNT was a function of how many
    /// internal paths the binder happened to take. Suppressing an exact
    /// duplicate loses nothing a reader could have distinguished, and the repo
    /// already takes that position
    /// (<c>DiagnosticBag.SuppressDuplicateDiagnosticsIn</c>). Callers keep
    /// returning "invalid, stop" even when the print was suppressed.
    /// </remarks>
    /// <param name="diagnostics">The bag to search.</param>
    /// <param name="id">The diagnostic id.</param>
    /// <param name="message">The fully formatted message.</param>
    /// <param name="location">The anchor location.</param>
    /// <returns><see langword="true"/> when the identical diagnostic is present.</returns>
    private static bool AlreadyReportedHere(
        DiagnosticBag diagnostics,
        string id,
        string message,
        TextLocation location)
    {
        foreach (var existing in diagnostics)
        {
            if (string.Equals(existing.Id, id, StringComparison.Ordinal)
                && ReferenceEquals(existing.Location.Text, location.Text)
                && existing.Location.Span.Start == location.Span.Start
                && existing.Location.Span.Length == location.Span.Length
                && string.Equals(existing.Message, message, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #4032: renders the constraint that a closed generic type clause
    /// failed, for the <c>GS0152</c> message.
    /// </summary>
    /// <param name="typeParameter">The CLR generic parameter.</param>
    /// <param name="failedConstraint">
    /// The type-bound constraint that failed, or <see langword="null"/> when a
    /// special (<c>class</c>/<c>struct</c>/<c>new()</c>) constraint did.
    /// </param>
    /// <returns>A short human-readable constraint description.</returns>
    private static string DescribeClrConstraint(Type typeParameter, Type? failedConstraint)
    {
        if (failedConstraint != null)
        {
            var name = failedConstraint.FullName ?? failedConstraint.Name;
            var tick = name.IndexOf('`');
            return tick >= 0 ? name.Substring(0, tick) : name;
        }

        GenericParameterAttributes attributes;
        try
        {
            attributes = typeParameter.GenericParameterAttributes;
        }
        catch (Exception)
        {
            return typeParameter.Name;
        }

        var special = attributes & GenericParameterAttributes.SpecialConstraintMask;
        if ((special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0)
        {
            return "struct";
        }

        if ((special & GenericParameterAttributes.ReferenceTypeConstraint) != 0)
        {
            return "class";
        }

        if ((special & GenericParameterAttributes.DefaultConstructorConstraint) != 0)
        {
            return "new()";
        }

        return typeParameter.Name;
    }

    /// <summary>
    /// ADR-0041: binds the return-type clause of a function (declaration,
    /// method, extension, or lambda). When <paramref name="isAsync"/> is
    /// <c>true</c> and the clause is the top-level <c>sequence[T]</c> alias
    /// (optionally nullable), the alias resolves to
    /// <see cref="AsyncSequenceTypeSymbol"/> (i.e. <c>IAsyncEnumerable[T]</c>)
    /// rather than the synchronous <see cref="SequenceTypeSymbol"/>.
    /// In every other position — parameter types, locals, generic arguments,
    /// nested type clauses — <c>sequence[T]</c> continues to mean
    /// <c>IEnumerable[T]</c> (ADR-0040).
    /// </summary>
    private TypeSymbol? BindReturnTypeClause(TypeClauseSyntax? syntax, bool isAsync)
    {
        var bound = BindTypeClause(syntax);
        if (!isAsync || bound == null)
        {
            return bound;
        }

        if (bound is SequenceTypeSymbol seq)
        {
            return AsyncSequenceTypeSymbol.Get(seq.ElementType);
        }

        var nt = bound as NullableTypeSymbol;
        var innerSeq = nt?.UnderlyingType as SequenceTypeSymbol;
        if (innerSeq != null)
        {
            return NullableTypeSymbol.Get(AsyncSequenceTypeSymbol.Get(innerSeq.ElementType));
        }

        return bound;
    }

    // Issue #4222: internal (not private) so RefStructAsyncLivenessAnalyzer can
    // gate its per-suspension-point liveness analysis on iterator functions too
    // (native ref-alias locals), without duplicating this return-type check.
    internal static bool IsIteratorReturnType(TypeSymbol type)
    {
        if (type == null)
        {
            return false;
        }

        if (type is SequenceTypeSymbol)
        {
            return true;
        }

        // Issue #798: `async sequence[T]` (AsyncSequenceTypeSymbol) is the
        // ADR-0041 alias for `IAsyncEnumerable[T]`. For an in-scope generic
        // T it cannot be keyed by the ClrType branch below because
        // `AsyncSequenceTypeSymbol.MakeClrType` returns null when the
        // element type carries no CLR projection. Recognize the symbolic
        // form so `yield` is accepted inside `async func ... sequence[T]`.
        if (type is AsyncSequenceTypeSymbol)
        {
            return true;
        }

        var clr = type.ClrType;
        if (clr == null)
        {
            return false;
        }

        // Use FullName matching rather than typeof identity: when gsc is
        // invoked with explicit `/r:` references (the production SDK build
        // path) the IEnumerable types come from a MetadataLoadContext, not
        // the host process, so `clr == typeof(System.Collections.IEnumerable)`
        // would be false even for the canonical types. The async branch below
        // already uses FullName for the same reason.
        if (clr.FullName == "System.Collections.IEnumerable" ||
            clr.FullName == "System.Collections.IEnumerator")
        {
            return true;
        }

        if (clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            var def = clr.GetGenericTypeDefinition();
            if (def.FullName == "System.Collections.Generic.IEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IEnumerator`1")
            {
                return true;
            }

            // Async iterators: IAsyncEnumerable<T> / IAsyncEnumerator<T>
            if (def.FullName == "System.Collections.Generic.IAsyncEnumerable`1" ||
                def.FullName == "System.Collections.Generic.IAsyncEnumerator`1")
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Checks if the return type is IAsyncEnumerable[T] or IAsyncEnumerator[T].
    /// Functions with such return types are implicitly async iterators and allow
    /// both yield and await without requiring the 'async' keyword.
    /// </summary>
    private static bool IsAsyncIteratorReturnType(TypeSymbol type)
    {
        // Issue #798: an open-T `async sequence[T]` carries a null ClrType
        // because AsyncSequenceTypeSymbol erases its element type via the
        // CLR projection. Honor the symbolic form so `await` + `yield`
        // inside such a function are accepted without requiring the
        // explicit `async` modifier (per the existing implicit-async
        // contract for IAsyncEnumerable returns).
        if (type is AsyncSequenceTypeSymbol)
        {
            return true;
        }

        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return false;
        }

        var def = clr.GetGenericTypeDefinition();
        var fullName = def?.FullName;
        return fullName == "System.Collections.Generic.IAsyncEnumerable`1"
            || fullName == "System.Collections.Generic.IAsyncEnumerator`1";
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="type"/> denotes an
    /// <c>async sequence</c> — i.e. <c>IAsyncEnumerable&lt;T&gt;</c>. Used
    /// by the <c>@EnumeratorCancellation</c> binder check (ADR-0040 /
    /// issue #180): only sequences expose
    /// <c>GetAsyncEnumerator(CancellationToken)</c> so threading a token
    /// through a marked parameter is only meaningful here, not on a bare
    /// <c>IAsyncEnumerator&lt;T&gt;</c>.
    /// </summary>
    private static bool IsAsyncSequenceReturnType(TypeSymbol type)
    {
        // Issue #798: see IsAsyncIteratorReturnType — open-T
        // AsyncSequenceTypeSymbol has a null ClrType so honor it
        // symbolically too.
        if (type is AsyncSequenceTypeSymbol)
        {
            return true;
        }

        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType || clr.IsGenericTypeDefinition)
        {
            return false;
        }

        var def = clr.GetGenericTypeDefinition();
        return def?.FullName == "System.Collections.Generic.IAsyncEnumerable`1";
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="type"/> already denotes a
    /// Task-shaped awaitable (Task, Task[T], ValueTask, or ValueTask[T]).
    /// Used by the <c>async func(...)</c> type-clause binder (ADR-0043) to
    /// reject explicit Task wrapping where the modifier already implies it.
    /// </summary>
    private static bool IsTaskShapedReturn(TypeSymbol type)
    {
        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        string? fullName;
        if (clr.IsGenericType && !clr.IsGenericTypeDefinition)
        {
            fullName = clr.GetGenericTypeDefinition()?.FullName;
        }
        else
        {
            fullName = clr.FullName;
        }

        return fullName == "System.Threading.Tasks.Task"
            || fullName == "System.Threading.Tasks.Task`1"
            || fullName == "System.Threading.Tasks.ValueTask"
            || fullName == "System.Threading.Tasks.ValueTask`1";
    }

    // Issue #522: bind `T(args) { Prop1 = v1, Prop2 = v2, … }` object
    // initializer. The construction is lowered to a synthetic local plus a
    // sequence of property assignments:
    //   { var $tmp = T(args); $tmp.Prop1 = v1; $tmp.Prop2 = v2; $tmp }
    // Init-only setters are emitted via the regular setter call path; the
    // emit-side modreq fix (EncodeReturnClr) makes the resulting IL valid.

    // Issue #522: bind a single `Prop = value` initializer against a known
    // receiver local. Mirrors the property/field write logic in
    // BindFieldAssignmentExpression so init-only setters, regular setters,
    // user-defined struct properties, and CLR-base inherited members all
    // route through the same lowering.

    /// <summary>ADR-0060: human-readable label for a <see cref="RefKind"/>.</summary>
    /// <param name="kind">The ref-kind value.</param>
    /// <returns>"none", "ref", "out", or "in".</returns>
    private static string RefKindToString(RefKind kind) => kind switch
    {
        RefKind.Ref => "ref",
        RefKind.Out => "out",
        RefKind.In => "in",
        _ => "none",
    };

    /// <summary>
    /// ADR-0063: render a function's signature in a human-readable form for diagnostics.
    /// </summary>
    /// <param name="function">The function whose signature should be formatted.</param>
    /// <returns>A human-readable signature string (e.g. <c>F(in int, out string)</c>).</returns>
    internal static string FormatOverloadSignature(FunctionSymbol function)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(function.Name);
        sb.Append('(');
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            var p = function.Parameters[i];
            if (p.RefKind != RefKind.None)
            {
                sb.Append(RefKindToString(p.RefKind));
                sb.Append(' ');
            }

            sb.Append(p.Type?.Name ?? "?");
        }

        sb.Append(')');
        return sb.ToString();
    }

    /// <summary>
    /// ADR-0065 §2 Rule 3: ensures the body of a <c>convenience init</c>
    /// begins with a <c>init(args)</c> self-delegation. Reports
    /// <c>GS0278</c> when violated. Empty bodies and bodies whose first
    /// statement is anything other than a chaining expression-statement are
    /// rejected.
    /// </summary>
    private static void VerifyConvenienceInitDelegatesFirst(ConstructorSymbol ctor, BoundStatement boundBody, DiagnosticBag diagnostics)
    {
        if (ctor.Declaration == null)
        {
            return;
        }

        var location = ctor.Declaration.InitKeyword.Location;

        var firstNonNoOp = FindFirstSignificantStatement(boundBody);
        if ((firstNonNoOp is BoundExpressionStatement exprStmt
            && IsConstructorChainingExpression(exprStmt.Expression))
            || StartsWithConstructorDelegationSyntax(ctor.Declaration.Body))
        {
            return;
        }

        diagnostics.ReportConvenienceInitMustDelegate(location, ctor.DeclaringType?.Name ?? "?");
    }

    private static bool StartsWithConstructorDelegationSyntax(BlockStatementSyntax body)
    {
        return body.Statements.Length > 0
            && body.Statements[0] is ExpressionStatementSyntax { Expression: CallExpressionSyntax call }
            && call.Identifier.ValueText == "init";
    }

    private static bool IsConstructorChainingExpression(BoundExpression expression)
        => expression is BoundConstructorChainingExpression
            || (expression is BoundBlockExpression block
                && IsConstructorChainingExpression(block.Expression))
            || (expression is BoundConversionExpression conversion
                && IsConstructorChainingExpression(conversion.Expression))
            || (expression is BoundSpillSequenceExpression spill
                && IsConstructorChainingExpression(spill.Value));

    /// <summary>
    /// ADR-0065 §2: recursively descends into a single-statement block to find
    /// the first effective top-level statement. Used by
    /// <see cref="VerifyConvenienceInitDelegatesFirst"/> to allow trivial
    /// pre-pass wrapping (e.g. statements injected by lowering passes added
    /// at a later date) without giving up on the chaining check.
    /// </summary>
    private static BoundStatement? FindFirstSignificantStatement(BoundStatement statement)
    {
        if (statement is BoundBlockStatement block)
        {
            for (var i = 0; i < block.Statements.Length; i++)
            {
                var inner = FindFirstSignificantStatement(block.Statements[i]);
                if (inner != null)
                {
                    return inner;
                }
            }

            return null;
        }

        return statement;
    }

    /// <summary>
    /// ADR-0060: maps a ref-kind modifier syntax token to a <see cref="RefKind"/> value.
    /// </summary>
    /// <param name="modifier">The <c>ref</c>/<c>out</c>/<c>in</c> contextual-keyword token (<see langword="null"/> for none).</param>
    /// <returns>The corresponding <see cref="RefKind"/> value.</returns>
    private static RefKind GetRefKindFromModifier(SyntaxToken? modifier)
    {
        if (modifier == null)
        {
            return RefKind.None;
        }

        return modifier.Text switch
        {
            "ref" => RefKind.Ref,
            "out" => RefKind.Out,
            "in" => RefKind.In,
            _ => RefKind.None,
        };
    }

    internal static void InferTypeArguments(TypeSymbol parameterType, TypeSymbol argumentType, Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        if (parameterType is TypeParameterSymbol tp)
        {
            // Issue #1531: `void` is never a valid type argument, so a type
            // parameter must not be inferred from a void source. This arises
            // when a void-returning delegate/method-group argument is matched
            // against a `(...)->TResult` (type-parameter-return) delegate
            // parameter: binding `TResult := void` would wrongly make that
            // value-returning overload applicable and tie it with the intended
            // `(...)->void` overload (spurious GS0266). Skipping the binding
            // leaves the type parameter un-inferred, so the candidate is
            // rejected and the `(...)->void` overload wins unambiguously.
            if (argumentType == TypeSymbol.Void
                || TypeSymbol.ContainsNullLiteralType(argumentType))
            {
                return;
            }

            // Join compatible nullable-reference evidence across arguments.
            // The post-substitution applicability check still rejects genuine
            // type conflicts.
            if (substitution.TryGetValue(tp, out var existing))
            {
                substitution[tp] = MemberLookup.MergeInferredTypeArgument(existing, argumentType) ?? existing;
            }
            else
            {
                substitution[tp] = argumentType;
            }

            return;
        }

        var importedParameterType = parameterType as ImportedTypeSymbol;
        if (importedParameterType is not null && importedParameterType.HasTypeParameterArgument)
        {
            InferImportedTypeArguments(importedParameterType, argumentType, substitution);
            return;
        }

        if (parameterType is NullableTypeSymbol pn)
        {
            // Issue #1931: a `T?` parameter also accepts a non-nullable argument
            // (every value is trivially convertible to its own nullable form,
            // same as a plain `T`-typed parameter would). Without this, a
            // generic method's only `T?` parameter never contributes to `T`
            // inference and every call site needs an explicit `[T]` (GS0151),
            // even though the equivalent non-nullable `T` parameter infers fine.
            InferTypeArguments(pn.UnderlyingType, argumentType is NullableTypeSymbol an ? an.UnderlyingType : argumentType, substitution);
        }
        else if (parameterType is SliceTypeSymbol ps && argumentType is SliceTypeSymbol asym)
        {
            InferTypeArguments(ps.ElementType, asym.ElementType, substitution);
        }
        else if (parameterType is ChannelTypeSymbol pc
            && ChannelTypeSymbol.TryGetChannelShape(argumentType, out var argumentElement, out _, out _))
        {
            // ADR-0174 D2/D9: `T` in `chan[T]` — including a directional
            // parameter taking a bidirectional argument, since `chan[int32]`
            // converts to `in chan[int32]` and the element is what is being
            // inferred either way. Without this, `merge(a, b)` cannot infer its
            // element and every generic channel function has to be called with
            // an explicit type argument.
            InferTypeArguments(pc.ElementType, argumentElement, substitution);
        }
        else if (parameterType is ArrayTypeSymbol pa && argumentType is ArrayTypeSymbol aa)
        {
            InferTypeArguments(pa.ElementType, aa.ElementType, substitution);

            // #611 intentional asymmetry: a fixed-array `[N]T` does NOT unify
            // against a slice parameter `[]T` (or vice versa). In Go, explicit
            // slicing is required to produce a slice from a fixed-length array.
            // The CLR-level inference path (ClrOverloadResolution.UnifyForInference)
            // handles this differently because both map to CLR T[], but at the
            // GSharp semantic level they are distinct types.
        }
        else if (parameterType is RectangularArrayTypeSymbol pr
            && argumentType is RectangularArrayTypeSymbol ar
            && pr.Rank == ar.Rank)
        {
            InferTypeArguments(pr.ElementType, ar.ElementType, substitution);
        }
        else if (parameterType is TupleTypeSymbol parameterTuple
            && argumentType is TupleTypeSymbol argumentTuple
            && parameterTuple.Arity == argumentTuple.Arity)
        {
            for (var i = 0; i < parameterTuple.Arity; i++)
            {
                InferTypeArguments(
                    parameterTuple.ElementTypes[i],
                    argumentTuple.ElementTypes[i],
                    substitution);
            }
        }
        else if (parameterType is SequenceTypeSymbol pseq)
        {
            // Issue #773 / ADR-0084 §L2: an extension declared as
            // `func (self sequence[T]) ...` must infer T from any
            // call-site receiver whose static type is sequence-compatible —
            // another `sequence[U]`, a `[]U` slice, a fixed `[N]U` array,
            // or any CLR type that implements `IEnumerable<U>`.
            switch (argumentType)
            {
                case SequenceTypeSymbol aseq:
                    InferTypeArguments(pseq.ElementType, aseq.ElementType, substitution);
                    break;
                case SliceTypeSymbol asl:
                    InferTypeArguments(pseq.ElementType, asl.ElementType, substitution);
                    break;
                case ArrayTypeSymbol aarr:
                    InferTypeArguments(pseq.ElementType, aarr.ElementType, substitution);
                    break;
                default:
                    var openIEnumerable = typeof(System.Collections.Generic.IEnumerable<>);
                    if (TryFindUniqueGenericProjection(
                        argumentType,
                        openIEnumerable,
                        out var sequenceArguments,
                        out _)
                        && sequenceArguments.Length == 1)
                    {
                        InferTypeArguments(
                            pseq.ElementType,
                            sequenceArguments[0],
                            substitution);
                    }

                    break;
            }
        }
        else if (parameterType is AsyncSequenceTypeSymbol paseq)
        {
            // Mirror of the synchronous-sequence inference for `async sequence[T]`.
            switch (argumentType)
            {
                case AsyncSequenceTypeSymbol aaseq:
                    InferTypeArguments(paseq.ElementType, aaseq.ElementType, substitution);
                    break;
                default:
                    var openIAsyncEnumerable = typeof(System.Collections.Generic.IAsyncEnumerable<>);
                    if (TryFindUniqueGenericProjection(
                        argumentType,
                        openIAsyncEnumerable,
                        out var asyncSequenceArguments,
                        out _)
                        && asyncSequenceArguments.Length == 1)
                    {
                        InferTypeArguments(
                            paseq.ElementType,
                            asyncSequenceArguments[0],
                            substitution);
                    }

                    break;
            }
        }
        else if (parameterType is FunctionTypeSymbol pf && argumentType is FunctionTypeSymbol af
            && pf.ParameterTypes.Length == af.ParameterTypes.Length)
        {
            // Infer type parameters that appear inside a delegate parameter,
            // e.g. `f func(T) U` matched against `func(int32) bool` yields
            // T -> int32, U -> bool.
            for (var i = 0; i < pf.ParameterTypes.Length; i++)
            {
                InferTypeArguments(pf.ParameterTypes[i], af.ParameterTypes[i], substitution);
            }

            InferTypeArguments(pf.ReturnType, af.ReturnType, substitution);
        }
        else if (TryGetUserGenericArguments(parameterType, out var userParamDef, out var userParamArgs)
            && userParamArgs.Any(TypeSymbol.ContainsTypeParameter))
        {
            // Issue #1932: mirror the ImportedTypeSymbol (`List[T]`) inference
            // below for USER-DEFINED generic types (struct/class `StructSymbol`,
            // `interface InterfaceSymbol`) — e.g. parameter `Pair[T]` matched
            // against argument `Pair[string]`, or parameter `IHolder[T]`
            // matched against an argument whose type implements `IHolder[string]`.
            // Unify positionally against whichever constructed instance (the
            // argument itself, or one of its implemented interfaces) shares the
            // parameter's generic definition.
            if (TryFindUserGenericArguments(argumentType, userParamDef, out var userArgArgs)
                && userParamArgs.Length == userArgArgs.Length)
            {
                for (var i = 0; i < userParamArgs.Length; i++)
                {
                    InferTypeArguments(userParamArgs[i], userArgArgs[i], substitution);
                }
            }
        }
    }

    private static void InferImportedTypeArguments(
        ImportedTypeSymbol parameterType,
        TypeSymbol argumentType,
        Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        var foundProjection = false;
        if (parameterType.OpenDefinition != null
            && TryFindUniqueGenericProjection(
                argumentType,
                parameterType.OpenDefinition,
                out var mappedArguments,
                out foundProjection))
        {
            if (mappedArguments.Length == parameterType.TypeArguments.Length)
            {
                for (var i = 0; i < parameterType.TypeArguments.Length; i++)
                {
                    InferTypeArguments(
                        parameterType.TypeArguments[i],
                        mappedArguments[i],
                        substitution);
                }
            }

            return;
        }

        if (!foundProjection
            && (argumentType is SliceTypeSymbol || argumentType is ArrayTypeSymbol)
            && parameterType.TypeArguments.Length == 1
            && IsArrayCompatibleOpenInterface(parameterType.OpenDefinition))
        {
            var elementType = argumentType is SliceTypeSymbol slice
                ? slice.ElementType
                : ((ArrayTypeSymbol)argumentType).ElementType;
            InferTypeArguments(parameterType.TypeArguments[0], elementType, substitution);
        }
    }

    // Issue #3465: imported argument types can expose a generic parameter
    // shape through a non-generic concrete type's base class or interfaces.
    // Example: FieldDefinitionHandleCollection implements
    // IReadOnlyCollection<FieldDefinitionHandle>.
    private static bool TryFindUniqueClrGenericProjection(
        Type clrType,
        Type openDefinition,
        out ImmutableArray<TypeSymbol> projection,
        out bool foundProjection)
    {
        projection = ImmutableArray<TypeSymbol>.Empty;
        foundProjection = false;
        if (!openDefinition.IsGenericTypeDefinition)
        {
            return false;
        }

        try
        {
            var pending = new Stack<Type>();
            var visited = new HashSet<Type>();
            pending.Push(clrType);
            while (pending.Count > 0)
            {
                var current = pending.Pop();
                if (!visited.Add(current))
                {
                    continue;
                }

                if (current.IsGenericType
                    && current.GetGenericTypeDefinition().IsSameAs(openDefinition))
                {
                    var arguments = current.GetGenericArguments()
                        .Select(TypeSymbol.FromClrType)
                        .ToImmutableArray();
                    if (!foundProjection)
                    {
                        projection = arguments;
                        foundProjection = true;
                    }
                    else if (!TypeArgumentVectorsEquivalent(projection, arguments))
                    {
                        projection = ImmutableArray<TypeSymbol>.Empty;
                        return false;
                    }
                }

                foreach (var iface in current.GetInterfaces())
                {
                    pending.Push(iface);
                }

                if (current.BaseType != null)
                {
                    pending.Push(current.BaseType);
                }
            }

            return foundProjection;
        }
        catch (Exception)
        {
            // MLC cross-context or other reflection failure — treat as no match.
            projection = ImmutableArray<TypeSymbol>.Empty;
            foundProjection = false;
            return false;
        }
    }

    private static bool TryFindUniqueGenericProjection(
        TypeSymbol type,
        Type openDefinition,
        out ImmutableArray<TypeSymbol> projection,
        out bool foundProjection)
    {
        projection = ImmutableArray<TypeSymbol>.Empty;
        foundProjection = false;
        var pending = new Stack<TypeSymbol>();
        var visited = new HashSet<TypeSymbol>();
        pending.Push(type);

        while (pending.Count > 0)
        {
            var current = pending.Pop();
            if (!visited.Add(current))
            {
                continue;
            }

            ImmutableArray<TypeSymbol> currentProjection = default;
            var currentFound = false;
            var currentAgrees = true;
            if (current is ImportedTypeSymbol imported
                && imported.OpenDefinition != null)
            {
                currentAgrees =
                    MemberLookup.TryMapUniqueConstructedTypeArgumentsThroughHierarchy(
                        imported,
                        openDefinition,
                        out currentProjection,
                        out currentFound);
            }
            else if (current.ClrType is { } clrType)
            {
                currentAgrees = TryFindUniqueClrGenericProjection(
                    clrType,
                    openDefinition,
                    out currentProjection,
                    out currentFound);
            }

            if (currentFound)
            {
                if (!currentAgrees)
                {
                    projection = ImmutableArray<TypeSymbol>.Empty;
                    foundProjection = true;
                    return false;
                }

                if (!foundProjection)
                {
                    projection = currentProjection;
                    foundProjection = true;
                }
                else if (!TypeArgumentVectorsEquivalent(projection, currentProjection))
                {
                    projection = ImmutableArray<TypeSymbol>.Empty;
                    return false;
                }
            }

            if (current is StructSymbol currentStruct)
            {
                if (currentStruct.BaseClass != null)
                {
                    pending.Push(currentStruct.BaseClass);
                }

                if (currentStruct.ImportedBaseType != null)
                {
                    pending.Push(currentStruct.ImportedBaseType);
                }

                foreach (var iface in currentStruct.Interfaces)
                {
                    pending.Push(iface);
                }

                foreach (var iface in currentStruct.ImplementedClrInterfaces)
                {
                    pending.Push(iface);
                }
            }
            else if (current is InterfaceSymbol currentInterface)
            {
                foreach (var baseInterface in currentInterface.BaseInterfaces)
                {
                    pending.Push(baseInterface);
                }

                foreach (var baseInterface in currentInterface.BaseClrInterfaces)
                {
                    pending.Push(baseInterface);
                }
            }
        }

        return foundProjection;
    }

    // Issue #1932: extract the generic definition + constructed type arguments
    // of a USER-DEFINED generic type (`struct`/`class` -> StructSymbol,
    // `interface` -> InterfaceSymbol), so generic-method inference can unify
    // a parameter like `Pair[T]` against an argument like `Pair[string]` the
    // same way it already does for imported CLR generics (`List[T]`).
    private static bool TryGetUserGenericArguments(TypeSymbol type, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out TypeSymbol? definition, out ImmutableArray<TypeSymbol> typeArguments)
    {
        switch (type)
        {
            case StructSymbol s when !s.TypeArguments.IsDefaultOrEmpty:
                definition = s.Definition;
                typeArguments = s.TypeArguments;
                return true;
            case InterfaceSymbol i when !i.TypeArguments.IsDefaultOrEmpty:
                definition = i.Definition;
                typeArguments = i.TypeArguments;
                return true;
            default:
                definition = null;
                typeArguments = ImmutableArray<TypeSymbol>.Empty;
                return false;
        }
    }

    // Issue #1932 / #3465: find a unique constructed projection of `definition`
    // across the complete substituted source base/interface closure.
    private static bool TryFindUserGenericArguments(TypeSymbol type, TypeSymbol definition, out ImmutableArray<TypeSymbol> typeArguments)
    {
        typeArguments = ImmutableArray<TypeSymbol>.Empty;
        var pending = new Stack<TypeSymbol>();
        var visited = new HashSet<TypeSymbol>();
        var foundProjection = false;
        pending.Push(type);

        while (pending.Count > 0)
        {
            var current = pending.Pop();
            if (!visited.Add(current))
            {
                continue;
            }

            if (TryGetUserGenericArguments(current, out var currentDefinition, out var currentArguments)
                && ReferenceEquals(currentDefinition, definition))
            {
                if (!foundProjection)
                {
                    typeArguments = currentArguments;
                    foundProjection = true;
                }
                else if (!TypeArgumentVectorsEquivalent(typeArguments, currentArguments))
                {
                    typeArguments = ImmutableArray<TypeSymbol>.Empty;
                    return false;
                }
            }

            if (current is StructSymbol currentStruct)
            {
                if (currentStruct.BaseClass != null)
                {
                    pending.Push(currentStruct.BaseClass);
                }

                foreach (var iface in currentStruct.Interfaces)
                {
                    pending.Push(iface);
                }
            }
            else if (current is InterfaceSymbol currentInterface)
            {
                foreach (var baseInterface in currentInterface.BaseInterfaces)
                {
                    pending.Push(baseInterface);
                }
            }
        }

        return foundProjection;
    }

    private static bool TypeArgumentVectorsEquivalent(
        ImmutableArray<TypeSymbol> left,
        ImmutableArray<TypeSymbol> right)
    {
        if (left.Length != right.Length)
        {
            return false;
        }

        for (var i = 0; i < left.Length; i++)
        {
            if (!DeclarationBinder.TypeSignaturesEquivalent(left[i], right[i]))
            {
                return false;
            }
        }

        return true;
    }

    // #313: surface the CLR generic arguments of an argument type (e.g. the
    // `int32` of a `List<int32>` argument) as GSharp type symbols, so they can
    // be unified positionally against the symbolic arguments of a `List[T]`
    // parameter during type-argument inference.
    internal static ImmutableArray<TypeSymbol> GetClrGenericArguments(TypeSymbol type)
    {
        if (type is ImportedTypeSymbol it && !it.TypeArguments.IsDefaultOrEmpty)
        {
            return it.TypeArguments;
        }

        var clr = type?.ClrType;
        if (clr == null || !clr.IsGenericType)
        {
            return ImmutableArray<TypeSymbol>.Empty;
        }

        var args = clr.GetGenericArguments();
        var builder = ImmutableArray.CreateBuilder<TypeSymbol>(args.Length);
        foreach (var a in args)
        {
            builder.Add(TypeSymbol.FromClrType(a));
        }

        return builder.MoveToImmutable();
    }

    // Issue #2416: the fixed, closed set of single-type-parameter generic
    // interfaces that the CLR guarantees every single-dimensional array
    // (`T[]`) implements, regardless of whether `T` has been emitted yet.
    // Used to symbolically unify a slice/array argument against an
    // `IEnumerable[T]`-shaped (or equivalent) generic parameter when the
    // array's element type has no `ClrType` (still source-only), so
    // reflection-based generic-projection lookup
    // isn't available.
    private static bool IsArrayCompatibleOpenInterface(Type? openDefinition)
    {
        if (openDefinition == null || !openDefinition.IsGenericTypeDefinition)
        {
            return false;
        }

        return openDefinition.IsSameAs(typeof(System.Collections.Generic.IEnumerable<>))
            || openDefinition.IsSameAs(typeof(System.Collections.Generic.ICollection<>))
            || openDefinition.IsSameAs(typeof(System.Collections.Generic.IList<>))
            || openDefinition.IsSameAs(typeof(System.Collections.Generic.IReadOnlyCollection<>))
            || openDefinition.IsSameAs(typeof(System.Collections.Generic.IReadOnlyList<>));
    }

    /// <summary>
    /// Substitutes type parameters in <paramref name="type"/> using
    /// <paramref name="substitution"/>. Equivalent to calling the
    /// <see cref="SubstituteType(TypeSymbol, Dictionary{TypeParameterSymbol, TypeSymbol}, Func{Type, Type})"/>
    /// overload with a <see langword="null"/> CLR-type mapper (safe for
    /// single-reflection-context callers, i.e. every compile that does not
    /// pass an explicit <c>/r:</c> reference set to <c>gsc</c>).
    /// </summary>
    /// <param name="type">The type to substitute.</param>
    /// <param name="substitution">The type-parameter to type-argument map.</param>
    /// <returns>The substituted type.</returns>
    internal static TypeSymbol SubstituteType(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
        => SubstituteType(type, substitution, null);

    /// <summary>
    /// Issue #1926: <paramref name="mapClrType"/> projects a substituted type
    /// argument's <see cref="TypeSymbol.ClrType"/> into the SAME reflection
    /// context as the constructed generic's <c>OpenDefinition</c> before
    /// calling <see cref="Type.MakeGenericType(Type[])"/>. Well-known
    /// primitive <see cref="TypeSymbol"/>s (e.g. <see cref="TypeSymbol.Int32"/>)
    /// always carry the host process's live <c>typeof(int)</c>, but a
    /// <c>gsc</c> compile that supplies an explicit <c>/r:</c> reference set
    /// resolves imported generics (e.g. <c>IReadOnlyList[T]</c>) through an
    /// isolated <see cref="System.Reflection.MetadataLoadContext"/>.
    /// <c>MakeGenericType</c> throws when its generic-definition and
    /// type-argument <see cref="Type"/>s come from different reflection
    /// contexts, so closing a generic extension's receiver clause (or any
    /// other generic member) over a primitive silently fell back to the
    /// erased <c>object</c>-argument form — which then fails an interface
    /// conversion check that would otherwise succeed (GS0155: <c>List[T]</c>
    /// not convertible to a receiver-clause's <c>IReadOnlyList[T]</c>). Passing
    /// <c>null</c> (the default, single-context callers) skips the projection
    /// and keeps prior behaviour identical.
    /// </summary>
    /// <param name="type">The type to substitute.</param>
    /// <param name="substitution">The type-parameter to type-argument map.</param>
    /// <param name="mapClrType">
    /// Projects a host CLR <see cref="Type"/> into the reflection context that
    /// the type being substituted was resolved from (typically
    /// <see cref="Symbols.ReferenceResolver.MapClrTypeToReferences"/>), or
    /// <see langword="null"/> to skip the projection.
    /// </param>
    /// <returns>The substituted type.</returns>
    internal static TypeSymbol SubstituteType(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol> substitution, Func<Type, Type>? mapClrType)
    {
        if (type is TypeParameterSymbol tp)
        {
            return substitution.TryGetValue(tp, out var concrete) ? concrete : type;
        }

        if (TypeSymbol.TrySubstituteCompositeType(
            type,
            nested => SubstituteType(nested, substitution, mapClrType),
            out var composite))
        {
            return composite;
        }

        // Issue #1250: a member-signature type that is itself a constructed
        // generic G# user class (e.g. `Holder[T]` on `Box[T]`) must have its
        // own type arguments substituted with the receiver's type-argument map
        // so `Holder[T]` surfaces as `Holder[int32]` on `Box[int32]`. Without
        // this branch the constructed type's arguments stay parametric and the
        // bound member binds with `T` still open, failing argument/return/
        // assignment conversions (GS0155 "Cannot convert 'Holder' to 'Holder'").
        // Recurses so nested generics (`Holder[Holder[T]]`,
        // `Dictionary[K, List[V]]`) are substituted too.
        if (type is StructSymbol ss
            && ss.Definition != null
            && !ReferenceEquals(ss.Definition, ss)
            && !ss.TypeArguments.IsDefaultOrEmpty)
        {
            return StructSymbol.SubstituteConstructionArguments(
                ss,
                arg =>
                {
                    return SubstituteType(arg, substitution, mapClrType);
                },
                mapClrType);
        }

        // Issue #1521: a member-signature type that is a reference to a type
        // nested inside the generic being constructed (e.g. the return type
        // `Tag` of `Box[T].MakeTag()`, or a field/local typed `Tag`) must thread
        // the receiver's type-argument map through the enclosing construction so
        // it surfaces as `Box[int32].Tag`. `Tag` declares no own type arguments,
        // so the emitter parents its use-site references/slots at
        // `Box`1+Tag`1<int32>` rather than the open `Box`1+Tag`1<!0>`.
        Func<TypeSymbol, TypeSymbol> substituteEnclosingType =
            nestedType =>
            {
                return SubstituteType(nestedType, substitution, mapClrType);
            };
        if (type is StructSymbol nestedRef && nestedRef.TypeArguments.IsDefaultOrEmpty)
        {
            var newEnclosing = StructSymbol.SubstituteEnclosingArguments(
                nestedRef,
                substituteEnclosingType);
            if (!newEnclosing.IsDefault)
            {
                return StructSymbol.ConstructNested(nestedRef.Definition ?? nestedRef, newEnclosing, mapClrType);
            }
        }

        if (type is EnumSymbol nestedEnum)
        {
            var newEnclosing = EnumSymbol.SubstituteEnclosingArguments(
                nestedEnum,
                substituteEnclosingType);
            if (!newEnclosing.IsDefault)
            {
                return EnumSymbol.ConstructNested(nestedEnum.Definition ?? nestedEnum, newEnclosing);
            }
        }

        // Issue #1250: same recursion for a constructed generic user interface
        // type appearing in a member signature (`IBox[T]` → `IBox[int32]`).
        if (type is InterfaceSymbol ifaceType
            && ifaceType.Definition != null
            && !ReferenceEquals(ifaceType.Definition, ifaceType)
            && !ifaceType.TypeArguments.IsDefaultOrEmpty)
        {
            var newIfaceArgs = ImmutableArray.CreateBuilder<TypeSymbol>(ifaceType.TypeArguments.Length);
            var ifaceChanged = false;
            foreach (var arg in ifaceType.TypeArguments)
            {
                var substituted = SubstituteType(arg, substitution, mapClrType);
                ifaceChanged |= !ReferenceEquals(substituted, arg);
                newIfaceArgs.Add(substituted);
            }

            return ifaceChanged
                ? InterfaceSymbol.Construct(ifaceType.Definition, newIfaceArgs.MoveToImmutable(), mapClrType)
                : type;
        }

        // Issue #2340 follow-up (sibling to the #1503 branch already present
        // in StructSymbol.SubstituteTypeForConstruction): a constructed
        // generic named delegate appearing as a call's parameter or return
        // type (e.g. `func MakeGetter[T](item T) Getter[T]`) must have its own
        // type arguments substituted through the call's method-type-argument
        // map so the bound call surfaces `Getter[int32]` rather than the
        // still-open `Getter[T]`. Without this branch the binder's computed
        // call-expression type stayed open over the callee's own type
        // parameter even though the emitter correctly built a MethodSpec/
        // MemberRef closed over the concrete argument — the mismatch between
        // the (wrong, open) declared type of the receiving local/field and
        // the (correct, closed) value actually produced by the `call`
        // instruction failed ilverify with `StackUnexpected`.
        if (type is DelegateTypeSymbol del
            && del.Definition != null
            && !ReferenceEquals(del.Definition, del)
            && !del.TypeArguments.IsDefaultOrEmpty)
        {
            var newDelegateArgs = ImmutableArray.CreateBuilder<TypeSymbol>(del.TypeArguments.Length);
            var delegateChanged = false;
            foreach (var arg in del.TypeArguments)
            {
                var substituted = SubstituteType(arg, substitution, mapClrType);
                delegateChanged |= !ReferenceEquals(substituted, arg);
                newDelegateArgs.Add(substituted);
            }

            return delegateChanged
                ? DelegateTypeSymbol.Construct(del.Definition, newDelegateArgs.MoveToImmutable())
                : type;
        }

        if (type is ImportedTypeSymbol it && it.HasTypeParameterArgument)
        {
            // #313: substitute a generic type parameterized by an in-scope type
            // parameter (e.g. `List[T]` with {T: int32} → `List<int32>`). When
            // every argument becomes concrete, reconstruct the real closed CLR
            // type so downstream member/index/conversion resolution sees the
            // substituted form; otherwise keep an erased constructed symbol.
            var newArgs = ImmutableArray.CreateBuilder<TypeSymbol>(it.TypeArguments.Length);
            var changed = false;
            var anyFree = false;
            foreach (var arg in it.TypeArguments)
            {
                var substituted = SubstituteType(arg, substitution, mapClrType);
                if (!ReferenceEquals(substituted, arg))
                {
                    changed = true;
                }

                if (TypeSymbol.ContainsTypeParameter(substituted))
                {
                    anyFree = true;
                }

                newArgs.Add(substituted);
            }

            if (!changed)
            {
                return type;
            }

            var substitutedArgs = newArgs.MoveToImmutable();
            if (!anyFree && it.OpenDefinition != null)
            {
                var clrArgs = new System.Type[substitutedArgs.Length];
                var allClr = true;
                for (var i = 0; i < substitutedArgs.Length; i++)
                {
                    if (TypeSymbol.RequiresSymbolicProjection(substitutedArgs[i]))
                    {
                        allClr = false;
                        break;
                    }

                    // A concrete nullable value type carries the bare
                    // underlying CLR type on TypeSymbol.ClrType. Use its
                    // effective Nullable<T> shape when closing an imported
                    // generic. Preserve the erasure of `T?` for an originally
                    // unconstrained type parameter, however: unlike a
                    // struct-constrained `T?`, that annotation is represented
                    // by T itself even when this call later substitutes a
                    // value type (issue #1471).
                    var originalArg = it.TypeArguments[i];
                    var preserveErasedNullableTypeParameter =
                        originalArg is NullableTypeSymbol { UnderlyingType: TypeParameterSymbol originalTypeParameter }
                        && !originalTypeParameter.HasValueTypeConstraint;
                    var clr = preserveErasedNullableTypeParameter
                        ? originalArg is NullableTypeSymbol { UnderlyingType: TypeParameterSymbol nullableTypeParameter }
                            && substitution.TryGetValue(nullableTypeParameter, out var actualType)
                            && actualType is NullableTypeSymbol
                            ? NullableLifting.GetEffectiveClrType(substitutedArgs[i])
                            : substitutedArgs[i].ClrType
                        : NullableLifting.GetEffectiveClrType(substitutedArgs[i]);
                    if (clr == null)
                    {
                        allClr = false;
                        break;
                    }

                    clrArgs[i] = mapClrType != null ? mapClrType(clr) : clr;
                }

                if (allClr)
                {
                    try
                    {
                        return TypeSymbol.FromClrType(it.OpenDefinition.MakeGenericType(clrArgs));
                    }
                    catch (System.ArgumentException)
                    {
                        // MakeGenericType can legitimately throw ArgumentException for CLR
                        // generic constraint reasons (e.g. unmanaged/ref-struct constraints),
                        // not only cross-reflection-context mismatches, so this is NOT always
                        // a bug. Log for diagnosability and fall through to the erased
                        // constructed form so both debug and release builds degrade gracefully
                        // rather than crash.
                        var assertMessage = $"Binder.SubstituteType: MakeGenericType failed for '{it.OpenDefinition}' with args [{FormatClrTypes(clrArgs)}] even after mapClrType projection.";
                        System.Diagnostics.Debug.WriteLine(assertMessage);
                    }
                }
            }

            if (it.OpenDefinition != null)
            {
                var erasedArgs = new System.Type[substitutedArgs.Length];
                var allErased = true;
                for (var i = 0; i < substitutedArgs.Length; i++)
                {
                    if (!MemberLookup.TryProjectErasedClrType(substitutedArgs[i], out var erased)
                        || erased == null)
                    {
                        allErased = false;
                        break;
                    }

                    erasedArgs[i] = mapClrType != null ? mapClrType(erased) : erased;
                }

                if (allErased)
                {
                    try
                    {
                        var erasedClosed = it.OpenDefinition.MakeGenericType(erasedArgs);
                        return ImportedTypeSymbol.GetConstructed(erasedClosed, it.OpenDefinition, substitutedArgs);
                    }
                    catch (System.ArgumentException)
                    {
                        var assertMessage = $"Binder.SubstituteType: erased MakeGenericType failed for '{it.OpenDefinition}' with args [{FormatClrTypes(erasedArgs)}] even after mapClrType projection.";
                        System.Diagnostics.Debug.WriteLine(assertMessage);
                    }
                }
            }

            return ImportedTypeSymbol.GetConstructed(Invariant.Required(it.ClrType, "a constructed imported type has a CLR representation"), it.OpenDefinition, substitutedArgs);
        }

        return type;
    }

    private static string FormatClrTypes(Type[] types)
    {
        var text = new string[types.Length];
        for (var i = 0; i < types.Length; i++)
        {
            text[i] = types[i].ToString();
        }

        return string.Join(", ", text);
    }

    // Phase 4.2 / ADR-0020: returns true if `typeArgument` satisfies the constraint of a
    // type parameter. Both the enum constraint and the optional sealed-interface bound
    // must hold.
    //
    // Issue #4043: `substitution` carries the WHOLE type-argument vector, which
    // a DEPENDENT bound (`[TBase, TDerived TBase]`) needs and a per-position
    // check cannot supply — the question "does TDerived's argument satisfy
    // TBase's bound" is only answerable once TBase's own argument is known.
    // Every other constraint kind ignores it. It is optional and defaults to
    // `null`: a caller that has no vector (or a vector missing the bound
    // parameter) gets the pre-#4043 answer, which ACCEPTS. That direction is
    // deliberate — an indeterminate dependent bound must never manufacture a
    // GS0152 on a program that is legal.
    internal static bool SatisfiesConstraint(
        TypeSymbol typeArgument,
        TypeParameterSymbol tp,
        IReadOnlyDictionary<TypeParameterSymbol, TypeSymbol>? substitution = null)
    {
        // Issue #4043: the dependent bound, checked against the sibling's
        // resolved argument.
        if (tp.TypeParameterBound is { } dependentBound
            && substitution != null
            && substitution.TryGetValue(dependentBound, out var boundArgument)
            && boundArgument != null
            && !ReferenceEquals(boundArgument, dependentBound)
            && !SatisfiesDependentBound(typeArgument, boundArgument, tp))
        {
            return false;
        }

        if (tp.InterfaceConstraint != null)
        {
            var expectedIface = tp.InterfaceConstraint;

            // Issue #1052: a self-referential generic user-interface constraint
            // `[T IFace[T]]` carries the constrained parameter as its own type
            // argument. Substitute it with the actual type argument before the
            // implementation check, so `[T ICmp[T]]` validates that the argument
            // implements `ICmp[argument]` (mirrors the CLR path below).
            if (!expectedIface.TypeArguments.IsDefaultOrEmpty
                && expectedIface.Definition != null
                && !ReferenceEquals(expectedIface.Definition, expectedIface))
            {
                var substArgs = ImmutableArray.CreateBuilder<TypeSymbol>(expectedIface.TypeArguments.Length);
                var changed = false;
                foreach (var arg in expectedIface.TypeArguments)
                {
                    if (ReferenceEquals(arg, tp))
                    {
                        substArgs.Add(typeArgument);
                        changed = true;
                    }
                    else
                    {
                        substArgs.Add(arg);
                    }
                }

                if (changed)
                {
                    expectedIface = InterfaceSymbol.Construct(expectedIface.Definition, substArgs.MoveToImmutable());
                }
            }

            if (!ImplementsInterface(typeArgument, expectedIface))
            {
                return false;
            }
        }

        // Issue #943: enforce a CLR interface constraint (generic or not), e.g.
        // `[T IComparable[T]]`. The type argument must implement the (self-ref
        // substituted) closed interface.
        //
        // Issue #943: enforce a CLR interface constraint (generic or not), e.g.
        // `[T IComparable[T]]`. The type argument must implement the (self-ref
        // substituted) closed interface.
        //
        // A SAME-COMPILATION class has no CLR type while binding, so the
        // reflective probe underneath this used to answer "no" for
        // `class D : IDisposable` at `[TD IDisposable]` — a false rejection
        // #4090's widening would have spread to every type clause. That is
        // #4124, and PR #4138 repairs it at the shared leaf rather than here:
        // the reflective body is split out of `SatisfiesClrInterfaceConstraint`
        // and the symbolic walk wraps every exit of it, so this arm inherits
        // the answer without routing. (#4136 was filed for the same thing from
        // this site's `GS0152` witness and is closed as a duplicate; its
        // proposed fix would have been a FIFTH copy of that fallback, which
        // #4138 deleted rather than added to.)
        if (tp.ClrInterfaceConstraint != null
            && !SatisfiesClrInterfaceConstraint(typeArgument, tp.ClrInterfaceConstraint, tp))
        {
            return false;
        }

        // Issue #1056: enforce a base-class constraint, e.g. `[T Animal]`. The
        // type argument must be the constraint class itself or derive from it
        // (mirrors C#'s `where T : BaseClass`).
        if (tp.ClassConstraint != null
            && !SatisfiesClassConstraint(typeArgument, tp.ClassConstraint))
        {
            return false;
        }

        if (tp.Constraint == TypeParameterConstraint.Comparable && !IsComparable(typeArgument))
        {
            return false;
        }

        // ADR-0097 / issue #775: enforce the `class` / `struct` / `new()`
        // flag-style constraints introduced by the G# spelling.
        if (tp.HasReferenceTypeConstraint && !IsReferenceTypeForConstraint(typeArgument))
        {
            return false;
        }

        if (tp.HasValueTypeConstraint && !IsNonNullableValueTypeForConstraint(typeArgument))
        {
            return false;
        }

        // Issue #1336: enforce the `unmanaged` constraint — the type argument
        // must be an unmanaged type (a non-nullable value type whose fields are
        // recursively unmanaged).
        if (tp.HasUnmanagedConstraint && !IsUnmanagedTypeForConstraint(typeArgument))
        {
            return false;
        }

        if (tp.HasDefaultConstructorConstraint && !HasDefaultConstructorForConstraint(typeArgument))
        {
            return false;
        }

        return true;
    }

    /// <summary>
    /// Issue #4043: returns <see langword="true"/> when the argument supplied for
    /// a DEPENDENTLY bounded type parameter satisfies the bound, given the
    /// argument the bounding parameter itself received. C#'s rule for
    /// <c>where TDerived : TBase</c> is that an implicit reference conversion
    /// (or boxing to <c>object</c>) must exist from the one to the other, so
    /// this composes the relations the binder already owns: identity, the
    /// universal <c>object</c> bound, interface implementation, base-class
    /// derivation, and propagation through a type parameter's own bound.
    /// </summary>
    /// <remarks>
    /// Deliberately built from <see cref="SatisfiesClassConstraint"/> /
    /// <see cref="ImplementsInterface"/> / <see cref="SatisfiesClrInterfaceConstraint"/>
    /// rather than from <c>Conversion.Classify(...).Exists</c>: the conversion
    /// classifier admits user-defined and boxing conversions that a CLR
    /// <c>GenericParamConstraint</c> does not, so a "yes" from it would let
    /// through instantiations the runtime refuses.
    /// <para><b>Indeterminate answers accept.</b> When either side still
    /// mentions an unsubstituted type parameter, the relation has no closed
    /// answer here and the pre-#4043 behaviour (accept) is kept — the CLR only
    /// loads the instantiation once it is closed, and a wrong "no" would be a
    /// GS0152 on a legal program.</para>
    /// </remarks>
    /// <param name="typeArgument">The argument supplied for the bounded parameter.</param>
    /// <param name="boundArgument">The argument supplied for the bounding parameter.</param>
    /// <param name="tp">The bounded type parameter, used only to recognise a
    /// SELF-REFERENTIAL generic interface bound. Issue #4063: the IMPORTED
    /// spelling of this bound reaches the relation from a reflective
    /// <c>Type</c> vector and has no such symbol, so it passes
    /// <see langword="null"/> — and declines to ask at all unless both sides
    /// are closed, which is precisely when self-substitution cannot matter.</param>
    /// <returns><see langword="true"/> when the bound holds or cannot be disproved.</returns>
    internal static bool SatisfiesDependentBound(
        TypeSymbol typeArgument,
        TypeSymbol boundArgument,
        TypeParameterSymbol? tp)
    {
        if (typeArgument is null || boundArgument is null)
        {
            return true;
        }

        if (ReferenceEquals(typeArgument, boundArgument)
            || TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(typeArgument, boundArgument))
        {
            return true;
        }

        // `where TDerived : TBase` with TBase substituted by `object` is the
        // universal bound — every type argument, value types included, converts.
        if (boundArgument.ClrType is { } boundClr
            && string.Equals(boundClr.FullName, "System.Object", StringComparison.Ordinal))
        {
            return true;
        }

        // Propagation: the supplied argument is itself a dependently bounded
        // type parameter whose chain reaches the bound. The chain is acyclic —
        // `ReportCircularConstraints` rejects cycles at declaration — but the
        // walk is bounded anyway so a malformed symbol cannot hang the binder.
        if (typeArgument is TypeParameterSymbol argumentParameter)
        {
            var current = argumentParameter;
            for (var steps = 0; steps < 64 && current.TypeParameterBound is { } next; steps++)
            {
                if (ReferenceEquals(next, boundArgument))
                {
                    return true;
                }

                current = next;
            }
        }

        if (boundArgument is InterfaceSymbol userInterface)
        {
            return ImplementsInterface(typeArgument, userInterface)
                || TypeSymbol.ContainsTypeParameter(typeArgument);
        }

        if (boundArgument.ClrType is { IsInterface: true })
        {
            // Review finding (#4068): a SAME-COMPILATION class or struct that
            // implements the bound interface directly has no CLR type of its
            // own, so the reflective walk returned false without ever reading
            // the symbol's declared interfaces — rejecting
            // `Take[IDisposable, D]` for `class D : IDisposable`, which is a
            // GS0152 on a legal program. Issue #4124 moved that symbolic
            // fallback INTO `SatisfiesClrInterfaceConstraint`, so this arm no
            // longer carries its own copy.
            if (SatisfiesClrInterfaceConstraint(typeArgument, boundArgument, tp))
            {
                return true;
            }

            return TypeSymbol.ContainsTypeParameter(typeArgument);
        }

        if (SatisfiesClassConstraint(typeArgument, boundArgument))
        {
            return true;
        }

        // Indeterminate: an open instantiation has no closed answer to give.
        return TypeSymbol.ContainsTypeParameter(typeArgument)
            || TypeSymbol.ContainsTypeParameter(boundArgument);
    }

    /// <summary>
    /// Review finding (#4068): returns <see langword="true"/> when a
    /// SAME-COMPILATION symbol implements the imported interface a dependent
    /// bound names. Such a symbol has no CLR type while binding, so the
    /// reflective path cannot see its interface list at all.
    /// </summary>
    /// <remarks>
    /// A GENERIC bound is compared on the SYMBOLIC arguments, through the same
    /// walk <c>ClrOverloadResolution</c> uses for the imported-definition side
    /// of this repair — so <c>class Impl : IDep[Bee]</c> does NOT satisfy a
    /// bound of <c>IDep[A]</c>, even though both project to the identical
    /// erased <c>IDep&lt;object&gt;</c>. A NON-generic bound has no arguments
    /// to disagree about and is answered by the declared-interface walk.
    /// </remarks>
    /// <param name="typeArgument">The same-compilation type argument.</param>
    /// <param name="boundArgument">The bound, as a symbol.</param>
    /// <param name="boundInterfaceClr">The bound's CLR interface type.</param>
    /// <param name="tp">Issue #4124: the constrained parameter, for a
    /// SELF-REFERENTIAL bound. <c>[T IComparable[T]]</c> carries the
    /// constrained parameter as its own argument, so the expected vector is
    /// <c>[T]</c> and a <c>class Cmp : IComparable[Cmp]</c> would never match
    /// it symbolically. The reflective half already substitutes the argument
    /// for <c>tp</c> (<c>GenericConstraintArgumentsMatch</c>); this does the
    /// same so the two halves answer the same question. <see langword="null"/>
    /// from a caller that has no such symbol.</param>
    /// <returns><see langword="true"/> when the symbol implements the bound.</returns>
    private static bool SourceSymbolImplementsImportedInterface(
        TypeSymbol typeArgument,
        TypeSymbol boundArgument,
        Type boundInterfaceClr,
        TypeParameterSymbol? tp)
    {
        Type openDefinition;
        try
        {
            openDefinition = boundInterfaceClr.IsGenericType
                ? boundInterfaceClr.GetGenericTypeDefinition()
                : boundInterfaceClr;
        }
        catch (Exception)
        {
            return false;
        }

        var expected = boundArgument is ImportedTypeSymbol importedBound
            ? importedBound.TypeArguments
            : ImmutableArray<TypeSymbol>.Empty;

        foreach (var implemented in EnumerateDeclaredClrInterfaces(typeArgument))
        {
            // A NON-generic bound has no arguments to disagree about, so
            // reaching the interface at all is the whole answer — and reaching
            // it includes reaching it through a derived one (`IList` gives
            // `IEnumerable`). This is the `class D : IDisposable` case.
            if (expected.IsDefaultOrEmpty)
            {
                if (implemented.ClrType is { } implementedClr
                    && ClrTypeUtilities.IsAssignableByName(boundInterfaceClr, implementedClr))
                {
                    return true;
                }

                continue;
            }

            // A GENERIC bound is decided on the SYMBOLIC arguments, so
            // `class Impl : IDep[Bee]` does not satisfy a bound of `IDep[A]`
            // even though both project to the identical erased
            // `IDep<object>` — the same distinction the imported-definition
            // half of this repair makes.
            if (implemented is not ImportedTypeSymbol importedInterface
                || importedInterface.OpenDefinition is not { } implementedOpen
                || !string.Equals(
                    implementedOpen.FullName ?? implementedOpen.Name,
                    openDefinition.FullName ?? openDefinition.Name,
                    StringComparison.Ordinal))
            {
                continue;
            }

            var actual = importedInterface.TypeArguments;
            if (actual.IsDefaultOrEmpty || actual.Length != expected.Length)
            {
                continue;
            }

            var allMatch = true;
            for (var i = 0; i < expected.Length; i++)
            {
                // Issue #4124: a self-referential position names the
                // constrained parameter itself, and the argument is what it
                // stands for here — the same substitution the reflective half
                // performs.
                var expectedArgument = SubstituteSelfReference(expected[i], tp, typeArgument);
                if (!TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(actual[i], expectedArgument))
                {
                    allMatch = false;
                    break;
                }
            }

            if (allMatch)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Review finding (#4068): the imported CLR interfaces a same-compilation
    /// symbol declares — directly, through its base chain, and through the
    /// G#-declared interfaces it implements. Each is a CLOSED symbolic
    /// construction, so its type arguments still tell two same-compilation
    /// classes apart after the CLR projection has collapsed both to
    /// <c>object</c>.
    /// </summary>
    /// <param name="symbol">The same-compilation symbol.</param>
    /// <returns>The CLR interface symbols it declares.</returns>
    private static IEnumerable<TypeSymbol> EnumerateDeclaredClrInterfaces(TypeSymbol symbol)
    {
        if (symbol is StructSymbol aggregate)
        {
            foreach (var current in aggregate.GetHierarchy())
            {
                foreach (var implemented in current.ImplementedClrInterfaces)
                {
                    if (implemented != null)
                    {
                        yield return implemented;
                    }
                }

                foreach (var userInterface in current.Interfaces)
                {
                    foreach (var projection in EnumerateInterfaceClrBases(userInterface))
                    {
                        yield return projection;
                    }
                }

                // Issue #4067 (review): a source class INHERITS every interface
                // its IMPORTED base carries, and that base is held in its own
                // slot rather than in `BaseClass` — so `class Sub : ArrayList`
                // reached this walk with an empty interface list and
                // `class Fwd[T Sub] : GsEnumerable[T]` was rejected for not
                // carrying `IEnumerable`, which `ArrayList` plainly does.
                // Measured on the reviewed commit.
                //
                // The base itself is yielded rather than its interface list:
                // the NON-GENERIC arm below answers with
                // `IsAssignableByName(bound, ArrayList)`, which already walks
                // the CLR closure. The GENERIC arm skips it, because an
                // imported base is never a construction of the interface being
                // sought and its arguments are CLR-level rather than symbolic —
                // a same-compilation class reaching a GENERIC bound through an
                // imported base is therefore still not answered here.
                if (current.ImportedBaseType is { ClrType: not null } importedBase)
                {
                    yield return importedBase;
                }
            }
        }

        if (symbol is InterfaceSymbol declaredInterface)
        {
            foreach (var projection in EnumerateInterfaceClrBases(declaredInterface))
            {
                yield return projection;
            }
        }
    }

    /// <summary>
    /// Review finding (#4068): the imported interfaces a G#-declared interface
    /// and its base interfaces extend.
    /// </summary>
    /// <param name="userInterface">The declared interface.</param>
    /// <returns>The imported constructions it carries.</returns>
    private static IEnumerable<TypeSymbol> EnumerateInterfaceClrBases(InterfaceSymbol? userInterface)
    {
        if (userInterface == null)
        {
            yield break;
        }

        foreach (var candidate in userInterface.SelfAndAllBaseInterfaces())
        {
            foreach (var importedBase in candidate.BaseClrInterfaces)
            {
                if (importedBase != null)
                {
                    yield return importedBase;
                }
            }
        }
    }

    /// <summary>
    /// Issue #1056: returns <see langword="true"/> when <paramref name="typeArgument"/>
    /// satisfies a base-class constraint <paramref name="classConstraint"/> — it
    /// is the constraint class itself (by definition identity, so a constructed
    /// instantiation of the same generic class counts) or transitively derives
    /// from it. A constraining type parameter whose own class or dependent
    /// constraint already derives from the target is accepted (constraint
    /// propagation). For an imported reference class the CLR assignability
    /// relation is used.
    /// </summary>
    /// <param name="typeArgument">The candidate type argument.</param>
    /// <param name="classConstraint">The required base class.</param>
    /// <returns><see langword="true"/> when the argument is or derives from the constraint class.</returns>
    internal static bool SatisfiesClassConstraint(TypeSymbol typeArgument, TypeSymbol classConstraint)
    {
        if (typeArgument is null || classConstraint is null)
        {
            return false;
        }

        // Constraint propagation: follow both ordinary class constraints and
        // #4043's separate dependent-bound slot. Reference-identity tracking
        // protects against malformed cycles without limiting valid chain depth.
        if (typeArgument is TypeParameterSymbol)
        {
            var visited = new HashSet<TypeParameterSymbol>(ReferenceEqualityComparer.Instance);
            while (typeArgument is TypeParameterSymbol tpArg)
            {
                if (!visited.Add(tpArg))
                {
                    return false;
                }

                var next = tpArg.ClassConstraint ?? tpArg.TypeParameterBound;
                if (next == null)
                {
                    return false;
                }

                typeArgument = next;
            }
        }

        if (classConstraint is StructSymbol classDef)
        {
            var constraintDef = classDef.Definition ?? classDef;
            if (typeArgument is StructSymbol argClass)
            {
                foreach (var current in argClass.GetHierarchy())
                {
                    var currentDef = current.Definition ?? current;
                    if (ReferenceEquals(currentDef, constraintDef) || ReferenceEquals(current, classConstraint))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        // Imported reference class: use CLR assignability when both project to a
        // CLR type.
        if (classConstraint.ClrType is { } constraintClr)
        {
            if (typeArgument.ClrType is { } argClr)
            {
                // Issue #3705 (family 3): the constraint comes from imported
                // metadata (MetadataLoadContext) while the argument may be a
                // well-known TypeSymbol singleton wrapping a host `typeof(T)`.
                // Raw IsAssignableFrom is silently false across that boundary.
                return ClrLoadContext.IsAssignable(constraintClr, argClr);
            }

            // Issue #3501: a SOURCE class deriving (possibly through source
            // bases) from an imported CLR base has no ClrType of its own —
            // walk the source base chain to the first ImportedBaseType and
            // check CLR assignability there (`class Derived : ImportedBase`
            // must satisfy `[T ImportedBase]`).
            if (typeArgument is StructSymbol sourceClass)
            {
                foreach (var current in sourceClass.GetHierarchy())
                {
                    if (current.ImportedBaseType?.ClrType is { } importedBaseClr
                        && ClrLoadContext.IsAssignable(constraintClr, importedBaseClr))
                    {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0097: returns <see langword="true"/> when <paramref name="type"/>
    /// satisfies a <c>where T : class</c> constraint — i.e. it is a reference
    /// type at the CLR level. Includes G# interfaces and reference-shaped
    /// classes, plus the special case of another type parameter that itself
    /// carries the <c>class</c> bit (constraint propagation).
    /// </summary>
    /// <param name="type">The candidate type argument.</param>
    /// <returns><see langword="true"/> when the type satisfies <c>class</c>.</returns>
    internal static bool IsReferenceTypeForConstraint(TypeSymbol type)
    {
        if (type is null)
        {
            return false;
        }

        if (type is NullableTypeSymbol)
        {
            // T? is the nullable-annotated form of an underlying reference
            // type; the constraint check fires on the *unannotated* T.
            return false;
        }

        if (type is TypeParameterSymbol tp)
        {
            // A class-base constraint proves the parameter is reference-shaped
            // just as strongly as the explicit `class` flag.
            return tp.HasReferenceTypeConstraint || tp.ClassConstraint != null;
        }

        if (type is StructSymbol structSym)
        {
            return structSym.IsClass;
        }

        if (type is InterfaceSymbol || type is FunctionTypeSymbol || type is DelegateTypeSymbol
            || type is ArrayTypeSymbol || type is SliceTypeSymbol || type is RectangularArrayTypeSymbol || type is MapTypeSymbol
            || type is ChannelTypeSymbol || type is SequenceTypeSymbol || type is AsyncSequenceTypeSymbol)
        {
            return true;
        }

        if (type == TypeSymbol.String || type == TypeSymbol.Object)
        {
            return true;
        }

        var importedType = type as ImportedTypeSymbol;
        if (importedType != null)
        {
            var clr = importedType.ClrType;
            if (clr != null)
            {
                return !clr.IsValueType;
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0097: returns <see langword="true"/> when <paramref name="type"/>
    /// satisfies a <c>where T : struct</c> constraint — i.e. it is a
    /// non-nullable value type at the CLR level.
    /// </summary>
    /// <param name="type">The candidate type argument.</param>
    /// <returns><see langword="true"/> when the type satisfies <c>struct</c>.</returns>
    internal static bool IsNonNullableValueTypeForConstraint(TypeSymbol type)
    {
        if (type is null || type is NullableTypeSymbol)
        {
            return false;
        }

        if (type is TypeParameterSymbol tp)
        {
            return tp.HasValueTypeConstraint;
        }

        if (type is StructSymbol structSym)
        {
            return !structSym.IsClass;
        }

        // Issue #4139: a SAME-COMPILATION enum is a non-nullable value type and
        // always satisfies `struct` — ECMA-335 II.14.3, and `csc` agrees. It
        // has no CLR type while binding, so without this arm it fell through to
        // the reflective probe below and was reported as a violation on a legal
        // program (`interface ISource[T struct]` implemented over a source
        // `enum Color`). The IMPORTED spelling has always worked, through the
        // probe; this is the same answer one substrate over, and it is the same
        // shape as #4136 in the sibling interface arm.
        if (type is EnumSymbol)
        {
            return true;
        }

        if (type.ClrType is { } primitiveClr)
        {
            return primitiveClr.IsValueType && !NullableLifting.IsValueTypeNullableClr(primitiveClr);
        }

        return false;
    }

    /// <summary>
    /// Issue #1336: returns <see langword="true"/> when <paramref name="type"/>
    /// satisfies a <c>where T : unmanaged</c> constraint — it is an unmanaged
    /// (blittable, GC-free) type. Blittable primitives, enums, pointers and
    /// non-nullable value structs whose fields are recursively unmanaged
    /// qualify, as does another type parameter constrained <c>unmanaged</c>.
    /// Managed reference types, nullable value types, and structs containing a
    /// managed field do not. Mirrors C#'s unmanaged-type rule (ECMA-335 /
    /// ADR-0093 blittability).
    /// </summary>
    /// <param name="type">The candidate type argument.</param>
    /// <returns><see langword="true"/> when the type is unmanaged.</returns>
    internal static bool IsUnmanagedTypeForConstraint(TypeSymbol type)
    {
        if (type is null || type is NullableTypeSymbol)
        {
            return false;
        }

        if (type is TypeParameterSymbol tp)
        {
            return tp.HasUnmanagedConstraint;
        }

        return new BlittableDetector().IsUnmanaged(type);
    }

    /// <summary>
    /// ADR-0097: returns <see langword="true"/> when <paramref name="type"/>
    /// satisfies a <c>where T : new()</c> constraint. Value types satisfy it
    /// implicitly; reference types must expose a public parameterless
    /// constructor.
    /// </summary>
    /// <param name="type">The candidate type argument.</param>
    /// <returns><see langword="true"/> when the type satisfies <c>new()</c>.</returns>
    internal static bool HasDefaultConstructorForConstraint(TypeSymbol type)
    {
        if (type is null)
        {
            return false;
        }

        if (IsNonNullableValueTypeForConstraint(type))
        {
            return true;
        }

        if (type is TypeParameterSymbol tp)
        {
            return tp.HasDefaultConstructorConstraint || tp.HasValueTypeConstraint;
        }

        if (type is StructSymbol structSym)
        {
            // G# structs are value types (already handled above); G# classes
            // expose a public parameterless ctor unless the user provided
            // one with parameters. Iterate explicit ctors; if any has zero
            // parameters, the constraint is satisfied; if the class has no
            // explicit ctors at all, the synthesized one is public.
            if (!structSym.IsClass)
            {
                return true;
            }

            if (structSym.ExplicitConstructors.IsDefaultOrEmpty)
            {
                return !structSym.HasPrimaryConstructor || structSym.PrimaryConstructorParameters.Length == 0;
            }

            foreach (var ctor in structSym.ExplicitConstructors)
            {
                if (ctor.Parameters.Length == 0)
                {
                    return true;
                }
            }

            return false;
        }

        if (type is ImportedTypeSymbol it && it.ClrType is { } clr)
        {
            if (clr.IsValueType)
            {
                return true;
            }

            try
            {
                var ctor = clr.GetConstructor(System.Type.EmptyTypes);
                return ctor != null && ctor.IsPublic;
            }
            catch
            {
                return true;
            }
        }

        return false;
    }

    internal static bool ImplementsInterface(TypeSymbol typeArgument, InterfaceSymbol iface)
    {
        // Issue #1113: an interface constraint is satisfied when the type
        // argument implements the interface ANYWHERE in its hierarchy — directly,
        // through a base class, or via a transitively-inherited base interface
        // (mirrors C#'s `where T : IFace`). Walk the full base-class chain and,
        // for every interface encountered, its transitive base-interface closure.
        if (typeArgument is StructSymbol s)
        {
            foreach (var current in s.GetHierarchy())
            {
                foreach (var implemented in current.Interfaces)
                {
                    if (implemented == null)
                    {
                        continue;
                    }

                    foreach (var candidate in implemented.SelfAndAllBaseInterfaces())
                    {
                        if (candidate == iface || SameConstructedInterface(candidate, iface))
                        {
                            return true;
                        }
                    }
                }
            }
        }

        if (typeArgument is InterfaceSymbol i)
        {
            // An interface type argument satisfies the constraint when it is the
            // constraint interface or transitively extends it.
            foreach (var candidate in i.SelfAndAllBaseInterfaces())
            {
                if (candidate == iface || SameConstructedInterface(candidate, iface))
                {
                    return true;
                }
            }
        }

        if (typeArgument is TypeParameterSymbol tp && tp.InterfaceConstraint != null)
        {
            // Constraint propagation: a type parameter whose own interface
            // constraint is or extends the target satisfies the bound.
            foreach (var candidate in tp.InterfaceConstraint.SelfAndAllBaseInterfaces())
            {
                if (candidate == iface || SameConstructedInterface(candidate, iface))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1052: structural equality for two constructed generic
    /// <see cref="InterfaceSymbol"/> instances — same generic definition and
    /// element-wise equal type arguments. The constructed-interface cache
    /// usually makes reference equality sufficient, but symbols produced via
    /// independent construction paths (e.g. a struct's declared interface vs a
    /// self-substituted constraint) can differ by identity while denoting the
    /// same closed type.
    /// </summary>
    private static bool SameConstructedInterface(InterfaceSymbol a, InterfaceSymbol b)
    {
        if (a == null || b == null)
        {
            return false;
        }

        var defA = a.Definition ?? a;
        var defB = b.Definition ?? b;
        if (!ReferenceEquals(defA, defB))
        {
            return false;
        }

        if (a.TypeArguments.IsDefaultOrEmpty || b.TypeArguments.IsDefaultOrEmpty
            || a.TypeArguments.Length != b.TypeArguments.Length)
        {
            return false;
        }

        for (var k = 0; k < a.TypeArguments.Length; k++)
        {
            var ta = a.TypeArguments[k];
            var tb = b.TypeArguments[k];
            if (ta == tb || ReferenceEquals(ta, tb))
            {
                continue;
            }

            if (ta is InterfaceSymbol ia && tb is InterfaceSymbol ib && SameConstructedInterface(ia, ib))
            {
                continue;
            }

            return false;
        }

        return true;
    }

    /// <summary>
    /// Issue #943: returns <see langword="true"/> when <paramref name="typeArgument"/>
    /// satisfies a CLR interface constraint <paramref name="constraint"/> (e.g.
    /// <c>IComparable[T]</c>). For a self-referential generic constraint the
    /// constrained parameter <paramref name="tp"/> is substituted by the type
    /// argument itself, so <c>[T IComparable[T]]</c> checks that the argument
    /// implements <c>IComparable&lt;argument&gt;</c>. Matching is performed by
    /// metadata full name to avoid mixing reflection load contexts.
    /// </summary>
    /// <param name="typeArgument">The supplied type argument.</param>
    /// <param name="constraint">The CLR interface constraint type.</param>
    /// <param name="tp">The constrained type parameter (for self-substitution).</param>
    /// <returns><see langword="true"/> when the constraint is satisfied.</returns>
    /// <remarks>
    /// Issue #4124: the reflective answer below is the WHOLE answer only for a
    /// type argument that HAS a CLR type. A same-compilation class has none
    /// while binding, so <c>class D : IDisposable</c> was reported as failing
    /// <c>[T IDisposable]</c> — a false rejection of ordinary code. The symbol
    /// knows its own interface list, so the wrapper asks it when reflection
    /// cannot. See <see cref="SourceSymbolImplementsImportedInterface"/> for
    /// the walk and the type-safety of its generic arm.
    /// </remarks>
    internal static bool SatisfiesClrInterfaceConstraint(TypeSymbol typeArgument, TypeSymbol constraint, TypeParameterSymbol? tp)
    {
        if (SatisfiesClrInterfaceConstraintReflectively(typeArgument, constraint, tp))
        {
            return true;
        }

        // Issue #4124: the SAME blindness #4061, #4068 and #4092 each repaired
        // at the site that happened to hit it. Consolidated here, at the leaf
        // all three of the symbolic askers bottom out in, so a fifth site
        // cannot appear. Only consulted when the argument has NO CLR type,
        // which is exactly the case the reflective walk cannot see, so nothing
        // that walk already answers changes.
        return typeArgument is { ClrType: null }
            && constraint.ClrType is { IsInterface: true } constraintInterfaceClr
            && SourceSymbolImplementsImportedInterface(typeArgument, constraint, constraintInterfaceClr, tp);
    }

    /// <summary>
    /// The reflective half of <see cref="SatisfiesClrInterfaceConstraint"/>:
    /// the answer <c>typeArgument.ClrType.GetInterfaces()</c> gives. Split out
    /// by issue #4124 so the symbolic fallback wraps EVERY exit of it rather
    /// than being bolted onto one caller at a time.
    /// </summary>
    /// <param name="typeArgument">The supplied type argument.</param>
    /// <param name="constraint">The CLR interface constraint type.</param>
    /// <param name="tp">The constrained type parameter (for self-substitution).</param>
    /// <returns><see langword="true"/> when reflection proves the constraint.</returns>
    private static bool SatisfiesClrInterfaceConstraintReflectively(
        TypeSymbol typeArgument,
        TypeSymbol constraint,
        TypeParameterSymbol? tp)
    {
        // Constraint propagation: another type parameter constrained to the same
        // interface trivially satisfies the constraint.
        if (typeArgument is TypeParameterSymbol argTp)
        {
            return argTp.ClrInterfaceConstraint != null
                && string.Equals(
                    argTp.ClrInterfaceConstraint.ClrType?.FullName,
                    constraint.ClrType?.FullName,
                    StringComparison.Ordinal);
        }

        var typeArgClr = typeArgument?.ClrType;
        var constraintClr = constraint?.ClrType;
        if (typeArgClr == null || constraintClr == null)
        {
            return false;
        }

        if (!constraintClr.IsGenericType)
        {
            // Non-generic interface constraint (e.g. `[T IDisposable]`).
            if (string.Equals(typeArgClr.FullName, constraintClr.FullName, StringComparison.Ordinal))
            {
                return true;
            }

            foreach (var interfaceType in typeArgClr.GetInterfaces())
            {
                if (string.Equals(interfaceType.FullName, constraintClr.FullName, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        var openDefName = constraintClr.GetGenericTypeDefinition().FullName;

        // constraint is this method's own non-nullable parameter (the
        // `constraint?.ClrType` read above is a redundant null-conditional,
        // not a narrowing of constraint).
        var constraintArgs = MemberLookup.GetImportedTypeSymbol(constraint!)?.TypeArguments
            ?? ImmutableArray<TypeSymbol>.Empty;
        var constraintClrArgs = constraintClr.GetGenericArguments();

        foreach (var candidate in EnumerateSelfAndInterfaces(typeArgClr))
        {
            if (!candidate.IsGenericType
                || !string.Equals(candidate.GetGenericTypeDefinition().FullName, openDefName, StringComparison.Ordinal))
            {
                continue;
            }

            if (GenericConstraintArgumentsMatch(
                candidate.GetGenericArguments(),
                constraintArgs,
                constraintClrArgs,
                tp,
                typeArgument,
                typeArgClr))
            {
                return true;
            }
        }

        return false;
    }

    private static IEnumerable<Type> EnumerateSelfAndInterfaces(Type type)
    {
        if (type.IsInterface)
        {
            yield return type;
        }

        foreach (var interfaceType in type.GetInterfaces())
        {
            yield return interfaceType;
        }
    }

    private static bool GenericConstraintArgumentsMatch(
        Type[] candidateArgs,
        ImmutableArray<TypeSymbol> constraintArgs,
        Type[] constraintClrArgs,
        TypeParameterSymbol? tp,
        TypeSymbol? typeArgument,
        Type typeArgClr)
    {
        var expectedCount = !constraintArgs.IsDefaultOrEmpty
            ? constraintArgs.Length
            : constraintClrArgs.Length;
        if (expectedCount == 0 || candidateArgs.Length != expectedCount)
        {
            return false;
        }

        for (var i = 0; i < candidateArgs.Length; i++)
        {
            // A self-referential constraint argument (the constrained parameter
            // itself) is expected to be the type argument; any other argument is
            // matched against its own resolved CLR type.
            //
            // Review finding (#4124): the self-reference may be NESTED —
            // `[T IComparable[List[T]]]` — so the substitution is recursive
            // rather than a whole-argument identity test. Measured before this
            // change: `class C : IComparable[List[C]]` was refused with
            // `GS0152` on both halves of this predicate, while the flat
            // `[T IComparable[T]]` bound. `SubstituteSelfReference` is the SAME
            // helper the symbolic half calls, so the two halves keep answering
            // the same question.
            var expectedName = !constraintArgs.IsDefaultOrEmpty
                ? (constraintArgs[i] is TypeParameterSymbol cArgTp && ReferenceEquals(cArgTp, tp)
                    ? typeArgClr.FullName
                    : SubstituteSelfReference(constraintArgs[i], tp, typeArgument).ClrType?.FullName)
                : constraintClrArgs[i].FullName;

            if (expectedName == null
                || !string.Equals(candidateArgs[i].FullName, expectedName, StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Review finding (#4124): replaces every occurrence of the constrained
    /// parameter <paramref name="tp"/> inside <paramref name="expected"/> with
    /// the type argument it stands for, at ANY depth.
    /// </summary>
    /// <remarks>
    /// <para>The flat shape <c>[T IComparable[T]]</c> was closed by comparing
    /// the whole argument against <paramref name="tp"/>. That misses the
    /// NESTED shape <c>[T IComparable[List[T]]]</c>, where the argument is
    /// <c>List[T]</c> and never equals <paramref name="tp"/> — so
    /// <c>class C : IComparable[List[C]]</c> was refused with <c>GS0152</c>,
    /// the same false-rejection class #4124 is about, one level down.
    /// Measured red on this branch's parent <c>b4478875</c> AND on both halves
    /// of this predicate before this change.</para>
    /// <para>Both halves call this, deliberately: the reflective half compares
    /// CLR full names and the symbolic half compares symbols, but they must
    /// agree on WHAT the expected argument is, or a type answers one way with
    /// a CLR type and the other way without. On any failure to construct the
    /// substituted type — a cross-reflection-context
    /// <c>MakeGenericType</c> is the realistic one — the pre-existing
    /// unsubstituted argument is returned, which is exactly the behaviour
    /// before this change.</para>
    /// </remarks>
    /// <param name="expected">The constraint's declared type argument.</param>
    /// <param name="tp">The constrained parameter, or <see langword="null"/>.</param>
    /// <param name="typeArgument">The argument it stands for, or <see langword="null"/>.</param>
    /// <returns>The argument with the self-reference substituted.</returns>
    private static TypeSymbol SubstituteSelfReference(
        TypeSymbol expected,
        TypeParameterSymbol? tp,
        TypeSymbol? typeArgument)
    {
        if (tp == null || typeArgument == null || !TypeSymbol.ContainsTypeParameter(expected))
        {
            return expected;
        }

        if (ReferenceEquals(expected, tp))
        {
            return typeArgument;
        }

        try
        {
            return SubstituteType(
                expected,
                new Dictionary<TypeParameterSymbol, TypeSymbol> { [tp] = typeArgument });
        }
        catch (Exception)
        {
            return expected;
        }
    }

    internal static bool IsComparable(TypeSymbol type)
    {
        if (type == TypeSymbol.Int32 || type == TypeSymbol.String || type == TypeSymbol.Bool)
        {
            return true;
        }

        if (type is NullableTypeSymbol n)
        {
            return IsComparable(n.UnderlyingType);
        }

        if (type is StructSymbol s && s.IsData)
        {
            return true;
        }

        if (type is TypeParameterSymbol tp)
        {
            return tp.Constraint == TypeParameterConstraint.Comparable;
        }

        return false;
    }

    internal static string DescribeConstraint(TypeParameterSymbol tp)
    {
        // ADR-0097 / issue #775: include the flag-style constraints in the
        // human-readable description so diagnostics are unambiguous.
        var flags = new System.Collections.Generic.List<string>();
        if (tp.InterfaceConstraint != null)
        {
            flags.Add(SymbolDisplay.ToTypeDisplayString(tp.InterfaceConstraint));
        }

        if (tp.ClrInterfaceConstraint != null)
        {
            flags.Add(SymbolDisplay.ToTypeDisplayString(tp.ClrInterfaceConstraint));
        }

        if (tp.ClassConstraint != null)
        {
            flags.Add(SymbolDisplay.ToTypeDisplayString(tp.ClassConstraint));
        }

        // Issue #4043: a dependent bound reads as the NAME of the bounding type
        // parameter — `TBase`, not whatever it happened to be substituted with
        // at this call. That is what the author wrote and what C# names in
        // CS0311, and it stays stable across call sites.
        if (tp.TypeParameterBound != null)
        {
            flags.Add(tp.TypeParameterBound.Name);
        }

        if (tp.Constraint == TypeParameterConstraint.Comparable)
        {
            flags.Add("comparable");
        }

        if (tp.HasReferenceTypeConstraint)
        {
            flags.Add("class");
        }

        if (tp.HasValueTypeConstraint && !tp.HasUnmanagedConstraint)
        {
            flags.Add("struct");
        }

        if (tp.HasUnmanagedConstraint)
        {
            flags.Add("unmanaged");
        }

        if (tp.HasDefaultConstructorConstraint && !tp.HasValueTypeConstraint)
        {
            flags.Add("new()");
        }

        if (flags.Count == 0)
        {
            return "any";
        }

        return string.Join(" ", flags);
    }

    // Issue #507 follow-up: shared core for binding a `?.<rhs>` access against
    // an already-bound receiver expression. Used by BindNullConditionalAccessExpression
    // (when the receiver is the left side of the outermost accessor) and by the
    // BindAccessorStep nested-accessor case (when a `?.` accessor appears as the
    // right side of an outer `.` chain — e.g. `o.InnerObj?.Map`, which
    // ParseNameOrCallExpression folds into `AccessorExpression(o, ., AccessorExpression(InnerObj, ?., Map))`).

    // Issue #507 follow-up: the read-side counterpart to BindIndexedAssignmentToVariable.
    // Routes a bound target + index syntax through map / array / CLR-indexer
    // resolution and returns the bound index read. Extracted from
    // BindIndexExpression so the BindAccessorStep arm that handles
    // `receiver.Member[k]` (where the parser folds `[...]` into the right side
    // of the trailing `.`) can produce the same bound shape without re-running
    // the accessor chain.

    // Issue #507: indexer assignment whose target is an arbitrary expression
    // (e.g. `obj.Member[k] = v`). The parser produces this node for any LHS
    // shape that parses as an IndexExpression and is followed by `=`. We
    // mirror the user-visible workaround (bind the indexed property to a
    // local first) by synthesizing a temp local that holds the bound target
    // value, then routing the indexer assignment through that temp via the
    // existing variable-rooted path. This reuses every downstream code path
    // (lowering, async spilling, side-effect spilling, evaluation, IL emit)
    // without modification.
    //
    // Follow-up: also handles null-conditional receiver chains
    // (`obj.A?.B[k] = v`). The receiver chain is split at the leftmost `?.`;
    // the left part is captured into a synthetic null-check local and the
    // write is wrapped in a `BoundNullConditionalAccessExpression` so the
    // assignment no-ops when an intermediate is `nil`.

    // Issue #507 follow-up: compound indexer assignment via member chain
    // (`obj.Map[k] += v`, `d[k] -= 1`, ...). Shares the same chain-walking
    // machinery as the plain `=` form so the receiver is evaluated exactly
    // once. The synthesized binary expression (`tmp[k] op v`) is built inside
    // BindIndexedWriteThroughChain after the receiver temp is established.

    // Issue #507 follow-up: shared driver for indexer assignment through a
    // member chain. Handles three orthogonal axes:
    //   * `chainBase` is non-null when recursing past a `?.` capture; the
    //     remainingChain is then bound against the capture via BindAccessorStep
    //     rather than a fresh BindExpression on the syntax tree.
    //   * `compoundOperatorToken` is non-null for `op=` forms; the helper then
    //     synthesizes the `tmp[k] op rhs` binary expression after the receiver
    //     temp is established.
    //   * `boundValueOverride` is non-null when the caller already bound the
    //     RHS (currently unused at top-level, kept for symmetry/future reuse).
    //
    // Null-conditional behaviour: if the chain contains a `?.`, the leftmost
    // occurrence splits the chain. The left side is captured into a synthetic
    // local; the right side (plus the indexer write) becomes the whenNotNull
    // body of a `BoundNullConditionalAccessExpression`. Nested `?.` is handled
    // by recursive splitting.
    //
    // Receiver evaluation: the chain receiver is evaluated exactly once. The
    // index expression is bound twice for compound assignment (once for the
    // read, once for the write) because both target the same syntax node;
    // callers passing side-effecting index expressions should pre-bind them
    // to a local. This matches the precedent set by the local compound
    // assignment desugar (`x += 1` lowers to `x = x + 1` and double-evaluates
    // `x` syntactically).

    // Issue #507 follow-up: walks a left-recursive accessor chain to find the
    // leftmost `?.` in source order. When found, splits the chain into the
    // sub-expression LEFT of the `?.` (which is captured for null-checking)
    // and the sub-expression to its RIGHT (which is bound against the
    // capture). Returns false when the chain contains no `?.` at all.

    // Issue #507 follow-up: compound assignment (`tmp[k] += v`) supplies a
    // pre-bound RHS (the synthesized `tmp[k] op v` binary expression) so the
    // shared body must skip re-binding the value syntax and just convert the
    // bound value to the element type. Carries `diagnosticLocation` for the
    // conversion error site, matching the caller's user-visible operator.

    // #313: for an erased generic indexed in a generic body (e.g. `items[0]`
    // where `items: List[T]`), the closed CLR indexer reports its element type
    // as `object` because the symbol is erased to `List<object>`. Recover the
    // symbolic element type by resolving the indexer on the open definition: if
    // its property type is a generic parameter, map it back to the matching
    // symbolic argument so the result binds as `T` rather than `object`.

    // ADR-0056 §1: map a CLR member's return/field type to a `TypeSymbol`,
    // surfacing a `T&` return as a `ByRefTypeSymbol` over the pointee so that
    // `AutoDereferenceRefReturn` can apply the §1 rule generally to ref-returning
    // methods and properties (not just the span indexer).

    // ADR-0056 §2: a `ref readonly T` return (e.g. `ReadOnlySpan[T].get_Item`)
    // carries a required custom modifier `System.Runtime.InteropServices.InAttribute`
    // on the indexer property / getter return, whereas a `ref T` return
    // (`Span[T].get_Item`) carries none. This distinguishes a writable span
    // element from a read-only one.

    // Issue #324: build a method-group expression for a bare identifier that
    // names a free (package-level) function. Returns false for anything that
    // cannot be materialized as a simple `ldftn` over a static method def:
    // instance methods, generics, variadics, and class statics are excluded.

    /// <summary>
    /// Issue #530: returns the CLR type to use when <paramref name="typeSymbol"/>
    /// appears as a generic type argument (e.g. <c>Task[int32?]</c> or
    /// <c>FromResult[string?]</c>). For a <see cref="NullableTypeSymbol"/>
    /// wrapping a value type the result is <c>Nullable&lt;T&gt;</c>; for a
    /// nullable reference type the result is the underlying reference type
    /// (since CLR has no separate <c>string?</c> type).
    /// </summary>
    /// <param name="typeSymbol">The type symbol to resolve.</param>
    /// <returns>
    /// The CLR type projected onto the reference load context, or <c>null</c>
    /// when the symbol has no CLR type.
    /// </returns>
    private Type? ResolveClrTypeForGenericArg(TypeSymbol typeSymbol)
        => NullableLifting.ResolveClrTypeForGenericArg(this.scope.References, typeSymbol);

    /// <summary>
    /// Resolves a CLR type used in a type clause to its semantic aggregate when
    /// it is an imported data class/data struct. This keeps simple, qualified,
    /// nested, and closed-generic spellings on the same symbol identity.
    /// </summary>
    /// <param name="type">The resolved CLR type.</param>
    /// <returns>The semantic aggregate when <paramref name="type"/> is a marked data type; otherwise the ordinary imported-type projection.</returns>
    private TypeSymbol ResolveClrTypeClauseSymbol(Type type)
    {
        return ImportedTypeSymbol.TryCreateSemanticAggregate(type, this.scope.References, out var aggregate)
            ? aggregate
            : TypeSymbol.FromClrType(type);
    }

    // Issue #337: build an (unresolved) CLR member method-group expression for a
    // member name that resolves to a method on an imported static type or a CLR
    // instance receiver. Collects every accessible name-matching overload of the
    // requested static-ness; overload selection happens later in BindConversion
    // once the target delegate signature is known. Returns false when the type
    // exposes no method of that name (so the caller surfaces the member
    // diagnostic).

    // ADR-0047 §6 / #175: if <paramref name="symbol"/> carries an
    // [Obsolete] attribute, surface a use-site diagnostic at
    // <paramref name="location"/>. Severity is Warning by default,
    // promoted to Error when the attribute's second positional
    // argument (IsError) is true.
    private void ReportObsoleteUseIfApplicable(TextLocation location, Symbol symbol, string displayName)
    {
        if (symbol == null)
        {
            return;
        }

        if (KnownAttributes.TryGetObsolete(symbol.Attributes, out var message, out var isError))
        {
            Diagnostics.ReportObsoleteUse(location, displayName, message, isError);
        }
    }

    private TypeSymbol? LookupType(string name)
        => LookupType(name, preferredArity: -1);

    private TypeSymbol? LookupType(string name, int preferredArity)
        => LookupType(name, preferredArity, out _);

    private TypeSymbol? LookupType(string name, int preferredArity, out bool ambiguousAcrossImportedPackages)
        => LookupType(name, preferredArity, out ambiguousAcrossImportedPackages, out _);

    /// <summary>
    /// Issue #2455: same as <see cref="LookupType(string, int)"/>, but also
    /// reports (via <paramref name="ambiguousAcrossImportedPackages"/>) when
    /// the bare simple name collides between two or more different top-level
    /// packages that are EACH visible via a compilation-wide <c>import</c>
    /// (see <see cref="BoundScope.TryLookupTypeAlias(string, int, out TypeSymbol, out bool)"/>).
    /// Used by the bare-name branch of <see cref="BindNonNullableTypeClause"/>
    /// so it can surface a dedicated ambiguity diagnostic (GS0496) instead of
    /// the generic "cannot find type" (GS0157) that a null result otherwise
    /// produces.
    /// </summary>
    /// <param name="name">The simple type name.</param>
    /// <param name="preferredArity">The preferred generic arity, or -1 for none.</param>
    /// <param name="ambiguousAcrossImportedPackages">Whether the miss was specifically a cross-package import ambiguity.</param>
    /// <param name="importedTypeAmbiguity">Issue #3734: the colliding imported CLR candidates when the name resolved first-import-wins between two different imported types.</param>
    /// <returns>The resolved type, or <c>null</c> when unresolved or ambiguous.</returns>
    private TypeSymbol? LookupType(
        string name,
        int preferredArity,
        out bool ambiguousAcrossImportedPackages,
        out ImportedTypeAmbiguity? importedTypeAmbiguity)
    {
        ambiguousAcrossImportedPackages = false;
        importedTypeAmbiguity = null;

        // Issue #944: a parse-recovery artifact (e.g. a malformed type clause
        // with no identifier) can reach here with a null/empty name. Treat it
        // as unresolved and let the caller surface the ordinary GS0113
        // diagnostic, rather than indexing a name-keyed dictionary with a null
        // key (which threw ArgumentNullException → GS9998 ICE).
        if (string.IsNullOrEmpty(name))
        {
            return null;
        }

        // Phase 4.1 / ADR-0020: a generic function's type parameters shadow
        // outer type names while we are binding its signature and body.
        if (binderCtx.CurrentTypeParameters != null && binderCtx.CurrentTypeParameters.TryGetValue(name, out var tp))
        {
            return tp;
        }

        switch (name)
        {
            case "bool":
                return TypeSymbol.Bool;
            case "uint8":
            // ADR-0098 / issue #729: friendly numeric alias for `uint8`. Canonical
            // remains `uint8`; the alias resolves here and the bound tree records
            // the canonical TypeSymbol, so diagnostics, `typeof`, and `nameof`
            // continue to print the width-bearing name.
            case "byte":
                return TypeSymbol.UInt8;
            case "int8":
            case "sbyte":
                return TypeSymbol.Int8;
            case "int16":
            case "short":
                return TypeSymbol.Int16;
            case "uint16":
            case "ushort":
                return TypeSymbol.UInt16;
            case "int32":
            case "int":
                return TypeSymbol.Int32;
            case "uint32":
            case "uint":
                return TypeSymbol.UInt32;
            case "int64":
            case "long":
                return TypeSymbol.Int64;
            case "uint64":
            case "ulong":
                return TypeSymbol.UInt64;
            case "nint":
                return TypeSymbol.NInt;
            case "nuint":
                return TypeSymbol.NUInt;
            case "float32":
            case "float":
                return TypeSymbol.Float32;
            case "float64":
            case "double":
                return TypeSymbol.Float64;
            case "decimal":
                return TypeSymbol.Decimal;
            case "char":
                return TypeSymbol.Char;
            case "string":
                return TypeSymbol.String;
            case "object":
                return TypeSymbol.Object;
            case "void":
                // ADR-0075 / issue #715: `void` is a recognised type-clause
                // name so the arrow-form function type clause can spell its
                // void-returning shape `() -> void`. Downstream binder checks
                // reject `void` in positions where it is meaningless
                // (parameter types, variable types, generic arguments).
                return TypeSymbol.Void;
        }

        if (binderCtx.TryLookupSourceType(
                scope,
                name,
                preferredArity,
                function,
                out var aliased,
                out ambiguousAcrossImportedPackages))
        {
            // Issue #3466: nested source types may retain a bare lookup key so
            // their containing type can use the short name. Outside that
            // lexical scope, an explicit alias (including one targeting a
            // nested CLR type) or a same-named top-level import wins.
            if (scope.TryLookupImportedClassByArity(
                    name,
                    preferredArity,
                    declaration: null,
                    out var importedType,
                    out importedTypeAmbiguity)
                && binderCtx.ImportedTypeOverridesSourceType(
                    scope,
                    name,
                    aliased,
                    preferredArity,
                    function,
                    importedType.ClassType))
            {
                if (ImportedTypeSymbol.TryCreateSemanticAggregate(
                    importedType.ClassType,
                    scope.References,
                    out var importedAggregate))
                {
                    return importedAggregate;
                }

                return TypeSymbol.FromClrType(importedType.ClassType);
            }

            // Issue #3734: the source type won, so no imported candidate was
            // chosen and the cross-import collision is not what this reference
            // means.
            importedTypeAmbiguity = null;
            return aliased;
        }

        if (ambiguousAcrossImportedPackages)
        {
            // Issue #2455: a genuine cross-package collision where two or more
            // colliding packages are each imported. Do not fall through to the
            // CLR-imported-class / alias-import paths below — those cannot
            // possibly be what a colliding SOURCE type reference means — and
            // let the caller report the dedicated ambiguity diagnostic.
            return null;
        }

        // ADR-0156 Phase 2: a type declared by a prior interactive submission
        // resolves as an imported CLR type over that submission's emitted
        // assembly, newest submission first. Consulted after this
        // compilation's own source types (the current cell shadows history)
        // and before ordinary imports.
        if (scope.SubmissionImports is { } submissionImports
            && submissionImports.TryResolveType(scope.References, name, preferredArity, out var submissionClrType))
        {
            if (ImportedTypeSymbol.TryCreateSemanticAggregate(submissionClrType, scope.References, out var submissionAggregate))
            {
                return submissionAggregate;
            }

            return TypeSymbol.FromClrType(submissionClrType);
        }

        if (scope.TryLookupImportedClass(name, declaration: null, out var importedClass, out importedTypeAmbiguity))
        {
            if (ImportedTypeSymbol.TryCreateSemanticAggregate(importedClass.ClassType, scope.References, out var aggregate))
            {
                return aggregate;
            }

            return TypeSymbol.FromClrType(importedClass.ClassType);
        }

        // Issue #2273: `import R = Namespace.Type` names a TYPE outright (not a
        // namespace) — a C# `using R = Some.Type;` analog. Unlike a plain
        // `import Some.Namespace`, whose target is never itself a type, an
        // ALIAS's target is resolved directly as a type so `R` is usable
        // anywhere the aliased type's own name would be: here (type-clause
        // position, e.g. `var x R = ...`), and — via this same method — at
        // static-member/nested-type use sites that fall back to it. Handles
        // both an imported CLR type (`import R = System.Math` then `R.PI`) and
        // a same-compilation SOURCE type declared in another package (the
        // conventional resx `import R = ...Properties.Resources` pattern),
        // generalized to any namespace depth.
        if (scope.TryLookupImport(name, out var aliasImport) && aliasImport.IsAlias)
        {
            var aliasTarget = aliasImport.Target;

            if (scope.References.TryResolveType(aliasTarget, out var clrAliasType))
            {
                if (ImportedTypeSymbol.TryCreateSemanticAggregate(clrAliasType, scope.References, out var clrAggregate))
                {
                    return clrAggregate;
                }

                return TypeSymbol.FromClrType(clrAliasType);
            }

            // Source types are visible by simple (possibly nested) name across
            // packages, but have no reflectable CLR type while binding, so the
            // resolver above never sees them. Resolve the alias target's final
            // dotted segment as a source type name instead.
            var lastDot = aliasTarget.LastIndexOf('.');
            var aliasSimpleName = lastDot >= 0 ? aliasTarget.Substring(lastDot + 1) : aliasTarget;
            if (!string.Equals(aliasSimpleName, name, System.StringComparison.Ordinal))
            {
                var aliasedSourceType = LookupType(aliasSimpleName, preferredArity);
                if (aliasedSourceType != null && !ReferenceEquals(aliasedSourceType, TypeSymbol.Error))
                {
                    return aliasedSourceType;
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #525: resolves a class declaration's base-type identifier to an
    /// imported CLR interface. Honors imports and aliases (via
    /// <see cref="LookupType(string)"/>) for simple names and falls back to direct
    /// fully-qualified resolution against the reference set. Only public
    /// CLR interface types are accepted; classes, value types, and other
    /// references are rejected so the regular "cannot find type" diagnostic
    /// still applies.
    /// </summary>
    /// <param name="name">The identifier text as written in the base clause.</param>
    /// <param name="importedInterface">The resolved CLR interface type symbol on success.</param>
    /// <returns><see langword="true"/> when the name resolves to an imported CLR interface; otherwise <see langword="false"/>.</returns>
    private bool TryResolveImportedInterface(string name, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out TypeSymbol? importedInterface)
    {
        importedInterface = null;

        // Simple name honoring imports/aliases. This is the same path used
        // by expression-type contexts (e.g. `var g IClrInterface = ...`),
        // which is why those contexts already find the interface today.
        var candidate = LookupType(name)?.ClrType;

        // Fully-qualified fallback against the reference set
        // (e.g. `System.IDisposable`).
        if (candidate == null && scope.References.TryResolveType(name, out var resolved))
        {
            candidate = resolved;
        }

        // Issue #526: dotted-qualifier names such as `Outer.INested` or
        // `Probe.CSharp.Outer.INested` mean a NESTED CLR interface — walk the
        // dotted name with Type.GetNestedType for the tail segments.
        if (candidate == null && name.Contains('.'))
        {
            candidate = TryResolveDottedClrType(name);
        }

        // TODO(issue-525): generic CLR interfaces (e.g. `IComparable<T>`)
        // require a base-type clause grammar that accepts a type-argument
        // list. The single-identifier base-type syntax can only name the
        // open definition, which is rejected here; closing it requires
        // additional parser work and is left for a follow-up issue.
        if (candidate == null || !candidate.IsInterface || candidate.IsGenericTypeDefinition)
        {
            return false;
        }

        importedInterface = TypeSymbol.FromClrType(candidate);
        return importedInterface?.ClrType != null;
    }

    /// <summary>
    /// Issue #296: resolves a class declaration's base-type name to an imported
    /// CLR base class. Honors imports and aliases (via <see cref="LookupType(string)"/>)
    /// for simple names and falls back to direct fully-qualified resolution.
    /// Only non-sealed reference (class) types are accepted as a base; CLR
    /// interfaces, value types, and sealed classes are rejected so the regular
    /// "cannot find type" / single-inheritance diagnostics still apply.
    /// </summary>
    private bool TryResolveImportedBaseType(string baseName, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out TypeSymbol? importedBaseType)
    {
        importedBaseType = null;

        // Simple name honoring imports/aliases, e.g. `MemoryStream` with
        // `import System.IO`. This is the same path used to resolve imported
        // types for construction and static access.
        var candidate = LookupType(baseName)?.ClrType;

        // Fully-qualified name, e.g. `System.IO.MemoryStream`, resolved directly
        // against the reference set.
        if (candidate == null && scope.References.TryResolveType(baseName, out var resolvedType))
        {
            candidate = resolvedType;
        }

        // Issue #526: dotted-qualifier names such as `Outer.NestedClass` mean a
        // NESTED CLR class — walk the dotted name with Type.GetNestedType.
        if (candidate == null && baseName.Contains('.'))
        {
            candidate = TryResolveDottedClrType(baseName);
        }

        if (candidate == null || !candidate.IsClass || candidate.IsInterface || candidate.IsSealed)
        {
            return false;
        }

        importedBaseType = TypeSymbol.FromClrType(candidate);
        return importedBaseType?.ClrType != null;
    }

    /// <summary>
    /// Issue #526: resolves a dotted-string CLR type name such as
    /// <c>Outer.Inner</c> or <c>Probe.CSharp.Outer.Inner</c> into a
    /// <see cref="System.Type"/>. Strategy: take increasingly long prefixes
    /// (joined by <c>.</c>) as the outer type and walk the remaining
    /// segments as nested types via <see cref="Type.GetNestedType(string, BindingFlags)"/>,
    /// returning the deepest match. Honors imports as a namespace prefix on
    /// the outer portion, matching <see cref="BindQualifiedTypeName"/>.
    /// Returns <c>null</c> when no split yields a fully resolvable type chain.
    /// </summary>
    private System.Type? TryResolveDottedClrType(string dottedName)
    {
        if (string.IsNullOrEmpty(dottedName) || !dottedName.Contains('.'))
        {
            return null;
        }

        var segments = dottedName.Split('.');
        for (var outerLen = segments.Length; outerLen >= 1; outerLen--)
        {
            System.Type? outer;
            if (outerLen == 1)
            {
                outer = LookupType(segments[0])?.ClrType;
            }
            else
            {
                var prefix = string.Join(".", segments, 0, outerLen);
                if (!scope.References.TryResolveType(prefix, out outer))
                {
                    outer = null;
                }

                if (outer == null)
                {
                    foreach (var import in scope.GetDeclaredImports())
                    {
                        if (scope.References.TryResolveType(import.Target + "." + prefix, out var viaImport))
                        {
                            outer = viaImport;
                            break;
                        }
                    }
                }
            }

            if (outer == null)
            {
                continue;
            }

            var current = outer;
            var resolved = true;
            for (var i = outerLen; i < segments.Length; i++)
            {
                if (!scope.References.TryResolveNestedType(current, segments[i], out var next))
                {
                    resolved = false;
                    break;
                }

                current = next;
            }

            if (resolved)
            {
                return current;
            }
        }

        return null;
    }

    /// <summary>
    /// Picks or synthesizes the entry-point function symbol for the compilation
    /// per the rules in design/Gsharp-design-v0.1.md (C#-9-style top-level
    /// statements). Reports diagnostics for ambiguity.
    /// </summary>
    private static FunctionSymbol? ResolveEntryPoint(
        Binder binder,
        ImmutableArray<FunctionSymbol> functions,
        ImmutableArray<StructSymbol> structs,
        GlobalStatementSyntax[] globalStatements,
        ImmutableArray<SyntaxTree> syntaxTrees,
        PackageSymbol entryPointPackage,
        FunctionSymbol? synthesizedEntryPoint)
    {
        var explicitMain = functions.FirstOrDefault(f => f.Name == "Main");

        // Issue #1996: a class-scoped static `Main` (sync or async, any
        // class — not just `Program`) is also a valid entry-point
        // candidate. Instance `Main` methods don't qualify (no receiver
        // exists to construct at startup), so only StaticMethods are
        // scanned. Package-scope `Main` takes precedence when both exist,
        // mirroring the pre-existing (silent, first-found) precedence for
        // multiple package-scope `Main` declarations — this codebase does
        // not diagnose ambiguous entry points today, so we don't introduce
        // that check here either.
        var classMain = explicitMain == null && !structs.IsDefaultOrEmpty
            ? structs
                .Where(s => s.IsClass && !s.StaticMethods.IsDefaultOrEmpty)
                .SelectMany(s => s.StaticMethods.AsEnumerable())
                .FirstOrDefault(m => m.Name == "Main")
            : null;
        explicitMain ??= classMain;

        var hasTopLevel = globalStatements.Length > 0;

        if (hasTopLevel)
        {
            // Top-level statements must live in exactly one *package*. Multiple
            // files within the same package may collectively contribute top-level
            // statements (matching the C# "one Program type per assembly" rule
            // relaxed to packages).
            var packagesWithTopLevel = syntaxTrees
                .Where(st => st.Root.Members.OfType<GlobalStatementSyntax>().Any())
                .Select(st =>
                {
                    var pkgSyntax = st.Root.Members.OfType<PackageSyntax>().FirstOrDefault();
                    return pkgSyntax != null
                        ? string.Concat(pkgSyntax.IdentifiersWithDots.Select(t => t.ValueText))
                        : "Default";
                })
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (packagesWithTopLevel.Length > 1)
            {
                foreach (var tree in syntaxTrees.Where(st => st.Root.Members.OfType<GlobalStatementSyntax>().Any()))
                {
                    var first = tree.Root.Members.OfType<GlobalStatementSyntax>().First();
                    binder.Diagnostics.ReportMultipleTopLevelFiles(first.Statement.Location);
                }
            }

            if (explicitMain != null)
            {
                // explicitMain is either a source-declared `Main` function or
                // a class-scoped static `Main` method (classMain below) —
                // both are real user declarations, never the declaration:null
                // synthesized entry point.
                binder.Diagnostics.ReportTopLevelStatementsConflictWithMain(
                    Invariant.Required(explicitMain.Declaration, "a user-declared Main function has a source declaration").Identifier.Location);
            }

            // ADR-0066 D1: the synthesized entry-point symbol (with its
            // `args string[]` parameter) is constructed up front in
            // BindGlobalScope so that TLS can be bound through a
            // function-scoped Binder; here we just return that symbol.
            return synthesizedEntryPoint;
        }

        return explicitMain;
    }

    private static PackageSymbol ResolveEntryPointPackage(
        Dictionary<SyntaxTree, PackageSymbol> packageByTree,
        GlobalStatementSyntax[] globalStatements,
        ImmutableArray<FunctionSymbol> functions,
        ImmutableArray<PackageSymbol>.Builder packagesInOrder)
    {
        if (globalStatements.Length > 0)
        {
            return packageByTree[globalStatements[0].SyntaxTree];
        }

        var explicitMain = functions.FirstOrDefault(f => f.Name == "Main");
        if (explicitMain?.Package != null)
        {
            return explicitMain.Package;
        }

        return packagesInOrder.Count > 0
            ? packagesInOrder[0]
            : new PackageSymbol("Default", declaration: null);
    }

    /// <summary>
    /// Attaches authored documentation from a G# doc comment to a symbol (ADR-0057 §7/§8).
    /// Parses the block text from the syntax tree side-table and calls <see cref="Symbol.SetDocumentation"/>.
    /// </summary>
    /// <param name="symbol">The symbol that should receive the parsed documentation.</param>
    /// <param name="syntax">The syntax node whose attached doc-comment text is being attached.</param>
    internal static void AttachDocumentation(Symbol symbol, SyntaxNode? syntax)
    {
        var docText = syntax?.SyntaxTree?.GetDocumentation(syntax);
        if (docText == null)
        {
            return;
        }

        var doc = GSharpDocumentationParser.Parse(docText);
        if (doc != null)
        {
            symbol.SetDocumentation(doc);
        }
    }

    private readonly record struct BodyBindResult(
        BoundBlockStatement Body,
        ImmutableArray<Diagnostic> Diagnostics);

    /// <summary>
    /// Issues #4089/#4090: one G#-declared generic TYPE-CLAUSE construction
    /// whose constraint check has been recorded but not yet answered, because
    /// at the construction site the definition's own type-parameter constraints
    /// may not be resolved yet.
    /// </summary>
    /// <remarks>
    /// The <see cref="DiagnosticBag"/> is captured rather than looked up at
    /// flush time: a binder's bag is its own, and a type clause bound inside a
    /// field initializer or a lambda during the declaration phase belongs to a
    /// different bag from the root binder's.
    /// </remarks>
    internal readonly struct PendingUserGenericConstraintCheck
    {
        public PendingUserGenericConstraintCheck(
            DiagnosticBag diagnostics,
            ImmutableArray<TypeParameterSymbol> declaredParameters,
            ImmutableArray<TypeSymbol> typeArgs,
            TextLocation location)
        {
            Diagnostics = diagnostics;
            DeclaredParameters = declaredParameters;
            TypeArgs = typeArgs;
            Location = location;
        }

        /// <summary>Gets the bag the diagnostic is reported into.</summary>
        public DiagnosticBag Diagnostics { get; }

        /// <summary>Gets the definition's own type parameters.</summary>
        public ImmutableArray<TypeParameterSymbol> DeclaredParameters { get; }

        /// <summary>Gets the symbolic arguments, in declaration order.</summary>
        public ImmutableArray<TypeSymbol> TypeArgs { get; }

        /// <summary>Gets the location the diagnostic is anchored to.</summary>
        public TextLocation Location { get; }
    }

#pragma warning restore SA1202
}
