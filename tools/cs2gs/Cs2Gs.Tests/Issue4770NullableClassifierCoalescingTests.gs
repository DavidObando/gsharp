// <copyright file="Issue4770NullableClassifierCoalescingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Security.Cryptography
import Xunit
import Xunit.Abstractions

/// Runs the original params negative control through native and translated CLR code.
open class Issue4770NullableClassifierCoalescingTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func OriginalParamsControl_CompilesVerifiesAndRuns() {
        let root = GsharpTestProjectRunner.FindRepoRoot()!!
        Assert.NotNull(root)
        let testPath = Path.Combine(root, "tools", "cs2gs", "Cs2Gs.Tests", "Issue4612GenericStoreBridgeTests.cs")
        let original = Assert.Single(
            CSharpSyntaxTree
                .ParseText(File.ReadAllText(testPath))
                .GetRoot()
                .DescendantNodes()
                .OfType[MethodDeclarationSyntax](),
            (method MethodDeclarationSyntax) -> method
                .Identifier
                .ValueText == "ParamsElement_ClassifiesExpandedElementsOnly"
        )
        let source = `using System;
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
{` + original.WithAttributeLists(default(SyntaxList[AttributeListSyntax])).ToFullString() + "\n}"
        let helper = ExtractClassifier(root)
        this.output.WriteLine("Original test source SHA256=" + Hash(File.ReadAllBytes(testPath)))
        this.Run(
            source,
            helper,
            (assembly Assembly) -> {
                let probe = assembly.GetType("Issue4770.Probe")
                Assert.NotNull(probe)
                let run = probe!!.GetMethod(original.Identifier.ValueText)
                Assert.NotNull(run)
                Assert.Null(run!!.Invoke(Activator.CreateInstance(probe!!), nil))
            }
        )
    }

    @Theory
    @InlineData("string kind", "kind", "not-reported")
    @InlineData("var kind", "kind", "not-reported")
    @InlineData("string? kind", "kind", "not-reported")
    @InlineData("string kind", "((kind))", "not-reported")
    func ObservedLocal_PreservesNullFallbackAndEvaluationOrder(declaration string, observed string, expected string) {
        let source = (`#nullable enable
using Issue4770.Contracts;
namespace Issue4770;
public static class Probe
{
    public static string Run()
    {
        ` + "$declaration" + ` = Classifier.Read();
        string value = ` + "$observed" + ` ?? Classifier.Fallback();
        return value + "|" + Classifier.Calls + "|" + Classifier.Effects;
    }
}`)
        this.Run(
            source,
            Controls,
            (assembly Assembly) -> Assert.Equal(expected + "|1|read,fallback", Invoke(assembly, "Run"))
        )
    }

    @Fact
    func FixedNonNullContract_RetainsRequiredBridge() {
        const source = `#nullable enable
using Issue4770.Contracts;
namespace Issue4770;
public static class Probe
{
    public static string Run()
    {
        string value = Classifier.Read();
        return Classifier.Accept(value);
    }
}`
        this.Run(
            source,
            Controls,
            (assembly Assembly) -> {
                let exception = Assert.Throws[TargetInvocationException](
                    func () object? {
                        return Invoke(assembly, "Run")
                    }
                )
                Assert.IsType[NullReferenceException](exception.InnerException)
            },
            nativeAssert: (assembly Assembly) -> Assert.Null(Invoke(assembly, "Run"))
        )
    }

    @Theory
    @InlineData(false, "not-reported|1|read,fallback")
    @InlineData(true, "reported|1|read")
    func Coalescing_ObservesNullButDoesNotEvaluateUnusedFallback(present bool, expected string) {
        let source = (`#nullable enable
using Issue4770.Contracts;
namespace Issue4770;
public static class Probe
{
    public static string Run()
    {
        Classifier.Value = ` + "${(if present { "\"reported\"" } else { "null" })}" + `;
        string kind = Classifier.Read();
        return (kind ?? Classifier.Fallback()) + "|" + Classifier.Calls + "|" + Classifier.Effects;
    }
}`)
        this.Run(source, Controls, (assembly Assembly) -> Assert.Equal(expected, Invoke(assembly, "Run")))
    }

    @Theory
    @InlineData(false, "not-reported|1|read")
    @InlineData(true, "7|1|read")
    func NullableFallbackAndValueTypeCoalescing_PreserveTheirContracts(present bool, expected string) {
        let source = (`#nullable enable
