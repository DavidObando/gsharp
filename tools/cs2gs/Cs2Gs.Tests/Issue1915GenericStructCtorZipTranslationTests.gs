// <copyright file="Issue1915GenericStructCtorZipTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1915's generic source-struct construction cases. Issue #2766 now
/// preserves the generic struct's real constructor and constructed call rather
/// than replaying the constructor as a composite literal.
open class Issue1915GenericStructCtorZipTranslationTests {
    @Fact
    func GenericStruct_PlainParameterAssignCtor_PreservesConstructedCall() {
        let printed = TranslateUnit(`
namespace Demo
{
    public struct Slot<T>
    {
        private readonly T _content;
        public Slot(T content) { _content = content; }
        public T Content => _content;
    }

    public class C
    {
        public Slot<int> Make() => new Slot<int>(42);
    }
}`)
        Assert.Contains("init(content T)", printed)
        Assert.Contains("Slot[int32](42)", printed)
    }

    @Fact
    func GenericStruct_MultiParameterCtor_PreservesDeclaredParameterOrder() {
        let printed = TranslateUnit(`
namespace Demo
{
    public struct Pair<T>
    {
        public readonly T First;
        public readonly T Second;
        public Pair(T first, T second) { First = first; Second = second; }
    }

    public class C
    {
        public Pair<string> Make() => new Pair<string>("a", "b");
    }
}`)
        Assert.Contains("init(first T, second T)", printed)
        Assert.Contains("Pair[string](\"a\", \"b\")", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
