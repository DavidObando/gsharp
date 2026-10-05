// <copyright file="InterpreterNestedEnumAttributeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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

public class InterpreterNestedEnumAttributeTests
{
    private readonly ITestOutputHelper output;

    public InterpreterNestedEnumAttributeTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void ActualInterpreterTheoryDeclarations_PreserveNativeNestedEnumData()
    {
        string root = GsharpTestProjectRunner.FindRepoRoot();
        string tests = Path.Combine(root, "test", "Interpreter.Tests");
        var driverRoot = CSharpSyntaxTree.ParseText(File.ReadAllText(
            Path.Combine(tests, "Issue3010EntryPointDriverMatrixTests.cs"))).GetRoot();
        var theoryRoot = CSharpSyntaxTree.ParseText(File.ReadAllText(
            Path.Combine(tests, "Issue2988DeinitInterpreterTests.cs"))).GetRoot();
        ClassDeclarationSyntax driverClass = driverRoot.DescendantNodes().OfType<ClassDeclarationSyntax>().Single();
        EnumDeclarationSyntax driver = driverClass.Members.OfType<EnumDeclarationSyntax>().Single();
        ClassDeclarationSyntax theoryClass = theoryRoot.DescendantNodes().OfType<ClassDeclarationSyntax>().Single();
        MethodDeclarationSyntax theory = theoryClass.Members.OfType<MethodDeclarationSyntax>()
            .Single(method => method.Identifier.ValueText == "InheritedDeinitializersRunOnEveryDriver");
        Assert.Equal(3, theory.AttributeLists.SelectMany(list => list.Attributes)
            .Count(attribute => attribute.Name.ToString() == "InlineData"));

        // The real declarations/attributes are unchanged; the finalizer-running
        // body is omitted because this guard exercises metadata discovery only.
        string source = "using Xunit; namespace GSharp.Interpreter.Tests;\n"
            + driverClass.WithAttributeLists(default)
                .WithMembers(SyntaxFactory.SingletonList<MemberDeclarationSyntax>(driver)).ToFullString()
            + theoryClass.WithAttributeLists(default)
                .WithMembers(SyntaxFactory.SingletonList<MemberDeclarationSyntax>(
                    theory.WithBody(SyntaxFactory.Block()))).ToFullString()
            + "\npublic enum Driver { Decoy = 91 }\n";
        string[] references = Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll")
            .Concat(new[] { typeof(TheoryAttribute).Assembly.Location, typeof(Xunit.Abstractions.ITestCase).Assembly.Location })
            .Distinct().ToArray();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("InterpreterTheory.cs", source) }, references.Select(path => MetadataReference.CreateFromFile(path)).ToArray());
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        using var nativeImage = new MemoryStream();
        var nativeEmit = project.Compilation.Emit(nativeImage);
        Assert.True(nativeEmit.Success, string.Join(Environment.NewLine, nativeEmit.Diagnostics));
        Assert.Equal("0,1,2", ReadTheoryData(EmittedFixture.Load(nativeImage.ToArray())));
        this.output.WriteLine("Roslyn native declaration-slice SHA256: " + Convert.ToHexString(SHA256.HashData(nativeImage.ToArray())));
        this.output.WriteLine("Native theory data: nested Driver(0), Driver(1), Driver(2)");

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.IsUnsupported);
        Assert.Contains("@InlineData(Issue3010EntryPointDriverMatrixTests.Driver(0))", printed, StringComparison.Ordinal);
        string directory = Path.Combine(AppContext.BaseDirectory, "interpreter-enum-attributes", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string input = Path.Combine(directory, "InterpreterTheory.gs");
            string image = Path.Combine(directory, "InterpreterTheory.dll");
            File.WriteAllText(input, printed);
            string[] arguments = new[] {
                LocalFunctionHoistTranslationTests.FindCompiler(), "/target:library", "/out:" + image,
            }.Concat(references.Select(path => "/r:" + path)).Append(input).ToArray();
            this.output.WriteLine("gsc: dotnet " + string.Join(" ", arguments));
            ProcessRunResult compiled = ProcessRunner.Run("dotnet", arguments);
            this.output.WriteLine(compiled.Output);
            Assert.False(compiled.TimedOut, compiled.Output);
            Assert.True(compiled.ExitCode == 0, compiled.Output);
            string[] verify = new[] { "tool", "run", "ilverify", image, "-s", "System.Private.CoreLib" }
                .Concat(references.SelectMany(path => new[] { "-r", path })).ToArray();
            ProcessRunResult verified = ProcessRunner.Run("dotnet", verify, root);
            this.output.WriteLine("STRICT ILVerify: dotnet " + string.Join(" ", verify));
            this.output.WriteLine(verified.Output);
            Assert.False(verified.TimedOut, verified.Output);
            Assert.True(verified.ExitCode == 0, verified.Output);
            Assert.Equal("0,1,2", ReadTheoryData(EmittedFixture.Load(image)));
            this.output.WriteLine("G# theory data: nested Driver(0), Driver(1), Driver(2)");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("class Host", "Host", "Host")]
    [InlineData("class Host[T any]", "Host[int32]", "Host`1")]
    [InlineData("class Host { class Middle", "Host.Middle", "Middle")]
    [InlineData("open class Host", "Child", "Host")]
    public void NestedEnumConversion_RetainsOwnerAndEvaluatesOnce(string declaration, string receiver, string owner)
    {
        string source = $$"""
            {{declaration}} {
                enum Kind { First, Second }
            }
            {{(receiver == "Host.Middle" ? "}" : string.Empty)}}
            {{(receiver == "Child" ? "class Child : Host {}" : string.Empty)}}
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
            let value = {{receiver}}.Kind(Counter.Next())
            "${value.GetType().DeclaringType!!.Name}:${value}:${Counter.Calls}"
            """;
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(owner + ":Second:1", result.Value);
    }

    [Theory]
    [InlineData("Host.Kind(\"invalid\")", "GS0155", 10)]
    [InlineData("Host.Kind()", "GS0144", 5)]
    [InlineData("Host.Kind(1, 2)", "GS0144", 5)]
    [InlineData("Host.Kind[int32](1)", "GS0148", 9)]
    public void InvalidNestedEnumConversion_ReportsDiagnostic(string expression, string diagnostic, int character)
    {
        var result = EmittedOracle.Evaluate("class Host { enum Kind { First } }\n" + expression);
        var rejected = Assert.Single(result.Diagnostics, actual => actual.Id == diagnostic);
        Assert.NotNull(rejected.Location.Text);
        Assert.Equal(1, rejected.Location.StartLine);
        Assert.Equal(character, rejected.Location.StartCharacter);
    }

    [Fact]
    public void NullableNestedEnumConversion_PreservesPresentAndNilValues()
    {
        var result = EmittedOracle.Evaluate("""
            class Host { enum Kind { First, Second } }
            let present = Host.Kind?(Host.Kind(1))
            let missing = Host.Kind?(nil)
            "${present!!.ToString()}:${missing == nil}"
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal("Second:True", result.Value);
    }

    [Fact]
    public void NonconstantNestedEnumAttribute_RemainsRejected()
    {
        var result = EmittedOracle.Evaluate(new[] { """
            import System
            class Host { enum Kind { First } }
            class ValueAttribute : Attribute { init(value object) {} }
            func Next() int32 -> 0
            @Value(Host.Kind(Next()))
            class Tagged {}
            """ }, new EmittedOracleOptions { IsLibrary = true });
        var rejected = Assert.Single(result.Diagnostics, diagnostic => diagnostic.Id == "GS0202");
        Assert.NotNull(rejected.Location.Text);
        Assert.Equal(4, rejected.Location.StartLine);
        Assert.Equal(7, rejected.Location.StartCharacter);
    }

    private static string ReadTheoryData(Assembly assembly)
    {
        Type type = assembly.GetType("GSharp.Interpreter.Tests.Issue2988DeinitInterpreterTests");
        Assert.NotNull(type);
        MethodInfo method = type.GetMethod("InheritedDeinitializersRunOnEveryDriver");
        Assert.NotNull(method);
        Type driver = method.GetParameters().Single().ParameterType;
        Assert.Equal("GSharp.Interpreter.Tests.Issue3010EntryPointDriverMatrixTests+Driver", driver.FullName);
        InlineDataAttribute[] attributes = method.GetCustomAttributes<InlineDataAttribute>().ToArray();
        Assert.Equal(3, attributes.Length);
        return string.Join(",", attributes.Select(attribute =>
        {
            object value = Assert.Single(Assert.Single(attribute.GetData(method)));
            Assert.Equal(driver, value.GetType());
            return Convert.ToInt32(value);
        }).OrderBy(value => value));
    }
}
