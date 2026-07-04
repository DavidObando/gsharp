// <copyright file="Issue1901LambdaDefaultsTranslationTests.cs" company="GSharp">
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
/// Issue #1901: two grid-corpus gaps, both about a callee whose parameter
/// list gsc cannot express 1:1 the way C# does.
/// <list type="bullet">
/// <item>
/// A C#12 lambda default parameter (<c>(int x = 10) =&gt; x * 2</c>) IS
/// preserved on the emitted G# lambda parameter (gsc's
/// <c>LambdaBinder.BindAndAttachParameterDefaultValue</c> already supports a
/// default there) — but that default lives only on the lambda's own
/// <c>ParameterSymbol</c>, never on the structural <c>FunctionTypeSymbol</c>
/// that types the variable holding it. Every INDIRECT call through that
/// variable (<c>f()</c>) binds against the structural type
/// (<c>OverloadResolver.TryBindFunctionTypeArguments</c>), which carries only
/// parameter TYPES, so gsc always demands the full arity there — the default
/// is otherwise unreachable. Roslyn already resolves the omitted argument to
/// its constant default regardless of call shape
/// (<c>IArgumentOperation.ArgumentKind.DefaultValue</c>), so the translator
/// materializes it explicitly at the call site instead.
/// </item>
/// <item>
/// A C#13 "params collection" parameter (<c>params List&lt;int&gt;</c>,
/// <c>params IEnumerable&lt;string&gt;</c>) is declared as an ordinary
/// (non-variadic) G# parameter of the full collection type — gsc's own
/// variadic parameter is always an array/slice. An expanded call site
/// (<c>Total(1, 2, 3)</c>, including the zero-argument <c>Total()</c> form)
/// is lowered into an explicit collection construction
/// (<c>List[int32]{1, 2, 3}</c> / <c>List[int32]()</c>) that becomes that
/// single ordinary argument; the direct-collection call form
/// (<c>Total(someList)</c>) already binds a single ordinary argument and
/// needs no lowering.
/// </item>
/// </list>
/// </summary>
public class Issue1901LambdaDefaultsTranslationTests
{
    [Fact]
    public void LambdaDefaultParameter_PreservedOnParameter_AndMaterializedAtOmittedCallSite()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("let f = (x int32 = 10) -> x * 2", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(f(10))", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(f(3))", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void LambdaMultipleDefaultParameters_OnlyOmittedTrailingArgsMaterialized()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("let g = (a int32, b int32 = 5) -> a + b", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(g(1, 5))", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(g(1, 2))", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParamsCollection_ExpandedCall_LowersToCollectionConstruction()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("func Total(values List[int32]) int32", rendered, StringComparison.Ordinal);
        Assert.Contains("let zero = ParamsCollections.Total(List[int32]())", rendered, StringComparison.Ordinal);
        Assert.Contains("let three = ParamsCollections.Total(List[int32]{ 1, 2, 3 })", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParamsCollection_DirectCollectionCall_PassesThroughUnchanged()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("let sum = ParamsCollections.Total(lst)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("List[int32]{ lst }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParamsCollection_EnumerableInterfaceParameter_ExpandedCallLowersToListConstruction()
    {
        string rendered = Render(@"
using System;
using System.Collections.Generic;
namespace Corpus.Issue1901
{
    public class ParamsCollections
    {
        public static string JoinParts(params IEnumerable<string> parts)
        {
            return string.Join(""+"", parts);
        }

        public static void Run()
        {
            var joined = JoinParts(""a"", ""b"", ""c"");
        }
    }
}
");

        Assert.Contains("func JoinParts(parts IEnumerable[string]) string", rendered, StringComparison.Ordinal);
        Assert.Contains(
            "let joined = ParamsCollections.JoinParts(List[string]{ \"a\", \"b\", \"c\" })",
            rendered,
            StringComparison.Ordinal);
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
