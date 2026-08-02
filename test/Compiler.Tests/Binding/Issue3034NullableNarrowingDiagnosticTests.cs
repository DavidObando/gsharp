// <copyright file="Issue3034NullableNarrowingDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Binding;

/// <summary>
/// Issue #3034: GS0159 distinguishes a nullable receiver from unrelated
/// function-lookup failures and explains how to make the call safe.
/// </summary>
public class Issue3034NullableNarrowingDiagnosticTests
{
    private const string NullableReceiverMessage =
        "Cannot call function M because receiver 'c' may be nil. Use '?.' for a null-safe call, bind it with 'if let', or re-narrow it before calling.";

    [Theory]
    [InlineData("function")]
    [InlineData("top-level")]
    public void NullableReceiver_ExplainsMissingNarrowing(string scope)
    {
        var source = scope == "top-level"
            ? """
            class C { func M() { } }

            var c C? = nil
            c.M()
            """
            : """
            class C { func M() { } }

            func Run() {
                var c C? = nil
                c.M()
            }
            """;
        var diagnostic = GetGs0159(source, isLibrary: scope != "top-level");

        Assert.Equal(NullableReceiverMessage, diagnostic.Message);
        AssertDiagnosticSpan(
            diagnostic,
            line: scope == "top-level" ? 3 : 4,
            startCharacter: scope == "top-level" ? 2 : 6,
            endCharacter: scope == "top-level" ? 5 : 9,
            text: "M()");
    }

    [Fact]
    public void ExpiredBranchNarrowing_ExplainsNeedToRenarrow()
    {
        var diagnostic = GetGs0159("""
            class C {
                func M() { }
            }

            func Run() {
                var c C? = C()
                if c != nil {
                    c.M()
                }

                c.M()
            }
            """);

        Assert.Equal(NullableReceiverMessage, diagnostic.Message);
    }

    [Fact]
    public void MissingMethodOnNullableReceiver_KeepsLookupMessage()
    {
        var diagnostic = GetGs0159("""
            class C {
                func M() { }
            }

            func Run() {
                var c C? = nil
                c.Frobnicate()
            }
            """);

        Assert.Equal("Cannot find function Frobnicate.", diagnostic.Message);
    }

    [Theory]
    [InlineData("function")]
    [InlineData("top-level")]
    public void WrongArityOnNullableReceiver_KeepsLookupMessage(string scope)
    {
        var source = scope == "top-level"
            ? """
            class C { func M(value int32) { } }

            var c C? = nil
            c.M()
            """
            : """
            class C { func M(value int32) { } }

            func Run() {
                var c C? = nil
                c.M()
            }
            """;
        var diagnostic = GetGs0159(source, isLibrary: scope != "top-level");

        Assert.Equal("Cannot find function M.", diagnostic.Message);
        AssertDiagnosticSpan(
            diagnostic,
            line: scope == "top-level" ? 3 : 4,
            startCharacter: scope == "top-level" ? 2 : 6,
            endCharacter: scope == "top-level" ? 5 : 9,
            text: "M()");
    }

    [Theory]
    [InlineData("function")]
    [InlineData("top-level")]
    public void WrongArgumentTypeOnNullableReceiver_KeepsLookupMessage(string scope)
    {
        var source = scope == "top-level"
            ? """
            class C { func M(value int32) { } }

            var c C? = nil
            c.M("x")
            """
            : """
            class C { func M(value int32) { } }

            func Run() {
                var c C? = nil
                c.M("x")
            }
            """;
        var diagnostic = GetGs0159(source, isLibrary: scope != "top-level");

        Assert.Equal("Cannot find function M.", diagnostic.Message);
        AssertDiagnosticSpan(
            diagnostic,
            line: scope == "top-level" ? 3 : 4,
            startCharacter: scope == "top-level" ? 2 : 6,
            endCharacter: scope == "top-level" ? 8 : 12,
            text: "M(\"x\")");
    }

    [Fact]
    public void StructNullableReceiver_ExplainsMissingNarrowing()
    {
        var diagnostic = GetGs0159("""
            struct S { func M() { } }

            func Run() {
                var s S? = nil
                s.M()
            }
            """);

        Assert.Equal(
            "Cannot call function M because receiver 's' may be nil. Use '?.' for a null-safe call, bind it with 'if let', or re-narrow it before calling.",
            diagnostic.Message);
    }

    [Fact]
    public void InterfaceNullableReceiver_ExplainsMissingNarrowing()
    {
        var diagnostic = GetGs0159("""
            interface I { func M(); }

            func Run() {
                var value I? = nil
                value.M()
            }
            """);

        Assert.Equal(
            "Cannot call function M because receiver 'value' may be nil. Use '?.' for a null-safe call, bind it with 'if let', or re-narrow it before calling.",
            diagnostic.Message);
    }

    [Fact]
    public void EnumNullableReceiver_ExplainsMissingNarrowing()
    {
        var diagnostic = GetGs0159("""
            enum E { A }

            func Run() {
                var value E? = nil
                value.ToString()
            }
            """);

        Assert.Equal(
            "Cannot call function ToString because receiver 'value' may be nil. Use '?.' for a null-safe call, bind it with 'if let', or re-narrow it before calling.",
            diagnostic.Message);
    }

