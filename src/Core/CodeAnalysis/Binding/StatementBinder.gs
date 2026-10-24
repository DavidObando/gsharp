// <copyright file="StatementBinder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Threading

/// Extracted from (cref:Binder) in PR-B-7. Owns all per-statement-kind
/// binding logic: dispatch ((cref:BindStatement)), block bodies, locals
/// and deconstruction, control flow (`if`, `switch`, `for`
/// family, `break`/`continue`/`return`), effects (`try`,
/// `throw`, `using`, `defer`, `go`, channel send,
/// `select`, `yield`, `scope`), and the expression-statement
/// fall-through. Type-system narrowing helpers (nil-guard, MemberNotNullWhen
/// merging, pattern narrowing) ride along because they are only consumed by
/// statement binders. Expression binding remains on (cref:Binder) and is
/// invoked via the delegate callbacks supplied to the constructor; the two
/// symbol-construction `BindVariableDeclaration` overloads (used pervasively
/// across non-statement contexts) also stay on (cref:Binder) and are
/// invoked through delegate callbacks here.
internal partial class StatementBinder {
    private let binderCtx BinderContext
    private let conversions ConversionClassifier
    private let patterns PatternBinder
    private let bindExpression StatementBinder_BindExpressionDelegate
    private let bindExpressionWithTargetType StatementBinder_BindExpressionWithTargetTypeDelegate
    private let bindTypeClause(TypeClauseSyntax) -> TypeSymbol?
    private let bindLocalVariable StatementBinder_BindLocalVariableDelegate
    private let bindLocalVariableWithAccessibility StatementBinder_BindLocalVariableWithAccessibilityDelegate
    private let bindVariableReference(string, TextLocation) -> VariableSymbol?
    private let bindInterpolatedStringAsFormattable(InterpolatedStringExpressionSyntax, TypeSymbol) -> BoundExpression
    private let isFormattableStringTargetType(TypeSymbol) -> bool
    private let isLvalue(BoundExpression) -> bool
    private let isIteratorReturnType(TypeSymbol) -> bool
    private let resolveAccessibility(SyntaxToken?) -> Accessibility
    private let bindVariableDeclarationAttributes StatementBinder_BindVariableDeclarationAttributesDelegate
    private let getCurrentFunction() -> FunctionSymbol?
    private let bindLambdaWithTargetType((LambdaExpressionSyntax, FunctionTypeSymbol) -> BoundExpression)?

    /// Issue #3501 A2: binds a function-literal initializer with a hook that
    /// fires after the literal's signature binds (and before its body does),
    /// letting `BindVariableDeclaration` declare the variable first so
    /// the body can self-reference. See
    /// `LambdaBinder.BindFunctionLiteralExpression`'s
    /// `onSignatureBound` parameter.
    private let bindFunctionLiteralWithSelfDeclaration(
        (FunctionLiteralExpressionSyntax, (FunctionSymbol, FunctionTypeSymbol) -> void) -> BoundExpression
    )?

    private let prepareGenericLocalFunctionDeclaration((VariableDeclarationSyntax) -> () -> BoundStatement)?
    private let checkNonGenericLocalFunctionEnclosingTypeParameterReference(
        (TextLocation, string, BoundFunctionLiteralExpression) -> void
    )?

    /// Issue #4221: after every member of a consecutive run of generic
    /// local-function declarations has had its body bound once (in source
    /// order), re-converges the whole group's captured-variable sets to a
    /// fixed point — see `LambdaBinder.ReconcileGenericLocalFunctionGroupCaptures`.
    private let reconcileGenericLocalFunctionGroupCaptures((IReadOnlyList[BoundFunctionLiteralExpression]) -> void)?
    private let bindNullCoalescingAssignmentStatement(
        (ExpressionStatementSyntax, NullCoalescingAssignmentExpressionSyntax) -> BoundStatement
    )?

    private let exceptionHandlerRegions Stack[SyntaxNode] = Stack[SyntaxNode]()
    private let activeFinallyClauses Stack[FinallyClauseSyntax] = Stack[FinallyClauseSyntax]()
    private let activeCleanupStatements Stack[BoundStatement] = Stack[BoundStatement]()
    private let activeCleanupRegions Stack[GotoCleanupRegion] = Stack[GotoCleanupRegion]()
    private let boundFinallyBlocks Dictionary[FinallyClauseSyntax, BoundStatement] = Dictionary[
        FinallyClauseSyntax,
        BoundStatement
    ]()
    private let finallyEntryExternalCallableAliases Dictionary[
        FinallyClauseSyntax,
        ImmutableArray[VariableSymbol]
    ] = Dictionary[FinallyClauseSyntax, ImmutableArray[VariableSymbol]]()
    private let finallyFlowSummaries Dictionary[BoundStatement, FinallyFlowSummary] = Dictionary[
        BoundStatement,
        FinallyFlowSummary
    ]()
    private let userLabelHandlerRegions Dictionary[string, ImmutableArray[SyntaxNode]] = Dictionary[
        string,
        ImmutableArray[SyntaxNode]
    ](StringComparer.Ordinal)
    private let userGotoHandlerRegions List[
        (LabelName string, Location TextLocation, SourceRegions ImmutableArray[SyntaxNode])
    ] = List[(LabelName string, Location TextLocation, SourceRegions ImmutableArray[SyntaxNode])]()
    private let internallyReachableFallthroughStatements HashSet[BoundStatement] = HashSet[BoundStatement]()
    private let internallyReachableLoopExits HashSet[BoundLabel] = HashSet[BoundLabel]()
    private let internallyReachableLoopBacks HashSet[BoundLabel] = HashSet[BoundLabel]()
    private var internalReachabilityGeneration int32
    private var currentStatementListFallsThrough bool = true
    private var usingInitializationFlagCount int32

