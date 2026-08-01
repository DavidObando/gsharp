// <copyright file="Issue3015ImportedBaseIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3015: imported-base backing objects must retain the derived G# type
/// identity without breaking inherited CLR member dispatch.
/// </summary>
public class Issue3015ImportedBaseIdentityTests
{
    [Fact]
    public void OrdinaryConstruction_PreservesDerivedTypeIdentity()
    {
        const string Source = """
            package Issue3015.Identity
            import System

            class OrdinarySentinel : EventArgs {
            }

            var value = OrdinarySentinel()
            Console.WriteLine(value.ToString())
            Console.WriteLine(value.GetType().FullName)
            """;

        Assert.Equal(
            "Issue3015.Identity.OrdinarySentinel\nIssue3015.Identity.OrdinarySentinel\n",
            Evaluate(Source));
    }

    [Fact]
    public void LiteralConstruction_PreservesDerivedTypeIdentity()
    {
        const string Source = """
            package Issue3015.Identity
            import System

            class LiteralSentinel : EventArgs {
            }

            var value = LiteralSentinel{}
            Console.WriteLine(value.ToString())
            Console.WriteLine(value.GetType().FullName)
            """;

        Assert.Equal(
            "Issue3015.Identity.LiteralSentinel\nIssue3015.Identity.LiteralSentinel\n",
            Evaluate(Source));
    }

    [Fact]
    public void OrdinaryConstruction_PreservesImportedBaseMemberDispatch()
    {
        const string Source = """
            package Issue3015.Bridge
            import System
            import System.IO

            class OrdinaryBuffer : MemoryStream {
            }

            Console.WriteLine(OrdinaryBuffer().CanRead)
            """;

        Assert.Equal("True\n", Evaluate(Source));
    }

    [Fact]
    public void LiteralConstruction_PreservesImportedBaseMemberDispatch()
    {
        const string Source = """
            package Issue3015.Bridge
            import System
            import System.IO

            class LiteralBuffer : MemoryStream {
            }

            Console.WriteLine(LiteralBuffer{}.CanRead)
            """;

        Assert.Equal("True\n", Evaluate(Source));
    }

    [Fact]
    public void ExplicitImportedBaseConstructor_PreservesStateAndIdentity()
    {
        const string Source = """
            package Issue3015.Constructor
            import System

            class MessageSentinel(message string) : Exception(message) {
            }

            var value = MessageSentinel("explicit-state-3015")
            Console.WriteLine(value.Message)
            Console.WriteLine(value.GetType().FullName)
            """;

        Assert.Equal(
            "explicit-state-3015\nIssue3015.Constructor.MessageSentinel\n",
            Evaluate(Source));
    }

    [Fact]
    public void OverloadedBaseConstructors_ShareOneDerivedRuntimeType()
    {
        const string Source = """
            package Issue3015.Constructor
            import System
            import GSharp.Interpreter.Tests

            class OverloadedSentinel : Issue3015OverloadedBase {
                init() : base() {
                }

                init(label string) : base(label) {
                }
            }

            var first = OverloadedSentinel()
            var second = OverloadedSentinel("explicit-3015")
            Console.WriteLine(first.Label)
            Console.WriteLine(second.Label)
            Console.WriteLine(Object.ReferenceEquals(first.GetType(), second.GetType()))
            """;

        Assert.Equal(
            "default-3015\nexplicit-3015\nTrue\n",
            Evaluate(Source));
    }

    [Fact]
    public void GenericConstruction_PreservesConstructedTypeIdentity()
    {
        const string Source = """
            package Issue3015.Generic
            import System

            class OrdinaryGenericSentinel[T] : EventArgs {
            }

            class LiteralGenericSentinel[T] : EventArgs {
            }

            Console.WriteLine(OrdinaryGenericSentinel[int32]().ToString())
            Console.WriteLine(LiteralGenericSentinel[string]{}.ToString())
            """;

        Assert.Equal(
            "Issue3015.Generic.OrdinaryGenericSentinel`1[System.Int32]\n"
                + "Issue3015.Generic.LiteralGenericSentinel`1[System.String]\n",
            Evaluate(Source));
    }

    [Fact]
    public void NestedConstruction_PreservesContainingTypeIdentity()
    {
        const string Source = """
            package Issue3015.Nested
            import System

            class Outer {
                class OrdinaryNestedSentinel : EventArgs {
                }

                class LiteralNestedSentinel : EventArgs {
                }
            }

            Console.WriteLine(Outer.OrdinaryNestedSentinel().ToString())
            Console.WriteLine(Outer.LiteralNestedSentinel{}.ToString())
            """;

        Assert.Equal(
            "Issue3015.Nested.Outer+OrdinaryNestedSentinel\n"
                + "Issue3015.Nested.Outer+LiteralNestedSentinel\n",
            Evaluate(Source));
    }

    private static string Evaluate(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));

        using var outWriter = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
            var errors = result.Diagnostics.Where(d => d.IsError).ToArray();
            Assert.True(
                errors.Length == 0,
                "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}

/// <summary>Imported constructor-overload probe for issue #3015.</summary>
public class Issue3015OverloadedBase
{
    /// <summary>Initializes a new instance of the <see cref="Issue3015OverloadedBase"/> class.</summary>
    public Issue3015OverloadedBase()
    {
        Label = "default-3015";
    }

    /// <summary>Initializes a new instance of the <see cref="Issue3015OverloadedBase"/> class.</summary>
    /// <param name="label">Probe label.</param>
    public Issue3015OverloadedBase(string label)
    {
        Label = label;
    }

    /// <summary>Gets constructor probe label.</summary>
    public string Label { get; }
}
