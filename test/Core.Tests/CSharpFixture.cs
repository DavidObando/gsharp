// <copyright file="CSharpFixture.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests;

/// <summary>Compiles an imported C# contract without migrating its metadata premises.</summary>
internal sealed class CSharpFixture : IDisposable
{
    internal CSharpFixture(string source)
    {
        DirectoryPath = Path.Combine(AppContext.BaseDirectory, "csharp-fixtures", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(DirectoryPath);
        AssemblyPath = Path.Combine(DirectoryPath, "CSharpContract" + Guid.NewGuid().ToString("N") + ".dll");
        try
        {
            var compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(AssemblyPath),
                new[] { CSharpSyntaxTree.ParseText(source) },
                ReferenceResolver.HostTrustedPlatformAssemblyPaths()
                    .Select(path => MetadataReference.CreateFromFile(path)),
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using var stream = File.Create(AssemblyPath);
            var result = compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }
        catch
        {
            Directory.Delete(DirectoryPath, recursive: true);
            throw;
        }
    }

    internal string DirectoryPath { get; }

    internal string AssemblyPath { get; }

    internal Assembly Load() => EmittedFixture.Load(File.ReadAllBytes(AssemblyPath), DirectoryPath);

    internal ReferenceResolver RuntimeReferences() => ReferenceResolver.WithRuntimeReferences(new[] { AssemblyPath });

    public void Dispose() => Directory.Delete(DirectoryPath, recursive: true);
}
