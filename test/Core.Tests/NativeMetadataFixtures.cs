// <copyright file="NativeMetadataFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using GSharp.Tests;

namespace GSharp.Core.Tests;

/// <summary>Native C# metadata contracts, independent of the test harness's compiler.</summary>
internal static class NativeMetadataFixtures
{
    private static readonly Lazy<byte[]> CachedImage = new(() =>
    {
        using var fixture = Compile();
        return File.ReadAllBytes(fixture.AssemblyPath);
    });

    private static readonly Lazy<Assembly> CachedAssembly = new(() => EmittedFixture.Load(Image));

    internal static byte[] Image => CachedImage.Value;

    internal static CSharpFixture Compile()
    {
        using var stream = typeof(NativeMetadataFixtures).Assembly.GetManifestResourceStream(
            "GSharp.Core.Tests.NativeMetadataContracts.cs.txt")
            ?? throw new InvalidOperationException("The native C# metadata contract resource is missing.");
        using var reader = new StreamReader(stream);
        return new CSharpFixture(reader.ReadToEnd());
    }

    internal static Type GetType(string fullName)
        => CachedAssembly.Value.GetType(fullName, throwOnError: true)
            ?? throw new InvalidOperationException($"The native C# fixture does not declare '{fullName}'.");
}
