// <copyright file="Issue1915OpenGenericTypeOfTranslationTests.cs" company="GSharp">
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
/// Issue #1915 (sub-bug b): <c>typeof(List&lt;&gt;)</c> (an unbound generic
/// operand, <c>GenericNameSyntax.IsUnboundGenericName == true</c>) originally
/// translated to the bare generic-definition name <c>typeof(List)</c> — that
/// half was correct at the time (G# had no bracket syntax for an open
/// generic, so the bare name was the only spelling available), but gsc's OWN
/// binder could not resolve a bare imported-CLR-generic name at all (it only
/// tried the exact, non-generic reflection name), so the printed G# failed
/// to compile with GS0113 "Type 'List' doesn't exist." Fixed on the gsc side:
/// a bare simple name inside <c>typeof(...)</c> now falls back to an
/// arity-suffixed (<c>`1</c>, <c>`2</c>, …) reflection lookup across the
/// file's imports and binds to the CLR open generic type definition when
/// exactly one match exists.
/// <para>
/// Issue #2012 (S1): the bare-name fallback stays ambiguous (GS0113) for
/// same-base-name multi-arity BCL families (<c>Func</c>, <c>Action</c>, …),
/// so #1989/#2011 added an explicit-arity spelling via <c>_</c> placeholder
/// bracket type arguments (<c>typeof(Name[_, ...])</c>). cs2gs now emits
/// THAT canonical form for every unbound generic — carrying the arity C#
/// derives from comma count the same way — rather than the bare name, so the
/// translated output round-trips correctly for every family, not just
/// single-arity ones.
/// </para>
/// </summary>
public class Issue1915OpenGenericTypeOfTranslationTests
{
    [Fact]
    public void UnboundGenericType_TypeOf_TranslatesToUnderscorePlaceholderAndRoundTrips()
    {
        string printed = TranslateUnit(@"
using System;
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(List<>);
    }
}");

        Assert.Contains("typeof(List[_])", printed);
    }

    [Fact]
    public void UnboundGenericType_TwoArity_TranslatesToUnderscorePlaceholderAndRoundTrips()
    {
        string printed = TranslateUnit(@"
using System;
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(Dictionary<,>);
    }
}");

        Assert.Contains("typeof(Dictionary[_, _])", printed);
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

        Assert.Empty(context.Diagnostics);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
