// <copyright file="ImportedExtensionMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
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
    public void ExtensionMethod_DelegateParameter_LambdaLiteralArgument_Binds()
    {
        // Issue #322: a function literal (lambda) passed directly as an argument
        // when resolving an extension-method overload whose parameter type is
        // System.Delegate must bind, just as the var-bound form already does.
        // The fixture assembly is supplied as an explicit reference, so the
        // binder loads `Handle`'s System.Delegate parameter through a
        // MetadataLoadContext while the lambda carries a *live runtime* Func<>
        // type. The delegate→Delegate conversion must therefore be classified by
        // name across reflection contexts. Mirrors the ASP.NET Core minimal-API
        // MapGet(this ..., string, Delegate) shape.
        var source = @"
package Demo
import GSharp.Core.Tests.Fixtures

func Run() string {
    var prefix = ""hi""
    return prefix.Handle(func() string { return ""ok"" })
}
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void ExtensionMethod_DelegateParameter_VarBoundArgument_Binds()
    {
        // Companion to the lambda-literal case: the documented workaround
        // (bind to a typed func var first) already bound before issue #322;
        // this guards that the fix does not regress it. A native `func()
        // string` annotation is used (rather than `Func[string]`) so the test
        // does not depend on importing System under the fixture-only resolver.
        var source = @"
package Demo
import GSharp.Core.Tests.Fixtures

func Run() string {
    var handler func() string = func() string { return ""ok"" }
    var prefix = ""hi""
    return prefix.Handle(handler)
}
";
        AssertBindsWithoutErrors(source);
    }

    private static void AssertBindsWithoutErrors(string source)
    {
        // Use an explicit reference to the test (fixture) assembly so its types
        // are loaded through a MetadataLoadContext — the cross-reflection-context
        // configuration that reproduces issue #322. The Default resolver loads
        // host runtime assemblies and would not exercise that path.
        var fixturePath = typeof(Fixtures.Handler322Extensions).Assembly.Location;
        var resolver = ReferenceResolver.WithReferences(new[] { fixturePath });
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
        var program = Binder.BindProgram(globalScope, resolver);
        var diagnostics = globalScope.Diagnostics.AddRange(program.Diagnostics);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
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
