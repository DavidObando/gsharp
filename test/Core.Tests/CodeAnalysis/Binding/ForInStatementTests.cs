// <copyright file="ForInStatementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 7.2 — canonical <c>for v in collection</c> and <c>await for v in stream</c> binding.
/// </summary>
public class ForInStatementTests
{
    [Fact]
    public void ForIn_OverArray_YieldsValuesInSourceOrder()
    {
        var source = @"
var arr = [3]int32{1, 2, 3}
var folded = 0
for v in arr {
    folded = (folded * 10) + v
}
folded
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(123, result.Value);
    }

    [Fact]
    public void ForIn_OverSlice_YieldsStrings()
    {
        var source = @"
var xs = []string{""a"", ""b"", ""c""}
var s = """"
for v in xs {
    s = s + v
}
s
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("abc", result.Value);
    }

    [Fact]
    public void ForIn_OverDictionary_YieldsKeysAndValues()
    {
        var source = @"
import System.Collections.Generic

var dict = Dictionary[string, int32]()
dict[""a""] = 1
dict[""bb""] = 2
var total = 0
var keyChars = 0
for k, v in dict {
    total = total + v
    keyChars = keyChars + len(k)
}
(total * 10) + keyChars
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(33, result.Value);
    }

    [Fact]
    public void ForIn_OverList_UsesEnumerablePath()
    {
        var source = @"
import System.Collections.Generic

var list = List[int32]()
list.Add(4)
list.Add(5)
list.Add(6)
var sum = 0
for v in list {
    sum = sum + v
}
sum
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(15, result.Value);
    }

    [Fact]
    public void ForIn_OverClrPatternEnumerable_UsesGetEnumeratorPattern()
    {
        var source = @"
import GSharp.Core.Tests.CodeAnalysis.Binding

var sum = 0
for v in PatternEnumerableFixture() {
    sum = sum + v
}
sum
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void ForIn_OverUserPatternEnumerable_UsesGetEnumeratorPattern()
    {
        var source = @"
type NumberEnumerator class(Index int32, Current int32) {
    func MoveNext() bool {
        Index = Index + 1
        if Index <= 3 {
            Current = Index * 2
            return true
        }

        return false
    }
}

type Numbers class {
    func GetEnumerator() NumberEnumerator {
        return NumberEnumerator(0, 0)
    }
}

var sum = 0
for v in Numbers{} {
    sum = sum + v
}
sum
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void AwaitForIn_OverAsyncEnumerable_YieldsValues()
    {
        var source = @"
import GSharp.Core.Tests.CodeAnalysis.Binding

var total = 0
await for v in AsyncStreamFixture.Counts() {
    total = total + v
}
total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void LegacyForRange_StillBinds()
    {
        var source = @"
var xs = []int32{1, 2, 3}
var sum = 0
for v in xs {
    sum = sum + v
}
sum
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void LegacyAwaitForRange_StillBinds()
    {
        var source = @"
import GSharp.Core.Tests.CodeAnalysis.Binding

var total = 0
await for v in AsyncStreamFixture.Counts() {
    total = total + v
}
total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ForIn_OverNonIterable_Diagnoses()
    {
        var source = @"
for v in 42 {
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void In_RemainsRegularIdentifier()
    {
        var source = @"
let in = 1
in + 2
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}

/// <summary>CLR fixture exposing the C# foreach pattern without implementing <see cref="IEnumerable{T}"/>.</summary>
public sealed class PatternEnumerableFixture
{
    /// <summary>Creates a new pattern enumerator.</summary>
    /// <returns>The enumerator.</returns>
    public PatternEnumerator GetEnumerator() => new();
}

/// <summary>Enumerator for <see cref="PatternEnumerableFixture"/>.</summary>
public sealed class PatternEnumerator
{
    private readonly int[] values = { 2, 4, 6 };
    private int index = -1;

    /// <summary>Gets the current element.</summary>
    public int Current { get; private set; }

    /// <summary>Moves to the next element.</summary>
    /// <returns>True when an element is available.</returns>
    public bool MoveNext()
    {
        index++;
        if (index >= values.Length)
        {
            return false;
        }

        Current = values[index];
        return true;
    }
}
