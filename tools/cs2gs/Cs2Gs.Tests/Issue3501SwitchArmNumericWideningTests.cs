// <copyright file="Issue3501SwitchArmNumericWideningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 (Translator burn-down, GS0179 family): C# target-types every
/// switch-expression arm to the switch's converted type (`long candidate =
/// value switch { sbyte item => item, ... }` widens each numeric arm to `long`
/// implicitly), while gsc requires every arm to produce the same type as the
/// first arm. A numeric arm whose own type differs from its C# converted type
/// must therefore spell the conversion C# inserted (`int64(item)`).
/// </summary>
public class Issue3501SwitchArmNumericWideningTests
{
    [Fact]
    public void SwitchExpression_NumericArms_WidenToConvertedType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Probe
    {
        public static long Classify(object value)
        {
            long candidate = value switch
            {
                sbyte item => item,
                int item => item,
                long item => item,
                _ => -1,
            };

            return candidate;
        }
    }
}
");

        // Each narrower numeric arm carries the explicit widening C# applied
        // implicitly; the already-long arm stays bare.
        Assert.Contains("int64(item)", printed, StringComparison.Ordinal);
        Assert.Contains("int64(-1)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void SwitchExpression_UniformArms_StayBare()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Probe
    {
        public static int Classify(int value)
        {
            int result = value switch
            {
                0 => 10,
                1 => 20,
                _ => 30,
            };

            return result;
        }
    }
}
");

        Assert.DoesNotContain("int32(", printed, StringComparison.Ordinal);
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
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = Cs2Gs.CodeModel.Printing.GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