    init(
        binderCtx BinderContext,
        conversions ConversionClassifier,
        patterns PatternBinder,
        bindExpression StatementBinder_BindExpressionDelegate,
        bindExpressionWithTargetType StatementBinder_BindExpressionWithTargetTypeDelegate,
        bindTypeClause(TypeClauseSyntax) -> TypeSymbol?,
        bindLocalVariable StatementBinder_BindLocalVariableDelegate,
        bindLocalVariableWithAccessibility StatementBinder_BindLocalVariableWithAccessibilityDelegate,
        bindVariableReference(string, TextLocation) -> VariableSymbol?,
        bindInterpolatedStringAsFormattable(InterpolatedStringExpressionSyntax, TypeSymbol) -> BoundExpression,
        isFormattableStringTargetType(TypeSymbol) -> bool,
        isLvalue(BoundExpression) -> bool,
        isIteratorReturnType(TypeSymbol) -> bool,
        resolveAccessibility(SyntaxToken?) -> Accessibility,
        bindVariableDeclarationAttributes StatementBinder_BindVariableDeclarationAttributesDelegate,
        getCurrentFunction() -> FunctionSymbol?,
        bindLambdaWithTargetType((LambdaExpressionSyntax, FunctionTypeSymbol) -> BoundExpression)? = nil,
        prepareGenericLocalFunctionDeclaration((VariableDeclarationSyntax) -> () -> BoundStatement)? = nil,
        checkNonGenericLocalFunctionEnclosingTypeParameterReference(
            (TextLocation, string, BoundFunctionLiteralExpression) -> void
        )? = nil,
        bindFunctionLiteralWithSelfDeclaration(
            (FunctionLiteralExpressionSyntax, (FunctionSymbol, FunctionTypeSymbol) -> void) -> BoundExpression
        )? = nil,
        reconcileGenericLocalFunctionGroupCaptures((IReadOnlyList[BoundFunctionLiteralExpression]) -> void)? = nil,
        bindNullCoalescingAssignmentStatement(
            (ExpressionStatementSyntax, NullCoalescingAssignmentExpressionSyntax) -> BoundStatement
        )? = nil
    ) {
        this.binderCtx = binderCtx ?? throw ArgumentNullException("binderCtx")
        this.conversions = conversions ?? throw ArgumentNullException("conversions")
        this.patterns = patterns ?? throw ArgumentNullException("patterns")
        this.bindExpression = bindExpression ?? throw ArgumentNullException("bindExpression")
        this.bindExpressionWithTargetType = bindExpressionWithTargetType ??
            throw ArgumentNullException("bindExpressionWithTargetType")
        this.bindTypeClause = bindTypeClause ?? throw ArgumentNullException("bindTypeClause")
        this.bindLocalVariable = bindLocalVariable ?? throw ArgumentNullException("bindLocalVariable")
        this.bindLocalVariableWithAccessibility = bindLocalVariableWithAccessibility ??
            throw ArgumentNullException("bindLocalVariableWithAccessibility")
        this.bindVariableReference = bindVariableReference ?? throw ArgumentNullException("bindVariableReference")
        this.bindInterpolatedStringAsFormattable = bindInterpolatedStringAsFormattable ??
            throw ArgumentNullException("bindInterpolatedStringAsFormattable")
        this.isFormattableStringTargetType = isFormattableStringTargetType ??
            throw ArgumentNullException("isFormattableStringTargetType")
        this.isLvalue = isLvalue ?? throw ArgumentNullException("isLvalue")
        this.isIteratorReturnType = isIteratorReturnType ?? throw ArgumentNullException("isIteratorReturnType")
        this.resolveAccessibility = resolveAccessibility ?? throw ArgumentNullException("resolveAccessibility")
        this.bindVariableDeclarationAttributes = bindVariableDeclarationAttributes ??
            throw ArgumentNullException("bindVariableDeclarationAttributes")
        this.getCurrentFunction = getCurrentFunction ?? throw ArgumentNullException("getCurrentFunction")
        this.bindLambdaWithTargetType = bindLambdaWithTargetType
        this.prepareGenericLocalFunctionDeclaration = prepareGenericLocalFunctionDeclaration
        this.checkNonGenericLocalFunctionEnclosingTypeParameterReference = checkNonGenericLocalFunctionEnclosingTypeParameterReference
        this.bindFunctionLiteralWithSelfDeclaration = bindFunctionLiteralWithSelfDeclaration
        this.reconcileGenericLocalFunctionGroupCaptures = reconcileGenericLocalFunctionGroupCaptures
        this.bindNullCoalescingAssignmentStatement = bindNullCoalescingAssignmentStatement
    }

    private prop Diagnostics DiagnosticBag -> binderCtx.Diagnostics

    private prop $scope BoundScope {
        get -> binderCtx.RootScope
        set -> this.binderCtx.RootScope = value
    }

    private prop function FunctionSymbol? -> getCurrentFunction()

    private func BindErrorStatement() BoundStatement {
        return BoundExpressionStatement(nil, BoundErrorExpression(nil))
    }

    internal func BindStatement(syntax StatementSyntax) BoundStatement? {
        // ADR-0169: guarantee the dispatch-level anchor so semantic-model and
        // analyzer queries can resolve this statement by its syntax.
        let result = BindStatementCore(syntax)
        result?.AnchorSyntax(syntax)
        return result
    }

