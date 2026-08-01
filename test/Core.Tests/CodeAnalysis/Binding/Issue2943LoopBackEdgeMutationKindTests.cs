// <copyright file="Issue2943LoopBackEdgeMutationKindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Guards issue #2943's member-path mutation classification against new
/// call- or assignment-shaped bound expression kinds.
/// </summary>
public class Issue2943LoopBackEdgeMutationKindTests
{
    [Fact]
    public void CallAndAssignmentShapedKinds_AreClassifiedAsPotentiallyMutating()
    {
        var uncovered = Enum.GetValues<BoundNodeKind>()
            .Where(IsCallOrAssignmentShaped)
            .Where(kind => !StatementBinder.IsPotentiallyMutatingMemberPathExpression(kind))
            .ToArray();

        Assert.Empty(uncovered);
    }

    private static bool IsCallOrAssignmentShaped(BoundNodeKind kind)
    {
        var name = kind.ToString();

        // Plain variable assignment is handled by exact root identity.
        return name.EndsWith("CallExpression", StringComparison.Ordinal)
            || (kind != BoundNodeKind.AssignmentExpression
                && name.EndsWith("AssignmentExpression", StringComparison.Ordinal))
            || name.EndsWith("InvocationExpression", StringComparison.Ordinal);
    }
}
