// <copyright file="Adr0117NAryCollectionInitializerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 / ADR-0117: a G# collection-initializer element holds one or
/// two values, so C#'s N-ary <c>{ a, b, c }</c> element (xunit TheoryData
/// rows — sugar for <c>Add(a, b, c)</c>) previously gapped. The whole
/// initializer now lowers to a block expression issuing the same explicit
/// <c>Add</c> calls the C# compiler synthesizes.
/// </summary>
public class Adr0117NAryCollectionInitializerTests
{
    private const string TableSource = @"
using System.Collections;
using System.Collections.Generic;

namespace N
{
    public class Table : IEnumerable
    {
        private readonly List<string> rows = new List<string>();

        public int Count => this.rows.Count;

        public void Add(int a, string b, bool c) => this.rows.Add($""{a}:{b}:{c}"");

        IEnumerator IEnumerable.GetEnumerator() => this.rows.GetEnumerator();
    }

    public class C
    {
        public static Table Build() => new Table
        {
            { 1, ""x"", true },
            { 2, ""y"", false },
        };
    }
}";

    [Fact]
    public void ThreeValueElement_LowersToAddCallsInBlockExpression()
    {
        string g = Render(TableSource);

        Assert.Contains("let values = Table()", g, StringComparison.Ordinal);
        Assert.Contains("values.Add(1, \"x\", true)", g, StringComparison.Ordinal);
        Assert.Contains("values.Add(2, \"y\", false)", g, StringComparison.Ordinal);
        Assert.DoesNotContain("CS2GS", g, StringComparison.Ordinal);
    }

    [Fact]
    public void ThreeValueElement_TranslatedGSharp_ParsesBindsAndCompiles()
    {
        string g = Render(TableSource);

        var result = EmittedOracle.Evaluate(
            new[] { g },
            new EmittedOracleOptions { IsLibrary = true });
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(0, result.ExitCode);
    }

    [Fact]
    public void TwoValueElements_KeepTheCanonicalInitializerForm()
    {
        string g = Render(@"
using System.Collections.Generic;

namespace N
{
    public class C
    {
        public static Dictionary<string, int> Build() => new Dictionary<string, int>
        {
            { ""a"", 1 },
            { ""b"", 2 },
        };
    }
}");

        Assert.DoesNotContain("values", g, StringComparison.Ordinal);
        Assert.DoesNotContain(".Add(", g, StringComparison.Ordinal);
    }

    private static string Render(string csharp)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", csharp) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
