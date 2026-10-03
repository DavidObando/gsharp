// <copyright file="CSharpToGSharpTranslator.GenericStoreBridges.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Cs2Gs.Translator;

/// <summary>
/// Issue #4612 (option 1): reports every fail-fast <c>!!</c> that cs2gs puts on
/// a value stored into generic storage.
/// </summary>
/// <remarks>
/// <para>
/// Generic storage is a slot declared as a type parameter (<c>list.Add(x)</c>,
/// <c>items.Append(x)</c>, <c>Func&lt;T, R&gt;.Invoke(x)</c>, <c>dict[k] = v</c>,
/// a lambda result returned into <c>Func&lt;..., TResult&gt;</c>), an array or
/// collection-expression element (<c>new[] { a, b }</c>, <c>arr[i] = v</c>,
/// <c>[a, b]</c>), an iterator element, and a user-written C# <c>value!</c> on a type-parameter
/// value. C# lets a maybe-null value reach any of them and stores the null. cs2gs keeps its fail-fast policy
/// there: the translation asserts the value, so the migrated program throws
/// where the C# ran. Translation, compilation and IL verification all pass, so
/// this report is how such a site becomes visible.
/// </para>
/// <para>
/// Every store-position bridge reports through <see cref="DeclarationVisitor.ReportStoreBridge"/>
/// after it has decided, so the generated code is unchanged. A bridge whose
/// target symbol is unknown reports as <c>unknown-target</c>: the list
/// over-approximates rather than missing a site.
/// </para>
/// </remarks>
public sealed partial class CSharpToGSharpTranslator
{
    /// <summary>
    /// The diagnostic id for a fail-fast <c>!!</c> on a value stored into
    /// generic storage (see the class remarks). A forwarded, non-fatal warning:
    /// every site goes to the app's <c>translate.log</c>.
    /// </summary>
    public const string GenericStoreBridgeDiagnosticId = "CS2GS-GENERIC-STORE-BRIDGE";

    /// <summary>
    /// Test access to the parameter-slot classification (the visitor is private).
    /// </summary>
    /// <param name="parameter">The target parameter.</param>
    /// <param name="value">The C# value passed to it.</param>
    /// <param name="expandedParams">Whether the value is an expanded params element.</param>
    /// <param name="slotType">The slot's type after substitution.</param>
    /// <param name="resultDependsOnSlot">Whether the call's result type mentions the slot's type parameter.</param>
    /// <returns>The kind, or <see langword="null"/> when the slot is not a type parameter.</returns>
    internal static string ClassifyParameterSlotForTests(
        IParameterSymbol parameter,
        ExpressionSyntax value,
        bool expandedParams,
        out ITypeSymbol slotType,
        out bool resultDependsOnSlot) =>
        DeclarationVisitor.ClassifyParameterSlot(parameter, value, expandedParams, out slotType, out resultDependsOnSlot);

    private sealed partial class DeclarationVisitor
    {
        // A reported value is its first line, at most this many characters.
        private const int MaxValueTextLength = 160;

        private const string Ellipsis = "...";

        private static readonly char[] LineBreakCharacters = { '\r', '\n' };

