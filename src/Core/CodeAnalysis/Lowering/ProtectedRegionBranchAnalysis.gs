// <copyright file="ProtectedRegionBranchAnalysis.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis.Binding
import System.Collections.Generic
import System.Collections.Immutable

/// Records branch targets and their enclosing protected try regions.
internal class ProtectedRegionBranchAnalysis {
    private let labelRegions Dictionary[BoundLabel, ImmutableArray[BoundTryStatement]]

    private init(labelRegions Dictionary[BoundLabel, ImmutableArray[BoundTryStatement]], branches List[Branch]) {
        this.labelRegions = labelRegions
        Branches = branches
    }

    prop Branches IReadOnlyList[Branch] {
        get;
    }

    prop HasEscapingBranch bool {
        get {
            for branch in Branches {
                if !labelRegions.ContainsKey(branch.Target) {
                    return true
                }
            }
            return false
        }
    }

    func ContainsLabel(label BoundLabel) bool -> labelRegions.ContainsKey(label)

    func TryGetLabelRegions(
        label BoundLabel,
        out regions ImmutableArray[BoundTryStatement]
    ) bool -> labelRegions.TryGetValue(label, out regions)

    internal struct Branch {
        init(statement BoundStatement, target BoundLabel, regions ImmutableArray[BoundTryStatement]) {
            Statement = statement
            Target = target
            Regions = regions
        }

        prop Statement BoundStatement {
            get;
        }

        prop Target BoundLabel {
            get;
        }

        prop Regions ImmutableArray[BoundTryStatement] {
            get;
        }
    }

    private class Walker : BoundTreeWalker {
        init() {
            LabelRegions = Dictionary[BoundLabel, ImmutableArray[BoundTryStatement]]()
            Branches = List[Branch]()
        }

        private let tryStack List[BoundTryStatement] = List[BoundTryStatement]()

        prop LabelRegions Dictionary[BoundLabel, ImmutableArray[BoundTryStatement]] {
            get;
        }

        prop Branches List[Branch] {
            get;
        }

        override func VisitStatement(node BoundStatement?) {
            if node == nil {
                return
            }
            switch node {
                case label is BoundLabelStatement {
                    LabelRegions[label.Label] = tryStack.ToImmutableArray()
                    return
                }
                case go_ is BoundGotoStatement {
                    Branches.Add(Branch(go_, go_.Label, tryStack.ToImmutableArray()))
                    return
                }
                case conditional is BoundConditionalGotoStatement {
                    Branches.Add(Branch(conditional, conditional.Label, tryStack.ToImmutableArray()))
                }
            }
            base.VisitStatement(node)
        }

        protected override func VisitTryStatement(node BoundTryStatement) {
            tryStack.Add(node)
            VisitStatement(node.TryBlock)
            tryStack.RemoveAt(tryStack.Count - 1)
            for clause in node.CatchClauses {
                VisitStatement(clause.Body)
            }
            if node.FinallyBlock != nil {
                VisitStatement(node.FinallyBlock)
            }
        }
    }

    shared {
        func Create(body BoundStatement) ProtectedRegionBranchAnalysis {
            let walker = ProtectedRegionBranchAnalysis.Walker()
            walker.VisitStatement(body)
            return ProtectedRegionBranchAnalysis(walker.LabelRegions, walker.Branches)
        }
    }
}
