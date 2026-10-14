// <copyright file="ISelectArm.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

/// A registered arm that can be torn down when it loses.
internal interface ISelectArm {
    /// Removes the registration. Idempotent.
    func Deregister();
}
