// <copyright file="StatementBinder.NarrowingExits.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Linq

/// ADR-0208 section 19, PR 2: joins of normal statement exit states.
/// @remarks The binder records the state at the end of each statement list. An
/// `if` joins the exit states of its branches with (cref:NarrowingState.Join),
/// and a bare block exits with the state at the end of its list. An `else if`
/// adds the exit states of its own branches to the list of the enclosing `if`,
/// so the join stays n-ary. The enclosing list then lifts every fact that the
/// join proves. Writes on an exiting path do not reach the join.
internal partial class StatementBinder {
    // The statement that owns the recorded exit and its predecessors, in source order.
    private var exitOwner BoundStatement? = nil
    private var exitPredecessors List[NarrowingState] = List[NarrowingState]()
    // The state at the end of the statement list that was bound last.
    private var listExitState NarrowingState = NarrowingState.Empty

    /// Records the state at the end of a statement list. `BindBlockStatements`
    /// calls it before it pops the frame that holds the lifts of the list.
    private func NoteListExit(completedCleanupExit NarrowingState?) {
        listExitState = completedCleanupExit ?? binderCtx.Narrowing
    }

    /// Records the exit state of a block that [`BindBlockStatement`](paramref) bound.
    private func RecordBlockExit(block BoundBlockStatement) {
        exitOwner = block
        exitPredecessors = List[NarrowingState]{listExitState}
    }

    /// Adds the states that flow out of a branch to [`exits`](paramref). A branch
    /// that cannot complete adds the unreachable state. A branch with no recorded
    /// exit adds the state with no fact. Call it right after the branch is bound.
    private func AddBranchExits(exits List[NarrowingState], branch BoundStatement) {
        if !CanCompleteNormally(branch) {
            exits.Add(NarrowingState.Unreachable)
        } else if object.ReferenceEquals(exitOwner, branch) {
            let conditional = JoinedConditional(branch)
            var heldWidenings = NarrowingState.Empty
            for path in binderCtx.Narrowing.Paths {
                let type = binderCtx.Narrowing.NarrowedType(path)!!
                if IsNullableWidening(path, type) {
                    heldWidenings = heldWidenings.With(path, type)
                }
            }
            for state in exitPredecessors {
                exits.Add(
                    if conditional == nil {
                        state
                    } else {
                        RestrictConditionalExit(state, conditional, externalCallableAliases, heldWidenings)
                    }
                )
            }
        } else {
            exits.Add(NarrowingState.Empty)
        }
    }

    /// The state of the path that skips an `if` with no `else`.
    private func SkippedBranchExit(
        entry NarrowingState,
        elseNarrow Dictionary[AccessPath, TypeSymbol]?
    ) NarrowingState {
        if elseNarrow == nil {
            return entry
        }
        return RefineConditionEntry(entry, elseNarrow)
    }

    private func RefineConditionEntry(
        entry NarrowingState,
        facts IReadOnlyDictionary[AccessPath, TypeSymbol]
    ) NarrowingState {
        var result = entry
        for fact in facts {
            let held = result.NarrowedType(fact.Key)
            // Condition effects already removed stale facts. A weaker proof cannot replace a surviving refinement.
            if IsNullableWidening(fact.Key, fact.Value) || held == nil || !IsWeakerOrEqual(held, fact.Value) {
                result = result.With(fact.Key, fact.Value)
            }
        }
        return result
    }

    private func PushConditionNarrowingFrame(facts Dictionary[AccessPath, TypeSymbol]) {
        let entry = RefineConditionEntry(binderCtx.Narrowing, facts)
        let refined = Dictionary[AccessPath, TypeSymbol]()
        for fact in facts {
            refined[fact.Key] = entry.NarrowedType(fact.Key)!!
        }
        binderCtx.PushNarrowingFrame(refined)
    }

    private func IntersectBranchEntry(state NarrowingState) {
        for frame in binderCtx.NarrowedVariables {
            for entry in frame.ToArray() {
                let joined = state.NarrowedType(entry.Key)
                // Keep weaker enclosing facts. A refinement belongs to the branch's own frame.
                if joined == nil || !IsWeakerOrEqual(joined, entry.Value) {
                    conditionKillJournal?.Add((frame, entry.Key, entry.Value))
                    frame.Remove(entry.Key)
                }
            }
        }
    }

    private func KillExitEffects(
        state NarrowingState,
        statement BoundStatement,
        aliases IReadOnlyCollection[VariableSymbol],
        anchor SyntaxNode? = nil
    ) NarrowingState {
        var state = state
        let effects = GetStatementEffects(statement, aliases)
        let syntax = anchor ?? statement.Syntax
        let filters = if syntax == nil {
            default(List[(TryBlock SyntaxNode?, Names HashSet[string])]?)
        } else {
            EnclosingFilterWrites(syntax, effects)
        }
        for path in state.Paths {
            if StatementKillsPath(effects, path, effects.MayMutateMemberPaths, effects.MayWriteStorageOf(path)) ||
                (filters != nil && (FilterWritesVariable(filters, path.Root) || MayBeMutatedByUnknownCallable(path))) {
                let type = state.NarrowedType(path)!!
                if !IsNullableWidening(path, type) || StatementDischargesNullableWidening(statement, path, type) {
                    state = state.Remove(path)
                }
            }
        }
        return state
    }

