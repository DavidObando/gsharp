// <copyright file="StatementBinder.Blocks.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
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

internal partial class StatementBinder {
    private func BindSwitchStatement(syntax SwitchStatementSyntax) BoundStatement {
        let discriminant = bindExpression(syntax.Expression, false)
        if NativeProtocolOperations.GetProtocol(discriminant.Type) != nil {
            Diagnostics.ReportNativeProtocol(
                syntax.Location,
                "native protocol switch patterns require an explicit is/as intermediate view"
            )
            return BindErrorStatement()
        }
        ApplyHeaderCallableEffects(discriminant)
        let switchType = discriminant.Type
        if switchType == TypeSymbol.Error {
            return BindErrorStatement()
        }
        let arms = ImmutableArray.CreateBuilder[BoundPatternSwitchArm](syntax.Cases.Length)
        var hasDefault = false
        let callableEntry = CaptureExternalCallableAliases()
        let shadowFlow = ShadowBegin(discriminant)
        var shadowApproximate = false
        var callableExits HashSet[VariableSymbol]? = nil
        var callableFallthrough HashSet[VariableSymbol]? = nil
        // ADR-0069 addendum / issue #712: track each non-exiting arm's
        // discriminator narrowing so we can lift a common post-switch
        // narrowing into the enclosing block when every fall-through arm
        // contributes the same `{discriminator → T}` mapping. Arms that
        // end in an unconditional exit (return/throw/break/continue) do
        // not contribute to the merge — they remove themselves from the
        // post-switch dataflow.
        var hasAnyFallThroughArm = false
        var mergedExitFrame Dictionary[AccessPath, TypeSymbol]? = nil
        var mergeFailed = false
        // Issue #3501 A3: (a) an unlabeled `break` inside an arm exits the
        // switch — push a LoopStack frame whose ContinueLabel is null so
        // `continue` still binds to the enclosing loop; (b) an arm whose
        // body ENDS in `fallthrough` jumps to the NEXT arm's body-entry
        // label, skipping that arm's pattern test and guard (Go semantics).
        binderCtx.LabelCounter++
        let switchOrdinal = binderCtx.LabelCounter
        let switchBreakLabel = BoundLabel("switchBreak$switchOrdinal")
        let armEntryLabels = [syntax.Cases.Length]BoundLabel?
        let savedFallthroughTarget = binderCtx.CurrentFallthroughTarget
        let savedFallthroughAnchor = binderCtx.CurrentFallthroughAnchor
        binderCtx.LoopStack.Push((nil, switchBreakLabel, nil))
        try {
            for var caseIndex = 0; caseIndex < syntax.Cases.Length; caseIndex++ {
                ShadowBeginBranch(shadowFlow)
                let caseSyntax = syntax.Cases[caseIndex]
                let callableArmEntry = HashSet[VariableSymbol](callableEntry)
                if callableFallthrough != nil {
                    callableArmEntry.IntersectWith(callableFallthrough)
                }
                RestoreExternalCallableAliases(callableArmEntry)
                // Issue #3501 A3: arm the fallthrough context for this arm. The
                // one legal position is the body's last statement; a trailing
                // fallthrough in a non-final arm targets the next arm's entry
                // label (created on demand, prepended when that arm binds).
                let trailingStatement = if caseSyntax.Body.Statements.Length > 0 {
                    caseSyntax.Body.Statements[caseSyntax.Body.Statements.Length - 1]
                } else {
                    default(StatementSyntax?)
                }
                let endsInFallthrough = trailingStatement is FallthroughStatementSyntax
                this.binderCtx.CurrentFallthroughAnchor = if endsInFallthrough {
                    trailingStatement
                } else {
                    default(StatementSyntax?)
                }
                this.binderCtx.CurrentFallthroughTarget = nil
                if endsInFallthrough && caseIndex < syntax.Cases.Length - 1 {
                    var nextArmEntry BoundLabel? = armEntryLabels[caseIndex + 1]
                    if nextArmEntry == nil {
                        nextArmEntry = BoundLabel("switchArm${switchOrdinal}_${caseIndex + 1}")
                        armEntryLabels[caseIndex + 1] = nextArmEntry
                    }
                    this.binderCtx.CurrentFallthroughTarget = nextArmEntry
                }
                if caseSyntax.IsDefault {
                    if hasDefault {
                        Diagnostics.ReportDuplicateSwitchDefault(caseSyntax.Keyword.Location)
                    }
                    hasDefault = true
                    var defaultBody = BindBlockStatement(caseSyntax.Body)
                    ShadowAddBranch(shadowFlow, nil, defaultBody, true)
                    shadowApproximate = shadowApproximate || endsInFallthrough
                    defaultBody = PrependArmEntryLabel(defaultBody, armEntryLabels[caseIndex])
                    arms.Add(BoundPatternSwitchArm(nil, pattern: nil, $guard: nil, defaultBody))
                    let callableDefaultExit = CaptureExternalCallableAliases()
                    callableFallthrough = if endsInFallthrough {
                        callableDefaultExit
                    } else {
                        default(HashSet[VariableSymbol]?)
                    }
                    if !EndsInUnconditionalExit(defaultBody, gotoExits: false) {
                        callableExits = JoinExternalCallableAliases(callableExits, callableDefaultExit)
                    }
                    if !EndsInUnconditionalExit(defaultBody) {
                        // A default arm that falls through carries no narrowing
                        // on the discriminator (we can't observe any specific
                        // type), so it defeats the merge unconditionally.
                        hasAnyFallThroughArm = true
                        mergeFailed = true
                    }
                    continue
                }
                $scope = BoundScope($scope)
                let caseValue = Invariant.Required(
                    caseSyntax.Value,
                    "a non-default switch case has a pattern value",
                    expression: "caseSyntax.Value"
                )
                let pattern = patterns.BindPattern(caseValue, switchType)
                // Issue #3501 A3: a fallthrough INTO this arm skips its pattern
                // test — pattern bindings and guards would run unassigned/
                // unevaluated, so such targets are rejected. Pattern-declared
                // variables live in the arm scope just pushed above.
                if armEntryLabels[caseIndex] != nil &&
                    ($scope.GetDeclaredVariables().Length > 0 || caseSyntax.Guard != nil) {
                    let previousCase = syntax.Cases[caseIndex - 1]
                    let fallthroughKeyword = previousCase.Body.Statements[previousCase.Body.Statements.Length - 1]
                    Diagnostics.ReportFallthroughTargetHasBindings(fallthroughKeyword.Location)
                }
                // Issue #991: a guarded arm (`when <bool>`) can always fail at
                // runtime, so a guarded discard `case _ when …` does NOT act as a
                // default/total arm.
                let guardSyntax ExpressionSyntax? = caseSyntax.Guard
                let hasGuard = guardSyntax != nil
                if pattern is BoundDiscardPattern && !hasGuard {
                    if hasDefault {
                        Diagnostics.ReportDuplicateSwitchDefault(caseValue.Location)
                    }
                    hasDefault = true
                }
                let frame Dictionary[AccessPath, TypeSymbol]? = TryClassifyPatternNarrowing(discriminant, pattern)
                var guard_ BoundExpression? = nil
                if hasGuard {
                    guard_ = BindGuardExpressionWithNarrowing(
                        Invariant.Required(
                            guardSyntax,
                            "a guarded switch case has a guard expression",
                            expression: "guardSyntax"
                        ),
                        frame
                    )
                    callableEntry.ExceptWith(ApplyHeaderCallableEffects(guard_) ?? HashSet[VariableSymbol]())
                    ShadowAddGuard(shadowFlow, guard_)
                }
                // ADR-0166: the arm body runs only when the guard was true, so the
                // guard's when-true pattern variables (`when x.Tag is string tag`)
                // are in scope there.
                let (guardWhenTrue, _) = PatternVariables.Classify(guard_)
                var body = PatternVariables.BindInScope(
                    binderCtx,
                    guardWhenTrue,
                    () -> {
                        return BindStatementWithNarrowing(caseSyntax.Body, frame)
                    }
                )
                $scope = $scope.Pop()
                ShadowAddBranch(shadowFlow, frame, body)
                shadowApproximate = shadowApproximate || endsInFallthrough
                body = PrependArmEntryLabel(body, armEntryLabels[caseIndex])
                arms.Add(BoundPatternSwitchArm(nil, pattern, guard_, body))
                let callableArmExit = CaptureExternalCallableAliases()
                callableFallthrough = if endsInFallthrough {
                    callableArmExit
                } else {
                    default(HashSet[VariableSymbol]?)
                }
                if !EndsInUnconditionalExit(body, gotoExits: false) {
                    callableExits = JoinExternalCallableAliases(callableExits, callableArmExit)
                }
                // Issue #991: a guarded arm may not actually run even when its
                // pattern matches, so it cannot contribute a reliable post-switch
                // narrowing. Conservatively defeat the narrowing merge.
                if hasGuard {
                    mergeFailed = true
                }
                if mergeFailed {
                    continue
                }
                if EndsInUnconditionalExit(body) {
                    continue
                }
                hasAnyFallThroughArm = true
                if frame == nil || frame.Count == 0 {
                    // Fall-through arm with no narrowing — nothing to lift.
                    mergeFailed = true
                    continue
                }
                if mergedExitFrame == nil {
                    mergedExitFrame = Dictionary[AccessPath, TypeSymbol](frame)
                    continue
                }
                // Intersect with the running merge. Only variables narrowed to
                // the same type by every fall-through arm survive.
                let next = Dictionary[AccessPath, TypeSymbol]()
                for kv in frame {
                    if mergedExitFrame!!.TryGetValue(kv.Key, out var existing) && existing == kv.Value {
                        next[kv.Key] = kv.Value
                    }
                }
                if next.Count == 0 {
                    mergeFailed = true
                    mergedExitFrame = nil
                } else {
                    mergedExitFrame = next
                }
            }
        } finally {
            binderCtx.LoopStack.Pop()
            this.binderCtx.CurrentFallthroughTarget = savedFallthroughTarget
            this.binderCtx.CurrentFallthroughAnchor = savedFallthroughAnchor
        }
        if !hasDefault {
            callableExits = JoinExternalCallableAliases(callableExits, callableEntry)
        }
        RestoreExternalCallableAliases(callableExits ?? callableEntry)
        let boundArms = arms.ToImmutable()
        let isExhaustive = ExhaustivenessAnalyzer.AnalyzeSwitchStatement(
            syntax.SwitchKeyword.Location,
            switchType,
            boundArms,
            $scope.GetDeclaredStructs(),
            Diagnostics
        )
        let result = BoundPatternSwitchStatement(nil, discriminant, boundArms, isExhaustive)
        let shadowBreaks = binderCtx.UsedBreakLabels.Contains(switchBreakLabel)
        // ADR-0069 addendum / issue #712: park the merged narrowing on the
        // bound switch so the enclosing block walker can lift it. Only do
        // so when at least one arm fell through (otherwise the switch
        // itself unconditionally exits and the post-switch dataflow is
        // unreachable). Also require the switch to be exhaustive — if a
        // non-matching value escapes the switch without entering any arm,
        // the discriminator's type is unchanged and we must not narrow.
        if !mergeFailed &&
            hasAnyFallThroughArm &&
            mergedExitFrame != nil &&
            mergedExitFrame.Count > 0 &&
            SwitchHandlesAllValues(boundArms, switchType) {
            binderCtx.PendingSwitchExitFrames[result] = mergedExitFrame
        }
        // Issue #3501 A3: when an arm actually used `break`, its goto targets
        // the statement position right after the switch — append the label
        // there. Switches with no arm-level break keep their bare shape (so
        // exhaustive all-arms-return switches still read as unconditional
        // exits to the all-paths-return check).
        if shadowBreaks {
            let wrapped = BoundBlockStatement(
                syntax,
                ImmutableArray.Create[BoundStatement](result, BoundLabelStatement(nil, switchBreakLabel))
            )
            ShadowFinish(
                shadowFlow,
                "switch",
                syntax.SwitchKeyword.Location,
                []BoundStatement{result, wrapped},
                !(hasDefault || isExhaustive),
                true
            )
            return wrapped
        }
        ShadowFinish(
            shadowFlow,
            "switch",
            syntax.SwitchKeyword.Location,
            []BoundStatement{result},
            !(hasDefault || isExhaustive),
            shadowApproximate
        )
        return result
    }

