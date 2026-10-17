// <copyright file="ControlFlowGraph.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.CodeDom.Compiler
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq

/// Control flow analyzer.
class ControlFlowGraph {
    private init(start BasicBlock, end BasicBlock, blocks List[BasicBlock], branches List[BasicBlockBranch]) {
        Start = start
        End = end
        Blocks = blocks
        Branches = branches
    }

    /// Gets the start block.
    prop Start BasicBlock {
        get;
    }

    /// Gets the end block.
    prop End BasicBlock {
        get;
    }

    /// Gets the set of blocks.
    prop Blocks List[BasicBlock] {
        get;
    }

    /// Gets the set of branches.
    prop Branches List[BasicBlockBranch] {
        get;
    }

    /// Writes the current control flow graph to the specified writer.
    /// @param writer The writer.
    func WriteTo(writer TextWriter) {
        let Quote = func (text string) string {
            return "\"" + text.TrimEnd().Replace("\"", "\\\"").Replace(Environment.NewLine, "\\l") + "\""
        }
        writer.WriteLine("digraph G {")
        let blockIds = Dictionary[BasicBlock, string]()
        for var i = 0; i < Blocks.Count; i++ {
            let id = "N$i"
            blockIds.Add(Blocks[i], id)
        }
        for block in Blocks {
            let id = blockIds[block]
            let label = Quote(block.ToString())
            writer.WriteLine("    $id [label = $label shape = box]")
        }
        for branch in Branches {
            let fromId = blockIds[branch.From]
            let toId = blockIds[branch.To]
            let label = Quote(branch.ToString())
            writer.WriteLine("    $fromId -> $toId [label = $label]")
        }
        writer.WriteLine("}")
    }

    /// Basic block.
    class BasicBlock {
        /// Initializes a new instance of the (cref:BasicBlock) class.
        init() {
            Statements = List[BoundStatement]()
            Incoming = List[BasicBlockBranch]()
            Outgoing = List[BasicBlockBranch]()
        }

        /// Initializes a new instance of the (cref:BasicBlock) class.
        /// @param isStart Indiates whether this is a start block or not.
        init(isStart bool) {
            Statements = List[BoundStatement]()
            Incoming = List[BasicBlockBranch]()
            Outgoing = List[BasicBlockBranch]()
            IsStart = isStart
            IsEnd = !isStart
        }

        /// Gets a value indicating whether this is a start block or not.
        prop IsStart bool {
            get;
        }

        /// Gets a value indicating whether this is an end block or not.
        prop IsEnd bool {
            get;
        }

        /// Gets the list of statements in this block.
        prop Statements List[BoundStatement] {
            get;
        }

        /// Gets the list of incoming branches to this block.
        prop Incoming List[BasicBlockBranch] {
            get;
        }

        /// Gets the list of outgoing branches from this block.
        prop Outgoing List[BasicBlockBranch] {
            get;
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func ToString() string {
            if IsStart {
                return "<Start>"
            }
            if IsEnd {
                return "<End>"
            }
            {
                using let writer = StringWriter()
                {
                    using let indentedWriter = IndentedTextWriter(writer)
                    for statement in Statements {
                        BoundNodePrinter.WriteTo(statement, indentedWriter)
                    }
                    return writer.ToString()
                }
            }
        }
    }

    /// Basic block branch.
    class BasicBlockBranch {
        /// Initializes a new instance of the (cref:BasicBlockBranch) class.
        /// @param from Originating block.
        /// @param to Destination block.
        /// @param condition Branch condition.
        init(from BasicBlock, to BasicBlock, condition BoundExpression?) {
            From = from
            To = to
            Condition = condition
        }

        /// Gets the originating block.
        prop From BasicBlock {
            get;
        }

        /// Gets the destination block.
        prop To BasicBlock {
            get;
        }

        /// Gets the branch condition.
        prop Condition BoundExpression? {
            get;
        }

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func ToString() string {
            if Condition == nil {
                return string.Empty
            }
            let condition = Condition!!
            return condition.ToString()
        }
    }

