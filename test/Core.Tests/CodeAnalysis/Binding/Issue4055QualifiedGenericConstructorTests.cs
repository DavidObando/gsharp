// <copyright file="Issue4055QualifiedGenericConstructorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4055: a fully-qualified generic CLR type followed by a constructor
/// argument list must use the same qualified type walk and constructor binding
/// as its static-member and unqualified-constructor spellings.
/// </summary>
public sealed class Issue4055QualifiedGenericConstructorTests
{
    [Fact]
    public void FullyQualifiedNullableDefaultConstruction_Executes()
    {
        var result = EmittedOracle.Evaluate(
            """
            package P
            import System

            Console.WriteLine(System.Nullable[int32]().HasValue)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal($"False{System.Environment.NewLine}", result.Output);
    }

    [Fact]
    public void MultiSegmentGenericReferenceTypeConstruction_Executes()
    {
        var result = EmittedOracle.Evaluate(
            """
            package P
            import System

            let values = System.Collections.Generic.List[int32]()
            values.Add(7)
            Console.WriteLine(values[0])
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal($"7{System.Environment.NewLine}", result.Output);
    }

    [Fact]
    public void NestedGenericTypeArguments_Executes()
    {
        var result = EmittedOracle.Evaluate(
            """
            package P
            import System

            let values = System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[int32]]()
            values["x"] = System.Collections.Generic.List[int32]()
            values["x"].Add(9)
            Console.WriteLine(values["x"][0])
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal($"9{System.Environment.NewLine}", result.Output);
    }

    [Fact]
    public void NonGenericQualifiedConstructor_StillExecutes()
    {
        var result = EmittedOracle.Evaluate(
            """
            package P
            import System

            let value = System.Text.StringBuilder("ok")
            Console.WriteLine(value.ToString())
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal($"ok{System.Environment.NewLine}", result.Output);
    }

    [Fact]
    public void QualifiedGenericObjectInitializerReceiver_Executes()
    {
        var result = EmittedOracle.Evaluate(
            """
            package P
            import System

            Console.WriteLine(System.Collections.Generic.KeyValuePair[int32, string](){}.Key)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal($"0{System.Environment.NewLine}", result.Output);
    }

    [Fact]
    public void MissingGenericType_ReportsTerminalTypeNotNamespace()
    {
        var diagnostic = Assert.Single(Errors(
            """
            package P

            let value = System.Collections.Generic.Missing[int32]().Count
            """));

        Assert.Equal("GS0157", diagnostic.Id);
        Assert.Equal(
            "Cannot find type 'Missing' in namespace 'System.Collections.Generic'. Are you missing an import?",
            diagnostic.Message);
        Assert.Equal("Missing", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void InapplicableGenericConstructor_ReportsOverloadNotNamespace()
    {
        var diagnostics = Errors(
            """
            package P

            let value = System.Collections.Generic.List[int32]("not-capacity").Count
            """);

        Assert.Equal(new[] { "GS0267" }, diagnostics.Select(diagnostic => diagnostic.Id));
    }

    [Fact]
    public void MissingMemberOnQualifiedGenericType_StillReportsMember()
    {
        var diagnostic = Assert.Single(Errors(
            """
            package P

            System.Collections.Generic.List[int32].Missing()
            """));

        Assert.Equal("GS0159", diagnostic.Id);
        Assert.Equal("Cannot find function Missing.", diagnostic.Message);
    }

    [Fact]
    public void NamespaceAndSourceTypeCollision_StillBindsClrConstruction()
    {
        var result = EmittedOracle.Evaluate(
            """
            package P
            import System

            class System {
            }

            Console.WriteLine(System.Nullable[int32]().HasValue)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal($"False{System.Environment.NewLine}", result.Output);
    }

    [Fact]
    public void QualifiedGenericStaticMember_StillExecutes()
    {
        var result = EmittedOracle.Evaluate(
            """
            package P
            import System

            Console.WriteLine(System.Collections.Generic.Comparer[int32].Default.Compare(1, 2))
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal($"-1{System.Environment.NewLine}", result.Output);
    }

    [Fact]
    public void QualifiedGenericTypeClause_StillBinds()
    {
        Assert.Empty(Errors(
            """
            package P

            var value System.Nullable[int32]
            """));
    }

    [Fact]
    public void QualifiedSourceConstructor_StillExecutes()
    {
        var result = EmittedOracle.Evaluate(
            """
            package P
            import System

            class Box {
                prop Value int32 -> 13
            }

            let box = P.Box()
            Console.WriteLine(box.Value)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal($"13{System.Environment.NewLine}", result.Output);
    }

    private static Diagnostic[] Errors(string source)
        => EmittedOracle.Evaluate(source).Diagnostics
            .Where(diagnostic => diagnostic.IsError)
            .ToArray();
}
