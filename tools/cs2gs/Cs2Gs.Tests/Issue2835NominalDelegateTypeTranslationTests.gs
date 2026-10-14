// <copyright file="Issue2835NominalDelegateTypeTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #2835 — cs2gs used to erase EVERY delegate type to G#'s structural
/// arrow form (`(string) -> void`), including delegates declared in the
/// source being translated. CLR delegates are nominally typed, so a
/// `List<MessageHandler>` that became `List[Action[string]]`
/// blew up at runtime the moment a real `MessageHandler` was added to it:
/// `ArgumentException: The value "MessageHandler" is not of type
/// "System.Action`1[System.String]"`.
///
/// A source-declared delegate now keeps its nominal name in every type
/// position — cs2gs already emits a real `delegate X(…) `;
/// declaration for it. Imported/BCL delegates retain arrow form only for
/// `Func`/`Action` (ADR-0115 §B.8).
open class Issue2835NominalDelegateTypeTranslationTests {
    @Fact
    func SourceDelegate_KeepsNominalName_AsFieldType() {
        let rendered = Render()
        Assert.Contains("List[MessageHandler]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("List[(string) -> void]", rendered, StringComparison.Ordinal)
    }

    @Fact
    func SourceDelegate_KeepsNominalName_AsPlainFieldParameterAndReturnType() {
        let rendered = Render()
        Assert.Contains("Last MessageHandler", rendered, StringComparison.Ordinal)
        Assert.Contains("Register(handler MessageHandler)", rendered, StringComparison.Ordinal)
        Assert.Contains("First() MessageHandler", rendered, StringComparison.Ordinal)
    }

    @Fact
    func SourceDelegate_StillEmitsItsTypeAliasDeclaration() {
        let rendered = Render()
        Assert.Contains("delegate MessageHandler(message string);", rendered, StringComparison.Ordinal)
    }

    @Fact
    func FuncAndAction_RenderInArrowForm_WhilePredicateKeepsNominalName() {
        let rendered = Render()
        Assert.Contains("length (string) -> int32", rendered, StringComparison.Ordinal)
        Assert.Contains("sink (string) -> void", rendered, StringComparison.Ordinal)
        Assert.Contains("test Predicate[string]", rendered, StringComparison.Ordinal)
    }

    @Fact
    func GenericSourceDelegate_KeepsNominalNameWithTypeArguments() {
        const genericSource = `
using System.Collections.Generic;

namespace Corpus.Delegates
{
    public delegate T Projector<T>(T input);

    public class Pipeline
    {
        public List<Projector<int>> Stages = new List<Projector<int>>();
    }
}
`
        let rendered = GSharpPrinter.Print(Translate(genericSource))
        Assert.Contains("List[Projector[int32]]", rendered, StringComparison.Ordinal)
    }

    @Fact
    func EventHandlerType_IsStillNominal() {
        // MapEventType already preserved nominal identity for the event's own
        // handler type; this pins that it still does.
        let unit = Translate(Source)
        let broadcaster = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Broadcaster")
        let message = broadcaster.Members.OfType[EventDeclaration]().Single((e EventDeclaration) -> e.Name == "Message")
        Assert.Equal("MessageHandler", (cast[NamedTypeReference](message.Type)).Name)
    }

    @Fact
    func NestedDelegates_LiftToDistinctTopLevelNominalTypes() {
        const nestedSource = `
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
`
        let unit = Translate(nestedSource)
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("delegate First_Transform(", rendered, StringComparison.Ordinal)
        Assert.Contains("delegate Second_Transform(", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("First.Transform", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Second.Transform", rendered, StringComparison.Ordinal)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
        Assert.True(result!!.Success, string.Join(Environment.NewLine, result!!.Errors))
    }

    shared {
        private const Source string = `
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
            sink(length("x").ToString() + test("y").ToString());
        }
    }
}
`

        private func Render() string -> GSharpPrinter.Print(Translate(Source))

        private func Translate(source string) CompilationUnit {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Delegates.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return CSharpToGSharpTranslator().TranslateDocument(document, context)
        }
    }
}
