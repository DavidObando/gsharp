// <copyright file="Issue3460TranslatorTests.cs" company="GSharp">
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

namespace Cs2Gs.Tests.Fixtures
{
    public sealed class Issue3460ImportedOptions
    {
        public Issue3460ImportedOptions()
        {
            Trace = (Trace * 10) + 1;
        }

        public Issue3460ImportedOptions(int marker)
        {
            Trace = (Trace * 10) + marker;
        }

        public static int Trace { get; set; }

        public required string Required { get; init; }

        public int InitOnly { get; init; }

        public int Value { get; set; }

        public Issue3460NestedOptions Nested { get; set; } = new();

        public List<int> Values { get; } = new();
    }

    public sealed class Issue3460NestedOptions
    {
        public int Value { get; set; }
    }

    public sealed class Issue3460OptionalOptions
    {
        public Issue3460OptionalOptions(int marker = 7)
        {
            Marker = marker;
        }

        public int Marker { get; }

        public int Value { get; init; }
    }

    public sealed class Issue3460OverloadedOptionalOptions
    {
        public Issue3460OverloadedOptionalOptions(short marker = 7)
        {
            Selected = 1;
        }

        public Issue3460OverloadedOptionalOptions(int marker)
        {
            Selected = 2;
        }

        public int Selected { get; }

        public int Value { get; init; }
    }

    public sealed class Issue3460ParamsCollectionOptions
    {
        public Issue3460ParamsCollectionOptions(params List<int> values)
        {
            Count = values.Count;
        }

        public int Count { get; }

        public int Value { get; init; }
    }

    public sealed class Issue3460OptionalParamsCollectionOptions
    {
        public Issue3460OptionalParamsCollectionOptions(
            int marker = 7,
            params List<int> values)
        {
            Marker = marker;
            Count = values.Count;
        }

        public int Marker { get; }

        public int Count { get; }

        public int Value { get; init; }
    }

    public sealed class Issue3460SpanParamsOptions
    {
        public Issue3460SpanParamsOptions(params ReadOnlySpan<int> values)
        {
            Count = values.Length;
        }

        public int Count { get; }

        public int Value { get; init; }
    }

    public sealed class Issue3460UnsupportedParamsOptions
    {
        public Issue3460UnsupportedParamsOptions(params HashSet<int> values)
        {
            Count = values.Count;
        }

        public int Count { get; }

        public int Value { get; init; }
    }

    public sealed class Issue3460StringDefaultOptions
    {
        public Issue3460StringDefaultOptions(string marker = "selected")
        {
            Selected = 1;
            Marker = marker;
        }

        public Issue3460StringDefaultOptions(object marker)
        {
            Selected = 2;
            Marker = marker.ToString();
        }

        public int Selected { get; }

        public string Marker { get; }

        public int Value { get; init; }
    }

    public sealed class Issue3460NonNullNestedHolder
    {
        public Issue3460NestedOptions Nested { get; } = new();
    }

    public sealed class Issue3460NullNestedHolder
    {
        public Issue3460NestedOptions Nested { get; }
    }

    public sealed class Issue3460NullCollectionHolder
    {
        public List<int> Values { get; }
    }
}