        /// <summary>
        /// Classifies a parameter slot. Uses no visitor state, so a test can call
        /// it directly for a shape no self-contained translation reaches.
        /// </summary>
        /// <param name="parameter">The target parameter (the params parameter for an expanded params argument).</param>
        /// <param name="value">The C# value passed to it.</param>
        /// <param name="expandedParams">Whether the value is an expanded params element.</param>
        /// <param name="slotType">The slot's type after substitution.</param>
        /// <param name="resultDependsOnSlot">Whether the call's result type mentions the slot's type parameter.</param>
        /// <returns>The kind, or <see langword="null"/> when the slot is not a type parameter.</returns>
        internal static string ClassifyParameterSlot(
            IParameterSymbol parameter,
            ExpressionSyntax value,
            bool expandedParams,
            out ITypeSymbol slotType,
            out bool resultDependsOnSlot)
        {
            resultDependsOnSlot = false;
            ITypeSymbol declared = parameter.OriginalDefinition.Type;
            slotType = parameter.Type;
            bool paramsElement = false;

            // Only an expanded params argument is an element; an array or
            // collection passed directly is stored whole. GetParamsElementType
            // covers params arrays and params collections (ReadOnlySpan<T>, ...).
            if (expandedParams
                && GetParamsElementType(parameter.OriginalDefinition) is { } declaredElement
                && GetParamsElementType(parameter) is { } constructedElement)
            {
                declared = GetBridgedSlotType(value, declaredElement);
                slotType = constructedElement;
                paramsElement = true;
            }

            slotType = GetBridgedSlotType(value, slotType);
            if (declared is not ITypeParameterSymbol typeParameter)
            {
                // An expanded element of a concrete params array
                // (`Path.Combine(params string[])`) is stored into that array:
                // an array element like any other.
                return paramsElement ? "params-element" : null;
            }

            // Whether the call's result type mentions the slot's type
            // parameter, for every owner (a method's, a delegate's or a
            // containing type's): `Append<T>` -> IEnumerable<T>,
            // `delegate T Echo<T>(T)`, `Box<T>.Store(T): T`.
            IMethodSymbol method = parameter.ContainingSymbol as IMethodSymbol;
            resultDependsOnSlot = method != null
                && MentionsTypeParameter(method.OriginalDefinition.ReturnType, typeParameter);
            if (method?.MethodKind == MethodKind.DelegateInvoke)
            {
                return "delegate-invoke";
            }

            if (typeParameter.TypeParameterKind == TypeParameterKind.Method)
            {
                string methodKind = ValueFeedsExplicitTypeArguments(value)
                    ? "explicit-type-argument"
                    : "inferred-method-type-parameter";
                return paramsElement ? methodKind + ",params-element" : methodKind;
            }

            return paramsElement ? "constructed-generic-member,params-element" : "constructed-generic-member";
        }

        /// <summary>
        /// Called by every store-position bridge with the value before and after
        /// the bridge. Reports when the bridge added a <c>!!</c> and the target
        /// is, or may be, generic storage. Returns <paramref name="bridged"/>.
        /// </summary>
        /// <param name="value">The C# value stored into the slot.</param>
        /// <param name="original">The translated value before the bridge.</param>
        /// <param name="bridged">The translated value after the bridge.</param>
        /// <param name="targetSymbol">The slot's symbol, or <see langword="null"/> when unknown.</param>
        /// <param name="knownSlotType">The element type a collection-expression translation resolved, or <see langword="null"/>.</param>
        /// <param name="projection">The asserted synthesized member path, or null for the source value.</param>
        /// <returns><paramref name="bridged"/>, unchanged.</returns>
        private GExpression ReportStoreBridge(
            ExpressionSyntax value,
            GExpression original,
            GExpression bridged,
            ISymbol targetSymbol,
            ITypeSymbol knownSlotType = null,
            string projection = null)
        {
            // gsc erases a reference `!!` inside an expression tree, so it
            // cannot throw there and is not reported.
            if (value == null
                || ReferenceEquals(original, bridged)
                || bridged is not NonNullAssertionExpression
                || original is NonNullAssertionExpression
                || this.IsWithinExpressionTreeLambda(value))
            {
                return bridged;
            }

            if (targetSymbol == null)
            {
                (ISymbol finalStore, ITypeSymbol resolvedSlotType) = this.ResolveFinalStore(value);
                targetSymbol = finalStore;
                knownSlotType ??= resolvedSlotType;
            }

            string kind = this.ClassifyGenericStoreSlot(value, targetSymbol, knownSlotType, out ITypeSymbol slotType, out bool resultDependsOnSlot);
            if (kind == null)
            {
                return bridged;
            }

            slotType = GetBridgedSlotType(value, knownSlotType) ?? slotType;
            this.ReportGenericStore(value, value.ToString(), kind, targetSymbol, slotType, resultDependsOnSlot, projection);
            return bridged;
        }

