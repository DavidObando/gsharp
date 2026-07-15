// <copyright file="ControlFlowGraph.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Control flow analyzer.
/// </summary>
public sealed class ControlFlowGraph
{
    private ControlFlowGraph(BasicBlock start, BasicBlock end, List<BasicBlock> blocks, List<BasicBlockBranch> branches)
    {
        Start = start;
        End = end;
        Blocks = blocks;
        Branches = branches;
    }

    /// <summary>
    /// Gets the start block.
    /// </summary>
    public BasicBlock Start { get; }

    /// <summary>
    /// Gets the end block.
    /// </summary>
    public BasicBlock End { get; }

    /// <summary>
    /// Gets the set of blocks.
    /// </summary>
    public List<BasicBlock> Blocks { get; }

    /// <summary>
    /// Gets the set of branches.
    /// </summary>
    public List<BasicBlockBranch> Branches { get; }

    /// <summary>
    /// Creates a control flow graph from the provided bound block statement.
    /// </summary>
    /// <param name="body">The bound block statement.</param>
    /// <returns>The control flow graph.</returns>
    public static ControlFlowGraph Create(BoundBlockStatement body)
    {
        var basicBlockBuilder = new BasicBlockBuilder();
        var blocks = basicBlockBuilder.Build(body);

        var graphBuilder = new GraphBuilder();
        return graphBuilder.Build(blocks);
    }

