// <copyright file="Issue4770NullableClassifierCoalescingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable annotations

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;
using Xunit.Abstractions;

namespace Cs2Gs.Tests;

/// <summary>Runs the original params negative control through native and translated CLR code.</summary>
public class Issue4770NullableClassifierCoalescingTests
{
    private readonly ITestOutputHelper output;

    public Issue4770NullableClassifierCoalescingTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void OriginalParamsControl_CompilesVerifiesAndRuns()
    {
        string root = GsharpTestProjectRunner.FindRepoRoot();
        Assert.NotNull(root);
        string testPath = Path.Combine(root, "tools", "cs2gs", "Cs2Gs.Tests", "Issue4612GenericStoreBridgeTests.cs");
        MethodDeclarationSyntax original = Assert.Single(
            CSharpSyntaxTree.ParseText(File.ReadAllText(testPath)).GetRoot()
                .DescendantNodes().OfType<MethodDeclarationSyntax>(),
            method => method.Identifier.ValueText == "ParamsElement_ClassifiesExpandedElementsOnly");
        string source = """
            using System;
            using System.Collections.Generic;
            using System.Linq;
            using Cs2Gs.Translator;
            using Cs2Gs.Translator.Loading;
            using Microsoft.CodeAnalysis;
            using Microsoft.CodeAnalysis.CSharp.Syntax;
            using Microsoft.CodeAnalysis.Operations;
            using Xunit;
            using CSharpToGSharpTranslator = Issue4770.Contracts.CSharpToGSharpTranslator;
            namespace Issue4770;
            public class Probe
            {
            """ + original.WithAttributeLists(default).ToFullString() + "\n}";
        string helper = ExtractClassifier(root);
        this.output.WriteLine("Original test source SHA256=" + Hash(File.ReadAllBytes(testPath)));
        this.Run(source, helper, assembly =>
        {
            Type probe = assembly.GetType("Issue4770.Probe");
            Assert.NotNull(probe);
            MethodInfo run = probe.GetMethod(original.Identifier.ValueText);
            Assert.NotNull(run);
            Assert.Null(run.Invoke(Activator.CreateInstance(probe), null));
        });
    }

    [Theory]
    [InlineData("string kind", "kind", "not-reported")]
    [InlineData("var kind", "kind", "not-reported")]
    [InlineData("string? kind", "kind", "not-reported")]
    [InlineData("string kind", "((kind))", "not-reported")]
    public void ObservedLocal_PreservesNullFallbackAndEvaluationOrder(
        string declaration, string observed, string expected)
    {
        string source = $$"""
            #nullable enable
            using Issue4770.Contracts;
            namespace Issue4770;
            public static class Probe
            {
                public static string Run()
                {
                    {{declaration}} = Classifier.Read();
                    string value = {{observed}} ?? Classifier.Fallback();
                    return value + "|" + Classifier.Calls + "|" + Classifier.Effects;
                }
            }
            """;
        this.Run(source, Controls, assembly =>
            Assert.Equal(expected + "|1|read,fallback", Invoke(assembly, "Run")));
    }

    [Fact]
    public void FixedNonNullContract_RetainsRequiredBridge()
    {
        const string source = """
            #nullable enable
            using Issue4770.Contracts;
            namespace Issue4770;
            public static class Probe
            {
                public static string Run()
                {
                    string value = Classifier.Read();
                    return Classifier.Accept(value);
                }
            }
            """;
        this.Run(source, Controls, assembly =>
        {
            TargetInvocationException exception = Assert.Throws<TargetInvocationException>(() => Invoke(assembly, "Run"));
            Assert.IsType<NullReferenceException>(exception.InnerException);
        }, nativeAssert: assembly => Assert.Null(Invoke(assembly, "Run")));
    }

    [Theory]
    [InlineData(false, "not-reported|1|read,fallback")]
    [InlineData(true, "reported|1|read")]
    public void Coalescing_ObservesNullButDoesNotEvaluateUnusedFallback(bool present, string expected)
    {
        string source = $$"""
            #nullable enable
            using Issue4770.Contracts;
            namespace Issue4770;
            public static class Probe
            {
                public static string Run()
                {
                    Classifier.Value = {{(present ? "\"reported\"" : "null")}};
                    string kind = Classifier.Read();
                    return (kind ?? Classifier.Fallback()) + "|" + Classifier.Calls + "|" + Classifier.Effects;
                }
            }
            """;
        this.Run(source, Controls, assembly => Assert.Equal(expected, Invoke(assembly, "Run")));
    }