    private func BindStatementCore(syntax StatementSyntax) BoundStatement? {
        switch syntax.Kind {
            case SyntaxKind.CommentToken {
                // comments don't need to be bound
                return nil
            }
            case SyntaxKind.BlockStatement {
                return BindBlockStatement(cast[BlockStatementSyntax](syntax))
            }
            case SyntaxKind.VariableDeclaration {
                return BindVariableDeclaration(cast[VariableDeclarationSyntax](syntax))
            }
            case SyntaxKind.IfStatement {
                return BindIfStatement(cast[IfStatementSyntax](syntax))
            }
            case SyntaxKind.IfLetStatement {
                return BindIfLetStatement(cast[IfLetStatementSyntax](syntax))
            }
            case SyntaxKind.GuardLetStatement {
                return BindGuardLetStatement(cast[GuardLetStatementSyntax](syntax))
            }
            case SyntaxKind.WhileLetStatement {
                return BindWhileLetStatement(cast[WhileLetStatementSyntax](syntax))
            }
            case SyntaxKind.ForInfiniteStatement {
                return BindForInfiniteStatement(cast[ForInfiniteStatementSyntax](syntax))
            }
            case SyntaxKind.ForEllipsisStatement {
                return BindForEllipsisStatement(cast[ForEllipsisStatementSyntax](syntax))
            }
            case SyntaxKind.ForConditionStatement {
                return BindForConditionStatement(cast[ForConditionStatementSyntax](syntax))
            }
            case SyntaxKind.ForClauseStatement {
                return BindForClauseStatement(cast[ForClauseStatementSyntax](syntax))
            }
            case SyntaxKind.ForRangeStatement {
                return BindForRangeStatement(cast[ForRangeStatementSyntax](syntax))
            }
            case SyntaxKind.ForTupleRangeStatement {
                return BindForTupleRangeStatement(cast[ForTupleRangeStatementSyntax](syntax))
            }
            case SyntaxKind.WhileStatement {
                return BindWhileStatement(cast[WhileStatementSyntax](syntax))
            }
            case SyntaxKind.LockStatement {
                return BindLockStatement(cast[LockStatementSyntax](syntax))
            }
            case SyntaxKind.DoWhileStatement {
                return BindDoWhileStatement(cast[DoWhileStatementSyntax](syntax))
            }
            case SyntaxKind.LabeledStatement {
                return BindLabeledStatement(cast[LabeledStatementSyntax](syntax))
            }
            case SyntaxKind.GotoStatement {
                return BindGotoStatement(cast[GotoStatementSyntax](syntax))
            }
            case SyntaxKind.BreakStatement {
                return BindBreakStatement(cast[BreakStatementSyntax](syntax))
            }
            case SyntaxKind.ContinueStatement {
                return BindContinueStatement(cast[ContinueStatementSyntax](syntax))
            }
            case SyntaxKind.FallthroughStatement {
                return BindFallthroughStatement(cast[FallthroughStatementSyntax](syntax))
            }
            case SyntaxKind.ReturnStatement {
                return BindReturnStatement(cast[ReturnStatementSyntax](syntax))
            }
            case SyntaxKind.ExpressionStatement {
                return BindExpressionStatement(cast[ExpressionStatementSyntax](syntax))
            }
            case SyntaxKind.MultiAssignmentStatement {
                return BindMultiAssignmentStatement(cast[MultiAssignmentStatementSyntax](syntax))
            }
            case SyntaxKind.SwitchStatement {
                return BindSwitchStatement(cast[SwitchStatementSyntax](syntax))
            }
            case SyntaxKind.TryStatement {
                return BindTryStatement(cast[TryStatementSyntax](syntax))
            }
            case SyntaxKind.ThrowStatement {
                return BindThrowStatement(cast[ThrowStatementSyntax](syntax))
            }
            case SyntaxKind.RethrowStatement {
                return BindRethrowStatement(cast[RethrowStatementSyntax](syntax))
            }
            case SyntaxKind.UsingStatement {
                return BindUsingStatement(cast[UsingStatementSyntax](syntax))
            }
            case SyntaxKind.DeferStatement {
                return BindDeferStatement(cast[DeferStatementSyntax](syntax))
            }
            case SyntaxKind.GoStatement {
                return BindGoStatement(cast[GoStatementSyntax](syntax))
            }
            case SyntaxKind.ChannelSendStatement {
                return BindChannelSendStatement(cast[ChannelSendStatementSyntax](syntax))
            }
            case SyntaxKind.SelectStatement {
                return BindSelectStatement(cast[SelectStatementSyntax](syntax))
            }
            case SyntaxKind.ScopeStatement {
                return BindScopeStatement(cast[ScopeStatementSyntax](syntax))
            }
            case SyntaxKind.FixedStatement {
                return BindFixedStatement(cast[FixedStatementSyntax](syntax))
            }
            case SyntaxKind.AwaitForRangeStatement {
                return BindAwaitForRangeStatement(cast[AwaitForRangeStatementSyntax](syntax))
            }
            case SyntaxKind.AwaitUsingStatement {
                return BindAwaitUsingStatement(cast[AwaitUsingStatementSyntax](syntax))
            }
            case SyntaxKind.YieldStatement {
                return BindYieldStatement(cast[YieldStatementSyntax](syntax))
            }
            case SyntaxKind.TupleDeconstructionStatement {
                return BindTupleDeconstructionStatement(cast[TupleDeconstructionStatementSyntax](syntax))
            }
            case SyntaxKind.NamedDeconstructionStatement {
                return BindNamedDeconstructionStatement(cast[NamedDeconstructionStatementSyntax](syntax))
            }
            default {
                throw Exception("Unexpected syntax ${syntax.Kind}")
            }
        }
    }

    internal func BindBlockStatement(syntax BlockStatementSyntax) BoundStatement {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let reachableOnEntry = currentStatementListFallsThrough
        $scope = BoundScope($scope)
        // ADR-0175 (#3820/#3824): a block statement accepts only the
        // compiler-intrinsic scope annotations — `@SuppressDiagnostic`, and
        // (ADR-0186 §9) `@Oblivious` / `@NullabilityEnabled` — each scoped to
        // this block's `{`..`}`. They are consumed straight from the syntax
        // tree and never bound; anything else in annotation position before a
        // block is the ADR-0047 §2 "not allowed on statement" error.
        for annotation in syntax.Annotations {
            if DiagnosticSuppressionMap.IsSuppressDiagnostic(annotation) {
                DeclarationBinder.ValidateSuppressDiagnostic(annotation, Diagnostics)
            } else if ObliviousScope.IsScopeAnnotation(annotation) {
                // ADR-0186 §9: `@Oblivious { … }` / `@NullabilityEnabled { … }`
                // scope every type written inside the block, the analogue of
                // a C# `#nullable disable` / `#nullable enable` region inside a
                // method body. Read by ObliviousScope from the block's span.
                ObliviousScope.Validate(annotation, syntax.Annotations, Diagnostics)
            } else {
                Diagnostics.ReportAnnotationsNotAllowedOnStatement(annotation.AtToken.Location)
            }
        }
        // ADR-0122 / issue #1014: an `unsafe { … }` block enters an unsafe
        // context for the duration of its statements. The body of an
        // `unsafe func` (or any method of an `unsafe` type) is likewise an
        // unsafe context — its top-level block carries no `unsafe` keyword, so
        // consult the current function's unsafe flag as well.
        let entersUnsafe = syntax.IsUnsafe || (function?.IsUnsafe ?? false)
        // Issue #1881: a `checked { … }` / `unchecked { … }` block establishes
        // the named overflow context for its statements; an ordinary block
        // leaves the enclosing context untouched (unlike `unsafe`, there is no
        // ambient default to fall back to).
        using let checkedScope = if syntax.IsChecked || syntax.IsUnchecked {
            binderCtx.PushCheckedContext(syntax.IsChecked)
        } else {
            default(BinderContext.CheckedContextScope)
        }
        {
            using let _ = binderCtx.PushUnsafeContext(entersUnsafe)
            let shadowEntry = ShadowBegin()
            let fallsThrough = BindBlockStatements(syntax.Statements, 0, statements)
            let block = BoundBlockStatement(syntax, statements.ToImmutable())
            ShadowRecordBlock(block, shadowEntry)
            if !reachableOnEntry && fallsThrough {
                internallyReachableFallthroughStatements.Add(block)
            }
            $scope = $scope.Pop()
            return block
        }
    }

