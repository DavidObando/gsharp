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
/// the emitted <c>System.GC.AllocateArray[T]</c> takes an <c>int32</c>; a
/// non-<c>int32</c> numeric length must be coerced via the conversion-call form
/// (<c>int32(n)</c>) so the allocation binds (otherwise gsc reports GS0159
/// "Cannot find function AllocateArray").
/// </summary>
public class Issue914ArrayLengthCoercionTranslationTests
{
    /// <summary>
    /// A <c>uint</c> length is coerced to <c>int32</c> via the conversion-call
    /// form so <c>System.GC.AllocateArray[T]</c> binds.
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

        Assert.Contains("System.GC.AllocateArray[S](int32(n))", printed);
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

        Assert.Contains("int32(n)", printed);
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

        Assert.Contains("System.GC.AllocateArray[S](n)", printed);
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
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
