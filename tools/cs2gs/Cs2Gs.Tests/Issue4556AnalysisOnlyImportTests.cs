// <copyright file="Issue4556AnalysisOnlyImportTests.cs" company="GSharp">
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
/// Issue #4556: the managed-reference array analysis (#4545) maps a receiver's
/// array type only to inspect its element shape. That mapping used to record
/// the element type's namespace as a synthesized import, although no name from
/// it is printed. In self-migrated Core.Tests a <c>ParameterInfo[]</c> receiver
/// imported <c>System.Reflection</c>, which made the file's bare compiler
/// <c>Binder</c> ambiguous with <c>System.Reflection.Binder</c> (GS0547). An
/// analysis-only mapping now synthesizes no import; a printed reference still
/// does.
/// </summary>
public class Issue4556AnalysisOnlyImportTests
{
    [Fact]
    public void ArrayReceiverShapeAnalysis_DoesNotImportElementNamespace()
    {
        string printed = Translate(@"
using System;

namespace Demo
{
    public class C
    {
        public void M(int value)
        {
        }

        public int Count()
        {
            return typeof(C).GetMethod(""M"").GetParameters().Length;
        }
    }
}");

        Assert.Contains("GetParameters()", printed);
        Assert.DoesNotContain("import System.Reflection", printed);
    }

    [Fact]
    public void ArrayReceiverShapeAnalysis_OfHomonymElement_SynthesizesNoAlias()
    {
        // A source `ParameterInfo` makes the metadata one a homonym, which a
        // printing mapping disambiguates with a synthesized alias import. The
        // shape-only mapping must not register that alias either.
        string printed = Translate(@"
using System;

namespace Demo
{
    public class ParameterInfo
    {
    }

    public class C
    {
        public void M(int value)
        {
        }

        public int Count()
        {
            return typeof(C).GetMethod(""M"").GetParameters().Length;
        }
    }
}");

        Assert.Contains("GetParameters()", printed);
        Assert.DoesNotContain("System.Reflection", printed);
    }

    [Fact]
    public void PrintedElementReference_AfterShapeAnalysis_StillImportsItsNamespace()
    {
        // Negative control: the analysis-only mapping runs first; the printed
        // `ParameterInfo` reference that follows must still get its import.
        string printed = Translate(@"
using System;

namespace Demo
{
    public class C
    {
        public void M(int value)
        {
        }

        public string First()
        {
            int count = typeof(C).GetMethod(""M"").GetParameters().Length;
            return typeof(System.Reflection.ParameterInfo).Name + count;
        }
    }
}");

        Assert.Contains("import System.Reflection", printed);
        Assert.Contains("ParameterInfo", printed);
    }

    private static string Translate(string source)
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
