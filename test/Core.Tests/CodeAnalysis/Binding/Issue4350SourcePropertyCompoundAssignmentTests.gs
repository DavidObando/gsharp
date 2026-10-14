// <copyright file="Issue4350SourcePropertyCompoundAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #4350: source members precede an imported base during compound writes.
class Issue4350SourcePropertyCompoundAssignmentTests {
    @Fact
    func PrivateSetterProperty_OnImportedBaseSubclass_BindsAndMutates() {
        let result = EmittedOracle.Evaluate(`import GSharp.Core.CodeAnalysis.Binding

class Counter : BoundTreeWalker {
    internal prop Hits int32 {
        get;
        private set;
    }

    override func VisitExpression(node BoundExpression) {
        this.Hits += 1
    }

    func Read() int32 -> Hits
}

var counter = Counter{}
counter.VisitExpression(default(BoundExpression))
var answer = counter.Read()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.ReadGlobals()["answer"])
    }
}