    internal func BindStatementList(
        statementSyntaxes ImmutableArray[StatementSyntax],
        beforeBind((StatementSyntax) -> void)? = nil,
        trailingStatement(() -> BoundStatement)? = nil
    ) ImmutableArray[BoundStatement] {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let _ = BindBlockStatements(statementSyntaxes, 0, statements, beforeBind, trailingStatement)
        return statements.ToImmutable()
    }

    /// Shared prepare-then-bind grouping for a consecutive run of local-
    /// function-literal declarations that all match [`isMember`](paramref)
    /// (either (cref:IsGenericLocalFunctionDeclaration) or
    /// (cref:IsNonGenericLocalFunctionLiteralDeclaration)): every
    /// member's signature is registered (via `prepareGenericLocalFunctionDeclaration`,
    /// which is generic-list-agnostic) before any member's body binds, so the
    /// whole run can forward-reference and mutually recurse; then each body
    /// binds in source order and, for a plural run, capture sets converge to
    /// a fixed point (issue #4221's `ReconcileGenericLocalFunctionGroupCaptures`).
    /// @param statementSyntaxes The enclosing statement list.
    /// @param start The index of the run's first member.
    /// @param statements The bound-statement builder to append to.
    /// @param beforeBind Optional per-statement hook, invoked for each member.
    /// @param isMember Which of the two local-function-literal shapes this run is made of.
    /// @returns The index of the run's last member (the caller sets its loop variable to this and
    /// continues).
    private func BindLocalFunctionLiteralGroup(
        statementSyntaxes ImmutableArray[StatementSyntax],
        start int32,
        statements ImmutableArray[BoundStatement].Builder,
        beforeBind((StatementSyntax) -> void)?,
        isMember(StatementSyntax) -> bool
    ) int32 {
        let statementSyntax = statementSyntaxes[start]
        // Only consecutive declarations of the same shape share forward
        // visibility. Ordinary variables and statements remain sequential;
        // file boundaries also end a region, preserving per-file import
        // resolution.
        let bodies = List[() -> BoundStatement]()
        var end = start
        while end < statementSyntaxes.Length &&
            statementSyntaxes[end].SyntaxTree == statementSyntax.SyntaxTree &&
            isMember(statementSyntaxes[end]) {
            beforeBind?(statementSyntaxes[end])
            bodies.Add(
                prepareGenericLocalFunctionDeclaration!!(cast[VariableDeclarationSyntax](statementSyntaxes[end]))
            )
            end++
        }
        let groupLiterals List[BoundFunctionLiteralExpression]? = if reconcileGenericLocalFunctionGroupCaptures != nil {
            List[BoundFunctionLiteralExpression](bodies.Count)
        } else {
            default(List[BoundFunctionLiteralExpression]?)
        }
        for var member = 0; member < bodies.Count; member++ {
            beforeBind?(statementSyntaxes[start + member])
            let bindBody = bodies[member]
            let bound = bindBody()
            statements.Add(bound)
            if bound is BoundLocalFunctionDeclaration{Literal: {} literal} {
                literal.Function.HasCaptures = literal.CapturedVariables.Length > 0
                groupLiterals?.Add(literal)
            }
        }
        // Issue #4221: a local function calling a sibling that captures
        // outer state needs that capture folded into its own environment
        // even when the sibling is declared later in the group (forward
        // reference) or the two call each other. The in-order bind above
        // already handles a callee declared earlier; this converges the
        // rest. Applies equally to a non-generic group — the reconciler
        // itself does not distinguish generic from non-generic literals.
        if groupLiterals != nil && groupLiterals.Count > 1 {
            reconcileGenericLocalFunctionGroupCaptures!!(groupLiterals)
            // The reconcile pass above can widen a member's CapturedVariables
            // after the initial per-member stamp above; re-stamp so a later
            // bare-name reference (see FunctionSymbol.HasCaptures) sees the
            // final, post-widening answer.
            for literal in groupLiterals {
                literal.Function.HasCaptures = literal.CapturedVariables.Length > 0
            }
        }
        return end - 1
    }

