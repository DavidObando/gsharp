// <copyright file="Issue4113NominalDelegateIdentityInExpressionsTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #4113: a nominal CLR delegate
/// (<c>EventHandler</c>, <c>EventHandler&lt;T&gt;</c>) referenced from a
/// <c>typeof(...)</c> operand or an explicit generic type argument must keep
/// its nominal identity, exactly like <c>MapExplicitType</c> already
/// preserves it for a variable's declared type (issue #2835/#3841).
/// <para>
/// Before this fix, <c>MapTypeOf</c> (the <c>typeof(...)</c> operand mapper)
/// and <c>MapTypeArguments</c> (the explicit-type-argument mapper) both
/// routed through the general, structurally-canonicalizing <c>Map</c>
/// pipeline, which silently rewrote <c>typeof(EventHandler)</c> into
/// <c>typeof(Action&lt;object, EventArgs&gt;)</c> — a DIFFERENT runtime
/// <see cref="Type"/>. That is invisible at the printed-G#-source level only
/// if you don't check it, but it defeats any test (or, once this exact
/// translator source is itself self-hosted, any compiler logic — see
/// <c>MemberLookup.CanonicalizeWellKnownEventHandler</c>) that relies on
/// <c>typeof(EventHandler)</c> actually meaning <c>System.EventHandler</c>.
/// </para>
/// </summary>
public class Issue4113NominalDelegateIdentityInExpressionsTranslationTests
{
    [Fact]
    public void TypeOfNominalEventHandler_PreservesNominalIdentity()
    {
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public class C
    {
        public Type F() => typeof(EventHandler);
    }
}");

        Assert.Contains("typeof(EventHandler)", printed);
        Assert.DoesNotContain("EventArgs) -> void", printed);
    }

    [Fact]
    public void TypeOfClosedGenericNominalEventHandler_PreservesNominalIdentity()
    {
        string printed = TranslateUnit(@"
using System;
using System.ComponentModel;

namespace Demo
{
    public class C
    {
        public Type F() => typeof(EventHandler<PropertyChangedEventArgs>);
    }
}");

        Assert.Contains("typeof(EventHandler[PropertyChangedEventArgs])", printed);
        Assert.DoesNotContain("EventArgs) -> void", printed);
    }

    [Fact]
    public void ExplicitGenericTypeArgumentOfNominalEventHandler_PreservesNominalIdentity()
    {
        // The exact shape behind EventEmitTests' `Assert.IsType<EventHandler>(del)`
        // (#4113): an explicit type argument on a generic method call.
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public class C
    {
        public bool F(object del) => Describe<EventHandler>(del);

        public bool Describe<T>(object value) => value is T;
    }
}");

        Assert.Contains("Describe[EventHandler](del)", printed);
        Assert.DoesNotContain("Describe[(object", printed);
    }

    [Fact]
    public void TypeOfOrdinaryActionDelegate_StillCanonicalizesToStructuralForm()
    {
        // Precision guard: Func/Action/Predicate are the canonical structural
        // spelling's own identity (issue #2835's own exclusion) — typeof over
        // one of those must keep collapsing to the arrow form, unlike
        // EventHandler above.
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public class C
    {
        public Type F() => typeof(Action<object, EventArgs>);
    }
}");

        Assert.Contains("typeof((object, EventArgs) -> void)", printed);
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip and bind. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