        /// <summary>
        /// Called by the translation of a user-written C# <c>expr!</c>, which C#
        /// erases and G# checks at run time. Reports when the translation added
        /// a <c>!!</c> and either the operand's type is a type parameter (the
        /// #4681 shape: <c>value!</c> on an unconstrained <c>T</c> that may hold
        /// null) or the target is a resolved generic store. A user <c>!</c> on a
        /// concrete-typed value whose target is unresolved is not reported: the
        /// C# author asserted it, and it is outside the generic-store class.
        /// Returns <paramref name="bridged"/>.
        /// </summary>
        /// <param name="forgiving">The C# <c>expr!</c>.</param>
        /// <param name="original">The translated operand.</param>
        /// <param name="bridged">The translated operand after the bridge.</param>
        /// <param name="targetSymbol">The value's target, or <see langword="null"/>.</param>
        /// <returns><paramref name="bridged"/>, unchanged.</returns>
        private GExpression ReportForgivenStoreBridge(
            PostfixUnaryExpressionSyntax forgiving,
            GExpression original,
            GExpression bridged,
            ISymbol targetSymbol)
        {
            if (ReferenceEquals(original, bridged)
                || bridged is not NonNullAssertionExpression
                || original is NonNullAssertionExpression
                || this.IsWithinExpressionTreeLambda(forgiving))
            {
                return bridged;
            }

            string kind;
            ITypeSymbol slotType;
            bool resultDependsOnSlot = false;
            (ISymbol finalStore, ITypeSymbol knownSlotType) = this.ResolveFinalStore(forgiving);
            if (finalStore != null)
            {
                targetSymbol = finalStore;
            }

            if (this.context.GetTypeInfo(forgiving.Operand).Type is ITypeParameterSymbol operandType)
            {
                kind = "forgiven-type-parameter-value";
                slotType = operandType;
                this.ClassifyGenericStoreSlot(forgiving, targetSymbol, knownSlotType, out _, out resultDependsOnSlot);
            }
            else
            {
                kind = this.ClassifyGenericStoreSlot(forgiving, targetSymbol, knownSlotType, out slotType, out resultDependsOnSlot);
                if (kind == null || kind == "unknown-target")
                {
                    return bridged;
                }

                kind = "forgiven," + kind;
            }

            this.ReportGenericStore(forgiving, forgiving.ToString(), kind, targetSymbol, slotType, resultDependsOnSlot);
            return bridged;
        }

        private void ReportGenericStore(
            ExpressionSyntax value,
            string valueText,
            string kind,
            ISymbol targetSymbol,
            ITypeSymbol slotType,
            bool resultDependsOnSlot,
            string projection = null)
        {
            string target = targetSymbol is IParameterSymbol parameterTarget && parameterTarget.ContainingSymbol != null
                ? parameterTarget.ContainingSymbol.ToDisplayString(SymbolDisplayFormat.CSharpShortErrorMessageFormat)
                    + " parameter '" + parameterTarget.Name + "'"
                : targetSymbol?.ToDisplayString(SymbolDisplayFormat.CSharpShortErrorMessageFormat) ?? "?";
            string typeArgument = slotType == null
                ? "?"
                : slotType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) + " (" + slotType.NullableAnnotation + ")";

            // Keep the value on one line within 160 characters, reserving
            // space for the asserted synthesized leaf.
            string text = valueText;
            int maxSourceTextLength = MaxValueTextLength - (projection?.Length ?? 0);
            int lineEnd = text.IndexOfAny(LineBreakCharacters);
            if (lineEnd >= 0 || text.Length > maxSourceTextLength)
            {
                int cut = System.Math.Min(lineEnd >= 0 ? lineEnd : text.Length, maxSourceTextLength - Ellipsis.Length);
                text = text.Substring(0, cut).TrimEnd() + Ellipsis;
            }