    [Theory]
    [InlineData(false, "not-reported|1|read")]
    [InlineData(true, "7|1|read")]
    public void NullableFallbackAndValueTypeCoalescing_PreserveTheirContracts(bool present, string expected)
    {
        string source = $$"""
            #nullable enable
            using Issue4770.Contracts;
            namespace Issue4770;
            public static class Probe
            {
                public static string Run()
                {
                    Classifier.Number = {{(present ? "7" : "null")}};
                    int? number = Classifier.ReadNumber();
                    string? first = null;
                    string? second = null;
                    return (first ?? second ?? (number?.ToString() ?? "not-reported")) + "|" + Classifier.Calls + "|" + Classifier.Effects;
                }
            }
            """;
        this.Run(source, Controls, assembly => Assert.Equal(expected, Invoke(assembly, "Run")));
    }

    [Fact]
    public void DefensiveCoalescing_DoesNotWidenFixedParameterOrMemberContracts()
    {
        string root = GsharpTestProjectRunner.FindRepoRoot();
        string binding = Path.Combine(root, "src", "Core", "CodeAnalysis", "Binding");
        RecordDeclarationSyntax record = Assert.Single(CSharpSyntaxTree.ParseText(
            File.ReadAllText(Path.Combine(binding, "BoundBodyCacheKey.cs"))).GetRoot()
            .DescendantNodes().OfType<RecordDeclarationSyntax>());
        SyntaxNode resolver = CSharpSyntaxTree.ParseText(File.ReadAllText(Path.Combine(
            binding, "OverloadResolution", "OverloadResolver.cs"))).GetRoot();
        DelegateDeclarationSyntax callback = Assert.Single(resolver.DescendantNodes().OfType<DelegateDeclarationSyntax>(),
            declaration => declaration.Identifier.ValueText == "TryGetFunctionLiteralDelegate");
        StatementSyntax assignment = Assert.Single(resolver.DescendantNodes().OfType<ExpressionStatementSyntax>(),
            statement => statement.ToString() == "this.tryGetFunctionLiteral = tryGetFunctionLiteral ?? throw new ArgumentNullException(nameof(tryGetFunctionLiteral));");
        MethodDeclarationSyntax implementation = Assert.Single(CSharpSyntaxTree.ParseText(
            File.ReadAllText(Path.Combine(binding, "LambdaBinder.cs"))).GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>(),
            method => method.Identifier.ValueText == "TryGetFunctionLiteral");
        string source = """
            #nullable enable
            using System;
            using GSharp.Core.CodeAnalysis.Binding;
            namespace Issue4770;
            """ + record.ToFullString() + callback.ToFullString() + """
            public static class Helper
            {
            """ + implementation.ToFullString() + """
            }
            public class Holder
            {
                private readonly TryGetFunctionLiteralDelegate tryGetFunctionLiteral;
                public Holder(TryGetFunctionLiteralDelegate tryGetFunctionLiteral)
                {
            """ + assignment.ToFullString() + """
                }
            }
            public static class Probe
            {
                public static string Run() => "contracts";
            }
            """;
        this.Run(source, Controls, assembly =>
        {
            Assert.Equal("contracts", Invoke(assembly, "Run"));
            Type key = assembly.GetType("Issue4770.BoundBodyCacheKey");
            Assert.NotNull(key);
            ConstructorInfo constructor = Assert.Single(key.GetConstructors(), candidate => candidate.GetParameters().Length == 2);
            var nullability = new NullabilityInfoContext();
            foreach (ParameterInfo parameter in constructor.GetParameters())
            {
                Assert.Equal(NullabilityState.NotNull, nullability.Create(parameter).ReadState);
            }

            foreach (string name in new[] { "StableMemberId", "BodyHash" })
            {
                PropertyInfo property = key.GetProperty(name);
                Assert.NotNull(property);
                Assert.Equal(NullabilityState.NotNull, nullability.Create(property).ReadState);
            }

            Type holder = assembly.GetType("Issue4770.Holder");
            Type callbackType = assembly.GetType("Issue4770.TryGetFunctionLiteralDelegate");
            Assert.NotNull(holder);
            Assert.NotNull(callbackType);
            ConstructorInfo holderConstructor = Assert.Single(holder.GetConstructors());
            ParameterInfo callbackParameter = Assert.Single(holderConstructor.GetParameters());
            Assert.Equal(callbackType, callbackParameter.ParameterType);
            Assert.Equal(NullabilityState.NotNull, nullability.Create(callbackParameter).ReadState);
            MethodInfo method = assembly.GetType("Issue4770.Helper").GetMethod("TryGetFunctionLiteral");
            Assert.NotNull(method);
            Delegate callbackValue = method.CreateDelegate(callbackType);
            Assert.NotNull(holderConstructor.Invoke(new object[] { callbackValue }));
            object?[] arguments = { null, null };
            Assert.Equal(false, callbackValue.DynamicInvoke(arguments));
            Assert.Null(arguments[1]);
            Assert.Equal("member", key.GetProperty("StableMemberId").GetValue(constructor.Invoke(new object[] { "member", "hash" })));
        });
    }

