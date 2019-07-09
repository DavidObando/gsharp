// <copyright file="ControlFlowGraph.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Control flow analyzer.
    /// </summary>
    internal sealed class ControlFlowGraph
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
                if (lastStatement == null || lastStatement.Kind != BoundNodeKind.ReturnStatement)
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
                return "\"" + text.Replace("\"", "\\\"") + "\"";
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
                var label = Quote(block.ToString().Replace(Environment.NewLine, "\\l"));
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
            public List<BoundStatement> Statements { get; } = new List<BoundStatement>();

            /// <summary>
            /// Gets the list of incoming branches to this block.
            /// </summary>
            public List<BasicBlockBranch> Incoming { get; } = new List<BasicBlockBranch>();

            /// <summary>
            /// Gets the list of outgoing branches from this block.
            /// </summary>
            public List<BasicBlockBranch> Outgoing { get; } = new List<BasicBlockBranch>();

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
                    foreach (var statement in Statements)
                    {
                        statement.WriteTo(writer);
                    }

                    return writer.ToString();
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
            private readonly List<BoundStatement> statements = new List<BoundStatement>();
            private readonly List<BasicBlock> blocks = new List<BasicBlock>();

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
                        case BoundNodeKind.ExpressionStatement:
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
            private readonly Dictionary<BoundStatement, BasicBlock> blockFromStatement = new Dictionary<BoundStatement, BasicBlock>();
            private readonly Dictionary<BoundLabel, BasicBlock> blockFromLabel = new Dictionary<BoundLabel, BasicBlock>();
            private readonly List<BasicBlockBranch> branches = new List<BasicBlockBranch>();
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
                        blockFromStatement.Add(statement, block);
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
                                var toBlock = blockFromLabel[gs.Label];
                                Connect(current, toBlock);
                                break;
                            case BoundNodeKind.ConditionalGotoStatement:
                                var cgs = (BoundConditionalGotoStatement)statement;
                                var thenBlock = blockFromLabel[cgs.Label];
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
                            case BoundNodeKind.VariableDeclaration:
                            case BoundNodeKind.LabelStatement:
                            case BoundNodeKind.ExpressionStatement:
                                if (isLastStatementInBlock)
                                {
                                    Connect(current, next);
                                }

                                break;
                            default:
                                throw new Exception($"Unexpected statement: {statement.Kind}");
                        }
                    }
                }

            ScanAgain:
                foreach (var block in blocks)
                {
                    if (!block.Incoming.Any())
                    {
                        RemoveBlock(blocks, block);
                        goto ScanAgain;
                    }
                }

                blocks.Insert(0, start);
                blocks.Add(end);

                return new ControlFlowGraph(start, end, blocks, branches);
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

            private void RemoveBlock(List<BasicBlock> blocks, BasicBlock block)
            {
                foreach (var branch in block.Incoming)
                {
                    branch.From.Outgoing.Remove(branch);
                    branches.Remove(branch);
                }

                foreach (var branch in block.Outgoing)
                {
                    branch.To.Incoming.Remove(branch);
                    branches.Remove(branch);
                }

                blocks.Remove(block);
            }

            private BoundExpression Negate(BoundExpression condition)
            {
                if (condition is BoundLiteralExpression literal)
                {
                    var value = (bool)literal.Value;
                    return new BoundLiteralExpression(!value);
                }

                var op = BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool);
                return new BoundUnaryExpression(op, condition);
            }
        }
    }
}
