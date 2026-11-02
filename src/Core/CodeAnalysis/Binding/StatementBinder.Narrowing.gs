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
    private let lastEarlyExitLifts List[(Path AccessPath, Type TypeSymbol)] = List[(Path AccessPath, Type TypeSymbol)]()
    // Issue #5128: effect summary of the statement bound last. Invalidation
    // and the callable alias update read the same summary, so the bound tree of
    // a statement is walked once. A summary is valid only for the node and the
    // entry alias set it was computed for.
    private var effectsNode BoundStatement? = nil
    private var effectsAliases HashSet[VariableSymbol]? = nil
    private var effects AssignedRootsCollector? = nil
    // Member-mutation facts are a pure function of a statement's syntax.
    private let memberMutationBySyntax Dictionary[SyntaxNode, bool] = Dictionary[SyntaxNode, bool]()
    // ADR-0208 R18: reused for each condition; read only before the branches are bound.
    private var conditionRemovedFacts Dictionary[AccessPath, TypeSymbol]?
    // ADR-0208 R18: the facts that the conditions of the `if` statements in the then-branch being bound removed,
    // so the sibling else-branch can be bound without them. `nil` outside such a branch.
    private var conditionKillJournal List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]?
    // ADR-0208 R18: the callable aliases at each operand of the condition being classified (cref:AliasesAtTests);
    // `nil` otherwise, and the current aliases apply.
    private var testAliasesAt Dictionary[BoundExpression, HashSet[VariableSymbol]]?

    internal func IsolateExternalCallableAliases() HashSet[VariableSymbol] {
        let saved = HashSet[VariableSymbol](externalCallableAliases)
        externalCallableAliases.Clear()
        return saved
    }

    internal func RestoreExternalCallableAliases(saved HashSet[VariableSymbol]) {
        externalCallableAliases.Clear()
        externalCallableAliases.UnionWith(saved)
    }

    private func CaptureExternalCallableAliases() HashSet[VariableSymbol] -> HashSet[VariableSymbol](
        externalCallableAliases
    )

    /// ADR-0208 R12 (#5171): creates an effect collector that decides storage sharing through
    /// (cref:MayShareStorage).
    private func NewCollector(
        assignmentPreservesNarrowing((BoundAssignmentExpression, TypeSymbol) -> bool)?,
        externalFunctionValues IEnumerable[VariableSymbol]? = nil
    ) AssignedRootsCollector -> AssignedRootsCollector(
        assignmentPreservesNarrowing,
        externalFunctionValues,
        (first VariableSymbol, second VariableSymbol) -> MayShareStorage(first, second)
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

    private func ComputeLoopEntryExternalCallableAliases(
        body BoundStatement,
        backEdgeTail BoundStatement?,
        breakLabel BoundLabel,
        continueLabel BoundLabel,
        entryAliases IReadOnlyCollection[VariableSymbol],
        backEdgeCondition BoundExpression? = nil
    ) HashSet[VariableSymbol] {
        let iteration = ImmutableArray.CreateBuilder[BoundStatement]()
        if backEdgeCondition != nil {
            iteration.Add(BoundExpressionStatement(nil, backEdgeCondition))
        }
        iteration.Add(body)
        iteration.Add(BoundLabelStatement(nil, continueLabel))
        if backEdgeTail != nil {
            iteration.Add(backEdgeTail)
        }
        iteration.Add(BoundLabelStatement(nil, breakLabel))
        let loop = BoundForInfiniteStatement(
            nil,
            BoundBlockStatement(nil, iteration.ToImmutable()),
            breakLabel,
            continueLabel
        )
        let collector = NewCollector(nil, entryAliases)
        collector.Visit(loop)
        return collector.DefinitelyExternalFunctionValues.ToHashSet()
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
            }
            case userInstanceCall is BoundUserInstanceCallExpression {
                if !KnownAttributes.TryGetMemberNotNullMembers(userInstanceCall.Method.Attributes, out memberNames) {
                    return
                }
            }
            default {
                return
            }
        }
        for name in memberNames {
            NarrowFieldIfNullable(name, frame)
        }
    }

    /// Looks up [`fieldName`](paramref) in the current scope. If it
    /// resolves to an (cref:ImplicitFieldVariableSymbol) whose declared
    /// type is nullable, adds a narrowing entry to [`frame`](paramref)
    /// that maps the symbol to its underlying non-nullable type.
    private func NarrowFieldIfNullable(fieldName string, frame Dictionary[AccessPath, TypeSymbol]) {
        if $scope.TryLookupSymbol(fieldName) is ImplicitFieldVariableSymbol fieldVar &&
            fieldVar.Type is NullableTypeSymbol nullable {
            SetPersistentNarrowing(frame, fieldVar, nullable.UnderlyingType)
        }
    }

    private func NarrowFieldIfNullable(fieldName string, frame NarrowingFrame) {
        if $scope.TryLookupSymbol(fieldName) is ImplicitFieldVariableSymbol fieldVar &&
            fieldVar.Type is NullableTypeSymbol nullable {
            SetPersistentNarrowing(frame, fieldVar, nullable.UnderlyingType)
        }
    }

    private func SetPersistentNarrowing(frame NarrowingFrame, path AccessPath, narrowedType TypeSymbol) {
        frame[path] = narrowedType
        NoteAssignmentNarrowing(path)
    }

    private func SetPersistentNarrowing(
        frame Dictionary[AccessPath, TypeSymbol],
        path AccessPath,
        narrowedType TypeSymbol
    ) {
        frame[path] = narrowedType
        NoteAssignmentNarrowing(path)
    }

    private func NoteAssignmentNarrowing(path AccessPath) {
        if !path.HasMembers {
            binderCtx.AssignmentNarrowingGeneration++
            binderCtx.AssignmentNarrowingGenerations[path.Root] = binderCtx.AssignmentNarrowingGeneration
        }
    }

    // `if !TryGet(out var v) || v == nil { return }` tests `v` AFTER the
    // condition wrote it through the out argument, so the narrowing it lifts is
    // about the new value. The post-statement invalidation drops every root the
    // statement writes, which discarded that lift; put back the lifted
    // narrowing of a bare variable that only the condition wrote through a
    // writable reference and that no branch or plain assignment touches.
    private func RestoreEarlyExitLiftsWrittenOnlyByCondition(
        statement BoundStatement?,
        persistentFrame NarrowingFrame
    ) {
        var statement = statement
        if lastEarlyExitLifts.Count == 0 {
            return
        }
        while statement is BoundBlockStatement labeledBlock &&
            labeledBlock.Syntax is LabeledStatementSyntax &&
            labeledBlock
            .Statements
            .Length == 2 &&
            labeledBlock.Statements[0] is BoundLabelStatement {
            statement = labeledBlock.Statements[1]
        }
        if statement is not BoundIfStatement ifStatement {
            return
        }
        let condition = NewCollector(nil, externalCallableAliases)
        condition.VisitExpression(ifStatement.Condition)
        if condition
            .WritableReferenceRoots
            .Count == 0 ||
            condition.MayMutateAnyRoot ||
            condition.MayMutateWritableReferenceRoots {
            return
        }
        let branches = NewCollector(nil, externalCallableAliases)
        branches.VisitStatement(ifStatement.ThenStatement)
        if ifStatement.ElseStatement != nil {
            branches.VisitStatement(ifStatement.ElseStatement)
        }
        let plainTargets = PlainAssignmentTargetCollector()
        plainTargets.VisitExpression(ifStatement.Condition)
        for (path, narrowedType) in lastEarlyExitLifts {
            // ADR-0208 R15: a condition that runs source code after the test of a closure-assigned root can run a
            // closure that clears it, so the lift stays removed.
            if condition.MayRunEscapedClosure &&
                MayBeMutatedByEscapedClosure(path.Root) &&
                RunsEscapedClosureAfterTest(ifStatement.Condition, path.Root) {
                continue
            }
            if !path.HasMembers && condition.WritableReferenceRoots.Contains(path.Root) &&
                !plainTargets
                .Targets
                .Contains(path.Root) && !branches.AssignsRoot(path.Root) {
                SetPersistentNarrowing(persistentFrame, path, narrowedType)
            }
        }
    }

    // ADR-0208 R15: whether an operand of the `||` chain [`condition`](paramref) that follows the last test of
    // [`root`](paramref) runs source code. A fact that the chain establishes holds only until that code runs.
    private func RunsEscapedClosureAfterTest(condition BoundExpression, root VariableSymbol) bool {
        let operands = List[BoundExpression]()
        FlattenLogicalOr(condition, operands)
        let runsCode = List[bool]()
        var lastTest = -1
        for var i = 0; i < operands.Count; i++ {
            let collector = NewCollector(nil, externalCallableAliases)
            collector.VisitExpression(operands[i])
            runsCode.Add(collector.MayRunEscapedClosure)
            let walker = RootMentionWalker(root)
            walker.VisitExpression(operands[i])
            // An operand is a test of the root when it only reads it, or when its code is the call that writes
            // the root through `out`/`ref`. An operand that runs other code after reading the root is not.
            if walker.Found && (!collector.MayRunEscapedClosure || collector.WritableReferenceRoots.Contains(root)) {
                lastTest = i
            }
        }
        for var i = lastTest + 1; i < operands.Count; i++ {
            if runsCode[i] {
                return true
            }
        }
        return false
    }

    private func FlattenLogicalOr(expression BoundExpression, operands List[BoundExpression]) {
        if expression is BoundBinaryExpression binary && binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
            FlattenLogicalOr(binary.Left, operands)
            FlattenLogicalOr(binary.Right, operands)
        } else {
            operands.Add(expression)
        }
    }

    private class RootMentionWalker : BoundTreeWalker {
        private let root VariableSymbol

        init(root VariableSymbol) {
            this.root = root
        }

        prop Found bool {
            get;
            private set;
        }

        open override func VisitExpression(node BoundExpression?) {
            if node is BoundVariableExpression variable && object.ReferenceEquals(variable.Variable, root) {
                Found = true
            }
            base.VisitExpression(node)
        }
    }

    private class PlainAssignmentTargetCollector : BoundTreeWalker {
        init() {
            Targets = HashSet[VariableSymbol]()
        }

        prop Targets HashSet[VariableSymbol] {
            get;
        }

        protected override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            if node.Variable != nil {
                Targets.Add(node.Variable)
            }
            base.VisitAssignmentExpression(node)
        }
    }

    private func InvalidateNarrowingsForAssignedVariables(
        statementSyntax SyntaxNode,
        boundStatement BoundStatement? = nil,
        removedFacts Dictionary[AccessPath, TypeSymbol]? = nil
    ) {
        EnsureClosureAssignedNames(statementSyntax)
        // Issue #1639: `NarrowedVariables.Count == 0` never fires in practice —
        // `BindBlockStatements` pushes a (usually empty) memberNotNullFrame for
        // every block, so the list always has at least one entry once binding
        // is inside any block. The real fast-path question is whether any
        // active frame actually holds a narrowing; if none do, no walk of the
        // statement's syntax subtree can possibly invalidate anything, so skip
        // both walks (and their HashSet/List allocations) entirely.
        if !HasAnyActiveNarrowings() {
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
        var dropAllMemberPaths = if boundStatement != nil {
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
            let collector = GetStatementEffects(boundStatement, externalCallableAliases)
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
        let filterNames = if statementCollector != nil {
            EnclosingFilterNames(statementSyntax, statementCollector)
        } else {
            default(HashSet[string]?)
        }
        if !anyRootAssigned &&
            !dropAllMemberPaths &&
            !dropAllRoots &&
            !dropGlobalRoots &&
            !runsEscapedClosure &&
            filterNames == nil {
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
                    filterNames != nil && (filterNames.Contains(key.Root.Name) || MayBeMutatedByUnknownCallable(key))
                ) ||
                    (
                    if statementCollector != nil {
                        StatementKillsPath(
                            statementCollector,
                            key,
                            dropAllMemberPaths,
                            statementCollector.MayMutateReferenceStorage
                        )
                    } else {
                        assignedRoots!!.Any(
                            (assigned VariableSymbol) -> object.ReferenceEquals(assigned, key.Root) ||
                                MayShareStorage(assigned, key.Root)
                        ) ||
                            DropsOnMemberMutation(key, dropAllMemberPaths, dropAllMemberPaths)
                    }
                )
                if drop {
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
                    // The frames are visited innermost first, so the recorded type is the one a read saw.
                    if removedFacts != nil && !removedFacts.ContainsKey(key) {
                        removedFacts[key] = frame[key]
                    }
                    if removedFacts != nil {
                        conditionKillJournal?.Add((frame, key, frame[key]))
                    }
                    frame.Remove(key)
                }
            }
        }
    }

    // The names that the filters of enclosing `try` statements write, when the statement
    // can run after one of them; otherwise `nil`.
    private func EnclosingFilterNames(statementSyntax SyntaxNode, effects AssignedRootsCollector) HashSet[string]? {
        if !effects.MayMutateMemberPaths && !effects.ContainsTry {
            return nil
        }
        let filters = CollectCatchFiltersAbove(statementSyntax)
        return if filters.Count > 0 {
            CollectEnclosingFilterNames(filters)
        } else {
            default(HashSet[string]?)
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
        effects.AssignsRoot(path.Root) || DropsOnMemberMutation(path, dropAllMemberPaths, dropReferenceStorage)

    private func UpdateExternalCallableAliases(
        statement BoundStatement,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]
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
        let collector = GetStatementEffects(statement, aliasesAtEntry)
        // The summary serves one statement; later statements recompute it.
        ClearStatementEffects()
        ApplyCallableAliasExitState(externalCallableAliases, statement, aliasesAtEntry, collector)
        // A filter of an enclosing try can run between any two statements of its protected block,
        // when a nested handler catches a replacement exception.
        if externalCallableAliases.Count > 0 && statement.Syntax is {} syntax {
            let filters = CollectCatchFiltersAbove(syntax)
            filters.AddRange(CollectCatchFiltersWithin(syntax))
            if filters.Count > 0 {
                RemoveFilterAffectedAliases(externalCallableAliases, filters)
            }
        }
    }

    // Returns the effect summary of [`statement`](paramref) for the entry alias
    // set [`aliases`](paramref). The summary is a collector that has visited the
    // statement. Callers must treat it as read-only.
    private func GetStatementEffects(
        statement BoundStatement,
        aliases IReadOnlyCollection[VariableSymbol]
    ) AssignedRootsCollector {
        if effects != nil && object.ReferenceEquals(effectsNode, statement) && HasSameAliases(aliases) {
            CompilationMeasurements.Count("narrowing.effect-reuses")
            return effects!!
        }
        let collector = NewCollector(nil, aliases)
        collector.Visit(statement)
        CompilationMeasurements.Count("narrowing.effect-walks")
        effectsNode = statement
        effectsAliases = if aliases.Count == 0 {
            nil
        } else {
            HashSet[VariableSymbol](aliases)
        }
        effects = collector
        return collector
    }

    private func HasSameAliases(aliases IReadOnlyCollection[VariableSymbol]) bool {
        if aliases.Count == 0 {
            return effectsAliases == nil
        }
        if effectsAliases == nil || effectsAliases!!.Count != aliases.Count {
            return false
        }
        for alias in aliases {
            if !effectsAliases!!.Contains(alias) {
                return false
            }
        }
        return true
    }

    private func ClearStatementEffects() {
        effectsNode = nil
        effectsAliases = nil
        effects = nil
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
            MemberFieldAssignmentExpressionSyntax,
            MemberIndexAssignmentExpressionSyntax,
            IndexAssignmentExpressionSyntax,
            CompoundIndexAssignmentExpressionSyntax,
            IndirectAssignmentExpressionSyntax,
            IndirectCompoundAssignmentExpressionSyntax,
            FieldAssignmentExpressionSyntax {
                mayMutateMemberPaths = true
            }
            case AssignmentExpressionSyntax { }
            case EventSubscriptionExpressionSyntax{IsIncrementDecrement: true} inc {
                mayMutateMemberPaths = inc.LeftHandSide is not NameExpressionSyntax
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
        }
        // ADR-0208 R15: a call can run an escaped closure that replaces a callable alias which a closure assigns.
        if collector.MayRunEscapedClosure {
            aliases.RemoveWhere(NamesClosureAssignedStorage)
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
        case block is BoundBlockStatement: block.Syntax != nil && !ContainsUserGotoOrLabel(block.Syntax)
        case _ is BoundIfStatement or
            _ is BoundTryStatement or
            _ is BoundPatternSwitchStatement or
            _ is BoundForInfiniteStatement or
            _ is BoundForEllipsisStatement or
            _ is BoundForRangeStatement or
            _ is BoundAwaitForRangeStatement: true
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
        return HasActiveNarrowings(binderCtx.NarrowedVariables.Count)
    }

    private func HasActiveNarrowings(frameCount int32) bool {
        for var i = Math.Min(frameCount, binderCtx.NarrowedVariables.Count) - 1; i >= 0; i-- {
            if binderCtx.NarrowedVariables[i].Count > 0 {
                return true
            }
        }
        return false
    }

    private func CollectInheritedNarrowingInvalidations(
        mutations AssignedRootsCollector,
        mayMutateMemberPaths bool,
        frameCount int32,
        frames IReadOnlyList[Dictionary[AccessPath, TypeSymbol]]
    ) List[(FrameIndex int32, Path AccessPath)] {
        let invalidations = List[(FrameIndex int32, Path AccessPath)]()
        for var i = Math.Min(frameCount, frames.Count) - 1; i >= 0; i-- {
            for path in frames[i].Keys {
                if MayBeMutatedByUnknownWrite(mutations, path) || mutations.MayMutateGlobalRoot(
                    path.Root,
                    frames[i][path]
                ) ||
                    mutations.InvalidatesNarrowing(path.Root, frames[i][path]) ||
                    DropsOnMemberMutation(path, mutations) {
                    invalidations.Add((i, path))
                }
            }
        }
        return invalidations
    }

    private func InvalidateInheritedNarrowings(invalidations IReadOnlyList[(FrameIndex int32, Path AccessPath)]) {
        for (frameIndex, path) in invalidations {
            binderCtx.NarrowedVariables[frameIndex].Remove(path)
        }
    }

    private func CollectLoopBackEdgeMutations(
        body BoundStatement,
        breakLabel BoundLabel,
        continueLabel BoundLabel,
        backEdgeTail BoundStatement?,
        backEdgeCondition BoundExpression?
    ) LoopBackEdgeMutationCollector {
        let markerLabel = BoundLabel("loopBackEdge")
        let marker = BoundExpressionStatement(nil, BoundLiteralExpression(nil, true))
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(body)
        statements.Add(BoundLabelStatement(nil, continueLabel))
        if backEdgeTail != nil {
            statements.Add(backEdgeTail)
        }
        if backEdgeCondition != nil {
            statements.Add(BoundConditionalGotoStatement(nil, markerLabel, backEdgeCondition, jumpIfTrue: true))
            statements.Add(BoundGotoStatement(nil, breakLabel))
            statements.Add(BoundLabelStatement(nil, markerLabel))
        }
        statements.Add(marker)
        statements.Add(BoundLabelStatement(nil, breakLabel))
        let graph = ControlFlowGraph.Create(Lowerer.Lower(BoundBlockStatement(nil, statements.ToImmutable())))
        let markerBlock ControlFlowGraph.BasicBlock? = graph.Blocks.FirstOrDefault(
            (block ControlFlowGraph.BasicBlock) -> block.Statements.Any(
                (statement BoundStatement) -> object.ReferenceEquals(statement, marker)
            )
        )
        let collector = LoopBackEdgeMutationCollector(
            AssignmentPreservesNarrowing,
            (first VariableSymbol, second VariableSymbol) -> MayShareStorage(first, second)
        )
        if markerBlock == nil {
            return collector
        }
        let reachesBackEdge = HashSet[ControlFlowGraph.BasicBlock]()
        let pending = Stack[ControlFlowGraph.BasicBlock]()
        pending.Push(markerBlock)
        while pending.Count > 0 {
            let block = pending.Pop()
            if !reachesBackEdge.Add(block) {
                continue
            }
            for incoming in block.Incoming {
                pending.Push(incoming.From)
            }
        }
        for block in reachesBackEdge {
            for statement in block.Statements {
                collector.Visit(statement)
            }
        }
        return collector
    }

    /// ADR-0069 / issue #700: when the bound statement is an
    /// (cref:BoundIfStatement) whose then-branch unconditionally
    /// exits the enclosing block, and whose else-frame (recorded by
    /// (cref:BindIfStatement)) is non-empty, merge that frame into
    /// [`persistentFrame`](paramref) so subsequent statements in the
    /// enclosing block see the narrowing.
    private func ApplyEarlyExitNarrowings(statement BoundStatement?, persistentFrame NarrowingFrame) {
        var statement = statement
        lastEarlyExitLifts.Clear()
        var isLabeledStatement = false
        while statement is BoundBlockStatement labeledBlock &&
            labeledBlock.Syntax is LabeledStatementSyntax &&
            labeledBlock
            .Statements
            .Length == 2 &&
            labeledBlock.Statements[0] is BoundLabelStatement {
            isLabeledStatement = true
            statement = labeledBlock.Statements[1]
        }
        // Issue #4285: suppress lifts that a user goto can bypass. A guard
        // attached directly to its target label is different: every entry
        // executes the guard. Limit that exception to bare variables, whose
        // proof generations the goto join can track.
        if binderCtx.FunctionContainsUserGotoOrLabel &&
            !(isLabeledStatement && statement is BoundIfStatement && !ContainsUserLabel(statement.Syntax)) {
            return
        }
        if statement is BoundIfStatement ifStmt {
            if !binderCtx.PendingEarlyExitFrames.TryGetValue(ifStmt, out var elseFrame) {
                return
            }
            binderCtx.PendingEarlyExitFrames.Remove(ifStmt)
            // Only apply the lift if the then-branch unconditionally exits.
            // Falling through means the variable could still be of any type
            // that satisfies the original condition, so the else-frame is not
            // a safe post-condition.
            if !EndsInUnconditionalExit(ifStmt.ThenStatement) {
                return
            }
            for kv in elseFrame {
                if binderCtx.FunctionContainsUserGotoOrLabel && !kv.Key.Members.IsDefaultOrEmpty {
                    continue
                }
                SetPersistentNarrowing(persistentFrame, kv.Key, kv.Value)
                lastEarlyExitLifts.Add((kv.Key, kv.Value))
            }
            return
        }
        // ADR-0069 addendum / issue #712: post-switch narrowing lift. When
        // every non-exiting arm contributes the same narrowing on the
        // discriminator, propagate that narrowing into the enclosing block.
        if statement is BoundPatternSwitchStatement switchStmt && binderCtx.PendingSwitchExitFrames.TryGetValue(
            switchStmt,
            out var switchFrame
        ) {
            binderCtx.PendingSwitchExitFrames.Remove(switchStmt)
            for kv in switchFrame {
                SetPersistentNarrowing(persistentFrame, kv.Key, kv.Value)
            }
        }
    }

    /// Issue #1123: assignment-based smart cast. When the bound statement is a
    /// plain `x = rhs` assignment whose target is a nullable flow-tracked
    /// variable and whose right-hand side is statically <em>non-nullable</em>
    /// value assignable to the local's underlying type, record a narrowing of
    /// `x` to that underlying non-nullable type in
    /// [`persistentFrame`](paramref). Mirrors the post-guard narrowing of
    /// (cref:ApplyEarlyExitNarrowings): the entry persists for the rest
    /// of the enclosing block (and into nested blocks) until
    /// (cref:InvalidateNarrowingsForAssignedVariables) clears it on a
    /// subsequent mutation. Called after invalidation so the fresh narrowing
    /// supersedes the clearing pass for this same statement.
    private func ApplyAssignmentNarrowing(statement BoundStatement?, persistentFrame NarrowingFrame) {
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
    }

    /// Issue #4519: joins the current narrowing state with forward jumps that
    /// can reach [`labelName`](paramref). Only assignment narrowings
    /// created after such a jump are removed; narrowings established before
    /// every jump, unrelated variables, and assignments after the label remain.
    private func InvalidateAssignmentNarrowingsBypassedByGoto(
        labelName string,
        fallthroughReachesLabel bool
    ) IReadOnlyList[GotoNarrowingSnapshot]? {
        if !binderCtx.PendingGotoAssignmentStarts.Remove(labelName, out _) {
            return nil
        }
        binderCtx.PendingGotoNarrowingSnapshots.Remove(labelName, out var incomingSnapshots)
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
        JoinExternalCallableAliases(incomingSnapshots, fallthroughReachesLabel)
        if !fallthroughReachesLabel {
            let commonIncoming = Dictionary[AccessPath, TypeSymbol]()
            let commonFrameIndices = Dictionary[AccessPath, int32]()
            for entry in incomingSnapshots[0].NarrowedVariables {
                let incomingTypes = List[TypeSymbol]{entry.Value}
                for var i = 1; i < incomingSnapshots.Count; i++ {
                    if !incomingSnapshots[i].NarrowedVariables.TryGetValue(entry.Key, out var incomingType) {
                        incomingTypes.Clear()
                        break
                    }
                    incomingTypes.Add(incomingType)
                }
                let commonType TypeSymbol? = FindCommonImplicitSupertype(entry.Key, incomingTypes)
                if commonType != nil {
                    commonIncoming.Add(entry.Key, commonType)
                    if incomingSnapshots[0].NarrowingFrameIndices.TryGetValue(entry.Key, out var frameIndex) &&
                        incomingSnapshots
                        .All(
                        (snapshot GotoNarrowingSnapshot) -> snapshot.NarrowingFrameIndices.TryGetValue(
                            entry.Key,
                            out var incomingFrame
                        ) &&
                            incomingFrame == frameIndex
                    ) {
                        commonFrameIndices.Add(entry.Key, frameIndex)
                    }
                }
            }
            for frame in binderCtx.NarrowedVariables {
                frame.Clear()
            }
            binderCtx.AssignmentNarrowingGenerations.Clear()
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
                if !entry.Key.HasMembers && incomingSnapshots[0].AssignmentGenerations.TryGetValue(
                    entry.Key.Root,
                    out var generation
                ) &&
                    incomingSnapshots
                    .All(
                    (snapshot GotoNarrowingSnapshot) -> snapshot.AssignmentGenerations.TryGetValue(
                        entry.Key.Root,
                        out var incomingGeneration
                    ) &&
                        incomingGeneration == generation
                ) {
                    binderCtx.AssignmentNarrowingGenerations.Add(entry.Key.Root, generation)
                }
            }
            return incomingSnapshots
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
                if !snapshot.NarrowedVariables.TryGetValue(entry.Key, out var sourceType) {
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
                if frame.ContainsKey(path) && targetFrameIndex < 0 {
                    targetFrameIndex = i
                }
                frame.Remove(path)
            }
            if targetFrameIndex >= 0 && joinedTypes.TryGetValue(path, out var joinedType) {
                binderCtx.NarrowedVariables[targetFrameIndex].Add(path, joinedType)
            }
        }
        return incomingSnapshots
    }

    private func JoinExternalCallableAliases(
        incomingSnapshots IReadOnlyList[GotoNarrowingSnapshot],
        fallthroughReachesLabel bool
    ) {
        if !fallthroughReachesLabel {
            externalCallableAliases.Clear()
            externalCallableAliases.UnionWith(incomingSnapshots[0].ExternalCallableAliases)
        }
        for snapshot in incomingSnapshots {
            externalCallableAliases.IntersectWith(snapshot.ExternalCallableAliases)
        }
    }

    internal func ReportUnsafeBackwardGotoNarrowings() {
        let reported = HashSet[BackwardGotoNarrowingAccess]()
        for state in binderCtx.BackwardGotoNarrowingStates.Values {
            let targetFinallySet = HashSet[FinallyClauseSyntax](state.TargetSnapshot.ActiveFinallyClauses)
            let targetCleanupSet = HashSet[BoundStatement](state.TargetSnapshot.ActiveCleanupStatements)
            for edge in state.Edges {
                let sourceSnapshot = edge.SourceSnapshot.Clone()
                if !ApplyExitedFinallyEffects(sourceSnapshot, targetFinallySet, targetCleanupSet) {
                    continue
                }
                for access in edge.Accesses {
                    let sourceType TypeSymbol? = if sourceSnapshot.NarrowedVariables.TryGetValue(
                        access.Path,
                        out var narrowedSourceType
                    ) {
                        narrowedSourceType
                    } else {
                        (
                            if access.Path.HasMembers || access.DeclaredType is NullableTypeSymbol {
                                default(TypeSymbol?)
                            } else {
                                access.DeclaredType
                            }
                        )
                    }
                    if (sourceType == nil || !IsRepresentationPreservingJoin(sourceType, access.RequiredType)) &&
                        reported
                        .Add(access) {
                        switch access.Kind {
                            case BackwardGotoNarrowingUseKind.Function {
                                Diagnostics.ReportUnableToFindFunction(access.Location, access.MemberName)
                            }
                            case BackwardGotoNarrowingUseKind.Conversion {
                                Diagnostics.ReportCannotConvert(
                                    access.Location,
                                    access.DeclaredType,
                                    Invariant.Required(
                                        access.TargetType,
                                        "a deferred conversion has a target type",
                                        expression: "access.TargetType"
                                    )
                                )
                            }
                            case BackwardGotoNarrowingUseKind.Index {
                                Diagnostics.ReportTypeNotIndexable(access.Location, access.DeclaredType)
                            }
                            case BackwardGotoNarrowingUseKind.NonNullUse {
                                Diagnostics.ReportCannotConvert(
                                    access.Location,
                                    access.DeclaredType,
                                    Invariant.Required(
                                        access.TargetType,
                                        "a deferred non-null use has a target type",
                                        expression: "access.TargetType"
                                    )
                                )
                            }
                            default {
                                Diagnostics.ReportUnableToFindMember(access.Location, access.MemberName)
                            }
                        }
                    }
                }
            }
        }
    }

    private func ApplyExitedFinallyEffects(
        snapshot GotoNarrowingSnapshot,
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
        for statement in statements {
            fallsThrough = (fallsThrough || HasInternallyReachableFallthrough(statement)) &&
                CanCompleteNormally(statement)
        }
        return fallsThrough
    }

    private func ComputeCleanupFallthroughNonNull(
        cleanup BoundStatement,
        callableAliases IReadOnlyCollection[VariableSymbol]
    ) Dictionary[AccessPath, TypeSymbol]? {
        let state = Dictionary[AccessPath, TypeSymbol]()
        let aliases = HashSet[VariableSymbol](callableAliases)
        let statements = if cleanup is BoundBlockStatement block {
            block.Statements
        } else {
            ImmutableArray.Create(cleanup)
        }
        for statement in statements {
            if !ProcessBranchStatement(statement, state, aliases) {
                return nil
            }
            let aliasesAtEntry = aliases.ToArray()
            let mutations = NewCollector(AssignmentPreservesNarrowing, aliasesAtEntry)
            mutations.Visit(statement)
            ApplyMutationsToState(state, mutations)
            ApplyCallableAliasExitState(aliases, statement, aliasesAtEntry, mutations)
        }
        return state
    }

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
                if MayBeMutatedByUnknownWrite(summary.Mutations, entry.Key) || summary.Mutations.MayMutateGlobalRoot(
                    entry.Key.Root,
                    entry.Value
                ) ||
                    DropsOnMemberMutation(entry.Key, summary.Mutations) ||
                    summary
                    .Mutations
                    .InvalidatesNarrowing(entry.Key.Root, entry.Value) {
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

    private func ApplyFlowSummary(snapshot GotoNarrowingSnapshot, summary FinallyFlowSummary) {
        for entry in snapshot.NarrowedVariables.ToArray() {
            if MayBeMutatedByUnknownWrite(summary.Mutations, entry.Key) || summary.Mutations.MayMutateGlobalRoot(
                entry.Key.Root,
                entry.Value
            ) ||
                DropsOnMemberMutation(entry.Key, summary.Mutations) ||
                summary
                .Mutations
                .InvalidatesNarrowing(entry.Key.Root, entry.Value) {
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
        out underlying TypeSymbol?
    ) bool {
        variable = nil
        underlying = nil
        if !SmartCastStability.IsAssignmentNarrowingRoot(assign.Variable) || assign.Variable.IsReadOnly {
            return false
        }
        if assign.Variable.Type is not NullableTypeSymbol nullable {
            return false
        }
        // Issue #1123 is scoped to reference (and interface) types. Nullable
        // value types (`int32?` → `int32`) are excluded: the existing narrowed-
        // read emit path does not unwrap `Nullable<T>` to its underlying value
        // for a `var`-local read, so a narrowed value-type read produces
        // unverifiable IL. Reference nullability is purely an annotation, so a
        // narrowed reference read needs no special emit.
        let u = nullable.UnderlyingType
        if !IsReferenceLikeType(u) {
            return false
        }
        if !AssignmentTypePreservesNarrowing(assign.AssignedValueType, u) &&
            !NestedAssignmentPreservesNarrowing(assign.Expression, u) {
            return false
        }
        variable = assign.Variable
        underlying = u
        return true
    }

    /// Issue #3907: whether [`value`](paramref) — the right-hand side of
    /// an assignment — is itself an assignment whose own value proves the outer
    /// target non-nil.
    /// @remarks A nested assignment's STATIC type is its own target's DECLARED
    /// type, so `order = (buffer = [8]int32)` types as `buffer`'s
    /// `[]?int32` even though the value it propagates is the definitely
    /// non-nil array literal. The outer assignment therefore failed
    /// (cref:AssignmentTypePreservesNarrowing) and `order` stayed
    /// nullable, while the identical `order = [8]int32` narrowed — an
    /// asymmetry with no justification, since the two assign the same value.
    /// C# reaches the same conclusion: its flow analysis tracks the assigned
    /// value's null-state, not the nested target's annotation.
    ///
    /// Sound because the value of an assignment expression IS the value
    /// assigned — not a re-read of the target — so `x = (y = v)` gives
    /// `x` exactly the value `v` and must narrow on exactly the
    /// evidence `x = v` narrows on. That is why this applies the SAME
    /// (cref:AssignmentTypePreservesNarrowing) test to the inner
    /// operand rather than a weaker or stronger one: the rule is a
    /// look-through, not a new narrowing source.
    /// @param value The outer assignment's right-hand side.
    /// @param narrowedType The outer target's underlying non-nullable type.
    /// @returns `true` when the nested assignment narrows the outer target.
    private func NestedAssignmentPreservesNarrowing(value BoundExpression?, narrowedType TypeSymbol) bool {
        var value = value
        while value is BoundConversionExpression conversion {
            value = conversion.Expression
        }
        let inner BoundExpression? = switch value {
            case nestedLocal is BoundAssignmentExpression: nestedLocal.Expression
            case nestedField is BoundFieldAssignmentExpression: nestedField.Value
            default: default(BoundExpression?)
        }
        if inner == nil {
            return false
        }
        var innerValue = inner
        while innerValue is BoundConversionExpression innerConversion {
            innerValue = innerConversion.Expression
        }
        return AssignmentTypePreservesNarrowing(innerValue.Type, narrowedType) ||
            NestedAssignmentPreservesNarrowing(innerValue, narrowedType)
    }

    private func AssignmentPreservesNarrowing(assignment BoundAssignmentExpression, narrowedType TypeSymbol) bool {
        // Loop back-edges need stronger proof than straight-line issue #1123
        // narrowing because the assigned value feeds a later iteration.
        return AssignmentTypePreservesNarrowing(assignment.AssignedValueType, narrowedType) &&
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
            case literal is BoundLiteralExpression: literal.Value != nil
            case BoundVariableExpression{NarrowedType: not nil} variable when variable
                .Variable
                .Type is NullableTypeSymbol &&
                !(variable.NarrowedType is NullableTypeSymbol): true
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

    /// Issue #2159: `if`-join narrowing. When both the then-branch and the
    /// else-branch (explicit or the implicit negated-condition else) of a
    /// fall-through (cref:BoundIfStatement) leave a nullable `var`
    /// local non-null at their exit, lift that narrowing into the enclosing
    /// block's persistent frame so subsequent reads see the non-nullable type.
    /// This generalises the straight-line assignment narrowing (issue #1123)
    /// and the early-exit narrowing (issue #700) to the ubiquitous
    /// "null-check then reassign in the null branch" idiom.
    ///
    /// A branch leaves the local non-null when it either (a) assigns it a
    /// statically non-null value (see (cref:TryClassifyNonNullAssignment)),
    /// or (b) is entered under a condition that narrows it non-null
    /// (`x != nil`) and never reassigns it to a nullable value. The result
    /// is the intersection over the two branch exits, so the local is narrowed
    /// only when proven non-null on every path that reaches the join.
    ///
    /// Runs after (cref:InvalidateNarrowingsForAssignedVariables) (which
    /// clears any stale narrowing on variables the `if` mutates) so the
    /// fresh join narrowing supersedes the clearing pass; a later statement that
    /// reassigns the local to a nullable value re-nullable-izes it through its
    /// own invalidation pass.
    private func ApplyIfJoinNarrowings(statement BoundStatement?, persistentFrame NarrowingFrame) {
        // Issues #4285 and #4290: arbitrary user jumps invalidate the
        // dominance assumptions behind branch-exit narrowing.
        if binderCtx.FunctionContainsUserGotoOrLabel {
            return
        }
        if statement is not BoundIfStatement ifStmt {
            return
        }
        // Both branches must fall through to the join. A branch that
        // unconditionally exits (return/throw/break/continue/goto) is the
        // early-exit case handled by ApplyEarlyExitNarrowings; requiring both
        // branches to fall through here keeps the two passes from overlapping.
        if EndsInUnconditionalExit(ifStmt.ThenStatement) {
            return
        }
        if ifStmt.ElseStatement != nil && EndsInUnconditionalExit(ifStmt.ElseStatement) {
            return
        }
        let joined Dictionary[AccessPath, TypeSymbol]? = ComputeIfJoinNonNull(ifStmt, entry: nil)
        if joined == nil || joined.Count == 0 {
            return
        }
        for kv in joined {
            let path = kv.Key
            // Lift plain nullable reference-like flow variables only, matching the
            // scope of the straight-line assignment narrowing. Value-type
            // nullables and member paths are intentionally excluded.
            if path.HasMembers || !SmartCastStability.IsAssignmentNarrowingRoot(path.Root) ||
                path
                .Root
                .IsReadOnly ||
                path
                .Root
                .Type is not NullableTypeSymbol nullable ||
                !IsReferenceLikeType(nullable.UnderlyingType) {
                continue
            }
            SetPersistentNarrowing(persistentFrame, path, nullable.UnderlyingType)
        }
    }

    /// Issue #2159: computes the set of locals proven non-null at the normal
    /// (fall-through) exit of [`ifStmt`](paramref), given the non-null
    /// locals on entry ([`entry`](paramref)). Recurses through
    /// `else if` chains (an `else if` is a nested
    /// (cref:BoundIfStatement)). Returns `null` when the
    /// whole `if` exits unconditionally (no path falls through).
    private func ComputeIfJoinNonNull(
        ifStmt BoundIfStatement,
        entry Dictionary[AccessPath, TypeSymbol]?,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) Dictionary[AccessPath, TypeSymbol]? {
        let (thenNarrow, elseNarrow) = ComputeConditionNarrowing(ifStmt.Condition)
        let thenState Dictionary[AccessPath, TypeSymbol]? = ComputeBranchFallthroughNonNull(
            ifStmt.ThenStatement,
            MergeLocalNonNull(entry, thenNarrow),
            callableAliases
        )
        let elseState Dictionary[AccessPath, TypeSymbol]? = if ifStmt.ElseStatement == nil {
            MergeLocalNonNull(entry, elseNarrow)
        } else {
            ComputeBranchFallthroughNonNull(ifStmt.ElseStatement, MergeLocalNonNull(entry, elseNarrow), callableAliases)
        }
        if thenState == nil && elseState == nil {
            return nil
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

    /// Issue #2159: computes the locals proven non-null at the normal exit of a
    /// single branch [`branch`](paramref), seeded with the non-null locals
    /// on entry. Returns `null` when the branch unconditionally
    /// exits (does not fall through to the join).
    private func ComputeBranchFallthroughNonNull(
        branch BoundStatement,
        entry Dictionary[AccessPath, TypeSymbol]?,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) Dictionary[AccessPath, TypeSymbol]? {
        let state = entry ?? Dictionary[AccessPath, TypeSymbol]()
        return if ProcessBranchStatement(branch, state, callableAliases) {
            state
        } else {
            default(Dictionary[AccessPath, TypeSymbol]?)
        }
    }

    /// Issue #2159: folds a single branch statement into the running non-null
    /// [`state`](paramref). Returns `false` when the
    /// statement unconditionally exits the branch (so later statements are
    /// unreachable).
    private func ProcessBranchStatement(
        stmt BoundStatement,
        state Dictionary[AccessPath, TypeSymbol],
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) bool {
        switch stmt {
            case BoundReturnStatement, BoundThrowStatement, BoundRethrowStatement, BoundGotoStatement {
                return false
            }
            case BoundExpressionStatement{Expression: BoundAssignmentExpression assign} {
                // The right-hand side can write other roots, aliases included.
                ClearAssignedRoots(assign, state, callableAliases)
                if TryClassifyNonNullAssignment(assign, out var local, out var underlying) {
                    RemoveSharingStorage(
                        state,
                        Invariant.Required(
                            local,
                            "a successful assignment narrowing has a variable",
                            expression: "local"
                        )
                    )
                    state[
                        AccessPath.ForVariable(
                            Invariant.Required(
                                local,
                                "a successful assignment narrowing has a variable",
                                expression: "local"
                            )
                        )
                    ] = Invariant.Required(
                        underlying,
                        "a successful assignment narrowing has an underlying type",
                        expression: "underlying"
                    )
                } else if assign.Variable != nil {
                    // Any other assignment to a tracked local (nullable value,
                    // value type, …) drops its narrowing.
                    RemoveSharingStorage(state, assign.Variable)
                }
                return true
            }
            case nested is BoundIfStatement {
                {
                    // The nested join is the exact post-if non-null set given the
                    // current state as entry, so it fully replaces the tracked
                    // state (it carries surviving entry facts through).
                    let nestedResult Dictionary[AccessPath, TypeSymbol]? = ComputeIfJoinNonNull(
                        nested,
                        Dictionary[AccessPath, TypeSymbol](state),
                        callableAliases
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
                if inner.Statements.Any((statement BoundStatement) -> statement is BoundLabelStatement) {
                    // Internal jumps do not exit the branch. Without a CFG,
                    // retain only entry facts untouched by the whole block.
                    ClearAssignedRoots(inner, state, callableAliases)
                    return true
                }
                for s in inner.Statements {
                    if !ProcessBranchStatement(s, state, callableAliases) {
                        return false
                    }
                }
                return true
            }
            case tryStatement is BoundTryStatement {
                if EndsInUnconditionalExit(tryStatement) {
                    return false
                }
                ClearAssignedRoots(tryStatement, state, callableAliases)
                if tryStatement.FinallyBlock == nil {
                    return true
                }
                let finallyState Dictionary[AccessPath, TypeSymbol]? = if ContainsUserGotoOrLabel(
                    tryStatement.FinallyBlock.Syntax
                ) {
                    (
                        if EndsInUnconditionalExit(tryStatement.FinallyBlock) {
                            default(Dictionary[AccessPath, TypeSymbol]?)
                        } else {
                            Dictionary[AccessPath, TypeSymbol]()
                        }
                    )
                } else {
                    ComputeBranchFallthroughNonNull(tryStatement.FinallyBlock, entry: nil, callableAliases)
                }
                if finallyState == nil {
                    return false
                }
                for entry in finallyState {
                    state[entry.Key] = entry.Value
                }
                return true
            }
            default {
                // Loops, switches, and any other construct that could reassign a
                // tracked local: conservatively drop every narrowing on a local
                // the statement's subtree assigns anywhere.
                ClearAssignedRoots(stmt, state, callableAliases)
                return true
            }
        }
    }

    /// Issue #2159: recomputes the then / else condition-implied non-null
    /// narrowing frames for an `if` condition, mirroring the composition
    /// (cref:BindIfStatement) performs (nil guard, `[NotNullWhen]`
    /// bool call, and type-test), so the join analysis sees the same seeds the
    /// branches were bound under.
    private func ComputeConditionNarrowing(condition BoundExpression)(
        Then Dictionary[AccessPath, TypeSymbol]?,
        Else Dictionary[AccessPath, TypeSymbol]?
    ) {
        var thenNarrow Dictionary[AccessPath, TypeSymbol]?
        var elseNarrow Dictionary[AccessPath, TypeSymbol]?
        thenNarrow, elseNarrow = TryClassifyNilGuard(condition)
        if thenNarrow == nil && elseNarrow == nil {
            thenNarrow, elseNarrow = TryClassifyBoolCallNarrowing(condition)
        }
        let (typeThen, typeElse) = TryClassifyTypeTestNarrowing(condition)
        thenNarrow = MergeNarrowingFrames(thenNarrow, typeThen)
        elseNarrow = MergeNarrowingFrames(elseNarrow, typeElse)
        return (thenNarrow, elseNarrow)
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
        before.ExceptWith(externalCallableAliases)
        return before
    }

    // The one header rule: an alias that [`header`](paramref) assigns, or that an unknown callable in it can assign,
    // is no longer known to be external.
    private func RemoveHeaderAffectedAliases(aliases HashSet[VariableSymbol], header BoundExpression) {
        let collector = NewCollector(nil, aliases)
        collector.VisitExpression(header)
        if collector.MayMutateAnyRootViaPointer {
            aliases.Clear()
        }
        RemoveAssignedAliases(aliases, collector)
        if collector.MayMutateAnyRoot || collector.MayRunEscapedClosure {
            aliases.RemoveWhere(NamesClosureAssignedStorage)
        }
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
                    headerEffects.MayMutateReferenceStorage
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
    private func ApplyInitializerEffectsToNarrowings(syntax SyntaxNode, initializer BoundStatement) {
        if !HasAnyActiveNarrowings() {
            return
        }
        let removedFacts = if conditionKillJournal == nil {
            default(Dictionary[AccessPath, TypeSymbol]?)
        } else {
            Dictionary[AccessPath, TypeSymbol]()
        }
        InvalidateNarrowingsForAssignedVariables(syntax, initializer, removedFacts)
    }

    private func IsOnNarrowingStack(frame NarrowingFrame) bool {
        for var i = binderCtx.NarrowedVariables.Count - 1; i >= 0; i-- {
            if object.ReferenceEquals(binderCtx.NarrowedVariables[i], frame) {
                return true
            }
        }
        return false
    }

    /// ADR-0208 section 9 and row R18 (#5534): the effects of a branching condition apply to the narrowing facts
    /// before either branch is bound. The condition runs first, so a call, a getter or an assignment in it can end a
    /// fact that the branches would otherwise read. The same rule as a catch filter (row R10) and the one rule of
    /// (cref:InvalidateNarrowingsForAssignedVariables). The facts that the condition itself proves are classified
    /// after this call, so a test after the effect (`Check(h) && x != nil`) still narrows its branch. The
    /// effects are read with the callable aliases from before the condition, as for a statement, so this runs
    /// before (cref:ApplyHeaderCallableEffects). Returns the removed facts with the type a read saw, or `nil`.
    private func ApplyConditionEffectsToNarrowings(syntax SyntaxNode, condition BoundExpression) Dictionary[
        AccessPath,
        TypeSymbol
    ]? {
        if !HasAnyActiveNarrowings() {
            return nil
        }
        let removedFacts = conditionRemovedFacts ?? Dictionary[AccessPath, TypeSymbol]()
        conditionRemovedFacts = removedFacts
        removedFacts.Clear()
        InvalidateNarrowingsForAssignedVariables(syntax, BoundExpressionStatement(nil, condition), removedFacts)
        return if removedFacts.Count == 0 {
            default(Dictionary[AccessPath, TypeSymbol]?)
        } else {
            removedFacts
        }
    }

    private func EnsureClosureAssignedNames(anchor SyntaxNode) -> binderCtx.EnsureClosureAssignedNames(
        () -> ComputeClosureAssignedNames(anchor)
    )

    /// Issue #2159: conservatively drops every narrowing on a local that
    /// [`node`](paramref)'s bound subtree assigns anywhere.
    private func ClearAssignedRoots(
        node BoundNode,
        state Dictionary[AccessPath, TypeSymbol],
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) {
        if state.Count == 0 {
            return
        }
        let collector = NewCollector(nil, callableAliases ?? externalCallableAliases)
        collector.Visit(node)
        if node.Syntax is {} syntax && (collector.MayMutateMemberPaths || collector.ContainsTry) {
            let filters = CollectCatchFiltersAbove(syntax)
            if filters.Count > 0 {
                let names = CollectEnclosingFilterNames(filters)
                for path in state
                    .Keys
                    .Where((path AccessPath) -> names.Contains(path.Root.Name) || MayBeMutatedByUnknownCallable(path))
                    .ToArray() {
                    state.Remove(path)
                }
            }
        }
        if collector.MayMutateAnyRoot || collector.MayRunEscapedClosure {
            for path in state.Keys.Where((path AccessPath) -> MayBeMutatedByUnknownWrite(collector, path)).ToArray() {
                state.Remove(path)
            }
        }
        if collector.MayMutateGlobalRoots {
            for path in state
                .Keys
                .Where((path AccessPath) -> path.Root is GlobalVariableSymbol && !path.Root.IsReadOnly)
                .ToArray() {
                state.Remove(path)
            }
        }
        for root in collector.Roots {
            RemoveByRoot(state, root)
        }
        for path in state
            .Keys
            .Where((path AccessPath) -> collector.SharesStorageWithAssignedRoot(path.Root))
            .ToArray() {
            state.Remove(path)
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
        private let assignedFields HashSet[AssignedField] = HashSet[AssignedField]()
        private let assignedProperties HashSet[AssignedProperty] = HashSet[AssignedProperty]()
        private let assignments Dictionary[VariableSymbol, List[BoundAssignmentExpression]] = Dictionary[
            VariableSymbol,
            List[BoundAssignmentExpression]
        ]()
        private let writableReferenceAliases Dictionary[VariableSymbol, BoundExpression] = Dictionary[
            VariableSymbol,
            BoundExpression
        ]()
        private let functionLiterals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]] = Dictionary[
            VariableSymbol,
            HashSet[BoundFunctionLiteralExpression]
        ]()
        private let unknownFunctionValues HashSet[VariableSymbol] = HashSet[VariableSymbol]()
        private let externalFunctionValues HashSet[VariableSymbol] = HashSet[VariableSymbol]()
        private let visitedFunctionLiterals HashSet[BoundFunctionLiteralExpression] = HashSet[
            BoundFunctionLiteralExpression
        ]()
        private let pendingConditionalTargets HashSet[BoundLabel] = HashSet[BoundLabel]()
        private let visitedLabels HashSet[BoundLabel] = HashSet[BoundLabel]()
        private let callableInvocationCountsAtLabel Dictionary[BoundLabel, int32] = Dictionary[BoundLabel, int32]()
        private let callableInvocations List[VariableSymbol] = List[VariableSymbol]()
        private let enclosingGlobalAssignments Stack[VariableSymbol] = Stack[VariableSymbol]()
        private var globalMutationProtectedRoots HashSet[VariableSymbol]?
        // ADR-0208 R15: the variables whose assignment encloses every node that can run an escaped closure. The
        // assignment replaces the value afterwards, so its own postcondition survives (`x = Make()`).
        private let enclosingAssignments Stack[VariableSymbol] = Stack[VariableSymbol]()
        private var escapedClosureProtectedRoots HashSet[VariableSymbol]?
        private var tryAssignedVariables HashSet[VariableSymbol]?
        private let mayShareStorage((VariableSymbol, VariableSymbol) -> bool)?

        init(
            assignmentPreservesNarrowing((BoundAssignmentExpression, TypeSymbol) -> bool)?,
            externalFunctionValues IEnumerable[VariableSymbol]? = nil,
            mayShareStorage((VariableSymbol, VariableSymbol) -> bool)? = nil
        ) {
            this.mayShareStorage = mayShareStorage
            Roots = HashSet[VariableSymbol]()
            WritableReferenceRoots = HashSet[VariableSymbol]()
            this.assignmentPreservesNarrowing = assignmentPreservesNarrowing
            if externalFunctionValues != nil {
                this.externalFunctionValues.UnionWith(externalFunctionValues)
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

        // A nested try can catch a replacement exception, after the filters of an enclosing try ran.
        prop ContainsTry bool {
            get;
            private set;
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
        prop DefinitelyExternalFunctionValues IEnumerable[VariableSymbol] -> externalFunctionValues.Except(
            unknownFunctionValues
        )
            .Where((variable VariableSymbol) -> !functionLiterals.ContainsKey(variable))

        protected open override func VisitIndirectAssignmentExpression(node BoundIndirectAssignmentExpression) {
            var pointer = node.Pointer
            while pointer is BoundConversionExpression conversion {
                pointer = conversion.Expression
            }
            while pointer is BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                pointer = assertion.Operand
            }
            if pointer is BoundAddressOfExpression address {
                RecordWritableReference(address.Operand)
            } else if pointer is BoundVariableExpression variable && writableReferenceAliases.TryGetValue(
                variable.Variable,
                out var operand
            ) {
                RecordWritableReference(operand)
            } else {
                MayMutateAnyRoot = true
                MayMutateAnyRootViaPointer = true
            }
            base.VisitIndirectAssignmentExpression(node)
        }

        open override func VisitStatement(node BoundStatement?) {
            if node is BoundLabelStatement label {
                visitedLabels.Add(label.Label)
                pendingConditionalTargets.Remove(label.Label)
                callableInvocationCountsAtLabel[label.Label] = callableInvocations.Count
            } else if node is BoundGotoStatement gotoStatement {
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
            if StatementBinder.IsPotentiallyMutatingMemberPathExpression(node.Kind) {
                MayMutateMemberPaths = true
            }
            if StatementBinder.IsMemberStorageWriteExpression(node.Kind) ||
                (
                StatementBinder.IsPotentiallyMutatingMemberPathExpression(node.Kind) &&
                    node is not BoundCallOperationExpression
            ) {
                MayMutateReferenceStorage = true
            }
            if node is BoundPropertyAccessExpression && node.Property.IsAutoProperty == false {
                MayMutateMemberPaths = true
            }
            // ADR-0208 R16 and R17 (#5231, #5532): an imported accessor that is not on the stable list is a call,
            // like a source accessor.
            if StatementBinder.ClrAccessRunsUserCode(node) {
                MarkMayMutateGlobalRoots()
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
                        (initializer BoundFieldInitializer) -> initializer.Property != nil &&
                            !initializer
                            .Property
                            .IsAutoProperty
                    )
                )
            )
            let sourcePropertyRunsUserCode = (
                node is BoundPropertyAccessExpression and
                    {Property: {IsAutoProperty: false}} or
                    BoundPropertyAssignmentExpression and
                    {Property: {IsAutoProperty: false}}
            )
            // ADR-0208 R11 (#5170): any call, property getter or constructor
            // with user code may assign a mutable global. A static member access runs the type initializer (#5504).
            if sourcePropertyRunsUserCode ||
                sourceConstructionRunsUserCode ||
                StatementBinder.StaticMemberAccessRunsUserCode(node) {
                MarkMayMutateGlobalRoots()
            }
            // ADR-0208 R15 (#5237): a call of any kind can run a closure that escaped, except a call through a
            // callable value, which keeps its own classification (AnalyzeCallableInvocation).
            if node is BoundClrConstructorCallExpression or
                BoundClrConversionCallExpression or
                BoundClrBinaryOperatorExpression or
                BoundClrUnaryOperatorExpression or
                BoundFunctionPointerInvocationExpression or
                BoundEventSubscriptionExpression or
                BoundClrEventSubscriptionExpression or
                BoundTypeParameterConstructionExpression {
                MarkRunsEscapedClosure()
            }
            // A hole of a type other than a built-in value or a string calls its `ToString`.
            if node is BoundInterpolatedStringExpression interpolation {
                for part in interpolation.Parts {
                    if part.Value is {} hole && hole.Type != TypeSymbol.String && !TypeSymbol.IsLegalPointeeType(
                        hole.Type
                    ) {
                        MarkRunsEscapedClosure()
                        break
                    }
                }
            }
            if node is BoundCallOperationExpression && !IsCallableValueInvocation(node) {
                MarkRunsEscapedClosure()
            }
            if node is BoundCallOperationExpression{CalledFunction: FunctionSymbol function, Arguments: var arguments} {
                // ADR-0208 R12 (#5292, amendment A3): a plain function call does not write by-reference storage;
                // a property or indexer accessor can assign the members the storage names.
                MarkMayMutateGlobalRoots(
                    writesReferenceStorage: function.MethodKind is MethodKind.PropertyGet or MethodKind.PropertySet
                )
                if function.HasCaptures {
                    MayMutateAnyRoot = true
                }
                let count = Math.Min(arguments.Length, function.Parameters.Length)
                for var i = 0; i < count; i++ {
                    if (function.Parameters[i].RefKind is RefKind.Ref or RefKind.Out) {
                        RecordWritableReference(arguments[i])
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
                        RecordWritableReference(argument)
                    }
                }
            }
            if node is BoundCallOperationExpression call {
                RecordCallSiteAliasing(call)
                AnalyzeCallableArguments(call.Arguments)
            }
            base.VisitExpression(node)
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
                root is ImplicitFieldVariableSymbol field && assignedFields.Contains(
                    AssignedField(field.Receiver, field.Field)
                )
            ) ||
                (
                root is ImplicitStaticFieldVariableSymbol staticField && assignedFields.Contains(
                    AssignedField(nil, staticField.Field)
                )
            ) ||
                (
                root is ImplicitPropertyVariableSymbol property && assignedProperties.Contains(
                    AssignedProperty(property.Receiver, property.Property)
                )
            ) ||
                (
                root is ImplicitStaticPropertyVariableSymbol staticProperty && assignedProperties.Contains(
                    AssignedProperty(nil, staticProperty.Property)
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
            AnalyzeCallableInvocation(node.Target)
            AnalyzeCallableArguments(node.Arguments)
            base.VisitIndirectCallExpression(node)
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

        protected open override func VisitBinaryExpression(node BoundBinaryExpression) {
            VisitExpression(node.Left)
            if node
                .Op
                .Kind is BoundBinaryOperatorKind.LogicalAnd or
                BoundBinaryOperatorKind.LogicalOr or
                BoundBinaryOperatorKind.NullCoalesce {
                VisitPossiblySkipped(() -> VisitExpression(node.Right))
            } else {
                VisitExpression(node.Right)
            }
        }

        protected open override func VisitNullConditionalAccessExpression(node BoundNullConditionalAccessExpression) {
            // The access is bound on a synthetic capture: remember the receiver behind it.
            captureReceivers[node.Capture] = node.Receiver
            VisitExpression(node.Receiver)
            VisitPossiblySkipped(() -> VisitExpression(node.WhenNotNull))
        }

        protected open override func VisitConditionalExpression(node BoundConditionalExpression) {
            VisitExpression(node.Condition)
            VisitAlternativePaths(() -> VisitExpression(node.WhenTrue), () -> VisitExpression(node.WhenFalse))
        }

        protected open override func VisitConditionalAddressExpression(node BoundConditionalAddressExpression) {
            VisitExpression(node.Condition)
            VisitAlternativePaths(
                () -> VisitExpression(node.WhenTrueOperand),
                () -> VisitExpression(node.WhenFalseOperand)
            )
        }

        protected open override func VisitBinaryPattern(node BoundBinaryPattern) {
            VisitPattern(node.Left)
            VisitPossiblySkipped(() -> VisitPattern(node.Right))
        }

        protected open override func VisitPropertyPattern(node BoundPropertyPattern) {
            for field in node.Fields {
                // A computed property of a pattern runs its getter.
                if field.Property is {} property && !property.IsAutoProperty {
                    MarkMayMutateGlobalRoots()
                }
                // ADR-0208 R16 (#5231): so does an imported property that is not on the stable list.
                if StatementBinder.ClrMemberReadRunsUserCode(field.ClrMember) {
                    MarkMayMutateGlobalRoots()
                }
                VisitPossiblySkipped(() -> VisitPattern(field.Pattern))
            }
        }

        protected open override func VisitConstantPattern(node BoundConstantPattern) {
            // ADR-0208 R19 (#5593): the test can call the input's `Equals`, which can be user code. It is a plain
            // method call, so it does not write by-reference storage (R12, amendment A3).
            if StatementBinder.ConstantPatternRunsUserCode(node) {
                MarkMayMutateGlobalRoots(writesReferenceStorage: false)
            }
            base.VisitConstantPattern(node)
        }

        protected open override func VisitListPattern(node BoundListPattern) {
            // ADR-0208 R19 (#5593): the `Length`/`Count` getter and the indexer of an indexable input (R16, R17).
            if StatementBinder.ListPatternRunsUserCode(node) {
                MarkMayMutateGlobalRoots()
            }
            for element in node.Elements {
                VisitPossiblySkipped(() -> VisitPattern(element))
            }
        }

        protected open override func VisitBaseClassCallExpression(node BoundBaseClassCallExpression) {
            // ADR-0208 R11 (#5170): a base method or computed accessor runs user code.
            if node.Method != nil {
                MarkMayMutateGlobalRoots()
            }
            AnalyzeCallableArguments(node.Arguments)
            base.VisitBaseClassCallExpression(node)
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
            if string.Equals(node.Method.Name, "Invoke", StringComparison.Ordinal) &&
                IsCallableType(node.Receiver.Type) {
                AnalyzeCallableInvocation(node.Receiver)
            }
            base.VisitImportedInstanceCallExpression(node)
        }

        protected open override func VisitFunctionPointerInvocationExpression(
            node BoundFunctionPointerInvocationExpression
        ) {
            AnalyzeCallableArguments(node.Arguments)
            base.VisitFunctionPointerInvocationExpression(node)
        }

        protected open override func VisitConstructorCallExpression(node BoundConstructorCallExpression) {
            AnalyzeCallableArguments(node.Arguments)
            base.VisitConstructorCallExpression(node)
        }

        protected open override func VisitClrConstructorCallExpression(node BoundClrConstructorCallExpression) {
            AnalyzeCallableArguments(node.Arguments)
            base.VisitClrConstructorCallExpression(node)
        }

        private func AnalyzeCallableArguments(arguments ImmutableArray[BoundExpression]) {
            for argument in arguments {
                if !IsCallableType(argument.Type) {
                    continue
                }
                let hasKnownTargets = TryGetFunctionLiterals(argument, out var literals)
                if literals != nil {
                    for literal in literals {
                        VisitFunctionLiteralBody(literal)
                    }
                }
                let isExternal = IsExternalCallable(argument)
                if isExternal {
                    MarkMayMutateGlobalRoots(runsSourceCode: false)
                }
                if IsUnknownCallable(argument) || (!hasKnownTargets && !isExternal) {
                    MayMutateAnyRoot = true
                }
            }
        }

        protected open override func VisitVariableDeclaration(node BoundVariableDeclaration) {
            if node.Initializer != nil && TryGetWritableReferenceOperand(node.Initializer, out var operand) {
                writableReferenceAliases[node.Variable] = operand!!
            }
            let externalCallable = node.Initializer != nil && IsExternalCallable(node.Initializer)
            if node.Initializer != nil && TryGetFunctionLiterals(node.Initializer, out var literals) {
                functionLiterals[node.Variable] = HashSet[BoundFunctionLiteralExpression](literals!!)
                if UnwrapCallable(node.Initializer!!) is BoundVariableExpression source &&
                    unknownFunctionValues.Contains(source.Variable) {
                    unknownFunctionValues.Add(node.Variable)
                }
                if externalCallable {
                    externalFunctionValues.Add(node.Variable)
                }
            } else if externalCallable {
                externalFunctionValues.Add(node.Variable)
            } else if node.Initializer != nil {
                unknownFunctionValues.Add(node.Variable)
            }
            base.VisitVariableDeclaration(node)
        }

        protected open override func VisitIfStatement(node BoundIfStatement) {
            VisitExpression(node.Condition)
            let branchStart = CaptureCallableState()
            VisitStatement(node.ThenStatement)
            let thenState = CaptureCallableState()
            RestoreCallableState(branchStart)
            VisitStatement(node.ElseStatement)
            let elseState = CaptureCallableState()
            var joined(
                Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                Unknown HashSet[VariableSymbol],
                External HashSet[VariableSymbol]
            )? = nil
            if !StatementBinder.EndsInUnconditionalExit(node.ThenStatement, gotoExits: false) {
                joined = JoinCallableStates(joined, thenState)
            }
            if node.ElseStatement == nil || !StatementBinder.EndsInUnconditionalExit(
                node.ElseStatement,
                gotoExits: false
            ) {
                joined = JoinCallableStates(joined, elseState)
            }
            RestoreCallableState(joined ?? branchStart)
        }

        protected open override func VisitConditionalGotoStatement(node BoundConditionalGotoStatement) {
            VisitExpression(node.Condition)
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
            // ADR-0208 R11 (#5170): lowering adds GetEnumerator, MoveNext and Current calls, and an
            // iterator body runs inside them. Indexed iteration runs no user code.
            if node.IterationKind != ForRangeKind.Indexed {
                MarkMayMutateGlobalRoots()
            }
            VisitExpression(node.Collection)
            VisitPossiblySkippedBody(node.Body)
        }

        protected open override func VisitAwaitForRangeStatement(node BoundAwaitForRangeStatement) {
            MarkMayMutateGlobalRoots()
            VisitExpression(node.Stream)
            VisitPossiblySkippedBody(node.Body)
        }

        protected open override func VisitPatternSwitchStatement(node BoundPatternSwitchStatement) {
            VisitExpression(node.Discriminant)
            let branchStart = CaptureCallableState()
            var joined(
                Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                Unknown HashSet[VariableSymbol],
                External HashSet[VariableSymbol]
            )? = if node.IsExhaustive {
                nil
            } else {
                CloneCallableState(branchStart)
            }
            for arm in node.Arms {
                RestoreCallableState(branchStart)
                VisitPattern(arm.Pattern)
                VisitExpression(arm.Guard)
                VisitStatement(arm.Body)
                if !StatementBinder.EndsInUnconditionalExit(arm.Body, gotoExits: false) {
                    joined = JoinCallableStates(joined, CaptureCallableState())
                }
            }
            RestoreCallableState(joined ?? branchStart)
        }

        protected open override func VisitSwitchExpression(node BoundSwitchExpression) {
            VisitExpression(node.Discriminant)
            let branchStart = CaptureCallableState()
            var dispatchState = CloneCallableState(branchStart)
            var canMiss = true
            var joined(
                Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                Unknown HashSet[VariableSymbol],
                External HashSet[VariableSymbol]
            )? = nil
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

        protected open override func VisitTryStatement(node BoundTryStatement) {
            ContainsTry = true
            let branchStart = CaptureCallableState()
            let outerTryAssignments = tryAssignedVariables
            let assignedInTry = HashSet[VariableSymbol]()
            tryAssignedVariables = assignedInTry
            VisitStatement(node.TryBlock)
            tryAssignedVariables = outerTryAssignments
            outerTryAssignments?.UnionWith(assignedInTry)
            let tryState = CaptureCallableState()
            var exceptionalState = CloneCallableState(branchStart)
            for variable in assignedInTry {
                exceptionalState.Literals.Remove(variable)
                exceptionalState.External.Remove(variable)
                exceptionalState.Unknown.Add(variable)
            }
            // ADR-0208 R10 (#5168): a replacement exception reaches a clause after the filters of
            // all clauses ran, so every handler starts from the state with their effects.
            for clause in node.CatchClauses {
                if clause.Filter != nil {
                    RestoreCallableState(exceptionalState)
                    VisitExpression(clause.Filter)
                    exceptionalState = JoinCallableStates(exceptionalState, CaptureCallableState())
                }
            }
            var finallyEntries = JoinCallableStates(CloneCallableState(tryState), exceptionalState)
            var joined(
                Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                Unknown HashSet[VariableSymbol],
                External HashSet[VariableSymbol]
            )? = if StatementBinder.EndsInUnconditionalExit(node.TryBlock, gotoExits: false) {
                nil
            } else {
                tryState
            }
            for clause in node.CatchClauses {
                RestoreCallableState(exceptionalState)
                VisitExpression(clause.Filter)
                VisitStatement(clause.Body)
                let catchState = CaptureCallableState()
                finallyEntries = JoinCallableStates(finallyEntries, catchState)
                if !StatementBinder.EndsInUnconditionalExit(clause.Body, gotoExits: false) {
                    joined = JoinCallableStates(joined, catchState)
                }
            }
            if node.FinallyBlock != nil {
                RestoreCallableState(finallyEntries)
                VisitStatement(node.FinallyBlock)
            } else {
                RestoreCallableState(joined ?? branchStart)
            }
        }

        // An assignment reached only on some paths (pendingConditionalTargets
        // is non-empty: a conditional goto to a later label is still pending) leaves the other paths with whatever
        // the variable held before. Only a variable already known external
        // stays external; anything else becomes unknown (fail-safe).
        private func MarkExternalAssignment(variable VariableSymbol) {
            if pendingConditionalTargets.Count > 0 && !externalFunctionValues.Contains(variable) {
                unknownFunctionValues.Add(variable)
                return
            }
            externalFunctionValues.Add(variable)
        }

        private func VisitPossiblySkippedBody(body BoundStatement) {
            let entry = CaptureCallableState()
            var previous = entry
            while true {
                RestoreCallableState(previous)
                VisitStatement(body)
                MergeCallableState(previous)
                let joined = CaptureCallableState()
                if CallableStatesEqual(previous, joined) {
                    RestoreCallableState(joined)
                    return
                }
                previous = joined
            }
        }

        private func CaptureCallableState()(
            Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
            Unknown HashSet[VariableSymbol],
            External HashSet[VariableSymbol]
        ) -> (
            functionLiterals.ToDictionary(
                (entry KeyValuePair[VariableSymbol, HashSet[BoundFunctionLiteralExpression]]) -> entry.Key,
                (entry KeyValuePair[VariableSymbol, HashSet[BoundFunctionLiteralExpression]]) -> HashSet[
                    BoundFunctionLiteralExpression
                ](entry.Value)
            ),
            HashSet[VariableSymbol](unknownFunctionValues),
            HashSet[VariableSymbol](externalFunctionValues)
        )

        private func RestoreCallableState(
            state(
                Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                Unknown HashSet[VariableSymbol],
                External HashSet[VariableSymbol]
            )
        ) {
            functionLiterals.Clear()
            unknownFunctionValues.Clear()
            externalFunctionValues.Clear()
            MergeCallableState(state)
        }

        private func MergeCallableState(
            state(
                Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                Unknown HashSet[VariableSymbol],
                External HashSet[VariableSymbol]
            )
        ) {
            for entry in state.Literals {
                if !functionLiterals.TryGetValue(entry.Key, out var literals) {
                    literals = HashSet[BoundFunctionLiteralExpression]()
                    functionLiterals.Add(entry.Key, literals)
                }
                literals.UnionWith(entry.Value)
            }
            unknownFunctionValues.UnionWith(state.Unknown)
            externalFunctionValues.UnionWith(state.External)
        }

        private func IsExternalCallable(expression BoundExpression) bool {
            return UnwrapCallable(expression) is BoundVariableExpression variable &&
                (
                (variable.Variable is ParameterSymbol and {IsReadOnly: true}) || externalFunctionValues.Contains(
                    variable.Variable
                )
            )
        }

        private func IsUnknownCallable(expression BoundExpression) bool -> UnwrapCallable(
            expression
        ) is BoundVariableExpression variable &&
            unknownFunctionValues.Contains(variable.Variable)

        private func AnalyzeCallableInvocation(expression BoundExpression) {
            let callable = UnwrapCallable(expression)
            if callable is BoundFunctionLiteralExpression direct {
                VisitFunctionLiteralBody(direct)
                return
            }
            if callable is not BoundVariableExpression variable {
                MayMutateAnyRoot = true
                return
            }
            callableInvocations.Add(variable.Variable)
            AnalyzeCallableVariable(variable.Variable)
        }

        private func AnalyzeCallableVariable(variable VariableSymbol) {
            if functionLiterals.TryGetValue(variable, out var literals) {
                for literal in literals {
                    VisitFunctionLiteralBody(literal)
                }
            }
            // A read-only callable parameter originates outside this function
            // and cannot capture this function's local slots.
            MayMutateAnyRoot |= unknownFunctionValues.Contains(variable) ||
                (
                !(variable is ParameterSymbol && variable.IsReadOnly == true) && !externalFunctionValues.Contains(
                    variable
                ) &&
                    !functionLiterals.ContainsKey(variable)
            )
            if variable is ParameterSymbol && variable.IsReadOnly == true || externalFunctionValues.Contains(variable) {
                MarkMayMutateGlobalRoots(runsSourceCode: false)
                MayMutateWritableReferenceRoots = true
                MayMutateReferenceStorage = true
            }
        }

        // ADR-0208 R11 (#5170): the loop header runs user code before every body run.
        func MarkIterationRunsUserCode() {
            MarkMayMutateGlobalRoots()
        }

        // [`runsSourceCode`](paramref) is false for a call through a callable value: it keeps its own classification
        // (ADR-0208 row R15).
        private func MarkMayMutateGlobalRoots(writesReferenceStorage bool = true, runsSourceCode bool = true) {
            if runsSourceCode {
                MarkRunsEscapedClosure()
            }
            // User code can also write members and the storage behind by-reference aliases.
            MayMutateMemberPaths = true
            if writesReferenceStorage {
                MayMutateReferenceStorage = true
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

        private func MarkRunsEscapedClosure() {
            MayRunEscapedClosure = true
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

        private func TryGetFunctionLiterals(
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
            if callable is BoundVariableExpression variable && functionLiterals.TryGetValue(
                variable.Variable,
                out var stored
            ) {
                literals = stored
                return true
            }
            literals = nil
            return false
        }

        private func VisitFunctionLiteralBody(literal BoundFunctionLiteralExpression) {
            if literal.Body is not{} body || !visitedFunctionLiterals.Add(literal) {
                return
            }
            try {
                VisitStatement(body)
            } finally {
                visitedFunctionLiterals.Remove(literal)
            }
        }

        protected open override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            if node.Variable != nil {
                // ADR-0208 R12 (#5171): a callable stored through a `ref` alias is stored in every
                // variable that shares its storage, and the callee is unknown.
                if mayShareStorage != nil {
                    for other in functionLiterals
                        .Keys
                        .Concat(externalFunctionValues)
                        .Concat(unknownFunctionValues)
                        .ToArray() {
                        if !object.ReferenceEquals(other, node.Variable) && mayShareStorage!!(node.Variable, other) {
                            functionLiterals.Remove(other)
                            externalFunctionValues.Remove(other)
                            unknownFunctionValues.Add(other)
                        }
                    }
                }
                writableReferenceAliases.Remove(node.Variable)
                tryAssignedVariables?.Add(node.Variable)
                let externalCallable = IsExternalCallable(node.Expression)
                if TryGetFunctionLiterals(node.Expression, out var literals) {
                    if pendingConditionalTargets.Count > 0 && functionLiterals.TryGetValue(
                        node.Variable,
                        out var existing
                    ) {
                        existing.UnionWith(literals!!)
                    } else {
                        functionLiterals[node.Variable] = HashSet[BoundFunctionLiteralExpression](literals!!)
                    }
                    if UnwrapCallable(node.Expression) is BoundVariableExpression source &&
                        unknownFunctionValues.Contains(source.Variable) {
                        unknownFunctionValues.Add(node.Variable)
                    } else if pendingConditionalTargets.Count == 0 {
                        unknownFunctionValues.Remove(node.Variable)
                    }
                    if externalCallable {
                        MarkExternalAssignment(node.Variable)
                    } else if pendingConditionalTargets.Count == 0 {
                        externalFunctionValues.Remove(node.Variable)
                    }
                } else if externalCallable {
                    if pendingConditionalTargets.Count == 0 {
                        functionLiterals.Remove(node.Variable)
                        unknownFunctionValues.Remove(node.Variable)
                    }
                    MarkExternalAssignment(node.Variable)
                } else {
                    if pendingConditionalTargets.Count == 0 {
                        functionLiterals.Remove(node.Variable)
                        externalFunctionValues.Remove(node.Variable)
                    }
                    unknownFunctionValues.Add(node.Variable)
                }
                Roots.Add(node.Variable)
                if !assignments.TryGetValue(node.Variable, out var rootAssignments) {
                    rootAssignments = List[BoundAssignmentExpression]()
                    assignments.Add(node.Variable, rootAssignments)
                }
                rootAssignments.Add(node)
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
        }

        protected open override func VisitAddressOfExpression(node BoundAddressOfExpression) {
            if !node.IsReadOnly {
                RecordWritableReference(node.Operand)
            }
            base.VisitAddressOfExpression(node)
        }

        private func RecordWritableReference(expression BoundExpression) {
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
                return
            }
            if expression is BoundConditionalAddressExpression conditional {
                RecordWritableReference(conditional.WhenTrueOperand)
                RecordWritableReference(conditional.WhenFalseOperand)
                return
            }
            if !SmartCastStability.TryGetStableMemberPath(expression, out var path, out _) {
                if expression is BoundIndexExpression || expression is BoundClrIndexExpression {
                    MayMutateMemberPaths = true
                    MayMutateReferenceStorage = true
                } else {
                    MayMutateAnyRoot = true
                    MayMutateAnyRootViaPointer = true
                }
                return
            }
            if path.HasMembers {
                MayMutateMemberPaths = true
                MayMutateReferenceStorage = true
            } else {
                Roots.Add(path.Root)
            }
        }

        protected open override func VisitFieldAssignmentExpression(node BoundFieldAssignmentExpression) {
            if node.ReceiverExpression == nil {
                assignedFields.Add(AssignedField(node.Receiver, node.Field))
            }
            base.VisitFieldAssignmentExpression(node)
        }

        protected open override func VisitPropertyAssignmentExpression(node BoundPropertyAssignmentExpression) {
            let receiver VariableSymbol? = (node.Receiver as BoundVariableExpression)?.Variable
            if node.Receiver == nil || receiver != nil {
                assignedProperties.Add(AssignedProperty(receiver, node.Property))
            }
            base.VisitPropertyAssignmentExpression(node)
        }

        private data struct AssignedField(Receiver VariableSymbol?, Field FieldSymbol) : IEquatable[AssignedField] { }

        private data struct AssignedProperty(Receiver VariableSymbol?, Property PropertySymbol) : IEquatable[
            AssignedProperty
        ] { }

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
                left(
                    Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                    Unknown HashSet[VariableSymbol],
                    External HashSet[VariableSymbol]
                ),
                right(
                    Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                    Unknown HashSet[VariableSymbol],
                    External HashSet[VariableSymbol]
                )
            ) bool {
                return left.Unknown.SetEquals(right.Unknown) && left.External.SetEquals(right.External) &&
                    left
                    .Literals
                    .Count == right
                    .Literals
                    .Count &&
                    left
                    .Literals
                    .All(
                    (entry KeyValuePair[VariableSymbol, HashSet[BoundFunctionLiteralExpression]]) -> right
                        .Literals
                        .TryGetValue(entry.Key, out var literals) && entry.Value.SetEquals(literals)
                )
            }

            private func CloneCallableState(
                state(
                    Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                    Unknown HashSet[VariableSymbol],
                    External HashSet[VariableSymbol]
                )
            )(
                Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                Unknown HashSet[VariableSymbol],
                External HashSet[VariableSymbol]
            ) -> (
                state.Literals.ToDictionary(
                    (entry KeyValuePair[VariableSymbol, HashSet[BoundFunctionLiteralExpression]]) -> entry.Key,
                    (entry KeyValuePair[VariableSymbol, HashSet[BoundFunctionLiteralExpression]]) -> HashSet[
                        BoundFunctionLiteralExpression
                    ](entry.Value)
                ),
                HashSet[VariableSymbol](state.Unknown),
                HashSet[VariableSymbol](state.External)
            )

            private func JoinCallableStates(
                left(
                    Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                    Unknown HashSet[VariableSymbol],
                    External HashSet[VariableSymbol]
                )?,
                right(
                    Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                    Unknown HashSet[VariableSymbol],
                    External HashSet[VariableSymbol]
                )
            )(
                Literals Dictionary[VariableSymbol, HashSet[BoundFunctionLiteralExpression]],
                Unknown HashSet[VariableSymbol],
                External HashSet[VariableSymbol]
            ) {
                if left == nil {
                    return right
                }
                let variables = left
                    .Literals
                    .Keys
                    .Concat(left.Unknown)
                    .Concat(left.External)
                    .Concat(right.Literals.Keys)
                    .Concat(right.Unknown)
                    .Concat(right.External)
                    .ToHashSet()
                for variable in variables {
                    let hasLeft = left.Literals.ContainsKey(variable) || left.Unknown.Contains(variable) ||
                        left
                        .External
                        .Contains(variable)
                    let hasRight = right.Literals.ContainsKey(variable) || right.Unknown.Contains(variable) ||
                        right
                        .External
                        .Contains(variable)
                    if !hasLeft || !hasRight {
                        left.Unknown.Add(variable)
                    }
                }
                for entry in right.Literals {
                    if !left.Literals.TryGetValue(entry.Key, out var literals) {
                        literals = HashSet[BoundFunctionLiteralExpression]()
                        left.Literals.Add(entry.Key, literals)
                    }
                    literals.UnionWith(entry.Value)
                }
                left.Unknown.UnionWith(right.Unknown)
                left.External.UnionWith(right.External)
                return left
            }

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

    private class LoopBackEdgeMutationCollector : AssignedRootsCollector {
        init(
            assignmentPreservesNarrowing(BoundAssignmentExpression, TypeSymbol) -> bool,
            mayShareStorage(VariableSymbol, VariableSymbol) -> bool
        ) : base(assignmentPreservesNarrowing, nil, mayShareStorage) { }
    }

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
                return HasInternallyReachableFallthrough(ifStatement.ThenStatement) ||
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
                return switchStatement.Arms.Any(
                    (arm BoundPatternSwitchArm) -> HasInternallyReachableFallthrough(arm.Body)
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
                return false
            }
        }
    }

    /// Issue #3501 A2: when the literal declares at least one
    /// `ref`/`out`/`in` parameter, returns the synthesized
    /// delegate type backing its shape (Func/Action cannot carry by-ref type
    /// arguments); `null` for a by-value-only literal, which
    /// keeps its (cref:FunctionTypeSymbol) natural type.
    private func SynthesizeRefDelegateForLiteral(function FunctionSymbol, functionType FunctionTypeSymbol) TypeSymbol? {
        if !function.Parameters.Any((p ParameterSymbol) -> p.RefKind != RefKind.None) {
            return nil
        }
        return $scope.GetSynthesizedRefDelegateCache().GetOrCreate(
            function.Parameters,
            functionType.ReturnType,
            $scope.GetCurrentDeclaringPackageName()
        )
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
            // ADR-0055 Tier 4: an interpolated-string initializer whose declared
            // type is IFormattable/FormattableString lowers to
            // FormattableStringFactory.Create rather than an eager string.
            if type != nil &&
                syntax.Initializer is InterpolatedStringExpressionSyntax interpolatedInit &&
                isFormattableStringTargetType(type) {
                variableType = type
                convertedInitializer = bindInterpolatedStringAsFormattable(interpolatedInit, type)
            } else if type != nil &&
                syntax.Initializer is LambdaExpressionSyntax targetTypedLambda &&
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
                let lambda = bindLambdaWithTargetType!!(targetTypedLambda, targetFnType!!)
                convertedInitializer = conversions.BindConversion(syntax.Initializer!!.Location, lambda, variableType)
            } else if type is PointerTypeSymbol && syntax.Initializer is StackAllocExpressionSyntax {
                // ADR-0124 / issue #1024: `var p *T = stackalloc [n]T` inside
                // an unsafe context yields the raw `T*` pointer. The target
                // pointer type must be threaded into the stackalloc binder so
                // it selects the pointer form rather than the default Span<T>.
                variableType = type
                convertedInitializer = bindExpressionWithTargetType(syntax.Initializer, type)
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
            } else if type != nil &&
                (
                syntax.Initializer is IfExpressionSyntax ||
                    syntax.Initializer is IfLetExpressionSyntax ||
                    syntax.Initializer is ConditionalExpressionSyntax ||
                    syntax.Initializer is SwitchExpressionSyntax ||
                    syntax.Initializer is BlockExpressionSyntax ||
                    IsNullCoalescingExpression(syntax.Initializer)
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
                            preDeclaredSelf = bindLocalVariableWithAccessibility(
                                syntax.Identifier,
                                isReadOnly,
                                selfType,
                                accessibility
                            )
                        }
                    )
                } else {
                    initializer = bindExpression(syntax.Initializer!!, false)
                }
                variableType = type ?? preDeclaredSelf?.Type ?? initializer.Type
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
                } else if syntax.TypeClause == nil && ContainsNever(variableType) {
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
        variable!!.CallableParameterNames = GetCallableParameterNames(convertedInitializer!!)
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
        if TypeSymbol.IsByRefLike(variableType) {
            if function == nil || function!!.IsTopLevelEntryPoint {
                Diagnostics.ReportByRefLikeEscape(
                    syntax.Identifier.Location,
                    variableType,
                    "be declared as a top-level variable (it would be emitted as a heap-rooted static field)"
                )
            } else if !function!!.IsAsync && isIteratorReturnType(function!!.Type) {
                Diagnostics.ReportByRefLikeEscape(
                    syntax.Identifier.Location,
                    variableType,
                    "be declared as a local in an iterator (it would be hoisted into the state machine)"
                )
            }
        }
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
        if convertedInitializer is {} callableInitializer && IsExternalCallableSource(callableInitializer) {
            externalCallableAliases.Add(declaredVariable)
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
            } else if ConstantExpressionEvaluator.TryFold(convertedInitializer, declaredVariable.Type, out constValue) {
                if declaredVariable is GlobalVariableSymbol global {
                    global.SetConstantValue(constValue)
                } else if declaredVariable is LocalVariableSymbol constLocal {
                    constLocal.IsConst = true
                }
            } else if declaredVariable is GlobalVariableSymbol && !(convertedInitializer is BoundErrorExpression) {
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
        // Pointee type: the user may write an explicit type clause that must match
        // the initializer's static type; otherwise infer from the initializer.
        let pointeeType = initializer.Type ?? TypeSymbol.Error
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
        // ADR-0186 §4/§5, issue #4325: deconstruction reads members out of
        // the source, so the source is a receiver and gets the same check and
        // unwrap every other receiver position gets. The unwrap is the half
        // that matters for binding: the dispatch below switches on
        // `initializer.Type is TupleTypeSymbol` / `is StructSymbol` and then
        // probes for an imported `Deconstruct`, none of which a platform
        // wrapper matches.
        initializer = binderCtx.InsertPlatformCheck(initializer, syntax.Initializer.Location, "a deconstruction source")
        if initializer.Type is TupleTypeSymbol tupleType {
            if syntax.Identifiers.Count != tupleType.Arity {
                Diagnostics.ReportDeconstructionFieldCountMismatch(
                    syntax.CloseParenToken.Location,
                    tupleType.Arity,
                    syntax.Identifiers.Count
                )
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
            let (tempVar, elements) = CreateTupleDeconstructionPlan(syntax, tupleType)
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            statements.Add(BoundVariableDeclaration(syntax, tempVar, initializer))
            for var i = 0; i < syntax.Identifiers.Count; i++ {
                let idTok = syntax.Identifiers[i]
                if IsDiscard(idTok) {
                    continue
                }
                let elemType = tupleType.ElementTypes[i]
                let elemVar = bindLocalVariable(idTok, isReadOnly, elemType)
                statements.Add(BoundVariableDeclaration(syntax, elemVar, elements[i]))
            }
            return BoundBlockStatement(syntax, statements.ToImmutable())
        }
        if initializer.Type is StructSymbol structType && (structType.IsData || structType.IsInline) {
            let members = if structType.IsData {
                TypeMemberModel.GetDataDeconstructionMembers(structType)
            } else {
                structType.Fields.Cast[Symbol]().ToImmutableArray()
            }
            if syntax.Identifiers.Count != members.Length {
                Diagnostics.ReportDeconstructionFieldCountMismatch(
                    syntax.CloseParenToken.Location,
                    members.Length,
                    syntax.Identifiers.Count
                )
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
            let tempName = "<data${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
            let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, structType)
            $scope.TryDeclareVariable(tempVar)
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            statements.Add(BoundVariableDeclaration(syntax, tempVar, initializer))
            for var i = 0; i < syntax.Identifiers.Count; i++ {
                let idTok = syntax.Identifiers[i]
                if IsDiscard(idTok) {
                    continue
                }
                let member = members[i]
                let elemVar = bindLocalVariable(idTok, isReadOnly, GetDeconstructionMemberType(member))
                let access = BindDeconstructionMemberAccess(BoundVariableExpression(nil, tempVar), structType, member)
                statements.Add(BoundVariableDeclaration(syntax, elemVar, access))
            }
            return BoundBlockStatement(syntax, statements.ToImmutable())
        }
        if TryBindImportedDeconstruct(
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
                // LanguageServer fix: carry the real declaring identifier
                // token as this declaration's Syntax (instead of null) so
                // SemanticLookup.MatchBoundLocals's exact-reference match
                // finds THIS declaration instead of falling back to a
                // same-named symbol from an unrelated enclosing scope.
                statements.Add(BoundVariableDeclaration(identifiers[i], elemVar, access))
            }
            return statements.ToImmutable()
        }
        if elementType is StructSymbol structType && (structType.IsData || structType.IsInline) {
            let members = if structType.IsData {
                TypeMemberModel.GetDataDeconstructionMembers(structType)
            } else {
                structType.Fields.Cast[Symbol]().ToImmutableArray()
            }
            if identifiers.Count != members.Length {
                Diagnostics.ReportDeconstructionFieldCountMismatch(
                    closeParenLocation,
                    members.Length,
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
                let member = members[i]
                let elemVar = bindLocalVariable(identifiers[i], true, GetDeconstructionMemberType(member))
                let access = BindDeconstructionMemberAccess(elementAccessBase, structType, member)
                // LanguageServer fix: see the matching comment in the tuple
                // branch above.
                statements.Add(BoundVariableDeclaration(identifiers[i], elemVar, access))
            }
            return statements.ToImmutable()
        }
        if TryBindImportedDeconstruct(
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

    private func TryBindImportedDeconstruct(
        receiver BoundExpression,
        identifiers GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[SyntaxToken],
        location TextLocation,
        isReadOnly bool,
        out statements ImmutableArray[BoundStatement]
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
            receiverClrType,
            "Deconstruct",
            includeExtensions: true
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
                let temp = LocalVariableSymbol(
                    "<deconstruct${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>",
                    isReadOnly: false,
                    elementType
                )
                $scope.TryDeclareVariable(temp)
                arguments.Add(BoundAddressOfExpression(nil, BoundVariableExpression(nil, temp)))
                refKinds.Add(RefKind.Out)
                if !IsDiscard(identifiers[i]) {
                    let variable = bindLocalVariable(identifiers[i], isReadOnly, elementType)
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
        // ADR-0186 §4/§5: named deconstruction reads each field off the
        // initializer, so a platform `DPt!` is used as non-null here, exactly
        // like the positional form's source (see the check in
        // BindTupleDeconstructionStatement). The same call unwraps the value, which
        // the symbol-kind test below needs: a platform wrapper is not a
        // StructSymbol, so `let { X = x } = obliviousCall()` reported GS0164
        // where `DPt` compiled.
        initializer = binderCtx.InsertPlatformCheck(initializer, syntax.Initializer.Location, "a deconstruction source")
        if !(initializer.Type is StructSymbol structType) || (!structType.IsData && !structType.IsInline) {
            Diagnostics.ReportDeconstructionRequiresTupleOrDataStruct(syntax.OpenBraceToken.Location, initializer.Type)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        let tempName = "<data${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, structType)
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
                structType,
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
            let variable = bindLocalVariable(fieldSyntax.LocalIdentifier, true, field.Type)
            let access = BoundFieldAccessExpression(nil, BoundVariableExpression(nil, tempVar), declaringType, field)
            statements.Add(BoundVariableDeclaration(syntax, variable, access))
        }
        return BoundBlockStatement(syntax, statements.ToImmutable())
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
                MemberFieldAssignmentExpressionSyntax,
                MemberIndexAssignmentExpressionSyntax,
                IndexAssignmentExpressionSyntax,
                CompoundIndexAssignmentExpressionSyntax,
                IndirectAssignmentExpressionSyntax,
                IndirectCompoundAssignmentExpressionSyntax,
                FieldAssignmentExpressionSyntax {
                    mayMutateMemberPaths = true
                }
                case a is AssignmentExpressionSyntax {
                    assigned.Add(a.IdentifierToken.ValueText)
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

        private func IsRepresentationPreservingJoin(source TypeSymbol, target TypeSymbol) bool {
            return Conversion.IsRepresentationPreservingImplicit(source, target)
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
                assignedType is NullableTypeSymbol {
                return false
            }
            let conversion = Conversion.Classify(assignedType, narrowedType)
            return conversion.Exists && conversion.IsImplicit
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

        private func RemoveByRoots(state Dictionary[AccessPath, TypeSymbol], roots HashSet[VariableSymbol]) {
            var toRemove List[AccessPath]? = nil
            for key in state.Keys {
                if roots.Contains(key.Root) {
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
        private func ComputeClosureAssignedNames(anchor SyntaxNode) HashSet[string]? {
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
            CollectAddressTakenNames(root, names)
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
        // collected: the call itself is analyzed for the write.
        private func CollectAddressTakenNames(node SyntaxNode, names HashSet[string]) {
            switch node {
                case UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.AmpersandToken}} addressOf when !(
                    addressOf.Parent is CallExpressionSyntax
                ) {
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
                CollectAddressTakenNames(child, names)
            }
        }

        private func CollectAllNames(node SyntaxNode, names HashSet[string]) {
            if node is NameExpressionSyntax name {
                names.Add(name.IdentifierToken.ValueText)
            }
            for child in node.GetChildren() {
                CollectAllNames(child, names)
            }
        }

        /// ADR-0208 R12 (#5171): the plain variable that the `ref` local
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
        /// it aliases through plain `ref` local initializers.
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
        /// not a plain variable. A member, index or indirect write and any call
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
                current = if current is NullableTypeSymbol nullable {
                    nullable.UnderlyingType
                } else {
                    (current as PlatformTypeSymbol)!!.UnderlyingType
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

        /// ADR-0208 R14 and R16 (#5231): whether [`node`](paramref) reads an imported (CLR) property whose getter
        /// can run user code. Such a read is a `call`: the one definition for the straight-line pass, the loop
        /// collector and the `finally` summaries. A field is no getter. A property is stable (it runs no user
        /// code) only when (cref:IsStableClrGetter) says so; an unlisted property is a call.
        internal func ClrPropertyReadRunsUserCode(
            node BoundExpression
        ) bool -> node is BoundClrPropertyAccessExpression{Member: var member} &&
            ClrMemberReadRunsUserCode(member)

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
                (element BoundPattern) -> element is not(BoundSlicePattern or BoundDiscardPattern{Variable: nil})
            )
        )

        /// ADR-0208 R19 (#5593): whether the test of a constant pattern can run user code. Only an `ObjectEquals`
        /// test (cref:BoundConstantPattern.ClassifyTest) can: `object.Equals(object, object)` calls the virtual
        /// `Equals` of the input when both values are not null. An `object` input can hold any type, so its `Equals`
        /// can be a user override, even for a literal pattern value. A `nil` value (a conversion of the literal, or
        /// the default of the input type) never reaches it. A nullable value input holds its underlying type,
        /// whose `Equals` runs no user code only for a primitive, an enum or `decimal`.
        internal func ConstantPatternRunsUserCode(node BoundConstantPattern) bool {
            if BoundConstantPattern.ClassifyTest(node.Type, node.Value) != ConstantPatternTestKind.ObjectEquals {
                return false
            }
            let value = BoundConstantPattern.UnwrapInputConversion(node.Type, node.Value)
            if value is BoundLiteralExpression{Value: nil} ||
                (value is BoundDefaultExpression && value.Type == node.Type) {
                return false
            }
            if node.Type is not NullableTypeSymbol nullable {
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
                }
                case BoundNodeKind.FieldAssignmentExpression:
                if node is BoundFieldAssignmentExpression{
                    Field: {IsStatic: true, IsConst: false},
                    StructType: {} fieldOwner
                } {
                    owner = fieldOwner
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

        /// ADR-0208 R11 (#5170), R15 (#5237) and #5483: the one definition of whether constructing
        /// [`type`](paramref) can run user code. The type, the generic definition of a constructed type, and
        /// every base class are checked for
        ///
        /// | member                                              | runs at construction |
        /// | --------------------------------------------------- | -------------------- |
        /// | instance field initializer                          | yes                  |
        /// | primary constructor                                 | yes                  |
        /// | explicit constructor                                | yes                  |
        /// | the type initializer (see (cref:TypeInitializationRunsUserCode)) | per that table |
        /// | none of the above                                   | no                   |
        internal func ConstructionRunsUserCode(type StructSymbol) bool {
            var current StructSymbol? = type
            for var depth = 0; current != nil && depth < 64; depth++ {
                let definition = current.Definition ?? current
                if !definition
                    .InstanceFieldInitializers
                    .IsEmpty ||
                    definition.HasPrimaryConstructor ||
                    !definition
                    .EffectiveExplicitConstructors
                    .IsDefaultOrEmpty ||
                    TypeInitializationRunsUserCode(definition, atStaticMemberAccess: false) {
                    return true
                }
                current = definition.BaseClass
            }
            return false
        }

        /// ADR-0208 R12 (#5171, #5292, amendment A3): whether the effects of a node invalidate the narrowing of
        /// [`path`](paramref). A member-bearing path drops when the node may run user code or write a member
        /// (`mayMutateMemberPaths`). A root that may name storage no other root names drops when the node
        /// writes through a member, index or indirect target (`mayMutateReferenceStorage`), and a `ref` local
        /// that does not alias a by-reference parameter also drops on any call (see
        /// (cref:CallsMayWriteAliasedStorage)). A plain call does not drop the narrowing of a by-reference
        /// parameter, as in 0.5.212 and in C#.
        internal func DropsOnMemberMutation(
            path AccessPath,
            mayMutateMemberPaths bool,
            mayMutateReferenceStorage bool
        ) bool -> (path.HasMembers && mayMutateMemberPaths) ||
            (
            IsExternalStorageAlias(path.Root) &&
                (mayMutateReferenceStorage || (mayMutateMemberPaths && CallsMayWriteAliasedStorage(path.Root)))
        )

        internal func DropsOnMemberMutation(
            path AccessPath,
            mutations AssignedRootsCollector
        ) bool -> DropsOnMemberMutation(path, mutations.MayMutateMemberPaths, mutations.MayMutateReferenceStorage)

        /// ADR-0208 R12 (#5292): whether a call can write the storage that the external-storage alias
        /// [`root`](paramref) names. A by-reference parameter (or a `ref` local that aliases one) names
        /// storage that the caller owns and the callee cannot name; any other alias (a `ref` local of an
        /// element or member, or of a mutable global) can be reached through the shared heap or global.
        internal func CallsMayWriteAliasedStorage(root VariableSymbol) bool {
            let chain = AliasChain(root)
            return !(chain[chain.Count - 1] is ParameterSymbol)
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

        /// Issue #4965 (ADR-0202): whether [`type`](paramref) is, or is a tuple
        /// with an element that is, the bottom type — the inferred type of an
        /// initializer that never produces a value (`throw e`,
        /// `(if c { return 1 } else { return 2 }, 0)`). Such a type cannot be
        /// a local's type: `never` has no CLR form.
        /// @param type The inferred type.
        /// @returns `true` when the type contains `never`.
        internal func ContainsNever(type TypeSymbol?) bool {
            if type == TypeSymbol.Never {
                return true
            }
            if type is TupleTypeSymbol tuple {
                for element in tuple.ElementTypes {
                    if ContainsNever(element) {
                        return true
                    }
                }
            }
            return false
        }

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

        /// ADR-0069 / issue #700: structurally determine whether the given
        /// bound statement unconditionally transfers control out of its
        /// enclosing block (return / throw / unconditional goto, which covers
        /// the lowered shapes of `break` and `continue`). A block
        /// counts when its last statement does any of those; an
        /// (cref:BoundIfStatement) counts only if both arms do; a
        /// (cref:BoundTryStatement) counts when its `finally` exits or
        /// its protected block and every handler exit.
        /// @param statement The statement to classify.
        /// @param gotoExits When `false`, a goto is not counted as an exit, so only
        /// return/throw do. Callable-alias joins use this because a goto can still
        /// reach code after the enclosing construct.
        /// @returns `true` when the statement always leaves its block.
        internal func EndsInUnconditionalExit(statement BoundStatement?, gotoExits bool = true) bool {
            switch statement {
                case nil {
                    return false
                }
                case BoundReturnStatement, BoundThrowStatement, BoundRethrowStatement {
                    return true
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
            externalAliases IReadOnlyCollection[VariableSymbol]
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
                (variable.Variable is ParameterSymbol and {IsReadOnly: true}) || externalAliases.Contains(
                    variable.Variable
                )
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

        private func GetCallableParameterNames(initializer BoundExpression) ImmutableArray[string] {
            var initializer = initializer
            while initializer is BoundConversionExpression conversion {
                initializer = conversion.Expression
            }
            let parameters = switch initializer {
                case literal is BoundFunctionLiteralExpression: literal.Function.Parameters
                case pointer is BoundFunctionPointerFromMethodExpression: pointer.Method.Parameters
                default: default(ImmutableArray[ParameterSymbol])
            }
            if parameters.IsDefaultOrEmpty {
                return default(ImmutableArray[string])
            }
            let names = ImmutableArray.CreateBuilder[string](parameters.Length)
            for parameter in parameters {
                names.Add(parameter.Name)
            }
            return names.MoveToImmutable()
        }

        private func GetDeconstructionMemberType(member Symbol) TypeSymbol -> switch member {
            case field is FieldSymbol: field.Type
            case property is PropertySymbol: property.Type
            default: TypeSymbol.Error
        }

        private func BindDeconstructionMemberAccess(
            receiver BoundExpression,
            type StructSymbol,
            member Symbol
        ) BoundExpression -> switch member {
            case field is FieldSymbol: cast[BoundExpression](BoundFieldAccessExpression(nil, receiver, type, field))
            case property is PropertySymbol: cast[BoundExpression](
                BoundPropertyAccessExpression(nil, receiver, type, property)
            )
            default: cast[BoundExpression](BoundErrorExpression(nil))
        }
    }
}
