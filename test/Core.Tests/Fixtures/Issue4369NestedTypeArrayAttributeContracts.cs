// <copyright file="Issue4369NestedTypeArrayAttributeContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>Builds issue #4369's imported C# attribute contract in a separate assembly.</summary>
internal sealed class Issue4369NestedTypeArrayAttributeContracts : IDisposable
{
    private readonly CSharpFixture fixture = new(Source);

    /// <summary>Gets the compiled contract assembly path.</summary>
    public string Path => fixture.AssemblyPath;

    /// <summary>Loads the contract and one subject assembly together.</summary>
    public (Assembly Contract, Assembly Subject) LoadWith(byte[] subjectImage)
    {
        var assemblies = fixture.LoadTogether(
            File.ReadAllBytes(fixture.AssemblyPath),
            subjectImage);
        return (assemblies[0], assemblies[1]);
    }

    public void Dispose() => fixture.Dispose();

    private const string Source = """
        using System;

        namespace Issue4369.Contracts;

        [AttributeUsage(AttributeTargets.Class)]
        public sealed class ValuesAttribute : Attribute
        {
            public ValuesAttribute(object[] values) => Values = values;

            public object[] Values { get; }
        }
        """;
}