    private func BindBlockStatements(
        statementSyntaxes ImmutableArray[StatementSyntax],
        startIndex int32,
        statements ImmutableArray[BoundStatement].Builder,
        beforeBind((StatementSyntax) -> void)? = nil,
        trailingStatement(() -> BoundStatement)? = nil
    ) bool {
        // Issue #208: push a persistent narrowing frame for this statement list.
        // After each call statement whose method carries [MemberNotNull], the
        // named fields are added to this frame and remain narrowed for all
        // subsequent statements in the block (until assignment invalidates them).
        let memberNotNullFrame = Dictionary[AccessPath, TypeSymbol]()
        let inheritedAssignmentGenerations = Dictionary[VariableSymbol, int32](binderCtx.AssignmentNarrowingGenerations)
        let inheritedFallthrough = currentStatementListFallsThrough
        let inheritedPotentialReachabilityLabel = binderCtx.PotentialReachabilityLabel
        binderCtx.BeginNarrowingProof(memberNotNullFrame)
        binderCtx.NarrowedVariables.Add(memberNotNullFrame)
        let shadowSavedOverlay = ShadowEnterList()
        let shadowSavedBase = binderCtx.ShadowOverlayBase
        try {
            for var i = startIndex; i < statementSyntaxes.Length; i++ {
                let statementSyntax = statementSyntaxes[i]
                beforeBind?(statementSyntax)
                if IsGenericLocalFunctionDeclaration(statementSyntax) && prepareGenericLocalFunctionDeclaration != nil {
                    i = BindLocalFunctionLiteralGroup(
                        statementSyntaxes,
                        i,
                        statements,
                        beforeBind,
                        IsGenericLocalFunctionDeclaration
                    )
                    continue
                }
                // Issue #4219 (umbrella remainder), workstream B: a `ref`-
                // returning function literal always routes through the
                // direct-call path, standing alone or not — see
                // IsRefReturningLocalFunctionDeclaration.
                if IsRefReturningLocalFunctionDeclaration(statementSyntax) &&
                    prepareGenericLocalFunctionDeclaration != nil {
                    i = BindLocalFunctionLiteralGroup(
                        statementSyntaxes,
                        i,
                        statements,
                        beforeBind,
                        IsRefReturningLocalFunctionDeclaration
                    )
                    continue
                }
                // Issue #4219 (umbrella remainder): a run of TWO OR MORE
                // consecutive non-generic local-function-literal `let`
                // declarations gets the same forward-visibility/mutual-
                // recursion treatment as a generic group — see
                // IsNonGenericLocalFunctionLiteralDeclaration for why a lone
                // member does not qualify. A run mixing generic and
                // non-generic members never reaches here (the branch above
                // already claimed the generic member and stopped at the
                // first non-generic one), so a generic member calling a
                // non-generic sibling declared AFTER it remains GS0130 —
                // that broader-parity combination is deliberately out of
                // scope here (see #4219's "mixed groups" note).
                //
                // Issue #4219 (umbrella remainder) correctness fix: also require an
                // actual cross-reference between
                // members of the run (see
                // NonGenericLocalFunctionLiteralGroupHasCrossReference) —
                // mere adjacency of two unrelated non-generic locals must
                // not opt them into the direct-call representation; see that
                // method's doc comment for the regression this prevents.
                if IsNonGenericLocalFunctionLiteralDeclaration(statementSyntax) &&
                    prepareGenericLocalFunctionDeclaration != nil &&
                    i +
                    1 < statementSyntaxes.Length &&
                    statementSyntaxes[i + 1].SyntaxTree == statementSyntax.SyntaxTree &&
                    IsNonGenericLocalFunctionLiteralDeclaration(statementSyntaxes[i + 1]) {
                    var runEnd = i
                    while runEnd < statementSyntaxes.Length &&
                        statementSyntaxes[runEnd].SyntaxTree == statementSyntax.SyntaxTree &&
                        IsNonGenericLocalFunctionLiteralDeclaration(statementSyntaxes[runEnd]) {
                        runEnd++
                    }
                    if NonGenericLocalFunctionLiteralGroupHasCrossReference(statementSyntaxes, i, runEnd) {
                        i = BindLocalFunctionLiteralGroup(
                            statementSyntaxes,
                            i,
                            statements,
                            beforeBind,
                            IsNonGenericLocalFunctionLiteralDeclaration
                        )
                        continue
                    }
                }
                if statementSyntax is DeferStatementSyntax deferSyntax {
                    let defer_ = BindDeferStatementInBlock(deferSyntax)
                    statements.AddRange(defer_.PrefixStatements)
                    if defer_.Cleanup == nil {
                        statements.Add(
                            Invariant.Required(
                                defer_.ErrorStatement,
                                "an invalid defer lowering has an error statement",
                                expression: "defer.ErrorStatement"
                            )
                        )
                        InvalidateNarrowingsForAssignedVariables(statementSyntax)
                        continue
                    }
                    InvalidateNarrowingsForAssignedVariables(statementSyntax)
                    let innerStatements = ImmutableArray.CreateBuilder[BoundStatement]()
                    let cleanupEffect = BoundExpressionStatement(nil, defer_.Cleanup!!)
                    let fallsThrough = BindWithinSynthesizedCleanup(
                        cleanupEffect,
                        () -> BindBlockStatements(
                            statementSyntaxes,
                            i + 1,
                            innerStatements,
                            beforeBind,
                            trailingStatement
                        )
                    )
                    statements.Add(
                        BuildCleanupTryStatement(innerStatements.ToImmutable(), defer_.Cleanup!!, shieldCleanup: true)
                    )
                    return fallsThrough
                }
                if statementSyntax is UsingStatementSyntax usingSyntax {
                    let usingLowering = BindUsingStatementInBlock(usingSyntax)
                    if usingLowering.InitializedDeclaration != nil {
                        statements.Add(usingLowering.InitializedDeclaration!!)
                    }
                    // Issue #3784: read the guard off the declaration before the
                    // null test below narrows it away.
                    let usingResource = if usingLowering.Declaration is {} usingDeclaration {
                        NilGuardedResource(usingDeclaration.Variable)
                    } else {
                        default(VariableSymbol?)
                    }
                    if usingLowering.Declaration != nil {
                        statements.Add(usingLowering.Declaration)
                    }
                    if usingLowering.Cleanup == nil {
                        statements.Add(
                            Invariant.Required(
                                usingLowering.ErrorStatement,
                                "an invalid using lowering has an error statement",
                                expression: "usingLowering.ErrorStatement"
                            )
                        )
                        InvalidateNarrowingsForAssignedVariables(statementSyntax, usingLowering.Declaration)
                        continue
                    }
                    statements.Add(
                        BuildInitializedAssignment(
                            Invariant.Required(
                                usingLowering.Initialized,
                                "a valid using lowering has an initialized variable",
                                expression: "usingLowering.Initialized"
                            )
                        )
                    )
                    InvalidateNarrowingsForAssignedVariables(statementSyntax, usingLowering.Declaration)
                    let innerStatements = ImmutableArray.CreateBuilder[BoundStatement]()
                    let cleanupEffect = BoundExpressionStatement(nil, usingLowering.Cleanup!!)
                    let fallsThrough = BindWithinSynthesizedCleanup(
                        cleanupEffect,
                        () -> BindBlockStatements(
                            statementSyntaxes,
                            i + 1,
                            innerStatements,
                            beforeBind,
                            trailingStatement
                        )
                    )
                    statements.Add(
                        BuildCleanupTryStatement(
                            innerStatements.ToImmutable(),
                            usingLowering.Cleanup!!,
                            usingLowering.Initialized,
                            usingResource
                        )
                    )
                    return fallsThrough
                }
                if statementSyntax is AwaitUsingStatementSyntax awaitUsingSyntax {
                    let awaitUsingLowering = BindAwaitUsingStatementInBlock(awaitUsingSyntax)
                    if awaitUsingLowering.InitializedDeclaration != nil {
                        statements.Add(awaitUsingLowering.InitializedDeclaration!!)
                    }
                    // Issue #3784: as above, captured before the null test.
                    let awaitUsingResource = if awaitUsingLowering.Declaration is {} awaitUsingDeclaration {
                        NilGuardedResource(awaitUsingDeclaration.Variable)
                    } else {
                        default(VariableSymbol?)
                    }
                    if awaitUsingLowering.Declaration != nil {
                        statements.Add(awaitUsingLowering.Declaration!!)
                    }
                    if awaitUsingLowering.Cleanup == nil {
                        statements.Add(
                            Invariant.Required(
                                awaitUsingLowering.ErrorStatement,
                                "an invalid await using lowering has an error statement",
                                expression: "awaitUsingLowering.ErrorStatement"
                            )
                        )
                        InvalidateNarrowingsForAssignedVariables(statementSyntax, awaitUsingLowering.Declaration)
                        continue
                    }
                    statements.Add(
                        BuildInitializedAssignment(
                            Invariant.Required(
                                awaitUsingLowering.Initialized,
                                "a valid await using lowering has an initialized variable",
                                expression: "awaitUsingLowering.Initialized"
                            )
                        )
                    )
                    InvalidateNarrowingsForAssignedVariables(statementSyntax, awaitUsingLowering.Declaration)
                    let innerStatements = ImmutableArray.CreateBuilder[BoundStatement]()
                    let cleanupEffect = BoundExpressionStatement(nil, awaitUsingLowering.Cleanup!!)
                    let fallsThrough = BindWithinSynthesizedCleanup(
                        cleanupEffect,
                        () -> BindBlockStatements(
                            statementSyntaxes,
                            i + 1,
                            innerStatements,
                            beforeBind,
                            trailingStatement
                        )
                    )
                    statements.Add(
                        BuildCleanupTryStatement(
                            innerStatements.ToImmutable(),
                            awaitUsingLowering.Cleanup!!,
                            awaitUsingLowering.Initialized,
                            awaitUsingResource
                        )
                    )
                    return fallsThrough
                }
                // ADR-0071 / issue #708: `guard let` extends the enclosing block's
                // scope with the new bindings. Inline the per-binding decl + nil-
                // check pairs directly into the enclosing statement list so that
                // (a) the synthesized variables live for the rest of the block and
                // (b) `ApplyEarlyExitNarrowings` lifts each binding's non-nil
                // narrowing into the persistent block frame for subsequent reads.
                if statementSyntax is GuardLetStatementSyntax guardLetSyntax {
                    BindGuardLetStatementInBlock(guardLetSyntax, statements, memberNotNullFrame)
                    InvalidateNarrowingsForAssignedVariables(statementSyntax)
                    continue
                }
                let externalCallableAliasesAtEntry = externalCallableAliases.ToArray()
                let statement BoundStatement? = BindStatement(statementSyntax)
                if statement == nil {
                    continue
                }
                statements.Add(statement)
                // Issue #208: after binding a call statement, apply any
                // [MemberNotNull] post-condition narrowings to the persistent frame.
                ApplyMemberNotNullNarrowings(statement, memberNotNullFrame)
                // ADR-0069 / issue #700: lift the else-frame of an
                // `if x !is T { return }` (or any if whose then-branch
                // ends in an unconditional exit) into the enclosing
                // block's persistent frame, so subsequent reads in this
                // block see the narrowing.
                ApplyEarlyExitNarrowings(statement, memberNotNullFrame)
                // ADR-0166: the same lift for pattern variables — after
                // `if !(x is T t) { return }`, `t` is declared for the rest of
                // this block.
                ApplyEarlyExitPatternVariables(statement)
                // Phase 3.C.4: mutation invalidates the narrowing. After binding
                // a statement that writes to a narrowed variable, drop its
                // narrowing from the current frame so subsequent reads in this
                // block see the variable at its declared (nullable) type again.
                InvalidateNarrowingsForAssignedVariables(statementSyntax, statement)
                RestoreEarlyExitLiftsWrittenOnlyByCondition(statement, memberNotNullFrame)
                // Issue #1123: assignment-based smart cast. After invalidation
                // (which clears any stale narrowing on the assigned variable),
                // re-narrow a nullable `var` local that was just assigned a
                // statically non-nullable value, so subsequent reads in this
                // block — and nested blocks — see the non-nullable type until a
                // later mutation invalidates it again. Runs last so it wins over
                // the invalidation pass for the same statement.
                ApplyAssignmentNarrowing(statement, memberNotNullFrame)
                UpdateExternalCallableAliases(statement, externalCallableAliasesAtEntry)
                // Issue #2159: `if`-join narrowing. After invalidation (which
                // drops any narrowing the `if` mutates), lift a nullable `var`
                // local that both the then- and else-branch leave non-null into
                // the persistent frame, so subsequent reads see the non-nullable
                // type. Runs after invalidation for the same reason as the
                // assignment narrowing above.
                ApplyIfJoinNarrowings(statement, memberNotNullFrame)
                ApplyTryFinallyFallthroughNarrowings(statement, memberNotNullFrame)
                ShadowAfterStatement(statement)
                let hasInternallyReachableFallthrough = HasInternallyReachableFallthrough(statement)
                let canCompleteNormally = CanCompleteNormally(statement)
                currentStatementListFallsThrough = (
                    currentStatementListFallsThrough || hasInternallyReachableFallthrough
                ) &&
                    canCompleteNormally
                if !canCompleteNormally && !hasInternallyReachableFallthrough {
                    this.binderCtx.PotentialReachabilityLabel = nil
                }
            }
            if trailingStatement != nil {
                statements.Add(trailingStatement())
            }
            return currentStatementListFallsThrough
        } finally {
            ShadowLeaveList(shadowSavedOverlay, shadowSavedBase)
            binderCtx.EndNarrowingProof()
            binderCtx.AssignmentNarrowingGenerations.Clear()
            for entry in inheritedAssignmentGenerations {
                binderCtx.AssignmentNarrowingGenerations.Add(entry.Key, entry.Value)
            }
            currentStatementListFallsThrough = inheritedFallthrough
            this.binderCtx.PotentialReachabilityLabel = inheritedPotentialReachabilityLabel
        }
    }

