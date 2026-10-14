// <copyright file="IlVerifyStatus.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

/// The status of an IL-verify run (ADR-0115 §C, stage 3).
enum IlVerifyStatus {
    Skipped,
    Passed,
    Failed,
    Incomplete
}
