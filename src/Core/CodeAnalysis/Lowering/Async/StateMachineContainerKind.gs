// <copyright file="StateMachineContainerKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

/// Storage kind for a synthesized state-machine type (see
/// `~/roslyn-async.md` §5).
enum StateMachineContainerKind {
    Struct,
    Class
}