    /// ADR-0174 D7: runs a `defer` body under a shielded context, so
    /// cleanup that needs a channel still completes while the scope around it
    /// is being cancelled, and cannot hold cancellation up forever — the shield
    /// carries the host's grace budget. The shield is an ordinary
    /// `Context` local declared before the body, which is exactly what the
    /// suspension pass reads as the ambient context for the calls inside.
    /// @param cleanupStatement The deferred body.
    /// @returns The body wrapped in its shield.
    private func ShieldCleanup(cleanupStatement BoundStatement) BoundStatement {
        let runtime = binderCtx.ChannelRuntime
        let id = Interlocked.Increment(&binderCtx.SyntheticLocalCounter)
        let shield = LocalVariableSymbol("<defer$$shield$$$id>", isReadOnly: true, runtime.ContextType)
        $scope.TryDeclareVariable(shield)
        return BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(nil, shield, runtime.BindShieldedContext(binderCtx.AmbientContext())),
                BoundTryStatement(
                    nil,
                    BoundBlockStatement(nil, ImmutableArray.Create(cleanupStatement)),
                    ImmutableArray[BoundCatchClause].Empty,
                    BoundBlockStatement(
                        nil,
                        ImmutableArray.Create[BoundStatement](
                            BoundExpressionStatement(nil, runtime.BindContextDispose(shield))
                        )
                    )
                )
            )
        )
    }

    private func BindWithinSynthesizedCleanup[T](cleanup BoundStatement, bind() -> T) T {
        activeCleanupStatements.Push(cleanup)
        activeCleanupRegions.Push(GotoCleanupRegion(nil, cleanup))
        try {
            return bind()
        } finally {
            activeCleanupRegions.Pop()
            activeCleanupStatements.Pop()
        }
    }

    private func BuildCleanupTryStatement(
        protectedStatements ImmutableArray[BoundStatement],
        cleanup BoundExpression,
        initialized VariableSymbol? = nil,
        nilGuardedResource VariableSymbol? = nil,
        shieldCleanup bool = false
    ) BoundTryStatement {
        let tryBlock = BoundBlockStatement(nil, protectedStatements)
        var cleanupStatement BoundStatement = BoundExpressionStatement(nil, cleanup)
        // Issue #3784: `if resource != nil { <cleanup> }`, mirroring how csc
        // lowers `using` over a reference-typed resource.
        if nilGuardedResource != nil && BoundBinaryOperator.Bind(
            SyntaxKind.BangEqualsToken,
            nilGuardedResource.Type,
            TypeSymbol.Null
        ) is {} nilInequality {
            cleanupStatement = BoundIfStatement(
                nil,
                BoundBinaryExpression(
                    nil,
                    BoundVariableExpression(nil, nilGuardedResource),
                    nilInequality,
                    BoundLiteralExpression(nil, nil, TypeSymbol.Null)
                ),
                cleanupStatement,
                elseStatement: nil
            )
        }
        if initialized != nil {
            cleanupStatement = BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](
                    BuildInitializedAssignment(initialized, value: false),
                    cleanupStatement
                )
            )
            cleanupStatement = BoundIfStatement(
                nil,
                BoundVariableExpression(nil, initialized),
                cleanupStatement,
                elseStatement: nil
            )
        }
        if shieldCleanup && binderCtx.ChannelRuntime.IsAvailable {
            cleanupStatement = ShieldCleanup(cleanupStatement)
        }
        let finallyBlock = BoundBlockStatement(nil, ImmutableArray.Create(cleanupStatement))
        return BoundTryStatement(nil, tryBlock, ImmutableArray[BoundCatchClause].Empty, finallyBlock)
    }

    shared {
        private func IsDiscard(token SyntaxToken) bool -> token.Text == "_"

        private func IsGenericLocalFunctionDeclaration(syntax StatementSyntax) bool -> (
            syntax is VariableDeclarationSyntax and
                {
                Keyword: {Kind: SyntaxKind.LetKeyword},
                TypeParameterList: not nil,
                Initializer: FunctionLiteralExpressionSyntax,
                HasRefKindModifier: false,
                IsAsyncLet: false
            }
        )

        /// Issue #4219 (umbrella remainder): the non-generic counterpart of
        /// (cref:IsGenericLocalFunctionDeclaration) — same shape, minus
        /// the type-parameter list. A generic local function is ALWAYS routed
        /// through the directly-callable-symbol path (a CLR delegate cannot
        /// close over an unbound generic method, so it has no other option);
        /// a non-generic one is not under any such constraint and, standing
        /// alone, keeps its existing "delegate-valued variable" representation
        /// (see `StatementBinder.Narrowing.cs`'s
        /// `bindFunctionLiteralWithSelfDeclaration` self-recursion path) to
        /// avoid silently changing every ordinary `let f = func ...` in the
        /// language. Only a run of TWO OR MORE consecutive non-generic members
        /// (see the minimum-run-length gate in (cref:BindBlockStatements))
        /// opts into forward visibility — that plural shape is unambiguously a
        /// deliberate group of named local functions, not an ordinary single
        /// closure-valued local. An explicit outer type clause
        /// (`let f (int32) -> int32 = func ...`) is also excluded: the
        /// direct-call path's signature comes entirely from the LITERAL (its own
        /// parameters/return type), so a declared outer type would be silently
        /// ignored instead of type-checked/converted against — the old path
        /// still validates it via `ConversionClassifier.BindConversion`.
        private func IsNonGenericLocalFunctionLiteralDeclaration(syntax StatementSyntax) bool -> (
            syntax is VariableDeclarationSyntax and
                {
                Keyword: {Kind: SyntaxKind.LetKeyword},
                TypeParameterList: nil,
                TypeClause: nil,
                Initializer: FunctionLiteralExpressionSyntax and {IsRefReturn: false},
                HasRefKindModifier: false,
                IsAsyncLet: false
            }
        )

        /// Issue #4219 (umbrella remainder), workstream B: a `ref`-returning
        /// function literal (`let f = func (...) ref T { ... }`) has no
        /// delegate-valued-variable representation available at all — a CLR
        /// delegate's `Invoke` cannot be made to return by ref without a
        /// dedicated synthesized delegate shape (out of scope here, see GS0588).
        /// It ALWAYS routes through the direct-call path, standing alone or not
        /// (unlike (cref:IsNonGenericLocalFunctionLiteralDeclaration)'s
        /// 2-or-more-member gate — one ref-returning literal has no other
        /// representation to fall back to), reusing named-function ref-return
        /// machinery (issue #4224) for calls, aliasing, and emission. It is kept
        /// in its OWN run — not merged with an adjacent ordinary non-generic
        /// group — mirroring the existing generic/non-generic mixed-group
        /// exclusion; a ref-returning literal and a non-ref sibling cannot
        /// forward-reference each other yet.
        private func IsRefReturningLocalFunctionDeclaration(syntax StatementSyntax) bool -> (
            syntax is VariableDeclarationSyntax and
                {
                Keyword: {Kind: SyntaxKind.LetKeyword},
                TypeParameterList: nil,
                TypeClause: nil,
                Initializer: FunctionLiteralExpressionSyntax and {IsRefReturn: true},
                HasRefKindModifier: false,
                IsAsyncLet: false
            }
        )

        /// Issue #4219 (umbrella remainder) correctness fix: a syntactic pre-check
        /// gating whether a consecutive run of (cref:IsNonGenericLocalFunctionLiteralDeclaration)
        /// members actually needs the forward-visible/direct-call group
        /// representation. Without this gate, mere source-adjacency of two
        /// non-generic `let name = func ...` locals opted them in
        /// regardless of whether either body ever names the other — so two
        /// unrelated, ordinary capturing callbacks declared back-to-back (a
        /// common shape: `let onClick = func() {...}; let onLog = func()
        /// {...}; Register(onClick)`) lost the ability to convert a
        /// capturing member's bare name to a delegate value, a previously-legal
        /// pattern with nothing to do with recursion. Only a run where at least
        /// one member's body actually references another member's name needs
        /// forward visibility; an unrelated run keeps each member's original
        /// delegate-valued-variable representation (self-recursion is
        /// unaffected either way — it already works via the existing
        /// single-declaration self-reference path, so a member naming only
        /// itself does not count as a cross-reference here).
        private func NonGenericLocalFunctionLiteralGroupHasCrossReference(
            statementSyntaxes ImmutableArray[StatementSyntax],
            start int32,
            end int32
        ) bool {
            let siblingNames = HashSet[string]()
            for var idx = start; idx < end; idx++ {
                siblingNames.Add((cast[VariableDeclarationSyntax](statementSyntaxes[idx])).Identifier.Text)
            }
            for var idx = start; idx < end; idx++ {
                let decl = cast[VariableDeclarationSyntax](statementSyntaxes[idx])
                let selfName = decl.Identifier.Text
                // `[start, end)` is only ever the `[i, runEnd)` range built by
                // BindBlockStatements's `runEnd` loop, which advances only while
                // `IsNonGenericLocalFunctionLiteralDeclaration` holds for the
                // member at that index -- and that predicate pattern-matches
                // `Initializer: FunctionLiteralExpressionSyntax { IsRefReturn:
                // false }`. So every declaration in this range already has a
                // non-null `FunctionLiteralExpressionSyntax` initializer by
                // construction; the `!` merely restates what the caller verified.
                let literal = cast[FunctionLiteralExpressionSyntax](decl.Initializer!!)
                for node in literal.Body.DescendantNodesAndSelf() {
                    // A direct call (`second(x)`) is its own syntax node with an
                    // `Identifier` token — it is NOT a NameExpressionSyntax
                    // wrapping a call, so both shapes must be checked to catch
                    // the common "sibling(...)" recursive-call reference.
                    let referencedName string? = switch node {
                        case name is NameExpressionSyntax: name.IdentifierToken.Text
                        case call is CallExpressionSyntax: call.Identifier.Text
                        default: default(string?)
                    }
                    if referencedName != nil && referencedName != selfName && siblingNames.Contains(referencedName) {
                        return true
                    }
                }
            }
            return false
        }

        private func IsSyntacticallyInfiniteLoop(statement BoundForInfiniteStatement) bool {
            return (
                statement.Syntax is ForInfiniteStatementSyntax or
                    LabeledStatementSyntax and
                    {Statement: ForInfiniteStatementSyntax}
            )
        }

        private func BuildInitializedAssignment(
            initialized VariableSymbol,
            value bool = true
        ) BoundExpressionStatement -> BoundExpressionStatement(
            nil,
            BoundAssignmentExpression(nil, initialized, BoundLiteralExpression(nil, value))
        )

        /// Issue #3784: a `using` resource whose declared type is nilable can
        /// legitimately hold `nil` (`using let s = if cond { nil } else {
        /// File.Create(p) }`), exactly as C#'s
        /// `using (var s = cond ? null : File.Create(p))` can. The cleanup
        /// must therefore be nil-guarded; without the guard the finally block
        /// issues an unconditional `Dispose()` on a nil receiver and the
        /// statement throws a (cref:NullReferenceException) on the very path
        /// C# defines as a no-op. Returns the variable to guard on, or
        /// `null` when the resource cannot be nil.
        /// @param variable The bound resource variable.
        /// @returns The variable to nil-guard the cleanup on, or `null`.
        private func NilGuardedResource(variable VariableSymbol) VariableSymbol? {
            // The guard belongs to resources whose CLR representation is a managed
            // REFERENCE — those are the ones an initializer can leave holding null,
            // whatever static nullability the binder inferred for the declaration
            // (`default(T?)`, a conditional with a nil arm, an interop call). A
            // value-typed resource — including a `Nullable<T>` local — is never a
            // nil reference, so its cleanup stays exactly as unconditional as it
            // was. When the resource's type does not support `!= nil` at all,
            // BuildCleanupTryStatement drops the guard again.
            let clrType = NullableTypeSymbol.GetEffectiveClrType(variable.Type)
            return if clrType != nil && clrType.IsValueType == true {
                default(VariableSymbol?)
            } else {
                variable
            }
        }
    }
}

