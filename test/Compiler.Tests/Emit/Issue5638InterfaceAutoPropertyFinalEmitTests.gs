// <copyright file="Issue5638InterfaceAutoPropertyFinalEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #5638: an implicit interface implementation that is neither `open`
/// nor `override` must emit `MethodAttributes.Virtual | MethodAttributes.Final | MethodAttributes.NewSlot`
/// in both the implementation assembly and the reference assembly.
open class Issue5638InterfaceAutoPropertyFinalEmitTests {
    @Fact
    func NonOpenInterfacePropertiesAndIndexers_HaveVirtualFinalNewSlot_WhileOpenControlStaysUnsealed_InOutAndRefout() {
        const source = `package Issue5638.Metadata

interface IContract {
    prop Auto int32 { get; set; }
    prop InitOnly int32 { get; init; }
    prop Computed int32 { get; set; }
    prop this[index int32] int32 { get; set; }
    prop OpenAuto int32 { get; set; }
}

open class OpenImpl : IContract {
    private var computed int32
    prop Auto int32 { get; set; }
    prop InitOnly int32 { get; init; }
    prop Computed int32 {
        get -> this.computed
        set { this.computed = value }
    }
    prop this[index int32] int32 {
        get -> index + this.computed
        set { this.computed = index + value }
    }
    open prop OpenAuto int32 { get; set; }
}

class ClosedImpl : IContract {
    prop Auto int32 { get; set; }
    prop InitOnly int32 { get; init; }
    prop Computed int32 { get; set; }
    prop this[index int32] int32 {
        get -> index
        set { }
    }
    prop OpenAuto int32 { get; set; }
}

interface IPositional {
    prop Rate int32 { get; }
}

open data class PositionalRecord(Rate int32) : IPositional {
}`
        let tempDir = CreateTempDirectory()
        try {
            let (implPath, refPath) = CompileGSharpWithReference(tempDir, "Issue5638Metadata", source)
            IlVerifier.Verify(implPath)
            for assemblyPath in[]string{implPath, refPath} {
                for typeName in[]string{"OpenImpl", "ClosedImpl"} {
                    for accessorName in[]string{
                        "get_Auto",
                        "set_Auto",
                        "get_InitOnly",
                        "set_InitOnly",
                        "get_Computed",
                        "set_Computed",
                        "get_Item",
                        "set_Item"
                    } {
                        AssertVirtualFinalNewSlot(assemblyPath, typeName, accessorName)
                    }
                }
                AssertVirtualFinalNewSlot(assemblyPath, "ClosedImpl", "get_OpenAuto")
                AssertVirtualFinalNewSlot(assemblyPath, "ClosedImpl", "set_OpenAuto")
                AssertVirtualFinalNewSlot(assemblyPath, "PositionalRecord", "get_Rate")
                AssertVirtualFinalNewSlot(assemblyPath, "PositionalRecord", "set_Rate")
                AssertVirtualUnsealedNewSlot(assemblyPath, "OpenImpl", "get_OpenAuto")
                AssertVirtualUnsealedNewSlot(assemblyPath, "OpenImpl", "set_OpenAuto")
            }
        } finally {
            DeleteDirectory(tempDir)
        }
    }