    /// <summary>
    /// Reports whether all paths in a bound block statement return or not.
    /// </summary>
    /// <param name="body">The bound block statement.</param>
    /// <returns>Whether all its paths return or not.</returns>
    public static bool AllPathsReturn(BoundBlockStatement body)
    {
        var graph = Create(body);

        foreach (var branch in graph.End.Incoming)
        {
            var lastStatement = branch.From.Statements.LastOrDefault();
            if (lastStatement == null)
            {
                return false;
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
            if (lastStatement.Kind != BoundNodeKind.ReturnStatement
                && lastStatement.Kind != BoundNodeKind.ThrowStatement
                && !(lastStatement is BoundPatternSwitchStatement sw && SwitchAlwaysReturns(sw)))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Writes the current control flow graph to the specified writer.
    /// </summary>
    /// <param name="writer">The writer.</param>
    public void WriteTo(TextWriter writer)
    {
        string Quote(string text)
        {
            return "\"" + text.TrimEnd().Replace("\"", "\\\"").Replace(Environment.NewLine, "\\l") + "\"";
        }

        writer.WriteLine("digraph G {");

        var blockIds = new Dictionary<BasicBlock, string>();

        for (int i = 0; i < Blocks.Count; i++)
        {
            var id = $"N{i}";
            blockIds.Add(Blocks[i], id);
        }

        foreach (var block in Blocks)
        {
            var id = blockIds[block];
            var label = Quote(block.ToString());
            writer.WriteLine($"    {id} [label = {label} shape = box]");
        }

        foreach (var branch in Branches)
        {
            var fromId = blockIds[branch.From];
            var toId = blockIds[branch.To];
            var label = Quote(branch.ToString());
            writer.WriteLine($"    {fromId} -> {toId} [label = {label}]");
        }

        writer.WriteLine("}");
    }

    /// <summary>
    /// Determines whether a pattern <c>switch</c> statement is exhaustive and
    /// definitely returns — that is, it has a <c>default</c> arm and every arm
    /// body definitely returns or throws. Such a switch never falls off its end
    /// and therefore acts as a control-flow terminator for definite-return
    /// analysis (issue #1596). A switch without a <c>default</c> arm can fall
    /// through (the discriminant may match no arm) and is never treated as
    /// definitely-returning.
    /// </summary>
    /// <param name="switchStatement">The pattern switch statement.</param>
    /// <returns>Whether the switch definitely returns on every path.</returns>
    internal static bool SwitchAlwaysReturns(BoundPatternSwitchStatement switchStatement)
    {
        var hasDefault = false;
        foreach (var arm in switchStatement.Arms)
        {
            if (arm.IsDefault)
            {
                hasDefault = true;
            }

            if (!StatementDefinitelyReturns(arm.Body))
            {
                return false;
            }
        }

        return hasDefault;
    }

    /// <summary>
    /// Structurally determines whether a bound statement definitely returns (or
    /// throws) on the fall-through path — without constructing a sub control-flow
    /// graph. This is deliberately conservative: escaping jumps such as
    /// <c>continue</c>/<c>break</c>/<c>goto</c> (which the lowerer emits as goto
    /// statements targeting labels outside the statement) are treated as NOT
    /// returning. Building an isolated CFG for such a statement would fail
    /// because those jump targets are not present in the isolated graph
    /// (issue #1596 follow-up: fixes a crash on <c>continue</c>/<c>break</c>
    /// inside a switch arm nested in a loop).
    /// </summary>
    /// <param name="statement">The bound statement.</param>
    /// <returns>Whether the statement definitely returns or throws.</returns>
    private static bool StatementDefinitelyReturns(BoundStatement statement)
    {
        switch (statement)
        {
            case BoundBlockStatement block:
                // A block definitely returns iff its last reachable statement
                // definitely returns.
                var last = block.Statements.LastOrDefault();
                return last != null && StatementDefinitelyReturns(last);
            case BoundPatternSwitchStatement nestedSwitch:
                return SwitchAlwaysReturns(nestedSwitch);
            default:
                return statement.Kind == BoundNodeKind.ReturnStatement
                    || statement.Kind == BoundNodeKind.ThrowStatement;
        }
    }

    /// <summary>
    /// Basic block.
    /// </summary>
    public sealed class BasicBlock
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BasicBlock"/> class.
        /// </summary>
        public BasicBlock()
        {
        }

        /// <summary>
        /// Initializes a new instance of the <see cref="BasicBlock"/> class.
        /// </summary>
        /// <param name="isStart">Indiates whether this is a start block or not.</param>
        public BasicBlock(bool isStart)
        {
            IsStart = isStart;
            IsEnd = !isStart;
        }

        /// <summary>
        /// Gets a value indicating whether this is a start block or not.
        /// </summary>
        public bool IsStart { get; }

        /// <summary>
        /// Gets a value indicating whether this is an end block or not.
        /// </summary>
        public bool IsEnd { get; }

        /// <summary>
        /// Gets the list of statements in this block.
        /// </summary>
        public List<BoundStatement> Statements { get; } = [];

        /// <summary>
        /// Gets the list of incoming branches to this block.
        /// </summary>
        public List<BasicBlockBranch> Incoming { get; } = [];

        /// <summary>
        /// Gets the list of outgoing branches from this block.
        /// </summary>
        public List<BasicBlockBranch> Outgoing { get; } = [];

        /// <inheritdoc/>
        public override string ToString()
        {
            if (IsStart)
            {
                return "<Start>";
            }

            if (IsEnd)
            {
                return "<End>";
            }

            using (var writer = new StringWriter())
            {
                using (var indentedWriter = new IndentedTextWriter(writer))
                {
                    foreach (var statement in Statements)
                    {
                        statement.WriteTo(indentedWriter);
                    }

                    return writer.ToString();
                }
            }
        }
    }

    /// <summary>
    /// Basic block branch.
    /// </summary>
    public sealed class BasicBlockBranch
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="BasicBlockBranch"/> class.
        /// </summary>
        /// <param name="from">Originating block.</param>
        /// <param name="to">Destination block.</param>
        /// <param name="condition">Branch condition.</param>
        public BasicBlockBranch(BasicBlock from, BasicBlock to, BoundExpression condition)
        {
            From = from;
            To = to;
            Condition = condition;
        }

        /// <summary>
        /// Gets the originating block.
        /// </summary>
        public BasicBlock From { get; }

        /// <summary>
        /// Gets the destination block.
        /// </summary>
        public BasicBlock To { get; }

        /// <summary>
        /// Gets the branch condition.
        /// </summary>
        public BoundExpression Condition { get; }

        /// <inheritdoc/>
        public override string ToString()
        {
            if (Condition == null)
            {
                return string.Empty;
            }

            return Condition.ToString();
        }
    }

    /// <summary>
    /// Basic block builder.
    /// </summary>
    public sealed class BasicBlockBuilder
    {
        private readonly List<BoundStatement> statements = [];
        private readonly List<BasicBlock> blocks = [];

        /// <summary>
        /// Builds a basic block from the provided bound block statement and adds
        /// it to the list of known blocks.
        /// </summary>
        /// <param name="block">The bound block statement.</param>
        /// <returns>A basic block.</returns>
        public List<BasicBlock> Build(BoundBlockStatement block)
        {
            foreach (var statement in block.Statements)
            {
                switch (statement.Kind)
                {
                    case BoundNodeKind.LabelStatement:
                        StartBlock();
                        statements.Add(statement);
                        break;
                    case BoundNodeKind.GotoStatement:
                    case BoundNodeKind.ConditionalGotoStatement:
                    case BoundNodeKind.ReturnStatement:
                        statements.Add(statement);
                        StartBlock();
                        break;
                    case BoundNodeKind.VariableDeclaration:
                    case BoundNodeKind.LocalFunctionDeclaration:
                    case BoundNodeKind.ExpressionStatement:
                        statements.Add(statement);
                        break;
                    case BoundNodeKind.PatternSwitchStatement:
                        statements.Add(statement);

                        // An exhaustive switch (default present and every arm
                        // returns/throws) terminates the block like a return;
                        // otherwise it falls through to the next statement.
                        if (SwitchAlwaysReturns((BoundPatternSwitchStatement)statement))
                        {
                            StartBlock();
                        }

                        break;
                    case BoundNodeKind.TryStatement:
                    case BoundNodeKind.ThrowStatement:
                    case BoundNodeKind.GoStatement:
                    case BoundNodeKind.ChannelSendStatement:
                    case BoundNodeKind.SelectStatement:
                    case BoundNodeKind.ScopeStatement:
                    case BoundNodeKind.FixedStatement:
                    case BoundNodeKind.AwaitForRangeStatement:
                    case BoundNodeKind.YieldStatement:
                        // Treat exception-flow constructs as opaque statements; precise
                        // CFG modeling of catch/finally edges is deferred to a later phase.
                        // GoStatement and ChannelSendStatement fall through to the next
                        // statement at the CFG level. A FixedStatement carries a pinned
                        // body that likewise falls through to the following statement.
                        statements.Add(statement);
                        break;
                    default:
                        throw new Exception($"Unexpected statement: {statement.Kind}");
                }
            }

            EndBlock();

            return blocks.ToList();
        }

        private void StartBlock()
        {
            EndBlock();
        }

        private void EndBlock()
        {
            if (statements.Count > 0)
            {
                var block = new BasicBlock();
                block.Statements.AddRange(statements);
                blocks.Add(block);
                statements.Clear();
            }
        }
    }

    /// <summary>
    /// Graph builder.
    /// </summary>
    public sealed class GraphBuilder
    {
        private readonly Dictionary<BoundLabel, BasicBlock> blockFromLabel = [];
        private readonly List<BasicBlockBranch> branches = [];
        private readonly BasicBlock start = new BasicBlock(isStart: true);
        private readonly BasicBlock end = new BasicBlock(isStart: false);

        /// <summary>
        /// Builds a control flow graph from the provided list of basic blocks.
        /// </summary>
        /// <param name="blocks">The list of basic blocks.</param>
        /// <returns>A control flow graph.</returns>
        public ControlFlowGraph Build(List<BasicBlock> blocks)
        {
            if (!blocks.Any())
            {
                Connect(start, end);
            }
            else
            {
                Connect(start, blocks.First());
            }

            foreach (var block in blocks)
            {
                foreach (var statement in block.Statements)
                {
                    if (statement is BoundLabelStatement labelStatement)
                    {
                        blockFromLabel.Add(labelStatement.Label, block);
                    }
                }
            }

            for (int i = 0; i < blocks.Count; i++)
            {
                var current = blocks[i];
                var next = i == blocks.Count - 1 ? end : blocks[i + 1];

                foreach (var statement in current.Statements)
                {
                    var isLastStatementInBlock = statement == current.Statements.Last();
                    switch (statement.Kind)
                    {
                        case BoundNodeKind.GotoStatement:
                            var gs = (BoundGotoStatement)statement;
                            Connect(current, ResolveLabelTarget(gs.Label, blockFromLabel, end));
                            break;
                        case BoundNodeKind.ConditionalGotoStatement:
                            var cgs = (BoundConditionalGotoStatement)statement;
                            var thenBlock = ResolveLabelTarget(cgs.Label, blockFromLabel, end);
                            var elseBlock = next;
                            var negatedCondition = Negate(cgs.Condition);
                            var thenCondition = cgs.JumpIfTrue ? cgs.Condition : negatedCondition;
                            var elseCondition = cgs.JumpIfTrue ? negatedCondition : cgs.Condition;
                            Connect(current, thenBlock, thenCondition);
                            Connect(current, elseBlock, elseCondition);
                            break;
                        case BoundNodeKind.ReturnStatement:
                            Connect(current, end);
                            break;
                        case BoundNodeKind.PatternSwitchStatement:
                            // An exhaustive switch (default present and every arm
                            // returns/throws) terminates control like a return and
                            // connects to the end block. A non-exhaustive switch may
                            // fall through to the next statement (issue #1596).
                            if (SwitchAlwaysReturns((BoundPatternSwitchStatement)statement))
                            {
                                Connect(current, end);
                            }
                            else if (isLastStatementInBlock)
                            {
                                Connect(current, next);
                            }

                            break;
                        case BoundNodeKind.VariableDeclaration:
                        case BoundNodeKind.LocalFunctionDeclaration:
                        case BoundNodeKind.LabelStatement:
                        case BoundNodeKind.ExpressionStatement:
                        case BoundNodeKind.TryStatement:
                        case BoundNodeKind.GoStatement:
                        case BoundNodeKind.ChannelSendStatement:
                        case BoundNodeKind.SelectStatement:
                        case BoundNodeKind.ScopeStatement:
                        case BoundNodeKind.FixedStatement:
                        case BoundNodeKind.AwaitForRangeStatement:
                        case BoundNodeKind.YieldStatement:
                            // Issue #798: `yield` (ADR-0040) participates in the
                            // CFG as a fall-through to the next statement; the
                            // iterator state-machine rewriter (`IteratorRewriter`
                            // / `AsyncIteratorRewriter`) later lowers it on the
                            // emit path. Without this arm the gsc interpreter
                            // path (`Compilation.Evaluate`) — which runs CFG
                            // visualization on iterator bodies prior to running
                            // the iterator rewriter — would throw GS9998
                            // "Unexpected statement: YieldStatement" instead of
                            // interpreting the iterator.
                            if (isLastStatementInBlock)
                            {
                                Connect(current, next);
                            }

                            break;
                        case BoundNodeKind.ThrowStatement:
                            // Throws transfer control to a catch handler or unwind out
                            // of the function; treat as terminator.
                            Connect(current, end);
                            break;
                        default:
                            throw new Exception($"Unexpected statement: {statement.Kind}");
                    }
                }
            }

            RemoveUnreachableBlocks(blocks);

            blocks.Insert(0, start);
            blocks.Add(end);

            return new ControlFlowGraph(start, end, blocks, branches);
        }

        private void RemoveUnreachableBlocks(List<BasicBlock> blocks)
        {
            // ponytail: single-pass worklist replacing the old goto-restart
            // scan (was O(n^2)). Peels blocks whose incoming-branch count
            // hits zero, cascading through their outgoing edges, same fixpoint
            // as the original "remove and rescan" loop.
            var removed = new HashSet<BasicBlock>();
            var queue = new Queue<BasicBlock>();
            foreach (var block in blocks)
            {
                if (!block.Incoming.Any())
                {
                    removed.Add(block);
                    queue.Enqueue(block);
                }
            }

            while (queue.Count > 0)
            {
                var block = queue.Dequeue();
                foreach (var branch in block.Outgoing)
                {
                    branch.To.Incoming.Remove(branch);
                    if (!removed.Contains(branch.To) && !branch.To.Incoming.Any())
                    {
                        removed.Add(branch.To);
                        queue.Enqueue(branch.To);
                    }
                }
            }

            if (removed.Count == 0)
            {
                return;
            }

            branches.RemoveAll(branch => removed.Contains(branch.From) || removed.Contains(branch.To));
            blocks.RemoveAll(block => removed.Contains(block));
        }

        /// <summary>
        /// Resolves a goto/conditional-goto's target label to the basic block
        /// that declares it, or <paramref name="end"/> when the label is not
        /// declared anywhere in the region this graph was built over.
        /// </summary>
        /// <remarks>
        /// <para>Issue #2360: several analyses (<see cref="RefStructAsyncLivenessAnalyzer"/>,
        /// <see cref="RefKindDefiniteAssignmentAnalyzer"/>) build a fresh, narrowly
        /// scoped <see cref="ControlFlowGraph"/> over just one nested compound
        /// statement's body — a <c>try</c>/<c>catch</c>/<c>finally</c> block, a
        /// <c>select</c> case, a <c>scope</c>, or a <c>fixed</c> body — because the
        /// outer graph treats those as single opaque statements (issue #1642). A
        /// <c>goto</c> lexically inside such a region can legitimately target a
        /// label declared <em>outside</em> it: the async lowering pipeline's
        /// generalized try/finally-with-return funnel (<see cref="Lowering.Lowerer"/>'s
        /// <c>RewriteReturnStatement</c>/<c>WrapWithMethodExitEpilogue</c>) rewrites a
        /// <c>return</c> inside a protected region into exactly this shape — a
        /// <c>goto</c> to a synthesized exit label placed after the whole
        /// enclosing statement, i.e. outside the try body's own region. The same
        /// applies to a user <c>break</c>/<c>continue</c> lowered to a <c>goto</c>
        /// past a loop that encloses (but is not entirely inside) the region.</para>
        /// <para>Such a label is, from the narrow region's point of view,
        /// indistinguishable from any other exit out of the region — exactly like
        /// a <c>return</c> or <c>throw</c>, which already connect straight to
        /// <paramref name="end"/> (see the switch above). Routing an unresolved
        /// label to <paramref name="end"/> keeps every synthesized branch target
        /// meaningful to the analysis (the region-scoped liveness/assignment
        /// fixpoint folds in whatever is live/assigned past the region, via each
        /// analyzer's own <c>liveOutOfRegion</c>/<c>isFunctionBody</c> plumbing)
        /// instead of throwing <see cref="KeyNotFoundException"/> and crashing the
        /// compiler (GS9998) the moment a by-ref-like local or an <c>out</c>
        /// parameter happens to make either analyzer examine the region.</para>
        /// </remarks>
        /// <param name="label">The goto/conditional-goto's target label.</param>
        /// <param name="blockFromLabel">The label-to-block map for this region.</param>
        /// <param name="end">This graph's end block.</param>
        /// <returns>The declaring block, or <paramref name="end"/> if the label escapes the region.</returns>
        private static BasicBlock ResolveLabelTarget(BoundLabel label, Dictionary<BoundLabel, BasicBlock> blockFromLabel, BasicBlock end)
        {
            return blockFromLabel.TryGetValue(label, out var block) ? block : end;
        }

        private void Connect(BasicBlock from, BasicBlock to, BoundExpression condition = null)
        {
            if (condition is BoundLiteralExpression l)
            {
                var value = (bool)l.Value;
                if (value)
                {
                    condition = null;
                }
                else
                {
                    return;
                }
            }

            var branch = new BasicBlockBranch(from, to, condition);
            from.Outgoing.Add(branch);
            to.Incoming.Add(branch);
            branches.Add(branch);
        }

        private BoundExpression Negate(BoundExpression condition)
        {
            if (condition is BoundLiteralExpression literal)
            {
                var value = (bool)literal.Value;
                return new BoundLiteralExpression(null, !value);
            }

            var op = BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool);
            return new BoundUnaryExpression(null, op, condition);
        }
    }
}
