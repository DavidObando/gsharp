// <copyright file="Issue1201StaticUsingTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1201 / ADR-0134: a C# <c>using static X</c> translates to a bare type
/// import <c>import X</c>, which gsc now hoists X's <c>shared</c> (static)
/// members into scope for unqualified reference. So unlike a sibling static
/// (which is qualified through its owning type, see
/// <see cref="StaticMemberQualificationTranslationTests"/>), a member referenced
/// through a <c>using static</c> directive must be emitted UNqualified — the
/// pre-fix qualification workaround is removed.
/// </summary>
public class Issue1201StaticUsingTranslationTests
{
    private const string AuxSource = @"
namespace Corpus.Aux
{
    public static class EnumUtil
    {
        public static int[] GetValues() => new int[] { 1, 2, 3 };

        public static T[] GetValuesOf<T>(T seed) => new T[] { seed };

        public static readonly int Answer = 42;
    }
}
";

    private const string CallerSource = @"
using static Corpus.Aux.EnumUtil;

namespace Corpus.Main
{
    public class Consumer
    {
        public int[] F() => GetValues();

        public string[] G() => GetValuesOf(""x"");

        public int H() => Answer;
    }
}
";

    [Fact]
    public void UsingStatic_TranslatesTo_BareTypeImport()
    {
        string rendered = TranslateCaller();

        Assert.Contains("import Corpus.Aux.EnumUtil", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void BareStaticCall_ThroughUsingStatic_StaysUnqualified()
    {
        string rendered = TranslateCaller();

        Assert.Contains("GetValues()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("EnumUtil.GetValues", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void BareGenericStaticCall_ThroughUsingStatic_StaysUnqualified()
    {
        string rendered = TranslateCaller();

        Assert.Contains("GetValuesOf", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("EnumUtil.GetValuesOf", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void BareStaticFieldRef_ThroughUsingStatic_StaysUnqualified()
    {
        string rendered = TranslateCaller();

        Assert.DoesNotContain("EnumUtil.Answer", rendered, StringComparison.Ordinal);
    }

    private static string TranslateCaller()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("EnumUtil.cs", AuxSource),
                ("Caller.cs", CallerSource),
            });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(d => d.FilePath.EndsWith("Caller.cs", StringComparison.Ordinal));
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
