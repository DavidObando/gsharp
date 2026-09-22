// <copyright file="Issue4350SourcePropertyCompoundAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #4350: source members precede an imported base during compound writes.</summary>
public sealed class Issue4350SourcePropertyCompoundAssignmentTests
{
    [Fact]
    public void PrivateSetterProperty_OnImportedBaseSubclass_BindsAndMutates()
    {
        var result = EmittedOracle.Evaluate("""
            import GSharp.Core.CodeAnalysis.Binding

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
            var answer = counter.Read()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.ReadGlobals()["answer"]);
    }
}
