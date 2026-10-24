// <copyright file="StatementBinder.NarrowingExits.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic

/// ADR-0208 section 19, PR 2: the exit states of `if` statements and bare
/// blocks, and the facts that their joins prove for the statements that follow.
/// @remarks The binder records the state at the end of each statement list. An
/// `if` joins the exit states of its branches with (cref:NarrowingState.Join),
/// and a bare block exits with the state at the end of its list. An `else if`
/// adds the exit states of its own branches to the list of the enclosing `if`,
/// so the join stays n-ary. The enclosing list then lifts every fact that the
/// join proves and that the frames do not hold. A function with a user label or `goto` keeps its current lifts (row R6
/// belongs to a later PR). The legacy passes still run, and they still own the
/// facts that a write kills.
internal partial class StatementBinder {
    // The statement that owns the recorded exit, the state before it, and the
    // states that flow out of it, in source order.
    private var exitOwner BoundStatement? = nil
    private var exitEntry NarrowingState = NarrowingState.Empty
    private var exitPredecessors List[NarrowingState] = List[NarrowingState]()
    // The state at the end of the statement list that was bound last.
    private var listExitState NarrowingState = NarrowingState.Empty

    /// Whether the join of branch exit states is consumed in the current function.
    private func JoinExitsEnabled() bool -> !binderCtx.FunctionContainsUserGotoOrLabel

    /// Records the state at the end of a statement list. `BindBlockStatements`
    /// calls it before it pops the frame that holds the lifts of the list.
    private func NoteListExit() {
        listExitState = binderCtx.Narrowing
    }

    /// Records the exit state of a block that [`BindBlockStatement`](paramref) bound.
    /// @param entry The state before the block.
    private func RecordBlockExit(block BoundBlockStatement, entry NarrowingState) {
        if !JoinExitsEnabled() {
            return
        }
        exitOwner = block
        exitEntry = entry
        exitPredecessors = List[NarrowingState]{listExitState}
    }

    /// Adds the states that flow out of a branch to [`exits`](paramref). A branch
    /// that cannot complete adds the unreachable state. A branch with no recorded
    /// exit adds the state with no fact. Call it right after the branch is bound.
    private func AddBranchExits(exits List[NarrowingState], branch BoundStatement) {
        if !JoinExitsEnabled() {
            return
        }
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

    /// Records the exit states of an `if`: the states of its branches.
    private func RecordIfExit(statement BoundStatement, entry NarrowingState, exits List[NarrowingState]) {
        if !JoinExitsEnabled() {
            return
        }
        exitOwner = statement
        exitEntry = entry
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
        if statement == nil || !JoinExitsEnabled() || !object.ReferenceEquals(exitOwner, statement) {
            return
        }
        let entry = exitEntry
        let exit = NarrowingState.Join(exitPredecessors)
        exitOwner = nil
        if exit.Count == 0 || (statement is BoundBlockStatement && !CanCompleteNormally(statement)) {
            return
        }
        var effects AssignedRootsCollector? = nil
        var filterNames HashSet[string]? = nil
        var branchesMutateMembers = false
        for path in exit.Paths {
            let joined = exit.NarrowedType(path)
            if joined == nil || !IsJoinGain(path, joined, entry) {
                continue
            }
            if effects == nil {
                effects = GetStatementEffects(statement, aliasesAtEntry)
                let syntax = statement.Syntax
                filterNames = if syntax == nil {
                    default(HashSet[string]?)
                } else {
                    EnclosingFilterNames(syntax, effects)
                }
                branchesMutateMembers = BranchesMayMutateMemberPaths(statement)
            }
            // The legacy passes own every kill that a write causes (row R2, a later PR).
            // A call in the condition runs before the condition proves its facts (row R5).
            let killedByFilter = filterNames != nil &&
                (filterNames.Contains(path.Root.Name) || MayBeMutatedByUnknownCallable(path))
            if !killedByFilter && !StatementKillsPath(effects, path, branchesMutateMembers) {
                SetPersistentNarrowing(persistentFrame, path, joined)
            }
        }
    }

    // Whether the branches of an `if`, or the statements of a bare block, can mutate
    // a member path. The condition and the initializer run before the facts hold.
    private func BranchesMayMutateMemberPaths(statement BoundStatement) bool {
        switch statement {
            case ifStatement is BoundIfStatement {
                return MayMutateMemberPaths(ifStatement.ThenStatement) ||
                    (ifStatement.ElseStatement != nil && MayMutateMemberPaths(ifStatement.ElseStatement))
            }
            case initialized is BoundBlockStatement when initialized.Syntax is IfStatementSyntax &&
                initialized
                .Statements
                .Length == 2 &&
                initialized.Statements[1] is BoundIfStatement {
                return BranchesMayMutateMemberPaths(initialized.Statements[1])
            }
            default {
                return MayMutateMemberPaths(statement)
            }
        }
    }

    private func MayMutateMemberPaths(statement BoundStatement) bool {
        let syntax = statement.Syntax
        return syntax == nil || SyntaxMayMutateMemberPaths(syntax)
    }

    // A gain is a fact that the statement proved and the frames do not hold. A
    // fact that the entry state held is not a gain unless the join strengthens it.
    // Putting back an entry fact that a write killed belongs to a later PR (row R2).
    private func IsJoinGain(path AccessPath, joined TypeSymbol, entry NarrowingState) bool {
        let entryType = entry.NarrowedType(path)
        if entryType != nil &&
            (object.Equals(entryType, joined) || !Conversion.IsRepresentationPreservingImplicit(joined, entryType)) {
            return false
        }
        let currentType = binderCtx.Narrowing.NarrowedType(path)
        if currentType == nil {
            return true
        }
        return !object.Equals(currentType, joined) && Conversion.IsRepresentationPreservingImplicit(joined, currentType)
    }
}
