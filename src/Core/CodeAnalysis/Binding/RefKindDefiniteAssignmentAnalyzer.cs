#nullable disable

// <copyright file="RefKindDefiniteAssignmentAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0060 items #4 and #5: definite-assignment analysis specialized
/// for ref-kind parameters.
/// <list type="bullet">
///   <item>GS0238 — every <c>out</c> parameter must be definitely assigned on
///     every path that reaches a <c>return</c> (or falls off the function
///     end for <c>void</c> bodies).</item>
///   <item>GS0239 — a variable passed via <c>ref</c> (NOT <c>out</c>) at a
///     call site must be definitely assigned at that point.</item>
/// </list>
/// The analyzer builds a <see cref="ControlFlowGraph"/> for the function body
/// and runs a forward "must be assigned" data-flow with intersect-meet over
/// predecessors. Reads are checked before writes apply within a basic block,
/// so a single statement that both writes and reads the same variable is
/// classified using the set at the start of that statement.
/// </summary>
internal static class RefKindDefiniteAssignmentAnalyzer
{
    public static void Analyze(BoundBlockStatement body, FunctionSymbol function, DiagnosticBag diagnostics)
    {
        if (body == null || function == null)
        {
            return;
        }

        ControlFlowGraph graph;
        try
        {
            graph = ControlFlowGraph.Create(body);
        }
        catch
        {
            return;
        }

        // Seed: every non-out parameter (including ref/in) is assigned on entry.
        var initialAssigned = new HashSet<VariableSymbol>();
        foreach (var p in function.Parameters)
        {
            if (p.RefKind != RefKind.Out)
            {
                initialAssigned.Add(p);
            }
        }

        var outParams = function.Parameters.Where(p => p.RefKind == RefKind.Out).ToImmutableArray();

        // Block entry sets.
        var entryAssigned = new Dictionary<ControlFlowGraph.BasicBlock, HashSet<VariableSymbol>>();
        var exitAssigned = new Dictionary<ControlFlowGraph.BasicBlock, HashSet<VariableSymbol>>();

        // Initialize: all blocks start with the universal set (intersection
        // identity), except the start block which carries the initial
        // assigned-on-entry parameter set.
        foreach (var b in graph.Blocks)
        {
            entryAssigned[b] = b.IsStart ? new HashSet<VariableSymbol>(initialAssigned) : null;
            exitAssigned[b] = null;
        }

        // Worklist iteration. We don't report diagnostics during fixed-point
        // computation — only on a final pass once entry sets have converged.
        var worklist = new Queue<ControlFlowGraph.BasicBlock>();
        worklist.Enqueue(graph.Start);
        var changed = true;
        var safety = 0;
        while (changed && safety++ < 10000)
        {
            changed = false;
            foreach (var block in graph.Blocks)
            {
                if (block.IsEnd)
                {
                    continue;
                }

                // Compute entry as intersection over predecessors' exits.
                HashSet<VariableSymbol> entry;
                if (block.IsStart)
                {
                    entry = new HashSet<VariableSymbol>(initialAssigned);
                }
                else
                {
                    entry = null;
                    foreach (var incoming in block.Incoming)
                    {
                        var predExit = exitAssigned[incoming.From];
                        if (predExit == null)
                        {
                            continue;
                        }

                        if (entry == null)
                        {
                            entry = new HashSet<VariableSymbol>(predExit);
                        }
                        else
                        {
                            entry.IntersectWith(predExit);
                        }
                    }

                    if (entry == null)
                    {
                        entry = new HashSet<VariableSymbol>(initialAssigned);
                    }
                }

                var prevEntry = entryAssigned[block];
                if (prevEntry != null && SetsEqual(prevEntry, entry))
                {
                    // No change to entry — re-compute exit if necessary.
                }
                else
                {
                    entryAssigned[block] = entry;
                    changed = true;
                }

                var exit = SimulateBlock(block, new HashSet<VariableSymbol>(entryAssigned[block]), null);
                var prevExit = exitAssigned[block];
                if (prevExit == null || !SetsEqual(prevExit, exit))
                {
                    exitAssigned[block] = exit;
                    changed = true;
                }
            }
        }

        // Final reporting pass.
        foreach (var block in graph.Blocks)
        {
            if (block.IsStart || block.IsEnd)
            {
                continue;
            }

            var entry = entryAssigned[block] ?? new HashSet<VariableSymbol>(initialAssigned);
            SimulateBlock(block, new HashSet<VariableSymbol>(entry), diagnostics);
        }

        // Item #4: at the function exit, check all out parameters are assigned.
        // We report at the last statement of each predecessor of the end block.
        if (!outParams.IsDefaultOrEmpty)
        {
            foreach (var endBranch in graph.End.Incoming)
            {
                var fromBlock = endBranch.From;
                var exit = exitAssigned[fromBlock] ?? new HashSet<VariableSymbol>(initialAssigned);
                foreach (var op in outParams)
                {
                    if (!exit.Contains(op))
                    {
                        var loc = GetReportLocation(fromBlock, function);
                        diagnostics.ReportOutParameterNotAssigned(loc, op.Name);
                    }
                }
            }
        }
    }

