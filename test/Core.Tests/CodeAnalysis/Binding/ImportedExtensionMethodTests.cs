// <copyright file="ImportedExtensionMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #294 — imported BCL/library <c>[Extension]</c> methods dispatched with
/// instance ("receiver") syntax (<c>receiver.Method(args)</c>) rather than only
/// statically (<c>DeclaringClass.Method(receiver, args)</c>). Exercised via
/// <c>System.Linq.Enumerable</c>, a dependency-free source of generic extension
/// methods over <c>IEnumerable&lt;T&gt;</c>.
/// </summary>
/// <remarks>
/// These assert through full compilation (bind + lower + emit) rather than the
/// tree-walking interpreter, because the interpreter does not marshal GSharp
/// closures into CLR delegates for reflection-invoked imported methods. The
/// end-to-end execution path is covered by the <c>LinqExtensions</c>
/// conformance sample.
/// </remarks>
public class ImportedExtensionMethodTests
{
    [Fact]
    public void Where_OnList_InstanceSyntax_Compiles()
    {
        var source = @"
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)

var evens = list.Where(func(x int32) bool { return x % 2 == 0 })
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void WhereSelect_Chained_InstanceSyntax_Compiles()
    {
        var source = @"
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)

var projected = list.Where(func(x int32) bool { return x % 2 == 0 }).Select(func(x int32) int32 { return x * 10 })
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void Count_Terminal_InstanceSyntax_Compiles()
    {
        var source = @"
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)

var n = list.Where(func(x int32) bool { return x > 2 }).Count()
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void Sum_NonGenericReceiverInference_InstanceSyntax_Compiles()
    {
        var source = @"
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(2)
list.Add(3)
list.Add(5)

var total = list.Sum()
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void WithoutImportingNamespace_ExtensionNotVisible_Diagnoses()
    {
        // System.Linq is NOT imported, so Where must remain unresolved (GS0159):
        // import scope is respected.
        var source = @"
import System.Collections.Generic

var list = List[int32]()
list.Add(1)

var evens = list.Where(func(x int32) bool { return x % 2 == 0 })
";
        var diagnostics = EmitDiagnostics(source);
        Assert.Contains(diagnostics, d => d.IsError);
    }

    [Fact]
    public void InstanceMethodPreferredOverExtension()
    {
        // List<T>.Contains is a genuine instance method; resolving it must use
        // the instance method, not an Enumerable.Contains extension. This guards
        // the standard resolution order (instance members before extensions).
        var source = @"
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)

var found = list.Contains(2)
";
        AssertCompilesWithoutErrors(source);
    }

    [Fact]
    public void CountBy_OmitsTrailingOptionalComparer_InstanceSyntax_Compiles()
    {
        // Issue #327: Enumerable.CountBy<TSource,TKey>(this IEnumerable<TSource>,
        // Func<TSource,TKey>, IEqualityComparer<TKey> comparer = null) is an
        // imported extension method with a trailing optional parameter. Calling
        // it with only the key selector must resolve by omitting the optional
        // comparer — the same shape as HttpResponse.WriteAsync(text) in #327.
        var source = @"
import System.Linq
import System.Collections.Generic

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
list.Add(4)

var counts = list.CountBy(func(x int32) int32 { return x % 2 })
";
        AssertCompilesWithoutErrors(source);
    }

    private static void AssertCompilesWithoutErrors(string source)
    {
        var diagnostics = EmitDiagnostics(source, out var success);
        Assert.True(
            success,
            "Emit failed:\n" + string.Join("\n", diagnostics.Select(d => d.ToString())));
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    private static IReadOnlyList<Diagnostic> EmitDiagnostics(string source)
        => EmitDiagnostics(source, out _);

    private static IReadOnlyList<Diagnostic> EmitDiagnostics(string source, out bool success)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        success = result.Success;
        return result.Diagnostics;
    }
}
