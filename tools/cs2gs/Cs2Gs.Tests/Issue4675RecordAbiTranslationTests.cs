// <copyright file="Issue4675RecordAbiTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;
using GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4675: translated record API metadata must match Roslyn's C#
/// baseline for the same source.
/// </summary>
public sealed class Issue4675RecordAbiTranslationTests
{
    private const string Source = @"
namespace Corpus.Issue4675
{
    public record RecordBase(int BaseValue)
    {
        public string Render()
        {
            var builder = new System.Text.StringBuilder();
            PrintMembers(builder);
            return builder.ToString();
        }
    }

    public record RecordClass(int Value) : RecordBase(1)
    {
        public string BodyHash { get; } = ""hash"";
    }

    public sealed record SealedRecord(int Value);

    public sealed record SealedDerivedRecord(int Other) : RecordBase(1);

    public readonly record struct RecordStruct(int Value);

    public record GenericRecord<T>(T Value);

    public record GenericDerivedRecord<T>(T Value) : RecordBase(1);

    public readonly record struct GenericRecordStruct<T>(T Value);

    public record RefOverloadedPrintMembers(int Value)
    {
        public bool PrintMembers(ref System.Text.StringBuilder builder) => false;
    }

    public record CustomPrintMembers(int Value)
    {
        protected virtual bool PrintMembers(System.Text.StringBuilder builder)
        {
            builder.Append(""custom"");
            return true;
        }
    }

    public record DerivedCustomPrintMembers(int Other) : CustomPrintMembers(1);

    public record OverloadedPrintMembers(int Value)
    {
        public bool PrintMembers(int ignored) => false;
    }
}";

    [Fact]
    public void TranslatedRecordAbi_MatchesCSharpCompilerSurface()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Issue4675.cs", Source) });
        Assert.True(
            project.BoundWithoutErrors,
            "C# baseline should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        INamedTypeSymbol baselineClass = project.Compilation.GetTypeByMetadataName("Corpus.Issue4675.RecordClass");
        IMethodSymbol baselinePrintMembers = Assert.Single(
            baselineClass.GetMembers("PrintMembers").OfType<IMethodSymbol>());
        Assert.Equal(Accessibility.Protected, baselinePrintMembers.DeclaredAccessibility);
        Assert.True(baselinePrintMembers.IsVirtual || baselinePrintMembers.IsOverride);
        Assert.Equal("System.Text.StringBuilder", baselinePrintMembers.Parameters[0].Type.ToDisplayString());
        Assert.Contains(
            baselineClass.AllInterfaces,
            iface => iface.OriginalDefinition.ToDisplayString() == "System.IEquatable<T>");

        IPropertySymbol baselineProperty = Assert.Single(
            baselineClass.GetMembers("BodyHash").OfType<IPropertySymbol>());
        Assert.Null(baselineProperty.SetMethod);

        INamedTypeSymbol baselineStruct = project.Compilation.GetTypeByMetadataName("Corpus.Issue4675.RecordStruct");
        Assert.Contains(
            baselineStruct.AllInterfaces,
            iface => iface.OriginalDefinition.ToDisplayString() == "System.IEquatable<T>");

        INamedTypeSymbol baselineOverloaded = project.Compilation.GetTypeByMetadataName("Corpus.Issue4675.OverloadedPrintMembers");
        Assert.Contains(
            baselineOverloaded.GetMembers("PrintMembers").OfType<IMethodSymbol>(),
            method => method.IsImplicitlyDeclared
                && method.Parameters.Length == 1
                && method.Parameters[0].Type.ToDisplayString() == "System.Text.StringBuilder");

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string translated = GSharpPrinter.Print(unit);
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(translated);
        Assert.True(
            roundTrip.Success,
            "Translated record should bind:\n" + string.Join(Environment.NewLine, roundTrip.Errors) + "\n" + translated);

        TypeDeclaration translatedClass = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "RecordClass");
        MethodDeclaration translatedPrintMembers = Assert.Single(
            translatedClass.Members.OfType<MethodDeclaration>(),
            method => method.Name == "PrintMembers");
        Assert.Equal(Visibility.Protected, translatedPrintMembers.Visibility);
        Assert.True(translatedPrintMembers.IsOpen);
        Assert.Contains("BodyHash", translated);
        Assert.DoesNotContain("BodyHash string { get; init; }", translated, StringComparison.Ordinal);

