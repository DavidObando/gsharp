// <copyright file="Issue4219GenericLocalRecursionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

open class Issue4219GenericLocalRecursionTests {
    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(true, true)
    func GenericRegions_EmitStaticMethodDefsAndConstructedCalls(interfaceOwner bool, capture bool) {
        var root DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
        while root != nil && !File.Exists(Path.Combine(root.FullName, "samples", "GenericLocalRecursion.gs")) {
            root = root.Parent
        }
        Assert.NotNull(root)
        let directory = Path.Combine(AppContext.BaseDirectory, "issue-4219", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let assembly = Path.Combine(directory, "group.dll")
            let source = Path.Combine(directory, "group.gs")
            var text = File.ReadAllText(Path.Combine(root!!.FullName, "samples", "GenericLocalRecursion.gs"))
            if interfaceOwner {
                text = text.Replace("class Example", "interface Example", StringComparison.Ordinal)
                let nestedReturn = if capture {
                    "return Value() + \"$${x}\".Length - 7"
                } else {
                    "return Value()"
                }
                text = text.Replace(
                    "return Value()",
                    "let nested = func() int32 { " + nestedReturn + " }\nreturn nested()",
                    StringComparison.Ordinal
                )
            }
            File.WriteAllText(source, text)
            Assert.Equal(
                0,
                Program.Main([]string{"/target:exe", "/targetframework:net10.0", "/out:" + assembly, source})
            )
            IlVerifier.Verify(assembly)
            using let stream = File.OpenRead(assembly)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            let expected = Dictionary[string, int32]{
                ["first"] = 2,
                ["second"] = 2,
                ["third"] = 2,
                ["left"] = 1,
                ["right"] = 1
            }
            let methods = reader
                .MethodDefinitions
                .Select((handle MethodDefinitionHandle) -> (Handle: handle, Method: reader.GetMethodDefinition(handle)))
                .Where(
                (pair(Handle MethodDefinitionHandle, Method MethodDefinition)) -> expected.ContainsKey(
                    reader.GetString(pair.Item2.Name)
                )
            )
                .ToDictionary(
                func (pair(Handle MethodDefinitionHandle, Method MethodDefinition)) string {
                    return reader.GetString(pair.Item2.Name)
                }
            )
            Assert.Equal(expected.Count, methods.Count)
            for (name, arity) in expected {
                let method = methods[name].Item2
                Assert.Equal(arity, method.GetGenericParameters().Count)
                var signature = reader.GetBlobReader(method.Signature).ReadSignatureHeader()
                Assert.True(signature.IsGeneric)
                Assert.False(signature.IsInstance)
                let owner = reader.GetTypeDefinition(method.GetDeclaringType())
                Assert.Equal(name == "left" || name == "right", !owner.GetDeclaringType().IsNil)
                if !owner.GetDeclaringType().IsNil {
                    let parent = reader.GetTypeDefinition(owner.GetDeclaringType())
                    Assert.Equal(interfaceOwner, (parent.Attributes & TypeAttributes.Interface) != 0)
                }
            }
            let constructedTargets = Enumerable
                .Range(1, reader.GetTableRowCount(TableIndex.MethodSpec))
                .Select(
                (row int32) -> reader.GetMethodSpecification(MetadataTokens.MethodSpecificationHandle(row)).Method
            )
                .Where((handle EntityHandle) -> handle.Kind == HandleKind.MethodDefinition)
                .Select(
                (handle EntityHandle) -> reader.GetString(
                    reader.GetMethodDefinition(MethodDefinitionHandle(handle)).Name
                )
            )
                .ToHashSet(StringComparer.Ordinal)
            Assert.All(expected.Keys, (name string) -> Assert.Contains(name, constructedTargets))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }
}
