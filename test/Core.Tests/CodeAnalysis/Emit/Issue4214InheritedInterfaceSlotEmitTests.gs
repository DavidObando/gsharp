// <copyright file="Issue4214InheritedInterfaceSlotEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.PortableExecutable
import System.Reflection.Metadata
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import Xunit
import GSharp.Core.Tests
import System.Collections.Generic

open class Issue4214InheritedInterfaceSlotEmitTests {
    @Theory
    @InlineData(false, false, false)
    @InlineData(false, false, true)
    @InlineData(false, true, false)
    @InlineData(false, true, true)
    @InlineData(true, false, false)
    @InlineData(true, false, true)
    @InlineData(true, true, false)
    @InlineData(true, true, true)
    func InheritedEnumeratorSlot_HasBodyAndLoads(iterator bool, userElement bool, metadataReferences bool) {
        let element = if userElement {
            "Item"
        } else {
            "int32"
        }
        let item = if userElement {
            "Item{Value: 6}"
        } else {
            "6"
        }
        let body = if iterator {
            "yield $item"
        } else {
            (`var items = List[` + "$element" + `]()
items.Add(` + "$item" + `)
return items.GetEnumerator()`)
        }
        let source = (`package Issue4214
import System.Collections
import System.Collections.Generic

class Item { var Value int32 }
struct Bag : IReadOnlyCollection[` + "$element" + `] {
    prop Count int32 -> 1
    func GetEnumerator() IEnumerator[` + "$element" + `] { ` + "$body" + ` }
    func GetEnumerator(value int32) int32 -> value
    private func (IEnumerable) GetEnumerator() IEnumerator { return GetEnumerator() }
}

var bag = Bag{}
var generic IEnumerable[` + "$element" + `] = bag
var cursor = generic.GetEnumerator()
cursor.MoveNext()
let firstItem = cursor.Current
let first = ` + "${(if userElement { "firstItem.Value" } else { "firstItem" })}" + `
var nongeneric IEnumerable = bag
var other = nongeneric.GetEnumerator()
other.MoveNext()
let secondItem = (other.Current as ` + "$element" + `?)!!
first + ` + "${(if userElement { "secondItem.Value" } else { "secondItem" })}")
        let paths IReadOnlyList[string]? = if metadataReferences {
            ReferenceResolver.HostTrustedPlatformAssemblyPaths()
        } else {
            default(IReadOnlyList[string]?)
        }
        using let references = if metadataReferences {
            ReferenceResolver.WithReferences(paths!!)
        } else {
            ReferenceResolver.Default()
        }
        using let stream = MemoryStream()
        let emitted = Compilation(references, SyntaxTree.Parse(source)).Emit(stream)
        Assert.True(emitted.Success, string.Join("; ", emitted.Diagnostics))
        stream.Position = 0
        using let pe = PEReader(stream)
        let metadata = pe.GetMetadataReader()
        let bag = metadata
            .TypeDefinitions
            .Select(metadata.GetTypeDefinition)
            .Single((type TypeDefinition) -> metadata.GetString(type.Name) == "Bag")
        let methods = bag
            .GetMethods()
            .Select(metadata.GetMethodDefinition)
            .Where(
            (method MethodDefinition) -> metadata.GetString(method.Name).EndsWith(
                "GetEnumerator",
                StringComparison.Ordinal
            )
        )
            .ToArray()
        Assert.Equal(3, methods.Length)
        for method in methods {
            Assert.NotEqual(0, method.RelativeVirtualAddress)
            var signature = metadata.GetBlobReader(method.Signature)
            signature.ReadSignatureHeader()
            if signature.ReadCompressedInteger() != 0 {
                Assert.Equal(0, int32((method.Attributes & MethodAttributes.Virtual)))
                continue
            }
            let required = MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final
            Assert.Equal(required, method.Attributes & required)
        }
        let result = EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{References: paths})
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(12, result.Value)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func InheritedPropertySlot_LoadsAndDispatches(metadataReferences bool) {
        let source = `import System.Collections
import System.Collections.Generic
struct Bag : IReadOnlyList[int32] {
    prop Count int32 -> 1
    prop this[index int32] int32 -> 6
    func GetEnumerator() IEnumerator[int32] { yield 6 }
    private func (IEnumerable) GetEnumerator() IEnumerator { return GetEnumerator() }
}
var list IReadOnlyList[int32] = Bag{}
list.Count + list[0]`
        let result = EmittedOracle.Evaluate(
            []string{source},
            EmittedOracleOptions{
                References: if metadataReferences {
                    ReferenceResolver.HostTrustedPlatformAssemblyPaths()
                } else {
                    default(IReadOnlyList[string]?)
                }
            }
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(7, result.Value)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func InheritedEventSlots_LoadAndDispatch(metadataReferences bool) {
        using let fixture = CSharpFixture(`namespace ImportedEvents;
public interface IBase { event System.Action Changed; }
public interface IDerived : IBase {}`)
        using let references = if metadataReferences {
            ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        } else {
            fixture.RuntimeReferences()
        }
        let compilation = Compilation(references, SyntaxTree.Parse(`package EventConsumer
import ImportedEvents
struct Bag : IDerived { event Changed System.Action }`)){IsLibrary = true}
        using let stream = MemoryStream()
        let result = compilation.Emit(stream)
        Assert.True(result.Success, string.Join("; ", result.Diagnostics))
        let type Type? = EmittedFixture.Load(stream.ToArray(), fixture.DirectoryPath).GetType("EventConsumer.Bag")
        let inherited = type!!.GetInterfaces().Single((candidate Type) -> candidate.Name == "IBase")
        Assert.All(
            type!!.GetInterfaceMap(inherited).TargetMethods,
            (method MethodInfo) -> {
                Assert.True(method.IsVirtual)
                Assert.False(method.IsAbstract)
            }
        )
        let instance object? = Activator.CreateInstance(type!!)
        let changed EventInfo? = inherited.GetEvent("Changed")
        let handler() -> void = () -> { }
        changed!!.AddEventHandler(instance, handler)
        changed!!.RemoveEventHandler(instance, handler)
    }
}
