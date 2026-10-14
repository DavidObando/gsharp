// <copyright file="Issue3076SpillSequenceSpillerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable
import System.Reflection
import Xunit

class Issue3076SpillSequenceSpillerTests {
    @Fact
    func GenericStaticClrAssignmentPreservesContainerWhenAwaitIsSpilled() {
        let staticContainerType = TypeSymbol.String
        let member PropertyInfo? = typeof(GenericStaticSlot[_]).GetProperty("Value")
        let assignment = BoundClrPropertyAssignmentExpression(
            syntax: nil,
            receiver: BoundLiteralExpression(nil, 0),
            member!!,
            BoundAwaitExpression(nil, BoundLiteralExpression(nil, 1), TypeSymbol.Int32),
            TypeSymbol.Int32,
            staticContainerType: staticContainerType
        )
        let body = BoundBlockStatement(
            syntax: nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, assignment))
        )
        let rewritten = SpillSequenceSpiller.Rewrite(body)
        let statement = Assert.IsType[BoundExpressionStatement](rewritten.Statements[^1])
        let rewrittenAssignment = Assert.IsType[BoundClrPropertyAssignmentExpression](statement.Expression)
        Assert.Same(staticContainerType, rewrittenAssignment.StaticContainerType)
    }

    private shared class GenericStaticSlot[T] {
        prop Value int32
    }
}
