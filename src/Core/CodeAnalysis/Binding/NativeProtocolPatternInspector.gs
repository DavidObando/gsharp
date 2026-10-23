// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic

internal class NativeProtocolPatternInspector(
    $scope BoundScope,
    source TypeSymbol?,
    location TextLocation
) : BoundTreeWalker {
    internal prop HasProtocolTests bool {
        get;
        private set;
    }
    internal prop HasConcreteTests bool {
        get;
        private set;
    }
    private let targets HashSet[TypeSymbol] = HashSet[TypeSymbol]()
    internal prop Targets HashSet[TypeSymbol] -> targets

    protected override func VisitTypePattern(node BoundTypePattern) {
        if NativeProtocolOperations.GetProtocol(node.TargetType) is {} target {
            HasProtocolTests = true
            targets.Add(target)
            if source is {} sourceProtocol {
                NativeProtocolOperations.RequireCoverage($scope, sourceProtocol, target, location)
            }
        } else {
            HasConcreteTests = true
        }
        base.VisitTypePattern(node)
    }
}
