// <copyright file="CSharpToGSharpTranslator.Statements.cs" company="GSharp">
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
        private const string ReachingTupleProjectionAnnotation =
            "cs2gs-reaching-tuple-projection";

        private readonly Dictionary<
            string,
            (ExpressionSyntax Source, IReadOnlyList<int> Path)>
            reachingTupleProjections = new();

        private enum DelegateArgumentBehavior
        {
            NotObserved,
            InvokedDuringCall,
            Escapes,
        }

        private IEnumerable<GStatement> TranslateLocalDeclaration(VariableDeclarationSyntax declaration, bool isConst, bool isUsing = false, bool isAwait = false)
        {
            // Issue #1900: `ref int r = ref xs[1];` — a ref local. `declaration.Type`
            // is a `RefTypeSyntax`; every declarator in this statement is a ref
            // local aliasing storage, which maps to G#'s native ref-aliasing local
            // (see TranslateRefExpression / TranslateRefLocalDeclaration).
            if (declaration.Type is RefTypeSyntax)
            {
                return this.TranslateRefLocalDeclaration(declaration);
            }

            var results = new List<GStatement>();
            bool hasExplicitType = !declaration.Type.IsVar;

            foreach (VariableDeclaratorSyntax declarator in declaration.Variables)
            {
                GExpression initializer;
                if (declarator.Initializer == null)
                {
                    initializer = null;
                }
                else
                {
                    // Value-position deconstruction assignments still need a
                    // statement seam; ordinary assignments remain inline.
                    var replacements = new List<ExpressionSyntax>();
                    List<AssignmentExpressionSyntax> initializerEmbedded =
                        this.HoistAssignmentsInOrder(
                            declarator.Initializer.Value,
                            includeSelf: true,
                            results,
                            replacements);

                    try
                    {
                        initializer = this.CoerceCovariantArrayConversion(
                            declarator.Initializer.Value,
                            this.CoercePointerConversion(
                                declarator.Initializer.Value,
                                this.CoerceConstantToUnsigned(
                                    declarator.Initializer.Value,
                                    this.TranslateExpression(declarator.Initializer.Value))));
                    }
                    finally
                    {
                        this.ReleaseHoistedAssignments(
                            initializerEmbedded,
                            replacements);
                    }
                }

                if (initializer != null
                    && declarator.Initializer?.Value is { } initializerSyntax
                    && this.context.GetDeclaredSymbol(declarator) is ILocalSymbol localTarget)
                {
                    initializer = this.ForgiveNullableReferenceValue(
                        initializerSyntax,
                        initializer,
                        localTarget.Type,
                        localTarget);
                }

                BindingKind binding;
                if (isConst)
                {
                    binding = BindingKind.Const;
                }
                else if (isUsing)
                {
                    // A `using` resource is read-only after acquisition; it maps to
                    // the immutable `using let` form (sample Defer.gs).
                    binding = BindingKind.Let;
                }
                else
                {
                    var local = this.context.GetDeclaredSymbol(declarator) as ILocalSymbol;
                    binding = local != null && this.IsLocalReassigned(local)
                        ? BindingKind.Var
                        : BindingKind.Let;
                }

                // An immutable `let` requires an initializer; a declaration with no
                // initializer (e.g. a pre-declared `out` target, `int x;`) must bind
                // as mutable `var <name> <type>` so the zero value is named and the
                // subsequent assignment is legal (spec §Bindings, ADR-0115 §B.3).
                if (declarator.Initializer == null && binding == BindingKind.Let)
                {
                    binding = BindingKind.Var;
                }

                // A type clause is required when there is no initializer (it names
                // the zero/default value, spec §Bindings). With an initializer the
                // type is normally inferred (ADR-0115 §B.3) — but when the C#
                // developer wrote an explicit type that differs from the
                // initializer's natural type (an implicit conversion, e.g.
                // `long startSample = 0;` where `0` is `int`), G# would re-infer
                // the narrower natural type and later operations (e.g. `+=` with an
                // `int64` value) fail with GS0129. In that case preserve the
                // developer's declared type so the binding keeps the intended type.
                GTypeReference type = null;
                if (hasExplicitType)
                {
                    bool emitType = initializer == null;

                    // Prefer the local symbol's type: it carries the flow
                    // nullable annotation (`SttsBox?`), whereas
                    // `GetTypeInfo(declaration.Type)` reports the bare type and
                    // silently drops the `?`, so a nullable-enabled local would
                    // be rendered non-nullable and later `= nil`/`== nil` fail.
                    ITypeSymbol declaredType =
                        (this.context.GetDeclaredSymbol(declarator) as ILocalSymbol)?.Type
                        ?? this.context.GetTypeInfo(declaration.Type).Type;

                    if (!emitType && initializer != null && declaredType != null)
                    {
                        // Preserve the explicit type only when it differs from the
                        // initializer's natural type (an implicit conversion). When
                        // they match, omit the clause and rely on inference — the
                        // idiomatic common case. A declared nullable reference
                        // (`Box?`) whose initializer is non-null would infer the
                        // narrower non-null type, so always emit it to keep the `?`.
                        ITypeSymbol naturalType =
                            this.context.GetTypeInfo(declarator.Initializer.Value).Type;
                        if (naturalType == null
                            || !SymbolEqualityComparer.Default.Equals(declaredType, naturalType)
                            || IsAnnotatedNullableReference(declaredType))
                        {
                            emitType = true;
                        }
                        else if (this.context.GetDeclaredSymbol(declarator) is ILocalSymbol equalTypeLocal
                            && this.ShouldPromoteToNullableReference(equalTypeLocal))
                        {
                            // Issue #1737: the explicit-type-equals-initializer-type
                            // shape above bypasses the type clause entirely (relying
                            // on inference), which would also silently drop the
                            // #1072 nullable promotion below. Route it through the
                            // same emitType=true path as every other explicit-typed
                            // shape so `var x = e;` and `T x = e;` (declared type ==
                            // natural type) promote identically.
                            emitType = true;
                        }
                    }

                    if (emitType)
                    {
                        // Issue #4045: an explicitly named delegate is a nominal
                        // CLR type, even when it comes from metadata. Preserve
                        // that identity instead of inferring an equivalent
                        // System.Action/Func structural arrow at runtime.
                        type = declaredType != null
                            ? this.typeMapper.MapExplicitType(
                                declaredType,
                                this.context,
                                declaration.Type.GetLocation())
                            : null;

                        // Issue #1072: a non-nullable reference/array local that is
                        // null-checked or null-assigned in its scope is really nullable.
                        if (this.context.GetDeclaredSymbol(declarator) is ILocalSymbol localSymbol)
                        {
                            type = declarator.Initializer?.Value is { } localInitializer
                                && IsNullOrSuppressedNull(localInitializer)
                                && localSymbol.Type.IsReferenceType
                                    ? MakeNullable(type)
                                    : this.PromoteIfUsedAsNullable(type, localSymbol);
                        }
                    }
                }
                else if (initializer != null &&
                    this.context.GetDeclaredSymbol(declarator) is ILocalSymbol inferredLocal &&
                    this.InferredLocalDeclarationIsNullable(inferredLocal))
                {
                    // Issue #1072/#2305 (inferred-type form): a `var x = e` local
                    // whose uses prove it nullable needs an explicit `T?`.
                    // Otherwise G# may re-infer a non-null type from `e`, making a
                    // later nil check fail GS0129.
                    //
                    // Issue #3907: map through MapEventType, not Map. The C#
                    // author wrote no type here at all — the clause exists only
                    // to carry the `?` — so the spelling must be one G# accepts
                    // for the initializer's own type. `Map` erases a DELEGATE to
                    // its structural arrow type (`EventHandler<T>` becomes
                    // `(object?, T) -> void`), and in G# those are different
                    // types: the conversion between them exists but is
                    // EXPLICIT, so the emitted `let h ((object?, T) -> void)? =
                    // <delegate>` failed with GS0156. MapEventType keeps the
                    // nominal delegate name for exactly the reason it already
                    // documents — structurally equivalent delegates are not
                    // interchangeable — and falls through to Map unchanged for
                    // every non-delegate type, so only this shape moves.
                    type = MakeNullable(this.typeMapper.MapEventType(
                        inferredLocal.Type, this.context, declaration.Type.GetLocation()));
                }
                else if (initializer != null &&
                    declarator.Initializer.Value is BaseObjectCreationExpressionSyntax { ArgumentList.Arguments.Count: 1 } &&
                    this.context.GetDeclaredSymbol(declarator) is ILocalSymbol delegateInferredLocal &&
                    delegateInferredLocal.Type is INamedTypeSymbol namedDelegateLocalType &&
                    namedDelegateLocalType.TypeKind == TypeKind.Delegate)
                {
                    // Issue #4127/#4129 (self-hosting regression, #3501):
                    // decomposed into a designation (`is ILocalSymbol
                    // delegateInferredLocal`) plus a separate, PLAIN enum
                    // comparison (`namedDelegateLocalType.TypeKind ==
                    // TypeKind.Delegate`) — not a nested `{ Type:
                    // INamedTypeSymbol { TypeKind: TypeKind.Delegate } }`
                    // property pattern — because gsc's pattern matcher does
                    // not reliably evaluate a property pattern containing an
                    // enum-constant sub-pattern against an
                    // imported-interface-typed scrutinee (`ILocalSymbol.Type`
                    // is declared `ITypeSymbol`) once this exact translator
                    // source is itself translated to G# and compiled by gsc
                    // — the self-hosting pipeline issue #4116 exists to fix.
                    // See CSharpTypeMapper.MapEventType and
                    // CSharpToGSharpTranslator.Constructors.cs's
                    // `explicitlyNamedDelegate` for the same workaround
                    // already applied elsewhere in this translator (issue
                    // #4153's own repro isolates the trigger to the enum
                    // sub-pattern alone).
                    //
                    // Issue #4116: a `var`-typed local initialized by a
                    // delegate-CREATION expression (`var handler = new
                    // Action(() => counter++);`) can lose its C# delegate
                    // identity entirely. TranslateObjectCreation unwraps
                    // `new SomeDelegate(lambda)` straight to the bare lambda
                    // argument (G# has no delegate-wrapper constructor to
                    // keep), and a `var` local — unlike an EXPLICITLY typed
                    // one (`EventHandler handler = ...`, issue #4045, handled
                    // by the `hasExplicitType` branch above) — has no OTHER
                    // place in the emitted G# that still carries the C#
                    // delegate type forward. Left un-annotated, G# infers the
                    // arrow lambda's type from its own BODY instead: a VOID
                    // delegate whose lambda body is a value-producing
                    // expression (e.g. `counter++` — G# models
                    // increment/decrement as value-producing, ADR-0115 §B /
                    // gsc issue #1027) infers a non-void `Func&lt;T&gt;`
                    // rather than the source's `Action`, and a
                    // reflection-based `MethodInfo.Invoke` against the real
                    // (`Action`-typed) parameter then rejects it outright.
                    // This is the same nominal-identity-preservation rule
                    // already applied to an explicit local's declared type, a
                    // `typeof(...)` operand (issue #4113), and an explicit
                    // generic type argument (issue #4113) — MapExplicitType,
                    // not the general structurally-canonicalizing Map.
                    //
                    // Scoped to exactly this shape (an object-CREATION
                    // initializer, the one TranslateObjectCreation unwraps):
                    // a `var` local initialized by a BARE lambda (`var f = (x
                    // int32 = 10) => x * 2;`, no wrapping delegate
                    // constructor at all) loses nothing — there is no unwrap
                    // step to discard information — and must keep the
                    // idiomatic unannotated arrow form (issue #1901's own
                    // coverage pins this; a broader condition here
                    // regressed it).
                    type = this.typeMapper.MapExplicitType(
                        namedDelegateLocalType, this.context, declaration.Type.GetLocation());
                }

                // Issue #4356: record the emitted G# nullability of this local
                // (analyzer mode), for every later read of it.
                this.RecordEmittedLocalNullability(
                    this.context.GetDeclaredSymbol(declarator) as ILocalSymbol,
                    type,
                    declarator.Initializer?.Value,
                    initializer);

                results.Add(new LocalDeclarationStatement(
                    binding,
                    this.EmittedName(declarator, declarator.Identifier),
                    type,
                    initializer,
                    isUsing: isUsing,
                    isAwait: isAwait));
            }

            return results;
        }

        /// <summary>
        /// Issue #1072/#2305/#3771/#4445: whether a <c>var</c> local's emitted G#
        /// declaration is widened to <c>T?</c>.
        /// </summary>
        /// <remarks>
        /// This is the single rule shared by the declaration site (which emits the
        /// explicit <c>T?</c> clause) and by the assignment-RHS forgiveness, which
        /// must NOT bridge an assignment into a target that is nullable in G#:
        /// unlike C#'s erased <c>!</c>, G#'s <c>!!</c> is a checked assertion that
        /// THROWS on nil.
        /// </remarks>
        private bool InferredLocalDeclarationIsNullable(ILocalSymbol local)
        {
            if (this.ShouldPromoteToNullableReference(local)
                || (IsAnnotatedNullableReference(local.Type)
                    && this.IsUsedAsNullable(local, this.GetNullabilityScope(local))))
            {
                return true;
            }

            return this.InferredLocalDefaultRequiresTypedDeclaration(local);
        }

        private bool InferredLocalDefaultRequiresTypedDeclaration(ILocalSymbol local)
        {
            if (this.state.InferredLocalDefaultTypedDeclarations.TryGetValue(
                    local,
                    out bool cached))
            {
                return cached;
            }

            bool result = this.InferredLocalDefaultRequiresTypedDeclarationCore(local);
            this.state.InferredLocalDefaultTypedDeclarations.Add(local, result);
            return result;
        }

        private bool InferredLocalDefaultRequiresTypedDeclarationCore(
            ILocalSymbol local)
        {
            if (!IsAnnotatedNullableReference(local.Type))
            {
                return false;
            }

            ExpressionSyntax initializer = this.GetInferredLocalInitializer(
                local,
                out ExpressionSyntax flowExpression,
                out int flowPosition);
            if (initializer == null)
            {
                // A non-literal tuple/Deconstruct source has no per-leaf flow
                // API. Preserve the pre-#4445 inference instead of treating
                // Roslyn's declaration annotation as a maybe-null result.
                return false;
            }

            // Roslyn also reports MaybeNull for ordinary unconstrained-T
            // expressions such as `await Func<Task<T>>()`. Issue #4445 is the
            // narrower default-value rule: follow aliases and branch expressions
            // back to a written default, then let Roslyn's flow state decide
            // whether that default still reaches this declaration.
            if (!this.InferredInitializerOriginatesFromDefault(
                initializer,
                new HashSet<ISymbol>(SymbolEqualityComparer.Default)))
            {
                return false;
            }

            TypeInfo typeInfo = initializer.SyntaxTree == this.context.SemanticModel.SyntaxTree
                ? this.context.GetTypeInfo(initializer)
                : default;
            bool isWholeTupleDefault = IsNullOrDefaultLiteral(initializer)
                && typeInfo.Type is { IsTupleType: true };

            NullableFlowState flowState = flowExpression == initializer
                ? typeInfo.Nullability.FlowState
                : this.context.SemanticModel.GetSpeculativeTypeInfo(
                    flowPosition,
                    flowExpression,
                    SpeculativeBindingOption.BindAsExpression).Nullability.FlowState;
            if (flowState == NullableFlowState.None)
            {
                // Roslyn omits element flow in a deconstruction RHS, but
                // speculative binding at that exact position preserves it.
                flowState = this.context.SemanticModel.GetSpeculativeTypeInfo(
                    initializer.SpanStart,
                    initializer,
                    SpeculativeBindingOption.BindAsExpression).Nullability.FlowState;
            }

            if (flowState != NullableFlowState.None)
            {
                return flowState == NullableFlowState.MaybeNull;
            }

            if (isWholeTupleDefault)
            {
                // `default((T, T))` is a non-null ValueTuple as a whole. Use
                // this fallback only when Roslyn has no projected element flow;
                // a stable alias may have narrowed that element at the use site.
                return true;
            }

            if (IsNullForgiven(initializer))
            {
                return false;
            }

            if (!IsNullOrDefaultLiteral(initializer)
                && (typeInfo.Type ?? typeInfo.ConvertedType) is { } initializerType
                && !IsAnnotatedNullableReference(initializerType)
                && initializerType is not ITypeParameterSymbol)
            {
                return false;
            }

            // Roslyn reports FlowState.None for individual tuple RHS leaves in
            // deconstruction, while preserving the inferred annotation here.
            return local.NullableAnnotation == NullableAnnotation.Annotated;
        }

        private bool InferredInitializerOriginatesFromDefault(
            ExpressionSyntax expression,
            HashSet<ISymbol> visited)
        {
            if (this.TryGetReachingTupleProjection(
                expression,
                out ExpressionSyntax projectionSource,
                out IReadOnlyList<int> projectionPath))
            {
                return this.InferredTupleProjectionOriginatesFromDefault(
                    projectionSource,
                    projectionPath,
                    visited);
            }

            switch (expression)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    return this.InferredInitializerOriginatesFromDefault(
                        parenthesized.Expression,
                        visited);

                case PostfixUnaryExpressionSyntax suppression
                    when suppression.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                    return this.InferredInitializerOriginatesFromDefault(
                        suppression.Operand,
                        visited);

                case LiteralExpressionSyntax literal
                    when literal.IsKind(SyntaxKind.DefaultLiteralExpression):
                case DefaultExpressionSyntax:
                    return true;

                case CastExpressionSyntax cast:
                    return this.InferredInitializerOriginatesFromDefault(
                        cast.Expression,
                        visited);

                case AssignmentExpressionSyntax assignment
                    when assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                        || assignment.IsKind(SyntaxKind.CoalesceAssignmentExpression):
                    return this.InferredInitializerOriginatesFromDefault(
                        assignment.Right,
                        visited);

                case ConditionalExpressionSyntax conditional:
                    return this.InferredInitializerOriginatesFromDefault(
                            conditional.WhenTrue,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default))
                        || this.InferredInitializerOriginatesFromDefault(
                            conditional.WhenFalse,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default));

                case BinaryExpressionSyntax coalesce
                    when coalesce.IsKind(SyntaxKind.CoalesceExpression):
                    return this.InferredInitializerOriginatesFromDefault(
                            coalesce.Left,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default))
                        || this.InferredInitializerOriginatesFromDefault(
                            coalesce.Right,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default));

                case SwitchExpressionSyntax switchExpression:
                    return switchExpression.Arms.Any(arm =>
                        this.InferredInitializerOriginatesFromDefault(
                            arm.Expression,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default)));

                case MemberAccessExpressionSyntax member
                    when member.SyntaxTree == this.context.SemanticModel.SyntaxTree
                        && this.TryGetTupleElementAccess(
                            member,
                            out ExpressionSyntax receiver,
                            out IReadOnlyList<int> path):
                    return this.InferredTupleProjectionOriginatesFromDefault(
                        receiver,
                        path,
                        visited);
            }

            if (expression.SyntaxTree != this.context.SemanticModel.SyntaxTree)
            {
                return false;
            }

            if (this.context.GetSymbolInfo(expression).Symbol is not ILocalSymbol local
                || !visited.Add(local))
            {
                return false;
            }

            return this.GetReachingLocalValues(local, expression.SpanStart, visited).Any(value =>
                this.InferredInitializerOriginatesFromDefault(
                    value,
                    new HashSet<ISymbol>(visited, SymbolEqualityComparer.Default)));
        }

        private bool InferredTupleProjectionOriginatesFromDefault(
            ExpressionSyntax source,
            IReadOnlyList<int> path,
            HashSet<ISymbol> visited)
        {
            if (path.Count == 0)
            {
                return this.InferredInitializerOriginatesFromDefault(source, visited);
            }

            source = Unwrap(source);
            if (IsNullOrDefaultLiteral(source))
            {
                return true;
            }

            if (source is CastExpressionSyntax cast)
            {
                return this.InferredTupleProjectionOriginatesFromDefault(
                    cast.Expression,
                    path,
                    visited);
            }

            if (source is AssignmentExpressionSyntax assignment
                && (assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                    || assignment.IsKind(
                        SyntaxKind.CoalesceAssignmentExpression)))
            {
                return this.InferredTupleProjectionOriginatesFromDefault(
                    assignment.Right,
                    path,
                    visited);
            }

            if (source is BinaryExpressionSyntax coalesce
                && coalesce.IsKind(SyntaxKind.CoalesceExpression))
            {
                return this.InferredTupleProjectionOriginatesFromDefault(
                        coalesce.Left,
                        path,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default))
                    || this.InferredTupleProjectionOriginatesFromDefault(
                        coalesce.Right,
                        path,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default));
            }

            int index = path[0];
            IReadOnlyList<int> remaining = path.Skip(1).ToArray();
            if (source is TupleExpressionSyntax tuple
                && index < tuple.Arguments.Count)
            {
                return this.InferredTupleProjectionOriginatesFromDefault(
                    tuple.Arguments[index].Expression,
                    remaining,
                    visited);
            }

            if (source is ConditionalExpressionSyntax conditional)
            {
                return this.InferredTupleProjectionOriginatesFromDefault(
                        conditional.WhenTrue,
                        path,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default))
                    || this.InferredTupleProjectionOriginatesFromDefault(
                        conditional.WhenFalse,
                        path,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default));
            }

            if (source is SwitchExpressionSyntax switchExpression)
            {
                return switchExpression.Arms.Any(arm =>
                    this.InferredTupleProjectionOriginatesFromDefault(
                        arm.Expression,
                        path,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default)));
            }

            if (source.SyntaxTree == this.context.SemanticModel.SyntaxTree
                && this.context.GetSymbolInfo(source).Symbol is ILocalSymbol local
                && visited.Add(local))
            {
                return this.GetReachingLocalValues(
                        local,
                        source.SpanStart,
                        visited)
                    .Any(value => this.InferredTupleProjectionOriginatesFromDefault(
                        value,
                        path,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default)));
            }

            ExpressionSyntax projected = ProjectTupleElement(source, path);
            return projected.SyntaxTree == this.context.SemanticModel.SyntaxTree
                && this.InferredInitializerOriginatesFromDefault(projected, visited);
        }

        private bool TryGetTupleElementAccess(
            MemberAccessExpressionSyntax member,
            out ExpressionSyntax receiver,
            out IReadOnlyList<int> path)
        {
            var indices = new List<int>();
            ExpressionSyntax expression = member;
            while (expression is MemberAccessExpressionSyntax access
                && this.context.GetSymbolInfo(access.Name).Symbol
                    is IFieldSymbol { ContainingType.IsTupleType: true } field
                && this.context.GetTypeInfo(access.Expression).Type
                    is INamedTypeSymbol { IsTupleType: true } tupleType)
            {
                int index = TupleElementIndex(tupleType, field);
                if (index < 0)
                {
                    receiver = null;
                    path = null;
                    return false;
                }

                indices.Insert(0, index);
                expression = access.Expression;
                while (expression is ParenthesizedExpressionSyntax parenthesized)
                {
                    expression = parenthesized.Expression;
                }
            }

            receiver = expression;
            path = indices;
            return indices.Count > 0;
        }

        private static bool IsNullForgiven(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax parenthesized)
            {
                expression = parenthesized.Expression;
            }

            return expression is PostfixUnaryExpressionSyntax
            {
                RawKind: (int)SyntaxKind.SuppressNullableWarningExpression,
            };
        }

        private ExpressionSyntax GetInferredLocalInitializer(
            ILocalSymbol local,
            out ExpressionSyntax flowExpression,
            out int flowPosition)
        {
            flowExpression = null;
            flowPosition = 0;
            SyntaxNode declaration = local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
            if (declaration is VariableDeclaratorSyntax declarator)
            {
                flowExpression = declarator.Initializer?.Value;
                flowPosition = flowExpression?.SpanStart ?? 0;
                return flowExpression;
            }

            if (declaration is not SingleVariableDesignationSyntax designation
                || designation.Ancestors().OfType<AssignmentExpressionSyntax>().FirstOrDefault()
                    is not { Left: { } left, Right: { } right })
            {
                return null;
            }

            if (TryFindDeconstructionPath(designation, left, new List<int>(), out List<int> path))
            {
                flowExpression = ProjectTupleElement(right, path);
                flowPosition = right.SpanStart;
            }

            return FindDeconstructionInitializer(designation, left, right);
        }

        private static bool TryFindDeconstructionPath(
            SingleVariableDesignationSyntax target,
            ExpressionSyntax left,
            List<int> path,
            out List<int> found)
        {
            left = Unwrap(left);
            if (left is DeclarationExpressionSyntax declaration)
            {
                return TryFindDeconstructionPath(target, declaration.Designation, path, out found);
            }

            if (left is TupleExpressionSyntax tuple)
            {
                for (int i = 0; i < tuple.Arguments.Count; i++)
                {
                    path.Add(i);
                    if (TryFindDeconstructionPath(
                        target,
                        tuple.Arguments[i].Expression,
                        path,
                        out found))
                    {
                        return true;
                    }

                    path.RemoveAt(path.Count - 1);
                }
            }

            found = null;
            return false;
        }

        private static bool TryFindDeconstructionPath(
            SingleVariableDesignationSyntax target,
            VariableDesignationSyntax designation,
            List<int> path,
            out List<int> found)
        {
            if (designation.SyntaxTree == target.SyntaxTree
                && designation.Span == target.Span)
            {
                found = new List<int>(path);
                return true;
            }

            if (designation is ParenthesizedVariableDesignationSyntax parenthesized)
            {
                for (int i = 0; i < parenthesized.Variables.Count; i++)
                {
                    path.Add(i);
                    if (TryFindDeconstructionPath(
                        target,
                        parenthesized.Variables[i],
                        path,
                        out found))
                    {
                        return true;
                    }

                    path.RemoveAt(path.Count - 1);
                }
            }

            found = null;
            return false;
        }

        private static ExpressionSyntax ProjectTupleElement(
            ExpressionSyntax expression,
            IReadOnlyList<int> path)
        {
            return ProjectTupleElement(expression, path, 0);
        }

        private static ExpressionSyntax ProjectTupleElement(
            ExpressionSyntax expression,
            IReadOnlyList<int> path,
            int depth)
        {
            if (depth == path.Count)
            {
                return expression;
            }

            expression = Unwrap(expression);
            if (IsNullOrDefaultLiteral(expression))
            {
                return SyntaxFactory.LiteralExpression(
                    SyntaxKind.DefaultLiteralExpression);
            }

            int index = path[depth];
            if (expression is TupleExpressionSyntax tuple
                && index < tuple.Arguments.Count)
            {
                return ProjectTupleElement(
                    tuple.Arguments[index].Expression,
                    path,
                    depth + 1);
            }

            if (expression is ConditionalExpressionSyntax conditional)
            {
                return conditional
                    .WithWhenTrue(ProjectTupleElement(conditional.WhenTrue, path, depth))
                    .WithWhenFalse(ProjectTupleElement(conditional.WhenFalse, path, depth));
            }

            if (expression is SwitchExpressionSyntax switchExpression)
            {
                return switchExpression.WithArms(SyntaxFactory.SeparatedList(
                    switchExpression.Arms.Select(arm =>
                        arm.WithExpression(ProjectTupleElement(arm.Expression, path, depth)))));
            }

            ExpressionSyntax member = SyntaxFactory.MemberAccessExpression(
                SyntaxKind.SimpleMemberAccessExpression,
                SyntaxFactory.ParenthesizedExpression(expression),
                SyntaxFactory.IdentifierName($"Item{index + 1}"));
            return ProjectTupleElement(member, path, depth + 1);
        }

        private ExpressionSyntax FindDeconstructionInitializer(
            SingleVariableDesignationSyntax target,
            ExpressionSyntax left,
            ExpressionSyntax right,
            HashSet<ISymbol> visited = null)
        {
            visited ??= new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            left = Unwrap(left);
            if (right.SyntaxTree == this.context.SemanticModel.SyntaxTree
                && this.context.GetSymbolInfo(right).Symbol is ILocalSymbol alias)
            {
                if (!visited.Add(alias))
                {
                    return null;
                }

                IReadOnlyList<ExpressionSyntax> reaching =
                    this.GetReachingLocalValues(alias, right.SpanStart, visited);
                if (reaching.Count > 1)
                {
                    foreach (ExpressionSyntax value in reaching)
                    {
                        ExpressionSyntax found =
                            FindDeconstructionInitializer(
                                target,
                                left,
                                value,
                                new HashSet<ISymbol>(
                                    visited,
                                    SymbolEqualityComparer.Default));
                        if (this.InitializerOriginatesFromDefault(found))
                        {
                            return found;
                        }
                    }

                    return null;
                }
            }

            right = this.ResolveStableTupleAlias(right);
            if (right is AssignmentExpressionSyntax assignment
                && assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                return FindDeconstructionInitializer(
                    target,
                    left,
                    assignment.Right,
                    visited);
            }

            if (left.SyntaxTree == target.SyntaxTree
                && left.Span.Contains(target.Span)
                && IsNullOrDefaultLiteral(right))
            {
                return right;
            }

            if (left is DeclarationExpressionSyntax declaration)
            {
                return FindDeconstructionInitializer(
                    target,
                    declaration.Designation,
                    right,
                    visited);
            }

            if (right is ConditionalExpressionSyntax conditional)
            {
                ExpressionSyntax found =
                    FindDeconstructionInitializer(
                        target,
                        left,
                        conditional.WhenTrue,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default));
                return this.InitializerOriginatesFromDefault(found)
                    ? found
                    : FindDeconstructionInitializer(
                        target,
                        left,
                        conditional.WhenFalse,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default));
            }

            if (right is BinaryExpressionSyntax coalesce
                && coalesce.IsKind(SyntaxKind.CoalesceExpression))
            {
                ExpressionSyntax found = FindDeconstructionInitializer(
                    target,
                    left,
                    coalesce.Left,
                    new HashSet<ISymbol>(
                        visited,
                        SymbolEqualityComparer.Default));
                return this.InitializerOriginatesFromDefault(found)
                    ? found
                    : FindDeconstructionInitializer(
                        target,
                        left,
                        coalesce.Right,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default));
            }

            if (right is SwitchExpressionSyntax switchExpression)
            {
                foreach (SwitchExpressionArmSyntax arm in switchExpression.Arms)
                {
                    ExpressionSyntax found =
                        FindDeconstructionInitializer(
                            target,
                            left,
                            arm.Expression,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default));
                    if (this.InitializerOriginatesFromDefault(found))
                    {
                        return found;
                    }
                }

                return null;
            }

            if (left is not TupleExpressionSyntax leftTuple
                || right is not TupleExpressionSyntax rightTuple
                || leftTuple.Arguments.Count != rightTuple.Arguments.Count)
            {
                return null;
            }

            for (int i = 0; i < leftTuple.Arguments.Count; i++)
            {
                ExpressionSyntax found = FindDeconstructionInitializer(
                    target,
                    leftTuple.Arguments[i].Expression,
                    rightTuple.Arguments[i].Expression,
                    new HashSet<ISymbol>(
                        visited,
                        SymbolEqualityComparer.Default));
                if (found != null)
                {
                    return found;
                }
            }

            return null;
        }

        private ExpressionSyntax FindDeconstructionInitializer(
            SingleVariableDesignationSyntax target,
            VariableDesignationSyntax designation,
            ExpressionSyntax right,
            HashSet<ISymbol> visited = null)
        {
            visited ??= new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            if (designation.SyntaxTree == target.SyntaxTree
                && designation.Span == target.Span)
            {
                return right;
            }

            if (right.SyntaxTree == this.context.SemanticModel.SyntaxTree
                && this.context.GetSymbolInfo(right).Symbol is ILocalSymbol alias)
            {
                if (!visited.Add(alias))
                {
                    return null;
                }

                IReadOnlyList<ExpressionSyntax> reaching =
                    this.GetReachingLocalValues(alias, right.SpanStart, visited);
                if (reaching.Count > 1)
                {
                    foreach (ExpressionSyntax value in reaching)
                    {
                        ExpressionSyntax found =
                            FindDeconstructionInitializer(
                                target,
                                designation,
                                value,
                                new HashSet<ISymbol>(
                                    visited,
                                    SymbolEqualityComparer.Default));
                        if (this.InitializerOriginatesFromDefault(found))
                        {
                            return found;
                        }
                    }

                    return null;
                }
            }

            right = this.ResolveStableTupleAlias(right);
            if (right is AssignmentExpressionSyntax assignment
                && assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                return FindDeconstructionInitializer(
                    target,
                    designation,
                    assignment.Right,
                    visited);
            }

            if (designation.SyntaxTree == target.SyntaxTree
                && designation.Span.Contains(target.Span)
                && IsNullOrDefaultLiteral(right))
            {
                return right;
            }

            if (right is ConditionalExpressionSyntax conditional)
            {
                ExpressionSyntax found =
                    FindDeconstructionInitializer(
                        target,
                        designation,
                        conditional.WhenTrue,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default));
                return this.InitializerOriginatesFromDefault(found)
                    ? found
                    : FindDeconstructionInitializer(
                        target,
                        designation,
                        conditional.WhenFalse,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default));
            }

            if (right is BinaryExpressionSyntax coalesce
                && coalesce.IsKind(SyntaxKind.CoalesceExpression))
            {
                ExpressionSyntax found =
                    FindDeconstructionInitializer(
                        target,
                        designation,
                        coalesce.Left,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default));
                return this.InitializerOriginatesFromDefault(found)
                    ? found
                    : FindDeconstructionInitializer(
                        target,
                        designation,
                        coalesce.Right,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default));
            }

            if (right is SwitchExpressionSyntax switchExpression)
            {
                foreach (SwitchExpressionArmSyntax arm in switchExpression.Arms)
                {
                    ExpressionSyntax found =
                        FindDeconstructionInitializer(
                            target,
                            designation,
                            arm.Expression,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default));
                    if (this.InitializerOriginatesFromDefault(found))
                    {
                        return found;
                    }
                }

                return null;
            }

            if (designation is not ParenthesizedVariableDesignationSyntax parenthesized
                || right is not TupleExpressionSyntax rightTuple
                || parenthesized.Variables.Count != rightTuple.Arguments.Count)
            {
                return null;
            }

            for (int i = 0; i < parenthesized.Variables.Count; i++)
            {
                ExpressionSyntax found = FindDeconstructionInitializer(
                    target,
                    parenthesized.Variables[i],
                    rightTuple.Arguments[i].Expression,
                    new HashSet<ISymbol>(
                        visited,
                        SymbolEqualityComparer.Default));
                if (found != null)
                {
                    return found;
                }
            }

            return null;
        }

        private bool InitializerOriginatesFromDefault(ExpressionSyntax expression)
        {
            return expression != null
                && this.InferredInitializerOriginatesFromDefault(
                    expression,
                    new HashSet<ISymbol>(SymbolEqualityComparer.Default));
        }

        private ExpressionSyntax ResolveStableTupleAlias(
            ExpressionSyntax expression,
            HashSet<ISymbol> visited = null)
        {
            if (expression.SyntaxTree != this.context.SemanticModel.SyntaxTree)
            {
                return expression;
            }

            visited ??= new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            int usePosition = expression.SpanStart;
            expression = this.UnwrapTuplePreservingCasts(expression);
            while (this.context.GetSymbolInfo(expression).Symbol is ILocalSymbol local
                && visited.Add(local))
            {
                IReadOnlyList<ExpressionSyntax> reaching =
                    this.GetReachingLocalValues(local, usePosition, visited);
                if (reaching.Count == 0)
                {
                    break;
                }

                if (reaching.Count != 1)
                {
                    break;
                }

                expression = reaching[0];
                usePosition = reaching[0].SpanStart;
                if (expression.SyntaxTree != this.context.SemanticModel.SyntaxTree)
                {
                    break;
                }

                expression = this.UnwrapTuplePreservingCasts(expression);
            }

            return expression;
        }

        private IReadOnlyList<ExpressionSyntax> GetReachingLocalValues(
            ILocalSymbol local,
            int usePosition,
            HashSet<ISymbol> visited = null,
            SyntaxNode executableOverride = null,
            IReadOnlyList<ExpressionSyntax> entryValues = null,
            bool preserveDelegateCompoundAssignments = false)
        {
            SyntaxNode declaration = local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
            ExpressionSyntax initializer = null;
            VariableDeclaratorSyntax declarator = declaration as VariableDeclaratorSyntax;
            if (declarator?.Initializer?.Value is { } declaratorInitializer)
            {
                initializer = declaratorInitializer;
            }
            else if (declaration is SingleVariableDesignationSyntax designation
                && designation.Ancestors().OfType<AssignmentExpressionSyntax>().FirstOrDefault()
                    is { Left: { } left, Right: { } right })
            {
                initializer = FindDeconstructionInitializer(
                    designation,
                    left,
                    right,
                    visited);
            }

            SyntaxNode declarationExecutable =
                declaration.AncestorsAndSelf().FirstOrDefault(node =>
                node is BaseMethodDeclarationSyntax
                    or AccessorDeclarationSyntax
                    or LocalFunctionStatementSyntax
                    or AnonymousFunctionExpressionSyntax);
            declarationExecutable ??= declaration.AncestorsAndSelf()
                .OfType<CompilationUnitSyntax>()
                .FirstOrDefault();
            SyntaxNode executable = executableOverride ?? declarationExecutable;
            if (executable == null)
            {
                return Array.Empty<ExpressionSyntax>();
            }

            IReadOnlyList<ExpressionSyntax> initialValues =
                entryValues ?? Array.Empty<ExpressionSyntax>();
            if (executableOverride == null
                && declarationExecutable != null
                && declaration.SyntaxTree.GetRoot().FindToken(usePosition).Parent
                    is { } useNode)
            {
                List<SyntaxNode> nestedExecutables = useNode.AncestorsAndSelf()
                    .TakeWhile(node => node.Span != declarationExecutable.Span)
                    .Where(node =>
                        node is BaseMethodDeclarationSyntax
                            or AccessorDeclarationSyntax
                            or LocalFunctionStatementSyntax
                            or AnonymousFunctionExpressionSyntax)
                    .Reverse()
                    .ToList();
                foreach (SyntaxNode nestedExecutable in nestedExecutables)
                {
                    HashSet<ISymbol> declarationVisited = visited == null
                        ? null
                        : new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default);
                    var nestedInitialValues = new HashSet<ExpressionSyntax>(
                        this.GetReachingLocalValues(
                            local,
                            nestedExecutable.SpanStart,
                            declarationVisited,
                            executable,
                            initialValues,
                            preserveDelegateCompoundAssignments));
                    foreach (int invocationPosition
                        in this.GetInvocationPositions(nestedExecutable, executable))
                    {
                        HashSet<ISymbol> invocationVisited = visited == null
                            ? null
                            : new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default);
                        nestedInitialValues.UnionWith(this.GetReachingLocalValues(
                            local,
                            invocationPosition,
                            invocationVisited,
                            executable,
                            initialValues,
                            preserveDelegateCompoundAssignments));
                    }

                    bool recursiveChanged;
                    do
                    {
                        recursiveChanged = false;
                        foreach (int invocationPosition in
                            this.GetInvocationPositions(
                                nestedExecutable,
                                nestedExecutable))
                        {
                            int before = nestedInitialValues.Count;
                            HashSet<ISymbol> invocationVisited = visited == null
                                ? null
                                : new HashSet<ISymbol>(
                                    visited,
                                    SymbolEqualityComparer.Default);
                            nestedInitialValues.UnionWith(
                                this.GetReachingLocalValues(
                                    local,
                                    invocationPosition,
                                    invocationVisited,
                                    nestedExecutable,
                                    nestedInitialValues.ToList(),
                                    preserveDelegateCompoundAssignments));
                            recursiveChanged |= nestedInitialValues.Count != before;
                        }
                    }
                    while (recursiveChanged);

                    initialValues = nestedInitialValues.ToList();
                    executable = nestedExecutable;
                }
            }

            Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph graph;
            try
            {
                graph = this.CreateControlFlowGraph(executable);
            }
            catch (ArgumentException)
            {
                return Array.Empty<ExpressionSyntax>();
            }

            Microsoft.CodeAnalysis.FlowAnalysis.BasicBlock useBlock = null;
            int useOperationIndex = -1;
            foreach (Microsoft.CodeAnalysis.FlowAnalysis.BasicBlock block in graph.Blocks)
            {
                for (int i = 0; i < block.Operations.Length; i++)
                {
                    if (block.Operations[i].Syntax.FullSpan.Contains(usePosition))
                    {
                        useBlock = block;
                        useOperationIndex = i;
                        break;
                    }
                }

                if (useBlock == null
                    && block.BranchValue?.Syntax.FullSpan.Contains(usePosition) == true)
                {
                    useBlock = block;
                    useOperationIndex = block.Operations.Length;
                }

                if (useBlock != null)
                {
                    break;
                }
            }

            if (useBlock?.IsReachable != true)
            {
                return Array.Empty<ExpressionSyntax>();
            }

            var outputs =
                new Dictionary<Microsoft.CodeAnalysis.FlowAnalysis.BasicBlock,
                    HashSet<ExpressionSyntax>>();
            var assignedValues = new Dictionary<AssignmentExpressionSyntax, ExpressionSyntax>();
            var elementAssignedValues =
                new Dictionary<
                    (string Write, string Previous),
                    ExpressionSyntax>();
            ExpressionSyntax unknownTuple = CreateUnknownTuple(local.Type);
            bool changed;
            do
            {
                changed = false;
                foreach (Microsoft.CodeAnalysis.FlowAnalysis.BasicBlock block in graph.Blocks)
                {
                    if (!block.IsReachable)
                    {
                        continue;
                    }

                    var values = new HashSet<ExpressionSyntax>();
                    if (block.Kind
                        == Microsoft.CodeAnalysis.FlowAnalysis.BasicBlockKind.Entry)
                    {
                        values.UnionWith(initialValues);
                    }

                    foreach (Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowBranch predecessor
                        in block.Predecessors)
                    {
                        if (outputs.TryGetValue(predecessor.Source, out var predecessorValues))
                        {
                            values.UnionWith(predecessorValues);
                        }
                    }

                    foreach (IOperation operation in block.Operations)
                    {
                        this.ApplyReachingOperation(
                            operation,
                            declaration,
                            initializer,
                            local,
                            values,
                            assignedValues,
                            elementAssignedValues,
                            visited,
                            unknownTuple,
                            preserveDelegateCompoundAssignments);
                    }

                    if (block.BranchValue is { } branchValue)
                    {
                        this.ApplyReachingOperation(
                            branchValue,
                            declaration,
                            initializer,
                            local,
                            values,
                            assignedValues,
                            elementAssignedValues,
                            visited,
                            unknownTuple,
                            preserveDelegateCompoundAssignments);
                    }

                    if (!outputs.TryGetValue(block, out var previous)
                        || !previous.SetEquals(values))
                    {
                        outputs[block] = values;
                        changed = true;
                    }
                }
            }
            while (changed);

            var reaching = new HashSet<ExpressionSyntax>();
            foreach (Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowBranch predecessor
                in useBlock.Predecessors)
            {
                if (outputs.TryGetValue(predecessor.Source, out var predecessorValues))
                {
                    reaching.UnionWith(predecessorValues);
                }
            }

            for (int i = 0; i < useOperationIndex; i++)
            {
                this.ApplyReachingOperation(
                    useBlock.Operations[i],
                    declaration,
                    initializer,
                    local,
                    reaching,
                    assignedValues,
                    elementAssignedValues,
                    visited,
                    unknownTuple,
                    preserveDelegateCompoundAssignments);
            }

            if (useOperationIndex < useBlock.Operations.Length)
            {
                this.ApplyReachingOperation(
                    useBlock.Operations[useOperationIndex],
                    declaration,
                    initializer,
                    local,
                    reaching,
                    assignedValues,
                    elementAssignedValues,
                    visited,
                    unknownTuple,
                    preserveDelegateCompoundAssignments,
                    usePosition);
            }
            else if (useBlock.BranchValue is { } branchValue)
            {
                this.ApplyReachingOperation(
                    branchValue,
                    declaration,
                    initializer,
                    local,
                    reaching,
                    assignedValues,
                    elementAssignedValues,
                    visited,
                    unknownTuple,
                    preserveDelegateCompoundAssignments,
                    usePosition);
            }

            return reaching.ToList();
        }

        private IEnumerable<int> GetInvocationPositions(
            SyntaxNode nestedExecutable,
            SyntaxNode enclosingExecutable)
        {
            ISymbol callable = null;
            AnonymousFunctionExpressionSyntax anonymousFunction = null;
            if (nestedExecutable is LocalFunctionStatementSyntax localFunction)
            {
                callable = this.context.SemanticModel.GetDeclaredSymbol(localFunction);
            }
            else if (nestedExecutable is AnonymousFunctionExpressionSyntax nestedAnonymousFunction)
            {
                anonymousFunction = nestedAnonymousFunction;
                SyntaxNode owner = anonymousFunction;
                while (owner.Parent switch
                {
                    ParenthesizedExpressionSyntax parenthesized
                        when parenthesized.Expression == owner => true,
                    CastExpressionSyntax cast when cast.Expression == owner => true,
                    PostfixUnaryExpressionSyntax suppression
                        when suppression.IsKind(
                            SyntaxKind.SuppressNullableWarningExpression)
                            && suppression.Operand == owner => true,
                    _ => false,
                })
                {
                    owner = owner.Parent;
                }

                if (owner.Parent is EqualsValueClauseSyntax
                    {
                        Parent: VariableDeclaratorSyntax declarator,
                    })
                {
                    callable = this.context.SemanticModel.GetDeclaredSymbol(declarator);
                }
                else if (owner.Parent
                    is AssignmentExpressionSyntax assignment)
                {
                    callable = this.context.GetSymbolInfo(assignment.Left).Symbol;
                }
            }

            if (callable == null && anonymousFunction == null)
            {
                yield break;
            }

            SyntaxNode executionBody = enclosingExecutable switch
            {
                AnonymousFunctionExpressionSyntax anonymous => anonymous.Body,
                LocalFunctionStatementSyntax { Body: { } body } => body,
                LocalFunctionStatementSyntax
                { ExpressionBody.Expression: { } expression } => expression,
                _ => enclosingExecutable,
            };

            foreach (InvocationExpressionSyntax invocation in
                EagerExecutionNodes(executionBody)
                    .OfType<InvocationExpressionSyntax>())
            {
                IMethodSymbol invokedMethod =
                    this.context.GetSymbolInfo(invocation).Symbol
                        as IMethodSymbol;
                if (anonymousFunction != null
                    && invokedMethod?.MethodKind != MethodKind.DelegateInvoke)
                {
                    continue;
                }

                if (anonymousFunction == null
                    && (invokedMethod == null
                        || (invokedMethod.MethodKind
                                != MethodKind.LocalFunction
                            && invokedMethod.MethodKind
                                != MethodKind.DelegateInvoke)))
                {
                    continue;
                }

                ExpressionSyntax target = invocation.Expression;
                if (target is MemberAccessExpressionSyntax invoke
                    && invoke.Name.Identifier.ValueText == "Invoke")
                {
                    target = invoke.Expression;
                }
                else if (target is MemberBindingExpressionSyntax binding
                    && binding.Name.Identifier.ValueText == "Invoke"
                    && invocation.Parent is ConditionalAccessExpressionSyntax conditional)
                {
                    target = conditional.Expression;
                }

                if (anonymousFunction == null)
                {
                    if (callable is not IMethodSymbol callableLocalFunction
                        || !this.DelegateExpressionReachesLocalFunction(
                            target,
                            invocation.SpanStart,
                            callableLocalFunction,
                            new HashSet<ISymbol>(
                                SymbolEqualityComparer.Default)))
                    {
                        continue;
                    }
                }
                else if (!this.DelegateExpressionReachesAnonymousFunction(
                        target,
                        invocation.SpanStart,
                        anonymousFunction,
                        enclosingExecutable,
                        new HashSet<ISymbol>(
                            SymbolEqualityComparer.Default)))
                {
                    continue;
                }

                yield return invocation.ArgumentList.CloseParenToken.SpanStart;
            }

            foreach (SyntaxNode escapeNode in EagerExecutionNodes(executionBody))
            {
                // Roslyn traversal elements are concrete; self-migration imports them as platform-typed.
                var escape = escapeNode!;
                ExpressionSyntax value;
                int position;
                bool includeLaterStates;
                switch (escape)
                {
                    case ReturnStatementSyntax returnedStatement:
                        ExpressionSyntax returned = returnedStatement.Expression;
                        if (returned == null)
                        {
                            continue;
                        }

                        value = returned;
                        position = returned.Span.End - 1;
                        includeLaterStates = true;
                        break;

                    case YieldStatementSyntax yieldedStatement
                        when yieldedStatement.IsKind(
                            SyntaxKind.YieldReturnStatement):
                        ExpressionSyntax yielded = yieldedStatement.Expression;
                        if (yielded == null)
                        {
                            continue;
                        }

                        value = yielded;
                        position = yielded.Span.End - 1;
                        includeLaterStates = true;
                        break;

                    case ArgumentSyntax argument
                        when !argument.RefOrOutKeyword.IsKind(
                                SyntaxKind.OutKeyword)
                            && (this.context.GetTypeInfo(argument.Expression)
                                    .ConvertedType
                                ?? this.context.GetTypeInfo(
                                    argument.Expression).Type)?.TypeKind
                                == TypeKind.Delegate:
                        DelegateArgumentBehavior behavior =
                            this.GetDelegateArgumentBehavior(argument);
                        if (behavior == DelegateArgumentBehavior.NotObserved)
                        {
                            continue;
                        }

                        value = argument.Expression;
                        position = argument.Parent?.Parent
                            is InvocationExpressionSyntax escapedInvocation
                                ? escapedInvocation.ArgumentList.CloseParenToken.SpanStart
                                : argument.Span.End;
                        includeLaterStates =
                            behavior == DelegateArgumentBehavior.Escapes;
                        break;

                    default:
                        continue;
                }

                bool reachesCallable = anonymousFunction != null
                    ? this.DelegateExpressionReachesAnonymousFunction(
                        value,
                        value.SpanStart,
                        anonymousFunction,
                        enclosingExecutable,
                        new HashSet<ISymbol>(
                            SymbolEqualityComparer.Default))
                    : callable is IMethodSymbol escapedLocalFunction
                        && this.DelegateExpressionReachesLocalFunction(
                            value,
                            value.SpanStart,
                            escapedLocalFunction,
                            new HashSet<ISymbol>(
                                SymbolEqualityComparer.Default));
                if (reachesCallable)
                {
                    yield return position;
                    if (includeLaterStates)
                    {
                        foreach (SyntaxNode laterNode in
                            EagerExecutionNodes(executionBody))
                        {
                            if (laterNode is StatementSyntax later
                                && later.SpanStart > escape.SpanStart)
                            {
                                yield return later.Span.End - 1;
                            }
                        }
                    }
                }
            }

            if (anonymousFunction == null)
            {
                if (callable is IMethodSymbol escapedLocalFunction)
                {
                    foreach (AssignmentExpressionSyntax assignment in
                        EagerExecutionNodes(executionBody)
                            .OfType<AssignmentExpressionSyntax>()
                            .Where(candidate =>
                                this.IsNonLocalDelegateStorage(candidate.Left))
                            .Where(candidate =>
                                this.DelegateExpressionReachesLocalFunction(
                                    candidate.Right,
                                    candidate.Right.SpanStart,
                                    escapedLocalFunction,
                                    new HashSet<ISymbol>(
                                        SymbolEqualityComparer.Default))))
                    {
                        foreach (StatementSyntax later in
                            EagerExecutionNodes(executionBody)
                                .OfType<StatementSyntax>()
                                .Where(statement =>
                                    statement.SpanStart >= assignment.Span.End))
                        {
                            yield return later.Span.End - 1;
                        }
                    }
                }

                yield break;
            }

            foreach (AssignmentExpressionSyntax assignment in
                EagerExecutionNodes(executionBody)
                    .OfType<AssignmentExpressionSyntax>()
                    .Where(candidate =>
                        this.IsNonLocalDelegateStorage(candidate.Left)))
            {
                if (!this.DelegateExpressionReachesAnonymousFunction(
                    assignment.Right,
                    assignment.Right.SpanStart,
                    anonymousFunction,
                    enclosingExecutable,
                    new HashSet<ISymbol>(SymbolEqualityComparer.Default)))
                {
                    continue;
                }

                foreach (StatementSyntax later in
                    EagerExecutionNodes(executionBody)
                        .OfType<StatementSyntax>()
                        .Where(statement => statement.SpanStart >= assignment.Span.End))
                {
                    int position = later.Span.End - 1;
                    if (this.NonLocalDelegateMayReferenceAnonymousFunction(
                        assignment.Left,
                        position,
                        anonymousFunction,
                        enclosingExecutable))
                    {
                        yield return position;
                    }
                }
            }
        }

        private DelegateArgumentBehavior GetDelegateArgumentBehavior(
            ArgumentSyntax argument)
        {
            IParameterSymbol parameter = DetermineParameter(argument, this.context);
            if (parameter == null
                || parameter.DeclaringSyntaxReferences.IsDefaultOrEmpty)
            {
                return DelegateArgumentBehavior.Escapes;
            }

            if (DelegateCalleeMayDispatchDynamically(argument, parameter))
            {
                return DelegateArgumentBehavior.Escapes;
            }

            bool invoked = false;
            foreach (SyntaxReference reference in parameter.DeclaringSyntaxReferences)
            {
                if (reference.GetSyntax() is not ParameterSyntax declaration)
                {
                    return DelegateArgumentBehavior.Escapes;
                }

                SemanticModel model = declaration.SyntaxTree
                    == this.context.SemanticModel.SyntaxTree
                        ? this.context.SemanticModel
                        : this.context.Compilation.GetSemanticModel(
                            declaration.SyntaxTree);
                SyntaxNode executable = declaration.Ancestors().FirstOrDefault(
                    node => node is BaseMethodDeclarationSyntax
                        or LocalFunctionStatementSyntax
                        or AnonymousFunctionExpressionSyntax);
                if (executable == null)
                {
                    return DelegateArgumentBehavior.Escapes;
                }

                SyntaxNode body = executable switch
                {
                    LocalFunctionStatementSyntax { Body: { } block } => block,
                    LocalFunctionStatementSyntax
                    { ExpressionBody.Expression: { } expression } => expression,
                    AnonymousFunctionExpressionSyntax anonymous => anonymous.Body,
                    _ => executable,
                };
                var eagerUses = EagerExecutionNodes(body)
                    .OfType<IdentifierNameSyntax>()
                    .Where(identifier =>
                        SymbolEqualityComparer.Default.Equals(
                            model.GetSymbolInfo(identifier).Symbol,
                            parameter))
                    .ToList();
                foreach (IdentifierNameSyntax use in eagerUses)
                {
                    if (DelegateParameterUseIsInvocation(use))
                    {
                        invoked = true;
                        continue;
                    }

                    if (DelegateParameterUseIsNonEscapingObservation(use, model))
                    {
                        continue;
                    }

                    DelegateArgumentBehavior aliasBehavior =
                        GetSourceDelegateAliasBehavior(
                            use,
                            body,
                            model,
                            new HashSet<ISymbol>(
                                SymbolEqualityComparer.Default));
                    if (aliasBehavior == DelegateArgumentBehavior.Escapes)
                    {
                        return DelegateArgumentBehavior.Escapes;
                    }

                    invoked |= aliasBehavior
                        == DelegateArgumentBehavior.InvokedDuringCall;
                }

                var eagerUseStarts = eagerUses
                    .Select(use => use.SpanStart)
                    .ToHashSet();
                bool capturedByNestedExecutable = body.DescendantNodes()
                    .OfType<IdentifierNameSyntax>()
                    .Any(identifier =>
                        !eagerUseStarts.Contains(identifier.SpanStart)
                            && SymbolEqualityComparer.Default.Equals(
                                model.GetSymbolInfo(identifier).Symbol,
                                parameter));
                if (capturedByNestedExecutable)
                {
                    return DelegateArgumentBehavior.Escapes;
                }
            }

            return invoked
                ? DelegateArgumentBehavior.InvokedDuringCall
                : DelegateArgumentBehavior.NotObserved;
        }

        private static DelegateArgumentBehavior GetSourceDelegateAliasBehavior(
            IdentifierNameSyntax use,
            SyntaxNode body,
            SemanticModel model,
            HashSet<ISymbol> visited)
        {
            ILocalSymbol alias = null;
            if (use.Ancestors().OfType<VariableDeclaratorSyntax>().FirstOrDefault()
                is { Initializer.Value: { } initializer } declarator
                && initializer.Span.Contains(use.Span))
            {
                alias = model.GetDeclaredSymbol(declarator) as ILocalSymbol;
            }
            else if (use.Ancestors().OfType<AssignmentExpressionSyntax>()
                    .FirstOrDefault(assignment =>
                        assignment.Right.Span.Contains(use.Span))
                is { Left: { } left })
            {
                alias = model.GetSymbolInfo(left).Symbol as ILocalSymbol;
            }

            if (alias?.Type.TypeKind != TypeKind.Delegate
                || !visited.Add(alias))
            {
                return DelegateArgumentBehavior.Escapes;
            }

            bool invoked = false;
            List<IdentifierNameSyntax> eagerUses = EagerExecutionNodes(body)
                .OfType<IdentifierNameSyntax>()
                .Where(identifier =>
                    SymbolEqualityComparer.Default.Equals(
                        model.GetSymbolInfo(identifier).Symbol,
                        alias))
                .ToList();
            foreach (IdentifierNameSyntax aliasUse in eagerUses)
            {
                if (DelegateParameterUseIsInvocation(aliasUse))
                {
                    invoked = true;
                    continue;
                }

                if (DelegateParameterUseIsNonEscapingObservation(
                        aliasUse,
                        model))
                {
                    continue;
                }

                DelegateArgumentBehavior behavior =
                    GetSourceDelegateAliasBehavior(
                        aliasUse,
                        body,
                        model,
                        visited);
                if (behavior == DelegateArgumentBehavior.Escapes)
                {
                    return behavior;
                }

                invoked |= behavior == DelegateArgumentBehavior.InvokedDuringCall;
            }

            var eagerUseStarts = eagerUses
                .Select(eagerUse => eagerUse.SpanStart)
                .ToHashSet();
            bool capturedByNestedExecutable = body.DescendantNodes()
                .OfType<IdentifierNameSyntax>()
                .Any(identifier =>
                    SymbolEqualityComparer.Default.Equals(
                        model.GetSymbolInfo(identifier).Symbol,
                        alias)
                        && !eagerUseStarts.Contains(identifier.SpanStart));
            if (capturedByNestedExecutable)
            {
                return DelegateArgumentBehavior.Escapes;
            }

            return invoked
                ? DelegateArgumentBehavior.InvokedDuringCall
                : DelegateArgumentBehavior.NotObserved;
        }

        private static bool DelegateCalleeMayDispatchDynamically(
            ArgumentSyntax argument,
            IParameterSymbol parameter)
        {
            if (parameter.ContainingSymbol is not IMethodSymbol method
                || method.IsStatic
                || method.MethodKind == MethodKind.LocalFunction
                || method.IsSealed
                || method.ContainingType?.IsSealed == true
                || method is
                    {
                        IsAbstract: false,
                        IsVirtual: false,
                        IsOverride: false,
                    })
            {
                return false;
            }

            return argument.Parent?.Parent
                is not InvocationExpressionSyntax
                {
                    Expression: MemberAccessExpressionSyntax
                    {
                        Expression: BaseExpressionSyntax,
                    },
                };
        }

        private static bool DelegateParameterUseIsInvocation(
            IdentifierNameSyntax use)
        {
            if (use.Parent is InvocationExpressionSyntax direct
                && direct.Expression == use)
            {
                return true;
            }

            if (use.Parent is MemberAccessExpressionSyntax member
                && member.Expression == use
                && member.Name.Identifier.ValueText == "Invoke"
                && member.Parent is InvocationExpressionSyntax)
            {
                return true;
            }

            return use.Parent is ConditionalAccessExpressionSyntax conditional
                && conditional.Expression == use
                && conditional.WhenNotNull
                    is InvocationExpressionSyntax invocation
                && invocation.Expression
                    is MemberBindingExpressionSyntax binding
                && binding.Name.Identifier.ValueText == "Invoke";
        }

        private static bool DelegateParameterUseIsNonEscapingObservation(
            IdentifierNameSyntax use,
            SemanticModel model)
        {
            SimpleNameSyntax memberName = use.Parent switch
            {
                MemberAccessExpressionSyntax member
                    when member.Expression == use => member.Name,
                ConditionalAccessExpressionSyntax conditional
                    when conditional.Expression == use
                        && conditional.WhenNotNull
                            is MemberBindingExpressionSyntax binding =>
                    binding.Name,
                _ => null,
            };
            if (memberName == null)
            {
                return false;
            }

            ISymbol observedMember = model.GetSymbolInfo(memberName).Symbol;
            INamedTypeSymbol containingType = observedMember?.ContainingType;
            bool isObjectOrDelegate = containingType?.SpecialType
                    == SpecialType.System_Object
                || containingType?.ToDisplayString() is
                    "System.Delegate" or "System.MulticastDelegate";
            bool isTerminalObservation = observedMember switch
            {
                IMethodSymbol method when method.Name is
                    "GetHashCode" or "ToString" or "GetType" or "Equals" => true,
                IPropertySymbol property when property.Name is
                    "Method" or "Target" => true,
                _ => false,
            };
            return isObjectOrDelegate && isTerminalObservation;
        }

        private static bool LocalFunctionMatches(
            ISymbol symbol,
            IMethodSymbol localFunction) =>
            symbol is IMethodSymbol method
                && SymbolEqualityComparer.Default.Equals(
                    method.OriginalDefinition,
                    localFunction.OriginalDefinition);

        private bool DelegateExpressionReachesLocalFunction(
            ExpressionSyntax expression,
            int usePosition,
            IMethodSymbol localFunction,
            HashSet<ISymbol> visited)
        {
            foreach (ExpressionSyntax candidate in
                expression.DescendantNodesAndSelf().OfType<ExpressionSyntax>())
            {
                if (candidate.SyntaxTree != this.context.SemanticModel.SyntaxTree)
                {
                    continue;
                }

                ISymbol symbol = this.context.GetSymbolInfo(candidate).Symbol;
                if (LocalFunctionMatches(symbol, localFunction))
                {
                    return true;
                }

                if (symbol is ILocalSymbol delegateLocal
                    && delegateLocal.Type.TypeKind == TypeKind.Delegate
                    && this.DelegateLocalReachesLocalFunction(
                        delegateLocal,
                        usePosition,
                        localFunction,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default)))
                {
                    return true;
                }

                if (candidate is InvocationExpressionSyntax
                    && symbol is IMethodSymbol factory
                    && visited.Add(factory.OriginalDefinition))
                {
                    foreach (ExpressionSyntax returned in
                        this.GetSourceCallableReturnExpressions(factory))
                    {
                        // Source return expressions are concrete; self-migration imports sequence elements as nullable.
                        var returnedExpression = returned!;
                        if (this.DelegateExpressionReachesLocalFunction(
                            returnedExpression,
                            returnedExpression.SpanStart,
                            localFunction,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default)))
                        {
                            return true;
                        }
                    }
                }
            }

            return false;
        }

        private bool DelegateLocalReachesLocalFunction(
            ILocalSymbol local,
            int usePosition,
            IMethodSymbol localFunction,
            HashSet<ISymbol> visited)
        {
            if (!visited.Add(local))
            {
                return false;
            }

            foreach (ExpressionSyntax value in this.GetReachingLocalValues(
                local,
                usePosition,
                preserveDelegateCompoundAssignments: true))
            {
                foreach (ExpressionSyntax expression in
                    value.DescendantNodesAndSelf().OfType<ExpressionSyntax>())
                {
                    if (expression.SyntaxTree != this.context.SemanticModel.SyntaxTree)
                    {
                        continue;
                    }

                    ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
                    if (LocalFunctionMatches(symbol, localFunction))
                    {
                        return true;
                    }

                    if (symbol is ILocalSymbol alias
                        && alias.Type.TypeKind == TypeKind.Delegate
                        && this.DelegateLocalReachesLocalFunction(
                            alias,
                            expression.SpanStart,
                            localFunction,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default)))
                    {
                        return true;
                    }

                    if (expression is InvocationExpressionSyntax
                        && symbol is IMethodSymbol factory
                        && visited.Add(factory.OriginalDefinition))
                    {
                        foreach (ExpressionSyntax returned in
                            this.GetSourceCallableReturnExpressions(factory))
                        {
                            // Source return expressions are concrete; self-migration imports sequence elements as nullable.
                            var returnedExpression = returned!;
                            if (this.DelegateExpressionReachesLocalFunction(
                                returnedExpression,
                                returnedExpression.SpanStart,
                                localFunction,
                                new HashSet<ISymbol>(
                                    visited,
                                    SymbolEqualityComparer.Default)))
                            {
                                return true;
                            }
                        }
                    }
                }
            }

            return false;
        }

        private bool DelegateExpressionReachesAnonymousFunction(
                ExpressionSyntax expression,
                int usePosition,
                AnonymousFunctionExpressionSyntax anonymousFunction,
                SyntaxNode enclosingExecutable,
                HashSet<ISymbol> visited)
        {
            if (expression.DescendantNodesAndSelf().Any(node =>
                node.SyntaxTree == anonymousFunction.SyntaxTree
                    && node.Span == anonymousFunction.Span))
            {
                return true;
            }

            foreach (ExpressionSyntax candidate in
                expression.DescendantNodesAndSelf().OfType<ExpressionSyntax>())
            {
                if (candidate.SyntaxTree != this.context.SemanticModel.SyntaxTree)
                {
                    continue;
                }

                ISymbol symbol = this.context.GetSymbolInfo(candidate).Symbol;
                if (symbol is ILocalSymbol local
                    && local.Type.TypeKind == TypeKind.Delegate
                    && this.DelegateLocalReachesAnonymousFunction(
                        local,
                        usePosition,
                        anonymousFunction,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default)))
                {
                    return true;
                }

                if (symbol is (IFieldSymbol or IPropertySymbol or IEventSymbol)
                    && this.NonLocalDelegateMayReferenceAnonymousFunction(
                        candidate,
                        usePosition,
                        anonymousFunction,
                        enclosingExecutable))
                {
                    return true;
                }

                if (candidate is InvocationExpressionSyntax
                    && symbol is IMethodSymbol factory
                    && visited.Add(factory.OriginalDefinition))
                {
                    foreach (ExpressionSyntax returned in
                        this.GetSourceCallableReturnExpressions(factory))
                    {
                        // Source return expressions are concrete; self-migration imports sequence elements as nullable.
                        var returnedExpression = returned!;
                        if (this.DelegateExpressionReachesAnonymousFunction(
                            returnedExpression,
                            returnedExpression.SpanStart,
                            anonymousFunction,
                            FindEnclosingExecutable(returnedExpression),
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default)))
                        {
                            return true;
                        }
                    }
                }
            }

            return false;
        }

        private IEnumerable<ExpressionSyntax> GetSourceCallableReturnExpressions(
            IMethodSymbol method)
        {
            foreach (SyntaxReference reference
                in method.OriginalDefinition.DeclaringSyntaxReferences)
            {
                SyntaxNode declaration = reference.GetSyntax();
                if (declaration.SyntaxTree != this.context.SemanticModel.SyntaxTree)
                {
                    continue;
                }

                switch (declaration)
                {
                    case MethodDeclarationSyntax
                    { ExpressionBody.Expression: { } expression }:
                        yield return expression;
                        continue;

                    case LocalFunctionStatementSyntax
                    { ExpressionBody.Expression: { } expression }:
                        yield return expression;
                        continue;
                }

                SyntaxNode body = declaration switch
                {
                    BaseMethodDeclarationSyntax { Body: { } block } => block,
                    LocalFunctionStatementSyntax { Body: { } block } => block,
                    _ => null,
                };
                if (body == null)
                {
                    continue;
                }

                foreach (ReturnStatementSyntax returned in EagerExecutionNodes(body)
                    .OfType<ReturnStatementSyntax>()
                    .Where(statement => statement.Expression != null))
                {
                    yield return returned.Expression;
                }
            }
        }

        private bool NonLocalDelegateMayReferenceAnonymousFunction(
            ExpressionSyntax storage,
            int usePosition,
            AnonymousFunctionExpressionSyntax anonymousFunction,
            SyntaxNode enclosingExecutable)
        {
            if (!this.IsNonLocalDelegateStorage(storage))
            {
                return false;
            }

            Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph graph;
            try
            {
                graph = this.CreateControlFlowGraph(enclosingExecutable);
            }
            catch (ArgumentException)
            {
                return false;
            }

            Microsoft.CodeAnalysis.FlowAnalysis.BasicBlock useBlock = null;
            int useOperationIndex = -1;
            foreach (Microsoft.CodeAnalysis.FlowAnalysis.BasicBlock block in graph.Blocks)
            {
                for (int i = 0; i < block.Operations.Length; i++)
                {
                    if (block.Operations[i].Syntax.FullSpan.Contains(usePosition))
                    {
                        useBlock = block;
                        useOperationIndex = i;
                        break;
                    }
                }

                if (useBlock == null
                    && block.BranchValue?.Syntax.FullSpan.Contains(usePosition) == true)
                {
                    useBlock = block;
                    useOperationIndex = block.Operations.Length;
                }

                if (useBlock != null)
                {
                    break;
                }
            }

            if (useBlock?.IsReachable != true)
            {
                return false;
            }

            var outputs =
                new Dictionary<
                    Microsoft.CodeAnalysis.FlowAnalysis.BasicBlock,
                    HashSet<int>>();
            bool changed;
            do
            {
                changed = false;
                foreach (Microsoft.CodeAnalysis.FlowAnalysis.BasicBlock block
                    in graph.Blocks)
                {
                    if (!block.IsReachable)
                    {
                        continue;
                    }

                    var states = new HashSet<int>();
                    if (block.Kind
                        == Microsoft.CodeAnalysis.FlowAnalysis.BasicBlockKind.Entry)
                    {
                        states.Add(0);
                    }

                    foreach (Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowBranch predecessor
                        in block.Predecessors)
                    {
                        if (outputs.TryGetValue(predecessor.Source, out var predecessorStates))
                        {
                            states.UnionWith(predecessorStates);
                        }
                    }

                    foreach (IOperation operation in block.Operations)
                    {
                        states = this.ApplyDelegateReachingOperation(
                            operation,
                            storage,
                            states,
                            anonymousFunction,
                            usePosition);
                    }

                    if (block.BranchValue is { } branchValue)
                    {
                        states = this.ApplyDelegateReachingOperation(
                            branchValue,
                            storage,
                            states,
                            anonymousFunction,
                            usePosition);
                    }

                    if (!outputs.TryGetValue(block, out var previous)
                        || !previous.SetEquals(states))
                    {
                        outputs[block] = states;
                        changed = true;
                    }
                }
            }
            while (changed);

            var reaching = new HashSet<int>();
            foreach (Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowBranch predecessor
                in useBlock.Predecessors)
            {
                if (outputs.TryGetValue(predecessor.Source, out var predecessorStates))
                {
                    reaching.UnionWith(predecessorStates);
                }
            }

            for (int i = 0; i < useOperationIndex; i++)
            {
                reaching = this.ApplyDelegateReachingOperation(
                    useBlock.Operations[i],
                    storage,
                    reaching,
                    anonymousFunction,
                    usePosition);
            }

            if (useOperationIndex < useBlock.Operations.Length)
            {
                reaching = this.ApplyDelegateReachingOperation(
                    useBlock.Operations[useOperationIndex],
                    storage,
                    reaching,
                    anonymousFunction,
                    usePosition,
                    usePosition);
            }
            else if (useBlock.BranchValue is { } branchValue)
            {
                reaching = this.ApplyDelegateReachingOperation(
                    branchValue,
                    storage,
                    reaching,
                    anonymousFunction,
                    usePosition,
                    usePosition);
            }

            return reaching.Any(count => count > 0);
        }

        private bool IsNonLocalDelegateStorage(ExpressionSyntax expression)
        {
            expression = Unwrap(expression);
            return this.context.GetSymbolInfo(expression).Symbol
                    is IFieldSymbol or IPropertySymbol or IEventSymbol
                || (expression is ElementAccessExpressionSyntax
                        && this.context.GetTypeInfo(expression).Type?.TypeKind
                            == TypeKind.Delegate);
        }

        private HashSet<int> ApplyDelegateReachingOperation(
            IOperation operation,
            ExpressionSyntax storage,
            HashSet<int> states,
            AnonymousFunctionExpressionSyntax anonymousFunction,
            int storageUsePosition,
            int beforePosition = int.MaxValue)
        {
            foreach (AssignmentExpressionSyntax assignment in
                EagerExecutionNodes(operation.Syntax)
                    .OfType<AssignmentExpressionSyntax>()
                    .Where(candidate => candidate.Span.End <= beforePosition)
                    .Where(candidate =>
                        this.DelegateStorageMatches(
                            candidate.Left,
                            storage,
                            storageUsePosition))
                    .OrderBy(candidate => candidate.Span.End))
            {
                var next = new HashSet<int>();
                bool opaqueStorage = this.IsOpaqueDelegateStorage(storage);
                foreach (int state in states)
                {
                    int rightCount =
                        this.DelegateAssignmentValueAnonymousFunctionCount(
                            assignment.Right,
                            state,
                            storage,
                            anonymousFunction,
                            storageUsePosition);
                    if (opaqueStorage)
                    {
                        // A property's accessors may ignore or transform what is
                        // stored, so a write never proves the earlier delegate
                        // is gone: keep the prior state beside the written one.
                        next.Add(state);
                    }

                    next.Add(assignment.Kind() switch
                    {
                        SyntaxKind.AddAssignmentExpression =>
                            Math.Min(2, state + rightCount),
                        SyntaxKind.SubtractAssignmentExpression =>
                            state == 1 && rightCount == 1 ? 0 : state,
                        _ => rightCount,
                    });
                }

                states = next;
            }

            return states;
        }

        private int DelegateAssignmentValueAnonymousFunctionCount(
            ExpressionSyntax expression,
            int currentState,
            ExpressionSyntax trackedStorage,
            AnonymousFunctionExpressionSyntax anonymousFunction,
            int trackedStorageUsePosition)
        {
            expression = Unwrap(expression);
            if (expression.DescendantNodesAndSelf().Any(node =>
                node.SyntaxTree == anonymousFunction.SyntaxTree
                    && node.Span == anonymousFunction.Span))
            {
                return 1;
            }

            if (this.DelegateStorageMatches(
                expression,
                trackedStorage,
                trackedStorageUsePosition))
            {
                return currentState;
            }

            if (this.context.GetSymbolInfo(expression).Symbol is ILocalSymbol local
                && local.Type.TypeKind == TypeKind.Delegate)
            {
                return this.DelegateLocalReachesAnonymousFunction(
                    local,
                    expression.SpanStart,
                    anonymousFunction,
                    new HashSet<ISymbol>(SymbolEqualityComparer.Default))
                        ? 1
                        : 0;
            }

            return expression switch
            {
                ConditionalExpressionSyntax conditional =>
                    Math.Max(
                        this.DelegateAssignmentValueAnonymousFunctionCount(
                            conditional.WhenTrue,
                            currentState,
                            trackedStorage,
                            anonymousFunction,
                            trackedStorageUsePosition),
                        this.DelegateAssignmentValueAnonymousFunctionCount(
                            conditional.WhenFalse,
                            currentState,
                            trackedStorage,
                            anonymousFunction,
                            trackedStorageUsePosition)),
                BinaryExpressionSyntax binary when binary.IsKind(
                    SyntaxKind.AddExpression) =>
                    AddDelegateCounts(
                        this.DelegateAssignmentValueAnonymousFunctionCount(
                            binary.Left,
                            currentState,
                            trackedStorage,
                            anonymousFunction,
                            trackedStorageUsePosition),
                        this.DelegateAssignmentValueAnonymousFunctionCount(
                            binary.Right,
                            currentState,
                            trackedStorage,
                            anonymousFunction,
                            trackedStorageUsePosition)),
                BinaryExpressionSyntax binary when binary.IsKind(
                    SyntaxKind.CoalesceExpression) =>
                    Math.Max(
                        this.DelegateAssignmentValueAnonymousFunctionCount(
                            binary.Left,
                            currentState,
                            trackedStorage,
                            anonymousFunction,
                            trackedStorageUsePosition),
                        this.DelegateAssignmentValueAnonymousFunctionCount(
                            binary.Right,
                            currentState,
                            trackedStorage,
                            anonymousFunction,
                            trackedStorageUsePosition)),
                _ => 0,
            };
        }

        // Field-like storage (fields, events, array elements) holds exactly what
        // was written; a property does not. Anything whose writes cannot be
        // proven to replace the stored delegate is opaque and only ever widens.
        private bool IsOpaqueDelegateStorage(ExpressionSyntax storage) =>
            this.context.GetSymbolInfo(Unwrap(storage)).Symbol is IPropertySymbol;

        private static int AddDelegateCounts(int left, int right) =>
            Math.Min(2, left + right);

        private bool DelegateStorageMatches(
            ExpressionSyntax left,
            ExpressionSyntax right,
            int? rightUsePosition = null)
        {
            left = Unwrap(left);
            right = Unwrap(right);
            if (left is ElementAccessExpressionSyntax
                || right is ElementAccessExpressionSyntax)
            {
                if (left is not ElementAccessExpressionSyntax leftElement
                    || right is not ElementAccessExpressionSyntax rightElement)
                {
                    return false;
                }

                return this.IndexedDelegateStorageMatches(
                    leftElement,
                    rightElement,
                    rightUsePosition);
            }

            ISymbol leftSymbol = this.context.GetSymbolInfo(left).Symbol;
            ISymbol rightSymbol = this.context.GetSymbolInfo(right).Symbol;
            if (!SymbolEqualityComparer.Default.Equals(leftSymbol, rightSymbol))
            {
                return false;
            }

            if (leftSymbol?.IsStatic == true)
            {
                return true;
            }

            ExpressionSyntax leftReceiver =
                (left as MemberAccessExpressionSyntax)?.Expression;
            ExpressionSyntax rightReceiver =
                (right as MemberAccessExpressionSyntax)?.Expression;
            if (leftReceiver == null || rightReceiver == null)
            {
                ExpressionSyntax explicitReceiver = leftReceiver ?? rightReceiver;
                return explicitReceiver == null
                    || explicitReceiver is ThisExpressionSyntax;
            }

            if (leftReceiver is ThisExpressionSyntax
                || rightReceiver is ThisExpressionSyntax)
            {
                return leftReceiver is ThisExpressionSyntax
                    && rightReceiver is ThisExpressionSyntax;
            }

            return this.DelegateReceiverMatches(
                leftReceiver,
                rightReceiver,
                rightUsePosition);
        }

        private bool DelegateReceiverMatches(
            ExpressionSyntax left,
            ExpressionSyntax right,
            int? rightUsePosition = null)
        {
            left = Unwrap(left);
            right = Unwrap(right);
            ISymbol leftSymbol = this.context.GetSymbolInfo(left).Symbol;
            ISymbol rightSymbol = this.context.GetSymbolInfo(right).Symbol;
            if (leftSymbol is ILocalSymbol or IParameterSymbol
                || rightSymbol is ILocalSymbol or IParameterSymbol)
            {
                IReadOnlyList<ExpressionSyntax> leftOrigins =
                    this.GetIndexedDelegateReceiverOrigins(
                        left,
                        new HashSet<ISymbol>(
                            SymbolEqualityComparer.Default));
                IReadOnlyList<ExpressionSyntax> rightOrigins =
                    this.GetIndexedDelegateReceiverOrigins(
                        right,
                        new HashSet<ISymbol>(
                            SymbolEqualityComparer.Default),
                        rightUsePosition);
                if (leftOrigins.Count == 0 || rightOrigins.Count == 0)
                {
                    return SymbolEqualityComparer.Default.Equals(
                        leftSymbol,
                        rightSymbol);
                }

                return this.DelegateOriginSetsMatch(
                    leftOrigins,
                    rightOrigins);
            }

            if (left is ThisExpressionSyntax || right is ThisExpressionSyntax)
            {
                return left is ThisExpressionSyntax
                    && right is ThisExpressionSyntax;
            }

            if (left is MemberAccessExpressionSyntax leftMember
                && right is MemberAccessExpressionSyntax rightMember)
            {
                return SymbolEqualityComparer.Default.Equals(
                        this.context.GetSymbolInfo(leftMember).Symbol,
                        this.context.GetSymbolInfo(rightMember).Symbol)
                    && this.DelegateReceiverMatches(
                        leftMember.Expression,
                        rightMember.Expression,
                        rightUsePosition);
            }

            if (left is ElementAccessExpressionSyntax leftElement
                && right is ElementAccessExpressionSyntax rightElement)
            {
                return this.IndexedDelegateStorageMatches(
                    leftElement,
                    rightElement,
                    rightUsePosition);
            }

            return leftSymbol != null
                && SymbolEqualityComparer.Default.Equals(
                    leftSymbol,
                    rightSymbol);
        }

        private bool IndexedDelegateStorageMatches(
            ElementAccessExpressionSyntax left,
            ElementAccessExpressionSyntax right,
            int? rightUsePosition = null)
        {
            if (left.ArgumentList.Arguments.Count
                    != right.ArgumentList.Arguments.Count)
            {
                return false;
            }

            for (int i = 0; i < left.ArgumentList.Arguments.Count; i++)
            {
                Optional<object> leftIndex = this.context.SemanticModel
                    .GetConstantValue(
                        left.ArgumentList.Arguments[i].Expression);
                Optional<object> rightIndex = this.context.SemanticModel
                    .GetConstantValue(
                        right.ArgumentList.Arguments[i].Expression);
                ISymbol leftIndexSymbol = this.context.GetSymbolInfo(
                    left.ArgumentList.Arguments[i].Expression).Symbol;
                ISymbol rightIndexSymbol = this.context.GetSymbolInfo(
                    right.ArgumentList.Arguments[i].Expression).Symbol;
                if (leftIndexSymbol is not (ILocalSymbol or IParameterSymbol)
                    && rightIndexSymbol is not (ILocalSymbol or IParameterSymbol)
                    && leftIndex.HasValue
                    && rightIndex.HasValue)
                {
                    if (!Equals(leftIndex.Value, rightIndex.Value))
                    {
                        return false;
                    }

                    continue;
                }

                IReadOnlyList<ExpressionSyntax> leftIndexOrigins =
                    this.GetIndexedDelegateReceiverOrigins(
                        left.ArgumentList.Arguments[i].Expression,
                        new HashSet<ISymbol>(
                            SymbolEqualityComparer.Default));
                IReadOnlyList<ExpressionSyntax> rightIndexOrigins =
                    this.GetIndexedDelegateReceiverOrigins(
                        right.ArgumentList.Arguments[i].Expression,
                        new HashSet<ISymbol>(
                            SymbolEqualityComparer.Default),
                        rightUsePosition);

                if (!this.DelegateOriginSetsMatch(
                    leftIndexOrigins,
                    rightIndexOrigins))
                {
                    return false;
                }
            }

            IReadOnlyList<ExpressionSyntax> leftOrigins =
                this.GetIndexedDelegateReceiverOrigins(
                    left.Expression,
                    new HashSet<ISymbol>(SymbolEqualityComparer.Default));
            IReadOnlyList<ExpressionSyntax> rightOrigins =
                this.GetIndexedDelegateReceiverOrigins(
                    right.Expression,
                    new HashSet<ISymbol>(SymbolEqualityComparer.Default),
                    rightUsePosition);
            return this.DelegateOriginSetsMatch(leftOrigins, rightOrigins);
        }

        private bool DelegateOriginSetsMatch(
            IReadOnlyList<ExpressionSyntax> left,
            IReadOnlyList<ExpressionSyntax> right)
        {
            return left.Count > 0
                && right.Count > 0
                && left.Any(leftOrigin =>
                    right.Any(rightOrigin =>
                        this.IndexedDelegateReceiverOriginMatches(
                            leftOrigin,
                            rightOrigin)));
        }

        private IReadOnlyList<ExpressionSyntax> GetIndexedDelegateReceiverOrigins(
            ExpressionSyntax expression,
            HashSet<ISymbol> visited,
            int? usePosition = null)
        {
            expression = Unwrap(expression);
            if (expression.SyntaxTree != this.context.SemanticModel.SyntaxTree)
            {
                return Array.Empty<ExpressionSyntax>();
            }

            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            if (symbol is ILocalSymbol local)
            {
                if (!visited.Add(local))
                {
                    return Array.Empty<ExpressionSyntax>();
                }

                IReadOnlyList<ExpressionSyntax> reaching =
                    this.GetReachingLocalValues(
                        local,
                        usePosition ?? expression.SpanStart,
                        new HashSet<ISymbol>(
                            visited,
                            SymbolEqualityComparer.Default));
                if (reaching.Count == 0)
                {
                    return new[] { expression };
                }

                return reaching
                    .SelectMany(value =>
                        this.GetIndexedDelegateReceiverOrigins(
                            value,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default)))
                    .ToList();
            }

            if (usePosition is int observationPosition
                && symbol is IParameterSymbol or IFieldSymbol
                && this.TryGetDefiniteAssignmentsBetween(
                    symbol,
                    expression,
                    observationPosition,
                    out IReadOnlyList<ExpressionSyntax> assignedValues))
            {
                return assignedValues
                    .SelectMany(assignedValue =>
                        this.GetIndexedDelegateReceiverOrigins(
                            assignedValue,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default)))
                    .ToList();
            }

            if (symbol is IPropertySymbol or IMethodSymbol
                || expression is InvocationExpressionSyntax)
            {
                return Array.Empty<ExpressionSyntax>();
            }

            return new[] { expression };
        }

        private bool TryGetDefiniteAssignmentsBetween(
            ISymbol symbol,
            ExpressionSyntax start,
            int usePosition,
            out IReadOnlyList<ExpressionSyntax> assignedValues)
        {
            assignedValues = null;
            StatementSyntax startStatement = start.AncestorsAndSelf()
                .OfType<StatementSyntax>()
                .FirstOrDefault();
            StatementSyntax useStatement = start.SyntaxTree.GetRoot()
                .FindToken(usePosition)
                .Parent?
                .AncestorsAndSelf()
                .OfType<StatementSyntax>()
                .FirstOrDefault();
            if (startStatement?.Parent is not BlockSyntax block
                || useStatement?.Parent != block)
            {
                return false;
            }

            int startIndex = block.Statements.IndexOf(startStatement);
            int useIndex = block.Statements.IndexOf(useStatement);
            if (startIndex < 0 || useIndex <= startIndex)
            {
                return false;
            }

            foreach (StatementSyntax statement in block.Statements
                .Skip(startIndex + 1)
                .Take(useIndex - startIndex - 1))
            {
                if (statement is ExpressionStatementSyntax expressionStatement
                    && expressionStatement.Expression
                        is AssignmentExpressionSyntax assignment
                    && assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                    && this.BindsTo(assignment.Left, symbol))
                {
                    assignedValues = new[] { assignment.Right };
                    continue;
                }

                DataFlowAnalysis flow =
                    this.context.SemanticModel.AnalyzeDataFlow(statement);
                if (flow.Succeeded
                    && flow.AlwaysAssigned.Any(assigned =>
                        SymbolEqualityComparer.Default.Equals(assigned, symbol)))
                {
                    List<ExpressionSyntax> values = statement.DescendantNodes()
                        .OfType<AssignmentExpressionSyntax>()
                        .Where(candidate =>
                            candidate.IsKind(
                                SyntaxKind.SimpleAssignmentExpression)
                                && this.BindsTo(candidate.Left, symbol))
                        .Select(candidate => candidate.Right)
                        .ToList();
                    if (values.Count > 0)
                    {
                        assignedValues = values;
                    }
                }

                if (symbol is IFieldSymbol
                    && this.TryGetDefinitelyAssignedValues(
                        statement,
                        symbol,
                        out IReadOnlyList<ExpressionSyntax> fieldValues))
                {
                    assignedValues = fieldValues;
                }
            }

            return assignedValues != null;
        }

        private bool TryGetDefinitelyAssignedValues(
            StatementSyntax statement,
            ISymbol symbol,
            out IReadOnlyList<ExpressionSyntax> values)
        {
            if (statement is ExpressionStatementSyntax expressionStatement
                && expressionStatement.Expression
                    is AssignmentExpressionSyntax assignment
                && assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                && this.BindsTo(assignment.Left, symbol))
            {
                values = new[] { assignment.Right };
                return true;
            }

            if (statement is BlockSyntax block)
            {
                foreach (StatementSyntax nested in block.Statements.Reverse())
                {
                    if (this.TryGetDefinitelyAssignedValues(
                        nested,
                        symbol,
                        out values))
                    {
                        return true;
                    }
                }
            }

            if (statement is IfStatementSyntax conditional
                && conditional.Else?.Statement is { } whenFalse
                && this.TryGetDefinitelyAssignedValues(
                    conditional.Statement,
                    symbol,
                    out IReadOnlyList<ExpressionSyntax> whenTrueValues)
                && this.TryGetDefinitelyAssignedValues(
                    whenFalse,
                    symbol,
                    out IReadOnlyList<ExpressionSyntax> whenFalseValues))
            {
                values = whenTrueValues.Concat(whenFalseValues).ToList();
                return true;
            }

            values = null;
            return false;
        }

        private bool IndexedDelegateReceiverOriginMatches(
            ExpressionSyntax left,
            ExpressionSyntax right)
        {
            left = Unwrap(left);
            right = Unwrap(right);
            if (left.SyntaxTree == right.SyntaxTree
                && left.Span == right.Span)
            {
                return true;
            }

            // Equivalent constants at different syntax locations (`0` in
            // `xs[0]` and in `var i = 0; xs[i]`) are the same origin.
            Optional<object> leftConstant =
                this.context.SemanticModel.GetConstantValue(left);
            Optional<object> rightConstant =
                this.context.SemanticModel.GetConstantValue(right);
            if (leftConstant.HasValue && rightConstant.HasValue)
            {
                return Equals(leftConstant.Value, rightConstant.Value);
            }

            ISymbol leftSymbol = this.context.GetSymbolInfo(left).Symbol;
            ISymbol rightSymbol = this.context.GetSymbolInfo(right).Symbol;
            if (leftSymbol is IParameterSymbol
                || leftSymbol is ILocalSymbol)
            {
                return SymbolEqualityComparer.Default.Equals(
                    leftSymbol,
                    rightSymbol);
            }

            if (leftSymbol is not IFieldSymbol
                || !SymbolEqualityComparer.Default.Equals(
                    leftSymbol,
                    rightSymbol))
            {
                return left is ThisExpressionSyntax
                    && right is ThisExpressionSyntax;
            }

            ExpressionSyntax leftReceiver =
                (left as MemberAccessExpressionSyntax)?.Expression;
            ExpressionSyntax rightReceiver =
                (right as MemberAccessExpressionSyntax)?.Expression;
            if (leftReceiver == null || rightReceiver == null)
            {
                return leftReceiver == null && rightReceiver == null;
            }

            IReadOnlyList<ExpressionSyntax> leftOrigins =
                this.GetIndexedDelegateReceiverOrigins(
                    leftReceiver,
                    new HashSet<ISymbol>(SymbolEqualityComparer.Default));
            IReadOnlyList<ExpressionSyntax> rightOrigins =
                this.GetIndexedDelegateReceiverOrigins(
                    rightReceiver,
                    new HashSet<ISymbol>(SymbolEqualityComparer.Default));
            return this.DelegateOriginSetsMatch(leftOrigins, rightOrigins);
        }

        private bool DelegateLocalReachesAnonymousFunction(
            ILocalSymbol local,
            int usePosition,
            AnonymousFunctionExpressionSyntax anonymousFunction,
            HashSet<ISymbol> visited)
        {
            if (!visited.Add(local))
            {
                return false;
            }

            foreach (ExpressionSyntax value in this.GetReachingLocalValues(
                local,
                usePosition,
                preserveDelegateCompoundAssignments: true))
            {
                if (value.DescendantNodesAndSelf().Any(node =>
                    node.SyntaxTree == anonymousFunction.SyntaxTree
                        && node.Span == anonymousFunction.Span))
                {
                    return true;
                }

                foreach (ExpressionSyntax expression in
                    value.DescendantNodesAndSelf().OfType<ExpressionSyntax>())
                {
                    if (expression.SyntaxTree == this.context.SemanticModel.SyntaxTree
                        && this.context.GetSymbolInfo(expression).Symbol
                            is ILocalSymbol alias
                        && alias.Type.TypeKind == TypeKind.Delegate
                        && this.DelegateLocalReachesAnonymousFunction(
                            alias,
                            expression.SpanStart,
                            anonymousFunction,
                            new HashSet<ISymbol>(
                                visited,
                                SymbolEqualityComparer.Default)))
                    {
                        return true;
                    }

                    if (expression.SyntaxTree
                            == this.context.SemanticModel.SyntaxTree
                        && expression is InvocationExpressionSyntax
                        && this.context.GetSymbolInfo(expression).Symbol
                            is IMethodSymbol factory
                        && visited.Add(factory.OriginalDefinition))
                    {
                        foreach (ExpressionSyntax returned in
                            this.GetSourceCallableReturnExpressions(factory))
                        {
                            // Source return expressions are concrete; self-migration imports sequence elements as nullable.
                            var returnedExpression = returned!;
                            if (this.DelegateExpressionReachesAnonymousFunction(
                                returnedExpression,
                                returnedExpression.SpanStart,
                                anonymousFunction,
                                FindEnclosingExecutable(returnedExpression),
                                new HashSet<ISymbol>(
                                    visited,
                                    SymbolEqualityComparer.Default)))
                            {
                                return true;
                            }
                        }
                    }
                }
            }

            return false;
        }

        private Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph CreateControlFlowGraph(
            SyntaxNode executable)
        {
            if (executable is LocalFunctionStatementSyntax localFunction)
            {
                Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph parent =
                    this.CreateControlFlowGraph(FindEnclosingExecutable(executable));
                IMethodSymbol symbol =
                    this.context.SemanticModel.GetDeclaredSymbol(localFunction);
                return Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraphExtensions
                    .GetLocalFunctionControlFlowGraphInScope(parent, symbol);
            }

            if (executable is AnonymousFunctionExpressionSyntax anonymousFunction)
            {
                Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph parent =
                    this.CreateControlFlowGraph(FindEnclosingExecutable(executable));
                Microsoft.CodeAnalysis.FlowAnalysis.IFlowAnonymousFunctionOperation operation =
                    parent.Blocks
                        .SelectMany(block => block.Operations
                            .Append(block.BranchValue)
                            .Where(candidate => candidate != null))
                        .SelectMany(operation => operation.DescendantsAndSelf())
                        .OfType<Microsoft.CodeAnalysis.FlowAnalysis
                            .IFlowAnonymousFunctionOperation>()
                        .First(candidate =>
                            candidate.Syntax.SyntaxTree == anonymousFunction.SyntaxTree
                            && candidate.Syntax.Span == anonymousFunction.Span);
                return Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraphExtensions
                    .GetAnonymousFunctionControlFlowGraphInScope(parent, operation);
            }

            if (executable is EqualsValueClauseSyntax or ArrowExpressionClauseSyntax)
            {
                ExpressionSyntax expression = executable switch
                {
                    EqualsValueClauseSyntax initializer => initializer.Value,
                    ArrowExpressionClauseSyntax arrow => arrow.Expression,
                    _ => throw new InvalidOperationException(),
                };
                IOperation operation = this.context.SemanticModel.GetOperation(expression);
                while (operation?.Parent != null)
                {
                    operation = operation.Parent;
                }

                return operation switch
                {
                    IBlockOperation block =>
                        Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph.Create(block),
                    IFieldInitializerOperation field =>
                        Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph.Create(field),
                    IPropertyInitializerOperation property =>
                        Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph.Create(property),
                    IMethodBodyOperation body =>
                        Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph.Create(body),
                    _ => throw new ArgumentException(
                        "The expression does not have a control-flow root.",
                        nameof(executable)),
                };
            }

            if (executable is PrimaryConstructorBaseTypeSyntax primaryBase)
            {
                ExpressionSyntax expression =
                    primaryBase.ArgumentList.Arguments.First().Expression;
                IOperation operation = this.context.SemanticModel.GetOperation(expression);
                while (operation?.Parent != null)
                {
                    operation = operation.Parent;
                }

                return operation switch
                {
                    IConstructorBodyOperation body =>
                        Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph.Create(body),
                    IBlockOperation block =>
                        Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph.Create(block),
                    _ => throw new ArgumentException(
                        "The base initializer does not have a control-flow root.",
                        nameof(executable)),
                };
            }

            return Microsoft.CodeAnalysis.FlowAnalysis.ControlFlowGraph.Create(
                executable,
                this.context.SemanticModel);
        }

        private static SyntaxNode FindEnclosingExecutable(SyntaxNode nested) =>
            nested.Ancestors().First(node =>
                (node is BaseMethodDeclarationSyntax
                        or AccessorDeclarationSyntax
                        or LocalFunctionStatementSyntax
                        or AnonymousFunctionExpressionSyntax
                        or CompilationUnitSyntax)
                    || node is PrimaryConstructorBaseTypeSyntax
                    || (node is ArrowExpressionClauseSyntax arrow
                        && arrow.Parent is PropertyDeclarationSyntax
                            or IndexerDeclarationSyntax)
                    || (node is EqualsValueClauseSyntax initializer
                        && (initializer.Parent is PropertyDeclarationSyntax
                            || initializer.Parent?.Parent?.Parent
                                is FieldDeclarationSyntax)));

        private void ApplyReachingOperation(
            IOperation operation,
            SyntaxNode declaration,
            ExpressionSyntax initializer,
            ILocalSymbol local,
            HashSet<ExpressionSyntax> values,
            Dictionary<AssignmentExpressionSyntax, ExpressionSyntax> assignedValues,
            Dictionary<
                (string Write, string Previous),
                ExpressionSyntax>
                elementAssignedValues,
            HashSet<ISymbol> visited,
            ExpressionSyntax unknownTuple,
            bool preserveDelegateCompoundAssignments,
            int beforePosition = int.MaxValue)
        {
            if (declaration.SpanStart < beforePosition
                && operation.Syntax.FullSpan.Contains(declaration.Span))
            {
                values.Clear();
                if (initializer != null)
                {
                    values.Add(initializer);
                }
            }

            foreach (SyntaxNode writeNode in EagerExecutionNodes(operation.Syntax)
                .Where(node => ReachingWritePosition(node) <= beforePosition)
                .Where(node => node is AssignmentExpressionSyntax
                    || this.ReachingWriteTargetsLocal(node, local))
                .OrderBy(ReachingWritePosition)
                .ThenBy(node => node.SpanStart))
            {
                if (local.RefKind != RefKind.None
                    && (writeNode is not AssignmentExpressionSyntax refAssignment
                        || !this.BindsTo(refAssignment.Left, local)
                        || refAssignment.Right is not RefExpressionSyntax))
                {
                    continue;
                }

                var elementWrites =
                    new List<(IReadOnlyList<int> Path, ExpressionSyntax Value)>();
                if (writeNode is ArgumentSyntax argument
                    && this.TryFindTupleElementWritePath(
                        argument.Expression,
                        local,
                        new List<int>(),
                        out IReadOnlyList<int> argumentPath))
                {
                    elementWrites.Add((
                        argumentPath,
                        SyntaxFactory.IdentifierName("__unknown")));
                }

                if (writeNode is not AssignmentExpressionSyntax assignment)
                {
                    if (elementWrites.Count > 0)
                    {
                        // Roslyn yields concrete nodes; self-migration imports LINQ elements as platform-typed.
                        this.ApplyTupleElementWrites(
                            writeNode!,
                            elementWrites,
                            local,
                            values,
                            elementAssignedValues,
                            visited,
                            unknownTuple);
                        continue;
                    }

                    if (writeNode is ArgumentSyntax refOrOutArgument)
                    {
                        if (!refOrOutArgument.RefOrOutKeyword.IsKind(
                            SyntaxKind.RefKeyword))
                        {
                            values.Clear();
                        }

                        values.Add(unknownTuple);
                        continue;
                    }

                    if (writeNode is RefExpressionSyntax)
                    {
                        continue;
                    }

                    values.Clear();
                    continue;
                }

                this.CollectTupleElementWrites(
                    assignment.Left,
                    assignment.Right,
                    local,
                    elementWrites);
                if (!elementWrites.Any(write => write.Path.Count > 0))
                {
                    elementWrites.Clear();
                }

                if (elementWrites.Count > 0)
                {
                    // Roslyn yields concrete nodes; self-migration imports LINQ elements as platform-typed.
                    this.ApplyTupleElementWrites(
                        writeNode!,
                        elementWrites,
                        local,
                        values,
                        elementAssignedValues,
                        visited,
                        unknownTuple);

                    continue;
                }

                if (!TryFindAssignedValuePath(
                    assignment.Left,
                    local,
                    new List<int>(),
                    out IReadOnlyList<int> path))
                {
                    continue;
                }

                bool preserveExistingValues =
                    preserveDelegateCompoundAssignments
                        && (assignment.IsKind(SyntaxKind.AddAssignmentExpression)
                            || assignment.IsKind(
                                SyntaxKind.SubtractAssignmentExpression));
                if (!preserveExistingValues)
                {
                    values.Clear();
                }

                if (!assignedValues.TryGetValue(assignment, out ExpressionSyntax value))
                {
                    var aliasPath = visited == null
                        ? null
                        : new HashSet<ISymbol>(visited, SymbolEqualityComparer.Default);
                    ExpressionSyntax source =
                        this.ResolveStableTupleAlias(assignment.Right, aliasPath)
                            ?? assignment.Right;
                    value = ProjectTupleElement(source, path);
                    assignedValues.Add(assignment, value);
                }

                if (preserveDelegateCompoundAssignments
                    && assignment.IsKind(SyntaxKind.SubtractAssignmentExpression))
                {
                    bool priorAddition = FindEnclosingExecutable(assignment)
                        .DescendantNodes()
                        .OfType<AssignmentExpressionSyntax>()
                        .Any(candidate =>
                            candidate.SpanStart < assignment.SpanStart
                                && candidate.IsKind(
                                    SyntaxKind.AddAssignmentExpression)
                                && this.BindsTo(candidate.Left, local));
                    if (!priorAddition && values.Count == 1)
                    {
                        ExpressionSyntax existing =
                            this.ResolveStableTupleAlias(values.Single())
                                ?? values.Single();
                        if (SyntaxFactory.AreEquivalent(existing, value))
                        {
                            values.Clear();
                        }
                    }

                    continue;
                }

                values.Add(value);
            }
        }

        private static int ReachingWritePosition(SyntaxNode node) =>
            node is ArgumentSyntax
            { RefOrOutKeyword.RawKind: not (int)SyntaxKind.None } argument
                ? argument.Parent?.Parent?.Span.End ?? argument.Span.End
                : node.Span.End;

        private bool ReachingWriteTargetsLocal(SyntaxNode node, ILocalSymbol local)
        {
            if (node is ArgumentSyntax
                { RefOrOutKeyword.RawKind: (int)SyntaxKind.InKeyword })
            {
                return false;
            }

            if (this.SyntaxNodeWritesSymbol(node, local))
            {
                return true;
            }

            return node is ArgumentSyntax
            { RefOrOutKeyword.RawKind: not (int)SyntaxKind.None } argument
                && (this.ReachingBindsTo(argument.Expression, local)
                    || this.TryFindTupleElementWritePath(
                        argument.Expression,
                        local,
                        new List<int>(),
                        out _));
        }

        private void ApplyTupleElementWrites(
            SyntaxNode writeNode,
            IReadOnlyList<(IReadOnlyList<int> Path, ExpressionSyntax Value)> writes,
            ILocalSymbol local,
            HashSet<ExpressionSyntax> values,
            Dictionary<(string Write, string Previous), ExpressionSyntax>
                elementAssignedValues,
            HashSet<ISymbol> visited,
            ExpressionSyntax unknownTuple)
        {
            for (int writeOrdinal = 0; writeOrdinal < writes.Count; writeOrdinal++)
            {
                var elementWrite = writes[writeOrdinal];
                IReadOnlyList<int> elementPath = elementWrite.Path;
                ExpressionSyntax writtenValue = elementWrite.Value;
                string write = writeNode.SpanStart
                    + ":"
                    + string.Join(".", elementPath)
                    + ":"
                    + writeOrdinal;
                var aliasPath = visited == null
                    ? null
                    : new HashSet<ISymbol>(
                        visited,
                        SymbolEqualityComparer.Default);
                ExpressionSyntax source = this.ResolveStableTupleAlias(
                    writtenValue,
                    aliasPath) ?? writtenValue;
                if (elementPath.Count == 0)
                {
                    values.Clear();
                    values.Add(source);
                    continue;
                }

                ExpressionSyntax[] previousValues = values.ToArray();
                if (previousValues.Length == 0)
                {
                    previousValues = new[] { unknownTuple };
                }

                values.Clear();
                if (writeNode is ArgumentSyntax
                    { RefOrOutKeyword.RawKind: (int)SyntaxKind.RefKeyword })
                {
                    values.UnionWith(previousValues);
                }

                foreach (ExpressionSyntax previous in previousValues)
                {
                    var key = (write, TupleReachingStateKey(previous));
                    if (!elementAssignedValues.TryGetValue(
                        key,
                        out ExpressionSyntax updated))
                    {
                        updated = this.ReplaceTupleElement(
                            previous,
                            local.Type,
                            elementPath,
                            0,
                            source);
                        elementAssignedValues.Add(key, updated);
                    }

                    values.Add(updated);
                }
            }
        }

        private static ExpressionSyntax CreateUnknownTuple(ITypeSymbol type)
        {
            if (type is not INamedTypeSymbol { IsTupleType: true } tuple)
            {
                return SyntaxFactory.IdentifierName("__unknown");
            }

            return SyntaxFactory.TupleExpression(SyntaxFactory.SeparatedList(
                tuple.TupleElements.Select(element => SyntaxFactory.Argument(
                    CreateUnknownTuple(element.Type)))));
        }

        private void CollectTupleElementWrites(
            ExpressionSyntax left,
            ExpressionSyntax right,
            ILocalSymbol local,
            List<(IReadOnlyList<int> Path, ExpressionSyntax Value)> writes,
            bool includeWholeTuple = false)
        {
            left = Unwrap(left);
            if (includeWholeTuple && this.ReachingBindsTo(left, local))
            {
                writes.Add((Array.Empty<int>(), right));
                return;
            }

            if (this.TryFindTupleElementWritePath(
                left,
                local,
                new List<int>(),
                out IReadOnlyList<int> path))
            {
                writes.Add((path, right));
                return;
            }

            if (left is not TupleExpressionSyntax tuple)
            {
                return;
            }

            for (int i = 0; i < tuple.Arguments.Count; i++)
            {
                this.CollectTupleElementWrites(
                    tuple.Arguments[i].Expression,
                    ProjectTupleElement(right, new[] { i }),
                    local,
                    writes,
                    includeWholeTuple: true);
            }
        }

        private bool TryFindTupleElementWritePath(
            ExpressionSyntax expression,
            ILocalSymbol local,
            List<int> path,
            out IReadOnlyList<int> found)
        {
            expression = Unwrap(expression);
            if (this.ReachingBindsTo(expression, local))
            {
                found = new List<int>(path);
                return path.Count > 0;
            }

            foreach (ExpressionSyntax aliasTarget
                in this.GetRefAliasTargets(expression))
            {
                if (this.TryFindTupleElementWritePath(
                    aliasTarget,
                    local,
                    path,
                    out found))
                {
                    return true;
                }
            }

            if (expression is MemberAccessExpressionSyntax member
                && this.context.GetTypeInfo(member.Expression).Type
                    is INamedTypeSymbol { IsTupleType: true } tupleType
                && this.context.GetSymbolInfo(member.Name).Symbol is IFieldSymbol field)
            {
                int index = TupleElementIndex(tupleType, field);
                if (index >= 0)
                {
                    path.Insert(0, index);
                    if (this.TryFindTupleElementWritePath(
                        member.Expression,
                        local,
                        path,
                        out found))
                    {
                        return true;
                    }

                    path.RemoveAt(0);
                }
            }

            found = null;
            return false;
        }

        private static int TupleElementIndex(
            INamedTypeSymbol tupleType,
            IFieldSymbol field)
        {
            IFieldSymbol canonical = field.CorrespondingTupleField ?? field;
            for (int i = 0; i < tupleType.TupleElements.Length; i++)
            {
                IFieldSymbol candidate =
                    tupleType.TupleElements[i].CorrespondingTupleField
                    ?? tupleType.TupleElements[i];
                if (SymbolEqualityComparer.Default.Equals(candidate, canonical)
                    || tupleType.TupleElements[i].Name == field.Name)
                {
                    return i;
                }
            }

            return -1;
        }

        private ExpressionSyntax ReplaceTupleElement(
            ExpressionSyntax expression,
            ITypeSymbol type,
            IReadOnlyList<int> path,
            int depth,
            ExpressionSyntax replacement)
        {
            if (depth == path.Count)
            {
                return this.PreserveReachingTupleProjection(
                    replacement,
                    Array.Empty<int>());
            }

            if (type is not INamedTypeSymbol { IsTupleType: true } tupleType)
            {
                return expression;
            }

            int replacedIndex = path[depth];
            return SyntaxFactory.TupleExpression(SyntaxFactory.SeparatedList(
                tupleType.TupleElements.Select((element, index) =>
                {
                    ExpressionSyntax projected = this.PreserveReachingTupleProjection(
                        expression,
                        new[] { index });
                    return SyntaxFactory.Argument(index == replacedIndex
                        ? this.ReplaceTupleElement(
                            projected,
                            element.Type,
                            path,
                            depth + 1,
                            replacement)
                        : projected);
                })));
        }

        private ExpressionSyntax PreserveReachingTupleProjection(
            ExpressionSyntax source,
            IReadOnlyList<int> path)
        {
            ExpressionSyntax projected = ProjectTupleElement(source, path);
            if (projected.GetAnnotations(ReachingTupleProjectionAnnotation).Any())
            {
                return projected;
            }

            ExpressionSyntax origin = source;
            SyntaxAnnotation annotation =
                source.GetAnnotations(ReachingTupleProjectionAnnotation).FirstOrDefault();
            if (annotation != null
                && this.reachingTupleProjections.TryGetValue(
                    annotation.Data,
                    out var sourceProjection))
            {
                origin = sourceProjection.Source;
                path = sourceProjection.Path.Concat(path).ToArray();
            }
            else if (source.SyntaxTree != this.context.SemanticModel.SyntaxTree)
            {
                return projected;
            }

            string data = origin.SpanStart.ToString(CultureInfo.InvariantCulture)
                + ":"
                + origin.Span.Length.ToString(CultureInfo.InvariantCulture)
                + ":"
                + string.Join(".", path);
            this.reachingTupleProjections.TryAdd(data, (origin, path));
            return projected.WithAdditionalAnnotations(
                new SyntaxAnnotation(ReachingTupleProjectionAnnotation, data));
        }

        private bool TryGetReachingTupleProjection(
            ExpressionSyntax expression,
            out ExpressionSyntax source,
            out IReadOnlyList<int> path)
        {
            SyntaxAnnotation annotation =
                expression.GetAnnotations(ReachingTupleProjectionAnnotation)
                    .FirstOrDefault();
            if (annotation == null
                || !this.reachingTupleProjections.TryGetValue(
                    annotation.Data,
                    out var projection))
            {
                source = null;
                path = null;
                return false;
            }

            source = projection.Source;
            path = projection.Path;
            return true;
        }

        private static string TupleReachingStateKey(ExpressionSyntax expression)
        {
            IEnumerable<string> projections = expression.DescendantNodesAndSelf()
                .SelectMany(node =>
                    node.GetAnnotations(ReachingTupleProjectionAnnotation))
                .Select(annotation => annotation.Data);
            IEnumerable<string> sourceNodes = expression.DescendantNodesAndSelf()
                .Where(node => node.SyntaxTree != null)
                .Select(node =>
                    node.RawKind.ToString(CultureInfo.InvariantCulture)
                    + ":"
                    + node.SpanStart.ToString(CultureInfo.InvariantCulture)
                    + ":"
                    + node.Span.Length.ToString(CultureInfo.InvariantCulture));
            return expression
                + "|"
                + string.Join(";", sourceNodes)
                + "|"
                + string.Join(";", projections);
        }

        private bool TryFindAssignedValuePath(
            ExpressionSyntax left,
            ILocalSymbol local,
            List<int> path,
            out IReadOnlyList<int> found)
        {
            left = Unwrap(left);
            if (this.ReachingBindsTo(left, local))
            {
                found = new List<int>(path);
                return true;
            }

            foreach (ExpressionSyntax aliasTarget in this.GetRefAliasTargets(left))
            {
                if (this.TryFindAssignedValuePath(
                    aliasTarget,
                    local,
                    path,
                    out found))
                {
                    return true;
                }
            }

            if (left is DeclarationExpressionSyntax declaration)
            {
                return this.TryFindAssignedValuePath(
                    declaration.Designation,
                    local,
                    path,
                    out found);
            }

            if (left is TupleExpressionSyntax tuple)
            {
                for (int i = tuple.Arguments.Count - 1; i >= 0; i--)
                {
                    path.Add(i);
                    if (this.TryFindAssignedValuePath(
                        tuple.Arguments[i].Expression,
                        local,
                        path,
                        out found))
                    {
                        return true;
                    }

                    path.RemoveAt(path.Count - 1);
                }
            }

            found = null;
            return false;
        }

        private bool ReachingBindsTo(
            ExpressionSyntax expression,
            ILocalSymbol local,
            HashSet<ISymbol> visited = null)
        {
            expression = Unwrap(expression);
            if (this.BindsTo(expression, local))
            {
                return true;
            }

            visited ??= new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            return this.GetRefAliasTargets(expression, visited)
                .Any(aliasTarget =>
                    this.ReachingBindsTo(aliasTarget, local, visited));
        }

        private IEnumerable<ExpressionSyntax> GetRefAliasTargets(
            ExpressionSyntax expression,
            HashSet<ISymbol> visited = null)
        {
            if (expression.SyntaxTree != this.context.SemanticModel.SyntaxTree
                || this.context.GetSymbolInfo(expression).Symbol
                    is not ILocalSymbol alias
                || alias.RefKind == RefKind.None
                || (visited != null && !visited.Add(alias)))
            {
                return Array.Empty<ExpressionSyntax>();
            }

            HashSet<ISymbol> reachingVisited = visited == null
                ? null
                : new HashSet<ISymbol>(
                    visited,
                    SymbolEqualityComparer.Default);
            return this.GetReachingLocalValues(
                    alias,
                    expression.SpanStart,
                    reachingVisited)
                .OfType<RefExpressionSyntax>()
                .Select(target => target.Expression)
                .ToList();
        }

        private bool TryFindAssignedValuePath(
            VariableDesignationSyntax designation,
            ILocalSymbol local,
            List<int> path,
            out IReadOnlyList<int> found)
        {
            if (designation is SingleVariableDesignationSyntax single
                && SymbolEqualityComparer.Default.Equals(
                    this.context.SemanticModel.GetDeclaredSymbol(single),
                    local))
            {
                found = new List<int>(path);
                return true;
            }

            if (designation is ParenthesizedVariableDesignationSyntax tuple)
            {
                for (int i = tuple.Variables.Count - 1; i >= 0; i--)
                {
                    path.Add(i);
                    if (this.TryFindAssignedValuePath(
                        tuple.Variables[i],
                        local,
                        path,
                        out found))
                    {
                        return true;
                    }

                    path.RemoveAt(path.Count - 1);
                }
            }

            found = null;
            return false;
        }

        private ExpressionSyntax UnwrapTuplePreservingCasts(ExpressionSyntax expression)
        {
            expression = Unwrap(expression);
            while (this.context.GetTypeInfo(expression).Type is { IsTupleType: true })
            {
                if (expression is CastExpressionSyntax cast)
                {
                    expression = Unwrap(cast.Expression);
                    continue;
                }

                if (expression is PostfixUnaryExpressionSyntax suppression
                    && suppression.IsKind(SyntaxKind.SuppressNullableWarningExpression))
                {
                    expression = Unwrap(suppression.Operand);
                    continue;
                }

                break;
            }

            return expression;
        }

        /// <summary>
        /// Translates every declarator of a ref-local declaration (<c>ref int r =
        /// ref xs[1];</c>, issue #1900) into G#'s native ref-aliasing local
        /// (<c>let ref name T = lvalue</c> / <c>var ref name T = lvalue</c>,
        /// issue #491/ADR-0060 §follow-up). Unlike C#, the RHS carries no second
        /// `ref` keyword — the `ref` modifier on the binding itself is what marks
        /// the local as an alias. Reads and writes of the local afterward are
        /// ordinary identifier references; gsc routes them through the alias
        /// transparently, so — unlike a hand-rolled pointer lowering — no
        /// rewriting of later usages is needed here.
        /// </summary>
        private IEnumerable<GStatement> TranslateRefLocalDeclaration(VariableDeclarationSyntax declaration)
        {
            var results = new List<GStatement>();

            foreach (VariableDeclaratorSyntax declarator in declaration.Variables)
            {
                if (this.context.GetDeclaredSymbol(declarator) is not ILocalSymbol localSymbol)
                {
                    continue;
                }

                string name = this.EmittedName(localSymbol, declarator.Identifier.ValueText);

                GExpression initializer = declarator.Initializer?.Value is RefExpressionSyntax refInit
                    ? this.TranslateRefExpression(refInit)
                    : null;

                if (initializer == null)
                {
                    string message = $"ref local '{declarator.Identifier.Text}' has no `ref` initializer expression; a ref local must be aliased at declaration (issue #1900).";
                    this.context.ReportUnsupported(declarator, message);
                    continue;
                }

                GTypeReference pointeeType = this.typeMapper.Map(localSymbol.Type, this.context, declaration.Type.GetLocation());

                // The alias is written through by a plain `name = value` in the
                // original C# (e.g. `r = 20;`) exactly like a normal local, so the
                // existing reassignment heuristic decides `let ref` vs `var ref`
                // the same way it decides `let` vs `var` for any other local.
                BindingKind binding = this.IsLocalReassigned(localSymbol) ? BindingKind.Var : BindingKind.Let;

                results.Add(new LocalDeclarationStatement(
                    binding,
                    name,
                    pointeeType,
                    initializer,
                    isRefAlias: true,
                    isReadOnlyRefAlias: localSymbol.RefKind == RefKind.RefReadOnly));
            }

            return results;
        }

        /// <summary>
        /// Translates a C# binary expression, inserting an explicit numeric
        /// conversion when C#'s implicit numeric promotion bridged two operands of
        /// different numeric types. G# has no implicit cross-type numeric promotion:
        /// an operator such as <c>==</c>/<c>&lt;</c>/<c>+</c> is per-primitive-type,
        /// so <c>uint16 == int32</c> (and the lifted <c>uint16? == int32</c>) is
        /// <c>GS0129</c>. The faithful fix mirrors C#: when one operand is a constant
        /// literal, retype the literal to the other operand's G# type; otherwise
        /// convert each C#-promoted operand to the common (promoted) type.
        /// </summary>
        private GExpression TranslateBinaryExpression(BinaryExpressionSyntax binary)
        {
            // ADR-0169 analyzer mode: the assignment-LHS conjunction idiom
            // rewrites to a write-node parent-kind check; standalone
            // comparisons against Roslyn members with no G# counterpart lower
            // to a boolean constant. Both carry CS2GS-ANALYZER-SHAPE review
            // warnings.
            if (this.InAnalyzerApiMode && this.TryLowerAssignmentLeftConjunction(binary, out GExpression loweredConjunction))
            {
                return loweredConjunction;
            }

            if (this.InAnalyzerApiMode && this.TryLowerAnalyzerComparison(binary, out GExpression loweredComparison))
            {
                return loweredComparison;
            }

            if (binary.IsKind(SyntaxKind.LogicalAndExpression)
                && !this.ConditionUsesNativePatternVariables(GetConditionRoot(binary))
                && this.TryTranslateIfLetBooleanExpression(binary, out GExpression ifLet))
            {
                return ifLet;
            }

            // ADR-0159 / issue #3501: C# guards a `params` array against an
            // explicit null argument (`args != null`), but a G# variadic
            // parameter always materializes an array, so gsc rejects the
            // always-decided nil compare (GS0523). Fold the test to its
            // constant value; the `&&`/`||` simplification below then absorbs
            // it so no literal `true &&` survives in the output.
            if (this.TryFoldParamsArrayNullCheck(binary, out GExpression foldedParamsCheck))
            {
                return foldedParamsCheck;
            }

            GExpression left = this.TranslateExpression(binary.Left);
            string op = binary.OperatorToken.Text;
            GExpression right = this.TranslateBinaryRightOperand(binary);

            if (op == "&&" && left is LiteralExpression { Kind: LiteralKind.Bool, Value: "true" })
            {
                return right;
            }

            if (op == "||" && left is LiteralExpression { Kind: LiteralKind.Bool, Value: "false" })
            {
                return right;
            }

            // C# string concatenation `a + b`: gsc handles char operands
            // natively. Other non-string operands still need an explicit
            // `ToString()` because G# does not expose C#'s string + object arms.
            if (binary.IsKind(SyntaxKind.AddExpression)
                && this.context.GetTypeInfo(binary).Type?.SpecialType == SpecialType.System_String)
            {
                left = this.CoerceConcatOperand(binary.Left, left);
                right = this.CoerceConcatOperand(binary.Right, right);
                return new BinaryExpression(left, op, right);
            }

            // C# null-coalescing `a ?? b`: the left is a nullable numeric, the
            // right must match the left's *underlying* (non-nullable) numeric type
            // (a `??` is not a symmetric arithmetic promotion of both sides). Only
            // apply this when both sides are numeric; mixed reference cases such as
            // `Task<T>? ?? Task` flow through unchanged.
            if (op == "??")
            {
                return this.TranslateNullCoalescing(binary, left, right);
            }

            // Issue #1232: G# now matches C#'s shift-count ergonomics — gsc
            // implicitly widens a narrower-order integer shift count to int32 —
            // so `<<` / `>>` translate straight through with no count coercion.
            // (`<<` / `>>` are not numeric-promotion operators, so they fall
            // through to the plain binary form below.)
            //
            // Issue #4116: that reasoning covers the shift COUNT (the right
            // operand) but not the shifted VALUE (the left operand). C# binary
            // numeric promotion (§12.4.7) ALSO promotes a `sbyte`/`byte`/
            // `short`/`ushort`/`char` left operand of `<<`/`>>`/`>>>` to `int`,
            // unconditionally — independent of, and unrelated to, the right
            // operand's own (separate) conversion to `int`. G#'s own shift
            // operators deliberately do NOT do this for non-`char` integral
            // types (gsc issue #2227 special-cased only `char`): `uint8 << n`
            // stays `uint8`-typed, so a narrower left operand silently drops
            // every bit shifted past its own width instead of promoting first.
            // Left un-widened, a translated `byteValue << 24` collapses to 0
            // instead of the C# value, corrupting anything built by OR-ing
            // shifted bytes back together (issue #4116's metadata-token-decode
            // failures). Widen ONLY the left operand here to the type Roslyn
            // says C# actually promoted it to; the right operand is handled by
            // #1232 above and must not be coerced to the (unrelated) left type.
            if (binary.IsKind(SyntaxKind.LeftShiftExpression)
                || binary.IsKind(SyntaxKind.RightShiftExpression)
                || binary.IsKind(SyntaxKind.UnsignedRightShiftExpression))
            {
                ITypeSymbol shiftLeftType = this.context.GetTypeInfo(binary.Left).Type;
                ITypeSymbol shiftLeftConverted = this.context.GetTypeInfo(binary.Left).ConvertedType;
                if (TryGetNumericKind(shiftLeftType, out SpecialType shiftLeftUnderlying) &&
                    TryGetNumericKind(shiftLeftConverted, out SpecialType shiftLeftConvUnderlying) &&
                    shiftLeftUnderlying != shiftLeftConvUnderlying)
                {
                    left = this.CoerceOperandTo(left, shiftLeftConverted, binary.Left.GetLocation());
                }

                return new BinaryExpression(left, op, right);
            }

            if (!IsNumericPromotionOperator(op))
            {
                return new BinaryExpression(left, op, right);
            }

            ITypeSymbol leftType = this.context.GetTypeInfo(binary.Left).Type;
            ITypeSymbol rightType = this.context.GetTypeInfo(binary.Right).Type;

            if (!TryGetNumericKind(leftType, out SpecialType leftUnderlying) ||
                !TryGetNumericKind(rightType, out SpecialType rightUnderlying))
            {
                return new BinaryExpression(left, op, right);
            }

            // Operand types already share an underlying numeric type (only the
            // nullability may differ, e.g. `int32? == 2`); G# accepts those directly,
            // so leave the expression untouched.
            if (leftUnderlying == rightUnderlying)
            {
                return new BinaryExpression(left, op, right);
            }

            bool leftConst = this.context.SemanticModel.GetConstantValue(binary.Left).HasValue;
            bool rightConst = this.context.SemanticModel.GetConstantValue(binary.Right).HasValue;

            // Prefer the minimal, faithful form: a constant expression is retyped to
            // the other (non-constant) operand's G# type so both operands share a
            // type (e.g. `channelCount == (2 as uint16?)`). This mirrors C#'s
            // constant-expression narrowing conversions (C# §10.2.11), which are
            // defined ONLY between integral types (int/long constants narrowing to
            // a smaller/differently-signed integral type) — never between a
            // floating-point/decimal type and an integral type. Issue #2352: a
            // `double`/`float`/`decimal` constant (including one folded from a
            // compile-time-constant sub-expression, e.g. `1.0 * 2.0`) must NEVER be
            // narrowed down to the other operand's integral type this way — nor may
            // a floating-point/decimal non-constant operand's declared type be used
            // to narrow an integral constant, since C# binary numeric promotion
            // always widens the integral side to match float/double/decimal,
            // regardless of which side happens to be a constant. Restricting this
            // branch to "both operands are integral" routes every
            // floating-point/decimal combination through the converted-type-driven
            // logic below instead, which always follows Roslyn's own promotion
            // direction.
            bool leftIsIntegral = IsIntegralNumericKind(leftUnderlying);
            bool rightIsIntegral = IsIntegralNumericKind(rightUnderlying);

            // Issue #4350: retyping the constant is faithful for a comparison
            // (the result is `bool` either way), but NOT for an arithmetic or
            // bitwise operator whose C# operation type is the constant's own
            // wider type: `2L * capacity` multiplies in `long`, so narrowing the
            // literal to `int32(2L)` would silently change it into an `int`
            // multiplication that overflows. Those operators take the
            // converted-type path below, which widens the non-constant side.
            bool isComparison = IsComparisonOperator(op);

            // Issue #4350 (review): a shift is typed by its LEFT operand alone and
            // its count is always `int`, so neither side's constant is retyped to
            // the other's type — `2L << count` stays a `long` shift. Roslyn's
            // converted types below already describe the shift faithfully.
            bool isShift = op is "<<" or ">>" or ">>>";

            if (!isShift
                && rightConst
                && !leftConst
                && leftIsIntegral
                && rightIsIntegral
                && (isComparison || !this.OperandWidenedToConstantType(binary.Left, rightUnderlying))
                && this.IntegralConstantFits(binary.Right, leftUnderlying))
            {
                right = this.CoerceOperandTo(
                    right,
                    leftType,
                    binary.Right.GetLocation());
                return new BinaryExpression(left, op, right);
            }

            if (!isShift
                && leftConst
                && !rightConst
                && leftIsIntegral
                && rightIsIntegral
                && (isComparison || !this.OperandWidenedToConstantType(binary.Right, leftUnderlying))
                && this.IntegralConstantFits(binary.Left, rightUnderlying))
            {
                left = this.CoerceOperandTo(
                    left,
                    rightType,
                    binary.Left.GetLocation());
                return new BinaryExpression(left, op, right);
            }

            // Neither (or both) operand is a constant expression, or one side is a
            // floating-point/decimal type: convert each operand that C# promoted
            // (its declared type differs from the common converted type) to that
            // common type. Roslyn's `ConvertedType` always reflects the correct C#
            // binary numeric promotion direction here — including widening an
            // integral non-constant operand up to a constant's floating-point type
            // (issue #2352) — independent of which side is a compile-time constant.
            ITypeSymbol leftConverted = this.context.GetTypeInfo(binary.Left).ConvertedType;
            ITypeSymbol rightConverted = this.context.GetTypeInfo(binary.Right).ConvertedType;

            if (TryGetNumericKind(leftConverted, out SpecialType leftConvUnderlying) &&
                leftConvUnderlying != leftUnderlying)
            {
                left = this.CoerceOperandTo(
                    left,
                    leftConverted,
                    binary.Left.GetLocation());
            }

            if (TryGetNumericKind(rightConverted, out SpecialType rightConvUnderlying) &&
                rightConvUnderlying != rightUnderlying)
            {
                right = this.CoerceOperandTo(
                    right,
                    rightConverted,
                    binary.Right.GetLocation());
            }

            return new BinaryExpression(left, op, right);
        }

        // Issue #4350: whether C# binary numeric promotion widened the
        // non-constant operand to the constant's own type, i.e. the operation
        // itself runs in the constant's (wider) type.
        private bool OperandWidenedToConstantType(ExpressionSyntax nonConstant, SpecialType constantUnderlying)
        {
            TypeInfo info = this.context.GetTypeInfo(nonConstant);
            return TryGetNumericKind(info.Type, out SpecialType own)
                && TryGetNumericKind(info.ConvertedType, out SpecialType converted)
                && own != converted
                && converted == constantUnderlying;
        }

        private static bool IsComparisonOperator(string op) =>
            op is "==" or "!=" or "<" or "<=" or ">" or ">=";

        private GExpression TranslateBinaryRightOperand(BinaryExpressionSyntax binary)
        {
            // A fallback pattern in a right operand may spill its scrutinee.
            // A deconstruction assignment also needs statements. Host either in
            // the operand itself so `&&`/`||`/`??` still decide whether it runs.
            if (!IsShortCircuitOperator(binary)
                || (!this.RequiresLocalAssignmentSeam(binary.Right)
                    && (this.state.PendingSpillPrologue == null
                        || !this.ContainsFallbackPatternSpill(binary.Right))))
            {
                return this.TranslateExpression(binary.Right);
            }

            List<GStatement> previousDeclarations = this.state.ShortCircuitSpillDeclarations;
            SyntaxNode previousScope = this.state.ShortCircuitSpillScope;
            this.state.ShortCircuitSpillDeclarations ??= this.state.PendingSpillPrologue;
            this.state.ShortCircuitSpillScope ??= binary.Right;
            try
            {
                return this.TranslateWithLocalAssignmentSeam(
                    binary.Right,
                    () => this.TranslateExpression(binary.Right));
            }
            finally
            {
                this.state.ShortCircuitSpillDeclarations = previousDeclarations;
                this.state.ShortCircuitSpillScope = previousScope;
            }
        }

        private static bool IsShortCircuitOperator(BinaryExpressionSyntax binary) =>
            binary.IsKind(SyntaxKind.LogicalAndExpression)
            || binary.IsKind(SyntaxKind.LogicalOrExpression)
            || binary.IsKind(SyntaxKind.CoalesceExpression);

        private bool ContainsFallbackPatternSpill(ExpressionSyntax expression)
        {
            foreach (IsPatternExpressionSyntax isPattern in expression
                .DescendantNodesAndSelf(
                    descendIntoChildren: node =>
                        node is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
                .OfType<IsPatternExpressionSyntax>())
            {
                if (!PatternReadsScrutineeAtMostOnce(isPattern.Pattern)
                    && !this.PatternReceiverTranslatesToTrivialOperand(isPattern.Expression)
                    && !this.ConditionUsesNativePatternVariables(GetConditionRoot(isPattern)))
                {
                    return true;
                }
            }

            return false;
        }

        private bool PatternReceiverTranslatesToTrivialOperand(ExpressionSyntax expression)
        {
            if (!IsTrivialPatternReceiver(expression))
            {
                return false;
            }

            // A bare identifier may become a member access through pattern-binding
            // substitution or implicit static qualification. Classify the emitted
            // shape so its spill stays behind earlier short-circuit guards.
            return IsTrivialOperand(this.TranslateExpression(Unparenthesize(expression)));
        }

        // For a string-concatenation `+` operand: if the operand's C# type is not
        // already `string` or `char`, wrap the translated operand in an explicit
        // `operand.ToString()` call. G# handles char concatenation natively. A
        // bare `null` literal is also unchanged (`null.ToString()` would throw).
        private GExpression CoerceConcatOperand(ExpressionSyntax operandSyntax, GExpression translated)
        {
            ITypeSymbol operandType = this.context.GetTypeInfo(operandSyntax).Type;
            SpecialType specialType = operandType?.SpecialType ?? SpecialType.None;
            if (specialType == SpecialType.System_String
                || specialType == SpecialType.System_Char)
            {
                return translated;
            }

            if (IsNullOrSuppressedNull(operandSyntax))
            {
                return translated;
            }

            GExpression receiver = translated is BinaryExpression or IfExpression || IsBareNumericLiteral(translated)
                ? new ParenthesizedExpression(translated)
                : translated;

            // Issue #4287: a NILABLE reference operand concatenates as the empty
            // string in C# (`"p:" + null` is "p:"), so the conversion is the
            // null-conditional `x?.ToString()`, whose `string?` result G#
            // concatenates the same way. `x.ToString()` was a call on a `T?`
            // receiver: gsc now reports it (GS0159), and it threw on nil
            // where C# did not. `?.` on a value that turns out non-null is
            // legal and costs one branch.
            if (this.ConcatOperandMayBeNilInEmittedGSharp(operandSyntax, operandType))
            {
                // Inside an expression-tree lambda `?.` is not available (gsc
                // rejects a null-conditional access there, GS0473), so use the
                // static `string.Concat(object?)`: null-as-empty like C#,
                // evaluates its operand once, and a plain static call is
                // representable in a tree (Copilot review).
                if (this.IsWithinExpressionTreeLambda(operandSyntax))
                {
                    ITypeSymbol stringType = this.context.Compilation.GetSpecialType(SpecialType.System_String);
                    return new InvocationExpression(
                        new MemberAccessExpression(
                            new TypeExpression(this.typeMapper.Map(stringType, this.context, operandSyntax.GetLocation())),
                            "Concat"),
                        new List<GExpression> { translated });
                }

                return new ConditionalAccessExpression(
                    receiver,
                    new InvocationExpression(new MemberAccessExpression(new ConditionalReceiverExpression(), "ToString")));
            }

            return new InvocationExpression(new MemberAccessExpression(receiver, "ToString"));
        }

        // Issue #4287: whether a string-concatenation operand may be `T?` in
        // the EMITTED G#, so its `ToString()` conversion must be null-safe.
        // Composed only from predicates cs2gs already uses for receivers and
        // values, so it cannot drift from what gsc imports as nilable:
        // - a C# `T?` reference declaration;
        // - a Roslyn member that is `T?` only on the G# analyzer API, whatever
        //   its C# shape (Roslyn's `SyntaxToken` is a struct, G#'s is a nilable
        //   class);
        // - anything the shared value and receiver predicates say gsc imports
        //   as nilable, such as `Array.GetValue` (annotated `object?`) called
        //   from an oblivious C# file, where Roslyn erases the annotation at
        //   the call site.
        // Plain equality rather than a property pattern over the Roslyn enum:
        // cs2gs translates its own source, and a pattern test against a Roslyn
        // enum constant does not survive that (issue #4167).
        private bool ConcatOperandMayBeNilInEmittedGSharp(ExpressionSyntax operandSyntax, ITypeSymbol operandType) =>
            (operandType != null
                && operandType.IsReferenceType
                && operandType.NullableAnnotation == NullableAnnotation.Annotated)
            || this.IsGSharpNullableAnalyzerExpression(operandSyntax)
            || this.NullableReferenceValueMayBeNull(operandSyntax)
            || this.ReceiverValueIsObliviouslyReadAnnotatedResult(operandSyntax)
            || this.ReceiverValueIsPromotedNullable(operandSyntax);

        // Issue #1960 item 2: true when `assignment` is a `+=`/`-=` whose LEFT
        // side is delegate-typed (TypeKind.Delegate covers both a named delegate
        // and Action/Func-shaped BCL delegates) but is NOT a declared C# event —
        // i.e. a raw delegate multicast combine/remove, which has no G# form.
        // A real event access (`obj.Ticked += handler`) resolves to an
        // IEventSymbol and is excluded so it keeps flowing through the normal
        // compound-assignment path (G#'s event-subscription `+=`/`-=`).
        private bool IsDelegateMulticastCombine(AssignmentExpressionSyntax assignment, out string op)
        {
            op = assignment.OperatorToken.Text;
            if (!assignment.IsKind(SyntaxKind.AddAssignmentExpression) &&
                !assignment.IsKind(SyntaxKind.SubtractAssignmentExpression))
            {
                return false;
            }

            if (this.context.GetSymbolInfo(assignment.Left).Symbol is IEventSymbol)
            {
                return false;
            }

            return this.context.GetTypeInfo(assignment.Left).Type?.TypeKind == TypeKind.Delegate;
        }

        // Issue #2259 (oblivious sink): an ELEMENT-access assignment target
        // (`arr[i] = …`, a `Dictionary`/user-indexer write, …) whose RHS is a
        // null-conditional access result (`x?[i]` / `x?.Member`) or any other
        // promoted-nullable value trips a `T? -> T` GS0156 once gsc's strict
        // nullability sees the RHS's true `T?` type. A field/property/local/
        // parameter assignment TARGET is instead widened to `T?` at its own
        // declaration by the whole-program taint analysis (see
        // ObliviousNullabilityAnalyzer's SimpleAssignmentExpression edge in
        // CollectEdges), but an element-access target has no single declaration
        // to widen — promoting the whole array/collection's element type would
        // ripple to every other read of it — so the minimal, generalized fix is
        // a `!!` assertion at the RHS use site instead, exactly like every other
        // promoted-nullable-into-non-nullable sink (return/argument/tuple/event).
        // Gated to an oblivious compilation and skipped when the resolved LHS
        // indexer is itself declared or promoted nullable (nothing to forgive),
        // so a nullable-enabled compilation and an already-nullable sink are
        // byte-identical.
        private GExpression ForgiveElementAccessAssignmentRhs(
            AssignmentExpressionSyntax assignment, GExpression translatedRhs)
        {
            if (!this.IsObliviousCompilation()
                || translatedRhs is NonNullAssertionExpression
                || IsNullOrSuppressedNull(assignment.Right)
                || !this.ElementAccessAssignmentRequiresNonNullReference(assignment)
                || !this.IsNullablePromotedValue(assignment.Right))
            {
                return translatedRhs;
            }

            return EnsureNonNullAssertion(translatedRhs);
        }

        // Issue #4211: the SINK half of the #2259 rule above, factored out so the
        // whole-RHS rule and its per-ARM sibling
        // (<see cref="IsNullableTaintedArmOfElementAccessAssignment"/>) share a
        // single definition of "this element-access write genuinely demands a
        // non-null reference": a SIMPLE assignment into an element-access target
        // whose own type is a non-annotated reference type and whose resolved
        // indexer (arrays resolve to no symbol at all) is not itself promoted to
        // `T?` by the taint fixpoint. An already-nullable sink has nothing to
        // forgive, and a compound assignment is a different shape entirely.
        private bool ElementAccessAssignmentRequiresNonNullReference(
            AssignmentExpressionSyntax assignment)
        {
            if (!assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                || assignment.Left is not ElementAccessExpressionSyntax)
            {
                return false;
            }

            ISymbol leftSymbol = this.context.GetSymbolInfo(assignment.Left).Symbol;
            ITypeSymbol leftType = this.GetAssignmentTargetType(assignment.Left, leftSymbol);
            if (leftType is not { IsReferenceType: true }
                || leftType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
            }

            return leftSymbol is not IPropertySymbol indexer
                || !this.ShouldPromoteToNullableReference(indexer);
        }

        // Issue #2427 (oblivious sink): a plain REASSIGNMENT (`path = (pathStub +
        // ext).AsUncIfLong();`, the exact Oahu.Core BookLibrary.gs:469 shape) to an
        // already-declared non-null local/parameter/field/property/indexer whose
        // RHS reads an oblivious EXTERNAL (metadata, no nullable context) member
        // trips the same `T? -> T` GS0156 that issue #2202's direct-return
        // forgiveness (`ReceiverNeedsNullForgiveness`) and issue #2425's
        // explicit-local-initializer forgiveness (`TranslateLocalDeclaration`)
        // already apply for THEIR OWN value-read shapes (`return
        // ext.Combine(...)`; `T x = ext.Combine(...);`) — gsc maps every such
        // oblivious external reference read to `T?` regardless of where the value
        // is consumed. Neither of those fixes reaches a subsequent bare assignment
        // STATEMENT: `TranslateExpressionStatement`'s assignment case translates
        // the RHS via plain `TranslateExpression` with no external-oblivious
        // forgiveness of its own. This reuses the SAME `IsImportedObliviousNullableMember`
        // detection those two fixes already use, applied at the assignment RHS use
        // site instead. Gated to a target whose OWN type is a non-annotated,
        // non-promoted reference type — i.e., one that genuinely expects
        // non-null — so a target that is itself declared/promoted nullable (which
        // already accepts a `T?` RHS unchanged) and a nullable-enabled compilation
        // (whose external annotations are real) are both left byte-identical.
        // Scoped to SIMPLE assignment: a compound assignment (`path +=
        // ext.Combine(...)`) is a distinct shape (its RHS also flows through
        // numeric-coercion logic) and is deliberately left untouched here.
        private GExpression ForgiveObliviousExternalAssignmentRhs(
            AssignmentExpressionSyntax assignment, GExpression translatedRhs)
        {
            if (!this.IsObliviousCompilation()
                || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                || translatedRhs is NonNullAssertionExpression
                || !this.IsImportedObliviousNullableMember(this.context.GetSymbolInfo(assignment.Right).Symbol)

                // ADR-0186 step 6 (PR 0): gsc checks a `T!` right-hand side.
                || this.PlatformTypedImportNeedsNoBridge(assignment.Right))
            {
                return translatedRhs;
            }

            ISymbol leftSymbol = this.context.GetSymbolInfo(assignment.Left).Symbol;
            ITypeSymbol leftType = this.GetAssignmentTargetType(assignment.Left, leftSymbol);
            if (leftType is not { IsReferenceType: true }
                || leftType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return translatedRhs;
            }

            if (leftSymbol != null && this.ShouldPromoteToNullableReference(leftSymbol))
            {
                return translatedRhs;
            }

            return EnsureNonNullAssertion(translatedRhs);
        }

        // For a compound numeric assignment `x OP= y` (`+= -= *= /= %= &= |= ^=`),
        // G# requires the RHS to share the LHS's numeric type; a mismatched RHS is
        // coerced to the LHS type via the conversion-call form (e.g. `x += int64(y)`).
        // A nullable RHS is coerced through the LHS's underlying numeric type.
        private GExpression CoerceCompoundAssignmentRhs(
            AssignmentExpressionSyntax assignment, GExpression rhs)
        {
            if (assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                return rhs;
            }

            // Issue #1232: compound shift (`<<=` / `>>=`). The RHS is a shift
            // count, NOT the LHS numeric type — gsc now implicitly widens a
            // narrower-order integer count to int32, so the count needs no
            // coercion. Return it unchanged (and, crucially, skip the LHS-type
            // numeric promotion below, which would wrongly coerce the count to
            // the LHS type, e.g. `uint32(count)` → GS0129).
            if (assignment.IsKind(SyntaxKind.LeftShiftAssignmentExpression) ||
                assignment.IsKind(SyntaxKind.RightShiftAssignmentExpression) ||
                assignment.IsKind(SyntaxKind.UnsignedRightShiftAssignmentExpression))
            {
                return rhs;
            }

            ITypeSymbol leftType = this.context.GetTypeInfo(assignment.Left).Type;
            ITypeSymbol rightType = this.context.GetTypeInfo(assignment.Right).Type;

            if (TryGetNumericKind(leftType, out SpecialType leftUnderlying) &&
                TryGetNumericKind(rightType, out SpecialType rightUnderlying) &&
                leftUnderlying != rightUnderlying)
            {
                return this.CoerceOperandTo(
                    rhs,
                    UnwrapNullable(leftType),
                    assignment.Right.GetLocation());
            }

            return rhs;
        }

        // C# array-creation lengths accept any integral type (`new T[uint]`,
        // `new T[long]`, …), but the native G# allocation form `[n]T` (issue
        // #1272) takes an `int32`. Coerce a non-`int32` numeric length to int32
        // via the conversion-call form so the allocation binds. A nullable or
        // non-numeric length is left unchanged.
        private GExpression CoerceLengthToInt32(
            ExpressionSyntax lengthSyntax, GExpression length)
        {
            ITypeSymbol lengthType = this.context.GetTypeInfo(lengthSyntax).Type;
            if (lengthType != null &&
                IsNonNullableValueType(lengthType) &&
                TryGetNumericKind(lengthType, out SpecialType underlying) &&
                underlying != SpecialType.System_Int32)
            {
                ITypeSymbol int32Type =
                    this.context.Compilation.GetSpecialType(SpecialType.System_Int32);
                return this.CoerceOperandTo(
                    length,
                    int32Type,
                    lengthSyntax.GetLocation());
            }

            return length;
        }

        // G# array/indexer element access. Issue #1279: gsc now accepts ANY
        // C#-supported integer type as an array/slice element index (it converts
        // the wider/unsigned kinds — `uint`, `long`, `ulong`, `nint`, `nuint` —
        // to native int), so an ARRAY index needs no `int32(...)` coercion and is
        // emitted idiomatically. A user/CLR indexer (`List<T>`, `Span<T>`,
        // `IReadOnlyList<T>`, ...) whose single parameter is `int32` still binds
        // its argument to `int32` via normal conversion rules in gsc, so a wide
        // index against such an indexer is still wrapped in `int32(<index>)`.
        // Dictionary/other indexers keyed by a non-`int32` type, `System.Index`/
        // `System.Range` indices, and indices already `int`/narrower are left
        // untouched.
        private GExpression CoerceIndexToInt32(
            ElementAccessExpressionSyntax elementAccess, GExpression index)
        {
            if (elementAccess.ArgumentList.Arguments.Count != 1)
            {
                return index;
            }

            // Issue #1279: arrays accept any integer index in gsc — no coercion.
            if (this.context.GetTypeInfo(elementAccess.Expression).Type is IArrayTypeSymbol)
            {
                return index;
            }

            if (!this.IndexerTargetTypeIsInt32(elementAccess))
            {
                return index;
            }

            ExpressionSyntax indexSyntax = elementAccess.ArgumentList.Arguments[0].Expression;
            ITypeSymbol indexType = this.context.GetTypeInfo(indexSyntax).Type;
            if (indexType != null &&
                IsNonNullableValueType(indexType) &&
                IsIntegerNotWideningToInt32(indexType))
            {
                ITypeSymbol int32Type =
                    this.context.Compilation.GetSpecialType(SpecialType.System_Int32);
                return this.CoerceOperandTo(
                    index,
                    int32Type,
                    indexSyntax.GetLocation());
            }

            return index;
        }

        // CLR rectangular-array Get/Set pseudo-methods take int32 indices.
        // Preserve C#'s unchecked integral narrowing for wide index kinds
        // (`long`/`ulong`/`nint`/`nuint`) with an explicit G# int32 conversion.
        private GExpression CoerceMultiDimIndexToInt32(ExpressionSyntax indexSyntax, GExpression index)
        {
            ITypeSymbol indexType = this.context.GetTypeInfo(indexSyntax).Type;
            if (indexType != null &&
                IsNonNullableValueType(indexType) &&
                IsIntegerNotWideningToInt32(indexType))
            {
                ITypeSymbol int32Type =
                    this.context.Compilation.GetSpecialType(SpecialType.System_Int32);
                return this.CoerceOperandTo(
                    index,
                    int32Type,
                    indexSyntax.GetLocation());
            }

            return index;
        }

        private GExpression TranslateOutVarDesignation(SingleVariableDesignationSyntax single)
        {
            return new OutArgumentExpression(
                "out var",
                this.EmittedName(single, single.Identifier));
        }

        // Reports whether the element-access target indexes by `int32`: a C# array,
        // or a type whose bound indexer takes a single `int32` parameter (such as
        // `List<T>`, `Span<T>`, `IReadOnlyList<T>`). A `Dictionary<TKey, T>` or any
        // other indexer keyed by a non-`int32` type returns false.
        private bool IndexerTargetTypeIsInt32(ElementAccessExpressionSyntax elementAccess)
        {
            ITypeSymbol receiverType = this.context.GetTypeInfo(elementAccess.Expression).Type;
            if (receiverType is IArrayTypeSymbol)
            {
                return true;
            }

            if (this.context.GetSymbolInfo(elementAccess).Symbol is IPropertySymbol
                { IsIndexer: true, Parameters.Length: 1 } indexer)
            {
                return indexer.Parameters[0].Type.SpecialType == SpecialType.System_Int32;
            }

            return false;
        }

        // Reports whether `type` is an integral type that does NOT implicitly widen
        // to `int32` in C# — `uint`/`uint32`, `long`/`int64`, `ulong`/`uint64`,
        // `nint`, and `nuint`. The narrow integrals (`byte`, `sbyte`, `short`,
        // `ushort`, `char`) and `int` itself widen to/are `int32` and return false.
        private static bool IsIntegerNotWideningToInt32(ITypeSymbol type)
        {
            switch (type.SpecialType)
            {
                case SpecialType.System_UInt32:
                case SpecialType.System_Int64:
                case SpecialType.System_UInt64:
                case SpecialType.System_IntPtr:
                case SpecialType.System_UIntPtr:
                    return true;
                default:
                    return false;
            }
        }

        // C# `a ?? b` where `a` is a nullable numeric and the operands' numeric
        // kinds differ: the coercion target is the *result* type of the whole
        // `??` expression — C#'s best-common-type computation (§12.15), exactly
        // as `GetTypeInfo(binary).Type` already reports it — not unconditionally
        // the left operand's type (issue #1725). When the right operand is
        // *wider* than the left (e.g. `long r = nullableInt ?? longDefault;`),
        // C# types the whole expression as the right operand's (wider) type and
        // converts the LEFT's non-null value instead; the old code coerced the
        // right operand DOWN to the left's narrower type, silently truncating
        // it (or truncating a `double` fallback to the left's integral type).
        //
        // gsc's own `??` binder (issue #1239) already performs this same
        // C#-faithful best-common-type widening and auto-converts the left
        // operand's non-null value whenever the left is the narrower side —
        // verified directly against gsc for int32?/int64, int32?/double,
        // int64?/int32 (left wider), float?/double, uint32?/int64, and
        // int32?/decimal (see Issue1725NullCoalescingNumericWideningEmitTests
        // for the runtime locks of each combo). The one gap gsc does not
        // fill on its own is a *constant* right operand whose natural
        // numeric kind differs
        // from the result (e.g. `x ?? 0` for `uint32? x`: the literal `0`'s
        // natural type `int32` differs from the `uint32` result C# computed
        // via its constant-literal conversion rule, which gsc's type-only
        // conversion lattice does not special-case) — only in that direction
        // is an explicit coercion required, and it always targets the
        // *result* type, never the left type. Coercing the right operand when
        // it already matches the result type is a no-op (skipped below), so
        // this also covers left-wider-than-right (right coerced up, as
        // before) and equal-kind operands (no coercion, unchanged).
        // Non-numeric coalescing (reference types, tasks) is left untouched.
        private GExpression TranslateNullCoalescing(
            BinaryExpressionSyntax binary, GExpression left, GExpression right)
        {
            ITypeSymbol leftType = this.context.GetTypeInfo(binary.Left).Type;
            ITypeSymbol rightType = this.context.GetTypeInfo(binary.Right).Type;

            if (TryGetNumericKind(leftType, out SpecialType leftUnderlying) &&
                TryGetNumericKind(rightType, out SpecialType rightUnderlying) &&
                leftUnderlying != rightUnderlying)
            {
                // `.Type` (not `.ConvertedType`) is the `??` expression's own
                // best-common-type per C# §12.15 — the value we need here.
                // `.ConvertedType` instead reflects an ENCLOSING conversion
                // (e.g. an assignment's target type), which would let an
                // outer context over-coerce this operand to the wrong type
                // (S1). `.Type` is only null for an unresolved/erroneous
                // expression; both operands already passed `TryGetNumericKind`
                // above, meaning the semantic model fully resolved this `??`,
                // so `.Type` is guaranteed non-null here.
                ITypeSymbol resultType = this.context.GetTypeInfo(binary).Type;

                if (TryGetNumericKind(resultType, out SpecialType resultUnderlying) &&
                    rightUnderlying != resultUnderlying)
                {
                    right = this.CoerceOperandTo(
                        right,
                        UnwrapNullable(resultType),
                        binary.Right.GetLocation());
                }
            }

            return new BinaryExpression(left, "??", right);
        }

        // C# ternary `cond ? a : b` lowers to the G# value-position `if` expression.
        // Issue #1232: gsc now matches C#'s numeric ergonomics for conditional arms
        // — it adapts an in-range constant integer literal arm and implicitly widens
        // a narrower typed arm to the other arm's type. So a coercion is only needed
        // for the residual case G# still cannot unify on its own: when C#'s common
        // result type is STRICTLY WIDER than BOTH arm types (e.g. `cond ? u16 : i16`
        // whose C# common type is `int`, which equals neither arm). There we coerce
        // both diverging arms to the result type via the conversion-call form. The
        // idiomatic `cond ? 1u : 0` now translates to `if cond { 1u } else { 0 }`
        // (no cast on the `0`), letting gsc adapt the literal.
        private GExpression TranslateConditionalExpression(
            ConditionalExpressionSyntax conditional)
        {
            // ADR-0151: `receiver is { } name [&& predicate] ? a : b` has a
            // canonical G# form — the value-position `if let` — which needs
            // neither a single-evaluation spill temp nor a `!!` at each binder
            // reference. Attempt it before the general lowering; the helper is
            // conservative and leaves everything untranslated when it bails.
            if (!this.ConditionUsesNativePatternVariables(conditional.Condition)
                && this.TryTranslateIfLetConditional(conditional, out GExpression ifLet))
            {
                return ifLet;
            }

            GExpression condition = this.TranslateExpression(conditional.Condition);
            (GExpression whenTrue, List<GStatement> thenStatements) =
                this.TranslateConditionalValueBranch(conditional.WhenTrue);
            (GExpression whenFalse, List<GStatement> elseStatements) =
                this.TranslateConditionalValueBranch(conditional.WhenFalse);
            (whenTrue, whenFalse) = this.CoerceConditionalArms(conditional, whenTrue, whenFalse);
            return new IfExpression(
                condition,
                whenTrue,
                whenFalse,
                thenStatements,
                elseStatements);
        }

        // G# conditional/switch arms can use block expressions: run arm-local
        // spills/writes there so only the selected C# arm executes them.
        private (GExpression Value, List<GStatement> Statements) TranslateConditionalValueBranch(
            ExpressionSyntax branch,
            Func<GExpression> translateValue = null)
        {
            List<GStatement> outerSpillPrologue = this.state.PendingSpillPrologue;
            var statements = new List<GStatement>();
            this.state.PendingSpillPrologue = statements;
            try
            {
                var replacements = new List<ExpressionSyntax>();
                List<AssignmentExpressionSyntax> embedded =
                    this.HoistAssignmentsInOrder(
                        branch,
                        includeSelf: true,
                        statements,
                        replacements);

                try
                {
                    GExpression value = translateValue != null
                        ? translateValue()
                        : this.TranslateValueWithNullForgiveness(branch);
                    return (value, statements);
                }
                finally
                {
                    this.ReleaseHoistedAssignments(embedded, replacements);
                }
            }
            finally
            {
                this.state.PendingSpillPrologue = outerSpillPrologue;
            }
        }

        // Shared by the general `IfExpression` lowering above and the ADR-0151
        // `if let` rewrite: aligns the two translated arms with C#'s computed
        // conditional result type (numeric widening that gsc will not infer on
        // its own, and a bare `null` arm re-spelled as `default(T?)`).
        private (GExpression WhenTrue, GExpression WhenFalse) CoerceConditionalArms(
            ConditionalExpressionSyntax conditional,
            GExpression whenTrue,
            GExpression whenFalse)
        {
            TypeInfo conditionalTypeInfo = this.context.GetTypeInfo(conditional);
            ITypeSymbol resultType = conditionalTypeInfo.Type ?? conditionalTypeInfo.ConvertedType;
            ITypeSymbol trueType = this.context.GetTypeInfo(conditional.WhenTrue).Type;
            ITypeSymbol falseType = this.context.GetTypeInfo(conditional.WhenFalse).Type;

            // When C# computed a single numeric conditional type but an arm has a
            // different numeric type (e.g. `cond ? 1u : 0`, whose `0` is `int32`
            // while the result is `uint32`), coerce each mismatched arm to the
            // result type: G# requires both arms to share a type (GS0263) and does
            // no implicit promotion. Each arm is coerced independently so a ternary
            // with only one mismatched arm is still aligned.
            if (resultType != null &&
                IsNonNullableValueType(resultType) &&
                TryGetNumericKind(resultType, out SpecialType resultUnderlying))
            {
                if (TryGetNumericKind(trueType, out SpecialType trueUnderlying) &&
                    trueUnderlying != resultUnderlying)
                {
                    whenTrue = this.CoerceOperandTo(
                        whenTrue,
                        resultType,
                        conditional.WhenTrue.GetLocation());
                }

                if (TryGetNumericKind(falseType, out SpecialType falseUnderlying) &&
                    falseUnderlying != resultUnderlying)
                {
                    whenFalse = this.CoerceOperandTo(
                        whenFalse,
                        resultType,
                        conditional.WhenFalse.GetLocation());
                }
            }

            // Issue #3553: C# also target-types REFERENCE arms to the
            // conditional's common type (`cond ? new NonNullAssertionExpression(…)
            // : new IdentifierExpression(…)` converts both to the shared base),
            // while gsc requires a common result type outright (GS0263). When an
            // arm's own reference type differs from the common reference type by
            // more than a nullable annotation, spell the upcast (`arm as T`).
            // Mirrors CoerceSwitchArmNumericValue's reference rule for switch
            // arms; each arm is coerced independently.
            if (resultType?.IsReferenceType == true
                && resultType.TypeKind != TypeKind.Error)
            {
                if (trueType?.IsReferenceType == true
                    && trueType.TypeKind != TypeKind.Error
                    && !SymbolEqualityComparer.Default.Equals(trueType, resultType))
                {
                    whenTrue = this.CoerceReferenceValueTo(
                        conditional.WhenTrue,
                        whenTrue,
                        resultType);
                }

                if (falseType?.IsReferenceType == true
                    && falseType.TypeKind != TypeKind.Error
                    && !SymbolEqualityComparer.Default.Equals(falseType, resultType))
                {
                    whenFalse = this.CoerceReferenceValueTo(
                        conditional.WhenFalse,
                        whenFalse,
                        resultType);
                }
            }

            // A `null` arm (`cond ? value : null`) carries no type of its own, so
            // G# infers the conditional's type purely from the non-null arm — the
            // bare `nil` then fails to unify (GS0155 "cannot convert nil to T", and
            // the surrounding call cascades GS0159). C#'s common type already
            // records the nullable union (e.g. `IEnumerator<T>?`); re-emit the null
            // arm as `default(T?)` carrying that mapped nullable type so gsc unifies
            // the branches into the nullable type instead of guessing the non-null
            // one. Restricted to reference-type results (a `Nullable<V>` value
            // result is handled by C#'s own lifting / numeric paths above).
            if (resultType is { IsReferenceType: true })
            {
                GTypeReference nullableResult = MakeNullable(
                    this.typeMapper.Map(resultType, this.context, conditional.GetLocation()));

                if (IsNullLiteral(conditional.WhenTrue))
                {
                    whenTrue = new DefaultValueExpression(nullableResult);
                }

                if (IsNullLiteral(conditional.WhenFalse))
                {
                    whenFalse = new DefaultValueExpression(nullableResult);
                }
            }

            return (whenTrue, whenFalse);
        }

        // Unwraps `System.Nullable<T>` to its underlying `T`; other types pass
        // through unchanged.
        private static ITypeSymbol UnwrapNullable(ITypeSymbol type)
        {
            if (type is INamedTypeSymbol named &&
                named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T &&
                named.TypeArguments.Length == 1)
            {
                return named.TypeArguments[0];
            }

            return type;
        }

        // non-nullable value type target (e.g. `uint8`, `int32`) G# rejects
        // `(expr as T)` with GS0270 ("the 'as' operator requires the target type to
        // be a reference type or a nullable value type"); the canonical G# form is
        // the width-bearing conversion-call `T(expr)`. Only a reference type or a
        // nullable value type target (where `as` is valid) keeps the `as` form.
        private GExpression CoerceOperandTo(
            GExpression expression,
            ITypeSymbol targetType,
            Location location)
        {
            if (IsNonNullableValueType(targetType))
            {
                GTypeReference conversionTarget = this.typeMapper.Map(
                    targetType, this.context, location);
                return new ConversionExpression(conversionTarget, expression);
            }

            GTypeReference target = this.typeMapper.Map(targetType, this.context, location);
            return new ParenthesizedExpression(
                new BinaryExpression(expression, "as", new TypeExpression(target)));
        }

        // Wraps a translated expression in an explicit G# pointer conversion-call
        // (`*void(expr)`, `*uint8(expr)`, ...) when C# performed an IMPLICIT
        // pointer→pointer conversion at this position. In C# a pointer→pointer
        // conversion between DIFFERENT pointee types (`byte* → void*`,
        // `void* → byte*`, `int* → void*`, ...) is implicit, but per ADR-0122 §6
        // G# requires it to be spelled explicitly as the conversion-call
        // `*<TargetPointee>(expr)`; the bare operand is rejected with GS0156
        // ("An explicit conversion exists"). Applied at argument, assignment,
        // return, and local-initializer positions (issue #914).
        //
        // No wrap is emitted when the pointee types are identical (no conversion
        // is needed) — this also naturally covers an already-explicit C# cast
        // `(void*)x` bound to a `void*` target (source == converted == `void*`),
        // which cs2gs already renders as `*void(x)`, avoiding a double wrap. The
        // full target pointer type is mapped through the standard type mapper so
        // the pointee (`void`, `uint8`, `int32`, ...) is spelled with G# names.
        private GExpression CoercePointerConversion(ExpressionSyntax expression, GExpression translated)
        {
            if (expression == null)
            {
                return translated;
            }

            TypeInfo info = this.context.GetTypeInfo(expression);
            if (info.Type is IPointerTypeSymbol source &&
                info.ConvertedType is IPointerTypeSymbol target &&
                !SymbolEqualityComparer.Default.Equals(source.PointedAtType, target.PointedAtType))
            {
                GTypeReference targetRef = this.typeMapper.Map(target, this.context, expression.GetLocation());
                return new ConversionExpression(targetRef, translated);
            }

            return translated;
        }

        // Issue #3685: wraps a translated expression in the explicit checked
        // reference cast `cast[[]B](expr)` when C# performed an implicit ARRAY
        // COVARIANCE conversion at this position (`PortableExecutableReference[]`
        // returned as `MetadataReference[]`, the InternalAnalyzers.Tests wall).
        // C# widens `D[] -> B[]` implicitly; G# slices are invariant by design
        // (gsc issue #2516 — the ArrayTypeMismatchException hazard must be
        // announced), so the bare operand is rejected (GS0155/GS0156) and the
        // upcast has to be spelled. `cast[…]` is the identity-preserving
        // spelling: it is a reference-level no-op on the SAME array instance,
        // unlike a projecting `.Cast[B]().ToArray()` copy.
        //
        // Applied at the same argument / assignment / return / local-initializer
        // positions as CoercePointerConversion, and for the same reason: those
        // are the positions where C# inserts a target-typed conversion. Rank and
        // element-kind guards keep it to the one-dimensional reference-element
        // case the CLR actually widens; an annotation-only element difference
        // compares equal under SymbolEqualityComparer.Default and is left bare.
        private GExpression CoerceCovariantArrayConversion(ExpressionSyntax expression, GExpression translated)
        {
            if (expression == null)
            {
                return translated;
            }

            TypeInfo info = this.context.GetTypeInfo(expression);
            if (info.Type is IArrayTypeSymbol source &&
                info.ConvertedType is IArrayTypeSymbol target &&
                source.Rank == 1 &&
                target.Rank == 1 &&
                source.ElementType is { IsReferenceType: true } sourceElement &&
                target.ElementType is { IsReferenceType: true } targetElement &&
                sourceElement.TypeKind != TypeKind.Error &&
                targetElement.TypeKind != TypeKind.Error &&
                !SymbolEqualityComparer.Default.Equals(sourceElement, targetElement))
            {
                GTypeReference targetRef = this.typeMapper.Map(target, this.context, expression.GetLocation());
                return new ConversionExpression(targetRef, translated, isCheckedReferenceCast: true);
            }

            return translated;
        }

        // Reports whether `type` is a value type that is not `System.Nullable<T>`,
        // i.e. a target for which G#'s `as` operator is invalid (GS0270) and the
        // conversion-call form must be used instead.
        private static bool IsNonNullableValueType(ITypeSymbol type)
        {
            if (type == null || !type.IsValueType)
            {
                return false;
            }

            if (type is INamedTypeSymbol named &&
                named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
            {
                return false;
            }

            return true;
        }

        private static bool IsNumericPromotionOperator(string op)
        {
            switch (op)
            {
                case "==":
                case "!=":
                case "<":
                case "<=":
                case ">":
                case ">=":
                case "+":
                case "-":
                case "*":
                case "/":
                case "%":
                case "&":
                case "|":
                case "^":
                    return true;
                default:
                    return false;
            }
        }

        // Reports whether `type` is a numeric primitive (unwrapping Nullable<T>) and
        // yields its underlying special type. `char` is included because C# promotes
        // it to `int` in arithmetic/comparison/bitwise contexts, so a mismatched
        // `uint8 == 'A'` needs a G# conversion here. `bool`/`string` are excluded.
        private static bool TryGetNumericKind(ITypeSymbol type, out SpecialType underlying)
        {
            underlying = SpecialType.None;
            if (type == null)
            {
                return false;
            }

            if (type is INamedTypeSymbol named &&
                named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T &&
                named.TypeArguments.Length == 1)
            {
                type = named.TypeArguments[0];
            }

            switch (type.SpecialType)
            {
                case SpecialType.System_Char:
                case SpecialType.System_SByte:
                case SpecialType.System_Byte:
                case SpecialType.System_Int16:
                case SpecialType.System_UInt16:
                case SpecialType.System_Int32:
                case SpecialType.System_UInt32:
                case SpecialType.System_Int64:
                case SpecialType.System_UInt64:
                case SpecialType.System_Single:
                case SpecialType.System_Double:
                case SpecialType.System_Decimal:
                    underlying = type.SpecialType;
                    return true;
                default:
                    return false;
            }
        }

        // Reports whether a numeric underlying kind (as classified by
        // <see cref="TryGetNumericKind"/>) is an INTEGRAL type — i.e. every numeric
        // primitive except the three floating-point/decimal kinds (`float`,
        // `double`, `decimal`). Issue #2352: C#'s constant-expression narrowing
        // conversions (C# §10.2.11) — the rule that lets cs2gs retype a constant
        // operand to the OTHER operand's (narrower or differently-signed) numeric
        // type instead of widening the non-constant operand — are defined only
        // between integral types. This gate keeps that retyping confined to
        // integral↔integral combinations so a `float`/`double`/`decimal` constant
        // (or non-constant) operand always instead follows the converted-type-driven
        // widening below, matching C#'s actual binary numeric promotion.
        private static bool IsIntegralNumericKind(SpecialType underlying)
        {
            switch (underlying)
            {
                case SpecialType.System_Single:
                case SpecialType.System_Double:
                case SpecialType.System_Decimal:
                    return false;
                default:
                    return true;
            }
        }

        private bool IntegralConstantFits(ExpressionSyntax expression, SpecialType targetType)
        {
            Optional<object> constant = this.context.SemanticModel.GetConstantValue(expression);
            if (!constant.HasValue || constant.Value == null)
            {
                return false;
            }

            decimal value;
            try
            {
                value = constant.Value is char character
                    ? character
                    : Convert.ToDecimal(constant.Value, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return false;
            }

            return targetType switch
            {
                SpecialType.System_SByte => value >= sbyte.MinValue && value <= sbyte.MaxValue,
                SpecialType.System_Byte => value >= byte.MinValue && value <= byte.MaxValue,
                SpecialType.System_Int16 => value >= short.MinValue && value <= short.MaxValue,
                SpecialType.System_UInt16 => value >= ushort.MinValue && value <= ushort.MaxValue,
                SpecialType.System_Char => value >= char.MinValue && value <= char.MaxValue,
                SpecialType.System_Int32 => value >= int.MinValue && value <= int.MaxValue,
                SpecialType.System_UInt32 => value >= uint.MinValue && value <= uint.MaxValue,
                SpecialType.System_Int64 => value >= long.MinValue && value <= long.MaxValue,
                SpecialType.System_UInt64 => value >= ulong.MinValue && value <= ulong.MaxValue,
                _ => false,
            };
        }

        private IEnumerable<GStatement> TranslateLabeledStatement(LabeledStatementSyntax labeledStatement)
        {
            // C# `label: statement;` is a single statement wrapper; G# has the
            // identical `label: statement` form (ADR-0070, generalized by
            // ADR-0139 / issue #1884). The inner statement can expand into more
            // than one G# statement (e.g. a declaration that needs a spill
            // prologue); the label is attached to the FIRST emitted statement
            // only — C# source has no way to target a position mid-expansion,
            // so this is a faithful mapping.
            string label = this.EmittedName(labeledStatement, labeledStatement.Identifier);
            List<GStatement> inner = this.TranslateStatement(labeledStatement.Statement).ToList();
            if (inner.Count == 0)
            {
                return new[] { (GStatement)new LabeledStatement(label, new BlockStatement(new List<GStatement>())) };
            }

            var result = new List<GStatement> { new LabeledStatement(label, inner[0]) };
            result.AddRange(inner.Skip(1));
            return result;
        }

        private IEnumerable<GStatement> TranslateGotoStatement(GotoStatementSyntax gotoStatement)
        {
            switch (gotoStatement.Kind())
            {
                case SyntaxKind.GotoCaseStatement:
                case SyntaxKind.GotoDefaultStatement:
                    // Issue #3501 A3: a trailing `goto case`/`goto default`
                    // that targets the LEXICALLY NEXT section is exactly Go's
                    // `fallthrough` — the native gsc statement replaces the
                    // synthesized-label lowering below.
                    if (this.IsAdjacentFallthroughGoto(gotoStatement))
                    {
                        return new[] { (GStatement)new FallthroughStatement() };
                    }

                    // ADR-0139 / issue #1884: `goto case K;` jumps to the
                    // statement list of the case labeled with the constant K
                    // WITHOUT re-evaluating the switch subject; `goto default;`
                    // jumps to the default section. Neither re-enters the
                    // switch, so both lower to a plain `goto` targeting a
                    // synthesized label placed at the top of the target arm's
                    // body (see TranslateSwitchStatement).
                    SwitchLabelSyntax target = this.ResolveGotoCaseOrDefaultTarget(gotoStatement);
                    if (target == null)
                    {
                        this.context.ReportUnsupported(gotoStatement, "goto target case/default label could not be resolved.");
                        return new[] { (GStatement)new RawStatement($"// unsupported: {gotoStatement.Kind()}") };
                    }

                    // Issue #3501: a goto whose target arm does nothing (an
                    // empty section or a bare `break;`) just exits the
                    // switch — G#'s break-in-arm (A3) says that directly, no
                    // synthesized label pair needed. Guarded against an
                    // intervening loop or nested switch, where a bare `break`
                    // would bind to the inner construct instead.
                    if (TargetArmIsEmptyBreak(target)
                        && !HasInterveningBreakTarget(gotoStatement))
                    {
                        return new[] { (GStatement)new BreakStatement() };
                    }

                    return new[] { (GStatement)new GotoStatement(this.GotoCaseOrDefaultLabelName(target)) };

                default:
                    // Plain `goto label;` — Expression is the label name as an
                    // IdentifierNameSyntax (verified against Roslyn 4.14).
                    var labelName = (IdentifierNameSyntax)gotoStatement.Expression;
                    string label = this.EmittedName(labelName, labelName.Identifier);
                    return new[] { (GStatement)new GotoStatement(label) };
            }
        }

        /// <summary>
        /// ADR-0159 / issue #3501: folds <c>args == null</c> /
        /// <c>args != null</c> where <c>args</c> is the enclosing method's
        /// C# <c>params</c> array to its constant value — a G# variadic
        /// parameter always materializes an array, so gsc rejects the
        /// always-decided nil compare (GS0523).
        /// </summary>
        private bool TryFoldParamsArrayNullCheck(BinaryExpressionSyntax binary, out GExpression folded)
        {
            folded = null;
            bool isEquals = binary.IsKind(SyntaxKind.EqualsExpression);
            if (!isEquals && !binary.IsKind(SyntaxKind.NotEqualsExpression))
            {
                return false;
            }

            ExpressionSyntax operand = binary.Right.IsKind(SyntaxKind.NullLiteralExpression) ? binary.Left
                : binary.Left.IsKind(SyntaxKind.NullLiteralExpression) ? binary.Right
                : null;
            if (!this.IsParamsArrayOperand(operand))
            {
                return false;
            }

            folded = LiteralExpression.Bool(!isEquals);
            return true;
        }

        /// <summary>
        /// ADR-0159 / issue #3501: true when <paramref name="operand"/> reads a
        /// C# <c>params</c> parameter. Such a parameter translates to a G#
        /// variadic, which always materializes an array, so any nil comparison
        /// against it is statically decided and gsc reports GS0523. Shared by
        /// the <c>args == null</c> binary spelling
        /// (<see cref="TryFoldParamsArrayNullCheck"/>) and the <c>args is
        /// null</c> / <c>args is not null</c> pattern spelling
        /// (<c>TranslatePatternTest</c> / <c>TranslateNotPatternTest</c>).
        /// </summary>
        private bool IsParamsArrayOperand(ExpressionSyntax operand)
            => operand != null
                && this.context.GetSymbolInfo(operand).Symbol is IParameterSymbol { IsParams: true };

        /// <summary>
        /// Issue #3501: true when the arm a <c>goto case</c>/<c>goto
        /// default</c> targets does nothing — its section body is empty or a
        /// single bare <c>break;</c> — so the jump is equivalent to exiting
        /// the switch.
        /// </summary>
        private static bool TargetArmIsEmptyBreak(SwitchLabelSyntax target) =>
            target.Parent is SwitchSectionSyntax section
            && (section.Statements.Count == 0
                || (section.Statements.Count == 1 && section.Statements[0] is BreakStatementSyntax));

        /// <summary>
        /// Issue #3501: true when a loop or a nested <c>switch</c> sits
        /// between the <c>goto</c> and its enclosing switch, so a bare
        /// <c>break</c> emitted in the goto's position would bind to that
        /// inner construct instead of the switch.
        /// </summary>
        private static bool HasInterveningBreakTarget(GotoStatementSyntax gotoStatement)
        {
            for (SyntaxNode node = gotoStatement.Parent; node is not null; node = node.Parent)
            {
                switch (node)
                {
                    case SwitchStatementSyntax:
                        return false;
                    case ForStatementSyntax or ForEachStatementSyntax or ForEachVariableStatementSyntax
                        or WhileStatementSyntax or DoStatementSyntax:
                        return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Resolves the <see cref="SwitchLabelSyntax"/> that a <c>goto case
        /// K;</c> / <c>goto default;</c> statement targets, by walking up to
        /// the nearest enclosing <c>switch</c> and matching on compile-time
        /// constant value (issue #1884). Returns <c>null</c> if the enclosing
        /// switch or matching label cannot be found (malformed input; the
        /// caller reports a translation gap).
        /// </summary>
        private SwitchLabelSyntax ResolveGotoCaseOrDefaultTarget(GotoStatementSyntax gotoStatement)
        {
            SwitchStatementSyntax enclosingSwitch = gotoStatement.Ancestors().OfType<SwitchStatementSyntax>().FirstOrDefault();
            if (enclosingSwitch == null)
            {
                return null;
            }

            if (gotoStatement.Kind() == SyntaxKind.GotoDefaultStatement)
            {
                return enclosingSwitch.Sections
                    .SelectMany(section => section.Labels)
                    .OfType<DefaultSwitchLabelSyntax>()
                    .FirstOrDefault();
            }

            Optional<object> targetValue = this.context.SemanticModel.GetConstantValue(gotoStatement.Expression);
            if (!targetValue.HasValue)
            {
                return null;
            }

            foreach (SwitchSectionSyntax section in enclosingSwitch.Sections)
            {
                foreach (SwitchLabelSyntax label in section.Labels)
                {
                    if (label is CaseSwitchLabelSyntax caseLabel)
                    {
                        Optional<object> caseValue = this.context.SemanticModel.GetConstantValue(caseLabel.Value);
                        if (caseValue.HasValue && Equals(targetValue.Value, caseValue.Value))
                        {
                            return caseLabel;
                        }
                    }
                }
            }

            return null;
        }

        /// <summary>
        /// The synthesized G# label name for a <c>goto case</c>/<c>goto
        /// default</c> target (issue #1884). Keyed by the target label's own
        /// syntax node, which keeps the two independent call sites that must
        /// agree on the name — the arm that defines the label
        /// (<see cref="TranslateSwitchStatement"/>) and the <c>goto</c> that
        /// targets it (<see cref="ResolveGotoCaseOrDefaultTarget"/> callers) —
        /// consistent through the per-scope ordinal allocation (issue #3467).
        /// </summary>
        private string GotoCaseOrDefaultLabelName(SwitchLabelSyntax label)
            => this.SyntheticLabelName(
                label is DefaultSwitchLabelSyntax ? "gotoDefault" : "gotoCase",
                label);

        /// <summary>
        /// Issue #3501 A3: true when a <c>goto case</c>/<c>goto default</c>
        /// is exactly Go's <c>fallthrough</c>: it is the DIRECT last
        /// statement of a single-label section (so the section prints as one
        /// G# arm), and it targets a label of the LEXICALLY NEXT section
        /// whose labels are all binding-free (constants or <c>default</c> —
        /// gsc rejects fallthrough into an arm with pattern bindings or a
        /// guard). Such gotos print as the native <c>fallthrough</c>
        /// statement and need no synthesized arm-top label.
        /// </summary>
        private bool IsAdjacentFallthroughGoto(GotoStatementSyntax gotoStatement)
        {
            if (!gotoStatement.IsKind(SyntaxKind.GotoCaseStatement)
                && !gotoStatement.IsKind(SyntaxKind.GotoDefaultStatement))
            {
                return false;
            }

            SwitchSectionSyntax section = gotoStatement.Ancestors().OfType<SwitchSectionSyntax>().FirstOrDefault();
            if (section == null
                || section.Statements.LastOrDefault() != gotoStatement
                || section.Labels.Count != 1)
            {
                return false;
            }

            if (section.Parent is not SwitchStatementSyntax switchStatement
                || gotoStatement.Ancestors().OfType<SwitchStatementSyntax>().FirstOrDefault() != switchStatement)
            {
                return false;
            }

            int sectionIndex = switchStatement.Sections.IndexOf(section);
            if (sectionIndex < 0 || sectionIndex + 1 >= switchStatement.Sections.Count)
            {
                return false;
            }

            SwitchSectionSyntax nextSection = switchStatement.Sections[sectionIndex + 1];
            SwitchLabelSyntax resolvedTarget = this.ResolveGotoCaseOrDefaultTarget(gotoStatement);
            return resolvedTarget != null
                && nextSection.Labels.Contains(resolvedTarget)
                && nextSection.Labels.All(l => l is CaseSwitchLabelSyntax or DefaultSwitchLabelSyntax);
        }

        private GStatement TranslateThrow(ThrowStatementSyntax throwStatement)
        {
            // ADR-0176 / issue #3897: C# `throw;` maps to G# `rethrow`, which
            // emits ILOpCode.Rethrow and preserves the original throw site.
            // The previous lowering re-threw the caught variable, which is the
            // same exception object but resets its StackTrace. A C# `throw;` is
            // only legal inside a catch handler, and cs2gs keeps it inside the
            // translated catch body, so `rethrow` is always legal here.
            if (throwStatement.Expression == null)
            {
                return new RethrowStatement();
            }

            return new ThrowStatement(this.TranslateExpression(throwStatement.Expression));
        }

        private GStatement TranslateTry(TryStatementSyntax node)
        {
            BlockStatement tryBlock = this.TranslateBlock(node.Block);

            var catches = new List<CatchClause>();
            foreach (CatchClauseSyntax catchClause in node.Catches)
            {
                string variableName = null;
                GTypeReference exceptionType = null;
                if (catchClause.Declaration != null)
                {
                    ITypeSymbol typeSymbol = this.context.GetTypeInfo(catchClause.Declaration.Type).Type;
                    exceptionType = typeSymbol != null
                        ? this.typeMapper.Map(typeSymbol, this.context, catchClause.Declaration.Type.GetLocation())
                        : new NamedTypeReference(catchClause.Declaration.Type.ToString());
                    variableName = this.EmittedName(
                        catchClause.Declaration,
                        catchClause.Declaration.Identifier);
                }

                GExpression filter = catchClause.Filter == null
                    ? null
                    : this.TranslateExpression(catchClause.Filter.FilterExpression);
                catches.Add(new CatchClause(
                    variableName,
                    exceptionType,
                    this.TranslateBlock(catchClause.Block),
                    filter));
            }

            BlockStatement finallyBlock = node.Finally != null
                ? this.TranslateBlock(node.Finally.Block)
                : null;

            return new TryStatement(tryBlock, catches, finallyBlock);
        }

        private GStatement TranslateUsingStatement(UsingStatementSyntax node)
        {
            // C# `using (var r = e) body` / `await using (var r = e) body` has
            // no `using (...)` block form in G# (it is GS0005); it maps to a
            // scoped block holding a `using let` / `await using let` resource
            // declaration followed by the body, so the resource is disposed at
            // the end of that block (sample Defer.gs; ADR-0115 §B; ADR-0030).
            // The C# `await` keyword (issue #1903) selects `DisposeAsync` over
            // `Dispose` — dropping it silently would compile a sync `using`
            // against an `IAsyncDisposable`-only type and gsc would reject it
            // (GS0119), so it must be threaded through, never elided.
            bool isAwait = !node.AwaitKeyword.IsKind(SyntaxKind.None);
            var statements = new List<GStatement>();
            if (node.Declaration != null)
            {
                statements.AddRange(this.TranslateLocalDeclaration(node.Declaration, isConst: false, isUsing: true, isAwait: isAwait));
            }
            else if (node.Expression != null)
            {
                // `using (expr) body` (no declaration): the resource is the
                // expression value; bind it to a fresh `using let` so disposal
                // is scoped to the block.
                statements.Add(new LocalDeclarationStatement(
                    BindingKind.Let,
                    "_",
                    type: null,
                    initializer: this.TranslateExpression(node.Expression),
                    isUsing: true,
                    isAwait: isAwait));
            }

            BlockStatement bodyBlock = this.TranslateStatementAsBlock(node.Statement);
            statements.AddRange(bodyBlock.Statements);
            return new BlockStatement(statements);
        }

        /// <summary>
        /// ADR-0143 §D: whether <paramref name="expression"/> is an invocation
        /// that binds to an ELIDED unimplemented C# partial method — a partial
        /// method DEFINITION with no implementation part. Such a call produces no
        /// runtime effect in C# and has no G# member to target (the declaration
        /// was elided in <see cref="TranslateMethod"/>), so the enclosing
        /// expression statement is dropped.
        /// </summary>
        private bool IsElidedPartialMethodInvocation(ExpressionSyntax expression)
        {
            if (expression is not InvocationExpressionSyntax invocation)
            {
                return false;
            }

            // The bound target may resolve to either the defining or the
            // implementing part; normalize to the definition and check whether it
            // is an unimplemented partial definition.
            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method)
            {
                return false;
            }

            // Issue #4370: a `[LibraryImport]` definition is never elided (it
            // translates to a native `@LibraryImport` func), even when the
            // compilation carries no generated implementation. Issue #4301: nor
            // is a `[GeneratedRegex]` one (it translates to a declaring part).
            IMethodSymbol definition = method.PartialDefinitionPart ?? method;
            return definition.IsPartialDefinition
                && definition.PartialImplementationPart == null
                && !IsLibraryImportDefinition(definition)
                && !IsGeneratedRegexDefinition(definition);
        }

        private GStatement TranslateExpressionStatement(ExpressionSyntax expression)
        {
            if (expression is ConditionalAccessExpressionSyntax conditionalAccess &&
                this.TryTranslateNullConditionalStaticExtensionHelperStatement(
                    conditionalAccess,
                    out GStatement conditionalHelperStatement))
            {
                return conditionalHelperStatement;
            }

            if (expression is ConditionalAccessExpressionSyntax voidConditionalAccess
                && this.context.GetTypeInfo(voidConditionalAccess).Type?.SpecialType
                    == SpecialType.System_Void
                && (this.RequiresLocalAssignmentSeam(voidConditionalAccess.WhenNotNull)
                    || this.ContainsFunctionArgumentSpillSeam(voidConditionalAccess.WhenNotNull)))
            {
                return this.TranslateVoidConditionalAccessWithLocalAssignmentSeam(
                    voidConditionalAccess);
            }

            switch (expression)
            {
                case AssignmentExpressionSyntax assignment when this.IsDelegateMulticastCombine(assignment, out string combineOp):
                    // Issue #1960 item 2: `handler += Second;` / `handler -= Second;`
                    // on a plain delegate-typed target (NOT a declared `event` —
                    // those already lower to G#'s dedicated event-subscription
                    // `+=`/`-=` form, ADR-0052/ADR-0036) has no G# equivalent.
                    // G#'s `+=`/`-=` syntax binds ONLY to an actual CLR event
                    // (Parser.cs's `EventSubscriptionExpressionSyntax`; the binder's
                    // general compound-assignment fallback has no `+`/`-` operator
                    // for delegate/function types, and `Delegate.Combine`/`Remove`
                    // are reachable only from the compiler's own synthesized event
                    // accessors, not from ordinary call-expression binding). Rather
                    // than emit `+=`/`-=` that fails to bind in gsc, gap loudly.
                    string combineMessage =
                        $"delegate multicast '{combineOp}' on a non-event delegate-typed target has no G# equivalent: " +
                        "G#'s '+='/'-=' syntax binds only to a declared CLR event, and 'Delegate.Combine'/'Delegate.Remove' " +
                        "are reachable only from the compiler's own synthesized event accessors, not from ordinary call " +
                        "binding (issue #1960).";
                    this.context.ReportUnsupported(assignment, combineMessage);
                    return new RawStatement($"// unsupported: delegate multicast '{combineOp}'");

                case AssignmentExpressionSyntax assignment:
                    return new AssignmentStatement(
                        this.TranslateAssignmentTarget(assignment.Left),
                        this.TranslateAssignmentValue(assignment),
                        assignment.OperatorToken.Text);

                case PostfixUnaryExpressionSyntax postfix
                    when postfix.IsKind(SyntaxKind.PostIncrementExpression)
                        || postfix.IsKind(SyntaxKind.PostDecrementExpression):
                    return new IncrementDecrementStatement(
                        this.TranslateExpression(postfix.Operand),
                        postfix.OperatorToken.Text);

                case PrefixUnaryExpressionSyntax prefix
                    when prefix.IsKind(SyntaxKind.PreIncrementExpression)
                        || prefix.IsKind(SyntaxKind.PreDecrementExpression):
                    // G# has no prefix ++/--; both forms are statements with the
                    // same effect, so emit the canonical postfix increment.
                    return new IncrementDecrementStatement(
                        this.TranslateExpression(prefix.Operand),
                        prefix.OperatorToken.Text);

                case SwitchExpressionSyntax switchExpression:
                    // A C# switch EXPRESSION used in statement position — reached
                    // via a discard (`_ = x switch { ... };`, lowered by
                    // TranslateExpressionStatements) or any other expression-
                    // statement context. G#'s switch-EXPRESSION arm form uses
                    // `case P: expr` (an expression per arm) and is only valid in
                    // value position; a bare switch expression at statement
                    // position is parsed as a switch STATEMENT, whose arms require
                    // a `case P { block }` body — so emitting the expression form
                    // here produces invalid G# (GS0005 "expected OpenBraceToken").
                    // Lower to a genuine switch STATEMENT instead, running each
                    // arm's expression for its side effect (the value is discarded,
                    // exactly as in C#'s `_ = <switch expr>`); issue #914.
                    return this.TranslateSwitchExpressionAsStatement(switchExpression);

                default:
                    return new ExpressionStatement(this.TranslateExpression(expression));
            }
        }

        private GStatement TranslateVoidConditionalAccessWithLocalAssignmentSeam(
            ConditionalAccessExpressionSyntax conditionalAccess)
        {
            GExpression receiver = this.CaptureReceiverOnce(
                this.TranslateExpression(conditionalAccess.Expression),
                conditionalAccess.Expression,
                "a void conditional-access statement here has no enclosing evaluation seam to capture its receiver once.");
            GExpression previousReceiver = this.state.ConditionalReceiverReplacement;
            List<GStatement> outerSpillPrologue = this.state.PendingSpillPrologue;
            var statements = new List<GStatement>();
            var replacements = new List<ExpressionSyntax>();
            this.state.ConditionalReceiverReplacement =
                new NonNullAssertionExpression(receiver);
            this.state.PendingSpillPrologue = statements;
            List<AssignmentExpressionSyntax> embedded =
                this.HoistAssignmentsInOrder(
                    conditionalAccess.WhenNotNull,
                    includeSelf: true,
                    statements,
                    replacements);
            try
            {
                statements.Add(new ExpressionStatement(
                    this.TranslateExpression(conditionalAccess.WhenNotNull)));
            }
            finally
            {
                this.ReleaseHoistedAssignments(embedded, replacements);
                this.state.PendingSpillPrologue = outerSpillPrologue;
                this.state.ConditionalReceiverReplacement = previousReceiver;
            }

            return new IfStatement(
                new BinaryExpression(receiver, "!=", LiteralExpression.Null()),
                new BlockStatement(statements));
        }

        private GExpression TranslateAssignmentValue(AssignmentExpressionSyntax assignment)
        {
            GExpression value = this.CoerceConstantToUnsigned(
                assignment.Right,
                this.TranslateExpression(assignment.Right));
            value = this.CoerceCompoundAssignmentRhs(assignment, value);
            value = this.CoerceCovariantArrayConversion(
                assignment.Right,
                this.CoercePointerConversion(assignment.Right, value));

            // Issue #4500: a write into an element of an array whose element
            // cs2gs widened to `T?` (IsWidenedArrayElementLocal) accepts nil,
            // so none of the null-forgiveness bridges below may assert the
            // value. The coercions above still apply.
            if (assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                && assignment.Left is ElementAccessExpressionSyntax elementTarget
                && this.context.GetSymbolInfo(elementTarget.Expression).Symbol is ILocalSymbol widenedArray
                && this.IsWidenedArrayElementLocal(widenedArray))
            {
                return value;
            }

            value = this.ForgiveElementAccessAssignmentRhs(assignment, value);
            value = this.ForgiveObliviousExternalAssignmentRhs(assignment, value);
            if (!assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                return value;
            }

            ISymbol assignmentTarget = this.context.GetSymbolInfo(assignment.Left).Symbol;
            ITypeSymbol assignmentTargetType = this.GetAssignmentTargetType(assignment.Left, assignmentTarget);
            ISymbol promotionTarget = assignmentTarget;
            if (assignmentTarget is ILocalSymbol inferredAssignmentLocal
                && inferredAssignmentLocal.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                    is VariableDeclaratorSyntax { Initializer.Value: { } initializer } declarator
                && declarator.Ancestors().OfType<VariableDeclarationSyntax>()
                    .FirstOrDefault()?.Type.IsVar == true)
            {
                // Issue #3771: substituting the INITIALIZER's type for the
                // target's and dropping `promotionTarget` also drops the #1072
                // promotion check, so a `var` local whose emitted G# declaration
                // was widened to `T?` (TranslateLocalDeclaration's inferred-type
                // branch) still looks like a non-nullable sink here and the RHS
                // gets a `!!`. C#'s `!` is erased at compile time; G#'s `!!` is a
                // CHECKED assertion that THROWS on nil, so the assertion turns
                // `for (var c = x; c != null; c = Parent(c))` into a guaranteed
                // NullReferenceException at the loop's normal exit — compiling
                // and ILVerifying clean the whole way. Keep the promotion target
                // so a widened declaration vetoes the assertion.
                if (this.InferredLocalDeclarationIsNullable(inferredAssignmentLocal))
                {
                    return value;
                }

                assignmentTargetType = this.context.GetTypeInfo(initializer).Type;
                promotionTarget = null;
            }

            return this.ForgiveNullableReferenceValue(
                assignment.Right,
                value,
                assignmentTargetType,
                promotionTarget,
                includePromotedValue: true);
        }

        // Expression nullability is absent when warnings are disabled, even
        // when the declared indexer or array element explicitly permits null.
        private ITypeSymbol GetAssignmentTargetType(ExpressionSyntax left, ISymbol target) =>
            target switch
            {
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                IFieldSymbol field => field.Type,
                IPropertySymbol property => property.Type,
                _ when left is ElementAccessExpressionSyntax element
                    && this.context.GetTypeInfo(element.Expression).Type is IArrayTypeSymbol array => array.ElementType,
                _ => this.context.GetTypeInfo(left).Type,
            };

        // Translates the target (left-hand side) of an assignment. Two member-access
        // LHS shapes that gsc cannot bind through the usual receiver path are fixed
        // up here:
        //
        //   • `Prop.Member = v` where `Prop` is an *implicit-this* instance
        //     property/field of the enclosing type. gsc resolves a bare-identifier
        //     assignment receiver as a variable/parameter; an implicit-this property
        //     receiver has no local slot, so the member write fails (GS0158 /
        //     GS9998). Qualifying it as `this.Prop.Member = v` routes the write
        //     through the expression-receiver path, which binds correctly.
        //     When `Prop` is itself declared-nullable (or promoted, issue #1072),
        //     the same `!!` the read path applies is inserted on the qualified
        //     receiver (`this.Prop!!.Member = v`) — the qualification and the
        //     null-forgiveness are independent fixes and compose.
        //
        //   • `recv.Member = v` where `recv` is a declared-nullable receiver that
        //     Roslyn flow-proved non-null (or was promoted to nullable, #1072).
        //     gsc does not flow-narrow an *assignment* receiver (only reads), so the
        //     bare nullable receiver fails to bind the setter (GS0158). A
        //     `recv!!.Member = v` re-establishes the non-null fact (mirrors the
        //     read-side <see cref="TranslateReceiverWithNullForgiveness"/> and its
        //     flow-independent <see cref="ReceiverIsNullableReferenceFieldOrProperty"/>
        //     companion, so nullable-oblivious corpora get the same assertion the
        //     read path does).
        private GExpression TranslateAssignmentTarget(ExpressionSyntax left)
        {
            if (left is MemberAccessExpressionSyntax member)
            {
                if (member.Expression is IdentifierNameSyntax receiverId &&
                    this.context.GetSymbolInfo(receiverId).Symbol is { IsStatic: false } receiverSymbol &&
                    (receiverSymbol.Kind == SymbolKind.Property ||
                        receiverSymbol.Kind == SymbolKind.Field))
                {
                    GExpression qualifiedReceiver = new MemberAccessExpression(
                        new ThisExpression(),
                        this.EmittedName(receiverId, receiverId.Identifier));

                    // ADR-0186 step 6 (PR 0): an inherited oblivious-metadata
                    // member is `T!`, which gsc checks itself.
                    if (!this.PlatformTypedImportNeedsNoBridge(receiverId) &&
                        (this.ReceiverNeedsNullForgiveness(receiverId, isDereferenceReceiver: true) ||
                        this.ReceiverIsNullableReferenceFieldOrProperty(receiverId)))
                    {
                        qualifiedReceiver = EnsureNonNullAssertion(qualifiedReceiver);
                    }

                    return new MemberAccessExpression(
                        qualifiedReceiver,
                        this.EmittedName(member, member.Name.Identifier));
                }

                // ADR-0186 step 6 (PR 0): an oblivious-metadata receiver is
                // `T!`, which gsc checks itself.
                if (!this.PlatformTypedImportNeedsNoBridge(member.Expression) &&
                    (this.ReceiverNeedsNullForgiveness(member.Expression, isDereferenceReceiver: true) ||
                    this.ReceiverIsNullableReferenceFieldOrProperty(member.Expression) ||
                    (member.Expression is IdentifierNameSyntax hoistedId &&
                     this.context.GetSymbolInfo(hoistedId).Symbol is { } hoistedSymbol &&
                     this.state.HoistedNullableGuardLocals.Contains(hoistedSymbol))))
                {
                    return new MemberAccessExpression(
                        EnsureNonNullAssertion(this.TranslateExpression(member.Expression)),
                        this.EmittedName(member, member.Name.Identifier));
                }
            }

            return this.TranslateExpression(left);
        }

        /// <summary>
        /// Issue #1741: whether an identifier named <c>_</c> is a true C# discard
        /// (<see cref="IDiscardSymbol"/>) rather than a real variable/field named
        /// <c>_</c> that happens to be in scope. A real <c>_</c> binding is a normal
        /// assignment target, not a discard, and must not be dropped.
        /// </summary>
        /// <param name="identifier">The <c>_</c> identifier on the assignment's left side.</param>
        /// <returns><c>true</c> when <paramref name="identifier"/> is a genuine discard.</returns>
        private bool IsTrueDiscard(IdentifierNameSyntax identifier)
        {
            ISymbol symbol = this.context.GetSymbolInfo(identifier).Symbol;

            // No symbol at all means there is no real `_` binding in scope, so this
            // is a genuine discard; fall back to the name-based check.
            return symbol is IDiscardSymbol or null;
        }

        private bool CanDropDiscardedExpression(ExpressionSyntax expression)
        {
            expression = Unwrap(expression);
            switch (expression)
            {
                case LiteralExpressionSyntax:
                case ThisExpressionSyntax:
                case BaseExpressionSyntax:
                case DefaultExpressionSyntax:
                case TypeOfExpressionSyntax:
                    return true;

                case IdentifierNameSyntax identifier:
                    ISymbol symbol = this.context.GetSymbolInfo(identifier).Symbol;
                    return symbol is IRangeVariableSymbol
                        || (symbol is ILocalSymbol local && local.RefKind == RefKind.None)
                        || (symbol is IParameterSymbol parameter && parameter.RefKind == RefKind.None);

                case PostfixUnaryExpressionSyntax suppressed
                    when suppressed.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                    return this.CanDropDiscardedExpression(suppressed.Operand);

                case TupleExpressionSyntax tuple:
                    return tuple.Arguments.All(argument =>
                        this.CanDropDiscardedExpression(argument.Expression));

                default:
                    return false;
            }
        }

        /// <summary>
        /// Translates an expression-statement that may expand into several G#
        /// statements: tuple declaration/deconstruction forms may expand, while
        /// ordinary chained assignments remain native nested expressions.
        /// </summary>
        private IEnumerable<GStatement> TranslateExpressionStatements(
            ExpressionSyntax expression,
            bool hoistPostfix = true)
        {
            if (expression is AssignmentExpressionSyntax assignment &&
                assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                if (assignment.Left is IdentifierNameSyntax { Identifier.ValueText: "_" } discardCandidate &&
                    this.IsTrueDiscard(discardCandidate))
                {
                    // C# statement-level discard `_ = e` (Roslyn parses the `_`
                    // target as an IdentifierNameSyntax). G# has no discard target
                    // (`_ = e` → GS0125). Drop only reads that cannot run code or
                    // throw; otherwise G#'s native discard declaration evaluates
                    // the RHS exactly once while keeping its value unbound.
                    if (this.CanDropDiscardedExpression(assignment.Right))
                    {
                        return System.Array.Empty<GStatement>();
                    }

                    ExpressionSyntax discardedValue = Unwrap(assignment.Right);
                    if ((discardedValue is AssignmentExpressionSyntax or SwitchExpressionSyntax)
                        || (discardedValue is PrefixUnaryExpressionSyntax prefix
                            && (prefix.IsKind(SyntaxKind.PreIncrementExpression)
                                || prefix.IsKind(SyntaxKind.PreDecrementExpression)))
                        || (discardedValue is PostfixUnaryExpressionSyntax postfix
                            && (postfix.IsKind(SyntaxKind.PostIncrementExpression)
                                || postfix.IsKind(SyntaxKind.PostDecrementExpression))))
                    {
                        return this.TranslateExpressionStatements(discardedValue);
                    }

                    return this.WithHoistedAssignments(
                        assignment.Right,
                        includeSelf: true,
                        () => new List<GStatement>
                        {
                            new LocalDeclarationStatement(
                                BindingKind.Let,
                                "_",
                                initializer: this.TranslateExpression(assignment.Right)),
                        });
                }

                if (this.TryGetDeconstructionTargets(assignment.Left, out BindingKind binding, out IReadOnlyList<string> names))
                {
                    return new[]
                    {
                        (GStatement)new TupleDeconstructionStatement(
                            binding,
                            names,
                            this.TranslateExpression(assignment.Right)),
                    };
                }

                // `(a, b) = (x, y)` deconstruction *assignment*. Flat existing
                // targets now use G# native multi-assignment (issues #3353/#3358),
                // including storage targets and tuple-valued calls. Mixed
                // declarations, nested targets, expression-position forms, and
                // non-tuple Deconstruct sources use the recursive fallback below.
                // That fallback captures the whole RHS ONCE via G#'s native
                // `let (t0, t1, ...) = rhs` deconstruction-declaration form —
                // this already handles every RHS shape the declaration path
                // does (a tuple literal, a tuple-returning call, a
                // Deconstruct-method type) and, being a single statement,
                // preserves C#'s evaluate-then-assign-all semantics (handles
                // aliasing such as the swap `(a, b) = (b, a)`); issue #1895,
                // ADR-0115 §B. A NESTED target (`((a, b), c) = ...`) has no
                // flat `t0, t1, ...` shape at the top level, but is lowered by
                // recursing: the nested arm gets its own temp, which is then
                // deconstructed by a SECOND `let (...) = temp` statement
                // (issue #1974) — G#'s grammar only needs a flat name list per
                // statement, and nothing stops chaining several of them. A
                // storage target inside a fallback shape is captured before the
                // RHS by `LowerTupleAssignment`, preserving issue #2234 order.
                if (assignment.Left is DeclarationExpressionSyntax nestedDeclarationExpression
                    && nestedDeclarationExpression.Designation
                        is ParenthesizedVariableDesignationSyntax nestedDeclaration)
                {
                    return this.LowerTupleDeclaration(
                        nestedDeclaration,
                        assignment.Right,
                        nestedDeclarationExpression.Type.IsVar);
                }

                if (assignment.Left is TupleExpressionSyntax leftTuple)
                {
                    return this.LowerTupleAssignment(leftTuple, assignment.Right);
                }
            }

            // Ordinary chains, including `??=`, are native G# assignment
            // expressions. Keep legacy flattening only when a link is
            // tuple-valued and still needs statement-hosting lowering.
            if (expression is AssignmentExpressionSyntax outerAssignment &&
                AssignmentChainRequiresStatementLowering(outerAssignment))
            {
                return this.FlattenChainedAssignment(outerAssignment, preserveValue: false);
            }

            return this.WithHoistedAssignments(
                expression,
                includeSelf: false,
                () => hoistPostfix
                    ? this.WithHoistedPostfix(
                        expression,
                        () => new[] { this.TranslateExpressionStatement(expression) }).ToList()
                    : new List<GStatement> { this.TranslateExpressionStatement(expression) });
        }

        // Strips parentheses so chain/assignment detection is parenthesis-transparent.
        private static ExpressionSyntax Unwrap(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax paren)
            {
                expression = paren.Expression;
            }

            return expression;
        }

        private static bool AssignmentChainRequiresStatementLowering(
            AssignmentExpressionSyntax assignment)
        {
            if (AssignmentRequiresStatementLowering(assignment))
            {
                return true;
            }

            return Unwrap(assignment.Right) is AssignmentExpressionSyntax nested
                && AssignmentChainRequiresStatementLowering(nested);
        }

        /// <summary>
        /// Translates an expression in statement position, hoisting any embedded
        /// post-increment/decrement (`a[i++] = x`, `M(i--)`, `x = y++`) into
        /// trailing `i++` / `i--` statements. G# models inc/dec as statements, so
        /// the sub-expression is suppressed (read as its pre-increment value) and
        /// the mutation is appended after the main statement (ADR-0115 §B).
        /// </summary>
        /// <remarks>
        /// Issue #4114: this hoist-to-trailing-statement strategy is only sound
        /// when a target is mutated at most ONCE in the statement. C# sequences
        /// repeated postfix operators on the SAME target left-to-right — each
        /// occurrence of `x++` in `H(x++), H(x++)` observes a DIFFERENT value
        /// (the first reads the original, the second reads it already
        /// incremented). Suppressing every occurrence and deferring every
        /// mutation to AFTER the whole statement collapses that sequencing:
        /// none of the mutations has run when either suppressed read happens,
        /// so both read the same (original) value, and the compiler's own
        /// metadata row planner discovered this the hard way — two inherited
        /// event-bridge MethodDef rows were planned as `H(nextMethodRow++),
        /// H(nextMethodRow++))` and came out numerically identical, so the
        /// second emitted row landed one past its plan and tripped the
        /// self-hosted compiler's "not emitted in planned order" guard
        /// (GS9998). A target with more than one embedded occurrence is left
        /// un-hoisted here; those occurrences fall through to G#'s native
        /// inline inc/dec expression (gsc issue #1027), which evaluates each
        /// occurrence in true left-to-right order without needing a statement
        /// seam. Single-occurrence targets keep the existing hoisted form.
        /// </remarks>
        private IEnumerable<GStatement> WithHoistedPostfix(
            ExpressionSyntax expression,
            Func<IEnumerable<GStatement>> buildMain)
        {
            List<PostfixUnaryExpressionSyntax> embedded = CollectEmbeddedPostfix(expression);
            if (embedded.Count == 0)
            {
                return buildMain();
            }

            var targetOccurrences = new Dictionary<ISymbol, int>(SymbolEqualityComparer.Default);
            foreach (PostfixUnaryExpressionSyntax node in embedded)
            {
                ISymbol target = this.context.GetSymbolInfo(node.Operand).Symbol;
                if (target != null)
                {
                    targetOccurrences[target] = targetOccurrences.TryGetValue(target, out int count) ? count + 1 : 1;
                }
            }

            // A node whose operand's symbol could not be resolved (e.g. an
            // array-element access like `a[0]++` — a built-in indexer
            // operation with no target symbol via GetSymbolInfo) has no
            // reliable way to detect aliasing with another occurrence, so it
            // must stay inline rather than be hoisted: hoisting is only safe
            // once a repeat is ruled out, and an unresolved target can never
            // rule one out. `Record(a[0]++, a[0]++)` therefore falls through
            // to G#'s native inline postfix, which evaluates each occurrence
            // in true left-to-right order regardless of aliasing.
            List<PostfixUnaryExpressionSyntax> hoistable = embedded
                .Where(node =>
                {
                    ISymbol target = this.context.GetSymbolInfo(node.Operand).Symbol;
                    return target != null && targetOccurrences[target] == 1;
                })
                .ToList();

            if (hoistable.Count == 0)
            {
                return buildMain();
            }

            foreach (PostfixUnaryExpressionSyntax node in hoistable)
            {
                this.state.SuppressedPostfix.Add(node);
            }

            List<GStatement> statements;
            try
            {
                statements = buildMain().ToList();
            }
            finally
            {
                foreach (PostfixUnaryExpressionSyntax node in hoistable)
                {
                    this.state.SuppressedPostfix.Remove(node);
                }
            }

            foreach (PostfixUnaryExpressionSyntax node in hoistable)
            {
                statements.Add(new IncrementDecrementStatement(
                    this.TranslateExpression(node.Operand),
                    node.OperatorToken.Text));
            }

            return statements;
        }
    }
}
