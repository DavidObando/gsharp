// <copyright file="Issue1913AttributeTranslationTests.cs" company="GSharp">
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
/// Regression tests for issue #1913: a PARAMETER attribute (e.g. <c>[Note] int
/// x</c>) was silently dropped from the translated G#, because
/// <c>MapParameter</c> never routed its <c>ParameterSyntax</c> through the
/// shared <c>MapAttributes</c> helper every other declaration kind (class,
/// method, property, field, ...) already calls — with no diagnostic to flag
/// the loss. Separately, a C# 11 generic attribute (<c>[Tag&lt;int&gt;]</c>)
/// emitted its type argument in angle brackets (<c>@Tag&lt;int&gt;</c>), which
/// G# cannot parse (GS0005 LessToken) since G# spells every generic
/// type-argument list in square brackets.
/// </summary>
public class Issue1913AttributeTranslationTests
{
    [Fact]
    public void ParameterAttribute_SimpleAttribute_IsNotDropped()
    {
        string printed = TranslateUnit(@"
using System;

[AttributeUsage(AttributeTargets.Parameter)]
public class NoteAttribute : Attribute
{
}

namespace Demo
{
    public class C
    {
        public void M([Note] int x)
        {
        }
    }
}");

        Assert.Contains("@Note", printed);
        Assert.Contains("@Note x int32", printed);
    }

    [Fact]
    public void GenericAttribute_TypeArgument_UsesSquareBrackets()
    {
        string printed = TranslateUnit(@"
using System;

[AttributeUsage(AttributeTargets.Class)]
public class TagAttribute<T> : Attribute
{
}

namespace Demo
{
    [Tag<int>]
    public class C
    {
    }
}");

        Assert.Contains("@Tag[int32]", printed);
        Assert.DoesNotContain("<int>", printed);
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
            d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
