// <copyright file="Issue4369NestedTypeArrayAttributeContracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

import GSharp.Core.Tests
import System
import System.IO
import System.Reflection

/// Builds issue #4369's imported C# attribute contract in a separate assembly.
internal class Issue4369NestedTypeArrayAttributeContracts : IDisposable {
    private let fixture CSharpFixture = CSharpFixture(Source)

    /// Gets the compiled contract assembly path.
    prop Path string -> fixture.AssemblyPath

    /// Loads the contract and one subject assembly together.
    func LoadWith(subjectImage[]uint8)(Contract Assembly, Subject Assembly) {
        let assemblies = fixture.LoadTogether(File.ReadAllBytes(fixture.AssemblyPath), subjectImage)
        return (assemblies[0], assemblies[1])
    }

    func Dispose() -> fixture.Dispose()

    shared {
        private const Source string = `using System;

namespace Issue4369.Contracts;

[AttributeUsage(AttributeTargets.Class)]
public sealed class ValuesAttribute : Attribute
{
    public ValuesAttribute(object[] values) => Values = values;

    public object[] Values { get; }
}`
    }
}
