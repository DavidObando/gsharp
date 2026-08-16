// <copyright file="Binder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
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
            ClrOperatorResolution.TryResolveConversion(source, target, allowExplicit: false, out _, out _);
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
                method.IsAsync && !IsAsyncIteratorReturnType(returnType)
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
            tryBindClrConstructorCall: (CallExpressionSyntax syntax, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out BoundExpression? result) => Expressions.TryBindClrConstructorCall(syntax, out result),
            tryBindIntrinsicCall: (CallExpressionSyntax syntax, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out BoundExpression? result) => Expressions.TryBindIntrinsicCall(syntax, out result),
            tryBindInheritedClrInstanceCall: (BoundExpression receiver, Type? importedBaseClr, string methodName, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out BoundExpression? result, Type[]? explicitTypeArgs, ImmutableArray<TypeSymbol> typeArgSymbols, ImmutableArray<string> argumentNames, bool allowProtectedInherited) =>
            {
                return Expressions.TryBindInheritedClrInstanceCall(receiver, importedBaseClr, methodName, arguments, ce, out result, explicitTypeArgs, typeArgSymbols, argumentNames, allowProtectedInherited: allowProtectedInherited);
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
            tryGetFunctionLiteral: LambdaBinder.TryGetFunctionLiteral,
            inferTypeArguments: InferTypeArguments,
            substituteType: (t, subst) => SubstituteType(t, subst, scope.References.MapClrTypeToReferences),
            satisfiesConstraint: SatisfiesConstraint,
            describeConstraint: DescribeConstraint,
            getCurrentFunction: () => this.function,
            bindLambdaWithTarget: (syntax, targetType) =>
            {
                return Lambdas.BindLambdaExpression(syntax, targetType);
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
        lambdas = new LambdaBinder(
            binderCtx,
            conversions,
            bindBlockStatement: syntax => Statements.BindBlockStatement(syntax),
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
            bindLambdaBodyExpression: BindLambdaBodyExpressionForLambdas,
            bindTypeParameterList: syntax =>
            {
                return Declarations.BindTypeParameterList(syntax);
            });
        BoundExpression BindExpressionWithTargetTypeForStatements(
            ExpressionSyntax syntax,
            TypeSymbol targetType) =>
            Expressions.BindExpression(syntax, targetType);
        BoundExpression BindLambdaBodyExpressionForLambdas(ExpressionSyntax syntax) =>
            Expressions.BindLambdaBodyExpression(syntax);
        statements = new StatementBinder(
            binderCtx,
            conversions,
            patterns,
            bindExpression: (syntax, canBeVoid) => Expressions.BindExpression(syntax, canBeVoid),
            bindExpressionWithTargetType: BindExpressionWithTargetTypeForStatements,
            bindTypeClause: BindTypeClause,
            bindLocalVariable: (identifier, isReadOnly, type) => Declarations.BindVariableDeclaration(identifier, isReadOnly, type),
            bindLocalVariableWithAccessibility: (identifier, isReadOnly, type, accessibility) => Declarations.BindVariableDeclaration(identifier, isReadOnly, type, accessibility),
            bindVariableReference: (name, location) => Expressions.BindVariableReference(name, location),
            bindInterpolatedStringAsFormattable: (syntax, targetType) =>
            {
                return Expressions.BindInterpolatedStringAsFormattable(syntax, targetType);
            },
            isFormattableStringTargetType: ExpressionBinder.IsFormattableStringTargetType,
            isLvalue: ExpressionBinder.IsLvalue,
            isIteratorReturnType: IsIteratorReturnType,
            resolveAccessibility: ResolveAccessibility,
            bindVariableDeclarationAttributes: (annotations, positionDescription) => Declarations.BindAttributes(annotations, AttributeTargetKind.Field, VariableDeclarationAllowedTargets, positionDescription, System.AttributeTargets.Field),
            getCurrentFunction: () => this.function,
            bindLambdaWithTargetType: (syntax, targetType) => Lambdas.BindLambdaExpression(syntax, targetType),
            bindGenericLocalFunctionDeclaration: syntax => Lambdas.BindGenericLocalFunctionDeclaration(syntax),
            checkNonGenericLocalFunctionEnclosingTypeParameterReference: (location, name, literal) => Lambdas.CheckNonGenericLocalFunctionEnclosingTypeParameterReference(location, name, literal));
        BoundExpression BindTypeOfExpressionForDeclarations(TypeOfExpressionSyntax syntax) =>
            Expressions.BindTypeOfExpression(syntax);
        BoundExpression BindExpressionForDeclarations(ExpressionSyntax syntax) =>
            Expressions.BindExpression(syntax);
        declarations = new DeclarationBinder(
            binderCtx,
            conversions,
            bindExpression: BindExpressionForDeclarations,
            bindTypeClause: BindTypeClause,
            bindReturnTypeClause: (syntax, isAsync) => BindReturnTypeClause(syntax, isAsync),
            bindTypeOfExpression: BindTypeOfExpressionForDeclarations,
            bindArrayCreationExpression: syntax => Expressions.BindArrayCreationExpression(syntax),
            resolveAccessibility: ResolveAccessibility,
            lookupType: LookupType,
            getEffectiveArgumentClrType: t => Expressions.GetEffectiveArgumentClrType(t),
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
            bindLocalVariable: (identifier, isReadOnly, type) => Declarations.BindVariableDeclaration(identifier, isReadOnly, type));

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

                // ADR-0058 / issue #376: for ref struct instance methods, the implicit
                // `this` parameter has function-local safe-to-escape by default (scoped).
                // Only [UnscopedRef] relaxes this, allowing `this` to be returned.
                if (TypeSymbol.IsByRefLike(function.ReceiverType) && !DeclarationBinder.HasUnscopedRefAnnotation(function))
                {
                    function.ThisParameter.IsScoped = true;
                }

                // Phase 3.B.3 sub-step 2b: expose each field on the receiver
                // as a bare name inside the method body. Field access lowers
                // to `this.<field>` at name resolution time.
                // Sub-step 3: walk inheritance chain so inherited fields are
                // also accessible via bare name. Derived shadowing wins.
                if (function.ReceiverType is StructSymbol receiverStruct)
                {
                    StructSymbol? currentReceiverType = receiverStruct;
                    while (currentReceiverType != null)
                    {
                        var t = currentReceiverType;
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

                        currentReceiverType = t.BaseClass;
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
                ? string.Concat(packageSyntax.IdentifiersWithDots.Select(t => t.Text))
                : defaultPackageName;
            if (!packagesByName.TryGetValue(packageName, out var packageSymbol))
            {
                packageSymbol = new PackageSymbol(packageName, packageSyntax);
                packagesByName[packageName] = packageSymbol;
                packagesInOrder.Add(packageSymbol);
                AttachDocumentation(packageSymbol, packageSyntax);
            }

            packageByTree[tree] = packageSymbol;
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
            CollectRichAnonymousObjectDeclarations(tree.Root, tree, richAnonymousClasses, binder.Diagnostics, ref anonClassCounter);
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
            TypeClauseSyntax? baseType = syntax.BaseTypeClauses.Count > 0
                ? syntax.BaseTypeClauses[0]
                : syntax.BaseTypeIdentifier == null
                    ? null
                    : new TypeClauseSyntax(syntax.BaseTypeIdentifier.SyntaxTree, syntax.BaseTypeIdentifier);
            var baseName = baseType?.QualifierIdentifierTokens.LastOrDefault()?.Text
                ?? baseType?.Identifier?.Text;
            if (symbol.IsClass && baseName != null && declarationsByName.TryGetValue(baseName, out var candidates))
            {
                // baseName is derived from baseType via `?.`, so a non-null
                // baseName implies baseType is non-null.
                var nonNullBaseType = Invariant.Required(baseType, "baseName is non-null only when baseType is non-null");
                var requestedPackage = nonNullBaseType.HasQualifier
                    ? nonNullBaseType.DottedName[..^(baseName.Length + 1)]
                    : symbol.PackageName;
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

                var baseIndex = matchingPackage.Count == 1
                    ? matchingPackage[0]
                    : classCandidateCount == 1
                        ? soleClassCandidate
                        : -1;
                if (baseIndex >= 0)
                {
                    AddBaseFirst(baseIndex);
                }
            }

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
        binder.declarations.BindPendingBaseInitializers();
        binder.declarations.BindPendingFieldInitializers();

        binder.declarations.ExpandStructInterfaceClosures();

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

                statements.AddRange(tlsBinder.statements.BindStatementList(
                    topLevelStatements.MoveToImmutable(),
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
        var entryPoint = ResolveEntryPoint(binder, functions, structs, globalStatements, syntaxTrees, entryPointPackage, synthesizedEntryPoint);

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

        var diagnostics = binder.Diagnostics.ToImmutableArray();

        if (previous != null)
        {
            diagnostics = diagnostics.InsertRange(0, previous.Diagnostics);
        }

        var delegates = binder.scope.GetDeclaredDelegates();

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

        // Issue #1929/#1953: collect producer-declared friend assemblies
        // (`@assembly:InternalsVisibleTo("...")`) so the emitter can write
        // real InternalsVisibleToAttribute rows. Diagnostics for malformed
        // declarations report through binder.Diagnostics above, but that bag
        // was already snapshotted into `diagnostics`, so append here too.
        var friendDiagnostics = new DiagnosticBag();
        var friendAssemblies = FriendAssemblyDeclarations.Collect(syntaxTrees, friendDiagnostics);
        result.FriendAssemblies = previous == null
            ? friendAssemblies
            : previous.FriendAssemblies.AddRange(friendAssemblies.Where(f => !previous.FriendAssemblies.Contains(f)));
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
            .AddRange(parentScope.GetAnonymousTypeCache().Symbols);

        return new BoundProgram(globalScope.Package, globalScope.Packages, diagnostics.ToImmutable(), functionBodies.ToImmutable(), globalScope.EntryPoint, statement, allStructs, globalScope.Interfaces, globalScope.Enums, globals, globalScope.Delegates)
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
        DefiniteAssignmentAnalyzer.Analyze(body, function, diagnostics);
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
        ref int counter)
    {
        if (node is AnonymousClassExpressionSyntax anon && IsRichAnonymousObject(anon))
        {
            var decl = SynthesizeAnonymousClassDeclaration(anon, tree, counter++, diagnostics);
            results.Add((anon, decl));
        }

        foreach (var child in node.GetChildren())
        {
            CollectRichAnonymousObjectDeclarations(child, tree, results, diagnostics, ref counter);
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
    /// backing a rich anonymous-object literal. Field members become public
    /// class fields (with their initializers), method and event members are
    /// spliced verbatim, and the base/interface clause (with any
    /// base-constructor arguments) is forwarded onto the synthesized class.
    /// Field initializers and base-constructor arguments must be self-contained
    /// (they cannot reference enclosing locals) — a documented limitation of
    /// the rich path; the field-only path retains full capture/inference.
    /// </summary>
    private static StructDeclarationSyntax SynthesizeAnonymousClassDeclaration(
        AnonymousClassExpressionSyntax syntax,
        SyntaxTree tree,
        int index,
        DiagnosticBag diagnostics)
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
                    if (field.TypeClause == null)
                    {
                        // The rich path materializes fields as ordinary class
                        // fields, which require an explicit type. Inferred-type
                        // fields are only supported on the field-only path.
                        diagnostics.ReportInferredFieldTypeNotAllowedInRichAnonymousObject(field.Identifier.Location, field.Identifier.Text);
                        continue;
                    }

                    fields.Add(new FieldDeclarationSyntax(
                        tree,
                        Tok(SyntaxKind.PublicKeyword, "public"),
                        field.LetOrVarKeyword,
                        field.Identifier,
                        field.TypeClause,
                        field.EqualsToken,
                        field.Value));
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
        decl.BaseTypeClauses = baseTypeClauses;
        decl.BaseConstructorOpenParenthesisToken = syntax.BaseConstructorOpenParenthesisToken;
        decl.BaseConstructorArguments = syntax.BaseConstructorArguments;
        decl.BaseConstructorCloseParenthesisToken = syntax.BaseConstructorCloseParenthesisToken;
        return decl;
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
            sb.Append(i.Text);
        }

        var targetPath = sb.ToString();
        var localName = import.AliasIdentifier?.Text ?? targetPath;
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

            var convention = System.Runtime.InteropServices.CallingConvention.Cdecl;
            if (syntax.CallingConventionIdentifierToken != null)
            {
                var ccName = syntax.CallingConventionIdentifierToken.Text;
                switch (ccName)
                {
                    case "Cdecl":
                        convention = System.Runtime.InteropServices.CallingConvention.Cdecl;
                        break;
                    case "Stdcall":
                        convention = System.Runtime.InteropServices.CallingConvention.StdCall;
                        break;
                    case "Thiscall":
                        convention = System.Runtime.InteropServices.CallingConvention.ThisCall;
                        break;
                    case "Fastcall":
                        convention = System.Runtime.InteropServices.CallingConvention.FastCall;
                        break;
                    default:
                        Diagnostics.ReportFunctionPointerUnknownCallingConvention(
                            syntax.CallingConventionIdentifierToken.Location,
                            ccName);
                        return null;
                }
            }

            return FunctionPointerTypeSymbol.Get(convention, paramTypes.MoveToImmutable(), fpRet);
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
                        pt = SliceTypeSymbol.Get(pt);
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
            for (var i = 0; i < tupleElements.Count; i++)
            {
                var elementType = BindTypeClause(tupleElements[i]);
                if (elementType == null)
                {
                    return null;
                }

                elements.Add(elementType);
            }

            return TupleTypeSymbol.Get(elements.MoveToImmutable());
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

        if (syntax.IsChannel)
        {
            // Phase 5.4 / ADR-0022: channel type clause `chan T`.
            // ADR-0082 / issue #722: gate on `import Gsharp.Extensions.Go`.
            // Reports GS0316 anchored at the `chan` keyword and recovers by
            // binding the channel type as if the import were present.
            // IsChannel implies the parser set ChanKeyword/ChanElementType.
            var chanKeyword = Invariant.Required(syntax.ChanKeyword, "IsChannel implies the parser set ChanKeyword");
            binderCtx.ReportIfGoExtensionsImportMissing(syntax, chanKeyword.Location, "chan");

            var elementType = BindTypeClause(Invariant.Required(syntax.ChanElementType, "IsChannel implies the parser set ChanElementType"));
            if (elementType == null)
            {
                return null;
            }

            return ChannelTypeSymbol.Get(elementType);
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
        if (!syntax.HasQualifier &&
            syntax.HasTypeArguments &&
            scope.TryLookupImportedGenericClass(identifierToken.Text, Invariant.Required(syntax.TypeArguments, "HasTypeArguments implies the parser set TypeArguments").Count, out var clrOpenType))
        {
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

            try
            {
                var closed = clrOpenType.MakeGenericType(clrArgs);
                if (hasSymbolicArg)
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
                Diagnostics.ReportTypeNotGeneric(identifierToken.Location, identifierToken.Text);
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
            element = LookupType(identifierToken.Text, requestedArity, out var ambiguousAcrossImportedPackages);
            if (element == null)
            {
                // Issue #2455: "ambiguous between imported packages" and "no
                // match at all" are different failure modes and deserve
                // different diagnostics — ambiguous means two or more
                // colliding same-named top-level types are each imported, not
                // that the type is undefined.
                if (ambiguousAcrossImportedPackages)
                {
                    Diagnostics.ReportAmbiguousSourceType(identifierToken.Location, identifierToken.Text);
                }
                else
                {
                    Diagnostics.ReportUndefinedType(identifierToken.Location, identifierToken.Text);
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
                        Diagnostics.ReportTypeNotGeneric(identifierToken.Location, identifierToken.Text);
                        return null;
                    }

                    if (iface.TypeParameters.Length != typeArgs.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(identifierToken.Location, identifierToken.Text, iface.TypeParameters.Length, typeArgs.Length);
                        return null;
                    }

                    element = InterfaceSymbol.Construct(iface, typeArgs, scope.References.MapClrTypeToReferences);
                }
                else if (element is StructSymbol genericStruct)
                {
                    if (!genericStruct.IsGenericDefinition)
                    {
                        Diagnostics.ReportTypeNotGeneric(identifierToken.Location, identifierToken.Text);
                        return null;
                    }

                    if (genericStruct.TypeParameters.Length != typeArgs.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(identifierToken.Location, identifierToken.Text, genericStruct.TypeParameters.Length, typeArgs.Length);
                        return null;
                    }

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
                        Diagnostics.ReportTypeNotGeneric(identifierToken.Location, identifierToken.Text);
                        return null;
                    }

                    if (genericDelegate.TypeParameters.Length != typeArgs.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(identifierToken.Location, identifierToken.Text, genericDelegate.TypeParameters.Length, typeArgs.Length);
                        return null;
                    }

                    element = DelegateTypeSymbol.Construct(genericDelegate, typeArgs);
                }
                else
                {
                    Diagnostics.ReportTypeNotGeneric(identifierToken.Location, identifierToken.Text);
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
            var segmentName = i == 0 ? headIdentifier.Text : string.Join(".", segmentTexts, 0, i + 1);
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
                return StructSymbol.Construct(genericStruct, typeArgs, scope.References.MapClrTypeToReferences);
            case InterfaceSymbol genericIface when genericIface.IsGenericDefinition && genericIface.TypeParameters.Length == typeArgs.Length:
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
        segmentTexts[0] = qualifiedIdentifier.Text;
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
        var sourceType = LookupType(lastSegment, targetArity > 0 ? targetArity : -1);
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
        var outermost = LookupType(qualifiedIdentifier.Text);
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

        var lastGoodName = qualifiedIdentifier.Text;
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

        try
        {
            var closed = clrType.MakeGenericType(clrArgs);
            if (hasSymbolicArg)
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
                if (scope.TryLookupImportedGenericClass(segmentTexts[0], arity, out var imported))
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

        try
        {
            var closed = nestedDef.MakeGenericType(clrArgs);
            if (hasSymbolicArg)
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
        // #313 / #671: preserve symbolic type parameters, user types, and
        // nested generic/array/nullable shapes beside their erased CLR form.
        if (TypeSymbol.RequiresSymbolicProjection(type) || type.ClrType == null)
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

    private static bool IsIteratorReturnType(TypeSymbol type)
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
            && call.Identifier.Text == "init";
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
            if (argumentType == TypeSymbol.Void)
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
                    var argClrSeq = argumentType?.ClrType;
                    var openIEnumerable = typeof(System.Collections.Generic.IEnumerable<>);
                    if (argClrSeq != null)
                    {
                        var matchedSeq = argClrSeq.IsGenericType && argClrSeq.GetGenericTypeDefinition().IsSameAs(openIEnumerable)
                            ? argClrSeq
                            : FindMatchingInterface(argClrSeq, openIEnumerable);
                        if (matchedSeq != null)
                        {
                            var args = matchedSeq.GetGenericArguments();
                            if (args.Length == 1)
                            {
                                InferTypeArguments(pseq.ElementType, TypeSymbol.FromClrType(args[0]), substitution);
                            }
                        }
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
                    var argClrAseq = argumentType?.ClrType;
                    var openIAsyncEnumerable = typeof(System.Collections.Generic.IAsyncEnumerable<>);
                    if (argClrAseq != null)
                    {
                        var matchedAseq = argClrAseq.IsGenericType && argClrAseq.GetGenericTypeDefinition().IsSameAs(openIAsyncEnumerable)
                            ? argClrAseq
                            : FindMatchingInterface(argClrAseq, openIAsyncEnumerable);
                        if (matchedAseq != null)
                        {
                            var args = matchedAseq.GetGenericArguments();
                            if (args.Length == 1)
                            {
                                InferTypeArguments(paseq.ElementType, TypeSymbol.FromClrType(args[0]), substitution);
                            }
                        }
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
        var argumentClrArguments = GetClrGenericArguments(argumentType);
        if (!argumentClrArguments.IsDefaultOrEmpty
            && argumentClrArguments.Length == parameterType.TypeArguments.Length)
        {
            for (var i = 0; i < parameterType.TypeArguments.Length; i++)
            {
                InferTypeArguments(
                    parameterType.TypeArguments[i],
                    argumentClrArguments[i],
                    substitution);
            }

            return;
        }

        var argumentClrType = argumentType.ClrType;
        var matchedInterface = argumentClrType != null
            && argumentClrType.IsArray
            && parameterType.OpenDefinition != null
                ? FindMatchingInterface(argumentClrType, parameterType.OpenDefinition)
                : null;
        if (matchedInterface != null)
        {
            var matchedArguments = matchedInterface.GetGenericArguments();
            if (matchedArguments.Length == parameterType.TypeArguments.Length)
            {
                for (var i = 0; i < parameterType.TypeArguments.Length; i++)
                {
                    InferTypeArguments(
                        parameterType.TypeArguments[i],
                        TypeSymbol.FromClrType(matchedArguments[i]),
                        substitution);
                }
            }

            return;
        }

        if ((argumentType is SliceTypeSymbol || argumentType is ArrayTypeSymbol)
            && parameterType.TypeArguments.Length == 1
            && IsArrayCompatibleOpenInterface(parameterType.OpenDefinition))
        {
            var elementType = argumentType is SliceTypeSymbol slice
                ? slice.ElementType
                : ((ArrayTypeSymbol)argumentType).ElementType;
            InferTypeArguments(parameterType.TypeArguments[0], elementType, substitution);
        }
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

    // Issue #1932: find the constructed type arguments for `definition` on
    // `type` itself, or (when `type` is a struct/class) on one of its
    // implemented interfaces — e.g. matching parameter `IHolder[T]` against
    // an argument struct/class that implements `IHolder[string]`.
    private static bool TryFindUserGenericArguments(TypeSymbol type, TypeSymbol definition, out ImmutableArray<TypeSymbol> typeArguments)
    {
        if (TryGetUserGenericArguments(type, out var ownDefinition, out typeArguments)
            && ReferenceEquals(ownDefinition, definition))
        {
            return true;
        }

        if (type is StructSymbol s && !s.Interfaces.IsDefaultOrEmpty)
        {
            foreach (var iface in s.Interfaces)
            {
                if (TryGetUserGenericArguments(iface, out var ifaceDefinition, out var ifaceArgs)
                    && ReferenceEquals(ifaceDefinition, definition))
                {
                    typeArguments = ifaceArgs;
                    return true;
                }
            }
        }

        typeArguments = ImmutableArray<TypeSymbol>.Empty;
        return false;
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

    // #611: find the closed generic interface on a CLR type that matches
    // the given open generic definition (e.g. find `IEnumerable<int>` on
    // `int[]` given `IEnumerable<>` as the open definition).
    private static Type? FindMatchingInterface(Type? clrType, Type? openDefinition)
    {
        if (clrType == null || openDefinition == null || !openDefinition.IsGenericTypeDefinition)
        {
            return null;
        }

        try
        {
            foreach (var iface in clrType.GetInterfaces())
            {
                if (iface.IsGenericType && iface.GetGenericTypeDefinition().IsSameAs(openDefinition))
                {
                    return iface;
                }
            }
        }
        catch (Exception)
        {
            // MLC cross-context or other reflection failure — treat as no match.
        }

        return null;
    }

    // Issue #2416: the fixed, closed set of single-type-parameter generic
    // interfaces that the CLR guarantees every single-dimensional array
    // (`T[]`) implements, regardless of whether `T` has been emitted yet.
    // Used to symbolically unify a slice/array argument against an
    // `IEnumerable[T]`-shaped (or equivalent) generic parameter when the
    // array's element type has no `ClrType` (still source-only), so
    // reflection-based interface lookup (<see cref="FindMatchingInterface"/>)
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

        if (type is NullableTypeSymbol n)
        {
            var inner = SubstituteType(n.UnderlyingType, substitution, mapClrType);
            return ReferenceEquals(inner, n.UnderlyingType) ? type : NullableTypeSymbol.Get(inner);
        }

        if (type is SliceTypeSymbol s)
        {
            var inner = SubstituteType(s.ElementType, substitution, mapClrType);
            return ReferenceEquals(inner, s.ElementType) ? type : SliceTypeSymbol.Get(inner);
        }

        if (type is ArrayTypeSymbol a)
        {
            var inner = SubstituteType(a.ElementType, substitution, mapClrType);
            return ReferenceEquals(inner, a.ElementType) ? type : ArrayTypeSymbol.Get(inner, a.Length);
        }

        if (type is RectangularArrayTypeSymbol rectangularArray)
        {
            var inner = SubstituteType(rectangularArray.ElementType, substitution, mapClrType);
            return ReferenceEquals(inner, rectangularArray.ElementType) ? type : RectangularArrayTypeSymbol.Get(inner, rectangularArray.Rank);
        }

        if (type is SequenceTypeSymbol seq)
        {
            // Issue #773: substitute through `sequence[T]` so the open
            // receiver of a generic extension lowers to a concrete
            // `sequence[U]` at the call site (and downstream
            // `BindExtensionFunctionCall` sees a matching parameter type).
            var inner = SubstituteType(seq.ElementType, substitution, mapClrType);
            return ReferenceEquals(inner, seq.ElementType) ? type : SequenceTypeSymbol.Get(inner);
        }

        if (type is AsyncSequenceTypeSymbol aseq)
        {
            var inner = SubstituteType(aseq.ElementType, substitution, mapClrType);
            return ReferenceEquals(inner, aseq.ElementType) ? type : AsyncSequenceTypeSymbol.Get(inner);
        }

        if (type is ChannelTypeSymbol channel)
        {
            var inner = SubstituteType(channel.ElementType, substitution, mapClrType);
            return ReferenceEquals(inner, channel.ElementType) ? type : ChannelTypeSymbol.Get(inner);
        }

        if (type is MapTypeSymbol map)
        {
            // Issue #1481: substitute through `map[K, V]` so a call like
            // `entries[int32](items)` lowers its return type from the open
            // `sequence[map[string, T]]` to the closed
            // `sequence[map[string, int32]]`. Without this branch the map's
            // key/value types stay parametric, so the for-in at the call site
            // encodes its `IEnumerable<Dictionary<string, !!0>>` GetEnumerator
            // reference against the unsubstituted method type parameter and
            // fails verification against the closed kickoff return. Directly
            // analogous to the tuple branch below (#813).
            var newKey = SubstituteType(map.KeyType, substitution, mapClrType);
            var newValue = SubstituteType(map.ValueType, substitution, mapClrType);
            return ReferenceEquals(newKey, map.KeyType) && ReferenceEquals(newValue, map.ValueType)
                ? type
                : MapTypeSymbol.Get(newKey, newValue);
        }

        if (type is TupleTypeSymbol tup)
        {
            // Issue #813: substitute through `(T1, T2, …)` so a call like
            // `Indexed[int32](source)` lowers its return type from the
            // open `sequence[(int32, T)]` to the closed
            // `sequence[(int32, int32)]`. Without this branch the tuple's
            // element types stay parametric and downstream member lookup
            // (`.Item1` / `.Item2`) and conversion checks behave as if
            // T were never substituted.
            var builder = ImmutableArray.CreateBuilder<TypeSymbol>(tup.ElementTypes.Length);
            var changed = false;
            foreach (var elem in tup.ElementTypes)
            {
                var substituted = SubstituteType(elem, substitution, mapClrType);
                if (!ReferenceEquals(substituted, elem))
                {
                    changed = true;
                }

                builder.Add(substituted);
            }

            return changed ? TupleTypeSymbol.Get(builder.MoveToImmutable()) : type;
        }

        if (type is FunctionTypeSymbol fn)
        {
            var changed = false;
            var builder = ImmutableArray.CreateBuilder<TypeSymbol>(fn.ParameterTypes.Length);
            foreach (var paramType in fn.ParameterTypes)
            {
                var substituted = SubstituteType(paramType, substitution, mapClrType);
                changed |= !ReferenceEquals(substituted, paramType);
                builder.Add(substituted);
            }

            var substitutedReturn = SubstituteType(fn.ReturnType, substitution, mapClrType);
            changed |= !ReferenceEquals(substitutedReturn, fn.ReturnType);

            // ADR-0102 follow-up / issue #818: preserve the per-parameter
            // variadic flags through substitution so the substituted function
            // type retains its variadic call-site semantics.
            return changed
                ? FunctionTypeSymbol.Get(builder.MoveToImmutable(), fn.IsVariadic, substitutedReturn)
                : type;
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
                arg => SubstituteType(arg, substitution, mapClrType),
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
            nestedType => SubstituteType(nestedType, substitution, mapClrType);
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

                    var clr = substitutedArgs[i].ClrType;
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
    internal static bool SatisfiesConstraint(TypeSymbol typeArgument, TypeParameterSymbol tp)
    {
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
    /// Issue #1056: returns <see langword="true"/> when <paramref name="typeArgument"/>
    /// satisfies a base-class constraint <paramref name="classConstraint"/> — it
    /// is the constraint class itself (by definition identity, so a constructed
    /// instantiation of the same generic class counts) or transitively derives
    /// from it. A constraining type parameter whose own class constraint already
    /// derives from the target is accepted (constraint propagation). For an
    /// imported reference class the CLR assignability relation is used.
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

        // Constraint propagation: a type parameter constrained to a class that
        // is or derives from the target satisfies the bound.
        if (typeArgument is TypeParameterSymbol tpArg)
        {
            return tpArg.ClassConstraint != null
                && SatisfiesClassConstraint(tpArg.ClassConstraint, classConstraint);
        }

        if (classConstraint is StructSymbol classDef)
        {
            var constraintDef = classDef.Definition ?? classDef;
            if (typeArgument is StructSymbol argClass)
            {
                for (var current = argClass; current != null; current = current.BaseClass)
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
        if (classConstraint.ClrType is { } constraintClr && typeArgument.ClrType is { } argClr)
        {
            return constraintClr.IsAssignableFrom(argClr);
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

        if (type == TypeSymbol.String)
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
            for (var current = s; current != null; current = current.BaseClass)
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
    internal static bool SatisfiesClrInterfaceConstraint(TypeSymbol typeArgument, TypeSymbol constraint, TypeParameterSymbol tp)
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
            return string.Equals(typeArgClr.FullName, constraintClr.FullName, StringComparison.Ordinal)
                || typeArgClr.GetInterfaces().Any(i =>
                    string.Equals(i.FullName, constraintClr.FullName, StringComparison.Ordinal));
        }

        var openDefName = constraintClr.GetGenericTypeDefinition().FullName;

        // constraint is this method's own non-nullable parameter (the
        // `constraint?.ClrType` read above is a redundant null-conditional,
        // not a narrowing of constraint).
        var constraintArgs = MemberLookup.GetImportedTypeSymbol(constraint!)?.TypeArguments
            ?? ImmutableArray<TypeSymbol>.Empty;
        var constraintClrArgs = constraintClr.GetGenericArguments();

        var candidates = new List<Type>();
        if (typeArgClr.IsInterface)
        {
            candidates.Add(typeArgClr);
        }

        foreach (var interfaceType in typeArgClr.GetInterfaces())
        {
            candidates.Add(interfaceType);
        }

        foreach (var candidate in candidates)
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
                typeArgClr))
            {
                return true;
            }
        }

        return false;
    }

    private static bool GenericConstraintArgumentsMatch(
        Type[] candidateArgs,
        ImmutableArray<TypeSymbol> constraintArgs,
        Type[] constraintClrArgs,
        TypeParameterSymbol tp,
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
            var expectedName = !constraintArgs.IsDefaultOrEmpty
                ? (constraintArgs[i] is TypeParameterSymbol cArgTp && ReferenceEquals(cArgTp, tp)
                    ? typeArgClr.FullName
                    : constraintArgs[i].ClrType?.FullName)
                : constraintClrArgs[i].FullName;

            if (expectedName == null
                || !string.Equals(candidateArgs[i].FullName, expectedName, StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
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
    /// <returns>The resolved type, or <c>null</c> when unresolved or ambiguous.</returns>
    private TypeSymbol? LookupType(string name, int preferredArity, out bool ambiguousAcrossImportedPackages)
    {
        ambiguousAcrossImportedPackages = false;

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

        if (scope.TryLookupTypeAlias(name, preferredArity, out var aliased, out ambiguousAcrossImportedPackages))
        {
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

        if (scope.TryLookupImportedClass(name, declaration: null, out var importedClass))
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
                        ? string.Concat(pkgSyntax.IdentifiersWithDots.Select(t => t.Text))
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

#pragma warning restore SA1202
}
