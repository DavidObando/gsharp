// <copyright file="NullabilityMode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// ADR-0186: the nullability mode of a compilation. Selected by
/// `--nullability=<mode>` (equivalently `/nullability:<mode>`).
///
/// (cref:PlatformTypes) is the default: nullability-oblivious imported
/// reference positions read as `T!`, and source declarations are
/// nullability-enabled by default. (cref:Oblivious) (ADR-0186 §9) reads
/// imported reference positions the same way and additionally makes this
/// compilation's own unadorned reference declarations `T!`. The legacy
/// `enabled` mode (ADR-0136) was retired by #4372.
enum NullabilityMode {
    PlatformTypes,
    Oblivious
}
