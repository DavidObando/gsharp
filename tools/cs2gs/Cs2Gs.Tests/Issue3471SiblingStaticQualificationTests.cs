// <copyright file="Issue3471SiblingStaticQualificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests
{
    // Issue #3471: a bare C# reference to a sibling static member used to be
    // re-qualified through the owning type on every line (`Agent.IsEnabled(...)`
    // inside `Agent`). gsc resolves bare sibling `shared` references from
    // anywhere inside the declaring aggregate's body, so the qualifier is only
    // required where the emitted body leaves the type scope (lifted extension
    // funcs), or where gsc genuinely cannot see the member bare (nested type →
    // outer statics, derived type → inherited statics).
    public sealed class Issue3471SiblingStaticQualificationTests
    {
        [Fact]
        public void InstanceMethod_SiblingSharedMembers_EmitBare()
        {
            string printed = Translate("""
                public class Agent
                {
                    public static int Count { get; set; }

                    public string Name = "x";

                    public string Describe()
                    {
                        if (IsEnabled("1"))
                        {
                            Count = Count + 1;
                            return Name + Count;
                        }

                        return Name;
                    }

                    private static bool IsEnabled(string value) => value == "1";
                }
                """);

            Assert.DoesNotContain("Agent.IsEnabled", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("Agent.Count", printed, StringComparison.Ordinal);
            Assert.Contains("IsEnabled(\"1\")", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void SharedMethod_SiblingSharedFieldAndCall_Evaluate()
        {
            string printed = Translate("""
                public static class Obj
                {
                    private static int seed = 40;

                    public static int Run()
                    {
                        Bump(2);
                        return seed;
                    }

                    private static int Bump(int by) => seed += by;
                }
                """);

            Assert.DoesNotContain("Obj.Bump", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("Obj.seed", printed, StringComparison.Ordinal);
            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(42, result.Value);
        }

        [Fact]
        public void NestedType_OuterSharedMember_StaysQualified()
        {
            string printed = Translate("""
                public class Outer
                {
                    public static string Tag() => "outer";

                    public class Inner
                    {
                        public string From() => Tag();
                    }
                }
                """);

            Assert.Contains("Outer.Tag()", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void DerivedType_InheritedSharedMember_StaysQualified()
        {
            string printed = Translate("""
                public class BaseCls
                {
                    public static string BaseTag() => "base";
                }

                public class DerivedCls : BaseCls
                {
                    public string From() => BaseTag();
                }
                """);

            Assert.Contains("BaseCls.BaseTag()", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void LiftedExtensionBody_SiblingStatic_StaysQualified()
        {
            string printed = Translate("""
                public static class Ext
                {
                    public static int Twice(this int value) => Add(value, value);

                    public static int Add(int a, int b) => a + b;
                }
                """);

            Assert.Contains("Ext.Add(", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void LiftedStaticLocalFunction_SameTypeCall_EmitsBare()
        {
            string printed = Translate("""
                public class Labels
                {
                    public string Make()
                    {
                        int ordinal = 0;
                        return NewLabel("switchEnd", ref ordinal);

                        static string NewLabel(string prefix, ref int i)
                        {
                            i++;
                            return prefix + i;
                        }
                    }
                }
                """);

            Assert.Contains("__local_", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("Labels.__local_", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void GenericOwner_SiblingSharedMember_EmitsBare()
        {
            string printed = Translate("""
                public class Box<T>
                {
                    public static int Total { get; set; }

                    public int Touch()
                    {
                        Total = Total + 1;
                        return Total;
                    }
                }
                """);

            Assert.DoesNotContain("Box[T].Total", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("Box.Total", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void StructOwner_SiblingSharedMember_EmitsBare()
        {
            string printed = Translate("""
                public struct Pt
                {
                    public static int Zero => 0;

                    public int X;

                    public int Shift() => X + Zero;
                }
                """);

            Assert.DoesNotContain("Pt.Zero", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        // gsc resolves bare sibling statics from lambda bodies inside INSTANCE
        // members but reports GS0130 for lambda bodies inside `shared` member
        // bodies (issue #3487), so a lambda site in a static member keeps the
        // qualifier while a lambda site in an instance member goes bare.
        [Fact]
        public void LambdaBody_InStaticMember_StaysQualified()
        {
            string printed = Translate("""
                using System;

                public class Events
                {
                    private static int Hidden() => 3;

                    public static int Shown() => 4;

                    public static int Run()
                    {
                        Func<int> mixed = () => Hidden() + Shown();
                        return mixed();
                    }
                }
                """);

            Assert.Contains("Events.Hidden()", printed, StringComparison.Ordinal);
            Assert.Contains("Events.Shown()", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void LambdaBody_InInstanceMember_EmitsBare()
        {
            string printed = Translate("""
                using System;

                public class Events
                {
                    private static int Hidden() => 3;

                    public int Run()
                    {
                        Func<int> f = () => Hidden();
                        return f();
                    }
                }
                """);

            Assert.DoesNotContain("Events.Hidden()", printed, StringComparison.Ordinal);
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
