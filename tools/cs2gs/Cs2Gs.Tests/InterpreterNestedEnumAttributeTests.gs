// <copyright file="InterpreterNestedEnumAttributeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.IO
import System.Linq
import System.Reflection
import System.Security.Cryptography
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Xunit
import Xunit.Abstractions
import GSharp.Core.CodeAnalysis
import System.Collections.Generic

open class InterpreterNestedEnumAttributeTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func ActualInterpreterTheoryDeclarations_PreserveNativeNestedEnumData() {
        let root = GsharpTestProjectRunner.FindRepoRoot()!!
        let tests = Path.Combine(root, "test", "Interpreter.Tests")
        let driverRoot = CSharpSyntaxTree.ParseText(
            File.ReadAllText(Path.Combine(tests, "Issue3010EntryPointDriverMatrixTests.cs"))
        )
            .GetRoot()
        let theoryRoot = CSharpSyntaxTree.ParseText(
            File.ReadAllText(Path.Combine(tests, "Issue2988DeinitInterpreterTests.cs"))
        )
            .GetRoot()
        let driverClass = driverRoot.DescendantNodes().OfType[ClassDeclarationSyntax]().Single()
        let driver = driverClass.Members.OfType[EnumDeclarationSyntax]().Single()
        let theoryClass = theoryRoot.DescendantNodes().OfType[ClassDeclarationSyntax]().Single()
        let theory = theoryClass
            .Members
            .OfType[MethodDeclarationSyntax]()
            .Single(
            (method MethodDeclarationSyntax) -> method.Identifier.ValueText == "InheritedDeinitializersRunOnEveryDriver"
        )
        Assert.Equal(
            3,
            theory
                .AttributeLists
                .SelectMany(
                func (list AttributeListSyntax) IEnumerable[AttributeSyntax] {
                    return list.Attributes
                }
            )
                .Count((attribute AttributeSyntax) -> attribute.Name.ToString() == "InlineData")
        )
        // The real declarations/attributes are unchanged; the finalizer-running
        // body is omitted because this guard exercises metadata discovery only.
        let source = "using Xunit; namespace GSharp.Interpreter.Tests;\n" +
            driverClass
            .WithAttributeLists(default(SyntaxList[AttributeListSyntax]))
            .WithMembers(SyntaxFactory.SingletonList[MemberDeclarationSyntax](driver))
            .ToFullString() +
            theoryClass
            .WithAttributeLists(default(SyntaxList[AttributeListSyntax]))
            .WithMembers(SyntaxFactory.SingletonList[MemberDeclarationSyntax](theory.WithBody(SyntaxFactory.Block())))
            .ToFullString() +
            `
public enum Driver { Decoy = 91 }
`
        let references = Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .Concat([]string{typeof(TheoryAttribute).Assembly.Location, typeof(ITestCase).Assembly.Location})
            .Distinct()
            .ToArray()
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("InterpreterTheory.cs", source)},
            references.Select((path string) -> MetadataReference.CreateFromFile(path)).ToArray()
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        using let nativeImage = MemoryStream()
        let nativeEmit = project.Compilation.Emit(nativeImage)
        Assert.True(nativeEmit.Success, string.Join(Environment.NewLine, nativeEmit.Diagnostics))
        Assert.Equal("0,1,2", ReadTheoryData(EmittedFixture.Load(nativeImage.ToArray())))
        this.output.WriteLine(
            "Roslyn native declaration-slice SHA256: " + Convert.ToHexString(SHA256.HashData(nativeImage.ToArray()))
        )
        this.output.WriteLine("Native theory data: nested Driver(0), Driver(1), Driver(2)")
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(context.Diagnostics, (diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported)
        Assert.Contains(
            "@InlineData(Issue3010EntryPointDriverMatrixTests.Driver(0))",
            printed,
            StringComparison.Ordinal
        )
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "interpreter-enum-attributes",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let input = Path.Combine(directory, "InterpreterTheory.gs")
            let image = Path.Combine(directory, "InterpreterTheory.dll")
            File.WriteAllText(input, printed)
            let arguments = []string{
                LocalFunctionHoistTranslationTests.FindCompiler()!!,
                "/target:library",
                "/out:" + image
            }
                .Concat(references.Select((path string) -> ("/r:" + path)))
                .Append(input)
                .ToArray()
            this.output.WriteLine("gsc: dotnet " + string.Join(" ", arguments))
            let compiled = ProcessRunner.Run("dotnet", arguments)
            this.output.WriteLine(compiled.Output)
            Assert.False(compiled.TimedOut, compiled.Output)
            Assert.True(compiled.ExitCode == 0, compiled.Output)
            let verify = []string{"tool", "run", "ilverify", image, "-s", "System.Private.CoreLib"}.Concat(
                references.SelectMany(
                    func (path string) IEnumerable[string] {
                        return []string{"-r", path}
                    }
                )
            )
                .ToArray()
            let verified = ProcessRunner.Run("dotnet", verify, root)
            this.output.WriteLine("STRICT ILVerify: dotnet " + string.Join(" ", verify))
            this.output.WriteLine(verified.Output)
            Assert.False(verified.TimedOut, verified.Output)
            Assert.True(verified.ExitCode == 0, verified.Output)
            Assert.Equal("0,1,2", ReadTheoryData(EmittedFixture.Load(image)))
            this.output.WriteLine("G# theory data: nested Driver(0), Driver(1), Driver(2)")
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData("class Host", "Host", "Host")
    @InlineData("class Host[T any]", "Host[int32]", "Host`1")
    @InlineData("class Host { class Middle", "Host.Middle", "Middle")
    @InlineData("open class Host", "Child", "Host")
    func NestedEnumConversion_RetainsOwnerAndEvaluatesOnce(declaration string, receiver string, owner string) {
        let source = ("" + "$declaration" + ` {
    enum Kind { First, Second }
}
` + "${(if receiver == "Host.Middle" { "}" } else { string.Empty })}" + `
` + "${(if receiver == "Child" { "class Child : Host {}" } else { string.Empty })}" + `
enum Kind { Decoy = 91 }
class Counter {
    shared {
        var Calls int32 = 0
        func Next() int32 {
            Calls = Calls + 1
            return 1
        }
    }
}
let value = ` + "$receiver" + `.Kind(Counter.Next())
"${value.GetType().DeclaringType!!.Name}:${value}:${Counter.Calls}"`)
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(owner + ":Second:1", result.Value)
    }

    @Theory
    @InlineData("Host.Kind(\"invalid\")", "GS0155", int32(10))
    @InlineData("Host.Kind()", "GS0144", int32(5))
    @InlineData("Host.Kind(1, 2)", "GS0144", int32(5))
    @InlineData("Host.Kind[int32](1)", "GS0148", int32(9))
    func InvalidNestedEnumConversion_ReportsDiagnostic(expression string, diagnostic string, character int32) {
        let result = EmittedOracle.Evaluate("class Host { enum Kind { First } }\n" + expression)
        let rejected = Assert.Single(
            result.Diagnostics,
            (actual GSharp.Core.CodeAnalysis.Diagnostic) -> actual.Id == diagnostic
        )
        Assert.NotNull(rejected.Location.Text)
        Assert.Equal(1, rejected.Location.StartLine)
        Assert.Equal(character, rejected.Location.StartCharacter)
    }

    @Fact
    func NullableNestedEnumConversion_PreservesPresentAndNilValues() {
        let result = EmittedOracle.Evaluate(`class Host { enum Kind { First, Second } }
let present = Host.Kind?(Host.Kind(1))
let missing = Host.Kind?(nil)
"${present!!.ToString()}:${missing == nil}"`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("Second:True", result.Value)
    }

    @Fact
    func NonconstantNestedEnumAttribute_RemainsRejected() {
        let result = EmittedOracle.Evaluate([]string{`import System
class Host { enum Kind { First } }
class ValueAttribute : Attribute { init(value object) {} }
func Next() int32 -> 0
@Value(Host.Kind(Next()))
class Tagged {}`}, EmittedOracleOptions{IsLibrary: true})
        let rejected = Assert.Single(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0202"
        )
        Assert.NotNull(rejected.Location.Text)
        Assert.Equal(4, rejected.Location.StartLine)
        Assert.Equal(7, rejected.Location.StartCharacter)
    }

    shared {
        private func ReadTheoryData(assembly Assembly) string {
            let type Type? = assembly.GetType("GSharp.Interpreter.Tests.Issue2988DeinitInterpreterTests")
            Assert.NotNull(type)
            let method MethodInfo? = type!!.GetMethod("InheritedDeinitializersRunOnEveryDriver")
            Assert.NotNull(method)
            let driver = method!!.GetParameters().Single().ParameterType
            Assert.Equal("GSharp.Interpreter.Tests.Issue3010EntryPointDriverMatrixTests+Driver", driver.FullName)
            let attributes = method!!.GetCustomAttributes[InlineDataAttribute]().ToArray()
            Assert.Equal(3, attributes.Length)
            return string.Join(
                ",",
                attributes.Select(
                    (attribute InlineDataAttribute) -> {
                        let value = Assert.Single(Assert.Single(attribute.GetData(method)!!))
                        Assert.Equal(driver, value.GetType())
                        return Convert.ToInt32(value)
                    }
                )
                    .OrderBy((value int32) -> value)
            )
        }
    }
}
