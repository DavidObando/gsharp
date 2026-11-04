// <copyright file="BackwardJumpSpans.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// The backward-jump span of a function (ADR-0213 section 11): the run of
/// consecutive statements, in one statement list, from the statement that holds
/// the earliest label that a later `goto` targets through the statement that
/// holds the last such `goto`.
internal sealed class BackwardJumpSpan {
    init(
        owner SyntaxNode,
        statements ImmutableArray[StatementSyntax],
        firstIndex int32,
        lastIndex int32,
        labels List[string],
        gotoCount int32,
        targetedLabels List[string]? = nil
    ) {
        Owner = owner
        StatementList = statements
        FirstIndex = firstIndex
        LastIndex = lastIndex
        Labels = labels
        GotoCount = gotoCount
        TargetedLabels = targetedLabels ?? labels
    }

    /// Gets the block statement, block expression or compilation unit that holds the statement list of the span.
    prop Owner SyntaxNode {
        get;
    }

    /// Gets the statement list that holds the span.
    prop StatementList ImmutableArray[StatementSyntax] {
        get;
    }

    /// Gets the first node of the span: a statement, or the trailing expression of a block expression
    /// when the span starts there (index equal to the statement count).
    prop FirstStatement SyntaxNode -> NodeAt(FirstIndex)

