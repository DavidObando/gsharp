// <copyright file="MultiAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 2.3: <c>a, b = b, a</c> multi-target assignment with sequential
/// evaluation via synthesized temporaries. The short-var multi-decl form
/// <c>a, b := 1, 2</c> was removed by ADR-0077 / issue #717; the parser
/// now emits GS0305 for that spelling — covered by
/// <see cref="GSharp.Core.Tests.CodeAnalysis.Syntax.Issue717ColonEqualsRemovedParserTests"/>.
/// </summary>
public class MultiAssignmentTests
{
    [Fact]
    public void MutableTupleDeconstruction_WithDiscard_Executes()
    {
        var result = EmittedOracle.Evaluate("""
            var kept = 0
            kept, _ = (7, 2)
            kept
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void MultiDecl_AsTwoVarLines_Binds()
    {
        Assert.Empty(Bind("func F() {\n var a = 1\n var b = 2\n var s = a + b\n }\n"));
    }

    [Fact]
    public void MultiAssignment_Swap_Binds()
    {
        Assert.Empty(Bind("func F() {\n var a = 1\n var b = 2\n a, b = b, a\n }\n"));
    }

    [Fact]
    public void MultiAssignment_Three_Way_Binds()
    {
        Assert.Empty(Bind("func F() {\n var a = 1\n var b = 2\n var c = 3\n a, b, c = c, a, b\n }\n"));
    }

    [Fact]
    public void MultiAssignment_Count_Mismatch_Reports_Error()
    {
        var diagnostics = Bind("func F() {\n var a = 1\n var b = 2\n a, b = 1, 2, 3\n }\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("target", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void MultiAssignment_To_Readonly_Reports_Error()
    {
        var diagnostics = Bind("func F() {\n let a = 1\n var b = 2\n a, b = b, a\n }\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("read-only", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void MultiAssignment_To_Undefined_Reports_Error()
    {
        var diagnostics = Bind("func F() {\n var a = 1\n a, missing = 1, 2\n }\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("doesn't exist", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void MultiAssignment_StorageTargets_AndTupleRhs_Bind()
    {
        var diagnostics = Bind("""
            package P

            class Box {
                var Field int32
                prop Value int32 {
                    get { return Field }
                    set(v) { Field = v }
                }
            }

            func Pair() (int32, int32) { return (5, 6) }

            func F() {
                var values = []int32{0, 0}
                var box = Box{}
                var boxes = []Box{box}
                var local = 0
                values[0], box.Field, box.Value, boxes[0].Field, local = 1, 2, 3, 4, 5
                local, values[1] = Pair()
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void MultiAssignment_TupleRhsArityMismatch_ReportsExactDiagnostic()
    {
        var diagnostics = Bind("""
            func Pair() (int32, int32, int32) { return (1, 2, 3) }
            func F() {
                var a = 0
                var b = 0
                a, b = Pair()
            }
            """);

        var diagnostic = Assert.Single(diagnostics.Where(d => d.Id == "GS0167"));
        Assert.Equal("Multi-assignment has 2 target(s) but 3 value(s).", diagnostic.Message);
    }

    [Fact]
    public void MultiAssignment_InvalidTarget_ReportsExactDiagnostic()
    {
        var diagnostics = Bind("""
            func Get() int32 { return 0 }
            func F() {
                var a = 0
                Get(), a = 1, 2
            }
            """);

        var diagnostic = Assert.Single(diagnostics.Where(d => d.Id == "GS0526"));
        Assert.Equal(
            "Multi-assignment target must be a writable variable, field, property, array element, indexer, or pointer dereference.",
            diagnostic.Message);
    }

    [Theory]
    [InlineData(
        "func F() { let a = 0 var b = 0 a, b = 1, 2 }",
        "GS0127",
        "Variable 'a' is read-only and cannot be assigned to.")]
    [InlineData(
        "class Box { prop Value int32 { get; init; } } func F(box Box) { var b = 0 box.Value, b = 1, 2 }",
        "GS0372",
        "Init-only property 'Value' can only be assigned during object initialization (in a constructor, an object initializer, or an 'init' accessor).")]
    [InlineData(
        "class Box { private var Value int32 } func F(box Box) { var b = 0 box.Value, b = 1, 2 }",
        "GS0472",
        "'Box.Value' is inaccessible due to its protection level: a 'private' member is only accessible within 'Box'.")]
    [InlineData(
        "func F() { var a int32 var b int32 a, b = (1, \"two\") }",
        "GS0155",
        "Cannot convert type 'string' to 'int32'.")]
    public void MultiAssignment_ReusesExactSingleAssignmentDiagnostics(
        string source,
        string id,
        string message)
    {
        var diagnostic = Assert.Single(Bind(source).Where(d => d.Id == id));
        Assert.Equal(message, diagnostic.Message);
    }

    [Fact]
    public void MultiAssignment_MalformedExpressionTarget_RecoversWithOneTargetDiagnostic()
    {
        var diagnostics = Bind("""
            func F() {
                var a = 0
                var b = 0
                a + 1, b = 2, 3
            }
            """);

        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal("GS0526", diagnostic.Id);
    }

    [Fact]
    public void MultiDecl_DifferentTypes_AsTwoVarLines_Binds()
    {
        Assert.Empty(Bind("func F() {\n var a = 1\n var b = \"two\"\n var s = b\n var n = a\n }\n"));
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
