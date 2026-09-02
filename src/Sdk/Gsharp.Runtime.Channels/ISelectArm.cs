// <copyright file="ISelectArm.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>A registered arm that can be torn down when it loses.</summary>
internal interface ISelectArm
{
    /// <summary>Removes the registration. Idempotent.</summary>
    void Deregister();
}