    private func NodeAt(index int32) SyntaxNode {
        if index < StatementList.Length {
            return StatementList[index]
        }
        if Owner is BlockExpressionSyntax blockOwner {
            return Invariant.Required(
                blockOwner.Expression,
                "a span index past the statements names the trailing expression",
                expression: "Owner.Expression"
            )
        }
        return Owner
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

    /// Gets the participant labels that at least one participant `goto` targets.
    prop TargetedLabels List[string] {
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
            result.Add(NodeAt(i))
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
        init(owner SyntaxNode, statements ImmutableArray[StatementSyntax], index int32) {
            Owner = owner
            Statements = statements
            Index = index
        }

        prop Owner SyntaxNode {
            get;
        }

        prop Statements ImmutableArray[StatementSyntax] {
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

    private sealed class TrySite {
        init(statement TryStatementSyntax, startPosition int32) {
            Statement = statement
            StartPosition = startPosition
        }

        prop Statement TryStatementSyntax {
            get;
        }

        prop StartPosition int32 {
            get;
        }
    }

    /// Computes the span of a function body, or `nil` when the body has no participant backward
    /// `goto`.
    func Compute(body BlockStatementSyntax) BackwardJumpSpan? -> Compute(cast[SyntaxNode](body))

    /// Computes the span of a function body that is a block statement or a block expression (the body
    /// of a lambda), or `nil` when the body has no participant backward `goto`.
    func Compute(body SyntaxNode) BackwardJumpSpan? {
        let labels = List[LabelSite]()
        let gotos = List[GotoSite]()
        let path = List[Step]()
        let tries = List[TrySite]()
        let visitCounter = List[int32]()
        visitCounter.Add(0)
        if body is ExpressionSyntax && body !is BlockExpressionSyntax {
            path.Add(Step(body, ImmutableArray[StatementSyntax].Empty, 0))
            Collect(body, path, tries, false, labels, gotos, visitCounter)
            path.RemoveAt(path.Count - 1)
        } else {
            Collect(body, path, tries, false, labels, gotos, visitCounter)
        }
        return BuildSpan(labels, gotos)
    }

    /// Computes the span of a combined top-level statement list across one or more syntax trees.
    func Compute(owner SyntaxNode, topStatements ImmutableArray[StatementSyntax]) BackwardJumpSpan? {
        if topStatements.Length == 0 {
            return nil
        }
        let labels = List[LabelSite]()
        let gotos = List[GotoSite]()
        let path = List[Step]()
        let tries = List[TrySite]()
        let visitCounter = List[int32]()
        visitCounter.Add(0)
        CollectList(owner, topStatements, path, tries, false, labels, gotos, visitCounter)
        return BuildSpan(labels, gotos)
    }

    private func BuildSpan(labels List[LabelSite], gotos List[GotoSite]) BackwardJumpSpan? {
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
        for candidate in participants {
            if candidate.Length == 0 {
                return nil
            }
        }
        var depth = 0
        var owner SyntaxNode = participants[0][0].Owner
        var statements = participants[0][0].Statements
        while true {
            var common = true
            for candidate in participants {
                if candidate.Length <= depth || !object.ReferenceEquals(
                    candidate[depth].Owner,
                    participants[0][depth].Owner
                ) {
                    common = false
                    break
                }
            }
            if !common {
                break
            }
            owner = participants[0][depth].Owner
            statements = participants[0][depth].Statements
            depth++
        }
        // depth now counts the shared lists. The statement indices at the last shared list bound the span.
        if depth == 0 {
            return nil
        }
        let level = depth - 1
        var first = int32.MaxValue
        var last = -1
        for candidate in participants {
            let index = candidate[level].Index
            first = Math.Min(first, index)
            last = Math.Max(last, index)
        }
        // An index equal to the statement count is the trailing expression of a block expression.
        let spanLabels = List[string]()
        for label in labels {
            if label.Path.Length > level && object.ReferenceEquals(label.Path[level].Owner, owner) &&
                label
                .Path[level]
                .Index >= first &&
                label
                .Path[level]
                .Index <= last {
                spanLabels.Add(label.Name)
            }
        }
        let targetedLabels = List[string]()
        for site in gotos {
            if site.Participates && spanLabels.Contains(site.Name) && !targetedLabels.Contains(site.Name) {
                targetedLabels.Add(site.Name)
            }
        }
        return BackwardJumpSpan(owner, statements, first, last, spanLabels, backward.Count, targetedLabels)
    }

    // A label does not change what its statement does: `Again: return 0` ends the path.
    private func IsUnconditionalExit(statement SyntaxNode) bool {
        var node = statement
        while node is LabeledStatementSyntax labeled {
            node = labeled.Statement
        }
        switch node.Kind {
            case SyntaxKind.BreakStatement,
            SyntaxKind.ContinueStatement,
            SyntaxKind.ReturnStatement,
            SyntaxKind.ThrowStatement,
            SyntaxKind.RethrowStatement,
            SyntaxKind.GotoStatement {
                return true
            }
            case SyntaxKind.BlockStatement {
                let block = cast[BlockStatementSyntax](node)
                return block
                    .Statements
                    .Length > 0 &&
                    !ContainsUserLabel(block) &&
                    IsUnconditionalExit(block.Statements[block.Statements.Length - 1])
            }
            case SyntaxKind.IfStatement {
                let ifStatement = cast[IfStatementSyntax](node)
                return ifStatement.ElseClause != nil &&
                    !ContainsUserLabel(ifStatement) &&
                    IsUnconditionalExit(ifStatement.ThenStatement) &&
                    IsUnconditionalExit(ifStatement.ElseClause.ElseStatement)
            }
            case SyntaxKind.ForInfiniteStatement {
                let loop = cast[ForInfiniteStatementSyntax](node)
                return !ContainsUserLabel(loop.Body) && !ContainsBreakForLoop(loop.Body)
            }
            case SyntaxKind.SwitchStatement {
                let switchStatement = cast[SwitchStatementSyntax](node)
                if ContainsUserLabel(switchStatement) || ContainsBreakForSwitch(switchStatement) {
                    return false
                }
                var hasDefaultOrDiscard = false
                for arm in switchStatement.Cases {
                    if arm.IsDefault || (arm.Guard == nil && arm.Value is DiscardPatternSyntax) {
                        hasDefaultOrDiscard = true
                    }
                    if !IsUnconditionalExit(arm.Body) {
                        return false
                    }
                }
                return hasDefaultOrDiscard
            }
            case SyntaxKind.TryStatement {
                return FinallyCannotComplete(cast[TryStatementSyntax](node))
            }
            default {
                return false
            }
        }
    }

    private func ContainsUserLabel(node SyntaxNode) bool {
        if IsFunctionLike(node) {
            return false
        }
        if node is LabeledStatementSyntax labeled && !StatementBinder.IsLabelableLoop(labeled.Statement) {
            return true
        }
        for child in node.GetChildren() {
            if ContainsUserLabel(child) {
                return true
            }
        }
        return false
    }

    private func ContainsBreakForLoop(
        node SyntaxNode,
        inNestedLoopOrSwitch bool = false,
        innerLoopLabels List[string]? = nil
    ) bool {
        if IsFunctionLike(node) {
            return false
        }
        if node is BreakStatementSyntax breakStatement {
            if breakStatement.LabelIdentifier == nil {
                return !inNestedLoopOrSwitch
            }
            let target = breakStatement.LabelIdentifier.ValueText
            return innerLoopLabels == nil || !innerLoopLabels.Contains(target)
        }
        var nextLabels = innerLoopLabels
        if node is LabeledStatementSyntax labeled && StatementBinder.IsLabelableLoop(labeled.Statement) {
            let copy = if innerLoopLabels == nil {
                List[string]()
            } else {
                List[string](innerLoopLabels)
            }
            copy.Add(labeled.LabelIdentifier.ValueText)
            nextLabels = copy
        }
        let nested = inNestedLoopOrSwitch || StatementBinder.IsLabelableLoop(node) || node is SwitchStatementSyntax
        for child in node.GetChildren() {
            if ContainsBreakForLoop(child, nested, nextLabels) {
                return true
            }
        }
        return false
    }

    private func ContainsBreakForSwitch(
        node SyntaxNode,
        inNestedLoopOrSwitch bool = false,
        innerLoopLabels List[string]? = nil
    ) bool {
        if IsFunctionLike(node) {
            return false
        }
        if node is BreakStatementSyntax breakStatement {
            if breakStatement.LabelIdentifier == nil {
                return !inNestedLoopOrSwitch
            }
            let target = breakStatement.LabelIdentifier.ValueText
            return innerLoopLabels == nil || !innerLoopLabels.Contains(target)
        }
        var nextLabels = innerLoopLabels
        if node is LabeledStatementSyntax labeled && StatementBinder.IsLabelableLoop(labeled.Statement) {
            let copy = if innerLoopLabels == nil {
                List[string]()
            } else {
                List[string](innerLoopLabels)
            }
            copy.Add(labeled.LabelIdentifier.ValueText)
            nextLabels = copy
        }
        for child in node.GetChildren() {
            let childNested = inNestedLoopOrSwitch || StatementBinder.IsLabelableLoop(child) ||
                child is SwitchStatementSyntax
            if ContainsBreakForSwitch(child, childNested, nextLabels) {
                return true
            }
        }
        return false
    }

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

    private func CollectList(
        owner SyntaxNode,
        statements ImmutableArray[StatementSyntax],
        path List[Step],
        tries List[TrySite],
        dead bool,
        labels List[LabelSite],
        gotos List[GotoSite],
        visitCounter List[int32]
    ) {
        var deadHere = dead
        for var i = 0; i < statements.Length; i++ {
            let statement = statements[i]
            if statement is LabeledStatementSyntax labeledStatement && !StatementBinder.IsLabelableLoop(
                labeledStatement.Statement
            ) {
                deadHere = false
            }
            let labelsBefore = labels.Count
            path.Add(Step(owner, statements, i))
            Collect(statement, path, tries, deadHere, labels, gotos, visitCounter)
            path.RemoveAt(path.Count - 1)
            if labels.Count > labelsBefore {
                deadHere = false
            }
            if IsUnconditionalExit(statement) {
                deadHere = true
            }
        }
    }

    private func Collect(
        node SyntaxNode,
        path List[Step],
        tries List[TrySite],
        dead bool,
        labels List[LabelSite],
        gotos List[GotoSite],
        visitCounter List[int32]
    ) {
        if node is CompilationUnitSyntax unit {
            let topStatements = unit
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((globalStatement GlobalStatementSyntax) -> globalStatement.Statement)
                .ToImmutableArray()
            if topStatements.Length > 0 {
                CollectList(unit, topStatements, path, tries, dead, labels, gotos, visitCounter)
            }
            return
        }
        if node is BlockStatementSyntax block {
            CollectList(block, block.Statements, path, tries, dead, labels, gotos, visitCounter)
            return
        }
        if node is BlockExpressionSyntax blockExpression {
            CollectList(blockExpression, blockExpression.Statements, path, tries, dead, labels, gotos, visitCounter)
            let tail = blockExpression.Expression
            if tail != nil {
                // The trailing expression follows the statements in the same list, so it has a step of its own.
                path.Add(Step(blockExpression, blockExpression.Statements, blockExpression.Statements.Length))
                Collect(tail, path, tries, dead, labels, gotos, visitCounter)
                path.RemoveAt(path.Count - 1)
            }
            return
        }
        if node is LabeledStatementSyntax labeled {
            if !StatementBinder.IsLabelableLoop(labeled.Statement) {
                let labelPos = visitCounter[0]
                visitCounter[0] = labelPos + 1
                labels.Add(LabelSite(labeled.LabelIdentifier.ValueText, labelPos, path.ToArray()))
                Collect(labeled.Statement, path, tries, false, labels, gotos, visitCounter)
            } else {
                Collect(labeled.Statement, path, tries, dead, labels, gotos, visitCounter)
            }
            return
        }
        if node is GotoStatementSyntax jump {
            let gotoPos = visitCounter[0]
            visitCounter[0] = gotoPos + 1
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
                    if FinallyCannotComplete(enclosing.Statement) &&
                        labelPosition >= 0 &&
                        labelPosition < enclosing.StartPosition {
                        participates = false
                    }
                }
            }
            gotos.Add(GotoSite(jump.LabelIdentifier.ValueText, gotoPos, path.ToArray(), participates))
            return
        }
        if node is TryStatementSyntax tryStatement {
            let labelsBeforeTry = labels.Count
            let tryStart = visitCounter[0]
            visitCounter[0] = tryStart + 1
            tries.Add(TrySite(tryStatement, tryStart))
            Collect(tryStatement.TryBlock, path, tries, dead, labels, gotos, visitCounter)
            let handlersDead = dead && labels.Count == labelsBeforeTry
            for clause in tryStatement.CatchClauses {
                Collect(clause.Body, path, tries, handlersDead, labels, gotos, visitCounter)
            }
            tries.RemoveAt(tries.Count - 1)
            if tryStatement.FinallyClause != nil {
                let finallyDead = handlersDead && labels.Count == labelsBeforeTry
                Collect(tryStatement.FinallyClause.Body, path, tries, finallyDead, labels, gotos, visitCounter)
            }
            return
        }
        for child in node.GetChildren() {
            if IsFunctionLike(child) {
                continue
            }
            Collect(child, path, tries, dead, labels, gotos, visitCounter)
        }
    }
}
