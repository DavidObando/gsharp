// <copyright file="Issue914IndexCoercionTranslationTests.cs" company="GSharp">
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

/// Translation tests for the array/indexer element-access index handling.
/// Issue #1279: gsc now accepts ANY C#-supported integer type as an ARRAY/slice
/// element index (it converts the wider/unsigned kinds — `uint`,
/// `long`, `ulong`, `nint`, `nuint` — to native int), so an
/// array index is emitted WITHOUT an `int32(...)` wrapper. A CLR/user
/// indexer whose single parameter is `int32` (`List<T>`,
/// `Span<T>`, `IReadOnlyList<T>`) still binds its argument
/// to `int32` via normal conversion rules in gsc, so a wide index against
/// such an indexer is still coerced via the conversion-call form
/// (`int32(i)`). Originally tracked the #914 (`Oahu.Decrypt`) array
/// coercion defect.
open class Issue914IndexCoercionTranslationTests {
    /// A `uint` array index is emitted uncoerced (gsc accepts it).
    @Fact
    func ArrayIndex_UintIndex_NoCoercion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int Get(int[] arr, uint i) => arr[i];
    }
}`)
        Assert.Contains("arr[i]", printed)
        Assert.DoesNotContain("int32(", printed)
    }

    /// A `long` array index is emitted uncoerced (gsc accepts it).
    @Fact
    func ArrayIndex_LongIndex_NoCoercion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int Get(int[] arr, long i) => arr[i];
    }
}`)
        Assert.Contains("arr[i]", printed)
        Assert.DoesNotContain("int32(", printed)
    }

    /// A computed `uint` array-index expression (`chunk - 1u`) is
    /// emitted uncoerced (gsc accepts the whole wide index).
    @Fact
    func ArrayIndex_UintExpression_NoCoercion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int Get(int[] table, uint chunk) => table[chunk - 1u];
    }
}`)
        Assert.Contains("chunk", printed)
        Assert.DoesNotContain("int32(", printed)
    }

    /// A `nint` array index is emitted uncoerced (gsc accepts it).
    @Fact
    func ArrayIndex_NintIndex_NoCoercion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int Get(int[] arr, nint i) => arr[i];
    }
}`)
        Assert.Contains("arr[i]", printed)
        Assert.DoesNotContain("int32(", printed)
    }

    /// An `int` array index already matches `int32`; no conversion call
    /// is added.
    @Fact
    func ArrayIndex_IntIndex_NoCoercion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int Get(int[] arr, int i) => arr[i];
    }
}`)
        Assert.Contains("arr[i]", printed)
        Assert.DoesNotContain("int32(i)", printed)
    }

    /// A `Dictionary<string, T>` lookup is keyed by the string; the
    /// index must not be wrapped.
    @Fact
    func DictionaryIndex_StringKey_NoCoercion() {
        let printed = TranslateUnit(`
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
        public int Get(Dictionary<string, int> map, string k) => map[k];
    }
}`)
        Assert.DoesNotContain("int32(", printed)
    }

    /// A `Dictionary<uint, T>` lookup is keyed by `uint`; the
    /// index must not be coerced to `int32` (the indexer parameter is
    /// `uint`, not `int32`).
    @Fact
    func DictionaryIndex_UintKey_NoCoercion() {
        let printed = TranslateUnit(`
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
        public int Get(Dictionary<uint, int> map, uint k) => map[k];
    }
}`)
        Assert.DoesNotContain("int32(k)", printed)
    }

    /// A from-end index (`span[^1]`, a `System.Index`) goes through the
    /// dedicated lowering and must not gain a spurious `int32(...)` wrap.
    @Fact
    func SpanFromEndIndex_NoSpuriousCoercion() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        public int Last(Span<int> span) => span[^1];
    }
}`)
        Assert.DoesNotContain("int32(", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
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