    @Fact
    func NonOpenInterfaceEventsAndFieldBackedProperties_HaveVirtualFinalNewSlot_InOutAndRefout() {
        const csharpContract = `namespace ClrContracts;

public interface IClrHolder
{
    int FieldValue { get; set; }
}`
        const source = `package Issue5638.EventsAndFields
import System
import ClrContracts

interface IEventContract {
    event FieldEvent EventHandler?
    event CustomEvent EventHandler?
    event OpenEvent EventHandler?
}

interface IParamContract {
    prop ParamValue int32 { get; }
}

open class EventAndFieldBase(ParamValue int32) : IEventContract, IParamContract, IClrHolder {
    var FieldValue int32
    event FieldEvent EventHandler?
    event CustomEvent EventHandler? {
        add { }
        remove { }
        raise { }
    }
    open event OpenEvent EventHandler?
}`
        let tempDir = CreateTempDirectory()
        try {
            let clrContractPath = Path.Combine(tempDir, "ClrContracts.dll")
            EmitCSharp(csharpContract, clrContractPath)
            let (implPath, refPath) = CompileGSharpWithReference(
                tempDir,
                "Issue5638EventsAndFields",
                source,
                clrContractPath
            )
            IlVerifier.Verify(implPath, additionalReferences: []string{clrContractPath})
            for assemblyPath in[]string{implPath, refPath} {
                for accessorName in[]string{
                    "add_FieldEvent",
                    "remove_FieldEvent",
                    "add_CustomEvent",
                    "remove_CustomEvent",
                    "raise_CustomEvent",
                    "get_ParamValue",
                    "get_FieldValue",
                    "set_FieldValue"
                } {
                    AssertVirtualFinalNewSlot(assemblyPath, "EventAndFieldBase", accessorName)
                }
                AssertVirtualUnsealedNewSlot(assemblyPath, "EventAndFieldBase", "add_OpenEvent")
                AssertVirtualUnsealedNewSlot(assemblyPath, "EventAndFieldBase", "remove_OpenEvent")
            }
        } finally {
            DeleteDirectory(tempDir)
        }
    }

    @Fact
    func CrossAssemblyDerivedClass_CannotOverrideNonOpenInterfaceAutoProperty_AgainstImplementationOrReferenceAssembly() {
        const libASource = `package LibA
import System

interface ICounter {
    prop Auto int32 { get; set; }
    prop this[index int32] int32 { get; set; }
    event Changed EventHandler?
}

open class Base : ICounter {
    prop Auto int32 { get; set; }
    prop this[index int32] int32 {
        get -> index
        set { }
    }
    event Changed EventHandler?
}

class Box {
    shared {
        var G string? = "x"
    }
}

func Run(ref text string?, b Base) int32 {
    if text == nil { return 0 }
    let n = b.Auto
    return text.Length + n
}

func RunG(b Base) int32 {
    return Run(ref Box.G, b)
}`
        const consumerSource = `import System
import LibA

class Derived : Base {
    override prop Auto int32 {
        get {
            Box.G = nil
            return 1
        }
        set { }
    }
    override prop this[index int32] int32 {
        get -> index
        set { }
    }
    override event Changed EventHandler?
}

Console.WriteLine(RunG(Derived()))`
        let tempDir = CreateTempDirectory()
        try {
            let (implPath, refPath) = CompileGSharpWithReference(tempDir, "LibA", libASource)
            IlVerifier.Verify(implPath)
            for referencePath in[]string{implPath, refPath} {
                let consumerSrc = Path.Combine(tempDir, "consumer.gs")
                let consumerOut = Path.Combine(tempDir, "consumer.dll")
                File.WriteAllText(consumerSrc, consumerSource)
                let (exitCode, output) = RunCompiler(
                    []string{
                        "/out:" + consumerOut,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/r:" + referencePath,
                        consumerSrc
                    }
                )
                Assert.NotEqual(0, exitCode)
                Assert.Contains("(5,19,5,23): error GS0184: Method 'Auto'", output, StringComparison.Ordinal)
                Assert.Contains("(12,19,12,23): error GS0184: Method 'Item'", output, StringComparison.Ordinal)
                Assert.Contains("(16,20,16,27): error GS0184: Method 'Changed'", output, StringComparison.Ordinal)
            }
        } finally {
            DeleteDirectory(tempDir)
        }
    }

    @Fact
    func CrossAssemblyCSharpDerivedClass_CannotOverrideNonOpenInterfaceAutoProperty_AgainstImplementationOrReferenceAssembly() {
        const libASource = `package LibA

interface ICounter {
    prop Auto int32 { get; set; }
    prop OpenAuto int32 { get; set; }
}

open class Base : ICounter {
    prop Auto int32 { get; set; }
    open prop OpenAuto int32 { get; set; }
}`
        const csharpConsumer = `using LibA;

public class BadDerived : Base
{
    public override int Auto
    {
        get => 1;
        set { }
    }
}

public class GoodDerived : Base
{
    public override int OpenAuto
    {
        get => 2;
        set { }
    }
}`
        let tempDir = CreateTempDirectory()
        try {
            let (implPath, refPath) = CompileGSharpWithReference(tempDir, "LibA", libASource)
            for referencePath in[]string{implPath, refPath} {
                let diagnostics = CompileCSharpAndGetErrors(csharpConsumer, referencePath)
                let error = Assert.Single(diagnostics)
                Assert.Equal("CS0506", error.Id)
                Assert.Contains("Base.Auto", error.GetMessage(), StringComparison.Ordinal)
            }
        } finally {
            DeleteDirectory(tempDir)
        }
    }