    [Fact]
    public void ConstrainedTypeParameterNullableReceiver_ExplainsMissingNarrowing()
    {
        var diagnostic = GetGs0159("""
            interface I { func M(); }

            func Use[T I](value T?) {
                value.M()
            }
            """);

        Assert.Equal(
            "Cannot call function M because receiver 'value' may be nil. Use '?.' for a null-safe call, bind it with 'if let', or re-narrow it before calling.",
            diagnostic.Message);
    }

    [Fact]
    public void ImportedAndArrayNullableReceivers_KeepExistingSuccessfulBinding()
    {
        Assert.Empty(GetDiagnostics("""
            import System.Text

            func Run() {
                var value StringBuilder? = nil
                value.ToString()
            }
            """));

        Assert.Empty(GetDiagnostics("""
            func Run() {
                var values []?int32 = nil
                values.ToString()
            }
            """));
    }

    [Fact]
    public void QualifiedNullableReceiver_PreservesQualifier()
    {
        var diagnostic = GetGs0159("""
            class C {
                func M() { }
            }

            class Box {
                var Inner C?
            }

            func Run() {
                var b Box = Box()
                b.Inner.M()
            }
            """);

        Assert.Equal(
            "Cannot call function M because receiver 'b.Inner' may be nil. Use '?.' for a null-safe call, bind it with 'if let', or re-narrow it before calling.",
            diagnostic.Message);
    }

    [Fact]
    public void MultilineNullableReceiver_CollapsesWhitespace()
    {
        var diagnostic = GetGs0159("""
            class C { func M() { } }
            class Box { var Inner C? }
            func Run() {
                var b Box = Box()
                b.
                    Inner.M()
            }
            """);

        Assert.Equal(
            "Cannot call function M because receiver 'b. Inner' may be nil. Use '?.' for a null-safe call, bind it with 'if let', or re-narrow it before calling.",
            diagnostic.Message);
        Assert.DoesNotContain('\n', diagnostic.Message);
        AssertDiagnosticSpan(diagnostic, line: 5, startCharacter: 14, endCharacter: 17, text: "M()");
    }

    [Fact]
    public void InvalidExplicitTypeArgument_KeepsLookupMessage()
    {
        var diagnostic = GetGs0159AllowingOtherDiagnostics("""
            import System

            func Run() {
                Array.Empty[Missing]()
            }
            """);

        Assert.Equal("Cannot find function Empty.", diagnostic.Message);
    }

    [Fact]
    public void MissingImportedStaticMethod_KeepsLookupMessage()
    {
        var diagnostic = GetGs0159("""
            import System

            func Run() {
                Console.Nope()
            }
            """);

        Assert.Equal("Cannot find function Nope.", diagnostic.Message);
    }

    [Fact]
    public void MissingImportedInstanceMethod_KeepsLookupMessage()
    {
        var diagnostic = GetGs0159("""
            func Run() {
                "x".Nope()
            }
            """);

        Assert.Equal("Cannot find function Nope.", diagnostic.Message);
    }

    [Fact]
    public void ImportedDelegateMemberMismatch_KeepsLookupMessage()
    {
        var diagnostic = GetGs0159("""
            import GSharp.Compiler.Tests.Binding

            func Run() {
                var bag = Issue3034DelegateBag()
                bag.Handler = (value int32) -> value
                bag.Handler?("x")
            }
            """);

        Assert.Equal("Cannot find function Handler.", diagnostic.Message);
    }

    private static Diagnostic GetGs0159(string source, bool isLibrary = true)
    {
        var diagnostic = Assert.Single(GetDiagnostics(source, isLibrary));
        Assert.Equal("GS0159", diagnostic.Id);
        return diagnostic;
    }

    private static Diagnostic GetGs0159AllowingOtherDiagnostics(string source)
        => Assert.Single(GetDiagnostics(source), diagnostic => diagnostic.Id == "GS0159");

    private static Diagnostic[] GetDiagnostics(string source, bool isLibrary = true)
    {
        var sourceText = SourceText.From(source, "issue3034.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var compilation = new Compilation(ReferenceResolver.Default(), tree) { IsLibrary = isLibrary };

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream, refStream: null);
        return result.Diagnostics.ToArray();
    }

    private static void AssertDiagnosticSpan(
        Diagnostic diagnostic,
        int line,
        int startCharacter,
        int endCharacter,
        string text)
    {
        Assert.Equal(line, diagnostic.Location.StartLine);
        Assert.Equal(line, diagnostic.Location.EndLine);
        Assert.Equal(startCharacter, diagnostic.Location.StartCharacter);
        Assert.Equal(endCharacter, diagnostic.Location.EndCharacter);
        Assert.Equal(text, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }
}

/// <summary>Provides an imported delegate member for the GS0159 call-site matrix.</summary>
public struct Issue3034DelegateBag
{
    /// <summary>Delegate member invoked with an incompatible argument.</summary>
    public Func<int, int> Handler;
}