        TypeDeclaration translatedStruct = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "RecordStruct");
        Assert.Contains(
            translatedStruct.Interfaces,
            iface => iface is NamedTypeReference named && named.Name.Contains("IEquatable", StringComparison.Ordinal));
        TypeDeclaration translatedOverloaded = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "OverloadedPrintMembers");
        Assert.Equal(
            2,
            translatedOverloaded.Members.OfType<MethodDeclaration>().Count(method => method.Name == "PrintMembers"));

        using var csharpImage = new MemoryStream();
        Assert.True(project.Compilation.Emit(csharpImage).Success, "C# baseline should emit.");
        using var gsharpImage = new MemoryStream();
        var gsharpCompilation = new GSharpCompilation(
            GSharpSyntaxTree.Parse(SourceText.From(translated)))
        {
            IsLibrary = true,
        };
        var gsharpEmit = gsharpCompilation.Emit(
            gsharpImage,
            pdbStream: null,
            refStream: null,
            assemblyName: "Issue4675Translated");
        Assert.True(gsharpEmit.Success, string.Join(Environment.NewLine, gsharpEmit.Diagnostics));

        Assembly csharpAssembly = Assembly.Load(csharpImage.ToArray());
        Assembly gsharpAssembly = Assembly.Load(gsharpImage.ToArray());
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordBase");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedRecord");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordStruct");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordBase");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedDerivedRecord");
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordBase", isProtected: true);
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass", isProtected: true);
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedRecord", isProtected: false);
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.SealedDerivedRecord", isProtected: false);
        Assert.True(gsharpAssembly.GetType("Corpus.Issue4675.SealedDerivedRecord", throwOnError: true).IsSealed);
        AssertGetOnlyProperty(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass", "BodyHash");
        AssertInitProperty(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RecordClass", "Value");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.OverloadedPrintMembers");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.RefOverloadedPrintMembers");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.CustomPrintMembers");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.GenericRecord`1");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.GenericDerivedRecord`1");
        AssertRecordInterface(csharpAssembly, gsharpAssembly, "Corpus.Issue4675.GenericRecordStruct`1");
        foreach (string typeName in new[]
        {
            "Corpus.Issue4675.RecordBase",
            "Corpus.Issue4675.RecordClass",
            "Corpus.Issue4675.DerivedCustomPrintMembers",
            "Corpus.Issue4675.SealedDerivedRecord",
        })
        {
            AssertPrintMembersOutput(csharpAssembly, gsharpAssembly, typeName);
        }

        object baselineDerived = Activator.CreateInstance(
            csharpAssembly.GetType("Corpus.Issue4675.SealedDerivedRecord", throwOnError: true), new object[] { 42 });
        object translatedDerived = Activator.CreateInstance(
            gsharpAssembly.GetType("Corpus.Issue4675.SealedDerivedRecord", throwOnError: true), new object[] { 42 });
        object baselineRender = csharpAssembly.GetType("Corpus.Issue4675.RecordBase", throwOnError: true)
            .GetMethod("Render").Invoke(baselineDerived, null);
        object translatedRender = gsharpAssembly.GetType("Corpus.Issue4675.RecordBase", throwOnError: true)
            .GetMethod("Render").Invoke(translatedDerived, null);
        Assert.Equal(baselineRender, translatedRender);
    }

    [Theory]
    [InlineData("P")]
    [InlineData("this.P")]
    public void InitializedGetOnlyRecordProperty_ConstructorWritesTargetBackingField(string target)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Record.cs", """
                public record Item(int N) {
                    public int P { get; } = 1;
                    public Item() : this(0) { TARGET = 2; }
                    public static int Run() => new Item().P;
                }
                """.Replace("TARGET", target, StringComparison.Ordinal)),
        });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        var result = EmittedOracle.Evaluate(translated + "\nItem.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void CharArrayRecordPrinting_MatchesCSharpBaseline()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("ArrayRecord.cs", """
                public record Item(char[] Value) {
                    public static string Run() {
                        var builder = new System.Text.StringBuilder();
                        new Item(new[] { 'a', 'b' }).PrintMembers(builder);
                        return builder.ToString();
                    }
                }
                """),
        });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        using var baselineImage = new MemoryStream();
        Assert.True(project.Compilation.Emit(baselineImage).Success);
        Assembly baseline = Assembly.Load(baselineImage.ToArray());
        object expected = baseline.GetType("Item", throwOnError: true).GetMethod("Run").Invoke(null, null);
        Assert.Equal("Value = System.Char[]", expected);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        var result = EmittedOracle.Evaluate(translated + "\nItem.Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void PartialRecordPrintMembers_IsEmittedOnce()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("First.cs", "namespace Corpus; public partial record Item(int Value);"),
            ("Second.cs", "namespace Corpus; public partial record Item { public int Extra => 7; }"),
        });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        string[] translated = project.Documents.Select(document =>
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        }).ToArray();
        Assert.Equal(1, translated.Sum(text => text.Split("func PrintMembers(", StringSplitOptions.None).Length - 1));
        TranslationTestValidation.AssertBinds(translated);
    }

    [Theory]
    [InlineData("public virtual", "CS8875")]
    [InlineData("private", "CS8875")]
    [InlineData("protected", "CS8872")]
    public void InvalidRecordPrintMembersShape_IsRejectedByCSharp(string modifiers, string diagnosticId)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Invalid.cs", $"public record Item {{ {modifiers} bool PrintMembers(System.Text.StringBuilder builder) => false; }}"),
        });
        Assert.False(project.BoundWithoutErrors);
        Assert.Contains(project.ErrorDiagnostics, diagnostic => diagnostic.Id == diagnosticId);
    }

    [Fact]
    public void TranslatedCoreRecordAbi_MatchesCSharpSourceApi()
    {
        string repoRoot = LocateRepoRoot();
        string[] paths =
        {
            "src/Core/CodeAnalysis/OptionalValue.cs",
            "src/Core/CodeAnalysis/SymbolInfo.cs",
            "src/Core/CodeAnalysis/TypeInfo.cs",
            "src/Core/CodeAnalysis/Binding/BoundBodyCacheKey.cs",
            "src/Core/CodeAnalysis/Documentation/DocInline.cs",
            "src/Core/CodeAnalysis/Documentation/DocumentationComment.cs",
        };
        var sources = paths
            .Select(path => (Path: path, Source: File.ReadAllText(Path.Combine(repoRoot, path))))
            .ToArray();
        var references = CSharpProjectLoader.RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(typeof(GSharpCompilation).Assembly.Location))
            .ToArray();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            sources.Select(source => (source.Path, source.Source)).ToArray(),
            references,
            assemblyName: "Issue4675CoreCSharpBaseline");
        Assert.True(
            project.BoundWithoutErrors,
            "Core C# baseline sources should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        string[] translatedSources = project.Documents
            .Select(document =>
            {
                var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
                return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
            })
            .ToArray();
        TranslationTestValidation.AssertBinds(translatedSources);

        using var csharpImage = new MemoryStream();
        Assert.True(project.Compilation.Emit(csharpImage).Success, "Core C# baseline should emit.");
        using var gsharpImage = new MemoryStream();
        var gsharpCompilation = new GSharpCompilation(
            translatedSources.Select(source => GSharpSyntaxTree.Parse(SourceText.From(source))).ToArray())
        {
            IsLibrary = true,
        };
        var gsharpEmit = gsharpCompilation.Emit(
            gsharpImage,
            pdbStream: null,
            refStream: null,
            assemblyName: "Issue4675TranslatedCoreRecords");
        Assert.True(
            gsharpEmit.Success,
            string.Join(
                Environment.NewLine,
                gsharpEmit.Diagnostics.Select(diagnostic => $"{diagnostic.Id} {diagnostic.Location}: {diagnostic.Message}")));

        Assembly csharpAssembly = Assembly.Load(csharpImage.ToArray());
        Assembly gsharpAssembly = Assembly.Load(gsharpImage.ToArray());
        foreach (string typeName in new[]
        {
            "GSharp.Core.CodeAnalysis.OptionalValue",
            "GSharp.Core.CodeAnalysis.SymbolInfo",
            "GSharp.Core.CodeAnalysis.TypeInfo",
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
        })
        {
            AssertRecordInterface(csharpAssembly, gsharpAssembly, typeName);
        }

        AssertRecordInterface(csharpAssembly, gsharpAssembly, "GSharp.Core.CodeAnalysis.Documentation.DocInline");
        AssertPrintMembers(csharpAssembly, gsharpAssembly, "GSharp.Core.CodeAnalysis.Documentation.DocInline");
        AssertCopyConstructor(csharpAssembly, gsharpAssembly, "GSharp.Core.CodeAnalysis.Documentation.DocInline", isProtected: true);
        AssertCopyConstructor(
            csharpAssembly,
            gsharpAssembly,
            "GSharp.Core.CodeAnalysis.Documentation.DocInline+UnknownXmlElement",
            isProtected: false);
        AssertGetOnlyProperty(
            csharpAssembly,
            gsharpAssembly,
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            "BodyHash");
        AssertGetOnlyProperty(
            csharpAssembly,
            gsharpAssembly,
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            "StableMemberId");

        Type baselineKeyType = csharpAssembly.GetType(
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            throwOnError: true);
        Type translatedKeyType = gsharpAssembly.GetType(
            "GSharp.Core.CodeAnalysis.Binding.BoundBodyCacheKey",
            throwOnError: true);
        ConstructorInfo baselineKeyConstructor = Assert.Single(
            baselineKeyType.GetConstructors(),
            constructor => constructor.GetParameters().Length == 2);
        ConstructorInfo translatedKeyConstructor = Assert.Single(
            translatedKeyType.GetConstructors(),
            constructor => constructor.GetParameters().Length == 2);
        object baselineKey = baselineKeyConstructor.Invoke(new object[] { null, null });
        object translatedKey = translatedKeyConstructor.Invoke(new object[] { null, null });
        foreach (string propertyName in new[] { "StableMemberId", "BodyHash" })
        {
            Assert.True(
                Equals(
                    baselineKeyType.GetProperty(propertyName).GetValue(baselineKey),
                    translatedKeyType.GetProperty(propertyName).GetValue(translatedKey)),
                propertyName + " initializer mismatch.");
        }
    }

    private static string LocateRepoRoot()
    {
        for (DirectoryInfo directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "CONTRIBUTING.md")))
            {
                return directory.FullName;
            }
        }

        throw new DirectoryNotFoundException("Could not locate the G# repository root.");
    }

    private static void AssertRecordInterface(Assembly baseline, Assembly translated, string typeName)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        if (baselineType.IsGenericTypeDefinition)
        {
            baselineType = baselineType.MakeGenericType(typeof(int));
            translatedType = translatedType.MakeGenericType(typeof(int));
        }

        Assert.Contains(typeof(IEquatable<>).MakeGenericType(baselineType), baselineType.GetInterfaces());
        Assert.Contains(typeof(IEquatable<>).MakeGenericType(translatedType), translatedType.GetInterfaces());

        MethodInfo baselineEquals = baselineType.GetMethod("Equals", new[] { baselineType });
        MethodInfo translatedEquals = translatedType.GetMethod("Equals", new[] { translatedType });
        Assert.NotNull(baselineEquals);
        Assert.NotNull(translatedEquals);
        Assert.Equal(baselineEquals.Attributes & MethodAttributes.MemberAccessMask, translatedEquals.Attributes & MethodAttributes.MemberAccessMask);
        Assert.Equal(baselineEquals.IsVirtual, translatedEquals.IsVirtual);
        Assert.Equal(baselineEquals.IsFinal, translatedEquals.IsFinal);
        if (!baseline.GetType(typeName, throwOnError: true).IsGenericTypeDefinition)
        {
            return;
        }

        ConstructorInfo constructor = Assert.Single(
            translatedType.GetConstructors(),
            candidate => candidate.GetParameters() is [{ ParameterType: var parameterType }] && parameterType == typeof(int));
        object left = constructor.Invoke(new object[] { 42 });
        object equal = constructor.Invoke(new object[] { 42 });
        object different = constructor.Invoke(new object[] { 43 });
        MethodInfo interfaceEquals = typeof(IEquatable<>).MakeGenericType(translatedType).GetMethod("Equals");
        Assert.Equal(true, interfaceEquals.Invoke(left, new[] { equal }));
        Assert.Equal(false, interfaceEquals.Invoke(left, new[] { different }));
    }

    private static void AssertPrintMembers(Assembly baseline, Assembly translated, string typeName)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        MethodInfo baselineMethod = baselineType.GetMethod(
            "PrintMembers",
            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
        MethodInfo translatedMethod = translatedType.GetMethod(
            "PrintMembers",
            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);

        Assert.NotNull(baselineMethod);
        Assert.NotNull(translatedMethod);
        Assert.Equal(baselineMethod.Attributes & MethodAttributes.MemberAccessMask, translatedMethod.Attributes & MethodAttributes.MemberAccessMask);
        Assert.Equal(baselineMethod.IsVirtual, translatedMethod.IsVirtual);
        Assert.Equal(baselineMethod.IsFinal, translatedMethod.IsFinal);
        Assert.Equal(baselineMethod.ReturnType, translatedMethod.ReturnType);
        Assert.Equal(
            baselineMethod.GetParameters().Select(parameter => parameter.ParameterType),
            translatedMethod.GetParameters().Select(parameter => parameter.ParameterType));
    }

    private static void AssertCopyConstructor(Assembly baseline, Assembly translated, string typeName, bool isProtected)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        ConstructorInfo baselineCopy = Assert.Single(
            baselineType.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
            ctor => ctor.GetParameters() is [{ ParameterType: var parameterType }] && parameterType == baselineType);
        ConstructorInfo translatedCopy = Assert.Single(
            translatedType.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
            ctor => ctor.GetParameters() is [{ ParameterType: var parameterType }] && parameterType == translatedType);

        Assert.Equal(isProtected, baselineCopy.IsFamily);
        Assert.Equal(isProtected, translatedCopy.IsFamily);
        Assert.Equal(baselineCopy.IsPrivate, translatedCopy.IsPrivate);
    }

    private static void AssertPrintMembersOutput(Assembly baseline, Assembly translated, string typeName)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        var baselineBuilder = new System.Text.StringBuilder();
        var translatedBuilder = new System.Text.StringBuilder();
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        object baselineResult = baselineType.GetMethod("PrintMembers", flags).Invoke(
            Activator.CreateInstance(baselineType, new object[] { 42 }),
            new object[] { baselineBuilder });
        object translatedResult = translatedType.GetMethod("PrintMembers", flags).Invoke(
            Activator.CreateInstance(translatedType, new object[] { 42 }),
            new object[] { translatedBuilder });
        Assert.Equal(baselineResult, translatedResult);
        Assert.Equal(baselineBuilder.ToString(), translatedBuilder.ToString());
    }

    private static void AssertGetOnlyProperty(Assembly baseline, Assembly translated, string typeName, string propertyName, string message = null)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        PropertyInfo baselineProperty = baselineType.GetProperty(propertyName);
        PropertyInfo translatedProperty = translatedType.GetProperty(propertyName);

        Assert.NotNull(baselineProperty);
        Assert.NotNull(translatedProperty);
        Assert.Null(baselineProperty.SetMethod);
        Assert.True(translatedProperty.SetMethod is null, message);
        Assert.Equal(baselineProperty.PropertyType, translatedProperty.PropertyType);
    }

    private static void AssertInitProperty(Assembly baseline, Assembly translated, string typeName, string propertyName)
    {
        Type baselineType = baseline.GetType(typeName, throwOnError: true);
        Type translatedType = translated.GetType(typeName, throwOnError: true);
        MethodInfo baselineSetter = baselineType.GetProperty(propertyName).SetMethod;
        MethodInfo translatedSetter = translatedType.GetProperty(propertyName).SetMethod;

        Assert.NotNull(baselineSetter);
        Assert.NotNull(translatedSetter);
        Assert.Equal(
            baselineSetter.ReturnParameter.GetRequiredCustomModifiers(),
            translatedSetter.ReturnParameter.GetRequiredCustomModifiers());
    }
}
