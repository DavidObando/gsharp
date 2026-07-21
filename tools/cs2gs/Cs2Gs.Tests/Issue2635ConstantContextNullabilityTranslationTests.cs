// <copyright file="Issue2635ConstantContextNullabilityTranslationTests.cs" company="GSharp">
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

public class Issue2635ConstantContextNullabilityTranslationTests
{
    [Fact]
    public void ConstantStringConcatenations_RemainConstantForFieldsAndLocals()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private const string Extension = "".json"";
        public const string Settings = ""appsettings"" + Extension;

        public string UserAgent()
        {
            const string value = ""Mozilla/5.0 "" + ""AppleWebKit/537.36"";
            return value;
        }
    }
}");

        Assert.Contains("const Settings string = \"appsettings\" + C.Extension", printed);
        Assert.Contains("const value = \"Mozilla/5.0 \" + \"AppleWebKit/537.36\"", printed);
        Assert.DoesNotContain("!!", printed);
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
