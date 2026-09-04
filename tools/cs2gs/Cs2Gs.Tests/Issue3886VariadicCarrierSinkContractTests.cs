// <copyright file="Issue3886VariadicCarrierSinkContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3886: the sink contract used to decide whether an argument needs a
/// <c>!!</c> bridge must agree with the signature the DECLARATION side
/// actually emits.
/// <para>
/// <c>TranslateParameter</c> gates issue #1072 promotion on <c>!variadic</c> —
/// "variadic params are never null-compared as a whole" — so an ADR-0173
/// variadic carrier is always emitted <c>...T</c> however much null evidence
/// (<c>if (paths is null) throw</c>) the oblivious-nullability fixpoint
/// recorded against that parameter. The call side asked
/// <c>ShouldPromoteToNullableReference</c> about the same parameter anyway,
/// concluded the sink had widened to <c>...T?</c>, and dropped the bridge —
/// so a promoted <c>string?</c> reached a non-null <c>...string</c> slot bare.
/// </para>
/// <para>
/// That is the whole migrated <c>test/Compiler.Tests</c> compile wall:
/// <c>test/Shared/EmittedFixture.cs</c> declares
/// <c>LoadTogether(params string[] assemblyPaths)</c> opening with
/// <c>if (assemblyPaths is null) throw</c>, and the one call site in
/// <c>Issue2525ImportedIndexerHidingEmitTests</c> passing a promoted
/// <c>ContractsPath</c> produced GS0154 plus fifteen cascade
/// "Cannot find function/member" errors on the error-typed result.
/// </para>
/// </summary>
public class Issue3886VariadicCarrierSinkContractTests
{
    /// <summary>
    /// The wall shape: an argument in the EXPANDED tail of a null-guarded
    /// source-declared <c>params T[]</c> must still be bridged, and the
    /// bridged program must run.
    /// </summary>
    [Fact]
    public void ExpandedArgument_NullGuardedSourceParams_AssertsNonNullAndRuns()
    {
        string printed = TranslateOblivious("""
            using System;

            namespace Demo
            {
                public static class Fixture
                {
                    public static string Join(params string[] parts)
                    {
                        if (parts is null)
                        {
                            throw new ArgumentNullException(nameof(parts));
                        }

                        return string.Join("|", parts);
                    }
                }

                public sealed class Result
                {
                    public Result(string first)
                    {
                        First = first;
                    }

                    public string First { get; }
                }

                public static class Caller
                {
                    public static string Go(bool emit)
                    {
                        var first = emit ? "a" : null;
                        var result = new Result(first);
                        return Fixture.Join(result.First, "b");
                    }
                }
            }
            """);

        // The evidence that the sink really is non-null: the declaration is a
        // bare `...string` carrier, so the promoted `string?` argument needs
        // the bridge.
        Assert.Contains("func Join(parts ...string)", printed, StringComparison.Ordinal);
        Assert.Contains("prop First string?", printed, StringComparison.Ordinal);
        Assert.Contains("Fixture.Join(result.First!!, \"b\")", printed, StringComparison.Ordinal);

        AssertEvaluates(printed, "Caller.Go(true)", "a|b");
    }

    /// <summary>
    /// The same defect through the DIRECT collection form
    /// (<c>Join(paths)</c>, binding the params parameter itself rather than
    /// its element): the emitted carrier is non-null, so a promoted
    /// <c>[]string?</c> argument needs the bridge too.
    /// </summary>
    [Fact]
    public void DirectCollectionArgument_NullGuardedSourceParams_AssertsNonNullAndRuns()
    {
        string printed = TranslateOblivious("""
            using System;

            namespace Demo
            {
                public static class Fixture
                {
                    public static string Join(params string[] parts)
                    {
                        if (parts is null)
                        {
                            throw new ArgumentNullException(nameof(parts));
                        }

                        return string.Join("|", parts);
                    }
                }

                public sealed class Bundle
                {
                    public Bundle(string[] parts)
                    {
                        Parts = parts;
                    }

                    public string[] Parts { get; }
                }

                public static class Caller
                {
                    public static string Go(bool emit)
                    {
                        var parts = emit ? new[] { "a", "b" } : null;
                        var bundle = new Bundle(parts);
                        return Fixture.Join(bundle.Parts);
                    }
                }
            }
            """);

        Assert.Contains("func Join(parts ...string)", printed, StringComparison.Ordinal);
        Assert.Contains("Fixture.Join(bundle.Parts!!)", printed, StringComparison.Ordinal);

        AssertEvaluates(printed, "Caller.Go(true)", "a|b");
    }

    /// <summary>
    /// Precision guard: a genuinely non-null argument to the same null-guarded
    /// variadic carrier gains no assertion. <c>!!</c> is a RUNTIME check in G#,
    /// so a gratuitous one is a behaviour change, not a readability wart.
    /// </summary>
    [Fact]
    public void ExpandedArgument_NonNullValue_StaysBare()
    {
        string printed = TranslateOblivious("""
            using System;

            namespace Demo
            {
                public static class Fixture
                {
                    public static string Join(params string[] parts)
                    {
                        if (parts is null)
                        {
                            throw new ArgumentNullException(nameof(parts));
                        }

                        return string.Join("|", parts);
                    }
                }

                public static class Caller
                {
                    public static string Go(string first)
                    {
                        return Fixture.Join(first, "b");
                    }
                }
            }
            """);

        Assert.Contains("Fixture.Join(first, \"b\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("first!!", printed, StringComparison.Ordinal);

        AssertEvaluates(printed, "Caller.Go(\"a\")", "a|b");
    }

    private static void AssertEvaluates(string printed, string expression, object expected)
    {
        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + expression);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            Microsoft.CodeAnalysis.NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
