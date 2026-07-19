// <copyright file="Issue2509ConstraintTypeQualificationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2509: every class/interface constraint type must use the same
/// semantic, collision-aware type mapper as generic constraints and ordinary
/// type positions.
/// </summary>
public sealed class Issue2509ConstraintTypeQualificationTranslationTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SourceHomonyms_AllDeclarationKinds_KeepExactConstraintIdentity(bool reverseTypeFileOrder)
    {
        (string FileName, string Source) first = ("A.cs", """
            namespace A
            {
                public interface IContract { }
                public interface IGeneric<T> { }
                public class Base { }
                public static class Outer
                {
                    public interface IContract { }
                }
            }
            """);
        (string FileName, string Source) second = ("B.cs", """
            namespace B
            {
                public interface IContract { }
                public interface IGeneric<T> { }
                public class Base { }
                public static class Outer
                {
                    public interface IContract { }
                }
            }
            """);
        var sources = reverseTypeFileOrder
            ? new[] { second, first, ("Caller.cs", CallerSource) }
            : new[] { first, second, ("Caller.cs", CallerSource) };

        (string printed, TranslationContext context) = TranslateInMemory(sources, "Caller.cs");

        Assert.Contains("class BaseHost[T A.Base]", printed, StringComparison.Ordinal);
        Assert.Contains("interface InterfaceHost[T A.IContract]", printed, StringComparison.Ordinal);
        Assert.Contains("type Handler[T A.IContract] = delegate", printed, StringComparison.Ordinal);
        Assert.Contains("func Generic[T A.IGeneric[T]]", printed, StringComparison.Ordinal);
        Assert.Contains("func Nested[T A.Outer.IContract]", printed, StringComparison.Ordinal);
        Assert.Contains("func Multiple[T A.Base init()]", printed, StringComparison.Ordinal);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Message.Contains(
                "multiple constraint types; only the first ('A.Base')",
                StringComparison.Ordinal));
    }

    [Fact]
    public void MetadataConstraint_WithSourceHomonym_UsesQualifiedSemanticIdentity()
    {
        MetadataReference contractReference = CompileLibrary(
            """
            namespace A
            {
                public interface IContract { }
            }
            """,
            "Issue2509MetadataA");

        const string SourceHomonym = """
            namespace B
            {
                public interface IContract { }
            }
            """;
        const string Caller = """
            using Contract = A.IContract;

            namespace App
            {
                public static class Repro
                {
                    public static void Add<T>() where T : class, Contract, new() { }
                    public static B.IContract GetOther() => null;
                }
            }
            """;

        string printed = TranslateWithReferences(
            new[] { ("B.cs", SourceHomonym), ("Caller.cs", Caller) },
            "Caller.cs",
            contractReference);

        Assert.Contains("func Add[T A.IContract class init()]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void MetadataConstraint_WithMetadataHomonym_UsesQualifiedSemanticIdentity()
    {
        MetadataReference first = CompileLibrary(
            """
            namespace A
            {
                public interface IContract { }
            }
            """,
            "Issue2509MetadataFirst");
        MetadataReference second = CompileLibrary(
            """
            namespace B
            {
                public interface IContract { }
            }
            """,
            "Issue2509MetadataSecond");

        const string Caller = """
            using A;

            namespace App
            {
                public static class Repro
                {
                    public static void Add<T>() where T : IContract { }
                    public static B.IContract GetOther() => null;
                }
            }
            """;

        string printed = TranslateWithReferences(
            new[] { ("Caller.cs", Caller) },
            "Caller.cs",
            first,
            second);

        Assert.Contains("func Add[T A.IContract]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NestedMetadataConstraint_WithCollidingOutermostTypes_UsesNamespaceQualification()
    {
        MetadataReference first = CompileLibrary(
            """
            namespace A
            {
                public static class Outer
                {
                    public interface IContract { }
                }
            }
            """,
            "Issue2509NestedMetadataFirst");
        MetadataReference second = CompileLibrary(
            """
            namespace B
            {
                public static class Outer
                {
                    public interface IContract { }
                }
            }
            """,
            "Issue2509NestedMetadataSecond");

        const string Caller = """
            using A;

            namespace App
            {
                public static class Repro
                {
                    public static void Add<T>() where T : Outer.IContract { }
                    public static B.Outer.IContract GetOther() => null;
                }
            }
            """;

        string printed = TranslateWithReferences(
            new[] { ("Caller.cs", Caller) },
            "Caller.cs",
            first,
            second);

        Assert.Contains("func Add[T A.Outer.IContract]", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NullableConstraintAnnotation_IsAuditedAndDroppedFromUnsupportedConstraintSlot()
    {
        (string printed, TranslationContext context) = TranslateInMemory(
            new[]
            {
                ("Caller.cs", """
                    #nullable enable
                    namespace Solo
                    {
                        public interface IContract { }
                        public sealed class Holder<T> where T : IContract? { }
                    }
                    """),
            },
            "Caller.cs");

        Assert.Contains("class Holder[T IContract]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("IContract?", printed, StringComparison.Ordinal);
        Assert.Contains(
            context.Diagnostics,
            diagnostic => diagnostic.Message.Contains(
                "generic-constraint slot has no nullable form",
                StringComparison.Ordinal));
    }

    [Fact]
    public void NoCollision_NonGenericConstraint_RemainsShort()
    {
        (string printed, TranslationContext _) = TranslateInMemory(
            new[]
            {
                ("Caller.cs", """
                    namespace Solo
                    {
                        public interface IContract { }
                        public sealed class Holder<T> where T : IContract { }
                    }
                    """),
            },
            "Caller.cs");

        Assert.Contains("class Holder[T IContract]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Solo.IContract", printed, StringComparison.Ordinal);
    }

    private const string CallerSource = """
        using A;
        using Contract = A.IContract;

        namespace App
        {
            public class BaseHost<T> where T : Base { }
            public interface InterfaceHost<T> where T : Contract { }
            public delegate void Handler<T>() where T : IContract;

            public static class Repro
            {
                public static void Generic<T>() where T : IGeneric<T> { }
                public static void Nested<T>() where T : Outer.IContract { }
                public static void Multiple<T>() where T : Base, IContract, new() { }

                public static B.IContract GetOther() => null;
                public static B.IGeneric<int> GetOtherGeneric() => null;
                public static B.Base GetOtherBase() => null;
                public static B.Outer.IContract GetOtherNested() => null;
            }
        }
        """;

    private static (string Printed, TranslationContext Context) TranslateInMemory(
        (string FileName, string Source)[] sources,
        string targetFile)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(sources);
        Assert.True(
            project.BoundWithoutErrors,
            "Inline C# should bind without errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(
            candidate => candidate.FilePath.EndsWith(targetFile, StringComparison.Ordinal));
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return (PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context)), context);
    }

    private static string TranslateWithReferences(
        (string FileName, string Source)[] sources,
        string targetFile,
        params MetadataReference[] additionalReferences)
    {
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree[] trees = sources
            .Select(source => CSharpSyntaxTree.ParseText(source.Source, parseOptions, path: source.FileName))
            .ToArray();
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.Issue2509.ConstraintQualification",
            trees,
            CSharpProjectLoader.RuntimeReferences().Concat(additionalReferences).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

        SyntaxTree target = trees.Single(tree => tree.FilePath.EndsWith(targetFile, StringComparison.Ordinal));
        SemanticModel model = compilation.GetSemanticModel(target);
        var document = new LoadedDocument(target.FilePath, target, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(
            roundTrip.Success,
            string.Join(Environment.NewLine, roundTrip.Errors) + Environment.NewLine + printed);
        return printed;
    }

    private static MetadataReference CompileLibrary(string source, string assemblyName)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest));
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var stream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = compilation.Emit(stream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        stream.Position = 0;
        return MetadataReference.CreateFromStream(stream);
    }
}
