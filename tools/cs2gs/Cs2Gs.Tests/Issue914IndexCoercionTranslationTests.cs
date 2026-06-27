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
/// Translation tests for the array/indexer element-access index coercion defect
/// discovered migrating <c>Oahu.Decrypt</c> (issue #914). G# array and indexer
/// element access require an <c>int32</c> index; C# accepts any integral index
/// and only widens the narrow kinds (<c>byte</c>, <c>sbyte</c>, <c>short</c>,
/// <c>ushort</c>, <c>char</c>) to <c>int</c>. The wider/unsigned kinds
/// (<c>uint</c>, <c>long</c>, <c>ulong</c>, <c>nint</c>, <c>nuint</c>) do not
/// implicitly convert, so they must be coerced via the conversion-call form
/// (<c>int32(i)</c>) (otherwise gsc reports GS0156).
/// </summary>
public class Issue914IndexCoercionTranslationTests
{
    /// <summary>
    /// A <c>uint</c> array index is coerced to <c>int32</c>.
    /// </summary>
    [Fact]
    public void ArrayIndex_UintIndex_CoercesToInt32()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Get(int[] arr, uint i) => arr[i];
    }
}");

        Assert.Contains("arr[int32(i)]", printed);
    }

    /// <summary>
    /// A <c>long</c> array index is coerced to <c>int32</c>.
    /// </summary>
    [Fact]
    public void ArrayIndex_LongIndex_CoercesToInt32()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Get(int[] arr, long i) => arr[i];
    }
}");

        Assert.Contains("arr[int32(i)]", printed);
    }

    /// <summary>
    /// A computed <c>uint</c> index expression (<c>chunk - 1u</c>) is coerced to
    /// <c>int32</c> as a whole.
    /// </summary>
    [Fact]
    public void ArrayIndex_UintExpression_CoercesToInt32()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Get(int[] table, uint chunk) => table[chunk - 1u];
    }
}");

        Assert.Contains("int32(", printed);
        Assert.Contains("chunk", printed);
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
