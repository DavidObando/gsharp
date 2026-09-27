// <copyright file="Issue4503ImportedAttributeContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>Builds issue #4503's imported C# contracts outside the ambient test assembly.</summary>
internal sealed class Issue4503ImportedAttributeContracts : IDisposable
{
    private readonly CSharpFixture fixture = new(Source);

    /// <summary>Gets the compiled contract assembly path.</summary>
    public string Path => fixture.AssemblyPath;

    /// <summary>Loads the contract and emitted assembly together outside the default load context.</summary>
    public (Assembly Contract, Assembly Emitted) LoadWith(byte[] emittedImage)
    {
        var assemblies = fixture.LoadTogether(
            File.ReadAllBytes(fixture.AssemblyPath),
            emittedImage);
        return (assemblies[0], assemblies[1]);
    }

    public void Dispose() => fixture.Dispose();

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
