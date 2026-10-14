// <copyright file="Issue914FoundationSinkTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Translator-fidelity tests for the residual Oahu.Foundation oblivious-sink
/// defects fixed under issue #914:
/// 1. an explicit constructor parameter receives ordinary oblivious-nullability promotion,
/// 2. a null-conditional delegate invoke on a non-simple (call / `??`) receiver emits directly without
/// a translator spill,
/// 3. a promoted-nullable function value subscribed to a CLR event must be forgiven with `!!` at the
/// subscription sink,
/// 4. a CLR reference cast `(T)expr` emits the unambiguous checked cast `cast[T](expr)`.
/// Every promotion is gated to oblivious compilations, so a nullable-enabled
/// compilation stays byte-identical (unpromoted).
open class Issue914FoundationSinkTranslationTests {
    @Fact
    func Oblivious_ExplicitConstructorDelegateParameter_PromotesToNullable() {
        // `report` is invoked null-conditionally and a derived ctor forwards a
        // promoted-nullable `base(report)` argument, so the kept explicit
        // constructor parameter must render `((T) -> void)?`.
        let printed = TranslateOblivious(`
using System;
namespace Demo
{
    public abstract class ProgressBase<T>
    {
        private readonly Action<T> report;
        protected ProgressBase(Action<T> report) { this.report = report; }
        public void Fire(T v) { report?.Invoke(v); }
    }

    public class ProgressImpl : ProgressBase<int>
    {
        public ProgressImpl(Action<int> report = null) : base(report) { }
    }
}`)
        Assert.Contains("abstract class ProgressBase[T] {", printed)
        Assert.Contains("init(report ((T) -> void)?)", printed)
    }

    @Fact
    func Enabled_ExplicitConstructorDelegateParameter_StaysUnpromoted() {
        // Under a nullable-ENABLED compilation the whole-program taint analysis
        // short-circuits to false, so the explicit constructor parameter stays
        // the non-nullable `(T) -> void`.
        let printed = TranslateEnabled(`
using System;
namespace Demo
{
    public abstract class ProgressBase<T>
    {
        private readonly Action<T> report;
        protected ProgressBase(Action<T> report) { this.report = report; }
        public void Fire(T v) { report?.Invoke(v); }
    }

    public class ProgressImpl : ProgressBase<int>
    {
        public ProgressImpl(Action<int>? report = null) : base(report) { }
    }
}`)
        Assert.Contains("abstract class ProgressBase[T] {", printed)
        Assert.Contains("init(report (T) -> void)", printed)
        Assert.DoesNotContain("init(report ((T) -> void)?)", printed)
    }

    @Fact
    func Oblivious_NullConditionalDelegateInvokeOnCallReceiver_InvokesDirectly() {
        // Issue #3356: both generic `.Invoke` lookup and direct `recv?(args)`
        // parsing now work, so no translator spill is needed.
        let printed = TranslateOblivious(`
using System;
namespace Demo
{
    public class C
    {
        private Func<T, string> ToStringFunc<T>() => null;
        public string ToString<T>(T val) => ToStringFunc<T>()?.Invoke(val);
    }
}`)
        Assert.DoesNotContain(".Invoke", printed)
        Assert.Contains("ToStringFunc[T]()?(val)", printed)
        Assert.DoesNotContain("__spill", printed)
    }

    @Fact
    func Oblivious_PromotedDelegateSubscribedToEvent_PreservesNilableHandler() {
        // `handler` is a delegate parameter defaulted to `null`, so it promotes to
        // `((object, EventArgs) -> void)?`. Issue #3775 made event subscription
        // itself nil-tolerant, matching Delegate.Combine/Remove, so cs2gs must
        // preserve the handler instead of restoring the old throwing `!!` bridge.
        let printed = TranslateOblivious(`
using System;
namespace Demo
{
    public delegate void MyHandler(object sender, EventArgs e);

    public class Source
    {
        public event MyHandler Fired;
    }

    public class C
    {
        public void Sub(Source s, MyHandler handler = null)
        {
            s.Fired += handler;
        }
    }
}`)
        Assert.Contains("s.Fired += handler", printed)
        Assert.DoesNotContain("s.Fired += handler!!", printed)
    }

    @Fact
    func ReferenceDowncast_EmitsCheckedConversionCall() {
        // `(IEnumerable)o` is a CLR checked reference downcast.
        let printed = TranslateOblivious(`
using System.Collections;
namespace Demo
{
    public class C
    {
        public void Iter(object o)
        {
            foreach (var x in (IEnumerable)o) { }
        }
    }
}`)
        Assert.Contains("cast[IEnumerable](o)", printed)
        Assert.DoesNotContain("o as IEnumerable", printed)
    }

    @Fact
    func ReferenceDowncast_BetweenClasses_EmitsCheckedConversionCall() {
        // A class-to-derived-class downcast uses the same canonical call form.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Animal { }
    public class Dog : Animal { public void Bark() { } }

    public class C
    {
        public void Run(Animal a)
        {
            ((Dog)a).Bark();
        }
    }
}`)
        Assert.Contains("cast[Dog](a)", printed)
        Assert.DoesNotContain("a as Dog", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func TranslateEnabled(source string) string {
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.EnabledInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Select((r MetadataReference) -> r).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
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
