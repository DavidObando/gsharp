// <copyright file="Issue666LinqExtensionOnClrRefTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #666: LINQ extension methods (Where, Select, FirstOrDefault, ToArray,
/// AsEnumerable) called via instance syntax on IEnumerable&lt;T&gt;/List&lt;T&gt;
/// must work when T is a CLR reference type from a project-referenced (non-BCL)
/// assembly loaded through <see cref="System.Reflection.MetadataLoadContext"/>.
/// </summary>
public class Issue666LinqExtensionOnClrRefTypeTests
{
    [Fact]
    public void Where_OnList_ClrRefElement_InstanceSyntax_Binds()
    {
        var source = @"
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.Where(func(i Issue666ItemCls) bool { return true })
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void Select_OnList_ClrRefElement_InstanceSyntax_Binds()
    {
        var source = @"
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.Select(func(i Issue666ItemCls) string { return i.Name })
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void FirstOrDefault_OnList_ClrRefElement_InstanceSyntax_Binds()
    {
        var source = @"
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.FirstOrDefault()
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void ToArray_OnList_ClrRefElement_InstanceSyntax_Binds()
    {
        var source = @"
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var arr = xs.ToArray()
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void AsEnumerable_OnList_ClrRefElement_InstanceSyntax_Binds()
    {
        var source = @"
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.AsEnumerable()
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void WhereSelectChain_ClrRefElement_InstanceSyntax_Binds()
    {
        var source = @"
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.Where(func(i Issue666ItemCls) bool { return true }).Select(func(i Issue666ItemCls) string { return i.Name })
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void AsEnumerableWhere_ClrRefElement_InstanceSyntax_Binds()
    {
        var source = @"
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = xs.AsEnumerable().Where(func(i Issue666ItemCls) bool { return true })
";
        AssertBindsWithoutErrors(source);
    }

    // --- Regression guards: BCL types (should already pass) ---

    [Fact]
    public void Where_OnList_String_InstanceSyntax_Binds()
    {
        var source = @"
package Probe
import System.Collections.Generic
import System.Linq

var xs = List[string]()
xs.Add(""hello"")
var q = xs.Where(func(s string) bool { return true })
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void Where_OnList_Int32_InstanceSyntax_Binds()
    {
        var source = @"
package Probe
import System.Collections.Generic
import System.Linq

var xs = List[int32]()
xs.Add(1)
var q = xs.Where(func(x int32) bool { return x > 0 })
";
        AssertBindsWithoutErrors(source);
    }

    // --- Regression guard: explicit static form (the #320 workaround) ---

    [Fact]
    public void Where_ExplicitStatic_ClrRefElement_Binds()
    {
        var source = @"
package Probe
import GSharp.Core.Tests.Fixtures
import System.Collections.Generic
import System.Linq

var xs = List[Issue666ItemCls]()
xs.Add(Issue666ItemCls())
var q = Enumerable.Where[Issue666ItemCls](xs, func(i Issue666ItemCls) bool { return true })
";
        AssertBindsWithoutErrors(source);
    }

    private static void AssertBindsWithoutErrors(string source)
    {
        // Load the test assembly (which contains the Issue666ItemCls fixture)
        // plus all BCL assemblies through a MetadataLoadContext, reproducing
        // the cross-context configuration that triggers issue #666.
        var fixturePath = typeof(Fixtures.Issue666ItemCls).Assembly.Location;
        List<string> paths = [fixturePath];

        // Include BCL assemblies so System.Linq.Enumerable is discoverable.
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (!string.IsNullOrEmpty(tpa))
        {
            foreach (var p in tpa.Split(Path.PathSeparator))
            {
                if (!string.IsNullOrWhiteSpace(p) && File.Exists(p))
                {
                    paths.Add(p);
                }
            }
        }

        using var resolver = ReferenceResolver.WithReferences(paths);
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
        var program = Binder.BindProgram(globalScope, resolver);
        var diagnostics = globalScope.Diagnostics.AddRange(program.Diagnostics);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }
}
