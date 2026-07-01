// <copyright file="Issue1507SliceArrayUntypedLambdaInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1507 — target-typed inference of an UNTYPED arrow-lambda parameter
/// (<c>(i) -&gt; …</c>) passed to a LINQ / imported extension method must be
/// driven by the matching delegate parameter when the receiver is a G# slice
/// (<c>[]T</c>) or array (<c>[N]T</c>), exactly as it already is for a
/// <c>List[T]</c> receiver. On the base compiler the lambda parameter was never
/// target-typed for a slice/array receiver — the extension probe in
/// <c>ResolveDeferredArrowLambdaArguments</c> is gated on a non-null receiver
/// <c>ClrType</c>, which a slice/array receiver lacks — so the call reported
/// <c>GS0159</c> (cannot find function), <c>GS0304</c> (cannot infer the type of
/// lambda parameter) and, for a user element, <c>GS0158</c> (cannot find
/// member). The fix normalizes a slice/array receiver to a symbolic
/// <c>IEnumerable[elementType]</c> purely for the deferred-lambda inference,
/// recovering the element type for the untyped lambda parameter.
/// <para>
/// Element / package names are unique per test method on purpose: a delegate
/// function-type such as <c>(Item) -&gt; bool</c> is interned process-wide by
/// its display name, so reusing a single name across in-process compilations
/// would alias a stale element symbol from a previous test.
/// </para>
/// </summary>
public class Issue1507SliceArrayUntypedLambdaInferenceTests
{
    [Fact]
    public void Slice_UserStruct_UntypedWhere_InfersElementType()
    {
        var source = @"
package Probe1507WhereS
import System
import System.Linq

data struct Item1507WhereS { var V int32 }

func f(xs []Item1507WhereS) int32 { return xs.Where((i) -> i.V > 0).Count() }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
        AssertOnlyLambdaParameterType(program, "Item1507WhereS");
    }

    [Fact]
    public void Slice_UserStruct_UntypedSelect_InfersElementType()
    {
        var source = @"
package Probe1507SelectS
import System
import System.Linq

data struct Item1507SelectS { var V int32 }

func f(xs []Item1507SelectS) int32 { return xs.Select((i) -> i.V).Sum() }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
        AssertOnlyLambdaParameterType(program, "Item1507SelectS");
    }

    [Fact]
    public void Slice_UserStruct_UntypedOrderBy_InfersElementType()
    {
        var source = @"
package Probe1507OrderByS
import System
import System.Linq

data struct Item1507OrderByS { var V int32 }

func f(xs []Item1507OrderByS) int32 { return xs.OrderBy((i) -> i.V).First().V }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
        AssertOnlyLambdaParameterType(program, "Item1507OrderByS");
    }

    [Fact]
    public void Slice_PrimitiveInt32_UntypedWhere_InfersInt32()
    {
        var source = @"
package Probe1507WhereInt
import System
import System.Linq

func f(xs []int32) int32 { return xs.Where((i) -> i > 0).Count() }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
        AssertOnlyLambdaParameterType(program, "int32");
    }

    [Fact]
    public void Slice_PrimitiveString_UntypedWhere_InfersString()
    {
        var source = @"
package Probe1507WhereStr
import System
import System.Linq

func f(xs []string) int32 { return xs.Where((s) -> s.Length > 3).Count() }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
        AssertOnlyLambdaParameterType(program, "string");
    }

    [Fact]
    public void Array_UserStruct_UntypedWhere_InfersElementType()
    {
        var source = @"
package Probe1507ArrWhereS
import System
import System.Linq

data struct Item1507ArrWhereS { var V int32 }

func f(xs [3]Item1507ArrWhereS) int32 { return xs.Where((i) -> i.V > 0).Count() }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
        AssertOnlyLambdaParameterType(program, "Item1507ArrWhereS");
    }

    [Fact]
    public void Slice_UserStruct_ChainedWhereWhereCount_Binds()
    {
        var source = @"
package Probe1507Chain
import System
import System.Linq

data struct Item1507Chain { var V int32 }

func f(xs []Item1507Chain) int32 { return xs.Where((i) -> i.V > 0).Where((i) -> i.V < 10).Count() }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
        // Both chained untyped lambdas must infer the element type.
        AssertOnlyLambdaParameterType(program, "Item1507Chain");
    }

