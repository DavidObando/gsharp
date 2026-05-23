// <copyright file="ForRangeStatementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 4 exit (part 3) — <c>for k, v := range coll</c> over arrays,
/// slices, CLR dictionaries, and CLR enumerables.
/// </summary>
public class ForRangeStatementTests
{
    [Fact]
    public void ForRange_OverArray_ValueOnly_Binds()
    {
        var source = @"
import System

var arr = [3]int{10, 20, 30}
for v := range arr {
    Console.WriteLine(v)
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ForRange_OverArray_KeyAndValue_Binds()
    {
        var source = @"
import System

var arr = [3]int{10, 20, 30}
for i, v := range arr {
    Console.WriteLine(i)
    Console.WriteLine(v)
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ForRange_OverList_ValueOnly_Binds()
    {
        var source = @"
import System
import System.Collections.Generic

var lst = List[int]()
lst.Add(1)
lst.Add(2)
for v := range lst {
    Console.WriteLine(v)
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ForRange_OverList_KeyAndValue_Binds()
    {
        var source = @"
import System
import System.Collections.Generic

var lst = List[int]()
lst.Add(7)
for i, v := range lst {
    Console.WriteLine(i)
    Console.WriteLine(v)
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ForRange_OverDictionary_KeyAndValue_Binds()
    {
        var source = @"
import System
import System.Collections.Generic

var d = Dictionary[string, int]()
d[""a""] = 1
d[""b""] = 2
for k, v := range d {
    Console.WriteLine(k)
    Console.WriteLine(v)
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ForRange_BreakAndContinue_Bind()
    {
        var source = @"
import System

var arr = [4]int{1, 2, 3, 4}
for i, v := range arr {
    if v == 2 {
        continue
    }
    if v == 4 {
        break
    }
    Console.WriteLine(v)
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ForRange_OverNonIterable_Diagnoses()
    {
        var source = @"
var x = 42
for v := range x {
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
