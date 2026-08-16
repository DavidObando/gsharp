// <copyright file="ProtectedRegionBranchAnalysis.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Records branch targets and their enclosing protected try regions.
/// </summary>
internal sealed class ProtectedRegionBranchAnalysis
{
    private readonly Dictionary<BoundLabel, ImmutableArray<BoundTryStatement>> labelRegions;

    private ProtectedRegionBranchAnalysis(
        Dictionary<BoundLabel, ImmutableArray<BoundTryStatement>> labelRegions,
        List<Branch> branches)
    {
        this.labelRegions = labelRegions;
        Branches = branches;
    }

    public IReadOnlyList<Branch> Branches { get; }

    public bool HasEscapingBranch
    {
        get
        {
            foreach (var branch in Branches)
            {
                if (!labelRegions.ContainsKey(branch.Target))
                {
                    return true;
                }
            }

            return false;
        }
    }

    public static ProtectedRegionBranchAnalysis Create(BoundStatement body)
    {
        var walker = new Walker();
        walker.VisitStatement(body);
        return new ProtectedRegionBranchAnalysis(walker.LabelRegions, walker.Branches);
    }

    public bool ContainsLabel(BoundLabel label)
        => labelRegions.ContainsKey(label);

    public bool TryGetLabelRegions(
        BoundLabel label,
        out ImmutableArray<BoundTryStatement> regions)
        => labelRegions.TryGetValue(label, out regions);

    internal readonly struct Branch
    {
        public Branch(
            BoundStatement statement,
            BoundLabel target,
            ImmutableArray<BoundTryStatement> regions)
        {
            Statement = statement;
            Target = target;
            Regions = regions;
        }

        public BoundStatement Statement { get; }

        public BoundLabel Target { get; }

        public ImmutableArray<BoundTryStatement> Regions { get; }
    }

    private sealed class Walker : BoundTreeWalker
    {
        private readonly List<BoundTryStatement> tryStack = new();

        public Dictionary<BoundLabel, ImmutableArray<BoundTryStatement>> LabelRegions { get; } = new();

        public List<Branch> Branches { get; } = new();

        public override void VisitStatement(BoundStatement? node)
        {
            if (node == null)
            {
                return;
            }

            switch (node)
            {
                case BoundLabelStatement label:
                    LabelRegions[label.Label] = tryStack.ToImmutableArray();
                    return;
                case BoundGotoStatement go:
                    Branches.Add(new Branch(go, go.Label, tryStack.ToImmutableArray()));
                    return;
                case BoundConditionalGotoStatement conditional:
                    Branches.Add(new Branch(conditional, conditional.Label, tryStack.ToImmutableArray()));
                    break;
            }

            base.VisitStatement(node);
        }

        protected override void VisitTryStatement(BoundTryStatement node)
        {
            tryStack.Add(node);
            VisitStatement(node.TryBlock);
            tryStack.RemoveAt(tryStack.Count - 1);

            foreach (var clause in node.CatchClauses)
            {
                VisitStatement(clause.Body);
            }

            if (node.FinallyBlock != null)
            {
                VisitStatement(node.FinallyBlock);
            }
        }
    }
}
