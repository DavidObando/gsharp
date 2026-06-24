// <copyright file="Issue1030InterfaceStaticMembersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0089 / issue #1030 — interface static *state* (storage) and
/// default-bodied static-virtual interface *properties* (follow-up to #1019).
/// Pins binder behaviour: interface <c>var</c>/<c>let</c>/<c>const</c> fields
/// bind, qualified <c>IName.Field</c> read/write binds, a default-bodied
/// static interface property binds and does NOT require an implementer, and
/// assigning a <c>let</c>/<c>const</c> interface field is rejected.
/// </summary>
public class Issue1030InterfaceStaticMembersTests
{
    [Fact]
    public void InterfaceStaticState_VarLetConst_Binds()
    {
        var source = @"
interface ICounter {
  shared {
    var Count int32 = 0
    let Label string = ""c""
    const Max int32 = 100
  }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void QualifiedReadAndWrite_Binds()
    {
        var source = @"
interface ICounter {
  shared {
    var Count int32 = 0
  }
}

func Bump() int32 {
  ICounter.Count = ICounter.Count + 1
  return ICounter.Count
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void AssignToConstInterfaceField_ReportsCannotAssign()
    {
        var source = @"
interface ICounter {
  shared {
    const Max int32 = 100
  }
}

func Bad() {
  ICounter.Max = 5
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0127");
    }

    [Fact]
    public void DefaultBodiedStaticProperty_ImplementerNotRequired()
    {
        // A fully default-bodied static-virtual interface property is satisfied
        // by the interface itself; an implementer that omits it is NOT flagged
        // with GS0397.
        var source = @"
sealed interface IData {
  shared {
    prop Name string { get { return ""default"" } }
  }
}

struct Apple : IData {
}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0397");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GenericInterfaceStaticState_StillReportsGS0330()
    {
        // Generic interface static fields require per-construction storage and
        // remain out of scope; rejected with a refined GS0330.
        var source = @"
sealed interface IBox[T] {
  shared {
    var Slot int32
  }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0330");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
