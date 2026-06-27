// <copyright file="Issue1272ArrayAllocationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1272: a C# array creation with no initializer (<c>new T[n]</c>) must
/// translate to the native G# zero-initialised allocation form <c>[n]T</c>
/// rather than the BCL call <c>System.GC.AllocateArray[T](n)</c>. The
/// <c>new T[]{…}</c> initializer form is unaffected and keeps mapping to the
/// slice literal <c>[]T{…}</c>.
/// </summary>
public class Issue1272ArrayAllocationTranslationTests
{
    /// <summary>
    /// A constant-length allocation <c>new int[8]</c> maps to <c>[8]int32</c>.
    /// </summary>
    [Fact]
    public void ArrayCreation_ConstantLength_EmitsNativeAllocation()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int[] Make() => new int[8];
    }
}");

        Assert.Contains("[8]int32", printed);
        Assert.DoesNotContain("AllocateArray", printed);
    }

    /// <summary>
    /// A runtime-length allocation <c>new int[n]</c> maps to <c>[n]int32</c>.
    /// </summary>
    [Fact]
    public void ArrayCreation_RuntimeLength_EmitsNativeAllocation()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int[] Make(int n) => new int[n];
    }
}");

        Assert.Contains("[n]int32", printed);
        Assert.DoesNotContain("AllocateArray", printed);
    }

    /// <summary>
    /// The initializer form <c>new T[]{…}</c> still maps to the slice literal
    /// <c>[]T{…}</c> (unchanged by issue #1272).
    /// </summary>
    [Fact]
    public void ArrayCreation_WithInitializer_RemainsSliceLiteral()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int[] Make() => new int[]{ 1, 2, 3 };
    }
}");

        Assert.Contains("[]int32{1, 2, 3}", printed);
        Assert.DoesNotContain("AllocateArray", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
