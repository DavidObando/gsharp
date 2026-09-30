// <copyright file="Issue1897CollectionExpressionTranslationTests.cs" company="GSharp">
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
/// Issue #1897: four distinct C# collection-expression gaps in the G05
/// grid corpus, each fixed independently:
/// <list type="bullet">
/// <item>a collection-expression spread element (<c>[0, ..rest, 9]</c>) —
/// maps to native G# ellipsis spread syntax
/// (<c>[]T{0, ...rest, 9}</c>).</item>
/// <item>a <c>List&lt;T&gt;</c>-targeted collection expression
/// (<c>List&lt;int&gt; l = [10, 20];</c>) — previously mistranslated to a
/// G# array literal (<c>[]int32{10, 20}</c>) that does not convert to
/// <c>List[int32]</c> (gsc GS0155); now lowers to the canonical G#
/// collection-initializer form (<c>List[int32]{10, 20}</c>, ADR-0117).</item>
/// <item>the <c>["key"] = value</c> dictionary-initializer form — already
/// had a canonical G# form via the existing indexed
/// <c>CollectionInitializerElement</c> path (<c>TryTranslateCollectionInitializer</c>);
/// this test just locks in that it stays gap-free and round-trips.</item>
/// <item>the implicit-typed <c>stackalloc[] { 5, 6, 7 }</c> form — was
/// CS2GS-GAP "ImplicitStackAllocArrayCreationExpression has no canonical G#
/// form yet"; now maps to the same G# count-inferred stackalloc initializer
/// (<c>stackalloc []T{...}</c>) as the explicit omitted-size form.</item>
/// </list>
/// </summary>
public class Issue1897CollectionExpressionTranslationTests
{
    [Fact]
    public void SpreadElement_UsesNativeArrayLiteralSyntax()
    {
        string rendered = Render(@"
namespace Corpus.Issue1897
{
    public class Holder
    {
        public int[] Combine(int[] rest)
        {
            int[] s = [0, .. rest, 9];
            return s;
        }
    }
}
");

        Assert.Contains("[]int32{0, ...rest, 9}", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__spread", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".AddRange(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SpreadElement_CoercesMismatchedElementTypeNatively()
    {
        // Issue #1985 / #3096: gsc's native spread binder applies the ordinary
        // implicit element conversion while adding each source element.
        string rendered = Render(@"
namespace Corpus.Issue1985
{
    public class Holder
    {
        public long[] Combine(int[] rest)
        {
            long[] s = [.. rest];
            return s;
        }
    }
}
");

        Assert.Contains("[]int64{...rest}", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".Select(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SpreadElement_SpanTarget_UsesNativeArrayLiteral()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1985
{
    public class Holder
    {
        public int Combine(int[] rest)
        {
            Span<int> s = [0, .. rest, 9];
            return s[0];
        }
    }
}
");

        Assert.Contains("[]int32{0, ...rest, 9}", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SpreadElement_EmptySpread_UsesNativeArrayLiteral()
    {
        string rendered = Render(@"
namespace Corpus.Issue1985
{
    public class Holder
    {
        public int[] Combine(int[] empty)
        {
            int[] s = [.. empty];
            return s;
        }
    }
}
");

        Assert.Contains("[]int32{...empty}", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SpreadElement_NestedSpreads_StayInLexicalOrder()
    {
        string rendered = Render(@"
namespace Corpus.Issue1985
{
    public class Holder
    {
        public int[] Combine(int[] a, int[] b)
        {
            int[] s = [.. a, .. b];
            return s;
        }
    }
}
");

        Assert.Contains("[]int32{...a, ...b}", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SpreadElement_ListTarget_UsesExplicitCtorCollectionInitializer()
    {
        string rendered = Render(@"
using System.Collections.Generic;

namespace Corpus.Issue3096
{
    public class Holder
    {
        public List<int> Combine(int[] rest)
        {
            List<int> values = [0, .. rest, 9];
            return values;
        }
    }
}
");

        Assert.Contains("List[int32](){ 0, ...rest, 9 }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ConstructibleTarget_NullableAddParameter_DoesNotForgiveNullableElement()
    {
        // Issue #4525 (M2): the bound element type keeps its nullability, so a
        // legitimately null element added through Add(string?) is not asserted.
        string rendered = Render(@"
#nullable enable
using System.Collections;
using System.Collections.Generic;

namespace Corpus.Issue4525
{
    public class Bag : IEnumerable<string>
    {
        public void Add(string? item) { }
        public IEnumerator<string> GetEnumerator() => throw new System.NotImplementedException();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public class Holder
    {
        public Bag Make(string? x)
        {
            Bag b = [x];
            return b;
        }
    }
}
");

        Assert.DoesNotContain("!!", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ConstructibleTarget_NonNullableAddParameter_ForgivesNullableElement()
    {
        string rendered = Render(@"
#nullable enable
using System.Collections;
using System.Collections.Generic;

namespace Corpus.Issue4525
{
    public class Bag : IEnumerable<string>
    {
        public void Add(string item) { }
        public IEnumerator<string> GetEnumerator() => throw new System.NotImplementedException();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public class Holder
    {
        public Bag Make(string? x)
        {
            Bag b = [x];
            return b;
        }
    }
}
");

        Assert.Contains("x!!", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ConstructibleTarget_PrivateBaseAddDoesNotHidePublicNullableAdd()
    {
        string rendered = Render(@"
#nullable enable
using System.Collections;
using System.Collections.Generic;

namespace Corpus.Issue4525
{
    public class BaseBag : IEnumerable<object>
    {
        private void Add(object item) { }
        public IEnumerator<object> GetEnumerator() => throw new System.NotImplementedException();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public class Bag : BaseBag
    {
        public void Add(object? item) { }
    }

    public class Holder
    {
        public Bag Make(object? x)
        {
            Bag b = [x];
            return b;
        }
    }
}
");

        Assert.DoesNotContain("!!", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ConstructibleTarget_GenericAddWithNullableElementIsReportedUnsupported()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
#nullable enable
using System.Collections;
using System.Collections.Generic;

namespace Corpus.Issue4525
{
    public class Bag : IEnumerable<string>
    {
        public void Add<T>(T item) { }
        public IEnumerator<string> GetEnumerator() => throw new System.NotImplementedException();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public class Holder
    {
        public Bag Make(string? x)
        {
            Bag b = [x];
            return b;
        }
    }
}
") });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("Add overload set", StringComparison.Ordinal));
    }

    [Fact]
    public void ConstructibleTarget_GenericDerivedAddOverNullableBaseAddIsReportedUnsupported()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
#nullable enable
using System.Collections;
using System.Collections.Generic;

namespace Corpus.Issue4525
{
    public class BaseBag : IEnumerable<string>
    {
        public void Add(string? item) { }
        public IEnumerator<string> GetEnumerator() => throw new System.NotImplementedException();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public class Bag : BaseBag
    {
        public void Add<U>(U item) { }
    }

    public class Holder
    {
        public Bag Make(string? x)
        {
            Bag b = [x];
            return b;
        }
    }
}
") });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("Add overload set", StringComparison.Ordinal));
    }

    [Fact]
    public void ConstructibleTarget_GenericAddWithDefaultElementIsReportedUnsupported()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
#nullable enable
using System.Collections;
using System.Collections.Generic;

namespace Corpus.Issue4525
{
    public class Bag : IEnumerable<string>
    {
        public void Add<T>(T item) { }
        public IEnumerator<string> GetEnumerator() => throw new System.NotImplementedException();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public class Holder
    {
        public Bag Make(string? x)
        {
            Bag b = [default(string)];
            return b;
        }
    }
}
") });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("Add overload set", StringComparison.Ordinal));
    }

    [Fact]
    public void ConstructibleTarget_ExtensionAddWithNullableElementIsReportedUnsupported()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
#nullable enable
using System.Collections;
using System.Collections.Generic;

namespace Corpus.Issue4525
{
    public class Bag : IEnumerable<string>
    {
        public IEnumerator<string> GetEnumerator() => throw new System.NotImplementedException();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public static class BagExtensions
    {
        public static void Add(this Bag bag, string? item) { }
    }

    public class Holder
    {
        public Bag Make(string? x)
        {
            Bag b = [x];
            return b;
        }
    }
}
") });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                && diagnostic.Message.Contains("Add overload set", StringComparison.Ordinal));
    }

    [Fact]
    public void ListTarget_LowersToCollectionInitializerNotArrayLiteral()
    {
        string rendered = Render(@"
using System.Collections.Generic;

namespace Corpus.Issue1897
{
    public class Holder
    {
        public List<int> Make()
        {
            List<int> l = [10, 20];
            return l;
        }
    }
}
");

        Assert.Contains("List[int32]{ 10, 20 }", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("[]int32{10, 20}", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DictionaryIndexedInitializer_TranslatesGapFreeAndRoundTrips()
    {
        string rendered = Render(@"
using System.Collections.Generic;

namespace Corpus.Issue1897
{
    public class Holder
    {
        public Dictionary<string, int> Make()
        {
            return new Dictionary<string, int> { [""blue""] = 2 };
        }
    }
}
");

        Assert.Contains("[\"blue\"] = 2", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ImplicitStackAlloc_LowersToCountInferredStackAllocInitializer()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1897
{
    public class Holder
    {
        public int First()
        {
            Span<int> t = stackalloc[] { 5, 6, 7 };
            return t[0];
        }
    }
}
");

        Assert.Contains("stackalloc [3]int32{5, 6, 7}", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SpanTarget_UsesTargetElementType()
    {
        string rendered = Render("""
            using System;

            namespace Corpus.Issue4525
            {
                public class Holder
                {
                    public long Read()
                    {
                        Span<long> values = [1];
                        return values[0];
                    }
                }
            }
            """);

        Assert.Contains("[]int64{int64(1)}", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("[]int32{1}", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void EmptyReadOnlySpanTarget_RetainsTargetElementType()
    {
        string rendered = Render("""
            using System;

            namespace Corpus.Issue4525
            {
                public class Holder
                {
                    public int Count()
                    {
                        ReadOnlySpan<long> values = [];
                        return values.Length;
                    }
                }
            }
            """);

        Assert.Contains("[]int64{}", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("[]object{}", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ConstructibleTarget_UsesBoundAddElementType()
    {
        string rendered = Render("""
            using System.Collections;
            using System.Collections.Generic;

            namespace Corpus.Issue4525
            {
                public sealed class Bag : IEnumerable<int>
                {
                    public void Add(long value)
                    {
                    }

                    public IEnumerator<int> GetEnumerator()
                    {
                        yield return 0;
                    }

                    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
                }

                public class Holder
                {
                    public Bag Make()
                    {
                        Bag values = [1];
                        return values;
                    }
                }
            }
            """);

        Assert.Contains("Bag(){ int64(1) }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void GenericConstructibleTarget_UsesSubstitutedAddElementType()
    {
        string rendered = Render("""
            using System.Collections;
            using System.Collections.Generic;

            namespace Corpus.Issue4525
            {
                public sealed class Bag<T> : IEnumerable<int>
                {
                    public void Add(T value)
                    {
                    }

                    public IEnumerator<int> GetEnumerator()
                    {
                        yield return 0;
                    }

                    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
                }

                public class Holder
                {
                    public Bag<long> Make()
                    {
                        Bag<long> values = [1];
                        return values;
                    }
                }
            }
            """);

        Assert.Contains("Bag[int64]{ int64(1) }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

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
