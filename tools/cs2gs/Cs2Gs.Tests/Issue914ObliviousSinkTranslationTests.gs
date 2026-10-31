// <copyright file="Issue914ObliviousSinkTranslationTests.cs" company="GSharp">
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

/// Translator-fidelity tests for issue #914: the oblivious-nullability taint
/// analysis ((cref:ObliviousNullabilityAnalyzer)) already promotes
/// null-reachable reference SOURCES (returns, fields, locals, null-checked
/// params) to `T?`. These tests cover the complementary SINK positions
/// that must also be promoted so a promoted `T?` value flows without a
/// GS0154/GS0155/GS0156 "T? vs T" error:
/// 1. tuple return-element types,
/// 2. lambda / local-function return types,
/// 3. property-getter return types that forward a promoted backing field,
/// 4. designated-constructor parameters reached via a `: this(...)` delegation carrying null,
/// 5. delegate parameters invoked with a null argument.
/// All promotions are gated to oblivious compilations, so a
/// nullable-<em>enabled</em> compilation stays byte-identical (unpromoted).
open class Issue914ObliviousSinkTranslationTests {
    @Fact
    func Oblivious_TupleReturn_PromotesElementTypesToNullable() {
        // `dir`/`file` are null-tainted locals; the `(string, string)` return
        // type must promote its element types so `return (dir, file)` (which
        // yields `(string?, string?)`) does not trip GS0155.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public (string, string) Get(bool b)
        {
            string dir = "d";
            string file = "f";
            if (b) { dir = null; file = null; }
            return (dir, file);
        }
    }
}`)
        Assert.Contains("Get(b bool) (string?, string?)", printed)
    }

    @Fact
    func Oblivious_LocalFunctionReturn_PromotesToNullable() {
        // The local function `Parse` returns null on a path, so its return type
        // must render `string?` exactly like a method return.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public void Run(string s)
        {
            string Parse(string v)
            {
                if (v == null) { return null; }
                return v;
            }

            var x = Parse(s);
        }
    }
}`)
        Assert.Contains("func (v string?) string?", printed)
    }

    @Fact
    func Oblivious_PropertyGetterForwardingPromotedField_PromotesPropertyType() {
        // `writer` is null-tainted (assigned null), so the backing field is
        // `StreamWriter?`; the expression-bodied getter `Writer => writer`
        // forwards it, so the property type must promote to `TextWriter?`.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        private System.IO.StreamWriter writer;

        public System.IO.TextWriter Writer => this.writer;

        public void Clear() { this.writer = null; }
    }
}`)
        Assert.Contains("Writer TextWriter?", printed)
    }

    @Fact
    func Oblivious_DesignatedConstructorReachedWithNull_PromotesParameters() {
        // The convenience ctor `C() : this(null, null)` delegates to the
        // designated ctor; the analyzer follows the constructor-initializer
        // arg->param edges, so `context`/`message` must render `string?`.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public C(string context, string message) { }

        public C() : this(null, null) { }
    }
}`)
        Assert.Contains("init(context string?, message string?)", printed)
    }

    @Fact
    func Enabled_DesignatedConstructorReachedWithNull_PromotesParameters() {
        // Issue #5508: the SAME shape under a nullable-ENABLED compilation. The
        // C# author passes the literal `null` at a parameter the annotations
        // declare non-null, which C# only warns about but gsc rejects at a
        // non-nullable reference slot (#4316). The parameters follow the
        // author's null, exactly as the oblivious twin above does.
        let printed = TranslateEnabled(`
namespace Demo
{
    public class C
    {
        public C(string context, string message) { }

        public C() : this(null, null) { }
    }
}`, "Round-trip only: this snippet pins the declaration, not a bound program.")
        Assert.Contains("init(context string?, message string?)", printed)
    }

    @Fact
    func Oblivious_DelegateParameterInvokedWithNull_PromotesArrowParameter() {
        // `cb` is invoked with a null argument, so its delegate parameter type
        // must promote to `object?` (an arrow parameter position).
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public void Run(System.Action<object> cb)
        {
            cb(null);
        }
    }
}`)
        Assert.Contains("(object?) -> void", printed)
    }

    @Fact
    func Oblivious_ShadowedNestedDelegateParameter_DoesNotPromoteOuterParameter() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public void Run(System.Action<object> callback)
        {
            System.Action<System.Action<object>> invoke =
                callback => callback(null);
        }
    }
}`)
        Assert.Contains("Run(callback (object) -> void)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Run(callback (object?) -> void)", printed, StringComparison.Ordinal)
    }

    @Fact
    func Oblivious_SourceNamedDelegatePromotion_IsConsistentAcrossForwardingParameters() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Item { }
    public delegate void Handler(Item item);

    public class Runner
    {
        public void Start(Handler handler)
        {
            Forward(handler);
        }

        private void Forward(Handler handler)
        {
            Invoke(handler);
        }

        private void Invoke(Handler handler)
        {
            handler(null);
        }
    }
}`)
        // Issue #2835: a source-declared delegate keeps its NOMINAL name at
        // every use site (CLR delegates are nominally typed), so the oblivious
        // promotion of the delegate's own parameter lands once, on the delegate
        // declaration, instead of being re-encoded into an erased arrow form at
        // all three forwarding parameters.
        Assert.Contains("delegate Handler(item Item?);", printed, StringComparison.Ordinal)
        Assert.Equal(3, printed.Split("handler Handler", StringSplitOptions.None).Length - 1)
        Assert.DoesNotContain("(Item?) -> void", printed, StringComparison.Ordinal)
    }

    @Fact
    func Oblivious_SourceNamedDelegate_WidensContractForPromotedArgument() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Item { }
    public class Holder
    {
        public Item Value { get; set; }
    }

    public delegate void Handler(Item value);

    public class C
    {
        public void Run(Handler handler, Holder holder)
        {
            holder.Value = null;
            var value = holder.Value;
            handler(value);
        }
    }
}`)
        Assert.True(printed.Contains("delegate Handler(value Item?);", StringComparison.Ordinal), printed)
        Assert.Contains("handler(value)", printed)
        Assert.DoesNotContain("handler(value!!)", printed)
    }

    @Fact
    func Oblivious_NullableDelegateForwardedThroughGenericMethods_PromotesEveryParameter() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Book { }
    public class Conversion { }
    public class Context { }
    public delegate void ConvertDelegate<T>(Book book, T context, System.Action<Conversion> callback);

    public class Job<T>
    {
        public void Start(ConvertDelegate<T> convertAction)
        {
            Forward(convertAction);
        }

        private void Forward(ConvertDelegate<T> convertAction)
        {
            Invoke(convertAction);
        }

        private void Invoke(ConvertDelegate<T> convertAction)
        {
            if (convertAction != null)
                convertAction(new Book(), default(T), _ => { });
        }
    }

    public class App
    {
        public void Run()
        {
            ConvertDelegate<Context> convertAction = (_, _, _) => { };
            new Job<Context>().Start(convertAction);
        }
    }
}`)
        // Issue #2835: the delegate keeps its nominal name, so the null-check
        // promotion shows up as `ConvertDelegate[T]?` on every forwarding
        // parameter rather than on an erased arrow form. The BCL `Action<T>`
        // nested inside the delegate's own signature still erases to arrow form.
        Assert.Contains(
            "delegate ConvertDelegate[T](book Book, context T, callback (Conversion) -> void);",
            printed,
            StringComparison.Ordinal
        )
        Assert.Equal(3, printed.Split("convertAction ConvertDelegate[T]?", StringSplitOptions.None).Length - 1)
        Assert.Contains("Start(convertAction)", printed)
        Assert.DoesNotContain("Start(convertAction!!)", printed)
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

        private func TranslateEnabled(source string, roundTripOnlyReason string? = nil) string {
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
            return PrintAndValidate(
                CSharpToGSharpTranslator().TranslateDocument(document, context),
                roundTripOnlyReason
            )
        }

        private func PrintAndValidate(unit CompilationUnit, roundTripOnlyReason string? = nil) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
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
