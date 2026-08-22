// <copyright file="Issue3466NestedHomonymAliasTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue3466NestedHomonymAliasTests
{
    [Fact]
    public void NestedDocInlineList_DoesNotAliasImportedGenericList()
    {
        string printed = Translate("""
            using System.Collections.Generic;

            namespace Demo
            {
                public abstract record DocInline
                {
                    public sealed record List(string Value) : DocInline;
                }

                public static class Repro
                {
                    public static int Count()
                    {
                        var values = new List<string>();
                        values.Add("one");
                        return values.Count;
                    }
                }
            }
            """);

        Assert.Contains("import System.Collections.Generic", printed, StringComparison.Ordinal);
        Assert.Contains("List[string]()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("import GenericList =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__cs2gs_", printed, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("public sealed class List { }")]
    [InlineData("public sealed class List<T> { }")]
    public void TopLevelListHomonym_UsesReadableAlias(string sourceDeclaration)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;

            namespace Demo
            {
                {{sourceDeclaration}}

                public static class Repro
                {
                    public static int Count()
                    {
                        var values = new System.Collections.Generic.List<string>();
                        values.Add("one");
                        return values.Count;
                    }
                }
            }
            """);

        Assert.Contains(
            "import GenericList = System.Collections.Generic.List",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("GenericList[string]()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__cs2gs_", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NonListMetadataHomonym_UsesGeneralReadableAliasPath()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class StringBuilder
                {
                }

                public static class Repro
                {
                    public static int Length()
                    {
                        var builder = new System.Text.StringBuilder("one");
                        return builder.Length;
                    }
                }
            }
            """);

        Assert.Contains(
            "import TextStringBuilder = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("TextStringBuilder(\"one\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__cs2gs_", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadableAlias_AvoidsEnclosingMethodThatShadowsTypeCall()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class StringBuilder
                {
                }

                public static class Repro
                {
                    private static int TextStringBuilder()
                    {
                        return 4;
                    }

                    public static int Length()
                    {
                        var builder = new System.Text.StringBuilder("one");
                        return builder.Length + TextStringBuilder();
                    }
                }
            }
            """);

        Assert.Contains(
            "import TextStringBuilder_2 = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("TextStringBuilder_2(\"one\")", printed, StringComparison.Ordinal);
        Assert.Contains("func TextStringBuilder() int32", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadableAlias_AvoidsInvokedLocalValues()
    {
        string printed = Translate("""
            using System;

            namespace Demo
            {
                public sealed class StringBuilder
                {
                }

                public static class LocalFunctionCase
                {
                    public static int Read()
                    {
                        int TextStringBuilder() => 1;
                        var builder = new System.Text.StringBuilder("one");
                        return builder.Length + TextStringBuilder();
                    }
                }

                public static class LocalCase
                {
                    public static int Read()
                    {
                        Func<int> TextStringBuilder = () => 2;
                        var builder = new System.Text.StringBuilder("two");
                        return builder.Length + TextStringBuilder();
                    }
                }
            }
            """);

        Assert.Contains(
            "import TextStringBuilder_2 = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "import TextStringBuilder = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Equal(2, CountOccurrences(printed, "TextStringBuilder_2(\""));
        Assert.True(
            CountOccurrences(printed, "TextStringBuilder()") >= 2,
            "Invoked source values keep their emitted name while the generated type alias moves.");
    }

    [Fact]
    public void ReadableAlias_DoesNotAvoidQualifiedMemberValues()
    {
        string printed = Translate("""
            using System;

            namespace Demo
            {
                public sealed class StringBuilder
                {
                }

                public static class FieldCase
                {
                    private static Func<int> TextStringBuilder = () => 3;

                    public static int Read()
                    {
                        var builder = new System.Text.StringBuilder("three");
                        return builder.Length + TextStringBuilder();
                    }
                }

                public static class PropertyCase
                {
                    private static Func<int> TextStringBuilder => () => 4;

                    public static int Read()
                    {
                        var builder = new System.Text.StringBuilder("four");
                        return builder.Length + TextStringBuilder();
                    }
                }
            }
            """);

        Assert.Contains(
            "import TextStringBuilder = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "import TextStringBuilder_2 = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Equal(2, CountOccurrences(printed, "TextStringBuilder(\""));
        Assert.Contains("FieldCase.TextStringBuilder()", printed, StringComparison.Ordinal);
        Assert.Contains("PropertyCase.TextStringBuilder()", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadableAlias_DoesNotAvoidUninvokedValueNames()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class StringBuilder
                {
                }

                public static class FieldCase
                {
                    private static int TextStringBuilder = 1;

                    public static int Read()
                    {
                        var builder = new System.Text.StringBuilder("one");
                        return builder.Length + TextStringBuilder;
                    }
                }

                public static class PropertyCase
                {
                    private static int TextStringBuilder => 2;

                    public static int Read()
                    {
                        var builder = new System.Text.StringBuilder("two");
                        return builder.Length + TextStringBuilder;
                    }
                }

                public static class LocalCase
                {
                    public static int Read()
                    {
                        int TextStringBuilder = 3;
                        var builder = new System.Text.StringBuilder("three");
                        return builder.Length + TextStringBuilder;
                    }
                }
            }
            """);

        Assert.Contains(
            "import TextStringBuilder = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "import TextStringBuilder_2 = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Equal(3, CountOccurrences(printed, "TextStringBuilder(\""));
    }

    [Fact]
    public void NestedSameArityMetadataType_DoesNotForceAlias()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class Container
                {
                    public sealed class StringBuilder
                    {
                    }
                }

                public static class Repro
                {
                    public static int Length()
                    {
                        var builder = new System.Text.StringBuilder("one");
                        return builder.Length;
                    }
                }
            }
            """);

        Assert.Contains("StringBuilder(\"one\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("import TextStringBuilder =", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void FullyQualifiedMetadataType_InsideNestedHomonymScope_UsesAlias()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class Container
                {
                    public sealed class StringBuilder
                    {
                    }

                    public static int Length()
                    {
                        var builder = new System.Text.StringBuilder("one");
                        return builder.Length;
                    }
                }
            }
            """);

        Assert.Contains(
            "import TextStringBuilder = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("TextStringBuilder(\"one\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Container.StringBuilder(\"one\")", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NestedType_WithImportedTopLevelHomonym_RemainsQualified()
    {
        string printed = Translate("""
            using System.Text;

            namespace Demo
            {
                public sealed class Container
                {
                    public sealed class StringBuilder
                    {
                        public int NestedOnly => 3;
                    }

                    public static int Read()
                    {
                        var builder = new StringBuilder();
                        return builder.NestedOnly;
                    }
                }
            }
            """);

        Assert.Contains("Container.StringBuilder()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("TextStringBuilder()", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadableAlias_AvoidsExistingAliasAndSourceType()
    {
        string printed = Translate("""
            using GenericList = System.Text.StringBuilder;

            namespace Demo
            {
                public sealed class List
                {
                }

                public sealed class GenericList_2
                {
                }

                public static class Repro
                {
                    public static int Count()
                    {
                        var first = new System.Collections.Generic.List<int>();
                        var second = new System.Collections.Generic.List<int>();
                        first.Add(1);
                        second.Add(2);
                        return first.Count + second.Count;
                    }
                }
            }
            """);

        Assert.Contains(
            "import GenericList = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Equal(
            1,
            CountOccurrences(
                printed,
                "import GenericList_3 = System.Collections.Generic.List"));
        Assert.Equal(2, CountOccurrences(printed, "GenericList_3[int32]()"));
    }

    [Fact]
    public void ReadableAlias_AvoidsImportedBareTypeName()
    {
        string referencePath = typeof(TextStringBuilder).Assembly.Location;
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(referencePath))
            .ToArray();
        using var resolver = ReferenceResolver.WithReferences(
            new[] { referencePath });

        string printed = Translate(
            """
            using Cs2Gs.Tests;

            namespace Demo
            {
                public sealed class StringBuilder
                {
                }

                public static class Repro
                {
                    public static System.Text.StringBuilder MakeBuilder()
                    {
                        return new System.Text.StringBuilder("one");
                    }

                    public static int Measure()
                    {
                        var builder = MakeBuilder();
                        TextStringBuilder imported = new TextStringBuilder();
                        return builder.Length + imported.Value;
                    }
                }
            }
            """,
            references,
            resolver);

        Assert.Contains(
            "import TextStringBuilder_2 = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "import TextStringBuilder = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "func MakeBuilder() TextStringBuilder_2 {",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "return TextStringBuilder_2(\"one\")",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ReadableAlias_AvoidsTypeFromLateExtensionMethodGroupImport()
    {
        string referencePath = typeof(TextStringBuilder).Assembly.Location;
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(referencePath))
            .ToArray();
        using var resolver = ReferenceResolver.WithReferences(
            new[] { referencePath });

        string printed = Translate(
            "Consumer.cs",
            new[]
            {
                ("Consumer.cs", """
                    namespace Demo
                    {
                        public sealed class StringBuilder
                        {
                        }

                        public static class Repro
                        {
                            public static System.Text.StringBuilder MakeBuilder()
                            {
                                return new System.Text.StringBuilder("one");
                            }

                            private static int Invoke(System.Func<int> action)
                            {
                                return action();
                            }

                            public static int Measure()
                            {
                                var builder = MakeBuilder();
                                return builder.Length + Invoke("x".Issue3466Length);
                            }
                        }
                    }
                    """),
                ("GlobalUsings.g.cs", "global using Cs2Gs.Tests;\n"),
            },
            references,
            resolver);

        Assert.Contains("import Cs2Gs.Tests", printed, StringComparison.Ordinal);
        Assert.Contains(
            "import TextStringBuilder_2 = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "import TextStringBuilder = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.True(
            CountOccurrences(printed, "TextStringBuilder_2") >= 3,
            "Late import reservation should keep one exact alias in type and constructor positions.");
    }

    [Fact]
    public void ReadableAlias_AvoidsEmittedMethodTypeParameterName()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class StringBuilder
                {
                }

                public static class Repro
                {
                    public static System.Text.StringBuilder Make<TextStringBuilder>()
                    {
                        return new System.Text.StringBuilder("one");
                    }
                }
            }
            """);

        Assert.Contains(
            "import TextStringBuilder_2 = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("func Make[TextStringBuilder]() TextStringBuilder_2", printed, StringComparison.Ordinal);
        Assert.Contains("return TextStringBuilder_2(\"one\")", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ExistingAlias_IsNotReusedWhenMethodTypeParameterShadowsIt()
    {
        string printed = Translate("""
            using TextStringBuilder = System.Text.StringBuilder;

            namespace Demo
            {
                public sealed class StringBuilder
                {
                }

                public static class Repro
                {
                    public static System.Text.StringBuilder Make<TextStringBuilder>()
                    {
                        return new System.Text.StringBuilder("one");
                    }
                }
            }
            """);

        Assert.Contains(
            "import TextStringBuilder = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "import TextStringBuilder_2 = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("func Make[TextStringBuilder]() TextStringBuilder_2", printed, StringComparison.Ordinal);
        Assert.Contains("return TextStringBuilder_2(\"one\")", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ExistingAlias_IsNotReusedWhenVisibleNestedSourceTypeShadowsIt()
    {
        string printed = Translate("""
            using StringBuilder = System.Text.StringBuilder;

            namespace Demo
            {
                public static class Before
                {
                    public static int Length()
                    {
                        return new StringBuilder("before").Length;
                    }
                }

                public sealed class Holder
                {
                    public sealed class StringBuilder
                    {
                    }

                    public static int Length()
                    {
                        return new System.Text.StringBuilder("nested").Length;
                    }
                }

                public static class After
                {
                    public static int Length()
                    {
                        return new StringBuilder("after").Length;
                    }
                }
            }
            """);

        Assert.Contains(
            "import StringBuilder = System.Text.StringBuilder",
            printed,
            StringComparison.Ordinal);
        Assert.Equal(
            1,
            CountOccurrences(
                printed,
                "import TextStringBuilder = System.Text.StringBuilder"));
        Assert.Equal(2, CountOccurrences(printed, "return StringBuilder(\""));
        Assert.Contains("TextStringBuilder(\"nested\")", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void OptionalEnumConstructorArgument_UsesLocatedAliasForMemberAndConversion()
    {
        string referencePath = typeof(Issue3466OptionalDayOfWeek).Assembly.Location;
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(referencePath))
            .ToArray();
        using var resolver = ReferenceResolver.WithReferences(
            new[] { referencePath });

        string printed = Translate(
            """
            namespace Demo
            {
                public sealed class Holder
                {
                    public enum DayOfWeek
                    {
                        Local,
                    }

                    public static int Read()
                    {
                        return new global::Cs2Gs.Tests.Issue3466OptionalDayOfWeek
                        {
                            Marker = 1,
                        }.Value;
                    }
                }
            }
            """,
            references,
            resolver);

        Assert.Contains(
            "import SystemDayOfWeek = System.DayOfWeek",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "SystemDayOfWeek(SystemDayOfWeek.Monday)",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void BareCatch_MapsSystemExceptionAtCatchLocation()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class Holder
                {
                    public sealed class Exception
                    {
                    }

                    public static int Read()
                    {
                        try
                        {
                            throw new global::System.InvalidOperationException();
                        }
                        catch
                        {
                            return 7;
                        }
                    }
                }
            }
            """);

        Assert.Contains(
            "import SystemException_2 = System.Exception",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("catch (ex SystemException_2)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void SynthesizedSwitchThrow_MapsSystemInvalidOperationExceptionAtSourceLocation()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class Holder
                {
                    public sealed class InvalidOperationException
                    {
                    }

                    public static int Read(bool value)
                    {
                        return value switch
                        {
                            true => 1,
                            false => 0,
                        };
                    }
                }
            }
            """);

        Assert.Contains(
            "import SystemInvalidOperationException = System.InvalidOperationException",
            printed,
            StringComparison.Ordinal);
        Assert.Contains(
            "SystemInvalidOperationException(\"Unmatched switch expression value.\")",
            printed,
            StringComparison.Ordinal);
    }

    private static string Translate(
        string source,
        IReadOnlyList<MetadataReference> references = null,
        ReferenceResolver bindReferences = null)
        => Translate(
            "Snippet.cs",
            new[] { ("Snippet.cs", source) },
            references,
            bindReferences);

    private static string Translate(
        string targetFileName,
        IReadOnlyList<(string FileName, string Source)> sources,
        IReadOnlyList<MetadataReference> references = null,
        ReferenceResolver bindReferences = null)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            sources,
            references);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(
            project.Documents,
            candidate => candidate.FilePath == targetFileName);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        if (bindReferences == null)
        {
            TranslationTestValidation.AssertBinds(printed);
        }
        else
        {
            TranslationTestValidation.AssertBinds(bindReferences, printed);
        }

        return printed;
    }

    private static int CountOccurrences(string value, string search)
    {
        int count = 0;
        for (int index = value.IndexOf(search, StringComparison.Ordinal);
            index >= 0;
            index = value.IndexOf(search, index + search.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}

public sealed class TextStringBuilder
{
    public int Value => 4;
}

public static class Issue3466LateImportExtensions
{
    public static int Issue3466Length(this string value) => value.Length;

    public static int Issue3466Length(this string value, int offset) => value.Length + offset;
}

public sealed class Issue3466OptionalDayOfWeek
{
    public Issue3466OptionalDayOfWeek(DayOfWeek day = DayOfWeek.Monday)
    {
        this.Value = (int)day;
    }

    public int Value { get; }

    public int Marker { get; set; }
}
