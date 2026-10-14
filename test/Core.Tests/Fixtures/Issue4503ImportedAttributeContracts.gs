// <copyright file="Issue4503ImportedAttributeContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

import GSharp.Core.Tests
import System
import System.IO
import System.Reflection

/// Builds issue #4503's imported C# contracts outside the ambient test assembly.
internal class Issue4503ImportedAttributeContracts : IDisposable {
    private let fixture CSharpFixture = CSharpFixture(Source)

    /// Gets the compiled contract assembly path.
    prop Path string -> fixture.AssemblyPath

    /// Loads the contract and emitted assembly together outside the default load context.
    func LoadWith(emittedImage[]uint8)(Contract Assembly, Emitted Assembly) {
        let assemblies = fixture.LoadTogether(File.ReadAllBytes(fixture.AssemblyPath), emittedImage)
        return (assemblies[0], assemblies[1])
    }

    func Dispose() -> fixture.Dispose()

    shared {
        private const Source string = `using System;

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
}`
    }
}
