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
        let gsTestPath = Path.ChangeExtension(testPath, ".gs")
        Assert.True(
            File.Exists(testPath) || File.Exists(gsTestPath),
            "Expected Issue4612GenericStoreBridgeTests under $root."
        )
        let testSource = if File.Exists(testPath) {
            File.ReadAllText(testPath)
        } else {
            FrozenParamsElementTestSource
        }
        let original = Assert.Single(
            CSharpSyntaxTree.ParseText(testSource).GetRoot().DescendantNodes().OfType[MethodDeclarationSyntax](),
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
        let hashInput = if File.Exists(testPath) {
            File.ReadAllBytes(testPath)
        } else {
            File.ReadAllBytes(gsTestPath)
        }
        this.output.WriteLine("Original test source SHA256=" + Hash(hashInput))
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
        let cacheKeyCs = Path.Combine(binding, "BoundBodyCacheKey.cs")
        let cacheKeyGs = Path.Combine(binding, "Incremental", "BoundBodyCacheKey.gs")
        Assert.True(
            File.Exists(cacheKeyCs) || File.Exists(Path.ChangeExtension(cacheKeyCs, ".gs")) || File.Exists(cacheKeyGs),
            "Expected BoundBodyCacheKey under $binding."
        )
        let cacheKeySource = if File.Exists(cacheKeyCs) {
            File.ReadAllText(cacheKeyCs)
        } else {
            FrozenBoundBodyCacheKeySource
        }
        let resolverCs = Path.Combine(binding, "OverloadResolution", "OverloadResolver.cs")
        let resolverSource = if File.Exists(resolverCs) {
            File.ReadAllText(resolverCs)
        } else {
            FrozenOverloadResolverSource
        }
        let lambdaBinderCs = Path.Combine(binding, "LambdaBinder.cs")
        let lambdaBinderSource = if File.Exists(lambdaBinderCs) {
            File.ReadAllText(lambdaBinderCs)
        } else {
            FrozenLambdaBinderSource
        }
        let record = Assert.Single(
            CSharpSyntaxTree.ParseText(cacheKeySource).GetRoot().DescendantNodes().OfType[RecordDeclarationSyntax]()
        )
        let resolver = CSharpSyntaxTree.ParseText(resolverSource).GetRoot()
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
                .ParseText(lambdaBinderSource)
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
            let csFiles = Directory.EnumerateFiles(directory, "CSharpToGSharpTranslator*.cs").ToArray()
            if csFiles.Length == 0 {
                Assert.NotEmpty(Directory.EnumerateFiles(directory, "CSharpToGSharpTranslator*.gs"))
                return FrozenClassifierContractsSource
            }
            let methods = csFiles
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

        private const FrozenParamsElementTestSource string = `public class FrozenIssue4612 {
    public void ParamsElement_ClassifiesExpandedElementsOnly()
    {
        const string source = @"
            using System;
            using System.Collections.Generic;

            public static class C
            {
                public static List<T> Of<T>(params T[] items) => new List<T>(items);

                public static int Span<T>(params ReadOnlySpan<T> items) => items.Length;

                public static List<string> Explicit(string s) => Of<string>(s, ""y"");

                public static List<string> Inferred(string s) => Of(s, ""y"");

                public static int Collection(string s) => Span(s, ""y"");

                public static List<string> Direct(string[] s) => Of(s);
            }
            ";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        List<ArgumentSyntax> arguments = document.GetRoot().DescendantNodes().OfType<ArgumentSyntax>()
            .Where(argument => argument.Expression.ToString() == "s")
            .ToList();
        Assert.Equal(4, arguments.Count);

        var kinds = new List<string>();
        foreach (ArgumentSyntax argument in arguments)
        {
            bool expanded = document.SemanticModel.GetOperation(argument) is not IArgumentOperation;
            var invocation = (InvocationExpressionSyntax)argument.Parent.Parent;
            var method = (IMethodSymbol)document.SemanticModel.GetSymbolInfo(invocation).Symbol;
            string kind = CSharpToGSharpTranslator.ClassifyParameterSlotForTests(
                method.Parameters[0],
                argument.Expression,
                expanded,
                out ITypeSymbol slotType,
                out bool resultDependsOnSlot);
            kinds.Add((kind ?? "not-reported") + " " + slotType.ToDisplayString() + " " + resultDependsOnSlot);
        }

        Assert.Equal(
            new[]
            {
                "explicit-type-argument,params-element string True",
                "inferred-method-type-parameter,params-element string True",
                "inferred-method-type-parameter,params-element string False",
                "not-reported string[] False",
            },
            kinds);
    }
}`

        private const FrozenBoundBodyCacheKeySource string = `namespace GSharp.Core.CodeAnalysis.Binding;
public readonly record struct BoundBodyCacheKey(string StableMemberId, string BodyHash)
{
    public string StableMemberId { get; } = StableMemberId ?? string.Empty;
    public string BodyHash { get; } = BodyHash ?? string.Empty;
    public override string ToString() => $"{StableMemberId}#{BodyHash}";
}`

        private const FrozenOverloadResolverSource string = `#nullable enable
using System;
namespace GSharp.Core.CodeAnalysis.Binding;
internal sealed partial class OverloadResolver
{
    public delegate bool TryGetFunctionLiteralDelegate(
        BoundExpression expression,
        [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out BoundFunctionLiteralExpression? literal);
    private readonly TryGetFunctionLiteralDelegate tryGetFunctionLiteral;
    public OverloadResolver(TryGetFunctionLiteralDelegate tryGetFunctionLiteral)
    {
        this.tryGetFunctionLiteral = tryGetFunctionLiteral ?? throw new ArgumentNullException(nameof(tryGetFunctionLiteral));
    }
}`

        private const FrozenLambdaBinderSource string = `#nullable enable
namespace GSharp.Core.CodeAnalysis.Binding;
internal sealed partial class LambdaBinder
{
    public static bool TryGetFunctionLiteral(
        BoundExpression expression,
        [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out BoundFunctionLiteralExpression? literal)
    {
        if (expression is BoundFunctionLiteralExpression direct)
        {
            literal = direct;
            return true;
        }
        if (expression is BoundConversionExpression { Expression: BoundFunctionLiteralExpression converted })
        {
            literal = converted;
            return true;
        }
        literal = null;
        return false;
    }
}`

        private const FrozenClassifierContractsSource string = `using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
namespace Issue4770.Contracts;
public static class CSharpToGSharpTranslator
{
    public static string ClassifyParameterSlotForTests(
        IParameterSymbol parameter,
        ExpressionSyntax value,
        bool expandedParams,
        out ITypeSymbol slotType,
        out bool resultDependsOnSlot) =>
        DeclarationVisitor.ClassifyParameterSlot(parameter, value, expandedParams, out slotType, out resultDependsOnSlot);
private static class DeclarationVisitor {
        internal static string ClassifyParameterSlot(
            IParameterSymbol parameter,
            ExpressionSyntax value,
            bool expandedParams,
            out ITypeSymbol slotType,
            out bool resultDependsOnSlot)
        {
            resultDependsOnSlot = false;
            ITypeSymbol declared = parameter.OriginalDefinition.Type;
            slotType = parameter.Type;
            bool paramsElement = false;
            if (expandedParams
                && GetParamsElementType(parameter.OriginalDefinition) is { } declaredElement
                && GetParamsElementType(parameter) is { } constructedElement)
            {
                declared = GetBridgedSlotType(value, declaredElement);
                slotType = constructedElement;
                paramsElement = true;
            }
            slotType = GetBridgedSlotType(value, slotType);
            if (declared is not ITypeParameterSymbol typeParameter)
            {
                return paramsElement ? "params-element" : null;
            }
            IMethodSymbol method = parameter.ContainingSymbol as IMethodSymbol;
            resultDependsOnSlot = CallResultMentionsTypeParameter(method, typeParameter);
            if (method?.MethodKind == MethodKind.DelegateInvoke)
            {
                return "delegate-invoke";
            }
            if (typeParameter.TypeParameterKind == TypeParameterKind.Method)
            {
                string methodKind = ValueFeedsExplicitTypeArguments(value)
                    ? "explicit-type-argument"
                    : "inferred-method-type-parameter";
                return paramsElement ? methodKind + ",params-element" : methodKind;
            }
            return paramsElement ? "constructed-generic-member,params-element" : "constructed-generic-member";
        }
        private static ITypeSymbol GetParamsElementType(IParameterSymbol parameter) =>
            parameter?.IsParams == true
                ? parameter.Type switch
                {
                    IArrayTypeSymbol arrayType => arrayType.ElementType,
                    INamedTypeSymbol { TypeArguments: [ITypeSymbol element] } collection
                        when IsSupportedParamsCollectionType(collection)
                        => element,
                    _ => null,
                }
                : null;
        private static bool IsSupportedParamsCollectionType(ITypeSymbol type)
        {
            if (type is not INamedTypeSymbol { TypeArguments: [ITypeSymbol] } named)
            {
                return false;
            }
            if (named.Name == "List" && named.ContainingNamespace?.ToDisplayString() == "System.Collections.Generic")
            {
                return true;
            }
            if (IsSpanParamsCollectionType(named))
            {
                return true;
            }
            SpecialType specialType = named.OriginalDefinition.SpecialType;
            return specialType == SpecialType.System_Collections_Generic_IEnumerable_T
                || specialType == SpecialType.System_Collections_Generic_ICollection_T
                || specialType == SpecialType.System_Collections_Generic_IList_T
                || specialType == SpecialType.System_Collections_Generic_IReadOnlyList_T
                || specialType == SpecialType.System_Collections_Generic_IReadOnlyCollection_T;
        }
        private static bool IsSpanParamsCollectionType(ITypeSymbol type) =>
            type is INamedTypeSymbol { TypeArguments: [ITypeSymbol] } named
            && named.ContainingNamespace?.ToDisplayString() == "System"
            && named.Name is "Span" or "ReadOnlySpan";
        private static ITypeSymbol GetBridgedSlotType(ExpressionSyntax value, ITypeSymbol slotType)
        {
            if (value == null || slotType is not INamedTypeSymbol)
            {
                return slotType;
            }
            var tupleIndices = new List<int>();
            OutermostTransparentNode(value, tupleIndices);
            return GetTupleSlot(slotType, tupleIndices);
        }
        private static ITypeSymbol GetTupleSlot(ITypeSymbol slotType, List<int> tupleIndices)
        {
            for (int i = tupleIndices.Count - 1; i >= 0; i--)
            {
                if (slotType is INamedTypeSymbol nullable
                    && nullable.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T
                    && nullable.TypeArguments.Length == 1
                    && nullable.TypeArguments[0] is INamedTypeSymbol { IsTupleType: true } underlyingTuple)
                {
                    slotType = underlyingTuple;
                }
                if (slotType is not INamedTypeSymbol { IsTupleType: true } tupleType)
                {
                    return slotType;
                }
                if (tupleIndices[i] >= tupleType.TupleElements.Length)
                {
                    return null;
                }
                slotType = GetEffectiveTupleElementType(tupleType, tupleIndices[i]);
            }
            return slotType;
        }
        private static ITypeSymbol GetEffectiveTupleElementType(INamedTypeSymbol tuple, int index)
        {
            IFieldSymbol element = tuple.TupleElements[index];
            NullableAnnotation annotation =
                element.NullableAnnotation == NullableAnnotation.Annotated
                || element.Type.NullableAnnotation == NullableAnnotation.Annotated
                    ? NullableAnnotation.Annotated
                    : element.NullableAnnotation;
            return element.Type.WithNullableAnnotation(annotation);
        }
        private static SyntaxNode OutermostTransparentNode(
            ExpressionSyntax value,
            List<int> tupleIndices = null,
            List<SyntaxNode> storeNodes = null)
        {
            SyntaxNode node = value;
            while (true)
            {
                SyntaxNode parent = node.Parent;
                switch (parent)
                {
                    case ParenthesizedExpressionSyntax:
                    case CastExpressionSyntax:
                    case CheckedExpressionSyntax:
                    case ConditionalAccessExpressionSyntax:
                    case PostfixUnaryExpressionSyntax forgiving
                        when forgiving.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                        node = parent;
                        break;
                    case BinaryExpressionSyntax binary
                        when binary.IsKind(SyntaxKind.CoalesceExpression)
                            || (binary.IsKind(SyntaxKind.AsExpression) && binary.Left == node):
                        node = parent;
                        break;
                    case AssignmentExpressionSyntax assignment
                        when assignment.Right == node
                            && (assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                                || assignment.IsKind(SyntaxKind.CoalesceAssignmentExpression)):
                        storeNodes?.Add(node);
                        node = parent;
                        break;
                    case ConditionalExpressionSyntax conditional when conditional.Condition != node:
                        node = parent;
                        break;
                    case SwitchExpressionArmSyntax arm when arm.Expression == node:
                        node = arm.Parent;
                        break;
                    case ArgumentSyntax tupleElement when tupleElement.Parent is TupleExpressionSyntax tuple:
                        tupleIndices?.Add(tuple.Arguments.IndexOf(tupleElement));
                        node = tuple;
                        break;
                    default:
                        return node;
                }
            }
        }
        private static bool ValueFeedsExplicitTypeArguments(ExpressionSyntax value) =>
            EnclosingInvocationArgument(value) is { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax invocation } }
            && HasExplicitTypeArguments(invocation.Expression);
        private static ArgumentSyntax EnclosingInvocationArgument(ExpressionSyntax value) =>
            OutermostTransparentNode(value).Parent is ArgumentSyntax { Parent: BaseArgumentListSyntax } argument
                ? argument
                : null;
        private static bool HasExplicitTypeArguments(ExpressionSyntax callee) => callee switch
        {
            GenericNameSyntax => true,
            MemberAccessExpressionSyntax member => HasExplicitTypeArguments(member.Name),
            MemberBindingExpressionSyntax binding => HasExplicitTypeArguments(binding.Name),
            _ => false,
        };
        private static bool CallResultMentionsTypeParameter(IMethodSymbol method, ITypeParameterSymbol typeParameter)
        {
            if (method == null)
            {
                return false;
            }
            IMethodSymbol contract = method.OriginalDefinition;
            return MentionsTypeParameter(
                contract.MethodKind == MethodKind.Constructor ? contract.ContainingType : contract.ReturnType,
                typeParameter);
        }
        private static bool MentionsTypeParameter(ITypeSymbol type, ITypeParameterSymbol typeParameter)
        {
            if (type == null)
            {
                return false;
            }
            if (SymbolEqualityComparer.Default.Equals(type, typeParameter))
            {
                return true;
            }
            if (type is IArrayTypeSymbol array)
            {
                return MentionsTypeParameter(array.ElementType, typeParameter);
            }
            if (type is IPointerTypeSymbol pointer)
            {
                return MentionsTypeParameter(pointer.PointedAtType, typeParameter);
            }
            if (type is IFunctionPointerTypeSymbol functionPointer)
            {
                return MentionsTypeParameter(functionPointer.Signature.ReturnType, typeParameter)
                    || functionPointer.Signature.Parameters.Any(parameter => MentionsTypeParameter(parameter.Type, typeParameter));
            }
            return type is INamedTypeSymbol named
                && (named.TypeArguments.Any(argument => MentionsTypeParameter(argument, typeParameter))
                    || MentionsTypeParameter(named.ContainingType, typeParameter));
        }
}
}`
    }
}
