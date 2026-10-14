// <copyright file="CSharpToGSharpTranslator.GenericStoreBridges.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import System
import System.Collections.Generic
import System.Linq

/// Issue #4612 (option 1): reports every fail-fast `!!` that cs2gs puts on
/// a value stored into generic storage.
/// @remarks Generic storage is a slot declared as a type parameter (`list.Add(x)`,
/// `items.Append(x)`, `Func<T, R>.Invoke(x)`, `dict[k] = v`,
/// a lambda result returned into `Func<..., TResult>`), an array or
/// collection-expression element (`new[] { a, b }`, `arr[i] = v`,
/// `[a, b]`), an iterator element, and a user-written C# `value!` on a type-parameter
/// value. C# lets a maybe-null value reach any of them and stores the null. cs2gs keeps its fail-fast
/// policy
/// there: the translation asserts the value, so the migrated program throws
/// where the C# ran. Translation, compilation and IL verification all pass, so
/// this report is how such a site becomes visible.
///
/// Every store-position bridge reports through (cref:DeclarationVisitor.ReportStoreBridge)
/// after it has decided, so the generated code is unchanged. A bridge whose
/// target symbol is unknown reports as `unknown-target`: the list
/// over-approximates rather than missing a site.
partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// Called by every store-position bridge with the value before and after
        /// the bridge. Reports when the bridge added a `!!` and the target
        /// is, or may be, generic storage. Returns [`bridged`](paramref).
        /// @param value The C# value stored into the slot.
        /// @param original The translated value before the bridge.
        /// @param bridged The translated value after the bridge.
        /// @param targetSymbol The slot's symbol, or `null` when unknown.
        /// @param knownSlotType The element type a collection-expression translation resolved, or `null`.
        /// @param projection The asserted synthesized member path, or null for the source value.
        /// @returns [`bridged`](paramref), unchanged.
        private func ReportStoreBridge(
            value ExpressionSyntax?,
            original GExpression?,
            bridged GExpression?,
            targetSymbol ISymbol?,
            knownSlotType ITypeSymbol? = nil,
            projection string? = nil
        ) GExpression? {
            var targetSymbol = targetSymbol
            var knownSlotType = knownSlotType
            // gsc erases a reference `!!` inside an expression tree, so it
            // cannot throw there and is not reported.
            if value == nil || object.ReferenceEquals(original, bridged) ||
                bridged is not NonNullAssertionExpression assertion ||
                this.IsWithinExpressionTreeLambda(value) {
                return bridged
            }
            var operatorInput = targetSymbol is IParameterSymbol{ContainingSymbol: IMethodSymbol operatorMethod} &&
                operatorMethod.MethodKind == MethodKind.Conversion
            if !operatorInput && object.ReferenceEquals(assertion.Operand, original) {
                let conversionTarget ITypeSymbol? = knownSlotType ?? this.GetFixedElementDestinationType(
                    value,
                    targetSymbol
                ) ??
                    ObliviousNullabilityAnalyzer.SymbolValueType(targetSymbol)
                if this.GetUserDefinedConversionInputOperator(value, conversionTarget, out _) is {} conversionOperator {
                    // An input assertion guards the operator parameter, not its result's store.
                    targetSymbol = conversionOperator.Parameters[0]
                    knownSlotType = conversionOperator.Parameters[0].Type
                    operatorInput = true
                }
            }
            if !operatorInput {
                let (finalStore, resolvedSlotType) = this.ResolveFinalStore(value)
                if finalStore != nil {
                    targetSymbol = finalStore
                    knownSlotType ??= resolvedSlotType
                }
            }
            let kind string? = this.ClassifyGenericStoreSlot(
                value,
                targetSymbol,
                knownSlotType,
                out var slotType,
                out var resultDependsOnSlot
            )
            if kind == nil {
                return bridged
            }
            slotType = GetBridgedSlotType(value, knownSlotType) ?? slotType
            this.ReportGenericStore(
                value,
                value.ToString(),
                kind,
                targetSymbol,
                slotType,
                resultDependsOnSlot,
                projection
            )
            return bridged
        }

        /// Called by the translation of a user-written C# `expr!`, which C#
        /// erases and G# checks at run time. Reports when the translation added
        /// a `!!` and either the operand's type is a type parameter (the
        /// #4681 shape: `value!` on an unconstrained `T` that may hold
        /// null) or the target is a resolved generic store. A user `!` on a
        /// concrete-typed value whose target is unresolved is not reported: the
        /// C# author asserted it, and it is outside the generic-store class.
        /// Returns [`bridged`](paramref).
        /// @param forgiving The C# `expr!`.
        /// @param original The translated operand.
        /// @param bridged The translated operand after the bridge.
        /// @param targetSymbol The value's target, or `null`.
        /// @returns [`bridged`](paramref), unchanged.
        private func ReportForgivenStoreBridge(
            forgiving PostfixUnaryExpressionSyntax,
            original GExpression?,
            bridged GExpression?,
            targetSymbol ISymbol?
        ) GExpression? {
            var targetSymbol = targetSymbol
            if object.ReferenceEquals(original, bridged) ||
                !(bridged is NonNullAssertionExpression) ||
                original is NonNullAssertionExpression ||
                this.IsWithinExpressionTreeLambda(forgiving) {
                return bridged
            }
            var kind string?
            var slotType ITypeSymbol?
            var resultDependsOnSlot = false
            let (finalStore, knownSlotType) = this.ResolveFinalStore(forgiving)
            if finalStore != nil {
                targetSymbol = finalStore
            }
            if this.context.GetTypeInfo(forgiving.Operand).Type is ITypeParameterSymbol operandType {
                kind = "forgiven-type-parameter-value"
                slotType = operandType
                this.ClassifyGenericStoreSlot(forgiving, targetSymbol, knownSlotType, out _, out resultDependsOnSlot)
            } else {
                kind = this.ClassifyGenericStoreSlot(
                    forgiving,
                    targetSymbol,
                    knownSlotType,
                    out slotType,
                    out resultDependsOnSlot
                )
                if kind == nil || kind == "unknown-target" {
                    return bridged
                }
                kind = "forgiven," + kind
            }
            this.ReportGenericStore(forgiving, forgiving.ToString(), kind, targetSymbol, slotType, resultDependsOnSlot)
            return bridged
        }

        private func ReportGenericStore(
            value ExpressionSyntax?,
            valueText string,
            kind string?,
            targetSymbol ISymbol?,
            slotType ITypeSymbol?,
            resultDependsOnSlot bool,
            projection string? = nil
        ) {
            let target = if targetSymbol is IParameterSymbol parameterTarget &&
                parameterTarget.ContainingSymbol != nil {
                parameterTarget.ContainingSymbol.ToDisplayString(SymbolDisplayFormat.CSharpShortErrorMessageFormat) +
                    " parameter '" +
                    parameterTarget.Name +
                    "'"
            } else {
                targetSymbol?.ToDisplayString(SymbolDisplayFormat.CSharpShortErrorMessageFormat) ?? "?"
            }
            let typeArgument = if slotType == nil {
                "?"
            } else {
                slotType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) +
                    " (" +
                    slotType
                    .NullableAnnotation
                    .ToString() + ")"
            }
            // Keep the value on one line within 160 characters, reserving
            // space for the asserted synthesized leaf.
            var text = valueText
            let maxSourceTextLength = MaxValueTextLength - (projection?.Length ?? 0)
            let lineEnd = text.IndexOfAny(LineBreakCharacters)
            if lineEnd >= 0 || text.Length > maxSourceTextLength {
                let cut = Math.Min(
                    if lineEnd >= 0 {
                        lineEnd
                    } else {
                        text.Length
                    },
                    maxSourceTextLength - Ellipsis.Length
                )
                text = text.Substring(0, cut).TrimEnd() + Ellipsis
            }
            text += projection
            this.context.ReportOnce(
                TranslationDiagnostic(
                    "GenericStoreBridge",
                    "kind=$kind | target=$target | slot-type=$typeArgument | result-depends-on-slot=${(if resultDependsOnSlot { "yes" } else { "no" })} | value=$text",
                    value!!.GetLocation(),
                    TranslationSeverity.Warning
                ){DiagnosticId = CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId},
                projection
            )
        }

        /// The final argument or element store a value feeds through the shared
        /// transparent traversal, including value-producing assignments.
        /// @param value The stored value.
        /// @returns The store and its known slot type; nulls when no final store resolves.
        private func ResolveFinalStore(value ExpressionSyntax?)(Store ISymbol?, SlotType ITypeSymbol?) {
            let storeNodes = List[SyntaxNode]()
            storeNodes.Insert(0, OutermostTransparentNode(value, storeNodes: storeNodes)!!)
            for node in storeNodes {
                let (store, slotType) = this.ResolveStoreAtNode(node, value)
                let kind string? = this.ClassifyGenericStoreSlot(value, store, slotType, out _, out _)
                if kind != nil && kind != "unknown-target" {
                    return (store, slotType)
                }
            }
            return (nil, nil)
        }

        private func ResolveStoreAtNode(node SyntaxNode?, value ExpressionSyntax?)(
            Store ISymbol?,
            SlotType ITypeSymbol?
        ) {
            switch node!!.Parent {
                case argument is ArgumentSyntax when argument.Parent is BaseArgumentListSyntax {
                    return (this.GetArgumentParameter(argument), nil)
                }
                case initializer is InitializerExpressionSyntax when initializer.IsKind(
                    SyntaxKind.ArrayInitializerExpression
                ) {
                    return (this.ArrayTypeOfInitializer(initializer), nil)
                }
                case initializer is InitializerExpressionSyntax when initializer.IsKind(
                    SyntaxKind.CollectionInitializerExpression
                ) ||
                    (
                    initializer.IsKind(SyntaxKind.ComplexElementInitializerExpression) && initializer.Parent.IsKind(
                        SyntaxKind.CollectionInitializerExpression
                    )
                ) {
                    {
                        let complex = initializer.IsKind(SyntaxKind.ComplexElementInitializerExpression)
                        let element ExpressionSyntax? = if complex {
                            cast[ExpressionSyntax](initializer)
                        } else {
                            cast[ExpressionSyntax](node)
                        }
                        let addMethod IMethodSymbol? = this
                            .context
                            .SemanticModel
                            .GetCollectionInitializerSymbolInfo(element!!)
                            .Symbol as IMethodSymbol
                        let index = if complex {
                            initializer.Expressions.IndexOf(cast[ExpressionSyntax](node))
                        } else {
                            0
                        }
                        return if addMethod != nil && this.TryGetCollectionInitializerArgumentTarget(
                            cast[ExpressionSyntax](node),
                            index,
                            addMethod,
                            addMethod,
                            out var targetType,
                            out var parameter
                        ) {
                            (parameter, targetType)
                        } else {
                            (nil, nil)
                        }
                    }
                }
                case ExpressionElementSyntax{Parent: CollectionExpressionSyntax collection} {
                    {
                        // The element (or Add) type CoerceCollectionElement bound
                        // this element to; never a guess from generic arity.
                        let collectionType ITypeSymbol? = this.context.GetTypeInfo(collection).ConvertedType
                        this.state.CollectionElementSlots.TryGetValue(node!!, out var elementType)
                        return (collectionType, elementType)
                    }
                }
                case assignment is AssignmentExpressionSyntax when assignment.Right == node {
                    return (
                        this
                            .context
                            .GetSymbolInfo(assignment.Left)
                            .Symbol ??
                            (
                            if assignment.Left is ElementAccessExpressionSyntax elementAccess {
                                this.context.GetTypeInfo(elementAccess.Expression).Type as IArrayTypeSymbol
                            } else {
                                default(IArrayTypeSymbol?)
                            }
                        ),
                        nil
                    )
                }
                case yielded is YieldStatementSyntax {
                    {
                        let iterator IMethodSymbol? = this
                            .context
                            .SemanticModel
                            .GetEnclosingSymbol(yielded.SpanStart) as IMethodSymbol
                        return (
                            iterator,
                            if iterator == nil {
                                default(ITypeSymbol?)
                            } else {
                                this.GetIteratorStoreSlot(value, iterator)
                            }
                        )
                    }
                }
                case lambda is AnonymousFunctionExpressionSyntax when lambda.Body == node {
                    return (
                        (this.context.GetTypeInfo(lambda).ConvertedType as INamedTypeSymbol)?.DelegateInvokeMethod,
                        nil
                    )
                }
                default {
                    return (this.ResolveValueSink(cast[ExpressionSyntax](node)), nil)
                }
            }
        }

        /// Classifies a bridged store target. Returns `null` when
        /// the slot is declared with a concrete type, and a kind otherwise.
        private func ClassifyGenericStoreSlot(
            value ExpressionSyntax?,
            targetSymbol ISymbol?,
            knownSlotType ITypeSymbol?,
            out slotType ITypeSymbol?,
            out resultDependsOnSlot bool
        ) string? {
            slotType = nil
            resultDependsOnSlot = false
            switch targetSymbol {
                case nil {
                    return "unknown-target"
                }
                case parameter is IParameterSymbol {
                    {
                        // A parameter variable is not a call-site parameter slot.
                        // Resolve the final slot first: an assignment result can
                        // still feed a genuine argument, even to this same method.
                        let parameterStores = List[SyntaxNode]()
                        let finalValue SyntaxNode? = OutermostTransparentNode(value, storeNodes: parameterStores)
                        let parameterIsFinalStore = SymbolEqualityComparer.Default.Equals(
                            this.ResolveStoreAtNode(finalValue, value).Store,
                            parameter
                        )
                        if (parameterIsFinalStore && finalValue!!.Parent is AssignmentExpressionSyntax) ||
                            (
                            !parameterIsFinalStore && parameterStores.Any(
                                (node SyntaxNode) -> SymbolEqualityComparer.Default.Equals(
                                    this.ResolveStoreAtNode(node, value).Store,
                                    parameter
                                )
                            )
                        ) {
                            slotType = parameter.Type
                            return if slotType is ITypeParameterSymbol {
                                "type-parameter-assignment"
                            } else {
                                this.ClassifyTupleStoreSlot(value, parameter, out slotType, out resultDependsOnSlot)
                            }
                        }
                        // Fail-safe: a params value is an element unless it is
                        // provably the direct, non-expanded argument (an explicit
                        // argument operation of its own, as TranslateArgumentValue
                        // tests). A collection-initializer element or a value nested
                        // in a tuple or conditional is therefore classified by the
                        // element slot rather than dropped.
                        let directArgument = (
                            EnclosingInvocationArgument(value) is {} argument &&
                                this
                                .context
                                .SemanticModel
                                .GetOperation(argument) is IArgumentOperation operation &&
                                operation.ArgumentKind == ArgumentKind.Explicit
                        ) ||
                            (
                            knownSlotType != nil && SymbolEqualityComparer.Default.Equals(knownSlotType, parameter.Type)
                        )
                        let expandedParams = parameter.IsParams && !directArgument
                        return ClassifyParameterSlot(
                            parameter,
                            value,
                            expandedParams,
                            out slotType,
                            out resultDependsOnSlot
                        ) ??
                            this.ClassifyTupleStoreSlot(
                            value,
                            parameter,
                            out slotType,
                            out resultDependsOnSlot,
                            parameterArgument: true
                        )
                    }
                }
                case property is IPropertySymbol when property.OriginalDefinition.Type is ITypeParameterSymbol {
                    slotType = GetBridgedSlotType(value, property.Type)
                    return "constructed-generic-member"
                }
                case field is IFieldSymbol when field.OriginalDefinition.Type is ITypeParameterSymbol {
                    slotType = GetBridgedSlotType(value, field.Type)
                    return "constructed-generic-member"
                }
                case invoke is IMethodSymbol when invoke.MethodKind == MethodKind.DelegateInvoke {
                    {
                        // An expression-bodied lambda's result: unwrap Task<T> when
                        // the lambda is async, as the bridge guards the inner value.
                        let asyncLambda = OutermostTransparentNode(
                            value
                        )!!.Parent is AnonymousFunctionExpressionSyntax function &&
                            function
                            .AsyncKeyword
                            .IsKind(SyntaxKind.AsyncKeyword)
                        return DelegateResultSlot(invoke, asyncLambda, value, out slotType) ??
                            this.ClassifyTupleStoreSlot(value, invoke, out slotType, out resultDependsOnSlot)
                    }
                }
                case local is ILocalSymbol when local.Type is ITypeParameterSymbol {
                    // A local declared as an in-scope type parameter (`T copy`).
                    slotType = local.Type
                    return "type-parameter-local"
                }
                case iterator is IMethodSymbol when OutermostTransparentNode(
                    value
                )!!.Parent is YieldStatementSyntax yielded {
                    slotType = knownSlotType ?? this.GetIteratorStoreSlot(value, iterator)
                    return "iterator-element"
                }
                case returning is IMethodSymbol when returning.MethodKind != MethodKind.AnonymousFunction &&
                    returning.MethodKind != MethodKind.DelegateInvoke &&
                    GetEffectiveReturnType(returning.ReturnType, returning.IsAsync) is ITypeParameterSymbol {
                    // A method's result declared as a type parameter (`return
                    // maybe;` in `T M<T>(...)`, or the `T` of an async Task<T>).
                    slotType = GetEffectiveReturnType(returning.ReturnType, returning.IsAsync)
                    return "type-parameter-return"
                }
                case array is IArrayTypeSymbol {
                    // An array element: the CLR's built-in generic storage.
                    // C# stores a null there as readily as in List<T> (#4628:
                    // `new[] { p.GetMethod, p.SetMethod }.OfType<MethodInfo>()`).
                    slotType = GetBridgedSlotType(value, array.ElementType)
                    return "array-element"
                }
                case INamedTypeSymbol {
                    // A collection-expression element: the element (or Add)
                    // type the collection-expression translation resolved,
                    // never a guess from the collection's generic arity.
                    if knownSlotType == nil {
                        return "unknown-target"
                    }
                    slotType = GetBridgedSlotType(value, knownSlotType)
                    return "collection-expression-element"
                }
                case lambda is IMethodSymbol when lambda.MethodKind == MethodKind.AnonymousFunction {
                    {
                        // A lambda's result is stored into its delegate's return
                        // slot (`Func<T, TResult>`'s TResult).
                        let lambdaSyntax SyntaxNode? = lambda.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                        let delegateInvoke IMethodSymbol? = if lambdaSyntax == nil {
                            default(IMethodSymbol?)
                        } else {
                            (
                                this.context.GetTypeInfo(lambdaSyntax).ConvertedType as INamedTypeSymbol
                            )?.DelegateInvokeMethod
                        }
                        if delegateInvoke == nil {
                            return "unknown-target"
                        }
                        return DelegateResultSlot(delegateInvoke, lambda.IsAsync, value, out slotType) ??
                            this.ClassifyTupleStoreSlot(
                            value,
                            delegateInvoke,
                            out slotType,
                            out resultDependsOnSlot,
                            isAsync: lambda.IsAsync
                        )
                    }
                }
                default {
                    return this.ClassifyTupleStoreSlot(value, targetSymbol, out slotType, out resultDependsOnSlot)
                }
            }
        }

        private func ClassifyTupleStoreSlot(
            value ExpressionSyntax?,
            targetSymbol ISymbol?,
            out slotType ITypeSymbol?,
            out resultDependsOnSlot bool,
            parameterArgument bool = false,
            isAsync bool = false
        ) string? {
            let GetStoreType = func (symbol ISymbol?, asyncLambda bool) ITypeSymbol? {
                return switch symbol {
                    case field is IFieldSymbol: field.Type
                    case local is ILocalSymbol: local.Type
                    case parameter is IParameterSymbol: parameter.Type
                    case property is IPropertySymbol: property.Type
                    case method is IMethodSymbol: GetEffectiveReturnType(
                        method.ReturnType,
                        method.IsAsync || asyncLambda
                    )
                    default: default(ITypeSymbol?)
                }
            }
            slotType = nil
            resultDependsOnSlot = false
            let tupleIndices = List[int32]()
            let node SyntaxNode? = OutermostTransparentNode(value, tupleIndices)
            if tupleIndices.Count == 0 {
                return nil
            }
            let asyncLambda = isAsync ||
                (
                node!!.Parent is AnonymousFunctionExpressionSyntax function && function.AsyncKeyword.IsKind(
                    SyntaxKind.AsyncKeyword
                )
            )
            let declared ITypeSymbol? = GetTupleSlot(
                GetStoreType(targetSymbol?.OriginalDefinition, asyncLambda),
                tupleIndices
            )
            if declared is not ITypeParameterSymbol typeParameter {
                return nil
            }
            slotType = GetTupleSlot(GetStoreType(targetSymbol, asyncLambda), tupleIndices)
            resultDependsOnSlot = parameterArgument &&
                targetSymbol is IParameterSymbol{ContainingSymbol: IMethodSymbol method} &&
                CallResultMentionsTypeParameter(method, typeParameter)
            return if slotType == nil {
                default(string?)
            } else {
                "type-parameter-tuple-element"
            }
        }

        /// The array an initializer element is stored into. A rectangular
        /// array's rows are nested initializers with no type of their own, so
        /// this climbs to the outermost initializer first, then reads its
        /// converted type (a bare `string[] xs = { ... }`) or the creation
        /// expression's type (`new T[,,] { ... }`).
        /// @param initializer An array initializer at any nesting depth.
        /// @returns The array type, or `null` when it cannot be resolved.
        private func ArrayTypeOfInitializer(initializer InitializerExpressionSyntax) IArrayTypeSymbol? {
            var outermost = initializer
            while outermost.Parent is InitializerExpressionSyntax parent && parent.IsKind(
                SyntaxKind.ArrayInitializerExpression
            ) {
                outermost = parent
            }
            return this
                .context
                .GetTypeInfo(outermost)
                .ConvertedType as IArrayTypeSymbol ??
                this
                .context
                .GetTypeInfo(outermost.Parent)
                .Type as IArrayTypeSymbol
        }

        private func GetIteratorStoreSlot(value ExpressionSyntax?, iterator IMethodSymbol) ITypeSymbol? {
            let tupleIndices = List[int32]()
            let node SyntaxNode? = OutermostTransparentNode(value, tupleIndices)
            if node!!.Parent is not YieldStatementSyntax yielded {
                return nil
            }
            // A bound generic iterator returns one of the enumerable/enumerator
            // envelopes. Use MapReturnType's emitted scalar element contract
            // before following the tuple path; the operand may have another type.
            var slotType ITypeSymbol? = if iterator.ReturnType is INamedTypeSymbol returnType &&
                returnType
                .TypeArguments
                .Length == 1 {
                returnType.TypeArguments[0]
            } else {
                this.context.GetTypeInfo(yielded.Expression).ConvertedType
            }
            if (iterator.ReturnType is INamedTypeSymbol and {Name: "IEnumerable"}) && this.AwaitedReturnIsTainted(
                slotType,
                iterator
            ) {
                slotType = slotType!!.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
            }
            return GetTupleSlot(slotType, tupleIndices)
        }

        shared {
            // A reported value is its first line, at most this many characters.
            private const MaxValueTextLength int32 = 160

            private const Ellipsis string = "..."
            private let LineBreakCharacters[]char = []char{'\r', '\n'}

            /// Classifies a parameter slot. Uses no visitor state, so a test can call
            /// it directly for a shape no self-contained translation reaches.
            /// @param parameter The target parameter (the params parameter for an expanded params argument).
            /// @param value The C# value passed to it.
            /// @param expandedParams Whether the value is an expanded params element.
            /// @param slotType The slot's type after substitution.
            /// @param resultDependsOnSlot Whether the call's result type mentions the slot's type parameter.
            /// @returns The kind, or `null` when the slot is not a type parameter.
            internal func ClassifyParameterSlot(
                parameter IParameterSymbol,
                value ExpressionSyntax?,
                expandedParams bool,
                out slotType ITypeSymbol?,
                out resultDependsOnSlot bool
            ) string? {
                resultDependsOnSlot = false
                var declared ITypeSymbol? = parameter.OriginalDefinition.Type
                slotType = parameter.Type
                var paramsElement = false
                // Only an expanded params argument is an element; an array or
                // collection passed directly is stored whole. GetParamsElementType
                // covers params arrays and params collections (ReadOnlySpan<T>, ...).
                if expandedParams &&
                    GetParamsElementType(parameter.OriginalDefinition) is {} declaredElement &&
                    GetParamsElementType(parameter) is {} constructedElement {
                    declared = GetBridgedSlotType(value, declaredElement)
                    slotType = constructedElement
                    paramsElement = true
                }
                slotType = GetBridgedSlotType(value, slotType)
                if declared is not ITypeParameterSymbol typeParameter {
                    // An expanded element of a concrete params array
                    // (`Path.Combine(params string[])`) is stored into that array:
                    // an array element like any other.
                    return if paramsElement {
                        "params-element"
                    } else {
                        default(string?)
                    }
                }
                // Whether the call's result type mentions the slot's type
                // parameter, for every owner (a method's, a delegate's or a
                // containing type's): `Append<T>` -> IEnumerable<T>,
                // `delegate T Echo<T>(T)`, `Box<T>.Store(T): T`.
                let method IMethodSymbol? = parameter.ContainingSymbol as IMethodSymbol
                resultDependsOnSlot = CallResultMentionsTypeParameter(method, typeParameter)
                if method?.MethodKind == MethodKind.DelegateInvoke {
                    return "delegate-invoke"
                }
                if typeParameter.TypeParameterKind == TypeParameterKind.Method {
                    let methodKind = if ValueFeedsExplicitTypeArguments(value) {
                        "explicit-type-argument"
                    } else {
                        "inferred-method-type-parameter"
                    }
                    return if paramsElement {
                        methodKind + ",params-element"
                    } else {
                        methodKind
                    }
                }
                return if paramsElement {
                    "constructed-generic-member,params-element"
                } else {
                    "constructed-generic-member"
                }
            }

            // Whether the call that receives `value` as an argument spells its type
            // arguments (`Identity<SyntaxNode>(x)`), as opposed to inferring them.
            // A value nested in transparent containers (parentheses, a C# `!`, a
            // conditional or switch arm, a tuple element) counts as the enclosing
            // invocation argument, as the store bridges resolve it.
            private func ValueFeedsExplicitTypeArguments(value ExpressionSyntax?) bool -> EnclosingInvocationArgument(
                value
            ) is {Parent: ArgumentListSyntax{Parent: InvocationExpressionSyntax invocation}} &&
                HasExplicitTypeArguments(invocation.Expression)

            private func EnclosingInvocationArgument(
                value ExpressionSyntax?
            ) ArgumentSyntax? -> if OutermostTransparentNode(value)!!.Parent is ArgumentSyntax{
                Parent: BaseArgumentListSyntax
            } argument {
                argument
            } else {
                default(ArgumentSyntax?)
            }

            // The single definition of "transparent" for the store bridges: the
            // stored value seen through parentheses, casts, checked wrappers, a C#
            // `!`, null-preserving operators, conditional/switch arms, and tuple
            // elements. Every classification that needs
            // the enclosing store or argument starts here.
            private func OutermostTransparentNode(
                value ExpressionSyntax?,
                tupleIndices List[int32]? = nil,
                storeNodes List[SyntaxNode]? = nil
            ) SyntaxNode? {
                var node SyntaxNode? = value
                while true {
                    let parent SyntaxNode? = node!!.Parent
                    switch parent {
                        case ParenthesizedExpressionSyntax {
                            node = parent
                        }
                        case CastExpressionSyntax {
                            node = parent
                        }
                        case CheckedExpressionSyntax {
                            node = parent
                        }
                        case ConditionalAccessExpressionSyntax {
                            node = parent
                        }
                        case forgiving is PostfixUnaryExpressionSyntax when forgiving.IsKind(
                            SyntaxKind.SuppressNullableWarningExpression
                        ) {
                            node = parent
                        }
                        case binary is BinaryExpressionSyntax when binary.IsKind(SyntaxKind.CoalesceExpression) ||
                            (binary.IsKind(SyntaxKind.AsExpression) && binary.Left == node) {
                            node = parent
                        }
                        case assignment is AssignmentExpressionSyntax when assignment.Right == node &&
                            (
                            assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) || assignment.IsKind(
                                SyntaxKind.CoalesceAssignmentExpression
                            )
                        ) {
                            storeNodes?.Add(node!!)
                            node = parent
                        }
                        case conditional is ConditionalExpressionSyntax when conditional.Condition != node {
                            node = parent
                        }
                        case arm is SwitchExpressionArmSyntax when arm.Expression == node {
                            node = arm.Parent
                        }
                        case tupleElement is ArgumentSyntax when tupleElement.Parent is TupleExpressionSyntax tuple {
                            tupleIndices?.Add(tuple.Arguments.IndexOf(tupleElement))
                            node = tuple
                        }
                        default {
                            return node
                        }
                    }
                }
            }

            private func GetTupleSlot(slotType ITypeSymbol?, tupleIndices List[int32]) ITypeSymbol? {
                var slotType = slotType
                for var i = tupleIndices.Count - 1; i >= 0; i-- {
                    if slotType is INamedTypeSymbol nullable &&
                        nullable
                        .OriginalDefinition
                        .SpecialType == SpecialType.System_Nullable_T &&
                        nullable
                        .TypeArguments
                        .Length == 1 &&
                        nullable.TypeArguments[0] is INamedTypeSymbol{IsTupleType: true} underlyingTuple {
                        slotType = underlyingTuple
                    }
                    if slotType is not INamedTypeSymbol{IsTupleType: true} tupleType {
                        return slotType
                    }
                    if tupleIndices[i] >= tupleType.TupleElements.Length {
                        return nil
                    }
                    slotType = GetEffectiveTupleElementType(tupleType, tupleIndices[i])
                }
                return slotType
            }

            private func GetBridgedSlotType(value ExpressionSyntax?, slotType ITypeSymbol?) ITypeSymbol? {
                if value == nil || !(slotType is INamedTypeSymbol) {
                    return slotType
                }
                let tupleIndices = List[int32]()
                OutermostTransparentNode(value, tupleIndices)
                return GetTupleSlot(slotType, tupleIndices)
            }

            // A lambda result stored into its delegate's return slot. An async
            // lambda's `!!` guards the value inside the task, so both the declared
            // and the constructed return types are unwrapped (GetEffectiveReturnType).
            private func DelegateResultSlot(
                delegateInvoke IMethodSymbol,
                isAsync bool,
                value ExpressionSyntax?,
                out slotType ITypeSymbol?
            ) string? {
                let declared = delegateInvoke.OriginalDefinition.ReturnType
                slotType = GetBridgedSlotType(value, GetEffectiveReturnType(delegateInvoke.ReturnType, isAsync))
                return if declared is ITypeParameterSymbol ||
                    GetEffectiveReturnType(declared, isAsync) is ITypeParameterSymbol {
                    "delegate-result"
                } else {
                    default(string?)
                }
            }

            private func CallResultMentionsTypeParameter(
                method IMethodSymbol?,
                typeParameter ITypeParameterSymbol
            ) bool {
                if method == nil {
                    return false
                }
                let contract = method.OriginalDefinition
                // Constructor calls produce their containing type, not the CLR void return.
                return MentionsTypeParameter(
                    if contract.MethodKind == MethodKind.Constructor {
                        (contract.ContainingType as ITypeSymbol)
                    } else {
                        contract.ReturnType
                    },
                    typeParameter
                )
            }

            private func MentionsTypeParameter(type ITypeSymbol?, typeParameter ITypeParameterSymbol) bool {
                if type == nil {
                    return false
                }
                if SymbolEqualityComparer.Default.Equals(type, typeParameter) {
                    return true
                }
                if type is IArrayTypeSymbol array {
                    return MentionsTypeParameter(array.ElementType, typeParameter)
                }
                if type is IPointerTypeSymbol pointer {
                    return MentionsTypeParameter(pointer.PointedAtType, typeParameter)
                }
                if type is IFunctionPointerTypeSymbol functionPointer {
                    return MentionsTypeParameter(functionPointer.Signature.ReturnType, typeParameter) ||
                        functionPointer
                        .Signature
                        .Parameters
                        .Any((parameter IParameterSymbol) -> MentionsTypeParameter(parameter.Type, typeParameter))
                }
                // A nested type carries its containing types' type parameters
                // (`Box<T>.Result`).
                return type is INamedTypeSymbol named &&
                    (
                    named.TypeArguments.Any((argument ITypeSymbol) -> MentionsTypeParameter(argument, typeParameter)) ||
                        MentionsTypeParameter(named.ContainingType, typeParameter)
                )
            }
        }
    }

    shared {
        /// The diagnostic id for a fail-fast `!!` on a value stored into
        /// generic storage (see the class remarks). A forwarded, non-fatal warning:
        /// every site goes to the app's `translate.log`.
        const GenericStoreBridgeDiagnosticId string = "CS2GS-GENERIC-STORE-BRIDGE"

        /// Test access to the parameter-slot classification (the visitor is private).
        /// @param parameter The target parameter.
        /// @param value The C# value passed to it.
        /// @param expandedParams Whether the value is an expanded params element.
        /// @param slotType The slot's type after substitution.
        /// @param resultDependsOnSlot Whether the call's result type mentions the slot's type parameter.
        /// @returns The kind, or `null` when the slot is not a type parameter.
        internal func ClassifyParameterSlotForTests(
            parameter IParameterSymbol,
            value ExpressionSyntax,
            expandedParams bool,
            out slotType ITypeSymbol?,
            out resultDependsOnSlot bool
        ) string? -> DeclarationVisitor.ClassifyParameterSlot(
            parameter,
            value,
            expandedParams,
            out slotType,
            out resultDependsOnSlot
        )
    }
}
