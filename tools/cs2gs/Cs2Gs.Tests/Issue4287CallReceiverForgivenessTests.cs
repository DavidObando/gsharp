// <copyright file="Issue4287CallReceiverForgivenessTests.cs" company="GSharp">
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
/// Issue #4287: gsc reports GS0159 for an imported instance-method call on a
/// receiver that is <c>T?</c> in G#, as it already reported a member read
/// through one. Every path in cs2gs that emits a call therefore has to give
/// the receiver the same forgiveness a member read gets. Each test binds its
/// output with gsc, so a missed receiver fails as GS0159 rather than passing
/// on text alone.
/// </summary>
public class Issue4287CallReceiverForgivenessTests
{
    [Fact]
    public void GenericMethodCall_OnAFlowNarrowedNullableField_AssertsTheReceiver()
    {
        // C#'s flow analysis tracks the field's null state after the test (no
        // warning here). G# narrows only STABLE receivers (locals and `let`
        // fields, ADR-0069), and this field is a mutable `var`, so the G#
        // receiver needs `!!`. The generic-name call path used to translate
        // its receiver bare, unlike the non-generic one.
        string printed = TranslateUnit(@"
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
        private List<string>? items = new List<string> { ""a"" };

        public int F()
        {
            if (items != null)
            {
                return items.ConvertAll<int>(s => s.Length).Count + items.IndexOf(""a"");
            }

            return -1;
        }
    }
}");

        Assert.Contains("items!!.ConvertAll[int32]", printed, StringComparison.Ordinal);
        Assert.Contains("items!!.IndexOf(", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void DroppedByRefSuppression_OnAnotherTypeParameter_IsNotAsserted()
    {
        // Review finding: the suppressed `ref name!` fixes T, but the call
        // returns U (int), so nothing about the result became nilable and a
        // `!!` there would be spurious (and invalid on a value type).
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        private string? name = ""n"";

        private static U Pick<T, U>(ref T value, U result) => result;

        public int F() => Pick(ref name!, 1).CompareTo(0);
    }
}", bind: false);

        // Not bound: a source-declared `ref T` parameter call is a separate,
        // pre-existing translation gap; only the receiver decision is asserted.
        Assert.Contains("Pick(", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(")!!.CompareTo", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void GenericStaticCall_OnATypeReceiver_IsNotAsserted()
    {
        // The control: a type is not a value, so a generic static call through
        // it is never forgiven.
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public int F() => Array.Empty<string>().Length;
    }
}");

        Assert.Contains("Array.Empty[string]()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Array!!", printed, StringComparison.Ordinal);
    }

    private static string TranslateUnit(string source, bool bind = true)
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
        if (!bind)
        {
            return printed;
        }

        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must bind. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
