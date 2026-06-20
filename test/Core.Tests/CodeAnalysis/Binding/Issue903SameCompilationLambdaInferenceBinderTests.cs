// <copyright file="Issue903SameCompilationLambdaInferenceBinderTests.cs" company="GSharp">
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
/// Issue #903 — an un-typed arrow lambda (<c>(c) -&gt; …</c>) passed to a
/// generic LINQ extension method whose receiver's generic element type is a
/// <em>same-compilation</em> user type (a <c>struct</c> or <c>class</c> being
/// compiled in the same source, e.g. <c>List[Check]</c>) must infer its
/// parameter type from that element symbol so the call resolves and the
/// predicate/projection body type-checks.
/// <para>
/// On the base compiler this reported <c>GS0159</c> (cannot find function),
/// <c>GS0304</c> (cannot infer the type of lambda parameter), and <c>GS0158</c>
/// (cannot find member) because the element type has no CLR <see cref="Type"/>
/// yet (it is still being compiled), so the reflection-driven inference path
/// lost the element identity. The fix recovers it symbolically from the
/// receiver's generic type arguments. Sibling assemblies (CLR reference element
/// types) were already covered by issue #666; these tests pin the
/// same-compilation case for both <c>struct</c> and <c>class</c> elements.
/// </para>
/// <para>
/// Element types are uniquely named per test method on purpose: a delegate
/// function-type such as <c>(Check) -&gt; bool</c> is interned process-wide by
/// its display name, so reusing a single name across in-process compilations
/// would alias a stale element symbol from a previous test.
/// </para>
/// </summary>
public class Issue903SameCompilationLambdaInferenceBinderTests
{
    [Fact]
    public void Struct_UntypedLambda_Single_Binds()
    {
        var source = @"
package Probe
import System.Collections.Generic
import System.Linq

struct Check903SingleS { let Id string }

var checks = List[Check903SingleS]()
checks.Add(Check903SingleS { Id: ""network"" })
var net = checks.Single((c) -> c.Id == ""network"")
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void Struct_UntypedLambda_Where_Binds()
    {
        var source = @"
package Probe
import System.Collections.Generic
import System.Linq

struct Check903WhereS { let Id string }

var checks = List[Check903WhereS]()
checks.Add(Check903WhereS { Id: ""network"" })
var filtered = checks.Where((c) -> c.Id == ""network"").ToList()
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void Struct_UntypedLambda_SelectProjectingToString_Binds()
    {
        var source = @"
package Probe
import System.Collections.Generic
import System.Linq

struct Check903SelectS { let Id string }

var checks = List[Check903SelectS]()
checks.Add(Check903SelectS { Id: ""network"" })
var ids = checks.Select((c) -> c.Id).ToHashSet()
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void Class_UntypedLambda_Single_Binds()
    {
        var source = @"
package Probe
import System.Collections.Generic
import System.Linq

class Check903SingleC { let Id string }

var checks = List[Check903SingleC]()
checks.Add(Check903SingleC { Id: ""network"" })
var net = checks.Single((c) -> c.Id == ""network"")
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void Class_UntypedLambda_SelectProjectingToString_Binds()
    {
        var source = @"
package Probe
import System.Collections.Generic
import System.Linq

class Check903SelectC { let Id string }

var checks = List[Check903SelectC]()
checks.Add(Check903SelectC { Id: ""network"" })
var ids = checks.Select((c) -> c.Id).ToHashSet()
";
        AssertBindsWithoutErrors(source);
    }

    [Fact]
    public void Struct_ExplicitlyTypedLambda_Single_Binds()
    {
        // The explicitly-typed parameter form must keep binding cleanly; on the
        // base compiler it regressed alongside the untyped form because the
        // same-compilation Func<Check,bool> argument had no CLR backing.
        var source = @"
package Probe
import System.Collections.Generic
import System.Linq

struct Check903TypedS { let Id string }

var checks = List[Check903TypedS]()
checks.Add(Check903TypedS { Id: ""network"" })
var net = checks.Single((c Check903TypedS) -> c.Id == ""network"")
";
        AssertBindsWithoutErrors(source);
    }

    private static void AssertBindsWithoutErrors(string source)
    {
        // Reference the full BCL through a MetadataLoadContext so
        // System.Linq.Enumerable's generic extension methods are discoverable,
        // mirroring the issue #666 harness. The element types under test are
        // declared in-source (same compilation), which is the #903 scenario.
        var paths = new List<string>();
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
