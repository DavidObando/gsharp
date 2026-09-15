// <copyright file="Issue4214InheritedInterfaceSlotEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.PortableExecutable;
using System.Reflection.Metadata;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue4214InheritedInterfaceSlotEmitTests
{
    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, false, true)]
    [InlineData(false, true, false)]
    [InlineData(false, true, true)]
    [InlineData(true, false, false)]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    [InlineData(true, true, true)]
    public void InheritedEnumeratorSlot_HasBodyAndLoads(bool iterator, bool userElement, bool metadataReferences)
    {
        var element = userElement ? "Item" : "int32";
        var item = userElement ? "Item{Value: 6}" : "6";
        var body = iterator
            ? $"yield {item}"
            : $"var items = List[{element}]()\nitems.Add({item})\nreturn items.GetEnumerator()";
        var source = $$"""
            package Issue4214
            import System.Collections
            import System.Collections.Generic

            class Item { var Value int32 }
            struct Bag : IReadOnlyCollection[{{element}}] {
                prop Count int32 -> 1
                func GetEnumerator() IEnumerator[{{element}}] { {{body}} }
                func GetEnumerator(value int32) int32 -> value
                private func (IEnumerable) GetEnumerator() IEnumerator { return GetEnumerator() }
            }

            var bag = Bag{}
            var generic IEnumerable[{{element}}] = bag
            var cursor = generic.GetEnumerator()
            cursor.MoveNext()
            let firstItem = cursor.Current
            let first = {{(userElement ? "firstItem.Value" : "firstItem")}}
            var nongeneric IEnumerable = bag
            var other = nongeneric.GetEnumerator()
            other.MoveNext()
            let secondItem = (other.Current as {{element}}?)!!
            first + {{(userElement ? "secondItem.Value" : "secondItem")}}
            """;
        var paths = metadataReferences ? ReferenceResolver.HostTrustedPlatformAssemblyPaths() : null;
        using var references = metadataReferences
            ? ReferenceResolver.WithReferences(paths)
            : ReferenceResolver.Default();
        using var stream = new MemoryStream();
        var emitted = new Compilation(references, SyntaxTree.Parse(source)).Emit(stream);
        Assert.True(emitted.Success, string.Join("; ", emitted.Diagnostics));
        stream.Position = 0;
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        var bag = metadata.TypeDefinitions.Select(metadata.GetTypeDefinition)
            .Single(type => metadata.GetString(type.Name) == "Bag");
        var methods = bag.GetMethods().Select(metadata.GetMethodDefinition)
            .Where(method => metadata.GetString(method.Name).EndsWith("GetEnumerator", System.StringComparison.Ordinal))
            .ToArray();
        Assert.Equal(3, methods.Length);
        foreach (var method in methods)
        {
            Assert.NotEqual(0, method.RelativeVirtualAddress);
            var signature = metadata.GetBlobReader(method.Signature);
            signature.ReadSignatureHeader();
            if (signature.ReadCompressedInteger() != 0)
            {
                Assert.Equal(0, (int)(method.Attributes & MethodAttributes.Virtual));
                continue;
            }

            var required = MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.Final;
            Assert.Equal(required, method.Attributes & required);
        }

        var result = EmittedOracle.Evaluate(new[] { source }, new EmittedOracleOptions { References = paths });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(12, result.Value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void InheritedPropertySlot_LoadsAndDispatches(bool metadataReferences)
    {
        var source = """
            import System.Collections
            import System.Collections.Generic
            struct Bag : IReadOnlyList[int32] {
                prop Count int32 -> 1
                prop this[index int32] int32 -> 6
                func GetEnumerator() IEnumerator[int32] { yield 6 }
                private func (IEnumerable) GetEnumerator() IEnumerator { return GetEnumerator() }
            }
            var list IReadOnlyList[int32] = Bag{}
            list.Count + list[0]
            """;
        var result = EmittedOracle.Evaluate(new[] { source }, new EmittedOracleOptions
        {
            References = metadataReferences ? ReferenceResolver.HostTrustedPlatformAssemblyPaths() : null,
        });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void InheritedEventSlots_LoadAndDispatch(bool metadataReferences)
    {
        using var fixture = new CSharpFixture("""
            namespace ImportedEvents;
            public interface IBase { event System.Action Changed; }
            public interface IDerived : IBase {}
            """);
        using var references = metadataReferences
            ? ReferenceResolver.WithReferences(new[] { fixture.AssemblyPath })
            : fixture.RuntimeReferences();
        var compilation = new Compilation(references, SyntaxTree.Parse("""
            package EventConsumer
            import ImportedEvents
            struct Bag : IDerived { event Changed System.Action }
            """)) { IsLibrary = true };
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join("; ", result.Diagnostics));
        var type = EmittedFixture.Load(stream.ToArray(), fixture.DirectoryPath).GetType("EventConsumer.Bag");
        var inherited = type.GetInterfaces().Single(candidate => candidate.Name == "IBase");
        Assert.All(type.GetInterfaceMap(inherited).TargetMethods, method =>
        {
            Assert.True(method.IsVirtual);
            Assert.False(method.IsAbstract);
        });
        var instance = Activator.CreateInstance(type);
        var changed = inherited.GetEvent("Changed");
        Action handler = () => { };
        changed.AddEventHandler(instance, handler);
        changed.RemoveEventHandler(instance, handler);
    }
}
