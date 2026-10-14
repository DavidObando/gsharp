// <copyright file="Issue4679NamedBclDelegateIdentityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Collections.Generic
import System.Threading
import Xunit

class Issue4679NamedBclDelegateIdentityTranslationTests {
    @Theory
    @InlineData("Predicate<string>", typeof(Predicate[string]))
    @InlineData("Predicate<>", typeof(Predicate[_]))
    @InlineData("Predicate<string>[]", typeof([]Predicate[string]))
    @InlineData("List<Predicate<string>>", typeof(List[Predicate[string]]))
    @InlineData("Func<Predicate<string>>", typeof(() -> Predicate[string]))
    @InlineData("(Predicate<string>, int)", typeof((Predicate[string], int32)))
    @InlineData("Comparison<string>", typeof(Comparison[string]))
    @InlineData("(Comparison<string>, int)", typeof((Comparison[string], int32)))
    @InlineData("Converter<string, int>", typeof(Converter[string, int32]))
    @InlineData("ThreadStart", typeof(ThreadStart))
    @InlineData("Func<ThreadStart>", typeof(() -> ThreadStart))
    @InlineData("Action<string>", typeof((string) -> void))
    @InlineData("Func<string, bool>", typeof((string) -> bool))
    func TypeOf_PreservesExactClrIdentity(type string, expected Type) {
        let printed = Translate((`using System;
using System.Collections.Generic;
using System.Threading;

public class Probe
{
    public Type Observe() => typeof(` + "$type" + `);
}`))
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe().Observe()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(expected, result.Value)
    }

    @Fact
    func CastsPatternsAndGenericArguments_ObserveTheOriginalDelegate() {
        let printed = Translate(`using System;

public class Probe
{
    public Type Identity<T>() => typeof(T);
    public Type Infer<T>(T value) => typeof(T);

    public bool Observe()
    {
        var predicate = new Predicate<string>(value => value.Length > 0);
        object boxed = predicate;
        var converted = (Predicate<string>)boxed;
        var safe = boxed as Predicate<string>;
        return boxed.GetType() == typeof(Predicate<string>)
            && boxed is Predicate<string>
            && boxed is Predicate<string> matched && matched("x")
            && !(boxed is Func<string, bool>)
            && converted("x")
            && safe != null && safe("x")
            && Identity<Predicate<string>>() == typeof(Predicate<string>)
            && Infer(predicate) == typeof(Predicate<string>);
    }
}`)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe().Observe()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(true, result.Value)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.Empty(context.Diagnostics)
            return printed
        }
    }
}
