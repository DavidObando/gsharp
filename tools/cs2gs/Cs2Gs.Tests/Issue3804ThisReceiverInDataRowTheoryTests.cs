// <copyright file="Issue3804ThisReceiverInDataRowTheoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3804: the last translate-stage wall in the self-migration corpus was
/// not an unsupported construct at all — it was cs2gs crashing. Issue #3726's
/// data-row promotion looks a parameter up by ordinal in the attribute's value
/// array, and guarded only the UPPER bound:
/// <code>
/// || parameter.Ordinal >= row.Values.Length) { continue; }
/// if (row.Values[parameter.Ordinal].IsNull)
/// </code>
/// Roslyn models <c>this</c> as an <c>IParameterSymbol</c> on the enclosing
/// method whose <c>Ordinal</c> is <b>-1</b>, and the semantic model hands back
/// exactly that symbol for a <c>this</c> expression. So any <c>this.…</c>
/// receiver inside a method carrying a data-row-shaped attribute indexed at -1
/// and took the whole Translate stage down with an
/// <see cref="System.IndexOutOfRangeException"/> — reported by the gate as
/// "translation-unsupported", with no file and no line.
/// <para>
/// The receiver is not a row column, so the fix is to answer "no promotion" for
/// a negative ordinal, without weakening the #3726 rule for the real columns —
/// which the second and third tests here pin.
/// </para>
/// </summary>
public class Issue3804ThisReceiverInDataRowTheoryTests
{
    // The same stand-in for xunit's `[InlineData]` used by the #3726 tests: the
    // shape the rule keys off is a `params object[]` constructor, not the name.
    private const string DataAttributeDeclarations = @"
using System;

namespace Demo
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    public sealed class InlineDataAttribute : Attribute
    {
        public InlineDataAttribute(params object[] data)
        {
            this.Data = data;
        }

        public object[] Data { get; }
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class TheoryAttribute : Attribute
    {
    }
}";

    [Fact]
    public void AThisReceiverInsideADataRowTheory_TranslatesInsteadOfCrashing()
    {
        // The minimal reduction of test/Interpreter.Tests' crash: a theory
        // whose body reaches through `this`. Translating at all is the
        // assertion that matters — before the fix this call threw
        // IndexOutOfRangeException out of the translator.
        string printed = Translate(
            @"
namespace Demo
{
    public class ProgramTests
    {
        private readonly string name = ""n"";

        [Theory]
        [InlineData(""a"")]
        public void Check(string text)
        {
            System.Console.WriteLine(this.name.Length + text.Length);
        }
    }
}",
            out string declarations);

        Assert.Contains("Check(text string)", printed);
        Assert.Contains("this.name", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void AThisReceiverDoesNotSuppressTheNullColumnPromotion()
    {
        // The guard must answer only for the receiver. The declared parameters
        // still line up with the row, so #3726's promotion has to survive it:
        // column 0 carries a null and column 1 never does.
        string printed = Translate(
            @"
namespace Demo
{
    public class ProgramTests
    {
        private readonly string name = ""n"";

        [Theory]
        [InlineData(null, ""a"")]
        [InlineData(""b"", ""c"")]
        public void Check(string maybe, string always)
        {
            System.Console.WriteLine(this.name + maybe + always);
        }
    }
}",
            out string declarations);

        Assert.Contains("Check(maybe string?, always string)", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void AThisReceiverIsNeverPromotedByAWiderRow()
    {
        // The receiver's -1 is not "the last column" either: a row wide enough
        // to cover every declared parameter must not make `this` itself
        // nullable through some wrap-around reading of the ordinal.
        string printed = Translate(
            @"
namespace Demo
{
    public class ProgramTests
    {
        private readonly string name = ""n"";

        [Theory]
        [InlineData(null, null)]
        public void Check(string first, string second)
        {
            System.Console.WriteLine(this.name.Length + (first ?? second ?? """").Length);
        }
    }
}",
            out string declarations);

        Assert.Contains("Check(first string?, second string?)", printed);
        Assert.DoesNotContain("this!!", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    // Returns the printed consumer file, and hands back the printed attribute
    // declarations too so callers can bind the pair.
    private static string Translate(string source, out string printedDeclarations)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Attributes.cs", DataAttributeDeclarations), ("Tests.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics));

        printedDeclarations = Print(project, 0);
        return Print(project, 1);
    }

    private static string Print(LoadedCSharpProject project, int documentIndex)
    {
        LoadedDocument document = project.Documents[documentIndex];
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