    shared {
        private func AssertVirtualFinalNewSlot(assemblyPath string, typeName string, methodName string) {
            let attributes = ReadMethodAttributes(assemblyPath, typeName, methodName)
            let expected = MethodAttributes.Virtual | MethodAttributes.Final | MethodAttributes.NewSlot
            Assert.True(
                (attributes & expected) == expected,
                "$typeName::$methodName in '${Path.GetFileName(assemblyPath)}' expected Virtual|Final|NewSlot, got $attributes."
            )
        }

        private func AssertVirtualUnsealedNewSlot(assemblyPath string, typeName string, methodName string) {
            let attributes = ReadMethodAttributes(assemblyPath, typeName, methodName)
            let expected = MethodAttributes.Virtual | MethodAttributes.NewSlot
            Assert.True(
                (attributes & expected) == expected,
                "$typeName::$methodName in '${Path.GetFileName(assemblyPath)}' expected Virtual|NewSlot, got $attributes."
            )
            Assert.True(
                (attributes & MethodAttributes.Final) == 0,
                "$typeName::$methodName in '${Path.GetFileName(assemblyPath)}' must not carry Final, got $attributes."
            )
        }

        private func ReadMethodAttributes(assemblyPath string, typeName string, methodName string) MethodAttributes {
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            for typeHandle in reader.TypeDefinitions {
                let type = reader.GetTypeDefinition(typeHandle)
                if !string.Equals(reader.GetString(type.Name), typeName, StringComparison.Ordinal) {
                    continue
                }
                for methodHandle in type.GetMethods() {
                    let method = reader.GetMethodDefinition(methodHandle)
                    if string.Equals(reader.GetString(method.Name), methodName, StringComparison.Ordinal) {
                        return method.Attributes
                    }
                }
            }
            throw InvalidOperationException("'$typeName::$methodName' not found in '$assemblyPath'.")
        }

        private func CompileGSharpWithReference(
            directory string,
            name string,
            source string,
            additionalReferences ...string
        )(ImplementationPath string, ReferencePath string) {
            let srcPath = Path.Combine(directory, name + ".gs")
            let implPath = Path.Combine(directory, name + ".dll")
            let refPath = Path.Combine(directory, name + ".ref.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{
                "/out:" + implPath,
                "/refout:" + refPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath
            }
            for reference in additionalReferences {
                args.Add("/r:" + reference)
            }
            let (exitCode, output) = RunCompiler(args.ToArray())
            Assert.True(exitCode == 0, "gsc failed:\n" + output)
            return (implPath, refPath)
        }

        private func EmitCSharp(source string, outputPath string, additionalReferences ...string) {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!))
                .Split(Path.PathSeparator)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
                .Concat(additionalReferences.Select((path string) -> MetadataReference.CreateFromFile(path)))
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(outputPath),
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let result = compilation.Emit(outputPath)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func CompileCSharpAndGetErrors(source string, additionalReference string) IReadOnlyList[
            Microsoft.CodeAnalysis.Diagnostic
        ] {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!))
                .Split(Path.PathSeparator)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
                .Append(MetadataReference.CreateFromFile(additionalReference))
            let compilation = CSharpCompilation.Create(
                "CSharpConsumer",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            return result
                .Diagnostics
                .Where((d Microsoft.CodeAnalysis.Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToArray()
        }

        private func RunCompiler(args[]string)(ExitCode int32, Output string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let code = Program.Main(args)
                return (code, stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        }

        private func CreateTempDirectory() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue5638-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }

        private func DeleteDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }
}