using Issue4770.Contracts;
namespace Issue4770;
public static class Probe
{
    public static string Run()
    {
        Classifier.Number = ` + "${(if present { "7" } else { "null" })}" + `;
        int? number = Classifier.ReadNumber();
        string? first = null;
        string? second = null;
        return (first ?? second ?? (number?.ToString() ?? "not-reported")) + "|" + Classifier.Calls + "|" + Classifier.Effects;
    }
}`)
        this.Run(source, Controls, (assembly Assembly) -> Assert.Equal(expected, Invoke(assembly, "Run")))
    }

    @Fact
    func DefensiveCoalescing_DoesNotWidenFixedParameterOrMemberContracts() {
        let root = GsharpTestProjectRunner.FindRepoRoot()!!
        let binding = Path.Combine(root, "src", "Core", "CodeAnalysis", "Binding")
        let record = Assert.Single(
            CSharpSyntaxTree
                .ParseText(File.ReadAllText(Path.Combine(binding, "BoundBodyCacheKey.cs")))
                .GetRoot()
                .DescendantNodes()
                .OfType[RecordDeclarationSyntax]()
        )
        let resolver = CSharpSyntaxTree.ParseText(
            File.ReadAllText(Path.Combine(binding, "OverloadResolution", "OverloadResolver.cs"))
        )
            .GetRoot()
        let callback = Assert.Single(
            resolver.DescendantNodes().OfType[DelegateDeclarationSyntax](),
            (declaration DelegateDeclarationSyntax) -> declaration
                .Identifier
                .ValueText == "TryGetFunctionLiteralDelegate"
        )
        let assignment StatementSyntax = Assert.Single(
            resolver.DescendantNodes().OfType[ExpressionStatementSyntax](),
            (
                statement ExpressionStatementSyntax
            ) -> statement.ToString() == "this.tryGetFunctionLiteral = tryGetFunctionLiteral ?? throw new ArgumentNullException(nameof(tryGetFunctionLiteral));"
        )
        let implementation = Assert.Single(
            CSharpSyntaxTree
                .ParseText(File.ReadAllText(Path.Combine(binding, "LambdaBinder.cs")))
                .GetRoot()
                .DescendantNodes()
                .OfType[MethodDeclarationSyntax](),
            (method MethodDeclarationSyntax) -> method.Identifier.ValueText == "TryGetFunctionLiteral"
        )
        let source = `#nullable enable
using System;
using GSharp.Core.CodeAnalysis.Binding;
namespace Issue4770;` + record.ToFullString() + callback.ToFullString() +
            "public static class Helper\n{" +
            implementation.ToFullString() + `}
