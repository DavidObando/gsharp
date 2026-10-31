// <copyright file="CSharpToGSharpTranslator.Types.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import GSharpIdentifierNameContext = GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        private func TranslateLambda(
            lambda AnonymousFunctionExpressionSyntax,
            exactTargetInvoke IMethodSymbol? = nil
        ) GExpression {
            let parameters = List[Parameter]()
            let projectedParameters = List[IParameterSymbol]()
            let parameterList ParameterListSyntax? = switch lambda {
                case paren is ParenthesizedLambdaExpressionSyntax: paren.ParameterList
                case anonymousMethod is AnonymousMethodExpressionSyntax: anonymousMethod.ParameterList
                default: default(ParameterListSyntax?)
            }
            if lambda is SimpleLambdaExpressionSyntax simple {
                parameters.Add(
                    this.MapLambdaParameter(
                        simple.Parameter,
                        exactTargetInvoke?.Parameters.FirstOrDefault(),
                        projectedParameters
                    )
                )
            } else if parameterList != nil {
                for var index = 0; index < parameterList.Parameters.Count; index++ {
                    let exactParameter IParameterSymbol? = if exactTargetInvoke != nil &&
                        index < exactTargetInvoke
                        .Parameters
                        .Length {
                        exactTargetInvoke.Parameters[index]
                    } else {
                        default(IParameterSymbol?)
                    }
                    parameters.Add(
                        this.MapLambdaParameter(parameterList.Parameters[index], exactParameter, projectedParameters)
                    )
                }
            } else if lambda is AnonymousMethodExpressionSyntax implicitParamsAnonymousMethod {
                // `delegate { … }` (no parameter list at all, distinct from
                // `delegate () { … }`) binds to whatever parameter list the target
                // delegate type declares (C# spec §12.19) — the block simply may
                // not reference them. G# function literals always name params
                // explicitly, so synthesize them from the converted delegate
                // type's Invoke signature; if that type can't be resolved, this is
                // a genuine gap rather than a silent zero-arg guess.
                let invokeMethod IMethodSymbol? = exactTargetInvoke ??
                    GetDelegateInvokeMethod(this.context.GetTypeInfo(implicitParamsAnonymousMethod).ConvertedType)
                if invokeMethod != nil {
                    // The body can never reference these params (C# gives them no
                    // source names here), so use G#'s repeatable, non-referenceable
                    // discard parameter. This preserves every positional slot
                    // without shadowing a captured source or generated name.
                    for invokeParameter in invokeMethod.Parameters {
                        let mapped = this.MapParameter(invokeParameter, implicitParamsAnonymousMethod)
                        parameters.Add(
                            Parameter(
                                "_",
                                mapped.Type,
                                mapped.IsVariadic,
                                mapped.RefKind,
                                mapped.DefaultValue,
                                mapped.Attributes
                            )
                        )
                    }
                } else {
                    this.context.ReportUnsupported(
                        implicitParamsAnonymousMethod,
                        "parameterless 'delegate { … }' anonymous method whose target delegate type could not be resolved; cannot infer its parameter list (ADR-0115 §B)."
                    )
                }
            }
            let isAsync = lambda.AsyncKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsyncKeyword)
            let lambdaSymbol IMethodSymbol? = this
                .context
                .GetSymbolInfo(lambda)
                .Symbol as IMethodSymbol ??
                GetDelegateInvokeMethod(this.context.GetTypeInfo(lambda).ConvertedType)
            var exactReturnType GTypeReference? = if exactTargetInvoke != nil {
                this.MapDelegateLikeReturnType(exactTargetInvoke, isAsync, lambda.GetLocation())
            } else {
                default(GTypeReference?)
            }
            // Explicit ValueTask envelopes must preserve the nullable result
            // already accepted by the generic selector flow proof.
            if isAsync &&
                exactTargetInvoke?.ReturnType is INamedTypeSymbol taskLike &&
                IsTaskLikeEnvelope(taskLike) &&
                lambda
                .Body
                .DescendantNodesAndSelf(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> !(node is AnonymousFunctionExpressionSyntax) &&
                    !(node is LocalFunctionStatementSyntax)
            )
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]()
                .Any(this.LambdaResultFeedsNullableObservedInvocation) {
                exactReturnType = this.PromoteTaskEnvelopeReturnIfTainted(
                    exactReturnType,
                    taskLike.TypeArguments[0],
                    lambdaSymbol
                )
            }
            let hasUnderscoreParameter = (
                lambda is SimpleLambdaExpressionSyntax simpleLambda &&
                    simpleLambda
                    .Parameter
                    .Identifier
                    .ValueText == "_"
            ) ||
                parameterList
                ?.Parameters
                .Any(
                (parameter Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax) -> parameter
                    .Identifier
                    .ValueText == "_"
            ) == true
            let isAsyncVoidTarget = isAsync && lambdaSymbol != nil && IsCSharpAsyncVoidHandler(lambdaSymbol)
            // A block-bodied lambda's body is its own evaluation scope: a spill
            // hoisted while translating it (issue #1731) must never leak into the
            // ENCLOSING statement's prologue (that would evaluate the operand
            // once, eagerly, at the lambda's definition instead of per
            // invocation). The ambient seam is suspended around the block body;
            // each statement inside it still opens its own fresh seam via
            // <see cref="TranslateStatement"/>. The assignment-/expression-bodied
            // branches below instead open their OWN fresh seam via
            // <see cref="WithSpillSeam"/> (rather than being suspended outright),
            // since they have no per-statement seam of their own to fall back on.
            let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
            let outerOutDeclarations List[GStatement]? = this.state.FunctionArgumentOutDeclarations
            this.state.PendingSpillPrologue = nil
            this.state.FunctionArgumentOutDeclarations = nil
            // Issue #1736: a lambda is its own mutability/reference-scan scope,
            // regardless of WHERE the lambda appears. `currentBodyScope` drives
            // `IsSymbolReassigned` (via `IsLocalReassigned`/`WithParameterShadows`),
            // which treats a null scope as "never reassigned" — correct only when
            // reached from a normal method/accessor body (already scoped by
            // <see cref="TranslateBody"/>). A lambda translated OUTSIDE any body —
            // a field/property initializer, a folded static-ctor RHS, a ctor
            // `base(...)`/`this(...)` argument, an attribute argument, etc. — left
            // `currentBodyScope` null, so a local declared and reassigned entirely
            // inside the lambda (e.g. `Func<int> f = () => { int i = 0; i++; return
            // i; };`) was misclassified as immutable and emitted `let i = 0`
            // followed by an illegal `i++`. Narrowing the scope to the lambda node
            // itself here — rather than only widening it at each out-of-body call
            // site — fixes every such position at once and is idempotent when the
            // lambda is already inside a normal body: the narrower scope is a
            // subset of the enclosing one that still contains the lambda's own
            // reassignments, so nothing that worked before regresses.
            let previousBodyScope Microsoft.CodeAnalysis.SyntaxNode? = this.state.CurrentBodyScope
            this.state.CurrentBodyScope = lambda
            try {
                if isAsyncVoidTarget {
                    // Every C# lambda body shape reduces to a plain STATEMENT
                    // sequence here — never a `return`-wrapped value, even for
                    // the generic expression-bodied shape below, since a
                    // void-delegate target has no result to return (and the
                    // expression itself, e.g. a bare `await voidTask`, has no
                    // value to produce anyway).
                    let innerBody = if lambda.Body is BlockSyntax asyncVoidBlock {
                        this.WithParameterShadows(lambda, this.TranslateBlock(asyncVoidBlock))
                    } else {
                        BlockStatement(
                            this.WithSpillSeam(
                                func () IReadOnlyList[GStatement] {
                                    return this.TranslateExpressionStatements(
                                        cast[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax](lambda.Body)
                                    )!!.ToList()
                                }
                            )
                                .ToList()
                        )
                    }
                    return LambdaExpression(
                        parameters,
                        blockBody: innerBody,
                        isAsync: true,
                        returnType: NamedTypeReference("void"),
                        isFunctionLiteral: true
                    )
                }
                if lambda.Body is BlockSyntax block {
                    // ADR-0128 / issue #1172: block-bodied lambdas normally use the
                    // idiomatic inferred arrow form. Issue #3414: when a direct
                    // argument's return expressions need conversion to the target
                    // delegate result, preserve that exact result on a func literal.
                    return LambdaExpression(
                        parameters,
                        blockBody: this.WithParameterShadows(lambda, this.TranslateBlock(block)),
                        isAsync: isAsync,
                        returnType: exactReturnType,
                        isFunctionLiteral: exactTargetInvoke != nil
                    )
                }
                // A void static-helper `?.` call needs a guarded statement, not
                // an expression-bodied lambda whose body cannot represent void.
                if !isAsync &&
                    lambda.Body is ConditionalAccessExpressionSyntax voidConditional &&
                    this.TryMatchNullConditionalStaticExtensionHelper(
                    voidConditional,
                    out _,
                    out var voidHelper,
                    out _,
                    out _,
                    out _,
                    out _
                ) &&
                    voidHelper!!
                    .ReturnsVoid {
                    return LambdaExpression(
                        parameters,
                        blockBody: BlockStatement(
                            this.WithSpillSeam(
                                func () IReadOnlyList[GStatement] {
                                    return this.TranslateExpressionStatements(
                                        cast[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax](lambda.Body)
                                    )!!.ToList()
                                }
                            )
                                .ToList()
                        ),
                        isAsync: false
                    )
                }
                if lambda.Body is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax assignmentBody &&
                    lambdaSymbol != nil &&
                    lambdaSymbol.ReturnsVoid == true {
                    // A C# assignment-bodied lambda converted to a void delegate
                    // discards the assignment's value. Keep that discard explicit
                    // with a statement body; value-returning targets use the native
                    // assignment expression below.
                    return LambdaExpression(
                        parameters,
                        blockBody: BlockStatement(
                            this.WithSpillSeam(
                                func () IReadOnlyList[GStatement] {
                                    return this.TranslateExpressionStatements(
                                        if hasUnderscoreParameter &&
                                            (
                                            assignmentBody.Left is IdentifierNameSyntax and
                                                {Identifier: {ValueText: "_"}}
                                        ) {
                                            assignmentBody.Right
                                        } else {
                                            cast[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax](assignmentBody)
                                        }
                                    )!!.ToList()
                                }
                            )
                                .ToList()
                        ),
                        isAsync: isAsync
                    )
                }
                if isAsync &&
                    lambda.Body is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ExpressionSyntax voidAsyncBody &&
                    this
                    .context
                    .GetTypeInfo(voidAsyncBody)
                    .Type
                    ?.SpecialType == SpecialType
                    .System_Void {
                    return LambdaExpression(
                        parameters,
                        blockBody: BlockStatement(
                            this.WithSpillSeam(
                                func () IReadOnlyList[GStatement] {
                                    return this.TranslateExpressionStatements(voidAsyncBody)!!.ToList()
                                }
                            )
                                .ToList()
                        ),
                        isAsync: true,
                        returnType: exactReturnType,
                        isFunctionLiteral: exactTargetInvoke != nil
                    )
                }
                // A value-returning expression-bodied lambda (`x => x.Get() is {…}`)
                // has no statement seam of its own; open one via
                // <see cref="WithSpillSeam"/> so a nested spill (issue #1731) lands
                // here rather than being dropped. If nothing spilled, keep the
                // idiomatic arrow-expression form; otherwise the lambda must
                // become block-bodied to host the spill's `let`, ending in an
                // explicit `return`.
                let spillPrologue = List[GStatement]()
                let savedSeam List[GStatement]? = this.state.PendingSpillPrologue
                let savedOutDeclarations List[GStatement]? = this.state.FunctionArgumentOutDeclarations
                this.state.PendingSpillPrologue = spillPrologue
                this.state.FunctionArgumentOutDeclarations = spillPrologue
                var expressionBody GExpression?
                try {
                    // Issue #2496: callable-value nullability is distinct from
                    // callable-return nullability. Apply forgiveness only at a
                    // runtime lambda's semantically resolved non-null result
                    // contract; expression trees and nullable delegate results
                    // stay assertion-free.
                    let bodyExpression = cast[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax](lambda.Body)
                    expressionBody = this.TranslateExpression(bodyExpression)
                    if this.IsUnguardedForwardOfTaintedValueAsRuntimeLambdaResult(bodyExpression) {
                        expressionBody = this.ReportStoreBridge(
                            bodyExpression,
                            expressionBody,
                            NonNullAssertionExpression(expressionBody),
                            this.GetLambdaTargetDelegateType(lambda)?.DelegateInvokeMethod
                        )
                    } else if this.IsGSharpNullableAnalyzerExpression(bodyExpression) &&
                        this
                        .AnalyzerBridgeTargetIsNonNull(
                        GetEffectiveReturnType(
                            this.GetLambdaTargetDelegateType(lambda)?.DelegateInvokeMethod?.ReturnType,
                            lambda.AsyncKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsyncKeyword)
                        )
                    ) {
                        // Issue #4356: a `T?`-only-in-G# analyzer value returned
                        // where the delegate's EFFECTIVE G# result is non-null —
                        // the `T` of an async `Task<T>`, never the envelope — the
                        // same bridge a `return` statement takes. (gsc erases the
                        // reference `!!` inside an expression tree.)
                        expressionBody = this.ReportStoreBridge(
                            bodyExpression,
                            expressionBody,
                            EnsureNonNullAssertion(expressionBody),
                            this.GetLambdaTargetDelegateType(lambda)?.DelegateInvokeMethod
                        )
                    }
                } finally {
                    this.state.PendingSpillPrologue = savedSeam
                    this.state.FunctionArgumentOutDeclarations = savedOutDeclarations
                }
                if spillPrologue.Count == 0 {
                    if exactTargetInvoke != nil {
                        return LambdaExpression(
                            parameters,
                            blockBody: BlockStatement([]GStatement{ReturnStatement(expressionBody)}),
                            isAsync: isAsync,
                            returnType: exactReturnType,
                            isFunctionLiteral: true
                        )
                    }
                    return LambdaExpression(parameters, expressionBody: expressionBody, isAsync: isAsync)
                }
                let bodyStatements = List[GStatement](spillPrologue){ReturnStatement(expressionBody)}
                return LambdaExpression(
                    parameters,
                    blockBody: BlockStatement(bodyStatements),
                    isAsync: isAsync,
                    returnType: exactReturnType,
                    isFunctionLiteral: exactTargetInvoke != nil
                )
            } finally {
                for projectedParameter in projectedParameters {
                    this.state.ProjectedCallableParameterType.Remove(projectedParameter)
                }
                this.state.PendingSpillPrologue = outerSpillPrologue
                this.state.FunctionArgumentOutDeclarations = outerOutDeclarations
                this.state.CurrentBodyScope = previousBodyScope
            }
        }

        // Shared mapping of a method/lambda result type into a G# func return type,
        // applying the `async` unwrap rule: a G# `async func` declares the UNWRAPPED
        // result, so C# `async Task` → null (void) and `async Task<T>` → `T`.
        private func MapDelegateLikeReturnType(symbol IMethodSymbol?, isAsync bool, location Location) GTypeReference? {
            if symbol!!.ReturnsVoid {
                return if isAsync {
                    NamedTypeReference("void")
                } else {
                    default(NamedTypeReference?)
                }
            }
            let returnType = symbol!!.ReturnType
            if isAsync &&
                returnType is INamedTypeSymbol{Name: "Task"} task &&
                task
                .ContainingNamespace
                ?.ToDisplayString() == "System.Threading.Tasks" {
                if !task.IsGenericType {
                    return nil
                }
                // Issue #2421: same declaration-sink promotion the sync path
                // below applies, keyed off the AWAITED type (see
                // CSharpToGSharpTranslator.MapReturnType /
                // PromoteAwaitedReturnIfTainted for the full rationale).
                let awaitedType = task.TypeArguments[0]
                let awaitedMapped GTypeReference? = this.typeMapper.Map(awaitedType, this.context, location)
                return this.PromoteAwaitedReturnIfTainted(awaitedMapped, awaitedType, symbol)
            }
            // Issue #914 (oblivious sink): local-function/lambda return
            // promotion uses the same shared symbol-position decision as a
            // top-level method return.
            var mapped GTypeReference? = this.typeMapper.Map(returnType, this.context, location)
            mapped = this.PromoteTupleDeclarationIfTainted(mapped, returnType, symbol)
            if returnType is INamedTypeSymbol{IsGenericType: true} taskLike &&
                taskLike
                .TypeArguments
                .Length == 1 &&
                taskLike
                .ContainingNamespace
                ?.ToDisplayString() == "System.Threading.Tasks" && (taskLike.Name is "Task" or "ValueTask") {
                return this.PromoteTaskEnvelopeReturnIfTainted(mapped, taskLike.TypeArguments[0], symbol)
            }
            return this.PromoteReturnIfTainted(mapped, symbol)
        }

        private func MapLambdaParameter(
            parameter Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax,
            exactTargetParameter IParameterSymbol? = nil,
            projectedParameters List[IParameterSymbol]? = nil
        ) Parameter {
            // A lambda parameter's type is inferred by Roslyn from the delegate
            // target even when the C# spelling omits it (`n => …`); the canonical
            // G# arrow lambda always names the parameter type (ADR-0074).
            if this.context.GetDeclaredSymbol(parameter) is IParameterSymbol symbol {
                if exactTargetParameter != nil && !SymbolEqualityComparer.IncludeNullability.Equals(
                    symbol.Type,
                    exactTargetParameter.Type
                ) {
                    if parameter.Type != nil {
                        this.context.ReportUnsupported(
                            parameter,
                            "projected delegate parameter type differs from an explicitly typed lambda parameter; no exact G# adaptation exists."
                        )
                    }
                    let mappedTarget = this.MapParameter(exactTargetParameter, parameter, promoteNullability: false)
                    this.state.ProjectedCallableParameterType[symbol] = exactTargetParameter.Type
                    projectedParameters?.Add(symbol)
                    return Parameter(
                        this.EmittedName(parameter, parameter.Identifier, GSharpIdentifierNameContext.Parameter),
                        mappedTarget.Type,
                        mappedTarget.IsVariadic,
                        mappedTarget.RefKind
                    )
                }
                // Issue #3855: the #1072 promotion is safe for a lambda
                // parameter whose type is FIXED by the target delegate —
                // widening an input position is contravariance, and a
                // `(T?) -> R` literal still converts to a `(T) -> R` target.
                // It is NOT safe when the annotation is an INPUT to the
                // enclosing call's type-argument inference: there the widened
                // annotation does not adapt to a fixed target, it CHOOSES the
                // target, so `.Where((d T?) -> d != nil)` infers the whole
                // sequence as `sequence[T?]` and every downstream member
                // access runs on a nullable receiver.
                let mapped = this.MapParameter(
                    symbol,
                    parameter,
                    promoteNullability: !this.LambdaParameterAnnotationFeedsTypeInference(parameter)
                )
                // Issue #5541: a lambda parameter that receives an element of oblivious
                // container storage states the element's nullable positions.
                let promoted = this.PromoteObliviousContainerStorage(mapped.Type, symbol)
                return if object.ReferenceEquals(promoted, mapped.Type) {
                    mapped
                } else {
                    Parameter(
                        mapped.Name,
                        promoted!!,
                        mapped.IsVariadic,
                        mapped.RefKind,
                        mapped.DefaultValue,
                        mapped.Attributes
                    )
                }
            }
            let type GTypeReference? = if parameter.Type != nil {
                this.MapTypeSyntax(parameter.Type)
            } else {
                cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
            }
            return Parameter(
                this.EmittedName(parameter, parameter.Identifier, GSharpIdentifierNameContext.Parameter),
                type
            )
        }

        // `typeof(IEnumerable<>)` over an unbound generic has no bound symbol for
        // the omitted type argument, so the general type mapper cannot resolve it.
        // G# has no open-generic `typeof` spelling; the canonical form is the bare
        // generic definition name (`typeof(IEnumerable)`), which parses and binds
        // to the open type (issue #1915: gsc's binder now resolves a bare
        // imported generic name inside `typeof(...)` to the CLR open generic
        // definition via an arity-suffixed reflection lookup).
        // `typeof(IEnumerable<>)` over an unbound generic has no bound symbol for
        // the omitted type argument, so the general type mapper cannot resolve it.
        // Issue #2012 (S1): G# has no `Name<>`/`Name<,>` comma-count unbound-generic
        // spelling; the canonical form carries the requested arity explicitly via
        // `_` placeholder bracket type arguments (issue #1989/#2011) —
        // `typeof(IEnumerable<>)` maps to `typeof(IEnumerable[_])`,
        // `typeof(Dictionary<,>)` maps to `typeof(Dictionary[_, _])`, etc. This
        // form always resolves the arity-suffixed generic and never falls back
        // to a same-named non-generic type (unlike the older bare-name form,
        // which stayed ambiguous for same-base-name multi-arity families such
        // as `Func`/`Action`).
        // Issue #3589: nested forms carry an unbound generic in a NON-terminal
        // segment (`Dictionary<,>.Enumerator`, `Outer<>.Inner<>`). Each unbound
        // segment renders with its own `_` placeholder list — the older
        // `qualified.Left.ToString()` composition leaked the C# `<>` spelling
        // verbatim into the emitted file (a round-trip GS0005). #3589 binds
        // the nested spelling by composing its segment-wise reflection name.
        private func MapTypeOfOperand(type TypeSyntax) GTypeReference? {
            if type is NameSyntax nameSyntax &&
                HasOmittedTypeArgument(nameSyntax) &&
                RenderUnboundGenericName(nameSyntax) is {} unboundName {
                return NamedTypeReference(unboundName)
            }
            let symbol ITypeSymbol? = this.context.GetTypeInfo(type).Type
            return if symbol != nil {
                this.typeMapper.MapTypeOf(symbol, this.context, type.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(type.ToString()))
            }
        }

        private func MapTypeSyntax(type TypeSyntax?) GTypeReference? {
            let symbol ITypeSymbol? = this.context.GetTypeInfo(type).Type
            return if symbol != nil {
                this.typeMapper.MapExplicitType(symbol, this.context, type!!.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(type!!.ToString()))
            }
        }

        /// Translates the `ref expr` operand of a ref local's initializer
        /// (`ref int r = ref xs[1]`) or a ref return (`return ref
        /// values[1]`) — issue #1900. G# has a native ref-aliasing local
        /// (`let/var ref name T = lvalue`, issue #491/ADR-0060) and a native
        /// ref-returning function (`func F(...) ref T { return ref lvalue }`,
        /// issue #490); both alias the RHS lvalue directly with no explicit
        /// address-of syntax, so the operand is translated as-is.
        ///
        /// Issue #4224: gsc's lvalue checks (`ExpressionBinder.IsLvalue` /
        /// `StatementBinder.IsLvalueForRefReturn`) now also accept a call to
        /// a ref-returning function/method or a read of a ref-returning
        /// property, so `ref Pick(xs, 2)` (aliasing a ref-returning call's
        /// result at another call/return site) has a native G# construct to
        /// bind to — translate the call operand as-is like every other lvalue
        /// shape and let gsc's own binder validate (and reject with its
        /// precise diagnostic) a callee that does not actually return by ref.
        private func TranslateRefExpression(refExpression RefExpressionSyntax) GExpression? {
            let operand = refExpression.Expression
            if operand is IdentifierNameSyntax ||
                operand is ElementAccessExpressionSyntax ||
                operand is MemberAccessExpressionSyntax ||
                operand is InvocationExpressionSyntax {
                return this.TranslateExpression(operand)
            }
            this.context.ReportUnsupported(
                refExpression,
                "ref expression over '${operand.Kind()}' has no canonical G# form yet: G#'s ref-aliasing local/return only aliases a variable, array element, or field — not a call result, even a ref-returning one (issue #1900)."
            )
            return IdentifierExpression("nil")
        }

        private func TranslatePredefinedTypeExpression(predefined PredefinedTypeSyntax) GExpression {
            // A C# predefined type used as an expression receiver (`string.Concat`,
            // `int.Parse`) is a static-call target. Reuse the type mapper so the
            // receiver and every type-clause position share one canonical G#
            // spelling (`string`, `int32`, ...; ADR-0115 §B.12).
            let symbol ITypeSymbol? = this.context.GetTypeInfo(predefined).Type
            let mapped GTypeReference? = if symbol == nil {
                default(GTypeReference?)
            } else {
                this.typeMapper.Map(symbol, this.context, predefined.GetLocation())
            }
            let name = if mapped is NamedTypeReference{TypeArguments: {Count: 0}} named {
                named.Name
            } else {
                symbol?.Name ?? predefined.Keyword.Text
            }
            return IdentifierExpression(name)
        }

        private func TranslateImplicitObjectCreation(creation ImplicitObjectCreationExpressionSyntax) GExpression? {
            // A C# target-typed `new()` carries its concrete type only in the bound
            // model; emit the explicit constructed type (`List[T]()`) so the G#
            // construction names the type (ADR-0115 §B.7/§B.16).
            var typeSymbol ITypeSymbol? = this.context.GetTypeInfo(creation).Type
            if this.TryGetManagedReferenceArrayProjectedMethod(creation, out var projectedConstructor) {
                typeSymbol = projectedConstructor!!.ContainingType
            }
            let type GTypeReference? = if typeSymbol != nil {
                this.typeMapper.Map(typeSymbol, this.context, creation.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
            }
            let arguments = this.TranslateCallArguments(
                creation,
                creation.ArgumentList?.Arguments ?? default(Microsoft.CodeAnalysis.SeparatedSyntaxList[ArgumentSyntax])
            )
            return this.BuildObjectCreationCore(creation, typeSymbol, type, arguments, creation.Initializer)
        }

        private func TranslateSwitchExpression(
            node Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax
        ) GExpression? {
            if this.InAnalyzerApiMode && this.TryTranslateAnalyzerTypeNameSwitch(node, out var analyzerTypeName) {
                return analyzerTypeName
            }
            let subject GExpression? = this.TranslateExpression(node.GoverningExpression)
            let nullableResultType GTypeReference? = this.NullableReferenceSwitchResultType(node)
            let arms = List[SwitchArm]()
            var hasTotalArm = false
            for arm in node.Arms {
                // Issue #1730: the pattern's bindings must be installed BEFORE the
                // `when` guard is translated, since the guard can reference them
                // (`Circle { Radius: var r } when r > 0 => ...`). Translating the
                // guard first (the prior order) resolved `r` while it was still
                // out of scope.
                let bindings = List[(Symbol ISymbol, Replacement GExpression)]()
                let usedDesignators = HashSet[string](StringComparer.Ordinal)
                let guards = List[GExpression]()
                let mutableBindings = List[(Symbol ILocalSymbol, MatchedValue GExpression)]()
                this.RegisterProjectedSwitchPatternBindings(arm.Pattern, node.GoverningExpression)
                let pattern GPattern? = this.TranslateSwitchPattern(
                    arm.Pattern,
                    subject,
                    bindings,
                    usedDesignators,
                    guards,
                    mutableBindings
                )
                for (symbol, replacement) in bindings {
                    this.state.PatternBindings[symbol] = replacement
                }
                for (symbol, matchedValue) in mutableBindings {
                    this.state.PatternBindings[symbol] = matchedValue
                }
                var guard_ GExpression?
                var body GExpression?
                try {
                    // Issue #991: C# `when` guards now have a canonical G# form.
                    // Issue #1943: a typed positional/property subpattern that
                    // has no room in its `TypePattern` GPattern node (a
                    // constant/relational/nested test) was collected into
                    // `guards` above instead; AND it together with any explicit
                    // `when` clause (`case Point p when p.X == 0 && p.Y == 0 &&
                    // <user guard>:`).
                    guard_ = this.TranslateSwitchPatternGuard(arm.WhenClause, guards, mutableBindings)
                    this.UseMutableSwitchPatternLocals(mutableBindings)
                    body = this.TranslateSwitchArmExpression(arm.Expression, nullableResultType)
                    body = this.MaterializeMutableSwitchPatternLocals(body, mutableBindings, arm.Pattern)
                } finally {
                    for (symbol, _) in bindings {
                        this.state.PatternBindings.Remove(symbol)
                    }
                    for (symbol, _) in mutableBindings {
                        this.state.PatternBindings.Remove(symbol)
                    }
                }
                arms.Add(SwitchArm(pattern, body, guard_))
                // A guarded discard (`case _ when …`) can still fail at run
                // time, so — mirroring gsc's own exhaustiveness rule
                // (diagnostics.md GS0176: "a guarded discard … does not act
                // as a total/default arm") — only an unguarded discard/`default`
                // arm counts as total. `pattern` is `null` for a real C#
                // discard (`_ =>`); it is a `DiscardPattern` node (not `null`)
                // for a `var v =>` arm, which also always matches (it never
                // narrows, so it is total too — see `TranslatePattern`'s
                // `VarPatternSyntax` case above).
                hasTotalArm |= guard_ == nil && (pattern == nil || (pattern is DiscardPattern || pattern is VarPattern))
            }
            // Issue #1962: a C# switch expression can be exhaustive purely by
            // its TYPE arms (e.g. every case of a sealed hierarchy is covered,
            // or a `bool`'s `true`/`false` are both present) with no `_`/`var`
            // catch-all at all — Roslyn proves that exhaustive and requires no
            // default arm. gsc's own exhaustiveness check has no equivalent
            // type-hierarchy proof: it only recognizes a literal unguarded
            // discard/`default:` arm as total (see GS0176 above), so the
            // translated arm set would otherwise trip GS0176 even though the
            // source compiled cleanly. Synthesize a trailing default arm that
            // mirrors C#'s own runtime behavior for an unmatched switch
            // expression value (an implicit throw — C#'s own
            // `SwitchExpressionException`) so gsc accepts the switch and a
            // genuinely-unreachable value still fails loudly instead of
            // silently miscompiling.
            if !hasTotalArm {
                let resultType GTypeReference? = this.ResolveExpressionType(node)
                let unmatchedThrow GExpression = ThrowExpression(
                    BuildConstruction(
                        this.MapSystemInvalidOperationException(node.GetLocation()),
                        List[GExpression]{LiteralExpression.String("Unmatched switch expression value.")}
                    ),
                    resultType
                )
                arms.Add(SwitchArm(nil, unmatchedThrow, nil))
            }
            return SwitchExpression(subject, arms)
        }

        private func NullableReferenceSwitchResultType(
            node Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax
        ) GTypeReference? {
            let resultType ITypeSymbol? = this.context.GetTypeInfo(node).Type
            if !(resultType != nil && resultType.IsReferenceType == true) {
                return nil
            }
            let mapped GTypeReference? = this.typeMapper.Map(resultType, this.context, node.GetLocation())
            return if mapped!!.IsNullable {
                mapped
            } else {
                MakeNullable(mapped)
            }
        }

        // Issue #2412 (round 3): mirrors TranslateValueWithNullForgiveness's
        // ternary-arm handling (Statements.cs, ConditionalExpressionSyntax
        // WhenTrue/WhenFalse) for a switch-EXPRESSION arm's value. Prior to
        // this fix, a switch arm's value was translated with a bare
        // `TranslateExpression` call, so a nullable-tainted arm value never
        // got the `!!` forgiveness a ternary arm in the exact same
        // return-preserving-body position already receives — the detection
        // logic in `FindEnclosingConditionalAndSiblings` already recognized
        // switch arms, but nothing downstream ever consulted it for this call
        // site. `TranslateValueWithNullForgiveness` is safe to reuse as-is: it
        // only adds `!!` when `ReceiverNeedsNullForgiveness` says so (which
        // already excludes literals, so the `IsNullOrDefaultLiteral` branch
        // below is untouched either way).
        private func TranslateSwitchArmExpression(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            nullableResultType GTypeReference?
        ) GExpression? {
            let (value, statements) = this.TranslateConditionalValueBranch(
                expression,
                () -> if nullableResultType != nil && IsNullOrDefaultLiteral(expression) {
                    cast[GExpression](DefaultValueExpression(nullableResultType))
                } else {
                    this.CoerceSwitchArmValue(expression, this.TranslateValueWithNullForgiveness(expression))!!
                }
            )
            return if statements.Count == 0 {
                value
            } else {
                cast[GExpression](BlockExpression(statements, value))
            }
        }

        // Issues #3501/#4832: C# target-types every switch-expression arm to
        // the switch's converted type, while gsc requires every arm to produce
        // the same type (GS0179). Spell conversions to non-nullable value
        // result types, including numeric widening and implicit conversion
        // operators such as TypeDefinitionHandle -> EntityHandle.
        private func CoerceSwitchArmValue(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            translated GExpression?
        ) GExpression? {
            let info = this.context.GetTypeInfo(expression)
            if TryGetNumericKind(info.Type, out var source) &&
                TryGetNumericKind(info.ConvertedType, out var converted) &&
                source != converted {
                return this.CoerceOperandTo(translated, info.ConvertedType, expression.GetLocation())
            }
            if info.Type is {} valueArmType &&
                valueArmType.TypeKind != TypeKind.Error &&
                info.ConvertedType is {} valueTarget &&
                valueTarget.TypeKind != TypeKind.Error &&
                IsNonNullableValueType(valueTarget) &&
                !SymbolEqualityComparer
                .Default
                .Equals(valueArmType, valueTarget) && this.GetUserDefinedConversionInputOperator(
                expression,
                valueTarget,
                out _
            ) != nil {
                return this.CoerceOperandTo(translated, valueTarget, expression.GetLocation())
            }
            // Issue #3553: C# also target-types REFERENCE arms — `value switch
            // { ExpressionSyntax e => new[] { e }, BlockSyntax b =>
            // b.DescendantNodes()…, _ => Enumerable.Empty<ExpressionSyntax>() }`
            // converts every arm to the switch's IEnumerable<T> — while gsc
            // requires every arm to produce the first arm's type (GS0179).
            // When an arm's own reference type differs from its converted
            // reference type by more than a nullable annotation, spell the
            // upcast (`arm as T`). Annotation-only differences stay bare (the
            // `!!`/promotion machinery owns those), as do identical types.
            if info.Type is {IsReferenceType: true} armType &&
                info.ConvertedType is {IsReferenceType: true} armTarget &&
                !SymbolEqualityComparer
                .Default
                .Equals(armType, armTarget) &&
                info.Type!!.TypeKind != TypeKind.Error &&
                info.ConvertedType!!.TypeKind != TypeKind.Error {
                return this.CoerceReferenceValueTo(expression, translated, armTarget)
            }
            return translated
        }

        // Issue #3553: spells a reference upcast to the converted type. A
        // provably non-null value uses the non-null spelling — the
        // conversion-call `T(expr)` for class targets, the unambiguous
        // checked-reference-cast `cast[T](expr)` for (generic) interface
        // targets. A value that is nullable on the G# side (a C# `T?` arm, or
        // an oblivious promoted-nullable read — the #2412 contract keeps such
        // arms un-forgiven and widens the RESULT instead) uses the safe cast
        // `expr as T`, whose `T?` result unifies at the widened nullable type.
        private func CoerceReferenceValueTo(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            translated GExpression?,
            targetType ITypeSymbol?
        ) GExpression? {
            let location = expression.GetLocation()
            let target GTypeReference? = this.typeMapper.Map(targetType, this.context, location)
            let conversionOperator IMethodSymbol? = this.GetUserDefinedConversionInputOperator(
                expression,
                targetType,
                out var convertsValue
            )
            if conversionOperator != nil && convertsValue {
                let convertedType GTypeReference? = this.MapDelegateLikeReturnType(
                    conversionOperator,
                    isAsync: false,
                    location
                )
                // Forgiveness may already have asserted the converted result.
                let convertedResultIsAsserted = this
                    .state
                    .MaterializedConversionResults
                    .TryGetValue(UnwrapTranslatedValue(translated)!!, out var materializedOperator) &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(materializedOperator, conversionOperator)
                let converted GExpression? = if convertedResultIsAsserted {
                    translated
                } else {
                    cast[GExpression](ConversionExpression(convertedType, translated))
                }
                return if SymbolEqualityComparer.Default.Equals(conversionOperator.ReturnType, targetType) {
                    converted
                } else {
                    cast[GExpression](
                        ConversionExpression(
                            if convertedType!!.IsNullable && !convertedResultIsAsserted {
                                MakeNullable(target)
                            } else {
                                target
                            },
                            converted,
                            isCheckedReferenceCast: true
                        )
                    )
                }
            }
            let nullableValue = !(translated is NonNullAssertionExpression) &&
                (
                this
                    .context
                    .GetTypeInfo(expression)
                    .Type
                    ?.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    (this.IsObliviousCompilation() && this.IsNullablePromotedValue(expression))
            )
            if nullableValue {
                return ParenthesizedExpression(BinaryExpression(translated, "as", TypeExpression(target)))
            }
            // Always the unambiguous constructor-independent `cast[T](expr)`
            // form: the conversion-call `T(expr)` doesn't bind for generic
            // interface targets and parses as CONSTRUCTION for class targets
            // (GS0386 on an abstract base — Oahu's DescriptorFactory).
            return ConversionExpression(target, translated, isCheckedReferenceCast: true)
        }

        private func TranslateSwitchPatternGuard(
            whenClause WhenClauseSyntax?,
            patternGuards List[GExpression],
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]
        ) GExpression? {
            let guardMutation ILocalSymbol? = if whenClause == nil {
                default(ILocalSymbol?)
            } else {
                mutableBindings.Select((binding(Symbol ILocalSymbol, MatchedValue GExpression)) -> binding.Symbol)
                    .FirstOrDefault((symbol ILocalSymbol) -> this.IsSymbolReassigned(symbol, whenClause))
            }
            var guard_ GExpression? = nil
            if guardMutation != nil {
                this.context.ReportUnsupported(
                    whenClause,
                    "switch pattern variable '${guardMutation.Name}' is reassigned in a when guard; G# has no arm-local mutable storage visible to both guard and body."
                )
                guard_ = LiteralExpression.Bool(false)
            } else if whenClause != nil {
                guard_ = this.TranslateExpression(whenClause.Condition)
            }
            return CombinePatternGuards(patternGuards, guard_)
        }

        private func UseMutableSwitchPatternLocals(
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]
        ) {
            for (symbol, _) in mutableBindings {
                this.state.PatternBindings[symbol] = IdentifierExpression(this.EmittedName(symbol, symbol.Name))
            }
        }

        private func MaterializeMutableSwitchPatternLocals(
            body GExpression?,
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)],
            pattern Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax
        ) GExpression? {
            let declarations = this.BuildMutableSwitchPatternDeclarations(mutableBindings, pattern)
            return if declarations.Count == 0 {
                body
            } else {
                cast[GExpression](BlockExpression(declarations, body))
            }
        }

        private func MaterializeMutableSwitchPatternLocals(
            body BlockStatement,
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)],
            pattern Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax
        ) BlockStatement {
            let declarations = this.BuildMutableSwitchPatternDeclarations(mutableBindings, pattern)
            if declarations.Count == 0 {
                return body
            }
            declarations.AddRange(body.Statements)
            return BlockStatement(declarations)
        }

        private func BuildMutableSwitchPatternDeclarations(
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)],
            pattern Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax
        ) List[GStatement] {
            let declarations = List[GStatement](mutableBindings.Count)
            for (symbol, matchedValue) in mutableBindings {
                declarations.Add(
                    LocalDeclarationStatement(
                        BindingKind.Var,
                        this.EmittedName(symbol, symbol.Name),
                        this.typeMapper.Map(symbol.Type, this.context, pattern.GetLocation()),
                        initializer: matchedValue
                    )
                )
            }
            return declarations
        }

        // Lowers a C# switch EXPRESSION that appears in statement position
        // (a discard `_ = x switch { ... };` or any other expression-statement)
        // into a G# switch STATEMENT. Each arm's expression is run for its side
        // effect only — the switch value is discarded, exactly as in C# — so the
        // arm body becomes a single-statement block wrapping the arm expression.
        // Mirrors TranslateSwitchExpression's pattern/guard/binding handling and
        // its exhaustiveness rule (issue #914).
        private func TranslateSwitchExpressionAsStatement(
            node Microsoft.CodeAnalysis.CSharp.Syntax.SwitchExpressionSyntax
        ) GStatement {
            let subject GExpression? = this.TranslateExpression(node.GoverningExpression)
            let cases = List[SwitchStatementCase]()
            var hasTotalArm = false
            for arm in node.Arms {
                let bindings = List[(Symbol ISymbol, Replacement GExpression)]()
                let usedDesignators = HashSet[string](StringComparer.Ordinal)
                let guards = List[GExpression]()
                let mutableBindings = List[(Symbol ILocalSymbol, MatchedValue GExpression)]()
                this.RegisterProjectedSwitchPatternBindings(arm.Pattern, node.GoverningExpression)
                let pattern GPattern? = this.TranslateSwitchPattern(
                    arm.Pattern,
                    subject,
                    bindings,
                    usedDesignators,
                    guards,
                    mutableBindings
                )
                for (symbol, replacement) in bindings {
                    this.state.PatternBindings[symbol] = replacement
                }
                for (symbol, matchedValue) in mutableBindings {
                    this.state.PatternBindings[symbol] = matchedValue
                }
                var guard_ GExpression?
                var body BlockStatement
                try {
                    guard_ = this.TranslateSwitchPatternGuard(arm.WhenClause, guards, mutableBindings)
                    this.UseMutableSwitchPatternLocals(mutableBindings)
                    body = this.TranslateSwitchArmExpressionAsBlock(arm.Expression)
                } finally {
                    for (symbol, _) in bindings {
                        this.state.PatternBindings.Remove(symbol)
                    }
                    for (symbol, _) in mutableBindings {
                        this.state.PatternBindings.Remove(symbol)
                    }
                }
                let armBody = this.MaterializeMutableSwitchPatternLocals(body, mutableBindings, arm.Pattern)
                cases.Add(SwitchStatementCase(pattern, armBody, guard_))
                hasTotalArm |= guard_ == nil && (pattern == nil || (pattern is DiscardPattern || pattern is VarPattern))
            }
            // As in TranslateSwitchExpression: a C# switch expression is
            // exhaustive by construction, but gsc's switch only treats a literal
            // unguarded discard/`default` as total (GS0176). When none is present,
            // synthesize a trailing default that throws — mirroring C#'s own
            // runtime SwitchExpressionException for an unmatched value.
            if !hasTotalArm {
                let unmatchedThrow GExpression = ThrowExpression(
                    BuildConstruction(
                        this.MapSystemInvalidOperationException(node.GetLocation()),
                        List[GExpression]{LiteralExpression.String("Unmatched switch expression value.")}
                    ),
                    nil
                )
                cases.Add(
                    SwitchStatementCase(
                        nil,
                        BlockStatement([]GStatement{cast[GStatement](ExpressionStatement(unmatchedThrow))})
                    )
                )
            }
            return SwitchStatement(subject, cases)
        }

        private func MapSystemInvalidOperationException(location Location) GTypeReference? {
            let invalidOperationException ITypeSymbol? = this
                .context
                .Compilation
                .GetTypeByMetadataName("System.InvalidOperationException")
            return if invalidOperationException != nil {
                this.typeMapper.Map(invalidOperationException, this.context, location)
            } else {
                cast[GTypeReference](NamedTypeReference("InvalidOperationException"))
            }
        }

        // Renders a switch-expression arm through the shared statement seam so
        // assignment/deconstruction side effects stay inside the selected arm.
        private func TranslateSwitchArmExpressionAsBlock(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) BlockStatement {
            return BlockStatement(
                this.WithSpillSeam(
                    func () IReadOnlyList[GStatement] {
                        if expression is Microsoft.CodeAnalysis.CSharp.Syntax.ThrowExpressionSyntax throwExpression {
                            return []GStatement{
                                cast[GStatement](ThrowStatement(this.TranslateExpression(throwExpression.Expression)))
                            }
                        }
                        return this.TranslateExpressionStatements(expression, hoistPostfix: false)!!.ToList()
                    }
                )
                    .ToList()
            )
        }

        private func TranslateSwitchStatement(node Microsoft.CodeAnalysis.CSharp.Syntax.SwitchStatementSyntax) sequence[
            GStatement
        ] {
            let subject GExpression? = this.TranslateExpression(node.Expression)
            let cases = List[SwitchStatementCase]()
            let sectionByLocalFunction = Dictionary[IMethodSymbol, SwitchSectionSyntax](SymbolEqualityComparer.Default)
            let declarationByLocalFunction = Dictionary[IMethodSymbol, LocalFunctionStatementSyntax](
                SymbolEqualityComparer.Default
            )
            let orderedBySection = Dictionary[
                SwitchSectionSyntax,
                IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax]
            ]()
            for section in node.Sections {
                orderedBySection.Add(section, this.HoistCallBeforeDeclLocalFunctions(section.Statements, section.Span))
                for localFunction in section.Statements.OfType[LocalFunctionStatementSyntax]() {
                    using let modelScope = this.context.UseSemanticModelFor(localFunction.SyntaxTree)
                    if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol symbol {
                        sectionByLocalFunction[symbol] = section
                        declarationByLocalFunction[symbol] = localFunction
                    }
                }
            }
            this.RegisterRecursiveLocalFunctionLifts(
                node.Sections.SelectMany(
                    func (section SwitchSectionSyntax) IEnumerable[
                        Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax
                    ] {
                        return section.Statements
                    }
                ),
                (component IReadOnlyCollection[IMethodSymbol]) -> component
                    .Select((symbol IMethodSymbol) -> sectionByLocalFunction[symbol])
                    .Distinct()
                    .Skip(1)
                    .Any() ||
                    component
                    .Any(
                    (symbol IMethodSymbol) -> this.IsLocalFunctionReferencedFromAnotherSwitchSection(
                        symbol,
                        declarationByLocalFunction[symbol]
                    )
                ),
                processOnlyForcedGroups: true
            )
            for section in node.Sections {
                let ordered = orderedBySection[section]
                this.RegisterCapturingRecursiveLocalFunctions(ordered)
                this.RegisterRecursiveLocalFunctionLifts(ordered)
            }
            // Issue #1884: a `goto case K;` / `goto default;` anywhere in this
            // switch (but not in a nested switch, whose own gotos target its
            // own labels) needs a synthesized label at the top of the arm it
            // targets, so the goto can be lowered to a plain `goto`.
            // Issue #3501 A3: gotos that qualify as adjacent fallthroughs
            // print as the native `fallthrough` statement and need no
            // synthesized arm-top label. Issue #3501: neither do gotos to a
            // do-nothing arm, which print as a bare `break` (see
            // TranslateGotoStatement).
            let gotoTargets = HashSet[SwitchLabelSyntax](
                node
                    .DescendantNodes()
                    .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.GotoStatementSyntax]()
                    .Where(
                    (g Microsoft.CodeAnalysis.CSharp.Syntax.GotoStatementSyntax) -> (
                        g.Kind() == Microsoft.CodeAnalysis.CSharp.SyntaxKind.GotoCaseStatement || g.Kind() == Microsoft
                            .CodeAnalysis
                            .CSharp
                            .SyntaxKind
                            .GotoDefaultStatement
                    ) &&
                        g
                        .Ancestors()
                        .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.SwitchStatementSyntax]()
                        .First() == node &&
                        !this.IsAdjacentFallthroughGoto(g)
                )
                    .Select(
                    (g Microsoft.CodeAnalysis.CSharp.Syntax.GotoStatementSyntax) -> (
                        Goto: g,
                        Target: this.ResolveGotoCaseOrDefaultTarget(g)
                    )
                )
                    .Where(
                    (
                        pair(Goto Microsoft.CodeAnalysis.CSharp.Syntax.GotoStatementSyntax, Target SwitchLabelSyntax)
                    ) -> pair.Item2 != nil &&
                        !(TargetArmIsEmptyBreak(pair.Item2) && !HasInterveningBreakTarget(pair.Item1))
                )
                    .Select(
                    (
                        pair(Goto Microsoft.CodeAnalysis.CSharp.Syntax.GotoStatementSyntax, Target SwitchLabelSyntax)
                    ) -> pair.Item2
                )
            )
            for section in node.Sections {
                // A G# switch-statement arm carries a single pattern; a C# section
                // that stacks multiple `case` labels (fall-through) has no canonical
                // G# form, so each label is emitted as its own arm. The body is
                // translated per-label (not once per section) because a pattern
                // label's bindings (issue #1730) must be installed before the body
                // is translated, and bindings can differ across stacked labels.
                let labels = section.Labels.ToList()
                // Issue #3501 A3: a section stacking multiple CONSTANT labels
                // becomes ONE Go-style comma arm (`case 1, 2 { … }`) with the
                // body translated once, instead of duplicating the body per
                // label. Pattern labels keep the per-label form (their
                // bindings can differ), and goto-targeted labels keep their
                // own arms so `goto case K` still has a distinct target.
                if labels.Count > 1 && labels.All((l SwitchLabelSyntax) -> l is CaseSwitchLabelSyntax) && !labels.Any(
                    gotoTargets.Contains
                ) {
                    let constantLabels = labels.Cast[CaseSwitchLabelSyntax]().ToList()
                    let mergedArm = SwitchStatementCase(
                        ConstantPattern(this.TranslateExpression(constantLabels[0].Value)),
                        this.TranslateSwitchSectionBody(section, orderedBySection[section])
                    ){
                        AdditionalPatterns = constantLabels
                            .Skip(1)
                            .Select(
                            (l CaseSwitchLabelSyntax) -> cast[GPattern](
                                ConstantPattern(this.TranslateExpression(l.Value))
                            )
                        )
                            .ToList()
                    }
                    cases.Add(mergedArm)
                    continue
                }
                for label in labels {
                    switch label {
                        case patternLabel is CasePatternSwitchLabelSyntax {
                            let bindings = List[(Symbol ISymbol, Replacement GExpression)]()
                            let usedDesignators = HashSet[string](StringComparer.Ordinal)
                            let guards = List[GExpression]()
                            let mutableBindings = List[(Symbol ILocalSymbol, MatchedValue GExpression)]()
                            this.RegisterProjectedSwitchPatternBindings(patternLabel.Pattern, node.Expression)
                            let pattern GPattern? = this.TranslateSwitchPattern(
                                patternLabel.Pattern,
                                subject,
                                bindings,
                                usedDesignators,
                                guards,
                                mutableBindings
                            )
                            // Issue #1730: install the pattern's bindings before
                            // translating the `when` guard and the case body, so
                            // both see the bound variable (`case Circle { Radius:
                            // var r } when r > 0: return r;`). The bindings are
                            // scoped to this label only.
                            for (symbol, replacement) in bindings {
                                this.state.PatternBindings[symbol] = replacement
                            }
                            for (symbol, matchedValue) in mutableBindings {
                                this.state.PatternBindings[symbol] = matchedValue
                            }
                            var guard_ GExpression?
                            var patternBody BlockStatement
                            try {
                                // Issue #991: C# `when` guards now have a canonical G# form.
                                // Issue #1943: see the switch-EXPRESSION arm above —
                                // a typed positional/property subpattern with no
                                // room in its `TypePattern` node is collected into
                                // `guards` and AND-ed with any explicit `when`.
                                guard_ = this.TranslateSwitchPatternGuard(
                                    patternLabel.WhenClause,
                                    guards,
                                    mutableBindings
                                )
                                this.UseMutableSwitchPatternLocals(mutableBindings)
                                patternBody = this.TranslateSwitchSectionBody(section, orderedBySection[section])
                                patternBody = this.MaterializeMutableSwitchPatternLocals(
                                    patternBody,
                                    mutableBindings,
                                    patternLabel.Pattern
                                )
                            } finally {
                                for (symbol, _) in bindings {
                                    this.state.PatternBindings.Remove(symbol)
                                }
                                for (symbol, _) in mutableBindings {
                                    this.state.PatternBindings.Remove(symbol)
                                }
                            }
                            cases.Add(SwitchStatementCase(pattern, patternBody, guard_))
                        }
                        case valueLabel is CaseSwitchLabelSyntax {
                            cases.Add(
                                SwitchStatementCase(
                                    ConstantPattern(this.TranslateExpression(valueLabel.Value)),
                                    this.TranslateSwitchSectionBody(
                                        section,
                                        orderedBySection[section],
                                        if gotoTargets.Contains(valueLabel) {
                                            this.GotoCaseOrDefaultLabelName(valueLabel)
                                        } else {
                                            default(string?)
                                        }
                                    )
                                )
                            )
                        }
                        case defaultLabel is DefaultSwitchLabelSyntax {
                            cases.Add(
                                SwitchStatementCase(
                                    nil,
                                    this.TranslateSwitchSectionBody(
                                        section,
                                        orderedBySection[section],
                                        if gotoTargets.Contains(defaultLabel) {
                                            this.GotoCaseOrDefaultLabelName(defaultLabel)
                                        } else {
                                            default(string?)
                                        }
                                    )
                                )
                            )
                        }
                        default {
                            this.context.ReportUnsupported(
                                label,
                                "switch label '${label.Kind()}' has no canonical G# form yet (ADR-0115 §B)."
                            )
                        }
                    }
                }
            }
            if this.RequiresEnumStatementFallback(node) {
                // Empty blocks do not round-trip, so discard a literal as the
                // canonical side-effect-free statement.
                cases.Add(
                    SwitchStatementCase(
                        nil,
                        BlockStatement(
                            []GStatement{
                                LocalDeclarationStatement(BindingKind.Let, "_", initializer: LiteralExpression.Int("0"))
                            }
                        )
                    )
                )
            }
            yield SwitchStatement(subject, cases)
        }

        private func RequiresEnumStatementFallback(
            node Microsoft.CodeAnalysis.CSharp.Syntax.SwitchStatementSyntax
        ) bool {
            // Issue #4167 (tracked by #4153): decomposed -- not a nested
            // `{ TypeKind: TypeKind.Enum }` pattern -- because gsc's pattern
            // matcher does not reliably evaluate an enum sub-pattern against
            // an imported-interface-typed scrutinee (here, `ITypeSymbol` from
            // `GetTypeInfo().Type`) under self-hosting. Same fix shape as the
            // four call sites #4155 already decomposed for TypeKind.Delegate.
            if this
                .context
                .GetTypeInfo(node.Expression)
                .Type is not INamedTypeSymbol enumType ||
                enumType.TypeKind != TypeKind.Enum {
                return false
            }
            let missingValues = HashSet[object](
                enumType
                    .GetMembers()
                    .OfType[IFieldSymbol]()
                    .Where((field IFieldSymbol) -> field.HasConstantValue)
                    .Select((field IFieldSymbol) -> field.ConstantValue!!)
            )
            for label in node.Sections.SelectMany(
                func (section SwitchSectionSyntax) IEnumerable[SwitchLabelSyntax] {
                    return section.Labels
                }
            ) {
                switch label {
                    case DefaultSwitchLabelSyntax {
                        return false
                    }
                    case valueLabel is CaseSwitchLabelSyntax {
                        RemoveConstantValue(valueLabel.Value, missingValues)
                    }
                    case CasePatternSwitchLabelSyntax{WhenClause: nil} patternLabel when IsTotalPattern(
                        patternLabel.Pattern
                    ) {
                        return false
                    }
                    case CasePatternSwitchLabelSyntax{WhenClause: nil} patternLabel {
                        RemoveCoveredPatternValues(patternLabel.Pattern, missingValues)
                    }
                }
            }
            return missingValues.Count > 0
        }

        private func RemoveConstantValue(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            values HashSet[object]
        ) {
            let constant = this.context.SemanticModel.GetConstantValue(expression)
            if constant.HasValue {
                values.Remove(constant.Value!!)
            }
        }

        private func RemoveCoveredPatternValues(
            pattern Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax,
            values HashSet[object]
        ) {
            switch pattern {
                case constant is Microsoft.CodeAnalysis.CSharp.Syntax.ConstantPatternSyntax {
                    this.RemoveConstantValue(constant.Expression, values)
                }
                case binary is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryPatternSyntax when binary.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.OrPattern
                ) {
                    this.RemoveCoveredPatternValues(binary.Left, values)
                    this.RemoveCoveredPatternValues(binary.Right, values)
                }
                case parenthesized is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedPatternSyntax {
                    this.RemoveCoveredPatternValues(parenthesized.Pattern, values)
                }
            }
        }

        private func TranslateSwitchSectionBody(
            section SwitchSectionSyntax,
            ordered IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax],
            injectLabel string? = nil
        ) BlockStatement {
            let statements = List[GStatement]()
            // Recursive local-function state for every section is registered
            // once, up front, by TranslateSwitchStatement (the only caller), so
            // cross-section references see each section's lifts.
            // Issue #4262 follow-up (item 2): mirrors TranslateBlock's own
            // per-statement guarded-field-local-capture loop — a direct
            // early-return guard in a switch-section body leaks to the
            // section's own following statements exactly like a block's does
            // (AddFollowingStatements explicitly supports SwitchSectionSyntax).
            let activeGuardCaptures = Dictionary[ISymbol, Microsoft.CodeAnalysis.CSharp.Syntax.IfStatementSyntax](
                SymbolEqualityComparer.Default
            )
            let capturedNamesInScope = HashSet[string]()
            for statement in ordered {
                statements.AddRange(this.TranslateStatement(statement))
                if statement is Microsoft.CodeAnalysis.CSharp.Syntax.IfStatementSyntax ifStatement {
                    this.EmitGuardedFieldLocalCaptures(
                        ifStatement,
                        activeGuardCaptures,
                        capturedNamesInScope,
                        statements
                    )
                }
            }
            if injectLabel != nil {
                // Issue #1884: this arm is the target of a `goto case`/`goto
                // default` elsewhere in the switch; attach the synthesized
                // label to the first statement (or, for an empty arm, to an
                // empty block) so the goto has something concrete to jump to.
                if statements.Count == 0 {
                    statements.Add(LabeledStatement(injectLabel, BlockStatement(List[GStatement]())))
                } else {
                    statements[0] = LabeledStatement(injectLabel, statements[0])
                }
            }
            return BlockStatement(statements)
        }

        private func TranslateBreakStatement(
            node Microsoft.CodeAnalysis.CSharp.Syntax.BreakStatementSyntax
        ) IEnumerable[GStatement] {
            let target Microsoft.CodeAnalysis.SyntaxNode? = GetBreakTarget(node)
            if target is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchStatementSyntax {
                if IsRedundantSwitchSectionBreak(node) {
                    return Array.Empty[GStatement]()
                }
                // Issue #3501 A3: gsc `break` now exits the enclosing switch
                // (C#/Go alignment), so a non-terminal C# switch break keeps
                // its spelling — no `goto __switchExit` lowering, no trailing
                // exit label.
                return []GStatement{cast[GStatement](BreakStatement())}
            }
            return []GStatement{cast[GStatement](BreakStatement())}
        }

        // Issue #3467: synthesized labels used to embed the syntax node's
        // SpanStart (`__switchExit36386`) — unreadable, and unstable because
        // any upstream edit shifts every label in the file. Labels are instead
        // numbered per enclosing function body in first-use order: the first
        // label of a prefix is bare (`__switchExit`), later ones take an
        // ordinal (`__switchExit2`). Function literals and local functions are
        // their own G# function scopes, so each restarts the numbering.
        private func SyntheticLabelName(prefix string, node Microsoft.CodeAnalysis.SyntaxNode?) string {
            if this.state.SyntheticLabelNames.TryGetValue(node!!, out var existing) {
                return existing
            }
            let scope_ Microsoft.CodeAnalysis.SyntaxNode? = node!!.AncestorsAndSelf().FirstOrDefault(
                (ancestor Microsoft.CodeAnalysis.SyntaxNode) -> ancestor is BaseMethodDeclarationSyntax ||
                    ancestor is AccessorDeclarationSyntax ||
                    ancestor is LocalFunctionStatementSyntax ||
                    ancestor is AnonymousFunctionExpressionSyntax ||
                    ancestor is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .CompilationUnitSyntax
            ) ??
                node
            let key(Scope Microsoft.CodeAnalysis.SyntaxNode?, Prefix string) = (scope_, prefix)
            this.state.SyntheticLabelCounters.TryGetValue(key, out var ordinal)
            ordinal++
            this.state.SyntheticLabelCounters[key] = ordinal
            let name = if ordinal == 1 {
                "__$prefix"
            } else {
                "__$prefix$ordinal"
            }
            this.state.SyntheticLabelNames[node!!] = name
            return name
        }

        private func TranslateYieldStatement(
            node Microsoft.CodeAnalysis.CSharp.Syntax.YieldStatementSyntax
        ) IEnumerable[GStatement] {
            // `yield return x` maps to the G# iterator `yield x` (sample
            // TupleSequenceIterators.gs); the enclosing func's return type is
            // rewritten to `sequence[T]`. `yield break` maps to G#'s native
            // `yield break` (issue #3501), which terminates the iterator from
            // any nesting depth.
            if node.Expression == nil {
                return []GStatement{cast[GStatement](YieldStatement(nil))}
            }
            var value GExpression? = this.TranslateValueWithNullForgiveness(node.Expression)
            let typeInfo = this.context.GetTypeInfo(node.Expression)
            let declaredType ITypeSymbol? = this.GetDeclaredValueType(node.Expression)
            if declaredType?.IsReferenceType == true &&
                declaredType!!.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                typeInfo.ConvertedType is {} convertedType &&
                convertedType.IsReferenceType &&
                convertedType.NullableAnnotation != Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                this
                .context
                .GetSymbolInfo(node.Expression)
                .Symbol is ILocalSymbol yieldedLocal &&
                yieldedLocal
                .DeclaringSyntaxReferences
                .Any((reference SyntaxReference) -> reference.GetSyntax() is ForEachStatementSyntax) &&
                typeInfo
                .Nullability
                .FlowState == Microsoft
                .CodeAnalysis
                .NullableFlowState
                .NotNull {
                // Preserve the non-null iterator element type through lowering;
                // ordinary locals need no assertion at this seam.
                value = EnsureNonNullAssertion(value)
            }
            // Issue #3501: a yield is a VALUE seam against the iterator's
            // element type (the yield expression's C# converted type), exactly
            // like an argument against its parameter — a promoted-nullable
            // value (`yield Canonical(called)` where `Canonical` returns
            // `ISymbol?`) flowing into a non-null element needs the same `!!`
            // bridge the argument path inserts. Tuple literals bridge
            // per-element (`yield (field, true)` where a Try-out-var is
            // `FieldDeclaration?` but the element is `(GMember, bool)`).
            let enclosingIterator IMethodSymbol? = this
                .context
                .SemanticModel
                .GetEnclosingSymbol(node.SpanStart) as IMethodSymbol
            if node.Expression is TupleExpressionSyntax tupleValue &&
                typeInfo.ConvertedType is INamedTypeSymbol{IsTupleType: true} tupleTarget &&
                value is TupleLiteralExpression tupleLiteral &&
                tupleValue
                .Arguments
                .Count == tupleTarget
                .TupleElements
                .Length &&
                tupleLiteral
                .Elements
                .Count == tupleValue
                .Arguments
                .Count {
                let bridged = List[GExpression](tupleLiteral.Elements.Count)
                for var i = 0; i < tupleLiteral.Elements.Count; i++ {
                    bridged.Add(
                        this.ForgiveNullableReferenceValue(
                            tupleValue.Arguments[i].Expression,
                            tupleLiteral.Elements[i],
                            tupleTarget.TupleElements[i].Type,
                            enclosingIterator,
                            includePromotedValue: true,
                            reportedSlotType: tupleTarget.TupleElements[i].Type
                        )!!
                    )
                }
                value = TupleLiteralExpression(bridged)
            } else {
                var elementType = typeInfo.ConvertedType
                if elementType != nil {
                    elementType = if enclosingIterator == nil {
                        elementType
                    } else {
                        this.GetIteratorStoreSlot(node.Expression, enclosingIterator) ?? elementType
                    }
                    value = this.ForgiveNullableReferenceValue(
                        node.Expression,
                        value,
                        elementType,
                        enclosingIterator,
                        includePromotedValue: true
                    )
                }
            }
            // At statement position the parser reads `yield (` as a tuple
            // yield, not as an arbitrary parenthesized expression (#4705).
            // The printed text is the single source of truth: only a value
            // whose rendering starts with `(` and is not a tuple literal needs
            // to be materialized, keeping the expression's target type and
            // iterator-time evaluation. A rendering that starts with a nonempty
            // `[` (a sized array creation, `[3]T`) is materialized for the same
            // reason: `yield [` parses as indexing a variable named `yield`.
            // Everything else prints inline.
            //
            // The one other reason to materialize: a target-typed value (a branching expression or a lambda)
            // needs the iterator element type as its target (a common type for
            // `b ? s : n` into `object`, user conversions inside tuple leaves,
            // #4719), which a bare `yield if ...` does not provide because G#
            // binds yield operands without the element type.
            if !(value is TupleLiteralExpression) &&
                (
                YieldValuePrintsAmbiguously(GSharpPrinter.RenderExpressionText(value)) ||
                    (
                    value is IfExpression ||
                        value is SwitchExpression ||
                        value is IfLetExpression ||
                        value is BlockExpression ||
                        value is LambdaExpression
                )
            ) {
                let name = this.FreshYieldedValueName(node)
                var type GTypeReference? = nil
                if typeInfo.ConvertedType is {} yieldType {
                    type = this.typeMapper.Map(yieldType, this.context, node.Expression!!.GetLocation())
                    type = this.PromoteTupleDeclarationIfTainted(type, yieldType, enclosingIterator)
                    type = this.PromoteAwaitedReturnIfTainted(type, yieldType, enclosingIterator)
                }
                return []GStatement{
                    LocalDeclarationStatement(BindingKind.Let, name, type, initializer: value),
                    YieldStatement(IdentifierExpression(name))
                }
            }
            return []GStatement{cast[GStatement](YieldStatement(value))}
        }

        // The hoisted local gets a readable name (`item`, `item_2`, ...). It is
        // claimed through the shared synthesized-local mechanism, so it cannot
        // collide with a source identifier in the body or with a local other
        // passes synthesized (guard captures, spills); it must also not shadow
        // any symbol visible at the yield.
        private func FreshYieldedValueName(node Microsoft.CodeAnalysis.CSharp.Syntax.YieldStatementSyntax) string {
            let stem = "item"
            var candidate = stem
            for var suffix = 2;
                !this
                .context
                .SemanticModel
                .LookupSymbols(node.SpanStart, name: candidate)
                .IsEmpty ||
                !this.TryClaimSynthesizedLocalName(candidate, node); suffix++ {
                candidate = "${stem}_$suffix"
            }
            return candidate
        }

        private func TranslateForEachVariable(node ForEachVariableStatementSyntax) GStatement {
            // `foreach (var (a, b) in xs)` is a C# TUPLE DECONSTRUCTION over a
            // sequence whose element is a tuple. G#'s two-name `for k, v in xs`
            // form is NOT tuple deconstruction — it is index/element iteration
            // (the key is the int32 index), so emitting `for a, b in xs` would
            // bind `a` to the loop index. Issue #1922: G# now has a first-class
            // deconstructing loop header, `for (a, b) in xs { <body> }`, so a
            // synchronous foreach translates directly to that instead of a
            // hidden temp variable plus a separate `let (a, b) = tmp` (ADR-0115
            // §B's older form). G# has no first-class `await for (a, b) in`
            // form, so `await foreach` keeps the older temp+let lowering.
            let names = List[string]()
            CollectForEachVariableNames(node.Variable, names)
            let forEachInfo = this.context.SemanticModel.GetForEachStatementInfo(node)
            let projectedElement ITypeSymbol? = this.GetProjectedForEachElementType(node, forEachInfo)
            let nullableBindings = List[ISymbol]()
            let projectedBindings = List[ILocalSymbol]()
            if projectedElement != nil && forEachInfo.ElementType != nil {
                this.CollectProjectedForEachVariableBindings(
                    node.Variable,
                    projectedElement,
                    forEachInfo.ElementType,
                    nullableBindings,
                    projectedBindings
                )
            }
            if names.Count >= 2 {
                let isAwait = !node.AwaitKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.None)
                var body BlockStatement
                try {
                    body = this.TranslateStatementAsBlock(node.Statement)
                } finally {
                    for binding in nullableBindings {
                        this.state.NullableForEachBindings.Remove(binding)
                    }
                    for binding in projectedBindings {
                        this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType.Remove(binding)
                    }
                }
                let iterable GExpression? = this.TranslateReceiverWithNullForgiveness(node.Expression)
                if !isAwait {
                    return ForTupleInStatement(names, iterable, body)
                }
                let firstName string? = names.FirstOrDefault((name string) -> name != "_")
                let preferredName = if firstName != nil {
                    firstName + "Item"
                } else {
                    "deconstructedItem"
                }
                let pair = this.AllocateDeconstructionTempName(node.Variable, preferredName)
                let statements = List[GStatement](body.Statements.Count + 1){TupleDeconstructionStatement(
                        BindingKind.Let,
                        names,
                        IdentifierExpression(pair)
                    )
                }
                statements.AddRange(body.Statements)
                return ForInStatement(pair, iterable, BlockStatement(statements), isAwait: true)
            }
            for binding in nullableBindings {
                this.state.NullableForEachBindings.Remove(binding)
            }
            for binding in projectedBindings {
                this.state.ManagedReferenceArrayNullable.ManagedReferenceArrayProjectedLocalType.Remove(binding)
            }
            this.context.ReportUnsupported(
                node,
                "foreach tuple deconstruction with arity < 2 has no canonical G# form yet (ADR-0115 §B)."
            )
            return RawStatement("// unsupported: foreach variable deconstruction")
        }

        private func CollectProjectedForEachVariableBindings(
            variable Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            projectedSource ITypeSymbol,
            destination ITypeSymbol?,
            nullableBindings List[ISymbol],
            projectedBindings List[ILocalSymbol]
        ) {
            switch variable {
                case declaration is DeclarationExpressionSyntax {
                    this.CollectProjectedForEachVariableBindings(
                        declaration.Designation,
                        projectedSource,
                        destination,
                        nullableBindings,
                        projectedBindings
                    )
                }
                case tuple is TupleExpressionSyntax when projectedSource is INamedTypeSymbol{
                    IsTupleType: true
                } sourceTuple &&
                    destination is INamedTypeSymbol{IsTupleType: true} destinationTuple &&
                    tuple
                    .Arguments
                    .Count == sourceTuple
                    .TupleElements
                    .Length &&
                    tuple
                    .Arguments
                    .Count == destinationTuple
                    .TupleElements
                    .Length {
                    for var i = 0; i < tuple.Arguments.Count; i++ {
                        this.CollectProjectedForEachVariableBindings(
                            tuple.Arguments[i].Expression,
                            GetEffectiveTupleElementType(sourceTuple, i),
                            GetEffectiveTupleElementType(destinationTuple, i),
                            nullableBindings,
                            projectedBindings
                        )
                    }
                }
            }
        }

        private func CollectProjectedForEachVariableBindings(
            designation VariableDesignationSyntax,
            projectedSource ITypeSymbol,
            destination ITypeSymbol?,
            nullableBindings List[ISymbol],
            projectedBindings List[ILocalSymbol]
        ) {
            var destination = destination
            switch designation {
                case single is SingleVariableDesignationSyntax when this.context.GetDeclaredSymbol(
                    single
                ) is ILocalSymbol symbol {
                    destination = symbol.Type
                    let projectedType ITypeSymbol? = this.GetProjectedBindingType(
                        projectedSource,
                        destination,
                        this.context.Compilation.ClassifyConversion(projectedSource, destination)
                    ) ??
                        destination
                    if !SymbolEqualityComparer.IncludeNullability.Equals(symbol.Type, projectedType) {
                        this
                            .state
                            .ManagedReferenceArrayNullable
                            .ManagedReferenceArrayProjectedLocalType[symbol] = projectedType
                        projectedBindings.Add(symbol)
                    }
                    if projectedType?.NullableAnnotation == Microsoft
                        .CodeAnalysis
                        .NullableAnnotation
                        .Annotated &&
                        this.IsReferenceLikeOrManagedReference(projectedType) &&
                        this
                        .state
                        .NullableForEachBindings
                        .Add(symbol) {
                        nullableBindings.Add(symbol)
                    }
                }
                case tuple is ParenthesizedVariableDesignationSyntax when projectedSource is INamedTypeSymbol{
                    IsTupleType: true
                } sourceTuple &&
                    destination is INamedTypeSymbol{IsTupleType: true} destinationTuple &&
                    tuple
                    .Variables
                    .Count == sourceTuple
                    .TupleElements
                    .Length &&
                    tuple
                    .Variables
                    .Count == destinationTuple
                    .TupleElements
                    .Length {
                    for var i = 0; i < tuple.Variables.Count; i++ {
                        this.CollectProjectedForEachVariableBindings(
                            tuple.Variables[i],
                            GetEffectiveTupleElementType(sourceTuple, i),
                            GetEffectiveTupleElementType(destinationTuple, i),
                            nullableBindings,
                            projectedBindings
                        )
                    }
                }
            }
        }

        private func CollectForEachVariableNames(
            variable Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            names List[string]
        ) {
            switch variable {
                case tuple is TupleExpressionSyntax {
                    for argument in tuple.Arguments {
                        CollectForEachVariableNames(argument.Expression, names)
                    }
                }
                case declaration is DeclarationExpressionSyntax {
                    CollectDesignationNames(declaration.Designation, names)
                }
                case identifier is IdentifierNameSyntax {
                    names.Add(this.EmittedName(identifier, identifier.Identifier)!!)
                }
            }
        }

        private func CollectDesignationNames(designation VariableDesignationSyntax, names List[string]) {
            switch designation {
                case single is SingleVariableDesignationSyntax {
                    names.Add(this.EmittedName(single, single.Identifier)!!)
                }
                case DiscardDesignationSyntax {
                    names.Add("_")
                }
                case parenthesized is ParenthesizedVariableDesignationSyntax {
                    for child in parenthesized.Variables {
                        CollectDesignationNames(child, names)
                    }
                }
            }
        }

        private func TranslatePattern(
            pattern Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax?,
            receiver GExpression?,
            bindings List[(Symbol ISymbol, Replacement GExpression)],
            usedDesignators HashSet[string]?,
            guards List[GExpression],
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]? = nil
        ) GPattern? {
            switch pattern {
                case constant is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConstantPatternSyntax when this.IsTypeReferencePattern(constant.Expression) {
                    return this.BuildPatternTypeTest("_", constant.Expression, constant)
                }
                case constant is Microsoft.CodeAnalysis.CSharp.Syntax.ConstantPatternSyntax {
                    return ConstantPattern(this.TranslateExpression(constant.Expression))
                }
                case relational is Microsoft.CodeAnalysis.CSharp.Syntax.RelationalPatternSyntax {
                    return RelationalPattern(
                        relational.OperatorToken.Text,
                        this.TranslateExpression(relational.Expression)
                    )
                }
                case Microsoft.CodeAnalysis.CSharp.Syntax.DiscardPatternSyntax {
                    // The discard arm (`_ =>`) is the G# `default:` arm.
                    return nil
                }
                case declaration is DeclarationPatternSyntax when declaration.Designation is SingleVariableDesignationSyntax variable {
                    return this.BuildPatternTypeTest(
                        this.EmittedName(variable, variable.Identifier),
                        declaration.Type,
                        declaration
                    )
                }
                case declaration is DeclarationPatternSyntax when declaration.Designation is DiscardDesignationSyntax {
                    return this.BuildPatternTypeTest("_", declaration.Type, declaration)
                }
                case typePattern is Microsoft.CodeAnalysis.CSharp.Syntax.TypePatternSyntax {
                    return this.BuildPatternTypeTest("_", typePattern.Type, typePattern)
                }
                case varPattern is Microsoft.CodeAnalysis.CSharp.Syntax.VarPatternSyntax {
                    if varPattern.Designation is ParenthesizedVariableDesignationSyntax {
                        this.context.ReportUnsupported(
                            varPattern,
                            "var pattern with tuple designation ('var (a, b)') has no canonical G# form yet (ADR-0115 §B)."
                        )
                        return DiscardPattern()
                    }
                    if mutableBindings != nil &&
                        varPattern.Designation is SingleVariableDesignationSyntax mutableVariable &&
                        this
                        .context
                        .GetDeclaredSymbol(mutableVariable) is ILocalSymbol mutableSymbol && this.IsSymbolReassigned(
                        mutableSymbol,
                        this.state.CurrentBodyScope ?? varPattern.SyntaxTree.GetRoot()
                    ) {
                        let captureName = this.NewMutableSwitchPatternCaptureName(varPattern, usedDesignators)
                        mutableBindings.Add((mutableSymbol, IdentifierExpression(captureName)))
                        return VarPattern(captureName)
                    }
                    return VarPattern(
                        if varPattern.Designation is SingleVariableDesignationSyntax varVariable {
                            this.EmittedName(varVariable, varVariable.Identifier)
                        } else {
                            "_"
                        }
                    )
                }
                case RecursivePatternSyntax{Type: {} type} recursive when this
                    .state
                    .TranslatingBooleanPattern &&
                    !PatternIntroducesBinding(recursive) {
                    let nativeTypePattern = this.BuildPatternTypeTest("_", type, recursive)
                    if recursive.PropertyPatternClause == nil && recursive.PositionalPatternClause == nil {
                        return nativeTypePattern
                    }
                    return BinaryPattern(
                        isConjunction: true,
                        nativeTypePattern,
                        this.TranslateRecursivePattern(
                            recursive,
                            receiver,
                            bindings,
                            usedDesignators,
                            guards,
                            mutableBindings,
                            treatAsUntyped: true
                        )
                    )
                }
                case recursive is RecursivePatternSyntax {
                    return this.TranslateRecursivePattern(
                        recursive,
                        receiver,
                        bindings,
                        usedDesignators,
                        guards,
                        mutableBindings
                    )
                }
                case binary is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .BinaryPatternSyntax when binary
                    .OperatorToken
                    .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AndKeyword) || binary.OperatorToken.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.OrKeyword
                ) {
                    return BinaryPattern(
                        binary.OperatorToken.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AndKeyword),
                        this.TranslatePattern(
                            binary.Left,
                            receiver,
                            bindings,
                            usedDesignators,
                            guards,
                            mutableBindings
                        ),
                        this.TranslatePattern(
                            binary.Right,
                            receiver,
                            bindings,
                            usedDesignators,
                            guards,
                            mutableBindings
                        )
                    )
                }
                case unary is UnaryPatternSyntax when unary.OperatorToken.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.NotKeyword
                ) {
                    return NotPattern(
                        this.TranslatePattern(
                            unary.Pattern,
                            receiver,
                            bindings,
                            usedDesignators,
                            guards,
                            mutableBindings
                        )
                    )
                }
                case parenthesized is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedPatternSyntax {
                    return ParenthesizedPattern(
                        this.TranslatePattern(
                            parenthesized.Pattern,
                            receiver,
                            bindings,
                            usedDesignators,
                            guards,
                            mutableBindings
                        )
                    )
                }
                case listPattern is Microsoft.CodeAnalysis.CSharp.Syntax.ListPatternSyntax {
                    return this.TranslateListPattern(
                        listPattern,
                        receiver,
                        bindings,
                        usedDesignators,
                        guards,
                        mutableBindings
                    )
                }
                default {
                    this.context.ReportUnsupported(
                        pattern,
                        "pattern '${pattern!!.Kind()}' has no canonical G# form yet (ADR-0115 §B)."
                    )
                    return DiscardPattern()
                }
            }
        }

        private func TranslateSwitchPattern(
            pattern Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax,
            receiver GExpression?,
            bindings List[(Symbol ISymbol, Replacement GExpression)],
            usedDesignators HashSet[string],
            guards List[GExpression],
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]
        ) GPattern? {
            if pattern is RecursivePatternSyntax &&
                pattern.Type != nil &&
                pattern.PropertyPatternClause != nil &&
                PatternIntroducesBinding(pattern) &&
                this
                .IsNativelyExpressiblePattern(pattern, topLevel: true) {
                let scope_ = this.state.CurrentBodyScope ?? pattern.SyntaxTree.GetRoot()
                let locals = pattern
                    .DescendantNodesAndSelf()
                    .OfType[SingleVariableDesignationSyntax]()
                    .Select(
                    (designation SingleVariableDesignationSyntax) -> this.context.GetDeclaredSymbol(designation)
                )
                    .OfType[ILocalSymbol]()
                    .ToList()
                if locals.All((local ILocalSymbol) -> !this.IsSymbolReassigned(local, scope_)) {
                    let nativeBinders = List[ILocalSymbol]()
                    let native = this.BuildNativePattern(pattern, nativeBinders)
                    for binder in nativeBinders {
                        bindings.Add((binder, IdentifierExpression(this.EmittedName(binder, binder.Name))))
                    }
                    return native
                }
            }
            return this.TranslatePattern(pattern, receiver, bindings, usedDesignators, guards, mutableBindings)
        }

        // Issue #1889: G# has a native list pattern (spec §Pattern matching,
        // ListPatternSyntax/SlicePatternSyntax) that structurally matches an
        // array/slice element-by-element — unlike the property/positional-
        // pattern branches above, no manual member-test composition is needed;
        // gsc's own pattern binder tests length and element shape at runtime.
        // Each non-slice, non-discard element recurses through the shared
        // `TranslatePattern`, so `var` and declaration binders keep their native
        // pattern form at the element read from the start or end.
        private func TranslateListPattern(
            listPattern Microsoft.CodeAnalysis.CSharp.Syntax.ListPatternSyntax,
            receiver GExpression?,
            bindings List[(Symbol ISymbol, Replacement GExpression)],
            usedDesignators HashSet[string]?,
            guards List[GExpression],
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]?
        ) GPattern {
            let elements = listPattern.Patterns
            let sliceIndex = FindSlicePatternIndex(elements)
            let lengthAccess = MemberAccessExpression(receiver, "Length")
            let translated = List[GPattern](elements.Count)
            for var i = 0; i < elements.Count; i++ {
                let element = elements[i]
                if element is Microsoft.CodeAnalysis.CSharp.Syntax.SlicePatternSyntax slice {
                    translated.Add(
                        this.TranslateSlicePattern(
                            slice,
                            receiver,
                            i,
                            elements.Count - i - 1,
                            bindings,
                            usedDesignators,
                            guards,
                            mutableBindings
                        )
                    )
                    continue
                }
                if element is Microsoft.CodeAnalysis.CSharp.Syntax.DiscardPatternSyntax {
                    translated.Add(DiscardPattern())
                    continue
                }
                let elementReceiver = this.BuildListElementReceiver(
                    receiver,
                    lengthAccess,
                    i,
                    elements.Count,
                    sliceIndex
                )
                translated.Add(
                    this.TranslatePattern(
                        element,
                        elementReceiver,
                        bindings,
                        usedDesignators,
                        guards,
                        mutableBindings
                    )!!
                )
            }
            return ListPattern(translated)
        }

        // Issue #1889: a named capture (`.. var rest`/`.. T rest`) binds directly
        // to G#'s own slice-capture designator (`..rest`) — a REAL runtime
        // binding: the captured name IS the designator, so references to it in
        // the arm body resolve naturally. A nested
        // subpattern (`..[> 0]`) recurses through `TranslatePattern` against the
        // materialized slice value, matching G#'s own `SlicePattern.Pattern`
        // (spec §Pattern matching). A bare `..` carries neither.
        private func TranslateSlicePattern(
            slice Microsoft.CodeAnalysis.CSharp.Syntax.SlicePatternSyntax,
            receiver GExpression?,
            prefixCount int32,
            suffixCount int32,
            bindings List[(Symbol ISymbol, Replacement GExpression)],
            usedDesignators HashSet[string]?,
            guards List[GExpression],
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]?
        ) GPattern {
            switch slice.Pattern {
                case nil {
                    return SlicePattern(designator: nil)
                }
                case Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .VarPatternSyntax{Designation: SingleVariableDesignationSyntax variable} {
                    if mutableBindings != nil && this.context.GetDeclaredSymbol(
                        variable
                    ) is ILocalSymbol mutableSymbol &&
                        this
                        .IsSymbolReassigned(mutableSymbol, this.state.CurrentBodyScope ?? slice.SyntaxTree.GetRoot()) {
                        let captureName = this.NewMutableSwitchPatternCaptureName(slice, usedDesignators)
                        mutableBindings.Add((mutableSymbol, IdentifierExpression(captureName)))
                        return SlicePattern(captureName)
                    }
                    return SlicePattern(this.EmittedName(variable, variable.Identifier))
                }
                case varPatternSyntax is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .VarPatternSyntax when varPatternSyntax.Designation is DiscardDesignationSyntax {
                    return SlicePattern(designator: nil)
                }
                case varTuple is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .VarPatternSyntax when varTuple.Designation is ParenthesizedVariableDesignationSyntax {
                    this.context.ReportUnsupported(
                        varTuple,
                        "var pattern with tuple designation ('var (a, b)') has no canonical G# form yet (ADR-0115 §B)."
                    )
                    return SlicePattern(designator: nil)
                }
                case DeclarationPatternSyntax{Designation: SingleVariableDesignationSyntax declVariable} {
                    // G#'s slice capture designator is always typed as the
                    // slice's own `[]T`, so the (redundant) C# declared type is
                    // dropped — same bind-only treatment as the `var` capture above.
                    return SlicePattern(this.EmittedName(declVariable, declVariable.Identifier))
                }
                default {
                    let sliceValue = BuildSliceExpression(receiver, prefixCount, suffixCount)
                    return SlicePattern(
                        designator: nil,
                        this.TranslatePattern(
                            slice.Pattern,
                            sliceValue,
                            bindings,
                            usedDesignators,
                            guards,
                            mutableBindings
                        )
                    )
                }
            }
        }

        private func TranslateRecursivePattern(
            recursive RecursivePatternSyntax?,
            receiver GExpression?,
            bindings List[(Symbol ISymbol, Replacement GExpression)],
            usedDesignators HashSet[string]?,
            guards List[GExpression],
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]? = nil,
            treatAsUntyped bool = false
        ) GPattern {
            // A pure property pattern (`{ A: 0, B: 0 }`) with no type maps to the
            // G# property pattern; a typed recursive pattern (`Circle { Radius: var r }`)
            // maps to a type pattern whose designator is the binding receiver.
            if treatAsUntyped || recursive!!.Type == nil {
                let fields = List[PropertyPatternField]()
                if recursive!!.PropertyPatternClause != nil {
                    let extendedFieldTrees = Dictionary[string, ExtendedPropertyFieldTree]()
                    let extendedFieldRootOrder = List[string]()
                    for sub in recursive!!.PropertyPatternClause!!.Subpatterns {
                        if sub.NameColon != nil {
                            let rawFieldName string? = this.GetSubpatternMemberName(sub)
                            let memberSymbol ISymbol? = this.GetPatternMemberSymbol(sub.NameColon!!.Name)
                            var fieldName string? = this.EmittedName(memberSymbol, rawFieldName)
                            fieldName = this.TranslateAnalyzerPatternFieldName(recursive, sub, fieldName)
                            fields.Add(
                                PropertyPatternField(
                                    fieldName,
                                    this.TranslatePattern(
                                        sub.Pattern,
                                        MemberAccessExpression(receiver, fieldName),
                                        bindings,
                                        usedDesignators,
                                        guards,
                                        mutableBindings
                                    )
                                )
                            )
                            continue
                        }
                        if sub.ExpressionColon != nil {
                            // Issue #1891: an extended property subpattern
                            // (`Start.X: 0`) parses as `ExpressionColon`, not
                            // `NameColon`. G#'s property-pattern field is a single
                            // identifier (no dotted member path), so the chain
                            // lowers to nested `PropertyPattern`s instead —
                            // `Start.X: 0` becomes `Start: { X: 0 }`, agreeing
                            // with the nested-pattern form a user could already
                            // write directly. Works to any chain depth.
                            //
                            // Issue #1971: multiple subpatterns sharing a
                            // leftmost identifier (`{ A.B: 0, A.C: 1 }`) must
                            // merge into ONE nested field (`{ A: { B: 0, C: 1 } }`)
                            // instead of emitting the top-level field `A` twice —
                            // grouped here via `extendedFieldTrees`, keyed by the
                            // sanitized root identifier, and converted once all
                            // subpatterns have been scanned. `fields` reserves the
                            // root's position at its FIRST occurrence so field
                            // order still matches the source.
                            let names = SplitMemberPath(sub.ExpressionColon!!.Expression)
                            let rootName = names[0]
                            if !extendedFieldTrees.TryGetValue(rootName, out var tree) {
                                tree = ExtendedPropertyFieldTree()
                                extendedFieldTrees[rootName] = tree
                                extendedFieldRootOrder.Add(rootName)
                                fields.Add(default(PropertyPatternField)) // placeholder, filled in after the loop

                            }
                            tree.Insert(names, 1, sub.Pattern)
                            continue
                        }
                        this.context.ReportUnsupported(
                            sub,
                            "positional subpattern has no canonical G# form yet (ADR-0115 §B)."
                        )
                    }
                    if extendedFieldRootOrder.Count > 0 {
                        var placeholderIndex = 0
                        for rootName in extendedFieldRootOrder {
                            while fields[placeholderIndex] != nil {
                                placeholderIndex++
                            }
                            let tree = extendedFieldTrees[rootName]
                            if tree.HasCollision {
                                // Bug (N1, Opus review of #1971): a path segment
                                // that is BOTH a leaf value check (`A.B: 0`) AND
                                // a nested-member check (`A.B.C: 1`) at the same
                                // name cannot be merged into a single
                                // PropertyPattern field — one side would have to
                                // be silently dropped. Per ADR-0115 ("never
                                // guess"), report the gap loudly instead of
                                // guessing which side to keep, and fall back to
                                // an empty nested field for '{rootName}' so the
                                // merge optimization doesn't emit a
                                // semantically-wrong pattern.
                                this.context.ReportUnsupported(
                                    recursive!!.PropertyPatternClause,
                                    "extended property pattern mixes a direct value check and a nested member check on the same path segment '${tree.CollisionSegment}' (rooted at '$rootName'); not supported."
                                )
                                fields[placeholderIndex] = PropertyPatternField(
                                    rootName,
                                    PropertyPattern(List[PropertyPatternField]())
                                )
                                continue
                            }
                            let childFields = tree.ConvertChildren(
                                this,
                                MemberAccessExpression(receiver, rootName),
                                bindings,
                                usedDesignators,
                                guards,
                                mutableBindings
                            )
                            fields[placeholderIndex] = PropertyPatternField(rootName, PropertyPattern(childFields))
                        }
                    }
                }
                if recursive!!.PositionalPatternClause != nil {
                    // Issue #1887: a bare positional pattern arm (`(0, 0) =>`,
                    // `(0, _) or (>0, >0) =>`) has no type prefix, so — same as
                    // the untyped property-pattern branch above — it lowers to a
                    // G# property pattern whose fields are the tuple/record
                    // members each position deconstructs to.
                    let subs = recursive!!.PositionalPatternClause!!.Subpatterns
                    let positional PositionalSlots? = this.TryGetPositionalMembers(
                        recursive,
                        subs.Count,
                        out var positionalFailure
                    )
                    for var i = 0; i < subs.Count; i++ {
                        let sub = subs[i]
                        if sub.Pattern is Microsoft.CodeAnalysis.CSharp.Syntax.DiscardPatternSyntax {
                            // A discard position (`(0, _)`) imposes no constraint —
                            // same as an omitted field in a property pattern — so
                            // it contributes no field at all.
                            continue
                        }
                        if !this.TryResolvePositionalSlot(
                            sub,
                            i,
                            positional,
                            positionalFailure,
                            if recursive!!.Type != nil {
                                this.context.GetTypeInfo(recursive!!.Type).Type
                            } else {
                                default(ITypeSymbol?)
                            },
                            out var memberName,
                            out var memberSymbol,
                            out var slotFailure
                        ) {
                            this.context.ReportUnsupported(
                                sub,
                                PositionalSubpatternGapMessage("positional subpattern", slotFailure)
                            )
                            continue
                        }
                        let emittedMemberName string? = this.EmittedName(memberSymbol, memberName)
                        fields.Add(
                            PropertyPatternField(
                                emittedMemberName,
                                this.TranslatePattern(
                                    sub.Pattern,
                                    MemberAccessExpression(receiver, emittedMemberName),
                                    bindings,
                                    usedDesignators,
                                    guards,
                                    mutableBindings
                                )
                            )
                        )
                    }
                }
                // A designation on the (possibly nested) untyped property
                // pattern (`{ ClrType: { IsGenericType: true } closedClr }`)
                // maps to G#'s native ADR-0166 designator after the closing
                // brace — dropping it orphans every body reference to the
                // binder (the nightly selfmig regression on
                // TupleElementNamesReader.cs).
                var propertyDesignator string? = nil
                if recursive!!.Designation is SingleVariableDesignationSyntax propertyVariable {
                    propertyDesignator = this.EmittedName(propertyVariable, propertyVariable.Identifier)
                    if mutableBindings != nil && this.context.GetDeclaredSymbol(
                        propertyVariable
                    ) is ILocalSymbol propertySymbol &&
                        this
                        .IsSymbolReassigned(
                        propertySymbol,
                        this.state.CurrentBodyScope ?? recursive!!.SyntaxTree.GetRoot()
                    ) {
                        let captureName = this.NewMutableSwitchPatternCaptureName(recursive, usedDesignators)
                        mutableBindings.Add((propertySymbol, IdentifierExpression(captureName)))
                        propertyDesignator = captureName
                    } else {
                        usedDesignators?.Add(propertyDesignator!!)
                    }
                } else if recursive!!.Designation is ParenthesizedVariableDesignationSyntax {
                    this.context.ReportUnsupported(
                        recursive,
                        "property pattern with tuple designation has no canonical G# form yet (ADR-0115 §B)."
                    )
                }
                return PropertyPattern(fields, propertyDesignator)
            }
            // Typed recursive pattern: synthesize a designator named after the type
            // (`circle`), and rewrite each `Name: var x` property binding to a
            // member access on that designator (`circle.Radius`). The synthesized
            // designator is derived from the right-most identifier token of the
            // type syntax (not `Type.ToString()`, which yields an invalid
            // identifier for a qualified/generic type such as `Ns.Circle` or
            // `List<int>`), and sanitized like every other declared/synthesized
            // name so a keyword-colliding designator agrees with its references
            // (issue #1734).
            // Issue #1839 (N3): two typed recursive subpatterns within the SAME
            // arm/scope (e.g. `Ns.Circle or Other.Circle`) can synthesize the
            // identical designator from their distinct rightmost simple names,
            // which would silently shadow one another as two `circle` locals.
            // Uniquify on collision within this arm's shared `usedDesignators`
            // scope (threaded alongside `bindings`) rather than emitting a
            // colliding declaration.
            let designator string? = if recursive!!.Designation is SingleVariableDesignationSyntax named {
                Uniquify(this.EmittedName(named, named.Identifier), usedDesignators)
            } else {
                this.SynthesizePatternDesignator(recursive, usedDesignators)
            }
            if recursive!!.PropertyPatternClause != nil {
                for sub in recursive!!.PropertyPatternClause!!.Subpatterns {
                    // Issue #4356: an extended subpattern (`Clause.Items.Count: > 0`)
                    // takes the same lowering as its `is`-expression spelling,
                    // which guards each nullable link (Roslyn-annotated or, in
                    // analyzer mode, `T?` only on the G# API) and reads it once.
                    // A flat `d.Clause.Items.Count` chain threw where C# falls
                    // through on a nil link, and bound only through gsc's old
                    // member-lookup carve-out for stated-nullable chains. A bare
                    // `var`/discard leaf adds no test of its own, but C# still
                    // requires every intermediate link to be non-nil
                    // (`Clause.Items: _` does not match a nil `Clause`), so it
                    // takes the guarded lowering too whenever a link is
                    // nullable; only an all-non-nullable path keeps the flat
                    // binding below.
                    if sub.ExpressionColon != nil &&
                        (
                        sub.Pattern is not(
                            Microsoft
                                .CodeAnalysis
                                .CSharp
                                .Syntax
                                .VarPatternSyntax or
                                Microsoft
                                .CodeAnalysis
                                .CSharp
                                .Syntax
                                .DiscardPatternSyntax
                        ) ||
                            this.ExtendedPathHasNullableLink(sub.ExpressionColon!!.Expression)
                    ) {
                        this.AddTypedSubpatternGuard(
                            () -> this.TranslateExtendedPropertyMemberTest(
                                sub.ExpressionColon!!.Expression,
                                sub.Pattern,
                                IdentifierExpression(designator)
                            ),
                            bindings,
                            guards,
                            mutableBindings
                        )
                        continue
                    }
                    let memberPath List[string]? = if sub.NameColon != nil {
                        List[string]{
                            this.EmittedName(
                                this.GetPatternMemberSymbol(sub.NameColon!!.Name),
                                this.GetSubpatternMemberName(sub)
                            )!!
                        }
                    } else {
                        (
                            if sub.ExpressionColon != nil {
                                SplitMemberPath(sub.ExpressionColon!!.Expression)
                            } else {
                                default(List[string]?)
                            }
                        )
                    }
                    if memberPath == nil {
                        this.context.ReportUnsupported(
                            sub,
                            "typed property subpattern has no member path (ADR-0115 §B)."
                        )
                        continue
                    }
                    var memberAccess GExpression = IdentifierExpression(designator)
                    for memberName in memberPath {
                        memberAccess = MemberAccessExpression(memberAccess, memberName)
                    }
                    let memberType ITypeSymbol? = if sub.NameColon != nil {
                        this.RegisterPatternMemberSlot(this.GetPatternMemberSymbol(sub.NameColon!!.Name), memberAccess)
                    } else {
                        default(ITypeSymbol?)
                    }
                    this.AddTypedSubpatternTest(
                        sub.Pattern,
                        memberAccess,
                        bindings,
                        guards,
                        mutableBindings,
                        memberType
                    )
                }
            }
            if recursive!!.PositionalPatternClause != nil {
                // Issue #1887: a TYPED recursive pattern (`Point(0, 0)`, `Point(var
                // x, var y)`) lowers to a `TypePattern` GPattern node, which — same
                // as the typed property-pattern branch above — carries only a
                // designator and a type, no room for an extra equality/relational
                // test. A `var` positional subpattern still binds cleanly (a member
                // access on the designator).
                //
                // Issue #1943: anything else (a constant/relational/nested
                // positional subpattern, e.g. `Point(0, 0)`, `Point(> 0, _)`)
                // generalizes the same lowering the untyped bare-tuple arm form
                // already uses (`TranslateRecursivePatternTest`'s
                // `PositionalPatternClause` loop) — a boolean member-access test —
                // but since a `TypePattern` has no room for it, the test is
                // appended to the arm's `guards` list instead, to be AND-ed with
                // any explicit `when` clause by the caller (`case Point p when
                // p.X == 0 && p.Y == 0:`). Any designator a nested subpattern
                // binds (e.g. `Point(Sub(var a, 0), _)`) is captured into
                // `bindings` the same way the property-pattern loop above does,
                // so it is installed/removed on the same schedule as every other
                // arm-scoped binding.
                let subs = recursive!!.PositionalPatternClause!!.Subpatterns
                let positional PositionalSlots? = this.TryGetPositionalMembers(
                    recursive,
                    subs.Count,
                    out var positionalFailure
                )
                for var i = 0; i < subs.Count; i++ {
                    let sub = subs[i]
                    if sub.Pattern is Microsoft.CodeAnalysis.CSharp.Syntax.DiscardPatternSyntax {
                        // A discard position (`Point(0, _)`) imposes no
                        // constraint and binds nothing, so no field is needed.
                        continue
                    }
                    if !this.TryResolvePositionalSlot(
                        sub,
                        i,
                        positional,
                        positionalFailure,
                        this.context.GetTypeInfo(recursive!!.Type).Type,
                        out var memberName,
                        out var memberSymbol,
                        out var slotFailure
                    ) {
                        this.context.ReportUnsupported(
                            sub,
                            PositionalSubpatternGapMessage("typed positional subpattern", slotFailure)
                        )
                        continue
                    }
                    let memberAccess GExpression = MemberAccessExpression(
                        IdentifierExpression(designator),
                        this.EmittedName(memberSymbol, memberName)
                    )
                    // Issue #4356: pass the slot's type, as the property loop
                    // above does, so a nullable slot is guarded and read once.
                    this.AddTypedSubpatternTest(
                        sub.Pattern,
                        memberAccess,
                        bindings,
                        guards,
                        mutableBindings,
                        this.RegisterPatternMemberSlot(memberSymbol, memberAccess)
                    )
                }
            }
            return this.BuildPatternTypeTest(designator, recursive!!.Type, recursive)
        }

        // Issue #4356: records a guard built by `translate`, collecting any
        // pattern binding it introduced exactly as AddTypedSubpatternTest does:
        // a binder the arm body reassigns becomes a mutable capture of its
        // matched value, the rest bind directly.
        private func AddTypedSubpatternGuard(
            translate() -> GExpression,
            bindings List[(Symbol ISymbol, Replacement GExpression)],
            guards List[GExpression],
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]? = nil
        ) {
            let bindingsBefore = HashSet[ISymbol](this.state.PatternBindings.Keys, SymbolEqualityComparer.Default)
            let memberTest = translate()
            for added in this.state.PatternBindings.Keys.ToList() {
                if bindingsBefore.Contains(added) {
                    continue
                }
                let matched = this.state.PatternBindings[added]
                if mutableBindings != nil && added is ILocalSymbol mutableSymbol && this.IsSymbolReassigned(
                    mutableSymbol,
                    this
                        .state
                        .CurrentBodyScope ??
                        mutableSymbol
                        .DeclaringSyntaxReferences
                        .FirstOrDefault()
                        ?.SyntaxTree
                        .GetRoot()
                ) {
                    mutableBindings.Add((mutableSymbol, matched))
                    continue
                }
                bindings.Add((added, matched))
            }
            guards.Add(memberTest)
        }

        // Issue #4356: whether any intermediate link of an extended property path
        // (`Clause.Items` in `Clause.Items.Count`) is nullable in the emitted G#
        // (see IsNullablePatternLink).
        private func ExtendedPathHasNullableLink(path Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) bool {
            for var link Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ExpressionSyntax? = (path as MemberAccessExpressionSyntax)?.Expression;
                link != nil;
                link = (link as MemberAccessExpressionSyntax)
                ?.Expression {
                let declared ITypeSymbol? = this.ResolveDeclaredReceiverType(this.context.GetTypeInfo(link).Type, link)
                if this.IsNullablePatternLink(declared, link) {
                    return true
                }
            }
            return false
        }

        private func AddTypedSubpatternTest(
            pattern Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax,
            memberAccess GExpression,
            bindings List[(Symbol ISymbol, Replacement GExpression)],
            guards List[GExpression],
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]?,
            memberType ITypeSymbol? = nil
        ) {
            if pattern is Microsoft.CodeAnalysis.CSharp.Syntax.DiscardPatternSyntax {
                return
            }
            if pattern is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .VarPatternSyntax{Designation: SingleVariableDesignationSyntax bound} &&
                this
                .context
                .GetDeclaredSymbol(bound) is {} boundSymbol {
                if mutableBindings != nil && boundSymbol is ILocalSymbol mutableSymbol && this.IsSymbolReassigned(
                    mutableSymbol,
                    this.state.CurrentBodyScope ?? pattern.SyntaxTree.GetRoot()
                ) {
                    mutableBindings.Add((mutableSymbol, memberAccess))
                    return
                }
                bindings.Add((boundSymbol, memberAccess))
                return
            }
            // Issue #4356: the member's type lets the nested test guard a
            // nullable member and read it once (TranslatePatternTest).
            this.AddTypedSubpatternGuard(
                () -> this.TranslatePatternTest(memberAccess, pattern, memberType, isNestedPatternMember: true),
                bindings,
                guards,
                mutableBindings
            )
        }

        // A designator synthesized from the pattern type (`circle` for
        // `Circle { }`) is a readable local, so it must not capture a name the
        // arm already refers to: a source identifier in the arm, or a lifted
        // local-function helper (issue #4302), whose references print bare.
        private func SynthesizePatternDesignator(
            recursive RecursivePatternSyntax?,
            usedDesignators HashSet[string]?
        ) string {
            let stem = SanitizeIdentifier(LowerCamel(GetRightmostTypeName(recursive!!.Type)))
            let arm Microsoft.CodeAnalysis.SyntaxNode? = recursive!!.Ancestors().FirstOrDefault(
                (node Microsoft.CodeAnalysis.SyntaxNode) -> node is SwitchSectionSyntax ||
                    node is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .SwitchExpressionArmSyntax ||
                    node is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .StatementSyntax
            ) ??
                recursive
            let occupied = HashSet[string](usedDesignators!!, StringComparer.Ordinal)
            occupied.UnionWith(this.state.LiftedStaticLocalFunctions.Values)
            occupied.UnionWith(
                this
                    .state
                    .LiftedRecursiveLocalFunctions
                    .Values
                    .Select((lift LiftedRecursiveLocalFunction) -> lift.Name!!)
            )
            occupied.UnionWith(
                arm!!
                    .DescendantTokens()
                    .Where(
                    (token Microsoft.CodeAnalysis.SyntaxToken) -> token.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.IdentifierToken
                    )
                )
                    .Select((token Microsoft.CodeAnalysis.SyntaxToken) -> this.nameAllocator.GetName(token.ValueText))
            )
            let owner INamedTypeSymbol? = this
                .state
                .CurrentEmittedAggregate ??
                this
                .context
                .SemanticModel
                .GetEnclosingSymbol(recursive!!.SpanStart)
                ?.ContainingType
            let designator = LiftedLocalFunctionNameAllocator.For(this.context.Compilation).ClaimDesignator(
                owner,
                stem,
                occupied.Contains
            )
            usedDesignators!!.Add(designator)
            return designator
        }

        private func NewMutableSwitchPatternCaptureName(
            pattern Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax?,
            usedDesignators HashSet[string]?
        ) string {
            let rootPattern = pattern!!
                .AncestorsAndSelf()
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax]()
                .Last()
            var candidate string
            do {
                candidate = "__pattern${this.state.SwitchPatternCounter}"
                this.state.SwitchPatternCounter++
            } while usedDesignators!!.Contains(candidate) ||
                rootPattern
                .DescendantNodesAndSelf()
                .OfType[SingleVariableDesignationSyntax]()
                .Any(
                (designation SingleVariableDesignationSyntax) -> this.EmittedName(
                    designation,
                    designation.Identifier
                ) == candidate
            ) ||
                !this.TryClaimSynthesizedLocalName(candidate, pattern)
            usedDesignators!!.Add(candidate)
            return candidate
        }

        // Extracts the right-most simple-name identifier token from a (possibly
        // qualified/generic) type syntax, e.g. `Ns.Circle` -> "Circle",
        // `List<int>` -> "List", `Outer.Inner<T>` -> "Inner". `Type.ToString()`
        // renders the full qualified/generic text, which is not itself a valid
        // identifier and must never be used to synthesize a designator name
        // (issue #1734).
        //
        // Issue #1839 (N2): a predefined type (`int`) resolves to its BCL name
        // via the semantic model — the same resolution `TranslatePredefinedTypeExpression`
        // uses for a predefined-type expression receiver — rather than the
        // lowercase keyword text (`int`), which is itself a G# keyword and not a
        // valid designator once sanitized. Nullable/array types recurse into
        // their element type, since `int?`/`int[]` designate the same underlying
        // simple type as `int`. A tuple, pointer, or function-pointer type has no
        // single simple name to derive a faithful designator from, so a
        // diagnostic is reported instead of emitting the unsanitized, invalid
        // `Type.ToString()` text (`(int, int)`, `int*`, `delegate*<int, int>`).
        private func GetRightmostTypeName(type TypeSyntax?) string {
            switch type {
                case qualified is QualifiedNameSyntax {
                    return GetRightmostTypeName(qualified.Right)
                }
                case aliasQualified is AliasQualifiedNameSyntax {
                    return GetRightmostTypeName(aliasQualified.Name)
                }
                case simple is SimpleNameSyntax {
                    return simple.Identifier.ValueText
                }
                case predefined is PredefinedTypeSyntax {
                    let predefinedSymbol ITypeSymbol? = this.context.GetTypeInfo(predefined).Type
                    return predefinedSymbol?.Name ?? predefined.Keyword.Text
                }
                case nullable is NullableTypeSyntax {
                    return GetRightmostTypeName(nullable.ElementType)
                }
                case array is ArrayTypeSyntax {
                    return GetRightmostTypeName(array.ElementType)
                }
                case TupleTypeSyntax, PointerTypeSyntax, FunctionPointerTypeSyntax {
                    this.context.ReportUnsupported(
                        type,
                        "recursive pattern designator cannot be synthesized from type '${type!!.Kind()}'; give the pattern an explicit designation (ADR-0115 §B)."
                    )
                    return "value"
                }
                default {
                    return type!!.ToString()
                }
            }
        }

        private func TranslateQuery(query QueryExpressionSyntax) GExpression? {
            // G# has no query-comprehension syntax; lower the C# query to the
            // equivalent System.Linq method chain (`from … where … orderby …
            // select …` → `.Where(…).OrderBy(…).Select(…)`, ADR-0115 §B LINQ).
            let from = query.FromClause
            var current GExpression? = this.TranslateExpression(from.Expression)
            let rangeType GTypeReference? = this.ResolveRangeVariableType(
                from.Type,
                from.Expression,
                from,
                out var rangeTypeSymbol
            )
            let rangeSymbol ISymbol? = this.context.GetDeclaredSymbol(from)
            this.RecordProjectedQueryBinding(rangeSymbol, rangeTypeSymbol)
            // The query's "scope" is the set of range variables in play, in
            // declaration order — the C# spec's transparent identifier (§12.19.3).
            // A lone `from` starts with one; a second `from`, a `let`, or a `join`
            // grows it. scope.Count > 1 is threaded as a positional tuple — not
            // because G# lacks anonymous types (it has had them since
            // ADR-0146), but because a tuple is the lighter-weight, more
            // appropriate carrier for this ephemeral, translator-internal
            // value (ADR-0185, Alternative 3). See <see cref="BuildScopeParameter"/>,
            // which (as of ADR-0185) emits that tuple as a DESTRUCTURING
            // parameter under the real range-variable names directly.
            let scope_ = List[(Name string, Type GTypeReference, Symbol ISymbol)]{
                (from.Identifier.ValueText, rangeType, rangeSymbol)
            }
            // Issue #1998: track the enclosing query node so a scope that grows
            // past G#'s tuple arity cap (see <see cref="BuildScopeParameter"/>)
            // can anchor a precise diagnostic rather than silently emitting a
            // tuple shape that would only surface as an opaque GS0159 much
            // later, at G# bind time. Save/restore to stay correct for a
            // (rare) query nested inside this one's lambda bodies.
            let previousQueryNode QueryExpressionSyntax? = this.state.CurrentQueryNode
            this.state.CurrentQueryNode = query
            try {
                current = this.LowerQueryBody(query.Body, scope_, current)
            } finally {
                this.state.CurrentQueryNode = previousQueryNode
            }
            return current
        }

        // Determines a query range variable's element type. The emitted
        // projected collection type wins when an explicit range type has an
        // identity conversion; a real conversion keeps the explicit target.
        // The selected query operator, enumeration, and single-type-argument
        // query-provider fallback cover shapes without a projection.
        private func ResolveRangeVariableType(
            explicitType TypeSyntax?,
            source Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            anchor Microsoft.CodeAnalysis.SyntaxNode,
            out effectiveType ITypeSymbol?
        ) GTypeReference? {
            let elementType ITypeSymbol? = this.ResolveRangeVariableElementTypeSymbol(source, anchor)
            if explicitType != nil {
                let explicitTypeSymbol ITypeSymbol? = this.context.GetTypeInfo(explicitType).Type
                let projectedBinding ITypeSymbol? = if elementType == nil || explicitTypeSymbol == nil {
                    default(ITypeSymbol?)
                } else {
                    this.GetProjectedBindingType(
                        elementType,
                        explicitTypeSymbol,
                        this.context.Compilation.ClassifyConversion(elementType, explicitTypeSymbol)
                    )
                }
                if projectedBinding != nil {
                    effectiveType = projectedBinding
                    return this.typeMapper.Map(projectedBinding, this.context, anchor.GetLocation())
                }
                effectiveType = explicitTypeSymbol
                return this.MapTypeSyntax(explicitType)
            }
            if elementType != nil {
                effectiveType = elementType
                return this.typeMapper.Map(elementType, this.context, anchor.GetLocation())
            }
            effectiveType = nil
            this.context.ReportUnsupported(
                anchor,
                "query range variable's element type could not be determined from its source collection (ADR-0115 §B)."
            )
            return NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType)
        }

        private func RecordProjectedQueryBinding(symbol ISymbol?, effectiveType ITypeSymbol?) {
            if symbol != nil && effectiveType != nil {
                this.state.ProjectedQueryBindingType[symbol] = effectiveType
            }
        }

        private func ResolveRangeVariableElementTypeSymbol(
            source Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            anchor Microsoft.CodeAnalysis.SyntaxNode
        ) ITypeSymbol? {
            let mappedArrayElement ITypeSymbol? = this.GetMappedArrayElementType(source)
            if anchor is FromClauseSyntax{Parent: QueryBodySyntax} additionalFrom &&
                this
                .context
                .SemanticModel
                .GetQueryClauseInfo(additionalFrom)
                .OperationInfo
                .Symbol is IMethodSymbol selectMany {
                let resultSelector IMethodSymbol? = selectMany
                    .Parameters
                    .Select((parameter IParameterSymbol) -> GetDelegateInvokeMethod(parameter.Type))
                    .Where((invoke IMethodSymbol) -> invoke != nil)
                    .Skip(1)
                    .FirstOrDefault()
                if resultSelector != nil && resultSelector.Parameters.Length >= 2 {
                    let selectorElement = resultSelector.Parameters[1].Type
                    // Preserve a custom provider contract; replace only the
                    // original managed-array element with its projected form.
                    return if mappedArrayElement != nil && SymbolEqualityComparer.Default.Equals(
                        mappedArrayElement,
                        selectorElement
                    ) {
                        mappedArrayElement
                    } else {
                        selectorElement
                    }
                }
            }
            if mappedArrayElement != nil {
                return mappedArrayElement
            }
            let projectedSource ITypeSymbol? = this.GetManagedReferenceArrayProjectedExpressionType(source)
            let projectedElement ITypeSymbol? = GetEnumerableElementType(projectedSource)
            if projectedElement != nil {
                return if this.ArrayExpressionHasNullableReferenceLikeElement(source) {
                    projectedElement.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
                } else {
                    projectedElement
                }
            }
            let sourceType ITypeSymbol? = this
                .context
                .GetTypeInfo(source)
                .Type ??
                this
                .context
                .GetTypeInfo(source)
                .ConvertedType
            if this.ArrayExpressionHasNullableReferenceLikeElement(source) &&
                GetEnumerableElementType(sourceType) is {} nullableElement {
                return nullableElement.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
            }
            if anchor is FromClauseSyntax{Parent: QueryExpressionSyntax} initialFrom {
                let query QueryExpressionSyntax? = cast[QueryExpressionSyntax](initialFrom.Parent)
                let queryOperator IMethodSymbol? = this
                    .context
                    .SemanticModel
                    .GetQueryClauseInfo(initialFrom)
                    .OperationInfo
                    .Symbol as IMethodSymbol ??
                    (
                    if query!!.Body.Clauses.FirstOrDefault() is QueryClauseSyntax firstClause {
                        this.context.SemanticModel.GetQueryClauseInfo(firstClause).OperationInfo.Symbol as IMethodSymbol
                    } else {
                        this.context.GetSymbolInfo(query!!.Body.SelectOrGroup).Symbol as IMethodSymbol
                    }
                )
                for parameter in queryOperator?.Parameters ?? ImmutableArray[IParameterSymbol].Empty {
                    if parameter.Type is INamedTypeSymbol{
                        DelegateInvokeMethod: {Parameters: [{Type: {} rangeType}, ..]}
                    } {
                        return rangeType
                    }
                }
            }
            let enumerableElement ITypeSymbol? = GetEnumerableElementType(sourceType)
            if enumerableElement != nil {
                return enumerableElement
            }
            return if sourceType is INamedTypeSymbol queryProvider &&
                queryProvider.IsGenericType &&
                queryProvider
                .TypeArguments
                .Length == 1 {
                queryProvider.TypeArguments[0]
            } else {
                default(ITypeSymbol?)
            }
        }

        private func LowerQueryBody(
            body QueryBodySyntax,
            $scope List[(Name string, Type GTypeReference, Symbol ISymbol)],
            current GExpression?
        ) GExpression? {
            var current = current
            for clause in body.Clauses {
                switch clause {
                    case where is WhereClauseSyntax {
                        current = this.QueryCall(current, "Where", $scope, where.Condition)
                    }
                    case orderBy is OrderByClauseSyntax {
                        var first = true
                        for ordering in orderBy.Orderings {
                            let descending = ordering.AscendingOrDescendingKeyword.IsKind(
                                Microsoft.CodeAnalysis.CSharp.SyntaxKind.DescendingKeyword
                            )
                            let method = (
                                if first {
                                    "OrderBy"
                                } else {
                                    "ThenBy"
                                }
                            ) +
                                (
                                if descending {
                                    "Descending"
                                } else {
                                    string.Empty
                                }
                            )
                            current = this.QueryCall(current, method, $scope, ordering.Expression)
                            first = false
                        }
                    }
                    case let_ is LetClauseSyntax {
                        current = this.LowerLetClause(let_, $scope, current)
                    }
                    case additionalFrom is FromClauseSyntax {
                        current = this.LowerAdditionalFromClause(additionalFrom, $scope, current)
                    }
                    case join is JoinClauseSyntax {
                        current = this.LowerJoinClause(join, $scope, current)
                    }
                    default {
                        this.context.ReportUnsupported(
                            clause,
                            "query clause '${clause.Kind()}' has no canonical G# lowering yet (ADR-0115 §B)."
                        )
                    }
                }
            }
            // The result element type after this body's select/group runs, used to
            // type the range variable of an `into` continuation (below). Defaults
            // to the unchanged scope for an elided identity `select n` — a single
            // variable stays itself, a transparent identifier (scope.Count > 1)
            // surfaces as the positional tuple it was already threaded as.
            var resultType GTypeReference? = if $scope.Count == 1 {
                $scope[0].Type
            } else {
                cast[GTypeReference](
                    TupleTypeReference(
                        $scope.Select((v(Name string, Type GTypeReference, Symbol ISymbol)) -> v.Type).ToList()
                    )
                )
            }
            // Tracks the projected `select` expression's resolved `ITypeSymbol`
            // (issue #1967) so a continuation's `into y` can be checked for an
            // Index/Range projection below — `resultType` alone is a `GTypeReference`
            // and has already lost that information by the time the continuation
            // runs. Left null for an elided identity `select`/`group` continuation:
            // either case re-uses an already-declared range variable's type, whose
            // Index/Range loud gap (if any) was already reported at its own `from`/
            // `let`/`join` site.
            var resultTypeSymbol ITypeSymbol? = nil
            switch body.SelectOrGroup {
                case select_ is SelectClauseSyntax {
                    // An identity projection (`select n`) after another clause is a
                    // no-op the C# compiler elides; keep it only when it transforms.
                    if $scope.Count == 1 &&
                        select_.Expression is IdentifierNameSyntax id &&
                        id
                        .Identifier
                        .ValueText == $scope[0].Name &&
                        body
                        .Clauses
                        .Count > 0 {
                        if $scope[0].Symbol != nil {
                            this.state.ProjectedQueryBindingType.TryGetValue($scope[0].Symbol, out resultTypeSymbol)
                        }
                        break
                    }
                    current = this.QueryCall(current, "Select", $scope, select_.Expression, out var effectiveSelectType)
                    resultTypeSymbol = effectiveSelectType ?? this.context.GetTypeInfo(select_.Expression).Type
                    resultType = if resultTypeSymbol is {} projected {
                        this.typeMapper.Map(projected, this.context, select_.GetLocation())
                    } else {
                        cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
                    }
                }
                case group is GroupClauseSyntax {
                    current = this.LowerGroupClause(group, $scope, current, out resultType, out resultTypeSymbol)
                }
                default {
                    this.context.ReportUnsupported(
                        body.SelectOrGroup,
                        "query '${body.SelectOrGroup.Kind()}' has no canonical G# lowering yet (ADR-0115 §B)."
                    )
                    return current
                }
            }
            // `... into y ...` (a query continuation) is the C# spec's own sugar
            // for `from y in (...) ...` — lower it as a nested query body over the
            // projected sequence rather than silently dropping the continuation's
            // clauses (issue #1738). This covers both a `select … into y` and a
            // `group … by … into y` continuation (issue #1902) — either way `y`
            // re-starts the scope as a single range variable over the projection.
            if body.Continuation != nil {
                let continuationSymbol ISymbol? = this.context.GetDeclaredSymbol(body.Continuation)
                this.RecordProjectedQueryBinding(continuationSymbol, resultTypeSymbol)
                let continuationScope = List[(Name string, Type GTypeReference, Symbol ISymbol)]{
                    (body.Continuation!!.Identifier.ValueText, resultType, continuationSymbol)
                }
                current = this.LowerQueryBody(body.Continuation!!.Body, continuationScope, current)
            }
            return current
        }

        // Lowers `let x = e` (spec §12.19.3.4): a Select projecting the current
        // scope's transparent identifier widened by one member, `x`. Mirrors the
        // spec's `(...).Select(x1 => new{x1, x2 = e})`, with a positional tuple
        // carrying the widened scope forward instead of an anonymous object
        // (ADR-0185, Alternative 3 — the lighter-weight carrier for this
        // ephemeral, translator-internal use, not a fallback for a missing
        // feature).
        private func LowerLetClause(
            $let LetClauseSyntax,
            $scope List[(Name string, Type GTypeReference?, Symbol ISymbol?)],
            current GExpression?
        ) GExpression? {
            var current = current
            let prologue = List[GStatement]()
            let param = this.BuildScopeParameter($scope)
            // Issue #3348: as in `BuildScopeLambda`, the `let` value is evaluated
            // inside this Select lambda — hoist into its own prologue, not the
            // enclosing statement's.
            let letValue GExpression? = this.TranslateQueryLambdaBody(
                $let.Expression,
                prologue,
                $scope,
                out var effectiveLetType
            )
            let letType GTypeReference? = if effectiveLetType is {} t {
                this.typeMapper.Map(t, this.context, $let.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
            }
            let elements = $scope.Select(
                (v(Name string, Type GTypeReference, Symbol ISymbol)) -> cast[GExpression](
                    IdentifierExpression(this.EmittedName(v.Symbol, v.Name))
                )
            )
                .ToList()
            elements.Add(letValue!!)
            prologue.Add(ReturnStatement(TupleLiteralExpression(elements)))
            let lambda = LambdaExpression(List[Parameter]{param}, blockBody: BlockStatement(prologue))
            current = InvocationExpression(MemberAccessExpression(current, "Select"), List[GExpression]{lambda})
            $scope.Add(($let.Identifier.ValueText, letType, this.context.GetDeclaredSymbol($let)))
            this.RecordProjectedQueryBinding($scope[^1].Symbol, effectiveLetType)
            return current
        }

        // Lowers a second (or later) `from` clause (spec §12.19.3.3, SelectMany):
        // `(...).SelectMany(x1 => e2, (x1, x2) => new{x1, x2})`. The
        // collection-selector runs over the CURRENT scope; the result-selector
        // widens it by the new range variable, same transparent-identifier tuple
        // as `let` above.
        private func LowerAdditionalFromClause(
            from FromClauseSyntax,
            $scope List[(Name string, Type GTypeReference?, Symbol ISymbol?)],
            current GExpression?
        ) GExpression? {
            var current = current
            let collectionSelector = this.BuildScopeLambda($scope, from.Expression)
            let newVarType GTypeReference? = this.ResolveRangeVariableType(
                from.Type,
                from.Expression,
                from,
                out var newVarTypeSymbol
            )
            let newVar(Name string, Type GTypeReference?, Symbol ISymbol?) = (
                from.Identifier.ValueText,
                newVarType,
                this.context.GetDeclaredSymbol(from)
            )
            this.RecordProjectedQueryBinding(newVar.Symbol, newVarTypeSymbol)
            let resultSelector = this.BuildTransparentResultSelector($scope, newVar)
            current = InvocationExpression(
                MemberAccessExpression(current, "SelectMany"),
                List[GExpression]{collectionSelector, resultSelector}
            )
            $scope.Add(newVar)
            return current
        }

        // Lowers `join x2 in e2 on k1 equals k2 [into g]` (spec §12.19.3.7/.8):
        // an inner join is `Join(e2, x1 => k1, x2 => k2, (x1, x2) => new{x1, x2})`;
        // a group join (`into g`) is the same shape over `GroupJoin`, widening the
        // scope by `g : IEnumerable<TInner>` instead of the bare inner variable.
        private func LowerJoinClause(
            join JoinClauseSyntax,
            $scope List[(Name string, Type GTypeReference?, Symbol ISymbol?)],
            current GExpression?
        ) GExpression? {
            var current = current
            let inner GExpression? = this.TranslateExpression(join.InExpression)
            let innerVarType GTypeReference? = this.ResolveRangeVariableType(
                join.Type,
                join.InExpression,
                join,
                out var innerVarTypeSymbol
            )
            let innerVar = (
                Name: join.Identifier.ValueText,
                Type: innerVarType,
                Symbol: this.context.GetDeclaredSymbol(join)
            )
            this.RecordProjectedQueryBinding(innerVar.Item3, innerVarTypeSymbol)
            let outerKeySelector = this.BuildScopeLambda($scope, join.LeftExpression)
            let innerKeySelector = this.BuildScopeLambda(
                List[(Name string, Type GTypeReference?, Symbol ISymbol?)]{innerVar},
                join.RightExpression
            )
            if join.Into == nil {
                let resultSelector = this.BuildTransparentResultSelector($scope, innerVar)
                current = InvocationExpression(
                    MemberAccessExpression(current, "Join"),
                    List[GExpression]{inner!!, outerKeySelector, innerKeySelector, resultSelector}
                )
                $scope.Add(innerVar)
                return current
            }
            // Group join: the `into g` variable is always `IEnumerable<TInner>`
            // (spec §12.19.3.8) — no C# expression to infer it from, so it is
            // built directly from the already-resolved inner element type.
            // `sequence[T]` is G#'s spelling for `IEnumerable<T>` (see the
            // `GetEnumerableElementType`/array-iteration lowering above).
            // `into g` is always `IEnumerable<TInner>` (spec §12.19.3.8) — never
            // Index/Range itself — so no loud-gap check applies here.
            let groupVar = (
                Name: join.Into!!.Identifier.ValueText,
                Type: cast[GTypeReference](NamedTypeReference("sequence", List[GTypeReference]{innerVarType!!})),
                Symbol: this.context.GetDeclaredSymbol(join.Into)
            )
            let groupVarTypeSymbol ITypeSymbol? = if innerVarTypeSymbol != nil &&
                this
                .context
                .Compilation
                .GetTypeByMetadataName("System.Collections.Generic.IEnumerable`1") is {} enumerableType {
                enumerableType.Construct(innerVarTypeSymbol)
            } else {
                default(INamedTypeSymbol?)
            }
            this.RecordProjectedQueryBinding(groupVar.Item3, groupVarTypeSymbol)
            let groupResultSelector = this.BuildTransparentResultSelector($scope, groupVar)
            current = InvocationExpression(
                MemberAccessExpression(current, "GroupJoin"),
                List[GExpression]{inner!!, outerKeySelector, innerKeySelector, groupResultSelector}
            )
            $scope.Add(groupVar)
            return current
        }

        // Lowers `group e by k` (spec §12.19.3.9): the two-argument
        // `GroupBy(x1 => k, x1 => e)`, eliding the element-selector to the
        // single-argument `GroupBy(x1 => k)` for the identity case (`group n by
        // …`) the same way an identity `select n` is elided above. The query's
        // element type becomes `IGrouping<TKey, TElement>`.
        private func LowerGroupClause(
            group GroupClauseSyntax,
            $scope List[(Name string, Type GTypeReference, Symbol ISymbol)],
            current GExpression?,
            out resultType GTypeReference?,
            out resultTypeSymbol ITypeSymbol?
        ) GExpression? {
            var current = current
            let keySelector = this.BuildScopeLambda($scope, group.ByExpression, out var effectiveKeyType)
            let keyTypeSymbol ITypeSymbol? = effectiveKeyType ?? this.context.GetTypeInfo(group.ByExpression).Type
            let keyType GTypeReference? = if keyTypeSymbol is {} key {
                this.typeMapper.Map(key, this.context, group.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
            }
            let isIdentity = $scope.Count == 1 &&
                group.GroupExpression is IdentifierNameSyntax id &&
                id
                .Identifier
                .ValueText == $scope[0].Name
            let args = List[GExpression]{keySelector}
            var elementType GTypeReference?
            var elementTypeSymbol ITypeSymbol?
            if isIdentity {
                elementType = $scope[0].Type
                elementTypeSymbol = if $scope[0].Symbol != nil &&
                    this
                    .state
                    .ProjectedQueryBindingType
                    .TryGetValue($scope[0].Symbol, out var projectedElement) {
                    projectedElement
                } else {
                    this.context.GetTypeInfo(group.GroupExpression).Type
                }
            } else {
                args.Add(this.BuildScopeLambda($scope, group.GroupExpression, out var effectiveElementType))
                elementTypeSymbol = effectiveElementType ?? this.context.GetTypeInfo(group.GroupExpression).Type
                elementType = if elementTypeSymbol is {} element {
                    this.typeMapper.Map(element, this.context, group.GetLocation())
                } else {
                    cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
                }
            }
            current = InvocationExpression(MemberAccessExpression(current, "GroupBy"), args)
            resultType = NamedTypeReference("IGrouping", List[GTypeReference]{keyType!!, elementType!!})
            resultTypeSymbol = if keyTypeSymbol != nil &&
                elementTypeSymbol != nil &&
                this
                .context
                .Compilation
                .GetTypeByMetadataName("System.Linq.IGrouping`2") is {} groupingType {
                groupingType.Construct(keyTypeSymbol, elementTypeSymbol)
            } else {
                default(INamedTypeSymbol?)
            }
            return current
        }

        private func QueryCall(
            receiver GExpression?,
            method string,
            $scope List[(Name string, Type GTypeReference, Symbol ISymbol)],
            lambdaBody Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) GExpression -> this.QueryCall(receiver, method, $scope, lambdaBody, out _)

        private func QueryCall(
            receiver GExpression?,
            method string,
            $scope List[(Name string, Type GTypeReference, Symbol ISymbol)],
            lambdaBody Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            out effectiveType ITypeSymbol?
        ) GExpression {
            var receiver = receiver
            let ContainsNullableLeaf = func (type GTypeReference) bool {
                return type.IsNullable ||
                    (type is TupleTypeReference tuple && tuple.ElementTypes.Any(ContainsNullableLeaf))
            }
            let UsesSystemLinqEnumerable = func (body Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) bool {
                return (
                    switch body.Parent {
                        case clause is QueryClauseSyntax: this
                            .context
                            .SemanticModel
                            .GetQueryClauseInfo(clause)
                            .OperationInfo
                            .Symbol as IMethodSymbol
                        case ordering is OrderingSyntax: this.context.GetSymbolInfo(ordering).Symbol as IMethodSymbol
                        case selectOrGroup is SelectOrGroupClauseSyntax: this
                            .context
                            .GetSymbolInfo(selectOrGroup)
                            .Symbol as IMethodSymbol
                        default: default(IMethodSymbol?)
                    }
                )
                    ?.ContainingType
                    .ToDisplayString() == "System.Linq.Enumerable"
            }
            let sourceType = if $scope.Count == 1 {
                $scope[0].Type
            } else {
                cast[GTypeReference](
                    TupleTypeReference(
                        $scope.Select((v(Name string, Type GTypeReference, Symbol ISymbol)) -> v.Type).ToList()
                    )
                )
            }
            // Casting before ThenBy would erase the IOrderedEnumerable returned
            // by the projected OrderBy call.
            if sourceType is TupleTypeReference && ContainsNullableLeaf(sourceType) && !method.StartsWith(
                "ThenBy",
                StringComparison.Ordinal
            ) &&
                UsesSystemLinqEnumerable(lambdaBody) {
                // Query lowering has no Roslyn invocation node for the shared
                // callable-projection funnel. Cast supplies its projected
                // recursive tuple element type to LINQ before method binding.
                receiver = InvocationExpression(
                    MemberAccessExpression(IdentifierExpression("System.Linq.Enumerable"), "Cast"),
                    List[GExpression]{receiver!!},
                    List[GTypeReference]{sourceType}
                )
            }
            let lambda = this.BuildScopeLambda($scope, lambdaBody, out effectiveType)
            return InvocationExpression(MemberAccessExpression(receiver, method), List[GExpression]{lambda})
        }

        // Builds a lambda over the current query scope: a single scope variable
        // becomes a plain `(x) -> body`; a transparent identifier (scope.Count >
        // 1) becomes a tuple-parameter lambda that first deconstructs the tuple
        // back into the individual range-variable names `body` refers to (see
        // <see cref="BuildScopeParameter"/>).
        private func BuildScopeLambda(
            $scope List[(Name string, Type GTypeReference?, Symbol ISymbol?)],
            lambdaBody Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) LambdaExpression -> this.BuildScopeLambda($scope, lambdaBody, out _)

        private func BuildScopeLambda(
            $scope List[(Name string, Type GTypeReference?, Symbol ISymbol?)],
            lambdaBody Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            out effectiveType ITypeSymbol?
        ) LambdaExpression {
            let prologue = List[GStatement]()
            let param = this.BuildScopeParameter($scope)
            // Issue #3348: translate the clause body INSIDE this lambda's own seam.
            // Anything it hoists — a single-evaluation spill (issue #1731) or an
            // embedded value-position assignment (issue #1723) — lands in `prologue`,
            // after the scope-parameter deconstruction it may read from, and so runs
            // once per element inside the lambda. Left on the enclosing statement's
            // ambient seam it would instead be emitted before the whole query, where
            // the range variable it references is not in scope.
            let body GExpression? = this.TranslateQueryLambdaBody(lambdaBody, prologue, $scope, out effectiveType)
            if prologue.Count == 0 {
                return LambdaExpression(List[Parameter]{param}, expressionBody: body)
            }
            prologue.Add(ReturnStatement(body))
            return LambdaExpression(List[Parameter]{param}, blockBody: BlockStatement(prologue))
        }

        // Issue #3348: translates a query-clause expression as the body of the lambda
        // that clause lowers to, redirecting every hoist into that lambda's own
        // `prologue`. <see cref="TranslateConditionWithHoist"/> already implements
        // exactly this contract for loop/if conditions — redirect the spill seam AND
        // hoist embedded assignments into a caller-supplied statement list — so it is
        // reused verbatim rather than duplicated. `CollectEmbeddedAssignments` no
        // longer descends into a query clause (see <see cref="EagerQuerySources"/>),
        // so the enclosing statement leaves these assignments for this call to hoist.
        private func TranslateQueryLambdaBody(
            lambdaBody Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            prologue List[GStatement],
            $scope IReadOnlyList[(Name string, Type GTypeReference?, Symbol ISymbol?)],
            out effectiveType ITypeSymbol?
        ) GExpression? {
            let addedNullableBindings = List[ISymbol]()
            for (_, type, symbol) in $scope {
                if type!!.IsNullable &&
                    symbol != nil &&
                    this
                    .state
                    .ProjectedQueryBindingType
                    .TryGetValue(symbol, out var bindingType) &&
                    this.IsReferenceLikeOrManagedReference(bindingType) &&
                    this
                    .state
                    .NullableForEachBindings
                    .Add(symbol) {
                    addedNullableBindings.Add(symbol)
                }
            }
            try {
                let result GExpression? = this.TranslateConditionWithHoist(lambdaBody, prologue)
                effectiveType = this.GetManagedReferenceArrayProjectedArgumentType(lambdaBody)
                return result
            } finally {
                for symbol in addedNullableBindings {
                    this.state.NullableForEachBindings.Remove(symbol)
                }
            }
        }

        // Builds the `(x1, x2) => new{x1, x2}` result-selector shape shared by
        // SelectMany/Join/GroupJoin (spec §12.19.3.3/.7/.8): one parameter for
        // the left-hand (current) scope, one for the newly introduced variable,
        // returning the widened scope as a positional tuple.
        private func BuildTransparentResultSelector(
            leftScope List[(Name string, Type GTypeReference?, Symbol ISymbol?)],
            rightVar(Name string, Type GTypeReference?, Symbol ISymbol?)
        ) LambdaExpression {
            let prologue = List[GStatement]()
            let leftParam = this.BuildScopeParameter(leftScope)
            let rightParam = Parameter(this.EmittedName(rightVar.Symbol, rightVar.Name), rightVar.Type)
            let elements = leftScope.Select(
                (v(Name string, Type GTypeReference, Symbol ISymbol)) -> cast[GExpression](
                    IdentifierExpression(this.EmittedName(v.Symbol, v.Name))
                )
            )
                .ToList()
            elements.Add(IdentifierExpression(this.EmittedName(rightVar.Symbol, rightVar.Name)))
            prologue.Add(ReturnStatement(TupleLiteralExpression(elements)))
            return LambdaExpression(List[Parameter]{leftParam, rightParam}, blockBody: BlockStatement(prologue))
        }

        // Builds the formal parameter a query-scope lambda binds to: a single
        // variable binds directly by name; a transparent identifier
        // (scope.Count > 1) binds a tuple-DESTRUCTURING parameter (ADR-0185,
        // `(x1 T1, x2 T2, ...) -> ...`) under the real range-variable names
        // directly — no prologue statement needed, and no synthetic name:
        // ADR-0185 retired the `__q{N}` scheme (issue #4304) this function
        // used to synthesize here, together with issue #1998's collision-
        // avoidance loop it required (a same-name collision between a query
        // range variable and an outer local is now just an ordinary
        // identifier collision, already resolved by EmittedName/
        // EmittedNameAllocator like everywhere else in this translator).
        private func BuildScopeParameter($scope List[(Name string, Type GTypeReference?, Symbol ISymbol?)]) Parameter {
            if $scope.Count == 1 {
                return Parameter(this.EmittedName($scope[0].Symbol, $scope[0].Name), $scope[0].Type)
            }
            // Issue #1998: G#'s tuple family (mirroring the BCL's `ValueTuple`)
            // tops out at arity 7 — a query scope this wide (`from` plus 6+
            // `let`/second-`from`/`join` clauses) has no canonical tuple to
            // widen into. Report a precise, actionable diagnostic HERE (rather
            // than silently emitting the oversized tuple shape, which would
            // only surface as an opaque GS0159 much later at G# bind time) and
            // still emit the best-effort shape so a single query with one
            // over-wide scope doesn't block translating the rest of the file.
            // Unaffected by ADR-0185: this proposal changes how a scope's
            // tuple parameter is SPELLED, not how wide a scope G# tuples can
            // represent.
            if $scope.Count > 7 && this.state.CurrentQueryNode != nil {
                let scopeMessage = "Query scope has grown to ${$scope.Count} range variables (${string.Join(", ", $scope.Select((v (Name string, Type GTypeReference, Symbol ISymbol)) -> v.Name))}); " +
                    "G# tuples support at most 7 elements (ADR-0115 §B), so this scope has no canonical G# lowering. " +
                    "Split the query (e.g. an intermediate `select new { ... }`-style projection via a `let`, or a nested query) " +
                    "to keep each transparent-identifier scope at 7 or fewer range variables."
                this.context.Report(
                    TranslationDiagnostic(
                        "QueryExpressionSyntax",
                        scopeMessage,
                        this.state.CurrentQueryNode!!.GetLocation(),
                        TranslationSeverity.Unsupported
                    )
                )
            }
            return Parameter(
                $scope.Select(
                    (v(Name string, Type GTypeReference, Symbol ISymbol)) -> (
                        this.EmittedName(v.Symbol, v.Name),
                        v.Type
                    )
                )
                    .ToList()
            )
        }

        shared {
            private func HasOmittedTypeArgument(name NameSyntax) bool -> switch name {
                case generic is GenericNameSyntax: generic
                    .TypeArgumentList
                    .Arguments
                    .Any((a TypeSyntax) -> a is OmittedTypeArgumentSyntax)
                case qualified is QualifiedNameSyntax: HasOmittedTypeArgument(qualified.Left) ||
                    HasOmittedTypeArgument(qualified.Right)
                case alias is AliasQualifiedNameSyntax: HasOmittedTypeArgument(alias.Name)
                default: false
            }

            // Renders a (possibly nested) unbound-generic name with `_` placeholder
            // bracket arguments per generic segment: `IEnumerable<>` → `IEnumerable[_]`,
            // `Dictionary<,>.Enumerator` → `Dictionary[_, _].Enumerator`,
            // `Outer<>.Inner<>` → `Outer[_].Inner[_]`. Null for shapes with no
            // canonical spelling.
            private func RenderUnboundGenericName(name NameSyntax) string? {
                switch name {
                    case identifier is IdentifierNameSyntax {
                        return identifier.Identifier.ValueText
                    }
                    case generic is GenericNameSyntax {
                        return generic.Identifier.ValueText + "[" + string.Join(
                            ", ",
                            Enumerable.Repeat("_", generic.TypeArgumentList.Arguments.Count)
                        ) +
                            "]"
                    }
                    case qualified is QualifiedNameSyntax {
                        let left string? = RenderUnboundGenericName(qualified.Left)
                        let right string? = RenderUnboundGenericName(qualified.Right)
                        return if left == nil || right == nil {
                            default(string?)
                        } else {
                            left + "." + right
                        }
                    }
                    case alias is AliasQualifiedNameSyntax {
                        // `global::` (or another extern alias) has no G# spelling;
                        // the aliased segment renders bare.
                        return RenderUnboundGenericName(alias.Name)
                    }
                    default {
                        return nil
                    }
                }
            }

            private func IsTotalPattern(
                pattern Microsoft.CodeAnalysis.CSharp.Syntax.PatternSyntax
            ) bool -> pattern is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .DiscardPatternSyntax ||
                pattern is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .VarPatternSyntax ||
                (
                pattern is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ParenthesizedPatternSyntax parenthesized &&
                    IsTotalPattern(parenthesized.Pattern)
            ) ||
                (
                pattern is Microsoft.CodeAnalysis.CSharp.Syntax.BinaryPatternSyntax binary && binary.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.OrPattern
                ) &&
                    (IsTotalPattern(binary.Left) || IsTotalPattern(binary.Right))
            )

            // The nearest loop or switch, rather than either kind in isolation,
            // determines whether G# keeps the break or lowers it to a switch exit.
            private func GetBreakTarget(node Microsoft.CodeAnalysis.CSharp.Syntax.BreakStatementSyntax) Microsoft
                .CodeAnalysis
                .SyntaxNode? -> node
                .Ancestors().FirstOrDefault(IsBreakTarget)

            private func IsBreakTarget(node Microsoft.CodeAnalysis.SyntaxNode) bool -> node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .SwitchStatementSyntax ||
                node is ForStatementSyntax ||
                node is CommonForEachStatementSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .WhileStatementSyntax ||
                node is DoStatementSyntax

            private func IsRedundantSwitchSectionBreak(
                node Microsoft.CodeAnalysis.CSharp.Syntax.BreakStatementSyntax
            ) bool {
                // A break at the end of every containing statement list reaches
                // exactly the point where a G# arm ends naturally.
                var child Microsoft.CodeAnalysis.SyntaxNode = node
                for ancestor in node.Ancestors() {
                    if ancestor is SwitchSectionSyntax section {
                        return section.Statements.LastOrDefault() == child
                    }
                    if ancestor is BlockSyntax block &&
                        child is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .StatementSyntax statement &&
                        block
                        .Statements
                        .LastOrDefault() != statement {
                        return false
                    }
                    child = ancestor
                }
                return false
            }

            // Mirrors the statement-start disambiguation in Parser.Statements.cs: at
            // `yield (` only a tuple literal parses as a yield, and `yield [` is an
            // index of a variable named `yield` unless the bracket pair is empty
            // (`yield []T{...}`), so a sized array creation (`[3]T`) must be
            // materialized as well. A tuple literal never reaches this check.
            private func YieldValuePrintsAmbiguously(printed string) bool {
                let text = printed.TrimStart()
                if text.StartsWith("(", StringComparison.Ordinal) {
                    return true
                }
                return text.StartsWith("[", StringComparison.Ordinal) &&
                    !text
                    .Substring(1)
                    .TrimStart()
                    .StartsWith("]", StringComparison.Ordinal)
            }

            private func GetBreakTarget(node Microsoft.CodeAnalysis.CSharp.Syntax.YieldStatementSyntax) Microsoft
                .CodeAnalysis
                .SyntaxNode -> node
                .Ancestors().FirstOrDefault(
                (n Microsoft.CodeAnalysis.SyntaxNode) -> n is BaseMethodDeclarationSyntax ||
                    n is AccessorDeclarationSyntax ||
                    n is LocalFunctionStatementSyntax
            ) ??
                node

            // Issue #1943: AND-folds every boolean test `TranslatePattern` collected
            // into `guards` (a typed positional/property subpattern with no room in
            // its `TypePattern` GPattern node — see `TranslateRecursivePattern`'s
            // `PositionalPatternClause` branch) together with the arm's own explicit
            // `when` clause, if any. Returns <see langword="null"/> when there is
            // nothing to guard on, so a plain arm with no synthesized test and no
            // `when` clause keeps emitting no guard at all.
            private func CombinePatternGuards(guards List[GExpression], whenGuard GExpression?) GExpression? {
                var combined GExpression? = nil
                for guardTest in guards {
                    combined = if combined == nil {
                        guardTest
                    } else {
                        cast[GExpression](BinaryExpression(combined, "&&", guardTest))
                    }
                }
                if whenGuard == nil {
                    return combined
                }
                return if combined == nil {
                    whenGuard
                } else {
                    cast[GExpression](BinaryExpression(combined, "&&", whenGuard))
                }
            }

            private func LowerCamel(name string) string {
                if string.IsNullOrEmpty(name) {
                    return name
                }
                return char.ToLowerInvariant(name[0]) + name.Substring(1)
            }

            // Issue #1839 (N3): appends a numeric suffix (`circle_2`, `circle_3`, …)
            // when `name` was already used earlier in the same arm/scope, so two
            // typed recursive subpatterns that happen to collapse to the same
            // designator (distinct types sharing a rightmost simple name, or an
            // explicit designation colliding with a synthesized one) get distinct,
            // compilable locals instead of silently shadowing one another.
            private func Uniquify(name string?, usedDesignators HashSet[string]?) string? {
                var candidate string? = name
                var suffix = 2
                while !usedDesignators!!.Add(candidate!!) {
                    candidate = "${name}_$suffix"
                    suffix++
                }
                return candidate
            }
        }
    }
}
