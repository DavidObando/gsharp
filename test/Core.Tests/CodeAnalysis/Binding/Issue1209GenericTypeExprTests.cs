// <copyright file="Issue1209GenericTypeExprTests.cs" company="GSharp">
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
/// Issue #1209 — a generic-type reference with explicit type arguments used in
/// expression / member-access receiver position (<c>Box[int32].Default</c>,
/// <c>Comparer[int32].Default</c>) must bind as the constructed generic type,
/// not as element access on a variable (which previously produced
/// <c>GS0125 Variable 'Box' doesn't exist</c>). The disambiguation must NOT
/// regress genuine indexing (<c>arr[i]</c>, <c>dict[key]</c>), which still
/// binds as element access because the target resolves to a value.
/// </summary>
public class Issue1209GenericTypeExprTests
{
    [Fact]
    public void UserGenericStaticField_BindsAsConstructedType()
    {
        var source = @"
class Box[T] {
  shared {
    let Default int32 = 0
  }
}

func F() int32 {
  return Box[int32].Default
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void UserGenericStaticProperty_BindsAsConstructedType()
    {
        var source = @"
class Box[T] {
  shared {
    prop Value int32 { get { return 11 } }
  }
}

func F() int32 {
  return Box[int32].Value
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void UserGenericStaticMethod_BindsAsConstructedType()
    {
        var source = @"
class Box[T] {
  shared {
    func Make() int32 { return 7 }
  }
}

func F() int32 {
  return Box[int32].Make()
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BclGenericStaticMember_Comparer_BindsAsConstructedType()
    {
        var source = @"
import System.Collections.Generic

func F() int32 {
  return Comparer[int32].Default.Compare(1, 2)
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ArrayIndexing_StillBindsAsElementAccess()
    {
        var source = @"
func F() int32 {
  var a = [3]int32{10, 20, 30}
  a[0] = 99
  return a[1]
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DictionaryIndexing_StillBindsAsElementAccess()
    {
        var source = @"
import System.Collections.Generic

func F() int32 {
  var d = map[string,int32]{}
  d[""a""] = 1
  return d[""a""]
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IndexingWithVariableSubscript_StillBindsAsElementAccess()
    {
        var source = @"
func F() int32 {
  var a = [3]int32{10, 20, 30}
  var sum = 0
  for var i = 0; i < a.Length; i++ {
    sum = sum + a[i]
  }

  return sum
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void UnknownGenericTypeReference_StillReportsDiagnostic()
    {
        // A name that is neither a value nor a known generic type must not be
        // silently accepted as a constructed generic receiver.
        var source = @"
func F() int32 {
  return Nope[int32].Default
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