public class Holder
{
    private readonly TryGetFunctionLiteralDelegate tryGetFunctionLiteral;
    public Holder(TryGetFunctionLiteralDelegate tryGetFunctionLiteral)
    {` + assignment.ToFullString() + `    }
}
public static class Probe
{
    public static string Run() => "contracts";
}`
        this.Run(
            source,
            Controls,
            (assembly Assembly) -> {
                Assert.Equal("contracts", Invoke(assembly, "Run"))
                let key = assembly.GetType("Issue4770.BoundBodyCacheKey")
                Assert.NotNull(key)
                let constructor = Assert.Single(
                    key!!.GetConstructors(),
                    (candidate ConstructorInfo) -> candidate.GetParameters().Length == 2
                )
                let nullability = NullabilityInfoContext()
                for parameter in constructor.GetParameters() {
                    Assert.Equal(NullabilityState.NotNull, nullability.Create(parameter).ReadState)
                }
                for name in[]string{"StableMemberId", "BodyHash"} {
                    let property = key!!.GetProperty(name)
                    Assert.NotNull(property)
                    Assert.Equal(NullabilityState.NotNull, nullability.Create(property!!).ReadState)
                }
                let holder = assembly.GetType("Issue4770.Holder")
                let callbackType = assembly.GetType("Issue4770.TryGetFunctionLiteralDelegate")
                Assert.NotNull(holder)
                Assert.NotNull(callbackType)
                let holderConstructor = Assert.Single(holder!!.GetConstructors())
                let callbackParameter = Assert.Single(holderConstructor.GetParameters())
                Assert.Equal(callbackType, callbackParameter.ParameterType)
                Assert.Equal(NullabilityState.NotNull, nullability.Create(callbackParameter).ReadState)
                let method = assembly.GetType("Issue4770.Helper")!!.GetMethod("TryGetFunctionLiteral")
                Assert.NotNull(method)
                let callbackValue = method!!.CreateDelegate(callbackType!!)
                Assert.NotNull(holderConstructor.Invoke([]object{callbackValue}))
                let arguments[]object? = []object? {nil, nil}
                Assert.Equal(false, callbackValue.DynamicInvoke(arguments))
                Assert.Null(arguments[1])
                Assert.Equal(
                    "member",
                    key!!.GetProperty("StableMemberId")!!.GetValue(constructor.Invoke([]object{"member", "hash"}))
                )
            }
        )
    }

    private func Run(
        source string,
        contracts string,
        assert(Assembly) -> void,
        nativeAssert((Assembly) -> void)? = nil
    ) {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "pipeline-tests",
            "issue4770",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let contractsPath = Path.Combine(directory, "Contracts.dll")
            let nativePath = Path.Combine(directory, "Native.dll")
            let translatedPath = Path.Combine(directory, "Translated.dll")
            let extraReferences = []string{
                typeof(CSharpCompilation).Assembly.Location,
                typeof(Compilation).Assembly.Location,
                typeof(CSharpProjectLoader).Assembly.Location,
                typeof(CSharpToGSharpTranslator).Assembly.Location,
                typeof(GSharpPrinter).Assembly.Location,
                typeof(TypeSymbol).Assembly.Location,
                typeof(Assert).Assembly.Location
            }
            var references = Directory
                .EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
                .Concat(extraReferences)
                .Distinct()
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .ToArray()
            Emit(contractsPath, contracts, references)
            references = references.Append(MetadataReference.CreateFromFile(contractsPath)).ToArray()
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Probe.cs", source)},
                references,
                "Native"
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            {
                using let image = File.Create(nativePath)
                let emitted = project
                    .Compilation
                    .WithOptions(project.Compilation.Options.WithDeterministic(true))
                    .Emit(image)
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            }
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            File.WriteAllText(Path.Combine(directory, "Probe.cs"), source)
            File.WriteAllText(Path.Combine(directory, "Contracts.cs"), contracts)
            let sourcePath = Path.Combine(directory, "Probe.gs")
            File.WriteAllText(sourcePath, printed)
            let compiler = LocalFunctionHoistTranslationTests.FindCompiler()
            Assert.NotNull(compiler)
            let arguments = List[string]{compiler!!, "/target:library", "/out:" + translatedPath, "/r:" + contractsPath}
            arguments.AddRange(extraReferences.Select((path string) -> ("/r:" + path)))
            arguments.Add(sourcePath)
            this.output.WriteLine("gsc: dotnet " + string.Join(" ", arguments))
            let compiled = ProcessRunner.Run("dotnet", arguments)
            Assert.False(compiled.TimedOut, compiled.Output)
            Assert.True(compiled.ExitCode == 0, compiled.Output + "\n" + printed)
            for path in[]string{contractsPath, nativePath, translatedPath} {
                let verify = List[string]{"tool", "run", "ilverify", path, "-s", "System.Private.CoreLib"}
                for reference in Directory
                    .EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
                    .Concat(extraReferences)
                    .Append(contractsPath)
                    .Distinct() {
                    verify.Add("-r")
                    verify.Add(reference)
                }
                this.output.WriteLine("STRICT ILVerify: dotnet " + string.Join(" ", verify))
                let verified = ProcessRunner.Run("dotnet", verify, IlVerifyRunner().RepoRoot)
                Assert.False(verified.TimedOut, verified.Output)
                Assert.True(verified.ExitCode == 0, verified.Output)
                this.output.WriteLine(
                    Path.GetFileName(path) + " strict ILVerify exit=" + verified.ExitCode.ToString() +
                        "\n" +
                        verified.Output
                )
                this.output.WriteLine(Path.GetFileName(path) + " SHA256=" + Hash(File.ReadAllBytes(path)))
            }
            let nativePair = EmittedFixture.LoadTogether(contractsPath, nativePath)
            let native = nativePair[1]
            let translated = EmittedFixture.LoadTogether(contractsPath, translatedPath)[1]
            if nativePair[0].GetType("Issue4770.Contracts.CSharpToGSharpTranslator") is {} classifier {
                let wrapper = classifier.GetMethod("ClassifyParameterSlotForTests")
                Assert.NotNull(wrapper)
                Assert.Equal(typeof(string), wrapper!!.ReturnType)
                Assert.Equal(
                    NullabilityState.Unknown,
                    NullabilityInfoContext().Create(wrapper!!.ReturnParameter).ReadState
                )
                let parameters = wrapper!!.GetParameters()
                Assert.Equal(
                    []Type{
                        typeof(IParameterSymbol),
                        typeof(ExpressionSyntax),
                        typeof(bool),
                        typeof(ITypeSymbol).MakeByRefType(),
                        typeof(bool).MakeByRefType()
                    },
                    parameters.Select((parameter ParameterInfo) -> parameter.ParameterType)
                )
                Assert.True(parameters[3].IsOut)
                Assert.True(parameters[4].IsOut)
            }
            for assembly in[]Assembly{native, translated} {
                let probe = assembly.GetType("Issue4770.Probe")!!
                Assert.NotNull(probe)
                let method = Assert.Single(
                    probe.GetMethods(
                        BindingFlags.DeclaredOnly | BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance
                    )
                )
                Assert.Empty(method.GetParameters())
                Assert.Equal(
                    if source.Contains("public static string Run()", StringComparison.Ordinal) {
                        typeof(string)
                    } else {
                        typeof(Void)
                    },
                    method.ReturnType
                )
            }
            (nativeAssert ?? assert)(native)
            this.output.WriteLine("Native CLR assertions passed.")
            assert(translated)
            this.output.WriteLine("Translated CLR assertions passed.")
        } finally {
            let evidence = Environment.GetEnvironmentVariable("GSHARP_ISSUE4770_EVIDENCE")
            if !string.IsNullOrEmpty(evidence) {
                let destination = Path.Combine(evidence, Path.GetFileName(directory))
                Directory.CreateDirectory(destination)
                for file in Directory.EnumerateFiles(directory) {
                    File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), overwrite: true)
                }
            }
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private const Controls string = `#nullable enable
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
}`

        private func Invoke(assembly Assembly, method string) object? -> assembly.GetType(
            "Issue4770.Probe"
        )!!.GetMethod(method)!!.Invoke(nil, nil)

        private func ExtractClassifier(root string) string {
            let directory = Path.Combine(root, "tools", "cs2gs", "Cs2Gs.Translator")
            let methods = Directory
                .EnumerateFiles(directory, "CSharpToGSharpTranslator*.cs")
                .SelectMany(
                func (path string) IEnumerable[MethodDeclarationSyntax] {
                    return CSharpSyntaxTree
                        .ParseText(File.ReadAllText(path))
                        .GetRoot()
                        .DescendantNodes()
                        .OfType[MethodDeclarationSyntax]()
                        .Where((method MethodDeclarationSyntax) -> method.Modifiers.Any(SyntaxKind.StaticKeyword))
                }
            )
                .GroupBy((method MethodDeclarationSyntax) -> method.Identifier.ValueText)
                .ToDictionary(
                func (group IGrouping[string, MethodDeclarationSyntax]) string {
                    return group.Key
                },
                (group IGrouping[string, MethodDeclarationSyntax]) -> group.ToArray(),
                StringComparer.Ordinal
            )
            var wrapper = Assert.Single(methods["ClassifyParameterSlotForTests"])
            let pending = Queue[string]()
            pending.Enqueue("ClassifyParameterSlot")
            let selected = Dictionary[string, MethodDeclarationSyntax](StringComparer.Ordinal)
            while pending.TryDequeue(out var name) {
                if selected.ContainsKey(name) {
                    continue
                }
                let method = Assert.Single(methods[name])
                selected.Add(name, method)
                for invocation in method.DescendantNodes().OfType[InvocationExpressionSyntax]() {
                    if invocation.Expression is IdentifierNameSyntax identifier && methods.ContainsKey(
                        identifier.Identifier.ValueText
                    ) {
                        pending.Enqueue(identifier.Identifier.ValueText)
                    }
                }
            }
            // Only the test accessor becomes public for the imported fixture; the
            // production classifier and its complete static dependency closure are verbatim.
            wrapper = wrapper.WithModifiers(
                SyntaxFactory.TokenList(
                    SyntaxFactory.Token(SyntaxKind.PublicKeyword).WithTrailingTrivia(SyntaxFactory.Space),
                    SyntaxFactory.Token(SyntaxKind.StaticKeyword).WithTrailingTrivia(SyntaxFactory.Space)
                )
            )
            return `using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
namespace Issue4770.Contracts;
public static class CSharpToGSharpTranslator
{` + wrapper.ToFullString() + `
private static class DeclarationVisitor {
` + string.Join("\n", selected.Values.Select((method MethodDeclarationSyntax) -> method.ToFullString())) + `
}
}`
        }

        private func Emit(path string, source string, references[]MetadataReference) {
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(path),
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Preview))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithDeterministic(true)
            )
            using let image = File.Create(path)
            let emitted = compilation.Emit(image)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        }

        private func Hash(bytes[]uint8) string -> Convert.ToHexString(SHA256.HashData(bytes))
    }
}
