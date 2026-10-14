// <copyright file="Issue2525ImportedIndexerHidingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Linq.Expressions
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import ExpressionsLambdaExpression = System.Linq.Expressions.LambdaExpression
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2525: imported indexers declared on a derived interface hide
/// same-signature indexers inherited from more distant interfaces.
class Issue2525ImportedIndexerHidingEmitTests {
    @Fact
    func HiddenSlots_ReadWriteExpressionsGenericsDiamondAndClasses_RunVerifyReflectAndWorkFromCSharp() {
        const source = `package Issue2525
import System
import System.Linq.Expressions
import Issue2525.Contracts

open data class Payload2525(Name string) {}
open data class BaseKey2525(Name string) {}
open data class DerivedKey2525(Name string) {}

class Api {
    shared {
        func Read(value IDerived) string -> value["key"]
        func Write(value IDerived, text string) { value["key"] = text }
        func ReadBase(value IBase) string -> value["key"]
        func WriteBase(value IBase, text string) { value["key"] = text }
        func ReadExpression() Expression[Func[IDerived, string]] ->
            (value IDerived) -> value["key"]
        func ReadConstrained[T IDerived](value T) string -> value["key"]
        func WriteConstrained[T IDerived](value T, text string) { value["key"] = text }
        func ReadGenericBase(
            value IGenericOverloadDerived[BaseKey2525, DerivedKey2525],
            key BaseKey2525) string -> value[key]
        func ReadGenericDerived(
            value IGenericOverloadDerived[BaseKey2525, DerivedKey2525],
            key DerivedKey2525) string -> value[key]
        func Bump(value IIntDerived) int32 {
            value[0] += 1
            value[0]++
            return value[0]
        }
    }
}

func Main() {
    let slots = SlotStore()
    let derived IDerived = slots
    Api.Write(derived, "gsharp")
    Console.WriteLine(Api.Read(derived))
    let asBase IBase = derived
    Api.WriteBase(asBase, "base")
    Console.WriteLine(Api.ReadBase(asBase))
    Api.WriteConstrained[SlotStore](slots, "constrained")
    Console.WriteLine(Api.ReadConstrained[SlotStore](slots))

    let ints = IntStore()
    let intDerived IIntDerived = ints
    intDerived[0] = 10
    intDerived[0] += 4
    intDerived[0]++
    Console.WriteLine(intDerived[0])
    let maybe IIntDerived? = intDerived
    Console.WriteLine(maybe?[0])
    let intBase IIntBase = intDerived
    intBase[0] = 2
    Console.WriteLine(intBase[0])

    let generic = GenericStore[Payload2525]()
    let genericDerived IGenericDerived[Payload2525] = generic
    let derivedKey = Payload2525("derived-key")
    genericDerived[derivedKey] = Payload2525("generic-derived")
    Console.WriteLine(genericDerived[derivedKey].Name)
    let genericBase IGenericBase[Payload2525] = genericDerived
    let baseKey = Payload2525("base-key")
    genericBase[baseKey] = Payload2525("generic-base")
    Console.WriteLine(genericBase[baseKey].Name)

    let genericOverload IGenericOverloadDerived[BaseKey2525, DerivedKey2525] =
        GenericOverloadStore[BaseKey2525, DerivedKey2525]()
    Console.WriteLine(Api.ReadGenericBase(genericOverload, BaseKey2525("base")))
    Console.WriteLine(Api.ReadGenericDerived(genericOverload, DerivedKey2525("derived")))

    let multi = MultiLevelStore()
    let leaf ILeaf = multi
    leaf["key"] = "value"
    Console.WriteLine(leaf["key"])
    let root IRoot = leaf
    root["key"] = "value"
    Console.WriteLine(root["key"])

    let diamond IDiamondLeaf = DiamondStore()
    diamond["key"] = "value"
    Console.WriteLine(diamond["key"])

    let inheritedDiamond IDiamondInheritedLeaf = InheritedDiamondStore()
    inheritedDiamond["key"] = "value"
    Console.WriteLine(inheritedDiamond["key"])

    let overloaded IOverloadDerived = OverloadStore()
    Console.WriteLine(overloaded["key"])
    let boxed object = "key"
    Console.WriteLine(overloaded[boxed])

    let overloadHiding IOverloadHidingDerived = OverloadHidingStore()
    Console.WriteLine(overloadHiding["key"])
    Console.WriteLine(overloadHiding[boxed])

    let dualGeneric IDualGeneric = DualGenericStore()
    Console.WriteLine(dualGeneric[1])
    Console.WriteLine(dualGeneric["key"])

    let changed IReturnDerived = ReturnStore()
    Console.WriteLine(changed["key"].Length)

    let getOnly IGetDerived = GetStore()
    Console.WriteLine(getOnly[0])

    let setStore = SetStore()
    let setOnly ISetDerived = setStore
    setOnly[0] = 2525
    Console.WriteLine(setStore.DerivedValue)

    let byRef IRefDerived = RefStore()
    byRef[0] = 8
    byRef[0]++
    Console.WriteLine(byRef[0])

    let initStore = InitStore()
    let initLike IInitDerived = initStore
    initLike["key"] = "init"
    Console.WriteLine(initStore.DerivedValue)

    let optional IOptionalDerived = OptionalStore()
    Console.WriteLine(optional["key"])

    let optionalGeneric IOptionalGenericDerived[Payload2525] = OptionalGenericStore[Payload2525]()
    Console.WriteLine(optionalGeneric[Payload2525("key")])

    let nullable INullDerived = NullStore()
    nullable["nullable-key"] = "nullable-value"
    let nullableResult string? = nullable["nullable-key"]
    Console.WriteLine(nullableResult)

    let classDerived = ClassDerived()
    Console.WriteLine(classDerived["key"])
    let classBase ClassBase = classDerived
    Console.WriteLine(classBase["key"])

    let holder = Holder{Values: {["nested"] = "write"}}
    Console.WriteLine(holder.Values["nested"])
}`
        using let result = Compile(source, "exe")
        IlVerifier.Verify(result.OutputPath, additionalReferences: []string{result.ContractsPath!!})
        Assert.Equal(`derived:gsharp
base:base
derived:constrained
15
15
2
generic-derived
generic-base
generic-base
generic-derived
leaf:value
root:value
diamond:value
left-inherited:value
string
object
derived-string
visible-base-object
dual-int
dual-string
14
25
2525
9
init
derived:3
derived-generic:4
nullable-value
class-derived
class-base
derived:write`.ReplaceLineEndings(Environment.NewLine) + Environment.NewLine, Run(result.OutputPath))
        // One context for both: the emitted API is invoked below with
        // instances of the contracts assembly's types, which requires a
        // single identity for them.
        let loaded2525 = EmittedFixture.LoadTogether(result.ContractsPath, result.OutputPath)
        let contracts = loaded2525[0]
        let derivedType = contracts.GetType("Issue2525.Contracts.IDerived", throwOnError: true)!!
        let baseType = contracts.GetType("Issue2525.Contracts.IBase", throwOnError: true)!!
        let derivedProperty = derivedType.GetProperties(
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
        )
            .Single()
        let baseProperty = baseType.GetProperties(
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
        )
            .Single()
        Assert.NotEqual(baseProperty.MetadataToken, derivedProperty.MetadataToken)
        let emitted = loaded2525[1]
        let api = emitted.GetType("Issue2525.Api", throwOnError: true)!!
        Assert.Equal("Issue2525.Contracts.IDerived", api.GetMethod("Read")!!.GetParameters()[0].ParameterType.FullName)
        Assert.Equal("Issue2525.Contracts.IBase", api.GetMethod("ReadBase")!!.GetParameters()[0].ParameterType.FullName)
        let expression = Assert.IsAssignableFrom[ExpressionsLambdaExpression](
            api.GetMethod("ReadExpression")!!.Invoke(nil, nil)
        )
        let slotStore = Activator.CreateInstance(
            contracts.GetType("Issue2525.Contracts.SlotStore", throwOnError: true)!!
        )!!
        Assert.Equal("derived:", expression.Compile().DynamicInvoke(slotStore))
        let consumerPath = EmitCSharpConsumer(result.DirectoryPath, result.OutputPath, result.ContractsPath)
        IlVerifier.Verify(consumerPath, additionalReferences: []string{result.OutputPath, result.ContractsPath!!})
        Assert.Equal(
            "derived:consumer${Environment.NewLine}base:consumer-base${Environment.NewLine}derived:consumer-constrained${Environment.NewLine}4${Environment.NewLine}left-inherited:csharp${Environment.NewLine}",
            Run(consumerPath)
        )
    }