    /// Basic block builder.
    class BasicBlockBuilder {
        private let statements List[BoundStatement] = List[BoundStatement]()
        private let blocks List[BasicBlock] = List[BasicBlock]()
        private let treatThrowsAsTerminators bool

        /// Initializes a new instance of the (cref:BasicBlockBuilder) class.
        init() { }

        internal init(treatThrowsAsTerminators bool) {
            this.treatThrowsAsTerminators = treatThrowsAsTerminators
        }

        /// Builds a basic block from the provided bound block statement and adds
        /// it to the list of known blocks.
        /// @param block The bound block statement.
        /// @returns A basic block.
        func Build(block BoundBlockStatement) List[BasicBlock] {
            for statement in block.Statements {
                switch statement.Kind {
                    case BoundNodeKind.LabelStatement {
                        StartBlock()
                        statements.Add(statement)
                    }
                    case BoundNodeKind.GotoStatement,
                    BoundNodeKind.ConditionalGotoStatement,
                    BoundNodeKind.ReturnStatement {
                        statements.Add(statement)
                        StartBlock()
                    }
                    case BoundNodeKind.VariableDeclaration,
                    BoundNodeKind.LocalFunctionDeclaration,
                    BoundNodeKind
                        .ExpressionStatement {
                        statements.Add(statement)
                        if treatThrowsAsTerminators && ControlFlowGraph.HasNeverValue(statement) {
                            StartBlock()
                        }
                    }
                    case BoundNodeKind.PatternSwitchStatement, BoundNodeKind.FixedStatement {
                        statements.Add(statement)
                        if ControlFlowGraph.StatementDefinitelyReturns(statement) {
                            StartBlock()
                        }
                    }
                    case BoundNodeKind.ThrowStatement, BoundNodeKind.RethrowStatement {
                        statements.Add(statement)
                        if treatThrowsAsTerminators {
                            StartBlock()
                        }
                    }
                    case BoundNodeKind.TryStatement,
                    BoundNodeKind.GoStatement,
                    BoundNodeKind.AwaitForRangeStatement,
                    BoundNodeKind
                        .YieldStatement {
                        // Treat exception-flow constructs as opaque statements; precise
                        // CFG modeling of catch/finally edges is deferred to a later phase.
                        // GoStatement falls through to the next statement at the CFG level.
                        statements.Add(statement)
                    }
                    default {
                        throw Exception("Unexpected statement: ${statement.Kind}")
                    }
                }
            }
            EndBlock()
            return blocks.ToList()
        }

        private func StartBlock() {
            EndBlock()
        }

        private func EndBlock() {
            if statements.Count > 0 {
                let block = BasicBlock()
                block.Statements.AddRange(statements)
                blocks.Add(block)
                statements.Clear()
            }
        }
    }

    /// Graph builder.
    class GraphBuilder {
        private let blockFromLabel Dictionary[BoundLabel, BasicBlock] = Dictionary[BoundLabel, BasicBlock]()
        private let branches List[BasicBlockBranch] = List[BasicBlockBranch]()
        private let start BasicBlock = BasicBlock(isStart: true)
        private let end BasicBlock = BasicBlock(isStart: false)

