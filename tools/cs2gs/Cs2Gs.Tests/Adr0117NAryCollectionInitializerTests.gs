// <copyright file="Adr0117NAryCollectionInitializerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #3501 / ADR-0117: a G# collection-initializer element holds one or
/// two values, so C#'s N-ary `{ a, b, c }` element (xunit TheoryData
/// rows — sugar for `Add(a, b, c)`) previously gapped. The whole
/// initializer now lowers to a block expression issuing the same explicit
/// `Add` calls the C# compiler synthesizes.
open class Adr0117NAryCollectionInitializerTests {
    @Fact
    func ThreeValueElement_LowersToAddCallsInBlockExpression() {
        let g = Render(TableSource)
        Assert.Contains("let values = Table()", g, StringComparison.Ordinal)
        Assert.Contains("values.Add(1, \"x\", true)", g, StringComparison.Ordinal)
        Assert.Contains("values.Add(2, \"y\", false)", g, StringComparison.Ordinal)
        Assert.DoesNotContain("CS2GS", g, StringComparison.Ordinal)
    }

    @Fact
    func ThreeValueElement_TranslatedGSharp_ParsesBindsAndCompiles() {
        let g = Render(TableSource)
        let result = EmittedOracle.Evaluate([]string{g}, EmittedOracleOptions{IsLibrary: true})
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(0, result.ExitCode)
    }

    @Fact
    func TwoValueElements_KeepTheCanonicalInitializerForm() {
        let g = Render(`
using System.Collections.Generic;

namespace N
{
    public class C
    {
        public static Dictionary<string, int> Build() => new Dictionary<string, int>
        {
            { "a", 1 },
            { "b", 2 },
        };
    }
}`)
        Assert.DoesNotContain("values", g, StringComparison.Ordinal)
        Assert.DoesNotContain(".Add(", g, StringComparison.Ordinal)
    }

    shared {
        private const TableSource string = `
using System.Collections;
using System.Collections.Generic;

namespace N
{
    public class Table : IEnumerable
    {
        private readonly List<string> rows = new List<string>();

        public int Count => this.rows.Count;

        public void Add(int a, string b, bool c) => this.rows.Add($"{a}:{b}:{c}");

        IEnumerator IEnumerable.GetEnumerator() => this.rows.GetEnumerator();
    }

    public class C
    {
        public static Table Build() => new Table
        {
            { 1, "x", true },
            { 2, "y", false },
        };
    }
}`

        private func Render(csharp string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, csharp string){("Source.cs", csharp)})
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
            return GSharpPrinter.Print(unit)
        }
    }
}
