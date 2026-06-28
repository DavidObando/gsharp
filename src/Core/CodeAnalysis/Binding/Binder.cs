// <copyright file="Binder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
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
    // resolver in OverloadResolution.cs (which is unchanged). Composed
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

    private FunctionSymbol function;

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
        OverloadResolution.UserDefinedImplicitConversionLookup ??= (source, target) =>
            ClrOperatorResolution.TryResolveConversion(source, target, allowExplicit: false, out _, out _);
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="Binder"/> class.
    /// </summary>
    /// <param name="parent">The parent scope.</param>
    /// <param name="function">The function to bind.</param>
    public Binder(BoundScope parent, FunctionSymbol function)
    {
        binderCtx = new BinderContext(parent);
        memberLookup = new MemberLookup(binderCtx);
        conversions = new ConversionClassifier(
            binderCtx,
            memberLookup,
            bindExpression: syntax => expressions.BindExpression(syntax),
            bindExpressionWithTargetType: (syntax, targetType) => expressions.BindExpression(syntax, targetType),
            isFormattableStringTargetType: ExpressionBinder.IsFormattableStringTargetType,
            bindInterpolatedStringAsFormattable: (syntax, targetType) => expressions.BindInterpolatedStringAsFormattable(syntax, targetType),
            createErasedFunctionLiteralAdapter: (literal, targetFunctionType) => lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType),
            isLvalue: ExpressionBinder.IsLvalue,
            getRefKindFromModifier: GetRefKindFromModifier,
            refKindToString: RefKindToString);
        overloads = new OverloadResolver(
            binderCtx,
            memberLookup,
            conversions,
            bindExpression: syntax => expressions.BindExpression(syntax),
            bindExpressionWithTargetType: (syntax, targetType) => expressions.BindExpression(syntax, targetType),
            bindRefArgumentExpression: (refSyntax, parameter) => expressions.BindRefArgumentExpression(refSyntax, parameter),
            tryRebindInlineOutVarPlaceholder: (boundArg, slotSyntax, resolvedParameter, substitutedPointeeType) => expressions.TryRebindInlineOutVarPlaceholder(boundArg, slotSyntax, resolvedParameter, substitutedPointeeType),
            bindTypeClause: BindTypeClause,
            lookupType: LookupType,
            lookupTypeWithArity: LookupType,
            reportObsoleteUseIfApplicable: ReportObsoleteUseIfApplicable,
            tryBindClrConstructorCall: (syntax, out result) => expressions.TryBindClrConstructorCall(syntax, out result),
            tryBindIntrinsicCall: (syntax, out result) => expressions.TryBindIntrinsicCall(syntax, out result),
            tryBindInheritedClrInstanceCall: (BoundExpression receiver, Type importedBaseClr, string methodName, ImmutableArray<BoundExpression> arguments, CallExpressionSyntax ce, out BoundExpression result, Type[] explicitTypeArgs, ImmutableArray<TypeSymbol> typeArgSymbols, ImmutableArray<string> argumentNames) => expressions.TryBindInheritedClrInstanceCall(receiver, importedBaseClr, methodName, arguments, ce, out result, explicitTypeArgs, typeArgSymbols, argumentNames),
            isFormattableStringTargetType: ExpressionBinder.IsFormattableStringTargetType,
            bindInterpolatedStringAsFormattable: (syntax, targetType) => expressions.BindInterpolatedStringAsFormattable(syntax, targetType),
            getRefKindFromModifier: GetRefKindFromModifier,
            refKindToString: RefKindToString,
            createErasedFunctionLiteralAdapter: (literal, targetFunctionType) => lambdas.CreateErasedFunctionLiteralAdapter(literal, targetFunctionType),
            wrapAsTask: t => lambdas.WrapAsTask(t),
            isAsyncIteratorReturnType: IsAsyncIteratorReturnType,
            tryGetFunctionLiteral: LambdaBinder.TryGetFunctionLiteral,
            inferTypeArguments: InferTypeArguments,
            substituteType: SubstituteType,
            satisfiesConstraint: SatisfiesConstraint,
            describeConstraint: DescribeConstraint,
            getCurrentFunction: () => this.function,
            bindLambdaWithTarget: (syntax, targetType) => lambdas.BindLambdaExpression(syntax, targetType),
            bindUserTypeStaticCall: (structSym, ce) => expressions.BindUserTypeStaticCall(structSym, ce));
        patterns = new PatternBinder(
            binderCtx,
            conversions,
            bindExpression: syntax => expressions.BindExpression(syntax),
            bindTypeClause: BindTypeClause,
            isNilLiteral: StatementBinder.IsNilLiteral);
        lambdas = new LambdaBinder(
            binderCtx,
            conversions,
            bindBlockStatement: syntax => statements.BindBlockStatement(syntax),
            bindTypeClause: BindTypeClause,
            bindReturnTypeClause: (syntax, isAsync) => BindReturnTypeClause(syntax, isAsync),
            isAsyncIteratorReturnType: IsAsyncIteratorReturnType,
            resolveClrTypeForGenericArg: ResolveClrTypeForGenericArg,
            getCurrentFunction: () => this.function,
            setCurrentFunction: fn => this.function = fn,
            bindLambdaBodyExpression: syntax => expressions.BindLambdaBodyExpression(syntax));
        statements = new StatementBinder(
            binderCtx,
            conversions,
            patterns,
            bindExpression: (syntax, canBeVoid) => expressions.BindExpression(syntax, canBeVoid),
            bindExpressionWithTargetType: (syntax, targetType) => expressions.BindExpression(syntax, targetType),
            bindTypeClause: BindTypeClause,
            bindLocalVariable: (identifier, isReadOnly, type) => declarations.BindVariableDeclaration(identifier, isReadOnly, type),
            bindLocalVariableWithAccessibility: (identifier, isReadOnly, type, accessibility) => declarations.BindVariableDeclaration(identifier, isReadOnly, type, accessibility),
            bindVariableReference: (name, location) => expressions.BindVariableReference(name, location),
            bindInterpolatedStringAsFormattable: (syntax, targetType) => expressions.BindInterpolatedStringAsFormattable(syntax, targetType),
            isFormattableStringTargetType: ExpressionBinder.IsFormattableStringTargetType,
            isLvalue: ExpressionBinder.IsLvalue,
            isIteratorReturnType: IsIteratorReturnType,
            resolveAccessibility: ResolveAccessibility,
            bindVariableDeclarationAttributes: (annotations, positionDescription) => declarations.BindAttributes(annotations, AttributeTargetKind.Field, VariableDeclarationAllowedTargets, positionDescription, System.AttributeTargets.Field),
            getCurrentFunction: () => this.function,
            bindLambdaWithTargetType: (syntax, targetType) => lambdas.BindLambdaExpression(syntax, targetType));
        declarations = new DeclarationBinder(
            binderCtx,
            conversions,
            bindExpression: syntax => expressions.BindExpression(syntax),
            bindTypeClause: BindTypeClause,
            bindReturnTypeClause: (syntax, isAsync) => BindReturnTypeClause(syntax, isAsync),
            bindTypeOfExpression: syntax => expressions.BindTypeOfExpression(syntax),
            bindArrayCreationExpression: syntax => expressions.BindArrayCreationExpression(syntax),
            resolveAccessibility: ResolveAccessibility,
            lookupType: LookupType,
            getEffectiveArgumentClrType: t => expressions.GetEffectiveArgumentClrType(t),
            isAsyncIteratorReturnType: IsAsyncIteratorReturnType,
            isAsyncSequenceReturnType: IsAsyncSequenceReturnType,
            isPrimitiveTypeName: IsPrimitiveTypeName,
            refKindToString: RefKindToString,
            getCurrentFunction: () => this.function);
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
            bindStatement: syntax => statements.BindStatement(syntax));

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
                    for (var t = receiverStruct; t != null; t = t.BaseClass)
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
            // the enclosing type's first, then the method's own so the latter
            // shadow on name collision.
            var enclosingGenericOwner = (function.ReceiverType ?? function.StaticOwnerType) as StructSymbol;
            var enclosingTypeParams = enclosingGenericOwner?.Definition?.TypeParameters
                ?? enclosingGenericOwner?.TypeParameters
                ?? ImmutableArray<TypeParameterSymbol>.Empty;
            if (!enclosingTypeParams.IsDefaultOrEmpty || function.IsGeneric)
            {
                binderCtx.CurrentTypeParameters = new Dictionary<string, TypeParameterSymbol>();
                foreach (var tp in enclosingTypeParams)
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
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope previous, ImmutableArray<SyntaxTree> syntaxTrees)
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
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver references)
        => BindGlobalScope(previous, syntaxTrees, references, implicitSystemImport: true);

    /// <summary>
    /// Binds a set of syntax trees to the previous global scope, with full control over implicit-import seeding.
    /// </summary>
    /// <param name="previous">The previous global scope.</param>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <param name="references">The reference resolver; <c>null</c> selects <see cref="ReferenceResolver.Default"/>.</param>
    /// <param name="implicitSystemImport">When <c>true</c>, an implicit <c>import System</c> is seeded before user imports are processed.</param>
    /// <returns>The new chained bound global scope.</returns>
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver references, bool implicitSystemImport)
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
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver references, bool implicitSystemImport, ImmutableHashSet<string> preprocessorSymbols)
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
    public static BoundGlobalScope BindGlobalScope(BoundGlobalScope previous, ImmutableArray<SyntaxTree> syntaxTrees, ReferenceResolver references, bool implicitSystemImport, ImmutableHashSet<string> preprocessorSymbols, bool isLibrary)
    {
        var parentScope = CreateParentScope(previous, references, preprocessorSymbols);
        var binder = new Binder(parentScope, function: null);

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
        foreach (var tree in syntaxTrees)
        {
            var packageSyntax = tree.Root.Members.OfType<PackageSyntax>().FirstOrDefault();
            var packageName = packageSyntax != null
                ? string.Concat(packageSyntax.IdentifiersWithDots.Select(t => t.Text))
                : "Default";
            if (!packagesByName.TryGetValue(packageName, out var packageSymbol))
            {
                packageSymbol = new PackageSymbol(packageName, packageSyntax);
                packagesByName[packageName] = packageSymbol;
                packagesInOrder.Add(packageSymbol);
                AttachDocumentation(packageSymbol, packageSyntax);
            }

            packageByTree[tree] = packageSymbol;
        }

        var importDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                 .OfType<ImportSyntax>();
        foreach (var import in importDeclarations)
        {
            binder.BindImport(import);
        }

        var typeAliasDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                               .OfType<TypeAliasDeclarationSyntax>();
        foreach (var typeAlias in typeAliasDeclarations)
        {
            binder.declarations.ValidateTopLevelProtected(typeAlias.AccessibilityModifier);
            binder.declarations.BindTypeAliasDeclaration(typeAlias);
        }

        // ADR-0059 / issue #255: declare named delegate types BEFORE
        // interfaces/structs/enums so that interface methods, struct fields,
        // event handler types, etc. can reference a named delegate by name.
        var delegateDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                              .OfType<DelegateDeclarationSyntax>();
        foreach (var delegateSyntax in delegateDeclarations)
        {
            var owningPackage = packageByTree[delegateSyntax.SyntaxTree];
            binder.declarations.ValidateTopLevelProtected(delegateSyntax.AccessibilityModifier);
            binder.declarations.BindDelegateDeclaration(delegateSyntax, owningPackage);
        }

        var interfaceDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                               .OfType<InterfaceDeclarationSyntax>();

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
            var sym = binder.declarations.DeclareInterfaceSymbol(ifaceSyntax, owningPackage);
            if (sym != null)
            {
                declaredInterfaces.Add((ifaceSyntax, sym));
            }
        }

        var enumDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                           .OfType<EnumDeclarationSyntax>();
        foreach (var enumSyntax in enumDeclarations)
        {
            var owningPackage = packageByTree[enumSyntax.SyntaxTree];
            binder.declarations.ValidateTopLevelProtected(enumSyntax.AccessibilityModifier);
            binder.declarations.BindEnumDeclaration(enumSyntax, owningPackage);
        }

        // Issue #973: declare all struct/class type-name shells first (phase 1),
        // then bind their bodies (phase 2). Splitting declaration from body
        // binding lets a field/parameter/base-clause type forward-reference a
        // user struct or class declared later in the same compilation —
        // e.g. a `class` whose field type is a `struct` declared below it —
        // mirroring the two-phase scheme already used for interfaces above.
        var structDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                            .OfType<StructDeclarationSyntax>();
        var declaredStructs = new List<(StructDeclarationSyntax Syntax, StructSymbol Symbol)>();
        foreach (var structSyntax in structDeclarations)
        {
            var owningPackage = packageByTree[structSyntax.SyntaxTree];
            binder.declarations.ValidateTopLevelProtected(structSyntax.AccessibilityModifier);
            var structSymbol = binder.declarations.DeclareStructShell(structSyntax, owningPackage);
            if (structSymbol != null)
            {
                declaredStructs.Add((structSyntax, structSymbol));

                // Issue #1069: declare the type-name shells of any nested types
                // (recursively) right after the enclosing shell, so a sibling
                // member signature can forward-reference a nested type by name.
                // The bodies are bound later in phase 2 (BindNestedTypeBodies).
                binder.declarations.DeclareNestedTypeShells(structSyntax, structSymbol, owningPackage);
            }
        }

        foreach (var (structSyntax, structSymbol) in declaredStructs)
        {
            var owningPackage = packageByTree[structSyntax.SyntaxTree];
            binder.declarations.BindStructDeclarationBody(structSyntax, owningPackage, structSymbol);
        }

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
            binder.declarations.BindInterfaceMembers(ifaceSyntax, ifaceSymbol, owningPackage);
        }

        var functionDeclarations = syntaxTrees.SelectMany(st => st.Root.Members)
                                              .OfType<FunctionDeclarationSyntax>();
        foreach (var function in functionDeclarations)
        {
            var owningPackage = packageByTree[function.SyntaxTree];
            binder.declarations.ValidateTopLevelProtected(function.AccessibilityModifier);
            binder.declarations.BindFunctionDeclaration(function, owningPackage);
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
            .SelectMany(st => st.Root.Members)
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
        FunctionSymbol synthesizedEntryPoint = null;
        PackageSymbol synthesizedEntryPointPackage = null;
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
            foreach (var globalStatement in globalStatements)
            {
                var statement = tlsBinder.statements.BindStatement(globalStatement.Statement);
                statements.Add(statement);
            }

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
        }

        var imports = binder.scope.GetDeclaredImports();
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
        var entryPoint = ResolveEntryPoint(binder, functions, globalStatements, syntaxTrees, entryPointPackage, synthesizedEntryPoint);

        var diagnostics = binder.Diagnostics.ToImmutableArray();

        if (previous != null)
        {
            diagnostics = diagnostics.InsertRange(0, previous.Diagnostics);
        }

        var delegates = binder.scope.GetDeclaredDelegates();

        var result = new BoundGlobalScope(previous, entryPointPackage, packagesInOrder.ToImmutable(), diagnostics, imports, functions, variables, typeAliases, structs, interfaces, enums, delegates, entryPoint, statements.ToImmutable());
        result.PreprocessorSymbols = preprocessorSymbols ?? ImmutableHashSet<string>.Empty;
        return result;
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
    public static BoundProgram BindProgram(BoundGlobalScope globalScope, ReferenceResolver references = null)
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
    public static BoundProgram BindProgram(BoundGlobalScope globalScope, ReferenceResolver references, BoundBodyCache cache)
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
    public static BoundProgram BindProgram(BoundGlobalScope globalScope, ReferenceResolver references, BoundBodyCache cache, ImmutableHashSet<SyntaxTree> dirtyTrees)
    {
        var parentScope = CreateParentScope(globalScope, references, preprocessorSymbols: globalScope?.PreprocessorSymbols);

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

                var loweredBody = BindBodyWithCache(cache, dirtyTrees, function, function.Declaration.Body, diagnostics, () =>
                {
                    var binder = new Binder(parentScope, function);
                    var body = binder.statements.BindStatement(function.Declaration.Body);
                    var lowered = Lowerer.Lower(body);

                    if (function.Type != TypeSymbol.Void && !IsIteratorReturnType(function.Type) && !ControlFlowGraph.AllPathsReturn(lowered))
                    {
                        binder.Diagnostics.ReportAllPathsMustReturn(function.Declaration.Identifier.Location);
                    }

                    // ADR-0060 items #4/#5: out-parameter definite-assignment and
                    // 'ref'-arg unassigned-before-read checks.
                    RefKindDefiniteAssignmentAnalyzer.Analyze(lowered, function, binder.Diagnostics);

                    return (lowered, binder.Diagnostics.ToImmutableArray());
                });

                functionBodies.Add(function, loweredBody);
            }

            scope = scope.Previous;
        }

        // Phase 3.B.3 sub-step 2b: bind class method bodies. Methods are not
        // in globalScope.Functions (they're addressed via the dot operator),
        // so we walk Structs explicitly here.
        foreach (var structSym in globalScope.Structs)
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

                var loweredBody = BindBodyWithCache(cache, dirtyTrees, method, method.Declaration.Body, diagnostics, () =>
                {
                    var binder = new Binder(parentScope, method);
                    var body = binder.statements.BindStatement(method.Declaration.Body);
                    var lowered = Lowerer.Lower(body, structSym);

                    if (method.Type != TypeSymbol.Void && !IsIteratorReturnType(method.Type) && !ControlFlowGraph.AllPathsReturn(lowered))
                    {
                        binder.Diagnostics.ReportAllPathsMustReturn(method.Declaration.Identifier.Location);
                    }

                    return (lowered, binder.Diagnostics.ToImmutableArray());
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

        // Issue #1030: bind default bodies on static-virtual interface
        // *property* accessors (get_/set_). These mirror the static-virtual
        // method default-body loop above: a default-bodied accessor is a
        // non-abstract Static|Virtual slot whose lowered body is registered in
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
                if (!prop.IsStatic)
                {
                    continue;
                }

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
        // parameters, and the class's fields (via bare names). The body is keyed
        // in functionBodies by the constructor's underlying FunctionSymbol.
        // ADR-0063 §9: a class may declare multiple init(...) constructors; each
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
                if (ctor.IsSynthesizedFromPrimaryConstructor || ctor.Declaration == null)
                {
                    continue;
                }

                var ctorLoweredBody = BindBodyWithCache(cache, dirtyTrees, ctor.Function, ctor.Declaration.Body, diagnostics, () =>
                {
                    var ctorBinder = new Binder(parentScope, ctor.Function);
                    var ctorBody = ctorBinder.statements.BindStatement(ctor.Declaration.Body);

                    // ADR-0065 §2 Rule 3: a `convenience init` body must begin
                    // with a `init(args)` self-delegation expression-statement.
                    if (ctor.IsConvenience)
                    {
                        VerifyConvenienceInitDelegatesFirst(ctor, ctorBody, ctorBinder.Diagnostics);
                    }

                    var lowered = Lowerer.Lower(ctorBody, structSym);
                    return (lowered, ctorBinder.Diagnostics.ToImmutableArray());
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

        return new BoundProgram(globalScope.Package, globalScope.Packages, diagnostics.ToImmutable(), functionBodies.ToImmutable(), globalScope.EntryPoint, statement, globalScope.Structs, globalScope.Interfaces, globalScope.Enums, globals, globalScope.Delegates)
        {
            Imports = globalScope.Imports,
        };
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
        BoundBodyCache cache,
        ImmutableHashSet<SyntaxTree> dirtyTrees,
        FunctionSymbol member,
        SyntaxNode bodySyntax,
        ImmutableArray<Diagnostic>.Builder diagnostics,
        Func<(BoundBlockStatement Body, ImmutableArray<Diagnostic> Diagnostics)> bindAndLower)
    {
        var isDirty = dirtyTrees != null
            && bodySyntax?.SyntaxTree != null
            && dirtyTrees.Contains(bodySyntax.SyntaxTree);

        if (!isDirty
            && cache != null
            && bodySyntax != null
            && cache.TryReuse(member, bodySyntax, out var reusedBody, out var reusedDiagnostics))
        {
            diagnostics.AddRange(reusedDiagnostics);
            return reusedBody;
        }

        var (body, bodyDiagnostics) = bindAndLower();
        diagnostics.AddRange(bodyDiagnostics);
        cache?.Store(member, bodySyntax, body, bodyDiagnostics);
        return body;
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
        BoundBodyCache cache,
        ImmutableHashSet<SyntaxTree> dirtyTrees,
        BoundScope parentScope,
        FunctionSymbol method,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functionBodies,
        ImmutableArray<Diagnostic>.Builder diagnostics)
    {
        var loweredBody = BindBodyWithCache(cache, dirtyTrees, method, method.Declaration.Body, diagnostics, () =>
        {
            var binder = new Binder(parentScope, method);
            var body = binder.statements.BindStatement(method.Declaration.Body);
            var lowered = Lowerer.Lower(body);

            if (method.Type != TypeSymbol.Void && !IsIteratorReturnType(method.Type) && !ControlFlowGraph.AllPathsReturn(lowered))
            {
                binder.Diagnostics.ReportAllPathsMustReturn(method.Declaration.Identifier.Location);
            }

            return (lowered, binder.Diagnostics.ToImmutableArray());
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
        BoundBodyCache cache,
        ImmutableHashSet<SyntaxTree> dirtyTrees,
        BoundScope parentScope,
        FunctionSymbol accessor,
        BlockStatementSyntax bodySyntax,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functionBodies,
        ImmutableArray<Diagnostic>.Builder diagnostics,
        bool requireAllPathsReturn)
    {
        var loweredBody = BindBodyWithCache(cache, dirtyTrees, accessor, bodySyntax, diagnostics, () =>
        {
            var binder = new Binder(parentScope, accessor);
            var body = binder.statements.BindStatement(bodySyntax);
            var lowered = Lowerer.Lower(body);

            if (requireAllPathsReturn && !ControlFlowGraph.AllPathsReturn(lowered))
            {
                binder.Diagnostics.ReportAllPathsMustReturn(bodySyntax.OpenBraceToken.Location);
            }

            return (lowered, binder.Diagnostics.ToImmutableArray());
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
        BoundBodyCache cache,
        ImmutableHashSet<SyntaxTree> dirtyTrees,
        BoundScope parentScope,
        FunctionSymbol member,
        StatementSyntax bodySyntax,
        StructSymbol structSym,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functionBodies,
        ImmutableArray<Diagnostic>.Builder diagnostics,
        TextLocation? allPathsReturnLocation = null)
    {
        var loweredBody = BindBodyWithCache(cache, dirtyTrees, member, bodySyntax, diagnostics, () =>
        {
            var binder = new Binder(parentScope, member);
            var body = binder.statements.BindStatement(bodySyntax);
            var lowered = Lowerer.Lower(body, structSym);

            if (allPathsReturnLocation != null && !ControlFlowGraph.AllPathsReturn(lowered))
            {
                binder.Diagnostics.ReportAllPathsMustReturn(allPathsReturnLocation.Value);
            }

            return (lowered, binder.Diagnostics.ToImmutableArray());
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
        BoundBodyCache cache,
        ImmutableHashSet<SyntaxTree> dirtyTrees,
        BoundScope parentScope,
        FunctionSymbol method,
        StructSymbol structSym,
        ImmutableDictionary<FunctionSymbol, BoundBlockStatement>.Builder functionBodies,
        ImmutableArray<Diagnostic>.Builder diagnostics)
    {
        var loweredBody = BindBodyWithCache(cache, dirtyTrees, method, method.Declaration.Body, diagnostics, () =>
        {
            var binder = new Binder(parentScope, method);
            var body = binder.statements.BindStatement(method.Declaration.Body);
            var lowered = Lowerer.Lower(body, structSym);

            if (method.Type != TypeSymbol.Void && !IsIteratorReturnType(method.Type) && !ControlFlowGraph.AllPathsReturn(lowered))
            {
                binder.Diagnostics.ReportAllPathsMustReturn(method.Declaration.Identifier.Location);
            }

            return (lowered, binder.Diagnostics.ToImmutableArray());
        });

        functionBodies.Add(method, loweredBody);
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
    public static TypeSymbol TryInferExpressionType(
        BoundGlobalScope globalScope,
        ReferenceResolver references,
        FunctionSymbol containingFunction,
        IEnumerable<VariableSymbol> additionalLocals,
        ExpressionSyntax expression)
    {
        if (globalScope == null || expression == null)
        {
            return null;
        }

        try
        {
            var parentScope = CreateParentScope(globalScope, references, globalScope.PreprocessorSymbols);
            var binder = new Binder(parentScope, containingFunction);

            if (additionalLocals != null)
            {
                foreach (var local in additionalLocals)
                {
                    if (local != null)
                    {
                        // Speculative binding: collisions with already-declared
                        // parameters are expected and harmless (TryDeclareVariable
                        // simply reports false).
                        binder.scope.TryDeclareVariable(local);
                    }
                }
            }

            // The binder writes any diagnostics into its own throwaway bag, so
            // speculative binding never leaks errors into the open document.
            var bound = binder.expressions.BindExpression(expression);
            var type = bound?.Type;
            return type == null || ReferenceEquals(type, TypeSymbol.Error) || ReferenceEquals(type, TypeSymbol.Void)
                ? null
                : type;
        }
        catch (Exception)
        {
            // Inference must never throw into the editor pipeline.
            return null;
        }
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
        ReturnStatementSyntax firstBare = null;
        ReturnStatementSyntax firstValue = null;
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
        ref ReturnStatementSyntax firstBare,
        ref ReturnStatementSyntax firstValue,
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

        if (node is AwaitExpressionSyntax)
        {
            awaitFound = true;

            // Await operands may themselves contain returns/awaits that
            // belong to the entry point — fall through to recurse.
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

    private static BoundScope CreateParentScope(BoundGlobalScope previous, ReferenceResolver references, ImmutableHashSet<string> preprocessorSymbols)
    {
        var stack = new Stack<BoundGlobalScope>();
        while (previous != null)
        {
            stack.Push(previous);
            previous = previous.Previous;
        }

        var parent = CreateRootScope(references, preprocessorSymbols);

        while (stack.Count > 0)
        {
            previous = stack.Pop();
            var scope = new BoundScope(parent);

            foreach (var i in previous.Imports)
            {
                scope.TryImport(i);
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

    private static BoundScope CreateRootScope(ReferenceResolver references, ImmutableHashSet<string> preprocessorSymbols)
    {
        var result = new BoundScope(parent: null, references: references, preprocessorSymbols: preprocessorSymbols);

        foreach (var f in BuiltinFunctions.GetAll())
        {
            result.TryDeclareFunction(f);
        }

        return result;
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

    private static Accessibility ResolveAccessibility(SyntaxToken modifier)
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

    private TypeSymbol BindNonNullableTypeClause(TypeClauseSyntax syntax)
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
            var paramTypes = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.FunctionParameterTypes.Count);
            for (var i = 0; i < syntax.FunctionParameterTypes.Count; i++)
            {
                var pt = BindTypeClause(syntax.FunctionParameterTypes[i]);
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
                        syntax.ManagedFunctionPointerStarToken.Location);
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
            var paramTypes = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.FunctionParameterTypes.Count);
            var variadicFlagsBuilder = ImmutableArray.CreateBuilder<bool>(syntax.FunctionParameterTypes.Count);
            var anyVariadic = false;
            var firstVariadicSeen = false;
            for (var i = 0; i < syntax.FunctionParameterTypes.Count; i++)
            {
                var paramSyntax = syntax.FunctionParameterTypes[i];
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
                    if (i < syntax.FunctionParameterTypes.Count - 1)
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

            var ret = syntax.ReturnTypeClause != null ? BindTypeClause(syntax.ReturnTypeClause) : TypeSymbol.Void;
            if (ret == null)
            {
                return null;
            }

            if (syntax.IsAsyncFunction)
            {
                if (IsTaskShapedReturn(ret))
                {
                    Diagnostics.ReportAsyncFunctionTypeClauseHasExplicitTaskReturn(
                        syntax.ReturnTypeClause.Location,
                        ret.Name);
                    return null;
                }

                // ADR-0041 iterator carve-out — same logic as
                // BindReturnTypeClause(isAsync=true) at function declarations.
                if (ret is SequenceTypeSymbol seq)
                {
                    ret = AsyncSequenceTypeSymbol.Get(seq.ElementType);
                }
                else if (ret is NullableTypeSymbol nt && nt.UnderlyingType is SequenceTypeSymbol innerSeq)
                {
                    ret = NullableTypeSymbol.Get(AsyncSequenceTypeSymbol.Get(innerSeq.ElementType));
                }
                else if (!IsAsyncIteratorReturnType(ret))
                {
                    ret = lambdas.WrapAsTask(ret);
                }
            }

            var variadicFlags = anyVariadic ? variadicFlagsBuilder.MoveToImmutable() : default;
            return FunctionTypeSymbol.Get(paramTypes.MoveToImmutable(), variadicFlags, ret ?? TypeSymbol.Void);
        }

        if (syntax.IsTuple)
        {
            // Phase 4.5: tuple type clause `(T1, T2, ...)`.
            if (syntax.TupleElements.Count < 2)
            {
                Diagnostics.ReportUnexpectedToken(syntax.CloseParenToken.Location, syntax.CloseParenToken.Kind, SyntaxKind.IdentifierToken);
                return null;
            }

            var elements = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.TupleElements.Count);
            for (var i = 0; i < syntax.TupleElements.Count; i++)
            {
                var elementType = BindTypeClause(syntax.TupleElements[i]);
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
            // ADR-0104: map type clause `map[K,V]`.
            var keyType = BindTypeClause(syntax.MapKeyType);
            var valueType = BindTypeClause(syntax.MapValueType);
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
            binderCtx.ReportIfGoExtensionsImportMissing(syntax, syntax.ChanKeyword.Location, "chan");

            var elementType = BindTypeClause(syntax.ChanElementType);
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
                    && !BlittableDetector.IsBlittableValueStructPointee(pointeeType))
                {
                    // ADR-0122 §4 / issue #1034: a pointer to a blittable user
                    // struct (`*Point`) is legal — accepted by the
                    // BlittableDetector check above. A pointer to a non-blittable
                    // struct (one that contains a managed reference / string /
                    // class field) or to any managed reference type is still
                    // rejected here with GS0398, matching C#'s unmanaged-type rule.
                    Diagnostics.ReportUnmanagedPointerIllegalPointee(syntax.PointerPointeeType.Location, pointeeType.Name);
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
        if (!syntax.HasQualifier &&
            syntax.HasTypeArguments &&
            scope.TryLookupImportedGenericClass(syntax.Identifier.Text, syntax.TypeArguments.Count, out var clrOpenType))
        {
            var clrArgs = new System.Type[syntax.TypeArguments.Count];
            var symbolicArgs = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.TypeArguments.Count);
            var hasTypeParameterArg = false;
            for (var i = 0; i < syntax.TypeArguments.Count; i++)
            {
                var ta = BindTypeClause(syntax.TypeArguments[i]);
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
                    var taLocation = syntax.TypeArguments[i].Identifier?.Location ?? syntax.Identifier.Location;
                    Diagnostics.ReportByRefLikeEscape(taLocation, ta, "be used as a generic type argument");
                    return null;
                }

                // #313: an in-scope generic type parameter used as a type
                // argument (e.g. `List[T]` inside `func First[T](...)`) is a
                // valid type in any position. Under the type-erased generic
                // model (ADR-0004; type parameters encode as System.Object at
                // emit) the type argument projects onto `object` for the closed
                // CLR shape so member / index / conversion resolution keeps
                // working, while the symbolic `[T]` is preserved on the result
                // for inference, substitution, and erased emit.
                if (TypeSymbol.ContainsTypeParameter(ta))
                {
                    hasTypeParameterArg = true;
                    clrArgs[i] = scope.References.MapClrTypeToReferences(typeof(object));
                    continue;
                }

                // Issue #671: a user-defined G# type (class, struct,
                // interface, enum, delegate) used as a type argument to a CLR
                // generic has no ClrType at bind time — the CLR TypeDef is only
                // produced during emit. Handle the same way as type parameters:
                // project onto System.Object for the closed CLR shape and
                // preserve the symbolic argument via GetConstructed so the
                // emitter can recover the real type.
                if (ta.ClrType == null)
                {
                    hasTypeParameterArg = true;
                    clrArgs[i] = scope.References.MapClrTypeToReferences(typeof(object));
                    continue;
                }

                // Project host CLR type arguments onto the resolver's reference
                // set so they share clrOpenType's load context (its
                // MetadataLoadContext when references are supplied via /r:),
                // which MakeGenericType requires.
                // Issue #530: use ResolveClrTypeForGenericArg so that
                // `int32?` resolves to `Nullable<int>` (not bare `int`).
                clrArgs[i] = ResolveClrTypeForGenericArg(ta) ?? scope.References.MapClrTypeToReferences(ta.ClrType);
            }

            try
            {
                var closed = clrOpenType.MakeGenericType(clrArgs);
                if (hasTypeParameterArg)
                {
                    // #313 / #671: keep the symbolic type arguments alongside
                    // the type-erased closed CLR shape so call-site inference,
                    // return-type substitution, and user-type emit can recover
                    // the real type argument.
                    return ApplyArraySuffix(syntax, ImportedTypeSymbol.GetConstructed(closed, clrOpenType, symbolicArgs.MoveToImmutable()));
                }

                return ApplyArraySuffix(syntax, TypeSymbol.FromClrType(closed));
            }
            catch (System.ArgumentException)
            {
                Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.Identifier.Text);
                return null;
            }
        }

        TypeSymbol element;
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
            ReportObsoleteUseIfApplicable(syntax.Identifier.Location, element, element.Name);

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
            var requestedArity = syntax.HasTypeArguments ? syntax.TypeArguments.Count : 0;
            element = LookupType(syntax.Identifier.Text, requestedArity);
            if (element == null)
            {
                Diagnostics.ReportUndefinedType(syntax.Identifier.Location, syntax.Identifier.Text);
                return null;
            }

            // ADR-0047 §6 / #175: report obsolete-use for any named struct,
            // class, interface, or enum reference appearing in type position
            // (parameter types, return types, field types, generic-argument
            // positions, type aliases, etc.).
            ReportObsoleteUseIfApplicable(syntax.Identifier.Location, element, element.Name);

            // Phase 4.3c / ADR-0020: handle generic type construction `Foo[T1, T2]` in
            // type position (currently interfaces; structs follow up later).
            if (syntax.HasTypeArguments)
            {
                var typeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.TypeArguments.Count);
                for (var i = 0; i < syntax.TypeArguments.Count; i++)
                {
                    var ta = BindTypeClause(syntax.TypeArguments[i]);
                    if (ta == null)
                    {
                        return null;
                    }

                    // Issue #367: by-ref-like (`ref struct`) types are not permitted
                    // as generic type arguments to a user-defined generic type.
                    if (TypeSymbol.IsByRefLike(ta))
                    {
                        var taLocation = syntax.TypeArguments[i].Identifier?.Location ?? syntax.Identifier.Location;
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
                        Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.Identifier.Text);
                        return null;
                    }

                    if (iface.TypeParameters.Length != typeArgs.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(syntax.Identifier.Location, syntax.Identifier.Text, iface.TypeParameters.Length, typeArgs.Length);
                        return null;
                    }

                    element = InterfaceSymbol.Construct(iface, typeArgs);
                }
                else if (element is StructSymbol genericStruct)
                {
                    if (!genericStruct.IsGenericDefinition)
                    {
                        Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.Identifier.Text);
                        return null;
                    }

                    if (genericStruct.TypeParameters.Length != typeArgs.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(syntax.Identifier.Location, syntax.Identifier.Text, genericStruct.TypeParameters.Length, typeArgs.Length);
                        return null;
                    }

                    element = StructSymbol.Construct(genericStruct, typeArgs);
                }
                else
                {
                    Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.Identifier.Text);
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
    private TypeSymbol ApplyArraySuffix(TypeClauseSyntax syntax, TypeSymbol element)
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

        if (!int.TryParse(syntax.LengthToken.Text, out var length) || length < 0)
        {
            Diagnostics.ReportInvalidArrayLength(syntax.LengthToken.Location, syntax.LengthToken.Text);
            return null;
        }

        return ArrayTypeSymbol.Get(element, length);
    }

    private TypeSymbol BindTypeClause(TypeClauseSyntax syntax)
    {
        var bound = BindNonNullableTypeClause(syntax);
        if (bound == null)
        {
            return bound;
        }

        // Issue #1212: for an array/slice clause the trailing `?` is consumed
        // by ApplyArraySuffix and applied to the element type (`[]T?`), so it
        // must not also wrap the whole array. The *array* is made nullable only
        // by an explicit `?` right after `]` (`[]?T` → `ArrayQuestionToken`).
        if (syntax.IsArray)
        {
            return syntax.IsArrayNullable ? NullableTypeSymbol.Get(bound) : bound;
        }

        if (!syntax.IsNullable)
        {
            return bound;
        }

        return NullableTypeSymbol.Get(bound);
    }

    /// <summary>
    /// Issue #526: resolves a dotted-qualifier type clause (<c>Outer.Inner</c>,
    /// <c>A.B.C</c>) to a <see cref="TypeSymbol"/> wrapping a (possibly nested)
    /// CLR type.
    /// <para>
    /// Strategy: enumerate "split points" between an outer prefix that is a
    /// fully-qualified type name and the remaining segments that name nested
    /// types of that outer. The longest viable outer prefix wins, which lets
    /// callers write both <c>Outer.Inner</c> (with <c>import Probe.CSharp</c>
    /// providing the namespace prefix) and the fully-qualified
    /// <c>Probe.CSharp.Outer.Inner</c>. Type arguments on the clause attach to
    /// the deepest (last) segment so a nested generic such as
    /// <c>Outer.Generic[int]</c> resolves to the constructed
    /// <c>Outer.Generic`1</c> closed type.
    /// </para>
    /// <para>
    /// TODO(issue-526): per-segment type-argument syntax (e.g.
    /// <c>Outer[T].Inner</c>) is not yet expressible in the grammar — a single
    /// trailing <c>[…]</c> attaches to the last segment only. Adding mid-chain
    /// type-argument lists requires extending <see cref="TypeClauseSyntax"/>
    /// and the parser to record arguments per qualifier segment; deferred to a
    /// follow-up while keeping the non-generic and deepest-generic cases
    /// working end-to-end.
    /// </para>
    /// </summary>
    /// <summary>
    /// Issue #1069: returns the enclosing type of a (possibly nested) user type
    /// symbol — the value set via <c>SetContainingType</c> during declaration
    /// binding — or <c>null</c> for a top-level type or a non-aggregate symbol.
    /// </summary>
    private static TypeSymbol SymbolContainingType(TypeSymbol type) => type switch
    {
        StructSymbol s => s.ContainingType,
        EnumSymbol e => e.ContainingType,
        InterfaceSymbol i => i.ContainingType,
        _ => null,
    };

    /// <summary>
    /// Issue #1069: resolves a dotted type clause (<c>Outer.Entry</c>,
    /// <c>Outer.Middle.Inner</c>) to a user-defined nested type declared in the
    /// current compilation, by walking the enclosing-type chain. Each segment
    /// after the first must name a type whose enclosing type is the symbol
    /// resolved for the preceding segment. Returns <c>null</c> when the chain
    /// does not resolve to such a user nested type, letting the caller fall back
    /// to the reflection-based CLR nested-type walk. Type arguments on the
    /// deepest segment construct the closed generic type; array suffixes are
    /// applied by the caller.
    /// </summary>
    private TypeSymbol TryResolveUserNestedTypeChain(TypeClauseSyntax syntax, string[] segmentTexts)
    {
        if (segmentTexts.Length < 2)
        {
            return null;
        }

        var current = LookupType(segmentTexts[0]);
        if (current == null)
        {
            return null;
        }

        for (var i = 1; i < segmentTexts.Length; i++)
        {
            // Issue #1174: resolve each non-head segment as a nested type of the
            // previously-resolved container, NOT by global simple name. A bare
            // simple-name lookup returns a same-named top-level homonym, which
            // then fails the containment check and breaks `Container.Nested`
            // references. Only the deepest segment carries the clause's type
            // arguments, so it drives the preferred arity.
            var preferredArity = (i == segmentTexts.Length - 1 && syntax.HasTypeArguments)
                ? syntax.TypeArguments.Count
                : -1;
            if (!scope.TryLookupNestedTypeAlias(current, segmentTexts[i], preferredArity, out var nested))
            {
                return null;
            }

            current = nested;
        }

        if (!syntax.HasTypeArguments)
        {
            return current;
        }

        // Construct the closed generic for the deepest (named) segment.
        var typeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.TypeArguments.Count);
        foreach (var taSyntax in syntax.TypeArguments)
        {
            var ta = BindTypeClause(taSyntax);
            if (ta == null)
            {
                return null;
            }

            if (TypeSymbol.IsByRefLike(ta))
            {
                Diagnostics.ReportByRefLikeEscape(taSyntax.Identifier?.Location ?? syntax.Identifier.Location, ta, "be used as a generic type argument");
                return null;
            }

            typeArgsBuilder.Add(ta);
        }

        var typeArgs = typeArgsBuilder.MoveToImmutable();
        switch (current)
        {
            case StructSymbol genericStruct when genericStruct.IsGenericDefinition && genericStruct.TypeParameters.Length == typeArgs.Length:
                return StructSymbol.Construct(genericStruct, typeArgs);
            case InterfaceSymbol genericIface when genericIface.IsGenericDefinition && genericIface.TypeParameters.Length == typeArgs.Length:
                return InterfaceSymbol.Construct(genericIface, typeArgs);
            default:
                Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.DottedName);
                return null;
        }
    }

    private TypeSymbol BindQualifiedTypeName(TypeClauseSyntax syntax)
    {
        var totalSegments = 1 + syntax.QualifierIdentifierTokens.Length;
        var segmentTexts = new string[totalSegments];
        segmentTexts[0] = syntax.Identifier.Text;
        for (var i = 0; i < syntax.QualifierIdentifierTokens.Length; i++)
        {
            segmentTexts[1 + i] = syntax.QualifierIdentifierTokens[i].Text;
        }

        var targetArity = syntax.HasTypeArguments ? syntax.TypeArguments.Count : 0;

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

        // Greedy: prefer the longest outer prefix that resolves to a real type,
        // then walk the remaining segments as nested types. Going longest-first
        // lets a fully-qualified `Probe.CSharp.Outer` win without being misled
        // by a single-name `Probe` that happens to exist somewhere.
        for (var outerLen = totalSegments; outerLen >= 1; outerLen--)
        {
            var clrType = TryResolveOuterPrefix(segmentTexts, outerLen);
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

        // Could not resolve. Pinpoint the failing segment so the diagnostic is
        // actionable: if even the outermost simple name doesn't exist, report
        // a regular "undefined type". Otherwise walk from the outermost
        // resolvable segment and emit "Outer does not contain a nested type
        // 'X'" for the first failing segment.
        var outermost = LookupType(syntax.Identifier.Text);
        if (outermost == null)
        {
            Diagnostics.ReportUndefinedType(syntax.Identifier.Location, syntax.DottedName);
            return null;
        }

        var current = outermost.ClrType;
        if (current == null)
        {
            // Outer is a built-in / GSharp-defined type with no CLR
            // representation reachable here; just report it as undefined.
            Diagnostics.ReportUndefinedType(syntax.Identifier.Location, syntax.DottedName);
            return null;
        }

        var lastGoodName = syntax.Identifier.Text;
        for (var i = 0; i < syntax.QualifierIdentifierTokens.Length; i++)
        {
            var segmentText = syntax.QualifierIdentifierTokens[i].Text;
            var isLast = i == syntax.QualifierIdentifierTokens.Length - 1;
            Type next = null;
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
        Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.DottedName);
        return null;
    }

    /// <summary>
    /// Issue #526: resolves the first <paramref name="outerLen"/> segments of
    /// <paramref name="segmentTexts"/> joined by <c>.</c> to a single CLR
    /// type. Honors aliases and the active import set for one-segment
    /// prefixes, and the active import set as a namespace prefix for
    /// multi-segment prefixes.
    /// </summary>
    private Type TryResolveOuterPrefix(string[] segmentTexts, int outerLen)
    {
        if (outerLen == 1)
        {
            var symbol = LookupType(segmentTexts[0]);
            return symbol?.ClrType;
        }

        var prefix = string.Join(".", segmentTexts, 0, outerLen);
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
    private Type WalkNestedSegments(Type container, string[] segmentTexts, int start, int end, int targetArity)
    {
        var current = container;
        for (var i = start; i < end; i++)
        {
            var name = segmentTexts[i];
            var isLast = i == end - 1;
            Type next = null;
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
    private TypeSymbol ConstructIfGeneric(Type clrType, TypeClauseSyntax syntax, int targetArity)
    {
        if (targetArity == 0)
        {
            return TypeSymbol.FromClrType(clrType);
        }

        if (!clrType.IsGenericTypeDefinition)
        {
            Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.DottedName);
            return null;
        }

        var clrArgs = new Type[targetArity];
        var symbolicArgs = ImmutableArray.CreateBuilder<TypeSymbol>(targetArity);
        var hasTypeParameterArg = false;
        for (var i = 0; i < targetArity; i++)
        {
            var ta = BindTypeClause(syntax.TypeArguments[i]);
            if (ta == null)
            {
                return null;
            }

            symbolicArgs.Add(ta);

            // Issue #367: by-ref-like types cannot serve as generic arguments.
            if (TypeSymbol.IsByRefLike(ta))
            {
                var taLocation = syntax.TypeArguments[i].Identifier?.Location ?? syntax.Identifier.Location;
                Diagnostics.ReportByRefLikeEscape(taLocation, ta, "be used as a generic type argument");
                return null;
            }

            // #313: in-scope type parameters project onto System.Object under
            // the type-erased generic model so the closed CLR shape is well
            // formed while the symbolic argument is preserved alongside.
            if (TypeSymbol.ContainsTypeParameter(ta))
            {
                hasTypeParameterArg = true;
                clrArgs[i] = scope.References.MapClrTypeToReferences(typeof(object));
                continue;
            }

            // Issue #671: user-defined types without a ClrType project onto
            // System.Object (same as type parameters above).
            if (ta.ClrType == null)
            {
                hasTypeParameterArg = true;
                clrArgs[i] = scope.References.MapClrTypeToReferences(typeof(object));
                continue;
            }

            clrArgs[i] = ResolveClrTypeForGenericArg(ta) ?? scope.References.MapClrTypeToReferences(ta.ClrType);
        }

        try
        {
            var closed = clrType.MakeGenericType(clrArgs);
            if (hasTypeParameterArg)
            {
                return ImportedTypeSymbol.GetConstructed(closed, clrType, symbolicArgs.MoveToImmutable());
            }

            return TypeSymbol.FromClrType(closed);
        }
        catch (System.ArgumentException)
        {
            Diagnostics.ReportTypeNotGeneric(syntax.Identifier.Location, syntax.DottedName);
            return null;
        }
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
    private TypeSymbol BindReturnTypeClause(TypeClauseSyntax syntax, bool isAsync)
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

        if (bound is NullableTypeSymbol nt && nt.UnderlyingType is SequenceTypeSymbol innerSeq)
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

        string fullName;
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
        if (firstNonNoOp is BoundExpressionStatement exprStmt
            && exprStmt.Expression is BoundConstructorChainingExpression)
        {
            return;
        }

        diagnostics.ReportConvenienceInitMustDelegate(location, ctor.DeclaringType?.Name ?? "?");
    }

    /// <summary>
    /// ADR-0065 §2: recursively descends into a single-statement block to find
    /// the first effective top-level statement. Used by
    /// <see cref="VerifyConvenienceInitDelegatesFirst"/> to allow trivial
    /// pre-pass wrapping (e.g. statements injected by lowering passes added
    /// at a later date) without giving up on the chaining check.
    /// </summary>
    private static BoundStatement FindFirstSignificantStatement(BoundStatement statement)
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
    private static RefKind GetRefKindFromModifier(SyntaxToken modifier)
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
            // First seen value wins. Cross-arg consistency is verified later
            // by the post-substitution argument-type check.
            if (!substitution.ContainsKey(tp))
            {
                substitution[tp] = argumentType;
            }

            return;
        }

        if (parameterType is NullableTypeSymbol pn && argumentType is NullableTypeSymbol an)
        {
            InferTypeArguments(pn.UnderlyingType, an.UnderlyingType, substitution);
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
            // The CLR-level inference path (OverloadResolution.UnifyForInference)
            // handles this differently because both map to CLR T[], but at the
            // GSharp semantic level they are distinct types.
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
        else if (parameterType is ImportedTypeSymbol pit && pit.HasTypeParameterArgument)
        {
            // #313: infer from a generic type parameterized by an in-scope type
            // parameter (e.g. parameter `List[T]` matched against argument
            // `List<int32>`). Unify the symbolic type arguments positionally
            // against the argument's CLR generic arguments.
            var argClrArgs = GetClrGenericArguments(argumentType);
            if (!argClrArgs.IsDefaultOrEmpty && argClrArgs.Length == pit.TypeArguments.Length)
            {
                for (var i = 0; i < pit.TypeArguments.Length; i++)
                {
                    InferTypeArguments(pit.TypeArguments[i], argClrArgs[i], substitution);
                }
            }
            else if (argClrArgs.IsDefaultOrEmpty)
            {
                // #611: slice/array → interface inference. A slice `[]T` or
                // fixed-array `[N]T` is backed by CLR `T[]` which is not
                // generic itself but implements generic interfaces
                // (IEnumerable<T>, IReadOnlyList<T>, IList<T>, etc.). Walk
                // the array's interface set to find a match for the
                // parameter's open definition and extract its arguments.
                var argClr = argumentType?.ClrType;
                if (argClr != null && argClr.IsArray && pit.OpenDefinition != null)
                {
                    var matched = FindMatchingInterface(argClr, pit.OpenDefinition);
                    if (matched != null)
                    {
                        var matchedArgs = matched.GetGenericArguments();
                        if (matchedArgs.Length == pit.TypeArguments.Length)
                        {
                            for (var i = 0; i < pit.TypeArguments.Length; i++)
                            {
                                InferTypeArguments(pit.TypeArguments[i], TypeSymbol.FromClrType(matchedArgs[i]), substitution);
                            }
                        }
                    }
                }
            }
        }
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
    private static Type FindMatchingInterface(Type clrType, Type openDefinition)
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

    internal static TypeSymbol SubstituteType(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        if (type is TypeParameterSymbol tp)
        {
            return substitution.TryGetValue(tp, out var concrete) ? concrete : type;
        }

        if (type is NullableTypeSymbol n)
        {
            var inner = SubstituteType(n.UnderlyingType, substitution);
            return ReferenceEquals(inner, n.UnderlyingType) ? type : NullableTypeSymbol.Get(inner);
        }

        if (type is SliceTypeSymbol s)
        {
            var inner = SubstituteType(s.ElementType, substitution);
            return ReferenceEquals(inner, s.ElementType) ? type : SliceTypeSymbol.Get(inner);
        }

        if (type is ArrayTypeSymbol a)
        {
            var inner = SubstituteType(a.ElementType, substitution);
            return ReferenceEquals(inner, a.ElementType) ? type : ArrayTypeSymbol.Get(inner, a.Length);
        }

        if (type is SequenceTypeSymbol seq)
        {
            // Issue #773: substitute through `sequence[T]` so the open
            // receiver of a generic extension lowers to a concrete
            // `sequence[U]` at the call site (and downstream
            // `BindExtensionFunctionCall` sees a matching parameter type).
            var inner = SubstituteType(seq.ElementType, substitution);
            return ReferenceEquals(inner, seq.ElementType) ? type : SequenceTypeSymbol.Get(inner);
        }

        if (type is AsyncSequenceTypeSymbol aseq)
        {
            var inner = SubstituteType(aseq.ElementType, substitution);
            return ReferenceEquals(inner, aseq.ElementType) ? type : AsyncSequenceTypeSymbol.Get(inner);
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
                var substituted = SubstituteType(elem, substitution);
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
                var substituted = SubstituteType(paramType, substitution);
                changed |= !ReferenceEquals(substituted, paramType);
                builder.Add(substituted);
            }

            var substitutedReturn = SubstituteType(fn.ReturnType, substitution);
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
            var newStructArgs = ImmutableArray.CreateBuilder<TypeSymbol>(ss.TypeArguments.Length);
            var structChanged = false;
            foreach (var arg in ss.TypeArguments)
            {
                var substituted = SubstituteType(arg, substitution);
                structChanged |= !ReferenceEquals(substituted, arg);
                newStructArgs.Add(substituted);
            }

            return structChanged
                ? StructSymbol.Construct(ss.Definition, newStructArgs.MoveToImmutable())
                : type;
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
                var substituted = SubstituteType(arg, substitution);
                ifaceChanged |= !ReferenceEquals(substituted, arg);
                newIfaceArgs.Add(substituted);
            }

            return ifaceChanged
                ? InterfaceSymbol.Construct(ifaceType.Definition, newIfaceArgs.MoveToImmutable())
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
                var substituted = SubstituteType(arg, substitution);
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
                    var clr = substitutedArgs[i].ClrType;
                    if (clr == null)
                    {
                        allClr = false;
                        break;
                    }

                    clrArgs[i] = clr;
                }

                if (allClr)
                {
                    try
                    {
                        return TypeSymbol.FromClrType(it.OpenDefinition.MakeGenericType(clrArgs));
                    }
                    catch (System.ArgumentException)
                    {
                        // Fall through to the erased constructed form below.
                    }
                }
            }

            return ImportedTypeSymbol.GetConstructed(it.ClrType, it.OpenDefinition, substitutedArgs);
        }

        return type;
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
            // Propagate: if the source type parameter carries `class`, so
            // does this substitution.
            return tp.HasReferenceTypeConstraint;
        }

        if (type is StructSymbol structSym)
        {
            return structSym.IsClass;
        }

        if (type is InterfaceSymbol || type is FunctionTypeSymbol || type is DelegateTypeSymbol
            || type is ArrayTypeSymbol || type is SliceTypeSymbol || type is MapTypeSymbol
            || type is ChannelTypeSymbol || type is SequenceTypeSymbol || type is AsyncSequenceTypeSymbol)
        {
            return true;
        }

        if (type == TypeSymbol.String)
        {
            return true;
        }

        if (type is ImportedTypeSymbol it && it.ClrType is { } clr)
        {
            return !clr.IsValueType;
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
        var constraintArgs = (constraint as ImportedTypeSymbol)?.TypeArguments ?? ImmutableArray<TypeSymbol>.Empty;

        foreach (var candidate in EnumerateSelfAndInterfaces(typeArgClr))
        {
            if (!candidate.IsGenericType
                || !string.Equals(candidate.GetGenericTypeDefinition().FullName, openDefName, StringComparison.Ordinal))
            {
                continue;
            }

            if (GenericConstraintArgumentsMatch(candidate.GetGenericArguments(), constraintArgs, tp, typeArgClr))
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

        foreach (var i in type.GetInterfaces())
        {
            yield return i;
        }
    }

    private static bool GenericConstraintArgumentsMatch(
        Type[] candidateArgs,
        ImmutableArray<TypeSymbol> constraintArgs,
        TypeParameterSymbol tp,
        Type typeArgClr)
    {
        if (constraintArgs.IsDefaultOrEmpty || candidateArgs.Length != constraintArgs.Length)
        {
            return false;
        }

        for (var i = 0; i < candidateArgs.Length; i++)
        {
            // A self-referential constraint argument (the constrained parameter
            // itself) is expected to be the type argument; any other argument is
            // matched against its own resolved CLR type.
            var expectedName = constraintArgs[i] is TypeParameterSymbol cArgTp && ReferenceEquals(cArgTp, tp)
                ? typeArgClr.FullName
                : constraintArgs[i].ClrType?.FullName;

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
            flags.Add(tp.InterfaceConstraint.Name);
        }

        if (tp.ClrInterfaceConstraint != null)
        {
            flags.Add(tp.ClrInterfaceConstraint.Name);
        }

        if (tp.ClassConstraint != null)
        {
            flags.Add(tp.ClassConstraint.Name);
        }

        if (tp.Constraint == TypeParameterConstraint.Comparable)
        {
            flags.Add("comparable");
        }

        if (tp.HasReferenceTypeConstraint)
        {
            flags.Add("class");
        }

        if (tp.HasValueTypeConstraint)
        {
            flags.Add("struct");
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
    private Type ResolveClrTypeForGenericArg(TypeSymbol typeSymbol)
        => NullableLifting.ResolveClrTypeForGenericArg(this.scope.References, typeSymbol);

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

    private TypeSymbol LookupType(string name)
        => LookupType(name, preferredArity: -1);

    private TypeSymbol LookupType(string name, int preferredArity)
    {
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

        if (scope.TryLookupTypeAlias(name, preferredArity, out var aliased))
        {
            return aliased;
        }

        if (scope.TryLookupImportedClass(name, declaration: null, out var importedClass))
        {
            return TypeSymbol.FromClrType(importedClass.ClassType);
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
    private bool TryResolveImportedInterface(string name, out TypeSymbol importedInterface)
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
    private bool TryResolveImportedBaseType(string baseName, out TypeSymbol importedBaseType)
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
    private System.Type TryResolveDottedClrType(string dottedName)
    {
        if (string.IsNullOrEmpty(dottedName) || !dottedName.Contains('.'))
        {
            return null;
        }

        var segments = dottedName.Split('.');
        for (var outerLen = segments.Length; outerLen >= 1; outerLen--)
        {
            System.Type outer;
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
    private static FunctionSymbol ResolveEntryPoint(
        Binder binder,
        ImmutableArray<FunctionSymbol> functions,
        GlobalStatementSyntax[] globalStatements,
        ImmutableArray<SyntaxTree> syntaxTrees,
        PackageSymbol entryPointPackage,
        FunctionSymbol synthesizedEntryPoint)
    {
        var explicitMain = functions.FirstOrDefault(f => f.Name == "Main");
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
                binder.Diagnostics.ReportTopLevelStatementsConflictWithMain(
                    explicitMain.Declaration.Identifier.Location);
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
    internal static void AttachDocumentation(Symbol symbol, SyntaxNode syntax)
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
#pragma warning restore SA1202
}