    private func BindTryStatement(syntax TryStatementSyntax) BoundStatement {
        let callableEntry = CaptureExternalCallableAliases()
        let reachabilityGeneration = internalReachabilityGeneration
        let tryBlock = BindWithinFinallyScope(syntax.FinallyClause, () -> BindBlockStatement(syntax.TryBlock))
        let callableTryExit = CaptureExternalCallableAliases()
        let tryMutations = AssignedRootsCollector(nil, callableEntry)
        tryMutations.Visit(tryBlock)
        let callableExceptionalEntry = HashSet[VariableSymbol](callableEntry)
        callableExceptionalEntry.ExceptWith(tryMutations.Roots)
        // ADR-0208 R10 (#5168): an enclosing filter can run user code that assigns a callable alias.
        let enclosingFilters = CollectEnclosingCatchFilters(syntax)
        if enclosingFilters.Count > 0 {
            RemoveFilterAffectedAliases(callableExceptionalEntry, enclosingFilters)
        }
        var callableFinallyEntries = JoinExternalCallableAliases(
            HashSet[VariableSymbol](callableTryExit),
            callableExceptionalEntry
        )
        var callableExits HashSet[VariableSymbol]? = if CanReachCallableJoin(tryBlock) {
            HashSet[VariableSymbol](callableTryExit)
        } else {
            default(HashSet[VariableSymbol]?)
        }
        let handlersReachable = currentStatementListFallsThrough ||
            internalReachabilityGeneration != reachabilityGeneration
        let exceptionType TypeSymbol? = ResolveExceptionType()
        if exceptionType == nil {
            Diagnostics.ReportUndefinedType(syntax.TryKeyword.Location, "System.Exception")
            return BindErrorStatement()
        }
        let catches = ImmutableArray.CreateBuilder[BoundCatchClause]()
        // ADR-0177 D: exception types an earlier *unfiltered* clause already
        // catches unconditionally. A filtered clause never covers its type,
        // because the filter can decline at run time and hand the exception to
        // a later sibling — which is exactly why C# only reports CS0160 for
        // unfiltered predecessors.
        let unfilteredCoverage = List[TypeSymbol]()
        for catchSyntax in syntax.CatchClauses {
            RestoreExternalCallableAliases(callableExceptionalEntry)
            InvalidateNarrowingsForEnclosingFilters(enclosingFilters)
            let inheritedReachability = currentStatementListFallsThrough
            currentStatementListFallsThrough = handlersReachable
            // ADR-0177 A: a bare `catch { … }` carries no type clause and means
            // `catch (System.Exception)`, exactly as in C#.
            var catchType = exceptionType
            if catchSyntax.TypeClause != nil {
                let declared TypeSymbol? = bindTypeClause(catchSyntax.TypeClause)
                if declared != nil {
                    catchType = declared
                }
            }
            for covered in unfilteredCoverage {
                if IsCaughtBy(catchType, covered) {
                    Diagnostics.ReportUnreachableCatchClause(
                        (catchSyntax.TypeClause ?? cast[SyntaxNode](catchSyntax.CatchKeyword)).Location,
                        covered,
                        catchType
                    )
                    break
                }
            }
            $scope = BoundScope($scope)
            // ADR-0177 A: `catch (Type)` and bare `catch` bind nothing. The
            // emitter pops the exception off the stack instead of storing it.
            let variable = if catchSyntax.Identifier == nil {
                default(VariableSymbol?)
            } else {
                bindLocalVariable(catchSyntax.Identifier, true, catchType)
            }
            let filter BoundExpression? = BindCatchFilter(catchSyntax)
            callableExceptionalEntry.ExceptWith(ApplyHeaderCallableEffects(filter) ?? HashSet[VariableSymbol]())
            // ADR-0208 R10 (#5168): a filter runs before its handler is chosen. A
            // false or throwing filter continues the search (ADR-0177), so its
            // writes reach this body, every later clause and the finally block.
            if filter != nil {
                InvalidateNarrowingsForAssignedVariables(catchSyntax.Filter!!, BoundExpressionStatement(nil, filter))
            }
            let (filterWhenTrue, _) = PatternVariables.Classify(filter)
            exceptionHandlerRegions.Push(catchSyntax)
            var body BoundStatement
            try {
                // The handler runs only when its filter returned true, so any
                // pattern variables the filter definitely assigns on that path
                // are in scope and assigned throughout the handler.
                body = BindWithinFinallyScope(
                    syntax.FinallyClause,
                    () -> PatternVariables.BindInScope(
                        binderCtx,
                        filterWhenTrue,
                        () -> BindBlockStatement(catchSyntax.Body)
                    )
                )
            } finally {
                exceptionHandlerRegions.Pop()
                currentStatementListFallsThrough = inheritedReachability
            }
            $scope = $scope.Pop()
            if filter == nil {
                unfilteredCoverage.Add(catchType)
            }
            catches.Add(BoundCatchClause(catchType, variable, filter, body, exitsThroughFinally: false))
            let callableCatchExit = CaptureExternalCallableAliases()
            callableFinallyEntries = JoinExternalCallableAliases(callableFinallyEntries, callableCatchExit)
            if CanReachCallableJoin(body) {
                callableExits = JoinExternalCallableAliases(callableExits, callableCatchExit)
            }
        }
        var finallyBlock BoundStatement? = nil
        if syntax.FinallyClause != nil {
            InvalidateNarrowingsForEnclosingFilters(enclosingFilters)
            RestoreExternalCallableAliases(callableFinallyEntries)
            finallyEntryExternalCallableAliases[syntax.FinallyClause!!] = callableExits?.ToImmutableArray() ??
                ImmutableArray[VariableSymbol].Empty
            let inheritedReachability = currentStatementListFallsThrough
            currentStatementListFallsThrough = handlersReachable
            exceptionHandlerRegions.Push(syntax.FinallyClause!!)
            try {
                finallyBlock = BindBlockStatement(syntax.FinallyClause!!.Body)
                boundFinallyBlocks[syntax.FinallyClause!!] = finallyBlock
            } finally {
                exceptionHandlerRegions.Pop()
                currentStatementListFallsThrough = inheritedReachability
            }
        } else {
            RestoreExternalCallableAliases(callableExits ?? callableEntry)
        }
        if catches.Count == 0 && finallyBlock == nil {
            Diagnostics.ReportTryWithoutCatchOrFinally(syntax.TryKeyword.Location)
            return BindErrorStatement()
        }
        // Issue #836: a `yield` lexically inside a `try` block that also
        // has any `catch` clause is rejected (C# §15.14 / ECMA-335). The
        // iterator state machine cannot safely resume into a protected
        // region from a synthesized dispatch when that region also acts
        // as a CLR exception handler frame. Pure `try`/`finally` around
        // `yield` is supported and lowered by IteratorMoveNextBodyBuilder.
        if catches.Count > 0 &&
            function != nil &&
            isIteratorReturnType(function!!.Type) &&
            YieldFinder
            .ContainsYieldInOwnTryBlock(tryBlock) {
            for yieldLocation in YieldFinder.GetYieldLocationsInOwnTryBlock(tryBlock) {
                Diagnostics.ReportYieldInsideTryWithCatch(yieldLocation)
            }
        }
        return BoundTryStatement(syntax, tryBlock, catches.ToImmutable(), finallyBlock)
    }

    /// ADR-0208 R10 (#5168): the `when` filters of [`syntax`](paramref) and of every enclosing `try`
    /// whose protected block contains it. The CLR runs those filters in the first pass,
    /// before this `try` runs a `finally` block, and a replacement exception can reach a
    /// handler of this `try` after them.
    private func CollectEnclosingCatchFilters(syntax TryStatementSyntax) List[ExpressionSyntax] {
        let filters = List[ExpressionSyntax]()
        // A replacement exception from a nested finally reaches an earlier clause of this try after
        // the filter of a later clause has run for the original exception.
        for clause in syntax.CatchClauses {
            if clause.Filter != nil {
                filters.Add(clause.Filter)
            }
        }
        filters.AddRange(CollectCatchFiltersAbove(syntax))
        return filters
    }

    /// ADR-0208 R10 (#5168): the `when` filters of every `try` whose protected block contains
    /// [`start`](paramref).
    private func CollectCatchFiltersAbove(start SyntaxNode) List[ExpressionSyntax] {
        let filters = List[ExpressionSyntax]()
        var child SyntaxNode = start
        var parent = start.Parent
        while parent != nil {
            if parent is TryStatementSyntax outer && object.ReferenceEquals(outer.TryBlock, child) {
                for clause in outer.CatchClauses {
                    if clause.Filter != nil {
                        filters.Add(clause.Filter)
                    }
                }
            }
            child = parent
            parent = parent.Parent
        }
        return filters
    }

    /// ADR-0208 R10 (#5168): removes the external-callable aliases that a filter may reassign: a
    /// name the filter writes, or a variable that a closure assigns.
    private func RemoveFilterAffectedAliases(aliases HashSet[VariableSymbol], filters List[ExpressionSyntax]) {
        let filterNames = CollectEnclosingFilterNames(filters)
        aliases.RemoveWhere(
            (alias VariableSymbol) -> filterNames.Contains(alias.Name) || binderCtx.MayBeAssignedByClosure(alias)
        )
    }

    /// ADR-0208 R10 (#5168): the names that [`filters`](paramref) may write: assignment targets,
    /// `??=` targets, and `ref`, `out` and `&` operands. A name that a filter only reads is not
    /// written. Also anchors the closure-assigned name set.
    private func CollectEnclosingFilterNames(filters List[ExpressionSyntax]) HashSet[string] {
        EnsureClosureAssignedNames(filters[0])
        let names = HashSet[string]()
        for filter in filters {
            CollectAssignedNamesAndMemberMutation(filter, names)
            CollectWritableRefArgumentNames(filter, names)
            CollectFilterWriteTargets(filter, names)
        }
        return names
    }

    /// ADR-0208 R10 (#5168): collects the targets of `??=` and `&` in a filter. An index input of the
    /// target is only read; nested writes stay found by the traversal.
    private func CollectFilterWriteTargets(node SyntaxNode, names HashSet[string]) {
        if node is NullCoalescingAssignmentExpressionSyntax coalescing {
            CollectWriteTargetNames(coalescing.Target, names)
        } else if node is UnaryExpressionSyntax unary && unary.OperatorToken.Kind == SyntaxKind.AmpersandToken {
            CollectWriteTargetNames(unary.Operand, names)
        }
        for child in node.GetChildren() {
            CollectFilterWriteTargets(child, names)
        }
    }

    /// ADR-0208 R10 (#5168): the `when` filters of every `try` at or below [`node`](paramref).
    private func CollectCatchFiltersWithin(node SyntaxNode) List[ExpressionSyntax] {
        let filters = List[ExpressionSyntax]()
        if node is TryStatementSyntax tryStatement {
            for clause in tryStatement.CatchClauses {
                if clause.Filter != nil {
                    filters.Add(clause.Filter)
                }
            }
        }
        for child in node.GetChildren() {
            filters.AddRange(CollectCatchFiltersWithin(child))
        }
        return filters
    }

    /// ADR-0208 R10 (#5168): adds the storage that the `ref` or `out` operand [`operand`](paramref)
    /// writes: the variable itself, or the receiver of an index. An index input is only read.
    private func CollectWriteTargetNames(operand SyntaxNode, names HashSet[string]) {
        if operand is ParenthesizedExpressionSyntax parenthesized {
            CollectWriteTargetNames(parenthesized.Expression, names)
        } else if operand is IndexExpressionSyntax indexed {
            CollectWriteTargetNames(indexed.Target, names)
        } else if operand is AccessorExpressionSyntax accessor {
            CollectWriteTargetNames(accessor.LeftPart, names)
        } else {
            CollectAllNames(operand, names)
        }
    }

    /// ADR-0208 R10 (#5168): collects the names under `ref` and `out` arguments. An `in` argument
    /// cannot write its storage.
    private func CollectWritableRefArgumentNames(node SyntaxNode, names HashSet[string]) {
        if node is RefArgumentExpressionSyntax reference && !string.Equals(
            reference.RefKindModifier.Text,
            "in",
            StringComparison.Ordinal
        ) {
            if reference.Expression != nil {
                CollectWriteTargetNames(reference.Expression, names)
            } else {
                CollectAllNames(node, names)
            }
        }
        // An operand can contain nested writes, such as `ref items[Next(ref index)]`.
        for child in node.GetChildren() {
            CollectWritableRefArgumentNames(child, names)
        }
    }

    /// ADR-0208 R10 (#5168): drops the facts that [`filters`](paramref) may write. The filters
    /// are not bound yet, so every variable that a filter may write counts as written, and
    /// a filter counts as an unknown call: a getter, an indexer or a conversion can run user code
    /// without a call expression.
    private func InvalidateNarrowingsForEnclosingFilters(filters List[ExpressionSyntax]) {
        if filters.Count == 0 {
            return
        }
        let names = CollectEnclosingFilterNames(filters)
        if !HasAnyActiveNarrowings() {
            return
        }
        for frame in binderCtx.NarrowedVariables {
            if frame.Count == 0 {
                continue
            }
            let toRemove = List[AccessPath]()
            for key in frame.Keys {
                if names.Contains(key.Root.Name) || MayBeMutatedByUnknownCallable(key) {
                    toRemove.Add(key)
                }
            }
            for key in toRemove {
                frame.Remove(key)
            }
        }
    }

    private func BindWithinFinallyScope(finallyClause FinallyClauseSyntax?, bind() -> BoundStatement) BoundStatement {
        if finallyClause == nil {
            return bind()
        }
        activeFinallyClauses.Push(finallyClause)
        activeCleanupRegions.Push(GotoCleanupRegion(finallyClause, nil))
        try {
            return bind()
        } finally {
            activeCleanupRegions.Pop()
            activeFinallyClauses.Pop()
        }
    }

    /// ADR-0177 B: binds a clause's `when` filter. The filter is emitted as
    /// a CLR filter region, so it runs in the exception system's first pass —
    /// before any intervening `finally`, and while the throw point's frame
    /// is still on the stack. Two consequences fall out of that and are enforced
    /// here: the filter is not a handler (so it is bound outside the enclosing
    /// handler regions, making a `rethrow` inside it GS0570), and it cannot
    /// suspend (so an `await` inside it is GS0572).
    /// @param catchSyntax The catch clause being bound.
    /// @returns The bound filter, or `null` when the clause has none or the filter is in error.
    private func BindCatchFilter(catchSyntax CatchClauseSyntax) BoundExpression? {
        if catchSyntax.Filter is not{} filterSyntax {
            return nil
        }
        let filter = OutsideExceptionHandlers(() -> bindExpression(filterSyntax, false))
        if filter is BoundErrorExpression {
            return nil
        }
        if filter.Type != TypeSymbol.Bool {
            Diagnostics.ReportCannotConvert(filterSyntax.Location, filter.Type, TypeSymbol.Bool)
            return nil
        }
        for awaitLocation in AwaitFinder.Locations(filter) {
            Diagnostics.ReportAwaitInsideCatchFilter(awaitLocation)
        }
        return filter
    }

