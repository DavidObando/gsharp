// <copyright file="Issue4859YieldedTemporaryTests.cs" company="GSharp">
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
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #4859: `yield return` values only need a temporary when their
/// printed form starts with `(` and is not a tuple literal (#4705), or
/// when it starts with a nonempty `[` (a sized array, `yield [3]T`
/// parses as indexing), or when it is a branching expression or a lambda, which need the
/// iterator element type as their target (#4719).
/// Everything else prints inline, and a remaining temporary has a readable name, never `__yielded{N}`.
class Issue4859YieldedTemporaryTests {
    @Fact
    func CommonYieldShapes_PrintInlineWithoutATemporary() {
        let printed = Translate(`using System;
using System.Collections.Generic;

public static class Obj
{
    public static string Name(int n) => "n" + n;

    public static IEnumerable<object[]> Rows(int num)
    {
        yield return new object[] { 1, "a", Array.Empty<string>() };
        yield return new object[] { 2, "b", Array.Empty<string>() };
    }

    public static IEnumerable<string> Texts(int num)
    {
        yield return "static";
        yield return Name(num);
        yield return $"GS{num:D4}";
        yield return string.Concat("a", "b");
    }
}`)
        Assert.DoesNotContain("__yielded", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let item", printed, StringComparison.Ordinal)
        Assert.Contains("yield []object{", printed, StringComparison.Ordinal)
        Assert.Contains("yield \"static\"", printed, StringComparison.Ordinal)
        Assert.Contains("yield Name(num)", printed, StringComparison.Ordinal)
    }

    @Fact
    func ParenthesisStartingValue_UsesReadableCollisionCheckedName() {
        let printed = Translate(`using System.Collections.Generic;

public static class Obj
{
    public static IEnumerable<int> Conditional(bool choose, int item, int y, int z)
    {
        yield return (choose ? item : y) + z;
        yield return (choose ? y : item) + z;
    }

    public static int Run()
    {
        int total = 0;
        foreach (int v in Conditional(true, 1, 2, 10))
        {
            total += v;
        }

        return total;
    }
}`)
        Assert.DoesNotContain("__yielded", printed, StringComparison.Ordinal)
        Assert.Contains("let item_2 int32 =", printed, StringComparison.Ordinal)
        Assert.Contains("let item_3 int32 =", printed, StringComparison.Ordinal)
        Assert.Contains("yield item_2", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(11 + 12, result.Value)
    }

    @Fact
    func NameAllocation_IsPerMember_NotPerType() {
        let printed = Translate(`using System.Collections.Generic;

public static class Obj
{
    public static int Unrelated(int item) => item;

    public static IEnumerable<int> Rows(bool choose, int y, int z)
    {
        yield return (choose ? y : z) + 1;
    }
}`)
        Assert.Contains("let item int32 =", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("item_2", printed, StringComparison.Ordinal)
    }

    @Fact
    func SizedArrayYield_IsMaterializedBecauseYieldBracketIsAnIndex() {
        let printed = Translate(`using System.Collections.Generic;

public static class Obj
{
    public static IEnumerable<int[]> Rows()
    {
        yield return new int[3];
    }

    public static int Run()
    {
        int total = 0;
        foreach (int[] row in Rows())
        {
            total += row.Length;
        }

        return total;
    }
}`)
        Assert.DoesNotContain("yield [", printed, StringComparison.Ordinal)
        Assert.Contains("yield item", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func BranchingYield_IsMaterializedSoTheElementTypeIsItsTarget() {
        let printed = Translate(`using System.Collections.Generic;

public static class Obj
{
    public static IEnumerable<object> Rows(bool b, string s, int n)
    {
        yield return b ? s : n;
    }

    public static int Run()
    {
        int total = 0;
        foreach (object row in Rows(false, "x", 4))
        {
            total += (int)row;
        }

        return total;
    }
}`)
        Assert.DoesNotContain("yield if", printed, StringComparison.Ordinal)
        Assert.Matches("let item(_\\d+)? ", printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func GuardCaptureLocal_AndYieldTemporary_DoNotCollide() {
        let printed = Translate(`using System.Collections.Generic;

public class Holder
{
    public string Item { get; }

    public IEnumerable<int> Rows(bool choose, int y, int z)
    {
        if (Item == null)
        {
            throw new System.InvalidOperationException();
        }

        int length = Item.Length;
        yield return (choose ? y : z) + length;
    }
}`)
        Assert.Contains("let item = Item!!", printed, StringComparison.Ordinal)
        Assert.Contains("let item_2 int32 =", printed, StringComparison.Ordinal)
        Assert.Contains("yield item_2", printed, StringComparison.Ordinal)
    }

    @Fact
    func LambdaYield_IsMaterializedSoTheDelegateTypeIsItsTarget() {
        let printed = Translate(`using System;
using System.Collections.Generic;
using System.Threading.Tasks;

public static class Obj
{
    public static IEnumerable<Func<Task<object>>> Rows(bool b, string s, int n)
    {
        yield return async () => b ? s : n;
    }

    public static int Run()
    {
        int total = 0;
        foreach (Func<Task<object>> row in Rows(false, "x", 4))
        {
            total += (int)row().GetAwaiter().GetResult();
        }

        return total;
    }
}`)
        Assert.Matches("let item(_\\d+)? ", printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func InlineArrayYield_BindsAndRuns() {
        let printed = Translate(`using System.Collections.Generic;

public static class Obj
{
    public static IEnumerable<object[]> Rows()
    {
        yield return new object[] { 1, "a" };
        yield return new object[] { 2, "b" };
    }

    public static int Run()
    {
        int total = 0;
        foreach (object[] row in Rows())
        {
            total += (int)row[0];
        }

        return total;
    }
}`)
        Assert.DoesNotContain("__yielded", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(3, result.Value)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)}, nil)
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
