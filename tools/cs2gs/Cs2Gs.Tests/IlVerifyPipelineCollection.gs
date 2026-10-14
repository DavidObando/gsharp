// <copyright file="IlVerifyPipelineCollection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Xunit

/// Serializes IL-verify pipeline tests because they share the repo local
/// dotnet tool manifest and external verifier process.
@CollectionDefinition("IlVerifyPipeline", DisableParallelization = true)
class IlVerifyPipelineCollection {
    shared {
        /// The xUnit collection name for IL-verify pipeline tests.
        const Name string = "IlVerifyPipeline"
    }
}
