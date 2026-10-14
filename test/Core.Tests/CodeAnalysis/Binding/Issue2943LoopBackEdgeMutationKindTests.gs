// <copyright file="Issue2943LoopBackEdgeMutationKindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import System
import System.Linq
import Xunit

/// Guards issue #2943's member-path mutation classification against new
/// call- or assignment-shaped bound expression kinds.
open class Issue2943LoopBackEdgeMutationKindTests {
    @Fact
    func CallAndAssignmentShapedKinds_AreClassifiedAsPotentiallyMutating() {
        let uncovered = Enum
            .GetValues[BoundNodeKind]()
            .Where(IsCallOrAssignmentShaped)
            .Where((kind BoundNodeKind) -> !StatementBinder.IsPotentiallyMutatingMemberPathExpression(kind))
            .ToArray()
        Assert.Empty(uncovered)
    }

    shared {
        private func IsCallOrAssignmentShaped(kind BoundNodeKind) bool {
            let name = kind.ToString()
            // Plain variable assignment is handled by exact root identity.
            return name.EndsWith("CallExpression", StringComparison.Ordinal) ||
                (
                kind != BoundNodeKind.AssignmentExpression && name.EndsWith(
                    "AssignmentExpression",
                    StringComparison.Ordinal
                )
            ) ||
                name.EndsWith("InvocationExpression", StringComparison.Ordinal)
        }
    }
}
