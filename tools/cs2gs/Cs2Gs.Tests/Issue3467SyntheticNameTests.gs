// <copyright file="Issue3467SyntheticNameTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GSharp.Core.CodeAnalysis

// Issue #3467: synthesized control-flow labels and lifted local-function
// names used to embed the syntax node's SpanStart (`__switchExit36386`,
// `__local_ProjectRegions..._20145`), which reads as garbage and shifts on
// any upstream edit; C# `_` lambda parameters became `__underscore`. Names
// are now allocated per function body in first-use order, lifted helpers
// suffix only on genuine collision, and unreferenced `_` parameters keep
// the discard spelling.
class Issue3467SyntheticNameTests {
    @Fact
    func SyntheticNames_DoNotEmbedSourcePositions() {
        let printed = Translate(`using System.Collections.Generic;

public class C
{
    private bool stop;

    public IEnumerable<int> Items()
    {
        if (stop)
        {
            yield break;
        }

        yield return 1;
    }

    public string Label(int value)
    {
        int ordinal = 0;
        return NewLabel("end", ref ordinal) + value;

        static string NewLabel(string prefix, ref int i)
        {
            i++;
            return prefix + i;
        }
    }
}`)
        // Issue #3501 A1: `yield break` now translates to G#'s native
        // `yield break` — no synthesized iterator-exit label at all.
        Assert.Contains("yield break", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__iteratorExit", printed, StringComparison.Ordinal)
        // Issue #3501: a ref-parameter local function no longer lifts to a
        // `__local_` helper — gsc `let`-bound literals declare and call
        // through ref-kind parameters natively.
        Assert.Contains("let NewLabel = func (prefix string, ref i int32) string", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func SyntheticNames_AreStableUnderUpstreamEdits() {
        const body = `using System.Collections.Generic;

public class C
{
    private bool stop;

    public IEnumerable<int> Items()
    {
        if (stop)
        {
            yield break;
        }

        yield return 1;
    }

    public string Label(int value)
    {
        int ordinal = 0;
        return NewLabel("end", ref ordinal) + value;

        static string NewLabel(string prefix, ref int i)
        {
            i++;
            return prefix + i;
        }
    }
}`
        const header = "// A long leading comment that shifts every span downstream."
        let original = Translate(body)
        let shifted = Translate(header + Environment.NewLine + Environment.NewLine + body)
        // Issue #4653: the leading comment is kept as the file header;
        // everything after it is unchanged.
        Assert.Equal(header + `

` + original, shifted)
    }

    @Fact
    func GotoCaseLabels_UseOrdinalsPerMethod() {
        let printed = Translate(`public class C
{
    public static int Route(int value)
    {
        switch (value)
        {
            case 1:
                return 10;
            case 2:
                goto case 1;
            default:
                goto case 2;
        }
    }
}`)
        Assert.Contains("__gotoCase", printed, StringComparison.Ordinal)
        Assert.DoesNotMatch(Regex("__gotoCase\\d{3,}"), printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ReadableLiftFallback_SuffixOnlyOnCollision() {
        // Issue #4302: gsc still deliberately rejects a mixed generic /
        // non-generic direct-local group. The compatibility fallback uses
        // the source local name and adds a suffix only on collision.
        let printed = Translate(`public class Base
{
    protected static int Helper(int value) => -value;
}

public class C : Base
{
    public int Run(int value)
    {
        return Helper(value);

        static int Helper(int n)
        {
            return n == 0 ? 0 : Other<int>(n - 1);
        }

        static int Other<T>(int n)
        {
            return Helper(n);
        }
    }

    public int Run(string value)
    {
        return Helper(value.Length);

        static int Helper(int n)
        {
            return n == 0 ? 0 : Other<int>(n - 1);
        }

        static int Other<T>(int n)
        {
            return Helper(n);
        }
    }
}`)
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal)
        Assert.Contains("func Helper_2(", printed, StringComparison.Ordinal)
        Assert.Contains("func Helper_3(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Helper_4(", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ReadableLiftFallback_IsUniqueAcrossPartialTypeDocuments() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("C.First.cs", `public partial class C
{
    public int First(int value)
    {
        return Helper(value);
        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
    }
}`), ("C.Second.cs", `public partial class C
{
    public int Second(int value)
    {
        return Helper(value);
        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let printed = List[string]()
        let translator = CSharpToGSharpTranslator()
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            printed.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)))
        }
        let combined = string.Join(Environment.NewLine, printed)
        Assert.Contains("func Helper(", combined, StringComparison.Ordinal)
        Assert.Contains("func Helper_2(", combined, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed.ToArray())
    }

    @Fact
    func ReadableLiftFallback_AvoidsStaticImportsFromOtherDocuments() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("C.Import.cs", `using static System.Math;

public partial class C
{
    public int Existing() => Max(3, 4);
}`), ("C.Helper.cs", `public partial class C
{
    public int Run(int value)
    {
        return Max(value, value);
        static int Max(int left, int right) =>
            left == 0 ? right : Other<int>(left - 1, right);
        static int Other<T>(int left, int right) => Max(left, right);
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let printed = List[string]()
        let translator = CSharpToGSharpTranslator()
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            printed.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)))
        }
        let combined = string.Join(Environment.NewLine, printed)
        Assert.Contains("func Max_2(", combined, StringComparison.Ordinal)
        Assert.Contains("Max(3, 4)", combined, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed.ToArray())
    }

    @Fact
    func ReadableLiftFallback_AndSuffixedBackingFieldSharePartialTypeRegistry() {
        let sources = [](string, string){("C.Property.cs", `public partial class C
{
    private int _foo;

    public C(int value)
    {
        Foo = value;
    }

    public virtual int Foo { get; }
}`), ("C.Helper.cs", `public partial class C
{
    public int Run(int value)
    {
        return _foo2(value);
        static int _foo2(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => _foo2(n);
    }
}`)}
        for reverse in[]bool{false, true} {
            let project = CSharpProjectLoader.LoadInMemory(
                if reverse {
                    sources.Reverse().ToArray()
                } else {
                    sources
                }
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let printed = List[string]()
            let translator = CSharpToGSharpTranslator()
            for document in project.Documents {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                printed.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)))
            }
            TranslationTestValidation.AssertBinds(printed.ToArray())
        }
    }

    @Fact
    func ReadableLiftFallback_OwnedExtensionAllocatesAgainstNativeHolder() {
        // Issue #4790: the real body and its lifted helpers stay on the
        // native holder; C's canonical member only forwards to that body.
        let printed = Translate(`public class C
{
    public int Helper(int n) => n + 100;
}

public static class CExtensions
{
    public static int Extra(this C c, int n)
    {
        return Helper(n);
        static int Helper(int n) => n == 0 ? 7 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
    }
}`)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "C().Extra(2) + C().Helper(1)")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(108, result.Value)
        let receiver = Assert.Single(result.Assembly!!.GetTypes(), (type Type) -> type.Name == "C")
        let receiverHelper = Assert.Single(
            receiver.GetMethods(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
            ),
            (method MethodInfo) -> method.Name == "Helper"
        )
        Assert.False(receiverHelper.IsStatic)
        Assert.DoesNotContain(
            receiver.GetMethods(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
            ),
            (method MethodInfo) -> method.Name.StartsWith("Helper_", StringComparison.Ordinal)
        )
        let holder = Assert.Single(result.Assembly!!.GetTypes(), (type Type) -> type.Name == "CExtensions")
        Assert.Equal(receiver.Namespace, holder.Namespace)
        Assert.True(holder.IsAbstract && holder.IsSealed)
        let holderHelper = Assert.Single(
            holder.GetMethods(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly
            ),
            (method MethodInfo) -> method.Name == "Helper"
        )
        Assert.True(holderHelper.IsPrivate)
        let original MethodInfo? = holder.GetMethod("Extra", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(original)
        Assert.Equal(receiver, original!!.GetParameters()[0].ParameterType)
    }

    @Fact
    func ReadableLiftFallback_DoesNotCaptureReceiverExtensionCalls() {
        // Issue #4302: an interface-receiver extension is not folded into
        // C, so it is absent from C's members. A lifted instance helper
        // spelled `Helper` would silently capture `this.Helper(1)`.
        let printed = Translate(`public interface IThing
{
}

public static class ThingExtensions
{
    public static int Helper(this IThing thing, int n) => 1000 + n;
}

public class C : IThing
{
    public int Run(int value)
    {
        int viaExtension = this.Helper(1);
        return viaExtension + Helper(value);
        int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
        int Other<T>(int n) => Helper(n);
    }
}`)
        Assert.Contains("func Helper_2(", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run(2))", "1001")
    }

    @Fact
    func ReadableLiftFallback_TypeQualifiedExtensionCallStillReservesName() {
        // Issue #4302: a type-qualified extension call is rewritten to
        // receiver syntax, where an emitted helper could capture it.
        let printed = Translate(`public interface IThing
{
}

public static class ThingExtensions
{
    public static int Helper(this IThing value, int n) => 1000 + n;
}

public class C : IThing
{
    public int Run(int value)
    {
        int viaExtension = ThingExtensions.Helper(this, 1);
        return viaExtension + Helper(value);
        static int Helper(int n) => n == 0 ? 7 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
    }
}`)
        Assert.Contains("func Helper_2(", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run(2))", "1008")
    }

    @Fact
    func ReadableLiftFallback_GenericMethodGroupValueUsesLiftedName() {
        // Issue #4302: a generic method-group VALUE (`First<int>` passed as
        // a delegate) must resolve to its own lifted helper. Two same-named
        // groups in one type lift as `First` and `First_2`; the second
        // group's method group must not silently bind the first helper.
        let printed = Translate(`using System;

public class C
{
    public int A(int value)
    {
        return First<int>(value);
        static int First<T>(int n) => n == 0 ? 1 : Second(n - 1);
        static int Second(int n) => First<int>(n);
    }

    public int B(int value)
    {
        Func<int, int> f = First<int>;
        return f(value);
        static int First<T>(int n) => n == 0 ? 2 : Second(n - 1);
        static int Second(int n) => First<int>(n);
    }
}`)
        Assert.Contains("func First_2[", printed, StringComparison.Ordinal)
        Assert.Contains("First_2[int32](", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().A(2) * 10 + C().B(2))", "12")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ReadableLiftFallback_AndPartialDocumentAliasNeverShareAName(helperDocumentFirst bool) {
        // Issue #4302: a file-scope alias synthesized in one partial
        // document and a helper lifted in another land in the same type,
        // and gsc binds an invocation to the member before the alias.
        // Whichever document is translated first, the other must avoid it.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("C.Builder.cs", `namespace Demo;

public class StringBuilder
{
}

public partial class C
{
    public string Make() => new System.Text.StringBuilder().Append("x").ToString();
}`), ("C.Lift.cs", `namespace Demo;

public partial class C
{
    public int Run(int value)
    {
        return TextStringBuilder(value);
        static int TextStringBuilder(int n) =>
            n == 0 ? 7 : Other<int>(n - 1);
        static int Other<T>(int n) => TextStringBuilder(n);
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let documents = if helperDocumentFirst {
            project.Documents.Reverse()
        } else {
            cast[IEnumerable[LoadedDocument]](project.Documents)
        }
        let printed = List[string]()
        let translator = CSharpToGSharpTranslator()
        for document in documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            printed.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)))
        }
        let combined = string.Join(Environment.NewLine, printed)
        let helper = if helperDocumentFirst {
            "TextStringBuilder"
        } else {
            "TextStringBuilder_2"
        }
        let alias = if helperDocumentFirst {
            "TextStringBuilder_2"
        } else {
            "TextStringBuilder"
        }
        Assert.Contains("func $helper(", combined, StringComparison.Ordinal)
        Assert.Contains("import $alias = System.Text.StringBuilder", combined, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed.ToArray())
    }

