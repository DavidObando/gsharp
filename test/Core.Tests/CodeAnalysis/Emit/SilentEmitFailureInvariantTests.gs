// <copyright file="SilentEmitFailureInvariantTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// 6.2 SilentEmitFailure invariant: asserts that (cref:EmitDiagnosticException)
/// and `BuildEmitFailureDiagnostic` correctly anchor diagnostics at source
/// locations when an emit-time failure occurs.
open class SilentEmitFailureInvariantTests {
    @Fact
    func EmitDiagnosticException_Throw_SetsAnchorAndMessage() {
        let source = `package Test
var x = 1
`
        let sourceText = SourceText.From(source, "test.gs")
        let tree = SyntaxTree.Parse(sourceText)
        let anchor = tree.Root // use the CompilationUnit as anchor
        let ex = Assert.Throws[EmitDiagnosticException](
            () -> EmitDiagnosticException.Throw(anchor, "unsupported expression kind")
        )
        Assert.Equal("unsupported expression kind", ex.Message)
        Assert.Same(anchor, ex.Anchor)
        Assert.Null(ex.InnerException)
    }

    @Fact
    func EmitDiagnosticException_Wrap_PreservesInnerExceptionAndAnchor() {
        let source = `package Test
var x = 1
`
        let sourceText = SourceText.From(source, "test.gs")
        let tree = SyntaxTree.Parse(sourceText)
        let anchor = tree.Root
        let inner = InvalidOperationException("boom")
        let ex = Assert.Throws[EmitDiagnosticException](() -> EmitDiagnosticException.Wrap(anchor, inner))
        Assert.Same(inner, ex.InnerException)
        Assert.Same(anchor, ex.Anchor)
        Assert.Contains("InvalidOperationException", ex.Message)
        Assert.Contains("boom", ex.Message)
    }

    @Fact
    func EmitDiagnosticException_NullAnchor_IsAllowed() {
        // The anchor may be null for synthesized nodes; verify no crash.
        let ex = EmitDiagnosticException("synthesized failure", anchor: nil)
        Assert.Null(ex.Anchor)
        Assert.Equal("synthesized failure", ex.Message)
    }

    @Fact
    func CreateInternalErrorDiagnostic_WithAnchor_ProducesGS9998AtAnchorLocation() {
        let source = `package Test

var x = 1
`
        let sourceText = SourceText.From(source, "anchor_test.gs")
        let tree = SyntaxTree.Parse(sourceText)
        // The "var x = 1" statement is on line 2 (0-based).
        // Use the first statement's syntax node as anchor.
        let anchor = tree.Root.Members[1] // second member: the variable declaration
        let emitEx = EmitDiagnosticException(
            "InvalidOperationException: unsupported node",
            anchor,
            InvalidOperationException("unsupported node")
        )
        let diagnostic = Compilation.CreateInternalErrorDiagnostic(Exception("outer wrapper", emitEx))
        Assert.Equal("GS9998", diagnostic.Id)
        Assert.True(diagnostic.IsError)
        Assert.Equal("anchor_test.gs", diagnostic.Location.FileName)
        Assert.Equal(2, diagnostic.Location.StartLine)
        Assert.Equal(0, diagnostic.Location.StartCharacter)
        Assert.Equal(2, diagnostic.Location.EndLine)
        Assert.Equal(9, diagnostic.Location.EndCharacter)
        Assert.Equal("var x = 1", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Contains("InvalidOperationException", diagnostic.Message)
        Assert.Contains("unsupported node", diagnostic.Message)
    }

    @Fact
    func CreateInternalErrorDiagnostic_FindsAnchorAndRootCauseThroughMultipleWrappers() {
        let sourceText = SourceText.From("var x = 1\n", "wrapped.gs")
        let tree = SyntaxTree.Parse(sourceText)
        let anchor = tree.Root.Members[0]
        let rootCause = InvalidOperationException("deep failure")
        let emitEx = EmitDiagnosticException("emit failure", anchor, rootCause)
        let exception = Exception("outer one", Exception("outer two", emitEx))
        let diagnostic = Compilation.CreateInternalErrorDiagnostic(exception)
        Assert.Equal("GS9998", diagnostic.Id)
        Assert.Equal("wrapped.gs", diagnostic.Location.FileName)
        Assert.Equal(anchor.Span, diagnostic.Location.Span)
        Assert.Equal("var x = 1", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Equal("InvalidOperationException: deep failure", diagnostic.Message)
    }

    @Fact
    func CreateInternalErrorDiagnostic_WithoutAnchor_HasNoLocation() {
        let plainEx = InvalidOperationException("unexpected failure")
        let diagnostic = Compilation.CreateInternalErrorDiagnostic(plainEx)
        Assert.Equal("GS9998", diagnostic.Id)
        Assert.True(diagnostic.IsError)
        Assert.Null(diagnostic.Location.Text)
        Assert.Null(diagnostic.Location.FileName)
        Assert.Contains("InvalidOperationException", diagnostic.Message)
    }

    @Fact
    func Emit_ValidProgram_ProducesNoDiagnostics() {
        // Regression: a valid program should still compile successfully.
        let source = `package Test
import System

Console.WriteLine("hello")`
        let sourceText = SourceText.From(source, "valid.gs")
        let tree = SyntaxTree.Parse(sourceText)
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream, refStream: nil)
        Assert.True(
            result.Success,
            "Valid program should compile: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }
}