    @Theory
    @InlineData("func Bad(value IGetDerived) { value[0] = 1 }")
    @InlineData("func Bad(value ISetDerived) int32 -> value[0]")
    func HiddenAccessorAvailability_ReportsGS0116(declaration string) {
        let source = (`package Issue2525.Errors
import Issue2525.Contracts

` + "$declaration")
        using let result = Compile(source, "library", expectSuccess: false)
        Assert.Contains("GS0116", result.Diagnostics, StringComparison.Ordinal)
        Assert.Contains("not indexable", result.Diagnostics, StringComparison.OrdinalIgnoreCase)
    }

    @Theory
    @InlineData("func Bad(value IAmbiguous) string -> value[\"key\"]")
    @InlineData("func Bad(value IDiamondAmbiguous) string -> value[\"key\"]")
    func UnrelatedIndexerAmbiguity_ReportsGS0266(declaration string) {
        let source = (`package Issue2525.Errors
import Issue2525.Contracts

` + "$declaration")
        using let result = Compile(source, "library", expectSuccess: false)
        Assert.Contains("GS0266", result.Diagnostics, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0116", result.Diagnostics, StringComparison.Ordinal)
    }

    @Fact
    func UnrelatedBaseIndexers_AreAlsoAmbiguousInCSharp() {
        const consumer = `using Issue2525.Contracts;

public static class Consumer
{
    public static string Read(IAmbiguous value) => value["key"];
}`
        using let result = Compile("package Issue2525.Empty", "library")
        let compilation = CreateCSharpCompilation(
            "Issue2525.AmbiguousConsumer",
            consumer,
            OutputKind.DynamicallyLinkedLibrary,
            result.ContractsPath
        )
        Assert.Contains(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error &&
                (diagnostic.Id == "CS0121" || diagnostic.Id == "CS0229")
        )
    }

    @Fact
    func AspNetHeaderDictionary_StringValuesReadWriteShape_CompilesRunsAndIlVerifies() {
        let aspNetReferences = GetAspNetReferences()
        if aspNetReferences.Length == 0 {
            return
        }
        const source = `package Issue2525.Headers
import Microsoft.AspNetCore.Http

class HeaderApi {
    shared {
        func Read(headers IHeaderDictionary) string -> headers["Authorization"].ToString()
        func Write(headers IHeaderDictionary) { headers["Retry-After"] = "1" }
    }
}`
        using let result = Compile(
            source,
            "library",
            additionalReferences: aspNetReferences,
            emitContracts: false,
            outputFileName: "Issue2525.Headers.dll"
        )
        IlVerifier.Verify(result.OutputPath, additionalReferences: aspNetReferences)
        let consumerPath = EmitHeaderConsumer(result.DirectoryPath, result.OutputPath, aspNetReferences)
        IlVerifier.Verify(
            consumerPath,
            additionalReferences: aspNetReferences.Concat([]string{result.OutputPath}).ToArray()
        )
        Assert.Equal(
            "Bearer token${Environment.NewLine}1${Environment.NewLine}",
            Run(consumerPath, includeAspNetCore: true)
        )
    }

    private class CompilationResult : IDisposable {
        init(directoryPath string, outputPath string, contractsPath string?, diagnostics string) {
            DirectoryPath = directoryPath
            OutputPath = outputPath
            ContractsPath = contractsPath
            Diagnostics = diagnostics
        }

        prop DirectoryPath string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop ContractsPath string? {
            get;
        }

        prop Diagnostics string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(DirectoryPath, recursive: true)
            } catch { }
        }
    }

    shared {
        private const ContractsSource string = `#nullable enable
using System;

namespace Issue2525.Contracts
{
    public interface IBase
    {
        string this[string key] { get; set; }
    }

    public interface IDerived : IBase
    {
        new string this[string key] { get; set; }
    }

    public sealed class SlotStore : IDerived
    {
        private string baseValue = "";
        private string derivedValue = "";

        string IBase.this[string key]
        {
            get => "base:" + baseValue;
            set => baseValue = value;
        }

        string IDerived.this[string key]
        {
            get => "derived:" + derivedValue;
            set => derivedValue = value;
        }
    }

    public interface IIntBase
    {
        int this[int index] { get; set; }
    }

    public interface IIntDerived : IIntBase
    {
        new int this[int index] { get; set; }
    }

    public sealed class IntStore : IIntDerived
    {
        private int baseValue;
        private int derivedValue;

        int IIntBase.this[int index]
        {
            get => baseValue;
            set => baseValue = value;
        }

        int IIntDerived.this[int index]
        {
            get => derivedValue;
            set => derivedValue = value;
        }
    }

    public interface IGenericBase<T>
    {
        T this[T key] { get; set; }
    }

    public interface IGenericDerived<T> : IGenericBase<T>
    {
        new T this[T key] { get; set; }
    }

    public sealed class GenericStore<T> : IGenericDerived<T>
    {
        private T baseValue = default!;
        private T derivedValue = default!;

        T IGenericBase<T>.this[T key]
        {
            get => baseValue;
            set => baseValue = value;
        }

        T IGenericDerived<T>.this[T key]
        {
            get => derivedValue;
            set => derivedValue = value;
        }
    }

    public interface IGenericOverloadBase<TBase>
    {
        string this[TBase key] { get; }
    }

    public interface IGenericOverloadDerived<TBase, TDerived> : IGenericOverloadBase<TBase>
    {
        string this[TDerived key] { get; }
    }

    public sealed class GenericOverloadStore<TBase, TDerived> : IGenericOverloadDerived<TBase, TDerived>
    {
        string IGenericOverloadBase<TBase>.this[TBase key] => "generic-base";
        string IGenericOverloadDerived<TBase, TDerived>.this[TDerived key] => "generic-derived";
    }

    public interface IRoot
    {
        string this[string key] { get; set; }
    }

    public interface IMiddle : IRoot
    {
        new string this[string key] { get; set; }
    }

    public interface ILeaf : IMiddle
    {
        new string this[string key] { get; set; }
    }

    public sealed class MultiLevelStore : ILeaf
    {
        private string root = "";
        private string middle = "";
        private string leaf = "";

        string IRoot.this[string key]
        {
            get => "root:" + root;
            set => root = value;
        }

        string IMiddle.this[string key]
        {
            get => "middle:" + middle;
            set => middle = value;
        }

        string ILeaf.this[string key]
        {
            get => "leaf:" + leaf;
            set => leaf = value;
        }
    }

    public interface IDiamondRoot
    {
        string this[string key] { get; set; }
    }

    public interface IDiamondLeft : IDiamondRoot
    {
        new string this[string key] { get; set; }
    }

    public interface IDiamondRight : IDiamondRoot
    {
    }

    public interface IDiamondLeaf : IDiamondLeft, IDiamondRight
    {
        new string this[string key] { get; set; }
    }

    public interface IDiamondInheritedLeaf : IDiamondLeft, IDiamondRight
    {
    }

    public interface IDiamondSibling : IDiamondRoot
    {
        new string this[string key] { get; set; }
    }

    public interface IDiamondAmbiguous : IDiamondLeft, IDiamondSibling
    {
    }

    public sealed class DiamondStore : IDiamondLeaf
    {
        private string root = "";
        private string left = "";
        private string leaf = "";

        string IDiamondRoot.this[string key]
        {
            get => "root:" + root;
            set => root = value;
        }

        string IDiamondLeft.this[string key]
        {
            get => "left:" + left;
            set => left = value;
        }

        string IDiamondLeaf.this[string key]
        {
            get => "diamond:" + leaf;
            set => leaf = value;
        }
    }

    public sealed class InheritedDiamondStore : IDiamondInheritedLeaf
    {
        private string root = "";
        private string left = "";

        string IDiamondRoot.this[string key]
        {
            get => "root-inherited:" + root;
            set => root = value;
        }

        string IDiamondLeft.this[string key]
        {
            get => "left-inherited:" + left;
            set => left = value;
        }
    }

    public interface IOverloadBase
    {
        string this[object key] { get; }
    }

    public interface IOverloadDerived : IOverloadBase
    {
        string this[string key] { get; }
    }

    public sealed class OverloadStore : IOverloadDerived
    {
        string IOverloadBase.this[object key] => "object";
        string IOverloadDerived.this[string key] => "string";
    }

    public interface IOverloadHidingBase
    {
        string this[string key] { get; }
        string this[object key] { get; }
    }

    public interface IOverloadHidingDerived : IOverloadHidingBase
    {
        new string this[string key] { get; }
    }

    public sealed class OverloadHidingStore : IOverloadHidingDerived
    {
        string IOverloadHidingBase.this[string key] => "hidden-base-string";
        string IOverloadHidingBase.this[object key] => "visible-base-object";
        string IOverloadHidingDerived.this[string key] => "derived-string";
    }

    public interface IGenericSlot<T>
    {
        string this[T key] { get; }
    }

    public interface IDualGeneric : IGenericSlot<int>, IGenericSlot<string>
    {
    }

    public sealed class DualGenericStore : IDualGeneric
    {
        string IGenericSlot<int>.this[int key] => "dual-int";
        string IGenericSlot<string>.this[string key] => "dual-string";
    }

    public interface IReturnBase
    {
        object this[string key] { get; }
    }

    public interface IReturnDerived : IReturnBase
    {
        new string this[string key] { get; }
    }

    public sealed class ReturnStore : IReturnDerived
    {
        object IReturnBase.this[string key] => new object();
        string IReturnDerived.this[string key] => "derived-return";
    }

    public interface IGetBase
    {
        int this[int index] { get; set; }
    }

    public interface IGetDerived : IGetBase
    {
        new int this[int index] { get; }
    }

    public sealed class GetStore : IGetDerived
    {
        private int baseValue;

        int IGetBase.this[int index]
        {
            get => baseValue;
            set => baseValue = value;
        }

        int IGetDerived.this[int index] => 25;
    }

    public interface ISetBase
    {
        int this[int index] { get; set; }
    }

    public interface ISetDerived : ISetBase
    {
        new int this[int index] { set; }
    }

    public sealed class SetStore : ISetDerived
    {
        private int baseValue;
        private int derivedValue;

        int ISetBase.this[int index]
        {
            get => baseValue;
            set => baseValue = value;
        }

        int ISetDerived.this[int index] { set => derivedValue = value; }

        public int DerivedValue => derivedValue;
    }

    public interface IRefBase
    {
        int this[int index] { get; set; }
    }

    public interface IRefDerived : IRefBase
    {
        new ref int this[int index] { get; }
    }

    public sealed class RefStore : IRefDerived
    {
        private int baseValue;
        private int derivedValue;

        int IRefBase.this[int index]
        {
            get => baseValue;
            set => baseValue = value;
        }

        ref int IRefDerived.this[int index] => ref derivedValue;
    }

    public interface IInitBase
    {
        string this[string key] { get; set; }
    }

    public interface IInitDerived : IInitBase
    {
        new string this[string key] { get; init; }
    }

    public sealed class InitStore : IInitDerived
    {
        private string baseValue = "";
        private string derivedValue = "";

        string IInitBase.this[string key]
        {
            get => baseValue;
            set => baseValue = value;
        }

        string IInitDerived.this[string key]
        {
            get => derivedValue;
            init => derivedValue = value;
        }

        public string DerivedValue => derivedValue;
    }

    public interface IOptionalBase
    {
        string this[string key, int suffix = 3] { get; }
    }

    public interface IOptionalDerived : IOptionalBase
    {
        new string this[string key, int suffix = 3] { get; }
    }

    public sealed class OptionalStore : IOptionalDerived
    {
        string IOptionalBase.this[string key, int suffix] => "base:" + suffix;
        string IOptionalDerived.this[string key, int suffix] => "derived:" + suffix;
    }

    public interface IOptionalGenericBase<T>
    {
        string this[T key, int suffix = 4] { get; }
    }

    public interface IOptionalGenericDerived<T> : IOptionalGenericBase<T>
    {
        new string this[T key, int suffix = 4] { get; }
    }

    public sealed class OptionalGenericStore<T> : IOptionalGenericDerived<T>
    {
        string IOptionalGenericBase<T>.this[T key, int suffix] => "base-generic:" + suffix;
        string IOptionalGenericDerived<T>.this[T key, int suffix] => "derived-generic:" + suffix;
    }

    public interface INullBase
    {
        string? this[string? key] { get; set; }
    }

    public interface INullDerived : INullBase
    {
        new string? this[string? key] { get; set; }
    }

    public sealed class NullStore : INullDerived
    {
        private string? baseValue;
        private string? derivedValue;

        string? INullBase.this[string? key]
        {
            get => baseValue;
            set => baseValue = value;
        }

        string? INullDerived.this[string? key]
        {
            get => derivedValue;
            set => derivedValue = value;
        }
    }

    public interface IAmbiguousA
    {
        string this[string key] { get; }
    }

    public interface IAmbiguousB
    {
        string this[string key] { get; }
    }

    public interface IAmbiguous : IAmbiguousA, IAmbiguousB
    {
    }

    public class ClassBase
    {
        public string this[string key] => "class-base";
    }

    public sealed class ClassDerived : ClassBase
    {
        public new string this[string key] => "class-derived";
    }

    public sealed class Holder
    {
        public IDerived Values { get; } = new SlotStore();
    }
}`

        private func Compile(
            source string,
            target string,
            expectSuccess bool = true,
            additionalReferences IReadOnlyList[string]? = nil,
            emitContracts bool = true,
            outputFileName string = "Issue2525.dll"
        ) Issue2525ImportedIndexerHidingEmitTests
            .CompilationResult {
            let directory = NewDirectory()
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, outputFileName)
            File.WriteAllText(sourcePath, source)
            let contractsPath string? = if emitContracts {
                EmitCSharpAssembly(directory, "Issue2525.Contracts", ContractsSource)
            } else {
                default(string?)
            }
            let references = List[string]()
            if contractsPath != nil {
                references.Add(contractsPath)
            }
            if additionalReferences != nil {
                references.AddRange(additionalReferences)
            }
            let args = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            args.AddRange(references.Select((reference string) -> ("/reference:" + reference)))
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            let diagnostics = stdout.ToString() + stderr.ToString()
            if expectSuccess {
                Assert.True(exitCode == 0, diagnostics)
            } else {
                Assert.NotEqual(0, exitCode)
            }
            return Issue2525ImportedIndexerHidingEmitTests.CompilationResult(
                directory,
                outputPath,
                contractsPath,
                diagnostics
            )
        }

        private func EmitCSharpAssembly(directory string, assemblyName string, source string) string {
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            let compilation = CreateCSharpCompilation(assemblyName, source, OutputKind.DynamicallyLinkedLibrary)
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func CreateCSharpCompilation(
            assemblyName string,
            source string,
            outputKind OutputKind,
            additionalReferences ...string?
        ) CSharpCompilation {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .Concat(additionalReferences.Select((path string) -> MetadataReference.CreateFromFile(path)))
            return CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(outputKind, nullableContextOptions: NullableContextOptions.Enable)
            )
        }

        private func EmitCSharpConsumer(directory string, gsharpAssembly string, contractsAssembly string?) string {
            const source = `using System;
using Issue2525;
using Issue2525.Contracts;

internal static class Program
{
    private static void Main()
    {
        var store = new SlotStore();
        IDerived derived = store;
        Api.Write(derived, "consumer");
        Console.WriteLine(Api.Read(derived));
        Api.WriteBase(derived, "consumer-base");
        Console.WriteLine(Api.ReadBase(derived));
        Api.WriteConstrained<SlotStore>(store, "consumer-constrained");
        Console.WriteLine(Api.ReadConstrained<SlotStore>(store));

        IIntDerived ints = new IntStore();
        ints[0] = 2;
        Console.WriteLine(Api.Bump(ints));

        IDiamondInheritedLeaf diamond = new InheritedDiamondStore();
        diamond["key"] = "csharp";
        Console.WriteLine(diamond["key"]);
    }
}`
            let outputPath = Path.Combine(directory, "consumer.dll")
            let compilation = CreateCSharpCompilation(
                "Issue2525.Consumer",
                source,
                OutputKind.ConsoleApplication,
                gsharpAssembly,
                contractsAssembly
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func EmitHeaderConsumer(
            directory string,
            gsharpAssembly string,
            aspNetReferences IReadOnlyList[string]
        ) string {
            const source = `using System;
using Issue2525.Headers;
using Microsoft.AspNetCore.Http;

internal static class Program
{
    private static void Main()
    {
        IHeaderDictionary headers = new HeaderDictionary();
        headers.Authorization = "Bearer token";
        HeaderApi.Write(headers);
        Console.WriteLine(HeaderApi.Read(headers));
        Console.WriteLine(headers["Retry-After"].ToString());
    }
}`
            let outputPath = Path.Combine(directory, "header-consumer.dll")
            let references = aspNetReferences.Concat([]string{gsharpAssembly}).ToArray()
            let compilation = CreateCSharpCompilation(
                "Issue2525.HeaderConsumer",
                source,
                OutputKind.ConsoleApplication,
                references
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func Run(assemblyPath string, includeAspNetCore bool = false) string {
            let runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json")
            let frameworks = if includeAspNetCore {
                `  "frameworks": [
    { "name": "Microsoft.NETCore.App", "version": "10.0.0" },
    { "name": "Microsoft.AspNetCore.App", "version": "10.0.0" }
  ]`
            } else {
                "  \"framework\": { \"name\": \"Microsoft.NETCore.App\", \"version\": \"10.0.0\" }"
            }
            File.WriteAllText(runtimeConfigPath, (`{
  "runtimeOptions": {
    "tfm": "net10.0",
    ` + "$frameworks" + `
  }
}`))
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(runtimeConfigPath)
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`dotnet exec failed (` + "${process.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func GetAspNetReferences()[]string {
            let coreDirectory string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            let sharedDirectory string? = Directory.GetParent(coreDirectory!!)?.Parent?.FullName
            let aspNetRoot string? = if sharedDirectory == nil {
                default(string?)
            } else {
                Path.Combine(sharedDirectory, "Microsoft.AspNetCore.App")
            }
            if aspNetRoot == nil || !Directory.Exists(aspNetRoot) {
                return Array.Empty[string]()
            }
            let coreVersion string? = Path.GetFileName(coreDirectory)
            var versionDirectory string? = Path.Combine(aspNetRoot, coreVersion!!)
            if !Directory.Exists(versionDirectory) {
                versionDirectory = Directory
                    .GetDirectories(aspNetRoot)
                    .OrderByDescending((path string) -> path, StringComparer.Ordinal)
                    .FirstOrDefault()
            }
            return if versionDirectory == nil {
                Array.Empty[string]()
            } else {
                Directory.GetFiles(versionDirectory, "*.dll")
            }
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            Assert.False(string.IsNullOrWhiteSpace(value))
            return value!!.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
        }

        private func NewDirectory() string {
            let path = Path.Combine(AppContext.BaseDirectory, "issue2525", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(path)
            return path
        }
    }
}
