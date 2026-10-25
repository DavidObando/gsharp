// <copyright file="BackwardJumpSpans.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Linq

/// The backward-jump span of a function (ADR-0213 section 11): the run of
/// consecutive statements, in one statement list, from the statement that holds
/// the earliest label that a later `goto` targets through the statement that
/// holds the last such `goto`.
internal sealed class BackwardJumpSpan {
    init(block BlockStatementSyntax, firstIndex int32, lastIndex int32, labels List[string], gotoCount int32) {
        Block = block
        FirstIndex = firstIndex
        LastIndex = lastIndex
        Labels = labels
        GotoCount = gotoCount
    }

    /// Gets the statement list that holds the span.
    prop Block BlockStatementSyntax {
        get;
    }

    /// Gets the index of the first statement of the span in the list.
    prop FirstIndex int32 {
        get;
    }

    /// Gets the index of the last statement of the span in the list.
    prop LastIndex int32 {
        get;
    }

    /// Gets the labels inside the span, in source order. Every one is a participant.
    prop Labels List[string] {
        get;
    }

    /// Gets the number of participant `goto` statements that target a label at or before them.
    prop GotoCount int32 {
        get;
    }

    /// Gets the statements of the span.
    func Statements()[]SyntaxNode {
        let result = List[SyntaxNode]()
        for var i = FirstIndex; i <= LastIndex; i++ {
            result.Add(Block.Statements[i])
        }
        return result.ToArray()
    }
}