        /// Builds a control flow graph from the provided list of basic blocks.
        /// @param blocks The list of basic blocks.
        /// @returns A control flow graph.
        func Build(blocks List[BasicBlock]) ControlFlowGraph {
            if !blocks.Any() {
                Connect(start, end)
            } else {
                Connect(start, blocks.First())
            }
            for block in blocks {
                for statement in block.Statements {
                    if statement is BoundLabelStatement labelStatement {
                        blockFromLabel.Add(labelStatement.Label, block)
                    }
                }
            }
            for var i = 0; i < blocks.Count; i++ {
                let current = blocks[i]
                let next = if i == blocks.Count - 1 {
                    end
                } else {
                    blocks[i + 1]
                }
                for statement in current.Statements {
                    let isLastStatementInBlock = statement == current.Statements.Last()
                    switch statement.Kind {
                        case BoundNodeKind.GotoStatement {
                            let gs = cast[BoundGotoStatement](statement)
                            Connect(current, ResolveLabelTarget(gs.Label, blockFromLabel, end))
                        }
                        case BoundNodeKind.ConditionalGotoStatement {
                            let cgs = cast[BoundConditionalGotoStatement](statement)
                            let thenBlock = ResolveLabelTarget(cgs.Label, blockFromLabel, end)
                            let elseBlock = next
                            let negatedCondition = Negate(cgs.Condition)
                            let thenCondition = if cgs.JumpIfTrue {
                                cgs.Condition
                            } else {
                                negatedCondition
                            }
                            let elseCondition = if cgs.JumpIfTrue {
                                negatedCondition
                            } else {
                                cgs.Condition
                            }
                            Connect(current, thenBlock, thenCondition)
                            Connect(current, elseBlock, elseCondition)
                        }
                        case BoundNodeKind.ReturnStatement {
                            Connect(current, end)
                        }
                        case BoundNodeKind.PatternSwitchStatement, BoundNodeKind.FixedStatement {
                            if ControlFlowGraph.StatementDefinitelyReturns(statement) {
                                Connect(current, end)
                            } else if isLastStatementInBlock {
                                Connect(current, next)
                            }
                        }
                        case BoundNodeKind.VariableDeclaration, BoundNodeKind.ExpressionStatement
                        when ControlFlowGraph.HasNeverValue(statement) {
                            // Issue #4965 (ADR-0200): a never-typed value — a
                            // throw expression, or a block/if/switch every path
                            // of which exits — never completes, like a throw.
                            Connect(current, end)
                        }
                        case BoundNodeKind.VariableDeclaration,
                        BoundNodeKind.LocalFunctionDeclaration,
                        BoundNodeKind.LabelStatement,
                        BoundNodeKind.ExpressionStatement,
                        BoundNodeKind.TryStatement,
                        BoundNodeKind.GoStatement,
                        BoundNodeKind.AwaitForRangeStatement,
                        BoundNodeKind
                            .YieldStatement {
                            // Issue #798: `yield` (ADR-0040) participates in the
                            // CFG as a fall-through to the next statement; the
                            // iterator state-machine rewriter (`IteratorRewriter`
                            // / `AsyncIteratorRewriter`) later lowers it on the
                            // emit path. Without this arm, CFG analysis over an
                            // iterator body prior to the iterator rewriter would
                            // throw GS9998 "Unexpected statement: YieldStatement".
                            if isLastStatementInBlock {
                                Connect(current, next)
                            }
                        }
                        case BoundNodeKind.ThrowStatement, BoundNodeKind.RethrowStatement {
                            // Throws transfer control to a catch handler or unwind out
                            // of the function; treat as terminator.
                            Connect(current, end)
                        }
                        default {
                            throw Exception("Unexpected statement: ${statement.Kind}")
                        }
                    }
                }
            }
            RemoveUnreachableBlocks(blocks)
            blocks.Insert(0, start)
            blocks.Add(end)
            return ControlFlowGraph(start, end, blocks, branches)
        }

        private func RemoveUnreachableBlocks(blocks List[BasicBlock]) {
            // Issue #3061: incoming-edge peeling cannot remove an unreachable
            // cycle. Walk from Start so dead loop SCCs are discarded too.
            let reachable = HashSet[BasicBlock]{start}
            let queue = Queue[BasicBlock]()
            queue.Enqueue(start)
            while queue.Count > 0 {
                let block = queue.Dequeue()
                for branch in block.Outgoing {
                    if reachable.Add(branch.To) {
                        queue.Enqueue(branch.To)
                    }
                }
            }
            let removed = blocks.Where((block BasicBlock) -> !reachable.Contains(block)).ToHashSet()
            if removed.Count == 0 {
                return
            }
            let removedBranches = branches.Where(
                (branch BasicBlockBranch) -> removed.Contains(branch.From) || removed.Contains(branch.To)
            )
                .ToArray()
            for branch in removedBranches {
                branch.From.Outgoing.Remove(branch)
                branch.To.Incoming.Remove(branch)
            }
            branches.RemoveAll(
                (value ControlFlowGraph.BasicBlockBranch) -> Enumerable.Contains[BasicBlockBranch](
                    removedBranches,
                    value
                )
            )
            blocks.RemoveAll((block BasicBlock) -> removed.Contains(block))
        }

