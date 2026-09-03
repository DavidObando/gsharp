// <copyright file="CSharpToGSharpTranslator.Nullability.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        private HashSet<string> repositorySharedDocumentPaths;

        // Issue #1072: G# follows Kotlin-style nullability, so `nil`-safety is
        // enforced by the static type, not by a `!!`-on-`nil` escape hatch. A C#
        // symbol DECLARED non-nullable (`T`) but defensively compared against
        // `null` (`== null` / `!= null`) or assigned `null` / `null!` is, in
        // truth, nullable: faithfully it must render `T?` so the `== nil`/`!= nil`
        // guard type-checks (gsc only permits `== nil` on a nullable operand,
        // otherwise GS0129). Returns true when <paramref name="symbol"/> is used
        // that way anywhere in <paramref name="scope"/>.
        private bool IsUsedAsNullable(ISymbol symbol, SyntaxNode scope)
        {
            if (symbol == null || scope == null)
            {
                return false;
            }

            var key = (symbol, scope);
            if (this.state.UsedAsNullableCache.TryGetValue(key, out bool cached))
            {
                return cached;
            }

            bool result = this.ComputeIsUsedAsNullable(symbol, scope);
            this.state.UsedAsNullableCache[key] = result;
            return result;
        }

        private bool ComputeIsUsedAsNullable(ISymbol symbol, SyntaxNode scope)
        {
            // A source-backed ProjectReference can expose declaration syntax
            // owned by the referenced project's separate compilation. Its
            // whole-program taint result was already checked by the caller;
            // this local syntax scan is valid only for this compilation.
            if (!this.context.Compilation.ContainsSyntaxTree(scope.SyntaxTree))
            {
                return false;
            }

            if (scope.SyntaxTree != this.context.SemanticModel.SyntaxTree)
            {
                using IDisposable modelScope = this.context.UseSemanticModelFor(scope.SyntaxTree);
                return this.ComputeIsUsedAsNullable(symbol, scope);
            }

            foreach (SyntaxNode node in scope.DescendantNodes())
            {
                switch (node)
                {
                    case BinaryExpressionSyntax binary
                        when binary.IsKind(SyntaxKind.EqualsExpression)
                            || binary.IsKind(SyntaxKind.NotEqualsExpression):
                        if ((IsNullLiteral(binary.Right) && this.BindsTo(binary.Left, symbol))
                            || (IsNullLiteral(binary.Left) && this.BindsTo(binary.Right, symbol)))
                        {
                            return true;
                        }

                        break;

                    case AssignmentExpressionSyntax assignment
                        when assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                            && this.BindsTo(assignment.Left, symbol)
                            && IsNullOrSuppressedNull(assignment.Right):
                        return true;

                    // Issue #1907: `x ??= y` only assigns when `x` is currently
                    // null — `x` being a legal `??=` target proves it is used as
                    // nullable regardless of what `y` is (unlike plain `x = y`,
                    // where only a literal `null`/`null!` RHS proves it).
                    case AssignmentExpressionSyntax coalesceAssignment
                        when coalesceAssignment.IsKind(SyntaxKind.CoalesceAssignmentExpression)
                            && this.BindsTo(coalesceAssignment.Left, symbol):
                        return true;

                    case IsPatternExpressionSyntax isPattern
                        when this.BindsTo(isPattern.Expression, symbol)
                            && IsNullConstantPattern(isPattern.Pattern):
                        return true;

                    case VariableDeclaratorSyntax declarator
                        when declarator.Initializer != null
                            && IsNullOrSuppressedNull(declarator.Initializer.Value)
                            && SymbolEqualityComparer.Default.Equals(
                                this.context.GetDeclaredSymbol(declarator), symbol):
                        return true;
                }
            }

            return false;
        }

        // Promotes <paramref name="type"/> to its nullable (`T?`) form when the
        // symbol it renders is declared as a non-nullable reference/array type yet
        // is used as nullable in its scope (issue #1072). Value types and
        // already-nullable types are left untouched: this pass only covers
        // reference-type/array null-comparison and null-assignment.
        // True for a `T?`-annotated reference type, array, or (interface/
        // unconstrained) type parameter — the forms whose `?` the G# type mapper
        // preserves and which inference over a non-null initializer would drop.
        private static bool IsAnnotatedNullableReference(ITypeSymbol type) =>
            type is { NullableAnnotation: NullableAnnotation.Annotated }
                && (type.IsReferenceType || type is ITypeParameterSymbol);

        // Issue #3855: true when <paramref name="parameter"/> is a lambda
        // parameter whose rendered type ANNOTATION is an input to the enclosing
        // call's type-argument inference, so promoting it (#1072) would widen an
        // inferred type ARGUMENT rather than merely describe this one position.
        //
        // The distinction that matters is whether the target type is FIXED:
        //
        //   * fixed target (`Action<string> a = s => { if (s == null) … };`, a
        //     non-generic callee, or a generic callee with EXPLICIT type
        //     arguments) — the annotation only has to be COMPATIBLE with the
        //     target, and widening an input position is contravariance, so a
        //     `(string?) -> R` literal still converts to a `(string) -> R`
        //     target. The promotion is a faithful, local statement about what
        //     this body does with the value, and nothing else observes it.
        //
        //   * inferred target (`xs.Where(d => d != null)`) — the annotation is
        //     not checked against a target, it CHOOSES one. gsc infers
        //     `TSource := T?` from `(d T?) -> …`, so the element type of the
        //     whole chain widens and every downstream member access runs on a
        //     nullable receiver (GS0158 / GS0154). That consequence was never
        //     what #1072 intended.
        //
        // Suppressing the promotion here does not cost the `== nil` guard the
        // promotion existed to make legal: gsc admits `x == nil` / `x != nil`
        // on a bare reference class (BoundBinaryOperator's imported-class and
        // `StructSymbol { IsClass: true }` arms), so `(d T) -> d != nil` binds.
        private bool LambdaParameterAnnotationFeedsTypeInference(ParameterSyntax parameter)
        {
            if (parameter.FirstAncestorOrSelf<AnonymousFunctionExpressionSyntax>()
                is not { } lambda)
            {
                return false;
            }

            // Only a lambda handed DIRECTLY to a call has its parameter type
            // dictated by that call. Anywhere else (a local's initializer, a
            // return, a collection element) the target type is already fixed.
            SyntaxNode node = lambda;
            while (node.Parent is ParenthesizedExpressionSyntax or CastExpressionSyntax)
            {
                node = node.Parent;
            }

            if (node.Parent is not ArgumentSyntax argument
                || argument.Parent?.Parent is not InvocationExpressionSyntax invocation)
            {
                return false;
            }

            if (this.context.GetSymbolInfo(invocation).Symbol
                is not IMethodSymbol { IsGenericMethod: true })
            {
                return false;
            }

            // Explicit type arguments (`xs.Where<Node>(d => …)`) fix the target
            // before the lambda is ever looked at — nothing is inferred.
            if (HasExplicitTypeArguments(invocation.Expression))
            {
                return false;
            }

            ITypeSymbol parameterType =
                (this.context.SemanticModel.GetOperation(argument) as IArgumentOperation)
                    ?.Parameter?.OriginalDefinition.Type;
            if (parameterType == null)
            {
                // The callee could not be resolved to a parameter position. The
                // call IS generic and its type arguments ARE inferred, so the
                // annotation cannot be shown to be inert; suppress.
                return true;
            }

            int index = LambdaParameterIndex(lambda, parameter);
            ITypeSymbol arrowPosition = DelegateParameterTypeAt(parameterType, index);

            // Fall back to the whole delegate type when the arrow position
            // cannot be isolated: a type-parameter-free delegate parameter
            // (`Func<string, T>`'s input) proves the annotation is inert.
            return MentionsMethodTypeParameter(arrowPosition ?? parameterType);
        }

        private static bool HasExplicitTypeArguments(ExpressionSyntax callee) => callee switch
        {
            GenericNameSyntax => true,
            MemberAccessExpressionSyntax member => HasExplicitTypeArguments(member.Name),
            MemberBindingExpressionSyntax binding => HasExplicitTypeArguments(binding.Name),
            _ => false,
        };

        private static int LambdaParameterIndex(
            AnonymousFunctionExpressionSyntax lambda,
            ParameterSyntax parameter)
        {
            SeparatedSyntaxList<ParameterSyntax>? list = lambda switch
            {
                ParenthesizedLambdaExpressionSyntax paren => paren.ParameterList?.Parameters,
                AnonymousMethodExpressionSyntax anonymous => anonymous.ParameterList?.Parameters,
                _ => null,
            };

            return list?.IndexOf(parameter) ?? 0;
        }

        // The <paramref name="index"/>th arrow-parameter type of a delegate-typed
        // (or `Expression<TDelegate>`-typed) callee parameter, or null when the
        // shape is not a delegate at all.
        private static ITypeSymbol DelegateParameterTypeAt(ITypeSymbol parameterType, int index)
        {
            if (parameterType is INamedTypeSymbol { Name: "Expression", TypeArguments.Length: 1, DelegateInvokeMethod: null } expression)
            {
                parameterType = expression.TypeArguments[0];
            }

            return parameterType is INamedTypeSymbol { DelegateInvokeMethod: { } invoke }
                && index >= 0
                && index < invoke.Parameters.Length
                ? invoke.Parameters[index].Type
                : null;
        }

        // True when <paramref name="type"/> mentions a METHOD type parameter
        // anywhere — i.e. one the enclosing call has to infer. A CLASS type
        // parameter is already fixed by the receiver and is not an inference
        // input here.
        private static bool MentionsMethodTypeParameter(ITypeSymbol type) => type switch
        {
            ITypeParameterSymbol { TypeParameterKind: TypeParameterKind.Method } => true,
            IArrayTypeSymbol array => MentionsMethodTypeParameter(array.ElementType),
            IPointerTypeSymbol pointer => MentionsMethodTypeParameter(pointer.PointedAtType),
            INamedTypeSymbol named => named.TypeArguments.Any(MentionsMethodTypeParameter),
            _ => false,
        };

        private GTypeReference PromoteIfUsedAsNullable(GTypeReference type, ISymbol symbol)
        {
            if (type == null)
            {
                return type;
            }

            ITypeSymbol declaredType = symbol switch
            {
                IPropertySymbol property => property.Type,
                IFieldSymbol field => field.Type,
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                _ => null,
            };
            type = this.PromoteTupleDeclarationIfTainted(type, declaredType, symbol);
            if (type.IsNullable)
            {
                return type;
            }

            return this.ShouldPromoteToNullableReference(symbol) ? MakeNullable(type) : type;
        }

        // Issue #2113/#914: method/local-function returns are just another
        // symbol-position declaration sink, so their promote/not-promote answer
        // must come from the shared decision table.
        private GTypeReference PromoteReturnIfTainted(GTypeReference type, IMethodSymbol symbol)
        {
            if (type == null || type.IsNullable || symbol == null)
            {
                return type;
            }

            return this.ShouldPromoteToNullableReference(symbol)
                ? MakeNullable(type)
                : type;
        }

        // Issue #2421: mirrors PromoteReturnIfTainted's decision for an `async
        // Task<T>` method/lambda/local function, keyed off the UNWRAPPED
        // awaited type T rather than `symbol.ReturnType` (which for such a
        // member is the `Task<T>` ENVELOPE — always a reference type regardless
        // of whether T is a value or reference type). Calling
        // ShouldPromoteToNullableReference directly would use that envelope for
        // its `declared.IsReferenceType` guard, incorrectly bypassing the
        // guard's protection for a value-typed T (e.g. `Task<int>`, whose
        // awaited result must never become `int?`/`Nullable<int>` through this
        // reference-only promotion). The taint MEMBERSHIP check itself is
        // unchanged: it is the same whole-program symbol-keyed decision
        // (`ObliviousNullabilityAnalyzer.IsTainted`) the synchronous path
        // reaches via ShouldPromoteToNullableReference, since
        // SeedMethodLikeReturnTaint already seeds/propagates taint on the
        // method symbol uniformly regardless of its `Task<T>` envelope — only
        // the CONSUMPTION side (this declaration's own rendered return type)
        // was previously never asked the question at all for an async member.
        private GTypeReference PromoteAwaitedReturnIfTainted(
            GTypeReference type,
            ITypeSymbol awaitedType,
            IMethodSymbol symbol)
        {
            if (type == null || type.IsNullable || symbol == null)
            {
                return type;
            }

            if (awaitedType is not { IsReferenceType: true }
                || awaitedType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return type;
            }

            return ObliviousNullabilityAnalyzer.IsTainted(
                this.context.Compilation, symbol, this.context.SiblingCompilations)
                ? MakeNullable(type)
                : type;
        }

        // Issue #2423: mirrors PromoteAwaitedReturnIfTainted's decision for a
        // NON-async `Task<T>`/`ValueTask<T>`-returning declaration (a C#
        // interface member — interfaces cannot declare `async` members — or a
        // synchronous method that literally returns the envelope). Unlike the
        // async path, there is no `async` keyword here to imply the envelope,
        // so the literal `Task[T]`/`ValueTask[T]` reference from `envelope`
        // must be PRESERVED and only its type ARGUMENT promoted — otherwise an
        // interface declaration and its `async` implementation, once synced by
        // CollectInterfaceMethodEdges, would promote to two structurally
        // different shapes (`Task[T]?` outer-nullable vs `Task[T?]`
        // inner-nullable) that still fail interface-conformance (GS0187).
        private GTypeReference PromoteTaskEnvelopeReturnIfTainted(
            GTypeReference envelope,
            ITypeSymbol awaitedType,
            IMethodSymbol symbol)
        {
            if (envelope is not NamedTypeReference { TypeArguments.Count: 1 } named || named.IsNullable)
            {
                return envelope;
            }

            GTypeReference promotedInner = this.PromoteTupleDeclarationIfTainted(
                named.TypeArguments[0], awaitedType, symbol);
            promotedInner = this.PromoteAwaitedReturnIfTainted(
                promotedInner, awaitedType, symbol);

            return ReferenceEquals(promotedInner, named.TypeArguments[0])
                ? envelope
                : new NamedTypeReference(named.Name, new[] { promotedInner });
        }

        // Issue #2469/#2490: tuple leaves are independent declaration sinks.
        // Their evidence lives in ObliviousNullabilityAnalyzer's element-path
        // graph so tuple returns, parameters, locals, fields/properties, nested
        // tuples, async envelopes, and contracts all converge on the same
        // per-position answer.
        private GTypeReference PromoteTupleDeclarationIfTainted(
            GTypeReference mapped,
            ITypeSymbol returnType,
            ISymbol symbol)
        {
            if (!this.IsObliviousCompilation())
            {
                return mapped;
            }

            return this.PromoteTupleTypeArguments(mapped, returnType, symbol, new List<int>());
        }

        // Issue #3641: `var prepared = new List<(string, byte[])>()` renders the
        // CREATED type, not the local's declared type, so promoting only the
        // declaration would leave the initializer's `List[(string, []uint8)]`
        // unconvertible to the promoted `List[(string, []?uint8)]`. G# tuple
        // types agree structurally: the construction that feeds a promoted sink
        // has to be spelled with the same elements. The sink's own element paths
        // are reused directly — the mapper walks the CREATED type's arguments,
        // which coincide with the sink's for the covariant collection hand-offs
        // this shape uses (`List<T>` stored as `IReadOnlyList<T>`) and simply ask
        // an untainted key otherwise.
        private GTypeReference PromoteCreationTupleArguments(
            GTypeReference type,
            ITypeSymbol typeSymbol,
            BaseObjectCreationExpressionSyntax creation)
        {
            if (type == null || typeSymbol == null || !this.IsObliviousCompilation())
            {
                return type;
            }

            ISymbol sink = this.ResolveValueSink(creation);
            return sink == null
                ? type
                : this.PromoteTupleTypeArguments(type, typeSymbol, sink, new List<int>());
        }

        // The declaration a freshly built value flows into: the local/field being
        // initialized, the assignment target, the invoked parameter, or the
        // enclosing member whose return it is. Mirrors the sinks the analyzer's
        // tuple-flow collectors record edges for, so both sides agree on which
        // declaration owns the element key.
        private ISymbol ResolveValueSink(ExpressionSyntax value)
        {
            SyntaxNode node = value;
            while (node.Parent is ParenthesizedExpressionSyntax or CastExpressionSyntax)
            {
                node = node.Parent;
            }

            switch (node.Parent)
            {
                case EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax declarator }:
                    return this.context.GetDeclaredSymbol(declarator);

                case AssignmentExpressionSyntax assignment
                    when assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                        && assignment.Right == node:
                    return this.context.GetSymbolInfo(assignment.Left).Symbol;

                case ArgumentSyntax argument:
                    return (this.context.SemanticModel.GetOperation(argument) as IArgumentOperation)
                        ?.Parameter;

                case ReturnStatementSyntax returnStatement:
                    return this.context.SemanticModel
                        .GetEnclosingSymbol(returnStatement.SpanStart) as IMethodSymbol;

                case ArrowExpressionClauseSyntax arrow:
                    return this.context.SemanticModel.GetDeclaredSymbol(arrow.Parent);

                default:
                    return null;
            }
        }

        private GTypeReference PromoteTupleTypeArguments(
            GTypeReference mapped,
            ITypeSymbol declaredType,
            ISymbol symbol,
            List<int> path)
        {
            if (mapped is TupleTypeReference tuple
                && declaredType is INamedTypeSymbol { IsTupleType: true } tupleType
                && tupleType.TupleElements.Length == tuple.ElementTypes.Count)
            {
                return this.PromoteTupleElements(tuple, tupleType, symbol, path);
            }

            if (mapped is not NamedTypeReference named
                || declaredType is not INamedTypeSymbol declaredNamed
                || named.TypeArguments.Count != declaredNamed.TypeArguments.Length)
            {
                return mapped;
            }

            var arguments = new List<GTypeReference>(named.TypeArguments.Count);
            bool changed = false;
            for (int i = 0; i < named.TypeArguments.Count; i++)
            {
                path.Add(i);
                GTypeReference argument = this.PromoteTupleTypeArguments(
                    named.TypeArguments[i],
                    declaredNamed.TypeArguments[i],
                    symbol,
                    path);
                path.RemoveAt(path.Count - 1);
                changed |= !ReferenceEquals(argument, named.TypeArguments[i]);
                arguments.Add(argument);
            }

            return changed
                ? new NamedTypeReference(named.Name, arguments, named.ContainingType)
                    { IsNullable = named.IsNullable }
                : mapped;
        }

        private GTypeReference PromoteTupleElements(
            TupleTypeReference tuple,
            INamedTypeSymbol tupleType,
            ISymbol symbol,
            List<int> path)
        {
            var elements = new List<GTypeReference>(tuple.ElementTypes.Count);
            bool changed = false;
            for (int i = 0; i < tuple.ElementTypes.Count; i++)
            {
                GTypeReference element = tuple.ElementTypes[i];
                IFieldSymbol elementField = tupleType.TupleElements[i];
                path.Add(i);
                if (element is TupleTypeReference nestedMapped
                    && elementField.Type is INamedTypeSymbol { IsTupleType: true } nestedType)
                {
                    GTypeReference promotedNested = this.PromoteTupleElements(
                        nestedMapped,
                        nestedType,
                        symbol,
                        path);
                    changed |= !ReferenceEquals(promotedNested, element);
                    element = promotedNested;
                }
                else if (!element.IsNullable
                    && elementField.Type is { IsReferenceType: true }
                    && elementField.Type.NullableAnnotation != NullableAnnotation.Annotated
                    && ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                        this.context.Compilation,
                        symbol,
                        path,
                        this.context.SiblingCompilations))
                {
                    element = MakeNullable(element);
                    changed = true;
                }

                path.RemoveAt(path.Count - 1);
                elements.Add(element);
            }

            return changed
                ? new TupleTypeReference(elements, tuple.ElementNames) { IsNullable = tuple.IsNullable }
                : tuple;
        }

        // Issue #914: whether <paramref name="expression"/> yields a
        // promoted-nullable value in an oblivious compilation — either a
        // syntactically nullable form (`?.` / `??` / ternary, via
        // <see cref="IsNullableInitializer"/>, which also consults declared BCL
        // annotations) OR a field / property / local / parameter the whole-program
        // taint analysis promoted to `T?`, OR a method / local function whose
        // return the analysis proved null-tainted.
        private bool IsNullablePromotedValue(ExpressionSyntax expression)
        {
            if (expression == null)
            {
                return false;
            }

            // Issue #2496: an anonymous function or method group is a callable
            // value, not the value returned when that callable is invoked.
            // Roslyn binds a lambda to a synthesized IMethodSymbol, so asking the
            // oblivious-nullability fixpoint about that symbol can otherwise
            // mistake return-position taint for nullability of the delegate /
            // Expression<TDelegate> object itself. Keep callable-value
            // nullability separate; lambda result contracts are handled at the
            // lambda body seam instead.
            if (this.IsCallableValueExpression(expression))
            {
                return false;
            }

            if (this.IsNullableInitializer(expression))
            {
                return true;
            }

            if (ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                this.context.Compilation,
                expression,
                this.context.SemanticModel,
                this.context.SiblingCompilations))
            {
                return true;
            }

            // Issue #3663: a DECONSTRUCTING `foreach` variable aliases a tuple
            // leaf without ever naming it, and G#'s `for (a, b) in items` infers
            // each name from the sequence's element tuple. When #3641's
            // nested-tuple promotion renders that element `T?`, the variable IS
            // a nullable value even though its own declaration symbol carries no
            // taint of its own — bridge its reads like any other promoted value.
            if (ObliviousNullabilityAnalyzer.IsDeconstructedForEachElementTainted(
                this.context.Compilation,
                expression,
                this.context.SemanticModel,
                this.context.SiblingCompilations))
            {
                return true;
            }

            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            if (symbol is ILocalSymbol local
                && !this.ShouldPromoteToNullableReference(local)
                && local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                    is VariableDeclaratorSyntax { Initializer.Value: { } localInitializer })
            {
                return this.IsNullablePromotedValue(localInitializer);
            }

            return symbol switch
            {
                IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol or IMethodSymbol =>
                    this.ShouldPromoteToNullableReference(symbol),
                _ => false,
            };
        }

        // Issue #3676: whether <paramref name="expression"/> reads a
        // generated-code declaration that direct null evidence promoted to
        // `T?` (see
        // <c>ObliviousNullabilityAnalyzer.IsGeneratedDeclarationAssignedNull</c>).
        // This is the nullable-ENABLED counterpart of
        // <see cref="IsNullablePromotedValue"/>, deliberately limited to the one
        // promotion this translator performs there — e.g. the LSP
        // `DocumentUri.FromFileSystemPath(...)` whose `return null` branch makes
        // its result `DocumentUri?`, flowing into a `Location{Uri: …}` slot that
        // no evidence widened.
        private bool IsGeneratedDeclarationPromotedValue(ExpressionSyntax expression)
        {
            if (expression == null || this.IsCallableValueExpression(expression))
            {
                return false;
            }

            return ObliviousNullabilityAnalyzer.IsGeneratedDeclarationAssignedNull(
                this.context.Compilation,
                this.context.GetSymbolInfo(expression).Symbol,
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations);
        }

        private bool IsCallableValueExpression(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax parenthesized)
            {
                expression = parenthesized.Expression;
            }

            return expression is AnonymousFunctionExpressionSyntax
                || this.context.SemanticModel.GetMemberGroup(expression).Length > 0;
        }

        // Issue #914 (oblivious sink): promote the arrow (delegate) parameter
        // positions of <paramref name="symbol"/>'s type to `T?` for every position
        // that receives a null / promoted-nullable argument at an invocation of the
        // parameter inside its own method. A delegate parameter carries no
        // nullability in oblivious metadata, so a call like `sendOrPost(o => …,
        // null)` is the only evidence that the delegate's second position is really
        // `object?`; without it the `nil -> object` argument is rejected (GS0155).
        // This stays separate because delegate arrow-parameter positions have no
        // declaration symbol to ask; the distinct signal is an invocation of the
        // delegate parameter with a null/promoted-nullable argument.
        private GTypeReference PromoteDelegateParameterInvokedWithNull(
            GTypeReference type,
            IParameterSymbol symbol)
        {
            if (!this.IsObliviousCompilation()
                || type is not ArrowTypeReference arrow
                || symbol.Type is not INamedTypeSymbol { TypeKind: TypeKind.Delegate } delegateType
                || delegateType.DelegateInvokeMethod is not { } invoke
                || invoke.Parameters.Length != arrow.ParameterTypes.Count)
            {
                return type;
            }

            SyntaxNode methodSyntax = symbol.ContainingSymbol?
                .DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
            if (methodSyntax == null)
            {
                return type;
            }

            var nullablePositions = new HashSet<int>();
            foreach (InvocationExpressionSyntax invocation in methodSyntax
                .DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (!SymbolEqualityComparer.Default.Equals(
                        this.context.GetSymbolInfo(invocation.Expression).Symbol, symbol))
                {
                    continue;
                }

                ArgumentListSyntax argumentList = invocation.ArgumentList;
                for (int i = 0; i < argumentList.Arguments.Count && i < arrow.ParameterTypes.Count; i++)
                {
                    ExpressionSyntax argument = argumentList.Arguments[i].Expression;
                    if (IsNullOrDefaultLiteral(argument) || this.IsNullablePromotedValue(argument))
                    {
                        nullablePositions.Add(i);
                    }
                }
            }

            string delegateMetadataName = GetMetadataTypeName(delegateType.OriginalDefinition);
            foreach (SyntaxTree tree in this.context.Compilation.SyntaxTrees)
            {
                SemanticModel model = this.context.Compilation.GetSemanticModel(tree);
                foreach (DelegateDeclarationSyntax declaration in tree.GetRoot()
                    .DescendantNodes().OfType<DelegateDeclarationSyntax>())
                {
                    if (model.GetDeclaredSymbol(declaration) is not INamedTypeSymbol declarationSymbol
                        || GetMetadataTypeName(declarationSymbol) != delegateMetadataName)
                    {
                        continue;
                    }

                    nullablePositions.Clear();
                    for (int i = 0; i < declaration.ParameterList.Parameters.Count; i++)
                    {
                        IParameterSymbol declaredParameter =
                            model.GetDeclaredSymbol(declaration.ParameterList.Parameters[i]);
                        if (declaredParameter == null)
                        {
                            continue;
                        }

                        if (declaredParameter.Type.NullableAnnotation == NullableAnnotation.Annotated
                            || ObliviousNullabilityAnalyzer.IsTainted(
                                    this.context.Compilation,
                                    declaredParameter,
                                    this.context.SiblingCompilations))
                        {
                            nullablePositions.Add(i);
                        }
                    }
                }
            }

            if (nullablePositions.Count == 0)
            {
                return type;
            }

            var parameterTypes = new List<GTypeReference>(arrow.ParameterTypes.Count);
            bool changed = false;
            for (int i = 0; i < arrow.ParameterTypes.Count; i++)
            {
                GTypeReference parameterType = arrow.ParameterTypes[i];
                ITypeSymbol invokeParameterType = invoke.Parameters[i].Type;
                if (nullablePositions.Contains(i)
                    && !parameterType.IsNullable
                    && invokeParameterType is { IsReferenceType: true }
                    && invokeParameterType.NullableAnnotation != NullableAnnotation.Annotated)
                {
                    parameterType = MakeNullable(parameterType);
                    changed = true;
                }

                parameterTypes.Add(parameterType);
            }

            return changed
                ? new ArrowTypeReference(parameterTypes, arrow.ReturnTypes, arrow.IsAsync) { IsNullable = arrow.IsNullable }
                : type;
        }

        private static string GetMetadataTypeName(INamedTypeSymbol type)
        {
            var parts = new List<string>();
            for (INamedTypeSymbol current = type; current != null; current = current.ContainingType)
            {
                parts.Insert(0, current.MetadataName);
            }

            string nested = string.Join("+", parts);
            return type.ContainingNamespace is { IsGlobalNamespace: false } ns
                ? ns.ToDisplayString() + "." + nested
                : nested;
        }

        // Issue #3682: the element type of an array / slice literal that
        // literally writes `null` (or `default`) into a NON-nullable reference
        // element. C# accepts the write — the literal sits in an oblivious file
        // (`test/Core.Tests` has no `<Nullable>` setting), or its element type
        // was inferred from an oblivious/unannotated target — but G#'s element
        // type is genuinely non-nullable and gsc rejects the `nil` (GS0155,
        // `Cannot convert type 'nil' to 'object'`).
        //
        // The right repair is the DECLARATION, not the value: the `nil` really
        // is nil, so `!!` would turn a clean C# `new object[] { a, null }` into
        // a runtime throw. A literal's element type is inferred AT the literal
        // rather than pinned by a declaration, so widening it to `T?` is both
        // faithful and local — the array genuinely holds a nil.
        //
        // Restricted to reference elements whose annotation is not already
        // `Annotated` (those already render `T?`); value-typed elements never
        // receive a `nil` in the first place.
        private GTypeReference PromoteElementTypeForNullElements(
            GTypeReference elementType,
            ITypeSymbol elementTypeSymbol,
            IEnumerable<ExpressionSyntax> elements)
        {
            if (elementType == null
                || elementType.IsNullable
                || elementTypeSymbol is not { IsReferenceType: true }
                || elementTypeSymbol.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return elementType;
            }

            foreach (ExpressionSyntax element in elements)
            {
                if (element != null
                    && (IsNullOrDefaultLiteral(element) || this.IsNullDataRowRead(element)))
                {
                    return MakeNullable(elementType);
                }
            }

            return elementType;
        }

        // Issue #3726: #3682's rule stated for a value that is KNOWN nil rather
        // than the literal `nil`. A theory parameter a data row supplies `null`
        // for (`[InlineData(null, …)]`) really does arrive nil on that row, and
        // the element type is still inferred AT the literal — so widening it is
        // the same faithful repair #3682 makes. Bridging with `!!` instead is
        // exactly the "clean C# turned into a runtime throw" that rule rejects:
        // `new[] { flag, … }.Where(a => a is not null)` deliberately tolerates
        // the null, and `flag!!` would throw before the filter ever ran.
        //
        // Deliberately scoped to that attribute-stated evidence rather than to
        // every promoted declaration: generalizing it to the whole taint
        // fixpoint rewrites ~50 files across the corpus (an array literal's
        // element type is load-bearing for what the literal converts to), which
        // is its own decision.
        private bool IsNullDataRowRead(ExpressionSyntax expression)
        {
            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            return symbol is IParameterSymbol
                && ObliviousNullabilityAnalyzer.HasNullDataRowArgument(symbol)
                && this.ShouldPromoteToNullableReference(symbol);
        }

        // Issue #914: whether <paramref name="expression"/> is a bare `null` /
        // `null!` literal or a `default` / `default(T)` expression — the direct
        // null-argument forms used to detect a null flowing into a delegate
        // parameter position.
        private static bool IsNullOrDefaultLiteral(ExpressionSyntax expression)
        {
            return expression switch
            {
                LiteralExpressionSyntax { RawKind: (int)SyntaxKind.NullLiteralExpression } => true,
                LiteralExpressionSyntax { RawKind: (int)SyntaxKind.DefaultLiteralExpression } => true,
                DefaultExpressionSyntax => true,
                PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression } suppress =>
                    IsNullOrDefaultLiteral(suppress.Operand),
                ParenthesizedExpressionSyntax paren => IsNullOrDefaultLiteral(paren.Expression),
                _ => false,
            };
        }

        // Issue #1072 (field/property initializer form): field/property
        // initializers first consume the shared symbol-position promotion
        // decision, then the distinct direct-initializer signal (`?.`, declared
        // `T?` metadata, etc.) that has no declaration symbol of its own.
        private GTypeReference PromoteIfInitializerNullable(
            GTypeReference type,
            ISymbol symbol,
            ExpressionSyntax initializer)
        {
            if (type == null || type.IsNullable || symbol == null)
            {
                return type;
            }

            ITypeSymbol declaredType = symbol switch
            {
                IFieldSymbol field => field.Type,
                IPropertySymbol property => property.Type,
                _ => null,
            };

            if (declaredType is not { IsReferenceType: true }
                || declaredType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return type;
            }

            return this.ShouldPromoteToNullableReference(symbol)
                || this.IsNullableInitializer(initializer)
                    ? MakeNullable(type)
                    : type;
        }

        // Determines whether <paramref name="expression"/> (a field/property
        // initializer) yields a nullable reference value. Because the migrated
        // corpus typically compiles with the nullable context DISABLED, flow
        // nullability is unavailable, so this combines (a) syntactic forms that
        // introduce null (`a?.b`, `a ?? nullableFallback`, `cond ? a : b`) with
        // (b) the bound symbol's DECLARED nullable annotation, which survives in
        // BCL/source metadata regardless of the consuming nullable context
        // (e.g. `AssemblyName.Name` and `Path.GetFileNameWithoutExtension(...)`
        // are declared `string?`). `x!` suppresses nullability.
        private bool IsNullableInitializer(ExpressionSyntax expression)
        {
            if (expression == null)
            {
                return false;
            }

            switch (expression)
            {
                case ParenthesizedExpressionSyntax paren:
                    return this.IsNullableInitializer(paren.Expression);

                case PostfixUnaryExpressionSyntax suppress
                    when suppress.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                    return false;

                // `a?.b` / `a?[i]`: conditional access yields a nullable result.
                case ConditionalAccessExpressionSyntax:
                    return true;

                // `a ?? b`: nullable iff the `b` fallback is itself nullable.
                case BinaryExpressionSyntax coalesce
                    when coalesce.IsKind(SyntaxKind.CoalesceExpression):
                    return this.IsNullableInitializer(coalesce.Right);

                // `cond ? a : b`: nullable iff either branch is nullable.
                case ConditionalExpressionSyntax ternary:
                    return this.IsNullableInitializer(ternary.WhenTrue)
                        || this.IsNullableInitializer(ternary.WhenFalse);
            }

            // Flow nullability when the nullable context happens to be enabled.
            TypeInfo info = this.context.GetTypeInfo(expression);
            if (info.Nullability.Annotation == NullableAnnotation.Annotated)
            {
                return true;
            }

            // Issue #3802: a `[return: NotNullIfNotNull(nameof(p))]` return is
            // declared `T?` but is exactly as nullable as its named argument,
            // so answer for the ARGUMENT rather than reading the declared `T?`
            // below. The argument's own EMITTED type is what gsc will see, so
            // the taint fixpoint's promotion decision counts here as much as
            // the syntactic one — reading only the latter is what left
            // `Path.GetFileNameWithoutExtension(downloadFileName)` unpromoted
            // in Oahu while `downloadFileName` itself was promoted to `string?`.
            if (ConditionalNotNullPostcondition.TryGetForwardedArgument(
                expression,
                node => this.context.GetSymbolInfo(node).Symbol,
                out ExpressionSyntax conditionalSource))
            {
                return this.IsNullableInitializer(conditionalSource)
                    || this.ShouldPromoteToNullableReference(
                        this.context.GetSymbolInfo(conditionalSource).Symbol);
            }

            // Otherwise consult the bound symbol's declared annotation.
            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            ITypeSymbol symbolType = symbol switch
            {
                IMethodSymbol m => m.ReturnType,
                IPropertySymbol p => p.Type,
                IFieldSymbol f => f.Type,
                ILocalSymbol l => l.Type,
                IParameterSymbol pr => pr.Type,
                _ => null,
            };

            return symbolType is { IsReferenceType: true }
                && symbolType.NullableAnnotation == NullableAnnotation.Annotated;
        }

        // Issue #3644: the subset of <see cref="IsNullableInitializer"/> whose
        // nullability is written into the EXPRESSION SHAPE itself (`a?.b`,
        // `a ?? nullableFallback`, `cond ? a : b` with a nullable arm) rather
        // than inherited from a bound member's declared `T?` annotation. The
        // runtime-lambda result seam keeps these shapes unasserted (their
        // nullability is deliberate) while a flat declared-annotated member
        // read forwarded as the lambda result is bridged with `!!` to preserve
        // the oblivious C# delegate's non-null return contract.
        private bool IsSyntacticallyNullableResultShape(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case ParenthesizedExpressionSyntax paren:
                    return this.IsSyntacticallyNullableResultShape(paren.Expression);

                case ConditionalAccessExpressionSyntax:
                    return true;

                case BinaryExpressionSyntax coalesce
                    when coalesce.IsKind(SyntaxKind.CoalesceExpression):
                    return this.IsNullableInitializer(coalesce.Right);

                case ConditionalExpressionSyntax ternary:
                    return this.IsNullableInitializer(ternary.WhenTrue)
                        || this.IsNullableInitializer(ternary.WhenFalse);

                default:
                    return false;
            }
        }

        // Issue #1072/#2113/#914: the single translator-side promotion decision
        // for a reference-typed symbol position. Declaration rendering and sink
        // `!!` insertion both route through this helper so a tainted interface/
        // implementation member, local/parameter/property/field, or method return
        // gets the same `T?`/forgiveness treatment everywhere.
        private bool ShouldPromoteToNullableReference(ISymbol symbol)
        {
            ITypeSymbol declared = symbol switch
            {
                IMethodSymbol m => m.ReturnType,
                IFieldSymbol f => f.Type,
                IPropertySymbol pr => pr.Type,
                ILocalSymbol l => l.Type,
                IParameterSymbol p => p.Type,
                _ => null,
            };

            if (declared is not { IsReferenceType: true }
                || declared.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
            }

            // Issue #3694: C# gives a declaration two nullability contracts, an
            // INPUT and an OUTPUT one, and `[AllowNull]` keeps the output
            // non-nullable while widening the input — `[AllowNull] T P { get;
            // set; }` is exactly "the setter takes T?, the getter returns T",
            // the shape of a property whose setter normalises `null` to a
            // default. G# has a SINGLE nullability per declaration (ADR-0155,
            // Kotlin-style), so the only rendering that still accepts the
            // writes the C# accepts is `T?`; anything else turns a supported
            // assignment into an unrepresentable one (gsc GS0155 at the write —
            // and there is no `!!` for "assign nil to a non-nil target", so
            // there is nothing to bridge with at the use site).
            //
            // Being attribute-driven, this is decided by the DECLARATION alone:
            // no consumer evidence, no taint fixpoint, the same answer in every
            // compilation of a run. That is what makes it safe across projects,
            // where a consumer's promotion decision could otherwise disagree
            // with the contract the referenced project actually emitted.
            if (ObliviousNullabilityAnalyzer.HasAllowNullWriteContract(symbol))
            {
                return true;
            }

            // Issue #3726: a data-driving attribute is a null-WRITING site. An
            // xunit theory declared `[InlineData(null, …)] void T(string a, …)`
            // genuinely receives `null` for `a` at runtime, and cs2gs emits the
            // attribute — `@InlineData(nil, …)` — right beside the parameter
            // list it renders, so a non-nullable `a` contradicts the file's own
            // attribute (gsc GS0274). Attribute-driven and therefore decided by
            // the DECLARATION alone, exactly like `[AllowNull]` above.
            if (ObliviousNullabilityAnalyzer.HasNullDataRowArgument(symbol))
            {
                return true;
            }

            // EF Core treats reference properties from nullable-oblivious C#
            // entity types as optional. Preserve that model when translating
            // DbSet<T> entities; emitting a non-nullable G# property would make
            // EF materialize nullable database columns with GetString instead
            // of honoring DBNull.
            if (this.IsObliviousCompilation()
                && symbol is IPropertySymbol property
                && this.efEntityTypes.Contains(property.ContainingType.OriginalDefinition))
            {
                return true;
            }

            // A function-type (delegate) parameter with an explicit `= null`
            // default is nullable by construction: a non-nullable function type
            // cannot carry a `nil` default at all (gsc GS0265 at the declaration
            // itself), so it must render `((…) -> R)?`. This is scoped to delegate
            // types because promoting arbitrary reference parameters cascades
            // nullable-mismatch errors (GS0156) at pass-through call sites that
            // would each need their own flow-driven promotion.
            if (symbol is IParameterSymbol { HasExplicitDefaultValue: true } defaulted
                && defaulted.ExplicitDefaultValue is null
                && defaulted.Type.TypeKind == TypeKind.Delegate)
            {
                return true;
            }

            // Issue #2113: in a nullable-OBLIVIOUS compilation, a reference
            // declaration is rendered `T?` iff the whole-program transitive
            // null-taint analysis proved this symbol null-tainted. This is the
            // ONLY behavioral change for oblivious code — for a nullable-enabled
            // compilation `IsTainted` short-circuits to false, so every existing
            // path stays byte-identical.
            //
            // Issue #914 (oblivious deferred-return-promotion): a REFERENCE-
            // constrained type parameter (`where T : class`) is eligible too. The
            // top-of-method guard already required `declared.IsReferenceType`, so
            // an UNCONSTRAINED `T` (whose `IsReferenceType` is false, and for whom
            // `T?` would mean `Nullable<T>`) never reaches here. For a class-
            // constrained `T`, `T?` is an unambiguous nullable reference — the
            // generated `var settings T? = …` locals already rely on it — and
            // `Cast[T]`/`typeof(T)`/`T()` NAME positions are unaffected because
            // they reference `T`, not the promoted symbol.
            //
            // Issue #2412: the taint fixpoint only walks ONE compilation's own
            // syntax trees, so a symbol whose ONLY tainting evidence lives in a
            // REFERENCED sibling project (loaded as its own separate
            // `CSharpCompilation` by `CSharpProjectLoader.
            // LoadProjectWithReferencesAsync`) — whether the symbol is declared
            // there directly, or is declared here/in a third project but only
            // gets wired into taint via a sibling's own interface-implementation
            // edges (issue #2285) — must also be checked against every sibling's
            // OWN cached result, not just `this.context.Compilation`'s (the
            // downstream consumer's translation unit, whose syntax never
            // contains that evidence). `this.context.SiblingCompilations` is
            // `null` for every existing single-compilation caller, so this
            // overload reduces to the exact prior single-compilation check —
            // a pure additive fix for the cross-project case.
            // Issue #3501: a symbol declared in a SHARED document (a source
            // file linked into several repo projects, e.g. test/Shared/*) must
            // translate identically in every project — the repository mirror
            // rejects divergent outputs. Its taint check therefore runs over
            // the whole repository's compilations, and the per-project
            // usage-driven fallback below is skipped for it.
            bool sharedDocument = this.IsDeclaredInRepositorySharedDocument(symbol);
            IReadOnlyList<CSharpCompilation> taintCompilations =
                IsStoredMemberNullabilitySymbol(symbol) || sharedDocument
                    ? this.context.RepositoryCompilations ?? this.context.SiblingCompilations
                    : this.context.SiblingCompilations;

            // Issue #3501: a positional record's synthesized property and its
            // primary-constructor parameter are ONE declaration site (the same
            // ParameterSyntax) but TWO Roslyn symbols. The taint fixpoint keys
            // argument edges on the parameter (`new Entry(null, …)`), while a
            // member read (`entry.GsNamespace`) binds the property — query the
            // parameter's taint for such a property so the value bridge and the
            // promoted declaration agree.
            if (declared.NullableAnnotation == NullableAnnotation.None
                && ObliviousNullabilityAnalyzer.IsTainted(
                    this.context.Compilation,
                    NormalizePositionalRecordProperty(symbol),
                    taintCompilations))
            {
                return true;
            }

            // Issue #3676: a declaration inside an `<auto-generated/>` file is
            // nullable when the code directly writes `null` into it. The C#
            // compiler reports NO nullable diagnostics in generated code, so
            // such a declaration's `NotAnnotated` reference type was never
            // checked against the code that assigns or returns it — LSP
            // protocol plumbing marked generated (for StyleCop, not because it
            // is machine-written) freely writes `Filter = null` into a
            // `string Filter` and `return null` from a `string` method.
            // Translating those annotations at face value emits G# the C#
            // compiler never had to justify, and gsc — which has no such
            // suppression — rejects the `nil` (GS0155).
            if (ObliviousNullabilityAnalyzer.IsGeneratedDeclarationAssignedNull(
                    this.context.Compilation,
                    symbol,
                    this.context.RepositoryCompilations ?? this.context.SiblingCompilations))
            {
                return true;
            }

            return !sharedDocument
                && symbol is not IMethodSymbol
                && this.IsUsedAsNullable(symbol, this.GetNullabilityScope(symbol));
        }

        /// <summary>
        /// Issue #3501: maps a positional record's synthesized property back to
        /// the primary-constructor parameter it was generated from (both
        /// symbols share the SAME <see cref="ParameterSyntax"/> declaration).
        /// Any other symbol is returned unchanged.
        /// </summary>
        private static ISymbol NormalizePositionalRecordProperty(ISymbol symbol)
        {
            if (symbol is IPropertySymbol { ContainingType: { IsRecord: true } owner } property
                && property.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                    is ParameterSyntax declaringParameter)
            {
                foreach (IMethodSymbol constructor in owner.InstanceConstructors)
                {
                    foreach (IParameterSymbol parameter in constructor.Parameters)
                    {
                        if (parameter.Name == property.Name
                            && parameter.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                                == declaringParameter)
                        {
                            return parameter;
                        }
                    }
                }
            }

            return symbol;
        }

        // Issue #3501: file paths that appear in MORE THAN ONE repository
        // compilation — linked/shared sources whose translation must not
        // depend on which project is being translated.
        private bool IsDeclaredInRepositorySharedDocument(ISymbol symbol)
        {
            if (this.context.RepositoryCompilations is not { Count: > 1 } repository)
            {
                return false;
            }

            if (this.repositorySharedDocumentPaths == null)
            {
                var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                foreach (CSharpCompilation compilation in repository)
                {
                    foreach (SyntaxTree tree in compilation.SyntaxTrees)
                    {
                        if (!string.IsNullOrEmpty(tree.FilePath))
                        {
                            counts[tree.FilePath] = counts.TryGetValue(tree.FilePath, out int n) ? n + 1 : 1;
                        }
                    }
                }

                this.repositorySharedDocumentPaths = counts
                    .Where(kv => kv.Value > 1)
                    .Select(kv => kv.Key)
                    .ToHashSet(StringComparer.OrdinalIgnoreCase);
            }

            foreach (SyntaxReference reference in symbol.DeclaringSyntaxReferences)
            {
                string path = reference.SyntaxTree?.FilePath;
                if (!string.IsNullOrEmpty(path) && this.repositorySharedDocumentPaths.Contains(path))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool IsStoredMemberNullabilitySymbol(ISymbol symbol) =>
            symbol is IFieldSymbol or IPropertySymbol
            || symbol is IParameterSymbol
            {
                ContainingSymbol: IMethodSymbol
                {
                    MethodKind: MethodKind.Constructor,
                    ContainingType.IsRecord: true,
                },
            };

        // Issue #2521: sink lowering must use the target contract that G# will
        // actually bind, not consumer-side taint recorded for an imported
        // symbol. Only declarations emitted by this compilation can have their
        // contract widened by this compilation's promotion result. Project
        // references and CLR metadata retain their already-emitted contract.
        private bool TargetWillRemainNonNullableReference(ITypeSymbol targetType, ISymbol targetSymbol)
        {
            if (targetType is not { IsReferenceType: true }
                || targetType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
            }

            // ADR-0169 analyzer mode: an INamespaceSymbol target renders as
            // G#'s namespace display string, which the mapper forces to
            // `string?` (see CSharpTypeMapper.Map) — Roslyn's non-nullable
            // annotation on the C# side is not honored by the G# surface, so
            // the target never remains non-nullable and nullable arguments
            // need no `!!` bridge.
            if (this.InAnalyzerApiMode && Analyzers.RoslynAnalyzerApiMap.IsNamespaceSymbolType(targetType))
            {
                return false;
            }

            // Issue #3694: an `[AllowNull]` target is promoted from its own
            // declaration, so it widens in the project that emits it whether or
            // not that project is the one being translated here. Unlike the
            // evidence-driven promotions below, this one needs no
            // same-compilation gate — the referenced project's migrated
            // declaration is nullable too, so a nullable value needs no bridge.
            if (ObliviousNullabilityAnalyzer.HasAllowNullWriteContract(targetSymbol))
            {
                return false;
            }

            bool targetDeclaredInThisCompilation = targetSymbol?.DeclaringSyntaxReferences
                .Any(reference => this.context.Compilation.ContainsSyntaxTree(reference.SyntaxTree)) == true;

            return !(targetDeclaredInThisCompilation
                && this.ShouldPromoteToNullableReference(targetSymbol));
        }

        // A skipped source-generated property is recreated from its hand-written
        // backing field by gsgen. Carry the property's nullable target contract
        // back to that emitted field so the recreated property has the same type.
        private GTypeReference PromoteIfGeneratedPropertyTargetNullable(
            GTypeReference type,
            IFieldSymbol field)
        {
            if (type == null
                || type.IsNullable
                || field?.Type is not { IsReferenceType: true }
                || field.Type.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return type;
            }

            foreach (IPropertySymbol property in field.ContainingType.GetMembers().OfType<IPropertySymbol>())
            {
                if (!this.ShouldPromoteToNullableReference(property))
                {
                    continue;
                }

                foreach (SyntaxReference reference in property.DeclaringSyntaxReferences)
                {
                    if (!HasAutoGeneratedHeader(reference.SyntaxTree)
                        || reference.GetSyntax() is not PropertyDeclarationSyntax declaration)
                    {
                        continue;
                    }

                    using IDisposable modelScope = this.context.UseSemanticModelFor(reference.SyntaxTree);
                    if (declaration.DescendantNodes()
                        .OfType<IdentifierNameSyntax>()
                        .Any(identifier => this.BindsTo(identifier, field)))
                    {
                        return MakeNullable(type);
                    }
                }
            }

            return type;
        }

        private static bool HasAutoGeneratedHeader(SyntaxTree tree) =>
            ObliviousNullabilityAnalyzer.HasAutoGeneratedHeader(tree);

        // The syntax region a symbol's null usage is searched in: the whole
        // enclosing method for a parameter, the whole declaring type for a field,
        // and the enclosing method body block for a local.
        private SyntaxNode GetNullabilityScope(ISymbol symbol)
        {
            switch (symbol)
            {
                case IParameterSymbol parameter:
                    return parameter.ContainingSymbol?
                        .DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();

                case IFieldSymbol field:
                    return field.ContainingType?
                        .DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();

                case IPropertySymbol property:
                    return property.ContainingType?
                        .DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();

                case ILocalSymbol local:
                    SyntaxNode declaration = local
                        .DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
                    return declaration?.Ancestors().LastOrDefault(a => a is BlockSyntax);

                default:
                    return null;
            }
        }

        // `x is null` / `x is not null` constant pattern (the C# pattern form of a
        // null comparison, which the translator lowers to `== nil` / `!= nil`).
        private static bool IsNullConstantPattern(PatternSyntax pattern)
        {
            if (pattern is UnaryPatternSyntax unary && unary.IsKind(SyntaxKind.NotPattern))
            {
                pattern = unary.Pattern;
            }

            return pattern is ConstantPatternSyntax constant && IsNullLiteral(constant.Expression);
        }

        private static bool IsNullLiteral(ExpressionSyntax expression) =>
            expression is LiteralExpressionSyntax literal
                && literal.IsKind(SyntaxKind.NullLiteralExpression);

        // `null`, parenthesized null, or either form under C# null suppression.
        private static bool IsNullOrSuppressedNull(ExpressionSyntax expression) =>
            expression switch
            {
                ParenthesizedExpressionSyntax parenthesized =>
                    IsNullOrSuppressedNull(parenthesized.Expression),
                PostfixUnaryExpressionSyntax suppress
                    when suppress.IsKind(SyntaxKind.SuppressNullableWarningExpression) =>
                        IsNullOrSuppressedNull(suppress.Operand),
                _ => IsNullLiteral(expression),
            };
    }
}
