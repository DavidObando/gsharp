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
        "Cannot call function M because receiver 'c' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.";

    [Theory]
    [MemberData(nameof(ReceiverKindCases))]
    public void NullableReceiverGuidance_MatchesReceiverNarrowability(
        string receiverKind,
        string state,
        string scope,
        bool expectDiagnostic)
    {
        var source = CreateReceiverKindSource(receiverKind, state, scope);
        var diagnostics = GetDiagnostics(
            source,
            isLibrary: scope != "top-level" && receiverKind != "global");
        if (!expectDiagnostic)
        {
            Assert.Empty(diagnostics);
            return;
        }

        if (receiverKind == "parameter" && state == "narrowed-before-call")
        {
            Assert.Equal(2, diagnostics.Length);
            Assert.Contains(
                diagnostics,
                diagnostic => diagnostic.Message == "Variable 'c' is read-only and cannot be assigned to.");
        }
        else
        {
            Assert.Single(diagnostics);
        }

        var diagnostic = Assert.Single(diagnostics, diagnostic => diagnostic.Id == "GS0159");
        var receiver = receiverKind == "field" ? "b.Inner" : "c";
        Assert.Equal(
            $"Cannot call function M because receiver '{receiver}' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
            diagnostic.Message);
        Assert.DoesNotContain("re-narrow", diagnostic.Message, StringComparison.Ordinal);
    }

    [Theory]
    [MemberData(nameof(GuidanceRemedyCases))]
    public void NullableReceiverGuidance_SuggestedRemediesCompile(
        string receiverKind,
        string sourceTemplate,
        string receiver,
        string call,
        bool isLibrary)
    {
        var diagnosticSource = sourceTemplate.Replace("/*CALL*/", $"{receiver}.{call}", StringComparison.Ordinal);
        var diagnosticResult = Compile(diagnosticSource, isLibrary);
        var diagnostic = Assert.Single(diagnosticResult.Diagnostics, diagnostic => diagnostic.Id == "GS0159");
        var expectedDiagnosticIds = diagnosticResult.Diagnostics
            .Where(diagnostic => diagnostic.Id != "GS0159")
            .Select(diagnostic => diagnostic.Id)
            .Order()
            .ToArray();
        var (nullSafeOperator, bindingKeyword) = GetSuggestedRemedies(diagnostic.Message);
        var remedies = new[]
        {
            (Name: nullSafeOperator, Code: $"{receiver}{nullSafeOperator}{call}"),
            (Name: bindingKeyword, Code: $"{bindingKeyword} narrowed = {receiver} {{\n    narrowed.{call}\n}}"),
        };

        foreach (var remedy in remedies)
        {
            var source = sourceTemplate.Replace("/*CALL*/", remedy.Code, StringComparison.Ordinal);
            var result = Compile(source, isLibrary);
            Assert.True(
                result.Success,
                $"{receiverKind}/{remedy.Name}: {string.Join(Environment.NewLine, result.Diagnostics.Select(d => $"{d.Id}: {d.Message}"))}");
            Assert.Equal(
                expectedDiagnosticIds,
                result.Diagnostics.Select(diagnostic => diagnostic.Id).Order());
        }
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
            "Cannot call function M because receiver 's' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
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
            "Cannot call function M because receiver 'value' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
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
            "Cannot call function ToString because receiver 'value' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
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
            "Cannot call function M because receiver 'value' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
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
            "Cannot call function M because receiver 'b.Inner' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
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
            "Cannot call function M because receiver 'b. Inner' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
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
        => Compile(source, isLibrary).Diagnostics.ToArray();

    private static EmitResult Compile(string source, bool isLibrary)
    {
        var sourceText = SourceText.From(source, "issue3034.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var compilation = new Compilation(ReferenceResolver.Default(), tree) { IsLibrary = isLibrary };
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream, refStream: null);
    }

    public static TheoryData<string, string, string, bool> ReceiverKindCases => new()
    {
        { "local", "never-narrowed", "function", true },
        { "local", "narrowed-before-call", "function", false },
        { "parameter", "never-narrowed", "function", true },
        { "parameter", "narrowed-before-call", "function", true },
        { "field", "never-narrowed", "top-level", true },
        { "field", "narrowed-before-call", "top-level", true },
        { "field", "never-narrowed", "function", true },
        { "field", "narrowed-before-call", "function", true },
        { "global", "never-narrowed", "top-level", true },
        { "global", "narrowed-before-call", "top-level", false },
        { "global", "never-narrowed", "function", true },
        { "global", "narrowed-before-call", "function", false },
        { "let", "never-narrowed", "top-level", true },
        { "let", "narrowed-before-call", "top-level", true },
        { "let", "never-narrowed", "function", true },
        { "let", "narrowed-before-call", "function", true },
    };

    public static TheoryData<string, string, string, string, bool> GuidanceRemedyCases => new()
    {
        {
            "local",
            """
            class C { func M() { } }
            func Run() {
                var c C? = nil
                /*CALL*/
            }
            """,
            "c",
            "M()",
            true
        },
        {
            "parameter",
            """
            class C { func M() { } }
            func Run(c C?) {
                /*CALL*/
            }
            """,
            "c",
            "M()",
            true
        },
        {
            "field",
            """
            class C { func M() { } }
            class Box { var Inner C? }
            func Run() {
                var b Box = Box()
                /*CALL*/
            }
            """,
            "b.Inner",
            "M()",
            true
        },
        {
            "global",
            """
            class C { func M() { } }
            var c C? = nil
            func Run() {
                /*CALL*/
            }
            """,
            "c",
            "M()",
            false
        },
        {
            "let",
            """
            class C { func M() { } }
            func Run() {
                let c C? = nil
                /*CALL*/
            }
            """,
            "c",
            "M()",
            true
        },
        {
            "struct",
            """
            struct S { func M() { } }
            func Run() {
                var value S? = nil
                /*CALL*/
            }
            """,
            "value",
            "M()",
            true
        },
        {
            "interface",
            """
            interface I { func M(); }
            func Run(value I?) {
                /*CALL*/
            }
            """,
            "value",
            "M()",
            true
        },
        {
            "enum",
            """
            enum E { A }
            func Run() {
                var value E? = nil
                /*CALL*/
            }
            """,
            "value",
            "ToString()",
            true
        },
        {
            "constrained-type-parameter",
            """
            interface I { func M(); }
            func Run[T I](value T?) {
                /*CALL*/
            }
            """,
            "value",
            "M()",
            true
        },
        {
            "extension",
            """
            class C { }
            func (value C) M() { }
            func Run() {
                var c C? = nil
                /*CALL*/
            }
            """,
            "c",
            "M()",
            true
        },
    };

    private static (string NullSafeOperator, string BindingKeyword) GetSuggestedRemedies(string message)
    {
        const string useMarker = "Use '";
        const string bindMarker = "bind it with '";
        var nullSafeStart = message.IndexOf(useMarker, StringComparison.Ordinal) + useMarker.Length;
        var nullSafeEnd = message.IndexOf('\'', nullSafeStart);
        var bindingStart = message.IndexOf(bindMarker, StringComparison.Ordinal) + bindMarker.Length;
        var bindingEnd = message.IndexOf('\'', bindingStart);

        Assert.True(nullSafeStart >= useMarker.Length && nullSafeEnd > nullSafeStart);
        Assert.True(bindingStart >= bindMarker.Length && bindingEnd > bindingStart);
        return (message[nullSafeStart..nullSafeEnd], message[bindingStart..bindingEnd]);
    }

    private static string CreateReceiverKindSource(string receiverKind, string state, string scope)
    {
        var setNonNull = state == "narrowed-before-call";
        return (receiverKind, scope) switch
        {
            ("local", "function") => $$"""
                class C { func M() { } }
                func Run() {
                    var c C? = nil
                    {{(setNonNull ? "c = C()" : string.Empty)}}
                    c.M()
                }
                """,
            ("parameter", "function") => $$"""
                class C { func M() { } }
                func Run(c C?) {
                    {{(setNonNull ? "c = C()" : string.Empty)}}
                    c.M()
                }
                """,
            ("field", "top-level") => $$"""
                class C { func M() { } }
                class Box { var Inner C? }
                var b Box = Box()
                {{(setNonNull ? "b.Inner = C()" : string.Empty)}}
                b.Inner.M()
                """,
            ("field", "function") => $$"""
                class C { func M() { } }
                class Box { var Inner C? }
                func Run() {
                    var b Box = Box()
                    {{(setNonNull ? "b.Inner = C()" : string.Empty)}}
                    b.Inner.M()
                }
                """,
            ("global", "top-level") => $$"""
                class C { func M() { } }
                var c C? = nil
                {{(setNonNull ? "c = C()" : string.Empty)}}
                c.M()
                """,
            ("global", "function") => $$"""
                class C { func M() { } }
                var c C? = nil
                func Run() {
                    {{(setNonNull ? "c = C()" : string.Empty)}}
                    c.M()
                }
                """,
            ("let", "top-level") => $$"""
                class C { func M() { } }
                let c C? = {{(setNonNull ? "C()" : "nil")}}
                c.M()
                """,
            ("let", "function") => $$"""
                class C { func M() { } }
                func Run() {
                    let c C? = {{(setNonNull ? "C()" : "nil")}}
                    c.M()
                }
                """,
            _ => throw new ArgumentOutOfRangeException(nameof(receiverKind)),
        };
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