    @Fact
    func ReadableLiftFallback_LocalNamedLikeOwnerCannotCaptureHelperValue() {
        // Issue #4302: `C.First` would bind through the local `C` to
        // `D.First`; the same-aggregate helper reference stays bare.
        let printed = Translate(`using System;

public class D
{
    public int First(int n) => 100;
}

public class C
{
    public int Run()
    {
        D C = new D();
        Func<int, int> f = First;
        return f(1) + C!.First(0);
        static int First(int n) => n == 0 ? 7 : Second<int>(n - 1);
        static int Second<T>(int n) => First(n);
    }
}`)
        Assert.Contains("func First_2(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("= C.First", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run())", "107")
    }

    @Fact
    func ReadableLiftFallback_LocalNamedLikeOwnerAliasCannotCaptureHelperValue() {
        // Issue #4302: `Alias.First` binds through the local `Alias` to
        // `D.First` in C#, but gsc resolves the owner alias first, so the
        // helper must not keep the name `First`.
        let printed = Translate(`using System;
using Alias = C;

public class D
{
    public int First(int n) => 100;
}

public class C
{
    public int Run()
    {
        D Alias = new D();
        Func<int, int> f = First;
        return f(1) + Alias.First(0);
        static int First(int n) => n == 0 ? 7 : Second<int>(n - 1);
        static int Second<T>(int n) => First(n);
    }
}`)
        Assert.Contains("func First_2(", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run())", "107")
    }