    /// ADR-0177 D: collects the `await` expressions lexically inside a bound
    /// expression, without descending into nested function bodies — a lambda
    /// declared in a filter is not itself run by the filter region.
    private class AwaitFinder : BoundTreeWalker {
        private let locations List[TextLocation] = List[TextLocation]()

        protected override func VisitAwaitExpression(node BoundAwaitExpression) {
            if node.Syntax is {} syntax {
                this.locations.Add(syntax.Location)
            }
            base.VisitAwaitExpression(node)
        }

        shared {
            func Locations(expression BoundExpression) IReadOnlyList[TextLocation] {
                let walker = AwaitFinder()
                walker.VisitExpression(expression)
                return walker.locations
            }
        }
    }

    /// Walker that locates `yield` statements lexically inside a
    /// bound block, but does not descend into nested function bodies
    /// (lambdas / local functions). Issue #836.
    private class YieldFinder : BoundTreeWalker {
        private let locations List[TextLocation] = List[TextLocation]()

        protected override func VisitYieldStatement(node BoundYieldStatement) {
            // Prefer the `yield` keyword's location; fall back to the
            // full statement syntax location if available.
            if node.Syntax is YieldStatementSyntax yieldSyntax {
                this.locations.Add(yieldSyntax.YieldKeyword.Location)
            } else if node.Syntax != nil {
                this.locations.Add(node.Syntax!!.Location)
            }
        }

        shared {
            func ContainsYieldInOwnTryBlock(tryBlock BoundStatement) bool {
                let walker = YieldFinder()
                walker.VisitStatement(tryBlock)
                return walker.locations.Count > 0
            }

            func GetYieldLocationsInOwnTryBlock(tryBlock BoundStatement) IReadOnlyList[TextLocation] {
                let walker = YieldFinder()
                walker.VisitStatement(tryBlock)
                return walker.locations
            }
        }
    }

    private func BindThrowStatement(syntax ThrowStatementSyntax) BoundStatement {
        var expression = bindExpression(syntax.Expression, false)
        // ADR-0186 §4: a `throw` operand is one of the positions the ADR names
        // explicitly — "used where the language requires a non-null
        // reference". It does not pass through `BindConversion`, so it does
        // not inherit the check from the value seam; without this it still
        // fails fast (the CLR's own `throw` on a nil), but unattributed,
        // which is the entire thing §4 buys over the CLR's check.
        expression = binderCtx.InsertPlatformCheck(expression, syntax.Expression.Location, "a 'throw' operand")
        let exceptionType TypeSymbol? = ResolveExceptionType()
        if exceptionType != nil && expression.Type != TypeSymbol.Error {
            var argClr Type? = expression.Type?.ClrType
            // Issue #319: a GSharp class that inherits an imported CLR Exception
            // type has no concrete ClrType until emit time, but its
            // ImportedBaseType (walked transitively) is what determines
            // assignability to System.Exception.
            if argClr == nil && expression.Type is StructSymbol throwStruct {
                for t in throwStruct.GetHierarchy() {
                    if t.ImportedBaseType?.ClrType is Type clrBase {
                        argClr = clrBase
                        break
                    }
                }
            }
            if argClr == nil || !ClrTypeUtilities.IsAssignableByName(exceptionType.ClrType, argClr) {
                Diagnostics.ReportCannotConvert(
                    syntax.Expression.Location,
                    expression.Type ?? TypeSymbol.Error,
                    exceptionType
                )
                return BindErrorStatement()
            }
        }
        return BoundThrowStatement(syntax, expression)
    }

    /// Binds a `rethrow` statement (ADR-0176, issue #3897).
    /// @remarks Legality mirrors ECMA-335 III.4.24 (and C#'s CS0156 / CS0724):
    /// the statement must be lexically inside a `catch` handler, and no
    /// `finally` clause may sit between it and that handler — by the time
    /// a nested `finally` runs the CLR has already left the catch handler,
    /// so `rethrow` there would be unverifiable IL.
    ///
    /// The exception re-raised is the one belonging to the <i>lexically
    /// innermost</i> enclosing catch, which is exactly the top of
    /// `exceptionHandlerRegions`. A nested `try` <i>block</i> inside a
    /// catch handler pushes nothing, so a `rethrow` in it still refers to
    /// the enclosing catch's exception — matching C#.
    private func BindRethrowStatement(syntax RethrowStatementSyntax) BoundStatement {
        // The stack holds only handler bodies (catch/finally). The first entry
        // from the top decides: a catch means we are directly inside a handler;
        // a finally means a finally intervenes.
        let innermostHandler SyntaxNode? = if exceptionHandlerRegions.Count > 0 {
            exceptionHandlerRegions.Peek()
        } else {
            default(SyntaxNode?)
        }
        if innermostHandler is CatchClauseSyntax {
            return BoundRethrowStatement(syntax)
        }
        // A `finally` at the top only earns the more specific GS0571 when there
        // really is a catch handler further out that the finally is nested in;
        // otherwise there is no exception being handled at all (GS0570).
        var hasEnclosingCatch = false
        for region in exceptionHandlerRegions {
            if region is CatchClauseSyntax {
                hasEnclosingCatch = true
                break
            }
        }
        if innermostHandler is FinallyClauseSyntax && hasEnclosingCatch {
            Diagnostics.ReportRethrowInsideNestedFinally(syntax.RethrowKeyword.Location)
        } else {
            Diagnostics.ReportRethrowOutsideCatchHandler(syntax.RethrowKeyword.Location)
        }
        return BindErrorStatement()
    }

    /// Binds a nested function body (lambda / function literal) with the
    /// enclosing exception-handler regions hidden.
    /// @remarks ADR-0176: a lambda declared inside a `catch` handler is emitted as
    /// a separate method, so a `rethrow` in its body is not inside any
    /// handler at run time. Clearing the region stack for the duration of the
    /// nested body makes (cref:BindRethrowStatement) report GS0570 there
    /// instead of emitting unverifiable IL — matching C#'s treatment of
    /// `throw;` in a lambda.
    /// @param syntax The nested function's block body.
    /// @returns The bound body.
    internal func BindNestedFunctionBody(syntax BlockStatementSyntax) BoundStatement {
        let inheritedFallthrough = currentStatementListFallsThrough
        let inheritedReachabilityGeneration = internalReachabilityGeneration
        currentStatementListFallsThrough = true
        try {
            return OutsideExceptionHandlers(() -> BindBlockStatement(syntax))
        } finally {
            currentStatementListFallsThrough = inheritedFallthrough
            internalReachabilityGeneration = inheritedReachabilityGeneration
        }
    }

    /// Runs [`bind`](paramref) with the enclosing exception-handler
    /// regions hidden, then restores them.
    /// @typeparam T The bound result type.
    /// @param bind The binding callback for the nested function body.
    /// @returns Whatever [`bind`](paramref) produced.
    internal func OutsideExceptionHandlers[T](bind() -> T) T {
        let saved = exceptionHandlerRegions.ToArray()
        let savedFinallyClauses = activeFinallyClauses.ToArray()
        let savedCleanupStatements = activeCleanupStatements.ToArray()
        let savedCleanupRegions = activeCleanupRegions.ToArray()
        exceptionHandlerRegions.Clear()
        activeFinallyClauses.Clear()
        activeCleanupStatements.Clear()
        activeCleanupRegions.Clear()
        try {
            return bind()
        } finally {
            exceptionHandlerRegions.Clear()
            activeFinallyClauses.Clear()
            activeCleanupStatements.Clear()
            activeCleanupRegions.Clear()
            // Stack.ToArray() yields top-first; push back in reverse to restore.
            for var i = saved.Length - 1; i >= 0; i-- {
                exceptionHandlerRegions.Push(saved[i])
            }
            for var i = savedFinallyClauses.Length - 1; i >= 0; i-- {
                activeFinallyClauses.Push(savedFinallyClauses[i])
            }
            for var i = savedCleanupStatements.Length - 1; i >= 0; i-- {
                activeCleanupStatements.Push(savedCleanupStatements[i])
            }
            for var i = savedCleanupRegions.Length - 1; i >= 0; i-- {
                activeCleanupRegions.Push(savedCleanupRegions[i])
            }
        }
    }

    private func BindUsingStatement(syntax UsingStatementSyntax) BoundStatement {
        let usingLowering = BindUsingStatementInBlock(syntax)
        if usingLowering.Cleanup == nil {
            return Invariant.Required(
                usingLowering.ErrorStatement,
                "an invalid using lowering has an error statement",
                expression: "usingLowering.ErrorStatement"
            )
        }
        let cleanup = usingLowering.Cleanup
        let initialized = Invariant.Required(
            usingLowering.Initialized,
            "a valid using lowering has an initialization flag",
            expression: "usingLowering.Initialized"
        )
        let tryStmt = BuildCleanupTryStatement(
            ImmutableArray[BoundStatement].Empty,
            cleanup!!,
            initialized,
            NilGuardedResource(usingLowering.Declaration.Variable)
        )
        return BoundBlockStatement(
            syntax,
            ImmutableArray.Create[BoundStatement](
                Invariant.Required(
                    usingLowering.InitializedDeclaration,
                    "a valid using lowering has an initialization declaration",
                    expression: "usingLowering.InitializedDeclaration"
                ),
                usingLowering.Declaration,
                BuildInitializedAssignment(initialized),
                tryStmt
            )
        )
    }

    private func BindUsingStatementInBlock(syntax UsingStatementSyntax)(
        InitializedDeclaration BoundVariableDeclaration?,
        Declaration BoundVariableDeclaration,
        Initialized VariableSymbol?,
        Cleanup BoundExpression?,
        ErrorStatement BoundStatement?
    ) {
        let declaration = cast[BoundVariableDeclaration](BindVariableDeclaration(syntax.Declaration))
        let disposeCall BoundExpression? = conversions.TryBuildDisposeCall(
            declaration.Variable,
            syntax.UsingKeyword.Location
        )
        if disposeCall == nil {
            return (nil, declaration, nil, nil, BindErrorStatement())
        }
        let initialized = LocalVariableSymbol(
            "<>usingInitialized" + usingInitializationFlagCount++.ToString(),
            isReadOnly: false,
            TypeSymbol.Bool
        )
        let initializedDeclaration = BoundVariableDeclaration(nil, initialized, BoundLiteralExpression(nil, false))
        return (initializedDeclaration, declaration, initialized, disposeCall, nil)
    }

    private func BindAwaitUsingStatement(syntax AwaitUsingStatementSyntax) BoundStatement {
        let awaitUsingLowering = BindAwaitUsingStatementInBlock(syntax)
        if awaitUsingLowering.Cleanup == nil {
            return Invariant.Required(
                awaitUsingLowering.ErrorStatement,
                "an invalid await using lowering has an error statement",
                expression: "awaitUsingLowering.ErrorStatement"
            )
        }
        let cleanup = awaitUsingLowering.Cleanup
        let initialized = Invariant.Required(
            awaitUsingLowering.Initialized,
            "a valid await using lowering has an initialization flag",
            expression: "awaitUsingLowering.Initialized"
        )
        let declaration = Invariant.Required(
            awaitUsingLowering.Declaration,
            "a valid await using lowering has a declaration",
            expression: "awaitUsingLowering.Declaration"
        )
        let tryStmt = BuildCleanupTryStatement(
            ImmutableArray[BoundStatement].Empty,
            cleanup!!,
            initialized,
            NilGuardedResource(declaration.Variable)
        )
        return BoundBlockStatement(
            syntax,
            ImmutableArray.Create[BoundStatement](
                Invariant.Required(
                    awaitUsingLowering.InitializedDeclaration,
                    "a valid await using lowering has an initialization declaration",
                    expression: "awaitUsingLowering.InitializedDeclaration"
                ),
                declaration,
                BuildInitializedAssignment(initialized),
                tryStmt
            )
        )
    }

    private func BindAwaitUsingStatementInBlock(syntax AwaitUsingStatementSyntax)(
        InitializedDeclaration BoundVariableDeclaration?,
        Declaration BoundVariableDeclaration?,
        Initialized VariableSymbol?,
        Cleanup BoundExpression?,
        ErrorStatement BoundStatement?
    ) {
        // Gate: await using let requires an async (or suspending) context.
        if function == nil || !function!!.IsAsyncOrSuspending {
            Diagnostics.ReportAwaitUsingOutsideAsyncFunction(syntax.AwaitKeyword.Location)
            return (nil, nil, nil, nil, BindErrorStatement())
        }
        let declaration = cast[BoundVariableDeclaration](BindVariableDeclaration(syntax.Declaration))
        let disposeAsyncCall BoundExpression? = conversions.TryBuildDisposeAsyncCall(
            declaration.Variable,
            syntax.AwaitKeyword.Location
        )
        if disposeAsyncCall == nil {
            return (nil, declaration, nil, nil, BindErrorStatement())
        }
        let initialized = LocalVariableSymbol(
            "<>usingInitialized" + usingInitializationFlagCount++.ToString(),
            isReadOnly: false,
            TypeSymbol.Bool
        )
        let initializedDeclaration = BoundVariableDeclaration(nil, initialized, BoundLiteralExpression(nil, false))
        return (initializedDeclaration, declaration, initialized, disposeAsyncCall, nil)
    }

