// <copyright file="NativeMetadataFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests

import GSharp.Tests
import System
import System.IO
import System.Reflection

/// Native C# metadata contracts, independent of the test harness's compiler.
internal shared class NativeMetadataFixtures {
    private let CachedImage Lazy[[]uint8] = Lazy[[]uint8](
        () -> {
            using let fixture = Compile()
            return File.ReadAllBytes(fixture.AssemblyPath)
        }
    )

    private let CachedAssembly Lazy[Assembly] = Lazy[Assembly](() -> EmittedFixture.Load(Image))
    internal prop Image[]uint8 -> CachedImage.Value

    internal func Compile() CSharpFixture {
        using let stream = typeof(NativeMetadataFixtures).Assembly.GetManifestResourceStream(
            "GSharp.Core.Tests.NativeMetadataContracts.cs.txt"
        ) ??
            throw InvalidOperationException("The native C# metadata contract resource is missing.")
        using let reader = StreamReader(stream)
        return CSharpFixture(reader.ReadToEnd())
    }

    internal func GetType(fullName string) Type -> CachedAssembly.Value.GetType(fullName, throwOnError: true) ??
        throw InvalidOperationException("The native C# fixture does not declare '$fullName'.")
}