    @Fact
    func ReadableLiftFallback_ReferencedUnderscoreParameterReservesEmittedName() {
        let printed = Translate(`using System;

public class C
{
    public int Run(Func<int, int> _)
    {
        return _(0) + __underscore(0);
        static int __underscore(int n) =>
            n == 0 ? 7 : Other<int>(n - 1);
        static int Other<T>(int n) => __underscore(n);
    }
}`)
        Assert.Contains("func __underscore_2(", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C().Run((value int32) -> 100))",
            "107"
        )
    }

    @Fact
    func ReadableLiftFallback_PatternDesignatorCannotShadowStaticHelper() {
        // Issue #4302: `case Callback { }` synthesizes a readable designator
        // from the type name. It must not take the bare static helper's
        // name, or `callback(0)` would invoke the matched delegate.
        let printed = Translate(`public delegate int Callback(int value);

public class C
{
    public int Run(Callback value)
    {
        switch (value)
        {
            case Callback { }:
                return callback(0);
            default:
                return -1;
        }

        static int callback(int n) => n == 0 ? 2 : Other<int>(n - 1);
        static int Other<T>(int n) => callback(n);
    }
}`)
        Assert.Contains("return callback(0)", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run((value int32) -> 1))", "2")
    }

    @Fact
    func ReadableLiftFallback_PatternDesignatorReservesAgainstLaterNestedHelper() {
        // Issue #4302: the group inside the case body is lifted after the
        // pattern is translated. With `C.callback` occupied, the helper
        // takes `callback_2`, which must not also be the designator
        // synthesized from `Callback_2`.
        let printed = Translate(`public delegate int Callback_2(int value);

public class C
{
    private static int callback() => -1;

    public int Run(Callback_2 value)
    {
        switch (value)
        {
            case Callback_2 { }:
            {
                return callback(0);
                static int callback(int n) => n == 0 ? 2 : Other<int>(n - 1);
                static int Other<T>(int n) => callback(n);
            }
            default:
                return -1;
        }
    }
}`)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run((value int32) -> 1))", "2")
    }

    @Fact
    func MutablePatternCapture_ReservesAgainstLiftedHelper() {
        let printed = Translate(`using System;

public class C
{
    public int Run(Func<int, int> value)
    {
        switch (value)
        {
            case var callback:
                callback = n => 100 + n;
                return callback(0) + __pattern0(0);
                static int __pattern0(int n) =>
                    n == 0 ? 7 : Other<int>(n - 1);
                static int Other<T>(int n) => __pattern0(n);
        }
    }
}`)
        Assert.Contains("__pattern1", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C().Run((value int32) -> value))",
            "107"
        )
    }

    @Fact
    func SpillLocal_ReservesAgainstLiftedHelper() {
        let printed = Translate(`public class C
{
    public int Run()
    {
        int total = 0;
        int x = 5;

        int MutateX()
        {
            x = 99;
            return 1;
        }

        void Add(int a = 1, int b = 2, int c = 3)
        {
            total = (a * 100) + (b * 10) + c;
            if (a > 100)
            {
                AddPatternSwitch(a - 1);
            }
        }

        void AddPatternSwitch(int depth)
        {
            if (depth > 0)
            {
                Add(depth - 1);
            }
        }

        Add(c: x, a: MutateX());
        int __spill1 = 8;
        return total + __spill0(0) + __spill1;
        static int __spill0(int n) =>
            n == 0 ? 7 : Other<int>(n - 1);
        static int Other<T>(int n) => __spill0(n);
    }
}`)
        Assert.Contains("let __spill2 = x", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run())", "140")
    }

    @Fact
    func DeconstructionCarrier_ReservesAgainstNestedLiftedHelper() {
        let printed = Translate(`using System;

public class C
{
    public int Run()
    {
        Func<int, int> x = null!;
        int a = 0;
        int b = 0;
        (x, (a, b)) = (n => 100 + n, (1, 2));
        return Container();

        int Container()
        {
            return xValue(0);
            static int xValue(int n) =>
                n == 0 ? 7 : Other<int>(n - 1);
            static int Other<T>(int n) => xValue(n);
        }
    }
}`)
        Assert.Contains("xValue2", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run())", "7")
    }

    @Fact
    func LoopScrutinee_AvoidsLiftedHelperSourceName() {
        let printed = Translate(`using System;

public class C
{
    private static Func<int, int> Make(out int ignored)
    {
        ignored = 0;
        return value => 100 + value;
    }

    public int Run()
    {
        while (Make(out var ignored) is not null)
        {
            return __scrutinee0(0);
            static int __scrutinee0(int n) =>
                n == 0 ? 7 : Other<int>(n - 1);
            static int Other<T>(int n) => __scrutinee0(n);
        }

        return -1;
    }
}`)
        Assert.Contains("let __scrutinee1 =", printed, StringComparison.Ordinal)
        Assert.Contains("func __scrutinee0(", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run())", "7")
    }

    @Fact
    func ReadableLiftFallback_ReservesNameAgainstLaterTypeAlias() {
        let printed = Translate(`namespace Demo;

public class StringBuilder
{
}

public class C
{
    private static int TextStringBuilder(int value) => -value;

    public int Run(int value)
    {
        return TextStringBuilder(value);
        static int TextStringBuilder(int n) =>
            n == 0 ? 7 : Other<int>(n - 1);
        static int Other<T>(int n) => TextStringBuilder(n);
    }

    public string Later()
    {
        var builder = new System.Text.StringBuilder();
        return builder.ToString();
    }
}`)
        Assert.Contains("func TextStringBuilder_2(", printed, StringComparison.Ordinal)
        Assert.Contains("import TextStringBuilder_3 = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "Console.WriteLine(C().Run(2))", "7")
    }

    @Fact
    func ReadableAlias_CompilationAllocatorKeepsAliasesUnique() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("C.cs", "public class C { }")})
        let allocator = LiftedLocalFunctionNameAllocator.For(project.Compilation)
        Assert.Equal("TextStringBuilder", allocator.ClaimAlias("TextStringBuilder", (_ string) -> false))
        Assert.Equal("TextStringBuilder_2", allocator.ClaimAlias("TextStringBuilder", (_ string) -> false))
    }

    @Fact
    func ReadableLiftFallback_ReusesNameAcrossUnrelatedTypes() {
        let printed = Translate(`public class First
{
    public int Run(int value)
    {
        return Helper(value);
        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
    }
}

public class Second
{
    public int Run(int value)
    {
        return Helper(value);
        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
    }
}`)
        Assert.Equal(2, Regex.Matches(printed, "func Helper\\(").Count)
        Assert.DoesNotContain("func Helper_2(", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ReadableLiftFallback_AvoidsContainingTypeName() {
        let printed = Translate(`public class C
{
    public int Run(int value)
    {
        return C(value);
        static int C(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => C(n);
    }
}`)
        Assert.Contains("func C_2(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ReadableLiftFallback_AvoidsImportedAlias() {
        let printed = Translate(`using Helper = System.Math;

public class C
{
    public int Run(int value)
    {
        return Helper(value);
        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
    }
}`)
        Assert.Contains("func Helper_2(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ReadableLiftFallback_AvoidsEnclosingLocalNames() {
        let printed = Translate(`public class C
{
    private int Helper(int value) => -value;

    public int Run(int value)
    {
        int Helper_2 = 1;
        return Helper(value) + Helper_2;
        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
    }
}`)
        Assert.Contains("func Helper_3(", printed, StringComparison.Ordinal)
        Assert.Contains("return Helper_3(value) + Helper_2", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ReadableLiftFallback_AvoidsOuterMethodLocalNames() {
        let printed = Translate(`public class C
{
    private int Helper(int value) => -value;

    public int Run(int value)
    {
        int Helper_2 = 1;
        return Container(value) + Helper_2;

        int Container(int input)
        {
            return Helper(input);
            static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
            static int Other<T>(int n) => Helper(n);
        }
    }
}`)
        Assert.Contains("func Helper_3(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Helper_2(", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ReadableLiftFallback_AvoidsSiblingLocalFunctionNames() {
        let printed = Translate(`public class C
{
    private int Helper(int value) => -value;

    public int Run(int value)
    {
        return Helper(value) + Helper_2(value);
        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
        static int Helper_2(int n) => n;
    }
}`)
        Assert.Contains("func Helper_3(", printed, StringComparison.Ordinal)
        Assert.Contains("return Helper_3(value) + Helper_2(value)", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ReadableLiftFallback_AvoidsPrimaryConstructorFieldNames() {
        let printed = Translate(`public class C(int Helper_2)
{
    private int Helper(int value) => -value;

    public int Run(int value)
    {
        return Helper(value) + Helper_2;
        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
    }
}`)
        Assert.Contains("func Helper_3(", printed, StringComparison.Ordinal)
        Assert.Contains("return Helper_3(value) + Helper_2", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ReadableLiftFallback_AvoidsSynthesizedPropertyBackingField() {
        let printed = Translate(`public class C
{
    public C(int value)
    {
        Foo = value;
    }

    public virtual int Foo { get; }

    public int Run(int value)
    {
        return _foo(value);
        static int _foo(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => _foo(n);
    }
}`)
        Assert.Contains("func _foo_2(", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func UnreferencedUnderscoreLambdaParameter_KeepsDiscardSpelling() {
        let printed = Translate(`using System;

public class C
{
    public static int Apply(Func<string, int> f) => f("x");

    public static int Run() => Apply(_ => 7);
}`)
        Assert.Contains("(_ string)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__underscore", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ReferencedUnderscoreLambdaParameter_StillRenames() {
        let printed = Translate(`using System;

public class C
{
    public static int Apply(Func<int, int> f) => f(3);

    public static int Run() => Apply(_ => _ + 1);
}`)
        Assert.Contains("__underscore", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    shared {
        private func Translate(source string, additionalReferences ...MetadataReference) string {
            let references IReadOnlyList[MetadataReference]? = if additionalReferences.Length == 0 {
                default(List[MetadataReference]?)
            } else {
                CSharpProjectLoader
                    .RuntimeReferences()
                    .Concat(additionalReferences)
                    .GroupBy((reference MetadataReference) -> reference.Display!!, StringComparer.Ordinal)
                    .Select((group IGrouping[string, MetadataReference]) -> group.First())
                    .ToList()
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                references
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
