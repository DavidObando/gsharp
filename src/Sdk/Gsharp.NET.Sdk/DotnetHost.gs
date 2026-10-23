// <copyright file="DotnetHost.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.NET.Sdk.Tools

import System

/// Gives the executable that starts G# tools.
/// @remarks ADR-0207: an R2R compiler runs only on a host of its own OS and architecture.
/// The tools must start with the host that runs MSBuild, which the dotnet CLI names in
/// DOTNET_HOST_PATH. If the variable is not set, the host is unknown and the tools start
/// the bare name `dotnet` from PATH, as before.
internal class DotnetHost {
    shared {
        internal func Path() string {
            let fromEnvironment = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH")
            if string.IsNullOrEmpty(fromEnvironment) {
                return "dotnet"
            }
            return fromEnvironment!!
        }
    }
}
