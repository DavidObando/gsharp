// <copyright file="Issue914IndexCoercionTranslationTests.cs" company="GSharp">
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
/// Translation tests for the array/indexer element-access index handling.
/// Issue #1279: gsc now accepts ANY C#-supported integer type as an ARRAY/slice
/// element index (it converts the wider/unsigned kinds — <c>uint</c>,
/// <c>long</c>, <c>ulong</c>, <c>nint</c>, <c>nuint</c> — to native int), so an
/// array index is emitted WITHOUT an <c>int32(...)</c> wrapper. A CLR/user
/// indexer whose single parameter is <c>int32</c> (<c>List&lt;T&gt;</c>,
/// <c>Span&lt;T&gt;</c>, <c>IReadOnlyList&lt;T&gt;</c>) still binds its argument
/// to <c>int32</c> via normal conversion rules in gsc, so a wide index against
/// such an indexer is still coerced via the conversion-call form
/// (<c>int32(i)</c>). Originally tracked the #914 (<c>Oahu.Decrypt</c>) array
/// coercion defect.
/// </summary>
public class Issue914IndexCoercionTranslationTests
{
    /// <summary>
    /// A <c>uint</c> array index is emitted uncoerced (gsc accepts it).
    /// </summary>
    [Fact]
    public void ArrayIndex_UintIndex_NoCoercion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Get(int[] arr, uint i) => arr[i];
    }
}");

        Assert.Contains("arr[i]", printed);
        Assert.DoesNotContain("int32(", printed);
    }

    /// <summary>
    /// A <c>long</c> array index is emitted uncoerced (gsc accepts it).
    /// </summary>
    [Fact]
    public void ArrayIndex_LongIndex_NoCoercion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Get(int[] arr, long i) => arr[i];
    }
}");

        Assert.Contains("arr[i]", printed);
        Assert.DoesNotContain("int32(", printed);
    }

    /// <summary>
    /// A computed <c>uint</c> array-index expression (<c>chunk - 1u</c>) is
    /// emitted uncoerced (gsc accepts the whole wide index).
    /// </summary>
    [Fact]
    public void ArrayIndex_UintExpression_NoCoercion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Get(int[] table, uint chunk) => table[chunk - 1u];
    }
}");

        Assert.Contains("chunk", printed);
        Assert.DoesNotContain("int32(", printed);
    }

    /// <summary>
    /// A <c>nint</c> array index is emitted uncoerced (gsc accepts it).
    /// </summary>
    [Fact]
    public void ArrayIndex_NintIndex_NoCoercion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Get(int[] arr, nint i) => arr[i];
    }
}");

        Assert.Contains("arr[i]", printed);
        Assert.DoesNotContain("int32(", printed);
    }

    /// <summary>
    /// An <c>int</c> array index already matches <c>int32</c>; no conversion call
    /// is added.
    /// </summary>
    [Fact]
    public void ArrayIndex_IntIndex_NoCoercion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Get(int[] arr, int i) => arr[i];
    }
}");

        Assert.Contains("arr[i]", printed);
        Assert.DoesNotContain("int32(i)", printed);
    }

    /// <summary>
    /// A <c>Dictionary&lt;string, T&gt;</c> lookup is keyed by the string; the
    /// index must not be wrapped.
    /// </summary>
    [Fact]
    public void DictionaryIndex_StringKey_NoCoercion()
    {
        string printed = TranslateUnit(@"
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
        public int Get(Dictionary<string, int> map, string k) => map[k];
    }
}");

        Assert.DoesNotContain("int32(", printed);
    }

    /// <summary>
    /// A <c>Dictionary&lt;uint, T&gt;</c> lookup is keyed by <c>uint</c>; the
    /// index must not be coerced to <c>int32</c> (the indexer parameter is
    /// <c>uint</c>, not <c>int32</c>).
    /// </summary>
    [Fact]
    public void DictionaryIndex_UintKey_NoCoercion()
    {
        string printed = TranslateUnit(@"
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
        public int Get(Dictionary<uint, int> map, uint k) => map[k];
    }
}");

        Assert.DoesNotContain("int32(k)", printed);
    }

    /// <summary>
    /// A from-end index (<c>span[^1]</c>, a <c>System.Index</c>) goes through the
    /// dedicated lowering and must not gain a spurious <c>int32(...)</c> wrap.
    /// </summary>
    [Fact]
    public void SpanFromEndIndex_NoSpuriousCoercion()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        public int Last(Span<int> span) => span[^1];
    }
}");

        Assert.DoesNotContain("int32(", printed);
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
