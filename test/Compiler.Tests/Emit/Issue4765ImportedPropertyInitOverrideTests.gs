// <copyright file="Issue4765ImportedPropertyInitOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import Xunit.Abstractions
import GSharp.Compiler.Tests

class Issue4765ImportedPropertyInitOverrideTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ImportedWriteAccessorKindMismatchIsRejected(baseInit bool, reabstract bool) {
        let contract = ContractSource(baseInit)
        let mirror = (`public ` + "${(if reabstract { "abstract " } else { "" })}" + `class Mirror : ImportedKinds.Contract<int> {
    public ` + "${(if reabstract { "abstract " } else { "" })}" + `override int Value { get; protected ` + "${(if baseInit { "set" } else { "init" })}" + `; }
}`)
        let csharp = CSharpCompilation.Create(
            "MismatchMirror",
            []SyntaxTree{CSharpSyntaxTree.ParseText(contract), CSharpSyntaxTree.ParseText(mirror)},
            ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
                (path string) -> MetadataReference.CreateFromFile(path)
            ),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        Assert.Contains(csharp.GetDiagnostics(), (diagnostic Diagnostic) -> diagnostic.Id == "CS8853")
        using let reference = CSharpFixture(contract)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = (`package ImportedInitKind
import ImportedKinds
public ` + "${(if reabstract { "abstract " } else { "" })}" + `class Bridge : Contract[int32] {
    public ` + "${(if reabstract { "abstract " } else { "" })}" + `override prop Value int32 { get; protected ` + "${(if baseInit { "set" } else { "init" })}" + `; }
}`)
        let result = fixture.TryCompile(source, "ImportedInitKind", false, "/r:" + reference.AssemblyPath)
        let dll = Path.Combine(fixture.Directory, "ImportedInitKind.dll")
        this.Retain(
            "mismatch-" + baseInit.ToString() + "-" + reabstract.ToString(),
            contract,
            source,
            reference.AssemblyPath,
            dll,
            result.Output
        )
        this.output.WriteLine("gsc exit " + result.Code.ToString() + "\n" + result.Output)
        Verify(reference.AssemblyPath)
        if result.Code == 0 {
            // Preserve the pre-fix wrong-slot witness before the rejection assertion fails.
            this.LogSetterMetadata(reference.AssemblyPath)
            this.LogSetterMetadata(dll)
            try {
                Verify(dll, reference.AssemblyPath)
                this.output.WriteLine("Unexpected accepted product: strict ILVerify GREEN")
            } catch (exception Exception) {
                this.output.WriteLine("Unexpected accepted product: strict ILVerify RED\n" + exception.ToString())
            }
            try {
                let assembly = EmittedFixture.LoadTogether(reference.AssemblyPath, dll)[1]
                let bridge = RequiredType(assembly, "ImportedInitKind.Bridge")
                this.output.WriteLine("Unexpected accepted product: CLR type loaded " + bridge.ToString())
                let original = bridge.BaseType ?? throw InvalidOperationException("Missing imported base")
                let actualModifiers = RequiredProperty(bridge).GetSetMethod(nonPublic: true)!!
                    .ReturnParameter
                    .GetRequiredCustomModifiers()
                    .Select((type Type) -> type.FullName!!)
                    .ToArray()
                let expectedModifiers = RequiredProperty(original).GetSetMethod(nonPublic: true)!!
                    .ReturnParameter
                    .GetRequiredCustomModifiers()
                    .Select((type Type) -> type.FullName!!)
                    .ToArray()
                this.output.WriteLine(
                    "Imported setter modreq=[" + string.Join(",", expectedModifiers) +
                        "]; emitted setter modreq=[" +
                        string.Join(",", actualModifiers) + "]"
                )
                Assert.Equal(expectedModifiers, actualModifiers)
            } catch (exception Exception) {
                this.output.WriteLine(
                    "Unexpected accepted product: CLR reflection/contract metadata RED\n" + exception.ToString()
                )
            }
        }
        Assert.NotEqual(0, result.Code)
        Assert.Contains("GS0185", result.Output, StringComparison.Ordinal)
        Assert.Contains("Value", result.Output, StringComparison.Ordinal)
        Assert.False(File.Exists(dll))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func MatchingImportedWriteAccessorKindsPreserveSlotsAndDispatch(init bool, reabstract bool) {
        let contract = ContractSource(init)
        let write = if init {
            "init"
        } else {
            "set"
        }
        using let reference = CSharpFixture(contract)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = (`package ImportedInitKind
import ImportedKinds
` + "${(if reabstract { "public abstract class Bridge : Contract[int32] { public abstract override prop Value int32 { get; protected " + write + "; } }" } else { "" })}" + `
public class Item : ` + "${(if reabstract { "Bridge" } else { "Contract[int32]" })}" + ` {
    public override prop Value int32 { get; protected ` + "$write" + `; }
    public init(value int32) { this.Value = value }
}
public class Driver {
    shared {
        public func Run() int32 {
            let item Contract[int32] = Item(11)
            return item.Value
        }
    }
}`)
        let dll = fixture.Compile(source, "ImportedInitKind", false, "/r:" + reference.AssemblyPath)
        this.Retain(
            "matching-" + init.ToString() + "-" + reabstract.ToString(),
            contract,
            source,
            reference.AssemblyPath,
            dll,
            ""
        )
        Verify(reference.AssemblyPath)
        Verify(dll, reference.AssemblyPath)
        let assemblies = EmittedFixture.LoadTogether(reference.AssemblyPath, dll)
        let original = RequiredType(assemblies[0], "ImportedKinds.Contract`1").MakeGenericType(typeof(int32))
        let item = RequiredType(assemblies[1], "ImportedInitKind.Item")
        let setter MethodInfo? = RequiredProperty(item).GetSetMethod(nonPublic: true)
        Assert.NotNull(setter)
        Assert.True(setter!!.IsFamily)
        Assert.False(setter!!.IsAbstract)
        Assert.False((setter!!.Attributes & MethodAttributes.NewSlot) != 0)
        Assert.Equal(
            RequiredProperty(original).GetSetMethod(nonPublic: true)!!.ReturnParameter.GetRequiredCustomModifiers(),
            setter!!.ReturnParameter.GetRequiredCustomModifiers()
        )
        if reabstract {
            let bridge = RequiredType(assemblies[1], "ImportedInitKind.Bridge")
            Assert.Empty(
                bridge.GetFields(
                    BindingFlags.DeclaredOnly | BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
                )
            )
            let requiredSetter MethodInfo? = RequiredProperty(bridge).GetSetMethod(nonPublic: true)
            Assert.NotNull(requiredSetter)
            Assert.True(requiredSetter!!.IsAbstract)
            Assert.True(requiredSetter!!.IsVirtual)
            Assert.True(requiredSetter!!.IsFamily)
            Assert.False(requiredSetter!!.IsFinal)
            Assert.False((requiredSetter!!.Attributes & MethodAttributes.NewSlot) != 0)
            Assert.Null(requiredSetter!!.GetMethodBody())
            Assert.Equal(
                setter!!.ReturnParameter.GetRequiredCustomModifiers(),
                requiredSetter!!.ReturnParameter.GetRequiredCustomModifiers()
            )
        }
        Assert.Equal(11, RequiredType(assemblies[1], "ImportedInitKind.Driver").GetMethod("Run")!!.Invoke(nil, nil))
    }

