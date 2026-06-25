// <copyright file="Issue1103ExtensionImportedReceiverTests.cs" company="GSharp">
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
/// Issue #1103 / ADR-0019. An extension function whose receiver type is an
/// imported/BCL or primitive CLR type must be callable with instance/member
/// syntax <c>receiver.ExtMethod(args)</c> from inside a function or method
/// body — not only as a free function <c>ExtMethod(receiver, args)</c> and not
/// only from a top-level statement.
///
/// Two gaps combined to produce GS0159 "Cannot find function":
/// <list type="number">
/// <item><description>Extension functions were folded into
/// <c>BoundGlobalScope.Functions</c> but were re-registered on the rebuilt
/// body-binding scope only as plain functions, so the call-site extension
/// table was empty for any call inside a function/method body
/// (<c>CreateParentScope</c>).</description></item>
/// <item><description><see cref="BoundScope.TryLookupExtensionFunction"/>
/// matched the declared receiver against the call-site receiver by reference
/// equality, which is not robust for imported types whose declaration- and
/// call-site symbols can be distinct instances wrapping the same CLR
/// type.</description></item>
/// </list>
/// Top-level calls and package-owned struct receivers masked the first gap
/// (top-level statements are bound in the declaration pass; struct receivers
/// also register the function as an instance method on the struct), which is
/// why existing extension tests passed while real migrations failed.
/// </summary>
public class Issue1103ExtensionImportedReceiverTests
{
    [Fact]
    public void ImportedBclReferenceReceiver_InMethodBody_Binds()
    {
        const string source = @"
package Issue1103.Bcl
import System.IO

func (stream Stream) ReadU32() uint32 {
    return uint32(5)
}

class C {
    func UseFree(file Stream) uint32 {
        return ReadU32(file)
    }
    func UseInstance(file Stream) uint32 {
        return file.ReadU32()
    }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PrimitiveReceiver_InMethodBody_Binds_And_Executes()
    {
        const string source = @"
package Issue1103.Prim
import System

func (n int32) Doubled() int32 {
    return n * 2
}

class C {
    func UseInt(x int32) int32 {
        return x.Doubled()
    }
}

var c = C()
c.UseInt(21)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ImportedBclReferenceReceiver_InMethodBody_Executes()
    {
        const string source = @"
package Issue1103.BclExec
import System
import System.IO

func (stream Stream) ReadU32() int32 {
    return 5
}

class C {
    func UseInstance(file Stream) int32 {
        return file.ReadU32()
    }
}

var c = C()
var m = MemoryStream()
c.UseInstance(m)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void ClosedGenericImportedReceiver_InMethodBody_Binds_And_Executes()
    {
        const string source = @"
package Issue1103.Gen
import System.Collections.Generic

func (l List[int32]) SumAll() int32 {
    var total = 0
    for x in l {
        total = total + x
    }
    return total
}

class C {
    func Use(items List[int32]) int32 {
        return items.SumAll()
    }
}

var c = C()
var nums = List[int32]()
nums.Add(1)
nums.Add(2)
nums.Add(3)
c.Use(nums)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void PackageOwnedStructReceiver_InMethodBody_StillBinds()
    {
        const string source = @"
package Issue1103.Struct

struct Point {
    var X int32
    var Y int32
}

func (p Point) Sum() int32 {
    return p.X + p.Y
}

class C {
    func Use(p Point) int32 {
        return p.Sum()
    }
}
";
        // Only the expected ADR-0079 GS0314 owned-receiver warning may appear;
        // no GS0159 'cannot find function' error.
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void NoOverMatch_DifferentImportedReceiver_StillReportsGS0159()
    {
        const string source = @"
package Issue1103.NoOverMatch
import System.IO

func (stream Stream) ReadU32() uint32 {
    return uint32(5)
}

class C {
    func Use(w TextWriter) uint32 {
        return w.ReadU32()
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void OpenGenericReceiverUnification_InMethodBody_StillBinds_And_Executes()
    {
        const string source = @"
package Issue1103.OpenGen
import System
import System.Collections.Generic

func (self IEnumerable[T]) MyFirst[T any](fb T) T {
    return fb
}

class C {
    func Use(items []int32) int32 {
        return items.MyFirst(99)
    }
}

var c = C()
c.Use([]int32{10, 20, 30})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    private static IEnumerable<Diagnostic> Bind(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics.ToList();
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