/// Signature for the root (cref:ExpressionBinder.BindExpression(ExpressionSyntax, bool)) entry point.
/// @param syntax The expression syntax to bind.
/// @param canBeVoid Whether the expression is permitted to have `void` type.
/// @returns The bound expression.
internal delegate StatementBinder_BindExpressionDelegate(
    syntax ExpressionSyntax,
    canBeVoid bool = false
) BoundExpression;

/// Signature for the root binder's `BindExpression(syntax, targetType)` overload.
/// @param syntax The expression syntax to bind.
/// @param targetType The target type used to drive conversion.
/// @returns The bound expression, possibly converted to the target type.
internal delegate StatementBinder_BindExpressionWithTargetTypeDelegate(
    syntax ExpressionSyntax,
    targetType TypeSymbol
) BoundExpression;

/// Signature for `BindVariableDeclaration(SyntaxToken, bool, TypeSymbol)` on (cref:Binder).
/// @param identifier The identifier token introducing the variable.
/// @param isReadOnly Whether the variable is read-only (`let`).
/// @param type The declared/inferred type of the variable.
/// @returns The resulting variable symbol.
internal delegate StatementBinder_BindLocalVariableDelegate(
    identifier SyntaxToken,
    isReadOnly bool,
    type TypeSymbol
) VariableSymbol;

/// Signature for `BindVariableDeclaration(SyntaxToken, bool, TypeSymbol, Accessibility)`.
/// @param identifier The identifier token introducing the variable.
/// @param isReadOnly Whether the variable is read-only (`let`).
/// @param type The declared/inferred type of the variable.
/// @param accessibility The declared accessibility of the variable.
/// @returns The resulting variable symbol.
internal delegate StatementBinder_BindLocalVariableWithAccessibilityDelegate(
    identifier SyntaxToken,
    isReadOnly bool,
    type TypeSymbol,
    accessibility Accessibility
) VariableSymbol;

/// Signature for the simplified attribute-binding callback used only by local variable declarations.
/// @param annotations The annotations attached to the declaration.
/// @param positionDescription Human-readable position description used for diagnostics.
/// @returns The bound attributes.
internal delegate StatementBinder_BindVariableDeclarationAttributesDelegate(
    annotations ImmutableArray[AnnotationSyntax],
    positionDescription string
) ImmutableArray[BoundAttribute];
