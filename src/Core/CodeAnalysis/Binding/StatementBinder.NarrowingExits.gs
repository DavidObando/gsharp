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
            exits.AddRange(exitPredecessors)
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
        return entry.WithAll(elseNarrow)
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
            if StatementKillsPath(effects, path, effects.MayMutateMemberPaths, effects.MayMutateReferenceStorage) ||
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

    /// Lifts the facts that the exit state of [`statement`](paramref) proves into
    /// [`persistentFrame`](paramref). Every lift goes through
    /// (cref:SetPersistentNarrowing), like the other lifts.
    private func ApplyJoinExitNarrowings(
        statement BoundStatement?,
        persistentFrame NarrowingFrame,
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
        if statement == nil || !object.ReferenceEquals(exitOwner, statement) {
            return
        }
        var exit = NarrowingState.Join(exitPredecessors)
        exitOwner = nil
        if exit.IsUnreachable || !CanCompleteNormally(statement) {
            return
        }
        var conditionEffects AssignedRootsCollector? = nil
        var conditional = statement as BoundIfStatement
        if conditional == nil &&
            statement is BoundBlockStatement initialized &&
            initialized.Syntax is IfStatementSyntax &&
            initialized
            .Statements
            .Length == 2 {
            conditional = initialized.Statements[1] as BoundIfStatement
        }
        for path in exit.Paths {
            if binderCtx.Narrowing.NarrowedType(path) == nil &&
                (IsByReferenceRoot(path.Root) || IsExternalStorageAlias(path.Root)) &&
                conditional != nil {
                if conditionEffects == nil {
                    conditionEffects = NewCollector(nil, aliasesAtEntry)
                    conditionEffects.VisitExpression(conditional.Condition)
                }
                let syntaxMutates = conditional.Condition.Syntax is {} syntax && SyntaxMayMutateMemberPaths(syntax)
                // Keep the existing condition-proof restriction for caller-owned storage (corpus l1).
                if StatementKillsPath(
                    conditionEffects,
                    path,
                    syntaxMutates || conditionEffects.MayMutateMemberPaths,
                    syntaxMutates || conditionEffects.MayMutateReferenceStorage
                ) {
                    exit = exit.Remove(path)
                }
            }
        }
        IntersectBranchEntry(exit)
        for path in exit.Paths {
            let joined = exit.NarrowedType(path)
            if joined != nil {
                SetPersistentNarrowing(persistentFrame, path, joined)
            }
        }
    }

    private func IsWeakerOrEqual(held TypeSymbol, joined TypeSymbol) bool -> NarrowingState.IsNoStrongerThan(
        joined,
        held
    )
}
