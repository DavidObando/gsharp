// <copyright file="Issue1899DelegateEventTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1899: <c>delegate</c> and <c>event</c> DECLARATIONS reported
/// CS2GS-GAP even though G# has canonical forms for both — a named delegate
/// type alias (ADR-0059, <c>type Name = delegate func(params) R</c>) and an
/// event declaration (ADR-0052), field-like or with explicit add/remove
/// accessors. Covers: a delegate with parameters and a return type, a void
/// delegate, a field-like event, an explicit add/remove event, and a generic
/// delegate declaration (issue #1960 item 1: generic delegate aliases are now
/// supported end to end).
/// </summary>
public class Issue1899DelegateEventTranslationTests
{
    [Fact]
    public void DelegateDeclaration_WithParametersAndReturnType_MapsToNamedDelegateAlias()
    {
        string rendered = Render(@"
namespace Corpus.Issue1899
{
    public delegate int Combine(int a, int b);
}
");

        Assert.Contains("type Combine = delegate func(a int32, b int32) int32", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DelegateDeclaration_VoidReturn_OmitsReturnClause()
    {
        string rendered = Render(@"
namespace Corpus.Issue1899
{
    public delegate void Note(string message);
}
");

        Assert.Contains("type Note = delegate func(message string)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("func(message string) ", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void EventFieldDeclaration_FieldLikeEvent_MapsToEventDeclaration()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1899
{
    public class TickSource
    {
        public event EventHandler? Ticked;

        public void Tick()
        {
            EventHandler? snapshot = Ticked;
            if (snapshot != null)
            {
                snapshot(this, EventArgs.Empty);
            }
        }
    }
}
");

        Assert.Contains("event Ticked (object?, EventArgs) -> void", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void EventDeclaration_ExplicitAddRemove_MapsToEventDeclarationWithAccessorBodies()
    {
        string rendered = Render(@"
using System;
using System.Collections.Generic;

namespace Corpus.Issue1899
{
    public delegate void MessageHandler(string message);

    public class Broadcaster
    {
        private readonly List<MessageHandler> _handlers = new List<MessageHandler>();

        public event MessageHandler Message
        {
            add { _handlers.Add(value); }
            remove { _handlers.Remove(value); }
        }
    }
}
");

        Assert.Contains("event Message MessageHandler", rendered, StringComparison.Ordinal);
        Assert.Contains("add {", rendered, StringComparison.Ordinal);
        Assert.Contains("remove {", rendered, StringComparison.Ordinal);
        Assert.Contains("_handlers.Add(value)", rendered, StringComparison.Ordinal);
        Assert.Contains("_handlers.Remove(value)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DelegateDeclaration_Generic_MapsToGenericNamedDelegateAlias()
    {
        // Issue #1960 item 1: generic delegate declarations now carry their
        // type parameters into the G# named delegate alias's bracket section
        // (ADR-0059 "Follow-up work", issue #1503; GS0234 retired) instead of
        // gapping loudly.
        string rendered = Render(@"
namespace Corpus.Issue1899
{
    public delegate T Selector<T>(T value);
}
");

        Assert.Contains("type Selector[T] = delegate func(value T) T", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