namespace Cs2Gs.Tests
{
    public sealed class Issue3460TranslatorTests
    {
        [Fact]
        public void ImportedClrObjectInitializer_UsesCanonicalCompositeLiteralAndBinds()
        {
            string printed = Translate("""
                using System.Text.Json;
                using System.Text.Json.Serialization;

                public static class Obj
                {
                    public static JsonSerializerOptions Make() =>
                        new JsonSerializerOptions
                        {
                            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
                        };
                }
                """,
                MetadataReference.CreateFromFile(
                    typeof(System.Text.Json.JsonSerializerOptions).Assembly.Location));

            Assert.Contains(
                "JsonSerializerOptions{DefaultIgnoreCondition: JsonIgnoreCondition.WhenWritingNull}",
                printed,
                StringComparison.Ordinal);
            Assert.DoesNotContain("JsonSerializerOptions(){", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ImportedClrObjectInitializer_InArgumentPosition_Binds()
        {
            string printed = Translate("""
                using System.Threading.Tasks;

                public static class Obj
                {
                    private static int Read(ParallelOptions options) =>
                        options.MaxDegreeOfParallelism;

                    public static int Make() =>
                        Read(new ParallelOptions { MaxDegreeOfParallelism = 4 });
                }
                """);

            Assert.Contains(
                "Read(ParallelOptions{MaxDegreeOfParallelism: 4})",
                printed,
                StringComparison.Ordinal);
            Assert.DoesNotContain("ParallelOptions(){", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void SystemObjectEmptyInitializer_RemainsClrObjectConstruction()
        {
            string printed = Translate("""
                namespace Demo
                {
                    public sealed class Object
                    {
                    }

                    public static class Obj
                    {
                        public static string Run() =>
                            new object { }.GetType().FullName!;
                    }
                }
                """);

            Assert.Contains(
                "import __cs2gs_System_Object = System.Object",
                printed,
                StringComparison.Ordinal);
            Assert.Contains("__cs2gs_System_Object()", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("object{}", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Demo.Obj.Run()");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal("System.Object", result.Value);
        }

        [Fact]
        public void ImportedParameterlessInitializer_PreservesOrderedMembersNestedInitializersAndRuntime()
        {
            string printed = Translate("""
                using Cs2Gs.Tests.Fixtures;

                public static class Obj
                {
                    private static Issue3460ImportedOptions Capture(
                        Issue3460ImportedOptions options) => options;

                    private static int Mark(int digit)
                    {
                        Issue3460ImportedOptions.Trace =
                            (Issue3460ImportedOptions.Trace * 10) + digit;
                        return digit;
                    }

                    private static string MarkText(string value, int digit)
                    {
                        Mark(digit);
                        return value;
                    }

                    public static int Run()
                    {
                        Issue3460ImportedOptions.Trace = 0;
                        var options = Capture(
                            new Issue3460ImportedOptions
                            {
                                Required = MarkText("ok", 2),
                                InitOnly = Mark(3),
                                Value = Mark(4),
                                Nested = new Issue3460NestedOptions { Value = Mark(5) },
                                Values = { Mark(6), Mark(7) },
                            });
                        return Issue3460ImportedOptions.Trace
                            + options.Required.Length
                            + options.InitOnly
                            + options.Value
                            + options.Nested.Value
                            + options.Values[0]
                            + options.Values[1];
                    }
                }
                """,
                MetadataReference.CreateFromFile(typeof(Fixtures.Issue3460ImportedOptions).Assembly.Location));

            Assert.Contains("Issue3460ImportedOptions{", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("Issue3460ImportedOptions(){", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()",
                new[] { typeof(Fixtures.Issue3460ImportedOptions).Assembly.Location });
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(1234594, result.Value);
        }

        [Fact]
        public void ImportedConstructorArguments_RunBeforeOrderedMemberAssignments()
        {
            string printed = Translate("""
                using Cs2Gs.Tests.Fixtures;

                public static class Obj
                {
                    private static int MarkArgument()
                    {
                        Issue3460ImportedOptions.Trace =
                            (Issue3460ImportedOptions.Trace * 10) + 1;
                        return 2;
                    }

                    private static int Mark(int digit)
                    {
                        Issue3460ImportedOptions.Trace =
                            (Issue3460ImportedOptions.Trace * 10) + digit;
                        return digit;
                    }

                    private static string MarkText(string value, int digit)
                    {
                        Mark(digit);
                        return value;
                    }

                    public static int Run()
                    {
                        Issue3460ImportedOptions.Trace = 0;
                        var options = new Issue3460ImportedOptions(MarkArgument())
                        {
                            Required = MarkText("ok", 3),
                            InitOnly = Mark(4),
                        };
                        return Issue3460ImportedOptions.Trace + options.Required.Length;
                    }
                }
                """,
                MetadataReference.CreateFromFile(typeof(Fixtures.Issue3460ImportedOptions).Assembly.Location));

            Assert.Contains(
                "Issue3460ImportedOptions(Obj.MarkArgument())",
                printed,
                StringComparison.Ordinal);
            Assert.Contains("Required = Obj.MarkText(\"ok\", 3)", printed, StringComparison.Ordinal);
            Assert.Contains("InitOnly = Obj.Mark(4)", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()",
                new[] { typeof(Fixtures.Issue3460ImportedOptions).Assembly.Location });
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(1236, result.Value);
        }

        [Fact]
        public void ImportedNestedMemberInitializer_UnwrapsNullableReceiverAndPreservesNullThrow()
        {
            string printed = Translate("""
                using System;
                using Cs2Gs.Tests.Fixtures;

                public static class Obj
                {
                    private static int trace;

                    private static int Mark(int digit)
                    {
                        trace = (trace * 10) + digit;
                        return digit;
                    }

                    public static int Run()
                    {
                        trace = 0;
                        var initialized = new Issue3460NonNullNestedHolder
                        {
                            Nested = { Value = 5 },
                        };

                        try
                        {
                            _ = new Issue3460NullNestedHolder
                            {
                                Nested = { Value = Mark(1) },
                            };
                            return -1;
                        }
                        catch (NullReferenceException)
                        {
                        }

                        try
                        {
                            _ = new Issue3460NullCollectionHolder
                            {
                                Values = { Mark(2) },
                            };
                            return -2;
                        }
                        catch (NullReferenceException)
                        {
                            return trace + initialized.Nested!.Value;
                        }
                    }
                }
                """,
                MetadataReference.CreateFromFile(typeof(Fixtures.Issue3460NestedOptions).Assembly.Location));

            Assert.Contains("Nested: { Value = 5 }", printed, StringComparison.Ordinal);
            Assert.Contains("Nested: { Value = Obj.Mark(1) }", printed, StringComparison.Ordinal);
            Assert.Contains("Values: { Obj.Mark(2) }", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()",
                new[] { typeof(Fixtures.Issue3460NestedOptions).Assembly.Location });
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(17, result.Value);
        }

        [Fact]
        public void SourceCompositeInitializer_BracedMembersPreserveTextualEvaluationOrder()
        {
            string printed = Translate("""
                using System.Collections.Generic;

                public sealed class Nested
                {
                    public int Value { get; set; }
                }

                public sealed class Options
                {
                    public int First { get; set; }
                    public Nested Nested { get; } = new();
                    public int Middle { get; set; }
                    public List<int> Values { get; } = new();
                    public int Last { get; set; }
                }

                public static class Obj
                {
                    private static int trace;

                    private static int Mark(int digit)
                    {
                        trace = (trace * 10) + digit;
                        return digit;
                    }

                    public static int Run()
                    {
                        trace = 0;
                        _ = new Options
                        {
                            First = Mark(1),
                            Nested = { Value = Mark(2) },
                            Middle = Mark(3),
                            Values = { Mark(4) },
                            Last = Mark(5),
                        };
                        return trace;
                    }
                }
                """);

            Assert.Contains("Options{", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("Options(){", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(12345, result.Value);
        }

        [Fact]
        public void ImportedOptionalConstructor_DefaultIsMaterializedBeforeInitializer()
        {
            string printed = Translate("""
                using Cs2Gs.Tests.Fixtures;

                public static class Obj
                {
                    public static int Run()
                    {
                        var options = new Issue3460OptionalOptions { Value = 3 };
                        return (options.Marker * 10) + options.Value;
                    }
                }
                """,
                MetadataReference.CreateFromFile(typeof(Fixtures.Issue3460OptionalOptions).Assembly.Location));

            Assert.Contains(
                "Issue3460OptionalOptions(int32(7)){Value = 3}",
                printed,
                StringComparison.Ordinal);
            Assert.DoesNotContain("Issue3460OptionalOptions(){", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()",
                new[] { typeof(Fixtures.Issue3460OptionalOptions).Assembly.Location });
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(73, result.Value);
        }

        [Fact]
        public void ImportedOptionalConstructor_DefaultKeepsSelectedNarrowOverload()
        {
            string printed = Translate("""
                using Cs2Gs.Tests.Fixtures;

                public static class Obj
                {
                    public static int Run()
                    {
                        var options = new Issue3460OverloadedOptionalOptions { Value = 3 };
                        return (options.Selected * 10) + options.Value;
                    }
                }
                """,
                MetadataReference.CreateFromFile(typeof(Fixtures.Issue3460OverloadedOptionalOptions).Assembly.Location));

            Assert.Contains(
                "Issue3460OverloadedOptionalOptions(int16(7)){Value = 3}",
                printed,
                StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()",
                new[] { typeof(Fixtures.Issue3460OverloadedOptionalOptions).Assembly.Location });
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(13, result.Value);
        }

        [Fact]
        public void ImportedParamsCollectionConstructor_NoParenthesesBuildsEmptyListArgument()
        {
            string printed = Translate("""
                using Cs2Gs.Tests.Fixtures;

                public static class Obj
                {
                    public static int Run()
                    {
                        var options = new Issue3460ParamsCollectionOptions { Value = 3 };
                        return (options.Count * 10) + options.Value;
                    }
                }
                """,
                MetadataReference.CreateFromFile(typeof(Fixtures.Issue3460ParamsCollectionOptions).Assembly.Location));

            Assert.Contains(
                "Issue3460ParamsCollectionOptions(List[int32]()){Value = 3}",
                printed,
                StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()",
                new[] { typeof(Fixtures.Issue3460ParamsCollectionOptions).Assembly.Location });
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(3, result.Value);
        }

        [Fact]
        public void ImportedOptionalBeforeParamsCollection_MaterializesEveryOperationSlot()
        {
            string printed = Translate("""
                using Cs2Gs.Tests.Fixtures;

                public static class Obj
                {
                    public static int Run()
                    {
                        var options = new Issue3460OptionalParamsCollectionOptions { Value = 3 };
                        return (options.Marker * 100) + (options.Count * 10) + options.Value;
                    }
                }
                """,
                MetadataReference.CreateFromFile(typeof(Fixtures.Issue3460OptionalParamsCollectionOptions).Assembly.Location));

            Assert.Contains(
                "Issue3460OptionalParamsCollectionOptions(int32(7), List[int32]()){Value = 3}",
                printed,
                StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()",
                new[] { typeof(Fixtures.Issue3460OptionalParamsCollectionOptions).Assembly.Location });
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(703, result.Value);
        }

        [Fact]
        public void ImportedSpanParamsCollection_ExpandedObjectCreationUsesArrayConversion()
        {
            string printed = Translate("""
                using Cs2Gs.Tests.Fixtures;

                public static class Obj
                {
                    public static int Run()
                    {
                        var options = new Issue3460SpanParamsOptions(1, 2) { Value = 3 };
                        return (options.Count * 10) + options.Value;
                    }
                }
                """,
                MetadataReference.CreateFromFile(typeof(Fixtures.Issue3460SpanParamsOptions).Assembly.Location));

            Assert.Contains(
                "Issue3460SpanParamsOptions([]int32{1, 2}){Value = 3}",
                printed,
                StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()",
                new[] { typeof(Fixtures.Issue3460SpanParamsOptions).Assembly.Location });
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(23, result.Value);
        }

        [Fact]
        public void ImportedUnsupportedParamsCollection_NonemptyExpansionReportsDiagnostic()
        {
            (_, TranslationContext context) = TranslateWithContext("""
                using Cs2Gs.Tests.Fixtures;

                public static class Obj
                {
                    public static object Run() =>
                        new Issue3460UnsupportedParamsOptions(1, 2) { Value = 3 };
                }
                """,
                MetadataReference.CreateFromFile(typeof(Fixtures.Issue3460UnsupportedParamsOptions).Assembly.Location));

            Assert.Contains(
                context.Diagnostics,
                diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported
                    && diagnostic.Message.Contains("HashSet", StringComparison.Ordinal));
        }

        [Fact]
        public void ImportedStringOptionalDefault_PreservesSelectedReferenceOverload()
        {
            string printed = Translate("""
                using Cs2Gs.Tests.Fixtures;

                public static class Obj
                {
                    public static int Run()
                    {
                        var options = new Issue3460StringDefaultOptions { Value = 3 };
                        return (options.Selected * 100)
                            + (options.Marker.Length * 10)
                            + options.Value;
                    }
                }
                """,
                MetadataReference.CreateFromFile(typeof(Fixtures.Issue3460StringDefaultOptions).Assembly.Location));

            Assert.Contains(
                "Issue3460StringDefaultOptions(\"selected\"){Value = 3}",
                printed,
                StringComparison.Ordinal);
            Assert.DoesNotContain("\"selected\" as string", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);

            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()",
                new[] { typeof(Fixtures.Issue3460StringDefaultOptions).Assembly.Location });
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(183, result.Value);
        }

        private static string Translate(
            string source,
            params MetadataReference[] additionalReferences)
        {
            return TranslateWithContext(source, additionalReferences).Printed;
        }

        private static (string Printed, TranslationContext Context) TranslateWithContext(
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
            return (GSharpPrinter.Print(unit), context);
        }
    }
}
