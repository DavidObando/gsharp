// <copyright file="Issue6023UnreadableConstraintSpecialFlagTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

open class Issue6023UnreadableConstraintSpecialFlagTests {
    @Theory
    @InlineData("Api.Class(42)", "GS0159", "(4,9,4,18)")
    @InlineData("Api.Struct(\"x\")", "GS0159", "(4,9,4,20)")
    @InlineData("Api.New(\"x\")", "GS0159", "(4,9,4,17)")
    @InlineData("ClassBound[int32]()", "GS0152", "(4,5,4,15)")
    @InlineData("StructBound[string]()", "GS0152", "(4,5,4,16)")
    @InlineData("NewBound[string]()", "GS0152", "(4,5,4,13)")
    func Driver_RejectsKnownSpecialFlags_WhenTheTypeBoundCannotLoad(
        expression string,
        diagnosticId string,
        span string
    ) {
        using let dependency = CSharpFixture(DependencySource, assemblyName: "Constraint6023.B")
        using let library = Library(dependency)
        let references = RuntimeReferences().Concat([]string{library.AssemblyPath}).ToArray()
        let result = Compile(library.DirectoryPath, expression, references)
        Assert.True(result.ExitCode != 0, result.Output)
        Assert.Contains("Consumer.gs(1,1,1,1): warning GS9100:", result.Output)
        Assert.True(
            result.Output.Contains("Consumer.gs$span: error $diagnosticId:", StringComparison.Ordinal),
            result.Output
        )
        Assert.Equal(1, result.Output.Split(": error ", StringSplitOptions.None).Length - 1)
        Assert.False(File.Exists(result.AssemblyPath), result.Output)
    }

    @Theory
    @InlineData("Class", "System.Int32")
    @InlineData("Struct", "System.String")
    @InlineData("New", "System.String")
    func SingleParameterEntryPoints_RejectKnownSpecialFlags_WhenTheTypeBoundCannotLoad(
        methodName string,
        argumentName string
    ) {
        using let dependency = CSharpFixture(DependencySource, assemblyName: "Constraint6023.B")
        using let library = Library(dependency)
        let paths = RuntimeReferences().Concat([]string{library.AssemblyPath}).ToArray()
        using let context = MetadataLoadContext(PathAssemblyResolver(paths), coreAssemblyName: "System.Private.CoreLib")
        let assembly = context.LoadFromAssemblyPath(library.AssemblyPath)
        let api = assembly.GetType("Constraint6023.Api")!!
        let parameter = api.GetMethod(methodName)!!.GetGenericArguments()[0]
        let argument = context.LoadFromAssemblyName("System.Private.CoreLib").GetType(argumentName)!!
        let symbol = if argumentName == "System.Int32" {
            TypeSymbol.Int32
        } else {
            TypeSymbol.String
        }
        Assert.Throws[FileNotFoundException](
            () -> {
                parameter.GetGenericParameterConstraints()
            }
        )
        Assert.False(ClrOverloadResolution.SatisfiesTypeParameterConstraints(parameter, argument))
        Assert.False(ClrOverloadResolution.SatisfiesSingleGenericParameterConstraints(parameter, argument, symbol))
    }

    @Fact
    func Driver_DistinguishesSatisfyingBounds_FromAnUnderReferencedSpecialViolation() {
        using let dependency = CSharpFixture(DependencySource, assemblyName: "Constraint6023.B")
        using let library = Library(dependency)
        let references = RuntimeReferences().Concat([]string{library.AssemblyPath, dependency.AssemblyPath}).ToArray()
        let result = Compile(library.DirectoryPath, `Api.Class(Good())
    Api.Struct(GoodStruct())
    Api.New(Good())
    Api.Class[Good](Good())
    Api.Struct[GoodStruct](GoodStruct())
    Api.New[Good](Good())
    ClassBound[Good]()
    StructBound[GoodStruct]()
    NewBound[Good]()`, references)
        Assert.True(result.ExitCode == 0, result.Output)
        Assert.DoesNotContain("GS9100", result.Output)
        Assert.True(File.Exists(result.AssemblyPath), result.Output)
        IlVerifier.Verify(result.AssemblyPath, references)
        let incomplete = RuntimeReferences().Concat([]string{library.AssemblyPath}).ToArray()
        let explicitCalls = []string{"Api.Class[int32](42)", "Api.Struct[string](\"x\")", "Api.New[string](\"x\")"}
        let explicitSpans = []string{"(4,9,4,25)", "(4,9,4,28)", "(4,9,4,25)"}
        for var i = 0; i < explicitCalls.Length; i++ {
            let explicitResult = Compile(library.DirectoryPath, explicitCalls[i], incomplete)
            Assert.True(explicitResult.ExitCode != 0, explicitResult.Output)
            Assert.Contains("Consumer.gs${explicitSpans[i]}: error GS0159:", explicitResult.Output)
            Assert.False(File.Exists(explicitResult.AssemblyPath), explicitResult.Output)
        }
        let rejected = Compile(library.DirectoryPath, "Api.Class(42)", incomplete)
        Assert.True(rejected.ExitCode != 0, rejected.Output)
        Assert.Contains("Consumer.gs(4,9,4,18): error GS0159:", rejected.Output)
        Assert.False(File.Exists(rejected.AssemblyPath), rejected.Output)
    }

    shared {
        private const DependencySource string = `namespace Constraint6023
{
    public interface IFoo { }
    public sealed class Good : IFoo { }
    public struct GoodStruct : IFoo { }
}`

        private const LibrarySource string = `namespace Constraint6023
{
    public static class Api
    {
        public static void Class<T>(T x) where T : class, IFoo { }
        public static void Struct<T>(T x) where T : struct, IFoo { }
        public static void New<T>(T x) where T : IFoo, new() { }
    }
    public class ClassBound<T> where T : class, IFoo { }
    public class StructBound<T> where T : struct, IFoo { }
    public class NewBound<T> where T : IFoo, new() { }
}`

        private func Library(dependency CSharpFixture) CSharpFixture -> CSharpFixture(
            LibrarySource,
            []MetadataReference{MetadataReference.CreateFromFile(dependency.AssemblyPath)},
            assemblyName: "Constraint6023.A"
        )

        private func RuntimeReferences()[]string {
            let directory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let paths = Directory
                .GetFiles(directory, "*.dll")
                .OrderBy((path string) -> path, StringComparer.Ordinal)
                .ToArray()
            Assert.NotEmpty(paths)
            return paths
        }

        private func Compile(directory string, expression string, references[]string)(
            ExitCode int32,
            Output string,
            AssemblyPath string
        ) {
            let source = Path.Combine(directory, "Consumer.gs")
            let assembly = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".dll")
            File.WriteAllText(source, "import Constraint6023\n\nfunc Test() {\n    $expression\n}\n")
            let arguments = List[string]{"/target:library", "/targetframework:net10.0", "/out:" + assembly}
            arguments.AddRange(references.Select((path string) -> "/reference:" + path))
            arguments.Add(source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            var exitCode int32
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                exitCode = Program.Main(arguments.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (exitCode, stdout.ToString() + stderr.ToString(), assembly)
        }
    }
}
