// <copyright file="CSharpToGSharpTranslator.Statements.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.FlowAnalysis
import Microsoft.CodeAnalysis.Operations
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        private let reachingTupleProjections Dictionary[
            string,
            (Source ExpressionSyntax?, Path IReadOnlyList[int32])
        ] = Dictionary[string, (Source ExpressionSyntax, Path IReadOnlyList[int32])]()
        private enum DelegateArgumentBehavior {
            NotObserved,
            InvokedDuringCall,
            Escapes
        }

        private func TranslateLocalDeclaration(
            declaration VariableDeclarationSyntax?,
            isConst bool,
            isUsing bool = false,
            isAwait bool = false
        ) IEnumerable[GStatement] {
            // Issue #1900: `ref int r = ref xs[1];` — a ref local. `declaration.Type`
            // is a `RefTypeSyntax`; every declarator in this statement is a ref
            // local aliasing storage, which maps to G#'s native ref-aliasing local
            // (see TranslateRefExpression / TranslateRefLocalDeclaration).
            if declaration!!.Type is RefTypeSyntax {
                return this.TranslateRefLocalDeclaration(declaration)
            }
            let results = List[GStatement]()
            let hasExplicitType = !declaration!!.Type.IsVar
            for declarator in declaration!!.Variables {
                var localAcceptsNil = false
                var initializer GExpression?
                if declarator.Initializer == nil {
                    initializer = nil
                } else {
                    // Value-position deconstruction assignments still need a
                    // statement seam; ordinary assignments remain inline.
                    let replacements = List[ExpressionSyntax]()
                    let initializerEmbedded = this.HoistAssignmentsInOrder(
                        declarator.Initializer!!.Value,
                        includeSelf: true,
                        results,
                        replacements
                    )
                    try {
                        initializer = this.CoerceCovariantArrayConversion(
                            declarator.Initializer!!.Value,
                            this.CoercePointerConversion(
                                declarator.Initializer!!.Value,
                                this.CoerceConstantToUnsigned(
                                    declarator.Initializer!!.Value,
                                    this.TranslateExpression(declarator.Initializer!!.Value)
                                )
                            )
                        )
                    } finally {
                        this.ReleaseHoistedAssignments(initializerEmbedded, replacements)
                    }
                }
                if initializer != nil &&
                    declarator
                    .Initializer
                    ?.Value is {} initializerSyntax &&
                    this
                    .context
                    .GetDeclaredSymbol(declarator) is ILocalSymbol localTarget {
                    var targetType ITypeSymbol? = localTarget.Type
                    localAcceptsNil = this.LocalInitializerMakesStorageNullable(localTarget, initializerSyntax)
                    if localAcceptsNil {
                        targetType = targetType!!.WithNullableAnnotation(
                            Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                        )
                    }
                    if IsImplicitlyTypedLocal(localTarget) && this.GetManagedReferenceArrayProjectedExpressionType(
                        initializerSyntax
                    ) is {} projectedType {
                        let unparenthesizedInitializer ExpressionSyntax? = Unparenthesize(initializerSyntax)
                        let compositeInitializer = unparenthesizedInitializer is ConditionalExpressionSyntax ||
                            unparenthesizedInitializer is SwitchExpressionSyntax
                        if !compositeInitializer || this.InferredLocalAssignmentsMatch(
                            localTarget,
                            initializerSyntax,
                            projectedType
                        ) {
                            targetType = projectedType
                            this
                                .state
                                .ManagedReferenceArrayNullable
                                .ManagedReferenceArrayProjectedLocalType[localTarget] = projectedType
                        } else if this.IsRejectableManagedReferenceProjection(
                            initializerSyntax,
                            projectedType,
                            localTarget.Type
                        ) {
                            this.context.ReportUnsupported(
                                initializerSyntax,
                                "managed-reference array widening conflicts with a later assignment or consumer of this inferred local; no exact G# translation exists."
                            )
                        }
                    }
                    initializer = this.ForgiveNullableReferenceValue(
                        initializerSyntax,
                        initializer,
                        targetType,
                        localTarget
                    )
                }
                var binding BindingKind
                if isConst {
                    binding = BindingKind.Const
                } else if isUsing {
                    // A `using` resource is read-only after acquisition; it maps to
                    // the immutable `using let` form (sample Defer.gs).
                    binding = BindingKind.Let
                } else {
                    let local ILocalSymbol? = this.context.GetDeclaredSymbol(declarator) as ILocalSymbol
                    binding = if local != nil && this.IsLocalReassigned(local) {
                        BindingKind.Var
                    } else {
                        BindingKind.Let
                    }
                }
                // An immutable `let` requires an initializer; a declaration with no
                // initializer (e.g. a pre-declared `out` target, `int x;`) must bind
                // as mutable `var <name> <type>` so the zero value is named and the
                // subsequent assignment is legal (spec §Bindings, ADR-0115 §B.3).
                if declarator.Initializer == nil && binding == BindingKind.Let {
                    binding = BindingKind.Var
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
                var type GTypeReference? = nil
                if hasExplicitType {
                    // Issue #5537: storage of an imported oblivious container always
                    // states its nullable element positions.
                    var emitType = initializer == nil || this.StoresObliviousContainerElements(
                        this.context.GetDeclaredSymbol(declarator)
                    )
                    // Prefer the local symbol's type: it carries the flow
                    // nullable annotation (`SttsBox?`), whereas
                    // `GetTypeInfo(declaration.Type)` reports the bare type and
                    // silently drops the `?`, so a nullable-enabled local would
                    // be rendered non-nullable and later `= nil`/`== nil` fail.
                    let declaredType ITypeSymbol? = (
                        this.context.GetDeclaredSymbol(declarator) as ILocalSymbol
                    )?.Type ??
                        this
                        .context
                        .GetTypeInfo(declaration!!.Type)
                        .Type
                    if !emitType && initializer != nil && declaredType != nil {
                        // Preserve the explicit type only when it differs from the
                        // initializer's natural type (an implicit conversion). When
                        // they match, omit the clause and rely on inference — the
                        // idiomatic common case. A declared nullable reference
                        // (`Box?`) whose initializer is non-null would infer the
                        // narrower non-null type, so always emit it to keep the `?`.
                        let naturalType ITypeSymbol? = this.context.GetTypeInfo(declarator.Initializer!!.Value).Type
                        if naturalType == nil || !SymbolEqualityComparer.Default.Equals(declaredType, naturalType) ||
                            IsAnnotatedNullableReference(declaredType) ||
                            localAcceptsNil {
                            emitType = true
                        } else if this.context.GetDeclaredSymbol(declarator) is ILocalSymbol equalTypeLocal &&
                            this
                            .ShouldPromoteToNullableReference(equalTypeLocal) {
                            // Issue #1737: the explicit-type-equals-initializer-type
                            // shape above bypasses the type clause entirely (relying
                            // on inference), which would also silently drop the
                            // #1072 nullable promotion below. Route it through the
                            // same emitType=true path as every other explicit-typed
                            // shape so `var x = e;` and `T x = e;` (declared type ==
                            // natural type) promote identically.
                            emitType = true
                        }
                    }
                    if emitType {
                        // Issue #4045: an explicitly named delegate is a nominal
                        // CLR type, even when it comes from metadata. Preserve
                        // that identity instead of inferring an equivalent
                        // System.Action/Func structural arrow at runtime.
                        type = if declaredType != nil {
                            this.typeMapper.MapExplicitType(
                                declaredType,
                                this.context,
                                declaration!!.Type.GetLocation()
                            )
                        } else {
                            default(GTypeReference?)
                        }
                        type = this.PromoteObliviousContainerStorage(type, this.context.GetDeclaredSymbol(declarator))
                        // Issue #1072: a non-nullable reference/array local that is
                        // null-checked or null-assigned in its scope is really nullable.
                        if this.context.GetDeclaredSymbol(declarator) is ILocalSymbol localSymbol {
                            type = if localAcceptsNil {
                                MakeNullable(type)
                            } else {
                                (
                                    if declarator
                                        .Initializer
                                        ?.Value is {} localInitializer &&
                                        IsNullOrSuppressedNull(localInitializer) &&
                                        localSymbol
                                        .Type
                                        .IsReferenceType {
                                        MakeNullable(type)
                                    } else {
                                        this.PromoteIfUsedAsNullable(type, localSymbol)
                                    }
                                )
                            }
                        }
                    }
                } else if initializer != nil && this.context.GetDeclaredSymbol(
                    declarator
                ) is ILocalSymbol containerLocal &&
                    this
                    .StoresObliviousContainerElements(containerLocal) {
                    // Issue #5537: an inferred local that is also assigned an imported
                    // oblivious container states the nullable positions of its storage.
                    let storedType ITypeSymbol = this
                        .context
                        .GetTypeInfo(declarator.Initializer!!.Value)
                        .Type ??
                        containerLocal
                        .Type
                        .WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated)
                    type = this.PromoteObliviousContainerStorage(
                        this.typeMapper.MapExplicitType(storedType, this.context, declaration!!.Type.GetLocation()),
                        containerLocal
                    )
                    // The outer nullability keeps the existing inferred-local decision.
                    if this.InferredLocalDeclarationIsNullable(containerLocal) {
                        type = MakeNullable(type)
                    }
                } else if initializer != nil && this.context.GetDeclaredSymbol(
                    declarator
                ) is ILocalSymbol inferredLocal &&
                    this
                    .InferredLocalDeclarationIsNullable(inferredLocal) {
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
                    type = MakeNullable(
                        this.typeMapper.MapEventType(inferredLocal.Type, this.context, declaration!!.Type.GetLocation())
                    )
                } else if initializer != nil &&
                    (
                    declarator.Initializer!!.Value is BaseObjectCreationExpressionSyntax and
                        {ArgumentList: {Arguments: {Count: 1}}}
                ) &&
                    this
                    .context
                    .GetDeclaredSymbol(declarator) is ILocalSymbol delegateInferredLocal &&
                    delegateInferredLocal.Type is INamedTypeSymbol namedDelegateLocalType &&
                    namedDelegateLocalType.TypeKind == TypeKind
                    .Delegate {
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
                        namedDelegateLocalType,
                        this.context,
                        declaration!!.Type.GetLocation()
                    )
                }
                // Issue #5561: record whether the emitted storage accepts nil.
                if this.context.GetDeclaredSymbol(declarator) is ILocalSymbol storageLocal &&
                    (type != nil || initializer != nil) {
                    this.state.EmittedLocalStorageAcceptsNil[storageLocal] = if type != nil {
                        type.IsNullable
                    } else {
                        // G# infers the type from the emitted initializer; only an
                        // initializer that is certainly non-null fixes non-null storage.
                        !this.GSharpExpressionIsStaticallyNonNull(declarator.Initializer?.Value, initializer)
                    }
                }
                // Issue #4356: record the emitted G# nullability of this local
                // (analyzer mode), for every later read of it.
                this.RecordEmittedLocalNullability(
                    this.context.GetDeclaredSymbol(declarator) as ILocalSymbol,
                    type,
                    declarator.Initializer?.Value,
                    initializer
                )
                results.Add(
                    LocalDeclarationStatement(
                        binding,
                        this.EmittedName(declarator, declarator.Identifier),
                        type,
                        initializer,
                        isUsing: isUsing,
                        isAwait: isAwait
                    )
                )
            }
            return results
        }

        private func LocalInitializerMakesStorageNullable(
            local ILocalSymbol,
            initializer ExpressionSyntax
        ) bool -> local
            .Type
            .IsReferenceType &&
            !this
            .context
            .SemanticModel
            .GetNullableContext(initializer.SpanStart)
            .HasFlag(NullableContext.AnnotationsEnabled) &&
            (
            this
                .context
                .GetTypeInfo(initializer)
                .Nullability
                .Annotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated ||
                ObliviousNullabilityAnalyzer
                .IsImportedStatedNullablePosition(
                this.context.GetSymbolInfo(initializer).Symbol,
                this.context.Compilation
            ) ||
                this.ShouldPromoteToNullableReference(this.context.GetSymbolInfo(initializer).Symbol)
        ) &&
            ObliviousNullabilityAnalyzer.IsSemanticallyNullableInitializer(initializer, this.context.SemanticModel)

        private func LocalInitializerMakesStorageNullable(local ILocalSymbol) bool -> local
            .DeclaringSyntaxReferences
            .FirstOrDefault()
            ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} &&
            this.LocalInitializerMakesStorageNullable(local, initializer)

        /// Issue #1072/#2305/#3771/#4445: whether a `var` local's emitted G#
        /// declaration is widened to `T?`.
        /// @remarks This is the single rule shared by the declaration site (which emits the
        /// explicit `T?` clause) and by the assignment-RHS forgiveness, which
        /// must NOT bridge an assignment into a target that is nullable in G#:
        /// unlike C#'s erased `!`, G#'s `!!` is a checked assertion that
        /// THROWS on nil.
        private func InferredLocalDeclarationIsNullable(local ILocalSymbol) bool {
            if this.ShouldPromoteToNullableReference(local) ||
                (
                IsAnnotatedNullableReference(local.Type) && this.IsUsedAsNullable(
                    local,
                    this.GetNullabilityScope(local)
                )
            ) {
                return true
            }
            return this.InferredLocalDefaultRequiresTypedDeclaration(local)
        }

        private func InferredLocalDefaultRequiresTypedDeclaration(local ILocalSymbol?) bool {
            if this.state.InferredLocalDefaultTypedDeclarations.TryGetValue(local!!, out var cached) {
                return cached
            }
            let result = this.InferredLocalDefaultRequiresTypedDeclarationCore(local)
            this.state.InferredLocalDefaultTypedDeclarations.Add(local!!, result)
            return result
        }

        private func InferredLocalDefaultRequiresTypedDeclarationCore(local ILocalSymbol?) bool {
            if !IsAnnotatedNullableReference(local!!.Type) {
                return false
            }
            let initializer ExpressionSyntax? = this.GetInferredLocalInitializer(
                local,
                out var flowExpression,
                out var flowPosition
            )
            if initializer == nil {
                // A non-literal tuple/Deconstruct source has no per-leaf flow
                // API. Preserve the pre-#4445 inference instead of treating
                // Roslyn's declaration annotation as a maybe-null result.
                return false
            }
            // Roslyn also reports MaybeNull for ordinary unconstrained-T
            // expressions such as `await Func<Task<T>>()`. Issue #4445 is the
            // narrower default-value rule: follow aliases and branch expressions
            // back to a written default, then let Roslyn's flow state decide
            // whether that default still reaches this declaration.
            if !this.InferredInitializerOriginatesFromDefault(
                initializer,
                HashSet[ISymbol](SymbolEqualityComparer.Default)
            ) {
                return false
            }
            let typeInfo = if initializer.SyntaxTree == this.context.SemanticModel.SyntaxTree {
                this.context.GetTypeInfo(initializer)
            } else {
                default(TypeInfo)
            }
            let isWholeTupleDefault = IsNullOrDefaultLiteral(initializer) && typeInfo.Type is {IsTupleType: true}
            var flowState = if flowExpression == initializer {
                typeInfo.Nullability.FlowState
            } else {
                this
                    .context
                    .SemanticModel
                    .GetSpeculativeTypeInfo(flowPosition, flowExpression!!, SpeculativeBindingOption.BindAsExpression)
                    .Nullability
                    .FlowState
            }
            if flowState == Microsoft.CodeAnalysis.NullableFlowState.None {
                // Roslyn omits element flow in a deconstruction RHS, but
                // speculative binding at that exact position preserves it.
                flowState = this
                    .context
                    .SemanticModel
                    .GetSpeculativeTypeInfo(
                    initializer.SpanStart,
                    initializer,
                    SpeculativeBindingOption.BindAsExpression
                )
                    .Nullability
                    .FlowState
            }
            if flowState != Microsoft.CodeAnalysis.NullableFlowState.None {
                return flowState == Microsoft.CodeAnalysis.NullableFlowState.MaybeNull
            }
            if isWholeTupleDefault {
                // `default((T, T))` is a non-null ValueTuple as a whole. Use
                // this fallback only when Roslyn has no projected element flow;
                // a stable alias may have narrowed that element at the use site.
                return true
            }
            if IsNullForgiven(initializer) {
                return false
            }
            if !IsNullOrDefaultLiteral(initializer) &&
                (typeInfo.Type ?? typeInfo.ConvertedType) is {} initializerType &&
                !IsAnnotatedNullableReference(initializerType) &&
                !(initializerType is ITypeParameterSymbol) {
                return false
            }
            // Roslyn reports FlowState.None for individual tuple RHS leaves in
            // deconstruction, while preserving the inferred annotation here.
            return local!!.NullableAnnotation == Microsoft.CodeAnalysis.NullableAnnotation.Annotated
        }

        private func InferredInitializerOriginatesFromDefault(
            expression ExpressionSyntax?,
            visited HashSet[ISymbol]
        ) bool {
            if this.TryGetReachingTupleProjection(expression, out var projectionSource, out var projectionPath) {
                return this.InferredTupleProjectionOriginatesFromDefault(projectionSource, projectionPath, visited)
            }
            switch expression {
                case parenthesized is ParenthesizedExpressionSyntax {
                    return this.InferredInitializerOriginatesFromDefault(parenthesized.Expression, visited)
                }
                case suppression is PostfixUnaryExpressionSyntax when suppression.IsKind(
                    SyntaxKind.SuppressNullableWarningExpression
                ) {
                    return this.InferredInitializerOriginatesFromDefault(suppression.Operand, visited)
                }
                case literal is LiteralExpressionSyntax when literal.IsKind(SyntaxKind.DefaultLiteralExpression) {
                    return true
                }
                case DefaultExpressionSyntax {
                    return true
                }
                case cast is CastExpressionSyntax {
                    return this.InferredInitializerOriginatesFromDefault(cast.Expression, visited)
                }
                case assignment is AssignmentExpressionSyntax when assignment.IsKind(
                    SyntaxKind.SimpleAssignmentExpression
                ) ||
                    assignment
                    .IsKind(SyntaxKind.CoalesceAssignmentExpression) {
                    return this.InferredInitializerOriginatesFromDefault(assignment.Right, visited)
                }
                case conditional is ConditionalExpressionSyntax {
                    return this.InferredInitializerOriginatesFromDefault(
                        conditional.WhenTrue,
                        HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                    ) ||
                        this
                        .InferredInitializerOriginatesFromDefault(
                        conditional.WhenFalse,
                        HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                    )
                }
                case coalesce is BinaryExpressionSyntax when coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                    return this.InferredInitializerOriginatesFromDefault(
                        coalesce.Left,
                        HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                    ) ||
                        this.InferredInitializerOriginatesFromDefault(
                        coalesce.Right,
                        HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                    )
                }
                case switchExpression is SwitchExpressionSyntax {
                    return switchExpression.Arms.Any(
                        (arm SwitchExpressionArmSyntax) -> this.InferredInitializerOriginatesFromDefault(
                            arm.Expression,
                            HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                        )
                    )
                }
                case member is MemberAccessExpressionSyntax when member.SyntaxTree == this
                    .context
                    .SemanticModel
                    .SyntaxTree &&
                    this
                    .TryGetTupleElementAccess(member, out var receiver, out var path) {
                    return this.InferredTupleProjectionOriginatesFromDefault(receiver, path, visited)
                }
            }
            if expression!!.SyntaxTree != this.context.SemanticModel.SyntaxTree {
                return false
            }
            if this.context.GetSymbolInfo(expression).Symbol is not ILocalSymbol local || !visited.Add(local) {
                return false
            }
            return this.GetReachingLocalValues(local, expression!!.SpanStart, visited).Any(
                (value ExpressionSyntax) -> this.InferredInitializerOriginatesFromDefault(
                    value,
                    HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                )
            )
        }

        private func InferredTupleProjectionOriginatesFromDefault(
            source ExpressionSyntax?,
            path IReadOnlyList[int32]?,
            visited HashSet[ISymbol]
        ) bool {
            var source = source
            if path!!.Count == 0 {
                return this.InferredInitializerOriginatesFromDefault(source, visited)
            }
            source = Unwrap(source)
            if IsNullOrDefaultLiteral(source) {
                return true
            }
            if source is CastExpressionSyntax cast {
                return this.InferredTupleProjectionOriginatesFromDefault(cast.Expression, path, visited)
            }
            if source is AssignmentExpressionSyntax assignment &&
                (
                assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) || assignment.IsKind(
                    SyntaxKind.CoalesceAssignmentExpression
                )
            ) {
                return this.InferredTupleProjectionOriginatesFromDefault(assignment.Right, path, visited)
            }
            if source is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                return this.InferredTupleProjectionOriginatesFromDefault(
                    coalesce.Left,
                    path,
                    HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                ) ||
                    this
                    .InferredTupleProjectionOriginatesFromDefault(
                    coalesce.Right,
                    path,
                    HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                )
            }
            let index = path!![0]
            let remaining IReadOnlyList[int32] = path!!.Skip(1).ToArray()
            if source is TupleExpressionSyntax tuple && index < tuple.Arguments.Count {
                return this.InferredTupleProjectionOriginatesFromDefault(
                    tuple.Arguments[index].Expression,
                    remaining,
                    visited
                )
            }
            if source is ConditionalExpressionSyntax conditional {
                return this.InferredTupleProjectionOriginatesFromDefault(
                    conditional.WhenTrue,
                    path,
                    HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                ) ||
                    this
                    .InferredTupleProjectionOriginatesFromDefault(
                    conditional.WhenFalse,
                    path,
                    HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                )
            }
            if source is SwitchExpressionSyntax switchExpression {
                return switchExpression.Arms.Any(
                    (arm SwitchExpressionArmSyntax) -> this.InferredTupleProjectionOriginatesFromDefault(
                        arm.Expression,
                        path,
                        HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                    )
                )
            }
            if source!!.SyntaxTree == this
                .context
                .SemanticModel
                .SyntaxTree &&
                this
                .context
                .GetSymbolInfo(source)
                .Symbol is ILocalSymbol local &&
                visited
                .Add(local) {
                return this.GetReachingLocalValues(local, source!!.SpanStart, visited).Any(
                    (value ExpressionSyntax) -> this.InferredTupleProjectionOriginatesFromDefault(
                        value,
                        path,
                        HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                    )
                )
            }
            let projected ExpressionSyntax? = ProjectTupleElement(source, path)
            return projected!!.SyntaxTree == this
                .context
                .SemanticModel
                .SyntaxTree &&
                this.InferredInitializerOriginatesFromDefault(projected, visited)
        }

        private func TryGetTupleElementAccess(
            member MemberAccessExpressionSyntax,
            out receiver ExpressionSyntax?,
            out path IReadOnlyList[int32]?
        ) bool {
            let indices = List[int32]()
            var expression ExpressionSyntax = member
            while expression is MemberAccessExpressionSyntax access &&
                this
                .context
                .GetSymbolInfo(access.Name)
                .Symbol is IFieldSymbol{ContainingType: {IsTupleType: true}} field &&
                this
                .context
                .GetTypeInfo(access.Expression)
                .Type is INamedTypeSymbol{IsTupleType: true} tupleType {
                let index = TupleElementIndex(tupleType, field)
                if index < 0 {
                    receiver = nil
                    path = nil
                    return false
                }
                indices.Insert(0, index)
                expression = access.Expression
                while expression is ParenthesizedExpressionSyntax parenthesized {
                    expression = parenthesized.Expression
                }
            }
            receiver = expression
            path = indices
            return indices.Count > 0
        }

        private func GetInferredLocalInitializer(
            local ILocalSymbol?,
            out flowExpression ExpressionSyntax?,
            out flowPosition int32
        ) ExpressionSyntax? {
            flowExpression = nil
            flowPosition = 0
            let declaration SyntaxNode? = local!!.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
            if declaration is VariableDeclaratorSyntax declarator {
                flowExpression = declarator.Initializer?.Value
                flowPosition = flowExpression?.SpanStart ?? 0
                return flowExpression
            }
            if declaration is not SingleVariableDesignationSyntax designation ||
                !(
                designation
                    .Ancestors()
                    .OfType[AssignmentExpressionSyntax]()
                    .FirstOrDefault() is {Left: {} left, Right: {} right}
            ) {
                return nil
            }
            if TryFindDeconstructionPath(designation, left, List[int32](), out var path) {
                flowExpression = ProjectTupleElement(right, path)
                flowPosition = right.SpanStart
            }
            return FindDeconstructionInitializer(designation, left, right)
        }

        private func FindDeconstructionInitializer(
            target SingleVariableDesignationSyntax,
            left ExpressionSyntax?,
            right ExpressionSyntax?,
            visited HashSet[ISymbol]? = nil
        ) ExpressionSyntax? {
            var left = left
            var right = right
            var visited = visited
            visited ??= HashSet[ISymbol](SymbolEqualityComparer.Default)
            left = Unwrap(left)
            if right!!.SyntaxTree == this
                .context
                .SemanticModel
                .SyntaxTree &&
                this
                .context
                .GetSymbolInfo(right)
                .Symbol is ILocalSymbol alias {
                if !visited!!.Add(alias) {
                    return nil
                }
                let reaching = this.GetReachingLocalValues(alias, right!!.SpanStart, visited)
                if reaching.Count > 1 {
                    for value in reaching {
                        let found ExpressionSyntax? = FindDeconstructionInitializer(
                            target,
                            left,
                            value,
                            HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                        )
                        if this.InitializerOriginatesFromDefault(found) {
                            return found
                        }
                    }
                    return nil
                }
            }
            right = this.ResolveStableTupleAlias(right)
            if right is AssignmentExpressionSyntax assignment && assignment.IsKind(
                SyntaxKind.SimpleAssignmentExpression
            ) {
                return FindDeconstructionInitializer(target, left, assignment.Right, visited)
            }
            if left!!.SyntaxTree == target.SyntaxTree && left!!.Span.Contains(target.Span) &&
                IsNullOrDefaultLiteral(right) {
                return right
            }
            if left is DeclarationExpressionSyntax declaration {
                return FindDeconstructionInitializer(target, declaration.Designation, right, visited)
            }
            if right is ConditionalExpressionSyntax conditional {
                let found ExpressionSyntax? = FindDeconstructionInitializer(
                    target,
                    left,
                    conditional.WhenTrue,
                    HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                )
                return if this.InitializerOriginatesFromDefault(found) {
                    found
                } else {
                    FindDeconstructionInitializer(
                        target,
                        left,
                        conditional.WhenFalse,
                        HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                    )
                }
            }
            if right is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                let found ExpressionSyntax? = FindDeconstructionInitializer(
                    target,
                    left,
                    coalesce.Left,
                    HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                )
                return if this.InitializerOriginatesFromDefault(found) {
                    found
                } else {
                    FindDeconstructionInitializer(
                        target,
                        left,
                        coalesce.Right,
                        HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                    )
                }
            }
            if right is SwitchExpressionSyntax switchExpression {
                for arm in switchExpression.Arms {
                    let found ExpressionSyntax? = FindDeconstructionInitializer(
                        target,
                        left,
                        arm.Expression,
                        HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                    )
                    if this.InitializerOriginatesFromDefault(found) {
                        return found
                    }
                }
                return nil
            }
            if left is not TupleExpressionSyntax leftTuple ||
                right is not TupleExpressionSyntax rightTuple ||
                leftTuple
                .Arguments
                .Count != rightTuple
                .Arguments
                .Count {
                return nil
            }
            for var i = 0; i < leftTuple.Arguments.Count; i++ {
                let found ExpressionSyntax? = FindDeconstructionInitializer(
                    target,
                    leftTuple.Arguments[i].Expression,
                    rightTuple.Arguments[i].Expression,
                    HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                )
                if found != nil {
                    return found
                }
            }
            return nil
        }

        private func FindDeconstructionInitializer(
            target SingleVariableDesignationSyntax,
            designation VariableDesignationSyntax,
            right ExpressionSyntax?,
            visited HashSet[ISymbol]? = nil
        ) ExpressionSyntax? {
            var right = right
            var visited = visited
            visited ??= HashSet[ISymbol](SymbolEqualityComparer.Default)
            if designation.SyntaxTree == target.SyntaxTree && designation.Span == target.Span {
                return right
            }
            if right!!.SyntaxTree == this
                .context
                .SemanticModel
                .SyntaxTree &&
                this
                .context
                .GetSymbolInfo(right)
                .Symbol is ILocalSymbol alias {
                if !visited!!.Add(alias) {
                    return nil
                }
                let reaching = this.GetReachingLocalValues(alias, right!!.SpanStart, visited)
                if reaching.Count > 1 {
                    for value in reaching {
                        let found ExpressionSyntax? = FindDeconstructionInitializer(
                            target,
                            designation,
                            value,
                            HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                        )
                        if this.InitializerOriginatesFromDefault(found) {
                            return found
                        }
                    }
                    return nil
                }
            }
            right = this.ResolveStableTupleAlias(right)
            if right is AssignmentExpressionSyntax assignment && assignment.IsKind(
                SyntaxKind.SimpleAssignmentExpression
            ) {
                return FindDeconstructionInitializer(target, designation, assignment.Right, visited)
            }
            if designation.SyntaxTree == target.SyntaxTree && designation.Span.Contains(target.Span) &&
                IsNullOrDefaultLiteral(right) {
                return right
            }
            if right is ConditionalExpressionSyntax conditional {
                let found ExpressionSyntax? = FindDeconstructionInitializer(
                    target,
                    designation,
                    conditional.WhenTrue,
                    HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                )
                return if this.InitializerOriginatesFromDefault(found) {
                    found
                } else {
                    FindDeconstructionInitializer(
                        target,
                        designation,
                        conditional.WhenFalse,
                        HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                    )
                }
            }
            if right is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                let found ExpressionSyntax? = FindDeconstructionInitializer(
                    target,
                    designation,
                    coalesce.Left,
                    HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                )
                return if this.InitializerOriginatesFromDefault(found) {
                    found
                } else {
                    FindDeconstructionInitializer(
                        target,
                        designation,
                        coalesce.Right,
                        HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                    )
                }
            }
            if right is SwitchExpressionSyntax switchExpression {
                for arm in switchExpression.Arms {
                    let found ExpressionSyntax? = FindDeconstructionInitializer(
                        target,
                        designation,
                        arm.Expression,
                        HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                    )
                    if this.InitializerOriginatesFromDefault(found) {
                        return found
                    }
                }
                return nil
            }
            if designation is not ParenthesizedVariableDesignationSyntax parenthesized ||
                right is not TupleExpressionSyntax rightTuple ||
                parenthesized
                .Variables
                .Count != rightTuple
                .Arguments
                .Count {
                return nil
            }
            for var i = 0; i < parenthesized.Variables.Count; i++ {
                let found ExpressionSyntax? = FindDeconstructionInitializer(
                    target,
                    parenthesized.Variables[i],
                    rightTuple.Arguments[i].Expression,
                    HashSet[ISymbol](visited!!, SymbolEqualityComparer.Default)
                )
                if found != nil {
                    return found
                }
            }
            return nil
        }

        private func InitializerOriginatesFromDefault(expression ExpressionSyntax?) bool {
            return expression != nil && this.InferredInitializerOriginatesFromDefault(
                expression,
                HashSet[ISymbol](SymbolEqualityComparer.Default)
            )
        }

        private func ResolveStableTupleAlias(
            expression ExpressionSyntax?,
            visited HashSet[ISymbol]? = nil
        ) ExpressionSyntax? {
            var expression = expression
            var visited = visited
            if expression!!.SyntaxTree != this.context.SemanticModel.SyntaxTree {
                return expression
            }
            visited ??= HashSet[ISymbol](SymbolEqualityComparer.Default)
            var usePosition = expression!!.SpanStart
            expression = this.UnwrapTuplePreservingCasts(expression)
            while this.context.GetSymbolInfo(expression).Symbol is ILocalSymbol local && visited!!.Add(local) {
                let reaching = this.GetReachingLocalValues(local, usePosition, visited)
                if reaching.Count == 0 {
                    break
                }
                if reaching.Count != 1 {
                    break
                }
                expression = reaching[0]
                usePosition = reaching[0].SpanStart
                if expression.SyntaxTree != this.context.SemanticModel.SyntaxTree {
                    break
                }
                expression = this.UnwrapTuplePreservingCasts(expression)
            }
            return expression
        }

        private func GetReachingLocalValues(
            local ILocalSymbol,
            usePosition int32,
            visited HashSet[ISymbol]? = nil,
            executableOverride SyntaxNode? = nil,
            entryValues IReadOnlyList[ExpressionSyntax]? = nil,
            preserveDelegateCompoundAssignments bool = false
        ) IReadOnlyList[ExpressionSyntax] {
            let declaration SyntaxNode? = local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
            var initializer ExpressionSyntax? = nil
            let declarator VariableDeclaratorSyntax? = declaration as VariableDeclaratorSyntax
            if declarator?.Initializer?.Value is {} declaratorInitializer {
                initializer = declaratorInitializer
            } else if declaration is SingleVariableDesignationSyntax designation &&
                designation
                .Ancestors()
                .OfType[AssignmentExpressionSyntax]()
                .FirstOrDefault() is {Left: {} left, Right: {} right} {
                initializer = FindDeconstructionInitializer(designation, left, right, visited)
            }
            var declarationExecutable SyntaxNode? = declaration!!.AncestorsAndSelf().FirstOrDefault(
                (node SyntaxNode) -> node is BaseMethodDeclarationSyntax ||
                    node is AccessorDeclarationSyntax ||
                    node is LocalFunctionStatementSyntax ||
                    node is AnonymousFunctionExpressionSyntax
            )
            declarationExecutable ??= declaration!!.AncestorsAndSelf().OfType[CompilationUnitSyntax]().FirstOrDefault()
            var executable SyntaxNode? = executableOverride ?? declarationExecutable
            if executable == nil {
                return Array.Empty[ExpressionSyntax]()
            }
            var initialValues = entryValues ?? Array.Empty[ExpressionSyntax]()
            if executableOverride == nil &&
                declarationExecutable != nil &&
                declaration!!
                .SyntaxTree
                .GetRoot()
                .FindToken(usePosition)
                .Parent is {} useNode {
                let nestedExecutables = useNode
                    .AncestorsAndSelf()
                    .TakeWhile((node SyntaxNode) -> node.Span != declarationExecutable!!.Span)
                    .Where(
                    (node SyntaxNode) -> node is BaseMethodDeclarationSyntax ||
                        node is AccessorDeclarationSyntax ||
                        node is LocalFunctionStatementSyntax ||
                        node is AnonymousFunctionExpressionSyntax
                )
                    .Reverse()
                    .ToList()
                for nestedExecutable in nestedExecutables {
                    let declarationVisited HashSet[ISymbol]? = if visited == nil {
                        default(HashSet[ISymbol]?)
                    } else {
                        HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                    }
                    let nestedInitialValues = HashSet[ExpressionSyntax](
                        this.GetReachingLocalValues(
                            local,
                            nestedExecutable.SpanStart,
                            declarationVisited,
                            executable,
                            initialValues,
                            preserveDelegateCompoundAssignments
                        )
                    )
                    for invocationPosition in this.GetInvocationPositions(nestedExecutable, executable) {
                        let invocationVisited HashSet[ISymbol]? = if visited == nil {
                            default(HashSet[ISymbol]?)
                        } else {
                            HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                        }
                        nestedInitialValues.UnionWith(
                            this.GetReachingLocalValues(
                                local,
                                invocationPosition,
                                invocationVisited,
                                executable,
                                initialValues,
                                preserveDelegateCompoundAssignments
                            )
                        )
                    }
                    var recursiveChanged bool
                    do {
                        recursiveChanged = false
                        for invocationPosition in this.GetInvocationPositions(nestedExecutable, nestedExecutable) {
                            let before = nestedInitialValues.Count
                            let invocationVisited HashSet[ISymbol]? = if visited == nil {
                                default(HashSet[ISymbol]?)
                            } else {
                                HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                            }
                            nestedInitialValues.UnionWith(
                                this.GetReachingLocalValues(
                                    local,
                                    invocationPosition,
                                    invocationVisited,
                                    nestedExecutable,
                                    nestedInitialValues.ToList(),
                                    preserveDelegateCompoundAssignments
                                )
                            )
                            recursiveChanged |= nestedInitialValues.Count != before
                        }
                    } while recursiveChanged
                    initialValues = nestedInitialValues.ToList()
                    executable = nestedExecutable
                }
            }
            var graph ControlFlowGraph?
            try {
                graph = this.CreateControlFlowGraph(executable)
            } catch (ArgumentException) {
                return Array.Empty[ExpressionSyntax]()
            }
            var useBlock BasicBlock? = nil
            var useOperationIndex = -1
            for block in graph!!.Blocks {
                for var i = 0; i < block.Operations.Length; i++ {
                    if block.Operations[i].Syntax.FullSpan.Contains(usePosition) {
                        useBlock = block
                        useOperationIndex = i
                        break
                    }
                }
                if useBlock == nil && block.BranchValue?.Syntax.FullSpan.Contains(usePosition) == true {
                    useBlock = block
                    useOperationIndex = block.Operations.Length
                }
                if useBlock != nil {
                    break
                }
            }
            if useBlock?.IsReachable != true {
                return Array.Empty[ExpressionSyntax]()
            }
            let outputs = Dictionary[BasicBlock, HashSet[ExpressionSyntax]]()
            let assignedValues = Dictionary[AssignmentExpressionSyntax, ExpressionSyntax]()
            let elementAssignedValues = Dictionary[(Write string, Previous string), ExpressionSyntax]()
            let unknownTuple = CreateUnknownTuple(local.Type)
            var changed bool
            do {
                changed = false
                for block in graph!!.Blocks {
                    if !block.IsReachable {
                        continue
                    }
                    let values = HashSet[ExpressionSyntax]()
                    if block.Kind == BasicBlockKind.Entry {
                        values.UnionWith(initialValues)
                    }
                    for predecessor in block.Predecessors {
                        if outputs.TryGetValue(predecessor.Source, out var predecessorValues) {
                            values.UnionWith(predecessorValues)
                        }
                    }
                    for operation in block.Operations {
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
                            preserveDelegateCompoundAssignments
                        )
                    }
                    if block.BranchValue is {} branchValue {
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
                            preserveDelegateCompoundAssignments
                        )
                    }
                    if !outputs.TryGetValue(block, out var previous) || !previous.SetEquals(values) {
                        outputs[block] = values
                        changed = true
                    }
                }
            } while changed
            let reaching = HashSet[ExpressionSyntax]()
            for predecessor in useBlock!!.Predecessors {
                if outputs.TryGetValue(predecessor.Source, out var predecessorValues) {
                    reaching.UnionWith(predecessorValues)
                }
            }
            for var i = 0; i < useOperationIndex; i++ {
                this.ApplyReachingOperation(
                    useBlock!!.Operations[i],
                    declaration,
                    initializer,
                    local,
                    reaching,
                    assignedValues,
                    elementAssignedValues,
                    visited,
                    unknownTuple,
                    preserveDelegateCompoundAssignments
                )
            }
            if useOperationIndex < useBlock!!.Operations.Length {
                this.ApplyReachingOperation(
                    useBlock!!.Operations[useOperationIndex],
                    declaration,
                    initializer,
                    local,
                    reaching,
                    assignedValues,
                    elementAssignedValues,
                    visited,
                    unknownTuple,
                    preserveDelegateCompoundAssignments,
                    usePosition
                )
            } else if useBlock!!.BranchValue is {} branchValue {
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
                    usePosition
                )
            }
            return reaching.ToList()
        }

        private func GetInvocationPositions(nestedExecutable SyntaxNode, enclosingExecutable SyntaxNode?) sequence[
            int32
        ] {
            var callable ISymbol? = nil
            var anonymousFunction AnonymousFunctionExpressionSyntax? = nil
            if nestedExecutable is LocalFunctionStatementSyntax localFunction {
                callable = this.context.SemanticModel.GetDeclaredSymbol(localFunction)
            } else if nestedExecutable is AnonymousFunctionExpressionSyntax nestedAnonymousFunction {
                anonymousFunction = nestedAnonymousFunction
                var owner SyntaxNode? = anonymousFunction
                while switch owner!!.Parent {
                    case parenthesized is ParenthesizedExpressionSyntax when parenthesized.Expression == owner: true
                    case cast is CastExpressionSyntax when cast.Expression == owner: true
                    case suppression is PostfixUnaryExpressionSyntax when suppression.IsKind(
                        SyntaxKind.SuppressNullableWarningExpression
                    ) &&
                        suppression.Operand == owner: true
                    default: false
                } {
                    owner = owner!!.Parent
                }
                if owner!!.Parent is EqualsValueClauseSyntax{Parent: VariableDeclaratorSyntax declarator} {
                    callable = this.context.SemanticModel.GetDeclaredSymbol(declarator)
                } else if owner!!.Parent is AssignmentExpressionSyntax assignment {
                    callable = this.context.GetSymbolInfo(assignment.Left).Symbol
                }
            }
            if callable == nil && anonymousFunction == nil {
                yield break
            }
            let executionBody SyntaxNode? = switch enclosingExecutable {
                case anonymous is AnonymousFunctionExpressionSyntax: cast[SyntaxNode](anonymous.Body)
                case LocalFunctionStatementSyntax{Body: {} body}: cast[SyntaxNode](body)
                case LocalFunctionStatementSyntax{ExpressionBody: {Expression: {} expression}}: cast[SyntaxNode](
                    expression
                )
                default: enclosingExecutable
            }
            for invocation in EagerExecutionNodes(executionBody).OfType[InvocationExpressionSyntax]() {
                let invokedMethod IMethodSymbol? = this.context.GetSymbolInfo(invocation).Symbol as IMethodSymbol
                if anonymousFunction != nil && invokedMethod?.MethodKind != MethodKind.DelegateInvoke {
                    continue
                }
                if anonymousFunction == nil &&
                    (
                    invokedMethod == nil ||
                        (
                        invokedMethod.MethodKind != MethodKind.LocalFunction &&
                            invokedMethod.MethodKind != MethodKind.DelegateInvoke
                    )
                ) {
                    continue
                }
                var target = invocation.Expression
                if target is MemberAccessExpressionSyntax invoke && invoke.Name.Identifier.ValueText == "Invoke" {
                    target = invoke.Expression
                } else if target is MemberBindingExpressionSyntax binding &&
                    binding
                    .Name
                    .Identifier
                    .ValueText == "Invoke" &&
                    invocation.Parent is ConditionalAccessExpressionSyntax conditional {
                    target = conditional.Expression
                }
                if anonymousFunction == nil {
                    if callable is not IMethodSymbol callableLocalFunction ||
                        !this
                        .DelegateExpressionReachesLocalFunction(
                        target,
                        invocation.SpanStart,
                        callableLocalFunction,
                        HashSet[ISymbol](SymbolEqualityComparer.Default)
                    ) {
                        continue
                    }
                } else if !this.DelegateExpressionReachesAnonymousFunction(
                    target,
                    invocation.SpanStart,
                    anonymousFunction,
                    enclosingExecutable,
                    HashSet[ISymbol](SymbolEqualityComparer.Default)
                ) {
                    continue
                }
                yield invocation.ArgumentList.CloseParenToken.SpanStart
            }
            for escape in EagerExecutionNodes(executionBody) {
                var value ExpressionSyntax?
                var position int32
                var includeLaterStates bool
                switch escape {
                    case returnedStatement is ReturnStatementSyntax {
                        let returned ExpressionSyntax? = returnedStatement.Expression
                        if returned == nil {
                            continue
                        }
                        value = returned
                        position = returned.Span.End - 1
                        includeLaterStates = true
                    }
                    case yieldedStatement is YieldStatementSyntax when yieldedStatement.IsKind(
                        SyntaxKind.YieldReturnStatement
                    ) {
                        let yielded ExpressionSyntax? = yieldedStatement.Expression
                        if yielded == nil {
                            continue
                        }
                        value = yielded
                        position = yielded.Span.End - 1
                        includeLaterStates = true
                    }
                    case argument is ArgumentSyntax when !argument.RefOrOutKeyword.IsKind(SyntaxKind.OutKeyword) &&
                        (
                        this
                            .context
                            .GetTypeInfo(argument.Expression)
                            .ConvertedType ??
                            this
                            .context
                            .GetTypeInfo(argument.Expression)
                            .Type
                    )?.TypeKind == TypeKind
                        .Delegate {
                        let behavior = this.GetDelegateArgumentBehavior(argument)
                        if behavior == DelegateArgumentBehavior.NotObserved {
                            continue
                        }
                        value = argument.Expression
                        position = if argument.Parent?.Parent is InvocationExpressionSyntax escapedInvocation {
                            escapedInvocation.ArgumentList.CloseParenToken.SpanStart
                        } else {
                            argument.Span.End
                        }
                        includeLaterStates = behavior == DelegateArgumentBehavior.Escapes
                    }
                    default {
                        continue
                    }
                }
                let reachesCallable = if anonymousFunction != nil {
                    this.DelegateExpressionReachesAnonymousFunction(
                        value,
                        value!!.SpanStart,
                        anonymousFunction,
                        enclosingExecutable,
                        HashSet[ISymbol](SymbolEqualityComparer.Default)
                    )
                } else {
                    callable is IMethodSymbol escapedLocalFunction && this.DelegateExpressionReachesLocalFunction(
                        value,
                        value!!.SpanStart,
                        escapedLocalFunction,
                        HashSet[ISymbol](SymbolEqualityComparer.Default)
                    )
                }
                if reachesCallable {
                    yield position
                    if includeLaterStates {
                        for later in EagerExecutionNodes(executionBody).OfType[StatementSyntax]().Where(
                            (statement StatementSyntax) -> statement.SpanStart > escape!!.SpanStart
                        ) {
                            yield later.Span.End - 1
                        }
                    }
                }
            }
            if anonymousFunction == nil {
                if callable is IMethodSymbol escapedLocalFunction {
                    for assignment in EagerExecutionNodes(executionBody)
                        .OfType[AssignmentExpressionSyntax]()
                        .Where((candidate AssignmentExpressionSyntax) -> this.IsNonLocalDelegateStorage(candidate.Left))
                        .Where(
                        (candidate AssignmentExpressionSyntax) -> this.DelegateExpressionReachesLocalFunction(
                            candidate.Right,
                            candidate.Right.SpanStart,
                            escapedLocalFunction,
                            HashSet[ISymbol](SymbolEqualityComparer.Default)
                        )
                    ) {
                        for later in EagerExecutionNodes(executionBody).OfType[StatementSyntax]().Where(
                            (statement StatementSyntax) -> statement.SpanStart >= assignment.Span.End
                        ) {
                            yield later.Span.End - 1
                        }
                    }
                }
                yield break
            }
            for assignment in EagerExecutionNodes(executionBody).OfType[AssignmentExpressionSyntax]().Where(
                (candidate AssignmentExpressionSyntax) -> this.IsNonLocalDelegateStorage(candidate.Left)
            ) {
                if !this.DelegateExpressionReachesAnonymousFunction(
                    assignment.Right,
                    assignment.Right.SpanStart,
                    anonymousFunction,
                    enclosingExecutable,
                    HashSet[ISymbol](SymbolEqualityComparer.Default)
                ) {
                    continue
                }
                for later in EagerExecutionNodes(executionBody).OfType[StatementSyntax]().Where(
                    (statement StatementSyntax) -> statement.SpanStart >= assignment.Span.End
                ) {
                    let position = later.Span.End - 1
                    if this.NonLocalDelegateMayReferenceAnonymousFunction(
                        assignment.Left,
                        position,
                        anonymousFunction,
                        enclosingExecutable
                    ) {
                        yield position
                    }
                }
            }
        }

        private func GetDelegateArgumentBehavior(argument ArgumentSyntax) DelegateArgumentBehavior {
            let parameter IParameterSymbol? = DetermineParameter(argument, this.context)
            if parameter == nil || parameter.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                return DelegateArgumentBehavior.Escapes
            }
            if DelegateCalleeMayDispatchDynamically(argument, parameter) {
                return DelegateArgumentBehavior.Escapes
            }
            var invoked = false
            for reference in parameter.DeclaringSyntaxReferences {
                if reference.GetSyntax() is not ParameterSyntax declaration {
                    return DelegateArgumentBehavior.Escapes
                }
                let model = if declaration.SyntaxTree == this.context.SemanticModel.SyntaxTree {
                    this.context.SemanticModel
                } else {
                    this.context.Compilation.GetSemanticModel(declaration.SyntaxTree)
                }
                let executable SyntaxNode? = declaration.Ancestors().FirstOrDefault(
                    (node SyntaxNode) -> node is BaseMethodDeclarationSyntax ||
                        node is LocalFunctionStatementSyntax ||
                        node is AnonymousFunctionExpressionSyntax
                )
                if executable == nil {
                    return DelegateArgumentBehavior.Escapes
                }
                let body SyntaxNode? = switch executable {
                    case LocalFunctionStatementSyntax{Body: {} block}: cast[SyntaxNode](block)
                    case LocalFunctionStatementSyntax{ExpressionBody: {Expression: {} expression}}: cast[SyntaxNode](
                        expression
                    )
                    case anonymous is AnonymousFunctionExpressionSyntax: cast[SyntaxNode](anonymous.Body)
                    default: executable
                }
                let eagerUses = EagerExecutionNodes(body)
                    .OfType[IdentifierNameSyntax]()
                    .Where(
                    (identifier IdentifierNameSyntax) -> SymbolEqualityComparer.Default.Equals(
                        model.GetSymbolInfo(identifier).Symbol,
                        parameter
                    )
                )
                    .ToList()
                for use in eagerUses {
                    if DelegateParameterUseIsInvocation(use) {
                        invoked = true
                        continue
                    }
                    if DelegateParameterUseIsNonEscapingObservation(use, model) {
                        continue
                    }
                    let aliasBehavior = GetSourceDelegateAliasBehavior(
                        use,
                        body,
                        model,
                        HashSet[ISymbol](SymbolEqualityComparer.Default)
                    )
                    if aliasBehavior == DelegateArgumentBehavior.Escapes {
                        return DelegateArgumentBehavior.Escapes
                    }
                    invoked |= aliasBehavior == DelegateArgumentBehavior.InvokedDuringCall
                }
                let eagerUseStarts = eagerUses.Select((use IdentifierNameSyntax) -> use.SpanStart).ToHashSet()
                let capturedByNestedExecutable = body!!
                    .DescendantNodes()
                    .OfType[IdentifierNameSyntax]()
                    .Any(
                    (identifier IdentifierNameSyntax) -> !eagerUseStarts.Contains(identifier.SpanStart) &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(model.GetSymbolInfo(identifier).Symbol, parameter)
                )
                if capturedByNestedExecutable {
                    return DelegateArgumentBehavior.Escapes
                }
            }
            return if invoked {
                DelegateArgumentBehavior.InvokedDuringCall
            } else {
                DelegateArgumentBehavior.NotObserved
            }
        }

        private func DelegateExpressionReachesLocalFunction(
            expression ExpressionSyntax?,
            usePosition int32,
            localFunction IMethodSymbol,
            visited HashSet[ISymbol]
        ) bool {
            for candidate in expression!!.DescendantNodesAndSelf().OfType[ExpressionSyntax]() {
                if candidate.SyntaxTree != this.context.SemanticModel.SyntaxTree {
                    continue
                }
                let symbol ISymbol? = this.context.GetSymbolInfo(candidate).Symbol
                if LocalFunctionMatches(symbol, localFunction) {
                    return true
                }
                if symbol is ILocalSymbol delegateLocal &&
                    delegateLocal
                    .Type
                    .TypeKind == TypeKind.Delegate &&
                    this
                    .DelegateLocalReachesLocalFunction(
                    delegateLocal,
                    usePosition,
                    localFunction,
                    HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                ) {
                    return true
                }
                if candidate is InvocationExpressionSyntax && symbol is IMethodSymbol factory && visited.Add(
                    factory.OriginalDefinition
                ) {
                    for returned in this.GetSourceCallableReturnExpressions(factory) {
                        if this.DelegateExpressionReachesLocalFunction(
                            returned,
                            returned!!.SpanStart,
                            localFunction,
                            HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                        ) {
                            return true
                        }
                    }
                }
            }
            return false
        }

        private func DelegateLocalReachesLocalFunction(
            local ILocalSymbol,
            usePosition int32,
            localFunction IMethodSymbol,
            visited HashSet[ISymbol]
        ) bool {
            if !visited.Add(local) {
                return false
            }
            for value in this.GetReachingLocalValues(local, usePosition, preserveDelegateCompoundAssignments: true) {
                for expression in value.DescendantNodesAndSelf().OfType[ExpressionSyntax]() {
                    if expression.SyntaxTree != this.context.SemanticModel.SyntaxTree {
                        continue
                    }
                    let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
                    if LocalFunctionMatches(symbol, localFunction) {
                        return true
                    }
                    if symbol is ILocalSymbol alias &&
                        alias
                        .Type
                        .TypeKind == TypeKind.Delegate &&
                        this
                        .DelegateLocalReachesLocalFunction(
                        alias,
                        expression.SpanStart,
                        localFunction,
                        HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                    ) {
                        return true
                    }
                    if expression is InvocationExpressionSyntax && symbol is IMethodSymbol factory && visited.Add(
                        factory.OriginalDefinition
                    ) {
                        for returned in this.GetSourceCallableReturnExpressions(factory) {
                            if this.DelegateExpressionReachesLocalFunction(
                                returned,
                                returned!!.SpanStart,
                                localFunction,
                                HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                            ) {
                                return true
                            }
                        }
                    }
                }
            }
            return false
        }

        private func DelegateExpressionReachesAnonymousFunction(
            expression ExpressionSyntax?,
            usePosition int32,
            anonymousFunction AnonymousFunctionExpressionSyntax?,
            enclosingExecutable SyntaxNode?,
            visited HashSet[ISymbol]
        ) bool {
            if expression!!.DescendantNodesAndSelf().Any(
                (node SyntaxNode) -> node.SyntaxTree == anonymousFunction!!.SyntaxTree &&
                    node.Span == anonymousFunction!!.Span
            ) {
                return true
            }
            for candidate in expression!!.DescendantNodesAndSelf().OfType[ExpressionSyntax]() {
                if candidate.SyntaxTree != this.context.SemanticModel.SyntaxTree {
                    continue
                }
                let symbol ISymbol? = this.context.GetSymbolInfo(candidate).Symbol
                if symbol is ILocalSymbol local &&
                    local
                    .Type
                    .TypeKind == TypeKind.Delegate &&
                    this
                    .DelegateLocalReachesAnonymousFunction(
                    local,
                    usePosition,
                    anonymousFunction,
                    HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                ) {
                    return true
                }
                if (symbol is IFieldSymbol || symbol is IPropertySymbol || symbol is IEventSymbol) &&
                    this
                    .NonLocalDelegateMayReferenceAnonymousFunction(
                    candidate,
                    usePosition,
                    anonymousFunction,
                    enclosingExecutable
                ) {
                    return true
                }
                if candidate is InvocationExpressionSyntax && symbol is IMethodSymbol factory && visited.Add(
                    factory.OriginalDefinition
                ) {
                    for returned in this.GetSourceCallableReturnExpressions(factory) {
                        if this.DelegateExpressionReachesAnonymousFunction(
                            returned,
                            returned!!.SpanStart,
                            anonymousFunction,
                            FindEnclosingExecutable(returned),
                            HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                        ) {
                            return true
                        }
                    }
                }
            }
            return false
        }

        private func GetSourceCallableReturnExpressions(method IMethodSymbol?) sequence[ExpressionSyntax?] {
            for reference in method!!.OriginalDefinition.DeclaringSyntaxReferences {
                let declaration = reference.GetSyntax()
                if declaration.SyntaxTree != this.context.SemanticModel.SyntaxTree {
                    continue
                }
                switch declaration {
                    case MethodDeclarationSyntax{ExpressionBody: {Expression: {} expression}} {
                        yield expression
                        continue
                    }
                    case LocalFunctionStatementSyntax{ExpressionBody: {Expression: {} expression}} {
                        yield expression
                        continue
                    }
                }
                let body SyntaxNode? = switch declaration {
                    case BaseMethodDeclarationSyntax{Body: {} block}: block
                    case LocalFunctionStatementSyntax{Body: {} block}: block
                    default: default(BlockSyntax?)
                }
                if body == nil {
                    continue
                }
                for returned in EagerExecutionNodes(body).OfType[ReturnStatementSyntax]().Where(
                    (statement ReturnStatementSyntax) -> statement.Expression != nil
                ) {
                    yield returned.Expression
                }
            }
        }

        private func NonLocalDelegateMayReferenceAnonymousFunction(
            storage ExpressionSyntax,
            usePosition int32,
            anonymousFunction AnonymousFunctionExpressionSyntax?,
            enclosingExecutable SyntaxNode?
        ) bool {
            if !this.IsNonLocalDelegateStorage(storage) {
                return false
            }
            var graph ControlFlowGraph?
            try {
                graph = this.CreateControlFlowGraph(enclosingExecutable)
            } catch (ArgumentException) {
                return false
            }
            var useBlock BasicBlock? = nil
            var useOperationIndex = -1
            for block in graph!!.Blocks {
                for var i = 0; i < block.Operations.Length; i++ {
                    if block.Operations[i].Syntax.FullSpan.Contains(usePosition) {
                        useBlock = block
                        useOperationIndex = i
                        break
                    }
                }
                if useBlock == nil && block.BranchValue?.Syntax.FullSpan.Contains(usePosition) == true {
                    useBlock = block
                    useOperationIndex = block.Operations.Length
                }
                if useBlock != nil {
                    break
                }
            }
            if useBlock?.IsReachable != true {
                return false
            }
            let outputs = Dictionary[BasicBlock, HashSet[int32]]()
            var changed bool
            do {
                changed = false
                for block in graph!!.Blocks {
                    if !block.IsReachable {
                        continue
                    }
                    var states = HashSet[int32]()
                    if block.Kind == BasicBlockKind.Entry {
                        states.Add(0)
                    }
                    for predecessor in block.Predecessors {
                        if outputs.TryGetValue(predecessor.Source, out var predecessorStates) {
                            states.UnionWith(predecessorStates)
                        }
                    }
                    for operation in block.Operations {
                        states = this.ApplyDelegateReachingOperation(
                            operation,
                            storage,
                            states,
                            anonymousFunction,
                            usePosition
                        )
                    }
                    if block.BranchValue is {} branchValue {
                        states = this.ApplyDelegateReachingOperation(
                            branchValue,
                            storage,
                            states,
                            anonymousFunction,
                            usePosition
                        )
                    }
                    if !outputs.TryGetValue(block, out var previous) || !previous.SetEquals(states) {
                        outputs[block] = states
                        changed = true
                    }
                }
            } while changed
            var reaching = HashSet[int32]()
            for predecessor in useBlock!!.Predecessors {
                if outputs.TryGetValue(predecessor.Source, out var predecessorStates) {
                    reaching.UnionWith(predecessorStates)
                }
            }
            for var i = 0; i < useOperationIndex; i++ {
                reaching = this.ApplyDelegateReachingOperation(
                    useBlock!!.Operations[i],
                    storage,
                    reaching,
                    anonymousFunction,
                    usePosition
                )
            }
            if useOperationIndex < useBlock!!.Operations.Length {
                reaching = this.ApplyDelegateReachingOperation(
                    useBlock!!.Operations[useOperationIndex],
                    storage,
                    reaching,
                    anonymousFunction,
                    usePosition,
                    usePosition
                )
            } else if useBlock!!.BranchValue is {} branchValue {
                reaching = this.ApplyDelegateReachingOperation(
                    branchValue,
                    storage,
                    reaching,
                    anonymousFunction,
                    usePosition,
                    usePosition
                )
            }
            return reaching.Any((count int32) -> count > 0)
        }

        private func IsNonLocalDelegateStorage(expression ExpressionSyntax?) bool {
            var expression = expression
            expression = Unwrap(expression)
            return (this.context.GetSymbolInfo(expression).Symbol is IFieldSymbol or IPropertySymbol or IEventSymbol) ||
                (
                expression is ElementAccessExpressionSyntax &&
                    this
                    .context
                    .GetTypeInfo(expression)
                    .Type
                    ?.TypeKind == TypeKind.Delegate
            )
        }

        private func ApplyDelegateReachingOperation(
            operation IOperation,
            storage ExpressionSyntax,
            states HashSet[int32],
            anonymousFunction AnonymousFunctionExpressionSyntax?,
            storageUsePosition int32,
            beforePosition int32 = 2147483647
        ) HashSet[int32] {
            var states = states
            for assignment in EagerExecutionNodes(operation.Syntax)
                .OfType[AssignmentExpressionSyntax]()
                .Where((candidate AssignmentExpressionSyntax) -> candidate.Span.End <= beforePosition)
                .Where(
                (candidate AssignmentExpressionSyntax) -> this.DelegateStorageMatches(
                    candidate.Left,
                    storage,
                    storageUsePosition
                )
            )
                .OrderBy((candidate AssignmentExpressionSyntax) -> candidate.Span.End) {
                let next = HashSet[int32]()
                let opaqueStorage = this.IsOpaqueDelegateStorage(storage)
                for state in states {
                    let rightCount = this.DelegateAssignmentValueAnonymousFunctionCount(
                        assignment.Right,
                        state,
                        storage,
                        anonymousFunction,
                        storageUsePosition
                    )
                    if opaqueStorage {
                        // A property's accessors may ignore or transform what is
                        // stored, so a write never proves the earlier delegate
                        // is gone: keep the prior state beside the written one.
                        next.Add(state)
                    }
                    next.Add(
                        switch assignment.Kind() {
                            case SyntaxKind.AddAssignmentExpression: Math.Min(2, state + rightCount)
                            case SyntaxKind.SubtractAssignmentExpression: if state == 1 && rightCount == 1 {
                                0
                            } else {
                                state
                            }
                            default: rightCount
                        }
                    )
                }
                states = next
            }
            return states
        }

        private func DelegateAssignmentValueAnonymousFunctionCount(
            expression ExpressionSyntax?,
            currentState int32,
            trackedStorage ExpressionSyntax,
            anonymousFunction AnonymousFunctionExpressionSyntax?,
            trackedStorageUsePosition int32
        ) int32 {
            var expression = expression
            expression = Unwrap(expression)
            if expression!!.DescendantNodesAndSelf().Any(
                (node SyntaxNode) -> node.SyntaxTree == anonymousFunction!!.SyntaxTree &&
                    node.Span == anonymousFunction!!.Span
            ) {
                return 1
            }
            if this.DelegateStorageMatches(expression, trackedStorage, trackedStorageUsePosition) {
                return currentState
            }
            if this
                .context
                .GetSymbolInfo(expression)
                .Symbol is ILocalSymbol local &&
                local
                .Type
                .TypeKind == TypeKind
                .Delegate {
                return if this.DelegateLocalReachesAnonymousFunction(
                    local,
                    expression!!.SpanStart,
                    anonymousFunction,
                    HashSet[ISymbol](SymbolEqualityComparer.Default)
                ) {
                    1
                } else {
                    0
                }
            }
            return switch expression {
                case conditional is ConditionalExpressionSyntax: Math.Max(
                    this.DelegateAssignmentValueAnonymousFunctionCount(
                        conditional.WhenTrue,
                        currentState,
                        trackedStorage,
                        anonymousFunction,
                        trackedStorageUsePosition
                    ),
                    this.DelegateAssignmentValueAnonymousFunctionCount(
                        conditional.WhenFalse,
                        currentState,
                        trackedStorage,
                        anonymousFunction,
                        trackedStorageUsePosition
                    )
                )
                case binary is BinaryExpressionSyntax when binary.IsKind(SyntaxKind.AddExpression): AddDelegateCounts(
                    this.DelegateAssignmentValueAnonymousFunctionCount(
                        binary.Left,
                        currentState,
                        trackedStorage,
                        anonymousFunction,
                        trackedStorageUsePosition
                    ),
                    this.DelegateAssignmentValueAnonymousFunctionCount(
                        binary.Right,
                        currentState,
                        trackedStorage,
                        anonymousFunction,
                        trackedStorageUsePosition
                    )
                )
                case binary is BinaryExpressionSyntax when binary.IsKind(SyntaxKind.CoalesceExpression): Math.Max(
                    this.DelegateAssignmentValueAnonymousFunctionCount(
                        binary.Left,
                        currentState,
                        trackedStorage,
                        anonymousFunction,
                        trackedStorageUsePosition
                    ),
                    this.DelegateAssignmentValueAnonymousFunctionCount(
                        binary.Right,
                        currentState,
                        trackedStorage,
                        anonymousFunction,
                        trackedStorageUsePosition
                    )
                )
                default: 0
            }
        }

        // Field-like storage (fields, events, array elements) holds exactly what
        // was written; a property does not. Anything whose writes cannot be
        // proven to replace the stored delegate is opaque and only ever widens.
        private func IsOpaqueDelegateStorage(storage ExpressionSyntax) bool -> this
            .context
            .GetSymbolInfo(Unwrap(storage))
            .Symbol is IPropertySymbol

        private func DelegateStorageMatches(
            left ExpressionSyntax?,
            right ExpressionSyntax?,
            rightUsePosition int32? = nil
        ) bool {
            var left = left
            var right = right
            left = Unwrap(left)
            right = Unwrap(right)
            if left is ElementAccessExpressionSyntax || right is ElementAccessExpressionSyntax {
                if left is not ElementAccessExpressionSyntax leftElement ||
                    right is not ElementAccessExpressionSyntax rightElement {
                    return false
                }
                return this.IndexedDelegateStorageMatches(leftElement, rightElement, rightUsePosition)
            }
            let leftSymbol ISymbol? = this.context.GetSymbolInfo(left).Symbol
            let rightSymbol ISymbol? = this.context.GetSymbolInfo(right).Symbol
            if !SymbolEqualityComparer.Default.Equals(leftSymbol, rightSymbol) {
                return false
            }
            if leftSymbol?.IsStatic == true {
                return true
            }
            let leftReceiver ExpressionSyntax? = (left as MemberAccessExpressionSyntax)?.Expression
            let rightReceiver ExpressionSyntax? = (right as MemberAccessExpressionSyntax)?.Expression
            if leftReceiver == nil || rightReceiver == nil {
                let explicitReceiver ExpressionSyntax? = leftReceiver ?? rightReceiver
                return explicitReceiver == nil || explicitReceiver is ThisExpressionSyntax
            }
            if leftReceiver is ThisExpressionSyntax || rightReceiver is ThisExpressionSyntax {
                return leftReceiver is ThisExpressionSyntax && rightReceiver is ThisExpressionSyntax
            }
            return this.DelegateReceiverMatches(leftReceiver, rightReceiver, rightUsePosition)
        }

        private func DelegateReceiverMatches(
            left ExpressionSyntax?,
            right ExpressionSyntax?,
            rightUsePosition int32? = nil
        ) bool {
            var left = left
            var right = right
            left = Unwrap(left)
            right = Unwrap(right)
            let leftSymbol ISymbol? = this.context.GetSymbolInfo(left).Symbol
            let rightSymbol ISymbol? = this.context.GetSymbolInfo(right).Symbol
            if leftSymbol is ILocalSymbol ||
                leftSymbol is IParameterSymbol ||
                rightSymbol is ILocalSymbol ||
                rightSymbol is IParameterSymbol {
                let leftOrigins = this.GetIndexedDelegateReceiverOrigins(
                    left,
                    HashSet[ISymbol](SymbolEqualityComparer.Default)
                )
                let rightOrigins = this.GetIndexedDelegateReceiverOrigins(
                    right,
                    HashSet[ISymbol](SymbolEqualityComparer.Default),
                    rightUsePosition
                )
                if leftOrigins.Count == 0 || rightOrigins.Count == 0 {
                    return SymbolEqualityComparer.Default.Equals(leftSymbol, rightSymbol)
                }
                return this.DelegateOriginSetsMatch(leftOrigins, rightOrigins)
            }
            if left is ThisExpressionSyntax || right is ThisExpressionSyntax {
                return left is ThisExpressionSyntax && right is ThisExpressionSyntax
            }
            if left is MemberAccessExpressionSyntax leftMember && right is MemberAccessExpressionSyntax rightMember {
                return SymbolEqualityComparer.Default.Equals(
                    this.context.GetSymbolInfo(leftMember).Symbol,
                    this.context.GetSymbolInfo(rightMember).Symbol
                ) &&
                    this.DelegateReceiverMatches(leftMember.Expression, rightMember.Expression, rightUsePosition)
            }
            if left is ElementAccessExpressionSyntax leftElement &&
                right is ElementAccessExpressionSyntax rightElement {
                return this.IndexedDelegateStorageMatches(leftElement, rightElement, rightUsePosition)
            }
            return leftSymbol != nil && SymbolEqualityComparer.Default.Equals(leftSymbol, rightSymbol)
        }

        private func IndexedDelegateStorageMatches(
            left ElementAccessExpressionSyntax,
            right ElementAccessExpressionSyntax,
            rightUsePosition int32? = nil
        ) bool {
            if left.ArgumentList.Arguments.Count != right.ArgumentList.Arguments.Count {
                return false
            }
            for var i = 0; i < left.ArgumentList.Arguments.Count; i++ {
                let leftIndex = this.context.SemanticModel.GetConstantValue(left.ArgumentList.Arguments[i].Expression)
                let rightIndex = this.context.SemanticModel.GetConstantValue(right.ArgumentList.Arguments[i].Expression)
                let leftIndexSymbol ISymbol? = this
                    .context
                    .GetSymbolInfo(left.ArgumentList.Arguments[i].Expression)
                    .Symbol
                let rightIndexSymbol ISymbol? = this
                    .context
                    .GetSymbolInfo(right.ArgumentList.Arguments[i].Expression)
                    .Symbol
                if !((leftIndexSymbol is ILocalSymbol || leftIndexSymbol is IParameterSymbol)) &&
                    !((rightIndexSymbol is ILocalSymbol || rightIndexSymbol is IParameterSymbol)) &&
                    leftIndex.HasValue &&
                    rightIndex.HasValue {
                    if !object.Equals(leftIndex.Value, rightIndex.Value) {
                        return false
                    }
                    continue
                }
                let leftIndexOrigins = this.GetIndexedDelegateReceiverOrigins(
                    left.ArgumentList.Arguments[i].Expression,
                    HashSet[ISymbol](SymbolEqualityComparer.Default)
                )
                let rightIndexOrigins = this.GetIndexedDelegateReceiverOrigins(
                    right.ArgumentList.Arguments[i].Expression,
                    HashSet[ISymbol](SymbolEqualityComparer.Default),
                    rightUsePosition
                )
                if !this.DelegateOriginSetsMatch(leftIndexOrigins, rightIndexOrigins) {
                    return false
                }
            }
            let leftOrigins = this.GetIndexedDelegateReceiverOrigins(
                left.Expression,
                HashSet[ISymbol](SymbolEqualityComparer.Default)
            )
            let rightOrigins = this.GetIndexedDelegateReceiverOrigins(
                right.Expression,
                HashSet[ISymbol](SymbolEqualityComparer.Default),
                rightUsePosition
            )
            return this.DelegateOriginSetsMatch(leftOrigins, rightOrigins)
        }

        private func DelegateOriginSetsMatch(
            left IReadOnlyList[ExpressionSyntax],
            right IReadOnlyList[ExpressionSyntax]
        ) bool {
            return left.Count > 0 && right.Count > 0 && left.Any(
                (leftOrigin ExpressionSyntax) -> right.Any(
                    (rightOrigin ExpressionSyntax) -> this.IndexedDelegateReceiverOriginMatches(leftOrigin, rightOrigin)
                )
            )
        }

        private func GetIndexedDelegateReceiverOrigins(
            expression ExpressionSyntax?,
            visited HashSet[ISymbol],
            usePosition int32? = nil
        ) IReadOnlyList[ExpressionSyntax] {
            var expression = expression
            expression = Unwrap(expression)
            if expression!!.SyntaxTree != this.context.SemanticModel.SyntaxTree {
                return Array.Empty[ExpressionSyntax]()
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
            if symbol is ILocalSymbol local {
                if !visited.Add(local) {
                    return Array.Empty[ExpressionSyntax]()
                }
                let reaching = this.GetReachingLocalValues(
                    local,
                    usePosition ?? expression!!.SpanStart,
                    HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                )
                if reaching.Count == 0 {
                    return []ExpressionSyntax{expression!!}
                }
                return reaching.SelectMany(
                    func (value ExpressionSyntax) IEnumerable[ExpressionSyntax] {
                        return this.GetIndexedDelegateReceiverOrigins(
                            value,
                            HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                        )
                    }
                )
                    .ToList()
            }
            if usePosition is int32 observationPosition &&
                (symbol is IParameterSymbol || symbol is IFieldSymbol) &&
                this
                .TryGetDefiniteAssignmentsBetween(symbol, expression, observationPosition, out var assignedValues) {
                return assignedValues!!.SelectMany(
                    func (assignedValue ExpressionSyntax) IEnumerable[ExpressionSyntax] {
                        return this.GetIndexedDelegateReceiverOrigins(
                            assignedValue,
                            HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                        )
                    }
                )
                    .ToList()
            }
            if symbol is IPropertySymbol || symbol is IMethodSymbol || expression is InvocationExpressionSyntax {
                return Array.Empty[ExpressionSyntax]()
            }
            return []ExpressionSyntax{expression!!}
        }

        private func TryGetDefiniteAssignmentsBetween(
            symbol ISymbol?,
            start ExpressionSyntax?,
            usePosition int32,
            out assignedValues IReadOnlyList[ExpressionSyntax]?
        ) bool {
            assignedValues = nil
            let startStatement StatementSyntax? = start!!.AncestorsAndSelf().OfType[StatementSyntax]().FirstOrDefault()
            let useStatement StatementSyntax? = start!!
                .SyntaxTree
                .GetRoot()
                .FindToken(usePosition)
                .Parent
                ?.AncestorsAndSelf()
                .OfType[StatementSyntax]()
                .FirstOrDefault()
            if startStatement?.Parent is not BlockSyntax block || useStatement?.Parent != block {
                return false
            }
            let startIndex = block.Statements.IndexOf(startStatement!!)
            let useIndex = block.Statements.IndexOf(useStatement!!)
            if startIndex < 0 || useIndex <= startIndex {
                return false
            }
            for statement in block.Statements.Skip(startIndex + 1).Take(useIndex - startIndex - 1) {
                if statement is ExpressionStatementSyntax expressionStatement &&
                    expressionStatement.Expression is AssignmentExpressionSyntax assignment &&
                    assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) && this.BindsTo(assignment.Left, symbol) {
                    assignedValues = []ExpressionSyntax{assignment.Right}
                    continue
                }
                let flow DataFlowAnalysis? = this.context.SemanticModel.AnalyzeDataFlow(statement)
                if flow!!.Succeeded && flow!!.AlwaysAssigned.Any(
                    (assigned ISymbol) -> SymbolEqualityComparer.Default.Equals(assigned, symbol)
                ) {
                    let values = statement
                        .DescendantNodes()
                        .OfType[AssignmentExpressionSyntax]()
                        .Where(
                        (candidate AssignmentExpressionSyntax) -> candidate.IsKind(
                            SyntaxKind.SimpleAssignmentExpression
                        ) &&
                            this.BindsTo(candidate.Left, symbol)
                    )
                        .Select((candidate AssignmentExpressionSyntax) -> candidate.Right)
                        .ToList()
                    if values.Count > 0 {
                        assignedValues = values
                    }
                }
                if symbol is IFieldSymbol && this.TryGetDefinitelyAssignedValues(
                    statement,
                    symbol,
                    out var fieldValues
                ) {
                    assignedValues = fieldValues
                }
            }
            return assignedValues != nil
        }

        private func TryGetDefinitelyAssignedValues(
            statement StatementSyntax,
            symbol ISymbol?,
            out values IReadOnlyList[ExpressionSyntax]?
        ) bool {
            if statement is ExpressionStatementSyntax expressionStatement &&
                expressionStatement.Expression is AssignmentExpressionSyntax assignment &&
                assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) && this.BindsTo(assignment.Left, symbol) {
                values = []ExpressionSyntax{assignment.Right}
                return true
            }
            if statement is BlockSyntax block {
                for nested in block.Statements.Reverse() {
                    if this.TryGetDefinitelyAssignedValues(nested, symbol, out values) {
                        return true
                    }
                }
            }
            if statement is IfStatementSyntax conditional &&
                conditional
                .Else
                ?.Statement is {} whenFalse &&
                this.TryGetDefinitelyAssignedValues(conditional.Statement, symbol, out var whenTrueValues) &&
                this
                .TryGetDefinitelyAssignedValues(whenFalse, symbol, out var whenFalseValues) {
                values = whenTrueValues!!.Concat(whenFalseValues!!).ToList()
                return true
            }
            values = nil
            return false
        }

        private func IndexedDelegateReceiverOriginMatches(left ExpressionSyntax?, right ExpressionSyntax?) bool {
            var left = left
            var right = right
            left = Unwrap(left)
            right = Unwrap(right)
            if left!!.SyntaxTree == right!!.SyntaxTree && left!!.Span == right!!.Span {
                return true
            }
            // Equivalent constants at different syntax locations (`0` in
            // `xs[0]` and in `var i = 0; xs[i]`) are the same origin.
            let leftConstant = this.context.SemanticModel.GetConstantValue(left!!)
            let rightConstant = this.context.SemanticModel.GetConstantValue(right!!)
            if leftConstant.HasValue && rightConstant.HasValue {
                return object.Equals(leftConstant.Value, rightConstant.Value)
            }
            let leftSymbol ISymbol? = this.context.GetSymbolInfo(left).Symbol
            let rightSymbol ISymbol? = this.context.GetSymbolInfo(right).Symbol
            if leftSymbol is IParameterSymbol || leftSymbol is ILocalSymbol {
                return SymbolEqualityComparer.Default.Equals(leftSymbol, rightSymbol)
            }
            if !(leftSymbol is IFieldSymbol) || !SymbolEqualityComparer.Default.Equals(leftSymbol, rightSymbol) {
                return left is ThisExpressionSyntax && right is ThisExpressionSyntax
            }
            let leftReceiver ExpressionSyntax? = (left as MemberAccessExpressionSyntax)?.Expression
            let rightReceiver ExpressionSyntax? = (right as MemberAccessExpressionSyntax)?.Expression
            if leftReceiver == nil || rightReceiver == nil {
                return leftReceiver == nil && rightReceiver == nil
            }
            let leftOrigins = this.GetIndexedDelegateReceiverOrigins(
                leftReceiver,
                HashSet[ISymbol](SymbolEqualityComparer.Default)
            )
            let rightOrigins = this.GetIndexedDelegateReceiverOrigins(
                rightReceiver,
                HashSet[ISymbol](SymbolEqualityComparer.Default)
            )
            return this.DelegateOriginSetsMatch(leftOrigins, rightOrigins)
        }

        private func DelegateLocalReachesAnonymousFunction(
            local ILocalSymbol,
            usePosition int32,
            anonymousFunction AnonymousFunctionExpressionSyntax?,
            visited HashSet[ISymbol]
        ) bool {
            if !visited.Add(local) {
                return false
            }
            for value in this.GetReachingLocalValues(local, usePosition, preserveDelegateCompoundAssignments: true) {
                if value.DescendantNodesAndSelf().Any(
                    (node SyntaxNode) -> node.SyntaxTree == anonymousFunction!!.SyntaxTree &&
                        node.Span == anonymousFunction!!.Span
                ) {
                    return true
                }
                for expression in value.DescendantNodesAndSelf().OfType[ExpressionSyntax]() {
                    if expression.SyntaxTree == this
                        .context
                        .SemanticModel
                        .SyntaxTree &&
                        this
                        .context
                        .GetSymbolInfo(expression)
                        .Symbol is ILocalSymbol alias &&
                        alias
                        .Type
                        .TypeKind == TypeKind.Delegate &&
                        this
                        .DelegateLocalReachesAnonymousFunction(
                        alias,
                        expression.SpanStart,
                        anonymousFunction,
                        HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                    ) {
                        return true
                    }
                    if expression.SyntaxTree == this
                        .context
                        .SemanticModel
                        .SyntaxTree &&
                        expression is InvocationExpressionSyntax &&
                        this
                        .context
                        .GetSymbolInfo(expression)
                        .Symbol is IMethodSymbol factory &&
                        visited
                        .Add(factory.OriginalDefinition) {
                        for returned in this.GetSourceCallableReturnExpressions(factory) {
                            if this.DelegateExpressionReachesAnonymousFunction(
                                returned,
                                returned!!.SpanStart,
                                anonymousFunction,
                                FindEnclosingExecutable(returned),
                                HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                            ) {
                                return true
                            }
                        }
                    }
                }
            }
            return false
        }

        private func CreateControlFlowGraph(executable SyntaxNode?) ControlFlowGraph? {
            if executable is LocalFunctionStatementSyntax localFunction {
                let parent ControlFlowGraph? = this.CreateControlFlowGraph(FindEnclosingExecutable(executable))
                let symbol IMethodSymbol? = this.context.SemanticModel.GetDeclaredSymbol(localFunction)
                return ControlFlowGraphExtensions.GetLocalFunctionControlFlowGraphInScope(parent!!, symbol!!)
            }
            if executable is AnonymousFunctionExpressionSyntax anonymousFunction {
                let parent ControlFlowGraph? = this.CreateControlFlowGraph(FindEnclosingExecutable(executable))
                let operation = parent!!
                    .Blocks
                    .SelectMany(BlockOperationsAndBranchValue)
                    .SelectMany(
                    func (operation IOperation) IEnumerable[IOperation] {
                        return operation.DescendantsAndSelf()
                    }
                )
                    .OfType[IFlowAnonymousFunctionOperation]()
                    .First(
                    (candidate IFlowAnonymousFunctionOperation) -> candidate
                        .Syntax
                        .SyntaxTree == anonymousFunction.SyntaxTree &&
                        candidate
                        .Syntax
                        .Span == anonymousFunction.Span
                )
                return ControlFlowGraphExtensions.GetAnonymousFunctionControlFlowGraphInScope(parent!!, operation)
            }
            if executable is EqualsValueClauseSyntax || executable is ArrowExpressionClauseSyntax {
                let expression = switch executable {
                    case initializer is EqualsValueClauseSyntax: initializer.Value
                    case arrow is ArrowExpressionClauseSyntax: arrow.Expression
                    default: throw InvalidOperationException()
                }
                var operation IOperation? = this.context.SemanticModel.GetOperation(expression)
                while operation?.Parent != nil {
                    operation = operation!!.Parent
                }
                return switch operation {
                    case block is IBlockOperation: ControlFlowGraph.Create(block)
                    case field is IFieldInitializerOperation: ControlFlowGraph.Create(field)
                    case property is IPropertyInitializerOperation: ControlFlowGraph.Create(property)
                    case body is IMethodBodyOperation: ControlFlowGraph.Create(body)
                    default: throw ArgumentException("The expression does not have a control-flow root.", "executable")
                }
            }
            if executable is PrimaryConstructorBaseTypeSyntax primaryBase {
                let expression = primaryBase.ArgumentList.Arguments.First().Expression
                var operation IOperation? = this.context.SemanticModel.GetOperation(expression)
                while operation?.Parent != nil {
                    operation = operation!!.Parent
                }
                return switch operation {
                    case body is IConstructorBodyOperation: ControlFlowGraph.Create(body)
                    case block is IBlockOperation: ControlFlowGraph.Create(block)
                    default: throw ArgumentException(
                        "The base initializer does not have a control-flow root.",
                        "executable"
                    )
                }
            }
            return ControlFlowGraph.Create(executable!!, this.context.SemanticModel)
        }

        private func ApplyReachingOperation(
            operation IOperation,
            declaration SyntaxNode?,
            initializer ExpressionSyntax?,
            local ILocalSymbol,
            values HashSet[ExpressionSyntax],
            assignedValues Dictionary[AssignmentExpressionSyntax, ExpressionSyntax],
            elementAssignedValues Dictionary[(Write string, Previous string), ExpressionSyntax],
            visited HashSet[ISymbol]?,
            unknownTuple ExpressionSyntax,
            preserveDelegateCompoundAssignments bool,
            beforePosition int32 = 2147483647
        ) {
            if declaration!!.SpanStart < beforePosition && operation.Syntax.FullSpan.Contains(declaration!!.Span) {
                values.Clear()
                if initializer != nil {
                    values.Add(initializer)
                }
            }
            for writeNode in EagerExecutionNodes(operation.Syntax)
                .Where((node SyntaxNode) -> ReachingWritePosition(node) <= beforePosition)
                .Where(
                (node SyntaxNode) -> node is AssignmentExpressionSyntax || this.ReachingWriteTargetsLocal(node, local)
            )
                .OrderBy(ReachingWritePosition)
                .ThenBy((node SyntaxNode) -> node.SpanStart) {
                if local.RefKind != RefKind.None &&
                    (
                    writeNode is not AssignmentExpressionSyntax refAssignment || !this.BindsTo(
                        refAssignment.Left,
                        local
                    ) ||
                        !(refAssignment.Right is RefExpressionSyntax)
                ) {
                    continue
                }
                let elementWrites = List[(Path IReadOnlyList[int32]?, Value ExpressionSyntax)]()
                if writeNode is ArgumentSyntax argument && this.TryFindTupleElementWritePath(
                    argument.Expression,
                    local,
                    List[int32](),
                    out var argumentPath
                ) {
                    elementWrites.Add((argumentPath, SyntaxFactory.IdentifierName("__unknown")))
                }
                if writeNode is not AssignmentExpressionSyntax assignment {
                    if elementWrites.Count > 0 {
                        // Roslyn yields concrete nodes; self-migration imports LINQ elements as platform-typed.
                        this.ApplyTupleElementWrites(
                            writeNode!!,
                            elementWrites,
                            local,
                            values,
                            elementAssignedValues,
                            visited,
                            unknownTuple
                        )
                        continue
                    }
                    if writeNode is ArgumentSyntax refOrOutArgument {
                        if !refOrOutArgument.RefOrOutKeyword.IsKind(SyntaxKind.RefKeyword) {
                            values.Clear()
                        }
                        values.Add(unknownTuple)
                        continue
                    }
                    if writeNode is RefExpressionSyntax {
                        continue
                    }
                    values.Clear()
                    continue
                }
                this.CollectTupleElementWrites(assignment.Left, assignment.Right, local, elementWrites)
                if !elementWrites.Any(
                    (write(Path IReadOnlyList[int32], Value ExpressionSyntax)) -> write.Path.Count > 0
                ) {
                    elementWrites.Clear()
                }
                if elementWrites.Count > 0 {
                    // Roslyn yields concrete nodes; self-migration imports LINQ elements as platform-typed.
                    this.ApplyTupleElementWrites(
                        writeNode,
                        elementWrites,
                        local,
                        values,
                        elementAssignedValues,
                        visited,
                        unknownTuple
                    )
                    continue
                }
                if !TryFindAssignedValuePath(assignment.Left, local, List[int32](), out var path) {
                    continue
                }
                let preserveExistingValues = preserveDelegateCompoundAssignments &&
                    (
                    assignment.IsKind(SyntaxKind.AddAssignmentExpression) || assignment.IsKind(
                        SyntaxKind.SubtractAssignmentExpression
                    )
                )
                if !preserveExistingValues {
                    values.Clear()
                }
                if !assignedValues.TryGetValue(assignment, out var value) {
                    let aliasPath HashSet[ISymbol]? = if visited == nil {
                        default(HashSet[ISymbol]?)
                    } else {
                        HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                    }
                    // ResolveStableTupleAlias returns its input or a reaching value, never null;
                    // self-migration types that result as nullable (issue #4598).
                    let source ExpressionSyntax? = this.ResolveStableTupleAlias(assignment.Right, aliasPath)!!
                    // ProjectTupleElement never returns null; self-migration types
                    // the result as nullable (issue #4598).
                    value = ProjectTupleElement(source, path)!!
                    assignedValues.Add(assignment, value)
                }
                if preserveDelegateCompoundAssignments && assignment.IsKind(SyntaxKind.SubtractAssignmentExpression) {
                    let priorAddition = FindEnclosingExecutable(assignment)
                        .DescendantNodes()
                        .OfType[AssignmentExpressionSyntax]()
                        .Any(
                        (candidate AssignmentExpressionSyntax) -> candidate.SpanStart < assignment.SpanStart &&
                            candidate.IsKind(SyntaxKind.AddAssignmentExpression) && this.BindsTo(candidate.Left, local)
                    )
                    if !priorAddition && values.Count == 1 {
                        let existing = this.ResolveStableTupleAlias(values.Single()) ?? values.Single()
                        if SyntaxFactory.AreEquivalent(existing, value) {
                            values.Clear()
                        }
                    }
                    continue
                }
                values.Add(value)
            }
        }

        private func ReachingWriteTargetsLocal(node SyntaxNode, local ILocalSymbol) bool {
            if node is ArgumentSyntax && node.RefOrOutKeyword.RawKind == int32(SyntaxKind.InKeyword) {
                return false
            }
            if this.SyntaxNodeWritesSymbol(node, local) {
                return true
            }
            return node is ArgumentSyntax{RefOrOutKeyword: {RawKind: not int32(SyntaxKind.None)}} argument &&
                (
                this.ReachingBindsTo(argument.Expression, local) || this.TryFindTupleElementWritePath(
                    argument.Expression,
                    local,
                    List[int32](),
                    out _
                )
            )
        }

        private func ApplyTupleElementWrites(
            writeNode SyntaxNode,
            writes IReadOnlyList[(Path IReadOnlyList[int32]?, Value ExpressionSyntax)],
            local ILocalSymbol,
            values HashSet[ExpressionSyntax],
            elementAssignedValues Dictionary[(Write string, Previous string), ExpressionSyntax],
            visited HashSet[ISymbol]?,
            unknownTuple ExpressionSyntax
        ) {
            for var writeOrdinal = 0; writeOrdinal < writes.Count; writeOrdinal++ {
                let elementWrite = writes[writeOrdinal]
                let elementPath = elementWrite.Path!!
                let writtenValue = elementWrite.Value
                let write = writeNode.SpanStart.ToString() + ":" + string.Join(".", elementPath) +
                    ":" +
                    writeOrdinal.ToString()
                let aliasPath HashSet[ISymbol]? = if visited == nil {
                    default(HashSet[ISymbol]?)
                } else {
                    HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
                }
                // ResolveStableTupleAlias returns its input or a reaching value, never null;
                // self-migration types that result as nullable (issue #4598).
                let source ExpressionSyntax? = this.ResolveStableTupleAlias(writtenValue, aliasPath)!!
                if elementPath.Count == 0 {
                    values.Clear()
                    values.Add(source!!)
                    continue
                }
                var previousValues = values.ToArray()
                if previousValues.Length == 0 {
                    previousValues = []ExpressionSyntax{unknownTuple}
                }
                values.Clear()
                if writeNode is ArgumentSyntax && writeNode.RefOrOutKeyword.RawKind == int32(SyntaxKind.RefKeyword) {
                    values.UnionWith(previousValues)
                }
                for previous in previousValues {
                    let key = (write, TupleReachingStateKey(previous))
                    if !elementAssignedValues.TryGetValue(key, out var updated) {
                        // ReplaceTupleElement never returns null; self-migration types
                        // the result as nullable (issue #4598).
                        updated = this.ReplaceTupleElement(previous, local.Type, elementPath, 0, source!!)!!
                        elementAssignedValues.Add(key, updated)
                    }
                    values.Add(updated)
                }
            }
        }

        private func CollectTupleElementWrites(
            left ExpressionSyntax?,
            right ExpressionSyntax?,
            local ILocalSymbol,
            writes List[(Path IReadOnlyList[int32]?, Value ExpressionSyntax?)],
            includeWholeTuple bool = false
        ) {
            var left = left
            left = Unwrap(left)
            if includeWholeTuple && this.ReachingBindsTo(left, local) {
                writes.Add((Array.Empty[int32](), right))
                return
            }
            if this.TryFindTupleElementWritePath(left, local, List[int32](), out var path) {
                writes.Add((path, right))
                return
            }
            if left is not TupleExpressionSyntax tuple {
                return
            }
            for var i = 0; i < tuple.Arguments.Count; i++ {
                this.CollectTupleElementWrites(
                    tuple.Arguments[i].Expression,
                    ProjectTupleElement(right, []int32{i}),
                    local,
                    writes,
                    includeWholeTuple: true
                )
            }
        }

        private func TryFindTupleElementWritePath(
            expression ExpressionSyntax?,
            local ILocalSymbol,
            path List[int32],
            out found IReadOnlyList[int32]?
        ) bool {
            var expression = expression
            expression = Unwrap(expression)
            if this.ReachingBindsTo(expression, local) {
                found = List[int32](path)
                return path.Count > 0
            }
            for aliasTarget in this.GetRefAliasTargets(expression) {
                if this.TryFindTupleElementWritePath(aliasTarget, local, path, out found) {
                    return true
                }
            }
            if expression is MemberAccessExpressionSyntax member &&
                this
                .context
                .GetTypeInfo(member.Expression)
                .Type is INamedTypeSymbol{IsTupleType: true} tupleType &&
                this
                .context
                .GetSymbolInfo(member.Name)
                .Symbol is IFieldSymbol field {
                let index = TupleElementIndex(tupleType, field)
                if index >= 0 {
                    path.Insert(0, index)
                    if this.TryFindTupleElementWritePath(member.Expression, local, path, out found) {
                        return true
                    }
                    path.RemoveAt(0)
                }
            }
            found = nil
            return false
        }

        private func ReplaceTupleElement(
            expression ExpressionSyntax?,
            type ITypeSymbol?,
            path IReadOnlyList[int32],
            depth int32,
            replacement ExpressionSyntax
        ) ExpressionSyntax? {
            if depth == path.Count {
                return this.PreserveReachingTupleProjection(replacement, Array.Empty[int32]())
            }
            if type is not INamedTypeSymbol{IsTupleType: true} tupleType {
                return expression
            }
            let replacedIndex = path[depth]
            return SyntaxFactory.TupleExpression(
                SyntaxFactory.SeparatedList(
                    tupleType.TupleElements.Select(
                        (element IFieldSymbol, index int32) -> {
                            let projected ExpressionSyntax? = this.PreserveReachingTupleProjection(
                                expression,
                                []int32{index}
                            )
                            return SyntaxFactory.Argument(
                                if index == replacedIndex {
                                    this.ReplaceTupleElement(projected, element.Type, path, depth + 1, replacement)
                                } else {
                                    projected
                                }
                            )
                        }
                    )
                )
            )
        }

        private func PreserveReachingTupleProjection(
            source ExpressionSyntax?,
            path IReadOnlyList[int32]
        ) ExpressionSyntax? {
            var path = path
            let projected ExpressionSyntax? = ProjectTupleElement(source, path)
            if projected!!.GetAnnotations(ReachingTupleProjectionAnnotation).Any() {
                return projected
            }
            var origin ExpressionSyntax? = source
            let annotation SyntaxAnnotation? = source!!.GetAnnotations(ReachingTupleProjectionAnnotation)
                .FirstOrDefault()
            if annotation != nil && this.reachingTupleProjections.TryGetValue(
                annotation.Data!!,
                out var sourceProjection
            ) {
                origin = sourceProjection.Source
                path = sourceProjection.Path.Concat(path).ToArray()
            } else if source!!.SyntaxTree != this.context.SemanticModel.SyntaxTree {
                return projected
            }
            let data = origin!!.SpanStart.ToString(CultureInfo.InvariantCulture) +
                ":" +
                origin!!
                .Span
                .Length
                .ToString(CultureInfo.InvariantCulture) +
                ":" +
                string.Join(".", path)
            this.reachingTupleProjections.TryAdd(data, (origin, path))
            return projected!!.WithAdditionalAnnotations(SyntaxAnnotation(ReachingTupleProjectionAnnotation, data))
        }

        private func TryGetReachingTupleProjection(
            expression ExpressionSyntax?,
            out source ExpressionSyntax?,
            out path IReadOnlyList[int32]?
        ) bool {
            let annotation SyntaxAnnotation? = expression!!.GetAnnotations(ReachingTupleProjectionAnnotation)
                .FirstOrDefault()
            if annotation == nil || !this.reachingTupleProjections.TryGetValue(annotation.Data!!, out var projection) {
                source = nil
                path = nil
                return false
            }
            source = projection.Source
            path = projection.Path
            return true
        }

        private func TryFindAssignedValuePath(
            left ExpressionSyntax?,
            local ILocalSymbol,
            path List[int32],
            out found IReadOnlyList[int32]?
        ) bool {
            var left = left
            left = Unwrap(left)
            if this.ReachingBindsTo(left, local) {
                found = List[int32](path)
                return true
            }
            for aliasTarget in this.GetRefAliasTargets(left) {
                if this.TryFindAssignedValuePath(aliasTarget, local, path, out found) {
                    return true
                }
            }
            if left is DeclarationExpressionSyntax declaration {
                return this.TryFindAssignedValuePath(declaration.Designation, local, path, out found)
            }
            if left is TupleExpressionSyntax tuple {
                for var i = tuple.Arguments.Count - 1; i >= 0; i-- {
                    path.Add(i)
                    if this.TryFindAssignedValuePath(tuple.Arguments[i].Expression, local, path, out found) {
                        return true
                    }
                    path.RemoveAt(path.Count - 1)
                }
            }
            found = nil
            return false
        }

        private func ReachingBindsTo(
            expression ExpressionSyntax?,
            local ILocalSymbol,
            visited HashSet[ISymbol]? = nil
        ) bool {
            var expression = expression
            var visited = visited
            expression = Unwrap(expression)
            if this.BindsTo(expression, local) {
                return true
            }
            visited ??= HashSet[ISymbol](SymbolEqualityComparer.Default)
            return this.GetRefAliasTargets(expression, visited).Any(
                (aliasTarget ExpressionSyntax) -> this.ReachingBindsTo(aliasTarget, local, visited)
            )
        }

        private func GetRefAliasTargets(expression ExpressionSyntax?, visited HashSet[ISymbol]? = nil) IEnumerable[
            ExpressionSyntax
        ] {
            if expression!!.SyntaxTree != this
                .context
                .SemanticModel
                .SyntaxTree ||
                this
                .context
                .GetSymbolInfo(expression)
                .Symbol is not ILocalSymbol alias ||
                alias.RefKind == RefKind.None ||
                (visited != nil && !visited.Add(alias)) {
                return Array.Empty[ExpressionSyntax]()
            }
            let reachingVisited HashSet[ISymbol]? = if visited == nil {
                default(HashSet[ISymbol]?)
            } else {
                HashSet[ISymbol](visited, SymbolEqualityComparer.Default)
            }
            return this
                .GetReachingLocalValues(alias, expression!!.SpanStart, reachingVisited)
                .OfType[RefExpressionSyntax]()
                .Select((target RefExpressionSyntax) -> target.Expression)
                .ToList()
        }

        private func TryFindAssignedValuePath(
            designation VariableDesignationSyntax,
            local ILocalSymbol,
            path List[int32],
            out found IReadOnlyList[int32]?
        ) bool {
            if designation is SingleVariableDesignationSyntax single && SymbolEqualityComparer.Default.Equals(
                this.context.SemanticModel.GetDeclaredSymbol(single),
                local
            ) {
                found = List[int32](path)
                return true
            }
            if designation is ParenthesizedVariableDesignationSyntax tuple {
                for var i = tuple.Variables.Count - 1; i >= 0; i-- {
                    path.Add(i)
                    if this.TryFindAssignedValuePath(tuple.Variables[i], local, path, out found) {
                        return true
                    }
                    path.RemoveAt(path.Count - 1)
                }
            }
            found = nil
            return false
        }

        private func UnwrapTuplePreservingCasts(expression ExpressionSyntax?) ExpressionSyntax? {
            var expression = expression
            expression = Unwrap(expression)
            while this.context.GetTypeInfo(expression).Type is {IsTupleType: true} {
                if expression is CastExpressionSyntax cast {
                    expression = Unwrap(cast.Expression)
                    continue
                }
                if expression is PostfixUnaryExpressionSyntax suppression && suppression.IsKind(
                    SyntaxKind.SuppressNullableWarningExpression
                ) {
                    expression = Unwrap(suppression.Operand)
                    continue
                }
                break
            }
            return expression
        }

        /// Translates every declarator of a ref-local declaration (`ref int r =
        /// ref xs[1];`, issue #1900) into G#'s native ref-aliasing local
        /// (`let ref name T = lvalue` / `var ref name T = lvalue`,
        /// issue #491/ADR-0060 §follow-up). Unlike C#, the RHS carries no second
        /// `ref` keyword — the `ref` modifier on the binding itself is what marks
        /// the local as an alias. Reads and writes of the local afterward are
        /// ordinary identifier references; gsc routes them through the alias
        /// transparently, so — unlike a hand-rolled pointer lowering — no
        /// rewriting of later usages is needed here.
        private func TranslateRefLocalDeclaration(declaration VariableDeclarationSyntax?) IEnumerable[GStatement] {
            let results = List[GStatement]()
            for declarator in declaration!!.Variables {
                if this.context.GetDeclaredSymbol(declarator) is not ILocalSymbol localSymbol {
                    continue
                }
                let name string? = this.EmittedName(localSymbol, declarator.Identifier.ValueText)
                let initializer GExpression? = if declarator.Initializer?.Value is RefExpressionSyntax refInit {
                    this.TranslateRefExpression(refInit)
                } else {
                    default(GExpression?)
                }
                if initializer == nil {
                    let message = "ref local '${declarator.Identifier.Text}' has no `ref` initializer expression; a ref local must be aliased at declaration (issue #1900)."
                    this.context.ReportUnsupported(declarator, message)
                    continue
                }
                let pointeeType GTypeReference? = this.typeMapper.Map(
                    localSymbol.Type,
                    this.context,
                    declaration!!.Type.GetLocation()
                )
                // The alias is written through by a plain `name = value` in the
                // original C# (e.g. `r = 20;`) exactly like a normal local, so the
                // existing reassignment heuristic decides `let ref` vs `var ref`
                // the same way it decides `let` vs `var` for any other local.
                let binding = if this.IsLocalReassigned(localSymbol) {
                    BindingKind.Var
                } else {
                    BindingKind.Let
                }
                results.Add(
                    LocalDeclarationStatement(
                        binding,
                        name,
                        pointeeType,
                        initializer,
                        isRefAlias: true,
                        isReadOnlyRefAlias: localSymbol.RefKind == RefKind.RefReadOnly
                    )
                )
            }
            return results
        }

        /// Translates a C# binary expression, inserting an explicit numeric
        /// conversion when C#'s implicit numeric promotion bridged two operands of
        /// different numeric types. G# has no implicit cross-type numeric promotion:
        /// an operator such as `==`/`<`/`+` is per-primitive-type,
        /// so `uint16 == int32` (and the lifted `uint16? == int32`) is
        /// `GS0129`. The faithful fix mirrors C#: when one operand is a constant
        /// literal, retype the literal to the other operand's G# type; otherwise
        /// convert each C#-promoted operand to the common (promoted) type.
        private func TranslateBinaryExpression(binary BinaryExpressionSyntax) GExpression? {
            // ADR-0169 analyzer mode: the assignment-LHS conjunction idiom
            // rewrites to a write-node parent-kind check; standalone
            // comparisons against Roslyn members with no G# counterpart lower
            // to a boolean constant. Both carry CS2GS-ANALYZER-SHAPE review
            // warnings.
            if this.InAnalyzerApiMode && this.TryLowerAssignmentLeftConjunction(binary, out var loweredConjunction) {
                return loweredConjunction
            }
            if this.InAnalyzerApiMode && this.TryLowerAnalyzerComparison(binary, out var loweredComparison) {
                return loweredComparison
            }
            if binary.IsKind(SyntaxKind.LogicalAndExpression) && !this.ConditionUsesNativePatternVariables(
                GetConditionRoot(binary)
            ) &&
                this.TryTranslateIfLetBooleanExpression(binary, out var ifLet) {
                return ifLet
            }
            // ADR-0159 / issue #3501: C# guards a `params` array against an
            // explicit null argument (`args != null`), but a G# variadic
            // parameter always materializes an array, so gsc rejects the
            // always-decided nil compare (GS0523). Fold the test to its
            // constant value; the `&&`/`||` simplification below then absorbs
            // it so no literal `true &&` survives in the output.
            if this.TryFoldParamsArrayNullCheck(binary, out var foldedParamsCheck) {
                return foldedParamsCheck
            }
            var left GExpression? = this.TranslateExpression(binary.Left)
            let op = binary.OperatorToken.Text
            var right GExpression? = this.TranslateBinaryRightOperand(binary)
            if op == "&&" && (left is LiteralExpression && left.Kind == LiteralKind.Bool && left.Value == "true") {
                return right
            }
            if op == "||" && (left is LiteralExpression && left.Kind == LiteralKind.Bool && left.Value == "false") {
                return right
            }
            // C# string concatenation `a + b`: gsc handles char operands
            // natively. Other non-string operands still need an explicit
            // `ToString()` because G# does not expose C#'s string + object arms.
            if binary.IsKind(SyntaxKind.AddExpression) &&
                this
                .context
                .GetTypeInfo(binary)
                .Type
                ?.SpecialType == SpecialType
                .System_String {
                left = this.CoerceConcatOperand(binary.Left, left)
                right = this.CoerceConcatOperand(binary.Right, right)
                return BinaryExpression(left, op, right)
            }
            // C# null-coalescing `a ?? b`: the left is a nullable numeric, the
            // right must match the left's *underlying* (non-nullable) numeric type
            // (a `??` is not a symmetric arithmetic promotion of both sides). Only
            // apply this when both sides are numeric; mixed reference cases such as
            // `Task<T>? ?? Task` flow through unchanged.
            if op == "??" {
                return this.TranslateNullCoalescing(binary, left, right)
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
            if binary.IsKind(SyntaxKind.LeftShiftExpression) || binary.IsKind(SyntaxKind.RightShiftExpression) ||
                binary
                .IsKind(SyntaxKind.UnsignedRightShiftExpression) {
                let shiftLeftType ITypeSymbol? = this.context.GetTypeInfo(binary.Left).Type
                let shiftLeftConverted ITypeSymbol? = this.context.GetTypeInfo(binary.Left).ConvertedType
                if TryGetNumericKind(shiftLeftType, out var shiftLeftUnderlying) &&
                    TryGetNumericKind(shiftLeftConverted, out var shiftLeftConvUnderlying) &&
                    shiftLeftUnderlying != shiftLeftConvUnderlying {
                    left = this.CoerceOperandTo(left, shiftLeftConverted, binary.Left.GetLocation())
                }
                return BinaryExpression(left, op, right)
            }
            if !IsNumericPromotionOperator(op) {
                return BinaryExpression(left, op, right)
            }
            let leftType ITypeSymbol? = this.context.GetTypeInfo(binary.Left).Type
            let rightType ITypeSymbol? = this.context.GetTypeInfo(binary.Right).Type
            if !TryGetNumericKind(leftType, out var leftUnderlying) ||
                !TryGetNumericKind(rightType, out var rightUnderlying) {
                return BinaryExpression(left, op, right)
            }
            // Operand types already share an underlying numeric type (only the
            // nullability may differ, e.g. `int32? == 2`); G# accepts those directly,
            // so leave the expression untouched.
            if leftUnderlying == rightUnderlying {
                return BinaryExpression(left, op, right)
            }
            let leftConst = this.context.SemanticModel.GetConstantValue(binary.Left).HasValue
            let rightConst = this.context.SemanticModel.GetConstantValue(binary.Right).HasValue
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
            let leftIsIntegral = IsIntegralNumericKind(leftUnderlying)
            let rightIsIntegral = IsIntegralNumericKind(rightUnderlying)
            // Issue #4350: retyping the constant is faithful for a comparison
            // (the result is `bool` either way), but NOT for an arithmetic or
            // bitwise operator whose C# operation type is the constant's own
            // wider type: `2L * capacity` multiplies in `long`, so narrowing the
            // literal to `int32(2L)` would silently change it into an `int`
            // multiplication that overflows. Those operators take the
            // converted-type path below, which widens the non-constant side.
            let isComparison = IsComparisonOperator(op)
            // Issue #4350 (review): a shift is typed by its LEFT operand alone and
            // its count is always `int`, so neither side's constant is retyped to
            // the other's type — `2L << count` stays a `long` shift. Roslyn's
            // converted types below already describe the shift faithfully.
            let isShift = op == "<<" || op == ">>" || op == ">>>"
            if !isShift &&
                rightConst &&
                !leftConst &&
                leftIsIntegral &&
                rightIsIntegral &&
                (isComparison || !this.OperandWidenedToConstantType(binary.Left, rightUnderlying)) &&
                this
                .IntegralConstantFits(binary.Right, leftUnderlying) {
                right = this.CoerceOperandTo(right, leftType, binary.Right.GetLocation())
                return BinaryExpression(left, op, right)
            }
            if !isShift &&
                leftConst &&
                !rightConst &&
                leftIsIntegral &&
                rightIsIntegral &&
                (isComparison || !this.OperandWidenedToConstantType(binary.Right, leftUnderlying)) &&
                this
                .IntegralConstantFits(binary.Left, rightUnderlying) {
                left = this.CoerceOperandTo(left, rightType, binary.Left.GetLocation())
                return BinaryExpression(left, op, right)
            }
            // Neither (or both) operand is a constant expression, or one side is a
            // floating-point/decimal type: convert each operand that C# promoted
            // (its declared type differs from the common converted type) to that
            // common type. Roslyn's `ConvertedType` always reflects the correct C#
            // binary numeric promotion direction here — including widening an
            // integral non-constant operand up to a constant's floating-point type
            // (issue #2352) — independent of which side is a compile-time constant.
            let leftConverted ITypeSymbol? = this.context.GetTypeInfo(binary.Left).ConvertedType
            let rightConverted ITypeSymbol? = this.context.GetTypeInfo(binary.Right).ConvertedType
            if TryGetNumericKind(leftConverted, out var leftConvUnderlying) && leftConvUnderlying != leftUnderlying {
                left = this.CoerceOperandTo(left, leftConverted, binary.Left.GetLocation())
            }
            if TryGetNumericKind(rightConverted, out var rightConvUnderlying) &&
                rightConvUnderlying != rightUnderlying {
                right = this.CoerceOperandTo(right, rightConverted, binary.Right.GetLocation())
            }
            return BinaryExpression(left, op, right)
        }

        // Issue #4350: whether C# binary numeric promotion widened the
        // non-constant operand to the constant's own type, i.e. the operation
        // itself runs in the constant's (wider) type.
        private func OperandWidenedToConstantType(nonConstant ExpressionSyntax, constantUnderlying SpecialType) bool {
            let info = this.context.GetTypeInfo(nonConstant)
            return TryGetNumericKind(info.Type, out var own) &&
                TryGetNumericKind(info.ConvertedType, out var converted) &&
                own != converted &&
                converted == constantUnderlying
        }

        private func TranslateBinaryRightOperand(binary BinaryExpressionSyntax) GExpression? {
            // A fallback pattern in a right operand may spill its scrutinee.
            // A deconstruction assignment also needs statements. Host either in
            // the operand itself so `&&`/`||`/`??` still decide whether it runs.
            if !IsShortCircuitOperator(binary) ||
                (
                !this.RequiresLocalAssignmentSeam(binary.Right) &&
                    (this.state.PendingSpillPrologue == nil || !this.ContainsFallbackPatternSpill(binary.Right))
            ) {
                return this.TranslateExpression(binary.Right)
            }
            let previousDeclarations List[GStatement]? = this.state.ShortCircuitSpillDeclarations
            let previousScope SyntaxNode? = this.state.ShortCircuitSpillScope
            this.state.ShortCircuitSpillDeclarations ??= this.state.PendingSpillPrologue
            this.state.ShortCircuitSpillScope ??= binary.Right
            try {
                return this.TranslateWithLocalAssignmentSeam(
                    binary.Right,
                    () -> this.TranslateExpression(binary.Right)!!
                )
            } finally {
                this.state.ShortCircuitSpillDeclarations = previousDeclarations
                this.state.ShortCircuitSpillScope = previousScope
            }
        }

        private func ContainsFallbackPatternSpill(expression ExpressionSyntax) bool {
            for isPattern in expression.DescendantNodesAndSelf(
                descendIntoChildren: (node SyntaxNode) -> !(
                    (node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax)
                )
            )
                .OfType[IsPatternExpressionSyntax]() {
                if !PatternReadsScrutineeAtMostOnce(isPattern.Pattern) &&
                    !this.PatternReceiverTranslatesToTrivialOperand(isPattern.Expression) &&
                    !this.ConditionUsesNativePatternVariables(GetConditionRoot(isPattern)) {
                    return true
                }
            }
            return false
        }

        private func PatternReceiverTranslatesToTrivialOperand(expression ExpressionSyntax) bool {
            if !IsTrivialPatternReceiver(expression) {
                return false
            }
            // A bare identifier may become a member access through pattern-binding
            // substitution or implicit static qualification. Classify the emitted
            // shape so its spill stays behind earlier short-circuit guards.
            return IsTrivialOperand(this.TranslateExpression(Unparenthesize(expression))!!)
        }

        // For a string-concatenation `+` operand: if the operand's C# type is not
        // already `string` or `char`, wrap the translated operand in an explicit
        // `operand.ToString()` call. G# handles char concatenation natively. A
        // bare `null` literal is also unchanged (`null.ToString()` would throw).
        private func CoerceConcatOperand(operandSyntax ExpressionSyntax, translated GExpression?) GExpression? {
            let operandType ITypeSymbol? = this.context.GetTypeInfo(operandSyntax).Type
            let specialType = operandType?.SpecialType ?? SpecialType.None
            if specialType == SpecialType.System_String || specialType == SpecialType.System_Char {
                return translated
            }
            if IsNullOrSuppressedNull(operandSyntax) {
                return translated
            }
            let receiver GExpression? = if translated is BinaryExpression ||
                translated is IfExpression ||
                IsBareNumericLiteral(translated) {
                cast[GExpression](ParenthesizedExpression(translated))
            } else {
                translated
            }
            // Issue #4287: a NILABLE reference operand concatenates as the empty
            // string in C# (`"p:" + null` is "p:"), so the conversion is the
            // null-conditional `x?.ToString()`, whose `string?` result G#
            // concatenates the same way. `x.ToString()` was a call on a `T?`
            // receiver: gsc now reports it (GS0159), and it threw on nil
            // where C# did not. `?.` on a value that turns out non-null is
            // legal and costs one branch.
            if this.ConcatOperandMayBeNilInEmittedGSharp(operandSyntax, operandType) {
                // Inside an expression-tree lambda `?.` is not available (gsc
                // rejects a null-conditional access there, GS0473), so use the
                // static `string.Concat(object?)`: null-as-empty like C#,
                // evaluates its operand once, and a plain static call is
                // representable in a tree (Copilot review).
                if this.IsWithinExpressionTreeLambda(operandSyntax) {
                    let stringType ITypeSymbol = this.context.Compilation.GetSpecialType(SpecialType.System_String)
                    return InvocationExpression(
                        MemberAccessExpression(
                            TypeExpression(this.typeMapper.Map(stringType, this.context, operandSyntax.GetLocation())),
                            "Concat"
                        ),
                        List[GExpression]{translated!!}
                    )
                }
                return ConditionalAccessExpression(
                    receiver,
                    InvocationExpression(MemberAccessExpression(ConditionalReceiverExpression(), "ToString"))
                )
            }
            return InvocationExpression(MemberAccessExpression(receiver, "ToString"))
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
        private func ConcatOperandMayBeNilInEmittedGSharp(
            operandSyntax ExpressionSyntax,
            operandType ITypeSymbol?
        ) bool -> (
            operandType != nil &&
                operandType.IsReferenceType &&
                operandType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated
        ) ||
            this.IsGSharpNullableAnalyzerExpression(operandSyntax) || this.NullableReferenceValueMayBeNull(
            operandSyntax
        ) ||
            this.ReceiverValueIsObliviouslyReadAnnotatedResult(operandSyntax) || this.ReceiverValueIsPromotedNullable(
            operandSyntax
        ) ||
            this.ComposedReceiverMayBeNull(operandSyntax)

        // Issue #1960 item 2: true when `assignment` is a `+=`/`-=` whose LEFT
        // side is delegate-typed (TypeKind.Delegate covers both a named delegate
        // and Action/Func-shaped BCL delegates) but is NOT a declared C# event —
        // i.e. a raw delegate multicast combine/remove, which has no G# form.
        // A real event access (`obj.Ticked += handler`) resolves to an
        // IEventSymbol and is excluded so it keeps flowing through the normal
        // compound-assignment path (G#'s event-subscription `+=`/`-=`).
        private func IsDelegateMulticastCombine(assignment AssignmentExpressionSyntax, out op string) bool {
            op = assignment.OperatorToken.Text
            if !assignment.IsKind(SyntaxKind.AddAssignmentExpression) && !assignment.IsKind(
                SyntaxKind.SubtractAssignmentExpression
            ) {
                return false
            }
            if this.context.GetSymbolInfo(assignment.Left).Symbol is IEventSymbol {
                return false
            }
            return this.context.GetTypeInfo(assignment.Left).Type?.TypeKind == TypeKind.Delegate
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
        private func ForgiveElementAccessAssignmentRhs(
            assignment AssignmentExpressionSyntax,
            translatedRhs GExpression?
        ) GExpression? {
            if !this.IsObliviousCompilation() ||
                translatedRhs is NonNullAssertionExpression ||
                IsNullOrSuppressedNull(assignment.Right) ||
                !this.ElementAccessAssignmentRequiresNonNullReference(assignment) || !this.IsNullablePromotedValue(
                assignment.Right
            ) {
                return translatedRhs
            }
            // An array element write has no symbol; the array is the target.
            let storeTarget ISymbol? = this
                .context
                .GetSymbolInfo(assignment.Left)
                .Symbol ??
                (
                if assignment.Left is ElementAccessExpressionSyntax elementAccess {
                    this.context.GetTypeInfo(elementAccess.Expression).Type as IArrayTypeSymbol
                } else {
                    default(IArrayTypeSymbol?)
                }
            )
            return this.ReportStoreBridge(
                assignment.Right,
                translatedRhs,
                EnsureNonNullAssertion(translatedRhs),
                storeTarget
            )
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
        private func ElementAccessAssignmentRequiresNonNullReference(
            assignment AssignmentExpressionSyntax?
        ) bool -> assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) &&
            this.ElementAccessStoreRequiresNonNullReference(assignment!!.Left)

        // Issue #5595: the target half of the rule above. A deconstruction into an
        // element-access target (`(arr[0], i) = entry`) has no right-hand side per
        // element, so its store bridge asks this with the target alone.
        private func ElementAccessStoreRequiresNonNullReference(target ExpressionSyntax) bool {
            if !(target is ElementAccessExpressionSyntax) || this.ElementStoreSlotAcceptsNil(target) ||
                // Issue #5537: the element of oblivious container storage is `T?`.
            this.StoreTargetIsObliviousContainerElement(target) {
                return false
            }
            let leftSymbol ISymbol? = this.GetProjectedAssignmentTarget(
                target,
                this.context.GetSymbolInfo(target).Symbol
            )
            let leftType ITypeSymbol? = this.GetAssignmentTargetType(target, leftSymbol)
            if !(leftType != nil && leftType.IsReferenceType == true) ||
                leftType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return false
            }
            // An `[AllowNull]` indexer, also one that another project of the run
            // emits (#4356), is promoted, so it takes a nullable value.
            return leftSymbol is not IPropertySymbol indexer || !this.ShouldPromoteToNullableReference(indexer)
        }

        // Issues #4500, #4525 and #5595: whether the slot that an element-access
        // store target writes accepts nil: an array element that cs2gs emits `T?`,
        // or a slot that a prebuilt oblivious library declares. No bridge asserts a
        // value stored there, in a plain assignment or in a deconstruction.
        private func ElementStoreSlotAcceptsNil(target ExpressionSyntax?) bool {
            if this.IsNullableArrayElementAccess(target) {
                return true
            }
            if target is not ElementAccessExpressionSyntax access {
                return false
            }
            return this.ElementStoreSlotIsImportedOblivious(
                access,
                this.GetProjectedAssignmentTarget(access, this.context.GetSymbolInfo(access).Symbol)
            )
        }

        // Issue #3865: gsc imports the value of an oblivious indexer, and the
        // element of an oblivious array, that a prebuilt library declares as a
        // platform type, which takes a nullable value. An array element has no
        // symbol: its contract is the element position of the receiver's
        // declaration, read before type-argument substitution, so a `T[]` whose
        // `T` the consumer substitutes keeps that type argument's contract. A
        // `var` local without a type clause has the type of its initializer, so
        // it is followed to the declaration of that initializer.
        private func ElementStoreSlotIsImportedOblivious(target ElementAccessExpressionSyntax, slot ISymbol?) bool {
            if slot != nil {
                return this.IsImportedObliviousNullableTarget(slot)
            }
            var receiver ISymbol? = this.context.GetSymbolInfo(target.Expression).Symbol
            for var depth = 0; depth < 8 && receiver is ILocalSymbol; depth++ {
                receiver = this.InferredLocalInitializerSymbol(cast[ILocalSymbol](receiver))
            }
            let declared ITypeSymbol? = switch receiver?.OriginalDefinition {
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                case method is IMethodSymbol: method.ReturnType
                default: default(ITypeSymbol?)
            }
            return declared is IArrayTypeSymbol array && this.TargetContractIsFrozenInMetadata(receiver) &&
                ObliviousNullabilityAnalyzer.IsObliviousConcreteReferencePosition(array.ElementType)
        }

        // The declaration that the initializer of a `var` local reads, when the
        // local's emitted declaration has no type clause (see
        // `InferredLocalDeclarationIsNullable`), so G# infers it from that initializer.
        private func InferredLocalInitializerSymbol(local ILocalSymbol) ISymbol? {
            if this.InferredLocalDeclarationIsNullable(local) {
                return nil
            }
            if local
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} declarator &&
                declarator.Parent is VariableDeclarationSyntax{Type: {IsVar: true}} {
                return this.context.GetSymbolInfo(initializer).Symbol
            }
            return nil
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
        private func ForgiveObliviousExternalAssignmentRhs(
            assignment AssignmentExpressionSyntax,
            translatedRhs GExpression?
        ) GExpression? {
            if !this.IsObliviousCompilation() || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) ||
                translatedRhs is NonNullAssertionExpression ||
                !this.IsImportedObliviousNullableMember(this.context.GetSymbolInfo(assignment.Right).Symbol) ||
                this.PlatformTypedImportNeedsNoBridge(assignment.Right) {
                return translatedRhs
            }
            let leftSymbol ISymbol? = this.GetProjectedAssignmentTarget(
                assignment.Left,
                this.context.GetSymbolInfo(assignment.Left).Symbol
            )
            let leftType ITypeSymbol? = this.GetAssignmentTargetType(assignment.Left, leftSymbol)
            if !(leftType != nil && leftType.IsReferenceType == true) ||
                leftType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                return translatedRhs
            }
            if leftSymbol != nil && this.ShouldPromoteToNullableReference(leftSymbol) {
                return translatedRhs
            }
            return this.ReportStoreBridge(
                assignment.Right,
                translatedRhs,
                EnsureNonNullAssertion(translatedRhs),
                leftSymbol
            )
        }

        // For a compound numeric assignment `x OP= y` (`+= -= *= /= %= &= |= ^=`),
        // G# requires the RHS to share the LHS's numeric type; a mismatched RHS is
        // coerced to the LHS type via the conversion-call form (e.g. `x += int64(y)`).
        // A nullable RHS is coerced through the LHS's underlying numeric type.
        private func CoerceCompoundAssignmentRhs(assignment AssignmentExpressionSyntax, rhs GExpression?) GExpression? {
            if assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) {
                return rhs
            }
            // Issue #1232: compound shift (`<<=` / `>>=`). The RHS is a shift
            // count, NOT the LHS numeric type — gsc now implicitly widens a
            // narrower-order integer count to int32, so the count needs no
            // coercion. Return it unchanged (and, crucially, skip the LHS-type
            // numeric promotion below, which would wrongly coerce the count to
            // the LHS type, e.g. `uint32(count)` → GS0129).
            if assignment.IsKind(SyntaxKind.LeftShiftAssignmentExpression) || assignment.IsKind(
                SyntaxKind.RightShiftAssignmentExpression
            ) ||
                assignment.IsKind(SyntaxKind.UnsignedRightShiftAssignmentExpression) {
                return rhs
            }
            let leftType ITypeSymbol? = this.context.GetTypeInfo(assignment.Left).Type
            let rightType ITypeSymbol? = this.context.GetTypeInfo(assignment.Right).Type
            if TryGetNumericKind(leftType, out var leftUnderlying) &&
                TryGetNumericKind(rightType, out var rightUnderlying) &&
                leftUnderlying != rightUnderlying {
                return this.CoerceOperandTo(rhs, UnwrapNullable(leftType), assignment.Right.GetLocation())
            }
            return rhs
        }

        // C# array-creation lengths accept any integral type (`new T[uint]`,
        // `new T[long]`, …), but the native G# allocation form `[n]T` (issue
        // #1272) takes an `int32`. Coerce a non-`int32` numeric length to int32
        // via the conversion-call form so the allocation binds. A nullable or
        // non-numeric length is left unchanged.
        private func CoerceLengthToInt32(lengthSyntax ExpressionSyntax, length GExpression?) GExpression? {
            let lengthType ITypeSymbol? = this.context.GetTypeInfo(lengthSyntax).Type
            if lengthType != nil &&
                IsNonNullableValueType(lengthType) &&
                TryGetNumericKind(lengthType, out var underlying) &&
                underlying != SpecialType
                .System_Int32 {
                let int32Type ITypeSymbol = this.context.Compilation.GetSpecialType(SpecialType.System_Int32)
                return this.CoerceOperandTo(length, int32Type, lengthSyntax.GetLocation())
            }
            return length
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
        private func CoerceIndexToInt32(elementAccess ElementAccessExpressionSyntax, index GExpression?) GExpression? {
            if elementAccess.ArgumentList.Arguments.Count != 1 {
                return index
            }
            // Issue #1279: arrays accept any integer index in gsc — no coercion.
            if this.context.GetTypeInfo(elementAccess.Expression).Type is IArrayTypeSymbol {
                return index
            }
            if !this.IndexerTargetTypeIsInt32(elementAccess) {
                return index
            }
            let indexSyntax = elementAccess.ArgumentList.Arguments[0].Expression
            let indexType ITypeSymbol? = this.context.GetTypeInfo(indexSyntax).Type
            if indexType != nil && IsNonNullableValueType(indexType) && IsIntegerNotWideningToInt32(indexType) {
                let int32Type ITypeSymbol = this.context.Compilation.GetSpecialType(SpecialType.System_Int32)
                return this.CoerceOperandTo(index, int32Type, indexSyntax.GetLocation())
            }
            return index
        }

        // CLR rectangular-array Get/Set pseudo-methods take int32 indices.
        // Preserve C#'s unchecked integral narrowing for wide index kinds
        // (`long`/`ulong`/`nint`/`nuint`) with an explicit G# int32 conversion.
        private func CoerceMultiDimIndexToInt32(indexSyntax ExpressionSyntax, index GExpression?) GExpression? {
            let indexType ITypeSymbol? = this.context.GetTypeInfo(indexSyntax).Type
            if indexType != nil && IsNonNullableValueType(indexType) && IsIntegerNotWideningToInt32(indexType) {
                let int32Type ITypeSymbol = this.context.Compilation.GetSpecialType(SpecialType.System_Int32)
                return this.CoerceOperandTo(index, int32Type, indexSyntax.GetLocation())
            }
            return index
        }

        private func TranslateOutVarDesignation(single SingleVariableDesignationSyntax) GExpression {
            return OutArgumentExpression("out var", this.EmittedName(single, single.Identifier))
        }

        // Reports whether the element-access target indexes by `int32`: a C# array,
        // or a type whose bound indexer takes a single `int32` parameter (such as
        // `List<T>`, `Span<T>`, `IReadOnlyList<T>`). A `Dictionary<TKey, T>` or any
        // other indexer keyed by a non-`int32` type returns false.
        private func IndexerTargetTypeIsInt32(elementAccess ElementAccessExpressionSyntax) bool {
            let receiverType ITypeSymbol? = this.context.GetTypeInfo(elementAccess.Expression).Type
            if receiverType is IArrayTypeSymbol {
                return true
            }
            if this
                .context
                .GetSymbolInfo(elementAccess)
                .Symbol is IPropertySymbol{IsIndexer: true, Parameters: {Length: 1}} indexer {
                return indexer.Parameters[0].Type.SpecialType == SpecialType.System_Int32
            }
            return false
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
        // Reference arrays need the same explicit covariance spelling as
        // argument/return conversions because G# slices remain invariant.
        private func TranslateNullCoalescing(
            binary BinaryExpressionSyntax,
            left GExpression?,
            right GExpression?
        ) GExpression {
            var left = left
            var right = right
            let leftType ITypeSymbol? = this.context.GetTypeInfo(binary.Left).Type
            let rightType ITypeSymbol? = this.context.GetTypeInfo(binary.Right).Type
            let resultType ITypeSymbol? = this.context.GetTypeInfo(binary).Type
            // The left conversion occurs BEFORE the nil probe, so its target
            // must still admit nil even when the coalesce result is non-null.
            left = this.CoerceCovariantArrayConversion(
                binary.Left,
                left,
                resultType?.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
            )
            right = this.CoerceCovariantArrayConversion(binary.Right, right, resultType)
            if TryGetNumericKind(leftType, out var leftUnderlying) &&
                TryGetNumericKind(rightType, out var rightUnderlying) &&
                leftUnderlying != rightUnderlying {
                // `.Type` (not `.ConvertedType`) is the `??` expression's own
                // best-common-type per C# §12.15 — the value we need here.
                // `.ConvertedType` instead reflects an ENCLOSING conversion
                // (e.g. an assignment's target type), which would let an
                // outer context over-coerce this operand to the wrong type
                // (S1). `.Type` is only null for an unresolved/erroneous
                // expression; both operands already passed `TryGetNumericKind`
                // above, meaning the semantic model fully resolved this `??`,
                // so `.Type` is guaranteed non-null here.
                if TryGetNumericKind(resultType, out var resultUnderlying) && rightUnderlying != resultUnderlying {
                    right = this.CoerceOperandTo(right, UnwrapNullable(resultType), binary.Right.GetLocation())
                }
            }
            return BinaryExpression(left, "??", right)
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
        private func TranslateConditionalExpression(conditional ConditionalExpressionSyntax) GExpression? {
            // ADR-0151: `receiver is { } name [&& predicate] ? a : b` has a
            // canonical G# form — the value-position `if let` — which needs
            // neither a single-evaluation spill temp nor a `!!` at each binder
            // reference. Attempt it before the general lowering; the helper is
            // conservative and leaves everything untranslated when it bails.
            if !this.ConditionUsesNativePatternVariables(conditional.Condition) && this.TryTranslateIfLetConditional(
                conditional,
                out var ifLet
            ) {
                return ifLet
            }
            let condition GExpression? = this.TranslateExpression(conditional.Condition)
            var (whenTrue, thenStatements) = this.TranslateConditionalValueBranch(conditional.WhenTrue)
            var (whenFalse, elseStatements) = this.TranslateConditionalValueBranch(conditional.WhenFalse)
            whenTrue, whenFalse = this.CoerceConditionalArms(conditional, whenTrue, whenFalse)
            return IfExpression(condition, whenTrue, whenFalse, thenStatements, elseStatements)
        }

        // G# conditional/switch arms can use block expressions: run arm-local
        // spills/writes there so only the selected C# arm executes them.
        private func TranslateConditionalValueBranch(branch ExpressionSyntax, translateValue(() -> GExpression)? = nil)(
            Value GExpression?,
            Statements List[GStatement]
        ) {
            let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
            let statements = List[GStatement]()
            this.state.PendingSpillPrologue = statements
            try {
                let replacements = List[ExpressionSyntax]()
                let embedded = this.HoistAssignmentsInOrder(branch, includeSelf: true, statements, replacements)
                try {
                    let value GExpression? = if translateValue != nil {
                        translateValue()
                    } else {
                        this.TranslateValueWithNullForgiveness(branch)
                    }
                    return (value, statements)
                } finally {
                    this.ReleaseHoistedAssignments(embedded, replacements)
                }
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
            }
        }

        // Shared by the general `IfExpression` lowering above and the ADR-0151
        // `if let` rewrite: aligns the two translated arms with C#'s computed
        // conditional result type (numeric widening that gsc will not infer on
        // its own, and a bare `null` arm re-spelled as `default(T?)`).
        private func CoerceConditionalArms(
            conditional ConditionalExpressionSyntax,
            whenTrue GExpression?,
            whenFalse GExpression?
        )(WhenTrue GExpression?, WhenFalse GExpression?) {
            var whenTrue = whenTrue
            var whenFalse = whenFalse
            let conditionalTypeInfo = this.context.GetTypeInfo(conditional)
            let resultType ITypeSymbol? = conditionalTypeInfo.Type ?? conditionalTypeInfo.ConvertedType
            let trueType ITypeSymbol? = this.context.GetTypeInfo(conditional.WhenTrue).Type
            let falseType ITypeSymbol? = this.context.GetTypeInfo(conditional.WhenFalse).Type
            // When C# computed a single numeric conditional type but an arm has a
            // different numeric type (e.g. `cond ? 1u : 0`, whose `0` is `int32`
            // while the result is `uint32`), coerce each mismatched arm to the
            // result type: G# requires both arms to share a type (GS0263) and does
            // no implicit promotion. Each arm is coerced independently so a ternary
            // with only one mismatched arm is still aligned.
            if resultType != nil &&
                IsNonNullableValueType(resultType) &&
                TryGetNumericKind(resultType, out var resultUnderlying) {
                if TryGetNumericKind(trueType, out var trueUnderlying) && trueUnderlying != resultUnderlying {
                    whenTrue = this.CoerceOperandTo(whenTrue, resultType, conditional.WhenTrue.GetLocation())
                }
                if TryGetNumericKind(falseType, out var falseUnderlying) && falseUnderlying != resultUnderlying {
                    whenFalse = this.CoerceOperandTo(whenFalse, resultType, conditional.WhenFalse.GetLocation())
                }
            }
            // Issue #3553: C# also target-types REFERENCE arms to the
            // conditional's common type (`cond ? new NonNullAssertionExpression(…)
            // : new IdentifierExpression(…)` converts both to the shared base),
            // while gsc requires a common result type outright (GS0263). When an
            // arm's own reference type differs from the common reference type by
            // more than a nullable annotation, spell the upcast (`arm as T`).
            // Mirrors CoerceSwitchArmValue's reference rule for switch
            // arms; each arm is coerced independently.
            if resultType?.IsReferenceType == true && resultType!!.TypeKind != TypeKind.Error {
                if trueType?.IsReferenceType == true &&
                    trueType!!.TypeKind != TypeKind.Error &&
                    !SymbolEqualityComparer
                    .Default
                    .Equals(trueType, resultType) {
                    whenTrue = this.CoerceReferenceValueTo(conditional.WhenTrue, whenTrue, resultType)
                }
                if falseType?.IsReferenceType == true &&
                    falseType!!.TypeKind != TypeKind.Error &&
                    !SymbolEqualityComparer
                    .Default
                    .Equals(falseType, resultType) {
                    whenFalse = this.CoerceReferenceValueTo(conditional.WhenFalse, whenFalse, resultType)
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
            if resultType != nil && resultType.IsReferenceType == true {
                let nullableResult GTypeReference? = MakeNullable(
                    this.typeMapper.Map(resultType, this.context, conditional.GetLocation())
                )
                if IsNullLiteral(conditional.WhenTrue) {
                    whenTrue = DefaultValueExpression(nullableResult)
                }
                if IsNullLiteral(conditional.WhenFalse) {
                    whenFalse = DefaultValueExpression(nullableResult)
                }
            }
            return (whenTrue, whenFalse)
        }

        // non-nullable value type target (e.g. `uint8`, `int32`) G# rejects
        // `(expr as T)` with GS0270 ("the 'as' operator requires the target type to
        // be a reference type or a nullable value type"); the canonical G# form is
        // the width-bearing conversion-call `T(expr)`. Only a reference type or a
        // nullable value type target (where `as` is valid) keeps the `as` form.
        private func CoerceOperandTo(expression GExpression?, targetType ITypeSymbol?, location Location) GExpression {
            if IsNonNullableValueType(targetType) {
                let conversionTarget GTypeReference? = this.typeMapper.Map(targetType, this.context, location)
                return ConversionExpression(conversionTarget, expression)
            }
            let target GTypeReference? = this.typeMapper.Map(targetType, this.context, location)
            return ParenthesizedExpression(BinaryExpression(expression, "as", TypeExpression(target)))
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
        private func CoercePointerConversion(expression ExpressionSyntax?, translated GExpression?) GExpression? {
            if expression == nil {
                return translated
            }
            let info = this.context.GetTypeInfo(expression)
            if info.Type is IPointerTypeSymbol source &&
                info.ConvertedType is IPointerTypeSymbol target &&
                !SymbolEqualityComparer
                .Default
                .Equals(source.PointedAtType, target.PointedAtType) {
                let targetRef GTypeReference? = this.typeMapper.Map(target, this.context, expression.GetLocation())
                return ConversionExpression(targetRef, translated)
            }
            return translated
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
        // are the positions where C# inserts a target-typed conversion. Coalescing
        // supplies its own result type instead of an enclosing converted type. Rank and
        // element-kind guards keep it to the one-dimensional reference-element
        // case the CLR actually widens; an annotation-only element difference
        // compares equal under SymbolEqualityComparer.Default and is left bare.
        private func CoerceCovariantArrayConversion(
            expression ExpressionSyntax?,
            translated GExpression?
        ) GExpression? {
            if expression == nil {
                return translated
            }
            let info = this.context.GetTypeInfo(expression)
            return this.CoerceCovariantArrayConversion(expression, translated, info.ConvertedType)
        }

        private func CoerceCovariantArrayConversion(
            expression ExpressionSyntax,
            translated GExpression?,
            targetType ITypeSymbol?
        ) GExpression? {
            let info = this.context.GetTypeInfo(expression)
            if info.Type is IArrayTypeSymbol source &&
                targetType is IArrayTypeSymbol target &&
                source.Rank == 1 &&
                target.Rank == 1 &&
                source.ElementType is {IsReferenceType: true} sourceElement &&
                target.ElementType is {IsReferenceType: true} targetElement &&
                sourceElement.TypeKind != TypeKind.Error &&
                targetElement.TypeKind != TypeKind.Error &&
                !SymbolEqualityComparer
                .Default
                .Equals(sourceElement, targetElement) &&
                this
                .context
                .Compilation
                .ClassifyConversion(source, target)
                .IsImplicit {
                let targetRef GTypeReference? = this.typeMapper.Map(target, this.context, expression.GetLocation())
                return ConversionExpression(targetRef, translated, isCheckedReferenceCast: true)
            }
            return translated
        }

        private func IntegralConstantFits(expression ExpressionSyntax, targetType SpecialType) bool {
            let constant = this.context.SemanticModel.GetConstantValue(expression)
            if !constant.HasValue || constant.Value == nil {
                return false
            }
            var value decimal
            try {
                value = if constant.Value is char character {
                    decimal(character)
                } else {
                    Convert.ToDecimal(constant.Value, CultureInfo.InvariantCulture)
                }
            } catch (Exception) {
                return false
            }
            return switch targetType {
                case SpecialType.System_SByte: value >= decimal(int8.MinValue) && value <= decimal(int8.MaxValue)
                case SpecialType.System_Byte: value >= decimal(uint8.MinValue) && value <= decimal(uint8.MaxValue)
                case SpecialType.System_Int16: value >= decimal(int16.MinValue) && value <= decimal(int16.MaxValue)
                case SpecialType.System_UInt16: value >= decimal(uint16.MinValue) && value <= decimal(uint16.MaxValue)
                case SpecialType.System_Char: value >= decimal(char.MinValue) && value <= decimal(char.MaxValue)
                case SpecialType.System_Int32: value >= decimal(int32.MinValue) && value <= decimal(int32.MaxValue)
                case SpecialType.System_UInt32: value >= decimal(uint32.MinValue) && value <= decimal(uint32.MaxValue)
                case SpecialType.System_Int64: value >= decimal(int64.MinValue) && value <= decimal(int64.MaxValue)
                case SpecialType.System_UInt64: value >= decimal(uint64.MinValue) && value <= decimal(uint64.MaxValue)
                default: false
            }
        }

        private func TranslateLabeledStatement(labeledStatement LabeledStatementSyntax) IEnumerable[GStatement] {
            // C# `label: statement;` is a single statement wrapper; G# has the
            // identical `label: statement` form (ADR-0070, generalized by
            // ADR-0139 / issue #1884). The inner statement can expand into more
            // than one G# statement (e.g. a declaration that needs a spill
            // prologue); the label is attached to the FIRST emitted statement
            // only — C# source has no way to target a position mid-expansion,
            // so this is a faithful mapping.
            let label string? = this.EmittedName(labeledStatement, labeledStatement.Identifier)
            let inner = this.TranslateStatement(labeledStatement.Statement).ToList()
            if inner.Count == 0 {
                return []GStatement{cast[GStatement](LabeledStatement(label, BlockStatement(List[GStatement]())))}
            }
            let result = List[GStatement]{LabeledStatement(label, inner[0])}
            result.AddRange(inner.Skip(1))
            return result
        }

        private func TranslateGotoStatement(gotoStatement GotoStatementSyntax) IEnumerable[GStatement] {
            switch gotoStatement.Kind() {
                case SyntaxKind.GotoCaseStatement, SyntaxKind.GotoDefaultStatement {
                    // Issue #3501 A3: a trailing `goto case`/`goto default`
                    // that targets the LEXICALLY NEXT section is exactly Go's
                    // `fallthrough` — the native gsc statement replaces the
                    // synthesized-label lowering below.
                    if this.IsAdjacentFallthroughGoto(gotoStatement) {
                        return []GStatement{cast[GStatement](FallthroughStatement())}
                    }
                    // ADR-0139 / issue #1884: `goto case K;` jumps to the
                    // statement list of the case labeled with the constant K
                    // WITHOUT re-evaluating the switch subject; `goto default;`
                    // jumps to the default section. Neither re-enters the
                    // switch, so both lower to a plain `goto` targeting a
                    // synthesized label placed at the top of the target arm's
                    // body (see TranslateSwitchStatement).
                    let target SwitchLabelSyntax? = this.ResolveGotoCaseOrDefaultTarget(gotoStatement)
                    if target == nil {
                        this.context.ReportUnsupported(
                            gotoStatement,
                            "goto target case/default label could not be resolved."
                        )
                        return []GStatement{cast[GStatement](RawStatement("// unsupported: ${gotoStatement.Kind()}"))}
                    }
                    // Issue #3501: a goto whose target arm does nothing (an
                    // empty section or a bare `break;`) just exits the
                    // switch — G#'s break-in-arm (A3) says that directly, no
                    // synthesized label pair needed. Guarded against an
                    // intervening loop or nested switch, where a bare `break`
                    // would bind to the inner construct instead.
                    if TargetArmIsEmptyBreak(target) && !HasInterveningBreakTarget(gotoStatement) {
                        return []GStatement{cast[GStatement](BreakStatement())}
                    }
                    return []GStatement{cast[GStatement](GotoStatement(this.GotoCaseOrDefaultLabelName(target)))}
                }
                default {
                    // Plain `goto label;` — Expression is the label name as an
                    // IdentifierNameSyntax (verified against Roslyn 4.14).
                    let labelName IdentifierNameSyntax? = cast[IdentifierNameSyntax](gotoStatement.Expression)
                    let label string? = this.EmittedName(labelName, labelName!!.Identifier)
                    return []GStatement{cast[GStatement](GotoStatement(label))}
                }
            }
        }

        /// ADR-0159 / issue #3501: folds `args == null` /
        /// `args != null` where `args` is the enclosing method's
        /// C# `params` array to its constant value — a G# variadic
        /// parameter always materializes an array, so gsc rejects the
        /// always-decided nil compare (GS0523).
        private func TryFoldParamsArrayNullCheck(binary BinaryExpressionSyntax, out folded GExpression?) bool {
            folded = nil
            let isEquals = binary.IsKind(SyntaxKind.EqualsExpression)
            if !isEquals && !binary.IsKind(SyntaxKind.NotEqualsExpression) {
                return false
            }
            let operand ExpressionSyntax? = if binary.Right.IsKind(SyntaxKind.NullLiteralExpression) {
                binary.Left
            } else {
                (
                    if binary.Left.IsKind(SyntaxKind.NullLiteralExpression) {
                        binary.Right
                    } else {
                        default(ExpressionSyntax?)
                    }
                )
            }
            if !this.IsParamsArrayOperand(operand) {
                return false
            }
            folded = LiteralExpression.Bool(!isEquals)
            return true
        }

        /// ADR-0159 / issue #3501: true when [`operand`](paramref) reads a
        /// C# `params` parameter. Such a parameter translates to a G#
        /// variadic, which always materializes an array, so any nil comparison
        /// against it is statically decided and gsc reports GS0523. Shared by
        /// the `args == null` binary spelling
        /// ((cref:TryFoldParamsArrayNullCheck)) and the `args is
        /// null` / `args is not null` pattern spelling
        /// (`TranslatePatternTest` / `TranslateNotPatternTest`).
        private func IsParamsArrayOperand(operand ExpressionSyntax?) bool -> operand != nil &&
            (this.context.GetSymbolInfo(operand).Symbol is IParameterSymbol and {IsParams: true})

        /// Resolves the (cref:SwitchLabelSyntax) that a `goto case
        /// K;` / `goto default;` statement targets, by walking up to
        /// the nearest enclosing `switch` and matching on compile-time
        /// constant value (issue #1884). Returns `null` if the enclosing
        /// switch or matching label cannot be found (malformed input; the
        /// caller reports a translation gap).
        private func ResolveGotoCaseOrDefaultTarget(gotoStatement GotoStatementSyntax) SwitchLabelSyntax? {
            let enclosingSwitch SwitchStatementSyntax? = gotoStatement
                .Ancestors()
                .OfType[SwitchStatementSyntax]()
                .FirstOrDefault()
            if enclosingSwitch == nil {
                return nil
            }
            if gotoStatement.Kind() == SyntaxKind.GotoDefaultStatement {
                return enclosingSwitch
                    .Sections
                    .SelectMany(
                    func (section SwitchSectionSyntax) IEnumerable[SwitchLabelSyntax] {
                        return section.Labels
                    }
                )
                    .OfType[DefaultSwitchLabelSyntax]()
                    .FirstOrDefault()
            }
            let targetValue = this.context.SemanticModel.GetConstantValue(gotoStatement.Expression!!)
            if !targetValue.HasValue {
                return nil
            }
            for section in enclosingSwitch.Sections {
                for label in section.Labels {
                    if label is CaseSwitchLabelSyntax caseLabel {
                        let caseValue = this.context.SemanticModel.GetConstantValue(caseLabel.Value)
                        if caseValue.HasValue && object.Equals(targetValue.Value, caseValue.Value) {
                            return caseLabel
                        }
                    }
                }
            }
            return nil
        }

        /// The synthesized G# label name for a `goto case`/`goto
        /// default` target (issue #1884). Keyed by the target label's own
        /// syntax node, which keeps the two independent call sites that must
        /// agree on the name — the arm that defines the label
        /// ((cref:TranslateSwitchStatement)) and the `goto` that
        /// targets it ((cref:ResolveGotoCaseOrDefaultTarget) callers) —
        /// consistent through the per-scope ordinal allocation (issue #3467).
        private func GotoCaseOrDefaultLabelName(label SwitchLabelSyntax?) string -> this.SyntheticLabelName(
            if label is DefaultSwitchLabelSyntax {
                "gotoDefault"
            } else {
                "gotoCase"
            },
            label
        )

        /// Issue #3501 A3: true when a `goto case`/`goto default`
        /// is exactly Go's `fallthrough`: it is the DIRECT last
        /// statement of a single-label section (so the section prints as one
        /// G# arm), and it targets a label of the LEXICALLY NEXT section
        /// whose labels are all binding-free (constants or `default` —
        /// gsc rejects fallthrough into an arm with pattern bindings or a
        /// guard). Such gotos print as the native `fallthrough`
        /// statement and need no synthesized arm-top label.
        private func IsAdjacentFallthroughGoto(gotoStatement GotoStatementSyntax) bool {
            if !gotoStatement.IsKind(SyntaxKind.GotoCaseStatement) && !gotoStatement.IsKind(
                SyntaxKind.GotoDefaultStatement
            ) {
                return false
            }
            let section SwitchSectionSyntax? = gotoStatement.Ancestors().OfType[SwitchSectionSyntax]().FirstOrDefault()
            if section == nil || section.Statements.LastOrDefault() != gotoStatement || section.Labels.Count != 1 {
                return false
            }
            if section.Parent is not SwitchStatementSyntax switchStatement ||
                gotoStatement
                .Ancestors()
                .OfType[SwitchStatementSyntax]()
                .FirstOrDefault() != switchStatement {
                return false
            }
            let sectionIndex = switchStatement.Sections.IndexOf(section)
            if sectionIndex < 0 || sectionIndex + 1 >= switchStatement.Sections.Count {
                return false
            }
            let nextSection = switchStatement.Sections[sectionIndex + 1]
            let resolvedTarget SwitchLabelSyntax? = this.ResolveGotoCaseOrDefaultTarget(gotoStatement)
            return resolvedTarget != nil && nextSection.Labels.Contains(resolvedTarget) && nextSection.Labels.All(
                (l SwitchLabelSyntax) -> l is CaseSwitchLabelSyntax || l is DefaultSwitchLabelSyntax
            )
        }

        private func TranslateThrow(throwStatement ThrowStatementSyntax) GStatement {
            // ADR-0176 / issue #3897: C# `throw;` maps to G# `rethrow`, which
            // emits ILOpCode.Rethrow and preserves the original throw site.
            // The previous lowering re-threw the caught variable, which is the
            // same exception object but resets its StackTrace. A C# `throw;` is
            // only legal inside a catch handler, and cs2gs keeps it inside the
            // translated catch body, so `rethrow` is always legal here.
            if throwStatement.Expression == nil {
                return RethrowStatement()
            }
            return ThrowStatement(this.TranslateExpression(throwStatement.Expression))
        }

        private func TranslateTry(node TryStatementSyntax) GStatement {
            let tryBlock = this.TranslateBlock(node.Block)
            let catches = List[CatchClause]()
            for catchClause in node.Catches {
                var variableName string? = nil
                var exceptionType GTypeReference? = nil
                if catchClause.Declaration != nil {
                    let typeSymbol ITypeSymbol? = this.context.GetTypeInfo(catchClause.Declaration!!.Type).Type
                    exceptionType = if typeSymbol != nil {
                        this.typeMapper.Map(typeSymbol, this.context, catchClause.Declaration!!.Type.GetLocation())
                    } else {
                        cast[GTypeReference](NamedTypeReference(catchClause.Declaration!!.Type.ToString()))
                    }
                    variableName = this.EmittedName(catchClause.Declaration, catchClause.Declaration!!.Identifier)
                }
                let filter GExpression? = if catchClause.Filter == nil {
                    default(GExpression?)
                } else {
                    this.TranslateExpression(catchClause.Filter!!.FilterExpression)
                }
                catches.Add(CatchClause(variableName, exceptionType, this.TranslateBlock(catchClause.Block), filter))
            }
            let finallyBlock BlockStatement? = if node.Finally != nil {
                this.TranslateBlock(node.Finally!!.Block)
            } else {
                default(BlockStatement?)
            }
            return TryStatement(tryBlock, catches, finallyBlock)
        }

        private func TranslateUsingStatement(node UsingStatementSyntax) GStatement {
            // C# `using (var r = e) body` / `await using (var r = e) body` has
            // no `using (...)` block form in G# (it is GS0005); it maps to a
            // scoped block holding a `using let` / `await using let` resource
            // declaration followed by the body, so the resource is disposed at
            // the end of that block (sample Defer.gs; ADR-0115 §B; ADR-0030).
            // The C# `await` keyword (issue #1903) selects `DisposeAsync` over
            // `Dispose` — dropping it silently would compile a sync `using`
            // against an `IAsyncDisposable`-only type and gsc would reject it
            // (GS0119), so it must be threaded through, never elided.
            let isAwait = !node.AwaitKeyword.IsKind(SyntaxKind.None)
            let statements = List[GStatement]()
            if node.Declaration != nil {
                statements.AddRange(
                    this.TranslateLocalDeclaration(node.Declaration, isConst: false, isUsing: true, isAwait: isAwait)
                )
            } else if node.Expression != nil {
                // `using (expr) body` (no declaration): the resource is the
                // expression value; bind it to a fresh `using let` so disposal
                // is scoped to the block.
                statements.Add(
                    LocalDeclarationStatement(
                        BindingKind.Let,
                        "_",
                        type: nil,
                        initializer: this.TranslateExpression(node.Expression),
                        isUsing: true,
                        isAwait: isAwait
                    )
                )
            }
            let bodyBlock = this.TranslateStatementAsBlock(node.Statement)
            statements.AddRange(bodyBlock.Statements)
            return BlockStatement(statements)
        }

        /// ADR-0143 §D: whether [`expression`](paramref) is an invocation
        /// that binds to an ELIDED unimplemented C# partial method — a partial
        /// method DEFINITION with no implementation part. Such a call produces no
        /// runtime effect in C# and has no G# member to target (the declaration
        /// was elided in (cref:TranslateMethod)), so the enclosing
        /// expression statement is dropped.
        private func IsElidedPartialMethodInvocation(expression ExpressionSyntax) bool {
            if expression is not InvocationExpressionSyntax invocation {
                return false
            }
            // The bound target may resolve to either the defining or the
            // implementing part; normalize to the definition and check whether it
            // is an unimplemented partial definition.
            if this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method {
                return false
            }
            // Issue #4370: a `[LibraryImport]` definition is never elided (it
            // translates to a native `@LibraryImport` func), even when the
            // compilation carries no generated implementation. Issue #4301: nor
            // is a `[GeneratedRegex]` one (it translates to a declaring part).
            let definition = method.PartialDefinitionPart ?? method
            return definition.IsPartialDefinition &&
                definition.PartialImplementationPart == nil &&
                !CSharpToGSharpTranslator.IsLibraryImportDefinition(definition) &&
                !CSharpToGSharpTranslator.IsGeneratedRegexDefinition(definition)
        }

        private func TranslateExpressionStatement(expression ExpressionSyntax?) GStatement? {
            if expression is ConditionalAccessExpressionSyntax conditionalAccess &&
                this
                .TryTranslateNullConditionalStaticExtensionHelperStatement(
                conditionalAccess,
                out var conditionalHelperStatement
            ) {
                return conditionalHelperStatement
            }
            if expression is ConditionalAccessExpressionSyntax voidConditionalAccess &&
                this
                .context
                .GetTypeInfo(voidConditionalAccess)
                .Type
                ?.SpecialType == SpecialType.System_Void &&
                (
                this.RequiresLocalAssignmentSeam(voidConditionalAccess.WhenNotNull) ||
                    this.ContainsFunctionArgumentSpillSeam(voidConditionalAccess.WhenNotNull)
            ) {
                return this.TranslateVoidConditionalAccessWithLocalAssignmentSeam(voidConditionalAccess)
            }
            switch expression {
                case assignment is AssignmentExpressionSyntax when this.IsDelegateMulticastCombine(
                    assignment,
                    out var combineOp
                ) {
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
                    let combineMessage = "delegate multicast '$combineOp' on a non-event delegate-typed target has no G# equivalent: " +
                        "G#'s '+='/'-=' syntax binds only to a declared CLR event, and 'Delegate.Combine'/'Delegate.Remove' " +
                        "are reachable only from the compiler's own synthesized event accessors, not from ordinary call " +
                        "binding (issue #1960)."
                    this.context.ReportUnsupported(assignment, combineMessage)
                    return RawStatement("// unsupported: delegate multicast '$combineOp'")
                }
                case assignment is AssignmentExpressionSyntax {
                    return AssignmentStatement(
                        this.TranslateAssignmentTarget(assignment.Left),
                        this.TranslateAssignmentValue(assignment),
                        assignment.OperatorToken.Text
                    )
                }
                case postfix is PostfixUnaryExpressionSyntax when postfix.IsKind(SyntaxKind.PostIncrementExpression) ||
                    postfix
                    .IsKind(SyntaxKind.PostDecrementExpression) {
                    return IncrementDecrementStatement(
                        this.TranslateExpression(postfix.Operand),
                        postfix.OperatorToken.Text
                    )
                }
                case prefix is PrefixUnaryExpressionSyntax when prefix.IsKind(SyntaxKind.PreIncrementExpression) ||
                    prefix
                    .IsKind(SyntaxKind.PreDecrementExpression) {
                    // G# has no prefix ++/--; both forms are statements with the
                    // same effect, so emit the canonical postfix increment.
                    return IncrementDecrementStatement(
                        this.TranslateExpression(prefix.Operand),
                        prefix.OperatorToken.Text
                    )
                }
                case switchExpression is SwitchExpressionSyntax {
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
                    return this.TranslateSwitchExpressionAsStatement(switchExpression)
                }
                default {
                    return ExpressionStatement(this.TranslateExpression(expression))
                }
            }
        }

        private func TranslateVoidConditionalAccessWithLocalAssignmentSeam(
            conditionalAccess ConditionalAccessExpressionSyntax
        ) GStatement {
            let receiver GExpression? = this.CaptureReceiverOnce(
                this.TranslateExpression(conditionalAccess.Expression),
                conditionalAccess.Expression,
                "a void conditional-access statement here has no enclosing evaluation seam to capture its receiver once."
            )
            let previousReceiver GExpression? = this.state.ConditionalReceiverReplacement
            let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
            let statements = List[GStatement]()
            let replacements = List[ExpressionSyntax]()
            this.state.ConditionalReceiverReplacement = NonNullAssertionExpression(receiver)
            this.state.PendingSpillPrologue = statements
            let embedded = this.HoistAssignmentsInOrder(
                conditionalAccess.WhenNotNull,
                includeSelf: true,
                statements,
                replacements
            )
            try {
                statements.Add(ExpressionStatement(this.TranslateExpression(conditionalAccess.WhenNotNull)))
            } finally {
                this.ReleaseHoistedAssignments(embedded, replacements)
                this.state.PendingSpillPrologue = outerSpillPrologue
                this.state.ConditionalReceiverReplacement = previousReceiver
            }
            return IfStatement(BinaryExpression(receiver, "!=", LiteralExpression.Null()), BlockStatement(statements))
        }

        private func TranslateAssignmentValue(assignment AssignmentExpressionSyntax) GExpression? {
            var value GExpression? = this.CoerceConstantToUnsigned(
                assignment.Right,
                this.TranslateExpression(assignment.Right)
            )
            value = this.CoerceCompoundAssignmentRhs(assignment, value)
            value = this.CoerceCovariantArrayConversion(
                assignment.Right,
                this.CoercePointerConversion(assignment.Right, value)
            )
            // Issues #4500 and #4525: a write into an element of an array
            // cs2gs emits as `T?` accepts nil, so none of the null-forgiveness
            // bridges below may assert the value. The coercions above still apply.
            // Issue #5595: the same holds for a slot of a prebuilt oblivious library,
            // unless a user-defined conversion converts the value: the bridges below
            // decide the operator's input.
            if assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) &&
                (
                this.IsNullableArrayElementAccess(assignment.Left) ||
                    (
                    this.ElementStoreSlotAcceptsNil(assignment.Left) && !this.FlowsThroughUserDefinedConversion(
                        assignment.Right
                    )
                )
            ) {
                return value
            }
            value = this.ForgiveElementAccessAssignmentRhs(assignment, value)
            value = this.ForgiveObliviousExternalAssignmentRhs(assignment, value)
            if !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) {
                return value
            }
            let assignmentTarget ISymbol? = this.GetProjectedAssignmentTarget(
                assignment.Left,
                this.context.GetSymbolInfo(assignment.Left).Symbol
            )
            var assignmentTargetType ITypeSymbol? = this.GetAssignmentTargetType(assignment.Left, assignmentTarget)
            let projectedValue ITypeSymbol? = this.GetManagedReferenceArrayProjectedArgumentType(assignment.Right)
            // The rejectability check passes no destination: the generic
            // member's fixed receiver type can never adopt the projection.
            if (
                assignmentTarget is IFieldSymbol &&
                    assignmentTarget
                    .ContainingType
                    .IsGenericType == true ||
                    assignmentTarget is IPropertySymbol &&
                    assignmentTarget
                    .ContainingType
                    .IsGenericType == true
            ) &&
                assignmentTargetType != nil &&
                projectedValue != nil &&
                SymbolEqualityComparer
                .Default
                .Equals(assignmentTargetType, projectedValue) && !SymbolEqualityComparer.IncludeNullability.Equals(
                assignmentTargetType,
                projectedValue
            ) &&
                this
                .IsRejectableManagedReferenceProjection(assignment.Right, projectedValue, nil) {
                this.context.ReportUnsupported(
                    assignment,
                    "managed-reference array widening cannot change a generic member's fixed receiver type; no exact G# translation exists."
                )
                return value
            }
            var promotionTarget ISymbol? = assignmentTarget
            // Issue #5516: G# infers a `var` local from its initializer, so the storage is fixed
            // non-null only when that initializer is not nullable by declaration.
            var inferredStorageIsNonNull = false
            if assignmentTarget is ILocalSymbol inferredAssignmentLocal &&
                inferredAssignmentLocal
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} declarator &&
                declarator
                .Ancestors()
                .OfType[VariableDeclarationSyntax]()
                .FirstOrDefault()
                ?.Type
                .IsVar == true {
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
                if this.InferredLocalDeclarationIsNullable(inferredAssignmentLocal) {
                    return value
                }
                assignmentTargetType = this.context.GetTypeInfo(initializer).Type
                promotionTarget = nil
                inferredStorageIsNonNull = !this.IsNullableInitializer(initializer)
            }
            return this.ForgiveNullableReferenceValue(
                assignment.Right,
                value,
                assignmentTargetType,
                promotionTarget,
                includePromotedValue: true,
                fixedSink: inferredStorageIsNonNull
            )
        }

        // Expression nullability is absent when warnings are disabled, even
        // when the declared indexer or array element explicitly permits null.
        private func GetAssignmentTargetType(left ExpressionSyntax, target ISymbol?) ITypeSymbol? {
            return switch target {
                case local is ILocalSymbol: local.Type
                case parameter is IParameterSymbol: parameter.Type
                case field is IFieldSymbol: field.Type
                case property is IPropertySymbol: property.Type
                case _ when left is ElementAccessExpressionSyntax element &&
                    this
                    .context
                    .GetTypeInfo(element.Expression)
                    .Type is IArrayTypeSymbol array: array.ElementType
                default: this.context.GetTypeInfo(left).Type
            }
        }

        private func GetProjectedAssignmentTarget(left ExpressionSyntax, target ISymbol?) ISymbol? {
            var target = target
            target ??= switch this.context.SemanticModel.GetOperation(left) {
                case field is IFieldReferenceOperation: cast[ISymbol](field.Field)
                case property is IPropertyReferenceOperation: cast[ISymbol](property.Property)
                default: nil
            }
            let receiver ExpressionSyntax? = switch left {
                case member is MemberAccessExpressionSyntax: member.Expression
                case element is ElementAccessExpressionSyntax: element.Expression
                default: default(ExpressionSyntax?)
            }
            return if receiver != nil && target != nil && this.GetManagedReferenceArrayProjectedExpressionType(
                receiver
            ) is INamedTypeSymbol projectedReceiver {
                this.GetProjectedMember(projectedReceiver, target) ?? target
            } else {
                target
            }
        }

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
        private func TranslateAssignmentTarget(left ExpressionSyntax) GExpression? {
            if left is MemberAccessExpressionSyntax member {
                if member.Expression is IdentifierNameSyntax receiverId &&
                    this
                    .context
                    .GetSymbolInfo(receiverId)
                    .Symbol is {IsStatic: false} receiverSymbol &&
                    (receiverSymbol.Kind == SymbolKind.Property || receiverSymbol.Kind == SymbolKind.Field) {
                    var qualifiedReceiver GExpression? = MemberAccessExpression(
                        ThisExpression(),
                        this.EmittedName(receiverId, receiverId.Identifier)
                    )
                    // ADR-0186 step 6 (PR 0): an inherited oblivious-metadata
                    // member is `T!`, which gsc checks itself.
                    if !this.PlatformTypedImportNeedsNoBridge(receiverId) &&
                        (
                        this.ReceiverNeedsNullForgiveness(receiverId, isDereferenceReceiver: true) ||
                            this.ReceiverIsNullableReferenceFieldOrProperty(receiverId)
                    ) {
                        qualifiedReceiver = EnsureNonNullAssertion(qualifiedReceiver)
                    }
                    return MemberAccessExpression(qualifiedReceiver, this.EmittedName(member, member.Name.Identifier))
                }
                // ADR-0186 step 6 (PR 0): an oblivious-metadata receiver is
                // `T!`, which gsc checks itself.
                if !this.PlatformTypedImportNeedsNoBridge(member.Expression) &&
                    (
                    this.ReceiverNeedsNullForgiveness(member.Expression, isDereferenceReceiver: true) ||
                        this.ReceiverIsNullableReferenceFieldOrProperty(member.Expression) ||
                        (
                        member.Expression is IdentifierNameSyntax hoistedId &&
                            this
                            .context
                            .GetSymbolInfo(hoistedId)
                            .Symbol is {} hoistedSymbol &&
                            this
                            .state
                            .HoistedNullableGuardLocals
                            .Contains(hoistedSymbol)
                    )
                ) {
                    return MemberAccessExpression(
                        EnsureNonNullAssertion(this.TranslateExpression(member.Expression)),
                        this.EmittedName(member, member.Name.Identifier)
                    )
                }
            }
            return this.TranslateExpression(left)
        }

        /// Issue #1741: whether an identifier named `_` is a true C# discard
        /// ((cref:IDiscardSymbol)) rather than a real variable/field named
        /// `_` that happens to be in scope. A real `_` binding is a normal
        /// assignment target, not a discard, and must not be dropped.
        /// @param identifier The `_` identifier on the assignment's left side.
        /// @returns `true` when [`identifier`](paramref) is a genuine discard.
        private func IsTrueDiscard(identifier IdentifierNameSyntax) bool {
            let symbol ISymbol? = this.context.GetSymbolInfo(identifier).Symbol
            // No symbol at all means there is no real `_` binding in scope, so this
            // is a genuine discard; fall back to the name-based check.
            return symbol is IDiscardSymbol || symbol == nil
        }

        private func CanDropDiscardedExpression(expression ExpressionSyntax?) bool {
            var expression = expression
            expression = Unwrap(expression)
            switch expression {
                case LiteralExpressionSyntax,
                ThisExpressionSyntax,
                BaseExpressionSyntax,
                DefaultExpressionSyntax,
                TypeOfExpressionSyntax {
                    return true
                }
                case identifier is IdentifierNameSyntax {
                    let symbol ISymbol? = this.context.GetSymbolInfo(identifier).Symbol
                    return symbol is IRangeVariableSymbol ||
                        (symbol is ILocalSymbol local && local.RefKind == RefKind.None) ||
                        (symbol is IParameterSymbol parameter && parameter.RefKind == RefKind.None)
                }
                case suppressed is PostfixUnaryExpressionSyntax when suppressed.IsKind(
                    SyntaxKind.SuppressNullableWarningExpression
                ) {
                    return this.CanDropDiscardedExpression(suppressed.Operand)
                }
                case tuple is TupleExpressionSyntax {
                    return tuple.Arguments.All(
                        (argument ArgumentSyntax) -> this.CanDropDiscardedExpression(argument.Expression)
                    )
                }
                default {
                    return false
                }
            }
        }

        /// Translates an expression-statement that may expand into several G#
        /// statements: tuple declaration/deconstruction forms may expand, while
        /// ordinary chained assignments remain native nested expressions.
        private func TranslateExpressionStatements(expression ExpressionSyntax?, hoistPostfix bool = true) IEnumerable[
            GStatement
        ]? {
            if expression is AssignmentExpressionSyntax assignment && assignment.IsKind(
                SyntaxKind.SimpleAssignmentExpression
            ) {
                if assignment.Left is IdentifierNameSyntax{Identifier: {ValueText: "_"}} discardCandidate &&
                    this
                    .IsTrueDiscard(discardCandidate) {
                    // C# statement-level discard `_ = e` (Roslyn parses the `_`
                    // target as an IdentifierNameSyntax). G# has no discard target
                    // (`_ = e` → GS0125). Drop only reads that cannot run code or
                    // throw; otherwise G#'s native discard declaration evaluates
                    // the RHS exactly once while keeping its value unbound.
                    if this.CanDropDiscardedExpression(assignment.Right) {
                        return Array.Empty[GStatement]()
                    }
                    let discardedValue ExpressionSyntax? = Unwrap(assignment.Right)
                    if (discardedValue is AssignmentExpressionSyntax || discardedValue is SwitchExpressionSyntax) ||
                        (
                        discardedValue is PrefixUnaryExpressionSyntax prefix &&
                            (
                            prefix.IsKind(SyntaxKind.PreIncrementExpression) || prefix.IsKind(
                                SyntaxKind.PreDecrementExpression
                            )
                        )
                    ) ||
                        (
                        discardedValue is PostfixUnaryExpressionSyntax postfix &&
                            (
                            postfix.IsKind(SyntaxKind.PostIncrementExpression) || postfix.IsKind(
                                SyntaxKind.PostDecrementExpression
                            )
                        )
                    ) {
                        return this.TranslateExpressionStatements(discardedValue)
                    }
                    return this.WithHoistedAssignments(
                        assignment.Right,
                        includeSelf: true,
                        () -> List[GStatement]{
                            LocalDeclarationStatement(
                                BindingKind.Let,
                                "_",
                                initializer: this.TranslateExpression(assignment.Right)
                            )
                        }
                    )
                }
                if this.TryGetDeconstructionTargets(assignment.Left, out var binding, out var names) {
                    return []GStatement{
                        cast[GStatement](
                            TupleDeconstructionStatement(binding, names, this.TranslateExpression(assignment.Right))
                        )
                    }
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
                if assignment.Left is DeclarationExpressionSyntax nestedDeclarationExpression &&
                    nestedDeclarationExpression.Designation is ParenthesizedVariableDesignationSyntax nestedDeclaration {
                    return this.LowerTupleDeclaration(
                        nestedDeclaration,
                        assignment.Right,
                        nestedDeclarationExpression.Type.IsVar
                    )
                }
                if assignment.Left is TupleExpressionSyntax leftTuple {
                    return this.LowerTupleAssignment(leftTuple, assignment.Right)
                }
            }
            // Ordinary chains, including `??=`, are native G# assignment
            // expressions. Keep legacy flattening only when a link is
            // tuple-valued and still needs statement-hosting lowering.
            if expression is AssignmentExpressionSyntax outerAssignment &&
                AssignmentChainRequiresStatementLowering(outerAssignment) {
                return this.FlattenChainedAssignment(outerAssignment, preserveValue: false)
            }
            return this.WithHoistedAssignments(
                expression,
                includeSelf: false,
                () -> if hoistPostfix {
                    this.WithHoistedPostfix(
                        expression,
                        func () IEnumerable[GStatement] {
                            return []GStatement{this.TranslateExpressionStatement(expression)!!}
                        }
                    )
                        .ToList()
                } else {
                    List[GStatement]{this.TranslateExpressionStatement(expression)!!}
                }
            )
        }

        /// Translates an expression in statement position, hoisting any embedded
        /// post-increment/decrement (`a[i++] = x`, `M(i--)`, `x = y++`) into
        /// trailing `i++` / `i--` statements. G# models inc/dec as statements, so
        /// the sub-expression is suppressed (read as its pre-increment value) and
        /// the mutation is appended after the main statement (ADR-0115 §B).
        /// @remarks Issue #4114: this hoist-to-trailing-statement strategy is only sound
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
        private func WithHoistedPostfix(
            expression ExpressionSyntax?,
            buildMain() -> IEnumerable[GStatement]
        ) IEnumerable[GStatement] {
            let embedded = CollectEmbeddedPostfix(expression)
            if embedded.Count == 0 {
                return buildMain()
            }
            let targetOccurrences = Dictionary[ISymbol, int32](SymbolEqualityComparer.Default)
            for node in embedded {
                let target ISymbol? = this.context.GetSymbolInfo(node.Operand).Symbol
                if target != nil {
                    targetOccurrences[target] = if targetOccurrences.TryGetValue(target, out var count) {
                        count + 1
                    } else {
                        1
                    }
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
            let hoistable = embedded.Where(
                (node PostfixUnaryExpressionSyntax) -> {
                    let target ISymbol? = this.context.GetSymbolInfo(node.Operand).Symbol
                    return target != nil && targetOccurrences[target] == 1
                }
            )
                .ToList()
            if hoistable.Count == 0 {
                return buildMain()
            }
            for node in hoistable {
                this.state.SuppressedPostfix.Add(node)
            }
            var statements List[GStatement]
            try {
                statements = buildMain().ToList()
            } finally {
                for node in hoistable {
                    this.state.SuppressedPostfix.Remove(node)
                }
            }
            for node in hoistable {
                statements.Add(
                    IncrementDecrementStatement(this.TranslateExpression(node.Operand), node.OperatorToken.Text)
                )
            }
            return statements
        }

        shared {
            private const ReachingTupleProjectionAnnotation string = "cs2gs-reaching-tuple-projection"

            private func IsNullForgiven(expression ExpressionSyntax) bool {
                var expression = expression
                while expression is ParenthesizedExpressionSyntax parenthesized {
                    expression = parenthesized.Expression
                }
                return expression is PostfixUnaryExpressionSyntax &&
                    expression.RawKind == int32(SyntaxKind.SuppressNullableWarningExpression)
            }

            private func TryFindDeconstructionPath(
                target SingleVariableDesignationSyntax,
                left ExpressionSyntax?,
                path List[int32],
                out found List[int32]?
            ) bool {
                var left = left
                left = Unwrap(left)
                if left is DeclarationExpressionSyntax declaration {
                    return TryFindDeconstructionPath(target, declaration.Designation, path, out found)
                }
                if left is TupleExpressionSyntax tuple {
                    for var i = 0; i < tuple.Arguments.Count; i++ {
                        path.Add(i)
                        if TryFindDeconstructionPath(target, tuple.Arguments[i].Expression, path, out found) {
                            return true
                        }
                        path.RemoveAt(path.Count - 1)
                    }
                }
                found = nil
                return false
            }

            private func TryFindDeconstructionPath(
                target SingleVariableDesignationSyntax,
                designation VariableDesignationSyntax,
                path List[int32],
                out found List[int32]?
            ) bool {
                if designation.SyntaxTree == target.SyntaxTree && designation.Span == target.Span {
                    found = List[int32](path)
                    return true
                }
                if designation is ParenthesizedVariableDesignationSyntax parenthesized {
                    for var i = 0; i < parenthesized.Variables.Count; i++ {
                        path.Add(i)
                        if TryFindDeconstructionPath(target, parenthesized.Variables[i], path, out found) {
                            return true
                        }
                        path.RemoveAt(path.Count - 1)
                    }
                }
                found = nil
                return false
            }

            private func ProjectTupleElement(
                expression ExpressionSyntax?,
                path IReadOnlyList[int32]?
            ) ExpressionSyntax? {
                return ProjectTupleElement(expression, path, 0)
            }

            private func ProjectTupleElement(
                expression ExpressionSyntax?,
                path IReadOnlyList[int32]?,
                depth int32
            ) ExpressionSyntax? {
                var expression = expression
                if depth == path!!.Count {
                    return expression
                }
                expression = Unwrap(expression)
                if IsNullOrDefaultLiteral(expression) {
                    return SyntaxFactory.LiteralExpression(SyntaxKind.DefaultLiteralExpression)
                }
                let index = path!![depth]
                if expression is TupleExpressionSyntax tuple && index < tuple.Arguments.Count {
                    return ProjectTupleElement(tuple.Arguments[index].Expression, path, depth + 1)
                }
                if expression is ConditionalExpressionSyntax conditional {
                    return conditional.WithWhenTrue(ProjectTupleElement(conditional.WhenTrue, path, depth)!!)
                        .WithWhenFalse(ProjectTupleElement(conditional.WhenFalse, path, depth)!!)
                }
                if expression is SwitchExpressionSyntax switchExpression {
                    return switchExpression.WithArms(
                        SyntaxFactory.SeparatedList(
                            switchExpression.Arms.Select(
                                (arm SwitchExpressionArmSyntax) -> arm.WithExpression(
                                    ProjectTupleElement(arm.Expression, path, depth)!!
                                )
                            )
                        )
                    )
                }
                let member ExpressionSyntax = SyntaxFactory.MemberAccessExpression(
                    SyntaxKind.SimpleMemberAccessExpression,
                    SyntaxFactory.ParenthesizedExpression(expression!!),
                    SyntaxFactory.IdentifierName("Item${index + 1}")
                )
                return ProjectTupleElement(member, path, depth + 1)
            }

            private func GetSourceDelegateAliasBehavior(
                use IdentifierNameSyntax,
                body SyntaxNode?,
                model SemanticModel,
                visited HashSet[ISymbol]
            ) DelegateArgumentBehavior {
                var alias ILocalSymbol? = nil
                if use
                    .Ancestors()
                    .OfType[VariableDeclaratorSyntax]()
                    .FirstOrDefault() is {Initializer: {Value: {} initializer}} declarator &&
                    initializer
                    .Span
                    .Contains(use.Span) {
                    alias = model.GetDeclaredSymbol(declarator) as ILocalSymbol
                } else if use
                    .Ancestors()
                    .OfType[AssignmentExpressionSyntax]()
                    .FirstOrDefault(
                    (assignment AssignmentExpressionSyntax) -> assignment.Right.Span.Contains(use.Span)
                ) is {Left: {} left} {
                    alias = model.GetSymbolInfo(left).Symbol as ILocalSymbol
                }
                if alias?.Type.TypeKind != TypeKind.Delegate || !visited.Add(alias!!) {
                    return DelegateArgumentBehavior.Escapes
                }
                var invoked = false
                let eagerUses = EagerExecutionNodes(body)
                    .OfType[IdentifierNameSyntax]()
                    .Where(
                    (identifier IdentifierNameSyntax) -> SymbolEqualityComparer.Default.Equals(
                        model.GetSymbolInfo(identifier).Symbol,
                        alias
                    )
                )
                    .ToList()
                for aliasUse in eagerUses {
                    if DelegateParameterUseIsInvocation(aliasUse) {
                        invoked = true
                        continue
                    }
                    if DelegateParameterUseIsNonEscapingObservation(aliasUse, model) {
                        continue
                    }
                    let behavior = GetSourceDelegateAliasBehavior(aliasUse, body, model, visited)
                    if behavior == DelegateArgumentBehavior.Escapes {
                        return behavior
                    }
                    invoked |= behavior == DelegateArgumentBehavior.InvokedDuringCall
                }
                let eagerUseStarts = eagerUses.Select((eagerUse IdentifierNameSyntax) -> eagerUse.SpanStart).ToHashSet()
                let capturedByNestedExecutable = body!!
                    .DescendantNodes()
                    .OfType[IdentifierNameSyntax]()
                    .Any(
                    (identifier IdentifierNameSyntax) -> SymbolEqualityComparer.Default.Equals(
                        model.GetSymbolInfo(identifier).Symbol,
                        alias
                    ) &&
                        !eagerUseStarts.Contains(identifier.SpanStart)
                )
                if capturedByNestedExecutable {
                    return DelegateArgumentBehavior.Escapes
                }
                return if invoked {
                    DelegateArgumentBehavior.InvokedDuringCall
                } else {
                    DelegateArgumentBehavior.NotObserved
                }
            }

            private func DelegateCalleeMayDispatchDynamically(
                argument ArgumentSyntax,
                parameter IParameterSymbol?
            ) bool {
                if parameter!!.ContainingSymbol is not IMethodSymbol method ||
                    method.IsStatic ||
                    method.MethodKind == MethodKind.LocalFunction ||
                    method.IsSealed ||
                    method
                    .ContainingType
                    ?.IsSealed == true ||
                    method != nil &&
                    method.IsAbstract == false &&
                    method.IsVirtual == false &&
                    method.IsOverride == false {
                    return false
                }
                return argument
                    .Parent
                    ?.Parent is not(
                    InvocationExpressionSyntax and
                        {Expression: MemberAccessExpressionSyntax and {Expression: BaseExpressionSyntax}}
                )
            }

            private func DelegateParameterUseIsInvocation(use IdentifierNameSyntax) bool {
                if use.Parent is InvocationExpressionSyntax direct && direct.Expression == use {
                    return true
                }
                if use.Parent is MemberAccessExpressionSyntax member &&
                    member.Expression == use &&
                    member
                    .Name
                    .Identifier
                    .ValueText == "Invoke" &&
                    member.Parent is InvocationExpressionSyntax {
                    return true
                }
                return use.Parent is ConditionalAccessExpressionSyntax conditional &&
                    conditional.Expression == use &&
                    conditional.WhenNotNull is InvocationExpressionSyntax invocation &&
                    invocation.Expression is MemberBindingExpressionSyntax binding &&
                    binding
                    .Name
                    .Identifier
                    .ValueText == "Invoke"
            }

            private func DelegateParameterUseIsNonEscapingObservation(
                use IdentifierNameSyntax,
                model SemanticModel
            ) bool {
                let memberName SimpleNameSyntax? = switch use.Parent {
                    case member is MemberAccessExpressionSyntax when member.Expression == use: member.Name
                    case conditional is ConditionalAccessExpressionSyntax when conditional.Expression == use &&
                        conditional.WhenNotNull is MemberBindingExpressionSyntax binding: binding.Name
                    default: default(SimpleNameSyntax?)
                }
                if memberName == nil {
                    return false
                }
                let observedMember ISymbol? = model.GetSymbolInfo(memberName).Symbol
                let containingType INamedTypeSymbol? = observedMember?.ContainingType
                let isObjectOrDelegate = containingType?.SpecialType == SpecialType.System_Object ||
                    (containingType?.ToDisplayString() is "System.Delegate" or "System.MulticastDelegate")
                let isTerminalObservation = switch observedMember {
                    case method is IMethodSymbol when(
                        method.Name is "GetHashCode" or "ToString" or "GetType" or "Equals"
                    ): true
                    case property is IPropertySymbol when(property.Name is "Method" or "Target"): true
                    default: false
                }
                return isObjectOrDelegate && isTerminalObservation
            }

            private func LocalFunctionMatches(
                symbol ISymbol?,
                localFunction IMethodSymbol
            ) bool -> symbol is IMethodSymbol method &&
                SymbolEqualityComparer
                .Default
                .Equals(method.OriginalDefinition, localFunction.OriginalDefinition)

            private func AddDelegateCounts(left int32, right int32) int32 -> Math.Min(2, left + right)

            // Issue #4611: yield a block's operations followed by its branch value,
            // only when it has one. Appending the possibly-null BranchValue and
            // filtering it afterwards stores a null in a sequence of IOperation;
            // the migration bridges that argument with a fail-fast `!!` (the
            // settled policy for nil entering generic storage), so the migrated
            // translator threw on the first block without a branch value.
            private func BlockOperationsAndBranchValue(block BasicBlock) sequence[IOperation] {
                for operation in block.Operations {
                    yield operation
                }
                if block.BranchValue is {} branchValue {
                    yield branchValue
                }
            }

            private func FindEnclosingExecutable(nested SyntaxNode?) SyntaxNode -> nested!!.Ancestors().First(
                (node SyntaxNode) -> (
                    node is BaseMethodDeclarationSyntax ||
                        node is AccessorDeclarationSyntax ||
                        node is LocalFunctionStatementSyntax ||
                        node is AnonymousFunctionExpressionSyntax ||
                        node is CompilationUnitSyntax
                ) ||
                    node is PrimaryConstructorBaseTypeSyntax ||
                    (
                    node is ArrowExpressionClauseSyntax arrow &&
                        (arrow.Parent is PropertyDeclarationSyntax or IndexerDeclarationSyntax)
                ) ||
                    (
                    node is EqualsValueClauseSyntax initializer &&
                        (
                        initializer.Parent is PropertyDeclarationSyntax ||
                            initializer
                            .Parent
                            ?.Parent
                            ?.Parent is FieldDeclarationSyntax
                    )
                )
            )

            private func ReachingWritePosition(node SyntaxNode) int32 -> if node is ArgumentSyntax{
                RefOrOutKeyword: {RawKind: not int32(SyntaxKind.None)}
            } argument {
                argument.Parent?.Parent?.Span.End ?? argument.Span.End
            } else {
                node.Span.End
            }

            private func CreateUnknownTuple(type ITypeSymbol?) ExpressionSyntax {
                if type is not INamedTypeSymbol{IsTupleType: true} tuple {
                    return SyntaxFactory.IdentifierName("__unknown")
                }
                return SyntaxFactory.TupleExpression(
                    SyntaxFactory.SeparatedList(
                        tuple.TupleElements.Select(
                            (element IFieldSymbol) -> SyntaxFactory.Argument(CreateUnknownTuple(element.Type))
                        )
                    )
                )
            }

            private func TupleElementIndex(tupleType INamedTypeSymbol, field IFieldSymbol) int32 {
                let canonical = field.CorrespondingTupleField ?? field
                for var i = 0; i < tupleType.TupleElements.Length; i++ {
                    let candidate = tupleType.TupleElements[i].CorrespondingTupleField ?? tupleType.TupleElements[i]
                    if SymbolEqualityComparer.Default.Equals(candidate, canonical) ||
                        tupleType
                        .TupleElements[i]
                        .Name == field.Name {
                        return i
                    }
                }
                return -1
            }

            private func TupleReachingStateKey(expression ExpressionSyntax) string {
                let projections = expression
                    .DescendantNodesAndSelf()
                    .SelectMany(
                    func (node SyntaxNode) IEnumerable[SyntaxAnnotation] {
                        return node.GetAnnotations(ReachingTupleProjectionAnnotation)
                    }
                )
                    .Select((annotation SyntaxAnnotation) -> annotation.Data!!)
                let sourceNodes = expression
                    .DescendantNodesAndSelf()
                    .Where((node SyntaxNode) -> node.SyntaxTree != nil)
                    .Select(
                    (node SyntaxNode) -> (
                        node.RawKind.ToString(CultureInfo.InvariantCulture) + ":" + node.SpanStart.ToString(
                            CultureInfo.InvariantCulture
                        ) +
                            ":" +
                            node
                            .Span
                            .Length
                            .ToString(CultureInfo.InvariantCulture)
                    )
                )
                return expression.ToString() + "|" + string.Join(";", sourceNodes) + "|" + string.Join(";", projections)
            }

            private func IsComparisonOperator(op string) bool -> op == "==" ||
                op == "!=" ||
                op == "<" ||
                op == "<=" ||
                op == ">" ||
                op == ">="

            private func IsShortCircuitOperator(binary BinaryExpressionSyntax) bool -> binary.IsKind(
                SyntaxKind.LogicalAndExpression
            ) ||
                binary.IsKind(SyntaxKind.LogicalOrExpression) || binary.IsKind(SyntaxKind.CoalesceExpression)

            // Reports whether `type` is an integral type that does NOT implicitly widen
            // to `int32` in C# — `uint`/`uint32`, `long`/`int64`, `ulong`/`uint64`,
            // `nint`, and `nuint`. The narrow integrals (`byte`, `sbyte`, `short`,
            // `ushort`, `char`) and `int` itself widen to/are `int32` and return false.
            private func IsIntegerNotWideningToInt32(type ITypeSymbol?) bool {
                switch type!!.SpecialType {
                    case SpecialType.System_UInt32,
                    SpecialType.System_Int64,
                    SpecialType.System_UInt64,
                    SpecialType.System_IntPtr,
                    SpecialType.System_UIntPtr {
                        return true
                    }
                    default {
                        return false
                    }
                }
            }

            // Unwraps `System.Nullable<T>` to its underlying `T`; other types pass
            // through unchanged.
            private func UnwrapNullable(type ITypeSymbol?) ITypeSymbol? {
                if type is INamedTypeSymbol named &&
                    named
                    .OriginalDefinition
                    .SpecialType == SpecialType.System_Nullable_T &&
                    named
                    .TypeArguments
                    .Length == 1 {
                    return named.TypeArguments[0]
                }
                return type
            }

            // Reports whether `type` is a value type that is not `System.Nullable<T>`,
            // i.e. a target for which G#'s `as` operator is invalid (GS0270) and the
            // conversion-call form must be used instead.
            private func IsNonNullableValueType(type ITypeSymbol?) bool {
                if type == nil || !type.IsValueType {
                    return false
                }
                if type is INamedTypeSymbol named &&
                    named
                    .OriginalDefinition
                    .SpecialType == SpecialType.System_Nullable_T {
                    return false
                }
                return true
            }

            private func IsNumericPromotionOperator(op string) bool {
                switch op {
                    case "==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "&", "|", "^" {
                        return true
                    }
                    default {
                        return false
                    }
                }
            }

            // Reports whether `type` is a numeric primitive (unwrapping Nullable<T>) and
            // yields its underlying special type. `char` is included because C# promotes
            // it to `int` in arithmetic/comparison/bitwise contexts, so a mismatched
            // `uint8 == 'A'` needs a G# conversion here. `bool`/`string` are excluded.
            private func TryGetNumericKind(type ITypeSymbol?, out underlying SpecialType) bool {
                var type = type
                underlying = SpecialType.None
                if type == nil {
                    return false
                }
                if type is INamedTypeSymbol named &&
                    named
                    .OriginalDefinition
                    .SpecialType == SpecialType.System_Nullable_T &&
                    named
                    .TypeArguments
                    .Length == 1 {
                    type = named.TypeArguments[0]
                }
                switch type!!.SpecialType {
                    case SpecialType.System_Char,
                    SpecialType.System_SByte,
                    SpecialType.System_Byte,
                    SpecialType.System_Int16,
                    SpecialType.System_UInt16,
                    SpecialType.System_Int32,
                    SpecialType.System_UInt32,
                    SpecialType.System_Int64,
                    SpecialType.System_UInt64,
                    SpecialType.System_Single,
                    SpecialType.System_Double,
                    SpecialType.System_Decimal {
                        underlying = type!!.SpecialType
                        return true
                    }
                    default {
                        return false
                    }
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
            private func IsIntegralNumericKind(underlying SpecialType) bool {
                switch underlying {
                    case SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal {
                        return false
                    }
                    default {
                        return true
                    }
                }
            }

            /// Issue #3501: true when the arm a `goto case`/`goto
            /// default` targets does nothing — its section body is empty or a
            /// single bare `break;` — so the jump is equivalent to exiting
            /// the switch.
            private func TargetArmIsEmptyBreak(
                target SwitchLabelSyntax?
            ) bool -> target!!.Parent is SwitchSectionSyntax section &&
                (
                section
                    .Statements
                    .Count == 0 ||
                    (section.Statements.Count == 1 && section.Statements[0] is BreakStatementSyntax)
            )

            /// Issue #3501: true when a loop or a nested `switch` sits
            /// between the `goto` and its enclosing switch, so a bare
            /// `break` emitted in the goto's position would bind to that
            /// inner construct instead of the switch.
            private func HasInterveningBreakTarget(gotoStatement GotoStatementSyntax) bool {
                for var node SyntaxNode? = gotoStatement.Parent; node != nil; node = node!!.Parent {
                    switch node {
                        case SwitchStatementSyntax {
                            return false
                        }
                        case _ is ForStatementSyntax or
                            _ is ForEachStatementSyntax or
                            _ is ForEachVariableStatementSyntax or
                            _ is WhileStatementSyntax or
                            _ is DoStatementSyntax {
                            return true
                        }
                    }
                }
                return false
            }

            // Strips parentheses so chain/assignment detection is parenthesis-transparent.
            private func Unwrap(expression ExpressionSyntax?) ExpressionSyntax? {
                var expression = expression
                while expression is ParenthesizedExpressionSyntax paren {
                    expression = paren.Expression
                }
                return expression
            }

            private func AssignmentChainRequiresStatementLowering(assignment AssignmentExpressionSyntax) bool {
                if AssignmentRequiresStatementLowering(assignment) {
                    return true
                }
                return Unwrap(assignment.Right) is AssignmentExpressionSyntax nested &&
                    AssignmentChainRequiresStatementLowering(nested)
            }
        }
    }
}
