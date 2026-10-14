// <copyright file="Issue3424NonBindingPropertyPatternTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3424: non-binding property patterns over implicit property or field
/// receivers must use native G# patterns because gsc does not smart-cast members.
class Issue3424NonBindingPropertyPatternTranslationTests {
    @Fact
    func ImplicitPropertyReceiver_UsesNativePatternAndEvaluatesOnce() {
        let printed = Translate(Symbols + `public sealed class C
{
    private readonly BoundPattern pattern =
        new BoundTypePattern { PropertyPattern = null, HasBinding = false };
    private int reads;

    private BoundPattern Pattern
    {
        get
        {
            reads++;
            return pattern;
        }
    }

    public int Run()
    {
        bool matched = Pattern is BoundTypePattern
        {
            PropertyPattern: null,
            HasBinding: false,
        };
        return matched ? reads : -1;
    }
    }
}`)
        Assert.Contains(
            "Pattern is BoundTypePattern and { PropertyPattern: nil, HasBinding: false }",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("Pattern.PropertyPattern", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run())", "1")
    }

    @Fact
    func ImplicitFieldReceiver_UsesNativePatternAndBinds() {
        let printed = Translate(Symbols + `public sealed class C
{
    private readonly BoundPattern pattern =
        new BoundTypePattern { PropertyPattern = null, HasBinding = false };

    public bool IsSimple =>
        pattern is BoundTypePattern
        {
            PropertyPattern: null,
            HasBinding: false,
        };
    }
}`)
        Assert.Contains(
            "pattern is BoundTypePattern and { PropertyPattern: nil, HasBinding: false }",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("pattern.PropertyPattern", printed, StringComparison.Ordinal)
    }

    shared {
        private const Symbols string = `namespace Demo
{
    public abstract class BoundPattern
    {
    }

    public sealed class BoundTypePattern : BoundPattern
    {
        public object? PropertyPattern { get; init; }
        public bool HasBinding { get; init; }
    }`

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
            )
            TranslationTestValidation.AssertBinds(printed)
            return printed
        }
    }
}
