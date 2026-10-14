// <copyright file="Issue1901LambdaDefaultsTranslationTests.cs" company="GSharp">
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

/// Issue #1901: two grid-corpus gaps, both about a callee whose parameter
/// list gsc cannot express 1:1 the way C# does.
/// - A C#12 lambda default parameter (`(int x = 10) => x * 2`) IS preserved on the emitted G# lambda
/// parameter (gsc's `LambdaBinder.BindAndAttachParameterDefaultValue` already supports a default there)
/// — but that default lives only on the lambda's own `ParameterSymbol`, never on the structural
/// `FunctionTypeSymbol` that types the variable holding it. Every INDIRECT call through that variable
/// (`f()`) binds against the structural type (`OverloadResolver.TryBindFunctionTypeArguments`), which
/// carries only parameter TYPES, so gsc always demands the full arity there — the default is otherwise
/// unreachable. Roslyn already resolves the omitted argument to its constant default regardless of call
/// shape (`IArgumentOperation.ArgumentKind.DefaultValue`), so the translator materializes it explicitly
/// at the call site instead.
/// - A C#13 "params collection" parameter (`params List<int>`, `params IEnumerable<string>`) is
/// declared as an ordinary (non-variadic) G# parameter of the full collection type — gsc's own variadic
/// parameter is always an array/slice. An expanded call site (`Total(1, 2, 3)`, including the
/// zero-argument `Total()` form) is lowered into an explicit collection construction
/// (`List[int32]{1, 2, 3}` / `List[int32]()`) that becomes that single ordinary argument; the
/// direct-collection call form (`Total(someList)`) already binds a single ordinary argument and needs
/// no lowering.
open class Issue1901LambdaDefaultsTranslationTests {
    @Fact
    func LambdaDefaultParameter_PreservedOnParameter_AndMaterializedAtOmittedCallSite() {
        let rendered = Render(`
using System;
namespace Corpus.Issue1901
{
    public class LambdaDefaults
    {
        public static void Run()
        {
            var f = (int x = 10) => x * 2;
            Console.WriteLine(f());
            Console.WriteLine(f(3));
        }
    }
}
`)
        Assert.Contains("let f = (x int32 = 10) -> x * 2", rendered, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(f(10))", rendered, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(f(3))", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func LambdaMultipleDefaultParameters_OnlyOmittedTrailingArgsMaterialized() {
        let rendered = Render(`
using System;
namespace Corpus.Issue1901
{
    public class LambdaDefaults
    {
        public static void Run()
        {
            var g = (int a, int b = 5) => a + b;
            Console.WriteLine(g(1));
            Console.WriteLine(g(1, 2));
        }
    }
}
`)
        Assert.Contains("let g = (a int32, b int32 = 5) -> a + b", rendered, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(g(1, 5))", rendered, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(g(1, 2))", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NullableNamedDelegate_DefaultParameter_IsMaterializedAtConditionalCall() {
        let rendered = Render(`
#nullable enable
namespace Corpus.Issue2451
{
    public delegate string TokenProvider(bool enforce = false);

    public class Holder
    {
        public static string? Read(TokenProvider? provider)
        {
            return provider?.Invoke();
        }
    }
}
`)
        Assert.True(rendered.Contains("return provider?(false)", StringComparison.Ordinal), rendered)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func LambdaDefaultParameter_EnumAndNullConstants_MaterializedAtOmittedCallSite() {
        let rendered = Render(`
using System;
namespace Corpus.Issue1901
{
    public enum Color { Red, Green, Blue }

    public class LambdaDefaults
    {
        public static void Run()
        {
            var f = (Color c = Color.Blue, string s = null) => c;
            Console.WriteLine(f());
        }
    }
}
`)
        Assert.Contains("Console.WriteLine(f(Color.Blue, nil))", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParamsCollection_ExpandedCall_LowersToCollectionConstruction() {
        let rendered = Render(`
using System.Collections.Generic;
namespace Corpus.Issue1901
{
    public class ParamsCollections
    {
        public static int Total(params List<int> values)
        {
            int total = 0;
            foreach (int v in values)
            {
                total += v;
            }

            return total;
        }

        public static void Run()
        {
            var zero = Total();
            var three = Total(1, 2, 3);
        }
    }
}
`)
        // ADR-0173 / issue #3627: the params collection keeps its carrier
        // after the ellipsis and expanded calls stay natural — gsc packs.
        Assert.Contains("func Total(values ...List[int32]) int32", rendered, StringComparison.Ordinal)
        Assert.Contains("let zero = Total()", rendered, StringComparison.Ordinal)
        Assert.Contains("let three = Total(1, 2, 3)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParamsCollection_DirectCollectionCall_PassesThroughUnchanged() {
        let rendered = Render(`
using System.Collections.Generic;
namespace Corpus.Issue1901
{
    public class ParamsCollections
    {
        public static int Total(params List<int> values)
        {
            int total = 0;
            foreach (int v in values)
            {
                total += v;
            }

            return total;
        }

        public static void Run()
        {
            var lst = new List<int> { 4, 5 };
            var sum = Total(lst);
        }
    }
}
`)
        Assert.Contains("let sum = Total(lst)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("List[int32]{ lst }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParamsCollection_EnumerableInterfaceParameter_ExpandedCallLowersToListConstruction() {
        let rendered = Render(`
using System;
using System.Collections.Generic;
namespace Corpus.Issue1901
{
    public class ParamsCollections
    {
        public static string JoinParts(params IEnumerable<string> parts)
        {
            return string.Join("+", parts);
        }

        public static void Run()
        {
            var joined = JoinParts("a", "b", "c");
        }
    }
}
`)
        // ADR-0173 / issue #3627: carrier declaration + natural expanded call.
        Assert.Contains("func JoinParts(parts ...IEnumerable[string]) string", rendered, StringComparison.Ordinal)
        Assert.Contains("let joined = JoinParts(\"a\", \"b\", \"c\")", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    /// ADR-0173 / issue #3627: a `params ReadOnlySpan<T>` callee
    /// (C#13's PREFERRED params-collection overload) now translates to the
    /// gsc span carrier `...ReadOnlySpan[T]` with natural expanded
    /// calls — the wall that kept Cs2Gs.Tests translate-red in the #3501
    /// selfmig nightly.
    @Fact
    func ParamsCollection_ReadOnlySpan_TranslatesAsSpanCarrier() {
        let (unit, context) = Translate(`
using System;
namespace Corpus.Issue1901
{
    public class ParamsCollections
    {
        public static int Total(params ReadOnlySpan<int> values)
        {
            int total = 0;
            foreach (int v in values)
            {
                total += v;
            }

            return total;
        }

        public static void Run()
        {
            var three = Total(1, 2, 3);
        }
    }
}
`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("func Total(values ...ReadOnlySpan[int32]) int32", rendered, StringComparison.Ordinal)
        Assert.Contains("let three = Total(1, 2, 3)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ParamsCollection_Span_TranslatesAsSpanCarrier() {
        let (unit, context) = Translate(`
using System;
namespace Corpus.Issue1901
{
    public class ParamsCollections
    {
        public static int Total(params Span<int> values)
        {
            int total = 0;
            foreach (int v in values)
            {
                total += v;
            }

            return total;
        }

        public static void Run()
        {
            var three = Total(1, 2, 3);
        }
    }
}
`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("func Total(values ...Span[int32]) int32", rendered, StringComparison.Ordinal)
        Assert.Contains("let three = Total(1, 2, 3)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    /// Regression test: `Task.WhenAll(params ReadOnlySpan<Task>)` is a BCL
    /// overload from a REFERENCED assembly, never translated as a declaration
    /// (only user-declared callees route through `MapParameter`'s matching
    /// gap). There is nothing for a call-site gap to stay "consistent" with here,
    /// so — unlike the user-declared (cref:ParamsCollection_ReadOnlySpan_ExpandedCall_ReportsUnsupported)
    /// case above — this must fall back to the pre-issue-1901 ordinary argument
    /// translation silently, with no Unsupported diagnostic.
    @Fact
    func ParamsCollection_ExternalBclReadOnlySpanOverload_ExpandedCall_TranslatesWithoutGap() {
        let rendered = Render(`
using System.Threading.Tasks;
namespace Corpus.Issue1901
{
    public class BclParamsCollections
    {
        public static async Task Run()
        {
            await Task.WhenAll(Task.CompletedTask, Task.CompletedTask);
        }
    }
}
`)
        Assert.Contains("Task.WhenAll(Task.CompletedTask, Task.CompletedTask)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    /// Issue #2236: a lambda default of a `decimal` constant used to gap
    /// ("not a simple literal") because `MapConstantValue`'s
    /// constant-mapping switch had no `decimal` arm — even though
    /// `decimal` is exactly as much a compile-time constant as
    /// `double`/`float`, both of which it already handled. Now that
    /// the missing arm is filled in, the default is preserved on the lambda
    /// parameter and materialized at the omitted call site, with NO Unsupported
    /// diagnostic.
    @Fact
    func LambdaDefaultParameter_DecimalConstant_TranslatesWithoutGap() {
        let rendered = Render(`
using System;
namespace Corpus.Issue1901
{
    public class LambdaDefaults
    {
        public static void Run()
        {
            var f = (decimal x = 1.5m) => x;
            Console.WriteLine(f());
        }
    }
}
`)
        Assert.Contains("x decimal = 1.5", rendered, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(f(1.5))", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(
            rendered,
            "G# currently types decimal literal defaults as float64 and cannot bind them to decimal parameters."
        )
    }

    shared {
        private func Translate(source string)(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context)
        }

        private func AssertRoundTripParses(rendered string, roundTripOnlyReason string? = nil) {
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(rendered)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(rendered, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
