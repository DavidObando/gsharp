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
        var branchEffects AssignedRootsCollector? = nil
        var filterNames HashSet[string]? = nil
        var branchesMutateMembers = false
        var statementMutatesMembers = false
        for path in exit.Paths {
            let joined = exit.NarrowedType(path)
            if joined == nil || !IsJoinGain(path, joined, entry) {
                continue
            }
            if effects == nil || branchEffects == nil {
                effects = GetStatementEffects(statement, aliasesAtEntry)
                let syntax = statement.Syntax
                filterNames = if syntax == nil {
                    default(HashSet[string]?)
                } else {
                    EnclosingFilterNames(syntax, effects)
                }
                let branches = BranchStatements(statement)
                branchEffects = NewCollector(nil, aliasesAtEntry)
                var syntaxMutates = false
                for branch in branches {
                    branchEffects.Visit(branch)
                    let branchSyntax = branch.Syntax
                    syntaxMutates = syntaxMutates || branchSyntax == nil || SyntaxMayMutateMemberPaths(branchSyntax)
                }
                branchesMutateMembers = syntaxMutates || branchEffects.MayMutateMemberPaths
                statementMutatesMembers = branchesMutateMembers ||
                    effects.MayMutateMemberPaths ||
                    syntax == nil ||
                    SyntaxMayMutateMemberPaths(syntax)
            }
            let killedByFilter = filterNames != nil &&
                (filterNames.Contains(path.Root.Name) || MayBeMutatedByUnknownCallable(path))
            if !killedByFilter &&
                !KillsJoinGain(path, effects, branchEffects, branchesMutateMembers, statementMutatesMembers) {
                SetPersistentNarrowing(persistentFrame, path, joined)
            }
        }
    }

    // The one kill rule for a gain. The legacy passes own every kill that a write causes
    // (row R2, a later PR). A member-path fact is proved after the calls of the condition
    // and the initializer (row R5), so only the branches' effects, the writes of the
    // whole statement and an unknown write to its root kill it. A fact on a plain root, or on an external-storage alias, is
    // proved by a test that a later call in the condition can follow, so the whole
    // statement kills it.
    private func KillsJoinGain(
        path AccessPath,
        statementEffects AssignedRootsCollector,
        branchEffects AssignedRootsCollector,
        branchesMutateMembers bool,
        statementMutatesMembers bool
    ) bool {
        if path.HasMembers && !IsExternalStorageAlias(path.Root) {
            // The members are immutable, so a call in the condition can only invalidate the
            // fact by replacing the root, and it can do that after the test.
            return statementEffects.AssignsRoot(path.Root) ||
                MayBeMutatedByUnknownWrite(statementEffects, AccessPath.ForVariable(path.Root)) ||
                StatementKillsPath(branchEffects, path, branchesMutateMembers)
        }
        return StatementKillsPath(statementEffects, path, statementMutatesMembers)
    }

    // The statements that run after the facts of an `if` hold: its branches. A bare
    // block is all branch. The condition and the initializer run before the facts hold.
    private func BranchStatements(statement BoundStatement) List[BoundStatement] {
        let result = List[BoundStatement]()
        switch statement {
            case ifStatement is BoundIfStatement {
                result.Add(ifStatement.ThenStatement)
                if ifStatement.ElseStatement != nil {
                    result.Add(ifStatement.ElseStatement)
                }
            }
            case initialized is BoundBlockStatement when initialized.Syntax is IfStatementSyntax &&
                initialized
                .Statements
                .Length == 2 &&
                initialized.Statements[1] is BoundIfStatement {
                result.AddRange(BranchStatements(initialized.Statements[1]))
            }
            default {
                result.Add(statement)
            }
        }
        return result
    }

    // A gain is a fact that the statement proved and the frames do not hold. A
    // fact that the entry state held is not a gain unless the join refines it: a
    // type that the held type converts to is weaker or equal, and any other type
    // is a test that the held fact did not cover (`x IA?` tested against `IB`).
    // Putting back an entry fact that a write killed belongs to a later PR (row R2).
    private func IsJoinGain(path AccessPath, joined TypeSymbol, entry NarrowingState) bool {
        let entryType = entry.NarrowedType(path)
        if entryType != nil && IsWeakerOrEqual(entryType, joined) {
            return false
        }
        let currentType = binderCtx.Narrowing.NarrowedType(path)
        return currentType == nil || !IsWeakerOrEqual(currentType, joined)
    }

    private func IsWeakerOrEqual(held TypeSymbol, joined TypeSymbol) bool -> object.Equals(held, joined) ||
        Conversion.IsRepresentationPreservingImplicit(held, joined)
}
