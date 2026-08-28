// <copyright file="Issue3611OpenCallingConventionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3611 / ADR-0095 v2: the two formerly by-design-gapped C#
/// function-pointer shapes now translate to G#'s open calling-convention
/// model — bare <c>delegate* unmanaged&lt;...&gt;</c> (the platform-default
/// ABI) spells <c>unmanaged (T) -&gt; R</c>, and a combined or non-legacy
/// convention set spells <c>unmanaged[Name, ...] (T) -&gt; R</c> with the
/// <c>CallConv</c> short names in source order. Single legacy conventions
/// keep the v1 spelling.
/// </summary>
public class Issue3611OpenCallingConventionTranslationTests
{
    [Fact]
    public void BareUnmanagedPointer_TranslatesToBareUnmanagedForm()
    {
        // The exact residual shape from the #3501 corpus
        // (Core.Tests Issue2852GenericUnmanagedStackAllocTests).
        const string source = @"
public unsafe class Holder
{
    public delegate* unmanaged<int, int> FunctionPointer { get; set; }
}
";
        string printed = Render(source);
        Assert.Contains("unmanaged (int32) -> int32", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);
    }

    [Fact]
    public void CombinedConventions_TranslateInSourceOrder()
    {
        const string source = @"
public unsafe class Holder
{
    public delegate* unmanaged[Cdecl, SuppressGCTransition]<int, int> Combined;
    public delegate* unmanaged[SuppressGCTransition, Cdecl]<int, int> Reversed;
}
";
        string printed = Render(source);
        Assert.Contains("unmanaged[Cdecl, SuppressGCTransition] (int32) -> int32", printed, StringComparison.Ordinal);
        Assert.Contains("unmanaged[SuppressGCTransition, Cdecl] (int32) -> int32", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);
    }

    [Fact]
    public void SingleNonLegacyConvention_TranslatesToOpenForm()
    {
        const string source = @"
public unsafe class Holder
{
    public delegate* unmanaged[SuppressGCTransition]<int, int> Suppressed;
}
";
        string printed = Render(source);
        Assert.Contains("unmanaged[SuppressGCTransition] (int32) -> int32", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);
    }

    [Fact]
    public void SingleLegacyConvention_KeepsTheV1Spelling()
    {
        const string source = @"
public unsafe class Holder
{
    public delegate* unmanaged[Cdecl]<int, int> Legacy;
}
";
        string printed = Render(source);
        Assert.Contains("unmanaged[Cdecl] (int32) -> int32", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Translated G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
