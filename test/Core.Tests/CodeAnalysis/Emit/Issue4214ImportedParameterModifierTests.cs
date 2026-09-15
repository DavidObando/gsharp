// <copyright file="Issue4214ImportedParameterModifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

public class Issue4214ImportedParameterModifierTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedInParameter_ResolvesItsRequiredModifier(bool metadataReferences)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "in-parameter-contracts", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var name = "InContract";
            var path = Path.Combine(directory, name + ".dll");
            using (var stream = File.Create(path))
            {
                var contract = new Compilation(SyntaxTree.Parse("""
                    package InContract
                    class API {
                        shared { func Take(in value int32) int32 -> value }
                    }
                    """)) { IsLibrary = true, AssemblyName = name };
                var emitted = contract.Emit(stream);
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            }

            using var references = metadataReferences
                ? ReferenceResolver.WithReferences(new[] { path })
                : ReferenceResolver.WithRuntimeReferences(new[] { path });
            Assert.True(references.TryResolveType("InContract.API", out var api));
            var parameter = Assert.Single(api.GetMethod("Take").GetParameters());
            Assert.NotEmpty(parameter.GetRequiredCustomModifiers());
            var consumer = new Compilation(references, SyntaxTree.Parse("""
                package InConsumer
                import InContract
                class Runner {
                    shared {
                        func Run() int32 {
                            var value = 6
                            return API.Take(in value)
                        }
                    }
                }
                """)) { IsLibrary = true };
            using var output = new MemoryStream();
            var result = consumer.Emit(output);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            var assembly = EmittedFixture.Load(output.ToArray(), directory);
            Assert.Equal(6, assembly.GetType("InConsumer.Runner").GetMethod("Run").Invoke(null, null));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