    /// Records all normal predecessors of a statement's exit.
    private func RecordJoinExits(statement BoundStatement, exits List[NarrowingState]) {
        exitOwner = statement
        exitPredecessors = exits
    }

    private func RecordFallbackExit(
        statement BoundStatement,
        aliases IReadOnlyCollection[VariableSymbol],
        syntax SyntaxNode
    ) {
        if object.ReferenceEquals(exitOwner, statement) {
            return
        }
        // Labels inside expressions can join new predecessors while the statement binds.
        var exit = KillExitEffects(binderCtx.Narrowing, statement, aliases, syntax)
        let postconditions = NarrowingFrame()
        ApplyMemberNotNullNarrowings(statement, postconditions)
        exit = exit.WithAll(postconditions.Entries)
        if statement is BoundExpressionStatement{Expression: BoundAssignmentExpression assignment} &&
            TryClassifyNonNullAssignment(assignment, out var variable, out var type) {
            exit = exit.With(AccessPath.ForVariable(variable!!), type!!)
        }
        if statement is BoundExpressionStatement expressionStatement &&
            TryClassifyNestedAssignmentNarrowings(expressionStatement.Expression, aliases) is {} assignments {
            exit = exit.WithAll(assignments)
        }
        if loopExitFacts.TryGetValue(syntax, out var loopFacts) {
            exit = exit.WithAll(loopFacts)
        }
        RecordJoinExits(statement, List[NarrowingState]{exit})
    }

    private func JoinedConditional(statement BoundStatement) BoundIfStatement? {
        var statement = statement
        while statement is BoundBlockStatement labeled &&
            labeled.Syntax is LabeledStatementSyntax &&
            labeled
            .Statements
            .Length == 2 &&
            labeled.Statements[0] is BoundLabelStatement {
            statement = labeled.Statements[1]
        }
        if statement is BoundIfStatement conditional {
            return conditional
        }
        if statement is BoundBlockStatement initialized &&
            initialized.Syntax is IfStatementSyntax &&
            initialized
            .Statements
            .Length == 2 {
            return initialized.Statements[1] as BoundIfStatement
        }
        return nil
    }

    private func RestrictConditionalExit(
        state NarrowingState,
        conditional BoundIfStatement,
        aliases IReadOnlyCollection[VariableSymbol],
        heldState NarrowingState
    ) NarrowingState {
        var state = state
        var effects AssignedRootsCollector? = nil
        for path in state.Paths {
            let held = heldState.NarrowedType(path)
            let joined = state.NarrowedType(path)!!
            if (held == nil || !IsWeakerOrEqual(held, joined)) &&
                (IsByReferenceRoot(path.Root) || IsExternalStorageAlias(path.Root)) {
                if effects == nil {
                    effects = NewCollector(nil, aliases)
                    effects.VisitExpression(conditional.Condition)
                }
                let syntaxMutates = conditional.Condition.Syntax is {} syntax && SyntaxMayMutateMemberPaths(syntax)
                if StatementKillsPath(
                    effects,
                    path,
                    syntaxMutates || effects.MayMutateMemberPaths,
                    syntaxMutates || effects.MayWriteStorageOf(path)
                ) {
                    state = if held == nil {
                        state.Remove(path)
                    } else {
                        state.With(path, held)
                    }
                }
            }
        }
        return state
    }

    /// Lifts the facts that the exit state of [`statement`](paramref) proves into
    /// [`persistentFrame`](paramref). Every lift goes through
    /// (cref:SetPersistentNarrowing), like the other lifts.
    private func ApplyJoinExitNarrowings(
        statement BoundStatement?,
        persistentFrame NarrowingFrame,
        aliasesAtEntry IReadOnlyCollection[VariableSymbol]
    ) {
        var statement = statement
        while statement is BoundBlockStatement labeledBlock && !object.ReferenceEquals(exitOwner, statement) &&
            labeledBlock.Syntax is LabeledStatementSyntax &&
            labeledBlock
            .Statements
            .Length == 2 &&
            labeledBlock.Statements[0] is BoundLabelStatement {
            statement = labeledBlock.Statements[1]
        }
        if statement == nil || !object.ReferenceEquals(exitOwner, statement) {
            return
        }
        var exit = NarrowingState.Join(exitPredecessors)
        exitOwner = nil
        if exit.IsUnreachable || !CanCompleteNormally(statement) {
            return
        }
        let conditional = JoinedConditional(statement)
        if conditional != nil {
            exit = RestrictConditionalExit(exit, conditional, aliasesAtEntry, binderCtx.Narrowing)
        }
        IntersectBranchEntry(exit)
        let surviving = binderCtx.Narrowing
        for path in exit.Paths {
            let joined = exit.NarrowedType(path)
            if joined != nil && !object.Equals(surviving.NarrowedType(path), joined) {
                SetPersistentNarrowing(persistentFrame, path, joined)
            }
        }
    }

    private func IsWeakerOrEqual(held TypeSymbol, joined TypeSymbol) bool -> NarrowingState.IsNoStrongerThan(
        joined,
        held
    )
}
