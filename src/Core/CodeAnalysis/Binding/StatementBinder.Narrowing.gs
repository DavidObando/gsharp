// <copyright file="StatementBinder.Narrowing.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System.Threading

internal partial class StatementBinder {
    private let externalCallableAliases HashSet[VariableSymbol] = HashSet[VariableSymbol]()
    private let pendingStatementEffects Dictionary[
        BoundStatement,
        (Aliases HashSet[VariableSymbol], Summary AssignedRootsCollector)
    ] = Dictionary[BoundStatement, (Aliases HashSet[VariableSymbol], Summary AssignedRootsCollector)](
        ReferenceEqualityComparer.Instance
    )
    // Alias-independent records survive consumption and compose enclosing statements without another subtree walk.
    private let composedStatementEffects Dictionary[BoundStatement, StatementEffects] = Dictionary[
        BoundStatement,
        StatementEffects
    ](ReferenceEqualityComparer.Instance)
    // Member-mutation facts are a pure function of a statement's syntax.
    private let memberMutationBySyntax Dictionary[SyntaxNode, bool] = Dictionary[SyntaxNode, bool]()
    // ADR-0208 R18: reused for each condition; read only before the branches are bound.
    private var conditionRemovedFacts Dictionary[AccessPath, TypeSymbol]?
    private var activeConditionRemovedFacts Dictionary[AccessPath, TypeSymbol]?
    private var lastConditionWhenTrueAliases HashSet[VariableSymbol]?
    private var lastConditionWhenFalseAliases HashSet[VariableSymbol]?
    // ADR-0208 R18 (#5534, #5654): the facts that the conditions and statements in the then-branch being bound
    // removed, so the sibling else-branch can be bound without them. `nil` outside such a branch.
    private var conditionKillJournal List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]?
    private let branchyArgumentEntries Dictionary[
        SyntaxNode,
        (
            EntryFrames[](Frame NarrowingFrame, Entries NarrowingFrameSnapshot),
            EntryAliases HashSet[VariableSymbol],
            ExitFrames[](Frame NarrowingFrame, Entries NarrowingFrameSnapshot),
            ExitAliases HashSet[VariableSymbol]
        )
    ] = Dictionary[
        SyntaxNode,
        (
            EntryFrames[](Frame NarrowingFrame, Entries NarrowingFrameSnapshot),
            EntryAliases HashSet[VariableSymbol],
            ExitFrames[](Frame NarrowingFrame, Entries NarrowingFrameSnapshot),
            ExitAliases HashSet[VariableSymbol]
        )
    ]()
    // ADR-0208 R18: the callable aliases at each operand of the condition being classified (cref:AliasesAtTests);
    // `nil` otherwise, and the current aliases apply.
    private var testAliasesAt Dictionary[BoundExpression, HashSet[VariableSymbol]]?
    private var syncExpressionCallableAliases((IReadOnlyCollection[VariableSymbol]) -> void)?

    internal func SetSyncExpressionCallableAliases(callback((IReadOnlyCollection[VariableSymbol]) -> void)?) {
        syncExpressionCallableAliases = callback
    }

    internal func SyncExpressionCallableAliasesNow() {
        binderCtx.NarrowedVariables.SetExternalCallables(externalCallableAliases)
        syncExpressionCallableAliases?.Invoke(externalCallableAliases)
    }

    private let deferredArgumentSnapshots Dictionary[SyntaxNode, NarrowingBindSnapshot] = Dictionary[
        SyntaxNode,
        NarrowingBindSnapshot
    ]()
    private let initialArgumentBySyntax Dictionary[SyntaxNode, BoundExpression] = Dictionary[
        SyntaxNode,
        BoundExpression
    ]()
    private let syntaxByTrackedArgument Dictionary[BoundExpression, SyntaxNode] = Dictionary[
        BoundExpression,
        SyntaxNode
    ](ReferenceEqualityComparer.Instance)
    private let preConvertedEffectsBySyntax Dictionary[SyntaxNode, BoundExpression] = Dictionary[
        SyntaxNode,
        BoundExpression
    ]()
    private let verifyingArgumentSyntaxes HashSet[SyntaxNode] = HashSet[SyntaxNode](ReferenceEqualityComparer.Instance)
    private var pendingMultiAssignmentValueSyntax SyntaxNode?
    private var pendingMultiAssignmentValueSnapshot NarrowingBindSnapshot?
    private let expressionEntryAliases Dictionary[BoundExpression, HashSet[VariableSymbol]] = Dictionary[
        BoundExpression,
        HashSet[VariableSymbol]
    ](ReferenceEqualityComparer.Instance)
    private let appliedBinaryLefts HashSet[BoundBinaryExpression] = HashSet[BoundBinaryExpression](
        ReferenceEqualityComparer.Instance
    )
    private let appliedBinaryLeftsLog List[BoundBinaryExpression] = List[BoundBinaryExpression]()
    private let binaryRightEntryAliases Dictionary[BoundBinaryExpression, HashSet[VariableSymbol]] = Dictionary[
        BoundBinaryExpression,
        HashSet[VariableSymbol]
    ](ReferenceEqualityComparer.Instance)
    private let fullyAppliedSubExpressions HashSet[BoundExpression] = HashSet[BoundExpression](
        ReferenceEqualityComparer.Instance
    )
    private let fullyAppliedSubExpressionsLog List[BoundExpression] = List[BoundExpression]()
    private let fullyAppliedExitAliases Dictionary[BoundExpression, HashSet[VariableSymbol]] = Dictionary[
        BoundExpression,
        HashSet[VariableSymbol]
    ](ReferenceEqualityComparer.Instance)

    internal func RecordExpressionEntryAliases(expression BoundExpression?, entryAliases HashSet[VariableSymbol]?) {
        if expression == nil || entryAliases == nil {
            return
        }
        expressionEntryAliases[expression] = HashSet[VariableSymbol](entryAliases)
    }

    internal func RecordAppliedBinaryLeft(binary BoundBinaryExpression, rightEntryAliases HashSet[VariableSymbol]?) {
        if appliedBinaryLefts.Add(binary) {
            appliedBinaryLeftsLog.Add(binary)
            if rightEntryAliases != nil {
                binaryRightEntryAliases[binary] = HashSet[VariableSymbol](rightEntryAliases)
            }
        }
    }

    internal data struct NarrowingBindSnapshot(
        Frames[]?NarrowingFrameSnapshot?,
        Aliases[]?VariableSymbol,
        JournalEntries[]?(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol),
        AppliedBinaryLeftsCount int32 = 0,
        FullyAppliedCount int32 = 0,
        NonNullByRef[]?VariableSymbol = nil
    ) { }

    internal func CaptureNarrowingBindSnapshot() NarrowingBindSnapshot {
        var frames[]?NarrowingFrameSnapshot? = nil
        if HasAnyActiveNarrowings() {
            frames = [binderCtx.NarrowedVariables.Count]NarrowingFrameSnapshot?
            for var i = 0; i < binderCtx.NarrowedVariables.Count; i++ {
                let frame = binderCtx.NarrowedVariables[i]
                if frame.Count > 0 {
                    frames[i] = frame.SnapshotEntries()
                }
            }
        }
        let aliases = if externalCallableAliases.Count == 0 {
            default([]?VariableSymbol)
        } else {
            externalCallableAliases.ToArray()
        }
        let nonNullByRef = if binderCtx.NonNullByRefVariables.Count == 0 {
            default([]?VariableSymbol)
        } else {
            binderCtx.NonNullByRefVariables.ToArray()
        }
        let journalEntries = conditionKillJournal?.ToArray()
        return NarrowingBindSnapshot(
            frames,
            aliases,
            journalEntries,
            appliedBinaryLeftsLog.Count,
            fullyAppliedSubExpressionsLog.Count,
            nonNullByRef
        )
    }

    internal func RestoreNarrowingBindSnapshot(snapshot NarrowingBindSnapshot) {
        let count = binderCtx.NarrowedVariables.Count
        for var i = 0; i < count; i++ {
            let frame = binderCtx.NarrowedVariables[i]
            let savedFrame = if snapshot.Frames != nil && i < snapshot.Frames.Length {
                snapshot.Frames[i]
            } else {
                default(NarrowingFrameSnapshot?)
            }
            frame.RestoreTo(savedFrame)
        }
        externalCallableAliases.Clear()
        if snapshot.Aliases != nil {
            externalCallableAliases.UnionWith(snapshot.Aliases)
        }
        binderCtx.NonNullByRefVariables.Clear()
        if snapshot.NonNullByRef != nil {
            binderCtx.NonNullByRefVariables.UnionWith(snapshot.NonNullByRef)
        }
        SyncExpressionCallableAliasesNow()
        if conditionKillJournal is {} journal && snapshot.JournalEntries is {} entries {
            journal.Clear()
            for entry in entries {
                journal.Add(entry)
            }
        }
        while appliedBinaryLeftsLog.Count > snapshot.AppliedBinaryLeftsCount {
            let lastIdx = appliedBinaryLeftsLog.Count - 1
            let removed = appliedBinaryLeftsLog[lastIdx]
            appliedBinaryLeftsLog.RemoveAt(lastIdx)
            appliedBinaryLefts.Remove(removed)
            binaryRightEntryAliases.Remove(removed)
        }
        while fullyAppliedSubExpressionsLog.Count > snapshot.FullyAppliedCount {
            let lastIdx = fullyAppliedSubExpressionsLog.Count - 1
            let removed = fullyAppliedSubExpressionsLog[lastIdx]
            fullyAppliedSubExpressionsLog.RemoveAt(lastIdx)
            fullyAppliedSubExpressions.Remove(removed)
            fullyAppliedExitAliases.Remove(removed)
        }
    }

    internal func RecordDeferredArgumentSnapshot(syntax SyntaxNode) {
        if !HasAnyActiveNarrowings() && externalCallableAliases.Count == 0 && !deferredArgumentSnapshots.ContainsKey(
            syntax
        ) {
            return
        }
        let snapshot = CaptureNarrowingBindSnapshot()
        var current SyntaxNode? = syntax
        while current != nil {
            deferredArgumentSnapshots[current] = snapshot
            if current is ParenthesizedExpressionSyntax paren {
                current = paren.Expression
            } else {
                break
            }
        }
    }

    internal func RecordConvertedArgument(original BoundExpression?, converted BoundExpression?) {
        if original == nil || converted == nil || object.ReferenceEquals(original, converted) {
            return
        }
        if syntaxByTrackedArgument.TryGetValue(original, out var originSyntax) {
            syntaxByTrackedArgument[converted] = originSyntax
        }
    }

    internal func RebindDeferredArgumentWithSnapshot(syntax SyntaxNode, bind() -> BoundExpression) BoundExpression {
        if branchyArgumentEntries.ContainsKey(syntax) || !deferredArgumentSnapshots.TryGetValue(
            syntax,
            out var atArgument
        ) {
            let boundBranchy = bind()
            syntaxByTrackedArgument[boundBranchy] = syntax
            return boundBranchy
        }
        let afterArguments = CaptureNarrowingBindSnapshot()
        RestoreNarrowingBindSnapshot(atArgument)
        let bound = bind()
        syntaxByTrackedArgument[bound] = syntax
        ApplySubExpressionNarrowingEffectsCore(syntax, bound)
        let afterRebind = CaptureNarrowingBindSnapshot()
        RestoreNarrowingBindSnapshot(afterArguments)
        IntersectNarrowingWithSnapshot(afterRebind)
        return bound
    }

    internal func ApplyPendingMultiAssignmentValueSnapshot(syntax SyntaxNode) {
        if pendingMultiAssignmentValueSyntax != nil && object.ReferenceEquals(
            syntax,
            pendingMultiAssignmentValueSyntax
        ) &&
            pendingMultiAssignmentValueSnapshot is {} snapshot {
            pendingMultiAssignmentValueSyntax = nil
            pendingMultiAssignmentValueSnapshot = nil
            RestoreNarrowingBindSnapshot(snapshot)
        }
    }

    internal func JoinBranchNarrowingSnapshots(
        whenTrueType TypeSymbol?,
        afterWhenTrue NarrowingBindSnapshot,
        whenFalseType TypeSymbol?,
        afterWhenFalse NarrowingBindSnapshot
    ) {
        if whenTrueType == TypeSymbol.Never && whenFalseType != TypeSymbol.Never {
            RestoreNarrowingBindSnapshot(afterWhenFalse)
            return
        }
        if whenFalseType == TypeSymbol.Never && whenTrueType != TypeSymbol.Never {
            RestoreNarrowingBindSnapshot(afterWhenTrue)
            return
        }
        RestoreNarrowingBindSnapshot(afterWhenFalse)
        IntersectNarrowingWithSnapshot(afterWhenTrue)
    }

    internal func IntersectNarrowingWithSnapshot(other NarrowingBindSnapshot) {
        let count = binderCtx.NarrowedVariables.Count
        for var i = 0; i < count; i++ {
            let frame = binderCtx.NarrowedVariables[i]
            let otherFrame = if other.Frames != nil && i < other.Frames.Length {
                other.Frames[i]
            } else {
                default(NarrowingFrameSnapshot?)
            }
            frame.ForEachChangedKey(
                otherFrame,
                (
                    key AccessPath,
                    currentExists bool,
                    currentType TypeSymbol?,
                    otherExists bool,
                    otherType TypeSymbol?
                ) -> {
                    if currentExists &&
                        !IsNullableWidening(key, currentType!!) &&
                        (!otherExists || !object.Equals(currentType, otherType)) {
                        conditionKillJournal?.Add((frame, key, currentType!!))
                        frame.Remove(key)
                    } else if !currentExists && otherExists && IsNullableWidening(key, otherType!!) {
                        frame[key] = otherType!!
                    }
                }
            )
        }
        if externalCallableAliases.Count > 0 {
            if other.Aliases == nil {
                externalCallableAliases.Clear()
            } else {
                externalCallableAliases.IntersectWith(other.Aliases)
            }
            SyncExpressionCallableAliasesNow()
        }
        if binderCtx.NonNullByRefVariables.Count > 0 {
            if other.NonNullByRef == nil {
                binderCtx.NonNullByRefVariables.Clear()
            } else {
                binderCtx.NonNullByRefVariables.IntersectWith(other.NonNullByRef)
            }
        }
    }

    internal func IsolateExternalCallableAliases() HashSet[VariableSymbol] {
        let saved = HashSet[VariableSymbol](externalCallableAliases)
        externalCallableAliases.Clear()
        binderCtx.NarrowedVariables.SetExternalCallables(externalCallableAliases)
        return saved
    }

    internal func RestoreExternalCallableAliases(saved HashSet[VariableSymbol]) {
        externalCallableAliases.Clear()
        externalCallableAliases.UnionWith(saved)
        SyncExpressionCallableAliasesNow()
    }

    internal func SetExternalCallableAliasesFromExpression(aliases HashSet[VariableSymbol]) {
        externalCallableAliases.Clear()
        externalCallableAliases.UnionWith(aliases)
        binderCtx.NarrowedVariables.SetExternalCallables(externalCallableAliases)
    }

    private func CaptureExternalCallableAliases() HashSet[VariableSymbol] -> HashSet[VariableSymbol](
        externalCallableAliases
    )

    internal func CaptureExternalCallableAliasesForExpression() HashSet[VariableSymbol] -> HashSet[VariableSymbol](
        externalCallableAliases
    )

    internal func EvolveCallableAliases(operand BoundExpression, before HashSet[VariableSymbol]) HashSet[
        VariableSymbol
    ] -> AliasesAfter(operand, before)

    internal func ApplyExpressionEffects(
        bound BoundExpression,
        state Dictionary[AccessPath, TypeSymbol],
        beforeAliases HashSet[VariableSymbol],
        alreadyProcessed HashSet[BoundExpression]?,
        exitAliases Dictionary[BoundExpression, HashSet[VariableSymbol]]? = nil,
        commitProcessed bool = true
    ) HashSet[VariableSymbol] {
        if bound.Syntax is {} anchor {
            EnsureClosureAssignedNames(anchor)
        }
        let collector = NewCollector(nil, beforeAliases)
        collector.AlreadyProcessedExpressions = alreadyProcessed
        collector.ProcessedExpressionExitAliases = exitAliases
        collector.VisitExpression(bound)
        if commitProcessed && alreadyProcessed != nil {
            alreadyProcessed.UnionWith(collector.NewlyProcessedExpressions)
        }
        if state.Count > 0 {
            ClearAssignedRootsForConditionOperand(bound, state, collector)
        }
        let after = HashSet[VariableSymbol](collector.DefinitelyExternalFunctionValues)
        if collector.MayMutateAnyRootViaPointer {
            after.Clear()
        }
        RemoveCollectorFilterAffectedAliases(after, bound.Syntax, collector)
        return after
    }

    internal func RecordExpressionNarrowingKill(frame NarrowingFrame, path AccessPath, type TypeSymbol) {
        conditionKillJournal?.Add((frame, path, type))
        let removed = activeConditionRemovedFacts
        if removed != nil && !removed.ContainsKey(path) {
            removed[path] = type
        }
    }

    /// ADR-0208 R12 (#5171): creates an effect collector that decides storage sharing through
    /// (cref:MayShareStorage).
    private func NewCollector(
        assignmentPreservesNarrowing((BoundAssignmentExpression, TypeSymbol) -> bool)?,
        externalFunctionValues IEnumerable[VariableSymbol]? = nil,
        knownStatements Dictionary[BoundStatement, StatementEffects]? = nil
    ) AssignedRootsCollector -> AssignedRootsCollector(
        assignmentPreservesNarrowing,
        externalFunctionValues,
        (first VariableSymbol, second VariableSymbol) -> MayShareStorage(first, second),
        (variable VariableSymbol) -> NamesClosureAssignedStorage(variable),
        knownStatements
    )

    /// ADR-0208 R12 (#5171): removes the callable aliases that [`collector`](paramref) assigns, and
    /// those that share storage with an assigned variable.
    private func RemoveAssignedAliases(aliases HashSet[VariableSymbol], collector AssignedRootsCollector) {
        aliases.ExceptWith(collector.Roots)
        aliases.RemoveWhere((alias VariableSymbol) -> collector.SharesStorageWithAssignedRoot(alias))
    }

    /// ADR-0208 R12 (#5171): whether [`first`](paramref) and [`second`](paramref) may name one
    /// storage: the same variable, an overlapping `ref` alias chain, two external-storage aliases, or
    /// an external-storage alias and a root whose address the function takes or a closure assigns.
    private func MayShareStorage(first VariableSymbol, second VariableSymbol) bool {
        if SharesStorage(first, second) {
            return true
        }
        let firstEnd = AliasChain(first).Last()
        let secondEnd = AliasChain(second).Last()
        return (IsExternalStorageAlias(first) && MayBeReachedByAlias(secondEnd)) ||
            (IsExternalStorageAlias(second) && MayBeReachedByAlias(firstEnd))
    }

    // A caller can pass any mutable global by reference; an address-taken or closure-assigned root can be
    // reached through an alias as well.
    private func MayBeReachedByAlias(root VariableSymbol) bool -> (
        !(root is LocalVariableSymbol) && !(root is ParameterSymbol) && !root.IsReadOnly
    ) ||
        binderCtx.MayBeAssignedByClosure(root)

    /// ADR-0208 R12 (#5171): removes every narrowing whose root may share storage with
    /// [`root`](paramref).
    private func RemoveSharingStorage(state Dictionary[AccessPath, TypeSymbol], root VariableSymbol) {
        for key in state.Keys.Where((key AccessPath) -> MayShareStorage(key.Root, root)).ToArray() {
            state.Remove(key)
        }
    }

    private func RestoreJoinedExternalCallableAliases(
        left HashSet[VariableSymbol],
        right IReadOnlyCollection[VariableSymbol]
    ) {
        left.IntersectWith(right)
        RestoreExternalCallableAliases(left)
    }

    private func CaptureNonNullByRefVariables() HashSet[VariableSymbol] -> HashSet[VariableSymbol](
        binderCtx.NonNullByRefVariables
    )

    private func RestoreNonNullByRefVariables(saved IReadOnlyCollection[VariableSymbol]) {
        binderCtx.NonNullByRefVariables.Clear()
        binderCtx.NonNullByRefVariables.UnionWith(saved)
    }

    private func RestoreJoinedNonNullByRefVariables(
        left HashSet[VariableSymbol],
        right IReadOnlyCollection[VariableSymbol],
        leftCompletes bool = true,
        rightCompletes bool = true
    ) {
        if leftCompletes && rightCompletes {
            left.IntersectWith(right)
            RestoreNonNullByRefVariables(left)
        } else if leftCompletes {
            RestoreNonNullByRefVariables(left)
        } else if rightCompletes {
            RestoreNonNullByRefVariables(right)
        } else {
            left.IntersectWith(right)
            RestoreNonNullByRefVariables(left)
        }
    }

    /// If [`statement`](paramref) is a call expression statement whose
    /// called function carries `[MemberNotNull("_f", …)]`, narrows each
    /// named field (via its (cref:ImplicitFieldVariableSymbol)) to its
    /// underlying non-nullable type in [`frame`](paramref).
    private func ApplyMemberNotNullNarrowings(statement BoundStatement?, frame NarrowingFrame) {
        var statement = statement
        while statement is BoundBlockStatement labeledBlock &&
            labeledBlock.Syntax is LabeledStatementSyntax &&
            labeledBlock
            .Statements
            .Length == 2 &&
            labeledBlock.Statements[0] is BoundLabelStatement {
            statement = labeledBlock.Statements[1]
        }
        var callExpr BoundExpression? = nil
        if statement is BoundExpressionStatement exprStmt {
            callExpr = exprStmt.Expression
        }
        if callExpr == nil {
            return
        }
        var memberNames ImmutableArray[string]
        var receiver BoundExpression? = nil
        switch callExpr {
            case userCall is BoundCallExpression {
                if !KnownAttributes.TryGetMemberNotNullMembers(userCall.Function.Attributes, out memberNames) {
                    return
                }
            }
            case importedCall is BoundImportedCallExpression {
                if !ClrNullability.TryGetMemberNotNullMembers(importedCall.Function.Method, out memberNames) {
                    return
                }
            }
            case instanceCall is BoundImportedInstanceCallExpression {
                if !ClrNullability.TryGetMemberNotNullMembers(instanceCall.Method, out memberNames) {
                    return
                }
                receiver = instanceCall.Receiver
            }
            case userInstanceCall is BoundUserInstanceCallExpression {
                if !KnownAttributes.TryGetMemberNotNullMembers(userInstanceCall.Method.Attributes, out memberNames) {
                    return
                }
                receiver = userInstanceCall.Receiver
            }
            default {
                return
            }
        }
        for name in memberNames {
            NarrowFieldIfNullable(name, frame, receiver)
        }
    }

    /// Looks up [`fieldName`](paramref) in the current scope. If it
    /// resolves to an (cref:ImplicitFieldVariableSymbol) whose declared
    /// type is nullable, adds a narrowing entry to [`frame`](paramref)
    /// that maps the symbol to its underlying non-nullable type.
    private func NarrowFieldIfNullable(
        fieldName string,
        frame Dictionary[AccessPath, TypeSymbol],
        receiver BoundExpression? = nil
    ) {
        if $scope.TryLookupSymbol(fieldName) is ImplicitFieldVariableSymbol fieldVar &&
            (receiver == nil || TargetsImplicitThis(receiver, fieldVar)) &&
            fieldVar.Type is NullableTypeSymbol nullable {
            SetPersistentNarrowing(frame, fieldVar, nullable.UnderlyingType)
        }
    }

    private func NarrowFieldIfNullable(fieldName string, frame NarrowingFrame, receiver BoundExpression? = nil) {
        if $scope.TryLookupSymbol(fieldName) is ImplicitFieldVariableSymbol fieldVar &&
            (receiver == nil || TargetsImplicitThis(receiver, fieldVar)) &&
            fieldVar.Type is NullableTypeSymbol nullable {
            SetPersistentNarrowing(frame, fieldVar, nullable.UnderlyingType)
        }
    }

    private func SetPersistentNarrowing(frame NarrowingFrame, path AccessPath, narrowedType TypeSymbol) {
        frame[path] = narrowedType
    }

    private func SetPersistentNarrowing(
        frame Dictionary[AccessPath, TypeSymbol],
        path AccessPath,
        narrowedType TypeSymbol
    ) {
        frame[path] = narrowedType
    }

    private func InvalidateNarrowingsForAssignedVariables(
        statementSyntax SyntaxNode,
        boundStatement BoundStatement? = nil,
        removedFacts Dictionary[AccessPath, TypeSymbol]? = nil,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]? = nil
    ) {
        EnsureClosureAssignedNames(statementSyntax)
        // Issue #1639: `NarrowedVariables.Count == 0` never fires in practice —
        // `BindBlockStatements` pushes a (usually empty) memberNotNullFrame for
        // every block, so the list always has at least one entry once binding
        // is inside any block. The real fast-path question is whether any
        // active frame actually holds a narrowing; if none do, no walk of the
        // statement's syntax subtree can possibly invalidate anything, so skip
        // both walks (and their HashSet/List allocations) entirely.
        if !HasAnyActiveNarrowings() && binderCtx.NonNullByRefVariables.Count == 0 {
            return
        }
        // ADR-0069 addendum / issue #1180: member-path narrowings are far more
        // fragile than local narrowings. Any call could mutate a field reached
        // through the chain, and any member/index/indirect assignment could too,
        // so — matching the Kotlin guarantee that a smart cast only survives
        // when the compiler can prove the value is unchanged — we conservatively
        // drop EVERY member-bearing path when the statement contains a call or a
        // member-mutating assignment. Plain variable narrowings keep their
        // existing, more permissive invalidation (reassignment only).
        //
        // Issue #1639: both the assigned-name collection and the member-mutation
        // check used to walk the full statement syntax subtree separately.
        // Issue #5128: with a bound statement, the assigned roots come from the
        // statement effect summary, so the syntax walk only answers the
        // member-mutation question and caches that answer per statement.
        let assignedNames = HashSet[string]()
        // Issue #5640: for a `defer`, `boundStatement` is the prefix only. The deferred call in `statementSyntax` runs when the block exits.
        var dropAllMemberPaths = if boundStatement != nil {
            statementSyntax is not DeferStatementSyntax &&
                !IsPatternContainerSyntax(statementSyntax) &&
                SyntaxMayMutateMemberPaths(statementSyntax)
        } else {
            CollectAssignedNamesAndMemberMutation(statementSyntax, assignedNames)
        }
        // Issue #2943: use bound assignment targets when available so symbol
        // identity, not a same-named variable in an enclosing scope, decides
        // which root and member paths are invalidated. Special lowering paths
        // that invalidate before producing one bound statement retain the
        // syntax-name fallback.
        var assignedRoots HashSet[VariableSymbol]? = nil
        var anyRootAssigned = false
        var dropAllRoots = false
        var dropGlobalRoots = false
        var runsEscapedClosure = false
        var statementCollector AssignedRootsCollector? = nil
        if boundStatement != nil {
            let collector = GetStatementEffects(boundStatement, aliasesAtEntry ?? externalCallableAliases)
            statementCollector = collector
            // A property getter with user code is no call expression in the syntax.
            dropAllMemberPaths = dropAllMemberPaths || collector.MayMutateMemberPaths
            dropAllRoots = collector.MayMutateAnyRoot
            dropGlobalRoots = collector.MayMutateGlobalRoots
            runsEscapedClosure = collector.MayRunEscapedClosure
            // The summary is shared, so read it without adding roots to it.
            anyRootAssigned = collector.Roots.Count > 0
            for frame in binderCtx.NarrowedVariables {
                for path in frame.Keys {
                    if collector.AssignsRoot(path.Root) {
                        anyRootAssigned = true
                    }
                }
            }
            for variable in binderCtx.NonNullByRefVariables {
                if collector.AssignsRoot(variable) {
                    anyRootAssigned = true
                }
            }
        } else {
            assignedRoots = HashSet[VariableSymbol]()
            for name in assignedNames {
                if $scope.TryLookupSymbol(name) is VariableSymbol v {
                    assignedRoots.Add(v)
                }
            }
            anyRootAssigned = assignedRoots.Count > 0
        }
        // ADR-0208 R10 (#5168): a statement that runs user code or catches a replacement exception can
        // run after a filter of an enclosing try, so the filter writes join the statement effects.
        let filterWrites = if statementCollector != nil {
            EnclosingFilterWrites(statementSyntax, statementCollector)
        } else {
            default(List[(TryBlock SyntaxNode?, Names HashSet[string])]?)
        }
        if !anyRootAssigned &&
            !dropAllMemberPaths &&
            (statementCollector == nil || !statementCollector.MayMutateReferenceStorage) &&
            !dropAllRoots &&
            !dropGlobalRoots &&
            !runsEscapedClosure &&
            filterWrites == nil {
            return
        }
        // Issue #208: iterate ALL frames (not just the top) because the
        // memberNotNullFrame sits above the if-condition frames; dropping from
        // only the top would miss narrowings added by if-condition analysis.
        for var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i-- {
            let frame = binderCtx.NarrowedVariables[i]
            if frame.Count == 0 {
                continue
            }
            var toRemove List[AccessPath]? = nil
            for key in frame.Keys {
                let drop = (
                    filterWrites != nil &&
                        (FilterWritesVariable(filterWrites, key.Root) || MayBeMutatedByUnknownCallable(key))
                ) ||
                    (
                    if statementCollector != nil {
                        StatementKillsPath(
                            statementCollector,
                            key,
                            dropAllMemberPaths,
                            statementCollector.MayWriteStorageOf(key)
                        )
                    } else {
                        assignedRoots!!.Any(
                            (assigned VariableSymbol) -> object.ReferenceEquals(assigned, key.Root) ||
                                MayShareStorage(assigned, key.Root)
                        ) ||
                            DropsOnMemberMutation(key, dropAllMemberPaths, dropAllMemberPaths)
                    }
                )
                if drop &&
                    (
                    !IsNullableWidening(key, frame[key]) ||
                        StatementDischargesNullableWidening(boundStatement, key, frame[key])
                ) {
                    (
                        (
                            if toRemove == nil {
                                (toRemove = List[AccessPath]())
                            } else {
                                toRemove
                            }
                        )!!
                    ).Add(key)
                }
            }
            if toRemove != nil {
                let targetRemovedFacts = removedFacts ?? activeConditionRemovedFacts
                for key in toRemove {
                    // The frames are visited innermost first, so the recorded type is the one a read saw.
                    if targetRemovedFacts != nil && !targetRemovedFacts.ContainsKey(key) {
                        targetRemovedFacts[key] = frame[key]
                    }
                    conditionKillJournal?.Add((frame, key, frame[key]))
                    frame.Remove(key)
                }
            }
        }
        // Issue #4454: invalidate non-null by-ref local facts on any statement that
        // may write a nullable value to the local, while keeping a local passed only
        // to a non-null `ref T` or `out T` parameter. Compound statements without
        // user gotos/labels already updated and joined `NonNullByRefVariables` per branch.
        if binderCtx
            .NonNullByRefVariables
            .Count > 0 &&
            !(
            filterWrites == nil &&
                boundStatement is BoundIfStatement or
                BoundPatternSwitchStatement or
                BoundTryStatement or
                BoundBlockStatement{Syntax: BlockStatementSyntax or IfStatementSyntax} &&
                !ContainsUserGotoOrLabel(boundStatement)
        ) {
            for variable in binderCtx.NonNullByRefVariables.ToArray() {
                if boundStatement is BoundExpressionStatement callStmt &&
                    CallPreservesNonNullByRefVariable(callStmt.Expression, variable) &&
                    (statementCollector == nil || !statementCollector.MayMutateAnyRoot) {
                    continue
                }
                let varPath = AccessPath.ForVariable(variable)
                let killed = (filterWrites != nil && FilterWritesVariable(filterWrites, variable)) ||
                    (dropGlobalRoots && variable is GlobalVariableSymbol && !variable.IsReadOnly) ||
                    (
                    if statementCollector != nil {
                        StatementKillsPath(
                            statementCollector,
                            varPath,
                            dropAllMemberPaths,
                            statementCollector.MayWriteStorageOf(varPath)
                        )
                    } else {
                        assignedRoots!!.Any(
                            (assigned VariableSymbol) -> object.ReferenceEquals(assigned, variable) ||
                                MayShareStorage(assigned, variable)
                        )
                    }
                )
                if killed {
                    binderCtx.NonNullByRefVariables.Remove(variable)
                }
            }
        }
    }

    private func InvalidateNonNullByRefForEffects(
        effects AssignedRootsCollector,
        dropAllMemberPaths bool,
        filterWrites List[(TryBlock SyntaxNode?, Names HashSet[string])]? = nil
    ) {
        if binderCtx.NonNullByRefVariables.Count == 0 {
            return
        }
        for variable in binderCtx.NonNullByRefVariables.ToArray() {
            let varPath = AccessPath.ForVariable(variable)
            let killed = (filterWrites != nil && FilterWritesVariable(filterWrites, variable)) ||
                (effects.MayMutateGlobalRoots && variable is GlobalVariableSymbol && !variable.IsReadOnly) ||
                StatementKillsPath(effects, varPath, dropAllMemberPaths, effects.MayWriteStorageOf(varPath))
            if killed {
                binderCtx.NonNullByRefVariables.Remove(variable)
            }
        }
    }

    private func KillNonNullByRefExitEffects(
        statement BoundStatement,
        aliases IReadOnlyCollection[VariableSymbol],
        anchor SyntaxNode? = nil
    ) {
        if binderCtx.NonNullByRefVariables.Count == 0 {
            return
        }
        let effects = GetStatementEffects(statement, aliases)
        let syntax = anchor ?? statement.Syntax
        let filters = if syntax == nil {
            default(List[(TryBlock SyntaxNode?, Names HashSet[string])]?)
        } else {
            EnclosingFilterWrites(syntax, effects)
        }
        InvalidateNonNullByRefForEffects(effects, effects.MayMutateMemberPaths, filters)
    }

    // The writes that the filters of enclosing `try` statements make, when the statement
    // can run after one of them; otherwise `nil`.
    private func EnclosingFilterWrites(statementSyntax SyntaxNode, effects AssignedRootsCollector) List[
        (TryBlock SyntaxNode?, Names HashSet[string])
    ]? {
        if !effects.MayMutateMemberPaths && !effects.MayRunEscapedClosure && !effects.ContainsTry {
            return nil
        }
        let filters = CollectCatchFiltersAbove(statementSyntax)
        return if filters.Count > 0 {
            CollectEnclosingFilterWrites(filters)
        } else {
            default(List[(TryBlock SyntaxNode?, Names HashSet[string])]?)
        }
    }

    /// Issue #5000: returns a predicate that decides whether [`expression`](paramref)
    /// can reassign a variable or mutate its value-type contents.
    internal func CreateExpressionVariableMutationChecker(anchor SyntaxNode, expression BoundExpression)(
        VariableSymbol
    ) -> bool {
        var collector AssignedRootsCollector? = nil
        var dropAllMemberPaths = false
        var filterWrites List[(TryBlock SyntaxNode?, Names HashSet[string])]? = nil
        return func (variable VariableSymbol) bool {
            let strippedType = StripNullability(variable.Type) ?? variable.Type
            let isValueType = !Binder.IsReferenceTypeForConstraint(strippedType)
            if variable.IsReadOnly &&
                !isValueType &&
                !IsByReferenceRoot(variable) &&
                !IsExternalStorageAlias(variable) {
                return false
            }
            var effects = collector
            if effects == nil {
                EnsureClosureAssignedNames(anchor)
                effects = NewCollector(nil, nil)
                effects.VisitExpression(expression)
                collector = effects
                dropAllMemberPaths = (
                    expression.Syntax is {} exprSyntax &&
                        !IsPatternContainerSyntax(exprSyntax) &&
                        SyntaxMayMutateMemberPaths(exprSyntax)
                ) ||
                    effects.MayMutateMemberPaths
                filterWrites = EnclosingFilterWrites(anchor, effects)
            }
            let path = AccessPath.ForVariable(variable)
            return (
                filterWrites != nil &&
                    (FilterWritesVariable(filterWrites, variable) || MayBeMutatedByUnknownCallable(path))
            ) ||
                (
                (isValueType || IsExternalStorageAlias(variable) || IsByReferenceRoot(variable)) &&
                    (dropAllMemberPaths || effects.MayMutateReferenceStorage || effects.MayMutateGlobalRoots)
            ) ||
                StatementKillsPath(effects, path, dropAllMemberPaths, effects.MayMutateReferenceStorage)
        }
    }

    // The one rule for the facts that a statement kills: a root it assigns, a root
    // an unknown write reaches, a mutable global when it can write one, and every
    // member path when it can mutate one (ADR-0069 #1180, #2943).
    private func StatementKillsPath(
        effects AssignedRootsCollector,
        path AccessPath,
        dropAllMemberPaths bool,
        dropReferenceStorage bool
    ) bool -> MayBeMutatedByUnknownWrite(effects, path) ||
        (effects.MayMutateGlobalRoots && path.Root is GlobalVariableSymbol && !path.Root.IsReadOnly) ||
        effects.AssignsRoot(path.Root) ||
        DropsOnMemberMutation(path, dropAllMemberPaths || effects.ByReferenceWritesReach(path), dropReferenceStorage)

    private func UpdateExternalCallableAliases(
        statement BoundStatement,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]
    ) {
        var statement = statement
        var aliasesAtEntry = aliasesAtEntry
        while statement is BoundBlockStatement labeledBlock &&
            labeledBlock.Syntax is LabeledStatementSyntax &&
            labeledBlock
            .Statements
            .Length == 2 &&
            labeledBlock.Statements[0] is BoundLabelStatement {
            statement = labeledBlock.Statements[1]
            aliasesAtEntry = Array.Empty[VariableSymbol]()
        }
        let collector = GetStatementEffects(statement, aliasesAtEntry)
        pendingStatementEffects.Remove(statement)
        ApplyCallableAliasExitState(externalCallableAliases, statement, aliasesAtEntry, collector)
        // A filter of an enclosing try can run between any two statements of its protected block,
        // when a nested handler catches a replacement exception.
        RemoveCollectorFilterAffectedAliases(externalCallableAliases, statement.Syntax, collector)
        SyncExpressionCallableAliasesNow()
    }

    private func RemoveCollectorFilterAffectedAliases(
        aliases HashSet[VariableSymbol],
        syntax SyntaxNode?,
        collector AssignedRootsCollector
    ) {
        if aliases.Count == 0 || syntax == nil {
            if object.ReferenceEquals(aliases, externalCallableAliases) {
                SyncExpressionCallableAliasesNow()
            }
            return
        }
        let filters = if collector.MayMutateMemberPaths || collector.MayRunEscapedClosure || collector.ContainsTry {
            CollectCatchFiltersAbove(syntax)
        } else {
            List[ExpressionSyntax]()
        }
        filters.AddRange(collector.VisitedCatchFilters)
        if filters.Count > 0 {
            RemoveFilterAffectedAliases(aliases, filters)
        }
        if object.ReferenceEquals(aliases, externalCallableAliases) {
            SyncExpressionCallableAliasesNow()
        }
    }

    // Returns the effect summary of [`statement`](paramref) for the entry alias
    // set [`aliases`](paramref). The summary is a collector that has visited the
    // statement. Callers must treat it as read-only.
    private func GetStatementEffects(
        statement BoundStatement,
        aliases IReadOnlyCollection[VariableSymbol]
    ) AssignedRootsCollector {
        if pendingStatementEffects.TryGetValue(statement, out var recorded) && recorded.Aliases.SetEquals(aliases) {
            CompilationMeasurements.Count("narrowing.effect-reuses")
            return recorded.Summary
        }
        let collector = NewCollector(nil, aliases, composedStatementEffects)
        collector.MeasureStatementEffects = true
        collector.Visit(statement)
        CompilationMeasurements.Count("narrowing.effect-walks")
        pendingStatementEffects[statement] = (HashSet[VariableSymbol](aliases), collector)
        if collector.CanComposeRootEffects {
            composedStatementEffects[statement] = StatementEffects.Create(
                collector.Roots,
                Array.Empty[VariableSymbol](),
                false,
                false,
                false,
                false,
                false
            )
            CompilationMeasurements.Count("narrowing.effects-composed")
        }
        return collector
    }

    // Issue #5128: same member-mutation rule as CollectAssignedNamesAndMemberMutation,
    // without the name collection. The answer for a statement node is cached, so
    // an enclosing statement does not walk a nested statement again.
    private func SyntaxMayMutateMemberPaths(node SyntaxNode) bool {
        let cacheable = node is StatementSyntax
        if cacheable && memberMutationBySyntax.TryGetValue(node, out var cached) {
            return cached
        }
        var mayMutateMemberPaths = false
        switch node {
            // ADR-0208 R18 (#5534): creating a closure runs none of its body. A call of the closure is a call.
            case FunctionLiteralExpressionSyntax, LambdaExpressionSyntax {
                return false
            }
            case CallExpressionSyntax,
            MemberIndexAssignmentExpressionSyntax,
            IndexAssignmentExpressionSyntax,
            CompoundIndexAssignmentExpressionSyntax,
            IndirectAssignmentExpressionSyntax,
            IndirectCompoundAssignmentExpressionSyntax {
                mayMutateMemberPaths = true
            }
            case AssignmentExpressionSyntax, FieldAssignmentExpressionSyntax, MemberFieldAssignmentExpressionSyntax { }
            case coalescing is NullCoalescingAssignmentExpressionSyntax {
                mayMutateMemberPaths = coalescing.Target is not NameExpressionSyntax
            }
            // ADR-0208 R20 and R21 (#5832): an increment of a named member (`x.f++`) binds to a member write,
            // which the bound effects classify like `x.f = v`. Any other target keeps the syntax answer.
            case EventSubscriptionExpressionSyntax{IsIncrementDecrement: true} inc {
                mayMutateMemberPaths = inc.LeftHandSide is not NameExpressionSyntax &&
                    !(inc.LeftHandSide is AccessorExpressionSyntax{RightPart: NameExpressionSyntax})
            }
            case m is MultiAssignmentStatementSyntax {
                for t in m.Targets {
                    // Fresh locals do not mutate pre-existing storage.
                    if t is not NameExpressionSyntax && t is not MultiAssignmentDeclarationExpressionSyntax {
                        mayMutateMemberPaths = true
                    }
                }
            }
        }
        if !mayMutateMemberPaths {
            for child in node.GetChildren() {
                if SyntaxMayMutateMemberPaths(child) {
                    mayMutateMemberPaths = true
                    break
                }
            }
        }
        if cacheable {
            memberMutationBySyntax[node] = mayMutateMemberPaths
        }
        return mayMutateMemberPaths
    }

    private func ApplyCallableAliasExitState(
        aliases HashSet[VariableSymbol],
        statement BoundStatement,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol],
        collector AssignedRootsCollector
    ) {
        var statement = statement
        while statement is BoundBlockStatement labeledBlock &&
            labeledBlock.Syntax is LabeledStatementSyntax &&
            labeledBlock
            .Statements
            .Length == 2 &&
            labeledBlock.Statements[0] is BoundLabelStatement {
            statement = labeledBlock.Statements[1]
        }
        let directAssignment BoundAssignmentExpression? = (
            statement as BoundExpressionStatement
        )?.Expression as BoundAssignmentExpression
        let assignsExternalCallable = directAssignment != nil &&
            IsExternalCallableSource(directAssignment.Expression, aliasesAtEntry)
        if UsesJoinedCallableExitState(statement) {
            aliases.Clear()
            aliases.UnionWith(collector.DefinitelyExternalFunctionValues)
        } else {
            RemoveAssignedAliases(aliases, collector)
            // ADR-0208 R15 (#5502): a call can run an escaped closure that replaces a callable alias which a closure
            // assigns; the collector updates the alias state in evaluation order so a later assignment restores it.
            if collector.MayMutateAnyRoot || collector.MayRunEscapedClosure {
                aliases.IntersectWith(collector.DefinitelyExternalFunctionValues)
            }
        }
        if assignsExternalCallable {
            aliases.Add(
                Invariant.Required(
                    directAssignment,
                    "an external callable assignment has a target",
                    expression: "directAssignment"
                )
                    .Variable
            )
        }
        if statement is BoundVariableDeclaration declaration && collector.DefinitelyExternalFunctionValues.Contains(
            declaration.Variable
        ) {
            aliases.Add(declaration.Variable)
        }
    }

    private func UsesJoinedCallableExitState(statement BoundStatement) bool -> switch statement {
        case block is BoundBlockStatement: block.Syntax != nil && !ContainsUserGotoOrLabel(block)
        case exprStmt is BoundExpressionStatement: !ContainsUserGotoOrLabel(exprStmt)
        case _ is BoundIfStatement or
            _ is BoundTryStatement or
            _ is BoundPatternSwitchStatement or
            _ is BoundForInfiniteStatement or
            _ is BoundForEllipsisStatement or
            _ is BoundForRangeStatement or
            _ is BoundAwaitForRangeStatement: !ContainsUserLabel(statement)
        default: false
    }

    /// Issue #1639: returns whether any currently active narrowing frame holds
    /// at least one entry. Used as the fast-path guard before walking a
    /// statement's syntax subtree for invalidation purposes — a block's
    /// persistent `memberNotNullFrame` is pushed unconditionally (even
    /// when empty), so testing (cref:BinderContext.NarrowedVariables)
    /// for emptiness alone never short-circuits. Frame counts are typically
    /// shallow (bounded by nesting depth), so this scan is cheap relative to a
    /// syntax subtree walk.
    private func HasAnyActiveNarrowings() bool {
        if binderCtx.NonNullByRefVariables.Count > 0 {
            return true
        }
        for var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i-- {
            if binderCtx.NarrowedVariables[i].Count > 0 {
                return true
            }
        }
        return false
    }

    private func InvalidateInheritedNarrowings(invalidations IReadOnlyList[(FrameIndex int32, Path AccessPath)]) {
        for (frameIndex, path) in invalidations {
            binderCtx.NarrowedVariables[frameIndex].Remove(path)
        }
    }

    /// Issue #1123: assignment-based smart cast. When the bound statement is a
    /// plain `x = rhs` assignment whose target is a nullable flow-tracked
    /// variable and whose right-hand side is statically <em>non-nullable</em>
    /// value assignable to the local's underlying type, record a narrowing of
    /// `x` to that underlying non-nullable type in
    /// [`persistentFrame`](paramref). Like a normal-exit proof, the entry persists for the rest
    /// of the enclosing block (and into nested blocks) until
    /// (cref:InvalidateNarrowingsForAssignedVariables) clears it on a
    /// subsequent mutation. Called after invalidation so the fresh narrowing
    /// supersedes the clearing pass for this same statement.
    private func ApplyAssignmentNarrowing(
        statement BoundStatement?,
        persistentFrame NarrowingFrame,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]? = nil
    ) {
        var statement = statement
        while statement is BoundBlockStatement labeledBlock &&
            labeledBlock.Syntax is LabeledStatementSyntax &&
            labeledBlock
            .Statements
            .Length == 2 &&
            labeledBlock.Statements[0] is BoundLabelStatement {
            statement = labeledBlock.Statements[1]
        }
        if statement is BoundExpressionStatement{Expression: BoundAssignmentExpression assign} &&
            TryClassifyNonNullAssignment(assign, out var variable, out var underlying) {
            let narrowedVariable = Invariant.Required(
                variable,
                "a successful assignment narrowing has a variable",
                expression: "variable"
            )
            SetPersistentNarrowing(
                persistentFrame,
                narrowedVariable,
                Invariant.Required(
                    underlying,
                    "a successful assignment narrowing has an underlying type",
                    expression: "underlying"
                )
            )
        }
        if TryExtractNullCoalescingAssignmentFromStatement(statement, out var ncaAssign) &&
            ncaAssign != nil &&
            TryClassifyNonNullAssignment(ncaAssign, out var ncaVariable, out var ncaUnderlying) {
            SetPersistentNarrowing(
                persistentFrame,
                Invariant.Required(
                    ncaVariable,
                    "a successful assignment narrowing has a variable",
                    expression: "ncaVariable"
                ),
                Invariant.Required(
                    ncaUnderlying,
                    "a successful assignment narrowing has an underlying type",
                    expression: "ncaUnderlying"
                )
            )
        }
        if statement != nil && !ContainsUserLabel(statement) {
            let expr BoundExpression? = switch statement {
                case exprStmt is BoundExpressionStatement: exprStmt.Expression
                case varDecl is BoundVariableDeclaration: varDecl.Initializer
                default: default(BoundExpression?)
            }
            if expr != nil &&
                TryClassifyNullCoalescingExpressionNonNullAssignments(expr, aliasesAtEntry) is {} narrowed {
                for kv in narrowed {
                    SetPersistentNarrowing(persistentFrame, kv.Key, kv.Value)
                }
            } else if statement is BoundBlockStatement{
                Syntax: ExpressionStatementSyntax{Expression: NullCoalescingAssignmentExpressionSyntax}
            } ncaBlock &&
                TryClassifyNullCoalescingBlockStatementNonNullAssignments(
                ncaBlock,
                aliasesAtEntry
            ) is {} blockNarrowed {
                for kv in blockNarrowed {
                    SetPersistentNarrowing(persistentFrame, kv.Key, kv.Value)
                }
            }
        }
        if statement is BoundExpressionStatement expressionStatement &&
            TryClassifyNestedAssignmentNarrowings(expressionStatement.Expression, aliasesAtEntry) is {} assignments {
            for entry in assignments {
                SetPersistentNarrowing(persistentFrame, entry.Key, entry.Value)
            }
        }
        if statement is BoundExpressionStatement outCallStmt && !ContainsUserLabel(outCallStmt) {
            CollectNonNullOutCallVariables(outCallStmt.Expression, binderCtx.NonNullByRefVariables)
        }
    }

    private func CallPreservesNonNullByRefVariable(expr BoundExpression, target VariableSymbol) bool {
        if !SmartCastStability.IsAssignmentNarrowingRoot(target) ||
            target.Type is not NullableTypeSymbol nullable ||
            !IsReferenceLikeType(nullable.UnderlyingType) {
            return false
        }
        let underlying = nullable.UnderlyingType
        switch expr {
            case call is BoundCallExpression {
                return UserCallPreservesNonNullByRefVariable(
                    call.Function.Parameters,
                    call.Arguments,
                    0,
                    target,
                    underlying
                )
            }
            case uic is BoundUserInstanceCallExpression {
                let offset = if uic.Method.Parameters.Length == uic.Arguments.Length + 1 {
                    1
                } else {
                    0
                }
                return UserCallPreservesNonNullByRefVariable(
                    uic.Method.Parameters,
                    uic.Arguments,
                    offset,
                    target,
                    underlying
                )
            }
            case ctorCall is BoundConstructorCallExpression {
                let parameters = ctorCall
                    .SelectedConstructor
                    ?.Parameters ??
                    ctorCall
                    .StructType
                    .PrimaryConstructorParameters
                return !parameters.IsDefaultOrEmpty &&
                    UserCallPreservesNonNullByRefVariable(parameters, ctorCall.Arguments, 0, target, underlying)
            }
            default {
                return false
            }
        }
    }

    private func UserCallPreservesNonNullByRefVariable(
        parameters ImmutableArray[ParameterSymbol],
        arguments ImmutableArray[BoundExpression],
        parameterOffset int32,
        target VariableSymbol,
        underlying TypeSymbol
    ) bool {
        var matched = false
        for var i = 0; i < arguments.Length && i + parameterOffset < parameters.Length; i++ {
            let param = parameters[i + parameterOffset]
            if param.RefKind != RefKind.Ref && param.RefKind != RefKind.Out {
                continue
            }
            if arguments[i] is BoundAddressOfExpression{IsReadOnly: false, Operand: BoundVariableExpression v} &&
                object
                .ReferenceEquals(v.Variable, target) {
                if HasUserNullabilityContract(param) ||
                    !OutputTypeDischargesNullableWidening(param.Type, underlying) ||
                    HasCompetingWritableReferenceArgument(arguments, i, target) {
                    return false
                }
                matched = true
            }
        }
        return matched
    }

    private func CollectNonNullOutCallVariables(expr BoundExpression, sink HashSet[VariableSymbol]) {
        switch expr {
            case call is BoundCallExpression {
                CollectUserOutCallVariables(call.Function.Parameters, call.Arguments, 0, sink)
            }
            case uic is BoundUserInstanceCallExpression {
                let offset = if uic.Method.Parameters.Length == uic.Arguments.Length + 1 {
                    1
                } else {
                    0
                }
                CollectUserOutCallVariables(uic.Method.Parameters, uic.Arguments, offset, sink)
            }
            case ctorCall is BoundConstructorCallExpression {
                let parameters = ctorCall
                    .SelectedConstructor
                    ?.Parameters ??
                    ctorCall
                    .StructType
                    .PrimaryConstructorParameters
                if !parameters.IsDefaultOrEmpty {
                    CollectUserOutCallVariables(parameters, ctorCall.Arguments, 0, sink)
                }
            }
        }
    }

    private func CollectUserOutCallVariables(
        parameters ImmutableArray[ParameterSymbol],
        arguments ImmutableArray[BoundExpression],
        parameterOffset int32,
        sink HashSet[VariableSymbol]
    ) {
        for var i = 0; i < arguments.Length && i + parameterOffset < parameters.Length; i++ {
            let param = parameters[i + parameterOffset]
            if param.RefKind != RefKind.Out || HasUserNullabilityContract(param) {
                continue
            }
            if arguments[i] is BoundAddressOfExpression{
                IsReadOnly: false,
                Operand: BoundVariableExpression{Variable: var outVar}
            } &&
                SmartCastStability.IsAssignmentNarrowingRoot(outVar) &&
                outVar.Type is NullableTypeSymbol nullable &&
                IsReferenceLikeType(nullable.UnderlyingType) &&
                OutputTypeDischargesNullableWidening(param.Type, nullable.UnderlyingType) &&
                !HasCompetingWritableReferenceArgument(arguments, i, outVar) {
                sink.Add(outVar)
            }
        }
    }

    private func IsNonNullByRefInitializer(expression BoundExpression?, underlying TypeSymbol) bool {
        var current = expression
        while current is BoundConversionExpression conv {
            current = conv.Expression
        }
        if current == nil || current is BoundDefaultExpression || current is BoundErrorExpression {
            return false
        }
        if current is BoundConditionalExpression cond {
            return IsNonNullByRefInitializer(cond.WhenTrue, underlying) &&
                IsNonNullByRefInitializer(cond.WhenFalse, underlying)
        }
        if current is BoundBlockExpression block {
            return IsNonNullByRefInitializer(block.Expression, underlying)
        }
        if current.Type is PlatformTypeSymbol {
            return false
        }
        return AssignmentTypePreservesNarrowing(current.Type, underlying) ||
            NestedAssignmentPreservesNarrowing(current, underlying)
    }

    private func TryClassifyNestedAssignmentNarrowings(
        expression BoundExpression,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]? = nil
    ) Dictionary[AccessPath, TypeSymbol]? {
        var value = expression
        while value is BoundConversionExpression conversion {
            value = conversion.Expression
        }
        if value is BoundAssignmentExpression assignment {
            value = assignment.Expression
            while value is BoundConversionExpression conversion {
                value = conversion.Expression
            }
        }
        if value is not(
            BoundAssignmentExpression or
                BoundIndexAssignmentExpression or
                BoundClrIndexAssignmentExpression or
                BoundFieldAssignmentExpression or
                BoundPropertyAssignmentExpression or
                BoundClrPropertyAssignmentExpression or
                BoundBlockExpression
        ) ||
            ContainsUserLabel(expression) {
            return nil
        }
        // The operand transfer also applies setter effects after the assigned value.
        var entryAliases IReadOnlyCollection[VariableSymbol] = aliasesAtEntry ?? Array.Empty[VariableSymbol]()
        if expressionEntryAliases.TryGetValue(expression, out var recordedEntry) {
            entryAliases = recordedEntry
        }
        return TryClassifyConditionNonNullAssignments(expression, entryAliases)
    }

    /// Issue #4519 / ADR-0213 section 11: joins the current narrowing state with forward jumps that
    /// can reach [`labelName`](paramref).
    private func JoinForwardJumpsAtLabel(labelName string, fallthroughReachesLabel bool) IReadOnlyList[
        NarrowingJumpState
    ]? {
        let incomingSnapshots = binderCtx.NarrowingFlow.TakeJumps(labelName)
        if incomingSnapshots != nil {
            let activeFinallySet = HashSet[FinallyClauseSyntax](activeFinallyClauses)
            let activeCleanupSet = HashSet[BoundStatement](activeCleanupStatements)
            for var i = incomingSnapshots.Count - 1; i >= 0; i-- {
                if !ApplyExitedFinallyEffects(incomingSnapshots[i], activeFinallySet, activeCleanupSet) {
                    incomingSnapshots.RemoveAt(i)
                }
            }
            if incomingSnapshots.Count == 0 {
                return incomingSnapshots
            }
        }
        if !(incomingSnapshots != nil && incomingSnapshots.Count > 0) {
            return incomingSnapshots
        }
        ApplyIncomingJumpJoin(incomingSnapshots, fallthroughReachesLabel)
        return incomingSnapshots
    }

    private func ApplyIncomingJumpJoin(
        incomingSnapshots IReadOnlyList[NarrowingJumpState],
        fallthroughReachesTarget bool
    ) {
        JoinExternalCallableAliases(incomingSnapshots, fallthroughReachesTarget)
        binderCtx.NonNullByRefVariables.Clear()
        if !fallthroughReachesTarget {
            let commonIncoming = Dictionary[AccessPath, TypeSymbol]()
            let commonFrameIndices = Dictionary[AccessPath, int32]()
            for entry in incomingSnapshots[0].GetNarrowedVariablesSnapshot() {
                let incomingTypes = List[TypeSymbol]{entry.Value}
                for var i = 1; i < incomingSnapshots.Count; i++ {
                    if !incomingSnapshots[i].TryGetNarrowedVariable(entry.Key, out var incomingType) {
                        incomingTypes.Clear()
                        break
                    }
                    incomingTypes.Add(incomingType)
                }
                let commonType TypeSymbol? = FindCommonImplicitSupertype(entry.Key, incomingTypes)
                if commonType != nil {
                    commonIncoming.Add(entry.Key, commonType)
                    if incomingSnapshots[0].TryGetNarrowingFrameIndex(entry.Key, out var frameIndex) &&
                        incomingSnapshots
                        .All(
                        (snapshot NarrowingJumpState) -> snapshot.TryGetNarrowingFrameIndex(
                            entry.Key,
                            out var incomingFrame
                        ) &&
                            incomingFrame == frameIndex
                    ) {
                        commonFrameIndices.Add(entry.Key, frameIndex)
                    }
                }
            }
            for var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i-- {
                let frame = binderCtx.NarrowedVariables[i]
                for entry in frame {
                    conditionKillJournal?.Add((frame, entry.Key, entry.Value))
                }
                frame.Clear()
            }
            for entry in commonIncoming {
                let targetFrame = if commonFrameIndices.TryGetValue(entry.Key, out var frameIndex) &&
                    frameIndex < binderCtx
                    .NarrowedVariables
                    .Count {
                    binderCtx.NarrowedVariables[frameIndex]
                } else {
                    binderCtx.NarrowedVariables[binderCtx.NarrowedVariables.Count - 1]
                }
                targetFrame.Add(entry.Key, entry.Value)
            }
            return
        }
        let targetNarrowings = Dictionary[AccessPath, TypeSymbol]()
        for frame in binderCtx.NarrowedVariables {
            for entry in frame {
                targetNarrowings[entry.Key] = entry.Value
            }
        }
        let joinedTypes = Dictionary[AccessPath, TypeSymbol]()
        for entry in targetNarrowings {
            let types = List[TypeSymbol]{entry.Value}
            for snapshot in incomingSnapshots {
                if !snapshot.TryGetNarrowedVariable(entry.Key, out var sourceType) {
                    types.Clear()
                    break
                }
                types.Add(sourceType)
            }
            let commonType TypeSymbol? = FindCommonImplicitSupertype(entry.Key, types)
            if commonType != nil {
                joinedTypes.Add(entry.Key, commonType)
            }
        }
        for path in targetNarrowings.Keys {
            var targetFrameIndex = -1
            for var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i-- {
                let frame = binderCtx.NarrowedVariables[i]
                if frame.TryGetValue(path, out var removedType) {
                    if targetFrameIndex < 0 {
                        targetFrameIndex = i
                    }
                    conditionKillJournal?.Add((frame, path, removedType))
                }
                frame.Remove(path)
            }
            if targetFrameIndex >= 0 && joinedTypes.TryGetValue(path, out var joinedType) {
                binderCtx.NarrowedVariables[targetFrameIndex].Add(path, joinedType)
            }
        }
    }

    private func JoinExternalCallableAliases(
        incomingSnapshots IReadOnlyList[NarrowingJumpState],
        fallthroughReachesLabel bool
    ) {
        if !fallthroughReachesLabel {
            externalCallableAliases.Clear()
            externalCallableAliases.UnionWith(incomingSnapshots[0].ExternalCallableAliases)
        }
        for snapshot in incomingSnapshots {
            externalCallableAliases.IntersectWith(snapshot.ExternalCallableAliases)
        }
        SyncExpressionCallableAliasesNow()
    }

    private func ApplyExitedFinallyEffects(
        snapshot NarrowingJumpState,
        activeFinallySet HashSet[FinallyClauseSyntax],
        activeCleanupSet HashSet[BoundStatement]
    ) bool {
        for region in snapshot.ActiveCleanupRegions {
            var summary FinallyFlowSummary
            if region.FinallyClause is {} finallyClause {
                if activeFinallySet.Contains(finallyClause) || !boundFinallyBlocks.TryGetValue(
                    finallyClause,
                    out var finallyBlock
                ) {
                    continue
                }
                summary = CreateFinallyFlowSummary(finallyClause, finallyBlock, snapshot.ExternalCallableAliases)
            } else if region.CleanupStatement is {} cleanup {
                if activeCleanupSet.Contains(cleanup) {
                    continue
                }
                let mutations = NewCollector(AssignmentPreservesNarrowing, snapshot.ExternalCallableAliases)
                mutations.Visit(cleanup)
                summary = FinallyFlowSummary(
                    mutations,
                    ComputeCleanupFallthroughNonNull(cleanup, snapshot.ExternalCallableAliases)
                )
            } else {
                continue
            }
            if summary.NonNullOnNormalExit == nil {
                return false
            }
            ApplyFlowSummary(snapshot, summary)
        }
        return true
    }

    private func GetFinallyFlowSummary(
        finallyClause FinallyClauseSyntax,
        finallyBlock BoundStatement
    ) FinallyFlowSummary {
        if finallyFlowSummaries.TryGetValue(finallyBlock, out var summary) {
            return summary
        }
        summary = CreateFinallyFlowSummary(
            finallyClause,
            finallyBlock,
            finallyEntryExternalCallableAliases[finallyClause]
        )
        if speculativeReturnDepth > 0 {
            speculativeFinallySummaryLog.Add(finallyBlock)
        }
        finallyFlowSummaries.Add(finallyBlock, summary)
        return summary
    }

    private func CreateFinallyFlowSummary(
        finallyClause FinallyClauseSyntax,
        finallyBlock BoundStatement,
        callableAliases IReadOnlyCollection[VariableSymbol]
    ) FinallyFlowSummary {
        let mutations = NewCollector(AssignmentPreservesNarrowing, callableAliases)
        mutations.Visit(finallyBlock)
        let nonNullOnNormalExit = if !CanCompleteNormally(finallyBlock) {
            default(Dictionary[AccessPath, TypeSymbol]?)
        } else {
            (
                if ContainsUserGotoOrLabel(finallyClause.Body) {
                    Dictionary[AccessPath, TypeSymbol]()
                } else {
                    ComputeCleanupFallthroughNonNull(finallyBlock, callableAliases)
                }
            )
        }
        return FinallyFlowSummary(mutations, nonNullOnNormalExit)
    }

    private func CanCompleteNormally(statement BoundStatement) bool -> switch statement {
        case block is BoundBlockStatement: CanStatementListCompleteNormally(block.Statements)
        case expression is BoundExpressionStatement: !ExpressionAlwaysExits(expression.Expression)
        case BoundTryStatement{FinallyBlock: {} finallyBlock} when !CanCompleteNormally(finallyBlock): false
        case infiniteLoop is BoundForInfiniteStatement when IsSyntacticallyInfiniteLoop(
            infiniteLoop
        ): internallyReachableLoopExits.Contains(infiniteLoop.BreakLabel)
        default: !EndsInUnconditionalExit(statement)
    }

    // Callable-alias flow must also join a path that leaves through a goto
    // (a switch's own `break` reaches code after the switch), so a statement
    // that ends only in a goto still contributes its state; return/throw do
    // not (fail-safe).
    private func CanReachCallableJoin(statement BoundStatement) bool -> CanCompleteNormally(statement) ||
        (EndsInUnconditionalExit(statement) && !EndsInUnconditionalExit(statement, gotoExits: false))

    private func CanStatementListCompleteNormally(statements ImmutableArray[BoundStatement]) bool {
        var fallsThrough = true
        let targets = HashSet[BoundLabel]()
        for statement in statements {
            let reachable = fallsThrough ||
                HasInternallyReachableFallthrough(statement) ||
                (statement is BoundLabelStatement label && targets.Contains(label.Label))
            if reachable {
                if statement is BoundGotoStatement jump {
                    targets.Add(jump.Label)
                } else if statement is BoundConditionalGotoStatement conditional {
                    targets.Add(conditional.Label)
                }
            }
            fallsThrough = reachable && CanCompleteNormally(statement)
        }
        return fallsThrough
    }

    private func ComputeCleanupFallthroughNonNull(
        cleanup BoundStatement,
        callableAliases IReadOnlyCollection[VariableSymbol]
    ) Dictionary[AccessPath, TypeSymbol]? -> ComputeCleanupFallthroughNonNull(cleanup, entry: nil, callableAliases)

    private func ApplyMutationsToState(state Dictionary[AccessPath, TypeSymbol], mutations AssignedRootsCollector) {
        for entry in state.ToArray() {
            if MayBeMutatedByUnknownWrite(mutations, entry.Key) || mutations.MayMutateGlobalRoot(
                entry.Key.Root,
                entry.Value
            ) ||
                DropsOnMemberMutation(entry.Key, mutations) ||
                mutations.InvalidatesNarrowing(entry.Key.Root, entry.Value) {
                state.Remove(entry.Key)
            }
        }
    }

    private func ApplyTryFinallyFallthroughNarrowings(statement BoundStatement, persistentFrame NarrowingFrame) {
        var statement = statement
        while statement is BoundBlockStatement labeledBlock &&
            labeledBlock.Syntax is LabeledStatementSyntax &&
            labeledBlock
            .Statements
            .Length == 2 &&
            labeledBlock.Statements[0] is BoundLabelStatement {
            statement = labeledBlock.Statements[1]
        }
        if !(statement is BoundTryStatement{FinallyBlock: {} finallyBlock}) ||
            !(statement.Syntax is TryStatementSyntax{FinallyClause: {} finallyClause}) {
            return
        }
        let summary = GetFinallyFlowSummary(finallyClause, finallyBlock)
        if summary.NonNullOnNormalExit == nil {
            return
        }
        for frame in binderCtx.NarrowedVariables {
            for entry in frame.ToArray() {
                if !IsNullableWidening(entry.Key, entry.Value) &&
                    (
                    MayBeMutatedByUnknownWrite(summary.Mutations, entry.Key) || summary.Mutations.MayMutateGlobalRoot(
                        entry.Key.Root,
                        entry.Value
                    ) ||
                        DropsOnMemberMutation(entry.Key, summary.Mutations) ||
                        summary
                        .Mutations
                        .InvalidatesNarrowing(entry.Key.Root, entry.Value)
                ) {
                    conditionKillJournal?.Add((frame, entry.Key, entry.Value))
                    frame.Remove(entry.Key)
                }
            }
        }
        for entry in summary.NonNullOnNormalExit!! {
            if !entry.Key.HasMembers {
                SetPersistentNarrowing(persistentFrame, entry.Key, entry.Value)
            }
        }
    }

    private func ApplyFlowSummary(snapshot NarrowingJumpState, summary FinallyFlowSummary) {
        for entry in snapshot.GetNarrowedVariablesSnapshot() {
            if !IsNullableWidening(entry.Key, entry.Value) &&
                (
                MayBeMutatedByUnknownWrite(summary.Mutations, entry.Key) || summary.Mutations.MayMutateGlobalRoot(
                    entry.Key.Root,
                    entry.Value
                ) ||
                    DropsOnMemberMutation(entry.Key, summary.Mutations) ||
                    summary
                    .Mutations
                    .InvalidatesNarrowing(entry.Key.Root, entry.Value)
            ) {
                snapshot.RemoveNarrowing(entry.Key)
            }
        }
        for entry in Invariant.Required(
            summary.NonNullOnNormalExit,
            "a completing cleanup summary has normal-exit facts",
            expression: "summary.NonNullOnNormalExit"
        ) {
            if !entry.Key.HasMembers {
                snapshot.SetNarrowing(entry.Key, entry.Value)
            }
        }
        snapshot.ReplaceExternalCallableAliases(summary.Mutations.DefinitelyExternalFunctionValues)
    }

    /// Issue #1123 / issue #2159: classifies whether [`assign`](paramref)
    /// assigns a statically <em>non-nullable</em> value to a nullable reference-like
    /// flow-tracked variable, proving the variable is non-null after the
    /// assignment. Shared by (cref:ApplyAssignmentNarrowing)
    /// (straight-line assignment narrowing) and the `if`-join narrowing
    /// pass (which consults it to decide whether a branch leaves the variable
    /// non-null).
    /// @param assign The bound assignment to classify.
    /// @param variable On success, the narrowed variable.
    /// @param underlying On success, the variable's underlying non-nullable type.
    /// @returns `true` when the assignment narrows the variable.
    private func TryClassifyNonNullAssignment(
        assign BoundAssignmentExpression,
        out variable VariableSymbol?,
        out underlying TypeSymbol?,
        includeNonNullableStorage bool = false
    ) bool {
        variable = nil
        underlying = nil
        if !SmartCastStability.IsAssignmentNarrowingRoot(assign.Variable) || assign.Variable.IsReadOnly {
            return false
        }
        let nullable = assign.Variable.Type as NullableTypeSymbol ?? binderCtx.NarrowedVariables.Query(
            AccessPath.ForVariable(assign.Variable)
        ) as NullableTypeSymbol
        if nullable == nil && !includeNonNullableStorage {
            return false
        }
        // Issue #1123 is scoped to reference (and interface) types. Nullable
        // value types (`int32?` → `int32`) are excluded: the existing narrowed-
        // read emit path does not unwrap `Nullable<T>` to its underlying value
        // for a `var`-local read, so a narrowed value-type read produces
        // unverifiable IL. Reference nullability is purely an annotation, so a
        // narrowed reference read needs no special emit.
        let u = nullable?.UnderlyingType ?? assign.Variable.Type
        if !IsReferenceLikeType(u) {
            return false
        }
        if !AssignmentTypePreservesNarrowing(assign.AssignedValueType, u) &&
            !NestedAssignmentPreservesNarrowing(assign.Expression, u) &&
            !(
            u is TypeParameterSymbol &&
                assign.AssignedValueType == u &&
                ExpressionBinder.IsProvenNonNullTypeParameterExpression(assign.Expression)
        ) {
            return false
        }
        variable = assign.Variable
        underlying = u
        return true
    }

    internal func DischargesNullableWidening(bound BoundExpression, path AccessPath, widenedType TypeSymbol) bool {
        if path.HasMembers || widenedType is not NullableTypeSymbol widenedNullable {
            return false
        }
        let underlying = widenedNullable.UnderlyingType
        if !IsReferenceLikeType(underlying) || !SmartCastStability.IsAssignmentNarrowingRoot(path.Root) ||
            path
            .Root
            .IsReadOnly {
            return false
        }
        var expr = bound
        while expr is BoundConversionExpression conversion {
            expr = conversion.Expression
        }
        if expr is BoundAssignmentExpression assign && object.ReferenceEquals(assign.Variable, path.Root) {
            return AssignmentTypePreservesNarrowing(assign.AssignedValueType, underlying) ||
                NestedAssignmentPreservesNarrowing(assign.Expression, underlying)
        }
        if TryExtractNullCoalescingAssignmentFromExpression(expr, out var ncaAssign) &&
            ncaAssign != nil &&
            object
            .ReferenceEquals(ncaAssign.Variable, path.Root) {
            return AssignmentTypePreservesNarrowing(ncaAssign.AssignedValueType, underlying) ||
                NestedAssignmentPreservesNarrowing(ncaAssign.Expression, underlying)
        }
        let assignments = TryClassifyNestedAssignmentNarrowings(expr)
        return (
            assignments != nil && assignments.TryGetValue(path, out var assignedType) &&
                AssignmentTypePreservesNarrowing(assignedType, underlying)
        ) ||
            CallDischargesNullableWidening(expr, path.Root, underlying)
    }

    private func TryExtractNullCoalescingAssignmentFromStatement(
        statement BoundStatement?,
        out assign BoundAssignmentExpression?
    ) bool {
        assign = nil
        if statement == nil {
            return false
        }
        if statement is BoundExpressionStatement exprStmt {
            return TryExtractNullCoalescingAssignmentFromExpression(exprStmt.Expression, out assign)
        }
        var ifStmt = statement as BoundIfStatement
        if ifStmt == nil && statement is BoundBlockStatement blockStmt && blockStmt.Statements.Length > 0 {
            ifStmt = blockStmt.Statements[blockStmt.Statements.Length - 1] as BoundIfStatement
        }
        if ifStmt == nil ||
            ifStmt.ElseStatement != nil ||
            ifStmt.Syntax is not ExpressionStatementSyntax{Expression: NullCoalescingAssignmentExpressionSyntax} {
            return false
        }
        if ifStmt.ThenStatement is BoundExpressionStatement{Expression: BoundAssignmentExpression directAssign} {
            assign = directAssign
            return true
        }
        if ifStmt.ThenStatement is BoundBlockStatement thenBlock {
            for s in thenBlock.Statements {
                if s is BoundExpressionStatement{Expression: BoundAssignmentExpression blockAssign} {
                    assign = blockAssign
                    return true
                }
            }
        }
        return false
    }

    private func CallDischargesNullableWidening(
        expr BoundExpression,
        targetRoot VariableSymbol,
        underlying TypeSymbol
    ) bool {
        switch expr {
            case call is BoundCallExpression {
                return UserCallDischargesNullableWidening(
                    call.Function.Parameters,
                    call.Arguments,
                    0,
                    targetRoot,
                    underlying
                )
            }
            case uic is BoundUserInstanceCallExpression {
                let offset = if uic.Method.Parameters.Length == uic.Arguments.Length + 1 {
                    1
                } else {
                    0
                }
                return UserCallDischargesNullableWidening(
                    uic.Method.Parameters,
                    uic.Arguments,
                    offset,
                    targetRoot,
                    underlying
                )
            }
            case impCall is BoundImportedCallExpression {
                return ClrCallDischargesNullableWidening(
                    impCall.Function.Method,
                    impCall.Arguments,
                    impCall.StaticContainerType,
                    impCall.TypeArgumentSymbols,
                    targetRoot,
                    underlying
                )
            }
            case impInstCall is BoundImportedInstanceCallExpression {
                return ClrCallDischargesNullableWidening(
                    impInstCall.Method,
                    impInstCall.Arguments,
                    impInstCall.ConstrainedInterfaceType ?? impInstCall.Receiver.Type,
                    impInstCall.TypeArgumentSymbols,
                    targetRoot,
                    underlying
                )
            }
            case clrStaticCall is BoundClrStaticCallExpression {
                return ClrCallDischargesNullableWidening(
                    clrStaticCall.Method,
                    clrStaticCall.Arguments,
                    nil,
                    default(ImmutableArray[TypeSymbol?]),
                    targetRoot,
                    underlying
                )
            }
            default {
                return false
            }
        }
    }

    private func OutputTypeDischargesNullableWidening(paramType TypeSymbol?, underlying TypeSymbol) bool {
        var pointee = paramType
        if pointee is ByRefTypeSymbol byRefParam {
            pointee = byRefParam.PointeeType
        }
        if pointee == nil ||
            pointee is PlatformTypeSymbol ||
            pointee.ReferenceNullability == ReferenceNullabilityKind.Platform {
            return false
        }
        return AssignmentTypePreservesNarrowing(pointee, underlying)
    }

    private func UserCallDischargesNullableWidening(
        parameters ImmutableArray[ParameterSymbol],
        arguments ImmutableArray[BoundExpression],
        parameterOffset int32,
        targetRoot VariableSymbol,
        underlying TypeSymbol
    ) bool {
        for var i = 0; i < arguments.Length && i + parameterOffset < parameters.Length; i++ {
            let param = parameters[i + parameterOffset]
            if param.RefKind != RefKind.Out || HasUserNullabilityContract(param) {
                continue
            }
            if arguments[i] is BoundAddressOfExpression{IsReadOnly: false, Operand: BoundVariableExpression v} &&
                object.ReferenceEquals(v.Variable, targetRoot) &&
                OutputTypeDischargesNullableWidening(param.Type, underlying) &&
                !HasCompetingWritableReferenceArgument(arguments, i, targetRoot) {
                return true
            }
        }
        return false
    }

    private func ClrCallDischargesNullableWidening(
        method MethodInfo,
        arguments ImmutableArray[BoundExpression],
        receiverType TypeSymbol?,
        methodTypeArguments ImmutableArray[TypeSymbol?],
        targetRoot VariableSymbol,
        underlying TypeSymbol
    ) bool {
        let parameters = method.GetParameters()
        for var i = 0; i < arguments.Length && i < parameters.Length; i++ {
            let param = parameters[i]
            if RefCapabilities.GetParameterRefKind(param) != RefKind.Out || HasClrNullabilityContract(param) {
                continue
            }
            let paramType = MemberLookup.GetClrMethodParameterConversionTargetTypeSymbol(
                receiverType,
                method,
                i,
                methodTypeArguments
            ) ??
                if receiverType != nil {
                MemberLookup.GetClrMethodParameterTypeSymbol(receiverType, method, i)
            } else {
                ClrNullability.GetParameterTypeSymbol(param)
            }
            if arguments[i] is BoundAddressOfExpression{IsReadOnly: false, Operand: BoundVariableExpression v} &&
                object.ReferenceEquals(v.Variable, targetRoot) &&
                OutputTypeDischargesNullableWidening(paramType, underlying) &&
                !HasCompetingWritableReferenceArgument(arguments, i, targetRoot) {
                return true
            }
        }
        return false
    }

    private func HasCompetingWritableReferenceArgument(
        arguments ImmutableArray[BoundExpression],
        outIndex int32,
        targetRoot VariableSymbol
    ) bool {
        for var j = 0; j < arguments.Length; j++ {
            if j == outIndex {
                continue
            }
            if ArgumentSharesWritableStorageWith(arguments[j], targetRoot) {
                return true
            }
        }
        return false
    }

    private func ArgumentSharesWritableStorageWith(argument BoundExpression, targetRoot VariableSymbol) bool {
        switch argument {
            case BoundAddressOfExpression{IsReadOnly: false, Operand: BoundVariableExpression v} {
                return object.ReferenceEquals(v.Variable, targetRoot) || MayShareStorage(v.Variable, targetRoot)
            }
            case condAddr is BoundConditionalAddressExpression {
                return (
                    condAddr.WhenTrueOperand is BoundVariableExpression tv &&
                        (object.ReferenceEquals(tv.Variable, targetRoot) || MayShareStorage(tv.Variable, targetRoot))
                ) ||
                    (
                    condAddr.WhenFalseOperand is BoundVariableExpression fv &&
                        (object.ReferenceEquals(fv.Variable, targetRoot) || MayShareStorage(fv.Variable, targetRoot))
                )
            }
            default {
                return false
            }
        }
    }

    private func StatementDischargesNullableWidening(
        statement BoundNode?,
        path AccessPath,
        widenedType TypeSymbol
    ) bool {
        var current = statement
        while current is BoundBlockStatement labeledBlock &&
            labeledBlock.Syntax is LabeledStatementSyntax &&
            labeledBlock
            .Statements
            .Length == 2 &&
            labeledBlock.Statements[0] is BoundLabelStatement {
            current = labeledBlock.Statements[1]
        }
        if current is BoundExpressionStatement exprStmt {
            return DischargesNullableWidening(exprStmt.Expression, path, widenedType)
        }
        if current is BoundExpression expression {
            return DischargesNullableWidening(expression, path, widenedType)
        }
        if current is BoundIfStatement ifStmt {
            if EndsInUnconditionalExit(ifStmt.ThenStatement) ||
                ifStmt.ElseStatement == nil ||
                EndsInUnconditionalExit(ifStmt.ElseStatement) {
                return false
            }
            if !normalStatementExits.TryGetValue(ifStmt, out var joined) {
                return false
            }
            let underlying = if widenedType is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                widenedType
            }
            let joinedType = joined.NarrowedType(path)
            return joinedType != nil &&
                !IsNullableWidening(path, joinedType) &&
                AssignmentTypePreservesNarrowing(joinedType, underlying)
        }
        return false
    }

    private func AssignmentPreservesNarrowing(assignment BoundAssignmentExpression, narrowedType TypeSymbol) bool {
        // Loop back-edges need stronger proof than straight-line issue #1123
        // narrowing because the assigned value feeds a later iteration.
        return (
            AssignmentTypePreservesNarrowing(assignment.AssignedValueType, narrowedType) ||
                (narrowedType is TypeParameterSymbol && assignment.AssignedValueType == narrowedType)
        ) &&
            IsDefinitelyNonNullValue(assignment.Expression)
    }

    private func IsDefinitelyNonNullValue(expression BoundExpression) bool {
        var expression = expression
        while expression is BoundConversionExpression conversion {
            expression = conversion.Expression
        }
        return switch expression {
            case _ is BoundConstructorCallExpression: true
            case _ is BoundClrConstructorCallExpression: true
            case _ is BoundTypeParameterConstructionExpression: true
            case BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}}: true
            case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.NullCoalesce:
            binary.Right.Type == TypeSymbol.Never || IsDefinitelyNonNullValue(binary.Right)
            case literal is BoundLiteralExpression: literal.Value != nil
            case BoundVariableExpression{NarrowedType: not nil} variable when(
                variable.Variable.Type is NullableTypeSymbol || variable.Variable.Type is TypeParameterSymbol
            ) &&
                !(variable.NarrowedType is NullableTypeSymbol): true
            case BoundFieldAccessExpression{NarrowedType: not nil} field when !(
                field.NarrowedType is NullableTypeSymbol
            ): true
            case BoundPropertyAccessExpression{NarrowedType: not nil} prop when !(
                prop.NarrowedType is NullableTypeSymbol
            ): true
            case BoundClrPropertyAccessExpression{NarrowedType: not nil} clrProp when !(
                clrProp.NarrowedType is NullableTypeSymbol
            ): true
            case _ when SmartCastStability.TryGetStableMemberPath(expression, out var path, out _) &&
                path != nil &&
                binderCtx
                .NarrowedVariables
                .Query(path) is {} pathNarrowed && !(pathNarrowed is NullableTypeSymbol): true
            case variable is BoundVariableExpression: IsDefinitelyNonNullVariable(variable.Variable)
            case call is BoundCallExpression: FunctionReturnsDefinitelyNonNull(call.Function)
            default: false
        }
    }

    private func FunctionReturnsDefinitelyNonNull(function FunctionSymbol) bool {
        if function?.Declaration?.Body == nil || function.Type is NullableTypeSymbol {
            return false
        }
        let descendants = DescendantsAndSelf(function.Declaration!!.Body!!).ToArray()
        for node in descendants {
            if node is VariableDeclarationSyntax variable && string.Equals(
                variable.Identifier.ValueText,
                function.Type.Name,
                StringComparison.Ordinal
            ) {
                return false
            }
        }
        let returns = descendants.OfType[ReturnStatementSyntax]().ToArray()
        if returns.Length == 0 {
            return false
        }
        for statement in returns {
            if !IsDefinitelyNonNullSyntax(statement.Expression, function.Type) {
                return false
            }
        }
        return true
    }

    private func IsDefinitelyNonNullSyntax(expression ExpressionSyntax?, expectedType TypeSymbol) bool {
        if expression is LiteralExpressionSyntax literal {
            return literal.Value != nil
        }
        if expression is not CallExpressionSyntax call || call.Callee != nil || call.NullableQuestionToken != nil {
            return false
        }
        return expectedType is StructSymbol && string.Equals(
            call.Identifier.ValueText,
            expectedType.Name,
            StringComparison.Ordinal
        ) &&
            $scope
            .TryLookupFunctions(call.Identifier.ValueText).IsDefaultOrEmpty
    }

    /// Applies a conditional cleanup to the jump's entry facts.
    /// Cleanup runs after binding and must transfer the state supplied by each exiting edge.
    private func ComputeCleanupConditionalExit(
        ifStmt BoundIfStatement,
        entry Dictionary[AccessPath, TypeSymbol]?,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil,
        updatedAliases HashSet[VariableSymbol]? = nil
    ) Dictionary[AccessPath, TypeSymbol]? {
        var conditionEntry Dictionary[AccessPath, TypeSymbol]? = nil
        if entry != nil && entry.Count > 0 && !ContainsUserLabel(ifStmt.Condition) {
            conditionEntry = Dictionary[AccessPath, TypeSymbol](entry)
            ClearAssignedRoots(ifStmt.Condition, conditionEntry, callableAliases)
        }
        let initialAliases = HashSet[VariableSymbol](callableAliases ?? externalCallableAliases)
        let (thenNarrow, elseNarrow, trueAliases, falseAliases) = ComputeConditionNarrowingInOrder(
            ifStmt.Condition,
            initialAliases
        )
        let thenAliases = HashSet[VariableSymbol](trueAliases)
        let thenState Dictionary[AccessPath, TypeSymbol]? = ComputeCleanupFallthroughNonNull(
            ifStmt.ThenStatement,
            MergeLocalNonNull(conditionEntry, thenNarrow),
            thenAliases
        )
        let elseAliases = HashSet[VariableSymbol](falseAliases)
        let elseState Dictionary[AccessPath, TypeSymbol]? = if ifStmt.ElseStatement == nil {
            MergeLocalNonNull(conditionEntry, elseNarrow)
        } else {
            ComputeCleanupFallthroughNonNull(
                ifStmt.ElseStatement,
                MergeLocalNonNull(conditionEntry, elseNarrow),
                elseAliases
            )
        }
        if thenState == nil && elseState == nil {
            return nil
        }
        if updatedAliases != nil {
            updatedAliases.Clear()
            if thenState == nil {
                updatedAliases.UnionWith(elseAliases)
            } else if elseState == nil {
                updatedAliases.UnionWith(thenAliases)
            } else {
                updatedAliases.UnionWith(thenAliases)
                updatedAliases.IntersectWith(elseAliases)
            }
        }
        // When one branch exits, the join is reached only through the other, so
        // that branch's non-null set holds unconditionally at the join.
        if thenState == nil {
            return elseState
        }
        if elseState == nil {
            return thenState
        }
        return IntersectNonNull(thenState, elseState)
    }

    /// Transfers deferred cleanup in evaluation order from the supplied facts and callable aliases.
    private func ComputeCleanupFallthroughNonNull(
        branch BoundStatement,
        entry Dictionary[AccessPath, TypeSymbol]?,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) Dictionary[AccessPath, TypeSymbol]? {
        let state = entry ?? Dictionary[AccessPath, TypeSymbol]()
        let aliases = if callableAliases is HashSet[VariableSymbol]mutableAliases {
            mutableAliases
        } else {
            HashSet[VariableSymbol](callableAliases ?? externalCallableAliases)
        }
        return if TransferCleanupStatement(branch, state, aliases) {
            state
        } else {
            default(Dictionary[AccessPath, TypeSymbol]?)
        }
    }

    /// Transfers one deferred cleanup statement, returning whether it reaches the next statement.
    private func TransferCleanupStatement(
        stmt BoundStatement,
        state Dictionary[AccessPath, TypeSymbol],
        aliases HashSet[VariableSymbol]
    ) bool {
        switch stmt {
            case BoundReturnStatement, BoundThrowStatement, BoundRethrowStatement, BoundGotoStatement {
                return false
            }
            case expressionStatement is BoundExpressionStatement {
                if !CanCompleteNormally(stmt) {
                    return false
                }
                let hasLabel = ContainsUserLabel(stmt)
                if hasLabel {
                    state.Clear()
                    aliases.Clear()
                }
                let postconditions = if hasLabel {
                    default(Dictionary[AccessPath, TypeSymbol]?)
                } else {
                    TryClassifyConditionNonNullAssignments(expressionStatement.Expression, aliases)
                }
                ClearAssignedRootsAndUpdateAliases(stmt, state, aliases)
                if postconditions != nil {
                    for fact in postconditions {
                        state[fact.Key] = fact.Value
                    }
                }
                return true
            }
            case nested is BoundIfStatement {
                {
                    // The nested join is the exact post-if non-null set given the
                    // current state as entry, so it fully replaces the tracked
                    // state (it carries surviving entry facts through).
                    let nestedResult Dictionary[AccessPath, TypeSymbol]? = ComputeCleanupConditionalExit(
                        nested,
                        Dictionary[AccessPath, TypeSymbol](state),
                        aliases,
                        aliases
                    )
                    if nestedResult == nil {
                        return false
                    }
                    state.Clear()
                    for kv in nestedResult {
                        state[kv.Key] = kv.Value
                    }
                    return true
                }
            }
            case inner is BoundBlockStatement {
                if inner.Syntax is LabeledStatementSyntax &&
                    inner
                    .Statements
                    .Length == 2 &&
                    inner.Statements[0] is BoundLabelStatement {
                    // A user label can be reached by a goto from outside the branch,
                    // so only facts established after the label hold on all paths out.
                    state.Clear()
                    aliases.Clear()
                    return TransferCleanupStatement(inner.Statements[1], state, aliases)
                }
                if inner.Statements.Any((statement BoundStatement) -> statement is BoundLabelStatement) {
                    if ContainsUserLabel(inner) {
                        state.Clear()
                        aliases.Clear()
                    }
                    // Internal jumps do not exit the branch. Without a CFG,
                    // retain only entry facts untouched by the whole block.
                    ClearAssignedRootsAndUpdateAliases(inner, state, aliases)
                    return true
                }
                var fallsThrough = true
                for s in inner.Statements {
                    if !fallsThrough {
                        if !HasInternallyReachableFallthrough(s) {
                            continue
                        }
                        state.Clear()
                        aliases.Clear()
                        fallsThrough = true
                    }
                    if !TransferCleanupStatement(s, state, aliases) {
                        fallsThrough = false
                    }
                }
                return fallsThrough
            }
            case tryStatement is BoundTryStatement {
                if !CanCompleteNormally(tryStatement) {
                    return false
                }
                if ContainsUserLabel(tryStatement) {
                    state.Clear()
                    aliases.Clear()
                }
                if tryStatement.FinallyBlock is not{} finallyBlock {
                    ClearAssignedRootsAndUpdateAliases(tryStatement, state, aliases)
                    return true
                }
                let withoutFinally = BoundTryStatement(
                    tryStatement.Syntax,
                    tryStatement.TryBlock,
                    tryStatement.CatchClauses,
                    finallyBlock: nil
                )
                ClearAssignedRootsAndUpdateAliases(withoutFinally, state, aliases)
                if ContainsUserGotoOrLabel(finallyBlock) {
                    if !CanCompleteNormally(finallyBlock) {
                        return false
                    }
                    ClearAssignedRootsAndUpdateAliases(finallyBlock, state, aliases)
                    return true
                }
                return TransferCleanupStatement(finallyBlock, state, aliases)
            }
            default {
                if !CanCompleteNormally(stmt) {
                    return false
                }
                if ContainsUserLabel(stmt) {
                    state.Clear()
                    aliases.Clear()
                }
                // Loops, switches, and any other construct that could reassign a
                // tracked local: conservatively drop every narrowing on a local
                // the statement's subtree assigns anywhere.
                ClearAssignedRootsAndUpdateAliases(stmt, state, aliases)
                return true
            }
        }
    }

    private func ContainsUserLabel(statement BoundStatement?) bool {
        if !binderCtx.FunctionContainsUserGotoOrLabel || statement == nil {
            return false
        }
        let finder = UserLabelFinder()
        finder.VisitStatement(statement)
        return finder.Found
    }

    private func ContainsUserLabel(expression BoundExpression?) bool {
        if !binderCtx.FunctionContainsUserGotoOrLabel || expression == nil {
            return false
        }
        let finder = UserLabelFinder()
        finder.VisitExpression(expression)
        return finder.Found
    }

    private func ContainsUserGotoOrLabel(statement BoundStatement?) bool {
        if !binderCtx.FunctionContainsUserGotoOrLabel || statement == nil {
            return false
        }
        let finder = UserGotoOrLabelFinder()
        finder.VisitStatement(statement)
        return finder.Found
    }

    private class UserLabelFinder : BoundTreeWalker {
        prop Found bool {
            get;
            private set;
        }

        open override func VisitStatement(node BoundStatement?) {
            if Found || node == nil || node is BoundLocalFunctionDeclaration {
                return
            }
            if node.Syntax is LabeledStatementSyntax labeled && !IsLabelableLoop(labeled.Statement) {
                Found = true
                return
            }
            if node.Syntax != nil && ContainsUserLabel(node.Syntax) {
                Found = true
                return
            }
            base.VisitStatement(node)
        }

        open override func VisitExpression(node BoundExpression?) {
            if Found || node == nil || node is BoundFunctionLiteralExpression {
                return
            }
            if node.Syntax != nil && ContainsUserLabel(node.Syntax) {
                Found = true
                return
            }
            base.VisitExpression(node)
        }
    }

    private class UserGotoOrLabelFinder : BoundTreeWalker {
        prop Found bool {
            get;
            private set;
        }

        open override func VisitStatement(node BoundStatement?) {
            if Found || node == nil || node is BoundLocalFunctionDeclaration {
                return
            }
            if node.Syntax != nil && ContainsUserGotoOrLabel(node.Syntax) {
                Found = true
                return
            }
            base.VisitStatement(node)
        }

        open override func VisitExpression(node BoundExpression?) {
            if Found || node == nil || node is BoundFunctionLiteralExpression {
                return
            }
            if node.Syntax != nil && ContainsUserGotoOrLabel(node.Syntax) {
                Found = true
                return
            }
            base.VisitExpression(node)
        }
    }

    /// Issue #2159: recomputes the then / else condition-implied non-null
    /// narrowing frames for an `if` condition, mirroring the composition
    /// (cref:BindIfStatement) performs (nil guard, `[NotNullWhen]`
    /// bool call, and type-test), so the join analysis sees the same seeds the
    /// branches were bound under.
    private func ComputeConditionNarrowing(
        condition BoundExpression,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
        let aliases = HashSet[VariableSymbol](callableAliases ?? externalCallableAliases)
        let (thenNarrow, elseNarrow, _, _) = ComputeConditionNarrowingInOrder(
            condition,
            aliases,
            keepBoolCallInLogicalOps: true
        )
        return (thenNarrow, elseNarrow)
    }

    private func ComputeConditionNarrowingInOrder(
        condition BoundExpression,
        beforeAliases HashSet[VariableSymbol],
        removedFacts Dictionary[AccessPath, TypeSymbol]? = nil,
        forShortCircuitOperand bool = false,
        allowBoolCall bool = true,
        keepBoolCallInLogicalOps bool = true,
        shortCircuitInComposedOps bool = false,
        header SyntaxNode? = nil
    )(
        Then Dictionary[AccessPath, TypeSymbol]?,
        Else Dictionary[AccessPath, TypeSymbol]?,
        WhenTrueAliases HashSet[VariableSymbol],
        WhenFalseAliases HashSet[VariableSymbol]
    ) {
        if ContainsUserLabel(condition) {
            return (nil, nil, HashSet[VariableSymbol](), HashSet[VariableSymbol]())
        }
        let childShortCircuit = forShortCircuitOperand || shortCircuitInComposedOps
        switch condition {
            case block is BoundBlockExpression {
                let afterPrefix = AliasesAfterBlockPrefix(block, beforeAliases)
                var prefixRefinements Dictionary[AccessPath, TypeSymbol]? = nil
                if !block.Statements.IsDefaultOrEmpty {
                    let prefixShell = BoundBlockExpression(
                        block.Syntax,
                        block.Statements,
                        BoundLiteralExpression(nil, 0)
                    )
                    prefixRefinements = TryClassifyConditionNonNullAssignments(prefixShell, beforeAliases)
                    if prefixRefinements != nil && prefixRefinements.Count > 0 {
                        prefixRefinements = Dictionary[AccessPath, TypeSymbol](prefixRefinements)
                        ClearAssignedRoots(block.Expression, prefixRefinements, afterPrefix)
                        if prefixRefinements.Count == 0 {
                            prefixRefinements = nil
                        }
                    }
                }
                let (innerThen, innerElse, trueAliases, falseAliases) = ComputeConditionNarrowingInOrder(
                    block.Expression,
                    afterPrefix,
                    removedFacts,
                    childShortCircuit,
                    allowBoolCall,
                    keepBoolCallInLogicalOps,
                    shortCircuitInComposedOps,
                    header
                )
                return (
                    MergeNarrowingFrames(prefixRefinements, innerThen),
                    MergeNarrowingFrames(prefixRefinements, innerElse),
                    trueAliases,
                    falseAliases
                )
            }
            case unary is BoundUnaryExpression when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
                let (inThen, inElse, trueAliases, falseAliases) = ComputeConditionNarrowingInOrder(
                    unary.Operand,
                    beforeAliases,
                    removedFacts,
                    childShortCircuit,
                    allowBoolCall,
                    keepBoolCallInLogicalOps,
                    shortCircuitInComposedOps,
                    header
                )
                return (inElse, inThen, falseAliases, trueAliases)
            }
            case bin is BoundBinaryExpression when bin.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                let (leftThenRaw, leftElse, leftTrueAliases, leftFalseAliases) = ComputeConditionNarrowingInOrder(
                    bin.Left,
                    beforeAliases,
                    removedFacts,
                    childShortCircuit,
                    keepBoolCallInLogicalOps,
                    keepBoolCallInLogicalOps,
                    shortCircuitInComposedOps,
                    header
                )
                var leftThen = leftThenRaw
                if leftThen != nil && leftThen.Count > 0 {
                    leftThen = Dictionary[AccessPath, TypeSymbol](leftThen)
                    ClearOperandFacts(bin.Right, leftThen, leftTrueAliases)
                    if leftThen.Count == 0 {
                        leftThen = nil
                    }
                }
                let (rightThen, rightElse, rightTrueAliases, rightFalseAliases) = ComputeConditionNarrowingInOrder(
                    bin.Right,
                    leftTrueAliases,
                    removedFacts,
                    childShortCircuit,
                    keepBoolCallInLogicalOps,
                    keepBoolCallInLogicalOps,
                    shortCircuitInComposedOps,
                    header
                )
                let (combinedThen, combinedElse) = CombineLogicalAndNarrowings(
                    leftThenRaw,
                    leftThen,
                    leftElse,
                    rightThen,
                    rightElse
                )
                return (combinedThen, combinedElse, rightTrueAliases, JoinAliases(leftFalseAliases, rightFalseAliases))
            }
            case bin is BoundBinaryExpression when bin.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
                let (leftThen, leftElseRaw, leftTrueAliases, leftFalseAliases) = ComputeConditionNarrowingInOrder(
                    bin.Left,
                    beforeAliases,
                    removedFacts,
                    childShortCircuit,
                    keepBoolCallInLogicalOps,
                    keepBoolCallInLogicalOps,
                    shortCircuitInComposedOps,
                    header
                )
                var leftElse = leftElseRaw
                if leftElse != nil && leftElse.Count > 0 {
                    leftElse = Dictionary[AccessPath, TypeSymbol](leftElse)
                    ClearOperandFacts(bin.Right, leftElse, leftFalseAliases)
                    if leftElse.Count == 0 {
                        leftElse = nil
                    }
                }
                let (rightThen, rightElse, rightTrueAliases, rightFalseAliases) = ComputeConditionNarrowingInOrder(
                    bin.Right,
                    leftFalseAliases,
                    removedFacts,
                    childShortCircuit,
                    keepBoolCallInLogicalOps,
                    keepBoolCallInLogicalOps,
                    shortCircuitInComposedOps,
                    header
                )
                let (combinedThen, combinedElse) = CombineLogicalOrNarrowings(
                    leftThen,
                    leftElseRaw,
                    leftElse,
                    rightThen,
                    rightElse
                )
                return (combinedThen, combinedElse, JoinAliases(leftTrueAliases, rightTrueAliases), rightFalseAliases)
            }
        }
        var (thenNarrow, elseNarrow) = TryClassifyNilGuard(condition, forShortCircuitOperand)
        let (conditionalThen, conditionalElse) = TryClassifyNullConditionalBoolNarrowing(
            condition,
            forShortCircuitOperand,
            beforeAliases,
            (node BoundNode, state Dictionary[AccessPath, TypeSymbol], aliases IReadOnlyCollection[VariableSymbol]?) ->
            ClearAssignedRoots(node, state, aliases)
        )
        thenNarrow = MergeNarrowingFrames(thenNarrow, conditionalThen)
        elseNarrow = MergeNarrowingFrames(elseNarrow, conditionalElse)
        if !forShortCircuitOperand && allowBoolCall {
            let (boolThen, boolElse) = TryClassifyBoolCallNarrowing(condition, beforeAliases)
            thenNarrow = MergeNarrowingFrames(thenNarrow, boolThen)
            elseNarrow = MergeNarrowingFrames(elseNarrow, boolElse)
        }
        let (typeThen, typeElse) = TryClassifyTypeTestNarrowing(condition, removedFacts, beforeAliases)
        thenNarrow = MergeNarrowingFrames(thenNarrow, typeThen)
        elseNarrow = MergeNarrowingFrames(elseNarrow, typeElse)
        let assignRefinements = TryClassifyConditionNonNullAssignments(condition, beforeAliases)
        thenNarrow = MergeNarrowingFrames(assignRefinements, thenNarrow)
        elseNarrow = MergeNarrowingFrames(assignRefinements, elseNarrow)
        let afterAliases = AliasesAfter(condition, beforeAliases, header)
        return (thenNarrow, elseNarrow, afterAliases, afterAliases)
    }

    internal func TryClassifyConditionNonNullAssignments(
        condition BoundExpression,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) Dictionary[AccessPath, TypeSymbol]? {
        let state = Dictionary[AccessPath, TypeSymbol]()
        let aliases = HashSet[VariableSymbol](callableAliases ?? externalCallableAliases)
        let processed = HashSet[BoundExpression](ReferenceEqualityComparer.Instance)
        let exitAliases = Dictionary[BoundExpression, HashSet[VariableSymbol]](ReferenceEqualityComparer.Instance)
        CollectConditionNonNullAssignments(
            condition,
            state,
            aliases,
            processed,
            exitAliases,
            includeNullableNullCoalescing: true
        )
        return if state.Count > 0 {
            state
        } else {
            default(Dictionary[AccessPath, TypeSymbol]?)
        }
    }

    private func TryClassifyNullCoalescingExpressionNonNullAssignments(
        expression BoundExpression,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) Dictionary[AccessPath, TypeSymbol]? {
        let anchor = expression.Syntax ?? FindSyntaxAnchor(expression)
        if anchor == nil || !ContainsNullCoalescingAssignmentSyntax(anchor) {
            return nil
        }
        var entryAliases IReadOnlyCollection[VariableSymbol] = callableAliases ?? externalCallableAliases
        if expressionEntryAliases.TryGetValue(expression, out var recordedEntry) {
            entryAliases = recordedEntry
        }
        let state = Dictionary[AccessPath, TypeSymbol]()
        let aliases = HashSet[VariableSymbol](entryAliases)
        let processed = HashSet[BoundExpression](ReferenceEqualityComparer.Instance)
        let exitAliases = Dictionary[BoundExpression, HashSet[VariableSymbol]](ReferenceEqualityComparer.Instance)
        CollectConditionNonNullAssignments(
            expression,
            state,
            aliases,
            processed,
            exitAliases,
            includeNullableNullCoalescing: true
        )
        return if state.Count > 0 {
            state
        } else {
            default(Dictionary[AccessPath, TypeSymbol]?)
        }
    }

    private func TryClassifyNullCoalescingBlockStatementNonNullAssignments(
        block BoundBlockStatement,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) Dictionary[AccessPath, TypeSymbol]? {
        let state = Dictionary[AccessPath, TypeSymbol]()
        let aliases = HashSet[VariableSymbol](callableAliases ?? externalCallableAliases)
        let processed = HashSet[BoundExpression](ReferenceEqualityComparer.Instance)
        let exitAliases = Dictionary[BoundExpression, HashSet[VariableSymbol]](ReferenceEqualityComparer.Instance)
        for stmt in block.Statements {
            if stmt is BoundVariableDeclaration varDecl && varDecl.Initializer != nil {
                CollectConditionNonNullAssignments(
                    varDecl.Initializer,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing: true
                )
            } else {
                ClearAssignedRootsAndUpdateAliases(stmt, state, aliases)
            }
        }
        return if state.Count > 0 {
            state
        } else {
            default(Dictionary[AccessPath, TypeSymbol]?)
        }
    }

    private func ContainsNullCoalescingAssignmentSyntax(node SyntaxNode) bool {
        if node is NullCoalescingAssignmentExpressionSyntax {
            return true
        }
        if node is FunctionLiteralExpressionSyntax or LambdaExpressionSyntax {
            return false
        }
        for child in node.GetChildren() {
            if ContainsNullCoalescingAssignmentSyntax(child) {
                return true
            }
        }
        return false
    }

    private func CollectConditionNonNullAssignments(
        node BoundExpression?,
        state Dictionary[AccessPath, TypeSymbol],
        aliases HashSet[VariableSymbol],
        processed HashSet[BoundExpression],
        exitAliases Dictionary[BoundExpression, HashSet[VariableSymbol]],
        includeNullableNullCoalescing bool = false
    ) {
        if node == nil || processed.Contains(node) {
            return
        }
        switch node {
            case unary is BoundUnaryExpression {
                CollectConditionNonNullAssignments(
                    unary.Operand,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case binary is BoundBinaryExpression {
                CollectConditionNonNullAssignments(
                    binary.Left,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                if binary
                    .Op
                    .Kind is not(
                    BoundBinaryOperatorKind.LogicalAnd or
                        BoundBinaryOperatorKind.LogicalOr or
                        BoundBinaryOperatorKind.NullCoalesce
                ) {
                    CollectConditionNonNullAssignments(
                        binary.Right,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case conv is BoundConversionExpression {
                CollectConditionNonNullAssignments(
                    conv.Expression,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case asExpr is BoundAsExpression {
                CollectConditionNonNullAssignments(
                    asExpr.Expression,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case isExpr is BoundIsExpression {
                CollectConditionNonNullAssignments(
                    isExpr.Expression,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case assign is BoundAssignmentExpression {
                CollectConditionNonNullAssignments(
                    assign.Expression,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case indexExpr is BoundIndexExpression {
                CollectConditionNonNullAssignments(
                    indexExpr.Target,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for index in indexExpr.Indices {
                    CollectConditionNonNullAssignments(
                        index,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case clrIndexExpr is BoundClrIndexExpression {
                CollectConditionNonNullAssignments(
                    clrIndexExpr.Target,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for arg in clrIndexExpr.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case assign is BoundIndexAssignmentExpression {
                CollectConditionNonNullAssignments(
                    assign.TargetExpression,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for index in assign.Indices {
                    CollectConditionNonNullAssignments(
                        index,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
                CollectConditionNonNullAssignments(
                    assign.Value,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case assign is BoundClrIndexAssignmentExpression {
                CollectConditionNonNullAssignments(
                    assign.TargetExpression,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for index in assign.Arguments {
                    CollectConditionNonNullAssignments(
                        index,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
                CollectConditionNonNullAssignments(
                    assign.Value,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case assign is BoundFieldAssignmentExpression {
                CollectConditionNonNullAssignments(
                    assign.ReceiverExpression,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                CollectConditionNonNullAssignments(
                    assign.Value,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case assign is BoundPropertyAssignmentExpression {
                CollectConditionNonNullAssignments(
                    assign.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                CollectConditionNonNullAssignments(
                    assign.Value,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case assign is BoundClrPropertyAssignmentExpression {
                CollectConditionNonNullAssignments(
                    assign.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                CollectConditionNonNullAssignments(
                    assign.Value,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case tupleLit is BoundTupleLiteralExpression {
                for elem in tupleLit.Elements {
                    CollectConditionNonNullAssignments(
                        elem,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case arrayCreate is BoundArrayCreationExpression {
                if arrayCreate.DimensionExpressions.Length > 1 {
                    for dim in arrayCreate.DimensionExpressions {
                        CollectConditionNonNullAssignments(
                            dim,
                            state,
                            aliases,
                            processed,
                            exitAliases,
                            includeNullableNullCoalescing
                        )
                    }
                } else if arrayCreate.LengthExpression != nil {
                    CollectConditionNonNullAssignments(
                        arrayCreate.LengthExpression,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
                for elem in arrayCreate.Elements {
                    CollectConditionNonNullAssignments(
                        elem,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case stackAlloc is BoundStackAllocExpression {
                CollectConditionNonNullAssignments(
                    stackAlloc.Count,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for elem in stackAlloc.InitializerElements {
                    CollectConditionNonNullAssignments(
                        elem,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case mapLit is BoundMapLiteralExpression {
                for entry in mapLit.Entries {
                    CollectConditionNonNullAssignments(
                        entry.Key,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                    CollectConditionNonNullAssignments(
                        entry.Value,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case lenExpr is BoundLenExpression {
                CollectConditionNonNullAssignments(
                    lenExpr.Operand,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case structLit is BoundStructLiteralExpression {
                CollectConditionNonNullAssignments(
                    structLit.CopySource,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for init in structLit.Initializers {
                    CollectConditionNonNullAssignments(
                        init.Value,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case interp is BoundInterpolatedStringExpression {
                if interp.Handler != nil && !interp.Handler.ForwardedArguments.IsDefaultOrEmpty {
                    for arg in interp.Handler.ForwardedArguments {
                        CollectConditionNonNullAssignments(
                            arg,
                            state,
                            aliases,
                            processed,
                            exitAliases,
                            includeNullableNullCoalescing
                        )
                    }
                }
                for part in interp.Parts {
                    if !part.IsLiteral {
                        if interp.Handler != nil {
                            let skippedState = Dictionary[AccessPath, TypeSymbol](state)
                            let skippedAliases = HashSet[VariableSymbol](aliases)
                            let evalState = Dictionary[AccessPath, TypeSymbol](state)
                            let evalAliases = HashSet[VariableSymbol](aliases)
                            CollectConditionNonNullAssignments(
                                part.Value,
                                evalState,
                                evalAliases,
                                processed,
                                exitAliases,
                                includeNullableNullCoalescing
                            )
                            state.Clear()
                            for kv in skippedState {
                                if evalState.TryGetValue(kv.Key, out var evalType) &&
                                    FindCommonImplicitSupertype(
                                    kv.Key,
                                    List[TypeSymbol]{kv.Value, evalType}
                                ) is {} common {
                                    state[kv.Key] = common
                                }
                            }
                            skippedAliases.IntersectWith(evalAliases)
                            aliases.Clear()
                            aliases.UnionWith(skippedAliases)
                            if part.Value != nil {
                                exitAliases[part.Value] = HashSet[VariableSymbol](aliases)
                            }
                        } else {
                            CollectConditionNonNullAssignments(
                                part.Value,
                                state,
                                aliases,
                                processed,
                                exitAliases,
                                includeNullableNullCoalescing
                            )
                        }
                    }
                }
            }
            case nullCond is BoundNullConditionalAccessExpression {
                CollectConditionNonNullAssignments(
                    nullCond.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case baseIfaceCall is BoundBaseInterfaceCallExpression {
                CollectConditionNonNullAssignments(
                    baseIfaceCall.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for arg in baseIfaceCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case baseClassCall is BoundBaseClassCallExpression {
                CollectConditionNonNullAssignments(
                    baseClassCall.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for arg in baseClassCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case clrBin is BoundClrBinaryOperatorExpression {
                CollectConditionNonNullAssignments(
                    clrBin.Left,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                CollectConditionNonNullAssignments(
                    clrBin.Right,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case clrUnary is BoundClrUnaryOperatorExpression {
                CollectConditionNonNullAssignments(
                    clrUnary.Operand,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case addr is BoundAddressOfExpression {
                CollectConditionNonNullAssignments(
                    addr.Operand,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case deref is BoundDereferenceExpression {
                CollectConditionNonNullAssignments(
                    deref.Operand,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case indirectAssign is BoundIndirectAssignmentExpression {
                CollectConditionNonNullAssignments(
                    indirectAssign.Pointer,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                CollectConditionNonNullAssignments(
                    indirectAssign.Value,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case fnPtrCall is BoundFunctionPointerInvocationExpression {
                CollectConditionNonNullAssignments(
                    fnPtrCall.Pointer,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for arg in fnPtrCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case awaitExpr is BoundAwaitExpression {
                CollectConditionNonNullAssignments(
                    awaitExpr.Expression,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case tupleAccess is BoundTupleElementAccessExpression {
                CollectConditionNonNullAssignments(
                    tupleAccess.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case fieldAccess is BoundFieldAccessExpression {
                CollectConditionNonNullAssignments(
                    fieldAccess.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case propAccess is BoundPropertyAccessExpression {
                CollectConditionNonNullAssignments(
                    propAccess.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case clrPropAccess is BoundClrPropertyAccessExpression {
                CollectConditionNonNullAssignments(
                    clrPropAccess.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case ctorCall is BoundConstructorCallExpression {
                for arg in ctorCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case clrCtorCall is BoundClrConstructorCallExpression {
                for arg in clrCtorCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case call is BoundCallExpression {
                for arg in call.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case impCall is BoundImportedCallExpression {
                for arg in impCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case clrStaticCall is BoundClrStaticCallExpression {
                for arg in clrStaticCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case constrainedCall is BoundConstrainedStaticCallExpression {
                for arg in constrainedCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case userInstCall is BoundUserInstanceCallExpression {
                CollectConditionNonNullAssignments(
                    userInstCall.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for arg in userInstCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case impInstCall is BoundImportedInstanceCallExpression {
                CollectConditionNonNullAssignments(
                    impInstCall.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for arg in impInstCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case indirectCall is BoundIndirectCallExpression {
                CollectConditionNonNullAssignments(
                    indirectCall.Target,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                for arg in indirectCall.Arguments {
                    CollectConditionNonNullAssignments(
                        arg,
                        state,
                        aliases,
                        processed,
                        exitAliases,
                        includeNullableNullCoalescing
                    )
                }
            }
            case clrConvCall is BoundClrConversionCallExpression {
                CollectConditionNonNullAssignments(
                    clrConvCall.Source,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case cond is BoundConditionalExpression {
                CollectConditionNonNullAssignments(
                    cond.Condition,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                let thenState = Dictionary[AccessPath, TypeSymbol](state)
                let thenAliases = HashSet[VariableSymbol](aliases)
                CollectConditionNonNullAssignments(
                    cond.WhenTrue,
                    thenState,
                    thenAliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                let elseState = Dictionary[AccessPath, TypeSymbol](state)
                let elseAliases = HashSet[VariableSymbol](aliases)
                CollectConditionNonNullAssignments(
                    cond.WhenFalse,
                    elseState,
                    elseAliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                state.Clear()
                aliases.Clear()
                if cond.WhenTrue.Type == TypeSymbol.Never && cond.WhenFalse.Type != TypeSymbol.Never {
                    for kv in elseState {
                        state[kv.Key] = kv.Value
                    }
                    aliases.UnionWith(elseAliases)
                } else if cond.WhenFalse.Type == TypeSymbol.Never && cond.WhenTrue.Type != TypeSymbol.Never {
                    for kv in thenState {
                        state[kv.Key] = kv.Value
                    }
                    aliases.UnionWith(thenAliases)
                } else {
                    for kv in thenState {
                        if elseState.TryGetValue(kv.Key, out var elseType) &&
                            FindCommonImplicitSupertype(kv.Key, List[TypeSymbol]{kv.Value, elseType}) is {} common {
                            state[kv.Key] = common
                        }
                    }
                    thenAliases.IntersectWith(elseAliases)
                    aliases.UnionWith(thenAliases)
                }
                processed.Add(cond)
                exitAliases[cond] = HashSet[VariableSymbol](aliases)
                return
            }
            case condAddr is BoundConditionalAddressExpression {
                CollectConditionNonNullAssignments(
                    condAddr.Condition,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                let thenState = Dictionary[AccessPath, TypeSymbol](state)
                let thenAliases = HashSet[VariableSymbol](aliases)
                CollectConditionNonNullAssignments(
                    condAddr.WhenTrueOperand,
                    thenState,
                    thenAliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                let elseState = Dictionary[AccessPath, TypeSymbol](state)
                let elseAliases = HashSet[VariableSymbol](aliases)
                CollectConditionNonNullAssignments(
                    condAddr.WhenFalseOperand,
                    elseState,
                    elseAliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                state.Clear()
                aliases.Clear()
                if condAddr
                    .WhenTrueOperand
                    .Type == TypeSymbol.Never &&
                    condAddr
                    .WhenFalseOperand
                    .Type != TypeSymbol.Never {
                    for kv in elseState {
                        state[kv.Key] = kv.Value
                    }
                    aliases.UnionWith(elseAliases)
                } else if condAddr
                    .WhenFalseOperand
                    .Type == TypeSymbol.Never &&
                    condAddr
                    .WhenTrueOperand
                    .Type != TypeSymbol.Never {
                    for kv in thenState {
                        state[kv.Key] = kv.Value
                    }
                    aliases.UnionWith(thenAliases)
                } else {
                    for kv in thenState {
                        if elseState.TryGetValue(kv.Key, out var elseType) &&
                            FindCommonImplicitSupertype(kv.Key, List[TypeSymbol]{kv.Value, elseType}) is {} common {
                            state[kv.Key] = common
                        }
                    }
                    thenAliases.IntersectWith(elseAliases)
                    aliases.UnionWith(thenAliases)
                }
                processed.Add(condAddr)
                exitAliases[condAddr] = HashSet[VariableSymbol](aliases)
                return
            }
            case switchExpr is BoundSwitchExpression {
                CollectConditionNonNullAssignments(
                    switchExpr.Discriminant,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case spill is BoundSpillSequenceExpression {
                for stmt in spill.SideEffects {
                    if stmt is BoundExpressionStatement exprStmt {
                        CollectConditionNonNullAssignments(
                            exprStmt.Expression,
                            state,
                            aliases,
                            processed,
                            exitAliases,
                            includeNullableNullCoalescing
                        )
                    } else if stmt is BoundVariableDeclaration varDecl && varDecl.Initializer != nil {
                        CollectConditionNonNullAssignments(
                            varDecl.Initializer,
                            state,
                            aliases,
                            processed,
                            exitAliases,
                            includeNullableNullCoalescing
                        )
                    } else {
                        ClearAssignedRootsAndUpdateAliases(stmt, state, aliases)
                    }
                }
                CollectConditionNonNullAssignments(
                    spill.Value,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case managedRef is BoundManagedReferenceExpression {
                CollectConditionNonNullAssignments(
                    managedRef.Location,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case evtSub is BoundEventSubscriptionExpression {
                CollectConditionNonNullAssignments(
                    evtSub.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                CollectConditionNonNullAssignments(
                    evtSub.Handler,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case clrEvtSub is BoundClrEventSubscriptionExpression {
                CollectConditionNonNullAssignments(
                    clrEvtSub.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
                CollectConditionNonNullAssignments(
                    clrEvtSub.Handler,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case methodGroup is BoundMethodGroupExpression {
                CollectConditionNonNullAssignments(
                    methodGroup.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case clrMethodGroup is BoundClrMethodGroupExpression {
                CollectConditionNonNullAssignments(
                    clrMethodGroup.Receiver,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case throwExpr is BoundThrowExpression {
                CollectConditionNonNullAssignments(
                    throwExpr.Expression,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
            case block is BoundBlockExpression {
                for stmt in block.Statements {
                    if stmt is BoundExpressionStatement exprStmt {
                        CollectConditionNonNullAssignments(
                            exprStmt.Expression,
                            state,
                            aliases,
                            processed,
                            exitAliases,
                            includeNullableNullCoalescing
                        )
                    } else if stmt is BoundVariableDeclaration varDecl && varDecl.Initializer != nil {
                        CollectConditionNonNullAssignments(
                            varDecl.Initializer,
                            state,
                            aliases,
                            processed,
                            exitAliases,
                            includeNullableNullCoalescing
                        )
                    } else {
                        ClearAssignedRootsAndUpdateAliases(stmt, state, aliases)
                    }
                }
                CollectConditionNonNullAssignments(
                    block.Expression,
                    state,
                    aliases,
                    processed,
                    exitAliases,
                    includeNullableNullCoalescing
                )
            }
        }
        let nextAliases = ApplyExpressionEffects(node, state, aliases, processed, exitAliases)
        aliases.Clear()
        aliases.UnionWith(nextAliases)
        if node is BoundAssignmentExpression assigned &&
            TryClassifyNonNullAssignment(assigned, out var variable, out var type, includeNonNullableStorage: true) {
            state[AccessPath.ForVariable(variable!!)] = type!!
        } else if TryExtractNullCoalescingAssignmentFromExpression(node, out var ncaAssign) && ncaAssign != nil {
            if !(ncaAssign.Variable.Type is NullableTypeSymbol) {
                let path = AccessPath.ForVariable(ncaAssign.Variable)
                if DischargesNullableWidening(node, path, NullableTypeSymbol.Get(ncaAssign.Variable.Type)) {
                    state[path] = ncaAssign.Variable.Type
                }
            } else if includeNullableNullCoalescing &&
                TryClassifyNonNullAssignment(ncaAssign, out var ncaVar, out var ncaUnderlying) &&
                ncaVar != nil &&
                ncaUnderlying != nil {
                state[AccessPath.ForVariable(ncaVar)] = ncaUnderlying
            }
        } else if node is BoundCallOperationExpression callOp {
            for child in callOp.ChildNodes {
                if child is BoundAddressOfExpression{IsReadOnly: false, Operand: BoundVariableExpression outVar} &&
                    !(outVar.Variable.Type is NullableTypeSymbol) {
                    let path = AccessPath.ForVariable(outVar.Variable)
                    if DischargesNullableWidening(node, path, NullableTypeSymbol.Get(outVar.Variable.Type)) {
                        state[path] = outVar.Variable.Type
                    }
                }
            }
        }
        processed.Add(node)
        exitAliases[node] = HashSet[VariableSymbol](aliases)
    }

    // ADR-0208 R18 (#5545 shape 5): removes from [`state`](paramref) the facts of an earlier operand that the later
    // operand [`operand`](paramref) can invalidate. A stable member path's members are immutable, so only a write or
    // unknown write that can replace its root removes it.
    private func ClearOperandFacts(
        operand BoundExpression,
        state Dictionary[AccessPath, TypeSymbol],
        callableAliases IReadOnlyCollection[VariableSymbol]
    ) {
        if state.Count == 0 {
            return
        }
        let operandSyntax = operand.Syntax
        if operandSyntax != nil {
            EnsureClosureAssignedNames(operandSyntax)
        }
        let collector = NewCollector(nil, callableAliases)
        collector.VisitExpression(operand)
        let filterWrites = if operandSyntax != nil && (collector.MayMutateMemberPaths || collector.ContainsTry) {
            let filters = CollectCatchFiltersAbove(operandSyntax)
            if filters.Count > 0 {
                CollectEnclosingFilterWrites(filters)
            } else {
                default(List[(TryBlock SyntaxNode?, Names HashSet[string])]?)
            }
        } else {
            default(List[(TryBlock SyntaxNode?, Names HashSet[string])]?)
        }
        let syntaxMutatesMembers = operandSyntax != nil && SyntaxMayMutateMemberPaths(operandSyntax)
        for entry in state.ToArray() {
            let path = entry.Key
            let rootPath = AccessPath.ForVariable(path.Root)
            if filterWrites != nil &&
                (
                FilterWritesVariable(filterWrites, path.Root) ||
                    MayBeMutatedByUnknownCallable(
                    if path.HasMembers && !IsExternalStorageAlias(path.Root) && HasSeparateMemberPathLinks(path) {
                        rootPath
                    } else {
                        path
                    }
                )
            ) {
                state.Remove(path)
                continue
            }
            if path.HasMembers && !IsExternalStorageAlias(path.Root) {
                if OperandKillsStableMemberPath(collector, path, syntaxMutatesMembers) {
                    state.Remove(path)
                }
                continue
            }
            if MayBeMutatedByUnknownWrite(collector, path) || collector.MayMutateGlobalRoot(path.Root, entry.Value) ||
                DropsOnMemberMutation(
                path,
                syntaxMutatesMembers || collector.MayMutateMemberPaths || collector.ByReferenceWritesReach(path),
                collector.MayWriteStorageOf(path)
            ) ||
                collector.InvalidatesNarrowing(path.Root, entry.Value) || collector.Roots.Contains(path.Root) {
                state.Remove(path)
            }
        }
    }

    // ADR-0208 R5, R12, R20 and R21 (#5832, #5843): the one rule for a fact on a member path whose root names no
    // external storage, at an operand of a condition. Its links are stable, so a call replaces the fact only by
    // replacing the root or when a link is declared in a type with explicit or unknown layout, where another field can
    // share the link's storage. A member write that is not separate (a type with explicit layout, an imported type, a
    // `let` link, an index, indirect or imported write: `HasMemberStorageWrite`) or a separate write through another
    // by-reference root (`ByReferenceWritesReach`) can store into a link, as in a statement (`StatementKillsPath`).
    internal func OperandKillsStableMemberPath(
        collector AssignedRootsCollector,
        path AccessPath,
        syntaxMutatesMembers bool
    ) bool {
        let rootPath = AccessPath.ForVariable(path.Root)
        return collector.AssignsRoot(path.Root) || collector.HasMemberStorageWrite || collector.ByReferenceWritesReach(
            path
        ) ||
            MayBeMutatedByUnknownWrite(collector, rootPath) ||
            (
            (syntaxMutatesMembers || collector.MayMutateMemberPaths) &&
                (MayBeMutatedByUnknownCallable(rootPath) || !HasSeparateMemberPathLinks(path))
        )
    }

    // An unknown callable can reach a member path, a global or an implicit
    // member, a by-reference parameter or local, and a plain local or
    // parameter only when some closure of the enclosing function assigns it.
    // Treating every mutable local as mutable dropped the narrowing of
    // unrelated locals after any call to a local lambda.
    private func MayBeMutatedByUnknownCallable(path AccessPath) bool -> path.HasMembers ||
        (
        (!path.Root.IsReadOnly || IsByReferenceRoot(path.Root)) &&
            (
            path.Root is not(LocalVariableSymbol or ParameterSymbol) ||
                IsByReferenceRoot(path.Root) ||
                binderCtx.MayBeAssignedByClosure(path.Root)
        )
    )

    private func MayBeMutatedByUnknownWrite(mutations AssignedRootsCollector, path AccessPath) bool ->
    MayBeMutatedByUnknownWrite(mutations.MayMutateAnyRoot, mutations.MayMutateAnyRootViaPointer, path) ||
        (mutations.MayRunEscapedClosureOn(path.Root) && MayBeMutatedByEscapedClosure(path.Root))

    // ADR-0208 R15 (#5237): a node that runs source code can run a closure that escaped and assigns [`root`](paramref),
    // or the plain variable that a `ref` local names. A by-reference parameter keeps its fact (amendment A3).
    private func MayBeMutatedByEscapedClosure(root VariableSymbol) bool {
        // The common case: no closure of the function assigns anything.
        if binderCtx.HasNoClosureAssignedNames() {
            return false
        }
        // A plain variable is its own chain; only a `ref` local needs the alias walk.
        if root is not LocalVariableSymbol{RefKind: not RefKind.None} {
            return NarrowingState.OwnsClosureWritableStorage(root) && binderCtx.MayBeAssignedByClosure(root)
        }
        for member in AliasChain(root) {
            if NarrowingState.OwnsClosureWritableStorage(member) && binderCtx.MayBeAssignedByClosure(member) {
                return true
            }
        }
        return false
    }

    // ADR-0208 R15 (#5482): whether a closure of the function may assign [`alias`](paramref) or the plain variable
    // that a `ref` local names. The exit state of a statement and the header of a construct ask this about the storage an alias names, like
    // MayBeMutatedByEscapedClosure does for a narrowing fact, not about the alias's own name.
    private func NamesClosureAssignedStorage(alias VariableSymbol) bool {
        if binderCtx.HasNoClosureAssignedNames() {
            return false
        }
        if binderCtx.MayBeAssignedByClosure(alias) {
            return true
        }
        return alias is LocalVariableSymbol{RefKind: not RefKind.None} && MayBeMutatedByEscapedClosure(alias)
    }

    // The same decision from the two flags, for the region walker of ADR-0213 (slice L0).
    private func MayBeMutatedByUnknownWrite(mayMutateAnyRoot bool, viaPointer bool, path AccessPath) bool -> (
        viaPointer && (path.HasMembers || !path.Root.IsReadOnly || IsByReferenceRoot(path.Root))
    ) ||
        (mayMutateAnyRoot && MayBeMutatedByUnknownCallable(path))

    // Binding a header expression (an `if` condition, a switch discriminant or
    // guard, a catch filter) never runs the post-statement alias update, but
    // the expression can create or invoke a closure that reassigns a callable
    // alias before the nested bodies are bound. Fold its effects into the alias
    // state now: an alias the header assigns, or that an unknown callable in the
    // header can assign, is no longer known to be external (fail-safe).
    private func ApplyHeaderCallableEffects(header BoundExpression?) HashSet[VariableSymbol]? {
        if header == nil || externalCallableAliases.Count == 0 {
            return nil
        }
        let before = HashSet[VariableSymbol](externalCallableAliases)
        RemoveHeaderAffectedAliases(externalCallableAliases, header)
        SyncExpressionCallableAliasesNow()
        before.ExceptWith(externalCallableAliases)
        return before
    }

    // The one header rule: an alias that [`header`](paramref) assigns, or that an unknown callable in it can assign,
    // is no longer known to be external.
    private func RemoveHeaderAffectedAliases(aliases HashSet[VariableSymbol], header BoundExpression) {
        if ContainsUserLabel(header) {
            aliases.Clear()
            return
        }
        let collector = NewCollector(nil, aliases)
        collector.VisitExpression(header)
        if collector.MayMutateAnyRootViaPointer {
            aliases.Clear()
        }
        RemoveAssignedAliases(aliases, collector)
        if collector.MayMutateAnyRoot || collector.MayRunEscapedClosure {
            aliases.IntersectWith(collector.DefinitelyExternalFunctionValues)
        }
        RemoveCollectorFilterAffectedAliases(aliases, header.Syntax, collector)
    }

    /// ADR-0208 R9, R10, R11, R12, R14, R15 (#5637, #5238): applies the narrowing and callable-alias effects
    /// of [`operand`](paramref) before a later operand of the same expression is bound.
    internal func ApplySubExpressionNarrowingEffects(
        syntax SyntaxNode?,
        operand BoundExpression?,
        entryAliases HashSet[VariableSymbol]? = nil
    ) {
        if operand == nil {
            return
        }
        if syntax != nil && !verifyingArgumentSyntaxes.Contains(syntax) && deferredArgumentSnapshots.ContainsKey(
            syntax
        ) {
            initialArgumentBySyntax[syntax] = operand
            syntaxByTrackedArgument[operand] = syntax
        }
        let expression = if syntax != nil && preConvertedEffectsBySyntax.TryGetValue(syntax, out var preConverted) {
            preConverted
        } else {
            operand
        }
        ApplySubExpressionNarrowingEffectsCore(syntax, expression, entryAliases)
    }

    private func ApplySubExpressionNarrowingEffectsCore(
        syntax SyntaxNode?,
        operand BoundExpression?,
        entryAliases HashSet[VariableSymbol]? = nil
    ) {
        if operand == nil {
            return
        }
        var expression = operand
        while true {
            if expression is BoundAddressOfExpression address {
                expression = address.Operand
                continue
            }
            if expression is BoundConversionExpression conv && conv.Syntax is not CallExpressionSyntax {
                expression = conv.Expression
                continue
            }
            break
        }
        if expression is BoundConditionalAddressExpression conditionalAddress {
            ApplySubExpressionNarrowingEffectsCore(syntax, conditionalAddress.Condition)
            let postCondition = CaptureNarrowingBindSnapshot()
            ApplySubExpressionNarrowingEffectsCore(syntax, conditionalAddress.WhenTrueOperand)
            let afterTrue = CaptureNarrowingBindSnapshot()
            RestoreNarrowingBindSnapshot(postCondition)
            ApplySubExpressionNarrowingEffectsCore(syntax, conditionalAddress.WhenFalseOperand)
            let afterFalse = CaptureNarrowingBindSnapshot()
            JoinBranchNarrowingSnapshots(
                conditionalAddress.WhenTrueOperand.Type,
                afterTrue,
                conditionalAddress.WhenFalseOperand.Type,
                afterFalse
            )
            return
        }
        if fullyAppliedSubExpressions.Contains(expression) {
            if fullyAppliedExitAliases.TryGetValue(expression, out var exitAliases) {
                externalCallableAliases.Clear()
                externalCallableAliases.UnionWith(exitAliases)
                SyncExpressionCallableAliasesNow()
            }
            return
        }
        if expression is BoundConditionalExpression conditionalExpr {
            ApplySubExpressionNarrowingEffectsCore(
                conditionalExpr.Condition.Syntax ?? syntax,
                conditionalExpr.Condition
            )
            let postCondition = CaptureNarrowingBindSnapshot()
            if conditionalExpr.WhenTrue.Type != TypeSymbol.Never {
                ApplySubExpressionNarrowingEffectsCore(
                    conditionalExpr.WhenTrue.Syntax ?? syntax,
                    conditionalExpr.WhenTrue
                )
            }
            let afterTrue = CaptureNarrowingBindSnapshot()
            RestoreNarrowingBindSnapshot(postCondition)
            if conditionalExpr.WhenFalse.Type != TypeSymbol.Never {
                ApplySubExpressionNarrowingEffectsCore(
                    conditionalExpr.WhenFalse.Syntax ?? syntax,
                    conditionalExpr.WhenFalse
                )
            }
            let afterFalse = CaptureNarrowingBindSnapshot()
            JoinBranchNarrowingSnapshots(
                conditionalExpr.WhenTrue.Type,
                afterTrue,
                conditionalExpr.WhenFalse.Type,
                afterFalse
            )
            if fullyAppliedSubExpressions.Add(conditionalExpr) {
                fullyAppliedSubExpressionsLog.Add(conditionalExpr)
                fullyAppliedExitAliases[conditionalExpr] = HashSet[VariableSymbol](externalCallableAliases)
            }
            return
        }
        if expression is BoundBinaryExpression binExpr && appliedBinaryLefts.Contains(binExpr) {
            binaryRightEntryAliases.TryGetValue(binExpr, out var rightAliases)
            ApplySubExpressionNarrowingEffectsCore(binExpr.Right.Syntax, binExpr.Right, rightAliases)
            if BinaryEqualityRunsUserCode(binExpr) {
                let eqAnchor = syntax ?? binExpr.Syntax ?? FindSyntaxAnchor(binExpr)
                if eqAnchor != nil && (HasAnyActiveNarrowings() || externalCallableAliases.Count > 0) {
                    let dummyEq = BoundBinaryExpression(
                        binExpr.Syntax,
                        BoundDefaultExpression(binExpr.Syntax, binExpr.Left.Type),
                        binExpr.Op,
                        BoundDefaultExpression(binExpr.Syntax, binExpr.Right.Type),
                        binExpr.IsChecked
                    )
                    let eqAliasesAtEntry = externalCallableAliases.ToArray()
                    let eqStmt = BoundExpressionStatement(eqAnchor, dummyEq)
                    InvalidateNarrowingsForAssignedVariables(eqAnchor, eqStmt)
                    UpdateExternalCallableAliases(eqStmt, eqAliasesAtEntry)
                }
            }
            if fullyAppliedSubExpressions.Add(binExpr) {
                fullyAppliedSubExpressionsLog.Add(binExpr)
                fullyAppliedExitAliases[binExpr] = HashSet[VariableSymbol](externalCallableAliases)
            }
            return
        }
        var effectiveEntryAliases = entryAliases
        if effectiveEntryAliases == nil && expressionEntryAliases.TryGetValue(expression, out var recordedEntry) {
            effectiveEntryAliases = recordedEntry
        }
        if effectiveEntryAliases != nil {
            externalCallableAliases.Clear()
            externalCallableAliases.UnionWith(effectiveEntryAliases)
            SyncExpressionCallableAliasesNow()
        }
        if !HasAnyActiveNarrowings() &&
            externalCallableAliases.Count == 0 &&
            expression is not BoundAssignmentExpression &&
            expression is not BoundBlockExpression &&
            expression.Syntax is not NullCoalescingAssignmentExpressionSyntax {
            if expression is not BoundErrorExpression && fullyAppliedSubExpressions.Add(expression) {
                fullyAppliedSubExpressionsLog.Add(expression)
                fullyAppliedExitAliases[expression] = HashSet[VariableSymbol](externalCallableAliases)
            }
            return
        }
        if ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(expression, out var branchySyntax) &&
            branchySyntax != nil &&
            ExpressionBinder
            .IsTargetDependentBlockArgumentSyntax(branchySyntax) {
            ApplyDeferredBlockArgumentNarrowingEffects(branchySyntax)
            return
        }
        let anchor = syntax ?? expression.Syntax ?? FindSyntaxAnchor(expression)
        if anchor == nil || ExpressionHasNoNarrowingEffects(expression, anchor) {
            if expression is not BoundErrorExpression && fullyAppliedSubExpressions.Add(expression) {
                fullyAppliedSubExpressionsLog.Add(expression)
                fullyAppliedExitAliases[expression] = HashSet[VariableSymbol](externalCallableAliases)
            }
            return
        }
        let aliasesAtEntry = externalCallableAliases.ToArray()
        let statement = BoundExpressionStatement(anchor, expression)
        InvalidateNarrowingsForAssignedVariables(anchor, statement)
        UpdateExternalCallableAliases(statement, aliasesAtEntry)
        if binderCtx
            .NarrowedVariables
            .Count > 0 &&
            TryClassifyNullCoalescingExpressionNonNullAssignments(expression, aliasesAtEntry) is {} ncaNarrowed {
            let topFrame = binderCtx.NarrowedVariables[binderCtx.NarrowedVariables.Count - 1]
            for kv in ncaNarrowed {
                SetPersistentNarrowing(topFrame, kv.Key, kv.Value)
            }
        }
        if expression is not BoundErrorExpression && fullyAppliedSubExpressions.Add(expression) {
            fullyAppliedSubExpressionsLog.Add(expression)
            fullyAppliedExitAliases[expression] = HashSet[VariableSymbol](externalCallableAliases)
        }
    }

    private func FindSyntaxAnchor(node BoundExpression?) SyntaxNode? -> switch node {
        case nil: nil
        case nonNull is BoundExpression when nonNull.Syntax != nil: nonNull.Syntax
        case propAccess is BoundPropertyAccessExpression: FindSyntaxAnchor(propAccess.Receiver)
        case fieldAccess is BoundFieldAccessExpression: FindSyntaxAnchor(fieldAccess.Receiver)
        case clrProp is BoundClrPropertyAccessExpression: FindSyntaxAnchor(clrProp.Receiver)
        case clrIndex is BoundClrIndexExpression: FindSyntaxAnchor(clrIndex.Target)
        case index is BoundIndexExpression: FindSyntaxAnchor(index.Target)
        case conv is BoundConversionExpression: FindSyntaxAnchor(conv.Expression)
        case unary is BoundUnaryExpression: FindSyntaxAnchor(unary.Operand)
        case binary is BoundBinaryExpression: FindSyntaxAnchor(binary.Left) ?? FindSyntaxAnchor(binary.Right)
        case instCall is BoundUserInstanceCallExpression: FindSyntaxAnchor(instCall.Receiver)
        case impInstCall is BoundImportedInstanceCallExpression: FindSyntaxAnchor(impInstCall.Receiver)
        case cond is BoundConditionalExpression: FindSyntaxAnchor(cond.Condition) ??
            FindSyntaxAnchor(cond.WhenTrue) ??
            FindSyntaxAnchor(cond.WhenFalse)
        case condAddr is BoundConditionalAddressExpression: FindSyntaxAnchor(condAddr.Condition) ??
            FindSyntaxAnchor(condAddr.WhenTrueOperand) ??
            FindSyntaxAnchor(condAddr.WhenFalseOperand)
        case switchExpr is BoundSwitchExpression: FindSwitchSyntaxAnchor(switchExpr)
        case spill is BoundSpillSequenceExpression: FindSyntaxAnchor(spill.Value)
        case addr is BoundAddressOfExpression: FindSyntaxAnchor(addr.Operand)
        case deref is BoundDereferenceExpression: FindSyntaxAnchor(deref.Operand)
        case managedRef is BoundManagedReferenceExpression: FindSyntaxAnchor(managedRef.Location)
        default: nil
    }

    private func FindSwitchSyntaxAnchor(switchExpr BoundSwitchExpression) SyntaxNode? {
        var anchor = FindSyntaxAnchor(switchExpr.Discriminant)
        if anchor == nil {
            for arm in switchExpr.Arms {
                anchor = arm.Syntax ?? FindSyntaxAnchor(arm.Guard) ?? FindSyntaxAnchor(arm.Result)
                if anchor != nil {
                    break
                }
            }
        }
        var current = anchor
        while current != nil {
            if current is SwitchExpressionSyntax {
                return current
            }
            current = current.Parent
        }
        return anchor
    }

    private func ApplyDeferredBlockArgumentNarrowingEffects(syntax ExpressionSyntax) {
        var current = syntax
        while current is ParenthesizedExpressionSyntax paren {
            current = paren.Expression
        }
        if current is BlockExpressionSyntax block {
            let diagMark = Diagnostics.Count
            $scope = BoundScope($scope)
            try {
                if !block.Statements.IsDefaultOrEmpty {
                    let _ = BindStatementList(block.Statements, trailingStatement: nil, trailingSyntax: nil)
                }
                if block.Expression != nil {
                    ApplyDeferredBlockArgumentNarrowingEffects(block.Expression)
                }
            } finally {
                $scope = $scope.Pop()
                Diagnostics.TruncateTo(diagMark)
            }
            return
        }
        if current is ConditionalExpressionSyntax conditional {
            ApplyDeferredBlockArgumentNarrowingEffects(conditional.Condition)
            let postCond = CaptureNarrowingBindSnapshot()
            ApplyDeferredBlockArgumentNarrowingEffects(conditional.WhenTrue)
            let afterTrue = CaptureNarrowingBindSnapshot()
            RestoreNarrowingBindSnapshot(postCond)
            ApplyDeferredBlockArgumentNarrowingEffects(conditional.WhenFalse)
            let afterFalse = CaptureNarrowingBindSnapshot()
            JoinBranchNarrowingSnapshots(nil, afterTrue, nil, afterFalse)
            return
        }
        if current is IfExpressionSyntax ifExpr {
            let diagMark = Diagnostics.Count
            $scope = BoundScope($scope)
            try {
                if ifExpr.Initializer is {} initStmt {
                    let _ = BindStatementList(
                        ImmutableArray.Create(initStmt),
                        trailingStatement: nil,
                        trailingSyntax: nil
                    )
                }
                ApplyDeferredBlockArgumentNarrowingEffects(ifExpr.Condition)
                let postCond = CaptureNarrowingBindSnapshot()
                ApplyDeferredBlockArgumentNarrowingEffects(ifExpr.ThenBlock)
                let afterTrue = CaptureNarrowingBindSnapshot()
                RestoreNarrowingBindSnapshot(postCond)
                if ifExpr.ElseExpression != nil {
                    ApplyDeferredBlockArgumentNarrowingEffects(ifExpr.ElseExpression)
                }
                let afterFalse = CaptureNarrowingBindSnapshot()
                JoinBranchNarrowingSnapshots(nil, afterTrue, nil, afterFalse)
            } finally {
                $scope = $scope.Pop()
                Diagnostics.TruncateTo(diagMark)
            }
            return
        }
        if current is IfLetExpressionSyntax ifLetExpr {
            let diagMark = Diagnostics.Count
            $scope = BoundScope($scope)
            try {
                for binding in ifLetExpr.Bindings {
                    ApplyDeferredBlockArgumentNarrowingEffects(binding.Initializer)
                    var initExpr = bindExpression(binding.Initializer, false)
                    if binding.TypeClause != nil &&
                        bindTypeClause(binding.TypeClause) is {} declaredType &&
                        initExpr is not BoundErrorExpression {
                        let declaredUnderlying = if declaredType is NullableTypeSymbol declNullable {
                            declNullable.UnderlyingType
                        } else {
                            declaredType
                        }
                        initExpr = conversions.BindConversion(
                            binding.Initializer.Location,
                            initExpr,
                            NullableTypeSymbol.Get(declaredUnderlying)
                        )
                        ApplySubExpressionNarrowingEffects(binding.Initializer, initExpr)
                    }
                    let valueType = if initExpr.Type is NullableTypeSymbol nullable {
                        nullable.UnderlyingType
                    } else {
                        initExpr.Type
                    }
                    let local = LocalVariableSymbol(binding.Identifier.ValueText, true, valueType)
                    $scope.TryDeclareVariable(local)
                }
                if ifLetExpr.Guard != nil {
                    ApplyDeferredBlockArgumentNarrowingEffects(ifLetExpr.Guard)
                }
                let postHeader = CaptureNarrowingBindSnapshot()
                ApplyDeferredBlockArgumentNarrowingEffects(ifLetExpr.ThenBlock)
                let afterTrue = CaptureNarrowingBindSnapshot()
                RestoreNarrowingBindSnapshot(postHeader)
                if ifLetExpr.ElseExpression != nil {
                    ApplyDeferredBlockArgumentNarrowingEffects(ifLetExpr.ElseExpression)
                }
                let afterFalse = CaptureNarrowingBindSnapshot()
                JoinBranchNarrowingSnapshots(nil, afterTrue, nil, afterFalse)
            } finally {
                $scope = $scope.Pop()
                Diagnostics.TruncateTo(diagMark)
            }
            return
        }
        if current is SwitchExpressionSyntax switchExpr {
            let diagMark = Diagnostics.Count
            try {
                let discriminant = bindExpression(switchExpr.Expression, false)
                ApplyConditionEffectsAndHeaderAliases(switchExpr.Expression, discriminant)
                let armExitSnapshots = List[NarrowingBindSnapshot](switchExpr.Arms.Length)
                var hasDefault = false
                for arm in switchExpr.Arms {
                    $scope = BoundScope($scope)
                    try {
                        if arm.IsDefault {
                            hasDefault = true
                        } else if arm.Value is {} armValue {
                            if discriminant.Type != TypeSymbol.Error {
                                let header = BindSwitchArmHeader(
                                    armValue,
                                    arm.Guard,
                                    discriminant,
                                    discriminantStale: false
                                )
                                if header.Pattern is BoundDiscardPattern && arm.Guard == nil {
                                    hasDefault = true
                                }
                            } else if arm.Guard != nil {
                                ApplyDeferredBlockArgumentNarrowingEffects(arm.Guard)
                            }
                        }
                        let postHeader = CaptureNarrowingBindSnapshot()
                        ApplyDeferredBlockArgumentNarrowingEffects(arm.Result)
                        armExitSnapshots.Add(CaptureNarrowingBindSnapshot())
                        RestoreNarrowingBindSnapshot(postHeader)
                    } finally {
                        $scope = $scope.Pop()
                    }
                }
                if armExitSnapshots.Count > 0 {
                    let fallthroughNoMatch = CaptureNarrowingBindSnapshot()
                    RestoreNarrowingBindSnapshot(armExitSnapshots[0])
                    for var i = 1; i < armExitSnapshots.Count; i++ {
                        IntersectNarrowingWithSnapshot(armExitSnapshots[i])
                    }
                    if !hasDefault &&
                        (
                        discriminant.Type == TypeSymbol.Error || !ExhaustivenessAnalyzer.IsExhaustiveDiscriminant(
                            discriminant.Type
                        )
                    ) {
                        IntersectNarrowingWithSnapshot(fallthroughNoMatch)
                    }
                }
            } finally {
                Diagnostics.TruncateTo(diagMark)
            }
            return
        }
        if current is BinaryExpressionSyntax binaryExpr {
            ApplyDeferredBlockArgumentNarrowingEffects(binaryExpr.Left)
            ApplyDeferredBlockArgumentNarrowingEffects(binaryExpr.Right)
            return
        }
        if !ExpressionBinder.IsTargetDependentExpressionSyntax(current) {
            let diagMark = Diagnostics.Count
            try {
                let bound = bindExpression(current, false)
                ApplySubExpressionNarrowingEffects(current, bound)
            } finally {
                Diagnostics.TruncateTo(diagMark)
            }
        }
    }

    private func IsPatternContainerSyntax(syntax SyntaxNode) bool ->
    syntax is PropertyPatternFieldSyntax ||
        syntax is PropertyPatternSyntax ||
        syntax is ListPatternSyntax ||
        syntax is BinaryPatternSyntax

    internal func VerifyCallArgumentsAfterConversions(
        arguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        boundCall BoundExpression?,
        rebindCall(() -> BoundExpression)? = nil
    ) BoundExpression? {
        if arguments.Count < 2 ||
            boundCall == nil ||
            boundCall is BoundErrorExpression ||
            verifyingArgumentSyntaxes.Contains(OverloadResolver.UnwrapNamedArgumentValue(arguments[0])) ||
            initialArgumentBySyntax.Count == 0 {
            return boundCall
        }
        var targetSyntaxes HashSet[SyntaxNode]? = nil
        for var i = 0; i < arguments.Count; i++ {
            let argSyntax = OverloadResolver.UnwrapNamedArgumentValue(arguments[i])
            if initialArgumentBySyntax.ContainsKey(argSyntax) {
                if targetSyntaxes == nil {
                    targetSyntaxes = HashSet[SyntaxNode]()
                }
                targetSyntaxes.Add(argSyntax)
            }
        }
        if targetSyntaxes == nil || targetSyntaxes.Count == 0 {
            return boundCall
        }
        let finalBySyntax = Dictionary[SyntaxNode, BoundExpression]()
        CollectFinalArgumentsByOriginSyntax(boundCall, targetSyntaxes, finalBySyntax)
        var firstChanged = -1
        for var i = 0; i < arguments.Count - 1; i++ {
            let argSyntax = OverloadResolver.UnwrapNamedArgumentValue(arguments[i])
            if initialArgumentBySyntax.TryGetValue(argSyntax, out var initial) && finalBySyntax.TryGetValue(
                argSyntax,
                out var finalArg
            ) &&
                ConversionAddedNarrowingEffects(initial, finalArg, argSyntax) {
                firstChanged = i
                break
            }
        }
        if firstChanged < 0 {
            return boundCall
        }
        let firstSyntax = OverloadResolver.UnwrapNamedArgumentValue(arguments[firstChanged])
        if !deferredArgumentSnapshots.TryGetValue(firstSyntax, out var snapshotAtFirst) {
            return boundCall
        }
        for var i = 0; i < arguments.Count; i++ {
            initialArgumentBySyntax.Remove(OverloadResolver.UnwrapNamedArgumentValue(arguments[i]))
        }
        let addedVerifying = List[SyntaxNode](arguments.Count)
        for var i = 0; i < arguments.Count; i++ {
            let unwrapped = OverloadResolver.UnwrapNamedArgumentValue(arguments[i])
            if verifyingArgumentSyntaxes.Add(unwrapped) {
                addedVerifying.Add(unwrapped)
            }
        }
        try {
            let arg0Syntax = OverloadResolver.UnwrapNamedArgumentValue(arguments[0])
            if rebindCall != nil && deferredArgumentSnapshots.TryGetValue(arg0Syntax, out var snapshotAtZero) {
                for var i = 0; i < arguments.Count; i++ {
                    let argSyntax = OverloadResolver.UnwrapNamedArgumentValue(arguments[i])
                    if finalBySyntax.TryGetValue(argSyntax, out var finalArg) {
                        preConvertedEffectsBySyntax[argSyntax] = finalArg
                    }
                }
                try {
                    for var j = 0; j < arguments.Count; j++ {
                        $scope.RemoveVariablesDeclaredInSpan(arguments[j].SyntaxTree, arguments[j].Span)
                        let _ = Diagnostics.ReplaceDiagnosticsIn(arguments[j].Location, () -> 0)
                    }
                    RestoreNarrowingBindSnapshot(snapshotAtZero)
                    return rebindCall()
                } finally {
                    for var i = 0; i < arguments.Count; i++ {
                        preConvertedEffectsBySyntax.Remove(OverloadResolver.UnwrapNamedArgumentValue(arguments[i]))
                    }
                }
            }
            let replacements = Dictionary[BoundExpression, BoundExpression](ReferenceEqualityComparer.Instance)
            RestoreNarrowingBindSnapshot(snapshotAtFirst)
            ApplySubExpressionNarrowingEffects(firstSyntax, finalBySyntax[firstSyntax])
            for var j = firstChanged + 1; j < arguments.Count; j++ {
                let argSyntax = OverloadResolver.UnwrapNamedArgumentValue(arguments[j])
                if argSyntax is not RefArgumentExpressionSyntax{IsInlineDeclaration: true} {
                    $scope.RemoveVariablesDeclaredInSpan(arguments[j].SyntaxTree, arguments[j].Span)
                }
                var finalArg BoundExpression? = nil
                if !finalBySyntax.TryGetValue(argSyntax, out finalArg) {
                    initialArgumentBySyntax.TryGetValue(argSyntax, out finalArg)
                }
                if argSyntax is RefArgumentExpressionSyntax refArg {
                    if !refArg.IsInlineDeclaration && bindRefArgumentExpression != nil {
                        let reboundRef = Diagnostics.ReplaceDiagnosticsIn(
                            refArg.Location,
                            () -> bindRefArgumentExpression!!(refArg)
                        )
                        if finalArg is BoundAddressOfExpression finalAddr &&
                            reboundRef is BoundAddressOfExpression reboundAddr &&
                            !object
                            .ReferenceEquals(reboundAddr.Operand, finalAddr.Operand) {
                            let rebuiltAddr = finalAddr.Update(reboundAddr.Operand)
                            replacements[finalAddr] = rebuiltAddr
                            finalArg = rebuiltAddr
                        } else if finalArg is BoundConditionalAddressExpression finalCondAddr &&
                            reboundRef is BoundConditionalAddressExpression {
                            replacements[finalCondAddr] = reboundRef
                            finalArg = reboundRef
                        }
                    }
                    if finalArg != nil {
                        ApplySubExpressionNarrowingEffects(argSyntax, finalArg)
                    }
                    continue
                }
                if argSyntax is LambdaExpressionSyntax {
                    if finalArg != nil {
                        ApplySubExpressionNarrowingEffects(argSyntax, finalArg)
                    }
                    continue
                }
                let targetType = finalArg?.Type
                let hasUsableTarget = targetType != nil &&
                    targetType != TypeSymbol.Error &&
                    targetType != TypeSymbol.Void &&
                    !TypeSymbol.ContainsTypeParameter(targetType)
                let convertedRebound = Diagnostics.ReplaceDiagnosticsIn(
                    argSyntax.Location,
                    () -> {
                        let rebound = if (
                            ExpressionBinder.IsTargetTypedBranchyArgumentSyntax(argSyntax) ||
                                ExpressionBinder.IsTargetDependentExpressionSyntax(argSyntax)
                        ) &&
                            hasUsableTarget {
                            bindExpressionWithTargetType(argSyntax, targetType!!)
                        } else {
                            bindExpression(argSyntax, false)
                        }
                        if rebound is not BoundErrorExpression && hasUsableTarget && rebound.Type != targetType {
                            return conversions.BindConversion(argSyntax.Location, rebound, targetType)
                        }
                        return rebound
                    }
                )
                if finalArg != nil && !object.ReferenceEquals(convertedRebound, finalArg) {
                    replacements[finalArg] = convertedRebound
                }
                ApplySubExpressionNarrowingEffects(argSyntax, convertedRebound)
            }
            if replacements.Count > 0 {
                return ReplaceCallArgumentRewriter(replacements).RewriteExpression(boundCall)
            }
            return boundCall
        } finally {
            for added in addedVerifying {
                verifyingArgumentSyntaxes.Remove(added)
            }
        }
    }

    private sealed class ReplaceCallArgumentRewriter : BoundTreeRewriter {
        private let replacements Dictionary[BoundExpression, BoundExpression]

        init(replacements Dictionary[BoundExpression, BoundExpression]) {
            this.replacements = replacements
        }

        open override func RewriteExpression(node BoundExpression) BoundExpression {
            if replacements.TryGetValue(node, out var replacement) {
                return replacement
            }
            return base.RewriteExpression(node)
        }
    }

    private func ConversionAddedNarrowingEffects(
        initial BoundExpression,
        finalArg BoundExpression,
        argSyntax SyntaxNode
    ) bool {
        if object.ReferenceEquals(initial, finalArg) {
            return false
        }
        if finalArg is BoundClrConversionCallExpression {
            return true
        }
        if finalArg is BoundCallExpression && object.ReferenceEquals(finalArg.ImplicitConversionOperand, initial) {
            return true
        }
        if ContainsConversionWithNarrowingEffects(finalArg, argSyntax) &&
            !ContainsConversionWithNarrowingEffects(initial, argSyntax) {
            return true
        }
        if ExpressionBinder.IsDeferredBranchyArgumentPlaceholder(initial, out _) {
            return false
        }
        return ExpressionHasNoNarrowingEffects(initial, argSyntax) &&
            !ExpressionHasNoNarrowingEffects(finalArg, argSyntax)
    }

    private func ContainsConversionWithNarrowingEffects(node BoundExpression?, argSyntax SyntaxNode) bool {
        if node == nil {
            return false
        }
        if node is BoundClrConversionCallExpression {
            return !ExpressionHasNoNarrowingEffects(node, argSyntax)
        }
        if node is BoundCallExpression call && call.ImplicitConversionOperand != nil {
            return !ExpressionHasNoNarrowingEffects(call, argSyntax)
        }
        switch node {
            case conv is BoundConversionExpression {
                return ContainsConversionWithNarrowingEffects(conv.Expression, argSyntax)
            }
            case block is BoundBlockExpression {
                return ContainsConversionWithNarrowingEffects(block.Expression, argSyntax)
            }
            case cond is BoundConditionalExpression {
                return ContainsConversionWithNarrowingEffects(cond.WhenTrue, argSyntax) ||
                    ContainsConversionWithNarrowingEffects(cond.WhenFalse, argSyntax)
            }
            case sw is BoundSwitchExpression {
                for arm in sw.Arms {
                    if ContainsConversionWithNarrowingEffects(arm.Result, argSyntax) {
                        return true
                    }
                }
                return false
            }
            case bin is BoundBinaryExpression {
                return ContainsConversionWithNarrowingEffects(bin.Left, argSyntax) ||
                    ContainsConversionWithNarrowingEffects(bin.Right, argSyntax)
            }
            default {
                return false
            }
        }
    }

    private func CollectFinalArgumentsByOriginSyntax(
        node BoundExpression?,
        targetSyntaxes HashSet[SyntaxNode],
        finalBySyntax Dictionary[SyntaxNode, BoundExpression]
    ) {
        if node == nil {
            return
        }
        if syntaxByTrackedArgument.TryGetValue(node, out var originSyntax) && targetSyntaxes.Contains(originSyntax) {
            finalBySyntax[originSyntax] = node
            return
        }
        if node.ImplicitConversionOperand is {} convOperand && syntaxByTrackedArgument.TryGetValue(
            convOperand,
            out var convOrigin
        ) &&
            targetSyntaxes.Contains(convOrigin) {
            finalBySyntax[convOrigin] = node
            return
        }
        if node is BoundClrConversionCallExpression clrConv && syntaxByTrackedArgument.TryGetValue(
            clrConv.Source,
            out var clrOrigin
        ) &&
            targetSyntaxes.Contains(clrOrigin) {
            finalBySyntax[clrOrigin] = node
            return
        }
        switch node {
            case block is BoundBlockExpression {
                for stmt in block.Statements {
                    switch stmt {
                        case decl is BoundVariableDeclaration {
                            CollectFinalArgumentsByOriginSyntax(decl.Initializer, targetSyntaxes, finalBySyntax)
                        }
                        case exprStmt is BoundExpressionStatement {
                            CollectFinalArgumentsByOriginSyntax(exprStmt.Expression, targetSyntaxes, finalBySyntax)
                        }
                    }
                }
                CollectFinalArgumentsByOriginSyntax(block.Expression, targetSyntaxes, finalBySyntax)
            }
            case call is BoundCallExpression {
                for arg in call.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case instCall is BoundUserInstanceCallExpression {
                for arg in instCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case ctorCall is BoundConstructorCallExpression {
                for arg in ctorCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case structLit is BoundStructLiteralExpression {
                for init in structLit.Initializers {
                    CollectFinalArgumentsByOriginSyntax(init.Value, targetSyntaxes, finalBySyntax)
                }
            }
            case impCall is BoundImportedCallExpression {
                for arg in impCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case impInstCall is BoundImportedInstanceCallExpression {
                for arg in impInstCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case clrStaticCall is BoundClrStaticCallExpression {
                for arg in clrStaticCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case clrCtorCall is BoundClrConstructorCallExpression {
                for arg in clrCtorCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case indirectCall is BoundIndirectCallExpression {
                for arg in indirectCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case fnPtrCall is BoundFunctionPointerInvocationExpression {
                for arg in fnPtrCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case nullCond is BoundNullConditionalAccessExpression {
                CollectFinalArgumentsByOriginSyntax(nullCond.WhenNotNull, targetSyntaxes, finalBySyntax)
            }
            case cond is BoundConditionalExpression {
                CollectFinalArgumentsByOriginSyntax(cond.WhenTrue, targetSyntaxes, finalBySyntax)
                CollectFinalArgumentsByOriginSyntax(cond.WhenFalse, targetSyntaxes, finalBySyntax)
            }
            case constrainedCall is BoundConstrainedStaticCallExpression {
                for arg in constrainedCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case baseClassCall is BoundBaseClassCallExpression {
                for arg in baseClassCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case baseIfaceCall is BoundBaseInterfaceCallExpression {
                for arg in baseIfaceCall.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case arr is BoundArrayCreationExpression {
                for elem in arr.Elements {
                    CollectFinalArgumentsByOriginSyntax(elem, targetSyntaxes, finalBySyntax)
                }
            }
            case tupleLit is BoundTupleLiteralExpression {
                for elem in tupleLit.Elements {
                    CollectFinalArgumentsByOriginSyntax(elem, targetSyntaxes, finalBySyntax)
                }
            }
            case clrIndex is BoundClrIndexExpression {
                for arg in clrIndex.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case clrIndexAssign is BoundClrIndexAssignmentExpression {
                for arg in clrIndexAssign.Arguments {
                    CollectFinalArgumentsByOriginSyntax(arg, targetSyntaxes, finalBySyntax)
                }
            }
            case deref is BoundDereferenceExpression {
                CollectFinalArgumentsByOriginSyntax(deref.Operand, targetSyntaxes, finalBySyntax)
            }
            case conv is BoundConversionExpression {
                CollectFinalArgumentsByOriginSyntax(conv.Expression, targetSyntaxes, finalBySyntax)
            }
            case addr is BoundAddressOfExpression {
                CollectFinalArgumentsByOriginSyntax(addr.Operand, targetSyntaxes, finalBySyntax)
            }
            case condAddr is BoundConditionalAddressExpression {
                CollectFinalArgumentsByOriginSyntax(condAddr.Condition, targetSyntaxes, finalBySyntax)
                CollectFinalArgumentsByOriginSyntax(condAddr.WhenTrueOperand, targetSyntaxes, finalBySyntax)
                CollectFinalArgumentsByOriginSyntax(condAddr.WhenFalseOperand, targetSyntaxes, finalBySyntax)
            }
            case unary is BoundUnaryExpression {
                CollectFinalArgumentsByOriginSyntax(unary.Operand, targetSyntaxes, finalBySyntax)
            }
        }
    }

    private let knownEffectFreeExpressions HashSet[BoundExpression] = HashSet[BoundExpression](
        ReferenceEqualityComparer.Instance
    )

    private func ExpressionHasNoNarrowingEffects(node BoundExpression?, syntax SyntaxNode? = nil) bool {
        if node == nil {
            return true
        }
        if syntax is CallExpressionSyntax {
            return false
        }
        if knownEffectFreeExpressions.Contains(node) {
            return true
        }
        let isEffectFree = switch node {
            case BoundLiteralExpression,
            BoundDefaultExpression,
            BoundVariableExpression,
            BoundTypeOfExpression,
            BoundSizeOfExpression,
            BoundUtf8StringExpression,
            BoundFunctionLiteralExpression,
            BoundFunctionPointerFromMethodExpression,
            BoundErrorExpression: true
            case methodGroup is BoundMethodGroupExpression: ExpressionHasNoNarrowingEffects(methodGroup.Receiver)
            case clrMethodGroup is BoundClrMethodGroupExpression: ExpressionHasNoNarrowingEffects(
                clrMethodGroup.Receiver
            )
            case conversion is BoundConversionExpression: conversion.Syntax is not CallExpressionSyntax &&
                ExpressionHasNoNarrowingEffects(conversion.Expression)
            case unary is BoundUnaryExpression: ExpressionHasNoNarrowingEffects(unary.Operand)
            case binary is BoundBinaryExpression: !BinaryEqualityRunsUserCode(binary) &&
                ExpressionHasNoNarrowingEffects(binary.Left) &&
                ExpressionHasNoNarrowingEffects(binary.Right)
            case field is BoundFieldAccessExpression: !StaticMemberAccessRunsUserCode(field) &&
                ExpressionHasNoNarrowingEffects(field.Receiver)
            case property is BoundPropertyAccessExpression: !SourcePropertyAccessRunsUserCode(property) &&
                !StaticMemberAccessRunsUserCode(property) &&
                ExpressionHasNoNarrowingEffects(property.Receiver)
            case clrAccess is BoundClrPropertyAccessExpression: !ClrAccessRunsUserCode(clrAccess) &&
                ExpressionHasNoNarrowingEffects(clrAccess.Receiver)
            case clrIndex is BoundClrIndexExpression: !ClrAccessRunsUserCode(clrIndex) &&
                ExpressionHasNoNarrowingEffects(clrIndex.Target) &&
                ExpressionsHaveNoNarrowingEffects(clrIndex.Arguments)
            case index is BoundIndexExpression: !NativeMapAccessRunsUserCode(index) &&
                ExpressionHasNoNarrowingEffects(index.Target) &&
                ExpressionsHaveNoNarrowingEffects(index.Indices)
            case tupleAccess is BoundTupleElementAccessExpression: ExpressionHasNoNarrowingEffects(tupleAccess.Receiver)
            case asExpr is BoundAsExpression: ExpressionHasNoNarrowingEffects(asExpr.Expression)
            case deref is BoundDereferenceExpression: ExpressionHasNoNarrowingEffects(deref.Operand)
            case nullCond is BoundNullConditionalAccessExpression: ExpressionHasNoNarrowingEffects(nullCond.Receiver) &&
                ExpressionHasNoNarrowingEffects(nullCond.WhenNotNull)
            case conditional is BoundConditionalExpression: ExpressionHasNoNarrowingEffects(conditional.Condition) &&
                ExpressionHasNoNarrowingEffects(conditional.WhenTrue) &&
                ExpressionHasNoNarrowingEffects(conditional.WhenFalse)
            case clrCtor is BoundClrConstructorCallExpression: IsStableSystemIndexOperation(clrCtor) &&
                ExpressionsHaveNoNarrowingEffects(clrCtor.Arguments)
            case impInstCall is BoundImportedInstanceCallExpression: IsStableSystemIndexOperation(impInstCall) &&
                ExpressionHasNoNarrowingEffects(impInstCall.Receiver) &&
                ExpressionsHaveNoNarrowingEffects(impInstCall.Arguments)
            case tupleLiteral is BoundTupleLiteralExpression: ExpressionsHaveNoNarrowingEffects(tupleLiteral.Elements)
            case arrayCreation is BoundArrayCreationExpression: ExpressionHasNoNarrowingEffects(
                arrayCreation.LengthExpression
            ) &&
                ExpressionsHaveNoNarrowingEffects(arrayCreation.DimensionExpressions) &&
                ExpressionsHaveNoNarrowingEffects(arrayCreation.Elements)
            default: false
        }
        if isEffectFree {
            knownEffectFreeExpressions.Add(node)
        }
        return isEffectFree
    }

    private func ExpressionsHaveNoNarrowingEffects(expressions ImmutableArray[BoundExpression]) bool {
        if expressions.IsDefaultOrEmpty {
            return true
        }
        for expression in expressions {
            if !ExpressionHasNoNarrowingEffects(expression) {
                return false
            }
        }
        return true
    }

    /// ADR-0208 section 9 and row R18 (#5534): the else-branch of an `if` statement is bound under the state after
    /// the condition, not after the then-branch. The condition of an `if` statement nested in the then-branch runs
    /// only on that path, so the facts it removed from the enclosing frames are put back for the else-branch
    /// (`if flag if Check(h) { } else { } else { return x.Value }`). Returns the journal of the enclosing branch.
    private func BeginThenBranchConditionKills() List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]? {
        let outer = conditionKillJournal
        conditionKillJournal = List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]()
        return outer
    }

    /// Puts back the facts that the then-branch's conditions removed from frames that are still on the stack,
    /// before the else-branch is bound, and restores the journal of the enclosing branch. Only a fact that held
    /// in [`entry`](paramref), the state the else-branch starts from, is put back.
    private func RestoreThenBranchConditionKills(
        outer List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]?,
        entry NarrowingState,
        header List[(Syntax SyntaxNode, Bound BoundExpression)]? = nil,
        aliasesBeforeHeader HashSet[VariableSymbol]? = nil
    ) List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)] {
        let thenKills = conditionKillJournal!!
        conditionKillJournal = outer
        let restored = List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]()
        // The effects of a header that the else path also runs and that are not applied before the branches
        // (the `if let` initializers and guard, #5545 shape 4).
        var headerEffects AssignedRootsCollector? = nil
        var headerMutatesMemberPaths = false
        if thenKills.Count > 0 && header != nil && header.Count > 0 {
            // The header is walked in evaluation order from the aliases it started with.
            let collector = NewCollector(nil, aliasesBeforeHeader ?? externalCallableAliases)
            for part in header {
                collector.VisitExpression(part.Bound)
                headerMutatesMemberPaths = headerMutatesMemberPaths || SyntaxMayMutateMemberPaths(part.Syntax)
            }
            headerEffects = collector
        }
        for kill in thenKills {
            if !kill.Frame.ContainsKey(kill.Path) && IsOnNarrowingStack(kill.Frame) && object.Equals(
                entry.NarrowedType(kill.Path),
                kill.Type
            ) &&
                !(
                headerEffects != nil &&
                    StatementKillsPath(
                    headerEffects,
                    kill.Path,
                    headerMutatesMemberPaths || headerEffects.MayMutateMemberPaths,
                    headerEffects.MayWriteStorageOf(kill.Path)
                )
            ) {
                kill.Frame[kill.Path] = kill.Type
                restored.Add(kill)
            }
        }
        outer?.AddRange(thenKills)
        return restored
    }

    /// After the else-branch: the then-branch can have run, so the facts put back for the else-branch are removed
    /// again, unless the else-branch changed them.
    private func EndThenBranchConditionKills(restored List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]) {
        for entry in restored {
            if entry.Frame.TryGetValue(entry.Path, out var current) && current == entry.Type {
                entry.Frame.Remove(entry.Path)
            }
        }
    }

    /// ADR-0208 R18: applies the effects of the initializer of `if init; cond` before the condition is bound. Inside
    /// a then-branch the removed facts are recorded, as a condition's are, for the sibling else-branch.
    private func ApplyInitializerEffectsToNarrowings(
        syntax SyntaxNode,
        initializer BoundStatement,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]? = nil
    ) {
        if !HasAnyActiveNarrowings() {
            return
        }
        InvalidateNarrowingsForAssignedVariables(syntax, initializer, aliasesAtEntry: aliasesAtEntry)
    }

    private func IsOnNarrowingStack(frame NarrowingFrame) bool {
        for var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i-- {
            if object.ReferenceEquals(binderCtx.NarrowedVariables[i], frame) {
                return true
            }
        }
        return false
    }

    private func EffectsAlreadyAppliedByShortCircuit(expression BoundExpression) bool {
        var current = expression
        while current is BoundUnaryExpression unary && unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
            current = unary.Operand
        }
        return current is BoundBinaryExpression binary &&
            (
            binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd || binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr
        )
    }

    internal func ApplyShortCircuitOperandEffects(
        syntax SyntaxNode,
        expression BoundExpression,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]
    ) {
        if !HasAnyActiveNarrowings() || EffectsAlreadyAppliedByShortCircuit(expression) {
            return
        }
        InvalidateNarrowingsForAssignedVariables(
            expression.Syntax ?? syntax,
            BoundExpressionStatement(nil, expression),
            activeConditionRemovedFacts,
            aliasesAtEntry
        )
    }

    private func ApplyTrailingConditionEffects(
        syntax SyntaxNode,
        expression BoundExpression,
        removedFacts Dictionary[AccessPath, TypeSymbol]? = nil
    ) {
        if !HasAnyActiveNarrowings() || EffectsAlreadyAppliedByShortCircuit(expression) {
            return
        }
        InvalidateNarrowingsForAssignedVariables(
            expression.Syntax ?? syntax,
            BoundExpressionStatement(nil, expression),
            removedFacts
        )
    }

    /// ADR-0208 R18 (#5534, #5545): binds a boolean condition, applies its narrowing and callable-alias effects, and
    /// classifies the narrowing frames that hold when it is true and when it is false.
    internal func BindConditionWithEffects(conditionSyntax ExpressionSyntax, allowBoolCall bool = true)(
        Condition BoundExpression,
        WhenTrue Dictionary[AccessPath, TypeSymbol]?,
        WhenFalse Dictionary[AccessPath, TypeSymbol]?
    ) {
        let aliasesBefore = CaptureExternalCallableAliases()
        let outerRemoved = activeConditionRemovedFacts
        let removedFacts = Dictionary[AccessPath, TypeSymbol]()
        activeConditionRemovedFacts = removedFacts
        var condition BoundExpression
        try {
            condition = bindExpressionWithTargetType(conditionSyntax, TypeSymbol.Bool)
        } finally {
            activeConditionRemovedFacts = outerRemoved
        }
        RestoreExternalCallableAliases(aliasesBefore)
        ApplyTrailingConditionEffects(conditionSyntax, condition, removedFacts)
        if outerRemoved != nil {
            for entry in removedFacts {
                if !outerRemoved.ContainsKey(entry.Key) {
                    outerRemoved[entry.Key] = entry.Value
                }
            }
        }
        let effectiveRemoved = if removedFacts.Count == 0 {
            default(Dictionary[AccessPath, TypeSymbol]?)
        } else {
            removedFacts
        }
        conditionRemovedFacts = effectiveRemoved
        EnsureClosureAssignedNames(conditionSyntax)
        let (thenNarrow, elseNarrow, whenTrueAliases, whenFalseAliases) = ComputeConditionNarrowingInOrder(
            condition,
            aliasesBefore,
            effectiveRemoved,
            forShortCircuitOperand: false,
            allowBoolCall: allowBoolCall,
            keepBoolCallInLogicalOps: allowBoolCall,
            shortCircuitInComposedOps: !allowBoolCall,
            header: conditionSyntax
        )
        lastConditionWhenTrueAliases = whenTrueAliases
        lastConditionWhenFalseAliases = whenFalseAliases
        RestoreExternalCallableAliases(whenTrueAliases)
        return (condition, thenNarrow, elseNarrow)
    }

    /// ADR-0208 R18 (#5545): binds an initializer expression (of `if let` or `while let`) and applies its narrowing
    /// and callable-alias effects before the next binding, guard or branch is bound.
    internal func BindInitializerWithEffects(initializerSyntax ExpressionSyntax) BoundExpression {
        let aliasesBefore = CaptureExternalCallableAliases()
        let bound = bindExpression(initializerSyntax, false)
        RestoreExternalCallableAliases(aliasesBefore)
        ApplyTrailingConditionEffects(initializerSyntax, bound)
        RestoreExternalCallableAliases(AliasesAfter(bound, aliasesBefore, initializerSyntax))
        return bound
    }

    /// ADR-0208 R18 (#5545): binds the operands of `&&` or `||`, applying the left operand's narrowing and
    /// callable-alias effects before binding the right operand.
    internal func BindShortCircuitBinaryOperands(
        leftSyntax ExpressionSyntax,
        rightSyntax ExpressionSyntax,
        isAnd bool,
        bindLeft() -> BoundExpression,
        bindRight(BoundExpression, Dictionary[AccessPath, TypeSymbol]?) -> BoundExpression
    )(Left BoundExpression, Right BoundExpression) {
        let aliasesBeforeLeft = CaptureExternalCallableAliases()
        let nonNullByRefBeforeLeft = CaptureNonNullByRefVariables()
        let boundLeft = bindLeft()
        RestoreExternalCallableAliases(aliasesBeforeLeft)
        RestoreNonNullByRefVariables(nonNullByRefBeforeLeft)
        ApplyTrailingConditionEffects(leftSyntax, boundLeft)
        let nonNullByRefAfterLeft = CaptureNonNullByRefVariables()
        let (thenNarrow, elseNarrow, whenTrueAliases, whenFalseAliases) = ComputeConditionNarrowingInOrder(
            boundLeft,
            aliasesBeforeLeft,
            activeConditionRemovedFacts,
            forShortCircuitOperand: true,
            allowBoolCall: false,
            keepBoolCallInLogicalOps: false,
            header: leftSyntax
        )
        let rightAliases = if isAnd {
            whenTrueAliases
        } else {
            whenFalseAliases
        }
        let skippedAliases = if isAnd {
            whenFalseAliases
        } else {
            whenTrueAliases
        }
        RestoreExternalCallableAliases(rightAliases)
        var completed = false
        try {
            let rightFrame = if isAnd {
                thenNarrow
            } else {
                elseNarrow
            }
            let boundRight = bindRight(boundLeft, rightFrame)
            RestoreExternalCallableAliases(rightAliases)
            RestoreNonNullByRefVariables(nonNullByRefAfterLeft)
            ApplyTrailingConditionEffects(rightSyntax, boundRight)
            let nonNullByRefAfterRight = CaptureNonNullByRefVariables()
            let (_, _, rightWhenTrueAliases, rightWhenFalseAliases) = ComputeConditionNarrowingInOrder(
                boundRight,
                rightAliases,
                activeConditionRemovedFacts,
                forShortCircuitOperand: true,
                allowBoolCall: false,
                keepBoolCallInLogicalOps: false,
                header: rightSyntax
            )
            let rightExitAliases = JoinAliases(rightWhenTrueAliases, rightWhenFalseAliases)
            RestoreJoinedExternalCallableAliases(skippedAliases, rightExitAliases)
            RestoreJoinedNonNullByRefVariables(nonNullByRefAfterLeft, nonNullByRefAfterRight)
            completed = true
            return (boundLeft, boundRight)
        } finally {
            if !completed {
                RestoreExternalCallableAliases(aliasesBeforeLeft)
                RestoreNonNullByRefVariables(nonNullByRefBeforeLeft)
            }
        }
    }

    /// ADR-0208 R18 (#5545, #5654): binds the then- and else-arms of an `if`-expression or `?:` conditional
    /// expression, restoring for the else-arm any narrowing facts that the then-arm removed.
    internal func BindConditionalExpressionBranches(
        hasElse bool,
        bindWhenTrue() -> BoundExpression,
        bindWhenFalse() -> BoundExpression
    )(WhenTrue BoundExpression, WhenFalse BoundExpression) {
        let callableWhenTrue = lastConditionWhenTrueAliases ?? CaptureExternalCallableAliases()
        let callableWhenFalse = lastConditionWhenFalseAliases ?? CaptureExternalCallableAliases()
        lastConditionWhenTrueAliases = nil
        lastConditionWhenFalseAliases = nil
        let nonNullByRefEntry = CaptureNonNullByRefVariables()
        let joinEntry = binderCtx.Narrowing
        let outerConditionKills = if !hasElse {
            conditionKillJournal
        } else {
            BeginThenBranchConditionKills()
        }
        RestoreExternalCallableAliases(callableWhenTrue)
        let whenTrue = bindWhenTrue()
        let nonNullByRefThenExit = CaptureNonNullByRefVariables()
        let restoredConditionKills = if !hasElse {
            default(List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]?)
        } else {
            RestoreThenBranchConditionKills(outerConditionKills, joinEntry)
        }
        let callableThenExit = CaptureExternalCallableAliases()
        RestoreExternalCallableAliases(callableWhenFalse)
        RestoreNonNullByRefVariables(nonNullByRefEntry)
        let whenFalse = bindWhenFalse()
        if restoredConditionKills != nil {
            EndThenBranchConditionKills(restoredConditionKills)
        }
        let callableElseExit = if !hasElse {
            callableWhenFalse
        } else {
            CaptureExternalCallableAliases()
        }
        let nonNullByRefElseExit = if !hasElse {
            nonNullByRefEntry
        } else {
            CaptureNonNullByRefVariables()
        }
        RestoreJoinedExternalCallableAliases(callableThenExit, callableElseExit)
        RestoreJoinedNonNullByRefVariables(
            nonNullByRefThenExit,
            nonNullByRefElseExit,
            whenTrue.Type != TypeSymbol.Never,
            !hasElse || whenFalse.Type != TypeSymbol.Never
        )
        return (whenTrue, whenFalse)
    }

    /// ADR-0208 R18 (#5545): records the entry narrowing and callable-alias state of a target-typeable branchy call
    /// argument on its first (targetless) pass while keeping its effects for subsequent arguments, and restores that
    /// entry state when `FinalizeBranchyArgument` or `BindConversion` re-binds the argument with its parameter target
    /// type.
    internal func BindDeferrableConditional(
        syntax SyntaxNode,
        deferOnFailure bool,
        bind() -> BoundExpression
    ) BoundExpression {
        if deferOnFailure {
            let entryFrames = CaptureNarrowingFramesSnapshot()
            let entryAliases = CaptureExternalCallableAliases()
            let result = bind()
            branchyArgumentEntries[syntax] = (
                EntryFrames: entryFrames,
                EntryAliases: entryAliases,
                ExitFrames: CaptureNarrowingFramesSnapshot(),
                ExitAliases: CaptureExternalCallableAliases()
            )
            return result
        }
        if !branchyArgumentEntries.TryGetValue(syntax, out var savedEntry) {
            return bind()
        }
        RemoveBranchyArgumentEntriesInSubtree(syntax)
        let postFrames = CaptureNarrowingFramesSnapshot()
        let postAliases = CaptureExternalCallableAliases()
        RestoreNarrowingFramesSnapshot(savedEntry.EntryFrames)
        RestoreExternalCallableAliases(savedEntry.EntryAliases)
        let outerJournal = BeginThenBranchConditionKills()
        var result BoundExpression
        try {
            result = bind()
        } finally {
            let rebindKills = conditionKillJournal!!
            conditionKillJournal = outerJournal
            var removedOnRebind HashSet[SpeculativeFrameKey]? = nil
            if rebindKills.Count > 0 {
                for var i = 0; i < savedEntry.ExitFrames.Length; i++ {
                    let savedFrame = savedEntry.ExitFrames[i].Frame
                    let savedExitEntries = savedEntry.ExitFrames[i].Entries
                    if !IsOnNarrowingStack(savedFrame) {
                        continue
                    }
                    savedFrame.ForEachChangedKey(
                        savedExitEntries,
                        (path AccessPath, currentExists bool, _ TypeSymbol?, otherExists bool, _ TypeSymbol?) -> {
                            if !currentExists && otherExists {
                                removedOnRebind ??= HashSet[SpeculativeFrameKey]()
                                removedOnRebind!!.Add(SpeculativeFrameKey(savedFrame, path))
                            }
                        }
                    )
                }
            }
            let rebindRemovedAliases = HashSet[VariableSymbol](savedEntry.ExitAliases)
            rebindRemovedAliases.ExceptWith(externalCallableAliases)
            let rebindAddedAliases = HashSet[VariableSymbol](externalCallableAliases)
            rebindAddedAliases.ExceptWith(savedEntry.ExitAliases)
            RestoreNarrowingFramesSnapshot(postFrames)
            if removedOnRebind is {} removedSet {
                for kill in rebindKills {
                    if IsOnNarrowingStack(kill.Frame) && removedSet.Contains(
                        SpeculativeFrameKey(kill.Frame, kill.Path)
                    ) {
                        kill.Frame.Remove(kill.Path)
                        outerJournal?.Add(kill)
                    }
                }
            }
            postAliases.ExceptWith(rebindRemovedAliases)
            postAliases.UnionWith(rebindAddedAliases)
            RestoreExternalCallableAliases(postAliases)
        }
        return result
    }

    internal func CaptureCallArgumentPrebindRollback(callSyntax SyntaxNode) Action {
        let savedBindSnapshot = CaptureNarrowingBindSnapshot()
        let savedFrames = CaptureNarrowingFramesSnapshot()
        let savedAliases = CaptureExternalCallableAliases()
        let savedJournalCount = conditionKillJournal?.Count ?? -1
        return () -> {
            RestoreNarrowingBindSnapshot(savedBindSnapshot)
            RestoreNarrowingFramesSnapshot(savedFrames)
            RestoreExternalCallableAliases(savedAliases)
            let journal = conditionKillJournal
            if savedJournalCount >= 0 && journal != nil && journal.Count > savedJournalCount {
                journal.RemoveRange(savedJournalCount, journal.Count - savedJournalCount)
            }
            RemoveBranchyArgumentEntriesInSubtree(callSyntax)
        }
    }

    private func CaptureNarrowingFramesSnapshot()[](Frame NarrowingFrame, Entries NarrowingFrameSnapshot) -> binderCtx
        .NarrowedVariables
        .Select((frame NarrowingFrame) -> (Frame: frame, Entries: frame.SnapshotEntries()))
        .ToArray()

    private func RemoveBranchyArgumentEntriesInSubtree(root SyntaxNode) {
        branchyArgumentEntries.Remove(root)
        var toRemove List[SyntaxNode]? = nil
        for key in branchyArgumentEntries.Keys {
            if object.ReferenceEquals(key.SyntaxTree, root.SyntaxTree) &&
                key
                .Span
                .Start >= root
                .Span
                .Start &&
                key
                .Span
                .End <= root
                .Span
                .End {
                (toRemove ??= List[SyntaxNode]()).Add(key)
            }
        }
        if toRemove != nil {
            for key in toRemove {
                branchyArgumentEntries.Remove(key)
            }
        }
    }

    private func RestoreNarrowingFramesSnapshot(snapshot[](Frame NarrowingFrame, Entries NarrowingFrameSnapshot)) {
        let count = Math.Min(snapshot.Length, binderCtx.NarrowedVariables.Count)
        for var i = 0; i < count; i++ {
            let frame = binderCtx.NarrowedVariables[i]
            if !object.ReferenceEquals(frame, snapshot[i].Frame) {
                continue
            }
            frame.RestoreTo(snapshot[i].Entries)
        }
    }

    /// ADR-0208 section 9 and row R18 (#5534): the effects of a branching condition apply to the narrowing facts
    /// before either branch is bound. The condition runs first, so a call, a getter or an assignment in it can end a
    /// fact that the branches would otherwise read. The same rule as a catch filter (row R10) and the one rule of
    /// (cref:InvalidateNarrowingsForAssignedVariables). The facts that the condition itself proves are classified
    /// after this call, so a test after the effect (`Check(h) && x != nil`) still narrows its branch. The
    /// effects are read with the callable aliases from before the condition, as for a statement, so this runs
    /// before (cref:ApplyHeaderCallableEffects). Returns the removed facts with the type a read saw, or `nil`.
    internal func ApplyConditionEffectsAndHeaderAliases(syntax SyntaxNode, condition BoundExpression) {
        ApplyConditionEffectsToNarrowings(syntax, condition)
        ApplyHeaderCallableEffects(condition)
    }

    private func ApplyConditionEffectsToNarrowings(
        syntax SyntaxNode,
        condition BoundExpression,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]? = nil
    ) Dictionary[AccessPath, TypeSymbol]? {
        if !HasAnyActiveNarrowings() {
            return nil
        }
        let removedFacts = conditionRemovedFacts ?? Dictionary[AccessPath, TypeSymbol]()
        conditionRemovedFacts = removedFacts
        removedFacts.Clear()
        InvalidateNarrowingsForAssignedVariables(
            syntax,
            BoundExpressionStatement(syntax, condition),
            removedFacts,
            aliasesAtEntry
        )
        return if removedFacts.Count == 0 {
            default(Dictionary[AccessPath, TypeSymbol]?)
        } else {
            Dictionary[AccessPath, TypeSymbol](removedFacts)
        }
    }

    /// ADR-0208 R18 and R19 (#5629): a switch arm's test runs before its guard and its body or result, so its effects
    /// apply to the narrowing facts first, as a condition's do. The test is the `is` test of the arm's pattern on the
    /// value that the switch evaluated once, so the one collector classifies it as it classifies `if x is 1`. The
    /// discriminant's own evaluation is not part of the test.
    internal func ApplySwitchArmTestEffects(
        syntax SyntaxNode,
        discriminantType TypeSymbol,
        pattern BoundPattern,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]? = nil
    ) {
        let evaluated = LocalVariableSymbol("<switch-value>", true, discriminantType)
        let isExpr = BoundIsExpression(syntax, BoundVariableExpression(nil, evaluated), pattern)
        ApplyConditionEffectsToNarrowings(syntax, isExpr, aliasesAtEntry)
        if aliasesAtEntry == nil {
            ApplyHeaderCallableEffects(isExpr)
        }
    }

    /// #5629: a switch arm's header, bound once in dispatch order: the pattern, the narrowing that it proves for the
    /// discriminant, the guard, the callable aliases that the guard removed, and whether the header's effects can
    /// remove the discriminant's fact (then no later arm proves a narrowing of it either).
    internal sealed class SwitchArmHeader {
        init(
            pattern BoundPattern,
            frame Dictionary[AccessPath, TypeSymbol]?,
            boundGuard BoundExpression?,
            removedAliases HashSet[VariableSymbol]?,
            removedNonNullByRef HashSet[VariableSymbol]?,
            mayRemoveDiscriminantFact bool
        ) {
            Pattern = pattern
            Frame = frame
            Guard = boundGuard
            RemovedAliases = removedAliases
            RemovedNonNullByRef = removedNonNullByRef
            MayRemoveDiscriminantFact = mayRemoveDiscriminantFact
        }

        prop Pattern BoundPattern {
            get;
        }

        prop Frame Dictionary[AccessPath, TypeSymbol]? {
            get;
        }

        prop Guard BoundExpression? {
            get;
        }

        prop RemovedAliases HashSet[VariableSymbol]? {
            get;
        }

        prop RemovedNonNullByRef HashSet[VariableSymbol]? {
            get;
        }

        prop MayRemoveDiscriminantFact bool {
            get;
        }
    }

    /// ADR-0208 R18 and R19 (#5629): binds a switch arm's header in the current (arm) scope, after the headers before
    /// it. The test's effects apply first, as a condition's do. Its pattern proves a narrowing of the discriminant
    /// unless its own effects or those of a header before it ([`discriminantStale`](paramref)) can remove the tested
    /// fact, as for `if x is P`. The guard binds under that narrowing; its effects then apply with the pattern's frame
    /// on the stack (the body pushes the same dictionary), and so do its callable-alias effects. The switch statement
    /// and the switch expression both bind their headers here.
    internal func BindSwitchArmHeader(
        valueSyntax PatternSyntax,
        guardSyntax ExpressionSyntax?,
        discriminant BoundExpression,
        discriminantStale bool
    ) SwitchArmHeader {
        // The aliases that the header removes, statements inside a guard's block included, against its entry.
        let aliasesBefore = CaptureExternalCallableAliases()
        let nonNullByRefBefore = CaptureNonNullByRefVariables()
        let pattern = patterns.BindPattern(valueSyntax, discriminant.Type)
        ApplySwitchArmTestEffects(valueSyntax, discriminant.Type, pattern, aliasesBefore)
        let evaluated = LocalVariableSymbol("<switch-value>", true, discriminant.Type)
        ApplyHeaderCallableEffects(BoundIsExpression(valueSyntax, BoundVariableExpression(nil, evaluated), pattern))
        let test = BoundIsExpression(valueSyntax, discriminant, pattern)
        let testMayRemove = TestMayRemoveItsOperandFact(test)
        let frame = if discriminantStale || testMayRemove {
            default(Dictionary[AccessPath, TypeSymbol]?)
        } else {
            TryClassifyPatternNarrowing(discriminant, pattern)
        }
        var boundGuard BoundExpression? = nil
        var removedAliases HashSet[VariableSymbol]? = nil
        var removedNonNullByRef HashSet[VariableSymbol]? = nil
        var guardMayRemove = false
        if guardSyntax != nil {
            let guardAliasesBefore = CaptureExternalCallableAliases()
            let bound = BindGuardExpressionWithNarrowing(guardSyntax, frame)
            ApplySwitchGuardEffects(guardSyntax, bound, frame, guardAliasesBefore)
            ApplyHeaderCallableEffects(bound)
            guardMayRemove = EffectsMayRemoveFactOf(discriminant, bound, nil)
            boundGuard = bound
        }
        aliasesBefore.ExceptWith(externalCallableAliases)
        if aliasesBefore.Count > 0 {
            removedAliases = aliasesBefore
        }
        nonNullByRefBefore.ExceptWith(binderCtx.NonNullByRefVariables)
        if nonNullByRefBefore.Count > 0 {
            removedNonNullByRef = nonNullByRefBefore
        }
        return SwitchArmHeader(
            pattern,
            frame,
            boundGuard,
            removedAliases,
            removedNonNullByRef,
            testMayRemove || guardMayRemove
        )
    }

    /// #5629: applies a header that was bound before a `default` again where its arm is dispatched, since the
    /// default put its effects back. Returns the callable aliases that its guard removes.
    internal func ReapplySwitchArmHeaderEffects(
        valueSyntax PatternSyntax,
        guardSyntax ExpressionSyntax?,
        header SwitchArmHeader
    ) HashSet[VariableSymbol]? {
        ApplySwitchArmTestEffects(valueSyntax, header.Pattern.Type, header.Pattern)
        if guardSyntax != nil && header.Guard is {} boundGuard {
            ApplySwitchGuardEffects(guardSyntax, boundGuard, header.Frame)
        }
        if header.RemovedAliases is {} removed {
            externalCallableAliases.ExceptWith(removed)
            SyncExpressionCallableAliasesNow()
        }
        if header.RemovedNonNullByRef is {} removedNonNull {
            binderCtx.NonNullByRefVariables.ExceptWith(removedNonNull)
        }
        return header.RemovedAliases
    }

    private func ApplySwitchGuardEffects(
        syntax SyntaxNode,
        boundGuard BoundExpression,
        frame Dictionary[AccessPath, TypeSymbol]?,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]? = nil
    ) {
        if frame == nil {
            ApplyConditionEffectsToNarrowings(syntax, boundGuard, aliasesAtEntry)
            return
        }
        binderCtx.PushNarrowingFrame(frame)
        try {
            ApplyConditionEffectsToNarrowings(syntax, boundGuard, aliasesAtEntry)
        } finally {
            binderCtx.EndNarrowingProof()
        }
    }

    /// #5629: a `default` that is not the last arm runs after the tests of the arms after it.
    /// [`bindLaterTests`](paramref) binds those arms' patterns in dispatch order, each after the tests before it, and
    /// applies their effects; [`bind`](paramref) then binds the default's body. The facts that the tests and the
    /// default's conditions removed are put back afterwards (as R18 does for an else-branch), and each of those arms
    /// applies its own test where it is dispatched. A default that falls through keeps them: the next arm's body also
    /// runs after the default, and that path removes at least what the arm's own dispatch removes.
    /// The callable aliases are put back the same way.
    internal func BindAfterLaterArmTests(bindLaterTests() -> void, fallsThrough bool, bind() -> BoundNode) BoundNode {
        let outer = BeginThenBranchConditionKills()
        let entry = binderCtx.Narrowing
        let entryAliases = CaptureExternalCallableAliases()
        let entryNonNullByRef = CaptureNonNullByRefVariables()
        bindLaterTests()
        let headerKills = conditionKillJournal!!
        conditionKillJournal = outer
        let bound = bind()
        if !fallsThrough {
            RestoreExternalCallableAliases(entryAliases)
            RestoreNonNullByRefVariables(entryNonNullByRef)
        }
        if fallsThrough {
            outer?.AddRange(headerKills)
        } else {
            conditionKillJournal = headerKills
            RestoreThenBranchConditionKills(outer, entry)
            if headerKills.Count > 0 && bound.Syntax is {} boundSyntax {
                let boundStatement = switch bound {
                    case statement is BoundStatement: statement
                    case expression is BoundExpression: BoundExpressionStatement(boundSyntax, expression)
                    default: default(BoundStatement?)
                }
                if boundStatement != nil {
                    InvalidateNarrowingsForAssignedVariables(boundSyntax, boundStatement, aliasesAtEntry: entryAliases)
                }
            }
        }
        return bound
    }

    private func EnsureClosureAssignedNames(anchor SyntaxNode) -> binderCtx.EnsureClosureAssignedNames(
        () -> ComputeClosureAssignedNames(anchor, binderCtx)
    )

    private func ClearAssignedRootsAndUpdateAliases(
        statement BoundStatement,
        state Dictionary[AccessPath, TypeSymbol],
        aliases HashSet[VariableSymbol]
    ) {
        let hasUserLabel = ContainsUserLabel(statement)
        if hasUserLabel {
            state.Clear()
            aliases.Clear()
        }
        let aliasesAtEntry = aliases.ToArray()
        let collector = NewCollector(nil, aliasesAtEntry)
        collector.Visit(statement)
        ClearAssignedRoots(statement, state, collector)
        ApplyCallableAliasExitState(aliases, statement, aliasesAtEntry, collector)
        if hasUserLabel {
            aliases.Clear()
        }
    }

    /// Issue #2159: conservatively drops every narrowing on a local that
    /// [`node`](paramref)'s bound subtree assigns anywhere.
    internal func ClearAssignedRoots(
        node BoundNode,
        state Dictionary[AccessPath, TypeSymbol],
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) {
        if state.Count == 0 {
            return
        }
        if node.Syntax is {} anchor {
            EnsureClosureAssignedNames(anchor)
        }
        let collector = NewCollector(nil, callableAliases ?? externalCallableAliases)
        collector.Visit(node)
        ClearAssignedRoots(node, state, collector)
    }

    internal func ClearAssignedRootsForConditionOperand(
        node BoundNode,
        state Dictionary[AccessPath, TypeSymbol],
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) {
        if state.Count == 0 {
            return
        }
        if node.Syntax is {} anchor {
            EnsureClosureAssignedNames(anchor)
        }
        let collector = NewCollector(nil, callableAliases ?? externalCallableAliases)
        collector.Visit(node)
        ClearAssignedRootsForConditionOperand(node, state, collector)
    }

    private func ClearAssignedRootsForConditionOperand(
        node BoundNode,
        state Dictionary[AccessPath, TypeSymbol],
        collector AssignedRootsCollector
    ) {
        if state.Count == 0 {
            return
        }
        var memberPaths Dictionary[AccessPath, TypeSymbol]? = nil
        for entry in state.ToArray() {
            if entry.Key.HasMembers && !IsExternalStorageAlias(entry.Key.Root) {
                if memberPaths == nil {
                    memberPaths = Dictionary[AccessPath, TypeSymbol]()
                }
                memberPaths[entry.Key] = entry.Value
                state.Remove(entry.Key)
            }
        }
        if state.Count > 0 {
            ClearAssignedRoots(node, state, collector)
        }
        if memberPaths != nil {
            var filterWrites List[(TryBlock SyntaxNode?, Names HashSet[string])]? = nil
            if node.Syntax is {} syntax && (collector.MayMutateMemberPaths || collector.ContainsTry) {
                let filters = CollectCatchFiltersAbove(syntax)
                if filters.Count > 0 {
                    filterWrites = CollectEnclosingFilterWrites(filters)
                }
            }
            for entry in memberPaths {
                let path = entry.Key
                let killedByFilter = filterWrites != nil &&
                    (FilterWritesVariable(filterWrites, path.Root) || MayBeMutatedByUnknownCallable(path))
                let killed = killedByFilter ||
                    OperandKillsStableMemberPath(collector, path, syntaxMutatesMembers: false)
                if !killed {
                    state[path] = entry.Value
                }
            }
        }
    }

    private func ClearAssignedRoots(
        node BoundNode,
        state Dictionary[AccessPath, TypeSymbol],
        collector AssignedRootsCollector
    ) {
        if state.Count == 0 {
            return
        }
        if node.Syntax is {} syntax && (collector.MayMutateMemberPaths || collector.ContainsTry) {
            let filters = CollectCatchFiltersAbove(syntax)
            if filters.Count > 0 {
                let filterWrites = CollectEnclosingFilterWrites(filters)
                for path in state
                    .Keys
                    .Where(
                    (path AccessPath) -> FilterWritesVariable(filterWrites, path.Root) ||
                        MayBeMutatedByUnknownCallable(path)
                )
                    .ToArray() {
                    state.Remove(path)
                }
            }
        }
        ApplyMutationsToState(state, collector)
        for root in collector.Roots {
            RemoveByRoot(state, root)
        }
    }

    // #5456: lookup indexes for one closure-name collection. Each run owns one, so no state is shared between
    // compilations. One pass for each container keeps the collection linear in the number of writes.
    private sealed class ClosureScopeIndex {
        // Created on first use: most functions have no closure.
        private var declarations Dictionary[SyntaxNode, Dictionary[string, List[VariableDeclarationSyntax]]]?
        private var parameters Dictionary[SyntaxNode, HashSet[string]]?

        /// The variable declarations that are children of [`container`](paramref), by name and in source order.
        func DeclarationsOf(container SyntaxNode) Dictionary[string, List[VariableDeclarationSyntax]] {
            let index = declarations ?? Dictionary[SyntaxNode, Dictionary[string, List[VariableDeclarationSyntax]]]()
            declarations = index
            if index.TryGetValue(container, out var known) {
                return known
            }
            let built = Dictionary[string, List[VariableDeclarationSyntax]](StringComparer.Ordinal)
            for child in container.GetChildren() {
                if child is VariableDeclarationSyntax variable {
                    let key = variable.Identifier.ValueText
                    if !built.TryGetValue(key, out var list) {
                        list = List[VariableDeclarationSyntax]()
                        built[key] = list
                    }
                    list.Add(variable)
                }
            }
            index[container] = built
            return built
        }

        /// The names of the parameters that [`owner`](paramref) declares, without those of the closures nested in it.
        func ParametersOf(owner SyntaxNode) HashSet[string] {
            let index = parameters ?? Dictionary[SyntaxNode, HashSet[string]]()
            parameters = index
            if index.TryGetValue(owner, out var known) {
                return known
            }
            let built = HashSet[string](StringComparer.Ordinal)
            CollectParameters(owner, built)
            index[owner] = built
            return built
        }

        private func CollectParameters(node SyntaxNode, names HashSet[string]) {
            for child in node.GetChildren() {
                if child is ParameterSyntax{Identifier: {} identifier} {
                    names.Add(identifier.ValueText)
                }
                if !StatementBinder.IsScopeOwner(child) {
                    CollectParameters(child, names)
                }
            }
        }
    }

    /// Issue #2159: bound-tree walker collecting the root variable of every
    /// plain assignment target in a subtree, used to conservatively invalidate
    /// join narrowings across constructs the flow analysis does not model.
    private open class AssignedRootsCollector : BoundTreeWalker {
        private let assignmentPreservesNarrowing((BoundAssignmentExpression, TypeSymbol) -> bool)?
        private let assignedFields HashSet[FieldSymbol] = HashSet[FieldSymbol]()
        private let assignedProperties HashSet[PropertySymbol] = HashSet[PropertySymbol]()
        private let assignments Dictionary[VariableSymbol, List[BoundAssignmentExpression]] = Dictionary[
            VariableSymbol,
            List[BoundAssignmentExpression]
        ]()
        private let writableReferenceAliases Dictionary[VariableSymbol, BoundExpression] = Dictionary[
            VariableSymbol,
            BoundExpression
        ]()
        private let normalCallableState CallableAliasState = CallableAliasState()
        private let allEntryCallableState CallableAliasState = CallableAliasState()
        private let visitedFunctionLiterals HashSet[BoundFunctionLiteralExpression] = HashSet[
            BoundFunctionLiteralExpression
        ]()
        private let localProcessedExpressions HashSet[BoundExpression] = HashSet[BoundExpression](
            ReferenceEqualityComparer.Instance
        )
        private let pendingConditionalTargets HashSet[BoundLabel] = HashSet[BoundLabel]()
        private let visitedLabels HashSet[BoundLabel] = HashSet[BoundLabel]()
        private let declaredRegionLabels List[BoundLabel] = List[BoundLabel]()
        private let jumpedRegionLabels List[BoundLabel] = List[BoundLabel]()
        private let callableInvocationCountsAtLabel Dictionary[BoundLabel, int32] = Dictionary[BoundLabel, int32]()
        private let callableInvocations List[VariableSymbol] = List[VariableSymbol]()
        private let enclosingGlobalAssignments Stack[VariableSymbol] = Stack[VariableSymbol]()
        private var globalMutationProtectedRoots HashSet[VariableSymbol]?
        // ADR-0208 R15: the variables whose assignment encloses every node that can run an escaped closure. The
        // assignment replaces the value afterwards, so its own postcondition survives (`x = Make()`).
        private let enclosingAssignments Stack[VariableSymbol] = Stack[VariableSymbol]()
        private var escapedClosureProtectedRoots HashSet[VariableSymbol]?
        private var tryAssignedVariables HashSet[VariableSymbol]?
        private var functionLiteralReturnState(Normal CallableAliasState, AllEntry CallableAliasState)?
        private var functionLiteralTryReturnState(Normal CallableAliasState, AllEntry CallableAliasState)?
        private var functionLiteralFinallyDepth int32
        private let mayShareStorage((VariableSymbol, VariableSymbol) -> bool)?
        private let isClosureAssigned((VariableSymbol) -> bool)?
        private let knownStatements Dictionary[BoundStatement, StatementEffects]?
        private var hasAliasSensitiveOperations bool
        private var hasControlTransfer bool

        init(
            assignmentPreservesNarrowing((BoundAssignmentExpression, TypeSymbol) -> bool)?,
            externalFunctionValues IEnumerable[VariableSymbol]? = nil,
            mayShareStorage((VariableSymbol, VariableSymbol) -> bool)? = nil,
            isClosureAssigned((VariableSymbol) -> bool)? = nil,
            knownStatements Dictionary[BoundStatement, StatementEffects]? = nil
        ) {
            this.knownStatements = knownStatements
            this.mayShareStorage = mayShareStorage
            this.isClosureAssigned = isClosureAssigned
            Roots = HashSet[VariableSymbol]()
            WritableReferenceRoots = HashSet[VariableSymbol]()
            VisitedCatchFilters = List[ExpressionSyntax]()
            this.assignmentPreservesNarrowing = assignmentPreservesNarrowing
            if externalFunctionValues != nil {
                this.normalCallableState.External.UnionWith(externalFunctionValues)
                this.allEntryCallableState.External.UnionWith(externalFunctionValues)
            }
        }

        prop Roots HashSet[VariableSymbol] {
            get;
        }

        // Roots written through an out/ref argument or an address-of operand;
        // always also present in Roots.
        prop WritableReferenceRoots HashSet[VariableSymbol] {
            get;
        }

        prop MayMutateMemberPaths bool {
            get;
            private set;
        }

        // ADR-0208 R12 (#5292): a member, index or indirect write, or user code that may run one
        // (a lambda, a loop header); unlike MayMutateMemberPaths, a plain call does not set it.
        prop MayMutateReferenceStorage bool {
            get;
            private set;
        }

        // ADR-0208 R20 (#5827): the member, index and indirect writes that set MayMutateReferenceStorage.
        // A write that is not in this list sets untypedReferenceStorageWrite.
        private let referenceStorageWrites List[BoundExpression] = List[BoundExpression]()

        // ADR-0208 R21 (#5786, #5832): the by-reference value roots (a struct `this`, a `ref` parameter or local)
        // through which a separate source field or property write stores (cref:StatementBinder.MemberWriteStorage).
        private let byReferenceWriteRoots HashSet[VariableSymbol] = HashSet[VariableSymbol]()

        /// ADR-0208 R21 (#5786, #5832): whether a separate write through a by-reference value receiver can reach the
        /// member facts of [`path`](paramref). Such a write stores a field of the root's own storage, so it keeps the
        /// member facts of that root. Another root can name storage that overlaps it through a type with explicit
        /// layout, so the write removes the member facts of every other root.
        /// @param path The path of the fact.
        /// @returns `true` when a by-reference write can change the members of the path.
        func ByReferenceWritesReach(path AccessPath) bool {
            if byReferenceWriteRoots.Count == 0 || !StatementBinder.HasMemberLinks(path) {
                return false
            }
            let root = StatementBinder.EffectiveMemberRoot(path)
            for writeRoot in byReferenceWriteRoots {
                if root == nil || !object.ReferenceEquals(writeRoot, root) {
                    return true
                }
            }
            return false
        }
        private var untypedReferenceStorageWrite bool = false

        /// ADR-0208 R12 and R20 (#5292, #5827): whether the statement can store into the storage that the root of
        /// [`path`](paramref) names. A fact on the root itself dies on every reference-storage write. A fact on a member
        /// path dies only on a write whose location can hold the root's storage
        /// (cref:StatementBinder.StorageWriteMayOverwriteRoot), or on a write that the collector cannot type.
        /// @param path The path of the fact.
        /// @returns `true` when the statement can overwrite the storage of the root.
        func MayWriteStorageOf(path AccessPath) bool {
            if !MayMutateReferenceStorage {
                return false
            }
            if !StatementBinder.HasMemberLinks(path) || untypedReferenceStorageWrite {
                return true
            }
            let root = StatementBinder.EffectiveMemberRoot(path)
            if root == nil {
                return true
            }
            for write in referenceStorageWrites {
                if StatementBinder.StorageWriteMayOverwriteRoot(write, root.Type) {
                    return true
                }
            }
            return false
        }

        private func RecordReferenceStorageWrite(write BoundExpression?) {
            MayMutateReferenceStorage = true
            if write != nil && StatementBinder.IsMemberStorageWriteExpression(write.Kind) {
                referenceStorageWrites.Add(write)
            } else {
                untypedReferenceStorageWrite = true
            }
        }

        prop HasMemberStorageWrite bool {
            get;
            private set;
        }

        // A nested try can catch a replacement exception, after the filters of an enclosing try ran.
        prop ContainsTry bool {
            get;
            private set;
        }

        prop VisitedCatchFilters List[ExpressionSyntax] {
            get;
        }

        internal var MeasureStatementEffects bool

        internal prop CanComposeRootEffects bool -> !hasAliasSensitiveOperations &&
            !hasControlTransfer &&
            !ContainsTry &&
            !MayMutateMemberPaths &&
            !MayMutateReferenceStorage &&
            !MayMutateAnyRoot &&
            !MayMutateGlobalRoots &&
            !MayRunEscapedClosure &&
            writableReferenceAliases.Count == 0 &&
            Roots.All((root VariableSymbol) -> root is LocalVariableSymbol{RefKind: RefKind.None})

        prop AlreadyProcessedExpressions HashSet[BoundExpression]? {
            get;
            set;
        }

        prop NewlyProcessedExpressions HashSet[BoundExpression] -> localProcessedExpressions

        prop ProcessedExpressionExitAliases Dictionary[BoundExpression, HashSet[VariableSymbol]]? {
            get;
            set;
        }

        prop MayMutateAnyRoot bool {
            get;
            private set;
        }

        // Subset of MayMutateAnyRoot: a write through a pointer or reference of
        // unknown origin can reach ANY address-taken local, not just locals a
        // closure assigns.
        prop MayMutateAnyRootViaPointer bool {
            get;
            private set;
        }

        // ADR-0208 R15 (#5237): the node runs source code, so it can run a closure that escaped. A call through a
        // callable value is not in this set.
        prop MayRunEscapedClosure bool {
            get;
            private set;
        }

        prop MayMutateGlobalRoots bool {
            get;
            private set;
        }

        prop MayMutateWritableReferenceRoots bool {
            get;
            private set;
        }

        // A variable with a known local target on any branch is a mixed alias;
        // the exported alias set forgets local bodies, so treat it as unknown
        // rather than external-only (fail-safe).
        prop DefinitelyExternalFunctionValues IEnumerable[VariableSymbol] -> normalCallableState
            .External
            .Except(normalCallableState.Unknown)
            .Where((variable VariableSymbol) -> !normalCallableState.Literals.ContainsKey(variable))

        protected open override func VisitIndirectAssignmentExpression(node BoundIndirectAssignmentExpression) {
            base.VisitIndirectAssignmentExpression(node)
            var pointer = node.Pointer
            while pointer is BoundConversionExpression conversion {
                pointer = conversion.Expression
            }
            while pointer is BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                pointer = assertion.Operand
            }
            if pointer is BoundAddressOfExpression address {
                RecordWritableReference(address.Operand, invalidateCallableState: true)
            } else if pointer is BoundVariableExpression variable && writableReferenceAliases.TryGetValue(
                variable.Variable,
                out var operand
            ) {
                RecordWritableReference(operand, invalidateCallableState: true)
            } else {
                MayMutateAnyRoot = true
                MayMutateAnyRootViaPointer = true
            }
        }

        open override func VisitStatement(node BoundStatement?) {
            if node != nil && MeasureStatementEffects {
                CompilationMeasurements.Count("narrowing.effect-node-visits")
            }
            if node != nil &&
                knownStatements != nil &&
                enclosingAssignments.Count == 0 &&
                enclosingGlobalAssignments.Count == 0 &&
                visitedFunctionLiterals.Count == 0 &&
                tryAssignedVariables == nil &&
                pendingConditionalTargets.Count == 0 &&
                normalCallableState
                .LocalParameters
                .Count == 0 &&
                allEntryCallableState
                .LocalParameters
                .Count == 0 &&
                writableReferenceAliases.Count == 0 &&
                knownStatements
                .TryGetValue(node, out var known) {
                Roots.UnionWith(known.AssignedRoots)
                for root in known.AssignedRoots {
                    normalCallableState.InvalidateVariable(root, mayShareStorage)
                    allEntryCallableState.InvalidateVariable(root, mayShareStorage)
                }
                CompilationMeasurements.Count("narrowing.effects-child-reuses")
                return
            }
            if node is BoundLoopStatement or
                BoundLabelStatement or
                BoundGotoStatement or
                BoundConditionalGotoStatement or
                BoundReturnStatement or
                BoundThrowStatement or
                BoundRethrowStatement {
                hasControlTransfer = true
            }
            if node is BoundLocalFunctionDeclaration or BoundVariableDeclaration {
                hasAliasSensitiveOperations = true
            }
            if node is BoundLoopStatement loop {
                declaredRegionLabels.Add(loop.BreakLabel)
                if loop.ContinueLabel is {} continueLabel {
                    declaredRegionLabels.Add(continueLabel)
                }
            }
            if node is BoundLabelStatement label {
                declaredRegionLabels.Add(label.Label)
                visitedLabels.Add(label.Label)
                pendingConditionalTargets.Remove(label.Label)
                callableInvocationCountsAtLabel[label.Label] = callableInvocations.Count
            } else if node is BoundGotoStatement gotoStatement {
                jumpedRegionLabels.Add(gotoStatement.Label)
                if !visitedLabels.Contains(gotoStatement.Label) {
                    pendingConditionalTargets.Add(gotoStatement.Label)
                } else if callableInvocationCountsAtLabel.TryGetValue(gotoStatement.Label, out var invocationStart) {
                    for var i = invocationStart; i < callableInvocations.Count; i++ {
                        AnalyzeCallableVariable(callableInvocations[i])
                    }
                }
            }
            base.VisitStatement(node)
        }

        open override func VisitExpression(node BoundExpression?) {
            if node == nil {
                return
            }
            if IsCallableType(node.Type) ||
                node is BoundCallOperationExpression or
                BoundFunctionLiteralExpression or
                BoundFunctionPointerInvocationExpression or
                BoundAddressOfExpression or
                BoundConditionalAddressExpression {
                hasAliasSensitiveOperations = true
            }
            if AlreadyProcessedExpressions != nil &&
                visitedFunctionLiterals.Count == 0 &&
                (AlreadyProcessedExpressions!!.Contains(node) || !localProcessedExpressions.Add(node)) {
                if ProcessedExpressionExitAliases != nil && ProcessedExpressionExitAliases!!.TryGetValue(
                    node,
                    out var exitAliases
                ) {
                    normalCallableState.SetExternalOnly(exitAliases)
                    allEntryCallableState.SetExternalOnly(exitAliases)
                }
                return
            }
            let isStableSystemIndexOp = StatementBinder.IsStableSystemIndexOperation(node)
            // ADR-0208 R20 and R21 (#5796, #5786): a source property or field write into storage that no other
            // field overlaps is classified below. Every other member write removes every member-bearing path.
            let storage = StatementBinder.MemberWriteStorage(node)
            let separateSourceWrite = storage.Separate
            if separateSourceWrite && storage.ByReferenceRoot is {} byReferenceRoot {
                byReferenceWriteRoots.Add(byReferenceRoot)
            }
            if !isStableSystemIndexOp && StatementBinder.IsPotentiallyMutatingMemberPathExpression(node.Kind) &&
                !separateSourceWrite {
                MayMutateMemberPaths = true
            }
            if StatementBinder.IsMemberStorageWriteExpression(node.Kind) ||
                (
                !isStableSystemIndexOp && StatementBinder.IsPotentiallyMutatingMemberPathExpression(node.Kind) &&
                    node is not BoundCallOperationExpression &&
                    node is not BoundConstructorCallExpression
            ) {
                RecordReferenceStorageWrite(node)
            }
            // ADR-0208 R14 (#5215, #5599, #5786): a source accessor with user code is a call.
            // A constructor or init-accessor write to a get-only or init-only auto property can also
            // overwrite a stable property link (SmartCastStability.IsStableProperty).
            let sourcePropertyRunsUserCode = StatementBinder.SourcePropertyAccessRunsUserCode(node)
            let writesStableAutoProperty = node is BoundPropertyAssignmentExpression propAssign &&
                (!propAssign.Property.HasSetter || propAssign.Property.IsInitOnly)
            // ADR-0208 R21 (#5786): a write of a `var` field stores no link of a stable path
            // (SmartCastStability.IsStableField). A constructor write of a `let` field can store a link.
            let writesStableField = node is BoundFieldAssignmentExpression fieldAssign && fieldAssign.Field.IsReadOnly
            if sourcePropertyRunsUserCode || writesStableAutoProperty || writesStableField {
                MayMutateMemberPaths = true
            }
            if StatementBinder.IsMemberStorageWriteExpression(node.Kind) &&
                (!separateSourceWrite || sourcePropertyRunsUserCode || writesStableAutoProperty || writesStableField) {
                HasMemberStorageWrite = true
            }
            var runsEscapedClosureHere = false
            // ADR-0208 R16 and R17 (#5231, #5532): an imported accessor that is not on the stable list is a call,
            // like a source accessor.
            if StatementBinder.ClrAccessRunsUserCode(node) {
                MarkMayMutateGlobalRoots(invalidateCallableAliases: false)
                runsEscapedClosureHere = true
            }
            let sourceConstructionRunsUserCode = (
                node is BoundConstructorCallExpression construction &&
                    (
                    construction.SelectedConstructor != nil || StatementBinder.ConstructionRunsUserCode(
                        construction.StructType
                    )
                )
            ) ||
                (
                node is BoundStructLiteralExpression literal &&
                    (
                    StatementBinder.ConstructionRunsUserCode(literal.StructType) || literal.Initializers.Any(
                        (initializer BoundFieldInitializer) -> initializer.Property is {} property &&
                            StatementBinder.SourcePropertyRunsUserCode(property, receiverType: nil, isWrite: true)
                    )
                )
            )
            // ADR-0208 R11 (#5170): any call, property getter or constructor
            // with user code may assign a mutable global. A static member access runs the type initializer (#5504).
            if sourcePropertyRunsUserCode ||
                sourceConstructionRunsUserCode ||
                StatementBinder.StaticMemberAccessRunsUserCode(node) || node is BoundClrConversionCallExpression {
                MarkMayMutateGlobalRoots(invalidateCallableAliases: false)
                if node is not BoundStructLiteralExpression {
                    runsEscapedClosureHere = true
                }
            }
            // ADR-0208 R15 (#5237): a call of any kind can run a closure that escaped, except a call through a
            // callable value, which keeps its own classification (AnalyzeCallableInvocation).
            if !isStableSystemIndexOp &&
                node is BoundClrConstructorCallExpression or
                BoundClrConversionCallExpression or
                BoundClrBinaryOperatorExpression or
                BoundClrUnaryOperatorExpression or
                BoundFunctionPointerInvocationExpression or
                BoundEventSubscriptionExpression or
                BoundClrEventSubscriptionExpression or
                BoundTypeParameterConstructionExpression {
                MarkRunsEscapedClosure(invalidateCallableAliases: false)
                runsEscapedClosureHere = true
            }
            // A custom interpolated-string handler constructs the handler and calls its AppendLiteral /
            // AppendFormatted methods; the default handler calls `ToString` on a hole of a type other than a
            // built-in value or a string.
            if node is BoundInterpolatedStringExpression interpolation {
                if interpolation.Handler != nil {
                    MarkMayMutateGlobalRoots(writesReferenceStorage: false, invalidateCallableAliases: false)
                    runsEscapedClosureHere = true
                } else {
                    for part in interpolation.Parts {
                        if part.Value is {} hole && hole.Type != TypeSymbol.String && !TypeSymbol.IsLegalPointeeType(
                            hole.Type
                        ) {
                            MarkMayMutateGlobalRoots(writesReferenceStorage: false, invalidateCallableAliases: false)
                            runsEscapedClosureHere = true
                            break
                        }
                    }
                }
            }
            if StatementBinder.NativeMapAccessRunsUserCode(node) {
                MayMutateMemberPaths = true
                MarkMayMutateGlobalRoots(invalidateCallableAliases: false)
                runsEscapedClosureHere = true
            }
            if node is BoundFunctionLiteralExpression nestedLiteral {
                for captured in nestedLiteral.CapturedVariables {
                    normalCallableState.CapturedVariables.Add(captured)
                    allEntryCallableState.CapturedVariables.Add(captured)
                }
            }
            if !isStableSystemIndexOp && node is BoundCallOperationExpression && !IsCallableValueInvocation(node) {
                MarkRunsEscapedClosure(invalidateCallableAliases: false)
                runsEscapedClosureHere = true
            }
            if node is BoundCallOperationExpression{CalledFunction: FunctionSymbol function} {
                // ADR-0208 R12 (#5292, #5663, #5665, amendment A3): a plain function call does not write by-reference storage.
                // A property accessor, an indexer accessor, or a conversion operator can write the storage.
                MarkMayMutateGlobalRoots(
                    writesReferenceStorage: (function.MethodKind is MethodKind.PropertyGet or MethodKind.PropertySet) ||
                        StatementBinder.IsConversionOperator(function),
                    invalidateCallableAliases: false
                )
                runsEscapedClosureHere = true
                if function.HasCaptures {
                    MayMutateAnyRoot = true
                }
            }
            if node is BoundCallOperationExpression call {
                RecordCallSiteAliasing(call)
            }
            base.VisitExpression(node)
            if runsEscapedClosureHere {
                InvalidateCallableStateForUnknownClosure()
            }
            if node is BoundCallOperationExpression{
                CalledFunction: FunctionSymbol calledFunction,
                Arguments: var arguments
            } {
                let count = Math.Min(arguments.Length, calledFunction.Parameters.Length)
                for var i = 0; i < count; i++ {
                    if (calledFunction.Parameters[i].RefKind is RefKind.Ref or RefKind.Out) {
                        RecordWritableReference(arguments[i], invalidateCallableState: true)
                    }
                }
            }
            if node is BoundCallOperationExpression{
                CalledFunction: ImportedFunctionSymbol importedFunction
            } importedCall {
                // ADR-0208 R12 (#5292): a conditional address handed to a `ref`/`out` parameter of an imported
                // method is a write; one handed to an `in` parameter is a read.
                let parameters = importedFunction.Method.GetParameters()
                let count = Math.Min(importedCall.Arguments.Length, parameters.Length)
                for var i = 0; i < count; i++ {
                    var argument = importedCall.Arguments[i]
                    while argument is BoundConversionExpression conversion {
                        argument = conversion.Expression
                    }
                    if argument is BoundConditionalAddressExpression && RefCapabilities.GetParameterRefKind(
                        parameters[i]
                    ) is RefKind.Ref or
                        RefKind.Out {
                        RecordWritableReference(argument, invalidateCallableState: true)
                    }
                }
            }
        }

        // ADR-0208 R12 (#5171): whether [`root`](paramref) may name the storage of another
        // assigned root: one decision for every invalidation site (StatementBinder.MayShareStorage).
        func SharesStorageWithAssignedRoot(root VariableSymbol) bool {
            for assigned in Roots {
                if object.ReferenceEquals(assigned, root) {
                    continue
                }
                // ADR-0208 R12 (#5292, amendment A3): a variable that a call only passes by `ref`/`out`, once, is
                // written through the callee and names no other by-reference parameter's storage that the call site
                // shows. Only a shared variable or an overlapping alias chain still shares.
                if IsCallArgumentOnly(assigned) {
                    if StatementBinder.ChainsOverlap(assigned, root) {
                        return true
                    }
                    continue
                }
                if mayShareStorage != nil {
                    if mayShareStorage!!(assigned, root) {
                        return true
                    }
                } else if StatementBinder.SharesStorage(assigned, root) {
                    return true
                }
            }
            return false
        }

        // Variables that one call passes twice by reference, or by reference and by value: the aliasing is visible at
        // the call site, so a write through the call is a write through every by-reference parameter.
        private let callAliasedRoots HashSet[VariableSymbol] = HashSet[VariableSymbol]()
        private let captureReceivers Dictionary[VariableSymbol, BoundExpression] = Dictionary[
            VariableSymbol,
            BoundExpression
        ]()

        private func IsCallArgumentOnly(assigned VariableSymbol) bool -> !assignments.ContainsKey(assigned) &&
            !callAliasedRoots.Contains(ResolveStorage(assigned))

        // ADR-0208 R12 (#5292): the storage a variable names, through `let ref` alias chains. Every place that
        // records or looks up an occurrence of a variable resolves it here.
        private func ResolveStorage(variable VariableSymbol) VariableSymbol {
            let chain = StatementBinder.AliasChain(variable)
            return chain[chain.Count - 1]
        }

        // ADR-0208 R12 (#5292, amendment A3): records the variables that this call passes more than once, at least
        // once by `ref`/`out`.
        func RecordCallSiteAliasing(call BoundCallOperationExpression) {
            let byReference = Dictionary[VariableSymbol, int32]()
            let byValue = Dictionary[VariableSymbol, int32]()
            for child in call.ChildNodes {
                if child is BoundExpression operand {
                    // The branches of one conditional are mutually exclusive: an operand counts a variable once.
                    let referenceUses = HashSet[VariableSymbol]()
                    let valueUses = HashSet[VariableSymbol]()
                    CollectOccurrences(operand, false, referenceUses, valueUses)
                    for variable in referenceUses {
                        byReference[variable] = CountOf(byReference, variable) + 1
                    }
                    for variable in valueUses {
                        byValue[variable] = CountOf(byValue, variable) + 1
                    }
                }
            }
            for entry in byReference {
                if entry.Value + CountOf(byValue, entry.Key) >= 2 {
                    callAliasedRoots.Add(entry.Key)
                }
            }
        }

        private func CountOf(counts Dictionary[VariableSymbol, int32], variable VariableSymbol) int32 {
            return if counts.TryGetValue(variable, out var seen) {
                seen
            } else {
                0
            }
        }

        // Every occurrence of a variable in one operand of the call (the receiver or an argument) is collected
        // through conversions, null assertions, address-of operands and each branch of a conditional.
        private func CollectOccurrences(
            expression BoundExpression,
            isReference bool,
            byReference HashSet[VariableSymbol],
            byValue HashSet[VariableSymbol]
        ) {
            switch expression {
                case address is BoundAddressOfExpression {
                    CollectOccurrences(address.Operand, true, byReference, byValue)
                }
                case conversion is BoundConversionExpression {
                    CollectOccurrences(conversion.Expression, isReference, byReference, byValue)
                }
                case BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                    CollectOccurrences(assertion.Operand, isReference, byReference, byValue)
                }
                case conditionalAddress is BoundConditionalAddressExpression {
                    CollectOccurrences(conditionalAddress.WhenTrueOperand, true, byReference, byValue)
                    CollectOccurrences(conditionalAddress.WhenFalseOperand, true, byReference, byValue)
                }
                case conditional is BoundConditionalExpression {
                    CollectOccurrences(conditional.WhenTrue, isReference, byReference, byValue)
                    CollectOccurrences(conditional.WhenFalse, isReference, byReference, byValue)
                }
                case variable is BoundVariableExpression {
                    if captureReceivers.TryGetValue(variable.Variable, out var original) {
                        // The receiver of a null-conditional access is bound on a synthetic capture.
                        CollectOccurrences(original, isReference, byReference, byValue)
                    } else {
                        // Resolve the variable to the storage it names, through `let ref` alias chains.
                        let root = ResolveStorage(variable.Variable)
                        if isReference {
                            byReference.Add(root)
                        } else {
                            byValue.Add(root)
                        }
                    }
                }
            }
        }

        func AssignsRoot(root VariableSymbol) bool {
            return Roots.Contains(root) ||
                SharesStorageWithAssignedRoot(root) ||
                (
                root is ImplicitFieldVariableSymbol field &&
                    (
                    assignedFields.Contains(field.Field.OriginalDefinition ?? field.Field) ||
                        AssignsRoot(field.Receiver)
                )
            ) ||
                (
                root is ImplicitStaticFieldVariableSymbol staticField && assignedFields.Contains(
                    staticField.Field.OriginalDefinition ?? staticField.Field
                )
            ) ||
                (
                root is ImplicitPropertyVariableSymbol property &&
                    (
                    assignedProperties.Contains(property.Property.OriginalDefinition ?? property.Property) ||
                        AssignsRoot(property.Receiver)
                )
            ) ||
                (
                root is ImplicitStaticPropertyVariableSymbol staticProperty && assignedProperties.Contains(
                    staticProperty.Property.OriginalDefinition ?? staticProperty.Property
                )
            )
        }

        func InvalidatesNarrowing(root VariableSymbol, narrowedType TypeSymbol) bool {
            if MayMutateWritableReferenceRoots &&
                root is ParameterSymbol &&
                (root.RefKind == RefKind.Ref || root.RefKind == RefKind.Out) {
                return true
            }
            if !Roots.Contains(root) {
                return AssignsRoot(root)
            }
            // Another assigned root may name the same storage, so the preserving proof of this
            // root alone is not enough.
            if SharesStorageWithAssignedRoot(root) {
                return true
            }
            return !SmartCastStability.IsAssignmentNarrowingRoot(root) ||
                assignmentPreservesNarrowing == nil ||
                !assignments.TryGetValue(root, out var rootAssignments) || rootAssignments.Any(
                (assignment BoundAssignmentExpression) -> !assignmentPreservesNarrowing!!(assignment, narrowedType)
            )
        }

        func MayMutateGlobalRoot(root VariableSymbol, narrowedType TypeSymbol) bool -> MayMutateGlobalRoots &&
            root is GlobalVariableSymbol &&
            !root.IsReadOnly &&
            (
            globalMutationProtectedRoots == nil || !globalMutationProtectedRoots!!.Contains(root) ||
                InvalidatesNarrowing(root, narrowedType)
        )

        protected open override func VisitIndirectCallExpression(node BoundIndirectCallExpression) {
            VisitExpression(node.Target)
            let targetState = CaptureCallableState()
            let argumentSnapshots = VisitAndSnapshotCallableArguments(node.Arguments)
            InvalidateRefKindArguments(node.Arguments, node.ArgumentRefKinds)
            ApplyCallableArguments(argumentSnapshots)
            AnalyzeCallableInvocation(node.Target, targetState, argumentSnapshots)
        }

        private func VisitPossiblySkipped(visit() -> void) {
            // A skipped operand cannot erase an earlier callable target.
            VisitAlternativePaths(() -> { }, visit)
        }

        private func VisitAlternativePaths(whenTrue() -> void, whenFalse() -> void) {
            let branchStart = CaptureCallableState()
            whenTrue()
            let thenState = CaptureCallableState()
            RestoreCallableState(branchStart)
            whenFalse()
            RestoreCallableState(JoinCallableStates(thenState, CaptureCallableState()))
        }

        private func VisitCondition(expression BoundExpression)(
            WhenTrue(Normal CallableAliasState, AllEntry CallableAliasState),
            WhenFalse(Normal CallableAliasState, AllEntry CallableAliasState)
        ) {
            switch expression {
                case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                    let (leftTrue, leftFalse) = VisitCondition(binary.Left)
                    RestoreCallableState(leftTrue)
                    let (rightTrue, rightFalse) = VisitCondition(binary.Right)
                    let whenFalse = JoinCallableStates(leftFalse, rightFalse)
                    RestoreCallableState(JoinCallableStates(rightTrue, whenFalse))
                    return (rightTrue, whenFalse)
                }
                case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
                    let (leftTrue, leftFalse) = VisitCondition(binary.Left)
                    RestoreCallableState(leftFalse)
                    let (rightTrue, rightFalse) = VisitCondition(binary.Right)
                    let whenTrue = JoinCallableStates(leftTrue, rightTrue)
                    RestoreCallableState(JoinCallableStates(whenTrue, rightFalse))
                    return (whenTrue, rightFalse)
                }
                case unary is BoundUnaryExpression when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
                    let (operandTrue, operandFalse) = VisitCondition(unary.Operand)
                    return (operandFalse, operandTrue)
                }
                default {
                    VisitExpression(expression)
                    let after = CaptureCallableState()
                    return (after, CloneCallableState(after))
                }
            }
        }

        protected open override func VisitBinaryExpression(node BoundBinaryExpression) {
            if node.Op.Kind is BoundBinaryOperatorKind.LogicalAnd or BoundBinaryOperatorKind.LogicalOr {
                VisitCondition(node)
                return
            }
            if node.Op.Kind == BoundBinaryOperatorKind.NullCoalesce {
                VisitExpression(node.Left)
                VisitPossiblySkipped(() -> VisitExpression(node.Right))
                return
            }
            if node.Left is not BoundBinaryExpression {
                VisitExpression(node.Left)
                VisitExpression(node.Right)
                if StatementBinder.BinaryEqualityRunsUserCode(node) {
                    // ADR-0208 R19 (#5710): structural equality calls `Equals`, which can be user code. It is a plain
                    // method call, so it does not write by-reference storage (R12, amendment A3).
                    MarkMayMutateGlobalRoots(writesReferenceStorage: false)
                    InvalidateCallableStateForUnknownClosure()
                }
                return
            }
            let spine = Stack[BoundBinaryExpression]()
            var current BoundExpression = node
            while current is BoundBinaryExpression bin &&
                bin
                .Op
                .Kind is not(
                BoundBinaryOperatorKind.LogicalAnd or
                    BoundBinaryOperatorKind.LogicalOr or
                    BoundBinaryOperatorKind.NullCoalesce
            ) {
                spine.Push(bin)
                let left = bin.Left
                if AlreadyProcessedExpressions != nil &&
                    visitedFunctionLiterals.Count == 0 &&
                    (AlreadyProcessedExpressions!!.Contains(left) || localProcessedExpressions.Contains(left)) {
                    current = left
                    break
                }
                current = left
            }
            VisitExpression(current)
            while spine.Count > 0 {
                let bin = spine.Pop()
                if !object.ReferenceEquals(bin, node) &&
                    AlreadyProcessedExpressions != nil &&
                    visitedFunctionLiterals.Count == 0 {
                    localProcessedExpressions.Add(bin)
                }
                VisitExpression(bin.Right)
                if StatementBinder.BinaryEqualityRunsUserCode(bin) {
                    MarkMayMutateGlobalRoots(writesReferenceStorage: false)
                    InvalidateCallableStateForUnknownClosure()
                }
            }
        }

        protected open override func VisitNullConditionalAccessExpression(node BoundNullConditionalAccessExpression) {
            // The access is bound on a synthetic capture: remember the receiver behind it.
            captureReceivers[node.Capture] = node.Receiver
            VisitExpression(node.Receiver)
            VisitPossiblySkipped(() -> VisitExpression(node.WhenNotNull))
        }

        protected open override func VisitInterpolatedStringExpression(node BoundInterpolatedStringExpression) {
            if node.Handler != nil && !node.Handler.ForwardedArguments.IsDefaultOrEmpty {
                for arg in node.Handler.ForwardedArguments {
                    VisitExpression(arg)
                }
            }
            for part in node.Parts {
                if !part.IsLiteral {
                    if node.Handler != nil {
                        VisitPossiblySkipped(() -> VisitExpression(part.Value))
                    } else {
                        VisitExpression(part.Value)
                    }
                }
            }
        }

        protected open override func VisitConditionalExpression(node BoundConditionalExpression) {
            let (whenTrue, whenFalse) = VisitCondition(node.Condition)
            RestoreCallableState(whenTrue)
            VisitExpression(node.WhenTrue)
            let thenState = CaptureCallableState()
            RestoreCallableState(whenFalse)
            VisitExpression(node.WhenFalse)
            RestoreCallableState(JoinCallableStates(thenState, CaptureCallableState()))
        }

        protected open override func VisitConditionalAddressExpression(node BoundConditionalAddressExpression) {
            let (whenTrue, whenFalse) = VisitCondition(node.Condition)
            RestoreCallableState(whenTrue)
            VisitExpression(node.WhenTrueOperand)
            let thenState = CaptureCallableState()
            RestoreCallableState(whenFalse)
            VisitExpression(node.WhenFalseOperand)
            RestoreCallableState(JoinCallableStates(thenState, CaptureCallableState()))
        }

        protected open override func VisitBinaryPattern(node BoundBinaryPattern) {
            VisitPattern(node.Left)
            VisitPossiblySkipped(() -> VisitPattern(node.Right))
        }

        protected open override func VisitPropertyPattern(node BoundPropertyPattern) {
            for field in node.Fields {
                // A computed property of a pattern runs its getter.
                if field.Property is {} property && StatementBinder.SourcePropertyRunsUserCode(property, node.Type) {
                    MarkMayMutateGlobalRoots()
                    InvalidateCallableStateForUnknownClosure()
                }
                // ADR-0208 R16 (#5231): so does an imported property that is not on the stable list.
                if StatementBinder.ClrMemberReadRunsUserCode(field.ClrMember) {
                    MarkMayMutateGlobalRoots()
                    InvalidateCallableStateForUnknownClosure()
                }
                VisitPossiblySkipped(() -> VisitPattern(field.Pattern))
            }
        }

        protected open override func VisitConstantPattern(node BoundConstantPattern) {
            base.VisitConstantPattern(node)
            // ADR-0208 R19 (#5593): the test can call the input's `Equals`, which can be user code. It is a plain
            // method call, so it does not write by-reference storage (R12, amendment A3).
            if StatementBinder.ConstantPatternRunsUserCode(node) {
                MarkMayMutateGlobalRoots(writesReferenceStorage: false)
                InvalidateCallableStateForUnknownClosure()
            }
        }

        protected open override func VisitListPattern(node BoundListPattern) {
            // ADR-0208 R19 (#5593): the `Length`/`Count` getter and the indexer of an indexable input (R16, R17).
            if StatementBinder.ListPatternRunsUserCode(node) {
                MarkMayMutateGlobalRoots()
                InvalidateCallableStateForUnknownClosure()
            }
            for element in node.Elements {
                VisitPossiblySkipped(() -> VisitPattern(element))
            }
        }

        protected open override func VisitCallExpression(node BoundCallExpression) {
            VisitCallableArguments(node.Arguments)
        }

        protected open override func VisitImportedCallExpression(node BoundImportedCallExpression) {
            VisitCallableArguments(node.Arguments)
        }

        protected open override func VisitConstrainedStaticCallExpression(node BoundConstrainedStaticCallExpression) {
            VisitCallableArguments(node.Arguments)
        }

        protected open override func VisitClrStaticCallExpression(node BoundClrStaticCallExpression) {
            VisitCallableArguments(node.Arguments)
        }

        protected open override func VisitUserInstanceCallExpression(node BoundUserInstanceCallExpression) {
            VisitExpression(node.Receiver)
            VisitCallableArguments(node.Arguments)
        }

        protected open override func VisitBaseInterfaceCallExpression(node BoundBaseInterfaceCallExpression) {
            VisitExpression(node.Receiver)
            VisitCallableArguments(node.Arguments)
        }

        protected open override func VisitBaseClassCallExpression(node BoundBaseClassCallExpression) {
            // ADR-0208 R11 (#5170): a base method or computed accessor runs user code.
            if node.Method != nil {
                MarkMayMutateGlobalRoots(invalidateCallableAliases: false)
            }
            VisitExpression(node.Receiver)
            VisitCallableArguments(node.Arguments)
            if node.Method is {} method {
                InvalidateParameterRefArguments(node.Arguments, method.Parameters)
                InvalidateCallableStateForUnknownClosure()
            }
        }

        // `callback.Invoke()` on a delegate value: the explicit form of `callback()`.
        private func IsCallableValueInvocation(
            node BoundExpression
        ) bool -> node is BoundImportedInstanceCallExpression{
            Method: {Name: "Invoke"},
            Receiver: {Type: var receiverType}
        } &&
            IsCallableType(receiverType)

        protected open override func VisitImportedInstanceCallExpression(node BoundImportedInstanceCallExpression) {
            VisitExpression(node.Receiver)
            if IsCallableValueInvocation(node) {
                let targetState = CaptureCallableState()
                let argumentSnapshots = VisitAndSnapshotCallableArguments(node.Arguments)
                InvalidateImportedParameterRefArguments(node.Arguments, node.Method.GetParameters())
                ApplyCallableArguments(argumentSnapshots)
                AnalyzeCallableInvocation(node.Receiver, targetState, argumentSnapshots)
                return
            }
            VisitCallableArguments(node.Arguments)
        }

        protected open override func VisitFunctionPointerInvocationExpression(
            node BoundFunctionPointerInvocationExpression
        ) {
            VisitExpression(node.Pointer)
            VisitCallableArguments(node.Arguments)
            let parameterTypes = node.FunctionPointerType.ParameterTypes
            let count = Math.Min(node.Arguments.Length, parameterTypes.Length)
            for var i = 0; i < count; i++ {
                if parameterTypes[i] is ByRefTypeSymbol {
                    RecordWritableReference(node.Arguments[i], invalidateCallableState: true)
                }
            }
        }

        protected open override func VisitConstructorCallExpression(node BoundConstructorCallExpression) {
            VisitCallableArguments(node.Arguments)
            let parameters = node.SelectedConstructor?.Parameters ?? node.StructType.PrimaryConstructorParameters
            if !parameters.IsDefaultOrEmpty {
                InvalidateParameterRefArguments(node.Arguments, parameters)
            }
        }

        protected open override func VisitStructLiteralExpression(node BoundStructLiteralExpression) {
            if node.CopySource != nil {
                VisitExpression(node.CopySource)
            }
            let consumed = HashSet[BoundFieldInitializer]()
            let type = node.StructType
            let definition = type.Definition ?? type
            let spillsPrimaryInLexicalOrder = !node.IsZeroInitialization &&
                node.CopySource == nil &&
                !node.CallsPrimaryConstructor &&
                type.HasDeclaredPrimaryConstructor &&
                definition.NeedsSynthesizedValueStructDefaultCtor
            if node.CallsPrimaryConstructor {
                for parameter in type.PrimaryConstructorParameters {
                    if node.GetPrimaryArgument(parameter.Name) is {} primaryArgument {
                        consumed.Add(primaryArgument)
                        VisitExpression(primaryArgument.Value)
                    }
                }
            } else if spillsPrimaryInLexicalOrder {
                let primaryFields = HashSet[FieldSymbol]()
                for argument in node.GetPrimaryConstructorArguments() {
                    primaryFields.Add(argument.Field)
                }
                for initializer in node.Initializers {
                    if initializer.IsDeclarationInitializer {
                        consumed.Add(initializer)
                        continue
                    }
                    let target FieldSymbol? = initializer.Field ?? initializer.Property?.BackingField
                    if target != nil && primaryFields.Contains(target) {
                        consumed.Add(initializer)
                        VisitExpression(initializer.Value)
                    }
                }
            }
            if (
                node.CallsDataConstructor ||
                    node.CallsPrimaryConstructor ||
                    spillsPrimaryInLexicalOrder ||
                    type.IsClass ||
                    definition.NeedsSynthesizedValueStructDefaultCtor
            ) &&
                StatementBinder
                .ConstructionRunsUserCode(type) {
                normalCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
                allEntryCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
            }
            for initializer in node.Initializers {
                if !consumed.Contains(initializer) &&
                    !(initializer.IsDeclarationInitializer && definition.NeedsSynthesizedValueStructDefaultCtor) {
                    VisitExpression(initializer.Value)
                }
                if initializer.Property is {} property && StatementBinder.SourcePropertyRunsUserCode(
                    property,
                    receiverType: nil
                ) {
                    normalCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
                    allEntryCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
                }
            }
        }

        protected open override func VisitClrConstructorCallExpression(node BoundClrConstructorCallExpression) {
            VisitCallableArguments(node.Arguments)
            InvalidateRefKindArguments(node.Arguments, node.ArgumentRefKinds)
            InvalidateImportedParameterRefArguments(node.Arguments, node.Constructor.GetParameters())
        }

        private func InvalidateRefKindArguments(
            arguments ImmutableArray[BoundExpression],
            refKinds ImmutableArray[RefKind]
        ) {
            if refKinds.IsDefaultOrEmpty {
                return
            }
            let count = Math.Min(arguments.Length, refKinds.Length)
            for var i = 0; i < count; i++ {
                if refKinds[i] is RefKind.Ref or RefKind.Out {
                    RecordWritableReference(arguments[i], invalidateCallableState: true)
                }
            }
        }

        private func InvalidateParameterRefArguments(
            arguments ImmutableArray[BoundExpression],
            parameters ImmutableArray[ParameterSymbol]
        ) {
            let count = Math.Min(arguments.Length, parameters.Length)
            for var i = 0; i < count; i++ {
                if parameters[i].RefKind is RefKind.Ref or RefKind.Out {
                    RecordWritableReference(arguments[i], invalidateCallableState: true)
                }
            }
        }

        private func InvalidateImportedParameterRefArguments(
            arguments ImmutableArray[BoundExpression],
            parameters[]ParameterInfo
        ) {
            let count = Math.Min(arguments.Length, parameters.Length)
            for var i = 0; i < count; i++ {
                if RefCapabilities.GetParameterRefKind(parameters[i]) is RefKind.Ref or RefKind.Out {
                    RecordWritableReference(arguments[i], invalidateCallableState: true)
                }
            }
        }

        protected open override func VisitClrConversionCallExpression(node BoundClrConversionCallExpression) {
            VisitCallableArguments(ImmutableArray.Create(node.Source))
        }

        private data struct CallableProvenance(
            NormalTargets[]?BoundFunctionLiteralExpression,
            IsNormalExternal bool,
            IsNormalUnknown bool,
            AllTargets[]?BoundFunctionLiteralExpression,
            IsExternal bool,
            IsUnknown bool
        ) { }

        private func SnapshotCallableArgument(argument BoundExpression) CallableProvenance {
            let hasNormalTargets = normalCallableState.TryGetFunctionLiterals(argument, out var normalLiterals)
            let normalTargetArray = normalLiterals?.ToArray()
            let isNormalExternal = normalCallableState.IsExternalCallable(argument)
            let isNormalUnknown = normalCallableState.IsUnknownCallable(argument) ||
                (!hasNormalTargets && !isNormalExternal)
            let hasAllTargets = allEntryCallableState.TryGetFunctionLiterals(argument, out var allLiterals)
            let allTargetArray = allLiterals?.ToArray()
            let isExternal = allEntryCallableState.IsExternalCallable(argument)
            let isUnknown = allEntryCallableState.IsUnknownCallable(argument) || (!hasAllTargets && !isExternal)
            return CallableProvenance(
                normalTargetArray,
                isNormalExternal,
                isNormalUnknown,
                allTargetArray,
                isExternal,
                isUnknown
            )
        }

        private func VisitAndSnapshotCallableArguments(
            arguments ImmutableArray[BoundExpression]
        )[]?CallableProvenance? {
            var snapshots[]?CallableProvenance? = nil
            for var i = 0; i < arguments.Length; i++ {
                let argument = arguments[i]
                VisitExpression(argument)
                if !IsCallableType(argument.Type) {
                    continue
                }
                if snapshots == nil {
                    snapshots = [arguments.Length]CallableProvenance?
                }
                snapshots[i] = SnapshotCallableArgument(argument)
            }
            for argument in arguments {
                InvalidateWritableArgumentExpression(argument)
            }
            return snapshots
        }

        private func InvalidateWritableArgumentExpression(expression BoundExpression) {
            var current = expression
            while current is BoundConversionExpression conversion {
                current = conversion.Expression
            }
            while current is BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                current = assertion.Operand
            }
            if current is BoundAddressOfExpression{IsReadOnly: false} address {
                RecordWritableReference(address.Operand, invalidateCallableState: true)
            } else if current is BoundConditionalExpression conditional {
                InvalidateWritableArgumentExpression(conditional.WhenTrue)
                InvalidateWritableArgumentExpression(conditional.WhenFalse)
            }
        }

        private func ApplyCallableArguments(snapshots[]?CallableProvenance?) {
            if snapshots == nil {
                return
            }
            var previous = CaptureCallableState()
            while true {
                for maybeSnapshot in snapshots {
                    if maybeSnapshot is not{} snapshot {
                        continue
                    }
                    VisitCallableTargets(
                        snapshot.NormalTargets,
                        normalKeepsEntry: true,
                        snapshot.AllTargets,
                        allKeepsEntry: true
                    )
                    if snapshot.IsExternal {
                        MarkMayMutateGlobalRoots(runsSourceCode: false)
                    }
                    if snapshot.IsNormalUnknown {
                        normalCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
                    }
                    if snapshot.IsUnknown {
                        MayMutateAnyRoot = true
                        allEntryCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
                    }
                }
                MergeCallableState(previous)
                let joined = CaptureCallableState()
                if CallableStatesEqual(previous, joined) {
                    RestoreCallableState(joined)
                    return
                }
                previous = joined
            }
        }

        private func VisitCallableArguments(arguments ImmutableArray[BoundExpression]) {
            ApplyCallableArguments(VisitAndSnapshotCallableArguments(arguments))
        }

        protected open override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            if node.Initializer != nil && TryGetWritableReferenceOperand(node.Initializer, out var operand) {
                writableReferenceAliases[node.Variable] = operand!!
            }
            base.VisitVariableDeclaration(node)
            let inFunctionLiteral = visitedFunctionLiterals.Count > 0
            normalCallableState.ApplyVariableDeclaration(node, inFunctionLiteral)
            allEntryCallableState.ApplyVariableDeclaration(node, inFunctionLiteral)
        }

        protected open override func VisitBlockStatement(node BoundBlockStatement) {
            let statements = node.Statements
            let count = statements.Length
            if node.Syntax is IfLetStatementSyntax &&
                count >= 5 &&
                statements[count - 4] is BoundGotoStatement endGoto &&
                statements[count - 3] is BoundLabelStatement elseLabel &&
                statements[count - 1] is BoundLabelStatement endLabel &&
                endGoto.Label == endLabel
                .Label {
                var elseEntry(Normal CallableAliasState, AllEntry CallableAliasState)? = nil
                for var i = 0; i < count - 5; i++ {
                    let current = statements[i]
                    if current is BoundConditionalGotoStatement condGoto &&
                        condGoto.Label == elseLabel.Label &&
                        !condGoto
                        .JumpIfTrue {
                        let (whenTrue, whenFalse) = VisitCondition(condGoto.Condition)
                        elseEntry = JoinCallableStates(elseEntry, whenFalse)
                        RestoreCallableState(whenTrue)
                    } else {
                        VisitStatement(current)
                    }
                }
                let afterHeader = CaptureCallableState()
                let thenStatement = statements[count - 5]
                let elseStatement = statements[count - 2]
                VisitStatement(thenStatement)
                let thenState = CaptureCallableState()
                RestoreCallableState(elseEntry ?? afterHeader)
                VisitStatement(elseStatement)
                let elseState = CaptureCallableState()
                var joined(Normal CallableAliasState, AllEntry CallableAliasState)? = nil
                if !StatementBinder.EndsInUnconditionalExit(thenStatement, gotoExits: false) {
                    joined = JoinCallableStates(joined, thenState)
                }
                if !StatementBinder.EndsInUnconditionalExit(elseStatement, gotoExits: false) {
                    joined = JoinCallableStates(joined, elseState)
                }
                RestoreCallableState(joined ?? afterHeader)
                return
            }
            base.VisitBlockStatement(node)
        }

        protected open override func VisitIfStatement(node BoundIfStatement) {
            let (whenTrue, whenFalse) = VisitCondition(node.Condition)
            let afterCondition = CaptureCallableState()
            RestoreCallableState(whenTrue)
            VisitStatement(node.ThenStatement)
            let thenState = CaptureCallableState()
            RestoreCallableState(whenFalse)
            VisitStatement(node.ElseStatement)
            let elseState = CaptureCallableState()
            var joined(Normal CallableAliasState, AllEntry CallableAliasState)? = nil
            if !StatementBinder.EndsInUnconditionalExit(node.ThenStatement, gotoExits: false) {
                joined = JoinCallableStates(joined, thenState)
            }
            if node.ElseStatement == nil || !StatementBinder.EndsInUnconditionalExit(
                node.ElseStatement,
                gotoExits: false
            ) {
                joined = JoinCallableStates(joined, elseState)
            }
            RestoreCallableState(joined ?? afterCondition)
        }

        protected open override func VisitConditionalGotoStatement(node BoundConditionalGotoStatement) {
            VisitExpression(node.Condition)
            jumpedRegionLabels.Add(node.Label)
            if !visitedLabels.Contains(node.Label) {
                pendingConditionalTargets.Add(node.Label)
            }
        }

        protected open override func VisitForInfiniteStatement(
            node BoundForInfiniteStatement
        ) -> VisitPossiblySkippedBody(node.Body)

        protected open override func VisitForEllipsisStatement(node BoundForEllipsisStatement) {
            VisitExpression(node.LowerBound)
            VisitExpression(node.UpperBound)
            VisitPossiblySkippedBody(node.Body)
        }

        protected open override func VisitForRangeStatement(node BoundForRangeStatement) {
            VisitExpression(node.Collection)
            // ADR-0208 R11 (#5170): lowering adds GetEnumerator, MoveNext and Current calls, and an
            // iterator body runs inside them. Indexed iteration runs no user code.
            let runsUserCode = node.IterationKind != ForRangeKind.Indexed
            if runsUserCode {
                MarkMayMutateGlobalRoots()
            }
            VisitPossiblySkippedBody(node.Body, runsUserCode)
        }

        protected open override func VisitAwaitForRangeStatement(node BoundAwaitForRangeStatement) {
            VisitExpression(node.Stream)
            MarkMayMutateGlobalRoots()
            VisitPossiblySkippedBody(node.Body, iterationRunsUserCode: true)
        }

        protected open override func VisitPatternSwitchStatement(node BoundPatternSwitchStatement) {
            VisitExpression(node.Discriminant)
            let branchStart = CaptureCallableState()
            var dispatchState = CloneCallableState(branchStart)
            var canMiss = !node.IsExhaustive
            var joined(Normal CallableAliasState, AllEntry CallableAliasState)? = nil
            for arm in node.GetDispatchArms() {
                RestoreCallableState(dispatchState)
                VisitPattern(arm.Pattern)
                let patternFailure = CaptureCallableState()
                VisitExpression(arm.Guard)
                let guardFailure = CaptureCallableState()
                VisitStatement(arm.Body)
                if !StatementBinder.EndsInUnconditionalExit(arm.Body, gotoExits: false) {
                    joined = JoinCallableStates(joined, CaptureCallableState())
                }
                if arm.IsCatchAll {
                    canMiss = false
                } else {
                    dispatchState = if arm.Guard == nil {
                        patternFailure
                    } else if arm.PatternMatchesAllInputs {
                        guardFailure
                    } else {
                        JoinCallableStates(patternFailure, guardFailure)
                    }
                }
            }
            if canMiss {
                joined = JoinCallableStates(joined, dispatchState)
            }
            RestoreCallableState(joined ?? branchStart)
        }

        protected open override func VisitSwitchExpression(node BoundSwitchExpression) {
            VisitExpression(node.Discriminant)
            let branchStart = CaptureCallableState()
            var dispatchState = CloneCallableState(branchStart)
            var canMiss = true
            var joined(Normal CallableAliasState, AllEntry CallableAliasState)? = nil
            for arm in node.GetDispatchArms() {
                RestoreCallableState(dispatchState)
                VisitPattern(arm.Pattern)
                let patternFailure = CaptureCallableState()
                VisitExpression(arm.Guard)
                let guardFailure = CaptureCallableState()
                VisitExpression(arm.Result)
                joined = JoinCallableStates(joined, CaptureCallableState())
                if arm.IsCatchAll {
                    canMiss = false
                    break
                }
                dispatchState = if arm.Guard == nil {
                    patternFailure
                } else if arm.PatternMatchesAllInputs {
                    guardFailure
                } else {
                    JoinCallableStates(patternFailure, guardFailure)
                }
            }
            // The unmatched path includes evaluated guards, but no result.
            if node.Type == TypeSymbol.Void && canMiss {
                joined = JoinCallableStates(joined, dispatchState)
            }
            RestoreCallableState(joined ?? branchStart)
        }

        protected open override func VisitReturnStatement(node BoundReturnStatement) {
            base.VisitReturnStatement(node)
            if visitedFunctionLiterals.Count > 0 {
                if functionLiteralFinallyDepth > 0 {
                    functionLiteralTryReturnState = JoinCallableStates(
                        functionLiteralTryReturnState,
                        CaptureCallableState()
                    )
                } else {
                    functionLiteralReturnState = JoinCallableStates(functionLiteralReturnState, CaptureCallableState())
                }
            }
        }

        protected open override func VisitTryStatement(node BoundTryStatement) {
            ContainsTry = true
            if node.Syntax is TryStatementSyntax trySyntax {
                for clause in trySyntax.CatchClauses {
                    if clause.Filter != nil {
                        VisitedCatchFilters.Add(clause.Filter)
                    }
                }
            }
            let hasFinally = node.FinallyBlock != nil && visitedFunctionLiterals.Count > 0
            let outerTryReturnState = functionLiteralTryReturnState
            if hasFinally {
                functionLiteralFinallyDepth++
                functionLiteralTryReturnState = nil
            }
            let branchStart = CaptureCallableState()
            let outerTryAssignments = tryAssignedVariables
            let assignedInTry = HashSet[VariableSymbol]()
            tryAssignedVariables = assignedInTry
            VisitStatement(node.TryBlock)
            tryAssignedVariables = outerTryAssignments
            outerTryAssignments?.UnionWith(assignedInTry)
            let tryState = CaptureCallableState()
            let exceptionalNormal = branchStart.Normal.Clone()
            let exceptionalAllEntry = branchStart.AllEntry.Clone()
            for variable in assignedInTry {
                exceptionalNormal.Literals.Remove(variable)
                exceptionalNormal.External.Remove(variable)
                exceptionalNormal.Unknown.Add(variable)
                exceptionalAllEntry.Literals.Remove(variable)
                exceptionalAllEntry.External.Remove(variable)
                exceptionalAllEntry.Unknown.Add(variable)
            }
            var exceptionalState = (Normal: exceptionalNormal, AllEntry: exceptionalAllEntry)
            // ADR-0208 R10 (#5168): a replacement exception reaches a clause after the filters of
            // all clauses ran, so every handler starts from the state with their effects.
            for clause in node.CatchClauses {
                if clause.Filter != nil {
                    RestoreCallableState(exceptionalState)
                    VisitExpression(clause.Filter)
                    exceptionalState = JoinCallableStates(exceptionalState, CaptureCallableState())
                }
            }
            var finallyEntries = CallableAliasState.Join(tryState.AllEntry.Clone(), exceptionalState.AllEntry)
            var joinedNormal CallableAliasState? = if StatementBinder.EndsInUnconditionalExit(
                node.TryBlock,
                gotoExits: false
            ) {
                nil
            } else {
                tryState.Normal
            }
            var joinedAllEntry CallableAliasState? = if StatementBinder.EndsInUnconditionalExit(
                node.TryBlock,
                gotoExits: false
            ) {
                nil
            } else {
                tryState.AllEntry
            }
            for clause in node.CatchClauses {
                RestoreCallableState(exceptionalState)
                VisitExpression(clause.Filter)
                VisitStatement(clause.Body)
                let catchState = CaptureCallableState()
                finallyEntries = CallableAliasState.Join(finallyEntries, catchState.AllEntry)
                if !StatementBinder.EndsInUnconditionalExit(clause.Body, gotoExits: false) {
                    joinedNormal = CallableAliasState.Join(joinedNormal, catchState.Normal)
                    joinedAllEntry = CallableAliasState.Join(joinedAllEntry, catchState.AllEntry)
                }
            }
            let tryReturnState = functionLiteralTryReturnState
            if hasFinally {
                functionLiteralFinallyDepth--
                functionLiteralTryReturnState = outerTryReturnState
                if tryReturnState is {} returningState {
                    finallyEntries = CallableAliasState.Join(finallyEntries, returningState.AllEntry)
                }
            }
            if node.FinallyBlock != nil {
                let declaredStart = declaredRegionLabels.Count
                let jumpedStart = jumpedRegionLabels.Count
                let finallyNormalEntry = if tryReturnState is {} returningEntry {
                    CallableAliasState.Join(joinedNormal, returningEntry.Normal)
                } else {
                    joinedNormal
                }
                normalCallableState.RestoreFrom(finallyNormalEntry ?? finallyEntries)
                allEntryCallableState.RestoreFrom(finallyEntries)
                VisitStatement(node.FinallyBlock)
                if hasFinally && tryReturnState != nil && !StatementBinder.EndsInUnconditionalExit(
                    node.FinallyBlock,
                    gotoExits: false
                ) {
                    let returnAfterFinally = CaptureCallableState()
                    if functionLiteralFinallyDepth > 0 {
                        functionLiteralTryReturnState = JoinCallableStates(
                            functionLiteralTryReturnState,
                            returnAfterFinally
                        )
                    } else {
                        functionLiteralReturnState = JoinCallableStates(functionLiteralReturnState, returnAfterFinally)
                    }
                }
                if joinedNormal == nil || StatementBinder.EndsInUnconditionalExit(
                    node.FinallyBlock,
                    gotoExits: false
                ) ||
                    HasEscapingRegionJump(declaredStart, jumpedStart) {
                    normalCallableState.RestoreFrom(allEntryCallableState)
                }
            } else {
                normalCallableState.RestoreFrom(joinedNormal ?? finallyEntries)
                allEntryCallableState.RestoreFrom(joinedAllEntry ?? finallyEntries)
            }
        }

        internal func HasEscapingJump() bool -> HasEscapingRegionJump(0, 0)

        private func HasEscapingRegionJump(declaredStart int32, jumpedStart int32) bool {
            if jumpedRegionLabels.Count <= jumpedStart {
                return false
            }
            for var i = jumpedStart; i < jumpedRegionLabels.Count; i++ {
                let target = jumpedRegionLabels[i]
                var isLocal = false
                for var j = declaredStart; j < declaredRegionLabels.Count; j++ {
                    if declaredRegionLabels[j] == target {
                        isLocal = true
                        break
                    }
                }
                if !isLocal {
                    return true
                }
            }
            return false
        }

        private func VisitPossiblySkippedBody(body BoundStatement, iterationRunsUserCode bool = false) {
            let entry = CaptureCallableState()
            var previous = entry
            while true {
                RestoreCallableState(previous)
                VisitStatement(body)
                if iterationRunsUserCode {
                    MarkMayMutateGlobalRoots()
                }
                MergeCallableState(previous)
                let joined = CaptureCallableState()
                if CallableStatesEqual(previous, joined) {
                    RestoreCallableState(joined)
                    return
                }
                previous = joined
            }
        }

        private func CaptureCallableState()(Normal CallableAliasState, AllEntry CallableAliasState) -> (
            normalCallableState.Clone(),
            allEntryCallableState.Clone()
        )

        private func RestoreCallableState(state(Normal CallableAliasState, AllEntry CallableAliasState)) {
            normalCallableState.RestoreFrom(state.Normal)
            allEntryCallableState.RestoreFrom(state.AllEntry)
        }

        private func MergeCallableState(state(Normal CallableAliasState, AllEntry CallableAliasState)) {
            normalCallableState.MergeFrom(state.Normal)
            allEntryCallableState.MergeFrom(state.AllEntry)
        }

        private func AnalyzeCallableInvocation(
            expression BoundExpression,
            targetState(Normal CallableAliasState, AllEntry CallableAliasState)? = nil,
            argumentSnapshots[]?CallableProvenance? = nil
        ) {
            let callable = UnwrapCallable(expression)
            if callable is BoundFunctionLiteralExpression direct {
                VisitFunctionLiteralBody(direct, argumentSnapshots)
                return
            }
            if callable is not BoundVariableExpression variable {
                MayMutateAnyRoot = true
                normalCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
                allEntryCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
                return
            }
            callableInvocations.Add(variable.Variable)
            AnalyzeCallableVariable(variable.Variable, targetState, argumentSnapshots)
        }

        private func AnalyzeCallableVariable(
            variable VariableSymbol,
            targetState(Normal CallableAliasState, AllEntry CallableAliasState)? = nil,
            argumentSnapshots[]?CallableProvenance? = nil
        ) {
            let normalSource = targetState?.Normal ?? normalCallableState
            let allSource = targetState?.AllEntry ?? allEntryCallableState
            let isReadonlyCallableParameter = variable is ParameterSymbol &&
                variable.IsReadOnly == true &&
                !normalSource
                .LocalParameters
                .Contains(variable) && !allSource.LocalParameters.Contains(variable)
            normalSource.Literals.TryGetValue(variable, out var normalLiterals)
            let normalTargetArray = normalLiterals?.ToArray()
            let isNormalExternal = isReadonlyCallableParameter || normalSource.External.Contains(variable)
            let isNormalUnknown = normalSource.Unknown.Contains(variable) ||
                (!isNormalExternal && normalLiterals == nil)
            allSource.Literals.TryGetValue(variable, out var allLiterals)
            let allTargetArray = allLiterals?.ToArray()
            let isExternal = isReadonlyCallableParameter || allSource.External.Contains(variable)
            let isUnknown = allSource.Unknown.Contains(variable) || (!isExternal && allLiterals == nil)
            VisitCallableTargets(
                normalTargetArray,
                isNormalExternal || isNormalUnknown,
                allTargetArray,
                isExternal || isUnknown,
                argumentSnapshots
            )
            // A read-only callable parameter originates outside this function
            // and cannot capture this function's local slots.
            MayMutateAnyRoot |= isUnknown
            if isNormalUnknown {
                normalCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
            }
            if isUnknown {
                allEntryCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
            }
            if isExternal {
                MarkMayMutateGlobalRoots(runsSourceCode: false)
                MayMutateWritableReferenceRoots = true
                RecordReferenceStorageWrite(nil)
            }
        }

        private func VisitCallableTargets(
            normalTargets[]?BoundFunctionLiteralExpression,
            normalKeepsEntry bool,
            allTargets[]?BoundFunctionLiteralExpression,
            allKeepsEntry bool,
            argumentSnapshots[]?CallableProvenance? = nil
        ) {
            if (normalTargets == nil || normalTargets.Length == 0) && (allTargets == nil || allTargets.Length == 0) {
                return
            }
            let entryState = CaptureCallableState()
            let normalSet = if normalTargets == nil {
                default(HashSet[BoundFunctionLiteralExpression]?)
            } else {
                HashSet[BoundFunctionLiteralExpression](normalTargets)
            }
            let allSet = if allTargets == nil {
                default(HashSet[BoundFunctionLiteralExpression]?)
            } else {
                HashSet[BoundFunctionLiteralExpression](allTargets)
            }
            let combined = List[BoundFunctionLiteralExpression]()
            let seen = HashSet[BoundFunctionLiteralExpression]()
            if normalTargets != nil {
                for literal in normalTargets {
                    if seen.Add(literal) {
                        combined.Add(literal)
                    }
                }
            }
            if allTargets != nil {
                for literal in allTargets {
                    if seen.Add(literal) {
                        combined.Add(literal)
                    }
                }
            }
            var joinedNormal CallableAliasState? = if normalKeepsEntry {
                entryState.Normal.Clone()
            } else {
                default(CallableAliasState?)
            }
            var joinedAllEntry CallableAliasState? = if allKeepsEntry {
                entryState.AllEntry.Clone()
            } else {
                default(CallableAliasState?)
            }
            for literal in combined {
                if literal.Body == nil || visitedFunctionLiterals.Contains(literal) {
                    if normalSet != nil && normalSet.Contains(literal) {
                        joinedNormal = CallableAliasState.Join(joinedNormal, entryState.Normal)
                    }
                    if allSet != nil && allSet.Contains(literal) {
                        joinedAllEntry = CallableAliasState.Join(joinedAllEntry, entryState.AllEntry)
                    }
                    continue
                }
                RestoreCallableState(CloneCallableState(entryState))
                VisitFunctionLiteralBody(literal, argumentSnapshots)
                let exitState = CaptureCallableState()
                if normalSet != nil && normalSet.Contains(literal) {
                    joinedNormal = CallableAliasState.Join(joinedNormal, exitState.Normal)
                }
                if allSet != nil && allSet.Contains(literal) {
                    joinedAllEntry = CallableAliasState.Join(joinedAllEntry, exitState.AllEntry)
                }
            }
            normalCallableState.RestoreFrom(joinedNormal ?? entryState.Normal)
            allEntryCallableState.RestoreFrom(joinedAllEntry ?? entryState.AllEntry)
        }

        private func InvalidateCallableStateForUnknownClosure() {
            normalCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
            allEntryCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
        }

        // [`runsSourceCode`](paramref) is false for a call through a callable value: it keeps its own classification
        // (ADR-0208 row R15).
        private func MarkMayMutateGlobalRoots(
            writesReferenceStorage bool = true,
            runsSourceCode bool = true,
            invalidateCallableAliases bool = true
        ) {
            if runsSourceCode {
                MarkRunsEscapedClosure(invalidateCallableAliases)
            }
            // User code can also write members and the storage behind by-reference aliases.
            MayMutateMemberPaths = true
            if writesReferenceStorage {
                RecordReferenceStorageWrite(nil)
            }
            MayMutateGlobalRoots = true
            // No enclosing assignment: nothing is protected, so no set is built for every node.
            if enclosingGlobalAssignments.Count == 0 {
                if globalMutationProtectedRoots == nil {
                    globalMutationProtectedRoots = HashSet[VariableSymbol]()
                } else {
                    globalMutationProtectedRoots!!.Clear()
                }
                return
            }
            let protectedRoots = enclosingGlobalAssignments.ToHashSet()
            if globalMutationProtectedRoots == nil {
                globalMutationProtectedRoots = protectedRoots
            } else {
                globalMutationProtectedRoots!!.IntersectWith(protectedRoots)
            }
        }

        private func MarkRunsEscapedClosure(invalidateCallableAliases bool = true) {
            MayRunEscapedClosure = true
            if invalidateCallableAliases {
                normalCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
                allEntryCallableState.InvalidateClosureAssigned(isClosureAssigned, tryAssignedVariables)
            }
            if enclosingAssignments.Count == 0 {
                if escapedClosureProtectedRoots == nil {
                    escapedClosureProtectedRoots = HashSet[VariableSymbol]()
                } else {
                    escapedClosureProtectedRoots!!.Clear()
                }
                return
            }
            let protectedRoots = enclosingAssignments.ToHashSet()
            if escapedClosureProtectedRoots == nil {
                escapedClosureProtectedRoots = protectedRoots
            } else {
                escapedClosureProtectedRoots!!.IntersectWith(protectedRoots)
            }
        }

        /// Whether a node of this walk can run an escaped closure that writes [`root`](paramref) after the walk
        /// started. A root that every such node assigns afterwards is not in the set (ADR-0208 row R15).
        func MayRunEscapedClosureOn(root VariableSymbol) bool -> MayRunEscapedClosure &&
            (escapedClosureProtectedRoots == nil || !escapedClosureProtectedRoots!!.Contains(root))

        private func VisitFunctionLiteralBody(
            literal BoundFunctionLiteralExpression,
            argumentSnapshots[]?CallableProvenance? = nil
        ) {
            if literal.Body is not{} body || !visitedFunctionLiterals.Add(literal) {
                return
            }
            for captured in literal.CapturedVariables {
                normalCallableState.CapturedVariables.Add(captured)
                allEntryCallableState.CapturedVariables.Add(captured)
            }
            let parameters = literal.Function.Parameters
            for var i = 0; i < parameters.Length; i++ {
                let parameter = parameters[i]
                if !IsCallableType(parameter.Type) {
                    continue
                }
                if argumentSnapshots != nil && i < argumentSnapshots.Length && argumentSnapshots[i] is {} snapshot {
                    normalCallableState.ApplyParameterSnapshot(
                        parameter,
                        snapshot.NormalTargets,
                        snapshot.IsNormalExternal,
                        snapshot.IsNormalUnknown
                    )
                    allEntryCallableState.ApplyParameterSnapshot(
                        parameter,
                        snapshot.AllTargets,
                        snapshot.IsExternal,
                        snapshot.IsUnknown
                    )
                } else {
                    normalCallableState.ApplyParameterSnapshot(parameter, nil, isExternal: false, isUnknown: true)
                    allEntryCallableState.ApplyParameterSnapshot(parameter, nil, isExternal: false, isUnknown: true)
                }
            }
            let declaredBefore = declaredRegionLabels.Count
            let jumpedBefore = jumpedRegionLabels.Count
            let outerReturnState = functionLiteralReturnState
            let outerTryReturnState = functionLiteralTryReturnState
            let outerFinallyDepth = functionLiteralFinallyDepth
            functionLiteralReturnState = nil
            functionLiteralTryReturnState = nil
            functionLiteralFinallyDepth = 0
            try {
                VisitStatement(body)
                if !StatementBinder.EndsInUnconditionalExit(body, gotoExits: false) {
                    functionLiteralReturnState = JoinCallableStates(functionLiteralReturnState, CaptureCallableState())
                }
                if functionLiteralReturnState is {} exitState {
                    RestoreCallableState(exitState)
                }
            } finally {
                functionLiteralReturnState = outerReturnState
                functionLiteralTryReturnState = outerTryReturnState
                functionLiteralFinallyDepth = outerFinallyDepth
                if declaredRegionLabels.Count > declaredBefore {
                    declaredRegionLabels.RemoveRange(declaredBefore, declaredRegionLabels.Count - declaredBefore)
                }
                if jumpedRegionLabels.Count > jumpedBefore {
                    jumpedRegionLabels.RemoveRange(jumpedBefore, jumpedRegionLabels.Count - jumpedBefore)
                }
                visitedFunctionLiterals.Remove(literal)
            }
        }

        protected open override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            let assignedValue = UnwrapCallable(node.Expression)
            if !assignedValue.Type.IsValueType && !(assignedValue is BoundLiteralExpression{Value: nil}) {
                // Erased callable copies still transfer provenance in evaluation order.
                hasAliasSensitiveOperations = true
            }
            let protectedGlobalRoot GlobalVariableSymbol? = node.Variable as GlobalVariableSymbol
            if protectedGlobalRoot != nil {
                enclosingGlobalAssignments.Push(protectedGlobalRoot)
            }
            if node.Variable != nil {
                enclosingAssignments.Push(node.Variable)
            }
            base.VisitAssignmentExpression(node)
            if node.Variable != nil {
                enclosingAssignments.Pop()
            }
            if protectedGlobalRoot != nil {
                enclosingGlobalAssignments.Pop()
            }
            if node.Variable != nil {
                writableReferenceAliases.Remove(node.Variable)
                tryAssignedVariables?.Add(node.Variable)
                normalCallableState.ApplyAssignment(
                    node,
                    pendingConditionalTargets.Count,
                    mayShareStorage,
                    tryAssignedVariables
                )
                allEntryCallableState.ApplyAssignment(
                    node,
                    pendingConditionalTargets.Count,
                    mayShareStorage,
                    tryAssignedVariables
                )
                Roots.Add(node.Variable)
                if !assignments.TryGetValue(node.Variable, out var rootAssignments) {
                    rootAssignments = List[BoundAssignmentExpression]()
                    assignments.Add(node.Variable, rootAssignments)
                }
                rootAssignments.Add(node)
            }
        }

        protected open override func VisitAddressOfExpression(node BoundAddressOfExpression) {
            if !node.IsReadOnly {
                RecordWritableReference(node.Operand)
            }
            base.VisitAddressOfExpression(node)
        }

        private func RecordWritableReference(expression BoundExpression, invalidateCallableState bool = false) {
            var expression = expression
            while true {
                expression = switch expression {
                    case address is BoundAddressOfExpression: address.Operand
                    case conversion is BoundConversionExpression: conversion.Expression
                    case BoundUnaryExpression{
                        Op: {Kind: BoundUnaryOperatorKind.NullAssertion}
                    } assertion: assertion.Operand
                    default: expression
                }
                if !(expression is BoundAddressOfExpression) &&
                    !(expression is BoundConversionExpression) &&
                    !(
                    expression is BoundUnaryExpression && expression.Op.Kind == BoundUnaryOperatorKind.NullAssertion
                ) {
                    break
                }
            }
            if expression is BoundVariableExpression variable {
                Roots.Add(variable.Variable)
                WritableReferenceRoots.Add(variable.Variable)
                if invalidateCallableState {
                    normalCallableState.InvalidateVariable(variable.Variable, mayShareStorage, tryAssignedVariables)
                    allEntryCallableState.InvalidateVariable(variable.Variable, mayShareStorage, tryAssignedVariables)
                }
                return
            }
            if expression is BoundConditionalAddressExpression conditional {
                RecordWritableReference(conditional.WhenTrueOperand, invalidateCallableState)
                RecordWritableReference(conditional.WhenFalseOperand, invalidateCallableState)
                return
            }
            if expression is BoundFieldAccessExpression fieldAccess && fieldAccess.Field != nil {
                assignedFields.Add(fieldAccess.Field.OriginalDefinition ?? fieldAccess.Field)
            }
            if !SmartCastStability.TryGetStableMemberPath(expression, out var path, out _) {
                if expression is BoundIndexExpression || expression is BoundClrIndexExpression {
                    MayMutateMemberPaths = true
                    RecordReferenceStorageWrite(nil)
                } else {
                    MayMutateAnyRoot = true
                    MayMutateAnyRootViaPointer = true
                }
                return
            }
            if path.HasMembers {
                MayMutateMemberPaths = true
                RecordReferenceStorageWrite(nil)
            } else {
                Roots.Add(path.Root)
                if invalidateCallableState {
                    normalCallableState.InvalidateVariable(path.Root, mayShareStorage, tryAssignedVariables)
                    allEntryCallableState.InvalidateVariable(path.Root, mayShareStorage, tryAssignedVariables)
                }
            }
        }

        protected open override func VisitFieldAssignmentExpression(node BoundFieldAssignmentExpression) {
            assignedFields.Add(node.Field.OriginalDefinition ?? node.Field)
            base.VisitFieldAssignmentExpression(node)
        }

        protected open override func VisitPropertyAssignmentExpression(node BoundPropertyAssignmentExpression) {
            assignedProperties.Add(node.Property.OriginalDefinition ?? node.Property)
            base.VisitPropertyAssignmentExpression(node)
        }

        private sealed class CallableAliasState {
            let Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]] = Dictionary[
                VariableSymbol,
                HashSet[BoundFunctionLiteralExpression]
            ]()
            let Unknown HashSet[VariableSymbol] = HashSet[VariableSymbol]()
            let External HashSet[VariableSymbol] = HashSet[VariableSymbol]()
            let LocalParameters HashSet[VariableSymbol] = HashSet[VariableSymbol]()
            let CapturedVariables HashSet[VariableSymbol] = HashSet[VariableSymbol]()

            func Clone() CallableAliasState {
                let copy = CallableAliasState()
                copy.MergeFrom(this)
                return copy
            }

            func RestoreFrom(other CallableAliasState) {
                Literals.Clear()
                Unknown.Clear()
                External.Clear()
                LocalParameters.Clear()
                CapturedVariables.Clear()
                MergeFrom(other)
            }

            func SetExternalOnly(externalAliases HashSet[VariableSymbol]) {
                Literals.Clear()
                Unknown.Clear()
                External.Clear()
                External.UnionWith(externalAliases)
            }

            func MergeFrom(other CallableAliasState) {
                for entry in other.Literals {
                    if !Literals.TryGetValue(entry.Key, out var literals) {
                        literals = HashSet[BoundFunctionLiteralExpression]()
                        Literals.Add(entry.Key, literals)
                    }
                    literals.UnionWith(entry.Value)
                }
                Unknown.UnionWith(other.Unknown)
                External.UnionWith(other.External)
                LocalParameters.UnionWith(other.LocalParameters)
                CapturedVariables.UnionWith(other.CapturedVariables)
            }

            func ApplyParameterSnapshot(
                parameter ParameterSymbol,
                targets[]?BoundFunctionLiteralExpression,
                isExternal bool,
                isUnknown bool
            ) {
                LocalParameters.Add(parameter)
                let preserveCaptured = CapturedVariables.Contains(parameter)
                if targets != nil && targets.Length > 0 {
                    if preserveCaptured && Literals.TryGetValue(parameter, out var existing) {
                        existing.UnionWith(targets)
                    } else {
                        Literals[parameter] = HashSet[BoundFunctionLiteralExpression](targets)
                    }
                } else if !preserveCaptured {
                    Literals.Remove(parameter)
                }
                if isExternal {
                    External.Add(parameter)
                } else if !preserveCaptured {
                    External.Remove(parameter)
                }
                if isUnknown || ((targets == nil || targets.Length == 0) && !isExternal) {
                    Unknown.Add(parameter)
                } else if !preserveCaptured {
                    Unknown.Remove(parameter)
                }
            }

            func InvalidateVariable(
                variable VariableSymbol,
                mayShareStorage((VariableSymbol, VariableSymbol) -> bool)?,
                tryAssignedVariables HashSet[VariableSymbol]? = nil
            ) {
                Literals.Remove(variable)
                External.Remove(variable)
                Unknown.Add(variable)
                tryAssignedVariables?.Add(variable)
                if mayShareStorage != nil {
                    for other in Literals.Keys.Concat(External).Concat(Unknown).ToArray() {
                        if !object.ReferenceEquals(other, variable) && mayShareStorage(variable, other) {
                            Literals.Remove(other)
                            External.Remove(other)
                            Unknown.Add(other)
                            tryAssignedVariables?.Add(other)
                        }
                    }
                }
            }

            func EqualsState(other CallableAliasState) bool {
                return Unknown.SetEquals(other.Unknown) && External.SetEquals(other.External) &&
                    LocalParameters.SetEquals(other.LocalParameters) && CapturedVariables.SetEquals(
                    other.CapturedVariables
                ) &&
                    Literals.Count == other
                    .Literals
                    .Count &&
                    Literals
                    .All(
                    (entry KeyValuePair[VariableSymbol, HashSet[BoundFunctionLiteralExpression]]) -> other
                        .Literals
                        .TryGetValue(entry.Key, out var literals) && entry.Value.SetEquals(literals)
                )
            }

            func IsExternalCallable(expression BoundExpression) bool -> StatementBinder.IsExternalCallableSource(
                expression,
                External,
                LocalParameters
            )

            func InvalidateClosureAssigned(
                isClosureAssigned((VariableSymbol) -> bool)?,
                tryAssignedVariables HashSet[VariableSymbol]? = nil
            ) {
                if isClosureAssigned == nil {
                    return
                }
                for variable in Literals.Keys.Concat(External).ToArray() {
                    if isClosureAssigned(variable) {
                        Literals.Remove(variable)
                        External.Remove(variable)
                        Unknown.Add(variable)
                        tryAssignedVariables?.Add(variable)
                    }
                }
            }

            func IsUnknownCallable(expression BoundExpression) bool -> UnwrapCallable(
                expression
            ) is BoundVariableExpression variable &&
                Unknown.Contains(variable.Variable)

            func TryGetFunctionLiterals(
                expression BoundExpression,
                @System
                    .Diagnostics
                    .CodeAnalysis
                    .NotNullWhen(true) out literals IReadOnlyCollection[BoundFunctionLiteralExpression]?
            ) bool {
                let callable = UnwrapCallable(expression)
                if callable is BoundFunctionLiteralExpression direct {
                    literals = []BoundFunctionLiteralExpression{direct}
                    return true
                }
                if callable is BoundVariableExpression variable && Literals.TryGetValue(
                    variable.Variable,
                    out var stored
                ) {
                    literals = stored
                    return true
                }
                literals = nil
                return false
            }

            func ApplyVariableDeclaration(node BoundVariableDeclaration, inFunctionLiteral bool = false) {
                if inFunctionLiteral {
                    LocalParameters.Add(node.Variable)
                }
                if node.Initializer is not{} initializer {
                    return
                }
                let preserveCaptured = inFunctionLiteral && CapturedVariables.Contains(node.Variable)
                let externalCallable = IsExternalCallable(initializer)
                let unknownCallable = IsUnknownCallable(initializer)
                if TryGetFunctionLiterals(initializer, out var literals) {
                    if preserveCaptured && Literals.TryGetValue(node.Variable, out var existing) {
                        existing.UnionWith(literals!!)
                    } else {
                        Literals[node.Variable] = HashSet[BoundFunctionLiteralExpression](literals!!)
                    }
                    if unknownCallable {
                        Unknown.Add(node.Variable)
                    } else if !preserveCaptured {
                        Unknown.Remove(node.Variable)
                    }
                    if externalCallable {
                        External.Add(node.Variable)
                    } else if !preserveCaptured {
                        External.Remove(node.Variable)
                    }
                } else if externalCallable {
                    if !preserveCaptured {
                        Literals.Remove(node.Variable)
                    }
                    if unknownCallable {
                        Unknown.Add(node.Variable)
                    } else if !preserveCaptured {
                        Unknown.Remove(node.Variable)
                    }
                    External.Add(node.Variable)
                } else {
                    if !preserveCaptured {
                        Literals.Remove(node.Variable)
                        External.Remove(node.Variable)
                    }
                    Unknown.Add(node.Variable)
                }
            }

            func ApplyAssignment(
                node BoundAssignmentExpression,
                pendingConditionalTargetsCount int32,
                mayShareStorage((VariableSymbol, VariableSymbol) -> bool)?,
                tryAssignedVariables HashSet[VariableSymbol]? = nil
            ) {
                if node.Variable == nil {
                    return
                }
                // ADR-0208 R12 (#5171): a callable stored through a `ref` alias is stored in every
                // variable that shares its storage, and the callee is unknown.
                if mayShareStorage != nil {
                    for other in Literals.Keys.Concat(External).Concat(Unknown).ToArray() {
                        if !object.ReferenceEquals(other, node.Variable) && mayShareStorage(node.Variable, other) {
                            Literals.Remove(other)
                            External.Remove(other)
                            Unknown.Add(other)
                            tryAssignedVariables?.Add(other)
                        }
                    }
                }
                let preserveCaptured = LocalParameters.Contains(node.Variable) && CapturedVariables.Contains(
                    node.Variable
                )
                let externalCallable = IsExternalCallable(node.Expression)
                let unknownCallable = IsUnknownCallable(node.Expression)
                if TryGetFunctionLiterals(node.Expression, out var literals) {
                    if (pendingConditionalTargetsCount > 0 || preserveCaptured) && Literals.TryGetValue(
                        node.Variable,
                        out var existing
                    ) {
                        existing.UnionWith(literals!!)
                    } else {
                        Literals[node.Variable] = HashSet[BoundFunctionLiteralExpression](literals!!)
                    }
                    if unknownCallable {
                        Unknown.Add(node.Variable)
                    } else if pendingConditionalTargetsCount == 0 && !preserveCaptured {
                        Unknown.Remove(node.Variable)
                    }
                    if externalCallable {
                        MarkExternalAssignment(node.Variable, pendingConditionalTargetsCount)
                    } else if pendingConditionalTargetsCount == 0 && !preserveCaptured {
                        External.Remove(node.Variable)
                    }
                } else if externalCallable {
                    if pendingConditionalTargetsCount == 0 && !preserveCaptured {
                        Literals.Remove(node.Variable)
                    }
                    if unknownCallable {
                        Unknown.Add(node.Variable)
                    } else if pendingConditionalTargetsCount == 0 && !preserveCaptured {
                        Unknown.Remove(node.Variable)
                    }
                    MarkExternalAssignment(node.Variable, pendingConditionalTargetsCount)
                } else {
                    if pendingConditionalTargetsCount == 0 && !preserveCaptured {
                        Literals.Remove(node.Variable)
                        External.Remove(node.Variable)
                    }
                    Unknown.Add(node.Variable)
                }
            }

            // An assignment reached only on some paths (pendingConditionalTargetsCount > 0:
            // a conditional goto to a later label is still pending) leaves the other paths with whatever
            // the variable held before. Only a variable already known external
            // stays external; anything else becomes unknown (fail-safe).
            private func MarkExternalAssignment(variable VariableSymbol, pendingConditionalTargetsCount int32) {
                if pendingConditionalTargetsCount > 0 && !External.Contains(variable) {
                    Unknown.Add(variable)
                    return
                }
                External.Add(variable)
            }

            shared {
                func Join(left CallableAliasState?, right CallableAliasState) CallableAliasState {
                    if left == nil {
                        return right.Clone()
                    }
                    let joined = left.Clone()
                    let variables = joined
                        .Literals
                        .Keys
                        .Concat(joined.Unknown)
                        .Concat(joined.External)
                        .Concat(right.Literals.Keys)
                        .Concat(right.Unknown)
                        .Concat(right.External)
                        .ToHashSet()
                    for variable in variables {
                        let hasLeft = joined.Literals.ContainsKey(variable) || joined.Unknown.Contains(variable) ||
                            joined
                            .External
                            .Contains(variable)
                        let hasRight = right.Literals.ContainsKey(variable) || right.Unknown.Contains(variable) ||
                            right
                            .External
                            .Contains(variable)
                        if !hasLeft || !hasRight {
                            joined.Unknown.Add(variable)
                        }
                    }
                    joined.MergeFrom(right)
                    return joined
                }
            }
        }

        shared {
            private func TryGetWritableReferenceOperand(
                expression BoundExpression,
                @NotNullWhen(true) out operand BoundExpression?
            ) bool {
                var expression = expression
                while expression is BoundConversionExpression conversion {
                    expression = conversion.Expression
                }
                while expression is BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                    expression = assertion.Operand
                }
                operand = (expression as BoundAddressOfExpression)?.Operand
                return operand != nil
            }

            private func CallableStatesEqual(
                left(Normal CallableAliasState, AllEntry CallableAliasState),
                right(Normal CallableAliasState, AllEntry CallableAliasState)
            ) bool -> left
                .Normal
                .EqualsState(right.Normal) && left.AllEntry.EqualsState(right.AllEntry)

            private func CloneCallableState(state(Normal CallableAliasState, AllEntry CallableAliasState))(
                Normal CallableAliasState,
                AllEntry CallableAliasState
            ) -> (state.Normal.Clone(), state.AllEntry.Clone())

            private func JoinCallableStates(
                left(Normal CallableAliasState, AllEntry CallableAliasState)?,
                right(Normal CallableAliasState, AllEntry CallableAliasState)
            )(Normal CallableAliasState, AllEntry CallableAliasState) -> (
                CallableAliasState.Join(left?.Normal, right.Normal),
                CallableAliasState.Join(left?.AllEntry, right.AllEntry)
            )

            private func IsCallableType(type TypeSymbol?) bool -> (type is FunctionTypeSymbol or DelegateTypeSymbol) ||
                (type?.ClrType is {} clrType && ClrTypeUtilities.IsDelegateType(clrType))

            private func UnwrapCallable(expression BoundExpression) BoundExpression {
                var expression = expression
                while expression is BoundConversionExpression conversion {
                    expression = conversion.Expression
                }
                while expression is BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                    expression = assertion.Operand
                }
                return expression
            }
        }
    }

    private data class FinallyFlowSummary(
        Mutations AssignedRootsCollector,
        NonNullOnNormalExit Dictionary[AccessPath, TypeSymbol]?
    ) : IEquatable[FinallyFlowSummary] { }

    private func HasInternallyReachableFallthrough(statement BoundStatement) bool {
        if internallyReachableFallthroughStatements.Contains(statement) {
            return true
        }
        switch statement {
            case label is BoundLabelStatement {
                return internallyReachableLoopExits.Contains(label.Label) || internallyReachableLoopBacks.Contains(
                    label.Label
                )
            }
            case block is BoundBlockStatement {
                var fallsThrough = false
                for child in block.Statements {
                    fallsThrough = (fallsThrough || HasInternallyReachableFallthrough(child)) &&
                        !EndsInUnconditionalExit(child)
                }
                return fallsThrough
            }
            case ifStatement is BoundIfStatement {
                return (
                    HasInternallyReachableExpressionFallthrough(ifStatement.Condition) &&
                        CanCompleteNormally(ifStatement)
                ) ||
                    HasInternallyReachableFallthrough(ifStatement.ThenStatement) ||
                    (ifStatement.ElseStatement != nil && HasInternallyReachableFallthrough(ifStatement.ElseStatement))
            }
            case tryStatement is BoundTryStatement {
                return (tryStatement.FinallyBlock == nil || !EndsInUnconditionalExit(tryStatement.FinallyBlock)) &&
                    (
                    HasInternallyReachableFallthrough(tryStatement.TryBlock) || tryStatement.CatchClauses.Any(
                        (clause BoundCatchClause) -> HasInternallyReachableFallthrough(clause.Body)
                    )
                )
            }
            case switchStatement is BoundPatternSwitchStatement {
                return (
                    HasInternallyReachableExpressionFallthrough(switchStatement.Discriminant) &&
                        CanCompleteNormally(switchStatement)
                ) ||
                    switchStatement
                    .Arms
                    .Any(
                    (arm BoundPatternSwitchArm) -> (
                        HasInternallyReachableExpressionFallthrough(arm.Guard) && !EndsInUnconditionalExit(arm.Body)
                    ) ||
                        HasInternallyReachableFallthrough(arm.Body)
                )
            }
            case infiniteLoop is BoundForInfiniteStatement {
                return internallyReachableLoopExits.Contains(infiniteLoop.BreakLabel)
            }
            case ellipsisLoop is BoundForEllipsisStatement {
                return internallyReachableLoopExits.Contains(ellipsisLoop.BreakLabel) ||
                    internallyReachableLoopBacks.Contains(ellipsisLoop.ContinueLabel) ||
                    HasInternallyReachableFallthrough(ellipsisLoop.Body)
            }
            case rangeLoop is BoundForRangeStatement {
                return internallyReachableLoopExits.Contains(rangeLoop.BreakLabel) ||
                    internallyReachableLoopBacks.Contains(rangeLoop.ContinueLabel) ||
                    HasInternallyReachableFallthrough(rangeLoop.Body)
            }
            case awaitRangeLoop is BoundAwaitForRangeStatement {
                return internallyReachableLoopExits.Contains(awaitRangeLoop.BreakLabel) ||
                    internallyReachableLoopBacks.Contains(awaitRangeLoop.ContinueLabel) ||
                    HasInternallyReachableFallthrough(awaitRangeLoop.Body)
            }
            default {
                return HasInternallyReachableStatementExpressionFallthrough(statement) && CanCompleteNormally(statement)
            }
        }
    }

    private func HasInternallyReachableExpressionFallthrough(expression BoundExpression?) bool {
        if !binderCtx.FunctionContainsUserGotoOrLabel || expression == nil {
            return false
        }
        let finder = ExpressionFallthroughFinder(this)
        finder.VisitExpression(expression)
        return finder.Found
    }

    private func HasInternallyReachableStatementExpressionFallthrough(statement BoundStatement) bool {
        if !binderCtx.FunctionContainsUserGotoOrLabel {
            return false
        }
        let finder = ExpressionFallthroughFinder(this)
        finder.VisitStatement(statement)
        return finder.Found
    }

    private class ExpressionFallthroughFinder : BoundTreeWalker {
        private let owner StatementBinder

        init(owner StatementBinder) {
            this.owner = owner
        }

        prop Found bool {
            get;
            private set;
        }

        open override func VisitStatement(node BoundStatement?) {
            if Found || node == nil || node is BoundLocalFunctionDeclaration {
                return
            }
            base.VisitStatement(node)
        }

        open override func VisitExpression(node BoundExpression?) {
            if Found || node == nil || node is BoundFunctionLiteralExpression {
                return
            }
            if node is BoundBlockExpression block {
                var fallsThrough = false
                for child in block.Statements {
                    fallsThrough = (fallsThrough || owner.HasInternallyReachableFallthrough(child)) &&
                        owner.CanCompleteNormally(child)
                }
                if fallsThrough {
                    Found = true
                    return
                }
            }
            base.VisitExpression(node)
        }
    }

    /// Issue #3501 A2: when the literal declares at least one
    /// `ref`/`out`/`in` parameter, returns the synthesized
    /// delegate type backing its shape (Func/Action cannot carry by-ref type
    /// arguments); `null` for a by-value-only literal, which
    /// keeps its (cref:FunctionTypeSymbol) natural type.
    private func SynthesizeRefDelegateForLiteral(function FunctionSymbol, functionType FunctionTypeSymbol) TypeSymbol? {
        return $scope.TryGetSynthesizedRefDelegateForLiteral(function, functionType.ReturnType)
    }

    // ADR-0174 D15: `async let name = expr` starts `expr` as a child of the
    // enclosing scope and binds `name` to its eventual result:
    //   let <cell> = AsyncLetCell[R].Start(<frame>)
    //   go <expr>            // sink and result cell are <cell>
    // The binding names `R`, not a handle, so a spawn cannot outlive the scope
    // that owns it. Every read is `await name`, which reads the cell.
    private func BindAsyncLetDeclaration(syntax VariableDeclarationSyntax) BoundStatement {
        let asyncKeyword = syntax.AsyncModifier ?? syntax.Identifier
        if syntax.Initializer == nil {
            Diagnostics.ReportAsyncLetOutsideScope(asyncKeyword.Location)
            return BindErrorStatement()
        }
        if binderCtx.ScopeFrames.Count == 0 {
            // GS0551: without an owner this is the unstructured Task that D15
            // exists to avoid. Recover as an ordinary `let` so the body's other
            // diagnostics still surface.
            Diagnostics.ReportAsyncLetOutsideScope(asyncKeyword.Location)
            return BindOrdinaryVariableDeclaration(syntax)
        }
        if !binderCtx.ChannelRuntime.IsAvailable {
            Diagnostics.ReportTargetFrameworkMemberUnavailable(asyncKeyword.Location, "Gsharp.Concurrency.AsyncLetCell")
            return BindErrorStatement()
        }
        // The initializer is bound the way a `go` operand is: the child, not the
        // spawning goroutine, consumes a suspending call's completion.
        var expression = bindExpression(syntax.Initializer!!, false)
        if expression is BoundErrorExpression {
            return BoundExpressionStatement(syntax, expression)
        }
        var resultType = expression.Type ?? TypeSymbol.Error
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
        } else if AsyncReturnTypeNormalizer.TryUnwrapTaskReturnType(resultType, out var produced) {
            // An `async func` call (ADR-0023) is typed `Task[R]` and carries no
            // caller-side await, and a CLR method may return `ValueTask[R]`
            // outright. The binding names `R` either way; the child consumes
            // the task on the goroutine, as `go` already does.
            resultType = produced
        }
        if !(expression is BoundCallExpression) &&
            !(expression is BoundIndirectCallExpression) &&
            !(expression is BoundUserInstanceCallExpression) &&
            !(expression is BoundImportedCallExpression) &&
            !(expression is BoundImportedInstanceCallExpression) &&
            !(expression is BoundBaseClassCallExpression) {
            Diagnostics.ReportGoOperandIsNotACall(syntax.Initializer!!.Location)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        // Copilot review of PR #4273 / issue #4271: `async let` (ADR-0174 D15)
        // synthesizes its own BoundGoStatement directly, bypassing
        // BindGoStatement entirely — a fourth closure-synthesis path with the
        // identical capture-legality gap (see BindGoStatement's own comment
        // for the full explanation). Same fix: check the SAME expression
        // SynthesizeGoClosures will capture from.
        let asyncLetCaptured = GoCapturedVariableCollector.CollectCapturedVariables(expression)
        ClosureCaptureLegalityChecker.CheckCapturedVariables(
            asyncLetCaptured,
            Diagnostics,
            syntax.Initializer!!.Location
        )
        let runtime = binderCtx.ChannelRuntime
        let frame = binderCtx.ScopeFrames.Peek()
        let id = Interlocked.Increment(&binderCtx.SyntheticLocalCounter)
        let cell = LocalVariableSymbol("<asynclet$$cell$$$id>", isReadOnly: true, runtime.AsyncLetCellType)
        $scope.TryDeclareVariable(cell)
        let binding = AsyncLetVariableSymbol(syntax.Identifier.Text, resultType, cell, syntax.Identifier)
        if !$scope.TryDeclareVariable(binding) {
            Diagnostics.ReportSymbolAlreadyDeclared(syntax.Identifier.Location, syntax.Identifier.Text)
        }
        binderCtx.AsyncLetCells.Peek().Add(binding)
        return BoundBlockStatement(
            syntax,
            ImmutableArray.Create[BoundStatement](
                BoundVariableDeclaration(syntax, cell, runtime.BindAsyncLetStart(syntax, frame)),
                BoundGoStatement(
                    syntax,
                    expression,
                    BoundVariableExpression(nil, cell),
                    BoundVariableExpression(nil, cell),
                    resultType,
                    function?.ReceiverType ?? function?.StaticOwnerType ?? function?.LexicalEnclosingType
                )
            )
        )
    }

    private func BindVariableDeclaration(syntax VariableDeclarationSyntax) BoundStatement {
        if syntax.IsAsyncLet {
            return BindAsyncLetDeclaration(syntax)
        }
        return BindOrdinaryVariableDeclaration(syntax)
    }

    private func BindOrdinaryVariableDeclaration(syntax VariableDeclarationSyntax) BoundStatement {
        // Issue #491 (ADR-0060 follow-up): a `let ref` / `var ref` declaration introduces a
        // ref-aliasing local. The local's IL slot stores a managed pointer (`T&`) into the
        // initializer's lvalue; the symbol's static type remains `T` and reads/writes through
        // the local are implicitly indirected by the lowering & emitter. The slot itself
        // never carries a `const` value, so the assignability of the alias matches the
        // mutability of the aliased lvalue (writes through the alias write the storage).
        if syntax.HasRefKindModifier {
            return BindRefAliasLocalDeclaration(syntax)
        }
        // Issue #1886: `let Name[T, ...] = func (...) ... { ... }` declares a generic local
        // function. Route to the dedicated LambdaBinder path instead of the ordinary
        // variable-declaration binder — a generic function value cannot be represented as a
        // delegate stored in a variable.
        if syntax.TypeParameterList != nil {
            return if prepareGenericLocalFunctionDeclaration != nil {
                prepareGenericLocalFunctionDeclaration!!(syntax)()
            } else {
                throw InvalidOperationException(
                    "Generic local-function declarations require prepareGenericLocalFunctionDeclaration to be wired."
                )
                default(BoundStatement)
            }
        }
        let isReadOnly = syntax
            .Keyword
            ?.Kind == SyntaxKind.ConstKeyword ||
            syntax
            .Keyword
            ?.Kind == SyntaxKind.LetKeyword
        let type TypeSymbol? = if syntax.TypeClause is {} typeClause {
            bindTypeClause(typeClause)
        } else {
            default(TypeSymbol?)
        }
        let accessibility = resolveAccessibility(syntax.AccessibilityModifier)
        // Issue #3501 A2: when the initializer is a function literal, the
        // variable is declared BEFORE the literal's body binds (from the
        // literal's own signature, or the explicit type clause when present)
        // so the body can reference the binding it is being assigned to —
        // `let fact = func(n int32) int32 { ... fact(n - 1) ... }` is the G#
        // local-function recursion idiom.
        var preDeclaredSelf VariableSymbol? = nil
        var convertedInitializer BoundExpression?
        var variableType TypeSymbol
        var channelSlotWithoutInitializer = false
        if syntax.Initializer == nil {
            // Bare `var x T` declaration: the variable is initialized to the
            // type's zero value. The parser only produces a null initializer
            // when a type clause is present. For the magic collection types
            // (map/slice/array/sequence) the zero value is a SOUND EMPTY
            // INSTANCE, not a null reference — the bare (non-`?`) spelling
            // promises non-null, and ADR-0159 (issue #3310, the #2262 NRE)
            // makes that promise true. Channels are carved out: an
            // auto-created channel has no sensible default, so a bare
            // `chan T` slot has no zero value at all — whether that is an
            // error, and where, depends on the declared symbol's kind and is
            // decided after the symbol is created below (issue #3316). All
            // other types keep the CLR default (0 / false / all-zero struct /
            // null for reference types) here — EXCEPT `string`, which is
            // patched to `""` below (issue #3324) once we know whether the
            // symbol is a true local or a global (see that comment for why
            // this can't be decided in this branch, before the symbol
            // exists).
            variableType = type ?? TypeSymbol.Error
            channelSlotWithoutInitializer = MagicCollectionZeroValue.RequiresExplicitInitializer(variableType)
            convertedInitializer = MagicCollectionZeroValue.TrySynthesizeEmptyInstance(
                syntax,
                variableType,
                out var missingDeclarationShape
            ) ??
                BoundDefaultExpression(syntax, variableType)
            if missingDeclarationShape {
                Diagnostics.ReportNoApplicableOverload(syntax.Location, variableType.ToString())
            }
        } else {
            var unwrappedInitializer = syntax.Initializer
            while unwrappedInitializer is ParenthesizedExpressionSyntax parenthesizedInitializer {
                unwrappedInitializer = parenthesizedInitializer.Expression
            }
            // ADR-0055 Tier 4: an interpolated-string initializer whose declared
            // type is IFormattable/FormattableString lowers to
            // FormattableStringFactory.Create rather than an eager string.
            if type != nil &&
                syntax.Initializer is InterpolatedStringExpressionSyntax interpolatedInit &&
                isFormattableStringTargetType(type) {
                variableType = type
                convertedInitializer = bindInterpolatedStringAsFormattable(interpolatedInit, type)
            } else if type != nil && OverloadResolver.GetLambdaArgumentSyntax(
                syntax.Initializer
            ) is {} targetTypedLambda &&
                bindLambdaWithTargetType != nil &&
                MemberLookup
                .TryGetLambdaTargetFunctionTypeFromSymbol(type, out var targetFnType) {
                // ADR-0076 / issue #716: when a binding has an explicit
                // function-type and is initialised with an arrow lambda,
                // bind the lambda with the target shape so omitted
                // parameter type clauses are filled in from the target's
                // slots. The conversion that follows is identity for a
                // matching lambda shape; for a mismatch the regular
                // conversion diagnostic still fires.
                //
                // Issue #951: the target shape is extracted via
                // TryGetDelegateFunctionTypeFromSymbol so it also covers an
                // explicit CLR delegate binding type (e.g.
                // `let f Func[int32, int32] = (x) -> x + 1`), not just the
                // canonical `(int32) -> int32` function-type clause.
                variableType = type
                convertedInitializer = bindExpressionWithTargetType(syntax.Initializer!!, variableType)
            } else if type is PointerTypeSymbol && syntax.Initializer is StackAllocExpressionSyntax {
                // ADR-0124 / issue #1024: `var p *T = stackalloc [n]T` inside
                // an unsafe context yields the raw `T*` pointer. The target
                // pointer type must be threaded into the stackalloc binder so
                // it selects the pointer form rather than the default Span<T>.
                variableType = type
                convertedInitializer = bindExpressionWithTargetType(syntax.Initializer, type)
            } else if type != nil && type != TypeSymbol.Error && unwrappedInitializer is TupleLiteralExpressionSyntax {
                variableType = TupleTypeSymbol.ResolveNilElements(type)
                convertedInitializer = bindExpressionWithTargetType(syntax.Initializer!!, variableType)
            } else if type != nil &&
                syntax.Initializer is DefaultExpressionSyntax defaultInit &&
                defaultInit.TypeClause == nil {
                // ADR-0100 / issue #795: bare `default` initializer takes
                // its type from the declared variable type. We bind to a
                // BoundDefaultExpression of that type directly so the
                // emitter sees the value-type zero-init shape and the
                // interpreter mirrors it. The eager
                // `bindExpression(syntax.Initializer)` path would report
                // GS0362 because the kind dispatch has no target type.
                variableType = type
                convertedInitializer = BoundDefaultExpression(defaultInit, variableType)
                if syntax.Keyword?.Kind == SyntaxKind.ConstKeyword {
                    variableType = ConstantExpressionEvaluator.GetDeclarationType(convertedInitializer, variableType)
                    convertedInitializer = BoundDefaultExpression(defaultInit, variableType)
                }
            } else if type != nil &&
                (
                syntax.Initializer is IfExpressionSyntax ||
                    syntax.Initializer is IfLetExpressionSyntax ||
                    syntax.Initializer is ConditionalExpressionSyntax ||
                    syntax.Initializer is SwitchExpressionSyntax ||
                    syntax.Initializer is BlockExpressionSyntax ||
                    IsNullCoalescingExpression(syntax.Initializer) ||
                    conversions.ContainsNestedLambdaSyntax(syntax.Initializer!!)
            ) {
                // Issue #1158: when a typed local is initialised with an
                // if-/conditional-/switch-expression, thread the declared type
                // into the binder as the target type so sibling arms can unify
                // to it (C# 9+ target-typed conditional/switch), including a
                // target that is wider than the arms' natural least-upper-bound
                // (e.g. `object` or a shared interface). The conversion below is
                // identity for the chosen target; a genuine mismatch still
                // reports the regular conversion diagnostic.
                variableType = type
                let initializer = bindExpressionWithTargetType(syntax.Initializer!!, type)
                convertedInitializer = conversions.BindConversion(
                    syntax.Initializer!!.Location,
                    initializer,
                    variableType
                )
            } else {
                var initializer BoundExpression
                if syntax.Initializer is FunctionLiteralExpressionSyntax literalInitializer &&
                    bindFunctionLiteralWithSelfDeclaration != nil {
                    // Issue #3501 A2: bind the literal with a signature hook
                    // that declares the variable into the current scope before
                    // the body binds. The variable's type is the explicit type
                    // clause when present, else the literal's natural type.
                    initializer = bindFunctionLiteralWithSelfDeclaration!!(
                        literalInitializer,
                        (fn FunctionSymbol, fnType FunctionTypeSymbol) -> {
                            // Issue #3501 A2: a literal with `ref`/`out`/`in`
                            // parameters cannot live in a Func/Action-backed
                            // FunctionTypeSymbol — its inferred type is the
                            // synthesized ref-kind delegate for its shape.
                            let selfType = type ??
                                SynthesizeRefDelegateForLiteral(fn, fnType) ??
                                cast[TypeSymbol](fnType)
                            let declaredSelf = bindLocalVariableWithAccessibility(
                                syntax.Identifier,
                                isReadOnly,
                                selfType,
                                accessibility
                            )
                            if !fn.Parameters.IsDefaultOrEmpty {
                                let selfNames = ImmutableArray.CreateBuilder[string](fn.Parameters.Length)
                                for parameter in fn.Parameters {
                                    selfNames.Add(parameter.Name)
                                }
                                declaredSelf.CallableParameterNames = selfNames.MoveToImmutable()
                            }
                            preDeclaredSelf = declaredSelf
                        }
                    )
                } else {
                    initializer = bindExpression(syntax.Initializer!!, false)
                }
                let materializedInitializerType = TypeSymbol.MaterializeNeverFunctionReturns(initializer.Type)
                let synthesizedRefDelegateType = if type == nil &&
                    preDeclaredSelf == nil &&
                    initializer is BoundFunctionLiteralExpression refLiteral &&
                    materializedInitializerType is FunctionTypeSymbol materializedFunctionType {
                    SynthesizeRefDelegateForLiteral(refLiteral.Function, materializedFunctionType)
                } else {
                    default(TypeSymbol?)
                }
                variableType = type ??
                    preDeclaredSelf?.Type ??
                    synthesizedRefDelegateType ??
                    materializedInitializerType
                if syntax.TypeClause != nil && (type == nil || type == TypeSymbol.Error) {
                    convertedInitializer = BoundErrorExpression(initializer.Syntax)
                    variableType = TypeSymbol.Error
                } else if syntax.TypeClause == nil && MethodGroupDiagnostics.RequiresTarget(initializer) {
                    convertedInitializer = MethodGroupDiagnostics.ReportRequiresTarget(
                        Diagnostics,
                        initializer,
                        syntax.Initializer!!.Location
                    )
                    variableType = TypeSymbol.Error
                } else if syntax.TypeClause == nil && TypeSymbol.ContainsNeverType(variableType) {
                    // Issue #4965 (ADR-0202): an initializer that never produces
                    // a value (`let a = throw e`, or a block/if/switch every
                    // path of which exits) gives the local no type to infer.
                    // Report it like a void initializer rather than inferring the
                    // bottom type, which has no CLR representation (GS9998).
                    // `!!`: this branch is reached only when an initializer was
                    // bound (the `syntax.Initializer == nil` case is above).
                    Diagnostics.ReportExpressionMustHaveValue(syntax.Initializer!!.Location)
                    convertedInitializer = BoundErrorExpression(initializer.Syntax)
                    variableType = TypeSymbol.Error
                } else {
                    variableType = TupleTypeSymbol.ResolveNilElements(variableType)
                    if syntax.Keyword?.Kind == SyntaxKind.ConstKeyword {
                        variableType = ConstantExpressionEvaluator.GetDeclarationType(initializer, variableType)
                    }
                    convertedInitializer = conversions.BindConversion(
                        syntax.Initializer!!.Location,
                        initializer,
                        variableType
                    )
                }
                // Issue #4223: a NON-generic named local function (`let`/`var`/`const
                // Name = func (...) ... {...}`, no `[T, ...]` of its own) that
                // references an enclosing type parameter used to be rejected here
                // unconditionally (GS0468, issue #2016) on the assumption that the
                // zero-capture hoisting path could never give the enclosing type
                // parameter a valid emitted slot. That assumption was wrong for the
                // general case: UserTokenResolver.TryPromoteNonCapturingGenericLambda
                // (issue #2118) now promotes such a literal to a genuine generic
                // method, cloning every referenced enclosing type parameter as the
                // hoisted method's own — the same reification
                // ClosureEmitter.SynthesizeClosures's display-class path applies
                // when the literal is nested inside a user type for accessibility.
                //
                // One narrow combination is NOT proven safe yet and keeps the
                // diagnostic: an ASYNC zero-capture local function whose OWN
                // PARAMETER type references the enclosing type parameter. That
                // shape routes through the async "erased delegate" adapter (predates
                // #2118, used whenever a function-literal's declared type mentions an
                // open type parameter) rather than through
                // RegisterStateMachineEnclosingGenerics's reification, and the
                // adapter's parameter-unboxing conversion has a confirmed defect for
                // a value-typed instantiation (confirmed by direct repro:
                // `func Outer[U](seed U) U { let Local = async func (x U) U { return
                // x }; return Local(seed).Result }` compiles clean and then throws
                // `NullReferenceException` for `Outer(42)`, though `Outer("hi")`
                // succeeds — reproduced identically on an already-legal CAPTURING
                // async lambda of the same shape, so the adapter defect itself is
                // pre-existing and unrelated to #4223, but relaxing GS0468 here
                // would newly route a previously-rejected program through it). An
                // enclosing-type-parameter reference confined to the return type or
                // body (proven safe; see Issue4223EnclosingTypeParameterReificationTests)
                // and the GENERIC-own-type-parameter async case (which is hosted as a
                // real generic method, not the erased-delegate adapter) are unaffected.
                if initializer is BoundFunctionLiteralExpression functionLiteral &&
                    checkNonGenericLocalFunctionEnclosingTypeParameterReference != nil {
                    checkNonGenericLocalFunctionEnclosingTypeParameterReference!!(
                        syntax.Identifier.Location,
                        syntax.Identifier.ValueText,
                        functionLiteral
                    )
                }
            }
        }
        if syntax.Keyword?.Kind == SyntaxKind.ConstKeyword && convertedInitializer is {} constantInitializer {
            let constantType = ConstantExpressionEvaluator.GetDeclarationType(constantInitializer, variableType)
            if constantType != variableType {
                variableType = constantType
                convertedInitializer = conversions.BindConversion(
                    syntax.Initializer?.Location ?? syntax.Identifier.Location,
                    constantInitializer,
                    variableType
                )
            }
        }
        let variable VariableSymbol? = preDeclaredSelf ??
            bindLocalVariableWithAccessibility(syntax.Identifier, isReadOnly, variableType, accessibility)
        // Issue #3316 (ADR-0159 follow-up (a)): a bare `chan T` slot without an
        // initializer is only a declaration-site error (GS0520) for a GLOBAL —
        // a top-level declaration is emitted as a static field readable from
        // any function or REPL cell, which per-function flow analysis cannot
        // police. A genuine LOCAL declares freely; the definite-assignment
        // analysis (DefiniteAssignmentAnalyzer) instead reports GS0522 at any
        // use a path can reach without a preceding assignment — the C# CS0165
        // model, and Go's declare-then-assign shape becomes legal.
        if channelSlotWithoutInitializer && !(variable is LocalVariableSymbol) {
            if NativeProtocolMetadata.IsProtocol(variableType) {
                Diagnostics.ReportNativeProtocol(
                    syntax.Identifier.Location,
                    "a required protocol global must be initialized"
                )
            } else if ManagedReferenceTypes.TryGetElement(variableType, out _, out _) {
                Diagnostics.ReportManagedReference(
                    syntax.Identifier.Location,
                    "a non-null managed-reference global requires initialization"
                )
            } else {
                Diagnostics.ReportChannelRequiresInitializer(
                    syntax.Identifier.Location,
                    syntax.Identifier.ValueText,
                    variableType.Name
                )
            }
        }
        // Issue #3324 (ADR-0008): a bare `var s string` / `let s string`
        // LOCAL declared without an initializer zero-inits to `""`, per
        // ADR-0008's documented Go-style string zero value ("`""` for
        // string"). This is deliberately narrower than
        // MagicCollectionZeroValue's dispatch above (which only special-cases
        // the ADR-0159 magic collection types and otherwise falls back to
        // BoundDefaultExpression, i.e. the CLR default `null` for `string`):
        // class/struct FIELDS and the `default(string)` expression are a
        // separate, already-settled contract (issue #1714, PR #2788) that
        // deliberately keeps the CLR storage default (`null`) for
        // uninitialized reference-typed fields — see
        // Issue1714StringZeroValueEmitTests. A top-level `var` is emitted as
        // a static field (see the channel comment above), so only a genuine
        // LocalVariableSymbol gets the `""` treatment here; a
        // GlobalVariableSymbol falls through to the same CLR-default path
        // fields already use, keeping globals consistent with fields rather
        // than with true function locals.
        if syntax.Initializer == nil && variableType == TypeSymbol.String && variable is LocalVariableSymbol {
            convertedInitializer = BoundLiteralExpression(syntax, string.Empty, TypeSymbol.String)
        }
        variable!!.HasDefinitelyNonNullValue = isReadOnly &&
            !(variableType is NullableTypeSymbol) &&
            IsDefinitelyNonNullValue(convertedInitializer!!)
        variable!!.CallableParameterNameTree = BuildCallableParameterNameTree(convertedInitializer!!)
        // ADR-0058 / issue #376: propagate `scoped` modifier from syntax to the local symbol,
        // or infer function-local escape scope from the initializer (STE data-flow propagation).
        if variable is LocalVariableSymbol localVar {
            localVar.HoldsScopedManagedReference |= ManagedReferenceOrigins.IsScopedHandle(convertedInitializer!!)
            localVar.IsScoped |= localVar.HoldsScopedManagedReference
            if localVar.IsReadOnly && variableType is ByRefTypeSymbol {
                localVar.ManagedReferenceOrigin = if convertedInitializer is BoundAddressOfExpression address {
                    address.Operand
                } else {
                    cast[BoundExpression](
                        BoundDereferenceExpression(convertedInitializer!!.Syntax, convertedInitializer!!)
                    )
                }
            }
            if syntax.IsScoped {
                localVar.IsScoped = true
            } else if (TypeSymbol.IsByRefLike(variableType) || variableType is ByRefTypeSymbol) &&
                convertedInitializer != nil {
                // Infer scoped from initializer: if the initializer is rooted in a
                // scoped variable, the new local inherits function-local STE/RSTE.
                localVar.IsScoped = HasFunctionLocalEscapeScope(convertedInitializer)
            }
        }
        // Issue #367: a by-ref-like (`ref struct`) local is legal in an ordinary
        // function, but an iterator hoists every local into a heap-allocated
        // state machine, which the CLR forbids for a by-ref-like type. A
        // top-level (global) variable is emitted as a static field, which is
        // likewise heap-rooted and forbidden. Reject the declaration in those
        // contexts.
        //
        // Issue #2350: an async function's state machine also hoists locals,
        // but — unlike an iterator — it is legal for a by-ref-like local to
        // appear there as long as it never needs to survive an `await`
        // suspension point (the CLR forbids a by-ref-like *field*, but the
        // async lowering already never hoists such a local into one — see
        // AsyncCaptureWalker — so it is only unsafe when live across a
        // suspension). That is a per-local dataflow question this syntax-only
        // check cannot answer, so the coarse "any by-ref-like local in any
        // async function" rejection that used to live here has been replaced
        // by RefStructAsyncLivenessAnalyzer, which runs after lowering (see
        // its call sites in Binder.cs) and reports ReportByRefLikeEscape only
        // for a local actually proven live across a suspension (including via
        // unsafe try/finally interaction).
        ReportByRefLikeDeconstructOutputEscapeIfNeeded(syntax.Identifier, variableType, isDiscard: false)
        // Issue #187 / ADR-0047 §3: bind any `@Foo` annotations and attach
        // them to the variable symbol so #175 use-site diagnostics
        // (e.g. `@Obsolete`) fire when the variable is read or written.
        // Globals (`GlobalVariableSymbol`) will eventually round-trip these
        // to CLR `CustomAttribute` rows on their backing static field; for
        // locals the attributes carry compiler-recognised semantics only.
        if variable != nil && !syntax.Annotations.IsDefaultOrEmpty {
            let positionDescription = if variable is GlobalVariableSymbol {
                "a top-level variable declaration"
            } else {
                "a local variable declaration"
            }
            let boundAttrs = bindVariableDeclarationAttributes(syntax.Annotations, positionDescription)
            variable.SetAttributes(boundAttrs)
        }
        let declaredVariable = Invariant.Required(
            variable,
            "a variable declaration produces a variable symbol",
            expression: "variable"
        )
        if SmartCastStability.IsAssignmentNarrowingRoot(declaredVariable) &&
            syntax.Initializer != nil &&
            convertedInitializer != nil &&
            declaredVariable.Type is NullableTypeSymbol nonNullTarget &&
            IsReferenceLikeType(nonNullTarget.UnderlyingType) &&
            IsNonNullByRefInitializer(convertedInitializer, nonNullTarget.UnderlyingType) {
            binderCtx.NonNullByRefVariables.Add(declaredVariable)
        }
        if convertedInitializer is {} callableInitializer && IsExternalCallableSource(callableInitializer) {
            externalCallableAliases.Add(declaredVariable)
            binderCtx.NarrowedVariables.SetExternalCallables(externalCallableAliases)
        }
        // Issue #216 / #3519: a foldable `const` initializer carries its
        // target-typed compile-time value. Package constants also retain that
        // value on their symbol so every separately emitted body can inline it.
        var constValue object? = nil
        if syntax.Keyword?.Kind == SyntaxKind.ConstKeyword && convertedInitializer != nil {
            if TypeSymbol.IsByRefLike(convertedInitializer.Type) && ClrSpanTypes.TryResolveUtf8Type(
                $scope.References!!,
                out var utf8Type
            ) &&
                ClrTypeUtilities
                .AreSame(convertedInitializer.Type.ClrType, utf8Type) {
                Diagnostics.ReportInvalidUtf8StringLiteral(
                    syntax.Initializer?.Location ?? syntax.Identifier.Location,
                    "A readonly byte span is not a constant."
                )
            } else if declaredVariable is GlobalVariableSymbol && ConstantExpressionEvaluator.TryFindNativeInteger(
                convertedInitializer,
                out var nativeType
            ) {
                Diagnostics.ReportConstNativeIntegerNotSupported(
                    syntax.Identifier.Location,
                    syntax.Identifier.ValueText,
                    Invariant.Required(nativeType, "a detected native integer has a type", expression: "nativeType")
                        .Name
                )
            } else if ConstantExpressionEvaluator.TryFold(
                convertedInitializer,
                declaredVariable.Type,
                out constValue
            ) ||
                (
                declaredVariable is LocalVariableSymbol && NullableLifting.IsAnyValueTypeNullable(
                    declaredVariable.Type as NullableTypeSymbol
                ) &&
                    ConstantExpressionEvaluator.TryEvaluate(convertedInitializer, out constValue) && constValue == nil
            ) {
                // Nullable value constants have no CLR Constant row. Keep their null payload on local symbols only.
                if declaredVariable is GlobalVariableSymbol global {
                    global.SetConstantValue(constValue)
                } else if declaredVariable is LocalVariableSymbol constLocal {
                    constLocal.IsConst = true
                    constLocal.ConstantValue = constValue
                }
            } else if (
                declaredVariable is GlobalVariableSymbol ||
                    (
                    !LambdaBinder.TryGetFunctionLiteral(convertedInitializer, out _) &&
                        Conversion.IsReferenceLikeTarget(declaredVariable.Type.StripToBareShape())
                )
            ) &&
                !(convertedInitializer is BoundErrorExpression) &&
                !ConstantExpressionEvaluator
                .ContainsCheckedOutOfRangeFloatingConstantConversion(convertedInitializer) {
                // Issue #5767: the condition excludes an initializer that does not fold because of a checked
                // conversion of a value out of range. Its GS0635 gives the cause.
                Diagnostics.ReportConstFieldInitializerNotConstant(
                    syntax.Initializer?.Location ?? syntax.Identifier.Location,
                    syntax.Identifier.ValueText
                )
            }
        }
        return BoundVariableDeclaration(syntax, declaredVariable, convertedInitializer, constValue)
    }

    private func IsExternalCallableSource(expression BoundExpression) bool -> IsExternalCallableSource(
        expression,
        externalCallableAliases
    )

    /// Issue #491 (ADR-0060 follow-up): binds a `let ref name [T] = lvalue` or
    /// `var ref name [T] = lvalue` declaration. The local is recorded with
    /// (cref:RefKind.Ref) and its initializer is normalized to a
    /// (cref:BoundAddressOfExpression) over the aliased lvalue so the emitter / interpreter
    /// can populate the alias slot with a managed pointer at the declaration site and
    /// route subsequent reads/writes through the indirection.
    private func BindRefAliasLocalDeclaration(syntax VariableDeclarationSyntax) BoundStatement {
        let isReadOnly = syntax.ReadOnlyRefModifier != nil
        let refModifierLoc = Invariant.Required(
            syntax.RefKindModifier,
            "a ref-alias declaration has a ref modifier",
            expression: "syntax.RefKindModifier"
        )
            .Location
        let declaredType TypeSymbol? = if syntax.TypeClause is {} declaredTypeClause {
            bindTypeClause(declaredTypeClause)
        } else {
            default(TypeSymbol?)
        }
        // `const ref` is rejected: a `const` binding is a compile-time constant,
        // not a runtime storage slot, so there is no storage to alias.
        if syntax.Keyword?.Kind == SyntaxKind.ConstKeyword {
            Diagnostics.ReportRefLocalCannotBeDeclaredHere(
                refModifierLoc,
                syntax.Identifier.ValueText,
                "a 'const' binding"
            )
        }
        // An initializer is required: the local must alias an existing lvalue.
        if syntax.Initializer == nil {
            Diagnostics.ReportRefLocalRhsMustBeLvalue(refModifierLoc, "<missing>")
            let errorVar = bindLocalVariableWithAccessibility(
                syntax.Identifier,
                false,
                declaredType ?? TypeSymbol.Error,
                resolveAccessibility(syntax.AccessibilityModifier)
            )
            return BoundVariableDeclaration(syntax, errorVar, BoundErrorExpression(nil))
        }
        let initializer = bindExpression(syntax.Initializer!!, false)
        if initializer is BoundErrorExpression {
            let errorVar = bindLocalVariableWithAccessibility(
                syntax.Identifier,
                false,
                declaredType ?? TypeSymbol.Error,
                resolveAccessibility(syntax.AccessibilityModifier)
            )
            return BoundVariableDeclaration(syntax, errorVar, initializer)
        }
        // Validate addressable storage and, for writable aliases, write permission.
        // The same restrictions that govern `&expr` apply here (issue #491 / ADR-0039 §3).
        var rhsValid = true
        if !isReadOnly && RefCapabilities.IsReadOnlyStorage(initializer) {
            // Aliasing a read-only binding would let the alias mutate it; mirror
            // the existing `&readonly` rejection (GS9005 / GS0237 for `in`).
            if initializer is BoundVariableExpression{Variable: ParameterSymbol inParam} &&
                inParam.RefKind == RefKind.In {
                Diagnostics.ReportCannotAssignToInParameter(refModifierLoc, inParam.Name)
            } else {
                Diagnostics.ReportCannotTakeAddressOfConstant(refModifierLoc, syntax.Initializer!!.ToString())
            }
            rhsValid = false
        } else if !isLvalue(initializer) {
            let exprText = syntax.Initializer!!.ToString()
            Diagnostics.ReportRefLocalRhsMustBeLvalue(refModifierLoc, exprText)
            rhsValid = false
        }
        // A ref local aliases declared storage, not the narrowed value read.
        let pointeeType = if ExpressionBinder.TryGetAddressedStorageType(initializer, out var storageType) {
            storageType ?? TypeSymbol.Error
        } else {
            initializer.Type ?? TypeSymbol.Error
        }
        if declaredType != nil && rhsValid && pointeeType != TypeSymbol.Error && declaredType != pointeeType {
            Diagnostics.ReportCannotConvert(syntax.Initializer!!.Location, pointeeType, declaredType)
            rhsValid = false
        }
        let slotType = declaredType ?? pointeeType
        // Context restrictions: the CLR cannot encode a managed pointer as a static
        // field (top-level / `customize` partial). A hoisted state-machine field is
        // also forbidden, but async/iterator functions no longer get a blanket
        // rejection here — issue #4222 replaces that coarse rule with the same
        // per-local liveness treatment issue #2350 gave by-ref-like locals: an
        // alias declared in an async/iterator function is fine as long as it is
        // never live across an `await`/`yield` suspension point, which
        // RefStructAsyncLivenessAnalyzer (running after lowering) now proves,
        // reporting this same GS0258 only for a local actually caught crossing one.
        if function == nil || function!!.IsTopLevelEntryPoint {
            Diagnostics.ReportRefLocalCannotBeDeclaredHere(
                refModifierLoc,
                syntax.Identifier.ValueText,
                "a top-level variable (it would be emitted as a heap-rooted static field)"
            )
            rhsValid = false
        }
        let accessibility = resolveAccessibility(syntax.AccessibilityModifier)
        let variable VariableSymbol? = bindLocalVariableWithAccessibility(
            syntax.Identifier,
            isReadOnly,
            slotType,
            accessibility
        )
        if variable is LocalVariableSymbol localVar {
            localVar.RefKind = if isReadOnly {
                RefKind.RefReadOnly
            } else {
                RefKind.Ref
            }
            localVar.IsScoped = syntax.ScopedModifier != nil || HasFunctionLocalRefScope(initializer)
            localVar.ManagedReferenceOrigin = if rhsValid {
                initializer
            } else {
                default(BoundExpression?)
            }
        }
        // Annotations attach to the symbol unchanged (e.g. @Obsolete on a top-level
        // alias would still be observed if it ever became legal at top level).
        if variable != nil && !syntax.Annotations.IsDefaultOrEmpty {
            let positionDescription = "a local variable declaration"
            let boundAttrs = bindVariableDeclarationAttributes(syntax.Annotations, positionDescription)
            variable.SetAttributes(boundAttrs)
        }
        // Lower the initializer to BoundAddressOfExpression so the emitter
        // populates the alias slot with the managed pointer (§5 / §6 of ADR-0060).
        // Issue #3247: an index-from-end initializer (`xs[^1]`) binds as a
        // BoundBlockExpression whose prefix statements spill the receiver and
        // offset into temps. Sink the address-of onto the trailing element
        // access (mirroring the `return ref` path in BindReturnStatement) so
        // the emitter runs the prefix once and then takes the element address
        // (ldelema) instead of ICEing on the block wrapper.
        var boundInitializer BoundExpression
        if !rhsValid {
            boundInitializer = BoundErrorExpression(nil)
        } else if initializer is BoundBlockExpression block {
            boundInitializer = BoundBlockExpression(
                syntax.Initializer,
                block.Statements,
                BoundAddressOfExpression(syntax.Initializer, block.Expression, unmanaged: false, isReadOnly)
            )
        } else {
            boundInitializer = BoundAddressOfExpression(syntax.Initializer, initializer, unmanaged: false, isReadOnly)
        }
        return BoundVariableDeclaration(
            syntax,
            Invariant.Required(variable, "a ref-alias declaration produces a variable symbol", expression: "variable"),
            boundInitializer
        )
    }

    private func BindTupleDeconstructionStatement(syntax TupleDeconstructionStatementSyntax) BoundStatement {
        // Phase 4.5: `let (a, b, ...) = expr`. Issue #3423 adds the mutable
        // `var (a, b, ...) = expr` counterpart. Phase 7.3 extends the RHS from
        // tuple-only to data structs, preserving single-eval via a synthetic local.
        let isReadOnly = syntax.Keyword.Kind == SyntaxKind.LetKeyword
        var initializer BoundExpression
        if IsChannelReceiveSyntax(syntax.Initializer, out var receive) {
            // ADR-0174 D3: `let (v, ok) = <-ch` is the two-value receive — the
            // element (its zero value once closed) and whether the channel
            // delivered it — bound as a `(T, bool)` tuple so the ordinary
            // deconstruction below does the rest.
            if syntax.Identifiers.Count != 2 {
                Diagnostics.ReportChannelBindingTargetCount(
                    syntax.CloseParenToken.Location,
                    "let (value, ok) = <-ch",
                    "two names",
                    syntax.Identifiers.Count
                )
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
            let received BoundExpression? = BindTwoValueReceive(receive, out _)
            if received == nil {
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
            initializer = received
        } else {
            initializer = bindExpression(syntax.Initializer, false)
        }
        if initializer.Type == TypeSymbol.Error {
            return BoundExpressionStatement(syntax, initializer)
        }
        let materializedInitializerType = TypeSymbol.MaterializeNeverFunctionReturns(initializer.Type)
        if !object.ReferenceEquals(materializedInitializerType, initializer.Type) {
            initializer = conversions.BindConversion(
                syntax.Initializer.Location,
                initializer,
                materializedInitializerType
            )
        }
        if TypeSymbol.ContainsNeverType(initializer.Type) {
            Diagnostics.ReportExpressionMustHaveValue(syntax.Initializer.Location)
            DeclareErrorTypedLocals(syntax.Identifiers)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        // ADR-0186 §4/§5, issue #4325: deconstruction reads members out of
        // the source, so the source is a receiver and gets the same check and
        // unwrap every other receiver position gets. The unwrap is the half
        // that matters for binding: the dispatch below switches on
        // `initializer.Type is TupleTypeSymbol` / `is StructSymbol` and then
        // probes for an imported `Deconstruct`, none of which a platform
        // wrapper matches.
        initializer = binderCtx.InsertPlatformCheck(initializer, syntax.Initializer.Location, "a deconstruction source")
        if initializer.Type is TupleTypeSymbol rawTupleType {
            if syntax.Identifiers.Count != rawTupleType.Arity {
                Diagnostics.ReportDeconstructionFieldCountMismatch(
                    syntax.CloseParenToken.Location,
                    rawTupleType.Arity,
                    syntax.Identifiers.Count
                )
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
            let tupleType = cast[TupleTypeSymbol](TupleTypeSymbol.ResolveNilElements(rawTupleType))
            initializer = conversions.BindConversion(syntax.Initializer.Location, initializer, tupleType)
            let (tempVar, elements) = CreateTupleDeconstructionPlan(syntax, tupleType)
            tempVar.CallableParameterNameTree = BuildCallableParameterNameTree(initializer)
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            statements.Add(BoundVariableDeclaration(syntax, tempVar, initializer))
            for var i = 0; i < syntax.Identifiers.Count; i++ {
                let idTok = syntax.Identifiers[i]
                if IsDiscard(idTok) {
                    continue
                }
                let elemType = tupleType.ElementTypes[i]
                let elemVar = bindLocalVariable(idTok, isReadOnly, elemType)
                elemVar.CallableParameterNameTree = BuildCallableParameterNameTree(elements[i])
                statements.Add(BoundVariableDeclaration(syntax, elemVar, elements[i]))
            }
            return BoundBlockStatement(syntax, statements.ToImmutable())
        }
        if TryResolveDeconstructionAggregate(initializer.Type, out var structType) {
            let aggregate = structType!!
            let members = if aggregate.IsData {
                TypeMemberModel.GetDataDeconstructionMembers(aggregate)
            } else {
                aggregate.Fields.Cast[Symbol]().ToImmutableArray()
            }
            if syntax.Identifiers.Count != members.Length {
                if TryBindDeconstruct(
                    initializer,
                    syntax.Identifiers,
                    syntax.OpenParenToken.Location,
                    isReadOnly,
                    out var dataExtensionStatements
                ) {
                    return BoundBlockStatement(syntax, dataExtensionStatements)
                }
                Diagnostics.ReportDeconstructionFieldCountMismatch(
                    syntax.CloseParenToken.Location,
                    members.Length,
                    syntax.Identifiers.Count
                )
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
            let receiverType = initializer.Type
            let tempName = "<data${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
            let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, receiverType)
            $scope.TryDeclareVariable(tempVar)
            if RequiresSynthesizedDeconstructCall(aggregate, members) {
                return BoundBlockStatement(
                    syntax,
                    BindDataDeconstructCallStatements(
                        syntax,
                        BoundVariableExpression(nil, tempVar),
                        receiverType,
                        aggregate,
                        members,
                        syntax.Identifiers,
                        isReadOnly,
                        BoundVariableDeclaration(syntax, tempVar, initializer)
                    )
                )
            }
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            statements.Add(BoundVariableDeclaration(syntax, tempVar, initializer))
            for var i = 0; i < syntax.Identifiers.Count; i++ {
                let idTok = syntax.Identifiers[i]
                if IsDiscard(idTok) {
                    continue
                }
                let member = members[i]
                let memberType = GetDeconstructionMemberType(receiverType, aggregate, i, member, $scope.References)
                let elemVar = bindLocalVariable(idTok, isReadOnly, memberType)
                let access = BindDeconstructionMemberAccess(
                    BoundVariableExpression(nil, tempVar),
                    aggregate,
                    member,
                    memberType
                )
                statements.Add(BoundVariableDeclaration(syntax, elemVar, access))
            }
            return BoundBlockStatement(syntax, statements.ToImmutable())
        }
        if TryBindDeconstruct(
            initializer,
            syntax.Identifiers,
            syntax.OpenParenToken.Location,
            isReadOnly,
            out var deconstructStatements
        ) {
            return BoundBlockStatement(syntax, deconstructStatements)
        }
        Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(syntax.OpenParenToken.Location, initializer.Type)
        return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
    }

    private func CreateTupleDeconstructionPlan(syntax SyntaxNode, tupleType TupleTypeSymbol)(
        Temp LocalVariableSymbol,
        Elements ImmutableArray[BoundExpression]
    ) {
        let tempName = "<tuple${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let temp = LocalVariableSymbol(tempName, isReadOnly: true, tupleType)
        $scope.TryDeclareVariable(temp)
        let receiver = BoundVariableExpression(nil, temp)
        let elements = ImmutableArray.CreateBuilder[BoundExpression](tupleType.Arity)
        for var i = 0; i < tupleType.Arity; i++ {
            elements.Add(BoundTupleElementAccessExpression(syntax, receiver, tupleType, i))
        }
        return (temp, elements.MoveToImmutable())
    }

    /// Issue #1922: the `for (a, b) in coll { ... }` loop-prelude hook
    /// passed to (cref:BindForRangeStatementCore). Declares one
    /// read-only local per identifier (visible to the loop body, matching
    /// (cref:BindTupleDeconstructionStatement)'s tuple/data-struct
    /// handling) and returns the field-extraction statements to prepend —
    /// reading each element straight off [`elementVariable`](paramref)
    /// instead of a redundant synthetic temp, since the loop variable already
    /// is one.
    /// @param identifiers The parenthesized loop-target identifiers.
    /// @param closeParenLocation Location used for an arity-mismatch diagnostic.
    /// @param openParenLocation Location used for a wrong-shape-initializer diagnostic.
    /// @param elementVariable The already-declared, single, hidden loop variable.
    /// @returns The bound field-extraction statements, or empty on error (identifiers still get error-typed
    /// locals so the body doesn't cascade "undefined variable" diagnostics).
    /// @remarks ADR-0185: also reused (via a callback wired through (cref:Binder))
    /// by (cref:LambdaBinder.BindLambdaExpression) for a destructured
    /// arrow-lambda parameter `(x T1, y T2, ...) -> body` — the
    /// destructured parameter symbol itself plays the role
    /// [`elementVariable`](paramref) already plays here (a variable that
    /// already holds the tuple, needing no extra synthetic temp), which is
    /// exactly why this helper — rather than
    /// (cref:BindTupleDeconstructionStatement)'s statement-position
    /// machinery, which always spills into its OWN synthetic temp — is the
    /// reusable one for parameter-bind time.
    internal func BindForTupleLoopPrelude(
        identifiers GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[SyntaxToken],
        closeParenLocation TextLocation,
        openParenLocation TextLocation,
        elementVariable VariableSymbol
    ) ImmutableArray[BoundStatement] {
        // ADR-0186 §4/§5, issue #4325 (Copilot review on the gates PR): this
        // is the SHARED deconstruction prelude — a tuple-deconstructing
        // `for … in` element and a destructured arrow-lambda parameter both
        // arrive here (ADR-0185) — and it needs the same receiver check and
        // unwrap as the statement form in
        // `BindTupleDeconstructionStatement`. Fixing only the statement form
        // would have been failure mode 1 of the ADR's catalogue in miniature:
        // one deconstruction path taught, its sibling not, and the difference
        // invisible until someone deconstructs in a loop.
        //
        // The unwrap is the half that decides binding: every arm below
        // dispatches on `elementType is TupleTypeSymbol` / `is StructSymbol`
        // and then probes for an imported `Deconstruct`, and a platform
        // wrapper matches none of them — it reaches the imported probe
        // through its relayed `ClrType` and binds with no check at all.
        let elementAccessBase = PlatformCoercion.InsertCheck(
            BoundVariableExpression(nil, elementVariable),
            openParenLocation,
            "a deconstruction source"
        )
        let elementType = elementAccessBase.Type ?? elementVariable.Type
        if elementType is TupleTypeSymbol tupleType {
            if identifiers.Count != tupleType.Arity {
                Diagnostics.ReportDeconstructionFieldCountMismatch(
                    closeParenLocation,
                    tupleType.Arity,
                    identifiers.Count
                )
                DeclareErrorTypedLocals(identifiers)
                return ImmutableArray[BoundStatement].Empty
            }
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            for var i = 0; i < identifiers.Count; i++ {
                if IsDiscard(identifiers[i]) {
                    continue
                }
                let elemType = tupleType.ElementTypes[i]
                let elemVar = bindLocalVariable(identifiers[i], true, elemType)
                let access = BoundTupleElementAccessExpression(nil, elementAccessBase, tupleType, i)
                elemVar.CallableParameterNameTree = BuildCallableParameterNameTree(access)
                // LanguageServer fix: carry the real declaring identifier
                // token as this declaration's Syntax (instead of null) so
                // SemanticLookup.MatchBoundLocals's exact-reference match
                // finds THIS declaration instead of falling back to a
                // same-named symbol from an unrelated enclosing scope.
                statements.Add(BoundVariableDeclaration(identifiers[i], elemVar, access))
            }
            return statements.ToImmutable()
        }
        if TryResolveDeconstructionAggregate(elementType, out var structType) {
            let aggregate = structType!!
            let members = if aggregate.IsData {
                TypeMemberModel.GetDataDeconstructionMembers(aggregate)
            } else {
                aggregate.Fields.Cast[Symbol]().ToImmutableArray()
            }
            if identifiers.Count != members.Length {
                if TryBindDeconstruct(
                    elementAccessBase,
                    identifiers,
                    openParenLocation,
                    isReadOnly: true,
                    out var dataExtensionStatements
                ) {
                    return dataExtensionStatements
                }
                Diagnostics.ReportDeconstructionFieldCountMismatch(
                    closeParenLocation,
                    members.Length,
                    identifiers.Count
                )
                DeclareErrorTypedLocals(identifiers)
                return ImmutableArray[BoundStatement].Empty
            }
            if RequiresSynthesizedDeconstructCall(aggregate, members) {
                return BindDataDeconstructCallStatements(
                    nil,
                    elementAccessBase,
                    elementType,
                    aggregate,
                    members,
                    identifiers,
                    isReadOnly: true
                )
            }
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            for var i = 0; i < identifiers.Count; i++ {
                if IsDiscard(identifiers[i]) {
                    continue
                }
                let member = members[i]
                let memberType = GetDeconstructionMemberType(elementType, aggregate, i, member, $scope.References)
                let elemVar = bindLocalVariable(identifiers[i], true, memberType)
                let access = BindDeconstructionMemberAccess(elementAccessBase, aggregate, member, memberType)
                // LanguageServer fix: see the matching comment in the tuple
                // branch above.
                statements.Add(BoundVariableDeclaration(identifiers[i], elemVar, access))
            }
            return statements.ToImmutable()
        }
        if TryBindDeconstruct(
            elementAccessBase,
            identifiers,
            openParenLocation,
            isReadOnly: true,
            out var deconstructStatements
        ) {
            return deconstructStatements
        }
        if elementType != TypeSymbol.Error {
            Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(openParenLocation, elementType)
        }
        DeclareErrorTypedLocals(identifiers)
        return ImmutableArray[BoundStatement].Empty
    }

    private func TryBindDeconstruct(
        receiver BoundExpression,
        identifiers GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[SyntaxToken],
        location TextLocation,
        isReadOnly bool,
        out statements ImmutableArray[BoundStatement]
    ) bool {
        return TryBindSourceInstanceDeconstruct(receiver, identifiers, location, isReadOnly, out statements) ||
            TryBindImportedDeconstruct(
            receiver,
            identifiers,
            location,
            isReadOnly,
            out statements,
            includeInstance: true,
            includeExtensions: false
        ) ||
            TryBindSourceExtensionDeconstruct(receiver, identifiers, location, isReadOnly, out statements) ||
            TryBindImportedDeconstruct(
            receiver,
            identifiers,
            location,
            isReadOnly,
            out statements,
            includeInstance: false,
            includeExtensions: true
        )
    }

    private func TryBindSourceInstanceDeconstruct(
        receiver BoundExpression,
        identifiers GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[SyntaxToken],
        location TextLocation,
        isReadOnly bool,
        out statements ImmutableArray[BoundStatement]
    ) bool {
        statements = default(ImmutableArray[BoundStatement])
        let receiverType = receiver.Type
        if receiverType == nil ||
            receiverType == TypeSymbol.Error ||
            receiverType.ReferenceNullability == ReferenceNullabilityKind.Nullable ||
            NullableLifting.IsAnyValueTypeNullable(receiverType.StripToBareShape() as NullableTypeSymbol) {
            return false
        }
        let bareReceiverType = if receiverType is NullabilityAnnotatedTypeSymbol annotated {
            annotated.BaseType
        } else {
            receiverType
        }
        let instanceMatches = List[(Method FunctionSymbol, DeclaringInterface InterfaceSymbol?)]()
        let rootIface = (bareReceiverType as InterfaceSymbol) ??
            (bareReceiverType as TypeParameterSymbol)?.InterfaceConstraint
        if rootIface != nil {
            for iface in rootIface.SelfAndAllBaseInterfaces() {
                iface.EnsureMembersResolved()
                for candidate in iface.Methods {
                    if candidate.Name == "Deconstruct" &&
                        IsMatchingSourceInstanceDeconstruct(candidate, identifiers.Count, bareReceiverType, iface) {
                        AddUniqueInterfaceDeconstructMatch(instanceMatches, candidate, iface)
                    }
                }
            }
            if bareReceiverType is InterfaceSymbol && AccessibilityChecker.IsAccessible(
                Accessibility.Private,
                rootIface.Definition ?? rootIface,
                getCurrentFunction()
            ) {
                for candidate in rootIface.GetPrivateMethods("Deconstruct") {
                    if IsMatchingSourceInstanceDeconstruct(candidate, identifiers.Count, bareReceiverType, rootIface) {
                        AddUniqueInterfaceDeconstructMatch(instanceMatches, candidate, rootIface)
                    }
                }
            }
        } else {
            let instanceOverloads = MemberLookup.CollectSourceInstanceMethods(bareReceiverType, "Deconstruct")
            for candidate in instanceOverloads {
                if IsMatchingSourceInstanceDeconstruct(
                    candidate,
                    identifiers.Count,
                    bareReceiverType,
                    candidate.ReceiverType
                ) {
                    instanceMatches.Add((candidate, default(InterfaceSymbol?)))
                }
            }
            if instanceMatches.Count == 0 {
                let structRecv = (bareReceiverType as StructSymbol) ??
                    (bareReceiverType as TypeParameterSymbol)?.ClassConstraint as StructSymbol
                if structRecv != nil {
                    let seenInterfaces = HashSet[InterfaceSymbol]()
                    for current in structRecv.GetHierarchy() {
                        for iface in current.Interfaces {
                            if iface == nil {
                                continue
                            }
                            for baseIface in iface.SelfAndAllBaseInterfaces() {
                                if !seenInterfaces.Add(baseIface) {
                                    continue
                                }
                                baseIface.EnsureMembersResolved()
                                for candidate in baseIface.Methods {
                                    if candidate.Name == "Deconstruct" && InterfaceSymbol.HasDefaultBody(candidate) &&
                                        IsMatchingSourceInstanceDeconstruct(
                                        candidate,
                                        identifiers.Count,
                                        bareReceiverType,
                                        baseIface
                                    ) {
                                        AddUniqueInterfaceDeconstructMatch(instanceMatches, candidate, baseIface)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if instanceMatches.Count == 0 {
            return false
        }
        if instanceMatches.Count > 1 && instanceMatches[0].Method.ReceiverType is StructSymbol firstOwner {
            let mostDerived = List[(Method FunctionSymbol, DeclaringInterface InterfaceSymbol?)]()
            for match in instanceMatches {
                if object.ReferenceEquals(match.Method.ReceiverType, firstOwner) {
                    mostDerived.Add(match)
                }
            }
            if mostDerived.Count > 0 {
                instanceMatches.Clear()
                instanceMatches.AddRange(mostDerived)
            }
        }
        if instanceMatches.Count > 1 {
            let signatures = [instanceMatches.Count]string
            for var i = 0; i < signatures.Length; i++ {
                signatures[i] = Binder.FormatOverloadSignature(instanceMatches[i].Method)
            }
            Diagnostics.ReportAmbiguousOverload(location, "Deconstruct", instanceMatches.Count, signatures)
            DeclareErrorTypedLocals(identifiers)
            statements = ImmutableArray[BoundStatement].Empty
            return true
        }
        let selected = instanceMatches[0]
        let method = selected.Method
        let substitution = OverloadResolver.TryBuildReceiverSubstitution(bareReceiverType)
        let parameterOffset = if method.ExplicitReceiverParameter == nil {
            0
        } else {
            1
        }
        let arguments = ImmutableArray.CreateBuilder[BoundExpression](identifiers.Count)
        let declarations = ImmutableArray.CreateBuilder[BoundStatement](identifiers.Count)
        let receiverScoped = HasFunctionLocalEscapeScope(receiver) ||
            (
            (method.HasUnscopedRef || method.ThisParameter?.IsUnscopedRefReceiver == true) &&
                HasLocalOrSpilledReceiverStorageScope(receiver, bareReceiverType)
        )
        for var i = 0; i < identifiers.Count; i++ {
            let parameter = method.Parameters[i + parameterOffset]
            var elementType = parameter.Type
            if substitution != nil {
                elementType = Binder.SubstituteType(
                    elementType,
                    substitution,
                    $scope.References!!.MapClrTypeToReferences
                )
            }
            if elementType is ByRefTypeSymbol byRef {
                elementType = byRef.PointeeType
            }
            let outputScoped = TypeSymbol.IsByRefLike(elementType) && (receiverScoped || parameter.IsScoped)
            let temp = LocalVariableSymbol(
                "<deconstruct${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                isReadOnly: false,
                elementType
            )
            temp.IsScoped = outputScoped
            $scope.TryDeclareVariable(temp)
            arguments.Add(BoundAddressOfExpression(nil, BoundVariableExpression(nil, temp)))
            let isDiscard = IsDiscard(identifiers[i])
            ReportByRefLikeDeconstructOutputEscapeIfNeeded(identifiers[i], elementType, isDiscard)
            if !isDiscard {
                let variable = bindLocalVariable(identifiers[i], isReadOnly, elementType)
                if outputScoped && variable is LocalVariableSymbol localVariable {
                    localVariable.IsScoped = true
                }
                declarations.Add(BoundVariableDeclaration(identifiers[i], variable, BoundVariableExpression(nil, temp)))
            }
        }
        var declaringInterface = selected.DeclaringInterface
        if declaringInterface != nil && substitution != nil {
            declaringInterface = Binder.SubstituteType(
                declaringInterface,
                substitution,
                $scope.References!!.MapClrTypeToReferences
            ) as InterfaceSymbol ??
                declaringInterface
        }
        var callReceiver = receiver
        if declaringInterface != nil && bareReceiverType is StructSymbol && callReceiver.Type != declaringInterface {
            callReceiver = conversions.BindConversion(location, callReceiver, declaringInterface)
        }
        let constrainedTp = bareReceiverType as TypeParameterSymbol
        let call = BoundUserInstanceCallExpression(
            nil,
            callReceiver,
            method,
            arguments.MoveToImmutable(),
            nil,
            constrainedTp,
            declaringInterface ?? constrainedTp?.InterfaceConstraint
        )
        let result = ImmutableArray.CreateBuilder[BoundStatement](declarations.Count + 1)
        result.Add(BoundExpressionStatement(nil, call))
        result.AddRange(declarations)
        statements = result.ToImmutable()
        return true
    }

    private func HasLocalOrSpilledReceiverStorageScope(
        receiver BoundExpression,
        bareReceiverType TypeSymbol,
        isReadOnlyMember bool = false
    ) bool {
        if Binder.IsReferenceTypeForConstraint(receiver.Type) {
            return false
        }
        if HasFunctionLocalRefScope(receiver) || RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(
            receiver,
            isReadOnlyMember && bareReceiverType is not TypeParameterSymbol
        ) {
            return true
        }
        if !RefCapabilities.IsDirectlyAddressableForImplicitIn(receiver) {
            let unboxedInPlace = (
                bareReceiverType is StructSymbol{IsClass: false} || bareReceiverType.ClrType?.IsValueType == true
            ) &&
                receiver is BoundVariableExpression{NarrowedType: not nil} bve &&
                Binder.IsReferenceTypeForConstraint(bve.Variable.Type)
            if !unboxedInPlace {
                return true
            }
        }
        return false
    }

    private func ReportByRefLikeDeconstructOutputEscapeIfNeeded(
        identifier SyntaxToken,
        elementType TypeSymbol,
        isDiscard bool
    ) {
        if !TypeSymbol.IsByRefLike(elementType) {
            return
        }
        if !isDiscard && (function == nil || function!!.IsTopLevelEntryPoint) {
            Diagnostics.ReportByRefLikeEscape(
                identifier.Location,
                elementType,
                "be declared as a top-level variable (it would be emitted as a heap-rooted static field)"
            )
        } else if function != nil && !function!!.IsAsync && isIteratorReturnType(function!!.Type) {
            Diagnostics.ReportByRefLikeEscape(
                identifier.Location,
                elementType,
                "be declared as a local in an iterator (it would be hoisted into the state machine)"
            )
        }
    }

    private func AddUniqueInterfaceDeconstructMatch(
        matches List[(Method FunctionSymbol, DeclaringInterface InterfaceSymbol?)],
        candidate FunctionSymbol,
        declaringInterface InterfaceSymbol
    ) {
        for existing in matches {
            if object.ReferenceEquals(existing.Method, candidate) || BoundScope.FunctionSignaturesEqual(
                existing.Method,
                candidate
            ) {
                return
            }
        }
        matches.Add((candidate, declaringInterface))
    }

    private func TryBindSourceExtensionDeconstruct(
        receiver BoundExpression,
        identifiers GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[SyntaxToken],
        location TextLocation,
        isReadOnly bool,
        out statements ImmutableArray[BoundStatement]
    ) bool {
        statements = default(ImmutableArray[BoundStatement])
        let receiverType = receiver.Type
        if receiverType == nil || receiverType == TypeSymbol.Error {
            return false
        }
        let extensionOverloads = $scope.TryLookupExtensionFunctions(receiverType, "Deconstruct")
        if extensionOverloads.IsDefaultOrEmpty {
            return false
        }
        let extensionMatches = List[
            (
                Method FunctionSymbol,
                Substitution Dictionary[TypeParameterSymbol, TypeSymbol]?,
                ReceiverParamType TypeSymbol
            )
        ]()
        for candidate in extensionOverloads {
            if TryMatchSourceExtensionDeconstruct(
                candidate,
                identifiers.Count,
                receiverType,
                out var substitution,
                out var receiverParamType
            ) {
                extensionMatches.Add((candidate, substitution, receiverParamType!!))
            }
        }
        if extensionMatches.Count == 0 {
            return false
        }
        var survivors = extensionMatches
        if survivors.Count > 1 {
            let dominatedFiltered = List[
                (
                    Method FunctionSymbol,
                    Substitution Dictionary[TypeParameterSymbol, TypeSymbol]?,
                    ReceiverParamType TypeSymbol
                )
            ](survivors.Count)
            for current in survivors {
                var dominated = false
                for other in survivors {
                    if object.ReferenceEquals(current.Method, other.Method) {
                        continue
                    }
                    if OverloadResolver.CompareExtensionReceiverConversions(
                        conversions,
                        receiverType,
                        other.ReceiverParamType,
                        current.ReceiverParamType
                    ) < 0 {
                        dominated = true
                        break
                    }
                }
                if !dominated {
                    dominatedFiltered.Add(current)
                }
            }
            if dominatedFiltered.Count > 0 {
                survivors = dominatedFiltered
            }
        }
        if survivors.Count > 1 {
            let nonGeneric = List[
                (
                    Method FunctionSymbol,
                    Substitution Dictionary[TypeParameterSymbol, TypeSymbol]?,
                    ReceiverParamType TypeSymbol
                )
            ]()
            for current in survivors {
                if !current.Method.IsGeneric {
                    nonGeneric.Add(current)
                }
            }
            if nonGeneric.Count > 0 && nonGeneric.Count < survivors.Count {
                survivors = nonGeneric
            }
        }
        if survivors.Count > 1 {
            let signatures = [survivors.Count]string
            for var i = 0; i < signatures.Length; i++ {
                signatures[i] = Binder.FormatOverloadSignature(survivors[i].Method)
            }
            Diagnostics.ReportAmbiguousOverload(location, "Deconstruct", survivors.Count, signatures)
            DeclareErrorTypedLocals(identifiers)
            statements = ImmutableArray[BoundStatement].Empty
            return true
        }
        let selected = survivors[0]
        let arguments = ImmutableArray.CreateBuilder[BoundExpression](identifiers.Count + 1)
        let declarations = ImmutableArray.CreateBuilder[BoundStatement](identifiers.Count)
        let convertedReceiver = conversions.BindConversion(location, receiver, selected.ReceiverParamType)
        arguments.Add(convertedReceiver)
        let receiverScoped = !selected
            .Method
            .Parameters[0]
            .IsScoped &&
            (HasFunctionLocalEscapeScope(receiver) || HasFunctionLocalEscapeScope(convertedReceiver))
        for var i = 0; i < identifiers.Count; i++ {
            let parameter = selected.Method.Parameters[i + 1]
            var elementType = parameter.Type
            if selected.Substitution != nil {
                elementType = Binder.SubstituteType(
                    elementType,
                    selected.Substitution!!,
                    $scope.References!!.MapClrTypeToReferences
                )
            }
            if elementType is ByRefTypeSymbol byRef {
                elementType = byRef.PointeeType
            }
            let outputScoped = TypeSymbol.IsByRefLike(elementType) && (receiverScoped || parameter.IsScoped)
            let temp = LocalVariableSymbol(
                "<deconstruct${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                isReadOnly: false,
                elementType
            )
            temp.IsScoped = outputScoped
            $scope.TryDeclareVariable(temp)
            arguments.Add(BoundAddressOfExpression(nil, BoundVariableExpression(nil, temp)))
            let isDiscard = IsDiscard(identifiers[i])
            ReportByRefLikeDeconstructOutputEscapeIfNeeded(identifiers[i], elementType, isDiscard)
            if !isDiscard {
                let variable = bindLocalVariable(identifiers[i], isReadOnly, elementType)
                if outputScoped && variable is LocalVariableSymbol localVariable {
                    localVariable.IsScoped = true
                }
                declarations.Add(BoundVariableDeclaration(identifiers[i], variable, BoundVariableExpression(nil, temp)))
            }
        }
        var methodTypeArguments = default(ImmutableArray[TypeSymbol])
        if selected.Method.IsGeneric && selected.Substitution != nil {
            let typeArgsBuilder = ImmutableArray.CreateBuilder[TypeSymbol](selected.Method.TypeParameters.Length)
            for tp in selected.Method.TypeParameters {
                typeArgsBuilder.Add(selected.Substitution!![tp])
            }
            methodTypeArguments = typeArgsBuilder.MoveToImmutable()
        }
        let call = BoundCallExpression(nil, selected.Method, arguments.MoveToImmutable(), TypeSymbol.Void){
            MethodTypeArguments = methodTypeArguments
        }
        let result = ImmutableArray.CreateBuilder[BoundStatement](declarations.Count + 1)
        result.Add(BoundExpressionStatement(nil, call))
        result.AddRange(declarations)
        statements = result.ToImmutable()
        return true
    }

    private func IsMatchingSourceInstanceDeconstruct(
        candidate FunctionSymbol,
        outCount int32,
        receiverType TypeSymbol,
        declaringType TypeSymbol?
    ) bool {
        let effectiveDeclaringType = declaringType ?? candidate.ReceiverType
        if candidate.Type != TypeSymbol.Void ||
            candidate.IsAsync ||
            candidate.IsSuspending ||
            !candidate
            .TypeParameters
            .IsDefaultOrEmpty {
            return false
        }
        if !AccessibilityChecker.IsAccessible(candidate.Accessibility, effectiveDeclaringType, getCurrentFunction()) {
            return false
        }
        if effectiveDeclaringType != nil && AccessibilityChecker.ViolatesProtectedReceiverRule(
            candidate.Accessibility,
            effectiveDeclaringType,
            receiverType,
            getCurrentFunction()
        ) {
            return false
        }
        let parameterOffset = if candidate.ExplicitReceiverParameter == nil {
            0
        } else {
            1
        }
        if candidate.Parameters.Length != outCount + parameterOffset {
            return false
        }
        for var i = parameterOffset; i < candidate.Parameters.Length; i++ {
            if candidate.Parameters[i].RefKind != RefKind.Out || candidate.Parameters[i].IsVariadic {
                return false
            }
        }
        return true
    }

    private func TryMatchSourceExtensionDeconstruct(
        candidate FunctionSymbol,
        outCount int32,
        receiverType TypeSymbol,
        out substitution Dictionary[TypeParameterSymbol, TypeSymbol]?,
        @NotNullWhen(true) out receiverParamType TypeSymbol?
    ) bool {
        substitution = nil
        receiverParamType = nil
        if candidate.Type != TypeSymbol.Void || candidate.IsAsync || candidate.IsSuspending {
            return false
        }
        if !AccessibilityChecker.IsAccessible(
            candidate.Accessibility,
            candidate.StaticOwnerType,
            getCurrentFunction()
        ) {
            return false
        }
        if candidate.Parameters.Length != outCount + 1 {
            return false
        }
        for var i = 1; i < candidate.Parameters.Length; i++ {
            if candidate.Parameters[i].RefKind != RefKind.Out || candidate.Parameters[i].IsVariadic {
                return false
            }
        }
        if candidate.IsGeneric {
            let inferred = Dictionary[TypeParameterSymbol, TypeSymbol]()
            Binder.InferTypeArguments(
                candidate.Parameters[0].Type,
                RefCapabilities.GetInferenceType(candidate.Parameters[0], receiverType),
                inferred
            )
            for tp in candidate.TypeParameters {
                if !inferred.TryGetValue(tp, out var arg) {
                    continue
                }
                let strippedArg = PlatformTypeSymbol.StripTopLevel(arg)
                if tp.InterfaceConstraint is {} ifaceConstraint && TypeSymbol.ContainsTypeParameter(ifaceConstraint) {
                    if strippedArg is StructSymbol structArg {
                        for current in structArg.GetHierarchy() {
                            for implemented in current.Interfaces {
                                if implemented != nil {
                                    for baseIface in implemented.SelfAndAllBaseInterfaces() {
                                        Binder.InferTypeArguments(ifaceConstraint, baseIface, inferred)
                                    }
                                }
                            }
                        }
                    } else if strippedArg is InterfaceSymbol ifaceArg {
                        for baseIface in ifaceArg.SelfAndAllBaseInterfaces() {
                            Binder.InferTypeArguments(ifaceConstraint, baseIface, inferred)
                        }
                    }
                }
                if tp.ClassConstraint is StructSymbol classConstraint && TypeSymbol.ContainsTypeParameter(
                    classConstraint
                ) &&
                    strippedArg is StructSymbol classArg {
                    for current in classArg.GetHierarchy() {
                        Binder.InferTypeArguments(classConstraint, current, inferred)
                    }
                }
            }
            for tp in candidate.TypeParameters {
                if !inferred.TryGetValue(tp, out var typeArg) || TypeSymbol.IsByRefLike(typeArg) ||
                    !Binder.SatisfiesConstraint(typeArg, tp, inferred) {
                    return false
                }
            }
            substitution = inferred
        }
        let expectedReceiver = if substitution is {} receiverSubstitution {
            Binder.SubstituteType(
                candidate.Parameters[0].Type,
                receiverSubstitution,
                $scope.References!!.MapClrTypeToReferences
            )
        } else {
            candidate.Parameters[0].Type
        }
        if expectedReceiver != receiverType {
            let conversion = Conversion.Classify(receiverType, expectedReceiver)
            if !conversion.Exists || !conversion.IsImplicit {
                return false
            }
        }
        receiverParamType = expectedReceiver
        return true
    }

    private func TryBindImportedDeconstruct(
        receiver BoundExpression,
        identifiers GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[SyntaxToken],
        location TextLocation,
        isReadOnly bool,
        out statements ImmutableArray[BoundStatement],
        includeInstance bool = true,
        includeExtensions bool = true
    ) bool {
        statements = default(ImmutableArray[BoundStatement])
        var receiverClrType Type? = receiver.Type?.ClrType
        if receiverClrType == nil && !MemberLookup.TryProjectErasedClrType(
            Invariant.Required(receiver.Type, "a deconstruction receiver has a type", expression: "receiver.Type"),
            out receiverClrType
        ) {
            return false
        }
        receiverClrType = Invariant.Required(
            receiverClrType,
            "a deconstruction receiver has a CLR type",
            expression: "receiverClrType"
        )
        if receiver.Type is ImportedTypeSymbol symbolicReceiver &&
            symbolicReceiver.OpenDefinition != nil &&
            !symbolicReceiver
            .TypeArguments
            .IsDefaultOrEmpty {
            receiverClrType = symbolicReceiver.ReifyClosedClrType() ?? receiverClrType
        }
        let probes = MemberLookup(binderCtx).CollectImportedMethodProbes(
            staticClassType: nil,
            if includeInstance {
                receiverClrType
            } else {
                default(Type?)
            },
            "Deconstruct",
            includeExtensions: includeExtensions
        )
        for probe in probes {
            let receiverOffset = probe.ReceiverParameterOffset
            var candidates = List[MethodInfo]()
            for candidate in probe.Methods {
                let candidateParameters = candidate.GetParameters()
                var parametersMatch = candidate
                    .ReturnType
                    .FullName == typeof(Void).FullName &&
                    candidateParameters.Length == identifiers.Count +
                    receiverOffset
                for var i = receiverOffset; parametersMatch && i < candidateParameters.Length; i++ {
                    parametersMatch &= candidateParameters[i].IsOut && candidateParameters[i].ParameterType.IsByRef
                }
                if parametersMatch {
                    candidates.Add(candidate)
                }
            }
            if candidates.Count == 0 {
                continue
            }
            let inferenceTypes = [identifiers.Count + receiverOffset]Type
            if receiverOffset == 1 {
                inferenceTypes[0] = receiverClrType!!
            }
            let closedCandidates = List[MethodInfo]()
            for candidate in candidates {
                if !candidate.IsGenericMethodDefinition {
                    closedCandidates.Add(candidate)
                    continue
                }
                if !ClrOverloadResolution.TryInferTypeArguments(candidate, inferenceTypes, out var typeArguments) {
                    continue
                }
                try {
                    for var i = 0; i < typeArguments!!.Length; i++ {
                        typeArguments!![i] = $scope.References!!.MapClrTypeToReferences(typeArguments!![i]) ??
                            typeArguments!![i]
                    }
                    closedCandidates.Add(candidate.MakeGenericMethod(typeArguments!!))
                } catch (ArgumentException) { }
            }
            candidates = closedCandidates
            if candidates.Count == 0 {
                continue
            }
            let argumentTypes = [identifiers.Count + receiverOffset]Type
            if receiverOffset == 1 {
                argumentTypes[0] = receiverClrType!!
            }
            Array.Fill(
                argumentTypes,
                ClrOverloadResolution.InlineOutVarArgumentType,
                startIndex: receiverOffset,
                count: identifiers.Count
            )
            let resolution = ClrOverloadResolution.Resolve[MethodInfo](
                candidates,
                argumentTypes,
                projectTypeArgument: $scope.References!!.MapClrTypeToReferences
            )
            if resolution.Outcome == ClrOverloadResolution.ResolutionOutcome.Ambiguous {
                let signatures = [resolution.Ambiguous.Length]string
                for var i = 0; i < signatures.Length; i++ {
                    signatures[i] = ClrOverloadResolution.FormatMethodSignature(resolution.Ambiguous[i])
                }
                Diagnostics.ReportAmbiguousOverload(location, "Deconstruct", resolution.Ambiguous.Length, signatures)
                DeclareErrorTypedLocals(identifiers)
                statements = ImmutableArray[BoundStatement].Empty
                return true
            }
            if resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved {
                continue
            }
            let method = Invariant.Required(
                resolution.Best,
                "a resolved overload has a best method",
                expression: "resolution.Best"
            )
            let parameters = method.GetParameters()
            let arguments = ImmutableArray.CreateBuilder[BoundExpression](parameters.Length)
            let refKinds = ImmutableArray.CreateBuilder[RefKind](parameters.Length)
            let declarations = ImmutableArray.CreateBuilder[BoundStatement](identifiers.Count)
            if receiverOffset == 1 {
                arguments.Add(
                    conversions.BindConversion(
                        location,
                        receiver,
                        ClrNullability.GetParameterTypeSymbol(parameters[0]).StripToBareShape()
                    )
                )
                refKinds.Add(RefKind.None)
            }
            let bareReceiverType = receiver.Type.StripToBareShape()
            let receiverScoped = if receiverOffset == 0 {
                HasFunctionLocalEscapeScope(receiver) ||
                    (
                    RefCapabilities.HasUnscopedRef(method) &&
                        HasLocalOrSpilledReceiverStorageScope(
                        receiver,
                        bareReceiverType,
                        RefCapabilities.IsReadOnlyMethod(method)
                    )
                )
            } else {
                !RefCapabilities.IsScoped(parameters[0]) &&
                    (HasFunctionLocalEscapeScope(receiver) || HasFunctionLocalEscapeScope(arguments[0]))
            }
            for var i = 0; i < identifiers.Count; i++ {
                // Issue #3705 (family 2): the extension-`Deconstruct` arm used a
                // bare `FromClrType`, so a synthesised deconstruction local took
                // its type from an `out T` parameter with the declaration's
                // `[Nullable]` metadata dropped — while the instance arm reads it
                // through MemberLookup. `GetParameterTypeSymbol` peels `ByRef`
                // itself, so the element type falls out of both arms directly.
                let parameterType = if receiverOffset == 0 {
                    MemberLookup.GetClrMethodParameterTypeSymbol(
                        Invariant.Required(
                            receiver.Type,
                            "a deconstruction receiver has a type",
                            expression: "receiver.Type"
                        ),
                        method,
                        i
                    )
                } else {
                    ClrNullability.GetParameterTypeSymbol(parameters[i + receiverOffset])
                }
                let elementType = if parameterType is ByRefTypeSymbol byRef {
                    byRef.PointeeType
                } else {
                    parameterType
                }
                let outputScoped = TypeSymbol.IsByRefLike(elementType) &&
                    (receiverScoped || RefCapabilities.IsScoped(parameters[i + receiverOffset]))
                let temp = LocalVariableSymbol(
                    "<deconstruct${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                    isReadOnly: false,
                    elementType
                )
                temp.IsScoped = outputScoped
                $scope.TryDeclareVariable(temp)
                arguments.Add(BoundAddressOfExpression(nil, BoundVariableExpression(nil, temp)))
                refKinds.Add(RefKind.Out)
                let isDiscard = IsDiscard(identifiers[i])
                ReportByRefLikeDeconstructOutputEscapeIfNeeded(identifiers[i], elementType, isDiscard)
                if !isDiscard {
                    let variable = bindLocalVariable(identifiers[i], isReadOnly, elementType)
                    if outputScoped && variable is LocalVariableSymbol localVariable {
                        localVariable.IsScoped = true
                    }
                    declarations.Add(BoundVariableDeclaration(nil, variable, BoundVariableExpression(nil, temp)))
                }
            }
            let call BoundExpression = if receiverOffset == 1 {
                cast[BoundExpression](
                    BoundClrStaticCallExpression(
                        nil,
                        method,
                        TypeSymbol.Void,
                        arguments.MoveToImmutable(),
                        refKinds.MoveToImmutable()
                    )
                )
            } else {
                cast[BoundExpression](
                    BoundImportedInstanceCallExpression(
                        nil,
                        receiver,
                        MemberLookup.GetImportedMethodForEmission(method),
                        TypeSymbol.Void,
                        arguments.MoveToImmutable(),
                        refKinds.MoveToImmutable()
                    )
                )
            }
            let result = ImmutableArray.CreateBuilder[BoundStatement](identifiers.Count + 1)
            result.Add(BoundExpressionStatement(nil, call))
            result.AddRange(declarations)
            statements = result.ToImmutable()
            return true
        }
        return false
    }

    /// Declares each identifier as an error-typed local so a deconstruction failure doesn't cascade
    /// "variable doesn't exist" diagnostics through the loop body.
    private func DeclareErrorTypedLocals(identifiers GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[SyntaxToken]) {
        for var i = 0; i < identifiers.Count; i++ {
            if !IsDiscard(identifiers[i]) {
                bindLocalVariable(identifiers[i], true, TypeSymbol.Error)
            }
        }
    }

    private func BindNamedDeconstructionStatement(syntax NamedDeconstructionStatementSyntax) BoundStatement {
        var initializer = bindExpression(syntax.Initializer, false)
        if initializer.Type == TypeSymbol.Error {
            return BoundExpressionStatement(syntax, initializer)
        }
        if TypeSymbol.ContainsNeverType(TypeSymbol.MaterializeNeverFunctionReturns(initializer.Type)) {
            Diagnostics.ReportExpressionMustHaveValue(syntax.Initializer.Location)
            for fieldSyntax in syntax.Fields {
                if !IsDiscard(fieldSyntax.LocalIdentifier) {
                    bindLocalVariable(fieldSyntax.LocalIdentifier, true, TypeSymbol.Error)
                }
            }
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        // ADR-0186 §4/§5: named deconstruction reads each field off the
        // initializer, so a platform `DPt!` is used as non-null here, exactly
        // like the positional form's source (see the check in
        // BindTupleDeconstructionStatement). The same call unwraps the value, which
        // the symbol-kind test below needs: a platform wrapper is not a
        // StructSymbol, so `let { X = x } = obliviousCall()` reported GS0164
        // where `DPt` compiled.
        initializer = binderCtx.InsertPlatformCheck(initializer, syntax.Initializer.Location, "a deconstruction source")
        if !TryResolveDeconstructionAggregate(initializer.Type, out var structType) {
            Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(syntax.OpenBraceToken.Location, initializer.Type)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        let aggregate = structType!!
        let receiverType = initializer.Type
        let tempName = "<data${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, receiverType)
        $scope.TryDeclareVariable(tempVar)
        let seen = HashSet[string]()
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundVariableDeclaration(syntax, tempVar, initializer))
        for fieldSyntax in syntax.Fields {
            let fieldName = fieldSyntax.FieldIdentifier.ValueText
            if !seen.Add(fieldName) {
                Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.FieldIdentifier.Location, fieldName)
                continue
            }
            if !TypeMemberModel.TryGetFieldIncludingInherited(
                aggregate,
                fieldName,
                MemberQuery.Instance(MemberKinds.Field),
                out var field,
                out var declaringType
            ) {
                Diagnostics.ReportUnableToFindMember(fieldSyntax.FieldIdentifier.Location, fieldName)
                continue
            }
            if IsDiscard(fieldSyntax.LocalIdentifier) {
                continue
            }
            let fieldType = GetDeconstructionMemberType(receiverType, field, $scope.References)
            let variable = bindLocalVariable(fieldSyntax.LocalIdentifier, true, fieldType)
            let access = BindDeconstructionMemberAccess(
                BoundVariableExpression(nil, tempVar),
                declaringType,
                field,
                fieldType
            )
            statements.Add(BoundVariableDeclaration(syntax, variable, access))
        }
        return BoundBlockStatement(syntax, statements.ToImmutable())
    }

    private func TryResolveDeconstructionAggregate(type TypeSymbol, out structType StructSymbol?) bool {
        structType = nil
        if type.ReferenceNullability == ReferenceNullabilityKind.Nullable || NullableLifting.IsAnyValueTypeNullable(
            type.StripToBareShape() as NullableTypeSymbol
        ) {
            return false
        }
        structType = switch type {
            case direct is StructSymbol: direct
            case NullabilityAnnotatedTypeSymbol{BaseType: StructSymbol annotated}: annotated
            default: default(StructSymbol?)
        }
        if structType == nil && type.ClrType is {} clrType && ImportedTypeSymbol.TryCreateSemanticAggregate(
            clrType,
            $scope.References,
            out var importedAggregate
        ) {
            structType = importedAggregate
        }
        return structType != nil && (structType.IsData || structType.IsInline)
    }

    private func RequiresSynthesizedDeconstructCall(aggregate StructSymbol, members ImmutableArray[Symbol]) bool {
        if !aggregate.IsData {
            return false
        }
        for member in members {
            if member is PropertySymbol prop && !aggregate.Properties.Contains(prop) &&
                prop.GetterAccessibility != Accessibility.Public {
                return true
            }
        }
        return false
    }

    private func BindDataDeconstructCallStatements(
        syntax SyntaxNode?,
        receiver BoundExpression,
        receiverType TypeSymbol,
        aggregate StructSymbol,
        members ImmutableArray[Symbol],
        identifiers GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[SyntaxToken],
        isReadOnly bool,
        prefixStatement BoundStatement? = nil
    ) ImmutableArray[BoundStatement] {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        if prefixStatement != nil {
            statements.Add(prefixStatement)
        }
        if aggregate.ClrType != nil &&
            TryBindImportedDeconstruct(
            receiver,
            identifiers,
            syntax?.Location ?? default(TextLocation),
            isReadOnly,
            out var importedStatements
        ) {
            statements.AddRange(importedStatements)
            return statements.ToImmutable()
        }
        let arguments = ImmutableArray.CreateBuilder[BoundExpression](members.Length)
        let declarations = ImmutableArray.CreateBuilder[BoundStatement](members.Length)
        for var i = 0; i < identifiers.Count; i++ {
            let memberType = GetDeconstructionMemberType(receiverType, aggregate, i, members[i], $scope.References)
            let temp = LocalVariableSymbol(
                "<deconstruct${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                isReadOnly: false,
                memberType
            )
            $scope.TryDeclareVariable(temp)
            arguments.Add(BoundAddressOfExpression(nil, BoundVariableExpression(nil, temp)))
            if !IsDiscard(identifiers[i]) {
                let elemVar = bindLocalVariable(identifiers[i], isReadOnly, memberType)
                declarations.Add(
                    BoundVariableDeclaration(syntax ?? identifiers[i], elemVar, BoundVariableExpression(nil, temp))
                )
            }
        }
        let call = BoundUserInstanceCallExpression(
            nil,
            receiver,
            aggregate.DataDeconstruct,
            arguments.MoveToImmutable()
        )
        statements.Add(BoundExpressionStatement(nil, call))
        statements.AddRange(declarations)
        return statements.ToImmutable()
    }

    private class ReturnCallableParameterNameCollector : BoundTreeWalker {
        var Found bool
        var Conflict bool
        var Result CallableParameterNameNode?

        protected override func VisitReturnStatement(node BoundReturnStatement) {
            if Conflict {
                return
            }
            if node.Expression is {} returnExpression {
                if !IsVacuousCallableBranch(returnExpression) {
                    let tree = BuildCallableParameterNameTree(returnExpression)
                    if !Found {
                        Found = true
                        Result = tree
                        if Result == nil {
                            Conflict = true
                            return
                        }
                    } else {
                        Result = CallableParameterNameNode.Merge(Result, tree)
                        if Result == nil {
                            Conflict = true
                            return
                        }
                    }
                }
                VisitExpression(returnExpression)
            }
        }
    }

    shared {
        internal func IsScopeOwner(node SyntaxNode) bool -> node is FunctionLiteralExpressionSyntax or
            LambdaExpressionSyntax or
            AnonymousClassExpressionSyntax or
            FunctionDeclarationSyntax or
            ConstructorDeclarationSyntax or
            PropertyAccessorSyntax or
            EventAccessorSyntax or
            DeinitDeclarationSyntax

        private func JoinExternalCallableAliases(
            joined HashSet[VariableSymbol]?,
            next IReadOnlyCollection[VariableSymbol]
        ) HashSet[VariableSymbol] {
            if joined == nil {
                return HashSet[VariableSymbol](next)
            }
            joined.IntersectWith(next)
            return joined
        }

        /// ADR-0069 addendum / issue #1180 / issue #1639: combined single-pass walk
        /// that collects both facts previously gathered by two separate full
        /// subtree walks: (a) the set of plain-variable names reassigned anywhere
        /// in [`node`](paramref), added to [`assigned`](paramref), and
        /// (b) whether the subtree contains a construct that could change a value
        /// reached through a stable member path — a call (whose callee could
        /// mutate a field), or a member / index / indirect assignment — returned
        /// as the method result. Such statements conservatively invalidate all
        /// member-path smart casts.
        private func CollectAssignedNamesAndMemberMutation(node SyntaxNode, assigned HashSet[string]) bool {
            var mayMutateMemberPaths = false
            switch node {
                case CallExpressionSyntax,
                MemberIndexAssignmentExpressionSyntax,
                IndexAssignmentExpressionSyntax,
                CompoundIndexAssignmentExpressionSyntax,
                IndirectAssignmentExpressionSyntax,
                IndirectCompoundAssignmentExpressionSyntax {
                    mayMutateMemberPaths = true
                }
                case mfa is MemberFieldAssignmentExpressionSyntax {
                    mayMutateMemberPaths = true
                    assigned.Add(mfa.FieldIdentifier.ValueText)
                }
                case fa is FieldAssignmentExpressionSyntax {
                    mayMutateMemberPaths = true
                    assigned.Add(fa.FieldIdentifier.ValueText)
                }
                case a is AssignmentExpressionSyntax {
                    assigned.Add(a.IdentifierToken.ValueText)
                }
                case coalescing is NullCoalescingAssignmentExpressionSyntax {
                    if coalescing.Target is NameExpressionSyntax target {
                        assigned.Add(target.IdentifierToken.ValueText)
                    } else if coalescing.Target is AccessorExpressionSyntax{RightPart: NameExpressionSyntax field} {
                        mayMutateMemberPaths = true
                        assigned.Add(field.IdentifierToken.ValueText)
                    } else {
                        mayMutateMemberPaths = true
                    }
                }
                case EventSubscriptionExpressionSyntax{IsIncrementDecrement: true} inc {
                    if inc.LeftHandSide is NameExpressionSyntax incName {
                        assigned.Add(incName.IdentifierToken.ValueText)
                    } else {
                        mayMutateMemberPaths = true
                    }
                }
                case m is MultiAssignmentStatementSyntax {
                    for t in m.Targets {
                        if t is NameExpressionSyntax ne {
                            assigned.Add(ne.IdentifierToken.ValueText)
                        } else if t is MultiAssignmentDeclarationExpressionSyntax {
                            // Fresh locals do not mutate pre-existing storage.

                        } else {
                            mayMutateMemberPaths = true
                        }
                    }
                }
            }
            for child in node.GetChildren() {
                mayMutateMemberPaths |= CollectAssignedNamesAndMemberMutation(child, assigned)
            }
            return mayMutateMemberPaths
        }

        // ADR-0208 section 6: the forward-`goto` join and the shadow join share
        // one rule, which lives on NarrowingState.
        private func FindCommonImplicitSupertype(path AccessPath, sourceTypes IReadOnlyList[TypeSymbol]) TypeSymbol? {
            return NarrowingState.JoinTypes(path, sourceTypes)
        }

        /// Whether a value of static type [`assignedType`](paramref) proves a
        /// target non-nil whose non-nullable type is [`narrowedType`](paramref):
        /// it is not nullable and converts implicitly. Shared by assignment
        /// narrowing (issue #1123) and the `??=` result type (issue #4967).
        /// @param assignedType The assigned value's pre-conversion type.
        /// @param narrowedType The target's underlying non-nullable type.
        /// @returns `true` when the value is statically non-nil.
        internal func AssignmentTypePreservesNarrowing(assignedType TypeSymbol?, narrowedType TypeSymbol) bool {
            if assignedType == nil ||
                assignedType == TypeSymbol.Error ||
                assignedType == TypeSymbol.Null ||
                assignedType is NullableTypeSymbol ||
                (assignedType is TypeParameterSymbol assignedTp && !Binder.SatisfiesNotNullConstraint(assignedTp)) {
                return false
            }
            let conversion = Conversion.Classify(assignedType, narrowedType)
            return conversion.Exists && conversion.IsImplicit
        }

        /// Issue #3907: whether [`value`](paramref) — the right-hand side of
        /// an assignment — is itself an assignment whose own value proves the outer
        /// target non-nil.
        /// @param value The outer assignment's right-hand side.
        /// @param narrowedType The outer target's underlying non-nullable type.
        /// @returns `true` when the nested assignment narrows the outer target.
        internal func NestedAssignmentPreservesNarrowing(value BoundExpression?, narrowedType TypeSymbol) bool {
            var value = value
            while value is BoundConversionExpression conversion {
                value = conversion.Expression
            }
            if value == nil {
                return false
            }
            if value.Syntax is NullCoalescingAssignmentExpressionSyntax &&
                value.Type is not PlatformTypeSymbol &&
                AssignmentTypePreservesNarrowing(value.Type, narrowedType) {
                return true
            }
            if TryExtractNullCoalescingAssignmentFromExpression(value, out var nestedNca) && nestedNca != nil {
                return (
                    nestedNca.AssignedValueType is not PlatformTypeSymbol &&
                        AssignmentTypePreservesNarrowing(nestedNca.AssignedValueType, narrowedType)
                ) ||
                    NestedAssignmentPreservesNarrowing(nestedNca.Expression, narrowedType)
            }
            let coalesce BoundBinaryExpression? = if value.Syntax is NullCoalescingAssignmentExpressionSyntax {
                switch value {
                    case bin is BoundBinaryExpression when bin.Op.Kind == BoundBinaryOperatorKind.NullCoalesce: bin
                    case block is BoundBlockExpression when block.Expression is BoundBinaryExpression bin &&
                        bin
                        .Op
                        .Kind == BoundBinaryOperatorKind.NullCoalesce: bin
                    default: default(BoundBinaryExpression?)
                }
            } else {
                default(BoundBinaryExpression?)
            }
            if coalesce != nil {
                var right = coalesce.Right
                while right is BoundConversionExpression conv {
                    right = conv.Expression
                }
                if right is BoundBlockExpression rightBlock {
                    for stmt in rightBlock.Statements {
                        if stmt is BoundVariableDeclaration{Initializer: {} initExpr} &&
                            NestedAssignmentPreservesNarrowing(initExpr, narrowedType) {
                            return true
                        }
                    }
                }
                return false
            }
            let inner BoundExpression? = switch value {
                case nestedLocal is BoundAssignmentExpression: if nestedLocal.AssignedValueType is not PlatformTypeSymbol &&
                    AssignmentTypePreservesNarrowing(nestedLocal.AssignedValueType, narrowedType) {
                    return true
                } else {
                    nestedLocal.Expression
                }
                case nestedField is BoundFieldAssignmentExpression: nestedField.Value
                default: default(BoundExpression?)
            }
            if inner == nil {
                return false
            }
            if inner.Type is not NullableTypeSymbol &&
                inner.Type is not PlatformTypeSymbol &&
                (
                AssignmentTypePreservesNarrowing(inner.Type, narrowedType) ||
                    (
                    narrowedType is TypeParameterSymbol &&
                        inner.Type == narrowedType &&
                        ExpressionBinder.IsProvenNonNullTypeParameterExpression(inner)
                )
            ) {
                return true
            }
            var innerValue = inner
            while innerValue is BoundConversionExpression innerConversion {
                innerValue = innerConversion.Expression
            }
            return (
                innerValue.Type is not PlatformTypeSymbol &&
                    (
                    AssignmentTypePreservesNarrowing(innerValue.Type, narrowedType) ||
                        (
                        narrowedType is TypeParameterSymbol &&
                            innerValue.Type == narrowedType &&
                            ExpressionBinder.IsProvenNonNullTypeParameterExpression(innerValue)
                    )
                )
            ) ||
                NestedAssignmentPreservesNarrowing(innerValue, narrowedType)
        }

        internal func TryExtractNullCoalescingAssignmentFromExpression(
            expression BoundExpression?,
            out assign BoundAssignmentExpression?
        ) bool {
            assign = nil
            var current = expression
            while current is BoundConversionExpression conv && conv.Syntax is not CallExpressionSyntax {
                current = conv.Expression
            }
            if current == nil || current.Syntax is not NullCoalescingAssignmentExpressionSyntax {
                return false
            }
            let coalesce BoundBinaryExpression? = switch current {
                case bin is BoundBinaryExpression when bin.Op.Kind == BoundBinaryOperatorKind.NullCoalesce: bin
                case block is BoundBlockExpression when block.Expression is BoundBinaryExpression bin &&
                    bin
                    .Op
                    .Kind == BoundBinaryOperatorKind.NullCoalesce: bin
                default: default(BoundBinaryExpression?)
            }
            if coalesce == nil {
                return false
            }
            var left = coalesce.Left
            while left is BoundConversionExpression conv {
                left = conv.Expression
            }
            if left is not BoundVariableExpression targetVar {
                return false
            }
            var right = coalesce.Right
            while right is BoundConversionExpression conv {
                right = conv.Expression
            }
            if right.Type == TypeSymbol.Never {
                assign = BoundAssignmentExpression(current.Syntax, targetVar.Variable, right, TypeSymbol.Never)
                return true
            }
            if right is BoundBlockExpression rightBlock {
                for stmt in rightBlock.Statements {
                    if stmt is BoundExpressionStatement{Expression: BoundAssignmentExpression writeAssign} &&
                        object.ReferenceEquals(writeAssign.Variable, targetVar.Variable) {
                        assign = writeAssign
                        return true
                    }
                }
            }
            return false
        }

        private func IsDefinitelyNonNullVariable(variable VariableSymbol) bool {
            if variable is ParameterSymbol {
                return false
            }
            if !SmartCastStability.IsAssignmentNarrowingRoot(variable) ||
                !variable.IsReadOnly ||
                variable.Type is NullableTypeSymbol {
                return false
            }
            return variable.HasDefinitelyNonNullValue
        }

        private func DescendantsAndSelf(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in DescendantsAndSelf(child) {
                    yield descendant
                }
            }
        }

        /// Issue #2159: returns a fresh dictionary combining [`baseState`](paramref)
        /// with the plain-variable entries of [`add`](paramref) (a
        /// condition-narrowing frame). Member paths and by-reference roots are
        /// outside the join pass's lift scope.
        private func MergeLocalNonNull(
            baseState Dictionary[AccessPath, TypeSymbol]?,
            add Dictionary[AccessPath, TypeSymbol]?
        ) Dictionary[AccessPath, TypeSymbol] {
            let result = if baseState == nil {
                Dictionary[AccessPath, TypeSymbol]()
            } else {
                Dictionary[AccessPath, TypeSymbol](baseState)
            }
            if add != nil {
                for kv in add {
                    if !kv.Key.HasMembers && SmartCastStability.IsAssignmentNarrowingRoot(kv.Key.Root) {
                        result[kv.Key] = kv.Value
                    }
                }
            }
            return result
        }

        /// Issue #2159: intersects two branch-exit non-null maps, keeping a local
        /// only when both branches prove it non-null with the same underlying type.
        private func IntersectNonNull(
            a Dictionary[AccessPath, TypeSymbol],
            b Dictionary[AccessPath, TypeSymbol]
        ) Dictionary[AccessPath, TypeSymbol] {
            let result = Dictionary[AccessPath, TypeSymbol]()
            for kv in a {
                if b.TryGetValue(kv.Key, out var other) && object.Equals(other, kv.Value) {
                    result[kv.Key] = kv.Value
                }
            }
            return result
        }

        /// Issue #2159: removes every narrowing whose access path is rooted at
        /// [`root`](paramref) from [`state`](paramref).
        private func RemoveByRoot(state Dictionary[AccessPath, TypeSymbol], root VariableSymbol) {
            var toRemove List[AccessPath]? = nil
            for key in state.Keys {
                if object.ReferenceEquals(key.Root, root) {
                    (
                        (
                            if toRemove == nil {
                                (toRemove = List[AccessPath]())
                            } else {
                                toRemove
                            }
                        )!!
                    ).Add(key)
                }
            }
            if toRemove != nil {
                for key in toRemove {
                    state.Remove(key)
                }
            }
        }

        private func IsByReferenceRoot(root VariableSymbol) bool -> root is LocalVariableSymbol local &&
            (local.RefKind != RefKind.None || local.ManagedReferenceOrigin != nil)

        // Returns null (any name may be assigned) when the anchor is not inside a
        // function: a binder that spans several syntax trees (top-level code,
        // merged static initializers) cannot be scanned from one anchor.
        private func ComputeClosureAssignedNames(anchor SyntaxNode, binderCtx BinderContext? = nil) HashSet[string]? {
            var root SyntaxNode? = nil
            for var current SyntaxNode? = cast[SyntaxNode?](anchor); current != nil; current = current!!.Parent {
                if (
                    current is FunctionDeclarationSyntax or
                        ConstructorDeclarationSyntax or
                        PropertyAccessorSyntax or
                        EventAccessorSyntax or
                        DeinitDeclarationSyntax
                ) {
                    root = current
                }
            }
            if root == nil {
                return nil
            }
            let names = HashSet[string]()
            CollectClosureAssignedNames(root, root, names, ClosureScopeIndex())
            CollectAddressTakenNames(root, names, binderCtx)
            return names
        }

        private func CollectClosureAssignedNames(
            node SyntaxNode,
            root SyntaxNode,
            names HashSet[string],
            index ClosureScopeIndex
        ) {
            if node is FunctionLiteralExpressionSyntax ||
                node is LambdaExpressionSyntax ||
                node is AnonymousClassExpressionSyntax ||
                (node is FunctionDeclarationSyntax && !object.ReferenceEquals(node, root)) {
                CollectEscapingAssignedNames(node, names, index)
                CollectRefArgumentNames(node, names)
                CollectAddressOfNames(node, names)
                return
            }
            for child in node.GetChildren() {
                CollectClosureAssignedNames(child, root, names, index)
            }
        }

        // #5456: the names that a closure assigns and that another closure or the enclosing function can see. A
        // name that resolves to a declaration inside the assigning closure is private to one run of that closure
        // (a nested closure is another closure), so no escaped closure can write it. A name without such a
        // declaration counts, as does every shape this walk does not model.
        private func CollectEscapingAssignedNames(node SyntaxNode, names HashSet[string], index ClosureScopeIndex) {
            switch node {
                case a is AssignmentExpressionSyntax {
                    AddIfEscaping(a.IdentifierToken.ValueText, a, names, index)
                }
                case EventSubscriptionExpressionSyntax{
                    IsIncrementDecrement: true,
                    LeftHandSide: NameExpressionSyntax incName
                } inc {
                    AddIfEscaping(incName.IdentifierToken.ValueText, inc, names, index)
                }
                case m is MultiAssignmentStatementSyntax {
                    for t in m.Targets {
                        if t is NameExpressionSyntax ne {
                            AddIfEscaping(ne.IdentifierToken.ValueText, ne, names, index)
                        }
                    }
                }
                // `x ??= v` is a write the shared assigned-name walker does not model.
                case coalescing is NullCoalescingAssignmentExpressionSyntax {
                    if coalescing.Target is NameExpressionSyntax target {
                        AddIfEscaping(target.IdentifierToken.ValueText, coalescing, names, index)
                    } else {
                        CollectAllNames(coalescing.Target, names)
                    }
                }
            }
            for child in node.GetChildren() {
                CollectEscapingAssignedNames(child, names, index)
            }
        }

        private func AddIfEscaping(name string, site SyntaxNode, names HashSet[string], index ClosureScopeIndex) {
            if !IsDeclaredByAssigningClosure(name, site, index) {
                names.Add(name)
            }
        }

        private func ScopeOwnerOf(node SyntaxNode) SyntaxNode? {
            for var ancestor SyntaxNode? = node.Parent; ancestor != nil; ancestor = ancestor!!.Parent {
                if IsScopeOwner(ancestor) {
                    return ancestor
                }
            }
            return nil
        }

        // Whether the nearest declaration of [`name`](paramref) that is in scope at [`site`](paramref) is a local or
        // a parameter of the closure that holds the site. A local is in scope after its initializer, so a write inside
        // the initializer names an enclosing variable. Only a variable declaration and a parameter count: an
        // unmodelled declaration (a pattern variable, a loop variable) gives false and keeps the name.
        private func IsDeclaredByAssigningClosure(name string, site SyntaxNode, index ClosureScopeIndex) bool {
            let assigning = ScopeOwnerOf(site)
            if assigning == nil {
                return false
            }
            let siteStart = site.Span.Start
            for var ancestor SyntaxNode? = site.Parent; ancestor != nil; ancestor = ancestor!!.Parent {
                var declaration SyntaxNode? = nil
                // A declaration is in scope for the later children of a block or of a `for` clause only. A statement
                // that holds a declaration as its body (`do var x ... while (x = ...)`) does not scope it over its
                // condition.
                if ancestor is BlockStatementSyntax or
                    BlockExpressionSyntax or
                    ForClauseStatementSyntax &&
                    index
                    .DeclarationsOf(ancestor).TryGetValue(name, out var declared) {
                    for candidate in declared {
                        if candidate.Span.End <= siteStart {
                            declaration = candidate
                        }
                    }
                }
                if declaration == nil && IsScopeOwner(ancestor) && index.ParametersOf(ancestor).Contains(name) {
                    return object.ReferenceEquals(ancestor, assigning)
                }
                if declaration != nil {
                    return object.ReferenceEquals(ScopeOwnerOf(declaration), assigning)
                }
            }
            return false
        }

        // `out x` / `ref x` inside a closure lets the callee write the local.
        private func CollectRefArgumentNames(node SyntaxNode, names HashSet[string]) {
            if node is RefArgumentExpressionSyntax {
                CollectAllNames(node, names)
                return
            }
            for child in node.GetChildren() {
                CollectRefArgumentNames(child, names)
            }
        }

        // Inside a closure every `&x` (including a by-reference call argument) lets
        // the callee write the local while the closure runs.
        private func CollectAddressOfNames(node SyntaxNode, names HashSet[string]) {
            if node is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.AmpersandToken}} addressOf {
                CollectAllNames(addressOf.Operand, names)
            }
            for child in node.GetChildren() {
                CollectAddressOfNames(child, names)
            }
        }

        // An address that is stored (`let p = &x`, `ref y = x`) outlives the
        // statement and lets an unknown callable write the local, wherever in the
        // function it appears. An `&x` passed directly as a call argument is a
        // by-reference argument that cannot outlive the call, so it is not
        // collected unless the call is a type conversion (`*void(&x)`,
        // `cast[*void](&x)`) or may pass a raw pointer (`*T`) in an unsafe context.
        private func CollectAddressTakenNames(node SyntaxNode, names HashSet[string], binderCtx BinderContext? = nil) {
            switch node {
                case UnaryExpressionSyntax{
                    OperatorToken: {Kind: SyntaxKind.AmpersandToken}
                } addressOf when !IsTransientByRefCallArgument(addressOf, binderCtx) {
                    CollectAllNames(addressOf.Operand, names)
                }
                case VariableDeclarationSyntax{HasRefKindModifier: true, Initializer: {} initializer} {
                    CollectAllNames(initializer, names)
                }
                // `managed(x)` makes a persistent address of its operand.
                case persistent is CallExpressionSyntax when persistent.Identifier.Text == "managed" {
                    for argument in persistent.Arguments {
                        CollectAllNames(argument, names)
                    }
                }
            }
            for child in node.GetChildren() {
                CollectAddressTakenNames(child, names, binderCtx)
            }
        }

        private func IsTransientByRefCallArgument(addressOf UnaryExpressionSyntax, binderCtx BinderContext?) bool {
            var call CallExpressionSyntax? = nil
            var argName string? = nil
            if addressOf.Parent is CallExpressionSyntax directCall {
                call = directCall
            } else if addressOf.Parent is NamedArgumentExpressionSyntax namedArg &&
                namedArg.Parent is CallExpressionSyntax namedCall {
                call = namedCall
                argName = namedArg.NameToken.ValueText
            }
            if call == nil {
                return false
            }
            if call.ConversionTypeClause != nil {
                return false
            }
            if call.Identifier.Text == "cast" && call.TypeArgumentList != nil {
                return false
            }
            var argIndex = -1
            if argName == nil {
                for var i = 0; i < call.Arguments.Count; i++ {
                    if object.ReferenceEquals(call.Arguments[i], addressOf) {
                        argIndex = i
                        break
                    }
                }
                if argIndex < 0 {
                    return false
                }
            }
            let boundScope = binderCtx?.RootScope
            if call.Callee == nil && binderCtx != nil && boundScope != nil && binderCtx.TryLookupSourceType(
                boundScope,
                call.Identifier.ValueText,
                -1,
                nil,
                out _,
                out _
            ) {
                return false
            }
            if !IsInUnsafeSyntaxContext(addressOf, binderCtx) {
                return true
            }
            if call.Callee == nil && boundScope != nil {
                let fnName = call.Identifier.ValueText
                if boundScope.TryLookupSymbol(fnName) is VariableSymbol {
                    return false
                }
                var foundByRefParam = false
                for candidate in boundScope.TryLookupFunctions(fnName) {
                    if CandidateParameterIsPointer(candidate, argIndex, argName, ref foundByRefParam) {
                        return false
                    }
                }
                if binderCtx?.CurrentContainingType is StructSymbol currentStruct {
                    for method in currentStruct.Methods {
                        if method.Name == fnName &&
                            CandidateParameterIsPointer(method, argIndex, argName, ref foundByRefParam) {
                            return false
                        }
                    }
                    for staticFn in currentStruct.StaticMethods {
                        if staticFn.Name == fnName &&
                            CandidateParameterIsPointer(staticFn, argIndex, argName, ref foundByRefParam) {
                            return false
                        }
                    }
                }
                return foundByRefParam
            }
            if call.Callee is AccessorExpressionSyntax accessor &&
                accessor.LeftPart is NameExpressionSyntax leftName &&
                binderCtx != nil &&
                boundScope != nil &&
                binderCtx.TryLookupSourceType(
                boundScope,
                leftName.IdentifierToken.ValueText,
                -1,
                nil,
                out var ownerType,
                out _
            ) &&
                ownerType != nil {
                if ownerType is StructSymbol ownerStruct {
                    let memberName = accessor.RightPart.GetFirstToken().ValueText
                    var foundByRefParam = false
                    for method in ownerStruct.Methods {
                        if method.Name == memberName &&
                            CandidateParameterIsPointer(method, argIndex, argName, ref foundByRefParam) {
                            return false
                        }
                    }
                    for staticFn in ownerStruct.StaticMethods {
                        if staticFn.Name == memberName &&
                            CandidateParameterIsPointer(staticFn, argIndex, argName, ref foundByRefParam) {
                            return false
                        }
                    }
                    return foundByRefParam
                }
            }
            return false
        }

        private func CandidateParameterIsPointer(
            fn FunctionSymbol,
            argIndex int32,
            argName string?,
            ref foundByRefParam bool
        ) bool {
            var param ParameterSymbol? = nil
            if argName != nil {
                for p in fn.Parameters {
                    if p.Name == argName {
                        param = p
                        break
                    }
                }
            } else if argIndex >= 0 && argIndex < fn.Parameters.Length {
                param = fn.Parameters[argIndex]
            }
            if param == nil {
                return false
            }
            if param.Type is PointerTypeSymbol {
                return true
            }
            if param.RefKind != RefKind.None {
                foundByRefParam = true
            }
            return false
        }

        private func IsInUnsafeSyntaxContext(node SyntaxNode, binderCtx BinderContext?) bool {
            if binderCtx != nil && binderCtx.InUnsafeContext {
                return true
            }
            for var current SyntaxNode? = node; current != nil; current = current!!.Parent {
                if (current is BlockStatementSyntax block && block.IsUnsafe) ||
                    (current is FunctionDeclarationSyntax fn && fn.IsUnsafe) ||
                    (current is StructDeclarationSyntax structDecl && structDecl.IsUnsafe) {
                    return true
                }
            }
            return false
        }

        private func CollectAllNames(node SyntaxNode, names HashSet[string]) {
            if node is NameExpressionSyntax name {
                names.Add(name.IdentifierToken.ValueText)
            }
            for child in node.GetChildren() {
                CollectAllNames(child, names)
            }
        }

        /// ADR-0208 R12 (#5171, #5858): the variable whose storage the `ref` local
        /// [`root`](paramref) names in its initializer, or `null` when
        /// [`root`](paramref) is not such a local.
        internal func TryGetAliasedRoot(root VariableSymbol) VariableSymbol? {
            if !(root is LocalVariableSymbol local) || local.RefKind == RefKind.None {
                return nil
            }
            var origin BoundExpression? = local.ManagedReferenceOrigin
            while true {
                if origin is BoundConversionExpression conversion {
                    origin = conversion.Expression
                } else if origin is BoundUnaryExpression unary &&
                    unary
                    .Op
                    .Kind == BoundUnaryOperatorKind.NullAssertion {
                    origin = unary.Operand
                } else if origin is BoundTupleElementAccessExpression tuple {
                    origin = tuple.Receiver
                } else if origin is BoundBlockExpression block {
                    origin = block.Expression
                } else {
                    break
                }
            }
            return (origin as BoundVariableExpression)?.Variable
        }

        // The receiver of a struct method is the caller's storage, although its RefKind is None.
        private func IsValueTypeReceiver(parameter ParameterSymbol) bool -> parameter.IsReceiverParameter &&
            parameter.Type is StructSymbol{IsClass: false}

        /// ADR-0208 R12 (#5171): [`root`](paramref) followed by the variables
        /// it aliases through variable and tuple-element `ref` local initializers.
        internal func AliasChain(root VariableSymbol) List[VariableSymbol] {
            let chain = List[VariableSymbol]()
            chain.Add(root)
            var current = TryGetAliasedRoot(root)
            while current != nil && !chain.Contains(current) {
                chain.Add(current)
                current = TryGetAliasedRoot(current)
            }
            return chain
        }

        /// ADR-0208 R12 (#5171): whether [`root`](paramref) may name storage
        /// that no other root names: a by-reference parameter, whose caller may
        /// pass an element or a member, or a `ref` local whose initializer is
        /// not rooted in variable or tuple-element storage. A member, index or indirect write and any call
        /// can change that storage.
        internal func IsExternalStorageAlias(root VariableSymbol) bool {
            if root is ParameterSymbol parameter {
                return parameter.RefKind != RefKind.None || IsValueTypeReceiver(parameter)
            }
            if !(root is LocalVariableSymbol local) || local.RefKind == RefKind.None {
                return false
            }
            let chain = AliasChain(root)
            let last = chain[chain.Count - 1]
            if last is ParameterSymbol lastParameter {
                return lastParameter.RefKind != RefKind.None || IsValueTypeReceiver(lastParameter)
            }
            if last is LocalVariableSymbol lastLocal {
                return lastLocal.RefKind != RefKind.None
            }
            // A mutable global or field can be written by any call.
            return !last.IsReadOnly
        }

        /// ADR-0208 R12 (#5171): whether [`first`](paramref) and [`second`](paramref) may name one
        /// storage: the same variable, an overlapping alias chain, or two external-storage aliases.
        internal func SharesStorage(first VariableSymbol, second VariableSymbol) bool {
            if IsExternalStorageAlias(first) &&
                IsExternalStorageAlias(second) &&
                ByReferenceTypesMayOverlap(first.Type, second.Type) {
                return true
            }
            return ChainsOverlap(first, second)
        }

        private func StripNullability(type TypeSymbol?) TypeSymbol? {
            var current = type
            while current is NullableTypeSymbol or PlatformTypeSymbol {
                if current is NullableTypeSymbol nullable {
                    current = nullable.UnderlyingType
                } else if current is PlatformTypeSymbol platform {
                    current = platform.UnderlyingType
                }
            }
            return current
        }

        /// ADR-0208 R12 (#5292, amendment A3): whether two by-reference storages of these types can be one
        /// storage. The answer is "no" only when the types are provably disjoint: both are plain named class
        /// types that are not generic and mention no type parameter (a source or imported class), or a
        /// primitive or a string, after the outer nullability is stripped, and they are different types.
        /// Everything else overlaps: the same type, any generic instantiation (annotations nested in a
        /// construction are not told apart), a tuple, a struct or other value aggregate, an array, an
        /// interface, `object`, a type parameter, and any type that cannot be classified.
        internal func ByReferenceTypesMayOverlap(first TypeSymbol?, second TypeSymbol?) bool {
            let left = StripNullability(first)
            let right = StripNullability(second)
            if left == nil || right == nil || object.Equals(left, right) {
                return true
            }
            return !(IsPlainClassOrScalar(left) && IsPlainClassOrScalar(right))
        }

        private func IsPlainClassOrScalar(type TypeSymbol) bool {
            if TypeSymbol.ContainsTypeParameter(type) {
                return false
            }
            if type is StructSymbol structure {
                return structure.IsClass &&
                    structure
                    .TypeParameters
                    .IsDefaultOrEmpty &&
                    structure
                    .TypeArguments
                    .IsDefaultOrEmpty &&
                    !structure.IsConstructedNestedType &&
                    !TypeSymbol.IsUnboundGenericDefinition(structure)
            }
            let clr = type.ClrType
            if clr == nil || type is TypeParameterSymbol or InterfaceSymbol {
                return false
            }
            if clr.IsPrimitive || ClrTypeInspector.IsSameAs(clr, typeof(string)) || ClrTypeInspector.IsSameAs(
                clr,
                typeof(object)
            ) {
                return true
            }
            // An imported non-generic class, interface or `object`: a by-reference argument has the exact type of
            // its parameter, so a different reference type is a different storage.
            return type is ImportedTypeSymbol &&
                !clr.IsValueType &&
                !clr.IsGenericType &&
                !clr.IsArray &&
                !clr.IsByRef &&
                !clr.IsPointer
        }

        // ADR-0208 R5 (#5843): whether every link of [`path`](paramref) is declared in a type whose layout is known
        // not to be explicit. In a type with explicit layout, a `let` field can share storage with a `var` field.
        internal func HasSeparateMemberPathLinks(path AccessPath) bool {
            if !path.HasMembers {
                return true
            }
            for member in path.Members {
                if !IsSeparateMemberPathLink(member) {
                    return false
                }
            }
            return true
        }

        private func IsSeparateMemberPathLink(member PathMember) bool -> switch member.SourceSymbol {
            case field is FieldSymbol: if field.ExplicitOffset != nil {
                false
            } else if field.ImportedMember is FieldInfo importedField {
                importedField.DeclaringType is Type declaringType && !declaringType.IsExplicitLayout
            } else {
                ((field.OriginalDefinition ?? field).ContainingType ?? field.ContainingType) is StructSymbol owner &&
                    (owner.IsAnonymousLiteral || IsSeparateStorageOwner(owner))
            }
            case property is PropertySymbol: if property.ImportedMember is PropertyInfo importedProperty {
                importedProperty.DeclaringType is Type declaringType && !declaringType.IsExplicitLayout
            } else {
                (
                    property.BackingFieldDeclaringType ??
                        ((property.OriginalDefinition ?? property).ContainingType ?? property.ContainingType) as
                    StructSymbol ?? property.GetterSymbol?.ReceiverType as StructSymbol
                ) is StructSymbol owner &&
                    (owner.IsAnonymousLiteral || IsSeparateStorageOwner(owner))
            }
            default: switch member.ClrMember {
                case clrMember is MemberInfo: clrMember.DeclaringType is Type declaringType &&
                    !declaringType.IsExplicitLayout
                default: false
            }
        }

        /// ADR-0208 R20 and R21 (#5796, #5786, #5832): whether the source field or property write
        /// [`write`](paramref) stores into storage that no other field overlaps, and the by-reference value root
        /// through which it stores, if any. This is an allow-list. The written member must be declared in a source type
        /// of this compilation whose layout is known not to be explicit (cref:IsSeparateStorageOwner); a field of a type
        /// with explicit layout can share bytes with another field. Its receiver must be an object, a value-type
        /// variable, or a value-type field of such a receiver in such a type. A by-reference value variable (a struct
        /// `this`, a `ref` parameter or a `ref` local) is returned as the root: the write stores a field of that root's
        /// own storage, but the root can name a field of a type with explicit layout that overlaps another root
        /// (`ByReferenceWritesReach`). An imported type (G# or CLR), an interface field and every other write are not
        /// separate.
        /// @param write The bound node of the write.
        /// @returns Whether the storage is separate, and the by-reference root of the receiver.
        internal func MemberWriteStorage(write BoundExpression)(Separate bool, ByReferenceRoot VariableSymbol?) ->
        switch write {
            case field is BoundFieldAssignmentExpression: if field.StructType is {} fieldOwner &&
                IsSeparateStorageOwner(fieldOwner) {
                if field.ReceiverExpression != nil {
                    ReceiverStorage(field.ReceiverExpression)
                } else if field.Receiver is {} receiverVariable {
                    VariableStorage(receiverVariable)
                } else {
                    (true, default(VariableSymbol?))
                }
            } else {
                (false, default(VariableSymbol?))
            }
            case property is BoundPropertyAssignmentExpression: if property.StructType is {} propertyOwner &&
                IsSeparateStorageOwner(propertyOwner) {
                ReceiverStorage(property.Receiver)
            } else {
                (false, default(VariableSymbol?))
            }
            default: (false, default(VariableSymbol?))
        }

        // A source type of this compilation whose layout is known not to be explicit. An imported type has no
        // declaration, and its layout metadata is not read. A source declaration with a `StructLayout` annotation
        // whose layout is not resolved yet does not qualify.
        private func IsSeparateStorageOwner(type StructSymbol) bool {
            let definition = type.Definition ?? type
            if definition.Declaration is not{} declaration {
                return false
            }
            if definition.LayoutMetadata is {} layout {
                return layout.Layout != System.Runtime.InteropServices.LayoutKind.Explicit
            }
            for annotation in declaration.Annotations {
                if annotation.ToString().Contains("StructLayout", StringComparison.Ordinal) {
                    return false
                }
            }
            return true
        }

        private func VariableStorage(variable VariableSymbol)(Separate bool, ByReferenceRoot VariableSymbol?) {
            let variableType = StripNullability(variable.Type)
            if (variableType != nil && Binder.IsReferenceTypeForConstraint(variableType)) ||
                !IsExternalStorageAlias(variable) {
                return (true, nil)
            }
            return (true, variable)
        }

        private func ReceiverStorage(receiver BoundExpression?)(Separate bool, ByReferenceRoot VariableSymbol?) {
            if receiver == nil {
                return (true, nil)
            }
            let receiverType = StripNullability(receiver.Type)
            if receiverType != nil && Binder.IsReferenceTypeForConstraint(receiverType) {
                return (true, nil)
            }
            return switch receiver {
                case variable is BoundVariableExpression: VariableStorage(variable.Variable)
                case field is BoundFieldAccessExpression: if field.StructType is {} fieldOwner &&
                    IsSeparateStorageOwner(fieldOwner) {
                    ReceiverStorage(field.Receiver)
                } else {
                    (false, default(VariableSymbol?))
                }
                default: (false, default(VariableSymbol?))
            }
        }

        /// ADR-0208 R20 (#5827): whether the member, index or indirect write [`write`](paramref) can store into the
        /// storage of a by-reference root of type [`rootType`](paramref). A by-reference root (a struct `this`, a `ref`
        /// parameter or a `ref` local) can name a field, an array element or the backing field of an auto property.
        /// The written location holds that storage when it has the root's type, or when it is a value type that can
        /// contain the root's type in a field, a tuple element or a type argument. A scalar location (a primitive, an
        /// enum or a pointer) holds only its own value. A reference location holds one reference, so it holds the
        /// root's storage only when the root is a reference of an overlapping type
        /// (cref:ByReferenceTypesMayOverlap). Every other location is assumed to hold it.
        /// @param write A member storage write (cref:IsMemberStorageWriteExpression).
        /// @param rootType The type of the by-reference root.
        /// @returns `true` when the write can overwrite the storage of the root.
        internal func StorageWriteMayOverwriteRoot(write BoundExpression, rootType TypeSymbol?) bool -> switch write {
            case clrProperty is BoundClrPropertyAssignmentExpression: ClrLocationMayHoldRoot(
                switch clrProperty.Member {
                    case property is PropertyInfo: property.PropertyType
                    case field is FieldInfo: field.FieldType
                    default: default(Type?)
                },
                rootType
            )
            case clrIndex is BoundClrIndexAssignmentExpression: ClrLocationMayHoldRoot(
                clrIndex.Indexer.PropertyType,
                rootType
            )
            case _ is BoundFieldAssignmentExpression or
                BoundPropertyAssignmentExpression or
                BoundIndexAssignmentExpression or
                BoundIndirectAssignmentExpression: LocationMayHoldRoot(write.Type, rootType)
            default: true
        }

        private func LocationMayHoldRoot(locationType TypeSymbol?, rootType TypeSymbol?) bool {
            let location = StripNullability(locationType)
            let root = StripNullability(rootType)
            if location == nil || root == nil || location == TypeSymbol.Error || object.Equals(location, root) {
                return true
            }
            if location is EnumSymbol ||
                (
                location.ClrType is Type clr && !TypeSymbol.ContainsTypeParameter(location) &&
                    (clr.IsPrimitive || clr.IsEnum || clr.IsPointer)
            ) {
                return false
            }
            if Binder.IsReferenceTypeForConstraint(location) {
                return Binder.IsReferenceTypeForConstraint(root) && ByReferenceTypesMayOverlap(location, root)
            }
            return true
        }

        private func ClrLocationMayHoldRoot(locationType Type?, rootType TypeSymbol?) bool {
            let root = StripNullability(rootType)
            if locationType == nil || root == nil || locationType.ContainsGenericParameters || locationType.IsByRef {
                return true
            }
            if root.ClrType is Type rootClr && ClrTypeInspector.IsSameAs(locationType, rootClr) {
                return true
            }
            if locationType.IsPrimitive || locationType.IsEnum || locationType.IsPointer {
                return false
            }
            return locationType.IsValueType || Binder.IsReferenceTypeForConstraint(root)
        }

        /// ADR-0208 R12 (#5292): whether [`first`](paramref) and [`second`](paramref) are one variable or have
        /// overlapping `ref` alias chains. This is the sharing that a `ref`/`out` call argument can create.
        internal func ChainsOverlap(first VariableSymbol, second VariableSymbol) bool {
            if object.ReferenceEquals(first, second) {
                return true
            }
            let secondChain = AliasChain(second)
            for member in AliasChain(first) {
                if secondChain.Contains(member) {
                    return true
                }
            }
            return false
        }

        /// ADR-0208 R11 (#5504, #5520, #5832): whether the first access of a static field of the interface
        /// [`type`](paramref) can run user code. An interface has no `init` block, so its type initializer runs only
        /// its `shared` field initializers. The test is the one of a struct or class
        /// (cref:TypeInitializationRunsUserCode): a field initializer that is not a literal of its field type counts,
        /// and a `const` or a field with no initializer does not. The declaration pass sets the flag on the generic
        /// definition.
        internal func InterfaceInitializationRunsUserCode(type InterfaceSymbol) bool ->
        (type.Definition ?? type).DeclaresNonLiteralSharedFieldInitializer

        /// ADR-0208 R11 (#5170), R15 (#5237), #5483 and #5504: the one definition of whether initializing
        /// [`type`](paramref) runs user code. R11 (mutable globals) and R15 (closure-assigned locals) both read it,
        /// for the two events that can trigger the type initializer. The generic definition of a constructed type
        /// is checked.
        ///
        /// | type initializer                                                  | at construction (`newobj`) | at a static member access |
        /// | ----------------------------------------------------------------- | -------------------------- | ------------------------- |
        /// | `shared { init { ... } }` of a class (not `beforefieldinit`)       | yes                        | yes                       |
        /// | `shared { init { ... } }` of a value type (a literal is `initobj`) | no                         | yes                       |
        /// | `shared` field initializers only, one not a literal (`beforefieldinit`) | no                   | yes (#5520) |
        /// | `shared` field initializers only, all literals                      | no                         | no                        |
        ///
        /// The test reads the declaration (`DeclaresStaticInitializerBlock`), not the bound statements, which exist
        /// only after the body of the type is bound.
        internal func TypeInitializationRunsUserCode(type StructSymbol, atStaticMemberAccess bool) bool {
            let definition = type.Definition ?? type
            if definition.DeclaresStaticInitializerBlock && (atStaticMemberAccess || definition.IsClass) {
                return true
            }
            return atStaticMemberAccess && definition.DeclaresNonLiteralSharedFieldInitializer
        }

        // Native map hashing and equality run after the key and stored value.
        // Indexed maps can carry CLR custom comparers, even with primitive keys.
        private func NativeMapAccessRunsUserCode(node BoundExpression) bool -> switch node {
            case literal is BoundMapLiteralExpression: !literal
                .Entries
                .IsDefaultOrEmpty &&
                literal
                .MapType
                .KeyType != TypeSymbol.String &&
                !TypeSymbol.IsLegalPointeeType(literal.MapType.KeyType)
            case read is BoundIndexExpression: StripNullability(read.Target.Type) is MapTypeSymbol
            case write is BoundIndexAssignmentExpression: StripNullability(
                write.TargetExpression?.Type ?? write.Target?.Type
            ) is MapTypeSymbol
            default: false
        }

        /// ADR-0208 R14 (#5215, #5599): the one predicate for a source property accessor. It is true when
        /// [`node`](paramref) reads or writes a source property (cref:SourcePropertyRunsUserCode) whose accessor can
        /// run user code. The collector reads this, and so do the loop and `finally` summaries.
        internal func SourcePropertyAccessRunsUserCode(node BoundExpression) bool -> switch node {
            case read is BoundPropertyAccessExpression: SourcePropertyRunsUserCode(
                read.Property,
                read.Receiver?.Type,
                read.InterfaceType != nil
            )
            case write is BoundPropertyAssignmentExpression: SourcePropertyRunsUserCode(
                write.Property,
                write.Receiver?.Type,
                write.InterfaceType != nil,
                isWrite: true
            )
            default: false
        }

        /// ADR-0208 R14 (#5215, #5599): whether an accessor of the source [`property`](paramref) can run user code
        /// when it is called on a receiver of static type [`receiverType`](paramref) (`null` for a static property
        /// or for the initializer of a construction, whose type is exact). A computed accessor runs user code. An
        /// auto accessor runs none unless the call can dispatch to an override: the property is `open` or an
        /// `override` (a property override is itself overridable, #3223), or it is reached through an interface, and
        /// the receiver type can have a subclass. A value type, and a class that is neither `open` nor `sealed`
        /// (`TypeAttributes.Sealed` in `TypeDefEmitter`), cannot. A `base.` access is a call node of its own. A
        /// write ([`isWrite`](paramref)) of an auto property without a setter, which only a constructor can make,
        /// stores the backing field and calls no accessor.
        internal func SourcePropertyRunsUserCode(
            property PropertySymbol,
            receiverType TypeSymbol?,
            throughInterface bool = false,
            isWrite bool = false
        ) bool {
            if !property.IsAutoProperty || throughInterface {
                return true
            }
            if (isWrite && !property.HasSetter) ||
                property.IsStatic ||
                receiverType == nil ||
                !(property.IsVirtual || property.IsOverride) {
                return false
            }
            var type = PlatformTypeSymbol.StripTopLevel(receiverType)
            if type is NullableTypeSymbol nullable {
                type = nullable.UnderlyingType
            }
            return !(
                type is StructSymbol structType &&
                    (!structType.IsClass || (!structType.IsOpen && !structType.IsSealedHierarchy))
            )
        }

        /// ADR-0208 R16 and R17 (#5231, #5532): the one predicate that every imported accessor goes through. It is
        /// true when [`node`](paramref) reads or writes an imported property or indexer whose accessor can run user
        /// code and is not on the stable list (cref:IsStableClrAccessor): a property read, a property write, an
        /// indexer read or an indexer write. The collector reads this, and so do the loop and `finally` summaries.
        internal func ClrAccessRunsUserCode(node BoundExpression) bool -> (
            node is BoundClrPropertyAccessExpression{Member: var member} && ClrMemberReadRunsUserCode(member)
        ) ||
            (
            node is BoundClrPropertyAssignmentExpression{Member: PropertyInfo setter} &&
                !IsStableClrAccessor(setter, isSetter: true)
        ) ||
            (
            node is BoundClrIndexExpression{Indexer: var getter} indexRead &&
                (!IsStableClrAccessor(getter, isSetter: false) || ClrIndexReadIsErasedInterfaceCall(indexRead))
        ) ||
            (
            node is BoundClrIndexAssignmentExpression{Indexer: var indexer} &&
                !IsStableClrAccessor(indexer, isSetter: true)
        )

        /// ADR-0208 R17 (#5532): an index read on a receiver of an erased generic type (`List[T]` over a type
        /// parameter) is emitted as a call through the non-generic `IList` or `IDictionary` interface, which a
        /// subclass can reimplement. The listed accessor is then not the one that runs. This mirrors the test of
        /// `EmitClrIndex`: only a read, only a type that satisfies `IList` (with an `int32` index) or `IDictionary`
        /// (so not a `Span<T>`), and only one index argument. A write is always emitted on the concrete setter.
        private func ClrIndexReadIsErasedInterfaceCall(node BoundClrIndexExpression) bool {
            if node
                .Target
                .Type is not ImportedTypeSymbol{HasTypeParameterArgument: true} erased ||
                erased.ClrType is not{} clrType ||
                node
                .Arguments
                .Length != 1 {
                return false
            }
            return (ClrLoadContext.Satisfies(clrType, typeof(IList)) && node.Arguments[0].Type == TypeSymbol.Int32) ||
                ClrLoadContext.Satisfies(clrType, typeof(IDictionary))
        }

        /// ADR-0208 R16 (#5231): the same decision for a member that is read without an access node, such as the
        /// member of an imported property pattern (`lazy is { Value: 1 }`).
        internal func ClrMemberReadRunsUserCode(member MemberInfo?) bool -> member is PropertyInfo property &&
            !IsStableClrGetter(property)

        internal func IsStableClrGetter(property PropertyInfo) bool -> IsStableClrAccessor(property, isSetter: false)

        /// ADR-0208 R19 (#5593): a list pattern over an indexable input (not an array) calls its `Length`/`Count`
        /// getter, and its `this[int]` getter for each element that reads the value. A slice is a discard there, and
        /// a discard element (`_`) reads nothing. Both getters follow the one accessor rule of R16 and R17.
        internal func ListPatternRunsUserCode(node BoundListPattern) bool -> ClrMemberReadRunsUserCode(
            node.LengthProperty
        ) ||
            (
            node.IndexerProperty is {} indexer && !IsStableClrAccessor(indexer, isSetter: false) && node.Elements.Any(
                (element BoundPattern) -> element is not BoundSlicePattern && PatternReadsInput(element)
            )
        )

        /// ADR-0208 R19 (#5593): whether the emitted test of [`pattern`](paramref) loads its input value, as
        /// `EmitPattern` decides it. A discard without a variable loads nothing. Nor does `{}` on a value type that
        /// is not nullable, which `EmitPropertyPattern` emits as nothing (no input local, no null test, no member).
        /// `and`, `or` and `not` load it only through an operand that does. Every other pattern loads it.
        private func PatternReadsInput(pattern BoundPattern) bool -> switch pattern {
            case BoundDiscardPattern{Variable: nil}: false
            case property is BoundPropertyPattern: property.InputVariable != nil ||
                property
                .Fields
                .Length > 0 ||
                property.Type is NullableTypeSymbol ||
                !GSharp
                .Core
                .CodeAnalysis
                .Emit
                .ReflectionMetadataEmitter
                .IsValueTypeSymbol(property.Type)
            case binary is BoundBinaryPattern: PatternReadsInput(binary.Left) || PatternReadsInput(binary.Right)
            case negation is BoundNotPattern: PatternReadsInput(negation.Pattern)
            default: true
        }

        private func IsNullOperand(operand BoundExpression) bool {
            var value = operand
            while value is BoundConversionExpression conversion {
                if conversion.Type.StripToBareShape() is PointerTypeSymbol or FunctionPointerTypeSymbol {
                    break
                }
                if !Conversion.PreservesNull(conversion.Expression.Type, conversion.Type) {
                    return false
                }
                value = conversion.Expression
            }
            return value.Type == TypeSymbol.Null ||
                value is BoundLiteralExpression{Value: nil} ||
                (
                value is BoundFieldAccessExpression field && ConstantExpressionEvaluator.IsNullConstantSymbol(
                    field.Field
                )
            ) ||
                (
                value is BoundVariableExpression variable && ConstantExpressionEvaluator.IsNullConstantSymbol(
                    variable.Variable
                )
            ) ||
                (value is BoundDefaultExpression && Conversion.IsNullDefault(value.Type))
        }

        /// ADR-0208 R19 (#5710): whether a binary `==` or `!=` emits `object.Equals(object, object)` on an operand
        /// whose `Equals` can be user code (structural equality on a data or inline type, or a type parameter). A null
        /// operand never reaches `Equals`.
        internal func BinaryEqualityRunsUserCode(node BoundBinaryExpression) bool {
            if node
                .Op
                .Kind is not(BoundBinaryOperatorKind.Equals or BoundBinaryOperatorKind.NotEquals) ||
                IsNullOperand(node.Left) ||
                IsNullOperand(node.Right) {
                return false
            }
            if node.Left.Type is TypeParameterSymbol && node.Right.Type is TypeParameterSymbol {
                return true
            }
            if node.Op.IsReferenceEquality {
                return false
            }
            let leftType = if node.Left.Type is NullableTypeSymbol leftNullable {
                leftNullable.UnderlyingType
            } else {
                node.Left.Type
            }
            let rightType = if node.Right.Type is NullableTypeSymbol rightNullable {
                rightNullable.UnderlyingType
            } else {
                node.Right.Type
            }
            return leftType is StructSymbol structural &&
                structural == rightType &&
                (structural.IsData || structural.IsInline)
        }

        /// ADR-0208 R19 (#5593): whether the test of a constant pattern can run user code. Only an `ObjectEquals`
        /// test (cref:BoundConstantPattern.ClassifyTest) can: `object.Equals(object, object)` calls the virtual
        /// `Equals` of the input when both values are not null. An `object` input can hold any type, so its `Equals`
        /// can be a user override, even for a literal pattern value. A null value (the `nil` literal, or the default
        /// of a reference or nullable type) never reaches it. A nullable value input holds its underlying type,
        /// whose `Equals` runs no user code only for a primitive, an enum or `decimal`.
        internal func ConstantPatternRunsUserCode(node BoundConstantPattern) bool {
            return ConstantPatternTestRunsUserCode(
                BoundConstantPattern.ClassifyTest(node.Type, node.Value),
                node.Type,
                IsNullOperand(node.Value)
            )
        }

        /// The one R19 decision for a constant pattern's test of an input of type [`inputType`](paramref), which the
        /// bound pattern and the loop walker (ADR-0213) both use. `valueIsNull` is whether the pattern value is null
        /// for every instantiation.
        internal func ConstantPatternTestRunsUserCode(
            test ConstantPatternTestKind,
            inputType TypeSymbol,
            valueIsNull bool
        ) bool {
            if test != ConstantPatternTestKind.ObjectEquals || valueIsNull {
                return false
            }
            if inputType is not NullableTypeSymbol nullable {
                return true
            }
            let underlying = nullable.UnderlyingType
            if underlying is EnumSymbol {
                return false
            }
            return underlying.ClrType is not{} clr ||
                !(clr.IsPrimitive || clr.IsEnum || ClrTypeInspector.IsSameAs(clr, typeof(decimal)))
        }

        /// ADR-0208 R16 and R17 (#5231, #5532): the explicit list of imported accessors that run no user code. An
        /// accessor is stable when the declaring type is in a core library assembly, the accessor cannot be
        /// overridden (the type is sealed or the accessor is not overridable: not virtual, or `final` as an
        /// interface implementation is, so a call through an interface or an overridable member never qualifies),
        /// and the property is in this list. The list is small on purpose: add a property only when its accessor
        /// reads or writes a field and calls nothing, and name the corpus row that needs it. `Dictionary<K,V>`
        /// indexers are not on it: they call `GetHashCode` and `Equals` of the key.
        internal func IsStableClrAccessor(property PropertyInfo, isSetter bool) bool {
            // The name test comes first: it costs one string compare, and almost every imported property is not on the
            // list. The reflection reads below run only for a name that is.
            let name = property.Name
            if name != "Length" &&
                name != "IsEmpty" &&
                name != "Count" &&
                name != "Key" &&
                name != "Value" &&
                name != "HasValue" &&
                name != "Item" &&
                name != "Chars" &&
                name != "Capacity" {
                return false
            }
            let declaring = property.DeclaringType
            if declaring == nil {
                return false
            }
            let typeName = if declaring.IsGenericType {
                declaring.GetGenericTypeDefinition().FullName
            } else {
                declaring.FullName
            }
            var listed = false
            if name == "Length" {
                listed = if isSetter {
                    typeName == "System.Text.StringBuilder"
                } else {
                    typeName is "System.String" or
                        "System.Text.StringBuilder" or
                        "System.Array" or
                        "System.Span`1" or
                        "System.ReadOnlySpan`1"
                }
            } else if name == "IsEmpty" {
                listed = !isSetter && typeName is "System.Span`1" or "System.ReadOnlySpan`1"
            } else if name == "Count" {
                listed = !isSetter &&
                    typeName is "System.Collections.Generic.List`1" or
                    "System.Collections.Generic.Dictionary`2" or
                    "System.Collections.Generic.HashSet`1"
            } else if name == "Key" || name == "Value" {
                listed = !isSetter && typeName == "System.Collections.Generic.KeyValuePair`2"
            } else if name == "HasValue" {
                listed = !isSetter && typeName == "System.Nullable`1"
            } else if name == "Item" {
                listed = typeName == "System.Collections.Generic.List`1" ||
                    typeName == "System.Span`1" ||
                    (!isSetter && typeName == "System.ReadOnlySpan`1")
            } else if name == "Chars" {
                listed = typeName == "System.Text.StringBuilder" || (!isSetter && typeName == "System.String")
            } else {
                listed = isSetter && typeName == "System.Collections.Generic.List`1"
            }
            if !listed {
                return false
            }
            // A `Span<T>` indexer has no setter: a write goes through the ref-returning getter, so the accessor
            // that runs is the getter.
            let accessor = if isSetter && property.SetMethod != nil {
                property.SetMethod
            } else {
                property.GetMethod
            }
            if accessor == nil || (accessor.IsVirtual && !accessor.IsFinal && !declaring.IsSealed) {
                return false
            }
            let assemblyName = declaring.Assembly.GetName().Name
            return assemblyName == "System.Private.CoreLib" ||
                assemblyName == "System.Runtime" ||
                assemblyName == "System.Collections" ||
                assemblyName == "netstandard" ||
                assemblyName == "mscorlib"
        }

        /// ADR-0208 R11 and R15 (#5504): whether [`node`](paramref) reads, writes or subscribes a static member
        /// whose declaring type runs user code in its initializer (see (cref:TypeInitializationRunsUserCode)). The
        /// `StructType` of these nodes is the type that declares the member, so an inherited member triggers the
        /// base type and a derived type that hides it triggers the hiding type (corpus rows s08, s09, s22, s23,
        /// s25, s26). A constant has no access node: it is a literal.
        internal func StaticMemberAccessRunsUserCode(node BoundExpression) bool {
            var owner StructSymbol? = nil
            switch node.Kind {
                case BoundNodeKind.FieldAccessExpression:
                if node is BoundFieldAccessExpression{
                    Field: {IsStatic: true, IsConst: false},
                    StructType: {} fieldOwner
                } {
                    owner = fieldOwner
                } else if node is BoundFieldAccessExpression{
                    Field: {IsStatic: true, IsConst: false},
                    InterfaceType: {} interfaceOwner
                } {
                    return InterfaceInitializationRunsUserCode(interfaceOwner)
                }
                case BoundNodeKind.FieldAssignmentExpression:
                if node is BoundFieldAssignmentExpression{
                    Field: {IsStatic: true, IsConst: false},
                    StructType: {} fieldOwner
                } {
                    owner = fieldOwner
                } else if node is BoundFieldAssignmentExpression{
                    Field: {IsStatic: true, IsConst: false},
                    InterfaceType: {} interfaceOwner
                } {
                    return InterfaceInitializationRunsUserCode(interfaceOwner)
                }
                case BoundNodeKind.PropertyAccessExpression:
                if node is BoundPropertyAccessExpression{Property: {IsStatic: true}, StructType: {} propertyOwner} {
                    owner = propertyOwner
                }
                case BoundNodeKind.PropertyAssignmentExpression:
                if node is BoundPropertyAssignmentExpression{Property: {IsStatic: true}, StructType: {} propertyOwner} {
                    owner = propertyOwner
                }
                case BoundNodeKind.EventSubscriptionExpression:
                if node is BoundEventSubscriptionExpression{
                    Event: {IsStatic: true},
                    StructType: StructSymbol eventOwner
                } {
                    owner = eventOwner
                }
            }
            return owner != nil && TypeInitializationRunsUserCode(owner, atStaticMemberAccess: true)
        }

        /// ADR-0208 R11 (#5170), R15 (#5237), #5483 and #5562: the one definition of whether constructing
        /// [`type`](paramref) can run user code. The type, the generic definition of a constructed type, and
        /// every base class are checked for
        ///
        /// | member                                              | runs at construction |
        /// | --------------------------------------------------- | -------------------- |
        /// | instance field initializer                          | yes                  |
        /// | primary constructor                                 | yes                  |
        /// | explicit constructor                                | yes                  |
        /// | imported base class                                 | yes                  |
        /// | the type initializer (see (cref:TypeInitializationRunsUserCode)) | per that table |
        /// | none of the above                                   | no                   |
        internal func ConstructionRunsUserCode(type StructSymbol) bool {
            var current StructSymbol? = type
            for var depth = 0; current != nil && depth < 64; depth++ {
                let definition = current.Definition ?? current
                if definition.DeclaresInstanceFieldInitializer ||
                    !definition
                    .InstanceFieldInitializers
                    .IsEmpty ||
                    definition.HasPrimaryConstructor ||
                    !definition
                    .EffectiveExplicitConstructors
                    .IsDefaultOrEmpty ||
                    definition.ImportedBaseType != nil ||
                    TypeInitializationRunsUserCode(definition, atStaticMemberAccess: false) {
                    return true
                }
                current = definition.BaseClass
            }
            return current != nil
        }

        /// ADR-0208 R12 (#5171, #5292, amendment A3): whether the effects of a node invalidate the narrowing of
        /// [`path`](paramref). A member-bearing path drops when the node may run user code or write a member
        /// (`mayMutateMemberPaths`). A root that may name storage no other root names drops, with every path on it,
        /// when the node writes through a member, index or indirect target that can hold that storage
        /// (`mayMutateReferenceStorage`; a collector answers it for one path with `MayWriteStorageOf`, R20), and a `ref` local
        /// that does not alias a by-reference parameter also drops on any call (see
        /// (cref:CallsMayWriteAliasedStorage)). A plain call does not drop the narrowing of a by-reference
        /// parameter, as in 0.5.212 and in C#.
        internal func IsImplicitMemberRoot(root VariableSymbol) bool -> root is ImplicitFieldVariableSymbol or
            ImplicitPropertyVariableSymbol or
            ImplicitStaticFieldVariableSymbol or
            ImplicitStaticPropertyVariableSymbol

        internal func DropsOnMemberMutation(
            path AccessPath,
            mayMutateMemberPaths bool,
            mayMutateReferenceStorage bool
        ) bool -> (HasMemberLinks(path) && mayMutateMemberPaths) ||
            (
            EffectiveMemberRoot(path) is {} root &&
                IsExternalStorageAlias(root) &&
                (mayMutateReferenceStorage || (mayMutateMemberPaths && CallsMayWriteAliasedStorage(root)))
        )

        /// ADR-0208 R21 (#5786, #5830): a fact on a bare member name (an implicit member symbol) is a fact on the
        /// member of `this`, so it has member links like a member path.
        internal func HasMemberLinks(path AccessPath) bool -> path.HasMembers || IsImplicitMemberRoot(path.Root)

        /// ADR-0208 R21 (#5786, #5830): the variable whose storage holds the first link of [`path`](paramref): the
        /// receiver of an implicit instance member, the root of any other path, and `nil` for an implicit static
        /// member.
        internal func EffectiveMemberRoot(path AccessPath) VariableSymbol? -> switch path.Root {
            case field is ImplicitFieldVariableSymbol: field.Receiver
            case property is ImplicitPropertyVariableSymbol: property.Receiver
            case _ is ImplicitStaticFieldVariableSymbol or
                ImplicitStaticPropertyVariableSymbol: default(VariableSymbol?)
            default: path.Root
        }

        internal func DropsOnMemberMutation(
            path AccessPath,
            mutations AssignedRootsCollector
        ) bool -> DropsOnMemberMutation(
            path,
            mutations.MayMutateMemberPaths || mutations.ByReferenceWritesReach(path),
            mutations.MayWriteStorageOf(path)
        )

        /// ADR-0208 R12 (#5292): whether a call can write the storage that the external-storage alias
        /// [`root`](paramref) names. A by-reference parameter (or a `ref` local that aliases one) names
        /// storage that the caller owns and the callee cannot name; any other alias (a `ref` local of an
        /// element or member, or of a mutable global) can be reached through the shared heap or global.
        internal func CallsMayWriteAliasedStorage(root VariableSymbol) bool {
            let chain = AliasChain(root)
            return !(chain[chain.Count - 1] is ParameterSymbol)
        }

        internal func IsConversionOperator(function FunctionSymbol) bool -> function.IsSpecialName &&
            (function.Name == "op_Implicit" || function.Name == "op_Explicit")

        internal func IsStableSystemIndexOperation(node BoundExpression) bool -> switch node {
            case ctor is BoundClrConstructorCallExpression: ClrTypeInspector.IsSameAs(ctor.ClrType, typeof(Index)) ||
                ClrTypeInspector.IsSameAs(ctor.ClrType, typeof(Range))
            case call is BoundImportedInstanceCallExpression: call
                .Method
                .Name == "GetOffset" &&
                call
                .Method
                .DeclaringType is {} declaring &&
                ClrTypeInspector.IsSameAs(declaring, typeof(Index))
            default: false
        }

        internal func HasShallowExpressionEffects(node BoundExpression) bool {
            if IsStableSystemIndexOperation(node) {
                return false
            }
            if node is BoundAssignmentExpression or
                BoundCallOperationExpression or
                BoundClrConversionCallExpression or
                BoundClrBinaryOperatorExpression or
                BoundClrUnaryOperatorExpression or
                BoundFunctionPointerInvocationExpression or
                BoundEventSubscriptionExpression or
                BoundClrEventSubscriptionExpression or
                BoundTypeParameterConstructionExpression or
                BoundStructLiteralExpression or
                BoundInterpolatedStringExpression or
                BoundIsExpression or
                BoundNullConditionalAccessExpression {
                return true
            }
            if node is BoundAddressOfExpression{IsReadOnly: false} {
                return true
            }
            if node is BoundBinaryExpression bin {
                return BinaryEqualityRunsUserCode(bin)
            }
            return IsPotentiallyMutatingMemberPathExpression(node.Kind) ||
                IsMemberStorageWriteExpression(node.Kind) ||
                SourcePropertyAccessRunsUserCode(node) ||
                ClrAccessRunsUserCode(node) ||
                StaticMemberAccessRunsUserCode(node)
        }

        /// Returns whether an expression kind can invoke user code or assign
        /// through a member-bearing path.
        /// @param kind Bound expression kind.
        /// @returns `true` when member-path narrowings must be invalidated.
        internal func IsPotentiallyMutatingMemberPathExpression(
            kind BoundNodeKind
        ) bool -> kind == BoundNodeKind.CallExpression ||
            kind == BoundNodeKind.FunctionPointerInvocationExpression ||
            kind == BoundNodeKind.ImportedCallExpression ||
            kind == BoundNodeKind.ImportedInstanceCallExpression ||
            kind == BoundNodeKind.ConstrainedStaticCallExpression ||
            kind == BoundNodeKind.ConstructorCallExpression ||
            kind == BoundNodeKind.UserInstanceCallExpression ||
            kind == BoundNodeKind.BaseInterfaceCallExpression ||
            kind == BoundNodeKind.BaseClassCallExpression ||
            kind == BoundNodeKind.IndirectCallExpression ||
            kind == BoundNodeKind.ClrConstructorCallExpression ||
            kind == BoundNodeKind.ClrStaticCallExpression ||
            kind == BoundNodeKind.ClrConversionCallExpression ||
            IsMemberStorageWriteExpression(kind)

        /// ADR-0208 R12 (#5292): whether an expression kind writes through a member, index or indirect
        /// target, which can change the storage that a by-reference parameter names.
        internal func IsMemberStorageWriteExpression(
            kind BoundNodeKind
        ) bool -> kind == BoundNodeKind.FieldAssignmentExpression ||
            kind == BoundNodeKind.PropertyAssignmentExpression ||
            kind == BoundNodeKind.IndexAssignmentExpression ||
            kind == BoundNodeKind.ClrPropertyAssignmentExpression ||
            kind == BoundNodeKind.ClrIndexAssignmentExpression ||
            kind == BoundNodeKind.IndirectAssignmentExpression

        /// Issue #1123: whether [`type`](paramref) is a reference-like type,
        /// which is what scopes assignment narrowing to shapes whose narrowed read
        /// needs no special emit — reference nullability being purely an
        /// annotation. User value structs (null `ClrType` during binding,
        /// `IsClass == false`) and CLR value types / pointers / by-refs stay
        /// excluded, because the narrowed-read emit path does not unwrap
        /// `Nullable<T>`.
        /// @remarks Issue #3988: this was the FOURTH hand-copy of
        /// (cref:Conversion.IsReferenceLikeTarget) — its own comment said it
        /// mirrored "the reference-likeness rule the conversion classifier uses" —
        /// and it had drifted the same way the overload resolver's copy had. It
        /// named interfaces, user classes and reference-constrained type parameters
        /// but no STRUCTURAL shape, so a slice, array, named delegate, function
        /// type or channel whose element leaves its `ClrType` null did not
        /// narrow. That became load-bearing the moment #3988 made a nullable
        /// argument at an open non-nullable parameter an ERROR: the diagnostic
        /// names narrowing as one of its remedies, and for exactly those shapes
        /// `s = source` did not lift while `if s != nil` did — measured, `var s
        /// chan[T]? = nil; s = source; takesOpen[T](s)` reported GS0154 with no way
        /// to satisfy it. Every shape this adds is a genuine CLR reference, so the
        /// narrowed read stays the metadata-only no-op the #2159 arm below already
        /// relied on. The copy is gone; this DELEGATES.
        /// @param type The candidate type.
        /// @returns `true` when [`type`](paramref) is reference-like.
        private func IsReferenceLikeType(type TypeSymbol?) bool -> type != nil && Conversion.IsReferenceLikeTarget(type)

        /// Issue #4965 (ADR-0202): whether the end of a block whose bound
        /// statements are [`statements`](paramref) is unreachable, so that a
        /// value block ending this way has the bottom (`never`) type instead
        /// of needing a trailing value (GS0277). The last statement must be a
        /// `return`, `throw` or `rethrow`, a direct `break`/`continue`/`goto`
        /// (bound as a goto, which always leaves the block because the block
        /// ends right after it) — also when it sits in the tail of a nested
        /// block, an if/else, or a try (which is how a `defer` or `using let`
        /// prefix wraps the rest of the block) — or a structured statement
        /// every branch of which ends in `return`/`throw` (see
        /// EndsInUnconditionalExit). Gotos inside a switch statement are
        /// deliberately not counted: a `break` in a switch-statement arm
        /// targets the switch's own exit label and falls through to the end of
        /// the block, so counting it would type a block that completes normally
        /// as `never` (fail-safe; a tail if-else is an if-expression and is
        /// typed by its own branches instead).
        /// @param statements The bound statements of the block.
        /// @returns `true` when control can never reach the block's end.
        internal func BlockEndIsUnreachable(statements ImmutableArray[BoundStatement]) bool {
            if statements.IsDefaultOrEmpty {
                return false
            }
            return EndsInEscapingExit(statements[statements.Length - 1])
        }

        /// Issue #4965 (ADR-0202): the tail-position walk behind
        /// (cref:BlockEndIsUnreachable). A goto counts as an exit everywhere
        /// except inside a switch statement, where it may target the switch's
        /// own exit label.
        /// @param statement The statement to classify.
        /// @returns `true` when the statement never completes normally.
        private func EndsInEscapingExit(statement BoundStatement?) bool {
            switch statement {
                case nil {
                    return false
                }
                case BoundGotoStatement {
                    return true
                }
                case block is BoundBlockStatement {
                    return !block
                        .Statements
                        .IsDefaultOrEmpty &&
                        EndsInEscapingExit(block.Statements[block.Statements.Length - 1])
                }
                case nested is BoundIfStatement {
                    return nested.ElseStatement != nil &&
                        EndsInEscapingExit(nested.ThenStatement) &&
                        EndsInEscapingExit(nested.ElseStatement)
                }
                case nestedTry is BoundTryStatement {
                    if nestedTry.FinallyBlock != nil && EndsInEscapingExit(nestedTry.FinallyBlock) {
                        return true
                    }
                    return EndsInEscapingExit(nestedTry.TryBlock) && nestedTry.CatchClauses.All(
                        (clause BoundCatchClause) -> EndsInEscapingExit(clause.Body)
                    )
                }
                default {
                    return EndsInUnconditionalExit(statement, gotoExits: false)
                }
            }
        }

        private func ExpressionAlwaysExits(expression BoundExpression) bool {
            var expression = expression
            while true {
                if expression.Type == TypeSymbol.Never {
                    return true
                }
                if expression is BoundConversionExpression conversion {
                    expression = conversion.Expression
                } else if expression is BoundAssignmentExpression assignment {
                    expression = assignment.Expression
                } else {
                    return false
                }
            }
        }

        /// Classifies return, throw, mandatory `never` evaluation, and unconditional jump exits.
        /// @param statement The statement to classify.
        /// @param gotoExits Whether an unconditional goto counts as exiting this construct.
        /// @returns Whether the statement always leaves its block.
        internal func EndsInUnconditionalExit(statement BoundStatement?, gotoExits bool = true) bool {
            switch statement {
                case nil {
                    return false
                }
                case BoundReturnStatement, BoundThrowStatement, BoundRethrowStatement {
                    return true
                }
                case expression is BoundExpressionStatement {
                    return ExpressionAlwaysExits(expression.Expression)
                }
                case BoundGotoStatement {
                    // `break`/`continue` lower to BoundGotoStatement before this
                    // helper runs; an explicit `goto` likewise transfers
                    // control unconditionally. Callable-alias joins pass
                    // gotoExits: false because a goto (notably a switch's own
                    // break label) can still reach code after the construct, so
                    // only return/throw are proven to leave it (fail-safe).
                    return gotoExits
                }
                case block is BoundBlockStatement {
                    if block.Statements.IsDefaultOrEmpty {
                        return false
                    }
                    return EndsInUnconditionalExit(block.Statements[block.Statements.Length - 1], gotoExits)
                }
                case nested is BoundIfStatement {
                    if nested.ElseStatement == nil {
                        return false
                    }
                    return EndsInUnconditionalExit(nested.ThenStatement, gotoExits) &&
                        EndsInUnconditionalExit(nested.ElseStatement, gotoExits)
                }
                case nestedTry is BoundTryStatement {
                    if nestedTry.FinallyBlock != nil && EndsInUnconditionalExit(nestedTry.FinallyBlock, gotoExits) {
                        return true
                    }
                    return EndsInUnconditionalExit(nestedTry.TryBlock, gotoExits) && nestedTry.CatchClauses.All(
                        (clause BoundCatchClause) -> EndsInUnconditionalExit(clause.Body, gotoExits)
                    )
                }
                case nestedSwitch is BoundPatternSwitchStatement {
                    {
                        // ADR-0069 addendum / issue #712: a switch unconditionally
                        // exits when every arm (including default) does, and it
                        // covers every input the discriminator can take — i.e.,
                        // a default arm exists. Without a default the switch
                        // can fall through past every arm without entering any.
                        // Issue #4965: a GUARDED discard (`case _ when …`) can
                        // fail, so it is not a default; SwitchHandlesAllValues
                        // is the shared test.
                        for arm in nestedSwitch.Arms {
                            if !EndsInUnconditionalExit(arm.Body, gotoExits) {
                                return false
                            }
                        }
                        return SwitchHandlesAllValues(nestedSwitch.Arms, nestedSwitch.Discriminant.Type)
                    }
                }
                default {
                    return false
                }
            }
        }

        /// Issue #1480: returns `true` when the expression is a
        /// null-coalescing (`??`) binary expression. Such expressions honor the
        /// contextual target type in target-typed positions (typed local, return,
        /// assignment, argument) so sibling operands can unify to a common interface
        /// or base class supplied by the consumer.
        /// @param syntax The candidate expression syntax.
        /// @returns `true` for a `??` binary expression.
        private func IsNullCoalescingExpression(
            syntax ExpressionSyntax?
        ) bool -> syntax is BinaryExpressionSyntax binary &&
            binary
            .OperatorToken
            .Kind == SyntaxKind.QuestionQuestionToken

        private func IsExternalCallableSource(
            expression BoundExpression,
            externalAliases IReadOnlyCollection[VariableSymbol],
            localParameters IReadOnlyCollection[VariableSymbol]? = nil
        ) bool {
            var expression = expression
            if IsMethodCallableSource(expression) {
                return true
            }
            while expression is BoundConversionExpression conversion {
                expression = conversion.Expression
            }
            while expression is BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                expression = assertion.Operand
            }
            return expression is BoundVariableExpression variable &&
                (
                (
                    variable.Variable is ParameterSymbol and
                        {IsReadOnly: true} &&
                        (localParameters == nil || !localParameters.Contains(variable.Variable))
                ) ||
                    externalAliases.Contains(variable.Variable)
            )
        }

        private func IsMethodCallableSource(expression BoundExpression) bool {
            var expression = expression
            while expression is BoundConversionExpression conversion {
                expression = conversion.Expression
            }
            while expression is BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                expression = assertion.Operand
            }
            return expression is BoundFunctionPointerFromMethodExpression || expression is BoundMethodGroupExpression
        }

        internal func GetCallableParameterNames(initializer BoundExpression) ImmutableArray[string] ->
        BuildCallableParameterNameTree(initializer)?.Names ?? default(ImmutableArray[string])

        internal func GetTupleElementCallableParameterNames(expression BoundExpression, index int32) ImmutableArray[
            string
        ] {
            let tree = BuildCallableParameterNameTree(expression)
            if tree == nil || tree.Elements.IsDefaultOrEmpty || index < 0 || index >= tree.Elements.Length {
                return default(ImmutableArray[string])
            }
            return tree.Elements[index]?.Names ?? default(ImmutableArray[string])
        }

        internal func BuildCallableParameterNameTree(expression BoundExpression) CallableParameterNameNode? {
            var current = expression
            while true {
                if current is BoundConversionExpression conversion {
                    current = conversion.Expression
                    continue
                }
                if current is BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                    current = assertion.Operand
                    continue
                }
                if current is BoundBlockExpression{Expression: {} blockExpression} {
                    current = blockExpression
                    continue
                }
                break
            }
            if current is BoundConditionalExpression conditional {
                return MergeBranchCallableParameterNameTrees(conditional.WhenTrue, conditional.WhenFalse)
            }
            if current is BoundSwitchExpression switchExpression {
                var hasArm = false
                var merged CallableParameterNameNode? = nil
                for arm in switchExpression.Arms {
                    if IsVacuousCallableBranch(arm.Result) {
                        continue
                    }
                    let armTree = BuildCallableParameterNameTree(arm.Result)
                    if !hasArm {
                        hasArm = true
                        merged = armTree
                        if merged == nil {
                            return nil
                        }
                    } else {
                        merged = CallableParameterNameNode.Merge(merged, armTree)
                        if merged == nil {
                            return nil
                        }
                    }
                }
                return merged
            }
            if current is BoundBinaryExpression{Op: {Kind: BoundBinaryOperatorKind.NullCoalesce}} coalesce {
                return MergeBranchCallableParameterNameTrees(coalesce.Left, coalesce.Right)
            }
            if current is BoundVariableExpression variable {
                return variable.Variable.CallableParameterNameTree
            }
            if current is BoundIndirectCallExpression indirectCall {
                return BuildCallableParameterNameTree(indirectCall.Target)?.ReturnValue
            }
            if current is BoundTupleElementAccessExpression tupleAccess {
                let parentTree = BuildCallableParameterNameTree(tupleAccess.Receiver)
                if parentTree == nil ||
                    parentTree
                    .Elements
                    .IsDefaultOrEmpty ||
                    tupleAccess.Index < 0 ||
                    tupleAccess.Index >= parentTree
                    .Elements
                    .Length {
                    return nil
                }
                return parentTree.Elements[tupleAccess.Index]
            }
            if current is BoundTupleLiteralExpression tupleLiteral {
                var anyElement = false
                let builder = ImmutableArray.CreateBuilder[CallableParameterNameNode?](tupleLiteral.Elements.Length)
                for element in tupleLiteral.Elements {
                    let child = BuildCallableParameterNameTree(element)
                    anyElement |= child != nil
                    builder.Add(child)
                }
                return if anyElement {
                    CallableParameterNameNode(default(ImmutableArray[string]), builder.MoveToImmutable())
                } else {
                    nil
                }
            }
            if current is BoundFunctionLiteralExpression literal {
                let parameters = literal.Function.Parameters
                let names = if parameters.IsDefaultOrEmpty {
                    default(ImmutableArray[string])
                } else {
                    let builder = ImmutableArray.CreateBuilder[string](parameters.Length)
                    for parameter in parameters {
                        builder.Add(parameter.Name)
                    }
                    builder.MoveToImmutable()
                }
                let returnValue = BuildBodyReturnCallableParameterNameTree(literal.Body)
                if names.IsDefaultOrEmpty && returnValue == nil {
                    return nil
                }
                return CallableParameterNameNode(names, returnValue: returnValue)
            }
            if current is BoundFunctionPointerFromMethodExpression pointer {
                let parameters = pointer.Method.Parameters
                if parameters.IsDefaultOrEmpty {
                    return nil
                }
                let names = ImmutableArray.CreateBuilder[string](parameters.Length)
                for parameter in parameters {
                    names.Add(parameter.Name)
                }
                return CallableParameterNameNode(names.MoveToImmutable())
            }
            return nil
        }

        internal func BuildBodyReturnCallableParameterNameTree(body BoundBlockStatement?) CallableParameterNameNode? {
            if body == nil {
                return nil
            }
            let collector = ReturnCallableParameterNameCollector()
            collector.Visit(body)
            return collector.Result
        }

        private func IsVacuousCallableBranch(branch BoundExpression?) bool {
            if branch == nil {
                return true
            }
            var current = branch
            while true {
                if current is BoundConversionExpression conversion {
                    current = conversion.Expression
                    continue
                }
                if current is BoundBlockExpression{Expression: {} blockExpression} {
                    current = blockExpression
                    continue
                }
                break
            }
            return object.ReferenceEquals(current.Type, TypeSymbol.Never) ||
                current.Type == TypeSymbol.Null ||
                current is BoundLiteralExpression{Value: nil} ||
                current is BoundDefaultExpression ||
                current is BoundThrowExpression
        }

        private func MergeBranchCallableParameterNameTrees(
            thenBranch BoundExpression?,
            elseBranch BoundExpression?
        ) CallableParameterNameNode? {
            if IsVacuousCallableBranch(thenBranch) {
                return if IsVacuousCallableBranch(elseBranch) {
                    nil
                } else {
                    BuildCallableParameterNameTree(elseBranch!!)
                }
            }
            if IsVacuousCallableBranch(elseBranch) {
                return BuildCallableParameterNameTree(thenBranch!!)
            }
            let thenTree = BuildCallableParameterNameTree(thenBranch!!)
            let elseTree = BuildCallableParameterNameTree(elseBranch!!)
            return CallableParameterNameNode.Merge(thenTree, elseTree)
        }

        private func GetDeconstructionMemberType(
            receiverType TypeSymbol,
            aggregate StructSymbol,
            index int32,
            member Symbol,
            references ReferenceResolver?
        ) TypeSymbol {
            let memberType = GetDeconstructionMemberType(receiverType, member, references)
            if aggregate.IsData &&
                aggregate.HasPrimaryConstructor &&
                index >= 0 &&
                index < aggregate
                .PrimaryConstructorParameters
                .Length {
                if aggregate.ClrType is not{} aggregateClrType {
                    let positionalType = aggregate.PrimaryConstructorParameters[index].Type
                    return if TypeMemberModel.PositionalTypeSatisfiedByInheritedGetter(memberType, positionalType) {
                        positionalType
                    } else {
                        memberType
                    }
                }
                if member is PropertySymbol{ImportedMember: PropertyInfo importedProperty} && !ClrTypeUtilities.AreSame(
                    importedProperty.DeclaringType,
                    aggregateClrType
                ) {
                    let positionalType = if receiverType is ImportedTypeSymbol{
                        TypeArguments: {IsDefaultOrEmpty: false}
                    } &&
                        ImportedTypeSymbol.FindPrimaryConstructor(
                        aggregateClrType,
                        aggregate.PrimaryConstructorParameters
                    ) is {} primaryCtor {
                        ImportedTypeSymbol.NormalizeSemanticAggregate(
                            MemberLookup.GetClrMethodParameterTypeSymbol(receiverType, primaryCtor, index),
                            importedProperty.PropertyType,
                            references
                        )
                    } else {
                        ImportedTypeSymbol.NormalizeSemanticAggregate(
                            aggregate.PrimaryConstructorParameters[index].Type,
                            importedProperty.PropertyType,
                            references
                        )
                    }
                    return if TypeMemberModel.PositionalTypeSatisfiedByInheritedGetter(memberType, positionalType) {
                        positionalType
                    } else {
                        memberType
                    }
                }
            }
            return memberType
        }

        private func GetDeconstructionMemberType(
            receiverType TypeSymbol,
            member Symbol,
            references ReferenceResolver?
        ) TypeSymbol -> switch member {
            case field is FieldSymbol: if field.ImportedMember is FieldInfo importedField {
                ImportedTypeSymbol.NormalizeSemanticAggregate(
                    MemberLookup.GetClrFieldTypeSymbol(receiverType, importedField),
                    importedField.FieldType,
                    references
                )
            } else {
                field.Type
            }
            case property is PropertySymbol: if receiverType is not StructSymbol{ClrType: nil} &&
                property.ImportedMember is PropertyInfo importedProperty {
                let projected = MemberLookup.GetClrPropertyTypeSymbol(receiverType, importedProperty)
                let pointee = if projected is ByRefTypeSymbol byRefProperty {
                    byRefProperty.PointeeType
                } else {
                    projected
                }
                let clrPropertyType = if importedProperty.PropertyType.IsByRef {
                    importedProperty.PropertyType.GetElementType()
                } else {
                    importedProperty.PropertyType
                }
                ImportedTypeSymbol.NormalizeSemanticAggregate(pointee, clrPropertyType, references)
            } else {
                property.Type
            }
            default: TypeSymbol.Error
        }

        private func BindDeconstructionMemberAccess(
            receiver BoundExpression,
            type StructSymbol,
            member Symbol,
            memberType TypeSymbol? = nil
        ) BoundExpression -> switch member {
            case field is FieldSymbol: if field.ImportedMember is FieldInfo importedField {
                cast[BoundExpression](
                    BoundClrPropertyAccessExpression(nil, receiver, importedField, memberType ?? field.Type)
                )
            } else {
                cast[BoundExpression](
                    BoundFieldAccessExpression(
                        nil,
                        receiver,
                        type,
                        field,
                        substitutedType: memberType,
                        narrowedType: nil
                    )
                )
            }
            case property is PropertySymbol: if property.ImportedMember is PropertyInfo importedProperty {
                let effectiveType = memberType ?? property.Type
                let accessType = if property.ReturnRefKind != RefKind.None && effectiveType is not ByRefTypeSymbol {
                    cast[TypeSymbol](ByRefTypeSymbol.Get(effectiveType))
                } else {
                    effectiveType
                }
                ConversionClassifier.AutoDereferenceRefReturn(
                    BoundClrPropertyAccessExpression(nil, receiver, importedProperty, accessType)
                )
            } else {
                cast[BoundExpression](
                    BoundPropertyAccessExpression(
                        nil,
                        receiver,
                        type,
                        property,
                        substitutedType: memberType,
                        narrowedType: nil
                    )
                )
            }
            default: cast[BoundExpression](BoundErrorExpression(nil))
        }
    }
}
