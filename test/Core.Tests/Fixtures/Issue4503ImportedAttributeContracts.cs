// <copyright file="Issue4503ImportedAttributeContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>Builds issue #4503's imported C# contracts outside the ambient test assembly.</summary>
internal static class Issue4503ImportedAttributeContracts
{
    private static readonly Lazy<(string Path, Assembly Assembly)> Contract = new(Build);

    /// <summary>Gets the compiled contract assembly path.</summary>
    public static string Path => Contract.Value.Path;

    /// <summary>Gets the loaded contract assembly.</summary>
    public static Assembly Assembly => Contract.Value.Assembly;

    private static (string Path, Assembly Assembly) Build()
    {
        var directory = System.IO.Path.Combine(
            AppContext.BaseDirectory,
            "issue4503-contracts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path = System.IO.Path.Combine(directory, "Issue4503.Contracts.dll");
        var compilation = CSharpCompilation.Create(
            "Issue4503.Contracts",
            new[] { CSharpSyntaxTree.ParseText(Source) },
            new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using (var stream = File.Create(path))
        {
            var result = compilation.Emit(stream);
            if (!result.Success)
            {
                throw new InvalidOperationException(string.Join(Environment.NewLine, result.Diagnostics));
            }
        }

        return (path, Assembly.LoadFrom(path));
    }

    private const string Source = """
        using System;

        namespace Issue4503.Contracts;

        [AttributeUsage(AttributeTargets.All)]
        public sealed class ImportedNamedConstructorAttribute : Attribute
        {
            public ImportedNamedConstructorAttribute(string first, int second = 2, int third = 3)
            {
                First = first;
                Second = second;
                Third = third;
            }

            public string First { get; }
            public int Second { get; }
            public int Third { get; }
            public string Label { get; set; }
            public int Code;
            public int this[int index] { get => index; set { } }
            public System.IO.Stream Unsupported { get; set; }
        }

        [AttributeUsage(AttributeTargets.All)]
        public sealed class ImportedParamsConstructorAttribute : Attribute
        {
            public ImportedParamsConstructorAttribute(string name, params int[] values)
            {
                Name = name;
                Values = values;
            }

            public string Name { get; }
            public int[] Values { get; }
        }

        [AttributeUsage(AttributeTargets.All)]
        public sealed class ImportedReservedNamedAttribute : Attribute
        {
            public ImportedReservedNamedAttribute(string @params, string params_) { }
            public string @type { get; set; }
            public string type_ { get; set; }
        }

        [AttributeUsage(AttributeTargets.All)]
        public sealed class ImportedOverloadedReservedAttribute : Attribute
        {
            public ImportedOverloadedReservedAttribute(int @params) { }
            public ImportedOverloadedReservedAttribute(string params_) { }
        }
        """;
}
