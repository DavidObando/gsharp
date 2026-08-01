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

    [Fact]
    public void NullableReceiver_ExplainsMissingNarrowing()
    {
        var diagnostic = GetGs0159("""
            class C {
                func M() { }
            }

            func Run() {
                var c C? = nil
                c.M()
            }
            """);

        Assert.Equal(NullableReceiverMessage, diagnostic.Message);
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
    public void InvalidExplicitTypeArgument_KeepsLookupMessage()
    {
        var diagnostic = GetGs0159("""
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

    private static Diagnostic GetGs0159(string source)
    {
        var sourceText = SourceText.From(source, "issue3034.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var compilation = new Compilation(ReferenceResolver.Default(), tree) { IsLibrary = true };

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream, refStream: null);
        return Assert.Single(result.Diagnostics.Where(diagnostic => diagnostic.Id == "GS0159"));
    }
}

/// <summary>Provides an imported delegate member for the GS0159 call-site matrix.</summary>
public struct Issue3034DelegateBag
{
    /// <summary>Delegate member invoked with an incompatible argument.</summary>
    public Func<int, int> Handler;
}