    private func LogSetterMetadata(dll string) {
        using let stream = File.OpenRead(dll)
        using let pe = PEReader(stream)
        let metadata = pe.GetMetadataReader()
        for handle in metadata.MethodDefinitions {
            let method = metadata.GetMethodDefinition(handle)
            if metadata.GetString(method.Name) == "set_Value" {
                this.output.WriteLine(
                    "Actual set_Value: " + method.Attributes.ToString() +
                        "; RVA=" +
                        method
                        .RelativeVirtualAddress
                        .ToString() + "; signature=" + Convert.ToHexString(metadata.GetBlobBytes(method.Signature))
                )
            }
        }
    }

    private func Retain(name string, contract string, source string, reference string, dll string, diagnostics string) {
        for path in[]string{reference, dll}.Where(File.Exists) {
            this.output.WriteLine(
                "sha256 " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) + " " + path
            )
        }
        let root string? = Environment.GetEnvironmentVariable("GSHARP_IMPORTED_INIT_PROOF_ROOT")
        if string.IsNullOrEmpty(root) {
            return
        }
        let directory = Path.Combine(root, name)
        Directory.CreateDirectory(directory)
        File.WriteAllText(Path.Combine(directory, "Contract.cs"), contract)
        File.WriteAllText(Path.Combine(directory, "Native.gs"), source)
        File.WriteAllText(Path.Combine(directory, "diagnostics.log"), diagnostics)
        File.Copy(reference, Path.Combine(directory, Path.GetFileName(reference)))
        if File.Exists(dll) {
            File.Copy(dll, Path.Combine(directory, Path.GetFileName(dll)))
        }
    }

    shared {
        private func ContractSource(init bool) string -> (`namespace ImportedKinds {
    public abstract class Contract<T> {
        public abstract T Value { get; protected ` + "${(if init { "init" } else { "set" })}" + `; }
    }
}`)

        private func RequiredType(assembly Assembly, name string) Type -> assembly.GetType(name) ??
            throw InvalidOperationException("Missing type " + name)

        private func RequiredProperty(type Type) PropertyInfo -> type.GetProperty(
            "Value",
            BindingFlags.DeclaredOnly | BindingFlags.Instance | BindingFlags.Public
        ) ??
            throw InvalidOperationException("Missing Value property")

        private func Verify(dll string, references ...string) {
            Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
            IlVerifier.Verify(dll, references)
        }
    }
}
