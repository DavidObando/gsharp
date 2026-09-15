// <copyright file="Issue4219GenericLocalRecursionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public class Issue4219GenericLocalRecursionTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void GenericRegions_EmitStaticMethodDefsAndConstructedCalls(bool interfaceOwner)
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root != null && !File.Exists(Path.Combine(root.FullName, "samples", "GenericLocalRecursion.gs")))
        {
            root = root.Parent;
        }

        Assert.NotNull(root);
        var directory = Path.Combine(AppContext.BaseDirectory, "issue-4219", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var assembly = Path.Combine(directory, "group.dll");
            var source = Path.Combine(directory, "group.gs");
            var text = File.ReadAllText(Path.Combine(root.FullName, "samples", "GenericLocalRecursion.gs"));
            if (interfaceOwner)
            {
                text = text.Replace("class Example", "interface Example", StringComparison.Ordinal);
            }

            File.WriteAllText(source, text);
            Assert.Equal(0, Program.Main(new[]
            {
                "/target:exe",
                "/targetframework:net10.0",
                "/out:" + assembly,
                source,
            }));
            IlVerifier.Verify(assembly);

            using var stream = File.OpenRead(assembly);
            using var pe = new PEReader(stream);
            var reader = pe.GetMetadataReader();
            var expected = new Dictionary<string, int>
            {
                ["first"] = 2,
                ["second"] = 2,
                ["third"] = 2,
                ["left"] = 1,
                ["right"] = 1,
            };
            var methods = reader.MethodDefinitions
                .Select(handle => (Handle: handle, Method: reader.GetMethodDefinition(handle)))
                .Where(pair => expected.ContainsKey(reader.GetString(pair.Method.Name)))
                .ToDictionary(pair => reader.GetString(pair.Method.Name));
            Assert.Equal(expected.Count, methods.Count);
            foreach (var (name, arity) in expected)
            {
                var method = methods[name].Method;
                Assert.Equal(arity, method.GetGenericParameters().Count);
                var signature = reader.GetBlobReader(method.Signature).ReadSignatureHeader();
                Assert.True(signature.IsGeneric);
                Assert.False(signature.IsInstance);
                var owner = reader.GetTypeDefinition(method.GetDeclaringType());
                Assert.Equal(name is "left" or "right", !owner.GetDeclaringType().IsNil);
                if (!owner.GetDeclaringType().IsNil)
                {
                    var parent = reader.GetTypeDefinition(owner.GetDeclaringType());
                    Assert.Equal(interfaceOwner, (parent.Attributes & TypeAttributes.Interface) != 0);
                }
            }

            var constructedTargets = Enumerable.Range(1, reader.GetTableRowCount(TableIndex.MethodSpec))
                .Select(row => reader.GetMethodSpecification(MetadataTokens.MethodSpecificationHandle(row)).Method)
                .Where(handle => handle.Kind == HandleKind.MethodDefinition)
                .Select(handle => reader.GetString(reader.GetMethodDefinition((MethodDefinitionHandle)handle).Name))
                .ToHashSet(StringComparer.Ordinal);
            Assert.All(expected.Keys, name => Assert.Contains(name, constructedTargets));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