    private const string Controls = """
        #nullable enable
        namespace Issue4770.Contracts;
        public static class Classifier
        {
            public static int Calls;
            public static string Effects = "";
            public static string? Value;
            public static int? Number;
            public static string? Read() { Calls++; Effects += "read"; return Value; }
            public static int? ReadNumber() { Calls++; Effects += "read"; return Number; }
            public static string Fallback() { Effects += ",fallback"; return "not-reported"; }
            public static string Accept(string value) => value;
        }
        """;

    private static object? Invoke(Assembly assembly, string method) =>
        assembly.GetType("Issue4770.Probe").GetMethod(method).Invoke(null, null);

    private static string ExtractClassifier(string root)
    {
        string directory = Path.Combine(root, "tools", "cs2gs", "Cs2Gs.Translator");
        var methods = Directory.EnumerateFiles(directory, "CSharpToGSharpTranslator*.cs")
            .SelectMany(path => CSharpSyntaxTree.ParseText(File.ReadAllText(path)).GetRoot()
                .DescendantNodes().OfType<MethodDeclarationSyntax>()
                .Where(method => method.Modifiers.Any(SyntaxKind.StaticKeyword)))
            .GroupBy(method => method.Identifier.ValueText)
            .ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
        MethodDeclarationSyntax wrapper = Assert.Single(methods["ClassifyParameterSlotForTests"]);
        var pending = new Queue<string>();
        pending.Enqueue("ClassifyParameterSlot");
        var selected = new Dictionary<string, MethodDeclarationSyntax>(StringComparer.Ordinal);
        while (pending.TryDequeue(out string name))
        {
            if (selected.ContainsKey(name))
            {
                continue;
            }

            MethodDeclarationSyntax method = Assert.Single(methods[name]);
            selected.Add(name, method);
            foreach (InvocationExpressionSyntax invocation in method.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (invocation.Expression is IdentifierNameSyntax identifier && methods.ContainsKey(identifier.Identifier.ValueText))
                {
                    pending.Enqueue(identifier.Identifier.ValueText);
                }
            }
        }

        // Only the test accessor becomes public for the imported fixture; the
        // production classifier and its complete static dependency closure are verbatim.
        wrapper = wrapper.WithModifiers(SyntaxFactory.TokenList(
            SyntaxFactory.Token(SyntaxKind.PublicKeyword).WithTrailingTrivia(SyntaxFactory.Space),
            SyntaxFactory.Token(SyntaxKind.StaticKeyword).WithTrailingTrivia(SyntaxFactory.Space)));
        return """
            using System.Collections.Generic;
            using System.Linq;
            using Microsoft.CodeAnalysis;
            using Microsoft.CodeAnalysis.CSharp;
            using Microsoft.CodeAnalysis.CSharp.Syntax;
            namespace Issue4770.Contracts;
            public static class CSharpToGSharpTranslator
            {
            """ + wrapper.ToFullString() + "\nprivate static class DeclarationVisitor {\n"
            + string.Join("\n", selected.Values.Select(method => method.ToFullString())) + "\n}\n}";
    }

