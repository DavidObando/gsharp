// <copyright file="Issue3468MethodGroupWrapperTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests
{
    // Issue #3468: a method group whose signature already matches the target
    // delegate passes through as a direct method reference; a wrapper that IS
    // required renders as the concise arrow form with parameter names derived
    // from the target method (`(value string) -> Stringify(value)`), keeping
    // the block-bodied explicit-return-type function literal only where the
    // delegate's result type must be pinned (return covariance) or parameters
    // pass by reference.
    public sealed class Issue3468MethodGroupWrapperTests
    {
        [Fact]
        public void MatchingMethodGroups_PassThroughDirect()
        {
            string printed = Translate("""
                using System.Collections.Generic;
                using System.IO;
                using System.Linq;

                public class W
                {
                    public List<string> Full(List<string> paths)
                        => paths.Select(Path.GetFullPath).ToList();

                    public List<int> Lens(List<string> paths)
                        => paths.Select(Len).ToList();

                    private static int Len(string s) => s.Length;
                }
                """);

            Assert.Contains("paths.Select(Path.GetFullPath)", printed, StringComparison.Ordinal);
            Assert.Contains("Select(Len)", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        // An EXPLICIT C# delegate creation renders as a G# construction,
        // whose operand cannot be a variant group — so the cast shape keeps
        // its arrow wrapper even after #3501 A5.
        [Fact]
        public void ContravariantCastMethodGroup_KeepsArrowWrapper()
        {
            string printed = Translate("""
                using System;
                using System.Collections.Generic;
                using System.Linq;

                public class W
                {
                    public List<string> Mixed(List<string> paths)
                        => paths.Select((Func<string, string>)Stringify).ToList();

                    private static string Stringify(object? value) => value?.ToString() ?? "";
                }
                """);

            Assert.Contains("(value string) -> W.Stringify(value)", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("func (", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        // Issue #3501 A5: covariant-return groups pass direct.
        [Fact]
        public void ReturnCovariantMethodGroup_PassesDirect()
        {
            string printed = Translate("""
                using System.Collections.Generic;
                using System.Linq;

                public class W
                {
                    public List<object> Objs(List<string> paths)
                        => paths.Select<string, object>(Twice).ToList();

                    private static string Twice(string s) => s + s;
                }
                """);

            Assert.Contains("Select[string, object](Twice)", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("func (s string) object", printed, StringComparison.Ordinal);
            Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void ArrowWrapper_ExecutesWithParity()
        {
            string printed = Translate("""
                using System;
                using System.Collections.Generic;
                using System.Linq;

                public static class Obj
                {
                    public static int Run()
                    {
                        var items = new List<string> { "a", "bb" };
                        return items.Select((Func<string, int>)Weigh).Sum();
                    }

                    private static int Weigh(object? value) => (value as string)?.Length ?? 0;
                }
                """);

            Assert.Contains("(value string) -> Obj.Weigh(value)", printed, StringComparison.Ordinal);
            EmittedOracleResult result = EmittedOracle.Evaluate(
                printed + Environment.NewLine + "Obj.Run()");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
            Assert.Null(result.UnhandledException);
            Assert.Equal(3, result.Value);
        }

        [Fact]
        public void ReceiverRootCollision_UsesSourceDerivedSuffix()
        {
            string printed = Translate("""
                using System;

                public sealed class Renderer
                {
                    public string Render(object? value)
                        => value?.ToString() ?? "";
                }

                public static class W
                {
                    public static void Bind(Renderer value)
                        => Use((Func<string, string>)value.Render);

                    private static void Use(Func<string, string> transform)
                    {
                    }
                }
                """);

            Assert.Contains(
                "(value_ string) -> Func[string, string](value.Render)(value_)",
                printed,
                StringComparison.Ordinal);
            Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void NullableReceiverRootCollision_UsesSourceDerivedSuffix()
        {
            string printed = Translate("""
                using System;

                public sealed class Renderer
                {
                    public string Render(object? value)
                        => value?.ToString() ?? "";
                }

                public static class W
                {
                    public static void Bind(Renderer? value)
                        => Use((Func<string, string>)value!.Render);

                    private static void Use(Func<string, string> transform)
                    {
                    }
                }
                """);

            Assert.Contains(
                "(value_ string) -> Func[string, string](value!!.Render)(value_)",
                printed,
                StringComparison.Ordinal);
            Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void UnreachableDoubleSuffixCollision_PreservesFutureSourceName()
        {
            // Issue #4298: preserve the legal future source name `value_`
            // while suffixing the colliding `value`. No current translation
            // path reaches this helper with both collisions, so exercise the
            // defensive corner directly.
            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                new[] { ("Snippet.cs", "class C { void M(object value, object value_) {} }") });
            INamedTypeSymbol type = Assert.IsAssignableFrom<INamedTypeSymbol>(
                project.Compilation.GetTypeByMetadataName("C"));
            IMethodSymbol method = Assert.Single(type.GetMembers("M").OfType<IMethodSymbol>());
            var usedNames = new HashSet<string>(StringComparer.Ordinal)
            {
                "value",
            };

            Assert.Equal(
                "value__",
                WrapperParameterName(project.Compilation, method.Parameters, 0, usedNames));
            Assert.Equal(
                "value_",
                WrapperParameterName(project.Compilation, method.Parameters, 1, usedNames));
        }

        [Fact]
        public void ReservedWrapperParameter_UsesSourceDerivedSuffix()
        {
            string printed = Translate("""
                using System;

                public static class W
                {
                    public static void Bind()
                        => Use((Func<string, string>)Normalize);

                    private static string Normalize(object? @params)
                        => @params?.ToString() ?? "";

                    private static void Use(Func<string, string> transform)
                    {
                    }
                }
                """);

            Assert.Contains(
                "(params_ string) -> W.Normalize(params_)",
                printed,
                StringComparison.Ordinal);
            Assert.DoesNotContain("__arg", printed, StringComparison.Ordinal);
            TranslationTestValidation.AssertBinds(printed);
        }

        [Fact]
        public void MissingWrapperParameterName_UsesUniqueSyntheticFallback()
        {
            // Bound C# method-group conversions name every delegate slot; an
            // absent symbol is a defensive error-recovery corner only.
            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                new[] { ("Snippet.cs", "class C {}") });
            var usedNames = new HashSet<string>(StringComparer.Ordinal)
            {
                "__arg0",
            };

            string name = WrapperParameterName(
                project.Compilation,
                ImmutableArray<IParameterSymbol>.Empty,
                0,
                usedNames);

            Assert.Equal("__arg0_", name);
            Assert.Contains(name, usedNames);
        }

        private static string WrapperParameterName(
            Compilation compilation,
            ImmutableArray<IParameterSymbol> parameters,
            int index,
            HashSet<string> usedNames)
        {
            Type visitor = Assert.IsAssignableFrom<Type>(
                typeof(CSharpToGSharpTranslator).GetNestedType(
                    "DeclarationVisitor",
                    BindingFlags.NonPublic));
            MethodInfo method = Assert.IsAssignableFrom<MethodInfo>(
                visitor.GetMethod(
                    "MethodGroupWrapperParameterName",
                    BindingFlags.NonPublic | BindingFlags.Static));
            return Assert.IsType<string>(method.Invoke(
                null,
                new object[]
                {
                    EmittedNameAllocator.For(compilation),
                    parameters,
                    index,
                    usedNames,
                }));
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
