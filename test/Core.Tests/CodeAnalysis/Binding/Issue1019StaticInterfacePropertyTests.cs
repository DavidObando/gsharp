// <copyright file="Issue1019StaticInterfacePropertyTests.cs" company="GSharp">
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
/// ADR-0089 / issue #1019 — static-virtual interface *properties*. Pins the
/// binder behaviour for the <c>shared { prop … }</c> interface member shape:
/// the issue repro now binds, the implementer-satisfaction contract is
/// enforced (GS0397), default-bodied static interface properties are rejected
/// (GS0396), and genuine interface static *state* (<c>var</c> / <c>let</c>)
/// is still rejected (GS0330).
/// </summary>
public class Issue1019StaticInterfacePropertyTests
{
    [Fact]
    public void IssueRepro_BareStaticProperty_Binds()
    {
        // The exact #1019 repro must now parse and bind cleanly.
        var source = @"
interface IData {
  shared {
    prop Name string;
  }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GetOnlyStaticProperty_Binds()
    {
        var source = @"
sealed interface IData {
  shared {
    prop SizeInBytes int32 { get; }
  }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GetSetStaticProperty_Binds()
    {
        var source = @"
sealed interface IData {
  shared {
    prop Tag int32 { get; set }
  }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Implementer_WithMatchingStaticProperty_NoDiagnostics()
    {
        var source = @"
sealed interface IData {
  shared {
    prop Name string { get; }
  }
}

struct AppleData : IData {
  shared {
    prop Name string { get { return ""apple"" } }
  }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Implementer_MissingStaticProperty_ReportsGS0397()
    {
        var source = @"
sealed interface IData {
  shared {
    prop Name string { get; }
  }
}

struct AppleData : IData {
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0397");
    }

    [Fact]
    public void Implementer_StaticPropertyMissingGetter_ReportsGS0397()
    {
        var source = @"
sealed interface IData {
  shared {
    prop Name string { get; }
  }
}

struct AppleData : IData {
  shared {
    prop Name string { set { } }
  }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0397");
    }

    [Fact]
    public void DefaultBodiedStaticInterfaceProperty_ReportsGS0396()
    {
        // Default-bodied (with accessor bodies) static interface properties
        // are deferred; declare an abstract slot instead.
        var source = @"
sealed interface IData {
  shared {
    prop Name string { get { return ""x"" } }
  }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0396");
    }

    [Fact]
    public void GenericReadThroughConstraint_Binds()
    {
        var source = @"
sealed interface IData {
  shared {
    prop Name string { get; }
  }
}

struct AppleData : IData {
  shared {
    prop Name string { get { return ""apple"" } }
  }
}

func Describe[T IData](witness T) string {
  return T.Name
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void InterfaceStaticState_Var_StillReportsGS0330()
    {
        // Genuine interface static *state* (storage) remains unsupported.
        var source = @"
sealed interface IData {
  shared {
    var Count int32
  }
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0330");
    }

    [Fact]
    public void InterfaceStaticState_Let_StillReportsGS0330()
    {
        var source = @"
sealed interface IData {
  shared {
    let Count int32 = 0
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