    private void Run(string source, string contracts, Action<Assembly> assert, Action<Assembly> nativeAssert = null)
    {
        string directory = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", "issue4770", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string contractsPath = Path.Combine(directory, "Contracts.dll");
            string nativePath = Path.Combine(directory, "Native.dll");
            string translatedPath = Path.Combine(directory, "Translated.dll");
            var extraReferences = new[]
            {
                typeof(CSharpCompilation).Assembly.Location,
                typeof(Compilation).Assembly.Location,
                typeof(CSharpProjectLoader).Assembly.Location,
                typeof(CSharpToGSharpTranslator).Assembly.Location,
                typeof(GSharpPrinter).Assembly.Location,
                typeof(GSharp.Core.CodeAnalysis.Symbols.TypeSymbol).Assembly.Location,
                typeof(Assert).Assembly.Location,
            };
            MetadataReference[] references = Directory.EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll")
                .Concat(extraReferences).Distinct()
                .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path)).ToArray();
            Emit(contractsPath, contracts, references);
            references = references.Append(MetadataReference.CreateFromFile(contractsPath)).ToArray();
            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) }, references, "Native");
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
            using (var image = File.Create(nativePath))
            {
                var emitted = project.Compilation.WithOptions(project.Compilation.Options.WithDeterministic(true)).Emit(image);
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            }

            LoadedDocument document = Assert.Single(project.Documents);
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
            Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
            File.WriteAllText(Path.Combine(directory, "Probe.cs"), source);
            File.WriteAllText(Path.Combine(directory, "Contracts.cs"), contracts);
            string sourcePath = Path.Combine(directory, "Probe.gs");
            File.WriteAllText(sourcePath, printed);
            string compiler = LocalFunctionHoistTranslationTests.FindCompiler();
            Assert.NotNull(compiler);
            var arguments = new List<string> { compiler, "/target:library", "/out:" + translatedPath, "/r:" + contractsPath };
            arguments.AddRange(extraReferences.Select(path => "/r:" + path));
            arguments.Add(sourcePath);
            this.output.WriteLine("gsc: dotnet " + string.Join(" ", arguments));
            ProcessRunResult compiled = ProcessRunner.Run("dotnet", arguments);
            Assert.False(compiled.TimedOut, compiled.Output);
            Assert.True(compiled.ExitCode == 0, compiled.Output + "\n" + printed);
            foreach (string path in new[] { contractsPath, nativePath, translatedPath })
            {
                var verify = new List<string> { "tool", "run", "ilverify", path, "-s", "System.Private.CoreLib" };
                foreach (string reference in Directory.EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll")
                    .Concat(extraReferences).Append(contractsPath).Distinct())
                {
                    verify.Add("-r");
                    verify.Add(reference);
                }

                this.output.WriteLine("STRICT ILVerify: dotnet " + string.Join(" ", verify));
                ProcessRunResult verified = ProcessRunner.Run("dotnet", verify, new IlVerifyRunner().RepoRoot);
                Assert.False(verified.TimedOut, verified.Output);
                Assert.True(verified.ExitCode == 0, verified.Output);
                this.output.WriteLine(Path.GetFileName(path) + " strict ILVerify exit=" + verified.ExitCode + "\n" + verified.Output);
                this.output.WriteLine(Path.GetFileName(path) + " SHA256=" + Hash(File.ReadAllBytes(path)));
            }

            Assembly[] nativePair = EmittedFixture.LoadTogether(contractsPath, nativePath);
            Assembly native = nativePair[1];
            Assembly translated = EmittedFixture.LoadTogether(contractsPath, translatedPath)[1];
            if (nativePair[0].GetType("Issue4770.Contracts.CSharpToGSharpTranslator") is { } classifier)
            {
                MethodInfo wrapper = classifier.GetMethod("ClassifyParameterSlotForTests");
                Assert.NotNull(wrapper);
                Assert.Equal(typeof(string), wrapper.ReturnType);
                Assert.Equal(NullabilityState.Unknown, new NullabilityInfoContext().Create(wrapper.ReturnParameter).ReadState);
                ParameterInfo[] parameters = wrapper.GetParameters();
                Assert.Equal(
                    new[] { typeof(IParameterSymbol), typeof(ExpressionSyntax), typeof(bool), typeof(ITypeSymbol).MakeByRefType(), typeof(bool).MakeByRefType() },
                    parameters.Select(parameter => parameter.ParameterType));
                Assert.True(parameters[3].IsOut);
                Assert.True(parameters[4].IsOut);
            }

            foreach (Assembly assembly in new[] { native, translated })
            {
                Type probe = assembly.GetType("Issue4770.Probe");
                Assert.NotNull(probe);
                MethodInfo method = Assert.Single(probe.GetMethods(BindingFlags.DeclaredOnly | BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance));
                Assert.Empty(method.GetParameters());
                Assert.Equal(source.Contains("public static string Run()", StringComparison.Ordinal) ? typeof(string) : typeof(void), method.ReturnType);
            }

            (nativeAssert ?? assert)(native);
            this.output.WriteLine("Native CLR assertions passed.");
            assert(translated);
            this.output.WriteLine("Translated CLR assertions passed.");
        }
        finally
        {
            string evidence = Environment.GetEnvironmentVariable("GSHARP_ISSUE4770_EVIDENCE");
            if (!string.IsNullOrEmpty(evidence))
            {
                string destination = Path.Combine(evidence, Path.GetFileName(directory));
                Directory.CreateDirectory(destination);
                foreach (string file in Directory.EnumerateFiles(directory))
                {
                    File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), overwrite: true);
                }
            }

            Directory.Delete(directory, recursive: true);
        }
    }

    private static void Emit(string path, string source, MetadataReference[] references)
    {
        CSharpCompilation compilation = CSharpCompilation.Create(
            Path.GetFileNameWithoutExtension(path),
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Preview)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithDeterministic(true));
        using var image = File.Create(path);
        var emitted = compilation.Emit(image);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
}