    private func BindDeferStatement(syntax DeferStatementSyntax) BoundStatement {
        let defer_ = BindDeferStatementInBlock(syntax)
        if defer_.Cleanup == nil {
            return Invariant.Required(
                defer_.ErrorStatement,
                "an invalid defer lowering has an error statement",
                expression: "defer.ErrorStatement"
            )
        }
        let tryStmt = BuildCleanupTryStatement(
            ImmutableArray[BoundStatement].Empty,
            defer_.Cleanup!!,
            shieldCleanup: true
        )
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.AddRange(defer_.PrefixStatements)
        statements.Add(tryStmt)
        return BoundBlockStatement(syntax, statements.ToImmutable())
    }

    private func BindDeferStatementInBlock(syntax DeferStatementSyntax)(
        PrefixStatements ImmutableArray[BoundStatement],
        Cleanup BoundExpression?,
        ErrorStatement BoundStatement?
    ) {
        let expression = bindExpression(syntax.Expression, true)
        if expression is BoundErrorExpression {
            return (ImmutableArray[BoundStatement].Empty, nil, BoundExpressionStatement(nil, expression))
        }
        if !IsDeferableCall(expression) {
            Diagnostics.ReportDeferOperandIsNotACall(syntax.Expression.Location)
            return (ImmutableArray[BoundStatement].Empty, nil, BoundExpressionStatement(nil, BoundErrorExpression(nil)))
        }
        // Issue #1635 NB-1: a by-ref (ref/out/in) argument's bound value IS the
        // address of its target storage (a BoundAddressOfExpression /
        // BoundConditionalAddressExpression). Eager capture spills each
        // argument's *value* into a fresh readonly local, which for a by-ref
        // argument would spill the address into an ordinary (non-ref) local —
        // not supported by the emitter and not a meaningful by-ref capture.
        // Reject rather than silently mis-defer.
        if HasByRefArgument(expression) {
            Diagnostics.ReportDeferOperandHasByRefArgument(syntax.Expression.Location)
            return (ImmutableArray[BoundStatement].Empty, nil, BoundExpressionStatement(nil, BoundErrorExpression(nil)))
        }
        let prefix = ImmutableArray.CreateBuilder[BoundStatement]()
        let capturedCall = CaptureDeferArguments(expression, prefix)
        return (prefix.ToImmutable(), capturedCall, nil)
    }

    // ADR-0030 / issue #1635 (NB-1 follow-up): rebuild the deferred call with the
    // SAME node kind and EVERY metadata property the original call carried —
    // constrained-interface dispatch info, explicit type arguments, non-virtual
    // base-call marking, ref-kind annotations, static generic owner types, etc.
    // Only the receiver/target and arguments change (to the captured `$defer$`
    // locals); nothing else may be dropped or the deferred call can emit wrong
    // dispatch or invalid metadata.
    private func CaptureDeferArguments(
        expression BoundExpression,
        prefix ImmutableArray[BoundStatement].Builder
    ) BoundExpression {
        switch expression {
            case call is BoundCallExpression {
                return BoundCallExpression(
                    nil,
                    call.Function,
                    CaptureArguments(call.Arguments, prefix),
                    call.ReturnType,
                    call.IsConditionalElided
                ){
                    StaticGenericOwnerType = call.StaticGenericOwnerType,
                    StaticGenericInterfaceOwnerType = call.StaticGenericInterfaceOwnerType,
                    MethodTypeArguments = call.MethodTypeArguments
                }
            }
            case call is BoundIndirectCallExpression {
                return BoundIndirectCallExpression(
                    nil,
                    CaptureExpression(call.Target, prefix),
                    call.FunctionType,
                    CaptureArguments(call.Arguments, prefix),
                    call.ArgumentRefKinds
                )
            }
            case call is BoundUserInstanceCallExpression {
                return BoundUserInstanceCallExpression(
                    nil,
                    CaptureExpression(call.Receiver, prefix),
                    call.Method,
                    CaptureArguments(call.Arguments, prefix),
                    call.Type,
                    call.ConstrainedReceiverTypeParameter,
                    call.ConstrainedInterfaceType
                ){MethodTypeArguments = call.MethodTypeArguments}
            }
            case call is BoundImportedCallExpression {
                let captureStart = prefix.Count
                let arguments = CaptureArguments(call.Arguments, prefix)
                let copy = BoundImportedCallExpression(
                    call.Syntax,
                    call.Function,
                    arguments,
                    call.ArgumentRefKinds,
                    call.TypeArgumentSymbols,
                    call.StaticContainerType
                )
                // This closed capture created exactly this assignment and read.
                // A generic operand replacement cannot prove that value origin.
                if call.Arguments.Length == 1 && object.ReferenceEquals(
                    call.LogicalCompletionOperand,
                    call.Arguments[0]
                ) &&
                    prefix.Count == captureStart +
                    1 &&
                    prefix[captureStart] is BoundVariableDeclaration captured &&
                    object.ReferenceEquals(captured.Initializer, call.LogicalCompletionOperand) &&
                    arguments[0] is BoundVariableExpression read &&
                    object.ReferenceEquals(captured.Variable, read.Variable) {
                    copy.RecordLogicalCompletion(read)
                }
                return copy
            }
            case call is BoundImportedInstanceCallExpression {
                return BoundImportedInstanceCallExpression(
                    nil,
                    CaptureExpression(call.Receiver, prefix),
                    call.Method,
                    call.Type,
                    CaptureArguments(call.Arguments, prefix),
                    call.ArgumentRefKinds,
                    call.TypeArgumentSymbols,
                    call.ConstrainedReceiverTypeParameter,
                    call.ConstrainedInterfaceType,
                    call.IsNonVirtualBaseCall
                )
            }
            default {
                throw InvalidOperationException("Unexpected deferred expression: ${expression.Kind}")
            }
        }
    }

    private func CaptureArguments(
        arguments ImmutableArray[BoundExpression],
        prefix ImmutableArray[BoundStatement].Builder
    ) ImmutableArray[BoundExpression] {
        if arguments.IsEmpty {
            return arguments
        }
        let capturedArguments = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
        for argument in arguments {
            capturedArguments.Add(CaptureExpression(argument, prefix))
        }
        return capturedArguments.ToImmutable()
    }

    // ADR-0030 / issue #1635: `defer` evaluates the call target eagerly (function value,
    // receiver, and arguments), then invokes it at scope exit. Spill the receiver/indirect
    // target the same way arguments are spilled, so reassigning it afterwards can't change
    // which value the deferred call runs against.
    private func CaptureExpression(
        expression BoundExpression,
        prefix ImmutableArray[BoundStatement].Builder
    ) BoundExpression {
        let variable = LocalVariableSymbol(
            "$$defer$$arg$$${binderCtx.DeferArgumentCounter++}",
            isReadOnly: true,
            expression.Type ?? TypeSymbol.Error
        )
        $scope.TryDeclareVariable(variable)
        prefix.Add(BoundVariableDeclaration(nil, variable, expression))
        return BoundVariableExpression(nil, variable)
    }