            text += projection;
            this.context.ReportOnce(
                new TranslationDiagnostic(
                    "GenericStoreBridge",
                    $"kind={kind} | target={target} | slot-type={typeArgument} | result-depends-on-slot={(resultDependsOnSlot ? "yes" : "no")} | value={text}",
                    value.GetLocation(),
                    TranslationSeverity.Warning)
                {
                    DiagnosticId = GenericStoreBridgeDiagnosticId,
                },
                projection);
        }

        /// <summary>
        /// The final argument or element store a value feeds through the shared
        /// transparent traversal, including value-producing assignments.
        /// </summary>
        /// <param name="value">The stored value.</param>
        /// <returns>The store and its known slot type; nulls when no final store resolves.</returns>
        private (ISymbol Store, ITypeSymbol SlotType) ResolveFinalStore(ExpressionSyntax value)
        {
            var storeNodes = new List<SyntaxNode>();
            storeNodes.Insert(0, OutermostTransparentNode(value, storeNodes: storeNodes));
            foreach (SyntaxNode node in storeNodes)
            {
                (ISymbol store, ITypeSymbol slotType) = this.ResolveStoreAtNode(node, value);
                string kind = this.ClassifyGenericStoreSlot(value, store, slotType, out _, out _);
                if (kind != null && kind != "unknown-target")
                {
                    return (store, slotType);
                }
            }

            return (null, null);
        }

        private (ISymbol Store, ITypeSymbol SlotType) ResolveStoreAtNode(SyntaxNode node, ExpressionSyntax value)
        {
            switch (node.Parent)
            {
                case ArgumentSyntax argument when argument.Parent is BaseArgumentListSyntax:
                    return (this.GetArgumentParameter(argument), null);

                case InitializerExpressionSyntax initializer when initializer.IsKind(SyntaxKind.ArrayInitializerExpression):
                    return (this.ArrayTypeOfInitializer(initializer), null);

                case InitializerExpressionSyntax initializer
                    when initializer.IsKind(SyntaxKind.CollectionInitializerExpression)
                        || (initializer.IsKind(SyntaxKind.ComplexElementInitializerExpression)
                            && initializer.Parent.IsKind(SyntaxKind.CollectionInitializerExpression)):
                {
                    bool complex = initializer.IsKind(SyntaxKind.ComplexElementInitializerExpression);
                    ExpressionSyntax element = complex ? initializer : (ExpressionSyntax)node;
                    IMethodSymbol addMethod = this.context.SemanticModel
                        .GetCollectionInitializerSymbolInfo(element).Symbol as IMethodSymbol;
                    int index = complex ? initializer.Expressions.IndexOf((ExpressionSyntax)node) : 0;
                    return addMethod != null
                        && this.TryGetCollectionInitializerArgumentTarget(
                            (ExpressionSyntax)node,
                            index,
                            addMethod,
                            addMethod,
                            out ITypeSymbol targetType,
                            out IParameterSymbol parameter)
                        ? (parameter, targetType)
                        : (null, null);
                }

                case ExpressionElementSyntax { Parent: CollectionExpressionSyntax collection }:
                {
                    // The element (or Add) type CoerceCollectionElement bound
                    // this element to; never a guess from generic arity.
                    ITypeSymbol collectionType = this.context.GetTypeInfo(collection).ConvertedType;
                    this.state.CollectionElementSlots.TryGetValue(node, out ITypeSymbol elementType);
                    return (collectionType, elementType);
                }

                case AssignmentExpressionSyntax assignment
                    when assignment.Right == node:
                    return (
                        this.context.GetSymbolInfo(assignment.Left).Symbol
                            ?? (assignment.Left is ElementAccessExpressionSyntax elementAccess
                                ? this.context.GetTypeInfo(elementAccess.Expression).Type as IArrayTypeSymbol
                                : null),
                        null);

                case YieldStatementSyntax yielded:
                {
                    IMethodSymbol iterator = this.context.SemanticModel.GetEnclosingSymbol(yielded.SpanStart) as IMethodSymbol;
                    return (iterator, iterator == null ? null : this.GetIteratorStoreSlot(value, iterator));
                }

                case AnonymousFunctionExpressionSyntax lambda when lambda.Body == node:
                    return ((this.context.GetTypeInfo(lambda).ConvertedType as INamedTypeSymbol)?.DelegateInvokeMethod, null);

                default:
                    return (this.ResolveValueSink((ExpressionSyntax)node), null);
            }
        }