/// Computes the backward-jump span of a function body from syntax alone
/// (ADR-0213 section 11). Slice L0 computes the span and counts it. Nothing
/// consumes it yet.
/// @remarks Participants follow rule J8. A `goto` at an unreachable point
/// (after an unconditional exit with no label between, in the same statement
/// list) is not a participant. A `goto` that leaves a `try` whose `finally`
/// ends in an unconditional exit, with the label outside that `try`, is not
/// one either. A `goto` that the walker cannot rule out counts, which only
/// adds kills. A nested function literal has its own labels and is not walked.
/// The function returns one span for the body, from the lowest statement list
/// that holds every participant (disjoint spans may be merged, section 11).
internal shared class BackwardJumpSpans {
    /// A statement list on the path from the function body to a node, with the index of the
    /// statement that leads to the node.
    private sealed class Step {
        init(block BlockStatementSyntax, index int32) {
            Block = block
            Index = index
        }

        prop Block BlockStatementSyntax {
            get;
        }

        prop Index int32 {
            get;
        }
    }

    private sealed class LabelSite {
        init(name string, position int32, path[]Step) {
            Name = name
            Position = position
            Path = path
        }

        prop Name string {
            get;
        }

        prop Position int32 {
            get;
        }

        prop Path[]Step {
            get;
        }
    }

    private sealed class GotoSite {
        init(name string, position int32, path[]Step, participates bool) {
            Name = name
            Position = position
            Path = path
            Participates = participates
        }

        prop Name string {
            get;
        }

        prop Position int32 {
            get;
        }

        prop Path[]Step {
            get;
        }

        prop Participates bool {
            get;
        }
    }

    /// Computes the span of a function body, or `nil` when the body has no participant backward
    /// `goto`.
    func Compute(body BlockStatementSyntax) BackwardJumpSpan? {
        let labels = List[LabelSite]()
        let gotos = List[GotoSite]()
        let path = List[Step]()
        let tries = List[TryStatementSyntax]()
        Collect(body, path, tries, false, labels, gotos)
        if gotos.Count == 0 {
            return nil
        }
        // A label that a participant `goto` targets from a later position starts a span.
        let backward = List[GotoSite]()
        let targets = List[LabelSite]()
        for site in gotos {
            if !site.Participates {
                continue
            }
            for label in labels {
                if label.Name == site.Name && label.Position <= site.Position {
                    backward.Add(site)
                    if !targets.Contains(label) {
                        targets.Add(label)
                    }
                    break
                }
            }
        }
        if backward.Count == 0 {
            return nil
        }
        // The lowest statement list that holds the earliest target and every participant `goto`.
        let participants = List[[]Step]()
        for label in targets {
            participants.Add(label.Path)
        }
        for site in backward {
            participants.Add(site.Path)
        }
        var depth = 0
        var block BlockStatementSyntax = participants[0][0].Block
        while true {
            var common = true
            for candidate in participants {
                if candidate.Length <= depth || !object.ReferenceEquals(
                    candidate[depth].Block,
                    participants[0][depth].Block
                ) {
                    common = false
                    break
                }
            }
            if !common {
                break
            }
            block = participants[0][depth].Block
            depth++
        }
        // depth now counts the shared lists. The statement indices at the last shared list bound the span.
        let level = depth - 1
        var first = int32.MaxValue
        var last = -1
        for candidate in participants {
            let index = candidate[level].Index
            first = Math.Min(first, index)
            last = Math.Max(last, index)
        }
        let spanLabels = List[string]()
        for label in labels {
            if label.Path.Length > level && object.ReferenceEquals(label.Path[level].Block, block) &&
                label
                .Path[level]
                .Index >= first &&
                label
                .Path[level]
                .Index <= last {
                spanLabels.Add(label.Name)
            }
        }
        return BackwardJumpSpan(block, first, last, spanLabels, backward.Count)
    }

    private func IsUnconditionalExit(statement SyntaxNode) bool -> statement.Kind == SyntaxKind.BreakStatement ||
        statement.Kind == SyntaxKind.ContinueStatement ||
        statement.Kind == SyntaxKind.ReturnStatement ||
        statement.Kind == SyntaxKind.ThrowStatement ||
        statement.Kind == SyntaxKind.RethrowStatement ||
        statement.Kind == SyntaxKind.GotoStatement

    private func IsFunctionLike(node SyntaxNode) bool -> node.Kind == SyntaxKind.FunctionLiteralExpression ||
        node.Kind == SyntaxKind.LambdaExpression ||
        node.Kind == SyntaxKind.FunctionDeclaration ||
        node.Kind == SyntaxKind.AnonymousClassExpression

    // Whether the `finally` of the statement ends in a statement that cannot complete normally.
    private func FinallyCannotComplete(statement TryStatementSyntax) bool {
        if statement.FinallyClause == nil {
            return false
        }
        let statements = statement.FinallyClause.Body.Statements
        return statements.Length > 0 && IsUnconditionalExit(statements[statements.Length - 1])
    }

    private func Collect(
        node SyntaxNode,
        path List[Step],
        tries List[TryStatementSyntax],
        dead bool,
        labels List[LabelSite],
        gotos List[GotoSite]
    ) {
        if node is BlockStatementSyntax block {
            var deadHere = dead
            for var i = 0; i < block.Statements.Length; i++ {
                let statement = block.Statements[i]
                if statement.Kind == SyntaxKind.LabeledStatement {
                    deadHere = false
                }
                path.Add(Step(block, i))
                Collect(statement, path, tries, deadHere, labels, gotos)
                path.RemoveAt(path.Count - 1)
                if IsUnconditionalExit(statement) {
                    deadHere = true
                }
            }
            return
        }
        if node is LabeledStatementSyntax labeled {
            labels.Add(LabelSite(labeled.LabelIdentifier.ValueText, labeled.Span.Start, path.ToArray()))
            Collect(labeled.Statement, path, tries, false, labels, gotos)
            return
        }
        if node is GotoStatementSyntax jump {
            var participates = !dead
            if participates {
                let name = jump.LabelIdentifier.ValueText
                // The label of this name decides whether the jump leaves a try.
                var labelPosition = -1
                for site in labels {
                    if site.Name == name {
                        labelPosition = site.Position
                    }
                }
                for enclosing in tries {
                    if FinallyCannotComplete(enclosing) &&
                        labelPosition >= 0 &&
                        (labelPosition < enclosing.Span.Start || labelPosition >= enclosing.Span.End) {
                        participates = false
                    }
                }
            }
            gotos.Add(GotoSite(jump.LabelIdentifier.ValueText, jump.Span.Start, path.ToArray(), participates))
            return
        }
        if node is TryStatementSyntax tryStatement {
            tries.Add(tryStatement)
            Collect(tryStatement.TryBlock, path, tries, dead, labels, gotos)
            for clause in tryStatement.CatchClauses {
                Collect(clause.Body, path, tries, dead, labels, gotos)
            }
            tries.RemoveAt(tries.Count - 1)
            if tryStatement.FinallyClause != nil {
                Collect(tryStatement.FinallyClause.Body, path, tries, dead, labels, gotos)
            }
            return
        }
        for child in node.GetChildren() {
            if IsFunctionLike(child) {
                continue
            }
            Collect(child, path, tries, dead, labels, gotos)
        }
    }
}
