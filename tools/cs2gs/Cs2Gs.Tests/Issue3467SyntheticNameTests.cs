// <copyright file="Issue3467SyntheticNameTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests
{
    // Issue #3467: synthesized control-flow labels and lifted local-function
    // names used to embed the syntax node's SpanStart (`__switchExit36386`,
    // `__local_ProjectRegions..._20145`), which reads as garbage and shifts on
    // any upstream edit; C# `_` lambda parameters became `__underscore`. Names
    // are now allocated per function body in first-use order, lifted helpers
    // suffix only on genuine collision, and unreferenced `_` parameters keep
    // the discard spelling.
    public sealed class Issue3467SyntheticNameTests
    {
        [Fact]
        public void SyntheticNames_DoNotEmbedSourcePositions()
        {
            string printed = Translate("""
                using System.Collections.Generic;

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
                }
                """);

            // Issue #3501 A1: `yield break` now translates to G#'s native
            // `yield break` — no synthesized iterator-exit label at all.
            Assert.Contains("yield break", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__iteratorExit", printed, StringComparison.Ordinal);

            // Issue #3501: a ref-parameter local function no longer lifts to a
            // `__local_` helper — gsc `let`-bound literals declare and call
            // through ref-kind parameters natively.
            Assert.Contains("let NewLabel = func (prefix string, ref i int32) string", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void SyntheticNames_AreStableUnderUpstreamEdits()
        {
            const string body = """
                using System.Collections.Generic;

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
                }
                """;

            string original = Translate(body);
            string shifted = Translate(
                "// A long leading comment that shifts every span downstream." +
                Environment.NewLine + Environment.NewLine + body);

            Assert.Equal(original, shifted);
        }

        [Fact]
        public void GotoCaseLabels_UseOrdinalsPerMethod()
        {
            string printed = Translate("""
                public class C
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
                }
                """);

            Assert.Contains("__gotoCase", printed, StringComparison.Ordinal);
            Assert.DoesNotMatch(new Regex(@"__gotoCase\d{3,}"), printed);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReadableLiftFallback_SuffixOnlyOnCollision()
        {
            // Issue #4302: gsc still deliberately rejects a mixed generic /
            // non-generic direct-local group. The compatibility fallback uses
            // the source local name and adds a suffix only on collision.
            string printed = Translate("""
                public class Base
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
                }
                """);

            Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
            Assert.Contains("func Helper_2(", printed, StringComparison.Ordinal);
            Assert.Contains("func Helper_3(", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("func Helper_4(", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReadableLiftFallback_IsUniqueAcrossPartialTypeDocuments()
        {
            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                new[]
                {
                    ("C.First.cs", """
                        public partial class C
                        {
                            public int First(int value)
                            {
                                return Helper(value);
                                static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
                                static int Other<T>(int n) => Helper(n);
                            }
                        }
                        """),
                    ("C.Second.cs", """
                        public partial class C
                        {
                            public int Second(int value)
                            {
                                return Helper(value);
                                static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
                                static int Other<T>(int n) => Helper(n);
                            }
                        }
                        """),
                });
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

            var printed = new List<string>();
            var translator = new CSharpToGSharpTranslator();
            foreach (LoadedDocument document in project.Documents)
            {
                var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
                printed.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)));
            }

            string combined = string.Join(Environment.NewLine, printed);
            Assert.Contains("func Helper(", combined, StringComparison.Ordinal);
            Assert.Contains("func Helper_2(", combined, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed.ToArray());
        }

        [Fact]
        public void ReadableLiftFallback_AvoidsStaticImportsFromOtherDocuments()
        {
            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                new[]
                {
                    ("C.Import.cs", """
                        using static System.Math;

                        public partial class C
                        {
                            public int Existing() => Max(3, 4);
                        }
                        """),
                    ("C.Helper.cs", """
                        public partial class C
                        {
                            public int Run(int value)
                            {
                                return Max(value, value);
                                static int Max(int left, int right) =>
                                    left == 0 ? right : Other<int>(left - 1, right);
                                static int Other<T>(int left, int right) => Max(left, right);
                            }
                        }
                        """),
                });
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

            var printed = new List<string>();
            var translator = new CSharpToGSharpTranslator();
            foreach (LoadedDocument document in project.Documents)
            {
                var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
                printed.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)));
            }

            string combined = string.Join(Environment.NewLine, printed);
            Assert.Contains("func Max_2(", combined, StringComparison.Ordinal);
            Assert.Contains("Max(3, 4)", combined, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed.ToArray());
        }

        [Fact]
        public void ReadableLiftFallback_AndSuffixedBackingFieldSharePartialTypeRegistry()
        {
            var sources = new[]
            {
                ("C.Property.cs", """
                    public partial class C
                    {
                        private int _foo;

                        public C(int value)
                        {
                            Foo = value;
                        }

                        public virtual int Foo { get; }
                    }
                    """),
                ("C.Helper.cs", """
                    public partial class C
                    {
                        public int Run(int value)
                        {
                            return _foo2(value);
                            static int _foo2(int n) => n == 0 ? 0 : Other<int>(n - 1);
                            static int Other<T>(int n) => _foo2(n);
                        }
                    }
                    """),
            };

            foreach (bool reverse in new[] { false, true })
            {
                LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                    reverse ? sources.Reverse().ToArray() : sources);
                Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

                var printed = new List<string>();
                var translator = new CSharpToGSharpTranslator();
                foreach (LoadedDocument document in project.Documents)
                {
                    var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
                    printed.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)));
                }

                TranslationTestValidation.AssertBinds(printed.ToArray());
            }
        }

        [Fact]
        public void ReadableLiftFallback_OwnedExtensionAllocatesAgainstReceiverAggregate()
        {
            // Issue #4302: an owned extension's local functions belong to the
            // extension container in Roslyn, but the lifted helper is emitted
            // into the receiver type, so the name must avoid C.Helper.
            string printed = Translate("""
                public class C
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
                }
                """);

            Assert.Contains("func Helper_2(", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Extra(2) + C().Helper(1))",
                "108");
        }

        [Fact]
        public void ReadableLiftFallback_DoesNotCaptureReceiverExtensionCalls()
        {
            // Issue #4302: an interface-receiver extension is not folded into
            // C, so it is absent from C's members. A lifted instance helper
            // spelled `Helper` would silently capture `this.Helper(1)`.
            string printed = Translate("""
                public interface IThing
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
                }
                """);

            Assert.Contains("func Helper_2(", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run(2))",
                "1001");
        }

        [Fact]
        public void ReadableLiftFallback_TypeQualifiedExtensionCallStillReservesName()
        {
            // Issue #4302: a type-qualified extension call is rewritten to
            // receiver syntax, where an emitted helper could capture it.
            string printed = Translate("""
                public interface IThing
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
                }
                """);

            Assert.Contains("func Helper_2(", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run(2))",
                "1008");
        }

        [Fact]
        public void ReadableLiftFallback_GenericMethodGroupValueUsesLiftedName()
        {
            // Issue #4302: a generic method-group VALUE (`First<int>` passed as
            // a delegate) must resolve to its own lifted helper. Two same-named
            // groups in one type lift as `First` and `First_2`; the second
            // group's method group must not silently bind the first helper.
            string printed = Translate("""
                using System;

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
                }
                """);

            Assert.Contains("func First_2[", printed, StringComparison.Ordinal);
            Assert.Contains("First_2[int32](", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().A(2) * 10 + C().B(2))",
                "12");
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void ReadableLiftFallback_AndPartialDocumentAliasNeverShareAName(bool helperDocumentFirst)
        {
            // Issue #4302: a file-scope alias synthesized in one partial
            // document and a helper lifted in another land in the same type,
            // and gsc binds an invocation to the member before the alias.
            // Whichever document is translated first, the other must avoid it.
            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                new[]
                {
                    ("C.Builder.cs", """
                        namespace Demo;

                        public class StringBuilder
                        {
                        }

                        public partial class C
                        {
                            public string Make() => new System.Text.StringBuilder().Append("x").ToString();
                        }
                        """),
                    ("C.Lift.cs", """
                        namespace Demo;

                        public partial class C
                        {
                            public int Run(int value)
                            {
                                return TextStringBuilder(value);
                                static int TextStringBuilder(int n) =>
                                    n == 0 ? 7 : Other<int>(n - 1);
                                static int Other<T>(int n) => TextStringBuilder(n);
                            }
                        }
                        """),
                });
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

            IEnumerable<LoadedDocument> documents = helperDocumentFirst
                ? project.Documents.Reverse()
                : project.Documents;
            var printed = new List<string>();
            var translator = new CSharpToGSharpTranslator();
            foreach (LoadedDocument document in documents)
            {
                var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
                printed.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)));
            }

            string combined = string.Join(Environment.NewLine, printed);
            string helper = helperDocumentFirst ? "TextStringBuilder" : "TextStringBuilder_2";
            string alias = helperDocumentFirst ? "TextStringBuilder_2" : "TextStringBuilder";
            Assert.Contains($"func {helper}(", combined, StringComparison.Ordinal);
            Assert.Contains($"import {alias} = System.Text.StringBuilder", combined, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed.ToArray());
        }

        [Fact]
        public void ReadableLiftFallback_LocalNamedLikeOwnerCannotCaptureHelperValue()
        {
            // Issue #4302: `C.First` would bind through the local `C` to
            // `D.First`; the same-aggregate helper reference stays bare.
            string printed = Translate("""
                using System;

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
                }
                """);

            Assert.Contains("func First_2(", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("= C.First", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run())",
                "107");
        }

        [Fact]
        public void ReadableLiftFallback_LocalNamedLikeOwnerAliasCannotCaptureHelperValue()
        {
            // Issue #4302: `Alias.First` binds through the local `Alias` to
            // `D.First` in C#, but gsc resolves the owner alias first, so the
            // helper must not keep the name `First`.
            string printed = Translate("""
                using System;
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
                }
                """);

            Assert.Contains("func First_2(", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run())",
                "107");
        }

        [Fact]
        public void ReadableLiftFallback_ReferencedUnderscoreParameterReservesEmittedName()
        {
            string printed = Translate("""
                using System;

                public class C
                {
                    public int Run(Func<int, int> _)
                    {
                        return _(0) + __underscore(0);
                        static int __underscore(int n) =>
                            n == 0 ? 7 : Other<int>(n - 1);
                        static int Other<T>(int n) => __underscore(n);
                    }
                }
                """);

            Assert.Contains("func __underscore_2(", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run((value int32) -> 100))",
                "107");
        }

        [Fact]
        public void ReadableLiftFallback_PatternDesignatorCannotShadowStaticHelper()
        {
            // Issue #4302: `case Callback { }` synthesizes a readable designator
            // from the type name. It must not take the bare static helper's
            // name, or `callback(0)` would invoke the matched delegate.
            string printed = Translate("""
                public delegate int Callback(int value);

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
                }
                """);

            Assert.Contains("return callback(0)", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run((value int32) -> 1))",
                "2");
        }

        [Fact]
        public void ReadableLiftFallback_PatternDesignatorReservesAgainstLaterNestedHelper()
        {
            // Issue #4302: the group inside the case body is lifted after the
            // pattern is translated. With `C.callback` occupied, the helper
            // takes `callback_2`, which must not also be the designator
            // synthesized from `Callback_2`.
            string printed = Translate("""
                public delegate int Callback_2(int value);

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
                }
                """);

            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run((value int32) -> 1))",
                "2");
        }

        [Fact]
        public void MutablePatternCapture_ReservesAgainstLiftedHelper()
        {
            string printed = Translate("""
                using System;

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
                }
                """);

            Assert.Contains("__pattern1", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run((value int32) -> value))",
                "107");
        }

        [Fact]
        public void SpillLocal_ReservesAgainstLiftedHelper()
        {
            string printed = Translate("""
                public class C
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
                        return total + __spill0(0);
                        static int __spill0(int n) =>
                            n == 0 ? 7 : Other<int>(n - 1);
                        static int Other<T>(int n) => __spill0(n);
                    }
                }
                """);

            Assert.Contains("let __spill1 = x", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run())",
                "132");
        }

        [Fact]
        public void DeconstructionCarrier_ReservesAgainstNestedLiftedHelper()
        {
            string printed = Translate("""
                using System;

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
                }
                """);

            Assert.Contains("xValue2", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run())",
                "7");
        }

        [Fact]
        public void LoopScrutinee_ReservesAgainstLiftedHelper()
        {
            string printed = Translate("""
                using System;

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
                }
                """);

            Assert.Contains("func __scrutinee0_2(", printed, StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run())",
                "7");
        }

        [Fact]
        public void ReadableLiftFallback_ReservesNameAgainstLaterTypeAlias()
        {
            string printed = Translate("""
                namespace Demo;

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
                }
                """);

            Assert.Contains("func TextStringBuilder_2(", printed, StringComparison.Ordinal);
            Assert.Contains(
                "import TextStringBuilder_3 = System.Text.StringBuilder",
                printed,
                StringComparison.Ordinal);
            LocalFunctionHoistTranslationTests.CompileAndRun(
                printed,
                "Console.WriteLine(C().Run(2))",
                "7");
        }

        [Fact]
        public void ReadableAlias_CompilationAllocatorKeepsAliasesUnique()
        {
            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                new[] { ("C.cs", "public class C { }") });
            LiftedLocalFunctionNameAllocator allocator =
                LiftedLocalFunctionNameAllocator.For(project.Compilation);

            Assert.Equal("TextStringBuilder", allocator.ClaimAlias("TextStringBuilder", _ => false));
            Assert.Equal("TextStringBuilder_2", allocator.ClaimAlias("TextStringBuilder", _ => false));
        }

        [Fact]
        public void ReadableLiftFallback_ReusesNameAcrossUnrelatedTypes()
        {
            string printed = Translate("""
                public class First
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
                }
                """);

            Assert.Equal(2, Regex.Matches(printed, @"func Helper\(").Count);
            Assert.DoesNotContain("func Helper_2(", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReadableLiftFallback_AvoidsContainingTypeName()
        {
            string printed = Translate("""
                public class C
                {
                    public int Run(int value)
                    {
                        return C(value);
                        static int C(int n) => n == 0 ? 0 : Other<int>(n - 1);
                        static int Other<T>(int n) => C(n);
                    }
                }
                """);

            Assert.Contains("func C_2(", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReadableLiftFallback_AvoidsImportedAlias()
        {
            string printed = Translate("""
                using Helper = System.Math;

                public class C
                {
                    public int Run(int value)
                    {
                        return Helper(value);
                        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
                        static int Other<T>(int n) => Helper(n);
                    }
                }
                """);

            Assert.Contains("func Helper_2(", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReadableLiftFallback_AvoidsEnclosingLocalNames()
        {
            string printed = Translate("""
                public class C
                {
                    private int Helper(int value) => -value;

                    public int Run(int value)
                    {
                        int Helper_2 = 1;
                        return Helper(value) + Helper_2;
                        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
                        static int Other<T>(int n) => Helper(n);
                    }
                }
                """);

            Assert.Contains("func Helper_3(", printed, StringComparison.Ordinal);
            Assert.Contains("return Helper_3(value) + Helper_2", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReadableLiftFallback_AvoidsOuterMethodLocalNames()
        {
            string printed = Translate("""
                public class C
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
                }
                """);

            Assert.Contains("func Helper_3(", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("func Helper_2(", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReadableLiftFallback_AvoidsSiblingLocalFunctionNames()
        {
            string printed = Translate("""
                public class C
                {
                    private int Helper(int value) => -value;

                    public int Run(int value)
                    {
                        return Helper(value) + Helper_2(value);
                        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
                        static int Other<T>(int n) => Helper(n);
                        static int Helper_2(int n) => n;
                    }
                }
                """);

            Assert.Contains("func Helper_3(", printed, StringComparison.Ordinal);
            Assert.Contains("return Helper_3(value) + Helper_2(value)", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReadableLiftFallback_AvoidsPrimaryConstructorFieldNames()
        {
            string printed = Translate("""
                public class C(int Helper_2)
                {
                    private int Helper(int value) => -value;

                    public int Run(int value)
                    {
                        return Helper(value) + Helper_2;
                        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
                        static int Other<T>(int n) => Helper(n);
                    }
                }
                """);

            Assert.Contains("func Helper_3(", printed, StringComparison.Ordinal);
            Assert.Contains("return Helper_3(value) + Helper_2", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReadableLiftFallback_AvoidsSynthesizedPropertyBackingField()
        {
            string printed = Translate("""
                public class C
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
                }
                """);

            Assert.Contains("func _foo_2(", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void UnreferencedUnderscoreLambdaParameter_KeepsDiscardSpelling()
        {
            string printed = Translate("""
                using System;

                public class C
                {
                    public static int Apply(Func<string, int> f) => f("x");

                    public static int Run() => Apply(_ => 7);
                }
                """);

            Assert.Contains("(_ string)", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__underscore", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ReferencedUnderscoreLambdaParameter_StillRenames()
        {
            string printed = Translate("""
                using System;

                public class C
                {
                    public static int Apply(Func<int, int> f) => f(3);

                    public static int Run() => Apply(_ => _ + 1);
                }
                """);

            Assert.Contains("__underscore", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        private static string Translate(
            string source,
            params MetadataReference[] additionalReferences)
        {
            IReadOnlyList<MetadataReference> references = additionalReferences.Length == 0
                ? null
                : CSharpProjectLoader.RuntimeReferences()
                    .Concat(additionalReferences)
                    .GroupBy(reference => reference.Display, StringComparer.Ordinal)
                    .Select(group => group.First())
                    .ToList();
            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                new[] { ("Snippet.cs", source) },
                references);
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: "
                    + string.Join(Environment.NewLine, project.ErrorDiagnostics));

            LoadedDocument document = Assert.Single(project.Documents);
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
            return GSharpPrinter.Print(unit);
        }
    }
}
