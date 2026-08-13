// <copyright file="Issue914ArrayLengthCoercionTranslationTests.cs" company="GSharp">
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
/// Translation tests for the array-creation length coercion defect discovered
/// migrating <c>Oahu.Decrypt</c> (issue #914). C# array-creation expressions
/// accept any integral length (<c>new T[uint]</c>, <c>new T[long]</c>, …), but
/// the native G# allocation form <c>[n]T</c> (issue #1272) takes an
/// <c>int32</c>; a non-<c>int32</c> numeric length must be coerced via the
/// conversion-call form (<c>int32(n)</c>) so the allocation binds.
/// </summary>
public class Issue914ArrayLengthCoercionTranslationTests
{
    /// <summary>
    /// A <c>uint</c> length is coerced to <c>int32</c> via the conversion-call
    /// form inside the native <c>[n]T</c> allocation.
    /// </summary>
    [Fact]
    public void ArrayCreation_UintLength_CoercesToInt32()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class S { public int X; }

    public class C
    {
        public S[] Make(uint n) => new S[n];
    }
}");

        Assert.Contains("[int32(n)]S", printed);
    }

    /// <summary>
    /// A <c>long</c> length is likewise coerced to <c>int32</c>.
    /// </summary>
    [Fact]
    public void ArrayCreation_LongLength_CoercesToInt32()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public byte[] Make(long n) => new byte[n];
    }
}");

        Assert.Contains("[int32(n)]uint8", printed);
    }

    /// <summary>
    /// An <c>int</c> length is already <c>int32</c>; no conversion call is added.
    /// </summary>
    [Fact]
    public void ArrayCreation_IntLength_NoCoercion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class S { public int X; }

    public class C
    {
        public S[] Make(int n) => new S[n];
    }
}");

        Assert.Contains("[n]S", printed);
        Assert.DoesNotContain("int32(n)", printed);
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
