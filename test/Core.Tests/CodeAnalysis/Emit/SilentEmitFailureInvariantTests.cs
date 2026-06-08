// <copyright file="SilentEmitFailureInvariantTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// 6.2 SilentEmitFailure invariant: asserts that <see cref="EmitDiagnosticException"/>
/// and <c>BuildEmitFailureDiagnostic</c> correctly anchor diagnostics at source
/// locations when an emit-time failure occurs.
/// </summary>
public class SilentEmitFailureInvariantTests
{
    [Fact]
    public void EmitDiagnosticException_Throw_SetsAnchorAndMessage()
    {
        var source = "package Test\nvar x = 1\n";
        var sourceText = SourceText.From(source, "test.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var anchor = tree.Root; // use the CompilationUnit as anchor

        var ex = Assert.Throws<EmitDiagnosticException>(() =>
            EmitDiagnosticException.Throw(anchor, "unsupported expression kind"));

        Assert.Equal("unsupported expression kind", ex.Message);
        Assert.Same(anchor, ex.Anchor);
        Assert.Null(ex.InnerException);
    }

    [Fact]
    public void EmitDiagnosticException_Wrap_PreservesInnerExceptionAndAnchor()
    {
        var source = "package Test\nvar x = 1\n";
        var sourceText = SourceText.From(source, "test.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var anchor = tree.Root;
        var inner = new InvalidOperationException("boom");

        var ex = Assert.Throws<EmitDiagnosticException>(() =>
            EmitDiagnosticException.Wrap(anchor, inner));

        Assert.Same(inner, ex.InnerException);
        Assert.Same(anchor, ex.Anchor);
        Assert.Contains("InvalidOperationException", ex.Message);
        Assert.Contains("boom", ex.Message);
    }

    [Fact]
    public void EmitDiagnosticException_NullAnchor_IsAllowed()
    {
        // The anchor may be null for synthesized nodes; verify no crash.
        var ex = new EmitDiagnosticException("synthesized failure", anchor: null);
        Assert.Null(ex.Anchor);
        Assert.Equal("synthesized failure", ex.Message);
    }

    [Fact]
    public void BuildEmitFailureDiagnostic_WithAnchor_ProducesGS9998AtAnchorLocation()
    {
        var source = "package Test\n\nvar x = 1\n";
        var sourceText = SourceText.From(source, "anchor_test.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var compilation = new Compilation(tree);

        // The "var x = 1" statement is on line 2 (0-based).
        // Use the first statement's syntax node as anchor.
        var anchor = tree.Root.Members[1]; // second member: the variable declaration

        var emitEx = new EmitDiagnosticException(
            "InvalidOperationException: unsupported node",
            anchor,
            new InvalidOperationException("unsupported node"));

        // Call the private BuildEmitFailureDiagnostic via reflection
        var method = typeof(Compilation).GetMethod(
            "BuildEmitFailureDiagnostic",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(method);

        var diagnostic = (Diagnostic)method.Invoke(compilation, new object[] { emitEx });

        Assert.Equal("GS9998", diagnostic.Id);
        Assert.True(diagnostic.IsError);
        Assert.Equal("anchor_test.gs", diagnostic.Location.FileName);
        Assert.Contains("InvalidOperationException", diagnostic.Message);
        Assert.Contains("unsupported node", diagnostic.Message);

        // The anchor is on line 2 (0-based), not at origin (0,0)
        Assert.True(
            diagnostic.Location.StartLine >= 2,
            $"Expected line >= 2, got {diagnostic.Location.StartLine}");
    }

    [Fact]
    public void BuildEmitFailureDiagnostic_WithoutAnchor_FallsBackToFirstTree()
    {
        var source = "package Test\nvar x = 1\n";
        var sourceText = SourceText.From(source, "fallback_test.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var compilation = new Compilation(tree);

        // A plain exception (not EmitDiagnosticException) should still produce GS9998
        var plainEx = new InvalidOperationException("unexpected failure");

        var method = typeof(Compilation).GetMethod(
            "BuildEmitFailureDiagnostic",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(method);

        var diagnostic = (Diagnostic)method.Invoke(compilation, new object[] { plainEx });

        Assert.Equal("GS9998", diagnostic.Id);
        Assert.True(diagnostic.IsError);
        // Falls back to first tree's file name
        Assert.Equal("fallback_test.gs", diagnostic.Location.FileName);
        Assert.Contains("InvalidOperationException", diagnostic.Message);
    }

    [Fact]
    public void Emit_ValidProgram_ProducesNoDiagnostics()
    {
        // Regression: a valid program should still compile successfully.
        var source = """
            package Test
            import System

            Console.WriteLine("hello")
            """;

        var sourceText = SourceText.From(source, "valid.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var compilation = new Compilation(tree);

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream, refStream: null);

        Assert.True(
            result.Success,
            "Valid program should compile: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }
}