        private func Connect(from BasicBlock, to BasicBlock, condition BoundExpression? = nil) {
            var condition = condition
            if condition is BoundLiteralExpression l {
                if l.Value is not bool value {
                    throw InvalidOperationException("A literal branch condition must be Boolean.")
                }
                if value {
                    condition = nil
                } else {
                    return
                }
            }
            let branch = BasicBlockBranch(from, to, condition)
            from.Outgoing.Add(branch)
            to.Incoming.Add(branch)
            branches.Add(branch)
        }

        private func Negate(condition BoundExpression) BoundExpression {
            if condition is BoundLiteralExpression literal {
                if literal.Value is not bool value {
                    throw InvalidOperationException("A literal branch condition must be Boolean.")
                }
                return BoundLiteralExpression(nil, !value)
            }
            let op BoundUnaryOperator? = BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool)
            if op == nil {
                throw InvalidOperationException("The Boolean negation operator must be available.")
            }
            return BoundUnaryExpression(nil, op, condition)
        }

        shared {
            /// Resolves a goto/conditional-goto's target label to the basic block
            /// that declares it, or [`end`](paramref) when the label is not
            /// declared anywhere in the region this graph was built over.
            /// @remarks Issue #2360: several analyses ((cref:RefStructAsyncLivenessAnalyzer),
            /// (cref:DefiniteAssignmentAnalyzer)) build a fresh, narrowly
            /// scoped (cref:ControlFlowGraph) over just one nested compound
            /// statement's body — a `try`/`catch`/`finally` block, a
            /// `select` case, a `scope`, or a `fixed` body — because the
            /// outer graph treats those as single opaque statements (issue #1642). A
            /// `goto` lexically inside such a region can legitimately target a
            /// label declared <em>outside</em> it: the async lowering pipeline's
            /// generalized try/finally-with-return funnel ((cref:Lowering.Lowerer)'s
            /// `RewriteReturnStatement`/`WrapWithMethodExitEpilogue`) rewrites a
            /// `return` inside a protected region into exactly this shape — a
            /// `goto` to a synthesized exit label placed after the whole
            /// enclosing statement, i.e. outside the try body's own region. The same
            /// applies to a user `break`/`continue` lowered to a `goto`
            /// past a loop that encloses (but is not entirely inside) the region.
            ///
            /// Such a label is, from the narrow region's point of view,
            /// indistinguishable from any other exit out of the region — exactly like
            /// a `return` or `throw`, which already connect straight to
            /// [`end`](paramref) (see the switch above). Routing an unresolved
            /// label to [`end`](paramref) keeps every synthesized branch target
            /// meaningful to the analysis (the region-scoped liveness/assignment
            /// fixpoint folds in whatever is live/assigned past the region, via each
            /// analyzer's own `liveOutOfRegion`/`isFunctionBody` plumbing)
            /// instead of throwing (cref:KeyNotFoundException) and crashing the
            /// compiler (GS9998) the moment a by-ref-like local or an `out`
            /// parameter happens to make either analyzer examine the region.
            /// @param label The goto/conditional-goto's target label.
            /// @param blockFromLabel The label-to-block map for this region.
            /// @param end This graph's end block.
            /// @returns The declaring block, or [`end`](paramref) if the label escapes the region.
            private func ResolveLabelTarget(
                label BoundLabel,
                blockFromLabel Dictionary[BoundLabel, BasicBlock],
                end BasicBlock
            ) BasicBlock {
                return if blockFromLabel.TryGetValue(label, out var block) {
                    block
                } else {
                    end
                }
            }
        }
    }

    private class DefiniteReturnLabelRewriter : BoundTreeRewriter {
        private let labels Dictionary[BoundLabel, BoundLabel] = Dictionary[BoundLabel, BoundLabel]()

        init(labels IEnumerable[BoundLabel], createLabel() -> BoundLabel) {
            for label in labels {
                this.labels[label] = createLabel()
            }
        }