    private func BindGoStatement(syntax GoStatementSyntax) BoundStatement {
        // Issue #3304: the spawned call's result is discarded (ADR-0022), so
        // a void-returning operand is the natural goroutine shape — bind with
        // canBeVoid so GS0124 does not force `return 0` boilerplate onto
        // goroutine bodies. Non-call operands are still rejected below
        // (GS0137), and the emit path already wraps a non-Task operand in an
        // Action-shaped thunk whose body is an expression statement.
        var expression = bindExpression(syntax.Expression, true)
        if expression is BoundErrorExpression {
            return BoundExpressionStatement(syntax, expression)
        }
        // ADR-0174 D4/D5: the goroutine, not the spawning function, consumes
        // a suspending operand's ValueTask — unwrap the caller-side completion
        // (implicit await or root bridge) the call binder applied.
        if expression is BoundAwaitExpression awaited {
            expression = awaited.Expression
        } else if expression is BoundImportedCallExpression{Function: {Name: "Wait"}} bridge &&
            bridge
            .Function
            .ImportedClass
            .ClassType
            .FullName == "Gsharp.Concurrency.Blocking" &&
            bridge
            .Arguments
            .Length == 1 {
            expression = bridge.Arguments[0]
        }
        if !(expression is BoundCallExpression) &&
            !(expression is BoundIndirectCallExpression) &&
            !(expression is BoundUserInstanceCallExpression) &&
            !(expression is BoundImportedCallExpression) &&
            !(expression is BoundImportedInstanceCallExpression) &&
            !(expression is BoundBaseClassCallExpression) {
            Diagnostics.ReportGoOperandIsNotACall(syntax.Expression.Location)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        if !binderCtx.ChannelRuntime.IsAvailable {
            Diagnostics.ReportTargetFrameworkMemberUnavailable(
                syntax.Expression.Location,
                "Gsharp.Concurrency.GoroutineRuntime"
            )
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        // Copilot review of PR #4273 / issue #4271: a `go` statement's operand
        // is wrapped into a display-class closure by SynthesizeGoClosures at
        // EMIT time, entirely bypassing LambdaBinder's capture-legality
        // checks — so a goroutine capturing a ref/out/in PARAMETER (GS9010,
        // issue #4259) or a ref/var ref LOCAL alias (GS9011, issue #4271) was
        // neither rejected nor correctly implemented; the display class field
        // stores a by-value snapshot of the captured storage (see
        // GoCapturedVariableCollector's field-per-capture shape) and the
        // mutation through the ref/alias inside the goroutine body is
        // silently lost. Unlike issue #4222's per-suspension-point liveness
        // case, a goroutine body always runs concurrently with (and may
        // outlive) the launching statement — even wrapped in a `scope`, which
        // only joins the goroutine later, it never runs synchronously inline
        // — so this capture is always an escape; no confinement carve-out is
        // possible or needed. Compute the capture set on the SAME (shaped)
        // expression SynthesizeGoClosures will later capture from, so the
        // checked set and the actually-captured set can never drift apart.
        let shapedExpression = binderCtx.ChannelRuntime.ShapeGoOperand(expression)
        let goCaptured = GoCapturedVariableCollector.CollectCapturedVariables(shapedExpression)
        ClosureCaptureLegalityChecker.CheckCapturedVariables(goCaptured, Diagnostics, syntax.Expression.Location)
        let sink = if binderCtx.ScopeFrames.Count > 0 {
            BoundVariableExpression(nil, binderCtx.ScopeFrames.Peek())
        } else {
            default(BoundVariableExpression?)
        }
        let lexicalEnclosingType = function?.ReceiverType ?? function?.StaticOwnerType ?? function?.LexicalEnclosingType
        return BoundGoStatement(syntax, shapedExpression, sink, resultCell: nil, resultType: nil, lexicalEnclosingType)
    }

    private func BindChannelSendStatement(syntax ChannelSendStatementSyntax) BoundStatement {
        // ADR-0174 D1/D2: `ch <- v` lowers to ChannelOps.Send<T>(ch, v, default).
        // Any channel-shaped handle may be sent on except a receive-only
        // `in chan[T]` (GS0549) — this is what makes ownership checkable.
        var channel = bindExpression(syntax.Channel, false)
        if channel is BoundErrorExpression {
            return BoundExpressionStatement(syntax, channel)
        }
        // ADR-0186 §4: a send requires a non-null channel.
        channel = binderCtx.InsertPlatformCheck(channel, syntax.Channel.Location, "a channel send target")
        if !ChannelTypeSymbol.TryGetChannelShape(channel.Type, out var elementType, out var direction, out _) {
            Diagnostics.ReportSendTargetIsNotChannel(syntax.Channel.Location, channel.Type)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        if direction == ChannelDirection.In {
            Diagnostics.ReportSendOnReceiveOnlyChannel(syntax.LeftArrowToken.Location, channel.Type)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        let value = conversions.BindConversion(syntax.Value, elementType)
        if !binderCtx.ChannelRuntime.IsAvailable {
            Diagnostics.ReportTargetFrameworkMemberUnavailable(
                syntax.LeftArrowToken.Location,
                ChannelRuntimeBinder.ChanTypeName
            )
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        return binderCtx.ChannelRuntime.BindSend(
            syntax,
            channel,
            value,
            elementType,
            direction,
            binderCtx.AmbientContext()
        )
    }

    private func BindSelectStatement(syntax SelectStatementSyntax) BoundStatement {
        // Phase 5.6 / ADR-0022: select statement orchestrating channel ops.
        // ADR-0174 D2: arms accept any channel-shaped handle; the operand is
        // viewed through its `chan[T]` / `in chan[T]` / `out chan[T]` symbol so
        // the (wave-1, pre-D8) select emitter sees one representation.
        if syntax.Cases.Length == 0 {
            Diagnostics.ReportSelectWithNoCases(syntax.SelectKeyword.Location)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        let bound = ImmutableArray.CreateBuilder[BoundSelectCase]()
        var sawDefault = false
        // Issue #3501 A3: Go alignment — an unlabeled `break` inside a select
        // arm exits the SELECT (same frame shape as switch: null ContinueLabel
        // keeps `continue` bound to the enclosing loop).
        binderCtx.LabelCounter++
        let selectBreakLabel = BoundLabel("selectBreak${binderCtx.LabelCounter}")
        binderCtx.LoopStack.Push((nil, selectBreakLabel, nil))
        try {
            for caseSyntax in syntax.Cases {
                if caseSyntax.CaseKind == SelectCaseKind.Default {
                    if sawDefault {
                        Diagnostics.ReportSelectDuplicateDefault(caseSyntax.Keyword.Location)
                    }
                    sawDefault = true
                    let defaultBody = BindStatement(caseSyntax.Body)
                    bound.Add(
                        BoundSelectCase(
                            SelectCaseKind.Default,
                            channel: nil,
                            value: nil,
                            variable: nil,
                            Invariant.Required(defaultBody, "a select case has a bound body", expression: "defaultBody")
                        )
                    )
                    continue
                }
                if caseSyntax.CaseKind == SelectCaseKind.Cancelled {
                    // ADR-0174 D8: `case cancelled` has no operand — it observes the
                    // ambient context. Whether there is one to observe is settled by
                    // the suspension pass (GS0557), which knows which functions end
                    // up carrying a context.
                    let cancelledGuard = BindSelectArmGuard(caseSyntax)
                    let cancelledBody = BindStatement(caseSyntax.Body)
                    bound.Add(
                        BoundSelectCase(
                            SelectCaseKind.Cancelled,
                            channel: nil,
                            value: nil,
                            variable: nil,
                            cancelledGuard,
                            Invariant.Required(
                                cancelledBody,
                                "a cancelled select case has a bound body",
                                expression: "cancelledBody"
                            )
                        )
                    )
                    continue
                }
                if (caseSyntax.CaseKind is SelectCaseKind.AwaitBind or SelectCaseKind.AwaitDiscard) {
                    bound.Add(BindSelectAwaitCase(caseSyntax))
                    continue
                }
                // A send arm references a channel; a receive arm may reference
                // anything selectable (ADR-0174 D8/D9), which is how `case
                // <-after(d)` works without the library's timers pretending to be
                // channels.
                let channelSyntax = Invariant.Required(
                    caseSyntax.Channel,
                    "a non-default select case has a channel",
                    expression: "caseSyntax.Channel"
                )
                var channelExpr = bindExpression(channelSyntax, false)
                // ADR-0186 §4: a select case operates on a non-null channel.
                channelExpr = binderCtx.InsertPlatformCheck(
                    channelExpr,
                    channelSyntax.Location,
                    "a select case channel"
                )
                var chan_ ChannelTypeSymbol? = nil
                var selectableElement TypeSymbol? = nil
                if !(channelExpr is BoundErrorExpression) &&
                    caseSyntax.CaseKind != SelectCaseKind.Send &&
                    !ChannelTypeSymbol.TryGetChannelShape(channelExpr.Type, out _, out _, out _) &&
                    binderCtx
                    .ChannelRuntime
                    .IsAvailable &&
                    binderCtx
                    .ChannelRuntime
                    .TryGetSelectableElement(channelExpr.Type, out var selectable) {
                    selectableElement = selectable
                } else if !(channelExpr is BoundErrorExpression) && ChannelTypeSymbol.TryGetChannelShape(
                    channelExpr.Type,
                    out var armElement,
                    out var armDirection,
                    out _
                ) {
                    if caseSyntax.CaseKind == SelectCaseKind.Send && armDirection == ChannelDirection.In {
                        Diagnostics.ReportSendOnReceiveOnlyChannel(channelSyntax.Location, channelExpr.Type)
                    } else if caseSyntax.CaseKind != SelectCaseKind.Send && armDirection == ChannelDirection.Out {
                        Diagnostics.ReportReceiveFromSendOnlyChannel(channelSyntax.Location, channelExpr.Type)
                    } else {
                        chan_ = ChannelTypeSymbol.Get(armElement, armDirection)
                        if channelExpr.Type != chan_ {
                            channelExpr = BoundConversionExpression(nil, chan_, channelExpr)
                        }
                    }
                }
                if channelExpr is BoundErrorExpression || (chan_ == nil && selectableElement == nil) {
                    if chan_ == nil && !(channelExpr is BoundErrorExpression) && !ChannelTypeSymbol.TryGetChannelShape(
                        channelExpr.Type,
                        out _,
                        out _,
                        out _
                    ) {
                        if caseSyntax.CaseKind == SelectCaseKind.Send {
                            Diagnostics.ReportSendTargetIsNotChannel(channelSyntax.Location, channelExpr.Type)
                        } else {
                            Diagnostics.ReportReceiveOperandIsNotChannel(channelSyntax.Location, channelExpr.Type)
                        }
                    }
                    // Best-effort recover: bind the body anyway so further
                    // diagnostics surface.
                    let recoveredBody = BindStatement(caseSyntax.Body)
                    bound.Add(
                        BoundSelectCase(
                            caseSyntax.CaseKind,
                            channelExpr,
                            value: nil,
                            variable: nil,
                            Invariant.Required(
                                recoveredBody,
                                "a recovered select case has a bound body",
                                expression: "recoveredBody"
                            )
                        )
                    )
                    continue
                }
                var valueExpr BoundExpression? = nil
                var variable VariableSymbol? = nil
                var body BoundStatement
                // The guard is bound here, before a receive arm opens its scope, so
                // `case let v = <-ch when v > 0` cannot see `v`: the guard decides
                // whether the arm is registered at all, long before any value
                // arrives (ADR-0174 D8).
                let guard_ = BindSelectArmGuard(caseSyntax)
                if caseSyntax.CaseKind == SelectCaseKind.Send {
                    valueExpr = conversions.BindConversion(
                        Invariant.Required(
                            caseSyntax.Value,
                            "send select cases have a value expression",
                            expression: "caseSyntax.Value"
                        ),
                        Invariant.Required(chan_, "a send arm binds a channel, never a selectable", expression: "chan")
                            .ElementType
                    )
                    body = Invariant.Required(
                        BindStatement(caseSyntax.Body),
                        "a send select case has a bound body",
                        expression: "BindStatement(caseSyntax.Body)"
                    )
                } else if caseSyntax.CaseKind == SelectCaseKind.ReceiveBind {
                    // Introduce a scope so the bound variable is visible only inside
                    // the case body — matches `for v := range` lexical hygiene.
                    $scope = BoundScope($scope)
                    let identifier = Invariant.Required(
                        caseSyntax.Identifier,
                        "a receive-bind select case has an identifier",
                        expression: "caseSyntax.Identifier"
                    )
                    let bindElement = selectableElement ?? Invariant.Required(
                        chan_,
                        "a channel arm binds a channel type",
                        expression: "chan"
                    )
                        .ElementType
                    variable = LocalVariableSymbol(
                        identifier.ValueText,
                        isReadOnly: true,
                        bindElement,
                        declaringSyntax: identifier
                    )
                    if !$scope.TryDeclareVariable(variable) {
                        Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, identifier.ValueText)
                    }
                    body = Invariant.Required(
                        BindStatement(caseSyntax.Body),
                        "a receive-bind select case has a bound body",
                        expression: "BindStatement(caseSyntax.Body)"
                    )
                    $scope = $scope.Pop()
                } else {
                    // ReceiveDiscard
                    body = Invariant.Required(
                        BindStatement(caseSyntax.Body),
                        "a receive-discard select case has a bound body",
                        expression: "BindStatement(caseSyntax.Body)"
                    )
                }
                bound.Add(BoundSelectCase(caseSyntax.CaseKind, channelExpr, valueExpr, variable, guard_, body))
            }
            ReportChannelsTalkingToThemselves(bound)
        } finally {
            binderCtx.LoopStack.Pop()
        }
        let lowered = LowerSelectStatement(syntax, bound.ToImmutable())
        if binderCtx.UsedBreakLabels.Contains(selectBreakLabel) {
            return BoundBlockStatement(
                syntax,
                ImmutableArray.Create[BoundStatement](lowered, BoundLabelStatement(nil, selectBreakLabel))
            )
        }
        return lowered
    }

    // ADR-0174 D8: an arm's `when` guard. It is evaluated once, when the select
    // is entered, and a false guard keeps the arm out of the waiter entirely —
    // which is how G# spells Go's "set the channel to nil to disable the arm".
    private func BindSelectArmGuard(caseSyntax SelectCaseSyntax) BoundExpression? {
        if caseSyntax.Guard is not{} guardSyntax {
            return nil
        }
        let guard_ = bindExpression(guardSyntax, false)
        if guard_ is BoundErrorExpression {
            return nil
        }
        if guard_.Type != TypeSymbol.Bool {
            Diagnostics.ReportSelectArmGuardIsNotBoolean(guardSyntax.Location, guard_.Type)
            return nil
        }
        return guard_
    }

    // ADR-0174 D8: `case await task { … }` and `case let v = await task { … }`.
    // The arm joins the select through `SelectWaiter.AddTask`, so the operand
    // must be a `Task` or `Task[T]` — the only shape the waiter can attach a
    // claiming continuation to.
    private func BindSelectAwaitCase(caseSyntax SelectCaseSyntax) BoundSelectCase {
        let taskSyntax = Invariant.Required(
            caseSyntax.Channel,
            "an await select case has a task expression",
            expression: "caseSyntax.Channel"
        )
        var task = bindExpression(taskSyntax, false)
        // ADR-0186 §4: awaiting a task in a select arm requires a non-null
        // task, exactly as a plain `await` does (ExpressionBinder.BindAwaitExpression).
        task = binderCtx.InsertPlatformCheck(task, taskSyntax.Location, "an awaited select case task")
        let guard_ = BindSelectArmGuard(caseSyntax)
        var result TypeSymbol? = nil
        var recognized = task is BoundErrorExpression
        if !(task is BoundErrorExpression) {
            if task.Type?.ClrType?.FullName == "System.Threading.Tasks.Task" {
                recognized = true
            } else if AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(
                task.Type ?? TypeSymbol.Error,
                out var awaited,
                out var isValueTask
            ) &&
                !isValueTask {
                recognized = true
                result = awaited
            } else {
                Diagnostics.ReportTypeIsNotAwaitable(taskSyntax.Location, task.Type ?? TypeSymbol.Error)
            }
        }
        if !recognized || caseSyntax.CaseKind == SelectCaseKind.AwaitDiscard {
            let discardBody = BindStatement(caseSyntax.Body)
            return BoundSelectCase(
                caseSyntax.CaseKind,
                task,
                value: nil,
                variable: nil,
                guard_,
                Invariant.Required(discardBody, "an await select case has a bound body", expression: "discardBody")
            )
        }
        // `case let v = await task`: `v` is visible only inside the arm body,
        // exactly as a receive arm's binding is.
        $scope = BoundScope($scope)
        let identifier = Invariant.Required(
            caseSyntax.Identifier,
            "an await-bind select case has an identifier",
            expression: "caseSyntax.Identifier"
        )
        let variable = LocalVariableSymbol(
            identifier.ValueText,
            isReadOnly: true,
            result ?? TypeSymbol.Error,
            declaringSyntax: identifier
        )
        if !$scope.TryDeclareVariable(variable) {
            Diagnostics.ReportSymbolAlreadyDeclared(identifier.Location, identifier.ValueText)
        }
        let body = Invariant.Required(
            BindStatement(caseSyntax.Body),
            "an await-bind select case has a bound body",
            expression: "BindStatement(caseSyntax.Body)"
        )
        $scope = $scope.Pop()
        return BoundSelectCase(caseSyntax.CaseKind, task, value: nil, variable, guard_, body)
    }

    // ADR-0174 D8 / GS0564: a select that both sends to and receives from one
    // channel can complete by talking to itself, which is almost never what the
    // author meant. Reported on the second arm, once per channel.
    private func ReportChannelsTalkingToThemselves(cases ImmutableArray[BoundSelectCase].Builder) {
        let Unwrap = func (expression BoundExpression?) BoundExpression? {
            return if expression is BoundConversionExpression conversion {
                Unwrap(conversion.Expression)
            } else {
                expression
            }
        }
        let sent = Dictionary[VariableSymbol, int32]()
        let received = Dictionary[VariableSymbol, int32]()
        for var i = 0; i < cases.Count; i++ {
            // A receive operand is wrapped in the `in chan[T]` view conversion
            // and a send operand is not, so the comparison is on the symbol.
            if !(Unwrap(cases[i].Channel) is BoundVariableExpression{Variable: {} symbol} operand) {
                continue
            }
            let (mine, theirs) = if cases[i].CaseKind == SelectCaseKind.Send {
                (sent, received)
            } else {
                (received, sent)
            }
            if theirs.ContainsKey(symbol) {
                // The conversion wrapper carries no syntax, so the span comes
                // from the operand underneath it.
                Diagnostics.ReportSelectChannelSentAndReceived(
                    operand.Syntax?.Location ?? Invariant.Required(
                        cases[i].Body.Syntax,
                        "a select arm has a body",
                        expression: "cases[i].Body.Syntax"
                    )
                        .Location,
                    symbol.Name
                )
                theirs.Remove(symbol)
                continue
            }
            mine.TryAdd(symbol, i)
        }
    }

    /// ADR-0174 D8: lowers `select` onto the runtime's `SelectWaiter`.
    /// The operands are evaluated once, then every arm is registered on one
    /// waiter, which probes them in uniform-random order and — only if none is
    /// ready — parks on all of them at once. That replaces the old
    /// probe-in-source-order, `Task.WhenAny`, re-probe-the-winner shape,
    /// which was both unfair and unable to transfer a value atomically.
    /// @remarks The emitted shape is:
    /// ```
    /// let ch_i = <operand>                 // once, left to right
    /// var winner = -1; var again = true
    /// loop:
    /// let w = SelectWaiter.Rent(n, ctx)
    /// try {
    /// w.AddReceive[T](ch_i, i) / w.AddSend[T](ch_i, v_i, i)
    /// winner = w.Wait()                 // or w.TryNow() when a default arm exists
    /// again = w.NeedsReprobe            // a foreign arm lost its value to a thief
    /// if !again { v_i = w.TakeValue[T]() }
    /// } finally { w.Return() }
    /// if again goto loop
    /// if winner == i { body_i } … else { default body }
    /// ```
    /// `Wait` is the blocking form; inside a state machine the async
    /// lowering turns it into an awaited `WaitAsync`, exactly as it does
    /// for a scope's join, so a parked select holds no thread.
    /// @param syntax The select syntax.
    /// @param cases The bound arms.
    /// @returns The lowered statement.
    private func LowerSelectStatement(
        syntax SelectStatementSyntax,
        cases ImmutableArray[BoundSelectCase]
    ) BoundStatement {
        let ArmIs = func (winnerLocal VariableSymbol, arm int32) BoundExpression {
            return BoundBinaryExpression(
                nil,
                BoundVariableExpression(nil, winnerLocal),
                Invariant.Required(
                    BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                    "'==' is defined for int32",
                    expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                ),
                BoundLiteralExpression(nil, arm, TypeSymbol.Int32)
            )
        }
        if !EnsureChannelRuntimeForSelect(syntax) {
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        let runtime = binderCtx.ChannelRuntime
        let shapes = [cases.Length](Element TypeSymbol?, Direction ChannelDirection, Selectable bool)
        for var i = 0; i < cases.Length; i++ {
            if cases[i].IsDefault || cases[i].CaseKind == SelectCaseKind.Cancelled {
                continue
            }
            if cases[i].Channel is not{} channel {
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
            if (cases[i].CaseKind is SelectCaseKind.AwaitBind or SelectCaseKind.AwaitDiscard) {
                // The element is the task's result type, or null for a bare
                // `Task` whose completion carries no value.
                shapes[i] = (cases[i].Variable?.Type, ChannelDirection.In, false)
            } else if ChannelTypeSymbol.TryGetChannelShape(channel.Type, out var element, out var direction, out _) {
                shapes[i] = (element, direction, false)
            } else if runtime.TryGetSelectableElement(channel.Type, out var selectableElement) {
                // A receive arm over an `ISelectable[T]` — the library's timers
                // (ADR-0174 D9), which join a select without pretending to be
                // channels.
                shapes[i] = (selectableElement!!, ChannelDirection.In, true)
            } else {
                // A recovery arm: the diagnostic is already reported, and emit
                // never runs for a program that has one.
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
        }
        let id = Interlocked.Increment(&binderCtx.SyntheticLocalCounter)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        // The operands are evaluated once, left to right, before any arm is
        // attempted — re-evaluating a channel expression per probe would be
        // observable (D8 step 1).
        let channelLocals = [cases.Length]VariableSymbol?
        let valueLocals = [cases.Length]VariableSymbol?
        let guardLocals = [cases.Length]VariableSymbol?
        var armCount = 0
        for var i = 0; i < cases.Length; i++ {
            if cases[i].IsDefault {
                continue
            }
            armCount++
            if cases[i].Channel is {} channel {
                let channelLocal = LocalVariableSymbol("<select$$ch$$$id$$$i>", isReadOnly: true, channel.Type)
                $scope.TryDeclareVariable(channelLocal)
                channelLocals[i] = channelLocal
                statements.Add(BoundVariableDeclaration(nil, channelLocal, channel))
            }
            if cases[i].CaseKind == SelectCaseKind.Send {
                let value = Invariant.Required(
                    cases[i].Value,
                    "a send select arm binds a value",
                    expression: "cases[i].Value"
                )
                let valueLocal = LocalVariableSymbol("<select$$value$$$id$$$i>", isReadOnly: true, value.Type)
                $scope.TryDeclareVariable(valueLocal)
                valueLocals[i] = valueLocal
                statements.Add(BoundVariableDeclaration(nil, valueLocal, value))
            }
            // The guard is evaluated exactly once, here, outside the reprobe
            // loop: an arm's enablement cannot change under the select's feet.
            if cases[i].Guard is {} guard_ {
                let guardLocal = LocalVariableSymbol("<select$$guard$$$id$$$i>", isReadOnly: true, TypeSymbol.Bool)
                $scope.TryDeclareVariable(guardLocal)
                guardLocals[i] = guardLocal
                statements.Add(BoundVariableDeclaration(nil, guardLocal, guard_))
            }
        }
        let winner = LocalVariableSymbol("<select$$winner$$$id>", isReadOnly: false, TypeSymbol.Int32)
        $scope.TryDeclareVariable(winner)
        statements.Add(BoundVariableDeclaration(nil, winner, BoundLiteralExpression(nil, -1, TypeSymbol.Int32)))
        let again = LocalVariableSymbol("<select$$again$$$id>", isReadOnly: false, TypeSymbol.Bool)
        $scope.TryDeclareVariable(again)
        statements.Add(BoundVariableDeclaration(nil, again, BoundLiteralExpression(nil, true, TypeSymbol.Bool)))
        // A bound receive arm's variable is declared out here and assigned from
        // the waiter, so the arm body — which runs after the waiter is returned
        // — still sees it.
        for var i = 0; i < cases.Length; i++ {
            if cases[i].Variable is {} bindVariable {
                statements.Add(
                    BoundVariableDeclaration(nil, bindVariable, BoundDefaultExpression(nil, bindVariable.Type))
                )
            }
        }
        let hasDefault = cases.Any((c BoundSelectCase) -> c.IsDefault)
        let waiter = LocalVariableSymbol("<select$$waiter$$$id>", isReadOnly: true, runtime.SelectWaiterType)
        $scope.TryDeclareVariable(waiter)
        let attempt = ImmutableArray.CreateBuilder[BoundStatement]()
        for var i = 0; i < cases.Length; i++ {
            var register BoundExpression
            if cases[i].CaseKind == SelectCaseKind.Cancelled {
                register = runtime.BindSelectAddCancelled(waiter, cases[i].Body.Syntax?.Parent, i)
            } else if channelLocals[i] is not{} channelLocal {
                continue
            } else if (cases[i].CaseKind is SelectCaseKind.AwaitBind or SelectCaseKind.AwaitDiscard) {
                register = runtime.BindSelectAddTask(
                    waiter,
                    BoundVariableExpression(nil, channelLocal),
                    shapes[i].Element,
                    i
                )
            } else {
                let value = if valueLocals[i] is {} valueLocal {
                    BoundVariableExpression(nil, valueLocal)
                } else {
                    default(BoundVariableExpression?)
                }
                register = runtime.BindSelectAdd(
                    waiter,
                    BoundVariableExpression(nil, channelLocal),
                    value,
                    Invariant.Required(
                        shapes[i].Element,
                        "a channel arm has an element type",
                        expression: "shapes[i].Element"
                    ),
                    shapes[i].Direction,
                    i,
                    shapes[i].Selectable
                )
            }
            var registration BoundStatement = BoundExpressionStatement(nil, register)
            if guardLocals[i] is {} guardLocal {
                // A disabled arm is simply never registered, so it can never win
                // and its body is unreachable — the same shape as Go's nil
                // channel, without the nil.
                registration = BoundIfStatement(
                    nil,
                    BoundVariableExpression(nil, guardLocal),
                    registration,
                    elseStatement: nil
                )
            }
            attempt.Add(registration)
        }
        attempt.Add(
            BoundExpressionStatement(
                nil,
                BoundAssignmentExpression(
                    nil,
                    winner,
                    if hasDefault {
                        runtime.BindSelectTryNow(waiter)
                    } else {
                        runtime.BindSelectWait(waiter)
                    }
                )
            )
        )
        attempt.Add(
            BoundExpressionStatement(nil, BoundAssignmentExpression(nil, again, runtime.BindSelectNeedsReprobe(waiter)))
        )
        let takes = ImmutableArray.CreateBuilder[BoundStatement]()
        for var i = 0; i < cases.Length; i++ {
            if cases[i].Variable is not{} bindVariable {
                continue
            }
            takes.Add(
                BoundIfStatement(
                    nil,
                    ArmIs(winner, i),
                    BoundExpressionStatement(
                        nil,
                        BoundAssignmentExpression(
                            nil,
                            bindVariable,
                            runtime.BindSelectTakeValue(
                                waiter,
                                Invariant.Required(
                                    shapes[i].Element,
                                    "a binding arm has an element type",
                                    expression: "shapes[i].Element"
                                )
                            )
                        )
                    ),
                    elseStatement: nil
                )
            )
        }
        if takes.Count > 0 {
            attempt.Add(
                BoundIfStatement(
                    nil,
                    BoundUnaryExpression(
                        nil,
                        Invariant.Required(
                            BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool),
                            "'!' is defined for bool",
                            expression: "BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool)"
                        ),
                        BoundVariableExpression(nil, again)
                    ),
                    BoundBlockStatement(nil, takes.ToImmutable()),
                    elseStatement: nil
                )
            )
        }
        let loopLabel = BoundLabel("selectProbe$id")
        statements.Add(BoundLabelStatement(nil, loopLabel))
        statements.Add(
            BoundVariableDeclaration(nil, waiter, runtime.BindSelectRent(syntax, armCount, binderCtx.AmbientContext()))
        )
        statements.Add(
            BoundTryStatement(
                nil,
                BoundBlockStatement(nil, attempt.ToImmutable()),
                ImmutableArray[BoundCatchClause].Empty,
                BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundExpressionStatement(nil, runtime.BindSelectReturn(waiter))
                    )
                )
            )
        )
        statements.Add(
            BoundConditionalGotoStatement(nil, loopLabel, BoundVariableExpression(nil, again), jumpIfTrue: true)
        )
        // Dispatch, outside the waiter's lifetime: `winner` is the arm that
        // transferred, or -1 when a `default` arm exists and nothing was ready.
        var dispatch BoundStatement? = nil
        var needsElse = !hasDefault
        for var i = cases.Length - 1; i >= 0; i-- {
            if cases[i].IsDefault {
                dispatch = cases[i].Body
                continue
            }
            if needsElse {
                // Without a `default` arm the wait only returns once an arm has
                // transferred, so the last arm is unconditional. Saying so keeps
                // definite-return analysis exact: a select whose every arm
                // returns is a select that returns (issue #2890).
                dispatch = cases[i].Body
                needsElse = false
                continue
            }
            dispatch = BoundIfStatement(nil, ArmIs(winner, i), cases[i].Body, dispatch)
        }
        if dispatch != nil {
            statements.Add(dispatch)
        }
        return BoundBlockStatement(syntax, statements.ToImmutable())
    }

    private func EnsureChannelRuntimeForSelect(syntax SelectStatementSyntax) bool {
        if binderCtx.ChannelRuntime.IsAvailable {
            return true
        }
        Diagnostics.ReportTargetFrameworkMemberUnavailable(
            syntax.SelectKeyword.Location,
            "Gsharp.Concurrency.SelectWaiter"
        )
        return false
    }

    // ADR-0174 D15 / GS0569: reports every read of one of this block's
    // `async let` bindings that reached the bound tree. `await name` never
    // does — BindAwaitExpression replaces it with a read of the cell — so
    // anything left here is a use of a value that may not have arrived.
    private func ReportAsyncLetReadsWithoutAwait(body BoundStatement, cells List[AsyncLetVariableSymbol]) {
        if cells.Count == 0 {
            return
        }
        let walker = AsyncLetReadWalker(cells)
        walker.Visit(body)
        for (variable, location) in walker.Reads {
            Diagnostics.ReportAsyncLetReadWithoutAwait(location, variable.Name)
        }
    }

    private func BindScopeStatement(syntax ScopeStatementSyntax) BoundStatement {
        // ADR-0174 D5/D6: `scope { body }` lowers to
        //   let <frame> = ScopeFrame.Enter(ambient)
        //   let ctx = <frame>.Context
        //   var <ex> Exception = default
        //   try { body } catch (Exception <caught>) { <ex> = <caught> } finally { <frame>.Exit(<ex>) }
        // The frame is the completion sink every `go` in the body reports to;
        // Exit joins them, cancels siblings on the first failure, and throws per
        // the D6 precedence table (the body's exception unwrapped, or a
        // ScopeException). In a suspending body the async pipeline awaits
        // ExitAsync instead of blocking on Exit.
        if !binderCtx.ChannelRuntime.IsAvailable {
            Diagnostics.ReportTargetFrameworkMemberUnavailable(
                syntax.ScopeKeyword.Location,
                "Gsharp.Concurrency.ScopeFrame"
            )
            return BindErrorStatement()
        }
        let exceptionType TypeSymbol? = ResolveExceptionType()
        if exceptionType == nil {
            Diagnostics.ReportUndefinedType(syntax.ScopeKeyword.Location, "System.Exception")
            return BindErrorStatement()
        }
        let runtime = binderCtx.ChannelRuntime
        let id = Interlocked.Increment(&binderCtx.SyntheticLocalCounter)
        let frame = LocalVariableSymbol("<scope$$frame$$$id>", isReadOnly: true, runtime.ScopeFrameType)
        $scope.TryDeclareVariable(frame)
        let bodyException = LocalVariableSymbol("<scope$$ex$$$id>", isReadOnly: false, exceptionType)
        $scope.TryDeclareVariable(bodyException)
        // A nested scope's context is linked to the enclosing scope's `ctx` (ADR-0174 D6): cancelling the
        // outer block cancels the inner one, and `ctx.Parent` is the outer context.
        let ambient = if binderCtx.ScopeFrames.Count > 0 {
            runtime.BindScopeContext(binderCtx.ScopeFrames.Peek())
        } else {
            default(BoundExpression?)
        }
        $scope = BoundScope($scope)
        let contextToken = SyntaxToken(
            syntax.SyntaxTree,
            SyntaxKind.IdentifierToken,
            syntax.ScopeKeyword.Span.Start,
            "ctx",
            "ctx"
        )
        let context = bindLocalVariable(contextToken, true, runtime.ContextType)
        binderCtx.ScopeFrames.Push(frame)
        binderCtx.ScopeContexts.Push(context)
        let cells = List[AsyncLetVariableSymbol]()
        binderCtx.AsyncLetCells.Push(cells)
        var body BoundStatement
        try {
            body = Invariant.Required(
                BindStatement(syntax.Body),
                "a scope statement has a bound body",
                expression: "BindStatement(syntax.Body)"
            )
        } finally {
            binderCtx.AsyncLetCells.Pop()
            binderCtx.ScopeContexts.Pop()
            binderCtx.ScopeFrames.Pop()
        }
        // GS0569, the catch-all: `BindVariableReference` rejects a bare name,
        // but a receiver position (`a.ToString()`) resolves the symbol through
        // a different path. A read that survived into the bound tree is one
        // that was never spelled `await`.
        ReportAsyncLetReadsWithoutAwait(body, cells)
        // ADR-0174 D15: a binding nobody read still started work. The block
        // cancels and joins it at exit — the failure is not dropped — and says
        // so, because starting work only to cancel it is rarely intended.
        for cell in cells {
            if !cell.WasAwaited {
                Diagnostics.ReportAsyncLetNeverAwaited(
                    Invariant.Required(
                        cell.DeclaringSyntax,
                        "an async-let binding is declared by an identifier",
                        expression: "cell.DeclaringSyntax"
                    )
                        .Location,
                    cell.Name
                )
            }
        }
        $scope = $scope.Pop()
        let caught = LocalVariableSymbol("<scope$$caught$$$id>", isReadOnly: true, exceptionType)
        let catchBody = BoundBlockStatement(
            syntax,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(
                    syntax,
                    BoundAssignmentExpression(syntax, bodyException, BoundVariableExpression(syntax, caught))
                )
            )
        )
        let cleanup = ImmutableArray.CreateBuilder[BoundStatement]()
        for cell in cells {
            cleanup.Add(BoundExpressionStatement(syntax, runtime.BindAsyncLetCancelIfUnread(cell.Cell)))
        }
        cleanup.Add(BoundExpressionStatement(syntax, runtime.BindScopeExit(frame, bodyException)))
        let finallyBody = BoundBlockStatement(syntax, cleanup.ToImmutable())
        let tryStatement = BoundTryStatement(
            syntax,
            BoundBlockStatement(syntax, ImmutableArray.Create(body)),
            ImmutableArray.Create(BoundCatchClause(exceptionType, caught, catchBody, exitsThroughFinally: true)),
            finallyBody
        )
        return BoundBlockStatement(
            syntax,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(syntax, frame, runtime.BindScopeEnter(syntax, ambient)),
                BoundVariableDeclaration(syntax, context, runtime.BindScopeContext(frame)),
                BoundVariableDeclaration(syntax, bodyException, BoundDefaultExpression(syntax, exceptionType)),
                tryStatement
            )
        )
    }

    // ADR-0125 / issue #1026: binds a `fixed name *T = source { … }` pinning
    // statement. Pins a managed array (`[]T` → `&a[0]`) or string (→ char-data
    // pointer) for the duration of the block and binds an unmanaged pointer
    // `*T` into element 0. The pointer is a CLR pinned local at emit time.
    private func BindFixedStatement(syntax FixedStatementSyntax) BoundStatement {
        // A `fixed` statement yields a raw unmanaged pointer, so it is legal
        // only inside an `unsafe` context — consistent with ADR-0122's gating
        // (outside `unsafe`, `*T` would denote a *managed* by-ref, not a
        // pinnable pointer). Reject up front with GS0400.
        if !binderCtx.InUnsafeContext {
            Diagnostics.ReportFixedRequiresUnsafeContext(syntax.FixedKeyword.Location)
        }
        ReportSuspensionPointsInFixedBody(syntax.Body)
        // Open a fresh lexical scope: the pointer binding (and any inner
        // declarations) live only for the duration of the pinned block.
        $scope = BoundScope($scope)
        try {
            let pointerType = bindTypeClause(syntax.TypeClause)
            var source = bindExpression(syntax.PinnedSource, false)
            var fixedBufferSourceName string? = nil
            var pinKind FixedPinKind
            var elementType TypeSymbol
            var pinnedUnderlying TypeSymbol
            if ExpressionBinder.TryGetFixedBufferFieldAccess(source, out var bufferAccess) {
                // ADR-0125 amendment / issue #4378: a fixed-size buffer field
                // (ADR-0122 §10). Every reference to the field decays to a `*T`,
                // so recover the field access and pin its first element through
                // a `T& pinned` local — `ref recv.name.FixedElementField`, the
                // exact shape C# emits for `fixed (T* p = recv.name)` — which
                // keeps the containing storage pinned for the whole block.
                pinKind = FixedPinKind.FixedBuffer
                elementType = Invariant.Required(
                    bufferAccess.Field.FixedBufferElementType,
                    "a fixed-size buffer field records its element type",
                    expression: "bufferAccess.Field.FixedBufferElementType"
                )
                pinnedUnderlying = ByRefTypeSymbol.Get(elementType)
                fixedBufferSourceName = PointerTypeSymbol.Get(elementType).Name
                if !ExpressionBinder.IsLvalue(bufferAccess) {
                    // C# CS1708: the buffer belongs to a value (e.g. a call
                    // result), not a variable; there is no storage to pin.
                    Diagnostics.ReportFixedSourceNotPinnable(syntax.PinnedSource.Location, fixedBufferSourceName)
                } else if IsFixedVariable(bufferAccess) {
                    // C# CS0213: the storage cannot move, so there is nothing
                    // to pin; the buffer is already usable as a pointer.
                    Diagnostics.ReportFixedBufferAlreadyFixed(syntax.PinnedSource.Location, bufferAccess.Field.Name)
                }
                source = MakeFixedBufferElementReference(bufferAccess)
            } else if source.Type is SliceTypeSymbol sliceType {
                // Slice-pin form (`[]T`, the cs2gs mapping of C# `T[]`): the
                // CLR backing is a single-dimensional array `T[]`, so we pin
                // the array reference (`T[] pinned`) and derive `&a[0]` via
                // `ldelema` — exactly as C# does for `fixed (T* p = arr)`.
                pinKind = FixedPinKind.Array
                elementType = sliceType.ElementType
                pinnedUnderlying = sliceType
            } else if source.Type is ArrayTypeSymbol arrayType {
                // Fixed-size array form (`[N]T`), also CLR-backed by `T[]`.
                pinKind = FixedPinKind.Array
                elementType = arrayType.ElementType
                pinnedUnderlying = arrayType
            } else if source.Type == TypeSymbol.String {
                // String-pin form: pin the `string` reference itself
                // (`string pinned`) and derive the char-data pointer via
                // `RuntimeHelpers.OffsetToStringData` (the classic lowering),
                // which avoids a `modreq`-bearing `GetPinnableReference` ref.
                pinKind = FixedPinKind.String
                elementType = TypeSymbol.Char
                pinnedUnderlying = TypeSymbol.String
            } else if TryGetPinnableReference(source.Type, out _, out var pinnableElementClr) {
                // ADR-0125 / issue #1043: span-like pin form — any type exposing a
                // public instance `ref T GetPinnableReference()` (canonically
                // `System.Span[T]` / `System.ReadOnlySpan[T]`). Pin the `T&`
                // returned by `GetPinnableReference()` into a `T& pinned` local and
                // derive the `*T` via `conv.u`, mirroring C# `fixed (T* p = span)`.
                // `ReadOnlySpan[T].GetPinnableReference()` returns `ref readonly T`
                // (a `modreq(InAttribute)` ref-return); the method-reference
                // encoder reproduces that modreq (see EncodeReturnClr).
                pinKind = FixedPinKind.PinnableReference
                elementType = ResolvePinnableElementType(
                    source.Type,
                    Invariant.Required(
                        pinnableElementClr,
                        "a successful pinnable lookup has an element type",
                        expression: "pinnableElementClr"
                    )
                )
                pinnedUnderlying = ByRefTypeSymbol.Get(elementType)
            } else {
                Diagnostics.ReportFixedSourceNotPinnable(syntax.PinnedSource.Location, source.Type?.Name ?? "?")
                let errorPointerType = if pointerType is PointerTypeSymbol {
                    pointerType
                } else {
                    cast[TypeSymbol](PointerTypeSymbol.Get(TypeSymbol.UInt8))
                }
                let errorPointer = bindLocalVariable(syntax.Identifier, true, errorPointerType)
                let errorBody = Invariant.Required(
                    BindStatement(syntax.Body),
                    "a fixed statement has a bound body",
                    expression: "BindStatement(syntax.Body)"
                )
                return BoundFixedStatement(
                    syntax,
                    FixedPinKind.Array,
                    LocalVariableSymbol("$$pin$$error", isReadOnly: false, TypeSymbol.Error),
                    errorPointer,
                    source,
                    errorBody
                )
            }
            // The declared pointer's pointee must match the buffer's element
            // type. `char`/`uint16` are interchangeable for the string form
            // (both are 16-bit), matching C#'s `char*`. On mismatch, fall back
            // to the buffer's element type and report it as not pinnable.
            var resolvedElementType = elementType
            if pointerType is PointerTypeSymbol declaredPtr && declaredPtr.PointeeType?.ClrType != nil {
                let declaredPointee = declaredPtr.PointeeType
                let matches = elementType.ClrType != nil &&
                    (
                    declaredPointee.ClrType.IsSameAs(elementType.ClrType) ||
                        (pinKind == FixedPinKind.String && declaredPointee.ClrType.IsSameAs(typeof(uint16)))
                )
                if matches {
                    resolvedElementType = declaredPointee
                } else {
                    Diagnostics.ReportFixedSourceNotPinnable(
                        syntax.PinnedSource.Location,
                        fixedBufferSourceName ?? source.Type?.Name ?? "?"
                    )
                }
            }
            let pointerVariable = bindLocalVariable(syntax.Identifier, true, PointerTypeSymbol.Get(resolvedElementType))
            // Synthetic pinned local — wrapped in a PinnedTypeSymbol so the
            // emitter sets the `pinned` flag on its local-signature slot.
            let pinnedVariable = LocalVariableSymbol(
                "$$pin$$${pointerVariable.Name}",
                isReadOnly: false,
                PinnedTypeSymbol(pinnedUnderlying)
            )
            // Span-like form only: a synthetic local holding the source value,
            // whose address (`ldloca`) feeds the `GetPinnableReference()` call.
            var sourceVariable VariableSymbol? = nil
            if pinKind == FixedPinKind.PinnableReference {
                sourceVariable = LocalVariableSymbol(
                    "$$pinsrc$$${pointerVariable.Name}",
                    isReadOnly: false,
                    Invariant.Required(source.Type, "a fixed source has a type", expression: "source.Type")
                )
            }
            let body = Invariant.Required(
                BindStatement(syntax.Body),
                "a fixed statement has a bound body",
                expression: "BindStatement(syntax.Body)"
            )
            return BoundFixedStatement(syntax, pinKind, pinnedVariable, pointerVariable, source, body, sourceVariable)
        } finally {
            $scope = $scope.Pop()
        }
    }

    private func ReportSuspensionPointsInFixedBody(node SyntaxNode?) {
        if node == nil ||
            node is FunctionLiteralExpressionSyntax ||
            node is LambdaExpressionSyntax ||
            node is FixedStatementSyntax {
            return
        }
        switch node {
            case _ is AwaitExpressionSyntax or _ is AwaitForRangeStatementSyntax or _ is AwaitUsingStatementSyntax {
                Diagnostics.ReportFixedStatementCannotSuspend(node.Location, "await")
            }
            case yieldStatement is YieldStatementSyntax {
                Diagnostics.ReportFixedStatementCannotSuspend(
                    yieldStatement.YieldKeyword.Location,
                    yieldStatement.YieldKeyword.Text
                )
            }
        }
        for child in node.GetChildren() {
            ReportSuspensionPointsInFixedBody(child)
        }
    }

    private func BindAwaitForRangeStatement(syntax AwaitForRangeStatementSyntax) BoundStatement {
        return BindAwaitForRangeStatementCore(syntax, labelName: nil, originatingSyntax: syntax)
    }

    private func BindAwaitForRangeStatementCore(
        syntax AwaitForRangeStatementSyntax,
        labelName string?,
        originatingSyntax SyntaxNode
    ) BoundStatement {
        // Phase 5.8 / ADR-0023: `await for v := range stream { … }`.
        // The stream operand must be an `IAsyncEnumerable[T]` (a CLR type
        // that exposes a `GetAsyncEnumerator` method). The value variable
        // is typed as the stream's element `T`. Issue #937: the loop body
        // is bound through BindLoopBody so that `break`, `continue`, and
        // labeled break/continue resolve to the loop's synthesized labels —
        // achieving parity with the synchronous `for … in` loop.
        var stream = bindExpression(syntax.Stream, false)
        if stream is BoundErrorExpression {
            return BoundExpressionStatement(syntax, stream)
        }
        // ADR-0186 §4: the asynchronous twin of the `for … in` source check
        // (StatementBinder.Loops). A nil oblivious stream otherwise fails
        // inside the lowered `GetAsyncEnumerator` call, unattributed.
        stream = binderCtx.InsertPlatformCheck(stream, syntax.Stream.Location, "an 'await for' source")
        if !MemberLookup.TryGetAsyncEnumerableElementType(stream.Type, out var elementType) {
            Diagnostics.ReportTypeIsNotAsyncEnumerable(syntax.Stream.Location, stream.Type ?? TypeSymbol.Error)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        $scope = BoundScope($scope)
        let sourceType = Invariant.Required(
            elementType,
            "an async enumerable has an element type",
            expression: "elementType"
        )
        var variable VariableSymbol
        var typedVariablePrelude BoundStatement? = nil
        if syntax.TypeClause == nil {
            variable = bindLocalVariable(syntax.Identifier, false, sourceType)
        } else {
            let declaredType = bindTypeClause(syntax.TypeClause) ?? TypeSymbol.Error
            variable = LocalVariableSymbol(
                "<awaitfor${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                isReadOnly: false,
                type: sourceType
            )
            let declaredVariable = bindLocalVariable(syntax.Identifier, false, declaredType)
            let convertedValue = conversions.BindConversion(
                syntax.TypeClause!!.Location,
                BoundVariableExpression(syntax, variable),
                declaredType,
                allowExplicit: true
            )
            typedVariablePrelude = BoundVariableDeclaration(syntax, declaredVariable, convertedValue)
        }
        var body = BindLoopBody(
            syntax.Body,
            labelName,
            out var breakLabel,
            out var continueLabel,
            iterationRunsUserCode: true
        )
        if typedVariablePrelude != nil {
            body = BoundBlockStatement(originatingSyntax, ImmutableArray.Create(typedVariablePrelude, body))
        }
        $scope = $scope.Pop()
        return BoundAwaitForRangeStatement(originatingSyntax, variable, stream, body, breakLabel, continueLabel)
    }

    private func BindYieldStatement(syntax YieldStatementSyntax) BoundStatement {
        // ADR-0040: `yield <expr>` — only valid in an iterator function.
        if function == nil || !isIteratorReturnType(function!!.Type) {
            Diagnostics.ReportYieldOutsideIteratorFunction(syntax.YieldKeyword.Location)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        // Issue #3501: `yield break` terminates the iterator. Bind it as the
        // bare return the iterator MoveNext builders already lower to a jump
        // to the shared end label (state = -1, return false) — both the sync
        // rewriter and the async-iterator rewriter document exactly this
        // meaning for an expressionless return inside an iterator body.
        if syntax.BreakKeyword != nil {
            return BoundReturnStatement(syntax, expression: nil)
        }
        let elementType TypeSymbol? = GetIteratorElementType(function!!.Type)
        let expressionSyntax = Invariant.Required(
            syntax.Expression,
            "a yield statement without a break keyword carries an expression",
            expression: "syntax.Expression"
        )
        var expression = bindExpression(expressionSyntax, false)
        if expression.Type != nil && elementType != nil && expression.Type != elementType {
            expression = conversions.BindConversion(expressionSyntax.Location, expression, elementType)
        }
        return BoundYieldStatement(syntax, expression)
    }

    private class AsyncLetReadWalker : BoundTreeWalker {
        private let cells List[AsyncLetVariableSymbol]

        init(cells List[AsyncLetVariableSymbol]) {
            Reads = List[(Variable AsyncLetVariableSymbol, Location TextLocation)]()
            this.cells = cells
        }

        prop Reads List[(Variable AsyncLetVariableSymbol, Location TextLocation)] {
            get;
        }

        override func VisitExpression(node BoundExpression?) {
            if node is BoundVariableExpression{Variable: AsyncLetVariableSymbol binding} read && cells.Contains(
                binding
            ) &&
                (read.Syntax?.Location ?? binding.DeclaringSyntax?.Location) is {} location {
                Reads.Add((binding, location))
            }
            base.VisitExpression(node)
        }
    }

    shared {
        /// Issue #3501 A3: prepends the arm's body-entry label — the target a
        /// `fallthrough` in the PREVIOUS arm jumps to — when one was
        /// requested; returns the body unchanged otherwise.
        private func PrependArmEntryLabel(body BoundStatement, entryLabel BoundLabel?) BoundStatement {
            if entryLabel == nil {
                return body
            }
            return BoundBlockStatement(
                body.Syntax,
                ImmutableArray.Create[BoundStatement](BoundLabelStatement(nil, entryLabel), body)
            )
        }

        /// ADR-0069 addendum / issue #712: a switch is "exhaustive enough" for
        /// post-switch narrowing when it has a default arm OR its declared
        /// arm set covers every input the discriminator can take. We
        /// conservatively require either a default/discard arm — anything
        /// else is treated as non-exhaustive and we skip the lift. The
        /// exhaustiveness analyzer already reports a separate diagnostic for
        /// truly-non-exhaustive switches; this check only guards the
        /// narrowing lift.
        private func SwitchHandlesAllValues(
            arms ImmutableArray[BoundPatternSwitchArm],
            discriminantType TypeSymbol
        ) bool {
            for arm in arms {
                if (arm.Pattern == nil || arm.Pattern is BoundDiscardPattern) && arm.Guard == nil {
                    return true
                }
            }
            // No default — we cannot prove the post-switch frame is safe.
            return false
        }

        /// ADR-0177 D: returns whether an unfiltered `catch ()`
        /// already catches everything a `catch ()` could,
        /// which is true when [`thrown`](paramref) is [`handler`](paramref) or
        /// derives from it. Interfaces are not walked: the CLR matches a handler by
        /// class hierarchy, not by implemented interface.
        /// @param thrown The exception type named by the later clause.
        /// @param handler The exception type caught by the earlier clause.
        /// @returns `true` when the later clause can never run.
        private func IsCaughtBy(thrown TypeSymbol, handler TypeSymbol) bool {
            for var type TypeSymbol? = thrown; type != nil; type = type!!.BaseType {
                if object.ReferenceEquals(type, handler) || (type.ClrType != nil && type.ClrType == handler.ClrType) {
                    return true
                }
            }
            return false
        }

        private func IsDeferableCall(expression BoundExpression) bool -> expression is BoundCallExpression ||
            expression is BoundIndirectCallExpression ||
            expression is BoundUserInstanceCallExpression ||
            expression is BoundImportedCallExpression ||
            expression is BoundImportedInstanceCallExpression

        // A ref/out/in argument is bound as the ADDRESS of its target storage —
        // a BoundAddressOfExpression or BoundConditionalAddressExpression — for
        // every deferable call kind (user function, imported function/method).
        // Detecting the argument shape directly (rather than only consulting
        // ArgumentRefKinds, which not every call kind historically carried) catches every
        // by-ref argument regardless of which call kind wraps it.
        private func HasByRefArgument(expression BoundExpression) bool {
            let arguments = switch expression {
                case call is BoundCallExpression: call.Arguments
                case call is BoundImportedCallExpression: call.Arguments
                case call is BoundUserInstanceCallExpression: call.Arguments
                case call is BoundImportedInstanceCallExpression: call.Arguments
                case call is BoundIndirectCallExpression: call.Arguments
                default: ImmutableArray[BoundExpression].Empty
            }
            for argument in arguments {
                if (argument is BoundAddressOfExpression or BoundConditionalAddressExpression) {
                    return true
                }
            }
            return false
        }

        // ADR-0125 amendment / issue #4378: builds the managed reference
        // `ref recv.name.FixedElementField` to a fixed-size buffer's first element
        // (the backing struct's single element field sits at offset 0). The emitter
        // stores it into the `T& pinned` local, which pins the buffer's containing
        // object for the duration of the `fixed` body.
        private func MakeFixedBufferElementReference(bufferAccess BoundFieldAccessExpression) BoundExpression {
            let backing = Invariant.Required(
                bufferAccess.Type as StructSymbol,
                "a fixed-size buffer field is typed as its synthesized backing struct",
                expression: "bufferAccess.Type as StructSymbol"
            )
            let elementField = backing.Fields.Single((f FieldSymbol) -> f.Name == "FixedElementField")
            let elementAccess = BoundFieldAccessExpression(nil, bufferAccess, backing, elementField)
            return BoundAddressOfExpression(bufferAccess.Syntax, elementAccess, unmanaged: false)
        }

        // ADR-0125 amendment / issue #4378: C#'s "fixed variable" classification
        // (C# spec §23.4), used to reject pinning a fixed-size buffer whose storage
        // cannot move (C# CS0213). Fixed: a by-value local or parameter, a
        // pointer dereference, and a field of a value-typed fixed variable.
        // Movable (and therefore pinnable): a struct receiver `this` (passed by
        // reference), a `ref`/`out`/`in` parameter or ref local, a field of a
        // reference-type object, an array element, and a static field. Applied to
        // the buffer field access itself, so a buffer declared directly on a class
        // instance classifies as movable through the reference-type receiver arm. Anything
        // not recognised is treated as movable — an unnecessary pin is sound,
        // whereas wrongly rejecting a movable variable would leave no way to pin it.
        private func IsFixedVariable(expression BoundExpression?) bool -> switch expression {
            case boundVariableExpression is BoundVariableExpression when boundVariableExpression.Variable is ParameterSymbol &&
                boundVariableExpression
                .Variable
                .IsReceiverParameter == true: false
            case BoundVariableExpression{Variable: LocalVariableSymbol local}: local.RefKind == RefKind.None &&
                !(local.Type is ByRefTypeSymbol)
            case BoundFieldAccessExpression{Receiver: {} receiver} when !Binder.IsReferenceTypeForConstraint(
                receiver.Type
            ): IsFixedVariable(receiver)
            case dereference is BoundDereferenceExpression: dereference.Operand.Type is PointerTypeSymbol
            default: false
        }

        // ADR-0125 / issue #1043: detect a span-like pin source — a type exposing a
        // public instance `ref T GetPinnableReference()` (canonically `System.Span[T]`
        // / `System.ReadOnlySpan[T]`). Returns the resolved method and the ref-return
        // element CLR type (`T`). Used to enable the `GetPinnableReference` pin kind.
        private func TryGetPinnableReference(
            sourceType TypeSymbol,
            out method MethodInfo?,
            out elementClrType Type?
        ) bool {
            method = nil
            elementClrType = nil
            let clrType Type? = sourceType?.ClrType
            if clrType == nil {
                return false
            }
            var found MethodInfo?
            try {
                found = clrType.GetMethod(
                    "GetPinnableReference",
                    BindingFlags.Public | BindingFlags.Instance,
                    binder: nil,
                    types: Type.EmptyTypes,
                    modifiers: nil
                )
            } catch (AmbiguousMatchException) {
                return false
            }
            if found == nil || !found.ReturnType.IsByRef {
                return false
            }
            method = found
            elementClrType = found.ReturnType.GetElementType()
            return elementClrType != nil
        }

        // Issue #2838: recover the SYMBOLIC element type of a span-like pin source.
        // `TryGetPinnableReference` resolves through `sourceType.ClrType`, which for
        // a `Span[T]` inside a generic method is the type-erased `Span<object>` — so
        // its ref-return element is `System.Object`, not `T`. Binding the pointer as
        // `*object` produced a `pinned object&` local and, because an erased pointee
        // is not recognized as a value type, an 8-byte pointer-arithmetic stride for
        // every instantiation. Re-resolve the method on the OPEN definition (whose
        // ref-return is `!0`) and map that back through the receiver's real type
        // arguments. Falls back to the CLR element type for non-generic and fully
        // closed sources, preserving existing behavior.
        private func ResolvePinnableElementType(sourceType TypeSymbol, pinnableElementClr Type) TypeSymbol {
            if sourceType is ImportedTypeSymbol{OpenDefinition: not nil} imported &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty {
                var openMethod MethodInfo? = nil
                try {
                    openMethod = imported.OpenDefinition!!.GetMethod(
                        "GetPinnableReference",
                        BindingFlags.Public | BindingFlags.Instance,
                        binder: nil,
                        types: Type.EmptyTypes,
                        modifiers: nil
                    )
                } catch (AmbiguousMatchException) {
                    openMethod = nil
                }
                if openMethod?.ReturnType.IsByRef == true && MemberLookup.GetClrOpenMethodReturnTypeSymbol(
                    openMethod!!,
                    imported.OpenDefinition,
                    imported.TypeArguments
                ) is ByRefTypeSymbol pinned {
                    return pinned.PointeeType
                }
            }
            // The pinned element only types the pinned pointer local.
            return TypeSymbol.FromClrTypeWithoutNullability(pinnableElementClr, NullabilityFreeReason.EmitShape)
        }
    }
}