    [Fact]
    public void Slice_UserStruct_ChainedSelectWhereSum_Binds()
    {
        var source = @"
package Probe1507SelectWhere
import System
import System.Linq

data struct Item1507SelectWhere { var V int32 }

func f(xs []Item1507SelectWhere) int32 { return xs.Select((i) -> i.V).Where((v) -> v > 0).Sum() }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
        var paramTypes = CollectLambdaParameterTypeNames(program);
        // Select's lambda parameter is the element type; Where's lambda parameter
        // is the projected int32 — both must be recovered (never `object`).
        Assert.Contains("Item1507SelectWhere", paramTypes);
        Assert.Contains("int32", paramTypes);
        Assert.DoesNotContain("object", paramTypes);
    }

    [Fact]
    public void Regression_Slice_ExplicitlyTypedLambda_StillBinds()
    {
        var source = @"
package Probe1507Explicit
import System
import System.Linq

data struct Item1507Explicit { var V int32 }

func f(xs []Item1507Explicit) int32 { return xs.Where((i Item1507Explicit) -> i.V > 0).Count() }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
        AssertOnlyLambdaParameterType(program, "Item1507Explicit");
    }

    [Fact]
    public void Regression_Slice_NonLambdaExtensionCall_StillBinds()
    {
        var source = @"
package Probe1507NoLambda
import System
import System.Linq

data struct Item1507NoLambda { var V int32 }

func f(xs []Item1507NoLambda) int32 { return xs.Count() }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
    }

    [Fact]
    public void Regression_List_UntypedWhere_StillInfersElementType()
    {
        var source = @"
package Probe1507List
import System
import System.Linq
import System.Collections.Generic

data struct Item1507List { var V int32 }

func f(xs List[Item1507List]) int32 { return xs.Where((i) -> i.V > 0).Count() }
";
        var program = BindProgram(source);
        AssertNoErrors(program);
        AssertOnlyLambdaParameterType(program, "Item1507List");
    }

    private static void AssertNoErrors(BoundProgram program)
    {
        Assert.DoesNotContain(program.Diagnostics, d => d.IsError);
    }

    private static void AssertOnlyLambdaParameterType(BoundProgram program, string expectedElementTypeName)
    {
        var names = CollectLambdaParameterTypeNames(program);
        Assert.NotEmpty(names);
        Assert.All(names, n => Assert.Equal(expectedElementTypeName, n));
    }

    private static List<string> CollectLambdaParameterTypeNames(BoundProgram program)
    {
        var literals = new List<BoundFunctionLiteralExpression>();
        var visited = new HashSet<object>(ReferenceEqualityComparer.Instance);

        foreach (var body in program.Functions.Values)
        {
            Collect(body, literals, visited);
        }

        if (program.Statement != null)
        {
            Collect(program.Statement, literals, visited);
        }

        var names = new List<string>();
        foreach (var literal in literals)
        {
            Assert.NotNull(literal.FunctionType);
            Assert.NotEmpty(literal.FunctionType.ParameterTypes);
            names.Add(literal.FunctionType.ParameterTypes[0]?.Name);
        }

        return names;
    }

    // Reflection walk over the bound tree: descend through every public
    // BoundNode-typed property and every enumerable of BoundNodes, collecting
    // the bound arrow-lambda literals. Symbols are never BoundNodes, so the walk
    // terminates without cycles.
    private static void Collect(BoundNode node, List<BoundFunctionLiteralExpression> literals, HashSet<object> visited)
    {
        if (node == null || !visited.Add(node))
        {
            return;
        }

        if (node is BoundFunctionLiteralExpression literal)
        {
            literals.Add(literal);
        }

        foreach (var property in node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (property.GetIndexParameters().Length > 0)
            {
                continue;
            }

            object value;
            try
            {
                value = property.GetValue(node);
            }
            catch (TargetInvocationException)
            {
                continue;
            }

            if (value is BoundNode child)
            {
                Collect(child, literals, visited);
            }
            else if (value is IEnumerable enumerable && value is not string)
            {
                // A default (uninitialized) ImmutableArray boxes to IEnumerable
                // but throws on enumeration; skip such properties defensively.
                IEnumerator enumerator;
                try
                {
                    enumerator = enumerable.GetEnumerator();
                }
                catch (InvalidOperationException)
                {
                    continue;
                }

                while (true)
                {
                    try
                    {
                        if (!enumerator.MoveNext())
                        {
                            break;
                        }
                    }
                    catch (InvalidOperationException)
                    {
                        break;
                    }

                    if (enumerator.Current is BoundNode boundItem)
                    {
                        Collect(boundItem, literals, visited);
                    }
                }
            }
        }
    }

    private static BoundProgram BindProgram(string source)
    {
        // Reference the full BCL through a MetadataLoadContext so
        // System.Linq.Enumerable's generic extension methods are discoverable,
        // mirroring the issue #666 / #903 harness.
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
        var globalScope = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(globalScope, resolver);
        return program;
    }
}