        protected override func RewriteLabelStatement(node BoundLabelStatement) BoundStatement -> if labels.TryGetValue(
            node.Label,
            out var label
        ) {
            BoundLabelStatement(nil, label)
        } else {
            node
        }

        protected override func RewriteGotoStatement(node BoundGotoStatement) BoundStatement -> if labels.TryGetValue(
            node.Label,
            out var label
        ) {
            BoundGotoStatement(nil, label)
        } else {
            node
        }

        protected override func RewriteConditionalGotoStatement(
            node BoundConditionalGotoStatement
        ) BoundStatement -> BoundConditionalGotoStatement(
            nil,
            if labels.TryGetValue(node.Label, out var label) {
                label
            } else {
                node.Label
            },
            RewriteExpression(node.Condition),
            node.JumpIfTrue
        )
    }

    shared {
        /// Creates a control flow graph from the provided bound block statement.
        /// @param body The bound block statement.
        /// @returns The control flow graph.
        func Create(body BoundBlockStatement) ControlFlowGraph -> Create(body, treatThrowsAsTerminators: false)

        /// Reports whether all paths in a bound block statement return or not.
        /// @param body The bound block statement.
        /// @returns Whether all its paths return or not.
        func AllPathsReturn(body BoundBlockStatement) bool {
            var body = body
            body = body.PreEmitAnalysisBody ?? body
            // This projection is intentionally limited to definite-return. Other
            // data-flow analyzers use the same pre-emit body but retain their
            // existing opaque treatment of compound statements.
            let graph = Create(ProjectRegionsForDefiniteReturn(body), treatThrowsAsTerminators: true)
            for branch in graph.End.Incoming {
                let lastStatement BoundStatement? = branch.From.Statements.LastOrDefault()
                if lastStatement == nil {
                    return false
                }
                // A `throw` statement transfers control out of the function (either
                // up to a catch handler or off the frame entirely) and is therefore
                // a legitimate terminator for the "all paths return" check — the
                // path simply never falls off the end of the function.
                //
                // An exhaustive `switch` statement — one that has a `default` clause
                // and whose every reachable arm definitely returns or throws — never
                // falls off its end either, so it is likewise a valid terminator
                // (issue #1596). Non-exhaustive switches (no `default`) still fall
                // through and are rejected below.
                if !StatementDefinitelyReturns(lastStatement) {
                    return false
                }
            }
            return true
        }

        /// Determines whether a pattern `switch` statement is exhaustive and
        /// definitely returns — that is, it has a `default` arm and every arm
        /// body definitely returns or throws. Such a switch never falls off its end
        /// and therefore acts as a control-flow terminator for definite-return
        /// analysis (issue #1596). A switch without a `default` arm can fall
        /// through (the discriminant may match no arm) and is never treated as
        /// definitely-returning.
        /// @param switchStatement The pattern switch statement.
        /// @returns Whether the switch definitely returns on every path.
        internal func SwitchAlwaysReturns(switchStatement BoundPatternSwitchStatement) bool {
            var hasDefault = false
            for arm in switchStatement.Arms {
                if arm.IsDefault {
                    hasDefault = true
                }
                if !StatementDefinitelyReturns(arm.Body) {
                    return false
                }
            }
            return hasDefault
        }

        /// Issue #4965 (ADR-0200): whether [`statement`](paramref) evaluates a
        /// never-typed value — a throw expression, or a block, if-, if-let- or
        /// switch-expression every path of which exits — as an expression
        /// statement or a local's initializer. Such a statement never completes
        /// normally, exactly like a throw statement.
        /// @param statement The bound statement.
        /// @returns Whether the statement's value has the bottom type.
        internal func HasNeverValue(statement BoundStatement) bool {
            switch statement {
                case expressionStatement is BoundExpressionStatement {
                    return expressionStatement.Expression.Type == TypeSymbol.Never
                }
                case declaration is BoundVariableDeclaration {
                    return declaration.Initializer?.Type == TypeSymbol.Never
                }
                default {
                    return false
                }
            }
        }

        /// Structurally determines whether a bound statement definitely returns (or
        /// throws) on the fall-through path — without constructing a sub control-flow
        /// graph. This is deliberately conservative: escaping jumps such as
        /// `continue`/`break`/`goto` (which the lowerer emits as goto
        /// statements targeting labels outside the statement) are treated as NOT
        /// returning. Building an isolated CFG for such a statement would fail
        /// because those jump targets are not present in the isolated graph
        /// (issue #1596 follow-up: fixes a crash on `continue`/`break`
        /// inside a switch arm nested in a loop).
        /// @param statement The bound statement.
        /// @returns Whether the statement definitely returns or throws.
        internal func StatementDefinitelyReturns(statement BoundStatement) bool {
            switch statement {
                case block is BoundBlockStatement {
                    // A block definitely returns iff its last reachable statement
                    // definitely returns.
                    let last BoundStatement? = block.Statements.LastOrDefault()
                    return last != nil && StatementDefinitelyReturns(last)
                }
                case nestedSwitch is BoundPatternSwitchStatement {
                    return SwitchAlwaysReturns(nestedSwitch)
                }
                case fixedStatement is BoundFixedStatement {
                    return StatementDefinitelyReturns(fixedStatement.Body)
                }
                default {
                    return statement.Kind == BoundNodeKind.ReturnStatement ||
                        statement.Kind == BoundNodeKind.ThrowStatement ||
                        statement.Kind == BoundNodeKind.RethrowStatement ||
                        HasNeverValue(statement)
                }
            }
        }

        private func Create(body BoundBlockStatement, treatThrowsAsTerminators bool) ControlFlowGraph {
            let basicBlockBuilder = BasicBlockBuilder(treatThrowsAsTerminators)
            let blocks = basicBlockBuilder.Build(body)
            let graphBuilder = GraphBuilder()
            return graphBuilder.Build(blocks)
        }

        private func ProjectRegionsForDefiniteReturn(statement BoundStatement) BoundBlockStatement {
            var AddPatternSwitch((BoundPatternSwitchStatement, ((BoundStatement) -> void)?) -> void)? = nil
            var AddTry((BoundTryStatement, ((BoundStatement) -> void)?) -> void)? = nil
            var Add((BoundStatement, ((BoundStatement) -> void)?) -> void)? = nil
            var CollectLabels((BoundStatement) -> HashSet[BoundLabel])? = nil
            var CloneWithFreshLabels((BoundStatement) -> BoundStatement)? = nil
            var NewLabel((string) -> BoundLabel)? = nil
            var NewChoice(() -> BoundExpression)? = nil
            CollectLabels = func (root BoundStatement) HashSet[BoundLabel] {
                let labels = HashSet[BoundLabel]()
                let Collect = func (current BoundStatement) {
                    switch current {
                        case label is BoundLabelStatement {
                            labels.Add(label.Label)
                        }
                        case block is BoundBlockStatement {
                            for nested in block.Statements {
                                Collect(nested)
                            }
                        }
                        case nestedTry is BoundTryStatement {
                            Collect(nestedTry.TryBlock)
                            for clause in nestedTry.CatchClauses {
                                Collect(clause.Body)
                            }
                            if nestedTry.FinallyBlock != nil {
                                Collect(nestedTry.FinallyBlock)
                            }
                        }
                        case fixedStatement is BoundFixedStatement {
                            Collect(fixedStatement.Body)
                        }
                        case switchStatement is BoundPatternSwitchStatement {
                            for arm in switchStatement.Arms {
                                Collect(arm.Body)
                            }
                        }
                    }
                }
                Collect(root)
                return labels
            }
            CloneWithFreshLabels = func (root BoundStatement) BoundStatement {
                return DefiniteReturnLabelRewriter(
                    CollectLabels!!(root),
                    () -> NewLabel!!("finallyBody")
                ).RewriteStatement(root)
            }
            var labelOrdinal = 0
            NewLabel = func (name string) BoundLabel {
                return BoundLabel("<>definiteReturn_${name}_${labelOrdinal++}")
            }
            var choiceOrdinal = 0
            // Keep this non-literal so GraphBuilder preserves both synthetic alternatives.
            NewChoice = func () BoundExpression {
                return BoundVariableExpression(
                    nil,
                    LocalVariableSymbol("<>definiteReturnChoice${choiceOrdinal++}", isReadOnly: true, TypeSymbol.Bool)
                )
            }
            let builder = ImmutableArray.CreateBuilder[BoundStatement]()
            AddPatternSwitch = func (
                switchStatement BoundPatternSwitchStatement,
                routeTransfer((BoundStatement) -> void)?
            ) {
                let endLabel = NewLabel!!("switchEnd")
                let arms = List[(Arm BoundPatternSwitchArm, Label BoundLabel)]()
                var defaultArm BoundPatternSwitchArm? = nil
                var defaultLabel BoundLabel? = nil
                var dispatchComplete = false
                for arm in switchStatement.Arms {
                    if arm.IsDefault {
                        defaultArm = arm
                        defaultLabel = NewLabel!!("switchDefault")
                        continue
                    }
                    let armLabel = NewLabel!!("switchArm")
                    arms.Add((arm, armLabel))
                    if arm.Pattern is BoundDiscardPattern && arm.Guard == nil {
                        builder.Add(BoundGotoStatement(nil, armLabel))
                        dispatchComplete = true
                        break
                    }
                    builder.Add(BoundConditionalGotoStatement(nil, armLabel, NewChoice!!()))
                }
                if !dispatchComplete && !switchStatement.IsExhaustive {
                    builder.Add(
                        BoundGotoStatement(
                            nil,
                            if defaultArm == nil || defaultLabel == nil {
                                endLabel
                            } else {
                                defaultLabel
                            }
                        )
                    )
                }
                for (arm, armLabel) in arms {
                    builder.Add(BoundLabelStatement(nil, armLabel))
                    Add!!(arm.Body, routeTransfer)
                    builder.Add(BoundGotoStatement(nil, endLabel))
                }
                if defaultArm != nil && defaultLabel != nil {
                    builder.Add(BoundLabelStatement(nil, defaultLabel))
                    Add!!(defaultArm.Body, routeTransfer)
                }
                builder.Add(BoundLabelStatement(nil, endLabel))
            }
            AddTry = func (tryStatement BoundTryStatement, outerRoute((BoundStatement) -> void)?) {
                let endLabel = NewLabel!!("tryEnd")
                let finallyBlock BoundStatement? = tryStatement.FinallyBlock
                let exceptionLabel BoundLabel? = if finallyBlock == nil {
                    default(BoundLabel?)
                } else {
                    NewLabel!!("exceptionFinally")
                }
                let alternatives = List[(Body BoundStatement, Label BoundLabel, Terminates bool)]{
                    (tryStatement.TryBlock, NewLabel!!("tryBody"), false)
                }
                for clause in tryStatement.CatchClauses {
                    // ADR-0174 D6: a scope's synthesized handler stores the body
                    // exception for a finally that always rethrows it, so the
                    // handler never completes normally.
                    alternatives.Add((clause.Body, NewLabel!!("catch"), clause.ExitsThroughFinally))
                }
                if exceptionLabel != nil {
                    builder.Add(BoundConditionalGotoStatement(nil, exceptionLabel, NewChoice!!()))
                }
                for var i = 1; i < alternatives.Count; i++ {
                    builder.Add(BoundConditionalGotoStatement(nil, alternatives[i].Label, NewChoice!!()))
                }
                builder.Add(BoundGotoStatement(nil, alternatives[0].Label))
                for (body, label, terminates) in alternatives {
                    builder.Add(BoundLabelStatement(nil, label))
                    if finallyBlock == nil {
                        Add!!(body, outerRoute)
                        builder.Add(
                            if terminates {
                                cast[BoundStatement](BoundThrowStatement(nil, NewChoice!!()))
                            } else {
                                cast[BoundStatement](BoundGotoStatement(nil, endLabel))
                            }
                        )
                        continue
                    }
                    let bodyLabels = CollectLabels!!(body)
                    let RouteThroughFinally = func (transfer BoundStatement) {
                        // Issue #3061: loop and switch lowering emits gotos whose
                        // targets remain inside the try body; they do not leave the
                        // protected region and therefore must not run finally.
                        if transfer is BoundGotoStatement gotoStatement && bodyLabels.Contains(gotoStatement.Label) {
                            builder.Add(transfer)
                            return
                        }
                        Add!!(CloneWithFreshLabels!!(finallyBlock), outerRoute)
                        Add!!(transfer, outerRoute)
                    }
                    Add!!(body, RouteThroughFinally)
                    Add!!(CloneWithFreshLabels!!(finallyBlock), outerRoute)
                    Add!!(
                        if terminates {
                            cast[BoundStatement](BoundThrowStatement(nil, NewChoice!!()))
                        } else {
                            cast[BoundStatement](BoundGotoStatement(nil, endLabel))
                        },
                        outerRoute
                    )
                }
                if exceptionLabel != nil && finallyBlock != nil {
                    builder.Add(BoundLabelStatement(nil, exceptionLabel))
                    Add!!(CloneWithFreshLabels!!(finallyBlock), outerRoute)
                    Add!!(BoundThrowStatement(nil, NewChoice!!()), outerRoute)
                }
                builder.Add(BoundLabelStatement(nil, endLabel))
            }
            var methodExitLabel BoundLabel? = nil
            var methodExitReturn BoundReturnStatement? = nil
            Add = func (current BoundStatement, routeTransfer((BoundStatement) -> void)? = nil) {
                switch current {
                    case block is BoundBlockStatement {
                        for nested in block.Statements {
                            Add!!(nested, routeTransfer)
                        }
                    }
                    case fixedStatement is BoundFixedStatement {
                        // Fixed executes its body once; pin setup and normal-exit
                        // release remain emit concerns. Escaping exits currently
                        // skip that release epilogue (#2900).
                        Add!!(fixedStatement.Body, routeTransfer)
                    }
                    case switchStatement is BoundPatternSwitchStatement {
                        AddPatternSwitch!!(switchStatement, routeTransfer)
                    }
                    case tryStatement is BoundTryStatement {
                        AddTry!!(tryStatement, routeTransfer)
                    }
                    case labelStatement is BoundLabelStatement when object.ReferenceEquals(
                        labelStatement.Label,
                        methodExitLabel
                    ) { }
                    case returnStatement is BoundReturnStatement when object.ReferenceEquals(
                        returnStatement,
                        methodExitReturn
                    ) { }
                    case gotoStatement is BoundGotoStatement when methodExitLabel != nil && object.ReferenceEquals(
                        gotoStatement.Label,
                        methodExitLabel
                    ) {
                        if methodExitReturn != nil {
                            Add!!(BoundReturnStatement(nil, methodExitReturn.Expression), routeTransfer)
                        }
                    }
                    case BoundGotoStatement, BoundReturnStatement, BoundThrowStatement, BoundRethrowStatement {
                        if routeTransfer == nil {
                            builder.Add(current)
                        } else {
                            routeTransfer(current)
                        }
                    }
                    default {
                        builder.Add(current)
                    }
                }
            }
            if statement is BoundBlockStatement functionBody && functionBody.Statements.Length >= 3 {
                let returnTempDeclaration BoundVariableDeclaration? = functionBody
                    .Statements
                    .OfType[BoundVariableDeclaration]()
                    .FirstOrDefault(
                    (declaration BoundVariableDeclaration) -> declaration.Variable.Name == "$$returnTemp"
                )
                if returnTempDeclaration != nil &&
                    functionBody.Statements[^2] is BoundLabelStatement exitLabel &&
                    functionBody.Statements[^1] is BoundReturnStatement{
                    Expression: BoundVariableExpression returnExpression
                } exitReturn &&
                    object
                    .ReferenceEquals(returnTempDeclaration.Variable, returnExpression.Variable) {
                    methodExitLabel = exitLabel.Label
                    methodExitReturn = exitReturn
                }
            }
            Add(statement, nil)
            return BoundBlockStatement(nil, builder.ToImmutable())
        }
    }
}