    private static TextLocation GetReportLocation(ControlFlowGraph.BasicBlock block, FunctionSymbol function)
    {
        for (var i = block.Statements.Count - 1; i >= 0; i--)
        {
            var stmt = block.Statements[i];
            if (stmt?.Syntax is { } syn)
            {
                return syn.Location;
            }
        }

        return function.Declaration?.Location ?? default(TextLocation);
    }

    private static bool SetsEqual(HashSet<VariableSymbol> a, HashSet<VariableSymbol> b)
    {
        if (a.Count != b.Count)
        {
            return false;
        }

        foreach (var v in a)
        {
            if (!b.Contains(v))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Walks a basic block linearly, updating <paramref name="assigned"/>
    /// in place. When <paramref name="diagnostics"/> is non-null, reports
    /// GS0239 at every detected unassigned-before-ref read. Returns the
    /// exit set.
    /// </summary>
    private static HashSet<VariableSymbol> SimulateBlock(
        ControlFlowGraph.BasicBlock block,
        HashSet<VariableSymbol> assigned,
        DiagnosticBag diagnostics)
    {
        foreach (var statement in block.Statements)
        {
            ProcessStatement(statement, assigned, diagnostics);
        }

        return assigned;
    }

    private static void ProcessStatement(BoundStatement statement, HashSet<VariableSymbol> assigned, DiagnosticBag diagnostics)
    {
        switch (statement)
        {
            case BoundExpressionStatement es:
                ProcessExpression(es.Expression, assigned, diagnostics);
                break;
            case BoundVariableDeclaration vd:
                if (vd.Initializer != null)
                {
                    ProcessExpression(vd.Initializer, assigned, diagnostics);

                    // Synthesised default expressions (BoundDefaultExpression)
                    // emitted for `var x T` without an explicit initializer
                    // should NOT count as definite assignment — Roslyn DA
                    // treats `int x;` as unassigned for the same reason.
                    if (vd.Initializer is not BoundDefaultExpression)
                    {
                        assigned.Add(vd.Variable);
                    }
                }

                break;
            case BoundReturnStatement rs:
                if (rs.Expression != null)
                {
                    ProcessExpression(rs.Expression, assigned, diagnostics);
                }

                break;
            case BoundConditionalGotoStatement cgs:
                ProcessExpression(cgs.Condition, assigned, diagnostics);
                break;
            case BoundLabelStatement:
            case BoundGotoStatement:
                break;
            default:
                // For other statements, walk top-level expressions if any.
                // We deliberately avoid recursing into nested blocks (CFG
                // already flattened them) but do walk child expressions of
                // unmodeled statements via reflection-free best-effort.
                break;
        }
    }

    private static void ProcessExpression(BoundExpression expression, HashSet<VariableSymbol> assigned, DiagnosticBag diagnostics)
    {
        if (expression == null)
        {
            return;
        }

        switch (expression)
        {
            case BoundCallExpression call:
                // Process arguments; for ref/out arguments, the read/write
                // semantics interact with definite assignment.
                for (var i = 0; i < call.Arguments.Length; i++)
                {
                    var arg = call.Arguments[i];
                    ParameterSymbol parameter = i < call.Function.Parameters.Length ? call.Function.Parameters[i] : null;

                    if (parameter != null && parameter.RefKind != RefKind.None
                        && arg is BoundAddressOfExpression addr
                        && addr.Operand is BoundVariableExpression bve)
                    {
                        if (parameter.RefKind == RefKind.Ref && !assigned.Contains(bve.Variable))
                        {
                            diagnostics?.ReportVariableNotAssignedBeforeRef(arg.Syntax?.Location ?? call.Syntax?.Location ?? default(TextLocation), bve.Variable.Name);
                        }

                        // Both ref and out arg-positions count as writes (the
                        // callee may overwrite). 'in' is a read only.
                        if (parameter.RefKind == RefKind.Ref || parameter.RefKind == RefKind.Out)
                        {
                            assigned.Add(bve.Variable);
                        }
                    }
                    else
                    {
                        ProcessExpression(arg, assigned, diagnostics);
                    }
                }

                break;
            case BoundAssignmentExpression assign:
                ProcessExpression(assign.Expression, assigned, diagnostics);
                assigned.Add(assign.Variable);
                break;
            case BoundBinaryExpression bin:
                ProcessExpression(bin.Left, assigned, diagnostics);
                ProcessExpression(bin.Right, assigned, diagnostics);
                break;
            case BoundUnaryExpression un:
                ProcessExpression(un.Operand, assigned, diagnostics);
                break;
            case BoundAddressOfExpression aof:
                ProcessExpression(aof.Operand, assigned, diagnostics);
                break;
            case BoundDereferenceExpression deref:
                ProcessExpression(deref.Operand, assigned, diagnostics);
                break;
            case BoundConversionExpression conv:
                ProcessExpression(conv.Expression, assigned, diagnostics);
                break;
            default:
                break;
        }
    }
}
