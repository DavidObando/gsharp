// <copyright file="IlVerifyPipelineCollection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Serializes IL-verify pipeline tests because they share the repo local
/// dotnet tool manifest and external verifier process.
/// </summary>
[CollectionDefinition("IlVerifyPipeline", DisableParallelization = true)]
public sealed class IlVerifyPipelineCollection
{
    /// <summary>The xUnit collection name for IL-verify pipeline tests.</summary>
    public const string Name = "IlVerifyPipeline";
}
