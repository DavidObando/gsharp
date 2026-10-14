// <copyright file="Issue1897CollectionExpressionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1897: four distinct C# collection-expression gaps in the G05
/// grid corpus, each fixed independently:
/// - a collection-expression spread element (`[0, ..rest, 9]`) — maps to native G# ellipsis spread
/// syntax (`[]T{0, ...rest, 9}`).
/// - a `List<T>`-targeted collection expression (`List<int> l = [10, 20];`) — previously mistranslated
/// to a G# array literal (`[]int32{10, 20}`) that does not convert to `List[int32]` (gsc GS0155); now
/// lowers to the canonical G# collection-initializer form (`List[int32]{10, 20}`, ADR-0117).
/// - the `["key"] = value` dictionary-initializer form — already had a canonical G# form via the
/// existing indexed `CollectionInitializerElement` path (`TryTranslateCollectionInitializer`); this
/// test just locks in that it stays gap-free and round-trips.
/// - the implicit-typed `stackalloc[] { 5, 6, 7 }` form — was CS2GS-GAP
/// "ImplicitStackAllocArrayCreationExpression has no canonical G# form yet"; now maps to the same G#
/// count-inferred stackalloc initializer (`stackalloc []T{...}`) as the explicit omitted-size form.
open class Issue1897CollectionExpressionTranslationTests {
    @Fact
    func SpreadElement_UsesNativeArrayLiteralSyntax() {
        let rendered = Render(`
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
`)
        Assert.Contains("[]int32{0, ...rest, 9}", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__spread", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".AddRange(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SpreadElement_CoercesMismatchedElementTypeNatively() {
        // Issue #1985 / #3096: gsc's native spread binder applies the ordinary
        // implicit element conversion while adding each source element.
        let rendered = Render(`
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
`)
        Assert.Contains("[]int64{...rest}", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".Select(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SpreadElement_SpanTarget_UsesNativeArrayLiteral() {
        let rendered = Render(`
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
`)
        Assert.Contains("[]int32{0, ...rest, 9}", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SpreadElement_EmptySpread_UsesNativeArrayLiteral() {
        let rendered = Render(`
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
`)
        Assert.Contains("[]int32{...empty}", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SpreadElement_NestedSpreads_StayInLexicalOrder() {
        let rendered = Render(`
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
`)
        Assert.Contains("[]int32{...a, ...b}", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SpreadElement_ListTarget_UsesExplicitCtorCollectionInitializer() {
        let rendered = Render(`
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
`)
        Assert.Contains("List[int32](){ 0, ...rest, 9 }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ConstructibleTarget_NullableAddParameter_DoesNotForgiveNullableElement() {
        // Issue #4525 (M2): the bound element type keeps its nullability, so a
        // legitimately null element added through Add(string?) is not asserted.
        let rendered = Render(`
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
`)
        Assert.DoesNotContain("!!", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ConstructibleTarget_NonNullableAddParameter_ForgivesNullableElement() {
        let rendered = Render(`
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
`)
        Assert.Contains("x!!", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ConstructibleTarget_PrivateBaseAddDoesNotHidePublicNullableAdd() {
        let rendered = Render(`
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
`)
        Assert.DoesNotContain("!!", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ConstructibleTarget_GenericAddWithNullableElementIsReportedUnsupported() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
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
`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("Add overload set", StringComparison.Ordinal)
        )
    }

    @Fact
    func ConstructibleTarget_GenericDerivedAddOverNullableBaseAddIsReportedUnsupported() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
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
`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("Add overload set", StringComparison.Ordinal)
        )
    }

    @Fact
    func ConstructibleTarget_GenericAddWithDefaultElementIsReportedUnsupported() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
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
`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("Add overload set", StringComparison.Ordinal)
        )
    }

    @Fact
    func ConstructibleTarget_ExtensionAddWithNullableElementIsReportedUnsupported() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
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
`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("Add overload set", StringComparison.Ordinal)
        )
    }

    @Fact
    func ListTarget_LowersToCollectionInitializerNotArrayLiteral() {
        let rendered = Render(`
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
`)
        Assert.Contains("List[int32]{ 10, 20 }", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("[]int32{10, 20}", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DictionaryIndexedInitializer_TranslatesGapFreeAndRoundTrips() {
        let rendered = Render(`
using System.Collections.Generic;

namespace Corpus.Issue1897
{
    public class Holder
    {
        public Dictionary<string, int> Make()
        {
            return new Dictionary<string, int> { ["blue"] = 2 };
        }
    }
}
`)
        Assert.Contains("[\"blue\"] = 2", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ImplicitStackAlloc_LowersToCountInferredStackAllocInitializer() {
        let rendered = Render(`
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
`)
        Assert.Contains("stackalloc [3]int32{5, 6, 7}", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SpanTarget_UsesTargetElementType() {
        let rendered = Render(`using System;

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
}`)
        Assert.Contains("[]int64{int64(1)}", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("[]int32{1}", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func EmptyReadOnlySpanTarget_RetainsTargetElementType() {
        let rendered = Render(`using System;

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
}`)
        Assert.Contains("[]int64{}", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("[]object{}", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ConstructibleTarget_UsesBoundAddElementType() {
        let rendered = Render(`using System.Collections;
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
}`)
        Assert.Contains("Bag(){ int64(1) }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func GenericConstructibleTarget_UsesSubstitutedAddElementType() {
        let rendered = Render(`using System.Collections;
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
}`)
        Assert.Contains("Bag[int64]{ int64(1) }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
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
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
