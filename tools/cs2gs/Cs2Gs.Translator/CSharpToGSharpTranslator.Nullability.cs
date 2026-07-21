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
            // The scope is scanned with the current document's semantic model, so a
            // node from another syntax tree (e.g. an inherited field declared in a
            // different file) cannot be queried here — `GetSymbolInfo` would throw
            // "Syntax node is not within syntax tree". Such a symbol is promoted (if
            // applicable) while its own document is translated; skip it here.
            if (scope.SyntaxTree != this.context.SemanticModel.SyntaxTree)
            {
                return false;
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
            if (!this.IsObliviousCompilation()
                || mapped is not TupleTypeReference tuple
                || returnType is not INamedTypeSymbol { IsTupleType: true } tupleType
                || tupleType.TupleElements.Length != tuple.ElementTypes.Count)
            {
                return mapped;
            }

            return this.PromoteTupleElements(tuple, tupleType, symbol, new List<int>());
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
                ? new TupleTypeReference(elements) { IsNullable = tuple.IsNullable }
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

            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            return symbol switch
            {
                IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol or IMethodSymbol =>
                    this.ShouldPromoteToNullableReference(symbol),
                _ => false,
            };
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
            if (declared.NullableAnnotation == NullableAnnotation.None
                && ObliviousNullabilityAnalyzer.IsTainted(
                    this.context.Compilation,
                    symbol,
                    this.context.SiblingCompilations))
            {
                return true;
            }

            return symbol is not IMethodSymbol
                && this.IsUsedAsNullable(symbol, this.GetNullabilityScope(symbol));
        }

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
            tree.GetRoot().GetLeadingTrivia().Any(trivia =>
                trivia.ToString().Contains("<auto-generated", StringComparison.OrdinalIgnoreCase));

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
