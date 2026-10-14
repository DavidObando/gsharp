// <copyright file="Issue3521InitializerLambdaTargetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

class Issue3521InitializerLambdaTargetEmitTests {
    @Fact
    func DestinationMemberTypes_TargetUntypedLambdas_RunAndVerify() {
        const source = `package Issue3521Positive
import System.Collections.Generic

class NullableHolder3521 { var Callback ((int32) -> void)? }
class ClassHolder3521 { var Callback (int32) -> void }
data class DataClassHolder3521 { var Callback (int32) -> void }
struct StructHolder3521 { var Callback (int32) -> void }
data struct DataStructHolder3521 { var Callback (int32) -> void }
class PropertyHolder3521 {
    prop Callback (int32) -> void { get; init; }
    init() {}
}
class SuffixHolder3521 {
    var Callback (int32) -> void
    init() {}
}
data class CopyHolder3521 { var Callback (int32) -> void }
class MixedHolder3521 {
    var Callback (int32) -> void
    prop Items IList[int32] { get; init; }
    init() { Items = List[int32]() }
}
class NestedHolder3521 {
    var Factory (int32) -> ((int32) -> int32)
}

func Main() int32 {
    var seen int32 = 0

    let nullable = NullableHolder3521{
        Callback: (value) -> { seen = seen + value }
    }
    nullable.Callback?(1)

    let plain = ClassHolder3521{
        Callback: (value) -> { seen = seen + value }
    }
    plain.Callback(2)

    let dataClass = DataClassHolder3521{
        Callback: (value) -> { seen = seen + value }
    }
    dataClass.Callback(3)

    let structure = StructHolder3521{
        Callback: (value) -> { seen = seen + value }
    }
    structure.Callback(4)

    let dataStructure = DataStructHolder3521{
        Callback: (value) -> { seen = seen + value }
    }
    dataStructure.Callback(5)

    let projected = DataStructHolder3521{
        ...dataStructure,
        Callback: (value) -> { seen = seen + value }
    }
    projected.Callback(6)

    let mixed = MixedHolder3521{
        Callback: (value) -> { seen = seen + value },
        Items: { 1 }
    }
    mixed.Callback(7)

    let suffix = SuffixHolder3521(){
        Callback = (value) -> { seen = seen + value }
    }
    suffix.Callback(8)

    let original = CopyHolder3521{
        Callback: (value int32) -> { seen = seen + value }
    }
    let copied = original with {
        Callback = (value) -> { seen = seen + value }
    }
    copied.Callback(9)

    let anonymous = object {
        let Callback (int32) -> void =
            (value) -> { seen = seen + value }
    }
    anonymous.Callback(10)

    let array = []((int32) -> void){
        (value) -> { seen = seen + value }
    }
    array[0](11)

    let list = List[(int32) -> void]{
        (value) -> { seen = seen + value }
    }
    list[0](12)

    let indexed = Dictionary[int32, (int32) -> void]{
        [1] = (value) -> { seen = seen + value }
    }
    indexed[1](13)

    let mapped = map[int32, (int32) -> void]{
        1: (value) -> { seen = seen + value }
    }
    mapped[1](14)

    let property = PropertyHolder3521{
        Callback: (value) -> { seen = seen + value }
    }
    property.Callback(15)

    let nested = NestedHolder3521{
        Factory: (left) -> {
            return (right) -> left + right
        }
    }
    seen = seen + nested.Factory(8)(8)

    return seen == 136 ? 0 : 1
}`
        let directory = NewDirectory("positive")
        try {
            let outputPath = Path.Combine(directory, "Issue3521Positive.dll")
            Emit(source, outputPath)
            IlVerifier.Verify(outputPath)
            Assert.Equal(0, Run(outputPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func InferredGenericComposites_DeferConcreteLambdaMembers_RunAndVerify() {
        const source = `package Issue3521Generic

class GenericClass3521[T] {
    var Value T
    var Callback (int32) -> void
}

data struct GenericDataStruct3521[T] {
    var Value T
    var Callback (int32) -> void
}

class GenericCallback3521[T] {
    var Callback (T) -> void
}

func Main() int32 {
    var seen int32 = 0

    let classBox = GenericClass3521{
        Value: 40,
        Callback: (value) -> { seen = seen + value }
    }
    seen = seen + classBox.Value
    classBox.Callback(1)

    let dataBox = GenericDataStruct3521{
        Callback: (value) -> { seen = seen + value },
        Value: "ok"
    }
    dataBox.Callback(dataBox.Value.Length)

    let callbackBox = GenericCallback3521{
        Callback: (value int32) -> { seen = seen + value }
    }
    callbackBox.Callback(1)

    return seen == 44 ? 0 : 1
}`
        let directory = NewDirectory("generic")
        try {
            let outputPath = Path.Combine(directory, "Issue3521Generic.dll")
            Emit(source, outputPath)
            IlVerifier.Verify(outputPath)
            Assert.Equal(0, Run(outputPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func WrongLambdaArity_ReportsArgumentCountDiagnostic() {
        let diagnostics = CompileErrors(`package Issue3521WrongArity

class Holder3521WrongArity {
    var Callback (int32) -> void
}

func Build() Holder3521WrongArity ->
    Holder3521WrongArity{ Callback: (left, right) -> {} }`)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0144")
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9998")
    }

    @Fact
    func IncompatibleExplicitParameterType_ReportsConversionDiagnostic() {
        let diagnostics = CompileErrors(`package Issue3521WrongType

class Holder3521WrongType[T] {
    var Value T
    var Callback (int32) -> void
}

func Build() Holder3521WrongType[int32] ->
    Holder3521WrongType{
        Value: 1,
        Callback: (value string) -> {}
    }`)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0155")
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9998")
    }

    shared {
        private func Emit(source string, outputPath string) {
            using let resolver = ReferenceResolver.Default()
            let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(
                stream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: Path.GetFileNameWithoutExtension(outputPath)
            )
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func CompileErrors(source string)[]Diagnostic {
            using let resolver = ReferenceResolver.Default()
            let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
            using let stream = MemoryStream()
            let result = compilation.Emit(
                stream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue3521Negative" + Guid.NewGuid().ToString("N")
            )
            Assert.False(result.Success)
            return result.Diagnostics.ToArray()
        }

        private func Run(assemblyPath string) int32 {
            let context = AssemblyLoadContext("Issue3521-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                let assembly = context.LoadFromAssemblyPath(Path.GetFullPath(assemblyPath))
                let entryPoint MethodInfo? = assembly.EntryPoint
                Assert.NotNull(entryPoint)
                let arguments[]?object = if entryPoint!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
                return Convert.ToInt32(entryPoint!!.Invoke(nil, arguments))
            } finally {
                context.Unload()
            }
        }

        private func NewDirectory(name string) string {
            let directory = Path.Combine(
                Environment.CurrentDirectory,
                "TestArtifacts",
                "Issue3521",
                name + "-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }
    }
}
