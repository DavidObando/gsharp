// <copyright file="Issue2835NominalDelegateTypeTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2835 — cs2gs used to erase EVERY delegate type to G#'s structural
/// arrow form (<c>(string) -&gt; void</c>), including delegates declared in the
/// source being translated. CLR delegates are nominally typed, so a
/// <c>List&lt;MessageHandler&gt;</c> that became <c>List[Action[string]]</c>
/// blew up at runtime the moment a real <c>MessageHandler</c> was added to it:
/// <c>ArgumentException: The value "MessageHandler" is not of type
/// "System.Action`1[System.String]"</c>.
/// <para>
/// A source-declared delegate now keeps its nominal name in every type
/// position — cs2gs already emits a real <c>delegate X(…) </c>;
/// declaration for it. Imported/BCL delegates (<c>Func</c>, <c>Action</c>,
/// <c>Predicate</c>) still render in arrow form (ADR-0115 §B.8).
/// </para>
/// </summary>
public class Issue2835NominalDelegateTypeTranslationTests
{
    private const string Source = @"
using System;
using System.Collections.Generic;

namespace Corpus.Delegates
{
    public delegate void MessageHandler(string message);

    public delegate T Projector<T>(T input);

    public class Broadcaster
    {
        private readonly List<MessageHandler> _handlers = new List<MessageHandler>();

        public MessageHandler Last;

        public event MessageHandler Message
        {
            add { _handlers.Add(value); }
            remove { _handlers.Remove(value); }
        }

        public void Register(MessageHandler handler)
        {
            _handlers.Add(handler);
        }

        public MessageHandler First()
        {
            return _handlers[0];
        }

        public void UseBcl(Func<string, int> length, Action<string> sink, Predicate<string> test)
        {
            sink(length(""x"").ToString() + test(""y"").ToString());
        }
    }
}
";

    [Fact]
    public void SourceDelegate_KeepsNominalName_AsFieldType()
    {
        string rendered = Render();

        Assert.Contains("List[MessageHandler]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("List[(string) -> void]", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void SourceDelegate_KeepsNominalName_AsPlainFieldParameterAndReturnType()
    {
        string rendered = Render();

        Assert.Contains("Last MessageHandler", rendered, StringComparison.Ordinal);
        Assert.Contains("Register(handler MessageHandler)", rendered, StringComparison.Ordinal);
        Assert.Contains("First() MessageHandler", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void SourceDelegate_StillEmitsItsTypeAliasDeclaration()
    {
        string rendered = Render();

        Assert.Contains("delegate MessageHandler(message string);", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void BclDelegates_StillRenderInArrowForm()
    {
        string rendered = Render();

        Assert.Contains("length (string) -> int32", rendered, StringComparison.Ordinal);
        Assert.Contains("sink (string) -> void", rendered, StringComparison.Ordinal);
        Assert.Contains("test (string) -> bool", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void GenericSourceDelegate_KeepsNominalNameWithTypeArguments()
    {
        const string genericSource = @"
using System.Collections.Generic;

namespace Corpus.Delegates
{
    public delegate T Projector<T>(T input);

    public class Pipeline
    {
        public List<Projector<int>> Stages = new List<Projector<int>>();
    }
}
";
        string rendered = GSharpPrinter.Print(Translate(genericSource));

        Assert.Contains("List[Projector[int32]]", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void EventHandlerType_IsStillNominal()
    {
        // MapEventType already preserved nominal identity for the event's own
        // handler type; this pins that it still does.
        CompilationUnit unit = Translate(Source);
        TypeDeclaration broadcaster = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Broadcaster");
        EventDeclaration message = broadcaster.Members.OfType<EventDeclaration>().Single(e => e.Name == "Message");

        Assert.Equal("MessageHandler", ((NamedTypeReference)message.Type).Name);
    }

    [Fact]
    public void NestedDelegates_LiftToDistinctTopLevelNominalTypes()
    {
        const string nestedSource = @"
namespace Corpus.Delegates
{
    public class First
    {
        internal delegate int Transform(int value);
        private Transform transform = value => value + 1;

        public int Apply(int value) => transform(value);
    }

    public class Second
    {
        internal delegate int Transform(int value);
        private Transform transform = value => value + 2;

        public int Apply(int value) => transform(value);
    }
}
";

        CompilationUnit unit = Translate(nestedSource);
        string rendered = GSharpPrinter.Print(unit);

        Assert.Contains("type First_Transform = delegate func", rendered, StringComparison.Ordinal);
        Assert.Contains("type Second_Transform = delegate func", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("First.Transform", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Second.Transform", rendered, StringComparison.Ordinal);

        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Errors));
    }

    private static string Render() => GSharpPrinter.Print(Translate(Source));

    private static CompilationUnit Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Delegates.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return new CSharpToGSharpTranslator().TranslateDocument(document, context);
    }
}