        /// <summary>
        /// Classifies a bridged store target. Returns <see langword="null"/> when
        /// the slot is declared with a concrete type, and a kind otherwise.
        /// </summary>
        private string ClassifyGenericStoreSlot(
            ExpressionSyntax value,
            ISymbol targetSymbol,
            ITypeSymbol knownSlotType,
            out ITypeSymbol slotType,
            out bool resultDependsOnSlot)
        {
            slotType = null;
            resultDependsOnSlot = false;
            switch (targetSymbol)
            {
                case null:
                    return "unknown-target";

                case IParameterSymbol parameter:
                {
                    // A parameter variable is not a call-site parameter slot.
                    // Resolve the final slot first: an assignment result can
                    // still feed a genuine argument, even to this same method.
                    var parameterStores = new List<SyntaxNode>();
                    SyntaxNode finalValue = OutermostTransparentNode(value, storeNodes: parameterStores);
                    bool parameterIsFinalStore = SymbolEqualityComparer.Default.Equals(
                        this.ResolveStoreAtNode(finalValue, value).Store,
                        parameter);
                    if ((parameterIsFinalStore && finalValue.Parent is AssignmentExpressionSyntax)
                        || (!parameterIsFinalStore
                            && parameterStores.Any(node => SymbolEqualityComparer.Default.Equals(
                                this.ResolveStoreAtNode(node, value).Store,
                                parameter))))
                    {
                        slotType = parameter.Type;
                        return slotType is ITypeParameterSymbol
                            ? "type-parameter-assignment"
                            : this.ClassifyTupleStoreSlot(value, parameter, out slotType, out resultDependsOnSlot);
                    }

                    // Fail-safe: a params value is an element unless it is
                    // provably the direct, non-expanded argument (an explicit
                    // argument operation of its own, as TranslateArgumentValue
                    // tests). A collection-initializer element or a value nested
                    // in a tuple or conditional is therefore classified by the
                    // element slot rather than dropped.
                    bool directArgument = (EnclosingInvocationArgument(value) is { } argument
                        && this.context.SemanticModel.GetOperation(argument) is IArgumentOperation operation
                        && operation.ArgumentKind == ArgumentKind.Explicit)
                        || (knownSlotType != null
                            && SymbolEqualityComparer.Default.Equals(knownSlotType, parameter.Type));
                    bool expandedParams = parameter.IsParams && !directArgument;
                    return ClassifyParameterSlot(parameter, value, expandedParams, out slotType, out resultDependsOnSlot)
                        ?? this.ClassifyTupleStoreSlot(value, parameter, out slotType, out resultDependsOnSlot, parameterArgument: true);
                }

                case IPropertySymbol property when property.OriginalDefinition.Type is ITypeParameterSymbol:
                    slotType = GetBridgedSlotType(value, property.Type);
                    return "constructed-generic-member";

                case IFieldSymbol field when field.OriginalDefinition.Type is ITypeParameterSymbol:
                    slotType = GetBridgedSlotType(value, field.Type);
                    return "constructed-generic-member";

                case IMethodSymbol invoke when invoke.MethodKind == MethodKind.DelegateInvoke:
                {
                    // An expression-bodied lambda's result: unwrap Task<T> when
                    // the lambda is async, as the bridge guards the inner value.
                    bool asyncLambda = OutermostTransparentNode(value).Parent is AnonymousFunctionExpressionSyntax function
                        && function.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword);
                    return DelegateResultSlot(invoke, asyncLambda, value, out slotType)
                        ?? this.ClassifyTupleStoreSlot(value, invoke, out slotType, out resultDependsOnSlot);
                }

                case ILocalSymbol local when local.Type is ITypeParameterSymbol:
                    // A local declared as an in-scope type parameter (`T copy`).
                    slotType = local.Type;
                    return "type-parameter-local";

                case IMethodSymbol iterator when OutermostTransparentNode(value).Parent is YieldStatementSyntax yielded:
                    slotType = knownSlotType ?? this.GetIteratorStoreSlot(value, iterator);
                    return "iterator-element";

                case IMethodSymbol returning
                    when returning.MethodKind != MethodKind.AnonymousFunction
                        && returning.MethodKind != MethodKind.DelegateInvoke
                        && GetEffectiveReturnType(returning.ReturnType, returning.IsAsync) is ITypeParameterSymbol:
                    // A method's result declared as a type parameter (`return
                    // maybe;` in `T M<T>(...)`, or the `T` of an async Task<T>).
                    slotType = GetEffectiveReturnType(returning.ReturnType, returning.IsAsync);
                    return "type-parameter-return";

                case IArrayTypeSymbol array:
                    // An array element: the CLR's built-in generic storage.
                    // C# stores a null there as readily as in List<T> (#4628:
                    // `new[] { p.GetMethod, p.SetMethod }.OfType<MethodInfo>()`).
                    slotType = GetBridgedSlotType(value, array.ElementType);
                    return "array-element";

                case INamedTypeSymbol:
                    // A collection-expression element: the element (or Add)
                    // type the collection-expression translation resolved,
                    // never a guess from the collection's generic arity.
                    if (knownSlotType == null)
                    {
                        return "unknown-target";
                    }

                    slotType = GetBridgedSlotType(value, knownSlotType);
                    return "collection-expression-element";

                case IMethodSymbol lambda when lambda.MethodKind == MethodKind.AnonymousFunction:
                {
                    // A lambda's result is stored into its delegate's return
                    // slot (`Func<T, TResult>`'s TResult).
                    SyntaxNode lambdaSyntax = lambda.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
                    IMethodSymbol delegateInvoke = lambdaSyntax == null
                        ? null
                        : (this.context.GetTypeInfo(lambdaSyntax).ConvertedType as INamedTypeSymbol)?.DelegateInvokeMethod;
                    if (delegateInvoke == null)
                    {
                        return "unknown-target";
                    }

                    return DelegateResultSlot(delegateInvoke, lambda.IsAsync, value, out slotType)
                        ?? this.ClassifyTupleStoreSlot(value, delegateInvoke, out slotType, out resultDependsOnSlot, isAsync: lambda.IsAsync);
                }

                default:
                    return this.ClassifyTupleStoreSlot(value, targetSymbol, out slotType, out resultDependsOnSlot);
            }
        }

        private string ClassifyTupleStoreSlot(
            ExpressionSyntax value,
            ISymbol targetSymbol,
            out ITypeSymbol slotType,
            out bool resultDependsOnSlot,
            bool parameterArgument = false,
            bool isAsync = false)
        {
            slotType = null;
            resultDependsOnSlot = false;
            var tupleIndices = new List<int>();
            SyntaxNode node = OutermostTransparentNode(value, tupleIndices);
            if (tupleIndices.Count == 0)
            {
                return null;
            }

            bool asyncLambda = isAsync
                || (node.Parent is AnonymousFunctionExpressionSyntax function
                    && function.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword));
            ITypeSymbol declared = GetTupleSlot(GetStoreType(targetSymbol?.OriginalDefinition, asyncLambda), tupleIndices);
            if (declared is not ITypeParameterSymbol typeParameter)
            {
                return null;
            }

            slotType = GetTupleSlot(GetStoreType(targetSymbol, asyncLambda), tupleIndices);
            resultDependsOnSlot = parameterArgument
                && targetSymbol is IParameterSymbol { ContainingSymbol: IMethodSymbol method }
                && MentionsTypeParameter(method.OriginalDefinition.ReturnType, typeParameter);
            return slotType == null ? null : "type-parameter-tuple-element";

            static ITypeSymbol GetStoreType(ISymbol symbol, bool asyncLambda) => symbol switch
            {
                IFieldSymbol field => field.Type,
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                IPropertySymbol property => property.Type,
                IMethodSymbol method => GetEffectiveReturnType(method.ReturnType, method.IsAsync || asyncLambda),
                _ => null,
            };
        }

        // Whether the call that receives `value` as an argument spells its type
        // arguments (`Identity<SyntaxNode>(x)`), as opposed to inferring them.
        // A value nested in transparent containers (parentheses, a C# `!`, a
        // conditional or switch arm, a tuple element) counts as the enclosing
        // invocation argument, as the store bridges resolve it.
        private static bool ValueFeedsExplicitTypeArguments(ExpressionSyntax value) =>
            EnclosingInvocationArgument(value) is { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax invocation } }
            && HasExplicitTypeArguments(invocation.Expression);

        /// <summary>
        /// The array an initializer element is stored into. A rectangular
        /// array's rows are nested initializers with no type of their own, so
        /// this climbs to the outermost initializer first, then reads its
        /// converted type (a bare <c>string[] xs = { ... }</c>) or the creation
        /// expression's type (<c>new T[,,] { ... }</c>).
        /// </summary>
        /// <param name="initializer">An array initializer at any nesting depth.</param>
        /// <returns>The array type, or <see langword="null"/> when it cannot be resolved.</returns>
        private IArrayTypeSymbol ArrayTypeOfInitializer(InitializerExpressionSyntax initializer)
        {
            InitializerExpressionSyntax outermost = initializer;
            while (outermost.Parent is InitializerExpressionSyntax parent
                && parent.IsKind(SyntaxKind.ArrayInitializerExpression))
            {
                outermost = parent;
            }

            return this.context.GetTypeInfo(outermost).ConvertedType as IArrayTypeSymbol
                ?? this.context.GetTypeInfo(outermost.Parent).Type as IArrayTypeSymbol;
        }

        private static ArgumentSyntax EnclosingInvocationArgument(ExpressionSyntax value) =>
            OutermostTransparentNode(value).Parent is ArgumentSyntax { Parent: BaseArgumentListSyntax } argument
                ? argument
                : null;

        // The single definition of "transparent" for the store bridges: the
        // stored value seen through parentheses, casts, checked wrappers, a C#
        // `!`, null-preserving operators, conditional/switch arms, and tuple
        // elements. Every classification that needs
        // the enclosing store or argument starts here.
        private static SyntaxNode OutermostTransparentNode(
            ExpressionSyntax value,
            List<int> tupleIndices = null,
            List<SyntaxNode> storeNodes = null)
        {
            SyntaxNode node = value;
            while (true)
            {
                SyntaxNode parent = node.Parent;
                switch (parent)
                {
                    case ParenthesizedExpressionSyntax:
                    case CastExpressionSyntax:
                    case CheckedExpressionSyntax:
                    case ConditionalAccessExpressionSyntax:
                    case PostfixUnaryExpressionSyntax forgiving
                        when forgiving.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                        node = parent;
                        break;
                    case BinaryExpressionSyntax binary
                        when binary.IsKind(SyntaxKind.CoalesceExpression)
                            || (binary.IsKind(SyntaxKind.AsExpression) && binary.Left == node):
                        node = parent;
                        break;
                    case AssignmentExpressionSyntax assignment
                        when assignment.Right == node
                            && (assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                                || assignment.IsKind(SyntaxKind.CoalesceAssignmentExpression)):
                        storeNodes?.Add(node);
                        node = parent;
                        break;
                    case ConditionalExpressionSyntax conditional when conditional.Condition != node:
                        node = parent;
                        break;
                    case SwitchExpressionArmSyntax arm when arm.Expression == node:
                        node = arm.Parent;
                        break;
                    case ArgumentSyntax tupleElement when tupleElement.Parent is TupleExpressionSyntax tuple:
                        tupleIndices?.Add(tuple.Arguments.IndexOf(tupleElement));
                        node = tuple;
                        break;
                    default:
                        return node;
                }
            }
        }

        private ITypeSymbol GetIteratorStoreSlot(ExpressionSyntax value, IMethodSymbol iterator)
        {
            var tupleIndices = new List<int>();
            SyntaxNode node = OutermostTransparentNode(value, tupleIndices);
            if (node.Parent is not YieldStatementSyntax yielded)
            {
                return null;
            }

            // A bound generic iterator returns one of the enumerable/enumerator
            // envelopes. Unwrap its declared element contract before following
            // the tuple path; the forgiven operand may have a different type.
            ITypeSymbol slotType = iterator.ReturnType is INamedTypeSymbol returnType
                && returnType.TypeArguments.Length == 1
                    ? returnType.TypeArguments[0]
                    : this.context.GetTypeInfo(yielded.Expression).ConvertedType;
            return GetTupleSlot(slotType, tupleIndices);
        }

        private static ITypeSymbol GetTupleSlot(ITypeSymbol slotType, List<int> tupleIndices)
        {
            for (int i = tupleIndices.Count - 1; i >= 0; i--)
            {
                if (slotType is not INamedTypeSymbol { IsTupleType: true } tupleType)
                {
                    return slotType;
                }

                if (tupleIndices[i] >= tupleType.TupleElements.Length)
                {
                    return null;
                }

                slotType = GetEffectiveTupleElementType(tupleType, tupleIndices[i]);
            }

            return slotType;
        }

        private static ITypeSymbol GetBridgedSlotType(ExpressionSyntax value, ITypeSymbol slotType)
        {
            if (value == null || slotType is not INamedTypeSymbol { IsTupleType: true })
            {
                return slotType;
            }

            var tupleIndices = new List<int>();
            OutermostTransparentNode(value, tupleIndices);
            return GetTupleSlot(slotType, tupleIndices);
        }

        // A lambda result stored into its delegate's return slot. An async
        // lambda's `!!` guards the value inside the task, so both the declared
        // and the constructed return types are unwrapped (GetEffectiveReturnType).
        private static string DelegateResultSlot(
            IMethodSymbol delegateInvoke,
            bool isAsync,
            ExpressionSyntax value,
            out ITypeSymbol slotType)
        {
            ITypeSymbol declared = delegateInvoke.OriginalDefinition.ReturnType;
            slotType = GetBridgedSlotType(value, GetEffectiveReturnType(delegateInvoke.ReturnType, isAsync));
            return declared is ITypeParameterSymbol
                || GetEffectiveReturnType(declared, isAsync) is ITypeParameterSymbol
                    ? "delegate-result"
                    : null;
        }

        private static bool MentionsTypeParameter(ITypeSymbol type, ITypeParameterSymbol typeParameter)
        {
            if (type == null)
            {
                return false;
            }

            if (SymbolEqualityComparer.Default.Equals(type, typeParameter))
            {
                return true;
            }

            if (type is IArrayTypeSymbol array)
            {
                return MentionsTypeParameter(array.ElementType, typeParameter);
            }

            if (type is IPointerTypeSymbol pointer)
            {
                return MentionsTypeParameter(pointer.PointedAtType, typeParameter);
            }

            if (type is IFunctionPointerTypeSymbol functionPointer)
            {
                return MentionsTypeParameter(functionPointer.Signature.ReturnType, typeParameter)
                    || functionPointer.Signature.Parameters.Any(parameter => MentionsTypeParameter(parameter.Type, typeParameter));
            }

            // A nested type carries its containing types' type parameters
            // (`Box<T>.Result`).
            return type is INamedTypeSymbol named
                && (named.TypeArguments.Any(argument => MentionsTypeParameter(argument, typeParameter))
                    || MentionsTypeParameter(named.ContainingType, typeParameter));
        }
    }
}
