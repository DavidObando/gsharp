// <copyright file="Issue914FoundationSinkTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for the residual Oahu.Foundation oblivious-sink
/// defects fixed under issue #914:
/// <list type="number">
/// <item>an explicit constructor parameter receives ordinary
/// oblivious-nullability promotion,</item>
/// <item>a null-conditional delegate invoke on a non-simple (call / <c>??</c>)
/// receiver must spill the receiver into a local and invoke it directly,</item>
/// <item>a promoted-nullable function value subscribed to a CLR event must be
/// forgiven with <c>!!</c> at the subscription sink,</item>
/// <item>a CLR reference cast <c>(T)expr</c> must emit the <c>expr as T</c>
/// downcast form, not the value-conversion call <c>T(expr)</c>.</item>
/// </list>
/// Every promotion is gated to oblivious compilations, so a nullable-enabled
/// compilation stays byte-identical (unpromoted).
/// </summary>
public class Issue914FoundationSinkTranslationTests
{
    [Fact]
    public void Oblivious_ExplicitConstructorDelegateParameter_PromotesToNullable()
    {
        // `report` is invoked null-conditionally and a derived ctor forwards a
        // promoted-nullable `base(report)` argument, so the kept explicit
        // constructor parameter must render `((T) -> void)?`.
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("open class ProgressBase[T] {", printed);
        Assert.Contains("init(report ((T) -> void)?)", printed);
    }

    [Fact]
    public void Enabled_ExplicitConstructorDelegateParameter_StaysUnpromoted()
    {
        // Under a nullable-ENABLED compilation the whole-program taint analysis
        // short-circuits to false, so the explicit constructor parameter stays
        // the non-nullable `(T) -> void`.
        string printed = TranslateEnabled(@"
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
}");

        Assert.Contains("open class ProgressBase[T] {", printed);
        Assert.Contains("init(report (T) -> void)", printed);
        Assert.DoesNotContain("init(report ((T) -> void)?)", printed);
    }

    [Fact]
    public void Oblivious_NullConditionalDelegateInvokeOnCallReceiver_SpillsAndInvokesDirectly()
    {
        // `ToStringFunc<T>()?.Invoke(val)` — a null-conditional invoke whose
        // receiver is a generic call — cannot use `.Invoke` (gsc can't resolve it
        // on a type-parameter function type) nor `recv?(args)` (ternary collision),
        // so the receiver spills into a local invoked directly as `local?(val)`.
        string printed = TranslateOblivious(@"
using System;
namespace Demo
{
    public class C
    {
        private Func<T, string> ToStringFunc<T>() => null;
        public string ToString<T>(T val) => ToStringFunc<T>()?.Invoke(val);
    }
}");

        Assert.DoesNotContain(".Invoke", printed);
        Assert.Contains("__spill", printed);
        Assert.Contains("?(val)", printed);
    }

    [Fact]
    public void Oblivious_PromotedDelegateSubscribedToEvent_ForgivesRhsWithBang()
    {
        // `handler` is a delegate parameter defaulted to `null`, so it promotes to
        // `((object, EventArgs) -> void)?`. Subscribing it to the named-delegate
        // event `Fired` needs a `!!` so the promoted `T?` converts to the event's
        // non-nullable delegate type (GS0155 otherwise).
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("s.Fired += handler!!", printed);
    }

    [Fact]
    public void ReferenceDowncast_EmitsAsForm_NotConversionCall()
    {
        // `(IEnumerable)o` is a CLR reference downcast: it must render the
        // `o as IEnumerable` downcast form, never the value-conversion call
        // `IEnumerable(o)` (which gsc rejects for a reference target).
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("o as IEnumerable", printed);
        Assert.DoesNotContain("IEnumerable(o", printed);
    }

    [Fact]
    public void ReferenceDowncast_BetweenClasses_EmitsAsForm()
    {
        // A class-to-derived-class downcast is also a reference conversion and
        // must use the `as` form rather than a constructor-shaped call, which
        // would otherwise be parsed as instantiating the target type.
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("as Dog", printed);
        Assert.DoesNotContain("Dog(a", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string TranslateEnabled(string source)
    {
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.EnabledInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Select(r => r).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
